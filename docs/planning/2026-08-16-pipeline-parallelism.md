# 执行计划：Agent 管线并行化（2026-08-16）

> 背景：管线 6 阶段几乎全串行，一轮完整跑完最长 6 分钟（含 dispatcher 侧链）。
> 目标：LLM 调用并行，落库串行；预估总时长 6 分钟 → 3 分钟内。
> 本计划基于 GLM 5.3 审查子代理报告（17 问题点）修正。

## ✅ 实际执行情况（2026-08-16 当日完成）

按计划三批全部实施完毕，8548 tests 全绿 + typecheck/lint 干净。与计划的偏差：

1. **队列锁粒度落地为「方法级锁段」而非「单 RMW 段」**：commitChatState 的 EJS 段 + patches 循环 + saveSaveSlot 合成一个锁段（原子性更接近直觉），reactToEvents 移锁外；applyTimeAdvance 全部 DB 工作合成一个锁段，尾部自提交移锁外。计划文档里的「锁内禁调锁」纪律不变——嵌套调用（reactToEvents / 自提交）一律放锁外，天然无死锁，不需要可重入实现。
2. **`restoreSnapshot` 也收编入队**（计划中标注「文档化即可」，实施时直接包锁——7 表事务与管线提交交错有真实风险，入队成本为零）。
3. **第三个测试场景从「vars_update 空输出」改为「管线无 vars_update stage」**：空输出会先触发 processStageMarkers 的早退 return，barrier 与末尾兜底都在 return 之后，测不到末尾 await；改为无 vars_update 的管线（只有 story + dispatcher），侧链收尾完全依赖 run() 末尾 await。
4. **测试用「统一响应」替代「按 fetch 调用顺序分派」**：同 stage 并行的 agent 装配完成先后不定，mockResolvedValueOnce 顺序不可依赖——dispatcher 与 vars_update 用同一段可同时消费的合并 json 响应。

## 硬约束（全部改动围绕这三条）

1. **LLM 调用无副作用可并行；一切 Dexie 写入必须串行**（per-saveId FIFO 写队列）。
2. **队列锁粒度 = RMW 区段**，锁内**禁止**调用任何会再次进入队列的函数（防自死锁）。
3. 写队列不仅为并行铺路，还顺带修复现状三个真实竞态：
   - 侧链并发 commitChatState 的 FP lost-update（craft-gen-chain.ts:571）
   - commitChatState 尾部 saveSaveSlot 与 advanceTurn 的 totalTurns lost-update（state-manager.ts:300-307）
   - 随机事件结算/保洁的整条 SaveProfile 竞写（2026-08-16 靠 await 时序脆弱兜底）

## 批次划分

### 第一批：队列地基（GLM 审查 1-3，定案前不开工）

| 项  | 内容                                                                                                                                                                                                                                                                                                                                                                                                               | 位置                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1a  | 新模块 `state-write-queue.ts`：`withSaveWriteLock(saveId, fn)`（per-saveId FIFO）+ `withGlobalWriteLock(fn)`（全局 FIFO）。错误传播、队尾吞错防卡死、完成即清理                                                                                                                                                                                                                                                    | `src/sillytavern/state-write-queue.ts`（新）+ `.test.ts`                   |
| 1b  | state-manager 六类写入收编：`commitChatState`（EJS 段 + patches 循环 + saveSaveSlot 入锁；`reactToEvents` 移锁外）、`applyTimeAdvance`（锁内 DB 段；自调 commitChatState 移锁外）、`confirmRandomEventTrigger`（锁内结算；reactToEvents 移锁外）、`syncRandomEventsForTurn`、`syncMapJourney`、`advanceTurn`（拆两段：totalTurns RMW 段 + createSnapshot 自锁段，防嵌套死锁）、`createSnapshot`、`restoreSnapshot` | `src/sillytavern/state-manager.ts`                                         |
| 1c  | 记忆 id 全局锁：`generateMemoryId + saveMemory` 序列包 `withGlobalWriteLock`（3 调用点：summarizeAndSave / createCompressionSummaryMemory / game-pipeline persistPlotPostCheck）                                                                                                                                                                                                                                   | `memory-summarizer.ts` / `memory-store.ts` / `src/ui/lib/game-pipeline.ts` |
| 1d  | **per-agent 依赖判定**：`PipelineStage` 加可选 `agentWaitFor?: Record<string, string[]>`；`stageDependenciesMet` 改 per-agent（某 agent 依赖失败只跳过该 agent，不连坐同 stage 其他 agent）                                                                                                                                                                                                                        | `types.ts` / `agent-orchestrator.ts`                                       |

### 第二批：③ embedding 旁路 + ② 管线重排（GLM 审查：强耦合，必须同批）

| 项  | 内容                                                                                                                                                                                                           | 位置                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 2a  | `persistMemorySummary` 挪进 `pendingPlotTasks`（run() 末尾统一 await），不再阻塞 stage 完成                                                                                                                    | `game-pipeline.ts`           |
| 2b  | `DEFAULT_AGENT_PIPELINE` 6 层 → 4 层：Stage2=[request_dispatcher, memory_summary]，Stage3=[vars_update, plot_post_check]，配 `agentWaitFor`（vars_update 不依赖 memory_summary，post_check 不依赖 dispatcher） | `types.ts`                   |
| 2c  | `types.test.ts` 管线断言同步更新（6 阶段 → 4 阶段 + agentWaitFor）                                                                                                                                             | `types.test.ts`              |
| 2d  | orchestrator 测试补：per-agent 依赖、新 stage 组合                                                                                                                                                             | `agent-orchestrator.test.ts` |

### 第三批：① 侧链旁路化（队列就位后）

| 项  | 内容                                                                                                                             | 位置                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 3a  | dispatcher 的 `<json>` 落库后**启动侧链不 await**（记录 promise），立即进 Stage 3；run() 末尾 await 全部侧链完成后再 advanceTurn | `agent-orchestrator.ts`                      |
| 3b  | **回合级 barrier**：vars_update 的 commitPatches 前 await 侧链完整完成（其 LLM 已与 vars_update LLM 重叠，只等落库）             | `agent-orchestrator.ts`                      |
| 3c  | combat 分支显式 `await charGenPromise`（参战方新角色先生成）                                                                     | `agent-orchestrator.ts`                      |
| 3d  | abort 早退路径：侧链 await 放 finally 的 refreshFromDb 之前，后台任务统一 `.catch()`                                             | `agent-orchestrator.ts` / `game-pipeline.ts` |

## 验证

- 每批结束跑 `npm run test -- --run`（重点：state-manager / agent-orchestrator / memory-summarizer / types）+ `npm run typecheck` + `npm run lint`
- 新增队列测试清单：FIFO 顺序 / 跨 saveId 隔离 / 错误传播不卡队 / 锁内嵌套禁止（文档级，用测试钉死结构）
- 真机：一轮游玩计时对比

## 已确认不做的（本次范围外）

- 侧链并发信号量（≤2 条）—— 留待真机看 429 再定
- `restoreSnapshot` 的 7 表事务与管线并发 —— 文档化「管线运行中禁用」即可，UI 已由 isGenerating 挡住
- 旧格式 craft 分支（pendingCraftMarkers）保持串行，不做并行
