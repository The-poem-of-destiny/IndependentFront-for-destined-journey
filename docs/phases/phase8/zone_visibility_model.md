# Phase 8: 变量区可见性模型 — 完整设计

> 为全部 11 个 Agent 定义 8 个 Variable Zone 的可见性矩阵 + 具体场景示例 + 注入格式
>
> 日期：2026-06-21 | 基于 `phase8_plan.md` 和现有代码审计

---

## 一、8 个 Variable Zone 定义

### 1.1 数据结构

每个 Zone 是三层自描述容器（对齐 phase8_plan.md §变量区数据结构设计）：

```typescript
interface VariableZone {
  config: ZoneConfig;              // 注入行为控制
  visibility: string[];            // Agent ID 可见白名单
  content: Record<string, any>;    // 纯字典，实际数据
}

interface ZoneConfig {
  orderBy?: string;       // 注入排序字段
  limit?: number;         // 注入截断上限
  injectAs?: 'json' | 'list' | 'table' | 'summary';
}
```

### 1.2 Zone 总览

| # | Zone ID | 内容 | 写入方 | 状态 |
|---|---------|------|--------|------|
| 1 | `memory` | 记忆条目 `{MEM0001: {content, keywords, importance, timeRange, ...}}` | `memory_summary` | ✅ Active |
| 2 | `npc` | 所有角色（含主角），`type` 区分 player/npc/monster/summon | `char_update`, `char_gen` | ✅ Active |
| 3 | `world` | 世界状态：时间/地点/天气/季节/月相/纪元 | `vars_update` | ✅ Active |
| 4 | `quest` | 剧情事件/任务：活跃/待触发/已完成/失败 | `plot_pre_check`, `plot_post_check` | ✅ Active |
| 5 | `craft` | 制作项目：锻造/炼金/烹饪/裁缝 | `craft_gen`, `vars_update` | ✅ Active |
| 6 | `combat` | 活跃战斗状态 | `combat-resolver` (引擎直写) | ✅ Active |
| 7 | `outline` | 剧情大纲 + 世界线状态 | `plot_outline`, `plot_post_check` | 🆕 Reserved |
| 8 | `variable` | 自由变量（旗标/计数）`{user: {...}, sys: {...}}` | `vars_update` | 🆕 空容器 |

### 1.3 可见性级别

| 级别 | 标识 | 含义 |
|------|------|------|
| **FULL** | ✅ | Agent 看到完整内容 |
| **NARRATIVE** | 📝 | 叙事级视图 — 给 story Agent 专用：足够生成准确叙事的全部信息，但剥离纯数值设计细节（如装备+15攻击力→改为"锋利的刀刃"） |
| **SUMMARY** | 📋 | Agent 看到摘要/截断版本（字段白名单过滤 + 文本截断） |
| **KEYS** | 🔑 | Agent 仅看到 ID/名称/类型等索引信息 |
| **NONE** | ❌ | Agent 完全看不到此 Zone |

---

## 二、完整可见性矩阵（11 Agent × 8 Zone）

| Agent | memory | npc | world | quest | craft | combat | outline | variable |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **memory_recall** | ✅ FULL¹ | 🔑 KEYS | 🔑 KEYS² | 🔑 KEYS³ | ❌ | ❌ | ❌ | ❌ |
| **plot_pre_check** | 📋 SUMMARY⁴ | ✅ FULL | ✅ FULL | ✅ FULL | ❌ | ❌ | ✅ FULL | 🔑 KEYS⁵ |
| **story** | 📋 SUMMARY⁶ | 📝 NARRATIVE⁷ | ✅ FULL | 📋 SUMMARY⁸ | 📋 SUMMARY⁹ | ✅ FULL | 📋 SUMMARY¹⁰ | ❌ |
| **vars_update** | ❌ | 🔑 KEYS¹¹ | ✅ FULL | ❌ | 🔑 KEYS | 🔑 KEYS | ❌ | ✅ FULL |
| **char_update** | ❌ | 混合¹² | ✅ FULL | ❌ | 🔑 KEYS | ✅ FULL¹³ | ❌ | ❌ |
| **memory_summary** | 📋 SUMMARY¹⁴ | 🔑 KEYS | 📋 SUMMARY¹⁵ | 🔑 KEYS | ❌ | 🔑 KEYS¹⁶ | ❌ | ❌ |
| **plot_post_check** | 📋 SUMMARY¹⁷ | 📋 SUMMARY¹⁸ | ✅ FULL | ✅ FULL | ❌ | 📋 SUMMARY¹⁹ | ✅ FULL²⁰ | ❌ |
| **plot_outline** | ❌ | ✅ FULL²¹ | ✅ FULL | 🔑 KEYS²² | ❌ | ❌ | ✅ FULL²³ | ❌ |
| **craft_gen** | ❌ | 📋 SUMMARY²⁴ | ✅ FULL | ❌ | ✅ FULL | ❌ | ❌ | 🔑 KEYS²⁵ |
| **char_gen** | ❌ | 🔑 KEYS²⁶ | ✅ FULL | ❌ | ❌ | ❌ | ❌ | 📋 SUMMARY²⁷ |
| **item_gen** | ❌ | 🔑 KEYS²⁸ | ✅ FULL | ❌ | ❌ | ❌ | ❌ | 🔑 KEYS²⁹ |

### 注解

1. **memory_recall → memory FULL**: 完整记忆正文 + keywords + importance + timeRange。**排除**: `hiddenLine`（引擎专用暗线）和 `embedding` 向量。
2. **memory_recall → world KEYS**: 仅 `{time, location}`，用于时间/空间邻近度过滤。
3. **memory_recall → quest KEYS**: 仅 `{id, title, status}`，用于任务相关记忆匹配。
4. **plot_pre_check → memory SUMMARY**: 仅 `{id, relevance, reason, importance}`，不含正文。
5. **plot_pre_check → variable KEYS**: 仅触发条件中引用的变量键（扫描 `{{...}}` 模式）。
6. **story → memory SUMMARY**: 全文注入但 **排除 hiddenLine**。记忆正文是叙事核心素材。
7. **story → npc NARRATIVE（叙事级视图）**: 专门为 story 设计的可见性级别。**包含**: name, type, race, tier/tierName, level, HP/MP/SP(current+max), location, currentAction, attributes(str/dex/con/int/spi — 用于描述角色体魄/敏捷/智力等特质), equipment(slot+name+quality+flavorDescription — **剥离**纯数值 stats 如 "+15攻击力"), skills(name+type+briefDescription — **剥离** cost/cooldown/target), inventory(itemName+quantity+type+rarity — **剥离** 物品详细 stats), statusEffects(name+description+remainingTime), money, appearance, identity/occupation tags, background(完整背景故事，用于塑造角色基于过往经历的反应), personality(完整性格描述/编码，用于塑造角色的说话方式和情绪反应), relationships(仅在场角色间的关系 + 好感度数值，用于校准互动的亲疏程度)。**排除**: equipment 的详细 stats(攻击力/防御力数值), skills 的 cost/cooldown/数值效果, inventory 物品的详细 stats, ascension 完整树(仅保留 enabled 布尔值 + path 名称), 不在场角色的关系。
8. **story → quest SUMMARY**: 仅 active 事件的 title + chapterGoal(100字) + status。**排除**: pending 事件、触发条件。
9. **story → craft SUMMARY**: 仅 completed/in_progress 项目的 product + quality + resultNarrative。
10. **story → outline SUMMARY**: ⚠️ **最关键屏蔽** — 仅当前章节 title + 100字 chapterGoal。**绝不**注入完整大纲。
11. **vars_update → npc KEYS**: 仅 id + name + type + location，用于构造变量路径引用。
12. **char_update → npc 混合**: 目标角色 FULL（需完整数据更新），其他角色 KEYS（仅 name/location/relationship 做上下文）。通过 `targetCharacterId` 实现 per-call 过滤。
13. **char_update → combat FULL**: 仅当目标角色在 participants 列表中时注入。
14. **memory_summary → memory SUMMARY**: 最近 5-10 条，content 截断到 200 字。用于去重判断。
15. **memory_summary → world SUMMARY**: `{time, location, weather, season}`。用于 timeRange 和叙事风味。
16. **memory_summary → combat KEYS**: 仅 `{participants, summary}`。用于 importance 校准（战斗 = 7-8 分起步）。
17. **plot_post_check → memory SUMMARY**: 最近 3 条，仅 id + importance + timeRange + 首句摘要。
18. **plot_post_check → npc SUMMARY**: 仅 name/type/tier/location/currentAction/HP变化方向/最新关系变化。
19. **plot_post_check → combat SUMMARY**: 仅 `{outcome, casualties, significantEvents[]}`。不含 8 步伤害管线。
20. **plot_post_check → outline FULL (读写)**: 读取完整大纲判断世界线偏差，`changeLevel >= moderate` 时修改大纲。
21. **plot_outline → npc FULL (设计视图)**: 完整 identity/background/personality/ascension。**排除运行时状态**: HP/MP/SP/statusEffects/inventory。
22. **plot_outline → quest KEYS+SUMMARY**: 扩写模式：现有章节标题+摘要。新建模式：空。
23. **plot_outline → outline 特殊**: 新建=NONE，扩写=FULL（当前大纲作为扩展锚点）。
24. **craft_gen → npc SUMMARY (制作者+材料提供者)**: 制作者 FULL + 材料提供者仅 name+providedMaterials。其他所有角色的五维/背包/技能全部屏蔽。
25. **craft_gen → variable KEYS**: 仅制作相关参考值：`{forgeQuality, workshopTier, materialScarcity, regionTechLevel}`。
26. **char_gen → npc KEYS**: 仅 `{id, name, race, type, tier}`，避免重名 + 判断关系。**屏蔽**所有现有角色的五维/背包，防止新 NPC 属性被污染。
27. **char_gen → variable SUMMARY**: 仅 faction_standing + region_state 子集，提供世界观一致性锚点。屏蔽 `user.*`。
28. **item_gen → npc KEYS**: 仅目标角色 `{id, name, race, tier, occupation}` + 其他角色 name 列表（避免签名装备冲突）。**主数据源**是 `agentOutputs['char_gen']`，非 npc zone。
29. **item_gen → variable KEYS**: 仅物品风格参考：`{regionStyle, faction, economyLevel, techLevel}`。

### 2.1 NARRATIVE 级别详细字段映射（story → npc zone）

NARRATIVE 是专门为 story Agent 设计的可见性级别。核心原则：**给足叙事所需信息，剥离数值设计细节**。

| CharacterState 字段 | NARRATIVE 处理 | 示例 |
|---------------------|---------------|------|
| `name` | ✅ 完整 | `凯恩` |
| `type` | ✅ 完整 | `player` / `npc` / `monster` |
| `race` | ✅ 完整 | `人类` / `精灵` / `矮人` |
| `tier` / `tierName` | ✅ 完整 | `T2 中坚` |
| `level` | ✅ 完整 | `Lv.5` |
| `appearance` | ✅ 完整 | `身材结实的年轻男子，手掌布满老茧` |
| `identity[]` | ✅ 完整 | `["铁匠学徒", "白曜城居民"]` |
| `occupation[]` | ✅ 完整 | `["锻造师"]` |
| `attributes` | ✅ 保留数值 | `力量12 敏捷8 体质10 智力7 精神6` — story 据此生成 "他用结实的臂膀抡起铁锤" |
| `hp` / `maxHp` | ✅ 保留数值 | `HP: 85/100` — story 据此判断 "你感到手臂的伤口还在隐隐作痛" |
| `mp` / `maxMp` | ✅ 保留数值 | `MP: 40/50` |
| `sp` / `maxSp` | ✅ 保留数值 | `SP: 30/125` |
| `location` | ✅ 完整 | `白曜城-五馆街-铁匠铺` |
| `currentAction` | ✅ 完整 | `正在锻造` / `靠在门边观察` |
| `money` | ✅ 完整 | `50G` / `200G` |
| `equipment[].slot` | ✅ 完整 | `[武器]` / `[护甲]` |
| `equipment[].name` | ✅ 完整 | `铁剑` / `精灵长弓` |
| `equipment[].quality` | ✅ 完整 | `普通` / `优良` |
| `equipment[].description` | ✅ 风味文本 | `一把朴素但保养良好的铁剑，剑刃上还留着上次打磨的痕迹` |
| `equipment[].stats` | ❌ **剥离** | 不显示 `攻击力+15` / `防御力+8` — 依靠 description 和 quality 传达品质感 |
| `equipment[].effects` | ✅ 风味文本 | `{"锋刃": "攻击时附带轻微的出血效果"}` — 中文键值对描述 |
| `equipment[].scripts` | ❌ **剥离** | JS 代码块 (`$status.add(target, {name:'灼烧',...})`)，引擎沙盒执行 |
| `skills[].name` | ✅ 完整 | `重击` / `精准射击` |
| `skills[].type` | ✅ 完整 | `主动` / `被动` |
| `skills[].description` | ✅ 风味文本 | `集中力量进行一次势大力沉的斩击` |
| `skills[].cost` | ❌ **剥离** | 不显示 `SP消耗:15` |
| `skills[].cooldown` | ❌ **剥离** | 不显示 `冷却:3回合` |
| `skills[].effects` | ✅ 风味文本 | `{"破甲": "无视目标30%防御力"}` — 中文描述 |
| `skills[].scripts` | ❌ **剥离** | JS 代码块，引擎沙盒执行 |
| `inventory[].name` | ✅ 完整 | `治疗药水` / `铁矿石` |
| `inventory[].quantity` | ✅ 完整 | `×2` / `×5` |
| `inventory[].type` | ✅ 完整 | `消耗品` / `材料` |
| `inventory[].rarity` | ✅ 完整 | `普通` / `优良` |
| `inventory[].description` | ✅ 风味文本 | `散发草药香气的红色液体` |
| `inventory[].stats` | ❌ **剥离** | 不显示 `恢复20HP` |
| `inventory[].effects` | ✅ 风味文本 | `{"治疗": "饮用后恢复少量生命值"}` — 中文描述 |
| `inventory[].scripts` | ❌ **剥离** | JS 代码块，引擎沙盒执行 |
| `statusEffects[].name` | ✅ 完整 | `轻微烧伤` |
| `statusEffects[].description` | ✅ 完整 | `左手背被烧红的铁钳烫伤，泛起一片红肿` |
| `statusEffects[].remainingTime` | ✅ 完整 | `剩余 15 分钟` |
| `statusEffects[].effects` | ✅ 风味文本 | `{"灼烧": "每回合损失3%最大生命值"}` — 中文键值对，前端渲染用 |
| `statusEffects[].scripts` | ❌ **剥离** | JS 代码块 (`$dice.roll('2d6'); $resource.modifyHp(...);`)，引擎沙盒执行，AI 绝不接触 |
| `statusEffects[].onApply/onTick/onRemove/onTrigger` | ❌ **剥离** | 脚本钩子引用名 (如 `"tick"`)，引擎内部路由用 |
| `ascension.enabled` | ✅ 完整 | `true` / `false` |
| `ascension.path` | ✅ 仅名称 | `剑圣之道` — 不展开完整技能树 |
| `ascension.description` | ✅ 完整 | `追求剑道极致的修行之路` |
| `ascension.nodes[]` | ❌ **剥离** | 完整节点树太长且不必要 |
| `ascension.effects` | ✅ 风味文本 | `{"生命摇篮": "每回合回复5%最大生命值"}` — 中文描述 |
| `ascension.scripts` | ❌ **剥离** | JS 代码块，引擎沙盒执行；init/cleanup 生命周期由 SubscriptionManager 管理 |
| `relationships` | 📋 仅在场角色 + 好感度数值 | `凯恩 — 友好 (好感度:23, 师徒)` — 不在场角色的关系不注入。好感度数值用于校准角色间互动的亲疏程度 |
| `background` | ✅ 完整 | `在边境锻造坊长大，父亲是退伍老兵…` — story 据此生成符合角色过往经历的反应、对话和内心活动 |
| `personality` | ✅ 完整 | `冷静果断，对陌生人保持礼貌的距离` 或性格编码 `dOlgY(F)` — story 据此塑造角色的说话方式、情绪反应和决策倾向 |

---

## 三、关键设计原则

### 3.1 防止全知叙事的屏蔽

| 屏蔽项 | 影响 Agent | 机制 |
|--------|-----------|------|
| **完整大纲** | story | 只给 100 字章节目标摘要 |
| **hiddenLine** | story, memory_recall, memory_summary | Zone 注入层统一剥离 |
| **装备精确数值** | story | npc zone NARRATIVE 级别 — 装备显示 "锋利的精铁长剑（优良）" 而非 "攻击力+15" |
| **技能冷却/消耗数值** | story | npc zone NARRATIVE 级别 — 技能显示 "精准射击：一次精准的瞄准射击" 而非 "SP消耗:15, 冷却:3回合" |
| **登神长阶完整树** | story | 仅保留 enabled + path 名称 |
| **未触发剧情** | story | quest zone 只给 active 事件 |

### 3.2 防止生成偏差的三重屏蔽

| 屏蔽项 | 影响 Agent | 机制 |
|--------|-----------|------|
| **大纲** | char_gen, item_gen, craft_gen | ❌ NONE — 防止"预知未来"导致 NPC/物品/效果生成带有剧情目的 |
| **记忆** | char_gen, item_gen, craft_gen, plot_outline | ❌ NONE — 防止历史事件驱动生成决策 |
| **其他角色详情** | char_gen, item_gen | 🔑 KEYS — 防止 NPC 属性互相污染 |

### 3.3 char_update 并行过滤（per-call 而非 per-agent）

char_update 在 Stage 3 对 N 个角色并行执行。不是"整个 Agent 看什么"，而是"**每次调用**看什么"：

```
调用 for "player":     player FULL + npc_001 KEYS + npc_002 KEYS
调用 for "npc_001":    npc_001 FULL + player KEYS + npc_002 KEYS
调用 for "npc_002":    npc_002 FULL + player KEYS + npc_001 KEYS
```

通过 `AgentContext.targetCharacterId` 实现 per-call 的 npc zone 过滤。

### 3.4 plot_pre_check 作为大纲守门人

`plot_pre_check` 是 **唯一** 能读到完整 `outline` zone 的常态 Agent。它充当守门人：
1. 读取完整大纲 → 判断哪些事件应触发
2. 提炼 ~100 字章节目标 → 注入 story Agent
3. story Agent **永远**看不到完整大纲

### 3.5 Marker 触发 Agent 的特殊注入

craft_gen / char_gen / item_gen 仅在检测到对应 XML 标记时触发，注入逻辑与常规 Agent 不同：

- **craft_gen**: 额外注入 `craft` zone 全量（历史项目，防效果重名）
- **char_gen**: `<char_detect>` 的 bodyText 作为核心输入（Story AI 对新角色的叙事描述）
- **item_gen**: **主数据源**是 `agentOutputs['char_gen']`（char_gen 完整 JSON），zone 仅为辅助

### 3.6 Zone 写入 → EventBus 事件联动

> 📖 相关文档: `docs/reference/effect_script_system.md` — 四层效果架构（EffectParser → EffectRuntime → EventBus → ScriptExecutor）

每个 Zone 被写入时，引擎会通过 EventBus 发出对应事件。已注册 `$event.on()` 持久订阅的装备/技能/状态效果/登神长阶脚本会在此刻触发：

| Zone | 写入操作 | 触发事件类型 | 可能激活的脚本 |
|------|---------|-------------|--------------|
| `npc` | char_update 修改 HP/MP/SP | `character_action` | 装备的 init/cleanup、登神长阶的被动效果 |
| `npc` | char_update 添加/移除 statusEffects | `status_effect` | 状态效果的 onApply/onRemove、联动状态 |
| `npc` | char_update 装备/卸下装备 | `item_use` | 装备的 init → `$event.on()` 注册持久监听；cleanup → `$event.off()` 注销 |
| `npc` | char_update 学习/使用技能 | `skill_use` | 技能的 onUse 脚本 |
| `world` | vars_update 修改时间/地点 | `variable_change`, `location_change` | 时间敏感状态效果、地点触发脚本 |
| `variable` | vars_update 修改自由变量 | `variable_change` | 旗标变化触发剧情脚本 |
| `quest` | plot_post_check 修改事件状态 | `plot_trigger` | 剧情事件完成/失败触发的世界线脚本 |
| `combat` | combat-resolver 写入战斗状态 | `combat_action` | 装备/技能的战斗响应脚本 |
| `craft` | craft-resolver 写入制作结果 | `craft_action` | 制作完成触发的装备绑定脚本 |

**重要约束**: 脚本执行在沙盒中完成，收集到 `ScriptEffects`（adds/removes/stackSets/hpChanges/statChanges/events/subscriptions）后**统一批量应用**。这意味着：
- 同一轮内的多个 HP 修改会被合并（而非逐条执行）
- `$event.emit()` 触发的事件在同一轮内被收集，下一轮才被 EventBus 分发
- `SubscriptionManager` 管理持久订阅的生命周期，递归深度上限 10 层
- 对象失效时 `unregisterAll(ownerKey)` 兜底清理残留订阅

**对 Zone 可见性模型的影响**:
- 引擎内部：脚本通过 `$resource.modifyHp()` 修改 HP → 收集到 `ScriptEffects.hpChanges` → 统一写入 `npc` zone → 触发 `character_action` 事件
- AI 视角：story Agent **看不到** scripts 代码（NARRATIVE 级别剥离），但能看到装备/技能的 `effects` 中文描述，story 据此描述效果在叙事中的表现
- char_update Agent：FULL 级别能看到 scripts 内容，因为 char_update 负责管理角色完整状态，包括脚本的注册和清理

---

## 四、各 Agent 场景示例

### 4.1 memory_recall（Stage 0）

**场景：直接匹配 — 地点查询**

```
用户: "铁匠铺怎么走来着？上次那个委托完成了吗？"

输入 Zone:
  memory (FULL 60条): 含 MEM0001(白曜城地图, importance:7), MEM0002(铁匠委托, importance:8, keywords:["铁匠铺","委托","铁矿石"])
  npc (KEYS): [player 亚瑟, npc_003 铁匠老罗, npc_007 艾琳]
  world (KEYS): {time: "光辉纪元001年-05月-25日-10:00", location: "白曜城-五馆街"}
  quest (KEYS): [quest_001 铁匠的委托 | active]

输出:
{"memories": [
  {"id": "MEM0002", "relevance": 0.95, "reason": "铁匠委托直接匹配，用户正在询问委托完成情况"},
  {"id": "MEM0001", "relevance": 0.85, "reason": "白曜城地图信息包含铁匠铺位置"}
]}
```

**Embedding 路径**: 当 model 名含 "embedding" 时，不走 LLM，改为 `computeEmbedding(userInput)` → `cosineSimilarity()` → top-K 阈值过滤。输出格式相同。

### 4.2 plot_pre_check（Stage 0）

**场景：标准触发 — 进入铁匠铺**

```
用户: "我推开铁匠铺的门"

输入 Zone:
  quest (FULL): [evt_01 铁匠的请求 | pending | triggerCondition: "{{location}}包含'铁匠铺'"]
  outline (FULL): "第一章：与铁匠公会建立联系..."
  npc (FULL): player location=白曜城-市集 → 前往铁匠铺
  world (FULL): location=白曜城-市集

输出:
{"triggeredEvents": [
  {"id": "evt_01", "reason": "主角正进入铁匠铺——满足触发条件。当前章节大纲要求与铁匠公会建立联系。"}
],
"relevantBackground": "铁匠公会最近缺少矿石原料...完成此委托将解锁北境矿场的线索。",
"outlineRelevance": "第一章要求与铁匠公会建立联系，evt_01是通往后续章节的关键路径节点。"}
```

→ `relevantBackground` 作为 ~100 字摘要注入 story Agent 的 prompt。

### 4.3 story（Stage 1）

> 📖 **叙事规范参考**: 本场景的完整世界观上下文已提取到 `docs/reference/narrative_context_example.md`，包含维度清单和反例对照。生成任何世界观叙事内容前必须查阅。

**场景：探索 → 进入铁匠铺**

```
用户: "我推开铁匠铺的门"

输入 Zone:
  memory (SUMMARY): MEM0003 铁匠委托 (importance:7), MEM0001 白曜城地理 (importance:5)
  npc (NARRATIVE): 见下方完整注入格式示例
  world (FULL): 时间:16:30, 天气:晴朗, 季节:春季
  quest (SUMMARY): quest_001 "铁匠的请求" active, chapterGoal: "与铁匠公会建立联系..."
  outline (SUMMARY): 第1章 "白曜城的新人冒险者", chapterGoal: "抵达白曜城，建立初步人脉"

npc zone @ NARRATIVE 注入内容:
────────────────────────────────────────────────
## 👥 在场角色

[你] 凯恩 · 人类 · T2 中坚 · Lv.5
  外貌: 身材结实的年轻男子，手掌因常年的锻造劳作而布满老茧
  身份: 铁匠学徒, 白曜城居民 · 职业: 锻造师
  背景: 在边境锻造坊长大，父亲是退伍老兵，母亲早逝。十六岁独自来到白曜城，凭父亲教的基础锻冶手艺拜入老铁匠门下，学艺两年。渴望见识更广阔的世界，但性格内向不善与人交际
  性格: 内向、感性、平和、孩子气。心地善良但偶尔流露出少年人的冲动和好奇。对他人的苦难有天然的同情心，但表达方式笨拙。面对强者会本能地保持谦逊
  五维: 力量12 敏捷8 体质10 智力7 精神6
  HP: 85/100  MP: 40/50  SP: 30/50
  位置: 白曜城-市集 → 前往铁匠铺
  状态: 待机中 · 状态效果: 无

  装备:
    [武器] 铁剑 (普通) — 一把朴素但保养良好的铁剑，剑刃上还留着上次打磨的痕迹
    [护甲] 皮甲 (普通) — 深褐色的硬皮甲，左肩处有一道修补过的划痕

  技能:
    [主动] 重击 — 集中力量进行一次势大力沉的斩击
    [被动] 坚韧 — 长年锻造赋予的强健体魄，比常人更能承受伤害

  背包:
    治疗药水 ×2 (消耗品, 普通) — 散发草药香气的红色液体
    铁矿石 ×5 (材料, 普通) — 从北境矿场采集的优质铁矿石
    50G

  关系:
    老铁匠 — 友好 (好感度:45, 师徒, 如同父子)

[铁匠] 老铁匠 · 矮人 · T1 普通 · Lv.5
  外貌: 身材矮壮的中年矮人，粗壮的手臂上纹着铁锤与砧板的公会徽记
  身份: 铁匠铺老板, 铁匠公会成员 · 职业: 锻造大师
  背景: 出身于北境矮人锻冶世家，年轻时游历大陆各地学习锻造技艺，三十年前在白曜城落脚开了这家铁匠铺。妻子十年前病逝，无子嗣，将学徒凯恩视为己出
  性格: 憨厚直爽、不拘小节。典型的矮人脾气——高兴时开怀大笑，生气时摔锤子骂人。对锻造有着近乎偏执的热爱，对徒弟虽然嘴上不饶人但心里极为护短
  五维: 力量14 敏捷5 体质12 智力8 精神7
  HP: 120/120 · 位置: 铁匠铺 · 状态: 正在锻造
  状态效果: 轻微烧伤 (左手背红肿，剩余15分钟)

  装备:
    [武器] 锻造铁锤 (优良) — 一把沉重的锻造专用铁锤，锤面上刻着矮人符文

  技能:
    [主动] 淬火 — 以精准的淬火技巧提升锻造品质
    [被动] 矮人锻冶 — 矮人血脉传承的锻造天赋，锻造品质上限+1

  背包:
    精炼铁矿石 ×20 (材料)
    木炭 ×30 (材料)
    各式武器成品 ×8

  关系:
    凯恩 — 友好 (师徒关系)

[精灵] 艾琳 · 精灵 · T2 中坚 · Lv.8
  外貌: 身材纤细的精灵女性，银白色长发扎成高马尾，翠绿色眼眸警觉而锐利
  身份: 巡林者, 北方游侠 · 职业: 弓箭手, 侦察兵
  背景: 出身于翡翠之心森林的银叶精灵部落，成年后离开部落成为巡林者。近几个月在追查一群与北境矿场有关的走私者，线索指向白曜城。刚抵达城内，来铁匠铺补充箭矢
  性格: 冷静果断，观察力极强——进入任何空间第一件事就是扫视每个角落。对陌生人保持礼貌的距离，语气简洁不拖沓。但一旦认定对方可信，会是非常忠诚的战友
  五维: 力量4 敏捷10 体质5 智力7 精神8
  HP: 155/160 · 位置: 铁匠铺 · 状态: 靠在门边，观察着店内
  状态效果: 无

  装备:
    [武器] 精灵长弓 (优良) — 由银月木打造，弓身上刻着精灵符文，在暗处微微发光
    [护甲] 巡林者皮甲 (普通) — 深绿色的轻便皮甲，肩膀处衬有硬化的骨片

  技能:
    [主动] 精准射击 — 进行一次精准的瞄准射击
    [被动] 自然感知 — 精灵血统赋予的敏锐感官，能察觉细微的环境变化

  背包:
    白羽箭袋 ×1 · 草药包 ×3 · 30G

  关系:
    凯恩 — 中立 (刚认识)
────────────────────────────────────────────────

输出:
<thinking>玩家进入铁匠铺。铺子里有老铁匠（正在锻造，轻微烧伤）和艾琳（靠在门边）。
凯恩背包里有铁矿石×5，这正是老铁匠需要的。老铁匠是凯恩的师傅，
关系友好，应该用熟悉的语气。艾琳是刚出现的陌生人，保持警觉的观察姿态。</thinking>
<maintext>你推开沉重的橡木门，热浪和金属撞击声扑面而来。
身材矮壮的老铁匠正站在铁砧前，粗壮的手臂抡起锻造铁锤，
叮叮当当地敲打着一块烧红的铁坯。他左手背上还泛着一片红肿——
大概是刚才一不留神被铁钳烫到了。

"哦，是你啊，小子！"老铁匠抬头看见你，咧嘴露出一个憨厚的笑容，
"上次说的那批铁矿石带来了吗？我这正缺材料呢。"

你注意到门边靠着一个陌生的精灵。她背着长弓，银白色的马尾垂在肩头，
翠绿色的眼眸正不动声色地打量着你和铺子里的每个角落。</maintext>
<option>拿出铁矿石交给铁匠
询问老铁匠手上的烫伤
和那个精灵攀谈起来
看看墙上挂着的武器</option>
<sum>你进入铁匠铺，铁匠询问铁矿石的情况，一位精灵巡林者引起了你的注意</sum>
<vars>{"位置": "北方-诺斯加德-白曜城-五馆街-铁匠铺"}</vars>
```

**关键体现**: story 能准确描述老铁匠的"矮壮身材+粗壮手臂"(来自五维力量14/体质12)、"锻造铁锤上的矮人符文"(来自装备 flavor)、"左手烫伤"(来自状态效果)、"精灵在观察四周"(来自技能自然感知+中立关系)、"你背包里的铁矿石×5"(来自背包)，但没有写出 "老铁匠的锻造技能冷却还有2回合" 这种不该出现的数值细节。

### 4.4 vars_update（Stage 2）

**场景：购物 + 移动**

```
story 输出: <maintext>你花50G从铁匠那里买了一把新的铁剑...</maintext>
            <vars>{"位置":"...铁匠铺"}</vars>

输入 Zone:
  npc (KEYS): player (位置:市集), npc_001 (老铁匠, 位置:铁匠铺)
  world (FULL): 时间:16:30, 位置:白曜城-市集, 天气:晴朗

输出:
{"replace": [{"path": "world.location", "value": "北方-诺斯加德-白曜城-五馆街-铁匠铺"}],
 "delta": [{"path": "char.player.money", "amount": -50}],
 "insert": [{"path": "char.player.inventory", "value": {"name": "铁剑", "type": "weapon", "quantity": 1}}],
 "delta_time": 30}
```

### 4.5 char_update（Stage 3，并行×N）

**场景：玩家受伤 + 吃药（target = player）**

```
story 输出: <maintext>地精的匕首划过了你的手臂(HP-12)...你取出治疗药水一饮而尽(HP+20)...</maintext>

输入 npc zone (混合):
  🎯 当前角色 (FULL): player - HP:85/200, 背包: 治疗药水×2, 状态效果: []
  👥 其他角色 (KEYS): npc_001 老铁匠 - 位置:铁匠铺, npc_002 艾琳 - 位置:北境森林

输出:
{"characters": [{"id": "player", "changes": {
  "hp": 93,
  "inventory": [{"action": "remove", "itemId": "item_potion_001", "quantity": 1}],
  "statusEffects": [{"action": "add", "effect": {"name": "轻微出血", "category": "减益", "remainingTime": 30}}]
}}]}
```

### 4.6 memory_summary（Stage 4）

**场景：常规任务完成**

```
story 输出: <maintext>你把10块铁矿石整齐地码在柜台上。铁匠满意地清点了一下，支付了50G报酬。
           "不过这矿石成色有点眼熟...你不会是从北境矿场那边弄来的吧？最近那边可不太平..."</maintext>

输入 Zone:
  memory (SUMMARY 最近5条): MEM0001, MEM0002(铁匠委托, importance:8), ...
  npc (KEYS): player 亚瑟, npc_003 铁匠老罗
  world (SUMMARY): 时间:光辉纪元001年-05月-24日-15:00, 地点:铁匠铺, 天气:晴, 季节:春
  quest (KEYS): quest_001 铁匠的委托 | active

输出:
{"content": "主角按照约定前往白曜城铁匠铺，将收集到的10块铁矿石交给了铁匠老罗...铁匠还警告主角北境矿场近期有山贼盘踞...",
 "hiddenLine": "铁匠委托完成，北境矿场山贼线索浮现，铁匠对主角信任+1",
 "keywords": ["铁匠铺", "委托完成", "铁矿石", "北境矿场", "山贼", "报酬"],
 "importance": 6,
 "timeRangeStart": "光辉纪元001年-05月-24日-15:00",
 "timeRangeEnd": "光辉纪元001年-05月-24日-15:30"}
```

### 4.7 plot_post_check（Stage 5）

**场景：世界线中等变动 — NPC 加入队伍**

```
story 输出: "'我会和你一起去，'艾琳说道，她把弓甩到肩上..."

输入 Zone:
  quest (FULL): evt_04 "调查矿场" active (原计划单人)
  npc (SUMMARY): 艾琳 type=npc, relationships: {"player_1": "盟友"}
  outline (FULL): "第一章...主角独自调查矿场。第二章：孤身深入..."
  combat (SUMMARY): null

输出:
{"worldLineChanged": true, "changeLevel": "moderate",
 "outlineChanges": {"action": "addChapter", "changes": "第二章从'孤身深入'改为'双人成行'。新增1.5章：与艾琳在矿场建立羁绊。"},
 "eventUpdates": [{"id": "evt_04", "action": "update", "changes": {"description": "与艾琳组队调查矿场（原为独自前往）"}}],
 "newChildEvents": [
   {"title": "艾琳的过去", "description": "在旅途中了解艾琳的背景", "triggerCondition": "旅途中或扎营时", "depth": 2},
   {"title": "协同作战", "description": "与艾琳并肩作战建立默契", "triggerCondition": "在矿场触发战斗遭遇", "depth": 2}
 ]}
```

### 4.8 plot_outline（按需）

**场景：新建主线大纲**

```
输入 Zone:
  npc (FULL 设计视图): player 凯恩 - 铁匠学徒 Lv.3 T1, 背景:"在边境锻造坊长大...渴望见识更广阔的世界"
  world (FULL): 纪元:光辉纪元001年, 区域:白曜城/诺斯加德联盟
  quest (KEYS): [] (新存档)
  Plot Config: mode=main, durationYears=2, genrePreference=["combat","mystery"]

输出:
{"content": "# 命定之诗：铁砧之火\n\n## 第一章：白曜城的铁匠学徒\n...",
 "chapters": [
   {"title": "白曜城的铁匠学徒", "summary": "介绍凯恩的日常生活...", "keyEvents": ["学徒委托","矿场干扰","发现遗迹入口"], "estimatedDuration": "2-3周"},
   {"title": "遗迹低语", "summary": "凯恩深入古代遗迹...", "keyEvents": ["遗迹一层探索","发现血统真相","Boss战"], "estimatedDuration": "3-4周"}
 ],
 "selfCritique": {"score": 7, "strengths": ["清晰的三幕式英雄之旅结构","很好地利用了锻造背景"], "weaknesses": ["中期情感驱动力不足"], "suggestions": ["引入竞争弧光——另一位年轻冒险者推动彼此成长"]}}
```

### 4.9 craft_gen（Stage 1 阻塞）

**场景：锻造长剑**

```
Trigger: <craft_request industry="锻造" product="长剑" targetQuality="普通" materials="铁矿石×5, 木炭×2"/>

输入 Zone:
  npc (SUMMARY 制作者+提供者): 凯恩 FULL (STR:12, 锻造Lv.4, 背包:铁矿石×5+木炭×2) + 老铁匠 KEYS (材料提供:无)
  world (FULL): 地点=铁匠铺, 天气=晴, 季节=夏, 设施=标准锻造台+淬火槽
  craft (FULL): 2个历史项目 — iron_bracers(普通,完成), refined_arrows(普通,完成)
  variable (KEYS): {forgeQuality:"standard", workshopTier:1}

输出:
{"difficultyJudgment": {"dcModifier": 0, "reasoning": "T2角色锻造普通品质，材料充足，无环境惩罚"},
 "creativeEffects": [
   {"name": "精铁刃", "description": "剑刃经过精细打磨，攻击力+10%", "type": "增益"},
   {"name": "平衡握柄", "description": "握柄配重精确调整，命中率+5%", "type": "增益"}
 ],
 "effectDeclarations": ["攻击力:+12", "命中率:+5%"],
 "narrativeFlavor": "你握紧铁锤，将烧红的铁块放在铁砧上。火星四溅，叮叮当当的锻打声回荡在铁匠铺中...一把闪烁着寒光的长剑逐渐成型。",
 "craftToolCall": {"industry": "锻造", "productName": "长剑", "targetQuality": "普通", "quantity": 1, "materials": ["铁矿石×3", "木炭×1"]}}
```

→ Code 执行 `$craft.startProject()` → 结果卡片注入历史 → auto-continue Story AI。

### 4.10 char_gen（Stage 2 异步）

**场景：酒馆遇见精灵巡林者**

```
Trigger: <char_detect characterName="艾琳" characterType="npc">
         一位银发的精灵少女走进酒馆。她背着长弓，腰间挂着箭袋，翠绿色的眼眸警觉而锐利...
         </char_detect>

输入 Zone:
  npc (KEYS): [player_001 | 凯恩 | Human | player | T2], [npc_001 | 老铁匠 | Human | npc | T1]
  world (FULL): 时间=光辉纪元001年-06月-20日-19:45, 地点=白曜城-酒馆, 季节=秋
  variable (SUMMARY): {诺斯加德联盟=友好, 翡翠之心=中立, 北境矿场=不稳定}

输出:
{"name": "艾琳", "race": "精灵", "tier": 2, "level": 8,
 "attributes": {"str":4,"dex":10,"con":5,"int":7,"spi":8},
 "identity": ["巡林者","北方游侠","翡翠之心使者"],
 "occupation": ["弓箭手","侦察兵"],
 "background": "艾琳出身于翡翠之心森林的银叶精灵部落...她正在追查一群与北境矿场山贼有关的走私者，专程来酒馆打探消息。",
 "appearance": "身材纤细但肌肉线条分明。银白色长发扎成高马尾。翠绿色眼眸中透着锐利...",
 "personality": "冷静果断，对陌生人保持礼貌的距离。观察力极强——进入酒馆第一件事就是扫视每个角落。",
 "ascension": {"enabled": false}}
```

→ 链式触发 item_gen → `assembleCharacterState()` → StateManager 写入。

### 4.11 item_gen（Stage 2 链式）

**场景：为精灵巡林者生成装备**

```
Primary Input (agentOutputs['char_gen']):
  {"name":"艾琳","race":"精灵","tier":2,"level":8,"attributes":{"str":4,"dex":10,...},"identity":["巡林者",...],...}

输入 Zone (辅助):
  npc (KEYS): 目标=艾琳(精灵,T2,弓箭手/侦察兵), 其他=[凯恩,老铁匠]
  world (FULL): 区域=白曜城/诺斯加德联盟, 季节=秋
  variable (KEYS): {regionStyle:"northern_pragmatic", faction:"诺斯加德联盟"}

输出:
{"skills": [
  {"name":"精准射击","description":"命中率+20%，造成120%伤害","type":"active","cost":{"type":"SP","amount":15},"cooldown":3},
  {"name":"自然感知","description":"被动提升环境感知，闪避率+10%","type":"passive"}
],
"equipment": [
  {"slot":"武器","name":"精灵长弓","description":"由翡翠之心精灵工匠用银月木打造...","stats":{"攻击力":18,"敏捷":2},"durability":120,"quality":"优良"},
  {"slot":"护甲","name":"巡林者皮甲","description":"深绿色轻量化皮甲...","stats":{"防御力":8,"敏捷":1},"durability":100,"quality":"普通"}
],
"inventory": [
  {"name":"白羽箭袋","description":"装有30支精制箭矢的箭袋","quantity":1,"type":"消耗品","rarity":"普通"},
  {"name":"草药包","description":"装有基础疗伤草药的布袋","quantity":3,"type":"消耗品","rarity":"普通"}
]}
```

---

## 五、注入格式示例

### 5.1 npc zone @ NARRATIVE（story Agent 专用）

这是最复杂的注入级别 — 给 story 足够信息生成准确叙事，但剥离纯数值设计细节。核心原则：

| 字段 | 处理方式 | 示例 |
|------|---------|------|
| 五维属性 | ✅ 保留数值 | `力量12 敏捷8 体质10` → 描述为"结实有力" |
| 背景故事 | ✅ 完整 | `在边境锻造坊长大，父亲是退伍老兵…` → story 据此生成角色对特定话题的过往关联反应 |
| 性格 | ✅ 完整 | `冷静果断，对陌生人保持礼貌的距离` 或编码 `dOlgY(F)` → story 据此塑造说话方式和情绪反应 |
| 装备 stats | ❌ 剥离数值，保留风味 | ~~`攻击力+15`~~ → `"锋利的精铁长剑（优良）"` |
| 技能 cost/cooldown | ❌ 剥离 | ~~`SP消耗:15, 冷却:3`~~ → `"进行一次精准的瞄准射击"` |
| 背包物品 stats | ❌ 剥离数值 | ~~`恢复20HP`~~ → `"散发草药香气的红色液体"` |
| 登神长阶 | 📋 仅 enabled + path 名 | `"剑圣之道"` 而非完整技能树 |
| 关系 | ✅ 仅在场角色间 + 好感度数值 | `凯恩 — 友好 (好感度:23, 师徒)` — 数值用于校准互动亲疏 |

```
## 👥 在场角色

[你] 凯恩 · 人类 · T2 中坚 · Lv.5
  外貌: 身材结实的年轻男子，手掌因常年的锻造劳作而布满老茧
  身份: 铁匠学徒, 白曜城居民 · 职业: 锻造师
  背景: 在边境锻造坊长大，父亲是退伍老兵，母亲早逝。十六岁独自来到白曜城，凭父亲教的基础锻冶手艺拜入老铁匠门下，学艺两年。渴望见识更广阔的世界，但性格内向不善与人交际
  性格: 内向、感性、平和、孩子气。心地善良但偶尔流露出少年人的冲动和好奇。对他人的苦难有天然的同情心，但表达方式笨拙。面对强者会本能地保持谦逊
  五维: 力量12 敏捷8 体质10 智力7 精神6
  HP: 85/100  MP: 40/125  SP: 30/125
  位置: 白曜城-五馆街-铁匠铺
  状态: 与铁匠交谈 · 状态效果: 无

  装备:
    [武器] 铁剑 (普通) — 一把朴素但保养良好的铁剑，剑刃上还留着上次打磨的痕迹
    [护甲] 皮甲 (普通) — 深褐色的硬皮甲，左肩处有一道修补过的划痕

  技能:
    [主动] 重击 — 集中力量进行一次势大力沉的斩击
    [被动] 坚韧 — 长年锻造赋予的强健体魄，比常人更能承受伤害

  背包:
    治疗药水 ×2 (消耗品, 普通) — 散发草药香气的红色液体
    铁矿石 ×5 (材料, 普通) — 从北境矿场采集的优质铁矿石
    50G

  关系:
    老铁匠 — 友好 (好感度:45, 师徒, 如同父子)

[铁匠] 老铁匠 · 矮人 · T1 普通 · Lv.5
  外貌: 身材矮壮的中年矮人，粗壮的手臂上纹着铁锤与砧板的公会徽记
  身份: 铁匠铺老板, 铁匠公会成员 · 职业: 锻造大师
  背景: 出身于北境矮人锻冶世家，年轻时游历大陆各地学习锻造技艺，三十年前在白曜城落脚开了这家铁匠铺。妻子十年前病逝，无子嗣，将学徒凯恩视为己出
  性格: 憨厚直爽、不拘小节。典型的矮人脾气——高兴时开怀大笑，生气时摔锤子骂人。对锻造有着近乎偏执的热爱，对徒弟虽然嘴上不饶人但心里极为护短
  五维: 力量14 敏捷5 体质12 智力8 精神7
  HP: 120/120 · 位置: 铁匠铺 · 状态: 正在锻造
  状态效果: 轻微烧伤 — 左手背被烧红的铁钳烫伤，泛起一片红肿 (剩余 15 分钟)

  装备:
    [武器] 锻造铁锤 (优良) — 一把沉重的锻造专用铁锤，锤面上刻着矮人符文

  技能:
    [主动] 淬火 — 以矮人传承的精准淬火技巧提升锻造品质
    [被动] 矮人锻冶 — 矮人血脉传承的锻造天赋，锻造品质上限+1

  背包:
    精炼铁矿石 ×20 (材料) · 木炭 ×30 (材料) · 各式武器成品 ×8 · 200G

  关系:
    凯恩 — 友好 (好感度:45, 师徒, 如同父子)

[精灵] 艾琳 · 精灵 · T2 中坚 · Lv.8
  外貌: 身材纤细的精灵女性，银白色长发扎成高马尾，翠绿色眼眸警觉而锐利
  身份: 巡林者, 北方游侠 · 职业: 弓箭手, 侦察兵
  背景: 出身于翡翠之心森林的银叶精灵部落，成年后离开部落成为巡林者。近几个月在追查一群与北境矿场有关的走私者，线索指向白曜城。刚抵达城内，来铁匠铺补充箭矢
  性格: 冷静果断，观察力极强——进入任何空间第一件事就是扫视每个角落。对陌生人保持礼貌的距离，语气简洁不拖沓。但一旦认定对方可信，会是非常忠诚的战友
  五维: 力量4 敏捷10 体质5 智力7 精神8
  HP: 155/160 · 位置: 铁匠铺 · 状态: 靠在门边，不动声色地观察着
  状态效果: 无

  装备:
    [武器] 精灵长弓 (优良) — 由银月木打造，弓身刻着精灵符文在暗处微微发光
    [护甲] 巡林者皮甲 (普通) — 深绿色的轻便皮甲，肩部衬有硬化骨片

  技能:
    [主动] 精准射击 — 进行一次精准的瞄准射击
    [被动] 自然感知 — 精灵血统赋予的敏锐感官，能察觉细微的环境变化

  背包:
    白羽箭袋 ×1 (消耗品) — 装有30支精制白羽箭矢
    草药包 ×3 (消耗品) — 基础疗伤草药
    30G

  关系:
    凯恩 — 中立 (好感度:0, 刚认识)
    老铁匠 — 中立 (好感度:0, 刚进店)

注意: 以上角色的装备具体数值、技能消耗/冷却、物品详细效果均已剥离。
请用自然语言描述这些内容，而非直接引用数值。（如"锋利的剑刃"而非"攻击力+15的剑"）
背景与性格为角色核心信息，story Agent 应据此塑造角色的对话方式、行为反应和情绪表达。好感度数值用于校准角色间互动的亲疏程度。
```

### 5.2 npc zone @ KEYS（char_gen Agent）

```
=== 已有角色 (npc zone — KEYS only) ===

以下角色已存在于当前存档。新生成角色名必须与此列表无冲突。

| ID | Name | Race | Type | Tier |
|----|------|------|------|------|
| player_001 | 凯恩 | 人类 | player | T2 |
| npc_001 | 老铁匠 | 人类 | npc | T1 |

注意: 上述角色的五维/技能/装备/背包已被安全屏蔽。此列表仅用于重名检查和关系判断。
```

### 5.3 npc zone @ 混合（char_update Agent）

```
## 🎯 当前角色 (完整状态) — targetCharacterId = "player"

[player FULL CharacterState — 五维/装备/技能/背包/登神长阶 全部可见]

## 👥 其他角色 (索引)

npc_001 (老铁匠) — 人类 · T1 普通 — 位置: 白曜城-铁匠铺 — 关系: 友好
npc_002 (艾琳) — 精灵 · T2 中坚 — 位置: 北境森林 — 关系: 中立
```

### 5.4 outline zone @ SUMMARY（story Agent）

```
## 📚 剧情大纲 (当前章节)

当前进度: 第 1 章 / 共 5 章
章节: 白曜城的新人冒险者
目标: 主角抵达白曜城，通过铁匠公会建立人脉，发现北境古墓的线索
```

### 5.5 outline zone @ FULL（plot_pre_check Agent）

```
═══════════════════════════════════════
█  ZONE: outline (FULL)
═══════════════════════════════════════
大纲版本: v3 | 世界线状态: stable | 已确认: true

# 第一章：白曜城的新人冒险者

主角抵达北方重镇白曜城，在这里开始冒险者生涯...

## 章节结构
[1] 白曜城的初遇
    摘要: 主角抵达白曜城，完成铁匠委托任务，了解城中势力
    关键事件: 抵达白曜城 | 铁匠委托 | 北境古墓传闻
    预计时长: 1-2周（游戏时间）
═══════════════════════════════════════
```

---

## 六、实施指南

### 6.1 新增类型定义 (`context-visibility.ts`)

```typescript
export type VisibilityLevel = 'FULL' | 'SUMMARY' | 'KEYS' | 'NONE';
export type ZoneId = 'memory' | 'npc' | 'world' | 'quest' | 'craft' | 'combat' | 'outline' | 'variable';

export interface AgentZoneVisibility {
  memory: VisibilityLevel; npc: VisibilityLevel; world: VisibilityLevel;
  quest: VisibilityLevel; craft: VisibilityLevel; combat: VisibilityLevel;
  outline: VisibilityLevel; variable: VisibilityLevel;
}

export function getAgentZoneVisibility(agentId: string): AgentZoneVisibility {
  return VISIBILITY_MATRIX[agentId] ?? DEFAULT_VISIBILITY;
}

export function filterZoneContent(
  zoneId: ZoneId, content: Record<string, any>,
  visibility: VisibilityLevel, agentId: string, ctx?: AgentContext
): string | null { /* FULL/SUMMARY/KEYS/NONE 分发 */ }
```

### 6.2 修改 AgentContext (types.ts)

新增字段：`zones: Record<string, VariableZone>`、`zoneVisibility: ZoneVisibilityMatrix`、`targetCharacterId?: string`

### 6.3 重构 buildAgentMessages (agent-templates.ts)

Part 3（变量区）从手工 `variableContext(ctx)` 改为基于 zone visibility 矩阵的 `buildZoneSection(agentId, ctx)`。

### 6.4 迁移路径

1. **Step A**: 新建 `context-visibility.ts`，实现可见性矩阵 + zone 过滤
2. **Step B**: `AgentContext` 新增 `zones` 字段，写 `buildZoneContext()` 组装现有字段到 zone 字典
3. **Step C**: 修改各 Agent 的 `variableContext()` 从 `ctx.zones` 读取（旧函数保留为 fallback）
4. **Step D**: `buildAgentMessages()` 中集中调用 `filterZoneContent()`，移除各 Agent 的手工过滤

---

## 七、Prompt 四部分最终结构

```
┌──────────────────────────────────────────┐
│  预设 (Preset)                           │  ← 不共享，per-agent 固定
│  Agent 职责 / 思维链 / 输出格式           │
├──────────────────────────────────────────┤
│  世界书 (World Books)                    │  ← 部分共享，按 worldBookIds 分配
│  constant entries + keyword-matched      │
├──────────────────────────────────────────┤
│  变量区 (Variable Zones)                 │  ← 部分共享，按 visibility matrix
│  8 zones × 4 可见性级别                  │
├──────────────────────────────────────────┤
│  正文/用户输入 (Body)                     │  ← 共享，对话历史 + userInput
│  最近 N 轮对话 + 本轮用户输入              │
└──────────────────────────────────────────┘
```

---

## 八、待解决设计问题

1. **`variable` zone SUMMARY vs KEYS 边界**: 当前为空容器。未来 `user.*` 变量增长时，需定义 SUMMARY 白名单（推荐按前缀：`sys.faction_standing.*` + `sys.region_state.*`）
2. **material provider 自动检测**: craft_gen 的 npc SUMMARY 需要扫描 marker 的 `materials` 字段，逆向匹配背包中持有这些材料的在场角色
3. **同轮多 char_detect 重名检测**: 如果同一轮引入 3 个 NPC，char_gen 调用间需要互斥名称列表
4. **item_gen 对 craft zone 的可见性**: 当前 NONE，若未来需要引用制作物品防效果重名，可能升级到 KEYS
5. **scripts/effects 的双轨可见性**: 装备/技能/状态效果/登神长阶现在都有 `scripts`（JS 代码）和 `effects`（中文描述）两个独立字段。NARRATIVE 级别剥离 scripts 保留 effects，FULL 级别两者都可见。需确保 `formatZoneNarrative()` 实现严格剥离脚本代码，防止注入 story prompt 造成 prompt injection 风险
6. **EventBus 事件与 Zone 写入的原子性**: 脚本通过 `$resource.modifyHp()` 收集到 `ScriptEffects.hpChanges`，需在 StateManager 统一写入 `npc` zone 后，EventBus 再分发事件。如果事件处理过程中又产生新的 ScriptEffects，需要处理递归写入的一致性问题（当前递归上限 10 层）
7. **`@parent` 脚本引用跨 zone 一致性**: 当 item_gen 为 NPC 生成带 `@parent` 脚本引用的装备时，需确保 parentScripts 在 char_gen → item_gen 链中正确传递
