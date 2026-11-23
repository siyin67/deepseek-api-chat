import { useState } from 'react'
import { ApiError } from '../../services/api/client.js'
import { login, register } from '../../services/auth.js'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './LoginView.module.css'

type Mode = 'login' | 'register'

/** 服务端错误码 → 文案；未知错误退回通用提示 */
const describeAuthError = (
  error: unknown,
  t: ReturnType<typeof useTranslate>,
  mode: Mode
): string => {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return t('loginInvalid')
      case 'email_taken':
        return t('loginEmailTaken')
      case 'registration_disabled':
        return t('loginRegistrationDisabled')
      case 'rate_limited':
        return t('loginRateLimited')
      case 'invalid_email':
      case 'invalid_password':
        return mode === 'login' ? t('loginInvalid') : t('loginPasswordTooShort')
      default:
        break
    }
    if (error.kind === 'network') {
      return t('commonNetworkErrorToast')
    }
    if (error.message) {
      return error.message
    }
  }
  return t('commonNetworkErrorToast')
}

/** 未登录时占满窗口的登录 / 注册卡片，样式沿用会话列表与设置里的输入框 */
export const LoginView = () => {
  const t = useTranslate()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (busy) {
      return
    }
    const address = email.trim()
    if (!address) {
      setError(t('loginEmailRequired'))
      return
    }
    if (password.length < 8) {
      setError(t('loginPasswordTooShort'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'login') {
        await login(address, password)
      } else {
        await register(address, password)
      }
      setPassword('')
    } catch (e) {
      setError(describeAuthError(e, t, mode))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.title}>{t('loginTitle')}</div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className={styles.field}>
            <input
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              spellCheck={false}
              placeholder={t('loginEmailPlaceholder')}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <input
              type="password"
              name="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={t('loginPasswordPlaceholder')}
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="l" block disabled={busy}>
            {busy
              ? t(mode === 'login' ? 'loginSubmitting' : 'loginRegisterSubmitting')
              : t(mode === 'login' ? 'loginSubmit' : 'loginRegisterSubmit')}
          </Button>
        </form>
        <button
          type="button"
          className={styles.switch}
          disabled={busy}
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError(null)
          }}
        >
          {t(mode === 'login' ? 'loginToRegister' : 'loginToLogin')}
        </button>
      </div>
    </div>
  )
}
