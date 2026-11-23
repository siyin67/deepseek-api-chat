/**
 * HTTP 基础设施：统一错误体、鉴权、游标编码。
 * 错误体固定为 { error: { code, message } }，与前端 ApiError 解析一致。
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { hashToken } from './crypto.js'
import type { Database } from './db.js'

export type UserRole = 'admin' | 'user'

export interface AuthedUser {
  id: string
  email: string
  role: UserRole
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser
  }
}

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

export function badRequest(code = 'invalid_request', message?: string): ApiError {
  return new ApiError(400, code, message)
}

export function unauthorized(code = 'unauthorized', message?: string): ApiError {
  return new ApiError(401, code, message)
}

export function forbidden(code = 'forbidden', message?: string): ApiError {
  return new ApiError(403, code, message)
}

/** 管理员专用接口的统一守卫。 */
export function requireAdmin(user: AuthedUser): AuthedUser {
  if (user.role !== 'admin') throw forbidden('admin_required', '需要管理员权限')
  return user
}

export function notFound(message = '资源不存在'): ApiError {
  return new ApiError(404, 'not_found', message)
}

export function sendApiError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ApiError) {
    void reply.status(error.status).send({ error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : '服务器内部错误'
  if (!reply.sent) {
    void reply.status(500).send({ error: { code: 'internal', message } })
  }
}

/** 包装 async 路由，把异常交给 sendApiError。 */
export function handler(
  fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      // 必须把返回值交给 Fastify，否则 return {...} 的路由会变成 200 + 空响应体
      return await fn(request, reply)
    } catch (error) {
      sendApiError(reply, error)
      return undefined
    }
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/** 校验登录凭证（滑动续期：每次使用刷新 last_used_at）。停用账号一律拒绝。 */
export async function authenticate(
  request: FastifyRequest,
  db: Database,
): Promise<AuthedUser> {
  const token = bearerToken(request)
  if (!token) throw unauthorized()
  const rows = await db.query<{
    id: string
    email: string
    role: UserRole
    disabled: boolean
    token_id: string
    expires_at: Date
  }>(
    `SELECT u.id, u.email, u.role, u.disabled, t.id AS token_id, t.expires_at
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row) throw unauthorized()
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.query('DELETE FROM auth_tokens WHERE id = $1', [row.token_id])
    throw unauthorized('unauthorized', '登录已过期，请重新登录')
  }
  if (row.disabled) throw forbidden('account_disabled', '账号已被停用，请联系管理员')
  void db.query('UPDATE auth_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]).catch(
    () => undefined,
  )
  const user: AuthedUser = { id: row.id, email: row.email, role: row.role === 'admin' ? 'admin' : 'user' }
  request.user = user
  return user
}

export function requireUser(request: FastifyRequest): AuthedUser {
  if (!request.user) throw unauthorized()
  return request.user
}

/** 取当前登录用户；尚未鉴权时补一次（路由可独立于全局钩子使用）。 */
export async function currentUser(request: FastifyRequest, db: Database): Promise<AuthedUser> {
  return request.user ?? (await authenticate(request, db))
}

export function parseLimit(raw: unknown, fallback: number, max = 100): number {
  if (typeof raw !== 'string' || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw badRequest('invalid_request', 'limit 非法')
  return Math.min(value, max)
}

export function encodeCursor(updatedAt: Date | string, id: string): string {
  const time = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime()
  return Buffer.from(`${time}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: unknown): { updatedAt: Date; id: string } | null {
  if (typeof raw !== 'string' || raw === '') return null
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const index = text.indexOf('|')
  if (index <= 0) throw badRequest('invalid_cursor', '游标格式非法')
  const time = Number.parseInt(text.slice(0, index), 10)
  const id = text.slice(index + 1)
  if (!Number.isFinite(time) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw badRequest('invalid_cursor', '游标格式非法')
  }
  return { updatedAt: new Date(time), id }
}

/** 解析 ISO 时间参数，非法时 400。 */
export function parseIso(raw: unknown, field: string): Date {
  if (typeof raw !== 'string' || raw === '') {
    throw badRequest('invalid_request', `${field} 必填`)
  }
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) {
    throw badRequest('invalid_request', `${field} 必须是 ISO 时间`)
  }
  return value
}
