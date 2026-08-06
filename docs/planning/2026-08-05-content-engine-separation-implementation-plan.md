# 内容-引擎分离 实施计划（lean-delegation 编排）

> 2026-08-06。设计真源：`2026-08-05-content-engine-separation-design.md`（**v1.2**，两轮对抗
> 评审后定稿）。本文把 45 条决策（D1-D45）编排成 **8 个波次 / 26 个任务**，每个任务一份可直接
> 派发给子 agent 的 brief。基线：master @ `e53f8c0`。
>
> 执行模型：主会话 grounding / 派发 / 波间审查；实现全部走子 agent（**opus / medium effort**，
> 主人的全局约定）。设计文档是**契约**——brief 与设计冲突时以设计为准并回报，不得自行发挥。

---

## 0. 编排规则

### 0.1 三条铁律

1. **每一波结束时本仓 CI 必须全绿**（typecheck ×3 / format:check / lint / knip:ratchet /
   test:run）。红着过夜的波不存在——波 4 的原子交换尤其如此（设计 §10.2）。
2. **真实内容离仓（波 4）之前，一切改造都在「内容还在」的状态下开发与验证**。先改造、后搬家、
   再切仓（设计 §10.6）。
3. **knip 基线更新永远是一波的最后一个 commit**，且逐行 review diff，不盲跑（D34）。

### 0.2 每个子 agent brief 共用的报告格式（逐字带上）

```
报告只写四段，总长 ≤40 行：
1. 交付：改了哪些文件（新建/修改/删除各列一行），每文件一句话说明。
2. 验证：跑了哪些命令（typecheck/test/lint/编码检查），原样贴结论行（通过数/失败数）。
3. 偏差：与 brief 或设计文档的任何出入 + 理由；没有就写「无」。
4. 悬置：发现但没修的问题（越界不修，报回来）；没有就写「无」。
```

### 0.3 每个 brief 共用的围栏（逐字带上）

```
- 设计真源是 docs/planning/2026-08-05-content-engine-separation-design.md，先读你任务引用的
  D 条目与正文节；与 brief 冲突以设计为准并在「偏差」里报。
- 只改 brief 列出的文件面；越界发现记「悬置」。
- 禁 push；禁动 git 历史；禁删除 data/ 下任何真实内容文件（搬家统一在波 4 由专任务做）。
- 改了任何含中文的文件后必跑编码检查（AGENTS.md 的 node 一行命令：U+FFFD=0 / ctrl=0 /
  JSON 可解析），把结果贴进报告。
  （「禁删真实内容」的两处显式豁免：T2 按 D28 删 `data/defaults/item_gen_system_prompt.txt`
  与 `data/presets/`——零引用死文件，设计已裁定。）
- prettier 只 --write 你改过的文件；git diff --numstat 分辨真假改动（AGENTS.md 规矩）。
- 新模块必配 *.test.ts（Vitest；DB 用 fake-indexeddb）；改行为必改断言。
- 完成前跑 npm run typecheck && npm run test -- --run 相关文件；失败不许标完成。
```

### 0.4 全局验证命令（主会话每波末跑）

```bash
npm run typecheck && npm run typecheck:vue && npm run typecheck:tools
npm run format:check
npm run lint
npm run knip:ratchet
npm run test -- --run
```

---

## 1. 波次总览

| 波  | 任务      | 并行度                                                                      | 主题                                               | 出口条件                                           |
| --- | --------- | --------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| 0   | T0.1-T0.3 | 主人+主会话手做                                                             | 安全与前置                                         | key 已轮换；npm 关死；worktrees 入 ignore          |
| 1   | T1-T7     | T1 → T2 → T3 → T5（三者串行：同函数/同文件链）；T6 与 T2-T5 并行；→ T4 → T7 | 内容基础设施（provider / pack 机制 / agents 分层） | 装包管线端到端单测绿；真实内容下应用行为不变       |
| 2   | T8-T14    | **T8 先行独占 `create-store.ts`**，随后 T9-T14 并行                         | 代码内 IP 数据驱动化                               | 各数据面走 provider；真实数据经 JSON 供给行为不变  |
| 3   | T15-T16   | 2 个并行                                                                    | 占位内容 authoring                                 | 占位集齐 + placeholder-hashes.json；编码门过       |
| 4   | T17-T18   | 串行两 PR                                                                   | 🔴 原子交换 + 守门                                 | 占位进 public/data；真实内容出 src/tests；全部门绿 |
| 5   | T19-T20   | 2 个并行                                                                    | fixture/docs/仓面清洗                              | 词表扫描仅白名单命中                               |
| 6   | T21-T23   | 串行                                                                        | 私有内容仓 + pack 构建                             | 私有 CI 四门绿；真实 pack v1.0.0 产出              |
| 7   | T24-T25   | 串行                                                                        | 真机三走查 + 快照切仓                              | 设计 §0.2 十五条验收全过                           |

### 1.1 为什么这么分波

- 波 1 先立 provider 与 pack 机制：它们是波 2 每个抽取任务的落点（注册表/异步加载态），也是
  唯一有任务间依赖链的波。T4（agents 分层）必须晚于 T2（默认层来源）；T7（执行器）收所有线。
- 波 2 七个抽取任务文件面互不重叠，真实数据先抽到 `data/content/*.json`（本仓此刻仍私有内容
  合法在库），app 行为全程不变——这是「改造与搬家分离」的关键：行为回归在内容还在时就能发现。
- 波 3 只产 JSON 与文案，不碰代码，可与波 2 尾部并行。
- 波 4 是唯一的红 CI 风险窗（设计 §1.2 六处硬耦合 + §10.2 原子集），压成两个受控 PR。
- 波 6 依赖波 4 产出的最终 schema；波 7 依赖一切。

### 1.2 主会话在每波之间做什么

跑 §0.4 全量；抽查各报告的「偏差/悬置」；对照设计验收条目勾进度；波 4 前后各做一次
`git grep` 词表抽扫。发现子 agent 同任务失败两次 → 停，按主人规矩带失败细节上报。

---

## 2. 逐任务 brief

### 波 0 —— 安全与前置（不派 agent）

#### T0.1 ✋ 主人：轮换 SiliconFlow key

`sk-ycsg…` 在公开仓历史里可读（≥10 commits，4 个 fork）。轮换后确认 `.env.local` 各 key
从未 tracked（已验证，复查一眼）。**本任务与其余全部解耦，立即做。**

#### T0.2 主会话：npm 关死 + 快照卫生 + 记录勘正

`package.json` 加 `"private": true` + `files` 白名单；`.gitignore` 加 `.claude/worktrees/`；
AGENTS.md 里「agent-config.json 47 U+FFFD 未修」的过时记录更正（实测已修，D30）。一个 commit。

#### T0.3 ✋ 主人：五项裁定（异步收集，不阻塞波 1-3）

D3（内容仓建新 vs 扩建 Worldbook 仓）、D4（公开仓名——**波 7 前必须定**）、§3.1（105 MB 对局
导出删 vs 归档）、D10/D13/D35（授权四件）、R1（fork 处置）。默认推荐都在设计里。

---

### 波 1 —— 内容基础设施

#### T1 `content-source.ts`：pack 类型 + 校验 + planner 基座【引擎，纯函数】

- **设计**：§4、D17、D19、D20、D8（16 分区、拒 `creative_workshop`）。
- **改动面**：新建 `src/sillytavern/content-source.ts` + `content-source.test.ts`；
  `types.ts` 或 `types-content.ts` 收 `ContentPack / PackSection* / PackInstallPlan /
PackBaseline / ContentStatus` 类型。
- **契约要点**：`validatePackOrThrow`（formatVersion 有限数值；分节 if-present 形状；
  `minEngineVersion` semver 比对 `__ENGINE_VERSION__`（本波先接受注入缺省=跳过，T13 补注入
  **并补「过新包被拒绝」测试**——门先建后通电，通电必验）；
  拒 `creative_workshop` 分区书）；hash 工具（SHA-256，逐书/逐 preset/逐节）；
  `resolveSection` 优先级（pack payload > 占位 fetch 结果，纯函数接收两者）。类型收进
  **`types-content.ts`**（仓约定的大联合拆分文件模式）。
- **测试**：malformed 包全谱（空对象/错版本/坏分节/工坊分区书）不 throw 出 notes；三态语义表。
- **规模**：M。

#### T2 `content-store.ts`：provider 执行层 + 三处 fetch 收口 + 内容态 UI【依赖 T1】

- **设计**：D16、§5.1、§5.5。
- **改动面**：新建 `src/ui/stores/content-store.ts` + 测试；改 `settings-store.ts:428`、
  `game-pipeline.ts:704`、`create-store.ts:970` 三处 fetch → `loadProjectDefaults()`；
  🔴 `AgentConfigPanel.vue:136` **不改**（读-改-写回路径，保持 raw 读，D16）；
  `App.vue`/首页横幅组件 + 设置页徽标（`contentStatus` 消费）。
- **契约要点**：模块级 ready promise（settings-store 构造器 `setTimeout(0)` 也 await 它——
  时序契约写测试）；`contentStatus: placeholder | pack | needs_attention | error`；
  `setContentRegistry()` 骨架（catalog/locations/bloodlines/namePools/markers/branding 六面，
  **约定 URL `/data/content/<name>.json`**——占位与 overlay 真实态同形，本波先灌占位=现有
  代码常量，波 2 逐面接管）；7 处静默 fetch census 上报 provider（§5.5，不回退
  game-pipeline/beautifier 既有 warn）。横幅文案（产品名引用入 D32 白名单）+
  **§5.8 检测启发**：`contentStatus === placeholder` 且 Dexie 世界书条目规模远超占位阈值 →
  横幅切「检测到本地真实内容，导入内容包」措辞（验收 #15 的交付点）。
- **顺带（D28 死代码）**：删 `data/defaults/item_gen_system_prompt.txt`（零引用）、
  `worldbook-loader.ts::loadWorldBooks` + `WORLD_BOOK_FILES`（15 书清单唯一真源改
  `BUILTIN_IDS`）、`preset-loader.ts` `PRESET_BASE` 死路径 + `data/presets/` 目录、
  CODEOWNERS 空匹配规则。
- **规模**：M-L。

#### T3 presets 撤出 localStorage + 三态护栏【与 T2 并行；文件面：preset 读写侧】

- **设计**：D22。
- **改动面**：`settings-store.ts`（`serializeSettingsForLocalStorage` / `settings.presets` 镜像
  删除、`:459-472` M5.1 播种路径重写为 Dexie-only）；`PresetManager.vue`（10 处读镜像 →
  Dexie+内存 ref）；`AgentConfigPanel.vue:58` computed；`database.ts:771-776` `presets` 补
  三态护栏 + `database.test.ts` 断言；`settings-types.ts`。
- **契约要点**：`settings` 只留 `activePresetId`；迁移一次性（既有镜像数据以 Dexie 为准弃镜像，
  Dexie 空而镜像有 → 迁入后弃）。护栏作用域说明照 D22 注（手编备份）。
- **规模**：M。

#### T4 agents 分层（D44 四条修正全量）【依赖 T2】

- **设计**：D44、§5.4。**这是全计划风险最高的任务，brief 逐条对照 §5.4 的 1-4。**
- **改动面**：`agent-settings.ts`（`getAgentSettings` 加默认层参数——12 键 resolve；
  `listConfiguredAgents`/`updateAgentWorldBookIds` 迭代解析名册；`applyProjectDefaultToAgent`
  改「清覆写层」；`resetAgentSettings`；指纹迁移函数）；`settings-store.ts:436-443` boot 播种
  删除；`game-pipeline.ts:497-549`（统一走 resolve，消灭三种 precedence）；
  `workshop-types.ts:438-461`（grant/revoke 名册来源）；`AgentConfigPanel.vue` +
  `AgentParamsCard.vue`（显示解析值 + 来源徽标；`saveAgentSettings` diff 写入）；
  `AgentUpdateCenter.vue` 重定位（覆写 vs 默认差异面板 + 清除覆写）；历史默认指纹表
  `agent-defaults-fingerprints.json`（生成脚本 `scripts/build-agent-fingerprints.mjs`，
  现在从**本仓真实 agent-config.json** 生成——它就是「历史默认」）。
- **测试**：空覆写层 + 默认层 → story `worldBookIds` 非空；工坊 grant 达全名册；指纹迁移命中
  删除/未命中保留；`AgentUpdateCenter` 新语义；既有 `agent-settings-migration.test` 全绿。
- **规模**：L。**主会话波末重点审查对象。**

#### T5 Dexie v20 `contentPacks` + FullBackup 边界 + 对账【与 T3 并行；文件面：database.ts】

- **设计**：D18、§5.7。
- **改动面**：`database.ts`（v20 表 `contentPacks`；`DB_VERSION` 20；FullBackup **不收**
  contentPacks——`exportAllData`/`importAllData` 不动它；`reconcilePackState()` 挂
  `importAllData` 收尾）；`DataSection.vue` 文案；`database.test.ts`（版本冻结测试更新）。
- **契约要点**：对账范围 `{worldBooks, presets}` 逐 pack 拥有项（payload 现算 hash）；
  `activePresetId` 悬空 → payload 重导分支；`needs_attention` 不自动二选。
- **规模**：M。

#### T6 planner：四态基线 + 存档迁移计划 + 卸载计划【依赖 T1；与 T2-T5 并行（新文件，零撞面）】

- **设计**：D19、D20、D43、§5.2。
- **改动面**：新建 `src/sillytavern/content-pack-plan.ts` + 测试（planner 与 T1 的校验分文件，
  文件面不与 T1 撞——T1 先合）。
- **契约要点**：纯同步函数，基线由调用方传入（**不 fetch**）；worldbooks 四态（装包基线 >
  占位基线 `placeholder-hashes.json` > 冲突）；D43 三段式（900001+ 保留段假设写进注释；
  **按名配对**产 old→new uid 重写映射；单选钉选分区 `system_core`/`character` 失配 →
  `needs_selection`，多选失配 → 清除+note）；卸载计划（逐书编辑检测 → 确认清单 + 删后播序列）；
  升级 diff 从计划派生。
- **测试**：首装零冲突（新鲜占位）/ 编辑后 N 冲突 / 占位建档→装包 uid 迁移（`system_core`
  恰好单条）/ 卸载编辑检测。**这是 D38 契约测试与 D43 回归测试的共享内核。**
- **规模**：L。

#### T7 执行器：安装/升级/卸载 + 报告 UI【收波任务；依赖 T2-T6】

- **设计**：§5.2、§5.6、D19、D21。
- **改动面**：`content-store.ts`（执行器：快照→分节写入→存档迁移→contentPacks.put→注册表
  重灌→回滚）；导入入口（`DataSection.vue` 按钮 + 首页横幅按钮 + 文件 picker）；两阶段确认
  Modal + `WorkshopNote` 三类分组渲染；§5.6 恢复默认矩阵四入口改线
  （`AgentConfigPanel.restoreAgentDefaults` / `resetSingleWorldBook` / `resetToDefaults` /
  beautifier 回退——beautifier pack 规则走 provider 内存层，**不写用户表**）。
- **顺带（D42）**：boot 重播种通道——启动时比对 settings 里存的 `placeholderVersion` 与内置
  `placeholder-hashes.json` 的戳，戳前进时对「hash 仍等于占位基线」的书重播种（本波先留接口 +
  测试，占位 hash 清单 T15 产出后接真值）。
- **测试**：fake-indexeddb 端到端——装（含冲突确认路径）/ 升 / 卸（快照回滚路径）/
  占位建档→装包→存档存活（D43 回归，验收 #14c 的自动化半）/ 装包后 boot 时序断言 /
  D42 重播种（动过的书不被覆盖）。
- **规模**：L。

---

### 波 2 —— 代码内 IP 数据驱动化（7 并行，真实数据抽到 `data/content/*.json`）

> 共同模式：引擎保 schema + 纯函数 + 注册表读取；真实数据原样抽成 JSON 放 `data/content/`
> （URL `/data/content/<name>.json`，与 T2 注册表约定、T16 占位路径、私有仓 §3.1 树四方同形；
> dev 中间件本来就服务整个 `data/`，无需新配置）；`content-store` 把「占位 JSON fetch」与
> 「pack 分节」都灌进同一注册表。**本波结束时 app 行为与今日完全一致**（数据只是换了载体）。
> 🔴 撞面裁定（审计修订）：**`create-store.ts` 由 T8 独占**——T10 的 `:207`、T12 的
> `:1010/:1489` 与 D9 的起源印记区块（`:1470-1530`）都由 T8 顺带落地（各任务 brief 提供改法，
> T8 执行）；**`MapPanel.vue` 由 T11 独占**（含 `:22` 的 location 导入改线，T9 提供改法）；
> **`agent-tools.ts` 由 T10 独占**（含 `:219` 的品牌字符串，T13 移交）。其余文件面互不重叠。

#### T8 捏人目录【L，测试尾 XL】

- **设计**：D24。机制/数据切分线、`CreateStepDifficulty.vue:16` 直接 import、
  `field-enums.test.ts:166-180` 动态 import、create-store 六处同步消费点（`:204/:215/:347/
:736/:746/:1846-1848`）全部列在设计里，照抄进 brief。
- **产出**：`start-catalog-mechanics.ts`（留引擎）+ `data/content/catalog.json`（真实七池）+
  create-store 加载态 + 整页加载门（`CreateStepDestinyCore.vue:45` 先例推广）。
- **代执行（撞面裁定）**：T10 的 `create-store.ts:207`（血脉注册表改线）、T12 的
  `:1010/:1489`（era 字面量/传参）、**D9 起源印记区块（`:1470-1530`：`命定之灵/命定核心已激活`
  提示词改可选通用区块，收尾指令 `:1526` 同改；文案风格对齐 T14）**。
- 🔴 抽取时**原样保留** Overlord/Fate/HP 三段背景进 JSON（D10 的黑名单在 pack 构建器执行，
  不在抽取时悄悄删——留审计痕迹）。

#### T9 位置系统【S-M】

- **设计**：D25①。`location-db.ts` 数据 → `data/content/locations.json`；`$location`
  （`:910-921`）与 `audio-scene.ts:151/343` 默认参改注册表；`MapPanel.vue:22` 的改法**移交
  T11 执行**（T11 独占该文件）。测试：`location-db.test.ts` / `audio-scene.test.ts` 改打
  fixture（设计计量 ~90 断言）。

#### T10 血脉 + 随机表【S+M】

- **设计**：D25②③。`bloodlines.ts` / `random-tables.ts` 数据 → JSON；注册表缝；
  `agent-tools.ts:34,:214-241`（同步执行路径——registry 灌注时序已由 T2 ready promise 保证）
  **+ 同文件 `:219` 品牌字符串（T13 移交，T10 独占该文件）**；`create-store.ts:207` 改法交
  T8 代执行；`bloodlines.test.ts:51` 改 shape 断言。

#### T11 地图标记 + 外链三清【S】

- **设计**：D23。`MapPanel.vue:25` 静态 import → provider **+ `:22` location 导入改注册表
  （T9 移交，本任务独占该文件）**；`data/content/markers.json`；
  `useMapViewer.ts:24,29` i.ibb.co 删 + `:51` OSD prefixUrl 自托管（雪碧图进 `public/osd/`）
  或 `showNavigationControl: false`；`no-external-assets.test.ts` 扩 `src/**` `https?://`
  白名单扫描；`GamePage.test.ts` 顺带解耦验证。

#### T12 era/时间【S-M】

- **设计**：D9。`createDefaultTime(era)` 默认值中性 + `fromEpochMinutes` era 线程化（或
  GameTime 去 era 字段——brief 让 agent 按设计裁定二选一并报偏差）；SaveProfile 创建盖章
  （`database.ts:1343` 参数化）；`create-store.ts:1010/:1489` 改法**交 T8 代执行**（T8 独占
  该文件）；注释/示例字面量清理（`time-system.ts:66/:79/:98/:162`、`stat-projection.ts:188`）；
  `time-system.test.ts:39-48` 同步。

#### T13 branding 模块 + 版本注入 + 工坊配置化【M】

- **设计**：D26、D41。branding 落点定为**T2 注册表的 `branding` 分节 + 中性默认值文件
  `src/ui/branding-defaults.ts`**（不另起第二套）+ 运行时 `document.title`；改点清单照 D26
  逐项（index.html / HomePage ×5 / AboutSection ×3 / PlotSection / package.json /
  dev.bat+update.bat（ASCII！）/ favicon / variables.css / types.ts:2 /
  `poem-ejs.d.ts` → `engine-ejs.d.ts` + 创作指南引用同步；`agent-tools.ts:219` **移交 T10**）；
  `vite.config.ts` `define: __ENGINE_VERSION__` + **把 T1 预留的版本门接通电并补「过新包被
  拒绝」测试**（vitest 与 vite 共 config，define 生效——验证后报告）；`WORKSHOP_API_BASE` →
  配置（默认 unset → 工坊入口空态；`failure-text.ts:37` 文案随配置）。

#### T14 演示面重写【M，写作型】

- **设计**：D27。`test-save.ts` / `test-fixtures.ts` 中性重写（保结构保功能，换叙事）；
  `agent-templates.ts:393/:403/:411` stub 去 IP；`placeholder-registry.ts` 3 处；
  🔴 **通用叙事引导**：story 占位预设（8-12 条目）+ 无预设回退 systemPrompt 正文（输出契约
  `<maintext>/<option>/<sum>/<vars>` 完整、工具约定保真）——先产出到
  `data/content/placeholder-story-preset.json` 供 T16 组装。叙事内容遵守
  `reference/narrative_context_example.md` 的「不应出现什么」清单（通用奇幻、无机制数值入文）。

---

### 波 3 —— 占位内容 authoring（2 并行；可与波 2 尾部重叠）

#### T15 占位世界书 ×15 + hash 清单【M】

- **设计**：§6、D43①、D42。15 本落 **`data/placeholder/worldbooks/*.json`**；同 id/分区/
  `builtIn:true`；uid 全部 ∈ 900001+；每本 2-5 条通用奇幻条目；全集 ≥1 EJS 动态条 +
  ≥1 静态条、总数 ≤150；产 `scripts/build-placeholder-hashes.mjs`（输入目录参数化——波 4 换
  `public/data` 重跑）→ `src/sillytavern/placeholder-hashes.json`（逐书 hash +
  `placeholderVersion`，D20/D42/卸载三消费方的共同输入）。编码门自检。

#### T16 其余占位件组装【M】

- **设计**：§6。占位 agent-config（13 id 齐、systemPrompt 300-800 字通用、story 挂 T14 预设、
  presetId 固定且 ≠ pack id）→ `data/placeholder/defaults/`；占位 catalog/locations/
  bloodlines（同 id 同 modifiers）/namePools/branding → **`data/placeholder/content/`**
  （URL 同形铁律）；markers(`[]`) → `data/placeholder/defaults/`；beautifier 演示规则 4-6 条。
  🔴 **audio manifest 占位不在 `data/` 树**：消费方是 `/audio/manifest.json`
  （`audio-store.ts:57`，源 `public/audio/manifest.json`）——本任务只准备 `[]` 内容，
  **就地替换在波 4 T17 做**（真实 manifest 随之入 staging）。其余 hash 入 T15 清单（脚本重跑）。

---

### 波 4 —— 🔴 原子交换 + 守门（两个受控 PR，主会话盯全程）

#### T17 原子交换 PR【设计 §10.2 的原子集，一个 PR 内完成】

0. **前置自检（D29/R5）**：scrambled corpus 泄露审计（678 KB fixture 逐块查 stats/features
   元数据与未混淆字面量）——**在生成器还能就地跑的时候做**；有泄露先重生成再继续。
1. `data/placeholder/` → `public/data/`（worldbooks/defaults/content 布局照搬，URL 不变）；
   真实内容 → **`_private-staging/data/`**（严格 §3.1 树形；本仓临时目录，波 6 迁私有仓）：
   `data/worldbooks/` + `data/defaults/` + `data/content/`（波 2 抽出的真实 JSON）+
   **`data/regex-remote-snapshot.json`（点名，在三个 glob 之外）** +
   **`public/audio/manifest.json` → `_private-staging/data/audio/`，原位写入 T16 备好的 `[]`**。
   🔴 **`reference/` 全树离场（审计 #1）**：瘦身件（卡片 JSON / world_book_index /
   audit_report / agent 流程测试 / 战斗样本 / HTML 参考页 / 各 .txt）→
   `_private-staging/reference/`；三类 ✋ 件（两份 .jsonl 对局导出、游戏实例*、角色生成.txt）
   按 T0.3 裁定，默认 **`git rm`（历史留档即归档）**。`.gitignore`/`.prettierignore`/
   `eslint.config.js` 里的 reference 条目相应清理。
2. `vite.config.ts`：无条件读中间件删除；`POEM_CONTENT_DIR` 条件 overlay（读 + PUT 门控 +
   define 标志）+ `configurePreviewServer` 挂 BFF（D14+D15）；watch ignored 调整；
   「保存为默认」按钮按 define 标志隐藏。
3. `worldbook-ejs-corpus.test.ts` 整文件 → `_private-staging/tests/`（D29）；
   `ejs:fixture` 脚本删；`scramble-worldbook-ejs.mjs`、`extract-map-markers.cjs`、
   `import-regex-rules.mjs`、**`build-agent-fingerprints.mjs`（输入已离场，一次性工具）** →
   `_private-staging/tools/`。
4. `encoding-invariants.test.ts` 公开半（DATA_ROOT → `public/data`，哨兵放宽）；完整版拷贝
   → `_private-staging/tests/`（D30）。
5. `beautifier-segments.test.ts` / `view-audio.test.ts` 换合成 fixture（D31/D12）。
6. `tests/agent-framework/**` + `tests/realtime_export/*.preset.json` →
   `_private-staging/`；`knip.json` 两行 entry 删。
7. format glob += `"public/data/**/*.json"`；`build-placeholder-hashes.mjs` 输入指
   `public/data` **重跑**，清单校验一致。
8. 末位 commit：reviewed `knip:update`（D34）。

- **出口**：CI 全绿；`npm run dev`（无 overlay）= 占位态可玩；
  `POEM_CONTENT_DIR=_private-staging/data` = 真实态可玩；`vite preview` `/api` 通。

#### T18 守门与契约测试 PR【依赖 T17】

- `tests/no-world-content.test.ts`（D32 两轴：37 词词表 + 路径白名单 + 体量阈值 + 13 agent 断言
  - story preset prompts 非空 + `reference/` 不存在）；
- `tests/contract/pack-install.contract.test.ts`（D38：`POEM_PACK_FILE` 未设 skip；基线由
  `node:fs` 读 `public/data` 供给）；
- 零安装态启动 smoke（R1 闭环）。

---

### 波 5 —— 清洗（2 并行）

#### T19 测试 fixture 中性化扫荡【M，机械量大】

- **设计**：D33。~60 测试文件 IP 名 fixture（`state-manager.test.ts` 112 处起）；
  `combat-v3/fixtures/case-*.fixture.json` ×7（角色/招式叙述中性化 + 删 `sourceCase`）；
  `tests/ui/components/*SystemCard.test.ts` mock 名；**「登神要素」字串（审计 #12）**：
  `tier-constants.ts:217` 报错文案 + `tier-constants.test.ts` 8 处 + `agent-tools.ts:875`
  doc 注释，中性化为「突破要素」。改名不改断言结构；跑全量测试证明等价。

#### T20 docs / 仓面 / 工具链清洗【L，按清单执行】

- **设计**：D36、D37、D45、§7.2、D35 工件、§5.8。A 类 → `_private-staging/docs/`；
  ARCHITECTURE.md 363 行切分；B/C 清洗清单逐件（含 `docs/superpowers/**` 整树、`design.md`
  标题等 v1.2 补录）；**`docs/CHANGELOG.md` 截断重开（§0.3：全文归 `_private-staging/docs/`，
  公开侧从快照日重开，审计 #13）**；README/PRODUCT/AGENTS/CLAUDE/CONTEXT 引擎叙事重写
  （AGENTS.md 去 reference 指针与势力/血脉清单；保 T1-T7 表改标「引擎默认平衡表」）；
  LICENSE（MIT）/ CONTRIBUTORS.md / THIRD-PARTY-NOTICES 内容分发节 / CODEOWNERS 修正 +
  **测试者迁移公告**（§5.8 四个降级面：美化 22 条/地图标记/捏人目录/内置曲库——写进 README
  迁移节或独立 MIGRATION.md）；`.claude/` 分叉（audit-code + code-writer 移
  `_private-staging/`；agent-memory/.codex/.impeccable/.playbook 标记「不进快照」清单文件
  `docs/planning/snapshot-exclusions.md`）。产出后主会话跑 D32 门复扫。

---

### 波 6 —— 私有内容仓

#### T21 私有仓 scaffold + 内容迁移【M】

- **设计**：§3.1（`data/` 形状铁律）、D3。建仓（✋ T0.3 裁定）；`_private-staging/` 全量迁入
  （data/ 树 + content/ + tests/ + tools/ + docs/ + reference/ 瘦身件）；README（创作工作流：
  `POEM_CONTENT_DIR` 指法 + PUT 写回说明）。🔴 §3.1 三类不迁件（.jsonl 对局 / 游戏实例 /
  角色生成.txt）按 T0.3 裁定处置，默认留本仓归档。

#### T22 pack 构建器 + 私有 CI【L】

- **设计**：D38、D19、D10、D13、§3.2。`tools/build-pack.mjs`：读内容树 → 组装 §4 schema →
  schema 校验 + 编码门 + **D10 黑名单硬拦**（Overlord/Fate/HP 背景）+ D13 provenance 标记 +
  逐节 hash 盖章 + 尺寸报告。CI 四门：编码门（完整版）/ 全语料 EJS 门（迁来的
  `worldbook-ejs-corpus.test.ts`，含 golden）/ pack 构建自检 / 契约 job（clone 引擎 +
  `POEM_PACK_FILE` 跑 `tests/contract`）。（scrambled corpus 泄露审计已前移至 T17 步骤 0；
  本任务只接常态化职责：私有语料变更时重生成 fixture 并向公开侧 PR。）

#### T23 构建真实 pack v1.0.0【S】

构建、契约 job 过、`minEngineVersion` 定值、Release 草稿。授权未决分节按 D35 状态裁剪
（最小可分发 = 世界书 + agent-config，R9）。

---

### 波 7 —— 验收与切仓

#### T24 真机三走查【主会话 + 主人】

- **设计**：验收 #14。(a) 零安装态演示环路（build + preview）；(b) 导入 v1.0.0 pack 全链路
  游玩（世界书/预设短路/捏人目录/地图/血脉全量核对 + 恢复默认不回占位 + 升级 diff + 卸载
  回落）；(c) 占位期建档 → 装包 → 旧存档 `system_core` 恰好单条（needs_selection 流程）。
  发现的问题按 debug-loop 常规修复后**重走该项**。

#### T25 快照切仓【主会话执行，✋ 主人确认名字与时点】

- **设计**：D1、D2、D45、§0.2 全表。次序：本仓最终 CI 绿 → `git archive HEAD` 展开 →
  删 `_private-staging/`（快照排除清单核对）→ 新公开仓（✋名）首 commit → **新仓上**跑全 CI +
  D32 词表全树扫描 + `git ls-files` 人工 review（R7 的一坐审）→ CI/CODEOWNERS 移植 →
  tag + `__ENGINE_VERSION__` 对齐 → 本仓 GitHub 转私有 + README 指针（开发已迁移）→
  验收 §0.2 十五条逐项勾。

---

## 3. 主会话验收清单（对照设计 §0.2）

| #   | 验收                                          | 由谁交付                | 核验动作                           |
| --- | --------------------------------------------- | ----------------------- | ---------------------------------- |
| 1   | 全树无世界内容（白名单外）                    | T17-T20, T25            | 新仓首 commit D32 门 + 人工 review |
| 2   | build+preview 零安装态演示环路                | T14-T17                 | T24(a)                             |
| 3   | 显式内容态                                    | T2, T7                  | T24(a) 目视 + census 测试          |
| 4   | 装包后行为等价 + 首装零虚假冲突               | T6, T7, T23             | T24(b) + 契约测试                  |
| 5   | 恢复默认不回占位                              | T7                      | T24(b) 专项                        |
| 6   | 升级/卸载 + 零残留                            | T6, T7                  | T24(b) 专项 + 单测                 |
| 7   | 公开仓 CI 全绿（EJS 门 = scrambled + parity） | T17                     | 每波出口 + 波 4 复核               |
| 8   | no-world-content 门                           | T18                     | 新仓首 commit 跑                   |
| 9   | 私有 CI 四门                                  | T22                     | 波 6 出口                          |
| 10  | key 已轮换                                    | T0.1                    | ✋ 主人确认                        |
| 11  | LICENSE/署名/重写/贡献者                      | T20                     | 波 5 review                        |
| 12  | npm 关死                                      | T0.2                    | 立即                               |
| 13  | 授权五件处置记录                              | T0.3, T22               | 构建器状态位                       |
| 14  | 真机三走查                                    | T24                     | —                                  |
| 15  | 现存安装旅程                                  | T2, T7（§5.8 检测横幅） | T24(b) 前置核                      |

## 4. 已知风险与兜底

| 风险                                             | 兜底                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| T4（agents 分层）改动面大、precedence 是行为变更 | 波 1 主会话专项 review；指纹迁移有单测；测试者升级路径 T24(b) 实测   |
| T8 同步→异步波及 create-store 123 个 it          | 设计已列全消费点；分两 commit（机制切分 → 异步化）；失败两次即停上报 |
| 波 4 原子集漏项 → 红 CI                          | §1.2 六处硬耦合逐项核对单进 brief；PR 内 CI 过了才合                 |
| 占位 story 质量不够「能玩」                      | T14 写作型任务单列；T24(a) 不过就重写，不降验收                      |
| scrambled corpus 审计出泄露                      | 私有仓重生成（生成器自带编译等价自检），公开侧 PR 换 fixture         |
| 主人授权裁定拖延                                 | R9：最小可分发包先行，构建器按 D35 状态位裁剪分节                    |
| 私有/公开 schema 漂移                            | D38 契约 job 常驻私有 CI；改 pack 类型的引擎 PR 必须触发它           |

## 5. 与设计文档的对应关系

D1/D2/D45→T25；D3→T21；D4→T0.3/T25；D5→T0.1；D6/D7/D8→T1（校验）+T20（文档表述）+
T19（「登神要素」字串）；D9→T12+T8（create-store 面代执行）；D10→T8（保留抽取）+T22（黑名单）；
D11→T16（演示规则）+T17(1)（规则文件与 regex snapshot 入 staging）；
D12→T16(占位 `[]` 备料)/T17(1)(就地替换+真实 manifest 入 staging)/T17(5)(view-audio fixture)；
D13→T22；D14+D15→T17(2)；D16→T2；D17→T1；D18→T5；D19→T6/T7；D20→T6；D21→T7；D22→T3；
D23→T11；D24→T8；D25→T9/T10（create-store/MapPanel/agent-tools 撞面移交见波 2 preamble）；
D26→T13；D27→T14；D28→T2 顺带（§0.3 有豁免注记）；D29→T17(0)(审计)+T17(3)(迁移)；
D30→T17(4)；D31→T17(5)；D32→T18；D33→T19；D34→各波末；D35→T0.3/T20/T22；D36/D37→T20；
D38→T18/T22；D39→T0.2；D40→T13(版本注入+门通电)/T22(构建)；D41→T13；D42→T7(重播种通道)+
T15(hash 清单)；D43→T6/T7/T15；D44→T4；§3.1 reference 分流→T17(1)；§5.8→T2(检测横幅)+
T20(迁移公告)。
