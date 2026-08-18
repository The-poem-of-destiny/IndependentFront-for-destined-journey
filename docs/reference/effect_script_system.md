# 词条效果 & 脚本系统 (Phase 7e+8)

> 引擎参考文档。描述效果系统的四层架构：声明式词条(EffectParser) → 执行运行时(EffectRuntime) → 事件总线(EventBus) → AI 可编程脚本(ScriptExecutor)

---

## 🔴 适用范围（2026-08-18 复核）

**本文描述的 JS 脚本机制只适用于「战斗之外」的效果面。战斗内不走这条路。**

| 场景                                                | 效果机制                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 战斗**外**（装备/卸下、状态到期、读档接线、制作） | 本文的 `scripts` + `$` API（`script-executor.ts` + `subscription-manager.ts` + `emitChain`） |
| 战斗**内**（v3 内核主持的整场战斗）               | **EffectAutomaton DSL**（`src/sillytavern/combat-v3/automata/`，18 窗口声明 + 8 大类 intent） |

ADR-20 的原文是「声明式优先，复杂动态逻辑走脚本沙盒」；**战斗内那半边已在 v3 收紧成
「任意 JS 一律废止」** —— 战斗要的是可回放、可仲裁、可静态校验的效果声明，而任意 JS 三条都给不了。
所以战斗内的效果由 `automata/` 的封闭表达式文法编译执行，不经 `script-executor.ts`、
也不经 `emitChain`。**给战斗用的物品/技能写 `scripts` 是写进空气**（战斗内不会有人读它）；
战斗侧的契约见 `docs/reference/combat-system-architecture-v3.md` 与 `combat-item-validator.ts`。

> 战斗 v2 的 `emitChain` 效果基座**仍然存在且仍在服役**，只是它的服务对象从此是
> 制作系统与战斗外效果（ADR-29 继续适用），不再是战斗流程本身。

---

## 一、四层架构

```
Layer 1  词条解析     $effect.parse()   中文→结构化 ParsedEffect   AI 可调用
Layer 2  效果运行时   EffectRuntime     6 种效果类型分发           引擎内部
Layer 3  事件总线     EventBus          发布-订阅，按存档隔离      引擎内部
Layer 4  脚本沙盒     ScriptExecutor    AI 用 $ API 编写逻辑       AI 可调用
```

---

## 二、Layer 1: 词条解析 (`effect-parser.ts`)

把 AI 写的中文效果声明解析为结构化数据。

```typescript
// 输入: AI 写的中文
"攻击力: +50, DR: 5%, 火焰抗性: +30"

// $effect.parse() → 
[
  { key: "atk", rawKey: "攻击力", value: 50, isPercentage: false },
  { key: "dr", rawKey: "DR", value: 5, isPercentage: true },
  { key: "fireResist", rawKey: "火焰抗性", value: 30, isPercentage: false }
]
```

**50+ 中→英键映射表**：攻击力→atk, 防御力→def, 暴击率→critRate, 火焰抗性→fireResist...

```typescript
$effect.parse(text)          // 解析声明字符串
$effect.getValue(list, key)  // 查找指定 key 的值
$effect.sumValues(list, key) // 多个效果同 key 求和
```

---

## 三、Layer 2: 效果运行时 (`effect-runtime.ts`)

执行声明式效果定义，按类型分发到具体处理器。

```
EffectRuntime.execute(effects)
  ├── 按 priority 排序 (低→高)
  ├── evaluateCondition() — EJS 条件检查
  ├── 6 种类型分发:
  │   ├── vars_patch        → 变量修改
  │   ├── status_effect     → 添加/移除状态
  │   ├── character_update  → 角色属性/资源变更
  │   ├── dice_roll         → 骰子检定
  │   ├── item_effect       → 物品使用/装备/卸下
  │   └── skill_effect      → 技能使用/学习/遗忘
  └── 递归处理 childEffects (连锁效果)   🪦 死代码，见下
```

### 🪦 「连锁效果」是死代码（2026-08-18 复核）

`execute()` 里确实写着「`result.childEffects.length > 0` 就递归」（`effect-runtime.ts:77-80`），
但 `executeOne()` 里那个 `const childEffects: EffectDefinition[] = []`（`effect-runtime.ts:103`）
**声明之后一次都没有被 push 过** —— 六个 `executeXxx` 分支只往 `patches` 里写。于是那条递归
**永远进不去**，`childEffects` 恒为空数组。

这不是「暂时没人用」，是**这个功能从来没有实现过**。首次记录于
`docs/archive/planning/2026-07-30-combat-event-system-review.md` 的 **N6**。

🔴 写文档 / 写 AI 提示词时**不要把连锁效果当成可用能力**。需要「效果触发效果」时，现有的两条真路是：
事件链（`$event.emit` → EventBus → 订阅者脚本）与脚本内直接 `$call` / `$status.add` 套娃。

### 🪦 EffectRuntime 本身「已建成未接线」（2026-08-18 复核）

全仓 `new EffectRuntime` / `createEffectRuntime` 的调用点只有两处：`effect-runtime.ts:365-366`
自己的工厂函数，与 `effect-runtime.test.ts`。**生产链路零调用**。

也就是说上面那张「按 priority 排序 → 条件检查 → 6 种类型分发」的流程图描述的是**这个类的能力**，
不是「引擎当前每回合真的这么跑」。生产里的状态变更走 ADR-21 的 `commitChatState()`
（`state-manager.ts`），效果脚本走 Layer 4 + `effect-wiring.ts`。

🔴 所以本节读作**设计与实现记录**：类写好了、测试全绿、随时可接；但「管线完成后由编排层批量执行
EffectDefinition」这句是**计划态**。同类记录见
`docs/reviews/2026-08-03-code-quality-refactor/findings-t1-wiring-gap.md`。

**EffectDefinition 结构**：

```typescript
{
  type: 'status_effect',
  source: 'agent' | 'system' | 'resolver',
  payload: StatusEffectPayload,   // 效果负载
  priority: number,               // 执行顺序
  condition?: string,             // EJS 条件表达式
  relatedEventId?: string         // 关联的 EventBus 事件
}
```

---

## 四、Layer 3: 事件总线 (`game-event.ts`)

按存档隔离的发布-订阅系统，连接引擎各模块。

```typescript
// 12 种事件类型（2026-08-18 复核：types.ts:1836-1853。原文写「10 种」，
// 之后新增了 quest_update 与 random_event 两种）
type GameEventType =
  | 'character_action' | 'combat_action' | 'craft_action'
  | 'status_effect' | 'variable_change' | 'plot_trigger'
  | 'item_use' | 'skill_use' | 'location_change'
  | 'quest_update' | 'random_event' | 'system'

// 实例化 — 每个 SaveSlot 独立
const bus = new EventBus({ saveId })
bus.subscribe('combat_action', (event) => { ... })
bus.emit({ type: 'status_effect', data: { ... } })
```

**引擎 emit 事件节点**：

🔴 **下表 2026-08-18 按代码重写过**（旧表把 emit 记在了 resolver 身上）。现实是：
**几乎所有 GameEvent 都由 `state-manager` 的 `createEvent()` 一处产出**（每个 patch handler
返回一条），随后经 `commitChatState` 的 `publishToEffectSystem` 发到该存档的 EventBus。

| 模块 | 事件 | 时机 |
|------|------|------|
| `state-manager` | `status_effect` | addEffect / removeEffect 后（:998 / :1013） |
| `state-manager` | `variable_change` | set_variable / delta_variable 等变量补丁后（:689-735） |
| `state-manager` | `character_action` | 角色属性/资源类补丁后（:893-921） |
| `state-manager` | `item_use` | 物品增删/装备/卸下等补丁后（:1065-1277） |
| `state-manager` | `skill_use` | 技能使用/学习/遗忘补丁后（:1331-1374） |
| `state-manager` | `location_change` | set_location 后（:1392） |
| `state-manager` | `quest_update` | 任务补丁后（:1521 / :1532） |
| `state-manager` | `plot_trigger` | 剧情补丁后（:1502） |
| `state-manager` | `random_event` | 随机事件按名结算后（:2184，随机事件 v1） |
| `state-manager` | `system` | 时间推进等杂项补丁（:1414-1599） |

**🪦 三条已失效的行（原表所载）**：

- `combat-resolver` / `combat_action` —— **`combat-resolver.ts` 已被 M5 删除**，`$combat` API 与
  8 步伤害管线随 v2 运行时一起退役。现在战斗流程由 `combat-v3/` 内核主持，它**不发 GameEvent**，
  走自己的 `DomainEvent` + 双投影。`game-event.ts:355` 还留着 `createCombatEvent()` 这个 helper，
  但**生产侧零调用**（只有 `game-event.test.ts` 在用）—— 别按它推断「战斗会发事件到 EventBus」。
- `craft-resolver` / `craft_action` —— `craft-resolver.ts` 仍在服役，但它**不 emit 任何 GameEvent**
  （文件里连 `GameEvent` 这个词都没有）。`createCraftEvent()` 与 `createCombatEvent()` 同状：
  helper 在，生产调用点零。
- `plot-engine` / `plot_trigger` —— `plot-engine.ts` 同样不 emit；`plot_trigger` 的唯一产出点是
  上表里 `state-manager:1502`。

---

## 五、Layer 4: 脚本沙盒 (`script-executor.ts`)

AI 用 `$` API 编写效果逻辑，引擎在沙盒中执行。

> 🔴 本层只服务**战斗外**的效果。战斗内的效果走 EffectAutomaton DSL，见文首「适用范围」。

### 🔒 安全模型：QuickJS(wasm) realm 隔离（2026-08-10 / SEC-02 收口）

**这里的「沙盒」是真隔离，不是形参遮蔽。** 求值后端在 `script-backend.ts`（接缝）→
`script-quickjs-backend.ts`（实现），四条硬性质：

| 性质 | 说明 |
|------|------|
| **realm 隔离** | 脚本跑在 QuickJS(wasm) 的 guest realm 里。guest 中**不存在**宿主 `globalThis` / `indexedDB` / `fetch` —— 不是「被挡住」，是那些对象根本没被造出来，够不到 Dexie 与 API Key |
| **墙钟预算 50ms** | `init` 里写一句 `for(;;);` 不再冻死标签页；内存上限 32MB。一次脚本一个 runtime+context（脚本之间零泄漏，`$call` 重入互不干扰） |
| **fail-closed** | 没装隔离 = 脚本**一行都不跑**，不是「先用 `new Function` 跑着」 |
| **无 Legacy 回落** | 与 `ejs-backend.ts` **刻意不同：脚本面没有 `LegacyBackend`**，`setScriptBackend` 也不导出。留一个可安装的 `new Function` 实现，等于把刚拆掉的枪放回抽屉 |

🪦 **旧实现是 `new Function` + 13 个同名形参遮蔽**，那不是安全边界：
`({}).constructor.constructor("return globalThis")()` 能拿回应用自己的真全局，
于是 `indexedDB` → Dexie → `apiEndpoints.apiKey` 全在手上。它曾是全仓**唯一一条活着的
同源代码执行路径**，也因此是唯一一条活着的 API Key 外泄路径。

两条落到日常工作上的规矩：

1. **`buildSandbox()` 是 `$` API 名单的唯一真源**（`script-executor.ts:331`）。后端从它返回的对象
   **推导** guest 侧 API 形状，加一个 `$foo` 不必动后端。
2. **测试必须在 `beforeAll` 里 `await installProductionScriptBackend()`**。默认后端 fail-closed ——
   不装就是脚本一行不跑，而「断言收集到 0 条效果」那类用例会**照常变绿**。
3. 宿主全局在 guest 里**显式遮蔽成 `undefined`**（不是 ReferenceError），保真旧实现的形参遮蔽 ——
   AI 爱写的 `if (window)` 这种防御性代码不该让整个脚本中断。但 `Function` / `globalThis` / `eval`
   **刻意不遮蔽**：在 realm 里它们够不到宿主，留着反而更兼容。

宿主闭包一行没改，所以 `_parentScripts` 盖章 / `$call` 效果合并 / `$event.on` 的 handle 编号
全都仍在宿主侧原样发生 —— 这是迁到隔离后兼容性的来源。

### 数据模型

```
物品/技能/装备/Ascension:
  ├── effects: Record<string, string>   ← 前端渲染 (AI 写中文描述)
  ├── scripts: Record<string, string> ← 引擎执行 (脚本名→代码)
  │   ├── init    → 激活时自动执行（注册 $event.on）
  │   ├── cleanup → 失效时自动执行（调用 $event.off）
  │   └── ...     → 其他自定义脚本
  └── 钩子引用: scripts 里的脚本名

状态效果 (StatusEffect):
  ├── stackable / maxStacks          ← 层数控制
  ├── scripts: Record<string, string> ← 引擎执行
  ├── onApply / onTick / onRemove / onTrigger → 引用 scripts
  ├── subscriptions: 通过 init 中 $event.on() 注册持久监听
  └── effects: Record<string, number> ← 简单数值效果 (保留)
```

### 持久订阅管理 (`subscription-manager.ts`)

`SubscriptionManager` 管理 `$event.on()` 注册的持久订阅生命周期：

```
对象激活 → executeInit() → $event.on() → 收集到 effects.subscriptions
  → SubscriptionManager.register(ownerKey, eventType, scriptKey)
    → EventBus.subscribe(eventType, handler)
      → 事件触发 → resolveScriptRef → executeScript → 应用效果

对象失效 → executeCleanup() → $event.off() → 收集到 effects.unsubscriptions
  → SubscriptionManager.unregisterAll(ownerKey) [兜底]
```

**递归保护**：事件嵌套处理超过 10 层自动截断。

### 层数控制

| 配置 | 行为 |
|------|------|
| 无 stackable/maxStacks | 自由叠加 (现状) |
| `stackable: false` | 永远 1 层，重复施加只刷新时间 |
| `maxStacks: N` | 累加到 N 停止 |
| 两者合用 | `stackable: false, maxStacks: 1` = 不可叠 |

### 脚本沙盒 API

🔴 **下面这份 2026-08-18 按 `script-executor.ts` 的 `ScriptSandbox`（:57-117）与
`buildSandbox()`（:331-459）逐条核对过**，是完整名单（旧版少列了 `$char` 整个 namespace，
`$resource` 与 `$status` 也各少列一半）。

```typescript
executeScript(script, context)
  └── buildSandbox()
        ├── owner / target / event / self   ← 上下文变量
        ├── $dice     ← 骰子系统
        ├── $resource ← 资源：7 读 + 2 写
        ├── $char     ← 🆕 角色只读查询 namespace
        ├── $status   ← 状态效果：3 写 + 3 读（套娃核心）
        ├── $call     ← 跨对象脚本调用
        └── $event    ← 持久订阅 + 瞬时事件
```

**完整方法表**（读侧全部走 `ctx.readHooks`，未注入时返回下表的缺省值；写侧全部只写进
`ScriptEffects` 收集器，由调用方统一 apply —— 脚本本身**碰不到数据库**）：

| Namespace | 方法 | 读/写 | 缺省值 |
|-----------|------|-------|--------|
| `$dice` | `d20()` / `d100()` / `roll(formula)` | — | `roll` 解析不出公式返回 `0` |
| `$resource` | `getHp(id)` / `getMaxHp(id)` / `getMp(id)` / `getMaxMp(id)` / `getSp(id)` / `getMaxSp(id)` | 读 | `0` |
| `$resource` | `getHpPercent(id)` — 0~1 | 读 | `0` |
| `$resource` | `modifyHp(id, amount)` → `hpChanges` | 写 | — |
| `$resource` | `modifyStat(id, stat, amount)` → `statChanges` | 写 | — |
| `$char` | `getAttr(id, attr)` — 五维，英文键 `str/dex/con/int/spi` | 读 | `0` |
| `$char` | `getTier(id)` — 层级 1~7 | 读 | `0` |
| `$char` | `isPresent(id)` — 是否在场（配合 `emitChain` 在场过滤） | 读 | `false` |
| `$status` | `add(id, effect)` → `adds`（直接加、**不去重**，兼容旧脚本） | 写 | — |
| `$status` | `apply(target, buffDef)` → `statusApplies`（🆕 M2：走 BuffRegistry 去重 —— 同源刷新时间+增层，异源共存） | 写 | — |
| `$status` | `remove(target, buffIdOrName)` → `statusRemoves`（M2 新语义：按 buffId **或**裸 name 匹配） | 写 | — |
| `$status` | `setStacks(id, effectId, stacks)` → `stackSets`（旧 API） | 写 | — |
| `$status` | `getStacks(id, buffIdOrName)` | 读 | `0` |
| `$status` | `has(id, buffIdOrName)` | 读 | `false` |
| `$status` | `query(id)` — 返回 `StatusEffect[]` | 读 | `[]` |
| `$event` | `on(eventType, scriptKey)` → `subscriptions`，返回 handle 字符串 | 写 | — |
| `$event` | `off(handleOrType)` → `unsubscriptions` | 写 | — |
| `$event` | `emit(eventType, data?)` → `events` | 写 | — |
| `$call` | `$call(ref)` — 解析 ref 并在**同一上下文**执行，子脚本的**全部** 10 类效果自动合并回当前 `ScriptEffects`；固定返回 `undefined` | 写 | — |

🔴 **`add` 与 `apply` 是两件事，别混**：`add` 是「直接加一条」，`apply` 走 BuffRegistry 去重。
新脚本一律用 `apply`；`add` 只为旧脚本保留。

🔴 **`ScriptSandbox` 接口里的 `$event` 只声明了 `emit`，而 `buildSandbox()` 实际注入了
`on`/`off`/`emit` 三个** —— 以运行时的 `buildSandbox()` 为准（后端从返回对象推导 guest 面，
不看那个 interface）。接口声明滞后于实现，不影响脚本可用性。

### 套娃机制

脚本通过 `$status.add()` 创建新状态。**子 StatusEffect 只做 @parent 薄壳引用**，逻辑定义在父级 scripts 池（详见下方 ADR-27）：

```
// 父级（灼烧之剑.scripts）— 所有逻辑在这里扁平铺开:
{
  burnFormula: "$resource.modifyHp(owner, -5 * self.stacks);",
  ashFormula:  "$resource.modifyHp(owner, -2);",
  onHit: [
    "$status.add(target, { name:'灼烧', stacks:2,",
    "  scripts:{ tick:'@parent.burnFormula' },",
    "  onTick:'tick' });",
    "if ($dice.d100() <= 20) {",
    "  $status.add(owner, { name:'余烬', stacks:1,",
    "    scripts:{ tick:'@parent.ashFormula' },",
    "    onTick:'tick' });",
    "}",
  ].join('\n'),
}

// 子 StatusEffect.scripts — 只有引用:
灼烧: { tick: '@parent.burnFormula' }
余烬: { tick: '@parent.ashFormula' }

// 执行链:
灼烧之剑.onHit → $status.add(灼烧) → _parentScripts=灼烧之剑.scripts
  → 灼烧.onTick → resolveScriptRef('tick') → '@parent.burnFormula'
    → executeScript("$resource.modifyHp(owner, -5 * self.stacks);", {self:{stacks:2}})
      → 20%概率 → $status.add(余烬) → _parentScripts=灼烧之剑.scripts
        → 余烬.onTick → resolveScriptRef('tick') → '@parent.ashFormula'
```

无限套娃，无字符串转义问题，且所有公式在父级统一管理。

### 🆕 脚本引用路径规范

| 引用写法 | 解析目标 | 使用场景 |
|----------|---------|---------|
| `"tick"` | 当前对象 `scripts["tick"]` | 同对象内 |
| `"@parent.burnFormula"` | 创建者的 `scripts["burnFormula"]` | 子 StatusEffect 回调父 Item |
| `"@item.灼烧之剑.burnLogic"` | 指定物品的脚本 | 跨物品显式引用 |
| `"@skill.重击.damageCalc"` | 指定技能的脚本 | 技能间互相调用 |
| `"@status.burn_001.tick"` | 指定状态效果的脚本 | 状态链联动 |
| `"@ascension.生命摇篮.onActivate"` | 登神能力的脚本 | 权能/法则联动 |

**继承链自动建立**：`$status.add()` 时引擎自动将当前对象的 scripts 作为 `parentScripts` 传给子 StatusEffect。子对象可通过 `@parent.xxx` 回调父对象脚本。

**递归解析**：如果查到的值仍是 `@` 引用，自动递归解析（最多 5 层）。

### 🆕 编写规范：scripts 池扁平化 (ADR-27)

**核心原则：逻辑定义在父级 scripts 池扁平铺开，子 StatusEffect 只做 `@parent` 薄壳引用。禁止在 `$status.add()` 内联大段 JS 代码。**

#### ✅ 正确写法（分开写，不套娃）

```javascript
// 父级（Skill/Equipment/Item）的 scripts 池 — 所有逻辑在这里，扁平铺开:
{
  // 入口脚本（短，只负责 $status.add 薄壳）
  cast: [
    '$status.add(owner, {',
    "  name: '钢铁护盾',",
    '  category: \'增益\',',
    '  stacks: 1000,',
    '  remainingTime: null,',
    '  timeUnit: \'回合\',',
    '  source: \'钢铁护盾\',',
    "  scripts: { absorb: '@parent.absorbDamage' },",  // ← 只有引用！
    "  onTrigger: 'absorb'",
    '});',
  ].join('\n'),

  // 核心逻辑（独立 key，扁平在父级）
  absorbDamage: [
    'var dmg = event.damage || 0;',
    'var armor = self.stacks;',
    'if (armor <= 0) { $status.remove(owner, self.name); return; }',
    'if (dmg >= armor) {',
    '  $status.setStacks(owner, self.name, 0);',
    '  $status.remove(owner, self.name);',
    '  $event.emit("shield_broken", { absorbed: armor, overflow: dmg - armor });',
    '} else {',
    '  $status.setStacks(owner, self.name, armor - dmg);',
    '  $event.emit("shield_absorbed", { absorbed: dmg, remaining: armor - dmg });',
    '}',
  ].join('\n'),
}

// 子 StatusEffect.scripts — 只有 @parent 引用，极薄:
{ absorb: '@parent.absorbDamage' }
```

执行时 `$status.add()` 自动注入 `_parentScripts`，`executeHook()` 通过 `resolveScriptRef()` 递归解析 `@parent` 引用，最终执行的是父级代码，但 `self.stacks` / `self.name` 使用的是子 StatusEffect 的值。

#### ❌ 错误写法（套娃内联，禁止）

```javascript
// 不要在 $status.add() 里内联大段代码！
$status.add(owner, {
  name: '护盾',
  scripts: {
    absorb: [
      'var dmg = event.damage || 0;',   // 大段逻辑塞在子级
      'var armor = self.stacks;',
      'if (armor <= 0) { ... }',
      '// ... 20 行 ...'
    ].join('\n')
  },
  onTrigger: 'absorb'
});
```

#### 为什么要这样做

| 理由 | 说明 |
|------|------|
| 不套娃 | 所有逻辑在父级扁平铺开，一个 key 一个函数 |
| 可复用 | 多个子对象共享父级公式池（`@parent` 继承链自动建立） |
| 好维护 | 改一处公式，所有引用自动生效 |
| 好测试 | 直接测父级 `scripts['absorbDamage']`，无需构造深层 StatusEffect |
| AI 友好 | 每个 script key 是独立小函数，AI 生成/理解更准确 |

### 🆕 init / cleanup 生命周期

对象激活时引擎执行 `scripts.init`，失效时执行 `scripts.cleanup`：

| 对象类型 | init 触发时机 | cleanup 触发时机 |
|----------|-------------|-----------------|
| Equipment | 装备时 | 卸下时 |
| StatusEffect | 施加时 (onApply 之前) | 移除时 (onRemove 之后) |
| Ascension 要素 | 获得时 | 升级/失去时 |

**init 模式**：在 init 中调用 `$event.on()` 注册持久监听。
**cleanup 模式**：在 cleanup 中调用 `$event.off()` 取消监听。
**兜底**：即使 AI 忘了写 cleanup 或 cleanup 执行失败，`SubscriptionManager.unregisterAll(ownerKey)` 也会清理残留订阅。

### 🆕 $event API（扩展）

```typescript
// 注册持久事件监听。引擎在脚本执行后注册到 EventBus。
// 返回 handle 字符串，用于后续 $event.off()。
$event.on(eventType: string, scriptKey: string): string

// 取消持久事件监听。传入 handle 或 eventType。
$event.off(handleOrType: string): void

// 触发瞬时事件（已有）。
$event.emit(eventType: string, data?: Record<string, any>): void
```

**事件类型**：`combat_action` | `character_action` | `craft_action` | `status_effect` | `variable_change` | `plot_trigger` | `item_use` | `skill_use` | `location_change` | `system`

### 🆕 $call API

```typescript
// 执行指定脚本，共享当前上下文（owner/target/event/self）。
// 子脚本产生的所有效果（adds/removes/hpChanges/subscriptions 等）自动合并到当前 effects。
$call(ref: string): undefined
```

**示例**：
```javascript
// Item 定义
scripts: {
  burnFormula: "const dmg = $dice.roll('2d6'); $resource.modifyHp(target, -dmg);",
  onHit: "$status.add(target, { name:'灼烧', scripts:{ tick:'@parent.burnFormula' }, onTick:'tick' });"
}

// 灼烧.tick 脚本的值 = "@parent.burnFormula"
// resolveScriptRef("tick", 灼烧.scripts, 灼烧.parentScripts)
//   → "@parent.burnFormula" → parentScripts["burnFormula"]
//   → "const dmg = $dice.roll('2d6'); $resource.modifyHp(target, -dmg);"
```

**注意**：`$call()` 也可以直接在脚本代码中调用，用于在执行过程中引用其他脚本。但推荐将引用写在 `scripts` 值里通过 `resolveScriptRef` 自动解析，减少 `$call` 的使用。

### ScriptEffects 收集器

脚本执行不直接修改状态，而是收集变更。调用方在脚本执行后统一处理：

🔴 2026-08-18 复核：补上 M2 新增的两个字段，并删掉原文末尾那段**重复粘贴**的残片。
现共 **10 个**字段（对齐 `createScriptEffects()`，`script-executor.ts:148-161`）：

```typescript
ScriptEffects {
  adds:        { charId, effect }[]           // $status.add()
  removes:     { charId, effectId }[]         // （旧字段，$status.remove 已改走 statusRemoves）
  stackSets:   { charId, effectId, stacks }[] // $status.setStacks()
  events:      { eventType, data }[]          // $event.emit()
  hpChanges:   { charId, amount }[]           // $resource.modifyHp()
  statChanges: { charId, stat, amount }[]     // $resource.modifyStat()
  subscriptions:   { eventType, scriptKey }[] // $event.on()
  unsubscriptions: string[]                   // $event.off()
  statusApplies:   { target, buffDef }[]      // 🆕 M2: $status.apply() → 走 buff-registry 去重
  statusRemoves:   { target, buffIdOrName }[] // 🆕 M2: $status.remove() 新语义
}
```

### 钩子执行

```typescript
// 回合结束时执行所有状态的 onTick
executeHook(character.statusEffects, 'onTick', { owner: charId, event: { turn: 3 } })

// 施加时执行 onApply
executeHook([newEffect], 'onApply', { owner: charId })
```

---

## 六、前端展示

前端不改动逻辑，纯粹展示 AI 写的中文：

```vue
<!-- 物品的效果词条 -->
<div v-for="(desc, name) in item.effects" :key="name" class="effect-row">
  <span class="effect-key">{{ name }}</span>
  <span class="effect-value">{{ desc }}</span>
</div>

<!-- 状态效果用 BuffChip -->
<BuffChip :name="status.name" :type="status.category" :stacks="status.stacks" />
```

---

## 七、Agent 模板指示

AI (item_gen / vars_update) 生成物品/状态时需遵循 **ADR-27 scripts 池扁平化** 规范：

**核心规则：逻辑定义在父级（Skill/Equipment/Item）的 `scripts` 池扁平铺开，子 StatusEffect 只用 `@parent` 引用。禁止在 `$status.add()` 内联大段 JS。**

```
✅ 正确输出格式:
{
  "效果": { "锐利": "攻击力 +15%", "灼烧": "命中时50%附加灼烧" },
  "scripts": {
    // 父级 scripts 池 — 所有逻辑扁平铺开（一个 key 一个函数）
    "burnFormula": "$resource.modifyHp(owner, -floor($resource.maxHp(owner) * 0.05 * self.stacks));",
    "onHit": [
      "if ($dice.d100() <= 50) {",
      "  $status.add(target, {",
      "    name: '灼烧', category: '减益', stacks: 1, remainingTime: 3, timeUnit: '回合',",
      "    source: '灼烧之剑',",
      "    scripts: { tick: '@parent.burnFormula' },",  // ← 只有引用！
      "    onTick: 'tick'",
      "  });",
      "}",
    ].join('\n')
  }
}

// 子 StatusEffect.scripts — 只有 @parent 引用，极薄:
{ tick: '@parent.burnFormula' }
```

```
❌ 错误格式（禁止）:
{
  "scripts": {
    "hit": "$status.add(target, { scripts: { tick: '$resource.modifyHp(...)' }, onTick: 'tick' })"
    // ☝ 大段代码内联在子 StatusEffect 里 — 违反 ADR-27
  }
}
```

$ API 可用（2026-08-18 复核补全，完整表见 §五「完整方法表」）:
  $dice.d20() / $dice.d100() / $dice.roll('2d6+3')  — 骰子
  $resource.getHp/getMaxHp/getMp/getMaxMp/getSp/getMaxSp/getHpPercent(id)  — 资源只读
  $resource.modifyHp(id, amount)  — 修改HP (负数为伤害)
  $resource.modifyStat(id, stat, amount)  — 修改属性
  $char.getAttr(id, 'str')/getTier(id)/isPresent(id)  — 角色只读查询
  $status.apply(id, {name, category, ...})  — 🆕 添加状态（走去重，新脚本用这个）
  $status.add(id, {name, scripts, onTick, ...})  — 添加状态（不去重，旧脚本兼容）
  $status.remove(id, effectName)  — 移除状态
  $status.setStacks(id, effectName, n)  — 设置层数
  $status.getStacks(id, name)/has(id, name)/query(id)  — 状态只读查询
  $call(ref)  — 跨对象脚本调用（效果自动合并）
  $event.emit(type, data)  — 触发事件
  $event.on(type, scriptKey) — 注册持久监听（init 中使用）
  $event.off(handleOrType) — 取消监听（cleanup 中使用）

上下文变量:
  owner  — 效果持有者
  target — 事件目标
  self   — 当前效果自身 { stacks, remainingTime, name }
  event  — 触发事件数据

---

## 八、全局时间系统 (Phase 7e+8)

### 数据模型

```typescript
// SaveProfile — 存档级全局时间
gameTime: GameTime  // { era, year, month, day, weekday, hour, minute }

// StatusEffect — 剩余时间
remainingTime: number | null;  // null = 永久
timeUnit: '回合' | '分钟' | '小时';
```

### 时间推进流程

```
Story AI 输出
  ↓
vars_update Agent 提取
  └── { "delta_time": 180 }  // 分钟
  ↓
AgentOrchestrator Stage 2 后处理
  └── StateManager.applyTimeAdvance(180)
      ├── SaveProfile.gameTime = advanceTime(gameTime, 180)
      ├── 遍历所有 CharacterState.statusEffects
      │   ├── remainingTime === null → 跳过（永久）
      │   ├── timeUnit === '回合' → 跳过（战斗结算管）
      │   ├── timeUnit === '分钟' → remainingTime -= 180
      │   ├── timeUnit === '小时' → remainingTime -= 3
      │   └── remainingTime <= 0 → removeEffect + onRemove 脚本
      └── emit('time_advanced')
```

### 层数控制

| 字段 | 行为 |
|------|------|
| `stackable: false` | 永远 1 层，重复施加只刷新时间 |
| `maxStacks: N` | 累加到 N 停止 |
| 默认 | 无上限累加 |
```
