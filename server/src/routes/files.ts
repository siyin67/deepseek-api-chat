/**
 * Files API 代理：浏览器把附件传到本服务，由服务端带 Key 转给上游。
 * 只做一次性转发（上游 Files API 本身不是流式接口），返回体原样回传。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import { ApiError, currentUser, handler } from '../http.js'
import { FILES_BETA, anthropicUrl, resolveApiKey, toUpstreamError } from '../upstream.js'


export function registerFileRoutes(
  app: FastifyInstance,
  { db, config }: { db: Database; config: AppConfig },
): void {
  /** 上传：客户端 multipart 字段 purpose + file，服务端原样转上游。 */
  app.post(
    '/api/files',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      if (!request.isMultipart()) throw new ApiError(400, 'invalid_body', '需要 multipart 请求')

      let purpose = ''
      let data: Buffer | null = null
      let filename = 'file'
      let mimetype = 'application/octet-stream'
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            await part.toBuffer()
            continue
          }
          data = await part.toBuffer()
          filename = part.filename || 'file'
          mimetype = part.mimetype || 'application/octet-stream'
          continue
        }
        if (part.fieldname === 'purpose' && typeof part.value === 'string') {
          purpose = part.value
        }
      }
      if (!data || data.length === 0) throw new ApiError(400, 'invalid_body', '缺少文件')
      if (data.length > config.maxUploadMb * 1024 * 1024) {
        throw new ApiError(413, 'too_large', `文件超过 ${config.maxUploadMb}MB 上限`)
      }

      const { apiKey } = await resolveApiKey(db, config, user.id)
      const form = new FormData()
      if (purpose) form.append('purpose', purpose)
      form.append('file', new Blob([new Uint8Array(data)], { type: mimetype }), filename)

      let upstream: Response
      try {
        upstream = await fetch(anthropicUrl(config, '/files'), {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-beta': FILES_BETA,
          },
          body: form,
          signal: AbortSignal.timeout(120_000),
        })
      } catch {
        throw new ApiError(502, 'upstream_unreachable', '无法连接模型服务')
      }
      if (!upstream.ok) throw await toUpstreamError(upstream)
      const payload = (await upstream.json()) as unknown
      reply.header('cache-control', 'no-store')
      return payload
    }),
  )

  /** 删除远端文件（忽略不存在的情况，保证幂等）。 */
  app.delete(
    '/api/files/:fileId',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const { fileId } = request.params as { fileId: string }
      if (!fileId) throw new ApiError(400, 'invalid_body', '缺少 fileId')
      const { apiKey } = await resolveApiKey(db, config, user.id)
      try {
        const upstream = await fetch(anthropicUrl(config, `/files/${encodeURIComponent(fileId)}`), {
          method: 'DELETE',
          headers: { 'x-api-key': apiKey, 'anthropic-beta': FILES_BETA },
          signal: AbortSignal.timeout(30_000),
        })
        if (!upstream.ok && upstream.status !== 404) {
          request.log.warn({ status: upstream.status, fileId }, 'upstream file delete failed')
        }
      } catch {
        request.log.warn({ fileId }, 'upstream file delete unreachable')
      }
      reply.code(204)
      return null
    }),
  )
}

