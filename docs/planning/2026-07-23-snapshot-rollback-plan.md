# 快照面板 + 右键回退重发 — 实现计划

> 日期：2026-07-23 ｜ 状态：设计已锁定，待实现
> 相关记忆：`snapshot-regenerate-feature-design` ｜ 相关规范：M5 §11.2（快照=整份深拷贝）

## 一、目标

两个能力：

1. **左侧 SideToolbar「快照」按钮** → 面板列出分层保留的历史快照，可恢复到任一快照点（状态 + 消息回滚）。
2. **最新一回合 AI 消息右键** → 菜单「回退」+「复制」。
   - 「回退」= 撤回上一轮：恢复上一轮快照 + 把**这轮玩家输入回填到输入框**。
   - 回退后**原样发送** = 重新生成（同输入重跑 agent 链，新输出）；**编辑后发送** = 编辑重发。
   - 一个动作同时覆盖"重新生成"和"编辑重发"两种需求。

## 二、设计决策（主人已锁定）

| # | 决策 |
|---|------|
| ① | 右键菜单只做「回退」（撤回上一轮 + 回填输入）；不再单列"重新生成"（由回退+重发达成） |
| ② | 右键只在**最新一回合**消息上生效 |
| ③ | 分层保留（最近 5 每轮 → 每 4 回合 → 每 8~10 回合，封顶 ~30）；`trimSnapshots` 从 FIFO 改阶梯淘汰；设置加可配置项 |
| ④ | 快照按钮放**左**侧 SideToolbar，**调试按钮上面** |
| ⑤ | 回退/恢复底层用 `restoreSnapshot`（不用 `regenerateAgent`，它不级联下游） |
| A | 右键菜单额外加「复制」（复制该条消息文本） |
| B | 设置项 = 「快照保留模式」下拉：`阶梯式(推荐) / 密集(每轮)`，配合已有「快照上限」数字 |

## 三、架构与数据流

### 回退（右键）流

```
用户右键最新 assistant/system 消息 → 「回退」
  ├─ 1. 捕获当前回合 turn=N 的 user 消息 content（删除前先存）
  ├─ 2. restoreSnapshot(snapshotAtTurn(N-1))
  │     ├─ characters 覆写（全删→重写）
  │     ├─ saveProfile 覆写（变量/任务/时间/好感随行）
  │     ├─ plotEvents 覆写（🆕 全删→写快照副本，同 characters 模式）
  │     ├─ 清理 memories：realTimestamp > snapshot.createdAt（🆕）
  │     └─ deleteMessagesAfterTurn(N-1)
  ├─ 3. game.fillInput(capturedUserInput)  → 输入框回填
  ├─ 4. game.refreshFromDb() + restoreMessages()  → UI 同步
  └─ 5. 用户编辑/原样发送 → pipeline.run → 全新回合 N
```

### 快照面板恢复流

```
SideToolbar「快照」→ Modal 列出分层快照
  └─ 选一条 → restoreSnapshot(id) + memories/plotEvents 清理
     → refreshFromDb + restoreMessages
     → （不回填输入，从该点继续游戏）
```

### 分层保留（trim 改造）

- **仍每轮 `advanceTurn` 打 turn 快照**（保证右键回退永远有"上一轮档"可用）。
- `trimSnapshots` 改阶梯淘汰：当数量 > `maxSnapshotsPerSave` 时，按"年龄"稀疏化——
  - 最近 5 个：全留
  - 再往前：每 4 回合留 1 个
  - 更早：每 8~10 回合留 1 个
  - **铁律：永远不淘汰最近 5 个**（回退依赖）。
- 设置 `snapshotRetentionMode`：
  - `tiered`（默认）= 阶梯淘汰
  - `dense` = 原 FIFO（每轮都留，留最新 N 个）

## 四、任务分解

### A. 引擎层（`src/sillytavern/`）

| 任务 | 文件 | 说明 |
|------|------|------|
| A1 | `types.ts` | `Snapshot` 加 `plotEvents?: PlotEvent[]`（capture 用，可选=兼容旧快照） |
| A2 | `state-manager.ts:1165` `createSnapshot` | capture `plotEvents`（`structuredClone`，同 characters） |
| A3 | `state-manager.ts:1223` `restoreSnapshot` | 增强：① plotEvents 覆写恢复（全删+重写）② 清理 memories（realTimestamp > snap.createdAt）。需 `database.ts` 加 `deleteMemoriesAfter(saveId, realTimestamp)` helper |
| A4 | `database.ts:581` `trimSnapshots` | 加 `mode: 'tiered' \| 'dense'` 参数；实现阶梯淘汰算法（按 turn/createdAt 排序→分桶→保最近5+稀疏化旧层） |
| A5 | `state-manager.ts:1191` | `createSnapshot` 按 `settings.snapshotRetentionMode` 调对应 trim 模式 |
| A6 | `game-store.ts`（或 `game-pipeline.ts`） | 新增 action `rollbackOneTurn()`：捕获当前 user 输入 → restoreSnapshot(上一轮) → fillInput → refresh。入口需 `StateManager` 实例（实现时确认获取方式：`new StateManager(saveId)` 或复用 pipeline 的） |

### B. 前端层（`src/ui/components/game/`）

| 任务 | 文件 | 说明 |
|------|------|------|
| B1 | `SideToolbar.vue:10` | tools 数组在 `debug` 前插入 `{ id: 'snapshots', label: '快照', icon: 'fa-solid fa-clock-rotate-left' }` |
| B2 | `GamePage.vue` | `handleToolClick` 加 `'snapshots'` → `activeModal='snapshots'`；现有快照 Modal 占位（~行182）换成 `<SnapshotPanel>` |
| B3 | 新建 `SnapshotPanel.vue` | 列出 `getSnapshots(saveId)`：每条显示 回合#N / 时间 / reason 标签（回合档/手动/战斗前）/ 简要状态摘要；「恢复」按钮调 restoreSnapshot。外壳用 `AppModal` + `AppButton`，遵守 `docs/design.md` |
| B4 | `ChatFlow.vue` | 每条 `.bubble-row` 加 `@contextmenu`；**仅最新一回合** assistant 消息启用菜单。菜单项：回退 / 复制。新建 `ContextMenu.vue`（定位参考 `FormCascader.vue` 绝对定位+zindex）或内联实现 |
| B5 | `InputBar.vue` | 复用现有 `fillInput`/`pendingInput` watch（已就绪，无需改） |
| B6 | 守卫 | `activeCombat` 存在时：禁用右键回退 + 面板恢复按钮置灰 + toast「战斗中无法回退」 |

### C. 设置（`src/ui/`）

| 任务 | 文件 | 说明 |
|------|------|------|
| C1 | `types.ts:392` `AppSettings` | 加 `snapshotRetentionMode: 'tiered' \| 'dense'`；`DEFAULT_SETTINGS` 设 `'tiered'` |
| C2 | `SettingsPage.vue` 「记忆 & 缓存」分区 | 加下拉「快照保留模式」（阶梯式(推荐)/密集(每轮)） |
| C3 | `settings-store.ts` | 持久化新字段；确认「快照上限」数字项已暴露（已有 `maxSnapshotsPerSave`） |

### D. 测试（Vitest + fake-indexeddb）

| 任务 | 说明 |
|------|------|
| D1 | `trimSnapshots` 阶梯淘汰单测：构造 40+ turn 快照，验证 tiered 模式保留最近5全 + 旧层稀疏化、总数≤上限；dense 模式=FIFO |
| D2 | `restoreSnapshot` 增强单测：plotEvents 覆写 + memories 按 realTimestamp 清理 |
| D3 | `rollbackOneTurn` 单测：捕获输入 + 回滚（不重跑 pipeline）+ 回填正确 |
| D4 | 阶梯淘汰"铁律"：永远不删最近 5 个（即使上限=3） |

## 五、技术坑修复（汇总）

1. **`restoreSnapshot` 不回滚 memories/plotEvents** → A2/A3 修。
   - memories：append-only，按 `realTimestamp` 清理安全（无 turn 字段；未来可加 turn 字段更稳，本期用时间戳）。
   - plotEvents：有状态变更（不只是新增），**捕获进快照**才能干净恢复（覆写语义）。
2. **战斗进行中**（`activeCombat`）禁用回退/恢复 → B6。
3. **阶梯淘汰必须保护最近 5 个** → A4 + D4。
4. **PlotOutline** 不需回滚（大纲仅捏人页生成，游戏内不变；演化在 post_check.outlineChanges）。

## 六、边界与风险

- **第 1 回合无上一轮快照** → 右键回退禁用 + 提示「已是最早回合」。
- **manual / pre-combat 快照**混在 turn 快照里 → 面板按 `reason` 区分标签；分层淘汰优先保护非 turn 档（手动档不轻易淘汰）。
- **重发同一输入** → agent 有随机性（temperature），输出是新结果，符合"重新生成"预期。
- **plotEvents capture 增加快照体积** → bounded（剧情事件数量有限），可接受。
- **跨档校验**：`restoreSnapshot` 已有 `snapshot.saveId === this.saveId` 守卫，保持。

## 七、完成定义（DoD）

- [x] `npm run typecheck` 0 错误
- [x] `npm run test -- --run` 新增 D1-D4 全绿；全量仅 2 个 master 既有的无关失败（SelectableCard 颜色 + loadSave flaky，stash 基线复现确认非本特性引入）
- [ ] 真机验证（主人执行）：
  - 创角开局 → 多轮对话 → 右键最新消息「回退」→ 输入框回填该轮输入 → 编辑后发送 → 新回合
  - 右键「回退」→ 原样发送 → 重新生成（新输出）
  - 左侧「快照」面板 → 恢复到历史点 → 状态/消息正确回滚
  - 战斗中右键/面板恢复被禁用
- [x] `docs/design.md` 合规（CSS 变量 / AppModal / AppButton / 无硬编码颜色）
- [x] `CLAUDE.md` 同步（Phase 进度 10k + 组件清单 SnapshotPanel）
- [x] 提交前文档检查（`docs/` + CLAUDE.md）

## 八、实现顺序建议

1. **引擎先行**：A1→A2→A3（快照增强）→ A4→A5（分层 trim）→ A6（rollbackOneTurn）。每步配测试。
2. **前端接线**：B1→B2（按钮+路由）→ B3（面板）→ B4（右键菜单）→ B6（守卫）。
3. **设置**：C1→C2→C3。
4. **收尾**：D 测试补全 → typecheck → 真机 → 文档同步。
