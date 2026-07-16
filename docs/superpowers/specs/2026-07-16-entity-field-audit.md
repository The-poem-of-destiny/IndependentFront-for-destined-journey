# 2026-07-16 数据实体字段现状审计归档

> survey-entity-fields workflow 交叉审计产物（5 盘点 Agent + 1 审计 Agent，9 处跨报告冲突已回代码裁决）。
> 配套规范: 2026-07-16-data-field-conventions-design.md（附录 B 的编号对应本文清单）。

## 现状全景摘要（按实体）

**CharacterState**（types.ts:725-790，characters 表）：id 一律 crypto.randomUUID（create-store.ts:632 等），但下游翻译层充斥 'player_1' 假 id 兜底与 prompt 示例（item-gen-chain.ts:115; craft-gen-chain.ts:510）。存储在 characters 表但**无 saveId 一等字段/索引**，靠 customFields.saveId JS 全表扫描过滤（database.ts:472-479）。最大的坑：char_gen 侧链 NPC 不写 saveId → 落库即孤儿，刷新丢失、时间结算漏掉、删档残留三连；customFields 承载 saveId 等关键关联却是自由 KV，同义 key 分裂（physics/appearance、backstory/background、clothing/outfit）导致玩家创角信息不进叙事上下文。

**装备/背包/技能/状态效果**（EquipmentSlot/InventoryItem/Skill/StatusEffect）：id 生成六套前缀并存（randomUUID / itemgen_* / craft_* / varsupd_*），"add+equip 同 id 两步移动"与"char_gen 直写 equipment[]"两种表示法并存。最大的坑：state-manager 的 apply* 契约（value 必须带 id / remove 用 string id）与 orchestrator 翻译层大面积失配——状态效果/技能新增必 throw、items.consume/transfer 静默失效、craft 装备 stats 放错位置全丢；equip/unequip 有损（effects/scripts 不保真）。

**Quest/SaveProfile**（saveProfiles 表，主键=saveId，惰性创建）：Quest 无 id，**任务名即主键**（quests: Record<name, Quest>），patch 的 target 纯装饰。quest 链路（dispatcher→vars_update→orchestrator 解析 parsed.quests）代码已布线，但 vars_update prompt 输出格式**没教 quests 键**（已复核 config 全文），全靠自检清单暗示。affections/fp/contracts/achievements/news 五个字段的写入 API 全部无生产调用方——SaveProfile 一半字段是"声明了但永远默认值"的空壳；focusQuest 改了不回写。

**GameTime**：唯一运行时写入是 applyTimeAdvance（state-manager.ts:702-781），由 dispatcher delta_time 驱动，链路健康。坑：weekday 往返 bug（'周日' format→parse→format 变'周六'，time-system.ts:50/67-70/90）。

**MemoryRecord/PlotEvent/PlotOutline**（各自有 saveId 一等索引，模式健康）：但三张表**生产中全部恒空**——memory_summary Agent 跑了输出被丢（handleAgentResult 仅 story 有副作用），plot 系被 GamePipeline 硬编码 mode:'off' 禁用，generatePlotOutline 是占位空实现。属于"引擎完备、管线断头"。

**ChatMessage**（messages 表，Phase 10h）：id=randomUUID，saveId 可选 + persistMessage 非空断言的孤儿风险；turn 靠 game-store 闭包计数、一问一答共享。variablesAfter 零写入 → latestVariables 恒 null → Agent 上下文 variables 恒 {}，与 StateManager 寄生快照的变量形成**两套互不同步的变量存储**。metadata/apiUsed/parsed 是死字段；v3 chats 表并存待废弃。

**SaveSlot/Snapshot**：SaveSlot.id=saveId=randomUUID，slot 恒 0（10 槽未实现）。**最深的坑是 Snapshot 双轨**：StateManager 写 snapshots 表并指 activeSnapshotId，loadSave 却查恒空的内嵌数组 → 恢复死路径；且自动快照是硬编码空体（连带把寄生其上的变量视图清零），gameTime 写的还是现实时间。totalTurns 每 commit +1 而非每轮 +1，数值虚高还被 HomePage 当 Lv. 显示。

**StatePatch**（26 op，非任务口径的 15）：validatePatch + 逐 patch try/catch 不回滚（state-manager.ts:86-98）。翻译层规范度梯度明显：item-gen-chain 最规范（补 id、两步同 id）> char-gen（target 带子路径全 throw，靠 add_character 内嵌兜住）> craft-gen（双 Date.now / metadata 放错）> orchestrator items.*（name 当 id、object 当 string，几乎全灭）。AI prompt 与 Code 契约的失配是本次盘点最大的系统性问题簇。

---

## 合并去重后的不一致清单（52 项 → 按严重度排序）

### 🔴 S1 会丢数据 / 写入失败（throw 或永久丢失）

| # | 问题 | 证据 |
|---|------|------|
| 1 | **变量存储寄生快照 + 双重丢失**：persistVariables 无快照时静默丢弃写入（state-manager.ts:321-327）；自动快照硬编码空体 `variables:{}, characters:[]`（:676-679），成为 latest 后 getCurrentVariables（:314-318）读到 `{}`，变量视图被重置 | state-manager.ts:314-327, 676-679 |
| 2 | **Snapshot 双轨分裂 → 快照恢复死路径**：StateManager 只写 snapshots 表（state-manager.ts:684）+ activeSnapshotId 指表（:118-120）；loadSave 只查 SaveSlot.snapshots 内嵌数组（game-store.ts:318-322），该数组初始化后全仓无 push（create-store.ts:830, types.ts:997） | state-manager.ts:684; game-store.ts:318-322 |
| 3 | **memory_summary 输出无人持久化**：summarizeAndSave 生产零调用（memory-summarizer.ts:129）；handleAgentResult 仅 story 有副作用（game-pipeline.ts:527-542，vars_update case 为空）；add_memory patch 无生产者（state-manager.ts:594-600）→ memories 表生产恒空（仅 test-save.ts:368 写） | memory-summarizer.ts:129; game-pipeline.ts:527-542 |
| 4 | **vars_update 新增状态效果/技能必 throw（缺 id）**：三条供给链全不带 id——① characters.add statusEffects/skills 原样透传（agent-orchestrator.ts:857-858）；② `<status_effects>` XML 解析产物无 id（char-gen-agent.ts:955-961; orchestrator :958-963）；③ 脚本 $status.add Partial（script-executor.ts:276-282 → state-manager.ts:799）。applyAddStatusEffect :386 / applyAddSkill :548 要求 id 否则 throw。同源问题：combat 防御姿态（combat-resolver.ts:339-346）、StatusEffectPayload（types.ts:1295-1302 → effect-runtime.ts:202-208）同样缺 id | state-manager.ts:386,548; agent-orchestrator.ts:857-858 |
| 5 | **items.consume/transfer 契约断裂 → 物品永远消耗不掉**：applyRemoveItem 期望 value=string itemId + amount（state-manager.ts:462-463），但 orchestrator 传 `{name,quantity}` 对象（agent-orchestrator.ts:916,931）→ 静默 no-op；transfer 的 add_item 无 id（:932）→ throw（state-manager.ts:443）。transfer 整体 = 转出不生效 + 转入报错 | agent-orchestrator.ts:916,931-932 |
| 6 | **'player_1' 假 id 兜底指向不存在角色 → 整链 patch 失败**：item-gen-chain.ts:115、craft-gen-chain.ts:510 兜底 'player_1'，真实角色 id 全是 randomUUID（create-store.ts:632）；且 vars_update/request_dispatcher prompt 示例 + agent-templates.ts:182 都在教 AI 用 'player_1' | item-gen-chain.ts:115; craft-gen-chain.ts:510 |
| 7 | **craft 装备属性全丢 + 两步 id 断链**：stats/durability 放 metadata（craft-gen-chain.ts:440-443）而 applyEquipItem 只读 value.stats（state-manager.ts:483,503）；add_item :424 与 equip_item :437 各自独立调 Date.now()，跨毫秒 id 不等 → 背包扣除失败留副本。另 :407 `craft_${Date.now()}` 无随机后缀，同毫秒多产物按 id 合并成一件（state-manager.ts:445-447） | craft-gen-chain.ts:407,424,437,440-443 |
| 8 | **char_gen 侧链 NPC 缺 customFields.saveId → 孤儿角色**：assembleCharacterState customFields 无 saveId（char-gen-agent.ts:376-386），runCharGenChain 不传 overrides（:507），applyAddCharacter 不注入 this.saveId（state-manager.ts:586-591）→ 刷新后 loadSave 带过滤（game-store.ts:304）匹配不到，NPC 从 UI 消失；applyTimeAdvance 带过滤（state-manager.ts:716）→ 孤儿 NPC 状态效果永不结算 | char-gen-agent.ts:376-386,507; state-manager.ts:590,716 |
| 9 | **deleteSaveSlot 不级联 characters**：删 6 类关联数据独漏 characters（database.ts:563-578；characters 表无 saveId 索引 :193）→ 删档永久残留角色 | database.ts:563-578 |
| 10 | **equip/unequip 数据有损**：旧装备回背包只留 id/name/quantity/type，description/rarity/durability/effects/scripts 全丢（state-manager.ts:489-494,528-533）；新装备只收 slot/itemId/name/stats（:499-504） | state-manager.ts:489-504,528-533 |
| 11 | **buildCharGenPatches target 带子路径**：`characters.<id>.skills` 经 extractId（state-manager.ts:654-660）解析出 `<id>.skills` → 附属 add_skill/add_item/equip_item 全部 throw '角色不存在'（char-gen-agent.ts:410,420,430）。现状靠 add_character 内嵌全量数据（:399-403）兜住最终状态，但 commit 恒带 errors；**若修 target 不去重会二次叠加** | char-gen-agent.ts:410,420,430 |
| 12 | **ascension/exp/fp 写进变量快照而非角色/Profile 记录**：char-gen-agent.ts:441-477（ascension.*）、craft-gen-chain.ts:468-479（exp/profile.fp）、convertScriptEffects hp/属性（state-manager.ts:801-803）全走 variable 系 op → 落 Snapshot.variables，角色记录不变；叠加 #1 无快照时直接丢弃 | char-gen-agent.ts:441-477; craft-gen-chain.ts:468-479 |
| 13 | **persistMessage 非空断言**：`saveId: activeSaveId.value!`（game-store.ts:235），null 时产生 getMessages(saveId) 永不召回的孤儿消息；与同文件 :258,272 `?? undefined` 风格不一致 | game-store.ts:235 |
| 14 | **focusQuest 只读不回写**：QuestsPanel 本地 ref（QuestsPanel.vue:8,59）改后不持久化，刷新即丢（已复核确认） | QuestsPanel.vue:8,59 |

### 🟠 S2 静默失效（不报错但行为错误 / 功能恒空）

| # | 问题 | 证据 |
|---|------|------|
| 15 | **affections 完全断链恒 0**：无 set_affection op（types.ts:1207-1235）、state-manager 无 case（:158-229）、$affection API 无生产调用（affection-system.ts:149-164）；UI 按 npc.id 读（CharacterListPanel.vue:45）永远 0。并行的叙事层"关系列表[角色名].affinity"按名字索引（game-store.ts:73-83; context-visibility.ts:384），两套互不同步 | affection-system.ts:149-164 |
| 16 | **news 双写歧义 → ScenePanel 新闻恒空**：UI 读 saveProfile.news（game-store.ts:65-67），运行时新闻走 request_dispatcher → variables"世界新闻"（agent-orchestrator.ts:704-732）；addNews 无生产调用（save-profile.ts:120-132）；namespace-normalizer.ts:53 又把旧路径映到 variables sys.news | game-store.ts:65-67; save-profile.ts:120-132 |
| 17 | **FP/契约/成就管线未接**：addFP/spendFP/addContract/addAchievement（save-profile.ts:31-116）+ fp-system 计算函数（fp-system.ts:36-81）均无生产调用 → SaveProfile.fp 恒 0 | save-profile.ts:31-116 |
| 18 | **PlotEvent/PlotOutline 生产恒空**：plot-engine.ts 无生产 import；GamePipeline 硬编码 `plotSettings:{mode:'off'}`（game-pipeline.ts:282，已复核）；generatePlotOutline 占位空实现（create-store.ts:611-615）但 startJourney 仍 savePlotOutline（:848-851） | game-pipeline.ts:282; create-store.ts:611-615 |
| 19 | **currentAction 被翻成 set_location**：agent-orchestrator.ts:834-835 → applySetLocation 写 char.location（state-manager.ts:580），动作文本顶掉所在地 | agent-orchestrator.ts:834-835 |
| 20 | **characters.delta 非资源字段变替换**：`{[path]: amount}` 走 Object.assign（agent-orchestrator.ts:849; state-manager.ts:337）→ money delta -50 变 money=-50，而 prompt 明确教 delta 用于金钱/EXP | agent-orchestrator.ts:849 |
| 21 | **items.modify / remove skills 污染角色对象**：`{itemUpdate:{...}}`（agent-orchestrator.ts:937）、`{removeSkill:...}`（:910）经 Object.assign 挂到 CharacterState 上成假字段，实际不改物品不删技能 | agent-orchestrator.ts:910,937 |
| 22 | **remove_status_effect 按名删、按 id 匹配**：prompt 教 target="轻伤"（效果名），applyRemoveStatusEffect filter `e.id !== effectId`（state-manager.ts:429-430）→ 静默删不掉 | state-manager.ts:429-430 |
| 23 | **items.equip 拿物品名当 itemId 且丢 name**：agent-orchestrator.ts:921 → 背包按 id 扣除匹配不到（state-manager.ts:507），装备栏 name=undefined（:502） | agent-orchestrator.ts:921 |
| 24 | **unequip 语义双关**：prompt 教"物品名或槽位"，applyUnequipItem 只认 slot（state-manager.ts:525-526）→ 传物品名静默 no-op；characters.remove equipment（orchestrator :909）同病 | state-manager.ts:525-526 |
| 25 | **vars_update prompt 未教 quests 键但 orchestrator 在解析**（已复核：config 全文无独立 `"quests"` JSON 键，仅自检清单第 8-9 条提及映射要求）→ quest 链路靠 AI 悟性，跑偏无 Code 兜底（quest_update_request 也非正式 marker，marker-protocol.ts:39-48 不含） | agent-orchestrator.ts:972-1009 |
| 26 | **Stage2 delta 分支死代码 + metadata 错标**（已复核）：dispatcher prompt 只演示 delta_time/replace，orchestrator :712-719 解析 parsed.delta 无供给；且 :717,:725 metadata.source 写 'vars_update'（replace 分支 :709 是 'request_dispatcher'）——复制粘贴残留 | agent-orchestrator.ts:712-727 |
| 27 | **totalTurns 语义漂移**：每次 commitChatState +1（state-manager.ts:116，已复核），一轮管线 commit ≥2 次（orchestrator :730/941/964/1002 + 侧链 + agent-tools:540）→ 虚高；HomePage.vue:245 还显示成 Lv. | state-manager.ts:116; HomePage.vue:245 |
| 28 | **StateManager 即建即抛 → 快照间隔失真**：6 处生产实例化（agent-orchestrator.ts:701/822/957/978; game-pipeline.ts:430; agent-tools.ts:539，已复核）各自独立计数，`patchCount % 5`（state-manager.ts:100,104）退化为"单实例累计恰 5n 才触发" | state-manager.ts:100-104 |
| 29 | **EventBus/SubscriptionManager/EffectRuntime 三件套未接线**："按 SaveSlot 隔离"仅测试可见（game-event.ts:251-259; subscription-manager.ts:53; effect-runtime.ts:332 均无生产调用） | game-event.ts:254 |
| 30 | **$char.getNpcs/getMonsters 假隔离**：接收 saveId 参数但函数体忽略，返回全库（char-query.ts:40-47; database.ts:485-487）；refreshFromDb 又故意全表读兜孤儿（game-store.ts:341）——同一"当前存档角色"两种互斥语义 | char-query.ts:40-47 |
| 31 | **GameTime weekday 往返漂移**（已复核）：默认 weekday=1='周日'（time-system.ts:50,90 format），parseGameTime 把'周日'→7（:67-70）→ 再 format 变'周六' | time-system.ts:50,67-70,90 |
| 32 | **Quest.status 自由字符串**：getActiveQuests 硬编码比对'已完成'/'失败'（save-profile.ts:176），AI 变体（"完成"）误判活跃 | save-profile.ts:174-178 |
| 33 | **variablesAfter 生产零写入 → 两套变量存储互不同步**：latestVariables 恒 null（game-store.ts:55-62）→ context.variables 恒 {}（game-pipeline.ts:277，已复核）；与 StateManager 寄生快照的变量（#1）形成双轨 | game-store.ts:55; game-pipeline.ts:277 |
| 34 | **玩家创角 customFields 无人读**：physics（create-store.ts:683）/ backstory（:684）写入，读方只认 appearance/background（context-visibility.ts:289-291; CharacterListPanel.vue:191-208）→ 玩家填的外貌/背景不进叙事上下文；char_gen 写 clothing（char-gen-agent.ts:381）而 UI 读 outfit → 服装不显示 | create-store.ts:683-684 |
| 35 | **applyRemoveItem 静默 vs applyAddItem throw 风格分裂**：材料消耗失败无从感知（state-manager.ts:443 vs 465-471） | state-manager.ts:465-471 |
| 36 | **markNewsRead 死代码**：无调用方，read 标志永不翻转（save-profile.ts:134-139; ScenePanel.vue:121-124 仅本地展开） | save-profile.ts:134-139 |

### 🟡 S3 命名/契约混乱

| # | 问题 | 证据 |
|---|------|------|
| 37 | **slot 中英双轨**：类型注释/state-manager 判断用英文 'weapon'（types.ts:614; state-manager.ts:493,532），item_gen prompt + guessSlot 用中文'武器'等（item-gen-chain.ts:311-322）→ 中文槽位旧装备回背包一律标 'armor' | state-manager.ts:493; item-gen-chain.ts:311-322 |
| 38 | **InventoryItem.type 三套取值**：注释英文枚举（types.ts:649）、引擎链路 'equipment'（item-gen-chain.ts:248; craft-gen-chain.ts:411 硬编码——非装备产物也标 equipment，已复核）、测试/prompt 中文'消耗品'等 | types.ts:649; craft-gen-chain.ts:411 |
| 39 | **quality vs rarity 双名**：ItemGenOutput.equipment 用 quality、inventory 用 rarity（types.ts:2675,2684），craft 把 quality 塞 rarity（craft-gen-chain.ts:412,429），均绕过 7 级字面量联合（types.ts:650） | types.ts:2675,2684 |
| 40 | **Quest 主键双轨**：target `quests.<name>` 纯装饰不被解析（state-manager.ts:617-638），update_quest value=对象带 name、remove_quest value=裸字符串——形态不一致；任务名即主键无 id，改名=新建（types.ts:2146-2159） | state-manager.ts:617-638 |
| 41 | **装备两种落库表示并存**：char_gen 直写 equipment[]（背包无镜像，char-gen-agent.ts:308-320）vs item-gen/vars_update 的 add+equip 两步移动语义（item-gen-chain.ts:237-263）——"装备是否必有背包镜像"无统一答案 | char-gen-agent.ts:308-320 |
| 42 | **gameStartTime 双语义**：create-store.ts:834 写现实 ISO 时间，test-save.ts:60 写游戏内时间串；Snapshot.gameTime 同病——注释"游戏内时间"实写 `new Date().toISOString()`（types.ts:970; state-manager.ts:675） | create-store.ts:834; state-manager.ts:675 |
| 43 | **characters 表无 saveId 一等字段/索引**：全库唯一靠 customFields.saveId JS 全表扫描过滤的表（database.ts:193,472-479），与 memories/snapshots/messages 一等索引模式不一致——#8/#9/#30 的共同根因 | database.ts:193,472-479 |
| 44 | **叙事层关系数据 vs SaveProfile.affections key 语义分裂**：角色名 vs characterId（见 #15） | context-visibility.ts:384 |
| 45 | **assembleCharacterState 有损映射**：装备只映射 effects 不映射 scripts（char-gen-agent.ts:318）、inventory 丢 effects/scripts（:328-335）、Skill.level 硬编码 1（:297）、maxDurability 用 durability 充当（:316-317）；ItemGenOutput 类型本身缺 effects/scripts 字段（types.ts:2665-2685） | char-gen-agent.ts:297,316-318,328-335 |
| 46 | **chats(ChatSession) v3 遗留表与 messages 表并存**：ChatSession 无 saveId（types.ts:499-502），仅 vanilla store 使用（sillytavern-store.ts:77 等） | database.ts:190 |

### ⚪ S4 冗余 / 死字段

| # | 问题 | 证据 |
|---|------|------|
| 47 | **metadata.description 塞 JSON 字符串**：序列化 {openingPrompt,destinyCoreId,difficulty,remainingPoints}（create-store.ts:836-841），全仓无读取方；openingPrompt 与 metadata.openingPrompt（:843）双份 | create-store.ts:836-843 |
| 48 | **ChatMessage 死字段**：metadata/apiUsed 零写入（types.ts:489-496）；parsed 仅 v3/测试写，ChatFlow.vue:105 靠 content 兜底 | types.ts:489-496 |
| 49 | **messages 复合索引 [saveId+turn] 无查询使用**：getMessages 按 timestamp 排序（database.ts:200,699-703） | database.ts:200 |
| 50 | **Snapshot.messageIds 声明即死**（types.ts:983-984）；MemoryRecord.relatedPlotEventId 已 @deprecated 仍在（types.ts:888-889）；createCompressionSummaryMemory 返回缺 id 记录且无调用方补（memory-summarizer.ts:192-220） | types.ts:888-889,983-984 |
| 51 | **SaveSlot.slot 恒 0**："10 槽"未实现（create-store.ts:826 TODO），getSaveBySlot 多档同槽取 first（database.ts:553-555）；PlotOutline version 原地覆盖使 getLatestPlotOutline 排序形同虚设（plot-outline.ts:202-223; database.ts:611-617） | create-store.ts:826 |
| 52 | **杂项**：applyUpdateQuest/applyRemoveQuest 解构 updateProfile 未用（state-manager.ts:621,633）；任务口径"15 种 op"实为 26 种（types.ts:1207-1235）；StateManager maxSnapshots=30 与 AppSettings.maxSnapshotsPerSave=30 数值巧合但不读 settings（state-manager.ts:62; types.ts:462） | state-manager.ts:621,633 |

---

## 跨报告冲突及代码裁决（已逐一回代码复核）

| # | 冲突点 | 报告分歧 | 代码裁决 |
|---|--------|---------|---------|
| C1 | GamePipeline.handleAgentResult 处理范围 | 报告3说"只处理 story/vars_update"；报告4说"只处理 story" | **两者都对但报告4更准确**。game-pipeline.ts:527-542 的 switch 有 story 和 vars_update 两个 case，但 vars_update case 是空分支（仅注释 + break，:536-540），唯一有副作用的是 story（addMessage :532）。结论：memory_summary/plot 系输出确实被丢弃，vars_update 的实际处理在 orchestrator 而非此处 |
| C2 | vars_update prompt 是否教了 quests 键 | 报告2把 quest 链路描述为已布线协议（"vars_update 输出 `<json>{quests:{upsert,remove}}`"）；报告5说"JSON schema 里没有 quests 键，格式未教、检查却要求" | **报告5 胜诉**。对 agent-config.json 全文正则验证：所有 "quests" 命中均为 "requests" 子串（skill_requests/item_requests 等），独立 JSON 键 `\"quests\"` **零命中**；vars_update 输出格式节只有 characters/items 两键。但 orchestrator 确实在解析 parsed.quests（agent-orchestrator.ts:976-999），自检清单第 8-9 条也要求 quest 映射（config 内确认存在）。现状 = AI 只能靠自检清单反推格式，链路能否工作靠模型悟性 |
| C3 | 自动快照触发语义 | 报告4说"每 5 个 patch 一次的空快照遮蔽变量"（暗示会周期性发生）；报告3说"只有单次 commit patch 数恰为 5 的倍数才触发" | **折中，报告3的机制描述更准**。state-manager.ts:100 `patchCount += patches.length`（按批累加，非逐 patch），:104 `patchCount % 5 === 0` 在**同一实例内**跨 commit 累积；但生产中 6 处调用点（agent-orchestrator.ts:701/822/957/978 + game-pipeline.ts:430 + agent-tools.ts:539）都是即建即抛，实际退化为"单实例累计 patch 数恰为 5 的倍数才触发"。报告4的"每 5 patch 遮蔽"是理想态描述；但一旦触发，空快照遮蔽变量的后果（报告3/4一致）成立 |
| C4 | buildCharGenPatches 坏 target 的后果 | 报告1说 add_skill/add_item/equip_item "全部报角色不存在"且"若 target 修好这些 patch 会二次叠加数量"；报告5说"幸运的是 add_character 已内嵌全部数据，最终状态碰巧正确，但 commit 带 errors" | **两者兼容，报告5的现状描述准确**。state-manager.ts:86-98 逐 patch try/catch，单 patch throw 不中断批次也不回滚 → add_character 成功落库（含全量 skills/inventory/equipment，char-gen-agent.ts:399-403），后续附属 patch 各自失败进 errors[]。报告1的"二次叠加"是修复 target 后才会出现的隐患预警，非现状 |
| C5 | Stage2 delta 分支是否死代码 | 报告2表格列出 dispatcher 产出 "set_variable/delta_variable/insert_variable" 三种（把 delta 当活链路）；报告5说"prompt 只教 delta_time/replace/insert，delta 分支是死分支" | **报告5 胜诉（并修正其一处细节）**。agent-config.json request_dispatcher 输出格式节实测只演示 `delta_time` + `replace`（示例1-3 均无 delta/insert 数组）；orchestrator :712-719 的 parsed.delta 解析分支无 prompt 供给。且确认 :717/:725 的 metadata.source 写 'vars_update' 而 replace 分支 :709 写 'request_dispatcher'——复制粘贴残留属实 |
| C6 | StateManager 生产实例化点数量 | 报告3列 5 处（orchestrator×4 + game-pipeline×1）；报告4/5 列 6 处（+agent-tools.ts:539） | **6 处**。agent-tools.ts:539 实测存在 `createStateManager(context.saveId)`（craft_settle 工具内提交 patches）。报告3漏计 |
| C7 | GameTime weekday 往返 bug | 仅报告2提出，其他报告未涉及，需验证 | **属实**。time-system.ts:50 默认 weekday=1 注释'周日'；:90 format 用 `WEEKDAY_NAMES[weekday-1]`（1→'周日'）；:67-70 parse 把 '周日'→**7** → 再 format 时 `WEEKDAY_NAMES[6]`='周六'。format→parse→format 周日漂移成周六，确认 |
| C8 | craft equip 两步 id 是否真的两次 Date.now() | 报告1/5 均断言，交叉验证 | **属实**。craft-gen-chain.ts:424 add_item 与 :437 equip_item 各自模板字符串内独立调用 `Date.now()`，跨毫秒即断链。顺带确认 :411 主产物 type 硬编码 'equipment'（即使产物是药剂），而 :457 inventory 分支用 inv.type——报告5 #18 的"非装备产物也标 equipment"属实 |
| C9 | focusQuest 是否回写 | 仅报告2提出 | **属实**。QuestsPanel.vue:8 `focusQuest = ref(game.saveProfile?.focusQuest || '')` 本地 ref，:59 v-model 只改本地；全文件无任何持久化调用 → 刷新即丢 |
