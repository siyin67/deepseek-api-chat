/**
 * 模型 Key 接口：只回掩码，明文永不返回浏览器。
 * 写入前先向上游校验，避免把无效 Key 存进库。
 */
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import { encryptSecret, maskSecret } from '../crypto.js'
import { ApiError, authenticate, handler, requireUser } from '../http.js'
import { loadModelKeyStatus, resolveApiKey, verifyUpstreamKey } from '../upstream.js'

function readApiKey(body: unknown): string {
  const { apiKey } = (body ?? {}) as { apiKey?: unknown }
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    throw new ApiError(400, 'invalid_request', 'API Key 格式不正确')
  }
  return apiKey.trim()
}

export async function registerModelKeyRoutes(
  app: FastifyInstance,
  deps: { db: Database; config: AppConfig },
): Promise<void> {
  const { db, config } = deps

  app.get(
    '/api/model-key',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const user = requireUser(request)
      await reply.status(200).send(await loadModelKeyStatus(db, config, user.id))
    }),
  )

  app.put(
    '/api/model-key',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const user = requireUser(request)
      const apiKey = readApiKey(request.body)
      const verdict = await verifyUpstreamKey(config, apiKey)
      if (!verdict.valid) throw new ApiError(400, 'apiKeyInvalid', verdict.message)
      await db.query(
        `INSERT INTO user_model_keys (user_id, key_cipher, key_mask, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
           SET key_cipher = EXCLUDED.key_cipher,
               key_mask = EXCLUDED.key_mask,
               updated_at = now()`,
        [user.id, encryptSecret(apiKey, config.encryptionKey), maskSecret(apiKey)],
      )
      await reply.status(200).send({ configured: true, masked: maskSecret(apiKey), source: 'user' })
    }),
  )

  app.post(
    '/api/model-key/verify',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const apiKey = readApiKey(request.body)
      const verdict = await verifyUpstreamKey(config, apiKey)
      if (!verdict.valid) throw new ApiError(400, 'apiKeyInvalid', verdict.message)
      await reply.status(200).send({ valid: true })
    }),
  )

  /** 校验「当前生效的 Key」是否仍可用（用户自设或服务端兜底）。 */
  app.post(
    '/api/model-key/check',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const user = requireUser(request)
      const key = await resolveApiKey(db, config, user.id)
      const verdict = await verifyUpstreamKey(config, key.apiKey)
      await reply.status(200).send({ valid: verdict.valid, message: verdict.message })
    }),
  )

  app.delete(
    '/api/model-key',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const user = requireUser(request)
      await db.query('DELETE FROM user_model_keys WHERE user_id = $1', [user.id])
      await reply.status(204).send()
    }),
  )
}
