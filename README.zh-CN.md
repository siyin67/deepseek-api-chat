# DeepSeek API Chat

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天应用，已改造为可自托管的服务形态：账号登录、会话与消息服务端存储、模型请求由服务端转发。浏览器不持有模型 API Key，只与本站的 `/api` 通信。

与原静态示例相比，会话与消息保存在 PostgreSQL 中，同一账号换设备登录即可看到全部历史；除新增的登录界面外，原有界面与交互保持不变。

## 运行（开发环境）

需要 Node.js 22+、pnpm，以及一个 PostgreSQL 实例（也可以 `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`）。

```sh
# 1) 前端依赖
pnpm install

# 2) 服务端依赖
cd server && npm install && cd ..

# 3) 环境变量
cp deploy/.env.example deploy/.env   # 然后按注释修改
# DATABASE_URL、APP_ENCRYPTION_KEY 为必填；密钥生成：
openssl rand -base64 32

# 4) 分别启动服务端（3000）与前端开发服务器（8090）
cd server && npm run dev          # 终端一
pnpm dev                          # 终端二，/api 会代理到 :3000
```

打开 http://localhost:8090 ，注册账号后，在「设置 → 数据管理」填写自己的模型 Key，或在服务端配置 `DEEPSEEK_API_KEY` 作为兜底。

类型检查：前端 `pnpm type`，服务端 `cd server && npm run build`。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- 邮箱 + 密码账号；会话、消息与加密后的模型 Key 均存服务端，跨设备同步。

## 数据

服务端是唯一真相源：

- 账号、会话、消息与加密后的模型 Key 保存在 PostgreSQL。
- 模型 Key 使用 `APP_ENCRYPTION_KEY` 以 AES-256-GCM 加密入库，接口只返回 `sk-***abcd` 形式的掩码。
- 浏览器携带登录凭证请求本站 `/api`，任何时候都拿不到 Key 明文。
- IndexedDB 仅作为**缓存**：侧边栏先渲染会话元数据，进入会话时才拉取消息，滚动到顶部再向前翻页；主题、语言、语音等本地设置仍在 localStorage。

设置中的历史导入导出仍使用 ZIP 格式，导入的会话会被推送到服务端；导出包含会话与本地可用的图片原件，不包含 API Key 与设置。格式说明见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空服务端与本地的全部会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。

## 部署

Docker 部署文件位于 [`deploy/`](deploy/README.md)：多阶段 `Dockerfile`、`docker-compose.yml`（应用 + PostgreSQL + Caddy）、对流式接口关闭缓冲与压缩的 `Caddyfile`，以及 `.env.example`。首次启动步骤与完整环境变量说明见 [deploy/README.md](deploy/README.md)。

## 开发

| 命令          | 用途                  |
| ------------- | --------------------- |
| `pnpm dev`    | 启动前端开发服务器 8090 |
| `pnpm build`  | 构建前端到 `dist/`    |
| `pnpm type`   | 前端 TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查           |
| `pnpm format` | oxfmt 格式化          |

[rspack.config.ts](rspack.config.ts) 在开发时把 `/api` 代理到 `http://127.0.0.1:3000`；可用 `createConfig({ devServer })` 自定义。

```text
deploy/                Docker、反向代理、环境变量模板
server/                API 服务（Fastify + PostgreSQL）
  src/config.ts        环境变量校验
  src/crypto.ts        密码哈希、登录凭证、Key 加密
  src/context.ts       上下文组装与 token 预算裁剪
  src/routes/          auth、model key、sessions、turns、files、speech
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、登录、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、流式 SSE 与协议类型
    chat/              会话、消息分支、服务端同步与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
