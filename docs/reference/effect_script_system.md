# 词条效果 & 脚本系统 (Phase 7e+8)

> 引擎参考文档。描述效果系统的四层架构：声明式词条(EffectParser) → 执行运行时(EffectRuntime) → 事件总线(EventBus) → AI 可编程脚本(ScriptExecutor)

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
  └── 递归处理 childEffects (连锁效果)
```

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
// 10 种事件类型
type GameEventType =
  | 'character_action' | 'combat_action' | 'craft_action'
  | 'status_effect' | 'variable_change' | 'plot_trigger'
  | 'item_use' | 'skill_use' | 'location_change' | 'system'

// 实例化 — 每个 SaveSlot 独立
const bus = new EventBus({ saveId })
bus.subscribe('combat_action', (event) => { ... })
bus.emit({ type: 'status_effect', data: { ... } })
```

**引擎 emit 事件节点**：

| 模块 | 事件 | 时机 |
|------|------|------|
| `state-manager` | `status_effect` | addEffect / removeEffect 后 |
| `state-manager` | `variable_change` | set_variable / delta_variable 后 |
| `combat-resolver` | `combat_action` | 攻击/技能使用后 |
| `craft-resolver` | `craft_action` | 制作完成后 |
| `plot-engine` | `plot_trigger` | 剧情条件触发后 |

---

## 五、Layer 4: 脚本沙盒 (`script-executor.ts`)

AI 用 `$` API 编写效果逻辑，引擎在沙盒中执行。

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

```typescript
executeScript(script, context)
  └── buildSandbox()
        ├── owner / target / event / self   ← 上下文变量
        ├── $dice:   { d20, d100, roll }    ← 骰子系统
        ├── $resource: { getHp, getMaxHp, modifyHp, modifyStat }
        ├── $status: { add, remove, setStacks, getStacks }  ← 套娃核心
        ├── $event: { on, off, emit }       ← 🆕 持久订阅 + 瞬时事件
        └── $call:  (ref) => any            ← 🆕 跨对象脚本调用
```

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

```typescript
ScriptEffects {
  adds:        { charId, effect }[]         // $status.add()
  removes:     { charId, effectId }[]       // $status.remove()
  stackSets:   { charId, effectId, stacks }[] // $status.setStacks()
  events:      { eventType, data }[]        // $event.emit()
  hpChanges:   { charId, amount }[]         // $resource.modifyHp()
  statChanges: { charId, stat, amount }[]   // $resource.modifyStat()
  subscriptions:   { eventType, scriptKey }[]  // 🆕 $event.on()
  unsubscriptions: string[]                    // 🆕 $event.off()
}
  stackSets:   { charId, effectId, stacks }[] // $status.setStacks()
  hpChanges:   { charId, amount }[]         // $resource.modifyHp()
  statChanges: { charId, stat, amount }[]   // $resource.modifyStat()
  events:      { eventType, data }[]        // $event.emit()
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

$ API 可用:
  $dice.d20() / $dice.d100()  — 骰子
  $resource.modifyHp(id, amount)  — 修改HP (负数为伤害)
  $resource.modifyStat(id, stat, amount)  — 修改属性
  $status.add(id, {name, scripts, onTick, ...})  — 添加状态（scripts 只用 @parent 引用）
  $status.remove(id, effectName)  — 移除状态
  $status.setStacks(id, effectName, n)  — 设置层数
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
