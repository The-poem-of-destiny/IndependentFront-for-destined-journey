# 露骨内容开关设计（Explicit Content Switch）

> **状态**：✅ 已实施（2026-11-20），真机待验证；内容迁移（§8 P4）未做。跨仓：引擎仓（本仓）+ 私有内容仓 `Independend-Frontend-Assets`。
> **一句话**：内容作者用 `<nsfw>…</nsfw>` 包住露骨段落（可配 `<sfw>…</sfw>` 净版替身），
> 或给整条世界书条目 / 预设提示词标 `nsfw: true`；用户关掉开关时，这些内容**既不发给模型、也不在界面显示**，
> 唯一例外是「直接查看世界书条目」（设置 → 世界书编辑器），那里永远显示原文。

## 1. 目标与非目标

**目标**

1. 内容包里的文本（世界书条目正文、角色定义、Agent 提示词、预设提示词、目录/地图等注册表文本）可以**行内**标记露骨段落。
2. 一个全局开关 `nsfwContent`。关 = 标记段落从**所有 LLM 请求**与**所有游戏内显示**中消失；开 = 段落照常出现，标记本身被剥掉（模型永远看不到标记）。
3. 世界书编辑器（直接查看条目）显示原文，含标记。
4. 双仓都有同一份语法定义与同一套校验：内容仓构建/编辑器保存时就挡住坏标记，引擎装包时再验一次。
5. **失败即关闭（fail-closed）**：标记写坏时，关模式下宁可多删，也不漏。

**非目标**

- 不追溯清洗**模型已经写出来的正文**（聊天记录、记忆摘要、编年史）。开关打开期间模型生成的露骨叙事是无标记的，事后关开关无法识别它们。对策见 §7.3（关模式用 `<sfw>` 注入全年龄约束，从源头不生成）。
- 不管工坊（社区）条目，v1 只管内容包。工坊文本可在 v2 复用同一过滤器。
- 不是年龄验证 / 合规方案，只是内容分级开关。

## 2. 现状（2026-11-20 两仓摸底）

- 引擎**没有任何文本级露骨闸门**。只有图像侧的 `ImageRating`（`general|sensitive|questionable|explicit`）与全局 `imageMaxRating`。
- 内容仓里露骨材料的分布：
  - **预设**：已经是**整条提示词**（`🔥NSFW…`、`📚 NSFW板块开始/结束` 包出的 `<NSFW_content>` 段），靠 `enabled` 开关。
  - **世界书 / 角色**：绝大多数是**夹在全年龄条目里的零散段落**（若干势力/地点/组织条目各一两处；`system_core/lilith` 等已停用条目若干处）；整条皆露骨的只有 `industry/prostitution` 一条。
  - 结论：预设需要「整条标记」，世界书/角色需要「行内包裹」——两种粒度都要。
- 已占用、**不可复用**的标记：`<NSFW_content>`、`sex_*` 系列、EJS `<% %>`、`{{…}}` 宏与 `{{UPPER_CASE}}` 占位符、故事输出控制标签（`beat`/`options`/`thinking`…）。
  `nsfw` / `sfw` 两个标签名（小写、精确匹配）在两仓 `content/` 与引擎源码中均无占用。

## 3. 标记语法（两仓共同契约）

### 3.1 行内包裹

```text
港口夜市以香料与走私闻名。<nsfw>（露骨段落）</nsfw>巡夜卫兵每两小时换岗一次。

她总穿一件深红斗篷。<nsfw>（露骨外貌描写）</nsfw><sfw>斗篷下的衣着颇为大胆。</sfw>
```

| 标签             | 开模式 (`nsfwContent=true`) | 关模式 (`false`)         |
| ---------------- | --------------------------- | ------------------------ |
| `<nsfw>X</nsfw>` | 输出 `X`（剥标签留内容）    | 整段删除                 |
| `<sfw>Y</sfw>`   | 整段删除                    | 输出 `Y`（剥标签留内容） |

`<sfw>` 是可选的净版替身：关模式下需要一句「留白但不断档」的时候用。它独立于 `<nsfw>`，也可以单独出现（例：关模式才注入的全年龄约束，见 §7.3）。

### 3.2 语法规则

1. 标签名**精确小写**，无属性、无空格：`<nsfw>` `</nsfw>` `<sfw>` `</sfw>`。别的写法（`<Explicit>`、`<nsfw a="">`）不是标记，lint 报**错误**（防手滑写出「看着像但不生效」的标记）。
2. **同一段文本内配平**：一条世界书条目 / 一个提示词 / 一个字段内开、闭成对。不允许像 `<角色>` 那样跨条目开闭。
3. **不可嵌套**：`nsfw` 内不能再有 `nsfw` 或 `sfw`，反之亦然。
4. 可以跨行；与 Markdown / 中文混排无特殊转义。
5. **EJS 条目里**：标签只能出现在模板**字面文本**里，不能写在 `<% %>` 代码块内部；EJS 自己 `print` 出标签也可以（剥离在渲染之后，见 §5.2）。但条件分支必须保证**渲染结果**配平——静态 lint 只能检查字面配平，运行期不配平走 fail-closed。
6. 为什么不用 EJS 注释 `<%# nsfw:start %>`：引擎用 `hasDynamic = /<%|\{\{random|\{\{getvar/` 把条目分到静态/动态区，内容仓用 `<%` 判定 `.ejs` 扩展名。用 EJS 注释会把**所有被标记的纯文本条目变成 EJS 条目**，挪出静态区、破坏提示词缓存布局。XML 风格标签没有这个副作用。
7. 为什么不用 `{{…}}` 宏：`preprocessEntry` 会静默删除未知 `{{…}}`，而 LORE_BOOK 路径不会——同一个标记在不同路径行为不一致。

### 3.3 运行期语义（fail-closed）

`applyNsfwMode(text, enabled)` 单遍扫描：

- 正常配平：按上表处理。
- 未闭合的 `<nsfw>`：**关模式删到文本末尾**；开模式剥掉开标签。
- 孤立的 `</nsfw>` / `</sfw>`：删掉标签本身。
- 未闭合的 `<sfw>`：开模式删到末尾，关模式剥开标签。
- 删除后合并因删除产生的多余空行（最多保留一个空行），避免提示词里留下大洞。
- 纯函数、无 IO；对不含 `<nsfw`/`<sfw` 的文本走 `includes` 快速返回原串（绝大多数条目零开销）。

### 3.4 整条标记

| 位置       | 字段                               | 关模式行为                                                                                     |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 世界书条目 | `extra.lore.nsfw: true`            | 条目从游戏侧整体消失：不激活、不进 lore 目录/选择、不做 `dependsOn` 目标、日历 keyDates 也不收 |
| 预设提示词 | `settings.prompts[i].nsfw: true`   | `assemblePresetContent` 跳过该条（不论其 `enabled`）                                           |
| 角色定义   | `character.json` 顶层 `nsfw: true` | 角色不出现在建档选择与角色候选中                                                               |

开模式下整条标记无任何作用（仍按原 `enabled` 走）。
`extra.lore` 字段是白名单：`nsfw` 必须同时加进引擎 `lore-protocol.ts` 与内容仓镜像 `tools/lore-protocol-conditions.mjs`。

## 4. 开关

- `UiSettings.nsfwContent: boolean`（全局，非按存档；localStorage `fated-poem-settings`）。
- **默认 `false`**（安全默认）。今天的内容还没有任何标记，所以默认关不会改变现有体验；内容迁移（§8 P4）上线时在发布说明里提示用户。
- 引擎经 `src/core/runtime/engine-settings.ts` 注入缝读取（照 `directStructuredCombat` 的五处模板：`settings-types` / 默认值 / `main.ts` provider / `EngineSettings` + `FALLBACK` + merge / 消费点）。每次调用现读，切换即时生效。
- UI：设置 → 剧情（或新「内容」分区）一个开关 + 一句说明：「关闭后，内容包中标记为露骨的段落不会发送给模型，也不会在游戏界面显示；世界书编辑器仍显示原文。已生成的聊天内容不受影响。」
- **与图像分级联动**：关模式下 `imageMaxRating` 的有效值钳到 `sensitive`（不改用户存的值，只在读取时 `min`）。开模式不干预，仍由 `imageMaxRating` 自己决定。

## 5. 引擎侧：过滤落点

### 5.1 核心模块

新建 `src/core/content/nsfw-filter.ts`（唯一真源）：

```ts
export function applyNsfwMode(text: string, enabled: boolean): string; // §3.3
export function lintNsfwMarkup(text: string): NsfwMarkupIssue[]; // §6，带 offset
export function isNsfwEntry(entry: WorldBookEntry): boolean; // extra.lore.nsfw === true
export function filterNsfwBooks(books: WorldBook[], enabled: boolean): WorldBook[]; // 克隆，不改原对象
export function nsfwEnabled(): boolean; // getEngineSettings().nsfwContent
```

🔴 **铁律：过滤只发生在「使用时」，永不写回。** 原因：

- 世界书编辑器与游戏共用同一批对象（`worldbook-store.books`），而编辑器要原文；
- 建档时文本会被冻结进存档（`metadata.characterDefinitions`、`metadata.fixedLore`、`CharacterState` 的 profile 字段、`characterChronicle`）。如果在加载时剥离，开关状态就被永久烧进存档，之后切换不再生效。

所以存储层永远存原文，所有出口按**当时**的开关值过滤。

### 5.2 发给模型的路径（两层）

**A 层 —— 源头过滤（主力，决定预算/缓存/替身正确）**

| 落点                                                                                          | 做什么                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GamePipeline.loadActiveWorldBooks()`（`game-pipeline.ts:2071`）                              | `filterNsfwBooks`：关模式剔除整条标记条目，并对 `extra.lore.summary/aliases/definitions` 跑 `applyNsfwMode`。所有 Agent / 侧链 / 直出 / 图像链经 `chainData.worldBooks` 吃到的都是这份     |
| 绕过上面的世界书读取                                                                          | `create-store.ts` 的建档目录(~746)、剧情大纲(`loadPlotOutlineWorldBooks` ~1497)、开场 fixedLore 快照(~2352)；战斗协议 `combat/sandbox/protocol.ts` `defaultGetWorldBook` —— 各自套同一函数 |
| 条目正文渲染：`prerenderWorldBookEntries` / `renderWorldBookEntries`（`worldbook-loader.ts`） | **EJS 渲染之后**对每条结果跑 `applyNsfwMode`。必须在渲染后：EJS 把整条编成一个函数，`if/for` 可以跨越标签；且 `lore.get`/`getwi` 读到的别条原文会被嵌进本条输出，渲染后统一剥就一起覆盖    |
| 冻结文本的读取点                                                                              | `story-context-v2` 读 `ctx.fixedLore[key].text`；`buildCharacterContext`（`character-chronicle.ts:67`）；`{{CHARACTER_STATE}}` 序列化角色 profile 时                                       |
| 提示词模板                                                                                    | `assemblePresetContent` / `preprocessEntry`（`preset-loader.ts`）：跳过 `nsfw: true` 的 prompt，并对每条 content 跑过滤；Agent 的 `systemPrompt/template/tailPrompt` 在模板解析前过滤      |
| lore 选择 LLM                                                                                 | `lore-selection.ts` 发的 `summary` 走上面 `filterNsfwBooks` 已处理；`chars: content.length` 预算改用过滤后长度                                                                             |
| 注册表文本                                                                                    | 目录 / 地点 / 随机事件 / 地图包等**被拼进提示词**的字符串，在拼接处过滤（实施时按 `getContentRegistry()` 的消费点逐个列清单）                                                              |

**B 层 —— 出口安全网（兜底，保证「不漏」）**

- `AgentClient.buildRequestBody`（`agent-client.ts:943`）是**所有** `/api/llm/*` 流量的唯一出口（chat / stream / tools 轮次 / 记忆摘要 / 大纲 / 直出）。在这里对每条 `messages[i].content`（仅字符串内容及 `type: 'text'` 块；**不碰** Anthropic thinking / signature 块）再跑一次 `applyNsfwMode`。
- 开模式下这一步只是剥标签；关模式下若 A 层漏了某条路径，这里兜住。
- 开发模式下 B 层若**实际删掉了东西**（说明 A 层有漏网），打一条 `engine-log` 警告并带调用方 agent 名，便于补 A 层。
- B 层不能取代 A 层：只靠出口剥，`<sfw>` 替身也能出来，但 token 预算、lore 区块计数、Delta 签名都会按原文计算，错位。

**Delta 会话 / 缓存直出**

- `prompt-session-assembler.ts` 的基线签名（~:443-460）序列化原始 `e.content`；把 `nsfwContent` 值并入签名，切换开关即强制重建基线，旧 transcript 不再回放。
- `direct_cached` 的签名是 `[input.signature, frame.prefix]`，A 层在 frame 构建前已过滤，签名自然变化，无需额外处理。

**调试面板**：orchestrator 的 `result.requestMessages` 是出口前的文本；DebugPanel 显示前也过一遍，保证关模式下调试面板同样干净（它是「游戏内显示」）。

### 5.3 显示路径

新建 composable `useNsfwText()`（`src/ui/composables/`），返回响应式的 `(text) => applyNsfwMode(text, settings.nsfwContent)`；开关切换时界面立即重渲染。

| 组件                                                                            | 处理                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `create/CreateStepCharacters.vue`、`CreateStepDestinyCore.vue`                  | 过滤；`nsfw: true` 的角色 / 条目不列出                                                                  |
| `game/CharacterViewerModal.vue`、`CharacterListPanel.vue`、`StatusOverview.vue` | 过滤 profile 文本（来源是冻结进 `CharacterState` 的原文）                                               |
| `game/CharacterChronicleTab.vue`                                                | 过滤作者预置的 past 条目                                                                                |
| `game/MapPanel.vue`、`MapPoliticalTab.vue`                                      | 过滤标记描述 / 地图包文本                                                                               |
| `game/CalendarPanel.vue`                                                        | `collectLoreKeyDates` 读 `filterNsfwBooks` 后的书                                                       |
| `game/DebugPanel.vue`                                                           | 见 5.2                                                                                                  |
| **`settings/WorldBookSection.vue` → `WorldBookEditor.vue`**                     | **豁免，显示原文。** 额外：条目列表对 `nsfw` 条目或含标记的条目加一个小徽标；正文 textarea 不做任何处理 |
| `settings/agent/AgentPromptCard.vue`、`PresetManager.vue`                       | **豁免**（与世界书编辑器同属「直接查看/编辑原始内容」）。`TemplatePreview.vue` 是渲染预览，**过滤**     |

## 6. 校验（两仓同一套规则）

`lintNsfwMarkup(text)` 返回带 `offset` 的问题列表：

| 级别    | 规则                                                                  |
| ------- | --------------------------------------------------------------------- |
| error   | 未闭合 / 孤立闭标签                                                   |
| error   | 嵌套（`nsfw` 内含 `nsfw`/`sfw`，或反之）                              |
| error   | 形似但不规范的标签（大小写 / 属性 / 空格不规范；`NSFW_content` 不算） |
| error   | 标签出现在 `<% … %>` 代码块内部                                       |
| error   | 世界书 `parts` 切分时，标签跨越 part 边界                             |
| warning | 非露骨条目的 `dependsOn` 指向 `nsfw: true` 条目（关模式下依赖会消失） |
| warning | 空包裹 `<nsfw></nsfw>`                                                |

落点：

- **内容仓**：`tools/content-editor-checks.mjs` 的 `checkWorkspace` → `inspectBooks` / `inspectPresets` / `inspectAgents` 三处各调一次（与现有 `malformedSetvarOffsets` 同模式）；角色 `character.json` 的 profile 字符串也扫。一处接入即同时卡住 `content-source build/check`、编辑器 `/api/save`、`build-pack.mjs`。`checkPack` 只读检查器也接上。
- **引擎**：`validatePackOrThrow`（`content-source.ts`）调同一函数；`tests/contract/pack-install.contract.test.ts` 加断言「整包无标记错误」。
- 内容仓的 `.mjs` 实现是引擎 `nsfw-filter.ts` 的**镜像**（与 `lore-protocol-conditions.mjs` 的既有做法一致），两边共用一份测试向量 JSON，防止漂移。

## 7. 内容仓侧改动

### 7.1 工具链

- `content-editor-checks.mjs`：接 §6 lint。
- `lore-protocol-conditions.mjs`：白名单加 `nsfw`（与引擎同提交节奏）。
- `build-pack.mjs`：**不做任何变换**，标签原样进包（过滤是引擎运行期的事）。`minEngineVersion` 抬到含过滤器的引擎版本——旧引擎不认识标签，会把露骨段落连同标签一起发给模型。
- `content-source.mjs`：角色 `lore` 兜底文本由条目正文派生，标签随之保留，无需处理（引擎读取时过滤）。
- `scramble-worldbook-ejs.mjs`：`splitEjs` 把 `<% %>` 外的文本换成填充物，需保留四个标签原样，让测试夹具里的标记结构还在。
- `worldbook-repo-sync` 的正文摘要基线：给现有条目加包裹会改变摘要，迁移时**有意识地**更新基线。

### 7.2 内容编辑器

- 世界书条目、Agent 提示词、预设提示词三个正文 textarea 旁加「包为露骨」「加净版替身」两个按钮（用 `selectionStart/End` 包住选区）。
- 条目表单 `enabled` / `constant` 旁加 `nsfw` 复选框（写 `extra.lore.nsfw`）；预设提示词表单同理。
- 检查报告里显示 lint 的 offset，点击跳到 textarea 对应位置。
- 可选：一个「以关模式预览」切换，用镜像的 `applyNsfwMode` 显示过滤结果。

### 7.3 内容迁移（作者工作，不自动化）

1. **预设**：所有 `🔥NSFW…` / `🔧 NSFW可选…` / `📚 NSFW板块开始/结束` 提示词标 `nsfw: true`。主提示词、输出协议、思维链里零散的 NSFW 句子用 `<nsfw>` 包。
2. **全年龄约束**：主提示词里加一段 `<sfw>…</sfw>`（「本作以全年龄标准叙述，亲密场景以暗示与转场处理」之类）。**这是「事后无法清洗模型输出」的源头对策**——关模式下模型从一开始就不写露骨内容。
3. **世界书**：已启用条目中的零散段落逐条包裹；`industry/prostitution` 判断是整条标记还是包裹敏感段；已停用条目（`lilith` 等）可随启用一起处理。
4. **角色**：`vivira` 等含露骨描写的人设包裹；`character.json` profile 同理。
5. `{{setvar::NSFW内容::…}}` / `{{setvar::角色外貌性征::…}}` 这类变量开关：所在 prompt 若整条标记即自动失效；否则把 setvar 写进 `<nsfw>` 或 `<sfw>` 分支，让两种模式写入不同值。

## 8. 实施分期

| 期  | 仓     | 内容                                                                                                                                            | 验收                                                                                                                                             |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | 引擎   | `nsfw-filter.ts` + 单测（§3.3 全部分支、EJS 渲染后剥离、空行合并）；开关与注入缝；A 层全部落点 + B 层安全网；Delta 签名；`lore-protocol` 白名单 | 集成测试：关模式下用含标记的夹具包跑一轮主 DAG / 直出 / 战斗 / 记忆摘要，断言**所有**请求体不含 `<nsfw` 且不含段落内容；开模式断言含内容不含标签 |
| P2  | 引擎   | `useNsfwText` + §5.3 显示落点；世界书编辑器徽标；图像分级联动                                                                                   | 浏览器走查：切开关，建档页 / 角色查看器 / 地图即时变化，世界书编辑器不变                                                                         |
| P3  | 内容仓 | lint 镜像 + 共享测试向量；白名单；编辑器按钮与复选框；scramble 保留标签；`minEngineVersion`                                                     | `node --test` 新测试；`build-pack` 对坏标记 exit 1；引擎 `POEM_PACK_FILE=… npx vitest --run tests/contract` 通过                                 |
| P4  | 内容仓 | §7.3 内容迁移                                                                                                                                   | 两种模式各玩一段真机；关模式抽查请求日志                                                                                                         |

P1 与 P3 的 lint 部分可并行（以共享测试向量为契约）；P4 依赖 P1–P3。

## 9. 已知限制

- 模型输出、聊天记录、记忆摘要、玩家自写内容不在过滤范围（无标记可识别）。靠 §7.3 第 2 条从源头约束。
- 用户在世界书编辑器里**自己改**的条目同样遵循标记语义——这是特性，不是漏洞。
- 本开关不影响 BFF / API 供应商自身的内容策略。

## 10. 待主人裁定

📌 2026-11-20：1 / 3 / 4 三项按本稿推荐实施（默认关、关时钳到 `sensitive`、提示词编辑器豁免）；2 已由主人裁定。

1. 默认值：本稿取 **默认关**。若希望老用户无感，可改为「新安装默认关、已有设置默认开」。
2. 标签名：~~`<explicit>`~~ → **主人裁定用 `<nsfw>` / `<sfw>`，`<sfw>` 可选**（2026-11-20）。
3. 关模式是否钳制图像分级（本稿：钳到 `sensitive`）。
4. 提示词编辑器（Agent / 预设）是否与世界书编辑器同样豁免（本稿：豁免）。

## 11. 实施记录（2026-11-20）

📌 实施时把标签与字段统一改名为 `nsfw`（主人裁定）。正文上文已就地替换，下面只记与设计稿的偏差。

| 项             | 落地                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心模块       | `src/core/content/nsfw-filter.ts`：`applyNsfwMode` / `lintNsfwMarkup` / `filterNsfwBooks` / `filterNsfwMessages` / `isPresetPromptActive` / `nsfwEnabled`。内容仓镜像 `tools/nsfw-markup.mjs`，两仓共用 `tests/fixtures/nsfw-markup-vectors.json`（逐字节相同，内容仓测试比对） |
| 设置           | `UiSettings.nsfwContent`（默认 false）→ `engine-settings.ts` 注入缝；开关在 **设置 → 内容包 → 露骨内容**（不是剧情分区）                                                                                                                                                        |
| 预设条目       | 所有按 `enabled` 挑预设条目的地方（`preset-loader` 三处、`direct-context-frame` 三处、`story-context-v2`）改走 `isPresetPromptActive`                                                                                                                                           |
| Delta 签名     | **没改**。出口安全网每次都按当前开关过滤，回放的旧 transcript 也会被过滤，切换开关后发出去的内容已经正确；只是供应商侧缓存会自然失效一次                                                                                                                                        |
| 包校验         | 引擎装包时标记错误只出 **warning**（`bad-nsfw-markup`），不拦装包；内容仓构建 / 编辑器保存按 **error** 拦                                                                                                                                                                       |
| 角色整条标记   | 内容仓选择**校验报错**而不是构建时自动补：角色 `nsfw: true` 时，其人设条目也必须标 `extra.lore.nsfw: true`                                                                                                                                                                      |
| 显示           | `useNsfwText()`：建档页（摘要函数先过滤再剥 HTML，否则 `<nsfw>` 会被当 HTML 剥掉而内容留下）、角色查看器、角色列表、编年史、地图标记、日历、调试面板                                                                                                                            |
| 未过滤的显示面 | 玩家自己的人设编辑（StatusOverview，玩家自写文本）、调试导出 JSON（开发数据保留原文）、势力地图的地块事实（AI 生成，无标记）                                                                                                                                                    |
| 未做           | 内容编辑器「点检查报告跳到 offset」「以关模式预览」；内容迁移（给真实条目加标记）                                                                                                                                                                                               |
