# 直出无缓存优化模式 v1 设计

日期：2026-11-09。状态：**已实施（2026-11-09），已做本地自动化与建档界面验证；未做真实模型叙事验证**。

本稿基于 `direct-generation-v1` 的 `14255c4` 与本地参考资料；前期取舍记录保留在 [探索文档](2026-11-06-direct-no-cache-exploration.md)。本稿确定第一版边界，不改写旧调查结论为已交付能力。

2026-11-09 修订：按用户要求，取消先前的全局模式切换方案，改为**建档时明确选择、写入存档标记、存档生命周期内固定**；缺少标记的旧存档按 Agent 运行。

2026-11-09 接线补充：核对角色生成、原生角色、地图、库存与 UI 的现行调用点；§5–9、§12–13 补齐所需衔接，§15 汇总本地钩子与具体缺口。此段为实施前的接线调查记录，当前落地范围见下方实施注记。

2026-11-09 实施注记：已接入独立直出生成、显式建档选择、存档固定模式、原生角色／库存／地图更新和跨楼战斗状态。模式选择前移到建档准备页，先选择模式再检查相应 API。记忆仍复用原有实现；Agent 仍走原有管线。入口、内容包要求、已知边界和验证命令见 [使用说明](../reference/direct-generation.md)。

直出不执行自动图片生成、子 Agent、工具循环或 EJS 变量提交；效果与状态由主回复的原生协议提交。公开演示世界书已明确授权 direct_main，现有私有内容包需作者配置对应读取范围；没有复制原卡／Prime 私有正文或脚本。完整状态与接纳消息在同一事务提交；时间推进、角色经历、剧情收尾、快照与记忆等后续工作失败时显示警告，不重复结算已接纳楼。骰池是真随机输入，模型算术和规则遵循仍需真实模型验证。

## 1. 已确定的产品范围

- 存档标记为 `SaveSlot.metadata.generationMode?: 'agent' | 'direct'`；运行模式只由当前存档决定，缺少标记时解析为 `agent`，不根据全局设置或模型配置猜测。
- 新建存档必须明确选择“Agent 模式”或“直出（无缓存优化）”，两者都显式写入标记；建档后不可切换。本版不实现第三种缓存直出模式或已有存档的模式转换。
- direct 每次楼生成尝试最多 **1 次非记忆模型请求**，其余非记忆 Agent 职责压入主生成或由本地代码处理。
- **全部现有记忆流程保留且独立**：回溯、摘要、缺摘要补建、归档、维护和各自重试照现行规则运行。因此不是“每楼总共最多 2 次请求”。
- `generationMode` 与 `storyContextMode: legacy | v2` 正交；原有存档准入、历史窗口与记忆规则不因选择 direct 改变。
- 战斗／制作采用 ST 式主 AI 裁定与同次叙事；保留本地状态和有限写入检查，不宣称代码重演全部规则或保证模型算术正确。
- “无缓存优化”指主生成不建立客户端 Delta 会话；不承诺关闭供应商自动缓存，记忆自身的缓存策略不变。

## 2. 参考资料及采用范围

Prime 来源：`E:\Projects\POD-Reference\Prime-1.18s.json`；SHA-256：`83ca29e4d2c8f08ccb26ca4e4fed945a63b4f855fa71f55dce16e327c684ff8a`。仅静态解析，不执行其中脚本，不复制私有正文入仓。

- `prompt_order[0]` 列 91 项、启用 45 项；`prompts` 共 95 项。主变量 `[68]` 启用，额外变量 `[69]` 关闭；摘要 `[70]` 启用，选项 `[71]` 关闭。
- `prompts[67]` 提供“输入依据／局部数据／面板／叙事”组织，`[68]` 强调展示内容不等于保存状态，新实体须同轮完整写回；这是本稿主要借鉴点。
- `prompts[77]` 的 Recorder 包装、`[8]`／`[73]` 的 Gemini 适配与长公开裁决表不照搬；本稿使用 app 原生输出协议，也不采用其主回复摘要职责。
- `extensions.tavern_helper.scripts[0].content` 的 127–169 行把中段压为一条 user 消息，并重排深度注入；本稿只借鉴输入分区，不复制消息压平或角色伪装。
- `extensions.regex_scripts[1]` 删除旧 user 输入，`[6–7]` 按深度换用摘要；本稿保留 app 既有历史策略，不移植这些提示侧正则。
- `scripts[1].content` 的 1810–1862 行专门处理 Recorder 裁决标签；app 不依赖该脚本清理输出。`scripts[2]` 是外部助手 v3.15.0 加载器，未核验其运行时。
- 不复制 ST 块宏、外部扩展、`2000000` 上下文／`60000` 输出参数或“禁止原生 reasoning”文本指令。导入 ST 预设不等于兼容 Prime 脚本。
- 原卡来源与核验见探索文档 §7；原卡随机池、同次面板及实体组织作为参考，不移植其完整玩法与变量路径。

## 3. 建档选择、模式标记与端点

- 创建新存档时，在基础设置阶段明确询问生成模式，简述两种模式的调用方式，并提示“创建后不可更改”。初始选择为空，不静默套用旧档兼容默认值或上一次建档的选择。
- 玩家必须主动选择一种模式才能创建存档；确认页再次展示所选模式。`startJourney` 同样检查创建草稿中的选择，缺失时不建档、不触发开场生成，避免仅靠 UI 禁用按钮。
- 创建成功时先将选择写入 `SaveSlot.metadata.generationMode`，然后才允许首次开场生成、回合或记忆写入；新建 Agent 档也写入 `agent`，不省略标记。
- 读档、续玩和导入已有存档直接读取其标记，不重复询问；标记缺席的旧档按 Agent 运行，无需批量回填。**缺席默认 Agent 仅用于旧档兼容，不代替新建时的明确选择。**
- 标记属于永久存档元数据，不放进可回退的世界变量；保存、备份导入导出、快照回退和重置模型设置都不得改变或丢弃它。设置页和存档列表显示只读模式标签，不提供存档内切换入口。
- 切换到另一存档时使用另一存档自己的模式；不引入可覆盖存档标记的全局 `generationMode`。想使用另一模式，需要新建存档。

使用现有 `agents` 字典中的 `agents.direct_main` 独立槽，保存端点绑定、模型／采样参数；`directPresetId` 独立持久化。配置和日志身份为 direct_main，复用现有设置解析与 API 池绑定语义，不另建连接系统。

- 首次初始化只复制 story 的有效端点／模型／采样值，之后独立保存；修改 story 不再改变 direct。
- 预设使用新的 app 原生 direct 默认预设，不复制旧 story 输出契约或原 Prime；direct 预设选择独立持久化。
- 必需控制契约只有一个引擎来源：默认 direct 预设引用同一契约。文风、口吻和附加提示不能覆盖状态 schema、调用限制或声明所有权。
- 保留 `resolveAgentEndpoint` 对未绑定、有效绑定、失效显式绑定的既有处理；不因 direct 失败静默换用另一端点。
- 每轮从当前存档读取固定生成模式，并冻结实际端点、模型参数、预设、记忆模式及所用记忆配置；模型／参数／预设仍可调整，从下一轮生效，但不能改变该存档的生成模式。
- direct 准入只验证本轮主生成与实际使用的记忆配置；未使用的 craft、combat、lore_select 等失效配置不得阻止生成。
- 模式固定适用于存档全生命周期，不只是在办战斗期间；战斗恢复同样以存档标记为准，详见 §8。

模式标记落在 `src/core/types/types.ts` 的 SaveSlot metadata，创建选择落在 `src/ui/stores/create-store.ts` 与创建页；端点参数仍沿用 `agent-settings.ts`、`settings-types.ts`、`settings-store.ts` 和 `src/ui/lib/endpoint-resolver.ts`。不把 direct 设置伪装成 story 的临时覆写。

## 4. 执行边界与请求预算

`AgentOrchestrator` 增加显式 direct 分支，保留并复用其私有记忆实现；不让 direct 先跑旧 DAG 再逐项跳过，也不通过绕过类型检查访问私有方法。

新增小模块 `src/core/agents/direct-main.ts`，唯一业务入口为 `generateDirectTurn(input, client) -> DirectTurnDraft`。它组装／发起一次主生成并解析草稿，不持有数据库、不保存状态、不启动旁路 Agent。

`GamePipeline` 负责按存档标记准入、输入准备、流式展示、本地校验与提交、楼接纳、摘要触发及后续维护；原有 agent 分支继续使用原编排。所有生成和恢复入口共用同一存档模式解析函数，缺标记的兼容行为只有一处定义。

```mermaid
flowchart LR
  A[读取存档模式并冻结本轮配置] --> B[现有前置记忆流程]
  B --> C[本地组装所选上下文与骰池]
  C --> D[一次 direct 主生成]
  D --> E[校验与本地核心提交]
  E --> F[接纳主楼与辅助写入]
  F --> G[现有摘要与记忆维护]
```

- 主客户端硬约束：`maxRetries = 0`、tools 关闭、候选数为 1；只走普通单请求生成，不启用工具往返、fallback 模型或自动续写。现有请求体合并已保护 tools，并限制 OpenAI `n`／Gemini `candidateCount` 为 1，复用该边界，不重复增加同类防御。
- 不调用主生成的 `preparePromptSession`，不读写 Delta 会话增量；每轮发送完整的**所选上下文**，不是全历史或全存档。
- 保留用户高级 body 参数；不新增 `cachedContent`／`previous_response_id`／`cache_control` 等泛化黑名单。这些参数不构成已验证的缓存命中证据，本版也不宣称控制了供应商内部缓存。
- 记忆继续使用自身端点、参数、缓存与重试；请求记录必须分别标记主生成和记忆，不能只统计编排函数调用次数。
- 超时、断流或用户取消后的手动重试是新的明确生成尝试；一次尝试内部不得偷偷补发第二次主请求。

参数边界复用 `src/core/api/body-parameters.ts`；主请求仍经 `src/core/agents/agent-client.ts` 与 `src/core/api/llm-adapter.ts`，不另建 HTTP 实现。

## 5. 主输入：足够裁定，但不导出整个存档

输入保持清晰分区：原生控制契约与风格、可见世界资料、既有历史／记忆、当前权威状态、剧情决策资料、本地骰池、当前玩家输入。

- 历史和摘要窗口遵循 legacy／v2 现有规则；只取有效消息，当前玩家输入出现一次，不把旧 user 正则删减机制引入 app。
- 当前状态不是现有 `NARRATIVE` 简化视图的原样复用：参与者需完整规则相关装备、技能、背包、精确效果／消耗、状态持续时间与当前战斗状态。
- 原生角色的冻结定义、未实体化角色目录、按有效来源筛选的重要经历及 `CHARACTER_UPDATE_PROTOCOL` 必须显式接入 direct；当前模板只对 story 自动追加这些内容，新增配置名不会自动继承。
- 仅提供与本楼行动和在场对象有关的权威投影，不发送消息表、索引、调试数据或整个数据库 dump。
- 主生成承担原 plot 前后判断时，提供所需幕后事实与当前大纲／事件状态；这些资料进入专门区，不作为玩家已知事实。
- 合并主模型后不再具有跨 Agent 的幕后信息隔离；角色知情范围依提示约束和输出投影维持，不能宣称等价隔离。
- v2 的 `lore_select` 模型请求改为本地选择，复用现有激活、依赖与相关性筛选逻辑。
- 现有 `lore-selection.ts` 是 Story-only，不能原样当作完整 direct 路由。必须为 direct 补齐战斗、制作、实体、日常及剧情所需规则的明确 audience。
- 可见性、readWhen 与依赖授权仍受 `lore-routing.ts` 控制；不取所有 Agent 资料并集，也不能只读取 story audience 而漏掉数值协议。
- 固定控制契约和必需规则不得截断。输入总量加输出预留按实际端点窗口检查；超限在请求前报错，不自动切多次续写。
- 字符估算应明确标为估算；未知端点窗口不能假装已验证容量，设置页需让用户填写或采用已有端点能力来源。

## 6. 主输出骨架

采用 app 原生正文投影，并追加一个必需的结构区；不要求长思维链，不输出记忆摘要，也不接受裸存档 patch。

```xml
<maintext>
叙事与对应的 action_info / item_info 可见面板
</maintext>
<options>可选行动建议</options>
<character_updates>{"characters":[]}</character_updates>
<direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>
```

这里展示结构，不是完整 schema。实现时定义封闭的 v1 类型与校验器；所有顶层分区必须存在，无变化用对应空值，`direct_updates` 必须且只能有一个。

| 分区       | 职责与所有权                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`  | 固定为 1；不识别的版本在写入前失败。                                                                                                                                                                                   |
| `world`    | 复用 dispatcher 的世界变量／地图事实声明，排除时间与其它分区拥有的字段；不允许任意 DB 路径。                                                                                                                           |
| `time`     | 唯一时间推进声明，`delta_time` 为非负有限分钟；后续日常／时间处理消费同一值，不重复推进。                                                                                                                              |
| `entities` | 区分角色创建与归属物生成：角色项为 `{kind:"character", placement:{location,present}, output:EntityGenOutput}`；归属物项为 `{kind:"loadout", owner, output:EntityGenOutput}`。后者不能携带 character 块，不再生成请求。 |
| `state`    | 复用 vars／quests 的受控更新和已有对象资源、库存、关系变更；不创建实体或声明状态效果。                                                                                                                                 |
| `effects`  | 统一承接状态新增／移除及日常到期、周期／条件效果声明；同一效果只能有一个声明来源，不重复提交实体初始效果。                                                                                                             |
| `plot`     | 承载既有 pre／post 判断所需数据，交本地解析与剧情提交；不触发独立导演或大纲请求。                                                                                                                                      |
| `combat`   | 无战斗为 null；否则声明本楼战斗状态操作、进度与终局，转换为受控 `CombatState` 变化。                                                                                                                                   |
| `diceUsed` | 使用的骰池索引、用途／对象与消费顺序；本地核对引用合法性，不把日志等同于盲取公平证明。                                                                                                                                 |

`character_updates` 沿用现有协议：恰好一个完整块，无变化也给空 `characters`；只负责档案／经历，不承担数值实体。尚无 `CharacterState` 的首次登场人物，包括已选中的作者角色，必须同楼具备完整 entities 数据，否则本楼结构失败，不自动补调 entity_gen。仅在正文提及而不需要建立人物状态者，不强制创建实体。

角色项的 placement 明确本楼提交后的初始位置与在场状态，传给现有组装函数的 overrides；本楼从 A 到 B 遇见的人物不能默认落在调用前的 A。角色 ID、saveId、作者定义绑定与 introducedBy 来源由代码填写，模型不产生这些元数据。

`maintext` 是流式预览的唯一正文来源。最终结构收齐、解析及校验前不写游戏状态；隐藏结构不得进入玩家正文、选项或记忆输入。

## 7. 合并职责与避免重复结算

- world 复用 `buildDispatcherPatches` 的受控翻译；时间从该翻译结果拆出，只有 `time` 分区拥有推进权。
- state 复用 `buildVarsUpdatePatches` 的可用子集；旧 `characters.add`、状态新增等重叠入口在 direct 契约中禁止，防止同一声明执行两次。
- entities 复用 `EntityGenOutput`、实体解析／组装与按名引用规则；角色创建走 `assembleCharacterState` 加 `add_character`，普通 `buildEntityGenPatches` 不会创建人物。提取现有 runCharacterGen 中的本地定义／叙事档案／introducedBy 绑定段供两模式共用，不复用其网络调用；新人物先正式入库，随后才处理编年史与关系引用。
- 已有物品重铸／替换必须明确目标并采用对应替换语义；同名 `add_item` 只累加数量，不会更新品质或效果，不能把它当作完整物品改写已接通。
- 制作将声明的材料扣除、资源／奖励变化和 entities 产物放入同一个核心领域批次，不再运行 craft_gen 或后接产物生成。
- 日常结算由主模型在 time／effects／state 中声明；保留本地时间、地图派生及已有规则，旧 daily_check 不另发请求，也不重复处理战斗内同一效果。
- plot 用现有结构解析与本地持久化完成前后判断；旧导演的独立生成取消，不把剧情提示中的隐秘内容直接写进玩家正文。
- “获得装备”和“穿上装备”是两个操作：新增物品不以自带 equippedSlot 绕过现有 equip_item 的数量／槽位检查；需要穿戴时在同一核心批次追加明确装备操作。
- 现有 `add_item`／`add_skill`／`add_status_effect` 新增分支对 `protocolText`／`tags` 的传递不完整，不能因实体 parser 已支持就宣称端到端可用；必须补齐并验证保存后再读取。

## 8. 战斗、制作与跨楼状态

直出采用 AI 裁定：主回复给出过程、结果及状态声明。**不在生成后调用 `resolveCraft` 重新掷骰或改判**；本地只做类型、有限数值、引用、库存、名称与既有升级等写入检查，不验证全部配方或强制代码判胜。

- 战斗根据玩家本次输入推进到下一个需要玩家决定的位置；行内 `action_info` 展示，不启动旧独立 DM 窗口或自动敌方模型循环。
- 保留多楼战斗，复用 `CombatState` 类型；direct 在办状态与来源楼保存在 `SaveProfile.worldFlags.directCombat`，不新建表，也不复制一份到旧 `combatSandboxes`。
- 旧 `combatSandboxes` 是不进备份的在办缓存；direct 每楼是正式剧情进度，必须随 profile 快照、回退和导出／导入一起保存。不能只复用旧缓存，导致正文回退而战斗仍处在未来。
- direct 只保存结构化状态及来源，不积累／续接工具 transcript。载入只恢复状态和展示，不自动请求；GamePage 按存档标记选择 agent 沙盒或 direct profile 状态的恢复入口。
- 战斗始终沿用所属存档的固定模式；结束或放弃战斗也不会解锁模式切换，不提供跨模式转换或重开流程。
- 活跃战斗的参与者 HP／MP／SP 与战斗状态效果以 `CombatState` 为真源；同楼 state／effects 不得再写这些参与者的相同字段。
- HUD、人物查看器和下轮输入共同使用基于 directCombat 的只读当前状态投影；不把未终局资源写成第二份真源。不能通过设置旧 game.combatState 修补 UI，否则会打开旧战斗覆盖层。上下文 combatActive 也必须来自 directCombat，才能保持战斗中不注入随机事件的现有规则。
- 区分“战斗仍在进行”和“旧 Agent 战斗窗口打开”：人设编辑等既有战斗限制读取前者，旧 CombatPanel 只读后者。direct 每楼接纳后仍可存档／按楼回退，生成中的限制不变；不能把旧沙盒的全程禁止快照规则直接套过来。
- 新参战实体先完成本地组装，再用于战斗状态引用；临时战斗单位与正式存档人物仍按既有 origin 语义区分。
- 终局沿用现有存档单位白名单结算映射；EXP／FP 由本次主输出统一声明，旧自动经验／奖励计算不能再叠加执行。
- 制作保留成功／失败、产物与材料变化；没有完整产物实体时不得把可见 item_info 当作已入库装备。
- 本地预掷骰池参考原卡 60 个 d20，但按真实协议同时供应需要的其它骰式；AI 提交索引日志，不自行创造骰值或复用已耗索引。
- 池耗尽时保留未完状态并停在下一楼，不重发主请求补骰；预先可见整池仍可能影响模型选择，不承诺公平盲取。

## 9. 提交顺序与失败语义

现有 `commitDomainCommand` 提供存档写锁与领域事务，但不覆盖全楼所有表和附属动作；普通 `commitChatState` 为逐项容错，不能拿来替代制作的原子批次。

1. 完整收取输出；校验 schema、必需结构、实体完整性、引用、骰索引和字段／效果的重复所有者，拒绝非法跨分区写入。
2. 本地构造角色／产物和受控变更，不做网络请求；解析 plot、time、chronicle 等后续输入，提前发现结构错误。
3. 在现有 StateManager 入口扩展 direct 核心事务，把资源／库存／实体与战斗 snapshot 归入同一批；失败整批回滚。本楼合法随机事件回执先在锁内确认，再执行可能清理候选的位置／条件变化；复用现有纯结算与内部 profile 写入，不嵌套调用自行加锁的公开 confirmRandomEventTrigger。
4. 同一核心事务纳入 `messages` 表，核对来源 user／assistant 消息、存档归属及取消条件，并将本次消息标为 accepted；已接纳的同一结果直接返回，不再次扣材。避免游戏状态已提交、接纳标记却写失败后被当作新尝试重放。
5. 核心入口只获取一次现有存档写锁；不能外层加锁后再调用会自行上锁的 `commitDomainCommand` 或 UI `setStoryTurnStatus`。复用它们的核验语义，提取所需内部操作；核心不 import UI。
6. 核心成功后依次执行 applyTimeAdvance、syncMapJourney、剧情本地提交；用实际结束时间更新本楼已接纳消息，再构造其来源并提交 character_updates／作者初始经历。编年史读取来源消息的结束时间，不能先写编年史后补消息时间。
7. 完成本地状态收尾和 syncRandomEventsForTurn，再推进回合并打快照；随后 refreshFromDb，更新消息／选项和 direct 战斗只读投影，并刷新供记忆使用的上下文。最后才进入现有摘要与记忆维护，不能只刷新核心提交结果便让 UI／记忆读旧时间或旧地图。

世界地图、时间、剧情、编年史和快照各有现行入口，不能声称上述步骤已由一个现成事务全包；消息接纳并入核心事务是本版需要实现的变更。实现须标清每项所属步骤和来源楼；核心事务成功后的辅助失败显示警告、沿用既有回退能力，不自动重跑主模型或重复扣材。周期效果按楼开始时的旧状态和本次时间差声明，新增状态不再被扣一次本楼时长；本地时间推进后不得重新执行同一周期效果。

部分现行地图／随机事件辅助方法捕获错误后仅 console.warn；直接 await 它们无法兑现“具体失败可见”。direct 使用的这些入口须返回诊断结果供管线展示，不另建自动重试系统。

未提交前的无输出、坏 JSON、核心结构截断、网络失败或取消，作为失败楼保留错误／预览提示，不推进游戏状态、不形成正式摘要。手动重试明确产生新主请求；记忆前置任务已经完成的独立维护遵循原有语义。

已经接纳的楼若要重新生成，必须先走既有回退恢复其之前的游戏状态；不能仅把旧消息改成 failed 再覆盖正文。来源楼的接纳核验与回退准入需要测试，避免同一玩家行动重复扣材或发奖励。

已提交后的摘要或其它记忆任务失败不撤销主楼，不再次应用 direct_updates。辅助写入失败也不得自动补发主请求；需要用户处理时展示具体未完成项，不把全楼显示成完全成功。

## 10. 记忆接入保持原流程

- Orchestrator 继续调用现有 recall／summary 及 legacy／v2 维护，不将这些实现搬到 direct-main，也不把主调用参数覆盖到记忆客户端。
- 摘要只消费已接纳楼。给现有 `Agent.STORY` 输出槽提供清洁的游戏正文与可见面板／已公开事实，不提供原始整段输出。
- `direct_updates`、幕后 plot 判断、控制契约和未公开实体数据都剥离；保留玩家输入与可见后果的现有记忆关系。
- 上述清理只限定主输出投影；记忆原有当前时间／角色／剧情事件等上下文继续保留，使用本地提交后刷新值，不伪造 dispatcher 输出。既有摘要的隐藏线输出职责不在本版重构。
- 主回复不承担 memory summary；Prime 的 summary 模块、历史正则和外部摘要助手不进入本实现。
- 前置记忆失败沿用既有准入／错误语义；后置记忆失败与已提交主楼分开报告。旧重试、缺摘要补建与归档策略不因 direct 缩减。

## 11. 必须封住的额外请求入口

| 入口                                       | direct 行为                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| v2 lore_select                             | 本地选择，不建 selector 模型客户端。                                         |
| 末尾未知 NPC 自动生成                      | 使用完整 entities；缺失时报结构错误，不补请求。                              |
| craft／entity／combat／plot 标记与旧 daily | 只允许 direct 本地语义；不分派旧生成链、导演或战斗 runner。                  |
| GamePage 自动 resume                       | 以存档标记分流；direct 档只恢复结构状态，不能启动旧 agent 续战请求。         |
| sceneimage／image_prompt 自动流程          | 不因主回复标记自动生成提示词或图像；直出楼内禁自动出图。                     |
| 音频、随机事件回执                         | 保留已有本地播放与回执处理，不借机启动新的模型生成。                         |
| 手动重铸、手动出图、开局大纲               | 作为用户明确发起的独立动作展示，允许使用原路径，但不能偷偷挂在 direct 楼内。 |

开场正文也受一次非记忆主请求限制；手动开局大纲的独立费用与调用不伪装成开场正文附带处理。

## 12. 最小实施触点与顺序

| 位置                                                                                                      | 必要变更                                                               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/core/types/types.ts`、存档模式解析模块、`src/ui/stores/create-store.ts`                              | 永久模式标记、缺标记默认 Agent、创建草稿选择及建档校验。               |
| `src/ui/components/create/CreateStepBasic.vue`、`CreateStepConfirm.vue`、`CreateFooter.vue`               | 新建时明确询问并要求选择；确认页展示模式和创建后不可更改的说明。       |
| `src/ui/stores/settings-types.ts`、`settings-store.ts`、`agent-settings.ts`                               | 独立模型配置与 directPresetId；不添加全局运行模式开关。                |
| `src/ui/components/settings/agent/AgentConfigPanel.vue`、`src/ui/lib/endpoint-resolver.ts`、存档列表      | 只读存档模式标签、direct 参数展示，复用端点解析；不提供转换入口。      |
| `src/core/agents/agent-orchestrator.ts`、新增 `direct-main.ts`                                            | 显式执行分支、保留记忆、单次主生成与草稿类型。                         |
| `src/core/prompts/agent-templates.ts`、`src/core/content/lore-selection.ts`／`lore-routing.ts`            | 完整规则状态投影、原生 direct 契约、本地资料选择与 audience。          |
| `src/core/agents/entity-gen-agent.ts`、`src/core/character/`                                              | 复用实体组装，提取定义／素材／首次登场来源绑定，显式接入角色上下文。   |
| `src/core/story/story-output.ts`、`src/core/agents/entity-gen-parse.ts`、变量翻译器                       | 正文／结构分离、受控解析、所有权校验与现有格式复用。                   |
| `src/core/state/state-manager.ts`、`src/core/types/types.ts`、`src/core/combat/sandbox/types.ts`          | 核心领域及消息接纳事务、protocolText／tags 透传、direct 战斗随档状态。 |
| `src/ui/lib/game-pipeline.ts`、`src/ui/components/game/GamePage.vue`                                      | 准入、冻结、接受顺序、关闭旁路、恢复战斗与独立记忆交接。               |
| `src/ui/stores/game-store.ts`、`StatusOverview.vue`、`CharacterViewerModal.vue`                           | direct 战斗当前状态投影；区分实际战斗限制与旧窗口状态，提交后刷新。    |
| `src/core/story/beautifier.ts`、`src/ui/components/game/BeautifiedNarrative.vue`、`combat/combat-view.ts` | 在普通聊天复用 action_info 面板解析，保持结构数据隐藏。                |

实施依次推进：①存档模式标记、创建选择与准入；②native direct 契约和本地上下文；③单请求与解析；④实体／制作／战斗核心事务；⑤时间剧情档案等接纳收尾与记忆；⑥UI 和入口封锁；⑦针对性回归与人工游玩。只提取本次所需函数，不新建通用 Agent 框架。

## 13. 可用性与调用数验收

先用 mock 客户端／请求计数验证，再做用户授权的真实模型游玩；当前没有 direct 实现或真实模型质量／费用证据。

- 新建流程初始未选择模式，必须主动选择才可建档；直接调用 startJourney 也不能绕过。Agent／direct 新档均显式写标记，并先于首次开场生成。
- 缺标记的旧档和旧备份始终按 Agent 解析，不受当前模型设置或上一存档影响；加载、续玩、导入不会再次询问模式。
- 已建档模式不可更改；修改模型设置、结束／放弃战斗、回退、备份往返均不改变标记。切换两个不同模式的存档时，分别进入正确执行路径。
- 普通、开场、新人物、制作、战斗、多对象同楼：每次尝试非记忆请求 ≤1；`n=1`、无 tools、无 Delta、无网络自动重试／fallback／续写。
- 记忆独立计数：legacy／v2 各走原流程，重试与维护行为不变；摘要失败不回滚主楼、不再生成正文或重复扣材。
- 只使用 direct 与实际记忆配置；禁用 Agent 的失效端点不干扰 direct，direct 显式失效绑定也不偷偷换模型。
- 当前输入一次、有效历史窗口正确；参与者精确效果与消耗齐全；必要 lore audiences 覆盖战斗／制作／实体，超预算在请求前拒绝。
- 坏 JSON、缺 direct_updates、未知人物缺实体、截断／取消：没有核心状态提交、无正式 accepted 消息与摘要；手动重试只新增一次尝试。
- 制作缺料导致整批拒绝，不留下产物或奖励；材料／产物／奖励成功只提交一次。这里检查声明材料，不声称已核验完整配方。
- 作者角色首次实体化与新 NPC 均不补发请求；冻结定义／素材、introducedBy、作者过去与本楼经历关联正确。同楼移动后遇见的人物使用提交后位置，不能落在出发地。
- 新人物、技能、装备、物品、状态保存后重读，`protocolText`、`tags`、消耗和效果仍可用于下一楼；不能用“面板看起来正确”替代持久化验收。获得装备不自动穿戴，明确穿戴继续经过数量／槽位检查。
- 移动经位置真源更新地图、首访与候选；推进时间后的天气／地图收益／剩余旅程反映在 UI，地图收益只入账一次。已触发事件在位置清理候选前记回执，回合末只作候选保洁。
- 编年史引用已接纳消息的实际结束时间；新档案、经历、背包及地图在本地收尾后可见。任务状态与显式奖励各提交一次，不从任务卡片推断奖励。
- 活跃战斗使用 CombatState 资源，拒绝 state／effects 重复写；direct 跨楼、刷新恢复均不自动请求，恢复路径只取决于所属存档模式。回退和备份导入后 direct 战斗与对应正文进度一致，不继承未来状态。
- 战斗终局奖励不与旧计算叠加，骰索引不可越界／重复消费，池耗尽保留未完状态；测试不宣称模型盲取公平。
- direct 战斗中 HUD、角色查看器与下轮输入读取同一当前资源／状态，旧战斗覆盖层不打开；人设编辑仍受战斗限制，楼间存档及回退可用。普通正文能显示 action_info，既有 item_info 继续可用。
- 核心消息接纳写入失败时连同资源／实体回滚；同一已接纳结果重复提交为 no-op。提交后 time／plot／chronicle／消息时间／快照任一辅助失败：主楼仍被接纳、具体失败可见，不重发主请求、不重扣材料。
- memory 的 story 输入只有清洁可见正文，不含 hidden 更新块或幕后 plot；streaming 只展示 maintext，不提前写状态。direct_updates 完整块、未闭合块与主正文缺闭合标签的流式输入都不得泄露控制 JSON；选项仅在接纳后启用。
- 缺标记旧档的 Agent 行为和既有记忆模式准入回归通过；独立手动操作仍可用且不算作楼内隐式调用。

## 14. 本轮交付与验证

设计工作仅新增及修订本文档，不改生产代码、旧探索历史或私有参考资料，不提交／推送。本次修订包含存档模式固定，以及角色、地图、库存和 UI 接线核查。执行该文件的 Prettier、严格 UTF-8／控制字符检查及 diff 检查；设计验收项仍待实现后执行，不复用此前测试通过数宣称本模式可用。

### 现行实现的核验入口

- 存档元数据与创建入口：`src/core/types/types.ts:1568`、`src/ui/stores/create-store.ts:1936`；现有永久记忆模式标记见 `types.ts:1591`，新增生成模式标记与其正交。
- 设置与非使用端点：`src/ui/stores/settings-types.ts:125`、`src/ui/lib/game-pipeline.ts:1287`；主运行与额外 NPC 生成：同文件 `:636`、`:859`。
- 记忆分流、选书额外请求和格式重试：`src/core/agents/agent-orchestrator.ts:594`、`:668`、`:1407`；后置记忆维护：`src/ui/lib/game-pipeline.ts:939`、`:3012`、`:3061`。
- 输出投影、实体和日常翻译：`src/core/story/story-output.ts:18`、`src/core/agents/entity-gen-agent.ts:369`、`:604`、`src/core/variables/daily-check-translator.ts:204`。
- 现有领域事务与普通 AI 补丁的不同语义：`src/core/state/state-manager.ts:526`、`:659`；现有消息接纳事务：`src/ui/stores/game-store.ts:1153`，不能从核心直接调用 UI 实现。
- 旧战斗缓存不随档：`src/core/combat/sandbox/persistence.ts:1`；profile 整体快照和恢复：`src/core/state/state-manager.ts:2384`、`:2574`；旧自动恢复入口：`src/ui/components/game/GamePage.vue:239`。
- 剧情并非全走 StatePatch：`src/ui/lib/game-pipeline.ts:2418`、`:2644`；原时间推进入口：`src/core/agents/agent-orchestrator.ts:1844`。这些是实现接线依据，不代表直出已支持。

## 15. 角色、地图、库存与 UI 如何衔接

这里的 hook 是现有本地函数与明确的管线调用，不是一个已经存在的统一插件总线。direct 需要新增的主要是输入／输出契约及接线；数据库、原生角色体系、地图和大部分查看面板继续复用。

### 角色生成与原生角色体系

角色仍有三层：冻结的作者定义 `CharacterDefinition`、存档内机械及当前档案 `CharacterState`、按来源回合保存的 `CharacterChronicleEntry`。选中作者角色只保存定义，不等于已创建 NPC 实体；现有建档只创建传入的玩家。依据：`docs/reference/character-system.md`、`src/core/persistence/create-journey.ts:66`、`src/ui/stores/create-store.ts:1949`。

1. **生成前**：明确把作者目录、相关角色档案／机械状态及重要经历接入 direct 输入。现有模板仅在 `agentId === 'story'` 时自动加入角色上下文，direct_main 不会自动获得这条路径（`src/core/prompts/agent-templates.ts:807`）。
2. **同次回复**：首次需要入库的人物在 entities 给完整属性、资源、装备、技能及初始状态；character_updates 给档案变化和经历。现有角色只给变化，不能每楼重建；提到某人不等于为其创建实体。
3. **本地组装**：匹配本存档冻结定义，保留作者素材关联；按现行优先级合并当楼档案，注入 ID、saveId、introducedBy 和明确位置。原 runCharacterGen 的这段本地逻辑需提取复用；只调 assembleCharacterState 或 add_character 不会自动完成全部绑定（`src/core/agents/entity-gen-agent.ts:204`、`src/core/state/state-manager.ts:1756`）。
4. **接纳后**：用消息实际结束时间提交经历，保留来源指纹核验、初登场才可写生成过去、既有历史不被改写等规则；再补齐作者初始经历。新生成角色只属于本存档，不写回作者角色库（`src/core/state/state-manager.ts:367`、`:406`）。
5. **显示及后续上下文**：人物查看器沿用当前角色实例，编年史沿用 Dexie liveQuery；下一楼按现行重要度与来源有效性筛选经历，不把所有历史塞入主请求（`src/ui/components/game/CharacterViewerModal.vue:69`、`CharacterChronicleTab.vue:31`）。

这里取消的是机械数据的独立 entity_gen 请求，原生角色功能本身不需要取消。缺少必要实体数据时本楼失败，不再走旧管线的未知 NPC 自动补调。

### 其它本地钩子

| 系统             | 主回复声明                                 | 继续执行的本地处理与边界                                                                                                                                       |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地点／地图       | 人物位置、目的地、允许的地图事实／标记     | 人物 location 是真源；set_location 自带地图落位、首访和首访事件处理。mapFacts 是地块事实，mapMarkers 是显示叠层，不能用挪动标记代替人物移动。                  |
| 时间／旅程       | 一个 delta_time 与当前目的地               | applyTimeAdvance 处理时间、天气、逐日随机事件和地块周期收益；随后显式 syncMapJourney，从本楼提交后位置重估剩余旅程，到达后清旗。时间为零时不假定天气重新计算。 |
| 随机事件         | 从本轮候选中确认实际叙述的 event_trigger   | 候选被位置／条件变化清理前确认回执；收尾再清理候选。回执记录已触发与冷却，不自动执行剧情脚本或奖励。                                                           |
| 背包／装备／技能 | 新物完整实体、数量变化、明确穿戴或替换目标 | 继续用受控库存操作；获取与穿戴分开，同名 add_item 只加数量，重铸必须明确替换。物品卡片是展示，不是入库指令。                                                   |
| 状态／日常       | 到期、持续效果、恢复或消耗                 | 旧 daily_check 的模型判断并入本次声明；本地时间方法不会自动替它扣状态持续时间。战斗中的资源／状态只由 combat 分区拥有。                                        |
| 任务／剧情       | 任务进度、剧情状态及显式奖励               | 本地更新任务、剧情和大纲；完成任务本身不自动发奖励。地图自动周期收益继续由代码入账，主输出不得再支付一遍。                                                     |

位置／时间／旅程入口：`src/core/state/state-manager.ts:1735`、`:2766`、`:3094`；事件回执／收尾：`:2985`、`:2943`；地图收益：`:3158`；库存、穿戴、技能与任务：`:1421`、`:1577`、`:1649`、`:1866`。direct 使用这些语义，不重复手工调用已经包含在 set_location 内的钩子。

### UI 复用与需要补的地方

- **可复用**：人物查看器、素材与相册、编年史、背包／技能列表、任务和地图面板。完成本地收尾后 refreshFromDb 回读 characters／profile／plot，消息与选项另行更新；编年史自行订阅表变化。依据：`src/ui/stores/game-store.ts:1277`、`src/ui/components/game/ItemsPanel.vue:20`。
- **新增实体字段要能真正存住**：现行新增物品／技能／状态分支有 protocolText／tags 透传缺口。制作面板显示成功不足以证明下一楼能读到完整效果，必须以入库后重读验收（`src/core/state/state-manager.ts:1329`、`:1435`、`:1664`）。
- **正文战斗卡片需接入**：普通美化器当前只内建 item_info／task_info；action_info 解析在旧战斗视图。将其纯解析／呈现复用到普通聊天，不引入旧战斗 runner（`src/core/story/beautifier.ts:378`、`src/ui/components/game/combat/combat-view.ts:235`）。
- **战斗数值需投影**：HUD／人物查看器当前直接读人物 HP／MP／SP；direct 多楼战斗需读取 directCombat 中的当前数值和状态。旧 isInCombat 同时控制覆盖层、编辑限制和存档限制，必须按 §8 分清用途，不能简单置为 true（`StatusOverview.vue:441`、`CharacterViewerModal.vue:395`、`src/ui/stores/game-store.ts:212`、`:1354`、`:1459`、`:1612`）。
- **流式结构需隐藏**：story-output 的控制标签清单没有 direct_updates，必须补齐完整与未闭合块投影；接纳前仅预览正文，不提前激活行动选项或修改数据（`src/core/story/story-output.ts:21`、`:67`）。
- **图片需区分查看与生成**：现有立绘／相册照常查看；楼内自动 sceneimage 会再调用 image_prompt，故关闭自动链。用户明确点击的独立出图仍可用，不算同楼隐式生成（`src/ui/lib/game-pipeline.ts:2093`、`:4174`）。

例如“进入镇上，初见已选作者铁匠，并制作一把剑”：一个主回复同时给正文／物品卡、铁匠机械实体与本楼位置、材料扣除与剑实体、耗时、档案／经历。代码完成角色定义绑定、核心入库、地图／时间收尾及编年史提交后，原有角色页、背包、地图与时间显示更新；这一过程没有第二次非记忆模型调用。若仅输出漂亮的剑卡却缺剑实体，本楼不能按制作成功入库。
