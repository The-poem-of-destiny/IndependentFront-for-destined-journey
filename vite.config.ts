import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, relative, isAbsolute } from 'path';
import fs from 'fs';
import { buildHonoApp, isOpaqueSandboxOrigin, OPAQUE_ORIGIN_ERROR } from './server/app';
import { getRequestListener } from '@hono/node-server';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'file-write-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const u = req.url || '';
          if (u.startsWith('/api/') && isOpaqueSandboxOrigin(req.headers.origin)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: OPAQUE_ORIGIN_ERROR }));
            return;
          }
          next();
        });

        // === BFF (hono)：同源 API 路由，dev 挂载（Phase A）===
        // prod 走独立 server.js，见方案 §7
        const honoListener = getRequestListener(buildHonoApp().fetch);
        server.middlewares.use((req, res, next) => {
          const u = req.url || '';
          // hono BFF 管辖的路由前缀；其余 /api/*（proxy/worldbooks/defaults）走下方 inline middleware
          if (
            u.startsWith('/api/chat') ||
            u.startsWith('/api/status') ||
            u.startsWith('/api/models') ||
            u.startsWith('/api/embeddings')
          ) {
            return honoListener(req, res);
          }
          next();
        });

        const dataDir = resolve(__dirname, 'data');

        server.middlewares.use('/data', (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          const url = new URL(req.url || '', 'http://localhost');
          const relPath = url.pathname.replace(/^\/data\//, '');
          const filePath = resolve(dataDir, relPath);
          if (
            fs.existsSync(filePath) &&
            fs.statSync(filePath).isFile() &&
            !relPath.includes('..')
          ) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(fs.readFileSync(filePath, 'utf-8'));
            return;
          }
          next();
        });

        server.middlewares.use('/api/worldbooks', (req, res, next) => {
          if (req.method !== 'PUT' && req.method !== 'POST') return next();
          const id = (req.url || '').replace(/^\//, '').replace(/\.json$/, '');
          if (!id || id.includes('..')) return next();
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const worldbooksDir = resolve(dataDir, 'worldbooks');
              const filePath = resolve(worldbooksDir, `${id}.json`);
              // 🔒 P1-03 越界写防御：canonical containment —— 仅拒 '..' 不够，
              // Windows 绝对路径（如 C:\evil）经 resolve 会吞掉 worldbooksDir 逃逸到任意位置。
              const rel = relative(worldbooksDir, filePath);
              if (rel.startsWith('..') || isAbsolute(rel)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'invalid path' }));
                return;
              }
              // 对齐 /api/defaults 行为：允许新建文件
              if (!fs.existsSync(worldbooksDir)) {
                fs.mkdirSync(worldbooksDir, { recursive: true });
              }
              fs.writeFileSync(filePath, body, 'utf-8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });

        server.middlewares.use('/api/defaults', (req, res, next) => {
          if (req.method !== 'PUT' && req.method !== 'POST') return next();
          const rawUrl = (req.url || '').replace(/^\//, '').replace(/\.json$/, '');
          const fileName = rawUrl || 'agent-config';
          if (fileName.includes('..')) return next();
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const defaultsDir = resolve(dataDir, 'defaults');
              if (!fs.existsSync(defaultsDir)) fs.mkdirSync(defaultsDir, { recursive: true });
              const filePath = resolve(defaultsDir, `${fileName}.json`);
              // 🔒 P1-03 越界写防御（同 /api/worldbooks）：Windows 绝对路径会吞掉 defaultsDir。
              const rel = relative(defaultsDir, filePath);
              if (rel.startsWith('..') || isAbsolute(rel)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'invalid path' }));
                return;
              }
              fs.writeFileSync(filePath, body, 'utf-8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });

        // 🔒 P1-03: 旧的 /api/proxy 任意 URL 透传中间件已移除（BFF 重构后死代码 + SSRF 攻击面）。
        // agent-client / memory-store / api-tools 现走同源 /api/chat|embeddings|models（server/routes/proxy.ts），
        // 那里是受控的 X-Target-Base-URL 透传，不再有接受任意 URL 的开放代理。
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
  optimizeDeps: {
    // 🔴 quickjs-emscripten 必须排除出依赖预打包：它的 wasm 是独立文件、
    // 靠 import.meta.url 相对定位。预打包会把 JS 挪进 .vite/deps/，相对路径断掉后
    // 取 wasm 的请求落到 SPA fallback（拿回 index.html，魔数 3c 21 44 4f = "<!DO"），
    // EJS 隔离后端装载即失败 → fail-closed（真机 2026-08-02 实测）。
    exclude: ['quickjs-emscripten'],
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
});
