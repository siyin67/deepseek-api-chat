/**
 * 会话与消息的存取层：**服务端是真相源，IndexedDB 只是本地缓存**。
 *
 * 读取：列表只取元数据（先给缓存，再后台增量刷新），消息只在进入会话时按需拉取，
 * 历史消息用「向上翻一页」的方式增量加载。
 *
 * 写入：先更新本地缓存让界面立刻可见，再把变化推送给服务端（新增走批量接口、
 * 改动走单条接口、标题走 PATCH），并用「每条消息的内容指纹」做增量，避免重复传输。
 *
 * 对外导出的函数名与原纯 IndexedDB 版本保持一致，调用点无需改动。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { ApiError, apiRequest } from '../api/client.js'
import { createId } from '../../utils/id.js'
import { getVisibleMessages } from './branches.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
} from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 12

/** 单次推送的消息条数上限（与服务端 batch 接口限制一致）。 */
const PUSH_BATCH = 200

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 本地同步状态：记录已推送到服务端的消息指纹，用于增量判断。 */
interface SyncEntry {
  id: string
  title: string
  /** 当前可见分支的根；编辑第一条消息后会换一个新根，需要单独同步 */
  rootMessageId?: string | null
  serverUpdatedAt: number
  hashes: Record<string, string>
  hasEarlier: boolean
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 会话缓存：进入过的会话（可能只有最近一页消息） */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /** 每个会话的增量同步状态 */
  syncState: { key: string; value: SyncEntry }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
// 库名沿用旧名：它是本地缓存的标识，改名只会让已有缓存失效（服务端仍是真相源）。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging', 'syncState'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

// ---------------------------------------------------------------------------
// 传输层类型
// ---------------------------------------------------------------------------

interface WireSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount?: number
}

interface WireMessage {
  id: string
  parentId: string | null
  selectedChildId: string | null
  role: 'user' | 'assistant'
  content: string
  files: FileAttachment[]
  reply: unknown
  createdAt: number
}

interface WireDetail extends WireSummary {
  rootMessageId: string | null
  messages: WireMessage[]
  hasMore: boolean
}

interface WireChange extends WireSummary {
  deleted?: boolean
}

// ---------------------------------------------------------------------------
// 会话摘要的增量刷新通知
// ---------------------------------------------------------------------------

let summariesListener: ((summary: SessionSummary[]) => void) | null = null

/** 注册列表刷新回调；后台拉到的元数据通过它推给界面。 */
export const watchSessionSummaries = (listener: ((summary: SessionSummary[]) => void) | null): void => {
  summariesListener = listener
}

// 增量游标要跨刷新保存：否则刷新后 lastSummarySync 归零，只会重拉第一页元数据，
// 别的设备删掉的会话拿不到墓碑记录，会一直留在侧边栏（点进去才 404）。
const SYNC_CURSOR_KEY = 'chat-demo:summary-cursor'
const SYNC_TIME_KEY = 'chat-demo:summary-sync-time'

const readStoredCursor = (): string | null => {
  try {
    return localStorage.getItem(SYNC_CURSOR_KEY)
  } catch {
    return null
  }
}

const readStoredSyncTime = (): number => {
  try {
    const raw = localStorage.getItem(SYNC_TIME_KEY)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** 把游标与上次同步时间写回 localStorage；写不进去就退化为仅内存。 */
const storeSyncState = (): void => {
  try {
    if (summaryCursor) {
      localStorage.setItem(SYNC_CURSOR_KEY, summaryCursor)
    } else {
      localStorage.removeItem(SYNC_CURSOR_KEY)
    }
    if (lastSummarySync > 0) {
      localStorage.setItem(SYNC_TIME_KEY, String(lastSummarySync))
    } else {
      localStorage.removeItem(SYNC_TIME_KEY)
    }
  } catch {
    // 隐私模式或存储被禁用，忽略。
  }
}

let summaryCursor: string | null = readStoredCursor()
let lastSummarySync = readStoredSyncTime()
let summaryRefresh: Promise<void> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// ---------------------------------------------------------------------------
// 消息与服务端格式互转
// ---------------------------------------------------------------------------

const fnv = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 内容指纹：不包含 id，用来判断同一条消息在本地是否被改过。 */
const signature = (message: Message): string => {
  const parts =
    message.role === 'user'
      ? [message.content, JSON.stringify(message.files)]
      : [
          message.status,
          message.stopReason ?? '',
          JSON.stringify(message.blocks),
          JSON.stringify(message.usage ?? null),
          JSON.stringify(message.error ?? null),
          JSON.stringify(message.thinking ?? null),
        ]
  const text = [message.parentId ?? '', message.selectedChildId ?? '', ...parts].join('\u0000')
  return `${text.length}:${fnv(text).toString(16)}`
}

const replyPayload = (message: AssistantMessage) => ({
  model: message.model,
  thinking: message.thinking ?? null,
  search: message.search ?? null,
  latestReminder: message.latestReminder ?? null,
  prefix: message.prefix,
  status: message.status,
  blocks: message.blocks,
  stopReason: message.stopReason ?? null,
  stopDetails: message.stopDetails ?? null,
  usage: message.usage ?? null,
  error: message.error ?? null,
})

const toWireMessage = (message: Message) => ({
  id: message.id,
  parentId: message.parentId ?? null,
  selectedChildId: message.selectedChildId ?? null,
  role: message.role,
  content: message.role === 'user' ? message.content : '',
  files: message.role === 'user' ? message.files : [],
  reply: message.role === 'assistant' ? replyPayload(message) : null,
  createdAt: message.createdAt,
})

const fromWireMessage = (row: WireMessage): Message => {
  const branch = {
    id: row.id,
    parentId: row.parentId ?? undefined,
    selectedChildId: row.selectedChildId ?? undefined,
    createdAt: row.createdAt,
  }
  if (row.role === 'user') {
    return { ...branch, role: 'user', content: row.content, files: Array.isArray(row.files) ? row.files : [] }
  }
  const reply = (row.reply && typeof row.reply === 'object' ? row.reply : {}) as Partial<AssistantMessage>
  return {
    ...branch,
    role: 'assistant',
    model: reply.model ?? null,
    thinking: reply.thinking ?? undefined,
    search: reply.search ?? undefined,
    latestReminder: reply.latestReminder ?? undefined,
    prefix: reply.prefix ?? false,
    status: reply.status ?? 'done',
    blocks: Array.isArray(reply.blocks) ? reply.blocks : [],
    stopReason: reply.stopReason ?? undefined,
    stopDetails: reply.stopDetails ?? undefined,
    usage: reply.usage ?? undefined,
    error: reply.error ?? undefined,
  }
}

/** 按父子关系排序，保证一次批量写入时父节点先落库（外键约束按行检查）。 */
const topoOrder = (messages: Message[]): Message[] => {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  const ordered: Message[] = []
  for (const message of messages) {
    const stack: Message[] = []
    let current: Message | undefined = message
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      stack.push(current)
      const parentId: string | null | undefined = current.parentId
      current = parentId ? byId.get(parentId) : undefined
    }
    while (stack.length > 0) {
      const next = stack.pop()
      if (next) {
        ordered.push(next)
      }
    }
  }
  return ordered
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 导入的历史可能带非 uuid 主键，落库前统一替换（服务端以 uuid 为主键）。 */
const remapSessionIds = (session: Session): Session => {
  const mapped = new Map<string, string>()
  const remap = (id: string | null | undefined): string | null | undefined => {
    if (!id) {
      return id
    }
    if (uuidPattern.test(id)) {
      return id
    }
    let next = mapped.get(id)
    if (!next) {
      next = createId()
      mapped.set(id, next)
    }
    return next
  }
  return {
    ...session,
    id: remap(session.id) as string,
    rootMessageId: remap(session.rootMessageId),
    messages: session.messages.map((message) => ({
      ...message,
      id: remap(message.id) as string,
      parentId: remap(message.parentId),
      selectedChildId: remap(message.selectedChildId),
    })) as Session['messages'],
  }
}

// ---------------------------------------------------------------------------
// 每个会话串行推送，避免并发写入互相覆盖
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>()

const enqueue = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(
    sessionId,
    next.catch(() => undefined)
  )
  return next
}

// ---------------------------------------------------------------------------
// 缓存读写
// ---------------------------------------------------------------------------

const putCache = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const readSummaryState = async (): Promise<SessionSummary[]> => {
  const database = await getDB()
  const rows = await database.getAll('sessionSummaries')
  return rows.map(toSessionSummary)
}

const writeSummaries = async (summaries: SessionSummary[]): Promise<void> => {
  const database = await getDB()
  const tx = database.transaction('sessionSummaries', 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const store = tx.store
        const existing = new Set(await store.getAllKeys())
        for (const summary of summaries) {
          const previous = await store.get(summary.id)
          await store.put({ ...summary, fileIds: previous?.fileIds ?? [] })
          existing.delete(summary.id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const notifySummaries = async (): Promise<void> => {
  if (!summariesListener) {
    return
  }
  const summaries = await readSummaryState()
  summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  summariesListener(summaries)
}

// ---------------------------------------------------------------------------
// 服务端请求
// ---------------------------------------------------------------------------

const fetchPage = async (cursor: string | null): Promise<{ summaries: SessionSummary[]; next: string | null }> => {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const page = await apiRequest<{ sessions: WireSummary[]; nextCursor: string | null; serverTime: number }>(
    `/sessions${query}`
  )
  lastSummarySync = page.serverTime
  storeSyncState()
  return { summaries: page.sessions.map(toSessionSummary), next: page.nextCursor }
}

const fetchChanges = async (): Promise<SessionSummary[]> => {
  const changes = await apiRequest<{ changes: WireChange[]; serverTime: number }>(
    `/sessions/changes?since=${encodeURIComponent(new Date(lastSummarySync).toISOString())}`
  )
  lastSummarySync = changes.serverTime
  storeSyncState()
  const database = await getDB()
  const removed: string[] = []
  const updated: SessionSummary[] = []
  for (const change of changes.changes) {
    if (change.deleted) {
      removed.push(change.id)
      continue
    }
    updated.push(toSessionSummary(change))
  }
  if (removed.length > 0) {
    const tx = database.transaction(['sessions', 'sessionSummaries', 'syncState'], 'readwrite')
    await Promise.all([
      (async () => {
        for (const id of removed) {
          await tx.objectStore('sessions').delete(id)
          await tx.objectStore('sessionSummaries').delete(id)
          await tx.objectStore('syncState').delete(id)
        }
      })(),
      tx.done,
    ])
  }
  await writeSummaries(updated)
  return readSummaryState()
}

/** 一次问服务端多少个会话 id 还在（分批避免请求过大）。 */
const LOOKUP_BATCH = 200

/**
 * 清掉「本地有缓存、但服务端已经没有了」的会话。
 * 只在拉第一页元数据后执行：此时收到的墓碑最多只有一个「上次同步之后」的窗口，
 * 更早被删掉的会话（换设备、升级前删的）不会出现在增量里，只能主动问一次。
 */
const pruneMissingSessions = async (page: SessionSummary[]): Promise<void> => {
  const cached = await readSummaryState()
  const onPage = new Set(page.map((summary) => summary.id))
  const candidates = cached.map((summary) => summary.id).filter((id) => !onPage.has(id))
  if (candidates.length === 0) {
    return
  }
  const missing: string[] = []
  for (let index = 0; index < candidates.length; index += LOOKUP_BATCH) {
    const ids = candidates.slice(index, index + LOOKUP_BATCH)
    const result = await apiRequest<{ missing: string[] }>('/sessions/lookup', {
      method: 'POST',
      json: { ids },
    })
    missing.push(...result.missing)
  }
  for (const id of missing) {
    await purgeLocalSession(id)
  }
}

/** 后台增量刷新会话元数据（列表已在界面上时用）。 */
export const refreshSummaries = (): Promise<void> => {
  if (summaryRefresh) {
    return summaryRefresh
  }
  summaryRefresh = (async () => {
    try {
      // 有同步时间但本地一条摘要都没有（缓存被清过）时不能只拉增量，否则列表会是空的。
      const cached = await readSummaryState()
      if (lastSummarySync > 0 && cached.length > 0) {
        await fetchChanges()
      } else {
        const page = await fetchPage(null)
        summaryCursor = page.next
        storeSyncState()
        await writeSummaries(page.summaries)
        await pruneMissingSessions(page.summaries)
      }
      await notifySummaries()
    } catch (error) {
      reportStorageError('refresh session summaries')(error)
    } finally {
      summaryRefresh = null
    }
  })()
  return summaryRefresh
}

/** 批量请求的会话元数据；本地有缓存时先返回缓存，再后台增量刷新。 */
export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const cached = await readSummaryState()
  cached.sort((left, right) => right.updatedAt - left.updatedAt)
  if (cached.length === 0) {
    try {
      await refreshSummaries()
      return (await readSummaryState()).sort((left, right) => right.updatedAt - left.updatedAt)
    } catch (error) {
      reportStorageError('load session summaries')(error)
      return cached
    }
  }
  void refreshSummaries()
  return cached
}

/** 再往下翻一页元数据（列表滚动到底时调用）；已经没有更多时返回 null。 */
export const loadMoreSessionSummaries = async (): Promise<SessionSummary[] | null> => {
  if (!summaryCursor) {
    await refreshSummaries()
    if (!summaryCursor) {
      return null
    }
  }
  const page = await fetchPage(summaryCursor)
  summaryCursor = page.next
  storeSyncState()
  await writeSummaries(page.summaries)
  await notifySummaries()
  const merged = await readSummaryState()
  return merged.sort((left, right) => right.updatedAt - left.updatedAt)
}

// ---------------------------------------------------------------------------
// 会话详情
// ---------------------------------------------------------------------------

const saveSyncState = async (session: Session, hasEarlier: boolean, messages: Message[]): Promise<void> => {
  const database = await getDB()
  const previous = await database.get('syncState', session.id)
  const hashes: Record<string, string> = { ...(previous?.hashes ?? {}) }
  for (const message of messages) {
    hashes[message.id] = signature(message)
  }
  await database.put('syncState', {
    id: session.id,
    title: session.title,
    rootMessageId: session.rootMessageId ?? null,
    serverUpdatedAt: session.updatedAt,
    hashes,
    hasEarlier,
  })
}

/** 把服务端返回的一页详情写成会话对象并缓存。 */
const absorbDetail = async (detail: WireDetail): Promise<Session> => {
  const database = await getDB()
  const cached = await database.get('sessions', detail.id)
  const page = detail.messages.map(fromWireMessage)
  const merged = new Map<string, Message>()
  for (const message of cached?.messages ?? []) {
    merged.set(message.id, message)
  }
  for (const message of page) {
    merged.set(message.id, message)
  }
  const session: Session = {
    id: detail.id,
    title: detail.title,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    messages: [...merged.values()].sort((left, right) => left.createdAt - right.createdAt),
  }
  // 分页首屏不带 rootMessageId（表示「只拿到了尾部一页」）。此时若缓存里已有完整的树，
  // 继续沿用旧根，渲染仍按分支路径走；没有缓存时才保持未知，按线性顺序渲染这一页。
  const root = detail.rootMessageId ?? cached?.rootMessageId
  if (root) {
    session.rootMessageId = root
  }
  const previous = await database.get('syncState', detail.id)
  await putCache(session)
  // 已与服务端对齐的内容记下指纹：之后本地改动只会推送真正变化的那几条
  const hashes: Record<string, string> = { ...(previous?.hashes ?? {}) }
  for (const message of session.messages) {
    hashes[message.id] = signature(message)
  }
  await database.put('syncState', {
    id: detail.id,
    title: session.title,
    rootMessageId: detail.rootMessageId ?? previous?.rootMessageId ?? null,
    serverUpdatedAt: detail.updatedAt,
    hashes,
    hasEarlier: detail.hasMore,
  })
  return session
}

/** 进入会话时读取消息：有缓存先给缓存，没有缓存才等网络。 */
export const loadSession = async (id: string): Promise<Session | undefined> => {
  const cached = await (await getDB()).get('sessions', id)
  if (cached) {
    return cached
  }
  const detail = await apiRequest<{ session: WireDetail }>(`/sessions/${encodeURIComponent(id)}`)
  return absorbDetail(detail.session)
}

/** 强制从服务端刷新某个会话（切回标签页、别的设备改过时用）；失败时保留缓存。 */
export const refreshSession = async (id: string): Promise<Session | undefined> => {
  try {
    const detail = await apiRequest<{ session: WireDetail }>(`/sessions/${encodeURIComponent(id)}`)
    return await absorbDetail(detail.session)
  } catch (error) {
    // 会话已在别的设备上删掉：清掉本地缓存，避免界面上留一个点进去就报错的幽灵会话
    if (error instanceof ApiError && error.status === 404) {
      await purgeLocalSession(id)
      return undefined
    }
    reportStorageError('refresh session')(error)
    return undefined
  }
}

/** 是否还有更早的历史可以继续往上翻。 */
export const canLoadEarlier = async (id: string): Promise<boolean> =>
  (await (await getDB()).get('syncState', id))?.hasEarlier === true

/** 本地缓存里还有没有这个会话（用于判断刷新失败是不是「已被别的设备删掉」）。 */
export const hasLocalSession = async (id: string): Promise<boolean> =>
  Boolean(await (await getDB()).get('sessions', id))

/**
 * 上次与服务端对齐时记录的会话更新时间（服务端时钟）。
 * 与列表里的 updatedAt 不一致说明别的设备改过，需要重新拉详情。
 */
export const serverUpdatedAt = async (id: string): Promise<number> =>
  (await (await getDB()).get('syncState', id))?.serverUpdatedAt ?? 0

/** 向上翻一页历史消息，合并进缓存后返回新会话；没有更多时返回 undefined。 */
export const loadEarlierMessages = async (id: string): Promise<Session | undefined> => {
  const database = await getDB()
  const cached = await database.get('sessions', id)
  const state = await database.get('syncState', id)
  if (!cached || state?.hasEarlier !== true) {
    return undefined
  }
  const oldest = getVisibleMessages(cached)[0] ?? cached.messages[0]
  if (!oldest) {
    return undefined
  }
  const detail = await apiRequest<{ session: WireDetail }>(
    `/sessions/${encodeURIComponent(id)}?before=${encodeURIComponent(oldest.id)}`
  )
  const page = detail.session.messages.map(fromWireMessage)
  const known = new Set(page.map((message) => message.id))
  const merged: Message[] = [...page, ...cached.messages.filter((message) => !known.has(message.id))]
  const session: Session = { ...cached, messages: merged }
  if (detail.session.rootMessageId) {
    session.rootMessageId = detail.session.rootMessageId
  }
  await putCache(session)
  // 新翻出来的这一页同样已与服务端对齐，记下指纹，避免下次推送把它们当成改动逐条 PUT
  const hashes: Record<string, string> = { ...state.hashes }
  for (const message of session.messages) {
    hashes[message.id] = signature(message)
  }
  await database.put('syncState', {
    id,
    title: session.title,
    rootMessageId: detail.session.rootMessageId ?? state.rootMessageId ?? null,
    serverUpdatedAt: state.serverUpdatedAt,
    hashes,
    hasEarlier: detail.session.hasMore,
  })
  return session
}

// ---------------------------------------------------------------------------
// 写入：先落缓存，再增量推送服务端
// ---------------------------------------------------------------------------

const pushSession = async (session: Session): Promise<void> => {
  const database = await getDB()
  const state = await database.get('syncState', session.id)
  if (!state) {
    await apiRequest('/sessions', {
      method: 'POST',
      json: { id: session.id, title: session.title, createdAt: session.createdAt },
    })
  }
  const fresh: Message[] = []
  const changed: Message[] = []
  for (const message of session.messages) {
    const hash = state?.hashes[message.id]
    if (!hash) {
      fresh.push(message)
    } else if (hash !== signature(message)) {
      changed.push(message)
    }
  }
  if (fresh.length > 0) {
    const ordered = topoOrder(fresh)
    for (let index = 0; index < ordered.length; index += PUSH_BATCH) {
      await apiRequest(`/sessions/${encodeURIComponent(session.id)}/messages/batch`, {
        method: 'POST',
        json: { messages: ordered.slice(index, index + PUSH_BATCH).map(toWireMessage) },
      })
    }
  }
  for (const message of changed) {
    await apiRequest(`/sessions/${encodeURIComponent(session.id)}/messages/${message.id}`, {
      method: 'PUT',
      json: toWireMessage(message),
    })
  }
  // 标题与可见分支的根都需要同步：编辑第一条消息会换根，换了根其他设备才能看到同一分支
  const patch: { title?: string; rootMessageId?: string | null } = {}
  if (state && state.title !== session.title) {
    patch.title = session.title
  }
  const root = session.rootMessageId ?? null
  if (!state ? root !== null : (state.rootMessageId ?? null) !== root) {
    patch.rootMessageId = root
  }
  if (patch.title !== undefined || patch.rootMessageId !== undefined) {
    await apiRequest(`/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      json: patch,
    })
  }
  const touched = [...fresh, ...changed]
  await saveSyncState(session, state?.hasEarlier ?? false, touched)
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  await putCache(session, files)
  await enqueue(session.id, () => pushSession(session))
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const database = await getDB()
  const tx = database.transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  await enqueue(id, async () => {
    await apiRequest(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', json: { title } })
    const state = await database.get('syncState', id)
    if (state) {
      await database.put('syncState', { ...state, title })
    }
  })
}

/** 只清本地缓存（不动服务端）：会话在别的设备上被删掉时用。 */
const purgeLocalSession = async (sessionId: string): Promise<void> => {
  const database = await getDB()
  const tx = database.transaction(['sessions', 'sessionSummaries', 'files', 'syncState'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await tx.objectStore('syncState').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话：先删服务端（真相源），成功后再清本地缓存与原件。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await enqueue(sessionId, async () => {
    try {
      await apiRequest(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    } catch (error) {
      // 已经不存在时视为删除成功，避免本地残留幽灵会话
      if (!(error instanceof ApiError) || error.status !== 404) {
        throw error
      }
    }
  })
  await purgeLocalSession(sessionId)
}

/** 清空本地缓存（退出登录时调用），服务端数据不受影响。 */
export const wipeCache = async (): Promise<void> => {
  const database = await getDB()
  const tx = database.transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      await tx.objectStore('sessions').clear()
      await tx.objectStore('sessionSummaries').clear()
      await tx.objectStore('files').clear()
      await tx.objectStore('syncState').clear()
      await tx.objectStore('sessionsStaging').clear()
      await tx.objectStore('filesStaging').clear()
    })(),
    tx.done,
  ])
  summaryCursor = null
  lastSummarySync = 0
  storeSyncState()
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', remapSessionIds(session))
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 * 替换成功后再把每个会话整体推送到服务端。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const imported: Session[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
        await tx.objectStore('syncState').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const session = cursor.value as Session
          const summary = storedSummary(session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
          imported.push(session)
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 导入的语义是「覆盖」：先清空账号下的旧会话，再把导入的会话整体推送上去。
  await apiRequest('/sessions', { method: 'DELETE' })
  const failed: string[] = []
  for (const session of imported) {
    try {
      await enqueue(session.id, () => pushSession(session))
    } catch (error) {
      reportStorageError('push imported session')(error)
      failed.push(session.id)
    }
  }
  if (failed.length > 0) {
    throw new Error(`有 ${failed.length} 个会话未能同步到服务端，请重试`)
  }
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
