# 实施计划：Agent 重试次数可配置化（2026-08-16）

> 需求：Agent 流报错默认自动重试 3 遍，仍失败再报错；重试次数可在设置页配置。
> 现状：`AgentClient.chat()` 循环重试 1 次（`config.retryOnFail ? 1 : 0`，恒 1）；`chatStream()`（story 走这条）**零重试**；次数不可配置。

## ✅ 实际执行情况（2026-08-16 当日完成）

按计划全部实施完毕，8556 tests 全绿 + typecheck/lint 干净。与计划的偏差与追加发现：

1. **chatStream 重试清预览的实现**：重试前调 `onChunk('', true)`，game-pipeline 的 streamCallbacks 收到 `isComplete && text===''` 时重置 `streamedRaw`——把「重试重置」与「正常收尾清理」统一成同一条语义。
2. **abort 短路是双重的**：chat 循环 `signal?.aborted` break；chatStream 除 `outcome.kind === 'aborted'` 外，**信号已 aborted 时无论本次错误来源都立即停**（网关在取消瞬间仍可能返回 4xx/5xx，此时 outcome 是 'error'——取消的语义是「用户不想等了」，与错误来源无关）。
3. **测试踩坑**：`mockStreamingFetch` 返回的是 **fetch mock 本身**（设计为直接赋给 fetch），当作 response 返回会让 `await vi.fn()` 拿到函数对象、`res.body` undefined——第二次尝试必然失败（调试过程用独立复现文件定位）。
4. **顺带修复 settings-store 幽灵快照复活（真实产品 bug，测试驱动定位）**：`saveNow` 加 `bootTaskCancelled` 检查；测试补「$dispose 后换活跃 pinia」并改断言对象。详情见 CHANGELOG 同条目。

## 位置决策

重试逻辑放 **AgentClient 层**（chat 已有循环、chatStream 补循环），次数经 `AgentConfig.maxRetries` 数值字段注入。
**不放 orchestrator 层**——会与 chat 内部重试叠加（3×2=6 次请求）。

## 改动清单

### 1. AgentClient（agent-client.ts）

- `chat()` 循环：`maxRetries` 读参数（默认 1 → 保持），**AbortError 短路**（`signal?.aborted` → break，修现存「取消后白重试+白等退避」bug）。
- `chatStream()`：重构为 `streamOnce()`（单次流式会话）+ 外层重试循环：
  - 成功 → onComplete；外部 abort → onError('Request aborted') 立即返回；可重试错误且 attempt < maxRetries → **先 `onChunk('', true)` 清玩家可见预览**（与 game-pipeline 的「isComplete 清理临时预览」同一条语义），退避 `2^attempt` 秒后重试；超限 → onError。
  - 超时（streamTimeout abort）**可重试**（外部 signal 未 aborted）；外部 abort 不可重试。

### 2. AgentConfig（types.ts）

- 加 `maxRetries?: number`（缺省 = 1，兼容现状）。`retryOnFail` 布尔保留（false = 0 次；true 且未设 maxRetries = 1 次）。

### 3. 设置接线五处（缺一处即静默失效，Q-18 纪律）

| #   | 位置                                                   | 改动                                                                                                                                                        |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `data/defaults/agent-config.json`                      | 各 agent 的 12 键 → 13 键，加 `maxRetries`（默认 3）                                                                                                        |
| 2   | `src/ui/stores/agent-settings.ts`                      | `AgentSettingsEntry` 加键 + `AGENT_SETTINGS_DEFAULTS` 加 `maxRetries: 3`                                                                                    |
| 3   | `src/ui/lib/game-pipeline.ts`                          | `buildAgentConfigs` 映射 `maxRetries: agentCfg.maxRetries`；`streamCallbacks.onChunk` 处理 `isComplete && text===''` 时重置 `streamedRaw`（流式重试清预览） |
| 4   | `src/ui/components/settings/agent/AgentParamsCard.vue` | 加「失败重试次数」Stepper（0-5，复用现有参数行样式）                                                                                                        |
| 5   | `agent-config.json` 加载兜底                           | `loadPresets()` 的 `agentDefaults[agentId]` 透传 `maxRetries`（照 12 键形状）                                                                               |

### 4. 侧链

- `getClientFactory`（game-pipeline）：`maxRetries` 从哪来？侧链 AgentClient 是工厂里 new 的（`timeout: agentId === 'item_gen' ? 300000 : undefined`）。侧链的 AgentConfig 在 chainData.agentConfigs 里——工厂目前拿不到。**方案**：getClientFactory 从 `this.chainData?.agentConfigs` 按 agentId 查 maxRetries 传入（缺省 1）。item_gen 默认 3 次 × 300s 最坏 900s —— 超时罕见，且设置页可调，接受（文档标注）。

### 5. 测试

- `agent-client.test.ts`：maxRetries=0/3 生效、abort 不重试（不产生第二次 fetch）、退避间隔（fake timers）
- `chatStream` 重试：失败→重试成功（onComplete 一次、onChunk 清预览）、超限 onError 一次、abort 不重试
- 设置接线：AGENT_SETTINGS_DEFAULTS 键存在、buildAgentConfigs 映射（engine-imports 结构测试）

## 验证

- `npm run test -- --run` + `npm run typecheck` + `npm run lint` + 编码闸门（agent-config.json 有中文，改完必验）
- 真机：手动断网/错端点观察重试日志与次数

## 风险与边界

- 重试在 LLM 层无副作用 → 与写队列/并行化零冲突。
- 重试请求相同 → DeepSeek KVCache 命中，成本主要是时间。
- abort 短路是行为修正（取消后不再白等 1+2 秒）。
- story 流式重试时玩家看到正文「回退清空重新生成」——预期行为（onChunk('', true) 清预览）。
