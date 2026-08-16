---
name: known-flaky-tests
description: 全量基线是 0 failed（2026-08-15 实测 329 files / 8458 passed）；content-store-registry 与 game-store 大纲回读是概率性抖动，不是免死金牌
metadata:
  type: project
---

**2026-08-15 最终校验：全量 0 failed**（329 files / 8458 passed / 9 skipped，随机事件系统
W1-W3 全部落地后跑）。所以 `content-store-registry` 那条**是概率性的、不是稳定基线** ——
下面那两段把它记成「基线 1 failed」是当时连着抽中造成的误判。**别再拿它当免死金牌**：
看到它红先单独重跑一次，红两次就当自己弄坏的查。

**2026-08-15 补记（W3 实测）：当时观察到 1 failed**（328 files / 8455 passed / 9 skipped，
断言数字随内容面增加已从 8 变 9，症状不变）。另发现**第二类假警报，只在部分文件组合下出现**：
`src/ui/stores/settings-store.test.ts` →「已销毁的 store 不得再把自己的快照写回 localStorage」
在与 `agent-settings.test.ts` / `image-settings-migration.test.ts` **同一次 vitest 调用**里跑会红
（localStorage 被同 worker 的别的套件写过，残留 `beautifierBuiltinOverridesMigratedAt`），
单独跑与全量跑都绿。已 `git stash` 在干净树上复现 —— **挑几个文件做 targeted 验证时看到它变红，
先单独跑一遍再下结论**。

**2026-08-15 更新：全量基线是 1 failed** —— `src/ui/stores/content-store-registry.test.ts`
→「装包后再跑一轮加载不会把 pack 面冲掉（memo 已生效 → 八面零 fetch）」，`expected [] to have
a length of 8 but got 0`。**已 `git stash -u` 在干净树上复现过**，与随机事件系统无关；
单独跑该文件同样失败（不是用例间串扰）。当前基线 = 326 files / 8394 passed / 9 skipped /
**1 failed**；只有第 2 个失败才算自己弄坏的。

**2026-07-31 记录：全量 `npx vitest run` 全绿，0 failed**（当日多次实测：125 files / 4351 tests、
工坊 P1-1 后 128 files / 4452 tests、P1-3 workshop-store 后 132 files / 4543 tests、
工坊 P2-T6（EJS 差量提交）后 **145 files / 4928 tests** 连跑两次同样全绿）。
2026-08-04 图像生成阶段 H 后再测：**238 files / 6370 passed + 4 skipped，仍 0 failed**。
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
