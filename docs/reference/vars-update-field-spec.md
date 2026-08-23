# vars_update Agent 字段规范（读侧 / 写侧对齐）

> **状态**：盘点稿（2026-08-23）
>
> **用途**：`vars_update`（变量更新 Agent）可读、可写的**全部字段真源**，供：
> - 校对 `public/data/defaults/agent-config.json` 的 vars_update systemPrompt / template；
> - 未来改提示词时按本表逐字段对齐（读写对称）；
> - 定位"提示词没教 / 读写不对称 / 枚举来源多套"的缺口。
>
> **代码真源**：`src/sillytavern/vars-update-translator.ts`（翻译层）、`src/sillytavern/state-manager.ts`
> （apply* 白名单 / 归一化）、`src/sillytavern/types.ts`（实体字段）、`src/sillytavern/field-enums.ts`
> （枚举）、`src/sillytavern/placeholder-registry.ts`（读侧渲染）。

## 1. 职责

把 `request_dispatcher` 的请求单 + 当前状态落成状态补丁：角色数值、物品流转、任务、好感度、
状态效果。**寻址一律用名字，永不使用也不编造 id**（铁律 1）。新角色/新物品/新技能**不在本
Agent 生成**（归 item_gen），本 Agent 只更新既有对象。

## 2. 读侧（template 注入的区块）

| 区块 | 内容 | 渲染来源 | 备注 |
|---|---|---|---|
| `<世界设定>` | 世界书静态条目 | `{{LORE_BOOK_STATIC}}` | 🔴 提示词**未教**"以世界书数值为唯一准绳"（story 有，vars_update 没有） |
| `<动态状态>` | 世界书动态条目（EJS 求值） | `{{LORE_BOOK_DYNAMIC}}` | |
| `<已有角色>` | 角色状态（zone 过滤） | `{{CHARACTER_STATE}}` | 是否含状态效果取决于 zone 可见性 |
| `<已有物品>` | 背包清单 | `{{INVENTORY}}` | `name ×quantity (type rarity) — desc` |
| `<已有技能>` | 技能清单 | `{{SKILL_STATE}}` | `[主动/被动] name — desc [词条]`；不显示 cost/cooldown/scripts |
| `<已有任务>` | 任务清单 | `{{QUEST_STATE}}` | 状态 / 优先级 / 目标 / 进度 / 详情 / 奖励（字段完整） |
| `<调度器输出>` | dispatcher 完整输出 | `{{AGENT.REQUEST_DISPATCHER}}` | 含 `<char_update_request>` / `<item_update_request>` / `<quest_update_request>` 标签 |
| `<正文内容>` | story 正文 | `{{AGENT.STORY}}` | |
| `<最近对话>` | 最近历史窗口 | `{{NARRATIVE:layers=1}}` | |

🔴 **读侧缺口**：template **没有** `{{ACTIVE_EFFECTS}}`（现有状态效果）、`{{GAME_TIME}}`、
`{{MAP_CONTEXT}}`、`{{MEMORY_ENTRIES}}`、`{{PLOT_EVENTS}}`。即本 Agent 要写 `status_effects`，
却看不到存档里已存在的状态效果。

## 3. 写侧（输出格式规范）

### 3.1 characters.replace（写最终值）

| path | StatePatch op | 说明 |
|---|---|---|
| `hp` | `set_hp` | |
| `mp` | `set_mp` | |
| `sp` | `set_sp` | |
| `location` | `set_location` | 位置自由文本（唯一真源） |
| `currentAction` | `update_character` | 当前行为 |
| 其他白名单字段 | `update_character` | 见下方白名单 |

**update_character 白名单**（`state-manager.ts` UPDATE_CHAR_WHITELIST）：
`type / race / identity / occupation / tier / tierName / level / totalExp / expToNext /
attributes / freeAttrPoints / hp / maxHp / mp / maxMp / sp / maxSp / ascension / money /
location / present / adventurerRank / currentAction / bloodlineIds / quantity / appearance /
background / personality / gender / outfit / thoughts / customFields`

**禁止**：`name`（改名走 `rename_character`）；数组字段 `inventory / skills / statusEffects /
equipment`（走专用 op）；账务字段 `id / saveId`（Code 层维护）。白名单外键 → **loud 拒绝**（整条 patch 失败）。

### 3.2 characters.delta（写增量）

| path | StatePatch op | 说明 |
|---|---|---|
| `hp` | `delta_hp` | |
| `mp` | `delta_mp` | |
| `sp` | `delta_sp` | |
| `money` | `update_character` + `metadata.delta=true` | 真加法 |
| 其他数值字段 | `update_character` + `metadata.delta=true` | |

🔴 **delta 只允许数值字段**（UPDATE_CHAR_NUMERIC_FIELDS）：
`tier / level / totalExp / expToNext / freeAttrPoints / hp / maxHp / mp / maxMp / sp / maxSp /
money / quantity`。同一字段 replace 与 delta **只能选一个**（提示词已教）。

### 3.3 characters.add（新增子实体）

| path | StatePatch op | 形状 |
|---|---|---|
| `statusEffects` | `add_status_effect` | value = 完整状态效果对象 |
| `skills` | `add_skill` | value = 完整技能对象 |
| `inventory` | `add_item` | `{name, description, quantity, type, rarity, equippedSlot}` |
| `equipment` | `add_item` | `{name, description, type:'装备', rarity, slot→equippedSlot}`（slot 归一化） |
| 其他 | `update_character` | |

🔴 提示词只给了空示例 `{path,value:{}}`，**没教** statusEffects / skills / inventory / equipment
各自的具体字段形状。

### 3.4 characters.remove（删除子实体）

| path | StatePatch op | 形状 |
|---|---|---|
| `statusEffects` | `remove_status_effect` | `{name: 角色名, target: 效果名}` |
| `equipment` | `unequip_item` | `{name: 角色名, target: 物品名}` |
| `skills` | `remove_skill` | `{name: 角色名, target: 技能名}` |

🔴 没有 `inventory` 删除——物品删除走 `items.consume`。

### 3.5 items

| 块 | StatePatch op | 字段 | 约束 |
|---|---|---|---|
| `consume` | `remove_item` | owner / target / quantity? | 默认 1 |
| `equip` | `equip_item` | owner / target / slot | slot 归一化 |
| `unequip` | `unequip_item` | owner / target | |
| `transfer` | `transfer_item` | from / to / target / quantity? | 默认 1 |
| `modify` | `update_item` | owner / target / changes | changes **禁改** `name / quantity / id`；`type/rarity/equippedSlot` 自动归一化 |

🔴 `items.modify` 的 changes 可写字段未在提示词给出全集（示例只有 `{"durability":-5}`）；
实际可写 `InventoryItem` 除 `name/quantity/id` 外全部（description/type/rarity/equippedSlot/
stats/durability/maxDurability/data/effects…）。

### 3.6 quests（🔴 缺口最大的一处）

| 块 | 提示词教的 | Quest 实体字段（types.ts） | 缺失 |
|---|---|---|---|
| `upsert` | name / status / objective / detail | status / **priority** / **progress** / detail / objective / **reward** | **priority / progress / reward 没教** |
| `remove` | name | | |

后果（`setQuestInPlace` 合并语义）：新建任务时 priority 落默认 `'中'`、progress/reward 落空串
→ 任务进度永远显示"进度:—"、奖励永远空。

任务状态枚举：`进行中 / 已完成 / 失败 / 搁置`（field-enums QUEST_STATUSES）。

### 3.7 affections

| 块 | StatePatch op | 字段 |
|---|---|---|
| `set` | `set_affection` | name / value |
| `delta` | `delta_affection` | name / amount |

🔴 取值范围（-100 ~ 100，affection-system AFFECTION_MIN/MAX）未在提示词给出。

### 3.8 status_effects（XML）

提示词教：`name / category / owner / stacks / maxStacks / remainingTime / timeUnit` + 子词条
`<effect>` + `<script>`。

StatusEffect 实体字段（types.ts）：`name / description / category / stacks / maxStacks? /
stackable? / remainingTime / timeUnit / source / effects / effectDescriptions? / scripts?`

🔴 **未教**：`description`（必填）、`source`（必填，来源/解除方式）、`stackable`；且读侧看不到
现有状态效果（见 §2）。

枚举：`category ∈ 增益/减益/特殊`；`timeUnit ∈ 回合/分钟/小时`。

## 4. 缺口汇总（读写不对称）

> 📌 **2026-08-23 修订**：本表基于公开仓**占位版**（`public/data/defaults/agent-config.json`，1742 字简版）盘点。
> 实测**真实版**（`fated_poem_independent_assets/data/defaults/agent-config.json`，12279 字完整版，进 pack 的
> `agentDefaults`）已覆盖 G1/G2/G7/G8；G3/G4/G5/G6 于 2026-08-23 在真实版补全，公开仓占位版同步 quests 等关键字段。

| # | 缺口 | 影响 | 真实版状态 |
|---|---|---|---|
| G1 | `quests.upsert` 缺 priority/progress/reward | 新建任务进度/奖励常为空 | ✅ 真实版已有（可选字段说明）；占位版已同步 |
| G2 | `characters.*` 的 path 没有字段枚举，白名单不给 AI | AI 写错字段 → loud 拒绝整条失败 | ✅ 真实版已有（"支持的 path" 列表） |
| G3 | `characters.add` 的子实体形状没教全 | add 用不出正确形态 | ✅ 2026-08-23 真实版补全（按 path 的 value 形状表） |
| G4 | `items.modify` 的 changes 可写字段没给全集 | AI 只改 durability | ✅ 2026-08-23 真实版补全（可写字段 + 禁改键） |
| G5 | `status_effects` 缺 description/source/stackable 教导 | 状态效果落库缺必填字段 | ✅ 2026-08-23 真实版补全（<status_effects> 字段说明） |
| G6 | 读侧无 `{{ACTIVE_EFFECTS}}` | 写状态效果看不到现有效果 | ✅ 2026-08-23 真实版 template 加 `<已有状态效果>` 区块 |
| G7 | 提示词未教"参考世界书数值" | 枚举/数值与世界书可能脱节 | ✅ 真实版已有（"数据来源"节：世界设定=世界观约束） |
| G8 | `affections` 取值范围未教 | 越界值 | ✅ 真实版已有（范围 [-100,100] + 数值档位） |

## 5. 相关真源索引

- 翻译层：`src/sillytavern/vars-update-translator.ts`（buildVarsUpdatePatches / buildQuestPatches）
- 白名单/归一化：`src/sillytavern/state-manager.ts`（UPDATE_CHAR_WHITELIST /
  UPDATE_CHAR_NUMERIC_FIELDS / applyUpdateCharacter / applyUpdateItem / applyUpdateQuest）
- 实体字段：`src/sillytavern/types.ts`（CharacterState / InventoryItem / Skill / StatusEffect / Quest）
- 枚举：`src/sillytavern/field-enums.ts`（RARITY_LEVELS / QUEST_STATUSES / EQUIP_SLOTS /
  ITEM_TYPES / STATUS_CATEGORIES + 别名归一化）
- 读侧渲染：`src/sillytavern/placeholder-registry.ts`（CHARACTER_STATE / INVENTORY /
  SKILL_STATE / QUEST_STATE / ACTIVE_EFFECTS）
- 数据字段规范：`docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（§6 任务章等）
- 提示词现状：`public/data/defaults/agent-config.json`（agents.vars_update）
