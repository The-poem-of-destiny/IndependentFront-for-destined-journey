# 战斗 v3 修复待办追踪（backlog）

> 📌 **定位**：记录「开发过程中突然意识到、暂不阻塞当前主线、但应该修/应该补」的修复项。持续累积，完成即标 ✅。
> 📅 **创建**：2026-08-01（M5 完成后，排查 item_gen↔战斗链路时起）
>
> **用法**：新发现直接往顶部加。每项一句话说清「问题 + 落点 + 为什么」。攒够一批或到里程碑间隙时，挑出来做。
> **关联**：`docs/planning/2026-08-01-item-gen-combat-link-plan.md`（词条效果贯穿 AI 生成→解析→落库→战斗/制造消费的实施计划）

---

## 修复项

### ✅ 战斗 v3 物品 modifiers 链路断裂（已修 2026-08-01）

- **问题**：M5 退役 v2 后，item_gen 生成的装备 modifiers（命中+5、附加流血）在 v3 战斗里完全不生效。
- **根因**：`characterToCombatParticipant` 丢弃物品 modifiers；`createCombatState` 不编译参与者效果（activeEffects 恒 EMPTY）。
- **修复**：`CombatParticipant` 加 `modifiers` 字段 + `characterToCombatParticipant` 收集装备 modifiers + `createCombatState` 编译进 activeEffects。
- **状态**：✅ 已完成（5103 tests 全绿）。落点 `types.ts` / `combat-v2-types.ts` / `combat-v3/state.ts` / `state.test.ts`。

### ✅ applyAddItem 落库丢 modifiers/buffs/divinity（已修 2026-08-01）

- **问题**：craft_gen→item_gen 产物写 `patch.value.modifiers`，但 `state-manager.applyAddItem` 落库只收 9 字段，丢 `modifiers`/`buffs`/`divinity`。
- **影响**：craft 产物 + item_gen 独立链（开局/char_gen）装备的词条效果都落不了库 → 战斗不生效。**共享同一缺口，修一处通两条链。**
- **修复**：`applyAddItem` 补收 3 字段（`InventoryItem.modifiers` 类型已有，行 808）。
- **状态**：✅ 已完成（S1，2026-08-01，与制造接线一起做）。

### ✅ 物品/技能介入制造流程的接线（反向链路，已修 2026-08-01）

- **问题**：世界书《品质效果限定》检定修正表有「生产检定」列 + 《生产制作协议》公式含「技能[B] + 道具[C] + 身份[D]」，但 agent-tools 的 craft_check/craft_settle 构造 request 时 `toolBonus`/`skillBonus`/`identityBonus` 全没传（恒 0）。
- **落点**：craft_check/craft_settle 从角色已装备物品收集「生产检定」modifier → 填 bonus；modifier 的 checkType 补 `'生产'`。
- **状态**：✅ 已完成（S2，2026-08-01）。**含 S2c**：toolBonus 只进检定加值（fixedBonus 分子），不再同时减免 DC（finalDC 分母）——对齐世界书《生产制作协议》「检定加值」与「DC 减免」两条独立声明。**防泄漏**：checkType='生产' 不编译进战斗（compile.ts 返回 null，否则 slotMap 落到 hitBonus 误成命中）。

### ✅ `<automaton>` JSON 块无人消费（问题 1，已修 2026-08-01）

- **问题**：M3.5 加的 item_gen prompt 里 `<automaton>` 段只有注释引导、无具体模板，且 `parseEquipmentXML`/`parseSkillsXML` 都没解析——AI 输出了也不进战斗。
- **落点**：parseEquipmentXML 解析 automaton 块 + `ItemGenOutput`/`InventoryItem` 加 `automata` 字段 + `characterToCombatParticipant`/`createCombatState` 编译 automata（复用 modifiers 编译路径）。
- **状态**：✅ 已完成（S3，2026-08-01）。解析（XML+JSON 兜底）/ 类型（ItemGenOutput/InventoryItem/Skill/CombatParticipant）/ 落库（assemble/applyAddItem/buildCraftPatches）/ 编译（characterToCombatParticipant 收集装备+被动技能 automata，createCombatState 编译进 activeEffects）全链路打通。

### ✅ item_gen prompt 缺 automaton 具体模板（问题 2，已修 2026-08-01 S4c）

- **问题**：prompt 里 automaton 只是注释说明，AI 大概率产出不合规 JSON。
- **修复**：item_gen prompt 补 `<automaton>` 具体 JSON 模板 + 2 示例（damage.after 吸血 / check.hit 残血追击）+ 18 窗口清单 + trigger 封闭文法 + intents 8 大类 + ctx 根段白名单。不合规 JSON 仍由 DSL 编译期 9 条校验兜底剔除。
- **状态**：✅ 已完成（S4c，5126 tests 全绿）。

### ✅ craft_gen 创意词条 → item_gen 落地没有机制保证（已修 2026-08-01 S4b/S4c）

- **问题**：craft_gen 在 `<item_requests>` 写自然语言（如「锻火余温，剑身残留暖意」），item_gen 要不要把它翻译成 `<modifiers>` 全凭自觉。
- **修复**：craft_gen prompt 的 `<item_requests>` 加 `<affix>` 词条意图子元素（成功 + 失败品都写）；item_gen prompt 新增「收到 `<affix>` 必须翻译成 modifiers/automaton」硬性规则。
- **状态**：✅ 已完成（S4b/S4c）。

### ✅ 制作失败无产物（已修 2026-08-01 S4d）

- **问题**：craft_gen 失败 → `<item_requests>` 省略 → buildCraftPatches 返回空，玩家背包啥也没有，失败体验单薄。
- **修复**：craft_gen prompt 失败/大失败时也输出 `<item_requests>`（失败品/残料，type="inventory"、quality=普通）；`runCraftGenChain` item_gen 成功/失败都发；`buildCraftPatches` 失败时只落失败品 add_item（不 auto-equip / 不结算 EXP/FP）。
- **状态**：✅ 已完成（S4d）。

### ✅ Skill 落库缺 modifiers 字段（已修 2026-08-01 S4a）

- **问题**：`Skill` 接口无 modifiers 字段（S3 只加了 automata），技能「生产检定」加值落不了库 → S2-2 阻塞。
- **修复**：`Skill` 补 modifiers/buffs/divinity 字段 + `assembleCharacterState` skills 透传 + `agent-tools.collectCraftBonuses` 收集技能生产加值 → craft_check/craft_settle 的 skillBonus 生效。
- **状态**：✅ 已完成（S4a，S2-2 闭环）。

### 🟡 前端 ItemsPanel 缺 modifiers 展示

- **问题**：ItemsPanel 已有详情界面（名字/品质/词条/描述/脚本折叠），但**缺 modifiers（战斗修正）展示**。玩家看不到「命中+5、附加流血」。
- **建议**：v3 编译时产出人类可读效果描述，前端只渲染；automaton 是 DSL 内部表示**不裸展示**。独立详情页属 Phase 7e UI 精化可后置。
- **状态**：📝 后置（主人拍板先修链路，前端后做）。

---

## 归档（已完成 / 已解决）

- 2026-08-01 战斗 v3 M5-PR2 遗留：`game-pipeline.ts` 的 flag 分支结构保留一个版本周期（下个周期删 'v2' 分支与 flag 本身）—— 见 `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §8.2。
