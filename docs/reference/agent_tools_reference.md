# Agent 工具参考手册

> 本文档列出《命定之诗》独立前端中每个 Agent 持有的全部工具（$ API 可见性、Zone 数据可见性、XML 标记协议、输出能力）。

---

## 目录

1. [系统概览](#系统概览)
2. [Agent 清单](#agent-清单)
   - [memory_recall — 记忆召回](#1-memory_recall--记忆召回)
   - [plot_pre_check — 剧情触发检查](#2-plot_pre_check--剧情触发检查)
   - [story — 正文 AI](#3-story--正文-ai)
   - [vars_update — 变量更新](#4-vars_update--变量更新)
   - [char_update — 角色更新](#5-char_update--角色更新)
   - [memory_summary — 记忆总结](#6-memory_summary--记忆总结)
   - [plot_post_check — 剧情修正](#7-plot_post_check--剧情修正)
   - [plot_outline — 大纲生成](#8-plot_outline--大纲生成)
   - [craft_gen — 制作效果生成](#9-craft_gen--制作效果生成)
   - [char_gen — 角色生成](#10-char_gen--角色生成)
   - [item_gen — 物品生成](#11-item_gen--物品生成)
3. [$ API 命名空间参考](#-api-命名空间参考)
4. [Zone 可见性矩阵](#zone-可见性矩阵)
5. [XML 标记协议](#xml-标记协议)
6. [脚本沙盒工具](#脚本沙盒工具)

---

## 系统概览

### 管线架构

```
Stage 0: memory_recall  +  plot_pre_check    (并行)
           ↓                    ↓
Stage 1:         story                        (依赖 Stage 0)
                    ↓
Stage 2:         vars_update                  (依赖 Stage 1)
                    ↓
Stage 3:         char_update                  (依赖 Stage 1 + 2)
                    ↓
Stage 4:         memory_summary               (依赖 Stage 1)
                    ↓
Stage 5:         plot_post_check              (依赖 Stage 1 + 4)
```

### 工具分层

```
Layer 5  脚本级  $event.on/off  $call  @parent  init/cleanup     ← AI 可编程
Layer 4  语义级  $combat  $craft  $status  $var                   ← AI 可见
Layer 3  流程级  CombatResolver / CraftResolver                   ← 引擎内部
Layer 2  计算级  $dice  $resource  $char  $time  $validate        ← AI 只读/只读
Layer 1  原语级  StateManager.commitChatState()                   ← 仅引擎
```

### 关键设计决策 (ADR-11)

| 层 | 职责 | 示例 |
|----|------|------|
| **Code** | 确定性逻辑 | 战斗公式、制作DC、骰池、数值约束 |
| **Prompt** | 创造性逻辑 | 叙事、角色性格、记忆判断、剧情走向 |

---

## Agent 清单

### 1. memory_recall — 记忆召回

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 0 |
| **触发方式** | 每轮自动 |
| **执行模式** | 并行 (与 plot_pre_check) |
| **职责** | 从记忆库中筛选与用户输入最相关的记忆条目 |
| **LLM/Embedding** | 如果模型名含 `embedding` → 走向量 Embedding API 余弦相似度召回；否则走 LLM JSON 输出 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$char` | ❌ 不可见 | 不需要角色数据 |
| `$combat` | ❌ 不可见 | |
| `$craft` | ❌ 不可见 | |
| `$dice` | ❌ 不可见 | |
| `$resource` | ❌ 不可见 | |
| `$status` | ❌ 不可见 | |
| `$time` | ❌ 不可见 | |
| `$var` | ❌ 不可见 | |
| `$validate` | ❌ 不可见 | |

> **说明**: memory_recall 是纯信息检索 Agent，不参与游戏状态操作。它只有一个任务：筛选记忆。

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | **FULL** | 完整记忆库（正文 + 暗线 + 关键词 + 重要度） |
| npc | KEYS | 角色 ID/名称/种族/类型/Tier/位置（仅索引） |
| world | KEYS | 时间 + 位置 |
| quest | KEYS | 事件 ID/标题/状态（仅索引） |
| craft | NONE | - |
| combat | NONE | - |
| outline | NONE | - |
| variable | NONE | - |

#### 输出格式

```json
{"memories": [{"id": "MEM000001", "relevance": 0.95, "reason": "匹配原因"}]}
```

---

### 2. plot_pre_check — 剧情触发检查

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 0 |
| **触发方式** | 每轮自动 |
| **执行模式** | 并行 (与 memory_recall) |
| **职责** | 正文生成前，判断需要触发哪些剧情事件 + 需要注入哪些剧情背景信息 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$char` | ❌ | 通过 Zone 数据间接获得角色信息 |
| `$combat` | ❌ | |
| `$craft` | ❌ | |
| `$dice` | ❌ | |
| `$resource` | ❌ | |
| `$status` | ❌ | |
| `$time` | ❌ | |
| `$var` | ❌ | |
| `$validate` | ❌ | |

> **说明**: plot_pre_check 是纯分析 Agent，只读剧情大纲和事件状态，不做状态变更。

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | SUMMARY | 记忆摘要（前10条，200字预览，不含暗线） |
| npc | **FULL** | 完整角色数据（含五维/装备/技能/状态效果） |
| world | **FULL** | 世界状态（时间/位置/天气/季节） |
| quest | **FULL** | 全部剧情事件（含 pending/active，触发条件可见） |
| craft | NONE | - |
| combat | NONE | - |
| outline | **FULL** | 完整剧情大纲 |
| variable | KEYS | 变量名称列表 |

#### 输出格式

```json
{
  "triggeredEvents": [{"id": "事件ID", "reason": "触发原因"}],
  "relevantBackground": "需要注入到正文 prompt 的剧情背景信息摘要",
  "outlineRelevance": "当前大纲相关段落引用"
}
```

---

### 3. story — 正文 AI

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 1 |
| **触发方式** | 每轮自动 |
| **执行模式** | 串行（等 Stage 0 完成） |
| **职责** | 核心叙事引擎 — 生成剧情正文、选项、总结、变量变更 |
| **特殊能力** | **可使用 XML 标记协议**：`<craft_request>` / `<combat_trigger>` / `<char_detect>` |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$combat` | ✅ 可见 | 战斗流程 API（attack/defend/useSkill/useItem/flee/getState） |
| `$craft` | ✅ 可见 | 制作流程 API（startProject/check/getBaseDC/getExpTable） |
| `$status` | ✅ 可见 | 状态效果管理（add/remove/setStacks/getStacks） |
| `$dice` | ✅ 可读 | 骰池系统（d20/d100/roll） |
| `$char` | ✅ 只读 | 角色查询（getChar/getChars/getPlayer/getNpcs） |
| `$var` | ✅ 可见 | 变量读写 |
| `$time` | ✅ 可读 | 时间查询（getCurrentTime/formatTime/advance） |
| `$resource` | ✅ 只读 | 资源查询（getHpPercent/getMpPercent/getSpPercent/isAlive） |
| `$validate` | ❌ 不可见 | 引擎内部 |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | SUMMARY | 记忆摘要（前10条，200字正文预览） |
| npc | **NARRATIVE** | 角色叙事视图（剥离装备数值/技能消耗/冷却/CD，保留效果描述） |
| world | **FULL** | 完整世界状态 |
| quest | SUMMARY | 仅 active 事件 + 目标摘要 |
| craft | SUMMARY | 进行中/已完成制作项目 |
| combat | **FULL** | 完整战斗状态 |
| outline | SUMMARY | 当前章节标题 + 目标（~100字） |
| variable | NONE | - |

#### XML 标记能力

| 标记 | 类型 | 说明 |
|------|------|------|
| `<craft_request industry="锻造" productName="长剑">body</craft_request>` | 🛑 阻塞型 | 触发制作流程，叙事暂停等待制作结果 |
| `<combat_trigger combatType="标准" environment="密林深处">body</combat_trigger>` | 🚩 独立型 | 触发战斗，Stage 2 后打开独立战斗页 |
| `<char_detect characterName="艾琳" characterType="npc">body</char_detect>` | 👤 隐式型 | 标记新角色出现，Stage 2 异步生成角色数据 |

#### 输出格式

```xml
<thinking>思考过程（可选，不展示给玩家）</thinking>
<maintext>剧情正文（200-500字，第二人称"你"）</maintext>
<option>选项A
选项B
选项C</option>
<sum>本回合一句话总结</sum>
<vars>{"字段": 值}</vars>
```

#### 叙事约束

- ❌ 禁止精确数值（"攻击力+15"、"消耗15SP"、"恢复20HP"、"好感度+5"）
- ✅ 自然语言描述效果（"锋利的剑刃划破空气"、"药水的暖流蔓延全身"）

---

### 4. vars_update — 变量更新

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 2 |
| **触发方式** | 每轮自动 |
| **执行模式** | 串行（等 Story 完成） |
| **职责** | 从正文中提取结构化变量变更（位置/金钱/物品/时间流逝等） |
| **输入依赖** | `story` Agent 的输出（`ctx.agentOutputs.get('story')`） |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$var` | ✅ 可见 | 变量读写（核心工具） |
| `$time` | ❌ | 通过输出 `delta_time` 间接推进时间 |
| 其余全部 | ❌ | vars_update 是纯数据提取 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | KEYS | 角色 ID/名称/种族/类型/Tier/位置 |
| world | **FULL** | 完整世界状态（用于位置路径验证） |
| quest | NONE | - |
| craft | KEYS | 制作项目索引 |
| combat | KEYS | 活跃战斗索引 |
| outline | NONE | - |
| variable | **FULL** | 全部自由变量（sys + user） |

#### 变量操作类型

| 操作 | 字段 | 说明 |
|------|------|------|
| `replace` | `{"path": "变量名", "value": 新值}` | 设置新值 |
| `delta` | `{"path": "变量名", "amount": +10}` | 数值增减 |
| `insert` | `{"path": "数组变量名", "value": 新元素, "index": 可选}` | 数组插入 |
| `delta_time` | `{"delta_time": 180}` | 时间推进（分钟） |

#### 输出格式

```json
{
  "replace": [{"path": "位置", "value": "北方-诺斯加德-白曜城-铁匠铺"}],
  "delta": [{"path": "金钱", "amount": -50}],
  "insert": [{"path": "背包", "value": {"name": "铁剑", "quantity": 1}}],
  "delta_time": 60
}
```

#### 特殊行为

- 如果输出包含 `delta_time`，引擎会在本阶段自动调用 `StateManager.applyTimeAdvance()` 推进游戏时间

---

### 5. char_update — 角色更新

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 3 |
| **触发方式** | 每轮自动 |
| **执行模式** | 并行（每角色一个 call，`targetCharacterId` 区分） |
| **职责** | 从正文中提取角色状态变化（HP/MP/SP/状态效果/装备/技能/位置） |
| **输入依赖** | `story` + `vars_update` 的输出 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$char` | ✅ 只读 | 查询角色当前状态 |
| `$resource` | ✅ 只读 | 资源百分比查询 |
| `$status` | ✅ 可见 | 状态效果变更 |
| 其余 | ❌ | char_update 是状态提取 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | **FULL (目标角色)** | 目标角色的完整数据（per-call 过滤） |
| world | **FULL** | 完整世界状态 |
| quest | NONE | - |
| craft | KEYS | 制作项目索引 |
| combat | **FULL** | 完整战斗状态（含参战方 HP） |
| outline | NONE | - |
| variable | NONE | - |

#### 输出格式

```json
{
  "characters": [
    {
      "id": "角色ID",
      "changes": {
        "hp": 80,
        "mp": 45,
        "statusEffects": [...]
      }
    }
  ]
}
```

---

### 6. memory_summary — 记忆总结

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 4 |
| **触发方式** | 每轮自动 |
| **执行模式** | 串行（等 Story 完成） |
| **职责** | 将本回合重要事件总结为结构化记忆（正文≥200字 + 暗线 + 关键词 + 重要度） |
| **输入依赖** | `story` 的输出 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$time` | ❌ | 通过上下文获取游戏时间 |
| 其余全部 | ❌ | memory_summary 是纯文本处理 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | SUMMARY | 已有记忆摘要（前10条） |
| npc | KEYS | 角色索引 |
| world | SUMMARY | 世界状态摘要 |
| quest | KEYS | 事件索引 |
| craft | NONE | - |
| combat | KEYS | 活跃战斗索引 |
| outline | NONE | - |
| variable | NONE | - |

#### 重要度评分

| 分数 | 场景 |
|------|------|
| 1-3 | 日常对话、闲逛 |
| 4-6 | 有信息量的互动、物品获取 |
| 7-8 | 战斗、重要剧情推进 |
| 9-10 | 重大转折、角色死亡、世界线变动 |

#### 输出格式

```json
{
  "content": "正文内容（≥200字）",
  "hiddenLine": "暗线内容",
  "keywords": ["关键词1", "关键词2"],
  "importance": 6,
  "timeRangeStart": "光辉纪元001年-05月-24日-15:30",
  "timeRangeEnd": "光辉纪元001年-05月-24日-16:00"
}
```

---

### 7. plot_post_check — 剧情修正

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 5 |
| **触发方式** | 每轮自动 |
| **执行模式** | 串行（等 Story + memory_summary 完成） |
| **职责** | 分析正文后的世界线变动、修正大纲、更新事件状态、生成子事件 |
| **输入依赖** | `story` + `memory_summary` 的输出 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| 全部 | ❌ | plot_post_check 是纯分析 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | SUMMARY | 记忆摘要 |
| npc | SUMMARY | 角色摘要（不含五维/装备详情） |
| world | **FULL** | 完整世界状态 |
| quest | **FULL** | 全部剧情事件 |
| craft | NONE | - |
| combat | SUMMARY | 战斗状态摘要 |
| outline | **FULL** | 完整剧情大纲 |
| variable | NONE | - |

#### 世界线变动等级

| 等级 | 说明 |
|------|------|
| `minor` | 小范围调整（任务完成方式不同） |
| `moderate` | 中等影响（角色立场改变） |
| `major` | 重大转折（主要角色死亡、阵营变更） |

#### 输出格式

```json
{
  "worldLineChanged": false,
  "changeLevel": "none|minor|moderate|major",
  "outlineChanges": {
    "action": "none|update|addChapter|removeChapter",
    "changes": "大纲修改内容"
  },
  "eventUpdates": [{
    "id": "事件ID",
    "action": "update|addChild|skip|fail|complete",
    "changes": {"status": "新状态", "description": "更新后的描述"}
  }],
  "newChildEvents": [{
    "title": "子事件标题",
    "description": "描述",
    "triggerCondition": "触发条件",
    "depth": 1
  }]
}
```

---

### 8. plot_outline — 大纲生成

| 属性 | 值 |
|------|-----|
| **管线阶段** | 按需（不在默认管线中） |
| **触发方式** | 用户手动触发 / 新游戏开始时生成 |
| **执行模式** | 独立 |
| **职责** | 根据剧情配置、世界观设定和角色信息生成完整剧情大纲 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| 全部 | ❌ | plot_outline 是纯创意生成 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | **FULL** | 完整角色数据 |
| world | **FULL** | 完整世界状态 |
| quest | KEYS | 事件索引 |
| craft | NONE | - |
| combat | NONE | - |
| outline | **FULL** | 大纲（用于更新） |
| variable | NONE | - |

#### 输出格式

```json
{
  "content": "完整的大纲文本（Markdown格式，含章节标题和叙述）",
  "chapters": [{
    "title": "章节标题",
    "summary": "章节摘要",
    "keyEvents": ["关键事件1", "关键事件2"],
    "estimatedDuration": "预计持续的游戏时间"
  }],
  "selfCritique": {
    "score": 8,
    "strengths": ["优点1"],
    "weaknesses": ["不足1"],
    "suggestions": ["改进建议1"]
  }
}
```

---

### 9. craft_gen — 制作效果生成

| 属性 | 值 |
|------|-----|
| **管线阶段** | 按需（Story 阻塞调用） |
| **触发方式** | Story 输出中检测到 `<craft_request>` 标记 |
| **执行模式** | 🛑 阻塞型 — Story 暂停 → Craft Agent → 结果注入正文 → Story 继续 |
| **职责** | 判断制作难度、生成创意效果词条、生成制作叙事片段、提取 $craft API 参数 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$craft` | ✅ 可见 | 制作流程 API（核心工具） |
| `$dice` | ✅ 可读 | 骰池系统 |
| `$char` | ✅ 只读 | 查询制作者属性 |
| `$resource` | ✅ 只读 | 资源查询 |
| `$validate` | ❌ | |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | SUMMARY | 角色摘要（制作者信息） |
| world | **FULL** | 世界状态（地点/工具/设施） |
| quest | NONE | - |
| craft | **FULL** | 制作项目状态 |
| combat | NONE | - |
| outline | NONE | - |
| variable | KEYS | 变量索引 |

#### 输出格式

```json
{
  "difficultyJudgment": {
    "dcModifier": 0,
    "reasoning": "判定理由"
  },
  "creativeEffects": [
    {"name": "词条名", "description": "效果描述", "type": "增益|减益|特殊"}
  ],
  "effectDeclarations": ["攻击力: +50, DR: 5%"],
  "narrativeFlavor": "制作过程的叙事描述（注入回正文）",
  "craftToolCall": {
    "industry": "锻造|炼金|烹饪|裁缝",
    "productName": "制品名称",
    "targetQuality": "普通|优良|稀有|史诗|传说|神话|唯一",
    "quantity": 1,
    "materials": ["材料1", "材料2"]
  }
}
```

#### 分工边界 (ADR-11)

| craft_gen (AI) | Code 层 |
|----------------|---------|
| 难度判定 + DC 修正建议 | DC 基础值计算 (craft-dc.ts) |
| 创意效果词条 | 骰检掷骰 (骰池系统) |
| 制作叙事片段 | 品质继承/降级 (craft-quality.ts) |
| 提取 $craft API 参数 | 经验/FP 计算 (公式) |

---

### 10. char_gen — 角色生成

| 属性 | 值 |
|------|-----|
| **管线阶段** | Stage 2 后按需 |
| **触发方式** | vars_update 扫描到 `<char_detect>` 标记 |
| **执行模式** | 👤 异步链式 — char_gen → item_gen |
| **职责** | 为叙事中新出现的 NPC/怪物/召唤物生成完整角色数据 |
| **输入依赖** | `story` 输出中的 `<char_detect>` 标记 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$char` | ✅ 只读 | 查重（已有角色列表） |
| 其余 | ❌ | char_gen 是纯创意生成 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | KEYS | 已有角色索引（用于重名检查） |
| world | **FULL** | 世界状态（种族/势力/区域匹配） |
| quest | NONE | - |
| craft | NONE | - |
| combat | NONE | - |
| outline | NONE | - |
| variable | SUMMARY | 世界观变量 |

#### 输出格式

```json
{
  "name": "角色名",
  "race": "种族（23血脉之一）",
  "tier": 1,
  "level": 3,
  "attributes": {"str": 6, "dex": 5, "con": 5, "int": 4, "spi": 5},
  "identity": ["身份标签"],
  "occupation": ["职业标签"],
  "background": "背景故事（100-200字）",
  "appearance": "外貌描述（50-100字）",
  "personality": "性格描述（wOaGz编码）",
  "ascension": {
    "enabled": false,
    "path": "",
    "description": ""
  }
}
```

#### 生成规则

- 名字必须与已有角色无冲突
- Tier 匹配: 普通 NPC→T1, 精英→T2, Boss→T3-4, 传说→T5+
- T1 五维范围 3-8，总和不超过 25
- 登神长阶仅 Lv.13+ 开启

---

### 11. item_gen — 物品生成

| 属性 | 值 |
|------|-----|
| **管线阶段** | char_gen 后链接调用 |
| **触发方式** | char_gen 完成后自动触发（仅1次，ADR-26） |
| **执行模式** | 🔗 链式 — char_gen 输出 → item_gen 输入 |
| **职责** | 为已生成的角色创建合适档次的技能、装备和背包物品 |
| **输入依赖** | `char_gen` 的输出 |

#### $ API 可见性

| Namespace | 可见性 | 说明 |
|-----------|--------|------|
| `$char` | ✅ 只读 | 查重已有物品 |
| 其余 | ❌ | item_gen 是纯创意生成 Agent |

#### Zone 数据可见性

| Zone | 可见性 | 内容 |
|------|--------|------|
| memory | NONE | - |
| npc | KEYS | 角色索引 |
| world | **FULL** | 世界状态 |
| quest | NONE | - |
| craft | NONE | - |
| combat | NONE | - |
| outline | NONE | - |
| variable | KEYS | 变量索引 |

#### 输出格式

```json
{
  "skills": [{
    "name": "技能名",
    "description": "效果描述",
    "type": "active|passive",
    "cost": {"type": "MP", "amount": 10},
    "cooldown": 2
  }],
  "equipment": [{
    "slot": "武器",
    "name": "装备名",
    "description": "描述",
    "stats": {"攻击力": 15},
    "durability": 100,
    "quality": "普通"
  }],
  "inventory": [{
    "name": "物品名",
    "description": "描述",
    "quantity": 1,
    "type": "消耗品|材料|任务物品",
    "rarity": "普通"
  }]
}
```

#### Tier-品质匹配

| Tier | 品质范围 | 技能 | 装备 |
|------|----------|------|------|
| T1 | 普通/优良 | 1-2 基础 | 1-2 件普通 |
| T2-3 | 稀有/史诗 | 2-3 技能 | 2-3 件 |
| T4-5 | 传说 | 完整技能树 | 传说装备 |
| T6-7 | 神话 | 完整+登神 | 神话装备 |

---

## $ API 命名空间参考

### 总览

| Namespace | Agent 可见 | 用途 | 实现模块 |
|-----------|-----------|------|----------|
| `$combat` | ✅ 全可见 | 战斗流程 | `combat-resolver.ts` |
| `$craft` | ✅ 全可见 | 制作流程 | `craft-resolver.ts` |
| `$status` | ✅ 全可见 | 状态效果 | `effect-runtime.ts` |
| `$dice` | ✅ 全可见 | 骰池系统 | `dice.ts` |
| `$char` | ✅ 只读 | 角色查询 | `char-query.ts` |
| `$var` | ✅ 全可见 | 变量读写 | `var-resolver.ts` |
| `$time` | ✅ 全可见 | 时间查询 | `time-system.ts` |
| `$resource` | ✅ 只读 | 资源查询 | `resource-calc.ts` |
| `$validate` | ❌ 引擎内 | 数值约束 | `validate.ts` |

### $combat API

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `$combat.attack()` | `{combat, attackerId, defenderId, userInput?, action?, skillId?, itemId?, intentionKeywords?}` | `CombatActionResult` | 执行单次攻击（完整8步伤害管线） |
| `$combat.defend()` | `{combat, characterId}` | `CombatActionResult` | 防御动作 |
| `$combat.useSkill()` | `{combat, attackerId, defenderId, skillId, skillName}` | `CombatActionResult` | 使用技能 |
| `$combat.useItem()` | `{combat, characterId, itemId}` | `CombatActionResult` | 使用道具 |
| `$combat.flee()` | `{combat, characterId}` | `CombatActionResult` | 逃跑 |
| `$combat.getState()` | `{combat}` | `CombatState` | 获取当前战斗状态 |
| `$combat.initCombat()` | `{participants, combatType, environment}` | `CombatState` | 初始化战斗 |
| `$combat.endCombat()` | `{combat, winner}` | `CombatSummaryResult` | 结束战斗 |

### $craft API

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `$craft.startProject()` | `{characterId, industry, stage, productName, targetQuality, quantity, materials, ...}` | `CraftActionResult` | 执行完整制作项目（3阶段管线） |
| `$craft.check()` | `{characterId, industry, targetQuality, materials, ...}` | `CraftCheckResult` | 仅执行检定 |
| `$craft.getBaseDC()` | `{quality}` | `number` | 查询品质基准 DC |
| `$craft.getExpTable()` | `{quality}` | `number` | 查询品质经验表 |

### $dice API

| 方法 | 返回 | 说明 |
|------|------|------|
| `$dice.d20()` | `number (1-20)` | 掷 d20 |
| `$dice.d100()` | `number (1-100)` | 掷 d100 |
| `$dice.roll(formula)` | `DiceRollResult` | 解析并执行骰子公式（如 `"2d6+3"`） |
| `$dice.d20Advantage()` | `DiceRollResult` | d20 优势（取高） |
| `$dice.d20Disadvantage()` | `DiceRollResult` | d20 劣势（取低） |

### $char API

| 方法 | 返回 | 说明 |
|------|------|------|
| `$char.getChar(id)` | `CharacterState \| undefined` | 按 ID 获取角色 |
| `$char.getChars(saveId?)` | `CharacterState[]` | 获取所有角色 |
| `$char.getPlayer(saveId?)` | `CharacterState \| undefined` | 获取玩家角色 |
| `$char.getNpcs(saveId?)` | `CharacterState[]` | 获取所有 NPC |
| `$char.getTier(char)` | `number` | 获取生命层级 |
| `$char.getLevel(char)` | `number` | 获取等级 |
| `$char.getStat(char, stat)` | `number` | 获取五维属性值 |
| `$char.getLocation(char)` | `string` | 获取当前位置 |
| `$char.hasStatus(char, statusName)` | `boolean` | 检查是否有某状态效果 |
| `$char.hasItem(char, itemName)` | `boolean` | 检查是否有某物品 |

### $resource API

| 方法 | 返回 | 说明 |
|------|------|------|
| `$resource.getHpPercent(char)` | `number` | HP 百分比 (0-100) |
| `$resource.getMpPercent(char)` | `number` | MP 百分比 |
| `$resource.getSpPercent(char)` | `number` | SP 百分比 |
| `$resource.isAlive(char)` | `boolean` | 是否存活 (HP>0) |
| `$resource.isDead(char)` | `boolean` | 是否死亡 (HP≤0) |
| `$resource.isFullHp(char)` | `boolean` | HP 是否满 |
| `$resource.canAfford(char, cost)` | `boolean` | 资源是否可支付 |
| `$resource.getMaxHp(char)` | `number` | 最大 HP |

### $var API

| 方法 | 说明 |
|------|------|
| `$var.get(path)` | 读取变量值 |
| `$var.set(path, value)` | 设置变量值 |
| `$var.delta(path, amount)` | 数值变量增减 |
| `$var.push(path, value)` | 数组追加 |

### $time API

| 方法 | 返回 | 说明 |
|------|------|------|
| `$time.getCurrentTime()` | `GameTime` | 获取当前游戏时间 |
| `$time.formatTime(time)` | `string` | 格式化为可读字符串 |
| `$time.advance(minutes)` | `GameTime` | 推进时间 |
| `$time.isBefore(t1, t2)` | `boolean` | 时间比较 |
| `$time.isAfter(t1, t2)` | `boolean` | 时间比较 |
| `$time.diffMinutes(t1, t2)` | `number` | 时间差（分钟） |

---

## Zone 可见性矩阵

### 完整矩阵

| Agent | memory | npc | world | quest | craft | combat | outline | variable |
|-------|--------|-----|-------|-------|-------|--------|---------|----------|
| **memory_recall** | FULL | KEYS | KEYS | KEYS | NONE | NONE | NONE | NONE |
| **plot_pre_check** | SUMMARY | FULL | FULL | FULL | NONE | NONE | FULL | KEYS |
| **story** | SUMMARY | NARRATIVE | FULL | SUMMARY | SUMMARY | FULL | SUMMARY | NONE |
| **vars_update** | NONE | KEYS | FULL | NONE | KEYS | KEYS | NONE | FULL |
| **char_update** | NONE | FULL | FULL | NONE | KEYS | FULL | NONE | NONE |
| **memory_summary** | SUMMARY | KEYS | SUMMARY | KEYS | NONE | KEYS | NONE | NONE |
| **plot_post_check** | SUMMARY | SUMMARY | FULL | FULL | NONE | SUMMARY | FULL | NONE |
| **plot_outline** | NONE | FULL | FULL | KEYS | NONE | NONE | FULL | NONE |
| **craft_gen** | NONE | SUMMARY | FULL | NONE | FULL | NONE | NONE | KEYS |
| **char_gen** | NONE | KEYS | FULL | NONE | NONE | NONE | NONE | SUMMARY |
| **item_gen** | NONE | KEYS | FULL | NONE | NONE | NONE | NONE | KEYS |

### 可见性级别说明

| 级别 | 说明 | 适用场景 |
|------|------|----------|
| **FULL** | 完整数据（含所有字段/嵌套结构） | 需要完整上下文 |
| **NARRATIVE** | 叙事格式（剥离数值设计，保留自然语言描述） | story Agent 专用 — 避免数值泄露到正文 |
| **SUMMARY** | 摘要格式（只保留关键信息） | 需要知晓但不需完整细节 |
| **KEYS** | 仅索引键（ID/名称/状态） | 查重/引用/去冲突 |
| **NONE** | 完全不可见 | 不需要该数据 |

---

## XML 标记协议

### 标记类型

| 标记 | 类型 | 处理时机 | 说明 |
|------|------|----------|------|
| `<craft_request>` | 🛑 阻塞 | Stage 1 立即 | 叙事暂停，制作完成后结果注入正文 |
| `<combat_trigger>` | 🚩 独立 | Stage 2 延迟 | 等 char_gen 完成（新敌人就绪），再打开战斗页 |
| `<char_detect>` | 👤 隐式 | Stage 2 扫描 | vars_update 扫描后触发 char_gen → item_gen 链 |

### 标记格式

**craft_request:**
```xml
<craft_request industry="锻造" productName="长剑" targetQuality="稀有" characterId="player_1">
制作一把锋利的长剑，使用精炼铁矿石在铁匠铺锻造...
</craft_request>
```

**combat_trigger:**
```xml
<combat_trigger combatType="标准" environment="密林深处的废弃矿坑入口">
三只地精从阴影中窜出，挥舞着生锈的匕首向你扑来...
</combat_trigger>
```

**char_detect:**
```xml
<char_detect characterName="艾琳" characterType="npc">
一位银发的精灵少女走进铁匠铺，她背着长弓，腰间挂着箭袋...
</char_detect>
```

### 处理流程

```
Story 输出 → scanMarkers()
  ├── craft_request → onCraftRequest() → $craft.startProject() + craft_gen Agent
  │   └── 制作结果叙事注入 story output
  ├── combat_trigger → 暂存到 pendingCombatMarkers
  │   └── Stage 2 char_detect 处理完 → onCombatTrigger() → 战斗页
  └── char_detect → Stage 2 扫描 → onCharDetect()
      └── char_gen Agent → item_gen Agent → 新角色存入数据库
```

---

## 脚本沙盒工具

> 用于词条效果脚本（装备/技能/状态效果/物品的 `scripts` 字段）。**非 Agent 直接调用**，而是由 `script-executor.ts` 在沙盒中执行。

### ScriptSandbox API

| 命名空间 | 方法 | 说明 |
|----------|------|------|
| `$dice.d20()` | → `number` | 掷 d20 |
| `$dice.d100()` | → `number` | 掷 d100 |
| `$dice.roll(formula)` | → `number` | 解析骰子公式 |
| `$resource.getHp(charId)` | → `number` | 获取 HP |
| `$resource.getMaxHp(charId)` | → `number` | 获取最大 HP |
| `$resource.modifyHp(charId, amount)` | → `void` | 修改 HP |
| `$resource.modifyStat(charId, stat, amount)` | → `void` | 修改属性 |
| `$status.add(charId, effect)` | → `void` | 添加状态效果 |
| `$status.remove(charId, effectId)` | → `void` | 移除状态效果 |
| `$status.setStacks(charId, effectId, stacks)` | → `void` | 修改层数 |
| `$status.getStacks(charId, effectId)` | → `number` | 获取层数 |
| `$event.emit(eventType, data?)` | → `void` | 触发事件（可被其他脚本的 onTrigger 捕获） |
| `$event.on(eventType, scriptKey)` | → `string` (handle) | 🔒 注册持久事件订阅（通过 subscription-manager） |
| `$event.off(handle)` | → `void` | 🔒 取消订阅 |
| `$call(ref)` | → `void` | 🔒 跨对象脚本引用（如 `$call("@type.weapon.铁剑.onEquip")`） |
| `@parent.xxx` | — | 🔒 继承链引用（在脚本中直接调用父对象的脚本） |

### 生命周期钩子

| 钩子 | 触发时机 |
|------|----------|
| `init` | 对象（状态/物品/技能）被创建时执行一次 |
| `cleanup` | 对象被移除时执行一次（用于取消订阅、释放资源） |
| `onApply` | 状态效果施加时 |
| `onTick` | 每时间单位（回合/分钟/小时） |
| `onRemove` | 状态效果移除时 |
| `onTrigger` | 条件触发时 |

### 安全约束

- `new Function()` 沙盒隔离，无 DOM/文件/网络访问
- 仅暴露白名单 `$` API
- 订阅递归深度限制 ≤ 10
- 僵尸订阅兜底（`unregisterAll`）

---

## 附录：Agent 概览速查表

| # | Agent ID | 阶段 | 类型 | 依赖 | 输出 |
|---|----------|------|------|------|------|
| 1 | `memory_recall` | Stage 0 | 每轮自动 | 无 | `{memories: [{id, relevance, reason}]}` |
| 2 | `plot_pre_check` | Stage 0 | 每轮自动 | 无 | `{triggeredEvents, relevantBackground, outlineRelevance}` |
| 3 | `story` | Stage 1 | 每轮自动 | memory_recall, plot_pre_check | XML（maintext + option + sum + vars） |
| 4 | `vars_update` | Stage 2 | 每轮自动 | story | `{replace, delta, insert, delta_time}` |
| 5 | `char_update` | Stage 3 | 每轮自动 | story, vars_update | `{characters: [{id, changes}]}` |
| 6 | `memory_summary` | Stage 4 | 每轮自动 | story | `{content, hiddenLine, keywords, importance}` |
| 7 | `plot_post_check` | Stage 5 | 每轮自动 | story, memory_summary | `{worldLineChanged, outlineChanges, eventUpdates}` |
| 8 | `plot_outline` | 按需 | 手动触发 | 无 | `{content, chapters, selfCritique}` |
| 9 | `craft_gen` | 按需 | 🛑 阻塞 | story (craft_request) | `{difficultyJudgment, creativeEffects, narrativeFlavor, craftToolCall}` |
| 10 | `char_gen` | 按需 | 👤 异步 | story (char_detect) | `{name, race, tier, level, attributes, background, ...}` |
| 11 | `item_gen` | 按需 | 🔗 链式 | char_gen | `{skills, equipment, inventory}` |

---

## 待修改区域

> 2026-06-22 — Phase 8.5 Agentic 系统可靠性验证（对照游戏实例 99 轮对话）
> 2026-06-23 — F1-F7 已修复 ✅；剩余 F8-F14 + P1-P15

---

### 🔴 框架问题

**已完成（F1-F7，2026-06-23）**

| # | 来源 | 问题 | 状态 |
|---|------|------|:--:|
| F1 | vars | vars_update 结构化输出未布线 | ✅ 已布线到 StatePatch |
| F3 | char | assembleCharacterState 资源计算 Bug | ✅ 改用 calcHP/calcMP/calcSP |
| F4 | char | roll_attributes 公式不对齐 | ✅ 三池分配 |
| F5 | craft | 缺少 get_inventory 工具 | ✅ 新增 |
| F6 | craft | 缺少 craft_settle 工具 | ✅ 新增 |
| F7 | craft | creative_effects 缺少结构化数值字段 + scripts | ✅ 扩展类型 |

**待修复（F8-F14）**
| F8 | craft | **缺少 `craft_prepare` 工具** — 生产准备阶段（管制物/品质要求/资源预检/批量）无返回值 | `agent-tools.ts` 新增或扩展 craft_check |
| F9 | char | **登神长阶输出严重不足** — `<ascension>` 只有 3 属性，游戏有权能树（要素/权能/法则/神位/神国） | `types.ts` CharGenOutput.ascension 扩展 + 模板加子标签 |
| F10 | char | **缺 `get_tier_config` 工具** — 层级锚定需要人口分布/属性上限/等级范围数据 | `agent-tools.ts` 新增，查 tier-constants 表 |
| F11 | vars | **缺失更新领域** — 游戏更新 `/关系/` `/新闻/` `/任务/`，管线无 Agent 负责 | 短期 vars_update 扩展 path；长期需独立 Agent |

**中**

| # | 来源 | 问题 | 修改位置 |
|---|------|------|----------|
| F12 | craft | `craft_check` 不返回 **fixedBonusBreakdown**（属性/技能/道具各自贡献） | `agent-tools.ts` craft_check handler 展开返回 |
| F13 | char | **CharGenOutput 类型缺少字段** — likes/attire 在模板中有但类型不存在 | `types.ts` CharGenOutput +likes +attire |
| F14 | craft | craft_get_base_dc / craft_get_production_bonus 需要配套库存查询 | 与 F5 一起修 |

---

### 🟢 提示词问题（改模板就能解决，共 15 个）

**craft_gen (6)**

| # | 问题 | 修改方式 |
|---|------|----------|
| P1 | `<craft_result>` 缺独立**物品描述字段**（narrative 是制作过程不是物品本身） | 加 `<product_description>` 标签 |
| P2 | 缺**物品标签**（"活体收纳""浮空"）和**认证状态**（"不合法"） | 加 `<tags>` `<certification>` |
| P3 | 缺**成品类型区分**（基础加工/半成品/成品），影响 EXP 结算 | 加 `<stage>` 字段 |
| P4 | materials 是字符串而非**结构化列表**（名称×数量×品质） | 示例中明确子元素格式 |
| P5 | 缺**物品市场价值**（游戏中标注"85万G"） | 加 `<value>` 标签 |
| P6 | 缺**阶段化输出指引**（游戏有准备→检定→结算三面板渐进揭露体验） | 模板加三阶段叙事结构说明 |

**char_gen (6)**

| # | 问题 | 修改方式 |
|---|------|----------|
| P7 | 缺「**喜爱**」字段 — 游戏每个 NPC 都有 `喜爱: 纯净的能量` | `<char_result>` 加 `<likes>` |
| P8 | 缺「**衣物装饰**」字段 — 游戏中衣物描述与装备独立 | `<char_result>` 加 `<attire>` |
| P9 | `<appearance>` 字数偏低 — 游戏 100-200 token，我们 50-100 字 | 改为 100-200 字 + 身体各部位指引 |
| P10 | 缺**层级/等级锚定推理指引**（环境→人口分布→tier 链条） | fixedSystem 加 Step1 推理链 |
| P11 | 缺**登神长阶校验指引** — Lv≥13 判定 + 要素/权能/法则分支 | fixedSystem 加条件分支 + 工具调用 |
| P12 | **技能数量公式** — 游戏 `1 + ceil((tier-1)/2) + 额外`，模板只提了范围 | item_gen fixedSystem 写明公式 + 调 roll_dice |

**vars_update (2)**

| # | 问题 | 修改方式 |
|---|------|----------|
| P13 | **变量路径格式不匹配** — AI 输出扁平 "位置"，引擎期望 `sys.world.location` | fixedSystem 教 AI 使用分层路径 |
| P14 | 缺 **Analysis 推理块** — 游戏变量变化前列分析原因 | 模板加 `<analysis>` 段落 |

**story (1)**

| # | 问题 | 修改方式 |
|---|------|----------|
| P15 | craft_request 标记说明不够详细 — 缺少 expects/材料/品质填写指引 | story 模板加完整 craft_request 属性说明 |

> 📊 统计: ✅ 7 已修复 / 🔴 7 待修复 / 🟢 15 待修复 = **共 22 项待处理**

---

### 已完成的改动

1. 正文ai在生成的过程中调用任何工具(指的是openai协议下的tools)，意思就是一次直出
2. 正文ai里的craft_request需要修改，不再是阻塞式，而是和combat_trigger一样，正文主动暂停叙事，然后在maintext后生成xml标签，然后正文结束后，检测到xml标签的存在，停止其他ai的调用，优先开始调用craft request ai，然后craft_gen自动调用item_gen，添加到变量中，随后恢复正常流程

3. craft_gen 和 npc生成，item生成一样，都需要在调用其他ai的时候额外预留一个参数，就按照你的文档里的例子，
"craftToolCall": {
    "industry": "锻造|炼金|烹饪|裁缝",
    "productName": "制品名称",
    "targetQuality": "普通|优良|稀有|史诗|传说|神话|唯一",
    "quantity": 1,
    "materials": ["材料1", "材料2"],
    "expects": "该物品需要生成为什么样？用户要不要指定需求？需不需要有特殊效果？"
  }

4. 讨论区域：除了正文ai，有没有需要把其他的ai都做成agent化？类似agent + xml混合，最终结果读取xml，然后中间的思维过程主动调用工具来推理？
例如craft gen，你如果阅读了制造物品相关的思维链（参考世界书）,你就会发现他是要走流程的，其中可能涉及到调用d20,d100等内容，这个肯定是不能只靠ai生成的。

举例：具体流程为，当生成物品时，ai需要先过一遍制造检定，这个或许可以交给程序自动判断（调用tool），假如成功了那就开始物品生成brainstrom。思考物品的词条效果，思考效果是叙事层面的还是数值层面的，如果是数值层面的腰怎么写代码，思考完，完整的物品内容用xml包裹，结束对话。程序检测xml内的内容，返回。
