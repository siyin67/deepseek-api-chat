/**
 * 口令散列、登录凭证、模型 Key 加密。
 * 全部使用 node:crypto，无原生依赖，Docker 构建不需要编译工具链。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const ENC_PREFIX = 'enc:v1:'

export function newId(): string {
  return randomUUID()
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number.parseInt(parts[1] as string, 10)
  const r = Number.parseInt(parts[2] as string, 10)
  const p = Number.parseInt(parts[3] as string, 10)
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  const salt = Buffer.from(parts[4] as string, 'base64')
  const expected = Buffer.from(parts[5] as string, 'base64')
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 登录凭证：32 字节随机串，只返回给客户端一次，库里只存 sha256。 */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 注册口令：去掉容易混淆的 0/O/1/I，按大写生成，手抄也不会错。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createRegistrationCode(length = 8): string {
  const bytes = randomBytes(length)
  let code = ''
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  }
  return code
}

/** 口令比较：忽略大小写与空白，避免用户手抄时的大小写问题；用定长比较防时序侧信道。 */
export function matchesRegistrationCode(input: string, expected: string): boolean {
  const normalize = (value: string) => Buffer.from(value.trim().toUpperCase(), 'utf8')
  const left = normalize(input)
  const right = normalize(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (!payload.startsWith(ENC_PREFIX)) throw new Error('密文格式不支持')
  const [ivPart, tagPart, dataPart] = payload.slice(ENC_PREFIX.length).split(':')
  if (!ivPart || !tagPart || !dataPart) throw new Error('密文格式损坏')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 只暴露掩码：sk-****…ab12 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim()
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length)
  const head = trimmed.slice(0, 3)
  const tail = trimmed.slice(-4)
  return `${head}${'*'.repeat(Math.max(4, trimmed.length - 7))}${tail}`
}
