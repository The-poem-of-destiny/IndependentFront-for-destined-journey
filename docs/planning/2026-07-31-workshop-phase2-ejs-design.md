# 工坊 Phase 2 —— EJS 沙盒 + 只读 stats 投影 设计 v1.2

> 状态：**拷问定稿（2026-07-31，五轮）** · **已实施（T1-T6，2026-07-31）待真机**，对应决策已录 ADR-30（AGENTS.md 设计约定）· 契约词汇见根目录 `CONTEXT.md` · 实施纪要见 `docs/CHANGELOG.md`「工坊 P2」
>
> 修订：v1.1 —— 契约按主人指定重构为**两轴**：①只读 stats 面 ②EJS 变量沙盒。**契约自主设计，不承诺 MVU/酒馆助手兼容**；上游函数名只作薄别名层保留。v1 中「2a 纯只读 + 写回全部推给 2b」的框架废弃。
> 修订：v1.2（拷问五轮）——
> ① stats 面收窄为**纯代码推导数值**（hp/mp/sp/等级/五维/命运点数/时间），背包/技能/装备暂缓（§5）；
> ② `事件.*` 等叙事变量移入沙盒，沙盒从「EJS 专属 `ejs.*` 孤岛」改为「**与 AI 共写的叙事变量空间**（`variables.sys` 草稿）」，冲突仲裁 **AI 赢**——v1.1 的 `ejs` 命名空间/AI 拒写守卫/整树替换提交全部废弃；
> ③ census 修正（块内 lodash 全读边；`_.set/insert/assign` 是散文 MVU DSL 示例）+ 新发现 `getvar()/setvar()` JS 函数形态与 `variables` 裸全局；
> ④ 缓存分层扫描器加宽为三根针 `<%` / `{{random` / `{{getvar`（静态区可证明字节稳定）；
> ⑤ 提交权改 **per-Agent 声明**（`ejsVarsCommit`，默认仅 story）——前瞻扩展设计；
> ⑥ `世界.时间` 定为 `formatGameTime` 规范串（语料核对通过）；体积护栏 UX 定为「toast 一次 + 持久诊断行、整份拒绝不截断」。
>
> 前置文档：
>
> - `docs/planning/2026-07-31-creative-workshop-compat-design.md`（工坊 v2，§0 把本阶段标为「另行设计」——本文档即该设计）
> - `docs/CHANGELOG.md`「工坊 P1」尾注：🔴 Phase 2 未做，条目正文 EJS 原样进 Agent 上下文
> - ADR-04（EJS 由 Code 层在提示装配时评估）· ADR-21（StateManager 唯一写入口）· ADR-28（世界书实现理念：模仿输入→结果，不照抄中间结构）
>
> 适用对象：**全部世界书条目正文**——内置 15 本与工坊 `creative_workshop` 分区一视同仁（承工坊 D6，无门禁无特判）。

---

## 0. 目标与契约总纲

**目标**：世界书条目正文里的 EJS 块在提示装配时被求值，AI 看到的是**渲染结果**而非模板源码。

**契约总纲（主人指定，两轴）**：

| 轴  | 名字                | 权限     | 内容                                                                                                                                       |
| --- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | **`stats`** 只读面  | EJS 只读 | **纯代码推导数值**：HP/MP/SP（含上限）、等级/层级/经验、五维、命运点数、游戏时间。**不含**叙事变量；背包/技能/装备**暂缓**（主人未定，§5） |
| ②   | **`vars`** 变量沙盒 | EJS 读写 | **与 AI 共写的叙事变量空间** = `SaveProfile.variables.sys` 的草稿视图——任意形状、任意路径、跨回合持久；`事件.*` 等全部叙事状态都住这里     |

EJS 永远写不到**引擎真源实体**（角色/物品/资源/任务等，ADR-21 无涉）；叙事变量空间是 AI 与 EJS 的**共写域**，提交顺序固定：**EJS 差量先落，vars_update 补丁后落 → 路径冲突时 AI 覆盖 EJS**。理由：EJS 在装配期基于回合开始的旧状态计算，AI 补丁反映本回合正文，更新鲜；且语料里 EJS 写全是守卫式初始化与自有簿记，真实冲突面≈0。上游 MVU 名字（`getMessageVar/setMessageVar/getLocalVar/setLocalVar/getvar/setvar`）保留为**别名层**映射到两轴（D5）；映射不了的上游 API 走错误隔离回退（D8），**不为兼容而扭曲契约**。

> 事实依据（拷问第一轮查明）：本引擎从不读 `sys.事件.*`——引擎自己的事件系统是一等公民 `PlotEvent` 树；`事件.*` 状态机是卡片遗留协议，**推进者本来就是 AI**（语料的 `gotoSignal()` 产出的是「教 AI 输出变量补丁」的指令文本）。若把沙盒做成 EJS 专属孤岛，AI 推进的事件阶段对 EJS 不可见，全部事件书状态机报废——所以必须共写。

---

## 1. 语料盘点（实测，2026-07-31）

> 统计口径：对 `data/worldbooks/*.json` 原始文件跑 `<%[\s\S]*?%>` 正则（含 JSON 转义字节）。与 CHANGELOG 引用的「event 297 / system_core 252」计数方法不同（后者按解析后正文），量级一致，不影响结论。

### 1.1 块数分布

| 世界书             | EJS 块数 | 条目数备注              |
| ------------------ | -------- | ----------------------- |
| `event.json`       | 284      | 19 条目，重度事件状态机 |
| `system_core.json` | 252      | 系统皮肤/人格分支       |
| `dlc.json`         | 71       |                         |
| `character.json`   | 53       |                         |
| 其余 11 本         | 0–4      | `variable.json` 为空    |
| **合计**           | **≈660** |                         |

### 1.2 EJS 内调用的函数（按出现次数）

**上游运行时内建**（酒馆助手/MVU 提供，本引擎以别名层承接）：

| 函数                                      | 次数   | 说明                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getMessageVar(path, opts?)`              | 109    | 读 `stat_data.*`；**33 处带 `{ defaults }` 第二参数**，必须支持                                                                                                                                                                                                                                                                                          |
| `getLocalVar` / `setLocalVar`             | 41     | 上游为聊天域持久局部变量                                                                                                                                                                                                                                                                                                                                 |
| `matchChatMessages(pattern)`              | 15     | 检测近期聊天正文是否命中关键词                                                                                                                                                                                                                                                                                                                           |
| `setMessageVar(path, val)`                | ≥11    | 写 `stat_data.*`（语料中两类用途：默认值初始化、触发时间/楼层类自有簿记）                                                                                                                                                                                                                                                                                |
| `getvar(key, opts?)` / `setvar(key, val)` | 21 / 3 | **JS 函数形态**（非 `{{getvar::}}` 宏）：既读 `stat_data.*` 路径也读扁平聊天变量键（`系统名`/`阿南刻`/`dialog_beauty.story`…）；opts 见过 `{ scope, defaults, noCache }`                                                                                                                                                                                 |
| `variables`                               | 2      | 裸全局对象，`_.get(variables, 'stat_data.关系列表', {})` 形态                                                                                                                                                                                                                                                                                            |
| `_`（lodash）                             | ~50    | **块内实测全部是读边**：`get(23)/trim(5)/isArray(3)/isObject(2)/isEmpty(2)` + `isObjectLike/mapValues/find/flatMap/pick/pickBy/values/keys/has/uniq/keyBy/chain` 各 1。⚠️ 初稿census 误记的 `_.set/_.insert/_.assign` **不在 EJS 块内**——它们是散文里教 AI 写 MVU 补丁的示例 DSL（`_.set(路径, 旧值, 新值)` 三参形态），走 vars_update 链路，与 EJS 无关 |
| `getChatMessages`                         | 1      | 酒馆助手 API，不承接（D8 回退）                                                                                                                                                                                                                                                                                                                          |
| 标准全局                                  | 多     | `Math` / `JSON` / `String` / `Number` / `Boolean` / `RegExp`                                                                                                                                                                                                                                                                                             |

**条目内自定义**（条目正文里 `function xx(){}` / `const SIG = {...}` 自带定义）：`SIG`、`gotoSignal`、`genTask` 等。**已验证自足**：`SIG` 定义于 event.json uid 349/350/351/359，`SIG.` 引用只出现在 351/359——**没有任何条目引用其它条目定义的符号**。条目 = 独立编译单元成立。

### 1.3 `getMessageVar` 读取的 `stat_data` 路径（Top）

| 路径                                               | 次数 | 引擎侧真源                                             |
| -------------------------------------------------- | ---- | ------------------------------------------------------ |
| `stat_data.事件.*`（阶段/信号/标题/开启/已完成…）  | 60+  | `SaveProfile.variables.sys.事件.*`（vars_update 写入） |
| `stat_data.主角.*`（等级/状态效果/背包/技能/装备） | 17   | 玩家 `CharacterState`（`type === 'player'`）           |
| `stat_data.世界.地点` / `stat_data.世界.时间`      | 10   | `variables.sys.世界.地点` / `SaveProfile.gameTime`     |
| `stat_data.关系列表`                               | 5    | `SaveProfile.affections` + `CharacterState`            |
| `stat_data.命运点数`                               | 2    | `SaveProfile.fp`                                       |
| `stat_data.任务列表`                               | 2    | `SaveProfile.quests`                                   |

**写路径**（`setMessageVar` 全部实例）：`事件.信号` 置 `[]`（默认值初始化，均有 `if (!Array.isArray(...))` 守卫）、`事件.冰之歌.触发时间/楼层`（EJS 自有簿记，引擎从不写这些路径）。→ 这佐证了两轴契约：**语料的写全部属于「EJS 自有簿记」域**，没有一处真的想改引擎真源。

### 1.4 现行 `ejs-runtime.ts`（Phase 4.6）判死

全仓 grep：**唯一 import 来自它自己的测试文件，生产代码零调用**。且结构性不可用——它把每个 `<% %>` 块编译成**独立** `new Function` 执行，而语料的**主导模式是跨块控制流**：

```ejs
<%_ if (!hasCompleted) { _%>
  ……大段条件正文……
<%_ } _%>
```

拆开编译时 `if (!hasCompleted) {` 单独是语法错误 → 两个代码块都进错误分支，**条件正文无条件泄出**。event.json 有 118 处 `if`，几乎全部跨块。结论：**不是接线问题，是要重写**（见 D2）。tokenizer（`<%_ / <%= / <%- / %> / _%>` 识别）可保留。

### 1.5 其它实测事实

- `await`：全语料 ≤1 处 → 同步编译即可，不支持 async（D8 错误隔离兜底）。
- `include()`：0 处 → 不需要模板嵌套。
- ST 宏 `{{getvar::}}/{{setvar::}}/{{random}}`：条目正文另有一批，现行 `LORE_BOOK` resolver 已用 `parseSetvars/resolveGetvars/resolveRandoms` 后处理，**保持不动**，EJS 求值排在它之前（D1）。
- 无 lodash 依赖（`package.json` 已核）→ D5 决定 shim 不引依赖。

---

## 2. 决策

### D1 — 求值位置：提示装配期、条目粒度、宏剥离之前

EJS 求值发生在**提示装配时的 Code 层**（承 ADR-04），单位是**单条世界书条目正文**。

挂点是现有的两条汇流路径（二者最终都到 `formatWorldBookEntries`）：

1. `placeholder-registry.ts` 的 `LORE_BOOK` resolver（模板系统主路径，story 规范预设的预解析也走它）
2. `agent-templates.ts` 的 `buildFallbackMessages`（无模板 Agent 的兜底路径）

两处改为调用新的 `renderWorldBookEntries(entries, ejsCtx)`（worldbook-loader 新增）：内部完成 D7 的静/动分层 + 逐条求值 + 拼接。**`formatWorldBookEntries` 保持纯拼接不动**，供不带上下文的调用方（测试/预览）继续使用。

顺序约定：**EJS 求值在前，既有 `setvar/getvar/random` 宏剥离在后**（对拼接结果跑，现行为准，不动）。EJS 输出里若产出 `{{getvar::}}` 引用，仍会被下游正常解析。

**范围排除**：预设正文、Agent systemPrompt、美化规则里的 EJS 不在本阶段求值（美化规则里的 `<script>` 处置已在工坊 v2 D14 决定）。

### D2 — 运行时重写：整片编译（经典 EJS 模型）

重写 `ejs-runtime.ts` 的执行层：一个条目的全部 token **编译进同一个函数体**——文本 token 变成 `__out.push('...')`，代码 token 原样内联，`<%=` 变成 `__out.push(String(expr))`。跨块 `if/for` 天然成立。

```
tokenize(content)  →  buildFnBody(tokens)  →  new Function(...沙盒参数, body)  →  fn(...沙盒实参)
```

- 同步编译执行，**不支持 `await`**（语料 ≤1 处，D8 兜底）。
- `<%=` 输出 `undefined/null` 时输出空串（对齐现行运行时行为）。
- 接口保持 `EjsRuntime` / `renderEjs` 名字，返回形状改为 `{ rendered, varsDraft, errors }`；测试文件随重写更新。

### D3 — 沙盒与信任模型：对齐 script-executor，不另立标准

沙盒手段与 `script-executor.ts` 同款：`new Function` + **参数遮蔽**（`globalThis`/`window`/`document`/`fetch`/`XMLHttpRequest`/`localStorage`/`indexedDB`… 作为值为 `undefined` 的形参传入）。

明确承认（引 script-executor.ts:172 原话的立场）：**这不是安全边界**——`({}).constructor.constructor('return globalThis')()` 类逃逸堵不死。信任模型与工坊 v2 D14 一致：用户装什么内容是用户的选择，沙盒是**失误防护**（防手滑改全局、防意外网络请求），不是恶意代码防线。工坊条目与内置条目同权，不做第二套更严格的沙盒（否则违反工坊 D6 一视同仁）。

**命名澄清**：EJS 沙盒面（`stats`/`vars`）与 script-executor 的 Layer 4/5 `$` API（`$event`/`$combat`…）是**两套互不相通的契约**——前者给世界书模板、纯装配期、无副作用通道；后者给 AI script、有事件订阅与语义操作。EJS 面刻意**不带 `$` 前缀**以示区分。

### D4 — 契约轴①：`stats` 只读面（stat-projection.ts）

新纯函数模块 `src/sillytavern/stat-projection.ts`：

```ts
buildStatData(input: {
  characters: CharacterState[];     // 取玩家（type==='player'）
  gameTime?: GameTime;
  fp?: number;
}): Record<string, any>             // → stats 快照（深拷贝，孤儿对象）
```

**范围（主人定）：纯代码推导数值，仅此而已**：

| `stats` 路径                                                 | 来源                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `主角.生命值/生命值上限/法力值/法力值上限/体力值/体力值上限` | 玩家 `CharacterState.hp/maxHp/mp/maxMp/sp/maxSp`                                                                                                                              |
| `主角.等级/生命层级/累计经验值/升级所需经验`                 | `level/tier(+tierName)/totalExp/expToNext`                                                                                                                                    |
| `主角.属性.力量/敏捷/体质/智力/精神` + `属性.属性点`         | `attributes.*` + `freeAttrPoints`                                                                                                                                             |
| `命运点数`                                                   | `SaveProfile.fp`                                                                                                                                                              |
| `世界.时间`                                                  | `formatGameTime(gameTime)`——引擎既有规范串（`复兴纪元001年-05月-24日-周日-15:30`）。语料核对过：2 处不解析只存取，1 处仅用 `/(\d+)\s*年/` 抽年份，此格式命中；无季节/月名解析 |

键名用**上游中文键**（对照语料与卡片 MVU init 的 `角色.*` 命名，实施时二选一定死并写进 golden 用例）。**不含**：叙事变量（住 `vars`）、背包/技能/装备/状态效果（**暂缓**，主人未定，§5）、任务列表/关系列表（AI 内容实体，且上游结构与我们的实体形状不同，投影了也对不上——语料读取全部带守卫，缺失时走默认分支，进 §4 降级清单）。

**「只读」的实现**：投影是深拷贝孤儿对象，EJS 就地改它不污染引擎，pass 结束即弃。**不 freeze**——语料存在对读取结果做局部数组操作再判断的模式，freeze 会误伤；「写了不生效」由拷贝语义保证，文档写明。stats 快照**每 pass 独立克隆**（体量极小，克隆无成本），杜绝跨 pass 写泄漏。

**注入口**：EJS 作用域内为顶层标识符 `stats`（如 `stats.主角.法力值`）。

### D5 — 契约轴②：`vars` 共写叙事变量空间 + 别名层

**`vars` 是 `SaveProfile.variables.sys` 的草稿**——一个普通可变对象，EJS 直接 `vars.事件.冰之歌 = { 触发时间: t }`、`vars.计数 = (vars.计数 ?? 0) + 1`，**任意形状任意路径**，无 schema 无守卫（除原型污染段拦截，复用 var-resolver 的 `DANGEROUS_PATH_SEGMENTS` 思路对 `__proto__/prototype/constructor` 键做写时剔除）。AI（vars_update 语义 op）与 EJS 写**同一棵树**。

**存储与生命周期**：

- 持久位置：`SaveProfile.variables.sys`（现有命名空间，**不新增** `'ejs'`）。变量已在 M5 迁入 profile 并纳入快照重建 → **快照回退/重发自动覆盖，零额外工作**。
- pass 语义：每次装配 pass 开始 `vars = deepClone(variables.sys)`（草稿）；条目按注入顺序依次执行，草稿上的写**后续条目立即可见**（语料的 pass 内状态机模式成立）。
- 提交语义（**per-Agent 提交权**，拷问第三轮按主人指定定型）：`AgentConfig` 新增 `ejsVarsCommit?: boolean`——**持权 Agent 的装配 pass 产出提交候选**，无权 pass 求值照常、草稿即弃。**默认只有 story 持权**（agent-config.json 置 true），但机制是逐 Agent 声明的——这是**面向扩展的前瞻设计**：将来「某工坊书只对特定 Agent 可见、又需要持久状态机」时给该 Agent 发权即可，不改架构。多 Agent 持权时按**管线阶段序（同阶段按 agentId 字典序）**依次应用各 pass 差量——顺序钉死 → 确定性保住；后应用者同路径覆盖先应用者。注意提交权是 **pass 粒度不是书粒度**——草稿是普通对象，深 diff 无法归因「哪本书写的哪条路径」（做归因要上 Proxy 全程拦截，不值得）。回合结算时对每个持权 pass 做「回合开始克隆 vs 最终草稿」**深 diff → set/del 的 VarsPatch → 在 `commitChatState()` 内经现有 `applyVarsPatch` 落库**——不开第二条写路径，ADR-21 保持唯一入口。
- **仲裁顺序（契约级）**：同一次回合结算内，**EJS 差量先应用，vars_update 的 AI 补丁后应用**——路径冲突时 AI 覆盖 EJS。见 §0 理由。
- 体积护栏：**对 EJS 差量**序列化测量，超上限（初值 256 KB）**整份拒绝**——不截断不部分提交（截断状态机的半棵写入比冻结它更糟）；AI 补丁不受此护栏影响；上限实测后调。**用户可见性**（拷问第五轮定）：①走既有系统通知通道 toast，**每存档每来源只提醒一次**（文案点名来源）；②拒绝计数 + 最近拒绝时间落一条持久诊断行（游戏页调试/快照区或设置页），事后可查。杜绝「簿记静默失灵、只能从剧情怪异反推」的最坏调试体验。

**读语义（别名层的三种读形）**：

- **叶子读**（`getMessageVar('stat_data.事件.冰之歌.触发时间')`）：链 `stats[path] ?? vars[path]`，未命中返回 `opts.defaults`。
- **子树读**（`…('stat_data.事件')`）：stats 骨架上没有该前缀 → **直接返回 `vars` 草稿的活引用**（对其属性赋值就是真实草稿写，与共写模型自洽）；stats 骨架上有的前缀（`主角`/`世界.时间`/`命运点数`）→ 返回 stats 侧克隆子树。
- **整树读**（`…('stat_data')`，语料 2 处、全带守卫）：返回浅合并 `{ ...vars草稿顶层, ...stats顶层 }`（stats 顶层键胜出）。`主角` 顶层键因此指向 stats 侧最小投影——语料经它读背包的分支会走守卫默认值（§4 降级）。

**别名层**（承接存量语料，全部映射到两轴，不引入第三种状态）：

| 上游名                                    | 映射                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getMessageVar(path, opts?)`              | 剥 `stat_data.` 前缀 → 上述三种读形                                                                                                                                                              |
| `setMessageVar(path, val)`                | 剥前缀 → **写 `vars` 草稿**（永不触碰 stats）                                                                                                                                                    |
| `getvar(key, opts?)` / `setvar(key, val)` | `key` 带 `stat_data.` 前缀 → 同 getMessageVar/setMessageVar；扁平键（`系统名`/`阿南刻`…）→ 同链不剥前缀（`stats[key] ?? vars[key]` / 写草稿）。opts 的 `scope/noCache` **忽略**，`defaults` 支持 |
| `getLocalVar(k)` / `setLocalVar(k, v)`    | 读写 `vars._local[k]`（= `sys._local.*` 保留子树；上游聊天域持久语义由共写树持久化天然满足）                                                                                                     |
| `variables`                               | 裸全局（语料 2 处 `_.get(variables, 'stat_data.…')`）：提供 `{ stat_data: 整树读视图 }`                                                                                                          |
| `matchChatMessages(pattern)`              | 独立辅助函数：对 `ctx.history` 近 N 层正文做子串/正则命中（N 对齐该 Agent historyLayers）                                                                                                        |

读链 `stats ?? vars` 的正确性核对过语料两类写：默认值初始化（`事件.信号` 置 `[]`）有 `if (!Array.isArray(getMessageVar(...)))` 守卫——sys 树有值读到真值不写、无值写草稿再读草稿，两支都对；自有簿记（`冰之歌.*`）AI 从不写同路径，无碰撞；共写树上**不存在** v1.1 孤岛方案的「旧影子遮新值」问题。**新内容（工坊作者）建议直接用 `stats`/`vars` 双轴，别名层只为存量语料存在**——工坊文档如此宣传。

**其余注入符号**：`_`（自研 shim `ejs-lodash-shim.ts`，**纯读边** 17 方法（§1.2 块内实测），全量单测；不引 lodash 依赖——方法大半十行内实现，为 ~50 次调用引整包不成比例；`_.chain` 仅 1 处、若实现成本高允许中招条目走 D8 回退）；`Math/JSON/String/Number/Boolean/RegExp/Array/Object` 原生直传。

**未注入的符号**（酒馆助手全家桶：`triggerSlash`、`getChatMessages`、`SillyTavern.*`…）：执行时 `ReferenceError` → 落 D8 条目级回退，**不做预检白名单**。工坊装前检视（`WorkshopDetailModal`）加「EJS 兼容预检」列为可选后续。

### D6 — 求值域小结

- **条目** = 编译单元，独立编译执行（§1.2 已验证语料无跨条目符号依赖）。
- **pass** = 状态域：三样共享物——`stats` 快照（pass 级克隆，只读）、`vars` 草稿（pass 级，读写、按序可见）、编译缓存（session 级）。
- **回合** = 提交域：持权 pass（默认仅 story）的 `vars` 差量随回合结算落库（持权 pass 间按管线序 → 再 AI 补丁，D5）；swipe/重发时以最终保留的那次 run 为准（快照重建覆盖回退场景）。

### D7 — 缓存分层：EJS 条目沉底 ★

**问题**：`{{LORE_BOOK}}` 是提示前部最大的稳定块（story 路径 20 万字级），prompt cache 的命中前缀依赖它逐字节不变。EJS 条目每回合求值结果随 `stats`/`vars` 变化——**只要一个 EJS 条目混在中间，它后面的全部字节每回合 cache miss**。

**方案**：`renderWorldBookEntries` 内把激活条目按**语法特征**一分为二——

```
hasDynamic(content)  ≡  /<%|\{\{random|\{\{getvar/.test(content)
```

- **静态区**：三种动态特征都不含的条目，按 `order` 排序拼接，**排在前**——**可证明地**逐字节稳定，最大化缓存前缀；
- **动态区**：命中任一特征的条目，按 `order` 排序、EJS 逐条求值后拼接，**沉到 LORE_BOOK 展开的尾部**。

三根针的理由（拷问第二轮实测，509 条目）：`<%` 是 EJS 本体；`{{random}}`（1 条无 EJS 条目）被 `resolveRandoms` 每次装配重掷；`{{getvar}}`（15 条无 EJS 条目）的取值可能来自**动态区** setvar/EJS 产出的定义，字节随之漂移。`{{setvar}}` 定义本身**无害**——`parseSetvars` 确定性剥离，不用扫。判定按**语法**不按求值结果（某块「恰好每回合输出相同」也算动态）：简单、可预测、零误判成本。

**为什么沉底无副作用**：

1. **求值语义不变**——静态条目不执行代码，pass 内状态域（D6）只由 EJS 条目参与，而 EJS 条目**彼此的相对顺序保留**，`vars` 写→读链不受影响。
2. **缓存收益封顶**——模板里排在 LORE_BOOK 之后的本来就是动态占位符（`CHARACTER_STATE/NARRATIVE/USER_INPUT`），所以动态区放在 LORE_BOOK 展开尾部 = 紧贴既有动态段，稳定前缀已是理论最大。
3. **接受的代价**：条目在提示里的叙述顺序偏离全局 `order`（动态条目整体后移）。世界书条目是独立 lore 单元，顺序敏感度低；两区内部各自保序。此取舍**明确接受**。

~~顺带项~~ → 已并入 `hasDynamic` 三根针（拷问第二轮定：**必做**，不是可选——静态区字节稳定是 D7 的全部意义，漏一根针就破功）。

**自定义模板扩展**：`LORE_BOOK` resolver 支持参数 `{{LORE_BOOK:section=static}}` / `{{LORE_BOOK:section=dynamic}}`，让自定义模板可把两区拆到不同位置；不传参数 = 静态区+动态区顺序连拼（默认行为，普通用户无感）。

### D8 — 错误隔离：条目级回退原样注入（零回归保证）

每条目 try/catch 两段（编译期/执行期）。任一失败 → **该条目回退为原文注入**（= 今天的现状），`console.warn` 带书名+uid+错误摘要，并计数。不中断其余条目，不中断装配；该条目对 `vars` 草稿的半途写入随条目失败**整体丢弃**（条目级写缓冲，成功才并入草稿——避免半执行状态污染）。

理由：回退到现状意味着 Phase 2 上线**最坏情况等于不上线**，没有新的丢内容风险。回退条目归动态区（它含 `<%`，字节虽稳定但归类从简）。

### D9 — 编译缓存与性能

- 编译产物缓存 `Map<content, CompiledFn>`（session 级不淘汰——全语料 ≈660 块无内存压力）；命中跳过编译**不跳过执行**。
- `stats` 快照每回合构建一次（game-pipeline 层），同回合多 Agent 装配复用；`vars` 草稿每 pass 克隆一次。
- 性能验收：全内置书首轮编译 + 单 pass 求值实测计时进测试报告（不预设阈值，实测后定）。

### D10 — 测试策略

| 层               | 内容                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时单测       | 跨块 if/for、`<%_ _%>` trim、`<%=`/`<%-`、错误隔离、条目失败写缓冲丢弃                                                                         |
| shim 单测        | 19 个 lodash 方法 + `_.insert` 全量                                                                                                            |
| 投影单测         | 合成规则/覆盖层冲突/深拷贝隔离（改投影不脏引擎状态）                                                                                           |
| 沙盒单测         | `vars` 草稿按序可见、三种读形（叶子/子树活引用/整树浅合并）、`_local` 子树、原型污染键剔除、深 diff 正确性（set/del）、体积护栏拒绝差量        |
| 提交/回退        | story pass 差量随 `commitChatState` 落库；非 story pass 不落；**仲裁顺序**（同路径 EJS+AI 双写 → AI 终值）；快照回退后 sys 树重建              |
| **全语料冒烟** ★ | 加载全部内置书真实条目 + fixture stats → `renderWorldBookEntries` 全跑：不抛、统计回退率、断言回退率上限（初值 5%，实测收紧）                  |
| golden 用例      | 从 event.json 抽 3-5 个真实条目（斯芬克斯支线/冰之歌/信号机）配 fixture 断言渲染结果——冰之歌用例须覆盖「触发时间写 vars → 下回合读回」跨回合链 |
| 分层测试         | 静/动分区、区内保序、`section=` 参数、EJS 相对顺序不变                                                                                         |

---

## 3. 管线接线（before → after）

```
before:
  LORE_BOOK resolver / buildFallbackMessages
    → getEntriesForAgent → filterActiveEntries
    → formatWorldBookEntries(entries)            # 按 order 全量拼接，EJS 源码原样
    → parseSetvars/resolveGetvars/resolveRandoms # 宏剥离

after:
  LORE_BOOK resolver / buildFallbackMessages
    → getEntriesForAgent → filterActiveEntries
    → renderWorldBookEntries(entries, ejsCtx)    # 🆕 worldbook-loader
        ├─ 分层: hasDynamic? → 静态区 | 动态区    (D7)
        ├─ 静态区: 按 order 拼接（字节稳定）
        └─ 动态区: 按 order 逐条 compile(缓存)+execute(stats快照 + vars草稿)，失败回退原文 (D2/D8/D9)
    → parseSetvars/resolveGetvars/resolveRandoms # 不动 (D1)

ejsCtx: { stats: ctx.statData, vars: sys 草稿, history: ctx.history }
提交流:  story pass 草稿 → 深 diff(回合开始克隆, 最终草稿) → VarsPatch → commitChatState 内 applyVarsPatch
         （先落 EJS 差量，后落 vars_update AI 补丁 —— 冲突 AI 赢）→ SaveProfile.variables.sys
```

新增/改动模块清单：

| 模块                                      | 动作                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `src/sillytavern/ejs-runtime.ts`          | 重写执行层为整片编译（D2）+ 沙盒参数遮蔽（D3）+ 两轴/别名注入（D4/D5）         |
| `src/sillytavern/ejs-lodash-shim.ts`      | 🆕 19+1 方法 shim                                                              |
| `src/sillytavern/stat-projection.ts`      | 🆕 `buildStatData` 投影                                                        |
| `src/sillytavern/worldbook-loader.ts`     | 🆕 `renderWorldBookEntries` + `hasDynamic`；`formatWorldBookEntries` 不动      |
| `src/sillytavern/placeholder-registry.ts` | `LORE_BOOK` 改调 `renderWorldBookEntries`，支持 `section=` 参数                |
| `src/sillytavern/agent-templates.ts`      | `buildFallbackMessages` 同步改调                                               |
| `src/sillytavern/types.ts`                | `AgentContext.statData?`；`AgentConfig.ejsVarsCommit?`（默认仅 story 置 true） |
| `src/sillytavern/ejs-vars-diff.ts`        | 🆕 深 diff（回合开始克隆 vs 最终草稿）→ set/del VarsPatch 纯函数 + 体积护栏    |
| `src/sillytavern/state-manager.ts`        | `commitChatState` payload 加可选 EJS 差量；应用顺序钉死「EJS 差量 → AI 补丁」  |
| `src/ui/lib/game-pipeline.ts`             | ctx 注入 `statData`；story pass 草稿暂存 → diff → 结算提交                     |

---

## 4. 已知降级清单（相对上游语义，明确接受）

| 降级                                                                                 | 后果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 处置                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 不支持 `await`                                                                       | 语料 ≤1 处，中招条目回退原文                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 接受                           |
| `matchChatMessages` 窗口 = historyLayers                                             | 上游可查全聊天记录，我们查注入窗口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 接受                           |
| 酒馆助手扩展 API 未注入（`getChatMessages` 等）                                      | 工坊条目用到 → 该条目回退原文（D8）。实施期实测（T1 冒烟）：内置书 6 条中招（`TavernHelper/getChatMessage/message_id/lastMessageId/YAML`），连同 1 条 `await` + 下行 `{{roll}}` 共 8/509 条回退（1.6%）                                                                                                                                                                                                                                                                                                                                                                    | 可选预检，后续                 |
| ~~**ST 宏嵌在 EJS 代码块内**（`event.json` uid 358：`if ({{roll 1d100}} >= 100)`）~~ | ~~注定回退原文~~ → **已修复（2026-08-01）**：D1 顺序不动，改在**编译期**把代码位（`<% %>`/`<%= %>`/`<%- %>`）里的**自足值宏**降成沙盒调用——`{{roll 1d100}}` → `__roll("1d100")`、`{{random::A,B}}` → `__random("A,B")`（`ejs-runtime.rewriteCodeMacros` + `dice.ts` 复用）。文本位的宏一律不动、照旧交下游宏链；`{{user}}`/`{{getvar}}`/`{{setvar}}` **不在改写表内**（前者在代码位多嵌于字符串字面量，实测 dlc#479 / system_core#417 共 5 处；后两者取值依赖宏链 setvar 表，求值时机不安全）。改写成**调用而非字面值** → 正文字节不变，编译缓存照常命中且每次执行真正重掷 | 已解决；白名单 8 → 7 条        |
| 无提交权 Agent 的 pass 写 `vars` 不落库（默认仅 story 持权）                         | 该 pass 内 EJS 写只在本 pass 生效；需要时给对应 Agent 发 `ejsVarsCommit` 权即可                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 按设计（per-Agent 提交权，D5） |
| `主角.背包/技能/装备/状态效果` 读不到（stats 暂缓 + sys 树无对应数据）               | 语料 17 处读全带守卫 → 走默认分支（如钥匙类条目当「未持有」处理）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 待主人定夺（§5）               |
| `关系列表`/`任务列表` 读不到                                                         | 上游结构与我们的实体形状不同，投影也对不上；语料读取全带守卫 → 默认分支                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 接受，真机观察                 |
| `getvar` 的 `scope/noCache` 选项忽略                                                 | 语料语义上不受影响（我们无缓存分层可绕）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 接受                           |

> v1 草案中「setMessageVar 不跨回合持久」「localVar 仅 pass 域」两条降级已被共写树契约**消除**。

---

## 5. 待拷问问题（本文档暂定，欢迎推翻）

1. **背包/技能/装备/状态效果是否进 `stats`**——主人明言「还没想好」，**挂起**。现状：不进（§4 降级，语料守卫兜底）。将来若工坊内容要做自定义物品体系，可能反而希望它们留在 `vars` 域。
2. 别名层 opts 是否需要 `{ defaults }` 之外的成员？（语料另见 `scope/noCache`，已决定忽略；先只做 defaults）

---

## 6. 排除项（拷问过/不做，防止重复讨论）

- **不承诺 MVU/酒馆助手兼容**——契约自主（§0 总纲），别名层是搭桥不是承诺；缺 API 走回退。
- **不嵌 iframe、不跑上游酒馆助手 JS**（承工坊 v2 总则）。
- **不给工坊条目单独沙盒等级**——违反工坊 D6 一视同仁。
- **不按求值结果判定动静**（「输出恰好稳定」的块也归动态区）——语法判定简单可预测（D7）。
- **不动既有 `setvar/getvar/random` 宏剥离链**——顺序上排在 EJS 之后照旧（D1）。
- **不给 EJS 任何写引擎真源实体的通道**（角色/物品/资源/任务）——契约基石；叙事变量共写树是唯一例外域，且 AI 赢。
- **不做 `ejs` 独立命名空间/AI 拒写守卫**——v1.1 方案，拷问第一轮废弃：事件状态机推进者本就是 AI，隔离弄死语料（§0）。
- 预设正文 / systemPrompt / 美化规则内的 EJS 求值——不在本阶段。

---

## 7. 实施切片建议（供实施计划参考，非承诺）

1. **切片 1**：ejs-runtime 整片编译重写 + shim + 两轴/别名注入 + 单测（纯函数域，无接线）✅
2. **切片 2**：stat-projection + 投影单测 ✅
3. **切片 3**：renderWorldBookEntries（分层+错误隔离+编译缓存）+ 全语料冒烟 ✅（509 条目 / 61 动态 / 8 条已知回退白名单）
4. **切片 4**：装配挂点接线 + `AgentContext.statData` + game-pipeline 注入 + `section=` 参数 ✅
5. **切片 5**：vars 差量持久化（深 diff + `commitChatState` payload + 仲裁顺序钉死 + 体积护栏）+ 提交/回退测试 ✅
6. **切片 6**：真机 debug loop 走查（关注：回退率、缓存命中字节数前后对比、story 首包延迟、冰之歌跨回合链）⬜ **未做**

验收口径：`npm run typecheck` 0 错误；`npm test -- --run` 全绿；全语料冒烟回退率 ≤5%；真机 story 请求 `cacheHitTokens` 相对改造前不劣化（理想应显著改善——这正是 D7 的存在意义）。
