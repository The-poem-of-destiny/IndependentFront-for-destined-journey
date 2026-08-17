# 《命定之诗独立前端》全仓审查报告（非安全维度）

> 审查日期：2026-08-16 · 基线：`master` @ `1133a82` · 范围：全仓代码 / 测试 / 文档 / 构建产物 / 工具链（安全议题除外，属另一条独立审查线）

## 0. 审查方法

- **9 个维度并行深读** —— 架构与模块边界 / 类型安全 / 测试质量 / 代码质量 / 性能 / 前端 UI 规范与可访问性 / 数据层与持久化 / 文档一致性 / 构建 CI 工具链与依赖，另加 **1 轮完备性补扫**，专查九维都没碰到的子系统与产物（音频、图像生成、构建产物、应用引导链路等）。
- **逐条对抗验证** —— 每条发现都交给独立验证员核实：打开引用的文件与行号确认证据存在、检查影响是否夸大、是否落在文档明载的豁免里，并按事实修正严重度。
- **产出底账** —— 共 101 条发现：**0 条被驳回**，27 条「部分成立」（多为降档或加限定）；修正后 **high 2 条 / medium 51 条 / low 48 条**。各维度还同步记录了亮点与量化统计，报告求公允而非找茬。
- **闸门实跑** —— 工具链维度实际运行了本地质量闸门：`typecheck`、`typecheck:tools`、`lint`、`knip:ratchet` **全部通过**（`format:check` 在 Windows 上 776/776 全红属环境性假红，详见第 12 章）。

## 1. 总体评价

这是一个**工程纪律显著高于同类项目**的仓库。最突出的品质是「约定不只写在文档里，还大量落成机器闸门」：编码不变量、内容分离、地图/随机事件零中文字面量、主题归属、knip 死代码棘轮，都是真测试真 CI 在守。测试体量达 8303 个用例且无断言测试为零、全仓 TODO 仅 1 条、`@ts-ignore` 零处、122 份 Markdown 文档内部链接零死链、ADR-19 语义级 $ API 执行几乎无瑕疵——这些数字在 700 个源文件的体量下是罕见的。

对抗验证后**没有任何一条发现被驳回，但也只有 2 条 high 幸存**——问题的总体形态不是「有大 bug」，而是三个反复出现的模式：

1. **「规范靠人肉」的缺口**。仓库明明有把约束钉成测试的文化，却恰好在几处最会持续恶化的地方没钉：跨层 import 方向零闸门（引擎反向依赖前端 store 已长出 6 处）、design.md 声称的「强制扫描」并不存在（间距硬编码 1088 处已反超 token 用法 981 处）、`any` 无棘轮（259 处无计量）、测试无覆盖率度量。这些都不是现存缺陷，而是**已被证实会无声恶化的趋势**。
2. **每回合写入热路径的线性增长成本**。仅有的两条 high 都在这里：快照深拷贝全量消息历史、`commitChatState` 逐补丁全量读-改-写，成本随游戏时长线性上涨，长存档会先感知到。
3. **产物与文档的漂移**。`vite build` 把 267MB 待授权且应用点不到的音频打进产物；`data/ → public/data` 迁移没同步进 AGENTS.md 常驻指令（编码验证铁律引用的路径已失效）；`docs/ARCHITECTURE.md` 整篇过期仍挂着「架构总览」名号。

数据层另有几条**确凿但触发条件窄**的正确性缺陷（卸载内容包后标记可被静默抹掉、批量落库无事务、快照回退漏两张表、整库备份不含 localStorage 设置），值得排进近期修复。

## 2. 各维度一句话结论

| #   | 维度                   | 一句话结论                                                                                                            |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 4   | 架构与模块边界         | 架构主张大多落地，软肋是引擎反向依赖前端 store（6 处）且零机器闸门守护分层                                            |
| 5   | 类型安全               | 类型地基扎实（三闸门全绿、`@ts-ignore` 零处），漏风在 `any` 逃逸口与类型网边界；四个严格开关实测 0 error 可白捡       |
| 6   | 测试质量与覆盖         | 体量与配套率优秀（8303 用例、无断言测试为零），但全仓零覆盖率度量，且多处闸门会静默失效                               |
| 7   | 代码质量与可维护性     | 纪律优秀（TODO 1 条、`@ts-ignore` 0 处），但 GamePipeline 2445 行上帝类与 259 处无棘轮的 `any` 是结构性欠账           |
| 8   | 性能                   | 整体健康，风险集中在每回合写入热路径：快照深拷贝全量历史 + `commitChatState` 逐补丁全量读写，成本随游戏长度线性增长   |
| 9   | 前端 UI 规范与可访问性 | 规范写得好但零机检：间距硬编码 1088 处已反超 token 981 处，design.md 声称的「强制扫描」闸门并不存在                   |
| 10  | 数据层与持久化         | 纪律扎实（事务/三态导入/id 重发齐备），但最热写路径无事务、快照回退漏 characterAppearances、整库备份不含 localStorage |
| 11  | 文档与约定一致性       | Markdown 链接零死链，但 `data/ → public/data` 迁移与 build 语义未同步进常驻指令文件                                   |
| 12  | 构建/CI/工具链与依赖   | 闸门齐备且实跑全绿，但 `format:check` 在 Windows 上 776/776 假红、9 道 CI 闸门无本地聚合命令                          |
| 13  | 完备性补扫             | 代码面干净，风险集中在产物与文档：dist-ui 305MB 中 267MB 是应用点不到的待授权音频                                     |

## 3. 跨维度修复排期建议

### P0 —— 成本随使用持续增长，建议最先动手

| 严重度    | 问题                                                                             | 位置                                                        |
| --------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 🔴 high   | 每回合快照深拷贝全量消息历史，trim 时又把 30 份快照整行读回                      | `src/sillytavern/state-manager.ts:1430`、`database.ts:1368` |
| 🔴 high   | `commitChatState` 逐补丁全量读-改-写 profile 与 characters 全表                  | `src/sillytavern/state-manager.ts:279`                      |
| 🟡 medium | `vite build` 把 267MB 未授权且应用点不到的音频打进产物（dist-ui 共 305MB）       | `vite.config.ts:238-241`、`public/audio/manifest.json`      |
| 🟡 medium | `data/ → public/data` 迁移未同步：AGENTS.md 编码验证铁律与内容包路径引用全部失效 | `AGENTS.md:48`、`src/sillytavern/AGENTS.md:75`              |

### P1 —— 确凿的正确性缺陷，触发条件窄但值得近期修

| 严重度    | 问题                                                                                                                      | 位置                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 🟡 medium | content-store 两处裸写 `db.saves.put` 绕过 `saveSaveSlot`，卸载路径不刷新内存，`needs_selection` 标记可被后续写回静默抹掉 | `src/ui/stores/content-store.ts:1162,1481`                 |
| 🟡 medium | `commitChatState` 批量落库无事务，成对补丁中途失败留半应用状态                                                            | `src/sillytavern/state-manager.ts:278`                     |
| 🟡 medium | 快照回退不回滚 characterAppearances / sceneImages，留下被撤销的外貌与图鉴孤儿                                             | `src/sillytavern/state-manager.ts:1511`                    |
| 🟡 medium | 整库备份不含 localStorage 设置，恢复后 Agent 提示词/预设/出图配置归零                                                     | `src/sillytavern/database.ts:693`                          |
| 🟡 medium | BFF 转发无超时，上游挂起即请求永久挂起；`/api/worldbooks`、`/api/defaults` 仅存在于 dev 中间件，preview/生产必 404        | `server/routes/proxy.ts:110-118`、`vite.config.ts:114,155` |
| 🟡 medium | 全仓零全局错误兜底（无 `app.config.errorHandler` / `unhandledrejection`），真机异常不可观测                               | `src/ui/main.ts`                                           |

### P2 —— 防回归基建，一次投入长期受益

| 严重度    | 问题                                                                                               | 位置                                                           |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 🟡 medium | 补分层方向机器闸门：eslint `no-restricted-imports` + layering gate 测试，顺手清 6 处引擎→UI 反向边 | `eslint.config.js`、`tests/`                                   |
| 🟡 medium | tsconfig 四个零成本严格开关（实测 0 error 直接可开）                                               | `tsconfig.json`                                                |
| 🟡 medium | 补覆盖率度量与 `any` 棘轮（259 处存量），照 knip 棘轮既有模式                                      | `vitest.config.ts`、`eslint.config.js:58`                      |
| 🟡 medium | design.md 声称的「强制扫描」补成真闸门，遏制间距硬编码继续反超                                     | `docs/design.md:24`                                            |
| 🟡 medium | 9 道 CI 闸门补本地聚合命令（如 `npm run gates`），修 `format:check` Windows 假红                   | `package.json`、`.prettierrc`                                  |
| 🟡 medium | `AppModal` 补 dialog 语义与焦点管理，26 处调用点一次受益                                           | `src/ui/components/shared/AppModal.vue:79`                     |
| 🟡 medium | 声明 MIT 但仓库无 LICENSE 文件，与「代码 MIT + 内容独立授权」双许可口径矛盾                        | `package.json`、仓库根目录                                     |
| ⚪ low    | GamePipeline（2445 行 44 方法）与 create-store（148 个导出）拆分                                   | `src/ui/lib/game-pipeline.ts`、`src/ui/stores/create-store.ts` |

---

以下为十个维度的详细评审。每条问题标注了验证员修正后的严重度；标题后带「验证员限定」说明的，表示对抗验证发现原始指控部分不成立或影响被夸大。

## 4. 架构与模块边界

### 总评

这个维度整体健康度良好，属于「有明确架构主张、并且大部分主张真的落到了代码里」的状态。ADR-19（语义级 $ API）执行得几乎无瑕疵，combat-v3 的子系统边界是全仓最干净的一处，server/ 层是零耦合的纯 BFF，前端内部依赖方向也基本单向。真正的软肋集中在一处：**引擎层与前端 Pinia store 之间存在 6 条反向 import 边**，以及**没有任何机器闸门守护跨层 import 方向**——这两件事互为因果，前者是已被注释记录在案的知情例外，但后者意味着新的反向边会继续无声长出来。此外有一处确凿的正确性缺陷（content-store 裸写 `db.saves.put` 后不刷新内存，可致卸载内容包的标记被静默抹掉），以及若干偏可维护性的债（注释与事实相反的运行时环、BFF 前缀三处手工同步、types.ts 4022 行 god module）。没有 high 级问题幸存于对抗验证。

### 量化底账

- 扫描范围：src 下 697 个 TS/Vue 源文件（sillytavern 341、顶层平铺 269、combat-v3 74；ui 侧 components 127 个 .vue、stores 56、lib 54、composables 15）+ server/ 7 文件 301 行 + vite.config.ts 242 行 + tests/ 17 个顶层闸门。
- `npx madge --circular` 处理 724 文件，报 **32 条循环依赖**，其中 20 条（#7-#26、#28-#30、#32）经由 `sillytavern/* → ui/stores/content-store|create-store → sillytavern/database` 这条反向边织出（验证员未复跑 madge，此数字未独立证实）。
- ADR-21：全仓 `db.<table>.put/update/bulkPut` 裸写共 11 处，打到受管辖的 `saves` 表的有 2 处，均在 content-store.ts。
- ADR-19：agent-tools.ts 的 27 个工具全为语义级，零 CRUD 原语泄漏；script-executor guest 面仅 6 个 namespace。
- combat-v3：外部 5 处引用内部全为 type-only；`server/` 对 `src/` 的 import 数为 0。
- 闸门覆盖：已有 4 类结构闸门，但**零条守护跨层 import 方向**，eslint 无 `no-restricted-imports` 配置。

### 亮点

- `src/sillytavern/combat-v3/index.ts` 是唯一运行时出口（openCombat/runCombatV3/parsePlayerInput），外部 5 处引用（char-gen-agent.ts:38、combat-v2-types.ts:26、describe-automaton.ts:11、types.ts:17）全为 type-only，零运行时穿透。
- ADR-19 落实彻底：agent-tools.ts 的 27 个工具全是 declare_attack / craft_check / craft_settle / get_hp_percent 这类语义级接口，无 modifyHp/setVar 之流；script-executor.ts 的 buildSandbox 只暴露 $dice/$resource/$char/$status/$event/$call 六面，$validate 未进 guest。
- 「引擎要能力不要位置」的注入缝模式已成型且自我说明充分：`map-runtime.ts`（installMapPack）、`engine-settings.ts`（Q-06 设置真源）、`random-event-runtime.ts`、`script-backend.ts`（fail-closed 无 Legacy）四处形状一致，文件头把设计理由讲得比多数开源 ADR 清楚。
- 结构闸门是真机器闸门而非文档口号：`map-literals-gate.test.ts` / `random-event-literals-gate.test.ts` 钉死换图零改码、`tests/encoding-invariants.test.ts` 钉死中文编码、`tests/no-world-content.test.ts` 钉死内容分离、`start-catalog-mechanics.test.ts` 用导出名黑名单挡条目回流。
- ADR-32 的三条契约在代码里逐条对得上：placeholder-registry.ts:654 `if (ctx.combatActive === true) return ''`（战斗中零 token）、agent-templates.ts:612/668 按替换前原文判 `{{RANDOM_EVENTS}}` 是否存在（老预设兜底）、单通道只注 story。
- server/ 是真正的零状态 BFF：app.ts 52 行 + routes 249 行，对 `src/` 的 import 数为 0，前后端只经 HTTP 契约耦合；前端侧 stores/lib/composables 反向 import components 仅 1 处（usePlayerPortrait.ts:46）。

### 问题清单

#### 🟡 [medium] 引擎层反向依赖前端 Pinia store：6 个生产文件 import src/ui/\*

- **位置**：src/sillytavern/bloodlines.ts:21, location-db.ts:26, random-tables.ts:20, agent-tools.ts:36, content-source.ts:27, database.ts:41（参照 map-runtime.ts:15）
- **问题与影响**：前四者均为 `import { getContentRegistry } from '../ui/stores/content-store'`，content-source.ts:27 引 `../ui/lib/media-hash`，database.ts:41 是 `import type { CreatePreset }`；被 import 的 content-store.ts:41-42 正是 pinia + vue。而 map-runtime.ts:15-19 的文件头明文禁止这种做法并为此专造了 installMapPack 注入缝。后果：madge 报的 32 条环里有 20 条由这条反向边织出，改 create-store 会牵动引擎模块初始化顺序，而这类时序 bug 只在真机出现；tsconfig include 是 `src/**/*.ts`，dist/ 里同时有 sillytavern/ 和 ui/，package.json 声称 `main: dist/sillytavern/index.js`、description 写「独立的引擎库」，实际不可独立消费（静态拖 pinia/vue）；多个引擎单测被迫 import 前端 store 做夹具。验证员核实 import 事实全部属实，但「无声长出来的违规」是夸大——location-db.ts:20-25 与 bloodlines.ts:14-16 的注释白纸黑字记录了这是 D16 时序契约下的已知例外及回翻方法；被迫依赖 store 的引擎单测实测为 5 个而非 8 个，database.ts:41 是 type-only 不产生运行时边，madge 数字未独立复跑，故降为 medium。
- **建议**：照 map-runtime.ts / engine-settings.ts 先例补一个引擎侧 `content-registry-runtime.ts`（installContentRegistry/getContentRegistry，模块级单例 + 空骨架兜底），由 content-store 在 setContentRegistry 时注入；media-hash 的纯函数下沉进 src/sillytavern/，CreatePreset 按「types.ts 唯一类型来源」移进 types.ts。

#### 🟡 [medium] 缺少守护分层方向的机器闸门：eslint 无 import 限制，tests 无 layering gate

- **位置**：eslint.config.js, tests/, 对照 src/sillytavern/map-literals-gate.test.ts
- **问题与影响**：`grep 'no-restricted-imports|import/no|boundaries' eslint.config.js` 零命中；tests/ 下 17 个顶层闸门（encoding-invariants / no-world-content / no-external-assets / theme-surface-ownership / knip-ratchet …）无一检查跨层 import 方向。而本仓明明把「用测试钉死架构约束」当常规手段（已有 4 类结构闸门）。项目已有 700 个源文件、多 agent 并行改码，AGENTS.md 写着的约定（引擎不读注册表、types.ts 唯一类型来源）目前完全靠 review 兜；症状不是报错，而是 madge 里悄悄多一条环，直到某次真机初始化时序炸掉。验证员核实事实全对，但指出这是「缺一道防护」而非既存缺陷，且被它挡的 6 处边本身是有注释的知情例外，故 high 降 medium。
- **建议**：在 eslint.config.js 对 `src/sillytavern/**` 加 `no-restricted-imports`（patterns：`@ui/*`、`../ui/*`、`vue`、`pinia`），清完 6 处后收成 error；另加 `tests/layering-gate.test.ts` 用 `?raw` 扫源码兜住动态 import 与字符串路径。

#### 🟡 [medium] content-store 两处裸 db.saves.put 绕过 saveSaveSlot，卸载路径还不刷新内存

- **位置**：src/ui/stores/content-store.ts:1162, content-store.ts:1481, src/ui/stores/game-store.ts:744
- **问题与影响**：装包路径（1157-1162）与卸载路径（1480-1482）都是 `save.metadata = writePackSelectionMetadata(...); await db.saves.put(save)`，既没走 database.ts:1446-1450 的 `saveSaveSlot()`（会统一 `updatedAt = Date.now()`），也没走 ADR-21 的 commitChatState。装包路径之后有 `await g.loadSaves()` 补刷内存，卸载路径（含整个 uninstallPack 1350-1455 与两个 UI 调用点）全程无任何刷新。于是卸载内容包后 game-store 的 `saves`/`activeSave` 仍持旧 metadata，紧接着任何一次 patchSaveMetadata（game-store.ts:738-745 `detach(current)` 后整份 saveSaveSlot 写回）都会把刚落库的 needs_selection 标记抹掉——用户卸载了包却再不会被提示重选世界书分区，且完全无声。ADR-21 的 P1-09 例外只授权 SaveProfile 的 focusQuest/news，SaveSlot.metadata 不在其中。验证员逐点核实全部成立，仅因触发需「卸载时恰有 activeSave 在内存 + 之后再发生一次 metadata patch」的条件链而降一级，缺陷本身确凿。
- **建议**：两处改调 `saveSaveSlot(save)`，并把装包路径末尾的 loadSaves 刷新提成公共尾巴供卸载路径复用；更彻底的做法是按 ADR-21 把 `metadata.enabledWorldBookEntries` 的写口统一收进 game-store.patchSaveMetadata，content-store 只发意图。

#### 🟡 [medium] BFF 路由前缀清单在 vite.config.ts 重复两份，两个端点仅存在于 dev 中间件

- **位置**：vite.config.ts:52, vite.config.ts:199, server/app.ts:44, src/ui/components/settings/WorldBookSection.vue:35, src/ui/stores/settings-store.ts:624
- **问题与影响**：configureServer（53-64）与 configurePreviewServer（199-211）逐字重复同一份 `/api/chat|status|models|embeddings|image` 五前缀白名单，权威清单在 server/app.ts:44-48 的五行 `app.route(...)`——三处手工同步，无一处派生。另外 vite.config.ts:114-115 的 `/api/worldbooks` 与 155-156 的 `/api/defaults` 只注册在 configureServer 且包在 `if (poemContentDir !== null)` 内，server/app.ts 与 preview 分支均无对应路由，但前端无条件 fetch（WorldBookSection.vue:35 PUT、settings-store.ts:624 PUT）。后果：加新 BFF 路由忘改 vite 两份白名单即「dev 404、代码看着正确」；世界书「保存为默认」与 agent-config 写回在 preview 与生产部署下必然 404。验证员核实三处同步关系与端点缺失无误，仅修正「点了没反应」略夸张——前端在 `!res.ok` 时会 toast「保存失败（状态码）」，其余影响成立。
- **建议**：从 server/app.ts 导出 `BFF_ROUTE_PREFIXES` 常量数组，app.route 与两处 vite 中间件都从它派生，并在 tests/server-app.test.ts 断言一致；`/api/worldbooks`、`/api/defaults` 要么迁进 server/routes 走同一条 hono 管道，要么在前端按环境禁用入口按钮。

#### ⚪ [low] content-source.ts 与 content-pack-plan.ts 构成运行时环，而两处 JSDoc 宣称依赖单向

- **位置**：src/sillytavern/content-source.ts:36, src/sillytavern/content-pack-plan.ts:23
- **问题与影响**：content-source.ts:36 值导入 `planPackInstall`（:575-582 是纯转发导出），content-pack-plan.ts:23-28 又值导入 content-source 的 hashContentDeterministic / hashWorldBook / validatePackOrThrow / PLACEHOLDER_UID_RESERVED_BASE，构成 madge #6 这条真运行时环。而 content-pack-plan.ts:12-13 的文件头写着「依赖边方向不变（planner 是 content-source 的消费者，不是反过来）」，与事实相反。实际消费方（content-store.ts:58/1234/1318-1319）都从转发口取、且调用都在函数体内，当前无 undefined 风险；主要代价是注释误导下一个重构者。
- **建议**：删掉 content-source.ts 里的 planPackInstall 转发（调用方直接取 content-pack-plan），或把共用 hash 工具抽成叶子模块 content-hash.ts；改完把那句反事实注释改正。

#### ⚪ [low] 引擎硬编码 /api/\* 与 /data/\* 端点路径，无注入缝

- **位置**：src/sillytavern/agent-client.ts:683, api-tools.ts:42, api-tools.ts:111, memory-store.ts:31, beautifier.ts:132, builtin-worldbooks.ts:35
- **问题与影响**：六处 fetch 分别硬编码 `/api/chat/completions`、`/api/models`、`/api/chat/test`、`/api/embeddings`、`/data/defaults/beautifier-rules.json`、`/data/worldbooks/${id}.json`（行号经复核精确）。前端侧同类路径已收成常量（image-client.ts:73/558-564），引擎侧一个都没有。这把引擎钉死在「宿主提供同源 /api 与 /data」的隐式契约上，与「独立引擎库」定位矛盾，且改 BFF 路由无编译期关联、只在运行时 404。验证员指出原文「唯一没有注入缝的跨层耦合」的断言与第一条自相矛盾，且同源 /api+/data 是 SPA 宿主常规契约、仓库无 Electron/子路径部署需求记录，属改进建议而非现存缺陷，降 low。
- **建议**：补 `src/sillytavern/http-endpoints.ts`（或扩展 engine-settings 注入缝）把六个路径提成常量并允许宿主注入 basePath，并与 server/app.ts 的路由常量共享同一来源。

#### ⚪ [low] types.ts 4022 行成为跨层 god module，前端大量 @engine 深路径直连

- **位置**：src/sillytavern/types.ts, src/sillytavern/index.ts, src/ui/components/game/MemoryPanel.vue, settings/DataSection.vue, home/HomePage.vue
- **问题与影响**：types.ts 4022 行为全仓最大源文件；`grep -ho '@engine/[a-z0-9-]*' src/ui` 统计 @engine/types 137 次、@engine/database 105 次，此后断崖降到 types-image 32 次。src/sillytavern/index.ts（24 行）零使用——全仓 grep `sillytavern/index` 与 `from '@engine'` 零命中，所有 UI 引用都走深路径。14 个 .vue 直接 import @engine/database，绕过 src/ui/AGENTS.md 定义的 lib/ 桥接层。types.ts 虽已按子系统拆出 types-audio/image/map/content/random-events，主干仍是 4000 行。验证员核实数字（database 应为 105 非 104，index.ts 应为 24 行非 10 行），并指出「137 个模块重编译致 HMR 明显变慢」是无度量支撑的推测、「UI 直连 Dexie」属风格债无正确性后果，故降 low。
- **建议**：短期把 .vue 里的 @engine/database 直连收进对应 store 或 lib/ 桥接模块（先例：usePresets composable）；中期按已有分册思路继续切 types.ts（types-agent / types-combat / types-save），主干只留跨子系统共享的核心实体。

#### ⚪ [low] SettingsPage.engine-imports.test.ts 是手工维护的文件表，自述「忘了加不会红」

- **位置**：src/ui/components/settings/SettingsPage.engine-imports.test.ts:24
- **问题与影响**：该测试文件头 22-26 行自承「本测试扫的是一张文件表，新分区若也用动态导入，往 SOURCES 里加一行——忘了加不会红」；47-49 行的 `SOURCES` 实际只有 DataSection.vue 一项，而注释自己列举的 agent/PresetManager、agent/AgentConfigPanel 等调用点并不在表内。它挡的洞（`await import('@engine/database')` 解构名拼错，clearAll 解构 deleteDatabase 而实际导出 clearAllData）真实咬过一次；同文件也承认 typecheck:vue 现已能覆盖 SFC 解构。属于「看着有网、实际有洞」，仍在制造有测试即安全的错觉。
- **建议**：把 SOURCES 改成 `import.meta.glob('@ui/components/settings/**/*.vue', { as: 'raw', eager: true })` 全量扫描；或确认 typecheck:vue 在 CI 稳定覆盖后直接删掉这条测试，别留半张网。

## 5. 类型安全与 TypeScript 质量

### 总评

这个维度整体健康度偏高，属于「地基扎实、边角漏风」的形态。三道 typecheck 闸门（`tsc --noEmit` / `vue-tsc --noEmit` / `tsc -p tsconfig.tools.json`，末尾再补 `npm run build`）齐全且本地实跑全绿，`@ts-ignore` 全仓 0 处、`@ts-expect-error` 仅 2 处且都是测试里的正当用法，128 个 SFC 里运行时式 props 声明 0 处——这些指标在同规模项目里属于上游水平。真正的问题不在「写得烂」，而在两类系统性缺口：一是 `as any` / `Record<string, any>` 把几条关键契约（`StatePatch.value`、`AgentContext` 运行时槽位、`var-resolver` 变量树）留在编译器视野之外，让键名错配这类缺陷只能靠真机游玩发现；二是类型网的边界有洞——`public/engine-ejs.d.ts`（480 行对外契约）与 `scripts/nai-regression-smoke.ts` 落在所有 tsconfig 之外。最值得先做的其实是成本最低的一件：四个严格开关实测当前 0 error，属于白捡的回归防护。

### 量化底账

- 三道 typecheck 当前全绿（本地实跑 exit 0）；扫描 src 下 697 个 TS/Vue 源文件（含 128 个 .vue）、server/ 7 个、tests/ 17 个、scripts/ 8 个。
- 逃逸口（非测试 src）：`as any` 74 处 / 28 个文件（CharacterListPanel.vue 14、game-pipeline.ts 9、create-store.ts 5）；`: any` 注解 185 处；`as unknown as` 全仓 193 处（非测试 54）；`Record<string, any>` 192 vs `Record<string, unknown>` 194，口径各占一半。
- 严格开关实测（临时 probe，已删除，未改动仓库）：`noFallthroughCasesInSwitch` + `noImplicitOverride` + `noImplicitReturns` + `useUnknownInCatchVariables` 合计 **0 error**；`noUnusedLocals`+`noUnusedParameters` 18；`exactOptionalPropertyTypes` 273；`noUncheckedIndexedAccess` 2765（非测试 480）。
- 类型组织：src 非测试导出 869 个 interface/type，`types.ts`（4022 行）+ 5 份 `types-*.ts` 承载 271 个；重名导出类型 6 组。

### 亮点

- CI 的 types job 三 project 串联覆盖 src / SFC 模板表达式 / server+tests+config，末尾补 `npm run build` 兜住 tsc 不解析的资源导入，workflow 注释里写清了 TEST-01 的理由。
- Vue 组件类型化接近满分：70 个 `defineProps<T>()`、49 个 `defineEmits<T>()`，运行时数组/对象式声明 0 处，props 带 `any` 的仅 PlotOutlinePreview.vue 一个。
- 抑制注释纪律干净：`@ts-ignore` 0 处，`@ts-expect-error` 仅 useManualSceneImage.test.ts 两处且带中文理由（断言「就是要编译不过」），`eslint-disable` 仅 5 处全带理由。
- ESLint 开了类型感知档（`no-floating-promises` / `no-misused-promises` / `await-thenable`）并同时挂两份 tsconfig 以覆盖 server/tests（eslint.config.js:44-48 注释说明少挂一个会整片解析报错），配 `--max-warnings 0` 是真闸门。
- 枚举集中定义执行得好：field-enums.ts 用 `as const` 派生类型，types.ts:2416 把 `QualityLevel` alias 到 `Rarity`，QUALITY_RANK / QUALITY_BY_RANK / quality-colors.ts:38 的调色板全部从 `RARITY_LEVELS` 派生。
- AI JSON 输出有统一安全出口：plot-engine.ts 的 `parseModelJson<T>(raw, normalizer)` + `asArray<T>()` 收口了历史缺陷，并在注释里完整记录 Q-05 事故经过。
- 类型拆分规则明确且被遵守：types.ts 为唯一数据模型来源，types-audio / content / image / map / random-events 按子系统拆分，image 那册刻意不 import types.ts 以免依赖成环。

### 问题清单

#### 🟡 [medium] StatePatch.value 是 any，30+ 个 op 的载荷契约靠消费端各自断言维系

- **位置**：src/sillytavern/types.ts:1785、src/sillytavern/state-manager.ts:744 / :949 / :1203、src/sillytavern/vars-update-translator.ts:395
- **问题与影响**：`StatePatch { op: StatePatchOp; value?: any }` 而 `StatePatchOp`（types.ts:1742）是 33 个成员的联合，消费端逐 op 手写断言约 20 处（`as Partial<StatusEffect>`、`as { name?; to?; quantity? }`、`as CharacterState`）。ADR-21 把 `commitChatState()` 定为唯一写入入口，但这个入口的载荷无编译期约束：生产端写错键名（`qty` vs `quantity`、`changes` 漏层）照样编译通过。plot-engine.ts:186-193 的 Q-05 注释记录过同形态事故（无守卫断言 → TypeError → 被 catch 吞成 warn → 链路静默空转）。验证员核实事实全对，但打两处折：`add_character` 并非「零校验」（:1202-1209 就 throw 缺 id / 空 name，各 apply* 普遍有运行时守卫，失败是显式 throw 而非静默），且未指向任何现存 bug，属设计层弱点，降为 medium。
- **建议**：把 `StatePatch` 改成按 `op` 判别的可辨识联合，先覆盖载荷最复杂的 add_item / update_item / transfer_item / equip_item / add_character / rename_character / update_plot_event，其余落 `{ op: Exclude<...>; value?: unknown }` 兜底；消费端由 `as` 改为 switch 收窄。

#### 🟡 [medium] CharacterListPanel.vue 对已完整建模的 CharacterState 打了 14 处 `as any`

- **位置**：src/ui/components/game/CharacterListPanel.vue:68 / :70 / :222 / :311 / :395 / :421
- **问题与影响**：`selected` 来自 `game.npcs`（game-store.ts:84 明确为 `CharacterState[]`），组件却写成 `(selected.value as any)?.inventory`、`?.skills`、`(selected as any)?.statusEffects`、`(selected as any).customFields?.age`，而 types.ts:1032-1034 已声明 `skills` / `inventory` / `statusEffects` 三者必填、:1070 声明 `customFields`。访问路径全部退化为 any，`selEquipment` 元素类型丢失后下游还要再断言一次（:74/:76）；字段拼写错误或被 M1-M6 迁移重命名都不报错，只在真机上渲染空白。这是全仓非测试 74 处 `as any` 里最扎堆的单文件（14 处）。验证员逐行核实全部属实、计数精确，仅因是纯类型侵蚀、无现存功能缺陷且集中于展示型组件，由 high 降为 medium。
- **建议**：直接删掉这 14 处 `as any`（`selected` 本就是 `CharacterState | null`，可选链足够），`filter((i: any) => ...)` 形参标成 `InventoryItem`；改完 tsc 报的错就是真实字段漂移。顺手清理 create-store.ts:727-729 的 `(item as any).requiredRace`。

#### 🟡 [medium] 「types.ts 唯一类型来源」纪律有四处破口：逐字复制、同名异形、新旧并存

- **位置**：src/sillytavern/types.ts:3371 / :3394 与 src/sillytavern/craft-gen-chain.ts:122 / :145；src/ui/stores/settings-store.ts:89 与 src/sillytavern/types-content.ts:53；src/sillytavern/types.ts:2245 与 src/sillytavern/combat-v3/types.ts:571；src/sillytavern/content-source.ts:74 与 src/ui/stores/content-store.ts:668
- **问题与影响**：① `CraftGenOutput` / `ItemRequest` 逐字段存在两份，types.ts:3368 注释直言「与 craft-gen-chain.ts 中的定义保持一致」——靠人肉同步。② `AgentProjectDefaults` 同名异形：types-content.ts:53 是单 agent 的 13 字段，settings-store.ts:89 是 `{ version; agents: Record<string, AgentDefaultEntry> }`，auto-import 会挑错文件且 IDE 提示不区分（验证员补充：types-content.ts:44-50 注释已自承是 T1 权宜、待 T8 收口，属已知待办）。③ 已退役的 v2 `CombatState` 仍被 game-store.ts:95 的 `activeCombat` 使用，与 :99 的 v3 并存。④ `ContentFetchReport` 引擎与 UI 各一份同形声明。同形重复的漂移不会被编译器发现，直到形状真分叉才在断言处炸。
- **建议**：craft-gen-chain.ts 两个类型改为从 './types' 重导出（调用方零改动）；settings-store.ts 的 `AgentProjectDefaults` 改名（如 `AgentDefaultsFile`）并注释指向 types-content.ts；types.ts:2245 的 v2 `CombatState` 加 `@deprecated` 并规划把 `game-store.activeCombat` 收敛到 v3。

#### 🟡 [medium] tsconfig 缺 4 个「当前零成本」的严格开关，白放弃回归防护

- **位置**：tsconfig.json
- **问题与影响**：仓库只开了 `strict: true`。实测同时打开 `noFallthroughCasesInSwitch` + `noImplicitOverride` + `noImplicitReturns` + `useUnknownInCatchVariables` 报 **0 error**，却能永久拦住「switch 漏 break」「override 拼错方法名」「分支忘 return」「catch 变量当 Error 用」四类回归——而 state-manager 的 30+ op switch 分派与大量 Agent 输出解析恰是这些缺陷的高发地。`noUnusedLocals`+`noUnusedParameters` 仅 18 处；`noUncheckedIndexedAccess` 非测试 480 处里混着真实空数组/缺键风险（如 char-gen-agent.ts:723 `const block = blockMatch[1]` 后 :726 直接 `block.split('\n')`），热点 agent-settings.ts 35 / char-gen-agent.ts 33 / random-event-scheduler.ts 25 / plot-outline.ts 25。验证员用独立 probe config 复现了「零成本」结论（probe 走 tsc 不含 .vue，vue-tsc 侧未验，但 SFC 逻辑量小、方向不变）。
- **建议**：立刻把四条零成本开关加进 tsconfig.json，顺带清完 18 处未使用局部/参数；`noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes` 量大，照 `knip-ratchet.mjs` 先例按目录设「只许变少」的棘轮。

#### 🟡 [medium] public/engine-ejs.d.ts 是 480 行创作者契约，却不进任何 tsconfig、也无测试绑定

- **位置**：public/engine-ejs.d.ts、src/sillytavern/ejs-capabilities.ts:406 / :431、tsconfig.json
- **问题与影响**：tsconfig.json include 为 `src/**`，tsconfig.tools.json 为 `server/** tests/** *.config.ts src/env.d.ts`，这份 480 行 d.ts 不在任一 project 内，全仓仅三处注释提到它（ejs-capabilities.ts:402、ejs-preflight.ts:297、ejs-runtime.ts:668），无 import、无测试引用。实现侧 `projectQuest(name, q): Record<string, any>`、内部 `q as unknown as Record<string, any>`、返回中文键字面量——对外承诺的能力面与实现之间没有任何编译期或测试期联系。ejs-capabilities.ts:397-403 的注释亲口记录过一次同类事故（曾投 `description`/`objectives`/`rewards`，引擎根本没这些字段，创作者永远拿到空值），同样的漂移可以再发生一次而 CI 全绿。
- **建议**：把 engine-ejs.d.ts 纳入 tsconfig.tools.json 并在 tests/ 加编译期断言（`const _c: EjsQuestProjection = projectQuest(...)`）；或反过来让实现 `import type` 这份 d.ts 作为返回类型注解，把 `Record<string, any>` 换成具名类型。

#### 🟡 [medium] field-enums 建了枚举类型却没用在字段声明上：内联重写联合 + 注释里的枚举

- **位置**：src/sillytavern/types.ts:879 / :880 / :881 / :993 / :1046 / :1994、src/sillytavern/field-enums.ts:12
- **问题与影响**：field-enums.ts 已有 `EQUIP_SLOTS/EquipSlot`、`ITEM_TYPES/ItemType`、`RARITY_LEVELS/Rarity`，但 `InventoryItem` 三个字段全绕过：`equippedSlot?: string | null`（注释写「EQUIP_SLOTS 枚举值」）、`type?: string`（注释是英文值，而 ITEM_TYPES 为 `['装备','消耗品','材料','任务物品','特殊']`，验证员发现 char-gen-agent.ts:367 实际写入中文，注释与实际写入值也对不上，比原 finding 更糟）、`rarity` 把 RARITY_LEVELS 手抄一遍——恰恰是 types.ts:2405-2416 Q-11 注释声称「加第八级品质不可能漏」的反例。另有 9 处「联合写在注释里、类型是 string」（tierName:993、adventurerRank:1046、HitRating.level:1994 等）。`normalizeSlot()` 返回 `EquipSlot | null`，赋给 `string | null` 字段后窄类型当场丢弃，下游只能再校验一次。
- **建议**：`rarity` 改 `Rarity`、`equippedSlot` 改 `EquipSlot | null`、`type` 改 `ItemType`（并统一到中文与 ITEM_TYPES 对齐）；至少把 tierName / adventurerRank / HitRating.level 提成 field-enums 的 `as const` 派生类型，改完 tsc 报出来的就是真实枚举越界写入。

#### ⚪ [low] AgentContext 的 `as any` 逃逸口写读键名不一致（死占位符里的死键名）

- **位置**：src/sillytavern/context-visibility.ts:272 / :280 / :288、src/ui/lib/game-pipeline.ts:941、src/sillytavern/agent-templates.ts:347
- **问题与影响**：消费端读 `(ctx as any)._plotOutline` / `_craftProjects` / `_activeCombat`，而生产端 game-pipeline.ts:941 写的是无下划线的 `plotOutline`；全仓 grep 带下划线的三个键只有那三行、无任何写入方。两侧都用 `as any`，编译器与 vue-tsc 都看不见这个错配。验证员核实键名错配属实，但影响被大幅夸大：context-visibility.ts:793-797 的墓碑注释说明 buildZoneSection/wrapZoneSection 已删除、现役 zone 注入面只剩 placeholder-registry 的 `{{CHARACTER_STATE}}`，实测 placeholder-registry.ts:484-489 只对 zones.npc 调 filterZoneContent，craft/combat/outline 三个 zone 的 content 无任何消费点，formatCraft*/formatCombat*/formatOutline* 全是未接线的死函数；大纲另有活路（agent-templates.ts:346-347 读无下划线版，经 buildPlotContextBlock:584 注入 `<剧情大纲>` 块）。故不存在「Agent 拿不到大纲」，属整洁性问题，high → low。
- **建议**：把 `plotOutline` / `craftProjects` / `activeCombat` 声明为 `AgentContext` 的正式可选字段（或独立的 `AgentContextRuntimeSlots` 接口 extends 上去）并删掉两侧 `as any`；同时评估直接清理这三段无消费点的死代码。

#### ⚪ [low] scripts/nai-regression-smoke.ts 落在所有 tsconfig 之外，没有任何类型网

- **位置**：scripts/nai-regression-smoke.ts、tsconfig.json、tsconfig.tools.json
- **问题与影响**：实测 `tsc -p tsconfig.tools.json --listFilesOnly | grep scripts/` 只列出 build-placeholder-hashes.d.mts 与 knip-ratchet.d.mts（经 import 被动带入），这个 96 行脚本缺席，CI 的 types job 跑的正是这三个 project。tsconfig.tools.json 注释自称「主 tsconfig 只 include src/**，这一步是它们唯一的类型网」，可见意图是覆盖非 src 的 TS，只是漏了 scripts/。验证员确认事实全对，但因它是开发者手动跑的 NovelAI 回归冒烟脚本、不进产物也不进 CI，坏了只影响手动排障，medium → low。
- **建议**：tsconfig.tools.json 的 include 补 `"scripts/**/*.ts"`（顺带 `*.d.mts`），确认 0 error 后合入；eslint.config.js 的类型感知规则块 files 也加上 `scripts/**/*.ts`。

#### ⚪ [low] 变量系统核心 var-resolver 全面 `Record<string, any>` + `any` 返回

- **位置**：src/sillytavern/var-resolver.ts:79 / :97 / :132、src/sillytavern/context-visibility.ts:292
- **问题与影响**：`getVar(variables: Record<string, any>, path: string): any`，`setVar` / `delVar` / `insertVar` 同样是 `Record<string, any>` 进出。`any` 会沿调用链向外传播（返回值可赋给任何类型且不报错），而 `unknown` 只需在使用点收窄一次；变量树正是 ADR-30 里 AI 与 EJS 双写的共享空间，最该在读取点强制收窄。全仓非测试 `Record<string, any>` 192 vs `Record<string, unknown>` 194，两种口径各占一半（热点 context-visibility.ts 26 / var-resolver.ts 20 / types.ts 18）。验证员逐项核实签名与计数完全一致，判为渐进改进项而非现存缺陷。
- **建议**：先把 `getVar` 返回值改 `unknown`、再把容器改 `Record<string, unknown>`，调用点用类型守卫收窄；同时在约定文档里定「新代码一律 `Record<string, unknown>`，用 `any` 需注释理由」。

#### ⚪ [low] 三份重复的 deepClone 实现，各自带同款 `as unknown as T` 断言

- **位置**：src/sillytavern/ejs-runtime.ts:476、src/sillytavern/ejs-capabilities.ts:119、src/sillytavern/agent-templates.ts:108
- **问题与影响**：三处各有一份十行深拷贝，共贡献 11 处 `as unknown as`；它们服务 EJS 求值与模板装配两条相邻链路，行为分叉不会被编译器察觉。验证员核实重复属实但两点站不住：三份**已经分叉**（ejs-runtime 版带 WeakMap 环检测 + Date 分支，agent-templates 版有 Date 无环检测，ejs-capabilities 版两者皆无且容器用 `Record<string, unknown>`），且 agent-templates.ts:102-104 注释明写「不跨模块耦合，各留一份十行实现」——是有记录的刻意取舍而非无意复制，判 partly，severity 维持 low。
- **建议**：若要合并，抽 `src/sillytavern/deep-clone.ts`（单一实现 + 单一断言点 + 单份测试）三处 import；否则至少在三份注释里互相交叉引用，标注已知的语义差异（环检测 / Date 支持）。

## 6. 测试质量与覆盖

### 总评

这个维度整体处于**高健康度但有系统性盲点**的状态。测试体量与配套率都属优秀：8303 个 `it` 块、19581 处 `expect`、130703 行测试代码，引擎层 `src/sillytavern/` 与 `src/ui/{lib,stores,composables}` 的模块配套率近乎 100%，机器扫描后人工复核确认**真正的无断言测试为 0**，无条件 `it.skip` 全仓仅 1 条。更难得的是仓库把「测试基础设施」本身当工程对象对待——顶层闸门测试（编码不变式、knip 棘轮、战斗确定性）都带着「为什么值得单开」的踩坑记录，`vitest.config.ts` 的并发调优带实测表。最要紧的缺口是**度量层缺位**：全仓没有任何覆盖率工具或阈值配置，导致「有测试文件」与「关键分支被测」之间的差距无法被观测，AGENTS.md 里「每个新模块必须配套 `*.test.ts`」是全仓唯一靠人工纪律维持的约定。其次是若干**闸门自身会静默失效**的设计问题（提示词契约测试的 `continue` 路径、368 处 `as any` 放弃类型闸门），这类问题不会红，只会悄悄缩小防护面。UI 组件层与 BFF 服务端存在局部空白，但都伴随着扎实的 store 层/路由主干覆盖，属可控。

### 量化底账

- 扫描面：src 非测试 TS 250 个 + Vue 128 个，配套 `*.test.ts` 319 个，`tests/` 顶层闸门 16 个，server 7 文件、scripts 8 文件、CI 1 条工作流。
- 用例：`it(` 8303 个（src/sillytavern 5711 / src/ui 2450 / tests 177），`expect(` 19581 处。
- skip：全仓 `it.skip/describe.skip` 仅 4 处，其中 2 处是环境变量条件门。
- mock：`vi.mock` 出现在 68/335 个测试文件，密度克制；fake-indexeddb 经 `src/test-setup.ts` 全局注入，抽查未发现跨用例串档。
- 闸门抽跑：`tests/knip-ratchet.test.ts` + `tests/theme-fonts-invariant.test.ts` 通过（22 passed / 861ms）；CI 三 job 并行（types/quality/test）。
- 覆盖率：`coverage` 在 package.json、vitest.config.ts、ci.yml 中**零命中**。
- 属性测试：fast-check 仅 5 个文件、43 处 `fc.assert`。

### 亮点

- 引擎层配套率近乎 100%：`src/sillytavern/` 250 个非测试 TS 中缺同级测试的只有 combat-v3 的 phases/ 与 types.ts/index.ts/test-utils.ts；`src/ui/lib`、`src/ui/stores`、`src/ui/composables` 三个逻辑目录零缺口。
- 无断言测试实质为零：8303 个 `it` 块机器扫描命中 25 处疑似，逐条复核全部是 `expectErrAt`（combat-v3/automata/parser.test.ts:58）、`expectCropError`（src/ui/lib/image-crop.test.ts:302）这类断言辅助函数的假阳性。
- 顶层闸门设计突出且自带踩坑记录：`tests/encoding-invariants.test.ts` 把手工编码命令变成 raw+parsed 双遍断言并自陈已知缺口；`tests/knip-ratchet.test.ts` 用「身份」而非「计数」比对基线并为 `duplicates` 的形状差异写了回归用例；`combat-v3/no-nondeterminism.test.ts` 用 `import.meta.glob('?raw')` 扫源码钉死禁用 `Math.random`/`eval`。
- mock 有边界说明：`src/ui/lib/game-pipeline.test.ts:85` 明确写出「store 本身另有测试，这里只关心有没有把标记喂给 generate」，避免 mock 过度导致的空转断言。
- DB 隔离正确：`src/ui/stores/scene-image-store.test.ts:137` 用 `afterEach(clearAllData)` + `beforeEach(setActivePinia)` 双清，`src/sillytavern/database.test.ts:2257` 显式销毁再建库来测版本迁移。
- 跨仓契约测试降级设计正确：`tests/contract/pack-install.contract.test.ts:27` 用 `PACK_FILE ? describe : describe.skip` 反转依赖方向，公开 CI 跳过、私有 CI 设 `POEM_PACK_FILE` 后真跑，而不是把私有内容拖进公开仓。
- `vitest.config.ts` 的 `maxWorkers` 上限带 16/8/4 worker 的实测对比表，并明确拒绝「调高 testTimeout 掩盖问题」。

### 问题清单

#### 🟡 [medium] 全仓无覆盖率工具与覆盖率闸门

- **位置**：package.json、vitest.config.ts、.github/workflows/ci.yml
- **问题与影响**：`grep -n coverage` 三文件零命中；scripts 只有 `"test": "vitest"` / `"test:run": "vitest --run"`（package.json:24-25），devDependencies 无 `@vitest/coverage-v8`/`c8`/`istanbul`，vitest.config.ts:66-72 的 test 块仅 environment/include/setupFiles/globals/maxWorkers 五键。后果有二：AGENTS.md「每个新模块必须配套 `*.test.ts`」成为全仓唯一无 CI 背书的约定，漏写不会红；「有测试文件」不等于「关键分支被测」，缺少度量就无法发现空洞。验证员核实各项属实，但指出「最大盲点」的说法夸大——仓库已有 encoding-invariants / knip:ratchet / no-world-content / no-nondeterminism 等大量替代性结构闸门，且这是工具缺位而非已证实的覆盖空洞，故由 high 降为 medium。
- **建议**：装 `@vitest/coverage-v8` 并配 `test.coverage`（`provider:'v8'`、`include:['src/**','server/**']`、排除 `*.test.ts`/`test-utils.ts`）；**先不设行覆盖率阈值**，改照本仓棘轮范式把首次报告存为 `coverage-baseline.json` + `scripts/coverage-ratchet.mjs` 只断言不低于基线，挂进 CI quality job。另补一条极便宜的结构闸门：扫 `src/sillytavern/**` 与 `src/ui/{lib,stores,composables}/**`，缺同名测试的文件列入只许变短的白名单。

#### 🟡 [medium] combat-v3 phases/ 目录（2084 行）缺同名单测，伤害分支矩阵无系统覆盖

- **位置**：src/sillytavern/combat-v3/phases/attack.ts（982 行）、unit-turn.ts(341)、round.ts(259)、action.ts(237)、outcome.ts(145)、initiative.ts(120)
- **问题与影响**：这六个文件**均无同名 `.test.ts`**，该目录仅有 phases.test.ts(250) / preview.test.ts(248) / spawn.test.ts(288) / terminal.test.ts(143) 四份。attack.ts 导出三个函数（:105 `handleAttack`、:573 `resumeBlockedAttack`、:902 `isAttackTargetLegal`），全仓无测试直接调用它们。attack.ts 是「战斗伤害怎么算」的唯一真源，也是真机 debug 反复回归的热点（「战斗真机 debug 8 项修复」「火球术伤害」「骰池续骰中断」都落在这条链上）。验证员核实文件清单与行号属实，但推翻两处关键结论：preview.test.ts(248 行) 实际就是一份专打 attack.ts 的套件，其 describe 分组覆盖 A3-6 无订阅者不暂停 / A3-5 冻结 frame / DeclareBlock 回到 damage.compute 重算 / Q-21 格挡重算沿用冻结 damageType，断言就在同一文件（:138/:196/:228），并非「断言在别的文件里」；且 `handleAttack`/`resumeBlockedAttack` 只被 reducer.ts:50 引用，经 `reduce()` 驱动本就是合理单元边界；`isAttackTargetLegal` 全仓零调用方，是死导出。剩余成立的部分是各伤害类型/免疫/减伤的分支矩阵确实缺系统覆盖，故降为 medium。
- **建议**：优先补伤害类型/免疫/减伤的分支矩阵测试（用同目录现成 `test-utils.ts` 造 CombatState），并为 unit-turn.ts / round.ts 各补一份回合推进单测；`isAttackTargetLegal` 应考虑直接删除而非补测。

#### 🟡 [medium] 捏人页 create/ 与首页 home/ 组件层几乎空白，而 7d 正在改造中

- **位置**：src/ui/components/home/HomePage.vue(1498)、src/ui/components/create/CreatePage.vue、CreateStepBasic.vue(520)、CreateStepPlot.vue(678)、CreateStepSelections.vue(339)、src/ui/components/settings/WorldBookEditor.vue(909)
- **问题与影响**：按「组件名是否在任何 `*.test.ts` 中被提及」统计，**36 个 .vue 从未被任何测试引用**，体量前列包括 HomePage.vue(1498)、AudioLibrary.vue(983)、WorldBookEditor.vue(909)、AssetLibrary.vue(700) 等。分区看，`create/` 30 个文件只有 6 份测试，`home/` **一份都没有**。AGENTS.md 进度表标注 7d「🔄 世界书驱动改造中」——正被改的部分恰好是组件测试最薄处；HomePage.vue 是应用唯一入口（环境检测/用户协议/存档管理），WorldBookEditor.vue 出错会污染 Dexie 数据。相对地 store 层测得扎实（create-store.test.ts 2047 行），缺的是**组件契约**而非业务逻辑。
- **建议**：不必给 36 个组件都补，按风险补三类：CreatePage + 三个 Step 的步骤流转与「下一步可用」守卫；HomePage 的环境检测分支与「未同意协议不得进入」；WorldBookEditor 的保存/取消不产生脏写。仓库已有 62 个文件的 `@vue/test-utils` + jsdom docblock 成熟范式（抽查零遗漏），照抄即可。

#### 🟡 [medium] 提示词契约闸门会「静默消失」：措辞一改用例直接不生成，CI 照绿

- **位置**：tests/agent-tools-prompt-contract.test.ts:42、tests/memory-summary-prompt-contract.test.ts:34
- **问题与影响**：`tests/agent-tools-prompt-contract.test.ts:42` 在注册 `it()` 之前先过滤 `if (!prompt.includes('可用工具')) continue;`，实测 `public/data/defaults/agent-config.json` 的 13 个 agent 中只有 4 个命中（craft_gen / char_gen / item_gen / combat_v3），该闸门实际只管 4 条。工具名提取还钉死在格式上（:28-34：从「可用工具」截到空行或 `\n#`，再用 snake_case 正则）。这两条闸门守的都是「不红但坏」的真机 bug 回归（char_gen 广告白名单外工具导致模型放弃全部工具、memory_summary 被教「留空」导致记忆被丢弃），但闸门自身也是「不红但坏」：改标题或去掉空行会让用例不注册，`expect(advertised.length).toBeGreaterThan(0)` 只兜住空小节，`continue` 路径**无任何兜底**，用例数从 4 掉到 3 不会有信号。验证员核实数字精确，仅行号有偏差（memory-summary 那句 `toContain` 在 :34 非 :31），且该文件已存在负向断言（:27-29）。
- **建议**：把管辖范围从提示词文本挪进显式常量（取自 `AGENT_TOOL_MAP` 中白名单非空的 agent），无条件注册用例、找不到「可用工具」小节直接 fail；memory-summary 把 `toContain` 换成语义正则降低措辞耦合。

#### 🟡 [medium] BFF 服务端 models/embeddings 路由零覆盖，proxy 的 SSRF/502/剥头分支无断言

- **位置**：server/routes/proxy.ts:81/97/119、server/routes/models.ts、server/routes/embeddings.ts、tests/server-app.test.ts
- **问题与影响**：tests/server-app.test.ts 共 377 行、20 个用例、五个 describe 分组（origin boundary / response encoding / image passthrough / ComfyUI passthrough / base URL 规范化 SEC-09），且全仓再无第二份 server 测试。proxy.ts 三处关键分支无用例：SSRF 黑名单 403（`grep 'SSRF\|169.254'` 零命中）、fetch 失败→502（含从 `e.cause.code` 拼真因的字符串拼接，正是易写错又不会被察觉的逻辑）、`stripHopHeaders` 对 `content-length`/`connection`/`keep-alive` 的剥离（只有 content-encoding 被 Brotli 用例覆盖）。验证员核实核心成立，但推翻标题的一部分：`/api/chat` **并非零覆盖**——server-app.test.ts:49 有一次 `request('/api/chat/completions', {stream:false})`，非流式路径已覆盖，真正零覆盖的是 models 与 embeddings；行号亦有偏差（`streaming` 判定在 :97 非 :105，且实际还排除 HEAD）。SSE 流式请求体转发仍无用例，出问题只能真机发现。
- **建议**：照已有的「node:http 假上游」脚手架（tests/server-app.test.ts:28-68）补：`/api/chat` 带 `stream:true` 的字节级透传断言、上游 socket destroy → 502 且 body 含 cause code、`stripHopHeaders` 纯函数单测、`X-Target-Base-URL: http://169.254.169.254` → 403。

#### 🟡 [medium] 测试桩里 363 处 `as any` 绕开类型检查

- **位置**：src/ui/lib/game-pipeline.test.ts（118 处）、src/sillytavern/state-manager.test.ts(40)、item-gen-chain.test.ts(24)、game-pipeline.side-chain-abort.test.ts(17)
- **问题与影响**：实测 `as any` 在测试文件中共 **363 处**（摘要原写 368）、分布 37 个文件，而 `@ts-expect-error` 全仓测试只有 2 处——说明是刻意选 `as any` 而非受控豁免。tsconfig.json:26 的 include 覆盖 `src/**/*.ts`，测试本进 typecheck，`as any` 等于主动放弃这道闸门。game-pipeline.test.ts 是 2097 行的主管线核心测试，118 处 `as any` 意味着它构造的 gameStore / AgentResult / snapshot 桩对象完全不受类型约束：依赖接口改字段名或加必填字段时 `tsc --noEmit` 与 `vue-tsc` 都不报错，测试继续绿着验证一个已不存在的契约——文件内 :105-106 的注释「桩里漏了这一格，7 条既有用例会一起变红」记录的正是这类踩坑（那次运气好在运行期红了）。另有私有成员刺穿（side-chain-abort.test.ts:97 `(pipeline as any).getClientFactory()`、:112 `(pipeline as any).abortController = controller`）把内部字段名变成事实公开契约。
- **建议**：数据桩改用 `satisfies` / `Pick<T,...>` 让字段名写错立刻在 typecheck 红；私有刺穿改为在被测类上开显式测试注入点（构造函数可选参数传 abortController / clientFactory）。可先只治 game-pipeline.test.ts（占全仓约三分之一），并对 `**/*.test.ts` 加 `no-explicit-any` 的 warn + baseline 棘轮。

#### ⚪ [low] 属性测试面偏窄：43 处 `fc.assert` 全集中在图像与地图

- **位置**：src/sillytavern/image-anlas.property.test.ts(8)、image-prompt.property.test.ts(11)、image-quota.property.test.ts(10)、src/ui/lib/crop-rects.property.test.ts(8)、src/sillytavern/map-path.test.ts(6)
- **问题与影响**：fast-check 只出现在 5 个测试文件，`fc.assert` 合计 43 处（map-path 的 6 处还共用同一个 `queryArb`）。而天然适合属性测试的纯函数域一个都没用上：`combat-v3/dice-tape.ts`（种子化骰带，`no-nondeterminism.test.ts` 已钉死其确定性）、`resource-calc.ts`/tier 数值公式（T1-T7 乘数表可交叉验证、属性上限 20 是硬约束）、`random-event-scheduler.ts`（ADR-32 的 MTTH 调度，1062 行测试全是例子）。这些域「输入空间大、不变式好写、失败样例难手工构造」，属性测试能覆盖例子测试测不出的性质（如「频率调高后期望触发数单调不减」）。验证员核实数字精确，但指出 finding 自己也承认「这不是缺陷而是杠杆没用满」，且这几个域已各有数百至千行例子测试兜底，故由 medium 降为 low。
- **建议**：按投入产出比补三处 property 文件——dice-tape 的种子决定论 + 续骰可加性 + 骰值落域；resource-calc 的单调性与上限钳制；random-event-scheduler 的「available 不满足则永不入池」「冷却期内候选池不新增」。以 image-quota.property.test.ts 为写法样板。

#### ⚪ [low] vitest 未开全局 clearMocks，34 个用 mock 的文件靠人工纪律清状态

- **位置**：vitest.config.ts:66-72、src/sillytavern/agent-client.test.ts、combat-v3/coordinator.test.ts、src/ui/components/game/GamePage.test.ts
- **问题与影响**：test 块只有五个键，无 `clearMocks`/`mockReset`/`restoreMocks`，`src/test-setup.ts` 也只有一行 fake-indexeddb import、无全局 afterEach。实测 `vi.fn(`/`vi.mock(` 出现在 **92** 个测试文件（摘要写 104），其中既无 `*AllMocks` 也无 `mockClear/mockReset/mockRestore` 的有 **34** 个（摘要写 36），其中 18 个同时用了 `toHaveBeenCalledTimes`/`toHaveBeenCalledOnce`。当前无实际 bug——抽查的 game-pipeline.side-chain-abort.test.ts:101-106 确实手写 beforeEach 逐个清容器。风险在于靠纪律：新增用例时忘记把新 spy 纳入手写重置清单，症状是后一条用例把前一条的调用计数算进来，随用例顺序漂移、排查成本高。
- **建议**：在 vitest.config.ts 的 test 块加 `clearMocks: true`（只清调用记录不动实现），加完全量跑一次确认无回归；不要同时开 `mockReset`（会清掉工厂默认实现）。

#### ⚪ [low] 五份测试文件超过 2000 行，单文件承载过多关注点

- **位置**：src/sillytavern/state-manager.test.ts(4245)、combat-v3/coordinator.test.ts(3365)、database.test.ts(2354)、src/ui/stores/asset-store.test.ts(2161)、src/ui/lib/game-pipeline.test.ts(2097)
- **问题与影响**：加上 agent-orchestrator.test.ts(2072) 与 create-store.test.ts(2047)，七个文件占 18341 行，为全部测试代码 130703 行的 14%。三重成本：vitest 按**文件**分配 worker，4245 行的文件是一整根无法并行的长杆（vitest.config.ts:19-48 的并发调优长注释证实该仓被测试耗时咬过一次）；改某个切面要在 4245 行里定位 describe；单文件内共享 helper 越堆越多，新用例倾向复用不完全合适的 helper。
- **建议**：照已在用的「主文件 + 切面文件」命名法（`state-manager.map-wiring.test.ts`、`state-manager.random-events.test.ts`）继续拆——state-manager 按 commitChatState / 快照 / 回合推进 / patch 应用四切面，coordinator 按战斗阶段拆；不必一次拆完，新增用例优先落到新切面文件即可自然收敛。

#### ⚪ [low] 一条 `it.skip` 的注释已宣告断言永久失效，却留在原地

- **位置**：src/sillytavern/database.test.ts:311
- **问题与影响**：`it.skip('settings 应含 v4 默认字段（Q-06：不再播种，此断言随之失效）', ...)` 标题里已写明断言失效，其下 6 行断言（apiEndpoints/agentConfigs/cacheStrategy/maxSnapshotsPerSave/maxMemoriesRecall）验证的是被裁定废弃的行为。全仓另两处 skip（ejs-synthetic-corpus.test.ts:281、tests/contract/pack-install.contract.test.ts:27）都是环境条件门，属正当用法；这是 8303 个用例里唯一的无条件 skip。影响很小，但它是「skip 可以永久留着」的先例。
- **建议**：直接删除该 `it.skip` 及其 6 行断言；上一条用例 database.test.ts:308 `expect(await db.settings.count()).toBe(0)` 已正向守着「不再播种」，删除不丢覆盖。

## 7. 代码质量与可维护性

### 总评

这个维度整体处于**中上偏健康**的状态，问题集中在「结构」而非「纪律」。纪律面几乎无可挑剔：非测试代码里 TODO/FIXME 只有 1 条真待办、`@ts-ignore` 0 处、`eslint-disable` 仅 4 处、空且无注释的 catch 为 0，说明团队走的是「当场修或写进 CHANGELOG」而不是插标记就走；闸门体系（`--max-warnings 0` + 类型感知 lint + knip 棘轮 + 编码不变量测试）不仅存在，还每一道都在注释里写明了「为什么」。真正要紧的是三件事：**几个枢纽模块的体量与公共面失控**（GamePipeline 2445 行 8 类职责、create-store 导出 148 个成员、MapPoliticalTab.vue 1021 行 script），它们让「改一个子系统必须打开一个巨文件」成为常态，也让纯逻辑无法单测；**`no-explicit-any` 是唯一裸奔的欠账**——259 处 any 无任何计量，与其余三道棘轮的治理水准脱节；**knip 棘轮在实践中变成了「新债照记、旧债不还」**，基线十天从 133 涨到 145。相对地，重复代码问题基本都是可控的表层技术债（SFC 外壳 CSS、gen 链接口、combat-v3 窗口表），没有发现隐蔽的正确性风险。

### 量化底账

- 体量：src 非测试代码 106868 行 + 35141 行注释 + 12576 空行，注释密度 **24.7%**；最长文件 types.ts(4022)、game-pipeline.ts(2445)、state-manager.ts(2408)、create-store.ts(2265)、combat-v3/coordinator.ts(2226)。全仓 >80 行的函数仅 **67 个**，最长 450 行且是测试夹具——函数粒度整体是好的，问题在文件/类粒度。
- 测试覆盖面：319 个 `*.test.ts` / 378 个非测试源文件 ≈ **84%**。
- 重复：12 行窗口检测命中 365 组，去重后值得管的只有三簇（SFC 外壳 CSS、三条 gen 链 client 接口、combat-v3 的 18 键窗口表）；database.ts 里 16 个 Dexie 版本的 schema 重复是**有意冻结**并已 delta 化，不计入。
- 死代码：knip 基线现 **145** 条（验证员实测，finding 原报 144），十天净增 12。
- 主题令牌化：`var(--theme…)` 4457 次 vs 裸 hex 47 次（验证员按另一口径数为 4833 / 109，比例结论不变）。
- 错误处理：非测试代码 `console.log` 仅 25 处（15 处集中在 game-pipeline）；127 个 SFC 逐个扫描只找到 1 处真 floating promise。

### 亮点

- **闸门体系是本仓最强项，且每道都写明动机**：`eslint.config.js` 带 `--max-warnings 0` 并单开类型感知档（`no-floating-promises`/`no-misused-promises`/`await-thenable`，注释记着开启当天逮到 4 处真缺陷）；`scripts/knip-ratchet.mjs` 用「问题身份」而非计数做棘轮，能抓住「修一条又加一条」的净零变化；`tests/encoding-invariants.test.ts` 把中文编码三条判据变成 CI 断言。CI 三 job 覆盖 typecheck×3 + build + format:check + lint + knip:ratchet + test:run。
- **异常吞咽被治理成显式契约**：`no-empty` 关掉 `allowEmptyCatch`，每个空 catch 必须写理由，且理由确实在交代权衡（`src/ui/stores/theme-store.ts:133`「隐私模式/配额满：字号记不住而已，不值得打断用户」；`src/ui/stores/asset-store.ts:1279`「单个文件读不出字节不该连累其余」）。
- **state-manager.ts 是大文件正确组织的样板**：2408 行拆成一 op 一方法的 `applyXxx` 私有方法，配 `validatePatch` 前置校验（:395）与统一 `createEvent`（:1407）。（验证员核实：实为 31 个 `applyXxx`，且 `applyUpdateCharacter` 563-704 达 141 行，并非全部在 30 行以内——样板成色略被美化，但组织方式仍是正面参照。）
- **database.ts 把 Dexie 迁移重复治理成受控债务**：`src/sillytavern/database.ts:100-124` 用整段注释说明取舍，引入 `withSchema(base, delta)` 让 v13 起一版一行，明确**冻结 v1–v12**（改一字节即触发索引重建），并把「生成字符串必须与手写版逐字节相同」交给 database.test.ts 当闸门。
- **技术债处理姿势正确**：`char-gen-agent.ts:100-108` 先论证「回退路径在生产不可达」（唯一 clientFactory 恒定带 `chatWithTools`），再选择**删接口而非改签名**，用类型系统把结论钉死，而不是留一条永不执行的代码。
- **注释可追溯**：35141 行注释中 24740 行含中文、纯拉丁仅 833 行，风格统一且普遍带编号（「Q-02 修复」「M2 按名删除（#22）」「地图 v1 §7」），把设计文档、PR 编号与代码位置串成链路。

### 问题清单

#### 🟡 [medium] GamePipeline 是前端层的上帝类：2445 行、44 个方法、8 类职责挤在一个 class

- **位置**：src/ui/lib/game-pipeline.ts:173、:628、:1090、:1877
- **问题与影响**：`export class GamePipeline {` 从 :173 延伸到文件末 2445 行，44 个成员方法覆盖至少 8 类互不相干的职责——Agent 配置装配（`buildAgentConfigs` 628-779，151 行）、上下文装配（`buildContext` 830-933）、端点/客户端工厂（`getClientFactory` 1090-1255，165 行）、EJS vars 差量提交、音频、图像、战斗（`startCombatV3` 1877-2160，284 行）、三条 gen 侧链。全仓 >80 行的函数共 67 个，其中最长的两个都在这个类里。后果是改任一子系统都要打开同一个巨文件，读者无法靠文件边界判断影响面；`startCombatV3` 这类方法只能端到端测，无法对分支单独下断言；子 agent 分派时该文件必然整篇进上下文。
- **建议**：按已有接缝切成组合件——战斗三方法出 `game-pipeline-combat.ts`、三条 gen 侧链出 `game-pipeline-sidechains.ts`、音频三方法出 `game-pipeline-audio.ts`，主类只留 `run`/`buildContext`/事件分发；参照 `src/ui/lib/scene-image-seams.ts` 的依赖注入写法可零改测试平移。

#### 🟡 [medium] create-store 单个 Pinia store 导出 148 个成员（2265 行），game-store 93 个

- **位置**：src/ui/stores/create-store.ts:134、:2096、src/ui/stores/game-store.ts
- **问题与影响**：一个 `defineStore('create', …)` 覆盖 2265 行，`:2096 return {` 之后逐行统计出 **148 个**导出键，注释分组横跨内容加载门/步骤/难度/角色/属性/起始地树/装备技能/预设/开场提示词等九个关注点；其中 `START_LOCATIONS: startLocationTree,` 旁边直接写着「名字保持 START_LOCATIONS 以免动 8 个模板消费点」——这就是「公共面太大不敢改名」的实证。对照 `settings-store.ts` 15 个、`content-store.ts` 24 个（验证员修正，原报 13），说明团队本身知道怎么控面。面过大导致重构时无法区分内部实现与对外契约，store 内部状态互相可见，「第 N 步状态被第 M 步误改」这类 bug 无法靠类型或模块边界拦住。
- **建议**：按注释里已画好的分组横切成 `useCreateCharacterStore` / `useCreateAttributesStore` / `useCreateLoadoutStore` / `useCreatePresetStore`，用薄门面 `useCreateStore` 聚合并先保持导出名不变，再逐步收窄。

#### 🟡 [medium] MapPoliticalTab.vue 在 SFC 里写了 1021 行 script，而同功能已有 lib/composable 两层

- **位置**：src/ui/components/game/MapPoliticalTab.vue:216、:556、:693；src/ui/composables/useMapPolitical.ts:65；src/ui/lib/map-political.ts
- **问题与影响**：组件共 1863 行，`<script setup>` 占 1-1021 行，内含成体系的纯逻辑：`modeDaysOf`(468)、`fitView`(500)、`tileWorldPoint`(530)、`ensureTintSource`(556)、`paintTint`(594)、`paintFx`(608)、`stageOffset`(647)、`tileAtClient`(654) 以及整套指针状态机 `onPointerDown/Move/Up/Leave`(693-777)，末尾还挂 5 个 watch。同功能域已存在 `src/ui/lib/map-political.ts`(1405 行) 与 `src/ui/composables/useMapPolitical.ts` 两层，分层约定存在但这个组件没遵守。canvas 着色、坐标换算、命中测试被关在 SFC 里就只能挂载组件才能测，而 `src/ui/AGENTS.md:155` 自己记着 jsdom 没有 2D 上下文——该组件确无测试文件，地图着色 bug 只能真机走查。验证员核实：核心修辞证据「`<template>` 只有 85 行」不成立（template 实为 1023-1271 共 249 行），「模板 85 行 vs 逻辑 1021 行」的对比被夸大约 3 倍，`useMapPolitical.ts` 实测 186 行而非 121，故判 partly——结构失衡与不可测的结论仍成立，但没有原文说的那么极端。
- **建议**：把不依赖 Vue 响应式的 `ensureTintSource/paintTint/paintFx/tileWorldPoint/tileAtClient/stageOffset/modeDaysOf` 下沉进 `lib/map-political.ts`（canvas/stage 作参数传入），指针状态机抽成 `useMapPoliticalPointer.ts`，组件只留模板绑定与 watch 接线。

#### 🟡 [medium] 三条 gen 侧链的 client 接口逐字重复三份，且语义已漂移

- **位置**：src/sillytavern/char-gen-agent.ts:109、craft-gen-chain.ts:90、item-gen-chain.ts:78、item-gen-chain.ts:264
- **问题与影响**：`CharGenClient` / `CraftGenClient` / `ItemGenChainClient` 三处逐字节重复同一段 `chatWithTools` 签名与同一个 6 字段返回体 `{ output; rawResponse; tokensUsed; cacheHit; duration; error? }`。但语义已分叉：char-gen 已论证「回退路径生产不可达」并把 `chatWithTools` 提为必填、删掉回退；craft/item 仍是 `chatWithTools?:`（craft:101 / item:89），并各自留着 `if (client.chatWithTools)` 分支（craft:211、craft:333、item:236）与注释「Fallback: 仅当 client 不支持 chatWithTools（如测试 mock）时走普通 chat」。同一条论证只落地三分之一，导致 craft/item 维护着两条路径，其中一条**只有 mock 走得到**——测试覆盖的分支与生产跑的分支不是同一条，是最容易漏 bug 的形状；改返回体要同步三处，漏一处行为悄悄不一致。
- **建议**：抽出 `AgentChatResult` 与 `ChatWithToolsFn` 两个类型（放 `types.ts` 或新建 `agent-chain-client.ts`）供三处引用；同时把 char-gen 的结论套到 craft/item——`chatWithTools` 改必填、删两条 `if` 分支与 Fallback，测试 mock 补实现即可。

#### 🟡 [medium] combat-v3 的 18 个 WindowKey 在 6 处被手写枚举，其中 3 处是逐行相同的完整空表

- **位置**：src/sillytavern/combat-v3/types.ts:1302、:1371、:1580；state.ts:465；automata/index-active.ts:21；automata/interpreter.ts:57
- **问题与影响**：`WindowKey` 联合类型在 types.ts:1302-1320 定义 18 个成员，之后同一份清单被逐行照抄三遍（`types.ts:1371 EMPTY_EFFECT_INDEX` 常量、`state.ts:465 EMPTY_EFFECT_INDEX()` 函数、`automata/index-active.ts:21 EMPTY_BY_WINDOW`），另有两处按窗口逐键展开（interpreter.ts 的 `WINDOW_ROOTS` 白名单、types.ts:1580 `WindowCtxMap`）。新增窗口要改 6 处，`Record<WindowKey,…>` 能让漏改的 3 处编译报错，但白名单/上下文映射的语义差异得靠人记住；同名 `EMPTY_EFFECT_INDEX` 一常量一函数并存是现成陷阱。验证员补了一条比原 finding 更糟的事实：`grep -rn EMPTY_EFFECT_INDEX src/` 只有三条命中，types.ts:1371 那个导出常量**全仓零消费者（连测试都没有）**，是活着的死代码。
- **建议**：在 types.ts 导出 `WINDOW_KEYS = [...] as const` 并由它派生 `WindowKey`，提供唯一的 `createEmptyEffectIndex()` 工厂供 state.ts / index-active.ts 引用；顺手删掉零消费者的 types.ts:1371 常量。

#### 🟡 [medium] `no-explicit-any` 被关闭且无任何棘轮，259 处 any 无人计量

- **位置**：eslint.config.js:58、src/sillytavern/types.ts、src/ui/lib/game-pipeline.ts、src/sillytavern/ejs-runtime.ts
- **问题与影响**：配置里逐字写着 `'@typescript-eslint/no-explicit-any': 'off', // 项目仍在类型漂移修复中`——自认是暂时性欠账，却没配套任何计量。排除测试后扫描到 **259** 处 `: any` / `as any` / `any[]`（验证员按行级口径数为 254，差在正则口径），热点逐个精确吻合：`ejs-lodash-shim.ts` 53（shim 层可接受）、`game-pipeline.ts` 18、`ejs-runtime.ts` 17、`CharacterListPanel.vue` 16、`ejs-quickjs-backend.ts` 14、`types.ts` 11、`preset-loader.ts` 8。`any` 会沿调用链传染并静默关掉类型检查，出现在「唯一类型来源」types.ts 与枢纽 game-pipeline.ts 上尤其危险；没有基线就无法回答「这个月是变好还是变坏」，与同一份配置为 lint、死代码、中文编码都建了硬闸门的水准明显脱节。
- **建议**：照 knip-ratchet 的成熟模式加 `any` 棘轮（按 `文件|行内容哈希` 记入 `any-baseline.json`，新增即挂红），再按热点顺序消化 types.ts 与 game-pipeline.ts；低成本替代是先把规则改成 `'warn'` 并允许 `--max-warnings 259` 递减。

#### ⚪ [low] knip 棘轮只涨不落：基线十天从 133 涨到 145，承诺的清理提交未发生

- **位置**：knip-baseline.json、scripts/knip-ratchet.mjs:1、src/ui/components/create/DestinyCoreCard.vue、src/ui/components/shared/form/FormKeyValue.vue
- **问题与影响**：逐 commit 解析计数确认轨迹属实：50877a1(08-05)=133 → 792bef2=147 → 76346f7=144 → ccdb4ba=145 → 789103f(08-08 图像 v2)=148 → f698eb0(08-12)=145，即每次增长都发生在**功能 PR 里**（开发者跑 `--update` 把新死导出吸收进基线），而不是在清理提交里收紧；`knip-ratchet.mjs:10-11` 自己写着「真正的修法是去掉 export 关键字…属于另一次提交」，`git log -- knip-baseline.json` 里确无该提交。棘轮的价值在于「只许变少」，实践中却成了「新债照记、旧债不还」，长期会退化成形式闸门。验证员三处打折并把严重度从 medium 降为 **low**：① 当前基线实测 145 条、净增 12（finding 标题的数字报错）；② `parseOutlineAgentOutput` 并非「全仓无消费者」，plot-outline.test.ts:26/:92/:114/:128 有整组测试在测它，只是无生产消费者；③ 建议删的 4 个 Vue 文件（共 516 行）撞上脚本头部 :6-8 明载的豁免——它们是 Phase 7d 在途件，AGENTS.md 进度表 7d 至今仍标 🔄，删掉等于删同事没写完的活。真正无争议的只剩「基线被功能 PR 吸收、清理提交未发生」这一条流程观察。
- **建议**：排一次专门的清理提交，把 60+ 条「仅本文件使用的 export」批量去掉 `export` 关键字后 `npm run knip:update` 收紧；4 个 7d 在途 Vue 文件按脚本豁免保留，待 7d 收尾再处置。

#### ⚪ [low] 类型感知 lint 有意跳过 .vue，代价已兑现：DataSection.vue 有一处真实 floating promise

- **位置**：src/ui/components/settings/DataSection.vue:34、:241、eslint.config.js:40
- **问题与影响**：类型感知档 `files: ['src/**/*.ts', 'server/**/*.ts', 'tests/**/*.ts']` 不含 `.vue`（注释解释「SFC 里的 promise 绝大多数经由 store/composable 落地」）。逐 SFC 扫描 128 个文件只逮到 1 处，但它是真的：`:33 onMounted(async () => {` 内 `:34` 裸调 `loadStorageUsage();`（无 await / void / .catch），而 `:241 async function loadStorageUsage()` 内部无 try/catch。reject 时会变成 unhandled rejection，存储用量区块静默留空。对照 `BeautifierSection.vue:152` 写的是 `void beautifier.refreshPresetRules(...)`，说明约定存在只是这处漏了。
- **建议**：当场改为 `await loadStorageUsage();`（已在 async 的 onMounted 里）或 `void` 之；中期给 `.vue` 开类型感知档（`vue-eslint-parser` + `extraFileExtensions`），只开 `no-floating-promises` 一条以控解析开销。

#### ⚪ [low] SFC scoped CSS 共 20849 行，通用外壳样式在多个组件里逐行复制

- **位置**：src/ui/components/settings/assets/AssetCharacterDrawer.vue:604、audio/AudioLibrary.vue:948、audio/AudioMixer.vue:482、audio/AudioPlaylists.vue:436、game/CharacterViewerModal.vue:1194
- **问题与影响**：`.icon-btn`（`min-width:36px; height:36px; display:inline-flex; … border:1px solid var(--theme-card-border)`）整块在 4 个组件里逐行相同，其上的 `:focus-visible` 块同样 4 处相同；`.empty-tab` 在 5 处相同（验证员核对了 CharacterViewerModal:1194 与 PlotPanel:521，两个 workshop 弹窗未逐字核）。而仓内已有 `src/ui/styles/utilities.css`、`cards-shared.css`、`settings/settings-chrome.css`（`src/ui/AGENTS.md:310` 称其为「共用外壳样式唯一一份」）这套现成机制。改一次图标按钮尺寸/焦点环要翻 4+ 个组件，漏一个就风格漂移，而 `docs/design.md` 恰以「统一外壳」为核心约定。
- **建议**：把 `.icon-btn` / `.icon-btn:focus-visible` / `.empty-tab` 这类无组件语义的外壳样式挪进 `utilities.css`（或按 settings-chrome.css 的 `<style scoped src>` 惯例做一份 `shared-controls.css`），组件侧只留差异化覆盖；先处理 3 处以上重复的块即可拿到大部分收益。

#### ⚪ [low] src/sillytavern 平铺 269 个 .ts（131 源码 + 138 测试同层混放），靠 AGENTS.md 代替目录结构

- **位置**：src/sillytavern/、src/sillytavern/AGENTS.md
- **问题与影响**：目录下 269 个 `.ts` 源码与测试逐一交错在同一层，只有 3 个子目录（`__tests__/`、`combat-v3/`、`image-providers/`），而 combat-v3 内部又分了 `automata/`、`phases/`——说明分目录的能力与意愿都在，只是主干没做。功能域其实已在文件名前缀里画出（`ejs-*` 9 个、`combat-*`、`audio-*`、`asset-*`、`agent-*`、`workshop-*`、`image-*`、`content-*`），引擎分册 AGENTS.md 是靠一份长文档补偿这个缺失的结构。结果是「哪些文件属于 EJS 子系统」这类问题必须读文档才能回答，文档与代码同步全靠人，新人与子 agent 的上手成本常年支付。
- **建议**：按已有文件名前缀做一次纯 move 重构（`ejs/`、`audio/`、`asset/`、`workshop/`、`image/`、`content/`、`agent/`），测试跟随源码或统一进 `__tests__/`；零逻辑变更、可一次性完成，之后 AGENTS.md 分册可大幅瘦身。

#### ⚪ [low] 少量硬编码颜色绕过主题令牌，代码块暗色面在多组件重复且无回退

- **位置**：src/ui/components/game/CharacterListPanel.vue:571、:822、:1167；src/ui/components/game/ItemsPanel.vue:762；src/ui/components/settings/TemplatePreview.vue
- **问题与影响**：令牌化整体极彻底（`var(--theme…)` 4457 次 vs 裸 hex 47 次），剩余多数是合规的 `var(--theme-danger, #e5484d)` 带回退写法；但确有纯硬编码：`:571 border-bottom: 2px solid #c084fc;`、`:581 color:#c084fc;`、`:822 color:#a78bfa;`、`:825 color:#ef4444;`，以及 `.script-code` 的暗色面 `:1167 background:#0d1117; :1168 color:#c9d1d9;` 与 `ItemsPanel.vue:762-763` **同一对颜色逐行重复且均无 var() 回退**。项目有 10 套主题（含 parchment/ivory 浅色），固定暗底在浅色主题下会形成突兀黑块；同一对配色重复两处，改一处会漏另一处。热点还有 `TemplatePreview.vue`（验证员实测 17 处 hex）、`CharGenSystemCard.vue` 6 处、`CreateStepConfirm.vue` 6 处。
- **建议**：紫色强调改走 `--theme-quality-epic`（同文件 :799 已在用），红色走 `--theme-danger`，代码块面新增 `--theme-code-bg` / `--theme-code-fg` 并在 10 套主题各给一次值；CI 可加一条轻量断言：SFC `<style>` 段里不带 `var(--` 的裸 hex 数量不得增加。

## 8. 性能

### 总评

这个维度的整体健康度偏好：数据访问层有明确纪律，EJS/提示词装配、战斗 v3 表达式求值、势力地图渲染这三处最容易出性能事故的地方，都能看到刻意的分层、缓存与预算论证，甚至在文档里写死了性能契约。真正的风险集中在**一个地方**——每回合都要走的写入热路径。`state-manager.ts` 的快照创建把整份消息历史深拷贝进每一张快照，配套的 `trimSnapshots` 又在裁剪前把 30 份整行读回内存；同一个文件里的 `commitChatState` 则逐条补丁做全量读-改-写，一次提交能把同一份 SaveProfile 读写十几次。这两条的共同特征是「玩得越久越慢、且不报任何错」，应当优先处理。其余问题多属构建产物体积、长列表未窗口化、批量写未用 bulk 这类工程债，验证环节把其中三条的严重度调低了，说明初判存在一定放大，但方向都成立。

### 亮点

- Dexie 访问层纪律扎实：成对写入一律走显式事务（`database.ts:1810` saveAsset、`:1836` deleteAssets 的 bulkDelete），跨存档查询走 `where('saveId')` 或 `[saveId+messageId]` 复合索引而非全表扫内存过滤。
- `deleteMessagesAfterTurn`（`database.ts:1678-1683`）用 `[saveId+turn]` 复合索引做 between 范围删除，并在注释里说明上下界取法，是全仓索引使用最讲究的一处。
- EJS 静/动分层（`worldbook-loader.ts:229` hasDynamic + `:288` partitionEntries）兼顾性能与上游 prompt cache——刻意让静态区逐字节稳定，同步/异步两条路径共用同一份分区函数以防缓存静默击穿。
- `prerenderWorldBookEntries`（`worldbook-loader.ts:401`）把整个 pass 一次交给后端，跨 wasm 编组从 N 次压到 1 次；`toEval` 为空时完全不建 QuickJS runtime（`ejs-quickjs-backend.ts:312` 早退）；wasm 装载在 `main.ts:107/131` 明确不 await 以免拖慢启动。
- MapPoliticalTab 的 freeze-and-settle 契约（`src/ui/AGENTS.md` 有完整记录）：view 只喂 GPU transform，按分辨率计算的量读 150ms 防抖后的 settledView，把缩放最坏帧从 250ms 降下来；`useMapPolitical.ts` 的势力缓冲按 contentHash 懒建、卸载释放，注释直接给出 280ms 构建 / 35MB 常驻的预算数字。
- 素材、插画、音频一律元数据与字节分表（assetMeta/assetBlobs 等），列表与索引查询永不驮二进制；页面级组件全部 `defineAsyncComponent` 懒加载（`App.vue:106-110`）。

### 量化底账

扫描覆盖 src 下 697 个非测试 TS/Vue 源文件、约 15.5 万行，抽样深读行数前 25 的文件。Dexie 面核对 145 处 `toArray`，仅 `database.ts:1729` 与 `content-store.ts:849` 命中「toArray 后内存过滤」且对应表 ≤10 行；v1→v19 全部 stores 声明与实际 where 查询逐一对照，未发现缺索引的 where。N+1 候选 17 处，确认 4 处为真。Vue 面 258 处 v-for 的 `:key` 覆盖仅 2 处内联字面量数组缺失（无实际影响）；全仓 deep watch 只有 2 处。四个长列表文件 grep 虚拟滚动关键字零命中。依赖体积实测：noto-sans-sc 5.0MB、noto-serif-sc 6.4MB、openseadragon 5.6MB、quickjs-emscripten 2.4MB、fontawesome-free webfonts 1.0MB。

### 问题清单

#### 🔴 [high] 每回合快照深拷贝整份消息历史，trim 时又把 30 份快照全量读回内存

- **位置**：`src/sillytavern/state-manager.ts:1430`、`src/sillytavern/database.ts:1368`
- **问题与影响**：`createSnapshot`（:1436-1447）先 `await getMessages(this.saveId)` 再 `messages: structuredClone(messages)`，与 characters/plotEvents 一起整份落库；`advanceTurn`（:1482）每回合调一次，pre-combat 再调一次（`game-pipeline.ts:2010`）。紧接着 `trimSnapshots`（`database.ts:1373-1377`）第一句就是 `.where('saveId').equals(saveId).reverse().sortBy('createdAt')`，且在 `all.length <= maxCount` 早退**之前**执行——每回合把 30 份各自内嵌全量历史的整行反序列化进内存，而实际只用 id/reason/createdAt 三个字段。上限见 `types.ts:637` `maxSnapshotsPerSave: 30`。写入成本约 O(N)、读取约 O(30×N)，按 300 回合、单条正文 2KB 估，一次 advanceTurn 克隆约 600KB、再从 IDB 反序列化约 18MB，全在主线程；存档占用也是历史体积的约 30 倍。
- **建议**：trimSnapshots 改用 `primaryKeys()` 或 `.each()` 只投影裁剪判定所需字段，不 sortBy 整行；快照中的 messages 改存 id 列表+增量或单独建表按需读；写库前那次 `structuredClone` 可省（Dexie 落库本身即结构化克隆）。

#### 🔴 [high] commitChatState 逐 patch 全量读-改-写：每条补丁一次 getProfile/updateProfile 或一次 characters 全表扫描

- **位置**：`src/sillytavern/state-manager.ts:279`、`:460`、`:489`
- **问题与影响**：`:279-292` 是串行 `for (const patch of patches) await this.applyPatch(patch)`；`applySetVariable`/`applyDeltaVariable`（:489-519）每条都 `getCurrentVariables()` + `persistVariables()`，即整份 SaveProfile.variables 读回再整份写回；`resolveCharacter`（:459-474）每次 `getCharacters(this.saveId)` 拉全表再 `find(c => c.name === key)`；`getProfile` 分散在 1278/1315/1332/1355/1388/1638/1713/1843/1882/1920/1986/2018 共 12 处 handler，`getCharacters` 另有 7 处。一轮 AI 输出通常翻译出十几到几十条补丁，同一份 profile 就被完整读写十几次、characters 全表扫十几遍，全是串行 IDB 往返；`:297` 的 reactToEvents 会再走一轮提交，放大一次。验证员确认 ADR-21 的受控例外只豁免 UI 直写，与本条无关。
- **建议**：在 commitChatState 作用域内建一次提交级缓存——入口读一次 profile + characters 并建 name→char 索引，handler 全部读缓存写内存，出口一次 `updateProfile` + `bulkPut(characters)`；或整体包进一个 Dexie 事务并把读取提到循环外。

#### 🟡 [medium] settings 深监听无防抖：每次按键都整份 detach + JSON.stringify + 同步 localStorage.setItem

- **位置**：`src/ui/stores/settings-store.ts:452`、`:112`、`src/ui/components/settings/image/ImageRenderCard.vue:392`
- **问题与影响**：`watch(settings, () => saveNow(), { deep: true })` 无任何防抖，saveNow → persistRedactedSettings（:443-450）→ `localStorage.setItem`，而序列化（:112-122）先 `detach` 深拷贝再 `JSON.stringify`。同时 `ImageRenderCard.vue:391-397` 把整张 ComfyUI 工作流 JSON 的 textarea 用 `v-model="s.imageComfy.workflowJson"` 直绑到这个被深监听的对象上（袋子里还有 agents、10 项主题、17 项图像设置）。在可达几十 KB 的工作流框里每敲一个字符，就是一次全量深拷贝 + 序列化 + 同步阻塞写盘；旁边的 validateWorkflow 只在 `@blur`，救不了每键持久化。
- **建议**：给 saveNow 套 200–300ms 防抖并在离开页面/卸载时 flush；大文本字段改走本地草稿 + 显式保存，与 AgentConfigPanel 已有口径一致。

#### 🟡 [medium] vite 生产构建无分包策略且常开 sourcemap；App.vue 同步引入 7 个 store 把 Dexie 数据层压进首屏 chunk

- **位置**：`vite.config.ts:238`、`src/ui/App.vue:4`
- **问题与影响**：`build: { outDir: 'dist-ui', sourcemap: true }`，全文件无 `rollupOptions/manualChunks`。页面本身懒加载（`App.vue:106-110` 五个 defineAsyncComponent），但 `App.vue:3-9` 同步 import 了 audio/asset（2183 行）/settings/worldbook/beautifier/workshop 七个 store，其中 asset-store、worldbook-store 静态依赖 `@engine/database`，连同 `types.ts`（4022 行）全部落进 entry chunk——首屏标题画面就要下载解析整个数据层，懒加载收益被抵消；vendor 与业务代码混在同一 chunk，任何业务改动都让整块缓存失效；sourcemap 让产物再翻一倍以上。
- **建议**：加 manualChunks 至少切出 vendor（vue/pinia/dexie/fflate）；asset/workshop/beautifier 等 store 改在对应页面组件内引入（Pinia store 本就懒实例化）；生产 sourcemap 改 `hidden` 或按环境变量开关。

#### 🟡 [medium] ChatFlow 全量渲染消息列表，无虚拟滚动；每条 assistant 消息挂一个跑正则美化的组件

- **位置**：`src/ui/components/game/ChatFlow.vue:396`、`src/ui/components/game/BeautifiedNarrative.vue:114`
- **问题与影响**：`<template v-for="msg in messages" :key="msg.id">` 直接铺全量 `props.messages`，文件内无任何切片或窗口化（:189/:198/:294/:334 都是对全量数组操作），四个长列表文件 grep 虚拟滚动关键字零命中。每条 assistant 消息渲染一个 BeautifiedNarrative，其 parts computed（:114-127）逐段调 `compileBeautifierSegments(text, 'maintext', getBeautifierRules(), ...)`，规则库预设 22 条起、用户可再加；仅 streaming/关闭美化时短路，历史消息不适用。长档（几百回合）下 DOM 与组件实例随历史线性增长，首次打开存档要一次性挂载全部消息并各跑一遍全部正则；美化规则一变，所有 computed 同时失效重算。
- **建议**：对 messages 做窗口化（只渲染最近 N 条 + 向上增量加载）或引入虚拟滚动；美化结果按 (messageId, rulesVersion) 缓存。

#### ⚪ [low] 自托管字体资产约 11.5MB 进构建产物，FontAwesome 同时携带 woff2 与 ttf

- **位置**：`src/ui/main.ts:24`
- **问题与影响**：`:24-31` 同步 import 三个字体族 + 三份 FontAwesome CSS。实测 noto-sans-sc 5.0MB、noto-serif-sc 6.4MB、cinzel 88KB；fa-solid-900 同时有 158KB woff2 与 426KB ttf、fa-regular-400 同时有 25KB woff2 与 68KB ttf，约 494KB ttf 是现代浏览器永不取用的死重量。运行时因 unicode-range 切片只拉子集，代价主要在构建/分发/CDN 侧。验证员核实两处需修正：ttf 的 @font-face 引用在 solid.css / regular.css 而非原文所说的 fontawesome.css；且「webfonts 1.0MB」含 main.ts 明确不引的 brands，总量引用有轻微夸大——按性能维度已由 medium 降为 low。
- **建议**：保留 variable 包，构建里过滤掉不会被使用的 ttf（改引 min.css 后配 assetsInclude 排除，或自建仅含所用图标的子集）。

#### ⚪ [low] 插画记录查询是全表线性扫描，却在每条消息、每个插画位的 computed 里调用

- **位置**：`src/ui/stores/scene-image-store.ts:411`、`src/ui/components/game/SceneImageSegment.vue:124`、`src/ui/components/game/BeautifiedNarrative.vue:152`
- **问题与影响**：`byMessage`（:411-413）与 `takesAt`（:420-431）都是 `records.value.filter(...)`；调用点在渲染热路径——`BeautifiedNarrative.vue:147-156` 每条消息一次 byMessage，`SceneImageSegment.vue:124` 每个插画位一次 takesAt。复杂度 O(消息数 × 记录数)，且全部依赖同一个 records 数组，任一记录状态跳变都会让所有 computed 同时失效并各自重扫。验证员核实代码属实但影响量级被夸大：records 是单存档记录，几百×几百≈1e5 次浅字段比较在 JS 中是毫秒级，且只在生成期抖动（生成本身 5-60 秒/张），玩家感知接近 0，故降为 low。
- **建议**：在 store 里维护 `messageId → 记录[]` 的 computed 索引 Map，仅在 records 变化时重建，消费方从 O(N) 降到 O(1)。

#### ⚪ [low] 批量删除写成逐条 await 循环（N+1），已有 bulkDelete/bulkPut 未用

- **位置**：`src/sillytavern/memory-store.ts:199`、`src/ui/stores/content-store.ts:976`（另见 `state-manager.ts:1525`、`asset-store.ts:1832`）
- **问题与影响**：memory-store.ts:194-206 的 applyCompression 逐条 `deleteMemory`（一次压缩可涉及几十条）；content-store.ts:967-985 世界书/预设逐条 await 写入。对照 `database.ts:1830-1838` 的 deleteAssets 已正确使用 bulkDelete，反差成立。验证员对另两处打折：state-manager.ts:1511-1528 的角色/plotEvents 循环包在单事务内（Dexie 事务内往返远比独立事务廉价，且规模只有十几个角色），而 asset-store 导出处「改 bulkGet 一次取回」是**错误建议**——素材字节可达数百 MB，逐条取正是为了避免整库 blob 同时驻留内存，改了会把慢换成 OOM。真正值得改的只有 memory-store 与 content-store 两处，故降为 low。
- **建议**：仅对 memory-store 与 content-store 改用 `bulkDelete(ids)` / `bulkPut(rows)`；asset 导出维持逐条流式取字节不动。

#### ⚪ [low] EJS 编译缓存与 guest 函数体缓存是无上限 Map，键为条目正文全文

- **位置**：`src/sillytavern/ejs-backend.ts:82`、`src/sillytavern/ejs-quickjs-backend.ts:1124`
- **问题与影响**：`compileCache` 与 `guestBodyCache` 均以条目正文原文为键、只增不淘汰，只在 `clearEjsBackendCache` 时整体清空——而该函数的**生产调用方为零**（grep 只命中 4 个测试文件与 `worldbook-loader.ts:252` 一层转发，注释自陈「生产路径无需调用」），即运行期永不清。键本身可达数 KB，编辑期反复改一条 EJS 条目会让每个中间版本常驻内存。代码注释自认是「session 级、全语料≈1500 块无内存压力」的知情取舍，但工坊编辑场景未被该论证覆盖。
- **建议**：换成有上限的 LRU（几百条足够覆盖单次装配），或以内容哈希代替全文做键。

#### ⚪ [low] OpenSeadragon 静态引入，随 GamePage chunk 一起下载

- **位置**：`src/ui/components/game/MapPanel.vue:23`、`src/ui/composables/useMapViewer.ts:10`、`src/ui/composables/useMapMarkers.ts:9`
- **问题与影响**：三处均为静态 `import OpenSeadragon from 'openseadragon'`，无一处动态 import；`GamePage.vue:32` 静态 import MapPanel，而 GamePage 经 `App.vue:108` 懒加载——OSD 必然落进 GamePage chunk，进游戏页即下载（实测 openseadragon.min.js 345KB）。同处的势力地图页签已做懒挂载，说明「地图不是进游戏必用」这一点已被自己承认。
- **建议**：改成 `await import('openseadragon')` 在 useMapViewer 初始化时按需装载（与 quickjs-emscripten 的动态 import 同一口径），失败时地图面板降级提示。

## 9. 前端 UI 层规范与可访问性

### 总评

这一层的整体健康度处在「规范写得好、执行靠自觉」的状态。值得肯定的是，团队在几个最容易被忽略的地方做得比多数项目扎实：`variables.css` 的减少动态效果处理同时归零了 `animation-delay`、`base.css` 有真正兜底的全局 `:focus-visible` 焦点环、品质色纪律近乎零违反、`lib/` 层纯函数下沉与设置页 14 分区拆分是全仓分层最好的示范。问题也集中在同一个根因：`docs/design.md` 里那张「绝对禁令（design hook 强制扫描）」表所声称的机检并不存在，于是间距硬编码（1088 处）已经反超 token 用量（981 处）、57 处裸 hex 颜色、20 余处引用了根本没定义的 token 都在无声累积。可访问性方面，共用基元 `AppModal` 与 `AppTabs` 缺少 dialog/tablist 语义与焦点管理，因为在基元层，缺陷会随 26 个和 24 个调用点一起复制。本批 12 条 findings 经对抗验证后无一条被推翻，但两条 high 均被降为 medium（影响面小于原判），另有三条降为 low、三条标记 partly。整体判断：没有功能性中断，是一层可维护性与可访问性的系统性债务，最高杠杆的动作是把可机检的禁令变成一条测试闸门。

### 亮点

- `variables.css` 用系统 `prefers-reduced-motion` 与应用开关 `[data-reduced-motion]` 两条全局 `*` 规则覆盖了 19 个含 `@keyframes` 的文件，且同时归零 `animation-delay`，避免了交错入场退化成「隐身 280ms 再逐个弹出」。
- `base.css` 的全局 `:focus-visible { outline: 2px solid var(--theme-primary) }` 是真正的兜底；抽查的 29 个 `outline:none`（AudioMixer.vue:476、AssetLibrary.vue:581、CombatActionBar.vue:598）都配了 `box-shadow` 替代环而非裸删。
- 品质色纪律干净：`qualityVar()` 26 处内联绑定，组件内几乎无品质 hex，全仓 `background-clip: text` 为 0 处，design.md 两条禁令确实守住。
- 键盘可达性在部分位置做对了：`ScenePanel.vue:318-328` 用真 `<button>` 并挂 `@focus`/`@blur` 与 `aria-describedby`，`StatusOverview.vue:305/356/473/547` 的可点击 div 逐个补了 `@keydown.enter` + `@keydown.space.prevent`。
- 设置页拆分彻底：`settings-chrome.css` 作为唯一共用外壳被各分区以 `<style scoped src>` 引入，`AgentConfigPanel.vue` 做成收 `agentId` 的可复用面并被 `ImagePromptCard.vue` 直接复用。
- 展示层纯函数下沉意识强：`scene-image-view.ts`（七态真值表）/ `character-viewer.ts` / `cg-gallery.ts` / `map-political.ts` 均带测试，`scene-image-seams.ts` 做成不碰 Pinia 的工厂以便免挂载测试。
- `AppModal` 的 `bare` 档刻意与 `closable:false` 分家（注释明写「写成 closable:false 就等于顺手废掉 design.md §4.5 要求的 Esc」），并在 `onUnmounted` 归还 body 滚动锁。

### 量化底账

扫描范围：`src/ui/` 下 128 个 `.vue`（总 53230 行）+ 228 个 `.ts`，样式面 5 个 CSS（12377 行）+ 11 个主题 CSS。超 1000 行的组件 9 个，最大 `MapPoliticalTab.vue` 1863 行。间距 token 引用 981 处 vs 硬编码 px 1088 处（验证员复跑得 1001:1089，正则口径微差，结论不变）；组件内硬编码 hex/rgba 57 处；`aria-label` 146 / `role=` 77 / `aria-selected` 2 / `aria-modal` 1；`:focus-visible` 规则 153 条。工具链侧：`eslint.config.js` 只挂 `eslint-plugin-vue` flat/recommended，无 a11y 插件；`tests/` 17 个闸门中仅字体不变式与主题表面归属两条与设计规范相关。

### 问题清单

#### 🟡 [medium] `--theme-accent` 等别名 token 全仓无定义，引用处静默失效

- **位置**：src/ui/components/create/PlotOutlinePreview.vue:217 / :359 / :398，src/ui/themes/bronze.css:34
- **问题与影响**：全仓 `--theme-accent:` 的定义只有 `themes/bronze.css:34` 一处，`variables.css` 的 `:root` 中没有；`PlotOutlinePreview.vue` 三处不带 fallback 地引用它（`.stream-progress` 进度条、`.badge-active` 徽章紧接 `color: #fff`、`.event-bullet` 圆点），CSS 未定义自定义属性会让整条声明 invalid-at-computed-value-time 回落到 `transparent`。同类无定义 token 还有 `--theme-badge-bg`、`--theme-border`（design.md §1 禁令表点名的那个，5 处）、`--theme-danger`（8 处）、`--theme-bg-elevated`、`--theme-text`。后果是「当前章节」徽章在浅底主题上白字落米色底、对比度接近 0；带 fallback 的那批不消失但永远锁死写死色值，换十套主题都不跟随。验证员核实全部引用属实、组件非死代码，并补了一条：`:360` 的 `color: #fff` 同时踩中 design.md:31「硬编码 #fff 于 primary 底上」的禁令；但真正隐形只发生在 parchment/ivory/misty-lilac 等浅底主题，暗色主题下白字仍可读，且范围限于捏人页大纲预览的小徽章与 4px 进度条，故由 high 降为 medium。
- **建议**：在 `themes/variables.css` 的 `:root` 里把这批别名统一补成指向真 token（如 `--theme-danger: var(--theme-error)`、`--theme-border: var(--theme-card-border)`），或反过来改写引用；同时补一条源码闸门，扫 `src/ui/**` 所有 `var(--theme-*)` 名字与 `:root` 声明集合做差集，非空即红。

#### 🟡 [medium] `AppModal` 缺 dialog 语义、焦点陷阱与焦点归还，26 个调用点全部继承

- **位置**：src/ui/components/shared/AppModal.vue:79 / :64，src/ui/components/game/StatusOverview.vue:602，src/ui/components/game/QuestsPanel.vue:158
- **问题与影响**：`AppModal.vue:79-86` 根节点只有 `class="modal-overlay" tabindex="-1"`，无 `role="dialog"` / `aria-modal` / `aria-labelledby`，且全组件 0 处 `.focus()` 调用，`tabindex="-1"` 是死配置。Esc 在 document 上无条件监听、无栈顶判定，后果已被调用方注释点名：`StatusOverview.vue:602-604` 记录「两个 AppModal 同时开着按一下 Esc 会把两层一起关掉」，解法是各调用点自己写 `v-if="… && !cropOpen"` 绕开，而非在基元里修。另有绕过 AppModal 自建的浮层 `QuestsPanel.vue:158-166`，只有 `@click.self`，全文件无 `Escape`/`keydown`，直接违反 design.md §4.5。全仓 `role="dialog"` 仅 2 处、`aria-modal` 仅 1 处，而 `<AppModal` 调用文件 26 个。验证员逐条核实无误，仅指出关闭按钮已有 `aria-label="关闭"`；并认定这是可访问性退化而非功能中断——鼠标用户不受影响，Esc 与遮罩点击仍可关闭，弹窗 Teleport 到 body 末尾故 Tab 最终仍可达，故由 high 降为 medium。
- **建议**：在 `AppModal.vue` 一处修完——加 `role="dialog" aria-modal="true"` 与 `aria-labelledby`，open 时记录 `document.activeElement` 并把焦点移入 `.modal-content`、关闭时归还，加 Tab 循环陷阱，Esc 改为模块级打开栈只让栈顶响应；随后删掉 `StatusOverview.vue:602` 与 `AssetCharacterDrawer` 的绕法，并把 `QuestsPanel.vue:158` 的自建浮层改用 `AppModal` 的 `bare` 档。

#### 🟡 [medium] 间距硬编码 px 已超过 token 用量（1088:981），design.md §3.1 禁令未生效

- **位置**：src/ui/components/game/CharacterListPanel.vue、src/ui/components/game/StatusOverview.vue、src/ui/components/game/MapPanel.vue、src/ui/components/home/HomePage.vue、docs/design.md
- **问题与影响**：`components/game` px=517 / token=363（硬编码多 42%），`components/home` px=36 / token=3 几乎不用 token，`create` 反过来 83:214 守得住。单文件 top 为 CharacterListPanel.vue 73 条、integrated-game-surfaces.css 67 条、StatusOverview.vue 50 条、MapPanel.vue 50 条；连共享基元 `AppModal.vue:174 gap: 12px` 都是裸 px，而同文件 `:169`/`:205` 用了 `--theme-spacing-lg/xl`，一个组件内两种写法并存。后果是间距体系失去统一调节能力：做移动端/多分辨率适配时改 6 个 token 影响不到一半位置；且 12px 与 `--theme-spacing-md` 数值相同、肉眼无差别，review 期看不出谁对谁错。
- **建议**：不做一次性全量替换，先替换 `AppModal`/`AppButton`/`AppCard`/`AppTabs`/`settings-chrome.css`/`cards-shared.css` 这批高复用基元，再照 `knip:ratchet` 形制补一条硬编码间距条数的棘轮 baseline，只许变少；同时把 design.md §3.1 的空口禁令改成与闸门一致的措辞。

#### 🟡 [medium] 43 处 div/li 承载点击且无 tabindex/role/键盘事件，含捏人页主选择控件

- **位置**：src/ui/components/create/SelectableCard.vue:18，src/ui/components/game/QuestsPanel.vue:125，src/ui/components/settings/BeautifierSection.vue:271
- **问题与影响**：43 处 `<div|span|li|tr|td|img|a … @click` 分布在 31 个文件，带 `tabindex` 或 `role` 的为 0。最要害的是 `SelectableCard.vue:18-26`——捏人页装备/技能/物品选择卡的唯一选中入口，整块不可聚焦、不可回车，纯键盘用户选不了装备就建不了角色；`QuestsPanel.vue:125` 的任务卡与 `BeautifierSection.vue:271` 的 `library-header`（内层 `<h4>` 还用 `style="cursor: pointer"` 装成可点）同理。这些元素也拿不到全局 `:focus-visible` 焦点环。对照 `ScenePanel.vue:318` 与 `StatusOverview.vue` 的正确做法，说明是遗漏而非能力问题。
- **建议**：能换 `<button type="button">` 的一律换（三处都可以，CSS 补 `background:none;border:none;text-align:left;width:100%`），不能换标签的照 `StatusOverview` 补 `tabindex="0"` + `role="button"` + `@keydown.enter` + `@keydown.space.prevent`；并在 `eslint.config.js` 挂 `eslint-plugin-vuejs-accessibility` 的 `click-events-have-key-events` / `no-static-element-interactions` 把余下 40 处一次暴露。

#### 🟡 [medium] 组件内 57 处硬编码颜色，代码块与好感度色系写死深色配色

- **位置**：src/ui/components/game/CharacterListPanel.vue:1167 / :580，src/ui/components/game/ItemsPanel.vue:762，src/ui/components/game/MapPanel.vue:1517
- **问题与影响**：`.script-code` 把 GitHub 深色配色 `background: #0d1117; color: #c9d1d9;` 在 `CharacterListPanel.vue:1167-1168` 与 `ItemsPanel.vue:762-763` 各写一遍（连 font-family 都只差一个字体名）；好感度/命运点数色系写死 `#c084fc`/`#a78bfa`/`#ef4444`，且 `:928`/`:931` 重复一遍。其余分布在 MapPanel.vue 13 处、CharGenSystemCard.vue 9 处、PackInstallConfirmModal.vue 7 处、StatusOverview.vue `#f0ebe1`。在 parchment/ivory/misty-lilac/forest/ocean 等浅底主题下，黑底代码块像补丁一样嵌在米色纸面里，近白文字直接看不见；正负好感色在 crimson/sakura 等强色调主题里与调性冲突。验证员确认替代 token 真实可用（`variables.css:43 --theme-error`、:50-52 `--theme-affection` 系列），建议可执行。
- **建议**：把两份 `.script-code` 合并进 `styles/cards-shared.css` 并改用 `var(--theme-surface-muted)` + `var(--theme-text-secondary)`，好感度改 `var(--theme-affection)` / `var(--theme-error)`，近白文字改 `var(--theme-text-primary)`；把「components 下不出现裸 hex」并入下一条建议的设计闸门。

#### 🟡 [medium] design.md 声称的「design hook 强制扫描」并不存在

- **位置**：docs/design.md:24，eslint.config.js:23，tests/theme-fonts-invariant.test.ts:6
- **问题与影响**：`docs/design.md:24` 标题写着「绝对禁令（design hook 强制扫描）」，但 `.claude/` 下只有 `agent-memory/ agents/ launch.json workflows/ worktrees/`，无 `settings.json`、无任何 hooks；ESLint 无自定义 CSS/设计规则也无 a11y 插件；`tests/` 里与设计规范沾边的只有 `theme-fonts-invariant.test.ts` 与 `theme-surface-ownership.test.ts`。本轮仅靠几条 grep 就查出 1088 处间距硬编码、57 处裸 hex、20 余处未定义 token、2 处布局属性过渡，全部落在那张「强制扫描」表内。文档写着有闸门而实际没有，比明说没有更糟：写代码的人（含 AI agent）会把「没红」当成合规。本仓其他地方（编码不变式、knip 棘轮、字体不变式）已把「规范→CI 断言」走通，唯独最高频的设计规范停在文档层。
- **建议**：新建 `tests/design-invariants.test.ts`，逐条机检——token 必须有定义、components 无裸 hex、无 `background-clip: text`、`transition` 不含 width/height/max-height/padding、`border-left/right` 不超过 1px（themes/ 白名单）、间距 px 走棘轮；同时把 design.md:24 的标题改成指向该测试的真实说法。

#### ⚪ [low] 共用 Tab 基元 `AppTabs` 无 tab 语义，24 个 tab 面里只有 1 个正确

- **位置**：src/ui/components/shared/AppTabs.vue:29，src/ui/components/settings/assets/AssetLibrary.vue:228
- **问题与影响**：`AppTabs.vue:29-38` 渲染裸 `<button class="tab-item">`，选中态只在 class 上，容器无 `role="tablist"`、按钮无 `role="tab"` / `:aria-selected`，也无左右方向键导航。全仓 `aria-selected` 与 `role="tab"` 各只有 2 处，全部集中在 `AssetLibrary.vue:228-243` 的手写实现（注释自称遵循 design.md §4.3），而 class 名含 `tab` 的组件有 24 个，两套语义并存。验证员认定影响被夸大：底层是真 `<button>`，可聚焦、可回车/空格激活、能拿到全局焦点环，功能对键盘用户是通的，缺的只是屏幕阅读器的「第 2 项，共 5 项 / 已选中」播报与左右键导航这层增强，故由 medium 降为 low。
- **建议**：在 `AppTabs.vue` 一处补 `role="tablist"` / `role="tab"` / `:aria-selected` / roving `tabindex` 与 `@keydown.left/right`，内容面板加 `role="tabpanel"` + `aria-labelledby`，并把 `AssetLibrary.vue:228` 的手写实现换成 `AppTabs`。

#### ⚪ [low] 组件直接 import `@engine/database` 绕过 store 层

- **位置**：src/ui/components/create/PresetModal.vue:4，src/ui/components/home/HomePage.vue:46，src/ui/components/game/MapPoliticalTab.vue:887，src/ui/components/game/MemoryPanel.vue:4，src/ui/components/game/SnapshotPanel.vue:4
- **问题与影响**：`components/` 下 143 处 `from '@engine/...'`，其中 6 处直接取 Dexie 层，含 `saveCreatePreset`、`deleteSaveSlot`、`importAllData` 等写操作；这些写不进统一的失败处理，组件测试需 mock 整个 `@engine/database`。验证员核实引用位置全部属实，但推翻了「与分层约定相悖」的定性：`src/ui/AGENTS.md` 的「唯一入口」全是逐域声明（世界书 :203 / 美化规则 :205 / sceneImages :207 / per-Agent 设置 :195），捏人预设、存档槽、memory、snapshot 都不在其中；同文件 :241 反而明载了一条直连豁免；把 ADR-21「StateManager 为唯一写入入口」套 `deleteSaveSlot`/`importAllData` 属误引（ADR-21 管 chat state 经 `commitChatState()`）；「不在测试覆盖里」也不准，`MemoryPanel.test.ts:28` 即 mock 后测组件。剩余成立的是「写操作散在组件里、缺统一失败处理」这一可维护性观察，故降为 low。
- **建议**：给存档增删/导入、捏人预设、记忆/快照读删各补一个薄 store 方法，`MapPoliticalTab.vue:887` 的动态 `getDatabase()` 下沉到 `lib/map-*`。

#### ⚪ [low] 9 个组件超过 1000 行，最大 MapPoliticalTab.vue 1863 行

- **位置**：src/ui/components/game/MapPoliticalTab.vue:1，src/ui/components/game/MapPanel.vue:1，src/ui/components/home/HomePage.vue:1，src/ui/components/game/CharacterListPanel.vue:1
- **问题与影响**：行数（total/script/style/template）：MapPoliticalTab 1863/1020/590/253、MapPanel 1545/497/719/329、HomePage 1498/343/812/343、StatusOverview 1294、CharacterListPanel 1283/100/733/450，另有 CharacterViewerModal 1248、WorkshopBrowseModal 1066、SceneImageSegment 1061、ScenePanel 1026。`MapPoliticalTab` 的 script 段有 40+ computed 与 30+ 函数（`ensureTintSource:556`/`paintTint:594`/`onPointerMove:711`/`loadBaseArt:878` 等），尽管 `lib/map-political.ts` 已承接全部纯逻辑。对照 `settings/` 目录 14 个分区最大只有 858 行，同仓两套标准。验证员核实前五个文件行数一字不差，但指出仓库并无「单文件不超过 N 行」的成文约定，审查员自己也承认需要先定线，即规则尚不存在不应按违规计，故降为 low。
- **建议**：把 `MapPoliticalTab` 的指针交互抽成 `composables/usePoliticalStageView.ts`、画布绘制抽成 `lib/map-political-paint.ts`，`CharacterListPanel` 按列表/详情/脚本块拆三个子组件；先定一条可执行的行数线并做成棘轮闸门。

#### ⚪ [low] 两处布局属性过渡违反 design.md §1，其中一处在共用资源条基元里

- **位置**：src/ui/components/shared/ResourceBar.vue:59，src/ui/components/create/PlotOutlinePreview.vue:218
- **问题与影响**：design.md:29 禁令表明写「布局属性过渡 `transition: width/height/max-height/padding`」→ 替代 `transform: scaleX()`。全仓正则扫描（排除 `transition: all`）恰好命中且仅命中两处：`ResourceBar.vue:59 transition: width 250ms ease;`（HP/MP/SP/EXP 条，游戏页每回合都在跑）与 `PlotOutlinePreview.vue:218 transition: width 0.3s ease;`（大纲流式进度条）。`width` 过渡每帧触发 layout + paint，资源条在战斗回合里多条同时动画是最易察觉掉帧处。
- **建议**：两处改成 `transform: scaleX(var(--fill))` + `transform-origin: left`（外层裁剪）并过渡 `transform`；这条零违反的规则最适合作为设计闸门的第一条断言。

#### ⚪ [low] 17 处字号降到 8-9px，且一处用 px 绕过设置页字号缩放

- **位置**：src/ui/components/game/combat/CombatActionCard.vue:903，src/ui/components/game/StatusOverview.vue:1112，src/ui/components/game/ScenePanel.vue:593，src/ui/components/game/MapPanel.vue:1531
- **问题与影响**：`0.5rem`（8px）三处、`0.5625rem`（9px）十一处（StatusOverview 849/1106、CharacterListPanel 690/719、CombatHeader 153、TurnActivityLedger 356/416、DebugPanel 520/647、MapPanel 1164、CharGenSystemCard 503），另 `MapPanel.vue:1531 font-size: 10px`。位置集中在战斗行动卡、状态总览、场景栏、地图这类需要一眼扫读的面。验证员核实数值基本准确（PlotOutlinePreview.vue:351 实为 `0.55rem`，被并入统计），但推翻了「违反字号层级表」的定性：`docs/design.md:74` 原文是「小字/徽章 `0.6875rem` (11px) **以下**」，字面上把 11px 及更小划入该档，`0.5rem` 并未越界；审查员自己也承认这是建议改文档。唯一硬成立的子项是 `MapPanel.vue:1531` 用 px——已核实 `theme-store.ts:130` 靠 rem 缩放，那处确实不跟随设置页字号调节。
- **建议**：先把 `MapPanel.vue:1531` 的 `10px` 改成 rem；若确认 11px 为硬下限，在 design.md §2.2 表下补明措辞后再统一上提 `0.5rem`/`0.5625rem`。

#### ⚪ [low] 触摸目标低于 design.md §4.1 的 36px，含所有弹窗关闭按钮

- **位置**：src/ui/components/shared/AppModal.vue:184，src/ui/components/settings/agent/PresetManager.vue:711
- **问题与影响**：design.md:146 与 :433 检查清单均要求触摸目标 ≥ 36px 高。硬成立的两处：`AppModal.vue:183-186 .modal-close { width: 28px; height: 28px; }`（26 个弹窗共用、且 `bare` 档去掉页头后关闭全靠调用方自备）与 `PresetManager.vue:709-711 .subprompt-edit-btn { 24px }`。对照 `AudioMixer.vue:482-484 .icon-btn { min-width: 36px; height: 36px }`，说明规范在音频分区被执行过。验证员推翻了另两处引证：`ThemeSection.vue:169-177` 的 22px 是 `position: absolute` 的选中态勾选角标，纯装饰无点击处理器；`WorldBookEditor.vue:565/573` 的是开关轨道，真正的 `<input type="checkbox">` 以 `opacity: 0` 覆盖在整个 `<label>` 上、命中区已达标。因此「显式 20-35px 高度 32 处」这个口径是按 CSS 尺寸盲扫的，可信度需打折，仅「所有弹窗关闭按钮」这半句成立。
- **建议**：`.modal-close` 保留 28px 视觉但把命中区撑到 36px（直接放大尺寸或用 `::before { inset: -4px }` 扩热区），`PresetManager` 的 24px 按钮同理加 padding 撑热区。

## 10. 数据层与持久化

### 总评

这一维度整体健康度偏高，属于「纪律已经建立、只剩边角未覆盖」的状态。Dexie schema 跨 21 个版本 29 张表，升版链有真正的回归测试守着（database.test.ts:2255 起以冻结的 v12 schema 写入再用当前版打开，逐表断言数据未丢）；FullBackup 的三态导入语义、双重文件校验闸门、单存档导入「一律重发 id」的映射契约，都不是事后补的，而是把真实败法写进注释再据以设计的。await 纪律与 ADR-21 单写入口在全仓 grep 下几乎零漏网。最要紧的问题集中在三处：最热的写路径 `commitChatState` 是全仓唯一没有事务包裹的批量落库入口；快照回退漏掉了 `characterAppearances` / `sceneImages` 两张同属「每存档」的表；以及「整库备份」实际上不含 localStorage 里那一整袋 Agent/预设/图像设置。三条经对抗验证后都从 high 降到 medium——都有兜底或触发条件较窄，但都属于「不报错、只让状态悄悄不对」的类型，排查成本高于修复成本。其余七条是纪律裂口与可维护性问题，可以排进常规清理。

### 量化底账

- 扫描范围：`src/sillytavern` 引擎层 269 个 .ts + 前端层（stores 56 / lib 54 / composables 15 / components 231）。
- 核心文件体量：database.ts 2025 行（测试 2354 行）、state-manager.ts 2408 行、session-backup.ts 854 行（测试 1085 行）、save-profile.ts 326 行、db-write.ts 41 行。
- Schema：29 张表 / 21 个版本（v1–v12 全量手写冻结，v13 起 withSchema delta，v18 为唯一纯数据版）。
- FullBackup 覆盖 20 张表、排除 9 张（音频 4 / 素材 2 / sceneImageBlobs / contentPacks / mapBlobs），逐一核对后全部有成文理由。
- await 纪律：grep 未发现任何未 await 的 Dexie 写调用或悬空持久化 Promise（8 个入口零漏网）。
- ADR-21：引擎侧裸 `db.<表>.put/delete` 在 database.ts 与 session-backup.ts 之外零命中；UI 侧跨表越界写仅 content-store 的 2 处 `db.saves.put`。
- 事务：全仓 30 处 `db.transaction`，deleteSaveSlot / restoreSnapshot / importSessionSave / 六段 doImportAllData / 三个 localStorage→Dexie 迁移均已包裹，唯 `commitChatState` 未包。
- findings 共 10 条（原判 3 high / 5 medium / 2 low；验证后修正为 3 medium / 7 low）。

### 亮点

- FullBackup 导入侧的三态语义（undefined=整表不动 / []=清空 / 有数据=覆盖）在 v14–v19 五段事务里逐段贯彻，且每段都把「为什么不能写成先 clear 再 if」写在守卫上方（database.ts:915-993），直接堵死「恢复旧备份静默抹掉全部世界书」这类不可逆事故。
- 导入前有双重闸门：UI 侧 `isFullBackupFile` 认形状（session-backup.ts:188-195），引擎侧 `validateBackupOrThrow` 验类型（database.ts:768-804），注释点明了「只看 version 是数字会让一张角色卡把整个库清空」这条真实败法。
- 级联删除与回退都是事务化的：`deleteSaveSlot`（database.ts:1456-1491）与 `restoreSnapshot`（state-manager.ts:1511-1570）各用单个 `db.transaction` 包住全部相关表，后者还额外清理未来记忆与未来快照。
- 单存档导入的 id 重发契约执行彻底：IdMap 惰性分配与 `peek` 严格查表两种语义分开使用，快照内嵌副本用同一套映射改写（session-backup.ts:775-787）；工坊条目跨机身份重定向（session-backup.ts:64-73、238-250、597-614）识破了「uid 由本机分区游标发号」的陷阱，身份键用 `JSON.stringify([id, uid])` 而非拼串。
- 记忆编号分配复用 `allocateMemoryIds` 并刻意用 `primaryKeys()` 而非 `toArray()`（session-backup.ts:829-832），避免把 4096 维 embedding 整份读进内存。
- `db-write.ts` 把「落库前切断 Vue Proxy」收敛成 detach/stamped/omit 三个函数，并解释了为何不能换成 toRaw+structuredClone——治的是类型系统看不见、只在运行时炸 DataCloneError 的不变式。
- `reconcilePackState`（database.ts:1059+）恢复后对 pack 拥有项做只读对账，失配只报 needs_attention 不自动改任一边；`worldFlags` 两个子袋各有命名写入口（save-profile.ts:275、317）并解释了为何用整份覆盖而非逐字段合并。

### 问题清单

#### 🟡 [medium] commitChatState 逐条落库、无事务包裹——一批补丁中途失败会留下半应用状态

- **位置**：src/sillytavern/state-manager.ts:278、src/sillytavern/state-manager.ts:1511、src/sillytavern/database.ts:1456
- **问题与影响**：ADR-21 唯一写入口的主循环（state-manager.ts:278-292）在 for 内 try/catch 吞掉单条失败并 push `{success:false}`，循环外没有任何 `db.transaction`，而每个 `applyPatch` 分支内部各自落库（`await saveCharacter(char)` 17 处，`applyUpdateQuest` 走 `setQuest`→`updateProfile` 整份 put）。AI 一轮的补丁常是成对语义（remove_item + add_item 的交易、transfer 的双方、扣资源 + 发奖励），第二条抛错时第一条已永久落库，调用方拿不到任何回滚手段，玩家侧表现为物品消失/复制、资源被扣但奖励没发且不报错。对照 `restoreSnapshot`（1511）与 `deleteSaveSlot`（database.ts:1456）都明确事务化并注明「杜绝半删存档」，最热写路径反而裸奔。验证员核实主循环与对照均逐字属实（全文件 `db.transaction` 仅 1 处命中），仅 saveCharacter 计数应为 17 次而非 18 次；因每回合有 `reason:'turn'` 快照可回退、且触发需补丁中途抛错，按可恢复性降为 medium。
- **建议**：把 patches 循环包进覆盖 characters/saveProfiles/plotEvents/messages/saves 的 `db.transaction('rw', ...)`；若要保留「部分成功也算数」的现行语义，至少提供 `atomic: true` 选项供交易/转移类补丁使用并让失败 rethrow 触发回滚（注意事务内不能 await 非 Dexie Promise，`reactToEvents` 的动态 import 需提到事务外）。

#### 🟡 [medium] 快照回退不回滚 characterAppearances / sceneImages，与该表的「每存档数据」定性自相矛盾

- **位置**：src/sillytavern/state-manager.ts:1511、src/sillytavern/types.ts:1263、src/sillytavern/database.ts:1467、src/sillytavern/session-backup.ts:406
- **问题与影响**：`Snapshot` 类型（types.ts:1263-1285）只含 `characters / saveProfile / plotEvents? / messages?`，`restoreSnapshot` 的事务表清单（state-manager.ts:1512-1520）也不含 `characterAppearances`，全文件 grep `characterAppearance|sceneImage` 零命中。而 `deleteSaveSlot`（database.ts:1467-1488）把两张表都按 saveId 连带删并注明「v19 (D56): 会话外貌随存档走」，`exportSessionSave`（session-backup.ts:405-406）也按 saveId 整取。后果是回退一轮后，被撤销那轮里出图 AI 写进 `characterAppearances` 的外貌变化仍留在库里，成为没有叙事背书的「未来事实」，下次出图照着已撤销的剧情画；该轮 `sceneImages` 记录挂在已删 messageId 上成为图鉴孤儿。两者都不报错。验证员逐字核对类型、事务清单与反向对照全部成立；因受影响面仅限出图外貌与 CG 图鉴、不污染叙事与账务状态，降为 medium。
- **建议**：要么把 `characterAppearances` 纳入 Snapshot 深拷贝并在 restoreSnapshot 事务里整档覆写，要么照 `deleteMemoriesAfter` / `deleteSnapshotsAfter` 的先例按 `createdAt > snapshot.createdAt` 清理本档会话外貌与 sceneImages，并补一条「回退后本档外貌不含未来变化」的断言。

#### 🟡 [medium] 整库备份只导 IndexedDB，localStorage 里的 UI/Agent 设置一律不进

- **位置**：src/ui/components/settings/DataSection.vue:306、src/ui/stores/settings-store.ts:445、src/sillytavern/database.ts:693
- **问题与影响**：`exportAll()`（DataSection.vue:305-315）全部内容就是 `exportAllData()` + Blob，而 `exportAllData`（database.ts:693-761）只读 20 张 Dexie 表。真源在 localStorage 的那袋设置由 settings-store.ts:445 独立持久化（`STORAGE_KEY = 'fated-poem-settings'`），含 `agents`（12 个 Agent 的 systemPrompt/模型/世界书开关）、`activePresetId`、`imageDialectOverrides`、`imageNovelai`/`imageComfy`、主题、`placeholderVersion`。换机导入后 Dexie 数据回来了，但 Agent 提示词定制、选中的 story 预设、出图后端与方言、主题全部退回默认，症状是「AI 行为变了、图画得不对」而存档看着完好，排查方向被带偏；且 database.ts:628-631/841 自陈 `settings` 表已是死表，备份里那个 settings 数组不是真源。验证员确认导出路径完全不碰 localStorage，但影响需打折：导出按钮说明（DataSection.vue:417）只承诺「所有存档、角色、记忆、剧情」，444 行那句「IndexedDB + localStorage」是存储用量卡口径、说它为导出背书属于引申；另外序列化会抹掉 apiKey（settings-store.ts:112-122），真做进备份还需处理密钥，故定 medium。
- **建议**：在 `FullBackup` 上加 `uiSettings?: Record<string, unknown>`（沿用三态语义，缺席=不动本机设置），导出时塞入该袋、导入后交给 settings-store 现成迁移链并单独处理密钥；若决定不做，就把导出说明明确改成「不含界面与 Agent 设置」。

#### ⚪ [low] DB_VERSION 与最后一个 this.version(n) 之间缺少常量级闸门

- **位置**：src/sillytavern/database.ts:96、src/sillytavern/database.test.ts:857
- **问题与影响**：database.ts:87-96 自陈曾经落后过两版（v18/v19 都忘了改），当时的测试断言把漂移固定了下来而非拦下。今天 database.test.ts:857 的 `expect(backup.version).toBe(21)` 比对的仍是 `FullBackup.version` 与手写字面量。验证员核实「没有机器闸门」不成立：database.test.ts:2304 已有 `expect(db.verno).toBe(21)`，即 finding 推荐的 Dexie verno 断言，新加 `this.version(22)` 会当场变红。残留缺口只剩一种窄情形——改了 2304 的字面量却仍漏改 DB_VERSION（两个字面量互不牵引），故降为 low。
- **建议**：把 2304 行的断言改成 `expect(db.verno).toBe(DB_VERSION)`，让两个数字互相牵引即闭环。

#### ⚪ [low] content-store 用裸 db.saves.put 绕过 saveSaveSlot 写存档主记录

- **位置**：src/ui/stores/content-store.ts:1162、src/ui/stores/content-store.ts:1481、src/sillytavern/database.ts:1446
- **问题与影响**：两处均为 `save.metadata = writePackSelectionMetadata(...); await db.saves.put(save);`，绕过了会刷 `updatedAt` 的命名写入口 `saveSaveSlot`（database.ts:1446-1450）。P1-09 受控例外只列了 SaveProfile 的 `focusQuest` / `news[].read` 两项，saves 表不在其中；全库 grep `saves.put` 命中 4 处，确认该表已有多个写者。验证员指出两点打折：finding 提到的排序函数名不存在（实际是 database.ts:1432-1437 的 `getSaves()`）；且装/卸内容包后台改 metadata 时不刷 `updatedAt` 恰是合理语义，不该把存档顶到列表最前。实际风险是纪律裂口而非行为缺陷，降为 low。
- **建议**：在 database.ts 开一个具名的 `updateSaveMetadata(id, metadata)` 把「改 metadata 不动 updatedAt」这个意图写进签名，调用点改调它，恢复 saves 表单一写者。

#### ⚪ [low] QuestsPanel 从内存 store 快照整份覆盖写 SaveProfile，存在丢失更新窗口

- **位置**：src/ui/components/game/QuestsPanel.vue:20、src/sillytavern/save-profile.ts:32、src/sillytavern/state-manager.ts:1315
- **问题与影响**：watch 里 `profile.focusQuest = v; await updateProfile(JSON.parse(JSON.stringify(profile)))`，`profile` 是 `game.saveProfile` 这个长期驻留的 reactive 引用，整份 put 回库；引擎侧每条 quest/affection/vars 补丁则是现读现改现写（state-manager.ts:1315）。两条路径都是整份覆盖、无版本号无乐观锁，玩家在 AI 回合中调整焦点任务时可能把本轮刚写入的 quests/变量/好感度/gameTime 整份写回旧值，界面上只表现为「进度回退一格」。验证员核实原文与两侧写法均属实、窗口理论上真实存在，但触发条件很窄（须在引擎已落库而 UI 尚未 refreshFromDb 的一小段里恰好改焦点任务），且写法本身走的是 P1-09 要求的 `updateProfile()` 而非裸 put，属规范内瑕疵，降为 low。
- **建议**：改成先 `getProfile(saveId)` 取库里最新一份再只改 focusQuest 写回；或在 save-profile.ts 加窄入口 `setFocusQuest(saveId, name)`（形状照 `updateMapFlags` / `updateRandomEventFlags`），让 UI 永不持有整份 profile 去写。

#### ⚪ [low] importAllData 的失败回滚靠把整个库读进内存做预备份，含 4096 维 embedding

- **位置**：src/sillytavern/database.ts:813、src/sillytavern/database.ts:693、src/sillytavern/types.ts:1181
- **问题与影响**：database.ts:811-825 先 `const previousData = await exportAllData()` 再 try/catch 回灌，而 `exportAllData` 用 `Promise.all` 一次性 `toArray()` 全部 20 张表，其中 `MemoryRecord.embedding?: number[]` 默认 4096 维（types.ts:644）。同一问题在 session-backup.ts:829-831 已有明确警示（「只要 id 就别 toArray()」）。低配机上导入内存峰值抬高，而崩溃窗口恰在「已开始 clear 表、回滚数据只在内存里」这段。验证员核实代码与注释（含自陈「6 个独立事务跨段不原子」）全部属实，但影响完全是推测性的、无实测内存数据；导入本身已把整份备份 JSON 解析进内存，预备份只把峰值从约 1x 抬到 2x，非数量级变化，且它是回滚机制的必要代价，故定 low。
- **建议**：把预备份落到临时 Dexie 表（或改成写影子表、成功后原子换名）；退一步至少在预备份里排除 `memories.embedding`（回滚后可重算），并把「6 段独立事务 + 内存回滚」在注释里明确标为已知限制。

#### ⚪ [low] 任务状态枚举泄漏：'未开始' 不在 QUEST_STATUSES，createDefaultQuest 写空串，「活跃任务」谓词三处各写一遍

- **位置**：src/sillytavern/field-enums.ts:33、src/sillytavern/types.ts:2916、src/sillytavern/save-profile.ts:194、src/sillytavern/context-visibility.ts:613、src/ui/components/game/QuestsPanel.vue:50
- **问题与影响**：`QUEST_STATUSES` 只有四态且无 '未开始'，`createDefaultQuest()` 返回 `status: ''`，QuestsPanel.vue 在 50/56/118/134/172/182 六处用 `q.status || '未开始'` 渲染并据此建筛选器，凭空造出一个 `normalizeQuestStatus` 永远产不出的分组；「活跃任务」判定被硬编码三份（save-profile.ts:194、context-visibility.ts:613、QuestsPanel.vue:56）。`normalizeQuestStatus` 只在 `questFields.status !== undefined` 分支跑，新建任务的空串绕过归一化。这同时触犯铁律 5 的三个面：库里存在枚举外值、界面显示枚举外值、判定逻辑拷贝三份，将来调整 '搁置' 归属要改三个文件且漏一个不报错。验证员逐条核对全中；因三处谓词今天语义一致、空串只造成显示不一致（UI 兜底 '未开始'、context-visibility.ts:618 兜底 '进行中'）而不导致数据错误，属规范与可维护性问题，降为 low。
- **建议**：在 field-enums.ts 增设唯一谓词 `isActiveQuestStatus(status)`（或 `INACTIVE_QUEST_STATUSES`）供三处共用；`createDefaultQuest` 的 status 改成 '进行中'；UI 的 `|| '未开始'` 要么删掉，要么把该值正式加进枚举与别名表。

#### ⚪ [low] 单存档导入时 sceneImages.messageId 走惰性分配，消息缺席就指向凭空造出的 UUID

- **位置**：src/sillytavern/session-backup.ts:793、src/sillytavern/session-backup.ts:756、src/sillytavern/session-backup.ts:558
- **问题与影响**：重映射用 `msgIds.get(img.messageId)`，而 `IdMap.get`（558-568）查不到即 `crypto.randomUUID()` 现场分配。同一文件对同类可能悬空的引用刻意用 `peek`：`activeSnapshotId`（756-758）注明「严格查表：快照不在本备份里 → 置 null（惰性分配会造出一个指向虚空的 id）」，`remapSoftRefs`（583-586）同样只用 peek。插画锚定的消息若已被回退删除（并不罕见），导入后该记录挂着库里绝不存在的 messageId，正文永远渲染不到而 CG 图鉴仍会列出。验证员确认同文件内的双标准属实，危害评估诚实，low 定级合适。
- **建议**：改成 `messageId: msgIds.peek(img.messageId) ?? img.messageId`；若确实刻意要新 UUID，把理由写在调用点旁，别让它看起来像漏用了 peek。

#### ⚪ [low] 新建存档的 slot 硬编码 0，与单存档导入的 maxSlot+1 分配互不相干

- **位置**：src/ui/stores/create-store.ts:1818、src/sillytavern/session-backup.ts:825、src/sillytavern/database.ts:1442
- **问题与影响**：create-store 建档时 `slot: 0, // TODO: 自动分配空闲槽位`，而 session-backup.ts:816-825 认真算了 `maxSlot + 1`。于是玩家自建存档 slot 恒为 0，只有导入的才递增，按槽位寻址的 `getSaveBySlot`（database.ts:1442，`where('slot').equals(slot).first()`）在多存档下返回「碰巧第一条」。验证员核实三处证据全对，但影响需打折：`getSaveBySlot` 全仓生产调用方为零（仅定义处与 database.test.ts:41/665/667 三处测试引用），今天不存在错误寻址；且 `getSaves()` 按 updatedAt 排序不依赖 slot，存档列表不受影响，属未来隐患与死代码问题。
- **建议**：把 maxSlot 计算提成 `allocateSaveSlot()` 放进 database.ts 供两个建档入口共用；或承认 slot 已无语义，删掉 `getSaveBySlot` 并把字段标为遗留——不要继续维持「一半认真一半 TODO」。

## 11. 文档与约定一致性

### 总评

这个维度整体健康度良好，问题集中在「文档追不上代码迁移」而非「文档写得差」。全量扫描 175 个 tracked `.md`（其中 `docs/` 116 份）、约 1.4 万处链接与路径引用逐条 stat 校验，Markdown 链接形式（`[文字](路径)`）**零死链**，根 `AGENTS.md`「文档导航」树点名的 30 个 `docs/` 路径**全部存在**，`CONTEXT.md` 词条与 `src/` 术语抽查 6 条全部命中，`TODO.md` 8 条待办均确为未完成、无需搬迁。这套「AGENTS.md 为指令正文真源 + 两份分册就近放在代码目录 + CLAUDE.md 薄壳导入」的分层设计本身是可靠的，墓碑注释、编码不变式 CI 化、CHANGELOG 分工声明都是同类项目里少见的自律。

真正要紧的是三处**常驻指令文件里的失效引用**：`data/` → `public/data/` 的迁移没有同步进文档（波及「必须跑」的编码验证命令与引擎分册四处内容包路径）；`npm run build` 的语义被写反且本地闸门清单缺 `typecheck:vue` / `typecheck:tools` 两道；`docs/ARCHITECTURE.md` 整篇描述的是一个已不存在的系统（React 界面、Vanilla Store、v2 战斗），却仍被导航标为「完整软件+世界观架构」而无过期提示。这类漂移的破坏方式是「不报错，但照着不存在的路径写新代码」，与仓库自己在分册开头写下的告诫完全吻合。此外，`reference/` 整树已 gitignore、公开仓不存在，但两节「必读」指令没有像叙事规范那节那样补迁移说明，`.github/pull_request_template.md` 与 `.claude/workflows/audit-code.js` 也仍在依赖这些文件。

### 量化底账

- 175 个 tracked `.md`，`docs/` 下 116 份；Markdown 链接形式死链 **0**。
- 反引号路径引用剔除 `:行号` 误报后仍有约 **200 个唯一失效目标**，绝大多数落在 `docs/planning/` 历史设计文档（归档性质，可接受）；有害部分集中在常驻指令文件：根 `AGENTS.md` 7 处、`src/sillytavern/AGENTS.md` 5 处、`docs/reference/debug-loop-handbook.md` 5 处、`docs/ARCHITECTURE.md` 整篇。
- 命令与闸门核对：9 个 npm 命令中 **1 条语义写错**、**4 条 CI 闸门未收录**（验证员核定真正缺失的是 2 条）。
- 文档数字滞后实例：README 写「30+ 模块」，实为 `src/sillytavern/` 131 个非测试模块 + `combat-v3/` 74 个文件；`ARCHITECTURE.md` 写「16 组件」，实为 `src/ui/components` 下 127 个 `.vue`。

### 亮点

- Markdown 链接零死链，含中文文件名的 `docs/《命定之诗》内容二创与素材使用授权协议.md` 也可正常解析。
- 分册拆分机制设计得当且自带使用说明：`src/sillytavern/AGENTS.md` 与 `src/ui/AGENTS.md` 就近放在所描述的代码目录，同目录 `CLAUDE.md` 薄壳自动导入，根 `AGENTS.md`「🔴 各工具怎么读」一节明确区分 Claude Code 与只读根文件的工具。
- 引擎分册用 🪦 墓碑注释显式记录已删文件（`src/sillytavern/AGENTS.md:169` start-catalog-data.ts、`:373` variables.ts/vars-merger.ts、`:384` sillytavern-store.ts）并写明「别按图找那个文件」，主动防止按过期地图改代码。
- 编码不变式已从文档纪律升级为 CI 断言：`tests/encoding-invariants.test.ts` 把 U+FFFD / 控制字符 / JSON 可解析三条判据变成可执行闸门，`AGENTS.md` 也如实标注「2026-08-05 起这条已自动化」。
- `CONTEXT.md` 词条与代码术语高度一致：regexStorage / 锚地块 / 候选池 / 足迹 / AI 赢 五条抽查均在实现或测试中原样出现（如 `map-index.ts` 的「锚地块」、`random-event-scheduler.ts` 的「足迹」）。
- CHANGELOG 分工规则清楚且被遵守：`docs/CHANGELOG.md` 开头声明「AGENTS.md 只保留 ≤30 行速览表，历史在这里」，最新条目 2026-08-16 与 HEAD 同步；`TODO.md` 8 条待办新鲜度良好，文首规定「做完的搬去 CHANGELOG，已知缺陷归 known-issue.md，不要三处重复」。
- `.github/workflows/ci.yml` 注释详尽记录了三 job 拆分的实测耗时、为何不拆成八个、两个前提条件（public 仓免费分钟数 / master 无分支保护），是高质量的决策留痕。

### 问题清单

#### 🟡 [medium] `data/` → `public/data/` 迁移未同步进文档，波及「必须跑」的编码验证命令与引擎分册内容包路径

- **位置**：`AGENTS.md:48`、`AGENTS.md:68`、`src/sillytavern/AGENTS.md:75`、`:87`、`:170`、对照 `tests/encoding-invariants.test.ts:45`
- **问题与影响**：仓库根没有 `data/` 目录（`.gitignore:33` 有 `/data/` 整树排除），真实位置是 `public/data/`——`public/data/defaults/agent-config.json`、`public/data/content/catalog.json`、`image-dialects.json`、`random-events.json` 均在。但 `AGENTS.md:48` 仍写「提示词（`data/defaults/agent-config.json`）」、`:68` 写「扫 `data/` 与 …」，引擎分册 `:75` `:87` `:170` `:244` 四处内容包路径同样滞后。测试自己已经改过来了：`tests/encoding-invariants.test.ts:45` 是 `join(REPO_ROOT,'public','data')`，`:33-34` 注释写明「占位从 data/placeholder 迁入 public/data，URL 不变 `/data/*`」。`AGENTS.md` 那节正是「🔴 改中文文本之后必须验编码（每次）」的铁律，示例路径打不开会导致跳过验证或先花时间找文件；最坏结果不是报错，是照着不存在的路径写新代码或新脚本。
- **建议**：把上述 6 处 `data/xxx` 统一改成 `public/data/xxx`，并在 `AGENTS.md:68` 补一句「URL 仍是 `/data/*`，磁盘路径是 `public/data/`」，防止下一轮又改回去。

#### 🟡 [medium] `AGENTS.md`「常用命令」把 `npm run build` 的语义写错，并漏收两道本地闸门

- **位置**：`AGENTS.md:254`（命令块 251-270）、`package.json`、`vite.config.ts:239`、`.github/workflows/ci.yml`
- **问题与影响**：`AGENTS.md:254` 写 `npm run build # 编译 TypeScript (tsc) → dist/`，而 `package.json` 里 `build = vite build`（产物见 `vite.config.ts:239` `outDir: 'dist-ui'`），tsc 编译是另一条 `build:engine`。按文档跑会拿到前端包而非引擎产物，排查方向被带偏。同时命令块只收录 build/typecheck/test/lint/knip/dev，而 CI 的 types job 跑 `typecheck` + `typecheck:vue` + `typecheck:tools` + `build`——`typecheck:vue` / `typecheck:tools` 在命令块中零出现，意味着 `.vue` SFC 与 `server/`、`tests/`、`*.config.ts` 的类型错误本地全测不到（主 tsconfig 只 include `src/**`）。验证员核实核心事实成立，但「四条闸门全缺」被夸大两条：`format:check` 在 `AGENTS.md:32` 已有明确要求（只是不在命令块里），`AGENTS.md:257` 的 `npm run test -- --run` 与 `test:run` 等价，真正缺的是 `typecheck:vue` / `typecheck:tools`，故降为 medium。
- **建议**：`:254` 改为 `npm run build # Vite 打包前端 → dist-ui/` 并补 `build:engine # tsc → dist/`；命令块按 CI 三个 job 顺序补齐 `typecheck:vue` / `typecheck:tools`，并加一句「本地提交前的闸门集合 = ci.yml 三个 job 的全部步骤」。

#### 🟡 [medium] 两节标为「必读」的 `reference/` 参考资料已整树 gitignore、公开仓不存在且无迁移说明

- **位置**：`AGENTS.md:176`、`AGENTS.md:213`、`.gitignore:36`、`.github/pull_request_template.md:7`、`.claude/workflows/audit-code.js:62-64`
- **问题与影响**：`AGENTS.md:178` 要求「涉及所有游戏内部改动时必须先查阅 `reference/world_book_index.md`」，`:213-220` 列出 `reference/home_index.html` / `custom_start_index.html` / `status_index.html` 为前端必读。实际 `ls reference/` 只剩 `_local-notes/` 与 `workshop-reference/`，`.gitignore:36` 有 `/reference/` 整树排除，上述文件全部不存在。同样路径还被 `.github/pull_request_template.md:7` 的勾选项和 `.claude/workflows/audit-code.js:62-64` 依赖——CLAUDE.md 推荐在 Phase 完成前运行的 `audit-code` workflow 会直接扑空，PR 模板那两条是不可执行的。对比 `:188-191` 的叙事规范一节，那里**有**「已移入私有内容仓、公开仓不可见」的说明并给出本机绝对路径。验证员核实文件缺失属实，但原报告「三节」计数有误：`AGENTS.md:202`「Agent 流程测试 & Debug 参考」一节本身已写明指向私有仓并给出绝对路径，真正缺说明的是 `:176` 与 `:213` 两节；加之进度表「内容分离」一行已给全局背景，读者并非完全无线索，故降为 medium。
- **建议**：照 `:188-191` 的写法给这两节各补一条「已移入私有内容仓 `fated_poem_independent_assets`，公开仓不可见，本机路径 …」；同步修 `pull_request_template.md` 与 `.claude/workflows/audit-code.js`（改指私有仓路径，或在文件缺失时明确降级）。

#### 🟡 [medium] `docs/ARCHITECTURE.md` 整篇过期约两个月，却在导航里被标为「完整软件+世界观架构」而无过期提示

- **位置**：`docs/ARCHITECTURE.md:2`、`:17`、`:22`、`:65`、`AGENTS.md:87`、`README.md:120-123`
- **问题与影响**：文首写「v1.0 · 最后更新：2026-06-13」，`:17` 全景图仍画 `index.html / React GameView / Vue Chat`；`:22` 把 `Vanilla Store (sillytavern-store.ts)` 画成「响应式状态中心」，该文件已删、`src/sillytavern/AGENTS.md:384` 已立墓碑说明 Store 由 Pinia 接管；`:65` 列 `combat-resolver.ts # $combat API + 8步伤害管线`，该文件已在战斗 v3 M5 删除（`docs/CHANGELOG.md:1133`）；文末写「`src/ui/` — 10 主题/16 组件/4 页面」，实际 `src/ui/components` 下有 127 个 `.vue`。这是新人/新 agent 最可能先读的架构总览，按它建立的心智模型与两份 AGENTS 分册直接冲突，排查时会往错误的模块找。
- **建议**：最低成本是在文首加醒目过期声明——「软件架构部分已由 `src/sillytavern/AGENTS.md` 与 `src/ui/AGENTS.md` 取代，本文仅世界观部分仍有效」，并在 `AGENTS.md:87` 的树注同步这句；或安排一次性重写第一部分。

#### 🟡 [medium] 引擎分册模块树把两个已删文件仍列为活模块（同文件对其它已删文件都立了墓碑）

- **位置**：`src/sillytavern/AGENTS.md:136`、`src/sillytavern/AGENTS.md:379`
- **问题与影响**：`:136` 列 `combat-intention.ts / combat-damage.ts / combat-turn.ts / combat-resolver.ts` 并注「以上为 v2 战斗纯计算函数，v3 内核仍调用」，但 `combat-resolver.ts` 本身已在 M5 删除，`grep -rn combat-resolver src/` 只剩注释与测试描述、无任何 import；`combat-v2-types.ts:5,12,200` 明确记载 `characterToCombatParticipant`「原出自 combat-resolver」。`:379` 列 `api-router.ts / api-tools.ts`，而 `find src server -name 'api-*.ts'` 只有 `src/sillytavern/api-tools.ts`。同文件 `:20` `:31` `:169` `:373` `:384` 五处都用 🪦 标注已删项，说明墓碑机制是有意为之，这两条是漏网。分册自己写着「漏读的症状不是报错，是照着不存在的约定改代码」，而这里是地图本身在骗人。
- **建议**：给这两条补墓碑注——combat-resolver 注明「M5 已删，`characterToCombatParticipant` 等存活纯函数迁至 `combat-v2-types.ts`」；api-router 注明实际去向（BFF 路由现在在 `server/` 下）。

#### 🟡 [medium] README 作为对外入口内容过期，且把薄壳 `CLAUDE.md` 说成「最全」、全文从不提真源 `AGENTS.md`

- **位置**：`README.md:121`、`README.md:131`、`README.md:149`、`CLAUDE.md:5`
- **问题与影响**：`README.md:121` 文档表首行写 `[CLAUDE.md](CLAUDE.md) | 开发者 / AI 助手 | 架构、命令、规范、Phase 进度（最全）`，而 `CLAUDE.md:5` 自述「指令正文在 `AGENTS.md`……本文件是薄壳」，架构又已拆到两份分册；`grep -c 'AGENTS.md' README.md` = 0，全文零次提及真源。`:131`「引擎：TypeScript（`src/sillytavern/`，30+ 模块）」实为 131 个非测试模块 + `combat-v3/` 74 个文件；`:149`「Phase 1–10j + M1–M6 已完成」，而进度表里战斗 v3 / 地图 v1 / 存档互传 / 图像 v2 / 随机事件 v1 均已 ✅。外部贡献者按 README 进门会先读一个薄壳，绕一圈才找到指令正文与分册，过期数字还会让人低估仓库规模。
- **建议**：文档表首行换成 `AGENTS.md — 指令正文（工具中立，架构见两份分册）`，`CLAUDE.md` 降为「Claude Code 专属薄壳」；模块数与进度句改成不带具体数字的表述或直接指向 `AGENTS.md` 进度表，避免再次腐化。

#### ⚪ [low] 「每次发现 bug 必读」的 debug-loop-handbook 含失效路径与一个文件名笔误

- **位置**：`docs/reference/debug-loop-handbook.md:192`、`:195`、`:216`（另 `:24`、`:180`）
- **问题与影响**：`AGENTS.md:104` 把该文件标为「每次发现 bug 必读」。「关键文件速查」表写 `src/sillytavern/agency-client.ts`，真实文件是 `src/sillytavern/agent-client.ts`（`ls src/sillytavern/agen*.ts` 无 agency-client），这类笔误会让人误以为存在一个独立的 agency 层；同表与「关于热重载」一节的 `data/defaults/agent-config.json` 实为 `public/data/defaults/`。验证员核实 `tests/realtime_export/` 一条不成立：`.gitignore:68` 明列该目录，手册原文是让使用者把导出文件**放到**那里的本机落地目录，并非引用了不存在的文件；剩余两处属低成本笔误，故降为 low。
- **建议**：把 `agency-client.ts` 改为 `agent-client.ts`、`data/` 改为 `public/data/` 即可，其余不必动。

#### ⚪ [low] 仓库有两个 CHANGELOG，面向玩家的根 `CHANGELOG.md` 停更半个多月且从未被任何指令文件引用

- **位置**：`CHANGELOG.md:1-3`、`docs/CHANGELOG.md`、`AGENTS.md:18-22`、`README.md:119-125`
- **问题与影响**：根 `CHANGELOG.md` 自述「记录面向玩家的版本变更」，最新条目 `## 2026-07-30`（最后改动 2026-07-31），而 `docs/CHANGELOG.md` 最新为 2026-08-16。`grep -rn CHANGELOG AGENTS.md README.md CLAUDE.md` 命中 5 处全部指向 `docs/CHANGELOG.md`，根 CHANGELOG 零引用，README 文档表也未列。这半个月交付的玩家可见功能（地图 v1、存档导出/导入、图像生成 v2、随机事件 v1）一条都没进玩家更新日志。验证员核实事实全部成立，但影响限于发布时回溯 git log 补写的一次性成本，无工程或正确性风险，降为 low。
- **建议**：二选一并写进提交前检查清单——要么把根 `CHANGELOG.md` 列为「里程碑/发布时同步」项并说明与 `docs/CHANGELOG.md` 的分工（玩家语言 vs 工程细节），要么加过期头并入 `docs/`。

#### ⚪ [low] 三份前端设计文档并存且互不引用，`AGENTS.md` 只认其中一份为「必读」

- **位置**：`AGENTS.md:148-163`、`docs/design.md:3`、`DESIGN.md:1`、`design-qa.md`、`.codex/skills/pod-independent-front-ui/SKILL.md:19,27`
- **问题与影响**：「前端 UI 设计规范（必读）」一节只点名 `docs/design.md`；根目录另有英文 `DESIGN.md`（`:6`「Read this guide before starting UI theme work」），仅被 Codex skill 引用，在 `AGENTS.md` / `CLAUDE.md` / `README.md` 中零命中；第三份 `design-qa.md`（294 行主题实施 QA 记录）只在 `docs/CHANGELOG.md:356` 被顺带提到，无任何入口。三者互相 grep 均无命中，确实互不引用。验证员核实两处论据不实：`SKILL.md:27` 明写「Read `docs/design.md` and `DESIGN.md`」，Codex 侧读的是两份，「两条工具线基线分裂」被夸大；且 `docs/design.md` 实际最后提交为 2026-08-05（并非文件头声称的停在主题重做之前），故降为 low。
- **建议**：在「前端 UI 设计规范」一节写清三份文档的分工（`docs/design.md` = 排版/间距/组件底线；`DESIGN.md` = 主人核准的主题视觉起始值；`design-qa.md` = 实施后走查证据），或把 `DESIGN.md` 并入只留一份。

#### ⚪ [low] `CONTEXT.md` 自称统一语言词汇表，但最大的子系统战斗 v3 零词条

- **位置**：`CONTEXT.md:3`、`CONTEXT.md:33`、`src/sillytavern/combat-v3`
- **问题与影响**：`CONTEXT.md:2-3` 声明「本文件是项目的统一语言词汇表（glossary）」，但全文只有四节：内容创作执行面(`:6`) / 地图系统(`:19`) / 随机事件系统(`:31`) / EJS 世界书求值契约(`:48`)。`DiceTape` / 骰带 / `EffectIntent` / 主持人 等词命中数为 0，而 `combat-v3/` 有 74 个文件、进度表里有「Kernel+DiceTape+EffectIntent+DSL」「战斗主持人/DM」等专有概念。`:33` 的「事件」歧义警告只列了「剧情大事件」与「EventBus 上的 GameEvent」两个占用者，未提战斗系统内的 19 类战斗事件。词汇表只覆盖最近新增的子系统，最易产生命名冲突的战斗域反而无裁定。
- **建议**：补一节「战斗系统 v3」，至少收录 DiceTape / EffectIntent / EffectAutomaton DSL / 战斗主持人 / 战斗会话 五条，并把战斗事件补进 `:33` 的歧义警告。

#### ⚪ [low] 文档索引若干处小漂移：`docs/` 树漏列三项、TODO 摘要漏一条、PR 模板含不可执行勾选项

- **位置**：`AGENTS.md:85-113`、`AGENTS.md:79-80`、`.github/pull_request_template.md:6`、`docs/known-issue.md:1`
- **问题与影响**：`ls docs/` 实有 `known-issue.md` / `project-introduction.md` / `reviews/` 三项，导航树均未列——其中 `known-issue.md` 被 `TODO.md:4` 指定为已知缺陷的归属地，却在导航里找不到。`AGENTS.md:79-80` 把 TODO.md 概括为 7 条，实为 8 条（漏了 `:30`「远程加载的内容包（探索）」）。PR 模板 `:6` 的文档同步勾选项含 `reference/agent流程测试/`，该目录已整树 gitignore、公开仓不存在。另 `docs/known-issue.md:1` 标题是「Known issue: EJS 世界书与持久角色状态冲突」，是单条问题记录而非 TODO.md 设想的缺陷登记册。单条都不致命，合起来削弱「文档导航 = 唯一入口」的可靠性，死项被习惯性勾掉还会稀释整份清单的可信度。
- **建议**：`docs/` 树补上三项；`AGENTS.md:79` 的 TODO 摘要补「远程内容包」或改成不逐条列举；PR 模板删掉 `reference/agent流程测试/` 那一项；若 `known-issue.md` 要承担登记册职责，改成带条目列表的结构。

## 12. 构建/CI/工具链与依赖健康

### 总评

这个维度整体是健康的，且明显有人认真经营过：CI 的三 job 拆分、vitest 的 maxWorkers 上限、`.gitattributes` 的行尾规则，都在配置文件里留了实测数据与因果论证，而不是复制来的样板。实跑复验也支持这个判断——`typecheck` / `typecheck:vue` / `typecheck:tools` / `lint`（`--max-warnings 0`）/ `knip:ratchet` 五道闸门全部一次通过，`package-lock.json` 与 `package.json` 的 29 条依赖范围逐项比对完全一致，`npm ci` 不存在锁文件漂移风险。真正要紧的问题只有两类，且都不是「代码坏了」而是「开发者与 CI 之间的信息落差」：其一是 `format:check` 在 Windows 工作副本上 100% 假红，使九道闸门里的这一道在本地根本无法验证；其二是九道闸门没有任何一键本地等价命令，而这个落差已经两次真实地把类型错误漏到 CI 才被逮住。剩下的条目——BFF 无超时、scripts/ 在类型视野外、依赖落后、Node 版本三分叉——都属于该收敛但尚未咬人的技术债。

### 量化底账

- CI：1 条 workflow / 3 个 job / 9 道闸门；文件头 23 行注释记录了 178s → 约 85s 的并行优化实测。
- 实跑结果：`typecheck` / `typecheck:vue` / `typecheck:tools` 均 0 错，`lint` 0 warning，`knip:ratchet` 通过（145 条已知问题、无新增）；`format:check` 报 776 个文件失败，经全量加 `--end-of-line auto` 复跑转绿，确认 776/776 全是行尾假阳性。
- knip 基线 145 条，成分为 `exports 64 / types 75 / files 4 / devDependencies 1 / duplicates 1`，较首轮的 127 条净增。
- 依赖：`npm outdated` 报 15 项落后，其中 4 项跨主版本（pinia 2→4、vite 6→8、@vitejs/plugin-vue 5→6、fontawesome 6→7）；`.github/` 下无 dependabot / renovate。

### 亮点

- `ci.yml` 头部 25 行注释把三 job 拆分写成有实测支撑的工程决策：逐步耗时、为什么是三个而非八个（每 job 自付 14s 环境准备、`test:run` 82s 是长杆）、两个前置核查，还留了「加分支保护时记得把三个 job 名都加进必需检查」的后手。
- `scripts/knip-ratchet.mjs` 的棘轮按「类型|文件|名字」身份而非计数比对基线，能抓住「修好一条又新增一条」的净零变化；带 Windows BOM 防御与「被测试 import 时不执行 main」的守卫。
- `eslint.config.js` 开了类型感知的 `no-floating-promises` / `no-misused-promises` / `await-thenable`，并把 `tsconfig.json` 与 `tsconfig.tools.json` 两份都列进 `parserOptions.project`；`--max-warnings 0` 让配置成为真闸门而非提示板。
- `.gitattributes` 对行尾写清了因果而非结论（.bat 必须 CRLF、shebang 脚本必须 LF，均附故障复现描述），并刻意不加全局通配以避免一次性全仓重规范化。
- `vitest.config.ts` 的 maxWorkers 上限附 16/8/4 worker 的实测耗时表，并显式复刻 `vite.config.ts` 的 define（注明少这一行会让 `checkEngineVersion` 在测试里恒走 skipped 分支）。
- `server/` 的 6 个 BFF 路由把转发全部收敛到唯一的 `forward()`；`proxy.ts` 会把 undici 的 `e.cause.code` 挖出来拼进 502 响应，`image.ts` 用注释钉死「绝不 `res.json()`/`res.text()`」以防二进制被按文本读坏。

### 问题清单

#### 🟡 [medium] `npm run format:check` 在 Windows 上 100% 假红（776/776 文件）

- **位置**：`.prettierrc`、`.gitattributes`、`package.json:28`、`.github/workflows/ci.yml:64`、`AGENTS.md`
- **问题与影响**：`.prettierrc` 钉死 `"endOfLine": "lf"`，而 `core.autocrlf` 实测为 `true`、`.gitattributes` 只点名 `*.bat` 与 4 个 shebang 脚本。结果 `npm run format:check` 报 776 个文件失败，同一 glob 加 `--end-of-line auto` 全量复跑则全绿——776/776 是直接证实而非抽样推断的行尾噪声。开发者无法从假阳性中分辨真格式问题，`AGENTS.md:32-46` 因此写了一整节高危手工替代流程（绝不跑仓库级 `format`、只 `--write` 改过的文件、用 `git diff --numstat` 分辨真假改动），纯文档直推 master 时全靠人肉执行。验证员核实全部证据成立，但降为 medium：CI 侧在 Linux LF 检出上恒绿、仓库内容干净，且该坑已被 `AGENTS.md` 与 `.claude/agent-memory/code-writer/prettier-baseline-dirty.md` 两处记载并给出可执行替代流程。
- **建议**：把 `.prettierrc` 的 `endOfLine` 改为 `"auto"`（零 diff，入库仍是 LF、CI 照常通过），随后可整节删掉 `AGENTS.md` 的手工流程；不选此路则用 `.gitattributes` 加 `* text=auto eol=lf` 做一次性全仓规范化。

#### 🟡 [medium] 9 道 CI 闸门没有一键本地等价命令，已两次导致 CI 才发现失败

- **位置**：`package.json:17-33`、`.github/workflows/ci.yml:44-52`、`AGENTS.md`
- **问题与影响**：CI 实跑 9 步（`ci.yml:44-52` 的 typecheck 三连 + build，`:64-67` 的 format:check / lint / knip:ratchet，`:79` 的 test:run），而 `package.json` 无任何聚合脚本（无 `verify`/`ci`/`check`），`AGENTS.md:254-263`「常用命令」只列 build/typecheck/test/lint/knip/dev。`typecheck:tools` 是 `tests/`、`server/`、`*.config.ts` 的唯一类型网（主 tsconfig 只 include `src/**`），`build` 是资源导入破坏的唯一网。同一形态已复发两次：`6b9e474`（placeholder-content 注册表补第 9 面 randomEvents，紧跟 PR #109）与更早的 `37d0544`（补 mapPack 面）。验证员核实结论成立，但 evidence 中「这三道闸门在文档里一次都没出现」不成立——`docs/planning/2026-08-05-content-engine-separation-implementation-plan.md:20,55` 写了三道 typecheck 连跑，`.github/pull_request_template.md:5` 已把 typecheck + typecheck:vue + test:run 列成勾选项，故缺口比描述窄，降为 medium。
- **建议**：`package.json` 增加 `verify` 聚合脚本串起全部 9 道（并提供去掉 build/test 的 `verify:fast`），三个 CI job 改调对应子命令使「CI 跑什么」与「本地跑什么」共用一份定义，并写进 `AGENTS.md`「常用命令」。

#### 🟡 [medium] BFF 转发层对上游 fetch 完全没有超时

- **位置**：`server/routes/proxy.ts:110-118`、`server/routes/image.ts`
- **问题与影响**：`grep -rn "AbortSignal|timeout|setTimeout" server/` 在整个目录零命中；`proxy.ts:94-120` 的转发是裸 `fetch`，catch 块只覆盖「连不上」并返 502，没有「连上了但不回」的处理。上游 TCP 握手成功却不响应（ComfyUI 卡在显存分配、LLM 端点吊住、企业网关黑洞）时请求会无限期挂起，连接与 socket 只增不减；`image.ts` 的所有路由都是一行 `forward(c, …)`，包括 `/comfy/interrupt` 与 `/comfy/queue` 这两条取消善后路由——最需要及时返回时最可能卡住。
- **建议**：在 `forward()` 里加 `signal: AbortSignal.timeout(ms)` 并按路由传参（非流式约 60s，SSE/图像生成放宽或只约束首字节，善后路由给最短值），catch 里按 `err.name === 'TimeoutError'` 分流返回 504 并保留现有 cause 拼接。

#### 🟡 [medium] `scripts/` 在所有 tsconfig 之外，手写 `.d.mts` 与实现 `.mjs` 无一致性检查

- **位置**：`tsconfig.tools.json`、`scripts/knip-ratchet.d.mts`、`scripts/build-placeholder-hashes.d.mts`、`scripts/nai-regression-smoke.ts`、`package.json:27-28`
- **问题与影响**：`tsconfig.tools.json` 的 include 为 `["server/**/*.ts","tests/**/*.ts","*.config.ts","src/env.d.ts"]`，主 tsconfig 只 include `src/**`——`scripts/nai-regression-smoke.ts`（走生产代码路径的冒烟脚本）从未被任何 tsc 检查（它被 ESLint 扫但不被类型检查）。两份 `.d.mts` 是纯手写平行声明，`build-placeholder-hashes.d.mts` 的 18 个值级导出当前与 `.mjs` 一一对应，但无任何机制保证继续对应；format/lint 的 glob 都不含 `mts`，Prettier 也不管它们。改 `.mjs` 签名而不改声明不会触发任何闸门，而这两个脚本一个是 CI 闸门本体、一个是内容包哈希产出器。
- **建议**：`tsconfig.tools.json` 的 include 补 `scripts/**/*.ts` 与 `scripts/**/*.d.mts`，更彻底的做法是给 scripts 开 `allowJs` + `checkJs`（两个 `.mjs` 已写满 JSDoc）或由 JSDoc 生成声明；format/lint glob 补 `mts`。

#### ⚪ [low] CI 无 concurrency 取消组

- **位置**：`.github/workflows/ci.yml:27-33`
- **问题与影响**：通读 80 行全文，从 `on:` 直接到 `jobs:`，确无 `concurrency` 也无 `permissions`。同一分支连推两次（文档直推 master、修 CI 红都常连推）时旧 run 会跑满约 85 秒才被无视。验证员降为 low：`ci.yml:18` 自己写明本仓是 public、Actions 分钟数免费，浪费的只是排队额度而非项目成本，且三个 job 各自独立调度、旧 run 不取消并不拖慢新 run 的墙钟，原 evidence 把「墙钟收益」与「重复 run 的机器时间」混为一谈。
- **建议**：顶层加 `concurrency: { group: "${{ github.workflow }}-${{ github.ref }}", cancel-in-progress: true }`；加之前确认没有分支保护会把「被取消」判为失败。

#### ⚪ [low] 依赖主版本落后且无更新自动化，typescript 声明下界虚标

- **位置**：`package.json:42-75`、`.github/`
- **问题与影响**：实测 15 项落后，跨主版本四项为 pinia 2.3.1→4.0.3、vite 6.4.3→8.2.1、@vitejs/plugin-vue 5.2.4→6.0.8、fontawesome 6.7.2→7.3.1；`.github/` 下只有 CODEOWNERS / pull_request_template.md / workflows，无任何更新自动化。`package.json:71` 写 `"typescript": "^5.4.0"` 而实际解析到 5.9.3，下界给出「5.4 就够」的错误信号。vite 6→8 叠加两次破坏性变更，而本仓 `vite.config.ts` 有 12.6KB 自定义中间件与 optimizeDeps 例外，正是升级最易崩处。验证员核实事实基本成立（小版本落后实为 10 项），但补充 evidence 漏报了更值得排期的一条：typescript 自身 latest 已是 7.0.2；且该问题纯属前瞻性技术债，无已知 CVE、无 CI 失败，故降 low。
- **建议**：加 `.github/dependabot.yml`（npm、weekly、minor/patch 合成一组、major 单独开）先吃掉小版本；typescript 下界提到 `^5.9.0`；vite 8 / pinia 4 各自单独排期。

#### ⚪ [low] Node 版本三处不一致且无 engines 约束

- **位置**：`.github/workflows/ci.yml:41`、`package.json:57`、`package.json:17-34`
- **问题与影响**：`ci.yml:41/61/76` 三个 job 全写 `node-version: '20'`，本机实测 `v22.20.0`，`package.json:57` 为 `"@types/node": "^26.1.2"`；无 `engines` 字段、无 `.nvmrc`，新机器没有任何版本提示。验证员核实三个事实无误，但认为影响被夸大：`@types/node` 主版本与运行时并非一一对应承诺，tsconfig 开了 `skipLibCheck`、`lib` 只到 ES2020 + DOM，仓库中未见 Node 22+ 新 API 调用，也无一次此类历史失败，故这是「该收敛的真源分散」而非已在咬人的问题，降 low。
- **建议**：加 `"engines": { "node": ">=20 <23" }` 与 `.nvmrc`，CI 改用 `node-version-file: '.nvmrc'` 收敛到单一真源，`@types/node` 降到与目标运行时对应的主版本。

#### ⚪ [low] knip 棘轮长期驻留 145 条死代码

- **位置**：`knip-baseline.json`、`scripts/knip-ratchet.mjs:5-22`
- **问题与影响**：基线成分实测 `exports 64 / types 75 / files 4 / devDependencies 1 / duplicates 1`，已从首轮 127 条涨到 145，说明净增仍在继续。整文件死代码 4 个：`src/ui/components/create/DestinyCoreCard.vue`、`create/PartnerWorldBookPanel.vue`、`shared/form/FormCascader.vue`、`shared/form/FormKeyValue.vue`（脚本头注释将其解释为 Phase 7d 在途件，有作者明载的豁免理由）；另有 `@types/openseadragon` 与 `src/sillytavern/plot-outline.ts` 的 `parseOutlineJson`+`parseOutlineAgentOutput` 同义函数并存。死组件仍进 lint/typecheck/format 扫描面，并会误导后来者当作活代码。
- **建议**：排一次清理，4 个 Vue 文件与 7d 负责人确认后删或接上，两个同义解析函数二选一，死 export 多数只需去掉 `export`；清完跑 `npm run knip:update` 收紧基线，并可追加「基线总数只降不升」的软约束。

#### ⚪ [low] `dev.bat` 与 `dev.sh` 参数解析不对称，且路径未规范化

- **位置**：`dev.bat:33-38`、`dev.sh:26-40`、`docs/reference/dev-bat-notes.md:168-172`
- **问题与影响**：`dev.bat` 只查 `%~1` / `%~2` 两个固定位置的 `--no-content`，`dev.sh` 则 `for arg in "$@"` 遍历全部参数——`npm run dev -- --foo --bar --no-content` 在 Mac 生效、Windows 静默忽略。路径侧 `dev.bat` 直接 `set "POEM_CONTENT_DIR=%~dp0..\..."`（字面量含未折叠的 `..`），`dev.sh` 走 `cd -- "$CANDIDATE" && pwd` 规范化；未折叠路径会原样进 `vite.config.ts` 的 `dataDir` 与 `__POEM_CONTENT_DIR__`。而 `dev-bat-notes.md` 明写「其余一一对应……同样认 `--no-content`」，文档给出了比实现更强的等价承诺。
- **建议**：`dev.bat` 改用 `for %%A in (%*) do if /i "%%~A"=="--no-content" ...` 覆盖任意位置，路径用 `for %%I in (...) do set "POEM_CONTENT_DIR=%%~fI"` 折叠 `..`，并同步修正 `dev-bat-notes.md` 第六节的「差异只有一处」结论。

#### ⚪ [low] `notify.sh` 仅 Windows 可用，且入参直接拼进 PowerShell 单引号串

- **位置**：`scripts/notify.sh:19-38`、`AGENTS.md`
- **问题与影响**：全文 38 行，通知与响铃全部走 `powershell -NoProfile -Command "..."` 并以 `2>/dev/null || true` 收尾，无 `uname` 分支、无 `osascript`/`notify-send` 回退；而 `AGENTS.md` 把 `bash scripts/notify.sh` 定为每个 Phase 完成后必须执行的步骤，与项目刚为 Mac 补的 `dev.sh` + `dev.mjs` 分发层不一致。`\$notification.BalloonTipTitle = '${PHASE_NAME}';` 把未转义入参拼进单引号串，入参含 `'` 会破坏命令串并被 `|| true` 吞掉。
- **建议**：按 `uname -s` 分发（Darwin → `osascript`，Linux → `notify-send`，Windows 保留现路径），入参做单引号转义或经环境变量传值避免拼串。

#### ⚪ [low] 发布配置自相矛盾且是死配置

- **位置**：`package.json:7-16`、`.npmignore`
- **问题与影响**：`"private": true` 之下同时存在 `files` 白名单（含 `dist`/`dist-ui`/`public`/`src`/`server`/`scripts`/`docs`）与 `.npmignore` 黑名单（排除 `tests/`/`scripts/`/`.claude/`/`.git/`），两者对 `scripts/` 给出完全相反的意图；npm 语义下 `files` 优先，`.npmignore` 顶层排除基本失效。当前无实际故障，但真要发布那天两份清单会给出错误答案，`.npmignore` 头注释的「待发布决策落地后改用 files 白名单」正是留给未来的一颗雷。该条无对抗验证结论。
- **建议**：按注释已有的裁定删掉 `.npmignore` 只留 `files`，并把 `files` 收敛到真正要发的内容（`src` + `server` + `scripts` + `docs` 同时进包与「引擎库」定位不符）。

## 13. 完备性补扫

### 总评

本轮补扫针对九维摘要中"零发现"的面（静态资产、引导链路、构建产物、随机事件 v1、地图占位包、EJS/图像/工坊/剧情模块清点、编码闸门、测试环境声明、行尾守则、仓库治理件）逐个抽查，结论是：**代码面确实干净，问题集中在产物、文档口径与本机卫生三个"没人看"的边缘带**。抽查确认无缺陷的面包括随机事件调度器的种子化/池淘汰/首访足迹三条不变式（自洽且有 1062 行测试）、shebang 与 .bat 行尾守则的实际清单（无漏）、Vue 测试环境声明 58/58 齐备、占位内容 JSON 全部可解析。最要紧的两条是同一类性质：`vite build` 会把 267MB 未授权音频原样打进 305MB 的产物（且其中一首都注册不进应用），以及全仓零全局错误兜底——都属于"功能不坏、但一旦进入发布或调试流程就直接卡住"的口子。8 条 finding 里 2 条被验证员从 high 降到 medium、2 条从 medium 降到 low、2 条判 partly，说明初评整体偏重，但每一条的事实基础都经复测吻合。

### 量化底账

- 产物实测：`dist-ui` 305M（其中 `dist-ui/audio` 267M / 57 个 mp3）、`dist` 18M、`artifacts` 326M、`tmp` 45M、`.claude/worktrees` 584M（6 个废弃 worktree），本机工作副本合计约 1.3GB。
- 覆盖清点：随机事件 v1 共 8 个模块 3545 行（含 `rollRandomEvents` 954 行主体）；EJS 能力面 22 个 `ejs-*` 文件 9721 行；图像 20 个 `image-*` 文件；工坊 10 个 `workshop-*` 文件；`plot-engine` 465 行。
- 交叉核对：`map-pack.json` 13 个分节 vs `locations.json` 7 节点 vs 14 条 `placeBindings`，`neighbors` 非对称由 `buildAdjacency` 双向化，判为非缺陷。
- 治理件：无根 `LICENSE`、无 CODEOWNERS/PR 模板、单条 CI；`docs/reviews/` 保留 6 份历次审查存档。

### 亮点

- 占位内容不是空壳：`public/data/content/random-events.json` 用 `$comment` / `$comment_no_first_visit` / `$comment_config` 三层注释把"为什么刻意不给 first_visit 示例""×0 与 available 的语义差别""跨多天掷骰用到达日上下文"写进数据本身，抄这份文件的作者能直接看懂默认值与陷阱。
- 编码不变式闸门 `tests/encoding-invariants.test.ts` 把 AGENTS.md 的手工命令固化成 CI 断言，且 raw 与 `JSON.parse` 后的值各扫一遍，专抓"合法转义写出的退格"这种源码干净、解析不报错、正则永远匹配不到的坏形态。
- `src/ui/main.ts` 中主题/字体/音频解锁/两个 QuickJS 后端的注册次序全部带承重理由注释（字体须排样式表之前、engine-settings provider 须挂载前注册、音频解锁监听须启动时装），每条都写明"不这么做会安静地错"。
- 两个隔离后端装载失败时用 `duration=0` 的 error toast 强制留屏（`installProductionEjsBackend().then` / `installProductionScriptBackend().then`），把安全相关的降级从没人读的 console.warn 提升成用户可见状态。
- `vitest.config.ts` 的 `maxWorkers` 上限附完整实测表（16/8/4 worker 的全量与目标用例耗时）并说明"为什么不是调高 testTimeout"，是本仓少见的把性能取舍留下证据的配置。
- 零外链纪律贯穿到首字节：`index.html` 撤掉字体/图标 CDN、静态 `<title>` 中性并注明真实应用名由 branding 面运行时改写；OpenSeadragon 的 44 张按钮图自托管进 `public/osd/`，`useMapViewer.ts:26` 注释写明"否则每个玩家都在裸奔"。
- `random-event-scheduler.ts` 的 `enforcePoolCap` 把两条反直觉规则（forced 永不被淘汰导致池满时新条目自我淘汰、同 priority 取最后一个以免候选列表抖动）写进函数注释，实现（forward 迭代 + `<=`）与注释精确对应。
- `.gitattributes` 的两大段行尾说明各自附真实事故（cmd 按字节偏移解析直接不工作 / `knip-ratchet.mjs` 在 Windows 必红而 Linux CI 全绿且 `node --check` 说没问题），并明确拒绝写通配以免触发全仓重规范化。

### 问题清单

#### 🟡 [medium] 全仓零全局错误兜底：无 app.config.errorHandler / unhandledrejection / window.onerror

- **位置**：src/ui/main.ts:1-176、src/ui/App.vue
- **问题与影响**：`errorHandler|onErrorCaptured|unhandledrejection|window.onerror|addEventListener('error')` 在 `src/` 全仓零命中（连测试里也没有）；`main.ts` 从第 58 行 `createApp` 到第 142 行 `app.mount('#app')` 之间只注册了 pinia、主题 init、`setEngineSettingsProvider`、音频解锁监听与两个 QuickJS 后端，231 个 Vue 组件无一处 `onErrorCaptured`。组件渲染抛错时 Vue 卸载该子树，玩家看到的是"面板空了"而非错误；大量 async store 方法的未捕获拒绝除 console 外不留痕迹，`DebugPanel.vue` 的导出物里也拿不到异常栈，直接削弱 `docs/reference/debug-loop-handbook.md` 的调试循环。验证员核实全部证据成立，但影响是可观测性缺失而非功能损坏（开发期 console 仍可见，不涉数据损坏或安全），按本仓 high 的量级对齐降为 medium。
- **建议**：在 `main.ts` 挂载前补 `app.config.errorHandler` + `unhandledrejection` + `error` 三格监听，统一走 `useUIStore().toast(..., 'error', 0)`（与后端装载失败同口径），并把最近 N 条异常写进 Debug 导出。

#### 🟡 [medium] vite build 把 267MB 未授权音频原样打进产物

- **位置**：vite.config.ts:238-241、public/audio/manifest.json:1、public/audio/README.md:63-80、dist-ui/audio
- **问题与影响**：`vite.config.ts` 的 build 块只有 `outDir: 'dist-ui'` 与 `sourcemap: true` 两行，无 `copyPublicDir` 过滤，Vite 把 `public/` 原样拷进产物，实测 `dist-ui` 305M、`dist-ui/audio` 267M（57 个 mp3）。同时 `public/audio/manifest.json` 内容是 `[]`（4 字节，内容分离波 4 清空），而 `audio-store.ts:57` 的 `MANIFEST_URL = '/audio/manifest.json'` 是内置曲库唯一入口——这 267MB 一首都注册不进，占分发包 88% 的字节永不会被读取，且 README 标明其 license 为 `PLACEHOLDER-PENDING-REVIEW`、"不该随代码分发"。验证员逐项复测全对，但补充：mp3 已 gitignore，CI 与全新 clone 的构建产物是干净的，只有本机残留旧文件才复现，现存 `dist-ui` 未进入任何分发流程，故降为 medium。
- **建议**：给 build 加 `copyPublicDir` 过滤，或把 `public/audio/bgm/` 移出 publicDir 改成 dev-only overlay（与 `POEM_CONTENT_DIR` 同一套条件中间件思路）；再补一条产物体积闸门（如 `dist-ui > 60MB` 即红），把"产物里不许有未授权素材"变成机器判据。

#### 🟡 [medium] public/audio/README.md 与实际清单矛盾：manifest 已被清空成 []

- **位置**：public/audio/README.md:44、public/audio/README.md:68-71、public/audio/manifest.json:1
- **问题与影响**：README 第 44 行列出 57 首分组表，第 68-71 行称"留在仓库里的只有 manifest.json 和本文件""全新 clone 的曲库会列出 57 首，但一首都点不响""要恢复：把 mp3 放回 `public/audio/bgm/`……不需要改代码"。而 `manifest.json` 已在 `9672196 feat(content): 波 4` 中被清空为 `[]`，README 那节写于更早的 `2da6929` 且此后未跟改。三条陈述全部失效：实际列 0 首，放回 mp3 也注册不进。这是音频子系统唯一的操作文档，而 TODO.md 的"配乐重制/精选"正是待办项。
- **建议**：把第 63-80 节重写成波 4 之后的真实状态，说明 `/audio/manifest.json`（audio-store 硬编码）与内容包路径的关系；注意验证员提醒——`public/data/defaults/audio-manifest.json` 同样是 4 字节空占位，且 `audioManifest`/`audio-manifest` 在 `src/` 零命中，别把"内容包提供内置曲库"写成既成事实。

#### 🟡 [medium] package.json 声明 license: MIT 但无 LICENSE 文件，且与双许可口径矛盾

- **位置**：package.json、AGENTS.md:386-388、docs/《命定之诗》内容二创与素材使用授权协议.md
- **问题与影响**：`package.json` 为 `license: MIT` / `private: true` / `version: 1.0.0`，而 `ls LICENSE*` 无结果、git 跟踪的根目录清单里也无 LICENSE。AGENTS.md 末节裁定的是双许可（`src/sillytavern/` 下代码 MIT + 创意内容受独立协议，"两者不可混淆"），README.md:140 亦同，与顶层单一 MIT 声明存在口径差，MIT 的署名与免责条款无全文可依，会卡住 TODO.md 的"正式发布打包"。验证员核实缺文件与口径差属实，但两处夸大需扣分：`"private": true` 意味着永不发 npm，"按 npm 语义覆盖整个包"的下游误导路径实践中不成立；根目录存在 `THIRD-PARTY-NOTICES.md`（随 dist 分发在 `/licenses/`），并非全无许可载体，只是缺自家 MIT 全文（另 AGENTS.md:386-388 行号为估值，实际在文件末尾"## 内容许可"节）。
- **建议**：补根 `LICENSE`（MIT 全文，开头限定适用范围为引擎代码），把 `package.json` 的 `license` 改为 `SEE LICENSE IN LICENSE`，并在 README 许可一节写清两份文件的适用边界。

#### ⚪ [low] 编码闸门只扫 public/data 占位集，AGENTS.md 的"漏跑不再等于漏网"口径失准

- **位置**：tests/encoding-invariants.test.ts:45、tests/encoding-invariants.test.ts:33-36、.gitignore:33
- **问题与影响**：闸门的 `const DATA_ROOT = join(REPO_ROOT, 'public', 'data')`，文件头自述扫描范围为 `public/data/` 占位集 + `src/ server/ tests/ scripts/`；而 AGENTS.md 举的唯一实例（`data/defaults/agent-config.json` 的 47 个 U+FFFD，其中一个落在闭合 XML 标签的标签名里）指向的是被 `.gitignore:33` 整目录忽略的真实内容树。验证员核实：本机 `data/` 目录当前根本不存在，真实内容已按内容分离 v1.3 迁入私有内容仓，公开仓的测试无法也不应扫一份不在仓里的树——"闸门漏网"的定性不成立，这是内容分离的必然结果。真正成立的只有文档面：AGENTS.md 仍写"扫 `data/` 与 src|server|tests|scripts"，且"漏跑不再等于漏网"未限定只覆盖公开占位面，故判 partly、降为 low。
- **建议**：更新 AGENTS.md 那段的扫描范围表述并注明只覆盖公开占位面；如需覆盖真实语料，在私有内容仓侧复制同一份闸门（或让 DATA_ROOT 支持 `POEM_CONTENT_DIR` 双根）。

#### ⚪ [low] index.html 硬编码 data-theme="obsidian"，浅色主题用户每次刷新先看一帧深色首屏

- **位置**：index.html:2、src/ui/stores/theme-store.ts:159-169、src/ui/main.ts
- **问题与影响**：`index.html:2` 为 `<html lang="zh-CN" data-theme="obsidian">`，首字节即钉成深色；真实主题由 `theme-store.ts:159` 的 `init()` 读 `localStorage.getItem('fated-poem-theme')` 后经 `apply()`（第 149-157 行 `setAttribute('data-theme', themeId)`）改写，而调用点在 `main.ts:64-66`，排在第 24-56 行的三个字体包 + 三份 FontAwesome CSS + 12 份主题样式表 import 之后。`base.css:21` 的 `background: var(--theme-window-bg)` 使 body 底色随主题变量走，10 套主题中 parchment / ivory / sakura / misty-lilac 为浅色系，这些用户每次冷启动都会先看到一帧全屏深色再翻白。head 中确无读 `fated-poem-theme` 的内联脚本。属一帧级视觉抖动，无功能/数据影响且仅影响改过主题的用户，故为 low。
- **建议**：在 `<head>` 加一段极小的内联阻塞脚本，同步读 `fated-poem-theme`（连同 `fated-poem-font-size`）写 `documentElement.setAttribute`，HTML 上的硬编码值退化为 localStorage 不可用时的兜底。

#### ⚪ [low] .gitattributes 行尾守则注释过期：自称只有 dev.bat，实际还有跟踪的 update.bat

- **位置**：.gitattributes:4、update.bat
- **问题与影响**：`.gitattributes:4` 写"仓库里目前只有 dev.bat 一个"，但根目录同时跟踪着 `update.bat`（`DOS batch file, UTF-8 text, with CRLF`）；第 10 行规则是通配 `*.bat text eol=crlf`，故 update.bat 事实上受保护、无实际风险。真正的代价在可信度：同文件下半段的 shebang 清单要求"新增带 shebang 的脚本时记得往这里补一行"，这条人肉纪律依赖上半段注释的准确性，而漏一行的症状（Windows 上测试必红、Linux CI 全绿）正是文件里花大段篇幅描述的最难自查的一类。`git log` 显示 `.gitattributes` 在 update.bat 落地之后仍被改过而未更正。验证员补一句限定：update.bat 在 `docs/planning/2026-08-05-content-engine-separation-design.md:249` 等处有出现，不算完全无人记录，只是常用命令面没有。
- **建议**：把第 4 行改成"仓库里有 dev.bat 与 update.bat"，并在 AGENTS.md「常用命令」里给 update.bat 一行说明或删掉它。

#### ⚪ [low] 本机开发残留近 1.3GB 且无清理入口

- **位置**：.claude/worktrees、.gitignore:24、package.json
- **问题与影响**：6 个废弃 worktree 合计 584M（event-system-design 331M / nice-lamarr 77M / cool-knuth 74M / character-viewer-modal 37M / missing-app-features 33M / wonderful-liskov 32M，对应功能均已落地或废弃），加 artifacts 326M、dist-ui 305M、tmp 45M、dist 18M。`package.json` 的 scripts 列表（dev/build/build:engine/typecheck×3/test×2/preview/format×2/knip×3/lint×2）确无 clean 目标，`.gitignore:24` 只保证它们不进仓库。验证员核实数字全部吻合，但对"每个废弃 worktree 都是一份真实内容的完整拷贝"的措辞收一句：这些 worktree 建于内容分离完成后，抽查其 `docs/planning` 下为公开设计文档，未实测到真实世界书语料，该说法系照 `.gitignore` 注释推断。纯本机卫生，无仓库/产物影响。
- **建议**：加一个 `npm run clean`（dist / dist-ui / tmp / artifacts），并在 lean-delegation 收尾流程补一步 `git worktree prune` + 删目录。

## 14. 附录：审查统计

- **审查基线**：master @ 1133a82（2026-08-16）。所有行号引用均为该快照时点，后续提交可能漂移。
- **执行方式**：30 个审查 agent 分三波——9 个维度审查员 + 9 个逐维对抗验证员 + 1 个完备性批评员 + 1 个补扫验证员（合计 722 次工具调用），另 10 个章节撰写员负责浓缩成文。
- **验证纪律**：验证员默认立场为怀疑，逐条打开引用文件核对证据；「部分成立」的 27 条均在正文标注了验证员限定。
- **范围声明**：安全类问题（注入/越权/加密/密钥）全部排除，属另一条独立审查线；`reference/` 上游语料目录按仓库惯例不在审查范围。
