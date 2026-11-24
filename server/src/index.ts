/**
 * 服务入口：Fastify 组装（同源部署：静态资源 + /api 由同一进程提供，无需 CORS）。
 * 启动前校验配置、连库建表；退出时优雅关闭连接池。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { ensureAppSettings } from './appSettings.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerFileRoutes } from './routes/files.js'
import { registerModelKeyRoutes } from './routes/modelKey.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerSpeechRoutes } from './routes/speech.js'
import { registerTurnRoutes } from './routes/turns.js'

/** 应用根目录：容器内 /app，源码运行时为仓库根。 */
const appRoot = path.resolve(import.meta.dirname, '../..')

async function main(): Promise<void> {
  const config = loadConfig()
  const db = await openDatabase(config.databaseUrl)
  // 站点设置（是否开放注册 / 注册口令）首次启动写入数据库，之后以数据库为准
  const { settings, generatedCode } = await ensureAppSettings(db, config)

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    // 会话批量写入的 body 可能较大（导入历史），给到 16MB
    bodyLimit: 16 * 1024 * 1024,
    disableRequestLogging: config.nodeEnv === 'production',
  })

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: 1,
      fields: 4,
    },
  })

  app.get('/api/health', async () => ({ ok: true, now: Date.now() }))

  registerAuthRoutes(app, { db, config, settings })
  registerAdminRoutes(app, { db, settings })
  registerModelKeyRoutes(app, { db, config })
  registerSessionRoutes(app, { db, config })
  registerTurnRoutes(app, { db, config })
  registerFileRoutes(app, { db, config })
  registerSpeechRoutes(app, { db, config })

  // 前端产物：存在就同源托管，不存在（纯 API 部署）时直接 404
  const webDistDir = path.resolve(appRoot, config.webDistDir)
  if (existsSync(path.join(webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      wildcard: false,
      maxAge: '1h',
      index: ['index.html'],
      // 入口 HTML 必须每次回源，否则发版后会拿着旧的资源哈希请求 404
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) {
          response.setHeader('cache-control', 'no-cache')
        }
      },
    })
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        void reply.status(404).send({ error: { code: 'not_found', message: '资源不存在' } })
        return
      }
      // SPA 路由回退
      void reply.type('text/html').sendFile('index.html')
    })
  } else {
    app.log.warn({ webDistDir }, '前端产物不存在，仅提供 API')
  }

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'unhandled error')
    void reply.status(status).send({
      error: { code: status >= 500 ? 'internal' : 'bad_request', message: error.message },
    })
  })

  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    await app.close().catch(() => undefined)
    await db.close().catch(() => undefined)
    process.exit(0)
  }
  process.once('SIGTERM', () => void close('SIGTERM'))
  process.once('SIGINT', () => void close('SIGINT'))

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info({ port: config.port, webDistDir }, 'server ready')
  if (!settings.allowRegistration) {
    app.log.info('注册已关闭（管理员可在「设置 → 管理」中开启）')
  } else if (generatedCode) {
    app.log.info({ registrationCode: settings.registrationCode }, '已生成注册口令，注册新账号需要填写')
  } else {
    app.log.info('注册已开放，注册口令见「设置 → 管理」')
  }
  // 老库升级上来时所有账号都是 role='user'，没人能进管理页；这里提示一次怎么提权
  const [counts] = await db.query<{ admins: string; users: string }>(
    `select count(*) filter (where role = 'admin') as admins, count(*) as users from users`
  )
  if (counts && Number(counts.users) > 0 && Number(counts.admins) === 0) {
    app.log.warn(
      "当前没有任何管理员账号，管理页对所有人不可见；挑一个已有账号提权：" +
        "update users set role = 'admin' where email_lower = 'you@example.com';"
    )
  }
}

main().catch((error: unknown) => {
  console.error('[server] 启动失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
