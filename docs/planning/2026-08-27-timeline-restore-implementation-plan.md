# 时间线恢复深模块实施计划

> **状态：已实施（2026-08-27；自动验收通过，真机待验证）**
>
> **设计依据**：2026-08-27 架构审查与逐项裁定；领域词汇见根目录
> [`CONTEXT.md`](../../CONTEXT.md)「存档与时间线」。
>
> **适用对象**：使用不同操作系统、编辑器、AI 工具或纯人工流程的开发者。本文不要求
> Codex/Claude skill、私有内容仓、浏览器会话或远端服务。

## 0. 实际执行情况（2026-08-27）

| 任务 | 结果                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| T0   | 先补三态公开契约与现有行为回归测试，确认测试先红后绿。                                |
| T1   | 在 `game-store.ts` 落地私有 `restoreTimeline()`、完整投影回读、会话隔离与效果重接线。 |
| T2   | ChatFlow、SnapshotPanel、CombatPanel 按三态分别提示、关闭或回首页，并补组件测试。     |
| T3   | 同步架构、UI 导航与 CHANGELOG；聚焦测试及 `npm run gates` 全部通过。                  |

实施保持原裁定：没有新增导出 seam、依赖、数据库迁移或取消协议。T0 与 T1 在同一工作树连续完成，
未拆成人工提交；测试仍按红灯到绿灯顺序执行。创建 PR 后重基到已合入的 PR #124：`agentLog`
此时已升级为按存档持久化的最近十回合诊断历史，不再属于会话瞬态，因此时间线恢复保留该历史，
仅在离开存档时清空其内存投影；Agent 活动态与 EJS 会话诊断仍按原计划清理。真机游玩恢复走查
未执行，保留为交付后的手动验收。

## 1. 目标与停止点

把 `game-store.ts` 中三份快照恢复编排收进一个私有深模块，使调用方只需提供快照 ID，并能可靠
区分以下结果：

- 恢复前被拒绝，权威状态没有变化。
- 权威状态与玩家可见投影均恢复成功。
- 权威状态已经恢复，但玩家可见投影或效果接线失败，当前会话必须隔离并重新载入。

完成以下事项即停止：

1. `rollbackOneTurn()`、`restoreToSnapshot()`、`restartCombat()` 共用同一恢复 implementation。
2. 三个公开 action 返回同一三态结果，并由三个 Vue 调用面正确呈现。
3. 恢复成功后不存在旧分支角色、消息、记忆、运行态、prompt session 或效果订阅。
4. focused tests 与仓库全部 gates 通过，架构与变更文档同步。

### 非目标

- 不修改 `StateManager.restoreSnapshot()` 的事务、快照格式、保留算法或数据库 schema。
- 不为恢复 workflow 新增导出的 `src/ui/lib` seam、依赖注入 port、adapter 或 feature flag。
- 不让恢复 module 负责取消普通回合、侧链或战斗；v1 只接受静止状态。
- 不重置地图包、随机事件包、内容注册表、主题、侧栏折叠或全屏等非时间线运行态。
- 不顺手修复一般读档、效果系统或 `refreshFromDb()` 的其他相邻问题。
- 不新增依赖，不改变快照 UI 的布局与视觉设计。

## 2. 现状证据

### 2.1 重复 workflow

`src/ui/stores/game-store.ts` 有三条独立恢复路径：

- `restartCombat()`：放弃战斗、恢复 pre-combat 快照、回读角色/存档/消息、对齐回合并失效
  prompt session。
- `rollbackOneTurn()`：寻找上一轮快照、恢复、回填玩家输入，再执行同一套回读。
- `restoreToSnapshot()`：恢复指定快照，再执行同一套回读。

三处已经因真实问题分别补过“角色整表替换”和“prompt session 失效”。继续复制会让下一项恢复
不变量再次只落在部分调用点，locality 不足。

### 2.2 已有权威保证

`src/sillytavern/state-manager.ts` 的 `restoreSnapshot()` 已在 per-save 写锁和单个 Dexie 事务中完成
角色、档案、剧情事件、消息、记忆、未来快照与存档游标的恢复。失败会回滚事务并返回
`StateCommitResult.success === false`。

新 module 依赖这一保证，不在 UI 层复制事务、补偿写或重试。

### 2.3 当前缺口

- `refreshFromDb()` 捕获并吞掉异常，调用方无法判断投影是否完整，不能用于第三态判定。
- `refreshFromDb()` 对角色采用合并语义，也不重载记忆；它不是时间线恢复所需的整体投影。
- `clearActive()` 尚未清理全部分支相关瞬态，例如选项、输入、物品聚焦、Agent/EJS 调试状态与
  全部战斗句柄。
- `wireEffectSystem()` 对已存在 owner 幂等跳过；恢复后若不先 `unwireEffectSystem()`，旧分支装备
  或技能订阅可能继续生效。
- `restartCombat()` 当前在确认 pre-combat 快照存在之前就放弃战斗，拒绝结果仍会破坏当前战斗。
- 三个 Vue 调用面仍按 `{ ok, error }` 处理；`CombatPanel.vue` 甚至忽略返回值。

## 3. 深模块形状

### 3.1 seam 与 interface

seam 留在 `useGameStore()` implementation 内，不新建公开模块。私有 interface 只有一个入口：

```ts
async function restoreTimeline(snapshotId: string): Promise<TimelineRestoreResult>;
```

公开 action 复用同一结果类型：

```ts
export type TimelineRestoreResult =
  | { status: 'rejected'; error: string }
  | {
      status: 'restored';
      continuation: 'same-save' | 'save-switched';
      warning?: string;
    }
  | { status: 'projection-failed'; error: string };
```

`restoreTimeline()` 不接收回填文本、战斗回调、toast 或导航函数。这些都属于调用方意图，放进
interface 会使 module 变浅。删除该 module 时，恢复顺序、失败分类、投影重载、运行态清理、prompt
失效与效果重接线会重新散回三处，因此它通过 deletion test。

### 3.2 依赖分类

- Pinia refs、prompt session 与效果接线是 in-process 依赖。
- Dexie 是 local-substitutable 依赖，现有 Vitest 使用 `fake-indexeddb`，不需要新增 adapter。
- 没有远端或第三方依赖，不新增 port。

测试通过三个公开 action 穿过同一 seam；私有 helper 不导出，不为测试制造 hypothetical seam。

## 4. 恢复状态机与不变量

```text
校验静止状态与存档身份
  │ 不满足
  └──────────────→ rejected（权威状态与当前运行态不变）
  │ 满足
  ▼
锁住新回合入口 → StateManager.restoreSnapshot(snapshotId)
  │ 事务失败
  └──────────────→ rejected（解除忙碌态，保留原运行态）
  │ 事务成功
  ▼
失效 prompt session → 拆除旧效果接线 → 读取完整投影
  │ 读取/归一化/接线失败
  └──────────────→ 清空当前会话 → projection-failed
  │ 成功
  ▼
清旧分支瞬态 → 原子应用投影 → 重建效果接线 → restored
```

必须保持以下不变量：

1. **静止状态**：普通恢复要求 `isGenerating === false` 且 `isInCombat === false`。重开战斗先验证
   自己的前置条件并放弃战斗，再进入公共 module。
2. **恢复期间不可开新回合**：module 在第一个异步写之前占用现有生成忙碌态，所有出口释放；不新增
   第二套“恢复中”全局状态。
3. **存档身份固定**：入口捕获 `saveId`，所有数据库与运行时操作使用该值。每次异步阶段后，在应用
   Pinia 投影前验证 `activeSaveId` 仍等于捕获值；若用户已离开或切档，不得清空或覆写新会话。
4. **权威恢复成功后不可伪装失败**：其后的错误只能是 `projection-failed`，不能返回 `rejected`，也
   不能自动重跑数据库恢复。
5. **完整投影**：一次读取并应用 save、characters、memories、plotEvents、saveProfile、plotOutline、
   messages 与 `turnCounter`。不调用会吞错且采用合并语义的 `refreshFromDb()`。
6. **清除旧分支瞬态**：清理 pending input/options/item focus、active modal、Agent 活动、当前 Agent
   日志、EJS rejection/fallback/ui log、全部 v2/v3 战斗视图、coordinator、等待输入、消息流及挂起的
   summary resolver。挂起 resolver 必须以 `null` 结束，不能留下永不完成的 Promise。
7. **保留非分支偏好**：不改变 sidebar/fullscreen 等布局选择，也不重置内容、地图、随机事件、音频、
   素材或主题 store。
8. **效果一致性**：权威恢复成功后立即对捕获的 `saveId` 拆旧接线；完整投影应用后按恢复出的角色
   重建接线。接线失败属于 `projection-failed`，并再次拆除半成品。
9. **隔离第三态**：若当前仍是原存档，调用 `clearActive()` 清空游戏会话；若已经切到另一存档，绝不
   清理新存档。公开错误文案固定为“时间线已恢复，但界面重载失败，请重新进入存档”，技术原因只
   写日志。
10. **调用方意图后置**：回退输入只在 `restored` 后回填；重开战斗回调只在 `restored` 后调用。
    回调抛错返回 `restored + warning`，因为权威与投影仍然一致。

## 5. 实施顺序

```text
T0 公开结果契约与失败测试
 ↓
T1 私有时间线恢复 module + 运行态/效果生命周期
 ↓
T2 三个调用方适配与可见错误路径
 ↓
T3 文档同步、全量 gates、人工 smoke test
```

这些任务顺序集成，不并行修改 `game-store.ts`。每项从上一项已验证的状态开始，发现相邻问题只记录，
不顺手扩大范围。

## 6. T0：钉住公开结果契约

### 文件

- `src/ui/stores/game-store.ts`
- `src/ui/stores/game-store.test.ts`

### 工作

1. 新增 `TimelineRestoreResult`，只改变三个恢复 action 的返回 interface，不移动 workflow。
2. 先把现有成功/失败断言迁到三态 `status`。
3. 增加会在旧 implementation 上失败的行为测试：
   - `isGenerating` 时普通回退与指定快照恢复均返回 `rejected`，快照事务没有执行。
   - 没有 pre-combat 快照时，`restartCombat()` 返回 `rejected` 且不调用 `abandon`。
   - 投影读取失败时不得返回普通成功。
4. 保留现有真实 Dexie 回退用例，包括幽灵 NPC 清除、消息恢复、回合对齐与 prompt session 失效。

### 验收

```bash
npm run test:run -- src/ui/stores/game-store.test.ts
npm run typecheck
```

T0 是本地 red 阶段，不得单独提交、发布或交接；完成 T1 并转绿后，将 T0 与 T1 合为一个提交，
但实现时仍按测试先行顺序工作。

## 7. T1：实现私有时间线恢复 module

### 文件

- `src/ui/stores/game-store.ts`
- `src/ui/stores/game-store.test.ts`

### 工作

1. 增加私有 `restoreTimeline(snapshotId)`，集中执行 §4 状态机。
2. 增加私有完整投影读取与应用 helper；helper 留在 implementation 内，不进入 store 返回对象。
3. 把会话级清理集中为一个私有 helper，由 `clearActive()` 与成功恢复复用；`clearActive()` 只额外解除
   `activeSaveId`。
4. 恢复投影先完整读取并归一化，再同步应用到 Pinia，避免读取到一半时留下混合投影。
5. 用静态 import 复用 `wireEffectSystem()` / `unwireEffectSystem()`；不修改效果引擎 interface。
6. 将三个公开 action 的重复恢复段替换为 `restoreTimeline()`：
   - `rollbackOneTurn()` 在调用前捕获玩家输入并解析目标快照；仅在 `restored` 后回填。
   - `restoreToSnapshot()` 直接返回公共 module 结果。
   - `restartCombat()` 先确认 `preSnapshotId` 与 `restart` 回调存在，再 abandon；恢复成功后调用
     `restart`，抛错转为 `warning`。
7. 在跨 await 的每个写回点使用捕获的 `saveId` 做身份守卫，不能把旧恢复结果写进后来打开的存档。

### focused tests

- 三个 action 都穿过同一恢复行为，旧重复路径删除。
- 成功恢复会整体替换角色、记忆、剧情、消息与回合游标。
- pending input/options/item focus、Agent/EJS 日志及全部战斗瞬态被清空，布局偏好保持。
- 旧效果 owner/订阅被拆除，恢复快照内装备与技能重新接线。
- 数据库事务失败返回 `rejected` 且保留原运行态。
- 数据库事务成功、投影读取失败返回 `projection-failed`，隔离原存档并保留已恢复数据库。
- 效果接线失败走同一第三态并清掉半成品接线。
- 恢复期间切到另一存档时，不覆写或清空新存档。
- 重开回调抛错返回 `restored` 与 warning，不导航首页。

### 验收

```bash
npm run test:run -- src/ui/stores/game-store.test.ts
npm run typecheck
```

## 8. T2：适配三个 Vue 调用面

### 文件

- `src/ui/components/game/ChatFlow.vue`
- `src/ui/components/game/ChatFlow.test.ts`
- `src/ui/components/game/SnapshotPanel.vue`
- 新增 `src/ui/components/game/SnapshotPanel.test.ts`
- `src/ui/components/game/combat/CombatPanel.vue`
- `src/ui/components/game/combat/CombatPanel.test.ts`

### 工作

1. `ChatFlow.vue`：等待回退结果；`rejected` 显示 warning toast，`projection-failed` 显示 error toast
   并 `ui.navigate('home')`，`restored` 保持现有输入回填体验。
2. `SnapshotPanel.vue`：`rejected` 留在面板显示原因；`restored` 关闭面板；`projection-failed` 显示
   固定 error toast 并回首页。
3. `CombatPanel.vue`：不再 `void` 丢弃结果；`rejected` 显示 warning，`restored.warning` 明确提示
   “已回到战斗前，但战斗未能重新开始”，`projection-failed` 显示 error 并回首页。
4. 不新增 CSS，不改变按钮文案、尺寸、确认弹窗或交互顺序。

### focused tests

- 三个调用面分别覆盖 `rejected`、`restored`、`projection-failed`。
- 第三态只触发一次 error toast 与一次首页导航。
- `restored.warning` 不导航首页。
- SnapshotPanel 的 loading 状态在所有结果与异常出口都复位；使用 `try/finally`，避免按钮永久禁用。

### 验收

```bash
npm run test:run -- src/ui/components/game/ChatFlow.test.ts src/ui/components/game/SnapshotPanel.test.ts src/ui/components/game/combat/CombatPanel.test.ts
npm run typecheck:vue
```

## 9. T3：文档与整体验收

### 文件

- 本计划：状态改为“已实施（日期）”，新增实际执行情况与偏差记录。
- `docs/ARCHITECTURE.md`：在前端/持久化交界补充时间线恢复 module 的 seam 与三态语义。
- `src/ui/AGENTS.md`：在 store 架构地图记录三个 action 共用的恢复 workflow。
- `docs/CHANGELOG.md`：追加完成记录、根因、测试与真机状态。
- `AGENTS.md`：导航描述随最终状态更新。

### 自动验收

只格式化实际修改文件，然后运行：

```bash
npx prettier --write <本次实际修改的文件>
npm run test:run -- src/ui/stores/game-store.test.ts src/ui/components/game/ChatFlow.test.ts src/ui/components/game/SnapshotPanel.test.ts src/ui/components/game/combat/CombatPanel.test.ts
npm run gates
```

所有改过的中文文件逐一执行仓库规定的 UTF-8 / U+FFFD / 控制字符检查。不得以 focused tests
替代最终 `npm run gates`。

### 人工 smoke test

使用仓库占位内容或本地测试存档，不依赖私有叙事内容：

1. 普通两回合后执行“回退本轮”，确认输入回填、旧正文与后生成角色消失，重发后回合号连续。
2. 从快照面板恢复历史快照，确认不回填旧输入，角色、任务、记忆与消息同步回退。
3. 战斗中执行“重开战斗”，确认先回到 pre-combat 状态，再出现新的战斗就绪流程。
4. 生成中确认回退入口不可用，直接调用 action 也返回 `rejected`。
5. 用测试故障注入覆盖第三态；不在真实存档上人为破坏 IndexedDB。

真机未执行时，文档必须写“自动验收通过，真机待验证”，不得写成全部完成。

## 10. 交接与提交边界

- 本计划不授权提交、push 或合并；执行者按仓库代码变更流程使用分支与 PR。
- 每个任务只提交列出的文件；若拆分提交，推荐 T0+T1、T2、T3 三个可独立回滚的提交。
- 交接只需报告：提交 SHA、修改文件、执行命令、结果、未完成的 smoke test 或阻塞。
- 最终停止点是 §9 全部自动验收通过且没有具体高风险缺口；可选抽象与相邻清理留在范围外。
