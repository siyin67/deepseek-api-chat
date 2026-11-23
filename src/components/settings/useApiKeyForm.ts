import { useState } from 'react'
import { ApiError, saveModelKey } from '../../services/api/client.js'
import { refreshModelKey } from '../../services/auth.js'
import { classifyApiError } from '../../services/api/errors.js'
import { useTranslate } from '../../i18n/index.js'

/**
 * 输入模型 Key 后交给服务端校验并加密保存（浏览器只拿回掩码）。
 * 服务端校验通过才会落库，失败时把原因翻译成原有文案。
 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await saveModelKey(apiKey)
      await refreshModelKey()
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
