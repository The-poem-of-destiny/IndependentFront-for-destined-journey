# EJS 能力面设计 v1.0 —— 设计与实施记录

> **作者契约已迁移**：[世界书 EJS 与输出美化正则创作指南](../reference/worldbook-ejs-regex-authoring-guide.md) 是创作者行为规范，`public/poem-ejs.d.ts` 是签名配套。本文件保留设计理由、实施切片和历史拟议值；与作者指南冲突时以作者指南为准。
>
> **状态**：✅ **T0-T8 全部实施完成（2026-08-01）**，真机走查未做。承 ADR-30（两轴契约）与 `docs/planning/2026-07-31-workshop-phase2-ejs-design.md`（工坊 P2）。
> **定位**：本文件是 EJS 能力面的设计与实施记录。上游（SillyTavern + 酒馆助手 + MVU）的 API 只以**兼容别名层**形式承接存量内容，不是设计约束。
>
> **前置阅读**：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`（D1-D10 契约）、
> `docs/reviews/2026-08-01-repository-review.md`（SEC-02）、`src/sillytavern/AGENTS.md`「事件驱动架构」（2026-08-13 自根 `AGENTS.md` 迁入）。

---

## 0. 为什么要有这份文件

工坊 P2 上线时的沙盒是**注入表约束**：给什么就只能用什么。安全审计（SEC-02）指出这不是边界——
`stats.constructor.constructor("return globalThis")()` 一行拿回真全局，与注入表无关。

修法有两步，本文件负责**第二步**：

1. **换执行约束**（另文）：AST 白名单 + 计算下标守卫 + 执行预算，把「能力来自 realm」这条路封死；
2. **定能力面**（本文件）：既然能力必须逐条显式授予，那就把这张表设计好——**不是够用就行，是让创作者愿意用**。

真机语料实测（`E:\Photos\SillyTarvern\SillyTavern` 三本命定之诗世界书，754 条目 / 109 条含 EJS / 1524 块）
证明：**真实内容需要的每一样东西都是窄能力，没有一处需要环境权限**。详见 §9 语料依据。

---

## 0.1 求值后端裁定（2026-08-01，主人拍板）

**结论：生产后端走 QuickJS（wasm，主线程），不做 AST 白名单静态分析器。**

前提变化：`AsyncFunction` 编译是**兼容性要求**（真机 3 条 `await getwi(...)`），装配链本来就要改成
「异步预渲染 + 同步 resolver」。这一笔付掉之后，QuickJS 相对 AST 方案的架构增量≈0，而它**删掉**
后者的全部复杂度：

| AST 方案要建的                                                           | QuickJS 下                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| JS 静态分析器（标识符白名单 / 禁 `.constructor`·`eval`·`Proxy`·`class`） | 不需要——guest realm 里 `Object.constructor.constructor` 拿到的是 **guest 自己的** Function，编译出来的还是 guest 代码，照样关着 |
| `__idx` 计算下标守卫（真机 31 条目要它）                                 | 不需要——guest 内污染 guest 原型只影响 guest；出境由 `ejs-vars-diff` 的 `DANGEROUS_KEYS` 把关                                    |
| `__tick` 循环注入                                                        | 不需要，interrupt handler 是引擎级                                                                                              |
| 「我们的分析器有没有洞」的长期负债                                       | 消失                                                                                                                            |

且 AST 方案**结构性堵不住**三样东西，QuickJS 有正面答案：

1. **单表达式烧 CPU** —— `/(a+)+b/.test(长串)` 灾难性回溯、`"x".repeat(1e9)`：无循环无调用，
   `__tick` 永远不会被执行到。真机 **19 个条目用正则字面量**，内容作者可写 → 真实 DoS 面。
2. **内存耗尽** —— AST 方案要挡住得把守卫铺满整个标准库；QuickJS 一个内存上限。
3. **递归爆栈** —— QuickJS 可设最大栈深。

**Worker 不是必需**：interrupt handler 在主线程就能掐死死循环，realm 隔离也不依赖 Worker。
跑主线程 = 宿主能力调用**全部同步**（`lore.get` 直接返回），不需要 SharedArrayBuffer / COOP-COEP 头。
将来若要消除 UI 卡顿再搬 Worker，那是性能优化不是安全前提。

**性能不作为选型依据**（主人裁定）：提示装配耗时相对 AI 生成是噪音。但**预算仍必须有**——
见 §6.2 的 pass 级天花板：那不是性能项，是**拒绝服务防线**。

**依赖**：quickjs-emscripten 系（具体包与构建变体在实施期锁定并核对当时文档）。要求：
可设 interrupt handler / 内存上限 / 栈上限、可注入同步宿主函数、可 `executePendingJobs` 泵 Promise。

---

## 1. 设计原则

| #   | 原则                     | 含义                                                                                                                                                                   |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **能力显式授予**         | 沙盒里没有环境权限。每个可调用的东西都在本文件的表里，表外一律 `undefined`                                                                                             |
| P2  | **写只有两个口**         | `vars`（与 AI 共写的叙事变量）+ `local`（条目私有 KV）。**引擎实体一律只读**——角色/物品/任务/资源的变更走 AI 语义 op 与 `StateManager`（ADR-21），EJS 不开第二条写路径 |
| P3  | **永不抛，给安全默认值** | 每个能力遇到缺参/越界/不可见都返回 `''` / `[]` / `{}` / `null`，不抛异常。抛异常会把整条目推去回退（D8），而回退的观感是**模板源码直喂 AI**，比一个空值糟得多          |
| P4  | **只读即孤儿**           | 所有只读投影返回深拷贝孤儿对象。创作者就地改它是合法的（局部整理数据很常见），改动不回流引擎、pass 结束即弃                                                            |
| P5  | **确定性可复现**         | 随机全部走引擎种子源（§7）。同一存档快照回退重放，EJS 产出逐字节一致                                                                                                   |
| P6  | **可探测、可降级**       | 提供 `engine.version` / `engine.has()`。创作者能写「有就用、没有就退」的内容，而不是靠 try/catch 猜（真机语料里作者已经在这么干了）                                    |

**命名约定**：

- 方法名英文小驼峰，**数据键中文**（对齐 `field-enums.ts` 与全项目口径）：`char.get('艾莉亚').生命值`
- **不用 `$` 前缀** —— `$combat`/`$char` 那套是 script-executor 的 Layer 4/5 契约（AI script 用，有副作用、能订阅事件）。
  EJS 面是**装配期、无副作用**的另一套契约，刻意不带 `$` 以示区分（承 P2 设计 D3 的命名澄清）。

---

## 2. 能力面总览

```
只读数值 ── stats      主角/队伍/世界的代码推导数值（扩面，见 §3.1）
共写变量 ── vars       叙事变量空间（= SaveProfile.variables.sys 草稿）
私有存储 ── local      条目/项目私有持久 KV（跨回合）
─────────────────────────────────────────────────────────
只读查询 ── char       角色按名查询（五维/资源/背包/技能/状态/关系）
            world      时间/地点/势力/天气/回合号
            quest      任务列表只读
            lore       跨条目读世界书正文
            chat       近层聊天正文只读
─────────────────────────────────────────────────────────
纯工具  ── fmt        YAML/JSON/数值/表格 格式化
            rng        种子随机（骰子/抽样/洗牌）
            _          lodash 只读子集（26 方法）
─────────────────────────────────────────────────────────
带外    ── ui         给玩家的提示 / 调试日志（不进提示词）
            engine     版本与能力探测
─────────────────────────────────────────────────────────
兼容    ── 别名层      getMessageVar / setvar / TavernHelper / … （§5，仅为存量内容）
原生    ── Math JSON String Number Boolean RegExp Array Object Date(只读构造)
```

**总计 12 个顶层符号 + 别名层**。创作者只需要记住前面 3 个（`stats`/`vars`/`local`）就能写出 80% 的内容。

---

## 3. 逐 namespace 规格

### 3.1 `stats` —— 只读数值面（扩面裁定）

P2 设计 D4 把 `stats` 钉在「资源/等级/五维/命运点数/时间」，把背包/技能/装备/状态效果列为 §5 挂起项。
**本文件裁定：全部纳入。** 理由：真机语料 17 处读 `stat_data.主角.背包/技能/装备/状态效果`，
挂起的实际后果是这些条目全部走守卫默认分支（「当作未持有」）——对创作者是**沉默的错误**，不是降级。

```
stats.主角.生命值 / 生命值上限 / 法力值 / 法力值上限 / 体力值 / 体力值上限
stats.主角.等级 / 生命层级 / 层级数 / 累计经验值 / 升级所需经验
stats.主角.属性.{力量,敏捷,体质,智力,精神,属性点}
stats.主角.金钱
stats.主角.背包[]      → { 名字, 类型, 品质, 数量, 装备槽位, 描述 }
stats.主角.装备{}      → { 武器: 名字, 头部: …, … }（背包里 装备槽位 非空者的索引视图）
stats.主角.技能[]      → { 名字, 类型, 品质, 描述 }
stats.主角.状态效果[]  → { 名字, 类型, 剩余回合, 描述 }
stats.主角.登神长阶    → { 已开启, 要素[], 权能[], 法则[], 神位, 神国 }
stats.队伍[]           → 在场同伴的同构精简投影（名字/生命值/生命值上限/等级/生命层级）
stats.命运点数
stats.世界.时间        → '复兴纪元001年-05月-24日-周日-15:30'（引擎规范串）
stats.世界.地点 / 势力 / 天气 / 时段     （时段 = 拂晓/上午/…，取 getTimeOfDay）
stats.世界.回合         → number，等价 world.回合
```

**边界**

- 深拷贝孤儿（P4）。**刻意不 freeze** —— 语料存在「读出来做局部数组操作再判断」的模式。
- 「写了不生效」由拷贝语义保证，不报错、不警告（与上游语义一致，创作者预期内）。
- 数值口径全部来自引擎纯函数（`resource-calc` / `tier-constants` / `time-system`），**EJS 不做数值推导**。
- ⚠️ 体积：背包/技能可能上百条。`stats` 每 pass 克隆一次——实测计时进验收（§11 切片 T3）。

### 3.2 `vars` —— 共写叙事变量空间

契约不变（ADR-30 D5）：`SaveProfile.variables.sys` 的 pass 级草稿，任意形状任意路径，
AI 与 EJS 写同一棵树，**冲突 AI 赢**（EJS 差量先落、`vars_update` 后落）。

```js
vars.事件.冰之歌.触发时间 = stats.世界.时间;
vars.计数 = (vars.计数 ?? 0) + 1;
```

**边界**：`__proto__` / `prototype` / `constructor` 段命中 → **整次写入静默拒绝**；
pass 结束深 diff → `applyVarsPatch` 落库；差量超 **256 KB 整份拒绝**（不截断）；
提交权按 Agent 声明（`ejsVarsCommit`，默认仅 story）。

### 3.3 `local` —— 原始按项目隔离目标（现行共享）

> **现行偏离**：本节记录的是按项目隔离的原始目标。生产装配当前把所有内容接到 `builtin`，所以实际契约是“当前存档内所有 EJS 共享”；详见创作者指南第 6.4 节。

取代上游 `localStorage` / `getLocalVar`。原始目标语义：**属于本条目所在项目的小仓库**，跨回合持久，
不参与 AI 的变量空间（AI 看不见、写不到）。

```ts
local.get(key: string, fallback?: any): any        // 缺失返回 fallback ?? null
local.set(key: string, value: any): void           // 值必须 JSON-ish
local.has(key: string): boolean
local.remove(key: string): void
local.keys(): string[]
```

**边界**

- 原始命名空间目标：`vars._local.<projectId>.<key>`（内置书 projectId = `builtin`）。**项目之间互不可见** ——
  一个工坊项目读不到另一个的 KV，这是刻意的隔离，不是限制。
- 值必须可 JSON 序列化；单键 ≤ 16 KB，单项目总量 ≤ 64 KB，超限 `set` 静默失败 + `ui.log` 警告。
- 持久位置在 `variables.sys` 之下 → **快照回退自动覆盖**，零额外工作。

> 💡 上游 `getLocalVar/setLocalVar` 别名映射到这里（§5）。

### 3.4 `char` —— 角色只读查询（新）

```ts
char.player(): CharState | null                    // 主角（= stats.主角 的完整版）
char.get(name: string): CharState | null           // 按名（引擎唯一解析入口，同名规则一致）
char.present(): CharState[]                        // 当前在场
char.all(): CharState[]                            // 本 Agent 上下文可见的全部
char.has(name: string): boolean
char.affection(name: string): number               // -100 ~ +100
char.affectionLabel(name: string): string          // '挚友' / '中立' / … （affection-system 口径）
char.isStrongerThan(a: string, b: string): boolean // comparePower 封装
```

`CharState` 形状 = `stats.主角` 的同构投影 + `{ 名字, 种族, 身份[], 职业[], 类型 }`。

**边界**

- **可见性**：只返回该 Agent 上下文内已可见的角色（与 `{{CHARACTER_STATE}}` 注入口径一致）。
  不可见 → `null`。EJS 不得成为绕过 Phase 8 可见性模型的旁路。
- 只读孤儿拷贝。想改角色 → 让 AI 走语义 op，**不是 EJS 的职责**（P2）。
- 按名解析走引擎唯一入口（数据字典铁律：逻辑键=名字）。

### 3.5 `world` —— 世界只读（新）

```ts
world.时间: string            // 规范串
world.时间详情: { 纪元, 年, 月, 日, 星期, 时, 分, 季节, 时段 }
world.地点: string
world.地点详情: { 名字, 层级, 所属势力, 父节点, 相邻[] }   // location-db 投影
world.势力: string
world.天气: string
world.回合: number            // 取代上游 message_id / getLastMessageId
world.isDaytime(): boolean
world.diffDays(时间串A, 时间串B): number    // time-system 纯函数封装
```

**边界**：只读；时间比较/推进类纯函数只开**比较**不开**推进**（推进是引擎的事）。

### 3.6 `quest` —— 任务只读（新）

```ts
quest.all(): Quest[]
quest.active(): Quest[]
quest.get(name: string): Quest | null
quest.has(name: string): boolean
quest.focus(): Quest | null        // 玩家选中的焦点任务
```

`Quest` = `{ 名字, 状态, 描述, 目标[], 进度, 奖励 }`（形状对齐 `save-profile.ts` 的 `Quest`）。

### 3.7 `lore` —— 跨条目读世界书（新，取代 `getwi`）

```ts
lore.get(bookName: string, entryName: string): string   // 正文原文
lore.get(entryName: string): string                     // 全局按名找第一条
lore.has(bookName: string, entryName: string): boolean
lore.list(bookName: string): string[]                   // 条目名列表
```

**边界（本 namespace 最需要拷问）**

- 🔴 **必须遵守 Agent 世界书分区（Phase 8）**：不可见的书/条目 → 返回 `''`，`lore.has` 返回 `false`。
- **返回原文，不嵌套求值** —— 取到的条目若含 `<%` 原样返回。天然无递归/循环引用问题。
- 每条目 `lore.get` 调用数 ≤ 8（预算表 §6）；单次返回 ≤ 64 KB。
- 同步返回（我们的书全在内存）。上游写法是 `await getwi(...)` —— **`await` 一个非 Promise 合法**，
  编译目标为 `AsyncFunction` 后存量写法零改动可跑（§8）。

### 3.8 `chat` —— 近层正文只读（新）

```ts
chat.last(role?: 'user' | 'assistant'): string
chat.at(index: number, role?): string           // index<0 从末尾数，-1 = 最新
chat.slice(start: number, end: number, role?): string[]
chat.match(pattern: string | RegExp): boolean   // = 现有 matchChatMessages
chat.text(): string                             // 窗口内全部正文拼接串
```

**边界**：窗口**钉死为该 Agent 的 `historyLayers`**（不是全聊天记录——上游能查全部，我们明确降级，
理由是提示装配期本来就只看得见注入窗口）。越界返回 `''` / `[]`。
`RegExp` 的 `g`/`y` 标志自动剥除（`lastIndex` 漂移会让连续 `test` 结果不稳）。

### 3.9 `fmt` —— 格式化纯函数（新）

```ts
fmt.yaml(value, opts?: { blockQuote?: 'literal'|'folded'; indent?: number }): string
fmt.json(value, indent?: number): string
fmt.table(rows: object[], columns?: string[]): string    // Markdown 表格
fmt.list(items: string[], bullet?: string): string
fmt.num(n: number, digits?: number): string
fmt.pct(n: number, digits?: number): string              // 0.735 → '73.5%'
fmt.bar(value: number, max: number, width?: number): string  // '████░░░░ 50%'
fmt.pad(s: string, width: number, align?: 'left'|'right'|'center'): string
fmt.truncate(s: string, max: number, ellipsis?: string): string
fmt.compareName(a: string, b: string): number     // 中文友好比较（自带排序表，不依赖 localeCompare）
fmt.sortNames(names: string[]): string[]
```

**边界**：全部纯函数、无 I/O、输出长度设上限（防爆炸）。`fmt.yaml` **只出不进**（不提供 parse，语料 0 处需要）。

### 3.10 `rng` —— 种子随机（新）

```ts
rng.roll(formula: string): number          // '1d100' / '2d6+3'，不可解析返回 0
rng.rollDetail(formula): { 总计, 骰值[], 修正 }
rng.int(min: number, max: number): number  // 闭区间
rng.float(): number                        // [0,1)
rng.pick<T>(items: T[]): T | undefined
rng.pickN<T>(items: T[], n: number): T[]   // 不重复抽样
rng.shuffle<T>(items: T[]): T[]
rng.chance(p: number): boolean             // p ∈ [0,1]
```

**边界**：见 §7 确定性 —— 种子由 `(saveId, 回合号, 条目 uid, 本条目内调用序号)` 派生，**快照回退重放逐字节可复现**。
`Math.random` 仍然注入（原生直传），但**文档明说它不可复现**，`rng` 才是推荐写法。
`{{roll}}` / `{{random::}}` 宏改写后落到 `rng.roll` / `rng.pick`（现行实现落 `Math.random`，需改，§11 T2）。

### 3.11 `ui` —— 带外通道（新）

```ts
ui.notify(message: string, level?: 'info'|'success'|'warning'|'error'): void
ui.log(...args: any[]): void      // 进调试环形缓冲，不进真 console、不进提示词
```

**边界**

- `notify` 走既有 Toast 通道，**每 pass ≤ 3 条 + 同文去重**；toast 上**标注来源**（「来自《XX》条目」），
  玩家永远知道是谁在说话。
- **不提供阻塞对话框**。上游 `alert()` 别名映射到 `ui.notify(msg, 'warning')`。
- `ui.log` 有环形上限（512 条/pass），游戏页调试区可查。**两个都不影响提示词一个字节。**

### 3.12 `engine` —— 版本与能力探测（新）

```ts
engine.version: string                    // 语义化版本，如 '1.0.0'
engine.has(path: string): boolean         // engine.has('lore.get') / engine.has('stats.主角.背包')
engine.name: 'poem-of-destiny'
```

**为什么值得占一个顶层名**：真机语料里作者已经在用 `try { TavernHelper.getLastMessageId() } catch { message_id }`
猜环境。给他们一个正经的探测口，内容就能写成「新引擎用新面、老引擎退回别名层」，
**我们扩面/弃用时不会一刀切死存量内容**。

### 3.13 `_` —— lodash 只读子集

现有 shim 17 方法，**补齐到 26**（真机语料实测用到 24 个，全部纯读）：

```
现有：get trim isArray isObject isObjectLike isEmpty mapValues find flatMap
      pick pickBy values keys has uniq keyBy chain
补齐：isPlainObject size isNumber random omit cloneDeep mapKeys forOwn sample
```

**边界**：**永不提供写方法**（`set`/`assign`/`merge`/`update`）。真机 1524 个 EJS 块里 `_.set` 出现 **0 次** ——
散文里那些 `_.set(路径, 旧值, 新值)` 是教 AI 写 `vars_update` 补丁的示例 DSL，与 EJS 无关。
`_.random` / `_.sample` 内部改走 `rng`（确定性，§7）。

### 3.14 原生标准库保证（后端可移植性契约）

§3 那 12 个 namespace 是**我们自己的代码**，换求值后端（宿主 `new Function` ↔ QuickJS/wasm）不会有任何差异。
会有差异的是它们**脚下的原生标准库**——两个后端是两个 JS 引擎。故本节把原生面分成三档，
**创作者只能依赖 A 档**；B 档能用但行为按引擎浮动；C 档一律走 `fmt` 代替。

| 档                        | 内容                                                                                                                                                                                                                           | 契约                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **A · 保证**              | `Math` `JSON` `String` `Number` `Boolean` `RegExp`（基础 + 命名捕获组 + lookbehind）`Array` `Object` `Set` `Map` `Symbol.iterator` `Promise`；解构 / 展开 / 可选链 / 模板串 / 标签模板 / 箭头 / `class` 之外的全部 ES2020 语法 | 两个后端行为一致，进冒烟闸门                               |
| **B · 可用但不保证一致**  | `Date`（时区/夏令时行为按引擎）、`toFixed/toPrecision` 之外的数值排版、报错文案与 `stack`                                                                                                                                      | 能调用，**不得依赖其精确输出**；内容若因此漂移不算引擎缺陷 |
| **C · 不提供 / 不得依赖** | `Intl.*`、`toLocaleString` / `toLocaleDateString` / `localeCompare` 的**本地化行为**、`structuredClone`、`Intl.Segmenter`、正则 `/v` 标志                                                                                      | 预检标黄。替代见下表                                       |

**C 档替代路径**（`fmt` 因此要补齐）：

| 想做的事            | 别用                                                                 | 用                                              |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 数字千分位 / 百分比 | `Intl.NumberFormat` / `toLocaleString`                               | `fmt.num(n)` / `fmt.pct(n)`                     |
| **中文名字排序**    | `a.localeCompare(b)`（QuickJS 下退化成码点序，**顺序与浏览器不同**） | `fmt.compareName(a, b)` / `fmt.sortNames(list)` |
| 时间排版            | `new Date().toLocaleDateString('zh-CN')`                             | `stats.世界.时间` / `world.时间详情`            |
| 深拷贝              | `structuredClone`                                                    | `_.cloneDeep`                                   |

🔴 **实现约束（两个后端都适用）**：**任何吃回调的 helper 必须在 guest 侧实现**
（`_.mapValues` / `_.pickBy` / `_.find` / `fmt.table` 的自定义格式化器…）。
回调是 guest 代码，放宿主侧实现意味着跨边界传函数——在 QuickJS 后端下会变成噩梦。
`fmt` / `rng` / `_` 三个 namespace 因此**一律以 guest 源码形式注入**，不做宿主绑定。

**验收**：§11 的语料冒烟闸门要**在两个后端各跑一遍**，逐条目比对渲染结果字节。
不一致的条目要么是踩了 B/C 档（记进已知差异表），要么是后端 bug（修）。

---

## 4. 只读投影一览（速查）

| 我想要             | 用这个                                               |
| ------------------ | ---------------------------------------------------- |
| 主角血量           | `stats.主角.生命值`                                  |
| 某 NPC 好感        | `char.affection('艾莉亚')`                           |
| 现在几点           | `stats.世界.时间` / `world.时间详情.时`              |
| 第几回合           | `world.回合`                                         |
| 玩家刚说了什么     | `chat.last('user')`                                  |
| 玩家提过某关键词吗 | `chat.match(/咖啡馆/)`                               |
| 有没有某任务       | `quest.has('寻找失落的琴弦')`                        |
| 背包里有钥匙吗     | `stats.主角.背包.some(i => i.名字 === '青铜钥匙')`   |
| 拉另一条 lore 进来 | `lore.get('DLC-命定核心-维拉', '时间之门-剧情设计')` |
| 跨回合记个数       | `vars.我的计数 = (vars.我的计数 ?? 0) + 1`           |
| 存我自己的设置     | `local.set('展示模式', '简洁')`                      |
| 排版成 YAML        | `fmt.yaml(obj, { blockQuote: 'literal' })`           |
| 掷个骰             | `rng.roll('1d100')`                                  |
| 提醒玩家一句       | `ui.notify('命运点数已重置', 'warning')`             |

---

## 5. 兼容别名层（仅为存量内容）

**创作者写新内容请直接用 §3 的面。** 下表只为已有的角色卡/工坊内容能开箱即跑。

| 上游写法                                   | 映射到                                       | 备注                                                 |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `getMessageVar(path, {defaults})`          | 读链 `stats[path] ?? vars[path] ?? defaults` | 剥 `stat_data.` 前缀                                 |
| `setMessageVar(path, v)`                   | 写 `vars` 草稿                               | 永不触碰 stats                                       |
| `getvar(key,{defaults})` / `setvar(key,v)` | 同上，扁平键不剥前缀                         | `scope`/`noCache` 忽略                               |
| `getLocalVar(k)` / `setLocalVar(k,v)`      | `local.get/set`                              |                                                      |
| `localStorage.getItem/setItem`             | `local.get/set`（字符串）                    | **永不接触真 localStorage**                          |
| `matchChatMessages(p)`                     | `chat.match(p)`                              |                                                      |
| `getChatMessage(i, role)`                  | `chat.at(i, role)`                           |                                                      |
| `getChatMessages(a, b, role)`              | `chat.slice(a, b, role)`                     |                                                      |
| `getwi(book, entry)`                       | `lore.get(book, entry)`                      | 同步返回；`await` 合法                               |
| `YAML.stringify(v, o)`                     | `fmt.yaml(v, o)`                             |                                                      |
| `variables`                                | `{ stat_data: 整树读视图 }`                  | 现状不变                                             |
| `message_id`                               | `world.回合`                                 |                                                      |
| `TavernHelper.getLastMessageId()`          | `world.回合`                                 |                                                      |
| `TavernHelper.getVariables({type})`        | `variables`                                  | 其余方法 `undefined` → 触发作者自己的 try/catch 降级 |
| `toastr.info/success/warning/error`        | `ui.notify(msg, level)`                      | 限频                                                 |
| `alert(msg)`                               | `ui.notify(msg, 'warning')`                  | **不阻塞**                                           |
| `console.log(...)`                         | `ui.log(...)`                                | 进调试缓冲                                           |
| `charLoreBook`                             | 当前角色绑定书名（字符串）                   |                                                      |
| `print(v)`                                 | 原生保留                                     | EJS 语言自带，非上游 API                             |

**弃用政策**：别名层在 `engine.version` 的 **2 个 minor 版本内保持可用**，
之后在工坊「装前检视」的兼容预检里标黄（不阻断安装），再一个 minor 后可移除。
移除前必须先给出 `engine.has()` 探测路径，让内容能自己适配。

**明确不承接**（返回 `undefined`，触发条目回退或作者降级分支）：
`window.*`、`document`、`fetch`、`SillyTavern.*`、`triggerSlash`、其余 `TavernHelper.*`。
真机语料命中：**1 条**（第三方书 `角色扮演指南表` 的跨扩展互操作）。

---

## 6. 安全模型与预算

本节是能力面的**另一半**——面再窄，只要语言能重新造出能力，面就没意义。

### 6.1 隔离层（QuickJS realm，§0.1 裁定）

**语言一个字不裁。** 真机语料的 `const/let`(86)、模板串(32)、箭头(30)、IIFE(26)、`map/filter/reduce`(20)、
正则字面量(19)、展开(16)、标签模板(10)、可选链(8)、try/catch(5) 全部保留 —— 砍语言 = 砍掉一半自家内置书，
**DSL 方案已判死**。

隔离由 realm 提供，我们只需配置 4 个数字（见 §6.2）+ 定义注入面（§3）。guest 里
`.constructor` / `eval` / `new Function` / `Proxy` / `class` **随便用**，拿到的都是 guest 自己的东西。

**出境仍要把关**（唯一的静态/运行时守卫，且已存在）：`vars` / `local` 差量回宿主时，
`ejs-vars-diff.ts` 的 `DANGEROUS_KEYS`（`__proto__` / `prototype` / `constructor`）逐路径剔除。
guest 内的原型污染污染的是 guest，pass 结束即弃。

### 6.2 现行预算表

| 预算                      | 现行值                | 超限行为                     |
| ------------------------- | --------------------- | ---------------------------- |
| 单条目执行时间            | 50 ms                 | 当前条目回退原文，继续下一条 |
| 单 pass 执行总时间        | 5000 ms               | 当前及剩余动态条目回退原文   |
| guest heap                | 64 MiB                | 当前条目或整个 pass 回退     |
| guest stack               | 512 KiB               | 当前条目回退                 |
| `vars` 差量（每 pass）    | 256 KiB UTF-8         | 整份拒绝，不截断             |
| `local` 单值 / 当前共享桶 | 16 / 64 KiB UTF-8     | 当前 `set` 忽略并记录诊断    |
| `lore.get` 每条目         | 8 次，单次 ≤ 64K 字符 | 超出返回空串或截断           |
| 每个 `fmt.*` 字符串       | 64K 字符              | 截断并带标记                 |
| `ui.notify` 每条目        | 3 条（同文去重）      | 其余丢弃                     |
| `ui.log` 每条目           | 512 次                | 其余丢弃                     |

预算是条目 + pass 双层：单条目失败通常只回退自己；pass 总时间耗尽后，剩余动态条目不再执行。没有整条目 256 KiB 输出上限。

### 6.3 明确不提供（及理由）

| 不给                                               | 理由                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| 宿主 `window` / `document` / host global           | guest `globalThis` 存在，但只能回到 guest realm；宿主权限不开放                  |
| `fetch` / `XMLHttpRequest` / `WebSocket`           | 数据外传腿                                                                       |
| 真 `localStorage` / `indexedDB` / `sessionStorage` | API Key 与存档就在那儿                                                           |
| `setTimeout` / `setInterval`                       | 「条目跑完还在后台跑」——装配期不该有生命周期                                     |
| 写引擎实体（角色/物品/任务/资源）                  | ADR-21：唯一写入入口是 `StateManager`；EJS 是装配期，写实体会破坏管线 DAG 原子性 |
| 事件订阅（`$event.on`）                            | 那是 script-executor 的 Layer 5 契约，两套面刻意不互通                           |
| `import` / `include()`                             | 条目 = 独立编译单元（真机语料已验证无跨条目符号依赖）。要复用请用 `lore.get`     |

---

## 7. 确定性与快照

引擎有快照回退/重发（Phase 10k）。EJS 若用真随机，**回退重放会产出不同文本**，玩家会看到「同一个时间点、
不同的世界书内容」。

**裁定**：`rng.*` 的种子由 `hash(saveId, 回合号, 条目 uid, 本条目内第 n 次调用)` 派生。

> **现行修订**：实际种子为“saveId + 回合号 + 条目精确正文”，不含 uid；代码位 roll/random 宏已接入 `rng`，生产 QuickJS 不提供 `_.random` / `_.sample`。现行契约见创作者指南第 7.7 节。

- 同一回合同一条目重放 → 逐值一致
- 不同条目/不同回合 → 互不相关
- EJS 代码位中的 `{{roll}}` / `{{random::}}` 宏改写后落 `rng`；文本位随机宏仍由后续非种子宏链处理
- `Math.random` 仍可用但不可复现；生产 QuickJS 不提供 `_.random` / `_.sample`

---

## 8. 错误与降级契约

| 场景                                 | 行为                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| 能力返回不了值（越界/不可见/参数错） | 返回安全默认值（`''`/`[]`/`{}`/`null`/`0`），**不抛**                   |
| 条目里有语法错误 / 白名单外标识符    | 编译失败 → **原文注入** + 记 `fallbackEntries` + 预检可见               |
| 条目执行抛异常 / 超预算              | 原文注入 + 该条目对 `vars` 的半途写入**整体回滚**                       |
| `await` 非 Promise 值                | 合法（编译目标为 `AsyncFunction`）—— 存量 `await getwi(...)` 零改动可跑 |

**编译目标改为 `AsyncFunction` 是兼容性要求，不是 QuickJS 的成本** —— 真机语料 3 条用 `await`。
这决定了装配链要有一个 `await` 点（推荐形态：异步预渲染 + 同步 resolver，见 §11 T1）。

---

## 9. 语料依据（真机实测 2026-08-01）

来源：`E:\Photos\SillyTarvern\SillyTavern\data\default-user\worlds\` 的
`命定之诗与黄昏之歌v4.2.json`(732 条目) + `…精灵王室变革-角色更新4.json`(21) + `命定系统-卡米拉核心.json`(1)。

- **754 条目 / 109 条含 EJS / 1524 个 EJS 块** —— 仓库 `data/worldbooks/` 只有 509/45/≈660，**是真实的 4 成**。
  🔴 **含义**：现行 `worldbook-ejs-corpus.test.ts` 的「7 条已知回退」白名单是对着 4 成样本量的，
  **不能当作真实回退率**。按 §10.5 裁定**不把真机语料搬进 repo**——真实覆盖率改由本地诊断脚本
  `npm run ejs:corpus` 出报告；仓库内既有的 `data/worldbooks/`（509 条目）测试**原样保留**，
  它仍是有效的回归闸门，只是**不再声称代表全量**。
- 宿主 API 引用次数：`getMessageVar` 158 / `_` 116 / `setLocalVar` 82 / `getvar` 60 / `setMessageVar` 32 /
  `matchChatMessages` 26 / `getLocalVar` 20 / `setvar` 19 / `getChatMessage` 10+ / `YAML` 5 条目 /
  `TavernHelper` 3 / `getwi` 2 / `localStorage` 2 / `toastr`+`alert` 2 / `window` 1
- `_.set` / `_.assign` 等写方法：**0** —— 两轴契约的核心假设在 3 倍语料上仍然成立
- 逃逸语法（`.constructor` / `eval` / `new Function` / `Proxy` / `Reflect` / `class`）：**0**

**结论**：本文件这套面落地后，因「能力不足」而回退的真实条目 = **1 条**（第三方书的跨扩展互操作）。

---

## 10. 创作者体验（不做就没人用）

| 项           | 内容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| **类型定义** | 发布 `poem-ejs.d.ts`，创作者在 VSCode 里写世界书有补全与类型检查                           |
| **装前预检** | `WorkshopDetailModal` 加「EJS 兼容预检」：逐条列出白名单外标识符、超预算风险、将回退的条目 |
| **错误可见** | 回退条目在游戏页调试区列出（书名 #uid + 错误摘要 + 出错行），不只 `console.warn`           |
| **沙盒预览** | 设置页「世界书」分区加一个条目试跑器：贴正文 → 选存档 → 看渲染结果与 `vars` 差量           |
| **文档**     | 本文件 §3/§4 转成创作者手册（面向内容作者的语气，配可复制示例）                            |
| **示例项目** | 官方发一个「示例 DLC」，把 12 个 namespace 各用一遍，创作者照抄即可                        |

---

## 10.5 测试策略：合成语料，不 vendored 真实内容（2026-08-01 主人裁定）

**裁定：测试夹具全部合成，不把真实世界书搬进 repo。**
理由：4.4 MB 内容进 git 会让仓库与每次 clone 变重，且世界观内容受《内容二创与素材使用授权协议》约束；
更重要的是——**真实语料测不到危险路径**（良性内容里 `.constructor` 0 次、死循环 0 次、ReDoS 0 次），
而安全闸门恰恰需要那些。

**代价与补法（2026-08-01 主人裁定：不要人工环节）**：失去「改动弄坏真实条目 → 测试红」的能力，
补法**不是**本地诊断脚本（那会变成没人记得跑的 npm script），而是**混淆语料进 CI**：

```
scripts/scramble-worldbook-ejs.mjs   真实世界书 → 结构副本（正文换填充串、代码区一致混淆）
tests/fixtures/ejs-scrambled-corpus.json   109 条目 + 38 片段 / 660 KB / 已提交
src/sillytavern/ejs-scrambled-corpus.test.ts   CI 闸门，零人工
```

**混淆三条规则**（详见脚本头注释）：正文整体换填充串（不做字符置换——置换保留字频，可被频率分析还原）；
代码区 CJK 一致置换（读写链、`getvar`/`setvar` 键匹配、对象键一致性全保住）；
ASCII 标识符一致重命名（抹掉音译人名），**白名单**含宿主 API / JS 内建 / lodash 方法名 /
契约 token（`stat_data` 等）—— 漏一个就会把「方法名被改坏」测成「引擎缺能力」，基线失真。

**生成器自带闸门**：逐条目比对「原文编译结果 == 混淆后编译结果」，不一致**拒绝写出夹具**。
另有测试抽查混淆有效性（专有名词零出现）。刷新夹具：`npm run ejs:fixture -- --src "<路径>"`。

**片段补充**：按 API/语法特征从真实条目切出 38 个**自足**代码块（跨块 `if {` 那种半截块会被
自足性闸门滤掉），当聚焦用例用。

### 合成语料分组（按 §9 实测画像配比）

| 组               | 内容                                                                                                                                                 | 依据          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **A 语法覆盖**   | `const/let`、跨块 `if/for`、模板串、标签模板、箭头、IIFE、展开、可选链、正则字面量（含命名捕获）、`map/filter/reduce`、try/catch、`await` 非 Promise | §9 特征表逐项 |
| **B 能力面**     | 12 个 namespace × 每方法的**正常 / 越界 / 缺参**三态                                                                                                 | §3            |
| **C 别名层**     | 上游 16 个名字映射正确 + 三种读形（叶子/子树/整树）                                                                                                  | §5            |
| **D 契约不变式** | pass 内写→读可见、失败整体回滚、stats 深改不回流、静动分层字节稳定、EJS 差量 vs AI 补丁仲裁顺序、快照重放一致                                        | ADR-30 + §7   |
| **E 对抗**       | 构造器逃逸、原型污染路径、自引用环、死循环、`/(a+)+b/` 灾难回溯、`"x".repeat(1e9)`、深递归、Promise 悬挂、256 KB 差量超限、pass 天花板               | SEC-02 + §6.2 |
| **F 后端一致性** | A-D 全量在两后端跑，**逐字节比对**；不一致要么记进 §3.14 已知差异表，要么是 bug                                                                      | §3.14         |

### 🔴 E 组的陷阱（必须先布置好）

死循环 / 灾难回溯 / `repeat(1e9)` 这几例在 `LegacyBackend`（`new Function`，同步主线程）上
**会挂死测试进程** —— vitest 的超时**救不了同步无限循环**。故：

- 这些用例在 Legacy 后端下必须 `it.skip`，且**跳过理由写进测试名**（如
  `'[仅 QuickJS] 死循环被 interrupt 掐断'`），不做静默跳过；
- 只在 QuickJS 后端 suite 内真跑；
- 加一条**元测试**断言「E 组危险用例在 Legacy suite 里全部处于 skip 状态」——
  防止有人哪天顺手去掉 skip 把 CI 永久卡死。

---

## 11. 实施切片（建议，非承诺）

| 切片          | 内容                                                                                                                                                                                                                                   | 依赖   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| ~~**T0**~~ ✅ | **已完成（2026-08-01）**：混淆语料生成器 + 夹具 + CI 闸门（109 条目/38 片段，16 条已知回退带 `fixedBy` 标注）；合成语料 A 语法覆盖 15 例 + D 契约不变式 13 例 + E 对抗 8 例（3 例按规则 skip + 元测试保险丝）。**B/C 组随 T4-T6 补齐** | 无     |
| **T1**        | 抽出 `EjsBackend` 接口 + 编译目标 → `AsyncFunction`；装配链改「异步预渲染 + 同步 resolver」（复用现有 `ctx.ejsPass.loreRender` memo，`PlaceholderResolver` 签名**不动**）。现行 `new Function` 实现收编为 `LegacyBackend`              | T0     |
| **T2**        | `rng` + 种子确定性；`{{roll}}/{{random}}` 宏改写落 `rng`                                                                                                                                                                               | T1     |
| **T3**        | `stats` 扩面（背包/技能/装备/状态效果/队伍/世界扩展）                                                                                                                                                                                  | T0     |
| **T4**        | 新 namespace 第一批：`chat` / `lore` / `local` / `ui` / `engine`（宿主绑定侧）                                                                                                                                                         | T1、T3 |
| **T5**        | 新 namespace 第二批：`char` / `world` / `quest`；`fmt` / `_`（**guest 源码侧**，26 方法 + 排序/排版）                                                                                                                                  | T3     |
| **T6**        | 别名层重接到新面（存量语料全绿闸门）                                                                                                                                                                                                   | T4、T5 |
| **T7**        | **QuickJS 后端**：接 `EjsBackend`、编组层、预算配置（§6.2）、错误行号映射；两后端逐条目字节比对闸门（§3.14）                                                                                                                           | T6     |
| **T8**        | 生产默认切 QuickJS（`LegacyBackend` 保留供测试与回滚）；创作者体验：`.d.ts` / 装前预检 / 条目试跑器 / 手册                                                                                                                             | T7     |

### 11.1 评审修复轮（2026-08-01，PR #22）

T7 那行写着「两后端逐条目字节比对闸门（§3.14）」—— **当时没做**。代价是下面这些缺陷全部越过全绿的 CI：

| #   | 缺陷                       | Legacy   | 修前的 QuickJS                                                                                                                                                                                                            |
| --- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 能力面在生产**根本没接线** | —        | `buildCapabilityInput()` 写好了零调用，`buildEjsPassContext()` 漏 `capabilities` 字段 → 八个 namespace 全取默认空值                                                                                                       |
| 2   | **别名层整个缺席**         | 全部可用 | `getMessageVar`/`getvar`/`setvar`/`getwi`/`YAML`/`toastr`/`print` 一律 `ReferenceError`（38 个真机片段里 27 个中招）                                                                                                      |
| 3   | `await` 条目               | 正常     | 同步 IIFE → `SyntaxError`（语料 3 条）                                                                                                                                                                                    |
| 4   | 代码位 `{{roll}}`          | 正常     | guest 编译器漏调 `rewriteCodeMacros` → `SyntaxError`（语料 4 条）                                                                                                                                                         |
| 5   | 失败条目的半途写           | 整体回滚 | 残留并被 pass 末的 `readBackVars` 落库                                                                                                                                                                                    |
| 6   | `rng` 播种                 | 逐条目   | 整 pass 一条序列 → 同条目换个位置就换个结果                                                                                                                                                                               |
| 7   | 严格模式                   | 严格     | 宽松 → 未声明赋值静默建全局（wb5i#222488）                                                                                                                                                                                |
| 8   | **句柄泄漏**               | —        | 装配期 `unwrapResult` 的完成值没释放 + 同步条目的 `.catch` reaction job 没泵，`dispose()` 时 QuickJS `abort()` 整个 wasm 实例；而 dispose 外面那圈 try/catch 把异常**咽掉了**，测试全绿、stderr 刷 38 行 `Aborted` 没人看 |

**根因是测试布局，不是这八处各自的手滑**：渲染正确性全测 Legacy，QuickJS 只测安全属性 ——
「两个后端渲染结果不同」这一整类缺陷结构性无人看守。

补的是 `ejs-backend-parity.test.ts`：断言形式统一为 `legacy(x) === quickjs(x)`（文本 + 成败 + 草稿末态三样），
覆盖 38 个真机片段 + 语义面 + 八条回归。**不是** `quickjs(x) === 字面量` —— 后者每加一个能力就要手写期望值，
前者天然覆盖将来新增的一切。

已登记的 C 档差异（`localeCompare` / `toLocaleString` / `Intl` / 命名捕获组）在比对中显式豁免并计数，
豁免数**断言 ≤ 3** —— 它一旦变长，说明「已登记差异」正在变成垃圾桶。

同轮补齐：`ejs-backend.test.ts`（接缝本身此前无测试）、lodash T5 十个方法的测试、
`agent-templates.test.ts` 的能力面接线回归（含「`lore.get` 读不到该 Agent 看不见的书」这条安全断言）。

### 11.2 Legacy 后端的退场路线（2026-08-01 裁定）

问：既然 QuickJS 是边界，Legacy 还留着干嘛？答：**该删的先是「自动回退」，不是 Legacy 本身** —— 这两件事之前被混在一起。

原形态是**静默安全降级**：wasm 装不上 → 退回 `new Function` → 世界书照常渲染 → 用户毫不知情。
`installProductionEjsBackend` 的注释写着「调用方据返回值决定要不要提示用户」，
而 `main.ts` 写的是 `void installProductionEjsBackend();` —— **返回值被丢掉了**。

这比「没有隔离」更糟：没有隔离时你知道自己没有；有一个会静默失效的隔离，
你会**按「有隔离」去做决策**（比如据此解封工坊入口）。

**① 已完成（本轮）**

- 新增 `FailClosedBackend`：不求值，全部条目原文注入（D8 语义，最坏等于 EJS 没上线）
- `installProductionEjsBackend()` **第一件事**就是切到 fail-closed，关掉「装载期间悄悄用 Legacy 渲染」的时间窗；
  装成功换 QuickJS，装失败**留在 fail-closed**，且从 `console.warn` 升级成 `console.error`
- `main.ts` 接住返回值，失败时弹**不自动消失**的错误 toast
- 装配结果记忆化：重复调用不会把正在服役的 QuickJS 实例 dispose 掉重建
- 真浏览器验证：无 error、无降级 toast，隔离后端正常装载

**② 待做：真机走查。** 走查期间 Legacy 是**诊断参照物** —— 发现「某条目渲染不对」时，
能立刻问「Legacy 渲染对吗」，一问就把「QuickJS 的 bug」和「内容本身的 bug」分开。
这个价值在走查结束的那一刻归零。

**③ 走查之后：删 Legacy。** 连同 `buildSandboxArgs` / `SANDBOX_PARAM_NAMES` / `SHADOWED_GLOBALS`
那一套宿主形参注入（约四百行）与 parity 测试一起删，语料基线在 QuickJS 上重建。
项目仍处**预发布**，没有存量用户、没有内容作者的输出预期被钉死 —— 这是删它成本最低的窗口，别拖。
删掉之后能力面只剩**一份**实现（guest facade）；§11.1 那八条缺陷里有五条的成因就是「同一件事写两遍，第二遍漏了」。

**顺带（已在同一窗口内定掉）**：`passTimeoutMs` **1500ms → 5000ms**。原值是拍的，
而全语料实测单 pass **348–583ms**（109 条目，预热后；同口径 Legacy 为 6–73ms）——
只有 3 倍余量，动态条目再多两三倍的用户会整片撞天花板、大面积静默回退。5s 给到约 10 倍。

代价是最坏情况的主线程冻结变长；可接受，因为这是 **DoS 防线不是性能项**，
常态下的约束是单条目 50ms 那道闸门。能吃满 5s 的只有「上百个各自逼近 50ms 的条目」，
那种书本身该被作者优化，而不是被引擎腰斩成一堆原文注入。

`entryTimeoutMs` **维持 50ms**（实测均值约 3-5ms/条目，10 倍余量）—— 但它现在是唯一的实际约束，
真机走查时应重点看有没有条目逼近它（那会是静默回退的主要来源）。

**工坊入口的解封条件**：EJS 侧（本设计）已具备边界 ——
但 **SEC-01（正则 replaceString → `v-html` 的 XSS）尚未修复**，它与 EJS 无关、独立成链。
故 `WORKSHOP_ENTRY_ENABLED` 仍应保持 `false`，直到 SEC-01 落地。

**`EjsBackend` 接口（T1 就要定死，后续切片一律按它写）**：

```ts
interface EjsBackend {
  compile(source: string, entryId: string): CompiledEntry | { error: string };
  /** 一个装配 pass 的全部条目，按序执行；vars/local 草稿在后端内跨条目演化 */
  runPass(entries: CompiledEntry[], ctx: EjsPassContext): Promise<EjsPassResult>;
  dispose(): void;
}
```

两个实现（`LegacyBackend` / `QuickJsBackend`）必须通过**同一套测试**。测试默认跑 Legacy（快、无 wasm），
QuickJS 单独一个 suite + 语料字节比对。

---

## 12. 待拷问（本文档暂定，欢迎推翻）

1. **`char` 的可见性口径** —— 「该 Agent 上下文可见」是否够严？工坊内容能不能靠 `char.all()` 把
   玩家还没遇到的 NPC 全捞出来塞进提示词？（倾向：`char.all()` 只返回**已相遇**的，加 `char.met(name)`）
2. **`lore.get` 会不会被滥用成「绕过 order/激活机制的全量注入」** —— 8 次/条目的预算够不够？
   要不要限定只能读**同项目内**的条目（跨项目读需声明依赖）？
3. **`stats` 扩面后的体积** —— 背包上百条时每 pass 深克隆的成本，T3 实测前不预设阈值。
4. **`local` 的项目粒度** —— 内置书全部共用 `builtin` 命名空间，会不会让内置 DLC 之间互相踩？
   （倾向：内置书按**书名**分空间）
5. **确定性种子里要不要含 swipe 序号** —— 同一回合重 roll（重发）时，玩家期望换一个结果还是同一个？
6. **`ui.notify` 的来源标注** —— 工坊项目名可能是恶意伪装（「系统提示」）。是否需要强制前缀
   「内容《X》说：」而不是让项目名单独成句？

---

## 附：与既有文档的关系

- **承接**：`2026-07-31-workshop-phase2-ejs-design.md` 的 D1（求值位置）/D2（整片编译）/D7（静动分层）/
  D8（错误隔离）/D9（缓存）**全部不变**；本文件只重写 **D4（stats 范围）** 与 **D5（能力面）**，
  并把 §5「待拷问：背包是否进 stats」裁定为**进**。
- **取代**：P2 设计 §4 降级清单里「酒馆助手扩展 API 未注入」「关系列表/任务列表读不到」两行，
  由本文件的 `chat`/`lore`/`char`/`quest`/`fmt` 能力取代。
- **不触碰**：ADR-21（唯一写入入口）、ADR-19（$ API 语义级抽象）、Phase 8 可见性模型。| 切片 | 内容 | 状态 |
  |---|---|---|
  | **T0** | 混淆语料生成器 + 夹具（109 条目 / 38 片段 / 660 KB）+ CI 双向闸门；合成语料 A/D/E 三组 | ✅ |
  | **T1** | `EjsBackend` 接口 + `LegacyBackend`；`await` 条目编译成 `AsyncFunction`；`prerenderWorldBookEntries` 异步预渲染 + `buildAgentMessagesAsync`（`PlaceholderResolver` 签名零改动） | ✅ |
  | **T2** | `ejs-rng.ts` 种子随机；EJS 代码位 `{{roll}}`/`{{random::}}` 改走 `rng`；种子 = `(saveId, 回合号, 条目正文)` → 快照重放可复现 | ✅ |
  | **T3** | `stats` 扩面：背包/装备/技能/状态效果/登神长阶/金钱/队伍/世界(时段·回合·天气·地点) | ✅ |
  | **T4** | `chat` / `lore` / `local` / `ui` / `engine`（`ejs-capabilities.ts`） | ✅ |
  | **T5** | `char` / `world` / `quest`；`fmt`（`ejs-fmt.ts`，含不依赖 locale 的 `compareName`）；`_` 扩面（生产 QuickJS 的可移植交集现为 25 方法） | ✅ |
  | **T6** | 别名层重接到能力面（`getChatMessage`/`getwi`/`YAML`/`TavernHelper`/`toastr`/`alert`/`localStorage`/`console`/`message_id`/`lastMessageId`）；**内置全语料回退 7 → 0** | ✅ |
  | **T7** | `QuickJsBackend`（quickjs-emscripten 0.32，主线程）+ 预算配置 + 15 个安全用例 | ✅ |
  | **T8** | 生产默认切 QuickJS（`installProductionEjsBackend`，初始化失败时 fail-closed、保留 EJS 原文且不退 Legacy）；`public/poem-ejs.d.ts` 创作者类型定义；`ejs-preflight.ts` 装前预检 | ✅ |

**实测安全属性**（T7，quickjs-emscripten 0.32）：

| 攻击                                              | Legacy（`new Function`） | QuickJS                    |
| ------------------------------------------------- | ------------------------ | -------------------------- |
| `Object.constructor("return globalThis")().fetch` | **拿得到真全局** ❌      | `undefined` ✅             |
| `while(true){}`                                   | 冻死进程 ❌              | interrupt 掐断 ✅          |
| `/(a+)+b/.test("a".repeat(40))`                   | 冻死进程 ❌              | interrupt 掐断 ✅（762ms） |
| `"x".repeat(1e9)`                                 | OOM ❌                   | 内存上限拒绝 ✅            |

第三条是 AST 白名单方案**结构性做不到**的（单表达式、无循环，`__tick` 注入执行不到），
而真机语料 19 个条目用正则字面量 —— 这是选 QuickJS 而非 AST 的决定性证据。

**QuickJS 实测能力差异**（§3.14 已登记）：无 `Intl` / `structuredClone`；`localeCompare` 非本地化；
`toLocaleString` 无千分位；**命名捕获组不可用**（`exec` 返回 null，真机语料 0 处使用，不阻塞）。
以上全部有 `fmt.*` 替代路径，且 `ejs-preflight` 会逐条标出来。

**`EjsBackend` 接口（T1 就要定死，后续切片一律按它写）**：

```ts
interface EjsBackend {
  compile(source: string, entryId: string): CompiledEntry | { error: string };
  /** 一个装配 pass 的全部条目，按序执行；vars/local 草稿在后端内跨条目演化 */
  runPass(entries: CompiledEntry[], ctx: EjsPassContext): Promise<EjsPassResult>;
  dispose(): void;
}
```

两个实现（`LegacyBackend` / `QuickJsBackend`）必须通过**同一套测试**。测试默认跑 Legacy（快、无 wasm），
QuickJS 单独一个 suite + 语料字节比对。

---

## 12. 待拷问（本文档暂定，欢迎推翻）

1. **`char` 的可见性口径** —— 「该 Agent 上下文可见」是否够严？工坊内容能不能靠 `char.all()` 把
   玩家还没遇到的 NPC 全捞出来塞进提示词？（倾向：`char.all()` 只返回**已相遇**的，加 `char.met(name)`）
2. **`lore.get` 会不会被滥用成「绕过 order/激活机制的全量注入」** —— 8 次/条目的预算够不够？
   要不要限定只能读**同项目内**的条目（跨项目读需声明依赖）？
3. **`stats` 扩面后的体积** —— 背包上百条时每 pass 深克隆的成本，T3 实测前不预设阈值。
4. **`local` 的项目粒度** —— 内置书全部共用 `builtin` 命名空间，会不会让内置 DLC 之间互相踩？
   （倾向：内置书按**书名**分空间）
5. **确定性种子里要不要含 swipe 序号** —— 同一回合重 roll（重发）时，玩家期望换一个结果还是同一个？
6. **`ui.notify` 的来源标注** —— 工坊项目名可能是恶意伪装（「系统提示」）。是否需要强制前缀
   「内容《X》说：」而不是让项目名单独成句？

---

## 附：与既有文档的关系

- **承接**：`2026-07-31-workshop-phase2-ejs-design.md` 的 D1（求值位置）/D2（整片编译）/D7（静动分层）/
  D8（错误隔离）/D9（缓存）**全部不变**；本文件只重写 **D4（stats 范围）** 与 **D5（能力面）**，
  并把 §5「待拷问：背包是否进 stats」裁定为**进**。
- **取代**：P2 设计 §4 降级清单里「酒馆助手扩展 API 未注入」「关系列表/任务列表读不到」两行，
  由本文件的 `chat`/`lore`/`char`/`quest`/`fmt` 能力取代。
- **不触碰**：ADR-21（唯一写入入口）、ADR-19（$ API 语义级抽象）、Phase 8 可见性模型。
