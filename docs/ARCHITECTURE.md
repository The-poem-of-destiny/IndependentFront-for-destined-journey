# 《命定之诗》软件架构总览

> **状态**：现行架构总览，2026-08-18 重写，取代 2026-06 版 —— 旧版归档于 `docs/archive/ARCHITECTURE-2026-06.md`。
>
> **维护约定**：结构变更时本文与两份分册（`src/sillytavern/AGENTS.md`、`src/ui/AGENTS.md`）**同步更新**。
> 本文只写「层与层之间的形状」，任何一层内部的模块清单/踩坑记录都归分册，不在这里重复。

---

## 一、定位与阅读顺序

本文是**顶层鸟瞰**：四层结构、层间契约、一轮对话怎么流、并发怎么排队。它刻意不列模块清单 ——
一个模块该怎么改、哪些写法「不报错但是错的」，全部在分册与各系统的 living design 文档里。

**读的顺序**：

1. 根 `AGENTS.md` —— 指令正文（约定 / ADR / 提交前检查 / 进度速览），唯一真源。
2. 本文 —— 结构鸟瞰，建立坐标系。
3. 动哪层代码就读哪份分册：

| 分册                                                        | 覆盖范围                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| [`src/sillytavern/AGENTS.md`](../src/sillytavern/AGENTS.md) | 引擎层全部模块：类型/数据库/Agent 编排/战斗/制作/效果/图像生成…     |
| [`src/ui/AGENTS.md`](../src/ui/AGENTS.md)                   | 前端层：composables / lib / stores / components / 设置页 / 预设系统 |

**各系统的 living design**（改哪个系统读哪份，路径均相对仓库根）：

```
docs/reference/
├── effect_script_system.md              # 词条效果 & 脚本沙盒（引擎必读）
├── combat-system-architecture-v3.md     # 战斗系统 v3（代码内核主持流程；现行 combat_v3
│                                        #   Agent 契约在 agent-config.json + agent-tools.ts
│                                        #   + combat-v3/projection-agent.ts，无单独接口文档）
├── agent_system_prompt_guide.md         # Agent System Prompt 配置流程
├── audio_system.md                      # 音频系统 v1.0
├── worldbook-ejs-regex-authoring-guide.md  # 世界书 EJS + 输出美化正则（作者入口）
├── story_preset_format.md               # Story 预设编写指南
├── debug-loop-handbook.md               # 游玩→导出→分析→修复 调试循环
└── dev-bat-notes.md                     # dev.bat / dev.sh 说明书（改启动器前必读）

docs/planning/
├── 2026-07-31-creative-workshop-compat-design.md  # 创意工坊 / 世界书存储
├── 2026-07-31-workshop-phase2-ejs-design.md       # ADR-30 设计历史（部分已被能力面取代，
│                                                  #   现行创作者契约在 worldbook-ejs guide）
├── 2026-08-01-ejs-capability-surface-design.md    # EJS 能力面（12 namespace）
├── 2026-08-04-image-generation-design.md          # 图像生成 v1
├── 2026-08-05-content-engine-separation-design.md # 内容/引擎分离（占位集 + overlay）
├── 2026-08-11-map-system-v1-integration.md        # 地图 v1（ADR-31）
├── 2026-08-15-random-event-system-design.md       # 随机事件 v1（ADR-32）
├── 2026-08-16-pipeline-parallelism.md             # 写队列 + 4 层并行管线
└── 2026-07-29-asset-management-system-design.md   # 素材管理系统 v1.0

docs/superpowers/specs/                            # 数据字段规范 + 实体字段审计
docs/design.md                                     # 前端 UI 设计规范（写 UI 前必读）
```

> **世界观资料不在本仓**：世界书索引、审计报告、叙事规范范例、v4.2.1 参考页面等已随内容分离
> 移入私有内容仓 `fated_poem_independent_assets`，公开仓侧不可见（根 `reference/` 被 `.gitignore` 整树排除）。

---

## 二、四层结构

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① 前端 UI —— Vue 3 + Pinia            src/ui/  （125 个 .vue）        │
│   App.vue = 视图状态机（无 vue-router；ui.currentView 五态：          │
│              home / create / game / settings / workshop，全懒加载）    │
│   stores/（26 个非测试模块，含迁移器与工具）· composables/（10 个）    │
│   lib/（非组件模块：纯逻辑 / I/O 面 / 注入缝装配）                    │
│   components/{home,create,game,settings,shared,workshop}/             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 单向依赖（前端 → 引擎，见 §三）
┌───────────────────────────────▼──────────────────────────────────────┐
│ ② 引擎 —— 框架无关 TypeScript        src/sillytavern/ （168 非测试 .ts）│
│   types.ts（唯一类型来源）· database.ts · agent-orchestrator.ts       │
│   state-manager.ts（唯一写入口）· state-write-queue.ts                │
│   combat-v3/（内核+DSL+主持流程）· image-providers/                    │
│   零 Vue / 零 Pinia / 零 DOM —— headless 可跑                          │
└──────────┬────────────────────────────────────────┬──────────────────┘
           │ fetch 同源 /api/*                       │ Dexie
┌──────────▼──────────────────────────┐  ┌──────────▼──────────────────┐
│ ③ Hono BFF          server/          │  │ ④ 持久化 + 内容层            │
│   BFF_ROUTE_TABLE 单源 7 前缀        │  │   Dexie v22 · 30 张表        │
│   Origin: null → 403 守卫            │  │   快照拆表 meta/payload      │
│   routes/proxy.ts：透传转发器        │  │   public/data/ 占位集        │
│     + SSRF 黑名单（云元数据端点）    │  │   POEM_CONTENT_DIR overlay   │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

### ① 前端 UI（`src/ui/`）

Vue 3 SFC + Pinia。**没有 vue-router**：`App.vue` 用 `ui.currentView` 在五个页面组件之间切换，
每个页面 `defineAsyncComponent` 懒加载。主题/字体系统在 `themes/` + `styles/`，
由 `theme-surface-ownership` / `theme-fonts-invariant` 两道结构闸门守着。

### ② 引擎（`src/sillytavern/`）

框架无关的纯 TypeScript。子目录只有两处：`combat-v3/`（`automata/` `contract/` `phases/` `fixtures/`）
与 `image-providers/`。**类型唯一真源是 `types.ts`**，大型联合类型拆 `types-*.ts`
（现有 `types-audio` / `types-content` / `types-image` / `types-map` / `types-random-events`）。

### ③ Hono BFF（`server/`）

透传型 BFF：**key 由前端持有**，BFF 只做「加 CORS 头的 fetch 转发器」，零状态。三条硬形状：

- **`BFF_ROUTE_TABLE` 是前缀清单的唯一真源**（`server/app.ts`）。挂载、`BFF_ROUTE_PREFIXES`、
  `vite.config.ts` 的 dev/preview 两处中间件全部从它派生。现有 7 个前缀：
  `/api/chat` `/api/status` `/api/embeddings` `/api/models` `/api/image` `/api/worldbooks` `/api/defaults`。
  🔴 此前这份白名单在 vite 里被逐字抄了两遍（合计三处手工同步），漏改的症状是
  「代码看着完全正确，请求 404」。加路由**只改这张表**。
- **`Origin: null` 一律 403**。沙箱 srcdoc frame 会发这个头；放行等于把带凭据的 BFF 变成
  它的内网代理。
- **SSRF 黑名单**在 `routes/proxy.ts`：只拒云厂商元数据端点（IMDS 等）。**不拒 localhost / 私有 IP**
  —— 本地 LLM（ollama 等）需要它们，且这是同源单租户 BFF。上云多租户时必须改成 DNS 解析后逐 IP 校验。
- 唯一有状态的例外是 `/api/worldbooks` `/api/defaults` 两条**写回**路由，只在
  `POEM_CONTENT_DIR` 配置时注册，否则回 501。

### ④ 持久化 + 内容层

- **Dexie v22 / IndexedDB**，30 张表（`database.ts`）。v22 把快照拆成
  `snapshots`（元数据）+ `snapshotPayloads`（重载荷）—— 列表与淘汰每回合都跑，
  却只用得上 `turn` / `createdAt`，拆表前要把约 30 份整档对话历史在主线程反序列化一遍。
- **内容包覆盖层**：公开仓只带**零 IP 占位集**（磁盘 `public/data/`，运行期 URL 仍是 `/data/*`）；
  真实内容挂在私有内容仓，dev 期由 `POEM_CONTENT_DIR` 指向内容树做 overlay（中间件先于 Vite
  publicDir 注册，overlay 必然赢）。发行期走内容包（`contentPacks` 表 + 内容注册表注入缝）。
  `tests/no-world-content.test.ts` / `placeholder-content.test.ts` / `no-external-assets.test.ts`
  三道闸门钉住「公开仓侧不许有真实 IP 内容 / 不许引外链素材」。

---

## 三、分层契约与机器闸门

### 3.1 分层方向只有一个：前端 → 引擎

`src/sillytavern/**` **禁止** import `../ui/*` / `@ui/*` / `vue` / `pinia`，**type-only 也算**。

这条契约**破坏时不报错** —— 反向 import 编译得过、测试全绿，代价是引擎从此拖着
Vue + Pinia + Dexie 整条前端链，headless 跑批与引擎单测都得把整个 store 拉起来，
而 review 里一行 `import type { X } from '../ui/...'` 看上去人畜无害。所以两道闸互补：

| 闸门                                          | 管什么                                        | 看不见什么                    |
| --------------------------------------------- | --------------------------------------------- | ----------------------------- |
| `eslint.config.js` 的 `no-restricted-imports` | 静态 `import` / `export from`（引擎目录一档） | 动态 import、字符串路径、glob |
| `tests/layering-gate.test.ts`                 | 直接扫源码字符串，专治上面三种绕法            | —                             |

> `?raw` 源码读取**不算依赖边**：`import.meta.glob('@ui/main.ts', { query: '?raw' })`
> 把前端源码当字符串读进来做「供值链路」断言，没有把任何前端模块拉进依赖图。
> 判据是「命中行自己是不是真的在读源码字符串」，不是文件白名单。

**反向的方向不受限**：前端可以直连引擎任意模块。`src/ui/lib/` 是「值得收口的东西的家」，
**不是必经之路** —— 「引擎只经 lib/ 触达」是意图不是现状，没有任何闸门（见 §七）。

### 3.2 四条注入缝

引擎要用前端的东西只有两条路：**搬进引擎**（先例：`media-hash.ts`、`types.ts` 的 `CreatePreset`），
或**开一条注入缝**由前端往里装。现有四条：

| 缝                            | 装的是什么                       | 前端供值处                       |
| ----------------------------- | -------------------------------- | -------------------------------- |
| `engine-settings.ts`          | 全局设置真源（localStorage 侧）  | `src/ui/main.ts`                 |
| `content-registry-runtime.ts` | 内容注册表（世界书/预设/规则等） | `src/ui/stores/content-store.ts` |
| `map-runtime.ts`              | 地图包 MapPack + 派生索引        | 同上（随注册表一起换）           |
| `random-event-runtime.ts`     | 随机事件包 RandomEventPack       | 同上                             |

共同契约：**模块级单例 + `install*` / `get*` / `reset*` 三件套、缝内零 I/O、未装值时返回空包兜底**
（引擎单测不必拉起 store，坏包的代价是「棋子没在图上」而不是启动失败）。
🔴 `engine-settings.ts` 是这套形状的**变体**：它装的是 provider 函数
（`setEngineSettingsProvider` / `getEngineSettings`），没有 `reset`，因为它读的是活配置而不是快照包。

### 3.3 「结构闸门测试」这一类

一批专门断言**结构性契约**的测试 —— 它们不测行为，测的是「这条约定还成立吗」。
共同点：违反时不会有任何运行时症状，只有靠闸门才拦得住。

| 闸门                                                                                   | 钉住的契约                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `tests/layering-gate.test.ts`                                                          | 引擎不依赖前端（含动态/字符串/glob 绕法）               |
| `tests/encoding-invariants.test.ts`                                                    | U+FFFD = 0 / 控制字符 = 0 / JSON 可解析（含解析后的值） |
| `tests/no-world-content.test.ts`                                                       | 公开仓侧不含真实 IP 世界观内容                          |
| `tests/placeholder-content.test.ts`                                                    | 占位集完整且自洽                                        |
| `tests/no-external-assets.test.ts`                                                     | 不引外链素材                                            |
| `tests/theme-surface-ownership.test.ts`                                                | 主题表面归属（谁画背景）                                |
| `tests/theme-fonts-invariant.test.ts`                                                  | 字体栈不变式                                            |
| `tests/build-placeholder-hashes.test.ts`                                               | 占位基线 hash 清单与实际占位集一致                      |
| `tests/knip-ratchet.test.ts`                                                           | 死代码棘轮：只许变少不许变多                            |
| `tests/server-app.test.ts`                                                             | BFF 路由前缀单源 + Origin 守卫                          |
| `src/sillytavern/map-literals-gate.test.ts`                                            | 引擎地图模块零中文字面量（换图零改码）                  |
| `src/sillytavern/random-event-literals-gate.test.ts`                                   | 同上，随机事件侧                                        |
| `tests/agent-tools-prompt-contract.test.ts` / `memory-summary-prompt-contract.test.ts` | 提示词与工具契约一致                                    |

---

## 四、一轮对话的数据流

```
玩家输入
   │
   ▼
GamePipeline（src/ui/lib/game-pipeline.ts）
   │  组装 AgentConfig / AgentContext：世界书装配（EJS 求值，ADR-30）、
   │  stat 只读投影、{{MAP_CONTEXT}}、{{RANDOM_EVENTS}}、记忆、预设占位符
   ▼
AgentOrchestrator（引擎）—— DEFAULT_AGENT_PIPELINE，4 层 DAG
   │  Stage 0: memory_recall ‖ plot_pre_check              （无依赖，并行）
   │  Stage 1: story                                        （流式，逐块投影到 UI）
   │  Stage 2: request_dispatcher ‖ memory_summary          （都只依赖 story）
   │  Stage 3: vars_update ‖ plot_post_check                （各自 agentWaitFor，互不连坐）
   ▼
marker 协议 / 工具调用（marker-protocol.ts）
   │  <combat_trigger> / <craft_gen> / <char_gen> / <play_audio>
   │  / 情景插画标记 / <event_trigger name="…"/> …
   ▼
StatePatch
   ▼
commitChatState()（state-manager.ts）—— ADR-21 唯一写入口
   │  withSaveWriteLock(saveId) 排队 → CommitScope 提交级缓存开张
   │  读收到入口一拍、写收到出口一拍 → flush
   ▼
Dexie
```

**提示装配 seam（2026-08-23 新增）**：`prompt-session-assembler.ts` 是深模块，独占
`(saveId, agentId)` 的 delta 会话状态（transcript / baseline signature / revision / 投影 diff
起点），只对 orchestrator 开 `preparePromptSession` / `completePromptSession` /
`invalidatePromptSession` 三个入口；diff 由只读、幂等的 `prompt-state-projection.ts` 提供。
主 DAG 普通 chat/chatStream 首轮完整渲染 baseline，后续轮复用 wire transcript 只追加
`context_delta + turn_context + tailPrompt` 增量。模块不写 Dexie（内存态随刷新冷建基线）；
embedding / tools / 战斗 / 侧链 / regenerate 走原路径。设计见
`docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md`。

**两条旁路**：

- **战斗 v3 是持久会话旁路**：`<combat_trigger>` 命中后进 `combat-v3/` 的
  Kernel + DiceTape + EffectIntent + DSL 主持流程（coordinator 持会话、玩家意图文本经
  AI 解析成 Command），战斗期间不走上面这条主管线；结束后以结算摘要回注。
- **EJS 求值发生在提示装配期**（ADR-30，非运行期）：`stats` 只读面 + `vars` 共写叙事变量空间，
  冲突 AI 赢（EJS 差量先落、`vars_update` 补丁后落）；失败条目原文注入，零回归兜底。

---

## 五、并发模型

管线并行化之后，「同一存档的写」必须序列化，否则并行的两层会互相盖写。

- **`state-write-queue.ts`** —— 两把锁：
  - `withSaveWriteLock(saveId, fn)`：**per-saveId FIFO 队列**。同一存档的写按提交顺序排队，
    不同存档互不阻塞。
  - `withGlobalWriteLock(fn)`：记忆等跨存档资源用的全局锁。
- **`CommitScope`（`state-manager.ts`）—— 提交级缓存**：一次 `commitChatState` 内，
  读收到入口一拍、写收到出口一拍。此前每个 patch 各跑一趟完整读-改-写（10 个变量补丁 =
  20 次 `getProfile` + 10 次 `updateProfile`，每个角色补丁各扫一遍 `characters` 全表）。
  作用域只在锁段内非 null。
- **P1-09 受控 UI 写例外**：SaveProfile 的纯 UI 辅助字段（`focusQuest` 焦点任务、`news[].read`
  已读标记）允许 UI 触发写入，但必须走 `persistFocusQuest()` / `persistNewsRead()` 两个命名入口。
  🔴 这两个入口**串进 `withSaveWriteLock` 并在锁内重读一份新鲜 profile、只改那一个字段**：
  提交级缓存把写窗口拉成「整次提交一拍」，不进队列的 UI 写会被出口那次整档 flush 盖掉；
  而拿着 UI 手里那份陈旧整档进锁写回去，又会反过来抹掉提交结果 —— **两件事缺一条都不算修好**。
  AI 产生的 SaveProfile 变更仍必须走 `vars_update` 语义 op，不在此例外内。

---

## 六、规模与热点

| 维度          | 数值                                     |
| ------------- | ---------------------------------------- |
| 前端组件      | 125 个 `.vue`                            |
| 引擎非测试 TS | 168 个（`src/` 全量非测试 TS 为 257 个） |
| BFF           | `server/app.ts` + 7 个 route 模块        |
| 数据库        | Dexie v22 / 30 张表                      |
| 测试          | 342 个 `*.test.ts`，约 8.5k 用例         |

**行数热点**（超过 1800 行的文件，改动前先看分册对应章节）：

```
4167  src/sillytavern/types.ts
2664  src/sillytavern/state-manager.ts
2487  src/ui/lib/game-pipeline.ts
2391  src/ui/stores/asset-store.ts
2318  src/sillytavern/database.ts
2234  src/ui/stores/create-store.ts
2226  src/sillytavern/combat-v3/coordinator.ts
1863  src/ui/components/game/MapPoliticalTab.vue
1844  src/ui/lib/workshop-client.ts
1816  src/sillytavern/combat-v3/types.ts
```

> 📌 `types-*.ts` 拆分约定**只半施行**：新系统（audio / content / image / map / random-events）
> 各自拆了分册，但 `types.ts` 仍有 4167 行 —— v3 兼容层与 v4+ 核心实体都还挤在里面。
> 新增大型联合类型请继续拆分册，不要往 `types.ts` 里追加。

---

## 七、已知结构性缺口

1. **BFF 没有生产入口**。`buildHonoApp()` 只在 `vite.config.ts` 的 `configureServer`（dev）与
   `configurePreviewServer`（preview）两处被挂起来；没有独立进程入口，也没有打包产物。
   对应根 `TODO.md` 的「正式打包」一条 —— 在那之前，发行形态仍依赖 vite。
2. **`src/ui/lib/` 是意图不是现状**。实测 `src/ui` 下有 134 个非测试文件直接 `import '@engine/*'`，
   其中只有 19 个住在 `lib/`，另外 115 个是 stores / components 自己直连引擎。
   「引擎只经 lib/ 触达」**没有任何闸门**，写代码时不要依赖它成立
   （「改引擎签名只要改 lib/」是错的）。
3. **8 个 `*.standalone.html` 原型驻留 `src/ui/components/home/`**
   （AstralDrift 系列 6 个 + MagicCircle + ObsidianAstrolabeV2）。它们不进构建图、
   不被任何组件 import，是首页视觉方案的调参台。删除前需确认对应视觉方案已定型。
