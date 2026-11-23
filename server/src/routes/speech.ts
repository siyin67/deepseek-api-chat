/**
 * 语音代理：识别（ASR）走 multipart 一次性转发，合成（TTS）把上游音频字节原样透传。
 * 浏览器不再持有模型 Key，也无法直接访问上游域名。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import { ApiError, currentUser, handler } from '../http.js'
import { anthropicHeaders, resolveApiKey, toUpstreamError, toolsUrl } from '../upstream.js'

export function registerSpeechRoutes(
  app: FastifyInstance,
  { db, config }: { db: Database; config: AppConfig },
): void {
  /** 语音识别：multipart 字段 file → 上游 /v1/tools/asr */
  app.post(
    '/api/speech/transcribe',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      if (!request.isMultipart()) throw new ApiError(400, 'invalid_body', '需要 multipart 请求')
      let data: Buffer | null = null
      let filename = 'audio.webm'
      let mimetype = 'audio/webm'
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        if (part.fieldname !== 'file') {
          await part.toBuffer()
          continue
        }
        data = await part.toBuffer()
        filename = part.filename || 'audio.webm'
        mimetype = part.mimetype || 'audio/webm'
      }
      if (!data || data.length === 0) throw new ApiError(400, 'invalid_body', '缺少音频数据')

      const { apiKey } = await resolveApiKey(db, config, user.id)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)], { type: mimetype }), filename)
      let upstream: Response
      try {
        upstream = await fetch(toolsUrl(config, '/asr'), {
          method: 'POST',
          headers: anthropicHeaders(apiKey),
          body: form,
          signal: AbortSignal.timeout(120_000),
        })
      } catch {
        throw new ApiError(502, 'upstream_unreachable', '无法连接模型服务')
      }
      if (!upstream.ok) throw await toUpstreamError(upstream)
      reply.header('cache-control', 'no-store')
      return (await upstream.json()) as unknown
    }),
  )

  /**
   * 语音合成：JSON 原样转上游，音频字节流式回传。
   * 客户端拿到的是 PCM 分片，直接喂给 Web Audio，不做整体缓冲。
   */
  app.post(
    '/api/speech/synthesize',
    handler(async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await currentUser(request, db)
      const body = (request.body ?? {}) as Record<string, unknown>
      const text = typeof body.text === 'string' ? body.text : ''
      if (!text.trim()) throw new ApiError(400, 'invalid_body', 'text 不能为空')
      const { apiKey } = await resolveApiKey(db, config, user.id)
      let upstream: Response
      try {
        upstream = await fetch(toolsUrl(config, '/tts'), {
          method: 'POST',
          headers: { ...anthropicHeaders(apiKey), 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            voice_id: typeof body.voice_id === 'string' ? body.voice_id : 'stella',
            format: typeof body.format === 'string' ? body.format : 'pcm',
            filter_markdown: body.filter_markdown !== false,
          }),
          signal: AbortSignal.timeout(120_000),
        })
      } catch {
        throw new ApiError(502, 'upstream_unreachable', '无法连接模型服务')
      }
      if (!upstream.ok) throw await toUpstreamError(upstream)

      const contentType = upstream.headers.get('content-type') ?? 'audio/L16'
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      try {
        const stream = upstream.body
        if (stream) {
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
            if (reply.raw.writableEnded || reply.raw.destroyed) break
            reply.raw.write(chunk)
          }
        }
      } catch {
        request.log.warn('tts stream broke')
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end()
      }
    }),
  )
}
