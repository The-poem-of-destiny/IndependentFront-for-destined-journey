# 工坊 P3 社交面 — 交接文件（2026-08-01）

> 给下一个会话/协作者的完整交接。当前分支 `workshop-phase3`，提交 `417dc2b`，已推送。
> 代码状态：**实现完成、全量验证绿、待真机走查、未合 master**。

## 一、现在在哪

| 项           | 状态                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分支         | `workshop-phase3`（tracking origin，PR 未开：<https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/pull/new/workshop-phase3>） |
| 提交         | `417dc2b` feat(workshop) 工坊 P3 社交面（26 文件 +3854）；其前是 master 上的 `097b0e8` perf(workshop) 请求瘦身                                         |
| 验证         | 全仓 155 文件 / 5157 tests 绿；typecheck / vue-tsc / eslint 零错误；push 后 CI 结果见 Actions（watch 已挂）                                            |
| 设计真源     | `docs/archive/planning/2026-08-01-workshop-social-design.md`（D18–D25 + 上游契约附录 + 优化 O1–O6）——**改任何社交代码前必读**                          |
| 上游后端源码 | <https://github.com/AkabaneSaki/myrepo>（worker 在 `cloudflare/src/`）。契约疑问直接读源码，别猜                                                       |

## 二、这次做了什么（两笔工作）

1. **请求瘦身**（`097b0e8`，已在 master）：列表 45s TTL 缓存（后升 120s，见下）+ 安装不再 force 重下载荷 + 首装吃详情热缓存。
2. **社交面 P3**（`417dc2b`，本分支）：
   - `workshop-client.ts` — D21 契约修订（`WorkshopFetchInit` 扩 method/headers/cache）、`setWorkshopAuthTokenProvider` 注入缝、`decodeJwtPayload`、已登录 no-store + 缓存键身份前缀（`anon:`/`u<id>:`；载荷键刻意不分身份）、`toggleLike/toggleSubscribe`（**永不重试**）、`startLogin/pollLogin`、`WorkshopFailureKind` + `'unauthorized'`、双错误体解析
   - `workshop-social-store.ts`（新）— 登录编排（弹窗 + postMessage 快路径 source+state 双验证 + 2s 轮询兜底 60s 超时）、JWT 本地解码（不调 `/api/auth/me`）、localStorage `workshop-auth` 只存 `{token}`、per-project 社交覆盖层、toggle 乐观→无条件校正→失败回滚 + 800ms（项目×动作）节流、登出零请求
   - `parseSocialMeta/parseToggleAck`（workshop-manifest 纯函数）+ `WorkshopSocialMeta/WorkshopToggleAck` 类型
   - UI：`WorkshopSocialActions.vue`（新，卡片 compact / 详情 full **唯一**动作入口）、`WorkshopPage` 顶栏登录位、`WorkshopBrowseModal` 派发 socials、卡片根节点 `<button>`→`div[role=button]`（修按钮嵌套非法 HTML）
   - 文档：AGENTS.md（进度表 + 组件树）、CHANGELOG 顶部条目、旧设计文档 D11 对齐现实（安装即授予全 Agent 可见）

## 三、没做完 / 下一步（按优先级）

1. **🔴 真机走查（唯一硬阻塞）** — 必须人工做，AI 不代操作 Discord 账号：
   - [ ] 正常登录：点顶栏「Discord 登录」→ 弹窗授权 → 头像+名字出现；network 面板确认 poll 在 postMessage 快路径命中后**停止**
   - [ ] guild 门槛：用不在命定之诗 Discord 服务器的账号登录 → 应看到带「需加入服务器」说明的失败文案，而非红色报错
   - [ ] 点赞/订阅：登录后 toggle 一次成功（计数即时变、刷新后仍对）；断网点一次 → 回滚 + error toast；800ms 内连点 → 只发一枪
   - [ ] 未登录点赞 → 引导登录 toast，network 零请求
   - [ ] 刷新页面 token 复活（localStorage）；手动改坏 token → 静默登出不炸页
   - [ ] 已登录后列表请求带 `Authorization` 且 `no-store`（防 §1.3 个性化缓存污染）
2. **开 PR 合 master** — 真机过了再合；PR 正文可直接引用设计文档 §0 判决 + CHANGELOG 条目。
3. **可选后续**（设计文档 §6 明确本阶段不做）：投稿/我的项目、订阅项目更新提醒（依赖轮询策略，单独评估）、token 过期（7 天）后的重登录提示打磨。

## 四、坑与不变式（新会话最容易踩的）

- **toggle 是翻转不是幂等**（上游有行删/无行插）——任何「失败自动重试」都可能反向操作。D23 禁令，别好心加重试。
- **社交数据零持久化**（D13/D22）——不进 Dexie、不进 FullBackup、不进 `WorkshopProjectMeta`。测试在主动 enforce 这一点。
- **`credentials: 'include'` 全域禁止**——上游 ACAO:* 无 Allow-Credentials，加了整个请求会被浏览器拒掉。
- **上游列表/详情无 `Vary: Authorization`**——已登录读取必须 no-store；显示值一律走 store 覆盖层优先（设计文档 §3.3）。
- **网络只经 workshop-client**——组件/store 不碰 fetch；登录轮询也收在 client（`startLogin/pollLogin`）。
- prettier：仓库在 Windows 下 `--check` 有 CRLF 假阳性，转 LF 比对才是真相（agent memory 也记了这条）。
- 上游 worker 源码克隆在本会话 scratchpad（会话结束即失效），仓库地址在上表，需要时重新克隆。

## 五、相关文件一览（改社交必读顺序）

1. `docs/archive/planning/2026-08-01-workshop-social-design.md` — 设计 + 契约 + 决策
2. `src/ui/lib/workshop-client.ts` — 网络唯一入口（头注释含 D21 修订记录）
3. `src/ui/stores/workshop-social-store.ts` — 登录/社交状态编排
4. `src/ui/components/workshop/WorkshopSocialActions.vue` — 动作按钮唯一入口
5. `docs/planning/2026-07-31-creative-workshop-compat-design.md` — 工坊 P1 底座（D1–D17）
