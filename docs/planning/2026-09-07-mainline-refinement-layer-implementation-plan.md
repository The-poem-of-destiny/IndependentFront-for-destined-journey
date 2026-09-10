# 主线细化层实施计划

> **状态：已实施（2026-09-09），真机游玩与真实 LLM 回合待验证** —— T0-T4 代码/内容完成、
> T5 UI 组件与组件测试通过（真机浏览器走查未做）、T6 回归 gates 全绿（9484 tests）。
> 实际交付记录见本文件 §6 验收记录表。
>
> **设计真源**：[主线细化层设计](2026-09-07-mainline-refinement-layer-design.md)。
>
> **代码基线**：`master@38b861b`，2026-09-07 从 `306327b` fast-forward 后核对。
> 本文中的拟新增文件、字段及函数均为实施方案，不代表当前代码已存在。
>
> **执行方式**：按依赖顺序逐项实施，沿用仓库工具链，不要求特定 skill、Agent 编排或新增依赖。

## 1. 交付目标与停止点

在大纲事件窗口之间，由既有 pre/post 两个剧情 Agent 产生、演绎和结算主线细化节点。
Code 决定本轮能否推进细化，AI 决定具体行动与伏笔。节点随存档保存、随时间线恢复，玩家可在
剧情面板查看节点和连线，调试面板可解释本轮闸门结果。

完成标准：

1. `triggeredEvents: []` 的普通回合仍可产生合法细化；大纲事件触发和结算保持原有语义。
2. 节奏、按名更新、时间戳、揭示状态、连线和持久化均有单一代码入口。
3. Story 收到的是可演绎的行动建议；post 收到同轮已接受声明，不能靠异步数据库碰巧写完。
4. 后续 pre/post 请求通过既有 `plot` scope 感知节点变化，不因节点变化重基线。
5. 旧档缺字段可正常游玩；完整备份、单档互传、快照恢复保留节点与冷却状态。
6. 聚焦测试、`npm run gates` 和真实 UI 走查通过；真实提示词交付及游玩质量单独记录。

不新增 Agent、LLM 轮次、Dexie 表、图形依赖、后台清理任务或节点编辑器。不改变大纲内容、
`plotEvents` title 寻址、随机事件调度、记忆分配、世界线或时间推进。细化模块不产生任务补丁、
主线状态补丁或 `delta_time`；正文导致的普通游戏行为仍走现有正文后处理。

## 2. 代码核对与需要澄清的设计表述

以下是本次从磁盘核对的实施依据。

| 位置                                                                    | 已有行为                                                                 | 实施影响                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `src/sillytavern/types.ts`：`SaveProfile`                               | `worldFlags` 与 `variables` 是并列字段                                   | 设计 §5.1 的 `saveProfiles.variables.worldFlags` 应更正为 `SaveProfile.worldFlags`，不能创建嵌套副本 |
| `src/sillytavern/plot-engine.ts`：`parsePreCheckOutput`、`preCheckPlot` | 解析后只处理大纲；`triggeredEvents` 为空即返回                           | 细化必须独立处理，不能挂在触发事件非空分支内                                                         |
| `src/ui/lib/game-pipeline.ts`：`handlePlotPreCheck`                     | 同步生成 Story 导演块，异步写大纲事件                                    | 先接受细化声明并更新本轮上下文，再让 Story/post 使用；不得依赖异步 pre 落库顺序                      |
| 同文件：`persistPlotPostCheck`                                          | 大纲结算完成后生成关联记忆                                               | 细化结算不走 `eventToMemory`，不冒充大纲事件                                                         |
| 同文件：`executeRun`                                                    | 成功后排空剧情任务，再 `advanceTurn()`；失败不推进回合                   | 细化状态应在成功收口、快照之前提交；不把失败尝试算作冷却回合                                         |
| `src/sillytavern/state-manager.ts`                                      | profile 写入已有 per-save FIFO；`advanceTurn()` 后创建快照               | 新写入口复用锁；锁内重读 profile，避免覆盖并行变量/地图写入，不嵌套同锁                              |
| `src/sillytavern/agent-templates.ts`：`buildPlotContextBlock`           | pre/post 的 `PLOT_EVENTS` 被替换为富上下文                               | baseline 可在该块附加细化快照，保留既有模板入口                                                      |
| `src/sillytavern/prompt-state-projection.ts`                            | `plot` 仅有 active/pending 的 `{title,status}`；变为 null 不发清空 delta | 必须扩投影；新增节点视图清空时也必须发送明确空值，避免模型保留旧节点                                 |
| `src/sillytavern/prompt-session-assembler.ts`                           | `PLOT_EVENTS` 是 projection-backed；`AGENT.*` 每轮注入                   | 持久节点走 plot，闸门和同轮声明走 turn context，不能塞进静态 system                                  |
| `src/ui/components/game/PlotPanel.vue`                                  | `visibility` 与临时 `spoilerMode/peeked` 分离                            | 节点 status 不足以判断是否剧透，必须补独立揭示契约                                                   |
| `src/sillytavern/time-system.ts`                                        | 已有 `parseMonthTime`、`compareMonthTime`、`toEpochMinutes`、`diffDays`  | 复用游戏历法，不用宿主 `Date` 解析游戏月份                                                           |

设计 §7 的“记忆自然承接”按 §10 解释为：正文继续进入既有记忆流程，结构化伏笔连续性由
节点快照承担；不为细化节点额外创建记忆记录。

## 3. 实施前收口的契约与建议默认值

设计没有指定下面的数值和若干生命周期细节。本节提供可执行的建议，**不是原设计已有裁定**。
开始代码任务 T1 前，将最终采用的规则以带日期补注同步到设计文档；不把未定参数悄悄藏进实现。

### 3.1 节奏策略

建议首版仅在 `plotSettings.mode === 'main'` 且存在有效主线锚时启用；`side/off` 不产生节点。
复用剧情模式，不新增设置页旋钮；与 ADR-32 的开关及概率完全独立。

| 项目           | 建议规则                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 主线锚         | 从当前大纲标题、章节标题与所属大纲事件标题建立去重的精确名字集合；`directionAnchors` 是自由文本，仅供语义参考，不拆成虚构标题 |
| 窗口候选       | 读取有合法 `timeWindow` 的 pending 大纲事件；窗口距离取最近未来窗口起点，月窗口从该月首日开始                                 |
| 空白期         | 有正在 active 的大纲事件或当前已处于任一 pending 事件窗口时，关闭细化推进；该轮仍运行原大纲检查                               |
| 同轮大纲触发   | pre 返回实际可接受的大纲触发时，优先大纲，丢弃本轮细化推进声明；不能按无效标题误关闸                                          |
| 无可用未来窗口 | 保守不生成，返回明确原因；不把缺日期当距离为零                                                                                |
| 冷却           | 全存档每 4 个成功普通回合至多一次推进；首次无冷却；若上次推进是 t，则 t+4 最早再次允许                                        |
| 概率           | 距窗口 >60 游戏日：0.15；31–60 日：0.30；8–30 日：0.50；1–7 日：0.70                                                          |
| 每次额度       | 至多一个新建节点或既有节点的叙事推进；连线可引用已有节点，不借一条声明批量新增                                                |
| 战斗           | 回合入口已有 `combatActive` 时关闭；本轮 Story 新触发战斗与“已有战斗会话”区分，不重写战斗协调器                               |
| 重试           | 使用稳定存档标识、成功回合序号和专用 salt 取确定性随机值；同一未完成回合重试不重掷                                            |

窗口距离只控制节奏，不替代剧情 Agent 对自然语言触发条件的判断。阈值集中在一个默认策略
常量中，测试固定输入；不要求有限随机样本恰好呈现目标频率。

闸门控制“新建/推进行动”，不禁止 post 对已存在节点进行有正文证据的结算。未提及不等于
消散，不因等待若干回合自动 resolved/dissolved，不要求补齐伏笔配额。

### 3.2 节点、揭示与连线

保留设计的 `name/gist/thread/motive/involvedNpcs/status/foreshadows/payoffs/seededAt/resolvedAt`。
拟新增的最小账务字段：节点 `visibility: hidden | revealed`，以及状态袋的冷却/提交游标。

- 建议形状为 `worldFlags.plotThreads = { nodes: Record<节点名, PlotThreadNode>, lastAdvancedTurn?, lastCommittedTurn? }`。
  字段缺席读取为空；getter 不写库，不迁移全库，不新增存储版本框架。
- `name` 是稳定身份：同名更新不重复插入，不提供重命名操作；空字段不覆盖已有非空叙事。
- `seededAt` 首次插入由 Code 写游戏 epoch minutes，更新不改；`resolvedAt` 仅首次确认回收时写。
  UI 用游戏时间格式化函数显示，不按现实 Unix 毫秒解释。
- pre 只声明 `active/dormant`，post 才确认 `resolved/dissolved`；dormant 再次按名声明可复活。
  建议首版终态保留历史、不自动复活；若要续写终态节点，产生新名并以引用承接。
- pre 新声明默认 hidden；post 依据正文明确报告 `revealedNames`，Code 单向置 revealed。
  “活跃”“已回收”均不自动等于玩家知道。用户临时揭示不写持久字段。
- `A.foreshadows=[B]` 与 `B.payoffs=[A]` 都推导为 A→B，去重，不保存独立边表。
- 前向引用允许目标暂未出现，保存引用但不自动制造空节点；UI 不把未知目标当既有事实。
  自引用去掉并告警；无需强制 DAG，设计没有禁止成环，不增加拓扑校验器。
- pre 可提出 payoff 引用；已存在节点的回收和新增 payoff 连线须由 post 确认，pre 不提前改旧节点终态。
  foreshadows 表示意向连线，不等同已经兑现。

状态枚举按本设计的四个英文值存储，在集中定义处给中文显示映射，并在字段规范中记录此处
对“中文枚举”通则的明确例外；不一面使用英文设计、一面让不同写入口各自翻译。

### 3.3 AI 输出与本轮临时上下文

在原 JSON 上添加可选字段，建议命名：

| 输出 | 新字段                                                                                           | 权限                                               |
| ---- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| pre  | `threadDeclarations: Array<{name,gist,thread,motive,involvedNpcs,status,foreshadows?,payoffs?}>` | 提出节点与连线；不产时间戳、id、揭示状态或账务游标 |
| post | `threadUpdates: Array<{name,status: 'resolved'                                                   | 'dissolved',payoffs?: string[]}>`                  | 只结算已有节点或同轮接受节点；不凭空创建节点 |
| post | `revealedNames: string[]`                                                                        | 指定正文已向玩家呈现的节点，未知名字告警并跳过     |

没有新字段按空数组处理，旧 JSON 可继续工作。新字段中的坏条目独立丢弃并告警，不把有效
大纲输出一起判废。归一化仅在模型输出入口执行一次；内部消费已归一化对象。

拟在 `AgentContext` 增加三项类型化数据：持久节点快照、本轮闸门结果、同轮已接受声明。
同轮声明是临时工作集，post 可见；不是另一个持久真源。

导演块仅包含通过闸门的可演绎行动与场景融合要求，不把节点账务、未揭示终局、窗口标题或
全量事件线 JSON 直接发给 Story。保留原背景和 directive 兼容处理；测试确保空导演块时也
不会退回泄露原始结构化 pre 输出。Code 能保证结构化声明不越闸，不能声称能识别任意自由
文本是否“偷偷推进”主线；这部分由 prompt 约束和真实游玩质量验收。

### 3.4 侧链角色实体化的可见性与一致性（2026-09-09 讨论新增）

设计 §6 的写读归属未把 `char_gen`（角色生成侧链）列入节点读侧：它不直接读节点快照，
新 NPC 由 dispatcher 的 `<char_gen_request>` 触发、只服从请求描述。若不约束，生成出的
新角色背景会与节点动机脱节；若把节点全量塞给它，未揭示 `motive` 与连线意向会剧透。
本节按「实体化时点」分流，一致性由 Code 背书，不依赖 AI 自觉。本条为新增裁定，
原设计文档未见；T0 契约收口时以带日期补注同步回设计文档。

| 时点           | 判定                                                           | 给 char_gen 的内容                                         | 剧透风险                 |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| A 节点先于角色 | 角色尚未在正文/角色库出现，dispatcher 为 `involvedNpcs` 实体化 | 该节点全量（含 motive，行为化改写）                        | 无——玩家未见该角色另一面 |
| B 角色先于节点 | 角色已在正文/角色库出现，dispatcher 按正文证据补全             | 正文证据 + 该节点表层投影（name/gist/involvedNpcs/thread） | 有——必须藏               |

裁定：

1. **实体化时点分流**：char_gen_request 的 characterName 命中某节点 `involvedNpcs` 时，
   Code 从节点快照取该节点并按上表注入请求描述。时点判定依据是「该名字是否已在角色库/
   正文出现」——未出现走 A，已出现走 B；拿不准时保守走 B。
2. **行为暗示，不身份披露**：motive 本体**不进角色档案**（玩家能打开查看），进请求描述的
   是行为约束（如「人前装作寡言行商、回避出身、对雾蕈行情异常敏感」）。档案中出现未揭示
   身份即剧透，视为违规。
3. **身份型伏笔埋模糊钩子**：pre 对「角色型/身份型」伏笔只埋模糊目标（「一名身份不明的
   外乡人」），不把幕后身份写死在节点里；真身在揭示动作时由 pre/post 补。这样 char_gen
   自由生成的背景与节点永无冲突（节点当时未预设），随机性与一致性从根上不打架。
4. **连线意向不外泄**：`foreshadows`/`payoffs` 是 AI 的因果预判，任何投影不得携带给
   char_gen；dispatcher 的可见面只开放过滤后的表层投影（见 T3 第 1 条），不得自动持有
   全量内部节点。
5. **责任落位**：Code 背书注入（时点分流 + 按名锚定）；pre 埋模糊钩子；char_gen 只负责
   把使命/行为约束生成得有血有肉，不负责猜使命。

### 3.5 持久化时机

建议采用“pre/post 暂存，成功回合收口写入”的最小方案：

1. 加载大纲与事件后，使用当前 profile、`totalTurns + 1`、游戏时间和战斗状态求闸门。
2. pre 归一化并经 Code 接受声明，同步更新临时工作集与 Story 导演块，不写细化事实态。
3. post 读取持久快照与同轮工作集，暂存有效结算；旧大纲落库路径照常执行。
4. `orchResult.status === 'completed'` 且既有后台任务收口后，以命名 StateManager 方法提交
   细化结果；随后才调用 `advanceTurn()` 创建回合快照。
5. 写入口在 per-save 锁内重读最新 profile，仅改 `worldFlags.plotThreads`；一次保存节点、
   冷却及 `lastCommittedTurn`。同一成功回合重复提交 no-op，不覆盖变量/地图等相邻状态。
6. 取消/失败丢弃临时工作集，不消费冷却；沿用已有 run/save 所有权与退出清理，不新建取消协议。

post 失败而整个回合仍被编排器判定 completed 时，建议只保存 pre 接受的隐藏节点，不写回收
结算；若整个回合失败则全丢弃细化暂存。该策略不声称回滚其他系统已落库的半回合数据。
写细化失败必须进入已有诊断通道并说明未保存，不追加自动 LLM 重试。

`advanceTurn()` 的游标推进和快照创建不是与上述写入天然同一事务；实施时针对它失败后的
同轮重交验证幂等，不声称全回合原子。除非测试证明该接缝仍会损坏节点状态，不扩大为全管线
事务重构。

## 4. 任务拆分与依赖

顺序：`T0 → T1 → T2 → T3 → T4 → T5 → T6`。T4 的内容包交付和 T5 的 UI 可以在 T3
契约稳定后分别推进，但本文不要求并行执行。每项完成先跑对应测试，全部结束才跑完整 gates。

### T0：冻结契约、更新设计补注

**涉及**：设计文档、本文、字段规范。

1. 收口 §3 的概率/冷却、main-only、窗口空白期、状态转换、揭示、成功收口及侧链实体化
   可见性（§3.4）规则；把 §3.4 新增裁定以带日期补注同步回设计文档。
2. 更正设计 §5.1 存储路径，记录节点袋形状、英文状态例外及前向引用语义。
3. 明确 `thread` 的允许锚集合；`directionAnchors?: string` 已核对为自由文本，不从中猜测结构化标题。
4. 编码前阅读引擎/UI 分册；实体变更参考字段规范与实体审计，提示词变更参考模板指南。

**验收**：设计与实施计划对同一行为给出相同答案；后续测试不需要自行猜测产品语义。

### T1：实现节点领域逻辑与纯节奏判据

**拟新增**：`src/sillytavern/plot-threads.ts`、同名测试。
**扩展**：`save-profile.ts`、必要的集中类型/枚举定义。

1. 定义节点/状态袋/声明/结算/闸门结果类型，按名查找与图边推导只有一个实现。
2. getter 提供旧档空值；纯 reducer 处理插入、更新、休眠复活、终态、揭示、引用与时间戳。
3. 纯 `evaluatePlotThreadGate` 接收锚、窗口、回合、时间和状态；返回允许与否、原因、距离、
   概率、抽样值及剩余冷却。调试 UI 直接消费此结果。
4. 使用现有确定性随机原语，独立 salt，不能推进 ADR-32 的随机序列或调用其调度入口。
   若现有原语不导出，仅抽取最小通用纯函数，不把两个调度系统合并。
5. 日历转换复用现有函数；保留前向引用、去重边，不做数据库或 UI 工作。

**验收**：固定输入重复执行结果一致；冷却边界、跨年窗口、战斗/off/side、无窗口及空白期
规则正确；同名不重复、空字段不抹数据、pre 不终结节点、post 未提及不消散。

### T2：扩展解析、成功收口写入和管线接线

**涉及**：`plot-engine.ts`、`state-manager.ts`、`types.ts`、`src/ui/lib/game-pipeline.ts`；
必要时 `agent-orchestrator.ts`（char_gen_request marker 扫描）或 `char-gen-agent.ts`（请求构建）。
**测试**：现有 `plot-engine.test.ts`、`game-pipeline.test.ts`，拟新增
`state-manager.plot-threads.test.ts`。

1. 在现有解析器加入可选字段归一化，保留旧键；保留 `directive/outlineRelevance` 的实际兼容行为。
2. `loadPlotData()` 完成之后准备闸门，pre 完成时同步生成合法工作集；不要挂在
   `triggeredEvents.length > 0` 分支中。
3. post 开始前通过共享上下文提供同轮接受声明，不读后台 pre 落库来寻找节点。
4. 新增窄写入口，例如 `commitPlotThreadTurn()`，只接受归一化批次及 Code 回合信息；
   锁内重读 profile，执行 reducer，保存后返回可供日志使用的结果。
5. 成功分支中在 `advanceTurn()` 前调用；失败、取消和下一轮入口清理临时工作集。
6. 不把细化结果转为 `PlotEvent`、`StatePatch` 通用 worldFlags 写入或记忆记录。
7. char_gen_request 的 characterName 命中节点 `involvedNpcs` 时，按 §3.4 时点分流取该
   节点注入请求描述（场景 A 全量行为化 / 场景 B 表层投影，拿不准走 B）；未命中不加戏。

**验收**：同轮 pre 新建→Story 使用→post 回收→快照包含结果；无大纲触发仍可细化；关闭
闸门时 AI 越权声明不保存；与 `vars_update` 并行后双方状态均保留；取消重试不重复消费；
char_gen_request 命中 involvedNpcs 时按实体化时点注入正确投影，未命中不加戏。

### T3：baseline、Delta 与 Agent 可见性接通

**涉及**：`agent-templates.ts`、`placeholder-registry.ts`、`prompt-state-projection.ts`、
`prompt-session-assembler.ts` 及现有对应测试。

1. 为 pre/post 的 `PLOT_EVENTS` 富块增加事件线快照；不把完整内部节点自动加到 Story 或
   dispatcher 的可见面。dispatcher 的可见面只开放**过滤后的表层投影**（仅 revealed+active
   节点的 name/gist/involvedNpcs/thread，无 motive、无连线意向），供其撰写贴合主线的
   `<char_gen_request>`（§3.4 场景 B 的投影来源）。
2. 快照包括全部 active、未回收 dormant 伏笔及被引用的历史节点；近期终态建议保留最新
   10 条，其余仍存库并在 UI 可查。按稳定名字/时间排序，不在渲染时写状态。
3. 为避免同名 dormant 永久藏在过滤之外，上述未回收集合必须包含 dormant；引用闭包按
   visited 集合去重，不能因合法环无限展开。
4. 持久快照加入既有 `plot` 投影，保持 baseline 和 delta 字段语义一致。空集合变化要显式
   清空；不更换整个 prompt session 架构。
5. 为闸门和同轮声明增加最少的 turn-context 入口，例如 `PLOT_THREAD_TURN`；在 resolver、
   默认模板、assembler ephemeral 分类及设置页占位符目录同步注册。
6. `AGENT.PLOT_PRE_CHECK` 继续只给 Story 经过处理的导演块，post 通过独立临时入口拿结构化
   声明，避免两种消费方共用不兼容格式。
7. 断言实际组装请求：首次有全量节点，第二轮有节点 delta 和新闸门，只有静态配置变化才
   按现有规则重基线；切档/恢复使用现有 session 失效机制。
8. 为侧链实体化提供节点投影的**数据入口**：暴露按名取节点（含场景 A 的行为化改写/场景 B
   的表层视图）的只读纯函数，供 T2 的 marker 侧拼接；本任务不负责拼接发生时点，只保证
   投影内容遵守 §3.4 裁定 1-4（档案不含未揭示身份、不含 motive 本体与连线意向）。

**验收**：节点无变化不产生节点 delta；活跃→终态、引用变化、全量清空均可见；只有
pre/post 看见未揭示结构化节点；dispatcher 只持表层投影、char_gen 投影档案不含未揭示
身份/motive/连线意向；增加节点不破坏成功 wire transcript 前缀。

快照不能为了固定字符限额静默丢弃活跃伏笔。首版记录实际节点数与 prompt 用量；沿用
Delta 设计的普通回合 miss 预算，不新增摘要 Agent 或自动删除历史来回避预算。

### T4：提示词与真实内容交付

**公开仓**：`public/data/defaults/agent-config.json`、`agent-templates.ts` 示例与默认模板。
**真实内容仓**：本机已确认 `E:/Projects/POD-IF/fated_poem_independent_assets/data/defaults/agent-config.json`。
远程新 AGENTS 中的 `D:/Code/...` 是另一台机器路径，实施者按实际挂载定位。

1. pre 提示词明确分开“严格按现有标题触发大纲”与“按闸门创造细化”，保留原保守触发规则。
2. 要求主体、动机、行为、场景融合；不预告窗口、不强制玩家参与、不保证回收、不写数值账务。
   身份型/角色型伏笔埋模糊钩子（§3.4 裁定 3），不把幕后身份写死在节点里。
3. post 以本轮正文为证据，仅在确有兑现/消散时结算；揭示与终结分开，缺证据留原状。
4. 所有 JSON 示例与解析类型一致，覆盖空数组、休眠、复活、回收及前向引用；世界观叙事
   示例先读私有叙事规范，不将机制术语写进 Story 文案。
5. 同步真实内容仓的模板和 `reference/agent流程测试/` 资料，按其已有构建器验证内容包。
   不把真实 IP 提示词拷入公开占位集。
6. 核对保存过的自定义 template/systemPrompt 和导入内容包的覆盖顺序。旧输出按空数组兼容，
   自定义提示词保留；记录更新提示词的实际入口，不能只改默认 JSON 后宣称老用户已经启用。
7. 检查实际 Story 预设是否渲染 `AGENT.PLOT_PRE_CHECK`，通过现有预设装配修正本次交付的
   真实预设，避免将工作误放到被 preset 短路的 Story systemPrompt。

**验收**：公开占位配置及真实包分别能生成合法输出；一次真实 pre→Story→post 回合证实
新字段生效。拿不到私有内容时公共实现可继续，但交付状态明确标“真实内容接线待验证”。

### T5：事件线面板与调试区

**涉及**：`PlotPanel.vue`、拟新增 `PlotThreadsPanel.vue`、`DebugPanel.vue`；按需从
`game-store.ts` 的既有 `saveProfile` 派生只读数据，不建第二份持久 store。

1. UI 编码前读取 `src/ui/AGENTS.md`、`docs/design.md` 和相关 UI 规范。
2. 在剧情面板内增加带文字的“事件线”入口；按主线锚分组显示节点卡与轻量 SVG/CSS 连线，
   小屏可显示有方向的关联列表，不做力导向画布、拖拽或缩放系统。
3. 显示节点简述、状态、已揭示信息与游戏时间，连线使用 T1 的统一推导结果。
4. 复用剧透开关及逐条临时查看语义。隐藏节点不得通过标题、thread 分组名、连线端点、
   tooltip、ARIA 标签或隐藏 DOM 文本泄露；涉及隐藏端点的边也要遮蔽。
5. `motive` 可能包含正文尚未揭示的幕后原因，默认详情不显示完整动机；仅剧透模式显式
   查看时显示，避免“见过节点”被误当“知道全部内幕”。
6. 切换存档/关闭剧透模式清空临时 peek；无大纲但有历史节点时仍可查看历史，缺字段显示
   正常空态，不以零节点暗示功能报错。
7. 调试区展示生产闸门结果、节点状态计数、最近接受/忽略声明和原因。当前下一轮判据与
   上一轮实际结果区分标注；不得在 UI 重写概率/冷却判据或通过查看面板推进随机状态。

**验收**：组件测试覆盖隐藏节点、关联泄露、剧透关闭和切档；真实浏览器走查桌面/窄屏、
键盘操作、长中文名、多节点及空态。截图和检查结论留在工作区；停止所启动的预览进程。

### T6：存档往返、完整回归与交付文档

**涉及**：`session-backup.test.ts`、`database.test.ts`、StateManager/游戏 store 的现有
快照恢复测试，必要的 focused 集成测试。

1. 用真实 Dexie 测试入口导出/导入完整备份和单档，断言 nodes、引用、揭示状态、游戏时间
   与冷却游标保留；不同 saveId 之间不串档，导入换 id 后不引用旧存档标识。
2. 创建节点→打快照→推进/结算→恢复旧快照，断言节点、冷却、UI 和下一轮 prompt 均回到
   旧态；不新建专用迁移或补偿恢复机制。
3. 旧档无字段、旧 Agent 无新输出正常运行；随机事件开关组合不影响细化概率，反之亦然。
4. 完成下面测试矩阵及 gates；记录真实内容包版本和游玩/截图证据。
5. 同步设计状态、字段字典 SSOT 表、引擎/UI 分册、新入口导航与 CHANGELOG。计划真正
   交付后按 `docs/archive/README.md` 归档并更新引用；未通过真机项继续标待验证。
6. 若进入发布阶段，代码按分支+PR 流程，提交前检查文档，push 后等对应 CI 终态；本文
   的编写本身不执行代码实现、提交或发布。

## 5. 验证矩阵

| 层次    | 负载承重点                   | 最小证据                                                            |
| ------- | ---------------------------- | ------------------------------------------------------------------- |
| 纯逻辑  | 日期、概率、冷却、重试稳定性 | 固定种子；t+3 关闭/t+4 可判概率；跨月跨年与无窗口                   |
| reducer | 按名更新与历史保留           | 同名不增行、空值不覆盖、休眠复活、终态保留、去重边、未出现端点      |
| 解析    | 外部 AI 输出不可信           | 旧 JSON、缺字段、坏条目混有效条目、未知结算名字、越权时间戳         |
| 管线    | 不依赖后台时序               | 延迟旧 pre 落库，post 仍见同轮声明；触发为空仍生成；失败/取消后重试 |
| 写入    | profile RMW 与提交幂等       | 并行变量更新均保留；重复回合不改时间戳/冷却；落库失败后不伪报成功   |
| prompt  | baseline/delta 语义一致      | 第二轮 wire messages、节点清空、闸门变化、Story 结构化信息隔离      |
| 存档    | 完整往返与恢复               | FullBackup、单档、恢复旧快照、旧档缺字段、切档隔离                  |
| UI      | 防剧透与可读性               | DOM 内容/可访问名测试，桌面及窄屏实际截图                           |
| 内容    | 有动机的行动、自然伏笔       | 远窗口样例、近窗口样例、玩家忽略、已有伏笔回收、主线正常触发        |
| 侧链    | 实体化一致性与防剧透         | 场景 A 按全量生成、场景 B 只持表层、档案无未揭示身份、未命中不加戏  |

建议命令（实施对应文件存在后运行）：

```bash
npm run test:run -- src/sillytavern/plot-threads.test.ts src/sillytavern/plot-engine.test.ts src/sillytavern/state-manager.plot-threads.test.ts
npm run test:run -- src/ui/lib/game-pipeline.test.ts src/sillytavern/agent-templates.test.ts src/sillytavern/placeholder-registry.test.ts src/sillytavern/prompt-state-projection.test.ts src/sillytavern/prompt-session-assembler.test.ts
npm run test:run -- src/sillytavern/session-backup.test.ts src/sillytavern/database.test.ts
npm run gates
```

新增 UI 测试随 T5 实际文件名加入聚焦命令。中文修改逐文件跑 U+FFFD/控制字符检查，JSON
还须解析成功；Prettier 只格式化本次修改文件。Windows 下可使用 `npm.cmd/npx.cmd`。

真实游玩验证使用测试存档或用户备份副本，不直接篡改唯一存档。通过 fixture 覆盖远/近窗口
及冷却边界，再观察自然回合内容；不要求真实随机游玩恰好在第几轮触发。记录实际 Agent
调用集合，确认未增加请求；按 Delta 设计预热后检查连续普通回合 usage，不能用字符差估算
缓存 miss。未取得 provider 数据时明确留待验，不写成本达标。

## 6. 风险边界与验收记录

| 风险                                   | 可达依据                                | 归属与处理                                                             |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| 只改默认配置，真实游玩无新输出         | 存量自定义配置/内容包有覆盖优先级       | T4 核验实际装载配置和最终请求，不覆盖用户自定义内容                    |
| 节点没有出现在后续上下文               | 当前 plot 投影不含节点                  | T3 同时验证 baseline 与第二轮请求                                      |
| post 找不到同轮新节点                  | pre 的现有大纲落库是异步任务            | T2 同步临时工作集，不让 post 等待无关数据库写入                        |
| 覆盖相邻 worldFlags                    | vars_update 与 post 在同一 DAG 阶段并行 | StateManager 锁内重读/窄写，复用既有队列                               |
| 未揭示因果从面板泄露                   | 节点状态和玩家知识不是同一事实          | T5 独立 visibility、动机剧透限制、边端点遮蔽                           |
| 活跃伏笔累积增加上下文                 | 设计要求历史不删、未回收持续可见        | 稳定筛选终态历史并实测预算；不自作主张丢活跃节点                       |
| char_gen 生成 NPC 与节点动机脱节或剧透 | 侧链只服从薄请求、motives 默认不给      | §3.4 时点分流（A 全给/B 表层）+ 行为暗示 + 模糊钩子，Code 按名锚定注入 |

执行时逐项填入实际结果，不提前勾选：

| 项目              | 状态 | 实际记录                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0 契约收口       | ✅   | 设计文档追加 §11（2026-09-09 收口裁定：存储形状/节奏判据/AI 输出契约/侧链实体化/持久化时机）；§5.1 存储路径已更正                                                                                                                                                                                                                                           |
| T1 领域逻辑       | ✅   | `src/sillytavern/plot-threads.ts` + 测试 28 条全绿（固定输入确定性/冷却边界 t+3 关 t+4 开/跨年窗口/空白期/reducer 语义/去重边/前向引用/快照闭包/surface 防剧透）                                                                                                                                                                                            |
| T2 管线与持久化   | ✅   | `plot-engine.ts` 解析扩展（parseThreadDeclarations/Updates/RevealedNames + countAcceptableTriggers）；`save-profile.commitPlotThreadTurn`（锁内重读窄写+幂等，4 条测试）；game-pipeline 闸门/工作集/导演块/成功收口/char_gen 时点分流注入（buildCharGenProjectionA/B）                                                                                      |
| T3 上下文与 Delta | ✅   | plot scope 并入节点快照 + 显式清空（set null）；PLOT_THREAD_TURN / PLOT_THREAD_SURFACE 两个 ephemeral resolver + 模板注册 + placeholder-catalog；buildPlotContextBlock 富块；6 条 projection/assembler 测试（wire 前缀稳定、delta 只发变化）                                                                                                                |
| T4 内容交付       | ✅   | 公开占位 `public/data/defaults/agent-config.json`（pre/post systemPrompt + 3 模板，U+FFFD=0 / ctrl=0 / JSON 可解析）；私有内容仓 `agent-config.json` 同步 + **pack 2.7.0 构建成功**（agentDefaults.agents 13 个，含新契约）；`agent流程测试/要求.md` 追加主线细化测试要求；story 预设 `AGENT.PLOT_PRE_CHECK` ✓（预设短路无碍）。⚠ 真实 LLM 回合验证留待真机 |
| T5 UI             | ✅   | `PlotThreadsPanel.vue`（挂进 PlotPanel 带文字入口）+ `plot-thread-view.ts` + `plot-thread-debug.ts`；**组件测试抓出并修复一处真实防剧透漏洞**（详情"埋向/回收"引用行泄露隐藏端点 → visibleRefs 过滤）；DebugPanel 区块（生产函数求值，查看无副作用）。⚠ 真实浏览器走查未做；截图未产出                                                                      |
| T6 总验收         | ✅   | `npm run gates` 全绿（9484 tests / 8 skipped）；session-backup 往返 1 条新用例（nodes/引用/揭示/时间戳/冷却游标保留+不串档）；快照恢复 2 条新用例（restore 回旧态 / 不串档）。⚠ 真机与 provider usage 数据留待验证                                                                                                                                          |

> 🔴 **仍未完成（如实标注）**：真实游玩回合（pre→Story→post 一次闭环驱动新字段）、UI 桌面/窄屏真机走查与截图、provider usage 数据记录。这三项都依赖真机环境，非本会话可完成项。

---

### 🔴 2026-09-09 实施纪律记录（谁踩了坑、下次怎么避）

1. **JSON 转义地狱**：`agent-config.json` 的 systemPrompt 是**单行字符串**，内部 JSON 示例的引号是
   `\"`、换行是 `\n` 两字符。用「shell 内联 python -c」做替换时 PowerShell 的引号层会把转义吃掉；
   正确姿势是写成 `.py` 文件再执行，且锚点全部从文件 repr 验证过再 replace。
2. **插入点不能选「第 6 条」这种句子中段**：第一次 patch 把整节插进「6. 🔴 时间判断：」与它的正文
   中间，句子被截断成两半仍悄悄写进文件 —— 锚点必须选「一整节的标题行」。
3. **真实换行写进 JSON 字符串值**：用 `'\n'`（一字符）拼 section 时，JSON 值内只允许两字符
   `\n`；后果是文件能写回、`json.loads` 当场报「Invalid control character」，验证必需后置。
4. **组件测试抓防剧透漏洞的回报率极高**：jsdom 断言 `html.not.toContain(名字)` 直接抓到了
   「已揭示节点详情里的埋向/回收行引用隐藏节点名」这一处真实泄漏 —— 这个断言模式建议长期保留逐条加。
5. **不同层级的「可见」要分字段**：视图函数里 `masked` 只依据 reveal+peek；剧透模式只允许
   `peek`（不改 masked 判定），否则「开剧透=全显示」会绕过逐条揭示的语义（与 PlotPanel 同口径）。
