# 战斗 Agent 会话模式改造 —— 设计定稿（2026-08-09）

> 状态：**已实施（2026-08-09，lean-delegation 波 1-6 / T1-T17 全绿，7397 tests）**。引擎侧：§2.1 持久会话 / §2.2 工具增删查改（get_unit_detail 新增、get_hp_percent 删除）+ 查询命令分流 / §2.3 工具链规范 / §2.4 submit_adjudication 执行端 / §2.5 结算演绎 / §2.6 终局落库回写 / §2.7 system prompt 迁移 agent-config.json。前端侧：§3.1 CombatPanel 重写 v3 / §3.2 玩家输入 submitCombatCommand / §3.3 单位卡片 / §3.4 面板弹出修复（v3_units_snapshot + 事件链 + 玩家输入桥时序修复）/ §3.5 跳过/重开战斗 + pre-combat 快照。
>
> 🔴 **2026-08-12 已过真机并有一次定位纠偏**：真机走查跑完，落地了「战斗主持人/DM 纠偏」+ 8 项真机 bug 修复（攻击卡 UUID / 火球术伤害 / stats 键中英 / 骰池续骰中断 / 逃跑语义 / 敌方熔断闪退 / 终局 AI 总结 / 结算叙事崩），进度表记 7704 tests 全绿。**本文描述的会话机制（持久会话 / 工具分流 / 结算演绎 / 前端 v3）仍是现行实现**，但 `combat_v3` 的定位已从「**敌方专属决策器**」改为「**战斗主持人/DM**」——玩家意图文本也由它解析成 Command。读下文时凡出现「敌方决策」字样，按「战斗主持人对当前行动方的裁决」理解。
>
> 前置决策调查见 `2026-08-09-combat-agent-session-design.md`（逐条决策已完成，本文件为落地方案）。
> 背景：真机 debug 暴露战斗 Agent 提示词缺失、查询工具被误当 Command、战斗面板不弹出、v3 数据流未接入前端。改造核心 = 一个 agent 持久会话贯穿整场 + 工具链规范化 + 前端面板重写 v3。

---

## 一、总体架构决策（定案汇总）

| #   | 决策项        | 定案                                                                                                    |
| --- | ------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | 会话模型      | **整场一个持久会话**：`combat_v3` agent 一个 client 贯穿整场战斗，消息累积，前缀稳定 → LLM 前缀缓存命中 |
| 2   | 流式传输      | **先不开**（默认）。核心收益是缓存+记忆，实时感后置                                                     |
| 3   | 工具引导      | 查询/命令分流 + 查询结果进历史（不破坏缓存命中即可）+ 技能列表开局注入                                  |
| 4   | 思维链        | **摘要式**：面板显示"敌方决定攻击奥利雅思"，完整 reasoning 留 DebugPanel                                |
| 5   | 战斗回退      | **pre-combat 自动快照** + 战斗面板「跳过战斗 / 重开战斗」                                               |
| 6   | system prompt | **补全 + 迁 agent-config.json**（coordinator 硬编码 125 字改为读配置）                                  |

**副决策**：

- `submit_adjudication` **保留 + 补执行端**（内核 `evaluateAdjudication` 已实现，只差工具 case）
- `get_hp_percent` **删除**（面板已有 HP 百分比，冗余）
- `get_character` **必改**：加 skills + 装备字段（否则 AI 决策无依据）
- 新增 **`get_unit_detail`**：当前单位五维+技能+装备一把抓
- 战斗数据落库：**终局 Code 覆写回写** HP/MP/SP/状态到 characters（不走 AI summary 转述）

---

## 二、引擎侧设计（`src/sillytavern/combat-v3/`）

### 2.1 持久会话模型（决策 1A）

**现状**：`routeEnemyCommand`（coordinator.ts:459）每单位每次行动 `clientFactory('combat_v3', ...)` 新建 client + 组 system/user 两条消息，返回后对话丢弃。

**改造**：一场战斗持有一个 `CombatSession` 级对话句柄（消息数组），挂在 coordinator 闭包：

```
战斗开始 ──→ client 建一次，system 只发一次
  R1 敌A:  append(user 轮到A + 面板) → chat → 拿 command + narration
           append(assistant 决策正文) + append(tool 往返)
  R1 敌B:  append(user 轮到B + 面板) → ...
  R2 敌A:  ...   ← 前缀稳定，缓存命中
战斗结束 ──→ 释放
```

**具体改动**：

- `runCombatV3`（coordinator.ts:121）闭包内建 `let combatMessages: ChatMessage[] = []`，`routeEnemyCommand` 读/写它，不再每次组全新 messages。
- system 消息**只 append 一次**（战斗开始）。
- 每回合 append：`{role:'user', content: 轮到X + 面板}` → assistant 决策（含工具往返）→ tool 结果。
- 查询工具结果**保留进历史**（决策 3），但查询返回的是数据而非 Command（见 2.3）。
- **回合压缩不做**（决策：持久战斗不会拖太久，会话膨胀可接受）。

### 2.2 工具集（增删查改汇总）

`AGENT_TOOL_MAP['combat_v3']`（agent-tools.ts:602）从 10 个调整为 **11 个**：

| 工具                  | 动作              | 说明                                               |
| --------------------- | ----------------- | -------------------------------------------------- |
| `declare_attack`      | 保留              | 声明攻击/技能，一次=一个 Command（占攻击槽）       |
| `declare_action`      | 保留              | 战术动作：道具/移动/专注/防御/格挡（占动作槽）     |
| `pass_slot`           | 保留              | 显式放弃槽位                                       |
| `flee`                | 保留              | 逃跑，占双槽                                       |
| `submit_adjudication` | **保留+补执行端** | 见 2.4                                             |
| `write_summary`       | **改造**          | 持久会话下不再返回占位 Choose，改为终局真·消息收集 |
| `get_combat_state`    | 保留              | 查询战斗快照（$combat.getState）                   |
| `get_character`       | **必改**          | 加 `skills` + 装备字段                             |
| `get_inventory`       | 保留              | 查背包（战术动作用道具）                           |
| `get_hp_percent`      | **删除**          | 面板已有 HP%，冗余                                 |
| `get_unit_detail`     | **新增**          | 当前单位五维+技能+装备一把抓                       |

**命令类 vs 查询类分流（决策 3C，问题 2 修复）**：

- `toolCallToCommand`（coordinator.ts:492）只翻译**命令类**（6 个）→ Command。
- **查询类**（4 个）不走 `toolCallToCommand`：由新的 `executeCombatQuery(name, args, session)` 处理，返回数据给模型，**不产 Command**，`lastCommandFromResult` 只认命令类工具结果。
- 当前 `get_*` 全部落到 `default → nextPassCommand` 的静默 pass 是 bug，必须消除（查询=数据，命令=Command，两者永不混淆）。

### 2.3 工具链规范流程（决策 3A，system prompt 教 AI 怎么走）

每回合固定流程（写进 system prompt）：

1. **读面板**：user 消息自带 `{战况总览}`（projection-agent）→ 确认当前单位/资源/状态/序列
2. **查当前单位详情**：`get_unit_detail`（或复用 get_character 拿技能列表）——技能列表**开局已注入**，中途技能不变，可只查一次
3. **决策攻击槽**：`declare_attack`（含目标/技能/意图层级）或 `pass_slot(attack)`
4. **决策动作槽**：`declare_action` / `pass_slot(action)` / `flee`
5. **终局**：`write_summary` 收集战斗摘要

### 2.4 submit_adjudication 补执行端

**现状**：schema 有（agent-tools.ts:522），`toolCallToCommandSync` 无 case → 落 `default` 变 pass。

**改造**：`toolCallToCommandSync` 加 `case 'submit_adjudication'` → 返回 `{kind:'Adjudicate', payload:{ requestId, adjudication: { effectDescription, divinity, verifiableBounds, requestedRuleOverride, reason } }}`。内核 `evaluateAdjudication`（adjudication.ts:48）与 `routeAdjudication`（coordinator.ts:420）已就绪，直接接通。

> 门槛提醒：divinity ≥ 5（法则级）才通过，普通战斗不会触发，不影响常规决策。

### 2.5 结算演绎（决策：数字即时 + AI 叙事补上）

**目标**：玩家同时看到数值与叙事演绎，无等待空洞。

```
💬 AI 声明演绎（随 declare_attack 的 assistant content 一起产出）
📋 Code 结算卡片（内核算完【立即】弹出）
✍️ AI 结算演绎（拿结算事实串写一句结果句，流式流入）
```

**实现**：

- `routeEnemyCommand` 返回值扩为 `{ command, narration }`。
  - `narration`（声明演绎）= assistant `content`（agent-client.ts:240 已支持 content + tool_calls 并存，零额外往返）。
  - `narration` 投进 `combatLog` 渲染；`command` 照旧进内核。
- **结算演绎 = 每次行动多一次独立短调用**：内核算完 → 把结算事实串（命中/评级/伤害/状态）喂给同一持久会话 → AI 写一句结果句 → 流式进 `combatLog`（卡片已先显示数字，叙事随后补上）。
- 事实串由 coordinator 从 DomainEvent 汇总（AttackResolved/DamageApplied），形状对齐 v3_action 卡片。

### 2.6 战斗数据落库（终局 Code 覆写回写）

**现状（重要发现）**：v3 战斗全程纯内存（`openCombat` 是内存 session），终局 `toPatches`（coordinator.ts:735）**只落 FP**，HP/MP/SP/状态不落库 → 战斗打完角色伤势不持久化。

**定案：方案 1 —— 终局 Code 覆写回写**：

- 终局时 coordinator 持有最终 `CombatState`，遍历 `units`，按 `characterId` 匹配存档角色，用 StateManager 覆写 hp/mp/sp/statusEffects。
- 走 `commitChatState`（ADR-21 唯一写入口，不另开通道）。
- 战斗结束后 `advanceTurn()` 本就打 turn 快照 → 回写后立刻打，战斗后状态天然可回退。
- **召唤物**（无对应存档角色）按 characterId 匹配不到 → **跳过**，不硬造角色。
- 明确否决方案 2（summary 里 AI 报 HP 交给 vars_update）：HP 是账务字段，数据字典铁律③ AI 填叙事字段、Code 补账务字段——过 AI 的手会引入编造/记漏。

### 2.7 system prompt 补全（决策 6）

**现状**：coordinator.ts:479 硬编码 125 字 system，`agent-config.json` 的 `combat_v3.systemPrompt`（348 字）被盖掉从未生效。

**改造**：

- coordinator 改为从 `configs` 读 combat_v3 的 systemPrompt（照 char_gen/item_gen 读 configs 的先例），删硬编码。
- `data/defaults/agent-config.json` 的 `combat_v3.systemPrompt` 替换为 **§2.7.1 持久会话适配版全文**。

#### 2.7.1 systemPrompt 全文（持久会话适配版，待写入 agent-config.json）

> 关键设计差异：本 Agent 是**持久会话**而非 one-shot —— system 只发一次、AI 有全程记忆，
> 所以 prompt 按**时间线分章**（开局 → 回合内 → 大方向 → 结束），像操作手册按章节排，
> 而不是堆一坨每条调用都重读的规则。大方向章节对齐世界书战斗协议（uid 435）的六阶段。

```text
你是《命定之诗》战斗决策 Agent。你在一场持续整个战斗的对话中工作：
开局、每个行动点、终局都会轮到你的回合。内核（代码）主持整场战斗
（状态机/骰子/伤害/生死/战意/终局由内核真实计算），你在被叫到的
每个决策点做战术决策并输出战斗演绎。你有全程记忆，记得每回合发生过什么。

═══════════════════════════════════
一、开局（战斗刚建立时）
═══════════════════════════════════
· 你收到 user 消息里的 <action_info> 战况总览，内含：
  回合数、战斗类型、全部参战单位的 HP/MP/SP/攻/动/状态/战意/行动序列
· 首次被叫到（敌方第一个单位行动）：
  1. 先通读战况总览，确认敌我阵容、当前行动单位、序列顺序
  2. 若当前单位技能/装备信息不全 → 调 get_unit_detail（或 get_character）
    拿到五维、技能、装备后再决策；技能列表开局确认一次即可，中途不再重复查
  3. 从此开始，每个单位行动时都记得：这是第几回合、发生过什么

═══════════════════════════════════
二、回合内（每个行动点的固定流程）
═══════════════════════════════════
大方向（对齐战斗协议）：战况总览 → 行动顺序 → 各单位按序列行动
（攻击行动/战术动作）→ 战意判定（内核自动）→ 进入下一回合。

每个行动点（轮到某个单位）按此 SOP：
1. 读面板：user 消息自带最新 {战况总览}，确认当前单位/资源/状态/序列
2. 查详情：技能/装备信息不全才调 get_unit_detail，否则直接用
3. 决策【攻击槽】→ declare_attack（选目标/技能/意图层级），或 pass_slot(attack)
4. 决策【动作槽】→ declare_action（道具/移动/专注/防御/格挡），或 pass_slot(action)、flee
5. 演绎：随每个命令的 assistant 正文输出 1-3 句战斗演绎（声明演绎）

【槽位机制】（对齐战斗协议：每单位每回合 1[攻击]1[动作]）
· 攻击/技能 → 占攻击槽；移动/防御/专注/道具/格挡 → 占动作槽；逃跑 → 占双槽

【意图层级】非致死 < 常规 < 战术 < 机能 < 核心 < 抹杀 < 概念 < 处决
· 常规及以下无需判定；战术及以上需内核对抗检定；目标动摇/崩溃可处决（自动成功）

【目标选择】① 优先低 HP（收割）② 优先高威胁（输出/治疗/控场）③ 克制关系 ④ 保命优先

═══════════════════════════════════
三、大方向（贯穿整场的原则）
═══════════════════════════════════
· 战斗类型（标准/死斗等）决定战意阈值与终局条件——由内核判定，你不判
· 战意判定（敌人 HP 跌破阈值）由内核自动触发，你不主动判断
· 你不是裁判：禁止判断胜负、禁止编造结算、禁止传骰值/伤害/HP
· 有全程记忆：上一回合打残了谁、谁用过什么技能，决策时要利用

═══════════════════════════════════
四、结束战斗
═══════════════════════════════════
· 终局由内核判定（一方全灭/逃跑/战意崩溃/法则终局），你不得调战斗结束
· 内核结算完后，你收到战斗结果 → 调 write_summary 写 ≤500 字战斗摘要
· 摘要按战况总览口径：双方损失、关键转折、结果——供回注正文

═══════════════════════════════════
五、演绎契约
═══════════════════════════════════
· 声明动作时：assistant 正文写 1-3 句战斗演绎，与命令工具同时输出
· 结算后：内核给你结算事实串，你写一句结果句（命中/伤害/受击反应）
· 叙事禁止数值术语（"攻击力+15""HP-26"）；数字由 Code 卡片展示，叙事不重复数字
```

---

## 三、前端侧设计（`src/ui/`）

### 3.1 CombatPanel 重写 v3（决策 A = A2，原生吃 v3 形状）

**现状矛盾**：`CombatPanel.vue:12-17` 读 v2 `activeCombat.participants`（`CombatParticipant[]`），v3 写 `v3ActiveCombat`（`units` 字典 + `initiativeOrder`）。

**改造**：

- `CombatPanel` / `CombatHeader` / `CombatUnitCard` / `CombatActionBar` 改读 `v3ActiveCombat`。
- 新增 `v3_units_snapshot` 事件：把单位字典整体填进 store（当前 `v3_combat_started` 的 `units:{}` 是空的，后续事件也不填——面板弹出来也是空的，必须补）。
- `game-store.ts` 的 `v3_combat_started` 分支填充 `units` 字典（从事件载荷或开战 bundle）。

### 3.2 玩家输入（🎭 2026-08-12 主持人/DM 模式改造：统一 AI 解析意图）

**现状（T14 已实施）**：`CombatActionBar.vue` 四步拼装直接产结构化 Command → `submitCombatCommand` → 内核；自由文本走 `parsePlayerInput` 规则解析。**两条路都不经过 AI**。

**🎭 主持人模式改造（2026-08-12，设计纠偏）**：`combat_v3` 的定位从「敌方专属决策器」改为**战斗主持人（DM）**——同一持久会话贯穿全场，玩家轮次收到【玩家意图】文本后分析理解并调 `declare_*` 工具替玩家声明动作，敌方轮次扮演敌方决策。

- 拼装产出**自然语言意图文本**（如「我方艾萨使用技能火焰术攻击骷髅兵」）→ `submitCombatIntent`；自由文本原样提交。
- `routePlayerIntent`：把【玩家意图】文本 append 进主持人会话 → `chatWithTools` → 主持人调工具 → Command（内核校验执行）。
- 与敌方分支共用 `handle.messages` + `handle.client`（决策 1A）：主持人有全程记忆，记得玩家说过什么、敌方做过什么。
- 禁止把自由文本直接当 Command 喂内核（那是"查询工具被误当 Command"的同款坑）——现在由主持人理解意图，不再本地正则解析。
- 旧 Command 直连路径保留为测试/直捣兜底（`waitForCommand`），生产恒走意图桥（`waitForPlayerIntent`）。

### 3.3 单位卡片展示层级

- **外层卡片**：HP / MP / SP / 状态 / 战意（v3 `CombatUnitView` 已有，零额外拉取）。
- **详情展开**：五维 + 技能列表（`get_unit_detail` 或本地 characters 数据），点击展开。

### 3.4 战斗面板弹出修复（问题 3/4）

- 问题 3（面板不弹）：确认 `v3_combat_started` 事件链完整 emit + store 正确填充 `v3ActiveCombat`（含 units）。
- 问题 4（数据流未接）：见 3.1，面板组件整体切 v3 数据源。

### 3.5 跳过战斗 / 重开战斗

**触发**：进战斗时 `handleCombatTriggerV3`（game-pipeline.ts:1518）`openCombat` 之前 `createSnapshot('pre-combat', totalTurns)`——留档开战前状态（快照类型已存在且永不淘汰，database.ts:1354）。

**跳过战斗**（原"放弃战斗"改名）：

- 按钮文案：**跳过战斗**
- 弹窗确认：**跳过后不会获得任何经验，但玩家可以自由编写战斗过程**
- 行为：`abandonCombat()` 丢弃 session → FP 不落库（coordinator.ts:208-211 已有 abandon 路径）→ 面板关闭

**重开战斗**：

- 流程：`abandonCombat()` → `restoreSnapshot(pre-combat 快照)` → 重新触发 `combat_trigger`
- restore 后角色/对话/状态回到开战前（快照整表覆写，state-manager.ts:1422），HP 等天然一致（战斗不落库 / 或落库了也被快照覆盖）
- 弹窗确认：**重新开始本场战斗？当前战斗进度将丢弃，回到开战前状态**

---

## 四、Bug 修复清单（随实施一并交付）

| #   | 问题                                                     | 修复归属                           |
| --- | -------------------------------------------------------- | ---------------------------------- |
| 1   | 战斗 Agent 提示词缺失（125 字硬编码）                    | §2.7 迁 agent-config.json + 补全   |
| 2   | 查询工具被误当 Command（get_character → pass）           | §2.2 查询/命令分流                 |
| 3   | 战斗面板不弹出（v3_combat_started 从未 emit / units 空） | §3.4                               |
| 4   | v3 数据流未接进 CombatPanel                              | §3.1                               |
| 5   | 阵营误判（非 player 全当 enemy）                         | 已修（allies/enemies），待真机验证 |
| 6   | submit_adjudication 静默变 pass                          | §2.4 补执行端                      |
| 7   | 战斗 HP/MP/SP 不落库                                     | §2.6 终局覆写回写                  |
| 8   | get_hp_percent 冗余                                      | §2.2 删除                          |

---

## 五、实施顺序（建议）

1. **§2.7 system prompt**（无论会话模型怎么改都要补，地基）
2. **§2.2 查询/命令分流**（问题 2 根因，工具链正确性）
3. **§2.1 持久会话**（控制流重构，依赖 1/2 的提示词与工具就绪）
4. **§2.5 结算演绎**（持久会话之上的叙事增强）
5. **§2.4 submit_adjudication** + **§2.6 落库回写**（收尾正确性）
6. **§3 前端**（CombatPanel 重写 v3 + 输入改造 + 面板弹出修复）
7. **§3.5 跳过/重开战斗**（pre-combat 快照）

## 六、风险与未决

- **持久会话 token 体量**：单回合 = 面板 + 多轮工具 + 声明/结算演绎。开流式可缓解，但已定后置。
- **玩家输入解析**（§3.2）：自由文本过 AI/规则解析的边界（明确指令 vs 模糊叙事）需在 system prompt 里钉死。
- **结算演绎真实性**：事实串由 Code 汇总喂给 AI，AI 只写结果句——需防止 AI 篡改数字（system prompt 契约 + 卡片数字仍在，双保险）。
- **CombatOpened emit 链**：真机确认 `v3_combat_started` 已完整 emit（问题 3 修复验证点）。
