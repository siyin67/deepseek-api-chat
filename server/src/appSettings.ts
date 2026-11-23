/**
 * 运行期可改的站点设置：是否开放注册、注册口令。
 *
 * 首次启动时用环境变量（ALLOW_REGISTRATION / REGISTRATION_CODE）兜底写入数据库，
 * 之后一律以数据库为准——管理员在「设置 → 管理」里修改，无需重启。
 * 注册口令是共享邀请码，不是每用户的密钥，因此明文存库即可（接口只对管理员返回）。
 */
import type { AppConfig } from './config.js'
import { createRegistrationCode } from './crypto.js'
import type { Database } from './db.js'

export interface AppSettings {
  allowRegistration: boolean
  registrationCode: string
}

export interface AppSettingsPatch {
  allowRegistration?: boolean
  /** 省略 = 不改；null = 重新随机生成一个。 */
  registrationCode?: string | null
}

const ALLOW_KEY = 'allow_registration'
const CODE_KEY = 'registration_code'
const CODE_PATTERN = /^[A-Z0-9-]{6,32}$/

interface SettingRow {
  key: string
  value: unknown
}

async function readRows(db: Database): Promise<Map<string, unknown>> {
  const rows = await db.query<SettingRow>('SELECT key, value FROM app_settings')
  const map = new Map<string, unknown>()
  for (const row of rows) {
    map.set(row.key, row.value)
  }
  return map
}

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return normalized === '' ? null : normalized
}

/** 校验管理员自定义口令，非法时抛错由路由转 400。 */
export function normalizeRegistrationCode(input: string): string {
  const code = input.trim().toUpperCase()
  if (!CODE_PATTERN.test(code)) {
    throw new Error('注册口令只能是 6–32 位字母、数字或连字符')
  }
  return code
}

/**
 * 启动时调用：补齐缺失的设置行，并给出「口令是否为本次随机生成」（用于打日志提示管理员去看）。
 */
export async function ensureAppSettings(
  db: Database,
  config: AppConfig,
): Promise<{ settings: AppSettings; generatedCode: boolean }> {
  const existing = await readRows(db)
  const generatedCode = !existing.has(CODE_KEY)
  const seed: AppSettings = {
    allowRegistration: asBool(existing.get(ALLOW_KEY), config.allowRegistration),
    registrationCode:
      asCode(existing.get(CODE_KEY)) ?? asCode(config.registrationCode) ?? createRegistrationCode(),
  }
  const inserts: Array<[string, unknown]> = []
  if (!existing.has(ALLOW_KEY)) inserts.push([ALLOW_KEY, config.allowRegistration])
  if (generatedCode) inserts.push([CODE_KEY, seed.registrationCode])
  for (const [key, value] of inserts) {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)],
    )
  }
  return { settings: seed, generatedCode }
}

export async function readAppSettings(db: Database, fallback: AppSettings): Promise<AppSettings> {
  const rows = await readRows(db)
  return {
    allowRegistration: asBool(rows.get(ALLOW_KEY), fallback.allowRegistration),
    registrationCode: asCode(rows.get(CODE_KEY)) ?? fallback.registrationCode,
  }
}

export async function writeAppSettings(
  db: Database,
  patch: AppSettingsPatch,
  fallback: AppSettings,
): Promise<AppSettings> {
  const updates: Array<[string, unknown]> = []
  if (patch.allowRegistration !== undefined) {
    updates.push([ALLOW_KEY, patch.allowRegistration])
  }
  if (patch.registrationCode !== undefined) {
    updates.push([
      CODE_KEY,
      patch.registrationCode === null
        ? createRegistrationCode()
        : normalizeRegistrationCode(patch.registrationCode),
    ])
  }
  for (const [key, value] of updates) {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }
  return readAppSettings(db, fallback)
}
