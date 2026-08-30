# 游玩中玩家人设编辑设计

> **状态：已实施（2026-08-30；自动验收与 UI 真机走查通过，真实模型请求未调用）**
>
> **适用范围**：玩家在已开始的存档中修改主角的叙事人设。修改角色字段、玩家状态栏或
> Story prompt 投影前，先读本文。

## 0. 一句话架构

在玩家状态栏提供一个“编辑人设”入口；保存时由 `StateManager` 的命名方法在存档写锁内重读
唯一主角，只替换 `personality`、`appearance`、`background` 三个一等字段，再把权威角色回写
Pinia。改动由既有 `CHARACTER_STATE` Delta 在下一次行动中注入，不产生世界内事件，也不改写
已经发生的剧情。

## 1. 目标与停止点

### 1.1 必须做到

1. 玩家能在游玩中查看并编辑性格、外貌与体态、背景经历。
2. 保存后的值进入当前存档的 `characters` 表，而不是新增第二份 persona 配置。
3. 下一次 Story 及其他读取 `CHARACTER_STATE` 的 Agent 能看到最新值。
4. 保存不生成聊天消息、记忆、快照、GameEvent 或效果脚本触发。
5. 生成或战斗管线占用存档时拒绝保存，避免用户设定与正在组装的 prompt 交错。
6. 数据库写入失败时界面仍显示旧的权威值，草稿留在编辑器中供重试。
7. 宽屏与窄屏都可操作，键盘、Esc、标签和错误提示满足现有 `AppModal` / `AppButton` 契约。

### 1.2 非目标

- 不编辑姓名、性别、年龄、种族、身份、职业、层级、属性、资源、命运核心或系统核心。
- 不修改出图系统的 `ImagePreset.appearance` 九槽基线或本档 `characterAppearances.patch`。
- 不重写旧消息、旧记忆、创角开场文本或既有快照。
- 不新增 Dexie 表、字段、迁移、依赖、内容包字段或内容包版本。
- 不增加“锁定人设、禁止 AI 后续改变”的权限系统；v1 沿用字段现有的 AI/玩家共同写入契约。
- 不把编辑包装成一次 `update_character` StatePatch；它不是世界内行动。

完成本文第 9 节验收后停止，不顺手扩成通用角色编辑器。

## 2. 现状证据

### 2.1 存储真源

`CharacterState` 已有三个正式字段：

```ts
appearance?: string;
background?: string;
personality?: string;
```

每个存档的角色都存于 Dexie `characters` 表。字段规范明确这三项由 AI/玩家填写，并禁止再复制到
`customFields`。因此不需要 schema 迁移，也不能建立单独的 `userPersona` 真源。

创角时的映射已经固定：

| 创角输入    | 角色正式字段         | 说明                                         |
| ----------- | -------------------- | -------------------------------------------- |
| 性格        | `personality`        | 去除首尾空白后保存                           |
| 身材        | `appearance`         | 字段语义实际是外貌与体态                     |
| 身世 + 补充 | `background`         | 两段以空行合并；建档后不再保留可逆的分段结构 |
| 补充原文    | `customFields.extra` | 仅为创角扩展残留，不参与当前 Story 人设投影  |

编辑器直接展示三个正式字段，不尝试从 `background` 猜回“身世/补充”两栏，也不改动存量
`customFields.extra`。

### 2.2 Prompt 可见性

`context-visibility.ts` 的 `formatCharacterNarrative()` 会把角色的外貌、背景和性格写进 Story 的
`NARRATIVE` 角色视图。Delta 会话的 `projectCharacterBase()` 也会投影这三个字段；值变化时，下一轮
产生对应的 `character set`，因此无需 `invalidatePromptSession()`。

强制失效会把本可用一个小 Delta 表达的修改升级成完整重基线，增加 prompt 成本而没有正确性收益。

### 2.3 当前缺口

- `StatusOverview.vue` 是主角自己的信息面，但目前只显示身份、属性、状态与持有物，没有人设编辑入口。
- `CharacterListPanel.vue` 只列 NPC；`CharacterViewerModal.vue` 也明确是“别人的面”，都不是入口归属。
- `StateManager.update_character` 虽能写这三个字段，却会生成 `character_action`，并把事件发布给已装备
  物品和技能的订阅脚本。把 UI 编辑伪装成该 patch 会产生不应存在的世界内副作用。
- 直接从 Vue 调 `saveCharacter()` 又会绕开 per-save 写锁，可能被同存档的回合提交覆盖。

## 3. 领域语义

| 术语     | 精确定义                                                                |
| -------- | ----------------------------------------------------------------------- |
| 玩家人设 | 当前存档主角的 `personality`、`appearance`、`background` 三个叙事字段。 |
| 人设草稿 | 编辑弹窗中的本地副本；关闭或保存失败时不自动写入权威状态。              |
| 权威人设 | `characters` 表中 `type === 'player'` 那一行的三个正式字段。            |
| 叙事修订 | 对后续叙事如何理解主角的设定修正，不是游戏世界内发生的一次行动。        |
| 画像外貌 | 图像生成专用的九槽基线与本档差量；与本文的叙事 `appearance` 分离。      |

字段写入仍是“最后一次成功写入生效”。本功能不改变现有 Agent 对这些字段的写权限；若后续剧情通过
既有状态管线明确更新了人设，界面应显示更新后的权威值，而不是偷偷恢复旧草稿。

## 4. 核心裁定

### D1：入口属于 `StatusOverview`，不扩充角色列表

在主角姓名下方增加文字按钮“编辑人设”。画像区域已有独立的点击语义，按钮不得叠在画像上；角色列表
又只负责 NPC。入口放在自己的状态栏，信息归属与点击去向都最明确。

按钮在 `game.isGenerating === true` 或 `game.isInCombat === true` 时禁用，并以 `title` / 辅助文本
说明“当前回合或战斗结束后可编辑”。v1 只允许游戏空闲时保存。

### D2：独立弹窗承载三字段草稿

新增 `PlayerPersonaEditorModal.vue`，使用现有 `AppModal size="lg"`、`AppButton` 与表单外壳，按以下顺序
单列排列：

1. 性格
2. 外貌与体态
3. 背景经历

弹窗顶部固定提示：

> 修改会从下一次行动起影响叙事，不会改写已经发生的剧情。

其下必须显示费用警告：

> 修改会改变后续提示词，可能降低提示词缓存命中，并产生额外模型费用。

“可能”不可省略：本功能不会主动调用 `invalidatePromptSession()`，但上游服务商如何复用变化后的
prompt 前缀不由本地应用保证。

外貌字段旁另写：

> 此处修改正文中的人物设定；绘图使用的画像外貌请在画像设置中调整。

这两句是产品契约，不得只藏在 tooltip 中。

### D3：只在打开时复制权威值

弹窗从关闭变为打开时，以当前 `game.player` 初始化草稿。编辑期间不双向绑定角色对象；否则输入一个字
就会先污染 Pinia，再在取消时尝试回滚。

保存成功后才关闭弹窗。保存失败时保留草稿、恢复按钮，并在弹窗内显示错误，同时发一次全局 error
toast。字段未变化时“保存人设”禁用。

### D4：允许清空，不增加无依据的字符上限

三个字段都可为空，全部清空也属于明确的用户选择。保存时只做两项规范化：

1. `CRLF` / `CR` 统一为 `LF`；
2. 去除每个字段的首尾空白，保留内部换行与段落。

现有创角输入没有长度契约，v1 不凭空增加与创角不一致的上限。Vue 文本插值继续负责 HTML 转义；
这些文字本来就会作为用户提供的 prompt 内容注入，不做会改变语义的标签剥离。

### D5：关闭脏草稿要确认

草稿未变化时，Esc、遮罩和“取消”直接关闭。草稿已变化时，三条关闭路径统一询问“放弃未保存的人设
修改？”。保存中将 `AppModal.closable` 设为 `false`，避免请求进行时弹窗消失而结果去向不明。

### D6：命名写入口归 `StateManager`

`StateManager` 新增一个窄接口，不把保存细节暴露给 Vue：

```ts
export interface PlayerPersonaDraft {
  personality: string;
  appearance: string;
  background: string;
}

export type PlayerPersonaUpdateResult =
  | { ok: true; changed: boolean; character: CharacterState }
  | { ok: false; error: string };

async updatePlayerPersona(draft: PlayerPersonaDraft): Promise<PlayerPersonaUpdateResult>;
```

接口不接受角色 id、名字、任意字段字典或 StatePatch。`StateManager` 已由 `saveId` 构造，方法只寻找该
存档唯一的 `type === 'player'` 角色，使调用方无法借此编辑 NPC 或数值字段。

### D7：锁内重读、窄字段替换、无事件

方法必须完整运行于 `withSaveWriteLock(saveId)`：

1. 锁内调用 `getCharactersByType('player', saveId)`；不是恰好一条就明确拒绝。
2. 规范化三项文字；与最新角色逐字段比较。
3. 无变化时直接返回最新角色，不写数据库、不触碰更新时间。
4. 有变化时复制最新角色，仅替换三个字段，再 `saveCharacter(next)`。
5. 主写成功后按现有提交语义 best-effort 触碰 `SaveSlot.updatedAt`。
6. 返回刚落库的完整角色。

该方法不调用 `commitChatState()`、`createEvent()`、`reactToEvents()` 或 `createSnapshot()`。这不是绕开
StateManager，而是在同一所有者内为“用户修改元设定”建立与世界内 StatePatch 不同的命名命令。

### D8：Pinia 只接收权威返回值

`game-store` 新增：

```ts
async function updatePlayerPersona(draft: PlayerPersonaDraft): Promise<PlayerPersonaUpdateResult>;
```

调用前再次检查活跃存档、主角、`isGenerating` 与 `isInCombat`。调用时捕获当前 `saveId`；成功返回
后，仅当活跃存档仍是该值时，按角色 id 替换 `characters` 中对应元素并刷新 `saves` 排序。不得把
提交前草稿直接写进 store，也不得用 `refreshFromDb()` 的合并语义猜测本次保存结果。

方法不失效 prompt session。下一次 prompt 组装会从更新后的 `game.characters` 建立当前投影，与上一
成功投影比较后发出三字段中实际变化的 Delta。

### D9：叙事外貌与画像外貌保持分离

`CharacterState.appearance` 告诉文字 Agent“主角在叙事中是什么样”；图像系统的九槽外貌承担稳定出图。
两者生命周期和写权限不同，保存本文字段时不得同步改画像预设：

- 同步到全局基线会把一个存档中的中途修改泄漏到其他存档；
- 同步到会话差量又需要把自由文本可靠拆成九槽，现有系统没有这种无损转换；
- 静默同步任一处都会破坏图像系统“用户基线 / AI 会话差量”的既有所有权。

v1 以明确文案和现有画像设置入口解决可发现性，不建立隐式转换。

### D10：不改内容包

功能使用已有字段、占位符与 Story 可见性，不修改 `agent-config.json`、世界书或 pack schema，也不提升
内容包版本。第三人称叙事继续由现有 Story preset 与开场提示词负责。

## 5. 数据流

```text
StatusOverview “编辑人设”
  -> PlayerPersonaEditorModal 本地草稿
  -> game.updatePlayerPersona(draft)
  -> StateManager.updatePlayerPersona(draft)
  -> withSaveWriteLock(saveId)
       -> 锁内重读唯一 player
       -> 只替换 3 个正式字段
       -> saveCharacter(next)
  <- 返回权威 CharacterState
  -> Pinia 按 id 替换当前 player
  -> 下一次 prompt projection 产生 character field Delta
  -> Story 以主角姓名的第三人称有限视角继续叙事
```

任何失败都在“权威角色返回”之前终止，UI 不做乐观写入。

## 6. 交互与视觉规格

### 6.1 状态栏入口

- 位置：`StatusOverview` 的主角姓名下方，画像交互区域之外。
- 控件：文字按钮“编辑人设”，不得使用只有铅笔图标的按钮。
- 最小点击高度：36px；颜色、边框、间距只用主题 token。
- 生成中：按钮 disabled，辅助说明可被键盘和读屏获得。

### 6.2 弹窗布局

- 宽屏：`lg` 单列，背景经历获得最大可视高度。
- 窄屏：宽度随 `AppModal` 收缩，footer 两个按钮保持可触达；必要时纵向排列。
- 三个 `textarea` 都有可见 `label`，不得只用 placeholder 代替标签。
- footer 左侧“取消”，右侧“保存人设”；保存中显示“保存中…”。
- 错误信息使用 `role="alert"`，焦点留在弹窗内；成功后关闭并 toast“人设已更新，将从下一次行动起生效”。
- 动画沿用 `AppModal`，不新增布局属性动画；`prefers-reduced-motion` 行为由现有外壳继承。

## 7. 并发、失败与时间线语义

| 场景                       | 行为                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| 打开时正在生成             | 入口禁用，不创建草稿。                                               |
| 打开后生成态意外变为 true  | store 在落库前再次拒绝，弹窗保留草稿。                               |
| 同存档回合提交占用写锁     | 人设写排队；进入锁后重读最新角色，只改三字段，不覆盖其他状态。       |
| 保存期间切换存档           | 原存档写入按捕获的 `saveId` 完成；不得把返回角色写进新存档的 Pinia。 |
| 找不到主角或存在多个主角   | 拒绝并提示存档角色数据异常，不任选一条写入。                         |
| Dexie 写入失败             | 返回失败，UI 保持旧角色与当前草稿。                                  |
| SaveSlot 时间触碰失败      | 人设主写仍算成功；记录警告，不能把已成功写入伪装成整体失败。         |
| 下一次回合前关闭并重开游戏 | 从 `characters` 表读到新值，行为不依赖内存缓存。                     |
| 恢复旧快照                 | 快照中的旧角色字段成为权威值，编辑器随恢复后的角色显示旧人设。       |

不为不存在的交错新增版本号或冲突合并：弹窗覆盖层阻止玩家同时发送行动，生成态守卫处理管线占用，写锁处理
数据库级串行，这三层已经覆盖生产可达路径。

## 8. 实施文件图

| 文件                                                      | 最小改动                                             |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `src/sillytavern/state-manager.ts`                        | 新增类型与 `updatePlayerPersona()` 命名写入口。      |
| `src/sillytavern/state-manager.persona.test.ts`           | 锁内重读、窄改、无事件、无变化与异常主角回归。       |
| `src/ui/stores/game-store.ts`                             | 新增 action、生成态守卫、按 id 接入权威返回值。      |
| `src/ui/stores/game-store.persona.test.ts`                | 生成/战斗守卫、成功接入与无活跃存档回归。            |
| `src/ui/components/game/PlayerPersonaEditorModal.vue`     | 三字段草稿、脏关闭、保存态、可访问错误与响应式布局。 |
| `src/ui/components/game/PlayerPersonaEditorModal.test.ts` | 初始化、清空、未改禁用、脏关闭、失败保草稿和生成态。 |
| `src/ui/components/game/StatusOverview.vue`               | 添加文字入口并编排 modal / toast。                   |
| `src/ui/components/game/StatusOverview.persona.test.ts`   | 入口归属、禁用态、成功/失败文案与第三人称字段透传。  |
| `src/sillytavern/prompt-state-projection.test.ts`         | 三字段变化产生最小 Delta，未变化不产 Delta。         |

不修改 `CharacterListPanel`、`CharacterViewerModal`、数据库版本、内容包或图像外貌模块。

## 9. 验收清单

### 9.1 自动验收

1. 保存三项新值后，数据库中只有当前存档的唯一主角三字段变化；其余字段逐项保持。
2. 空字符串可清除任一或全部人设字段，内部段落换行保留。
3. 同存档并发提交先完成后，人设保存不会把其资源、物品、任务或位置写回旧值。
4. 保存不生成 `GameEvent`，即使存档有 `character_action` 订阅也不触发效果。
5. 保存失败、无主角、多主角、生成中都不修改 Pinia。
6. 保存期间切换存档不会把旧存档主角注入新存档。
7. 下一轮 prompt Delta 包含实际变化的 `appearance` / `background` / `personality`，不强制重基线。
8. modal 的标签、按钮、Esc、脏关闭、错误播报与窄屏布局测试通过。
9. `npm run gates` 全部通过，中文文本编码检查为 U+FFFD 0、非法控制字符 0。

### 9.2 真机验收

1. 空闲时打开编辑器，确认三项与当前角色档案一致。
2. 修改“性格”和“背景经历”后保存，下一次行动的正文以第三人称自然体现新设定，不复述编辑动作。
3. 旧正文和开场消息保持原样。
4. 生成中与战斗中不能保存，回合结束后可正常编辑。
5. 刷新页面、退出再进存档后修改仍在。
6. 画像生成设置与九槽外貌没有被静默改动。
7. 恢复到编辑前快照后，人设随时间线一同回到快照值。

### 9.3 2026-08-30 实施验收记录

- 聚焦回归：6 个测试文件、73 项测试全部通过；其中真实 `preparePromptSession()` 路径证明保存后的
  下一次 Story 请求只追加三个人设字段 Delta，不强制重基线。
- 完整闸门：`npm run gates` 通过；365 个测试文件、9,293 项通过、8 项跳过。
- UI 真机：本地 Vite 以现有测试存档完成打开、修改、保存、toast、复开持久化走查；768×900 与
  480×800 均无横向溢出，费用警告完整可读，footer 按钮实测高度 36px。
- 浏览器控制台没有本功能新增的 error；仅见既有 Three.js 弃用和首页 WebGL 静态降级警告。
- 为避免测试本身产生模型费用，未向真实 provider 发送请求；本轮验收覆盖到 provider 发送前的完整
  Story 消息组装边界，不宣称验证了模型供应商返回内容。
- 未修改内容包数据、manifest 或版本号。
