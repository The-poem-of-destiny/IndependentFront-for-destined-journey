# AI 状态读写改为「状态树投影 + 路径补丁」（MVU 形状）设计

> **状态：设计稿，未实施（2026-11-22；同日按主人裁定修订：背包与装备分字典、上限拆基础与额外、文本时长与消耗字段，新增变量修改器与可见更新块，其余 18 项逐条裁定完毕，见 §9）。** 设计层面已无待裁定项。
> 涉及：`src/core/variables/`、`src/core/agents/direct-*.ts`、`src/core/prompts/direct-*.ts`、`src/core/state/patch-rules.ts`。
> 前置必读：数据字段规范（`docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`）、[直出模式](../reference/direct-generation.md)、[缓存直出](../reference/direct-generation-cache.md)。

## 0. 结论

- **内核存储形状基本不动**：`CharacterState` / `SaveProfile` / `StatePatch` / `StateManager`（ADR-21）照旧，只追加几个可选字段（§5.6、§5.7）。
- **AI 读到什么就写什么**：读到一棵中文键、按名字作键的状态树；写的是同一棵树上的路径。
- **写入语法**：JSON Patch 形状的操作数组，op 只有 `replace` / `add` / `remove` / `delta` / `move`。
- **容错**：值先过纠正，纠正不了才丢那一条 op。
- **背包与装备分两个字典**，与原卡一致（2026-11-22 主人裁定）；内核仍以 `equippedSlot` 为单真源。
- **上限拆成 `{_基础, 额外}`**（2026-11-22 主人裁定）：基础由代码按公式推导，额外由 AI 写；顺带修掉「上限不随升级重算」。
- **玩家可手改**：新增变量修改器（§11）；每楼的变量更新块可见、可改、默认折叠（§12）。两者与 AI 写入走同一套路径 op、同一个纠正与翻译层。
- **先做直出，后做 Agent 模式**；用全局设置切换新旧协议，不新增生成模式。
- **外壳标签名不变**（`<direct_state>` / `<direct_context>` / `<direct_updates>`）。

## 1. 现状核实（2026-11-22 读码）

### 1.1 写入契约的问题

| 问题                                                                                                                                                          | 位置                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 读写两套字段名：输入是存档英文字段，新建实体用协议字段，协议要专门提醒「不要照抄」                                                                            | `src/core/prompts/direct-prompt.ts` 实体结构行                                     |
| 领域专用 op 多，各有形状和白名单                                                                                                                              | `src/core/agents/direct-contract.ts`                                               |
| 状态写入相关的协议行（顶层键说明到 effects 行）源码约 4.8k 字符，整份协议约 9.8k                                                                              | `direct-prompt.ts` 第 66–85 行，2026-11-22 实测源码字符（含插值占位）              |
| Agent 模式有第三套词汇：`vars_update` 读文本区块，写英文 path 的 JSON 加 `<status_effects>` XML；Delta 会话的 `<context_delta>` 又是按 scope/field 的英文字段 | `vars-update-translator.ts`、`agent-orchestrator.ts`、`prompt-state-projection.ts` |
| 直出提交是整楼事务，任一补丁抛错整楼失败，靠建补丁预演兜                                                                                                      | `StateManager.commitDirectTurn`、`direct-output.ts` 的 `PatchRehearsal`            |

### 1.2 代码把守的不变量（翻译层必须走既有 op）

| 不变量                                                                   | 把守处                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| hp/mp/sp 在 [0, 上限]                                                    | `applySetResource` / `applyDeltaResource` / `applyUpdateCharacter`                                 |
| 主角经验 → 等级、层级、升级所需经验、属性点、里程碑属性、登神关卡        | `character/exp-table.ts`，由 `applyPlayerProgression` 调用（`totalExp` 或 `ascension` 被写时触发） |
| 物品数量守恒：不足即抛、转移原子、堆叠不可穿戴、同槽顶替、槽位枚举       | `applyRemoveItem` / `applyTransferItem` / `applyEquipItem`                                         |
| 好感度钳在 [-100, 100]                                                   | `applyAffection`                                                                                   |
| 命运点数走账本                                                           | `addFP` / `spendFP`（`state/save-profile.ts`）                                                     |
| 时间只能经 `applyTimeAdvance(分钟)` 前进，带天气、随机事件、地块结算钩子 | `state-manager.ts`                                                                                 |
| 地点必须走 `set_location`，才会触发地图落位、首访、随机事件钩子          | `applySetLocation`                                                                                 |
| 名字是逻辑键，同档唯一；改名走 `rename_character`（迁移好感度键）        | `applyAddCharacter` / `applyRenameCharacter`                                                       |
| 年龄只读                                                                 | `character/character-age.ts`                                                                       |

### 1.3 可放宽为文本的字段（grep 核实：没有做算术或倒计时的读者）

| 字段                                              | 实际读者                                                                                                                              | 结论                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `StatusEffect.effects` 数值表                     | 只有战斗沙盒透传；直出建补丁已强制清成 `{}`                                                                                           | 不投影，词条一律进 `effectDescriptions` |
| `StatusEffect.remainingTime` + `timeUnit`         | 叠层刷新取 max、`update_status_effect`、daily_check 翻译、UI 显示、EJS `stats` 的「剩余时间 / 时间单位」。`applyTimeAdvance` 已不扣减 | 线上用文本，内核保留数值加单位          |
| `carryMinutes` / `lifecycle` / `sourceKey`        | 只被清零，或只在无生产引用的 `effects/buff-registry.ts` 里读                                                                          | 不投影                                  |
| `Skill.cost` 对象                                 | 只被格式化成字符串（`combat/sandbox/state.ts` 的 `toCombatSkill`、几处 UI）                                                           | 线上用文本                              |
| `Skill.cooldown` / `maxCooldown`                  | EJS「剩余冷却」与 UI 显示，无扣减代码                                                                                                 | 有值才投影                              |
| `skillPower` / `relevantAttribute` / `damageType` | Agent 模式战斗沙盒建单位时带出、UI 显示；`calc_damage` 的参数由 AI 传                                                                 | 有值才投影，可写                        |
| `InventoryItem.stats` / 耐久                      | UI 显示与品质推断                                                                                                                     | 有值才投影，可写                        |

### 1.4 顺带发现的坑

- **金钱没有下限**：`update_character` 的 delta 是裸加法，可以减成负数。纠正层钳制（§5.2）。
- **命运点不足会抛**：`spendFP` 抛错，在 `commitDirectTurn` 里等于整楼失败。纠正层钳制（§5.2）。
- **上限只在建角时算一次**（`calcResources`），升级后不重算；直出白名单也没有 `maxHp`。本设计在 §5.6 修掉。
- **同名物品叠到已穿戴的那件上**：`applyAddItem` 对同名只加数量，不看是否穿戴，会出现「穿着的物品数量为 2」。内核没有拆堆 op。本设计只在翻译层记录说明，不改内核（§5.3、§10）。

## 2. 范围与迁移顺序

| 写入路径                                                                        | 本设计的处置                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 直出 `direct_updates`（`direct` 与 `direct_cached`）                            | **第一期**迁移                                                     |
| Agent 模式 `vars_update`（`<json>` 加 `<status_effects>`）                      | **第二期**迁移                                                     |
| Agent 模式 `daily_check`                                                        | 第二期一并迁（同一棵树、同一语法）                                 |
| `request_dispatcher` 的 world 变量写入                                          | 第二期：变量走 `/变量/…` 路径                                      |
| `tile_ops` 六个地块 op、`delta_time` 字段                                       | 不迁。低频，已有「解析失败不否决」语义，地图模块有零中文字面量闸门 |
| `<character_updates>`（档案与经历）                                             | 不迁，协议文字不动。见 §5.5                                        |
| `plot` / `diceUsed` / `combat`、entity_gen / craft_gen 的 XML、战斗沙盒终局写回 | 不迁                                                               |

**先做直出**，理由：

1. 读写不对称在直出最严重（同一次请求里读存档字段名、写协议字段名）。
2. 单次请求「看树写树」最接近 MVU 的用法，收益能直接量出来。
3. 直出提交是整楼事务，写错的代价最高。
4. 协议在引擎里，不依赖内容仓先改 Agent 提示词。

**切换开关（已裁定 2026-11-22：全局设置）**：

- 推荐：全局设置 `stateProtocol: 'legacy' | 'tree'`，经 `runtime/engine-settings.ts` 注入缝读，缺省 `legacy`，每轮只取一次。先例是 `directStructuredCombat`。
- 不新增生成模式，`generationMode` 的建档固定约定不动。
- 可以不钉在存档上的依据：内核存储完全不变，协议只是线上格式，同一个档来回切没有数据后果。`direct_cached` 每切一次冷建一次（协议文字进签名）。
- 备选：建档时写 `metadata.stateProtocol` 钉死。代价是旧档永远走旧协议，两套协议、两套闸门、内容包两套措辞长期并存。

**并存期的回落**：新协议下若模型仍写了旧形状（对象里有 `state` / `entities` / `effects` 而没有 `patch`），交给旧解析器处理并记一条纠正。旧档未被接纳的开局提示词里还写着旧字段名，也靠这条兜住。旧协议删除时这条一并删。

## 3. 状态树规格

### 3.1 骨架

```
stat_data:
  世界: {时间: "<formatGameTime 规范串>", 地点: "<主角位置路径>", _时段, _天气, _回合}
  命运点数: 100
  主角: <人物节点>
  关系列表: {<名>: <人物节点> + {在场, 地点, 好感度} | <不在场摘要>}
  任务列表: {<任务名>: {状态, 关注度, 进展, 详情, 目标, 奖励}}
  新闻: {<栏目>: {<标题>: 正文}}        # 只投最近若干条，只增不删
  变量: <SaveProfile.variables 原样>     # ADR-30 vars 空间，键不翻译

<人物节点>（每个直接子键是一个缓存分区，见 §3.4）:
  档案: {种族, 性别, 身份[], 职业[], _年龄, _生日, 外貌, 着装, 性格, 背景故事, 类别?}
  成长: {_生命层级, 等级, 累计经验值, _升级所需经验, _属性点, _属性{力量,敏捷,体质,智力,精神}}   # 等级：NPC 可写，主角只读（§3.3）
  生命值: {当前, 上限: {_基础, 额外}}   法力值: {同}   体力值: {同}
  金钱   当前行动   心里话
  背包: {<物品名>: {品质, 类型, 数量, 位置?, 标签[], 效果{词条:文本}, 描述, 属性{}?, 耐久{当前,上限}?, 规则文本?}}
  装备: {<物品名>: {品质, 类型, 位置, 标签[], 效果{}, 描述, 属性{}?, 耐久{}?, 规则文本?, 数量?}}
  技能: {<技能名>: {品质, 类型:主动|被动, 消耗:文本, 冷却?, 标签[], 效果{}, 描述, 威力?, 关联属性?, 伤害类型?, 规则文本?}}
  状态效果: {<名>: {类型:增益|减益|特殊, 描述, 效果{}, 层数, 层数上限?, 剩余时间:文本, 来源}}
  登神长阶: {是否开启, 要素{<名>:{描述,效果{}}}, 权能{<名>:{描述,效果{},消耗}}, 法则{…}, 神位, 神国{名称,描述}}
```

- `背包` 只放 `equippedSlot` 为空的物品，`装备` 只放已穿戴的物品。内核同一人物下物品名唯一，所以同一个名字不会同时出现在两个字典。
- `装备` 条目的 `位置` 就是 `equippedSlot`。`数量` 只在大于 1 时出现（见 §1.4 第四条的遗留情形）。
- `背包` 条目不带 `位置`，不记适配槽位（§9 #9）；穿戴时由 op 自带位置（§5.3）。
- 上限的总值不单独投影：有效上限 = `_基础 + 额外`，AI 看两项即可。
- 怪物和召唤物也住 `关系列表`，`档案.类别` 标「怪物 / 召唤物」，带 `数量`。
- 地图上下文、`plotSettings`、`plot`、`openingPrompt`、`combat` 仍是 `direct_state` 里与 `stat_data` 并列的原有键，不进树。
- 原卡的 `事件` 簿记、`date` 块、`_隐藏`、`资产`、`命定契约` 在内核没有对应字段，不投影。内容需要时可以放进 `变量`。

### 3.2 与原卡结构的对照

| 对照点     | 本设计                                                                                                        | 状态                             |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 背包与装备 | 两个字典，装备按物品名作键、条目带 `位置`                                                                     | 已裁定（2026-11-22），与原卡一致 |
| 上限       | `上限: {_基础, 额外}`                                                                                         | 已裁定（2026-11-22），与原卡一致 |
| 剩余时间   | 文本；能解析的落数值加单位，解析不了的落 `durationText`                                                       | 已裁定（2026-11-22）             |
| 技能消耗   | 文本；能解析的落 `cost`，解析不了的落 `costText`                                                              | 已裁定（2026-11-22）             |
| 档案字段   | 收进 `档案` 子树                                                                                              | 设计决定，与原卡不同             |
| 位置词汇   | 只认内核槽位：武器 / 副手 / 头部 / 身体 / 手部 / 脚部 / 腰带 / 饰品；原卡「手持」等词不加别名，协议列出可选值 | 已裁定（2026-11-22）             |

与原卡仍有的两处硬差异，来自内核约束，本期不改：

- **同槽只能穿一件**。原卡若允许多件饰品，这里后穿的会顶掉先穿的。
- **堆叠物品不能穿戴**。内核没有拆堆 op，数量大于 1 的物品穿戴会被拒。

备注（未采用）：装备字典按槽位作键（`装备.武器 = {...}`）时，穿戴的目标路径自带槽位，顶替关系也一目了然。主方案按裁定用物品名作键；穿戴必须在 op 里写明位置。

### 3.3 只读键

- **以 `_` 开头的键只读**，树上一眼可见，协议里只需一句话。这是本项目自己的约定，不依赖 MVU 的实现。
- AI 写只读键：丢该条 op，记「由代码维护」。路径解析时忽略 `_` 前缀，所以写 `/主角/成长/等级` 也能得到这条提示。
- `上限._基础` 只读，`上限.额外` 可写。AI 若直接把 `上限` 写成一个数，按「额外 = 该数 − 基础」纠正并记录。
- `等级`：**NPC 可由 AI 写**（已裁定 2026-11-22），写入后代码按等级推出层级、重算基础上限（§5.3、§5.6）；**主角仍只读**，由经验表推导，写入丢弃并提示「请改累计经验值」。
- 玩家在变量修改器里看到的只读键：见 §11.3。

### 3.4 可见性、字节稳定与缓存

**可见性**：

- 全量节点：主角、在场角色、本轮输入点到名的角色、结构化战斗的参战者（沿用 `direct-main.ts` 现有判据）。
- 其余角色给摘要：`{在场: false, 地点, 好感度}`，取代现在的 `existingNames`。
- 路径解析对的是完整内核状态，不是投影出来的那部分。所以可以写摘要角色的任何叶子。
- 长存档里摘要的 token 成本要实测，过大就退回只给名字。

**字节稳定**：

- 投影是纯函数：无 I/O、无时钟、无随机；`undefined` 不出键。
- 人物节点键序固定；Record 按内核数组顺序。
- 缓存直出经 `serializeDirectContext` 再做键排序。

**`direct_cached` 分区**：

- 分区键就是树路径，值整块替换该路径。未出现的路径沿用最近值，`remove` 删除路径。只有「替换」一种语义。
- 切点固定：`/世界`、`/命运点数`、`/新闻`、`/变量`、`/任务列表/<名>`、每个全量人物节点的每个直接子键（含 `背包` 与 `装备` 两个分区）、每个摘要角色整块。
- 改 HP 只重发 `/主角/生命值`。
- 记忆、世界书、地图等原有分区不动。
- 尾部现值重申（现在的 `CURRENT_SECTIONS`）改由调用方指定键：在场角色的 `生命值` / `法力值` / `体力值` 三个分区，加上 `combat`。
- `DIRECT_CACHE_PROTOCOL` 出一份对应措辞。切换协议时每档冷建一次。

**Agent 模式 Delta 会话**（第二期）：

- `PromptScope` 加 `state_tree`：`upsert name=<路径>` 整块替换，`remove` 删除。
- 与缓存直出共用同一个切分函数。
- 新占位符 `{{STATE_TREE}}`。

**与 EJS 的关系**：`character/stat-projection.ts` 的 `buildStatData` 是给世界书 EJS 的创作者契约（背包是数组、键叫「名字」），不改、不合并。两者只共用键名词表。

## 4. 写入语法

### 4.1 选型：JSON Patch 形状的操作数组

不选 `_.set('路径', 旧值, 新值)`，理由：

- 命令式要自写分词器（引号、逗号、嵌套对象）。JSON 可以复用 `utils/model-json.ts` 和现有逐行丢弃的设施。
- 内核本来就有 RFC 6902 一族的变量 op（`remove_variable` / `move_variable` / `insert_variable`）。
- 命令式天然「一行坏只丢一行」，JSON 数组用**逐元素恢复**补上：整段 `JSON.parse` 失败时，按花括号配对逐个抠出含 `"op"` 的对象单独解析，坏的丢掉。截断输出也能保住前半段。

> 未核实项：2026-11-22 查 [MagVarUpdate 仓库首页](https://github.com/MagicalAstrogy/MagVarUpdate) 与其 [tutorial](https://raw.githubusercontent.com/MagicalAstrogy/MagVarUpdate/master/doc/tutorial.md)，只见到 `_.set` 一种命令。JSON Patch 模式的 op 清单、`_` 只读约定、zod 的用法都没找到文字说明，以主人手上的角色卡为准。本设计不依赖这些细节。

### 4.2 线上形状（直出）

```
<direct_updates>
{"version":2,"patch":[
 {"op":"delta","path":"/世界/时间","value":45},
 {"op":"delta","path":"/主角/生命值/当前","value":-30},
 {"op":"delta","path":"/主角/背包/治疗药水/数量","value":-1},
 {"op":"add","path":"/主角/背包/狼牙","value":{"类型":"材料","数量":2,"描述":"…"}},
 {"op":"move","from":"/主角/背包/铁剑","path":"/主角/装备/铁剑","value":"武器"},
 {"op":"delta","path":"/主角/生命值/上限/额外","value":50},
 {"op":"add","path":"/主角/状态效果/流血","value":{"类型":"减益","描述":"…","剩余时间":"3回合"}},
 {"op":"delta","path":"/关系列表/艾拉/好感度","value":5}
],"plot":{},"diceUsed":[]}
</direct_updates>
```

- 只有 `patch` 是主体。`plot` / `diceUsed` / `tile_ops` / `combat` 缺了按空处理。
- Agent 模式：`<json>{"patch":[…]}</json>`，`<status_effects>` 在新协议下不再使用。

### 4.3 op 集合

| op        | 语义                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `replace` | 把路径的值设为 `value`。目标不存在且 `value` 是整实体时按新建处理                                                             |
| `add`     | 在 Record 下新增条目（整实体值）。目标已存在时按内核的「再获得 / 再施加」语义：物品叠数量、状态叠层、技能合并字段、任务合并   |
| `remove`  | 删除条目或变量                                                                                                                |
| `delta`   | 数值叶子加 `value`，可为负                                                                                                    |
| `move`    | `from` → `path`。背包 ↔ 装备是穿戴与卸下，穿戴时 `value` 可给位置；同一字典内是改名；跨人物是转移，`value` 可给数量，缺省整叠 |

**保留 `delta`**，理由：

- 消耗和增减是最高频的写入，增量不依赖模型把当前值读对。缓存会话里旧值散在多轮，更容易读错。
- 库存守恒检查本来就是按增量做的。
- `replace` 数值同样接受，由翻译层换算成差量。

**别名**（纠正并记一条）：

- op：`set` / `update` / `assign` → `replace`；`insert` / `push` / `append` → `add`；`delete` / `unset` → `remove`；`inc` / `increment` → `delta`。缺 op 但有 `value` → `replace`。
- 路径：接受 `/a/b`、`a.b`、带 `stat_data` 前缀、数组段三种写法。

**顺序**：按 AI 写的顺序逐条作用在一份影子状态上，所以「先 add 再穿戴」「先 remove 再 add」自然成立。唯一例外是新建人物先于其他 op 落下。

### 4.4 新建实体通道

线上不另设语法。**往 Record 下写一个整对象就是新建**，值的形状与树上同类条目相同（读写同构）。

- 翻译层识别「实体根路径」：`/关系列表/<名>`、`…/背包/<名>`、`…/技能/<名>`、`…/状态效果/<名>`、`/任务列表/<名>`、`登神长阶` 的三个列表。
- 命中后不做逐叶映射，走**独立的组装管线**：
  - 人物：`assembleCharacterState` + `bindGeneratedCharacter`（资源上限、年龄锚点、作者定义绑定），产出 `add_character`。
  - 物品、技能、状态：补默认后产出 `add_item` / `add_skill` / `add_status_effect`。
- 新建人物的必需核心：`成长.等级`（层级由代码按等级推出）、`成长.属性` 五维、`地点`、`在场`。
- 缺核心时：丢整个人物（已裁定 2026-11-22，与现状一致）。按层级基线补属性属于数值裁定，不在本设计内替主人决定。
- 人物内部的坏条目只丢那一条（沿用现状）。

没有采用「另设 `新建` 数组」的原因：模型得先判断新旧再选通道，判错的那条还是要兜，等于两套语法。若主人坚持线上独立通道，翻译层的管线不变，只是多认一个入口。**已裁定（2026-11-22）：同构整对象。**

## 5. 纠正层与翻译层

### 5.1 处理流程（每条 op）

1. 解析路径：逐段对「键词表 + 影子状态」匹配。
   - 精确匹配 → 忽略 `_` 前缀 → 旧协议英文字段别名（`hp` / `inventory` / `statusEffects` 等）。
   - 名字段：精确名 → `resolveCharacterByName`（别名、「主角 / 玩家」）→ 把剩余段拼接起来再试（名字里含 `/` 或 `.` 时）。
   - **不做模糊匹配。**
2. 按叶子类型纠正值。
3. 映射成 `StatePatch`。
4. 用 `validateStatePatch` 和预演（从 `direct-output.ts` 抽出共用）核一遍。
5. 作用到影子状态。

### 5.2 纠正规则

| 叶子类型       | 纠正                                                                                                                                                             | 仍丢弃的情形           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 数值           | 数字字符串转数字；`"80/120"` 取首个数；要整数的四舍五入                                                                                                          | NaN、Infinity、对象    |
| 资源当前值     | 结果钳到 [0, 有效上限]                                                                                                                                           | —                      |
| 上限的 `额外`  | 整数，可为负；钳到「基础 + 额外 ≥ 1」                                                                                                                            | —                      |
| 上限写成单个数 | 换算成「额外 = 该数 − 基础」并记录                                                                                                                               | —                      |
| 金钱           | 结果钳到不小于 0（已裁定 2026-11-22，不允许负债）                                                                                                                | —                      |
| 命运点数       | 结果钳到不小于 0，换算成账本增量                                                                                                                                 | —                      |
| 好感度         | 钳到 [-100, 100]                                                                                                                                                 | —                      |
| 数量           | 整数；小于等于 0 视为移除；扣减超过持有量时钳到持有量并记录                                                                                                      | —                      |
| 层数           | 整数；小于等于 0 视为移除状态；受层数上限封顶                                                                                                                    | —                      |
| 枚举           | **只查 `content/field-enums.ts` 的别名表**，不做模糊匹配。品质认不出则省略；状态分类兜底「特殊」；任务状态兜底「进行中」；关注度兜底「中」；技能类型兜底「主动」 | —                      |
| 位置（装备槽） | 过 `normalizeSlot`；空串、`null`、「无」、「背包」视为卸下                                                                                                       | 槽位认不出（不猜穿哪） |
| 文本           | 数字和布尔转字符串，去首尾空白                                                                                                                                   | 对象                   |
| 文本数组       | 字符串按顿号、逗号、斜杠拆开；非字符串元素剔除                                                                                                                   | —                      |
| 词条字典       | 字符串转 `{效果: 文本}`；数组合并成一条                                                                                                                          | —                      |
| 布尔           | 认「是 / 否 / 在场 / 离场 / true / false / 1 / 0」                                                                                                               | 其他                   |
| 剩余时间       | 认「数字 + 回合 / 分钟 / 小时 / 天 / 周」，天和周折成小时；「永久 / 直至解除」视为永久；其余文本原样存进 `durationText`                                          | 不丢                   |
| 技能消耗       | 认「数字 + HP / MP / SP（或 生命 / 法力 / 体力）」；其余文本原样存进 `costText`                                                                                  | 不丢                   |
| 时间           | `delta` 的值是分钟，不能为负；`replace` 成时间串时用 `parseGameTime` 解析后与当前时间求差                                                                        | 时间倒退、解析不了     |
| 整实体值       | 名字以路径键为准；缺省补齐（数量 1、层数 1、分类「特殊」、描述空串、任务用 `createDefaultQuest`）；未知键剥除并记录                                              | 人物缺核心             |

**解析不了的时长和消耗文本（已裁定 2026-11-22）**：新增可选字段 `StatusEffect.durationText?` 与 `Skill.costText?`。两条互斥规则由 `StateManager` 把守：

- 状态：有 `durationText` 时 `remainingTime` 存 `null`。之后任何一次写入数值或 `null` 的 `remainingTime`（含 daily_check 的 `update_status_effect`），同时清掉 `durationText`。
- 技能：写入可解析的消耗时设 `cost` 并清 `costText`；不可解析时设 `costText` 并清 `cost`。

需要改成「优先显示文本」的读者见 §5.7。

**原卡槽位词不加别名（已裁定 2026-11-22）**：`位置` 只认 `normalizeSlot` 现有的内核槽位词与别名，协议列出可选值；写「手持」这类词的穿戴丢弃并说明。

### 5.3 路径到 StatePatch 的映射

`<P>` 是 `/主角` 或 `/关系列表/<名>`。

**标量与人物字段**

| 路径                              | 映射                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/世界/时间`                      | 不产补丁，汇总成本楼分钟数交给 `applyTimeAdvance`。顶层 `time.delta_time` 作为可接受的旧写法                   |
| `/世界/地点`，`<P>/地点`          | `set_location`                                                                                                 |
| `/命运点数`                       | `delta_variable profile.fp`；`replace` 换算成差量                                                              |
| `<P>/生命值/当前`（法力、体力同） | `set_hp` / `delta_hp`                                                                                          |
| `<P>/生命值/上限/额外`            | `update_character {maxHpBonus}`，`delta` 带 `metadata.delta`；有效上限由代码重算（§5.6）                       |
| `<P>/生命值/上限`（写成单个数）   | 纠正为额外后同上                                                                                               |
| `<P>/金钱`                        | `update_character {money}`                                                                                     |
| `<P>/成长/累计经验值`             | `update_character {totalExp}`，升级由代码接管                                                                  |
| `<P>/成长/等级`                   | NPC：`update_character {level, tier}`，`tier` 由代码按等级推出，随后重算基础上限；主角：丢弃并提示改累计经验值 |
| `<P>/当前行动`、`心里话`、`在场`  | `update_character`                                                                                             |
| `<P>/好感度`                      | `set_affection` / `delta_affection`                                                                            |

**背包与装备**（内核真源是 `inventory[].equippedSlot`；物品名在同一人物下唯一）

| 写法                                                             | 语义                                           | 映射                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `add <P>/背包/<物>`，物品不存在                                  | 获得新物品                                     | `add_item`（`equippedSlot` 为空）                                                                   |
| `add <P>/背包/<物>`，物品在背包                                  | 再获得                                         | `add_item` 叠数量                                                                                   |
| `add <P>/背包/<物>`，物品在装备                                  | 再获得一件同名物品                             | `add_item` 叠到已穿戴的那件上，并记录「同名物品已穿戴，数量叠在装备上」。这是内核按名唯一带来的限制 |
| `<P>/背包/<物>/数量` 或 `<P>/装备/<物>/数量`                     | 增减                                           | 增：`add_item`；减：`remove_item`；到 0：`remove_item` 全部                                         |
| `remove <P>/背包/<物>`                                           | 物品离开人物                                   | `remove_item` 全部                                                                                  |
| `remove <P>/装备/<物>`                                           | **物品离开人物（销毁、丢弃、被夺）**，不是卸下 | `remove_item` 全部。卸下必须 `move` 回背包。此语义与原卡一致，见 §9 #11                             |
| `move <P>/背包/<物>` → `<P>/装备/<物>`                           | 穿戴                                           | `equip_item {name, slot}`。槽位取值顺序见下                                                         |
| `move <P>/装备/<物>` → `<P>/背包/<物>`                           | 卸下                                           | `unequip_item {name}`                                                                               |
| `add <P>/装备/<物>`，物品在背包                                  | 穿戴已有物品                                   | `equip_item`；值里其余字段并入 `update_item`                                                        |
| `add <P>/装备/<物>`，物品不存在                                  | 获得并直接穿上                                 | `add_item`（不带槽位）+ `equip_item` 成一组。不能让 `add_item` 直接带槽位：它不处理同槽顶替         |
| `add <P>/装备/<物>`，物品已在装备                                | 改字段或换槽                                   | `update_item`；`位置` 不同时再 `equip_item` 到新槽                                                  |
| `replace <P>/装备/<物>/位置`                                     | 换槽；写成空值视为卸下                         | `equip_item` / `unequip_item`                                                                       |
| `replace <P>/背包/<物>/位置`                                     | 背包物品不记位置                               | 丢弃并说明「穿戴请 move 到装备并写位置」                                                            |
| 同一批里 `remove <P>/背包/<物>` 加 `add <P>/装备/<物>`（或反向） | 原卡常见的「删一边、加一边」写法               | 翻译前先折叠成一条 `move`，避免物品字段随删除丢失；`add` 值里的字段并入 `update_item`               |
| `<P>/背包或装备/<物>/<其余叶子>`                                 | 改字段                                         | `update_item {name, changes}`                                                                       |
| `move` 到另一人物的 `背包`                                       | 转移                                           | `transfer_item {name, to, quantity}`；从装备转出时接收方收到的是未穿戴物品                          |
| `move` 到另一人物的 `装备`                                       | 转移并穿戴                                     | `transfer_item` + 接收方 `equip_item` 成一组                                                        |
| `move` 同一字典内改名                                            | 改名                                           | `remove_item` + `add_item` 成一组，字段与 `equippedSlot` 照搬                                       |

穿戴时的槽位取值顺序：

1. 该条 op 的 `value`（字符串，或含 `位置` 的对象）。
2. 同一批里后面对 `<P>/装备/<物>/位置` 的写入。
3. 都没有：丢该条，说明「缺少位置」。

其余规则：

- **同槽顶替**：目标槽已有穿戴者时，内核自动把它卸下。翻译层记一条说明「〈旧物〉已自动卸回背包」，下一次投影它出现在 `背包`。
- **堆叠物品穿戴**：数量大于 1 时内核拒绝。翻译层丢该条并说明。
- 成组的补丁整组落或整组丢。

**技能、状态、登神、任务、新闻、变量、人物**

| 路径                                 | 映射                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `<P>/技能/<名>`                      | `add_skill` / `update_skill` / `remove_skill`；`消耗` 按 §5.2 落 `cost` 或 `costText`                            |
| `<P>/状态效果/<名>` 整对象           | `add_status_effect`，词条进 `effectDescriptions`；`剩余时间` 按 §5.2 落数值或 `durationText`                     |
| `<P>/状态效果/<名>/剩余时间`、`层数` | `update_status_effect`                                                                                           |
| `<P>/状态效果/<名>/<其余叶子>`       | 读出现值后删旧加新成组（内核没有改描述的 op）                                                                    |
| `<P>/状态效果/<名>` `remove`         | `remove_status_effect`                                                                                           |
| `<P>/登神长阶/…` 任意写              | 用「影子现值 + 本条」重建整份，再 `update_character {ascension}`                                                 |
| `/任务列表/<名>`（整对象或叶子）     | `update_quest`；`remove` 对应 `remove_quest`                                                                     |
| `/新闻/<栏目>/<标题>` `add`          | `add_news`；`remove` 丢弃并记录（只增）                                                                          |
| `/变量/<…>`                          | `set_variable` / `delta_variable` / `remove_variable` / `insert_variable` / `move_variable`。段内含 `.` 的丢该条 |
| `/关系列表/<新名>` 整对象            | §4.4 的人物组装管线                                                                                              |
| `/关系列表/<名>` `move` 改名         | `rename_character`                                                                                               |
| `/关系列表/<名>` `remove`            | `remove_character`，AI 只对怪物和召唤物放行                                                                      |
| `<P>/档案/<文字字段>`                | 见 §5.5                                                                                                          |
| `_` 开头的键，以及树外的路径         | 丢该条                                                                                                           |

`/变量/…` 的 ADR-30 仲裁不变：翻译出的仍是 `set_variable` 一族，EJS 差量先落、AI 补丁后落的顺序由 `commitAiPatches` 保证。

### 5.4 丢弃单元与整楼拒收

**丢弃单元**：

- 一条 op。
- 成组的删旧加新，整组落或整组丢。
- 新建人物内部的单个随身条目。
- 每条丢弃记「模型原文路径：原因，已忽略」，纠正记入 `normalized`。沿用 `DirectTurnDraft.dropped` / `normalized` 与 `outputWarnings`。

**仍整楼拒收**（比现状少一项）：

- 正文信封缺失或正文为空。
- `direct_updates` 不是恰好一个闭合区块。
- 区块非空，但逐元素恢复后一条 op 都没救回来。
- 任何层级出现原型污染键。
- 结构化战斗开启时 `combat` 有问题。
- 提交事务失败。

world 路径命中系统保留段不再整楼拒收：新协议里树外路径根本解析不到，只丢那一条。

零个开标签照旧按空更新接纳，并提示。

### 5.5 档案文字与 `character_updates`

- 档案和经历仍由 `<character_updates>` 管，协议文字不动（它与 Agent story、Story v2 共用，改了会让它们重基线）。
- 树上的 `档案` 文字字段若被路径写入：翻译层转成一条 `CharacterNarrativeUpdate.profile_changes`，并进本楼的叙事更新，不丢。
- 是否把它扶正为主写法、让 `character_updates` 只留经历：见 §9。

### 5.6 资源上限拆分的内核设计（已裁定 2026-11-22）

**字段**

- 新增三个可选字段：`CharacterState.maxHpBonus?` / `maxMpBonus?` / `maxSpBonus?`（整数，可为负，缺席按下面的规则读）。
- `maxHp` / `maxMp` / `maxSp` **保留，仍存有效总值**。现有读者全部不用改。
- 基础值不落库，恒由公式现算：`calcResources(tier, attributes)`（`character/tier-constants.ts`，建角与 entity_gen 现在用的就是它）。

**不变式**（新增纯函数模块 `character/resource-caps.ts`，读写两侧共用）

- `基础 = calcResources(tier, attributes)` 的三个上限。
- `额外 = maxHpBonus`；字段缺席时读作 `maxHp − 基础`。
- `有效上限 = max(1, 基础 + 额外)`，写回 `maxHp`。

**旧档迁移：不升 Dexie 版本，不做批量迁移**

- 缺席的 `额外` 读作「现上限 − 公式基础」，所以旧档的总上限一分不变。
- 这与「基础 = 现 maxHp、额外 = 0」的直觉不同。不采用后者的原因：那样基础必须落库，而且第一次重算时旧档里手写进上限的加成会被公式值盖掉。
- 实际效果：建角与 entity_gen 生成的角色，现上限本来就等于公式值，额外读出来是 0；被 daily_check 改过上限的旧角色，差值原样变成额外。
- 首次写入时把读出的额外固化进字段（见触发点第一步）。

**重算触发点**（全部收在 `StateManager.applyUpdateCharacter` 与 `applyAddCharacter`）

1. 补丁落地**之前**：若 `额外` 字段缺席，先按「现上限 − 旧基础」固化。必须在属性或层级变化之前做，否则差值会算错。
2. 补丁落地、升级与登神推进（`applyPlayerProgression`）都跑完**之后**：按新 `tier` / `attributes` 重算三个有效上限。
3. 因此这些情况都会重算：主角升级到里程碑（全属性加一）、层级变化、玩家分配属性点（`character/attribute-allocation.ts` 走的也是 `update_character`）、AI 写 `额外`、NPC 的属性或层级被改。
4. 新建角色（`applyAddCharacter`）：`额外` 缺席时置 0，并重算一次。

**旧写法兼容**

- `update_character {maxHp: n}`（Agent 模式 daily_check、旧协议）继续可用：解释为「把总上限设为 n」，换算成 `额外 = n − 基础`。
- `UPDATE_CHAR_WHITELIST` 与数值字段表加入三个 `*Bonus` 键。

**当前值随上限变化的规则**

- 上限下降：当前值钳到新上限。
- 上限上升：当前值不变，不白送恢复（已裁定 2026-11-22）。

**NPC、怪物、entity_gen 生成的角色**：同一条公式。生成时 `额外` 为 0，之后由 AI 按被动技能、装备加成去写。

**受影响的读者（2026-11-22 grep `maxHp|maxMp|maxSp`，非测试）**

读的都是总值，行为不变，无需修改：

- 引擎：`agents/agent-tools.ts`、`character/char-query.ts`、`character/stat-projection.ts`（EJS 的「生命值上限」等三键）、`ejs/ejs-capabilities.ts`、`combat/direct-combat.ts`、`combat/sandbox/{roster,runner,state,tools,types}.ts`、`persistence/database.ts`（快照预览）、`prompts/{context-visibility,direct-context-frame,direct-prompt,prompt-state-projection}.ts`、`variables/daily-check-translator.ts`。
- 前端：`game/StatusOverview.vue`、`CharacterListPanel.vue`、`CharacterViewerModal.vue`、`SnapshotPanel.vue`、`game/combat/{CombatMessageFlow,CombatPanel,CombatSettlementPanel,CombatUnitCard}.vue`、`shared/SaveManager.vue`、`stores/create-store.ts`、`utils/test-save.ts`。

需要改的只有 `state/state-manager.ts`（触发点）和新投影。EJS `stats` 面的键与含义不变，创作者规范不用改。UI 是否显示「基础 + 额外」的拆分属于可选增强，不在本期。

### 5.7 两个文本字段的读者（已裁定 2026-11-22）

规则：`durationText` / `costText` 有值时优先显示它，否则走原来的数值格式化。

| 读者                 | 位置                                                                                                                      | 要做的事                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 状态时长显示         | `ui/components/game/StatusOverview.vue`、`CharacterListPanel.vue`、`CharacterViewerModal.vue`                             | 优先显示 `durationText`（现在会把它显示成「永久」）                               |
| 战斗面板回合数       | `ui/components/game/combat/combat-view.ts`                                                                                | 有 `durationText` 时不算剩余回合                                                  |
| 给 Agent 的状态文本  | `prompts/context-visibility.ts`、`prompts/placeholder-registry.ts`（`ACTIVE_EFFECTS`）                                    | 优先输出 `durationText`。daily_check 读的就是这里，否则它会把条件型状态当永久处理 |
| daily_check 写回     | `variables/daily-check-translator.ts` → `update_status_effect`                                                            | 翻译层不用改；写入数值时长时由 `StateManager` 清掉 `durationText`（§5.2）         |
| EJS `stats`          | `character/stat-projection.ts` 的状态投影                                                                                 | 追加一个键「持续说明」；原有「剩余时间 / 时间单位」不变                           |
| 战斗沙盒             | `combat/sandbox/state.ts` 的 `toCombatStatus` / `toSaveStatus`、`combat/sandbox/types.ts`                                 | 两个方向都带上 `durationText`，否则战斗结束写回时丢失                             |
| 战斗沙盒技能         | `combat/sandbox/state.ts` 的 `toCombatSkill`                                                                              | 消耗字符串优先取 `costText`                                                       |
| 技能消耗显示         | `ui/components/game/StatusOverview.vue`、`cards/ItemSystemCard.vue`、`cards/CharGenSystemCard.vue`、`ui/lib/item-view.ts` | 优先显示 `costText`                                                               |
| 重铸时交给 AI 的现状 | `ui/components/game/ItemsPanel.vue`、`CharacterListPanel.vue`                                                             | 一并带上 `costText`                                                               |
| 落库字面量           | `state/state-manager.ts` 的 `applyAddStatusEffect`、`applyAddSkill`                                                       | 新建时的字段清单是逐项列的，要把新字段加进去，否则落库即丢                        |

不用改的：`context-visibility.ts` 与 `SKILL_STATE` 刻意不显示技能消耗；EJS 技能投影本来就不带消耗。

## 6. 存量兼容

**旧存档**：零迁移，不升 Dexie 版本。

- 新增字段全部可选：`maxHpBonus` 等三个、`durationText`、`costText`、`ChatMessage.stateUpdates`。缺席即旧行为。
- 资源上限：缺席的 `额外` 读作「现上限 − 公式基础」，总上限不变（§5.6）。
- 快照、两种备份、单存档导出都整存整取角色与消息对象，新字段随行。实施时要确认导入侧没有按字段白名单裁剪。
- `openingPrompt` 是建档时落库的文本，旧档里写着旧字段名：
  - 开局回合已被接纳的档不再重发（`d4795698`，2026-11-22）。
  - 未被接纳的边角情形靠 §2 的旧形状回落兜住。
- `prompts/opening-prompt.ts` 的两行直出更新说明改成协议中立的措辞。

**内容包（私有内容仓 `fated_poem_independent_assets`）**：引擎与内容包必须一起发布。2026-11-22 在本机内容仓工作树实测：

| 位置                                                               | 数量    |
| ------------------------------------------------------------------ | ------- |
| 两份 Prime 直出预设的条目文件数                                    | 91 / 90 |
| 其中提到 `direct_updates` 的                                       | 13 / 14 |
| 提到 `direct_state`（无缓存预设）或 `direct_context`（缓存预设）的 | 8 / 8   |
| 写到内部形状（`state.items`、`delta_time` 等）的                   | 个位数  |

- 外壳标签名不变，所以只提区块名的条目不用改。
- 写到内部形状的条目要改成协议中立的说法（例如「在状态更新里声明 HP 变化」），或者改用新路径写法。
- 这批改动是切换默认值的前置条件。
- 第二期还要改 `content/agents/vars_update/system.md`、`request_dispatcher` 的 system 与 template，以及公开仓占位 `public/data/defaults/agent-config.json`。
- 改默认提示词会影响 `agent-defaults-fingerprints.json` 的指纹迁移，实施时按该机制补指纹。

**世界书 EJS 别名层**：不受影响。

- `buildStatData`、`variables.stat_data` 别名、`vars` 草稿都不改。
- 创作者规范不用改。
- 新树的 `变量` 子树与 EJS 的 `vars` 是同一份 `SaveProfile.variables`。

**文档**：实施时同步改 `docs/reference/direct-generation.md`、`direct-generation-cache.md`、`src/core/AGENTS.md`、`src/ui/AGENTS.md`、`docs/CHANGELOG.md`；数据字段规范补一章「状态树投影」；根 `AGENTS.md` 导航树加本文一行；新 ADR 取下一个空号。

## 7. 风险与验证

### 7.1 度量

- **现状**：本机 `tests/realtime_export/` 不存在（2026-11-22），没有可用基线。需要主人提供真实导出。
- **数据源**：
  - DebugPanel 导出的 `fated-poem-debug-*.json`（最近 10 个调试回合，含原始响应与 `outputWarnings`）。
  - 完整运行日志 JSONL：`direct.output_dropped`、`direct.output_normalized`、`direct.updates_missing`、`state.commit`（Agent 模式逐补丁成败）。
- **新增**：每楼一条结构化统计 `stateWriteStats {protocol, ops, applied, corrected, dropped, rejected}`，进 `AgentResult` 和日志事件 `state.write_stats`。配一个离线脚本汇总。
- **指标**：
  - 整楼拒收率。
  - 每楼丢弃数与丢弃率（丢弃 ÷ 全部 op）。
  - 每楼纠正数。
  - 缺区块率。
  - 人工抽检的漏写率（正文里发生了、状态没写，机器量不出来）。
- **做法**：同一存档快照、同一串输入，切换 `stateProtocol` 各跑一轮，按模型分开统计。旧协议的原始响应不能拿新解析器重放，必须真跑。
- **切换默认值的门槛**：已裁定（2026-11-22）——不设硬指标，由主人试玩体感决定；上述指标照常统计，只作参考。

### 7.2 测试与闸门

| 闸门                                              | 断言                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **读写对称闸门**（新，核心）                      | 夹具状态投影出的每个非只读叶子，`replace` 成新值后经翻译和真实 `StateManager`（fake-indexeddb）提交再投影，读回新值。每个 Record 的 add / remove / move 同理。词表里的叶子没登记翻译规则就红 |
| 协议文字闸门（仿 `direct-contract-gate.test.ts`） | 协议由键词表生成；op 名、只读约定句、枚举词表各在指定行；协议里的示例零纠正、零丢弃通过                                                                                                      |
| 分区闸门                                          | 各分区互不重叠，合起来等于整树；同一状态两次序列化字节相同                                                                                                                                   |
| 翻译产物闸门                                      | 合法 op 的翻译产物都能通过 `validateStatePatch` 和预演                                                                                                                                       |
| 纠正表逐行用例                                    | §5.2 每一行一组正反例；逐元素恢复（截断、单条坏 JSON）                                                                                                                                       |
| 既有测试                                          | 旧协议的直出、归一化、契约闸门测试在旧协议删除前保持不动、保持全绿                                                                                                                           |
| 资源上限不变式                                    | 旧档角色（无 `*Bonus`）读出的总上限等于原 `maxHp`；属性或层级变化后有效上限 = 新基础 + 额外；`update_character {maxHp}` 旧写法换算正确                                                       |
| 背包装备语义                                      | §5.3 背包与装备表每一行一组用例；「删一边加一边」折叠后字段不丢；同槽顶替后旧物回到背包                                                                                                      |
| 玩家编辑往返                                      | 修改器对每个可写叶子的编辑提交后读回新值；撤销后读回旧值；整批失败时状态零变化                                                                                                               |
| 更新块补差                                        | 改值、撤销、重新应用三种修订的补偿 op 正确；现值与记录不符时给出冲突提示而不是静默覆盖                                                                                                       |

### 7.3 风险

- **未经真实模型验证**：新协议和 2026-11-21 的「坏项丢弃继续」一样，结论只能来自 §7.1。
- **纠正会掩盖错误**：钳制和补默认让错误写入变成「看起来成功」。所以纠正必须进 `normalized` 和统计，调试面板要能看到。
- **摘要角色的 token 成本**：长存档里可能偏大。
- **名字里的 `/` 和 `.`**：靠贪心拼接解析，极端重名情况下可能解析到错的条目。
- **并存期成本**：两套协议、两套闸门，要设退出时限（见 §8 第三期）。
- **knip 棘轮**：新模块在接线前只有测试引用，可能被算成死代码。T1–T7 要么同一个 PR 合入，要么实施时先确认 knip 的口径。
- **Delta 会话**：改 `PromptScope` 封闭联合会让 Agent 模式的会话重基线一次（第二期）。
- **「从装备 remove」被模型当成卸下**：物品会被销毁。靠协议一句话、更新块可见（§12）与修改器撤销兜。
- **手改与正文不一致**：玩家改了状态，历史正文仍是旧说法，模型可能按正文「改回去」。已裁定不额外告知模型（§11.5），只靠状态树本身的变化；若实测常被改回，再评估加提示。
- **穿戴漏写或写错位置**：不加槽位别名、不记适配槽位（§9 #6、#9），原卡习惯的「手持」或漏写位置都会让穿戴被丢。靠协议列出槽位、更新块可见与修改器补救；实测丢弃多再评估。
- **更新块的存储增长**：记录跟着消息进每一张快照的载荷。所以只在最新一楼保留前值，原文不落消息（§12.2）。

## 8. 实施分期与任务

验证命令通用：`npm run typecheck`、`npm run typecheck:tools`、`npm run lint`、`npm run test:run`；改 Vue 加跑 `npm run typecheck:vue`。新文件含中文键，改完跑根 `AGENTS.md` 的编码检查命令。写 UI 前读 `docs/design.md`。

文件冲突提示：`state/state-manager.ts` 由 T3 → T10 顺序改；`types/types.ts` 只在 T1 改；`ui/stores/game-store.ts` 由 T11 → T13 顺序改；`ui/lib/game-pipeline.ts` 只在 T9b 改。

### 第一期：共用内核 + 直出 + 两个玩家功能

**T1 类型、键词表、编解码、上限纯函数** [起点，可与 T2 并行]

- 文件：`src/core/types/types.ts`；新建 `src/core/variables/state-tree-spec.ts`、`state-tree-codecs.ts`、`src/core/character/resource-caps.ts` 及各自测试。
- 做：
  - `types.ts` 一次加齐所有可选字段：`maxHpBonus` / `maxMpBonus` / `maxSpBonus`、`durationText`、`costText`、`ChatMessage.stateUpdates` 及其类型（§12.2）、`AgentResult.stateWriteStats`。
  - 中文键词表：键、叶子类型、是否只读、对应内核字段。只依赖 `content/field-enums`。
  - 时长、消耗、布尔、枚举、文本数组、词条字典的格式化与解析。
  - `readResourceCaps` / `recomputeResourceCaps`（§5.6 不变式）。
- 完成标准：§5.2 每行有正反例；旧档角色读出的总上限等于原值。
- 验证：`npx vitest run tests/core/variables/state-tree-spec.test.ts tests/core/variables/state-tree-codecs.test.ts tests/core/character/resource-caps.test.ts`。

**T2 抽出建补丁预演** [可与 T1 并行]

- 文件：新建 `src/core/state/patch-rehearsal.ts` 及测试；改 `src/core/agents/direct-output.ts`（只改为引用）。
- 完成标准：既有直出测试零改动通过。
- 验证：`npx vitest run tests/core/agents tests/core/state`。

**T3 StateManager：上限重算与新字段落库** [T1 之后；与 T4、T5、T7、T8a、T8b 并行]

- 文件：`src/core/state/state-manager.ts` 及其测试。
- 做：
  - §5.6 的两步触发点、旧写法换算、白名单加三键。
  - `applyAddStatusEffect` / `applyAddSkill` / `applyAddItem` 的字段清单加新字段。
  - `update_status_effect` 写数值时长时清 `durationText`。
- 完成标准：§7.2「资源上限不变式」通过；既有测试不因总上限变化而红。
- 验证：`npx vitest run tests/core/state`。

**T4 投影与分区** [T1 之后；并行]

- 文件：新建 `src/core/variables/state-tree-projection.ts`、`state-tree-sections.ts` 及测试。
- 做：`buildStateTree`（§3.1；可见性选项含「全部全量」，供修改器用）、`splitStateTreeSections`（§3.4）。
- 完成标准：分区闸门通过；背包与装备互不重复；输出不含账务键。
- 验证：`npx vitest run tests/core/variables/state-tree-projection.test.ts tests/core/variables/state-tree-sections.test.ts`。

**T5 补丁解析与路径解析** [T1 之后；并行]

- 文件：新建 `src/core/variables/state-tree-patch.ts` 及测试。
- 做：区块 JSON → op 列表（逐元素恢复、op 别名、三种路径写法）；路径逐段解析；原型污染键检查。
- 验证：`npx vitest run tests/core/variables/state-tree-patch.test.ts`。

**T6 翻译层** [T2、T4、T5 之后]

- 文件：新建 `src/core/variables/state-tree-translator.ts`、`tests/core/variables/state-tree-translator.test.ts`、`tests/core/variables/state-tree-roundtrip-gate.test.ts`。
- 做：
  - `translateTreeOps(ops, snapshot, options)`，返回补丁、本楼分钟数、档案改动、新人物、丢弃与纠正说明。
  - **每条 op 的结果记录**：状态（已应用 / 已纠正 / 已丢弃）、说明、前值、后值。§11 的撤销与 §12 的显示都靠它。
  - `options.actor` 区分 AI 与玩家（玩家可删任意角色等放宽项，见 §11.3）。
  - §5.3 全表，含「删一边加一边」折叠与槽位取值顺序。
- 完成标准：读写对称闸门、翻译产物闸门、背包装备语义闸门通过。
- 验证：`npx vitest run tests/core/variables`。

**T7 协议文字与设置缝** [T1 之后；并行]

- 文件：新建 `src/core/prompts/state-tree-prompt.ts`、`tests/core/prompts/state-tree-prompt-gate.test.ts`；改 `src/core/runtime/engine-settings.ts`。
- 做：由词表生成协议的状态写入段（含可选槽位清单）；缓存协议措辞。
- 验证：`npx vitest run tests/core/prompts/state-tree-prompt-gate.test.ts`。

**T8a 文本字段读者（引擎）** [T1 之后；并行]

- 文件：`src/core/combat/sandbox/state.ts`、`combat/sandbox/types.ts`、`src/core/prompts/context-visibility.ts`、`prompts/placeholder-registry.ts`、`src/core/character/stat-projection.ts` 及测试。
- 做：§5.7 表里引擎侧各行。
- 完成标准：带 `durationText` 的状态经战斗沙盒往返后文本仍在；`ACTIVE_EFFECTS` 输出文本时长。

**T8b 文本字段读者（前端）** [T1 之后；并行]

- 文件：`src/ui/components/game/StatusOverview.vue`、`CharacterListPanel.vue`、`CharacterViewerModal.vue`、`ItemsPanel.vue`、`cards/ItemSystemCard.vue`、`cards/CharGenSystemCard.vue`、`combat/combat-view.ts`、`src/ui/lib/item-view.ts` 及测试。
- 做：§5.7 表里前端各行。
- 验证：`npm run typecheck:vue && npx vitest run tests/ui`。

**T9a 直出接线（引擎）** [T3、T6、T7 之后]

- 文件：`src/core/agents/direct-main.ts`、`direct-output.ts`、`src/core/prompts/direct-prompt.ts`、`direct-context-frame.ts`、`direct-context-session.ts`、`opening-prompt.ts` 及测试。
- 做：
  - 按 `stateProtocol` 分支；读侧用状态树；缓存分区用 T4 的切分；尾部现值键由调用方传入。
  - 写侧认 `version: 2`；旧形状回落。
  - `buildDirectPatches` 入参加 `profile`，返回加 `deltaTime`、合并后的 `characterUpdates`、本楼的更新记录（§12.2）。

- 完成标准：`legacy` 下全部既有测试零改动通过；`tree` 下端到端用例通过。
- 验证：`npm run test:run`。

**T9b 直出接线（前端）** [T9a 之后]

- 文件：`src/ui/lib/game-pipeline.ts`、`src/ui/stores/settings-types.ts`、`settings-store.ts`、`src/ui/main.ts`、`settings/DeveloperSection.vue` 及测试。
- 做：
  - `acceptDirectTurn` 传存档档案、用返回的 `deltaTime`。
  - 把更新记录写到本楼 assistant 消息上；接纳新一楼时清掉上一楼记录里的前值。
  - 新设置两处声明并接到引擎设置缝。
- 完成标准：开关关闭时行为与现在逐字节一致。

**T10 玩家编辑写入口（引擎）** [T3、T6 之后]

- 文件：`src/core/state/state-manager.ts`（`commitPlayerEdit`）、新建 `src/core/variables/state-tree-edit.ts`（把玩家编辑和更新块修订规划成 op 与反向 op）及测试。
- 做：§11.2、§12.3 的引擎部分。
- 完成标准：§7.2「玩家编辑往返」「更新块补差」通过；整批失败时状态零变化。
- 验证：`npx vitest run tests/core/state tests/core/variables/state-tree-edit.test.ts`。

**T11 变量修改器界面** [T4、T10 之后]

- 文件：新建 `src/ui/components/game/StateEditorPanel.vue`、`state-editor-view.ts`；改 `src/ui/stores/game-store.ts`、`components/game/SideToolbar.vue`、`GamePage.vue` 及测试。
- 做：§11.1、§11.3、§11.4、§11.6。
- 完成标准：只读键不可编辑；生成中、润色中、战斗中整面只读；提交后面板与状态面板同步刷新。
- 验证：`npm run typecheck:vue && npx vitest run tests/ui`。

**T13 变量更新块界面** [T9b、T11 之后]

- 文件：新建 `src/ui/components/game/StateUpdateBlock.vue`、`state-update-view.ts`；改 `src/ui/components/game/ChatFlow.vue`、`src/ui/stores/game-store.ts` 及测试。
- 做：§12.1、§12.3、§12.4。
- 完成标准：默认折叠；逐节演出未放完时不出现；只有最新一楼可改；全程文本插值不走 `v-html`。

**T14 度量** [T9a 之后；脚本可并行]

- 文件：`src/core/agents/direct-main.ts`、新建 `scripts/analyze-state-writes.mjs`。
- 做：§7.1 的统计字段、日志事件与汇总脚本。

**T15 文档** [全部之后]

- §6 列的各份文档；数据字段规范补「状态树投影」与新字段；`src/ui/AGENTS.md` 补两个新组件与 `activeModal` 新取值；本文状态行改为已实施。

（编号 T12 留空：更新块的引擎记录已并入 T6 与 T9a。）

### 第二期：Agent 模式（第一期验证通过后）

**T16 Agent 模式接线**

- 文件：`src/core/prompts/placeholder-registry.ts`（`{{STATE_TREE}}`）、`prompt-state-projection.ts`（`state_tree` scope）、`src/core/agents/agent-orchestrator.ts`、`public/data/defaults/agent-config.json`、`src/core/agents/agent-defaults-fingerprints.json`；`src/ui/lib/game-pipeline.ts`（把 vars_update 的更新记录挂到本楼正文消息上）。
- 内容仓同步改 vars_update / daily_check / request_dispatcher 的提示词。

### 第三期：收口

**T17**

- 切默认值为 `tree`；一个发布周期后删旧协议及其闸门；本文按文档守则处置。

## 9. 裁定汇总（2026-11-22 全部裁定）

| #   | 事项                     | 裁定                                                                     | 落点             |
| --- | ------------------------ | ------------------------------------------------------------------------ | ---------------- |
| A   | 背包与装备               | 沿用原卡，分 `背包` 与 `装备` 两个字典，装备按物品名作键、带 `位置`      | §3.1、§3.2、§5.3 |
| B   | 上限                     | 拆成 `上限: {_基础, 额外}`；基础由代码推导、只读，额外可写               | §3.1、§3.3、§5.6 |
| C   | 解析不了的时长与消耗文本 | 新增 `StatusEffect.durationText?` 与 `Skill.costText?`                   | §5.2、§5.7       |
| D   | 新增功能                 | 变量修改器（§11）；每楼变量更新块可见、可改、默认折叠（§12）             | §11、§12         |
| 1   | 新旧协议的切换方式       | 全局设置，不钉在存档上                                                   | §2               |
| 2   | NPC 等级可否由 AI 写     | **可写**（主人未采纳只读推荐）；层级与基础上限由代码随之重算，主角仍只读 | §3.3、§5.3       |
| 3   | 新建实体的线上形状       | 同构整对象，不另设数组                                                   | §4.4             |
| 4   | 新建人物缺核心字段       | 丢整个人物，不替补数值                                                   | §4.4             |
| 5   | 金钱能否为负             | 钳到 0                                                                   | §5.2             |
| 6   | 「手持」等原卡槽位词     | **不加别名**；协议列出可选槽位                                           | §3.2、§5.2       |
| 7   | 档案文字的路径写入       | 暂时只作容错                                                             | §5.5             |
| 8   | 切换默认值的门槛         | **不设硬指标，主人体感决定**；度量只作参考                               | §7.1             |
| 9   | 背包物品记住适配槽位     | **不采纳**，不新增 `fitSlot`；穿戴必须在 op 里写位置，漏写丢弃           | §5.3             |
| 10  | 上限上升时当前值         | 不变，不白送恢复                                                         | §5.6             |
| 11  | 从 `装备` 里 `remove`    | 物品离开人物，与原卡一致；卸下必须 `move`                                | §5.3             |
| 12  | 多件饰品、堆叠拆分       | 本期不做                                                                 | §3.2             |
| 13  | 变量修改器入口           | 常驻侧栏，不需要开发者模式                                               | §11.1            |
| 14  | 修改器强制改只读键       | 第一期不开放                                                             | §11.3            |
| 15  | 修改器改时间             | 第一期只读                                                               | §11.3            |
| 16  | 更新块的编辑语义         | 逐条补差；不做「从前置快照重放」                                         | §12.3            |
| 17  | 模型原文是否落在消息上   | 不落，从调试记录读                                                       | §12.2            |
| 18  | 手动修正是否告知模型     | **不告知**；只靠状态树本身的变化                                         | §11.5            |

## 10. 顺带看到、不在本设计内处理的问题

- **仅测试引用的模块**：`variables/namespace-normalizer.ts`、`effects/buff-registry.ts`、`effects/effect-parser.ts`、`character/resource-calc.ts`、`character/validate.ts`。
- **占位提示词与实现不符**：公开仓 vars_update 提示词写「另有 get_character / get_inventory 可查」，但 `src/ui/lib/game-pipeline.ts` 只给 craft_gen 和 entity_gen 开工具。
- **数据字段规范第 5 章过期**：仍写着「时间结算按 name 匹配删除」和 scripts / onApply 等字段。
- **同名物品叠到已穿戴物品上**、**没有拆堆 op**：见 §1.4 第四条。
- **回退本轮会丢掉本轮之后的手动修改**：自动存档把修改吸进本轮快照，回退用的是上一轮快照。这是润色、重铸已有的行为，修改器沿用。

## 11. 变量修改器（玩家手动纠错）

### 11.1 入口与外形

- 侧栏工具新增一项「变量」，打开 `game.activeModal === 'variables'`（与日历、预设同一种页面级弹窗位）。常驻、不需要开发者模式（已裁定 2026-11-22）。
- 组件 `game/StateEditorPanel.vue`，用 `AppModal` 的通栏版式：左栏是可折叠的状态树（世界、主角、关系列表、任务列表、变量），带按名字或路径的搜索；右栏是选中节点的编辑表单。
- 展示层判定放纯函数 `state-editor-view.ts`（照 `character-viewer.ts` 的先例）。
- 树来自 `buildStateTree` 的「全部全量」投影，每次打开时从库里新读，不用 store 里可能陈旧的副本。
- 表单控件按键词表的叶子类型给：数值用步进框，枚举用下拉（取 `field-enums`），布尔用开关，文本用文本框，文本数组用标签式输入，字典可增删条目。

### 11.2 写入路径

- 编辑产生的就是 §4.3 的 op，一条都不走别的形状。
- 流程：op → 同一个纠正层与翻译层（`actor: 'player'`）→ `StatePatch[]` → `StateManager.commitPlayerEdit`。
- 提交前先做一次不落库的试算，面板显示「将要发生的变更」：逐条的前值 → 后值，以及被纠正或被拒的条目。玩家确认后才提交。
- `commitPlayerEdit` 与 `commitChatState` 的关系：
  - 相同：同一把 `withSaveWriteLock`、同一批 `applyPatch` 处理器。数值钳制、升级推进、上限重算、地图落位钩子全都照常生效。
  - 不同：整批原子（语义同现有的 `commitDomainCommand`），任一条失败则全部不落并把原因交回面板。`commitChatState` 是逐条容错，对手动编辑不合适（半成功的结果玩家看不出来）。
  - 补丁带 `metadata.source: 'player_edit'`，并记引擎日志 `state.manual_edit`。
- 它**不属于** `persistFocusQuest` 那类受控例外：那两个入口是绕过补丁、只改一个 UI 辅助字段的窄写。修改器是与 AI 同等级的状态写入，必须走补丁。

### 11.3 可改范围

| 类别                        | 处理                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 普通叶子、Record 的增删改名 | 可改                                                                                                                          |
| `_` 只读键                  | 可见、置灰、带锁形图标与「由代码维护」提示，不可编辑。属性点仍走状态总览里现有的分配入口                                      |
| 强制修改只读键              | 第一期不开放（已裁定 2026-11-22）。派生值（年龄、基础上限、时段）本来就改不了；等级、属性这类落库值一旦手改，会与经验表不一致 |
| 时间                        | 第一期只读（已裁定 2026-11-22）。时间只能前进，且一改就会触发天气、随机事件、地块结算                                         |
| 删除角色                    | 玩家可删任意 NPC（现有角色面板已有此能力），主角不可删                                                                        |
| 新建人物                    | 第一期不做（需要整套机械数据），仍由 AI 生成                                                                                  |

### 11.4 锁定、快照与撤销

- **锁定**：回合生成中、正文润色中、Agent 模式战斗中，整面只读并说明原因（与玩家人设编辑同一组守卫）。
- **与自动存档**：提交后回读活表。`useAutosave` 监听到角色与档案变化，约 5 秒后把现状覆写进本轮快照。所以「恢复到本轮」不会丢手改。
- **与回退重发**：回退本轮用的是上一轮快照，本轮之后的手改会一起丢。面板底部写明这一点。
- **撤销**：
  - 每次提交都记下反向 op（由翻译层返回的前值生成）。面板提供「撤销上一次修改」，同样走 `commitPlayerEdit`。
  - 撤销栈只在内存里，换回合、切存档、离开游戏页即清空。更早的后悔药是快照。
  - 结构性操作的撤销是尽力还原：被删物品按投影出的字段重建，投影里没有的内部字段不保证。

### 11.5 手改之后模型怎么知道

- **状态本身**：
  - 无缓存直出每轮发整棵树。
  - 缓存直出按分区求差，手改过的分区会出现在下一轮的 `direct_context.set` 里；不会触发冷建。
  - Agent 模式的 Delta 会话同理，下一轮产生最小差量（与玩家人设编辑的先例一致，不失效会话）。
- **不额外告知模型（已裁定 2026-11-22）**：手改只经状态树本身的变化带给模型，不另发「玩家修正」提示，也不新增 `worldFlags` 字段。若实测模型常按历史正文改回，再评估加提示。

### 11.6 不做的事

- 不直接编辑内核字段名或原始 JSON。
- 不在修改器里改 `plot`、地图事实、记忆。

## 12. 每楼的变量更新块（可见、可改、默认折叠）

### 12.1 显示

- 位置：聊天流里每条已接纳的正文消息下方，组件 `game/StateUpdateBlock.vue`，用原生 `<details>`，默认收起（照 `ActionPanel.vue` 的先例）。
- 收起时的标题行：「本楼状态更新 N 项」，有纠正或丢弃时带计数角标。
- 展开后是**纠正后的 op 列表**，每行：路径、动作、前值 → 后值、状态标记。
  - 已应用：无标记。
  - 已纠正：标记加说明（例如「超过上限，已钳到 120」）。
  - 已丢弃：标记加原因，整行弱化显示。
  - 玩家修订过：标记「已手动修订」。
- **模型原文**作为次级入口「查看原文」：从调试记录里取（每存档只保留最近若干调试回合），取不到就不显示这个入口。
- 只在新协议（`tree`）下有逐条列表。旧协议的楼层没有记录，不显示这个块。
- 第二期 Agent 模式：同一个块挂在本楼正文消息下，内容是 vars_update 那一步的结果。

### 12.2 存储

- 记录放在本楼 assistant 消息上：`ChatMessage.stateUpdates?`，内容是 op 列表（每条带状态与说明）加本楼分钟数。
- `messages` 表存整条消息对象，新字段随行，**不需要升 Dexie 版本**（与 `stage`、`preRewriteContent` 同一先例）。
- **前值与后值只保留在最新一楼**。接纳下一楼时清掉上一楼的前值，只留路径、动作、写入值与状态。原因：快照载荷里带整份消息，记录会被每张快照复制一遍。
- **模型原文不落消息**（已裁定 2026-11-22）。落的话每楼多出若干 KB，再乘以快照张数。
- 备份、单存档导出、快照都整存整取消息，记录随行。

### 12.3 编辑语义

**逐条补差**（已裁定 2026-11-22）

- 只有**最新一楼**可改。可做三件事：
  - 改一条已应用 op 的值。
  - 撤销一条已应用的 op。
  - 把一条被丢弃的 op 改好后重新应用，或新增一条。
- 实现：根据「记录的前值、记录的后值、玩家想要的结果」算出补偿 op，作用在**当前状态**上，走 §11.2 的同一个写入口。数值增量按差额补（原来 −30 改成 −10，就补 +20）；覆盖型按目标值设。
- 若现值已经不等于记录的后值（之后又被改过），先提示冲突，由玩家决定是否仍然覆盖。
- 提交成功后更新这条消息上的记录，标「已手动修订」。
- **正文不变**。正文与状态的出入不另行告知模型（§11.5）。
- **不可在此修订、需回退本楼的 op**：时间、累计经验值（升级不可逆）、新建人物、登神长阶。这些行只读并说明原因。
- **更早的楼层只读**。每行给一个「在变量修改器中打开此路径」的跳转，改的是当前值。

**没有采用「从该楼前置快照重新翻译并重提交」**，原因：

- 那等于「重新生成但不调主模型」：要恢复上一轮快照，再把整套接纳收尾重跑一遍（时间推进及其钩子、剧情结算、角色经历、随机事件、回合快照、记忆摘要）。
- 记忆摘要要再花一次模型调用。
- 自动插画、音频标记、逐节演出都会被重放，得逐个加抑制。
- 还要按楼保存模型原文和当时的骰池，并保持消息 id 不变（插画和角色经历都按消息 id 挂靠）。
- 好处是结果与「模型当时就写对了」完全一致，也能改时间和经验。若主人要这个效果，可作为后续增强单独立项。

**锁定**：回合生成中、润色中、战斗中不可改。

### 12.4 与其他机制的关系

| 机制                             | 关系                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 交互式推进（`<beat/>` 逐节演出） | 更新块不在 `content` 里，不影响分节偏移。显示时机与行动选项相同：本楼全部放完后才出现                                                               |
| 流式输出                         | 流式期间不显示（记录在接纳时才有）；`<direct_updates>` 原文照旧不进正文                                                                             |
| 输出美化正则                     | 规则只处理正文，更新块不经过美化管线与 iframe。内容一律文本插值，不走 `v-html`                                                                      |
| 露骨内容开关                     | 该开关过滤的是内容包文本。更新块里是模型产出的状态值，与状态面板同口径，不过滤                                                                      |
| 缓存直出                         | 会话历史里的 assistant 只留正文，更新块本来就不在其中。修订不改历史消息的 `content`，不影响缓存前缀，不触发冷建。状态变化经下一轮的分区差量带给模型 |
| 无缓存直出、Agent Delta          | 同 §11.5                                                                                                                                            |
| 快照与自动存档                   | 修订后的记录随消息进本轮快照；回退到更早的轮次时，记录随消息一起回到当时的样子                                                                      |
| 调试面板                         | 「已忽略 N 项」照旧；更新块是给玩家的常驻视图，两者数据同源                                                                                         |
