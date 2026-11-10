# 直出（缓存优化）v1

状态：2026-11-10 已实施于 `direct-generation-cache-v1`，基于 `direct-generation-v1`。本地自动化与浏览器建档/配置入口已验证；自动化使用模拟模型，真实模型叙事、供应商缓存命中与账单尚未验证。

## 使用

1. 在「设置 → Agent 配置 → 直出主生成（缓存优化）」选择 API 来源、模型参数和预设。首次初始化复制无缓存直出的有效配置，此后独立调整；默认预设为「直出 · 缓存优化」。
2. 「渠道缓存支持」默认选通用稳定前缀。仅在渠道明确支持时，选择 Claude Messages 原生缓存或 OpenAI 显式断点。Gemini 使用通用策略和渠道隐式缓存。
3. 新建存档，在准备页主动选择「直出（缓存优化）」。存档写入 `metadata.generationMode = 'direct_cached'`；确认页、存档界面沿用统一模式标签。创建后不能切换模式。
4. 正常聊天。原生角色、地图、库存、战斗和制作继续使用[直出共用契约](direct-generation.md)。开发者调试面板可查看会话轮数、重建原因及渠道用量。

旧档无标签仍按 Agent 运行。缓存主生成的配置键为 `direct_cached`，执行与世界书权限身份仍为 `direct_main`，无需另授一份世界书读取权限。

## 请求与记忆

每次生成尝试最多一次非记忆主请求。没有预热、显式创建供应商缓存、工具、自动修复、自动重试或失败降级请求。手动重试是新一次生成尝试。

记忆回溯、摘要、补建和归档保留原流程与预算，不承诺整楼只有两次请求。缓存会话内暂留原文与当时的召回内容，最新召回只追加到当前轮；重建时重新读取记忆，并按原有历史窗口折叠。记忆更新本身不会要求每楼重建主会话。

## 上下文契约

首次请求包含固定输出协议、文风与静态前缀、当前记忆基线，以及当前完整状态和输入。后续请求保持已接纳的请求与原始回复不变，末尾追加：

- `direct_context.set`：变化的顶层状态整块替换。人物、背包、地图等均为绝对快照，不把差异误当成追加物品或数值增量。
- `direct_context.remove`：明确删除已不存在的顶层状态。
- 每轮重新确认当前战斗与人物资源；当前 app 状态优先于历史回复中的声明。
- `turn_context`：本轮玩家输入、最新召回、尾部指令和新骰池。骰池项为 `[骰面数, 骰值]`，索引和原有随机抽样规则不变；旧轮骰子不能再次使用。

模型仍输出一次完整正文、角色更新和 `direct_updates`。只有核心状态与来源消息的事务接纳后，才将本次请求和原始 assistant 回复追加到缓存。Gemini/Claude 原生 assistant 签名按现有适配器保留。解析、状态事务、取消或过期任务失败不会推进缓存。

普通内置预设把引擎追加的动态上下文移到末尾。自定义模板或包含宏的旧预设保留作者布局；动态值仍位于前缀时会触发重建，缓存收益可能较低。Story v2 复用五区装配与单次 EJS 渲染，记忆区进入可折叠基线；普通前置条目仍保留，动态字节改变时重建。不会自动改写用户预设。

## 重建与持久化

以下情况重新建立完整基线：

- 一段会话已接纳 8 次主生成，第 9 次重建。
- 累积上下文字符量超过当轮完整基线的 1.4 倍。
- 预计输入加输出预留超过端点配置窗口；若完整基线仍超限，则在请求前停止并提示缩短历史或调整输出预算。估算采用现有字符口径，不是真实 tokenizer。
- 模型、端点版本、请求体参数、文风/预设、记忆窗口、世界书内容或激活集合变化。
- 历史原文被编辑/截断，回退或内容授权变更使会话失效；缓存记录不存在或协议版本不符。

原文可能比记忆窗口多保留至多一段缓存会话。重建是本地装配，不产生额外 API 调用。

缓存使用既有 `promptSessions` 表，键为存档 ID 加 `direct_cached`，记录协议为 `direct-cache-v1`；与 Agent Delta 的记录独立。普通本地内容可刷新后恢复；缓存写入失败不撤销已接纳游戏状态。删档、回退、清理内容包复用既有失效和清理流程。

缓存不进入整库或单存档备份。Discord 受保护内容仅在当前页面内存保留，不读写磁盘提示词缓存。数据库版本升为 32（无数据改写），利用既有前向版本检查阻止旧 app 导入新模式后将其误当 Agent。

## 渠道适配与诊断

| 策略 | 发出的缓存参数 |
| --- | --- |
| 通用稳定前缀 | 无供应商专属参数，兼容渠道自动缓存与 Gemini 隐式缓存 |
| Claude Messages | 静态 system 块断点与自动会话 `cache_control`，必须使用对应协议 |
| OpenAI 显式断点 | `prompt_cache_key` 与消息 `prompt_cache_breakpoint`，必须使用支持这些字段的 Chat Completions 渠道 |

不根据模型名或 URL 猜测兼容性；不支持字段的渠道可能拒绝请求，需要手动改用通用策略。端点的高级请求体覆盖/省略继续生效，修改后重建会话。

调试面板区分缓存读、缓存写、普通输入、总输入和输出；渠道缺字段时显示「渠道未提供」，不显示假零。Claude 的总输入由普通输入、缓存读取和缓存写入相加，信息不足时保持未知。其他协议在已知总输入及读取数时计算普通输入。会话复用只说明本地前缀稳定，不证明供应商命中、延迟下降或费用节省。

参数契约参考：[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Gemini caching](https://ai.google.dev/gemini-api/docs/caching)。

## 实现和验证

- `src/core/prompts/direct-context-session.ts`：准备、接纳、失效、Delta 与重建。
- `src/core/prompts/direct-context-frame.ts`：旧记忆布局；`story-context-v2.ts` 提供 v2 缓存帧。
- `src/core/prompts/direct-context-store.ts`：可丢弃的持久化记录及受保护内容门。
- `src/core/api/prompt-caching.ts`：显式供应商策略和缓存模式专属用量口径。
- `src/core/agents/direct-main.ts`、`src/ui/lib/game-pipeline.ts`：单请求、既有输出校验和事务接纳后的缓存提交。

运行与全部检查命令见[直出模式](direct-generation.md#实现与验证)。重点回归覆盖前缀复用、原生回复签名、取消后迟到接纳、历史修改、预算和第 9 次重建、自定义宏布局、缓存恢复与备份排除、独立配置，以及两种记忆下的连续资源/制作/战斗与失败不重复结算。Agent 与无缓存直出仍运行原有回归。
