---
name: known-flaky-tests
description: 全量 vitest 跑出来的 2 个既有失败（game-store 大纲回读 ~50% 概率、SelectableCard 品质色），不是新改动弄坏的
metadata:
  type: project
---

`npx vitest --run` 全量当前**基线就是 2 failed / 3943 passed**（2026-07-29 实测），两条都与素材子系统无关：

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
