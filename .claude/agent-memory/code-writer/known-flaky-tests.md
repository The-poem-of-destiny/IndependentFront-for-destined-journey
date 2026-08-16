---
name: known-flaky-tests
description: 曾经的 2 个既有失败（game-store 大纲回读 ~50% 概率、SelectableCard 品质色）——2026-07-31 全量已 0 failed，别再把它们当基线放过
metadata:
  type: project
---

**2026-07-31 更新：全量 `npx vitest run` 全绿，0 failed**（当日多次实测：125 files / 4351 tests、
工坊 P1-1 后 128 files / 4452 tests、P1-3 workshop-store 后 132 files / 4543 tests、
工坊 P2-T6（EJS 差量提交）后 **145 files / 4928 tests** 连跑两次同样全绿）。
2026-08-04 图像生成阶段 H 后再测：**238 files / 6370 passed + 4 skipped，仍 0 failed**。
2026-08-15（MEM 编号跨存档唯一性修复）再测：**324 files / 8296 passed + 9 skipped，仍 0 failed**。
下面两条历史失败要么被修了，要么那次没抽中（第 1 条是概率性的）。**现在任何 failed 都要当
成自己弄坏的来查**，只有第 1 条再次出现且症状完全吻合时才可判为已知抖动。

历史记录（2026-07-29 实测 2 failed / 3943 passed）：

1. `src/ui/stores/game-store.test.ts` → 「loadSave 应并行回读最新大纲与事件树」**约 50% 概率失败**
   （单独跑也会失败）。症状: 期望 `确认版` 实得 `旧版`。
2. `src/ui/components/create/SelectableCard.test.ts` → 「稀有度边框色正确」
   断言 `rgb(156, 39, 176)`，实际是 `--q-color: var(--theme-quality-epic);`。

**Why:** 交付新模块时跑全量看到「2 failed」很容易误判成自己弄坏的，从而去改无关文件。
第 1 条的机理是时间戳打平: `savePlotOutline` 会把 `updatedAt` 覆写成 `Date.now()`，两条大纲
同毫秒落库后 `getLatestPlotOutline` 的 `sortBy('updatedAt')` 只能按随机 id 破平。

**How to apply:** 交付前对比这条基线；只有**新增**的失败才算自己的责任。真要修，
第 1 条属于测试自身的时序假设（给两条大纲拉开 updatedAt 或断言里放宽），别去改
`getLatestPlotOutline` 的取最新语义。
