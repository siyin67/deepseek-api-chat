import { translate, type TranslationMessage } from '../../i18n/index.js'
import { resizeUploadImage } from '../../utils/resizeUploadImage.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type { ChatModel, FileObject, FilePurpose, MessageStreamEvent } from './types.js'

/**
 * 所有请求都发往同源后端（`/api`），由它注入模型 Key 并转发上游。
 * 浏览器侧不再持有任何密钥，也不再直连模型服务域名。
 */
export const API_BASE = '/api'

/** 登录凭证；由 services/auth.ts 在启动与登录/登出时同步。 */
let authToken: string | null = null

export const setAuthToken = (token: string | null) => {
  authToken = token
}

export const getAuthToken = () => authToken

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

const isErrorBody = (value: unknown): value is { error: { code?: string; message: string } } =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      code = body.error.code
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

const withAuth = (init: RequestInit): RequestInit => {
  if (!authToken) {
    return init
  }
  const headers = new Headers(init.headers)
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${authToken}`)
  }
  return { ...init, headers }
}

/**
 * 登录凭证失效（401）时的回调：由 services/auth.ts 注册，用来清空凭证并回到登录页。
 * 登录/注册接口自身的 401 属于密码错误，不触发。
 */
let unauthorizedHandler: (() => void) | null = null

export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  unauthorizedHandler = handler
}

const isAuthEndpoint = (url: string) =>
  url.includes('/auth/login') || url.includes('/auth/register')

export const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, withAuth(init))
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    const error = await readErrorResponse(response)
    // 凭证失效、或账号被管理员停用：都退回登录页，避免页面一直报错
    if (
      authToken &&
      !isAuthEndpoint(url) &&
      (response.status === 401 || error.code === 'account_disabled')
    ) {
      unauthorizedHandler?.()
    }
    throw error
  }
  return response
}

/** JSON 请求快捷方式 */
export const apiRequest = async <T>(
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> => {
  const { json, ...rest } = init
  const response = await request(`${API_BASE}${path}`, {
    ...rest,
    ...(json === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json', ...rest.headers },
          body: JSON.stringify(json),
        }),
  })
  if (response.status === 204) {
    return undefined as T
  }
  // 兼容 200/201 但响应体为空的情况（例如幂等请求），避免 JSON 解析直接抛错
  const text = await response.text()
  if (text.trim() === '') {
    return undefined as T
  }
  return JSON.parse(text) as T
}

/** 保存模型 Key：服务端先校验再加密落库，返回的只有掩码 */
export const saveModelKey = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<{ masked: string; source: 'user' | 'server' | 'none' }> =>
  await apiRequest(`/model-key`, { method: 'PUT', json: { apiKey }, signal })

/** 校验当前生效的 Key（用户 Key 或服务端兜底 Key），不产生费用 */
export const verifyModelKey = async (
  signal?: AbortSignal
): Promise<{ valid: boolean; message: string }> =>
  await apiRequest(`/model-key/check`, { method: 'POST', signal })

/**
 * POST /api/files 上传附件（只传一次，服务端注入 Key 转给上游 Files API）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', purpose === null ? await resizeUploadImage(file, signal) : file)
  const response = await request(`${API_BASE}/files`, {
    method: 'POST',
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /api/files/{file_id} */
export const deleteFile = async (fileId: string): Promise<void> => {
  await request(`${API_BASE}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
}

/** 公开的登录页配置：是否开放注册（关闭时不显示注册入口） */
export const fetchAuthConfig = async (
  signal?: AbortSignal
): Promise<{ allowRegistration: boolean }> => await apiRequest('/auth/config', { signal })

export interface AdminUser {
  id: string
  email: string
  role: 'admin' | 'user'
  disabled: boolean
  createdAt: number
  sessionCount: number
  lastUsedAt: number | null
}

export interface AdminUserPage {
  users: AdminUser[]
  selfId: string
  nextCursor: string | null
}

export interface AdminSettings {
  allowRegistration: boolean
  registrationCode: string
  userCount: number
  adminCount: number
}

/** GET /api/admin/users（游标分页，只返回账号元数据） */
export const fetchAdminUsers = async (
  cursor?: string | null,
  signal?: AbortSignal
): Promise<AdminUserPage> =>
  await apiRequest(
    `/admin/users${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal }
  )

/** PATCH /api/admin/users/{id}：停用 / 启用 */
export const setAdminUserDisabled = async (
  userId: string,
  disabled: boolean
): Promise<AdminUser> => {
  const payload = await apiRequest<{ user: AdminUser }>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', json: { disabled } }
  )
  return payload.user
}

/** DELETE /api/admin/users/{id}：连同该账号的会话、消息一起删除 */
export const deleteAdminUser = async (userId: string): Promise<void> => {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export const fetchAdminSettings = async (signal?: AbortSignal): Promise<AdminSettings> =>
  await apiRequest('/admin/settings', { signal })

/** PUT /api/admin/settings：registrationCode 传 null 表示重新随机生成 */
export const saveAdminSettings = async (patch: {
  allowRegistration?: boolean
  registrationCode?: string | null
}): Promise<AdminSettings> => await apiRequest('/admin/settings', { method: 'PUT', json: patch })

export interface TurnRequest {
  sessionId: string
  replyId: string
  model: ChatModel
  thinking: boolean
  search: boolean
  latestReminder?: string
}

/**
 * POST /api/sessions/:id/turns（SSE），逐个产出流式事件，收到 message_stop 时结束。
 * 服务端按会话 id 从数据库还原历史上下文，请求体不含任何历史消息。
 */
export async function* streamTurn(
  input: TurnRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${API_BASE}/sessions/${input.sessionId}/turns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      replyId: input.replyId,
      model: input.model,
      thinking: input.thinking,
      search: input.search,
      ...(input.latestReminder ? { latestReminder: input.latestReminder } : {}),
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
