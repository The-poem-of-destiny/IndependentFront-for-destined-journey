# 创意工坊社交面设计 v1（Phase 3：Discord 登录 + 点赞 + 订阅）

> 决策编号接续 `2026-07-31-creative-workshop-compat-design.md`（D1–D17），本文档为 **D18–D25**。
> 上游后端源码已取得（github.com/AkabaneSaki/myrepo，worker 代码在 `cloudflare/src/`），
> 本文所有契约事实**直接读自源码**，不再是二手引用。文中 `后端 xxx.ts:NN` 均指该仓库
> `cloudflare/src/` 下的文件。

## 0. 判决：直连 REST 成立，iframe 桥（附录 B 方案）彻底不需要

Phase 1 设计时最大的未知数是会话载体。源码给出定论：

- **全程零 Cookie**。`src` 目录 grep `setCookie` / `Set-Cookie` / `Allow-Credentials` 均 0 命中。
- 会话 = **Bearer JWT**（HS256，7 天有效期，无刷新端点，无黑名单；后端 `utils/jwt.ts:90-116`）。
  读取端同时接受 `Bearer <token>` 与裸 token（`utils/jwt.ts:166-175`）。
- CORS 全局 `Access-Control-Allow-Origin: *`，且 `Allow-Headers: Content-Type, Authorization`
  （后端 `index.ts:61-63`）；任意 OPTIONS 预检直接 204 短路（`index.ts:78-83`）。

因此任意 origin 的 SPA 带 `Authorization` header 直接调用即可认证。**唯一禁忌**：
永远不要设置 `credentials: 'include'`——通配 ACAO 且无 `Allow-Credentials`，浏览器会整个拒绝请求。

## 1. 上游契约附录（源码验证，实施与测试以此为准）

### 1.1 登录三段式

| 步骤 | 端点                                    | 行为                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 起飞 | `GET /api/auth/login`                   | 返回 `{url, state}`。`state = crypto.randomUUID()`，KV 存 300s（后端 `endpoints/auth.ts:122-138`）。`url` 是 Discord OAuth 授权页，scope `identify guilds`，redirect_uri **恒为 worker 自己的 origin**（`utils/auth.ts:4-23,46-56`）——我们的 SPA 不出现在 OAuth 链路里                                                                                       |
| 回调 | `GET /api/auth/callback`（落在 worker） | **服务器成员门槛**：用户必须在 `ALLOWED_GUILD_IDS` 内，否则失败（`utils/auth.ts:232-238`）。成功则写 KV `oauth_result_<state>`（300s），并返回一页 HTML 向 opener `postMessage` `{type:'oauth-success', source:'creative-workshop-auth-callback', state, token, user}`——先发给记录的 origin，**随后广播给 `'*'`**（`endpoints/auth.ts:59-68`），800ms 后自关 |
| 收割 | `GET /api/auth/poll?key=<state>`        | 未就绪 `{ready:false}`；就绪后**单次消费**（KV 即删，`endpoints/auth.ts:164`），返回 `{ready:true, success:true, token, user}` 或 `{ready:true, success:false, message}`                                                                                                                                                                                     |

- `POST /api/auth/logout` 是**纯 no-op**（`endpoints/auth.ts:383-399`），登出即本地丢 token。
- `GET /api/auth/me` **恒 200**：token 缺失/过期/非法一律 `{user: null}` 而非 401
  （`endpoints/auth.ts:337-376`）。且响应字段全部来自 JWT payload 本身——见优化 O1。
- JWT payload：`{userId, username, globalName, avatar, isAdmin, isSuperAdmin, iat, exp}`。

### 1.2 点赞 / 订阅

- `POST /api/projects/:projectId/like` → `{liked: boolean, count: number}`
- `POST /api/projects/:projectId/subscribe` → `{subscribed: boolean, count: number}`
- **无请求体**；需要 `Authorization`，否则 `401 {"error":"Unauthorized"}`（后端 `endpoints/projects.ts:651-654,685-688`）。
- 🔴 **翻转语义，非幂等**：有行删、无行插，然后重数（`utils/db.ts:802-851`）。
  超时后重试可能把刚点的赞又取消——见 D23。
- 服务端**无任何限流/防抖**（grep rate/limit 仅命中客户端文案串）。

### 1.3 缓存与个性化污染（🔴 最重要的坑）

- `GET /api/projects`（列表）响应带 `Cache-Control: public, s-maxage=120`，
  详情带 `s-maxage=300`（后端 `index.ts:90-93`），**却没有 `Vary: Authorization`**——
  而 `userLiked`/`userSubscribed` 恰恰按调用者 JWT 填充（`utils/db.ts:1010-1024`）。
  任何 HTTP 层缓存都可能把**别人的/过期的**点赞旗标喂给已登录用户。
- 载荷文件 `GET /api/files/*` 带 `public, max-age=3600, s-maxage=86400`；
  `downloadsCount` 只在拉 `project-<id>.json` 时 +1 且常被边缘缓存挡住（`index.ts:286-293`）
  ——计数仅供展示，不做任何逻辑依赖。
- 异常兜底路径会硬编码 `userLiked:false`（`endpoints/projects.ts:175-176`）——
  `false` 不可作为权威负证据，一切以 toggle 响应为准。

### 1.4 错误形状（前端解析要兜住两种）

- 手写路由：`{"error": "<message>"}`（401 `Unauthorized` / 404 `Project not found` / …）
- chanfana 框架校验失败（非法 sort 等）：`{success:false, errors:[...]}` 风格 400。

## 2. 决策 D18–D25

| #       | 决策                                                                                                                | 理由与边界                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D18** | **直连 REST + Bearer JWT**；附录 B iframe 桥永久搁置                                                                | 源码判决（§0）。`credentials: 'include'` 全域禁止。上游改契约时受影响面仍钉死在 workshop-client 一个文件                                                                                                                                                                                                                                                                                   |
| **D19** | **登录 = 弹窗 + postMessage 快路径 + 轮询兜底**                                                                     | 弹窗开 `login.url`；监听 `message`，**双重验证** `data.source === 'creative-workshop-auth-callback'` 且 `data.state === 本次 state`（state 是只有我们和 worker 知道的 UUID，攻击者无从伪造）命中即收 token、停轮询；同时起 2s 间隔轮询（参考实现 1s，我们放宽一半——见 O3）、60s 超时。弹窗被拦（`window.open` 返 null）→ 直接报「请允许弹窗」。轮询是单次消费，快路径命中后**不再**打 poll |
| **D20** | **用户信息从 JWT 本地解码，`/api/auth/me` 不作为常规调用**；token + 快照存 localStorage                             | `/me` 字段本来就来自 JWT payload（§1.1），本地 base64url 解码等价且省请求；`exp` 本地判过期（启动时过期即静默登出）。localStorage 键 `workshop-auth`，存 `{token}` 即可（user 每次解码）。XSS 风险评估：本应用无第三方脚本，token 权限面仅限工坊社交动作，可接受；绝不放 URL、绝不进 Dexie/FullBackup                                                                                      |
| **D21** | **`WorkshopFetchInit` 契约修订**：由「只带 signal」扩为可带 `headers` 与 `cache`                                    | 这是对该接口注释里「别长出第二套请求配置」禁令的**显式修订**，修订理由：auth header 属于传输层关切，恰恰应该收在唯一网络口里，而不是让调用方绕过 client 自己拼 fetch。token 经 `setWorkshopAuthTokenProvider(() => string \| null)` 注入（client 不依赖 Pinia），由 client 统一附着                                                                                                        |
| **D22** | **社交数据 = 纯内存展示层，D13 存储禁令不动**                                                                       | 新类型 `WorkshopSocialMeta {likesCount, subscribesCount, downloadsCount, userLiked, userSubscribed}`，由 `parseSocialMeta()`（workshop-manifest 纯函数，缺字段回 0/false）从**既有** list/detail 响应顺带解析——**零新增读请求**。不进 `WorkshopProjectMeta`、不落 Dexie、不进 FullBackup；`workshopProjects` 表结构零改动                                                                  |
| **D23** | **toggle 纪律**：绝不自动重试；UI 以响应校正；按钮节流 800ms/项目                                                   | 翻转语义（§1.2）下重试 = 可能反向操作。乐观更新允许，但响应到达后**无条件覆盖**本地值；失败（含超时）回滚到操作前。服务端零限流，节流是我们自觉当好公民                                                                                                                                                                                                                                    |
| **D24** | **缓存分身份**：未登录走 TTL 缓存（列表 TTL 对齐上游 45s→120s）；已登录读取加 `cache:'no-store'` 且缓存键带身份前缀 | no-store 抵消 §1.3 的个性化污染（HTTP 层）；应用层 TTL 缓存仍保留用于吸收翻页往返，但键前缀 `anon:` / `u<userId>:` 防止登录/登出前后串数据。toggle 后将响应值写入 social 覆盖层（见 §3.3），使 TTL 窗口内的缓存旧值不可见                                                                                                                                                                  |
| **D25** | **失败分类扩容**：`WorkshopFailureKind` 新增 `'unauthorized'`；guild 门槛失败要说人话                               | 401 `{"error":"Unauthorized"}` → `unauthorized` → UI 引导登录而非红色报错。poll 的 `{success:false, message}`（多为不在 Discord 服务器）→ 展示 message 并附「需加入命定之诗 Discord 服务器」说明。`/me` 若被使用，按 `user === null` 判定而非状态码                                                                                                                                        |

## 3. 实施切片

### 3.1 P3b 引擎/客户端层（先行）

| 文件                                     | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sillytavern/workshop-types.ts`      | + `WorkshopSocialMeta` 类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/sillytavern/workshop-manifest.ts`   | + `parseSocialMeta(raw): WorkshopSocialMeta` 纯函数（容忍缺字段）                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/ui/lib/workshop-client.ts`          | D21 契约修订（headers/cache 入 `WorkshopFetchInit`，`setWorkshopAuthTokenProvider` 注入缝）；`WORKSHOP_LIST_TTL_MS` 45_000→120_000（O2）；缓存键身份前缀（D24）；`listProjects` 响应 + `socials: Record<id, WorkshopSocialMeta>`、`fetchProject` 响应 + `social`；+ `toggleLike(projectId, opts)` / `toggleSubscribe(projectId, opts)`（无体 POST、永不重试、不进缓存）；+ `startLogin()` / `pollLogin(state)`（登录也是网络，收口在 client）；`WorkshopFailureKind` + `'unauthorized'`；错误体双形状解析（§1.4） |
| `src/ui/stores/workshop-social-store.ts` | 新 Pinia store：auth 状态（token/user/loginPhase）+ 登录编排（D19 弹窗/postMessage/轮询/超时/单飞）+ JWT 本地解码与 exp 判定（D20）+ localStorage 持久化 + per-project social 覆盖层 + `toggleLike/toggleSubscribe` action（节流、乐观、校正、回滚，D23）+ 挂载时注册 token provider                                                                                                                                                                                                                              |

### 3.2 P3c UI 层（依赖 P3b 的接口）

| 组件                      | 改动                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `WorkshopPage.vue`        | 顶栏登录位：未登录「Discord 登录」按钮；已登录 Discord 头像（`avatarUrl` 后端拼好）+ 名字 + 登出。登录失败文案走 D25 |
| `WorkshopProjectCard.vue` | 点赞/订阅小按钮 + 计数（social 覆盖层 ?? 响应值）；未登录点击 → toast 引导登录；busy/节流态禁用                      |
| `WorkshopDetailModal.vue` | 同上放大版；计数展示接 `WorkshopSocialMeta`                                                                          |
| `WorkshopBrowseModal.vue` | 把 `listProjects` 返回的 `socials` 传给卡片                                                                          |

### 3.3 社交值的显示优先级（单一读取规则）

```
显示值 = socialStore.override[projectId]   // toggle 响应写入，最权威
       ?? 本次响应携带的 parseSocialMeta   // 列表/详情自然刷新
       ?? 不显示计数（不编数字）
```

登出时清空 override 层与已登录缓存键（用户旗标不跨身份）。

## 4. 基于后端源码的前端请求优化（本次一并实施）

| #   | 优化                                              | 依据                                                                                         | 节省                              |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| O1  | 用户信息 JWT 本地解码，不调 `/api/auth/me`        | `/me` 就是把 JWT payload 抄回来（后端 `endpoints/auth.ts:337-376`）                          | 每次启动/刷新 1 个请求            |
| O2  | 列表 TTL 45s → 120s                               | 上游自己声明 `s-maxage=120`（`index.ts:90-93`），即官方认可的新鲜度下限                      | 浏览往返请求约再减半              |
| O3  | postMessage 快路径 + 轮询 2s（参考实现 1s）       | 回调页 postMessage 是上游内建行为（`endpoints/auth.ts:59-68`）；state 双验证后收下即可停轮询 | 每次登录最多省 ~30 次 poll        |
| O4  | 登出不发请求                                      | `POST /api/auth/logout` 是纯 no-op（`endpoints/auth.ts:383-399`）                            | 每次登出 1 个请求                 |
| O5  | toggle 响应自带 `count` → 零回读                  | §1.2 响应形状                                                                                | 每次点赞/订阅省 1 次列表/详情回读 |
| O6  | 不引入上游自家前端的 `_=<timestamp>` 缓存破坏参数 | 实测其 `home.js` 带此参数拆缓存；我们的 URL 保持稳定才能吃到边缘/应用层缓存                  | 防负优化                          |
| —   | 详情 TTL 5min 与上游 `s-maxage=300` 恰好一致      | 无需改动，记录备查                                                                           | —                                 |

（D24 的 `no-store` 是**正确性**修正而非优化：已登录时个性化字段不可缓存，这部分请求增量是必要成本，由 override 层把它压到最低。）

## 5. 测试要点

- **client**：token provider 附着/不附着 `Authorization`；已登录键前缀与未登录互不命中；toggle 401 → `unauthorized`；toggle 网络失败**不重试**（fetch 调用数恒 1）；两种错误体都能分类；`parseSocialMeta` 缺字段兜底；poll 三态（pending/成功/失败）解析。
- **store**：postMessage 伪造（source 不对 / state 不对）一律拒收；快路径命中后不再 poll；60s 超时收场；JWT 过期启动即登出；乐观→校正→失败回滚三段；节流窗口内重复点击不发第二枪。
- **UI**：未登录点赞出引导不发请求；计数显示优先级规则（§3.3）。
- 全部走 `setWorkshopFetch` mock，**绝不发真实请求**；`npm run typecheck` + workshop 全套测试绿。
- 🔴 **真机验证留给主人**：真实 Discord OAuth（含 guild 门槛路径）必须人工走一遍——助手不代操作账号登录。

## 6. 不做的事（本阶段边界）

- 投稿/我的项目/管理面（`/api/my/*`、`/api/admin/*`）——拖入审核流，另立阶段。
- token 刷新——上游无端点，7 天过期即重新登录。
- 订阅内容的自动更新检查联动（「已订阅项目有新版本时提示」是好点子，但依赖轮询策略设计，单独评估）。
- 对 `downloadsCount` 的任何逻辑依赖（§1.3）。
