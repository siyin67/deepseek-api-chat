/**
 * 服务端配置：全部来自环境变量，启动时一次性校验。
 * 缺少必填项时直接抛错退出，避免带着半套配置上线。
 */

export interface AppConfig {
  nodeEnv: string
  port: number
  databaseUrl: string
  /** 32 字节密钥，用于 AES-256-GCM 加密模型 API Key。 */
  encryptionKey: Buffer
  tokenTtlDays: number
  /** 首次启动时写入 app_settings 的默认值；之后以数据库里的设置为准。 */
  allowRegistration: boolean
  /** 首次启动时写入 app_settings 的注册口令；留空则随机生成（管理员页可见）。 */
  registrationCode: string | null
  /** 服务端兜底 Key（用户未自设时使用），仅驻留内存，任何接口都不返回。 */
  fallbackApiKey: string | null
  apiBase: string
  upstreamTimeoutMs: number
  contextTokenBudget: number
  sessionPageSize: number
  messagePageSize: number
  maxUploadMb: number
  trustProxy: boolean
  logLevel: string
  publicOrigin: string | null
  webDistDir: string
}

function str(name: string, fallback?: string): string {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`缺少环境变量 ${name}`)
  }
  return raw
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，当前值：${raw}`)
  }
  return value
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

/** 接受 32 字节 base64 或 64 位 hex。 */
function secretKey(name: string): Buffer {
  const raw = str(name)
  const isHex = /^[0-9a-fA-F]{64}$/.test(raw)
  const bytes = Buffer.from(raw, isHex ? 'hex' : 'base64')
  if (bytes.length !== 32) {
    throw new Error(
      `环境变量 ${name} 必须是 32 字节密钥（base64 或 64 位 hex），当前解码后 ${bytes.length} 字节。可用 openssl rand -base64 32 生成。`,
    )
  }
  return bytes
}

export function loadConfig(): AppConfig {
  return {
    nodeEnv: str('NODE_ENV', 'production'),
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL'),
    encryptionKey: secretKey('APP_ENCRYPTION_KEY'),
    tokenTtlDays: int('AUTH_TOKEN_TTL_DAYS', 30),
    allowRegistration: bool('ALLOW_REGISTRATION', true),
    registrationCode: process.env.REGISTRATION_CODE ? process.env.REGISTRATION_CODE.trim() : null,
    fallbackApiKey: process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY : null,
    apiBase: (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
    upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 600_000),
    contextTokenBudget: int('CONTEXT_TOKEN_BUDGET', 120_000),
    sessionPageSize: int('SESSION_PAGE_SIZE', 30),
    messagePageSize: int('MESSAGE_PAGE_SIZE', 30),
    maxUploadMb: int('MAX_UPLOAD_MB', 64),
    trustProxy: bool('TRUST_PROXY', true),
    logLevel: str('LOG_LEVEL', 'info'),
    publicOrigin: process.env.PUBLIC_ORIGIN || null,
    /** 相对应用根目录（server/dist/index.js 上溯两级）；容器内即 /app/dist。 */
    webDistDir: str('WEB_DIST_DIR', 'dist'),
  }
}
