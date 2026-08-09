import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, relative, isAbsolute } from 'path';
import fs from 'fs';
import { buildHonoApp, isOpaqueSandboxOrigin, OPAQUE_ORIGIN_ERROR } from './server/app';
import { getRequestListener } from '@hono/node-server';

// 引擎版本 —— `package.json` 是唯一真源（D26/D40）。
// 内容包的 `minEngineVersion` 拿它做门（`content-source.ts` 的 checkEngineVersion）。
// 🔴 vitest 与本 config 共用一份配置，所以 `define` 在测试里**同样生效**：
//    「版本门在 vitest 下恒 skipped」的旧契约到此为止，测试用例要显式改写全局值。
const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

// 内容-引擎分离波 4 / D14+D15：真实内容 overlay 目录。
// 设置 POEM_CONTENT_DIR 时，dev server 从该目录服务 /data/*（读 + PUT 写回），
// 否则 /data/* 由 public/data 静态服务（占位内容）。UI 侧「保存为默认」按钮
// 按 __POEM_CONTENT_DIR__（编译期布尔）隐藏 —— 🔴 不许用 HTTP 探测（SPA fallback
// 会让探测失败开，见 D14）。
const poemContentDir = process.env.POEM_CONTENT_DIR ? resolve(process.env.POEM_CONTENT_DIR) : null;

export default defineConfig({
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
    __POEM_CONTENT_DIR__: JSON.stringify(poemContentDir !== null),
  },
  plugins: [
    vue(),
    {
      name: 'file-write-api',
      configureServer(server) {
        // 🔴 中间件注册次序是承重的（D14）：configureServer 注册的中间件先于 Vite 的
        // publicDir 静态处理执行 —— overlay 必然赢。POEM_CONTENT_DIR 未设置时
        // 不注册任何 /data 中间件，占位内容由 public/data 原生静态服务。
        const dataDir = poemContentDir ?? resolve(__dirname, 'data');

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
            u.startsWith('/api/embeddings') ||
            u.startsWith('/api/image')
          ) {
            return honoListener(req, res);
          }
          next();
        });

        // 🔴 条件 overlay（D14）：只有设置 POEM_CONTENT_DIR 才注册 /data 读中间件
        // 与 PUT/POST 写入口（写回 overlay 目录）。未设置时：
        //   - /data/* 由 public/data 静态服务（占位）
        //   - 写入口不注册（占位内容不可被「保存为默认」污染）
        if (poemContentDir !== null) {
          server.middlewares.use('/data', (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const url = new URL(req.url || '', 'http://localhost');
            // 🔴 Vite 中间件挂在 '/data' 前缀时，req.url 已经剥掉前缀
            // （实测：/data/worldbooks/x.json → req.url = /worldbooks/x.json）。
            // 不能再用 replace(/^\/data\//) —— 剥不存在的前缀会留下开头的 /，
            // resolve(dataDir, '/worldbooks/x') 因绝对路径直接丢掉 dataDir。
            const relPath = url.pathname.replace(/^\//, '');
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
        }

        // 写入口只在 overlay 启用时注册（D14）：写回 overlay 目录，不碰占位内容。
        if (poemContentDir !== null)
          server.middlewares.use('/api/worldbooks', (req, res, next) => {
            if (req.method !== 'PUT' && req.method !== 'POST') return next();
            const id = (req.url || '').replace(/^\//, '').replace(/\.json$/, '');
            if (!id || id.includes('..')) return next();
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => {
              // 🔴 攒 Buffer 最后统一 toString（2026-08-08 真机）：HTTP 把请求体拆成
              //    多个 chunk 时，多字节中文可能恰被切成两半——每块各自 toString() 会
              //    在切分处产生 U+FFFD 替换字符（"展示"曾被切成"展[替换符][替换符]示"、
              //    顿号丢失），就是 chunk 边界切碎了 UTF-8。
              chunks.push(chunk);
            });
            req.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
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

        if (poemContentDir !== null)
          server.middlewares.use('/api/defaults', (req, res, next) => {
            if (req.method !== 'PUT' && req.method !== 'POST') return next();
            const rawUrl = (req.url || '').replace(/^\//, '').replace(/\.json$/, '');
            const fileName = rawUrl || 'agent-config';
            if (fileName.includes('..')) return next();
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => {
              // 🔴 攒 Buffer 最后统一 toString（2026-08-08 真机）：同 /api/worldbooks，
              //    chunk 边界切碎多字节中文时每块各自 toString() 会产 U+FFFD。
              chunks.push(chunk);
            });
            req.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
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
      configurePreviewServer(server) {
        // 🔴 D14 v1.2 补：vite preview 下 /api/* 必须通（验收 #2）。buildHonoApp 的
        // BFF 路由挂在 hono listener 上，preview 走同一个 getRequestListener。
        const honoListener = getRequestListener(buildHonoApp().fetch);
        server.middlewares.use((req, res, next) => {
          const u = req.url || '';
          if (
            u.startsWith('/api/chat') ||
            u.startsWith('/api/status') ||
            u.startsWith('/api/models') ||
            u.startsWith('/api/embeddings') ||
            u.startsWith('/api/image')
          ) {
            return honoListener(req, res);
          }
          next();
        });
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
      // 内容-引擎分离波 4 / D14：真实内容在 overlay 目录（POEM_CONTENT_DIR），
      // 由服务端中间件按需读盘，不参与 Vite 热更新监视（改真实内容不触发前端重载）。
      ignored: poemContentDir !== null ? [`${poemContentDir}/**`] : [],
    },
  },
  build: {
    outDir: 'dist-ui',
    sourcemap: true,
  },
});
