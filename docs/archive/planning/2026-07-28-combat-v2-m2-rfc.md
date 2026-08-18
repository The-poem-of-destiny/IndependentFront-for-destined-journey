# 战斗 v2 — M2 效果与 Buff 系统 RFC

> 📅 **日期**：2026-07-28
> 📌 **状态**：RFC（待主人拍板，拍板后方可动代码）
> 🔗 **上游**：[`combat-system-architecture.md`](../../reference/combat-system-architecture.md)（v2 §四 效果系统 / §五 Buff 系统 / §十三 决策 c/d）、[`2026-07-28-combat-system-v2-plan.md`](./2026-07-28-combat-system-v2-plan.md)（M2 任务 3.1–3.10）、[`2026-07-28-combat-v2-m1-rfc.md`](./2026-07-28-combat-v2-m1-rfc.md)（M1 已交付 emitChain/subscribeChain）
> ⚠️ **原则**：M2 是「效果类型系统 + Buff 去重 + 结算时机」的落地。本 RFC 的核心立场是**尽量新增模块、StatusEffect 只加可选字段**，把计划里「StatusEffect 重构」的高风险降级为「StatusEffect 小补丁 + 新增周边模块」。

---

## 0. 摘要

M2 交付 4 块新能力 + 1 处小补丁：

1. **6 大类 modifier 类型系统**（新建 `effect-types.ts`，独立于 StatusEffect）
2. **登神 divinity 9 级 + 冲突仲裁**（差值压制表，对齐 §13 决策 c）
3. **collect_mods 机制**（用 M1 的 `emitChain` 收集攻/守方 modifier，新建 `modifier-collector.ts`）
4. **Buff 去重 + 生命周期 + 结算时机 + `$status` API**（新建 `buff-registry.ts` / `status-api.ts`）
5. **StatusEffect 小补丁**（加 `sourceKey?` / `lifecycle?` / `divinity?` 三个可选字段，不改现有字段）

**一句话结论**：现状 `StatusEffect` 已对齐世界书 6 字段，M2 **不重构结构**、只加可选字段 + 新建周边模块。真正接入战斗管线（modifier 分发到 8 步）是 M3 的事，M2 做到「modifier 可收集可分类 + buff 可去重可结算 + `$status` 可调用」即止。

---

## 1. 现状审计（RFC 的地基）

### 1.1 StatusEffect 现状（已成熟，非重构对象）

```ts
// types.ts:673
export interface StatusEffect {
  id?: string; // @deprecated（M2 起引擎不读写，旧存档兼容）
  name: string; // ✅ 对齐 [状态规则]「效果名称」
  description: string;
  category: '增益' | '减益' | '特殊'; // ✅ 对齐「类型」
  stacks: number; // ✅ 对齐「层数」(+ maxStacks?/stackable?)
  remainingTime: number | null; // ✅ 对齐「剩余时间」
  timeUnit: '回合' | '分钟' | '小时'; // ✅
  source: string; // ⚠️ 现状是复合字符串「[分类]-[施加者];[解除方式]」
  effects: Record<string, number>; // ✅ 对齐「效果」
  effectDescriptions?: Record<string, string>;
  scripts?: Record<string, string>; // ✅ 脚本池
  onApply?: string; // ✅ 4 钩子
  onTick?: string;
  onRemove?: string;
  onTrigger?: string;
}
```

**结论**：6 字段已对齐，4 钩子已就位，scripts 池已有。M2 **不需要动现有字段**，只需补 3 个可选字段（§3 D11）。

### 1.2 combat-damage 现状（扁平 input，无 modifier 收集）

`runDamagePipeline(input: DamagePipelineInput)` 是**纯函数**，input 是扁平参数（`relevantAttribute` / `skillPower` / `weaponAtk` / `penetrationRate` / `drRate` / `fixedDamageBonus` 等）。Step 6a 有 `fixedDamageBonus` 注入点（世界书固伤位），但**没有 modifier 收集机制**——所有参数由调用方直接传入。

**含义**：M2 的 collect_mods 产出 modifier 列表后，**怎么注入 runDamagePipeline 是 M3 的事**（M3 任务 4.4）。M2 只做到「collect + classify」，不碰 runDamagePipeline 签名。

### 1.3 🔑 引用面比计划预期小（决定性发现）

全仓 `StatusEffect` 引用：**68 处 / 16 文件**。

| 文件                                                                                  | 引用数 | 性质                                      |
| ------------------------------------------------------------------------------------- | ------ | ----------------------------------------- |
| state-manager.ts                                                                      | 11     | 🔴 核心（唯一写入入口）                   |
| script-executor.ts                                                                    | 9      | 🔴 核心（$status.add/remove 沙盒）        |
| effect-runtime.ts                                                                     | 5      | 🔴 核心（add/remove_status_effect patch） |
| types.ts                                                                              | 7      | 定义本身                                  |
| 其余（agent-orchestrator / char-gen-agent / combat-resolver / validate / game-event） | 各 1-2 | 轻度引用                                  |
| **craft-quality / craft-resolver / morale-system / affection-system**                 | **0**  | ✅ **不碰 StatusEffect！**                |

**对 M2 的含义**：计划 §3 风险栏写的「StatusEffect 重构会影响 craft/morale/affection」**与代码现状不符**——这三个模块根本不引用 StatusEffect 类型（morale 有自己的状态机、affection 管好感度数值、craft 管品质链）。M2 真正要保绿的是 **state-manager / script-executor / effect-runtime** 三个核心 + 它们的测试（约 20 处引用）。

### 1.4 世界书权威（架构文档已整理，无需啃原文）

- **#265160 [品质效果限定]**（chara_card.json:9497）：6 大类 / 登神 9 级 / 转化表 / 冲突仲裁 → 架构 §四 已完整摘录
- **[状态规则]**（chara_card.json:16586）：buff 6 字段 / 去重 / 4 生命周期 / 结算时机 / 状态交互 → 架构 §五 已完整摘录

本 RFC 以架构文档 §四/§五为权威，不再回世界书原文逐条对（M1 RFC 经验：架构文档是可靠的二次来源）。

### 1.5 M1 已交付的复用基础

- `EventBus.emitChain(type, params, ctx)` —— M2 的 collect_mods / round 结算直接用它
- `ScriptRegistry.registerDeclaration` —— 装备 modifier 声明注册到链式管道
- `ReadonlyHookSet` —— $status.query 读角色状态
- `subscribeChain` 的 `priority/order/owner/condition` —— modifier 排序与在场过滤

---

## 2. 设计目标（验收标准）

| #   | 目标                    | 验收                                                                          |
| --- | ----------------------- | ----------------------------------------------------------------------------- |
| G1  | modifier 6 大类类型系统 | 各类有 TS 接口；`classifyModifier(m)` 返回正确 category                       |
| G2  | 登神 divinity 冲突仲裁  | `resolveDivinityConflict(a,b)` 按 §13 决策 c 差值压制表返回压制率             |
| G3  | collect_mods 机制       | `collectAttackerMods` / `collectDefenderMods` 用 emitChain 收到 N 个 modifier |
| G4  | buff id 去重            | 同源（同 id）刷新时间+增层；异源（不同 id）共存；(owner,id) 唯一              |
| G5  | buff 4 生命周期         | 战斗型随回合递减；持续型不递减；触发型/条件型正确移除                         |
| G6  | 结算时机                | 增益在 round.start tick、减益在 round.end tick（emitChain 驱动）              |
| G7  | `$status` API           | apply/remove/query 可调；apply 自动走 buff-registry 去重                      |
| G8  | StatusEffect 兼容       | 现有 ~20 处核心引用零改动；旧 StatusEffect（无新字段）仍正常工作              |

---

## 3. 核心设计决策

每条给选项、推荐、理由。`✅推荐` 即本 RFC 立场。

### D1：modifier 类型系统的载体

- **✅ 选项 A**：新建 `effect-types.ts`，定义 `EffectCategory` 枚举 + 6 个分类接口 + `Modifier` 联合类型。**独立于 StatusEffect / EffectDefinition**
- 选项 B：扩展 `EffectDefinition`（Phase 4.5 的声明式效果），给它加 modifier 分类

**理由**：EffectDefinition 是「Agent 输出的结构化效果声明」（vars_patch/status_effect/...），语义是「执行什么操作」；modifier 是「装备/buff 声明的管线修正」（固伤/百分比/检定/...），语义是「怎么改管线参数」。两者正交，混在一起会让 EffectDefinition 的 switch 分支爆炸。新建独立类型系统更清晰，且不破坏 effect-runtime。

### D2：登神 divinity 的粒度（对齐 §13 决策 c/d）

- §13 决策 d 已定：**divinity 挂整件装备**（不挂单个 modifier）
- **✅ 推荐**：modifier 带可选 `divinity?: DivinityLevel` 字段（继承所属装备的 divinity）；裸 modifier（无 divinity）视为 `普通(0)`。`DivinityLevel` 是 9 级枚举（普通/微弱要素/.../神国）。`resolveDivinityConflict(attackerDiv, defenderDiv)` 按 §13 决策 c 差值压制表返回「压制率」（差1级→20%→差≥5级→100%）。

**注**：M2 只提供 divinity 类型 + 仲裁函数。真正在管线 Step 3/7 应用压制率是 M3（任务 4.5）。

### D3：collect_mods 机制（复用 M1 emitChain）

- **✅ 推荐**：用 M1 的 `emitChain`，事件名 `combat.attack.collect_attacker_mods` / `combat.attack.collect_defender_mods`。新建 `modifier-collector.ts` 封装：
  ```ts
  collectAttackerMods(bus, ctx): Promise<Modifier[]>  // emitChain，handler 往 params.mods[] push
  collectDefenderMods(bus, ctx): Promise<Modifier[]>
  ```
- params 结构：`{ mods: Modifier[], attack: { attackerId, defenderId, skillId, ... } }`。handler 读 attack 上下文，往 mods push 自己声明的 modifier。

**为什么不新造机制**：M1 的 emitChain 已具备链式传递 + 在场过滤 + priority 排序 + 错误隔离，正是 collect_mods 需要的。复用即「装备声明 modifier」=「subscribeChain 注册一个往 mods push 的 handler」。

### D4：modifier 分发到管线步骤（M2 边界）

- 架构 §4.4：固伤→Step6a / 百分比→Step6 / 检定→检定阶段 / 特殊→DR穿透 / 附加效果→buff / 资源→直接结算
- **✅ 推荐**：M2 只提供 `classifyModifier(m): EffectCategory` 工具函数 + 各 category 的聚合器（`sumFixedDamage(mods)` / `productPercentages(mods)` / `collectChecks(mods)` 等）。**不接入 runDamagePipeline**（那是 M3 任务 4.4）。M2 的验收止于「collect 到的 mods 能被正确分类聚合」。

### D5：StatusEffect 结构改动范围（关键降风险决策）

- **✅ 选项 A（推荐）**：**不改任何现有字段**，只加 3 个可选字段：
  ```ts
  StatusEffect {
    ... (现有全保留)
    /** 🆕 M2: buff id 前缀 —— 施加该 buff 的物品/技能名（"幽怨之剑"）。缺省=裸名 buff */
    sourceKey?: string;
    /** 🆕 M2: 生命周期类型（对齐 [状态规则] 4 种）。缺省=按 timeUnit 推导（回合→战斗型） */
    lifecycle?: '战斗' | '持续' | '触发' | '条件';
    /** 🆕 M2: 登神等级（大部分 buff 无，仅神位级 buff 带）。缺省=普通(0) */
    divinity?: DivinityLevel;
  }
  ```
- 选项 B（不推荐）：重构 source 字段拆成结构化子字段 —— 破坏 68 处引用

**理由**：选项 A 让现有引用零改动（新字段全可选、缺省时按现状推导），把「重构」降级为「补丁」。`source` 复合字符串保持原样（它承载「[分类]-[施加者];[解除方式]」用于驱散/豁免展示），buff id 前缀用独立的 `sourceKey`（语义清晰、不耦合）。

### D6：buff id 构造与去重（对齐架构 §5.2）

- **✅ 推荐**：buff id = `sourceKey ? \`${sourceKey}.${name}\` : name`。实例 = `(ownerCharId, buffId)`。新建 `buff-registry.ts`：
  ```ts
  class BuffRegistry {
    apply(
      ownerCharId: string,
      effect: StatusEffect,
    ): { action: 'added' | 'refreshed' | 'stacked'; instance: BuffInstance };
    remove(ownerCharId: string, buffId: string): void;
    query(ownerCharId: string, filter?): StatusEffect[];
    tick(ownerCharId, phase: 'round.start' | 'round.end'): StatusEffect[]; // 返回到期的
  }
  ```
- **去重规则**：同 `(owner, id)` = 同实例 → 刷新 remainingTime + stacks+=新 stacks（受 maxStacks 上限）；不同 id = 独立实例共存。

### D7：buff 4 生命周期（对齐架构 §5.3）

- **✅ 推荐**：`lifecycle` 字段决定 tick 行为：
  - `战斗`：round.end 时 remainingTime-- （timeUnit 必须为 '回合'）
  - `持续`：不随回合递减（永久/直至解除）
  - `触发`：onTrigger 触发后移除（由脚本控制，tick 不动）
  - `条件`：condition 不满足时移除（由脚本/外部检查，tick 不动）
- 缺省推导：`lifecycle` 未给时，`timeUnit==='回合'` → `战斗`；`remainingTime===null` → `持续`；否则 → `战斗`。

### D8：结算时机（对齐架构 §5.4）

- **✅ 推荐**：增益在 `combat.round.start` tick、减益/DoT 在 `combat.round.end` tick。M2 落 `BuffRegistry.tick(charId, phase)` 方法；M3 在 combat-turn 的 round.start/round.end 处 emitChain 调它。M2 的验收用单元测试直接调 tick。

### D9：layer vs stacks

- **✅ 推荐**：`stacks` 是 StatusEffect 的**持久字段**（落 DB），`layers` 是 handler 运行时的**瞬时参数**（不落 DB）。apply 时 handler 的 params.layers 初始化为 stacks。架构不规定 layers 语义（由 buff 类型决定：DoT 每层+X / 增益等级 / ...）。M2 不强制 layers，只在 `$status.apply` 时把 stacks 透传给 handler.ctx。

### D10：`$status` API（对齐 §13 决策 + ADR-21）

- **✅ 推荐**：新建 `status-api.ts`，暴露给 AI 脚本沙盒（扩展 ScriptSandbox）：
  ```ts
  $status.apply(target, buffDef): { action, instance }   // 走 buff-registry 去重 → state-manager patch
  $status.remove(target, buffIdOrName): void
  $status.query(target, filter?): StatusEffect[]
  $status.has(target, buffIdOrName): boolean
  $status.getStacks(target, buffIdOrName): number
  ```
- **落地路径**：`$status.apply` → BuffRegistry.apply（去重决定 added/refreshed/stacked）→ 生成 `add_status_effect` / `update_status_effect` patch → state-manager.commitChatState（遵循 ADR-21 唯一写入入口）。**不直接改 character.statusEffects**。

### D11：buff-registry 与 SubscriptionManager 的关系

- **✅ 推荐**：**两者独立**。
  - `BuffRegistry`：管 buff **实例**（owner×id 去重、层数、到期 tick）——数据层
  - `SubscriptionManager`：管 buff 的**脚本订阅**（$event.on 持久订阅、onTick/onApply 执行）——执行层
- buff 的 onApply/onTick 脚本仍走 SubscriptionManager/script-executor；buff 的实例去重走 BuffRegistry。apply 时两者协同：先 BuffRegistry 决定实例结果，再（若 added）注册脚本订阅。

---

## 4. API 草案（TypeScript）

### 4.1 effect-types.ts（modifier 6 大类）

```ts
export enum EffectCategory {
  FixedDamage = '固伤',
  Percentage = '百分比',
  Resource = '资源',
  Check = '检定',
  AdditionalEffect = '附加效果',
  SpecialMechanism = '特殊机制',
}

export enum DivinityLevel {
  普通 = 0,
  微弱要素 = 1,
  完整要素 = 2,
  微弱权能 = 3,
  完整权能 = 4,
  微弱法则 = 5,
  完整法则 = 6,
  神位 = 7,
  神国 = 8,
}

/** 基础 modifier 形状（所有类别共享） */
export interface ModifierBase {
  category: EffectCategory;
  source: string; // 声明来源（物品/技能名）
  divinity?: DivinityLevel;
  condition?: string; // 可选触发条件（EJS 风格）
}

export interface FixedDamageModifier extends ModifierBase {
  category: EffectCategory.FixedDamage;
  amount: number;
  damageType?: DamageType;
}
export interface PercentageModifier extends ModifierBase {
  category: EffectCategory.Percentage;
  /** 增伤 +0.2 = +20%；减伤 -0.2 */
  coefficient: number;
  target: 'damage' | 'heal' | 'resource';
}
export interface ResourceModifier extends ModifierBase {
  category: EffectCategory.Resource;
  resource: 'hp' | 'mp' | 'sp';
  amount: number; // 正=恢复，负=消耗
}
export interface CheckModifier extends ModifierBase {
  category: EffectCategory.Check;
  checkType: '命中' | '闪避' | '先攻' | '抵抗' | '属性';
  attribute?: AttributeName; // checkType='属性' 时给
  bonus: number;
}
export interface AdditionalEffectModifier extends ModifierBase {
  category: EffectCategory.AdditionalEffect;
  buffName: string;
  sourceKey: string; // buff id 前缀
  stacks?: number;
  duration?: number; // 回合
  lifecycle?: '战斗' | '持续' | '触发' | '条件';
}
export interface SpecialMechanismModifier extends ModifierBase {
  category: EffectCategory.SpecialMechanism;
  mechanism: 'DR' | '穿透' | '暴击倍率' | '召唤' | '光环' | '规则改写';
  value: number;
}

export type Modifier =
  | FixedDamageModifier
  | PercentageModifier
  | ResourceModifier
  | CheckModifier
  | AdditionalEffectModifier
  | SpecialMechanismModifier;

/** §13 决策 c 差值压制表：差1级→20% → 差≥5级→100% */
export function resolveDivinityConflict(atk: DivinityLevel, def: DivinityLevel): number;

/** 分类聚合工具 */
export function classifyModifier(m: Modifier): EffectCategory;
export function sumFixedDamage(mods: Modifier[]): { amount: number; type: DamageType };
export function productPercentages(mods: Modifier[]): number;
export function collectChecks(mods: Modifier[]): CheckModifier[];
```

### 4.2 modifier-collector.ts（collect_mods，复用 emitChain）

```ts
export interface CollectModsParams {
  mods: Modifier[];
  attack: {
    attackerId: string;
    defenderId: string;
    skillId?: string;
    weaponName?: string;
    damageType?: DamageType;
  };
}

/** 收集攻方装备/技能/buff 声明的 modifier（走 emitChain combat.attack.collect_attacker_mods） */
export function collectAttackerMods(
  bus: EventBus,
  attack: CollectModsParams['attack'],
  combatants: string[],
): Promise<Modifier[]>;
/** 收集守方装备/技能/buff 声明的 modifier（走 emitChain combat.attack.collect_defender_mods） */
export function collectDefenderMods(
  bus: EventBus,
  attack: CollectModsParams['attack'],
  combatants: string[],
): Promise<Modifier[]>;
```

### 4.3 buff-registry.ts（去重 + 生命周期 + tick）

```ts
export interface BuffInstance {
  ownerCharId: string;
  buffId: string; // `${sourceKey}.${name}` 或 `name`
  effect: StatusEffect;
  appliedAt: number; // 回合号
}

export class BuffRegistry {
  apply(
    ownerCharId: string,
    effect: StatusEffect,
  ): {
    action: 'added' | 'refreshed' | 'stacked';
    instance: BuffInstance;
  };
  remove(ownerCharId: string, buffIdOrName: string): boolean;
  query(ownerCharId: string, filter?: (e: StatusEffect) => boolean): StatusEffect[];
  has(ownerCharId: string, buffIdOrName: string): boolean;
  getStacks(ownerCharId: string, buffIdOrName: string): number;
  /** 按 phase 结算：战斗型回合递减 + 到期移除 */
  tick(
    ownerCharId: string,
    phase: 'round.start' | 'round.end',
    currentRound: number,
  ): StatusEffect[];
  /** 构造 buff id */
  static buffIdOf(effect: StatusEffect): string;
}
```

### 4.4 status-api.ts（$status 给 AI 脚本）

```ts
/** 注入沙盒的 $status API（扩展 ScriptSandbox） */
export interface StatusApi {
  apply(
    target: string,
    buffDef: Partial<StatusEffect> & { name: string; category: StatusEffect['category'] },
  ): { action: string; instance: BuffInstance };
  remove(target: string, buffIdOrName: string): boolean;
  query(target: string, filter?: (e: StatusEffect) => boolean): StatusEffect[];
  has(target: string, buffIdOrName: string): boolean;
  getStacks(target: string, buffIdOrName: string): number;
}

/** 工厂：用 BuffRegistry + readHooks 构造 $status */
export function createStatusApi(registry: BuffRegistry): StatusApi;
```

---

## 5. 任务分解（对齐计划 M2 的 3.1–3.10）

| 计划任务            | RFC 落地 | 涉及文件                                              | 核心改动                                              |
| ------------------- | -------- | ----------------------------------------------------- | ----------------------------------------------------- |
| 3.1 modifier 6 大类 | D1       | 新增 `effect-types.ts`                                | EffectCategory + 6 接口 + Modifier 联合               |
| 3.2 登神 divinity   | D2       | `effect-types.ts`                                     | DivinityLevel + resolveDivinityConflict（差值压制表） |
| 3.3 collect_mods    | D3       | 新增 `modifier-collector.ts`                          | collectAttackerMods/collectDefenderMods（emitChain）  |
| 3.4 modifier 分发   | D4       | `effect-types.ts`                                     | classifyModifier + 聚合工具（不接管线，M3 再接）      |
| 3.5 buff 6 字段     | D5       | `types.ts` StatusEffect +3 可选字段                   | sourceKey?/lifecycle?/divinity?                       |
| 3.6 buff id 去重    | D6       | 新增 `buff-registry.ts`                               | apply/remove/query + 同源刷新+增层                    |
| 3.7 buff 4 生命周期 | D7       | `buff-registry.ts`                                    | tick 按 lifecycle 决定递减/不移                       |
| 3.8 结算时机        | D8       | `buff-registry.ts`                                    | tick(charId, phase) 区分 round.start/end              |
| 3.9 layer 自由参数  | D9       | `status-api.ts`                                       | apply 时 layers=stacks 透传 handler                   |
| 3.10 `$status` API  | D10      | 新增 `status-api.ts` + 扩展 `script-executor.ts` 沙盒 | apply/remove/query/has/getStacks                      |

**实施顺序建议**：3.1→3.2→3.5（类型基础）→ 3.6→3.7→3.8（buff-registry）→ 3.10→3.9（$status）→ 3.3→3.4（modifier collect，依赖 emitChain 已就绪）。

---

## 6. 兼容策略与影响面

### 6.1 影响面（基于 §1.3 实测）

| 面                         | 影响                                                          |
| -------------------------- | ------------------------------------------------------------- |
| StatusEffect 现有字段      | **零改动**（D5 只加可选字段）                                 |
| state-manager.ts (11 处)   | 零（add/update_status_effect patch 已存在，M2 复用）          |
| script-executor.ts (9 处)  | 小改（沙盒增 `$status` namespace，复用 M1 的 readHooks 模式） |
| effect-runtime.ts (5 处)   | 零（add/remove_status_effect patch 不变）                     |
| craft / morale / affection | **零**（不引用 StatusEffect）                                 |
| 现有测试                   | StatusEffect 相关 ~20 处断言全绿（新字段可选，旧数据正常）    |

### 6.2 兼容保证

- ✅ 现有 `StatusEffect` 字段全部保留，新字段（sourceKey/lifecycle/divinity）全可选
- ✅ 缺省 `lifecycle` 按 timeUnit 推导（回合→战斗型），旧 buff 行为不变
- ✅ `$status.add`（旧 API）保留；新增 `$status.apply`（走 buff-registry 去重）。两者并存：add 是「直接加」（不去重，旧语义），apply 是「智能加」（去重）
- ✅ `source` 复合字符串不动，buff id 用独立 sourceKey
- ✅ runDamagePipeline 签名不动（M2 不接入管线）

### 6.3 回退策略

M2 全是新增模块（effect-types / modifier-collector / buff-registry / status-api）+ types.ts 加 3 可选字段 + script-executor 沙盒加 $status。可按模块独立回退。

---

## 7. 测试计划

### 7.1 现有测试回归（必须全绿）

- `state-manager.test.ts` / `script-executor.test.ts` / `effect-runtime.test.ts` / `validate.test.ts` / `resource-calc.test.ts` 等含 StatusEffect 断言的

### 7.2 M2 新增测试

| 测试文件                          | 覆盖                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| 新增 `effect-types.test.ts`       | 6 大类 classify；divinity 差值压制表（差1→20%/差5→100%）；聚合工具                                 |
| 新增 `modifier-collector.test.ts` | 注册 3 个装备声明 → collectAttackerMods 收到 3 modifier；在场过滤；priority 排序                   |
| 新增 `buff-registry.test.ts`      | 同源刷新+增层；异源共存；(owner,id) 唯一；4 生命周期 tick；round.start/end 区分；sourceKey 前缀 id |
| 新增 `status-api.test.ts`         | apply 走去重；remove/query/has/getStacks；$status 注入沙盒后可调                                   |
| `script-executor.test.ts` 扩展    | 沙盒 `$status.apply` 可调（mock BuffRegistry）                                                     |

### 7.3 验收命令

```bash
npm run typecheck
npm run test -- --run
```

---

## 8. 风险与对策

| 风险                                                                        | 等级 | 对策                                                                                                 |
| --------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| StatusEffect 加字段破坏旧存档反序列化                                       | 🟡   | 三字段全可选，JSON 反序列化缺字段 = undefined = 按缺省推导，旧存档安全                               |
| buff id 的 sourceKey 与现有 source 字段语义混淆                             | 🟡   | RFC 明确：source=展示用复合串，sourceKey=buff id 前缀（物品/技能名）。文档 + 注释双保险              |
| `$status.apply` 与 `$status.add` 双 API 心智负担                            | 🟡   | apply=智能（去重，推荐 AI 用），add=直接（兼容旧脚本）。item_gen systemPrompt 引导 AI 用 apply（M4） |
| collect_mods 的事件名拼写错导致 M3 接不上                                   | 🟢   | M2 定义 `CombatModEvent` 常量（`combat.attack.collect_attacker_mods` 等），M3 import 复用            |
| BuffRegistry 与 SubscriptionManager 协同顺序错（apply 时脚本未注册/已注册） | 🟡   | D11 明确：先 BuffRegistry.apply 决定实例，再（added 时）注册脚本订阅；refreshed/stacked 时不重注册   |
| divinity 差值压制表数值记错                                                 | 🟢   | 对齐 §13 决策 c 原文（差1级20%递增），写表驱动测试钉死                                               |

---

## 9. 待主人拍板点

带 ✅ 是本 RFC 推荐，主人不否决即按此实施：

| #   | 决策点                              | 选项                                      | 推荐                   |
| --- | ----------------------------------- | ----------------------------------------- | ---------------------- |
| Q1  | modifier 类型载体                   | 新建 effect-types / 扩展 EffectDefinition | ✅ 新建                |
| Q2  | divinity 粒度                       | 挂装备(modifier继承) / 挂单 modifier      | ✅ 挂装备（§13 d）     |
| Q3  | buff id 前缀来源                    | 新增 sourceKey 字段 / 从 source 解析      | ✅ 新增字段            |
| Q4  | lifecycle 表达                      | 新增 lifecycle 字段 / 从 timeUnit 推导    | ✅ 新增字段 + 缺省推导 |
| Q5  | `$status.apply` 去重路径            | 走 state-manager patch / 直接改 character | ✅ 走 patch（ADR-21）  |
| Q6  | collect_mods 机制                   | 复用 emitChain / 新造                     | ✅ 复用 emitChain      |
| Q7  | StatusEffect 现有字段               | 不动 / 重构 source                        | ✅ 不动                |
| Q8  | BuffRegistry vs SubscriptionManager | 独立 / 合并                               | ✅ 独立                |
| Q9  | M2 是否接入 runDamagePipeline       | 接 / 不接（留给 M3）                      | ✅ 不接                |
| Q10 | `$status.add`（旧）去留             | 保留并存 / 删除                           | ✅ 保留并存            |
| Q11 | 实施方式                            | 主线串行 / agent 并行                     | 见 §10                 |

---

## 10. 实施方式建议

M2 的 10 个任务可分 3 组，组内有依赖、组间较独立：

- **组 A（类型基础）**：3.1 effect-types + 3.2 divinity + 3.5 StatusEffect 加字段 —— 串行，类型先行
- **组 B（buff 引擎）**：3.6 buff-registry + 3.7 生命周期 + 3.8 结算时机 + 3.10 $status + 3.9 layer —— 依赖组 A，内部串行
- **组 C（modifier collect）**：3.3 collect_mods + 3.4 分发工具 —— 依赖组 A（类型），和组 B 独立

**方案 A（稳）**：主线串行 A→B→C。类型基础必须先稳，buff 引擎和 modifier collect 都依赖它。
**方案 B（快，用 agent）**：主线做完组 A 后，派两个 agent 并行做组 B（buff-registry 全家桶）和组 C（modifier-collector）。文件不重叠（buff-registry.ts/status-api.ts vs modifier-collector.ts/effect-types 扩展）。

主人倾向哪种？另外 **Q1–Q10 有没有不同意的**？如无异议本喵按推荐立场实施。

---

## 11. 变更记录

| 日期       | 变更                                                                                                                                    | 作者           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 2026-07-28 | 初版 RFC：现状审计（StatusEffect 已成熟 + craft/morale/affection 不在引用面）+ 11 决策 + API 草案 + 把「重构」降级为「小补丁+新增模块」 | Claude（RFC）  |
| 2026-07-28 | M2 实施完成：Q1-Q10 全按推荐；10 任务交付，五件套 ~140 tests，全量 3465/3466 零回归；StatusEffect 仅加 3 可选字段（D5=A），未重构       | Claude（实施） |
