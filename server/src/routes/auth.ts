/**
 * 账号接口：注册 / 登录 / 登出 / 当前用户 / 登录页公开配置。
 * 口令用 scrypt 散列，登录凭证只在签发时返回一次，库里只存 sha256。
 *
 * 注册规则：
 *   - 是否开放注册、注册口令都存在 app_settings，管理员可在「设置 → 管理」里改；
 *   - 注册必须带对注册口令（首次启动随机生成，管理员页可见）；
 *   - 数据库里的第一个账号自动成为管理员（超级管理员）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import type { AppSettings } from '../appSettings.js'
import { readAppSettings } from '../appSettings.js'
import {
  createSessionToken,
  hashPassword,
  hashToken,
  matchesRegistrationCode,
  newId,
  verifyPassword,
} from '../crypto.js'
import {
  ApiError,
  authenticate,
  forbidden,
  handler,
  requireUser,
  unauthorized,
  type UserRole,
} from '../http.js'
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
  /** 注册口令；兼容旧字段名 code */
  registrationCode?: unknown
  code?: unknown
}

export interface AuthUserPayload {
  user: { id: string; email: string; role: UserRole }
  token: string
  expiresAt: string
}

export interface AuthDeps {
  db: Database
  config: AppConfig
  /** 数据库里缺设置行时的兜底值；管理员改动后会同步更新这个对象。 */
  settings: AppSettings
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

function readSignUpCode(body: unknown): string {
  const { registrationCode, code } = (body ?? {}) as CredentialsBody
  const value = typeof registrationCode === 'string' ? registrationCode : code
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'invalid_request', '请输入注册口令')
  }
  return value.trim()
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

const asRole = (value: string | null | undefined): UserRole => (value === 'admin' ? 'admin' : 'user')

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

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, config, settings: settingsFallback } = deps

  /** 登录页需要知道「注册是否开放」来决定要不要显示注册入口（公开接口）。 */
  app.get(
    '/api/auth/config',
    handler(async (_request, reply) => {
      const settings = await readAppSettings(db, settingsFallback)
      await reply.status(200).send({ allowRegistration: settings.allowRegistration })
    }),
  )

  app.post(
    '/api/auth/register',
    handler(async (request, reply) => {
      const settings = await readAppSettings(db, settingsFallback)
      if (!settings.allowRegistration) {
        throw forbidden('registration_disabled', '当前部署未开放注册')
      }
      const { email, password } = readCredentials(request.body)
      const code = readSignUpCode(request.body)
      if (!matchesRegistrationCode(code, settings.registrationCode)) {
        throw forbidden('invalid_registration_code', '注册口令不正确')
      }
      const emailLower = email.toLowerCase()
      const userId = newId()
      const passwordHash = hashPassword(password)
      // 串行化注册：避免并发时出现两个「第一个账号」都成为管理员
      const role = await db.transaction(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('chat-demo:register'))`)
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE email_lower = $1',
          [emailLower],
        )
        if (existing.length > 0) throw new ApiError(409, 'email_taken', '该邮箱已注册')
        const counted = await client.query<{ count: string }>('SELECT count(*) AS count FROM users')
        const isFirst = Number.parseInt(counted[0]?.count ?? '0', 10) === 0
        const assigned: UserRole = isFirst ? 'admin' : 'user'
        await client.query(
          `INSERT INTO users (id, email, email_lower, password_hash, role)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, email, emailLower, passwordHash, assigned],
        )
        return assigned
      })
      const issued = await issueToken(db, config, userId)
      const payload: AuthUserPayload = {
        user: { id: userId, email, role },
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
      const rows = await db.query<{
        id: string
        email: string
        password_hash: string
        role: string | null
        disabled: boolean
      }>(
        'SELECT id, email, password_hash, role, disabled FROM users WHERE email_lower = $1',
        [email.toLowerCase()],
      )
      const user = rows[0]
      if (!user || !verifyPassword(password, user.password_hash)) {
        noteLoginFailure(key)
        throw unauthorized('invalid_credentials', '邮箱或密码不正确')
      }
      if (user.disabled) {
        throw forbidden('account_disabled', '账号已被停用，请联系管理员')
      }
      loginAttempts.delete(key)
      const issued = await issueToken(db, config, user.id)
      const payload: AuthUserPayload = {
        user: { id: user.id, email: user.email, role: asRole(user.role) },
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
      await reply.status(200).send({
        user: { id: user.id, email: user.email, role: user.role },
        modelKey,
      })
    }),
  )
}
