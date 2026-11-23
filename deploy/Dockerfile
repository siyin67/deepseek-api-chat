# syntax=docker/dockerfile:1

# 1) 前端静态资源：用仓库自带的 pnpm-lock.yaml 保证可复现构建
FROM node:22-alpine AS web
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json rspack.config.ts ./
COPY src ./src
COPY LICENSE ./
RUN pnpm build

# 2) 服务端：编译 TypeScript，只保留运行时依赖
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# 3) 运行镜像：一个进程同时提供 API 与前端静态文件
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=server --chown=node:node /app/server/package.json ./server/package.json
COPY --from=server --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=server --chown=node:node /app/server/dist ./server/dist
COPY --from=web --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# 服务端启动时自行建表，健康检查只反映进程与数据库连接是否就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
