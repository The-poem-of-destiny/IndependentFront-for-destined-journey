import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, relative, isAbsolute } from 'path';
import fs from 'fs';
import { buildHonoApp, isBffRoute, isOpaqueSandboxOrigin, OPAQUE_ORIGIN_ERROR } from './server/app';
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
        //
        // 🔴 前缀清单由 server/app.ts 的 `isBffRoute` 派生，**不在这里再抄一份**：
        //    此前 dev 与 preview 各有一份逐字重复的五前缀白名单，加新路由忘改
        //    其中一处的症状是「代码看着完全正确，请求 404」。
        //    `/api/worldbooks`、`/api/defaults` 两条写回也已搬进 hono（server/routes/content.ts），
        //    contentDir 从这里注入，dev 与 preview 拿到同一份行为。
        const honoListener = getRequestListener(buildHonoApp({ contentDir: poemContentDir }).fetch);
        server.middlewares.use((req, res, next) => {
          if (isBffRoute(req.url || '')) return honoListener(req, res);
          next();
        });

        // 🔴 条件 overlay（D14）：只有设置 POEM_CONTENT_DIR 才注册 /data 读中间件。
        // 未设置时 /data/* 由 public/data 静态服务（占位）。
        // 写入口（PUT/POST）已不在这里，见下方那条 📌 说明。
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
            // 🔒 SEC-03：canonical containment —— 与 20 行之下的写路径同一道守卫。
            // 此前这里只判 `!relPath.includes('..')`，两处都不够：
            //   ① WHATWG URL 解析器早把点段规范化掉了，那个 '..' 判断是死代码；
            //   ② Windows 绝对路径（/C:/Windows/win.ini）不含 '..'，经 resolve 会**吞掉**
            //      dataDir 逃到任意位置，existsSync 为真 → dev server 200 回任意本地文件。
            // dataDir 指向的正是私有内容仓，所以这条在开发机上不是「一般文件读取」。
            const rel = relative(dataDir, filePath);
            if (rel.startsWith('..') || isAbsolute(rel)) return next();
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              res.statusCode = 200;
              // 🔴 二进制必须按 Buffer 原样回（地图 v1 真机走查逮到：provinces.png 经
              // utf-8 往返后首字节 0x89 变成 U+FFFD 三字节，图不可解码且体积膨胀）。
              // 文本按 Buffer 回同样无损，所以统一走字节，不再假设「/data 全是 JSON」。
              const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
              const mime: Record<string, string> = {
                json: 'application/json',
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                webp: 'image/webp',
                txt: 'text/plain; charset=utf-8',
                md: 'text/markdown; charset=utf-8',
              };
              res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.end(fs.readFileSync(filePath));
              return;
            }
            next();
          });
        }

        // 📌 写入口（PUT/POST /api/worldbooks/:id 与 /api/defaults/:name）已迁进 hono
        //    （server/routes/content.ts），不再是这里的 inline 中间件 —— 那份实现只活在
        //    configureServer 分支里，`vite preview` 下必然 404。D14「只在 overlay 启用时
        //    才可写」的语义不变：contentDir 为 null 时那两条路由回 501，占位内容仍碰不到。

        // 🔒 P1-03: 旧的 /api/proxy 任意 URL 透传中间件已移除（BFF 重构后死代码 + SSRF 攻击面）。
        // agent-client / memory-store / api-tools 现走同源 /api/chat|embeddings|models（server/routes/proxy.ts），
        // 那里是受控的 X-Target-Base-URL 透传，不再有接受任意 URL 的开放代理。
      },
      configurePreviewServer(server) {
        // 🔴 D14 v1.2 补：vite preview 下 /api/* 必须通（验收 #2）。buildHonoApp 的
        // BFF 路由挂在 hono listener 上，preview 走同一个 getRequestListener。
        //
        // 🔴 这里与 configureServer 分支**必须是同一份判据与同一份 options** ——
        //    前缀清单走 `isBffRoute`，contentDir 同样注入，于是 dev 与 preview
        //    再也不会出现「dev 通、preview 404」的分叉（`/api/worldbooks`、
        //    `/api/defaults` 此前就是这么少了半边的）。
        const honoListener = getRequestListener(buildHonoApp({ contentDir: poemContentDir }).fetch);
        server.middlewares.use((req, res, next) => {
          if (isBffRoute(req.url || '')) return honoListener(req, res);
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
