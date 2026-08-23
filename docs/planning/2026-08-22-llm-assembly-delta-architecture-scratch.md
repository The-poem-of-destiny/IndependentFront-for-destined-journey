# LLM 组装层 Delta 会话架构

> **状态**：已实施（2026-08-23），真机运营验收待执行
>
> **用途**：约束 LLM 组装层 v1 的实现范围、接口、不变量和验收口径。实施步骤见
> [`2026-08-22-llm-assembly-delta-implementation-plan.md`](2026-08-22-llm-assembly-delta-implementation-plan.md)。
>
> **替代说明**：本文由同路径的讨论初稿修订而来。原始测量保留为背景证据；原初稿中
> “只按 saveId 共享状态”“清空 delta 回到旧基线”“直接复用 StatePatch”“字符新增量等同
> cache miss token”等结论已废止。

## 1. 问题、目标与范围

当前 `buildAgentMessagesAsync` 每次为一个 Agent 重新渲染完整上下文，最终返回一条 system
消息。即使静态前缀大量命中，多个 Agent 各自变化的后缀相加，预热后的普通回合仍可能超过
成本目标。

### 1.1 v1 目标

- 保持每个 Agent 首次 system 内容与现有生产渲染结果等价，只在既有 user 触发消息中增加
  固定 delta 协议说明和可选 `tailPrompt`。
- 后续成功回合复用该 Agent 的完整 wire transcript，只追加本轮变化。
- 普通主线回合预热后，默认主 DAG 的 LLM 请求合计
  `usage.prompt_cache_miss_tokens <= 30,000`。
- 重载、切换存档、修改静态配置或重基线后，模型看到的必须是当前权威状态，不能回滚。
- 不改变 Agent 输出契约、DAG 依赖、StateManager 写入契约或世界书 EJS 求值语义。

### 1.2 v1 纳入范围

默认主 DAG 的普通 `chat` / `chatStream` 路径：

- `memory_recall`（仅其配置为聊天模型时；embedding 路径无 LLM prompt，不计入）。
- `plot_pre_check`。
- `story`。
- `request_dispatcher`。
- `memory_summary`。
- `vars_update`。
- `plot_post_check`。

以上七个 Agent 是本文“主 DAG 合计”的唯一口径。某次配置禁用了其中一个，或
`memory_recall` 走 embedding，实测报告必须明确写出实际调用集合。

### 1.3 非目标

- 不接入 `combat_v3`。
- 不接入 `chatWithTools`，也不改变 `char_gen` / `item_gen` / `craft_gen` 的工具会话。
- 不改 `image_prompt`、剧情大纲等侧链的上下文策略。
- 不顺带修复 `historySlice`、缩减动态投影或新增全量 prompt 诊断平台。
- 不持久化会话 transcript，不跨浏览器重启追求缓存连续性。
- 不引入 tokenizer、模型能力注册表、新模板语言或第三方依赖。

这些项目即使有价值，也必须由独立任务和独立证据进入范围。

## 2. 证据与验收口径

### 2.1 权威基线

[`docs/reviews/2026-08-21-live-prompt-cache-10-turn-report.md`](../reviews/2026-08-21-live-prompt-cache-10-turn-report.md)
记录了生产应用、真实内容包、十个玩家回合的 provider usage：

- 七个主 DAG Agent 平均未命中 36,385 tokens/回合。
- 全部 Agent 平均未命中 42,505 tokens/回合。
- 静态大前缀总体命中有效，问题集中在多个 Agent 重复携带动态后缀。

2026-08-22 的三个相邻导出显示，内容指纹法估算的新增字符量约 1.5–2 万字符/回合。该结果
只证明“存在大量位置造成的伪 miss”，不证明 delta 后的 provider miss 数值。

### 2.2 不再使用的推导

- 字符数不等于 token 数；文档不得再写“3 万字约等于 3 万 token”。
- shingling 新增字符不能直接换算成 `prompt_cache_miss_tokens`。
- 缓存命中是 best-effort；一次冷轮或缓存淘汰不能用来判定本地组装逻辑失败。
- cache-hit token 仍有成本，总 prompt 和输出仍占上下文；不能写“命中不花钱”或“总量不重要”。

### 2.3 验收分两层

**确定性验收**在本地测试完成：

- 第 N 次请求的 messages 必须逐项以前一次实际 wire messages 加成功 assistant 响应为前缀。
- 本轮只追加一个 user delta 消息，且内容顺序和序列化结果稳定。
- 重基线使用当前全量投影，不复用旧快照。
- 失败、取消、签名变化和存档切换不会提交错误 transcript。

**运营验收**用 provider usage 完成，不进 CI：

- 同一配置先运行至少两个预热回合。
- 再记录五个连续、无制作/创角/战斗侧链的普通主线回合。
- 七个主 DAG LLM 请求逐回合合计 miss 均不高于 30,000 tokens。
- 同时报告 hit、miss、completion、实际 Agent 集合和是否发生重基线。

provider 缓存被淘汰时应记录为环境事件并重测，不能修改本地测试去“适配”偶发冷缓存。

## 3. 缓存与正确性不变量

1. **wire prefix 才是缓存前缀**：本地保存的必须是实际发给 provider 的 messages，包括
   `AgentClient` 为纯 system 请求补的非空 user 触发消息。
2. **正确性不依赖缓存命中**：远端缓存缺失只增加成本，不能改变模型收到的语义。
3. **成功后才推进**：只有拿到成功 assistant 响应后才能把本轮写进会话。
4. **每 Agent 隔离**：不同 Agent 的 system、世界书、上游输出和 assistant 历史不得共享。
5. **每存档隔离**：同一 Agent 在两个存档中的状态和叙事不得共享。
6. **配置变化即重基线**：模型、endpoint、system/preset、template、世界书配置、`tailPrompt`
   或协议版本变化时，旧 transcript 立即失效。
7. **重基线不回滚**：重基线从当前 `AgentContext` 重新渲染完整 prompt，并以当前投影作为
   下一轮 diff 起点。
8. **AI 只见名字**：delta 中角色、物品、技能、状态效果和任务继续按名字寻址，不暴露内部 id。

## 4. 模块与 seam

新增一个深模块 `prompt-session-assembler.ts`，由它独占会话状态、投影 diff、消息追加、签名
失效和重基线判断。`AgentOrchestrator` 只跨一个小 interface：

```ts
interface PreparedPromptSession {
  messages: ChatMessage[];
  handle: PromptSessionHandle | null;
  rebased: boolean;
  rebaseReason?: PromptRebaseReason;
}

preparePromptSession(input: PreparePromptSessionInput): Promise<PreparedPromptSession>;

completePromptSession(
  handle: PromptSessionHandle,
  result: Pick<
    AgentResult,
    'rawResponse' | 'promptTokens' | 'cacheHitTokens' | 'cacheMissTokens' | 'completionTokens'
  >,
): void;

invalidatePromptSession(handleOrSaveId: PromptSessionHandle | string): void;
```

接口约束：

- `preparePromptSession` 返回可直接发送的 wire messages；调用方不得再改消息内容或顺序。
- `handle === null` 表示该调用不在 v1 范围，继续走现有无状态行为。
- `completePromptSession` 只接受成功结果；失败和取消走 `invalidatePromptSession`。
- module 内部可以拆纯函数，但不把 diff 细节、Map 或重基线规则暴露给调用方。

不新增 provider adapter。provider 请求仍由 `AgentClient` 负责；组装 module 只处理进程内数据。

## 5. 会话身份、签名与生命周期

### 5.1 身份

会话主键是 `(saveId, agentId)`。不能只用 `saveId`，因为同一 stage 的不同 Agent 会并行，且
各自可见的模板、世界书和 assistant 响应不同。

每条会话另保存 `baselineSignature`，由以下静态输入确定：

- delta 协议版本。
- endpoint id 与实际 model。
- Agent systemPrompt 或 story preset 原文。
- 上下文 template 原文。
- Agent 可见世界书的 id、enabled、order 与条目原文。
- `historyLayers` 和 `tailPrompt`。

签名只比较静态配置，不包含本轮状态、EJS 动态求值结果、玩家输入或上游 Agent 输出。实现可
保存规范化字符串并做精确比较；v1 不需要为它引入加密哈希。

### 5.2 内存状态

每条会话只保存：

- 上一次实际 wire transcript。
- 上一次成功后的 `PromptStateProjection`。
- 已写入 transcript 的持久消息 id 游标。
- 当前 revision。
- baseline signature。
- 最近两次 provider prompt token 数（若 provider 返回）。
- 是否存在未完成调用。

不写 Dexie。页面刷新、应用重启或 module 重新初始化后，下一次请求自然从当前状态建立新基线。

### 5.3 并发与失败

当前主 DAG 同一回合不会并发调用同一个 Agent；同 stage 并行的是不同 `agentId`。v1 依赖这个
生产不变量，不另建队列或锁管理器。

若同一会话在未完成时再次 `prepare`，module 应使旧会话失效，并让新调用以当前全量 prompt
重基线。这样保正确性，不为未出现的吞吐需求增加调度系统。

最终失败、取消、流中断或手动重新生成都会使对应会话失效。`AgentClient` 内部对同一请求的
自动重试仍复用同一份 prepared messages，不算新 revision。

## 6. 消息形态

### 6.1 第一次请求或重基线

第一次请求完全复用当前 `buildAgentMessagesAsync` 的 system 渲染结果。随后以现有“继续”触发
文本为开头，追加 code 固定的 delta 协议说明和可选 `tailPrompt`，形成唯一的首轮 user 消息。
规范化后的 wire messages 保存为 baseline：

```text
system: 当前完整 prompt（现有生产语义）
user:   “继续”触发 + delta 协议说明 + 可选 tail_prompt
```

这避免在 v1 中重写 story preset、用户自定义 template 或占位符顺序。

成功后保存 provider 返回的 assistant content。下一次请求以前一次完整请求加该 assistant 响应
作为精确前缀。

### 6.2 后续请求

```text
system: baseline 完整 prompt
user:   baseline 触发消息
assistant: 第 1 次成功响应
user:   revision 2 的 context_delta + turn_context + tail_prompt
assistant: 第 2 次成功响应
user:   revision 3 的 context_delta + turn_context + tail_prompt
...
```

旧消息不重写、不重排、不删除。新的 user 消息固定按以下顺序渲染：

1. `context_delta`：相对上一成功投影的持久状态变化。
2. `turn_context`：本轮玩家输入、当前新增叙事、上游 Agent 输出和链参数。
3. `tail_prompt`：该 Agent 的单一用户自定义末尾指令；空值时整个区块省略。

`tail_prompt` 放在最末尾是行为需求，不假装它能命中缓存。每轮新追加的这一份属于本轮 suffix
成本；旧轮中的同名区块仍是前缀的一部分。

## 7. 读取型投影与 delta 协议

### 7.1 不复用 StatePatch

`StatePatch` 是 StateManager 的写命令，包含相对 amount、专用 op 和各实体自己的 target/value
契约。快照 diff 无法可靠反推出 transfer、delta 或 rename 等写入意图，因此不把它复用为
LLM 读取协议。

v1 定义只读、幂等的 `PromptStateProjection`。它只描述“现在是什么”，不描述“为何变成这样”。

### 7.2 最小操作集

delta 只有三种操作：

```ts
type PromptDeltaOp =
  | { op: 'set'; scope: string; owner?: string; name?: string; field: string; value: unknown }
  | { op: 'upsert'; scope: string; owner?: string; name: string; value: unknown }
  | { op: 'remove'; scope: string; owner?: string; name: string };
```

- `set` 用于标量字段，例如时间、位置、HP、好感度和普通变量。
- `upsert` 用于按名字寻址的完整集合元素，例如技能、物品、状态效果和任务。
- `remove` 用于删除按名字寻址的集合元素。
- `owner` 和 `name` 都是 AI 可见名称，不是内部 id。
- 同一 `(scope, owner, name, field)` 以 revision 最大者为当前值。
- 操作按固定 scope、owner、name、field 排序后用 JSON 序列化，保证字节稳定。

实现中 `scope` 是封闭联合类型，不接受用户自定义任意路径。上面的展示使用 `string` 只是简化
文档，正式类型必须列出 v1 实际支持的 scope。

> 📌 **2026-08-23 实施注记**：数据面仍只有 `set` / `upsert` / `remove` 三种 op，但实现额外加了
> 第四个 `rebase` **控制信号** op（`prompt-state-projection.ts` 的 `PromptDeltaOp` 联合）：
> NARRATIVE append cursor 检测到已表示消息被修改 / 删除 / 重排（或 previous/current 分属不同
> Agent）时，只返回 `{ op: 'rebase', reason }` 信号，**不产伪 delta**；该信号只给 session
> assembler 读，`renderPromptDelta` 收到即抛错，永不渲染进 `<context_delta>`。v1 投影 scope
> 封闭联合实为 14 个（推导依据与索引口径见 `prompt-state-projection.ts` 头部注释的映射表）：
>
> - `character` / `resource` / `inventory` / `skill` / `status_effect`
> - `quest` / `affection` / `variable` / `time` / `plot`
> - `map` / `lore_dynamic` / `memory` / `narrative`

### 7.3 投影粒度

- 角色基础字段与 hp/mp/sp 分开投影，资源变化不重发整名角色。
- 技能、物品和状态效果按 `(ownerName, elementName)` 整元素 upsert/remove，不细分元素内部字段。
- affection、变量、时间、位置和剧情进度使用标量 set。
- 动态世界书求值结果作为一个代码拥有的命名 block；结果变化时整块 upsert。
- 本轮玩家输入、上游 Agent 输出和随机事件候选属于 `turn_context`，不进入持久投影。

当前 template 或 story preset 决定某 Agent 看得见哪些占位符及其顺序。session module 从同一份
模板中提取占位符，并按代码拥有的四类清单处理：baseline-only、projection-backed、
append-cursor、ephemeral。
用户仍只编辑现有 template；这份分类不是第二种模板语言，也不允许配置。

嵌套对象必须按规范化内容比较，不能用对象引用 `!==` 判变化。数组先按逻辑名字归一化成 Map，
再做 add/update/remove；顺序变化本身不产生 delta，除非该集合的现有契约明确声明顺序有语义。

### 7.4 占位符分类

v1 对现有 registry 使用固定分类：

| 类别              | 占位符                                                                                                                                                           | 后续回合行为                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| baseline-only     | `SYS_PROMPT`、`LORE_BOOK_STATIC`                                                                                                                                 | 只存在于完整 baseline；原文或可见配置变化时重基线              |
| projection-backed | `CHARACTER_STATE`、`INVENTORY`、`SKILL_STATE`、`QUEST_STATE`、`GAME_TIME`、`MAP_CONTEXT`、`ACTIVE_EFFECTS`、`MEMORY_ENTRIES`、`PLOT_EVENTS`、`LORE_BOOK_DYNAMIC` | 从当前权威状态生成幂等 delta；富文本块可整块 upsert            |
| append-cursor     | `NARRATIVE`                                                                                                                                                      | baseline 按 `historyLayers` 播种；后续只追加尚未表示的持久消息 |
| ephemeral         | `USER_INPUT`、`RANDOM_EVENTS`、`RECENT_COMBAT`、`AGENT.*` 与链占位符                                                                                             | 每轮按 template 出现顺序放入 `turn_context`                    |

旧 template 使用未拆分的 `LORE_BOOK` 时，module 仍调用现有世界书分区结果：静态部分只留在
baseline，动态部分按 `LORE_BOOK_DYNAMIC` 处理。未注册占位符继续按现有规则原样保留在 baseline。

`NARRATIVE` 使用 `ChatMessage.id` 作为游标。后续上下文中出现新 id 时只追加新消息；已表示消息
若内容、角色或顺序变化，说明历史被编辑、删除或重排，必须重基线。`historyLayers` 只控制
baseline 建立时播种的最近窗口；会话存续期间的新消息持续累积，直到重基线重新收窄为最新窗口。

这是精确前缀复用带来的明确行为变化。它不由另一个“保留轮数”配置覆盖；上下文控制统一走
§8 的重基线规则。

### 7.5 世界书

世界书不能整体视为永久静态：

- `staticText` 进入首次完整 baseline。
- `dynamicText` 每轮按现有 EJS pass 求值；结果变化时作为固定 scope 进入 `context_delta`。
- 用户修改可见条目、enabled、order 或原文会改变 baseline signature，并触发重基线。
- EJS vars 草稿及提交权限继续使用现有 pass，不在 session module 内建立第二套状态。

## 8. 重基线与上下文上限

### 8.1 重基线触发

- 会话不存在或应用重载。
- baseline signature 改变。
- 最终失败、取消、流中断或手动重新生成。
- 同一会话出现重入。
- 已知上下文预算即将不足。
- 调用方显式清理某个存档。

### 8.2 正确重基线

重基线必须执行：

1. 丢弃旧 transcript 与旧 projection。
2. 从当前 `AgentContext` 调用现有完整渲染路径。
3. 保存当前 projection 作为新的 diff 起点。
4. 发送新的完整 baseline；本轮按冷请求计量。

禁止“清空 delta 后回到最初 baseline”，因为那会让模型状态回滚。

### 8.3 不猜模型上限

不同 endpoint/model 的上下文长度不同。v1 只增加可选的 endpoint 字段
`contextWindowTokens`，由使用者按实际 provider 配置；不维护内置模型能力表。

若该值存在，module 使用 provider 最近两次返回的 `prompt_tokens` 计算最近增长量，并在

```text
lastPromptTokens + max(0, lastGrowthTokens) + agent.maxTokens >= contextWindowTokens
```

时于下一轮重基线。若 provider 不返回 prompt token 或字段未配置，则不做不可靠的字符换算；
上下文错误沿用现有错误路径，并使本地会话失效，用户重试时从当前状态重基线。

## 9. 自定义边界

v1 只新增两个配置面：

- Agent `tailPrompt?: string`：每轮最新 user 消息末尾的一段文本。
- Endpoint `contextWindowTokens?: number`：可选的主动重基线依据。

不新增 `{{STATE_DELTA}}` / `{{TAIL_PROMPT}}` 占位符，不允许用户改 diff 操作、索引、排序或重基线
规则。现有 systemPrompt、story preset、template 和世界书继续负责首轮完整 prompt；delta 的协议
说明由 code 固定注入 baseline，避免形成第二个模板系统。

## 10. Agent 适用矩阵

| 路径                         | v1 行为                             | 理由                            |
| ---------------------------- | ----------------------------------- | ------------------------------- |
| 默认主 DAG、普通 chat        | delta session                       | 目标路径                        |
| story chatStream             | delta session，成功 complete 后推进 | 目标路径                        |
| memory_recall embedding      | 原路径                              | 没有聊天 prompt                 |
| toolsEnabled / chatWithTools | 原路径                              | 已有独立增长会话，语义不同      |
| combat_v3                    | 原路径                              | 战斗状态和工具会话独立          |
| char/item/craft/image 等侧链 | 原路径                              | v1 不承担参考轮次与并发语义     |
| 手动 regenerateAgent         | 无状态完整请求，并使旧 session 失效 | 防止替代回复混入正式 transcript |

侧链只有在主 DAG v1 达标后，凭新的 provider 证据另立设计；不得预先抽象“通用多会话框架”。

## 11. 测试与可观测性

### 11.1 通过 module interface 测试

- 首轮 system 与当前 `buildAgentMessagesAsync` 等价，首轮 user 只增加固定协议和可选 tail。
- 第二轮 wire messages 以前一轮请求和 assistant 响应为逐字节前缀。
- 同状态不产 delta；一个标量变化只产一个 set。
- 集合元素新增、修改、删除分别产 upsert、upsert、remove。
- 对象重新分配但内容相同不产 delta。
- 两个 Agent、两个 saveId 不串状态。
- 签名变化、失败、取消、重入和手动重生成触发正确重基线。
- 重基线 baseline 反映当前状态，而不是旧状态。
- 动态世界书重新求值一次且只进入本轮 block。
- `tailPrompt` 是最新 user 消息最后一个区块。

测试使用仓内匿名小 fixture，不依赖 `tests/realtime_export/`、私有内容仓、远端 API 或特定开发工具。

### 11.2 诊断

现有 Agent 日志增加最小字段：

- `promptSessionRevision`。
- `promptRebased` 与 reason。
- provider `prompt_tokens`（若有）。
- 现有 cache hit/miss/completion 字段继续保留。

不在 v1 建占位符级 profiler 或长期指标存储。

## 12. 已解决问题

| 原问题              | v1 裁定                                                    |
| ------------------- | ---------------------------------------------------------- |
| delta 最小单位      | 标量 set；命名集合元素整条 upsert/remove                   |
| 索引格式            | 结构化 scope/owner/name/field，不使用自由字符串路径        |
| 覆盖哪些变量        | 只覆盖主 DAG 当前可见的固定投影；scope 是代码封闭联合      |
| 每轮末尾提示词      | 单一 `tailPrompt`，固定在最新 user 消息末尾                |
| 可自定义程度        | 仅 tail 文本与 endpoint 上限可配；机制不可配               |
| 是否复用 StatePatch | 不复用；使用读取型幂等投影                                 |
| 何时重置            | 缺会话、签名变化、失败/取消/重入、手动重生成、已知预算不足 |
| 是否持久化          | 不持久化；重启后从当前状态冷建 baseline                    |
| 侧链是否纳入 30k    | 不纳入；报告时单列，后续凭证据另立范围                     |

## 13. 现状代码索引

- `src/sillytavern/agent-templates.ts`：现有完整 prompt 渲染入口。
- `src/sillytavern/agent-client.ts`：wire message 规范化、chat/chatStream 与 usage 解析。
- `src/sillytavern/agent-orchestrator.ts`：主 DAG 调用与成功/失败完成点。
- `src/sillytavern/types.ts`：AgentConfig、ApiEndpoint、AgentContext、AgentResult、默认 DAG。
- `src/sillytavern/placeholder-registry.ts`：占位符内容与 per-Agent 历史口径。
- `src/sillytavern/worldbook-loader.ts`：世界书 static/dynamic 分区与 EJS 渲染。
- `src/ui/lib/game-pipeline.ts`：每回合 AgentContext 组装、存档生命周期和调试日志。
- `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`：名字寻址与 StatePatch 契约。
