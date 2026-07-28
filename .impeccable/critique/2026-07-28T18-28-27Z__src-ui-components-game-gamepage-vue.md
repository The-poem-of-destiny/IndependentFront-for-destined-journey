---
target: GamePage 主界面（三栏布局）
total_score: 18
p0_count: 1
p1_count: 3
timestamp: 2026-07-28T18-28-27Z
slug: src-ui-components-game-gamepage-vue
---
⚠️ DEGRADED: single-context (会话规则禁止未经请求调用 Agent 工具，双 Agent 编排未启用)

**视觉证据缺口**: 浏览器面板未显示（截图始终超时），本轮审查基于 **源码 + 确定性扫描 + 离线对比度计算**，未做真机视觉核对。

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | 生成态三重指示并存；SideToolbar 完全无激活态 |
| 2 | Match System / Real World | 3 | 中文域语言扎实；但每条叙事挂现实时钟，「第 N 轮对话」是引擎术语 |
| 3 | User Control and Freedom | 2 | 回退仅藏在最新一条的右键里；选项弹窗无 Esc / 点外关闭 |
| 4 | Consistency and Standards | 2 | 4 个不存在的 token 静默兜底、12 档字号、5 套展开图元、3 套自造 z-index |
| 5 | Error Prevention | 1 | 中文输入法回车抢跑发送半成品；回退无确认即销毁一回合 |
| 6 | Recognition Rather Than Recall | 2 | 侧栏有文字标签（好）；但回退/复制/快捷键全靠记 |
| 7 | Flexibility and Efficiency | 2 | 两个开发者快捷键，玩家侧零快捷键，无 Shift+Enter |
| 8 | Aesthetic and Minimalist Design | 2 | 正文被四列 chrome 包围；位置信息重复三处 |
| 9 | Error Recovery | 1 | **Agent 失败被完全吞掉** —— `_error` 参数从未使用，面板零错误渲染 |
| 10 | Help and Documentation | 1 | 除 title 属性外无任何帮助；快捷键无处可查 |
| **Total** | | **18/40** | **Poor** |

> 说明：Nielsen 量表衡量的是**可用性**，不是美观度。这套 UI 的视觉手艺（玄墨配色、叠纸阴影、衬线正文、品质色点）明显高于 18 分给人的印象——失分几乎全在**状态可见性、错误恢复与规范自洽**上。

## Anti-Patterns Verdict

**这看起来像 AI 生成的吗？——不像。** 玄墨暖墨底 + 古金强调是有意的场景决策（"深夜暖光台灯下翻开命运之书"），不是 SaaS 默认盘；正文用 Noto Serif SC + `text-indent: 2em` + 1.8 行高，是真的在排书页而不是排聊天气泡；品质表达用色点 + 名字着色并明令禁止左边条。这些都是**已提交的立场**，不是模板残渣。

**确定性扫描**（`detect.mjs`，`src/ui/components/game/` 全目录）：**仅 1 条命中**
- `SideToolbar.vue:71` — `transition: width` 布局属性过渡（项目自己的 design.md §1 也明令禁止）

一个 7800 行的目录只出 1 条，说明设计规范是真的在执行。

**离线对比度核算**（14 组前景/背景，含 `color-mix` 解算）：**全部 ≥ 5.2:1，无一处不达标**。
最低的一组是 placeholder `#9a8e76` on `#211c16` = 5.24:1。这方面无需改动——问题不在对比度，在**字号**（下详）。

## Overall Impression

工程与视觉都到位了，**但产品自己写下的第一原则没有兑现**。

PRODUCT.md 说「叙事正文是视觉主角，所有面板退后服务于叙事」。实际布局是：叙事正文是四列里的第三列，左右各被两层 chrome 夹住（96px 工具栏 + 240px 场景栏 | 正文 | 320px 状态栏），并且**它是唯一没有自己表面的一列**——ScenePanel 和 StatusHUD 都拿到了 `--theme-content-bg`，正文区直接坐在 `--theme-window-bg` 上。视觉上它不是"书页"，是"面板之间的缝"。

最大的机会：**把面板从"围住正文"改成"按需覆盖正文"**，让正文真正拿到舞台中央。

## What's Working

1. **叙事排版本身是这个项目最好的部分。** `.bubble-narrative-full` 无边框无底色、`max-width: 70ch`、`line-height: 1.8`、段落 `text-indent: 2em`、`text-wrap: pretty`——这是真的在做书页，不是在做气泡。玩家消息用 6% 淡金染底 + 整圈细描边作"手稿旁注"，与正文形成层级但不打断阅读。

2. **色彩系统经得起量化检验。** 14 组对比度全过 AA，`color-mix()` 派生的 `--theme-surface-muted` 也过。7 级品质色做了微暖校色以配暖墨底，而不是照抄通用游戏品质盘。语义 z-index 阶（dropdown→sticky→modal→toast→tooltip）已定义——虽然游戏目录里几乎没人用它（见下）。

3. **ScenePanel 的心声气泡是个真正的设计想法。** 点在场 NPC 展开一条斜体引文，用 6% 主色染底 + 前后金色引号，`scrollIntoView({ block: 'nearest' })` 跟随。这是"游戏机制以叙事语言呈现"的正确示范，不是把 `好感度+5` 甩在脸上。

## Priority Issues

### [P0] Agent 失败被完全吞掉，玩家看到的只是"转圈消失了"

`game-store.ts:98` 的签名是 `clearAgentStatus(agentId, _error?: string)` —— 错误参数带下划线前缀，**函数体内从未使用**。`AgentStatusPanel.vue` 中 `error` / `失败` 的出现次数是 **0**。`game-pipeline.ts:740` 的 `onAgentError` 只做了 `console.error` + `clearAgentStatus`。

**后果**：一次生成失败（API 超时、模型未配置、额度耗尽）时，玩家看到 TopBar 的旋转图标停下、浮动面板消失，正文区什么都没多出来。他不知道该重发、该检查设置、还是该等。唯一线索在 F12 控制台。

对照 PRODUCT.md 的成功定义（"连续 30 分钟沉浸，UI 从未成为阻碍"）——这是最直接的破坏方式。

**Fix**：`clearAgentStatus` 接住 error → 在 ChatFlow 里插入一条**失败态消息**（可重试按钮 + 人话原因，不是错误码），并保留玩家刚才那条输入不清空。`game-pipeline.ts:640` 的状态提交失败已经这么做了（插一条 `[系统] 部分状态未能写入`），照那个路子补齐 Agent 侧即可。

**Suggested command**: `/impeccable harden`

### [P1] 生成态三处指示同时亮，其中一处正是 PRODUCT.md 点名的反参照

一次生成中，屏幕上同时有：
1. `TopBar.vue:38` — 旋转图标 + Agent 名
2. `AgentStatusPanel.vue` — `position: fixed; top:16px; right:16px; z-index:950` 的浮动卡片
3. `ChatFlow.vue:308` — 文字「AI 正在生成...」

第 3 条与 PRODUCT.md 的反参照逐字撞车：*「不要像 ChatGPT 式纯聊天 —— 不想看到『AI 回复在思考中 …』这样的占位文本」*。而且它渲染在流式正文**之上**，所以正文一边往外淌，上面一边挂着占位文字。

更糟的是第 2 条的位置：`top:16px; right:16px` + 宽 200–280px，**正好压在 StatusHUD（右侧 320px）的顶部**——盖住的是玩家概要的头像和名字。`z-index: 950` 又高于 `--z-modal: 310` 和 `--z-toast: 400`，所以生成期间打开背包，这张卡片会浮在 Modal 上面。

**Fix**：留一个。流式光标 `▍`（已实现，`ChatFlow.vue:517`）本身就是最好的"正在生成"信号——书页的下一行在长出来，这正是 PRODUCT.md 想要的"像书本的下一页那样自然加载"。删掉 `chat-loading` 文字块；把 AgentStatusPanel 的多 Agent 进度并进 TopBar 那一处，或让它锚到 TopBar 下方而不是盖住 HUD，并把 z-index 收回语义阶。

**Suggested command**: `/impeccable distill`

### [P1] 中文输入法回车抢跑 —— 一款中文游戏的输入框，按回车确认候选词就把半成品发出去了

`InputBar.vue:71` — `@keydown.enter="handleSend"`。Vue 的 `.enter` 修饰符只比对 `event.key`，**不检查 `event.isComposing`**。中文输入法组字过程中按回车确认候选词，Chrome 照样派发 `keydown` 且 `key === 'Enter'`，于是 `handleSend` 直接把当前 `input.value`（可能是拼音字母，或只打了一半的句子）发出去，同时清空输入框。

这不是理论风险，是中文 IME 的默认交互路径。

**Fix**：`@keydown.enter="e => { if (!e.isComposing) handleSend() }"`，或改用 `@keydown.enter.exact` + `compositionstart/end` 守卫。顺带把 `<input type="text">` 换成自增高 `<textarea>`：Enter 发送 / Shift+Enter 换行。设计原则 #4 写着「InputBar 不应感觉像提交表单」——单行、横向滚动、不能换行的 input 恰恰就是表单控件。

**Suggested command**: `/impeccable harden`

### [P1] 一切皆 Modal：8 个面板全部遮住正文

`GamePage.vue:188-211` 有 8 个 `AppModal`（背包/角色/任务/剧情/记忆/快照/地图/调试），其中 6 个是 `size="xxl"`。

这是认知负荷里的**上下文切换**（Context Switch）：要判断"我该不该喝这瓶药"，玩家必须盖住那段描述"为什么该喝"的正文。背包、角色、任务、地图这四个是**边读边查**的东西，不是独立任务流。product register 说得直白：*"Modal as first thought. Modals are usually laziness."*

同时 `SideToolbar` 的 `.tool-btn` 只有 `:hover`，**没有任何激活态**——面板开着的时候，工具栏不告诉你现在在哪。10 个按钮平铺无分组，混了三类东西：游戏内物（背包/角色/任务/地图）、元层（记忆/剧情/快照）、应用壳（音乐/调试/设置）。而「设置」在 TopBar 和 SideToolbar 里各有一个入口，相距不到 40px。

**Fix**：把常查的四个（背包/角色/任务/地图）改成**右侧 StatusHUD 的抽屉/标签页**，与正文并排而非覆盖；元层三个保留 Modal。侧栏按类别加分隔线，补 `.active` 态，删掉重复的设置入口之一。

**Suggested command**: `/impeccable layout`

### [P2] 项目在违反自己的设计规范，而且是静默违反

| 违规 | 证据 | 后果 |
|------|------|------|
| 引用不存在的 token | `--theme-border` ×5、`--theme-surface-hover` ×2、`--theme-accent` ×3（`variables.css` 中定义数均为 **0**） | ScenePanel 三段分隔线走的是 `rgba(255,255,255,0.04)` 兜底值，比全站统一的 `--theme-card-border` (#362e23) 淡得多；design.md §1 已把 `--theme-border` 列为明令禁止 |
| 字号失控 | ScenePanel 单文件 **12 档**字号：0.6 / 0.62 / 0.65 / 0.68 / 0.7 / 0.72 / 0.74 / 0.75 / 0.78 / 0.85 / 0.9 / 0.95rem。design.md §2.2 定义的字阶只有 5 档，下限 0.6875rem | 最小 0.6rem = **9.6px**。240px 宽的常驻栏里塞了 12 个层级，30 分钟连续游玩会累 |
| z-index 自造 | `ChatFlow.vue:580` = **9999**、`AgentStatusPanel.vue:67` = 950、`QuestsPanel.vue:225` = 1100。语义阶最高只到 `--z-tooltip: 500` | 三套互不相干的私有层级与一套已定义的语义阶并存；右键菜单在 9999 意味着它盖住一切，包括它不该盖的 |
| 硬编码 hex | `ChatFlow.vue:463`、`ScenePanel.vue:431` 的 `color: #fff`（在 avatar 上）；CharacterListPanel / DebugPanel / MapPanel 另有十余处 | design.md §8 检查清单第一条 |
| 字体绕过 token | ScenePanel 与 ChatFlow 共 7 处硬写 `system-ui, sans-serif`，而 `--theme-font-body` ('Noto Sans SC') 已定义且 base.css 已应用 | UI 标签字体在不同组件间不一致 |

**Fix**：这些都是机械修复，一次批量收口即可，不涉及设计判断。

**Suggested command**: `/impeccable polish`

## Persona Red Flags

**Alex（急性子熟练玩家）** — 玩家侧快捷键是 **0**。仅有的两个快捷键 `Ctrl+Shift+T`（注入测试数据）和 `Alt+Shift+D`（调试面板）都是开发者用的，且无处可查。打开背包必须鼠标移到左栏点击；关闭必须 Esc 或点 ×。想重发上一轮，得知道"右键点最新那条 AI 消息"这个隐藏知识。输入框不支持 Shift+Enter 换行，写长一点的行动描述只能在单行框里横向滚。

**Jordan（第一次玩）** — 进游戏后没有任何引导。「快照」是什么？「剧情」和「记忆」有何区别？为什么「设置」出现两次？ChatFlow 空态写着「等待冒险开始…／在下方输入你的行动来推进故事」——这条不错，但它只在**零消息**时出现，开场 Prompt 一发就永久消失了。侧栏 10 个按钮全部无说明，只有 `title` 悬浮提示。最要命的是：如果第一次生成就失败（新用户最可能的场景——API 还没配好），**屏幕上什么都不会发生**（见 P0）。

**Riley（边界测试者）** — `ChatFlow.vue:43` 的滚动 watch 无条件 `scrollTop = scrollHeight`：玩家往上翻读旧剧情时，新消息一到就被拽回底部，没有"用户已上滚"守卫。`InputBar` 的 `.options-popup` 是 `position: absolute` 装在 `overflow: hidden` 的 `.chat-flow` 里——选项一多就会被裁掉；且它没有 Esc、没有点外关闭、没有焦点管理，`role="listbox"` 里塞的是 `<button role="option">`（无效 ARIA 组合）。选项按钮本身 `v-if` 条件出现/消失，会让输入框左右跳位。回退菜单项直接销毁一回合，**无二次确认**。

**Casey（移动端）** — `.game-page-layout` 硬写 `min-width: 900px`，低于 900px 整页出横向滚动条。而 `TopBar.vue:152` 还留着一条 `@media (max-width: 720px)` —— 这条规则**永远不可能生效**，因为外层已经把宽度锁死在 900px 以上。代码在假装支持窄屏。

## Minor Observations

- **位置信息重复三处**：ScenePanel 的 `.scene-location`（完整路径）、StatusOverview 的 `.summary-location`（末段）、StatusOverview 个人信息里的「所在地」（又是完整路径）。同一屏三个副本。
- **每条消息挂现实世界时钟**（`bubble-time`，`display: block`）。一个有自己纪元/月/日/时辰系统的游戏，在每段散文下面压一行灰色的 `14:23`——既是品类错误，也是噪音。
- **TopBar 中间那块会晃**。`justify-content: space-between` 三子元素，"居中"的 `第 N 轮对话` 实际由左右两组的宽度决定；存档名最宽 14rem、Agent 指示器随出现/消失变宽、全屏按钮文字在「全屏／退出」间切换——每回合都会看到中间的标题左右漂移。而它显示的是全屏最不需要的信息，却是装饰最重的元素（两条渐变饰线）。
- **展开图元有五套**：`▶/◀`（侧栏折叠）、`›`（ScenePanel 角色列表）、`▸`（系统通知条）、`fa-chevron-up/down`（StatusOverview）、`▍`（流式光标）。
- `GamePage.vue:268` 的 `:deep(.modal-body) > :first-child { max-height: 55vh }` 给所有 Modal 一刀切 55vh，包括 `size="xxl"` 的地图和背包——大弹窗里开个小窗。
- `.scene-bot` 的 `min-height: 30% / max-height: 40%` 让「世界消息」恒定占据面板三分之一以上，即使一条新闻都没有（此时显示的是「暂无新消息」占着 30% 的高度）。
- `GamePage.vue:257` 的 `.placeholder-panel` 样式已无使用者，可删。

## Questions to Consider

- 如果背包和角色面板**不遮住正文**，而是从右侧 HUD 滑出与正文并排——玩家还需要在读和查之间反复切换吗？
- 流式光标 `▍` 已经在告诉玩家"正在写"。那另外两个加载指示器，各自还在回答什么问题？
- 正文区是四列里唯一没有自己表面的一列。如果反过来——**正文拿到 `--theme-card-bg` 的纸面 + 叠纸阴影，两侧面板退成窗口底色**——"书页"这个隐喻是不是才真的立起来了？
- 「第 N 轮对话」占着全屏最居中的位置。如果那里放的是**当前地点 + 时辰**呢？
- 240px 的常驻场景栏里塞了 12 档字号。这些信息里，有多少是**每一秒都要看**的，有多少是**需要时看一眼**的？
