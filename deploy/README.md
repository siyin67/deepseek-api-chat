# 部署说明（Docker）

本目录只包含部署文件：**不需要在开发机上执行 Docker 构建**，把仓库传到服务器后用 `docker compose` 构建即可。

```
deploy/
├── Dockerfile          # 三阶段：前端静态资源 → 服务端 TS 编译 → 运行镜像
├── docker-compose.yml  # db(PostgreSQL) + app(Node) + caddy(反向代理/HTTPS)
├── Caddyfile           # 反向代理配置：流式接口不缓冲、不压缩、长超时
└── .env.example        # 环境变量模板（复制为 .env 后修改）
```

## 架构

```
浏览器 ──HTTPS──> caddy:443 ──> app:3000 ──> PostgreSQL:5432
                          │                  └──> api.deepseek.com（注入 Key 转发）
                          └── 同源提供前端静态文件
```

- 只有一个应用容器：`app` 同时提供 `/api`（含流式聊天接口）与前端静态文件，避免跨域与 CORS 配置。
- 会话与消息、账号、加密后的模型 Key 都存在 PostgreSQL 的命名卷 `pgdata` 里。
- 模型 Key 只存在于服务端：用户的 Key 用 `APP_ENCRYPTION_KEY` 以 AES-256-GCM 加密入库，接口只返回掩码（如 `sk-***abcd`）。

## 首次启动

1. **准备环境变量**

   ```bash
   cd deploy
   cp .env.example .env
   # 生成 32 字节主密钥，粘贴到 .env 的 APP_ENCRYPTION_KEY=
   openssl rand -base64 32
   # 修改 POSTGRES_PASSWORD 为强密码；SITE_ADDRESS 填域名（自动 HTTPS），
   # 首次试跑可以保留 :80 走 HTTP
   ```

2. **构建并启动**

   ```bash
   docker compose up -d --build
   docker compose ps                 # 三个服务都应为 running / healthy
   docker compose logs -f app        # 看到 "server ready" 即就绪
   ```

   首次启动时应用会自动建表（幂等），无需手动执行 SQL 迁移。

3. **注册账号**

   打开 `http://<服务器地址>/`（或 `https://<域名>/`），在登录页切到「注册」，用邮箱 + 密码（≥ 8 位）注册。第一个账号注册完成后，建议把 `.env` 里的 `ALLOW_REGISTRATION` 改成 `false` 并 `docker compose up -d` 重启，关闭公开注册。

4. **配置模型 Key**

   任选其一：

   - **用户在页面里自填**：登录后「设置 → 数据管理 → API Key」，服务端会先验证 Key 有效性再加密入库。每个账号可以有自己的 Key。
   - **服务端统一兜底**：在 `.env` 里设置 `DEEPSEEK_API_KEY`，用户不填 Key 也能直接聊天（他们的 Key 为空时自动用兜底 Key）。

   两者都可以存在：用户自填优先，未填时回落到兜底 Key。

## 反向代理要点（已在 Caddyfile 中配置）

流式聊天要求中间层不得缓冲、不得压缩、超时要足够长，否则前端会变成「整段延迟输出」或者中途断流：

| 要求 | 配置 |
| --- | --- |
| 不缓冲，逐帧 flush | `reverse_proxy { flush_interval -1 }` |
| 不对流式响应压缩 | `/api/*` 分支不使用 `encode` |
| 长读超时 | `transport http { read_timeout 1h; write_timeout 1h }` |
| 关闭上游缓冲（应用侧） | 响应头 `X-Accel-Buffering: no`、`Cache-Control: no-store` |

Caddy 默认自动为域名申请并续期证书，无需额外配置 HTTPS。

### 想用 Nginx？

把 `caddy` 服务换成 nginx 镜像并改挂载配置，等价指令如下（关键是 `proxy_buffering off` 和长超时）：

```nginx
location /api/ {
    proxy_pass http://app:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # 不缓冲，流式逐帧下发
    proxy_cache off;
    gzip off;                     # 流式接口不压缩
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    chunked_transfer_encoding on;
}

location / {
    proxy_pass http://app:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

## 常用运维命令

```bash
docker compose logs -f app          # 应用日志
docker compose restart app          # 改完 .env 后重启应用
docker compose down                 # 停止（保留数据卷）
docker compose down -v              # 停止并删除数据卷（会清空全部会话与账号！）

# 备份 / 恢复数据库
docker compose exec -T db pg_dump -U chatdemo chatdemo > backup.sql
cat backup.sql | docker compose exec -T db psql -U chatdemo -d chatdemo
```

## 升级

```bash
git pull            # 或重新上传代码
cd deploy
docker compose up -d --build
```

数据库表结构由服务端启动时以 `CREATE TABLE IF NOT EXISTS` 保证幂等；如需新增列，需自行扩展 `server/src/schema.ts`。

## 环境变量说明

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `SITE_ADDRESS` | 否 | `:80` | Caddy 监听地址。填域名走自动 HTTPS，填 `:80` 只开 HTTP |
| `POSTGRES_DB` | 否 | `chatdemo` | 数据库名 |
| `POSTGRES_USER` | 否 | `chatdemo` | 数据库用户 |
| `POSTGRES_PASSWORD` | **是** | — | 数据库密码，请改为强密码 |
| `DATABASE_URL` | **是**（compose 内自动拼） | — | 应用侧数据库连接串 |
| `DATABASE_POOL_SIZE` | 否 | `10` | 连接池上限 |
| `APP_ENCRYPTION_KEY` | **是** | — | 32 字节（base64 或 64 位 hex），模型 Key 的加密主密钥。**丢失后已保存的 Key 无法解密** |
| `AUTH_TOKEN_TTL_DAYS` | 否 | `30` | 登录凭证有效期（天） |
| `ALLOW_REGISTRATION` | 否 | `true` | 是否允许注册新账号 |
| `DEEPSEEK_API_KEY` | 否 | 空 | 服务端兜底模型 Key（不下发浏览器，仅接口返回掩码） |
| `DEEPSEEK_API_BASE` | 否 | `https://api.deepseek.com` | 上游 API 地址 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `600000` | 单轮上游请求超时（毫秒） |
| `CONTEXT_TOKEN_BUDGET` | 否 | `120000` | 每轮输入上下文 token 预算，超出按整轮丢弃最早的历史 |
| `SESSION_PAGE_SIZE` | 否 | `30` | 会话元数据分页大小 |
| `MESSAGE_PAGE_SIZE` | 否 | `30` | 会话消息分页大小 |
| `MAX_UPLOAD_MB` | 否 | `64` | 单附件上传上限 |
| `PUBLIC_ORIGIN` | 否 | 空 | 对外访问地址，留空表示同源 |
| `TRUST_PROXY` | 否 | `true` | 位于反向代理之后，读取 `X-Forwarded-*` |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |
| `WEB_DIST_DIR` | 否 | `dist` | 前端静态文件目录（相对应用根 `/app`） |

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| 回复变成一次性整段输出 | 中间代理缓冲了 SSE。确认该路由 `proxy_buffering off` / `flush_interval -1`，且没有对它开 gzip |
| 长回答中途断开 | 代理读超时太短，调到 1h；同时确认 `UPSTREAM_TIMEOUT_MS` 足够大 |
| 登录后立刻又回到登录页 | 浏览器存了旧凭证：清掉站点数据重新登录；或检查 `AUTH_TOKEN_TTL_DAYS` 是否被改小 |
| 提示未配置模型 Key | 用户未填 Key 且未设置 `DEEPSEEK_API_KEY`：到「设置 → 数据管理」填写，或在 `.env` 配兜底 Key |
| `APP_ENCRYPTION_KEY` 报错 | 长度不是 32 字节。用 `openssl rand -base64 32` 重新生成（改密钥会导致已存 Key 失效） |
| 应用启动即退出 | `docker compose logs app` 查看缺失的环境变量（`DATABASE_URL`、`APP_ENCRYPTION_KEY` 必填） |
