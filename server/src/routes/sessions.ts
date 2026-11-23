/**
 * 会话元数据接口与消息接口（严格分层）：
 * - /api/sessions*：只涉及会话元数据，任何响应都不含消息内容；
 * - /api/sessions/:id/messages*：只涉及某会话的消息记录，按需、增量、分页。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import {
  ApiError,
  badRequest,
  currentUser,
  decodeCursor,
  encodeCursor,
  handler,
  parseLimit,
} from '../http.js'

type Timestamp = Date | string | number

interface SessionRow {
  id: string
  title: string
  created_at: Timestamp
  updated_at: Timestamp
  root_message_id: string | null
  message_count: number
  deleted_at: Timestamp | null
}

interface PathNode {
  id: string
  parent_id: string | null
  selected_child_id: string | null
}

interface MessageRow {
  id: string
  session_id: string
  parent_id: string | null
  selected_child_id: string | null
  role: 'user' | 'assistant'
  content: string
  files: unknown
  reply: unknown
  created_at: Timestamp
  seq: string | number
}

/** pg 把 timestamptz 读成 Date，早前若按字符串解析会得到 0，这里统一兜住三种形态。 */
const toEpoch = (value: Timestamp | null | undefined): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && /^\d+$/.test(value)) return parsed
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : 0
  }
  return 0
}

const ms = toEpoch

const iso = toEpoch

const toSummary = (row: SessionRow) => ({
  id: row.id,
  title: row.title,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  messageCount: Number(row.message_count ?? 0),
})

const toMessage = (row: MessageRow) => ({
  id: row.id,
  parentId: row.parent_id,
  selectedChildId: row.selected_child_id,
  role: row.role,
  content: row.content,
  files: Array.isArray(row.files) ? row.files : [],
  reply: row.reply ?? null,
  createdAt: ms(row.created_at),
})

/** 读取归属当前用户且未删除的会话；缺失即 404，避免跨账号探测。 */
async function loadSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<SessionRow> {
  const rows = await db.query<SessionRow>(
    `select id, title, created_at, updated_at, root_message_id, message_count, deleted_at
       from chat_sessions
      where id = $1 and user_id = $2 and deleted_at is null`,
    [sessionId, userId],
  )
  const row = rows[0]
  if (!row) throw new ApiError(404, 'session_not_found', '会话不存在或已删除')
  return row
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

function readString(value: unknown, field: string, max = 20000): string {
  if (typeof value !== 'string') throw badRequest('invalid_body', `${field} 必须是字符串`)
  if (value.length > max) throw badRequest('invalid_body', `${field} 过长`)
  return value
}

export function registerSessionRoutes(
  app: FastifyInstance,
  { db, config }: { db: Database; config: AppConfig },
): void {
  // ---------------------------------------------------------------------------
  // 会话元数据
  // ---------------------------------------------------------------------------

  /** 列表：只返回元信息，游标分页，绝不携带消息内容。 */
  app.get(
    '/api/sessions',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const query = request.query as Record<string, string | undefined>
      const limit = parseLimit(query.limit, config.sessionPageSize)
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      const rows = await db.query<SessionRow>(
        `select id, title, created_at, updated_at, root_message_id, message_count, deleted_at
           from chat_sessions
          where user_id = $1
            and deleted_at is null
            ${cursor ? 'and (updated_at, id) < ($3::timestamptz, $4::uuid)' : ''}
          order by updated_at desc, id desc
          limit $2`,
        cursor ? [user.id, limit + 1, cursor.updatedAt, cursor.id] : [user.id, limit + 1],
      )
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      reply.header('cache-control', 'no-store')
      return {
        sessions: page.map(toSummary),
        nextCursor:
          rows.length > limit && last ? encodeCursor(new Date(iso(last.updated_at)), last.id) : null,
        serverTime: Date.now(),
      }
    }),
  )

  /** 增量：返回 since 之后有变化的会话元数据（含删除墓碑）。 */
  app.get(
    '/api/sessions/changes',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const query = request.query as Record<string, string | undefined>
      const since = query.since ? new Date(query.since) : new Date(0)
      if (Number.isNaN(since.getTime())) throw badRequest('invalid_since', 'since 必须是 ISO 时间')
      const rows = await db.query<SessionRow>(
        `select id, title, created_at, updated_at, root_message_id, message_count, deleted_at
           from chat_sessions
          where user_id = $1 and updated_at > $2
          order by updated_at asc
          limit 500`,
        [user.id, since.toISOString()],
      )
      reply.header('cache-control', 'no-store')
      return {
        changes: rows.map((row) =>
          row.deleted_at
            ? { id: row.id, deleted: true, updatedAt: iso(row.updated_at) }
            : { ...toSummary(row), deleted: false },
        ),
        serverTime: Date.now(),
      }
    }),
  )

  /** 新建会话（客户端生成 id，服务端幂等接收）。 */
  app.post(
    '/api/sessions',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const body = (request.body ?? {}) as Record<string, unknown>
      const id = readString(body.id, 'id', 64)
      if (!isUuid(id)) throw badRequest('invalid_body', 'id 必须是 uuid')
      const title = typeof body.title === 'string' ? body.title.slice(0, 500) : ''
      const createdAt = typeof body.createdAt === 'number' && Number.isFinite(body.createdAt)
        ? Math.trunc(body.createdAt)
        : Date.now()
      const rows = await db.query<SessionRow>(
        `insert into chat_sessions (id, user_id, title, created_at, updated_at)
         values ($1, $2, $3, to_timestamp($4::bigint / 1000.0), now())
         on conflict (id) do nothing
         returning id, title, created_at, updated_at, root_message_id, message_count, deleted_at`,
        [id, user.id, title, createdAt],
      )
      const created = rows[0]
      if (!created) {
        // 已存在：同账号视为幂等成功，其他账号直接拒绝
        const existing = await db.query<SessionRow>(
          `select id, title, created_at, updated_at, root_message_id, message_count, deleted_at
             from chat_sessions where id = $1 and user_id = $2`,
          [id, user.id],
        )
        const row = existing[0]
        if (!row) throw badRequest('session_conflict', '会话 id 冲突')
        reply.code(200)
        return { session: toSummary(row) }
      }
      reply.code(201)
      return { session: toSummary(created) }
    }),
  )

  /** 清空全部会话（软删除，供「删除全部会话」使用）。 */
  app.delete(
    '/api/sessions',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      await db.query(
        `update chat_sessions set deleted_at = now(), updated_at = now()
          where user_id = $1 and deleted_at is null`,
        [user.id],
      )
      reply.code(204)
      return null
    }),
  )

  /**
   * 单个会话详情（元数据 + 消息）。
   *
   * - 默认只取「可见路径的最近一页」，用 `?before=<消息 id>` 沿 parent 向上翻页。
   * - 路径还没走完时响应里的 `rootMessageId` 为 null：前端按线性顺序渲染已加载的尾部，
   *   不持有未加载的历史。
   * - 路径回溯到根（或显式 `?full=1`）时返回整棵树（含兄弟分支），前端恢复版本切换能力。
   */
  const loadPathNodes = async (sessionId: string): Promise<Map<string, PathNode>> => {
    const rows = await db.query<PathNode>(
      `select id, parent_id, selected_child_id from chat_messages where session_id = $1`,
      [sessionId],
    )
    return new Map(rows.map((row) => [row.id, row]))
  }

  const walkToLeaf = (nodes: Map<string, PathNode>, rootId: string | null): string[] => {
    const path: string[] = []
    const seen = new Set<string>()
    let current = rootId
    while (current) {
      const node = nodes.get(current)
      if (!node || seen.has(current)) break
      seen.add(current)
      path.push(node.id)
      current = node.selected_child_id
    }
    return path
  }

  const walkUp = (nodes: Map<string, PathNode>, from: string, limit: number): string[] => {
    const ids: string[] = []
    const seen = new Set<string>()
    let current: string | null = from
    while (current && ids.length < limit) {
      const node = nodes.get(current)
      if (!node || seen.has(current)) break
      seen.add(current)
      ids.push(node.id)
      current = node.parent_id
    }
    return ids
  }

  app.get(
    '/api/sessions/:id',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { id } = request.params as { id: string }
      const session = await loadSession(db, user.id, id)
      const query = request.query as Record<string, string | undefined>
      const limit = parseLimit(query.limit, config.messagePageSize)
      const full = query.full === '1' || query.full === 'true'
      const summary = toSummary(session)

      const allRows = () =>
        db.query<MessageRow>(
          `select id, session_id, parent_id, selected_child_id, role, content, files, reply, created_at, seq
             from chat_messages
            where session_id = $1
            order by seq asc`,
          [id],
        )

      const pickRows = (messageIds: string[]) =>
        db.query<MessageRow>(
          `select id, session_id, parent_id, selected_child_id, role, content, files, reply, created_at, seq
             from chat_messages
            where session_id = $1 and id = any($2::uuid[])
            order by seq asc`,
          [id, messageIds],
        )

      reply.header('cache-control', 'no-store')

      if (full) {
        const rows = await allRows()
        return {
          session: {
            ...summary,
            rootMessageId: session.root_message_id,
            messages: rows.map(toMessage),
            hasMore: false,
          },
        }
      }

      const nodes = await loadPathNodes(id)
      const requested = typeof query.before === 'string' ? query.before.trim() : ''
      const anchor = requested && nodes.has(requested) ? requested : null
      const leaf =
        anchor ?? (session.root_message_id ? (walkToLeaf(nodes, session.root_message_id).at(-1) ?? null) : null)

      if (!leaf) {
        return {
          session: { ...summary, rootMessageId: session.root_message_id, messages: [], hasMore: false },
        }
      }

      const upward = walkUp(nodes, leaf, limit + 1)
      const hasMore = upward.length > limit
      const chosen = upward.slice(0, limit)
      const oldest = chosen.length > 0 ? nodes.get(chosen[chosen.length - 1]) : undefined

      // 已经回溯到根：整棵树都在内存里，可以放心返回全部消息（含兄弟分支）
      if (!oldest || oldest.parent_id === null) {
        const rows = await allRows()
        return {
          session: {
            ...summary,
            rootMessageId: session.root_message_id,
            messages: rows.map(toMessage),
            hasMore: false,
          },
        }
      }

      const rows = await pickRows(chosen)
      return {
        session: {
          ...summary,
          rootMessageId: null,
          messages: rows.map(toMessage),
          hasMore,
        },
      }
    }),
  )

  /** 修改标题 / 当前可见分支的根（编辑第一条消息会生成新的根，需随之同步）。 */
  app.patch(
    '/api/sessions/:id',
    handler(async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { id } = request.params as { id: string }
      await loadSession(db, user.id, id)
      const body = (request.body ?? {}) as Record<string, unknown>
      const values: unknown[] = [id, user.id]
      const sets: string[] = []
      if (body.title !== undefined) {
        values.push(readString(body.title, 'title', 500))
        sets.push(`title = $${values.length}`)
      }
      if (body.rootMessageId !== undefined) {
        const root = body.rootMessageId
        if (root !== null && !isUuidString(root)) {
          throw badRequest('invalid_body', 'rootMessageId 必须是 uuid')
        }
        values.push(root === null ? null : root)
        sets.push(`root_message_id = $${values.length}::uuid`)
      }
      if (sets.length === 0) throw badRequest('invalid_body', '没有需要更新的字段')
      const rows = await db.query<{ id: string; title: string; updated_at: Timestamp }>(
        `update chat_sessions set ${sets.join(', ')}, updated_at = now()
          where id = $1 and user_id = $2
          returning id, title, updated_at`,
        values,
      )
      const row = rows[0]
      if (!row) throw new ApiError(404, 'session_not_found', '会话不存在')
      return { id: row.id, title: row.title, updatedAt: iso(row.updated_at) }
    }),
  )

  /** 删除单个会话（软删除，保留墓碑供其他设备增量同步）。 */
  app.delete(
    '/api/sessions/:id',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { id } = request.params as { id: string }
      await loadSession(db, user.id, id)
      await db.query(
        `update chat_sessions set deleted_at = now(), updated_at = now()
          where id = $1 and user_id = $2`,
        [id, user.id],
      )
      reply.code(204)
      return null
    }),
  )

  // ---------------------------------------------------------------------------
  // 消息记录
  // ---------------------------------------------------------------------------

  /** 批量写入（新建会话的第一条、以及本地已有整棵树的一次性落库）。 */
  app.post(
    '/api/sessions/:id/messages/batch',
    handler(async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { id } = request.params as { id: string }
      await loadSession(db, user.id, id)
      const body = (request.body ?? {}) as Record<string, unknown>
      const raw = Array.isArray(body.messages) ? body.messages : null
      if (!raw) throw badRequest('invalid_body', 'messages 必须是数组')
      if (raw.length === 0) return { saved: 0 }
      if (raw.length > 500) throw badRequest('too_many_messages', '单次最多 500 条')
      const params: unknown[] = []
      const values: string[] = []
      for (const [index, item] of raw.entries()) {
        if (typeof item !== 'object' || item === null) {
          throw badRequest('invalid_body', `messages[${index}] 非法`)
        }
        const message = item as Record<string, unknown>
        const messageId = readString(message.id, 'id', 64)
        if (!isUuid(messageId)) throw badRequest('invalid_body', `messages[${index}].id 必须是 uuid`)
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const parentId =
          typeof message.parentId === 'string' && isUuid(message.parentId) ? message.parentId : null
        const selectedChildId =
          typeof message.selectedChildId === 'string' && isUuid(message.selectedChildId)
            ? message.selectedChildId
            : null
        const content = typeof message.content === 'string' ? message.content : ''
        const createdAt =
          typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
            ? Math.trunc(message.createdAt)
            : Date.now()
        const base = params.length
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}::jsonb, to_timestamp($${base + 9}::bigint / 1000.0))`,
        )
        params.push(
          messageId,
          id,
          parentId,
          selectedChildId,
          role,
          content,
          JSON.stringify(Array.isArray(message.files) ? message.files : []),
          message.reply === undefined || message.reply === null ? null : JSON.stringify(message.reply),
          createdAt,
        )
      }
      await db.transaction(async (client) => {
        await client.query(
          `insert into chat_messages
             (id, session_id, parent_id, selected_child_id, role, content, files, reply, created_at)
           values ${values.join(', ')}
           on conflict (id) do update set
             parent_id = excluded.parent_id,
             selected_child_id = excluded.selected_child_id,
             content = excluded.content,
             files = excluded.files,
             reply = excluded.reply
           where chat_messages.session_id = excluded.session_id`,
          params,
        )
        await client.query(
          `update chat_sessions
              set message_count = (select count(*) from chat_messages where session_id = $1),
                  root_message_id = (
                    select m.id from chat_messages m
                     where m.session_id = $1 and m.parent_id is null
                     order by m.seq asc limit 1
                  ),
                  updated_at = now()
            where id = $1`,
          [id],
        )
      })
      return { saved: raw.length }
    }),
  )

  /** 单条写入/更新（流式结束后回写本轮回复、切换分支节点）。 */
  app.put(
    '/api/sessions/:id/messages/:messageId',
    handler(async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { id, messageId } = request.params as { id: string; messageId: string }
      if (!isUuid(messageId)) throw badRequest('invalid_body', 'messageId 必须是 uuid')
      await loadSession(db, user.id, id)
      const body = (request.body ?? {}) as Record<string, unknown>
      const rows = await db.query<{ id: string }>(
        `update chat_messages
            set parent_id = $3,
                selected_child_id = $4,
                content = $5,
                files = $6::jsonb,
                reply = $7::jsonb
          where id = $1 and session_id = $2
          returning id`,
        [
          messageId,
          id,
          typeof body.parentId === 'string' && isUuid(body.parentId) ? body.parentId : null,
          typeof body.selectedChildId === 'string' && isUuid(body.selectedChildId)
            ? body.selectedChildId
            : null,
          typeof body.content === 'string' ? body.content : '',
          JSON.stringify(Array.isArray(body.files) ? body.files : []),
          body.reply === undefined || body.reply === null ? null : JSON.stringify(body.reply),
        ],
      )
      if (!rows[0]) throw new ApiError(404, 'message_not_found', '消息不存在')
      await db.query(`update chat_sessions set updated_at = now() where id = $1 and user_id = $2`, [
        id,
        user.id,
      ])
      return { id: rows[0].id, updatedAt: Date.now() }
    }),
  )

}

const isUuidString = (value: unknown): value is string =>
  typeof value === 'string' && isUuid(value)
