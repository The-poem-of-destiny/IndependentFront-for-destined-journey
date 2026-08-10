# 战斗 Agent 会话模式改造 —— 决策调查报告（2026-08-09）

> 状态：**待主人逐条决策**（下个对话）。本报告只列现状、问题与可选方向，**不做实现**。
> 背景：真机 debug 文件 `fated-poem-debug-7c342726-1786264459319.json` 暴露战斗 Agent 提示词缺失、
> 查询工具被误当 Command、战斗面板不弹出等问题，且当前"每单位独立调用"模式与缓存/记忆设计相悖。

---

## 一、现状速览

### 1.1 当前战斗 Agent 调用模型

```
[每单位每次行动 = 一次 chatWithTools 独立调用]
  routeEnemyCommand (coordinator.ts:472)
  ├─ system: "你是战斗决策 Agent。根据战斗面板为敌方单位决定动作..."（仅 125 字）
  └─ user: "轮到敌方「X」行动。\n\n<action_info>{战况总览} HP/MP/SP/状态/序列</action_info>"
```

- **每单位决策一次调用**，无跨回合记忆（AI 只见当前 panel，不知道战局进程）
- system prompt 仅 125 字，未教：技能来源、槽位机制、意图层级、目标选择、阵营视角
- 工具调用后 `lastCommandFromResult` 取最后一个 toolCalls → Command；无 tool_call 时退化为 pass

### 1.2 已确认的问题（真机证据）

| # | 问题 | 证据 |
|---|------|------|
| 1 | **战斗 Agent 提示词缺失**（仅 125 字，AI 靠瞎猜决策） | reasoning 14812 字全是"我猜是狼人，可能用爪击" |
| 2 | **查询工具被误当 Command**（get_character 返回 pass-attack） | reasoning："returned PassAttack commands instead of character data" |
| 3 | **战斗面板不弹出**（v3_combat_started 从未 emit） | coordinator 只 emit dispatch 后事件，漏了 openCombat 的 CombatOpened |
| 4 | **v3 数据流未接进 CombatPanel**（面板读 v2 activeCombat，v3 写 v3ActiveCombat） | CombatPanel.vue:12-17 vs game-store.ts:152 |
| 5 | **阵营误判**（非 player 全当 enemy） | 已修（allies/enemies），待真机验证 |

---

## 二、待决策项（下个对话逐条定）

### 决策 1：战斗 Agent 会话模型

**现状**：每单位每次行动一次 `chatWithTools`（无记忆、无缓存、每次重建）。

**候选方案**：

- **A. 整场一个持久会话（主人提议）**
  - 一次对话贯穿整场战斗：`system` 固定 + 每回合 append（assistant 决策 / tool 结果 / user 结算）
  - AI 有全程记忆，前缀稳定 → LLM 前缀缓存命中（DeepSeek/Anthropic）
  - 需要改 coordinator 控制流：从"每单位新建 client"改成"一场一个 client + 消息累积"
  - 单次回合体量大（多轮工具+正文），需配合流式（见决策 2）
- **B. 保持每单位独立调用，但补全 system prompt**
  - 改动最小，但无跨回合记忆、缓存收益小
  - AI 仍要靠每次重灌 panel 才能知道战局

> 倾向：A。但需一并解决 B 的提示词缺失（无论 A/B 都要补全 system prompt）。

### 决策 2：是否开流式传输

**现状**：`chatWithTools` 走 `chat`（非流式，一次性等完整响应）。`agent-client` 已有 `chatStream` 能力但战斗未用。

**候选方案**：
- **A. 开流式**：正文按 token 流出，玩家能实时看到 AI 的决策/叙事；但工具调用链在流式中要逐段解析（assistant 消息分片），实现复杂
- **B. 保持非流式**：整段等完再渲染，简单可靠；持久会话模式下每回合等待时间可能较长（多轮工具 + 长正文）

> 决策点：流式是否值得为"实时感"付出解析复杂度？持久会话下非流式的等待时长能否接受？

### 决策 3：工具调用是否需要提示（给 AI 的 tool schema / 提示）

**现状**：战斗工具 schema 已定义（agent-tools.ts 6+4 个），但 coordinator 传 `tools: undefined`（已修：注入 getToolsForAgent）。**AI 不知道"何时该调哪个工具"**——system prompt 没教它"想用技能先 get_character"。

**候选方案**：
- **A. system prompt 明确工具链**：教 AI"决策前先 get_combat_state 拿当前面板 → 需要技能详情再 get_character/get_inventory → 最后 declare_attack/declare_action"
- **B. 工具结果只喂当轮、不进历史**：避免历史里出现同一角色多版本状态（前文分析过的坑）
- **C. 查询类 vs 命令类工具分开处理**：查询工具返回数据、不产生 Command；命令工具才映射到 Command（这是问题 2 的修复）

> 决策点：A/B/C 都要做还是选做？工具调用在 system prompt 里的引导程度？

### 决策 4：思维链是否暴露

**现状**：`chatWithTools` 收集 reasoning（agent-client.ts:220 `[Round N]` 前缀），但**只进 agentLog，不展示给玩家**。DebugPanel 能看到。

**候选方案**：
- **A. 完全隐藏**：思维链只进日志，玩家只看正文/决策结果
- **B. 战斗面板展示思维链**：玩家能看到 AI 的决策过程（像 COT 展示），增加透明感但打断沉浸
- **C. 摘要式展示**：面板显示"敌方决定攻击奥利雅思"这种一行决策说明，不暴露完整思维链

> 决策点：战斗是快节奏决策场景，思维链是否值得展示？还是保持 DebugPanel 可查即可？

### 决策 5：重新战斗时快照怎么回退

**现状**：战斗回退 = 重进（重新触发 combat_trigger）。存档快照（restoreSnapshot）是另一套（回合级存档，恢复后清理 createdAt 之后的分支）。

**候选方案**：
- **A. 战斗前自动打快照**：进入战斗时打一张 pre-combat 快照，玩家可回退到开战前（现状有 reason='pre-combat' 快照类型但未见实际触发）
- **B. 沿用现状**：回退走回合级快照（restoreSnapshot），战斗中途回退 = 恢复上一回合存档
- **C. 战斗内 checkpoint**：持久会话模式下，每回合存 CombatState 快照，可逐回合回退（最细粒度，实现最重）

> 决策点：持久会话模式下，战斗中途想重来（重掷骰子/换策略）应该怎么回退？逐回合 checkpoint 还是退到开战前？

### 决策 6：战斗 system prompt 内容清单（无论 1A/1B 都要补）

需要覆盖：
- 角色定位：你是"敌方单位"决策 agent；玩家控制"友方"
- 面板解读：怎么读 `{战况总览}`（回合/阵营/HP/MP/SP/攻/动/状态/战意/序列/FP）
- 每回合固定流程（主人设计）：重新获取角色资源 → 判断当前单位 → 声明动作 → 正文 → 停止符
- 槽位机制：每单位每回合 = 攻击槽 + 动作槽（攻击/技能占攻击，移动/防御/专注/道具/格挡占动作）
- 意图层级：非致死/常规/战术/机能/核心/抹杀/概念/处决 语义
- 目标选择策略：优先低 HP、高威胁、克制关系
- 工具说明：查询类（读数据）+ 命令类（一个=一个 Command）

---

## 三、决策之间的耦合关系

```
决策 1（会话模型 A/B）决定 coordiator 控制流
  ├─ 决策 1=A → 决策 2（流式）几乎必做（单回合体量大）
  ├─ 决策 1=A → 决策 3C（查询 vs 命令分流）必做（否则查询工具结果会污染历史）
  ├─ 决策 1=A → 决策 5C（逐回合 checkpoint）有天然落点（CombatState 每回合可存）
  └─ 决策 6（system prompt）无论 1A/1B 都必做
决策 4（思维链）独立，不依赖 1/2/3
```

建议决策顺序：**1 → 6 → 3 → 2 → 5 → 4**（先定会话骨架，再补提示词与工具链，再定流式/快照/思维链）。

---

## 四、附：问题修复清单（决策后一并实施）

| # | 问题 | 状态 |
|---|------|------|
| 1 | 战斗 Agent 提示词缺失 | 待决策 1+6 |
| 2 | 查询工具被误当 Command | 待决策 3C |
| 3 | 战斗面板不弹出（CombatOpened 未 emit） | 待修（纯 bug，不依赖决策） |
| 4 | v3 数据流未接进 CombatPanel | 待修（与决策 1 相关） |
| 5 | 阵营误判（allies/enemies） | 已修，待真机验证 |
