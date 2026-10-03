# 战斗去代码化 + 实体生成统一 实施计划（2026-10-02）

> 状态：**进行中**。Phase 1b（砍战斗外 JS 脚本）/ Phase 1c（清 scripts 字段）已完成且 8 道闸门全绿；
> **Phase 1d（entity_gen 合并 + 实体两层化）已实施（2026-10-02）**：char_gen + item_gen 硬改名合并为
> `entity_gen`、请求/输出契约统一（`<entity_gen_request>` / `<entity_result>`）、实体两层字段
> `protocolText` + `tags` 落地、解析器不再产 `modifiers/buffs/automata/divinity`；占位提示词已同步。
> Phase 2 战斗重写**进行中**（2026-10-02 起）：已完成「新增协议驱动战斗沙盒后端核心」
> （`src/core/combat/sandbox/`）、**C1-C4**（combat 流程骨架 prompt / game-pipeline 切沙盒 +
> `projection.ts` 前端兼容投影 / 终局写回含 EXP 账务 / Dexie v27 持久化 + 刷新续战）、
> **C5a 砍 v3 内核**（kernel/reducer/phases/automata/coordinator 等运行时与其全部战斗测试删除，
> 只留 `combat-damage`/`combat-turn` 纯计算与 `ui-contract`/`ui-events` UI 桥）、
> **C5b 删结构化效果字段**（实体与 AI 输出镜像的 `modifiers/buffs/automata/divinity`、
> `combat/types.ts`、`describe-modifier`/`describe-automaton`、`combat-intention`/`morale-system`、
> `effect-types.ts` 残留引用清理，UI 同步去「战斗修正/原始数据」块）。
> C6 前端换新、C7 提示词定稿待后续步骤。
> 实验分支 `exp/2026-10-02-Combat-experiments`。
> 本文把「内容采纳 v1.4.2」与「代码去代码化」两条原本纠缠的线拆开，并定下先后顺序与裁定记录。

## 0. 一句话目标

把「效果/战斗」从**代码确定性结算**翻转成 **AI 依协议文本结算、Code 只做计算器**：
砍掉全部 AI 可写脚本（战斗外 JS + 战斗内 automata），把 `char_gen`+`item_gen` 合并为通用
`entity_gen`（角色/技能/装备/道具/状态/登神，按 v1.4.2 生成规则产出**纯文本**实体），
战斗改由单一沙盒 Agent 读 v1.4.2 协议主持，Code 只在复杂计算与终局写回上出手。

## 1. 两条线，先分清楚

| 线                   | 位置                                       | 内容                                                                                   | 能否独立          |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------- |
| **内容线 A**         | 私有内容仓 `fated_poem_independent_assets` | 新增 v1.4.2「战斗/数值相关额外世界书」（**不替换**旧 uid 435/438/444/447，防回档风险） | ✅ 可先做、非破坏 |
| **代码线（引擎仓）** | `fated_poem_independent`                   | B: entity_gen 合并 / C: 战斗重写 / D: 日常检定                                         | 依赖 A 的文本真源 |

**交点只有两处**：B 用 A 的**生成规则**条目（技能装备道具生成规则 / 核心数值表 / 品质效果限定 / 状态规则）；
C 用 A 的**战斗协议**条目（战斗协议 / 概览 / 战前资源推演 / 战斗生产规则）。除此之外两条线互不阻塞。

## 2. 顺序与依赖

```
A 内容：v1.4.2 额外世界书（非破坏）
        │
        ▼
B 代码：Phase 1d  entity_gen 合并 + 实体模型两层化   ← 已完成 1b/1c
        │
        ▼
C 代码：Phase 2 战斗重写（沙盒 Agent + 协议 + 计算工具 + 写回 + 持久化）
        │
        ▼
D 代码：Phase 3 日常检定 Agent（daily_check）
```

**为什么 B 先于 C**：B 定下实体的文本形态（`protocolText` + `tags`），C 的战斗 AI 直接读这段文本；
若先做 C，C 要一边适配旧结构化效果、一边等 B 改格式，反而重复返工。A 作为纯内容前置，先落最省事。

**已知临时窗口**：B 落地后、C 落地前，战斗 v3 失去了结构化效果来源（技能/装备不再产
`modifiers/buffs/automata`），会短暂无效。这是主人「不要过渡」裁定的预期代价，实验分支可接受；
B 与 C 应连续做完，不要在这个窗口里发版。

## 3. 内容线 A：新增 v1.4.2 额外世界书

- A1. 在私有内容仓新建一本「战斗/数值相关额外世界书」，收录 v1.4.2 的 8 条 entry：
  战斗生产规则 / 状态规则 / 核心数值表 / 技能装备道具生成规则 / 品质效果限定 / 战斗协议 /
  战斗协议概览 / 战前资源推演。**旧 uid 435/438/444/447 原样保留（保持关闭），不删不改**。
- A2. 处理 ST 专属激活段：战斗协议/概览/推演三条用 `$('#chat .mes')` jQuery + EJS 判断战斗是否激活，
  本引擎跑不了。改为**由 Code 在战斗/生成会话内按需注入**（去掉 EJS 激活壳），或保留但确保不抛。
- A3. 核对跨条目引用（经验值获取规则 / 经济价格指南 / 生产制作协议 / 命定系统 / WorldPaper /
  status_current_variables）：缺的由内容仓补齐或引擎占位。
- A4. 启用面：生成规则条目给 `entity_gen`；战斗协议条目给 `combat`（及 `daily_check` 只读生成规则）。
- 验收：世界书编码门 0/0/可解析；分条内容与 v1.4.2 逐字一致。

## 4. 代码线 B：Phase 1d — entity_gen 合并

**已决裁定**

- 硬改名 `entity_gen`，**不做兼容壳 / 不做旧存档迁移**。
- entity_gen **直接产 v1.4.2 纯协议文本**，不再产 `modifiers/buffs/automata/divinity/scripts`。
- 实体模型**两层化**：新增 `protocolText?: string`（原样条目）+ `tags?: string[]`（标签原文），
  保留现有简单标量（`type/rarity/cost/cooldown/skillPower/relevantAttribute/damageType/effects/description/stats`）。
  **不为每个标签加强类型**。
- **资产生成跳过**（全新实体，待本套稳定后单独立项）。

**步骤**

- B1. `types.ts`：`Skill`/`InventoryItem`/`StatusEffect` 加 `protocolText?`+`tags?`；退役
  `modifiers/buffs/automata/divinity` 字段（Phase 2 后彻底不需要）。
- B2. 合并生成链：新 `entity-gen-agent.ts`（由 `char-gen-agent.ts`+`item-gen-chain.ts` 收敛）；
  请求面 `<entity_gen_request type="character|skill|equipment|item|status|ascension">`；
  输出面统一 `<entity_result>`，一个解析器按 type 分派；落库保留两种形状（`add_character` /
  复数 `add_item`·`add_skill`）。
- B3. 工具白名单并集 + 运行时按 `entityType` 收窄（cs 12 + item 3 = 14）。
- B4. 上游 adapter：`craft_gen` 制作产物 / 战斗召唤改调 entity_gen。
- B5. 提示词：按 `docs/reference/agent_system_prompt_guide.md` Step 2 模板骨架编写（已与主人过草案）；
  `entity_gen` 注入生成规则条目，效果一律写文本「效果名: 效果」。
- B6. 删旧 `char_gen`/`item_gen` agentId 与相关注册（placeholder/agent-list/fingerprints/UI 文案）；
  测试同步；`npm run gates` 全绿。

## 5. 代码线 C：Phase 2 — 战斗重写

**已决裁定**

- **单一 `combat` 沙盒 DM**（一个 Agent 替双方按协议算完）；砍 `combat_enemy`、双会话、可见性隔离。
- 战斗状态归 AI 会话内存；**跨刷新落 Dexie 持久化**。
- Code 只提供**只读计算工具**（`roll_dice` + 伤害/先攻/距离等纯函数）+ 终局写回。

**步骤**

- ✅ C1. 会话：v1.4.2 协议正文在战斗会话创建时注入（Code 控制激活，不走世界书 EJS）。
- ✅ C2. 砍 v3 内核（2026-10-02 C5a）：`kernel/reducer/state/dice-tape/windows/intents/rule-keys/
adjudication/agent-permissions/agent-visibility/projection-ui` + `automata/` + `coordinator`/
  `client`/`participant`/`player-input`/`summon-pool`/`types.ts` 及其全部战斗测试删除。
- ✅ C3. 计算工具：把 `combat-damage`/`combat-turn` 纯函数包成只读工具暴露给 combat Agent
  （`combat-intention`/`morale-system` 零引用，随 C5b 删除）；AI 主持流程与叙事。
- ✅ C4. 终局写回：解析 AI 的 `{战斗结算}` / `{资源总结}` 面板 → `set_hp/set_mp/set_sp/
add_status_effect/remove_status_effect`，复用 `commitDomainCommand` 与纯函数式 patch 形状。
- ✅ C5. 战斗会话 Dexie 持久化（照 Delta 会话 v26 先例）。
- ✅ C5b（2026-10-02）. 删结构化效果字段：实体（`Skill`/`InventoryItem`/`StatusEffect`/
  `CombatParticipant`）与 AI 输出镜像的 `modifiers/buffs/automata/divinity`、
  `combat/types.ts`、`describe-modifier`/`describe-automaton`、`combat-intention`/`morale-system`、
  `effect-types.ts` 残留引用 + UI「战斗修正/原始数据」展示块。
- ✅ C6（2026-10-03）. 前端：战斗面板从 `DomainEvent → CombatEvent` 投影改为**直接吃沙盒 `CombatState`**
  （`src/ui/components/game/combat/`：`CombatPanel` + 就绪/战斗中/结算三态 + 坐标轴站位 + 行动规划区 +
  中栏叙事/`<action_info>` 等宽面板）；删投影桥 `sandbox/projection.ts` 与 UI 桥 `ui-contract.ts` /
  `ui-events.ts` / `combat/index.ts`；store 暴露响应式 `combatState` + `combatReady`/`combatSettlement`/
  `combatFlow`/`combatContinue`；结算「继续」携玩家输入续写下一回合。
- ⬜ C7. 提示词：`combat` 按 agent_system_prompt_guide 模板重写（**与主人讨论后再定稿**）。
- ⬜ C8. 测试 + `npm run gates` 全绿。

## 6. 代码线 D：Phase 3 — 日常检定 Agent（daily_check）

**已决裁定**：独立 Agent、Stage 0 **无条件运行**（不受 `plotSettings.mode==='off'` 影响）；
只做**周期性/条件型效果结算**（状态到期、条件触发、环境、upkeep），**不做社交/属性检定**
（v1.4.2《品质效果限定》明文「检定只存在于战斗与生产中」）。

**步骤**

- D1. 新 Agent + Stage 0 插点（`types.ts` 管线 + orchestrator 白名单 + placeholder + UI 名单）。
- D2. 输入在场实体（CHARACTER_STATE/ACTIVE_EFFECTS/INVENTORY/GAME_TIME/MAP_CONTEXT + 时间差）；
  输出周期/条件结算的 StatePatch（走 `commitChatState`）。
- D3. 取代 `applyTimeAdvance` 中随脚本退役而空掉的状态按期结算逻辑。
- D4. 提示词 + 测试 + gates。

## 7. 裁定记录（与主人确认）

1. 战斗会话模型：单一 `combat` 沙盒 DM。
2. entity_gen 数值来源：单 Agent + 注入生成规则世界书。
3. 日常检定：独立 Agent、只做周期/条件结算。
4. 战斗跨刷新：落 Dexie 持久化。
5. 实施节奏：分阶段（砍脚本 → entity_gen → 战斗 → 日常检定）。
6. **不做兼容/过渡**：硬改名 entity_gen、不管旧存档、直接产纯文本效果。
7. 实体字段：两层（`protocolText` + `tags` + 标量），不加强类型。
8. 资产实体：本阶段跳过。
9. v1.4.2：**新增额外世界书，不替换旧条目**。

## 8. 阶段性验收（全部跑 `npm run gates`）

- Phase 1d：typecheck / vue / tools / lint / knip / test / format / build 全绿。
- Phase 2：同上；战斗相关测试按新架构重写而非保留。
- Phase 3：同上。
