/**
 * 管理接口（仅超级管理员）：
 *   - 账号列表（游标分页，只返回账号元数据）
 *   - 停用 / 启用、删除账号
 *   - 站点设置：是否开放注册、查看 / 重新生成注册口令
 *
 * 删除账号依赖外键 ON DELETE CASCADE：会话、消息、登录凭证、模型 Key 一并清除。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppSettings, AppSettingsPatch } from '../appSettings.js'
import { normalizeRegistrationCode, readAppSettings, writeAppSettings } from '../appSettings.js'
import type { Database } from '../db.js'
import {
  badRequest,
  currentUser,
  decodeCursor,
  encodeCursor,
  handler,
  notFound,
  parseLimit,
  requireAdmin,
  type UserRole,
} from '../http.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Timestamp = Date | string | number

const toEpoch = (value: Timestamp | null | undefined): number => {
  if (value === null || value === undefined) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return parsed
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

const asRole = (value: string | null): UserRole => (value === 'admin' ? 'admin' : 'user')

interface AdminUserRow {
  id: string
  email: string
  role: string | null
  disabled: boolean
  created_at: Timestamp
  session_count: number | string
  last_used_at: Timestamp | null
}

interface AdminUserPayload {
  id: string
  email: string
  role: UserRole
  disabled: boolean
  createdAt: number
  sessionCount: number
  lastUsedAt: number | null
}

const toPayload = (row: AdminUserRow): AdminUserPayload => ({
  id: row.id,
  email: row.email,
  role: asRole(row.role),
  disabled: row.disabled === true,
  createdAt: toEpoch(row.created_at),
  sessionCount: Number(row.session_count ?? 0),
  lastUsedAt: row.last_used_at ? toEpoch(row.last_used_at) : null,
})

const USER_COLUMNS = `
  u.id, u.email, u.role, u.disabled, u.created_at,
  (SELECT count(*) FROM chat_sessions s WHERE s.user_id = u.id AND s.deleted_at IS NULL) AS session_count,
  (SELECT max(t.last_used_at) FROM auth_tokens t WHERE t.user_id = u.id) AS last_used_at
`

export interface AdminDeps {
  db: Database
  settings: AppSettings
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db, settings: settingsFallback } = deps

  const requireAdminUser = async (request: FastifyRequest) =>
    requireAdmin(await currentUser(request, db))

  app.get(
    '/api/admin/users',
    handler(async (request, reply) => {
      const admin = await requireAdminUser(request)
      const query = request.query as { cursor?: string; limit?: string }
      const limit = parseLimit(query.limit, 30, 100)
      const cursor = decodeCursor(query.cursor)
      const params: unknown[] = []
      let where = ''
      if (cursor) {
        params.push(cursor.updatedAt, cursor.id)
        where = 'WHERE (u.created_at, u.id) > ($1::timestamptz, $2::uuid)'
      }
      params.push(limit + 1)
      const rows = await db.query<AdminUserRow>(
        `SELECT ${USER_COLUMNS} FROM users u ${where}
          ORDER BY u.created_at ASC, u.id ASC
          LIMIT $${params.length}`,
        params,
      )
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page.at(-1)
      await reply.status(200).send({
        users: page.map(toPayload),
        // 0 个用户时说明注册还没开始，前端据此提示「注册即成为管理员」
        selfId: admin.id,
        nextCursor: hasMore && last ? encodeCursor(new Date(toEpoch(last.created_at)), last.id) : null,
      })
    }),
  )

  app.patch(
    '/api/admin/users/:id',
    handler(async (request, reply) => {
      const admin = await requireAdminUser(request)
      const { id } = request.params as { id: string }
      if (!UUID_PATTERN.test(id)) throw notFound('账号不存在')
      const body = (request.body ?? {}) as { disabled?: unknown }
      if (typeof body.disabled !== 'boolean') {
        throw badRequest('invalid_request', 'disabled 必须是布尔值')
      }
      if (id === admin.id) throw badRequest('cannot_modify_self', '不能停用当前登录的账号')
      const rows = await db.query<AdminUserRow>(
        `UPDATE users SET disabled = $1, updated_at = now() WHERE id = $2
         RETURNING id, email, role, disabled, created_at,
                   (SELECT count(*) FROM chat_sessions s WHERE s.user_id = users.id AND s.deleted_at IS NULL) AS session_count,
                   (SELECT max(t.last_used_at) FROM auth_tokens t WHERE t.user_id = users.id) AS last_used_at`,
        [body.disabled, id],
      )
      const row = rows[0]
      if (!row) throw notFound('账号不存在')
      await reply.status(200).send({ user: toPayload(row) })
    }),
  )

  app.delete(
    '/api/admin/users/:id',
    handler(async (request, reply) => {
      const admin = await requireAdminUser(request)
      const { id } = request.params as { id: string }
      if (!UUID_PATTERN.test(id)) throw notFound('账号不存在')
      if (id === admin.id) throw badRequest('cannot_delete_self', '不能删除当前登录的账号')
      const rows = await db.query<{ id: string }>('DELETE FROM users WHERE id = $1 RETURNING id', [id])
      if (rows.length === 0) throw notFound('账号不存在')
      await reply.status(204).send()
    }),
  )

  app.get(
    '/api/admin/settings',
    handler(async (request, reply) => {
      await requireAdminUser(request)
      const settings = await readAppSettings(db, settingsFallback)
      const counted = await db.query<{ total: string; admins: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE role = 'admin') AS admins FROM users`,
      )
      await reply.status(200).send({
        allowRegistration: settings.allowRegistration,
        registrationCode: settings.registrationCode,
        userCount: Number(counted[0]?.total ?? 0),
        adminCount: Number(counted[0]?.admins ?? 0),
      })
    }),
  )

  app.put(
    '/api/admin/settings',
    handler(async (request, reply) => {
      await requireAdminUser(request)
      const body = (request.body ?? {}) as { allowRegistration?: unknown; registrationCode?: unknown }
      const patch: AppSettingsPatch = {}
      if (body.allowRegistration !== undefined) {
        if (typeof body.allowRegistration !== 'boolean') {
          throw badRequest('invalid_request', 'allowRegistration 必须是布尔值')
        }
        patch.allowRegistration = body.allowRegistration
      }
      if (body.registrationCode !== undefined) {
        if (body.registrationCode === null) {
          patch.registrationCode = null
        } else if (typeof body.registrationCode === 'string') {
          try {
            normalizeRegistrationCode(body.registrationCode)
          } catch (error) {
            throw badRequest('invalid_request', error instanceof Error ? error.message : '注册口令非法')
          }
          patch.registrationCode = body.registrationCode
        } else {
          throw badRequest('invalid_request', 'registrationCode 必须是字符串或 null')
        }
      }
      if (Object.keys(patch).length === 0) {
        throw badRequest('invalid_request', '没有需要修改的设置')
      }
      const settings = await writeAppSettings(db, patch, settingsFallback)
      settingsFallback.allowRegistration = settings.allowRegistration
      settingsFallback.registrationCode = settings.registrationCode
      const counted = await db.query<{ total: string; admins: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE role = 'admin') AS admins FROM users`,
      )
      await reply.status(200).send({
        allowRegistration: settings.allowRegistration,
        registrationCode: settings.registrationCode,
        userCount: Number(counted[0]?.total ?? 0),
        adminCount: Number(counted[0]?.admins ?? 0),
      })
    }),
  )
}
