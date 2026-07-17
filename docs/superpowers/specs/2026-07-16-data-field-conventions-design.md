# 《命定之诗》游戏数据字段规范（数据字典）

> 版本: v1.0 草案 · 2026-07-16
> 定位: **理想态标准**。代码向本规范靠拢，不是本规范迁就代码。
> 背景: 2026-07-16 全量盘点发现 52 项字段/契约不一致（见附录 B），四大病根:
> ① id 无政府状态（六套 id 体系 + `player_1` 假 id）② "谁负责补字段"无约定
> ③ 同一概念多处存储（变量/快照/新闻/好感度全是双轨）④ AI↔翻译层↔StateManager 三层契约失配无人守门。
> 窗口期: 项目处于开发期，无真实玩家存档需要兼容，允许 breaking change 一次到位。

---

## 第 0 章 五条铁律（横切一切实体）

| # | 铁律 | 一句话 |
|---|------|--------|
| 铁律 1 | **逻辑键 = 名字** | 角色 `(saveId, name)`、物品/技能/状态效果 `(所属角色, name)`、任务 `(saveId, name)`。UUID 降级为纯内部物理主键（仅角色保留），**永不出现在 AI 契约、StatePatch target、prompt 示例中** |
| 铁律 2 | **名字解析唯一入口** | StateManager 提供 `resolveCharacter(name)` / 集合内按 name 查找的统一辅助，全引擎只此一处做名字→记录查找。解析失败必须进 `errors[]` 上浮，禁止静默 no-op |
| 铁律 3 | **字段分工** | AI 只填叙事字段（name/description/effects/rarity/…），Code 补账务字段（saveId/时间戳/数量合并/枚举归一化）。**AI 永远不产 id** |
| 铁律 4 | **每类数据唯一真源（SSOT）** | 每类数据只有一个家（见第 13 章 SSOT 总表）。发现双轨即为 bug |
| 铁律 5 | **枚举值统一中文、集中定义** | slot/type/rarity/quest.status/statusEffect.category 等枚举在 `src/sillytavern/field-enums.ts`（新建）一处定义，写入时统一做归一化校验 |

---

## 第 1 章 存储拓扑（目标态）

**单 Dexie 库、多存档混住、行级 saveId 隔离**（沿用现有模式并做严）。换存档 = `activeSaveId` 指针切换 + `loadSave()` 读入 Pinia，零搬运。导出/导入仅为备份/分享功能。

### 1.1 表清单与身份声明（新表必须先在此登记身份）

| 表 | 身份 | 主键 | saveId | 说明 |
|----|------|------|--------|------|
| `saves` | 存档本体 | id (=saveId, UUID) | — | SaveSlot |
| `characters` | **存档私有** | id (UUID, 内部) | ✅ **一等字段+索引**（🆕 从 customFields 提升） | 角色（含内嵌物品/技能/状态） |
| `saveProfiles` | 存档私有 | saveId | ✅ 主键即 saveId | 任务/时间/好感/FP/新闻/**变量**(🆕) |
| `messages` | 存档私有 | id (UUID) | ✅ 一等+索引 | 对话唯一真源 |
| `memories` | 存档私有 | id | ✅ 一等+索引 | 记忆 |
| `plotEvents` / `plotOutlines` | 存档私有 | id | ✅ 一等+索引 | 剧情 |
| `snapshots` | 存档私有 | id | ✅ 一等+索引 | 快照唯一真源 |
| `lorebooks` / `presets` / `settings` / `apiEndpoints` / `createPresets` | **全局共享** | id/key | ❌ 不设 | 世界书/预设/设置/API 池 |
| `chats` | ⚰️ v3 遗留 | id | — | 标记废弃，迁移批次中删除 |

### 1.2 隔离三规则

1. 每张存档私有表 saveId 必为**一等字段 + Dexie 索引**。谁写入谁负责带上，禁止塞 `customFields`。
2. `deleteSaveSlot(saveId)` 必须级联清空**全部**私有表（含 characters，修现状 #9）。
3. 所有"当前存档数据"查询必须带 saveId 过滤；`$char.getNpcs(saveId)` 等接口的 saveId 参数必须真正生效（修 #30）。

### 1.3 存档导出/导入（备份格式）

```jsonc
{ "formatVersion": 1, "exportedAt": "...",
  "save": {...}, "characters": [...], "saveProfile": {...},
  "messages": [...], "memories": [...], "plotEvents": [...], "snapshots": [...] }
```
导入时**重新生成 saveId** 及所有内部 UUID，防撞车。整库备份（`exportAllData`）另存，两者并存。

---

## 第 2 章 角色 Character

**键规则**: 逻辑键 `(saveId, name)`，同存档内名字唯一。物理主键 UUID 仅内部使用。
**存储**: `characters` 表，一角色一条大记录，物品/技能/状态效果内嵌其下。

### 2.1 字段表

| 字段 | 类型 | 必填 | 谁填 | 说明 |
|------|------|-----|------|------|
| id | string (UUID) | ✅ | **Code** | 内部物理主键，不出现在 AI 契约 |
| saveId | string | ✅ | **Code**（落库层强制注入） | 🆕 一等字段 |
| name | string | ✅ | AI/玩家 | **逻辑键**。同存档唯一，写入时查重 |
| type | 'player'\|'npc'\|'monster'\|'summon' | ✅ | Code/AI | |
| quantity | number | 可选 | Code | 🆕 **怪物集群数**（哥布林 ×3 = 一条记录）。仅 type='monster'/'summon' 使用，缺省=1 |
| race / identity[] / occupation[] | string / string[] | ✅ | AI | |
| tier / tierName / level / totalExp / expToNext | number/string | ✅ | Code 校验 | 数值约束走 validate.ts |
| attributes {str,dex,con,int,spi} / freeAttrPoints | number | ✅ | Code 校验 | |
| hp/maxHp/mp/maxMp/sp/maxSp / money | number | ✅ | Code | |
| ascension | 结构不变 | ✅ | AI+Code | ⚠️ 修改必须走 update_character，禁走变量（修 #12） |
| inventory[] | Item[] | ✅ | 见第 3 章 | **物品唯一容器**（装备也在这，见 equippedSlot） |
| ~~equipment[]~~ | — | — | — | ⚰️ **退役**（EquipmentSlot 类型删除） |
| skills[] | Skill[] | ✅ | 见第 4 章 | |
| statusEffects[] | StatusEffect[] | ✅ | 见第 5 章 | |
| location / currentAction / adventurerRank | string | ✅ | AI | location 与 currentAction 各归各位（修 #19） |
| bloodlineIds[] | string[] | 可选 | Code | |
| appearance / background / personality / gender | string | 可选 | AI/玩家 | 🆕 **从 customFields 升正式字段**。同义分裂裁决: physics→appearance、backstory→background、clothing→outfit（见下） |
| outfit / thoughts | string | 可选 | AI | 🆕 升正式字段（服装/心里话） |
| customFields | Record<string,any> | ✅ | — | 仅存真扩展数据（destinyCoreId/destinyPoints/age/likes/faction 等），**禁止再放 saveId 及上述已升级字段** |

### 2.2 生命周期规则

- **玩家/持久 NPC**: 创角/char_gen 链创建，长期存在。名字冲突时 char_gen 必须改名后再落库。
- **怪物/召唤物 = 临时实体**: 带 quantity，战斗中减员改 quantity，**死亡或战斗结束即整条删除**（`remove_character`）。
- **改名**: 唯一途径是 `rename_character` 操作（Code 同步迁移 affections key 等按名引用）。不为改名设计其他机制。
- **别名解析**: `resolveCharacter('主角'|'玩家')` → 返回 type='player' 的角色（AI 常用称呼兜底）。

### 2.3 StatePatch 速查（本实体相关 op）

| op | target | value / amount 形状 |
|----|--------|---------------------|
| add_character | `characters.<名字>` | 角色对象（无 id/saveId，**Code 补**） |
| remove_character 🆕 | `characters.<名字>` | — （怪物清场/删除用） |
| rename_character 🆕 | `characters.<旧名>` | `"<新名>"` |
| update_character | `characters.<名字>` | 部分字段对象。**白名单校验：禁止数组字段**（inventory/skills/statusEffects 必须走专用 op，修 #21） |
| set_hp/mp/sp、delta_hp/mp/sp | `characters.<名字>` | number（不变，仅 target 改名字） |
| set_location | `characters.<名字>` | string |

---

## 第 3 章 物品 Item（含装备状态）

**键规则**: 同一角色下 `name` 唯一；同名写入 = **数量合并**。**物品无 id**（🆕 InventoryItem.id 退役）。
**存储**: `CharacterState.inventory[]`（内嵌，无独立表）。
**核心设计**: 装备不是独立实体，**是物品的一种状态**——`equippedSlot` 有值 = 穿在身上，null = 躺背包。穿脱 = 改一个字段，零搬运（根除 #7/#10/#41）。

### 3.1 字段表

| 字段 | 类型 | 必填 | 谁填 | 说明 |
|------|------|-----|------|------|
| name | string | ✅ | AI | **逻辑键** |
| quantity | number | ✅ | Code 归一 | 缺省=1；同名合并累加 |
| equippedSlot | slot枚举 \| null | ✅ | AI 提名 + Code 校验 | 🆕 null=背包。**堆叠与穿戴互斥**: quantity>1 不可直接穿，需先拆 1 个为独立记录 |
| type | '装备'\|'消耗品'\|'材料'\|'任务物品'\|'特殊' | 可选 | AI | 中文枚举（裁决 #38 三套取值） |
| rarity | 7级品质（普通~唯一） | 可选 | AI | **quality 字段废除，统一 rarity**（修 #39） |
| description | string | 可选 | AI | |
| stats | Record<string,number> | 可选 | AI | 属性加成（穿戴时生效） |
| durability / maxDurability | number | 可选 | AI+Code | |
| effects | Record<词条名,中文描述> | 可选 | AI | |
| scripts | Record<脚本名,代码> | 可选 | AI | |
| data | Record<string,any> | 可选 | — | 扩展 |

### 3.2 slot 枚举（集中定义于 field-enums.ts，中文，对齐世界书装备条目）

`'武器' | '副手' | '头部' | '身体' | '手部' | '脚部' | '腰带' | '饰品'`
（英文 slot 全面退役，修 #37。一槽一件，穿入已占用槽 = 旧装备自动 `equippedSlot=null`。）

### 3.3 StatePatch 速查

| op | target | value / amount 形状 |
|----|--------|---------------------|
| add_item | `characters.<角色名>` | `{name(必), quantity?, type?, rarity?, description?, stats?, effects?, scripts?, equippedSlot?}` — 同名合并 |
| remove_item | `characters.<角色名>` | `{name(必), quantity?}` 缺省扣 1；**找不到 → errors[] 上浮**（不再静默，修 #5/#35） |
| equip_item | `characters.<角色名>` | `{name(必), slot(必)}` → 设 equippedSlot（原 itemId 语义废除，修 #23） |
| unequip_item | `characters.<角色名>` | `{name(必)}` → 清 equippedSlot（原 slot-only 语义废除，修 #24） |
| update_item 🆕 | `characters.<角色名>` | `{name(必), changes:{...}}`（替代 items.modify 的假字段污染，修 #21） |
| transfer_item 🆕 | `characters.<甲>` | `{name(必), to:'<乙名>', quantity?}` — Code 原子执行 扣甲+加乙（修 #5 transfer 断裂） |

**禁止**: AI 产物品 id ❌ · 英文 slot ❌ · quality 字段 ❌ · `itemgen_*`/`craft_*`/`varsupd_*` 前缀 id 全部退役 ❌

---

## 第 4 章 技能 Skill

**键规则**: 同一角色下 name 唯一（🆕 Skill.id 退役）。技能不可穿戴、不可堆叠（与物品的本质区别）。
**存储**: `CharacterState.skills[]`。

| 字段 | 类型 | 必填 | 谁填 |
|------|------|-----|------|
| name | string | ✅ | AI（逻辑键） |
| description | string | ✅ | AI |
| type | 'active'\|'passive' | ✅ | AI |
| cost {type:'HP'\|'MP'\|'SP', amount} | 可选 | AI |
| cooldown / maxCooldown / level | number | 可选 | AI+Code |
| effects / scripts | Record<string,string> | 可选 | AI |

**StatePatch**: `add_skill` value=`{name,...}`（同名 = 覆盖升级，Code 不再要求 id，修 #4）；`update_skill` value=`{name, changes}`；`remove_skill` 🆕 value=`{name}`（替代 `{removeSkill:...}` 假字段，修 #21）。

---

## 第 5 章 状态效果 StatusEffect

**键规则**: 同一角色下 name 唯一（🆕 id 退役）。同名再施加 = 按 stackable/maxStacks 叠层。
**存储**: `CharacterState.statusEffects[]`（独立第三集合——它既不是物品也不是技能）。

| 字段 | 类型 | 必填 | 谁填 |
|------|------|-----|------|
| name | string | ✅ | AI（逻辑键） |
| description / source | string | ✅ | AI |
| category | '增益'\|'减益'\|'特殊' | ✅ | AI |
| stacks / maxStacks / stackable | number/boolean | stacks✅ | Code 归一（缺省 stacks=1） |
| remainingTime | number\|null | ✅ | AI（null=永久） |
| timeUnit | '回合'\|'分钟'\|'小时' | ✅ | AI |
| effects | Record<string,number> | ✅ | AI |
| effectDescriptions / scripts / onApply / onTick / onRemove / onTrigger | 可选 | AI |

**StatePatch**: `add_status_effect` value=`{name,...}`（Code 不再要求 id——根除 #4 "必 throw"）；`remove_status_effect` value=`{name}`（按名删，修 #22 按 id 匹配永删不掉）。时间结算（applyTimeAdvance）按 name 匹配删除。

---

## 第 6 章 任务 Quest

**键规则**: `(saveId, 任务名)`。任务名即主键（现状即如此，予以确认）。改名 = 删旧建新。
**存储**: `SaveProfile.quests: Record<任务名, Quest>`。

| 字段 | 类型 | 必填 | 谁填 |
|------|------|-----|------|
| status | '进行中'\|'已完成'\|'失败'\|'搁置' | ✅ | AI 提名 + **Code 归一化**（自由字符串废除，修 #32） |
| priority | '低'\|'中'\|'高' | ✅ | AI |
| progress / detail / objective / reward | string | ✅ | AI |

**StatePatch**: `update_quest` value=`{name(必), ...fields}`（upsert）；`remove_quest` value=`{name}`（统一对象形状，裁决 #40 形态不一致）。
**AI 契约补课**: vars_update systemPrompt **必须显式教 quests 输出格式**（`<json>{quests:{upsert:[...],remove:[...]}}` + 示例），不能只靠自检清单暗示（修 #25）。

---

## 第 7 章 好感度 Affection & 关系数据

**SSOT 裁决**（修 #15/#44 双轨）: 好感度数值唯一真源 = `SaveProfile.affections`，**key = 角色名**（原 characterId 语义废除）；范围 [-100,+100]，Code clamp。心里话唯一真源 = `Character.thoughts`（第 2 章正式字段）。变量里的"关系列表[角色名].affinity/心里话"整体退役。

**StatePatch**: `set_affection` 🆕 target=`affections.<角色名>` value=number；`delta_affection` 🆕 同 target amount=number。
**接线**: vars_update 输出格式增加 affections 键（这是修"好感度恒 0"的前提，本规范先定形状）。
**联动**: `rename_character` 自动迁移 affections key。

---

## 第 8 章 存档 Profile（FP / 新闻 / 成就 / 契约 / 时间）

**存储**: `saveProfiles` 表，主键=saveId，惰性创建（现状确认）。

| 字段 | 类型 | SSOT 裁决 / 说明 |
|------|------|------------------|
| fp / fpHistory | number / FPTransaction[] | 结构不变（FPTransaction.id 由 Code 生成，保留——审计流水需要）。接线（fp-system→管线）列入待办，不属本规范 |
| quests | Record<任务名,Quest> | 见第 6 章 |
| affections | Record<角色名,number> | 见第 7 章 |
| gameTime | GameTime | ✅ 唯一真源确认。修 weekday 往返 bug（#31: '周日'→7→'周六'漂移） |
| news | NewsItem[] | **唯一真源 = 此处**（修 #16 双轨）: dispatcher 输出的世界新闻由 orchestrator 翻译为 `add_news` 🆕 patch（value=`{title, content, category}`，Code 补 id/publishedAt/read=false）写入此处；变量里的"世界新闻"/sys.news 路径退役 |
| contracts / achievements | 结构不变 | 接线待办 |
| variables | Record<string,any> | 🆕 **变量的新家**（见第 12 章；从快照寄生迁出，修 #1/#33） |
| worldFlags | Record<string,any> | 保留（mapMarkers 等）。与 variables 分工: worldFlags=Code 写的引擎标志，variables=AI 写的叙事变量 |
| focusQuest | string | UI 修改必须回写（修 #14） |

---

## 第 9 章 记忆 Memory & 剧情 Plot

**结构健康，予以确认**: MemoryRecord / PlotEvent / PlotOutline 字段与 saveId 一等索引模式不变。
**id**: 内部生成（MEM 自增 / UUID），不出现在 AI 契约（AI 通过 keywords/content 交互）。
**清理**: `relatedPlotEventId`（@deprecated）删除；PlotOutline version 原地覆盖与 getLatestPlotOutline 排序的语义冗余二选一（裁决: 保留 version 递增，删除排序依赖）。
**范围外标注**: memory_summary 输出未持久化（#3）、plot 管线 mode:'off'（#18）属**管线接线**问题，不是字段问题——本规范只锁定它们落库时的形状，接线单独立项。

---

## 第 10 章 消息 ChatMessage

**SSOT**: `messages` 表 = 对话唯一真源（append-only）。`chats` v3 表废弃删除（#46）。

| 字段 | 裁决 |
|------|------|
| id / saveId / role / content / timestamp | 保留。saveId 必填（persistMessage 非空断言改为前置校验，activeSaveId 为 null 时拒绝写入并报错，修 #13） |
| turn | 保留（一问一答共享同一 turn，语义确认）。快照恢复的截断游标 |
| systemEvent | 保留（系统卡片） |
| ~~variablesAfter / metadata / apiUsed / parsed~~ | ⚰️ 死字段全部删除（修 #33/#48） |

---

## 第 11 章 存档槽 SaveSlot & 快照 Snapshot

### 11.1 SaveSlot

| 字段 | 裁决 |
|------|------|
| id (=saveId) / name / slot / createdAt / updatedAt | 保留。slot 多槽位实现列入待办 |
| ~~snapshots[]（内嵌数组）~~ | ⚰️ **删除**（快照唯一真源 = snapshots 表，修 #2 双轨死路径） |
| activeSnapshotId | 保留，指向 snapshots **表**记录 |
| metadata.characterName / userName / totalTurns / openingPrompt / openingPromptConsumed / enabledWorldBookEntries | 保留。totalTurns 语义修正: **每对话轮 +1**（由管线在轮结束时递增，不再每 commit +1，修 #27） |
| metadata.gameStartTime | 语义裁决: **现实时间**（创档时刻，ISO 串）。游戏内时间只住 saveProfile.gameTime（修 #42 双语义） |
| ~~metadata.description~~ | ⚰️ 删除（塞 JSON 无人读，#47；destinyCoreId 等移入玩家角色 customFields） |

### 11.2 Snapshot（整体重定义，修 #1/#2/#28）

```ts
interface Snapshot {
  id: string            // Code 生成 UUID
  saveId: string        // 一等字段
  createdAt: number     // 现实时间戳
  reason: 'turn' | 'manual' | 'pre-combat'   // 触发原因
  turn: number          // 对话回合游标（恢复时截断 messages 用）
  characters: CharacterState[]   // 深拷贝
  saveProfile: SaveProfile       // 深拷贝（含任务/时间/好感/变量——变量自然随行）
}
```

- **打快照** = 整份深拷贝（不再是硬编码空体）。触发: 每对话轮管线完成后一次（reason='turn'），滚动保留上限 30（读 AppSettings.maxSnapshotsPerSave，不再私藏常量）。
- **恢复快照** = ① characters + saveProfile 整体覆写当前存档 ② `messages` 表删除 `turn > 快照.turn` 的行（对话一起回滚，不做增量合并）。
- 快照**不存对话副本**（messages 是 SSOT，游标足矣——铁律 4）。
- ~~Snapshot.variables / messageIds / memoryIds / gameTime(现实时间)~~ 旧字段废除。

---

## 第 12 章 变量 Variables

**SSOT 裁决**: 变量唯一真源 = `SaveProfile.variables`（🆕），彻底告别"寄生最新快照"（修 #1 静默丢弃 + 空快照重置 + #33 双轨）。

- 命名空间: `user.*` / `sys.*` 前缀隔离（沿用既有约定）。
- 读: `getCurrentVariables()` 改读 saveProfile；写: `set/delta/remove/move/insert_variable` 五个 op 形状不变，落点改 saveProfile。
- 快照拍照时随 saveProfile 深拷贝自然入照，恢复时自然还原——零额外机制。
- `variables.关系列表` / `variables.世界新闻` 等旧路径按第 7/8 章裁决退役，namespace-normalizer 同步清理。

---

## 第 13 章 SSOT 总表（速查）

| 数据 | 唯一真源 | 被裁掉的双轨 |
|------|---------|-------------|
| 角色状态（含物品/技能/状态效果） | `characters` 表 | ascension/exp 走变量的路径（#12） |
| 装备状态 | `Item.equippedSlot` | equipment[] 独立数组 |
| 任务 / 时间 / 好感 / FP / 新闻 / 变量 | `saveProfiles` 表 | 变量寄生快照、新闻走变量、关系列表 affinity |
| 对话 | `messages` 表 | chats v3 表、快照内对话副本（从未有，明令禁止） |
| 快照 | `snapshots` 表 | SaveSlot.snapshots 内嵌数组 |
| 记忆 / 剧情 | `memories` / `plotEvents` / `plotOutlines` 表 | — |
| 全局配置 | `settings` / `lorebooks` / `presets` / `apiEndpoints` | — |

---

## 第 14 章 AI 契约对齐要求（prompt 侧必改项）

1. **所有 prompt 示例中的 id 一律替换为名字**: `player_1` / `npc_guard_01` 全部退役，示例改用 `"理查德"` 之类的名字（agent-config.json vars_update/request_dispatcher/item_gen + agent-templates.ts:182 fixedExamples）。
2. vars_update `<json>` schema 增补: `quests` 键（第 6 章）、`affections` 键（第 7 章）；characters.* 的 `id` 字段更名为 `name`。
3. item_gen `<item_result>` XML 维持无 id 设计 ✅（现状正确），slot/type 枚举与 field-enums.ts 对齐。
4. request_dispatcher: 删除死掉的 delta 分支约定或补教（裁决: **删除**，orchestrator 同步删 #26 死分支）；`<item_gen_request>` 的 owner 属性写**角色名**。
5. 翻译层（orchestrator/三条侧链）按第 2-8 章 StatePatch 速查表重写，Code 负责: 名字解析、枚举归一、quantity 缺省、saveId 注入。

---

## 附录 A 迁移批次（S1 丢数据 → S4 清理，每批 typecheck+全量测试）

| 批次 | 内容 | 覆盖问题 |
|------|------|---------|
| M1 类型与库 | types.ts 字段增删（equippedSlot/quantity/saveId 一等/死字段删除）+ field-enums.ts + database v9（characters 索引、级联删除、chats 删表、$char.getNpcs 等 saveId 参数真正生效）+ 开发期清库重建 | #8 #9 #13 #30 #43 #46 #47 #48 |
| M2 StateManager 重写 | 名字解析入口 + 全部 apply* 按名字契约重写 + 新 op（remove/rename_character, transfer_item, update_item, remove_skill, set/delta_affection, add_news）+ 枚举归一化（quest.status 等）+ 验证失败进 errors[]（修 #35 风格分裂 + 深坑"验证失败不进 errors"） | #4 #5 #10 #19 #20 #21 #22 #23 #24 #32 #35 #40 |
| M3 翻译层重写 | orchestrator Stage2/3 + item/char/craft 三链 buildPatches 按新契约 + 'player_1' 兜底删除 + craft 双 Date.now 等 id 逻辑整体退役 + assembleCharacterState 无损映射（effects/scripts 全字段传递） | #6 #7 #11 #12 #26 #37 #38 #39 #41 #45 |
| M4 AI prompt 对齐 | 第 14 章全部（agent-config.json + agent-templates.ts） | #25 及示例毒化源头 |
| M5 SSOT 落地 | 变量迁 saveProfile + 快照重定义（打/恢复/滚动上限）+ 新闻/好感度走新 op（含关系列表退役）+ totalTurns 语义 + focusQuest 回写 + weekday bug | #1 #2 #14 #15 #16 #27 #28 #31 #33 #42 #44 |
| M6 UI 适配与清理 | 装备栏 = inventory.filter(equippedSlot) + CharacterListPanel 读正式字段 + 死代码清理（markNewsRead 接线或删、#49-#52） | #17 #34 #36 #49-#52 |
| 范围外（另立项） | memory_summary/plot/FP/EventBus 管线接线（#3 #18 #29）——数据形状本规范已锁定，接线不属字段规范 | #3 #18 #29 |

> **M1 执行注记（2026-07-16）**: M1 已按"每批次编译绿灯"原则重校准——物品/技能/状态效果 id 退役与 EquipmentSlot 删除移至 M2/M3（随消费者 StateManager/翻译层重写同批）；Snapshot 类型重定义移至 M5（随快照机制重建同批）；新正式字段采用双写策略，读方 M6 切换。M1 实际完成: field-enums.ts、CharacterState.saveId 一等化(#8 #43)、Dexie v9(#46)、级联删除(#9)、char-query 隔离(#30)、persistMessage 校验(#13)、SaveSlot 清理(#47)、ChatMessage 死字段(#48 #33 前半)。

> **M2 执行注记（2026-07-17）**: M2 StateManager 按名寻址重写完成。硬前置: field-enums 5 别名表无原型化 + applyAddCharacter 无条件覆写 saveId。types.ts: StatePatchOp +8 op（remove/rename_character、remove_skill、update/transfer_item、set/delta_affection、add_news），Skill/InventoryItem/StatusEffect id 可选化 @deprecated，InventoryItem 补 stats/durability/maxDurability。StateManager: resolveCharacter 名字解析唯一入口（名字→主角/玩家别名→UUID 兜底）+ resolveCharTarget 子路径防御(#11) + validatePatch 重写（验证失败 throw 进 errors[]，34 op 全矩阵，修 #35 风格分裂）+ update_quest 接 normalizeQuestStatus(#32) + remove_quest 改 {name} 形态(#40)。状态效果三 op 按名寻址(#4 #22): add 无 id + 同名叠层/maxStacks 封顶 + category 归一化。技能 op 按名寻址(#4): add 同名=覆盖升级 + update {name,changes} + 新增 remove_skill。物品四 op(#5 #35): add 同名合并累加、remove 找不到 throw、update_item 白名单禁 name/quantity、transfer_item 两阶段原子转移 + 自转移防复制。equip/unequip 重写(#10 #23 #24): equippedSlot 单真源、穿脱零搬运、quantity>1 拒穿、同槽自动顶替。update_character(#19 #20 #21): 38 字段白名单禁数组字段/name/id/saveId + metadata.delta=true 真加法 + currentAction 承接端就绪。set/delta_affection + add_news(#15 #16 Code 侧): 写 SaveProfile + clamp ±100 + 账务字段 Code 补。remove/rename_character(§2.2): 按名删除 + 改名查重 + affections 键随迁。equipment[]/EquipmentSlot 全工程退役(#41): 23 文件，装备读取统一 `inventory.filter(i => i.equippedSlot)`。id 读点清理(#40 前置): Vue :key/校验/hasSkill 改 name。翻译层最小编译桥: orchestrator/三侧链/craft-resolver/effect-runtime 12 处发射点适配新契约 + normalizeSlot 发射门禁。
>
> **M2 过渡兼容点清单（M3/M4 拆除项）**: ① resolveCharacter UUID 兜底 → M4 删（跨存档可命中，destructive op 慎用；M4 删除前提: M3 已将三链（char/item/craft）buildPatches 的 target 改为名字）；② remove_item / remove_status_effect / unequip_item 裸 string value 过渡分支 → M3 删；③ 翻译层 12 处 `// M3 重写` 与 id 生成行 `// M3 删` 标记（agent-orchestrator/item-gen-chain/craft-gen-chain/craft-resolver/effect-runtime）→ M3 按新契约重写；④ resource-calc hasSkill/hasItem `|| id` 过渡容忍 → M3/M4 删；⑤ AI json `id` 键过渡读（M3 Task 1 实装 `name ?? id`，M4 拆）。M3 队列额外登记: effect-runtime forget→update_skill 空 changes 纯 no-op（应改 remove_skill）、effect transfer 只 remove 无 add（既有缺口）、craft equip metadata 带 stats 死重量、unequip 对未穿戴物品静默成功、convertScriptEffects stackSets `{name: effectId}` 过渡形态、add_item 不校验槽位占用（装备互斥仅 equip_item 强制）、add_skill 合并路径 Object.assign 透传未知键（junk 字段可入库）、craft 同名去重跳过丢产物 quantity（stackable 误入 equipment 时，终审复核登记）。
>
> **终审修复(2026-07-17)**: 未知op入errors / craft同名合并去重 / add_character查重 / update_character clamp+attributes深合并 / delta_affection数字守卫 / refreshTime遗留NaN防护 / remove·rename跨存档守卫 / field-enums别名表satisfies复得字面量检查 / namespace-normalizer死装备映射删除。
>
> **M3 执行注记（2026-07-17）**: M3 翻译层重写完成——AI 输出→StatePatch 三处翻译（orchestrator Stage3 + item/char/craft 三条侧链）全部按 M2 新契约重构。核心成果: ① orchestrator characters.* 循环 `key = name ?? id` 过渡读 + currentAction→update_character(#19) + money delta→update_character delta=true(#20) + characters.add equipment 单 add_item 带 equippedSlot（不再 add+equip 两步 + 零 id 生成）② characters.remove 统一 {name} 对象形态 ③ items.transfer→单 transfer_item 替代 remove+add 两步(#5) ④ item-gen-chain buildItemGenPatches: 装备单 add_item 带 equippedSlot+stats+durability + 废除 itemgen_eq_/inv_/skill_ 三处 id 生成 + owner 解析 `marker.owner ?? context 玩家名`（player_1 灭绝 #6）⑤ char-gen-agent buildCharGenPatches: 只产 1 个 add_character（target 用 character.name），附属 add_skill/add_item/equip_item + ascension set_variable 全部删除(#11 #12) + assembleCharacterState 无损映射(#45) + 正式字段直写 ⑥ craft-gen-chain buildCraftPatches: 废除 craft_/craft_eq_/craft_inv_ 三处 id 生成 + type 归一化(#38) + exp→update_character delta(#12) + owner 玩家名解析 ⑦ state-manager 三处 string-value 过渡桥（remove_status_effect/remove_item/unequip_item）删除 ⑧ OrchestratorEvents.onCharDetect 死回调接口删除 ⑨ Stage2 storyOutput 作用域 bug 修复。测试: typecheck 0 错误，2753/2754 通过（仅既有 create-store 命定之灵 1 失败）。
>
> **M3 剩余过渡（M4 拆除）**: ① `const key = r.name ?? r.id` 六处过渡读 → M4 已改为 `r.name`（缺 name 跳过并 warn）② resolveCharacter UUID 兜底 → M4 已删（铁律1 收口）③ agent-config.json 中 prompt 的 id 键示例 → M4 已全部改为 name 键。
>
> **M4 执行注记（2026-07-17）**: M4 AI Prompt 契约对齐 + 代码侧收口完成，过渡兼容全部拆除，铁律1（名字寻址唯一化）+ 铁律3（AI 永不产 id）全面落地。
> **Prompt 侧**: ① vars_update systemPrompt: 全部 25 处 `player_1`→角色名（id→name 键）、新增 quests/affections 教学块（quest 字段按 types.ts 用 detail 非 description）+ 枚举取值表（对齐 field-enums SSOT）、格式骨架同步 ② request_dispatcher: 9 处 player_1 + npc id 示例改角色名 + owner=「持有者的角色名（不是 id）」教学 + 意识体/附灵/器灵→char_gen_request 判定规则（妲丽安缺口）③ item_gen: slot 枚举对齐 8 中文槽位、type 枚举 5 值、顺修 U+FFFD 乱码；char_gen 验证本就零 id ④ memory_summary 示例 relatedCharacterIds 的 player_1→理查德 ⑤ story 预设 COT 的 char_detect 输出教学整行删除（char_gen 输入侧 {{CHAR_DETECT}} 占位符双通道保留）。
> **代码侧**: ⑥ resolveCharacter UUID 兜底删除（解析收敛为: 名字精确匹配 → 主角/玩家别名 → throw 角色不存在；getCharacter 依赖清除；remove/rename_character 跨存档守卫随兜底拆除转死路径同批移除）⑦ agent-orchestrator Stage3 characters.replace/delta/add/remove 四处 `key = name ?? id` 过渡读删除（实际四处非规划六处，dispatcher 侧无此形态；缺 name warn+跳过），equipment 分支 `?? value.itemId` 过渡读同批拆除 ⑧ agent-templates.ts fixedExamples 的 player_1→理查德（id→name）+ char_gen variableInstruction 的 char_detect→char_gen_request 措辞 ⑨ agent-tools.ts 脚本路径教学 `char.player_1.hp`→`char.player.hp`（对齐 namespace-normalizer 真实映射）。
> **测试**: state-manager.test 37 处按 id mock 改按名寻址，3 个兜底用例改负向断言（id 寻址必报 角色不存在）；orchestrator.test 数据 id→name 键 + id-only 条目全跳过回归用例。typecheck 0 错误，2754/2755 通过（仅既有 create-store 命定之灵 1 失败）。
> **文档**: agent_tools_reference（player_1 示例 + char_detect 废除标注 + 流程图）、agent预期分析（顶部 M4 契约同步注记 + 1/2 节历史标注）同步。
> **M5 待接线登记**: vars_update prompt 已教 affections 输出形状，但 orchestrator 尚无 `parsed.affections` 翻译 handler（M5 Task 5 接线，勿在 M5 前误判为 bug）。→ ✅ M5 已接线。
>
> **M5 执行注记（2026-07-17）**: SSOT（铁律4）全面落地，13 项问题收口。
> **① 变量迁家（#1 #33）**: 变量唯一真源迁入 `SaveProfile.variables`——state-manager getCurrentVariables/persistVariables 从"读写最新快照"改为读写 profile，寄生快照路径全删，**无快照时写入不再静默丢弃**；getProfile 加载归一化 `variables ??= {}`（M1 终审备忘履约）。注: 无前缀路径默认归 sys 命名空间（var-resolver parseVarPath 既有语义）。
> **② Snapshot 重定义（#2 写侧 #28）**: Snapshot 接口整体替换为 §11.2 形态 `{id, saveId, createdAt, reason: 'turn'|'manual'|'pre-combat', turn, characters, saveProfile}`（旧 index/timestamp/variables/messageIds/memoryIds/plotEvents/gameTime 全删）；`createSnapshot(reason, turn)` = getCharacters+getProfile 各 structuredClone 整份深拷贝落表 + activeSnapshotId 指向 + trimSnapshots 上限读 `settings.maxSnapshotsPerSave ?? 30`；StateManager 的 patchCount%N 自动快照与 maxSnapshots/autoSnapshot/autoSnapshotInterval 配置字段全删（StateManagerConfig 缩为 {saveId}）；Dexie v10: snapshots schema `'id, saveId, createdAt'` + upgrade clear 旧快照。
> **③ restoreSnapshot（#2 恢复侧 #49）**: 按 id 读快照 + saveId 防跨档 → characters 全删后整体覆写（快照后新增 NPC 消失）→ saveProfile 覆写（variables/quests/affections/news 随行回滚）→ `deleteMessagesAfterTurn(saveId, turn)` 对话截断（启用 `[saveId+turn]` 死复合索引，边界 turn 保留）→ activeSnapshotId 更新；含 fake-indexeddb 全链路集成测试。
> **④ 每轮一拍（#27）**: commitChatState 的 totalTurns+1 删除（每 commit 虚高根治）；新增 `advanceTurn()` = totalTurns+1 + createSnapshot('turn', 新回合数)，由 GamePipeline.run() 成功路径调用（try/catch 不阻塞）；HomePage 的 `Lv.{{totalTurns}}` 误用改为 `第 N 回合`。
> **⑤ 新闻/好感接线（#15 #16 #44）**: dispatcher 无专用 news 键——新闻实为 replace/insert 的 `世界新闻` 变量路径，翻译层拦截（isWorldNewsPath）转产 add_news（字符串→首句 title/对象→title/content 互备/数组→逐条/空值→warn 丢弃），从变量循环排除；vars_update 的 `parsed.affections.set/delta` → set/delta_affection patch（M4 教学项闭环，好感度恒 0 根治）；namespace-normalizer 的 sys.news/sys.relationships 映射退役（旧存档残留变量不迁移，接受陈旧）。
> **⑥ 杂修四连（#14 #31 #42）**: weekday 双约定混用根治（parse 用 ISO 序、format 用 WEEKDAY_NAMES 序）——统一 1=周日…7=周六 对齐现有消费方，parse 侧从 WEEKDAY_NAMES.indexOf()+1 推导结构性杜绝漂移，约定写死在常量注释；QuestsPanel focusQuest 双向 watch 回写 profile（JSON 克隆过 Dexie）；test-save gameStartTime 改现实 ISO；SaveSlot 注释指向 AppSettings.maxSnapshotsPerSave。
> **SSOT 总表状态**: 变量→SaveProfile.variables ✅ / 快照→snapshots 表（打=深拷贝/恢复=覆写+回滚）✅ / 新闻→profile.news ✅ / 好感→profile.affections ✅ 全部单源。测试: typecheck 0 错误，2777/2778 通过（仅既有 create-store 命定之灵 1 失败）。

## 附录 B 现状偏差清单

52 项问题全文见盘点归档（2026-07-16 survey-entity-fields workflow 输出）。编号 #1-#52 与本文各章"修 #N"标注对应：S1 丢数据 #1-#14 · S2 静默失效 #15-#36 · S3 命名混乱 #37-#46 · S4 冗余死字段 #47-#52。

---

## 附录 C 新实体扩展模板（拓展时照抄）

> ### 第 N 章 <实体名>
> **键规则**: (归属, name) / 说明改名与同名策略
> **存储**: 哪张表 / 内嵌在谁下面 · 身份: 存档私有 or 全局共享
> **字段表**: | 字段 | 类型 | 必填 | 谁填(AI/Code/玩家) | 说明 |
> **引用关系**: 被谁按 name 引用 · rename 时需迁移什么
> **StatePatch 速查**: 涉及的 op + target/value 形状
> **禁止**: 本实体的反模式清单
