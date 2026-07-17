# M2 StateManager 契约重写 实施计划（数据字段规范批次 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** StateManager 全部 apply* 从"按 id 寻址"重写为"按名字寻址"（铁律1/2），新增 8 个 op，退役物品/技能/状态效果 id 与 equipment[] 数组，接入 field-enums 归一化。

**Architecture:** 先做两项硬前置与类型扩展（不破坏），再建名字解析唯一入口 `resolveCharacter` + 重写 validatePatch（验证失败进 errors[]），然后逐实体重写 op 契约，最后集中执行 equipment[]/EquipmentSlot 删除大手术（编译报错清单驱动）。过渡期兼容原则：**只为"让既有测试绿"服务**（真机游玩已冻结到 M6 后）——resolveCharacter 保留 UUID 兜底（M4 删）、remove_item/remove_status_effect 接受 string value（M3 删）。

**Tech Stack:** TypeScript · Dexie/fake-indexeddb · Vitest

## Global Constraints

- 每个 task 完成后 `npm run typecheck` 必须 0 错误。
- 每个 task 完成后 `npm run test -- --run` 不得新增失败。已知既有失败 1 个：`create-store.test.ts > 选中 system_core 世界书条目时应输出该条目内容（命定之灵）`，忽略但不得增多。
- 本计划在 M1 完成后执行（已满足）。文中行号为写作时快照，执行时以函数/符号锚点定位。
- `src/sillytavern/types.ts` 是唯一类型来源；枚举一律走 `field-enums.ts`。
- 注释中文；commit message 中文带 `feat:`/`fix:`/`refactor:` 前缀。
- 规范唯一真源: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（第 2-8 章 StatePatch 速查表是本计划的契约）；52 项问题: `docs/superpowers/specs/2026-07-16-entity-field-audit.md`。
- ⚠️ 本批次不改翻译层逻辑（orchestrator/三条侧链的 buildPatches 属 M3），对它们只做**最小编译适配**，每处标注 `// M3 重写`。
- ⚠️ 捏人页的 `.id` 是"装备池/物品池条目 id"（start-catalog 商品目录），**不是**本批退役的实体 id——create-store.ts / CreateStepSelections.vue / SelectedPanel.vue 的池 id 逻辑一律不动。

## 附录 A: 影响面清单（只读 grep 实测，执行时以 typecheck 报错清单为准）

**equipment[]/EquipmentSlot 删除波及（生产代码）：**

| 文件 | 处数 | 处理 |
|------|------|------|
| state-manager.ts | 5 + EquipmentSlot 引用 | Task 8 重写为 equippedSlot 语义 |
| char-gen-agent.ts | 6 + 构造 5 处 | Task 12 最小适配（equipment→inventory+equippedSlot），M3 重写 |
| char-query.ts / combat-resolver.ts / context-visibility.ts | 2/2/2 | Task 12 改读 `inventory.filter(i => i.equippedSlot)` |
| craft-gen-chain.ts / item-gen-chain.ts | 1/1 | Task 12 最小适配，M3 重写 |
| namespace-normalizer.ts / validate.ts | 1 / validateEquipment 块 | Task 12 改造/删除 |
| types.ts :763（CharacterState）:831（createDefault）:605（接口）| — | Task 12 删除；:2637/:2676 是 ItemGenOutput 的 AI 输出结构，保留（M3 处理语义）|
| UI: CharacterListPanel/ItemsPanel/StatusOverview/CharGenSystemCard/ItemSystemCard/toSystemEvent.ts | 1/2/1/2/4/3 | Task 12 最小适配 filter 写法（完整重构 M6）|
| test-fixtures.ts 3 处 equipment 字面量 | — | Task 12 改 equippedSlot 写法 |
| 测试 10 文件: agent-templates/char-gen-agent/combat-resolver/context-visibility/item-gen-chain/namespace-normalizer/placeholder-registry/state-manager/types/create-store 的 *.test.ts | — | Task 12 表格化清理 |

**id 可选化波及（读点需 null 容忍或改按 name）：** ScenePanel.vue(7)、state-manager.ts(5)、effect-runtime.ts(3)、CharacterListPanel.vue(2，`:key="fx.id"`→`:key="fx.name"`)、validate.ts(2)、StatusOverview.vue(1)。（create-store/CreateStep* 的池 id 不在此列。）

---

### Task 1: field-enums 别名表原型键加固（M2 硬前置 ①）

**Files:**
- Modify: `src/sillytavern/field-enums.ts`
- Test: `src/sillytavern/field-enums.test.ts`

**Interfaces:**
- Produces: 5 个 normalize* 行为不变，但对 `'constructor'`/`'toString'` 等原型键输入安全返回 null/undefined/兜底值。

- [ ] **Step 1: 写失败测试（追加到 field-enums.test.ts）**

```ts
describe('原型键安全（M2 硬前置: AI 提名值可能是任意字符串）', () => {
  it('normalizeSlot 对原型键返回 null 而非原型成员', () => {
    expect(normalizeSlot('constructor')).toBeNull();
    expect(normalizeSlot('toString')).toBeNull();
    expect(normalizeSlot('__proto__')).toBeNull();
  });
  it('normalizeItemType/normalizeRarity 对原型键返回 undefined', () => {
    expect(normalizeItemType('constructor')).toBeUndefined();
    expect(normalizeRarity('valueOf')).toBeUndefined();
  });
  it('normalizeQuestStatus/normalizeStatusCategory 对原型键走兜底', () => {
    expect(normalizeQuestStatus('constructor')).toBe('进行中');
    expect(normalizeStatusCategory('toString')).toBe('特殊');
  });
  it('normalizeItemType 的 special/道具 别名（M1 测试缺口）', () => {
    expect(normalizeItemType('special')).toBe('特殊');
    expect(normalizeItemType('道具')).toBe('特殊');
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest --run src/sillytavern/field-enums.test.ts -t "原型键"`，Expected: FAIL（`normalizeSlot('constructor')` 返回 Object 构造函数）。

- [ ] **Step 3: 实现** — 5 个别名表统一改为无原型对象（保持字面量内容不变，只包一层）：

```ts
const SLOT_ALIASES: Record<string, EquipSlot> = Object.assign(Object.create(null), {
  '主手': '武器', '惯用手': '武器', '副武器': '副手',
  // …原字面量内容原样保留…
});
```

同样处理 `ITEM_TYPE_ALIASES` / `RARITY_ALIASES` / `QUEST_STATUS_ALIASES` / `STATUS_CATEGORY_ALIASES`。

- [ ] **Step 4: 确认通过 + typecheck** — `npx vitest --run src/sillytavern/field-enums.test.ts && npm run typecheck`
- [ ] **Step 5: Commit** — `git add src/sillytavern/field-enums.* && git commit -m "fix(M2): field-enums 别名表无原型化 — 原型键穿透加固 (硬前置①)"`

覆盖: M1 终审登记项 ①。

---

### Task 2: applyAddCharacter 无条件覆写 saveId（M2 硬前置 ②）

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyAddCharacter）
- Test: `src/sillytavern/state-manager.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('add_character 携带非空但错误的 saveId 时也被覆写（铁律3: 不信任上游）', async () => {
  const sm = createStateManager('save_right');
  const npc = createDefaultCharacterState({ id: 'npc_y', name: '串档NPC' });
  npc.saveId = 'save_WRONG';
  await sm.commitChatState([{ op: 'add_character', target: 'characters.串档NPC', value: npc }]);
  const got = await getCharacters('save_right');
  expect(got.find(c => c.name === '串档NPC')?.saveId).toBe('save_right');
});
```

- [ ] **Step 2: 确认失败**（现实现 `if (!character.saveId)` 只补空值 → saveId 仍是 save_WRONG）
- [ ] **Step 3: 实现** — M1 注入的两行改为无条件：

```ts
    // 铁律3: saveId 是账务字段，由 Code 无条件注入，不信任上游 patch 构造方 (#8/M2硬前置②)
    character.saveId = this.saveId;
    if (character.customFields) character.customFields.saveId = this.saveId;  // 双写，M6 删
```

- [ ] **Step 4: 确认通过 + typecheck + 全量** ；**Step 5: Commit** `fix(M2): applyAddCharacter 无条件覆写 saveId (硬前置②)`

覆盖: M1 终审登记项 ②。

---

### Task 3: types.ts 扩展 — 新 op 联合 + id 可选化（不破坏，先铺路）

**Files:**
- Modify: `src/sillytavern/types.ts`

**Interfaces:**
- Produces: `StatePatchOp` 新增 `'remove_character' | 'rename_character' | 'remove_skill' | 'update_item' | 'transfer_item' | 'set_affection' | 'delta_affection' | 'add_news'`；`Skill.id?` / `InventoryItem.id?` / `StatusEffect.id?` 变可选并 @deprecated。

- [ ] **Step 1: StatePatchOp 联合类型（types.ts:1207 附近）追加 8 个 op**（放在对应实体分组旁，每个带一行中文注释：用途 + 规范章节号）。
- [ ] **Step 2: 三个内嵌实体 id 改可选**：

```ts
  /** @deprecated 逻辑键=name（规范铁律1）。M2 起引擎不再读写，M3 后翻译层不再生成，仅为旧存档数据兼容保留字段位 */
  id?: string;
```

（Skill/InventoryItem/StatusEffect 三处同文案。）
- [ ] **Step 3: InventoryItem 核对补齐 `stats?: Record<string, number>` / `durability?: number` / `maxDurability?: number`**（规范 §3.1——装备并入物品后这些字段归物品；已有则跳过）。
- [ ] **Step 4: typecheck + 全量测试**（id 变可选是放宽，构造点不破；若有 `string` 上下文读 `.id` 报错，本 task 内以 `?? ''` 最小适配并登记到 Task 12 表格）。
- [ ] **Step 5: Commit** `feat(M2): StatePatchOp 扩展 8 op + 物品/技能/状态效果 id 可选化 (@deprecated)`

---

### Task 4: StateManager 基建 — resolveCharacter + validatePatch 语义修正

**Files:**
- Modify: `src/sillytavern/state-manager.ts`
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces（后续所有 task 与 M3 消费）:
  - `private async resolveCharacter(key: string): Promise<CharacterState>` — 存档内按 name 精确匹配 → `'主角'|'玩家'` 别名返回 type='player' → UUID 兜底（`// 过渡: M4 删`）→ 找不到 throw `` `角色不存在: ${key}` ``
  - `private async resolveCharTarget(target: string): Promise<CharacterState>` — `characters.<key>` 前缀剥离后调 resolveCharacter（子路径如 `characters.X.skills` 只取第一段，修 #11 的 Code 侧防御）
  - 集合查找辅助: `findByName<T extends {name: string}>(list: T[], name: string): T | undefined`
  - **validatePatch 重写**: 验证失败不再 `return {success:false}` 而是 **throw** → 被 commitChatState 的逐 patch try/catch 收进 errors[]（根除"验证失败不进 errors、success 还是 true"深坑）

- [ ] **Step 1: 写失败测试**

```ts
describe('resolveCharacter 名字解析唯一入口', () => {
  it('按名字解析角色', async () => {
    /* mock store 放入 {id:'uuid-1', name:'理查德', type:'player', saveId:'s1'} →
       commit [{op:'set_hp', target:'characters.理查德', value: 50}] → 断言 hp=50 */
  });
  it('主角/玩家 别名解析到 player', async () => { /* target:'characters.主角' 同上生效 */ });
  it('UUID 兜底仍可用（过渡期）', async () => { /* target:'characters.uuid-1' 生效 */ });
  it('解析失败进 errors[] 不静默', async () => {
    /* commit 不存在的名字 → result.errors 含 '角色不存在: 不存在的人' */
  });
});
describe('validatePatch 语义修正 — 验证失败进 errors[]', () => {
  it('缺 op/target 的 patch 进 errors 且 success=false', async () => {
    const r = await sm.commitChatState([{ op: 'set_hp' } as any]);
    expect(r.errors.length).toBe(1);
    expect(r.patchesApplied).toBe(0);
  });
});
```

（完整 mock 写法沿用该文件既有 `buildMockCharacter`/`vi.mock` 模式；测试代码在实现前先写全。）

- [ ] **Step 2: 确认失败** — 旧断言 `errors stays empty` 系列会先撞（见 Step 4）。
- [ ] **Step 3: 实现** — resolveCharacter/resolveCharTarget/findByName 三辅助 + validatePatch 矩阵重写：

```
value 必填: set_variable/insert_variable/set_hp/mp/sp/set_location/update_quest/remove_quest/
           add_item/remove_item/update_item/transfer_item/equip_item/unequip_item/
           add_skill/update_skill/remove_skill/add_status_effect/remove_status_effect/
           add_character/rename_character/add_memory/update_plot_event/set_affection/add_news
amount 必填: delta_variable/delta_hp/mp/sp/delta_affection
无额外要求: remove_character/remove_variable（move_variable 要 metadata.toPath）
例外: update_character 允许 value 为空（metadata.action-only 场景）
```

全部**角色类 handler**（update_character/set_hp 系/delta 系/set_location/add_status_effect 系/add_item 系/equip 系/add_skill 系）的开头统一机械替换为 `const char = await this.resolveCharTarget(patch.target);`。
另外两处顺带接归一化：`applyUpdateQuest` 写入前 `questFields.status = normalizeQuestStatus(questFields.status ?? '')`（杀 #32 自由字符串）；`remove_quest` value 从裸字符串改 `{name}` 对象（#40 形态统一，翻译层 M3 同步）。
- [ ] **Step 4: 既有测试语义更新（本 task 集中处理，逐一列出）**：
  - `state-manager.test.ts` 「validatePatch/errors stays empty」系列（~:172-227）：断言反转——非法 patch 现在**进 errors[]**，`expect(result.errors).toHaveLength(n)`。
  - partial-success 用例（~:1149-1176）：`patchesApplied` 语义不变，errors 计数按新矩阵调整。
  - 报"角色不存在"的 2 处断言：错误消息格式对齐 `角色不存在: <key>`。
- [ ] **Step 5: 确认通过 + typecheck + 全量**；**Step 6: Commit** `feat(M2): resolveCharacter 名字解析唯一入口 + validatePatch 验证失败进 errors[]`

覆盖: 铁律2 落地 + errors 深坑 + #11 Code 侧防御。

---

### Task 5: 状态效果三 op 重写（按名寻址）

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyAddStatusEffect / applyRemoveStatusEffect / applyTimeAdvance / convertScriptEffects）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces: `add_status_effect` value=`{name(必),...}` 无 id（同名按 stackable/maxStacks 叠层，缺省 stacks=1，category 过 normalizeStatusCategory）；`remove_status_effect` value=`{name}` **或 string（按 name 解释，`// 过渡: M3 删`）**。

- [ ] **Step 1: 失败测试** — ① `add_status_effect` 不带 id 成功落库（杀 #4：这条链上线以来必 throw）② 同名再施加 stackable=true 时 stacks+1、超 maxStacks 封顶 ③ `remove_status_effect` value='轻伤' 字符串按名删掉（杀 #22）④ category 传 'buff' 归一为 '增益'。
- [ ] **Step 2: 确认失败**（现实现 `if (!value?.id) throw '缺少 status effect 数据'`）。
- [ ] **Step 3: 实现** — 按名查重叠层逻辑改 `findByName(char.statusEffects, value.name)`；id 相关分支删除；写入前 `category = normalizeStatusCategory(value.category ?? '')`。applyTimeAdvance 的到期删除改 `filter(e => e.name !== fx.name)`；convertScriptEffects 的 `$status.add` Partial 直接透传（无 id 要求后天然合法）。
- [ ] **Step 4: 既有断言更新**（该文件按 id 断言状态效果的用例改按 name）+ 通过 + typecheck + 全量。
- [ ] **Step 5: Commit** `feat(M2): 状态效果 op 按名寻址 — add 不再要求 id / remove 按名删 (#4 #22)`

覆盖: #4（状态效果侧）#22。

---

### Task 6: 技能 op 重写 + remove_skill

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyAddSkill / applyUpdateSkill / 新增 applyRemoveSkill）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces: `add_skill` value=`{name(必),...}` 无 id，**同名=覆盖升级**（规范 §4）；`update_skill` value=`{name, changes}`（旧 `{skillId, changes}` 形状不再支持——grep 确认生产无发送方，仅测试用）；`remove_skill` value=`{name}`。

- [ ] **Step 1: 失败测试** — ① add_skill 无 id 落库（杀 #4 技能侧）② 同名 add = 字段覆盖不重复 ③ update_skill 按 name 改 level ④ remove_skill 按 name 删、删不存在的进 errors[]。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（含 `case 'remove_skill'` 分发行）。
- [ ] **Step 4: 既有 update_skill 用 skillId 的断言改 name + 通过 + typecheck + 全量**；**Step 5: Commit** `feat(M2): 技能 op 按名寻址 + remove_skill (#4)`

覆盖: #4（技能侧）+ #21 的 removeSkill 假字段替代路径。

---

### Task 7: 物品 add/remove/update/transfer 重写（同名合并 + 归一化）

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyAddItem / applyRemoveItem / 新增 applyUpdateItem / applyTransferItem）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces（规范 §3.3 契约）:
  - `add_item` value=`{name(必), quantity?=1, type?, rarity?, description?, stats?, effects?, scripts?, equippedSlot?}` — **同名合并累加 quantity**；type 过 normalizeItemType、rarity 过 normalizeRarity、equippedSlot 过 normalizeSlot
  - `remove_item` value=`{name(必), quantity?=1}` **或 string（按 name 解释、patch.amount 当 quantity，兼容 craft-resolver 现行发法，`// 过渡: M3 删`）** — 扣减≤0 时 splice；**找不到 → throw 进 errors[]**（杀 #5 #35 静默）
  - `update_item` value=`{name(必), changes: Partial<InventoryItem>}` — changes 白名单禁 name/quantity（改名走删加，数量走 add/remove）
  - `transfer_item` target=`characters.<甲>` value=`{name(必), to: '<乙名>', quantity?=1}` — 原子扣甲加乙，双方任一解析失败整体不动并进 errors[]

- [ ] **Step 1: 失败测试**（每条 op 至少：正常路径 / 找不到进 errors / 归一化生效；transfer 加"乙不存在时甲的数量不变"原子性断言）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（含两个新 case 分发行；applyAddItem 的按 id 查重逻辑整体替换为按 name 合并）。
- [ ] **Step 4: 既有物品断言更新**（'potion' 字符串按 itemId 匹配 'Health Potion' 的旧用例改写为新契约对象形式）+ 通过 + typecheck + 全量。
- [ ] **Step 5: Commit** `feat(M2): 物品 op 按名寻址 — 同名合并/update_item/transfer_item 原子转移 (#5 #35)`

覆盖: #5 #35 + #21 的 itemUpdate 假字段替代路径。

---

### Task 8: equip/unequip 语义重写 — equippedSlot 单真源

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyEquipItem / applyUnequipItem）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces（规范 §3 装备=物品状态）:
  - `equip_item` value=`{name(必), slot(必)}` — slot 过 normalizeSlot（非法 slot 进 errors）；物品必须已在 inventory（找不到进 errors）；**quantity>1 的物品拒绝直接穿**（堆叠穿戴互斥，提示"先拆分"进 errors）；同槽已有装备自动 `equippedSlot=null`；本物品 `equippedSlot=slot`
  - `unequip_item` value=`{name}` 或 `{slot}`（按 slot 找当前穿戴者）— 清 equippedSlot；零数据搬运（杀 #10 有损穿脱）

- [ ] **Step 1: 失败测试** — ① 穿：inventory 物品 equippedSlot 被设、effects/scripts/rarity 字段原地未动 ② 同槽顶替：旧装备 equippedSlot=null 且字段无损 ③ quantity=5 拒穿进 errors ④ 脱按 name/按 slot 两式 ⑤ slot='weapon' 归一 '武器'。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（旧的 equipment[] 搬运逻辑整体删除——此时 `char.equipment` 引用仍在别处，本 task 只改这两个 handler 内部，等 Task 12 删字段）。
- [ ] **Step 4: 既有 equip/unequip 断言重写（按新语义）+ 通过 + typecheck + 全量**；**Step 5: Commit** `feat(M2): equip/unequip 重写为 equippedSlot 单真源 — 穿脱零搬运 (#10 #23 #24)`

覆盖: #10 #23 #24 + 规范"堆叠穿戴互斥"。

---

### Task 9: update_character 白名单 + currentAction 归位 + delta 修正

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（applyUpdateCharacter）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces: `update_character` value 白名单校验——**禁数组字段**（inventory/skills/statusEffects → 进 errors 提示走专用 op，杀 #21）、**禁 name**（改名唯一途径 rename_character）、**禁 id/saveId**（账务字段）；数值字段 + `metadata.delta=true` 时做**真加法**（杀 #20 的 money delta 变替换）；`currentAction` 是合法白名单字段（M3 翻译层把 currentAction 分支从 set_location 改到这里，杀 #19 的 Code 侧承接）。

- [ ] **Step 1: 失败测试** — ① value 含 inventory 键 → errors 且角色对象无污染 ② value 含 name → errors ③ `{value:{money:-50}, metadata:{delta:true}}` 在 money=100 时结果 50 ④ currentAction 正常写入不再顶掉 location。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（白名单常量 + delta 分支；Object.assign 仅作用于白名单过滤后的对象）。
- [ ] **Step 4: 既有「update name」的 2 个用例改用 race/money + 通过 + typecheck + 全量**；**Step 5: Commit** `feat(M2): update_character 白名单+delta 真加法+currentAction 归位 (#19 #20 #21)`

覆盖: #19（Code 侧）#20 #21。

---

### Task 10: 好感度/新闻 op — set_affection / delta_affection / add_news

**Files:**
- Modify: `src/sillytavern/state-manager.ts`
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces（M5 翻译层与 UI 消费）:
  - `set_affection` target=`affections.<角色名>` value=number → `profile.affections[角色名] = clamp(value, -100, 100)`（写 SaveProfile，getProfile 惰性创建路径复用 update_quest 的现成模式）
  - `delta_affection` 同 target amount=number → 现值(缺省0)+amount 后 clamp
  - `add_news` value=`{title(必), content(必), category?}` → Code 补 `id: crypto.randomUUID(), publishedAt: Date.now(), read: false` push 进 `profile.news`（规范 §8）
  - GameEvent: affection 走 `'system'`、news 走 `'system'`（GameEventType 不扩容，M1 实测联合无 affection 类型）

- [ ] **Step 1: 失败测试** — ① set 150 被 clamp 100 ② delta 在无记录时从 0 起算 ③ add_news 自动补齐三账务字段 ④ target 非 `affections.<名>` 格式进 errors。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（三个新 case + handler）。
- [ ] **Step 4: 通过 + typecheck + 全量**；**Step 5: Commit** `feat(M2): set/delta_affection + add_news op (#15 #16 的 Code 侧)`

覆盖: #15 #16 的 op 层（翻译接线在 M5）。

---

### Task 11: remove_character / rename_character（怪物生命周期 + 改名兜底）

**Files:**
- Modify: `src/sillytavern/state-manager.ts`
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**
- Produces:
  - `remove_character` target=`characters.<名>` — resolveCharTarget 后从 Dexie 删除该角色记录（`deleteCharacter(id)`，database.ts 已有或本 task 补一个 `db.characters.delete(id)` 薄封装）。规范 §2.2: 怪物/召唤物死亡或战斗结束即整条删除
  - `rename_character` target=`characters.<旧名>` value=`'<新名>'` — ① 同存档新名查重（撞名进 errors）② `char.name = 新名` 落库 ③ **按名引用迁移**: `profile.affections[旧名]` 键迁移（Task 10 已就位）+ `profile.quests` 各 quest 的文本字段不迁移（叙事文本，接受陈旧）——迁移面在本 task 注释里写明"当前按名引用仅 affections；M5/M6 新增按名引用时必须回来扩这里"

- [ ] **Step 1: 失败测试** — ① remove 后 getCharacters 查不到 ② remove 不存在的名字进 errors ③ rename 后旧名查不到新名可查、affections 键随迁 ④ rename 撞已有名进 errors。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 通过 + typecheck + 全量**。
- [ ] **Step 5: Commit** `feat(M2): remove_character/rename_character — 怪物生命周期 + 改名迁移 affections (#规范§2.2)`

覆盖: 规范 §2.2 生命周期 + rename 迁移条款。（注意执行顺序: 本 task 依赖 Task 10 的 affections 结构，勿提前。）

---

### Task 12: equipment[]/EquipmentSlot 删除大手术（编译清单驱动）

**Files:**
- Modify: `src/sillytavern/types.ts`（删 :605 EquipmentSlot 接口、:763 CharacterState.equipment、:831 createDefault 的 `equipment: []`）+ 附录 A 全部波及文件
- Test: 附录 A 列出的 10 个测试文件

**Interfaces:**
- Produces: 全工程 `CharacterState.equipment` 消失；装备读取统一 `char.inventory.filter(i => i.equippedSlot)` 惯用式。

- [ ] **Step 1: types.ts 三处删除** → `npm run typecheck 2>&1 | tee /tmp/m2-t12.txt` 拿全量报错清单。
- [ ] **Step 2: 生产代码逐文件清理**（附录 A 的处理列 + 以下速查；同模式给一个完整示例，其余表格化）：

示例（char-query.ts 读点模式，其余读点同式）:
```ts
// 旧: const weapons = char.equipment.filter(e => e.slot === 'weapon');
// 新: 装备=inventory 中 equippedSlot 非空的物品（规范 §3）
const equipped = char.inventory.filter(i => i.equippedSlot);
```

| 文件 | 改法 |
|------|------|
| state-manager.ts 残余 5 处 | Task 8 已改 handler，剩余读点改 filter 式 |
| char-gen-agent.ts assembleCharacterState + 5 处构造 | 装备产物写成 `{...item, equippedSlot: guessSlot(...)}` 直接 push 进 inventory；`{skills:[],equipment:[],inventory:[]}` 空构造删 equipment 键（同步改 ItemGenOutput 消费处签名——**仅编译适配，语义 M3 重写**） |
| craft-gen-chain.ts / item-gen-chain.ts 同款空构造 | 同上，标 `// M3 重写` |
| combat-resolver.ts(2) context-visibility.ts(2) namespace-normalizer.ts(1) | filter 式替换 |
| validate.ts validateEquipment 块 + EquipmentSlot import | 块删除（装备校验并入物品校验），import 清理 |
| UI 6 文件（附录 A） | filter 式最小适配，`// M6 完整重构` |
| test-fixtures.ts 3 处 | equipment 数组字面量改为 inventory 内带 equippedSlot 的物品 |

- [ ] **Step 3: 测试文件表格化清理**（10 文件，全部是"删 equipment 键/改 filter 断言/id 断言改 name"三类机械改法，以报错清单驱动逐个清零）。
- [ ] **Step 4: typecheck 0 错误 + 全量测试**；**Step 5: Commit** `refactor(M2): EquipmentSlot/equipment[] 退役 — 装备统一 equippedSlot 单真源 (#41)`

覆盖: #41 + M1 延后项收口。

---

### Task 13: id 读点清理（可选 id 的 null 容忍）

**Files:**
- Modify: `src/ui/components/game/ScenePanel.vue`(7) `CharacterListPanel.vue`(2: `:key="fx.id"`→`:key="fx.name"`) `StatusOverview.vue`(1) `src/sillytavern/effect-runtime.ts`(3) `validate.ts`(2) `state-manager.ts` 残余
- ⚠️ 排除: create-store/CreateStep*/SelectedPanel 的池 id（见 Global Constraints）

- [ ] **Step 1**: 逐处改法——Vue `:key` 用 name；effect-runtime 的效果实例键 `fx.id ?? fx.name`；validate 的 id 存在性校验删除。以 grep `\.(id)\b` 复核 + typecheck 清单驱动。
- [ ] **Step 2: typecheck + 全量**；**Step 3: Commit** `refactor(M2): 内嵌实体 id 读点清理 — :key/校验改 name (#40 前置)`

覆盖: #40 的 Code 侧。

---

### Task 14: 翻译层最小编译适配（M3 前的临时桥）

**Files:**
- Modify: `src/sillytavern/agent-orchestrator.ts` / `item-gen-chain.ts` / `char-gen-agent.ts` / `craft-gen-chain.ts`（仅 buildPatches 输出形状）

- [ ] **Step 1**: 上游构造的 patch value 改成新契约**最小形状**（能过 validatePatch + apply 不 throw 即可，语义重写留 M3）：orchestrator 的 add_item 补 name 键直传、equip_item `{itemId,slot}`→`{name: 原itemId值, slot}`（旧值本来就是名字，杀 #23 顺手）、varsupd_*/itemgen_*/craft_* 的 id 生成行**保留但输出进 value.id 可选位**（apply 已忽略）并标 `// M3 删`。
- [ ] **Step 2: 相关链路测试跑绿**（agent-orchestrator.test Stage3 系列 / item-gen-chain.test / char-gen-agent.test 按新形状改断言）+ typecheck + 全量。
- [ ] **Step 3: Commit** `chore(M2): 翻译层最小适配新契约 (M3 重写前的编译桥)`

---

### Task 15: 收尾 — 文档同步 + 全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（附录 A 加 M2 执行注记）、`CLAUDE.md`（StateManager 行注记 ADR-21 后追加"M2: 按名寻址"一句）
- Modify: `.superpowers/sdd/progress.md`（若用 SDD 执行则自动维护）

- [ ] **Step 1**: 附录 A 表格后追加 M2 执行注记（做了什么/过渡兼容点清单——UUID 兜底 M4 删、string value M3 删、翻译层最小适配 M3 重写）。
- [ ] **Step 2**: `npm run typecheck && npm run test -- --run` 终验（0 错误 / 仅既有 1 失败）。
- [ ] **Step 3**: `bash scripts/notify.sh "M2 StateManager 重写 完成!" "按名寻址 + 9 新 op + equipment 退役 | typecheck 0 错误"`
- [ ] **Step 4: Commit** `docs(M2): 附录 A 执行注记 + CLAUDE.md 同步`

---

## 覆盖清单

| # | 问题 | Task |
|---|------|------|
| 硬前置① 原型键穿透 | field-enums 加固 | 1 |
| 硬前置② saveId 无条件覆写 | applyAddCharacter | 2 |
| #4 技能/状态效果必 throw | 5 / 6 |
| #5 消耗品扣不掉 | 7 |
| #10 穿脱有损 | 8 |
| #11 target 子路径（Code 侧防御） | 4 |
| #19 currentAction 顶掉 location（Code 承接） | 9 |
| #20 delta 变替换 | 9 |
| #21 假字段污染 | 6 / 7 / 9 |
| #22 按名删效果按 id 匹配 | 5 |
| #23 #24 equip/unequip 语义 | 8 / 14 |
| #32 quest.status 归一（Code 侧入口在 update_quest 内接 normalizeQuestStatus，Task 4 矩阵顺带）| 4 |
| #35 静默/throw 风格分裂 | 7 |
| #40 Quest 形态 + id 读点 | 4 / 13 |
| #41 装备双表示 | 8 / 12 |
| #15 #16 Code 侧 op | 10 |
| 规范 §2.2 怪物生命周期/rename | 11 |
