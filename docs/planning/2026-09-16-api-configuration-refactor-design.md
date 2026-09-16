# API 配置重构设计：多协议 LLM、Embedding、Reranker 与独立出图连接

> 状态：已实施（2026-09-16）；设置页宽屏与 390px 窄屏已浏览器走查，真实供应商与付费出图调用待验。
> 依据：本次用户需求及补充裁定；代码依据为 2026-09-16 当前工作区，包含已有未提交改动。
> 实施顺序见[已归档实施计划](../archive/planning/2026-09-16-api-configuration-refactor-plan.md)。
> 本文明确区分用户已确定的要求与建议方案；建议方案不代表用户已经逐项批准。

> 📌 2026-09-16 实施注记：T0—T7 已落地。三种 LLM 协议统一经适配器与受控 BFF；Gemini
> `thoughtSignature`、Claude 原生内容块及工具续接可无损进入 Delta/战斗会话；Dexie v25 完成
> 通用源、独立图像连接和迁移检查点；显式 Embedding/Reranker 召回与失败本地兜底已接线。

## 1. 需求与范围

### 1.1 用户已确定

1. 通用 API 配置管理常规文字 LLM、Embedding 模型、Reranker 模型。
2. LLM 支持 OpenAI 兼容、Google Gemini 原生、Claude Messages 原生三种接口。
3. 现有 `image`（图像生成）类型移出通用 API 池，在图像生成页面设置独立出图连接。
4. 每个 API 源允许配置自己的 JSON 请求体参数；**源自定义参数优先于 Agent 同名参数**。
5. ranker 指检索后的 Reranker，使用 `openai-rerank` 接口，与向量化模型共用 OpenAI 兼容的连接及鉴权方式。

> 📌 2026-09-16 用户补充裁定：初稿中的通用 `rerank` 协议名统一为 `openai-rerank`。Embedding 与 Reranker 复用连接配置、鉴权和传输实现，具体操作分别为 `/embeddings` 与 `/rerank`。

### 1.2 建议的首版边界

- OpenAI 兼容明确指 Chat Completions；Gemini 使用 `generateContent` / `streamGenerateContent`；Claude 使用 Messages。
- Embedding 首版使用 `openai-embeddings`（`/embeddings`）；Reranker 使用 `openai-rerank`（`/rerank`），两者采用同一套 OpenAI 兼容连接配置。
- 图像后端沿用现有 NovelAI、ComfyUI；本轮调整连接归属，不扩展新图像供应商。
- `image_prompt` 是生成图像提示词的文字 Agent，仍使用通用 LLM 源；真正出图走图像专用连接。
- 沿用一个源条目绑定一个用途、一个协议、一个默认模型的使用方式。同一地址和 Key 可建多条，分别配置模型或参数；RPM 仍共桶。
- 首版不引入来源与模型的多层管理系统、自动故障转移、负载均衡、Responses、Vertex AI、Bedrock 或 OAuth 登录。
- 本次交付为设计与实施计划；代码实施、真实付费调用及发布另行执行。

## 2. 现状与重构原因

以下是对当前工作区源码的核对结果，不沿用旧文件头部注释作为现状结论。

| 位置                                                                           | 当前行为                                                                               | 需要改变的边界                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `src/ui/components/settings/ApiSection.vue`                                    | 一张表单处理 chat、embedding、image；组件内拼连接测试请求                              | 表单按用途、协议变化，测试调用复用生产适配器     |
| `src/ui/stores/settings-store.ts`、`api-key-migration.ts`                      | `ApiEntry`、`StoredApiEntry`、`ApiEndpoint` 多次转换；localStorage 元数据与 Dexie 合并 | 统一类型及校验，防止新字段保存后被旧转换逻辑丢弃 |
| `src/sillytavern/types.ts`                                                     | `provider: string` 混合承载供应商与用途                                                | 分离 `kind` 与 `protocol`                        |
| `src/sillytavern/agent-client.ts`                                              | 非流式、SSE、工具往返均按 OAI 消息形状处理                                             | 独立协议编码、解码及原生会话保留                 |
| `server/routes/chat.ts`、`models.ts`、`embeddings.ts`                          | 固定 OAI 路径                                                                          | 增加原生协议路由及 Reranker 路由                 |
| `server/routes/proxy.ts`                                                       | 只转发 Bearer 与 `api-key` 等既有请求头                                                | 支持 Gemini、Claude 的认证及版本头               |
| `src/ui/components/settings/agent/AgentParamsCard.vue`                         | 所有 API 池条目都能进入 Agent 选择器                                                   | 按用途过滤，运行时也校验类型                     |
| `src/ui/components/settings/image/ImageRenderCard.vue`、`scene-image-seams.ts` | NovelAI 从通用池读取 `imageNovelai.endpointId`                                         | 改为查询图像连接存储                             |
| `src/sillytavern/agent-orchestrator.ts`                                        | `memory_recall` 根据模型名含 `embedding` 或运行时 `apiType` 切分支                     | 使用显式召回模式与类型化绑定                     |
| `src/ui/lib/game-pipeline.ts`、`MemorySection.vue`                             | 写入向量使用 `embeddingEndpointId`，界面没有该字段的选择器                             | 统一查询与写入端点，补齐配置入口                 |
| `src/sillytavern/memory-store.ts`                                              | 已有向量空间指纹、余弦召回、重要度兜底；没有 Reranker 调用                             | 保留向量隔离，增加候选重排步骤                   |
| `prompt-session-assembler.ts`、`combat-v3/agent-session.ts`、`coordinator.ts`  | Delta 与战斗会话保存消息；战斗有工具往返重建                                           | 避免重建时丢失 Gemini/Claude 原生块及签名        |

另外，当前 `AgentClient.buildRequestBody()` 固定补入采样参数、输出上限和 `user_id`；参数自定义必须覆盖真正发出的请求，而非只增加一个未接线的 JSON 编辑框。

## 3. 配置模型

### 3.1 用途与协议分开

| UI 用途   | `kind`       | 首版允许的 `protocol`                         | 消费方                                           |
| --------- | ------------ | --------------------------------------------- | ------------------------------------------------ |
| 文字 LLM  | `llm`        | `openai-chat`、`gemini`、`anthropic-messages` | 普通 Agent、战斗两角色、捏人侧链、`image_prompt` |
| Embedding | `embedding`  | `openai-embeddings`                           | 记忆文本写入及查询向量                           |
| Reranker  | `reranker`   | `openai-rerank`                               | 检索候选重排                                     |
| 图像生成  | 独立图像配置 | 现有图像 provider                             | 出图管线                                         |

协议由用户显式选择，不从域名、模型名称或 Key 前缀猜测。Gemini 模型通过中转商的 OAI 接口调用时，协议应选 `openai-chat`。

建议的核心类型轮廓（最终定义放在引擎 `types.ts` 或其 `types-api.ts` 分册）：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type ApiSource = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: string[]; // 模型列表缓存，不是可用性的权威名单
  timeoutMs: number;
  bodyOverrides: JsonObject;
  bodyOmitPaths: string[]; // JSON Pointer，见 §4
} & (
  | {
      kind: 'llm';
      protocol: 'openai-chat' | 'gemini' | 'anthropic-messages';
      contextWindowTokens?: number;
    }
  | { kind: 'embedding'; protocol: 'openai-embeddings' }
  | { kind: 'reranker'; protocol: 'openai-rerank' }
);
```

`maskedKey` 从 Key 派生，不作为第二份权威数据。用途、协议、URL、模型和 JSON 都经过同一入口校验；未知新值不静默归成 LLM。

### 3.2 存储与写入口

建议继续使用 Dexie `apiEndpoints` 表保存通用源，保留原 ID，但将行结构升级成 `ApiSource`。增加 `imageApiConnections` 保存 NovelAI 命名连接，增加设备本地 `apiConfigMigrations` 保存迁移版本和跨存储清理进度。

- 新 `api-source-store.ts` 拥有初始化、CRUD、图像连接与凭据引用枚举；底层数据库函数仍在引擎层。
- 新配置的完整权威记录只存 Dexie；settings store 可以临时提供只读 `apiPool` 投影，让调用方逐批迁移。
- 普通 localStorage 设置保留绑定 ID、召回模式和图像生成参数；不再保存完整 API 条目副本。
- UI 的编辑草稿不直接绑定持久对象，点击保存后校验并事务写入；失败时保留输入。
- 源记录和图像连接都属于设备本地数据，遵循 SEC-01：不进入普通整库或单档备份，导入旧备份也不覆盖本机连接。
- 自定义请求体可能含供应商敏感信息，与连接记录采用同样的存储及导出边界；调试日志默认只记录参数路径和脱敏摘要。

### 3.3 绑定与类型检查

- 普通 Agent 只可选择 `kind: llm`；绑定失效或用途错误均返回明确错误，不回落到另一个源。
- 未绑定 Agent 的默认选择沿用现有规则，但默认候选只从 LLM 中取。
- 保留当前“用户显式选择”和“内容包默认引用”的来源区别；内容包失效引用的可见回退仍局限在 LLM 候选内。
- 首版保留 `agents[id].model` 实际存源 ID 的历史存储键，通过命名清晰的 resolver 接口解释；不要顺带修改内容包格式。
- Embedding 与 Reranker 分别由记忆设置绑定；运行时再次检查用途。
- 编辑已被引用源的用途时，显示受影响的绑定并要求先解除；删除后保留失效引用的提示，不能静默换源。

## 4. 每源请求体参数

### 4.1 合并契约

用户已裁定：源自定义参数优先。建议统一处理顺序为：

```text
协议默认值 + Agent/调用方参数
  → 协议映射，形成原生请求体
  → 深合并源 bodyOverrides
  → 删除 bodyOmitPaths 指定的可选字段
  → 校验最终结构和协议约束
  → 派生实际输出预算、配置签名与脱敏预览
  → RPM 排队 → 真实发送
```

- 对象递归合并；数组整体替换；标量整体替换。
- `null` 是要发送的 JSON 值，不表示删除；删除使用 `bodyOmitPaths`，避免语义混淆。
- 省略路径采用 JSON Pointer，例如 `/frequency_penalty`、`/generationConfig/topP`；首版不支持数组内部元素删除。
- 用户填写供应商原生字段：OAI 用 `temperature`，Gemini 用 `generationConfig.temperature`，Claude 用 `temperature`。
- 未知供应商扩展字段允许透传；本地只保证 JSON、受保护字段和已知协议约束，不宣称能验证所有中转扩展。
- 拒绝对象任意层的 `__proto__`、`constructor`、`prototype` 等危险键；采用不修改原对象的合并实现。

例：Agent 的温度为 `0.7`，OAI 源保存 `{"temperature": 0.2}`，最终发送 `0.2`。Gemini 源应保存 `{"generationConfig": {"temperature": 0.2}}`。

### 4.2 结构字段的建议边界

“源参数优先”用于可自定义的生成和检索参数。以下运行时结构建议在编辑器明确标为保留字段，冲突时报错，不能悄悄覆盖后再改回来：

- LLM 输入：`messages`、`contents`、`system`、`systemInstruction`、会话原生块。
- 调用身份与传输：`model`、`stream`、鉴权字段、供应商路由；模型在源的专用模型框配置。
- 工具权限：`tools`、`tool_choice`、`toolConfig`；这些来自当前调用允许的工具集，尤其涉及战斗角色隔离。
- Embedding 输入 `input`；Reranker 输入 `query`、`documents`。
- 改变响应结构的多候选设置首版只允许单候选；例如 OAI `n` 与 Gemini `candidateCount` 必须为 1。

温度、输出上限、停止词、thinking/reasoning、维度及 `top_n` 等非结构字段可以由源覆盖。原生模型不支持某 Agent 参数时，应在 UI 提示不适用，适配器不发送该参数。已知互斥或非法组合在发送前报错，不静默钳制用户参数。

**输出预算也使用覆盖后的实际值**：例如源将 `max_tokens` 改小，Delta 预算检查不能继续读取旧 Agent 值；无法可靠解读扩展字段时，主动预算判定标为不可用，不把未知当 0。

### 4.3 编辑体验

每个源提供“自定义请求体参数”JSON 编辑器、可选省略字段、格式校验、重置、使用当前草稿测试。提供按协议的简短示例，不默认写入未经用户选择的 thinking 或供应商扩展。

Agent 参数区保留用户原设置，旁边标明哪些参数被源覆盖或省略，并显示实际值。预览说明是示例请求还是当前调用的脱敏结果，避免用户误以为测试输入会参与正式对话。

## 5. 三种 LLM 协议适配

### 5.1 适配器职责

建议新增引擎 `api/` 目录，使用统一入口执行：源解析、参数处理、协议编码、请求、响应解码。`AgentClient` 保留业务调用、重试、取消、工具执行调度职责，供应商细节交给适配器。

| 协议                 | 基础 URL 示例                                      | 请求形式                                                              | 特有内容                                                                             |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `openai-chat`        | `https://api.openai.com/v1`                        | `/chat/completions`                                                   | `messages`、`tool_calls`、OAI SSE                                                    |
| `gemini`             | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:generateContent` 或 `:streamGenerateContent?alt=sse` | `contents`、`systemInstruction`、`generationConfig`、`functionCall/functionResponse` |
| `anthropic-messages` | `https://api.anthropic.com/v1`                     | `/messages`                                                           | 顶层 `system`、内容块、`tool_use/tool_result`、Messages SSE                          |

基础 URL 已含版本前缀，代码只拼协议后缀。表单展示最终 URL，避免重复 `/v1` 或把完整生成路径再次追加。Gemini 模型资源名由适配器规范化，禁止将模型字符串当任意 URL 路径。

这些是官方协议的形状；OAI 兼容服务不保证接受 OpenAI 的所有可选参数。依据：[OpenAI Chat Completions](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions)、[Gemini GenerateContent](https://ai.google.dev/api/generate-content)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)。

### 5.2 不能只统一纯文本

内部消息需要表达文本、工具请求、工具结果，以及不透明的供应商原生续接数据。建议统一业务消息结构，同时在每次 assistant 结果附带协议标识、原始有序内容块和必要签名；原生内容只交回对应协议适配器。

- Gemini 返回的 `thoughtSignature` 要随原始 part 保留及回传，不能在提取函数名后丢弃或重组。依据：[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。
- Claude 的 thinking/signature、tool_use 和 tool_result 必须保留相应块和关联 ID；工具续接不能只回填展示文本。依据：[Claude thinking](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models)。
- 工具调用参数只在完整解析和校验后执行；流中断、残缺 JSON 或未知工具不得作为空参数执行。
- `chatWithTools` 返回可续接的消息增量。战斗协调器保存该增量，不再仅靠工具执行日志人工重建 OAI transcript。
- 主持人与敌方继续隔离历史、工具和原生续接状态；调试用工具日志不能成为第二份会话真源。
- 不支持等价映射的强制工具选择或 schema 必须明确失败，不能降级成 `auto` 后假装满足调用要求。

### 5.3 流式输出与使用量

三个适配器分别解码原生事件，向现有 UI 提供统一的文本增量、可见思考增量、完整工具调用、使用量与结束状态。HTTP 200 之后仍可能收到流内错误，应正常进入失败路径。Claude 事件块结构见 [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)。

共同验收：跨 chunk 的 UTF-8 与 JSON、多行 SSE、取消、断流、结束事件后 usage、工具参数片段、重复结束事件。每个 provider 的原始结束原因同时保留，统一区分正常、工具请求、截断、拒绝/阻断及错误。

使用量按供应商含义映射；缓存读取、缓存写入、输入、输出不能混算。未返回的统计保持未知。原生流和非流式共用同一参数合并入口；保留现有 OAI 中转兼容测试作为基线。

### 5.4 Delta 与配置变更

现行 Delta 文档的“无需 provider adapter”和 OAI wire messages 假设由本设计实施阶段修订，正确性要求继续成立：实际送出的历史前缀稳定、成功后才推进、失败不污染会话。

- 逻辑 Delta 状态仍由 assembler 独占；原生编码由适配器确定性完成，不能有两处独立追加会话。
- 保存实际序列化输入及原生 assistant 续接内容，检查同协议下前缀稳定，而不只检查中间表示。
- 基线签名增加协议、规范化 URL、默认/实际模型、请求体覆盖与省略配置、适配器版本；内部连接修订号覆盖 Key 变化，不把完整 Key 写入签名或日志。
- 保存配置时，已经开始的一次工具调用循环及其重试使用同一配置快照。下一次业务调用读取新配置并重建基线。
- 战斗会话在安全的决策边界处理变更：保留 Kernel 事实，从当前授权投影重建模型上下文，不把旧签名转发给新协议。

## 6. BFF、鉴权和连接测试

### 6.1 BFF 路由

继续使用当前 Hono BFF。建议增加受控的 `/api/llm/{protocol}/generate`、`/api/llm/{protocol}/models` 与 `/api/rerank`；现有 OAI 路由可在迁移期作为入口别名。

- BFF 根据封闭协议、操作枚举生成上游后缀；Gemini 只放行校验过的模型资源名、流式标志、分页 token。
- 复用 `forward()` 的主机校验、元数据地址拦截、拒绝重定向、响应头清理和 SSE 透传。
- OAI 默认 Bearer；Gemini 使用 `x-goog-api-key`；Claude 使用 `x-api-key` 和 `anthropic-version`。首版保留必要的既有 `api-key` 兼容能力，鉴权方式必须可明确表达，不靠“试错换鉴权”发出隐蔽第二枪。
- Claude 协议版本及可选 beta 头作为协议设置单独配置，不能塞进请求体；只开放明确允许的头，不建立任意头透传器。
- 将前端取消传递到上游 fetch；流中断释放 reader。BFF 不缓存密钥，不把密钥写进 URL。

Gemini 密钥使用依据见 [API keys](https://ai.google.dev/gemini-api/docs/api-key)，Claude 版本与鉴权头见 [Messages API](https://platform.claude.com/docs/en/api/messages/create)。

### 6.2 列模型与测试

- 列模型按协议解析并处理分页；模型列表不可用时允许手填，不代表生成失败。参考 [Gemini models](https://ai.google.dev/api/models)、[Claude models](https://platform.claude.com/docs/en/api/models/list)。
- 测试使用编辑草稿的同一协议适配器、参数合并和 RPM 路径。模型已手填时无需先拉模型列表，也不能自动换成列表首项。
- LLM 测试用短文本，默认不带工具；需要工具能力时另有明确的工具测试。Embedding 验证非空合法向量；Reranker 验证索引和有限分数。
- 源显式配置的输出上限或 thinking 参数仍生效，测试页展示实际参数与可能产生调用费用的说明，不能用固定 `max_tokens: 1` 破坏合法配置。
- 修改地址、协议、Key、模型或参数后，旧测试结果失效；保存不要求远端成功，但表单本地校验必须通过。

## 7. Embedding 与 Reranker 接线

### 7.1 记忆设置的明确选择

新增显式 `memoryRecallMode: 'llm' | 'embedding'`，以及 `embeddingSourceId`、`rerankerSourceId`（空表示关闭重排）。首版保留旧 LLM 召回模式；Reranker 作为 Embedding/基础候选检索后的可选步骤，不默认增加远端调用。

- LLM 模式：保留 `memory_recall` Agent 的语义和配置。
- Embedding 模式：写入和查询使用同一个 Embedding 源解析器及配置快照；不再根据模型名称切换模式。
- 用途或绑定失效：不发送到其他远端源，按既有非致命记忆策略给出诊断并走本地重要度/时间兜底。
- 新用户默认保留 LLM 模式；旧配置的模式迁移见 §10。
- Reranker 未配置或关闭时，保留原有候选顺序；用户取消后立即结束，取消不能触发继续重排。

### 7.2 Reranker 契约和候选流程

协议标识为 `openai-rerank`，与 `openai-embeddings` 共用基础 URL、API Key、默认模型、自定义请求体参数的配置方式，以及 Bearer 鉴权、超时、取消和 RPM 传输实现。各源仍保存自己的模型与请求体参数；相同基础地址和 Key 的源共享 RPM 桶。

首版请求：`POST {baseUrl}/rerank`，Bearer 认证，`{ model, query, documents: string[], top_n? }`。Embedding 对应 `POST {baseUrl}/embeddings`，输入为 `{ model, input }`。两者复用连接与传输层，分别编码请求、解析响应。Reranker 响应要求 `results[]` 包含原始文档 `index` 和数值 `relevance_score`，供应商额外字段可忽略。

`openai-rerank` 是本项目对该兼容接口的协议命名，字段形状参考 [SiliconFlow Rerank](https://docs.siliconflow.com/en/api-reference/rerank/create-rerank)。

```text
当前存档记忆
  → 同向量空间召回，缺项按原有重要度/时间规则补候选
  → 取 candidateCount 条候选（可配置，必须 ≥ 最终召回条数）
  → 可选 Reranker
  → 最终最多 memoryRecallCount 条
  → 沿用当前记忆输出与注入通道
```

建议默认 `candidateCount` 为最终召回数的 3 倍、最多 100 条；这些是待验收的产品默认值，不是上游协议限制。请求还需总文本预算，超过预算按已公开的候选裁剪规则处理，不能无限提交全部记忆。

- 原始 `index` 映射到本地候选；不得信任服务商返回的文档文本替换本地记忆。
- `index` 重复、越界、非整数、非有限分数或空异常结果视为重排失败；保留原候选顺序并记录降级原因。
- 合法部分结果先按重排顺序使用，再按原候选顺序补齐缺额；源 `top_n` 可覆盖默认请求值，最终注入仍受 `memoryRecallCount` 约束。
- Reranker 超时、429、网络失败不切换服务商；首版单次尝试，失败本地回退，避免检索重试拖住每轮剧情。
- 重排分数是独立的 `rerankScore`，不混充余弦分，不跨供应商直接比较绝对分数。
- 候选只来自当前存档、沿用已有可见性边界；Reranker 不扩大能看见的记忆集合。

### 7.3 向量空间兼容

当前已有 `embeddingMeta.spaceId`。自定义维度、归一化或其他影响向量内容的参数必须计入空间身份，不能出现“参数改了但同维度就继续混算”。

建议空间版本升级时纳入协议、部署地址、实际模型、实际维度、预处理版本和稳定序列化的非输入配置指纹；Key 变化不改变向量空间。查询/文档任务标签若不同，必须作为同一配对配置建模，不能将角色差异误判为两个完全不兼容空间。

首版只提供共享 body 配置；需要不同 query/document 参数的服务暂不声明支持。存量默认 OAI 配置能够证明等价时保留旧空间兼容；有新增影响参数则建立新空间。旧向量保留但不参与不兼容余弦计算，沿用本地兜底；保存配置不自动触发全库付费重嵌入。

## 8. 图像生成连接独立

图像生成页面增加“API 接口设置”卡，随 provider 显示：

- NovelAI：命名连接、API Key、当前选择和 RPM；官方生成地址沿用常量，模型仍在出图参数区设置。
- ComfyUI：将现有本地地址设置归入这张卡，工作流及出图参数继续归现有 provider 设置。
- 旧用户的多个 NovelAI 连接全部保留，可在图像页切换；不为了只显示一个输入框丢掉其他密钥。
- `imageNovelai.endpointId` 首版保留原字段和值，但只解释为 `imageApiConnections` 的 ID；通用源选择器不再出现图像条目。
- `scene-image-seams` 接收已解析的图像连接，删除对通用 `apiPool` 的依赖。
- `image_prompt` 面板复用 LLM 源选择器，与实际出图连接清晰分区。
- 普通保存和迁移不生成图片。NovelAI 沿用明确的手动出图验证，不能把不支持的 `/models` 或 `/chat/completions` 当作连接测试。

图像去重、自动档不追溯生成、付费额度、七态显示、方言与角色预设均沿用已有契约。

## 9. RPM 与跨页面保存

API 配置页继续保留全局凭据 RPM 面，枚举通用源和独立图像连接；图像页的 RPM 编辑是同一策略的另一个入口，标明共用该凭据的连接名称。

- 身份仍是归一化基础地址 + Key，与用途、协议、模型无关；不同基础路径继续分桶。
- 连接测试、列模型、LLM 每次重试及工具轮次、Embedding、Reranker、NovelAI 都走同一发送调度器；ComfyUI 沿用现有例外。
- 迁移 NovelAI 时保留实际使用的常量地址；必要时显式迁移旧凭据指纹，不能因换页丢失策略。
- orphan 检查必须同时枚举通用和图像连接，删除一侧不能误删另一侧仍使用的策略。
- 将整表覆盖保存改为按变更凭据事务更新，避免 API 页和图像页分别加载的旧草稿覆盖对方修改。
- 地址/Key 修改及 RPM 迁移在同一写入口内处理；目标凭据已有策略时保留目标策略并可见提示。
- 保留 ADR-34 的 FIFO、溢出后等待 60 秒、排队不计网络超时、取消清理规则。

## 10. 迁移与恢复

当前 `DB_VERSION = 24`（2026-09-16 从 `database.ts` 实测）。实施时重新检查最新版本再选择下一版，不能直接按早期文档的 v23 写迁移。

### 10.1 确定性映射

| 旧数据                                        | 新数据                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `apiType: chat` 或经旧版本规则确认的缺省 chat | `kind: llm` + `protocol: openai-chat`                                        |
| `apiType: embedding`                          | `kind: embedding` + `protocol: openai-embeddings`                            |
| `apiType: image`                              | 同 ID 迁入 `imageApiConnections`，provider 为 NovelAI                        |
| `ApiEntry.model`                              | `ApiSource.defaultModel`                                                     |
| 旧 Agent 的池 ID                              | ID 原样保留                                                                  |
| 旧 source 无自定义 body                       | `bodyOverrides: {}`、`bodyOmitPaths: []`                                     |
| `imageNovelai.endpointId`                     | 值不变，查找目标改为图像表                                                   |
| `embeddingEndpointId` / `embeddingModel`      | 合并到统一 Embedding 绑定；覆写模型不相同时保留为独立迁移出的 Embedding 配置 |

不能用域名猜原生协议：现有 Claude/Gemini 名称的中转地址也按旧 OAI 行为迁移，由用户之后切换。

记忆模式的旧判断仅在迁移器中复现一次：若旧 `memory_recall` 已走 Embedding 分支，则迁到显式 Embedding 模式。若与写入端的 Embedding 地址/模型冲突，保留两份源并展示迁移待选择状态，选择前只使用本地兜底；不擅自为用户选择新的付费服务。普通 LLM 模式原样保留。

### 10.2 跨存储步骤

1. 阻止尚未水合完成的配置用于发请求，读取旧 localStorage 和 Dexie；按现行密钥迁移规则恢复完整数据。
2. 在内存中校验全部目标行和引用，生成稳定的 ID 映射；旧 ID 不重新生成，派生条目 ID 通过迁移记录稳定复用。
3. 在一个 Dexie 事务中写新通用行、图像行、必要的 RPM 调整及迁移记录，完成后校验关键字段。
4. 新读取器依据迁移记录使用新表。此时旧 localStorage 即使尚未清理，也不能再被旧合并函数导回并复活已删除的连接。
5. 将非敏感绑定/模式补丁写入 localStorage，清除旧 `apiPool`；成功后标记清理完成。清理失败可重试，不重复迁移、不覆盖迁移后用户编辑。
6. 所有凭据可靠落库前不清除唯一旧副本。事务失败显示迁移错误并允许重试，不启动半迁移配置的远端调用。

新 schema 落地后的代码回退必须理解该 schema；不承诺直接运行旧二进制可自动降级。普通游戏备份不含 API 凭据，不能当作凭据回滚副本。迁移失败优先前向修复，任何凭据备份都需专门的本机敏感数据路径。

## 11. 页面组织建议

| 页面       | 配置内容                                                                              |
| ---------- | ------------------------------------------------------------------------------------- |
| API 配置   | LLM / Embedding / Reranker 分类，源列表，编辑草稿，全局 RPM                           |
| 源编辑     | 名称、用途、协议、基础地址、Key、默认模型、超时、LLM 上下文窗口、自定义 body 与省略项 |
| Agent 配置 | 仅 LLM 源；Agent 采样参数与源覆盖结果提示                                             |
| 记忆与缓存 | LLM / Embedding 召回模式、Embedding 源、可选 Reranker 源、候选数、最终召回数          |
| 图像生成   | 独立 API 接口设置、现有提示词 Agent 设置、出图参数与视觉预设                          |

沿用 `docs/design.md` 的组件、主题 token、表单间距和可访问性规则。JSON 编辑放高级区；协议名称、最终地址、实际模型和测试结果保持普通用户可读。暂不在本设计阶段进行视觉重绘。

## 12. 旧契约的变更登记与验收

实施时在以下文档追加带日期的更正，不能在尚未实施时改成“已完成”：

| 文档                                         | 需要更新的约定                                               |
| -------------------------------------------- | ------------------------------------------------------------ |
| 图像 v1 §11、ComfyUI v2 C16                  | NovelAI 凭据改由图像页独立存储，保留固定地址与 provider 分工 |
| RPM 设计 §6、§8                              | 凭据来源包含两张连接表，跨页面局部更新与引用检查             |
| Delta 架构 §3—§5、§8                         | 原生序列化、续接数据、参数签名及实际输出预算                 |
| 数据字段规范 §1、§9                          | 新设备本地表身份、备份排除与向量空间兼容说明                 |
| 两份源码 `AGENTS.md`、`docs/ARCHITECTURE.md` | 实际模块归属与单向分层                                       |

完成判据是：三种 LLM 协议分别通过普通、流式、工具续接及会话回归；Embedding 写入查询一致；Reranker 能重排且失败可回退；出图连接与通用配置分离；用户原有连接和绑定可迁移；覆盖参数真正反映在发包、预算和 UI 中。具体阶段与验证矩阵见已归档实施计划。

> 📌 2026-09-16 验收记录：协议编码/解码、SSE、原生工具续接、迁移幂等、用途绑定、向量空间、
> Reranker 与非致命回退均有自动化覆盖；API、记忆和图像设置在宽屏及 390×844 视口完成浏览器走查。
> 未使用用户凭据执行真实 OpenAI、Gemini、Claude、Embedding、Reranker、NovelAI 或 ComfyUI 请求，
> 因而真实供应商兼容性、付费调用和实际出图继续明确标为待验。
