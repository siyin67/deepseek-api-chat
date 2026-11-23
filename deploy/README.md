# 部署说明（Docker）

本目录只包含部署文件：**不需要在开发机上执行 Docker 构建**，把仓库传到服务器后用 `docker compose` 构建即可。

```
deploy/
├── Dockerfile              # 三阶段：前端静态资源 → 服务端 TS 编译 → 运行镜像
├── docker-compose.yml      # db(PostgreSQL) + app(Node)，应用端口映射到宿主机 127.0.0.1:3000
├── nginx.conf              # 宿主机 Nginx 反代配置（复制到 /etc/nginx/conf.d/ 后改域名）
├── Caddyfile               # 可选：不用宿主机 Nginx 时，让 compose 里的 Caddy 容器终止 HTTPS
└── .env.example            # 环境变量模板（复制为 .env 后修改）
```

## 架构

```
浏览器 ──HTTPS──> 宿主机 Nginx :443 ──> 127.0.0.1:3000 (app 容器) ──> PostgreSQL:5432
                                                              └──> api.deepseek.com（注入 Key 转发）
```

- 容器里**不跑反向代理**：应用只把 `3000` 映射到宿主机回环地址，由宿主机上已有的 Nginx 负责 HTTPS 与转发。公网不需要、也不应该直接访问应用端口。
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
   # 修改 POSTGRES_PASSWORD 为强密码
   ```

2. **构建并启动**

   ```bash
   docker compose up -d --build
   docker compose ps                 # db 与 app 两个服务都应为 running / healthy
   docker compose logs -f app        # 看到 "server ready" 即就绪
   ```

   首次启动时应用会自动建表（幂等），无需手动执行 SQL 迁移。此时应用已监听在宿主机 `127.0.0.1:3000`（可改 `APP_PORT`），由下面第 5 步的 Nginx 对外提供访问。

3. **取注册口令并注册账号**

   注册新账号需要邀请口令，口令在首次启动时生成并打印在日志里：

   ```bash
   docker compose logs app | grep 注册口令        # 形如 {"registrationCode":"ABCD2345"}
   ```

   想自己指定就把 `.env` 里的 `REGISTRATION_CODE` 填上（6–32 位大写字母/数字/短横线），**只在首次启动写入数据库**，之后以管理页面为准。

   打开 `https://<域名>/`，在登录页切到「注册」，填邮箱 + 密码（≥ 8 位）+ 注册口令。**第一个注册成功的账号自动成为超级管理员**，可以进入「设置 → 管理」查看账号列表、停用/删除账号、开关注册、查看与更换注册口令。

   之后如不再需要开放注册，在管理页把「开放注册」关掉即可（立即生效，无需重启；`.env` 里的 `ALLOW_REGISTRATION` 只作为首次启动的默认值）。

4. **配置模型 Key**

   任选其一：

   - **用户在页面里自填**：登录后「设置 → 数据管理 → API Key」，服务端会先验证 Key 有效性再加密入库。每个账号可以有自己的 Key。
   - **服务端统一兜底**：在 `.env` 里设置 `DEEPSEEK_API_KEY`，用户不填 Key 也能直接聊天（他们的 Key 为空时自动用兜底 Key）。

   两者都可以存在：用户自填优先，未填时回落到兜底 Key。

5. **配置宿主机 Nginx**（详见下一节）

## 反向代理：宿主机 Nginx → 容器

应用容器只把端口发布到宿主机回环地址，Nginx 直接在宿主机上反代，链条上只有 app 一个容器：

```
浏览器 ──HTTPS──> 宿主机 Nginx :443 ──HTTP──> 127.0.0.1:3000  (docker 发布端口)
```

### 1. 装配置

`deploy/nginx.conf` 是一份可直接用的站点配置（含 80 跳转、443 TLS、`/api/` 流式段）：

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/deepseek-api-chat.conf
sudo sed -i 's/chat\.example\.com/你的域名/g' /etc/nginx/conf.d/deepseek-api-chat.conf   # 共 5 处
sudo nginx -t && sudo nginx -s reload
```

要点：

- `upstream` 指向 `127.0.0.1:3000`；如果改了 `.env` 的 `APP_PORT`，这里要同步改。
- 证书路径默认 `/etc/letsencrypt/live/<域名>/`，用别的证书就改 `ssl_certificate` / `ssl_certificate_key`。
- 宿主机已经有 HTTPS 站点时，只把 443 段落里的 `location /api/` 和 `location /` 两段拷进现有 `server` 块即可。

### 2. 拿证书

按环境挑一种：

```bash
# A. 还没有 Nginx 配置：让 certbot 直接改配置（最省事）
sudo certbot --nginx -d chat.example.com

# B. 已按上面装好配置：只申请证书，走 webroot（80 端口需可达）
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d chat.example.com

# C. 已有证书（公司 CA、云厂商托管）：跳过，直接改 ssl_certificate 路径
```

续期：certbot 自带的 systemd timer 已处理，只需要让它重载 Nginx：

```bash
sudo certbot renew --dry-run                                    # 先演练
sudo certbot renew --deploy-hook "systemctl reload nginx"       # 或写进 /etc/letsencrypt/cli.ini
```

### 3. 暂时没有域名 / 证书

先只跑 HTTP 调试：把 `nginx.conf` 里的 443 `server` 块整段注释掉，并把 80 段里的 `return 301 ...` 换成 `proxy_pass http://deepseek_api_chat;` 加上 `/api/` 那段流式配置。

### 4. 可选：不想在宿主机装 Nginx

compose 里带了一个 Caddy 容器做替代，改 `.env` 后重启即可（应用端口仍然同时映射到回环，互不影响）：

```bash
COMPOSE_PROFILES=caddy
SITE_ADDRESS=chat.example.com     # 填域名自动申请 HTTPS；:80 则只开 HTTP
```

```bash
docker compose up -d
```

## 流式接口的硬性要求

流式聊天要求中间层不得缓冲、不得压缩、超时要足够长，否则前端会变成「整段延迟输出」或者中途断流：

| 要求 | Nginx | Caddy |
| --- | --- | --- |
| 不缓冲，逐帧下发 | `proxy_buffering off` | `reverse_proxy { flush_interval -1 }` |
| 不压缩流式响应 | `/api/` 段里 `gzip off` | `/api/*` 分支不写 `encode` |
| 长读超时 | `proxy_read_timeout 3600s` | `transport http { read_timeout 1h; write_timeout 1h }` |
| 上传不落盘 | `proxy_request_buffering off` | 默认即流式 |
| 应用侧兜底 | 响应头 `X-Accel-Buffering: no`、`Cache-Control: no-store`（服务端已带） | 同上 |

### 关键段落（自己写配置时照抄这几行）

```nginx
location /api/ {
    proxy_pass http://deepseek_api_chat;    # upstream 指向 127.0.0.1:3000
    proxy_http_version 1.1;
    proxy_set_header Connection "";      # 保持 chunked 透传 + upstream keepalive
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                 # 流式逐帧下发，不要删
    proxy_request_buffering off;         # 上传边收边转
    proxy_cache off;
    gzip off;                            # 流式响应不压缩
    proxy_read_timeout 3600s;            # 必须远大于单轮回答时长
    proxy_send_timeout 3600s;
    send_timeout 3600s;
}
```

另外别忘 `client_max_body_size 80m;`（≥ `MAX_UPLOAD_MB` 默认 64MB），否则上传大附件会收到 413。若前面还套了一层云负载均衡或 Cloudflare，那一层同样要关缓冲（如 Cloudflare 的 `Cache Rules → Bypass` 或直接 DNS-only）。


## 常用运维命令

```bash
docker compose logs -f app          # 应用日志
docker compose restart app          # 改完 .env 后重启应用
docker compose down                 # 停止（保留数据卷）
docker compose down -v              # 停止并删除数据卷（会清空全部会话与账号！）

# 备份 / 恢复数据库
docker compose exec -T db pg_dump -U deepseekchat deepseekchat > backup.sql
cat backup.sql | docker compose exec -T db psql -U deepseekchat -d deepseekchat
```

## 升级

```bash
git pull            # 或重新上传代码
cd deploy
docker compose up -d --build
```

数据库表结构由服务端启动时以 `CREATE TABLE IF NOT EXISTS` 保证幂等；如需新增列，需自行扩展 `server/src/schema.ts`。

## 小内存机器：不要在这台服务器上构建

`docker compose up -d --build` 会在容器里跑 `pnpm build`（rspack）和 `tsc`，峰值内存约 1–1.5 GB。
**1–2 GB 内存且没有 swap 的 VPS 会被打满**，表现为：构建卡在 `RUN pnpm build` 几十分钟、`load average` 冲到 40+、`wa` 80%+、SSH 连不上（ping 仍有响应），最后构建被杀且没有产出新镜像。

先确认是不是老镜像还在跑：

```bash
docker image inspect deepseek-api-chat-app:latest --format 'Created={{.Created}}'
docker compose exec app grep -c "return await fn" server/dist/http.js   # 修复应 >= 1
```

### 方案 A：加 swap 后在后台构建（本机继续用 build）

```bash
# 1) 2 GB swap（一次性，写进 fstab 让它跟随机器重启）
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h | grep -i swap

# 2) 后台构建，日志落文件（关掉 SSH 也不会中断）
cd deploy
nohup docker compose build app > /tmp/build.log 2>&1 &
disown

# 3) 每隔几分钟看一眼
grep -E "naming to|ERROR" /tmp/build.log | tail -3

# 4) 出现 naming to ... done 之后
docker compose up -d
```

构建卡死时（`Ctrl+C` 只断开 CLI，构建仍在服务端跑）：

```bash
sudo pkill -9 -f rspack-node
sudo pkill -9 -f "tsc -p tsconfig.json"
docker system prune -f
```

### 方案 B：用 CI 构建好的镜像（推荐，服务器零编译）

仓库自带 `.github/workflows/docker.yml`：push 到 `main` 时在 GitHub 的机器上构建并推到
`ghcr.io/<你的用户名>/deepseek-api-chat:latest`，服务器只 pull。

1. GitHub 仓库页面 → **Actions** 里等 `docker` 工作流变绿；
2. 首次使用需要让服务器能拉取镜像，二选一：
   - 把 GHCR 上的 package 设为公开：仓库主页右侧 **Packages** → 该镜像 → *Package settings* → *Change visibility* → Public；
   - 或者服务器上登录一次（用个人访问令牌，勾选 `read:packages`）：`echo <TOKEN> | docker login ghcr.io -u <用户名> --password-stdin`；
3. 改 `deploy/docker-compose.yml`：注释掉 `app` 下的 `build:` 四行，打开 `image:` 那行（默认已是 `ghcr.io/siyin67/deepseek-api-chat:latest`，按需改用户名）；
4. 以后每次更新只需要：

```bash
cd deploy
docker compose pull
docker compose up -d
```

## 环境变量说明

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `APP_PORT` | 否 | `3000` | 应用发布到宿主机回环的端口（`127.0.0.1:${APP_PORT}:3000`）；改了就同步改 `nginx.conf` 的 upstream |
| `COMPOSE_PROFILES` | 否 | 空 | 留空 = 不启动任何代理容器（配合宿主机 Nginx）；填 `caddy` = 启动 Caddy 容器自动终止 HTTPS |
| `SITE_ADDRESS` | 否 | `:80` | 仅 caddy 模式：监听地址。填域名走自动 HTTPS，填 `:80` 只开 HTTP |
| `POSTGRES_DB` | 否 | `deepseekchat` | 数据库名 |
| `POSTGRES_USER` | 否 | `deepseekchat` | 数据库用户 |
| `POSTGRES_PASSWORD` | **是** | — | 数据库密码，请改为强密码 |
| `DATABASE_URL` | **是**（compose 内自动拼） | — | 应用侧数据库连接串 |
| `DATABASE_POOL_SIZE` | 否 | `10` | 连接池上限 |
| `APP_ENCRYPTION_KEY` | **是** | — | 32 字节（base64 或 64 位 hex），模型 Key 的加密主密钥。**丢失后已保存的 Key 无法解密** |
| `AUTH_TOKEN_TTL_DAYS` | 否 | `30` | 登录凭证有效期（天） |
| `ALLOW_REGISTRATION` | 否 | `true` | 是否允许注册新账号（仅首次启动的默认值，之后以管理页面为准） |
| `REGISTRATION_CODE` | 否 | 随机生成 | 注册邀请口令（6–32 位大写字母/数字/短横线），留空则启动时生成并打印在日志里；仅首次启动写入数据库 |
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
| `nginx -t` 报 `cannot load certificate` | 证书还没申请或路径不对：先按「拿证书」申请，或临时注释 443 段落只跑 HTTP |
| Nginx 返回 502 / `Connection refused` | 应用没起来或端口不一致：`docker compose ps` 看 app 是否 running，`curl -I http://127.0.0.1:3000/api/health` 应返回 200，端口要和 `APP_PORT` 及 upstream 一致 |
| 上传附件返回 413 | 代理的 `client_max_body_size` 小于上传体积：调到 ≥ `MAX_UPLOAD_MB`（默认 64MB） |
| 登录后立刻又回到登录页 | 浏览器存了旧凭证：清掉站点数据重新登录；或检查 `AUTH_TOKEN_TTL_DAYS` 是否被改小 |
| 提示未配置模型 Key | 用户未填 Key 且未设置 `DEEPSEEK_API_KEY`：到「设置 → 数据管理」填写，或在 `.env` 配兜底 Key |
| `APP_ENCRYPTION_KEY` 报错 | 长度不是 32 字节。用 `openssl rand -base64 32` 重新生成（改密钥会导致已存 Key 失效） |
| 应用启动即退出 | `docker compose logs app` 查看缺失的环境变量（`DATABASE_URL`、`APP_ENCRYPTION_KEY` 必填） |
