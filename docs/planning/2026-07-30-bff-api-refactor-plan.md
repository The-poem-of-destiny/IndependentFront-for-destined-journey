# BFF 同源后端 — API 请求/设置层重构方案

- **日期**: 2026-07-30
- **状态**: 待批准
- **作者**: 本喵瞄
- **关联**: PR #4（CORS 临时修复 withProxy）、`docs/reference/audio_system.md`（免手势自动播放权衡）、SillyTavern 架构

---

## 一、背景与目标

### 1.1 起因

刚合并的 PR #4 用 `withProxy()` + vite middleware 给 dev 环境打了 CORS 补丁，但本质是**临时透传代理**，存在两个根性问题：

1. **dev-only**：`withProxy` 靠 `import.meta.env.DEV` 判定，生产构建（静态托管 / file://）无 vite middleware → proxy 消失，CORS 问题原样回来；
2. **每个国外站点都要单独惦记**：当前是"出问题 → 加代理"的被动模式，没有统一接入点。

### 1.2 目标

引入一个**对标 SillyTavern 的本地同源后端（BFF）**，把"怎么把请求发出去"这件事**系统化、永久化**：

| 目标 | 达成方式 |
|---|---|
| CORS 永久消失 | 前端永远只请求同源 `/api/...`，BFF（服务器进程，无 CORS）转发给真实 provider |
| 生产可用 | 提供独立 `server.js` + `start.bat`，dev/prod **共享同一套路由代码** |
| 统一接入点 | 所有 API 调用（chat / embedding / models / test）走同源路由，告别 `withProxy(真实URL)` 散落各处 |
| 不动业务 | prompt / 编排 / 世界书 / 剧情 / 记忆 / 翻译层 **一行不改** |

### 1.3 非目标（明确隔离线）

- ❌ 不改 agent 编排（`agent-orchestrator.ts` DAG）
- ❌ 不改 prompt 模板（`agent-templates.ts` / `agent-config.json`）
- ❌ 不改翻译层 / StatePatch / 按名寻址
- ❌ 不引入 AI SDK（本轮；列为后续可选演进，见第十二章）
- ❌ 不改配置存储位置（API 配置仍存浏览器 localStorage，key 前端持有——SillyTavern 模式）

---

## 二、现状分析（基于真实代码）

### 2.1 API 调用层文件清单

| 文件 | 职责 | CORS 现状 |
|---|---|---|
| `src/sillytavern/agent-client.ts` | 核心：`chat()` / `chatStream()` / `chatWithTools()`。手搓 fetch + SSE 解析 + tool 多轮循环 + userId 缓存隔离 + 重试退避 + 超时 + 缓存命中检测（`x-ds-cache-hit` / `prompt_cache_*_tokens`） | 用 `withProxy()` |
| `src/sillytavern/api-tools.ts` | `withProxy()` + `fetchModels()` + `testConnection()` + `getFallbackModels()` | 用 `withProxy()` |
| `src/sillytavern/memory-store.ts` | `computeEmbedding()` 调 `/embeddings` | 用 `withProxy()` |
| `src/sillytavern/api-router.ts` | v3 双模型路由（primary/secondary） | 用 `withProxy()`，但**无人 import，死代码** |
| `src/ui/components/settings/SettingsPage.vue` | `testApiAndFetch()` / `fetchModelList()`，XHR 手搓（与 api-tools 重复实现） | 用 `withProxy()` |

### 2.2 配置存储

- **前端 localStorage**（`settings-store.ts`）：`apiPool: ApiEntry[]`
  ```ts
  interface ApiEntry {
    id, name, baseUrl, apiKey, maskedKey, model, models[], apiType: 'chat'|'embedding', enableThinking?
  }
  ```
- **Dexie**（`database.ts`）：`apiEndpoints: ApiEndpoint[]`（按 id），`AgentConfig.apiEndpointId` 指向
- **key 前端持有**：明文 `apiKey` 在内存（`_realKey`），存储时 `maskedKey`。这是 SillyTavern 模式（用户自己填 key），**预期行为，非缺陷**。

### 2.3 关键定制点（迁移时必须保留）

`agent-client.ts` 里这些是业务逻辑，BFF **不碰**，前端逻辑原样保留：

- `userId = fp|${saveId}|${agentId}`（DeepSeek 缓存隔离）
- `max_tokens ?? 16384` 兜底（2048 会截断 char_gen 思考链）
- `stream_options: { include_usage: true }`（流式末尾拿 usage）
- `enableThinking` → `thinking: { type: 'enabled' }` + `reasoning_effort: 'high'`
- 缓存命中：`data.cache_hit` / `usage.prompt_cache_hit_tokens` / `res.headers x-ds-cache-hit`
- SSE 解析（`\n\n` 分割 / `data: ` 前缀 / tool_call 按 index 累积 / reasoning_content）
- 重试指数退避 + AbortSignal + 超时翻译（区分超时/外部取消）

---

## 三、目标架构（对标 SillyTavern）

```
┌─────────────────────────────────────────────────────────────┐
│ 浏览器（localhost:5173 dev / localhost:8787 prod）            │
│  Vue 前端 ──同源──► /api/chat/completions  /api/embeddings    │
│                    /api/models  /api/chat/test  /api/status   │
└──────────────────────────┬──────────────────────────────────┘
                           │ 同源，浏览器永不拦截
┌──────────────────────────▼──────────────────────────────────┐
│ BFF（Node 进程，无 CORS 约束）— hono app                       │
│  - 透传请求到真实 provider                                     │
│  - 注入 CORS 头                                                │
│  - SSE 流式管道转发                                            │
└──────────────────────────┬──────────────────────────────────┘
                           │ 服务器端 fetch（无 CORS）
              ┌────────────┼────────────┬──────────────┐
              ▼            ▼            ▼            ▼
        DeepSeek    siliconflow    z.ai        Ollama ...
```

**双宿主**：同一份 hono 路由代码，挂在两个地方——

- **dev**：挂到 vite dev server 的 middleware（`server.middlewares.use`），5173 端口
- **prod**：独立 `server.js`，`@hono/node-server` 起服务，serve `dist-ui/` 静态文件 + `/api`，8787 端口

---

## 四、关键设计决策

### 4.1 透传模式 vs 托管模式 → 选**透传**

| 模式 | key 在哪 | BFF 是否管配置 | 复杂度 |
|---|---|---|---|
| **透传（选）** | 前端持有（同现状） | 否，无状态转发 | 低 |
| 托管 | BFF 管 | 是，需同步配置 | 高 |

理由：本项目是 SillyTavern 模式，key 本就在浏览器。透传模式 = BFF 只做"加 CORS 头的 fetch 转发器"，**零状态、零配置同步、最小风险**。前端改动仅限"换 URL"，业务逻辑全保留。

### 4.2 路由形态：header 传 target，废弃 encoded path

- 旧（PR #4）：`/api/proxy/<encodeURIComponent(真实URL)>` —— path 里塞编码 URL，语义丑，难扩展
- **新**：标准 REST 路径 + header 传真实 baseUrl
  ```
  POST /api/chat/completions
  X-Target-Base-URL: https://api.deepseek.com/v1
  Authorization: Bearer <key>      ← 透传给上游
  ```

好处：路径规范、provider 无关、未来套 AI SDK 只改 BFF 内部。

### 4.3 框架选型 → hono

- **轻量**（无依赖）、**Web 标准**（Request/Response/fetch）、**TS 原生**
- dev（vite middleware）/ prod（`@hono/node-server`）/ 未来 Edge **同一份代码**
- 对比 express：express 老 + 回调风格；hono 是 2024-2026 主流，和这个项目的 Web 标准品味一致

### 4.4 要不要 AI SDK → 本轮**不引入**

理由见 §1.3。AI SDK 接管需要把 `userId 缓存检测 / x-ds-cache-hit / reasoning_effort / stream_options` 全部重新映射，风险高且偏离"解决 CORS + 生产部署"的主目标。列为后续 Step 2（第十二章）。

---

## 五、BFF 路由契约

### 5.1 路由表

| Method | Path | 用途 | 上游 |
|---|---|---|---|
| POST | `/api/chat/completions` | chat（支持 stream） | `<X-Target-Base-URL>/chat/completions` |
| POST | `/api/embeddings` | 向量嵌入 | `<X-Target-Base-URL>/embeddings` |
| GET | `/api/models` | 拉取模型列表 | `<X-Target-Base-URL>/models` |
| POST | `/api/chat/test` | 连通性 ping | `<X-Target-Base-URL>/chat/completions`（max_tokens=1） |
| GET | `/api/status` | BFF 自身存活检测 | 无（本地返回） |

### 5.2 通用约定

- **请求头**：
  - `X-Target-Base-URL`：真实 provider baseUrl（必填，除 `/api/status`）
  - `Authorization`：透传给上游（`Bearer <key>` 或 Azure 的 `api-key`，由前端决定写法）
- **响应头**：BFF 统一回写 CORS 放行头（`Access-Control-Allow-Origin: *` 等），移除上游的 `transfer-encoding` / `content-length`（避免和 BFF 自身分块冲突，PR #4 已踩过）
- **OPTIONS 预检**：hono 中间件统一放行（同源下其实不会触发，但留着兜底）

### 5.3 流式（SSE）透传

`/api/chat/completions` 当 body 含 `stream:true` 时，BFF **不缓冲**，用 Web Response 直接把上游 `body`（ReadableStream）管道转发回前端。前端 `chatStream()` 的 SSE 解析逻辑**原样保留**（`\n\n` 分割 / `data:` 解析）。

骨架：
```ts
// server/routes/proxy.ts — 透传核心
async function forward(c: Context, suffix: string, init?: RequestInit) {
  const base = c.req.header('X-Target-Base-URL')?.replace(/\/+$/, '')
  if (!base) return c.json({ error: 'missing X-Target-Base-URL' }, 400)
  const auth = c.req.header('Authorization')
  const upstream = await fetch(`${base}${suffix}`, {
    method: c.req.method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...init,
    // @ts-expect-error Node undici 流式需要
    duplex: 'half',
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: stripHopHeaders(upstream.headers),
  })
}
```

---

## 六、前端改造方案（逐文件）

> 改造原则：**只换"请求打到哪"，不换"怎么解析/怎么重试/怎么 tool 循环"**。

### 6.1 `agent-client.ts`（核心，改动最小）

```diff
- import { withProxy } from './api-tools';
  // ...
- const res = await fetch(withProxy(`${this.baseUrl}/chat/completions`), {
+ const res = await fetch('/api/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
+     'X-Target-Base-URL': this.baseUrl,
      Authorization: `Bearer ${this.endpoint.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
```

- `callOnce` / `chatStream` 两处 fetch 各改 4 行（URL + 加 header）
- 删 `import { withProxy }`
- **其余全保留**：重试、超时、SSE 解析、tool 循环、userId、缓存检测、reasoning

### 6.2 `api-tools.ts`

- **删除** `withProxy()` 函数（约 23 行）
- `tryFetchModels`：`fetch('/api/models', { headers: { 'X-Target-Base-URL': baseUrl, Authorization } })`
- `testConnection`：`fetch('/api/chat/test', { ... })`（或直接复用 `/api/chat/completions` 小 body，省一条路由——见 §8 决策）
- `getFallbackModels` / `COMMON_MODELS_BY_HOST`：**保留**（远程拉取失败时的兜底，BFF 不替代）

### 6.3 `memory-store.ts`

- `computeEmbedding`：`fetch('/api/embeddings', { headers: { 'X-Target-Base-URL', Authorization }, body })`

### 6.4 `api-router.ts`

- **删除整个文件**（v3 死代码，无 import）。顺手清 `types.ts` 里 `ApiSettings` / `ApiTarget` 的孤儿引用（若有）。

### 6.5 `SettingsPage.vue`

- `testApiAndFetch` / `fetchModelList` 的 XHR：URL 改同源 `/api/...`，加 `X-Target-Base-URL` header
- **建议顺手去重**：这两个手搓 XHR 和 `api-tools.ts` 的 `testConnection` / `fetchModels` 重复实现。改成调 `api-tools.ts` 的函数，消除 SettingsPage 里的 XHR 长行（改善可读性，降重）。

---

## 七、dev/prod 双宿主实现

### 7.1 目录结构

```
项目根/
├── server/                       🆕 BFF 源码（与 vite 同级）
│   ├── app.ts                    hono app 定义（路由注册 + CORS 中间件）
│   ├── routes/
│   │   ├── proxy.ts              透传核心（forward() + stripHopHeaders）
│   │   ├── chat.ts               /api/chat/completions + /api/chat/test
│   │   ├── embeddings.ts         /api/embeddings
│   │   ├── models.ts             /api/models
│   │   └── status.ts             /api/status
│   └── cors.ts                   CORS 中间件
├── server-main.ts                🆕 生产入口（serveStatic dist-ui + hono app）
├── vite.config.ts                改：dev 时把 hono app 挂到 middleware
├── start.bat / start.sh          🆕 生产启动（node dist-server/server-main.js）
└── ...
```

### 7.2 dev：vite middleware 挂载

`vite.config.ts` 里用 `@hono/node-server` 的 `getRequestListener` 把 hono app 适配成 node listener，仅 `/api` 前缀交给 BFF，其余 `next()` 给 vite 处理 Vue HMR：

```ts
import { buildHonoApp } from './server/app'
import { getRequestListener } from '@hono/node-server'

// 在现有 configureServer(server) 里：
const listener = getRequestListener(buildHonoApp().fetch)
server.middlewares.use((req, res, next) => {
  if (req.url?.startsWith('/api')) return listener(req, res)
  next()
})
// 现有 /api/proxy middleware 整块删除（被 hono 路由取代）
```

### 7.3 prod：独立 server

`server-main.ts`：
```ts
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { buildHonoApp } from './server/app'

const app = buildHonoApp()
app.use('/*', serveStatic({ root: './dist-ui' }))   // 前端静态
serve({ fetch: app.fetch, port: 8787 }, (info) => {
  console.log(`命定之诗运行中: http://localhost:${info.port}`)
})
```

构建产物：`tsc -p tsconfig.server.json → dist-server/`，`vite build → dist-ui/`（已存在）。

`start.bat`（仿 SillyTavern）：
```bat
@echo off
if not exist node_modules (call npm install)
node dist-server/server-main.js
pause
```

### 7.4 新增依赖

```json
{
  "dependencies": {
    "hono": "^4.x",
    "@hono/node-server": "^1.x"
  }
}
```

均为轻量、无传递依赖、纯 TS。

---

## 八、迁移阶段（分步，每步可验证）

### Phase A — BFF 骨架 + dev 挂载 + chat 一条路由打通
- 建 `server/` 目录、hono app、CORS 中间件、`/api/chat/completions` + `/api/status`
- vite.config.ts 挂载 hono app（**保留**旧 `/api/proxy` middleware——`withProxy` 仍在 api-tools/memory-store/SettingsPage 用，Phase D 统一删，避免其他路径崩）
- **前端只改 `agent-client.ts`** 切同源
- 验证：dev 下游戏正常对话 + 流式（story 正文逐字出）
- **此时 withProxy 仍在 api-tools/memory-store/SettingsPage，不急删，保证其他路径不崩**

### Phase B — 全路由接入
- 加 `/api/embeddings` `/api/models` `/api/chat/test`
- 改 `memory-store.ts` / `api-tools.ts` / `SettingsPage.vue` 切同源
- 顺手 SettingsPage 去重（§6.5）
- 验证：设置页"获取模型"+"测试连接"通；记忆召回 embedding 通

### Phase C — 生产 server + start.bat
- 建 `server-main.ts` + `tsconfig.server.json` + `start.bat`/`start.sh`
- `npm run build` 增加 server 构建步骤
- 验证：`npm run build && start.bat`，浏览器开 8787，完整跑一轮游戏
- 更新 `package.json` scripts（`build` 串 ui+server，`start` 加生产启动）

### Phase D — 收尾清理
- 删 `withProxy()` 函数、删 `api-router.ts`（死代码）、清 types 孤儿
- 更新文档：`CLAUDE.md` 架构图 + Phase 表、本文档标 ✅
- 全量测试绿

每阶段独立提交，可单独回滚。Phase A 完成即可解决 CORS 主诉，B/C/D 是完善。

---

## 九、测试策略

- **BFF 路由单测**（`server/routes/*.test.ts`）：用 mock fetch 验证转发目标 URL 正确、header 透传、SSE 流不缓冲、stripHopHeaders 移除 transfer-encoding
- **前端 adapter 测试**：`agent-client.test.ts` / `memory-store.test.ts` 改断言：fetch URL 改成断言同源 `/api/...` + `X-Target-Base-URL` header（现有 mock fetch 框架直接复用）
- **dev 手测**：每阶段按 §8 验证项
- **prod 手测**：Phase C 完整一轮游戏

---

## 十、风险与取舍

| 风险 | 缓解 |
|---|---|
| 用户需装 Node（生产） | 同 SillyTavern 门槛，`start.bat` 自动 `npm install`；README 写清 |
| dev/prod 行为不一致 | 双宿主共享同一 hono app，路由代码单一真源 |
| SSE 流式在 Node undici 需 `duplex:'half'` | PR #4 已验证流式管道可行，hono Web Response 原生支持 |
| 前端持有 key 被质疑 | 本项目本就是 SillyTavern 模式，预期行为；托管模式留待未来 |
| 与 PR #4 冲突 | 不冲突：Phase A 删 `/api/proxy` middleware，`withProxy` Phase D 删，平滑过渡 |

---

## 十一、不在范围内（重申隔离线）

prompt 模板 / agent 编排 / 世界书 / 剧情 / 记忆 / 翻译层 / StatePatch / 按名寻址 / `agent-config.json` —— **本轮一行不动**。本轮只换"请求怎么发出去"。

---

## 十二、未来演进（Step 2，可选，独立进行）

BFF 路由接口稳定后，**内部**把透传换成 AI SDK：

- `streamText({ model, messages, tools, maxSteps })` 接管流式 + tool 多轮（替代前端手搓 `chatWithTools` 循环）
- `generateObject` 替代手搓 XML/JSON 解析兜底
- 多 provider 用 `@ai-sdk/openai-compatible` 统一（DeepSeek/siliconflow/z.ai 全覆盖）

Step 2 只动 BFF 内部，**前端 `/api/...` 契约不变**，可独立验证、独立回滚。届时再单独立 plan。

---

## 已定决策（2026-07-30）

1. ✅ **端口**：现阶段跳过 prod，dev/prod 都先用 5173（vite dev）。Phase C（独立 prod server）推迟到分发时再做。
2. ✅ **`/api/chat/test`**：独立路由（5 条路由互不重叠，语义清晰）。
3. ✅ **SettingsPage 去重**（§6.5）：纳入本轮（Phase B）。
4. ✅ **`start.bat` 语言**：随 Phase C 再定。
