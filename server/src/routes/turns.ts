/**
 * 上游对话转发：浏览器不再直连模型服务。
 *
 * 流程：客户端先把自己的提问与一条 pending 回复写入 /messages（同一事务），再调用本接口并带上
 * replyId。服务端从数据库还原「当前可见分支」——最后一条即本轮回复（含续写前缀），倒数第二条是
 * 本轮提问，其余为历史——因此上下文完全以服务端为准，浏览器无法伪造历史。
 *
 * 流式：上游 SSE 字节原样透传（不做任何解析/重写），hijack 后直接写 raw socket；
 * 关闭压缩与代理缓冲，回压时等待 drain，客户端断开即中止上游请求。
 */
import { once } from 'node:events'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import {
  DEFAULT_MODEL,
  buildTurnRequest,
  hasFileBlocks,
  toContextMessage,
  type ContextAssistantMessage,
  type ContextMessage,
  type ContextUserMessage,
} from '../context.js'
import { ApiError, badRequest, currentUser } from '../http.js'
import {
  anthropicHeaders,
  anthropicUrl,
  resolveApiKey,
  toUpstreamError,
} from '../upstream.js'

const ALLOWED_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PathRow {
  id: string
  parent_id: string | null
  selected_child_id: string | null
  role: 'user' | 'assistant'
  content: string
  files: unknown
  reply: unknown
}

/** 沿 parent/selected_child_id 走出当前可见分支，与前端 getVisibleMessages 等价。 */
async function loadVisiblePath(db: Database, sessionId: string): Promise<PathRow[]> {
  const rows = await db.query<PathRow>(
    `select id, parent_id, selected_child_id, role, content, files, reply
       from chat_messages
      where session_id = $1`,
    [sessionId],
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  const root = rows.find((row) => row.parent_id === null)
  if (!root) return []
  const path: PathRow[] = [root]
  const seen = new Set([root.id])
  let current = root
  while (current.selected_child_id) {
    const next = byId.get(current.selected_child_id)
    if (!next || seen.has(next.id)) break
    path.push(next)
    seen.add(next.id)
    current = next
  }
  return path
}

export interface TurnBody {
  replyId: string
  model?: string
  thinking?: boolean
  search?: boolean
  latestReminder?: string
}

export function registerTurnRoutes(
  app: FastifyInstance,
  { db, config }: { db: Database; config: AppConfig },
): void {
  app.post(
    '/api/sessions/:id/turns',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 出错时还没接管响应，可以照常返回 JSON 错误体
      try {
        const user = await currentUser(request, db)
        const { id: sessionId } = request.params as { id: string }
        const body = (request.body ?? {}) as Record<string, unknown>
        const replyId = body.replyId
        if (typeof replyId !== 'string' || !UUID.test(replyId)) {
          throw badRequest('invalid_body', 'replyId 必须是 uuid')
        }
        const sessions = await db.query<{ id: string; title: string }>(
          `select id, title from chat_sessions
            where id = $1 and user_id = $2 and deleted_at is null`,
          [sessionId, user.id],
        )
        const session = sessions[0]
        if (!session) throw new ApiError(404, 'session_not_found', '会话不存在或已删除')

        const path = await loadVisiblePath(db, sessionId)
        const last = path.at(-1)
        const questionRow = path.at(-2)
        if (!last || last.role !== 'assistant' || last.id !== replyId) {
          throw new ApiError(409, 'turn_conflict', '本轮回复已不是当前分支末端，请重试')
        }
        if (!questionRow || questionRow.role !== 'user') {
          throw new ApiError(409, 'turn_conflict', '未找到本轮提问')
        }

        const history = path
          .slice(0, -2)
          .map((row) => toContextMessage(row))
          .filter((message): message is ContextMessage => message !== null)
        const prefix = toContextMessage(last) as ContextAssistantMessage | null
        const question = toContextMessage(questionRow) as ContextUserMessage | null
        if (!prefix || !question) throw new ApiError(500, 'internal', '上下文数据结构异常')

        const model =
          typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
            ? body.model
            : DEFAULT_MODEL

        const built = buildTurnRequest({
          model,
          history,
          question,
          prefix,
          thinking: body.thinking === true,
          search: body.search === true,
          latestReminder:
            typeof body.latestReminder === 'string' ? body.latestReminder : undefined,
          // 标题还在生成条件内：会话标题为空时才向上游申请
          withTitle: session.title === '',
          budget: config.contextTokenBudget,
        })

        const { apiKey } = await resolveApiKey(db, config, user.id)
        const beta = hasFileBlocks(built.body.messages)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs)
        const onClientGone = () => {
          if (!reply.raw.writableEnded) controller.abort()
        }
        reply.raw.on('close', onClientGone)

        let upstream: Response
        try {
          upstream = await fetch(anthropicUrl(config, '/messages'), {
            method: 'POST',
            headers: {
              ...anthropicHeaders(apiKey, beta),
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify({ ...built.body, stream: true }),
            signal: controller.signal,
          })
        } catch (error) {
          clearTimeout(timer)
          reply.raw.off('close', onClientGone)
          if (controller.signal.aborted && !reply.raw.writableEnded) {
            throw new ApiError(504, 'upstream_timeout', '模型服务响应超时')
          }
          throw new ApiError(
            502,
            'upstream_unreachable',
            error instanceof Error ? error.message : '无法连接模型服务',
          )
        }

        if (!upstream.ok) {
          clearTimeout(timer)
          reply.raw.off('close', onClientGone)
          request.log.warn({ status: upstream.status, replyId }, 'upstream rejected turn')
          throw await toUpstreamError(upstream)
        }

        const contentType = upstream.headers.get('content-type') ?? ''
        const stream = upstream.body
        if (!stream || !contentType.includes('text/event-stream')) {
          clearTimeout(timer)
          reply.raw.off('close', onClientGone)
          throw new ApiError(502, 'upstream_protocol', '模型服务未返回流式响应')
        }

        // 接管响应：写入裸 socket，避免任何框架层再加工
        reply.hijack()
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store, must-revalidate',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-turn-id': replyId,
        })
        reply.raw.flushHeaders()
        request.log.info(
          { replyId, messages: built.messageCount, dropped: built.droppedRounds },
          'turn stream started',
        )

        try {
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
            if (reply.raw.writableEnded || reply.raw.destroyed) break
            if (!reply.raw.write(chunk)) await once(reply.raw, 'drain')
          }
        } catch (error) {
          // 上游中断：交给前端按「流式中断」处理（它会保留已收到的内容）
          request.log.warn({ replyId, err: String(error) }, 'upstream stream broke')
        } finally {
          clearTimeout(timer)
          reply.raw.off('close', onClientGone)
          if (!reply.raw.writableEnded) reply.raw.end()
        }
      } catch (error) {
        if (reply.raw.headersSent) {
          reply.raw.end()
          return
        }
        if (error instanceof ApiError) {
          await reply
            .status(error.status)
            .header('cache-control', 'no-store')
            .send({ error: { code: error.code, message: error.message } })
          return
        }
        request.log.error({ err: String(error) }, 'turn failed')
        await reply
          .status(500)
          .send({ error: { code: 'internal', message: '服务器内部错误' } })
      }
    },
  )
}
