/**
 * 账号接口：注册 / 登录 / 登出 / 当前用户。
 * 口令用 scrypt 散列，登录凭证只在签发时返回一次，库里只存 sha256。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import { createSessionToken, hashPassword, hashToken, newId, verifyPassword } from '../crypto.js'
import { ApiError, authenticate, handler, requireUser, unauthorized } from '../http.js'
import { loadModelKeyStatus } from '../upstream.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8
/** 简单的登录失败限流：同一 IP+邮箱 10 分钟内最多 10 次。 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

interface CredentialsBody {
  email?: unknown
  password?: unknown
}

export interface AuthUserPayload {
  user: { id: string; email: string }
  token: string
  expiresAt: string
}

function readCredentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as CredentialsBody
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    throw new ApiError(400, 'invalid_request', '请输入正确的邮箱地址')
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, 'invalid_request', `密码至少 ${MIN_PASSWORD_LENGTH} 位`)
  }
  return { email: email.trim(), password }
}

function clientKey(request: FastifyRequest, email: string): string {
  return `${request.ip}|${email.toLowerCase()}`
}

function assertLoginAllowed(key: string): void {
  const entry = loginAttempts.get(key)
  if (!entry) return
  if (entry.resetAt <= Date.now()) {
    loginAttempts.delete(key)
    return
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    throw new ApiError(429, 'rate_limited', '登录尝试过于频繁，请稍后再试')
  }
}

function noteLoginFailure(key: string): void {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count += 1
}

interface UserRow {
  id: string
  email: string
  password_hash: string
}

async function issueToken(
  db: Database,
  config: AppConfig,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = createSessionToken()
  const expiresAt = new Date(Date.now() + config.tokenTtlDays * 24 * 60 * 60 * 1000)
  await db.query(
    `INSERT INTO auth_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [newId(), userId, hashToken(token), expiresAt],
  )
  return { token, expiresAt: expiresAt.toISOString() }
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: Database; config: AppConfig },
): Promise<void> {
  const { db, config } = deps

  app.post(
    '/api/auth/register',
    handler(async (request, reply) => {
      if (!config.allowRegistration) {
        throw new ApiError(403, 'registration_disabled', '当前部署未开放注册')
      }
      const { email, password } = readCredentials(request.body)
      const emailLower = email.toLowerCase()
      const existing = await db.query<{ id: string }>(
        'SELECT id FROM users WHERE email_lower = $1',
        [emailLower],
      )
      if (existing.length > 0) throw new ApiError(409, 'email_taken', '该邮箱已注册')

      const userId = newId()
      try {
        await db.query(
          `INSERT INTO users (id, email, email_lower, password_hash) VALUES ($1, $2, $3, $4)`,
          [userId, email, emailLower, hashPassword(password)],
        )
      } catch (error) {
        if (error instanceof Error && /duplicate key/i.test(error.message)) {
          throw new ApiError(409, 'email_taken', '该邮箱已注册')
        }
        throw error
      }
      const issued = await issueToken(db, config, userId)
      const payload: AuthUserPayload = {
        user: { id: userId, email },
        token: issued.token,
        expiresAt: issued.expiresAt,
      }
      await reply.status(201).send(payload)
    }),
  )

  app.post(
    '/api/auth/login',
    handler(async (request, reply) => {
      const { email, password } = readCredentials(request.body)
      const key = clientKey(request, email)
      assertLoginAllowed(key)
      const rows = await db.query<UserRow>(
        'SELECT id, email, password_hash FROM users WHERE email_lower = $1',
        [email.toLowerCase()],
      )
      const user = rows[0]
      if (!user || !verifyPassword(password, user.password_hash)) {
        noteLoginFailure(key)
        throw unauthorized('invalid_credentials', '邮箱或密码不正确')
      }
      loginAttempts.delete(key)
      const issued = await issueToken(db, config, user.id)
      const payload: AuthUserPayload = {
        user: { id: user.id, email: user.email },
        token: issued.token,
        expiresAt: issued.expiresAt,
      }
      await reply.status(200).send(payload)
    }),
  )

  app.post(
    '/api/auth/logout',
    handler(async (request, reply) => {
      const user = await authenticate(request, db)
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
      if (token) {
        await db.query('DELETE FROM auth_tokens WHERE token_hash = $1 AND user_id = $2', [
          hashToken(token),
          user.id,
        ])
      }
      await reply.status(204).send()
    }),
  )

  app.get(
    '/api/auth/me',
    handler(async (request, reply) => {
      await authenticate(request, db)
      const user = requireUser(request)
      const modelKey = await loadModelKeyStatus(db, config, user.id)
      await reply.status(200).send({ user: { id: user.id, email: user.email }, modelKey })
    }),
  )
}
