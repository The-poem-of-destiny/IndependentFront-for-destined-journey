# AI 计费模式兼容性调查

调查日期：2026-11-05。代码基线：`18eed96`，从 `characters-v1` 新建并切换到 `investigate/ai-billing-modes`。

本次只核查现有能力、实际调用次数和兼容缺口，不提出模式设计或实施方案。依据为当前生产源码和针对性测试；没有修改生产代码、浏览器设置、存档或内容包，也没有发送真实模型请求。

## 1. 三种模式的现有兼容程度

| 目标模式                                             | 当前状态                                 | 已有基础                                                                     | 尚不满足的条件                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 直出，无缓存优化：每楼一次主调用，最多另一次记忆回溯 | 部分基础，尚无可用成品模式               | 正文、选项、角色档案与经历已经能在同一回复中输出；底层存在无状态完整组装路径 | App 固定启动多 Agent 管线；数值结算、实体生成、摘要等尚未由主回复统一承载；没有每楼调用预算，也没有正常游玩的关闭 Delta 开关 |
| 直出，Delta 缓存优化：每楼一次调用                   | Delta 基础已经实现，单次玩法契约尚未实现 | 旧模式正文已经使用持久化 Delta 会话，Delta 计算本身不调用模型                | 同样缺少单回复完整结算入口；召回、摘要、资料选择、实体和制作等仍会额外调用；Story v2 正文明确绕过 Delta                      |
| Agent：缓存优化、多次调用                            | 现有默认生产路径                         | 分阶段调度、按 Agent 分配模型、旧模式 Delta、工具循环和多种侧链已接通        | 缓存覆盖取决于具体路径，不能理解为所有请求都走 Delta；现有实现没有证明便宜模型能达到所需质量                                 |

矩阵依据：`src/ui/lib/game-pipeline.ts:1240` 的固定名册、`:1383` 的 `enabled: true`、`:2281` 的正文处理；`src/core/agents/agent-orchestrator.ts:637` 的 Story v2 分支、`:765` 的 Delta 入口；`src/core/prompts/prompt-session-assembler.ts:787` 的本地增量组装。

因此，当前最接近第三种模式。前两种不是增加一个设置选项就已经具备的功能；它们缺少的主要是单次调用下的完整玩法执行契约，而非基础文本生成能力。

## 2. 当前一楼实际会调用什么

这里把“一次调用”按一次模型 HTTP 请求理解。一个 Agent 的一次逻辑执行可能包含自动重试或多轮工具请求；本地解析、状态提交、掷骰等计算不单独算模型调用。

### 默认旧模式

新设置默认 `plotMode: 'off'`、`memoryRecallMode: 'llm'`、`storyContextV2Enabled: false`。实际剧情模式读取当前存档的 `metadata.plotSettings`，已有存档不一定等于新设置默认值。见 `src/ui/stores/settings-store.ts:256`、`:274`、`:300`，`src/ui/lib/game-pipeline.ts:1482`。

在普通非战斗、剧情关闭、没有失败重试、侧链或向量服务调用的成功回合中，基础成本是 **6 次**：

| 阶段               | Agent                                  | 当前职责                                   |
| ------------------ | -------------------------------------- | ------------------------------------------ |
| 正文前             | `memory_recall`                        | 从记忆中召回相关信息                       |
| 正文               | `story`                                | 正文、选项和角色叙事更新                   |
| 正文后，同阶段并行 | `request_dispatcher`、`memory_summary` | 时间／全局变化／子系统请求，以及新记忆摘要 |
| 后续               | `daily_check`                          | 时间推进后的日常结算                       |
| 后续               | `vars_update`                          | 角色、物品、状态、任务等变化               |

剧情开启时再加 `plot_pre_check` 和 `plot_post_check` 两次。默认管线、依赖与并行关系见 `src/core/types/types.ts:598`；剧情关闭时的禁用逻辑见 `src/core/agents/agent-orchestrator.ts:346`，战斗期间跳过日常检查见 `:515`。并行缩短等待时间，不减少请求数。

### Story v2 实验模式

不含重试和附加服务时，基础请求数是 **`4 + R + L + 2P`**：

- `4`：`story`、`request_dispatcher`、`memory_summary`、`vars_update`。该管线没有 `daily_check`，不能把它当作与旧模式只差提示词拼装的等价开关。见 `src/core/types/types.ts:636`。
- `R`：LLM 记忆召回正常为 0 或 1 次；没有候选时不请求。见 `src/core/agents/agent-orchestrator.ts:1317`。
- `L`：资料选择正常为 0 或 1 次；存在候选或补充目录时会单独调用 `lore_select`。见 `src/core/content/lore-selection.ts:137`，`src/core/agents/agent-orchestrator.ts:668`。
- `P`：剧情关闭为 0，开启为 1。

该公式只描述无重试的基础路径，**不是每楼最大调用次数**。v2 接纳回合后还会处理归档重试、当前摘要提交和缺失摘要补建，见 `src/ui/lib/game-pipeline.ts:940`。

### 可达的额外调用

| 触发                     | 额外调用及证据                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网络或生成失败           | 多数 Agent 的默认 `maxRetries` 为 3，即一次普通调用或一次工具轮次最多 4 次尝试；用户和内容默认可覆盖。`src/ui/stores/agent-settings.ts:73`，`src/core/agents/agent-client.ts:222`、`:502`                                                       |
| v2 召回输出格式无效      | 除网络重试外，另有一次格式重试；即使 `maxRetries=0`，也不能保证回溯最多一次请求。`src/core/agents/agent-orchestrator.ts:1407`、`:1485`                                                                                                          |
| 新角色／装备／技能等实体 | 角色按请求分别生成，其余实体可批量生成；每组工具循环最多 10 轮。`src/ui/lib/game-pipeline.ts:3981`，`src/core/agents/entity-gen-agent.ts:542`                                                                                                   |
| 正文角色更新涉及未知人物 | 即使调度器漏发标记，回合末也会进入已有角色生成链；同次 `character_updates` 并不消除新人物的实体生成调用。`src/ui/lib/game-pipeline.ts:859`                                                                                                      |
| 制作                     | 每个制作请求启动一条工具链，最多 10 轮；工具链失败另尝试普通 chat，有产物请求时继续实体生成。`src/ui/lib/game-pipeline.ts:3941`，`src/core/crafting/craft-gen-chain.ts:231`、`:246`、`:522`                                                     |
| 战斗                     | 独立战斗窗口的每次交互走多轮工具调用，默认最多 12 轮；工具本身是本地计算，结果回给模型会继续发送请求。`src/core/combat/sandbox/runner.ts:203`，`src/core/agents/agent-client.ts:285`                                                            |
| v2 事件归档              | 每个归档额外调用一次摘要模型，从来源正文重写详情。`src/ui/lib/game-pipeline.ts:3061`                                                                                                                                                            |
| v2 缺摘要／旧归档待重试  | 每楼最多补建 2 个缺摘要回合；另最多处理 2 份归档重试草稿，每份可能包含多个归档并逐个调用。`src/ui/lib/game-pipeline.ts:2934`、`:3023`、`:3051`                                                                                                  |
| 使用向量召回             | 可额外请求 query embedding、reranker；保存摘要／归档时也可能请求 embedding。`src/core/agents/agent-orchestrator.ts:1239`，`src/core/memory/memory-store.ts:517`，`src/core/memory/memory-summarizer.ts:217`，`src/ui/lib/game-pipeline.ts:3115` |
| 自动插画                 | 默认是手动档；自动档且正文有标记时，插画提示词转换会再调用 LLM，然后调用图像服务。`src/ui/stores/settings-store.ts:361`，`src/ui/lib/game-pipeline.ts:2095`、`:2118`，`src/core/image/image-prompt-agent.ts:221`                                |

正文润色是手动入口，剧情大纲生成发生在建档等流程，不计入上述固定每楼成本。见 `src/ui/lib/game-pipeline.ts:4280`，`src/ui/stores/create-store.ts:1594`。

**记忆回溯与记忆总结是不同成本。** 前者读取旧记忆，后者生成新摘要；v2 归档重写和缺摘要补建又是另外的生成请求。把“可再调用一次记忆回溯”理解为覆盖全部记忆工作，与当前执行路径不符。

## 3. 单回复已经能完成哪些事

| 能力                             | 当前是否从主回复直接处理                                 | 源码依据                                                                              |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 正文与行动选项                   | 是，支持流式投影和完成后持久化                           | `src/core/story/story-output.ts:141`；`src/ui/lib/game-pipeline.ts:2281`              |
| 角色叙事档案与经历               | 是，解析 `<character_updates>`，正式接纳回合后提交       | `src/core/character/character-updates.ts:93`；`src/ui/lib/game-pipeline.ts:909`       |
| 任意角色数值属性／装备／资源变化 | 否；角色更新只接受档案字段白名单和经历                   | `src/core/character/character-updates.ts:8`、`:24`、`:122`                            |
| 时间与全局变量                   | 由 `request_dispatcher` 输出翻译并提交                   | `src/core/agents/agent-orchestrator.ts:1840`                                          |
| 日常结算                         | 由 `daily_check` 输出翻译并提交                          | `src/core/agents/agent-orchestrator.ts:1960`                                          |
| 角色／物品／状态／任务结算       | 由 `vars_update` 输出翻译并提交                          | `src/core/agents/agent-orchestrator.ts:1970`                                          |
| 新实体及制作产物                 | 由独立实体生成／制作链处理                               | `src/core/agents/entity-gen-agent.ts:198`；`src/core/crafting/craft-gen-chain.ts:213` |
| 持久化记忆摘要                   | 消费 `memory_summary` 的结果，尚未消费主回复中的同类数据 | `src/ui/lib/game-pipeline.ts:2319`                                                    |

`<sum>`、`<vars>` 仍出现在部分默认提示词或旧类型常量里，但当前主回复处理没有把它们接成记忆写入或游戏结算；投影器只是将这些控制块从展示文本剥离。不能据标签存在就认定已经支持单次直出。见 `src/core/story/story-output.ts:21`、`:145`，`src/ui/lib/game-pipeline.ts:2281`。

结算翻译器、实体解析器与状态提交机制已经存在，分别见 `src/core/variables/vars-update-translator.ts:176`、`:218`、`:545`，`src/core/variables/daily-check-translator.ts:204`，`src/core/agents/entity-gen-parse.ts:521`。这些是现有基础能力；当前调用入口仍绑定各自 Agent，不代表已经支持从一次 Story 回复完成全部操作。

## 4. 缓存的实际支持范围

旧模式主 DAG 的普通、非工具路径会进入 `preparePromptSession`。Delta 会话按存档与 Agent 隔离：首轮建立完整基线，后续保留历史 transcript 并追加当前变化；签名变化、历史编辑、预算或增长条件会重建基线。会话可持久化并在刷新后恢复。见 `src/core/agents/agent-orchestrator.ts:627`、`:765`，`src/core/prompts/prompt-session-assembler.ts:787`、`:830`，`src/ui/main.ts:102`。

Delta 本身是本地投影与差分，**不要求增加一次 AI 请求**。但发送给 provider 的仍是 `旧 transcript + 当前 user delta`，不是只在网络上传新增片段；价值在于保持可复用前缀。见 `src/core/prompts/prompt-session-assembler.ts:821`、`:859`。源码只能证明这种组装行为，不能证明某渠道必定命中缓存、缓存保持多久或最终如何计费。

Story v2 的正文每轮走分区完整组装，明确不进入 Delta；其每轮摘要也是无状态请求。其余普通 Agent 仍可使用 Delta。v2 因而不是“直出缓存模式”，也不是旧 Delta 的简单升级开关。见 `src/core/agents/agent-orchestrator.ts:637`、`:761`。

现有 `cacheStrategy` 和 `memoryCacheStrategy` 字段只见于类型、默认值或历史迁移，没有连接到当前管线的 Delta 启停。正常 UI 不提供无缓存直出模式；底层重新生成等路径能够绕过会话，属于已有技术路径，不是完整产品模式。见 `src/core/types/types.ts:781`，`src/ui/stores/settings-store.ts:282`，`src/core/agents/agent-orchestrator.ts:480`、`:629`。

## 5. 设置、预设与版本边界

当前设置可以按 Agent 配置模型、提示词、采样参数、最大重试次数、历史窗口和末尾指令；没有三种计费模式，也没有通用的 Agent 启停设置。底层 `AgentConfig.enabled` 存在，但 App 构造配置时写死为 `true`，仅剧情开关等专用路径再调整。见 `src/ui/stores/agent-settings.ts:32`，`src/core/types/types.ts:479`，`src/ui/lib/game-pipeline.ts:1381`。

`storyContextV2Enabled` 控制实验存档与新记忆／上下文流程，不是调用预算开关；启用时仅准入带 v2 标记的存档，关闭时仅准入普通存档，不能用该开关给旧档随意切换模式。`memoryRecallMode` 只在 LLM 与 embedding 召回之间选择。旧类型中的 `apiMode: single/dual`、`uiMode: game/chat` 也没有连接成当前三模式执行入口。见 `src/core/story/story-context-mode.ts:48`，`src/ui/stores/settings-types.ts:195`、`:218`，`src/core/types/types.ts:759`、`:768`。

实际提示词还受内容包和用户覆盖影响：主预设先读数据库，缺失时才用内容默认；Agent 参数按用户覆盖、内容默认与代码兜底解析。不能只检查公开 `public/data/defaults/agent-config.json` 就断言用户实际运行的协议。见 `src/ui/lib/game-pipeline.ts:1600`，`src/ui/stores/agent-settings.ts:5`。

本地配套私有内容目录的 Agent 名册与当前引擎名册存在版本差异，但本次没有核对浏览器已安装内容包、用户覆盖或真实存档，因此不把该目录当成用户正在运行的配置，也不据此判断实际游玩故障。

## 6. 验证与结论边界

针对当前行为运行了下列两组测试，共 **18 个测试文件、477 项通过**，无重复计数：

```powershell
npm run test:run -- tests/core/agents/agent-orchestrator.test.ts tests/core/agents/agent-client.test.ts tests/core/prompts/prompt-session-assembler.test.ts tests/core/prompts/prompt-session-store.test.ts tests/core/prompts/story-context-v2.test.ts tests/core/story/story-context-mode.test.ts tests/core/memory/story-recall.test.ts tests/core/memory/story-turn-summary.test.ts tests/ui/lib/game-pipeline.test.ts tests/ui/lib/game-pipeline.boundaries.test.ts tests/core/content/lore-routing.test.ts

npm run test:run -- tests/core/story/story-output.test.ts tests/core/character/character-updates.test.ts tests/core/integration/character-chronicle.test.ts tests/core/variables/vars-update-translator.test.ts tests/core/variables/daily-check-translator.test.ts tests/core/agents/entity-gen-agent.test.ts tests/core/crafting/craft-gen-chain.test.ts
```

首次运行因 sandbox 的临时目录 rename 权限报 `EPERM`，未执行到用例；将该命令的 `TEMP`／`TMP` 指向工作区 `node_modules/.cache/ai-modes-investigation` 后重试，两组分别为 392 项和 85 项通过，没有为此修改代码。

测试证明现有组装、调度、解析和提交行为，不代表两种直出模式已经支持，也不证明真实模型质量、渠道缓存命中或费用。没有运行全仓 gates、真实模型游玩或计费实验。

按本次每楼一次、模式 1 仅允许另一次回溯的约束，所有随本楼自动触发的附加请求均构成当前兼容缺口；独立手动操作已单列。本轮止于调查。
