---
name: combat-v3-m5-pr2-v2-retired
description: 战斗 v3 M5-PR2 真正退役 v2 战斗运行时：删 6 文件+测试，类型迁 combat-v2-types.ts，v2 分支改优雅提示；tests 5245→5101 全绿
metadata:
  type: project
---

战斗 v3 **M5-PR2**（2026-08-01，分支 `feat/combat-v3-m5`）真正退役 v2 战斗运行时（选项 A 全删清单）。主人拍板。工作区 `src/sillytavern/`。

**删除（各 + 测试）**：`combat-runner` / `combat-pipeline` / `combat-actions-pipeline` / `combat-modifier-inject`（4 个运行时）+ `combat-resolver` / `combat-settlement-pipeline`（编排+结算，v3 不用）。

**类型迁移 → 新建 `combat-v2-types.ts`**（根目录，非 combat-v3 下）：`CombatClient` / `CombatClientResult` / `CombatEvent`（原 combat-runner）、`PipelineContext` + `COMBAT_EVENTS` 值（原 combat-pipeline，combat-morale-pipeline 仍引）、纯函数 `characterToCombatParticipant`（原 combat-resolver，game-pipeline v3 分支仍引）。

**必须留的六文件**：combat-panel / combat-damage / combat-intention / combat-turn / combat-morale-pipeline / combat-item-validator（v3 内核在调 or 纯计算）。

**agent-tools.ts**：删 `AGENT_TOOL_MAP['combat']` + `executeCombatToolCall` + `CombatToolContext`/`CombatToolCallResult` + Group E 整块（buildPipelineCtx/findCharIdByName/findStatusEffectsByName）+ 12 个 v2 工具 schema 定义。留 `['combat_v3']`（含 get_combat_state，其 executeToolCall 占位 case 保留）。`status_query`/`combat_*` 占位 throw case 在 executeToolCall 内保留（注释引用已删模块，但无 import，编译通过）。

**agent-config.json 在 `data/defaults/`**（不是 AGENTS.md 写的 `src/sillytavern/`！）：用 python 精确删 `combat` 条目，留 `combat_v3`。**绝不能用 prettier --write**。

**v2 分支优雅退役**：`game-pipeline.ts` `handleCombatTrigger` 的 v2 分支不再 `import('@engine/combat-runner')`，改为返回 `CombatSummaryResult`（narrativeSummary=「v2 战斗引擎已退役删除」+ outcome:'draw'）+ addMessage 提示。flag 结构保留（打回 'v2' = 优雅提示非真玩）。

**测试剥离**：`agent-tools.test.ts`（808→228 行，只留 status_query + 复用工具回归块）、`combat-integration-scenario.test.ts`（943→731 行，删第九章 $combat + 第十章 panel 块，第三章标题误导但 body 测存活纯函数保留）。

**Why:** v2 运行时是死代码且三处硬矛盾（game-pipeline 动态 import combat-runner / resolver 编排测试 / executeCombatToolCall）让「保留 v2 可用」编译不过。真正退役比半删干净。

**How to apply / 验证结果（2026-08-01）**：typecheck 0 错误；`npm run test -- --run` **5101 tests 全绿**（5245 → 减 ~144）；combat-v3 子目录 291 tests 全绿（不破坏 v3）；`npm run build` 成功（dist-ui .js chunk 零残留删除模块，仅 .map 有注释历史）。删除文件用 `git rm`（已 staged），新 combat-v2-types.ts 未 add。提交/PR 由主人做。

**坑**：① console 打印中文/箱线字符在 Windows cp932 会 UnicodeEncodeError——python 断言/p打印走文件或用 ascii-safe 逻辑；② `rstrip()` 只去右侧空白，断言行尾 `},` 要用 `.strip()`；③ prettier 本地对改动文件报错是 CRLF 基线假象（HEAD 就脏，见 [[prettier-baseline-dirty]]），新文件反而干净（Write 产 LF）。

相关：[[combat-v3-m4-part2-harness-wiring]]（test 数 5245 基线已被本 PR 改写为 5101）
