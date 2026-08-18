# 战斗 v3 实施计划（M0 → M5）

> 📅 **日期**：2026-07-31
> 📌 **状态**：implementation-ready。读者是逐 M 动手的实现 agent——**看完自己那一节就能开工**，不需要再翻别的文档做决策。
> 🔗 **架构真源**：[`docs/reference/combat-system-architecture-v3.md`](../../reference/combat-system-architecture-v3.md)。本 plan 的所有架构判断**引用节号**（如「架构 §四 4.3」），不复述内容。plan 只写「做什么、改哪里、怎么验」。
> 🔗 **其他上游**：[v2 架构](../../reference/combat-system-architecture.md) · [v2 审查报告](./2026-07-30-combat-event-system-review.md)（7 Critical + 15 Major） · 压测 RFC + 5 场脑测案例集（`2026-07-31-combat-v3-real-sample-stress-test-rfc.md` / `2026-07-31-combat-v3-stress-test/`，已移入私有内容仓 `fated_poem_independent_assets/docs/planning/`，公开仓侧不可见） · [数据字段规范](../../superpowers/specs/2026-07-16-data-field-conventions-design.md) · [仓库治理](../../planning/2026-07-31-repo-management.md)

---

## 0. 总览

### 0.1 范围

用 7 个里程碑把战斗从 v2 的「Agent 主持流程」翻转为 v3 的「代码内核主持流程」（架构 §一 1.1）。全部新代码落在 `src/sillytavern/combat-v3/`，v2 战斗代码在 M5 之前**一行不删**，靠 feature flag 整场切换。

| M    | 一句话                                             | 主产出                                      | 验收样本             |
| ---- | -------------------------------------------------- | ------------------------------------------- | -------------------- |
| M0   | 地基：分通道骰带 + replay harness + 纯函数签名改造 | `dice-tape.ts` / `replay.ts` / fixture 格式 | 06 / 24 简版 fixture |
| M1   | 内核骨架：状态机 + 行动槽 + 原子提交 + 唯一终局    | `kernel.ts` / `reducer.ts` / `state.ts`     | 单元测试（无端到端） |
| M2   | 接线：Coordinator + feature flag + 双投影 + 前端   | `coordinator.ts` / `projection-*.ts`        | 第 09 场端到端       |
| M3   | 效果系统：DSL + 编译链 + damage.preview            | `automata/*` / `intents.ts` / `windows.ts`  | 第 24 场（反伤）     |
| M3.5 | 开放性出口：CharGenRequest + BoundedAdjudication   | coordinator 扩展 + prompt 改写              | 第 06 场（召唤）     |
| M4   | 压力测试：5 场 fixture 全绿 + 补 2 场极端样本      | rule-keys 补全 + divinity 泛化              | 第 07 / 13 场        |
| M5   | 收尾：默认翻 v3 + 删旧接线 + 文档同步              | 删除清单 + 文档 PR                          | 全量回归             |

### 0.2 非目标（明确不做）

| 非目标                                                         | 说明                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **不改战斗外的 `EventBus.publish` / `emitChain`**              | 剧情 / 任务 / 地点 / 制作继续按 ADR-29 走现有事件系统。v3 只接管**战斗内**的效果求值（架构 §十五 15.2）             |
| **不改制作系统**                                               | craft-gen-chain / craft-resolver / craft-* 全部不动                                                                 |
| **不做 checkpoint 落 IndexedDB**                               | 架构 §十六 D1：v2 中途崩溃本来就全丢，v3 内存 journal + 原子结算已严格更优。落库是 M5+ **可选**增强                 |
| **不做 shadow dual-run**                                       | 架构 §一 1.6 明确否决                                                                                               |
| **不修 v2 战斗外的 script-executor 安全问题（C1 的非战斗面）** | v3 只在**战斗内**废止任意 JS。战斗外 `script-executor.ts` 的沙盒逃逸仍是遗留债，归统一效果框架另行处理（§9 会标注） |
| **不做真机验证**                                               | M6 真机由主人另行决定，不阻塞 M0–M5（架构 §十六 16.3 开放问题 5）                                                   |

### 0.3 前置依赖

| 依赖                                        | 状态    | 说明                                                                                                                                                             |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构文档 `combat-system-architecture-v3.md` | ✅ 已落 | D1–D6 已拍板                                                                                                                                                     |
| 5 场脑测案例集                              | ✅ 已落 | `docs/planning/2026-07-31-combat-v3-stress-test/case-*.md`，含 Command 序列 + 时间线 + 骰值                                                                      |
| 战斗对话样本                                | ✅ 已落 | `reference/战斗对话样本/`（24 场），fixture 骰值回推源                                                                                                           |
| v2 纯函数测试                               | ✅ 全绿 | `combat-damage.test.ts` / `combat-intention.test.ts` / `combat-turn.test.ts` / `combat-morale-pipeline.test.ts`——M0 签名改造后**必须仍全绿**，这是差分测试的地基 |

### 0.4 风险表

| #   | 风险                                                                                   | 等级 | 对策                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | DiceTape 不分通道就动工，M3+ 骰子错位、replay 全废                                     | 🔴   | M0 第一件事就是分通道（架构 §四 4.1）。fixture 格式里 `channelSplit` 是必填字段，缺了直接测试失败                                         |
| R2  | M0 改 v2 纯函数签名破坏现有测试                                                        | 🔴   | 改造原则：**v2 行为零变化**——调用方传入它现在自产的值。改完先跑 `npm run test -- --run`，v2 全绿才算 M0 通过                              |
| R3  | 前后端契约（CombatCommand / CombatTransition / DomainEvent）晚定，前后端并行开发对不上 | 🔴   | M1 就冻结三个契约的 TS 类型（`state.ts` + `index.ts` 导出），M2 起只加不改                                                                |
| R4  | fixture 骰值从样本回推有误，contract test 断言错的东西                                 | 🟡   | fixture 用 **milestone 断言**起步（回合数 / 关键伤害值 / 终局原因 / FP 净变动），不一上来就锁 eventHash；eventHash 在 M4 各场稳定后再冻结 |
| R5  | 表达式 parser 手写出 bug，AI 产的 automaton 静默失效                                   | 🟡   | parser 错误必须带**列号**且在**编译期**抛（架构 §七 7.3）；`compile.test.ts` 覆盖每类非法 token                                           |
| R6  | Coordinator 的 RequiredInput 路由漏一路 ⇒ dispatch 死循环                              | 🟡   | `coordinator.ts` 对 `RequiredInput` 做**穷尽 switch**（TS `never` 兜底），漏一路编译不过                                                  |
| R7  | M5 删旧代码删过头，v2 回滚路径断掉                                                     | 🟡   | M5 保留 v2 一个版本周期；删除清单逐文件标「删 / 留 / 部分留」，`combat-panel.ts` 的格式化函数**必须留**（被投影 B 引用）                  |
| R8  | agent-config.json prompt 改写后 Agent 输出格式跑偏                                     | 🟡   | 按 `reference/agent流程测试/agent预期分析.md` 的流程走查，M3.5 交付时同步更新该文档                                                       |

---

## 1. 全局工程约定

### 1.1 feature flag

```ts
// types.ts —— AppSettings 新增
combatEngineVersion: 'v2' | 'v3'; // 默认 'v2'
```

- **默认 `'v2'`，M5 才翻转为 `'v3'`**；
- **分支点唯一**：`src/ui/lib/game-pipeline.ts` 的 `handleCombatTrigger`（现 :1045，v2 在 :1055-1061 `await import('@engine/combat-runner')` 调 `runCombat`）。除此之外**任何地方不得再读这个 flag**；
- **粒度按整场战斗**：`openCombat` 时把 `engineVersion` 冻结进 `CombatState.provenance`，战斗中途不可变更（架构 §十四 14.5）；
- 设置页曝光时机：M2 起在「⚙️ 设置 → 存档数据」或开发者区加一个开关（M2 可先只支持代码改默认值，不做 UI）。

### 1.2 目录与文件树

全部新代码在 `src/sillytavern/combat-v3/`，deep module，唯一公共出口 `index.ts`（架构 §十四 14.1）。

| 文件                       | 职责                                                                                                        | 关键导出签名                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | **唯一公共出口**。只导出 openCombat + 公共类型，internal 一律不导出                                         | `export function openCombat(input: NewCombat \| RestoreCombat): CombatSession` / `export type { CombatCommand, CombatTransition, CombatView, DomainEvent, RequiredInput }` |
| `types.ts`                 | v3 战斗内部类型集中定义（**注意**：对外公开的类型仍从 `index.ts` re-export；全局实体类型仍归根 `types.ts`） | `CombatState` / `CombatPhase` / `ResolutionFrame` / `JournalEntry` / `CombatProvenance` / `EffectIntent` / `DomainEvent`                                                   |
| `state.ts`                 | CombatState 构造、不可变更新辅助、CombatView 投影、revision 递增                                            | `createCombatState(bundle): CombatState` / `toView(state): Readonly<CombatView>` / `bumpRevision(state): CombatState`                                                      |
| `kernel.ts`                | CombatSession 外壳：持有 state、驱动 dispatch 循环、幂等重放缓存                                            | `createSession(bundle, state?): CombatSession`                                                                                                                             |
| `reducer.ts`               | 纯 reducer：按 phase 分发 handler，产出 CombatTransition                                                    | `reduce(bundle, state, command): CombatTransition`                                                                                                                         |
| `phases/round.ts`          | RoundOpen / RoundClose handler（buff tick、总览投影）                                                       | `handleRoundOpen(bundle, state): MicroStep[]` / `handleRoundClose(...)`                                                                                                    |
| `phases/initiative.ts`     | 先攻 handler（调 v2 `rollInitiative`）                                                                      | `handleInitiative(bundle, state): MicroStep[]`                                                                                                                             |
| `phases/unit-turn.ts`      | UnitTurnOpen / 槽位消费 / UnitTurnClose                                                                     | `handleUnitTurn(bundle, state, command): MicroStep[]`                                                                                                                      |
| `phases/attack.ts`         | 攻击结算微步骤链（意图→命中→伤害→beforeDown→after）                                                         | `handleAttack(bundle, state, command): MicroStep[]`                                                                                                                        |
| `phases/action.ts`         | 战术动作（道具/移动/专注/防御/格挡/逃跑）                                                                   | `handleAction(bundle, state, command): MicroStep[]`                                                                                                                        |
| `phases/terminal.ts`       | 终局判定 + settlement（幂等）                                                                               | `checkTerminal(state): TerminalReason \| null` / `settle(bundle, state, settlementId): CombatTransition`                                                                   |
| `dice-tape.ts`             | 分通道骰带：epoch 管理、cursor、耗尽检测、provenance 记录                                                   | `createTape(epoch): DiceTapeState` / `draw(tape, channel, n): { rolls, tape } \| { exhausted: true }` / `beginEpoch(tape, epoch): DiceTapeState`                           |
| `windows.ts`               | ReactionWindow evaluator：求值排序、在场过滤、错误隔离、预算                                                | `evaluateWindow(index, key, ctx): { intents, rejections }`                                                                                                                 |
| `intents.ts`               | EffectIntent 验证 + 解释执行 + batch 原子性                                                                 | `validateBatch(batch, ctx): ValidationResult` / `applyIntents(state, intents): PendingChangeSet`                                                                           |
| `rule-keys.ts`             | closed RuleKey 注册表 + divinity 压制表                                                                     | `RULE_KEYS: Record<RuleKey, RuleKeySpec>` / `resolveOverride(key, payload, divinity): OverrideResult` / `divinitySuppression(atk, def): number`                            |
| `automata/parser.ts`       | 表达式微文法递归下降 parser                                                                                 | `parseExpression(src: string): ExprAst`（失败抛 `ExprSyntaxError` 带列号）                                                                                                 |
| `automata/interpreter.ts`  | AST 解释器（零 eval）                                                                                       | `evaluate(ast: ExprAst, ctx: WindowCtx): number \| string \| boolean`                                                                                                      |
| `automata/compile.ts`      | EffectProgram 编译链 + 编译期校验                                                                           | `compileEffectProgram(entity): { automata, staticModifiers, errors }`                                                                                                      |
| `automata/builtins.ts`     | v2 六大效果类别 → 可信 TS adapter automaton 注册表                                                          | `BUILTIN_ADAPTERS: Record<string, (parsed: ParsedEffect) => EffectAutomaton>`                                                                                              |
| `automata/index-active.ts` | ActiveEffectIndex 派生与增量更新                                                                            | `buildIndex(units): ActiveEffectIndex` / `updateIndex(index, delta): ActiveEffectIndex`                                                                                    |
| `projection-ui.ts`         | 投影 A：DomainEvent → CombatEvent（保住 game-store 契约）                                                   | `projectToUi(events: DomainEvent[]): CombatEvent[]`                                                                                                                        |
| `projection-agent.ts`      | 投影 B：CombatState → Markdown 文本面板（复用 combat-panel 格式化）                                         | `projectToAgent(state: CombatState): string`                                                                                                                               |
| `coordinator.ts`           | CombatSessionCoordinator：RequiredInput 路由、bundle 组装、终局落库、摘要回注                               | `runCombatV3(opts): Promise<CombatV3Result>`                                                                                                                               |
| `replay.ts`                | replay harness（纯函数，不写状态）                                                                          | `replayCombat(fixture: CombatFixture): { events: DomainEvent[]; hash: string; milestones: Milestone[] }`                                                                   |

每个文件配同名 `*.test.ts`（`phases/` 下的可合并为 `phases/phases.test.ts`）。

### 1.3 铁律

| #   | 铁律                                                                        | 强制手段                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/sillytavern/combat-v3/` 内**禁用 `Math.random()`**                     | `combat-v3/no-nondeterminism.test.ts`：读取目录下全部 `.ts`（排除 `*.test.ts`），断言不含 `Math.random`。若项目 ESLint 已接 `no-restricted-syntax`，同时加一条规则（二选一即可，测试断言是底线） |
| 2   | 同上，**禁用 `new Function` / `eval`**                                      | 同上测试，正则 `new\s+Function\|[^.\w]eval\s*\(`                                                                                                                                                 |
| 3   | 每个新模块配 `*.test.ts`                                                    | code review 检查项                                                                                                                                                                               |
| 4   | **不用 `any`**                                                              | 必要时 `unknown` + 类型守卫（项目约定）                                                                                                                                                          |
| 5   | v3 类型加在 `combat-v3/types.ts`；**跨模块共享的实体类型仍归根 `types.ts`** | `AppSettings.combatEngineVersion` 加在根 `types.ts`                                                                                                                                              |
| 6   | 每个 M 完成的定义                                                           | `npm run typecheck` 零错误 **且** `npm run test -- --run` 全绿                                                                                                                                   |
| 7   | 每个 M 完成后跑通知                                                         | `bash scripts/notify.sh "战斗 v3 <M名> 完成!" "<关键指标，如 tests 数/新增文件数>"`                                                                                                              |

### 1.4 settlement 产出的 StatePatch 约定

终局把 DomainEvent 翻译成 `StatePatch[]` 时（`coordinator.ts`），必须遵守[数据字段规范](../../superpowers/specs/2026-07-16-data-field-conventions-design.md)五铁律：

| 铁律                             | 在 settlement 的落点                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| ① 逻辑键 = 名字                  | patch 的 target 用**角色名 / 物品名**，不产 id                             |
| ② 名字解析唯一入口               | 走既有的名字解析函数，不在 combat-v3 内自建解析                            |
| ③ AI 填叙事字段，Code 补账务字段 | 战利品的名称/描述来自 AI（`settle.loot`）；数量/品质/EXP/FP 由 Code 算     |
| ④ 每类数据唯一真源               | FP 走 SaveProfile（架构 §十二）；HP/MP/SP 走 CharacterState；不双写        |
| ⑤ 枚举中文集中定义               | 伤害类型 / 品质 / 状态类型引 `field-enums.ts`，不在 combat-v3 内重复字面量 |

落库调用**唯一一次**：`StateManager.commitChatState({ patches, metadata: { combatId, settlementId } })`（架构 §十四 14.4，ADR-21）。

### 1.5 分支 / PR 流程

按 [`docs/planning/2026-07-31-repo-management.md`](../../planning/2026-07-31-repo-management.md)。补充约定：

- **一个 M 一个 PR**（M0/M1/M2/M3/M3.5/M4/M5），分支名 `feat/combat-v3-m0` 等；
- PR 描述里贴该 M 的「验收断言」清单勾选状态 + `npm run test -- --run` 的通过数；
- M2 起 PR 必须说明「v2 路径是否仍可用」（flag 打回 `'v2'` 后行为不变）；
- 文档同步在**每个 M 的 PR 内**完成，不攒到 M5（`AGENTS.md` 进度表 + `docs/CHANGELOG.md`）。

---

## 2. M0 — 地基：分通道骰带 + replay harness + 纯函数签名改造

### 2.1 目标与验收

| #    | 验收断言                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| A0-1 | `draw(tape, 'attackHit', 2)` 返回 2 颗骰并推进**且仅推进** `attackHit` 的 cursor；其余通道 cursor 不变                    |
| A0-2 | 通道耗尽时 `draw` 返回 `{ exhausted: true }`，**不返回骰值、不推进任何 cursor**                                           |
| A0-3 | `beginEpoch` 后各通道 cursor 归 0，旧 epoch 进 `exhausted[]`，旧余骰不可再取                                              |
| A0-4 | 60 颗按 32/10/7/6/5 分配（架构 §四 4.3），`channelSplit` 之和 ≠ 60 时 `createTape` 抛错                                   |
| A0-5 | `replayCombat(fixture)` 是纯函数：同 fixture 跑两次，`events` 深相等且 `hash` 相同；跑完不产生任何 DB/store 副作用        |
| A0-6 | `performAttackCheck` / `resolveIntention` 调用方 / `runMoraleCheckPipeline` 签名改造后，**v2 现有测试全绿**（零行为变化） |
| A0-7 | `combat-v3/no-nondeterminism.test.ts` 通过（目录内零 `Math.random` / `new Function`）                                     |
| A0-8 | 06 / 24 两场简版 fixture 的 milestone 断言通过                                                                            |

### 2.2 新建文件

| 文件                                                 | 职责与关键签名                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/types.ts`                                 | 先落 M0 需要的部分：`DiceChannel` / `DiceEpoch` / `DiceTapeState` / `CombatProvenance` / `CombatFixture` / `Milestone`。其余类型 M1 补                                                                                                                                                                                                         |
| `combat-v3/dice-tape.ts`                             | `createTape(epoch: DiceEpoch): DiceTapeState`；`draw(tape, channel: DiceChannel, n: number): DrawResult`（`DrawResult = { rolls: number[]; tape: DiceTapeState } \| { exhausted: true; channel: DiceChannel }`）；`beginEpoch(tape, epoch): DiceTapeState`；`splitSixty(dice: number[]): Record<DiceChannel, number[]>`（按 32/10/7/6/5 切分） |
| `combat-v3/replay.ts`                                | `replayCombat(fixture: CombatFixture): ReplayResult`。M0 版本只驱动 dice-tape + 断言 milestone（内核 M1 才有），预留 `reduce` 注入缝：`replayCombat(fixture, reducer?)`                                                                                                                                                                        |
| `combat-v3/no-nondeterminism.test.ts`                | 目录扫描断言（铁律 1/2）                                                                                                                                                                                                                                                                                                                       |
| `combat-v3/dice-tape.test.ts`                        | 见 §2.5                                                                                                                                                                                                                                                                                                                                        |
| `combat-v3/replay.test.ts`                           | 见 §2.5                                                                                                                                                                                                                                                                                                                                        |
| `combat-v3/fixtures/case-06-summon.fixture.json`     | 第 06 场简版                                                                                                                                                                                                                                                                                                                                   |
| `combat-v3/fixtures/case-24-reflection.fixture.json` | 第 24 场简版                                                                                                                                                                                                                                                                                                                                   |

### 2.3 fixture 格式（M0 冻结）

```jsonc
{
  "id": "case-24-reflection",
  "sourceCase": "docs/planning/2026-07-31-combat-v3-stress-test/case-24-reflection.md",
  "bundle": {
    "combatId": "fixture-24",
    "combatType": "标准",
    "units": [/* 参战单位快照：名字/tier/HP/MP/SP/五维/装备名/技能名/divinity */],
    "programs": [/* 编译后的 EffectAutomaton[]；M0 留空数组，M3 起填 */],
    "resourceSnapshots": { "FP": 2400 },
    "rulesetRevision": "v3-2026-07-31",
  },
  "epochs": [
    {
      "outputId": "out-1",
      "dice": [/* 恰好 60 个 1..20 整数 */],
      "channelSplit": {
        "attackHit": 32,
        "initiative": 10,
        "intentCheck": 7,
        "statusContest": 6,
        "procCheck": 5,
      },
    },
  ],
  "commands": [
    {
      "commandId": "c1",
      "expectedRevision": 0,
      "kind": "DeclareAttack",
      "actorId": "理查德",
      "cost": "attack",
      "payload": { "targetId": "处刑人", "skill": "星屑连袭", "intentionLevel": "常规" },
    },
  ],
  "expected": {
    "milestones": [
      { "kind": "damage", "at": "c1", "targetId": "处刑人", "value": 8535, "tolerance": 0 },
      { "kind": "reflected", "rootChainId": "c1", "depth": 1, "value": 339 },
      { "kind": "terminal", "reason": "hp_zero", "winner": "理查德" },
      { "kind": "fpDelta", "value": -1050 },
    ],
    "eventHash": null, // M0-M3 为 null（只断言 milestone）；M4 各场稳定后冻结为字符串
  },
}
```

**milestone 类型集**（M0 定，后续只加不改）：`damage` / `reflected` / `prevented` / `statusApplied` / `moraleChanged` / `summoned` / `terminal` / `fpDelta` / `roundCount`。

### 2.4 5 场案例 → fixture 的提取步骤

对每一场，按顺序做：

1. 打开 `docs/planning/2026-07-31-combat-v3-stress-test/case-XX-*.md`，找「**CombatCommand 序列**」表 ⇒ 逐行转成 `commands[]`（`commandId` 用 `c1/c2/...`，`expectedRevision` 从 0 递增）；
2. 同文件「**流程时间线**」段 ⇒ 提取每步的骰值（案例文档已列出，如「d20=11」「2d20 优势取 20」），按消费顺序填进对应通道；
3. 骰值不足 60 的位置**用样本原文回推**：去 `reference/战斗对话样本/第XX场_*.md` 的对应行号（案例文档附录已给行号）找骰池原文；仍缺的位置填 `10`（中位数）并在 fixture 加 `"_synthetic": true` 注释标记；
4. 「架构执行问题清单」里标 🔴 的机制 ⇒ 转成 `milestones` 断言（这是该 fixture 存在的意义）；
5. 跨 epoch 的场次（第 07 场有 9 次续杯）⇒ `epochs[]` 填多个，`outputId` 用 `out-1/out-2/...`。

**M0 只落 06 / 24 两场简版**（简版 = 只取该场最有代表性的 1–2 个回合，不求全场覆盖）。其余 07 / 09 / 13 三场 + 06/24 全量版在 M4 补齐。

### 2.5 修改文件（M0 动 v2 的唯一理由：差分测试的地基）

**原则：v2 行为零变化**——把内部自产的值改为由调用方显式传入，调用方传入的正是它现在会自产的那个值。

| 文件                        | 函数                                          | 改动点                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `combat-damage.ts`          | `performAttackCheck`（:382，问题在 :392-408） | `AttackCheckInput.d20Roll: number` ⇒ `rolls: [number, number?]`。删除 :394 / :401 两处 `Math.random()` 模拟第二骰。优势分支取 `Math.max(rolls[0], rolls[1])`，劣势取 `Math.min`，同层级只用 `rolls[0]`。**`rolls[1]` 缺省时**（同层级）不参与计算                                                                                                            |
| `combat-pipeline.ts`        | :256 `performAttackCheck({...})` 调用点       | 传 `rolls: [d20, d20]`（v2 现在的行为等价物——第二骰 v2 本来就是伪造的，这里传同值保持"有第二骰"结构，数值行为由测试锁定；若现有测试断言了具体 advantage 结果，改传能复现该结果的两颗值）                                                                                                                                                                     |
| `combat-resolver.ts`        | :143 同上                                     | 同上                                                                                                                                                                                                                                                                                                                                                         |
| `combat-pipeline.ts`        | :215-220 `resolveIntention({...})` 调用点     | ⚠️ **签名无需改**——`IntentionCheckInput` 已有 `attackerD20` / `defenderD20` 两个独立字段（combat-intention.ts:83-84）。C5 的 bug 在**调用点**把 `input.d20Intention ?? 10` 同时喂给两侧。M0 只把调用点改为接受两个入参（新增 `d20IntentionAttacker` / `d20IntentionDefender`，v2 调用方暂传同值以保行为不变）；真正的双骰在 M1 由内核从 `intentCheck` 通道取 |
| `combat-morale-pipeline.ts` | `runMoraleCheckPipeline`（:61）               | 删除 `d20Roll?: number` 的可选性与 `d20Roll ?? 10` 默认值（:69），改为**必传** `d20Roll: number`                                                                                                                                                                                                                                                             |
| `combat-pipeline.ts`        | :345 `runMoraleCheckPipeline(...)` 调用点     | 显式传 `10`（v2 现行为等价），M1 起 v3 从 `statusContest` 通道取真骰                                                                                                                                                                                                                                                                                         |
| `types.ts`                  | `AppSettings`                                 | 新增 `combatEngineVersion: 'v2' \| 'v3'`，默认 `'v2'`（settings 迁移给默认值，不需要 DB 版本升级）                                                                                                                                                                                                                                                           |

### 2.6 测试清单

| 文件                                   | 关键用例                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/dice-tape.test.ts`          | `draw 只推进目标通道 cursor` / `draw 越界返回 exhausted 且不推进` / `beginEpoch 重置全部 cursor 并归档旧 epoch` / `splitSixty 按 32-10-7-6-5 切分` / `channelSplit 之和非 60 时 createTape 抛错` / `exhausted epoch 的余骰不可再取` |
| `combat-v3/replay.test.ts`             | `同 fixture 两次 replay 结果深相等` / `replay 不产生副作用（无 DB / 无 store 写入）` / `milestone 不匹配时报出期望与实际`                                                                                                           |
| `combat-v3/no-nondeterminism.test.ts`  | `combat-v3 目录内无 Math.random` / `无 new Function 或 eval`                                                                                                                                                                        |
| `combat-damage.test.ts`（改）          | 现有用例全绿；新增 `优势取两颗骰较大者` / `劣势取较小者` / `同层级忽略第二颗骰`                                                                                                                                                     |
| `combat-intention.test.ts`             | 现有全绿（签名未变）                                                                                                                                                                                                                |
| `combat-morale-pipeline.test.ts`（改） | 现有全绿（调用方补传 `10`）；新增 `d20Roll 必传—省略时 TS 编译失败`（用 `@ts-expect-error` 断言）                                                                                                                                   |

### 2.7 样本验证

06 / 24 简版 fixture 的 milestone 断言在 `replay.test.ts` 中跑（M0 阶段内核未就位，只验证 fixture 能被解析、骰带能按序供骰、milestone 结构合法）。

### 2.8 不变量与 Critical/Major 核对

| 项                                         | M0 状态                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| 不变量③（骰子仅来自 DiceTape）             | 🟡 基础设施就位，内核 M1 接入                               |
| M-5（优劣势第二骰是 `Math.random()` 伪造） | ✅ **修复**（`Math.random()` 从 `performAttackCheck` 移除） |
| C5（意图对抗共用一颗骰）                   | 🟡 签名/调用点铺路，真正双骰 M1                             |
| M-4（战意骰恒 10）                         | 🟡 默认值删除，真骰 M1                                      |

### 2.9 风险与回滚

- M0 唯一的破坏性动作是三处签名改造。**回滚方式**：三个 commit 分开提（`dice-tape` / `replay` / `signature-refactor`），签名改造出问题单独 revert 即可，不影响 combat-v3 新目录；
- 若 `performAttackCheck` 的现有测试在改造后断言不上（因为 v2 原来的第二骰是随机的，测试可能用了 mock 或容差），**允许调整该测试为传入固定两颗骰**——这正是改造的目的（确定性），在 PR 说明里记一行。

---

## 3. M1 — 内核骨架：状态机 + 行动槽 + 原子提交 + 唯一终局

### 3.1 目标与验收

| #     | 验收断言                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1-1  | 单位必须消费完攻击槽 + 动作槽（或显式 `PassAttack` / `PassAction`）才推进到下一单位；未消费完时 `dispatch` 返回 `RequiredInput.PlayerCommand` 而非推进 |
| A1-2  | 非法 Command（错 phase / stale revision / 目标不在场 / 槽位已耗尽）返回 `rejection`，且 `events.length === 0`、DiceTape 各通道 cursor 完全不变         |
| A1-3  | 同 `commandId` 重复 dispatch 返回**首次**的 Transition（深相等），骰子不二次消费                                                                       |
| A1-4  | 一次 Command 的全部变更在末尾一次提交：中途抛错时 state 完全不变（用注入的会抛错的 handler 验证）                                                      |
| A1-5  | `round.open` 结算增益、`round.close` 结算减益/DoT，buff `remainingTime` 真实递减并到期移除（M-1 修复）                                                 |
| A1-6  | 终局四出口（HP 全灭 / 士气溃逃 / 逃跑成功 / `forceTerminal`）任一成立即进 Terminal，`dispatch` 此后只接受 `RequestSettlement`                          |
| A1-7  | `settle` 幂等：同 `settlementId` 二次调用返回既有结果，不产生第二套 EXP/FP（C3 修复）                                                                  |
| A1-8  | 意图对抗消费 `intentCheck` 通道**两颗**独立骰（C5 修复）；士气 d20 从 `statusContest` 取（M-4 修复）                                                   |
| A1-9  | 非致死攻击不致死：`checkNonLethal` 在伤害结算后、`unit.beforeDown` 前调用，HP 锁 1 + 施加[昏迷]（C6 修复）                                             |
| A1-10 | 最终伤害 `>= 0`（C7 修复）；负 modifier 不产生治疗                                                                                                     |

### 3.2 新建文件

| 文件                             | 关键签名                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/state.ts`             | `createCombatState(bundle: CombatDefinitionBundle): CombatState`；`toView(state): Readonly<CombatView>`；`applyPending(state, changes: PendingChangeSet): CombatState`（唯一的状态写入函数） |
| `combat-v3/kernel.ts`            | `createSession(bundle, initial?): CombatSession`。内部持有 `state` + `Map<commandId, CombatTransition>` 幂等缓存 + `dispatch` 循环（调 `reduce` → 若无 `requiredInput` 则继续自动推进）      |
| `combat-v3/reducer.ts`           | `reduce(bundle, state, command): CombatTransition`。**唯一**入口，内部按 `state.phase` 查推进表分发到 `phases/*`                                                                             |
| `combat-v3/phases/round.ts`      | `handleRoundOpen` / `handleRoundClose`                                                                                                                                                       |
| `combat-v3/phases/initiative.ts` | `handleInitiative`（调 v2 `rollInitiative`，骰值从 `initiative` 通道取）                                                                                                                     |
| `combat-v3/phases/unit-turn.ts`  | `handleUnitTurnOpen` / `consumeSlot` / `handleUnitTurnClose`                                                                                                                                 |
| `combat-v3/phases/attack.ts`     | `handleAttack`（微步骤链见 §3.4）                                                                                                                                                            |
| `combat-v3/phases/action.ts`     | `handleAction`（道具/移动/专注/防御/逃跑）                                                                                                                                                   |
| `combat-v3/phases/terminal.ts`   | `checkTerminal(state): TerminalReason \| null`；`settle(bundle, state, settlementId): CombatTransition`                                                                                      |
| `combat-v3/rule-keys.ts`         | M1 只注册 `terminal.forceTerminal`（哪怕此时只有内核内部能触发），其余三个 M4 补                                                                                                             |
| `combat-v3/windows.ts`           | M1 **空转版**：`evaluateWindow` 遍历 `ActiveEffectIndex`（此时恒空）返回空 intent 数组。窗口调用点必须**全部就位**，只是没有订阅者                                                           |

### 3.3 reducer 组织

每个 phase handler 是**纯函数**，签名统一：

```ts
type PhaseHandler = (
  bundle: CombatDefinitionBundle,
  state: CombatState,
  input: CombatCommand | AutoStep, // AutoStep = 内核自动推进（无外部输入）
) => MicroStep[];

interface MicroStep {
  kind: 'window' | 'dice' | 'compute' | 'emit' | 'phase';
  run: (ctx: StepCtx) => StepResult; // 只往 pendingChanges 追加，不写 state
}
```

**状态机推进表**（直接照架构 §二 2.4，写成数据而非 if-else）：

| 当前 phase          | 触发                     | 下一 phase            |
| ------------------- | ------------------------ | --------------------- |
| `CombatOpen`        | auto                     | `RoundOpen`           |
| `RoundOpen`         | auto（正面 tick + 总览） | `Initiative`          |
| `Initiative`        | auto（掷先攻）           | `UnitTurnOpen`        |
| `UnitTurnOpen`      | auto                     | `SlotConsume`         |
| `SlotConsume`       | Command（槽位未耗尽）    | `SlotConsume`         |
| `SlotConsume`       | 两槽已处理               | `MoraleCheck`         |
| `MoraleCheck`       | auto                     | `UnitTurnClose`       |
| `UnitTurnClose`     | 还有单位                 | `UnitTurnOpen`        |
| `UnitTurnClose`     | 单位处理完               | `RoundClose`          |
| `RoundClose`        | 未达终局                 | `RoundOpen`           |
| `RoundClose` / 任意 | `checkTerminal` 非空     | `Terminal`            |
| `Terminal`          | `RequestSettlement`      | `SettlementCommitted` |

### 3.4 攻击微步骤链（`phases/attack.ts`）

```
① check.intent 窗口 → 取 intentCheck 通道 2 颗骰 → resolveIntention（C5 ✅）
② collect_attacker_mods 窗口
③ check.hit 窗口 → 取 attackHit 通道 1~2 颗骰 → performAttackCheck（M-5 ✅）
④ collect_defender_mods 窗口
⑤ damage.compute → runDamagePipeline（v2 §八 8 步）→ clamp ≥ 0（C7 ✅）
⑥ damage.preview 窗口（M1 空转；M3 接 RequestChoice）
⑦ checkNonLethal（C6 ✅）—— 在 ⑧ 之前
⑧ unit.beforeDown 窗口（HP 将 ≤ 0 时）
⑨ damage.after 窗口
⑩ 追加 pendingChanges + DomainEvents，返回
```

### 3.5 M1 范围内接线的修复

| 编号 | 修复内容                                                                                                 | 落点                                  |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| C3   | 终局由内核 `checkTerminal` 判定，不再依赖 Agent 调 `combat_end`；`settle` 按 `settlementId` 幂等         | `phases/terminal.ts`                  |
| C5   | 意图对抗消费两颗独立骰                                                                                   | `phases/attack.ts` 步骤①              |
| C6   | `checkNonLethal` 在伤害结算后、`unit.beforeDown` 前调用                                                  | `phases/attack.ts` 步骤⑦              |
| C7   | 最终伤害 clamp ≥ 0；HP clamp 到 `[0, maxHp]`                                                             | `phases/attack.ts` 步骤⑤ + `state.ts` |
| M-3  | 行动槽强制：`Command.cost` 由内核验证并消费；`resetTurnResources` 改为只给 `canAct && hp > 0` 的单位发槽 | `phases/unit-turn.ts`                 |
| M-4  | 士气 d20 从 `statusContest` 通道取                                                                       | `phases/unit-turn.ts` MoraleCheck 步  |
| M-1  | buff tick 挂 `round.open`（增益）/ `round.close`（减益+DoT）；`tickBuffs` 的 `remaining` **写回** state  | `phases/round.ts`                     |
| M-9  | 攻方 MP/SP 与守方 HP 同在 `pendingChanges` 内一次提交（不再只同步守方）                                  | `phases/attack.ts` 步骤⑩              |

### 3.6 M1 不做

- **不含 automaton**：`windows.ts` 空转（窗口全部触发但 `ActiveEffectIndex` 恒空）。这样骨架可测、M3 接入时只需填索引，窗口调用点不用再动；
- 不含 Coordinator（M2）、不含前端（M2）、不含 DSL（M3）。

### 3.7 测试清单

| 文件                                | 关键用例                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/reducer.test.ts`         | `phase 推进表逐条覆盖` / `非法 phase 的 Command 被 reject` / `stale revision 被 reject 且零骰子消费` / `同 commandId 重复返回首次结果` / `中途抛错时 state 零变化`                                                                                        |
| `combat-v3/phases/phases.test.ts`   | `单位必须消费两槽才推进` / `PassAttack 也消费槽位` / `round.open 结算增益、round.close 结算减益` / `buff remainingTime 递减并到期移除` / `意图对抗用两颗独立骰` / `士气骰来自 statusContest` / `非致死攻击 HP 锁 1 并施加昏迷` / `负 modifier 不产生治疗` |
| `combat-v3/phases/terminal.test.ts` | `HP 全灭进 Terminal` / `士气溃逃进 Terminal` / `逃跑成功进 Terminal` / `forceTerminal 进 Terminal` / `settle 同 settlementId 幂等` / `Terminal 后只接受 RequestSettlement`                                                                                |
| `combat-v3/state.test.ts`           | `applyPending 产生新对象（不可变）` / `revision 单调递增` / `toView 不暴露可变引用`                                                                                                                                                                       |

### 3.8 样本验证

M1 无端到端。用**手工构造的最小 bundle**（2 单位、无 automaton）跑完整 3 回合，断言回合数、槽位消费次数、终局原因。

### 3.9 风险与回滚

- **风险**：phase 推进表写漏一格 ⇒ 死循环。**对策**：`reduce` 内加「单次 dispatch 微步骤上限 200」熔断，超限抛 `KernelStuckError` 并 dump `state.phase` 历史；测试专门覆盖该熔断。
- **回滚**：M1 全部是新文件，v2 路径不受影响（flag 仍是 `'v2'`），可整 PR revert。

---

## 4. M2 — 接线：Coordinator + feature flag + 双投影 + 前端

### 4.1 目标与验收

| #    | 验收断言                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1 | flag = `'v3'` 时，第 09 场 fixture 从 `handleCombatTrigger` 端到端跑通（无 automaton，纯基础攻击 + 意图 + 士气 + 终局），最终一次 `commitChatState` |
| A2-2 | flag = `'v2'` 时行为与 M2 之前**完全一致**（v2 全部战斗测试仍绿）                                                                                   |
| A2-3 | `RequiredInput` 四路由穷尽：`coordinator.ts` 的 switch 漏一路则 TS 编译失败（`never` 兜底）                                                         |
| A2-4 | 放弃战斗：调 `abandon()` 后 session 丢弃、`isGenerating` 解除、FP 不落库（C4 修复）                                                                 |
| A2-5 | 战斗摘要以【战斗摘要】assistant 消息回注 Story（与 v2 一致）                                                                                        |
| A2-6 | 投影 A：29 个 DomainEvent 全部有映射目标（映射为已有 CombatEvent 变体或新增变体），无「静默丢弃」分支                                               |

### 4.2 新建文件

| 文件                            | 关键签名                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/coordinator.ts`      | `runCombatV3(opts: { marker, storyOutput, deps }): Promise<CombatV3Result>`；内部 `routeRequiredInput(req, session): Promise<CombatCommand>`；`abandon(): void`                                          |
| `combat-v3/projection-ui.ts`    | `projectToUi(events: DomainEvent[]): CombatEvent[]`                                                                                                                                                      |
| `combat-v3/projection-agent.ts` | `projectToAgent(state: CombatState): string`（内部调 `combat-panel.ts` 的 `buildOverviewPanel` / `buildInitiativePanel` / `buildFullActionPanel`，数据源改为唯一 CombatState —— 架构 §十三 13.2 投影 B） |

### 4.3 Coordinator：RequiredInput 四路由（伪代码级）

```
routeRequiredInput(req, session):
  switch req.kind:

    case 'PlayerCommand':
      if (req.actorSide === 'player'):
        // → game-store，等前端
        gameStore.setCombatAwaitingInput({ unit, unitId, round, allowedKinds })
        return await gameStore.waitForCombatCommand()      // Promise 在 coordinator 侧，不在内核
      else:
        // → 战斗 Agent
        panel = projectToAgent(session.snapshot)
        result = await agentClient.chatWithTools({
          agent: 'combat', tools: V3_COMBAT_TOOLS, context: panel, maxRounds: MAX_TOOL_ROUNDS })
        return toolCallToCommand(result)                   // 一次工具调用 = 一个 Command

    case 'EffectChoice':
      owner 属玩家 → 前端格挡询问 UI；否则 → 战斗 Agent（同上，工具 declare_action/pass_slot）

    case 'BeginOutput':
      dice = drawSixtyD20()                                 // coordinator 自己产（唯一合法骰源入口）
      return { kind: 'SupplyDice', payload: { outputId, dice, channelSplit: DEFAULT_SPLIT } }

    case 'BoundedAdjudication':   // M3.5 实现，M2 先 throw UnsupportedInM2
    case 'CharGenRequest':        // M3.5 实现，M2 先 throw UnsupportedInM2

    default:
      const _exhaustive: never = req     // ← 漏一路编译不过
}
```

### 4.4 战斗 Agent 的 v3 工具集

**替换** v2 的 `AGENT_TOOL_MAP['combat']`（agent-tools.ts:716-740 的 19 个工具）。v3 工具集只有 6 个：

| 工具                  | schema 说明                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `declare_attack`      | `{ actorName, targetName, skillName?, intentionLevel, costs? }` → 内核 `DeclareAttack`。**不含骰值参数**          |
| `declare_action`      | `{ actorName, actionType: '道具'\|'移动'\|'专注'\|'防御'\|'格挡', payload }` → `DeclareAction` / `DeclareBlock`   |
| `pass_slot`           | `{ actorName, slot: 'attack'\|'action' }` → `PassAttack` / `PassAction`                                           |
| `flee`                | `{ actorName }` → `Flee`                                                                                          |
| `submit_adjudication` | `{ effectDescription, divinity, verifiableBounds, requestedRuleOverride?, reason }` → `Adjudicate`（M3.5 才启用） |
| `write_summary`       | `{ text }` ≤500 字 → 终局摘要（不产 Command，coordinator 直接收）                                                 |

**移除**（v3 内核接管，AI 不得再碰）：`combat_start` / `combat_end`（终局由内核判）、`roll_d20` / `roll_d100` / `roll_dice`（不变量③）、`status_apply` / `status_remove`（走 EffectIntent）、`combat_block` / `combat_move` / `combat_focus` / `combat_use_skill` / `combat_use_item`（并入 `declare_action`）。

**保留只读**：`get_character` / `get_hp_percent` / `get_inventory` / `get_combat_state`（后者改为返回 `projectToAgent` 的文本面板）。

**工具结果 = CombatTransition 的 Agent 投影**：每次工具调用返回 `projectToAgent(transition.snapshot)` 的文本面板 + 本次 `events` 的中文摘要行。

**`MAX_TOOL_ROUNDS` 语义变化**：v2 是 40 次「自由发挥」预算（`combat-runner.ts:123`）。v3 中**一次工具调用 = 一个 Command = 一个槽位或一次 pass**，所以预算含义变成「本次 Agent 决策轮的 Command 数上限」，**降到 8**（一个单位最多 attack + action + 若干 pass/adjudication）。超限即视为 Agent 卡死，coordinator 自动补 `PassAttack` + `PassAction` 推进。

### 4.5 game-store 改造清单

`src/ui/stores/game-store.ts`：

| 改动                                                    | 细节                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删 `combatSubmitter` ref（:97、:136、:141、:104、:154） | 裸函数引用模式与 `commandId + expectedRevision` 不兼容                                                                                                     |
| 新增 `combatCoordinator` 句柄                           | `ref<CombatCoordinatorHandle \| null>(null)`，暴露 `submitCommand` / `abandon`                                                                             |
| 新增 action `submitCombatCommand(partial)`              | 内部补 `commandId`（uuid）+ `expectedRevision`（从 `activeCombat.revision` 读），再转交句柄                                                                |
| `applyCombatEvent`（:110-127）                          | 改吃**投影 A 输出**（`projectToUi` 的结果），新增 CombatEvent 变体的分支                                                                                   |
| `combatAwaitingInput`（:93）                            | 扩展为 `{ unit, unitId, round, requiredInputKind, allowedKinds }`，供四态 UI 分流                                                                          |
| 新增 `abandonCombat()`                                  | 调句柄 `abandon()` → 丢弃 session → `exitCombat()`。**C4 修复**：v3 的 RequiredInput 模型天然可取消（内核不挂 Promise，Promise 在 coordinator 侧且可拒绝） |

### 4.6 投影 A 映射表（DomainEvent → CombatEvent）

| DomainEvent                                           | CombatEvent 目标                                    |
| ----------------------------------------------------- | --------------------------------------------------- |
| `CombatOpened`                                        | `combat_started`（已有）                            |
| `RoundOpened`                                         | `round_divider`（已有，修 N9「第 1 回合无分隔线」） |
| `InitiativeRolled`                                    | 🆕 `initiative_rolled`                              |
| `TurnOpened`                                          | `turn_started`（已有）                              |
| `TurnClosed`                                          | 🆕 `turn_ended`                                     |
| `RoundClosed`                                         | 合并进下一个 `round_divider`，不单独发              |
| `CombatEnded`                                         | `combat_ended`（已有）                              |
| `SettlementCommitted`                                 | 🆕 `settlement`（EXP/FP/战利品面板）                |
| `AttackDeclared` / `AttackResolved` / `DamageApplied` | `action`（已有，合成一张 `CombatActionCard`）       |
| `HpFloored` / `UnitDowned` / `UnitDefeated`           | 🆕 `unit_state_changed`                             |
| `StatusApplied` / `StatusRemoved` / `StatusExpired`   | 🆕 `status_changed`                                 |
| `ResourceSpent`                                       | 并入 `action` 卡片的消耗行                          |
| `MoraleChanged`                                       | 🆕 `morale_changed`                                 |
| `UnitSummoned` / `UnitDespawned`                      | 🆕 `roster_changed`（CombatUnitCard 增删）          |
| `DamagePrevented` / `DamageReflected`                 | 🆕 `special_damage`（独立视觉）                     |
| `MiracleTriggered` / `NarrativeCue`                   | `narrative`（已有）                                 |
| `AdjudicationAccepted` / `RuleOverridden`             | 🆕 `rule_override`（面板顶部横幅）                  |
| `EffectRejected`                                      | 🆕 `effect_rejected`（默认折叠，调试可见）          |
| `DiceEpochBegan`                                      | 🆕 `dice_epoch`（骰池加载态用）                     |

**约束**：`projectToUi` 对 `DomainEvent` 做穷尽 switch，漏一个编译不过（同 R6 手法）。

### 4.7 前端四态等待 UI

| 态                                | 组件归属                                                           | 最小 UI                                                                           |
| --------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `EffectChoice`（格挡询问）        | **`CombatActionBar.vue` 扩展**（不新建组件——它已有锁定态基础设施） | 顶部条：「即将受到 487 伤害 · 格挡？(消耗 SP50 + 动作槽)」+ 是/否两个 `AppButton` |
| `BoundedAdjudication`（裁决确认） | **新建 `CombatAdjudicationCard.vue`**（放消息流内，需展示长文本）  | 卡片：Agent 的 `effectDescription` + `reason` + divinity 徽章 + 确认/驳回         |
| `CharGenRequest`（召唤中）        | `CombatUnitCard.vue` 内的骨架占位                                  | 半透明卡片 + 「召唤中…」+ 来源物品名                                              |
| `BeginOutput`（骰池加载）         | `CombatHeader.vue` 右侧小指示器                                    | 一行小字「骰池续杯 (第 N 次)」，**必须轻**——第 07 场单场 9 次                     |

全部遵循 `docs/design.md`（间距 token / 品质色 / `prefers-reduced-motion`）。

### 4.8 修改文件

| 文件                                                  | 改动点                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/lib/game-pipeline.ts`                         | `handleCombatTrigger`（:1045）加 flag 分支：`'v2'` 走现有 `runCombat`（:1055-1061）；`'v3'` 走 `import('@engine/combat-v3').openCombat` + coordinator |
| `src/ui/stores/game-store.ts`                         | 见 §4.5                                                                                                                                               |
| `src/sillytavern/agent-tools.ts`                      | 新增 `AGENT_TOOL_MAP['combat_v3']`（6 工具 + 4 只读）；**不动** `['combat']`（v2 回滚要用）                                                           |
| `src/sillytavern/agent-config.json`                   | 新增 `combat_v3` agent 条目（prompt 改写在 M3.5，M2 先放最小可用版：逐 Command 决策、不掷骰、不判终局）                                               |
| `src/ui/components/game/combat/CombatActionBar.vue`   | 扩展 EffectChoice 态 + 改调 `submitCombatCommand`                                                                                                     |
| `src/ui/components/game/combat/CombatHeader.vue`      | 数据源改 CombatView + 骰池指示器                                                                                                                      |
| `src/ui/components/game/combat/CombatUnitCard.vue`    | 支持动态增删 + 召唤中骨架                                                                                                                             |
| `src/ui/components/game/combat/CombatMessageFlow.vue` | 订阅新 CombatEvent 变体                                                                                                                               |
| `src/ui/components/game/combat/CombatPanel.vue`       | 数据源改投影 + 新增关闭/放弃按钮（C4）                                                                                                                |

### 4.9 测试清单

| 文件                                 | 关键用例                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/coordinator.test.ts`      | `PlayerCommand 路由到 store` / `敌方 PlayerCommand 路由到 Agent` / `BeginOutput 自动注骰` / `MAX_TOOL_ROUNDS 超限自动 pass` / `abandon 后不落库` / `终局只调一次 commitChatState` |
| `combat-v3/projection-ui.test.ts`    | `29 个 DomainEvent 全部有映射（穷尽）` / `新增变体字段完整`                                                                                                                       |
| `combat-v3/projection-agent.test.ts` | `文本面板从唯一 CombatState 取数` / `与 combat-panel 格式一致`                                                                                                                    |
| `game-store.test.ts`（改）           | `submitCombatCommand 自动补 commandId/expectedRevision` / `abandonCombat 清理干净`                                                                                                |
| `combat-v3/fixtures/case-09` 端到端  | 见 §4.10                                                                                                                                                                          |

### 4.10 样本验证

**第 09 场 fixture 端到端**：`case-09-concept.fixture.json`（M2 落地）。该场无 automaton（认知剥夺走 M3.5 的裁决，M2 先用内核内部 `forceTerminal` 桩触发），压测的是基础攻击 + 意图对抗 + 士气 + 非 HP 终局。断言 milestone：`roundCount: 4` / `damage`（真理火球）/ `terminal.reason: 'force_terminal'` / `fpDelta`。

### 4.11 不变量与 Critical/Major 核对

| 项                                             | M2 状态                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| C2（combat 工具通道缺 7 个 case）              | ✅ **消解**——v3 工具集只有 6+4 个且全部实现，不存在缺 case               |
| C3（`combat_end` 不结束战斗）                  | ✅ M1 已修，M2 端到端验证                                                |
| C4（玩家暂停无法取消）                         | ✅ **修复**（abandon 流程 + CombatPanel 逃生口）                         |
| M-13（未调 `combat_start` 战斗蒸发）           | ✅ **消解**——v3 由内核 `openCombat` 开战，不依赖 Agent 调用              |
| M-2（链式脚本系统未通电）                      | 🟡 M3 接入                                                               |
| N9（第 1 回合无分隔线 / enterCombat 不开面板） | ✅ 顺带修（`CombatOpened` → 立即开面板；`RoundOpened` → 每轮都发分隔线） |

### 4.12 风险与回滚

- **风险**：game-store 改造影响 v2 路径。**对策**：`applyCombatEvent` 保留 v2 分支（v2 发的还是老 CombatEvent），新变体只在 v3 路径出现；
- **回滚**：flag 打回 `'v2'` 即恢复。M2 的 PR 必须包含一条「flag=v2 全量回归绿」的证据。

---

## 5. M3 — 效果系统：DSL + 编译链 + damage.preview

### 5.1 目标与验收

| #    | 验收断言                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3-1 | 表达式 parser 对每类非法输入抛 `ExprSyntaxError` 且**带列号**；白名单外 token（`eval` / `new` / `[` / `=`）一律拒绝                                                         |
| A3-2 | `evaluate` 零 eval：`no-nondeterminism.test.ts` 仍绿                                                                                                                        |
| A3-3 | `compileEffectProgram` 对不合规 automaton 在**编译期**剔除并返回 `errors[]`，运行时不出现该 automaton                                                                       |
| A3-4 | modifier push-handler：装备一件带 `modifiers[]` 的物品后，`collect_attacker_mods` 窗口能收到对应 `ModifierIntent`（ADR-29，架构 §七 7.4 ①）                                 |
| A3-5 | `damage.preview` 全流程：伤害算出 → 有反应 automaton 的单位触发 `RequestChoice` → `RequiredInput.EffectChoice` → `DeclareBlock` → **回到 `damage.compute` 重算** → 487 → 97 |
| A3-6 | 无反应 automaton 的单位受击**不触发暂停**（架构 §五 5.2 约束 3）                                                                                                            |
| A3-7 | intent batch 原子性：batch 内一个 intent 非法 ⇒ 整批 reject + `EffectRejected`，但核心攻击与同窗口其他 automaton 不受影响                                                   |
| A3-8 | 第 24 场反伤 fixture 全绿（含 depth=2 熔断 + 湮灭）                                                                                                                         |

### 5.2 表达式 parser 实施要点

**token 集**：
`NUMBER` / `STRING` / `TRUE` / `FALSE` / `NULL` / `IDENT`（仅 `ctx` 起始的点分路径 + 白名单函数名） / `DOT` / `LPAREN` / `RPAREN` / `COMMA` / `PLUS` / `MINUS` / `STAR` / `SLASH` / `EQ` / `NEQ` / `LT` / `LTE` / `GT` / `GTE` / `AND` / `OR` / `NOT` / `EOF`。

**遇到以下一律词法期报错**：`=`（单等号）、`[` `]`、`{` `}`、`` ` ``、`;`、`=>`、`new`、`function`、`this`、任何不以 `ctx.` 开头且不在函数白名单内的标识符。

**AST 节点类型**：

```ts
type ExprAst =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'path'; segments: string[] } // ctx.self.hpPercent → ['self','hpPercent']
  | { t: 'call'; fn: BuiltinFn; args: ExprAst[] } // BuiltinFn = 'min'|'max'|'floor'|'ceil'|'abs'|'percent'|'has'
  | { t: 'unary'; op: '-' | '!'; operand: ExprAst }
  | { t: 'bin'; op: BinOp; l: ExprAst; r: ExprAst };
```

**递归下降函数清单**（优先级从低到高）：

| 函数           | 处理                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `parseExpr`    | 入口 = `parseOr`                                                                          |
| `parseOr`      | `parseAnd ('\|\|' parseAnd)*`                                                             |
| `parseAnd`     | `parseCmp ('&&' parseCmp)*`                                                               |
| `parseCmp`     | `parseAdd (('=='\|'!='\|'<'\|'<='\|'>'\|'>=') parseAdd)?`（**非结合**——`a < b < c` 报错） |
| `parseAdd`     | `parseMul (('+'\|'-') parseMul)*`                                                         |
| `parseMul`     | `parseUnary (('*'\|'/') parseUnary)*`                                                     |
| `parseUnary`   | `('-'\|'!') parseUnary \| parsePrimary`                                                   |
| `parsePrimary` | 字面量 / `ctx.` 路径 / 白名单函数调用 / `( parseExpr )`                                   |

**错误消息格式**：`ExprSyntaxError: 第 N 列: 意外的 token 「xxx」，期望 <期望集>`。`N` 是**源字符串的 1-based 列号**。

**解释器**：`evaluate(ast, ctx): number | string | boolean`。除法零除返回 `0`（不抛）。`path` 解析走 `ctx` 的类型化白名单（架构 §七 7.3 表），未定义路径 ⇒ 抛 `ExprEvalError`（该 automaton 整批 reject，走错误隔离）。

**ctx 按窗口分型的 TS 定义方式**：

```ts
type WindowCtxMap = {
  'damage.after': {
    self: UnitCtx;
    target: UnitCtx;
    damage: DamageCtx;
    round: RoundCtx;
    depth: number;
    charges: ChargeCtx;
  };
  'unit.beforeDown': { self: UnitCtx; damage: DamageCtx; round: RoundCtx; charges: ChargeCtx };
  // … 每个 WindowKey 一行
};
type WindowCtx<K extends WindowKey> = WindowCtxMap[K];
```

编译期用 `WindowCtxMap[subscribe]` 的键集校验 automaton 里出现的 `ctx.*` 路径根段。

### 5.3 内建 adapter 注册表（`automata/builtins.ts`）

v2 六大效果类别（v2 §四 4.1）的常见词条 → 可信 TS automaton。**起步集 12 条**：

| #   | 词条形态                           | 类别            | 编译为                                                                                      |
| --- | ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | 「攻击时 +N 物理伤害」             | 固伤            | `collect_attacker_mods` → `AddModifier(slot:'fixedDamage', scope:'whole_action')`           |
| 2   | 「伤害 +N%」                       | 百分比          | `collect_attacker_mods` → `AddModifier(slot:'damageMult')`                                  |
| 3   | 「受到伤害 -N%」                   | 百分比          | `collect_defender_mods` → `AddModifier(slot:'damageTaken')`（**修 M-6**：守方百分比进管线） |
| 4   | 「命中 +N」                        | 检定            | `check.hit` → `AddModifier(slot:'hitBonus')`                                                |
| 5   | 「闪避 +N」                        | 检定            | `check.hit` → `AddModifier(slot:'dodge')`                                                   |
| 6   | 「先攻 +N」                        | 检定            | `initiative.before` → `AddModifier(slot:'initiative')`                                      |
| 7   | 「DR N%」                          | 特殊机制        | `collect_defender_mods` → `AddModifier(slot:'dr')`                                          |
| 8   | 「穿透 N%」                        | 特殊机制        | `collect_attacker_mods` → `AddModifier(slot:'penetration')`                                 |
| 9   | 「反弹 N% 伤害」                   | 特殊机制        | `damage.after` → `Schedule(DealDamage isReaction)` — 见 §九                                 |
| 10  | 「吸血 N%」                        | 资源            | `damage.after` → `Heal(self, ctx.damage.final * N)`                                         |
| 11  | 「护盾 N」                         | 资源            | `turn.open` → `ApplyStatus('护盾', layers:N)`                                               |
| 12  | 「每回合扣 N% maxHp，持续 X 回合」 | 附加效果（DoT） | `round.close` → `DealDamage` + duration 递减                                                |
| 13  | 「每回合回 N HP」                  | 附加效果（HoT） | `round.open` → `Heal`                                                                       |
| 14  | 「暴击率 +N%」                     | 检定            | `check.hit` → `AddModifier(slot:'critThreshold')`（v2 §四 4.3 转化表：暴击率 ⇒ 检定修正）   |
| 15  | 「X 次/战斗」                      | —               | 编译为 automaton 的 `charges: { max: X, remaining: X }`                                     |

映射由 `effect-parser.ts` 的 `ParsedEffect` 驱动（架构 §七 7.4 ②）。**不匹配任何内建条目的 ParsedEffect** ⇒ 落到 ③ 走 DSL 或产 `UnsupportedCapability`。

### 5.4 damage.preview 全流程时序（文字版）

```
① phases/attack.ts 步骤⑤ 算出 final = 487，写入 frame.pendingChanges（未提交）
② 进入 damage.preview 窗口：
   windows.evaluateWindow 先查 ActiveEffectIndex.byWindow['damage.preview']
   ├─ 空 → 直接跳过窗口，继续步骤⑦（无暂停，架构 §五 5.2 约束 3）
   └─ 非空 → 逐个求值（按 §五 5.3 排序）
③ 诺娅的「格挡」automaton trigger 命中 → 返回 RequestChoiceIntent
   { choiceId, prompt: '格挡？', options: ['是','否'], cost: { sp: 50, slot: 'action' } }
④ reducer 冻结 ResolutionFrame（step='damage.preview', queueCursor, executedReactionIds,
   pendingChanges, diceConsumedInFrame），返回 RequiredInput.EffectChoice
⑤ coordinator 路由到前端 CombatActionBar 的格挡询问态
⑥ 玩家点「是」→ submitCombatCommand({ kind:'DeclareBlock', cost:'action', payload:{ choiceId } })
⑦ reducer 从 frame 恢复（不重跑步骤①-③、不重取骰）：
   格挡 intent batch = [ AddModifier(slot:'damageTaken', value:-0.8, scope:'whole_action'),
                         Override(免疫拖拽), SpendResource(SP,50) ]
⑧ ★ 回到 damage.compute 重算（不是在 487 上打折）→ 487 × 0.2 = 97
⑨ 步骤⑦（checkNonLethal）→ ⑧（beforeDown）→ ⑨（damage.after）照常
⑩ 一次原子提交：DamageApplied(诺娅,-97) + ResourceSpent(SP,50) + ActionSlotConsumed
```

### 5.5 combat-item-validator 演进的校验清单

`combat-item-validator.ts` 从运行时校验器改造为**编译期**校验器（架构 §七 7.4）。`compileEffectProgram` 内逐条执行：

| #   | 校验项                                                           | 失败处理               |
| --- | ---------------------------------------------------------------- | ---------------------- |
| 1   | `subscribe` ∈ ReactionWindow 清单（架构 §五 5.1，18 个）         | 剔除 + `errors.push`   |
| 2   | `trigger` 表达式文法合规（§5.2）                                 | 剔除 + 带列号错误      |
| 3   | `intents[].kind` ∈ 8 大类 + Outcome 子类（架构 §六 6.1）         | 剔除                   |
| 4   | `OverrideIntent.ruleKey` ∈ closed RuleKey 白名单（架构 §八 8.2） | 剔除                   |
| 5   | `divinity` ≤ 所有者装备/技能声明的 divinity                      | 剔除                   |
| 6   | 数值范围按品质上限 clamp（v2 §13.2 决策 j）                      | clamp + warn（不剔除） |
| 7   | `ctx.*` 路径根段 ∈ `WindowCtxMap[subscribe]` 的键集              | 剔除                   |
| 8   | 五维直改检测（v2 §四 4.1 铁律：五维只能走检定修正）              | 剔除 + 明确错误文案    |
| 9   | buff id 带上级前缀（v2 §5.2）                                    | warn + 自动补前缀      |

### 5.6 新建文件

`automata/parser.ts` / `automata/interpreter.ts` / `automata/compile.ts` / `automata/builtins.ts` / `automata/index-active.ts` + 各自 `*.test.ts`。`windows.ts` 从空转改为实装。`intents.ts` 实装。

### 5.7 修改文件

| 文件                         | 改动点                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `combat-v3/windows.ts`       | 空转 → 实装：求值排序（架构 §五 5.3）、在场过滤、错误隔离、预算 64                             |
| `combat-v3/phases/attack.ts` | 步骤⑥ `damage.preview` 接 `RequestChoice` → 冻结 frame；步骤⑦ 恢复后回到 `damage.compute` 重算 |
| `combat-v3/reducer.ts`       | `DeclareBlock` Command 的 frame 恢复分支                                                       |
| `combat-v3/state.ts`         | `ResolutionFrame` 的冻结/恢复辅助                                                              |
| `combat-item-validator.ts`   | 导出编译期校验函数供 `compile.ts` 调用（保留 v2 运行时入口不删）                               |

### 5.8 测试清单

| 文件                               | 关键用例                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `automata/parser.test.ts`          | 每个优先级层级各 1 例 / `a < b < c 非结合报错` / `= 报错带列号` / `[ 报错` / `eval( 报错` / `未知标识符报错` / `ctx 路径解析` |
| `automata/interpreter.test.ts`     | 算术/比较/逻辑/一元 / `除零返回 0` / `白名单函数 min max floor percent has` / `未定义 ctx 路径抛 ExprEvalError`               |
| `automata/compile.test.ts`         | 9 条校验项逐条 1 个反例 / `errors[] 结构` / `合规 automaton 进 index`                                                         |
| `automata/builtins.test.ts`        | 15 条内建映射逐条断言编译结果的 window + intent kind                                                                          |
| `automata/index-active.test.ts`    | `buildIndex 按 window 分组并排序` / `ApplyStatus 增量加 automaton` / `离场移除`                                               |
| `combat-v3/windows.test.ts`        | `求值顺序 = window→divinity→priority→id` / `owner 离场跳过` / `单个抛错只废该批` / `超 64 个截断并 EffectRejected`            |
| `combat-v3/intents.test.ts`        | `batch 内一个非法整批 reject` / `核心攻击不受影响` / `EffectRejected code 枚举齐全`                                           |
| `combat-v3/phases/preview.test.ts` | `无订阅者不暂停` / `有订阅者暂停并冻结 frame` / `恢复不重取骰` / `487→97 重算路径`                                            |

### 5.9 样本验证

**第 24 场反伤 fixture 全绿**（`case-24-reflection.fixture.json` 升级为全量版）：断言 `damage`（星屑连袭 8535）/ `reflected`（depth=1，基准取 `preReduction`）/ `depth=2 熔断产 NarrativeCue('反射湮灭')` / `反伤不消耗攻击槽` / `反伤命中骰走 attackHit 通道`。

### 5.10 不变量与 Critical/Major 核对

| 项                                          | M3 状态                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| C1（沙盒不是沙盒）                          | ✅ **战斗内消解**（DSL 零 eval）。⚠️ 战斗外 `script-executor.ts` 遗留，非本 plan 范围                                                |
| M-2（链式脚本未通电）                       | ✅ **消解**（ActiveEffectIndex 是唯一路径且必然通电）                                                                                |
| M-6（modifier 不分 target、守方百分比丢弃） | ✅ **修复**（builtins #2/#3 分别进攻/守窗口）                                                                                        |
| M-11（script-registry 僵尸订阅）            | ✅ **战斗内消解**（ActiveEffectIndex 是派生的，无注册闭包）。战斗外遗留                                                              |
| M-12（递归防护失效）                        | ✅ **修复**（窗口递归 ≤5 + 反射 depth ≤2 + 预算 64）                                                                                 |
| M-14（事件顺序与 §6.3 相反）                | ✅ **消解**（v3 微步骤链 §3.4 顺序由内核固定，`check.hit` 掷骰在 `collect_attacker_mods` 之后但骰值通过 ctx 暴露给 `damage.*` 窗口） |
| M-15（handler 漏 return 抛 TypeError）      | ✅ **消解**（automaton 返回 intent batch，不改共享对象；返回 `undefined` 视为空 batch）                                              |
| 不变量①豁免                                 | ✅ `isReaction` + `doesNotConsumeSlot` 生效                                                                                          |

### 5.11 风险与回滚

- **风险**：parser 与解释器的 ctx 类型分型工作量被低估。**对策**：M3 允许先只实装 5 个高频窗口的 ctx 分型（`check.hit` / `collect_*_mods` / `damage.preview` / `damage.after` / `unit.beforeDown`），其余窗口的 ctx 用最小公共集，M4 补全，在 PR 里标注；
- **回滚**：`ActiveEffectIndex` 置空即退化为 M2 行为（内核仍可跑），是天然的降级开关。

---

## 6. M3.5 — 开放性出口：CharGenRequest + BoundedAdjudication + prompt 改写

### 6.1 目标与验收

| #     | 验收断言                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| A35-1 | `SpawnUnit` 且 `templateRef` 缺省 ⇒ dispatch 冻结 frame 返回 `RequiredInput.CharGenRequest`（内核不存 Promise）                  |
| A35-2 | `SupplyUnit` 注入后：`joinTiming:'this_round_tail'` 掷一颗 `initiative` 骰插入当前回合先攻**尾部**；`'next_round_head'` 下轮参与 |
| A35-3 | `duration.rounds` 到期在 `round.close` 移除，产 `UnitDespawned`，且其 automaton 从 `ActiveEffectIndex` 摘除                      |
| A35-4 | `ProposedAdjudication` 的 `divinity < 5` 被 reject（架构 §十一 11.4 硬门槛）                                                     |
| A35-5 | 裁决通过 ⇒ 产 `AdjudicationAccepted` + `RuleOverridden`（或 `MiracleTriggered`），并进 journal 带 `reason`                       |
| A35-6 | 第 06 场 fixture 端到端（召唤 2 食尸鬼、当回合参战、3 回合后消失、FP 100 扣费）                                                  |

### 6.2 CharGenRequest 时序

```
① phases/action.ts 或 windows 产出 SpawnOrDespawnIntent{ templateRef: undefined }
② intents.ts 验证通过 → reducer 冻结 ResolutionFrame
   （step='spawn', pendingChanges 已含 SpendResource(FP,100) 但未提交）
   → 返回 RequiredInput.CharGenRequest{ requestId, prompt, constraints }
③ coordinator 路由：
   a. 先查预生成召唤物池（§6.4）；命中 → 直接构造 SummonedUnitDefinition
   b. 未命中 → await runCharGenChain({ prompt, constraints })   ← char-gen-agent.ts 新入口
④ 解析校验 SummonedUnitDefinition：
   - divinity ≤ constraints.divinityCap（超出 → clamp + warn）
   - 属性总和 ≤ constraints.attributeBudget（超出 → 按比例缩放）
   - joinTiming ∈ {'this_round_tail','next_round_head'}（缺省 → 'next_round_head'）
   - 自带 automaton 走 compileEffectProgram（编译失败的剔除，不阻断召唤）
⑤ coordinator 提交 { kind:'SupplyUnit', payload:{ requestId, definition } }
⑥ reducer 从 frame 恢复：
   - 插入 state.units
   - joinTiming='this_round_tail' → draw(initiative,1) → 插先攻序列尾部
   - actionEconomy 决定本轮槽位（full=1攻1动 / partial=仅动作 / no_action=0）
   - duration → ApplyStatus('召唤时限', rounds)
   - automaton 增量进 ActiveEffectIndex
⑦ 与 SpendResource(FP,100) 同一次原子提交 → UnitSummoned + ResourceSpent
```

### 6.3 `char-gen-agent.ts` 新增入口

```ts
export async function runCharGenForCombat(req: {
  prompt: {
    race?: string;
    tier?: number;
    role?: string;
    sourceItem: string;
    summonerIntent: string;
  };
  constraints: { divinityCap: number; attributeBudget: number; durationRounds?: number };
  deps: CharGenDeps;
}): Promise<SummonedUnitDefinition>;
```

与现有 Stage2 `request_dispatcher` 异步检测新 NPC 的路径**并列存在**，不改现有入口。差异：现有是「战斗外、批量、落库」；新入口是「战斗中、单个、不落库」（召唤物只活在 CombatState 内，终局才决定是否落库）。

### 6.4 预生成召唤物池（可选，标注）

> ⚠️ **可选增强**，M3.5 不做也能验收。若做，最小实现：

- `combat-v3/summon-pool.ts`：`SUMMON_POOL: Record<string, SummonedUnitDefinition>`，key 为「种族+层级+定位」（如 `亡灵-T3-近战`）；
- `coordinator` 在 ③a 按 `prompt.race/tier/role` 做精确匹配，命中即用，未命中走实时 char_gen；
- 池内容由离线脚本调 char_gen 批量生成后手工审核入库（不在本 plan 范围）。

### 6.5 BoundedAdjudication

| 项          | 落点                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Agent 工具  | `submit_adjudication`（M2 已定义 schema，M3.5 启用）                                                                      |
| 内核验证    | `rule-keys.ts` 新增 `evaluateAdjudication(p: ProposedAdjudication, state): AdjudicationResult`，六步验证照架构 §十一 11.2 |
| 触发点      | windows 求值时 automaton 返回 `UnsupportedCapability`，或战斗 Agent 主动在其决策轮调 `submit_adjudication`                |
| DomainEvent | `AdjudicationAccepted` / `RuleOverridden` / `MiracleTriggered` / `EffectRejected(code:'ADJUDICATION_REJECTED')`           |
| 监测        | journal 统计 `AdjudicationAccepted` 数 ÷ `AttackResolved` 数，>20% 时 `coordinator` 打 warn 日志（架构 §十一 11.4）       |

### 6.6 agent-config.json prompt 变更清单

> 具体 prompt 文案不在本 plan 内写，只列**变更点 + 验收方式**。

| Agent             | 变更点                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat_v3`（新） | ① 删除全部「掷骰」指令（v2 prompt 提及 `roll_d20` 4 次）——骰值由内核提供，Agent 只读结果；② 删除「判断输赢并调 combat_end」——终局由内核判；③ 改为「**每次只提交一个 Command**」的逐步决策模式（对应 `MAX_TOOL_ROUNDS=8`）；④ 新增「无法用标准动作表达的创意效果 ⇒ 调 `submit_adjudication`，且仅当 divinity ≥ 法则级」；⑤ 保留叙事与摘要职责（`write_summary` ≤500 字） |
| `item_gen`        | ① 输出格式从 `<script name=...>` JS 块改为 `<automaton>` JSON 块；② 新增格式约束段落：`subscribe` 必须取自窗口清单、`trigger` 只能用封闭表达式文法、`intents` 只能用 8 大类词汇、`divinity` 不得超过物品自身声明；③ 保留 v2 §四 4.3 效果转化表约束（CD ⇒ X 次/战斗 等）                                                                                                 |
| `char_gen`        | ① 战斗中调用路径新增 `combatParticipation` 输出段（`joinTiming` / `duration` / `actionEconomy`）；② 同 `item_gen` 的 automaton JSON 约束（角色自带技能）                                                                                                                                                                                                                |

**验收方式**：按 `reference/agent流程测试/agent预期分析.md`（已随内容分离移入私有内容仓 `fated_poem_independent_assets`，且已于 2026-08-08 删除，公开仓侧不可见）的流程走查——为 `combat_v3` / 改后的 `item_gen` / `char_gen` 各补一段「完整输出追踪（思维链 → 工具调用序列 → XML/JSON）+ 下游解析链路」，并在 M3.5 的 PR 内同步更新该文档。

### 6.7 新建 / 修改文件

| 文件                                             | 动作                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `combat-v3/adjudication.ts`（新）                | `evaluateAdjudication(p, state): AdjudicationResult`                                       |
| `combat-v3/summon-pool.ts`（新，可选）           | 见 §6.4                                                                                    |
| `combat-v3/coordinator.ts`（改）                 | 补 `CharGenRequest` / `BoundedAdjudication` 两路由（M2 的 `throw UnsupportedInM2` 替换掉） |
| `combat-v3/reducer.ts`（改）                     | `SupplyUnit` / `Adjudicate` 两个 Command 的 frame 恢复分支                                 |
| `combat-v3/phases/action.ts`（改）               | `SpawnOrDespawnIntent` 触发 CharGenRequest 的分支                                          |
| `char-gen-agent.ts`（改）                        | 新增 `runCharGenForCombat`（§6.3）                                                         |
| `agent-config.json`（改）                        | 见 §6.6                                                                                    |
| `reference/agent流程测试/agent预期分析.md`（改） | 见 §6.6 验收方式                                                                           |

### 6.8 测试清单

| 文件                                  | 关键用例                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/adjudication.test.ts`      | `divinity<5 被 reject` / `目标非法 reject` / `未注册 RuleKey reject` / `不变量违反 reject` / `通过产 AdjudicationAccepted` / `reason 进 journal`                                                                                |
| `combat-v3/phases/spawn.test.ts`      | `templateRef 缺省触发 CharGenRequest` / `templateRef 命中不触发` / `this_round_tail 插先攻尾部并消耗 1 initiative 骰` / `next_round_head 下轮参与` / `duration 到期 round.close 移除 + 摘 automaton` / `actionEconomy 三态槽位` |
| `combat-v3/coordinator.test.ts`（扩） | `CharGenRequest 优先查池` / `char_gen 返回非法定义时 clamp 而非崩`                                                                                                                                                              |
| `char-gen-agent.test.ts`（扩）        | `runCharGenForCombat 不落库`                                                                                                                                                                                                    |

### 6.9 样本验证

**第 06 场 fixture 端到端**：断言 `summoned`×2（食尸鬼 A/B）/ `joinTiming='this_round_tail'` 且当回合执行攻击 / `fpDelta` 含 -100 / 3 回合后 `UnitDespawned`×2 / 全场 FP 净变动 -1050。

### 6.10 不变量与 Critical/Major 核对

| 项                                                   | M3.5 状态                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| 不变量①豁免②                                         | ✅ 召唤物当回合参战由 char_gen 声明，内核默认仍 `next_round_head` |
| 不变量④                                              | ✅ FP 扣费与 UnitSummoned 同一次原子提交                          |
| N2（`combat_start` 把完整 CombatState 序列化回 LLM） | ✅ **消解**——投影 B 是脱敏文本面板，不含 id/patches/roundLogs     |

### 6.11 风险与回滚

- **风险**：char_gen 3–10 秒阻塞战斗节奏。**对策**：召唤中态 UI（M2 已做）+ 预生成池（§6.4）；若真机体验不可接受，退路是把 `templateRef` 设为**必填**（AI 只能从池里选），架构接口不变；
- **风险**：prompt 改写导致 Agent 输出跑偏。**对策**：`agent_config` 的 v2 `combat` 条目**保留不删**，flag 回退时仍可用；
- **回滚**：`CharGenRequest` / `BoundedAdjudication` 两路由可单独退回 `throw`，退化为 M3 能力。

---

## 7. M4 — 压力测试：5 场 fixture 全绿 + RuleKey 补全

### 7.1 目标与验收

| #    | 验收断言                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A4-1 | 5 场 fixture（06/07/09/13/24）**全量版**全部作为 contract test 通过                                                                    |
| A4-2 | 2 个新增极端 fixture 通过：`case-x1-mutual-reflection`（双方带反伤被动）/ `case-x2-true-death-revive`（真正死亡后复活）                |
| A4-3 | 四个 closed RuleKey 全部注册并可用：`terminal.forceTerminal`（M1 已有）/ `morale.forceState` / `action.freezeSlot` / `death.threshold` |
| A4-4 | divinity 压制泛化到状态对抗与意图对抗（架构 §八 8.3）；差 ≥5 级时**不消费骰子**                                                        |
| A4-5 | 各 fixture 的 `eventHash` 冻结为具体字符串（从 `expected.eventHash: null` 升级），此后任何改动导致 hash 变化必须在 PR 说明理由         |
| A4-6 | 第 07 场 9 次骰池续杯全部正确（每次 epoch 切换后各通道 cursor 归 0、余骰作废）                                                         |

### 7.2 新增 fixture

| fixture                                   | 来源        | 断言重点                                                                                                             |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `case-06-summon.fixture.json`（全量）     | case-06     | 召唤 + FP + 定时消失                                                                                                 |
| `case-07-prevent-death.fixture.json`      | case-07     | PreventDeath×2 / 格挡 487→97 / 真伤 bypass / 集群 ×1.5 / 9 次续杯                                                    |
| `case-09-concept.fixture.json`（全量）    | case-09     | forceTerminal / morale.forceState / FP 跨边界                                                                        |
| `case-13-time-freeze.fixture.json`        | case-13     | freezeSlot / grantActionSlot / 奇迹裁决 / FP 2400 过载                                                               |
| `case-24-reflection.fixture.json`（全量） | case-24     | 反射 depth 熔断 / 基准取 rootChain                                                                                   |
| `case-x1-mutual-reflection.fixture.json`  | 🆕 脑测编写 | 双方各带 30% 反伤 → depth 2 熔断 → `mutual_cancel` + `NarrativeCue('反射湮灭')`。**不需要真机**                      |
| `case-x2-true-death-revive.fixture.json`  | 🆕 脑测编写 | 角色 HP→0 → `death.threshold` Override（divinity 6）→ HP 恢复 30% + `ConsumeCharge` → 同一次原子提交。**不需要真机** |

### 7.3 新增 / 修改

| 文件                            | 动作                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-v3/rule-keys.ts`        | 补 `morale.forceState` / `action.freezeSlot` / `death.threshold` 三个（schema / scope / divinity 门槛 / merge policy 照架构 §八 8.2 表） |
| `combat-v3/rule-keys.ts`        | `divinitySuppression(atk, def): number` 泛化：返回 ±20%/40%/60%/80%/100%；≥5 级返回 `{ certain: true }` 让调用方跳过掷骰                 |
| `combat-v3/phases/attack.ts`    | 意图对抗接 divinity 压制                                                                                                                 |
| `combat-v3/intents.ts`          | `ApplyStatus.contest` 接 divinity 压制                                                                                                   |
| `combat-v3/phases/unit-turn.ts` | `action.freezeSlot` 生效：被冻结的槽位不发、`TurnClosed` 直接跳过                                                                        |
| `combat-v3/phases/attack.ts`    | `death.threshold` 在 `unit.beforeDown` 生效 + `DamagePrevented` 事件                                                                     |
| `automata/interpreter.ts`       | 补全 M3 延后的窗口 ctx 分型（§5.11 风险项）                                                                                              |

### 7.4 测试清单

| 文件                             | 关键用例                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `combat-v3/rule-keys.test.ts`    | 四个 RuleKey 各 1 组（通过/门槛不足/merge 冲突）/ `divinity 差 1~5 级压制值` / `差≥5 不消费骰子` |
| `combat-v3/contract/*.test.ts`   | 7 个 fixture 各 1 个 `replayCombat` 断言（milestone + eventHash）                                |
| `combat-v3/replay.test.ts`（扩） | `eventHash 稳定性：同 fixture 连跑 10 次 hash 相同`                                              |

### 7.5 不变量与 Critical/Major 核对

| 项                                           | M4 状态                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 五条不变量                                   | ✅ 全部由 fixture 覆盖（①槽位/②GrantActionSlot/③骰源/④原子提交/⑤幂等）                            |
| M-7（`clusterCount` 幽灵字段）               | ✅ **修复**——集群走 `CombatUnitState.clusterCount` 正式字段（第 07 场 fixture 断言 ×1.5）         |
| M-8（buff 去重旁路 + 落库反向合并异源）      | ✅ **修复**——战斗内 buff 状态在唯一 CombatState 内，`ApplyStatus` 按 `statusId`（含上级前缀）去重 |
| M-10（`convertScriptEffects` 丢弃 5 个通道） | ✅ **消解**——v3 无 ScriptEffects，intent 直接进 pendingChanges                                    |

### 7.6 风险与回滚

- **风险**：fixture 骰值回推有误 ⇒ 断言的是错的东西。**对策**：每个 fixture 的 PR 必须附「样本原文行号 → fixture 骰值」的对照表（放 fixture 的 `_provenance` 字段）；
- **回滚**：fixture 是纯测试资产，可单独 skip 某场（`describe.skip`）不阻塞其他 M。

---

## 8. M5 — 收尾：默认翻 v3 + 删旧接线 + 文档同步

### 8.1 目标与验收

| #    | 验收断言                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------- |
| A5-1 | `AppSettings.combatEngineVersion` 默认值翻为 `'v3'`；已有存档的 settings 迁移时若无该字段也取 `'v3'` |
| A5-2 | 打回 `'v2'` 后 v2 路径仍完整可用（保留**一个版本周期**）                                             |
| A5-3 | 删除清单执行完毕后 `npm run typecheck` + `npm run test -- --run` 全绿                                |
| A5-4 | 文档同步 4 处全部完成（§8.3）                                                                        |

### 8.2 删除清单（逐文件）

| 文件                                                                                        | 动作                                   | 说明                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat-runner.ts`                                                                          | 🗑 **删**（连 `combat-runner.test.ts`） | 职责已由 `combat-v3/coordinator.ts` 接管                                                                                                                                                                                      |
| `combat-pipeline.ts`                                                                        | 🗑 **删**（连测试）                     | 已由 `combat-v3/phases/*` 接管                                                                                                                                                                                                |
| `combat-resolver.ts`                                                                        | ✂️ **部分留**                          | 删 `resolveAttack` / `resolveDefend` / `resolveFlee` / `initCombat` / `endCombat` 等编排函数；保留其 re-export 的纯函数出口（若其他模块 import 了 `runDamagePipeline` 等，改为直接从 `combat-damage.ts` import 后可整文件删） |
| `combat-panel.ts`                                                                           | ✅ **留**                              | 格式化函数被 `combat-v3/projection-agent.ts` 引用（架构 §十三 13.1/13.2 投影 B）。⚠️ **不要删**                                                                                                                               |
| `combat-damage.ts` / `combat-intention.ts` / `combat-turn.ts` / `combat-morale-pipeline.ts` | ✅ **留**                              | 纯函数，v3 内核在调                                                                                                                                                                                                           |
| `combat-actions-pipeline.ts`                                                                | 🗑 **删**                               | 已由 `combat-v3/phases/action.ts` 接管                                                                                                                                                                                        |
| `combat-settlement-pipeline.ts`                                                             | ✂️ **部分留**                          | EXP/战利品的纯计算留（v3 settle 在调）；管线编排删                                                                                                                                                                            |
| `combat-modifier-inject.ts`                                                                 | 🗑 **删**                               | 已由 `automata/builtins.ts` + `intents.ts` 接管                                                                                                                                                                               |
| `combat-item-validator.ts`                                                                  | ✂️ **部分留**                          | 编译期校验函数留（`compile.ts` 在调）；v2 运行时入口删                                                                                                                                                                        |
| `agent-tools.ts` 的 `AGENT_TOOL_MAP['combat']` + `executeCombatToolCall`                    | 🗑 **删**                               | v3 用 `['combat_v3']`                                                                                                                                                                                                         |
| `agent-config.json` 的 `combat` 条目                                                        | 🗑 **删**                               | 保留 `combat_v3`                                                                                                                                                                                                              |
| `script-executor.ts` / `subscription-manager.ts` / `script-registry.ts`                     | ✅ **留**                              | 战斗外仍在用（ADR-29）。⚠️ 战斗内的调用点在 M3 就已断开，M5 不需要再动                                                                                                                                                        |
| `game-pipeline.ts` 的 flag 分支                                                             | ✂️ **保留一个版本周期**                | 下个周期再删 `'v2'` 分支与 flag 本身                                                                                                                                                                                          |

### 8.3 文档同步清单

| 文档                                                                 | 改动                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                          | ① 进度表「战斗 v2」行改为「战斗 v3 ✅」并注明 v2 已退役；② 架构图 `src/sillytavern/` 段加 `combat-v3/` 子目录；③ ADR-20 / ADR-29 的表述补一句「战斗内走 EffectAutomaton DSL」                   |
| `docs/CHANGELOG.md`                                                  | 追加战斗 v3 M0–M5 的详细记录（每 M 一段：产出/tests 数/修复的 Critical-Major 编号）                                                                                                             |
| `docs/reference/combat-system-architecture.md`（v2）                 | 头部加横幅：`> ⚠️ 本文档描述的 v2 战斗系统已于 2026-XX-XX 被 v3 取代，见 combat-system-architecture-v3.md。本文保留作为纯计算规则（伤害管线/效果类别/数值表）的引用来源——v3 仍在使用这些章节。` |
| `docs/archive/planning/2026-07-31-combat-v3-architecture-handoff.md` | 收尾：§2「待补完」表全部标 ✅ 并指向架构文档节号；顶部加「本地图已完成历史使命，架构见 ⑥」                                                                                                      |
| `docs/archive/reference/combat-agent-api.md`                         | 按 §4.4 的 v3 工具集重写（或标注「v2 专用，已退役」）                                                                                                                                           |
| `reference/agent流程测试/agent预期分析.md`                           | M3.5 已改，M5 复核                                                                                                                                                                              |

### 8.4 风险与回滚

- **风险**：删过头导致 v2 回滚路径断掉。**对策**：删除分两个 PR——PR1 只翻默认值 + 文档同步（不删任何代码），观察一个版本周期；PR2 才执行 §8.2 删除清单；
- **风险**：其他模块偷偷 import 了将删的文件。**对策**：删除前先跑 `grep -rn "from './combat-pipeline'\|from './combat-runner'" src/` 确认零引用。

---

## 9. Critical / Major → 里程碑映射总表

> 来源：[`docs/archive/planning/2026-07-30-combat-event-system-review.md`](./2026-07-30-combat-event-system-review.md)。「消解」= v3 架构使该问题不再存在（而非逐条修补）。

### 9.1 Critical（7）

| #   | 一句话                                           | 修于                           | 怎么验证                                                                                                                   |
| --- | ------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| C1  | 脚本沙盒不隔离，LLM 生成的 JS 带全部浏览器全局跑 | **M3**（战斗内消解）           | `no-nondeterminism.test.ts` 断言 combat-v3 零 `new Function`/`eval`。⚠️ 战斗外 `script-executor.ts` 遗留，不在本 plan 范围 |
| C2  | combat 工具通道缺 7 个 case，AI 第一步报错       | **M2**（消解）                 | v3 工具集只有 6+4 个且全部实现；`coordinator.test.ts` 覆盖每个工具                                                         |
| C3  | `combat_end` 不结束战斗，EXP 可翻倍              | **M1**                         | `terminal.test.ts`：`settle 同 settlementId 幂等`、`Terminal 后只接受 RequestSettlement`                                   |
| C4  | 玩家暂停无法取消，卡死只能刷新                   | **M2**                         | `coordinator.test.ts`：`abandon 后不落库`；CombatPanel 有关闭按钮                                                          |
| C5  | 意图对抗两侧共用同一颗 d20                       | **M0**（铺路）+ **M1**（落地） | `phases.test.ts`：`意图对抗用两颗独立骰`（断言 `intentCheck` cursor 推进 2）                                               |
| C6  | 非致死规则整条丢失，「打晕」会打死               | **M1**                         | `phases.test.ts`：`非致死攻击 HP 锁 1 并施加昏迷`                                                                          |
| C7  | 最终伤害无下限 clamp，负 modifier 变治疗         | **M1**                         | `phases.test.ts`：`负 modifier 不产生治疗`（final ≥ 0）                                                                    |

### 9.2 Major（15）

| #    | 一句话                                                   | 修于                                 | 怎么验证                                                                                  |
| ---- | -------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| M-1  | 6 个事件从未触发；buff 永不 tick、永不过期               | **M1**                               | `phases.test.ts`：`buff remainingTime 递减并到期移除`                                     |
| M-2  | 链式脚本系统在生产环境未通电                             | **M3**（消解）                       | `ActiveEffectIndex` 是唯一路径；`windows.test.ts` 覆盖求值                                |
| M-3  | 「1 攻击 + 1 动作」硬约束不存在                          | **M1**                               | `phases.test.ts`：`单位必须消费两槽才推进`、`Pass 也消费槽位`                             |
| M-4  | 战意 d20 恒 10，溃逃概率钉死 100%                        | **M0**（删默认值）+ **M1**（接通道） | `phases.test.ts`：`士气骰来自 statusContest`                                              |
| M-5  | 优劣势第二颗骰是 `Math.random()` 伪造                    | **M0**                               | `combat-damage.test.ts`：`优势取两颗骰较大者` + `no-nondeterminism`                       |
| M-6  | modifier 折叠不分 target，守方百分比被丢弃               | **M3**                               | `builtins.test.ts`：#3「受到伤害 -N%」编译到 `collect_defender_mods`                      |
| M-7  | 集群 ×1.5 与 EXP 衰减是死代码（`clusterCount` 幽灵字段） | **M4**                               | 第 07 场 fixture 断言集群 ×1.5；`clusterCount` 进 `CombatUnitState` 正式字段              |
| M-8  | 战斗内 buff 去重旁路；落库侧反向合并异源                 | **M4**                               | 战斗内唯一 CombatState + `statusId` 含上级前缀；fixture 断言异源共存                      |
| M-9  | HP/资源同步只做守方；`costs.hp` 被丢弃                   | **M1**                               | `phases.test.ts`：攻守双方资源同在一次 `pendingChanges`                                   |
| M-10 | `convertScriptEffects` 丢弃 10 个通道里的 5 个           | **M3**（消解）                       | v3 无 ScriptEffects，intent 直接进 pendingChanges                                         |
| M-11 | 脚本注册表两条僵尸订阅路径                               | **M3**（战斗内消解）                 | `ActiveEffectIndex` 是派生的，无注册闭包；`index-active.test.ts` 覆盖离场移除。战斗外遗留 |
| M-12 | 递归防护在生产路径全线失效                               | **M3**                               | `windows.test.ts`：递归 ≤5 拦截；反射 depth ≤2（M4 fixture）                              |
| M-13 | 未调 `combat_start` 的叙事收尾让整场战斗蒸发             | **M2**（消解）                       | 内核 `openCombat` 开战，不依赖 Agent 调用                                                 |
| M-14 | 事件顺序与 v2 架构 §6.3 相反                             | **M3**（消解）                       | 微步骤链顺序由内核固定（本 plan §3.4），非 Agent 决定                                     |
| M-15 | handler 漏 `return` 让整次攻击抛 TypeError               | **M3**（消解）                       | automaton 返回 intent batch；返回 `undefined` 视为空 batch，`windows.test.ts` 覆盖        |

### 9.3 Minor

N1/N2/N9 在 M2 顺带修（见各节核对表）；N3/N4/N5/N6/N7/N8 属 v2 遗留，随 M5 删除清单一并消失或不再可达，**不单独立项**。

---

## 10. 开放问题跟踪

> 来源：架构 §十六 16.3。

| #   | 问题                                  | 阻塞哪个 M       | 处理                                                                                                                              |
| --- | ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | char_gen 战斗中调用 3–10 秒，玩家体验 | **不阻塞** M3.5  | 召唤中态 UI（M2 已做）先兜住；预生成池是 M3.5 可选项（§6.4）。若 M6 真机体验不可接受，退路是 `templateRef` 改必填（架构接口不变） |
| 2   | BoundedAdjudication 滥用风险          | **不阻塞**       | M3.5 已实装 `divinity ≥ 5` 硬门槛 + 20% 占比监测（§6.5）。数据要等真机才有                                                        |
| 3   | `MAX_REFLECTION_DEPTH = 2` 是否合适   | **阻塞 M4**      | M4 必须补 `case-x1-mutual-reflection` fixture（§7.2）。脑测编写即可，不需真机                                                     |
| 4   | 第 24 场复活机制未实证                | **阻塞 M4**      | M4 必须补 `case-x2-true-death-revive` fixture（§7.2），确定 HP 恢复比例 / charge 数 / divinity 门槛                               |
| 5   | v2 M6 真机是否先做                    | **不阻塞** M0–M5 | 主人待定。真机输出是 contract test 的**可选**第三层参照（架构 §十六 D5 ③），M0–M5 用前两层即可                                    |

---

## 变更记录

| 日期       | 变更                                                                                                                                                                                                                                                                                 | 作者   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 2026-07-31 | 初版：M0–M5 逐里程碑实施计划（文件树 / 关键签名 / 修改点 / 测试清单 / fixture 格式 / 样本验证 / Critical-Major 映射 / 开放问题跟踪）。含一处对 brief 的实测修正：`resolveIntention` 的 `IntentionCheckInput` **已有** `attackerD20`/`defenderD20` 双字段，C5 的 bug 在调用点而非签名 | Claude |
