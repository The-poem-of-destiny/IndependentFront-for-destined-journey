# M3 翻译层重写 实施计划（数据字段规范批次 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 输出 → StatePatch 的三处翻译（orchestrator Stage2/3 + item/char/craft 三条侧链）全部按 M2 新契约重构：名字寻址、零 id 生成、`player_1` 兜底灭绝。

**Architecture:** 逐翻译点重写并同步拆除 M2 留下的 string-value 过渡兼容（resolveCharacter 的 UUID 兜底保留到 M4——AI prompt 还在教 id 键）。AI json 的 `id` 键过渡读 `a.name ?? a.id`（M4 改 prompt 后删）。执行前先与 M2 实际完成状态校准（本计划引用的 M2 接口以 `docs/archive/superpowers/plans/2026-07-17-m2-state-manager-rewrite.md` 各 Task 的 Interfaces 为准）。

**Tech Stack:** TypeScript · Vitest

## Global Constraints

- 每个 task 完成后 `npm run typecheck` 必须 0 错误；`npm run test -- --run` 不得新增失败（已知既有 1 失败: create-store 命定之灵用例）。
- 本计划在 M2 完成后执行。行号为写作时快照，执行时以函数/符号锚点定位。
- types.ts 唯一类型来源；枚举走 field-enums.ts；注释中文；commit 中文前缀。
- 规范: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`；52 项: `docs/superpowers/specs/2026-07-16-entity-field-audit.md`。
- 消费的 M2 接口: `resolveCharacter`（名字/别名/UUID 三级解析）、新 op（transfer_item/update_item/remove_skill/remove_character/rename_character/set_affection/delta_affection/add_news）、物品/装备新 value 形状（{name,...}/{name,slot}）。

---

### Task 1: orchestrator Stage3 characters.* 翻译重写

**Files:**

- Modify: `src/sillytavern/agent-orchestrator.ts`（processStageMarkers 的 vars_update `<json>` 解析块）
- Test: `src/sillytavern/agent-orchestrator.test.ts`（Stage3 系列）

**Interfaces:**

- Consumes: M2 apply* 新契约。
- Produces: AI json → patch 的键名约定 `const key = a.name ?? a.id;  // 过渡: M4 改 prompt 后删 ?? a.id`；target 一律 `characters.${key}`。

- [ ] **Step 1: 失败测试** — 用该文件既有 `runVarsUpdateWithJson` helper：① `{characters:{replace:[{name:'理查德',path:'hp',value:88}]}}` → set_hp target=`characters.理查德` ② 旧键 `{id:'理查德',...}` 同样生效（过渡读）③ `replace path:'currentAction'` → update_character（value `{currentAction}`）不再 set_location（杀 #19）④ `delta path:'money'` → update_character + metadata.delta=true（M2 Task 9 真加法承接，杀 #20）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（replace/delta/add/remove 四循环的 key 读取与 target 构造统一改造；add 分支 inventory/equipment 直产 `add_item {name,...,equippedSlot}` 单 patch，varsupd_* id 生成两处删除；remove 分支 statusEffects/skills/equipment 改产 `remove_status_effect {name}` / `remove_skill {name}` / `unequip_item {name}`）。
- [ ] **Step 4: 既有 Stage3 断言更新**（M2 Task 14 最小适配版断言 → 本 task 终版）+ typecheck + 全量。
- [ ] **Step 5: Commit** `feat(M3): orchestrator characters.* 翻译按名寻址 (#19 #20 过渡读 name??id)`

覆盖: #19 #20（翻译侧收口）。

---

### Task 2: orchestrator items.* 翻译重写

**Files:**

- Modify: `src/sillytavern/agent-orchestrator.ts`（items.consume/equip/unequip/transfer/modify 五循环）
- Test: `src/sillytavern/agent-orchestrator.test.ts`

**Interfaces:**

- Produces: consume→`remove_item {name,quantity}`；equip→`equip_item {name,slot}`；unequip→`unequip_item {name}`；transfer→**单个 `transfer_item {name,to,quantity}`**（旧"remove+add 两 patch"删除，杀 #5 transfer 断裂）；modify→`update_item {name,changes}`（杀 #21 itemUpdate 假字段）。

- [ ] **Step 1: 失败测试**（五式各一 + transfer 只产 1 个 patch 的断言）；**Step 2: 确认失败**；**Step 3: 实现**。
- [ ] **Step 4: 同步拆 M2 过渡桥** — state-manager 的 remove_item/remove_status_effect string-value 兼容分支删除（翻译层已不再产 string）+ craft-resolver 的 remove_item 发送点改新形状（grep `op: 'remove_item'` 全仓核对发送方）。
- [ ] **Step 5: 断言更新 + typecheck + 全量**；**Step 6: Commit** `feat(M3): orchestrator items.* 翻译新契约 + 拆 string-value 过渡桥 (#5 #21 #23)`

覆盖: #5 #21 #23（翻译侧收口）。

---

### Task 3: orchestrator Stage2 清理 — 死 delta 分支 + metadata.source

**Files:**

- Modify: `src/sillytavern/agent-orchestrator.ts`（request_dispatcher `<json>` 解析块）
- Test: `src/sillytavern/agent-orchestrator.test.ts`

- [ ] **Step 1: 失败测试** — ① dispatcher json 含 delta 数组时**不再产生 patch**（分支已删）② replace 分支 metadata.source==='request_dispatcher'、insert 分支同（杀 #26 复制粘贴残留）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（parsed.delta 循环删除——prompt 从未教过 delta，纯死代码；:717/:725 的 source 'vars_update' 改 'request_dispatcher'）。
- [ ] **Step 4: 通过 + typecheck + 全量**；**Step 5: Commit** `fix(M3): Stage2 死 delta 分支删除 + metadata.source 修正 (#26)`

覆盖: #26。

---

### Task 4: item-gen-chain buildItemGenPatches 重写

**Files:**

- Modify: `src/sillytavern/item-gen-chain.ts`
- Test: `src/sillytavern/item-gen-chain.test.ts`

**Interfaces:**

- Produces: 装备=**单 add_item** `{name, quantity:1, type:'装备', rarity, description, stats, effects, scripts, equippedSlot: normalizeSlot(slot)}`（两步落库废除）；背包/技能同式无 id；`itemgen_eq_/inv_/skill_` 三处 id 生成删除；owner 解析 `marker.attributes.owner ?? context 玩家名`——**玩家名取 request.context.characters 中 type='player' 的 name，两者皆缺进 console.warn + 跳过该 marker**（'player_1' 假 id 灭绝，杀 #6）。

- [ ] **Step 1: 失败测试** — ① 装备产 1 个 patch 且 value.equippedSlot 已归一 ② owner 缺失时用 context 玩家名 ③ 玩家也缺时跳过并 warn ④ 全部 patch 的 value 无 id 键。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 既有断言更新（M2 Task 14 桥→终版，`characters.player_1` 断言删除）+ typecheck + 全量**。
- [ ] **Step 5: Commit** `feat(M3): item-gen 链零 id 化 + owner 玩家名解析 (#6 #7装备侧)`

覆盖: #6（item 链）。

---

### Task 5: char-gen-agent 重写 — target 修正 + 无损映射 + 正式字段

**Files:**

- Modify: `src/sillytavern/char-gen-agent.ts`（buildCharGenPatches / assembleCharacterState）+ `src/sillytavern/types.ts`（ItemGenOutput 补 effects/scripts 字段）
- Test: `src/sillytavern/char-gen-agent.test.ts`

**Interfaces:**

- Produces:
  - buildCharGenPatches: target 子路径灭绝——附属 add_skill/add_item/equip_item **整体删除**，全部数据内嵌在 add_character 的 value 里一次落库（现状本来就靠 add_character 兜底、附属 patch 恒 errors，删掉即修 #11 且防 target 修好后的二次叠加）
  - assembleCharacterState: ① 无损映射（装备 scripts 传递、inventory effects/scripts 传递、maxDurability 独立字段，杀 #45）② 装备产物直接进 inventory 带 equippedSlot ③ 正式字段直写（appearance/background/personality/gender/outfit 一等字段，customFields 同步双写到 M6）④ ascension 数据进 add_character value 本体，_*ascension.* 的 set_variable patch 删除_*（杀 #12 写进变量快照）
  - types.ts ItemGenOutput 的 equipment/inventory 条目补 `effects?: Record<string,string>; scripts?: Record<string,string>`（解析层 parseItemGenOutput 同步补提取——若 XML 解析器不支持子元素则先透传空对象并注记，完整解析随 agent 输出格式在本 task 内验证）

- [ ] **Step 1: 失败测试** — ① buildCharGenPatches 只产 1 个 add_character（无附属 patch）② value.inventory 内装备条目带 equippedSlot+scripts ③ 正式字段与 customFields 双写一致 ④ 无任何 set_variable patch。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 断言更新 + typecheck + 全量**。
- [ ] **Step 5: Commit** `feat(M3): char-gen 单 patch 落库 + 无损映射 + 正式字段直写 (#11 #12 #45)`

覆盖: #11 #12（char 侧）#45。

---

### Task 6: craft-gen-chain buildCraftPatches 重写

**Files:**

- Modify: `src/sillytavern/craft-gen-chain.ts`
- Test: `src/sillytavern/craft-gen-chain.test.ts`（若无则新建，覆盖 buildCraftPatches 纯函数）

**Interfaces:**

- Produces: 产物=add_item `{name, quantity, type: normalizeItemType(原始type) ?? '特殊', rarity, stats, durability, maxDurability, effects, scripts, equippedSlot?}`——stats/durability 从 metadata 移回 value（杀 #7）、type 硬编码 'equipment' 修正（杀 #38）；`craft_*` 双 Date.now id 生成三处删除；exp→`update_character {value:{totalExp:...}, metadata:{delta:true}}`、fp→M5 接线前暂走 `delta_variable profile.fp` 保持现状并标 `// M5 改 FP op`（杀 #12 的 exp 侧）；owner 兜底同 Task 4 玩家名式（杀 #6 craft 侧）。

- [ ] **Step 1: 失败测试**（① 装备产物 stats 在 value ② type 药剂→'消耗品'非'equipment' ③ 无 craft_ 前缀 id ④ exp 走 update_character delta）；**Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 断言更新 + typecheck + 全量**。
- [ ] **Step 5: Commit** `feat(M3): craft 链零 id 化 + stats 归位 + type 归一 (#6 #7 #12 #38 #39)`

覆盖: #6（craft 侧）#7 #12（exp 侧）#38 #39（quality→rarity 在 value 构造处统一走 rarity 键）。

---

### Task 7: story 层 char_detect 死路径删除（可选收尾）

**Files:**

- Modify: `src/sillytavern/agent-orchestrator.ts`（processStageMarkers Step C 旧格式块）、`src/sillytavern/types.ts`（OrchestratorEvents.onCharDetect @deprecated→删除）、`src/sillytavern/marker-protocol.ts`（char_detect 扫描保留——story prompt 仍可能输出，剥离逻辑保留但不再回调）
- Test: `src/sillytavern/agent-orchestrator.test.ts`

- [ ] **Step 1**: grep `onCharDetect` 全仓确认唯一消费点是 orchestrator 内部（game-pipeline 从未接线）→ Step C 调用块删除、事件接口字段删除、相关测试用例删除。story systemPrompt 的 char_detect 指令删除留给 M4（prompt 域）。
- [ ] **Step 2: typecheck + 全量**；**Step 3: Commit** `refactor(M3): story 层 char_detect 死路径删除 — 角色检测统一走 dispatcher`

---

### Task 8: 收尾 — 附录 A 注记 + 验证

- [ ] 规范附录 A 追加 M3 执行注记（翻译层新契约就位；剩余过渡: resolveCharacter UUID 兜底 + `name ?? id` 过渡读，均 M4 拆）。
- [ ] `npm run typecheck && npm run test -- --run` 终验；`bash scripts/notify.sh "M3 翻译层重写 完成!" "零 id 生成 | player_1 灭绝 | typecheck 0 错误"`。
- [ ] Commit `docs(M3): 附录 A 执行注记`。

---

## 覆盖清单

| #                           | Task  |
| --------------------------- | ----- |
| #5 #21 #23（翻译侧收口）    | 2     |
| #6 'player_1' 灭绝          | 4 / 6 |
| #7 stats 归位               | 6     |
| #11 target 子路径           | 5     |
| #12 ascension/exp 走正规 op | 5 / 6 |
| #19 #20（翻译侧收口）       | 1     |
| #26 死 delta + source       | 3     |
| #37（翻译侧 slot 归一）     | 4 / 6 |
| #38 #39 type/rarity         | 6     |
| #41（翻译侧装备单 patch）   | 4 / 5 |
| #45 无损映射                | 5     |
| char_detect 死路径          | 7     |
