# 交互式推进（直出正文逐节演出）设计

> **状态：已实施（2026-11-19；分支 `feat/interactive-progression`）。本地自动化测试覆盖引擎分节、演出状态机、登场判定、行为卡与组件接线；真实模型是否稳定输出 `<beat/>` 与战斗固定行未验证，真机游玩待验证。**

## 1. 目标与边界

直出模式（`direct`、`direct_cached`）的一楼正文按「节」放出，玩家每推进一次放出一节；新角色首次登场时浮现立绘或名字题签；正文战斗按「一名角色的一次行为」逐拍展示。

主人拍板（2026-11-19）：

- 设置 `stagedNarrative` **默认开**；关闭时 DOM 与引入前一致。
- 呈现方式：**聊天流内逐节**，不做全屏 VN 舞台。
- 新角色首次登场且没有任何素材：只浮现**名字题签**，与立绘同样「被画出来」式浮现。
- 键位：Space / Enter 推进、按住 Ctrl 快进（单独按住约 300ms 才进入）、End 全部显示，外加**鼠标左键点正文推进**。
- 历史消息「重看演出」本期不做（断点已落库，留作后续）。
- 登场演出只在角色本楼首次建档时触发。📌 2026-11-19 同日修订：实现为「名字不在开楼名册里（含别名）才演，演过就不再撤回」，不拿接纳后的新建名单过滤 —— 三轮审查里「先演后撤」反复出边角问题，主人拍板简化；代价是模型误标 enter 的临时人物也会登场。
- 战斗以「一个角色的一个行为」为一节。

不在本期范围：Agent 模式、历史消息演出、全屏舞台、按节重看。

## 2. 总体方案

模型在 `<maintext>` 里写 `<beat/>`；引擎剥掉标记，把断点偏移存进消息的旁路字段；前端在 ChatFlow 行内逐节放出。

- **协议常驻，不随开关变。** 「全文 / 演出」是纯前端设置，切换不动缓存前缀。改协议本身只让每个 `direct_cached` 存档冷建一次会话。
- **落库正文不含标记。** 节与节之间以 `\n\n` 拼接，断点存在 `ChatMessage.stage`。记忆、摘要、缓存 transcript、复制、润色都读 `content`，无需改动；旧档没有这个字段，按段落兜底。

## 3. 引擎：分节

模块 `src/core/story/story-beats.ts`。

- **不进 `MARKER_SPECS`。** 那张表的宽松扫描遇到漏写闭合会把后文吞掉；分节标记写错的代价只应是「少切一刀」。
- `extractStoryBeats(text)` → `{ content, breaks, enters }`。认 `<beat>`、`<beat/>`、`</beat>`、`<beat enter="名"/>`（大小写不敏感，enter 可用顿号或逗号列多人）。空节丢弃，其登场名顺延到下一个非空节。落在 `action_info` / `item_info` 面板里的标记只剥不切。**没有标记时 `content` 原样返回，逐字节不变。**
- `resolveBeatBreaks(content, stage?)` / `resolveStoryStage(content, stage?)`：读取方一律经此自校验。断点必须严格递增、不越界、前两字符是 `\n\n`、不落在面板里；任一处失效（例如润色改写了正文）就整体回退为按段落切，登场锚点归到所在段落的节首。
- `src/core/story/story-output.ts`：`projectStoryOutput` 在投影最后剥标记，只有出现过标记时才带 `stage`；`beat` 加进流式控制标签名单，半截的 `<bea` 不会漏进正文。新增 `projectStreamingStoryStaged(raw)` → `{ content, breaks, enters, closed }`，`content` 与 `projectStreamingStory` 恒等，`closed` 表示 `</maintext>` 已到。
- 类型：`ChatMessage.stage?: StoryStage`（`src/core/types/types.ts`），`StoryStage = { breaks, enters }`，`StoryStageEnter = { name, at }`。`DirectTurnDraft.stage` 随草稿带出。
- `parseDirectOutput` 不校验标记；标记写错不拒楼。

## 4. 协议文字

- `src/core/prompts/direct-prompt.ts` 的 `buildDirectProtocol`：两种战斗口径都加一行「正文分节」（节的粒度约 1–3 段、全篇约 4–10 节，首尾不写，不写进面板；本楼新建实体的人物在首次现身那一节之前写 `<beat enter="人物名"/>`）。
- 正文战斗口径（`directStructuredCombat` 关）在战斗行末追加「战斗逐拍」：一名角色的一次行为单独成一节，每节至多一个 `action_info`，前三行固定为 `|行动者|`、`|目标|`、`|行动|`，其后按需写 `|判定|`、`|伤害|`（或 `|恢复|`）、`|消耗|`、`|状态|`。
- `src/core/prompts/direct-context-session.ts` 的 `DIRECT_CACHE_PROTOCOL` 补一句：历史正文里的 `<beat/>` 已移除，每轮仍须照常分节（缓存会话的历史只留剥过标记的正文）。

## 5. 管线与设置

- `src/ui/lib/game-pipeline.ts`：流式回调 `StoryChunkCallback` 加第三参 `stage?: StreamingStoryStage`（断点、登场锚点、`closed`），只在直出主笔（`direct_main`）给出；接纳时消息带上 `draft.stage`（Dexie 存整条消息，无迁移）。
- `src/ui/components/game/GamePage.vue`：`streamingStage` 与 `streamingText` 同帧提交，传给 ChatFlow。
- 设置 `stagedNarrative`（`src/ui/stores/settings-types.ts` / `settings-store.ts`），默认 true，旧设置缺键时补默认。界面在「设置 → 消息显示 → 正文演出」。

## 6. 前端演出

### 6.1 状态机（纯函数）

`src/ui/lib/stage-playback.ts`：输入 `{ content, breaks, enters, closed }`，事件 `sync` / `advance` / `skipAll`，派生 `sections`、`revealedCount`、`waiting`、`finished`、`canAdvance`。

- 断点缺席时按段落**临时切**，不切开面板块。
- 流式中只有「后面已出现下一个断点」或「流已结束」的节算完整，只有完整的节能放出；首节完整即自动放出。
- 进度用**字符偏移游标**，不用节序号：临时段落切换成模型断点时，游标落在完整节内部就并到节尾，已放出的文字不回退。
- `skipAll` 后进入「全部显示」，此后每次同步都直接放出所有完整节。

### 6.2 登场判定（纯函数）

`src/ui/lib/stage-entrance.ts` 的 `resolveEntrances(enters, roster, created, sections)`：

- 名字或别名在**本楼开始时的名册**里的一律不演，模型标了 enter 也不演。
- 有 enter 标记的按偏移落到所在节；回合接纳后新建、但模型没标 enter 的角色，按名字首次出现的节补锚；正文里找不到就不演。同一人物只演一次。
- 名册来源（ChatFlow）：草稿用生成开始那一刻拍下的全部角色；正式消息按 `introducedBy === 回合键` 把本楼新建的角色分出来（建档点在 `src/core/agents/direct-output.ts` 的 add_character）。
- 不拿本楼新建名单过滤 enter 标记：名字不在开楼名册里（含别名）就演，包括没建档的临时人物。
- **演过就不再撤回**（2026-11-19 主人拍板）：登场卡一旦播出，就按播出时用的名字（含别名）钉进这条消息的账本；
  此后名册回读、接纳状态、是否在生成怎么变都保持显示，位置按当前的节重新定位，换位置时静态显示、不重画。
- 「已读过就不演」：还没演的名字每次重新判定，但只在所在节是上次判定之后才放出的时候演 ——
  回合接纳后补锚的新角色若落在已读过的节，不再演。

### 6.3 进度簿

`src/ui/composables/useStagedPlayback.ts`：

- 只演**本次会话新到**的直出正文（`useFreshMessages` 的判定）；历史消息与设置关闭时不建记录，ChatFlow 走原渲染。
- 流式草稿另有一份进度。草稿在提交前就被清空，所以进度一直留到正式消息领走；正式消息拿草稿游标同步到自己的正文，已放出的节静默显示，不回退、不重放。重试从头再流时草稿进度作废重开（`draftEpoch` +1）。
- `holdOptions`：最新一条正文还在演、或尚未被接纳时为真，InputBar 据此暂扣行动选项。
- 玩家发送新输入前 `skipEverything`，所有演出一律全部显示。

### 6.4 组件

- `src/ui/components/game/StagedNarrative.vue`：每节一个 `BeautifiedNarrative` 实例。交接前已看过的节 `reveal="off"`，新放出的节 `reveal="once"`；追上进度时显示等待提示；正在演的那一条末尾有小条「全文 / 快进 / 全部显示」。
- **插画**：`BeautifiedNarrative` 新增 `imageSlice` 属性 `{ base, narrative, tail }`。`<scene_image>` 的 occurrence 按整条消息计数，所以每节的插画序号加上前面各节的图数（`base`）；生图侧链取整条正文（`narrative`）；记录驱动的消息末尾图带只挂在末节（`tail`）。草稿不传 `messageId`，与原草稿一致。缺省 `imageSlice` 时行为不变。
- `src/ui/components/game/CharacterEntrance.vue`：立绘走立牌链 `ASSET_TYPE_FALLBACK_CHAIN`（立绘 → 立绘bg → 头像）；一张素材都没有时只浮现名字题签。动效只有一种：自上而下的遮罩扫过加透明度，不旋转、不发光、不弹跳；只在新放出的节且特效闸门打开时播一次，闸门关、减动效、已读过的节一律静态显示。遮罩用到 `mask-position` 动画，已在 `docs/design.md` §6.4 登记为例外。
- `src/ui/components/game/combat/CombatBeatCard.vue` + `combat-view.ts` 的 `parseCombatBeat(rows)`：`action_info` 里有 `|行动者|` 行时画成行为卡（行动者与目标头像走 `ASSET_TYPE_AVATAR_CHAIN`，至多三枚目标头像；判定、伤害 / 恢复、消耗、状态行；认不出的行照列），否则沿用通用面板。历史整段显示同样受益，不依赖演出开关。卡里的数值是模型自述，不是权威值。

### 6.5 输入

ChatFlow 在 window 上挂 keydown / keyup / blur，在消息容器上挂 click：

| 输入         | 行为                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Space、Enter | 推进一节                                                                                                                              |
| 按住 Ctrl    | 单独按住约 300ms 才进入快进（每 220ms 一节），松开即停；单按一下不推进，期间按别的键或滚轮即取消（Ctrl+F / Ctrl+R / Ctrl+滚轮不误触） |
| End          | 当前这一条全部显示                                                                                                                    |
| 鼠标左键     | 点正文推进                                                                                                                            |
| 小条「快进」 | 放到追上进度为止                                                                                                                      |
| 小条「全文」 | 直接关闭全局设置 `stagedNarrative`（提示可在设置页重新开）                                                                            |

让路条件（任一成立就不推进）：右键菜单开着、`hasOpenDialog()`、`game.activeModal`、`game.isInCombat`、正在选中文字、输入法选字中、带修饰键，或事件目标在按钮、链接、表单控件、iframe、卡片、插画、行为卡、操作条等元素里（清单见 `ChatFlow.vue` 的 `STAGE_YIELD_SELECTOR`）。

「全文」没有做成单条消息的临时切换：关闭设置后所有消息回到整段显示，DOM 与引入前一致；重新开启在「设置 → 消息显示 → 正文演出」。

## 7. 风险与取舍

- 真实模型是否稳定输出 `<beat/>` 与战斗固定行未验证；兜底是按段落切与通用面板。
- 私有内容包的直出预设可能与战斗固定行要求冲突。
- 每节独立跑美化，跨节的美化规则不再匹配。
- 行为卡里的 HP 等数值是模型自述，不是权威值。
- 协议文字变了，每个 `direct_cached` 存档会冷建一次会话。
- 润色改写正文后断点多半失效，读取时自动回退按段落切。
