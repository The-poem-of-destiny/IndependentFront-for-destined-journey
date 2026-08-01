---
name: combat-tool-independent-channel
description: 🪦 已退役（M5-PR2）——M4 任务 5.2 combat 工具的 executeCombatToolCall 独立通道（B 方案）；现已被 v3 内核 replace，代码已删
metadata:
  type: project
---

> 🪦 **本记忆已过时（2026-08-01 M5-PR2）**：`executeCombatToolCall` / `CombatToolContext` / Group E 已随 v2 战斗运行时**真正退役删除**。v2 combat 工具由 v3 内核 + `['combat_v3']` 工具集接管。见 [[combat-v3-m5-pr2-v2-retired]]。以下为历史背景，仅供参考。

combat agent 的 13 个 combat/status 工具走**独立执行通道** `executeCombatToolCall(ctx: CombatToolContext)`，不污染现有 `ToolExecutionContext`（只有 {characters,variables,saveId}，缺 bus/combatants/战斗实例）。

**Why:** combat 工具需要 EventBus（19 event emitChain）+ 在场过滤 + 当前 CombatState，这些塞进 ToolExecutionContext 会破坏 craft/char/item 工具的兼容性。B 方案拍板：新建 CombatToolContext + executeCombatToolCall，纯分发（调底层管道 + 包进 result，不落库，patches 交调用方）。

**How to apply（历史，现已删除）:**
- 旧 `executeToolCall` 里 combat_*/status_apply/status_remove/get_combat_state 的 throw 占位**刻意保留**（不是遗留 bug）——它现在的作用是「引导调用方走新通道」。改 combat 工具时不要去动 executeToolCall 的占位。
- CombatToolContext 字段：characters/variables/saveId/bus/combatants/combat/readHooks?。combat_start 返回的 CombatState 必须由调用方（combat_runner，任务 5.7）用它更新 ctx.combat。
- 所有 combat 工具按**角色名**寻址（铁律1），findCharIdByName 从 ctx.combat.participants 按 name 找 characterId；status_apply/remove 的 target 也是名字，patch target 用 characterId。
- patches 统一由调用方走 state-manager.commitChatState 落库（ADR-21），executeCombatToolCall 只收集不落库。
- 实现位置：[[agent-tools.ts]] Group E（文件末尾，getCoreAttribute 之后）。测试在 [[agent-tools.test.ts]] 第 6 段。

相关：[[combat-v3-m5-pr2-v2-retired]] [[combat-v2-progress]]
