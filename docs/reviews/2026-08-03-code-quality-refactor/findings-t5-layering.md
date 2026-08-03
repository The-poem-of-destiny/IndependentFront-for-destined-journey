# T5 分层塌陷：seam 说过要落但没落，巨石继续长

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

项目在文档里定义了清晰的分层（planner/executor、types 唯一来源、组件与主题的私有边界、GamePipeline 只做编排），但缺口出现时没有可用的出口，于是逻辑就近长在最方便的宿主里——3823 行的设置页、1600 行的管线类、Pinia 闭包里的文案与闸门、主题 CSS 直接伸进组件私有类名。结果是「两个不相干的理由改同一个文件」，且这些逻辑只能通过驱动整个宿主才能测。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                                                                           |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Q-23](#q-23) | 中     | types.ts 3716 行既是类型库又是常量/函数库，「大型联合类型拆 types-\*.ts」只兑现过一次；combat-v3/types.ts（1773 行）还把边界反转成根类型文件反向 import 子模块 |
| [Q-24](#q-24) | 中     | asset-store 的「纯执行器」定位没守住：约 200 行文案/摘要/D19 闸门长在 Pinia 闭包里                                                                             |
| [Q-25](#q-25) | 高     | 视图层巨石：SettingsPage.vue 3823 行内联 9 个设置分区，StatusOverview.vue 夹着 260 行画像导入/裁剪/toast 管线                                                  |
| [Q-27](#q-27) | 低     | beautifier iframe 文档的 290 行运行时逻辑内嵌在模板字面量里，四个职责混在一个函数，只能整串断言                                                                |
| [Q-28](#q-28) | 高     | crimson.css 与 indigo.css 里 319 条全局选择器直接伸进组件的 scoped 私有类名                                                                                    |
| [Q-29](#q-29) | 高     | Agent 调用装配与整条 LLM 管线没有独立层：端点/agent-config.json/世界书装配在 create-store 与 game-pipeline 各写一份且已漂移，两个宿主分别涨成 L 级巨石         |

<a id="q-23"></a>

### Q-23 types.ts 3716 行既是类型库又是常量/函数库，「大型联合类型拆 types-\*.ts」只兑现过一次；combat-v3/types.ts（1773 行）还把边界反转成根类型文件反向 import 子模块

- **严重度**：中
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/sillytavern/types.ts:1`、`src/sillytavern/types.ts:10`、`src/sillytavern/types.ts:12`、`src/sillytavern/types.ts:674`、`src/sillytavern/types.ts:1182`、`src/sillytavern/types.ts:1813`、`src/sillytavern/types.ts:1844`、`src/sillytavern/types.ts:2296`、`src/sillytavern/types.ts:2801`、`src/sillytavern/combat-v3/types.ts:1`、`src/sillytavern/combat-v2-types.ts:26`、`src/sillytavern/char-gen-agent.ts:37`、`src/sillytavern/char-gen-agent.ts:567`、`src/sillytavern/combat-v3/describe-automaton.ts:11`
- **工作量**：L　**风险**：低
- **来源**：CORE-04, CMBT-11

**证据**

**主干膨胀。** `types.ts` 有 169 个 `export interface|type` 加 29 个 `export const|function`——里面装的不只是类型。行为：`createDefaultPreset()`(674)、`createDefaultCharacterState()`(1023)、`resolvePlotTree()`(1182)、`getHitRating()`(1813)、`createDefaultQuest()`(2669)。数值规则表：`INTENTION_CONFIGS`(1844，60 行战斗意图表)、`CRAFT_PRODUCTION_BONUSES`(2296，60 行制作产能表)、`MORALE_OUTCOME_POOL`(2801)、`DIVINITY_LEVEL_NAMES`(1937)、`DAMAGE_TYPE_FORMULAS`(1784)。这些常量的消费方是 `craft-dc.ts` / `combat-*` / `morale-system.ts`，各自只用其中一两张表，却都要 import 整个 `types.ts`。

AGENTS.md 设计约定第一条说「大型联合类型可拆分为 `types-*.ts`」，全仓只有 `types-audio.ts` 一个，而且它自己的文件头注明「数据模型类型仍在 types.ts」——真正的音频类型（`AudioTrack` 3494 / `AudioPlaylist` 3556 / `AudioPlaybackState` 3570）还留在主干，拆分只搬走了注入缝接口。域边界在文件里其实已经用注释分好（角色系统 / 战斗 / 制作 / Marker / 素材 / 音频），只是没落成文件。

**边界反转。** `combat-v3` 把 1773 行类型放进子目录下一个裸 `types.ts`，且依赖方向是反的——`types.ts:10-12` 带着注释「type-only 循环安全：combat-v3/types.ts 反向 import 本文件的 CombatParticipant/StatusEffect 也是 type-only」，随后 `import type { EffectAutomaton } from './combat-v3/types';`。combat-v3 之外有四个非测试模块直接伸进去（`char-gen-agent.ts:37` 及其 :567 的内联 `import()`、`combat-v2-types.ts:26`、`describe-automaton.ts:11`、`types.ts:12`），而 `combat-v3/index.ts:8-11` 明文声明除 `openCombat`/`runCombatV3` 与六个具名类型外一律内部。

> 复核修正：原始发现称「五个外部模块」，实为四个（`char-gen-agent.ts` 的两处属同一模块），另有 `describe-automaton.test.ts:4`。另需说明该反向边是 type-only、编译期即擦除，两侧都有注释显式认可，**没有运行时或打包后果**——这是文档一致性问题而非缺陷。

**影响**

任何一个域改类型都要动同一个文件，多人/多 agent 并行时它是永久冲突点；因为它同时是运行时模块，「只想要一个 `QualityLevel`」的叶子模块会把 60 行制作加成表一起拖进依赖图（这是构建图的陈述——Vite/rollup 会 tree-shake 掉常量表，产物体积不受影响）。3716 行也意味着任何一次全文件阅读要 2 万+ token，AI 协作成本直接翻倍。边界那侧的代价是：`index.ts` 说内核是只有一个公开面的深模块，四个外部 importer 说不是，根类型文件还与它构成双向类型环——贡献者无法从文档回答「战斗类型该加在哪」。

**重构建议**

必须排在死类型清理之后（否则把 v3 已废弃的类型一起搬进新文件），且动手前先拍板域边界：`QualityLevel` 被 craft 与 item 共用，应留主干。

**第一步（成本最低、收益最确定）：** 把 `EffectAutomaton` 提升到兄弟文件 `src/sillytavern/types-combat.ts`——它是**唯一**制造出「根类型文件反向 import 子模块」这条边的符号；顺带把确实跨界的 `EffectAutomatonDecl` / `EffectIntent` / `ModifierSlot` / `WindowKey` / `SummonedUnitDefinition` 一起提上来，`combat-v3/types.ts` 内部改成 re-export，四个外部 importer 与 `types.ts:12` 全部重指新文件。然后修订 AGENTS.md:209，把规则写成实际执行的那条：跨模块类型放 `types.ts` 或 `types-*.ts`；子系统私有类型可以放在子系统旁边，前提是外部无人 import。

**第二步（按已有注释边界切，一次一域，纯机械搬运）：**

- `types-combat.ts`（承接上一步）继续吸收 `CombatParticipant` / `CombatState` / `HitRating` / `IntentionConfig` + `HIT_RATINGS` / `INTENTION_CONFIGS` / `DAMAGE_TYPE_FORMULAS` / `COMBAT_TYPE_MORALE_THRESHOLDS` / `getHitRating`
- `types-craft.ts`：`Craft*` + `QUALITY_RANK` / `QUALITY_BY_RANK` / `CRAFT_DC_BASE` / `CRAFT_DC_MODIFIER_RANGE` / `CRAFT_QUALITY_EXP` / `CRAFT_PRODUCTION_BONUSES` / `CRAFT_INDUSTRY_ATTRIBUTE`
- `types-marker.ts`：`DetectedMarker` 家族 + `MarkerScanResult`
- `types-asset.ts`

`types.ts` 保留 `export * from './types-*'` 做桶，调用方零改动。再把 `createDefault*` / `resolvePlotTree` 挪到各自领域模块（`createDefaultCharacterState` → `char-query.ts` 或新建 `character-factory.ts`，`resolvePlotTree` → `plot-engine.ts`），目标是 `types.ts` 只剩 `export type/interface` 与桶转发。

**不要做的一件事：** 把 `AudioTrack`/`AudioPlaylist`/`AudioPlaybackState` 并进 `types-audio.ts`。该文件头注明确写了「不搬进来——那会制造第二个真相来源」，这是一条有记录的刻意决定；要推翻它得先针对那条注释论证，不能顺手反转。

<a id="q-24"></a>

### Q-24 asset-store 的「纯执行器」定位没守住：约 200 行文案/摘要/D19 闸门长在 Pinia 闭包里

- **严重度**：中
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/ui/stores/asset-store.ts:825`、`src/ui/stores/asset-store.ts:866`、`src/ui/stores/asset-store.ts:893`、`src/ui/stores/asset-store.ts:935`、`src/ui/stores/asset-store.ts:953`、`src/ui/stores/asset-store.ts:968`、`src/ui/stores/asset-store.ts:1028`、`src/ui/stores/asset-store.ts:435`、`src/ui/stores/asset-store.ts:1825`、`src/sillytavern/asset-filename.ts:1`
- **工作量**：M　**风险**：低
- **来源**：STORE-05

**证据**

AGENTS.md 把 asset-store 定义为「执行器（planImport 出计划，本店只落库）」。实际 `defineStore` 闭包里还住着这些不碰任何 ref 的纯逻辑：`summarizePlan`(:866，把 `plan.skips` 按 reason 归类成摘要)、`buildImportMessage`(:935，拼那条中文汇总，含 `WARNING_TEXT` 表 :893)、`reimportHint`(:953)、`notifyImportSummary`(:968，六分支优先级文案)、`mergeSummaries`(:1028，多半边回执合并)。

`checkNameGates`(:825) 的文档注释自己承认这是欠账：「这三条里前两条本该与 `violatesNamingInvariant` 并排住在 `asset-filename.ts`（引擎层，两个入口共用）。D19 暂居此处是因为本次任务的范围栅栏不含那个文件」，并已预先授权搬迁（「等有人拥有它时，整块搬过去即可，调用点不变」）。`exportZip`(:1825-1998) 是另外 170 行导出编排（含音频半边）。`asset-store.test.ts` 已 2161 行，比被测模块还大。

> 复核修正：`violatesZipEntryName`(:435) 已经是模块级纯函数、不在 Pinia 闭包里——把它挪到 `asset-filename.ts` 是文件移动而非抽取。

**影响**

计划器（`asset-import-plan.ts`）与执行器的分工是这套素材系统最值钱的设计，但摘要与文案回流到 store 之后，「一次导入只弹一条提示」的六分支优先级就只能通过起 Pinia + 打桩 Dexie 才能测——这是 2161 行测试的主要来源。D19 闸门滞留在 UI 层则意味着导入侧与改名侧的命名不变式判据分居两层，将来给导入侧补 D19 时必然是第二次实现，而命名不变式恰恰是素材库主键的唯一依据。引擎侧那层纯函数质量很好、值得承接更多，下沉方向明确。

**重构建议**

三刀，互不阻塞，都不触碰任何 AGENTS.md 不变式（`asset-filename.ts` 在 AGENTS.md 里本就被点名为命名不变式的归属地）。建议先做第二刀，它是自带授权、价值最高的一半。

1. **下沉 D19 闸门**：把 `violatesZipEntryName`(:435) 与 `checkNameGates`(:825) 的前两关移进 `src/sillytavern/asset-filename.ts`，导出 `checkAssetNameGates(target): NameGateViolation | null`，导入侧与改名侧共用同一实现，调用点不变。这一刀让「导入侧将来补 D19」变成接线而不是重写。
2. **抽 `src/ui/lib/asset-import-summary.ts`**：搬 `emptySummary` / `summarizePlan` / `buildImportMessage` / `reimportHint` / `mergeSummaries` 与 `WARNING_TEXT` 表；`notifyImportSummary` 拆成纯的 `describeImportOutcome(summary): { text: string; type: ToastType }` + store 里三行的 notify 包装。六分支优先级从此可以用纯函数测，`asset-store.test.ts` 里对应的那批用例整体迁到 `asset-import-summary.test.ts`，不再需要 Pinia 与 Dexie 桩。
3. **抽 `src/ui/lib/asset-export.ts`**：把 `exportZip`(:1825-1998) 的编排搬过去，store 只提供行读取与 blob 读取两个回调。

三刀做完，asset-store 回到「拿计划落库 + 暴露响应式状态」的定位，测试体量应显著低于被测模块。

<a id="q-25"></a>

### Q-25 视图层巨石：SettingsPage.vue 3823 行内联 9 个设置分区，StatusOverview.vue 夹着 260 行画像导入/裁剪/toast 管线

- **严重度**：高
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/ui/components/settings/SettingsPage.vue:1`、`src/ui/components/settings/SettingsPage.vue:1330`、`src/ui/components/settings/SettingsPage.vue:1385`、`src/ui/components/settings/SettingsPage.vue:1883`、`src/ui/components/settings/SettingsPage.vue:2013`、`src/ui/components/settings/SettingsPage.vue:2251`、`src/ui/components/settings/SettingsPage.vue:2385`、`src/ui/components/settings/SettingsPage.vue:2781`、`src/ui/components/settings/AudioSection.vue:1`、`src/ui/components/game/StatusOverview.vue:29`、`src/ui/components/game/StatusOverview.vue:186`、`src/ui/components/game/StatusOverview.vue:265`、`src/ui/components/game/StatusOverview.vue:289`、`src/ui/components/game/StatusOverview.assets.test.ts:1`
- **工作量**：L　**风险**：中
- **来源**：UI-01, UI-07

**证据**

`SettingsPage.vue` 共 3823 行：script `1-1277`、template `1279-2779`、单个 `<style scoped>` 块 `2781-3823`（约 1040 行）。三个分区已抽成一行子组件——`<BeautifierSection v-if="activeSection === 'beautifier'" />`（2376）、`<AudioSection .../>`（2379）、`<AssetSection .../>`（2382），且各自有子目录（`settings/audio/` 下 AudioMixer/AudioLibrary/AudioPlaylists/AudioFolderStrip/AudioDialogs/format.ts/dialogs.ts，`settings/assets/` 同构）。另外九个仍是内联 `<section v-if="activeSection === '…'">`：api 1330、agent 1385 + 1873、worldbook 1883、plot 2013、memory 2188、theme 2251、messages 2337、data 2385、about 2479。它们的 script 状态已被横幅注释物理隔开（`// ==== API 池` 64-273、`// ==== Agent 配置` 275-330、占位符注册表 332-528、预设系统 530-780、agent actions 780-1001、worldbook 1003-1167、plot 1168-1198、theme/messages 1198-1216、data 1217-1276），各自触碰 `cfg.settings` 的互斥切片。`AudioSection.vue` 只有 208 行，就是这次重构收敛到的壳层尺寸。

`StatusOverview.vue` 共 1411 行，其中 29-288 是一整段自足的无关关注点——:29 的横幅写着「玩家画像 —— 素材库渲染 + 定点导入」，覆盖 `useAssetImage` 接线、`ASSET_MIMES`/`PORTRAIT_ACCEPT`/`assetMimeOf`（83-104）、隐藏 file input 与 `pickPortrait`（105-119）、设置弹窗开关（121-142）、裁剪台生命周期 `cropOpen`/`cropSource`/`onCropSaved`（144-178），以及两个各带 30 行注释的纯函数 `portraitMessage(outcome, name)`（186-212，对 `AssetMutationOutcome` 的五分支 switch）与 `announcePortraitWrite(outcome, id, name)`（265-287，回读 `portraitRow` 判断写入是否可见）。状态总览本体从 :289（`// ═══ 折叠状态 ═══`）才开始。缝的存在早被承认：同级测试就叫 `StatusOverview.assets.test.ts`，897 行全部服务于这一段。

> 复核修正：UI-07 原文称「同一段画像接线在 CharacterListPanel 与 ScenePanel 被部分重复实现」，不成立。两者都不 import `useAssetImage`，没有 file input、没有裁剪台、没有任何 toast/消息逻辑，只经 `<AssetMedia :name :type>` 只读渲染（`ScenePanel.vue:5/324` 配 `ASSET_TYPE_FALLBACK_CHAIN`，`CharacterListPanel.vue:4/126/165` 配 `ASSET_TYPE_AVATAR_CHAIN`），其同级 assets 测试分别只有 136 与 130 行且只测渲染回退。今天没有可去重的东西，「让它们复用于 NPC 画像」是新功能而非收敛。抽取本身仍成立（两个不相干的变更理由；两个纯函数无需 mount 即可测）。

**影响**

每一次设置改动——加一个 Agent 参数、加一个剧情开关、调一个主题色板——都要重开同一个 3800 行文件，无关工作在 git 里互撞，review 无人能通读。单一 scoped style 块意味着为剧情分区加的 CSS 类对 API 分区同样生效，共享的 `.section`/`.centered` 让跨分区回归不可见。测试也被卡住：仅有的两个 SettingsPage 测试（`SettingsPage.apikey.test.ts`、`SettingsPage.engine-imports.test.ts`）为断言一个行为必须挂载整页。StatusOverview 一侧，素材管线改动（新的 `AssetMutationOutcome`、新的受理 MIME）与状态布局改动都要编辑同一文件，而那 897 行测试为断言一个 toast 字符串必须连 game store、玩家、装备、buff 一起挂起来。

**重构建议**

均为机械性工作，无运行时风险，但建议排在 Q-18（设置类型）与 Q-11（品质表）之后落地，否则拆完还要再改一遍。

`SettingsPage.vue` 按「独立性 × 体积」排序，严格照 `AudioSection` 先例：每个新文件自带状态、自带 CSS、自带同级 `*.test.ts`；`SettingsPage` 最终只留 `activeSection`、`navItems`、页头与导航栏。

1. `settings/AboutSection.vue`（template 2479-2521，零状态，约 40 行）——先用它验证缝。
2. `settings/DataSection.vue`（script 1217-1276 的 `showClearConfirm`/`storageInfo`/`fmtBytes`/`exportAll`/`importAll`/`clearAll`，template 2385-2478，加 2455 的确认 AppModal）。
3. `settings/MessagesSection.vue`（script 1205-1216 `eventFilterLabel`，template 2337-2375）。
4. `settings/ThemeSection.vue`（script 1201-1204 `selectTheme`，template 2251-2336）。
5. `settings/MemorySection.vue`（template 2188-2250，无 script）。
6. `settings/PlotSection.vue`（script 1168-1198 `showPlotPreview`/`genreOptions`/`toggleGenre`/`plotDifficultyOptions`，template 2013-2187）。
7. `settings/WorldBookSection.vue`（script 1003-1167，template 1883-2012；已有 `WorldBookEditor.vue` 作为子组件）。
8. `settings/ApiSection.vue`（script 64-273，template 1330-1384，**加 2659 的添加/编辑 API 弹窗**）。
9. 最大的放最后，拆成镜像 `audio/` 的目录：`settings/agent/AgentSection.vue`（壳 + 子导航 1309-1329）、`AgentParamsCard.vue`、`AgentPromptCard.vue`、`PlaceholderPalette.vue`（script 332-528 加 `insertPlaceholder`/`phLabel`）、`PresetManager.vue`（script 530-780、template 1602-1872，**加 2522 的条目编辑弹窗与 2570 的预设编辑弹窗**）、以及 `settings/agent/agent-defaults.ts` 承接 `saveAsDefault`/`restoreAgentDefaults` 的纯逻辑部分。

三个尾部 AppModal 的归属务必按此处：2522 = 条目编辑弹窗、2570 = 预设编辑弹窗、2659 = 添加/编辑 API 弹窗（2455 的清除确认归 DataSection）。每完成一步，只把该分区的规则从 2781-3823 的样式块中挪走；残留壳层 CSS 应只剩页头、`.sub-nav`、`.section`、`.centered`。

`StatusOverview.vue` 一刀：把 29-288 整段抽成 `src/ui/composables/usePlayerPortrait.ts`，返回 `{ portraitRow, hasLargePortrait, portraitAccept, portraitInput, portraitActionLabel, pickPortrait, onPortraitFile, portraitDialogOpen, openDialog, closeDialog, cropOpen, cropSource, cropName, onCropSaved }`，入参 `(nameRef: Ref<string | undefined>)`。两个纯消息函数移入 `src/ui/components/game/portrait-messages.ts`（`portraitMessage`、`describePortraitWrite`）——它们收发都是普通值，测试完全不需要 mount。`StatusOverview.assets.test.ts` 随之拆成一个小的 `portrait-messages.test.ts`（纯函数，承接现有大部分断言）与一个薄的 composable 测试，组件只留标记与 12 行解构。

<a id="q-27"></a>

### Q-27 beautifier iframe 文档的 290 行运行时逻辑内嵌在模板字面量里，四个职责混在一个函数，只能整串断言

- **严重度**：低
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/ui/lib/beautifier-frame.ts:216`、`src/ui/lib/beautifier-frame.ts:524`
- **工作量**：M　**风险**：低
- **来源**：WB-08

**证据**

`buildBeautifierFrameDocument`（`beautifier-frame.ts:169-511`）返回一整份 HTML，其中 216-506 是约 290 行 JavaScript 运行时，塞在一个 TS 模板字面量里，混着四件互不相关的事：

- regexStorage 同步镜像（`__beautifierMakeStorage`，含配额校验、Proxy、mutation 批量上报，221-302、390-405）
- SillyTavern / MVU / lodash 兼容 shim（330-381）
- 高度测量（`measure`，406-440）
- 导航与表单拦截（385、482-488）

这段代码不过 tsc、不过 eslint、拿不到覆盖率，所有转义要手工顾——例如 :486 的 `/^\\\s*(?:#|data:|blob:|javascript:)/i`——测试只能对生成出来的字符串做子串断言。同文件 :524 另有一处 `data.sequence!` 非空断言。附带一处结构性开销：:412 在每次 ResizeObserver/MutationObserver 触发的 `measure` 里对整棵子树逐元素取计算样式：

```js
for (const element of body.querySelectorAll('*')) {
  const style = getComputedStyle(element);
  // ...
}
```

（仅 `mayUseFixedLayout` 时走此路径。）

**影响**

这是 SEC-01 隔离契约的**实际执行体**——配额、CSP 分档、storage 广播、导航拦截都在这里，而它同时是全仓最难验证的一段代码：改错一个大括号只有运行时才知道，改错一个转义只有真机才知道。四个职责挤在一个字符串里，也让「模型帧要关掉哪些能力」这类判断散落在 183-186 与内联脚本之间，读的人要在两处之间来回对照。

**重构建议**

把内联脚本切成三个独立的真 `.js` 源文件（纳入 eslint 与覆盖率），用 Vite `?raw` import 拼装：

- `beautifier-frame-storage.js`——镜像 + 配额 + mutation 队列
- `beautifier-frame-compat.js`——ST/MVU/lodash shim + 导航拦截
- `beautifier-frame-measure.js`——高度测量

`buildBeautifierFrameDocument` 退化成「按 scripts 策略挑片段 + 注入常量」的装配函数。存储镜像那份的配额语义（`assertSetAllowed` / `apply`）随即可以在 Node 环境直接单测，不必再经 iframe。`measure` 里的 `querySelectorAll('*')` 换成只查 `[style*=fixed]` 加一次性缓存，或改为在观察阶段记录候选元素集合。:524 的 `data.sequence!` 顺手改成显式校验。

**排期约束**：动这段等于动安全边界，价值真实但风险不对称——应与 Q-09/Q-10 同一批、由熟悉 SEC-01 契约的人做，并配一次真机走查（切片顺序、CSP 分档、跨帧广播三项各验一次）。

<a id="q-28"></a>

### Q-28 crimson.css 与 indigo.css 里 319 条全局选择器直接伸进组件的 scoped 私有类名

- **严重度**：高
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/ui/themes/crimson.css:84`、`src/ui/themes/crimson.css:148`、`src/ui/themes/crimson.css:347`、`src/ui/themes/crimson.css:429`、`src/ui/themes/crimson.css:750`、`src/ui/themes/crimson.css:776`、`src/ui/themes/indigo.css:82`、`src/ui/themes/bronze.css:1`、`src/ui/components/game/ScenePanel.vue:228`、`src/ui/components/game/ScenePanel.vue:436`、`src/ui/components/game/StatusOverview.vue:542`、`src/ui/components/game/StatusOverview.vue:809`
- **工作量**：L　**风险**：中
- **来源**：UI-03

**证据**

十个主题里八个是纯 token 块：`bronze`/`forest`/`ocean`/`sakura` 各 51 行、`misty-lilac` 59、`ivory` 64、`parchment` 68、`obsidian` 1。另外两个不是：`crimson.css` **1702 行**、`indigo.css` **555 行**，其中只有开头约 80 行是 `--theme-*` 声明，其余全是伸进组件内部的无作用域 CSS。`grep -cE "^:root\[data-theme='crimson'\] body" crimson.css` = **233**，indigo = **86**，合计 319 条。

样例：`:root[data-theme='crimson'] body .game-page-layout .scene-tab-body`（crimson.css:148）、`… .summary-name`（:347）、`… .res-fill`（:429）、`… .scene-panel > .tab-bar .tab-active::after`（:750）、`… .news-item::before`（:776）。而这些类名全部是组件 `<style scoped>` 块内的私有名：`.scene-tab-body` 声明在 `ScenePanel.vue:228`/`:470`、其 `<style scoped>` 起于 `:436`；`.summary-name` 声明在 `StatusOverview.vue:542`/`:972`、`<style scoped>` 起于 `:809`。两侧之间**没有任何连结**——没有共享常量、没有测试、组件里也没有一句注释警告这个类名在文件外承重。

这同时与 `docs/design.md` §1「主题无关：所有颜色来自 CSS 变量」直接冲突：这两个主题不是靠设 token 构建的，而是靠覆盖组件构建的，因此任何新面板在 crimson/indigo 下开箱就是没上主题的，需要手写三十来行附录。

**影响**

重命名 ScenePanel 里一个私有 CSS 类——Vue 的作用域机制本该让这件事免费——会静默毁掉十个主题里的两个，而组件、`typecheck`、`typecheck:vue`、CI 全都不吭声。反方向同样糟：1620 行主题 CSS 无法评审，维护者动 crimson 时没有任何办法知道哪些选择器还匹配活 DOM、哪些早已是死规则。这是本轮唯一一条严重度为高的条目，但排在后段，因为修法要先做清点、还要拍板产品口径。

**重构建议**

把这层「伸进组件」的耦合从事故变成**声明过的契约**，分三步。第一步之前必须先做一次清点：对 319 条选择器逐条判定「它今天还匹配活 DOM 吗」——本条证据未逐条验证过这点，清点结果直接决定后两步的工作量。

1. **判定「token 还是 hook」**。多数选择器是纯颜色/材质（`.res-fill` 的 background、`.summary-name` 的 colour、`.news-item` 的 border），它们应该变成 `themes/variables.css` 里的新 token——例如 `--theme-panel-texture`、`--theme-rail-texture`、`--theme-resource-fill-*`——由组件自己的 scoped 规则消费，主题只负责**赋不同的值**。这正是 design.md §1 要求的形态。但不要期待「整份塌回 token 块」：319 条里有真正结构性的工作（crimson 在 `.game-page-layout`/`.side-toolbar`/`.system-notif` 上叠的 `::before`/`::after` 镶嵌层、以及经 `--indigo-right-birds` 之类变量引用主题专属 PNG 的背景合成），必然留下一层 hook。
2. **给结构性残留一个公开钩子**。在组件模板上加 `data-theme-surface="rail|panel|notif"` 属性，主题只允许选这个属性，**永远不许选类名**。钩子清单写进 `docs/design.md` §4，作为主题↔组件契约。
3. **加 `src/ui/themes/theme-contract.test.ts`**：解析每份主题 CSS、提取全部选择器，若引用了声明钩子清单之外的类名就失败。需要如实说明它的边界——该测试没有真实 DOM，只能强制「不许用未声明的钩子」，无法检测已经死掉的选择器；但这仍是正确的强制点。

先决的产品决策一条：crimson 与 indigo 的深度定制是**保留**（改走 token + `data-theme-surface` 契约，成本 L）还是**砍掉**（退回纯 token 块，与另外八个主题一致）。这条不拍板，第 1 步的清点没有验收标准。

<a id="q-29"></a>

### Q-29 Agent 调用装配与整条 LLM 管线没有独立层：端点/agent-config.json/世界书装配在 create-store 与 game-pipeline 各写一份且已漂移，两个宿主分别涨成 L 级巨石

- **严重度**：高
- **主题**：分层塌陷：seam 说过要落但没落，巨石继续长
- **位置**：`src/ui/stores/create-store.ts:903`、`src/ui/stores/create-store.ts:958`、`src/ui/stores/create-store.ts:1014`、`src/ui/stores/create-store.ts:1055`、`src/ui/stores/create-store.ts:1205`、`src/ui/stores/create-store.ts:1388`、`src/ui/stores/create-store.ts:530`、`src/ui/lib/game-pipeline.ts:544`、`src/ui/lib/game-pipeline.ts:656`、`src/ui/lib/game-pipeline.ts:730`、`src/ui/lib/game-pipeline.ts:770`、`src/ui/lib/game-pipeline.ts:336`、`src/ui/lib/game-pipeline.ts:907`、`src/ui/stores/settings-store.ts:363`、`src/ui/stores/api-key-migration.ts:70`
- **工作量**：L　**风险**：中
- **来源**：STORE-01, STORE-04, STORE-07

**证据**

**装配层被抄了三份。** apiPool→`ApiEndpoint` 的映射逐字复制：`game-pipeline.ts:550-560` 的九行 `return ((s.apiPool ?? []) as any[]).map(entry => ({ id: entry.id || '', …, defaultModel: entry.defaultModel || entry.model || '', …, timeout: entry.timeout ?? 60000, enableThinking: entry.enableThinking ?? false })) as ApiEndpoint[]`，与 `create-store.ts:906-916` 同样九行（注释自承「对齐 game-pipeline.buildEndpoints」）。第三份等价转换在 `api-key-migration.ts:71` 的 `apiEntryToEndpoint()`（timeout 硬编码 60000、provider 规则不同）。

`/data/defaults/agent-config.json` 有四个独立 fetch 点：`game-pipeline.ts:685`（抽 preset + agentDefaults + ejsVarsCommit，失败 `console.warn` 留痕）、`create-store.ts:961`（只抽 `{...cfg, agentId}`，**丢弃 preset**，失败静默 `return []`）、`settings-store.ts:366`、`SettingsPage.vue:882`。世界书加载亦近似复制：`game-pipeline.ts:730-743` 与 `create-store.ts:976-994` 都是 `useWorldBookStore() → init() → loadWorldBooksWithFallback → filterBooksByEnabledEntries`，只差一层 worldBookIds 过滤。

**两个宿主各自涨成巨石。** `create-store.ts` 1972 行的 setup 闭包里至少住着六件不相干的事：捏人数值（228-338）、世界书与工坊启用轴（365-506）、目录 fetch 与解析（`parseCatalogItem` :530、`loadGroupedCatalog` :551）、一整条 Agent 调用链（`resolvePlotOutlineEndpoint` :903、`loadOutlineAgentConfigs` :959、`buildAgentMessagesAsync` 动态 import、`new AgentClient({ timeout: 300000 })` :1108、两轮自检重试循环 1129-1173、`extractSelfCritique` 的 XML+JSON 双路解析 1014-1052）、`exportAIDebugDump` :1205（直接 `document.createElement('a')` 触发下载）、以及 `buildOpeningPrompt` 1388-1519（130 行纯文本拼装：STATS_CN 中文映射、装备/技能/道具/背景逐段格式化）。后三者一行响应式状态都不需要写，却因为直接读 `xxx.value` 而无法脱离 Pinia 单测。

`game-pipeline.ts` 1611 行单类持有 11 个实例字段，其中三组互不相干：音频（`pendingAudioMarker` :123、`lastAudioLocation` :128、`flushPendingAudio` :336、`playForLocation` :366、`presentCharacterNames` :375、`primeSceneAudio` :388、`handlePlayAudio` :1017）、EJS 诊断（`ejsRejectToasted` :136、`flushEjsVarsDiffs` :907、`rejectEjsVarsDiff` :956）、配置装配（`buildAgentConfigs` :408、`buildEndpoints` :544、`loadPresets` :656、`loadActiveWorldBooks` :730、`loadSystemCoreWorkshopBookIds` :746、`getEndpointForAgent` :770）。剩下才是本体：`run` :200 加四条子系统分派（`handleCombatTriggerV3` :1346 / `handleCraftGen` :1455 / `handleCharGen` :1496 / `handleItemGen` :1560）。顺带一处结构性浪费：`getEndpointForAgent`（770-775）每次调用都重跑一遍 `buildEndpoints()` 的全池映射，而它在每回合每个 Agent 上都会被调。

> 复核修正：三点需要写进 PR 前提。① `apiEntryToEndpoint` 作用于 `StoredApiEntry`（Dexie 密钥迁移后的形状，`apiType ∈ chat|embedding`，无 `defaultModel`），不是宽松的 `settings.apiPool` 条目——合并成一个 `buildEndpoints` 是要调和两份不同的输入契约，不是删掉一份拷贝。② `create-store` 丢弃 preset 的实际影响窄于原文所述：`buildAgentMessagesAsync` 传的是 `presets = undefined`（`create-store.ts:1099`），而 agent-config.json 内嵌的 preset 是 story agent 的产物，plot_outline 丢掉它多半是潜伏而非当下误渲染。③ `game-pipeline.getEndpointForAgent` 的每回合重算，若改成「一次 run 内缓存」是行为变更而非纯重构——今天回合中途改设置会被下一次调用取到。

**影响**

任何 API 池字段的增改（新 provider 字段、超时策略、thinking 开关）必须同时改三处，改漏的那处表现为「捏人页大纲用了另一个端点/另一份 systemPrompt」——这类偏差不编译报错，只在真机上表现成模型选错。捏人页那条链路永远拿不到内嵌 preset 且加载失败零日志，与 game-pipeline 刻意「必须留痕」的决定相反。`extractSelfCritique` 这种 AI 输出解析与 game-pipeline 侧的同类解析（`extractJsonBlock` :1177）各自演化（与 Q-05 同源）。`buildOpeningPrompt` 的输出格式是 story / request_dispatcher 的输入契约，改它却要驱动整个捏人 store 才能验。想改「场景配乐什么时候切」必须打开这条 1600 行、同时管战斗与制作分派的文件；想给配置装配写单测必须先造一个完整 GamePipeline（含 game store、settings store、Dexie）——这正是 create-store 只能另抄一份的直接原因。这是 2026-07-27 审查 P2-03 就点过、seam 至今没落的老问题。

**重构建议**

动手前需要一个 owner 定下 seam 位置，因为要同时切开两个 L 级宿主并重定契约边界。建议顺序：

1. **`src/ui/lib/agent-runtime-config.ts`**（STORE-01 与 STORE-07 的同一个落点），导出三个纯/薄函数：
   - `buildEndpoints(settings): ApiEndpoint[]` —— 唯一的 apiPool→ApiEndpoint 转换。`api-key-migration.ts` 的 `apiEntryToEndpoint` 改为调用它，但要先显式调和 `StoredApiEntry` 与松散 apiPool 条目两份输入契约（建议加一个 `normalizeApiEntry(input): ApiPoolEntry` 前置层）。
   - `loadAgentProjectDefaults(): Promise<{ presets, agentDefaults, ejsVarsCommit }>` —— 唯一的 agent-config.json fetch + 解析 + 失败告警。**必须保留 game-pipeline 现有的 DB 优先语义与两处有意为之的 console.warn**（:695-698 记录 DB preset 遮蔽内嵌 preset，:713/:721 记录 fetch 失败），不得采纳 create-store 的静默 `return []`。
   - `loadVisibleWorldBooks(enabledEntries, worldBookIds?)`。

   `game-pipeline` 的 `buildEndpoints`/`loadPresets`/`loadActiveWorldBooks` 与 `create-store` 的 `resolvePlotOutlineEndpoint`/`loadOutlineAgentConfigs`/`loadPlotOutlineWorldBooks` 全部改调；`settings-store` 与 `SettingsPage` 复用同一个 loader。端点列表在一次 `run` 内算一次传下去——**这是行为变更，需与 owner 确认「回合中途改设置是否应立即生效」**。

2. **切开 create-store 的两刀**（都不动 UI）：
   - `src/ui/lib/opening-prompt.ts` —— `export function buildOpeningPrompt(draft: CreateDraftSnapshot): string`，入参是普通对象（装备/技能/道具/背景/命定核心/性格），store 只负责 `buildOpeningPrompt(snapshot())`；`extractSelfCritique` 一并挪成同目录纯函数并补 fixture 测试（理想情况直接复用 Q-05 抽出的 `model-json.ts`）。**搬可以，改措辞不行**——其输出是 story/request_dispatcher 的输入契约，内容规则受 `reference/narrative_context_example.md` 管辖。
   - `src/ui/lib/outline-runner.ts` —— `export async function runOutline(deps: { endpoint, agentConfigs, worldBooks, plotSettings, characterState, initialMessage, maxAttempts }): Promise<OutlineRunResult>`，把 1055-1202 整段搬进去，store 退回「攒参数 + 收结果 + 写 ref」。**必须保留 `buildAgentMessagesAsync` 的异步变体**（`create-store.ts:1068-1073` 注释，2026-08-01 修复 F3）：同步版 `buildAgentMessages` 会在宿主 realm 里用 `new Function` 求值世界书 EJS，绕开 QuickJS 隔离——换回同步版等于静默重开 SEC-02。
   - `exportAIDebugDump` 的 DOM 下载动作挪到 UI 组件，store 只吐 JSON 对象。

3. **切开 game-pipeline 的另两刀**（`run()` 时序完全不动）：
   - `src/ui/lib/pipeline-audio.ts` 的 `createSceneAudioController(game)`，暴露 `queue(marker)`/`flush()`/`primeForLocation(loc)`，GamePipeline 持有一个实例。**必须保留既有的时序不变式**——音频 marker 只在状态提交 + 回读之后才 flush（`run()` :317，理由写在 :119-122），因此 flush 的触发时机仍须由 GamePipeline 掌握。
   - `src/ui/lib/pipeline-ejs-vars.ts` 的 `flushEjsVarsDrafts(ctx, agentIds, { onReject })`，承接那三个诊断方法。

   余下的 GamePipeline 才名副其实：编排 + 四条子系统分派。

以上三组都不触碰 ADR-21（无一写入存档状态）。
