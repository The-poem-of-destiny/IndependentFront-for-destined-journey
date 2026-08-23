# LLM 组装层 Delta 会话实施计划

> **状态**：已完成（2026-08-23）
>
> **设计真源**：[`2026-08-22-llm-assembly-delta-architecture-scratch.md`](2026-08-22-llm-assembly-delta-architecture-scratch.md)
>
> **适用对象**：使用不同操作系统、编辑器、AI 工具或纯人工流程的开发者。本文不要求任何
> Codex/Claude skill、浏览器会话、私有内容仓或远端 API 凭据。

## 0. 实际执行情况（2026-08-23 补记）

> 本计划已按 §3 顺序完成 T0–T4 与 T5 的文档 + 全量 gates 部分，共 **5 个提交**（19535c9 →
> e116051，分支 `feat/prompt-delta-session`）。生产 usage 运营验收按约定留给仓库所有者，
> 不在本计划执行范围内。以下逐项记录与原计划的偏差；**无偏差的也写明**。

| 任务 | 提交                                                               | 实际做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 与计划偏差                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | `19535c9` test(prompt): pin baseline wire-message contract         | 新增 `src/sillytavern/fixtures/prompt-session/prompt-session-fixture.ts`（两虚构角色 + 一物品 + 一技能 + 一条动态世界书 + 三组消息），钉 `buildAgentMessagesAsync` 首轮只产一条 system 消息、AgentClient 补「继续」非空 user 触发、动态世界书每 assembly pass 只求值一次。**纯测试提交，不改生产行为**                                                                                                                                                                                                                                                                 | 额外加了「fixture 自身契约」测试：断言 fixture 的全部命名导出都被消费，否则 `scripts/knip-ratchet.mjs` 会把它们当新增死导出挂红 —— 计划 §4 未提这一步                                                                                                                                                                                             |
| T1   | `9d88d9a` feat(prompt): add read-only state projection diff        | 新增 `prompt-state-projection.ts` + 测试：封闭 scope 联合（14 个）、`set/upsert/remove` + `rebase` 控制信号、按逻辑名字归一化 + 规范化内容深比较、固定排序字节稳定、NARRATIVE append cursor                                                                                                                                                                                                                                                                                                                                                                            | **无偏差**。计划的「三函数 interface」原样落地                                                                                                                                                                                                                                                                                                    |
| T2   | `613f6a9` feat(prompt): add per-save per-agent prompt sessions     | 新增 `prompt-session-assembler.ts`（prepare/complete/invalidate 三入口 + `(saveId, agentId)` 内存态），`ensureUserMessage` 从 AgentClient 私有方法提为模块级导出纯函数，`AgentResult` 增 `promptTokens`，provider 不返回 `usage.prompt_tokens` 时保持 undefined                                                                                                                                                                                                                                                                                                        | 计划 §6 之外的**额外导出**：`agent-templates.ts` 的 `buildEjsPassContext` / `reportEjsFallback` 提为导出 —— assembler 每轮用同一个 EJS pass 单独求值动态世界书（投影的 `lore_dynamic`），并走与 `buildAgentMessagesAsync` 同一条回退诊断出口                                                                                                      |
| T3   | `2d4027d` feat(prompt): wire main DAG chat/chatStream              | `callAgent` 非 embedding / 非 tools / 非 skipSession 时先 `preparePromptSession`；非流式成功 complete、最终 error/abort invalidate；流式只在 `onComplete` complete、`onError` + promise reject invalidate；provider retry 复用同一 prepared messages；`result.requestMessages` 记录实际 wire messages；`regenerateAgent` 先 `invalidatePromptSession(handle)` 再走现有无状态完整请求（`skipSession`）；`AgentResult` 增 `promptSessionRevision` / `promptRebased` / `promptRebaseReason` 三个诊断字段                                                                  | 计划 §11 建议的第 4 个提交「wire main DAG **and minimal settings**」实际拆成两个：`2d4027d` 只做核心接线（orchestrator + 诊断字段），**此时 `ApiEndpoint.contextWindowTokens` / `AgentConfig.tailPrompt` 尚未接线**（prepare 调用未传这两个字段），配置面留到 T4 的 `e116051` 才补传                                                              |
| T4   | `e116051` feat(prompt): add minimal settings and lifecycle cleanup | `types.ts` 增 `ApiEndpoint.contextWindowTokens?` / `AgentConfig.tailPrompt?`；`agent-settings.ts` / `settings-store.ts` / `api-key-migration.ts` 三处 store 字段与迁移；`AgentParamsCard.vue` 加单一 `tailPrompt` 文本框、`ApiSection.vue` 聊天/embedding endpoint 高级区加 `contextWindowTokens` 数字字段（只接受正整数，坏值归一化 undefined）；orchestrator 补传两个字段；`game-pipeline.ts` 的 endpoint 构建透传 `contextWindowTokens`（正整数校验）、`resolveAgentConfig` 读 `tailPrompt`（空白归一化 undefined）；新增 `invalidatePromptSessions()` 存档清理方法 | 清理点实际挂在 **`GamePage.vue` 的 `onUnmounted`**（离开游戏页 = 存档切换/销毁的既有清理点，与 `abort()` / sceneImages 清理并列），而**方法本体定义在 `game-pipeline.ts`**（per-save 实例方法，内部调 `invalidatePromptSession(saveId)` 只清本存档全部 agent 的 session）。计划 §8 只说「在存档销毁/切换的既有清理点 invalidate」，未指定挂哪一侧 |
| T5   | —                                                                  | 文档同步（设计状态 / 计划状态 + 本节 / ARCHITECTURE / 引擎分册 / 两份 guide / CHANGELOG）+ 全量 gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **生产 usage 验收未执行**（计划 §9 第三段），留给仓库所有者                                                                                                                                                                                                                                                                                       |

**流式不携带 `prompt_tokens`（实施细节，影响预算判断对 story 不生效）**：story 是主 DAG 里唯一
走 chatStream 的 Agent。流式路径的 `StreamCallbacks` 现状不携带 `usage.prompt_tokens`
（orchestrator 在流式 `onComplete` 里传 `promptTokens: undefined`），因此 §8.3 的预算重基线判据
对 story **不生效**（`lastPromptTokens` 恒为 undefined → `shouldRebaseForBudget` 恒 false）。
story 只靠签名变化 / 失败 / 取消 / 重入 / 显式 invalidate 等其它判据重基线。这与设计 §10 停止条件
「若某 provider 不返回 prompt token，只缺少主动预算判断」同口径：**不为它引入 tokenizer，也不伪造
流式 token 数**。非流式主 DAG Agent（其余六个）不受影响，provider 返回 `prompt_tokens` 时预算
判断照常工作。

**全量验证**：`npm run gates` 八道全绿（typecheck / typecheck:vue / typecheck:tools / build /
format:check / lint / knip:ratchet / test:run）；全量 **355 文件 9169 tests 通过 + 8 skipped**。

**T5 文档同步范围**（本次改动）：

- 设计真源状态改为「已实施（2026-08-23），真机运营验收待执行」，§7.2 加 rebase 控制信号实施注记。
- `docs/ARCHITECTURE.md` 增 prompt-session-assembler 模块 seam。
- `src/sillytavern/AGENTS.md` 架构图增两行条目。
- `docs/reference/agent_system_prompt_guide.md` / `agent_template_guide.md` 各增 delta 会话说明。
- `docs/CHANGELOG.md` 追加实施记录。

## 1. 交付范围

本计划只交付默认主 DAG 普通 chat/chatStream 的 delta session：

- 七个主 DAG Agent；`memory_recall` 的 embedding 配置自动绕过。
- 首轮沿用现有完整 prompt，后续追加读取型 delta。
- 单一 `tailPrompt` 和可选 endpoint `contextWindowTokens`。
- 失败、取消、配置变化、手动重生成和预算不足时正确重基线。
- focused tests、全量 gates、匿名 fixture 和一次生产 usage 报告。

明确不做：`chatWithTools`、combat、char/item/craft/image 侧链、`historySlice` 修复、prompt
profiler、会话持久化、模型能力注册表、新 tokenizer、新依赖或第二套用户模板系统。

## 2. 共同工作约定

### 2.1 环境中立

- 以仓库 `package.json` / lockfile 为依赖真源，不添加全局工具要求。
- 命令写作 `npm ...`；Windows PowerShell/cmd 若命令解析有问题可使用 `npm.cmd ...` / `npx.cmd ...`。
- 所有路径使用仓库相对路径和 `/` 分隔符。
- 测试不得读取 `tests/realtime_export/`、私有内容仓、用户 home、系统临时目录或网络。
- 不假定开发者拥有 GitHub 登录；远端发布由获得授权的人在所有任务集成后执行。

### 2.2 协作与交接

- 协调者先钉同一个基线提交；每项任务从已集成的上一项开始，不并行修改同一 seam。
- 每项任务只提交清单内文件；发现相邻缺陷时记录，不顺手修。
- 交接信息只需：提交 SHA、改动文件、运行命令、结果、未解决阻塞。
- 不把本计划中的“Agent”理解成开发代理；它指游戏内 LLM Agent。
- 不引入 feature flag。v1 通过明确的 eligibility 判据选择 session 或现有无状态路径。

### 2.3 每项任务的完成定义

- focused tests 通过。
- `npm run typecheck` 与相应 Vue/tools 类型检查通过；只改引擎 TS 时仍需最后统一跑全量 gates。
- 只格式化本任务实际修改的文件。
- 中文文件编码检查为 `U+FFFD: 0`、控制字符为 `0`，JSON 文件还必须能解析。
- 不改变清单外的运行行为。

## 3. 实施顺序

```text
T0 记录现状契约与匿名 fixture
 ↓
T1 读取型 PromptStateProjection + 纯 diff
 ↓
T2 prompt-session-assembler 深模块
 ↓
T3 主 DAG chat/chatStream 接线
 ↓
T4 两个最小配置面 + 生命周期清理
 ↓
T5 文档、全量 gates 与生产 usage 验收
```

T1–T4 按顺序集成。这样每次提交都有一个可测试 interface，避免多名开发者同时改
`agent-orchestrator.ts`、`types.ts` 和配置 UI 后再集中解冲突。

## 4. T0：钉现状契约与匿名 fixture

### 目标

在改生产代码前，用小型仓内 fixture 固定“首轮等价”和“wire message 实际形态”。

### 文件

- 新增 `src/sillytavern/fixtures/prompt-session/` 下的匿名三回合 fixture。
- 扩充 `src/sillytavern/agent-templates.test.ts`。
- 扩充 `src/sillytavern/agent-client.test.ts`。

### 工作

1. fixture 只包含两个虚构角色、一个物品、一个技能、一条动态世界书和三组 user/assistant 消息。
2. 钉住 `buildAgentMessagesAsync` 首轮只产 system 消息的现状。
3. 钉住 `AgentClient` 实际发送前会补内容为“继续”的非空 user 触发消息。
4. 钉住动态世界书每个 assembly pass 只求值一次。
5. fixture 不复制真实导出、真实世界书、API Key 或用户内容。

### 验收

```bash
npm run test:run -- src/sillytavern/agent-templates.test.ts src/sillytavern/agent-client.test.ts
```

此任务不改生产行为。若现状测试与代码不一致，先修测试假设，不在 T0 修产品。

## 5. T1：实现读取型投影与纯 diff

### 目标

建立不依赖 StatePatch、无 I/O、无全局状态的纯函数层。

### 文件

- 新增 `src/sillytavern/prompt-state-projection.ts`。
- 新增 `src/sillytavern/prompt-state-projection.test.ts`。
- 必要时在 `src/sillytavern/types.ts` 增加对外需要的最小类型；内部类型留在新 module。

### interface

```ts
projectPromptState(agentId, context, renderedDynamicLore): PromptStateProjection;
diffPromptState(previous, current): PromptDeltaOp[];
renderPromptDelta(revision, ops): string;
```

### 工作

1. scope 使用封闭联合，不接受任意路径字符串。
2. 角色资源为标量；技能、物品、状态效果和任务按名字整元素比较。
3. 所有集合先按逻辑名字归一化；重复名字沿用现有上游不变量，不另做恢复系统。
4. 使用规范化内容深比较，禁止用对象引用判断变化。
5. 输出固定排序，再用 `JSON.stringify` 序列化到 `<context_delta>` 外壳。
6. 动态世界书作为固定 scope 的整块 upsert；静态世界书不进入投影。
7. `NARRATIVE` 以 `ChatMessage.id` 做 append cursor；旧消息变化返回“必须重基线”，不产伪 delta。
8. 不导入 StateManager、database、UI store 或 provider client。

### focused cases

- 完全相同投影返回空数组。
- 单个 HP 变化只产生一个 set。
- 对象重建但内容相同不产生操作。
- 技能新增/修改/删除分别为 upsert/upsert/remove。
- 数组重排不产生操作。
- 名字中含中文、点号或方括号时仍作为 JSON value，不拼路径。
- 相同输入多次渲染字节一致。
- 历史新增只返回新消息；已表示消息被修改、删除或重排时要求重基线。

### 验收

```bash
npm run test:run -- src/sillytavern/prompt-state-projection.test.ts
npm run typecheck
```

## 6. T2：实现 prompt-session-assembler 深模块

### 目标

让一个 module 独占 transcript、签名、revision、prepare/complete/invalidate 和重基线，不把状态
操作散进 orchestrator。

### 文件

- 新增 `src/sillytavern/prompt-session-assembler.ts`。
- 新增 `src/sillytavern/prompt-session-assembler.test.ts`。
- 小改 `src/sillytavern/agent-client.ts`：把“补非空 user 消息”提成可复用、幂等的纯函数。
- 修改 `src/sillytavern/types.ts`：为 `AgentResult` 增加可选 `promptTokens`。
- 扩充 `src/sillytavern/agent-client.test.ts`。

### interface

严格实现设计文档 §4 的三个入口：

- `preparePromptSession`。
- `completePromptSession`。
- `invalidatePromptSession`。

不要暴露内部 Map、projection mutation、signature builder 或 token-growth estimator。

### 工作

1. key 固定为 `(saveId, agentId)`。
2. 首轮调用现有完整 renderer；首轮 user 消息保留“继续”触发，随后追加固定协议和可选 tail。
3. 后续请求复制上次 wire transcript，追加成功 assistant 响应和一个新 user delta。
4. 从当前 template/story preset 提取占位符，并用代码固定分类选择 baseline、projection 或
   ephemeral 渲染；不新增用户可编辑模板。
5. 动态世界书沿用同一个 EJS pass，每轮至多求值一次。
6. `turn_context` 复用现有 resolver 产出的 ephemeral 数据，`tailPrompt` 始终最后渲染。
7. complete 前不修改已提交 session；使用 handle revision 防止过期完成回写。
8. 失败、取消、重入或显式 invalidation 删除对应 session。
9. 签名用规范化字符串精确比较，不加哈希库。
10. `AgentClient` 解析 provider `usage.prompt_tokens` 到 `AgentResult.promptTokens`；module 保存最近
    两次值并按设计公式决定下一轮是否重基线。

### focused cases

- 第二轮 messages 以前一轮实际请求加 assistant 为逐字节前缀。
- 两个 agentId 和两个 saveId 完全隔离。
- 过期 handle 不能覆盖新 revision。
- 失败后下一轮用当前状态重基线。
- 静态签名变化重基线，单纯状态变化不重基线。
- 达到已配置 token 预算时重基线；未配置时不猜。
- 空 `tailPrompt` 不产标签，非空值位于最后。
- `historyLayers` 只决定 baseline 播种窗口；后续新消息按 id 追加，重基线后重新收窄。

### 验收

```bash
npm run test:run -- src/sillytavern/prompt-session-assembler.test.ts src/sillytavern/agent-client.test.ts
npm run typecheck
```

## 7. T3：接入默认主 DAG

### 目标

只替换主 DAG 普通 chat/chatStream 的组装 seam；所有排除路径保持现状。

### 文件

- 修改 `src/sillytavern/agent-orchestrator.ts`。
- 必要时修改 `src/sillytavern/agent-templates.ts`，仅提取可复用的完整 renderer 结果。
- 扩充 `src/sillytavern/agent-orchestrator.test.ts` 或现有最接近的管线测试。

### 工作

1. `callAgent` 在确认非 embedding、非 tools 路径后调用 `preparePromptSession`。
2. 非流式成功后 complete；最终 error/abort 后 invalidate。
3. 流式只在 `onComplete` 形成成功结果后 complete；`onError` 和 promise reject invalidate。
4. provider retry 复用同一 prepared messages，不重复 prepare。
5. `result.requestMessages` 记录实际 wire messages，而不是规范化前的内部数组。
6. `regenerateAgent` 先 invalidate，再走现有完整无状态请求，不写入 session。
7. `callAgenticAgent`、combat、embedding 和所有侧链不调用新 module。
8. 不改变 stage 顺序、waitFor、结果解析或 StatePatch 提交时序。

### focused cases

- 默认七 Agent 中两个并行 Agent 使用不同 session。
- story 流式完成后推进一次，流错误后不推进。
- memory_recall embedding 不创建 session。
- toolsEnabled 不创建 session。
- regenerate 不污染下一次正常回合。
- requestMessages 与 mock provider 实际收到的 messages 相同。

### 验收

```bash
npm run test:run -- src/sillytavern/agent-orchestrator.test.ts src/sillytavern/prompt-session-assembler.test.ts
npm run typecheck
```

如果仓库没有名为 `agent-orchestrator.test.ts` 的合适测试入口，扩充消费该 class 的现有测试；
不要为了文件名新建重复 harness。

## 8. T4：配置面与生命周期

### 目标

只增加设计核准的两个配置字段，并保证存档生命周期能清理内存 session。

### 文件

- 修改 `src/sillytavern/types.ts`。
- 修改 `src/ui/stores/agent-settings.ts` 及其现有测试。
- 修改 `src/ui/stores/settings-store.ts` 的 `ApiEntry` 和现有持久化测试。
- 修改 `src/ui/stores/api-key-migration.ts` 的 ApiEntry/ApiEndpoint 映射和现有测试，保留非密钥字段。
- 修改现有 Agent 参数编辑面，加入单一 `tailPrompt` 文本框。
- 修改 `src/ui/components/settings/ApiSection.vue`，在聊天/embedding endpoint 的高级区加入可选
  `contextWindowTokens` 数字字段。
- 修改 `src/ui/lib/game-pipeline.ts`，在存档销毁/切换的既有清理点 invalidate。
- 扩充对应 Vue/store 测试。

### 字段

```ts
AgentConfig.tailPrompt?: string;
ApiEndpoint.contextWindowTokens?: number;
```

### 工作

1. 空白 `tailPrompt` 归一化为 undefined。
2. `contextWindowTokens` 只接受正整数；空值表示不做主动预算判断。
3. 不抓取远端模型表，不按 model 名硬编码上限。
4. 不增加第二个 tail、优先级列表、条件表达式或 per-scope 配置。
5. 配置修改后由 baseline signature 自然触发重基线，不写额外迁移。
6. 存档切换/销毁清理对应 saveId；其他存档 session 不受影响。
7. 控件遵循 `docs/design.md`，保留文字标签，不使用纯图标按钮。

### 验收

```bash
npm run test:run -- src/ui/stores/agent-settings.test.ts
npm run test:run -- src/ui/stores/settings-store.test.ts src/ui/stores/api-key-migration.test.ts
npm run typecheck
npm run typecheck:vue
```

测试文件名以仓库现有实际文件为准；扩充已有覆盖，不复制同一设置 harness。

## 9. T5：文档、全量验证与运营验收

### 文档同步

实现完成的同一提交更新：

- 本设计状态改为“已实施（日期）+ 真机状态”。
- 本计划状态改为“已完成”，逐项记录实际偏差；无偏差也写明。
- `docs/ARCHITECTURE.md` 增加 prompt-session-assembler 的 module seam。
- `src/sillytavern/AGENTS.md` 增加对应现行架构说明。
- `docs/reference/agent_system_prompt_guide.md` 说明首轮模板与后续 delta 的关系。
- `docs/reference/agent_template_guide.md` 说明 template 只控制首轮完整 prompt。
- `docs/CHANGELOG.md` 追加实施记录。

不要改写 2026-08-21 实测报告的历史数据；新结果另建带日期的 review 报告。

### 格式与编码

只对实际修改文件运行 Prettier，例如：

```bash
npx prettier --write <changed-file-1> <changed-file-2>
```

修改中文 JSON/Markdown 后按根 `AGENTS.md` 的命令检查 U+FFFD、控制字符和 JSON 解析。

### 全量 gates

```bash
npm run gates
```

不得用“focused tests 已过”替代 gates，也不得为了让 gates 通过而格式化无关文件。

### 生产 usage 验收

使用开发者自己的合法 endpoint 和非敏感测试存档，按设计 §2.3 执行：

1. 两个预热普通回合。
2. 五个连续、无侧链的普通主线回合。
3. 记录七个主 DAG Agent 的 hit/miss/completion、实际调用集合、session revision 和 rebase reason。
4. 每回合主 DAG miss 合计不高于 30,000 tokens。
5. 侧链若意外触发，单列并重做该普通回合样本，不把它混进主 DAG 指标。

测试者不得提交 API Key、完整真实 prompt、私有世界书或含用户内容的 debug export。报告只保留聚合
usage、匿名场景描述、版本 SHA 和必要的非敏感结构证据。

## 10. 停止条件与后续工作

满足以下条件即停止 v1：

- T0–T5 的验收全部通过。
- 主 DAG 运营指标达标。
- 排除路径的行为有回归测试证明未改变。
- 文档状态、架构导航和 CHANGELOG 已同步。

以下结果不自动扩大本计划：

- 若 sidechain 仍使总轮次超过 30k，记录其独立 usage，再决定是否新建设计。
- 若 `historySlice` 仍造成高 miss，按既有回归单独修复，不混入本 module。
- 若某 provider 不返回 prompt token，只缺少主动预算判断，不为它引入 tokenizer。
- 若模型对累积 delta 理解不足，先用匿名固定场景证明具体失败，再调整协议；不预建通用 schema
  编辑器、压缩器或摘要 Agent。

## 11. 建议提交边界

为方便不同开发者交接，建议保持五个可独立审查的提交：

1. `test(prompt): pin baseline wire-message contract`
2. `feat(prompt): add read-only state projection diff`
3. `feat(prompt): add per-save per-agent prompt sessions`
4. `feat(prompt): wire main DAG and minimal settings`
5. `docs(prompt): record delta session implementation and live verification`

提交标题只是建议，不是工具或分支要求。发布前按仓库规则检查文档、运行 gates，并由有权限的集成者
执行 push 与 CI 跟进。
