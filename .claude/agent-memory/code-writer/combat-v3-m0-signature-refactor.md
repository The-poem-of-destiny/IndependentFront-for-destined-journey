---
name: combat-v3-m0-signature-refactor
description: 战斗 v3 M0「v2 纯函数签名改造」落点 — performAttackCheck 改 rolls[]、morale d20 必传、AppSettings.combatEngineVersion、resolveIntention 调用点铺路
metadata:
  type: project
---

战斗 v3 M0 地基的「v2 纯函数签名改造」于 2026-08-01 完成。把 v2 战斗纯函数里内部自产的骰值改为调用方显式传入，铁律是 v2 行为零变化。

**Why:** 这是差分测试（contract test）的地基——v3 内核（combat-v3/）必须能用同输入复现 v2 纯函数结果。v2 用 Math.random() 内部伪造第二颗骰（M-5）、意图对抗攻守共用一颗骰（C5）、士气骰恒 10（M-4），这些都让 replay 不可能。M0 只改签名铺路，真正双骰由 M1 内核从 DiceTape 分通道取。

**How to apply:**
- `performAttackCheck`（combat-damage.ts）：`AttackCheckInput.d20Roll: number` → `rolls: [number, number?]`。优势取 max、劣势取 min、同层级用 rolls[0]；rolls[1] 缺省退化为单骰。两处 Math.random() 已删。
- 调用点传 `[d20, d20]`（同值，等效 v2 行为结构）：combat-pipeline.ts:256、combat-resolver.ts:143。
- `resolveIntention`（combat-intention.ts）签名**未改**——`IntentionCheckInput` 早有 attackerD20/defenderD20 两字段，C5 bug 在调用点。M0 把两个调用点（pipeline:215、resolver:125）统一为攻守同值双喂（resolver 原本是攻方定值+守方 Math.random()，现已对齐 pipeline）。
- `runMoraleCheckPipeline`（combat-morale-pipeline.ts）：`d20Roll?: number` + `?? 10` 默认值 → 必传 `d20Roll: number`。调用点（combat-pipeline.ts:345）显式传 10。
- `AppSettings.combatEngineVersion: 'v2' | 'v3'`（types.ts）+ DEFAULT_SETTINGS 默认 'v2'。分支点唯一（game-pipeline.handleCombatTrigger），M5 才翻 v3。
- 测试调整：combat-damage.test.ts 的 6 个 performAttackCheck 用例字段名改 rolls（同层级传 [n]，优劣势传 [n,n]）；combat-integration-scenario.test.ts:269 同改；combat-morale-pipeline.test.ts 6 处省略实参的调用补传 10。所有断言未改（容差断言 >= / <= 在传同值后仍成立）。

**边界：** 本任务**绝对不碰** src/sillytavern/combat-v3/（另一个 agent 并行做 DiceTape/replay/types）和 src/ui/（M0 不动前端）。no-nondeterminism.test.ts 的 node:fs 报错是另一个 agent 的，不归本任务。
