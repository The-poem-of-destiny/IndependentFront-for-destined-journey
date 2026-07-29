---
name: combat-v2-itemgen-modifiers
description: 战斗 v2 M4 5.5b — item_gen modifier 解析链路接入点（parse <modifiers>/校验/透传）
metadata:
  type: project
---

item_gen 的 modifier 解析链路已接入（M4 任务 5.5b，2026-07-29 完成）。

**Why:** M4 5.4 让 item_gen systemPrompt 输出 `<modifiers>` 子元素（每行一个 JSON），但 parseItemGenOutput 之前完全不解析。本任务补齐解析→校验→patch 全链路，为 M5 战斗管线 collect_mods 事件提供数据源。

**How to apply:** M5 战斗管线消费装备 modifier 时（combat.attack.collect_attacker_mods/defender_mods event），从角色的 `inventory[].modifiers` 读 Modifier[]（装备是 InventoryItem 的状态，规范 §3）。数据流：item_gen `<modifiers>` → parseEquipmentXML/parseInventoryXML/parseSkillsXML → validateAndCollectCombatEffects（违规 warn 不中断）→ ItemGenOutput 元素 → assembleCharacterState 透传 → InventoryItem.modifiers → add_character/add_item patch value。

关键设计决策：
- **buff 不独立产出**：item_gen systemPrompt 没让 AI 直出完整 StatusEffect，只让出 modifier（附加效果类 modifier 带 buffName/sourceKey/stacks/duration/lifecycle 字段，M5 消费侧转 buff）。ItemGenOutput 元素的 `buffs?` 字段保留但当前无生产填充方。
- **divinity 聚合**：从合规 modifier 取 max 作为装备级登神等级（§6.2「挂整件装备」）。
- **校验违规不中断**：validateAndCollectCombatEffects 丢弃违规 modifier，console.warn 但不抛，单坏 modifier 不污染整链。
- 校验函数 validateItemOutput 在 combat-item-validator.ts（5.5a 写好的纯函数），5.5b 在 char-gen-agent.ts 接入。
- 两个 type-only 循环依赖安全：types.ts ↔ effect-types.ts 双向 import type。

落点文件：
- src/sillytavern/types.ts — ItemGenOutput + CharGenOutput + InventoryItem 加 modifiers?/buffs?/divinity?
- src/sillytavern/char-gen-agent.ts — parseModifiersXML + validateAndCollectCombatEffects + 三个 parse 函数接入 + assembleCharacterState 透传
- src/sillytavern/craft-gen-chain.ts — buildCraftPatches 把 modifiers 写进 add_item patch value

关联 [[combat-v2-progress]]。
