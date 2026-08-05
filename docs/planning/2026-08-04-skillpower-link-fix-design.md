# skillPower 链路修复设计 —— 主动攻击技能威力接入战斗 v3 结算管线

> 状态：✅ **已实施（2026-08-04）**——类型层（types.ts / combat-v3/types.ts）+ 解析层（char-gen-agent.ts）+ 转换层（combat-v2-types.ts / state.ts）+ 收口（attack.ts）+ item_gen prompt + 配套文档 + 6 测试用例，5934 tests 全绿。设计稿原文保留以备追溯，§4 的方案即落地实施版。
> 日期：2026-08-04
> 范围：仅诊断并修复"主动攻击技能（如火球术）的主体威力没有进入 v3 战斗结算管线"这一条链路。不重构 v3 内核，不改 v2 历史模块。
> ADR 关联：ADR-28（模仿结果、不照抄中间结构——世界书的"骰子池/action_info 文本面板"对应我们的 `$combat.attack` + Code 公式）· ADR-21（唯一写入口，伤害也只应走结算管线一次）· ADR-29（统一链式管道）

---

## 0. 一句话结论

链路**真的断了，而且从头断到尾**——从 `Skill` 类型定义、`item_gen` 输出格式、`characterToCombatParticipant` 转换、`createCombatState` 初始化、`declare_attack` 工具 schema、到 `coordinator.toolCallToCommand` 翻译，**没有任何一个环节把技能威力读出来塞进 `ability.skillPower`**。结果 `attack.ts:128-136` 三个 fallback 全是 `skillPower: 0`，`calcInitialDamage`（`combat-damage.ts:36-50`）公式里的"+ 技能威力"项恒为 0。

与此同时，item_gen 已经按 Tier→威力区间表选好了威力值（实测火球术 = 450），但因为 `<skill>` XML schema 没有承载字段，这个 450 被写进了 cast 脚本 `$resource.modifyHp(target, -450)`——**战斗外路径、固定伤害、绕过命中/防御/抗性/暴击**，与主人描述的症状完全吻合。

**这不是设计上的故意**：v3 设计**本就有** `ability.skillPower` 这条通道（`combat-v3/types.ts:521`、`attack.ts:268`、公式 `combat-damage.ts:36-50`），只是 6 个环节全都漏接了。

---

## 0.1 与既有文档的关系（历史脉络：这是 v2→v3 迁移遗漏）

**先说结论**：本喵排查了 `docs/` 与 `reference/` 下所有命中 `skillPower / 技能威力 / 主动技能伤害 / cast 脚本` 的文档，**没有任何一份把这个缺口作为已知 TODO 记录过**——所以本设计不是重复造文档，修这个链路不会跟既有待办打架。但四份既有文档从侧面坐实了「这是 v2→v3 迁移时丢的行李」这一历史定位：

| 文档                                                                                                                    | 相关片段                                                                                          | 性质                                                          | 与本缺口的关系                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/reference/combat-agent-api.md:103-122`                                                                            | v2 的 `combat_attack` 工具 schema 含 `skillPower` / `damageType` / `multiHitCount` 等 AI 填值参数 | **v2 接口规格**                                               | v2 时代 AI 自己填 skillPower，链路通。v3 按 ADR-28（AI 不填数值）**有意删掉**了这些参数（`agent-tools.ts:399` 明写"骰值与伤害由内核真实计算"），但删了 AI 入口后**没建 Code 入口**——这是断链的直接成因 |
| `docs/planning/2026-07-31-combat-v3-stress-test/case-24-reflection.md:143-151`                                          | 脑测 Command 写了 `Attack({skillPower: 150, damageType: "能量", ...})`                            | **v3 压测的纸上脑测**（文件头声明"详细脑测报告"，非真跑代码） | 脑测**假设** Command 能传 skillPower，因此没发现真实 v3 代码里 schema/翻译层根本没这条通路。它的 Q1-Q6 全关注反伤 depth/熔断/PreventDeath，**完全没碰 skillPower 来源**——脑测绕过了断链                |
| `docs/planning/task_plan.md:283` · `docs/planning/progress.md:280` · `docs/reference/combat-system-architecture.md:452` | "公式 = 关联属性×10×层级系数 + 技能威力 + 武器攻击力"                                             | **公式描述（已完成事项附带说明）**                            | 印证公式设计**本就期待** skillPower 入参；但没人写过"技能威力项实际恒为 0"的断言，所以测试全绿掩盖了断链                                                                                               |
| `docs/CHANGELOG.md:410`                                                                                                 | "characterToCombatParticipant 收集被动技能 automata（**主动技能不走被动效果**）"                  | **已完成事项描述**                                            | 这正是断点 4（`combat-v2-types.ts:146`）的设计注释——主动技能本该走 declare_attack 触发，但触发链路没接通威力                                                                                           |

**历史脉络**：

1. **v2 时代**：`combat_attack` schema 有 `skillPower` 参数，AI 填值，链路通（`combat-agent-api.md:111`）。
2. **v3 迁移**：按 ADR-28 把 `skillPower/damageType/multiHitCount` 等数值参数从 `declare_attack` schema 中**有意删掉**（AI 只做战术决策，数值归 Code）——方向正确。
3. **遗漏**：删了 AI 入口，**忘了建 Code 入口**（"按 skillName 从技能库查威力填进 ability"）。于是 `attack.ts:128` 三个 fallback 全空 → `ability.skillPower` 恒为 0。

主人进度表记的「战斗 v3 ✅ M5 全量合入」是真的——合入的是 v3 内核骨架（公式/检定/抗性/暴击全在）；威力的数据通路是 v2→v3 迁移时丢的行李，M5 测试因为 bundle.ability 全是 `undefined` 走兜底 0，没写"skillPower 非 0"断言，所以全绿掩盖了。

**配套修订（实施本方案时一并做，避免老文档继续误导）**：

- `docs/reference/combat-agent-api.md` §`combat_attack`（103-122 行）加一行标注：「🔴 v3 已迁移：`declare_attack` schema 按 ADR-28 删掉了 `skillPower/damageType/multiHitCount` 等 AI 填值参数；本节保留仅作 v2 历史接口参考。v3 的威力入口见 `docs/planning/2026-08-04-skillpower-link-fix-design.md`」。否则后人读到这份 v2 规格会以为接口还活着。

---

## 1. 调用链全图（每一步带 file:line）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ① item_gen Agent 产出技能                                                   │
│   输入: dispatcher 的 <item_gen_request itemType="skill">                   │
│   prompt 里有 Tier→威力区间表（见 §3.1）                                    │
│   输出 XML: <skill name type cost_type cost_amount cooldown>                │
│             <effect>...</effect>                                            │
│             <script name="cast">$resource.modifyHp(target, -450)</script>   │
│             <modifiers>...</modifiers>                                      │
│             <buffs>...</buffs>                                              │
│   📌 schema 里 NO 威力字段 →威力值被塞进 cast 脚本                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ② char-gen-agent.ts / craft-gen-chain.ts 落库 Skill                         │
│   parseSkillsXML 把 <skill> → Skill 对象（src/sillytavern/types.ts:826）     │
│   Skill 接口字段: name/desc/type/cost/cooldown/effects/scripts/modifiers/   │
│                  buffs/divinity/automata                                    │
│   📌 Skill 接口 NO skillPower 字段（types.ts:826-849）                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ③ <combat_trigger> → request_dispatcher → onCombatTrigger                   │
│   marker-protocol.ts:270 扫描 <combat_trigger>                              │
│   agent-orchestrator.ts:898-905 触发 onCombatTrigger                        │
│   game-pipeline.ts:1133 handleCombatTrigger → handleCombatTriggerV3         │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ④ 组装 bundle（game-pipeline.ts:1367-1379）                                 │
│   participants = characters.map(characterToCombatParticipant)               │
│   📌 bundle NO skills 字段（types.ts:1086 的 skills? 从未被填）             │
│   📌 characterToCombatParticipant NO 读 char.skills（combat-v2-types.ts:146)│
│   📌 CombatParticipant 接口 NO ability/skillPower 字段（types.ts:2031-2084) │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⑤ createCombatState(bundle)（combat-v3/state.ts:118）                       │
│   每个 unit: ability = undefined（state.ts:152 写死）                       │
│   📌 注释说"可由 bundle.skills 兜底"但代码 NO 读 bundle.skills              │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⑥ runCombatV3 循环（coordinator.ts:120）                                    │
│   敌方/玩家 → RequiredInput.PlayerCommand → routeEnemyCommand               │
│   战斗 Agent 调用 declare_attack 工具（agent-tools.ts:397-419 schema）       │
│   📌 declare_attack schema 参数: actorName/targetName/skillName/            │
│      intentionLevel/costs —— NO skillPower/relevantAttribute/damageType     │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⑦ coordinator.toolCallToCommand（coordinator.ts:528-549）                   │
│   declare_attack → DeclareAttack Command                                    │
│   payload = { targetId, skill, intentionLevel, costs }                      │
│   📌 payload NO ability 字段（尽管 types.ts:906 允许 ability?）             │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⑧ handleAttack（combat-v3/phases/attack.ts:108）                            │
│   attack.ts:128-136:                                                        │
│     const ability = command.payload.ability ??     // ❌ undefined          │
│       attacker.ability ??                          // ❌ undefined          │
│       { relevantAttribute, skillPower: 0, ... }   // ✅ 兜底但恒为 0        │
│   attack.ts:265-275: buildDamageInput(spec.ability.skillPower)              │
│   attack.ts:268: skillPower: ability.skillPower  // = 0                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⑨ calcInitialDamage（combat-damage.ts:36-50）                               │
│   total = 属性×10×层级系数 + skillPower + weaponAtk                         │
│   skillPower 项恒为 0 → 主体伤害严重偏低                                    │
│   公式仍跑（命中/防御/抗性/暴击 都在），但"技能威力"这一项永远是 0          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 断点清单（每条带证据）

### 断点 1 — `Skill` 类型无 `skillPower` 字段 ❌

- **位置**：`src/sillytavern/types.ts:826-849`
- **证据**：`Skill` 接口字段全清单：`id? / name / description / type / cost? / cooldown? / maxCooldown? / level? / effects? / scripts? / modifiers? / buffs? / divinity? / automata?`。**没有任何承载"主体威力数值"的字位**。
- **结论**：类型层面就没有地方放威力值，是下游所有断点的根。

### 断点 2 — `item_gen` 输出格式无威力字段 ❌

- **位置**：`data/defaults/agent-config.json` 的 `agents.item_gen.systemPrompt`（`<skill>` XML schema）
- **证据**（item_gen systemPrompt 原文）：
  ```xml
  <skill name="技能名" type="active|passive" cost_type="HP|MP|SP|none" cost_amount="数值" cooldown="回合数">
    技能效果描述
    <effect name="词条名">词条中文描述</effect>
    <script name="init|cast|tick|cleanup">沙盒 API 代码</script>
  </skill>
  ```
  prompt 里**有** Tier→威力区间表（T1=100-300 / T2=300-800 / T3=800-1500 / ... / T7=8000+）作为评估参考，并要求 AI "对照 Tier 强度对齐"，但**输出 schema 没有威力属性**——AI 算出的威力值无处落座。
- **真实战斗取证**（`tests/realtime_export/fated-poem-debug-9d7ca32b-1785843679499.json` 的 item_gen 原始输出）：
  ```
  - 火球术：混合型主动技能 → cast 脚本处理伤害 ... 伤害 450、MP 200、CD 3，落在 T2 威力区间（300-800）。
  <skill name="火球术" type="active" cost_type="MP" cost_amount="200" cooldown="3">
    ...
    <script name="cast">$resource.modifyHp(target, -450);
  $status.add(target, {name:'法力燃烧', ...});</script>
  ```
  **AI 明明白白选了 450，但被迫塞进了 cast 脚本的 `$resource.modifyHp`——战斗外路径、固定伤害、绕过结算**。这是主人描述症状的**直接证据**。
- **结论**：prompt 缺字段 + AI 被迫走 cast 脚本，是症状的直接成因。

### 断点 3 — `CombatParticipant` 接口无 `ability` / 无技能列表 ❌

- **位置**：`src/sillytavern/types.ts:2031-2084`
- **证据**：字段全清单含 `modifiers? / automata? / weaponAtk / attributes / ...`，**没有 `ability` 字段，没有 `skills` 列表，没有 `skillPower`**。
- **结论**：即便上游把威力值带上了，这个类型也没地方放——`characterToCombatParticipant` 想填也没字段可填。

### 断点 4 — `characterToCombatParticipant` 不读技能 ❌

- **位置**：`src/sillytavern/combat-v2-types.ts:146-198`
- **证据**：函数体读 `char.inventory`（武器/防具）、收集装备 modifiers、收集**被动**技能的 automata（第 166 行 `.filter((s) => s.type === 'passive')`），但**主动技能被显式排除**，且没有任何代码读 `char.skills[i]` 的威力值。
- **注释原话**（第 163 行）："装备 automata 直接收；技能只收被动（主动技能在战斗中由 `$combat` action 触发，不在被动效果里）"——**设计意图是主动技能走 declare_attack 触发，但触发链路本身没接通威力**（见断点 6/7）。
- **结论**：characterToCombatParticipant 这一层根本不传主动技能信息进战斗。

### 断点 5 — `createCombatState` 不读 `bundle.skills`，`ability` 写死 undefined ❌

- **位置**：`src/sillytavern/combat-v3/state.ts:118-202`，关键行 152
- **证据**：
  ```ts
  // state.ts:151-152
  // M1 最小 ability：可由 bundle.skills 或参与者的 weaponAtk 兜底
  ability: undefined,
  ```
  紧邻的注释明说"可由 bundle.skills 兜底"，但函数体后续**完全没出现 `bundle.skills` 的读取**。`bundle.skills` 字段定义在 `combat-v3/types.ts:1086-1087` `skills?: Readonly<Record<string, { ability: ... }>>`——是 dead schema。
- **结论**：bundle.skills 是死字段，createCombatState 是 dead 兜底。

### 断点 6 — `declare_attack` 工具 schema 不接受威力参数 ❌

- **位置**：`src/sillytavern/agent-tools.ts:394-421`
- **证据**：schema 字段：`actorName / targetName / skillName? / intentionLevel / costs?`。**没有 skillPower / relevantAttribute / damageType / multiHitCount / divinity**。AI 想填也填不进。
- **对比**：`CombatActionRequest`（`types.ts:2130-2161`，v2 时代的请求类型）里**有** `skillPower? / relevantAttribute? / damageType? / multiHitCount? / weaponAtk?` 等字段——但 v3 工具 schema 退化掉了。注释（types.ts:2129）写"AI 调用 `$combat.attack()` 时生成"，是 v2 的设计意图，v3 没继承。
- **结论**：v3 工具 schema 与 v2 CombatActionRequest 之间的字段流失。

### 断点 7 — `coordinator.toolCallToCommand` 不填 `payload.ability` ❌

- **位置**：`src/sillytavern/combat-v3/coordinator.ts:528-549`
- **证据**：
  ```ts
  // coordinator.ts:537-549
  case 'declare_attack':
    return {
      commandId: id,
      expectedRevision: revision,
      kind: 'DeclareAttack',
      actorId: (args.actorName as string) ?? actorId,
      cost: 'attack',
      payload: {
        targetId: (args.targetName as string) ?? '',
        skill: args.skillName as string | undefined,
        intentionLevel: toIntention(args.intentionLevel),
        costs: args.costs as { mp?: number; sp?: number } | undefined,
      },
    };
  ```
  `DeclareAttack.payload` 类型（`combat-v3/types.ts:900-909`）**允许** `ability?: CombatUnitState['ability']`，但翻译函数**没填**。
- **结论**：类型允许、代码没填。即便工具 schema 加了字段，这里也需要补一行。

### 断点 8 — `handleAttack` 三个 fallback 全部 `skillPower: 0` ❌（核心收敛点）

- **位置**：`src/sillytavern/combat-v3/phases/attack.ts:128-136`
- **证据**：
  ```ts
  // attack.ts:128-136
  const ability = command.payload.ability ??            // 断点 7 留空 → undefined
    attacker.ability ??                                  // 断点 5 留空 → undefined
    {
      relevantAttribute: attacker.attributes.str,
      skillPower: 0,                                     // ★ 兜底字面量
      damageType: (command.payload.damageType ?? '物理') as never,
      intentionLevel: command.payload.intentionLevel,
      multiHitCount: 1,
      divinity: 0,
    };
  // attack.ts:265-275
  const damage = runDamagePipeline(
    buildDamageInput(attacker, defender, {
      relevantAttribute: ability.relevantAttribute,
      skillPower: ability.skillPower,                    // = 0
      ...
    }),
  );
  ```
- **结论**：所有断点的最终汇聚点。`ability.skillPower` 在 v3 内核里**永远是 0**。

### 旁路 D — effect-parser "技能威力"映射无消费方 ❌

- **位置**：`src/sillytavern/effect-parser.ts:69`（`技能威力: 'skillPower'`）
- **证据**：`effect-parser.ts` 把中文词条"技能威力"映射到 `ParsedEffect.key = 'skillPower'`，测试（`effect-parser.test.ts:194-197`）也覆盖了。但下游 `combat-v3/automata/compile.ts:130-144` 的 `compileParsedEffect` 调 `BUILTIN_ADAPTERS[parsed.key]`，而 **`builtins.ts:119` 的 `BUILTIN_ADAPTERS` 注册表里没有 `skillPower` 这一项**——也就是说"技能威力"词条在编译期会产 `UNSUPPORTED_CAPABILITY` 错误。
- **结论**：即便 AI 在 `<effect>` 里写"技能威力: +400"，也**不会进 ability**，反而会被当作不支持的词条丢弃/报错。这是另一条独立的断路。

### 旁注 — cast 脚本在 v3 战斗内无执行点 ❌

- **位置**：`grep -r 'cast' src/sillytavern/combat-v3/` 只在 spawn.test.ts 出现测试辅助函数，**没有任何 phase/automaton/kernel 代码挂载主动技能的 cast 脚本执行**。
- **对比**：`script-executor.ts:364-366` 的 `$resource.modifyHp` 收集器确实能把伤害落进 `effects.hpChanges`，但这是**战斗外路径**（NPC 叙事施法、非战斗 trigger）——战斗内 v3 内核没有"施放主动技能 → 执行 cast script"这一环。
- **结论**：cast 脚本里的 `$resource.modifyHp(target, -450)` 在战斗内**根本不会被执行**；它只在战斗外被引擎 script-executor 触发。也就是说，玩家在战斗里用火球术，**既不走 v3 结算（skillPower=0），cast 脚本也不跑**——主动技能在战斗内是**完全失联**的（除非主人额外用 `$event.emit` 在 damage.compute 等窗口挂副作用，但 item_gen prompt 没教这么做）。

### 链路里**通**的环节 ✅

- ✅ `<combat_trigger>` 标记识别 → dispatcher → `onCombatTrigger` 回调（`marker-protocol.ts:270` / `agent-orchestrator.ts:898-905` / `game-pipeline.ts:1133`）—— 通。
- ✅ `runCombatV3` 循环 + `routeRequiredInput` 路由（`coordinator.ts:120-202, 319-359`）—— 通。
- ✅ `handleAttack` → `runDamagePipeline` → `calcInitialDamage`（`attack.ts:265` / `combat-damage.ts:36`）—— 公式本身通，只是入参 skillPower=0。
- ✅ 战斗 v3 工具调用循环（`coordinator.ts:478` Agent 决策 → `toolCallToCommand` → `dispatch`）—— 通，但翻译漏字段（断点 7）。

---

## 3. 根因结论

**skillPower 链路真的断了，断点数量 = 8 个环节 + 2 条旁路。** 具体分层：

| 层次           | 断点                                                                                            | 性质                             |
| -------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| 类型层         | 断点 1（Skill 无字段）、断点 3（CombatParticipant 无字段）                                      | ❌ 类型设计遗漏                  |
| 数据生成层     | 断点 2（item_gen XML 无字段）                                                                   | ❌ prompt 与 schema 遗漏         |
| 数据转换层     | 断点 4（characterToCombatParticipant 不读技能）、断点 5（createCombatState 不读 bundle.skills） | ❌ 转换函数遗漏                  |
| 工具接口层     | 断点 6（declare_attack schema 无威力参数）                                                      | ❌ schema 退化（v2→v3 字段流失） |
| Command 翻译层 | 断点 7（toolCallToCommand 不填 ability）                                                        | ❌ 翻译函数遗漏                  |
| 收敛层         | 断点 8（handleAttack 三 fallback 全 0）                                                         | ❌ 兜底字面量                    |
| 旁路           | 旁路 D（effect-parser skillPower 无 adapter）                                                   | ❌ 词条映射悬空                  |
| 旁路           | cast 脚本在 v3 无执行点                                                                         | ❌ 战斗内外失联                  |

**是否有设计上的故意？——没有。** 证据：

1. v3 类型 `CombatUnitState.ability.skillPower`（`combat-v3/types.ts:521`）是**显式设计**的字段，注释"技能威力"。
2. 公式 `calcInitialDamage`（`combat-damage.ts:36-50`）**显式包含** "+ 技能威力"项，公式从世界书 #417617 核心数值表照搬。
3. `DeclareAttack.payload.ability?`（`combat-v3/types.ts:906`）**显式允许** AI 填入 ability。
4. `CombatDefinitionBundle.skills?`（`combat-v3/types.ts:1086`）**显式预留**了技能 ability 注入入口，注释"供 attack 取 ability 字段"。
5. `attack.ts:128` `command.payload.ability ??` 的 fallback 链**显式期待** payload 或 attacker.ability 有值。

设计**完整预留了 4 个注入点**（bundle.skills / participant.ability / payload.ability / attacker.ability），**但 4 个注入点的上游全都没填**。这是"设计了接口、没拉线"的典型断链，不是"故意让 AI 临时填值"的设计。

**与 cast 脚本 modifier 的边界**：cast 脚本里的 `$resource.modifyHp(target, -450)` 是**战斗外的固定伤害**通道（script-executor 收集器），而 v3 管线的 `ability.skillPower` 是**战斗内走命中/防御/抗性/暴击的结算**通道。两者**本不应重叠**——主动技能的主体威力应走结算通道（让防御/抗性发挥作用），cast 脚本只应承载"结算之外的附加效果"（如本例的"法力燃烧 buff"）。当前 item_gen 把主体伤害塞进 cast 是**被 schema 遗漏逼的**，不是合理设计。

---

## 4. 修复方案

### 4.0 修复策略总览

两条可选路径：

- **路径 A（推荐）：让 declare_attack 成为威力的唯一入口**——AI 在战斗中声明攻击时，由 Code 根据"技能名 + 攻击者"查到技能的 skillPower，填进 `payload.ability`。优点：威力值随当次战术决策走，能区分"普攻"和"火球术"；缺点：需要把 Skill.skillPower 字位加进类型 + item_gen 输出 + 落库。
- **路径 B：让 CombatParticipant 携带技能表**——characterToCombatParticipant 把 `char.skills` 塞进 participant，createCombatState 按"默认技能"初始化 attacker.ability。缺点：默认技能选择含糊（一个角色多个主动技能，默认用哪个？），且无法区分普攻和技能攻击。

**本设计采用路径 A**。理由：与 ADR-28 一致（AI 声明意图 `$combat.attack(skillName)`，Code 内部查技能并填值）；与 declare_attack 现有 schema 的 `skillName?` 参数天然对齐；不破坏 v3 的"一次声明一次结算"语义。

### 4.1 类型层修复（断点 1、断点 3）

**文件**：`src/sillytavern/types.ts`

**改动 1**（断点 1）：`Skill` 接口加字段（约第 836 行附近）：

```ts
export interface Skill {
  // ...现有字段...
  /** 🆕 主体技能威力（item_gen 按 Tier→威力区间表填写，战斗 v3 的 ability.skillPower 消费）。
   *  被动技能 / 纯辅助技能可为 undefined；战斗结算时缺省=0。
   *  与 modifiers(附加效果) / automata(自由效果 DSL) 的边界：
   *    - skillPower = 走结算管线的主体伤害基数（参与命中/防御/抗性/暴击）
   *    - modifiers/automata 里若再加 fixedDamage = 结算后追加的固伤（不参与防御） */
  skillPower?: number;
  // ...现有字段...
}
```

**改动 2**（断点 3）：`CombatParticipant` 接口加字段（约第 2083 行 `morale?` 后）：

```ts
export interface CombatParticipant {
  // ...现有字段...
  /** 🆕 主动技能快照（characterToCombatParticipant 从 char.skills 摘取主动技能，
   *  供 v3 内核 declare_attack 时按 skillName 查 skillPower）。
   *  被动技能的 modifiers/automata 仍走现有 modifiers/automata 通道，不在这里。 */
  activeSkills?: ReadonlyArray<{
    name: string;
    skillPower: number;
    damageType?: DamageType;
    relevantAttribute?: keyof typeof ATTRIBUTE_KEYS; // 或 string
    multiHitCount?: number;
    divinity?: number;
  }>;
}
```

> **备注**：不直接把整个 `Skill[]` 塞进 participant——只摘 v3 战斗所需的最小集。理由：(1) 避免循环引用和序列化负担；(2) Skill 里的 effects/scripts/buffs 在战斗内已有其他通道（modifiers / automata / buffs 各走各的），不需要重复带。

### 4.2 数据生成层修复（断点 2）

**文件**：`data/defaults/agent-config.json` 的 `agents.item_gen.systemPrompt`

**改动 A：`<skill>` XML schema 加威力属性**。在 item_gen systemPrompt 的两处 schema 模板（约第 1846 行附近的 char_gen 区块引用 + 约 19465 行附近的 item_result 模板）：

```xml
<skill name="技能名" type="active|passive" cost_type="HP|MP|SP|none" cost_amount="数值" cooldown="回合数" power="威力数值（主动技能必填，被动留空）">
  ...
</skill>
```

**改动 B：在 item_gen 思维链指引里加一条铁律**（靠近 Tier→威力区间表的位置）：

> 主动技能的主体伤害威力**必须**写进 `power` 属性（按 Tier→威力区间表取值），**禁止**写进 cast 脚本的 `$resource.modifyHp`。cast 脚本只承载结算之外的附加效果（buff / 削减 MP / 召唤 / 事件触发），不承载主体伤害。主体伤害由战斗 v3 内核读 `power` 走结算管线（命中/防御/抗性/暴击）。

**改动 C：火球术示例重写**（prompt 里的示例段落，如有）：

```xml
<skill name="火球术" type="active" cost_type="MP" cost_amount="200" cooldown="3" power="450">
  凝聚烈焰成球掷出...
  <effect name="烈焰爆裂">范围伤害100%，每命中目标损失400MP</effect>
  <script name="cast">$status.add(target, {name:'法力燃烧', ...});</script>
  <modifiers>
    {"category":"附加效果","source":"火球术","buffName":"法力燃烧",...}
  </modifiers>
  <buffs>
    {"name":"法力燃烧",...}
  </buffs>
</skill>
```

（注意：`$resource.modifyHp(target, -450)` 从 cast 脚本中**移除**——主体伤害改走 `power` 属性。）

> **风险**：item_gen 已有输出格式的存量数据（旧存档）没有 `power` 属性——见 §5.1 向后兼容。

### 4.3 数据转换层修复（断点 4、断点 5）

**文件**：`src/sillytavern/combat-v2-types.ts`

**改动**（断点 4）：`characterToCombatParticipant` 加一行摘取主动技能（约第 167 行之后）：

```ts
// 🆕 摘取主动技能的最小战斗集（供 v3 declare_attack 按 skillName 查 skillPower）
const activeSkills = (char.skills ?? [])
  .filter((s) => s.type === 'active' && typeof s.skillPower === 'number')
  .map((s) => ({
    name: s.name,
    skillPower: s.skillPower as number,
    // damageType / relevantAttribute / multiHitCount / divinity 若未来 Skill 加了，这里一并摘
  }));

return {
  // ...现有字段...
  activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
  // ...
};
```

**文件**：`src/sillytavern/combat-v3/state.ts`

**改动**（断点 5）：`createCombatState` 在 `ability: undefined` 那行（第 152 行）之后，**额外把 participant.activeSkills 写进 unit**。但 `CombatUnitState` 也需要加字段。

> **关键决策**：`ability` 仍然保持 undefined（per-attack 填，不 per-unit 填——一个单位有多个主动技能，每次 declare_attack 才决定用哪个）。**只把 activeSkills 快照搬进 CombatUnitState**。

**文件**：`src/sillytavern/combat-v3/types.ts`

**改动**：`CombatUnitState`（约第 467-531 行）加字段：

```ts
export interface CombatUnitState {
  // ...现有字段...
  /** 🆕 主动技能战斗快照（来自 CombatParticipant.activeSkills，供 declare_attack 时查） */
  activeSkills?: ReadonlyArray<{
    name: string;
    skillPower: number;
    damageType?: DamageType;
    relevantAttribute?: string;
    multiHitCount?: number;
    divinity?: number;
  }>;
}
```

`createCombatState`（state.ts:124-153）加一行：

```ts
units[id] = {
  // ...现有字段...
  ability: undefined,
  activeSkills: p.activeSkills, // 🆕
};
```

### 4.4 工具接口层修复（断点 6）

**决策**：**declare_attack 的 schema 不加 skillPower 参数**。理由：AI 不该填数值（ADR-28：AI 声明意图，Code 算数值）。AI 只声明 `skillName`，Code 根据 skillName 查 activeSkills 拿 skillPower。

**保留现有 schema**（`agent-tools.ts:397-419`）—— `skillName?` 已经够用。

> **可选增强**（不在本次范围）：让 declare_attack schema 加 `damageType? / relevantAttribute? / multiHitCount?` 让 AI 声明意图（如"这招用智力还是力量"、"物理还是魔法"），但这与 item_gen 已经给技能定型过的属性可能冲突。**建议保持现状**——技能定型由 item_gen 一次性完成，战斗中不重写。

### 4.5 Command 翻译层修复（断点 7，核心）

**文件**：`src/sillytavern/coordinator.ts`

**改动**：`toolCallToCommandSync` 的 `declare_attack` 分支（第 536-549 行）—— 在构造 payload 时，**根据 args.skillName 从 session 当前行单位的 activeSkills 查出 skillPower 等字段，填进 payload.ability**。

问题：`toolCallToCommandSync` 当前签名只收 `(name, args, revision, actorId)`，不持有 session 引用。需要扩参或重构。

**方案**：把 skillPower 查询从翻译函数挪到 `routeEnemyCommand` / `decideForUnit` 里（它们持有 session）。具体：

1. `toolCallToCommandSync` 保持纯翻译，不查技能（payload.ability 留空）。
2. 在 `coordinator.ts` 路由层（`routeEnemyCommand` 收到工具调用结果后、`session.dispatch` 前），加一个 `enrichWithAbility(command, session)` 钩子：
   ```ts
   function enrichWithAbility(cmd: CombatCommand, session: CombatSession): CombatCommand {
     if (cmd.kind !== 'DeclareAttack') return cmd;
     if (cmd.payload.ability) return cmd; // 已填不重写
     const skillName = cmd.payload.skill;
     const actor = session.snapshot().units[cmd.actorId];
     if (!skillName || !actor?.activeSkills) return cmd;
     const sk = actor.activeSkills.find((s) => s.name === skillName);
     if (!sk) return cmd; // 技能名查不到 → 走默认兜底（skillPower=0）
     return {
       ...cmd,
       payload: {
         ...cmd.payload,
         ability: {
           relevantAttribute: sk.relevantAttribute
             ? (actor.attributes[sk.relevantAttribute] ?? actor.attributes.int)
             : actor.attributes.int, // 法术类默认走智力；近战默认走 str（可按 damageType 分流）
           skillPower: sk.skillPower,
           damageType: sk.damageType ?? '物理',
           intentionLevel: cmd.payload.intentionLevel,
           multiHitCount: sk.multiHitCount ?? 1,
           divinity: sk.divinity ?? actor.ability?.divinity ?? 0,
         },
       },
     };
   }
   ```
3. 路由层每次拿到 AI 的工具调用 Command 后、dispatch 前，调一次 `enrichWithAbility`。

**玩家侧**（`game-pipeline.ts:1416-1422` 的 `submit`）：前端提交的 Command 也走同样的 enrich——但前端不持有 session，需要把 enrich 放在 `submit` 收到 Command 后立刻调，或让 kernel 在 dispatch 入口内部调。**推荐放在 kernel.dispatch 入口**（combat-v3/kernel.ts），保证玩家和敌方两条路径都过同一个 enrich。

> **更优方案**：把 enrich 逻辑放进 `handleAttack`（attack.ts:108）开头——既然 `attack.ts:128` 已经在读 `command.payload.ability ?? attacker.ability`，再加一层 "如果 payload.skill 指定了技能名，从 attacker.activeSkills 查" 即可。这样**所有调用 handleAttack 的路径**（敌方 AI / 玩家 / replay）自动受益，无需改 coordinator / kernel / game-pipeline。**本设计推荐这一方案**。

**最终推荐改法**（attack.ts:128 改写）：

```ts
// attack.ts:128 起
const declared = command.payload;
const attacker = state.units[command.actorId];

// 🆕 如果声明了技能名，从攻击者的 activeSkills 查 ability
const fromSkill =
  declared.skill && attacker.activeSkills
    ? attacker.activeSkills.find((s) => s.name === declared.skill)
    : undefined;

const ability = declared.ability ??
  (fromSkill
    ? {
        relevantAttribute:
          (fromSkill.relevantAttribute && attacker.attributes[fromSkill.relevantAttribute]) ||
          attacker.attributes.int,
        skillPower: fromSkill.skillPower,
        damageType: (fromSkill.damageType ?? '物理') as DamageType,
        intentionLevel: declared.intentionLevel,
        multiHitCount: fromSkill.multiHitCount ?? 1,
        divinity: fromSkill.divinity ?? attacker.ability?.divinity ?? 0,
      }
    : undefined) ??
  attacker.ability ?? {
    relevantAttribute: attacker.attributes.str,
    skillPower: 0,
    damageType: (declared.damageType ?? '物理') as never,
    intentionLevel: declared.intentionLevel,
    multiHitCount: 1,
    divinity: 0,
  };
```

这一改让 fallback 链变成四层：`payload.ability → activeSkills[skillName] → attacker.ability → 字面量兜底`，所有上游断点（5/6/7）即使不修，也能靠 activeSkills 查到威力。

### 4.6 旁路 D 修复（可选，低优先）

**文件**：`src/sillytavern/combat-v3/automata/builtins.ts`

**改动**：`BUILTIN_ADAPTERS`（第 119 行）加一个 `skillPower` adapter。但**不建议**——"技能威力"作为 effect 词条会让 AI 既可以写进 `<skill power="...">` 属性、又可以写进 `<effect>技能威力: +400</effect>`，**双通道引发重复计算风险**（见 §5.2）。

**建议**：在 effect-parser 里把"技能威力"词条标记为**deprecated / 仅警告**，指引 AI 走 `power` 属性。或者完全移除该映射，让 effect-parser 产 UNSUPPORTED_CAPABILITY 提示 AI 改用 `power` 属性。

### 4.7 修复覆盖矩阵

| 断点   | 修复方案                                                    | 改动文件                      | 改动量          |
| ------ | ----------------------------------------------------------- | ----------------------------- | --------------- |
| 1      | Skill 加 skillPower?                                        | types.ts                      | +1 字段         |
| 2      | item_gen XML 加 power 属性 + 示例                           | agent-config.json             | prompt 文案改动 |
| 3      | CombatParticipant 加 activeSkills?                          | types.ts                      | +1 字段         |
| 4      | characterToCombatParticipant 摘主动技能                     | combat-v2-types.ts            | +8 行           |
| 5      | createCombatState 透传 activeSkills；CombatUnitState 加字段 | combat-v3/state.ts + types.ts | +3 行 / +1 字段 |
| 6      | **不改**（保持 skillName? 即可）                            | —                             | 0               |
| 7      | **不改**（改在 attack.ts 收口）                             | —                             | 0               |
| 8      | handleAttack 加 activeSkills 查询层                         | combat-v3/phases/attack.ts    | +18 行          |
| 旁路 D | effect-parser "技能威力"词条改警告                          | effect-parser.ts（可选）      | +3 行           |

---

## 5. 风险与权衡

### 5.1 向后兼容（旧存档 Skill 无 skillPower 字段）

- **影响**：现有存档里的 Skill 对象没有 `skillPower` 字段（旧 item_gen 输出）。
- **缓解**：`Skill.skillPower?` 是可选字段。`characterToCombatParticipant` 用 `typeof s.skillPower === 'number'` 过滤，旧技能直接被排除出 `activeSkills`，战斗中查不到 → 走 `skillPower: 0` 兜底——**与当前行为完全一致**（不退化）。
- **迁移**：不需要数据迁移。旧技能的 cast 脚本里若已有 `$resource.modifyHp(target, -450)`，仍会在战斗外路径执行（与现状一致）。新战斗里这些旧技能的主体伤害为 0（威力值还在 cast 脚本里，但 v3 内核不会执行它——见旁注）。
- **建议**：提供一个**一次性迁移脚本**（可选），扫描 Skill.scripts.cast 里的 `$resource.modifyHp(target, -N)` 正则提取 N 写进 skillPower 字段、并清空 cast 脚本里的该语句。主人审批后再做。

### 5.2 重复计算风险（skillPower × modifier 固伤）

- **场景**：如果 AI 在 `<skill power="450">` 里写了主体威力，又在 `<modifiers>` 里写了一条 `{"category":"附加效果","fixedDamage":450,...}`，那 450 会被算两次（一次进 calcInitialDamage 的 skillPower 项，一次进管线 Step 6a 的 fixedDamageBonus）。
- **缓解**：
  - item_gen prompt 明确区分两者：`power` = 主体伤害（走结算），`modifiers/fixedDamage` = 结算后追加固伤（不参与防御）。给出反例对照。
  - effect-parser 的"技能威力"词条改警告/移除（§4.6），避免第三条通道。
- **审查**：item_gen 输出审查（agent_expected_analysis.md 的检查点）加一条"power 与 modifiers 固伤不重复"。

### 5.3 AI 填值可靠性

- **担心**：AI 会不会乱填 power（T1 技能填 99999）？
- **缓解**：item_gen prompt 已有 Tier→威力区间表作为评估参考，且要求"对照 Tier 强度对齐"。现有火球术实测验证（450 落在 T2 区间 300-800）证明 AI **能正确按区间取值**。当前问题是取对了值但塞错了字段（cast 脚本而非 power 属性），修复 schema 后 AI 会按 schema 走。
- **Code 层兜底**（可选）：`characterToCombatParticipant` 摘 activeSkills 时按 attacker.tier 做 clamp（超出区间 ±20% 截断 + warn）。这是**可选增强**，不在本次修复范围。

### 5.4 多主动技能 / 默认技能歧义

- **场景**：一个角色有 3 个主动技能（火球术 / 冰枪 / 奥术飞弹），declare_attack 只声明了 skillName='火球术'——能正确查到。但若 AI 声明 `skillName` 为空（普攻）——走 `skillPower: 0` 兜底，正确。若 AI 声明了不存在的技能名（hallucination）——查不到，走兜底 0，但应在 agentLog 产 warn。
- **缓解**：attack.ts 的 `fromSkill` 查询若未命中，push 一条 `AttackDeclared` 事件带 `skillResolved: false` 标记，供 debug 面板提示。

### 5.5 relevantAttribute 分流

- **场景**：火球术应走 `int`（智力），斩击应走 `str`（力量）。但 Skill 接口当前没有 relevantAttribute 字段。
- **缓解**：
  - **方案 A（推荐，本次做）**：Skill 加 `relevantAttribute?: 'str'|'dex'|'con'|'int'|'spi'`，item_gen 在生成技能时声明（法术类填 int，物理类填 str，敏捷类填 dex）。
  - **方案 B（兜底）**：activeSkills 不带 relevantAttribute，attack.ts 按 damageType 推断（'物理'→str，'魔法'→int，'真实'→str）。
  - 建议方案 A，让 AI 显式声明。但若主人想减少改动面，方案 B 也够用。

### 5.6 cast 脚本与 v3 内核的执行点（未来工作，本次不做）

- **现状**：cast 脚本在 v3 战斗内**无执行点**。这意味着即便火球术的 power=450 正确进结算，其 cast 脚本里的 `$status.add(target, {法力燃烧})` 也**不会在战斗内触发**——法力燃烧 buff 不会上。
- **本次范围**：不修。理由：cast 脚本执行点是另一个独立的大坑（涉及 script-executor 与 v3 窗口系统的桥接、战斗内 $resource.modifyHp 与结算管线的边界）。本次只修 skillPower 主体伤害链路。
- **临时缓解**：item_gen prompt 把 cast 脚本里的 buff 上挂**改写为 `<modifiers>` + `<buffs>` 子元素**（这是 item_gen prompt 当前已经指引的路径——见 `_tmp_contract.txt` 第 17 行"cast 中: $event.emit('事件名')"附近的指引）。buffs 子元素由 createCombatState 编译进 activeEffects，能在战斗内触发。**本次修复应在 item_gen prompt 里加一条**："buff / 减益效果必须写进 `<buffs>` 子元素 + `<modifiers>` 声明，禁止只写在 cast 脚本里"。

---

## 6. 验证清单

### 6.1 单元测试

| 测试点                                          | 测试文件（建议新增/扩展）                        | 断言                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| characterToCombatParticipant 摘主动技能         | `combat-v2-types.test.ts`                        | 给定含主动技能（skillPower=450）的角色，返回 `participant.activeSkills[0].skillPower === 450`                      |
| createCombatState 透传 activeSkills             | `combat-v3/state.test.ts`                        | 给定 bundle.participants[0].activeSkills，断言 `state.units[id].activeSkills` 同源                                 |
| handleAttack 按 skillName 查 skillPower         | `combat-v3/phases/attack.ts` 或 `phases.test.ts` | 攻击者 activeSkills 含"火球术 power=450"，DeclareAttack.skill="火球术"，断言 calcInitialDamage 入参 skillPower=450 |
| skillName 不匹配时兜底 0                        | 同上                                             | DeclareAttack.skill="不存在的技能"，断言 skillPower=0 且事件流有 warn                                              |
| 旧存档 Skill 无 skillPower                      | `combat-v2-types.test.ts`                        | 旧 Skill（无 skillPower 字段）被过滤出 activeSkills，行为与当前一致                                                |
| effect-parser "技能威力"词条改警告（若做 §4.6） | `effect-parser.test.ts`                          | 解析"技能威力: +400"产 deprecated 警告，不再产 skillPower key                                                      |

### 6.2 集成测试

- **复用** `tests/realtime_export/fated-poem-debug-9d7ca32b-1785843679499.json` 的 item_gen 输出（火球术 power=450）作为 fixture，驱动一场战斗，断言攻击者用火球术时 `AttackResolved` 事件的伤害值 > 450（因公式还有属性×10×层级系数 + 武器攻击力）。
- **回归**：现有 `combat-v3/phases/phases.test.ts`、`combat-v3/reducer.test.ts`、`combat-integration-scenario.test.ts` 全绿（这些测试的 bundle 大多 `ability: undefined`，走兜底 0，行为不变）。

### 6.3 真机验证

- 开局选火球术的角色进战斗 → declare_attack 声明"火球术" → 观察伤害面板的"技能威力"项是否非 0。
- DebugPanel 导出 agentLog → 查 `AttackDeclared` / `AttackResolved` 事件里的 `ability.skillPower` 实际值。
- 对照 `combat-damage.ts:48` 的 formula 字符串，确认公式里"+ 技能威力"项 = 450。

---

## 7. 附录

### 7.1 Tier→威力区间表（来自 item_gen systemPrompt）

| Tier | 品质上限 | 技能威力区间 | 消耗区间(MP/SP) | 装备攻/防区间 | 技能数 |
| ---- | -------- | ------------ | --------------- | ------------- | ------ |
| T1   | 优良     | 100-300      | 50-150          | 30-80         | 1-2    |
| T2   | 稀有     | 300-800      | 150-500         | 80-200        | 2-3    |
| T3   | 史诗     | 800-1500     | 500-1200        | 200-500       | 3-4    |
| T4   | 传说     | 1500-2500    | 1200-2400       | 500-900       | 3-5    |
| T5   | 神话     | 2500-4000    | 2400-10000      | 900-1500      | 4-5    |
| T6   | 神话+    | 4000-8000    | 10000-20000     | 1500-3000     | 5-7    |
| T7   | 唯一     | 8000+        | 20000+          | 3000+         | 完整   |

### 7.2 伤害公式（来自 `combat-damage.ts:36-50` + 世界书 #417617）

```
初始伤害 = 关联属性 × 10 × 层级系数 + 技能威力 + 武器攻击力
```

- 层级系数（getCombatCoefficient）：T1=2.0 / T2=2.8 / T3=4.0 / T4=8.0 / T5=15.0 / T6=35.0 / T7=80.0
- 后续 8 步管线：多段分割 → 穿透 → 装备减免 → 抗性 → 暴击 → 附加固伤 → clamp → 意图系数（详见 `combat-damage.ts`）

### 7.3 关键文件清单

- `src/sillytavern/types.ts:826` — Skill 接口
- `src/sillytavern/types.ts:2031` — CombatParticipant 接口
- `src/sillytavern/types.ts:2130` — CombatActionRequest（v2 遗留，含 skillPower? 字段）
- `src/sillytavern/combat-v2-types.ts:146` — characterToCombatParticipant
- `src/sillytavern/combat-v3/types.ts:467` — CombatUnitState（ability 字段在 517）
- `src/sillytavern/combat-v3/types.ts:1079` — CombatDefinitionBundle（skills? 死字段在 1086）
- `src/sillytavern/combat-v3/state.ts:118` — createCombatState
- `src/sillytavern/combat-v3/coordinator.ts:528` — toolCallToCommandSync
- `src/sillytavern/combat-v3/phases/attack.ts:108` — handleAttack（核心收敛点 128）
- `src/sillytavern/combat-damage.ts:36` — calcInitialDamage（公式）
- `src/sillytavern/agent-tools.ts:397` — declare_attack schema
- `src/sillytavern/effect-parser.ts:69` — "技能威力" 映射（旁路 D）
- `data/defaults/agent-config.json` — item_gen / combat_v3 systemPrompt
- `tests/realtime_export/fated-poem-debug-9d7ca32b-1785843679499.json` — 实测火球术 power=450 落进 cast 脚本的证据
