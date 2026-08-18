# 战斗 v2 — M1 事件管道基础设施 RFC

> 📅 **日期**：2026-07-28
> 📌 **状态**：RFC（待主人拍板，拍板后方可动代码）
> 🔗 **上游**：[`combat-system-architecture.md`](../../reference/combat-system-architecture.md)（v2 架构 §二/§三/§六）、[`2026-07-28-combat-system-v2-plan.md`](./2026-07-28-combat-system-v2-plan.md)（M1 任务 1.1–1.6）
> ⚠️ **原则**：这是 🔴 高风险改造，计划明确要求「先 RFC 再动代码」。本 RFC 的目标是把所有设计取舍讲清楚、把 API 钉死、把影响面摸透，主人拍板后实施阶段照着写即可，不再临场决策。

---

## 0. 摘要

M1 要把现有 **fan-out 广播式 EventBus** 升级为能支撑战斗管道的 **fan-in 链式事件总线**，并落地声明式脚本注册。交付 6 件东西：

1. `EventBus.emitChain()` —— 链式返回值（前一个 handler 的输出 = 后一个的输入）
2. 在场过滤（订阅者 owner 不在参战者列表则跳过）
3. `script-registry.ts` —— 声明式注册 facade（`{event, source, owner, handler, condition, priority}`）
4. 套娃深度按场景收紧（战斗 ≤5，非战斗保留 ≤10）
5. ctx 只读 API 最小集（脚本可读 HP/属性，不可写）
6. 旧 `$event.on/off` + `publish/subscribe` 向后兼容层

**一句话结论**：因为生产代码零调用 EventBus（见 §1.3），兼容负担极低，本 RFC 推荐**并存式改造**——旧 API 原样保留、新能力以新方法叠加，不破坏现有 78 个相关测试。

---

## 1. 现状审计（RFC 的地基）

### 1.1 EventBus（`game-event.ts`）—— 纯 fan-out

| 维度     | 现状                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 发布模型 | `publish(event)` 广播给所有订阅者，**handler 无返回值**（`void \| Promise<void>`）      |
| 订阅 API | `subscribe(type, handler)` / `subscribeAll(handler)` / `subscribeWhen(filter, handler)` |
| 返回值   | 三者都返回 unsubscribe 函数                                                             |
| 去重     | handler 用 `Set` 去重（同函数引用重复订阅只触发一次）                                   |
| 错误隔离 | 每个 handler 独立 try/catch，单个抛错不阻塞其他                                         |
| async    | handler 顺序 await（非并发）                                                            |
| 历史     | `history: GameEvent[]`，`maxHistory` 默认 500                                           |
| 实例化   | 按 SaveSlot，`busRegistry` + `getEventBus(saveId)`                                      |

**关键缺口**：handler 之间**无法传递数据**。publish 是「通知」，不是「变换」。战斗管道需要的是「初始伤害 → 戒指1 改 → 戒指2 改 → … → 最终伤害」的链式变换，现有模型做不到。

### 1.2 SubscriptionManager + ScriptExecutor —— 已有持久订阅骨架

- `SubscriptionManager.register(ownerKey, eventType, scriptKey, codeResolver, baseCtx)`
  - `ownerKey` = `{charId}:{objectType}:{objectId}`（如 `char_1:item:荆棘甲`）
  - 幂等：同 `eventType+scriptKey` 跳过
  - 套娃：`handleEvent` 里处理脚本内的 `$event.on/off`
  - 递归深度：`maxRecursionDepth=10`（per-manager 计数器）
- `ScriptExecutor`：`new Function()` 沙盒，`$event.on/off/emit` 收集到 `ScriptEffects.{subscriptions,unsubscriptions,events}`
- **已知坑**（RFC 须正视）：
  - `$resource.getHp/getMaxHp` 是**桩**（返回 0），注释写「调用方负责处理」—— 这是 M1 任务 1.5 要修的
  - `$event.emit` 收集到 `effects.events` 后，`handleEvent` 对它的处理是**空注释**（没有 re-emit 到 EventBus）—— 瞬时事件实际未通

### 1.3 🔑 生产代码零调用（决定性发现）

对 `getEventBus | new SubscriptionManager | new EventBus( | .publish( | emitChain` 全仓 grep，**仅命中 3 个文件**：

```
src/sillytavern/game-event.ts          ← 定义本身
src/sillytavern/game-event.test.ts     ← 测试
src/sillytavern/subscription-manager.test.ts  ← 测试
```

**没有任何生产模块调用 EventBus。** `game-event.ts` 自身注释也印证：「EventBus 引入时机: Phase 6c（按需）— 当前用声明式验证覆盖度」。Phase 6a 战斗系统走了 `combat-damage.ts` 纯函数路线，没接事件总线。

**对 M1 的含义**：

- ✅ 兼容负担几乎为零——没有生产调用方会被破坏
- ✅ 可以大胆设计 `emitChain`，不必为「不破坏某处生产逻辑」束手束脚
- ✅ 唯一必须保持绿的是 **78 个测试**（game-event ~40 + subscription-manager ~8 + script-executor ~30）
- ⚠️ 但这也意味着 M1 交付的是「**未通电的基础设施**」——真正发光要等 M3 把 combat-resolver 接上来。M1 的验收只能靠单元测试，不能靠端到端。

### 1.4 两套效果系统并存（RFC 须厘清）

项目里有**两套并行的"效果"系统**，M1 不能制造第三套：

| 系统                                     | 文件                                             | 定位                       | 数据形态                                       | M1 关系                                                   |
| ---------------------------------------- | ------------------------------------------------ | -------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| **EffectRuntime**                        | `effect-runtime.ts`                              | Phase 4.5 声明式效果执行器 | `EffectDefinition[]`（结构化）→ `StatePatch[]` | **不动**。它管 Agent 输出的结构化效果声明，与战斗管道无关 |
| **ScriptExecutor + SubscriptionManager** | `script-executor.ts` / `subscription-manager.ts` | Phase 7e+8 AI 脚本沙盒     | AI 写 JS，`$ API` 收集 `ScriptEffects`         | **M1 改造对象**                                           |

`script-registry.ts`（M1 新增）**不是第三套系统**，而是 SubscriptionManager 的**声明式 facade**——把 `{event, source, owner, handler, condition, priority}` 翻译成 `SubscriptionManager.register` 调用。详见 §3.5。

### 1.5 GameEventType —— 闭合扁平枚举

```ts
// types.ts:1220
export type GameEventType =
  | 'character_action'
  | 'combat_action'
  | 'craft_action'
  | 'status_effect'
  | 'variable_change'
  | 'plot_trigger'
  | 'item_use'
  | 'skill_use'
  | 'location_change'
  | 'quest_update'
  | 'system';
```

11 个扁平字面量，**无命名空间**（没有 `combat.attack.*`）。v2 架构 §6.4 的 19 个 event 用的是 `combat.attack.request` 点分式。命名方案需要决策（§3.8）。

---

## 2. 设计目标（验收标准）

| #   | 目标               | 验收                                                                          |
| --- | ------------------ | ----------------------------------------------------------------------------- |
| G1  | emitChain 链式变换 | 3 个 handler 链式改 params，最终值正确                                        |
| G2  | 在场过滤           | owner 不在 combatants 的订阅者被跳过                                          |
| G3  | 声明式注册         | 物品装备时一次注册整份 scripts 清单，卸下时全注销                             |
| G4  | 套娃收紧           | 战斗场景 6 层套娃第 6 层被拦截；非战斗仍允许 10 层                            |
| G5  | ctx 只读 API       | 脚本能 `$resource.getHp(owner)` 读到真值，`modifyHp` 仍走收集器（不能直接写） |
| G6  | 向后兼容           | 现有 78 个测试全绿，旧 `publish/subscribe/$event.on` 行为零变化               |

---

## 3. 核心设计决策

每条给出选项、推荐、理由。`✅推荐` 项即本 RFC 立场，主人可否决。

### D1：emitChain 与 publish 的关系

- **选项 A**：并存——新增 `emitChain`，`publish` 原样保留 ✅ **推荐**
- 选项 B：改造 `publish` 支持返回值（破坏性，牵连所有 handler 签名）

**理由**：publish 是 fan-out 通知（适合 `status_effect`/`location_change` 这类"告知"），emitChain 是 fan-in 变换（适合战斗管道的"参数流水线"）。两者语义不同，强行合并会让 handler 签名两难。并存还保住全部现有测试。

### D2：handler 注册表是否分离 ✅ 实施取 A

- **✅ 选项 A（实施采纳）**：分离——`subscribe(type, handler)` 走 publish（handler 收 GameEvent）；`subscribeChain(sub)` 走 emitChain（handler 收 params+ctx），两套独立注册表（`handlers`/`globalHandlers` vs `chainHandlers`）
- 选项 B（RFC 原推荐，未采纳）：统一——handler 签名升级，publish 丢弃返回值，emitChain 用返回值

**实施改 A 的原因**：现有测试断言 `handler.toHaveBeenCalledWith(event)`（收完整 GameEvent 对象），链式 handler 收的是 `(params, ctx)` 裸数据，签名差异大。强行统一（B）要么破坏现有测试，要么让链式 handler 从 event.data 解包（难用）。分离（A）让两套互不干扰，现有 40 个 publish 测试零改动。

> ℹ️ **params vs event**：emitChain 内部把 params 装进 `event.data` 构造完整 GameEvent 入历史；chain handler 收 `(params, ctx)`；publish handler 收 `GameEvent`。两者历史记录统一在同一 `history`。

### D3：链执行顺序（对齐 §13 决策 b「类型优先级 + order 兜底」）

- **✅ 推荐**：handler 注册带 `priority: number`（默认 0）+ `order: number`（默认 0），emitChain 按 `(priority 升序, order 升序, 注册序)` 排序执行

**澄清一个易混点**：这里的 `priority` 是**订阅者调度顺序**，不是登神 divinity。登神 divinity 是 **modifier 的属性**（M2 的事），管的是「神位伤压制常规盾」那种数值冲突仲裁，不归 M1 的链顺序管。M1 的 priority 只解决「5 个戒指谁先改参数」。

### D4：在场过滤实现（对齐架构 §3.4）

- **✅ 推荐**：handler 注册带可选 `owner: string`（角色 charId）；emitChain 的 `ctx.combatants: string[]` 给出参战者列表；`owner` 不在 `combatants` 则跳过该 handler

**边界**：

- `owner` 缺省（如系统/环境 buff）→ 永远在场，不过滤
- `combatants` 缺省 → 不过滤（向后兼容非战斗场景）
- 过滤在 emitChain 入口做一次，不在每个 handler 里重复判断

### D5：声明式注册 = SubscriptionManager 的 facade（非新系统）

架构 §3.1 的契约：

```ts
{
  (event, source, owner, handler, condition, priority);
}
```

`script-registry.ts` 暴露：

```ts
registerDeclaration(decl, ownerKey)        // 注册单条
registerDeclarations(decls[], ownerKey)    // 物品装备时批量注册整份清单
unregisterOwner(ownerKey)                  // 物品卸下时全注销（转发 SubscriptionManager.unregisterAll）
```

**内部实现**：把每条 declaration 翻译成 `SubscriptionManager.register(ownerKey, decl.event, decl.handler-as-scriptKey, resolver, {owner: decl.owner, ...})`。condition 编译成 `subscribeWhen` 的 filter。priority/order 写进 SubscriptionManager 的订阅元数据。

**为什么不直接让 AI 调 `$event.on`**：`$event.on` 是命令式（脚本运行时动态注册），声明式是**静态清单**（物品定义时就写好，装备即注册整份）。两者并存：声明式管"装备/卸下"的生命周期，命令式管"运行中临时订阅"。M1 的兼容层（任务 1.6）把旧 `$event.on` 映射成声明式注册的动态版。

### D6：套娃深度按场景（任务 1.4）

- 现状：`maxRecursionDepth=10` 写死在 SubscriptionManager constructor 默认值
- **✅ 推荐**：`emitChain` 的 ctx 带可选 `maxDepth`；EventBus 增加战斗模式标记。战斗 emitChain 调用时传 `maxDepth=5`，非战斗保持 10。

**实现细节**：递归深度计数仍在 SubscriptionManager（它管套娃），但 emitChain 调用前临时设置本次链的深度上限。需要 SubscriptionManager 支持 per-chain 深度配置（而非 per-instance 写死）。

### D7：ctx 只读 API 最小集（任务 1.5，对齐 §13 决策 e）

现状 `$resource.getHp` 返回 0（桩）。**✅ 推荐** M1 暴露最小只读集，通过 ScriptContext 注入真实查询函数：

```ts
// 新增只读查询（注入实现，脚本侧只读）
$resource.getHp(charId) / getMaxHp / getMp / getMaxMp / getSp / getMaxSp;
$resource.getHpPercent(charId);
$char.getAttr(charId, '体' | '智' | '敏' | '力' | '精'); // 五维只读
$char.getTier(charId);
$char.isPresent(charId); // 在场判断（配合 D4）
```

**写入仍走收集器**（`modifyHp`/`modifyStat` 进 `ScriptEffects`，由 state-manager 统一 apply）—— 这条不变，保住「脚本不能直接动 HP」的红线。

**注入缝**：`ScriptContext` 增加可选 `readHooks` 字段，调用方（SubscriptionManager / executeScript）按需注入。测试可不注入（缺省返回 0，兼容现有 30 个 script-executor 测试）。

### D8：GameEventType 命名空间方案（19 event 接入预备）

- 选项 A：扁平扩展——`combat_attack_request` / `combat_dice_roll` …（保持字面量联合风格）
- **选项 B**：点分命名空间——`'combat.attack.request'`，GameEventType 扩为 `原有联合 | CombatEventName | (string & {})` ✅ **推荐**

**理由**：架构 §6.4 全用点分式（`combat.attack.collect_attacker_mods`），扁平化 19 个会让 GameEventType 膨胀且失去层级语义。`(string & {})` 是 TS 常用技巧——保留字面量自动补全，同时允许任意 string 传入（emitChain 不被闭合枚举卡死）。

**注意**：19 event 的完整定义属 M3（任务 4.2）。M1 只需把 emitChain 的 type 参数设计为接受 `string`（不卡闭合枚举），M3 接入时再补 `CombatEventName` 联合。M1 不预定义 19 个 event。

---

## 4. API 草案（TypeScript）

### 4.1 EventBus 新增方法

```ts
/** 链式 handler —— 接收 params，返回（可能修改过的）params */
export type ChainHandler<P = any> = (params: P, ctx: ChainContext) => P | Promise<P>;

/** 链式调用上下文 */
export interface ChainContext {
  /** 参战者 charId 列表（在场过滤用；缺省=不过滤） */
  combatants?: string[];
  /** 触发源标识 */
  source?: string;
  /** 本次链的套娃深度上限（缺省=EventBus 默认） */
  maxDepth?: number;
  /** 只读查询钩子（注入给 handler 内的 $ API） */
  readHooks?: ReadonlyHookSet;
}

/** 链式订阅注册 —— handler 元数据带 priority/order/owner */
export interface ChainSubscription {
  type: string;
  handler: ChainHandler;
  priority?: number; // 默认 0
  order?: number; // 默认 0
  owner?: string; // 在场过滤用；缺省=永在场
  condition?: (params: any, ctx: ChainContext) => boolean;
}

export class EventBus {
  // ===== 旧 API 原样保留 =====
  publish(event: GameEvent): Promise<void>;
  subscribe(type, handler): () => void;
  subscribeAll(handler): () => void;
  subscribeWhen(filter, handler): () => void;

  // ===== M1 新增 =====
  /** 链式触发：按 priority/order 顺序，前一个返回值作后一个输入 */
  emitChain<P>(type: string, initialParams: P, ctx?: ChainContext): Promise<P>;

  /** 链式订阅（带元数据）。返回注销函数 */
  subscribeChain(sub: ChainSubscription): () => void;
}
```

### 4.2 声明式注册（`script-registry.ts` 新增）

```ts
/** 声明式脚本条目 —— 对齐架构 §3.1 */
export interface ScriptDeclaration {
  event: string; // 订阅事件
  source: string; // 静态身份（物品/技能名，buff id 前缀用）
  owner?: string; // 动态持有人 charId
  handler: ChainHandler; // 实际函数
  condition?: (p: any, ctx: ChainContext) => boolean;
  priority?: number;
  order?: number;
}

/** 注册一份声明 */
export function registerDeclaration(
  bus: EventBus,
  mgr: SubscriptionManager,
  decl: ScriptDeclaration,
  ownerKey: string, // {charId}:{objectType}:{objectName}
): () => void;

/** 批量注册（物品装备时）—— 返回整批的注销函数 */
export function registerDeclarations(
  bus: EventBus,
  mgr: SubscriptionManager,
  decls: ScriptDeclaration[],
  ownerKey: string,
): () => void;

/** 全量注销某 owner（物品卸下时） */
export function unregisterOwner(mgr: SubscriptionManager, ownerKey: string): void;
```

### 4.3 只读钩子集（注入缝）

```ts
export interface ReadonlyHookSet {
  getHp(charId: string): number;
  getMaxHp(charId: string): number;
  getMp(charId: string): number;
  getSp(charId: string): number;
  getHpPercent(charId: string): number;
  getAttr(charId: string, attr: '体' | '智' | '敏' | '力' | '精'): number;
  getTier(charId: string): number;
  isPresent(charId: string): boolean;
}
```

`ScriptContext` 增加可选 `readHooks?: ReadonlyHookSet`。`buildSandbox` 里 `$resource.getHp` 等改为 `ctx.readHooks?.getHp ?? (() => 0)`，缺省仍返回 0（兼容现有测试）。

---

## 5. 任务分解（对齐计划 M1 的 1.1–1.6）

| 计划任务                 | RFC 落地 | 涉及文件                  | 核心改动                                                                 |
| ------------------------ | -------- | ------------------------- | ------------------------------------------------------------------------ |
| 1.1 emitChain 链式返回值 | D1+D2+D3 | `game-event.ts`           | 新增 `emitChain`/`subscribeChain`，handler 签名升级 `(event)=>void\|any` |
| 1.2 在场过滤             | D4       | `game-event.ts`           | emitChain 入口按 `ctx.combatants` 过滤 `owner`                           |
| 1.3 声明式脚本契约       | D5       | 新增 `script-registry.ts` | facade 翻译 declaration → SubscriptionManager.register                   |
| 1.4 套娃深度限制         | D6       | `subscription-manager.ts` | per-chain maxDepth（替代 per-instance 写死）                             |
| 1.5 ctx 只读 API         | D7       | `script-executor.ts`      | ScriptContext 增 `readHooks`，沙盒 $resource/$char 接入                  |
| 1.6 旧 API 兼容层        | D1+D5    | `script-executor.ts`      | `$event.on` 映射到声明式注册的动态版；`publish/subscribe` 不动           |

**实施顺序**（建议）：1.1 → 1.5 → 1.2 → 1.4 → 1.3 → 1.6

- 先 emitChain（核心机制），再只读 API（独立增强），再在场过滤/套娃（依赖 ctx），再声明式 facade（依赖前面），最后兼容层（收口）。

---

## 6. 兼容策略与影响面

### 6.1 影响面（基于 §1.3 零生产调用）

| 面          | 影响                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| 生产代码    | **零**（无任何模块 import EventBus/SubscriptionManager 用于实际逻辑）              |
| 现有测试    | 78 个必须保持绿：game-event(~40) + subscription-manager(~8) + script-executor(~30) |
| 数据库/存档 | 零（EventBus 是内存态，不落 Dexie）                                                |
| Agent 层    | 零（M4 才接 Combat Agent）                                                         |

### 6.2 兼容保证清单

- ✅ `publish(event)` / `publishAll` 签名与行为不变
- ✅ `subscribe/subscribeAll/subscribeWhen` 签名不变，仍返回 unsubscribe 函数
- ✅ `EventHandler` 从 `(event)=>void` 升级为 `(event)=>void|any`——旧 handler 不 return，零影响
- ✅ `$event.on/off/emit` 在沙盒内的收集语义不变（仍进 `ScriptEffects`）
- ✅ `$resource.getHp` 缺省返回 0（不注入 readHooks 时）——现有 30 个 script-executor 测试无需改
- ✅ SubscriptionManager constructor 默认 `maxRecursionDepth=10` 保留（战斗深度通过 emitChain ctx 临时覆盖，不改默认）

### 6.3 回退策略

M1 全程不删旧 API、不改旧文件结构，纯**新增 + 增强**。若 emitChain 设计在实施中暴露问题，可直接回退新增方法，旧系统不受影响。建议 M1 一个 PR/批次提交，便于整体回退。

---

## 7. 测试计划

### 7.1 现有测试回归（必须全绿）

- `game-event.test.ts` ~40 个
- `subscription-manager.test.ts` ~8 个
- `script-executor.test.ts` ~30 个

### 7.2 M1 新增测试（对应 G1–G6）

| 测试文件                            | 覆盖                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `game-event.test.ts` 扩展           | emitChain 链式 3 handler 改 params；priority/order 排序；在场过滤跳过；async handler 链；handler 抛错不阻塞链；emitChain 历史记录 |
| `subscription-manager.test.ts` 扩展 | per-chain maxDepth=5 拦截第 6 层；默认仍 10；战斗 ctx 传深度                                                                      |
| `script-executor.test.ts` 扩展      | readHooks 注入后 `$resource.getHp` 返回真值；缺省仍返回 0；`$char.getAttr`/`isPresent`                                            |
| 新增 `script-registry.test.ts`      | registerDeclarations 批量注册；unregisterOwner 全注销；condition 过滤；priority 传递                                              |

### 7.3 验收命令

```bash
npm run typecheck   # 0 错误
npm run test -- --run   # 全绿（含新增）
```

---

## 8. 风险与对策

| 风险                                                                       | 等级 | 对策                                                                                                                                   |
| -------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| emitChain 链式语义设计错（如 params 突变 vs 返回新对象）导致 M3 接入时返工 | 🔴   | 本 RFC §4.1 钉死签名；M1 完成后写一个**战斗管道 mock 示例**（不接 combat-resolver，纯演示 emitChain 怎么用）放测试里，提前暴露设计缺陷 |
| 声明式 facade 和命令式 `$event.on` 双轨造成心智负担                        | 🟡   | §5 任务 1.6 兼容层把两者关系讲清；文档明确「声明式=静态生命周期，命令式=动态临时」                                                     |
| 套娃 per-chain 深度改动破坏现有 subscription-manager 的 per-instance 计数  | 🟡   | 不删 per-instance 默认，per-chain 作为临时覆盖；现有 S4 测试保持绿                                                                     |
| GameEventType 放开为 `(string & {})` 后失去编译期拼写检查                  | 🟢   | M3 补 `CombatEventName` 字面量联合供自动补全；M1 暂不预定义                                                                            |
| 「生产零调用」导致 M1 完成后无法真实验证                                   | 🟡   | 接受——M1 是基础设施层，验收靠单元测试；端到端验证是 M6 的事                                                                            |

---

## 9. 待主人拍板点

以下是需要主人明确表态的设计选择。带 ✅ 的是本 RFC 推荐，主人不否决即按此实施：

| #   | 决策点                                  | 选项                                                  | 推荐                                                    |
| --- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Q1  | emitChain 与 publish 关系               | 并存 / 替换                                           | ✅ 并存                                                 |
| Q2  | handler 注册表                          | 统一 / 分离                                           | ✅ 统一（签名升级 `(event)=>void\|any`）                |
| Q3  | 链顺序依据                              | priority+order / 仅注册序                             | ✅ priority+order+注册序                                |
| Q4  | 在场过滤触发时机                        | emitChain 入口一次性 / 每 handler 判                  | ✅ 入口一次性                                           |
| Q5  | 声明式 registry 定位                    | SubscriptionManager facade / 独立新系统               | ✅ facade                                               |
| Q6  | 套娃深度方案                            | per-chain ctx.maxDepth / EventBus 战斗模式标记 / 两者 | ✅ per-chain ctx.maxDepth（最小侵入）                   |
| Q7  | ctx 只读 API 范围                       | 最小集(HP/属性/tier/isPresent) / 一步到位全开         | ✅ 最小集起步                                           |
| Q8  | GameEventType 开放                      | 扁平扩展 / 点分命名空间+`(string & {})`               | ✅ 点分+开放                                            |
| Q9  | `$event.emit`（瞬时事件）是否在 M1 修通 | 修（re-emit 到 bus）/ 留到 M3                         | ✅ 留到 M3（M1 聚焦 emitChain，瞬时事件属 M3 接入范畴） |
| Q10 | 实施方式                                | 主线串行 / 用子 agent 并行 1.1 与 1.5                 | 见 §10                                                  |

---

## 10. 实施方式建议

M1 的 6 个任务有依赖链（§5），但 1.1（emitChain）和 1.5（ctx 只读 API）**互相独立**——emitChain 改 game-event.ts，只读 API 改 script-executor.ts，文件不重叠。可以考虑：

- **方案 A（推荐，稳）**：主线串行 1.1→1.5→1.2→1.4→1.3→1.6，每步 typecheck+test 后再下一步。适合首次落地，风险可控。
- **方案 B（快，用 agent）**：派两个子 agent 并行做 1.1 和 1.5（文件分区、不冲突），主线等两者合并后继续 1.2/1.4/1.3/1.6。

主人倾向哪种？如果选 B，本喵会在拍板后用 `Task` 工具派发，子 agent 各自只碰自己的文件、不互相 commit。

---

## 11. 变更记录

| 日期       | 变更                                                                                        | 作者           |
| ---------- | ------------------------------------------------------------------------------------------- | -------------- |
| 2026-07-28 | 初版 RFC：现状审计（含生产零调用发现）+ 10 决策 + API 草案 + 测试计划                       | Claude（RFC）  |
| 2026-07-28 | M1 实施完成：D2 改取 A（分离注册表）；6 任务全交付，四件套 130 tests，全量 3376/3377 零回归 | Claude（实施） |
