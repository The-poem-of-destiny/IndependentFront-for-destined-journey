# 词条效果贯穿链路实施计划（item_gen / craft / 战斗）

> 📅 **日期**：2026-08-01
> 📌 **状态**：**S1+S2+S3+S4 已完成**（2026-08-01，5126 tests 全绿）。
> 🔗 **关联**：`docs/planning/combat-v3-fix-backlog.md`（待办追踪）· `docs/reference/combat-system-architecture-v3.md`（v3 架构）· 世界书《品质效果限定》《生产制作协议》《核心数值表》《技能装备道具生成规则》
>
> **背景**：M5 退役 v2 后排查发现，item_gen 生成的装备词条（modifiers）在 v3 战斗/制造里没生效。本计划分 4 阶段把「AI 生成 → 解析 → 落库 → 战斗/制造消费」全链路打通。

---

## 0. 世界书依据（为什么这样做）

- 《品质效果限定》「效果类别」：**检定**类含「生产检定修正」，五维相关效果仅限此类。六类 modifier 已覆盖固伤/百分比/资源/检定/附加效果/特殊机制。
- 《品质效果限定》「检定修正表」：**生产检定**列（稀+[2-4] / 史+[5-7] / 传+[8-10] / 神+[11-15]）。
- 《生产制作协议》检定公式：`核心属性 + 各检定加值 + d20`；「检定加值: 属性[A] + **技能[B] + 道具[C] + 身份[D]**」；「基础DC + ... **-[物品/技能A]DC[-X]** = 最终DC」。
- 《核心数值表》「生产对应品质消耗」：半成品/成品按品质消耗 HP/MP/SP。
- 《技能装备道具生成规则》：技能标签「辅助向: 锻造/炼金/烹饪/裁缝」——**技能可以标辅助向，即制造相关技能**。

**结论**：世界书明确支持「物品/技能/身份介入制造」——物品/技能提供**生产检定加值**（进 `fixedBonus`）或 **DC 减免**（进 `finalDC`）。代码参数位已有，缺接线。

---

## 1. 现状链路（逐环节）

```
AI 生成           解析              落库              消费
──────────────────────────────────────────────────────────────
item_gen ──→ <modifiers> XML ──→ ItemGenOutput.modifiers ✅
  │                                  ↓
  │              buildCraftPatches 写 patch.value.modifiers ✅
  │                                  ↓
  │              applyAddItem 落库 ❌ 丢 modifiers/buffs/divinity
  │                                  ↓
  │              CharacterState.inventory[].modifiers（类型有，落库丢）
  │                                  ↓
  └────────────→ characterToCombatParticipant（已修，读 .modifiers）→ v3 战斗 ✅
craft_gen ──→ item_gen ──→ 同 ItemGenOutput ──→ 同链路
craft_resolver → 产物 effects: []（未接）
反向：craft_check/settle → toolBonus/skillBonus/identityBonus 恒 0 ❌
```

---

## 2. 阶段划分

| 阶段 | 内容                                               | 验收                                              |
| ---- | -------------------------------------------------- | ------------------------------------------------- |
| S1   | 修复 applyAddItem 落库丢 modifiers（正向链路闭环） | craft/item_gen 产物 modifiers 落库保留            |
| S2   | 物品/技能介入制造（反向链路）                      | 装备带「生产检定」modifier → craft_check 加值生效 |
| S3   | automaton 解析 + 落库 + 编译（问题 1）             | AI 输出的 automaton 进 v3 战斗                    |
| S4   | item_gen/craft_gen prompt 模板（问题 2）           | AI 能产出合规 automaton + affix 词条              |

**实施顺序**：S1+S2 先行（主人拍板：先评估制造兼容）→ S3 automaton 链路 → S4 prompt 模板 + 失败品 + Skill 落库。四阶段全部完成。

---

## 3. S1 + S2 + S3：制造 + 词条效果链路修复

> ✅ **已完成 2026-08-01**（5109 tests 全绿）。下方为实施细节留档；实作要点有 3 处与原始计划不同：
>
> 1. **S2c 按世界书语义落地**：toolBonus **只进 fixedBonus（检定加值分子），不再同时减免 finalDC**（世界书「检定加值」与「DC 减免」是两条独立声明）。craft-dc.ts 的 `calcCraftCheck` 已拆（`bonusDCReduction` 只剩 locationBonus + 品质产能）。
> 2. **防泄漏**：`checkType='生产'` 在 `compile.ts` 检定分支返回 `null`（不编译进战斗），否则 `slotMap['生产']=undefined` 会落到 hitBonus，装备生产加值误成命中。
> 3. **skillBonus 留 0**：落库 `CharacterState.skills` 的 `Skill` 接口**无 modifiers 字段**（只有 ItemGenOutput.skills[] 输出类型有）。技能生产检定加值字段级已支持，等 S4 补落库字段再收。

### S1: applyAddItem 补收 modifiers（3 行）

**文件**：`src/sillytavern/state-manager.ts` 的 `applyAddItem`（行 763-796）

**改动**：`char.inventory.push({...})` 补收 `modifiers`/`buffs`/`divinity`（`InventoryItem` 类型已有，行 808/810/812）。

```ts
char.inventory.push({
  ...现有 9 字段,
  modifiers: value.modifiers,
  buffs: value.buffs,
  divinity: value.divinity,
});
```

**影响**：craft_gen→item_gen 产物 + item_gen 独立链（开局/char_gen）的装备 modifiers 落库保留。

**验证**：`state-manager.test.ts` 加「add_item 带 modifiers → 落库保留」用例。

### S2: 物品/技能介入制造（反向链路）

**S2a. modifier checkType 补 '生产'**

- `effect-types.ts` `CheckModifier.checkType`（行 60）：`'命中' | '闪避' | '先攻' | '抵抗' | '属性'` → 加 `'生产'`
- `combat-item-validator.ts` `VALID_CHECK_TYPES`（行 47）：加 `'生产'`
- `automata/builtins.ts` / `compile.ts` 的 `slotMap`（若校验 checkType）同步

**S2b. craft_check/craft_settle 收集「生产检定」modifier**

`agent-tools.ts` 的 craft_check（行 633）/craft_settle（行 693）构造 request 时：

```ts
// 从角色已装备物品收集生产检定 modifier → toolBonus/skillBonus
function collectCraftBonuses(char: CharacterState): {
  toolBonus: number;   // 道具提供（equipped 物品的生产检定 modifier）
  skillBonus: number;  // 技能提供（char.skills[] 的生产检定 modifier，技能带 modifiers）
} {
  const tool = char.inventory.filter(i => i.equippedSlot)
    .flatMap(i => i.modifiers ?? [])
    .filter(m => m.category === '检定' && (m as CheckModifier).checkType === '生产')
    .reduce((sum, m) => sum + (m as CheckModifier).bonus, 0);
  const skill = (char.skills ?? []).flatMap(s => s.modifiers ?? [])
    .filter(...同上)
    .reduce(...);
  return { toolBonus: tool, skillBonus: skill };
}
```

- `toolBonus` → 进 `fixedBonus` + `bonusDCReduction`（craft-dc 已把 toolBonus 同时用于加值和 DC 减免，需确认这是否符合世界书——世界书是「检定加值」和「DC 减免」两条，可能分开更准，见 S2c）
- `skillBonus` → 进 `fixedBonus`
- `identityBonus`：身份加成，现有代码没来源，可先留 0（不阻塞）

**S2c. DC 减免 vs 检定加值分开（世界书语义）**

世界书：

- 「检定加值: 属性+技能+道具+身份」→ 进 `fixedBonus`（totalValue 分子）
- 「- [物品/技能]DC[-X]」→ 进 `finalDC`（DC 分母）

现有 `craft-dc.ts` 把 `toolBonus` 同时进 fixedBonus 和 dcReduction（行 114 `let dcReduction = toolBonus`）——**这会把道具加值算两遍**。需确认世界书意图：生产检定 modifier 应该只进 `fixedBonus`（检定加值），DC 减免是另一条（材料 DC 修正已实现）。

**建议**：S2b 只把「生产检定」modifier 填进 `skillBonus`/`toolBonus` 走 fixedBonus；`dcReduction` 保持现有逻辑（toolBonus 也减 DC）——除非发现真机问题再拆。**在计划里标注这是待确认点。**

**S2d. 测试**

- `craft-resolver.test.ts`：带生产检定 modifier 的角色 → craft_check 检定加值正确
- `agent-tools.test.ts`：craft_check 工具传 toolBonus 生效
- 集成：装备「锻造 +5」→ craft_check 的总值含 +5

### S3: automaton 解析 + 落库 + 编译（问题 1）— ✅ 已完成 2026-08-01

> **解析**：`char-gen-agent.ts` 新增 `parseAutomataXML`（复用 parseModifiersXML 容错模式：自闭合视为空 / 跳过注释 / 单行 JSON parse 失败 warn 跳过 / 缺 subscribe+intents 判别跳过）；接入 `parseSkillsXML`/`parseEquipmentXML`/`parseInventoryXML` + JSON 兜底 `parseItemGenJSONLoose`；描述预剥离 automaton 块防污染。
>
> **类型**：`ItemGenOutput`（skills/equipment/inventory 三组元素）+ `InventoryItem` + `Skill` + `CombatParticipant` 加 `automata?: EffectAutomaton[]`。
>
> **落库**：`assembleCharacterState`（equipment/inventory/skills 三处透传）+ `applyAddItem`（补收 automata）+ `buildCraftPatches`（equipment/inventory 透传）。
>
> **编译**：`characterToCombatParticipant` 收集已装备物品 automata + **被动技能** automata（主动技能不走被动效果）→ `CombatParticipant.automata`；`createCombatState` `compileEffectProgram({...automata})` 编译进 activeEffects。DSL 编译期 9 条校验（A3-3）自动兜底不合规 automaton。
>
> **验收**：解析 4 用例（equip/skill/无 automaton/形状粗判）+ 编译 2 用例（damage.after 生效 / subscribe 越界剔除）+ 落库 2 用例（add_item 保留 / buildCraftPatches 透传）+ characterToCombatParticipant 4 用例。5121 tests 全绿。

### S4（✅ 已完成 2026-08-01，5126 tests 全绿）

> **S4a Skill 落库补 modifiers**：`Skill` 接口补 `modifiers`/`buffs`/`divinity` 字段（S3 已加 automata）+ `assembleCharacterState` skills 映射透传 → 技能「生产检定」modifier 落库 → `agent-tools.collectCraftBonuses` 收集技能生产加值 → craft_check/craft_settle 的 `skillBonus` 位生效（**S2-2 闭环**）。
>
> **S4b craft_gen prompt**：`<item_requests>` 的 `<request>` 加 `<affix>` 词条意图子元素（成功 + 失败品都写）；失败/大失败时也输出 `<item_requests>`（失败品/残料，type="inventory"、quality=普通）；成功/失败 XML 示例 + 自检清单同步。
>
> **S4c item_gen prompt**：M3.5 的 `<automaton>` 注释段补**具体 JSON 模板 + 2 示例**（damage.after 吸血 / check.hit 残血追击）+ 18 窗口清单 + trigger 封闭文法 + intents 8 大类 + ctx 根段白名单；新增「收到 `<affix>` 必须翻译成 modifiers/automaton」硬性规则；`<equip>` 示例补完整 `<modifiers>`（含 checkType='生产'）+ `<automaton>` 块。
>
> **S4d 失败品链路**：`runCraftGenChain` item_gen 调用条件从 `success && itemRequests.length>0` 改为 `itemRequests.length>0`（成功/失败都发）；`buildCraftPatches` 失败时只落失败品 add_item（不 auto-equip / 不结算 EXP/FP），成功路径保持 auto-equip + 结算。测试 3 个新用例（失败装备失败品 / 失败库存失败品 / 成功回归）。
>
> **改动文件**：`types.ts`（Skill 补 modifiers/buffs/divinity）、`char-gen-agent.ts`（assemble 透传）、`agent-tools.ts`（collectCraftBonuses 收集技能加值）、`craft-gen-chain.ts`（失败品链路）、`agent-config.json`（craft_gen/item_gen systemPrompt）、3 个测试文件。5126 tests 全绿。

---

## 4. 文件改动清单

| 文件                                       | 动作                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `src/sillytavern/state-manager.ts`         | S1: applyAddItem 补收 modifiers/buffs/divinity                              |
| `src/sillytavern/state-manager.test.ts`    | S1: add_item 带 modifiers 落库用例                                          |
| `src/sillytavern/effect-types.ts`          | S2a: CheckModifier.checkType 加 '生产'                                      |
| `src/sillytavern/combat-item-validator.ts` | S2a: VALID_CHECK_TYPES 加 '生产'                                            |
| `src/sillytavern/agent-tools.ts`           | S2b: craft_check/craft_settle 收集生产检定 modifier → toolBonus/skillBonus  |
| `src/sillytavern/craft-resolver.test.ts`   | S2d: 生产检定 modifier 影响检定                                             |
| `src/sillytavern/agent-tools.test.ts`      | S2d: craft_check toolBonus 生效                                             |
| `src/sillytavern/types.ts`                 | S4a: Skill 补 modifiers/buffs/divinity 字段                                 |
| `src/sillytavern/char-gen-agent.ts`        | S4a: assembleCharacterState skills 透传 modifiers/buffs/divinity            |
| `src/sillytavern/agent-tools.ts`           | S4a: collectCraftBonuses 收集技能生产加值 → skillBonus                      |
| `src/sillytavern/craft-gen-chain.ts`       | S4d: 失败品链路（item_gen 成功/失败都发 + buildCraftPatches 失败落失败品）  |
| `data/defaults/agent-config.json`          | S4b/S4c: craft_gen/item_gen systemPrompt（affix + 失败品 + automaton 模板） |

---

## 5. 风险与回滚

- **S2c DC 减免语义**：toolBonus 同时进加值和 DC 减免可能不符合世界书（待确认）。风险低（加值通常小幅），真机发现问题再拆。
- **checkType 加 '生产' 影响战斗**：`VALID_CHECK_TYPES` 加 '生产' 后，战斗侧 collect_mods 会收集「生产检定」modifier 进战斗吗？——需确认战斗侧是否按 checkType 过滤（若 collect_attacker_mods 全收，生产 modifier 可能误进战斗）。**在实现时确认，必要时战斗侧过滤 checkType='生产'。**
- **回滚**：每阶段独立提交，单阶段可回退。

---

## 6. 验收断言

| #    | 断言                                                                | 状态                                                          |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| S1-1 | craft 产物带 modifiers → add_item 落库 → inventory[].modifiers 保留 | ✅ 有测试                                                     |
| S1-2 | item_gen 独立链产物同样保留                                         | ✅ 同一 applyAddItem 路径                                     |
| S2-1 | 装备「生产检定 +5」→ craft_check 返回的 totalValue 含 +5            | ✅ 有测试（agent-tools.test.ts）                              |
| S2-2 | 技能「锻造辅助 +3」→ craft_check 含 +3                              | 🟡 阻塞：Skill 接口无 modifiers 字段，待 S4 补                |
| S2-3 | 无加成角色 → 检定值不变（回归）                                     | ✅ 有测试（craft-dc.test.ts 回归护栏）                        |
| S2-4 | 战斗侧不误收「生产检定」modifier                                    | ✅ 有测试（compile.test.ts：checkType='生产' → 零 automaton） |
| S3-1 | `<equip>`/`<skill>` 内 `<automaton>` JSON → 解析进 automata[]       | ✅ 有测试（char-gen-agent.test.ts 解析 4 用例）               |
| S3-2 | automata 落库保留（add_item / buildCraftPatches）                   | ✅ 有测试（state-manager / craft-gen-chain）                  |
| S3-3 | characterToCombatParticipant 收集装备 + 被动技能 automata           | ✅ 有测试（combat-v2-types.test.ts）                          |
| S3-4 | createCombatState 编译 automata 进 activeEffects                    | ✅ 有测试（state.test.ts：damage.after 生效 / 越界剔除）      |
