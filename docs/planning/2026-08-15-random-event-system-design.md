# 随机事件系统 v1 设计（2026-08-15）

> 剧情系统旗下的支线/随机事件子系统。**可独立于剧情系统本体开关**（`plotSettings.mode === 'off'` 时照常工作）。
> 状态：**已实施（2026-08-15，W1-W3 全波次落地），待真机验证**；裁定记录见 §13。

## 0. 一句话架构

**Code 端确定性调度器**（每事件独立 MTTH + 权重修正 + 共享全局冷却 + 首访强制，种子化随机可重放）把「当前可触发事件候选池」渲染成一个自带外壳的提示词块注入 story（**不新开 Agent**）；AI 在叙事方便的时机挑一个编织进正文，并以 `<event_trigger name="事件名"/>` marker 回执；Code 按名字结算（清池 + 起冷却 + 记档案）。事件定义是**纯本地数据**（内容包分节 / 工坊第三内容轴），权重逻辑声明式优先（ADR-20），二创零改码。

### v1 功能清单 ↔ 落点

| 需求                                            | 落点                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 每事件独立 MTTH（如 30 天）                     | `RandomEventDef.trigger.mtthDays`，逐天掷骰 `p = min(1, w / mtthDays)`                                   |
| 共享全局冷却                                    | `worldFlags.randomEvents.lastTriggerDay` + pack 级 `globalCooldownDays`                                  |
| 每事件独立权重修正（不在某地 ×0 / 等级>5 ×1.3） | `RandomEventDef.weights: WeightModifier[]`（声明式条件 DSL）                                             |
| 可用性硬门槛（available）                       | `RandomEventDef.available: EventCondition`，不满足完全不进考虑（§3.1 分工说明）                          |
| 二创独特事件 + 部分随机组装事件                 | 事件定义 JSON（内容包 `randomEvents` 分节）+ `slots` 槽位表（种子化采样固化进简报）                      |
| 不新开 Agent、AI 有空时才触发                   | `{{RANDOM_EVENTS}}` 占位符注入 story 预设；候选池**跨回合驻留**直到触发/过期                             |
| 给 AI 候选列表按优先级+剧情自选                 | 注入块含全部候选（名字/优先级/简报），指令「至多触发一个，不方便可不触发」                               |
| 作者点名地点首访必触发                          | `location_change` 钩子 → scope 命中的 `first_visit` 事件强制入池（绕过 MTTH/冷却），足迹于**触发时**记账 |
| 独立于剧情系统开关                              | 全局设置 `randomEventsEnabled`；调度/注入/回执三面均不依赖三个 plot Agent                                |

## 1. 范围

### 铁则

1. **逻辑键 = 事件名，AI 永不见 id**（数据字段规范铁律 1；同 `plot_pre_check` 的 `resolveEventByTitle` 先例）。
2. **Code 掷骰、AI 演绎**（ADR-11）：何时可触发、候选有哪些、冷却与足迹记账全归 Code；触发时机与叙事内容全归 AI。Code **绝不**替 AI 写正文，也绝不因 AI 不触发而报错。
3. **随机必须种子化**（承 `ejs-rng.ts` 文件头的裁定）：快照回退/重发后重放同一存档点必须产出同一候选池。零 `Math.random`、零时钟。
4. **算不出来保持原值，绝不凭空造**（承天气 §7 处置）：定义缺失/解析失败 → 该条静默跳过 + console 诊断，池子其余部分照常。
5. **触发结算不产生任何数值副作用**（承 ADR-28 世界书理念）：v1 事件没有 `onTrigger` 效果表——AI 把事件演进正文后，状态变化由既有的 dispatcher/vars_update 管线自然捕获。事件系统只记「触发过」这一事实。

### 明确不做（v1 非目标）

- ❌ 不新开 Agent（也不复用 plot_pre_check——那会绑死在剧情系统开关上，见 §9）。
- ❌ 不做事件链/多阶段事件（触发后续走剧情或任务系统；事件定义可在 brief 里建议 AI 挂任务）。
- ❌ 不做触发时的自动 VarsPatch / 掉落 / 战斗唤起（AI 叙事 → 既有管线捕获；`<combat_trigger>` 等 marker story 本来就会写）。
- ❌ 不做脚本权重钩子（QuickJS）——声明式条件 DSL 先行（ADR-20），脚本口子列为 P2（§8.3）。
- ❌ 不做工坊第三内容轴的完整安装流（P2，§8.2）；v1 一等格式只有内容包分节。
- ❌ 不做事件图鉴/历史 UI 面板（P2；v1 只有设置开关 + 开发者模式下的池子诊断）。
- ❌ 不做通用首访与域级首访（裁定 §13-3/§13-7）：`first_visit` 的 `scope` **必填**，只认作者点名的地块；普通新地点不起事件是**有意语义**；域级（初入某国）进 P2。

## 2. 命名与词汇（防撞名）

「事件」在本仓已有三个占用者：`PlotEvent`（剧情大事件）、`GameEvent`（EventBus 状态变更事件）、世界书分区 `'event'`。本系统一律叫**随机事件（Random Event）**：

| 词                                 | 含义                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| **随机事件定义（RandomEventDef）** | 内容侧的一条事件模板（名字/MTTH/权重/槽位/简报），纯数据        |
| **候选池（pending pool）**         | Code 已判定可触发、等 AI 认领的事件实例列表，跨回合驻留         |
| **入池（arm）**                    | MTTH 掷中或首访强制，把一条定义实例化（槽位采样固化）放进候选池 |
| **触发（trigger）**                | AI 输出 `<event_trigger>` marker，Code 结算                     |
| **全局冷却**                       | 任一事件触发后，所有 MTTH 掷骰暂停 N 天（首访强制不受限）       |
| **足迹（visited）**                | 首访事件的已访问地点集合，按地点键记账                          |
| **地点键（placeKey）**             | 落位成功 → 地块名；失败 → 位置路径最深段。足迹与首访判定的键    |

模块前缀 `random-event*`，类型分册 `types-random-events.ts`，flags 命名空间 `worldFlags.randomEvents`。
根 `CONTEXT.md`「随机事件系统」词汇节已随本设计写入（2026-08-15）。

## 3. 数据模型

### 3.1 事件定义（内容侧，纯数据）

新建分册 `src/sillytavern/types-random-events.ts`（不 import `types.ts`，先例 `types-map.ts:1-26`）：

```ts
/** 一条随机事件定义。全部叙事字段中文自由文本，引擎零解释。 */
interface RandomEventDef {
  name: string; // 逻辑键（唯一），AI 面向
  priority?: number; // 默认 0；越大越优先（进注入块给 AI 参考 + 池满淘汰依据）
  brief: string; // 给 AI 的事件简报，可含 {{slot.槽名}} / {{place}} 占位
  detail?: string; // 更长的演绎指引（可选，注入块折叠展示）
  trigger:
    | { type: 'mtth'; mtthDays: number } // 平均每 mtthDays 天触发一次（权重 ×1 时）
    | { type: 'first_visit'; scope: PlaceFilter }; // 首访强制；scope 必填，只认点名地点（裁定 §13-3）
  available?: EventCondition; // 可用性硬门槛：不满足时事件完全不进考虑（不掷骰/不入首访选择/在池即撤）
  once?: boolean; // 全存档只触发一次（独特事件）
  cooldownDays?: number; // 个体冷却（与全局冷却独立，可选）
  weights?: WeightModifier[]; // 权重修正链，乘法叠加；任一 ×0 即不可触发
  slots?: Record<string, SlotTable>; // 组装槽位：入池时种子化采样并固化进 brief
}

interface WeightModifier {
  when: EventCondition;
  multiply: number;
}

interface SlotTable {
  pick: string[];
  weights?: number[];
} // 加权抽一条

interface PlaceFilter {
  anyOf: string[];
} // 地点键匹配（地块名/位置段）；v1 只做地块级，域级进 P2（裁定 §13-7）

/** 声明式条件 DSL —— 全部可选字段，同一对象内多字段 = AND */
interface EventCondition {
  location?: { anyOf?: string[]; noneOf?: string[] }; // 对地点键 + 位置路径全段做包含匹配
  journey?: boolean; // 是否在途（worldFlags.map.journey 存在）
  playerLevel?: { gte?: number; lte?: number };
  time?: { seasonAnyOf?: string[]; timeOfDayAnyOf?: string[] };
  var?: { path: string; eq?: unknown; gte?: number; lte?: number; exists?: boolean };
  quest?: { name: string; statusAnyOf: string[] };
  char?: { name: string; affectionGte?: number; affectionLte?: number };
  all?: EventCondition[];
  any?: EventCondition[];
  not?: EventCondition;
}
```

**`available` 与 `weights` ×0 的分工**：两者都能让事件不触发，但语义不同——`available` 是**可用性硬门槛**（事件是否解锁/存在于本局叙事，先于一切求值；不满足时 MTTH 不掷骰、首访不选它、已入池的条目也撤下），`weights` ×0 是**情境权重**（事件存在，只是此时此地概率为零）。首访事件没有权重链，`available` 是唯一能门它的方式（如「序章完成后，初到王都才有加冕日人潮事件」）。撤下 forced 条目时**不记足迹**——条件重新满足后再次到达仍会强制入池。

**P2 预留字段名**（v1 类型**不声明**，此处记档防撞）：`onTrigger`（声明式效果表，裁定 §13-1）、`weightScript`（QuickJS 权重钩子，§8.3）、`scope.granularity`（域级首访，裁定 §13-7）。

组装事件示例（遭遇神秘商人）：

```jsonc
{
  "name": "神秘商人",
  "priority": 2,
  "trigger": { "type": "mtth", "mtthDays": 30 },
  "available": { "var": { "path": "sys.序章完成", "exists": true } },
  "slots": {
    "货色": { "pick": ["来历不明的古代遗物", "违禁的炼金药剂", "一张残缺的藏宝图"] },
    "态度": { "pick": ["殷勤过头", "爱答不理", "神经兮兮"], "weights": [2, 1, 1] },
  },
  "brief": "一名{{态度}}的神秘商人拦住去路，兜售{{货色}}。他似乎认得玩家的来历。",
  "weights": [
    { "when": { "location": { "noneOf": ["永夜盟约"] } }, "multiply": 1 },
    { "when": { "location": { "anyOf": ["永夜盟约"] } }, "multiply": 0 },
    { "when": { "playerLevel": { "gte": 5 } }, "multiply": 1.3 },
    { "when": { "journey": true }, "multiply": 2 },
  ],
}
```

### 3.2 每存档状态（`worldFlags.randomEvents`）

同一分册内定义。**与 `worldFlags.map` 契约相反**：这里存的是**事实不是派生态**（足迹与触发档案不可重算），因此**没有 packStamp 自愈清空**——定义包更新后按名字续用，名字对不上的 pending 条目按铁则 4 静默剔除。

```ts
interface RandomEventSaveFlags {
  pending?: PendingRandomEvent[]; // 候选池（上限 3，priority 高者留）
  lastTriggerDay?: number; // 全局冷却锚点（gameDay 整数）
  lastRollDay?: number; // 已掷到哪一天（防漏掷/重掷；首次 ensure 时置当天，不补历史）
  visited?: string[]; // 首访足迹（地点键集合）
  fired?: Record<string, { count: number; lastDay: number }>; // 触发档案（once 与个体冷却的依据）
}

interface PendingRandomEvent {
  name: string;
  armedDay: number;
  expiresDay: number; // armedDay + offerTtlDays；首访强制条目不设过期
  forced?: boolean; // 首访强制
  placeKey?: string; // 首访条目所属地点键（离开即撤池）
  priority: number;
  brief: string; // 槽位已采样固化后的简报（入池即定型，重放稳定）
}
```

读写入口照 `save-profile.ts:245-284` 地图节的四件套：键常量 `RANDOM_EVENT_FLAGS_KEY = 'randomEvents'` 本节私有、`getRandomEventFlags` 返回新空袋、`updateRandomEventFlags` **整份覆盖**、存量记录 `worldFlags == null` 兜底。随 `saveProfiles` 自动进 FullBackup，**零新 Dexie 表**。

### 3.3 内容包分节（一等二创格式）

`types-content.ts` 的 `ContentPack` 增第 13 分节：

```ts
randomEvents?: PackRandomEventsSection;
// interface PackRandomEventsSection {
//   config?: { globalCooldownDays?: number; offerTtlDays?: number; maxPending?: number };
//   defs: RandomEventDef[];
// }
```

三态语义照旧（`undefined` 别动 / `[]` 清空 / rows 替换）；`PackInstallPlan.sections` 加对应格。
容错解析纯函数 `coerceRandomEventPack`（**永不抛**，坏定义整条跳过 + 诊断），先例 `coerceMapPack` / `parseImageDialects`。
**引擎仓零内置事件**（承内容-引擎分离 v1.3）：默认事件定义在内容仓 pack 里作；空分节 → 全部钩子整段 no-op（先例 `isEmptyMapPack`）。
配置默认值（pack 未给时引擎兜底，裁定 §13-6）：`globalCooldownDays = 3`、`offerTtlDays = 5`、`maxPending = 3`。

## 4. 调度器（Code 端，纯函数核）

新模块 `src/sillytavern/random-event-scheduler.ts`（纯函数，**零中文字面量**——全部文案来自定义数据；随图/随包零改码的同款结构闸门）+ 运行时单例 `random-event-runtime.ts`（`installRandomEventDefs` / `getRandomEventDefs`，先例 `map-runtime.ts`）。

### 4.1 MTTH 掷骰（逐天走）

挂在 `StateManager.applyTimeAdvance`（`state-manager.ts:1717`）里 `syncMapWeather` 之后，照三条钩子的统一形状（空包 no-op / ensure 自愈 / 有变化才落库 / 整段 try-catch）：

```
对 (lastRollDay, currentDay] 里的每一天 d：
  若 d - lastTriggerDay < globalCooldownDays → 跳过（全局冷却中）
  对每条 trigger.type === 'mtth' 的定义：
    once 已触发 / 个体冷却未过 / 已在池中 → 跳过
    available 不满足 → 跳过（硬门槛，先于权重求值）
    w = ∏ 命中的 weights[].multiply × 频率系数（设置项，默认 1）
    w <= 0 → 跳过
    p = min(1, w / mtthDays)                    // 权重放大概率 ≡ 缩短有效 MTTH
    rng = createEjsRng(buildRandomEventSeed(saveId, def.name, d))
    rng.chance(p) → 入池（同一 rng 继续采样 slots，固化 brief）
lastRollDay = currentDay；池满按 priority 淘汰（forced 永不被淘汰）
```

- **种子三元组** `(saveId, eventName, gameDay)`，长度前缀编码防撞种（照抄 `buildWeatherSeed`，`map-weather.ts:193-198`）。回退重发 → 同一天同一事件掷出同一结果。
- `gameDay = floor(toEpochMinutes(gameTime) / 1440)`（先例 `state-manager.ts:1647`）。一次 `delta_time` 可跨多天，所以是**逐天迭代**而不是布尔跨天。
- **简化裁定**：跨多天时权重用**当前（到达时）上下文**一次求值，不重建每一天的历史上下文。10 天旅程 = 用到达日语境掷 10 次。误差可接受，换来零历史回放成本。
- 条件求值的输入是一个只读快照（位置/地点键/等级/时间/变量/任务/好感），由 StateManager 侧组装后交给纯函数——分寸同 `projectLocationFlags` 写在 state-manager 而非纯函数叶的理由（要碰中文变量路径与 profile）。

### 4.2 首访强制

挂在 `applySetLocation → syncMapLocation`（`state-manager.ts:1167/1609`）之后的同层新钩子：

```
placeKey = 落位成功 ? 地块名 : 位置路径最深段
若 placeKey ∉ visited 且池中无该 placeKey 的 forced 条目：
  选 scope 命中且 available 满足的 first_visit 定义（多条命中取 priority 最高；
  没有命中 → 什么也不做——普通新地点不起事件是有意语义，裁定 §13-3）
  强制入池：forced=true、无 expiresDay、绕过全局冷却与 MTTH、brief 里 {{place}} 换成 placeKey
换地点时：撤掉池中 placeKey ≠ 新键的 forced 条目（人都走了，首访遭遇不再成立）
```

**足迹在触发时记账，不在入池时**：AI 若一直没触发、玩家离开又回来，会再次强制入池——这才守得住「点名地点第一次到必定触发」。反向风险（AI 屡教不改导致重复入池）由注入块的强制话术兜底（§5.1）。

- 地点键选**地块名而不是 tileId**：足迹要在换图（packStamp 变更、派生态清空）后存活，名字比编号稳定。
- 落位失败保底用位置路径最深段——首访语义降级但不失效（永不模糊匹配，承 ADR-31）。

### 4.3 池子保洁

每回合提交胶水层（`agent-orchestrator.ts:1053-1090` 那一排，形状照 `syncMapJourney`：try/catch + warn，不污染 `onStateCommitError`）跑一次轻量 `syncRandomEvents`：剔除过期（`gameDay > expiresDay`）、定义已不存在、`available` 当前不满足（**含 forced**——硬门槛高于首访强制，撤下且不记足迹）、权重当前为 0（forced 除外）的条目。渲染侧（§5.1）只过滤不写库。

## 5. AI 集成

### 5.1 读侧：`{{RANDOM_EVENTS}}` 占位符 → story

照 `{{MAP_CONTEXT}}` 端到端的三条纪律（块自带 XML 外壳 / 数据面纯函数、措辞在 resolver / 供值必须在 `buildContext`）：

1. **供值**：`GamePipeline.buildContext()` 加 `randomEventFlags: getRandomEventFlags(profile)`（先例 `game-pipeline.ts:812-813` 的 mapFlags，同款源码断言测试盯死）。
2. **数据**：纯函数 `buildRandomEventOffer(defs, flags, gameDay)` → 过滤后的候选快照（不产中文）。
3. **渲染**：`PLACEHOLDER_REGISTRY.RANDOM_EVENTS` resolver 产出：

```
<random_events>
以下事件当前可以触发。请在叙事自然、不打断当前剧情节奏的时机，选择其中至多一个
编织进正文（按优先级与当前剧情契合度自行判断；本回合不方便可以不触发，列表会保留）。
触发时：把事件内容自然写进正文，并在回复末尾输出 <event_trigger name="事件名"/>（名字逐字一致）。
[!] 标记的是首次到访事件，必须尽快触发（本回合优先）。
- [!]〔优先级 9〕初临此地：（简报……）
- 〔优先级 2〕神秘商人：一名殷勤过头的神秘商人拦住去路，兜售违禁的炼金药剂。……
</random_events>
```

池空/系统关闭/**战斗会话活跃** → 返回空串，零 token（先例 `placeholder-registry.ts:566-569`）。战斗静默是裁定 §13-2：战斗期间 MTTH 掷骰照常、候选静默驻池，战斗结束后下一回合恢复注入；判据取 AgentContext 里的战斗会话活跃位（与 `{{RECENT_COMBAT}}` 同源）。4. **到达 story 的三处同步改**（漏一处的症状是静默消失）：

- `STORY_PRESET_PLACEHOLDER_RE`（`agent-templates.ts:600`）加 `RANDOM_EVENTS`；
- `story-preset.json` 的占位与 `fallbackSystemPrompt`【子系统标记】段加 `<event_trigger>` 教学文案；
- 设置页 `placeholder-catalog.ts` 补条目（文件头明写「两边会漂，加占位符时两处都要动」）。

不注给 dispatcher——事件的消费者只有 story 一个，单通道免双写。剧情系统开着时，块首追加一句「触发时机须与当前剧情推进兼容」；plot_pre_check / plot_post_check 的职责边界不变（随机事件不是 PlotEvent，post_check 不管它的收尾）。

### 5.2 写侧：`<event_trigger>` marker → 结算

- **注册**：`marker-protocol.ts` 的 `MARKER_SPECS` 加一行（`fields: name`、`emptyBody: true`）——扫描器/联合类型全由这张表推导（`:239-246`），types.ts 判别联合与 `OrchestratorEvents` 各加一格。
- **消费**：`processStageMarkers` Stage 1（story 输出）过滤 `event_trigger` → 新回调 `onEventTrigger(name)` → `game-pipeline` handler。
- **结算入口**：StateManager 新增命名方法 `confirmRandomEventTrigger(name)`（与 `applyTimeAdvance` 同档的命名入口，**不做成 StatePatchOp**——它不是 AI 面向的通用状态原语，不该让 vars_update 也能发；ADR-21 的「唯一写入口」语义由 StateManager 方法承接）。结算五步：
  1. 按名字在池中解析；不在池中 → warn 忽略（AI 幻觉触发不奖励）；
  2. `fired[name]` 计数 + `lastDay`；
  3. `lastTriggerDay = gameDay`（全局冷却起算）；
  4. 出池：**清掉全部非 forced 条目**（一次触发一波，避免连环轰炸，裁定 §13-5），forced 条目保留；forced 自己被触发时把 `placeKey` 记入 `visited`；
  5. emit `GameEvent`（新类型 `'random_event'`），效果系统的 `$event.on` 订阅者可以吃到。
- 系统关闭时收到 marker → warn 忽略。
- 不写 memory：story 正文本身会被 memory_summary 收进记忆，事件系统不重复记账（铁则 5）。

## 6. 开关与设置

**v1 采用全局设置**（localStorage，`UiSettings`，裁定 §13-4），不做每存档字段：

| 字段                            | 默认   | 说明                                                               |
| ------------------------------- | ------ | ------------------------------------------------------------------ |
| `randomEventsEnabled: boolean`  | `true` | 总开关。关 = 调度 no-op（保留 flags 不清）+ 注入空串 + marker 忽略 |
| `randomEventsFrequency: number` | `1`    | 频率系数（0.5 / 1 / 2），乘进每次掷骰的 w                          |

理由：随机事件是「口味开关」，玩家中途想关就关（比照 `beautifierEnabled` / `imageGenMode` 一档）；不涉及存档结构，零迁移。引擎读取经 `engine-settings.ts` 加两项 + `main.ts` provider 转发（现成注入缝）。设置 UI 放 `PlotSection.vue` 内新「随机事件」子块（语义上归剧情家族，开关彼此独立）；`settings-types.ts` 声明 + `getDefaults()` 默认值两处同步（🔴 漏第二处 = 默认 undefined）。

与剧情系统的独立性验收：`plotSettings.mode === 'off'` 时——调度器照跑（挂在 StateManager，不在 plot agent 链上）、注入照发（story 恒在）、marker 照收（orchestrator Stage 1 恒在）。

## 7. 快照回退一致性

- 掷骰种子只依赖 `(saveId, eventName, gameDay)` → 回退后重放同一天必然同结果。
- `worldFlags.randomEvents` 随 `SaveProfile` 存活；**实施期必须核实** Phase 10k 快照是否覆盖 SaveProfile/worldFlags 的回滚。若不覆盖，回退后池子可能带着「未来」的条目——处置同天气（同为 worldFlags 住户，天气已接受此误差）：`lastRollDay > currentDay` 时视为回退，重置 `lastRollDay = currentDay` 并清非 forced 池。这条防御逻辑无论核实结果如何都写上（成本一个 if）。

## 8. 二创面

### 8.1 v1：内容包分节（已在 §3.3）

创作者只写 JSON：独特事件（`once: true` + 具体 brief）、组装事件（`slots` + 模板 brief）、解锁门槛（`available`，如某剧情变量立起后才进考虑）、地点限定（`weights` 里 `location` ×0/×N）、角色关联（`char` 条件）、等级门槛（`playerLevel`）。全部本地、全部声明式、坏定义单条跳过不连坐。

### 8.2 P2：工坊第三内容轴

`WorkshopPayload` 加 `randomEventDefs?`，`planInstall` 纯函数范式照旧（store 照单写行）；工坊分区是信任域边界——工坊来源的定义与 pack 来源合并时**同名后装覆盖、来源可溯**（`extra.workshop` 溯源先例）。声明式 JSON 是纯数据，无执行面，安全审计面为零。

### 8.3 P2：脚本权重钩子

若声明式 DSL 撑不住二创想象力，再开 `weightScript?: string` 口子：**只走 `script-backend.ts` 的 QuickJS 后端**（fail-closed、墙钟 50ms、内存 32MB；绝不 `new Function`——`plot-engine.evaluateCondition:27` 那个裸 `new Function` 是历史遗留，不是先例），沙盒注入只读快照 + 种子化 rng（照 `ejs-runtime.buildSandboxArgs` 的样子把 `createEjsRng` 实例交进去，保确定性）。

## 9. 为什么不复用 plot_pre_check（决策记录）

侦察确认 `plot_pre_check` 的「`{{PLOT_EVENTS}}` 清单注入 → `triggeredEvents[].title` 选回 → `resolveEventByTitle` → `preCheckPlot`」是现成的同构协议，复用几乎零引擎改动。不复用的三个理由：

1. **开关耦合**：`plotSettings.mode === 'off'` 时三个 plot Agent 被 orchestrator 禁用（`agent-orchestrator.ts:209-218`），随机事件会陪葬——直接违反本设计第一需求。
2. **时机语义不同**：pre_check 跑在 story 之前的 Stage 0，是「本回合就裁定触发」；随机事件要的是「AI 有空时再触发」的跨回合驻留，塞进 pre_check 契约会污染它的即时性。
3. **实体语义不同**：PlotEvent 是大纲树上的剧情节点（有父子/时间窗/世界线传播），随机事件是无状态机的一次性遭遇。硬套会把 `postCheckPlot` 的收尾义务也背上。

同理不新开 Agent（用户明确要求 + 每回合多一次 LLM 调用的成本不值得）。

## 10. 测试

| 面                      | 断言                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coerceRandomEventPack` | 永不抛；坏定义跳过；三态语义                                                                                                                                                                                     |
| 调度纯函数              | 同种子同结果（回放）；逐天迭代覆盖跨多天 delta_time；available 不满足不掷骰、在池即撤（含 forced 且不记足迹）；权重 ×0 不入池；全局冷却压制 MTTH 但不压制首访；池满按 priority 淘汰且 forced 免疫；once/个体冷却 |
| 条件 DSL                | 每种条件 + all/any/not 组合；未知字段忽略不抛                                                                                                                                                                    |
| 首访                    | 触发才记足迹；离开撤 forced；available 过滤定义；scope 必填、同键多定义取高 priority、无命中不起事件；落位失败降级位置段                                                                                         |
| marker 往返             | `MARKER_SPECS` 扫描 → `confirmRandomEventTrigger` 五步；不在池中忽略；关闭时忽略                                                                                                                                 |
| 注入                    | 池空/关闭/战斗会话活跃 → 空串；战后恢复注入；buildContext 供值源码断言（照 map-context 那条测试）                                                                                                                |
| 结构闸门                | `random-event-scheduler.ts` 等纯函数叶零中文字面量、零 `Math.random`/时钟（照 `map-weather.test.ts`）                                                                                                            |
| 编码                    | 新 JSON 样例过 `tests/encoding-invariants.test.ts` 三判据                                                                                                                                                        |

## 11. 实施切片（lean-delegation 波次草案）

| 波                     | 任务                                                                                                                                                                                                                                      | 产物                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| W1（纯函数层，可并行） | 类型分册 + coerce + 调度器 + 条件 DSL + offer 快照，全量单测                                                                                                                                                                              | `types-random-events.ts` / `random-event-pack.ts` / `random-event-scheduler.ts` / `random-event-context.ts` |
| W2（接线层，串行）     | save-profile 四件套 → StateManager 两钩子 + `confirmRandomEventTrigger` → runtime 单例 + content-store 第 13 面 → buildContext 供值 + resolver + marker + orchestrator 回调 + pipeline handler                                            | 引擎全接通                                                                                                  |
| W3（外围）             | settings 两字段 + PlotSection 子块 + engine-settings 转发；story-preset 教学文案 + `STORY_PRESET_PLACEHOLDER_RE` + placeholder-catalog；内容仓样例事件包；AGENTS.md 进度行 + 设计约定 ADR 行 + CHANGELOG（CONTEXT.md 词汇已随本设计写入） | 可真机                                                                                                      |

每波末跑 `npm run typecheck` + `npm run test -- --run`；W2 里 Dexie 零新表所以无版本升级，但 `SaveProfile.worldFlags` 新命名空间要过 FullBackup 往返测试。

## 12. 已知风险

- **AI 不认领**：候选池驻留 + TTL 过期是设计内行为；若真机发现 AI 长期无视，调 story 预设话术（内容侧），不加 Code 强制。
- **AI 幻觉触发不在池中的事件**：warn 忽略（§5.2 步 1）；若真机高频出现，说明注入块「逐字一致」话术不够醒目。
- **跨多天权重用到达日上下文**（§4.1 简化裁定）：长途旅行时"在城里才能发生"的事件可能在途中被掷中——由 `journey` 条件反向对冲（城内事件写 `{ journey: true } → ×0`），样例包要带示范。
- **快照回退覆盖面未核实**（§7）：防御 if 已设计，W2 实施时核实并记录。

## 附：本设计吸收的关键侦察结论（防遗忘）

- 天气系统的五条范式（纯函数零存储采样器 / 戳判据 / 冲突 AI 赢 / 算不出保原值 / 种子三元组长度前缀编码）是本设计 MTTH 面的直接母版（`map-weather.ts` / `state-manager.ts:1560-1671`）。
- 全仓目前**零** visited/首访跟踪；`worldFlags.map` 按契约随 packStamp 自愈清空，所以足迹必须住自己的命名空间（`types-map.ts:277-310`）。
- story 被预设短路，`systemPrompt` 写字不生效；占位符能穿透预设但要同步 `STORY_PRESET_PLACEHOLDER_RE`（`agent-templates.ts:600-679`）。
- `MARKER_SPECS` 是 marker 唯一真源，加一种只动一张表（`marker-protocol.ts:147-246`）。
- `buildPassSeed` 回合号取历史长度，随快照回退回旧值——这是「回退重放一致」在本仓已被验证的机制（`game-pipeline.ts:837`）。
- `agent-config.json` 现存 47 个 U+FFFD 是历史遗留，W3 改它时别当成自己弄坏的，也别顺手全修（单独议题）。

## 13. 裁定记录（2026-08-15 grilling 会话，主人逐条拍板）

1. **副作用面**：v1 纯叙事零副作用，`onTrigger` 声明式效果表进 P2（类型不声明，字段名记档防撞，见 §3.1）。
2. **战斗互斥**：战斗会话活跃时注入**全面静默**（零 token），MTTH 掷骰照常、候选静默驻池，战后下一回合恢复。
3. **首访语义收窄**：`first_visit` 的 `scope` **必填**，只做作者点名的特定地点；否决「引擎内置通用首访」与「样例包通用首访兜底」两案——普通新地点不起事件是有意语义。
4. **开关层级**：全局设置（`randomEventsEnabled` + `randomEventsFrequency`），否决每存档 metadata 案与混合案。
5. **清池策略**：触发即清全部非 forced 候选（一次触发一波），否决「只移除被触发者」。
6. **默认参数**：冷却 3 天 / TTL 5 天 / 池上限 3 / 频率三档 0.5×/1×/2×（本稿推荐组，否决更克制与更热闹两组）。
7. **首访粒度**：v1 只做地块级；域级（初入某国）进 P2，`scope.granularity` 预留名。
8. **P2 排序**：**暂缓未排定**（工坊第三内容轴 / 脚本权重钩子 / 事件图鉴面板 / onTrigger 效果表），v1 真机验证后再议。
