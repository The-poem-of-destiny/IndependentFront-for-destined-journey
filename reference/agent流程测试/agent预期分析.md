# Agent 流程测试 — 完整输出追踪（思维链→工具调用→正文）

> 设计目的: 作为 debug 工具的参考基准，每个 Agent 记录从输入到最终输出的完整链路。
> 排除: story、memory_recall、plot_pre_check、plot_post_check、plot_outline、plot_check、plot_correct

---

## 通用架构说明

所有 Agentic Agent（craft_gen / char_gen / item_gen）通过 `chatWithTools()` 执行多轮工具调用循环：

```
agent-client.ts: chatWithTools()
  1. 发送 messages + tools 给 LLM
  2. 如果响应无 tool_calls → 最终文本，终止
  3. 如果有 tool_calls → 逐条执行 executeToolCall() → 追加以 role:'tool' 消息
  4. 回到步骤 1（最多 maxRounds=5 轮）
```

非 Agentic Agent（vars_update / char_update / memory_summary）直接输出 JSON，由 orchestrator 解析。

---

## 1. vars_update Agent — 变量更新

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:245-283`

**System Prompt（核心约束）**:
```
你是一个变量提取系统。根据正文 AI 的输出，提取需要更新的变量。

支持的变量操作:
- replace: 设置新值 {"path": "变量名", "value": 新值}
- delta: 数值增减 {"path": "变量名", "amount": +10 或 -5}
- insert: 数组插入 {"path": "数组变量名", "value": 新元素, "index": 可选}
- delta_time: 时间推进 (分钟) {"delta_time": 180}

注意:
- 只提取正文中明确发生的变量变化
- 数值变化要精确（HP减少多少、金钱增减多少）
- 位置变化每次都要更新
- 新获得的物品/技能要 insert
- 时间流逝用 delta_time 表示（分钟），如 "过了一小时" → delta_time: 60
```

**输出格式 (严格 JSON)**:
```json
{"replace": [{"path": "位置", "value": "北方-诺斯加德-白曜城-铁匠铺"}], "delta": [{"path": "金钱", "amount": -50}], "insert": [{"path": "背包", "value": {"name": "铁剑", "quantity": 1}}], "delta_time": 60}
```

### 上下文注入（variableContext）

注入当前变量树和角色状态快照：
```
当前变量:
/世界/时间: "复兴纪元488年-08月-16日-12:00"
/世界/地点: "...私人住宅"
/主角/金钱: 27000

当前角色状态:
[protagonist:柠萌茶] Lv.9 T3 | HP:2843/2843 MP:7200/7200 SP:3600/3600
```

### 指令注入（variableInstruction）

注入 story agent 的原始输出正文：
```
正文 AI 输出:
<maintext>一整晚的深度睡眠...柠萌茶从次元腰包里摸出两个钱袋丢给她们..."今天给你们放假。"...
傍晚时分浅葱和铃音回来了...</maintext>

请提取变量变更。
```

### 完整输出追踪

**思维链**:
```
<thinking>
时间从中午推进到晚上22:00，过去了约10小时 → delta_time: 600
地点从客厅移到卧室 → replace 位置
柠萌茶给了两人零花钱，每人约500G → delta 金钱 -1000
无新物品/技能 → insert 为空
</thinking>
```

**最终 JSON 输出**:
```json
{
  "replace": [
    { "path": "/世界/时间", "value": "复兴纪元488年-08月-16日-星期三-22:00" },
    { "path": "/世界/地点", "value": "中南部-瓦伦蒂亚公国-诺瓦·瓦伦蒂亚城-中城区-私人住宅-卧室" }
  ],
  "delta": [
    { "path": "/主角/金钱", "amount": -1000 }
  ],
  "delta_time": 600
}
```

### 下游解析链路

`agent-orchestrator.ts:636-687` → `processStageMarkers(2)`:
1. `JSON.parse(varsOutput)` 解析原始输出
2. `replace[]` → `{ op: 'set_variable', target: 'variables.<path>', value }` StatePatch
3. `delta[]` → `{ op: 'delta_variable', target: 'variables.<path>', amount }` StatePatch
4. `insert[]` → `{ op: 'insert_variable', target: 'variables.<path>', value }` StatePatch
5. `delta_time` → `stateManager.applyTimeAdvance(minutes)`
6. 所有 patch 批量 `commitChatState(patches)`

**⚠️ 调试检查点**: JSON.parse 失败时整个 vars_update 阶段静默跳过，需在此处打 log。

---

## 2. char_update Agent — 角色状态更新

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:287-323`

**System Prompt（核心约束）**:
```
你是一个角色状态更新系统。根据正文 AI 的输出，更新角色的状态。

需要检测的变化:
- HP/MP/SP 的变化（受伤、治疗、消耗）
- 经验值和等级变化
- 状态效果的添加/移除（中毒、眩晕、buff等）
- 装备变化（获得/丢失/装备/卸下）
- 技能变化（学习/遗忘）
- 位置变化
- 金钱变化
- 关系变化
```

**输出格式 (严格 JSON)**:
```json
{"characters": [{"id": "角色ID", "changes": {"hp": 80, "statusEffects": [...], ...}}]}
```

`changes` 对象是 `CharacterState` 的部分映射，仅包含有变化的字段。可行字段: `hp`, `maxHp`, `mp`, `maxMp`, `sp`, `maxSp`, `level`, `tier`, `totalExp`, `statusEffects`, `equipment`, `skills`, `inventory`, `money`, `location`, `currentAction`, `attributes`, `freeAttrPoints`, `ascension`, `bloodlineIds`, `customFields`。

### 上下文注入

```
当前角色状态:
[protagonist:柠萌茶] Lv.9 T3 | HP:2843/2843 MP:7200/7200 SP:3600/3600 | statusEffects:[]
[npc_qiancong:浅葱] Lv.9 T3 | HP:3640/3640 MP:4500/4500 SP:2800/2800 | statusEffects:[]
[npc_lingyin:铃音] Lv.8 T2 | HP:1228/1228 MP:1800/1800 SP:1600/1600 | statusEffects:["轻伤"]

当前变量:
/世界/时间: "复兴纪元488年-08月-16日-22:00"
```

### 完整输出追踪

**思维链**:
```
<thinking>
检测以下变化:
- 柠萌茶: 施放奥术飞弹消耗MP 400，SP轻微消耗50 → mp:6800, sp:3550
- 浅葱: 承受魔物攻击HP -1440，后经光合作用恢复到2200 → hp:2200
- 铃音: 受到轻伤HP降低，但战后光合作用恢复 → hp:1228, sp:1200
  铃音在战斗中突破，EXP增加2500升级到Lv.9 → exp:18300, level:9
  轻伤状态被治疗移除 → statusEffects:[]
</thinking>
```

**最终 JSON 输出**:
```json
{
  "characters": [
    {
      "id": "protagonist",
      "changes": { "mp": 6800, "sp": 3550 }
    },
    {
      "id": "npc_qiancong",
      "changes": { "hp": 2200 }
    },
    {
      "id": "npc_lingyin",
      "changes": {
        "hp": 1228,
        "sp": 1200,
        "exp": 18300,
        "level": 9,
        "statusEffects": []
      }
    }
  ]
}
```

### 下游解析链路

**🔴 当前状态**: char_update 的输出存储在 `context.agentOutputs` 中，但 `processStageMarkers()` **不自动消费** char_update 的 JSON 输出为 StatePatch。与 vars_update 不同，没有 `isCharUpdateStage()` 检查。

**设计预期路径**（待接线）:
1. char_update JSON → `{ op: 'update_character', target: 'characters.<id>', value: changes }` StatePatch
2. `StateManager.applyUpdateCharacter()`（state-manager.ts:319）→ `Object.assign(char, changes)` → `saveCharacter()`
3. 生成 `character_action` GameEvent

**⚠️ 调试检查点**: 此 Agent 的输出存储后无人消费，是一个已知缺口。需确认是否已在 orchestrator 中接线。

---

## 3. craft_gen Agent — 制作效果生成 (Agentic)

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:453-535`

**System Prompt（核心约束）**:
```
你是一个制作系统 AI。你可以调用 function calling 工具来获取真实数据。

可用工具:
- roll_d20: 掷d20检定骰（加值/优势/劣势）
- roll_d100: 掷d100百分比骰
- roll_dice: 掷任意骰子公式（如 2d6）
- craft_check: 执行完整制作检定 — 输入角色/行业/品质/材料，返回真实DC+骰值+评级
- craft_get_base_dc: 查询某品质的基准 DC
- craft_get_production_bonus: 查询某品质的产能加成
- craft_settle: 完整制作管线（准备+检定+结算），实际消耗资源
- get_character: 查询角色属性/装备/资源
- get_hp_percent: 查询角色 HP 百分比
- get_inventory: 查询角色背包（必须调用以获取材料，禁止编造）

工作流程:
1. 调用 get_character 获取制作者数据
2. 调用 get_inventory 获取材料清单
3. 调用 craft_check 获取真实检定结果（禁止自己编造 DC 值/d20 值）
4. 解读检定结果（大失败/失败/成功/精益求精）
5. 成功时根据 expects 需求 brainstorm 创意效果词条
6. 生成制作叙事片段
7. 输出最终 <craft_result> XML

⚠️ 绝对禁止: 编造任何数值。DC、骰值、评级必须来自工具返回。
```

### 可用工具及其 Schema

白名单（agent-tools.ts:340-344）: `roll_d20, roll_d100, roll_dice, craft_check, craft_settle, craft_get_base_dc, craft_get_production_bonus, get_character, get_hp_percent, get_inventory`

| 工具 | 关键参数 | 返回值 |
|------|---------|--------|
| `get_character` | `characterId` | 完整角色对象（tier, level, attributes, hp/mp/sp, occupation） |
| `get_inventory` | `characterId`, `type?` | 物品列表（name, quantity, type, quality） |
| `craft_check` | `characterId`, `industry`, `targetQuality`, `materials[]`, `stage?`, `quantity?` | `{baseDC, finalDC, fixedBonus, diceValue, diceRolls[], totalValue, rating}` |
| `craft_settle` | 同上 + `productName` | `{success, outputQuality, productQuantity, xpGained, fpGained, patchesApplied}` — 实际消耗资源 |
| `craft_get_base_dc` | `quality` | `{quality, baseDC}` |
| `craft_get_production_bonus` | `quality` | 完整产能加成对象（dcReduction, resourceReduction, timeReduction 等） |
| `roll_d20` | `modifier?`, `advantage?`, `disadvantage?`, `reason?` | `{diceValue, diceRolls[], advantage, disadvantage}` |
| `roll_d100` | `modifier?`, `reason?` | `{value, modifier}` |
| `roll_dice` | `formula`, `modifier?`, `reason?` | `{formula, rolls[], total, modifier}` |
| `get_hp_percent` | `characterId` | `{characterId, hpPercent, hp, maxHp}` |

### 输出 XML 格式

```xml
<craft_result>
<success>true/false</success>
<product_name>制品名称</product_name>
<quality>品质</quality>
<check_summary>检定简述（如"DC12，d20=15+5=20，精益求精"）</check_summary>
<creative_effects>
<effect name="词条名" type="增益|减益|特殊" atk="0" def="0" hp="0" mp="0" sp="0"
        dot="0" dotType="" duration="" durationUnit="回合"
        stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="" scripts="">
  效果描述
</effect>
</creative_effects>
<narrative>制作叙事（200-400字，第二人称"你"，注入回正文）</narrative>
<craft_params>
<industry>行业</industry><target_quality>品质</target_quality><quantity>数量</quantity>
<materials>材料列表</materials>
</craft_params>
</craft_result>
```

### 完整输出追踪（以制作"浮空摇篮"为例）

**触发**: story Agent 输出含 `<craft_request expects="能承载一人重量，跟随意识移动">制作浮空法阵驱动的可移动容器</craft_request>`

**工具调用轮次 1** — 获取制作者数据:
```
→ get_character({characterId:"protagonist"})
← {
    "found": true, "id": "protagonist", "name": "柠萌茶",
    "tier": 3, "tierName": "稀有", "level": 9,
    "attributes": { "力量": 5, "敏捷": 5, "体质": 5, "智力": 12, "精神": 8 },
    "occupation": ["炼金专家"], "identity": ["B级冒险者"]
  }
```

**工具调用轮次 2** — 获取背包材料:
```
→ get_inventory({characterId:"protagonist"})
← {
    "items": [
      { "itemName": "月光木板", "quantity": 10, "type": "material", "quality": "优良" },
      { "itemName": "沼龙皮", "quantity": 5, "type": "material", "quality": "优良" },
      { "itemName": "秘银锭", "quantity": 2, "type": "material", "quality": "稀有" },
      { "itemName": "星尘砂", "quantity": 1, "type": "material", "quality": "稀有" },
      { "itemName": "魔晶石", "quantity": 3, "type": "material", "quality": "优良" }
    ]
  }
```

**工具调用轮次 3** — 执行制作检定:
```
→ craft_check({
    characterId: "protagonist",
    industry: "炼金",
    targetQuality: "稀有",
    productName: "浮空摇篮",
    materials: [
      { name: "月光木板", quantity: 10, quality: "优良" },
      { name: "沼龙皮", quantity: 5, quality: "优良" },
      { name: "秘银锭", quantity: 2, quality: "稀有" },
      { name: "星尘砂", quantity: 1, quality: "稀有" },
      { name: "魔晶石", quantity: 3, quality: "优良" }
    ]
  })
← {
    "baseDC": 14,
    "materialDCModifier": -2,
    "finalDC": 12,
    "fixedBonus": 5,
    "diceValue": 16,
    "diceRolls": [16],
    "totalValue": 21,
    "rating": "精益求精"
  }
```

**工具调用轮次 4** — 确认结算（实际消耗资源）:
```
→ craft_settle({
    characterId: "protagonist",
    industry: "炼金",
    targetQuality: "稀有",
    productName: "浮空摇篮",
    quantity: 1,
    materials: [...]
  })
← {
    "success": true,
    "outputQuality": "稀有",
    "productQuantity": 1,
    "xpGained": 400,
    "fpGained": 5,
    "patchesApplied": 4
  }
```

**最终输出** — 无 tool_calls，chatWithTools 循环终止:
```xml
<craft_result>
<success>true</success>
<product_name>浮空摇篮</product_name>
<quality>稀有</quality>
<check_summary>DC12（基准14-材料加成2），d20=16+5(智力)=21，评级: 精益求精</check_summary>
<creative_effects>
<effect name="灵念随行" type="增益" atk="0" def="0" hp="0" mp="0" sp="0"
        dot="0" dotType="" duration="" durationUnit=""
        stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="" scripts="">
  容器通过子母感应法阵与佩戴者戒指共鸣，可跟随意念移动，有效范围30米
</effect>
<effect name="浮空悬架" type="增益" atk="0" def="0" hp="0" mp="0" sp="0"
        dot="0" dotType="" duration="" durationUnit=""
        stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="" scripts="">
  箱体内部多层减震符文构成全向悬浮，外部颠簸时内部几乎无感
</effect>
<effect name="月泽温养" type="增益" atk="0" def="0" hp="5" mp="0" sp="0"
        dot="0" dotType="" duration="" durationUnit=""
        stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="" scripts="">
  月光木吸收环境魔力转为温和生命能量，每小时为乘员恢复5点HP
</effect>
</creative_effects>
<narrative>
你戴上护目镜，启动了元素熔炉。幽蓝色火焰在炉心燃起，魔力回路发出低沉的嗡鸣。
十块月光木板在精密构装台上悬浮排列，你用秘银笔蘸着星尘砂在每一块木板上勾勒出
细如发丝的浮空符文。沼龙皮被裁剪成合适的内衬，墨绿色的表面在魔力的灌注下泛起
柔光。当最后一块魔晶石嵌入法阵核心，整个箱体轻盈地浮了起来——没有一丝晃动，
如同漂浮在平静湖面上的一片羽毛。
</narrative>
<craft_params>
<industry>炼金</industry>
<target_quality>稀有</target_quality>
<quantity>1</quantity>
<materials>月光木板×10, 沼龙皮×5, 秘银锭×2, 星尘砂×1, 魔晶石×3</materials>
</craft_params>
</craft_result>
```

### 下游解析链路

1. `marker-protocol.ts:scanCraftRequests()` → 正则提取 `<craft_request>` 标记属性
2. `agent-orchestrator.ts:processStageMarkers(2)` → `this.pendingCraftMarkers` → `onCraftRequest` 回调
3. craft_gen Agent 执行（Agentic 多轮工具调用）
4. 结果注入：`<craft_request>` 标记被替换为 `<craft_result>` XML
5. `craft-resolver.ts` 通过 `craft_settle` 已实际消耗材料并产出 StatePatch

**⚠️ 调试检查点**:
- craft_request 标记是否被 story Agent 正确输出
- 工具调用是否按顺序执行（get_character → get_inventory → craft_check → craft_settle）
- craft_settle 返回的 patchesApplied 数量是否正确

---

## 4. char_gen Agent — 角色生成 (Agentic)

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:540-619`

**System Prompt（核心约束）**:
```
你是一个角色生成 AI。你可以调用 function calling 工具来获取真实的随机值和数据。

可用工具:
- random_name: 随机生成符合种族/性别的中文名
- random_hair_color: 随机生成符合种族的发色
- random_eye_color: 随机生成符合种族的瞳色
- random_personality: 随机生成 wOaGz(A) 五维性格编码
- random_appearance: 随机生成外貌摘要（发色/瞳色/外观年龄/体型）
- roll_attributes: 按生命层级随机生成五维属性（自动遵循上限和总和约束）
- roll_d20/roll_d100/roll_dice: 掷骰（用于等级/层级随机）
- get_character: 查询已有角色（避免重名）

工作流程:
1. 理解 <char_detect> 中描述的新角色
2. 调用 get_character 查重（避免生成已存在的角色名）
3. 根据角色描述确定种族和 tier
4. 调用 random_name 生成名称
5. 调用 random_hair_color / random_eye_color / random_appearance 生成外貌
6. 调用 random_personality 生成性格
7. 调用 roll_attributes 生成五维
8. 综合所有数据输出最终 <char_result> XML

⚠️ 绝对禁止: 自己编造名字、发色、瞳色、性格编码。必须调用工具获取随机值。
```

### 可用工具及其 Schema

白名单（agent-tools.ts）: `random_name, random_hair_color, random_eye_color, random_personality, random_appearance, roll_attributes, roll_d20, roll_d100, roll_dice, get_character`

| 工具 | 关键参数 | 返回值 |
|------|---------|--------|
| `get_character` | `characterId?` | 查重列表或特定角色对象 |
| `random_name` | `race`, `gender` | `{name}` |
| `random_hair_color` | `race` | `{color}` |
| `random_eye_color` | `race` | `{color}` |
| `random_appearance` | `race`, `gender` | `{hairColor, eyeColor, apparentAge, build}` |
| `random_personality` | — | `{code, description}` — code 格式: `wOaGz(A)` |
| `roll_attributes` | `tier` | `{str, dex, con, int, spi}` — 自动遵循层级上限和总和约束 |
| `roll_d20` | `modifier?`, `advantage?`, `reason?` | `{diceValue, diceRolls[]}` |
| `roll_d100` | `modifier?`, `reason?` | `{value, modifier}` |
| `roll_dice` | `formula`, `modifier?`, `reason?` | `{formula, rolls[], total, modifier}` |

### 输出 XML 格式

```xml
<char_result>
<name>名称</name>
<race>种族</race>
<tier>生命层级(1-7)</tier>
<level>等级(1-25)</level>
<attributes str="6" dex="5" con="5" int="4" spi="5"/>
<identity>身份1, 身份2</identity>
<occupation>职业1, 职业2</occupation>
<background>角色背景故事（100-200字）</background>
<appearance>外貌描述（含发色/瞳色/体型等，50-100字）</appearance>
<personality code="wOaGz(A)">性格描述</personality>
<ascension enabled="false" path="" description=""/>
</char_result>
```

**⚠️ char_gen 不生成技能/装备/物品**。技能和装备由 item_gen 在 char_gen 之后独立生成（ADR-26: item_gen 仅调用1次）。

### 完整输出追踪（以生成"绮萝莉娅"为例）

**触发**: story Agent 输出含 `<char_detect characterName="绮萝莉娅" characterType="npc">冰蓝色长发少女，沉睡于古代石棺中，灵魂无法操控身体只能以灵体对话。种族人类(变异血脉)，第五层级/传说。</char_detect>`

**工具调用轮次 1** — 查重:
```
→ get_character({})
← { "characters": [{ "id": "protagonist", "name": "柠萌茶", ... }] }  // 无重名
```

**工具调用轮次 2** — 生成名称:
```
→ random_name({race:"人类", gender:"女"})
← { "name": "绮萝莉娅" }
```

**工具调用轮次 3** — 生成外貌（并行调用）:
```
→ random_hair_color({race:"人类"})   ← { "color": "冰蓝色" }
→ random_eye_color({race:"人类"})    ← { "color": "蓝粉混合色" }
→ random_appearance({race:"人类", gender:"女"})  ← { "hairColor": "冰蓝色", "eyeColor": "蓝粉混合", "apparentAge": "15-16", "build": "身材匀称" }
```

**工具调用轮次 4** — 生成性格:
```
→ random_personality({})
← { "code": "dOlgY(F)", "description": "支配欲高，心思开放但谨慎，情感深沉，待人冷淡，外表优雅内心复杂，不轻易信任他人" }
```

**工具调用轮次 5** — 生成属性:
```
→ roll_attributes({tier: 5})
← { "str": 6, "dex": 6, "con": 6, "int": 11, "spi": 12 }
```

**最终输出** — 无 tool_calls，循环终止:
```xml
<char_result>
<name>绮萝莉娅</name>
<race>人类(变异血脉)</race>
<tier>5</tier>
<level>19</level>
<attributes str="6" dex="6" con="6" int="11" spi="12"/>
<identity>无尽树海教团圣女, 远古仪式的幸存者</identity>
<occupation>神术师, 灵体存在</occupation>
<background>绮萝莉娅曾是无尽树海深处某古代教团的圣女，数百年前在一次登神仪式中失败，
灵魂与肉体分离，被封印于石棺中沉睡至今。她的肉体依然保持着青春，但灵魂已无法完全操控身体，
只能通过灵体对话与外界交流。苏醒后的她发现自己身处完全陌生的时代，只能寄居于将她唤醒的
少年炼金术师身边。</background>
<appearance>冰蓝色及腰长发如冻结的瀑布，蓝粉混合色的双瞳透出非人的空灵。身材匀称但腹部
异常隆起（仪式后遗症），胸部饱满可泌乳，皮肤白皙如雪。身着会自动修复的华丽纯白连衣裙。
</appearance>
<personality code="dOlgY(F)">外表疏离冷淡，内心情感深沉。对信任的人展现出意外的温柔和
保护欲，对敌人则毫不留情。数百年的孤独使她更习惯观察而非参与。</personality>
<ascension enabled="true" path="登神长阶·生命摇篮" description="未完成的登神仪式使身体成为'生命摇篮'——一个能够孕育特殊存在的容器。"/>
</char_result>
```

### 下游解析链路

`char-gen-agent.ts`:
1. `parseCharGenXML(xml)` → `CharGenOutput` 对象（name, race, tier, level, attributes, identity, occupation, background, appearance, personality, ascension）
2. `assembleCharacterState(charData, itemData)` → 合并 char_gen + item_gen 输出为完整 `CharacterState`
3. `buildCharGenPatches(character)` → 生成 `StatePatch[]`（add_character + add_skill×N + add_item×N + equip_item×N）
4. 通过 `stateManager.commitChatState(patches)` 写入

**⚠️ 调试检查点**:
- `<char_detect>` 标记是否被 story Agent 输出
- 查重是否正确（避免生成同名角色）
- `roll_attributes` 返回的属性是否在层级约束范围内
- 性格编码格式是否符合 `wOaGz(A)` 模式

---

## 5. item_gen Agent — 技能/装备/物品生成 (Agentic)

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:624-693`

**System Prompt（核心约束）**:
```
你是一个物品生成 AI。你可以调用 function calling 工具来获取真实数据。

可用工具:
- roll_d20/roll_d100/roll_dice: 掷骰（用于品质随机/数量随机）
- craft_get_base_dc: 查询品质基准 DC（参考品质级别）
- get_character: 查询已有角色数据

生成规则 (对齐世界书 #261442 + #265160):
- Tier 匹配: T1 角色→1-2个基础技能+1-2件普通装备; T7→完整技能树+神话装备
- 技能: 主动技能注明消耗(HP/MP/SP)和冷却回合; 被动技能注明常驻效果
- 装备: 按槽位分配（武器必有一件）；品质按 tier 匹配
- 背包物品: 与角色身份匹配

工作流程:
1. 读取 char_gen 输出的角色数据
2. 根据角色 tier 确定技能/装备数量范围
3. 调用 roll_dice 确定实际数量
4. 生成具体的技能/装备/物品列表
5. 输出最终 <item_result> XML
```

### 目标类型: Skill（types.ts:570-583）

```typescript
interface Skill {
  id: string;                        // crypto.randomUUID() 生成
  name: string;
  description: string;
  type: 'active' | 'passive';
  cost?: { type: 'HP' | 'MP' | 'SP'; amount: number };
  cooldown?: number;                 // 剩余冷却时间
  maxCooldown?: number;
  level?: number;
  effects?: Record<string, string>;   // 🆕 词条名→中文描述 (AI写, 前端展示)
  scripts?: Record<string, string>;   // 🆕 脚本名→可执行代码 (AI写, 引擎执行)
}
```

**scripts 字段的三种用途**（script-executor.ts）:
| 脚本名 | 触发时机 | 典型内容 |
|--------|---------|---------|
| `init` | 技能学习/激活时 | `$event.on('combat_action', 'handler', (ctx) => {...})` |
| `cleanup` | 技能遗忘/移除时 | `$event.off('combat_action', 'handler')` |
| 自定义名 | 按名称通过 `$call()` 引用 | 效果逻辑，可被其他对象复用 |

### 输出 XML 格式

```xml
<item_result>
<skills>
<skill name="技能名" type="active|passive" cost_type="MP" cost_amount="10" cooldown="2">
  效果描述
</skill>
</skills>
<equipment>
<equip slot="武器" name="装备名" quality="品质" durability="100" stats="攻击力:18,敏捷:2">
  描述
</equip>
</equipment>
<inventory>
<item name="物品名" quantity="1" type="消耗品|材料|任务物品" rarity="普通">
  描述
</item>
</inventory>
</item_result>
```

### 完整输出追踪（以生成绮萝莉娅的技能/装备为例）

**输入**: char_gen 输出（绮萝莉娅, T5传说, Lv.19, int:11, spi:12, 职业:神术师）

**工具调用轮次 1** — 确定数量:
```
→ roll_dice({formula: "1d3+2", reason: "技能数量"})  ← { rolls: [2], total: 4 }
→ roll_dice({formula: "1d2+1", reason: "装备数量"})  ← { rolls: [1], total: 2 }
→ roll_dice({formula: "1d3", reason: "背包物品数量"}) ← { rolls: [2], total: 2 }
→ craft_get_base_dc({quality: "传说"})               ← { quality: "传说", baseDC: 20 }
```

**工具调用轮次 2** — 无需更多工具，直接生成:

```xml
<item_result>
<skills>
<skill name="序曲·止息" type="active" cost_type="" cost_amount="0" cooldown="0">
  挥动法杖发动至多四段连续攻击，造成精神伤害。命中敌人获得【乐章】灵感。
  可蓄力发动重击造成范围精神伤害。
</skill>
<skill name="间奏·失调" type="active" cost_type="MP" cost_amount="300" cooldown="8">
  奏响刺耳乐章，对周围5米内敌人造成精神伤害，附加【失调】状态（精神抗性-10%，持续8秒）。
  施放时获得大量【乐章】灵感。
</skill>
<skill name="终曲·赫卡忒" type="active" cost_type="MP" cost_amount="1200" cooldown="20">
  消耗所有【协奏能量】，召唤'猩红魔女人偶·赫卡忒'登场协同攻击，造成大范围精神伤害。
  赫卡忒留在场上20秒，属性与召唤者一致。
</skill>
<skill name="华彩乐段" type="passive">
  战斗中积攒【乐章】灵感(上限100点)。灵感满溢时蓄力重击升华为【华彩·猩红回响】，
  转化所有灵感为【协奏能量】。
</skill>
<skill name="声骸共生" type="passive">
  受到致命伤害时免疫此次伤害，强制赫卡忒代为承受并毁灭。
  触发后进入70秒【寂静】状态无法施放。
  <!-- 🆕 此技能需要 scripts.init 注册 combat_action 事件监听 -->
  <!-- 🆕 scripts.cleanup 需要在技能移除时清理事件订阅 -->
</skill>
</skills>
<equipment>
<equip slot="主手" name="彼岸花法杖" quality="传说" durability="100" stats="攻击力:520,精神:8">
  猩红水晶与未知枯木制成的法杖，顶端盛开永不凋零的彼岸花。
</equip>
<equip slot="身体" name="圣仪华裙" quality="史诗" durability="100" stats="防御力:120,精神:4">
  无尽树海教团圣女的仪式礼服，嵌有自动修复法阵，破损后自动复原。
</equip>
</equipment>
<inventory>
<item name="远古教团圣徽" quantity="1" type="任务物品" rarity="传说">
  古代教团圣徽，镌刻失传仪式符文，可能在教团遗址触发隐藏事件。
</item>
<item name="魂晶碎片" quantity="3" type="消耗品" rarity="稀有">
  封印灵魂能量的结晶体碎片，可用于临时强化灵体类技能或作为高级炼金材料。
</item>
</inventory>
</item_result>
```

### 🔴 技能脚本示例（当前架构缺失，但 Skill 类型已预留字段）

以"声骸共生"被动技能为例，其 scripts 应为:

```json
{
  "effects": {
    "濒死保护": "受到致命伤害时免疫此次伤害，强制召唤物代为承受。进入70秒【寂静】状态"
  },
  "scripts": {
    "init": "$event.on('combat_action', 'onOwnerDamaged', function(ctx) { var ownerHp = $resource.getHp(ctx.owner); if (ownerHp <= 0) { $resource.modifyHp(ctx.owner, 1); $status.remove(ctx.owner, '赫卡忒 summoned'); $status.add(ctx.owner, { name: '寂静', category: '减益', duration: 70, timeUnit: '秒', stackable: false, maxStacks: 1, source: '技能-[绮萝莉娅]·声骸共生', effects: {}, effectDescriptions: { '沉默': '无法施放任何技能' } }); } });",
    "cleanup": "$event.off('combat_action', 'onOwnerDamaged');"
  }
}
```

### 下游解析链路

`char-gen-agent.ts`:
1. `parseItemGenXML(xml)` → 调用 `parseSkillsXML()`, `parseEquipmentXML()`, `parseInventoryXML()`
2. `parseSkillsXML()` 正则: `/<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/g`
   - 提取属性: name, type, cost_type, cost_amount, cooldown
   - **🔴 不解析子元素** `<effect>` 和 `<script>`（当前缺失）
3. `assembleCharacterState()` → 将 itemData.skills 映射到 Skill 对象
   - **🔴 不传递 effects/scripts 字段**（当前缺失，见 char-gen-agent.ts:182-190）

### 🔴 代码缺口清单

| # | 文件:行号 | 问题 |
|---|----------|------|
| 1 | `types.ts:2393-2404` — `ItemGenOutput['skills']` | 缺少 `effects?: Record<string, string>` 和 `scripts?: Record<string, string>` |
| 2 | `char-gen-agent.ts:459-472` — `parseSkillsXML()` | 不解析 `<effect>` 和 `<script>` 子元素 |
| 3 | `char-gen-agent.ts:182-190` — `assembleCharacterState()` | `skills.map()` 不传递 effects/scripts |
| 4 | `agent-templates.ts:624-680` — item_gen 模板 | prompt 不指导 AI 生成 `<effect>` 和 `<script>` 子元素 |
| 5 | `agent-templates.ts:626-632` — item_gen 模板 | `可用工具` 列表只有 roll_d20/roll_d100/roll_dice/craft_get_base_dc/get_character，缺 script 相关工具 |

**⚠️ 调试检查点**:
- item_gen 是否在 char_gen 完成后恰好调用 1 次（ADR-26）
- `parseSkillsXML` 是否丢失了 effect/script 子元素
- `assembleCharacterState` 生成的 Skill 对象是否为空壳（缺 effects/scripts）
- 模板是否需要更新以指导 AI 输出 `<effect>` 和 `<script>` 子元素

---

## 6. memory_summary Agent — 记忆总结

### 模板格式规范

**文件**: `src/sillytavern/agent-templates.ts:327-365`

**System Prompt（核心约束）**:
```
你是一个记忆总结系统。每轮对话结束后，将本回合的重要事件总结为一条结构化记忆。

记忆格式:
- id: MEM + 6位数字编号（由系统分配，你不需要生成）
- content (正文): ≥200字的详细叙述，对 AI 可见
- hiddenLine (暗线): 一句话概括的隐藏线索，仅引擎使用
- keywords: 3-8个关键词
- importance: 1-10的重要度评分
  - 1-3: 日常对话、闲逛
  - 4-6: 有信息量的互动、物品获取
  - 7-8: 战斗、重要剧情推进
  - 9-10: 重大转折、角色死亡、世界线变动
```

**输出格式（严格 JSON）**:
```json
{"content": "正文内容(≥200字)", "hiddenLine": "暗线内容", "keywords": ["关键词1", "关键词2"], "importance": 5, "timeRangeStart": "游戏时间开始", "timeRangeEnd": "游戏时间结束"}
```

### 最终类型: MemoryRecord（types.ts:800-824）

```typescript
interface MemoryRecord {
  id: string;                    // "MEM000001"
  saveId: string;
  createdAt: number;             // 游戏时间戳
  realTimestamp: number;         // 真实时间戳
  timeRange: { start: string; end: string };
  content: string;               // ≥200字，AI 可见
  hiddenLine: string;            // 仅引擎使用
  keywords: string[];            // 最多 8 个
  relatedCharacterIds: string[];
  relatedPlotEventId?: string;
  importance: number;            // 1-10
  embedding?: number[];          // 向量（用于语义召回）
}
```

### 完整输出追踪

**思维链**:
```
<thinking>
- 内容: 柠萌茶发现了石棺中的绮萝莉娅，这是重要剧情事件
- 暗线: 古代圣女苏醒，可能关联教团遗址和未完成的登神仪式
- 关键词: 石棺, 绮萝莉娅, 圣女, 苏醒, 灵体对话, 变异血脉
- 重要性: 8（新角色登场+重要背景揭示）
- 时间: 从开棺到对话结束约 17 分钟
</thinking>
```

**最终 JSON 输出**:
```json
{
  "content": "柠萌茶在家中将A级任务'深绿之心'的奖励——一口古代石棺仔细擦拭干净后，发现了棺盖与棺身之间的接缝。经过尝试，他用蛮力掀开了沉重的石棺，发现里面沉睡着一位名叫绮萝莉娅的少女。少女拥有冰蓝色长发和蓝粉混合色的异色瞳，身着会自动修复的华丽白裙，最奇特的是她的腹部高高隆起却仍是处女。她通过灵体对话与柠萌茶交流，声称自己曾是某个古老教团的圣女，在数百年前的一次登神仪式失败后被封印于此。柠萌茶对她的特殊体质产生了强烈的好奇，两人之间形成了一种微妙的羁绊。",
  "hiddenLine": "古代石棺中沉睡的教团圣女绮萝莉娅苏醒，与柠萌茶建立初识关系",
  "keywords": ["古代石棺", "绮萝莉娅", "圣女", "苏醒", "灵体对话", "变异血脉", "教团", "登神仪式"],
  "importance": 8,
  "timeRangeStart": "复兴纪元488年-08月-15日-20:13",
  "timeRangeEnd": "复兴纪元488年-08月-15日-20:30"
}
```

### 下游解析链路

`memory-summarizer.ts`:
1. `parseMemorySummaryOutput(raw)` → 尝试 `JSON.parse`；失败则正则提取 `{...}` 块
2. 验证: content 非空、hiddenLine 存在、keywords 是数组
3. 裁剪: keywords 截断至 8 个，importance clamp 到 [1, 10]
4. `validateMemoryContent()` → content 长度 ≥ 200 字符
5. `generateMemoryId()` → 查询现有记忆，取最大 MEM 编号 + 1
6. 构建 `MemoryRecord`（含 `relatedCharacterIds`, `relatedPlotEventId`）
7. 如有 embedding endpoint → `computeEmbedding(keywords + content)` → 存储向量
8. `database.memories.put(memory)` → DexieDB 持久化

**召回链路**（随后续对话时触发）:
1. `memory_recall` Agent（stage 0）→ `recallMemories(saveId, query, topK)`
2. 计算 query embedding → 对每条记忆计算余弦相似度
3. 有 embedding 的记忆按相似度排序，无 embedding 的按 importance 降序
4. 注入 story Agent 的 variableContext

**⚠️ 调试检查点**:
- JSON.parse 失败时的 fallback 正则提取是否正常
- content 字数是否 ≥ 200（不足则截断/拒绝）
- embedding API 调用失败时是否优雅降级（记忆仍保存但无向量）
- 记忆 ID 生成是否避免冲突

---

## 总结: Debug 工具检查清单

| # | Agent | 关键检查点 | 严重度 |
|---|-------|-----------|--------|
| 1 | vars_update | JSON.parse 失败静默跳过 → 需 log | 🟡 |
| 2 | vars_update | delta_time 是否正确定时推进 | 🟡 |
| 3 | char_update | 输出未被 processStageMarkers 自动消费 | 🔴 |
| 4 | craft_gen | story 是否输出 `<craft_request>` 标记 | 🟡 |
| 5 | craft_gen | 工具调用顺序: get_character → get_inventory → craft_check → craft_settle | 🟡 |
| 6 | craft_gen | craft_check/craft_settle 返回的 DC/骰值是否被 AI 直接引用（禁止编造） | 🟡 |
| 7 | char_gen | story 是否输出 `<char_detect>` 标记 | 🟡 |
| 8 | char_gen | 工具调用完整性: 查重→name→hair→eye→appearance→personality→attributes | 🟡 |
| 9 | char_gen | 属性是否在层级约束范围内（tier 上限+总和） | 🟡 |
| 10 | item_gen | ADR-26: 是否在 char_gen 后恰好调用 1 次 | 🟡 |
| 11 | item_gen | `ItemGenOutput['skills']` 缺 effects/scripts → 类型层修复 | 🔴 |
| 12 | item_gen | `parseSkillsXML()` 不解析子元素 → 解析层修复 | 🔴 |
| 13 | item_gen | `assembleCharacterState()` 不传递 effects/scripts → 组装层修复 | 🔴 |
| 14 | item_gen | 模板不指导 AI 生成脚本 → 模板层修复 | 🔴 |
| 15 | memory_summary | JSON 解析失败时的 fallback | 🟡 |
| 16 | memory_summary | content ≥ 200 字强制约束 | 🟡 |
| 17 | memory_summary | embedding 失败时优雅降级 | 🟢 |
