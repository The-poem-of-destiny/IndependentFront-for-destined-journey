---
target: the settings page
total_score: 22
max_score: 40
na_heuristics:
p0_count: 1
p1_count: 3
timestamp: 2026-08-08T04-01-26Z
slug: src-ui-components-settings-settingspage-vue
---

## Design Health Score

| #         | Heuristic                      | Score     | Key Issue                                                                                                       |
| --------- | ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status    | 2         | `agentDirty` is written in 4 places and read in **zero** — the unsaved-changes signal exists and is thrown away |
| 2         | Match System / Real World      | 3         | Copy is unusually good, but `baseUrl` / `IndexedDB + localStorage` / `thinking:{type:'enabled'}` leak through   |
| 3         | User Control and Freedom       | 2         | 「恢复成最新」wipes every override with no confirm; leaving the Agent panel silently discards drafts            |
| 4         | Consistency and Standards      | 2         | 12 sections auto-save, 1 requires an explicit save; `window.confirm()` next to themed `AppModal`                |
| 5         | Error Prevention               | 2         | Number inputs carry `min`/`max` that browsers don't enforce on typed input; values flow raw into engine config  |
| 6         | Recognition Rather Than Recall | 2         | No search across 13 sections; cross-section dependencies must be held in working memory                         |
| 7         | Flexibility and Efficiency     | 1         | No shortcuts, no search, no per-section URL, no keyboard path into any toggle                                   |
| 8         | Aesthetic and Minimalist       | 3         | Disciplined shared chrome; undercut by three prose paragraphs before 存档数据's first control                   |
| 9         | Error Recovery                 | 2         | `ui.toast('ok')` / `ui.toast('fail: ' + msg)` are dev strings in the primary配置 flow                           |
| 10        | Help and Documentation         | 3         | `form-hint` explains _why_, not just _what_ — the best thing on this surface. No first-run path though          |
| **Total** |                                | **22/40** | **Acceptable — significant improvements needed**                                                                |

## Design Specificity Verdict

**LLM assessment**: This surface is **authored, not templated** — and that judgment was formed before running any detector.

The evidence is in the details a generic settings page never has. `settings-chrome.css` exists because the team hit Vue's scoped-style boundary and chose one shared source over 8 copies, and the file says so in its header. The 主题 grid renders each theme as a 16:10 swatch painted with its own `preview` gradient rather than a labelled radio row. The 字体 control is **two** selects because someone discovered the old three-way `mixed` option rendered identically to `sans` and split it. `AboutSection` carries a font/icon attribution card because CC BY 4.0 requires visible attribution — a legal obligation rendered as UI.

Where it goes generic is the **skeleton**, not the skin: a 180px icon+label rail, a scrolling content pane, cards in a 2-column grid. That shell is interchangeable with any admin panel. Given PRODUCT.md's stance — this is the tool mode of a narrative engine, where "UI 退后、叙事向前" — a conventional shell is a defensible choice, not a failure. The real gap is that the shell was never asked to carry 13 sections and ~90 controls, and it now shows.

**Deterministic scan**: `detect.mjs --json src/ui/components/settings` returned `[]` — zero findings across 30+ files. The mechanical detector agrees the visual craft floor is met. Everything below is behavioral, structural, or accessibility work that no static scan catches.

**Visual overlays**: Not applicable — findings came from direct DOM measurement and computed-style probes in a live page rather than script-injected overlays.

## Overall Impression

**The craft floor is high and the state model is the problem.**

Every individual control looks considered. Contrast measures 5.2–17.4:1 on the obsidian theme (comfortably past AA). Hint copy is genuinely better than most commercial products — the 标题字体 hint tells you what you'll lose, the reduced-motion hint tells you not to bother if the OS already handles it, and the API section admits "充个五块钱能玩到天荒地老."

Then you try to use it with a keyboard and land in the 消息显示 section, where I measured **zero focusable elements in the entire content pane**. Eight toggles, all `display: none`. There is nothing to tab to.

The single biggest opportunity: **surface the state you already track.** `agentDirty` is set in four places and read in none. That one gap explains the dirty-indicator, the navigate-away guard, and the "did my change take?" ambiguity all at once — and it's the cheapest fix on this list.

## What's Working

1. **`settings-chrome.css` as a real design system, with its reasoning attached.** One source for `.section > h3`, `.form-*`, `.toggle-*`, `.detail-card`, imported per-component via `<style scoped src>` so each keeps its own scope. The header documents the admission criterion (used by 2+ sections) and the specific bug that motivated it (45 inline margins, of which the first-card ones never applied because of margin collapsing). This is why the detector came back clean.

2. **Hint copy that explains consequences, not fields.** 「标题字体」doesn't say "choose a title font" — it says 衬线体是古籍手稿观感的来源，改成无衬线会让全站失去这层对比. 「减少动态效果」tells you the OS preference already works and this switch is only an extra force-on. 存档数据 states up front that export excludes the audio and asset libraries, because 换设备时才发现"东西没跟过来"已经太晚了. Most settings pages label; this one _counsels_.

3. **输出美化's three-stage structure.** 全局开关 → 已启用 (with per-rule toggles) → 可用规则库 (collapsed, count in the header) → 自定义规则. Progressive disclosure done right: the collapsed library shows `3 条未启用` so you know something is behind it. This is the shape the other complex sections should copy.

## Priority Issues

### [P0] The toggle control is invisible to keyboards and screen readers

`settings-chrome.css:139` sets `.toggle-input { display: none; }`. `display: none` removes the input from the tab order **and** from the accessibility tree. The visible `<span class="toggle-slider">` has no `role`, no `aria-checked`, no `tabindex`.

Measured live in 消息显示: 8 toggles, `display: "none"`, `offsetParent: null`, and `focusableInContent: 0`. A keyboard user can reach the section and then cannot operate a single thing in it. Seven components use this class: `MessagesSection`, `ThemeSection`, `WorldBookSection`, `BeautifierSection`, `AgentParamsCard`, `PresetManager`, `ImageRenderCard`.

**Why it matters**: PRODUCT.md commits to WCAG AA and states 键盘可用 as a design principle. This is a total failure of that promise on the most switch-dense surface in the app, and it silently contradicts the project's own accessibility section.

**Fix**: Replace `display: none` with the visually-hidden pattern — `position:absolute; opacity:0; width:1px; height:1px;` — keeping the input in flow, in the tab order, and in the a11y tree. Add `.toggle-input:focus-visible + .toggle-slider { outline: 2px solid var(--theme-primary); outline-offset: 2px; }`. One CSS edit fixes all seven components. `base.css:67` already defines the ring; the input just needs to be focusable enough to receive it.

**Suggested command**: `/impeccable audit`

### [P1] The unsaved-changes signal is computed and discarded

`s.agentDirty[id]` is set to `true` in `AgentConfigPanel.vue:155`, `AgentParamsCard.vue:65` and `:92`, cleared in two more places — and read **nowhere in the application**. Grep confirms: four writes, zero reads outside tests.

Meanwhile the Agent section is the only one of the thirteen with an explicit-save model. 「保存设置」sits at the bottom of a long scrolling panel, and both escape routes discard silently: switching agents in the sub-nav retriggers `watch(agentId, …, {immediate:true})` and reloads the drafts; switching main sections unmounts the panel behind `v-if`. Type a 2000-character system prompt, click the next agent to compare, and it's gone with no warning.

**Why it matters**: This section holds the most expensive-to-recreate content in the app. Losing it costs more than losing a save file, and the loss is silent.

**Fix**: Three consumers for the flag you already have — a dot on the dirty agent's `sub-nav-item`, a confirm on `selectAgent`/`selectSection` when dirty, and enable/disable `保存设置` off it so the button state answers "did that take?"

**Suggested command**: `/impeccable harden`

### [P1] Two save models and two confirm mechanisms in one page

Twelve sections write straight through to the store on change. One (Agent) requires an explicit click. Nothing marks the difference, so the user's mental model has to be per-section rather than page-wide — and the auto-saving twelve give no confirmation at all, so "did that take?" is unanswerable in both directions.

The same split runs through confirmations: `DataSection.vue:204` uses a native `window.confirm()` for pack uninstall, while the full data wipe two cards away uses a themed `AppModal`. One is an unstyled OS chrome box, the other matches the app.

And the Agent panel's action row reads **保存为默认 / 恢复成最新 / 保存设置** — three save-shaped verbs side by side, where the middle one is destructive. 「恢复成最新」calls `applyProjectDefaultToAgent`, discarding every override the user has made, on **one click with no confirmation**, reporting back with an `info` toast.

**Why it matters**: Heuristic 4 is the one users can't work around by being careful. Inconsistent save semantics turn every change into a small act of faith.

**Fix**: Pick auto-save-with-confirmation as the page-wide model, or explicit-save page-wide — not both. Route `window.confirm()` through `AppModal`. Rename 「恢复成最新」to 「放弃我的修改，恢复默认」and put it behind the same confirm as any other destructive action. Give it visual separation from the two save buttons.

**Suggested command**: `/impeccable clarify`

### [P1] Wayfinding doesn't scale to 13 sections, and the rail overflows unannounced

At a 1280×720 viewport I measured `.main-nav` `scrollHeight: 652` against `clientHeight: 615`, with the 创意工坊 entry's bottom edge at 744px — **below the fold, with no scroll affordance**. On a 720p laptop the workshop entry simply doesn't exist until you discover the rail scrolls.

Above that, there's no search, no per-section URL (single-URL state app), no keyboard navigation of the rail, and no cross-links between coupled settings. Coupling that the user has to carry in working memory:

- Agent 配置 is unusable until API 配置 has an entry — signalled only by eleven identical red badges.
- 记忆 & 缓存 says 「Embedding 端点请在「API 配置」中添加」as plain text, not a link.
- 图像生成's model lives on a card in that section while its endpoint lives in API 配置 — and the 主链接/模型 fields are deliberately hidden there.
- 本存档插画's cleanup control is in 存档数据, while every插画 setting is in 图像生成.

**Why it matters**: The secondary persona in PRODUCT.md — the 世界书/预设管理员 — lives in this page. Making them re-derive the map on every visit is exactly the extraneous load the product's own principles reject.

**Fix**: Add a filter input above the rail that matches section names _and_ control labels. Add a fade/shadow at the rail's scroll edge. Turn the plain-text cross-references into buttons that call `selectSection()`. Give the rail arrow-key navigation with `aria-current="page"` on the active item (currently absent — active state is colour and weight only).

**Suggested command**: `/impeccable layout`

### [P2] Failure messages in the primary configuration flow are developer strings

`ApiSection.vue:135` fires `ui.toast('ok', 'success')`. Line 146 fires `ui.toast('fail: ' + msg + hint, 'error')`. Line 247 dumps `API 密钥保存失败：${String(error)}` — a raw error object into a toast.

This is genuinely strange, because the _hints_ attached to those same messages are the best error copy in the codebase: the 401 branch says 「API Key 无效或与该服务不匹配，请按服务商文档核对 key 的来源与格式」, and the 404 branch distinguishes "this endpoint has no `/models`" from "your 主链接 is wrong." Someone thought hard about diagnosis and then prefixed it with `fail:`.

Compounding it: these are **toasts**, so a 100-character diagnostic auto-dismisses and can't be re-read, and it appears in a corner rather than beside the field that caused it. Adding an API endpoint is the first thing a new user must do, and it's the flow most likely to fail.

**Why it matters**: This is the surface's front door. The failure text here decides whether someone configures the product or closes it.

**Fix**: `'ok'` → 「连接成功，已获取 N 个模型」. `'fail: '` → 「连接失败」as a heading with the existing hint as body. Render the result inline in the modal under the API Key row instead of as a toast, so it persists while the user edits. Never `String(error)` into user-facing copy.

**Suggested command**: `/impeccable clarify`

## Persona Red Flags

**Alex (Impatient Power User)** — the closest match to the 世界书/预设管理员 persona in PRODUCT.md, who tunes prompts across 11 agents in a session:

- No keyboard shortcut opens settings, and none jumps between sections. Every section change is a mouse trip to the rail.
- No per-section URL. Alex cannot bookmark "the Agent tab," cannot share a link to it, and browser back doesn't move between sections.
- Comparing two agents' prompts costs a full round trip _and_ silently discards any unsaved edit on the way out.
- No bulk operations anywhere. Eleven agents share the same API pool selection, and it must be set eleven times.
- No per-section reset — only a global 清除所有数据 and a per-agent 恢复成最新.

**Sam (Accessibility-Dependent User)**:

- **Blocking**: eight toggles in 消息显示, zero focusable elements. Measured, not inferred. The section is inoperable.
- The nav rail's active state carries no `aria-current`. Sam hears fourteen identical buttons with no "you are here."
- The Agent sub-nav badges are `!` / `✕` / `✓` glyphs with no accessible text. "Is this agent configured?" is conveyed by a character and a colour.
- The theme grid's 10 swatches are buttons whose only content is `nameZh` plus a `✓` — the _state_ they select is a background gradient with no non-visual description.
- Positives worth keeping: `AppModal` handles `Escape` at document level, `base.css:67` defines a real focus ring, and every nav item pairs its icon with a text label.

**Jordan (Confused First-Timer)**:

- Lands on API 配置 with an empty state whose entire instruction is 「点击右上角「＋ 添加 API」」— the empty state points at a button instead of _being_ the button. The action is 500px away in the opposite corner.
- Clicking Agent 配置 next produces a wall of eleven red `!` badges and a 560px-wide void. Eleven alarms for one problem, and the fix is in a section Jordan just left.
- 「恢复成最新」is unguessable. Restore _what_ to _what_? Jordan will click it to find out, and lose their work.
- 存档数据 opens with three dense paragraphs about what backups exclude before showing a single control.

## Minor Observations

- **Mobile is unhandled, not degraded.** At 375px the rail takes 48% of the viewport (`navW: 179` of 375), the content pane is 190px wide holding 300px of content, and it scrolls horizontally inside itself — cards clip mid-word. `SettingsPage.vue` has exactly one media query and it's `prefers-reduced-motion`. Given PRODUCT.md's desktop framing this is a legitimate deprioritization, but "no breakpoint at all" is different from "chose a mobile layout."
- **Hover and active read too similarly on the rail.** Hover is `rgba(230,200,150,0.06)`; active is `color-mix(primary 8%, card-bg)` plus a border and weight 600. They're distinguishable side by side and ambiguous in a screenshot.
- **`min`/`max` on the 记忆 number inputs don't do what they look like they do.** HTML doesn't clamp typed values. `memorySnapshotLimit` flows through `main.ts:74` into `maxSnapshotsPerSave` unvalidated, and clearing the field yields an empty value on a `v-model.number`. No clamp exists anywhere in the chain.
- **`ContentStatusBanner` is undismissable.** `role="status"`, no close control, ~40px above the settings header on every view. For someone who has decided not to install a content pack, it's permanent.
- **输出美化's 导出规则/导入规则 float outside any card**, right-aligned below the last one — while 存档数据 puts the identical pair of actions _inside_ a card. Same action, two containers.
- **The Agent empty state is avoidable.** There's a persisted `s.activeAgent` and a resolver; on first run it's null and the user gets a void. Defaulting to the first agent costs one line and removes a screen that serves nobody.
- **`AboutSection` reports 1978 tests, `AGENTS.md` reports 2787.** Hand-maintained constants with a build date of 2026-06-15 in a file the header admits was never wired to a real source.
- **Nav buttons lack `type="button"`.** Harmless today (no enclosing form), but it's the kind of thing that breaks silently later.

## Questions to Consider

- **What if the rail were 5 groups instead of 13 items?** 连接 (API, Agent) · 内容 (世界书, 剧情, 记忆) · 呈现 (主题, 消息, 美化) · 媒体 (音频, 素材, 图像) · 系统 (数据, 关于). Miller's limit says 13 siblings is 3× over budget; the grouping is already implicit in the file's own comment about keeping the media three adjacent.
- **Why does one section have a Save button?** If the Agent panel could auto-save with an undo affordance like the other twelve, the dirty-state problem, the discard-on-navigate problem, and the three-ambiguous-verbs problem all disappear at once rather than being fixed three times.
- **Eleven red badges say one thing. What if the badge lived on 「Agent 配置」 in the rail instead**, and the sub-nav showed per-agent state only once the shared blocker is cleared?
- **What would this page look like if it opened with a search box instead of a section?** Thirteen sections and ~90 controls is past the size where browsing beats searching — and the hint text you've already written is exactly the corpus a search would index.
- **The hint copy is the best thing here. What if it were the organizing principle** — settings grouped by the decision they support rather than by the subsystem that owns them?
