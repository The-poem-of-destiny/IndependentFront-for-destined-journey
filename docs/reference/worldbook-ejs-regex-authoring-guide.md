# 世界书 EJS 与输出美化正则创作指南

> 文档版本：1.0（2026-08-02）<br>
> EJS 能力面版本：`engine.version === '1.0.0'`<br>
> 适用对象：世界书条目作者、创意工坊项目作者、输出美化规则作者

本文是创作者可依赖的规范入口。它规定世界书条目如何激活、EJS 在何时和什么边界内执行、输出美化正则如何匹配与渲染，以及两类脚本各自能读写什么。

配套资料：

- [`engine-ejs.d.ts`](../../public/engine-ejs.d.ts)：EJS API 的 TypeScript 声明，可复制到创作项目中获得补全。
- [EJS 能力面设计](../planning/2026-08-01-ejs-capability-surface-design.md)：设计与实施记录；用于理解决策背景，不覆盖本文的创作者契约。
- [工坊正则兼容性语料审查](../reviews/2026-08-02-workshop-regex-compatibility.md)：公共工坊语料、兼容率与安全边界证据。
- [内容二创与素材使用授权协议](../《命定之诗》内容二创与素材使用授权协议.md)：发布世界观与叙事内容前必须遵守。

## 1. 规范用语与稳定性

本文使用以下约束词：

- **必须**：违反后不能期待内容正确运行。
- **应当**：强烈建议；偏离时作者需要自行承担兼容性或可维护性风险。
- **可以**：受支持但不是必需。
- **不得依赖**：当前某个构建中可能碰巧可用，但不属于稳定兼容面。

若资料发生冲突，创作者应按以下顺序判断：

1. 本文的行为契约；
2. `public/engine-ejs.d.ts` 的签名；
3. 当前实现与回归测试；
4. planning/reviews 文档中的历史设计和语料记录。

发现前三项不一致时应视为实现或文档缺陷，不应把偶然行为写进新内容。

## 2. 两条完全不同的执行链

世界书 EJS 与输出美化正则不是同一种脚本，也不会互相调用。

```text
世界书被 Agent 选择
  → 存档启用过滤
  → 条目 enabled 过滤
  → 静态区 / 动态区排序
  → QuickJS 执行世界书 EJS
  → 处理世界书 {{...}} 宏
  → 组成 Agent 提示
  → 模型生成 <maintext>
  → 正文解析并提交消息
  → 输出美化正则匹配
  → replacement 在隔离 iframe 中渲染
```

关键区别：

| 维度 | 世界书 EJS | 输出美化正则 |
| --- | --- | --- |
| 输入 | 世界书条目 `content` | 已提交的 assistant 正文 |
| 执行时机 | Agent 提示装配时 | 模型输出完成并提交后 |
| 主要用途 | 条件注入、只读查询、叙事变量簿记 | HTML/CSS/JS 卡片、状态栏、交互展示 |
| 浏览器 DOM | 无 | 只有当前富命中自己的 iframe DOM |
| 网络 | 无 | 允许 HTTP(S)、WS(S) 等浏览器网络能力 |
| 持久状态 | `vars` / EJS `local`，按存档 | 共享 `regexStorage`，跨存档 |
| 能否修改游戏实体 | 不能 | 不能 |
| 失败结果 | 当前条目回退为 EJS 原文 | 当前规则不命中或脚本在 frame 内失败 |

以下内容不在本契约内：

- Story preset 和 system prompt 中的 EJS；
- replacement 内再次执行 EJS 或 `{{...}}` 宏；
- `$combat`、`$event`、效果脚本等游戏机制 API；
- 正则对提示词、聊天历史或 user 消息的改写。

## 3. 应该选择哪一种机制

| 需求 | 使用机制 |
| --- | --- |
| 固定设定或固定提示 | 普通世界书正文 |
| 简单文本变量或随机宏 | 世界书 `{{setvar}}` / `{{getvar}}` / `{{random}}` 宏 |
| 依据状态条件生成提示 | 世界书 EJS |
| 让后续 EJS 和 AI 共享叙事状态 | `vars` |
| 保存 EJS 自用的小型偏好或游标 | EJS `local`；必须使用作者前缀 |
| 把模型标签转换成卡片 | 输出美化正则 |
| 在卡片内运行交互脚本 | replacement 的 iframe JavaScript |
| 跨消息保存卡片主题或折叠状态 | `window.regexStorage` |
| 修改角色、背包、任务或战斗状态 | 由 AI 输出引擎规定的语义指令；EJS/正则都不负责 |

## 4. 世界书条目契约

### 4.1 作者字段

创意工坊载荷可使用标准 SillyTavern 世界书条目形状。导入后核心字段如下：

| 上游字段 | 内部字段 | 当前语义 |
| --- | --- | --- |
| `comment` / `name` | `name` | 条目稳定逻辑名；项目更新按名字匹配 |
| `content` | `content` | 注入正文；只有这里会执行世界书 EJS |
| `enabled` / `disable` | `enabled` | `false` 时不注入任何 Agent |
| `order` | `order` | 数值升序；数值越大越靠后 |
| `key` / `keys` | `key` | 保留用于导入兼容和编辑，不触发当前运行时激活 |
| `keysecondary` | `keysecondary` | 同上 |
| `selectiveLogic` | `selectiveLogic` | 保留，当前运行时不做关键词判定 |
| `position` | `position` | 保留，当前装配不按 ST position 分槽 |
| `uid` | 重新分配的 `uid` | 上游 uid 仅留作溯源，作者不得把它当跨安装稳定标识 |

作者必须给每条条目提供项目内稳定且尽量唯一的名字。更新时改名等价于删除旧条目并新增条目，可能改变存档启用引用。

### 4.2 激活条件

一条世界书条目进入某个 Agent 提示，必须同时满足：

1. 该世界书 ID 在 Agent 的 `worldBookIds` 中；
2. 当前存档的工坊项目/条目启用选择允许它；
3. 条目本身 `enabled === true`。

当前激活规则**不读取 `key`、`keysecondary`、`selectiveLogic` 或 `position`**。不要通过关键词字段实现条件注入；需要条件时应在 `content` 中使用 EJS。

工坊项目安装时会把世界书授权给现有 Agent，但每个存档是否启用仍由该存档决定。

### 4.3 排序与静动态分区

条目先按 `order` 升序稳定排序，再自动分成两区：

- 静态区：正文不含 `<%`、`{{random`、`{{getvar`；
- 动态区：正文含上述任一大小写敏感标记。

最终文本总是“静态区在前、动态区在后”，两区内部继续保持 `order` 顺序。动态区中只有含 `<%` 的条目会进入 EJS；只有 `{{random}}` / `{{getvar}}` 的条目留给后续世界书宏阶段。

这意味着作者不得用 `order` 让动态条目插到静态条目之前。需要 EJS 条目之间传递 `vars` 时，只需保证这些动态条目的相对 `order` 正确。

### 4.4 EJS 与世界书宏的顺序

EJS 先执行，文本位中产生或保留的 `{{...}}` 再交给世界书宏处理。EJS 代码位里的以下两类宏会先被编译成种子随机调用：

- `{{roll 1d100}}` / `{{roll::1d100}}`；
- `{{random::甲,乙,丙}}`。

其它代码位宏不会自动改写。replacement 中的任何 `{{...}}` 都是普通字面文本，不会经过这条链。

静态区和动态区分别执行 `setvar → getvar → random` 宏链。静态区的 `{{setvar}}` 不会给动态区的 `{{getvar}}` 供值；需要跨动态条目共享状态时应使用 EJS `vars`，或把成对宏留在同一区。

文本位的 `{{random::...}}` 由后续宏链用非种子随机处理，不具备快照重放确定性。需要可复现随机时必须在 EJS 代码位调用 `rng`，或直接输出 `<%= rng.pick(...) %>`。

## 5. EJS 语言

### 5.1 标签

一个条目的全部 `content` 会作为一个 strict-mode 程序单元编译，因此多个代码块可以共享局部变量和控制流。

| 写法 | 语义 |
| --- | --- |
| `<% code %>` | 执行代码，不直接输出 |
| `<%= expression %>` | 把表达式结果转成文本并输出 |
| `<%- expression %>` | 与 `<%=` 相同；本引擎不做 HTML 转义 |
| `<%# comment %>` | EJS 注释，不输出 |
| `<%%` | 输出字面 `<%` |
| `print(value)` | 从代码块直接追加输出 |

`null` 和 `undefined` 的输出为空串。未闭合的 `<%` 会按普通文本处理，不触发编译错误。

空白裁剪标记：

- `<%_` 删除标签前方的水平空白；
- `_%>` 删除标签后的水平空白以及最多一个换行；
- `-%>` 删除标签后的最多一个换行。

### 5.2 跨块控制流

```ejs
<% const hp = stats.主角?.生命值 ?? 0; %>
<% if (hp <= 0) { %>
当前主角无法继续行动。
<% } else { %>
当前主角仍可行动。
<% } %>
```

### 5.3 异步与不支持项

生产后端支持 Promise 和 `await`，包括存量内容里的 `await getwi(...)`。但 `lore.get` 本身同步返回原文，新内容没有必要为了它使用 `await`。

不支持：

- `include()`；
- ES module `import` / `export`；
- Node.js `require` / `process`；
- 跨条目共享 JavaScript 变量；
- 递归求值 `lore.get()` 返回内容中的 EJS。

未声明变量赋值在 strict mode 下会报错并让当前条目回退。必须使用 `const`、`let`、`var`，或明确写入 `vars` / `local`。

## 6. EJS 状态模型

### 6.1 状态与持久化矩阵

| 面 | 可读 | 可写 | 作用域 | 持久条件 | 保密边界 |
| --- | --- | --- | --- | --- | --- |
| `stats` | 是 | 不得写 | 当前装配 pass | 不持久 | 不是 |
| `vars` | 是 | 是 | 当前存档、当前 pass | 当前 Agent 有 `ejsVarsCommit` | AI 与 EJS 共写 |
| EJS `local` | 是 | 是 | 当前存档的共享 EJS 桶 | 同 `vars` | 不是秘密存储 |
| regex `regexStorage` | 仅 regex frame | 是 | 整个应用共享 | 异步写入 Dexie | 所有 regex 都可读写 |
| regex `sessionStorage` | 仅当前 frame | 是 | 单个消息 frame | 不持久 | 同 frame 脚本共享 |

### 6.2 `stats`：只读投影

`stats` 是给创作者读取的游戏投影。作者**必须把它视为只读**。写入不会提交游戏状态，而且直接 mutation 的条目间表现不属于兼容保证。

可选顶层：

| 路径 | 形状 |
| --- | --- |
| `stats.主角` | 主角完整只读投影 |
| `stats.队伍` | 当前队伍成员数组 |
| `stats.命运点数` | 数字 |
| `stats.世界` | 时间、时段、回合、天气、地点 |

`stats.主角` 字段：

- 资源：`生命值`、`生命值上限`、`法力值`、`法力值上限`、`体力值`、`体力值上限`；
- 成长：`等级`、`生命层级`、`累计经验值`、`升级所需经验`；
- 属性：`力量`、`敏捷`、`体质`、`智力`、`精神`、`属性点`；
- `金钱`；
- `背包[]`：`名字`、`类型`、`品质`、`数量`、`装备槽位`、`描述`；
- `装备`：`{ 槽位: 物品名 }`；
- `技能[]`：`名字`、`类型`、`等级`、`描述`、`剩余冷却`；
- `状态效果[]`：`名字`、`分类`、`层数`、`剩余时间`、`时间单位`、`描述`；
- `登神长阶`：`已开启`、`要素[]`、`权能[]`、`法则[]`、`神位`、`神国`。

数据可能缺失，必须使用可选链和默认值：

```ejs
<%
const player = stats.主角;
const hpRate = player && player.生命值上限 > 0
  ? player.生命值 / player.生命值上限
  : 0;
%>
生命比例：<%= fmt.pct(hpRate) %>
```

### 6.3 `vars`：AI 与 EJS 共写的叙事变量

`vars` 是当前存档 `variables.sys` 的装配草稿，可以保存任意 JSON 形状。动态条目按顺序共享同一草稿：前一条成功写入后，后一条可以立即读取。

```ejs
<%
vars.author_demo ??= {};
vars.author_demo.visits = Number(vars.author_demo.visits ?? 0) + 1;
%>
本次装配计数：<%= vars.author_demo.visits %>
```

提交规则：

- 只有带 `ejsVarsCommit` 的 Agent 会提交；默认只有 `story`；
- 无提交权 Agent 的写入只在该 pass 内可见，结束即丢弃；
- EJS 差量先应用，AI 的 `vars_update` 后应用；
- 同一路径冲突时 AI 获胜；
- 数组按整棵替换处理；
- 对象 key 不得包含 `.`；点号是持久化路径分隔符且没有转义语法，需要层级时应使用嵌套对象；
- `__proto__`、`prototype`、`constructor` 路径段被拒绝；
- 序列化后的整份差量上限为 256 KiB，超限时整份拒绝，不做部分提交。

不要把实体账务状态放进 `vars` 来绕过引擎。角色资源、物品、任务等仍由引擎语义操作管理。

### 6.4 EJS `local`：当前是每存档共享桶

API：

```ts
local.get(key, fallback?)
local.set(key, value)
local.has(key)
local.remove(key)
local.keys()
```

当前 1.0 行为必须如实理解：

- 所有世界书 EJS 当前都接入同一个 `builtin` 桶；
- 桶位于当前存档的 `vars._local` 下；
- 它不是按工坊项目隔离，也不是 IndexedDB 独立表；
- 只有当前 Agent 有 `ejsVarsCommit` 时，写入才会跨回合持久；
- 其它 EJS 可以读取、修改或删除同一桶中的键；
- 它不是秘密存储，禁止保存 API Key、token、密码或个人敏感数据。

作者必须给 key 加稳定且足够独特的前缀，例如：

```ejs
<%
const KEY = 'com_example_project:panel-mode';
const mode = local.get(KEY, 'compact');
if (!local.has(KEY)) local.set(KEY, mode);
%>
面板模式：<%= mode %>
```

限制按 UTF-8 序列化大小计算：

- 单个值最多 16 KiB；
- 整个共享桶最多 64 KiB；
- 值必须可 JSON 序列化；
- key 不得包含 `.`，作者前缀应使用下划线、连字符、冒号或 UUID；
- 空 key 和危险 key 会被忽略；
- 超限或序列化失败的 `set` 不写入，并只记录诊断。

`local.get` 返回拷贝；缺失时返回 `fallback ?? null`。

## 7. EJS 能力面速查

完整类型以 [`engine-ejs.d.ts`](../../public/engine-ejs.d.ts) 为准。本节说明稳定语义和易错点。

### 7.1 `char`

| 方法 | 返回 |
| --- | --- |
| `char.player()` | 主角投影或 `null` |
| `char.get(name)` | 精确名字匹配的角色或 `null` |
| `char.present()` | `生命值 > 0` 的角色；不表示地理位置“在场” |
| `char.all()` | 当前上下文提供的角色数组 |
| `char.has(name)` | 是否存在 |
| `char.affection(name)` | -100～100；缺失为 0 |
| `char.affectionLabel(name)` | 好感文字标签；缺失为空串 |

角色投影包含名字、类型、种族、身份、职业、三类资源、等级、层级、五维属性和地点。创作者不得假定 `char.all()` 一定包含整个存档的所有角色；上下文之外的可见性不属于稳定保证。

### 7.2 `world`

```ts
world.时间
world.时间详情 // { 纪元, 年, 月, 日, 星期, 时, 分, 时段 } | null
world.地点
world.天气
world.回合
world.isDaytime()
```

`world.isDaytime()` 使用 06:00～17:59 作为白天；无时间详情时返回 `true`。地点、天气等缺失时为空串。不要使用宿主 `Date` 推导游戏时间。

### 7.3 `quest`

| 方法 | 语义 |
| --- | --- |
| `quest.all()` | 当前上下文任务投影 |
| `quest.active()` | 状态为“进行中”、`active` 或空状态 |
| `quest.get(name)` | 按名字查找 |
| `quest.has(name)` | 是否存在 |
| `quest.focus()` | 玩家当前焦点任务 |

任务投影为 `{ 名字, 状态, 描述, 目标[], 进度, 奖励[], 关注度 }`。

### 7.4 `lore`

```ts
lore.get(entryName)
lore.get(bookName, entryName)
lore.has(entryName)
lore.has(bookName, entryName)
lore.list(bookName)
```

规则：

- 只能读取当前 Agent 已选择且已激活的世界书条目；
- `get` 返回条目原始正文，不递归执行其中的 EJS；
- 全局查找返回第一个同名条目，因此新内容应优先使用双参数形式；
- 每个 EJS 条目最多调用 `get` 8 次，超出返回空串；
- 单次结果最多 64K 字符；
- `has` 不消耗 `get` 次数。

```ejs
<%
const appendix = lore.get('示例资料书', '术语附录');
%>
<% if (appendix) { %>
<%= appendix %>
<% } %>
```

### 7.5 `chat`

```ts
chat.last(role?)
chat.at(index, role?)
chat.slice(start, end, role?)
chat.match(stringOrRegExp)
chat.text()
```

- 角色筛选接受 `user` / `assistant`；
- `at(-1)` 从末尾取最新一条；
- `slice` 的结束下标不包含；
- 字符串 `match` 做子串匹配；
- RegExp `match` 会移除 `g` / `y` 后测试。

稳定契约只保证 Agent 历史注入窗口内的数据。当前实现中 `last/at/slice` 可能看到比 `match/text` 更长的运行时历史，这属于兼容余量，新内容不得依赖窗口外消息。

### 7.6 `fmt`

`fmt` 提供后端一致的格式化：

- `yaml`、`json`、`table`、`list`；
- `num`、`pct`、`bar`；
- `pad`、`truncate`；
- `compareName`、`sortNames`。

每次格式化的字符串结果最多 64K 字符。应使用 `fmt.num` / `fmt.pct` / `fmt.compareName`，不要依赖 `Intl`、`toLocaleString` 或 `localeCompare` 的本地化表现。

### 7.7 `rng`

```ts
rng.roll('2d6+3')
rng.rollDetail('1d100')
rng.int(min, max)       // 闭区间
rng.float()             // [0, 1)
rng.pick(items)
rng.pickN(items, n)     // 不重复
rng.shuffle(items)
rng.chance(p)           // p 自动夹在 0..1
```

种子由“存档 ID + 回合号 + 条目精确正文”构成。同一存档点、同一回合、同一正文、同一调用顺序会得到相同结果。修改条目正文会改变序列；两条正文完全相同的条目在同一 pass 会得到相同序列。

`Math.random`、文本位 `{{random::...}}` 和墙钟时间不具备快照重放确定性，新内容不得用它们决定需要重放一致的提示内容。

```ejs
<%
const candidates = ['A', 'B', 'C'];
const selected = rng.pick(candidates) ?? 'A';
%>
本回合选择：<%= selected %>
```

### 7.8 `ui`

`ui.notify(message, level?)` 给玩家显示带外提示，`ui.log(...args)` 写入调试通道；两者都不进入 Agent 提示。

- 每个 EJS 条目最多 3 条去重通知；
- 每个 EJS 条目最多 512 次日志；
- 宿主未提供对应出口时会静默丢弃；
- 通知不得承载玩法必需信息。

### 7.9 `engine`

```ts
engine.name    // 'poem-of-destiny'
engine.version // '1.0.0'
engine.has(path)
```

`engine.has` 查询硬编码的能力路径，不是任意对象反射。应只用它探测本文和 `engine-ejs.d.ts` 中明确列出的路径。当前 `engine.has('world.isDaytime')` 与 `engine.has('engine.name')` 会返回 `false`，即使成员本身存在；作者不得用这两个结果反推成员不存在。

### 7.10 `_` 的可移植子集

生产 QuickJS 保证以下 25 个 lodash 风格方法：

`get`、`trim`、`isArray`、`isObject`、`isObjectLike`、`isEmpty`、`values`、`keys`、`has`、`uniq`、`isPlainObject`、`isNumber`、`isString`、`size`、`cloneDeep`、`omit`、`pick`、`mapValues`、`mapKeys`、`pickBy`、`forOwn`、`find`、`flatMap`、`keyBy`、`chain`。

`chain` 只保证：`get`、`trim`、`isArray`、`isObject`、`isObjectLike`、`isEmpty`、`mapValues`、`find`、`flatMap`、`pick`、`pickBy`、`values`、`keys`、`has`、`uniq`、`keyBy`。

不得依赖旧 Legacy 后端额外出现的 `toPath`、`isFunction`、`random` 或 `sample`。随机统一使用 `rng`。

## 8. EJS 兼容别名

别名只为导入存量 SillyTavern / 酒馆助手 / MVU 内容存在。新内容应直接使用命名空间 API。

| 存量名字 | 当前映射 |
| --- | --- |
| `getMessageVar` / `getvar` | 先读 `stats`，再读 `vars` |
| `setMessageVar` / `setvar` | 只写 `vars` |
| `getLocalVar` / `setLocalVar` | EJS `local` |
| EJS `localStorage.getItem/setItem/removeItem` | EJS `local` 的字符串兼容层 |
| `variables.stat_data` | `vars` 与 `stats` 的合并读视图，`stats` 胜 |
| `matchChatMessages` | `chat.match` |
| `getChatMessage` / `getChatMessages` | `chat.at` / `chat.slice(...).join('\n')`；后者返回字符串 |
| `getwi` | `lore.get` |
| `YAML.stringify` | `fmt.yaml` |
| `TavernHelper.getLastMessageId` | `world.回合` |
| `TavernHelper.getVariables` | `variables.stat_data` 兼容视图 |
| `toastr.*` / `alert` | `ui.notify`；`alert` 不阻塞 |
| `message_id` / `lastMessageId` | `world.回合` |
| `console.log/info/warn/error` | `ui.log` |
| `charLoreBook` | 当前配置中的首个世界书 ID |

这里的 EJS `localStorage` **不是浏览器 localStorage**，也不是 regex frame 的 `localStorage`。两个同名兼容层的含义完全不同：

- 世界书 EJS：映射到当前存档共享 EJS `local`；
- 输出美化 iframe：映射到全应用共享 `regexStorage`。

## 9. EJS 原生 JavaScript 与隔离

生产 EJS 在主线程 QuickJS guest realm 中执行。`globalThis`、`Function`、`eval`、类和原型属于 guest 自己，不能因此得到宿主权限。

可依赖的基础能力包括现代 JavaScript 语法、`Math`、`JSON`、`String`、`Number`、`Boolean`、基础 `RegExp`、`Array`、`Object`、`Set`、`Map`、`Promise`。

不得依赖：

- `window`、`document` 或宿主 DOM；
- `fetch`、`XMLHttpRequest`、`WebSocket`；
- 浏览器 IndexedDB / sessionStorage；
- timer、导航、文件系统；
- Node.js 全局；
- `Intl`、`structuredClone`；
- EJS 内的 RegExp `v` flag 或命名捕获组；
- `Date` 的本地时区/本地化输出。

这不影响输出美化正则使用浏览器宿主支持的命名捕获和 `$<name>` replacement。

## 10. EJS 预算、错误与回退

### 10.1 资源预算

| 项目 | 当前上限 | 超限结果 |
| --- | ---: | --- |
| 单条目执行 | 50 ms | 当前条目回退原文 |
| 单 Agent 装配 pass | 5000 ms | 当前及剩余动态条目回退原文 |
| QuickJS heap | 64 MiB | 条目或 pass 回退 |
| QuickJS stack | 512 KiB | 当前条目回退 |
| `vars` 差量 | 256 KiB UTF-8 | 整份差量拒绝 |
| EJS `local` 单值 / 总量 | 16 / 64 KiB UTF-8 | 当前写入忽略 |
| `lore.get` | 每条目 8 次、每次 64K 字符 | 返回空串或截断 |
| 每个 `fmt.*` 字符串 | 64K 字符 | 截断并带标记 |

当前没有“整个 EJS 条目输出 256 KiB”的硬上限。作者仍应控制体积，因为输出会直接增加提示 token 和装配延迟。

### 10.2 回退原子性

语法错误、未知全局、运行异常、超时或内存失败时：

1. 当前条目的 `vars` 与 EJS `local` 写入回滚；
2. 该条目的原始 `content` 原样进入提示；
3. 后续条目继续执行，除非整个 pass 已超时；
4. 诊断记录条目 uid 和错误。

若 QuickJS 初始化失败，生产环境 fail-closed：所有 EJS 条目保持原文，不会切回不隔离的 Legacy `new Function` 后端。

因此作者应避免让 EJS 原文包含不适合直接给 AI 看的密钥、内部注释或大量程序代码。

## 11. 输出美化规则格式

### 11.1 原生规则

应用内部规则字段：

```ts
interface BeautifierRule {
  id: string;
  name: string;
  scope: 'maintext' | 'options' | 'summary' | 'thinking' | 'global';
  pattern: string;       // 不带 /.../ 定界符
  flags: string;         // 例如 'gim'
  replacement: string;
  enabled: boolean;
  order: number;
  minDepth?: number;
  maxDepth?: number;
}
```

当前已提交叙事 renderer 使用 `maintext`；`global` 也会命中它。工坊导入规则统一落到 `maintext`。

### 11.2 工坊 ST 正则字段映射

| ST 字段 | 导入结果 | 兼容状态 |
| --- | --- | --- |
| `id` | 带项目命名空间的规则 ID | 支持 |
| `scriptName` | `name`；空值按项目内序号命名 | 支持 |
| `findRegex` | `pattern` + `flags` | 支持两种写法 |
| `replaceString` | `replacement`，存储时逐字保留 | 支持 |
| `disabled` | `enabled = !disabled` | 支持 |
| `placement` 含 `2` | assistant 输出显示侧 | 支持 |
| `minDepth` / `maxDepth` | 同名字段 | 支持，零基且含边界 |
| `markdownOnly=true` | 只使用显示侧 | 支持 |
| `markdownOnly=false` | 显示侧保留，提示词侧丢失 | 部分支持 |
| `promptOnly=true` | 整条不导入 | 不支持 |
| `placement` 不含 `2` | 整条不导入 | 不支持 user-only 等位置 |
| `trimStrings` | 忽略并报告 | 不支持 |
| `substituteRegex` | 仅在 pattern 真含宏时产生缺口 | pattern 宏未接线 |
| `runOnEdit` | 不执行 | 当前无消息编辑运行入口 |

工坊项目当前必须至少包含一个世界书条目，才能在存档启用面板中形成项目启用信号。纯正则、零世界书条目的项目会安装规则，但规则在任何存档都无法激活。发布纯视觉项目时应附带至少一个稳定命名的世界书条目，直到该限制解除。

导入归一化还遵守：

- 只有 `scriptName/script_name`、`findRegex/find_regex`、`replaceString/replace_string` 接受 snake_case 别名；
- 布尔字段必须是真布尔值；
- depth 必须是有限数字，数字字符串不接收；
- `placement` 只保留有限数字；缺失时是空数组；
- 缺失 ID 会按项目内序号生成；
- 项目内重复 ID 会被稳定消歧。

### 11.3 `findRegex` 两种写法

定界形式：

```text
/<status_panel\b[^>]*>([\s\S]*?)<\/status_panel>/gi
```

裸 pattern：

```text
<status_panel\b[^>]*>([\s\S]*?)</status_panel>
```

规则：

- 定界形式从最右侧未转义的 `/` 拆出 flags；
- 合法 flags 为 `d g i m s u v y`，不得重复；
- 尾部 flags 非法或重复时，整串按裸 pattern 处理；
- 裸 pattern **不会自动补 `g`**；
- 空 pattern 或编译失败时整条不导入；
- 缺失 `placement` 会规范化成空数组，因此不会默认成 AI 输出位置。

若希望替换全部命中，必须明确使用 `g`。

## 12. 匹配与 replacement 语义

### 12.1 规则何时运行

一条规则必须同时满足：

1. 全局美化开关开启；强制规则预览除外；
2. 规则 `enabled`；
3. 若规则带 `autoEnable` 工坊绑定，当前存档已启用对应项目；
4. scope 为 `maintext` 或 `global`；
5. 消息深度落在 `minDepth` / `maxDepth` 的含边界区间。

深度从最新 user/assistant 消息开始倒数，最新一条为 0；system event 不占深度。新消息会令旧消息深度增加，因此规则可能在跨过边界时出现或消失。独立预览和当前战斗叙事默认按深度 0 处理。

手动规则和没有 `autoEnable` 的内置规则不需要工坊项目启用信号。规则编辑器的强制预览可以绕过全局美化开关，但仍不是独立持久命名空间。

### 12.2 规则顺序是“消费未匹配原文”

规则按 `order` 升序执行。某条规则产生的 replacement 会变成 opaque 片段：

- 后续规则不能匹配 replacement 内部；
- 后续规则不能跨过 replacement 匹配两边的原文；
- 后续规则仍能匹配尚未被消费的原始文本；
- 空 replacement 也会消费命中，只是最终不创建可见片段。

这不同于连续调用 `String.replace`。需要组合转换时，应合并成一条规则，或让不同规则匹配互不重叠的源标签。

每个工坊项目的导入顺序都从同一 order 基数开始。跨项目同 order 的相对顺序不稳定；作者不得让两个项目的重叠 pattern 依赖谁先执行。

内置 `<item_info>` / `<task_info>` 会在自定义规则之前变成 opaque 富片段，后续规则不能进入或跨过它们。

### 12.3 JavaScript replacement token

支持原生 JavaScript 语义：

| token | 含义 |
| --- | --- |
| `$$` | 字面 `$` |
| `$&` | 完整匹配 |
| `$1`…`$99` | 编号捕获组 |
| 美元符号后接反引号 | 当前匹配之前的源文本 |
| `$'` | 当前匹配之后的源文本 |
| `$<name>` | 命名捕获组 |

未参与匹配的捕获组输出空串。两位捕获不存在时按 JavaScript 规则尝试首位捕获加后一位字面字符。公共语料已验证到 `$39`。

“匹配前/后文本”只以当前仍未匹配的 text segment 为边界，不会跨过更早规则产生的 opaque replacement。复杂规则应避免依赖这两个 token。

示例：

```json
{
  "scriptName": "示例状态卡",
  "findRegex": "/<status_panel>([\\s\\S]*?)<\\/status_panel>/g",
  "replaceString": "<section class=\"status-card\">$1</section>",
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": false,
  "runOnEdit": false,
  "trimStrings": [],
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": null,
  "placement": [2]
}
```

replacement 和捕获内容不消毒、不转义；未被任何规则命中的模型文本会转义 `&<>`。空 replacement 表示删除命中。

无 `g` 的规则只消费第一个合格命中。有 `g` 时消费全部；零长度 Unicode 匹配会推进索引，避免同一位置无限循环。运行时非法规则静默失效，不阻断后续规则。

### 12.4 replacement 不再经过模板处理

replacement 中以下内容全部按字面处理：

- `<%= ... %>`；
- `{{getvar::...}}` / `{{random::...}}`；
- Story preset 占位符；
- 酒馆助手变量宏。

需要动态行为时应使用 iframe JavaScript 和 `regexStorage`，或把动态信息先由模型输出到捕获组。

## 13. 富 replacement 的 iframe 契约

### 13.1 文档生命周期

- 流式输出阶段只显示普通文本，不创建脚本 frame；
- assistant 消息提交后才编译正则并创建 iframe；
- 每次富命中独占一个 iframe 和一个 DOM，未命中正文仍由宿主原生文本面渲染；
- 同一消息的不同命中、不同消息与不同预览均各自独立；
- replacement 可以是 HTML fragment，也可以是完整 HTML 文档；
- 外层 HTML 围栏、doctype、`html/head/body` 会按传输文档解析；
- `html` / `body` 属性、`style`、`script`、inline handler、SVG、图片、音频、视频和普通控件均可保留。

mapper 存储的 replacement 字符串保持原样，但渲染器会去外层空白和传输围栏、移除 doctype、抽取该 replacement 的第一套 `html/head/body` 并重建文档 shell。

宿主会在作者 head 前注入透明 body、`border-box`、媒体最大宽度和部分 `--theme-*` 变量；`prefers-reduced-motion` 时会压低动画。iframe 会自测高度，外层显示上限为 6000 px。

同一次命中的样式和脚本可以协作；CSS 不会泄漏到普通正文、应用父页面、其它命中或其它消息。跨命中 DOM 查询不受支持；需要跨 frame 持久协作时只能使用共享 `regexStorage`。frame 因正文变化或组件重建时脚本可能再次执行，需要“一次性”行为的脚本必须在当前 frame 内设置幂等 guard。

### 13.2 sandbox

frame 使用：

```html
<iframe sandbox="allow-scripts" credentialless referrerpolicy="no-referrer">
```

没有 `allow-same-origin`，因此内容运行在 opaque origin 中。它可以操作自己的 DOM，但不能读取父应用 DOM、Vue 状态、应用 localStorage、应用 Dexie、存档、API Key 或其它消息 frame。

frame 内的 `eval` / `new Function` 属于允许的浏览器脚本能力，但仍只能操作该 frame 自己的权限面。

> 本章描述的是**规则作者**的 frame（用户装过的正则）。模型输出里合成的 `<item_info>` / `<task_info>` 卡片走另一档收紧策略：`script-src` 只放行带 nonce 的宿主引导脚本、`script-src-attr 'none'`、`connect-src 'none'`，也不注入共享 `regexStorage`。样式、图片、字体、媒体不变。写正则时不会碰到这一档。

明确阻断或不保证：

- form submit；
- popup 和 `window.open`；
- download；
- top navigation 和外部链接导航；
- 嵌套 frame / object / manifest；
- 应用自身 `/api`（`Origin: null` 会被拒绝）；
- 任意读取本地文件或目录；
- modal API `alert/confirm/prompt`；
- IndexedDB。

普通按钮、输入控件和 frame 内事件可用。浏览器显式让用户选择文件等能力不属于本契约，作者不得依赖。

### 13.3 网络

为兼容现有语料，frame 允许：

- HTTP(S) script、style、image、font、audio、video；
- `fetch` / `XMLHttpRequest`；
- WebSocket / EventSource / sendBeacon；
- data/blob 资源；
- blob Worker。

实际请求仍受浏览器 CORS、mixed-content、CSP 子项、目标服务器策略和网络可用性影响。外部 Worker 不属于兼容面。

规则可以把以下数据发送给远程或本地网络：

- 当前 frame 可见的模型正文和捕获组；
- 共享 regex namespace 中的数据；
- 用户在该 frame 内主动输入的数据。

发布内容必须向用户说明外部端点和数据用途，不得把 `regexStorage` 当秘密仓库。

### 13.4 宿主兼容 shim

frame 提供少量空数据或 no-op shim，让部分存量脚本不立即崩溃：

- `TavernHelper` 的有限空实现；
- 全局 `getVariables` / `setVariables` / `replaceVariables`；
- `SillyTavern.getContext()` 的空 chat/局部 variables/no-op 保存能力；
- `Mvu` 的 null/false 结果；
- 最小 `_.get` / `_.set`。

这些 shim **不代表真实宿主集成**。脚本依赖 parent/top/opener、真实聊天记录、模型调用、slash command、事件总线、jQuery 或应用变量写入时会降级。新内容必须设计为 frame 自包含。

## 14. regexStorage 持久状态

### 14.1 唯一共享空间

每个 frame 中以下两个名字指向同一个 Storage-like 对象：

```js
window.regexStorage
window.localStorage
```

新内容应使用 `window.regexStorage` 表明意图；`localStorage` 只为存量规则兼容。

它是**整个应用唯一的共享不可信空间**：

- 所有规则、工坊项目、信任级别、存档和预览共享；
- 任意规则都能读取、覆盖、删除其它规则的数据；
- `clear()` 会清空所有作者的键；
- 工坊更新或卸载不会清理；
- 会随 FullBackup 导出和恢复。

作者必须使用反向域名或项目 UUID 前缀：

```js
const KEY = 'com.example.project:theme:v1';
```

这里与 EJS `vars/local` 不同：`regexStorage` key 可以包含点号。

禁止保存 API Key、登录 token、密码、未公开正文或其它秘密。

### 14.2 Storage-like API

支持以下同步接口：

```js
regexStorage.length
regexStorage.getItem(key)
regexStorage.setItem(key, value)
regexStorage.removeItem(key)
regexStorage.clear()
regexStorage.key(index)

regexStorage.myKey = 'value';
const value = regexStorage.myKey;
```

key/value 都会转成字符串。frame 创建时，持久快照会在作者 `head` 脚本执行前完成 hydration，所以首个同步 `getItem` 可以读到旧值。

不保证：

- `instanceof Storage`；
- Storage prototype 的其它行为；
- `Object.keys` / `for...in` 枚举所有存储键；
- `delete regexStorage.keyName`。

删除必须使用 `removeItem`。

写入流程：

1. 来源 frame 的同步镜像立即更新；
2. mutation 在 microtask 中发给宿主并异步写入 Dexie；
3. 成功后广播给其它 frame，并触发对应 `storage` event；
4. 写库失败时，来源 frame 回滚到最后持久快照。

`setItem` 返回只代表内存镜像已更新，不代表磁盘提交完成。跨 frame `storage` event 不发给来源 frame，且 `storageArea === null`。

### 14.3 配额

| 项目 | 上限 |
| --- | ---: |
| 全共享空间 | 5 MiB UTF-8，key + value 合计 |
| key 数量 | 1024 |
| 单个 key | 4096 UTF-8 bytes |

超限时 `setItem` 同步抛出 `DOMException`，`name === 'QuotaExceededError'`。作者应捕获并降级：

```js
const KEY = 'com.example.project:theme:v1';

function saveTheme(theme) {
  try {
    window.regexStorage.setItem(KEY, theme);
    return true;
  } catch (error) {
    if (error && error.name === 'QuotaExceededError') return false;
    throw error;
  }
}
```

`sessionStorage` 使用同类同步 shim 和配额，但只在当前消息 frame 存活；消息重建或页面重载后清空。IndexedDB 不开放。初始持久库加载失败时，regex namespace 会退化为本次应用生命周期内的共享空内存。

## 15. 性能与可用性责任

EJS 有执行预算，regex 和 iframe JavaScript 当前没有独立 CPU、内存或网络预算。正则匹配发生在父应用主线程，iframe 脚本也可能阻塞 renderer。作者必须：

- 避免灾难性回溯，例如嵌套量词对长正文做全局扫描；
- 避免无限循环、长同步循环和大规模 DOM 重排；
- 对 MutationObserver、interval 类逻辑自行清理；
- 避免为每个字符创建 DOM 节点；
- 给网络请求设置超时和错误 UI；
- 让无网络、CORS 失败、存储满额时仍能显示基础内容；
- 不依赖 modal、popup 或父页面导航完成核心交互。

一条 ReDoS 正则或无限 JavaScript 循环可能卡住渲染线程。这是当前创作者必须承担的硬约束。

## 16. 可复制的最小模板

### 16.1 条件世界书条目

```ejs
<%
const player = stats.主角;
const lowResource = Boolean(
  player &&
  player.生命值上限 > 0 &&
  player.生命值 / player.生命值上限 < 0.25
);
%>
<% if (lowResource) { %>
生成后续行动时，应体现主角当前资源紧张。
<% } %>
```

### 16.2 带持久偏好的富 replacement

把下列文档作为 `replaceString`，用捕获组 `$1` 填入内容。key 必须换成作者自己的唯一前缀。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        margin: 0;
        color: var(--theme-text, #e8e4dc);
      }

      .panel {
        padding: 12px;
        border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        border-radius: 10px;
      }

      .panel[data-mode="compact"] .detail {
        display: none;
      }
    </style>
  </head>
  <body>
    <section class="panel" id="panel">
      <button type="button" id="toggle">切换详情</button>
      <div class="detail">$1</div>
    </section>
    <script>
      if (!window.__examplePanelReady) {
        window.__examplePanelReady = true;

        const KEY = 'com.example.project:panel-mode:v1';
        const panel = document.getElementById('panel');
        const button = document.getElementById('toggle');
        let mode = window.regexStorage.getItem(KEY) || 'expanded';

        function render() {
          panel.dataset.mode = mode;
        }

        button.addEventListener('click', function () {
          mode = mode === 'compact' ? 'expanded' : 'compact';
          render();
          try {
            window.regexStorage.setItem(KEY, mode);
          } catch (error) {
            console.warn('preference was not persisted', error);
          }
        });

        render();
      }
    </script>
  </body>
</html>
```

该模板没有父页面依赖；存储失败时交互仍可在当前 frame 内工作。

## 17. 调试指南

### 17.1 EJS 原文出现在 Agent 提示或生成内容里

依次检查：

1. 是否有未声明变量、未知全局或 strict-mode 赋值；
2. 是否使用了 DOM、网络、`Intl`、`structuredClone` 等未提供能力；
3. 是否超出 50 ms、内存或 stack，或 awaited Promise 未在 50 ms 内落定；
4. `vars` / `local` 值是否包含循环引用；
5. QuickJS 初始化是否 fail-closed；
6. 调试日志中的条目 uid 和 fallback 错误。

### 17.2 EJS 状态没有跨回合保存

检查：

- 当前执行它的 Agent 是否有 `ejsVarsCommit`；默认应放在 story 可见世界书；
- 是否超过 256 KiB `vars` diff；
- `local.set` 是否超过 16/64 KiB；
- AI 是否在同一路径用 `vars_update` 覆盖；
- 当前条目是否在写入后发生异常并整体回滚。

### 17.3 正则安装了但不命中

检查：

1. 项目是否至少有一个世界书条目；
2. 当前存档是否启用该工坊项目；
3. `promptOnly` 是否为 `false`；
4. `placement` 是否包含 `2`；
5. `findRegex` 是裸 pattern 还是 `/pattern/flags`，是否误把斜杠当正文；
6. 是否忘了 `g`；
7. `minDepth/maxDepth` 是否包含目标消息；
8. 更早 `order` 的规则是否已经消费该段原文；
9. 全局美化开关和规则 `enabled` 是否开启。

### 17.4 HTML 有了但脚本行为不对

检查：

- 脚本是否在流式阶段观察；脚本只在提交后运行；
- 是否依赖 parent/top/opener 或真实 SillyTavern API；
- 是否依赖 `alert/confirm/prompt`、popup、form submit 或 navigation；
- 是否使用 IndexedDB，而不是 `regexStorage`；
- 网络端点是否允许 opaque origin 的 CORS；
- 页面是否因 mixed content 拦截 HTTP 资源；
- replacement 中的 `{{...}}` / EJS 是否被误当作还会求值；
- 脚本是否因 frame 重建而重复执行且缺少幂等 guard。

### 17.5 持久偏好互相覆盖

检查：

- key 是否带作者/项目/版本前缀；
- 是否有脚本调用 `clear()`；
- 是否超过 1024 keys 或 5 MiB；
- 是否把每次预览当成独立 namespace；
- 是否正确处理跨 frame `storage` event；
- 是否把 `setItem` 返回误认为已经耐久落盘。

## 18. 发布前检查清单

### 世界书 / EJS

- [ ] 每条 `name/comment` 稳定且项目内唯一。
- [ ] 已确认 `key` 和 `position` 不参与当前激活。
- [ ] 动态条目的 `order` 能满足跨条目 `vars` 读写顺序。
- [ ] `stats` 只读，没有 mutation。
- [ ] `vars` 使用项目顶层前缀，且允许 AI 覆盖同路径。
- [ ] `vars` 和 EJS `local` 的 key 不含点号。
- [ ] EJS `local` key 使用唯一前缀，不含秘密。
- [ ] 随机使用 `rng`，格式化使用 `fmt`。
- [ ] 不依赖 DOM、网络、`Intl`、命名捕获或 `include`。
- [ ] 故意触发过一次错误，确认原文回退仍不会泄露不该给 AI 的内容。
- [ ] 世界书对正确 Agent 可见，持久写入在有 `ejsVarsCommit` 的 Agent 中验证。

### 输出美化正则

- [ ] 项目至少包含一个世界书条目。
- [ ] `placement` 含 `2`，`promptOnly=false`。
- [ ] 已明确裸 pattern 不自动 `g`。
- [ ] 捕获组在长正文和缺失可选组时均测试。
- [ ] 多条规则的 `order` 不依赖二次匹配 replacement。
- [ ] 不依赖跨项目同 order 的执行顺序。
- [ ] replacement 不依赖 EJS 或 `{{...}}` 宏。
- [ ] 无 parent/top/opener、真实宿主变量或模型调用依赖。
- [ ] 网络失败、存储失败时仍有可读降级。
- [ ] `regexStorage` key 有唯一前缀，没有 `clear()`，没有秘密。
- [ ] 没有灾难性回溯、无限循环或大规模同步 DOM 工作。
- [ ] 已在“流式中”和“提交后”分别验证表现。
- [ ] 已披露所有外部网络端点和发送的数据。

## 19. 当前公共语料基线

2026-08-02 的匿名公共工坊快照：

- 303 个项目；
- 51 个项目含正则，共 99 条；
- 83 条定界 pattern、16 条裸 pattern；
- 99 条 pattern 均可编译；
- 按现行字段映射有 94 条可落地；
- 90 条输出 HTML、82 条含 style、35 条含 script、37 条完整文档；
- 60 条引用外部资源；
- 16 条依赖 parent/top/opener，14 条依赖宿主 API，仍会降级；
- 5 个项目共 6 条 active 规则使用持久 storage，均只调用 `getItem/setItem/removeItem`；
- 2 个纯正则项目因没有世界书条目，当前无法形成存档启用信号。

这份基线用于说明为什么本引擎保留完整 HTML/CSS/JS、网络和共享 Storage 兼容面。它不是对任意第三方内容质量或安全性的背书。
