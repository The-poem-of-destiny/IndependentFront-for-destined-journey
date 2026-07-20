# 剧情系统接线计划（Plot System Integration Plan）

> 日期: 2026-07-19 · 状态: 待主人确认
> 范围: 剧情大纲生成 / 两个剧情 Agent 接线 / 左侧界面显示 / 字段更新 / 提示词 / 存储
> 📌 **2026-07-20 变更注记**: 主人拍板 — plot_outline 仅捏人页调用（main+side 都在捏人页生成大纲+事件树）；游戏内大纲生成（支线年度/世界线重生成）全删；后续大纲演化唯一途径 = plot_post_check.outlineChanges；plotYearlyGeneration 字段退役；agent-config.json plot_outline 场景 三→二、template→{{SYS_PROMPT}}；plot_post_check 强化 outlineChanges 为大纲演化唯一维护者。

---

## 一、现状盘点（断链清单）

Phase 4 引擎层已完成，但整条链路从未接通：

| # | 断点 | 位置 | 影响 |
|---|------|------|------|
| 1 | `plotSettings: { mode: 'off' }` 硬编码 | `game-pipeline.ts buildContext()` | 三个剧情 Agent 永远禁用 |
| 2 | `preCheckPlot`/`postCheckPlot` 无人调用 | `plot-engine.ts`（只有测试引用） | Agent 输出即使产生也不落库 |
| 3 | `game-store.plotOutline` 恒 null | `loadSave()` 不加载 plotOutlines 表 | PlotPanel 大纲区永远空 |
| 4 | PlotPanel 读 `outline.title/summary` | `PlotPanel.vue:21-22` | 字段不存在（类型只有 content/selfCritique）|
| 5 | 捏人页 plotSettings 不落库 | `create-store.startJourney()` | 用户配置流失，游戏页读不到 |
| 6 | 大纲"游戏开始后自动生成"未实现 | `create-store.generatePlotOutline()` 占位 | 大纲永不生成 |
| 7 | 三个剧情 Agent 提示词是老简版 | agent-config.json（746~1422 字符） | 输出格式不可靠 |
| 8 | pre/post_check 按事件 **id** 寻址 | plot-engine 解析器 + 提示词 | 违反字段规范铁律 1（AI 永不产/引 id，逻辑键=名字→标题） |
| 9 | 剧情设置存 settings-store（全局 localStorage） | `settings-store: plotMode 等 6 个 key` | 剧情配置应随存档而非全局（每档不同剧情模式） |

### 最初设计回顾（phase4_plan.md v2）

- 三模式：off（完全关闭）/ side（仅支线，每年生成地区冲突）/ main（主线，按大纲推进）
- 主线流程：AI 生成大纲 → AI 自检精彩程度 → 确认 → 生成剧情事件树
- 剧情 AI 每轮调用两次：正文前触发检查（pre_check）+ 正文后世界线修正（post_check）
- 世界线变动 → 修改大纲（version+1）→ 级联传播子事件（默认 2 层）
- 事件完成/失败 → 自动生成高重要度记忆

**本计划不推翻原设计，只做接线 + 字段修正 + 提示词重写。**

---

## 二、字段更新（types.ts）

### 2.1 PlotOutline 增补

```typescript
export interface PlotOutline {
  // ...现有字段不动...
  /** 🆕 大纲标题（AI 生成，如"血色纹章"）— PlotPanel 头部显示 */
  title: string;
  /** 🆕 一句话摘要（≤80字，防剧透层下的可见部分） */
  summary: string;
  /** 🆕 章节结构化存储（不再每次从 content 正则重新解析） */
  chapters: Array<{ title: string; summary: string; status: 'pending' | 'active' | 'completed' }>;
}
```

理由：PlotPanel 已在消费 title/summary（现在是幻影字段）；chapters 结构化后
「当前章节进度」可以直接渲染，不依赖 parseOutlineChapters 的脆弱正则。

### 2.2 PlotEvent 增补

```typescript
export interface PlotEvent {
  // ...现有字段不动...
  /** 🆕 玩家可见性: hidden=未揭示(面板不显示) / revealed=已揭示 */
  visibility: 'hidden' | 'revealed';
  /** 🆕 所属章节标题（逻辑键=名字，铁律1） */
  chapterTitle?: string;
}
```

理由：大纲生成的未来事件不能直接摆在面板上剧透；pre_check 触发时置 revealed。

### 2.3 PlotSettings 增补（雷点 + 通用化）

```typescript
export interface PlotSettings {
  mode: 'off' | 'side' | 'main';
  /** 🆕 雷点 — 绝对禁止生成的内容（所有模式通用，硬约束） */
  tabooContent: string;
  main?: { /* ...现有字段不动... */ };
  side?: { /* ...现有字段不动... */ };
}
```

- `tabooContent` **仅在生成剧情大纲时使用**（plot_outline 的初次生成 / 重 roll 修改 /
  支线年度生成 / 世界线重生成），和 genrePreference 等参数一起注入动态上下文
- 提示词里作为「绝对禁止」级别（高于 genrePreference 偏好），空串=无雷点
- pre_check / post_check / story 不注入（大纲源头干净了，下游自然不会触雷）

### 2.4 设置页 ↔ 捏人页字段对齐

两处 UI 使用**同一套字段集**（含新增雷点），语义分工：
- **设置页「剧情系统」分区** = 新档默认值（settings-store 持久化 localStorage）
- **捏人页 CreateStepPlot** = 本档实际值（初始化时从设置页默认值读入，可改，
  startJourney 落 SaveSlot.metadata.plotSettings）

现状两边字段名/形状不一致，需收口对齐 create-store 的形状（与 types.ts PlotSettings 对齐）:

| 字段 | settings-store 现状 | create-store 现状 | 收口后 |
|------|--------------------|------------------|--------|
| 模式 | plotMode | plotMode | ✅ 一致 |
| 持续年份 | plotDuration | plotDurationYears | plotDurationYears |
| 难度 | plotDifficulty ('dynamic') | plotDifficultyTier ('adaptive') | plotDifficultyTier ('adaptive') |
| 外部NPC | plotAllowExternalNPC | plotAllowNonWorldbookNpc | plotAllowNonWorldbookNpc |
| 偏向 | plotGenres | plotGenrePreference | plotGenrePreference（8 选项全量） |
| 自定义偏好 | plotCustomPref | plotCustomPreference | plotCustomPreference |
| 支线区域/年生成 | ❌ 缺 | plotFocusRegion / plotYearlyGeneration | 设置页补齐 |
| 🆕 雷点 | ❌ 缺 | ❌ 缺 | plotTabooContent（两边都加，textarea） |

### 2.5 寻址方式修正（铁律 1 收口）

- `PreCheckResult.triggeredEvents`: `{ id }` → `{ title, reason }`
- `PostCheckResult.eventUpdates`: `{ id, action }` → `{ title, action, changes }`
- plot-engine 解析层：按 title 在本存档事件中唯一匹配（复用名字解析思路），
  匹配不到 → 记 warning 不硬失败
- 事件 id 仍由 Code 生成（crypto.randomUUID），只是 AI 输入输出全用标题

---

## 三、两个剧情 Agent 设计

### 3.1 plot_pre_check（正文前，Stage 0，与 memory_recall 并行）

**输入**（variableContext/variableInstruction 动态注入）:
- 大纲 content + 当前章节 + 活跃/待触发事件列表（标题+描述+触发条件语义）
- 用户输入 + 最近 2 轮对话 + 角色状态摘要（位置/时间/关键变量）

**输出** `<json>`:
```json
{
  "triggeredEvents": [{ "title": "事件标题", "reason": "触发原因" }],
  "relevantBackground": "需注入正文的剧情背景（≤300字，写给 story Agent 看）",
  "directive": "本轮剧情推进建议（≤100字，如'铺垫下一章冲突，节奏放缓'）"
}
```

**下游**: Code 层 `preCheckPlot()` 激活事件（pending→active + visibility→revealed），
`relevantBackground`+`directive` 拼进 story 的 variableContext（新增"剧情导演区块"）。

### 3.2 plot_post_check（正文后，Stage 5，waitFor story+memory_summary）

**输入**: 大纲 + 活跃事件 + 本轮正文 + 用户输入 + 角色状态摘要

**输出** `<json>`:
```json
{
  "worldLineChanged": false,
  "changeLevel": "none | minor | moderate | major",
  "eventUpdates": [{ "title": "事件标题", "action": "complete|fail|skip|update", "changes": {} }],
  "newChildEvents": [{ "title": "", "description": "", "parentTitle": "", "triggerCondition": "" }],
  "outlineChanges": { "action": "none|update", "changes": "变动描述" }
}
```

**下游**: `postCheckPlot()` 更新事件状态 → 完成/失败事件自动 `eventToMemory()` 落库
（含 embedding）→ worldLineChanged 时大纲 version+1 + 级联传播 → PlotPanel 自动刷新。

**保持 Quest 委托管线**（Phase 10g）: post_check 现有的 quest_update_request 职责不动。

### 3.3 plot_outline（捏人页生成 / 年度 / 世界线重生成，不在每轮管线中）

**触发时机**（2026-07-19 主人拍板: 主线大纲在捏人页生成，游戏首回合零等待）:
- 主线 main: **捏人页 CreateStepPlot** 点「🤖 生成剧情大纲」→ 一次 AI 调用产出结构化 JSON
  → PlotOutlinePreview 模糊预览，不满意可重新生成 → startJourney() 落库 + Code 转事件树
- 支线 side: 游戏内首回合 + 每游戏年（gameTime 年份变化检测），复用同一 Agent/提示词
- 世界线 major 变动: post_check 之后由 Code 触发重生成（v+1）

**不做二次 AI 格式化**: 叙事大纲(content)与结构化事件(chapters.keyEvents)在同一次
调用中产出，游戏里由 Code 纯确定性转换为 PlotEvent（ADR-11: 格式化归 Code）。

**输出** `<json>`:
```json
{
  "title": "大纲标题",
  "summary": "一句话摘要",
  "content": "# 完整叙事大纲（markdown，含章节）",
  "chapters": [{ "title": "第一章 ...", "summary": "...", "keyEvents": [{ "title": "", "description": "", "triggerHint": "" }] }],
  "selfCritique": { "score": 7, "strengths": [], "weaknesses": [], "suggestions": [] }
}
```

**自检重生成**: score < 6 时自动带着 weaknesses/suggestions 重试一次（最多 2 次），
仍不达标就用最后一版（不阻塞游戏开始）。

**大纲 → 事件树**: 不再用 parseOutlineChapters 正则，直接从 chapters[].keyEvents
结构化生成 PlotEvent（章节=depth 0 / keyEvent=depth 1，全部 visibility=hidden）。

### 3.4 大纲重 roll 模块（2026-07-19 主人新增需求）

区别于「重新生成」（丢弃重来）：**带着上一版大纲 + user 的修改要求，让 AI 重写/修改**。

**UI（捏人页 PlotOutlinePreview 下方）**:
```
[🎲 重新生成]  [✏️ 按要求修改]
点「按要求修改」→ 展开 textarea:「你希望怎么改这份大纲？」
  例: "第二章反派动机太俗套，改成和主角命定核心有关联；结局不要大团圆"
→ [提交修改] → AI 重写 → 预览刷新（版本历史可回退上一版）
```

**Prompt 结构**（同一个 plot_outline Agent，走「修改模式」动态注入）:
```
[system] plot_outline systemPrompt（含修改模式说明区块）
[user]
  # 上一版大纲（完整 JSON）
  {previousOutline}
  # 用户的修改要求
  {userRevisionRequest}
  # 剧情配置（含雷点）
  {plotSettings}
  要求: 在保留用户未提及部分的基础上，按修改要求重写大纲。
        修改要求与雷点冲突时，雷点优先。输出完整大纲 JSON（不是 diff）。
```

**行为细节**:
- 输出仍是完整大纲 JSON → 同一条校验/自检/预览链，零新增解析逻辑
- create-store 保留 `outlineHistory: PlotOutline[]`（会话内，最多 5 版）→ 「回退上一版」按钮
- 落库时只存最终确认版（历史不入库，避免膨胀）
- 游戏内支线/世界线重生成**不做**重 roll UI（本期只做捏人页；游戏内改大纲
  由 post_check 自动完成）
- 🔭 远期可选: 游戏内 PlotPanel 也加「按要求修改大纲」入口（需处理已触发事件
  与新大纲的一致性，复杂度高，本期不做）

---

## 四、提示词（agent-config.json 重写，参照 vars_update ~300 行标准）

三个 Agent 各重写 systemPrompt，共同要求：
1. 遵循 `agent_system_prompt_guide.md` 流程 + `narrative_context_example.md` 叙事规范
2. 世界观锚定：复兴纪元 / 10 势力 / 7 级品质 / T1-T7 层级（引用世界书条目语义）
3. **格式纪律**（吸取 char_gen 真机教训）: 思维链后必须输出 `<json>` 区块、
   字段名精确匹配、事件寻址只用标题、自检清单收尾
4. 尊重 PlotSettings：genrePreference 8 偏向 / difficultyTier / allowNonWorldbookNpc /
   customPreference 全部体现在 plot_outline 提示词的动态注入区
5. 防剧透意识：pre_check 的 relevantBackground 只给"当下需要"的背景，不预告未来章节

规模预估：plot_outline ~200 行 / pre_check ~120 行 / post_check ~180 行（含 quest 委托保留区）。

---

## 五、存储 & 数据流

### 5.1 PlotSettings 迁家：settings-store → SaveSlot.metadata

- 捏人页 `startJourney()` 把 `plotSettings.value` 写入 `SaveSlot.metadata.plotSettings`
- `game-pipeline.buildContext()` 读 `activeSave.metadata.plotSettings`（替换硬编码 off）
- settings-store 里的 6 个 plot* key 保留作为「新档默认值」，捏人页初始化时读入
- 老存档兜底：metadata 无 plotSettings → `{ mode: 'off' }`（行为不变）

### 5.2 大纲生成时序

**主线（捏人页）**:
```
CreateStepPlot 点「生成大纲」→ plot_outline Agent（create-store 直调 AgentClient）
  → JSON 校验 + 自检循环（score<6 重试 1 次）
  → plotOutline.value 暂存 + PlotOutlinePreview 模糊预览（可重新生成）
startJourney():
  → savePlotOutline(confirmed: true)
  → outlineToEvents(chapters.keyEvents)（纯 Code）→ savePlotEvents（全部 visibility=hidden）
  → SaveSlot.metadata.plotSettings 落库
```

**支线（游戏内）**:
```
loadSave → mode==='side' 且当年无大纲 → GamePipeline.ensurePlotOutline()
  → plot_outline Agent（agentStatus: '生成大纲'）→ 同上落库链
每轮 post_check 后: gameTime 年份变化检测 → 触发下一年度生成
```

### 5.3 每轮读写闭环

```
Stage 0  pre_check  → preCheckPlot() 激活事件 → background 注入 story 上下文
Stage 1  story      → （正文包含剧情推进）
Stage 5  post_check → postCheckPlot() 事件状态/新子事件/大纲版本/事件记忆
finally  refreshFromDb 扩展: + getLatestPlotOutline + getPlotEvents 回读 Pinia
```

- `loadSave()` 增加并行加载 `getLatestPlotOutline(saveId)` → `plotOutline.value`
- `refreshFromDb()` 增加大纲+事件回读（现在只回读 save/characters/profile）

---

## 六、界面显示（UI 设计，2026-07-19 主人拍板）

### 6.1 入口: SideToolbar 新增「剧情」按钮

现状盘点发现 SideToolbar **没有剧情入口**（GamePage 有 plot Modal 但工具栏没按钮）。
新增按钮插在「记忆」下方、「调试」上方:

```
背包 / 角色 / 任务 / 地图 / 记忆 / 【剧情 fa-book-open】/ 调试 / 设置
```

原「ScenePanel 插剧情脉络区块」方案取消（主人选择纯工具栏入口 + Modal）。

### 6.2 PlotPanel（Modal）升级 + 剧透开关

- 头部: outline.title + summary + 版本号(v2 时显示"世界线已变动×1") + 章节进度条
  + **「剧透模式」眼睛开关**（默认关闭）
- 章节手风琴: 每章 title + status 色标；展开显示本章 summary + 事件列表
- 事件渲染规则:
  - visibility==='revealed' → 正常显示（标题+描述+状态分组: ⚡活跃/⏳待触发/✅完成/✖失败）
  - visibility==='hidden' → 显示为「？？？」蒙层卡片
    - 剧透开关关闭: 点击无反应
    - 剧透开关开启: 点击单条 → 翻开该条标题+描述（**逐条揭示**，防手滑全泄）
    - 关闭开关 → 全部重新蒙回（偷看是 UI 临时态 ref，不写库；visibility 字段仍只由剧情推进翻转）
- 遵循 docs/design.md（间距 token / 品质色 / 折叠动画 + reduced-motion）

---

## 七、实施顺序（7 步，每步可独立验证）

| 步 | 内容 | 文件 | 验证 |
|----|------|------|------|
| 1 | 类型+解析层: PlotOutline/PlotEvent 字段增补 + PlotSettings 雷点 + id→title 寻址 | types.ts / plot-engine.ts / plot-outline.ts | 单测更新 |
| 2 | 存储: plotSettings 入 SaveSlot.metadata + loadSave/refreshFromDb 加载大纲事件 | create-store / game-store | 单测 + typecheck |
| 3 | 提示词: 三个 Agent systemPrompt 重写（plot_outline 含雷点注入区 + 修改模式区块） | agent-config.json / agent-templates.ts 动态上下文 | 人工审读 |
| 4 | 大纲生成链: 捏人页真实 AI 调用 + 自检循环 + 重 roll（修改模式 + outlineHistory 回退） + Code 结构化事件树 + 支线年度生成 | create-store / game-pipeline.ts / plot-outline.ts | 单测 |
| 5 | 每轮接线: buildContext 读真实 plotSettings + handleAgentResult 接 pre/post | game-pipeline.ts | 单测 |
| 6 | UI: SideToolbar 剧情按钮 + PlotPanel 升级（剧透开关+？？？蒙层）+ 设置页/捏人页字段对齐 + 雷点 textarea + 重 roll 按钮组 | SideToolbar.vue / PlotPanel.vue / SettingsPage.vue / CreateStepPlot | typecheck，主人真机验证 |
| 7 | 文档同步: CLAUDE.md 进度 + agent预期分析 + phase4 注记 | docs/ | — |

**真机验证点**（主人执行）: 新开主线档 → 首回合看大纲生成 → PlotPanel 有内容 →
玩几轮看事件触发/完成 → 完成事件出现在记忆面板。

---

## 八、已拍板决定（2026-07-19）

1. ~~大纲生成时机~~ → **捏人页生成**（一次 AI 调用出结构化 JSON，游戏里 Code 转事件树，首回合零等待）
2. ~~剧情区块位置~~ → **SideToolbar 按钮**，插「记忆」下方「调试」上方（ScenePanel 区块方案取消）
3. ~~hidden 事件~~ → **「？？？」蒙层 + 剧透模式开关**（默认关；开启后逐条点击揭示；关闭全部蒙回；UI 临时态不写库）——用户对内容保有控制权是设计原则
4. ~~设置页/捏人页字段~~ → **同一套字段集**：设置页=新档默认值，捏人页=本档实际值；字段名收口对齐 create-store/types.ts 形状；两边都加雷点 textarea
5. ~~雷点~~ → **PlotSettings.tabooContent**，剧情生成参数之一，**仅在 plot_outline 生成/重写大纲时注入**（「绝对禁止」级，高于 genrePreference）；pre/post_check 与 story 不注入
6. ~~大纲重 roll~~ → **修改模式**：带上一版大纲 JSON + 用户修改要求让 AI 重写（非从零）；outlineHistory 会话内留 5 版可回退；落库只存最终确认版
