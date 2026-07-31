# 战斗系统 v2 · M5 前端战斗面板 实施计划（定稿）

> 📅 **日期**：2026-07-29
> 📌 **目标**：落地独立战斗 UI —— 实时战斗消息流（叙事 + 数值卡片）+ B+C 混合操作（按钮拼装注入文本框，自由编辑后发送）
> 🔗 **上游**：[combat-system-v2-plan.md](./2026-07-28-combat-system-v2-plan.md) §6、[combat-system-architecture.md](../reference/combat-system-architecture.md)、[combat-agent-api.md](../reference/combat-agent-api.md)
> 🎨 **规范**：[design.md](../design.md)（玄墨基调 / 色点品质 / 纸叠阴影 / 禁侧边条）
> ⚠️ **前置**：M4 已完成（combat-runner + executeCombatToolCall + handleCombatTrigger 接入）
> ✅ **决策状态**：三项决策已由主人拍板（2026-07-29）

---

## 1. 已确认决策

| 决策               | 结论             | 要点                                                                                                                                                                                                                                   |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · 交互模式**   | **B+C 混合**     | 按钮是「快捷拼装助手」：选我方单位→选行动(普攻/技能/道具/防御/逃跑)→选目标→**拼装文本注入输入框**；玩家可自由编辑注入的文本（加细节/改意图）后发送。发送时仍是**自由文本指令**（走 combat agent）。既保留开放性，又免每次手打。详 §2.6 |
| **2 · 呈现方式**   | **全屏覆盖层**   | 战斗时覆盖层盖住 GamePage，结束滑出。沉浸感强、信息承载大、ChatFlow 天然被盖无需额外暂停逻辑                                                                                                                                           |
| **3 · 叙事持久化** | **只存最终摘要** | 战斗过程（叙事/伤害）只在内存态 combat-store，结束清空；最终 `【战斗摘要】` 进 messages 表。回看功能后置                                                                                                                               |

### 📌 combat agent prompt 现状（查证 2026-07-29）

combat agent 的 systemPrompt（`agent-config.json:1992`）+ 接口规格 §5（`combat-agent-api.md:372`）**当前就已明确要求**「轮到我方等用户输入」：

> 「敌人由你控制；**我方单位由用户输入**。用户描述我方行动，你理解意图后调对应工具」
> 「我方单位 → 用户输入：AI 理解用户意图 → 调对应函数」

✅ **核心 prompt 不用改** —— 主人记得完全正确。

⚠️ **偏离在 runner，不在 prompt**：M4 的 `combat-runner.ts:250-264`（buildRoundFeedback）写「我方单位若无明确用户指令，**按战术合理性代为行动**」——M4 没前端面板，权宜让 agent 代打全场。M5 的任务是**让 runner 追上 prompt**（真正停下来等输入），prompt 至多微调配合 runner 的回合调度方式，核心「我方由用户输入」不变。详 §3.4。

---

## 0. 现状审计（动手前必须吃透的 6 个事实）

M4 落地代码 + 现有前端架构调研结论：

| #   | 事实                                                                                                                                                                                                                                 | 代码位置                                           | 对 M5 的影响                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------- |
| ①   | **combat-runner 是黑盒**：`runCombat` 跑完整场才返回 `CombatSummaryResult`，中间过程（每回合叙事 / HP 变化 / 伤害分解 / 工具调用）对前端**完全不可见**                                                                               | `combat-runner.ts:110-245`                         | 🔴 M5 必须先给 runCombat 加事件流回调，否则面板无数据 |
| ②   | **runner 内部数据极丰富但被丢弃**：每次 `executeCombatToolCall` 产出 `CombatActionResult`（含 8 步 `CombatDamageBreakdown` / `IntentionResult` / `attackRoll` / `statusApplied` / `finalHp`），`combat_start` 产出完整 `CombatState` | `combat-runner.ts:183-205`、`types.ts:1749-1789`   | ✅ 数据已在手，事件流「旁路」一份给前端即可，无需重算 |
| ③   | **game-store 已有 `activeCombat` / `isInCombat` 字段但无人写入**（`isInCombat` 已被 ChatFlow 禁用右键回退）                                                                                                                          | `game-store.ts:49-50`、`ChatFlow.vue:194,324`      | ✅ 状态坑位已挖好，M5 负责「写入」                    |
| ④   | **CombatSystemCard 已存在**（战后结果卡片，消费 `CombatSystemEvent.details`）                                                                                                                                                        | `cards/CombatSystemCard.vue`、`types.ts:2964-2969` | ✅ 战后摘要卡片就绪不重做；M5 做「战中实时面板」      |
| ⑤   | **handleCombatTrigger 已接通**：story 输出 `<combat_trigger>` → orchestrator 暂存 → `runCombat` → 摘要 `【战斗摘要】` 回注 ChatFlow                                                                                                  | `game-pipeline.ts:932-979`                         | ✅ 触发链已通，M5 在此链路上「插面板」                |
| ⑥   | ChatFlow 已有「叙事气泡 + system 卡片（可折叠）」的成熟渲染模式                                                                                                                                                                      | `ChatFlow.vue:254-304`                             | ✅ 战斗消息流可直接复用此模式 + 美化逻辑              |

**一句话**：M4 跑通了战斗的「计算 + 叙事 + 触发」，但对前端是「黑盒跑完出摘要」。M5 = **拆开黑盒，过程实时转播成消息流，玩家可按钮拼装 + 自由文本介入**。

---

## 2. 界面设计

### 2.1 CombatPanel 整体布局

```
┌──────────────────────────────────────────────────────────┐
│  ⚔ 战斗 · 标准 · 第 3 回合 · 森林遭遇战          [✕ 关闭]│  CombatHeader
├──────────────────────────────────────────────────────────┤
│ 【敌方】                                                  │
│  ● 哥布林斥候  HP██████░░ 60/80  [流血×2]                 │
│  ● 哥布林萨满   HP███░░░░ 18/60  [祝福]          ⚠ 低血  │  CombatUnitCard(紧凑) ×N
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ─── 第 1 回合 ───                                       │  CombatMessageFlow
│  ╭────叙事────╮                                          │  （flex:1 主区域）
│  │ 英雄横剑一引，幽怨之剑泛起冷光，剑锋直取斥候要害。│     │  叙事气泡 + system卡片交替
│  ╰────────────╯                                          │  自动滚到底
│  ┌─系统·攻击─────────────────────────────────────┐       │
│  │ 英雄 →a 哥布林斥候  检定14(命中)  最终38伤 [▾]│       │
│  └────────────────────────────────────────────────┘       │  ← 折叠态：一行摘要
│  ╭────叙事────╮                                          │
│  │ 斥候侧身欲避，却已慢了半拍，剑刃划开皮肉…     │       │
│  ╰────────────╯                                          │
│  ┌─系统·攻击─────────────────────────────────────┐       │
│  │ 哥布林斥候 → 英雄  检定8(失误)  0伤          [▾]│      │
│  └────────────────────────────────────────────────┘       │
│  ─── 第 2 回合 ───                                       │
│  ...                                                     │
├──────────────────────────────────────────────────────────┤
│ 【我方】                                                  │
│  ● 英雄  T2  HP████████░ 92/100  MP██░ SP████  [专注]    │  CombatUnitCard(紧凑) ×N
├──────────────────────────────────────────────────────────┤
│  ①选单位:[英雄▾]  ②行动:[普攻][技能][道具][防御][逃跑]   │
│  ③技能:[幽怨之剑▾]  ④目标:[哥布林斥候▾]   [↓ 注入文本框] │  CombatActionBar
│  ┌──────────────────────────────────────────────────┐    │  （B+C 混合）
│  │ 英雄施展幽怨之剑，攻向哥布林斥候（可自由编辑）  │    │
│  └──────────────────────────────────────────────────┘    │
│                                            [发送指令]     │
└──────────────────────────────────────────────────────────┘
```

**布局要点**：

- **覆盖层**：`position: fixed; inset: 0`，`z-index` 高于 GamePage。背景 `--theme-overlay-bg` + `backdrop-filter: blur(4px)`（design §4.5）。
- **入场动画**：fade + scale(0.97→1)（design §6.2）；`prefers-reduced-motion` 禁用。
- **消息流 flex:1**：战斗叙事 + 结果卡片是视觉主角（design §1 叙事优先），单位条紧凑贴上下两边。
- **敌我分区**：敌方上 / 我方下 / 中间消息流 —— 模拟「两军对垒」空间感，视线落中间消息流。

### 2.2 子组件拆分

| 组件                        | 职责                                                                                  | 数据来源                                                              | 复用                                                |
| --------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `CombatPanel.vue`           | 主壳层：覆盖层 + 布局编排 + 读 combat-store + 入场/退场动画                           | combat-store                                                          | AppModal 覆盖层模式                                 |
| `CombatHeader.vue`          | 顶栏：战斗类型 / 回合 / 环境 / 关闭                                                   | combat-store.activeCombat                                             | —                                                   |
| `CombatUnitCard.vue`        | 参战单位紧凑条：名字(品质色点) + HP/MP/SP + buff chips + 低血/死亡/当前行动者标记     | CombatParticipant                                                     | `ResourceBar`、`BuffChip`、`qualityVar()`           |
| **`CombatMessageFlow.vue`** | **战斗消息流**：渲染 combatLog entries（叙事气泡 + system 卡片 + 回合分隔），自动滚底 | combat-store.combatLog                                                | ChatFlow 美化（抽 composable）、system 卡片折叠模式 |
| `CombatActionCard.vue`      | 单条工具调用结果卡片：折叠态一行摘要（攻方→守方 检定 伤害），展开态 8 步管线          | CombatActionResult                                                    | 替代旧 `combat-panel.ts` 的 `<action_info>`         |
| `CombatActionBar.vue`       | B+C 操作区：单位/行动/技能/目标 选择器 + 拼装注入 + 自由文本框 + 发送                 | combat-state.participants + CharacterState skills/equipment/inventory | `InputBar` 模式                                     |

**文件位置**：`src/ui/components/game/combat/`（新建子目录）。

### 2.3 战斗消息流设计（CombatMessageFlow）— 核心需求

渲染 `combat-store.combatLog: CombatLogEntry[]`，时间顺序排列：

```ts
type CombatLogEntry =
  | { id: string; kind: 'round_divider'; round: number }
  | { id: string; kind: 'narrative'; text: string; round: number }
  | { id: string; kind: 'action'; result: CombatActionResult; toolName: string }
  | { id: string; kind: 'status_change'; text: string }; // buff 施加/移除等
```

| entry 类型      | 渲染                                                  | 数据来源（事件流）                        |
| --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `round_divider` | 居中装饰线「── 第 N 回合 ──」                         | runner 每轮循环开始                       |
| `narrative`     | 叙事气泡（衬线 + 美化，复用 ChatFlow `beautifyText`） | `round_narrative` 事件                    |
| `action`        | `CombatActionCard`（折叠/展开），见 §2.4              | `action_resolved` 事件                    |
| `status_change` | 小通知条「斥候获得流血×2（2回合）」                   | `action_resolved` 里 `statusApplied` 拆出 |

**复用 ChatFlow 美化**：把 `ChatFlow.vue` 里的 `beautifyText`/`wrapParagraphs`/`getBeautifierRules` 抽成 `useBeautify.ts` composable，CombatMessageFlow 与 ChatFlow 共用。注意不破坏 ChatFlow 现有行为（抽出后 ChatFlow 测试保持绿）。

### 2.4 CombatActionCard（工具结果卡片 · 替代旧 action_info）

**折叠态**（默认，一行摘要）：

```
┌─系统·攻击─────────────────────────────────────┐
│ 英雄 →a 哥布林斥候  检定14(命中)  最终38伤 [▾]│
└────────────────────────────────────────────────┘
```

- 攻方 →a 守方（名字带品质色点）
- 检定值 + 评级（命中/暴击/偏离/失误，语义色徽章）
- 最终伤害（`--theme-error)` 染色）+ 守方 HP 变化（60→22）
- 失误/未命中：灰色「0 伤」+ 评级徽章

**展开态**（点 ▾ 展开，8 步管线）：

```
初始伤害 42  (属性×10×层级 + 技能威力 + 武器攻击)
  ▼ 多段分割 ×1
穿甲：有效防御 88  (防御100 × (1−穿透12%))
  ▼
装备减免 −12  (× 有效防/(有效防+2000))
  ▼
评级 ×1.2 · 意图 ×1.0
  ▼
DR ×0.9
  ▼
★ 最终伤害 38   哥布林斥候 HP 60 → 22（未死）
[状态] 斥候获得 流血×2（2回合）
```

- 竖向管线（`▼` 分隔），每步 KV（design §7.2）
- 最终伤害高亮（`--theme-primary` 染底加粗）
- HP 变化：扣血 `--theme-error`；死亡加粗「已倒下」
- 折叠/展开用 `<Transition>` + `grid-template-rows: 0fr→1fr`（design §6.1，禁 max-height）

### 2.5 CombatUnitCard（紧凑态）

```
● 哥布林斥候                    ⚠ 低血
HP ████████░░░░░░░░  60 / 80
MP ███░░░░░░░░░░░░░  12 / 30
[流血×2 剩2回合] [中毒 剩1回合]
```

- **品质色点 + 名字着色**（design §5.3，禁侧边条）
- HP/MP/SP 用 `ResourceBar`（`--theme-hp`/`--theme-mp`/`--theme-sp`）
- HP < 30% 加 `⚠ 低血` + 条闪烁（`prefers-reduced-motion` 关闪烁）
- 死亡态：`opacity: 0.5` + 删除线 + 「已倒下」角标
- 当前行动者（`turnOrder[currentTurnIndex]`）：`--theme-primary` 环绕光晕（design §4.2 选中态）
- buff chips 复用 `BuffChip.vue`：buff 绿 / debuff 红 / 特殊中性
- 点击单位可展开五维详情（力12 敏14 体10 智8 精11）—— 非必需，M5a 可省

### 2.6 B+C 按钮注入逻辑（CombatActionBar）— 核心需求

**交互流程**（四步拼装）：

```
① 选我方单位（单选下拉，多单位时；单单位时锁定）
② 选行动类型（Tab：普攻 / 技能 / 道具 / 防御 / 逃跑）
③ 若技能/道具 → 选具体项（下拉，从该单位 CharacterState.skills/inventory 查）
④ 若需目标（普攻/攻击型技能）→ 选敌方单位（下拉）
[注入文本框] → 拼装成自然语言填入下方文本框
```

**拼装模板**（注入后玩家可自由编辑）：

| 行动              | 模板                               |
| ----------------- | ---------------------------------- |
| 普攻              | `{actor}挥舞{weapon}攻击{target}`  |
| 技能（攻击型）    | `{actor}施展{skill}，攻向{target}` |
| 技能（自身/辅助） | `{actor}施展{skill}`               |
| 道具              | `{actor}使用{item}`                |
| 防御              | `{actor}举盾防御`                  |
| 逃跑              | `{actor}尝试撤退`                  |

**关键**：

- 拼装结果进**同一个文本框**，玩家可在其后追加细节（「瞄准要害」「全力一击」「试探性攻击」），完全自由编辑。
- 发送时是**自由文本**（不是结构化指令）—— 走 combat agent，agent 据此调工具。保留开放性。
- 多次注入：默认替换文本框内容（或追加，M5b 定）。
- 文本框也可**直接手打**（不点按钮）—— 按钮只是便捷入口。

**数据来源**：`CharacterState.skills`（技能列表）、`CharacterState.equipment`（武器名）、`CharacterState.inventory`（道具）。字段以 `types.ts` CharacterState 定义为准（实施时核对）。

---

## 3. 数据流与引擎改造

### 3.1 事件流（给 runCombat 加回调 · 纯增量）

`runCombat(request, deps)` → `runCombat(request, deps, onCombatEvent?)`：

```ts
export type CombatEvent =
  | { type: 'combat_started'; state: CombatState }
  | { type: 'action_resolved'; result: CombatActionResult; toolName: string }
  | { type: 'round_narrative'; text: string; round: number }
  | { type: 'round_started'; round: number }
  | { type: 'combat_ended'; summary: CombatSummaryResult }
  | { type: 'awaiting_player_input'; round: number }; // M5b 人机交替
```

**emit 时机**（`combat-runner.ts` 现有位置）：

| 事件                    | 位置                                               | 数据                        |
| ----------------------- | -------------------------------------------------- | --------------------------- |
| `combat_started`        | `combat_start` 后 combatState 赋值完（`:187-189`） | 新 CombatState              |
| `action_resolved`       | 每次 `executeCombatToolCall` 返回后（`:184`）      | CombatActionResult + 工具名 |
| `round_started`         | 每轮 for 循环开头（`:168`）                        | 回合数                      |
| `round_narrative`       | `chatWithTools` 返回 output 后（`:209`）           | 叙事文本 + 回合             |
| `combat_ended`          | return 前（`:236`）                                | CombatSummaryResult         |
| `awaiting_player_input` | M5b：我方回合需要玩家指令时                        | 回合数                      |

> 🔑 **纯增量**：onCombatEvent 可选，M4 的 6 个 runner 测试零破坏。事件流「旁路」只读不改主流程。

### 3.2 GamePipeline 桥接

```ts
// handleCombatTrigger 内：
this.game.enterCombat(); // 激活覆盖层
const result = await runCombat(request, deps, (evt) => {
  this.game.applyCombatEvent(evt); // 转发 → combat-store
});
this.game.exitCombat(result); // 覆盖层滑出 + 摘要回注（沿用现有逻辑）
```

**M5b 玩家输入桥接**：runner emit `awaiting_player_input` 时暂停（await resolver Promise）；CombatActionBar 发送文本 → pipeline 拿到 resolver → resolve(文本) → 文本注入 agent messages → agent 继续。

### 3.3 combat-store（game-store.ts 扩展）

```ts
const combatLog = ref<CombatLogEntry[]>([]); // 消息流条目
const combatLastAction = ref<CombatActionResult | null>();

function enterCombat() {
  isInCombat = true;
  combatLog = [];
  combatLastAction = null;
}
function applyCombatEvent(evt: CombatEvent) {
  // combat_started → activeCombat = evt.state
  // round_started  → combatLog.push({kind:'round_divider'})
  // round_narrative→ combatLog.push({kind:'narrative'})
  // action_resolved→ combatLog.push({kind:'action'}) + combatLastAction；statusApplied 拆 status_change
  // awaiting_player_input(M5b) → combatAwaitingInput = true
}
function exitCombat(result) {
  activeCombat = null;
  isInCombat = false;
  combatLog = []; /* 摘要回注已有 */
}

// M5b:
const combatAwaitingInput = ref(false);
function submitCombatInput(text: string) {
  /* resolve pending resolver */
}
```

### 3.4 B+C 人机交替（runner 行为级改动 · M5 合并实施）

**先纠正认知**（§1 已查证）：combat agent prompt **当前就要求**「我方由用户输入」，核心不用改。偏离在 runner（M4 代打权宜）。M5 让 runner 追上 prompt。

**回合边界控制（关键设计点 · M5 RFC 展开）**：要实现「轮到我方停止」，runner 要从「agent 一次 chatWithTools 跑全场」改成「按行动轴逐单位调度」。两条技术路径：

| 路径                        | 机制                                                                                                                                                                                                   | 可靠性                               | 改动量                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------ |
| **X · runner 调度（推荐）** | runner 维护「当前行动单位」，按 turnOrder 推进：敌方 → 调 agent 自主打；我方 → emit `awaiting_player_input` + `await pendingResolver` 等玩家文本 → 注入 agent。agent 每次 chatWithTools 只处理一个单位 | 🟢 高（代码控边界，不依赖 LLM 自律） | 🟡 中（runner 循环重构） |
| Y · agent 自停              | prompt 告诉 agent「轮到我方输出 `<await_input>` 停」，runner 检测标记暂停                                                                                                                              | 🔴 低（LLM 可能忘停/代打/格式错）    | 🟢 小                    |

**本喵推荐路径 X**：runner 当回合调度器，agent 只做「单单位战术决策 + 叙事」。可靠、职责清晰、与 prompt「我方由用户输入」天然对齐。

**runner 骨架（路径 X）**：

```
初始化: 第一次 chatWithTools → agent 调 combat_start → 拿 CombatState(turnOrder)
while combatState.status !== 'ended':
  unit = turnOrder[currentTurnIndex]
  if unit.side === 'enemy':
    messages.push(user: `轮到 {enemy} 行动，你控制`)
    chatWithTools → agent 调工具 + 叙事
  else:  // 我方
    emit awaiting_player_input(unit, round)
    playerText = await pendingResolver   ← 暂停等玩家
    messages.push(user: `玩家指令({ally}): ${playerText}`)
    chatWithTools → agent 据指令调工具 + 叙事
  currentTurnIndex++ → 到末尾则 round++（round.start/end 事件）
```

**prompt 微调（配合路径 X，非改核心）**：明确告诉 agent「我方回合你会收到一条 `玩家指令(...)` 的 user 消息，据此调工具；敌方回合收到 `轮到...你控制`。不要代打我方。」核心「我方由用户输入」不变。

**暂停/恢复机制**：runner 持有 `pendingResolver`，emit `awaiting_player_input` 后 `await new Promise`；前端 `submitCombatInput(text)` 通过 pipeline resolve 它，文本注入 agent messages 继续。

**超时兜底**：倾向持续等待（文字 RPG 无实时压力），可在 CombatActionBar 加「代打本回合」按钮交玩家选。

---

## 4. 任务清单

> 📌 **实施方式：M5a + M5b 合并连续做**（主人确认 2026-07-29）。prompt 本就要求「我方等输入」，M5a「代打观战」是临时违背 prompt 的过渡态——不如直接做最终态。下表保留 a/b 标签仅便理解任务性质，不做分批交付。真机验证留 M6。

### M5a · 观战面板 + 消息流（能跑能看）

| #     | 任务                      | 涉及文件                                      | 产出                                                               | 验收                             |
| ----- | ------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| 5a.1  | runCombat 事件流          | `combat-runner.ts`                            | +`CombatEvent` + `onCombatEvent` 参数 + 5 处 emit（不含 awaiting） | 现有 6 测试全绿 + 新增事件流测试 |
| 5a.2  | combat-store 战斗状态     | `game-store.ts`                               | enter/exit/applyCombatEvent + combatLog/combatLastAction           | 单元测试：事件→entries 流转      |
| 5a.3  | pipeline 桥接             | `game-pipeline.ts`                            | handleCombatTrigger 传 onCombatEvent → store                       | 集成：trigger → 面板有数据       |
| 5a.4  | 美化 composable 抽取      | `useBeautify.ts` + ChatFlow 改用              | beautifyText/wrapParagraphs 抽出复用                               | ChatFlow 现有测试不破坏          |
| 5a.5  | CombatPanel 壳层 + Header | `combat/CombatPanel.vue` + `CombatHeader.vue` | 覆盖层 + 布局 + 动画 + 读 store                                    | 手动：滑入/滑出                  |
| 5a.6  | CombatUnitCard            | `combat/CombatUnitCard.vue`                   | 紧凑单位条（HP/MP/SP + buff + 低血/死亡/当前态）                   | 手动：数值/buff/品质色点正确     |
| 5a.7  | CombatMessageFlow         | `combat/CombatMessageFlow.vue`                | 消息流（叙事气泡 + system 卡片 + 回合分隔）+ 自动滚底              | 手动：叙事/卡片交替渲染          |
| 5a.8  | CombatActionCard          | `combat/CombatActionCard.vue`                 | 折叠一行摘要 + 展开八步管线                                        | 手动：对齐 CombatDamageBreakdown |
| 5a.9  | GamePage 接线 + 正文暂停  | `GamePage.vue`                                | 战斗覆盖层挂载（isInCombat 驱动）                                  | 手动：战斗盖住主界面、结束滑出   |
| 5a.10 | 设计规范对齐              | 全套 combat 组件                              | design.md §8 检查清单逐项                                          | 设计审查                         |

### M5b · B+C 玩家介入（能打能指挥）

| #    | 任务                     | 涉及文件                             | 产出                                                    | 验收                             |
| ---- | ------------------------ | ------------------------------------ | ------------------------------------------------------- | -------------------------------- |
| 5b.1 | runner 人机交替          | `combat-runner.ts`                   | +`awaiting_player_input` + 暂停/恢复（pendingResolver） | 单元：我方回合暂停、敌方自主     |
| 5b.2 | combat agent prompt 调整 | `agent-config.json`（combat）        | 「每回合等我方指令；敌方你决策；据指令调工具+叙事」     | prompt 审查                      |
| 5b.3 | CombatActionBar          | `combat/CombatActionBar.vue`         | 四步选择器 + 拼装注入 + 自由文本框 + 发送               | 手动：拼装正确、可编辑、发送生效 |
| 5b.4 | 桥接玩家输入             | `game-pipeline.ts` + `game-store.ts` | store pendingResolver + pipeline 转发文本               | 集成：发送 → 战斗继续            |

### 原 plan §6 对照

| 原 plan                 | 归属                      | 说明                |
| ----------------------- | ------------------------- | ------------------- |
| 6.1 CombatPanel 主组件  | 5a.5                      | ✅                  |
| 6.2 敌我角色展示区      | 5a.6                      | ✅                  |
| 6.3 战斗对话流          | 5a.7（CombatMessageFlow） | ✅ 升级为消息流     |
| 6.4 输入区 + 角色选择   | 5b.3（B+C 混合）          | ✅ 按钮注入文本框   |
| 6.5 战斗状态 store      | 5a.2                      | ✅                  |
| 6.6 正文暂停机制        | 5a.9                      | ✅ 覆盖层天然暂停   |
| 6.7 pipeline 桥接       | 5a.1 + 5a.3 + 5b.4        | ✅                  |
| 6.8 数值面板渲染        | 5a.8（CombatActionCard）  | ✅ 升级为可折叠卡片 |
| 6.9 战斗结束 + 摘要注入 | 5a.3（exitCombat）        | ✅                  |
| 6.10 样式设计规范       | 5a.10                     | ✅                  |

---

## 5. 风险

### 🔴 高风险

1. **方案 B 人机交替循环**（M5b）：runner 从「agent 自主内循环」改成「暂停-恢复」是行为级改动，要保证 agent 对话连贯性（messages 序列不乱）。M5a 先不做，M5b 单独 RFC。
2. **美化 composable 抽取**（5a.4）：beautifyText 等耦合在 ChatFlow.vue，抽取要保证 ChatFlow 现有行为 + 测试零破坏。

### 🟡 中风险

3. **实时 HP 条性能**：每次 action_resolved 更新 HP 条，单场几十次。ResourceBar `transition: width 250ms`，高频可能堆积——必要时节流（16ms 合帧）。M5a 先不优化，真机看效果。
4. **覆盖层与 ChatFlow 输入冲突**：战斗中确保 ChatFlow 的 InputBar 禁用（`isInCombat` 已覆盖，需核实 InputBar 的 `:disabled` 绑定）。
5. **消息流滚动抖动**：叙事 + 卡片交替、卡片展开会改变内容高度，自动滚底要稳定（ChatFlow 已有 watch scrollTop 方案可复用）。

### ⚠️ 注意

- 所有新组件遵循 design.md §8 检查清单（禁侧边条 / 色点品质 / 纸叠阴影 / prefers-reduced-motion）。
- combat-runner 事件流改造**纯增量**，M4 的 6 个测试必须保持全绿。
- CharacterState skills/equipment/inventory 字段以 types.ts 为准，实施 5b.3 时核对。

---

## 6. 实施建议

- **合并实施 M5a+M5b**（主人确认 2026-07-29）：prompt 本就要求「我方等输入」，合并做让 runner 只改一次、prompt 基本不动、前端组件一次出；分开做反而要先做临时「代打态」再改回。真机验证留 M6。
- **RFC 前置**：路径 X 回合调度是 runner 行为级改动，开干前本喵先出 M5 RFC（细化 turnOrder 推进 / 暂停恢复机制 / 敌方连续单位是否合并一次调用 / 与现有 6 个 runner 测试的兼容 / CombatEvent 完整清单）。
- **subagent 并行方案**（对齐 M4「主线核心 + subagent 并行周边」）：
  - **主线做**：runCombat 事件流 + 路径 X 回合调度重构（5a.1+5b.1，引擎核心）、combat-store（5a.2）、pipeline 桥接含玩家输入（5a.3+5b.4）、CombatPanel 壳层 + GamePage 接线（5a.5+5a.9）、美化 composable 抽取（5a.4，跨 ChatFlow 谨慎）
  - **subagent 并行**（文件零重叠）：CombatUnitCard（5a.6）、CombatActionCard（5a.8）、CombatMessageFlow（5a.7）、CombatActionBar（5b.3）—— 四个独立 .vue，适合 code-writer 并行
  - **主线收尾**：prompt 微调（5b.2）、设计规范审查（5a.10）、全量测试

---

## 7. 变更记录

| 日期       | 变更                                                                                                                      | 作者           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 2026-07-29 | 初版：现状审计 + 3 决策点 + 界面设计 + A+B 分阶段任务                                                                     | Claude（计划） |
| 2026-07-29 | 定稿：决策 1 改 B+C 混合（按钮注入文本框）；新增战斗消息流设计（§2.3）；CombatActionCard 可折叠卡片（§2.4）；任务清单重排 | Claude（计划） |
| 2026-07-29 | 修订：查证 prompt 已要求「我方等输入」不用改核心（§1 补充）；M5a+M5b 合并实施；新增回合边界控制路径 X/Y（§3.4）           | Claude（计划） |
