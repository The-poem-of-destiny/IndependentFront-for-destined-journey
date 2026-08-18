# 战斗 Agent 会话模式改造 实施计划（lean-delegation 编排）

> 配套设计：`docs/planning/2026-08-09-combat-agent-session-revamp-design.md`（设计定稿）
> 前置调查：`docs/archive/planning/2026-08-09-combat-agent-session-design.md`（决策调查报告）
> 日期：2026-08-09 · 状态：**待执行**（代码层全绿，真机走查未做）
> 编排方式：**lean-delegation** —— 主会话只做规划与验收，全部实现交给子 agent。

---

## 0. 这份文件是什么

设计文档给了定案与改法。这份文件把它翻译成**可直接派发的 agent 任务**：分几波、每波谁跟谁并行、每个 agent 的完整 brief、每波之间主会话做什么。

**照着往下读就能开工，不需要再回去读设计文档的全部** —— 但每个 agent 的 brief 里都写明了它自己该读设计文档的哪几节。

### 0.1 三条编排铁律

1. **主会话不读实现文件、不写代码、不跑测试套件。** 要看代码就派 scout，要验收就派 verifier。主会话读进来的每一个 token 都会在之后每一轮被重新计费。
2. **所有 agent 一律高能力模型 + 中低 reasoning effort。** 高 effort 不会让实现更对，写清楚的 brief 才会。
3. **agent 不再派 agent。** 只有一层：主会话 → agent。每个 brief 里都要写这句。

### 0.2 每个 agent 的报告格式（所有 brief 共用，逐字带上）

```
用不超过 15 行汇报：
- 改了什么：文件路径 + 一句话说明（不要贴代码、不要贴 diff、不要贴文件内容）
- 验证：跑的确切命令 + 结果（过/不过；不过就只给失败的用例名和一句话原因）
- 阻塞项、以及顺手发现但没动的问题：各一行
做不完就直说，并写下你已经查明的东西，好让下一次从热的状态开始。
```

### 0.3 每个 brief 都要有的围栏（逐字带上）

```
- 只做本任务范围内的事。不要顺手重构、不要修你注意到的无关问题 —— 把它们写进报告里。
- 自己用工具直接做，不要派生子 agent。
- 本仓 CLAUDE.md / AGENTS.md 的规矩仍然生效：新模块必须配 *.test.ts；
  类型只从 types.ts / types-*.ts 来；Dexie 操作一律 await。
- 改完自己跑验证命令，不要把「我觉得应该没问题」当验证。
```

### 0.4 全局验证命令

| 场景               | 命令                                     |
| ------------------ | ---------------------------------------- |
| 单模块             | `npm test -- --run <测试文件路径>`       |
| 类型               | `npm run typecheck`                      |
| 波次收尾（全量）   | `npm run typecheck && npm test -- --run` |
| 文档改动后（必须） | `npx prettier --write <改过的每个 .md>`  |

🔴 **不要跑仓库级 `npm run format`** —— Windows 上 `core.autocrlf` 会把约 520 个文件重写成 LF（AGENTS.md 已记）。

---

## 1. 波次总览

```
波 1  ┌ T1  A   system prompt 全文写入 agent-config.json（combat_v3）
      ├ T2  B   coordinator 读 configs 的 systemPrompt，删硬编码
      └ T3  C   get_character 加 skills+装备字段（agent-tools.ts）
        │
波 2  ├ T4  A   查询/命令分流：executeCombatQuery + lastCommandFromResult 只认命令类
      ├ T5  B   get_hp_percent 从 AGENT_TOOL_MAP 删除
      └ T6  C   submit_adjudication 补执行端（toolCallToCommandSync 加 case）
        │
波 3  ├ T7  A   持久会话：runCombatV3 闭包持 combatMessages，routeEnemyCommand 读/写
      ├ T8  B   新增 get_unit_detail 工具（五维+技能+装备一把抓）
      └ T9  C   结算演绎：routeEnemyCommand 返回 {command, narration} + 结算短调用
        │
波 4  ├ T10 A   终局落库回写：CombatState units → characters 覆写 hp/mp/sp/status
      └ T11 B   write_summary 改造（持久会话下真·消息收集）
        │
波 5  ├ T12 A   CombatPanel/Header/UnitCard/ActionBar 改读 v3ActiveCombat
      ├ T13 B   v3_units_snapshot 事件 + game-store 填充 units
      └ T14 C   CombatActionBar 玩家输入改走 submitCombatCommand（文本→AI 解析）
        │
波 6  ├ T15 A   CombatOpened emit 链修复 + 面板弹出验证
      ├ T16 B   pre-combat 快照触发 + 跳过/重开战斗按钮
      └ T17 C   前端设计验证 + 波次收尾全量验收
```

---

## 2. 前置阅读（每个 brief 都该带上）

- **设计文档必读**：`docs/planning/2026-08-09-combat-agent-session-revamp-design.md`（各任务对应小节）
- **战斗协议参考**：世界书「战斗协议」（私有内容仓 world_setting.json uid 435 战斗协议条目）
- **v3 架构**：`docs/reference/combat-system-architecture-v3.md`
- **工具注册**：`src/sillytavern/agent-tools.ts`（ALL_TOOL_DEFINITIONS + AGENT_TOOL_MAP + executeToolCall）
- **coordinator**：`src/sillytavern/combat-v3/coordinator.ts`（routeEnemyCommand / runCombatV3 / toolCallToCommand）
- **agent-config**：`data/defaults/agent-config.json`（combat_v3 条目，systemPrompt 见设计 §2.7.1）

---

## 3. 波次明细

### 波 1 — 提示词与工具数据基础

**依赖**：无。三个任务互不重叠（config JSON / coordinator 读法 / 工具字段）。

#### T1 system prompt 全文写入 agent-config.json

**读**：设计 §2.7.1（prompt 全文已定稿）。

**改**：`data/defaults/agent-config.json` → `agents.combat_v3.systemPrompt` 替换为设计 §2.7.1 的全文。

**验证**：

- `node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('data/defaults/agent-config.json','utf8'));console.log(d.agents.combat_v3.systemPrompt.length)"`（应 > 1500 字）
- 编码检查：U+FFFD 0 / 控制字符 0 / JSON 可解析（AGENTS.md 判据）

**注意**：只改这一个字段。改完别跑仓库级 format。

#### T2 coordinator 读 configs 的 systemPrompt，删硬编码

**读**：设计 §2.7；coordinator.ts:479（硬编码 125 字 system）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` → `routeEnemyCommand` 的 system 消息改为从 `ctx.configs` 找 combat_v3 的 systemPrompt（照 char_gen-agent 读 configs 的先例）；删硬编码字符串。持久会话下 system 只发一次（波 3 会重构消息组法，本任务先确保取到配置值）。

**验证**：`npm run typecheck && npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts`

**注意**：coordinator.test.ts 里有断言 system 内容的用例，可能需同步更新——先跑测试看红在哪。

#### T3 get_character 加 skills + 装备字段

**读**：设计 §2.2（get_character 必改）；agent-tools.ts:802-837（当前返回形状）。

**改**：`src/sillytavern/agent-tools.ts` → `get_character` 的返回对象加 `skills`（char.skills）与装备信息（inventory 中 equippedSlot 非空的物品）。

**验证**：`npm test -- --run src/sillytavern/agent-tools.test.ts`

**注意**：返回字段只增不减，别动现有字段名（craft_gen/char_gen 也用它）。

### 波 2 — 工具链正确性（查询/命令分流）

**依赖**：波 1 完成。T4 是问题 2 的根治，最重要。

#### T4 查询/命令分流（问题 2 根治）

**读**：设计 §2.2；coordinator.ts:492（toolCallToCommand）、:632（lastCommandFromResult）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` →

- 新增 `executeCombatQuery(name, args, session)`：处理 4 个查询类工具（get_combat_state / get_unit_detail / get_character / get_inventory），返回数据给模型，**不产 Command**。
- `routeEnemyCommand` 的 toolExecutor 分流：命令类 → `toolCallToCommand`；查询类 → `executeCombatQuery`。
- `lastCommandFromResult` 只认命令类工具结果，查询结果不得成为最终 Command。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts && npm run typecheck`

**注意**：现有「查询工具落 default 变 pass」的行为必须消除；新增测试断言 get_character 不再产生 Command。

#### T5 get_hp_percent 从 AGENT_TOOL_MAP 删除

**读**：设计 §2.2；agent-tools.ts:602-615（AGENT_TOOL_MAP['combat_v3']）。

**改**：`src/sillytavern/agent-tools.ts` → 从 `combat_v3` 白名单移除 `'get_hp_percent'`。工具定义本身保留（craft_gen 可能不用它，但别删定义，只删 combat_v3 白名单引用）。

**验证**：`npm test -- --run src/sillytavern/agent-tools.test.ts`

#### T6 submit_adjudication 补执行端（问题 6）

**读**：设计 §2.4；coordinator.ts:532-616（toolCallToCommandSync 无此 case）；adjudication.ts（内核已就绪）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` → `toolCallToCommandSync` 加 `case 'submit_adjudication'` → 返回 `{kind:'Adjudicate', payload:{ requestId, adjudication:{ effectDescription, divinity, verifiableBounds, requestedRuleOverride, reason } }}`（照 routeAdjudication 的载荷形状）。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts`

### 波 3 — 持久会话 + 演绎

**依赖**：波 1/2 完成。T7 是控制流重构（决策 1A 落地）。

#### T7 持久会话（决策 1A 落地）

**读**：设计 §2.1；coordinator.ts:121（runCombatV3）、:459（routeEnemyCommand）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` →

- `runCombatV3` 闭包内建 `combatMessages: ChatMessage[]`。
- system 消息**只 append 一次**（首次调用）。
- `routeEnemyCommand` 改为读/写 combatMessages：每回合 append `{role:'user', content: 轮到X + 面板}` → assistant 决策（含工具往返）→ tool 结果。
- 查询工具结果**保留进历史**（决策：不破坏缓存命中即可）。
- 回合压缩不做。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts && npm run typecheck`

**注意**：这是控制流最大改动，协调器测试需覆盖「多单位多回合共享同一消息数组」的断言。

#### T8 新增 get_unit_detail 工具

**读**：设计 §2.2（新增项）；agent-tools.ts（工具定义 + 白名单 + executeToolCall 三处）。

**改**：`src/sillytavern/agent-tools.ts` →

- ALL_TOOL_DEFINITIONS 加 `get_unit_detail`（参数：unitId 或角色名；返回五维+技能+装备）。
- `AGENT_TOOL_MAP['combat_v3']` 加 `'get_unit_detail'`。
- executeToolCall 加 case，按角色名/characterId 从 context 取数据。

**验证**：`npm test -- --run src/sillytavern/agent-tools.test.ts`

**注意**：get_unit_detail 与 get_character 的区别——前者是战斗单位详情（含五维+技能+装备聚合），后者是通用角色查询（已加 skills）。两者都保留。

#### T9 结算演绎（数字即时 + AI 叙事补上）

**读**：设计 §2.5；coordinator.ts:459（routeEnemyCommand 返回值）、agent-client.ts:240（content + tool_calls 并存）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` →

- `routeEnemyCommand` 返回值扩为 `{ command, narration }`：narration 取自 assistant `content`（声明演绎），command 照旧。
- 新增结算演绎短调用：内核算完 → 汇总结算事实串（从 AttackResolved/DamageApplied 等 DomainEvent）→ 喂同一持久会话 → 拿结果句。
- narration 经 onCombatEvent 投进 combatLog（新增一个 CombatEvent 变体或复用 v3_narrative）。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts && npm run typecheck`

**注意**：结算演绎每单位每次行动多一次往返；事实串由 Code 汇总、AI 只写结果句（防篡改数字）。

### 波 4 — 落库与摘要

**依赖**：波 3 完成（结算事实串可供 T10 复用）。

#### T10 终局落库回写（问题 7）

**读**：设计 §2.6；coordinator.ts:227-235（终局 commitChatState）、:735（toPatches）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` →

- 终局时遍历 `session.snapshot().units`，按 characterId 匹配存档角色 → 生成 hp/mp/sp/statusEffects 的 StatePatch。
- 与 FP patch 合并进同一次 commitChatState（A2-1：整场只 commit 一次，别拆两次）。
- 召唤物（匹配不到角色）跳过。
- 战斗结束后 game-pipeline 的 advanceTurn 快照天然覆盖战斗后状态（无需额外改动）。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts && npm run typecheck`

**注意**：A2-1 要求「整场只 commit 一次」——HP 回写必须并进终局那一次，不能另开第二次 commit。

#### T11 write_summary 改造

**读**：设计 §2.2（write_summary 改造）；coordinator.ts:603-612（当前返回占位 Choose）。

**改**：`src/sillytavern/combat-v3/coordinator.ts` → 持久会话下 write_summary 不再返回占位 Choose，改为真·终局摘要收集：AI 调 write_summary(text) → 存进 coordinator 的 summary 收集变量 → 终局回注正文（替代现在的 Choose hack）。

**验证**：`npm test -- --run src/sillytavern/combat-v3/coordinator.test.ts`

### 波 5 — 前端重写 v3

**依赖**：波 3/4 完成（引擎侧语义稳定）。

#### T12 CombatPanel/Header/UnitCard/ActionBar 改读 v3ActiveCombat

**读**：设计 §3.1、§3.3；CombatPanel.vue:12-17、CombatHeader.vue、CombatUnitCard.vue、CombatActionBar.vue:38-49。

**改**：

- `src/ui/components/game/combat/CombatPanel.vue` → enemies/allies 从 `game.v3ActiveCombat.units` 按 initiativeOrder + side 过滤。
- `CombatUnitCard.vue` → prop 类型从 CombatParticipant 改为 CombatUnitView，外层显示 HP/MP/SP/状态/战意，详情展开显示五维+技能。
- `CombatHeader.vue` → 读 v3ActiveCombat.round 等。
- `CombatActionBar.vue` → allyUnits/enemyUnits 改从 v3ActiveCombat.units 取。

**验证**：`npm run typecheck && npm test -- --run src/ui/components/game/combat`

**注意**：v3 的 units 是 `Record<id, CombatUnitView>` 字典 + initiativeOrder 数组，没有 participants 数组——前端要做一次投影（字典→有序数组）。设计 §3.1 明确选 A2（原生吃 v3 形状），不写 v3→v2 适配层。

#### T13 v3_units_snapshot 事件 + game-store 填充 units

**读**：设计 §3.1、§3.4；game-store.ts:151-163（v3_combat_started units:{} 空）、:164-205。

**改**：

- `src/sillytavern/combat-v3/projection-ui.ts` 或 coordinator 加 `v3_units_snapshot` 事件（携带完整 units 字典）。
- `src/ui/stores/game-store.ts` 的 applyCombatEvent 加 case，填充 `v3ActiveCombat.units`；`v3_combat_started` 时一并填。

**验证**：`npm test -- --run src/ui/stores/game-store.test.ts`

**注意**：这是问题 4 的核心——面板弹出来不能是空的。事件在 CombatOpened/首次 dispatch 后发一次（开局快照），后续单位 HP 变化靠现有 v3_action 卡片同步（不做每步全量推送）。

#### T14 CombatActionBar 玩家输入改走 submitCombatCommand

**读**：设计 §3.2；CombatActionBar.vue:238（submitCombatInput）、game-store.ts:220（submitCombatCommand）。

**改**：`src/ui/components/game/combat/CombatActionBar.vue` →

- 四步拼装产出结构化 Command（DeclareAttack/DeclareAction/PassSlot/Flee），走 `game.submitCombatCommand`。
- 自由文本输入 → 过 coordinator 的文本→Command 解析（设计 §3.2：统一 AI 解析意图）。
- 移除对 v2 `submitCombatInput` 的依赖。

**验证**：`npm test -- --run src/ui/components/game/combat && npm run typecheck`

**注意**：禁止把自由文本直接当 Command 喂内核（"查询工具被误当 Command"的同款坑）。

### 波 6 — 面板弹出修复 + 快照/重开 + 收尾

**依赖**：波 5 完成。

#### T15 CombatOpened emit 链修复（问题 3）

**读**：设计 §3.4；reducer.ts:551-562（CombatOpen 已发 CombatOpened）、coordinator.ts:162（emitEvents）、game-store.ts:151。

**改**：真机/链路测试确认 `v3_combat_started` 完整 emit 到 store 且 v3ActiveCombat 正确填充（含 T13 的 units）。若事件链断在某处，补齐。

**验证**：`npm test -- --run src/ui/stores/game-store.test.ts && npm test -- --run src/sillytavern/combat-v3/projection-ui.test.ts`

#### T16 pre-combat 快照 + 跳过/重开战斗（决策 5）

**读**：设计 §3.5；game-pipeline.ts:1518（handleCombatTriggerV3）、game-store.ts:236（abandonCombat）、SnapshotPanel.vue。

**改**：

- `game-pipeline.ts` → openCombat 前 `createSnapshot('pre-combat', totalTurns)`。
- `game-store.ts` → 加 `skipCombat()`（abandon + 提示文案）与 `restartCombat()`（abandon + restoreSnapshot(pre-combat) + 重触发 combat_trigger）。
- `CombatPanel.vue` → 加「跳过战斗」「重开战斗」按钮（带确认弹窗；跳过文案：无经验，可自由编写战斗过程）。

**验证**：`npm test -- --run src/ui/components/game/combat && npm test -- --run src/ui/stores/game-store.test.ts`

#### T17 前端设计验证 + 波次收尾

**读**：设计 §3.1-3.5。

**改**：检查前端所有战斗组件不再引用 v2 `activeCombat`（只留兼容分支或删除）；波次收尾跑全量。

**验证**：`npm run typecheck && npm test -- --run`

**注意**：全量绿后，把 `docs/planning/2026-08-09-combat-agent-session-revamp-design.md` 状态改为「已实施」，并更新 AGENTS.md 进度表 + docs/CHANGELOG.md（提交前文档检查）。

---

## 4. 风险与应对

| 风险                                  | 应对                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| 持久会话消息数组膨胀                  | 已决策：回合压缩不做，接受膨胀（战斗不会拖很久）            |
| coordinator 控制流重构破坏现有测试    | 每波收尾跑全量；T7 是最大改动，单独验收                     |
| AI 篡改结算数字                       | 结算事实串由 Code 汇总、AI 只写结果句（T9）；卡片数字双保险 |
| 前端 units 字典→数组投影错位          | T12 单独验收，断言 initiativeOrder 顺序                     |
| A2-1「整场只 commit 一次」被 T10 破坏 | T10 必须把 HP 回写并进终局那一次 commit                     |

---

## 5. 验收清单（全部完成才算收尾）

- [ ] 波 1-6 全部任务各自的验证命令通过
- [ ] `npm run typecheck && npm test -- --run` 全绿
- [ ] 设计文档状态更新 + AGENTS.md 进度表 + docs/CHANGELOG.md 追加
- [ ] 提交前编码检查（U+FFFD 0 / 控制字符 0 / JSON 可解析）
- [ ] 真机走查：战斗面板弹出、敌方 AI 决策、结算演绎、跳过/重开战斗
