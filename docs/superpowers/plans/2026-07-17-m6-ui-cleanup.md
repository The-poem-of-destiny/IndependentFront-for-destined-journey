# M6 读方切换与收官清理 实施计划（数据字段规范批次 6）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 迁移收官：UI/上下文读方切到正式字段、customFields 双写侧退役、死代码/死字段清零，最后**解冻真机测试**做全量验证。

**Architecture:** 先切读方（此时双写仍在，行为安全），再停写旧 key（读方已不依赖），最后清死代码与收官验证。执行前必须与 M2-M5 实际完成状态校准（尤其: M3 是否已让 char-gen 写正式字段、M5 是否已启用 [saveId+turn] 索引）。

**Tech Stack:** TypeScript · Vue3/Pinia · Vitest · 真机 debug loop（`docs/reference/debug-loop-handbook.md`）

## Global Constraints

- 每个 task 完成后 `npm run typecheck` 0 错误 + `npm run test -- --run` 不新增失败（已知 1 失败: create-store 命定之灵——**本批 Task 6 顺手排查它**）。
- 本计划在 M5 完成后执行。行号为快照，按符号锚点定位。
- 规范: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`；52 项: `docs/superpowers/specs/2026-07-16-entity-field-audit.md`。
- 读方切换铁律: **先切读、再停写**，两步不得在同一 commit（回滚粒度）。

---

### Task 1: 读方切正式字段（切读，双写仍在）

**Files:**
- Modify: `src/sillytavern/context-visibility.ts`（customFields.background/personality/appearance 读点 → 一等字段，customFields 兜底保留一行 `?? customFields.xxx` 到 Task 2 删）
- Modify: `src/ui/components/game/CharacterListPanel.vue`（gender/age/appearance/outfit/trait/background 读点——**trait→personality**: UI 改读 `char.personality`）
- Modify: `src/ui/utils/test-save.ts`（NPC 的 customFields.trait 值同步复制为一等 personality 字段——**若 M2-M5 执行期间已做则跳过**）
- Modify: `src/ui/stores/game-store.ts`（getThoughts: 删 customFields 兜底；charName 参数裁决——**删除**，签名改 `getThoughts(char?: CharacterState)`，三个调用方（CharacterListPanel/GamePage/ScenePanel）同步）
- Test: `src/sillytavern/context-visibility.test.ts` + `src/ui/stores/game-store.test.ts`

- [ ] **Step 1: 失败测试** — ① 角色只有一等 appearance（customFields 无）时上下文包含外貌 ② getThoughts 新签名读 char.thoughts ③ CharacterListPanel 数据源断言（组件测试若无则以 store/纯函数级断言替代）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 通过 + typecheck + 全量**。
- [ ] **Step 5: Commit** `feat(M6): 读方切正式字段 — context/UI/getThoughts (#34 前半)`

覆盖: #34（读方侧）+ trait→personality 映射 + getThoughts 死参数。

---

### Task 2: 双写退役（停写旧 key）

**Files:**
- Modify: `src/ui/stores/create-store.ts`（buildCharacterState 的 customFields: 删 saveId/gender/personality/physics/backstory，保留 destinyCoreId/destinyPoints/age/extra）
- Modify: `src/ui/utils/test-save.ts`（4 处 customFields 同式收缩）
- Modify: `src/sillytavern/char-gen-agent.ts`（assembleCharacterState 停写 customFields 的 background/appearance/personality/gender/clothing——M3 起的双写侧）
- Modify: `src/sillytavern/state-manager.ts`（applyAddCharacter 的 `customFields.saveId` 双写行删除）
- Test: 受影响各 test（断言 customFields 旧 key 的改断言一等字段）

- [ ] **Step 1: grep 双写清单核对** — `grep -rn "customFields" src/ --include="*.ts" --include="*.vue" | grep -v test` 逐处分类: 停写 / 真扩展保留（destinyCoreId/destinyPoints/age/likes/faction/extra/thoughts? — thoughts 已升一等，停写）。
- [ ] **Step 2: 实现停写**；**Step 3: 全量测试**（读方 Task 1 已切，测试应只有断言旧 key 的需要更新）。
- [ ] **Step 4: Commit** `refactor(M6): customFields 双写侧退役 — 只留真扩展数据 (#34 后半)`

覆盖: #34（写方侧收口）。

---

### Task 3: 查询与类型清理

**Files:**
- Modify: `src/ui/stores/game-store.ts`（refreshFromDb: `getCharacters()` 全量 → `getCharacters(activeSaveId.value)` 索引查询，合并语义保持）
- Modify: `src/sillytavern/types.ts`（ChatSession 接口删除 + 失真 deprecation 注释清理；MemoryRecord.relatedPlotEventId 删除 #50）
- Modify: `src/sillytavern/memory-summarizer.ts`（createCompressionSummaryMemory 的 `Omit<...,'id'>` 返回改为内部补 `generateMemoryId()` 直接返回完整记录 #50）
- Modify: `src/sillytavern/plot-outline.ts` + `database.ts`（#51 裁决: 保留 version 递增语义，`getLatestPlotOutline` 改按 `updatedAt` 排序，删除按 version 排序的冗余；SaveSlot.slot 多槽 TODO 保留原样并在注释补"多槽位属产品功能非字段规范"）
- Modify: `src/sillytavern/state-manager.ts`（applyUpdateQuest/applyRemoveQuest 未用解构清理 #52；maxSnapshots 读 settings 已在 M5 Task 2——验证并删残留常量）
- Test: 相应 *.test.ts

- [ ] **Step 1**: 逐项实现（refreshFromDb 改动需保住 M1 写的三条合并语义测试）；grep `ChatSession|relatedPlotEventId` 全仓清零。
- [ ] **Step 2: typecheck + 全量**；**Step 3: Commit** `refactor(M6): 索引查询 + ChatSession/relatedPlotEventId 退役 + #50 #51 #52 清理`

覆盖: #46（收尾）#50 #51 #52 + refreshFromDb 备忘。

---

### Task 4: UI 死功能裁决 — markNewsRead 接线 + deleteSaveSlot 事务化

**Files:**
- Modify: `src/ui/components/game/ScenePanel.vue`（toggleNews 展开时调 markNewsRead + refreshFromDb 或本地同步 read 标志）
- Modify: `src/sillytavern/database.ts`（deleteSaveSlot 用 `db.transaction('rw', [...7 表], ...)` 包裹——M1 终审 Minor 遗留）
- Test: `src/sillytavern/save-profile.test.ts` / `database.test.ts`

- [ ] **Step 1: 失败测试** — ① markNewsRead 后 profile.news 对应项 read=true（接线路径）② deleteSaveSlot 事务语义（fake-indexeddb 支持 Dexie 事务；断言 7 表清空不变）。
- [ ] **Step 2: 实现**；**Step 3: 通过 + typecheck + 全量**；**Step 4: Commit** `feat(M6): markNewsRead 接线 + deleteSaveSlot 事务化 (#36)`

覆盖: #36 + M1 终审遗留。

---

### Task 5: 范围外留档 + 装备 UI 完整化验收

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（附录 A 后追加「范围外接线待办」小节）
- Modify: `src/ui/components/game/StatusOverview.vue` / `ItemsPanel.vue` / `CharacterListPanel.vue`（M2 Task 12 的 filter 最小适配 → 检查是否需要正式的"装备栏分组展示"重构；**只在展示破损时修**，纯样式优化不做）

- [ ] **Step 1**: #17（FP/契约/成就管线）#29（EventBus 三件套）#3 #18（memory_summary/plot 接线）四项写入「范围外接线待办」——数据形状已锁定，接线属功能开发非字段规范，留档移交。
- [ ] **Step 2**: 装备 UI 三组件人工过一遍渲染逻辑（equippedSlot 分组/槽位排序），破损处修复。
- [ ] **Step 3: typecheck + 全量**；**Step 4: Commit** `docs(M6): 范围外接线留档 + 装备 UI 验收 (#17 #29 留档)`

覆盖: #17 #29（合法排除留档）。

---

### Task 6: 收官验证 — 解冻真机测试

**Files:**
- Modify: `CLAUDE.md`（进度表 + 架构注记更新）
- Modify: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（附录 A 全批次完成注记）

- [ ] **Step 1: 全量门禁** — `npm run typecheck && npm run test -- --run`；顺手排查既有失败「create-store 命定之灵」用例（M1 前就存在，与迁移无关但收官不留尾巴——修复或注记原因）。
- [ ] **Step 2: 真机 debug loop**（按 `docs/reference/debug-loop-handbook.md`）:
  1. 清浏览器 IndexedDB（删 SillyTavernWebDB）→ `npm run dev`
  2. 完整一轮: 创角 → 开局 → 对话数轮（覆盖: 获得物品/消耗物品/穿脱装备/学技能/上状态效果/任务 upsert/好感度变化/新角色生成）
  3. DebugPanel 导出 JSON + log.txt → 按手册五维度分析
  4. **52 项逐条核对表**: 每项标 已修复/验证通过 | 已修复/待观察 | 范围外留档 —— 写入 `docs/superpowers/specs/2026-07-16-entity-field-audit.md` 文末「收官核对」节
- [ ] **Step 3: 发现的新 bug** 按 debug-loop-handbook 流程走（分析→排期→修复），不阻塞收官提交（除非 P0/P1）。
- [ ] **Step 4**: `bash scripts/notify.sh "数据字段规范 M1-M6 全部完成!" "52 项核对 | 真机验证通过"`；CLAUDE.md 进度表更新；Commit `docs(M6): 迁移收官 — 52 项核对 + 真机验证记录`。

---

## 覆盖清单

| 项 | Task |
|----|------|
| #34 读方/写方双侧 | 1 / 2 |
| #36 markNewsRead | 4 |
| #46 ChatSession 收尾 | 3 |
| #49（M5 已启用索引，本批确认）| 3 |
| #50 #51 #52 | 3 |
| #17 #29（范围外留档）| 5 |
| trait→personality | 1 |
| getThoughts charName 死参数 | 1 |
| refreshFromDb 索引查询 | 3 |
| deleteSaveSlot 事务化（M1 遗留）| 4 |
| 真机解冻 + 52 项收官核对 | 6 |
