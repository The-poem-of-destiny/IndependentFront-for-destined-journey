# 战斗 Agent ↔ 引擎 接口规格（Combat Agent API Contract）

> 📌 **文档定位**：M4 的**共同真源**。Combat Agent 的 systemPrompt、工具注册（`agent-tools.ts`）、item_gen 增强、schema 校验，全部以本文件为依据。
>
> 📖 **读者**：① 写 `combat` Agent systemPrompt 的人 ② 注册 combat 工具的代码 ③ 增强 item_gen 输出契约的代码 ④ 写 schema 校验的代码。
>
> 🔗 **关联**：
> - [`combat-system-architecture.md`](./combat-system-architecture.md) — 战斗中央架构（管道/事件/计算分工/数值），本文件是其「AI 接口面」的下钻
> - [`2026-07-28-combat-system-v2-plan.md`](../planning/2026-07-28-combat-system-v2-plan.md) §5 M4 任务清单（5.1–5.8 编号即本文件交叉引用）
> - [`agent_system_prompt_guide.md`](./agent_system_prompt_guide.md) — Agent systemPrompt 通用配置流程
>
> ⚠️ **铁律**（贯穿全文）：
> 1. **AI 永不产 id** —— 名字是逻辑键（规范铁律 1）。角色/物品/技能/buff 全按名字寻址。
> 2. **AI 不直接动 HP** —— HP 扣减、生死判定是代码红线（架构 §7.1）。
> 3. **数值字段强制、叙事自由**（§13 决策 k）。

---

## 0. 现状对齐（哪些已实现、哪些 M4 要建）

| 层 | 模块 | 状态 | 说明 |
|----|------|------|------|
| 类型 | `types.ts` Combat/Intention/HitRating/StatusEffect/StatePatch | ✅ M1-M2 | 字段见 §4 |
| 管道 | `combat-pipeline.ts` resolveAttackPipeline / runRoundPipeline / COMBAT_EVENTS(19) | ✅ M3 | async，§3 |
| 战术动作 | `combat-actions-pipeline.ts` useSkill/Item/block/move/focus | ✅ M3 | §2.1 |
| 状态 | `status-api.ts` applyStatusIntents/removeStatusIntents | ✅ M2 | §2.2 |
| Modifier | `effect-types.ts` 6 大类 + resolveDivinityConflict | ✅ M2 | §6.1 |
| Buff | `buff-registry.ts` applyBuff/removeBuff/tickBuffs | ✅ M2 | §6.3 |
| 战意 | `combat-morale-pipeline.ts` + `morale-system.ts` | ✅ M3 | §3/§5 |
| 结算 | `combat-settlement-pipeline.ts` runSettlementPipeline | ✅ M3 | §3/§5 |
| legacy | `combat-resolver.ts` $combat 同步聚合 | ✅ 保留 | M6 删，管道版优先 |
| **工具注册** | `agent-tools.ts` combat function schema | ❌ **M4 建** | §2（零 combat 工具） |
| **Agent 配置** | `data/defaults/agent-config.json` combat | ❌ **M4 建** | §5/§8（任务 5.1） |
| **工具白名单** | `AGENT_TOOL_MAP['combat']` | ❌ **M4 建** | §7（任务 5.3） |
| **orchestrator 接入** | combat_trigger → Combat Agent 独立循环 | ❌ **M4 建** | §8（任务 5.2/5.7） |
| **item_gen 增强** | 战斗物品输出契约 + schema 校验 | ❌ **M4 建** | §6（任务 5.4/5.5） |

> ℹ️ 底层计算管线（M1-M3）已全部就绪且经测试覆盖，M4 是**纯接入层**：把已实现的函数包成 AI 可调的 function schema + 写 Agent prompt + 接进编排器。

---

## 1. 计算分工速记（AI 能做什么、不能做什么）

### 1.1 代码红线（AI 不可触碰，违反即 clamp 兜底）

| 红线 | 由谁保证 | 代码位置 |
|------|---------|---------|
| HP 扣减 | `resolveAttackPipeline` 内 `clampHp(≥0)` | combat-pipeline.ts |
| 生死判定 | `HP ≤ 0 → isDead=true`（不可协商） | combat-pipeline.ts |
| 骰子生成 | `$dice.*` / `combat.dice.roll` event 后取最终值 | dice.ts / combat-pipeline.ts |
| 攻击检定 | `performAttackCheck`（优劣势+闪避+评级） | combat-damage.ts |
| 8 步伤害管线 | `runDamagePipeline`（含 modifier 注入） | combat-damage.ts |
| 先攻排序 | `rollInitiative` + sort | combat-turn.ts |
| EXP 计算 | `runSettlementPipeline`（Lv×战斗系数×集群衰减） | combat-settlement-pipeline.ts |
| buff 去重/层数 | `applyBuff`（同源刷新+增层/异源独立） | buff-registry.ts |
| buff 结算时机 | `tickBuffs`（增益 round.start / 减益 round.end） | buff-registry.ts |

### 1.2 AI 创造性职责（代码不插手）

- **意图解析**：自然语言 → 意图层级（§5.2 / `parseIntentionFromInput`）
- **战术动作决策**：格挡/移动/道具/专注/技能（调 §2.1 函数）
- **范围目标选取**：圈定打哪几个单位
- **集群判定**：「≥3 同类低级单位」——同类由 AI 判；判定后只生成 1 个代表
- **战意结果选择**：从结果池挑投降/溃逃/嘴炮…（§3 event 16/17）
- **FP 奖励**：根据「表现」创造性评估（§3 event 19）
- **战利品生成**：itemThink（§3 event 18）
- **登神等级判定**：生成效果时按叙事判 divinity（§6.2）
- **战斗叙事 + 摘要**：HP% 对应伤势描写；结算摘要 ≤500 字（§5.4）

---

## 2. AI 可调函数表（function schema）

> 🔧 **命名约定**：OpenAI function calling 的 `name` 用**扁平下划线**（对齐现有 `roll_d20`/`craft_check` 风格），内部映射到 `$combat.*` 语义级 namespace（ADR-19）。
>
> 📌 **底层走管道版**（async `resolveAttackPipeline` 等），不走 legacy 同步版。M4 注册工具时在 `executeToolCall` 里分发到管道函数。

### 2.1 战斗控制类（`combat_*`）

#### `combat_start` — 开战（任务 5.1/5.2）
```
参数:
  combatType:   enum['切磋','竞技','压制','死斗','标准','守卫']  (必)
  allies:       string[]    我方角色名列表（按名寻址，铁律1）  (必)
  enemies:      string[]    敌方角色名列表                       (必)
  environment:  string      战斗环境描述                         (必)
  d20Rolls:     integer[]   各单位先攻 d20（按 allies+enemies 顺序）(必)
返回: CombatState 摘要（combatId / round=1 / turnOrder 先攻排序 / 各方 HP）
底层: $combat.initCombat → CombatState
时机: 战斗面板唤起后第一步
红线: 先攻排序代码做，AI 只提供 d20
```

#### `combat_attack` — 执行单次攻击（核心）
```
参数:
  attackerId:      string   攻击者角色名                  (必)
  defenderId:      string   目标角色名                    (必)
  intentionInput:  string   用户原始输入（意图解析用，如"砍向要害"）(可选，缺省='常规')
  damageType:      enum['物理','能量','精神','真实']        (可选，缺省='物理')
  skillName:       string   技能名（用技能时填）           (可选)
  skillPower:      integer  技能威力                       (可选)
  weaponName:      string   武器名                         (可选)
  multiHitCount:   integer  多段攻击次数（可选，缺省1）
  nonLethal:       boolean  非致死标记                     (可选)
  costs:           object{hp?,mp?,sp?}  技能消耗           (可选)
  d20Attack:       integer  攻击检定 d20                   (必) ← 先调 roll_d20 拿
  d20Intention:    integer  意图对抗 d20（需对抗的层级用） (可选)
返回: CombatActionResult（§4.1 完整字段）
底层: resolveAttackPipeline(input, ctx) —— 走 19 event 攻击链
时机: 每次攻击行动；返回值含 rating/damage/finalHp/isDead/patches
红线: HP 扣减/生死由代码结算；AI 只读结果做叙事
```
> ⚠️ `d20Attack` 必须先调 `roll_d20` 取真实骰值，**禁止 AI 编造骰值**（对齐现有工具纪律）。

#### `combat_use_skill` — 使用技能（非攻击型）
```
参数: characterId(string,必), skillName(string,必)
返回: { success, patches, description }
底层: resolveUseSkill —— emit combat.action.use（M3 简化：技能效果由技能定义驱动）
```

#### `combat_use_item` — 使用道具
```
参数: characterId(string,必), itemName(string,必)
返回: { success, patches, description }
底层: resolveUseItem —— 生成 remove_item patch（按名消耗，铁律1）
```

#### `combat_block` — 格挡（本回合防御+50%/闪避+3）
```
参数: characterId(string,必)
返回: { success, patches, description }
底层: resolveBlock —— 上「防御姿态」buff
```

#### `combat_move` — 战术移动
```
参数: characterId(string,必)
返回: { success, patches, description }
底层: resolveMove —— 仅 emit combat.action.use（§13 m：节点式 location 无坐标，位置变更归 Story 叙事）
```

#### `combat_focus` — 专注（下次攻击命中+5）
```
参数: characterId(string,必)
返回: { success, patches, description }
底层: resolveFocus —— 上「专注」buff
```

#### `combat_flee` — 逃跑检定
```
参数: characterId(string,必), d20Roll(integer,必) ← 先调 roll_d20
返回: { success, description, patches }
底层: resolveFlee —— 敏捷+d20 vs DC(15+敌方平均层级×2)；成功仅结算不位移（§13 m）
```

#### `combat_end` — 结束战斗 + 结算
```
参数:
  winner:  enum['ally','enemy','draw']  (必)
返回: SettlementResult（§4.3：exp / fp? / patches / summary）
底层: runSettlementPipeline —— combat.end → EXP → settle.loot → settle.complete
时机: 判定胜负后；EXP/FP/战利品/摘要在此生成
红线: EXP 公式代码算（Lv×战斗系数×集群衰减），FP/摘要 AI 写
```

### 2.2 状态类（`status_*`）

#### `status_apply` — 施加 buff（自动走 id 去重）
```
参数:
  target:    string   目标角色名                    (必)
  name:      string   buff 名（如"流血"）            (必)
  category:  enum['增益','减益','特殊']              (必)
  sourceKey: string   来源前缀（物品/技能名，buff id=`sourceKey.name`）(必，环境 buff 才允许裸名)
  stacks:    integer  层数（可选，缺省1）
  duration:  integer  持续回合（战斗型有效，可选）
  lifecycle: enum['战斗','持续','触发','条件']       (可选)
  divinity:  integer  登神等级 0-8（可选，神位级 buff 才填）
  effects:   object   数值化效果 {defense:0.5, dodge:3, ...}（可选）
返回: { action:'added'|'refreshed'|'stacked', buffId, patches }
底层: applyStatusIntents → applyBuff（同源刷新+增层 / 异源独立，§6.3）
红线: buff id 去重代码做；AI 只声明 buff 描述
```

#### `status_remove` — 移除 buff
```
参数:
  target:       string  目标角色名                        (必)
  buffIdOrName: string  完整 buffId（"剑.流血"）或裸 name (必)
返回: { removed: string[], patches }
底层: removeStatusIntents → removeBuff（裸 name 移除所有同名）
```

#### `status_query` — 查询角色 buff
```
参数:
  target:        string  角色名                          (必)
  buffIdOrName:  string  查指定 buff（可选，缺省返回全部）
返回: StatusEffect[] 或 { has:boolean, stacks:integer }
底层: ReadonlyHookSet.getStatusEffects / hasStatus / getBuffStacks
红线: 只读
```

### 2.3 骰子类（`$dice.*`，复用现有 3 个，无需新建）

| 工具 | 用途 | 战斗场景 |
|------|------|---------|
| `roll_d20` | d20 + 加值/优劣势 | 攻击检定、意图对抗、逃跑、战意低阈值检定 |
| `roll_d100` | d100 | 百分比概率判定 |
| `roll_dice` | 任意公式（2d6/3d8+2） | 伤害随机、属性随机 |

> 纪律：所有需要骰值的 combat 动作，**先调 roll_** 取真实值再传入，禁止编造。

### 2.4 只读查询类（`$resource.*` / `$char.*`，复用现有 + 新增战斗专用）

| 工具 | 现有 | 战斗用途 |
|------|------|---------|
| `get_character` | ✅ | 查参战者属性/装备 |
| `get_hp_percent` | ✅ | 战意阈值判断（HP<阈值触发） |
| `get_inventory` | ✅ | 查可用道具/装备 |
| `get_combat_state` | ❌ **M4 新建** | 当前战斗快照（回合/行动轴/各方 HP）—— 底层 `$combat.getState` |

---

## 3. 19 Event 的 AI 角色

> 19 event 名见 `COMBAT_EVENTS`（combat-pipeline.ts）。AI 只需关注**方向涉及 AI** 的；纯代码↔脚本 event（round/turn/dice/collect_mods）AI 不直接处理，由物品/buff 脚本订阅。

| # | event | 方向 | AI 角色 | payload 关键字段 |
|---|-------|------|--------|-----------------|
| 1 | `combat.start` | AI→代码 | AI 调 `combat_start` 发起 | combatType / allies / enemies / environment |
| 2 | `combat.end` | AI→代码 | AI 调 `combat_end` 结束 | winner |
| 3 | `combat.round.start` | 代码→脚本 | （AI 不直接处理）buff 增益结算 | round / combatType |
| 4 | `combat.round.end` | 代码→脚本 | （AI 不直接处理）buff 减益/DoT tick | round / combatType |
| 5 | `combat.turn.start` | 代码→脚本 | （AI 不直接处理） | characterId |
| 6 | `combat.turn.end` | 代码→脚本 | （AI 不直接处理） | characterId |
| 7 | `combat.attack.request` | AI→代码 | AI 调 `combat_attack` 触发 | attackerId / defenderId / intentionKeywords / nonLethal |
| 8 | `combat.dice.roll` | 代码→脚本 | （AI 不直接处理）脚本可改骰值（幸运/诅咒） | dice[] / sides / purpose |
| 9 | `combat.attack.collect_attacker_mods` | 代码→脚本 | （AI 不直接处理）攻方装备声明 modifier | attackerId / defenderId / damageType |
| 10 | `combat.attack.hit` / `.miss` | 代码→脚本 | （AI 不直接处理）挂 buff 类脚本在此触发 | rating / checkValue |
| 11 | `combat.attack.collect_defender_mods` | 代码→脚本 | （AI 不直接处理）守方装备声明 modifier | 同 9 |
| 12 | `combat.attack.damage` | 代码→AI | **AI 消费**：救场/濒死保护/状态施加决策点 | damage / finalHp / isDead / breakdown |
| 13 | `combat.attack.result` | 代码→AI | **AI 消费**：完整面板 → 生成战斗叙事 | finalHp / isDead / moraleOutcome / rating |
| 14 | `combat.action.use` | AI→代码 | AI 调 block/move/focus/useSkill/useItem 触发 | characterId / action |
| 15 | `combat.flee.request` | AI→代码 | AI 调 `combat_flee` 触发 | characterId / d20Roll |
| 16 | `combat.morale.check` | 代码→AI | **AI 消费**：从结果池挑行为覆盖纯函数兜底 | hpRatio / combatType / baseState / outcomePool / outcome |
| 17 | `combat.morale.result` | AI→代码 | AI 选定 outcome 后应用 | defenderId / moraleState / outcome / triggered |
| 18 | `combat.settle.loot` | 代码→AI | **AI 消费**：生成战利品（itemThink） | winner / exp / defeatedEnemies / loot[] |
| 19 | `combat.settle.complete` | 代码→AI | **AI 消费**：写 FP + 结算摘要 | winner / exp / loot / fp / summary |

> 🔑 **AI 消费的 6 个 event**（12/13/16/18/19 + 间接 17）：这些是代码把数值结果喂给 AI、AI 产出创造性内容的对接点。Combat Agent 的多轮循环就是围绕这些 event 组织的（§5）。

---

## 4. 引擎→AI 数据包（AI 收到什么）

### 4.1 `CombatActionResult`（`combat_attack` 返回 / event 13 面板）
```ts
{
  request: CombatActionRequest,      // 原请求回显（attacker/defender/action/skill/damageType/costs...）
  intention: IntentionResult,        // 意图判定（§4.2）
  attackRoll: {                      // 攻击检定
    diceUsed, advantage, disadvantage,
    diceRolls: number[],             // 实际骰值序列
    dodgeNegated: boolean,           // 闪避是否失效（高阶压低阶/失去行动/动摇+自动成功）
    dodgeNegatedReason?,
    hitBonus, dodgeBonus,
    checkValue: number,              // 检定总值 = d20+命中-闪避
    rating: HitRating,               // 评级（level/coefficient/minCheckValue/triggersStatus）
  },
  damage: CombatDamageBreakdown,     // 8 步分解（§4.3）
  finalHp: number,                   // 结算后目标 HP（已 clamp≥0）
  maxHp: number,
  isDead: boolean,                   // HP≤0 强制（红线）
  isNarrativeAlive: boolean,         // = !isDead
  statusApplied: Array<{name, duration, effect}>,  // 本次触发的状态
  patches: StatePatch[],             // 引擎要落库的变更（HP扣减/消耗/状态）
  panelLines: string[],              // 面板文本行（M5 前端组件化渲染替代）
  description: string,               // 人类可读一句话
}
```

### 4.2 `IntentionResult`（意图判定）
```ts
{
  level: IntentionLevel,             // 非致死/常规/战术/机能/核心/抹杀/概念/处决
  verdict: '无需判定'|'成功'|'失败'|'自动成功'|'强制无效',
  contested?: {                       // 需对抗层级才有（战术/机能/核心/抹杀/概念）
    attackerFormula, attackerValue,  // (攻方层级×5 + d20)
    defenderFormula, defenderValue,  // (守方层级×5 + d20 + 意图难度)
  },
  coefficient: number,               // 生效伤害系数（1.0~1.6）
  extraEffects: string[],            // 成功时额外状态
  narrativeNote: string,
}
```
**意图层级系数表**（`INTENTION_CONFIGS`）：

| 层级 | 难度 | 系数 | 需对抗 |
|------|------|------|--------|
| 非致死 | 0 | 1.0 | ❌ |
| 常规 | 0 | 1.0 | ❌ |
| 战术 | 3 | 1.2 | ✅ |
| 机能 | 5 | 1.05 | ✅ |
| 核心 | 10 | 1.2 | ✅ |
| 抹杀 | 15 | 1.4 | ✅ |
| 概念 | 20 | 1.6 | ✅ |
| 处决 | 0 | 1.3 | ❌（动摇/崩溃目标自动成功） |

### 4.3 `CombatDamageBreakdown`（8 步伤害管线）
```ts
{
  initialDamage,          // Step1: 关联属性×10×层级系数 + 技能威力 + 武器攻击力
  initialFormula,         // 公式文本
  afterMultiSplit,        // Step2: 多段分割后
  penetration: { originalDef, penetrationRate, effectiveDef },  // Step3: 穿透
  equipmentReduction, afterEquipmentReduction,  // Step4: 装备减免 ÷(def+2000)
  typeReductionRate, typeReductionAmount, afterTypeReduction,  // Step5: 类型减免
  ratingCoefficient, intentionCoefficient, afterRating,        // Step6: ×评级×意图（百分比 modifier 注入此）
  // Step6a: + 固伤（固伤 modifier 注入此，字段内联在 afterRating→finalDamage）
  drRate, drReduction, afterDr,        // Step7: DR 修正
  finalDamage,                         // Step8: 最终（集群×1.5 在管道外层单独乘）
}
```
> 📥 **modifier 注入点**：检定类→检定前 / 百分比类→Step6 乘算 / 固伤类→Step6a / 特殊(DR/穿透)→Step3/7 / 登神压制→Step3+7 冲突仲裁。

### 4.4 `SettlementResult`（`combat_end` 返回 / event 19）
```ts
{
  exp: number,           // 代码算：Σ(败方单位 Lv × 战斗系数(tier) × 集群衰减)，整数
  fp?: number,           // AI 写：创造性评估（event 19）
  patches: StatePatch[], // EXP/FP/战利品落库 patch
  summary?: string,      // AI 写：结算摘要（≤500 字，回注 Story）
}
```
**集群 EXP 衰减**：≥3 合并目标，单位贡献 `max(0.5, 1-(n-3)×0.1)`。

### 4.5 战意结果池（`MORALE_OUTCOME_POOL`，event 16 AI 从中挑）

| MoraleState | 标签 | 结果池（AI 从中选 outcome） |
|-------------|------|---------------------------|
| `steady` | 坚定 | []（不触发） |
| `shaken` | 动摇 | 继续战斗但动作犹豫 / 表现出恐惧但未撤退 |
| `wavering` | 战意动摇 | 投降 / 认输 / 求饶 / 撤退 / 中止战斗 |
| `routing` | 崩溃 | 溃逃 / 阵线溃散 / 被击昏 / 被俘虏 / 内讧 / 投降 / 求饶 |

**战意阈值**（`COMBAT_TYPE_MORALE_THRESHOLDS`）：切磋40% / 竞技30% / 压制50% / 死斗10% / 标准30% / 守卫35%。
- 高阈值类型（切磋/竞技/压制）：HP<阈值 **自动**触发
- 低阈值类型（死斗/标准/守卫）：HP<阈值 且 **d20<12** 才触发

**战意状态修正**（`getMoraleModifiers`）：shaken 攻击骰-2；wavering 攻击骰-4/闪避无效/无法攻击/可被处决；routing 无法行动/可被处决。

---

## 5. 战斗轮次协议（四步流程 + 回合循环）

> 对齐架构 §11（四步流程）+ §6.2（回合循环）。这是 Combat Agent systemPrompt 的骨架。

### 步 1 · 初始化
- **AI 收到**：`<combat_trigger>` 标记（来自 Story/vars_update）+ 正文上文 + request_dispatcher 指令
- **AI 产出**：判定参战人数 / 敌我阵营 / 战斗类型 / 集群判定（≥3 同类）
- **AI 调用**：先 `roll_d20`（×N 拿先攻）→ `combat_start(combatType, allies, enemies, environment, d20Rolls)`
- **结果**：拿到 CombatState（含先攻排序的行动轴）

### 步 2 · 回合控制（循环）
每个回合：
1. **round.start**（代码结算增益 buff，AI 不直接处理）
2. **按行动轴逐单位**：
   - **敌人单位** → AI 控制：思考技能/攻击 → `roll_d20` → `combat_attack` / `combat_use_skill` / 战术动作
   - **我方单位** → 用户输入：AI 理解用户意图 → 调对应函数
   - 每单位 **1 攻击 + 1 动作**（硬约束，代码 `consumeAttack`/`consumeAction`）
   - HP<阈值时 event 16 触发 → AI 从结果池挑 outcome（event 17）
3. **round.end**（代码结算减益/DoT，AI 不直接处理）
- **AI 每次攻击后**：消费 `CombatActionResult`（event 13）→ 生成战斗叙事（HP% 对应伤势）
- **救场点**：event 12（damage）AI 可决策濒死保护/状态施加

### 步 3 · 判输赢（智能判断，AI 主导）
- 死斗 → 一方 HP≤0（代码 isDead）
- 切磋/竞技 → 认输 / 打晕 / 嘴炮（AI 创造性判断）
- 压制/守卫 → 击退 / 投降 / 撤退
- 战意崩溃（routing）→ 可处决 / 被俘虏

### 步 4 · 结算 + 摘要
- **AI 调用**：`combat_end(winner)`
- **底层**：`runSettlementPipeline` → event 18（AI 生成战利品）→ event 19（AI 写 FP + 摘要）
- **AI 产出**：结算摘要 ≤500 字
- **回注**：摘要作为**用户消息**注入 Story Agent → 正文流恢复（架构 §12）

### 轮次内的 AI 多轮调用
- 每个单位行动 = 一次 Agent 调用（思考 + 工具调用 + 叙事）
- ⚠️ **token/缓存风险**（计划 §10 中风险 7）：每回合多次调用，注意 prompt cache 命中（固定 systemPrompt + 战斗上下文增量）

---

## 6. item_gen 战斗物品输出契约（任务 5.4/5.5）

> item_gen 生成装备/技能/道具时，战斗相关效果必须符合本契约。schema 校验（任务 5.5）对着本节查，不合规打回。

### 6.1 modifier 6 大类格式（`effect-types.ts`）

所有 modifier 必归 6 类之一。每类进管线位置不同（架构 §4.1）。

| 类别 | 进管线 | 关键字段 | JSON 示例 |
|------|--------|---------|----------|
| **固伤** | Step 6a | `amount`, `damageType?` | `{"category":"固伤","source":"幽怨之剑","amount":200,"damageType":"物理"}` |
| **百分比** | Step 6 | `coefficient`, `target` | `{"category":"百分比","source":"狂战戒指","coefficient":0.2,"target":"damage"}` |
| **资源** | 直接结算 | `resource`, `amount` | `{"category":"资源","source":"血瓶","resource":"hp","amount":500}` |
| **检定** | 检定阶段 | `checkType`, `bonus`, `attribute?` | `{"category":"检定","source":"准星护符","checkType":"命中","bonus":5}` |
| **附加效果** | 转 buff | `buffName`, `sourceKey`, `stacks?`, `duration?`, `lifecycle?` | `{"category":"附加效果","source":"毒刃","buffName":"流血","sourceKey":"毒刃","stacks":1,"duration":3,"lifecycle":"战斗"}` |
| **特殊机制** | 各管线位 | `mechanism`, `value` | `{"category":"特殊机制","source":"破甲锤","mechanism":"穿透","value":20}` |

**通用基础字段**（`ModifierBase`）：
- `category`: EffectCategory（必，判别字段）
- `source`: 声明来源（物品/技能名，调试溯源 + 装备级 divinity 继承标识）（必）
- `divinity?`: 登神等级 0-8（继承所属装备，缺省=0）（§6.2）
- `condition?`: 触发条件（EJS 风格，如 `"{{target.hpPercent}} < 0.5"`）

**检定类 `checkType` 枚举**：`命中`/`闪避`/`先攻`/`抵抗`/`属性`（`属性` 时填 `attribute`: str/dex/con/int/spi）。
**特殊类 `mechanism` 枚举**：`DR`/`穿透`/`暴击倍率`/`召唤`/`光环`/`规则改写`。

> 🔴 **铁律**（#265160）：严禁直接增减五维，五维相关效果只能写为「检定」类（checkType='属性'）。

### 6.2 divinity 字段（登神等级，整件装备一个）

- **挂整件装备**，不挂单个 modifier（§13 决策 d）。装备的 divinity 由其所有 modifier 继承。
- 9 级（`DivinityLevel`）：0普通 / 1微弱要素 / 2完整要素 / 3微弱权能 / 4完整权能 / 5微弱法则 / 6完整法则 / 7神位 / 8神国
- **冲突仲裁**（`resolveDivinityConflict`，差值压制表）：攻方 divinity 高于守方时，差1级→压制20%，差2→40%，差3→60%，差4→80%，差≥5→100%（完全无视防御/DR）。
- **AI 职责**：生成效果时按叙事判定该装备的 divinity（大部分装备=0，神位级装备才填）。
- **冲突场景**（才比 divinity）：攻vs守 / 施加vs抵抗 / 互斥同类效果。非冲突场景（独立伤害叠加/同源刷新）不比。

### 6.3 buff 契约（`StatusEffect` + `buff-registry.ts`）

**buff id 规则**（`buffIdOf`）：`sourceKey ? "${sourceKey}.${name}" : name`
- 有来源（物品/技能 buff）→ `"幽怨之剑.流血"`（sourceKey 必填）
- 无来源（系统/环境 buff）→ 裸名 `"暴雨"`（**仅代码预置环境效果允许裸名**，AI 生成的 buff 必须带 sourceKey）

**6+ 字段**（`StatusEffect`）：
```
name          必  简练标识符（中毒/灼烧/流血）
description   必  中文描述
category      必  '增益'|'减益'|'特殊'
stacks        必  层数（默认1）
remainingTime 必  剩余时间（null=永久）
timeUnit      必  '回合'|'分钟'|'小时'
source        必  "[分类]-[施加者];[解除方式]"
effects       必  数值化 {defense:0.5, dodge:3, ...}
sourceKey     选  buff id 前缀（物品/技能名）—— AI 生成 buff 必填
lifecycle     选  '战斗'|'持续'|'触发'|'条件'（缺省按 timeUnit 推导）
divinity      选  登神等级（神位级 buff 才填）
maxStacks?    选  最大层数（undefined=无上限）
stackable?    选  是否可叠层（默认 true）
```

**去重规则**（`applyBuff`，代码自动）：
- 同 (owner, buffId) = 同实例 → 刷新 remainingTime（取 max）+ stacks += new（受 maxStacks）
- 不同 buffId = 异源独立共存
- AI 无需关心去重，只声明 buff 描述。

**结算时机**（`tickBuffs`，代码自动）：增益在 round.start / 减益·特殊在 round.end。
**生命周期**：战斗型随回合递减；持续/触发/条件型不递减。

### 6.4 脚本契约结构（声明式，`script-registry.ts`）

复杂动态效果（非纯数值）走脚本，每条是完整订阅契约：
```ts
{
  event: "attack.before" | "combat.dice.roll" | "combat.attack.hit" | ...,  // 订阅哪个 event
  source: "幽怨之剑",       // 静态身份（物品/技能名，永远不变）
  owner: null,              // 动态持有人（装备时填，在场过滤用）
  handler: "(ctx, params) => { ... }",  // 函数体（读 params，返回 params）
  condition: null,          // 触发条件（可选）
  priority: 0               // 链内顺序（可选）
}
```
- `source` vs `owner` 必须区分：source=静态身份证，owner=动态持有人。
- 套娃深度：战斗场景 ≤5（防递归爆炸）。
- AI 写脚本时用 `$resource`/`$char`/`$status`/`$event` 等 $ API（查 `get_script_reference` 工具）。

### 6.5 效果转化表（AI 创造性 → 代码可算，#265160）

| 不可计算概念 | 转化为 |
|-------------|--------|
| CD / 冷却 | X 次/战斗 |
| 施法速度 / 吟唱 / 攻速 | 先攻检定修正(+N) → 检定类 |
| 距离 / 射程 / 位移 | 标签"范围:X"(目标数) 或 状态"无法行动N回合" |
| 移动速度 | 先攻/逃跑检定修正(+N) → 检定类 |
| 范围面积(半径X米) | 标签"范围:X"(目标数) |
| X% 概率触发 | d20 ≥ 阈值 |
| 暴击率/闪避率/命中率 | 对应检定修正(±N) → 检定类 |
| 元素抗性(火抗/冰抗) | 伤害类型减免% 或 DR% → 特殊类 |
| 仇恨 / 嘲讽 | 控制状态"标记N回合" → 附加效果类 |
| 耐久 / 弹药 | "X次/战斗" 或消耗品 |

### 6.6 校验规则（任务 5.5，违规打回）

item_gen 输出解析时（`char-gen-agent.ts` / `craft-gen-chain.ts`）校验：
1. 每个 modifier 的 `category` ∈ 6 类之一
2. **非**检定类不得直接改五维数值（五维修正只能走检定类 `checkType='属性'` + `bonus`，#265160 铁律。校验函数已落地：`combat-item-validator.ts`）
3. AI 生成的 buff 必须带 `sourceKey`（裸名仅环境 buff）
4. `divinity` ∈ 0-8 整数
5. 脚本契约结构完整（event/source/handler 必填）
6. 不可计算概念已按转化表翻译

---

## 7. 工具白名单建议（`AGENT_TOOL_MAP['combat']`，任务 5.3）

```ts
combat: [
  // 战斗控制
  'combat_start', 'combat_attack', 'combat_use_skill', 'combat_use_item',
  'combat_block', 'combat_move', 'combat_focus', 'combat_flee', 'combat_end',
  // 状态
  'status_apply', 'status_remove', 'status_query',
  // 骰子（复用）
  'roll_d20', 'roll_d100', 'roll_dice',
  // 只读查询（复用 + 新建）
  'get_character', 'get_hp_percent', 'get_inventory', 'get_combat_state',
],
```

> 现有 4 个 agent 白名单（craft_gen/char_gen/item_gen/vars_update）不动，仅新增 combat。

---

## 8. orchestrator 接入点（任务 5.2/5.7）

```
Story / vars_update 输出 <combat_trigger>
  ↓ marker-protocol 扫描
  ↓ orchestrator onCombatTrigger（现有，复用）
  ↓ 等当前轮角色/记忆/物品生成都完成
  ↓ 唤起 Combat Agent（独立战斗循环，不走主 DAG）
  ↓ 正文流暂停，战斗面板滑入（M5）
  ↓
[四步流程循环，§5]
  ↓
combat_end → 摘要 ≤500 字
  ↓ 摘要作为用户消息注入 Story Agent
  ↓ 正文流恢复
```

**关键设计**：
- Combat Agent 是**独立循环**（每回合/每单位一次调用），不在主编排 DAG 内（对齐架构 §6.1 / 计划 5.2）。
- `combat_trigger` 路由复用现有 `onCombatTrigger`（计划 5.7）。
- `combat_summary` Agent（现有）并入 Combat Agent 第 4 步，或保留独立（计划 5.8，M4 决策点）。

---

## 9. M4 实施检查清单

- [x] **5.1** ✅ `data/defaults/agent-config.json` 新增 `combat` Agent（systemPrompt 四步流程 + 函数调用规则 + 摘要规则，3636 字）
- [x] **5.2** ✅ `combat-runner.ts` 新建跨回合循环 + `agent-tools.ts` executeCombatToolCall 独立通道（B 方案，不入主 DAG）
- [x] **5.3** ✅ `agent-tools.ts` 注册 §2 全部 13 工具 + `AGENT_TOOL_MAP['combat']`（§7）
- [x] **5.4** ✅ `agent-config.json` item_gen systemPrompt 增强 §6 契约 + `<modifiers>` 输出标签
- [x] **5.5** ✅ `combat-item-validator.ts` 校验纯函数（5.5a）+ `char-gen-agent.ts`/`craft-gen-chain.ts` 解析链路接入 + 校验（5.5b）
- [x] **5.6** ✅ `game-pipeline.ts` handleCombatTrigger 摘要以【战斗摘要】前缀注入对话流，Story 下一轮自然接续
- [x] **5.7** ✅ `game-pipeline.ts` onCombatTrigger stub → handleCombatTrigger → runCombat
- [x] **5.8** ✅ combat 摘要由 combat-runner 第 4 步生成（解析 `<combat_summary>`）；旧 `combat_summary` Agent 保留在 agent-config 不删（兼容历史引用），但 combat-runner 不依赖它
- [x] 全量测试 `npm test` 通过（3675/3676，唯一失败 SelectableCard 是预存 CSS 变量 flaky，与 M4 无关）
- [x] CLAUDE.md 文档导航加本文 + M4 进度更新

> **M4 核心完成（2026-07-29）**：combat 全链路接通（trigger → combat-runner 跨回合循环 → executeCombatToolCall → 管道函数 → patches 落库 → 摘要回注）。
> 🔴 **待真机验证（M6）**：combat-runner 单元测试 mock 了 LLM，真实 combat agent 行为（调工具顺序/叙事/判输赢）需真机验证。

---

## 变更记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-07-29 | 初版：基于 M1-M3 已实现代码（combat-pipeline/actions/status-api/effect-types/buff-registry/morale/settlement + types.ts）提炼 AI 接口规格，作为 M4 共同真源 | Claude（整理）|
| 2026-07-29 | §6.6 #2 措辞修正（非检定类不得改五维）+ §9 检查清单全部 ✅（M4 全 8 任务完成，待 M6 真机验证） | Claude（M4 收尾）|
