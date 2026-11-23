import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteAdminUser,
  fetchAdminSettings,
  fetchAdminUsers,
  saveAdminSettings,
  setAdminUserDisabled,
  type AdminSettings,
  type AdminUser,
} from '../../services/api/client.js'
import { useAuth } from '../../services/auth.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconCopyOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingCell } from './SettingCell.js'
import styles from './AdminPanel.module.css'
import settingsStyles from './Settings.module.css'

/**
 * 管理页（仅超级管理员）：注册开关、注册口令、账号列表（停用 / 启用 / 删除）。
 * 只读账号元数据，不暴露任何会话内容；停用后该账号的登录凭证立即失效。
 */
export const AdminPanel = () => (
  <>
    <RegistrationSection />
    <UsersSection />
  </>
)

const RegistrationSection = () => {
  const t = useTranslate()
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchAdminSettings()
      .then((value) => {
        if (alive) {
          setSettings(value)
          setFailed(false)
        }
      })
      .catch(() => {
        if (alive) {
          setFailed(true)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const apply = async (patch: { allowRegistration?: boolean; registrationCode?: string | null }) => {
    setBusy(true)
    try {
      setSettings(await saveAdminSettings(patch))
      return true
    } catch {
      showToast({ key: 'adminActionFailed', type: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const toggleRegistration = async () => {
    if (!settings || busy) {
      return
    }
    const next = !settings.allowRegistration
    if (await apply({ allowRegistration: next })) {
      showToast({ key: next ? 'adminRegistrationOnToast' : 'adminRegistrationOffToast' })
    }
  }

  const copyCode = async () => {
    if (!settings) {
      return
    }
    try {
      await navigator.clipboard.writeText(settings.registrationCode)
      showToast({ key: 'adminCodeCopied' })
    } catch {
      showToast({ key: 'adminCodeCopyFailed', type: 'error' })
    }
  }

  const regenerate = async () => {
    if (busy) {
      return
    }
    if (await apply({ registrationCode: null })) {
      showToast({ key: 'adminCodeRegenerated' })
    }
  }

  return (
    <>
      <SettingCell
        label={t('adminRegistrationTitle')}
        description={failed ? t('commonNetworkErrorToast') : t('adminRegistrationDescription')}
        status={null}
        action={
          <Button
            variant={settings?.allowRegistration ? 'outlined' : 'primary'}
            size="m"
            className={settingsStyles.cellButton}
            disabled={busy || !settings}
            onClick={() => void toggleRegistration()}
          >
            {t(settings?.allowRegistration ? 'adminRegistrationTurnOff' : 'adminRegistrationTurnOn')}
          </Button>
        }
      />
      <SettingCell
        label={t('adminRegistrationCode')}
        status={null}
        description={t('adminRegistrationCodeDescription')}
        action={
          <div className={styles.codeActions}>
            <code className={styles.code}>
              {settings ? settings.registrationCode : failed ? '—' : '······'}
            </code>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              disabled={busy || !settings}
              onClick={() => void copyCode()}
            >
              <IconCopyOutline16 />
              {t('adminCodeCopy')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              disabled={busy || !settings}
              onClick={() => void regenerate()}
            >
              {t('adminCodeRegenerate')}
            </Button>
          </div>
        }
      />
    </>
  )
}

const UsersSection = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const selfId = useAuth((state) => state.user?.id)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<AdminUser | null>(null)
  const started = useRef(false)

  const load = useCallback(async (from: string | null, append: boolean) => {
    setLoading(true)
    try {
      const page = await fetchAdminUsers(from)
      setUsers((prev) => (append ? [...prev, ...page.users] : page.users))
      setCursor(page.nextCursor)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (started.current) {
      return
    }
    started.current = true
    void load(null, false)
  }, [load])

  const replace = (user: AdminUser) =>
    setUsers((prev) => prev.map((item) => (item.id === user.id ? user : item)))

  const toggleUser = async (user: AdminUser) => {
    setPending(user.id)
    try {
      const updated = await setAdminUserDisabled(user.id, !user.disabled)
      replace(updated)
      showToast({ key: updated.disabled ? 'adminUserDisabledToast' : 'adminUserEnabledToast' })
    } catch {
      showToast({ key: 'adminActionFailed', type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const removeUser = async (user: AdminUser) => {
    setPending(user.id)
    try {
      await deleteAdminUser(user.id)
      setUsers((prev) => prev.filter((item) => item.id !== user.id))
      setConfirming(null)
      showToast({ key: 'adminUserDeletedToast' })
    } catch {
      showToast({ key: 'adminActionFailed', type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const describe = (user: AdminUser): string => {
    const date = new Date(user.createdAt).toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const parts = [
      user.role === 'admin' ? t('adminRoleAdmin') : '',
      user.disabled ? t('adminUsersDisabledTag') : '',
      t('adminUserMeta', { count: String(user.sessionCount), date }),
    ]
    return parts.filter(Boolean).join(' · ')
  }

  return (
    <>
      <div className={styles.groupTitle}>{t('adminUsersTitle')}</div>
      {users.map((user) => (
        <SettingCell
          key={user.id}
          label={user.id === selfId ? `${user.email}${t('adminUserSelfSuffix')}` : user.email}
          description={describe(user)}
          status={null}
          action={
            user.id === selfId ? null : (
              <div className={styles.userActions}>
                <Button
                  variant="outlined"
                  size="m"
                  className={settingsStyles.cellButton}
                  disabled={pending === user.id}
                  onClick={() => void toggleUser(user)}
                >
                  {t(user.disabled ? 'adminUserEnable' : 'adminUserDisable')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  size="m"
                  className={settingsStyles.cellButton}
                  disabled={pending === user.id}
                  onClick={() => setConfirming(user)}
                >
                  {t('adminUserDelete')}
                </Button>
              </div>
            )
          }
        />
      ))}
      {failed ? (
        <div className={styles.hint} role="alert">
          {t('commonNetworkErrorToast')}
          <Button
            variant="outlined"
            size="m"
            className={settingsStyles.cellButton}
            disabled={loading}
            onClick={() => void load(null, false)}
          >
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {!failed && !loading && users.length === 0 ? (
        <div className={styles.hint}>{t('adminUsersEmpty')}</div>
      ) : null}
      {loading ? (
        <div className={styles.hint} role="status">
          {t('sessionLoading')}
        </div>
      ) : null}
      {cursor && !loading ? (
        <div className={styles.more}>
          <Button
            variant="outlined"
            size="m"
            className={settingsStyles.cellButton}
            onClick={() => void load(cursor, true)}
          >
            {t('adminUsersLoadMore')}
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <Modal
          title={t('adminDeleteConfirmTitle')}
          className={settingsStyles.deleteConfirm}
          onClose={() => setConfirming(null)}
          footer={
            <div className={settingsStyles.deleteActions}>
              <Button variant="outlined" autoFocus onClick={() => setConfirming(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={pending === confirming.id}
                onClick={() => void removeUser(confirming)}
              >
                {t('delete')}
              </Button>
            </div>
          }
        >
          {t('adminDeleteConfirmBody', { email: confirming.email })}
        </Modal>
      ) : null}
    </>
  )
}
