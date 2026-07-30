import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import fs from 'fs'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'file-write-api',
      configureServer(server) {
        const dataDir = resolve(__dirname, 'data')

        server.middlewares.use('/data', (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next()
          const url = new URL(req.url || '', 'http://localhost')
          const relPath = url.pathname.replace(/^\/data\//, '')
          const filePath = resolve(dataDir, relPath)
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && !relPath.includes('..')) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(fs.readFileSync(filePath, 'utf-8'))
            return
          }
          next()
        })

        server.middlewares.use('/api/worldbooks', (req, res, next) => {
          if (req.method !== 'PUT' && req.method !== 'POST') return next()
          const id = (req.url || '').replace(/^\//, '').replace(/\.json$/, '')
          if (!id || id.includes('..')) return next()
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const worldbooksDir = resolve(dataDir, 'worldbooks')
              const filePath = resolve(worldbooksDir, `${id}.json`)
              // 对齐 /api/defaults 行为：允许新建文件
              if (!fs.existsSync(worldbooksDir)) {
                fs.mkdirSync(worldbooksDir, { recursive: true })
              }
              fs.writeFileSync(filePath, body, 'utf-8')
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (e: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
        })

        server.middlewares.use('/api/defaults', (req, res, next) => {
          if (req.method !== 'PUT' && req.method !== 'POST') return next()
          const rawUrl = (req.url || '').replace(/^\//, '').replace(/\.json$/, '')
          const fileName = rawUrl || 'agent-config'
          if (fileName.includes('..')) return next()
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const defaultsDir = resolve(dataDir, 'defaults')
              if (!fs.existsSync(defaultsDir)) fs.mkdirSync(defaultsDir, { recursive: true })
              const filePath = resolve(defaultsDir, `${fileName}.json`)
              fs.writeFileSync(filePath, body, 'utf-8')
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (e: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
        })

        // CORS proxy: /api/proxy/<encoded_url> -> forward to external API
        // 支持流式响应（SSE）：用 r.body 管道转发，避免缓冲整个响应
        server.middlewares.use('/api/proxy', (req, res) => {
          const targetUrl = (req.url || '').replace(/^\//, '')
          if (!targetUrl) { res.statusCode = 400; res.end('missing url'); return }
          const decoded = decodeURIComponent(targetUrl)
          if (!/^https?:\/\//.test(decoded)) { res.statusCode = 403; res.end('invalid url'); return }
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(req.headers)) {
            if (k !== 'host' && k !== 'origin' && k !== 'referer' && typeof v === 'string') headers[k] = v as string
          }
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            fetch(decoded, {
              method: (req.method || 'GET') as any,
              headers,
              body: chunks.length > 0 ? Buffer.concat(chunks) as any : undefined,
            })
              .then(async (r) => {
                res.statusCode = r.status || 200
                // 转发响应头，但移除可能破坏分块的 transfer-encoding/content-length
                for (const [k, v] of r.headers) {
                  if (k.toLowerCase() === 'transfer-encoding' || k.toLowerCase() === 'content-length') continue
                  try { res.setHeader(k, v) } catch {}
                }
                // 流式响应：直接管道转发 body，不缓冲
                if (r.body) {
                  const reader = (r.body as any).getReader?.()
                  if (reader) {
                    // Web ReadableStream (Node 18+ undici)
                    try {
                      while (true) {
                        const { done, value } = await reader.read()
                        if (done) break
                        res.write(value)
                      }
                    } catch (e: any) {
                      // 客户端提前断开等
                    } finally {
                      try { reader.releaseLock?.() } catch {}
                      res.end()
                    }
                  } else {
                    // Node stream：pipe
                    ;(r.body as any).pipe(res)
                  }
                } else {
                  res.end()
                }
              })
              .catch((e: any) => { res.statusCode = 502; res.end(JSON.stringify({ error: e.message })) })
          })
        })
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@engine': resolve(__dirname, 'src/sillytavern'),
      '@ui': resolve(__dirname, 'src/ui'),
    },
  },
  server: {
    port: 5173,
    open: true,
    watch: {
      ignored: ['**/data/worldbooks/**'],
    },
  },
  build: {
    outDir: 'dist-ui',
    sourcemap: true,
  },
})
