/**
 * 上游（DeepSeek）访问层：解析该用户的模型 Key、拼装请求头、错误转译。
 * Key 只在本模块内以明文短暂存在，绝不进入任何响应体。
 */
import type { AppConfig } from './config.js'
import type { Database } from './db.js'
import { decryptSecret } from './crypto.js'
import { ApiError } from './http.js'

export type KeySource = 'user' | 'server' | 'none'

export interface ModelKeyStatus {
  configured: boolean
  masked: string | null
  source: KeySource
}

export interface ResolvedKey {
  apiKey: string
  source: Exclude<KeySource, 'none'>
}

export interface UpstreamKeyRow {
  key_cipher: string
  key_mask: string
}

/** 用户自设 Key 优先，其次服务端兜底 Key（DEEPSEEK_API_KEY）。 */
export async function resolveApiKey(
  db: Database,
  config: AppConfig,
  userId: string,
): Promise<ResolvedKey> {
  const rows = await db.query<UpstreamKeyRow>(
    'SELECT key_cipher, key_mask FROM user_model_keys WHERE user_id = $1',
    [userId],
  )
  const row = rows[0]
  if (row) {
    try {
      return { apiKey: decryptSecret(row.key_cipher, config.encryptionKey), source: 'user' }
    } catch {
      throw new ApiError(500, 'internal', '已保存的模型 Key 无法解密，请重新设置')
    }
  }
  if (config.fallbackApiKey) return { apiKey: config.fallbackApiKey, source: 'server' }
  throw new ApiError(502, 'key_missing', '服务端尚未配置模型 API Key')
}

export async function loadModelKeyStatus(
  db: Database,
  config: AppConfig,
  userId: string,
): Promise<ModelKeyStatus> {
  const rows = await db.query<UpstreamKeyRow>(
    'SELECT key_cipher, key_mask FROM user_model_keys WHERE user_id = $1',
    [userId],
  )
  const row = rows[0]
  if (row) return { configured: true, masked: row.key_mask, source: 'user' }
  if (config.fallbackApiKey) {
    return { configured: true, masked: maskFallback(config.fallbackApiKey), source: 'server' }
  }
  return { configured: false, masked: null, source: 'none' }
}

function maskFallback(apiKey: string): string {
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length)
  return `${apiKey.slice(0, 3)}${'*'.repeat(Math.max(4, apiKey.length - 7))}${apiKey.slice(-4)}`
}

export const FILES_BETA = 'files-api-2025-04-14'

export function anthropicHeaders(apiKey: string, beta = false): Record<string, string> {
  return {
    'x-api-key': apiKey,
    ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
  }
}

export function anthropicUrl(config: AppConfig, path: string): string {
  return `${config.apiBase}/anthropic/v1${path}`
}

export function toolsUrl(config: AppConfig, path: string): string {
  return `${config.apiBase}/v1/tools${path}`
}

export function modelsUrl(config: AppConfig): string {
  return `${config.apiBase}/models`
}

/** 向上游校验 Key 是否可用（只回 401/403 视为无效，其他状态视为服务暂时不可用）。 */
export async function verifyUpstreamKey(
  config: AppConfig,
  apiKey: string,
): Promise<{ valid: boolean; message: string }> {
  let response: Response
  try {
    response = await fetch(modelsUrl(config), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return { valid: false, message: '无法连接模型服务，请稍后再试' }
  }
  if (response.ok) return { valid: true, message: '' }
  if (response.status === 401 || response.status === 403) {
    return { valid: false, message: 'API Key 无效' }
  }
  return { valid: false, message: `模型服务返回 ${response.status}` }
}

/** 从上游错误体里抽出人能看懂的消息。 */
export function extractUpstreamMessage(text: string, fallback: string): string {
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? fallback
  } catch {
    return text.slice(0, 300) || fallback
  }
}

/**
 * 上游非 2xx → 归一化错误。
 * 401/403 一律转 502：那是服务端 Key 的问题，不能被前端误判成「登录过期」。
 */
export async function toUpstreamError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '')
  const message = extractUpstreamMessage(text, `模型服务返回 ${response.status}`)
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'upstream_auth_failed', '服务端模型 Key 无效或已过期，请联系管理员')
  }
  if ([400, 402, 404, 413, 429].includes(response.status)) {
    return new ApiError(response.status, 'upstream_error', message)
  }
  return new ApiError(502, 'upstream_error', message)
}
