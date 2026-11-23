/**
 * 上下文拼装与裁剪（服务端权威版本）。
 *
 * 这里是 src/services/chat/reply.ts 中 toRequestMessages / toUserParam / toAssistantParam /
 * getContextRounds / isUsableReply 的服务端移植，语义必须保持一致（历史思考不回传、只回传
 * read_link 工具块与签名、latest_reminder 快照、续写前缀）。改动任一实现时请同步另一侧。
 *
 * 服务端只信任数据库里的消息，不使用浏览器传来的历史；浏览器只提交「本轮回复 id」。
 */

export const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
export const DEFAULT_MODEL = 'deepseek-flash'
/** 安全审核固定开启，与前端一致 */
export const SAFETY_CHECK = { level: 'high' } as const

export type Block = { type: string } & Record<string, unknown>

export interface ContextFile {
  serverId?: string | null
  isImage?: boolean
}

export interface ContextUserMessage {
  role: 'user'
  content: string
  files: ContextFile[]
}

export interface ContextAssistantMessage {
  role: 'assistant'
  status: string
  stopReason?: string | null
  prefix?: boolean
  thinking?: boolean
  latestReminder?: string
  blocks: Block[]
}

export type ContextMessage = ContextUserMessage | ContextAssistantMessage

export interface MessagesRequestBody {
  model: string
  system: string
  messages: unknown[]
  thinking: { type: 'enabled' | 'disabled' }
  safety_check: { level: 'high' }
  tools: Array<{ type: string; name: string }>
  title?: { enabled: boolean }
  stream: true
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** 数据库行 → 上下文消息；结构不合法的行直接丢弃（宁可少一轮，也不给上游发脏数据）。 */
export function toContextMessage(row: {
  role: string
  content: string
  files: unknown
  reply: unknown
}): ContextMessage | null {
  if (row.role === 'user') {
    return {
      role: 'user',
      content: row.content,
      files: asArray(row.files)
        .filter(isRecord)
        .map((file) => ({
          serverId: typeof file.serverId === 'string' ? file.serverId : null,
          isImage: file.isImage === true,
        })),
    }
  }
  if (row.role !== 'assistant') return null
  const reply = isRecord(row.reply) ? row.reply : {}
  return {
    role: 'assistant',
    status: asString(reply.status),
    stopReason: typeof reply.stopReason === 'string' ? reply.stopReason : null,
    prefix: reply.prefix === true,
    thinking: reply.thinking === true,
    latestReminder: typeof reply.latestReminder === 'string' ? reply.latestReminder : undefined,
    blocks: asArray(reply.blocks).filter(isRecord) as Block[],
  }
}

/** 附件按 Files API 的 file_id 引用：图片 image 块，其余 document 块；没有 serverId 的不进请求。 */
const toFileBlocks = (files: ContextFile[]): Array<{
  type: 'image' | 'document'
  source: { type: 'file'; file_id: string }
}> =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: (isImage ? 'image' : 'document') as 'image' | 'document',
            source: { type: 'file' as const, file_id: serverId },
          },
        ]
      : [],
  )

export const getReplyText = (reply: ContextAssistantMessage): string =>
  reply.blocks.map((block) => (block.type === 'text' ? asString(block.text) : '')).join('')

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传，服务端模板提示同样不算。
 */
const isUsableReply = (message: ContextMessage): message is ContextAssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate === true) &&
  getReplyText(message) !== ''

/** 有文件时先文件后文本 */
const toUserParam = ({ content, files }: ContextUserMessage): Record<string, unknown> => {
  const blocks = toFileBlocks(files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text', text: content }] : [])],
      }
}

/**
 * assistant 内容块转换：
 * - 历史思考与其签名不回传；续写只保留本轮非空思考及其签名；
 * - 文本块去掉 citations，相邻文本拼接，被思考或工具隔开的文本用空行连接；
 * - 工具块只回传 kind 为 read_link 的调用与结果，缺签名的阅读链接整对剔除。
 */
const toAssistantParam = (
  reply: ContextAssistantMessage,
  prefix = false,
  thinking = false,
): Record<string, unknown> => {
  const blocks = reply.blocks
  const unsignedReadLinks = new Set<string>()
  for (const block of blocks) {
    if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      isRecord(block.content) &&
      block.content.type === 'web_fetch_result' &&
      !asString(block.signature).trim()
    ) {
      unsignedReadLinks.add(asString(block.tool_use_id))
    }
  }
  const content: unknown[] = []
  let text: { type: 'text'; text: string } | null = null
  for (const block of blocks) {
    if (prefix && block.type === 'thinking' && !asString(block.thinking).trim()) {
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += asString(block.text)
      } else {
        const previous = content.at(-1)
        const needsBlank = isRecord(previous) && previous.type === 'text'
        text = { type: 'text', text: `${needsBlank ? '\n\n' : ''}${asString(block.text)}` }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: asString(block.thinking),
        signature: asString(block.signature),
      })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(asString(block.id))
    ) {
      content.push({
        type: 'server_tool_use',
        id: asString(block.id),
        name: asString(block.name),
        input: block.input,
        kind: block.kind,
      })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(asString(block.tool_use_id))
    ) {
      content.push(block)
    }
  }
  return {
    role: 'assistant',
    content: content.filter(
      (block) => !(isRecord(block) && block.type === 'text' && asString(block.text) === ''),
    ),
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答才保留 */
export function getContextRounds(history: ContextMessage[]): Array<[ContextUserMessage, ContextAssistantMessage]> {
  const rounds: Array<[ContextUserMessage, ContextAssistantMessage]> = []
  for (let i = 0; i + 1 < history.length; i += 1) {
    const user = history[i]
    const reply = history[i + 1]
    if (user && reply && user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i += 1
    }
  }
  return rounds
}

export function toRequestMessages(
  history: ContextMessage[],
  question: ContextUserMessage,
  prefix?: ContextAssistantMessage,
  thinking = false,
  latestReminder?: string,
): unknown[] {
  const messages: unknown[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      previousReminder = reminder
    }
  }
  for (const [user, reply] of getContextRounds(history)) {
    if (!user.content && toFileBlocks(user.files).length === 0) {
      continue
    }
    appendReminder(reply.latestReminder)
    messages.push(toUserParam(user), toAssistantParam(reply))
  }
  appendReminder(latestReminder)
  messages.push(toUserParam(question))
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    const blocks = asArray(assistant.content)
    const hasContent = blocks.some(
      (block) =>
        isRecord(block) &&
        ((block.type === 'text' && asString(block.text).trim()) ||
          (block.type === 'thinking' && asString(block.thinking).trim())),
    )
    if (hasContent) messages.push(assistant)
  }
  return messages
}

/** 粗略 token 估算：CJK 按 1 token/字，其余按 4 字符/token。 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let tokens = 0
  for (const char of text) {
    tokens += char.codePointAt(0)! > 0x2e80 ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

type Role = string

const roleOf = (message: unknown): Role => (isRecord(message) ? asString(message.role) : '')

/**
 * 按 token 预算裁剪历史：从最早的一轮开始整轮丢弃，本轮提问与续写前缀永远保留。
 * 返回裁剪后的 messages 与被丢弃的轮次数，便于日志观察成本。
 */
export function trimToBudget(
  messages: unknown[],
  budget: number,
): { messages: unknown[]; droppedRounds: number } {
  if (budget <= 0 || messages.length === 0) return { messages, droppedRounds: 0 }
  // 尾部保留：当前提问（user）以及可能存在的续写前缀（assistant）
  let tailStart = messages.length - 1
  if (tailStart > 0 && roleOf(messages[tailStart]) === 'assistant') tailStart -= 1
  const head = messages.slice(0, tailStart)
  const tail = messages.slice(tailStart)

  const units: unknown[][] = []
  for (const message of head) {
    const role = roleOf(message)
    const current = units.at(-1)
    const startsUnit = role === 'latest_reminder' || role === 'user'
    if (!current || startsUnit) {
      units.push([message])
    } else {
      current.push(message)
    }
  }

  const unitTokens = (unit: unknown[]): number => {
    let sum = 0
    for (const message of unit) sum += estimateTokens(message)
    return sum
  }
  let total = 0
  for (const message of tail) total += estimateTokens(message)
  for (const unit of units) total += unitTokens(unit)
  let droppedRounds = 0
  while (total > budget && units.length > 1) {
    const dropped = units.shift()
    if (!dropped) break
    total -= unitTokens(dropped)
    droppedRounds += 1
  }
  return { messages: [...units.flat(), ...tail], droppedRounds }
}

/** 是否含文件块（决定请求要不要带 Files API 的 beta 头） */
export function hasFileBlocks(messages: unknown[]): boolean {
  return messages.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && (block.type === 'image' || block.type === 'document'),
      ),
  )
}

export function serverTools(search: boolean): Array<{ type: string; name: string }> {
  const tools = [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }]
  if (search) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  return tools
}

export interface TurnRequestInput {
  model: string
  history: ContextMessage[]
  question: ContextUserMessage
  prefix?: ContextAssistantMessage
  thinking: boolean
  search: boolean
  latestReminder?: string
  withTitle: boolean
  budget: number
}

export interface TurnRequestResult {
  body: MessagesRequestBody
  droppedRounds: number
  messageCount: number
}

export function buildTurnRequest(input: TurnRequestInput): TurnRequestResult {
  const raw = toRequestMessages(
    input.history,
    input.question,
    input.prefix,
    input.thinking,
    input.latestReminder,
  )
  const trimmed = trimToBudget(raw, input.budget)
  return {
    body: {
      model: input.model,
      system: SYSTEM_PROMPT,
      messages: trimmed.messages,
      thinking: { type: input.thinking ? 'enabled' : 'disabled' },
      safety_check: SAFETY_CHECK,
      tools: serverTools(input.search),
      ...(input.withTitle ? { title: { enabled: true } } : {}),
      stream: true,
    },
    droppedRounds: trimmed.droppedRounds,
    messageCount: trimmed.messages.length,
  }
}
