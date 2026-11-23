import { create } from 'zustand'
import { ApiError, apiRequest, setAuthToken, setUnauthorizedHandler } from './api/client.js'

export interface AuthUser {
  id: string
  email: string
}

/** 服务端模型 Key 状态：只有掩码，明文永远不下发 */
export interface ModelKeyStatus {
  configured: boolean
  masked: string | null
  source: 'user' | 'server' | 'none'
}

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  modelKey: ModelKeyStatus | null
}

export const useAuth = create<AuthState>(() => ({
  status: 'unknown',
  user: null,
  modelKey: null,
}))

const TOKEN_KEY = 'chat-demo:auth-token'

const readToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

const writeToken = (token: string | null) => {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
  } catch {
    // 存储不可用时只在内存中保留本次会话
  }
}

interface SessionPayload {
  user: AuthUser
  token: string
  expiresAt: number
}

interface MePayload {
  user: AuthUser
  modelKey: ModelKeyStatus
}

const applySession = (payload: SessionPayload) => {
  writeToken(payload.token)
  setAuthToken(payload.token)
  useAuth.setState({ status: 'authenticated', user: payload.user })
}

/** 启动时用本地凭证换取当前用户；失败即视为未登录。 */
export const bootstrapAuth = async (): Promise<boolean> => {
  const token = readToken()
  if (!token) {
    setAuthToken(null)
    useAuth.setState({ status: 'anonymous', user: null, modelKey: null })
    return false
  }
  setAuthToken(token)
  try {
    const me = await apiRequest<MePayload>('/auth/me')
    useAuth.setState({ status: 'authenticated', user: me.user, modelKey: me.modelKey })
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      writeToken(null)
      setAuthToken(null)
    }
    useAuth.setState({ status: 'anonymous', user: null, modelKey: null })
    return false
  }
}

export const login = async (email: string, password: string): Promise<void> => {
  const payload = await apiRequest<SessionPayload>('/auth/login', {
    method: 'POST',
    json: { email, password },
  })
  applySession(payload)
  await refreshModelKey()
}

export const register = async (email: string, password: string): Promise<void> => {
  const payload = await apiRequest<SessionPayload>('/auth/register', {
    method: 'POST',
    json: { email, password },
  })
  applySession(payload)
  await refreshModelKey()
}

export const logout = async (): Promise<void> => {
  try {
    await apiRequest('/auth/logout', { method: 'POST' })
  } catch {
    // 凭证已在服务端失效也无妨，本地照样清干净
  }
  writeToken(null)
  setAuthToken(null)
  useAuth.setState({ status: 'anonymous', user: null, modelKey: null })
  const { wipeCache } = await import('./chat/db.js')
  await wipeCache()
}

/** 刷新服务端 Key 状态（保存/删除后调用） */
export const refreshModelKey = async (): Promise<ModelKeyStatus | null> => {
  try {
    const status = await apiRequest<ModelKeyStatus>('/model-key')
    useAuth.setState({ modelKey: status })
    return status
  } catch {
    return null
  }
}

/** 是否已具备可用的模型 Key；没有时由设置面板引导填写 */
export const hasModelKey = (): boolean => useAuth.getState().modelKey?.configured === true

// 凭证过期或被吊销：任何带凭证的请求收到 401 都退回登录页，避免一直报错
setUnauthorizedHandler(() => {
  writeToken(null)
  setAuthToken(null)
  useAuth.setState({ status: 'anonymous', user: null, modelKey: null })
  void import('./chat/db.js')
    .then(({ wipeCache }) => wipeCache())
    .catch(() => undefined)
})
