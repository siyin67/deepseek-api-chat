import { create } from 'zustand'
import { hasModelKey } from '../../services/auth.js'

/** 设置弹窗的分组：通用设置 / 数据管理 / 管理（仅超级管理员） */
export type SettingsSection = 'general' | 'data' | 'admin'

/** 设置弹窗：侧边栏底部、没有模型 Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 没有可用的模型 Key 时打开设置并选中 Key 所在的「数据管理」，返回是否已有 Key。
 * Key 由服务端保管，这里只看服务端返回的配置状态。
 */
export const ensureApiKey = () => {
  if (hasModelKey()) {
    return true
  }
  openSettings('data')
  return false
}
