# 战斗 v2 — M3 战斗管线重构 RFC

> 📅 **日期**：2026-07-28
> 📌 **状态**：RFC（待主人拍板，拍板后方可动代码）
> 🔗 **上游**：[`combat-system-architecture.md`](../reference/combat-system-architecture.md)（§六 流程与 event 时间线 / §八 8 步管线 / §七 计算分工）、[`2026-07-28-combat-system-v2-plan.md`](./2026-07-28-combat-system-v2-plan.md)（M3 任务 4.1–4.10）、M1/M2 RFC（已交付 emitChain/collect_mods/divinity/buff-registry）
> ⚠️ **原则**：M3 是 **M1-M6 里最大批次**（计划标注 🔴 最大改动）。核心立场：**新建管道版 + 保留 legacy 并行**，让 193 个战斗测试零破坏，管道版独立验证后再 M6 删 legacy。

---

## 0. 摘要

M3 把同步纯函数的 `resolveAttack` 升级为 **async 管道版**，接入 M1 的 `emitChain`（19 event 触发点）+ M2 的 `collect_mods`（modifier 注入 8 步管线）+ 登神压制 + HP 红线 + $combat API 扩展 + 战意/结算/集群接线。

交付 3 块：
1. **新建 `combat-pipeline.ts`**（管道版 `resolveAttackPipeline` 等，async + emitChain）——`combat-resolver.ts` 保留为 legacy
2. **`combat-damage.ts` 加 modifier 注入缝**（runDamagePipeline input 加可选 modifier 字段，不破坏 61 个现有测试）
3. **19 event 触发点 + 登神压制 + HP 红线 + 战意接线 + 结算管线 + 集群适配 + $combat API 扩展**

**一句话结论**：不动 `combat-resolver.ts`（保留 legacy + 19 测试全绿），新建管道版让 M1/M2 的基础设施**通电**——真正把 collect_mods 收来的 modifier 灌进 8 步管线、把 divinity 压制接入 Step 3/7、把 19 event 串起来。

---

## 1. 现状审计（RFC 的地基）

### 1.1 combat-resolver.ts 现状（同步 6 步，无 event 无 modifier）

`resolveAttack(input): CombatActionResult` 是**同步纯函数**，6 步：
1. 意图解析（`resolveIntention`）
2. 攻击检定（`performAttackCheck`）
3. 8 步伤害管线（`runDamagePipeline`，扁平 input）
4. 非致死检查
5. 状态施加判定（暴击≥1.3 必触发，硬编码）
6. StatePatch + 面板生成

**关键缺口**：
- ❌ **无 EventBus**——整个管线零事件触发，无法插 modifier / 救场 / 叙事 hook
- ❌ **无 modifier 收集**——扁平参数直接传 `runDamagePipeline`，装备/buff 没机会声明 modifier
- ❌ **无登神压制**——Step 3 穿透 / Step 7 DR 不比较 divinity
- ❌ **HP 红线不严谨**——`isDead = finalHp <= 0` 有，但没 clamp（AI 输出离谱伤害时 finalHp 可能大负数）
- ❌ **$combat 缺 API**——只有 attack/defend/flee/init/end/getState；缺 useSkill/useItem/block/move/focus（§13 h）

### 1.2 combat-damage.ts 现状（8 步纯函数，有固伤注入缝）

`runDamagePipeline(input)` 是**同步纯函数**，8 步（Step 1-8 + 6a/6b）。input 是扁平参数。**Step 6a 已有 `fixedDamageBonus?` 注入缝**（世界书固伤位），但**没有**全局乘算系数 / DR / 穿透的 modifier 注入缝。

61 个 combat-damage 测试是**纯函数测试**（给定 input 验证 output），不涉及 event。

### 1.3 combat-turn.ts 现状（纯资源管理，无 round 事件）

`rollInitiative` / `consumeAttack` / `consumeAction` / `resetTurnResources` 等纯函数。**无 `combat.round.start` / `combat.round.end` 事件触发**——M3 任务 4.2 要在回合开始/结束 emitChain（驱动 buff tick）。

### 1.4 morale-system.ts 现状（纯函数 checkMorale）

`checkMorale(hpRatio, combatType, d20Roll)` → `MoraleCheckResult`。**无 EventBus**。M3 任务 4.8 要接线：HP<阈值 → emit `combat.morale.check`（代码→AI）→ AI 从结果池挑行为 → emit `combat.morale.result`（AI→代码应用）。

### 1.5 🔴 测试规模（193 个，比计划写的 154 多）

| 文件 | 测试数 | M3 影响 |
|------|--------|---------|
| combat-damage.test.ts | 61 | 🟡 runDamagePipeline 加可选 modifier 字段，不破坏（新字段可选） |
| combat-integration-scenario.test.ts | 39 | 🔴 端到端集成场景，要补管道版对照（legacy 保留不删） |
| combat-intention.test.ts | 30 | 🟢 意图解析不改 |
| combat-turn.test.ts | 24 | 🟢 资源管理不改（round 事件在管道版触发，不改 turn 纯函数） |
| combat-panel.test.ts | 20 | 🟢 面板不改 |
| combat-resolver.test.ts | 19 | 🔴 但 legacy 保留 → 19 测试零改动 |
| **合计** | **193** | legacy 保留策略下，**193 全绿不动**；管道版新增独立测试 |

### 1.6 M1/M2 已就绪的接入基础

- M1 `EventBus.emitChain(type, params, ctx)` + `subscribeChain`——M3 在管道各步骤调它触发 19 event
- M1 `ScriptRegistry`——装备 modifier 声明走它注册到链式管道
- M2 `collectAttackerMods/collectDefenderMods(bus, attack, combatants)`——M3 管道版调它收集 modifier
- M2 `Modifier` 聚合工具（`sumFixedDamage/sumPercentages/collectChecks/collectSpecialMechanisms`）——M3 用它折叠 mods 进管线 input
- M2 `resolveDivinityConflict(atk, def)`——M3 在 Step 3/7 调它算压制率
- M2 `BuffRegistry.tick(effects, phase)`——M3 在 round.start/end emitChain 后调它结算 buff

---

## 2. 设计目标（验收标准）

| # | 目标 | 验收 |
|---|------|------|
| G1 | 管道版 resolveAttackPipeline | async，走完 19 event 的攻击子流程链，返回 CombatActionResult |
| G2 | modifier 注入 8 步管线 | collect 的固伤/百分比/检定/DR/穿透各进对应 step，数值正确 |
| G3 | 登神压制 Step 3/7 | 攻方 divinity 高时，守方防御/DR 被压制率削减 |
| G4 | HP 红线 | HP 扣减 clamp≥0；HP≤0 强制 isDead（AI 离谱输出也兜底） |
| G5 | 19 event 触发 | 攻击子流程的 7 个 event（request/dice.roll/collect×2/hit-miss/damage/result）+ 回合级 + 战意 + 结算都能 emitChain |
| G6 | $combat API 扩展 | useSkill/useItem/block/move/focus 可调 |
| G7 | 战意接线 | HP<阈值触发 morale.check → 应用 morale.result |
| G8 | 结算管线 | combat.end → loot → complete，EXP 计算 |
| G9 | legacy 零破坏 | 193 个现有战斗测试全绿（combat-resolver legacy 保留） |

---

## 3. 核心设计决策

每条给选项、推荐、理由。`✅推荐` 即本 RFC 立场。

### D1：管道化的载体（最关键）

- **✅ 选项 A（推荐）**：新建 `combat-pipeline.ts`（管道版 `resolveAttackPipeline` async），`combat-resolver.ts` **保留为 legacy 不动**。两者并存，M6 稳定后删 legacy。
- 选项 B（不推荐）：原地改 `combat-resolver.ts` 为 async 管道版——破坏 19 个 resolver 测试的同步契约 + 39 个集成场景，且无法回退

**理由**：193 个测试是 M3 最大风险。新建管道版让 legacy 测试零破坏，管道版独立验证。这是计划 §10 风险栏本就建议的「保留 combat-resolver.legacy.ts 并行」。

### D2：async 化的边界

- **✅ 推荐**：管道版全 async（emitChain 是 async）。`resolveAttackPipeline(input, ctx): Promise<CombatActionResult>`。`PipelineContext` 携带 `bus/combatants/readHooks`。legacy `resolveAttack` 保持同步不变。

### D3：modifier 怎么注入 8 步管线

- **✅ 选项 A（推荐）**：给 `runDamagePipeline` 的 `DamagePipelineInput` 加**一个可选** `modifiers?: PipelineModifiers` 字段：
  ```ts
  export interface PipelineModifiers {
    fixedDamageBonus?: number;      // 累加进 Step 6a（与现有 fixedDamageBonus 合并）
    damageMultiplier?: number;      // 百分比类：Step 6 额外 ×(1+sum)
    penetrationRateBonus?: number;  // 穿透类：Step 3 取 max(input, bonus)
    drRateBonus?: number;           // DR 类：Step 7 取 max(input, bonus)
    hitBonus?: number;              // 检定类·命中：进 performAttackCheck
    dodgeBonus?: number;            // 检定类·闪避
  }
  ```
  管道版 `resolveAttackPipeline` collect mods → 用 M2 聚合工具折叠成 `PipelineModifiers` → 传给 `runDamagePipeline`。
- 选项 B：管道版外部手撕 8 步——重复造轮子，不推荐

**为什么 input 加可选字段不破坏 61 个 damage 测试**：新字段全可选，缺省时 `runDamagePipeline` 行为与现在完全一致。61 个测试用旧 input（无 modifiers），零改动。

### D4：19 event 触发点（对齐架构 §6.4）

M3 落地攻击子流程的 7 个核心 event + 回合/战意/结算。**✅ 推荐** 在 `resolveAttackPipeline` 内按以下顺序 emitChain：

```
combat.attack.request (AI→代码)        入口，传攻守/技能/意图/消耗
  ↓
combat.dice.roll (代码→脚本)           攻击检定掷骰，脚本可改骰值（幸运/诅咒）
  ↓
combat.attack.collect_attacker_mods    攻方装备声明 modifier（M2 collectAttackerMods）
  ↓ 【攻击检定 + 评级】
combat.attack.hit / .miss (代码→脚本)  命中分支，挂 buff 在此
  ↓
combat.attack.collect_defender_mods    守方装备声明 modifier（M2 collectDefenderMods）
  ↓ 【8 步管线 + 登神压制 + HP 红线】
combat.attack.damage (代码→AI)         伤害结算完，救场/状态施加
  ↓
combat.attack.result (代码→AI)         完整面板数据
```

回合级（`combat.round.start/end`）、战意级（`morale.check/result`）、结算级（`settle.loot/complete`）、战术动作级（`action.use/flee.request`）、生命周期（`combat.start/end`）——分别在管道版的 `runRound`/`runMoraleCheck`/`runSettlement`/`resolveAction`/`startCombat/endCombat` 里触发。M3 落全部 19 个 event 名（作为常量集中定义，供 M4 Agent / M5 前端复用）。

### D5：登神压制接入（§13 决策 c）

- **✅ 推荐**：管道版在调 `runDamagePipeline` 前，比较攻方装备 divinity（取最高）vs 守方对应效果 divinity，用 `resolveDivinityConflict` 算压制率，折算进 `PipelineModifiers`：
  - Step 3 穿透：`penetrationRateBonus = resolveDivinityConflict(atkDiv, defDiv)`（压制率直接当穿透）
  - Step 7 DR：守方 `drRateBonus = -resolveDivinityConflict(atkDiv, defDiv)`（负值削减守方 DR）
- divinity 取值：攻方取装备/buff 声明中最高 divinity；守方同理。M2 的 Modifier 带 `divinity?`，collect 后取 max。

### D6：HP 扣减 + 生死判定红线（§7.1）

- **✅ 推荐**：管道版在 `combat.attack.damage` 后，**代码强制**：
  ```ts
  const finalHp = Math.max(0, defender.hp - damageBreakdown.finalDamage);  // clamp ≥0
  const isDead = finalHp <= 0;  // HP≤0 强制死亡，不可协商
  ```
  AI 输出再离谱（伤害超 maxHp、负伤害治疗等），clamp 兜底。这是 §13 决策 j（clamp 不卡流程）。

### D7：$combat API 扩展（§13 决策 h）

- **✅ 推荐**：管道版补全 `$combat.useSkill/useItem/block/move/focus`（架构 §13 h 按 #837805 §4 类型）。它们都走 emitChain（`combat.action.use`）+ 生成 patch。block 加「防御姿态」buff（走 M2 buff-registry）；move/focus 调整先攻/位置标签；useSkill/useItem 触发技能/物品效果。

### D8：战意接线（M3 任务 4.8）

- **✅ 推荐**：管道版在 `combat.attack.damage` 后，检查守方 HP%：
  - HP < 阈值 → emitChain `combat.morale.check`（代码→AI，传 hpRatio/combatType/可能结果池）
  - AI 返回选择 → emitChain `combat.morale.result`（AI→代码，应用 outcome 如投降/溃逃）
- 现有 `checkMorale` 纯函数保留（legacy/单测用）；管道版走 event 化版本（AI 介入选结果，而非纯随机）。

### D9：战斗结算管线（M3 任务 4.9）

- **✅ 推荐**：管道版 `runSettlement`：
  ```
  combat.end (AI→代码, 传 winner)
    ↓ EXP 计算（单体 = 目标 Lv×战斗系数，集群衰减；代码）
  combat.settle.loot (代码→AI, 战利品生成 itemThink)
    ↓
  combat.settle.complete (代码→AI, EXP/FP，AI 写摘要)
  ```

### D10：集群系统适配（M3 任务 4.10）

- **✅ 推荐**：管道版检测守方是否集群（cluster-system），若是：属性/资源 ×N（N=集群数量），finalDamage ×1.5（Step 8）。同类判定归 AI（char_gen 只生成 1 个代表），代码做 ×N。

### D11：193 测试迁移策略

- **✅ 推荐**：
  - **legacy 全保留**——193 个测试零改动（combat-resolver/damage/turn/intention/panel/integration 全绿）
  - **管道版新增独立测试**——`combat-pipeline.test.ts`（管道流程）+ 扩展 `combat-integration-scenario.test.ts` 加管道版对照场景（不删 legacy 场景）
  - **M6 删 legacy**——管道版稳定 + 真机验证后，删 combat-resolver.ts legacy + 迁移/删除 legacy 测试

---

## 4. API 草案（combat-pipeline.ts 核心）

```ts
import type { EventBus } from './game-event';
import type { ReadonlyHookSet, CombatState, CombatActionResult, AttackInput } from './types';
import type { Modifier } from './effect-types';

/** 19 event 名常量（集中定义，供 M4 Agent / M5 前端复用） */
export const COMBAT_EVENTS = {
  START: 'combat.start',
  END: 'combat.end',
  ROUND_START: 'combat.round.start',
  ROUND_END: 'combat.round.end',
  TURN_START: 'combat.turn.start',
  TURN_END: 'combat.turn.end',
  ATTACK_REQUEST: 'combat.attack.request',
  DICE_ROLL: 'combat.dice.roll',
  ATTACK_COLLECT_ATK: 'combat.attack.collect_attacker_mods',  // 与 M2 COMBAT_MOD_EVENTS 对齐
  ATTACK_HIT: 'combat.attack.hit',
  ATTACK_MISS: 'combat.attack.miss',
  ATTACK_COLLECT_DEF: 'combat.attack.collect_defender_mods',
  ATTACK_DAMAGE: 'combat.attack.damage',
  ATTACK_RESULT: 'combat.attack.result',
  ACTION_USE: 'combat.action.use',
  FLEE_REQUEST: 'combat.flee.request',
  MORALE_CHECK: 'combat.morale.check',
  MORALE_RESULT: 'combat.morale.result',
  SETTLE_LOOT: 'combat.settle.loot',
  SETTLE_COMPLETE: 'combat.settle.complete',
} as const;

/** 管道上下文（携带 eventBus + 只读查询 + 参战者） */
export interface PipelineContext {
  bus: EventBus;
  combatants: string[];
  readHooks: ReadonlyHookSet;
  /** 当前回合号（round.start/end 用） */
  currentRound?: number;
}

/** async 攻击管道 —— 19 event 的攻击子流程链 */
export async function resolveAttackPipeline(
  input: AttackInput,
  ctx: PipelineContext,
): Promise<CombatActionResult>;

/** 回合管道 —— round.start（buff tick 增益）→ 逐单位行动 → round.end（buff tick 减益） */
export async function runRoundPipeline(
  combat: CombatState,
  ctx: PipelineContext,
): Promise<{ combat: CombatState; logs: CombatRoundLog[] }>;

/** 战意接线 —— HP<阈值触发 morale.check → AI 返回 → morale.result */
export async function runMoraleCheckPipeline(
  defenderId: string,
  ctx: PipelineContext,
): Promise<{ triggered: boolean; outcome?: string }>;

/** 结算管道 —— end → EXP → loot → complete */
export async function runSettlementPipeline(
  combat: CombatState,
  winner: 'ally' | 'enemy' | 'draw',
  ctx: PipelineContext,
): Promise<{ exp: number; patches: StatePatch[] }>;

/** 把 collect 的 mods 折叠成 runDamagePipeline 的 PipelineModifiers + 登神压制 */
export function foldModsToPipelineModifiers(
  attackerMods: Modifier[],
  defenderMods: Modifier[],
): PipelineModifiers;
```

`combat-damage.ts` 侧：`DamagePipelineInput` 加可选 `modifiers?: PipelineModifiers`；`runDamagePipeline` 在 Step 3/6/6a/7 应用 modifier（缺省时行为不变）。

---

## 5. 任务分解（对齐计划 M3 的 4.1–4.10）

| 计划任务 | RFC 落地 | 涉及文件 | 核心 |
|---------|---------|---------|------|
| 4.1 管道化 | D1 | 新增 `combat-pipeline.ts` | resolveAttackPipeline（async），legacy combat-resolver 保留 |
| 4.2 19 event 触发 | D4 | `combat-pipeline.ts` | COMBAT_EVENTS 常量 + 各管道 emitChain |
| 4.3 随机数事件化 | D4 | `combat-pipeline.ts`（dice 事件） | combat.dice.roll emitChain（脚本可改骰值）；dice.ts 纯函数不动 |
| 4.4 modifier 注入 | D3 | `combat-damage.ts` + `combat-pipeline.ts` | DamagePipelineInput +modifiers? + foldModsToPipelineModifiers |
| 4.5 登神 priority 仲裁 | D5 | `combat-pipeline.ts` | foldMods 时调 resolveDivinityConflict 折算穿透/DR |
| 4.6 HP 红线 | D6 | `combat-pipeline.ts` | clamp≥0 + isDead 强制 |
| 4.7 $combat API 扩展 | D7 | `combat-pipeline.ts` | useSkill/useItem/block/move/focus |
| 4.8 战意接线 | D8 | `combat-pipeline.ts` | runMoraleCheckPipeline（morale.check/result emitChain） |
| 4.9 结算管线 | D9 | `combat-pipeline.ts` | runSettlementPipeline（end→EXP→loot→complete） |
| 4.10 集群适配 | D10 | `combat-pipeline.ts` | 守方集群检测 → 属性×N + finalDamage×1.5 |

**实施顺序建议**：4.1（管道骨架）→ 4.4（modifier 注入，接 M2）→ 4.5（登神）→ 4.6（HP 红线）→ 4.2/4.3（19 event + 骰子）→ 4.7（$combat 扩展）→ 4.8（战意）→ 4.9（结算）→ 4.10（集群）。

---

## 6. 兼容策略与影响面

### 6.1 影响面

| 面 | 影响 |
|----|------|
| `combat-resolver.ts`（legacy） | **零改动**（19 测试全绿） |
| `combat-damage.ts` | 加可选 `modifiers?` 字段（61 测试不破坏，缺省行为不变） |
| `combat-turn/intention/panel.ts` | 零改动（纯函数保留，管道版调用它们） |
| `morale-system.ts` / `cluster-system.ts` | 零改动（管道版调用它们的纯函数 + 加 event 层） |
| 193 个战斗测试 | **全绿**（legacy 保留策略） |
| 新增 `combat-pipeline.ts` | 管道版 + 独立测试 |

### 6.2 回退策略

combat-pipeline.ts 是新文件，完全可回退（删它即可回到 legacy）。legacy combat-resolver 全程保留，M6 真机验证后才删。

---

## 7. 测试计划

### 7.1 现有 193 测试全绿（legacy 保留）

### 7.2 M3 新增

| 测试文件 | 覆盖 |
|---------|------|
| 新增 `combat-pipeline.test.ts` | resolveAttackPipeline 全链（19 event 逐一触发断言）；modifier 注入（固伤/百分比/检定/DR/穿透各进对应 step）；登神压制（神位伤无视常规防）；HP 红线 clamp；hit/miss 分支 |
| 扩展 `combat-damage.test.ts` | runDamagePipeline 带 modifiers 字段的几个 case（不影响现有 61 个） |
| 新增管道版集成场景 | runRoundPipeline（round.start 增益 tick / round.end 减益 tick）；runMoraleCheckPipeline（HP<阈值触发）；runSettlementPipeline（EXP） |

### 7.3 验收
```bash
npm run typecheck
npm run test -- --run   # 193 legacy 全绿 + 管道版新增
```

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 管道版 async 破坏调用方同步契约 | 🔴 | D1 新建管道版，legacy 同步保留；调用方（M4 Agent）按需迁移 |
| modifier 注入 runDamagePipeline 破坏 61 个 damage 测试 | 🟡 | D3 新字段全可选，缺省行为不变；扩展测试时加几个带 modifiers 的 case 验证 |
| 19 event 触发顺序错导致管道乱 | 🔴 | COMBAT_EVENTS 常量集中定义；管道版测试逐一断言 event 触发顺序 |
| 登神压制数值映射错（穿透/DR 折算） | 🟡 | D5 用 §13 决策 c 的差值压制表（M2 已实现 resolveDivinityConflict），写表驱动测试 |
| 战意接线 AI 不返回 outcome 导致挂起 | 🟡 | morale.result 缺省走纯函数 checkMorale 兜底（确定性） |
| 集群 ×N 数值膨胀 | 🟢 | cluster-system 已有衰减逻辑，管道版复用 |
| 管道版太复杂难调试 | 🟡 | §13 决策 o（战斗日志 dump 管道参数链）——M3 加 debug 日志钩子 |

---

## 9. 待主人拍板点

带 ✅ 是本 RFC 推荐，主人不否决即按此实施：

| # | 决策点 | 选项 | 推荐 |
|---|--------|------|------|
| Q1 | 管道化载体 | 新建 combat-pipeline + legacy 保留 / 原地改 combat-resolver | ✅ 新建+保留 |
| Q2 | modifier 注入 | runDamagePipeline 加可选 modifiers 字段 / 外部手撕 | ✅ 加可选字段 |
| Q3 | 19 event 集中定义 | COMBAT_EVENTS 常量 / 各处散写字符串 | ✅ 常量集中 |
| Q4 | 登神压制折算 | 压制率当穿透 + 削减 DR / 其他映射 | ✅ 压制率当穿透+削减DR |
| Q5 | HP 红线 | clamp+强制 isDead / 其他 | ✅ clamp+强制 |
| Q6 | 战意 outcome 缺省 | 纯函数 checkMorale 兜底 / 必须等 AI | ✅ 纯函数兜底 |
| Q7 | 集群适配 | 复用 cluster-system 衰减 / 重写 | ✅ 复用 |
| Q8 | legacy 何时删 | M6 真机验证后 / M3 结束就删 | ✅ M6 后删 |
| Q9 | $combat 扩展范围 | 全补(useSkill/Item/block/move/focus) / 仅核心 | ✅ 全补（§13 h） |
| Q10 | 随机数事件化 | combat.dice.roll emitChain（脚本可改骰值）/ 纯函数不改 | ✅ emitChain |
| Q11 | 实施方式 | 主线串行 / agent 并行 | 见 §10 |

---

## 10. 实施方式建议

M3 是最大批次（10 任务），但都围绕 `combat-pipeline.ts` 一个新文件（+ combat-damage 小改）。任务间有强依赖（管道骨架先行，其余在骨架内填充），**不像 M1/M2 那样能拆成独立组并行**。

**方案 A（推荐，稳）**：主线串行 4.1→4.4→4.5→4.6→4.2/4.3→4.7→4.8→4.9→4.10。每步管道骨架扩展 + typecheck + test。M3 风险最高，主线把控最稳。
**方案 B（部分并行）**：主线做完 4.1 骨架 + 4.4 modifier 注入后，派 agent 并行做 4.8（战意，独立子管道）和 4.9（结算，独立子管道）。但 4.2/4.3/4.5/4.6/4.7/4.10 强耦合主流程，仍主线串行。

主人倾向哪种？另外 **Q1–Q10 有没有不同意的**？

---

## 11. 变更记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-07-28 | 初版 RFC：现状审计（193 测试实测 + combat-resolver 同步无 event）+ 11 决策 + 管道版 API 草案 + legacy 并行策略 | Claude（RFC）|
| 2026-07-28 | M3 实施完成：Q1-Q10 全按推荐；方案 C（主线核心管道 + 4 agent 并行周边）；10 任务交付 ~80 tests，全量 3544/3546 零回归；legacy 193 测试全保留 | Claude（实施）|
