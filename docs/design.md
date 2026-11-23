# deepseek-api-chat 服务端化改造方案

> 版本：v1（改造前方案稿，实现已完成）
>
> 本文保留改造前的设计与取舍记录，**以实现代码与根目录 `README.md` 为准**。已落地版本与本文的主要差异：
> 1. 未新增 `shared/` 共用层，服务端自持 `server/src/context.ts`（见下方修订说明）；
> 2. 反向代理用 **Caddy**（`deploy/Caddyfile`，`flush_interval -1`）实现，文中 Nginx 方案仅作等价参考；
> 3. `Dockerfile`、`docker-compose.yml`、`.env.example` 统一放在 `deploy/` 下，而非仓库根目录；
> 4. 运行时基础镜像为 `node:22-alpine`；账号体系为「邮箱 + 密码，可开关注册」。
>
> 范围：仓库根（原 `chat-demo/`，项目现已更名为 `deepseek-api-chat`）+ 新增 `server/`、`deploy/`。下文出现的 `chat-demo/` 均为改造前的目录名，属历史记录。
>
> 实现期修订：原计划的 `shared/` 共用层**未采纳**——为避免移动现有前端模块（保持「改动集中、可回滚」），
> 服务端自持一份上下文拼装实现 `server/src/context.ts`（与 `src/services/chat/reply.ts` 同构，文件头已注明需同步维护）。
> 因此下文出现的 `shared/*` 一律对应到 `server/src/context.ts`（`branches.ts` 的消息树逻辑在服务端由 SQL + 路径遍历实现）。
> 原则：前端界面与交互逻辑不变（登录界面除外）；Key 不出服务端；不本地执行 Docker 构建。

---

## 1. 现有代码分析结论

### 1.1 运行与构建

| 项 | 现状 |
| --- | --- |
| 技术栈 | React 18.3 + zustand 4.4 + TypeScript 7 + rspack 2；包管理 pnpm（`pnpm-lock.yaml`） |
| 开发 | `rspack serve -c rspack.config.ts`，端口 8090 |
| 构建 | `rm -rf dist && NODE_ENV=production rspack build` |
| 类型检查 | `tsc -p tsconfig.json`（strict、noEmit、noUnusedLocals/Parameters） |
| 静态注入 | `DefinePlugin` 注入 `__API_ORIGIN__`（默认 `https://api.deepseek.com`） |
| 后端 | **无**。README 明确「纯静态、无应用后端，浏览器直连 API」 |

### 1.2 数据流现状

```
浏览器 ─┬─ localStorage  (settings.ts: 'chat-demo:*' 含 apiKey 明文)
        ├─ IndexedDB    (db.ts: 'chat-demo' v11, sessions/sessionSummaries/files/staging)
        └─ fetch 直连 https://api.deepseek.com
              ├─ POST /anthropic/v1/messages     (SSE 流式，x-api-key 头)
              ├─ POST /anthropic/v1/files        (附件上传)
              ├─ GET  /models                    (Key 校验)
              └─ POST /v1/tools/asr|tts          (语音)
```

### 1.3 存储读写位置（改造核心）

- `src/services/chat/db.ts`（251 行）是**唯一**持久化出入口，导出：`loadSessionSummaries`、`loadSession`、`saveSession(session, files)`、`renameSession`、`deleteSession`、`saveFiles`、`loadFile`、`clearStaging`、`addStagingSession`、`saveStagingFiles`、`updateStagingFileTypes`、`commitStaging`、`reportStorageError`。
- 调用方只有 `src/services/chat/store.ts`（1118 行 zustand）与 `history/backup.ts`、`history/importArchive.ts`。
- 因此**「前端原有读写调用点保持不变」是可实现的**：把 `db.ts` 的实现换成 HTTP 客户端即可，store 与组件零改动。

### 1.4 请求发起位置（改造核心）

- `src/services/api/client.ts`：`API_ORIGIN = __API_ORIGIN__`、`ANTHROPIC_BASE_URL = ${API_ORIGIN}/anthropic/v1`；`streamMessage(apiKey, body, signal)` 用 `readServerSentEvents` 逐帧 `JSON.parse` 后 yield；`uploadFile`/`deleteFile`/`verifyApiKey`。
- `src/services/api/speech.ts`：`TOOLS_BASE_URL = ${API_ORIGIN}/v1/tools`。
- `src/services/api/sse.ts`：`ServerSentEventDecoder` + `readServerSentEvents`（**保留不动**，服务端透传同格式 SSE 即零改动）。
- 所有请求都经过 `request()` → `fetch`，是唯一的网络出口。

### 1.5 状态与组件结构

- 状态：`useChatStore`（会话/缓存/流式/UI）、`useSettings`（apiKey/locale/theme/thinking/search/…）、`useDrafts`（内存草稿）、`useUploads`（附件任务）、`useSettingsDialog`。
- 已具备「列表只存 `SessionSummary` + 详情按需加载 + 缓存上限 5」的结构（`SESSION_CACHE_LIMIT=5`），**天然贴合分层懒加载要求**。
- 消息树：`rootMessageId` + `parentId` + `selectedChildId`，由 `branches.ts` 维护（`appendBranch`/`selectVersion`/`getVisibleMessages`）。
- 上下文拼装：`reply.ts` 的 `getContextRounds` / `toRequestMessages` / `toAssistantParam`（纯 TS，仅 type-only import，**可原样被 Node 服务端复用**）。
- 流式渲染：`applyEvent` + rAF 节流 `flush` + `settleReply`；`MessageList` 负责 sticky 滚动与版本切换。
- 样式语言：`theme.css` 的 CSS 变量（`--dsw-alias-*`、`--ds-control-height-*`、`--ds-ease-in-out` 等）、`base/Modal`、`base/Button`、`base/Input` 等组件——登录界面与加载态全部复用它们。

### 1.6 Key 相关引用点（必须全部移除前端明文）

`settings.ts`、`api/client.ts`（全部请求）、`api/speech.ts`、`attachments.ts`、`drafts.ts`、`chat/store.ts:835/1024`、`chatInput/ChatInput.tsx:81,89`、`settings/ApiKeyField.tsx`、`settings/useApiKeyForm.ts`、`settings/settingsDialogState.ts`、`speech/readAloud.ts:95-102`、`chatInput/useVoiceInput.ts:78`。

### 1.7 本地环境限制（影响验证方式）

- `pnpm.exe`、`git.exe` 被沙箱拒绝执行；`npm install` 因缓存目录在 `%LOCALAPPDATA%` 被拒（workspace-write）。
- 因此**不依赖本地构建验证**：以 `tsc` 类型检查为目标（若 `npm install --cache .npm-cache` 可行则执行），其余以静态审查 + 文件自检为准；不在本地跑 Docker（用户明确要求）。

---

## 2. 改造点清单与涉及文件

### 2.1 新增（整体可删除即回滚）

```
chat-demo/server/                 后端（Fastify + pg + 静态托管）
  types.ts                        （实现期取消：见文首修订说明）
  branches.ts                     （实现期取消：服务端用 SQL + 路径遍历实现）
  reply.ts                        （实现期取消：改为 server/src/context.ts）
  context.ts                      上下文拼装 + 按 token 预算裁剪历史轮次
  protocol.ts                     接口契约类型（由 routes/* 与前端 client.ts 各自声明）
chat-demo/server/
  package.json  tsconfig.json  package-lock.json
  src/index.ts                    Fastify 启动 + 静态托管 dist + SPA 回退
  src/config.ts                   环境变量读取与校验
  src/db.ts                       pg Pool + 启动时幂等建表
  src/schema.ts                   建表 SQL
  src/http.ts                     错误模型、Bearer 鉴权、游标编解码
  src/auth.ts                     scrypt 口令、token 签发/校验、鉴权钩子
  src/crypto.ts                   AES-256-GCM 加解密 + mask
  src/routes/auth.ts              注册/登录/登出/me
  src/routes/sessions.ts          会话元数据、消息分页、增量同步、批量导入
  src/routes/turns.ts             会话轮次流式接口（上下文权威 + SSE 透传）
  src/routes/files.ts             Anthropic Files 代理
  src/routes/speech.ts            ASR/TTS 代理
  src/routes/modelKey.ts          Key 设置/掩码/校验
  src/upstream.ts                 上游 fetch + Key 注入 + 透传头
chat-demo/deploy/                 （见 §7）
```

### 2.2 修改（集中于 8 个文件 + 2 个配置）

| 文件 | 改动 | 规模 |
| --- | --- | --- |
| `src/services/chat/db.ts` | 重写为「服务端为真相源 + IndexedDB 仅缓存」：分页加载、增量推送、串行队列、`wipeCache` | 重写内部 |
| `src/services/api/client.ts` | 去掉 `apiKey`；base 改为同源 `/api`；`streamMessage` → `streamTurn`（`/api/sessions/:id/turns`）；Bearer 注入与 401 兜底 | 中 |
| `src/services/api/speech.ts` | 去掉 `apiKey`，走 `/api/speech/{transcribe,synthesize}` | 小 |
| `src/services/attachments.ts` | 去掉 `apiKey` 形参（内部队列不再传） | 小 |
| `src/services/chat/drafts.ts` | `addDraftFiles` 去掉 `apiKey` | 小 |
| `src/services/chat/store.ts` | `streamReply` 去掉 apiKey/本地 key 读取；新增 `refreshSessionSummaries`、`loadMoreSessions`、`loadOlderMessages`（纯增量） | 小 |
| `src/services/settings.ts` | 删除 `apiKey` 明文；新增 `modelKeyConfigured`/`modelKeyMask`（只读展示） | 小 |
| `src/app/App.tsx` | 未登录渲染 `<LoginView/>`；登录后 `initChat()` | 小 |
| `src/components/messages/MessageList.tsx` | 顶部「加载更早」触发（滚动到顶 + 加载态），复用现有骨架/错误态样式 | 小 |
| `src/components/sider/Sider.tsx` | 列表底部哨兵 + 增量加载（不改变视觉，仅追加 spinner 行） | 小 |
| `src/components/settings/{SettingsDialog,ApiKeyField,useApiKeyForm,settingsDialogState}.tsx` | Key 区域改为「服务端密钥：已配置 sk-***abcd / 未配置」+ 设置/校验/清除 | 中 |
| `src/components/{chatInput/ChatInput.tsx,speech/readAloud.ts,chatInput/useVoiceInput.ts}` | `ensureApiKey` → `ensureModelKey`/`ensureAuth`，去 apiKey 实参 | 小 |
| `src/i18n/{zh,en}.ts` | 登录、密钥、加载更多等新文案 | 小 |
| `rspack.config.ts`、`src/env.d.ts` | 去掉 `__API_ORIGIN__`/DefinePlugin；devServer 增加 `/api` → `http://127.0.0.1:3000` 代理（生产同源，不需要别名） | 小 |
| 新增 `src/services/auth.ts`、`src/components/auth/LoginView.tsx(+.module.css)` | 登录态（token + me + Key 状态）、登录/注册界面 | 中 |

---

## 3. 服务端接口契约

统一：`Authorization: Bearer <token>`；响应 `application/json`；错误体 `{"error":{"code","message"}}`。
`serverTime` 为服务器 UTC ISO 时间，用于增量同步基准。

### 3.1 认证

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `{email,password}` | `201 {token,user{id,email},expiresAt}` |
| POST | `/api/auth/login` | `{email,password}` | `200 {token,user,expiresAt}` |
| POST | `/api/auth/logout` | — | `204` |
| GET | `/api/auth/me` | — | `200 {user,modelKey{configured,masked}}` |

### 3.2 会话元数据接口（**不含任何消息内容**）

| 方法 | 路径 | 参数 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | `limit=30`（1..100）、`cursor`（不透明串） | `{items:[{id,title,createdAt,updatedAt}],nextCursor,hasMore,serverTime}` |
| GET | `/api/sessions/changes` | `since=<ISO>`、`limit` | `{items:[meta…],deletedIds:[uuid…],nextSince,serverTime}` |
| PATCH | `/api/sessions/:id` | `{title}` | `200 {id,title,updatedAt}` |
| DELETE | `/api/sessions/:id` | — | `204` |
| DELETE | `/api/sessions` | — | `204`（清空全部，供「删除全部会话」） |

- 排序：`updated_at DESC, id DESC`；游标 = `base64("<updated_at ms>|<id>")`，服务端校验格式非法返回 `400 invalid_cursor`。
- 增量：`changes` 只回元数据与删除墓碑，永不回消息。

### 3.3 会话消息接口（**按需、分页**）

| 方法 | 路径 | 参数 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id` | `limit=30` | `{session:{id,title,createdAt,updatedAt,rootMessageId,pathIds:[…]},messages:[…升序…],hasMore,serverTime}` |
| GET | `/api/sessions/:id/messages` | `before=<messageId>&limit=30` 或 `after=<messageId>&limit=30` | `{messages:[…],hasMore,serverTime}` |
| PUT | `/api/sessions/:id` | `{title?,rootMessageId?,updatedAt,messages:[MessageRow…],deletedMessageIds?[]}` | `200 {updatedAt,syncedIds:[…]}` |
| POST | `/api/sessions/bulk` | `{sessions:[{meta,messages}],mode:'replace'\|'merge'}` | `200 {summaries:[…]}` |

- `MessageRow` = `{id,sessionId,parentId,selectedChildId,role,content,files,reply,createdAt}`，与 `src/services/chat/types.ts` 的 `UserMessage`/`AssistantMessage` 一一对应（assistant 的 `thinking/blocks/status/usage/error` 整体存 `reply` JSONB）。
- **分页语义**：服务端只查询「可见路径」（从 `root_message_id` 沿 `selected_child_id` 走）的 id 序列（仅为 uuid，不取正文），再按页取行。默认返回**最近** `limit` 条；`before` 取更早一段，`after` 取增量（含版本切换后的重排）。
- 单次响应绝不含全量消息；`hasMore=false` 才算加载完。

### 3.4 流式轮次接口

`POST /api/sessions/:id/turns`

```jsonc
// 请求
{
  "replyId": "uuid",          // 本轮待填充的 assistant 消息 id（前端已 appendBranch + PUT 落库）
  "thinking": true,           // 是否启用深度思考
  "search": false,            // 是否启用智能搜索
  "budgetTokens": 120000      // 可选，覆盖服务端默认预算
}
```

- 服务端依据 `replyId` 在消息树中定位：`path = 可见路径`，`reply = path.at(-1)`，`question = path.at(-2)`，`history = path.slice(0,-2)`，`prefix = reply`。
- 服务端调用 `toRequestMessages(history, question, prefix, thinking, latestReminder)`（`server/src/context.ts`）并做 token 预算裁剪，注入 Key 请求上游。
- 响应：`200 text/event-stream`，**逐帧原样透传**上游 `event:`/`data:`（不新增自定义事件，不解析后重编码），因此前端 `readServerSentEvents` + `applyEvent` 全部零改动。
- 中断：前端 `AbortController.abort()` → 连接断开 → 服务端 abort 上游请求。
- 错误：流开始前的错误（无 Key/上游 4xx）→ 普通 JSON `{error:{code,message}}` + 状态码；流内错误保留上游 `event: error` 帧。

### 3.5 附件与语音代理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/files` | multipart `purpose`+`file`；服务端加 `anthropic-beta: files-api-2025-04-14` 转发 `/anthropic/v1/files`，返回 `FileObject` |
| DELETE | `/api/files/:fileId` | 转发上游删除 |
| POST | `/api/tools/asr` | multipart 音频 → 上游 ASR，JSON 透传 |
| POST | `/api/tools/tts` | `{text,voice_id,format,filter_markdown}` → 上游 PCM 流式透传（`audio/pcm`，不缓冲） |

### 3.6 模型 Key

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/model-key` | — | `{configured:boolean,masked?:string,source:'user'\|'server'\|'none'}` |
| PUT | `/api/model-key` | `{apiKey}` | `200 {configured,masked}`（服务端先向上游校验，通过才加密落库） |
| POST | `/api/model-key/verify` | `{apiKey}` | `200 {valid:true}` / `400 apiKeyInvalid` |
| DELETE | `/api/model-key` | — | `204` |

### 3.7 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `invalid_request` / `invalid_cursor` / `apiKeyInvalid` | 参数/Cursor 非法、Key 校验失败 |
| 401 | `unauthorized` / `invalid_credentials` | 未登录、凭证错误 |
| 403 | `forbidden` | 访问他人资源 |
| 404 | `not_found` | 会话/消息不存在 |
| 409 | `email_taken` | 邮箱已注册 |
| 413 | `payload_too_large` | 附件/请求过大 |
| 429 | `rate_limited` | 限流 |
| 502/504 | `upstream_error` / `upstream_timeout` | 上游失败/超时 |
| 500 | `internal` | 其他 |
| — | `key_missing`（502） | 未配置模型 Key |

---

## 4. 数据模型与 Key 加密

### 4.1 PostgreSQL 表（`server/src/schema.sql`，启动时幂等执行）

```sql
users(id uuid pk, email text unique not null, password_hash text, created_at, updated_at)
auth_tokens(id uuid pk, user_id→users, token_hash text unique, created_at, expires_at, last_used_at)
chat_sessions(id uuid pk, user_id→users, title text default '', root_message_id uuid null,
              created_at, updated_at, deleted_at)   -- 索引 (user_id, updated_at desc, id desc)
chat_messages(id uuid pk, session_id→chat_sessions, parent_id uuid, selected_child_id uuid,
              role text check in ('user','assistant'), content text, files jsonb, reply jsonb,
              created_at, seq bigserial)              -- 索引 (session_id, seq)
user_model_keys(user_id uuid pk→users, key_cipher text, key_mask text, updated_at)
```

- `id` 复用前端 `createId()`（标准 UUID），迁移与离线创建无需转换。
- 消息树字段与前端 `branches.ts` 完全同构 → 树语义零丢失，服务端不需要重新建模分支。

### 4.2 口令与凭证

- 口令：`node:crypto.scryptSync(password, salt(16B), 64)`，存 `scrypt$N$r$p$salt$hash`（无原生依赖，Docker 友好）。
- 会话凭证：32 字节随机 `token`，只在登录响应里出现一次；DB 只存 `sha256(token)`；`expires_at = now + AUTH_TOKEN_TTL_DAYS`（默认 30）。
- 登出删除该 token 行；改密/管理员操作可批量失效。

### 4.3 Key 加密（AES-256-GCM）

```
APP_ENCRYPTION_KEY (32 字节，base64 或 hex，env 提供)
cipher = aes-256-gcm(key, iv=random(12))
storage = "enc:v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ct)
```

- 明文仅在 `server/src/upstream.ts` 内以局部变量存在，用完即弃；**任何接口都不返回明文**。
- 掩码：`maskKey(k) = k.slice(0,3) + '*'.repeat(max(4, len-7)) + k.slice(-4)`（如 `sk-****…ab12`）。
- 读取顺序：用户自设 Key（`user_model_keys`）→ 服务端兜底 `DEEPSEEK_API_KEY`（env，同样视为机密，仅在内存解密使用）。
- 前端仅展示 `masked` 与 `source`，`settings.apiKey` 字段整体删除（含旧 localStorage 键的清理逻辑）。

---

## 5. 流式透传保障

**服务端**
1. 路由 `reply.raw.writeHead(200, {Content-Type:'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive', 'X-Accel-Buffering':'no'})` 后**逐块 `raw.write()`**，读完即写，不聚合。
2. 用 `for await (const chunk of upstream.body)`（undici `ReadableStream` → `Readable.fromWeb()`），不做 `JSON.parse` 再序列化，字节级保真。
3. 不注册 `@fastify/compress`；SSE 路由设 `requestTimeout = 0`（Fastify 5 用 `server.requestTimeout`/路由级 `config`），并 `reply.raw.socket.setNoDelay(true)`。
4. 客户端断开：`reply.raw.on('close')` → `AbortController.abort()` 中止上游，释放连接。
5. 不启用任何响应缓冲中间件（无 `onSend` hook 拦截 SSE 路由）。

**反向代理（nginx）**
```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_cache off;
gzip off;
chunked_transfer_encoding on;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_connect_timeout 15s;
```
（`/api/sessions/*/turns`、`/api/tools/tts` 单独 location 并显式关闭缓冲；`proxy_buffering off` 同时覆盖 `text/event-stream` 与 `audio/pcm`。）

**验证手段**：`curl -N` 观察逐帧到达；`X-Accel-Buffering: no` 双保险。

---

## 6. 扩展能力：保留 / 关闭

| 能力 | 现状 | 结论 | 说明 |
| --- | --- | --- | --- |
| 智能搜索 `deepseek_web_search` | 设置项 + 请求 `tools` | **保留** | 服务端纯透传，`search` 标记由请求体带入 |
| 链接阅读 `deepseek_read_url` | 始终携带 | **保留** | 同上，`read_link` 的 `server_tool_use`/`web_fetch_tool_result` 由共享 `reply.ts` 回传 |
| 标题生成 `title` | 无标题会话携带 | **保留** | 服务端按「无标题且首轮」注入 `title:true`；流中 `message_delta.title` 原样透传 |
| 深度思考 `thinking` | 设置项 | **保留** | `{type:'enabled'\|'disabled'}` 透传 |
| 附件/图片理解 | Files API | **保留** | 服务端 Files 代理；磁盘只存图片二进制于浏览器本地缓存 |
| 语音 ASR/TTS | `/v1/tools/*` | **保留** | 服务端代理，PCM 流式 |
| `deep_search`/`image_search`/`deep_image_search` | 类型存在但 UI 未用 | **不暴露** | 无入口，不加开关 |
| 浏览器直连上游 | 现状 | **关闭** | 只允许同源 `/api/*`；CSP `connect-src 'self'` |

结论：本次改造**不关闭任何现有 UI 入口**（后端为完整透传，无能力缺失）；仅移除「浏览器持有 Key」相关的交互。

---

## 7. Docker 部署文件清单与环境变量

### 7.1 文件

```
chat-demo/Dockerfile                     多阶段：web(build)→server(build)→runtime(node:24-alpine)
chat-demo/.dockerignore
chat-demo/deploy/docker-compose.yml      services: nginx / app / db（+ 可选 certbot, profiles:["tls"]）
chat-demo/deploy/nginx/conf.d/default.conf   TLS 终止 + SSE 关闭缓冲 + 静态资源缓存
chat-demo/deploy/nginx/conf.d/http-redirect.conf 80→443
chat-demo/deploy/.env.example
chat-demo/deploy/README.md               首次启动、证书、备份、升级、常见故障
```

- `app` 镜像：`node:24-alpine`，非 root 用户，`node server/dist/server/src/index.js`，同时用 `@fastify/static` 托管构建产物 `dist/`（单一入口，nginx 只做 TLS/压缩/限流）。
- `db`：`postgres:16-alpine` + 命名卷 `pgdata` + `healthcheck: pg_isready`；`app` 依赖 `condition: service_healthy`；启动时执行幂等 `schema.sql`。
- `nginx`：`nginx:1.27-alpine`，挂载证书目录 `./certs`（只读）。
- 不执行任何 Docker 构建（仅产出文件）。

### 7.2 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 是 | `production` | — |
| `PORT` | 否 | `3000` | 应用监听端口 |
| `DATABASE_URL` | 是 | — | `postgres://user:pass@db:5432/chat` |
| `APP_ENCRYPTION_KEY` | 是 | — | 32 字节 base64/hex；`openssl rand -base64 32` |
| `AUTH_TOKEN_TTL_DAYS` | 否 | `30` | 登录凭证有效期 |
| `ALLOW_REGISTRATION` | 否 | `true` | `false` 时注册接口 403 |
| `DEEPSEEK_API_KEY` | 否 | — | 服务端兜底 Key（用户未自设时使用） |
| `DEEPSEEK_API_BASE` | 否 | `https://api.deepseek.com` | 上游地址 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `600000` | 上游读超时 |
| `CONTEXT_TOKEN_BUDGET` | 否 | `120000` | 历史上下文 token 预算 |
| `SESSION_PAGE_SIZE` / `MESSAGE_PAGE_SIZE` | 否 | `30` / `30` | 默认分页 |
| `MAX_UPLOAD_MB` | 否 | `64` | 附件上限（与前端 64MB 对齐） |
| `TRUST_PROXY` | 否 | `true` | 取 `X-Forwarded-*` |
| `LOG_LEVEL` | 否 | `info` | pino 级别 |
| `PUBLIC_ORIGIN` | 否 | — | 用于 CSP/回调，如 `https://chat.example.com` |

### 7.3 首次启动

```bash
cp deploy/.env.example deploy/.env      # 填 DATABASE_URL / APP_ENCRYPTION_KEY / DEEPSEEK_API_KEY
# 证书：把 fullchain.pem / privkey.pem 放到 deploy/certs/
docker compose -f deploy/docker-compose.yml up -d
# 打开 https://<域名>/ → 注册（或 ALLOW_REGISTRATION=false 时预置账号）
```

---

## 8. 分层懒加载与缓存策略（落地细节）

| 环节 | 行为 |
| --- | --- |
| 启动 | 读 IndexedDB 缓存摘要 → 秒开渲染；同时拉 `/api/sessions?limit=30` 覆盖首页 + `/api/sessions/changes?since=` 增量刷新 |
| 列表滚动到底 | `loadMoreSessions()` → `cursor` 下一页；本地缓存并持久化到 IndexedDB |
| 点进会话 | `ensureSessionLoaded` → 先命中缓存（stale-while-revalidate）→ `GET /api/sessions/:id?limit=30`（最近 30 条）→ `after=` 增量补差异 |
| 滚动到顶 | `loadOlderMessages()` → `before=<首条 id>`，在列表顶部插入；保持滚动锚点（沿用 `restoreScrollRef` 机制） |
| 切换会话 | 命中缓存即渲染 + 后台 `after=` 校验；未命中走完整按需加载 |
| 写入 | `persist()` → `PUT /api/sessions/:id`，只推送与上次成功推送的 JSON 快照相比有变化的行（内存 `Map<sessionId,Map<msgId,hash>>`），会话元数据总是随行 |
| 删除 | `DELETE /api/sessions/:id` |
| 导入/导出 | 导入 `commitStaging` → `POST /api/sessions/bulk{mode:'replace'}`；导出仍走本地 ZIP（新增 `GET /api/sessions/:id/export` 不在本期范围） |
| 离线 | 缓存可读；写失败进入 `sessionSaveErrors`，沿用现有「重试保存」UI |

> 说明：附件二进制仍存浏览器 IndexedDB（体积原因），消息/元数据以服务端为真相源；`files[].serverId` 随消息上行，因此换设备后历史消息可正常回放上下文（服务端持有 file_id 供上游引用）。

---

## 9. 实施阶段（每阶段可独立验证）

1. **P1 服务端骨架**：`config`/`db`/`schema.sql`/`auth`/`crypto` + 健康检查。
2. **P2 会话与消息 API**：元数据分页、`changes`、消息分页、`PUT` 增量、`bulk`。
3. **P3 流式轮次**：`server/src/context.ts` 接入、Key 注入、SSE 透传、中断处理。
4. **P4 代理**：Files、ASR、TTS。
5. **P5 前端改造**：`auth.ts` + 登录界面 → `db.ts` 远端化（保留 `db.local.ts` 开关）→ `client.ts`/`speech.ts` 去 Key → settings/Key 区域 → 分页与加载更多。
6. **P6 部署文件** + 文档 + 自检清单。

**回滚**：新增目录（`server/`、`deploy/`）与新增前端文件整体删除即恢复纯前端形态；修改到的既有文件均可逐文件还原（`git checkout -- <file>`）。

**验收自检**（不依赖 Docker）：`tsc --noEmit` 通过、`readServerSentEvents` 未改动、`branches.ts`/`reply.ts` 行为由共享单份实现保证、Key 字符串在 `src/` 中零出现（grep 校验）、SSE 路由与 nginx 配置逐项对照 §5。
