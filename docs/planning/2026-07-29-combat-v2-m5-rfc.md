# 战斗 v2 · M5 前端战斗面板 RFC（路径 X 回合调度 + 事件流）

> 📅 **日期**：2026-07-29
> 📌 **性质**：M5 开干前的最后设计文档。细化 runner 路径 X（按行动轴逐单位调度）+ 事件流 + 测试兼容 + 决策点
> 🔗 **依据**：[M5 plan](./2026-07-29-combat-v2-m5-plan.md)（§3.4 路径 X）、[combat-agent-api.md](../reference/combat-agent-api.md) §5
> ✅ **状态**：主人确认「出完 RFC 就开干」。本 RFC 决策点附推荐默认，无异议即按推荐执行

---

## 0. 背景与目标

M5 要把 combat-runner 从「M4 黑盒代打全场」改造成「按行动轴逐单位调度 + 事件流旁路给前端 + 我方单位停下来等玩家文本输入」。本 RFC 细化：

1. runner 调度循环（路径 X）的精确逻辑
2. `pendingResolver` 暂停/恢复生命周期
3. `CombatEvent` 完整清单（前端消息流的数据源）
4. 现有 6 个 runner 测试的兼容方案
5. 5 个决策点 + 推荐默认

**非目标**：前端组件实现（plan §2/§4 已定）、combat 数值管线（M3 已定）、prompt 措辞（§5 微调）。

---

## 1. 现状代码分析（路径 X 的起点）

### 1.1 runner 当前循环（`combat-runner.ts:167-223`）

```
for (外层 i ≤ MAX_TURNS=10):
  combatCtx = {...}
  result = chatWithTools(messages, executeCombatToolCall, {maxRounds: MAX_TOOL_ROUNDS=40})
    // ↑ agent 在这一次 chatWithTools 里可能连续调:
    //   combat_start + 多次 combat_attack(敌我都打) + combat_end
  push assistant output
  检测 <combat_summary> → break
  push user feedback(buildRoundFeedback: "我方代为行动")
```

**特征**：agent 是「主持人自主打全场」，一次 chatWithTools 跑完一整段战斗（甚至整场）。runner 外层只是「再给 agent 一轮机会」。

### 1.2 工具返回值（`agent-tools.ts:1299-1493`）

| 工具 | 返回（给 agent 看的 `result`） |
|------|------------------------------|
| `combat_start` | 摘要 `{combatId, combatType, round, status, environment, turnOrder, participants[{name,side,hp,maxHp,tier,level}]}` + **`_combatState`**（原始完整 CombatState，runner 据此更新 ctx.combat） |
| `combat_attack` | 完整 `CombatActionResult`（含 8 步 damage / intention / attackRoll / finalHp / isDead / statusApplied / patches） |
| `combat_end` | `SettlementResult`（exp/fp/loot/summary） |
| `status_apply/remove` | `{action/buffId/patches/updated}` |

### 1.3 🔴 死字段发现：`currentTurnIndex`

grep 全仓 `currentTurnIndex`：**仅 `initCombat`（combat-resolver.ts:416）设 0**，无任何代码推进。M4 的 agent 自主选攻守双方，完全不用行动轴调度。

**路径 X 要激活它**：runner 自己维护 `turnPtr` 推进（不依赖管线推进），按 `combatState.turnOrder[turnPtr]` 取当前单位。

### 1.4 `CombatUnitTurn` 无 side（`types.ts:2440`）

```ts
interface CombatUnitTurn {
  characterId, name, agility, d20Roll, speedModifiers, totalInitiative,
  attacksRemaining, actionsRemaining
  // ❌ 无 side 字段
}
```

**路径 X 的 side 判定**：runner 在 combat_start 后，从 `combatState.participants` 建一个 `Map<characterId, 'ally'|'enemy'>`，调度时按 `turnOrder[turnPtr].characterId` 查。

### 1.5 buildRoundFeedback 代打偏离（`combat-runner.ts:260`）

> 「我方单位若无明确用户指令，**按战术合理性代为行动**」

这正是偏离 prompt（prompt 要求「我方由用户输入」）的权宜代码。路径 X 删除它，改成「我方单位 → 暂停等玩家」。

---

## 2. 路径 X 设计

### 2.1 runCombat 新签名

```ts
export async function runCombat(
  request: CombatRunRequest,
  deps: CombatRunDeps,
  onCombatEvent?: (evt: CombatEvent) => void,   // 🆕 事件流（可选，纯增量）
): Promise<CombatSummaryResult>
```

`onCombatEvent` 可选 → 不传时 runner 照跑（M4 测试场景 / 无前端时）。

### 2.2 调度循环（核心伪代码）

```ts
// ===== 阶段 1: 初始化 =====
let messages = buildAgentMessages('combat', ctxWithStory, ...);
messages.push({role:'user', content: triggerInfo + '第一步调 combat_start 初始化'});

// 初始化回合：让 agent 调 combat_start（这一轮 agent 自主）
let initResult = await chatWithTools(messages, toolCallback('init'));
// toolCallback 里 combat_start → combatState 赋值 + emit combat_started

if (!combatState) throw new Error('agent 未调 combat_start');

// side 映射表
const sideOf = new Map(combatState.participants.map(p => [p.characterId, p.side]));

let turnPtr = 0;  // = currentTurnIndex，runner 自己推

// ===== 阶段 2: 行动轴调度循环 =====
while (combatState.status !== 'ended') {
  const unit = combatState.turnOrder[turnPtr];
  if (!unit) break;  // 行动轴空（异常兜底）

  // 跳过无法行动 / 已死亡的单位
  const p = combatState.participants.find(x => x.characterId === unit.characterId);
  if (!p || !p.canAct || p.hp <= 0) {
    turnPtr = advance(turnPtr);
    continue;
  }

  emit({type:'turn_started', unit: unit.name, round: combatState.round});

  if (sideOf.get(unit.characterId) === 'enemy') {
    // ── 敌方：agent 自主 ──
    messages.push({role:'user', content:
      `轮到【敌方】${unit.name} 行动。你控制其战术（攻击/技能/道具/格挡/移动），调工具 + 输出本回合叙事。`
    });
    const r = await chatWithTools(messages, toolCallback('enemy'));
    messages.push({role:'assistant', content: r.output ?? ''});
    emit({type:'round_narrative', text: r.output ?? '', round: combatState.round});
  } else {
    // ── 我方：暂停等玩家 ──
    emit({type:'awaiting_player_input', unit: unit.name, unitId: unit.characterId, round: combatState.round});
    const playerText = await awaitPlayerInput();   // ← 暂停，pendingResolver
    messages.push({role:'user', content:
      `【玩家指令】我方 ${unit.name}：${playerText}\n请理解意图后调对应工具，并输出本回合叙事。`
    });
    const r = await chatWithTools(messages, toolCallback('ally'));
    messages.push({role:'assistant', content: r.output ?? ''});
    emit({type:'round_narrative', text: r.output ?? '', round: combatState.round});
  }

  // 检测 <combat_summary>（agent 可能在任一次输出里结束战斗）
  if (摘要检测) break;

  turnPtr = advance(turnPtr);
  // 行动轴走完 → round++ + emit round_started + 代码结算 round.start/end buff
}

// ===== 阶段 3: patches 落库 + 返回摘要（沿用 M4 逻辑）=====
```

**`advance(turnPtr)`**：`(turnPtr + 1) % turnOrder.length`；若回绕到 0 → `combatState.round++` + 触发回合事件。

### 2.3 暂停/恢复机制（`pendingResolver` 生命周期）

```ts
// runner 内
let pendingResolver: ((text: string) => void) | null = null;
let pendingRejecter: ((err: Error) => void) | null = null;

function awaitPlayerInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingResolver = resolve;
    pendingRejecter = reject;
  });
}

// deps 新增：供外部（pipeline）注入玩家文本
async function submitPlayerInput(text: string) {
  if (pendingResolver) { pendingResolver(text); pendingResolver = null; pendingRejecter = null; }
}

// abort / 错误清理
function failPending(err: Error) {
  if (pendingRejecter) { pendingRejecter(err); pendingResolver = null; pendingRejecter = null; }
}
```

**CombatRunDeps 扩展**：runner 把 `submitPlayerInput` 通过返回值或 deps 暴露给 pipeline。两种方式：
- **方式 A**：`runCombat` 返回 `{ summary, submitPlayerInput }` —— 但 summary 是 await 后才返回，submitPlayerInput 要在 await 期间用，矛盾。
- **方式 B（推荐）**：deps 传一个 `onCombatEvent` 回调，emit `awaiting_player_input` 时 pipeline 收到 → pipeline 把自己的 `submitText` 函数挂到 combat-store → 前端发送时调 → pipeline 转发给 runner 的 `submitPlayerInput`。

**pipeline 侧桥接**（推荐 B）：
```
runner 持有 pendingResolver
  ↓ emit awaiting_player_input
pipeline onCombatEvent → game-store.setCombatAwaiting(true) + 记住 runner 的 submitPlayerInput
  ↓ 前端 CombatActionBar 发送
game-store.submitCombatInput(text)
  → pipeline 调 runner.submitPlayerInput(text)
  → resolve pendingResolver → runner 继续
```

为让 pipeline 拿到 runner 的 `submitPlayerInput`，runner 通过 `onCombatEvent` 的 `awaiting_player_input` 事件 payload 携带一个 `submitRef`（或 pipeline 在 deps 里传一个 `registerSubmitter` 回调，runner emit 时调它注册）。

**D3 决策（abort 清理）**：pipeline abort 时调 `failPending(new AbortError())`，runner 的 `awaitPlayerInput` 抛错 → 循环 catch → 退出。推荐采用。

### 2.4 敌方连续单位优化（D1 决策）

场景：行动轴上连续 2+ 个敌方单位。两种处理：

| 选项 | 机制 | 优缺 |
|------|------|------|
| **D1-a 严格逐单位（推荐）** | 每个敌方单位一次 chatWithTools | 🟢 简单一致、与「每单位一次行动」对齐、消息流粒度清晰；🟡 连续敌方时多一次 agent 调用（token 稍多） |
| D1-b 连续敌方合并 | 把连续敌方单位合并成一次 chatWithTools，agent 依次处理 | 🟢 省 token；🔴 复杂、agent 可能漏单位、消息流粒度乱 |

**推荐 D1-a**：M5 先简单一致。连续敌方多一次调用，但 agent 有 cache（固定 systemPrompt），成本可控。优化后置。

### 2.5 单位回合边界（D2 决策）

每个单位每回合「1 攻击 + 1 动作」（prompt 约束）。路径 X 怎么判「这个单位这回合行动完了」？

| 选项 | 机制 | 优缺 |
|------|------|------|
| **D2-a 一次 chatWithTools = 一单位完整回合（推荐）** | agent 在那次调用里自己安排 1 攻击 + 1 动作（调 combat_attack + combat_block/focus/move 等），chatWithTools 结束 = 该单位回合结束 → 推进 turnPtr | 🟢 简单、信任 agent + 管线硬约束（consumeAttack/consumeAction 在 action 管线里）、与 prompt「每单位 1 攻击+1 动作」对齐 |
| D2-b runner 严格判 attacksRemaining/actionsRemaining | runner 读 unit.attacksRemaining/actionsRemaining，归零才推进 | 🔴 复杂、要处理「agent 只攻击不动作」「单位被状态限制」等边界 |

**推荐 D2-a**：runner 不判资源数，信任 agent + 管线硬约束。简单可靠。（管线里的 consumeAttack/consumeAction 是代码硬约束，agent 超额调用会被拒，不影响 runner 调度。）

---

## 3. CombatEvent 完整清单

```ts
export type CombatEvent =
  | { type: 'combat_started'; state: CombatState }
  | { type: 'turn_started'; unit: string; unitId: string; round: number }
  | { type: 'action_resolved'; result: CombatActionResult; toolName: string }
  | { type: 'status_change'; targetName: string; buffs: Array<{name;action;duration?}> }
  | { type: 'round_narrative'; text: string; round: number }
  | { type: 'round_started'; round: number }
  | { type: 'awaiting_player_input'; unit: string; unitId: string; round: number }
  | { type: 'combat_ended'; summary: CombatSummaryResult };
```

| 事件 | emit 时机 | 前端消费 |
|------|----------|---------|
| `combat_started` | combat_start 工具回调后 | combat-store: `activeCombat = state` + 建单位卡片 |
| `turn_started` | 行动轴推进到新单位时 | 高亮当前行动者单位卡片 |
| `action_resolved` | 每次 executeCombatToolCall 返回后（combat_attack/use_skill/...） | 消息流 push `action` 条目（CombatActionCard） |
| `status_change` | action_resolved 里拆出 statusApplied | 消息流 push `status_change` 通知条 |
| `round_narrative` | 每次 chatWithTools 返回 output 后 | 消息流 push `narrative` 气泡 |
| `round_started` | 行动轴回绕 round++ 时 | 消息流 push `round_divider` |
| `awaiting_player_input` | 我方单位回合，await 前 | combat-store: `combatAwaitingInput=true` → CombatActionBar 激活 |
| `combat_ended` | 循环结束 return 前 | combat-store: exitCombat + 摘要回注 ChatFlow |

**action_resolved 与 status_change 的关系**：combat_attack 的 CombatActionResult 里有 `statusApplied: Array<{name,duration,effect}>`。runner emit action_resolved（含完整 result），前端从中拆 statusApplied 渲染 status_change 条目。或 runner 主动额外 emit status_change —— **推荐前者**（runner 只 emit action_resolved，前端拆），减少事件冗余。

> 📌 清单简化：去掉 status_change 独立事件，前端从 action_resolved.result.statusApplied 拆。最终 7 个事件。

---

## 4. 测试兼容（现有 6 个 runner 测试）

### 4.1 现状测试（`combat-runner.test.ts`）

```
1. 解析 <combat_summary> 返回 CombatSummaryResult（ally_win）
2. 敌方获胜判定
3. 逃跑判定
4. 平局兜底
5. 未生成 summary 走兜底（循环达上限）
6. client 不支持 chatWithTools 抛错
```

mock client：`chatWithTools` 永远返回固定 output（含或不含 `<combat_summary>`）。**这是「agent 一次跑完」的假设**。

### 4.2 路径 X 后的测试重构

路径 X 改变 runner 行为（不再是「外层 for + 内层一次 chatWithTools」），现有 mock 模式不适用。重构方案：

**保留为纯函数测试**：`inferOutcome`（胜负判定）、`buildRoundFeedback`（删）、摘要解析逻辑 —— 抽成纯函数，独立测试，不依赖 runner 循环。

**runner 集成测试重写**：mock client 按调用次数返回不同 output（模拟行动轴推进）：
```
mock chatWithTools 第 1 次: "已调 combat_start...（含 turnOrder 信息）"
  → 但 combat_start 是工具调用，不是 chatWithTools output！
```

**关键**：combat_start 在 chatWithTools 内部的工具回调里发生（mock client 要触发 toolExecutor）。现有 mock client 不调 toolExecutor。重写 mock：
- mock chatWithTools(request, toolExecutor): 
  - 第 1 次：调 toolExecutor('combat_start', {...}) 拿 _combatState → 返回叙事 "战斗开始..."
  - 第 2 次（敌方）：调 toolExecutor('combat_attack', {敌方打我方}) → 返回叙事
  - 第 3 次（我方）：等玩家输入 → 返回叙事。但测试里没玩家 → 测试要主动 submitPlayerInput

**测试简化策略**：
- **场景测试（all-enemy）**：行动轴全是敌方（或 mock 我方单位无需玩家输入的场景）→ 测试 runner 能跑完 + emit 事件 + 返回摘要。
- **玩家输入测试**：mock 一个我方单位，runner emit awaiting_player_input → 测试调 submitPlayerInput('攻击') → runner 继续。
- **胜负判定**：抽成纯函数 inferOutcome 独立测（不依赖循环）。

### 4.3 测试数量预估

现有 6 → 重构后 ~8-10（纯函数 inferOutcome 3 + runner 集成 5-7：combat_started 事件 / 敌方回合推进 / 我方回合等输入 / 摘要解析 / abort 清理 / 死字段跳过）。

---

## 5. 决策点汇总（附推荐默认）

| # | 决策 | 推荐 | 理由 |
|---|------|------|------|
| D1 | 敌方连续单位 | **逐单位（D1-a）** | 简单一致，消息流粒度清晰，cache 省 token |
| D2 | 单位回合边界 | **一次 chatWithTools = 一单位回合（D2-a）** | 信任 agent + 管线硬约束，runner 不判资源数 |
| D3 | abort 清理 | **failPending(AbortError)** | abort 时 reject pendingResolver，runner 退出 |
| D4 | 首轮初始化 | **combat_start 单独一次 chatWithTools** | 初始化是独立阶段（无具体单位行动），清晰 |
| D5 | agent 叙事碎片化 | **messages 累积历史** | agent 每次看到完整战斗历史，叙事连贯（historyLayers 配合） |

> 无异议即按推荐执行。

---

## 6. 任务拆分（对接 plan §4，合并 M5a+M5b）

### 引擎主线（主线做，顺序依赖）
| # | 任务 | 文件 |
|---|------|------|
| E1 | CombatEvent 类型 + runCombat 加 onCombatEvent 参数 | `combat-runner.ts` + `types.ts` |
| E2 | 路径 X 调度循环重构（sideOf + turnPtr + while） | `combat-runner.ts` |
| E3 | pendingResolver 暂停/恢复 + submitPlayerInput 暴露 | `combat-runner.ts` + `CombatRunDeps` |
| E4 | 事件流 emit 7 处 | `combat-runner.ts` |
| E5 | runner 测试重构（纯函数 + 集成） | `combat-runner.test.ts` |
| E6 | combat-store 战斗状态（enter/exit/applyCombatEvent + combatLog） | `game-store.ts` |
| E7 | pipeline 桥接（onCombatEvent → store + submitPlayerInput 转发） | `game-pipeline.ts` |
| E8 | combat agent prompt 微调（配合路径 X 调度语气） | `agent-config.json` |

### 前端主线（主线做）
| # | 任务 | 文件 |
|---|------|------|
| F1 | 美化 composable 抽取（beautifyText/wrapParagraphs） | `useBeautify.ts` + ChatFlow 改用 |
| F2 | CombatPanel 壳层 + CombatHeader | `combat/CombatPanel.vue` + `CombatHeader.vue` |
| F3 | GamePage 接线（isInCombat 驱动覆盖层） | `GamePage.vue` |
| F4 | 设计规范审查 + 全量测试 | 全套 |

### 前端并行（subagent，文件零重叠）
| # | 任务 | 文件 |
|---|------|------|
| P1 | CombatUnitCard（紧凑单位条） | `combat/CombatUnitCard.vue` |
| P2 | CombatActionCard（折叠摘要 + 展开八步管线） | `combat/CombatActionCard.vue` |
| P3 | CombatMessageFlow（消息流） | `combat/CombatMessageFlow.vue` |
| P4 | CombatActionBar（B+C 四步选择 + 注入文本框） | `combat/CombatActionBar.vue` |

**并行前提**：P1-P4 文件互不重叠，但都依赖 combat-store 的接口（E6 定型）。所以 **E1-E7 引擎主线先做**，E6 把 combat-store 接口定死 → P1-P4 subagent 并行 + F2/F3 主线同步。

---

## 7. 风险与缓解

### 🔴 高风险
1. **路径 X 循环重构破坏 M4 行为**：M4 的 agent「自主打全场」行为被改成「逐单位」。缓解：runner 测试重写覆盖关键路径（E5）；真机验证留 M6。
2. **agent 不按路径 X 配合**：agent 可能在「敌方单位回合」里试图代打我方，或在「我方回合」不等指令就行动。缓解：prompt 微调（E8）明确「每次只处理当前单位」+ user 消息强约束；messages 累积历史让 agent 看到节奏。

### 🟡 中风险
3. **pendingResolver 泄漏**：战斗 abort / 报错时未清理 → runner 挂起。缓解：failPending 在 finally 调（D3）。
4. **mock client 测试复杂度**：路径 X 后 mock 要按调用次数 + 触发 toolExecutor 响应。缓解：封装一个 `makeTurnBasedMockClient` 测试工厂。
5. **美化 composable 抽取破坏 ChatFlow**：beautifyText 等耦合 ChatFlow。缓解：抽出后 ChatFlow 测试全量跑。

### ⚠️ 注意
- onCombatEvent 可选，保证「无前端」场景（纯引擎调用）runner 照跑。
- 路径 X 删除 buildRoundFeedback（代打逻辑），改为 turn_started + awaiting_player_input 事件驱动。
- prompt 微调不改核心（「我方由用户输入」「数值工具算」不变），只调整调度语气。

---

## 8. 实施顺序（开干路线图）

```
E1 → E2 → E3 → E4 → E5   (combat-runner 引擎核心 + 测试)
  ↓
E6 (combat-store 接口定型) ← P1/P2/P3/P4 subagent 并行起点
  ↓
E7 (pipeline 桥接)
  ↓
E8 (prompt 微调) + F1 (美化抽取)
  ↓
F2/F3 (主线壳层 + GamePage)  ← P1-P4 并行中
  ↓
F4 (设计审查 + 全量测试)
  ↓
commit + push
```

**第一批 commit 预期**：E1-E5（引擎核心，含测试）。然后 E6-E8 + F1（桥接 + prompt + 美化）。最后 P1-P4 + F2-F4（前端）。

---

## 9. 变更记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-07-29 | 初版：路径 X 调度 + 事件流 + 测试兼容 + 5 决策点 + 任务拆分 | Claude（RFC）|
