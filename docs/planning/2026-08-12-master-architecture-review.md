# master 架构审查报告

- **审查日期：** 2026-08-12
- **审查基线：** `master`，提交 `82575ff0f92447e8a87e2f9aede9408978d24663`
- **审查范围：** 架构、模块边界、状态归属、持久化、生命周期与集成行为
- **排除项：** 安全与威胁模型审查

## 执行摘要

本仓库具备扎实的局部工程纪律：TypeScript 与 Vue 类型检查通过，测试套件规模可观，Lint 规则严格，死代码棘轮也未出现回归。当前最主要的架构风险并非局部类型或格式缺陷，而是集中在多个模块都认为自己拥有同一事务、生命周期或工作流的边界处。

本次审查共发现：

- **7 项 P1 问题**：可能造成状态丢失、领域结算部分落库、跨存档污染、运行时效果过期、剧情事件缺失、回合阻断或战斗会话悬空。
- **4 项 P2 问题**：会使持久化工作流变得脆弱、反转既定的引擎/UI 依赖方向、把完整回合拆散在浅层模块之间，或在本地取消后仍让上游请求继续运行。
- **未发现 P0 问题**；按要求，本次未开展安全审查。

收益最高的改造，是把 `StateManager` 从共享补丁工具改造成明确的状态命令边界，并提供两种彼此区分的契约：

1. 面向不可信 AI 补丁批次的“尽力而为”应用；以及
2. 面向 Code 侧领域操作的原子执行，例如制作结算、战斗结算、剧情迁移、快照恢复与新建游戏。

第二优先级是显式化存档身份与生命周期归属。每一次异步加载、回读、战斗等待和运行时投影，都应绑定到捕获的存档会话代次；该代次关闭后，所有相关工作都必须立即失效。

## 审查方法

本次审查以仓库文档和实际可执行路径为事实来源。只有在确认以下五点后，候选问题才会进入报告：

- **范围：** 哪个组件拥有相关不变量；
- **触发：** 哪个具体运行时事件会触发问题；
- **可达性：** 是否存在能到达该代码的生产调用路径；
- **影响：** 实际会改变哪些状态或行为；以及
- **证据：** 对应的源码、测试或文档契约。

架构审查重点是模块深度、归属、依赖方向、生命周期和事务接缝。目标不是单纯寻找大文件，而是识别那些迫使多个调用方理解实现细节的浅层边界。

## 现状架构速览

主要游戏流程如下：

```text
GamePage / Pinia stores
        |
        v
GamePipeline
        |
        v
AgentOrchestrator ----> request side chains ----> model clients
        |                         |
        |                         v
        +--------------------> StateManager ----> Dexie
                                      |
                                      v
                              effect runtime / EventBus
```

这个总体形状合理，但其中若干箭头尚未形成真正的归属边界：

- `GamePipeline` 与 `AgentOrchestrator` 各自拥有完整回合的一部分。
- `StateManager` 是声明上的唯一写入边界，却没有提供统一的事务模型。
- 剧情与新建游戏工作流绕过 `StateManager` 直接写入。
- 运行时效果接线形成了第二份状态投影，却没有聚合生命周期所有者。
- 引擎模块直接导入 UI 层拥有的注册表和类型实现。

## 优先级定义

- **P0：** 阻断发布、影响面广且灾难性，或在常规使用下造成不可恢复后果。
- **P1：** 可达的正确性或生命周期缺陷，可能破坏状态、丢失领域操作、阻断主流程，或违反承重契约。
- **P2：** 应纳入计划的重要架构债务或资源生命周期缺陷，但通常不会立即使主流程失效。

## 审查发现

### AR-01 — 并行侧链提交可能丢失角色状态

- **优先级：** P1
- **归属边界：** 按存档隔离的状态变更

`AgentOrchestrator` 通过 `Promise.all` 并发执行所有非空请求侧链（`src/sillytavern/agent-orchestrator.ts:911-927`）。物品与制作侧链分别构造自己的补丁，并各自调用注入的 `StateManager`（`src/sillytavern/item-gen-chain.ts:150-154`、`src/sillytavern/craft-gen-chain.ts:567-571`）。`GamePipeline` 又为这些回调分别创建独立的管理器实例（`src/ui/lib/game-pipeline.ts:2046-2078`、`src/ui/lib/game-pipeline.ts:2181-2223`）。

角色物品操作会读取完整角色对象、修改其中的数组，再通过 `characters.put` 把整个对象写回（`src/sillytavern/state-manager.ts:442-467`、`src/sillytavern/state-manager.ts:816-854`、`src/sillytavern/database.ts:1293-1295`）。不同管理器实例之间没有按存档或按角色的串行化。

**触发条件：** 同一次 dispatcher 输出同时包含指向玩家的物品生成与制作/物品更新，且两条提交发生重叠。

**实际影响：** 两条侧链可能读到同一份初始角色状态；后执行的 `put` 会无声覆盖先执行侧链写入的背包或技能变化。

**整改建议：** 增加按存档串行执行全部命令的状态执行器，或在同一个仓储事务内完成读取、校验、修改和写入。模型调用仍可并发，但各侧链的状态结果应先汇总，再由唯一所有者统一提交。

**必须补充的回归测试：** 对同一角色启动两条可延迟的状态命令，在任一写入前先放行两次读取，最终断言两项改动均被保留。

### AR-02 — Code 侧结算误用了“尽力而为”补丁接口

- **优先级：** P1
- **归属边界：** 领域事务语义

`StateManager` 文件头声明的是“全部成功或全部回滚”（`src/sillytavern/state-manager.ts:7-12`），但 `commitChatState` 会捕获每条补丁的失败、继续应用后续补丁，并返回部分成功结果（`src/sillytavern/state-manager.ts:230-298`）。公开的 `StateCommitResult` 也明确暴露了这种部分应用结果（`src/sillytavern/types.ts:1725-1732`）。

对于不可信的 AI 批次，这种行为有其价值：一条畸形补丁未必应该抹掉所有有效补丁。但对于代表单一领域操作、由 Code 侧拥有的结算，这种语义是不安全的。

制作结算会构造一组具有整体语义的资源、材料、奖励与产物补丁（`src/sillytavern/craft-resolver.ts:308-358`）。工具处理器只记录提交错误，返回值仍沿用 resolver 计算出的成功状态（`src/sillytavern/agent-tools.ts:768-805`）。战斗同样一次性提交整批结算补丁，却完全忽略提交结果（`src/sillytavern/combat-v3/coordinator.ts:472-497`）。

**触发条件：** 材料、资源、奖励或角色补丁中的后续某条，在前面的结算补丁已经持久化后失败。

**实际影响：** 制作或战斗可能只扣除部分成本、漏发奖励或漏写状态，却仍继续按领域操作已经完成来运行。

**整改建议：** 按语义拆分接口：

- `commitBestEffortPatches`：用于不可信 AI 输出；以及
- `settleCraft`、`settleCombat` 等原子领域命令：在任何写入前校验整个操作，并在一个事务内完成提交。

**必须补充的回归测试：** 在制作和战斗结算的最后一条补丁注入失败，断言此前的任何状态变化都没有持久化。

### AR-03 — 存档加载与回读缺少会话代次归属

- **优先级：** P1
- **归属边界：** 活跃存档生命周期

`GamePage` 在创建 pipeline 前会执行多项异步初始化（`src/ui/components/game/GamePage.vue:73-102`）。卸载时只能中止已经存在的 pipeline，因此当 `pipeline` 仍为 `null` 时无法取消初始化（`src/ui/components/game/GamePage.vue:251-265`）。后续流程会反复读取可变的全局 `ui.activeSaveId`，并可能在导航离开后继续创建 pipeline 或发送开场提示词（`src/ui/components/game/GamePage.vue:173-176`）。

`game-store.loadSave` 同样没有“最后一次加载生效”的代次令牌（`src/ui/stores/game-store.ts:872-915`）。其中的消息恢复读取当前可变的 `activeSaveId`，而不是本次加载开始时捕获的存档 ID（`src/ui/stores/game-store.ts:820-827`）。

pipeline 末尾的回读还存在同类 TOCTOU（检查时/使用时）竞态。`GamePipeline` 在调用 `refreshFromDb` 前检查 `ownsActiveSave`（`src/ui/lib/game-pipeline.ts:425-431`），但 `refreshFromDb` 在异步读取后既没有保留也没有重新检查原存档身份（`src/ui/stores/game-store.ts:921-955`）。

**触发条件：** 打开存档 A，在初始化或末尾回读的 `await` 尚未完成时返回首页，随后打开存档 B。

**实际影响：** A 的过期异步流程可能覆盖 B 的内存角色、档案、剧情数据、消息或开场提示流程。

**整改建议：** 引入活跃存档会话代次令牌。每次加载与回读都必须接收显式的 `saveId` 和代次，只读取该 ID，并在每次写入内存状态前立即校验代次归属。即便 pipeline 尚未创建，关闭游戏页也必须使当前代次失效。

**必须补充的回归测试：** 使用可延迟数据库 Promise，分别覆盖初始加载和末尾回读期间从 A 切到 B 的场景，并断言只有 B 能修改 Pinia 状态。

### AR-04 — 效果接线没有与持久化角色状态保持一致

- **优先级：** P1
- **归属边界：** 按存档隔离的运行时投影

效果接线保存在进程级、按存档索引的全局 Map 中；如果 owner key 已经注册，后续接线会直接跳过（`src/sillytavern/effect-wiring.ts:57`、`src/sillytavern/effect-wiring.ts:132-165`）。全量接线只做增量添加（`src/sillytavern/effect-wiring.ts:191-205`）；虽然存在全量拆除函数，但生产代码在切换存档时没有调用它（`src/sillytavern/effect-wiring.ts:209-217`）。

多个持久化变更绕过了这套生命周期：

- 同槽位替换装备时只清除旧物品的槽位，并只给新物品接线（`src/sillytavern/state-manager.ts:1000-1017`）；
- `remove_item` 与 `remove_skill` 删除数据时不执行 cleanup（`src/sillytavern/state-manager.ts:864-886`、`src/sillytavern/state-manager.ts:1153-1164`）；
- `update_item` 与 `update_skill` 可以修改脚本，却不会重新注册（`src/sillytavern/state-manager.ts:896-919`、`src/sillytavern/state-manager.ts:1130-1144`）；以及
- 快照恢复替换角色行后，不会重建运行时订阅（`src/sillytavern/state-manager.ts:1475-1508`）。

前两种删除路径可以由玩家直接从 `ItemsPanel` 触发（`src/ui/components/game/ItemsPanel.vue:199-226`）。

**触发条件：** 替换、删除或更新带脚本的物品/技能；恢复到装备不同的快照；或离开一个已经完成接线的存档。

**实际影响：** 已移除装备仍可能持续触发“幽灵效果”，快照恢复回来的效果可能始终不生效，修改后的脚本也可能继续使用旧回调。

**整改建议：** 把效果接线视为由存档聚合拥有的派生投影。每次相关的原子角色变更完成后，都应对期望的 owner/script 集合与当前接线进行协调。快照恢复和存档会话关闭必须执行完整的关闭与重建。

**必须补充的回归测试：** 覆盖同槽替换、已装备物品删除、技能删除、脚本更新、快照恢复与存档切换；断言应观察实际订阅行为，而不能只检查数据库。

### AR-05 — 剧情持久化绕过了 StateManager 边界

- **优先级：** P1
- **归属边界：** 剧情状态与领域事件发布

pre-check 通过数据库 helper 直接激活剧情事件（`src/sillytavern/plot-engine.ts:135-153`），post-check 也直接保存更新（`src/sillytavern/plot-engine.ts:319-323`）。这绕过了已经存在的 `update_plot_event` 操作；后者会生成 `plot_trigger` 事件（`src/sillytavern/state-manager.ts:1274-1286`）。只有经 `commitChatState` 产生的事件才会发布到效果系统（`src/sillytavern/state-manager.ts:277-280`）。

post-check 还存在第二个时序问题：它先保存初始更新集，之后才向子事件传播 `worldLineChanged`（`src/sillytavern/plot-engine.ts:343-347`、`src/sillytavern/plot-engine.ts:366-399`），受影响的子事件没有再次保存。

**触发条件：** pre-check 激活剧情事件、post-check 修改事件，或中等/重大世界线变化向子节点传播。

**实际影响：** 订阅方永远收不到文档约定的 `plot_trigger`；子事件上的传播标记也会在函数返回后消失。

**整改建议：** 让剧情求值相对于持久化保持纯函数：只返回剧情命令和所有受影响事件的变化。由状态边界在一个事务内提交完整事件树，并统一发布一次领域事件。

**必须补充的回归测试：** 执行带子节点的父事件世界线变化，同时断言子节点标记已持久化，且恰好发布一次 `plot_trigger`。

### AR-06 — Pipeline 依赖语义混淆了“完成”与“成功”

- **优先级：** P1
- **归属边界：** Agent DAG 调度与失败策略

默认 pipeline 让 Story 等待 `memory_recall` 与 `plot_pre_check`（`src/sillytavern/types.ts:447-450`）。`stageDependenciesMet` 只有在依赖结果存在且不含错误时，才认为依赖已满足（`src/sillytavern/agent-orchestrator.ts:760-771`）。现有测试甚至明确断言：memory recall 失败时 Story 应被跳过（`src/sillytavern/agent-orchestrator.test.ts:475-509`）。

这个行为与产品契约冲突：Stage 0 中任一 Agent 失败都不应阻断 Stage 1；Stage 1 等待的是它们完成，而不是成功（`docs/fated-poem-engine-prd.md:147-150`）。

**触发条件：** 记忆召回或剧情 pre-check 在重试耗尽后返回错误。

**实际影响：** 一个可选预处理 Agent 的故障会阻止必需的 Story Agent 生成任何叙事。

**整改建议：** DAG 边只承担调度语义：`waitFor` 表示“已完成（settled）”。是否致命应由显式的 required/failure policy 决定，可以复用 `requiredAgents` 或增加按阶段策略。失败的可选 Agent 应提供空结果或确定性的兜底输出。

**必须补充的回归测试：** 分别让两个可选 Stage 0 Agent 单独失败和同时失败，断言 Story 仍会运行，并收到确定性的兜底上下文。

### AR-07 — 放弃战斗无法终止生产路径上的意图等待

- **优先级：** P1
- **归属边界：** 战斗会话取消

生产战斗注入了文本意图桥（`src/ui/lib/game-pipeline.ts:1900-1906`、`src/ui/lib/game-pipeline.ts:1997-2003`），coordinator 在玩家决策时会优先等待该桥（`src/sillytavern/combat-v3/coordinator.ts:670-696`、`src/sillytavern/combat-v3/coordinator.ts:741-764`）。

UI 的 `abandon` 回调只会 resolve 旧的命令等待器，从不结束 `pendingIntentResolve`（`src/ui/lib/game-pipeline.ts:1950-1963`）。仓库变更记录也已经注明该问题尚未解决（`docs/CHANGELOG.md:229-232`）。

**触发条件：** coordinator 等待玩家意图时，玩家选择跳过或重启战斗。

**实际影响：** 面板可能已经关闭，或新战斗已经开始，但旧的 `runCombatV3` Promise 与会话仍然悬空；新句柄还会掩盖这个孤儿会话。

**整改建议：** 用一个按会话隔离、可取消的输入通道替代两组 resolver。放弃战斗时应以显式取消结果或 `AbortSignal` 关闭通道，coordinator 中的所有等待都必须在不落结算的前提下结束。

**必须补充的回归测试：** 从每一种玩家输入路由执行放弃与重启，断言原运行已结束、没有产生结算、也没有残留活动句柄。

### AR-08 — 持久化工作流缺少聚合生命周期所有者

- **优先级：** P2
- **归属边界：** 应用层持久化工作流

完整备份导入替换 Dexie 数据后，只重载 API 条目就报告成功（`src/ui/components/settings/DataSection.vue:316-328`）。世界书、美化、工坊和图像预设 Store 都在应用启动时初始化，而且其 `init` 都是一次性的（`src/ui/App.vue:31-55`、`src/ui/stores/worldbook-store.ts:46-48`、`src/ui/stores/beautifier-store.ts:65-67`、`src/ui/stores/workshop-store.ts:158-160`、`src/ui/stores/image-preset-store.ts:81-89`）。

新建游戏在写侧存在对称问题。`create-store` 分别写入角色、存档槽、可选档案、大纲和剧情事件（`src/ui/stores/create-store.ts:1807-1867`），外层没有统一事务，也没有回滚。

**触发条件：** 导入包含不同单例数据的备份，或新建游戏在某次较晚的 IndexedDB 写入处失败。

**实际影响：** 导入数据在刷新页面前可能始终不可见，编辑旧 Store 数据还可能覆盖刚恢复的行。新建游戏失败则可能留下孤儿角色，或留下可见、可进入但初始化不完整的存档。

**整改建议：** 提取应用服务：

- `importBackup`：拥有数据库替换、关闭活跃存档、使所有单例投影失效，并在报告成功前重新加载它们；以及
- `createGame(command)`：用一个事务写入全部必需记录。

### AR-09 — 引擎模块导入了 UI 层拥有的实现

- **优先级：** P2
- **归属边界：** 内容 Provider 的依赖方向

架构文档规定引擎应与 UI 框架无关（`docs/ARCHITECTURE.md:43`、`docs/fated-poem-engine-prd.md:214`），`content-source.ts` 也再次声明依赖方向必须是 UI → 引擎（`src/sillytavern/content-source.ts:63-70`）。

但生产代码中的引擎模块直接导入 Pinia 层拥有的内容注册表（`src/sillytavern/agent-tools.ts:35`、`src/sillytavern/bloodlines.ts:21`、`src/sillytavern/location-db.ts:26`、`src/sillytavern/random-tables.ts:20`）。数据库导入 UI 层的 `CreatePreset` 类型（`src/sillytavern/database.ts:41`），内容源还导入 UI 层的 hash helper（`src/sillytavern/content-source.ts:27`）。

**实际影响：** 无头加载引擎时会被迫带入 UI 归属，测试引擎行为也需要 UI 模块。内容 Provider 的变更必须同时跨越既定接缝的两侧。

**整改建议：** 把 `ContentRegistry` 接口与状态、`CreatePreset` 以及平台中立的 hash 能力移到引擎拥有的模块。Pinia 内容 Store 只负责获取/安装内容，并通过该接口注入不可变快照。引擎测试使用内存 Adapter。

### AR-10 — 完整回合的归属被拆散在两个浅层模块之间

- **优先级：** P2
- **归属边界：** 完整回合工作流

`AgentOrchestrator` 暴露阶段事件，并为每种 marker/工作流分别提供回调（`src/sillytavern/agent-orchestrator.ts:67-168`、`src/sillytavern/agent-orchestrator.ts:815-965`）。唯一生产调用方 `GamePipeline` 又通过一张大型回调表把这些领域工作流接回去（`src/ui/lib/game-pipeline.ts:1410-1514`）。两侧还各自构造具体的模型与状态 Adapter。

`GamePipelineDeps` 接收整个 Pinia Store（`src/ui/lib/game-pipeline.ts:65-69`），实现内部却还会读取全局音频、世界书和 UI Store，并自行构造引擎依赖。因此其声明接口既过宽，又不完整。

**实际影响：** 新增或修改一个阶段 marker，需要同时改动接缝两侧及其测试。测试依赖模块级 mock 和大面积 `as any` Store 替身，接口没有提供足够的局部性与杠杆。

**整改建议：** 选择一个完整回合所有者，优先由引擎 orchestrator 承担。为模型调用、状态命令、内容快照和取消能力注入窄端口；消息、音频、图像与战斗通过类型化 UI effect 返回，而不是把每个内部 marker 都导出成回调。

### AR-11 — 浏览器取消没有贯穿 BFF 到上游

- **优先级：** P2
- **归属边界：** 端到端请求生命周期

浏览器客户端会为请求提供 `AbortSignal`（`src/sillytavern/agent-client.ts:663-673`），但代理向上游发起 `fetch` 时没有传入 `c.req.raw.signal`（`server/routes/proxy.ts:96-102`）。

**触发条件：** Provider 返回响应头前，用户点击停止、请求超时或页面导航导致浏览器取消慢请求。

**实际影响：** 浏览器认为工作已经取消，但 BFF 仍维持 Provider 请求与服务端连接，继续消耗计算、费用与连接资源，并可能活得比发起请求的存档或页面更久。

**整改建议：** 把入站请求的 signal 传给上游 `fetch`，同时保留现有的响应体取消处理。

## 建议的目标边界

### 1. 存档状态命令执行器

一个按存档隔离的执行器应统一拥有顺序控制和事务选择：

```text
模型工作 / UI 意图 / 领域 Resolver
                  |
                  v
          SaveCommandExecutor
          /                 \
  尽力而为 AI 补丁       原子领域命令
          \                 /
                  v
              仓储事务
                  |
                  v
         持久化状态 + 领域事件
```

该边界还应负责：只有持久化成功后才能发布事件。

### 2. 存档会话生命周期

一个 `SaveSession` 应拥有：

- 不可变的 `saveId` 与会话代次身份；
- 取消信号；
- pipeline 与战斗句柄；
- 状态命令执行器；
- 效果/EventBus 运行时；以及
- 关闭与协调行为。

Pinia 可以把会话状态投影给 Vue，但已经开始执行的异步操作不应再把可变的全局 `activeSaveId` 当作输入。

### 3. 完整回合应用服务

引擎应通过窄端口暴露一个深层的完整回合操作：

```ts
runTurn(input, {
  modelGateway,
  stateCommands,
  contentSnapshot,
  cancellation,
  uiEffects,
});
```

具体接口应遵循仓库现有约定，但这个模块需要向 UI 隐藏阶段顺序、marker 路由、侧链持久化和结果汇总。

## 整改路线图

### 波次 1 — 正确性止损

1. 增加按存档的状态串行化，阻止并发更新丢失。
2. 拆分“尽力而为”AI 补丁提交与原子领域命令。
3. 为加载和回读路径增加存档会话代次检查。
4. 用可取消输入通道替换两组战斗 resolver。
5. 修正 Stage 0 依赖语义，使其与 PRD 一致。

### 波次 2 — 聚合一致性

1. 在每次相关变更后协调效果接线，并在恢复/加载时重建。
2. 让剧情迁移与传播通过状态命令边界落库。
3. 让新建游戏在一个事务内完成。
4. 让备份导入负责关闭、失效并重载所有投影。

### 波次 3 — 深化模块边界

1. 把内容注册表与共享类型移交引擎拥有。
2. 让引擎 orchestrator 拥有完整回合。
3. 用窄端口替代整个 Store 依赖。
4. 让取消信号贯穿 BFF。

## 验证记录

审查基线通过以下检查：

```text
npm run typecheck       通过
npm run typecheck:vue   通过
npm run test:run        通过 — 319 个测试文件，8,173 项通过，9 项跳过
npm run lint            通过
npm run knip:ratchet    通过 — 无新增死代码问题
```

测试套件输出了已有的 JSDOM 媒体/Canvas 能力警告，但没有任何闸门失败。

闸门全部通过并不否定上述发现。大部分缺口需要并发、延迟生命周期、事务失败或运行时订阅测试，而当前测试套件尚未覆盖这些场景。

## 审查结论

本仓库不需要大规模重写。现有局部模块与测试已经提供了扎实基础。核心改进方向，是让已经声明的架构规则成为可执行边界：

- 唯一写入入口还必须拥有串行化与事务语义；
- 按存档隔离的运行时状态必须随存档会话创建、协调与销毁；
- 依赖方向必须真实反映在 import 关系中；以及
- 工作流模块应隐藏一个完整工作流，而不是把内部阶段逐一暴露给调用方。

完成前两个整改波次后，可以消除目前已经证实可达的正确性缺陷。第三个波次则会减少后续的霰弹式修改，并显著缩窄引擎与 UI 测试所需的替身范围。
