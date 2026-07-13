# 游戏页 UI 全面优化 — 实现计划

> **For agentic workers:** 每个 Task 独立可执行，按 Phase 分组，同 Phase 内可并行。

**Goal:** 从排版质感、可访问性、代码质量三个维度优化游戏页 14 个组件文件

**Architecture:** 分 3 个 Phase 推进，P0 快速修 Bug 和文本可读性，P1 提升交互体验和可访问性，P2 清理技术债和代码复用。每个 Phase 内任务互相独立可并行执行。

**Tech Stack:** Vue 3 + Pinia + CSS 变量主题系统 + Vitest

## Global Constraints

- 不改颜色 token 值，所有改动必须适配 10 个主题
- 不改布局结构（四栏），只改 CSS/模板/脚本
- 所有动画必须配合 `prefers-reduced-motion` 媒体查询
- 每个 Task 完成后跑 `npm run typecheck` + `npm run test -- --run`

---

### Phase 0: 快速修复（Bug + 文本可读性）

### Task 0.1: 叙事正文段落排版 + 消息入场动画

**Files:**
- Modify: `src/ui/components/game/ChatFlow.vue`

**改动：**
1. `.narrative-body` 内 `<p>` 加 `text-indent: 2em` + 段间距
2. `.bubble-row` 加 fadeIn 入场动画 + `prefers-reduced-motion` 兜底
3. 删除死代码 `.system-card-header` / `.system-card-icon` / `.system-card-title` / `.system-card-chevron` / `.system-card-body`（ChatFlow 模板不再使用，卡片由独立组件渲染）

- [ ] 添加叙事段落缩进 CSS
- [ ] 添加消息入场 keyframes + reduced-motion 兜底
- [ ] 删除 384-413 行死 CSS
- [ ] Commit: `fix(ui): ChatFlow — 叙事首行缩进 + 入场动画 + 清理死 CSS`

### Task 0.2: 系统卡片圆角溢出修复

**Files:**
- Modify: `src/ui/components/game/cards/CombatSystemCard.vue`
- Modify: `src/ui/components/game/cards/ItemSystemCard.vue`

**改动：** 各自 `.sys-card` 加 `overflow: hidden; border-radius: var(--theme-radius-md, 6px);`，确保左边框不穿出圆角

- [ ] CombatSystemCard `.sys-card` 加 overflow + border-radius
- [ ] ItemSystemCard `.sys-card` 加 overflow + border-radius
- [ ] Commit: `fix(ui): Combat/Item 卡片圆角溢出 — 加 overflow:hidden`

### Task 0.3: prefers-reduced-motion 全局支持

**Files:**
- Modify: `src/ui/themes/variables.css`

**改动：** 在文件末尾添加全局 `@media (prefers-reduced-motion: reduce)` 规则

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] 在 variables.css 末尾添加 reduced-motion 规则
- [ ] 验证：`grep -r "prefers-reduced-motion" src/ui/` 能找到
- [ ] Commit: `fix(a11y): 全局 prefers-reduced-motion 支持`

### Task 0.4: CharGenSystemCard 硬编码颜色修复

**Files:**
- Modify: `src/ui/components/game/cards/CharGenSystemCard.vue`

**改动：** 将 `.ci-name` 和 `.ci-tier-badge` 中的 `color: #fff` 改为 `color: var(--theme-text-primary)`，确保浅色主题下文字可见

- [ ] `.ci-name` 的 `color: #fff` → `color: var(--theme-text-primary)`
- [ ] `.ci-tier-badge` 的 `color: #fff` → `color: var(--theme-text-primary)`
- [ ] 检查模板中其他 hardcoded `#fff`，改用 `var(--theme-text-primary)` 或保持（需逐个判断上下文）
- [ ] Commit: `fix(ui): CharGenCard hardcode #fff → theme var`

### Task 0.5: CraftSystemCard ratingMeta 硬编码 hex → CSS 变量

**Files:**
- Modify: `src/ui/components/game/cards/CraftSystemCard.vue`

**改动：** `ratingMeta` 中的 `#e53e3e`/`#fc8181`/`#68d391`/`#ffd700` 改为引用 CSS 变量的内联 style 或使用主题 token

```ts
// 改为用 CSS 变量 token
const ratingMeta: Record<string, { icon: string; colorVar: string }> = {
  '大失败':     { icon: 'fa-regular fa-circle-xmark',       colorVar: '--theme-error' },
  '失败':       { icon: 'fa-solid fa-triangle-exclamation', colorVar: '--theme-warning' },
  '成功':       { icon: 'fa-regular fa-circle-check',      colorVar: '--theme-success' },
  '精益求精': { icon: 'fa-solid fa-star',                colorVar: '--theme-quality-legendary' },
}
```
模板中使用 `var(${ratingMeta[event.rating]?.colorVar})` 替代直接 hex。

- [ ] ratingMeta 改为 colorVar token
- [ ] 模板中 `:style` 绑定改为 `var()` 引用
- [ ] Commit: `fix(ui): CraftCard rating hex → CSS var tokens`

---

### Phase 1: 可访问性 & 交互

### Task 1.1: 键盘可访问性 — div@click 改 button/role

**Files:**
- Modify: `src/ui/components/game/ScenePanel.vue`
- Modify: `src/ui/components/game/StatusOverview.vue`
- Modify: `src/ui/components/game/ChatFlow.vue`
- Modify: `src/ui/components/game/InputBar.vue`

**改动：**
- ScenePanel NPC 行 `.scene-npc-item`：加 `role="button" tabindex="0"` + `@keydown.enter` / `@keydown.space`
- ScenePanel 新闻项 `.news-item`：同上
- StatusOverview 折叠 section header：加 `role="button" tabindex="0"` + `aria-expanded`
- ChatFlow 系统通知条 `.system-notif`：改为 `<button>` 或加 `role="button" tabindex="0"`
- InputBar 可选行动按钮：加 `aria-haspopup="listbox"` + `:aria-expanded="showOptions"`

- [ ] ScenePanel 所有可点击 div 加 keyboard 支持
- [ ] StatusOverview section header 加 aria-expanded
- [ ] ChatFlow .system-notif 加 role="button"
- [ ] InputBar 选项按钮加 aria 属性
- [ ] Commit: `fix(a11y): 键盘可访问性 — div@click 加 role/aria`

### Task 1.2: ARIA labels + 触摸目标 + InputBar 禁用

**Files:**
- Modify: `src/ui/components/game/SideToolbar.vue`
- Modify: `src/ui/components/game/InputBar.vue`
- Modify: `src/ui/components/game/ScenePanel.vue`
- Modify: `src/ui/components/game/ChatFlow.vue`
- Modify: `src/ui/components/game/GamePage.vue`

**改动：**
- SideToolbar 按钮加 `:aria-label="tool.label"`
- 触摸目标放大：ScenePanel NPC 行 padding 5→7px，ChatFlow .system-notif padding 8→10px，InputBar .option-item padding 8→10px
- InputBar 加 `disabled` prop，生成中禁用输入框和发送按钮
- ChatFlow 消息容器加 `tabindex="0"` 支持键盘滚动

- [ ] SideToolbar aria-label
- [ ] 各处触摸目标 padding 微调
- [ ] InputBar disabled prop + GamePage 传值
- [ ] ChatFlow .chat-messages tabindex="0"
- [ ] Commit: `fix(a11y): ARIA labels + touch targets + InputBar disabled`

### Task 1.3: StatusOverview 折叠过渡动画

**Files:**
- Modify: `src/ui/components/game/StatusOverview.vue`

**改动：** 将 3 处 `v-show` 改为 `v-if` + `<Transition name="collapse">`，添加 CSS 过渡

```css
.collapse-enter-active,
.collapse-leave-active {
  transition: max-height 0.25s ease, opacity 0.2s ease;
  overflow: hidden;
}
.collapse-enter-from,
.collapse-leave-to {
  max-height: 0;
  opacity: 0;
}
.collapse-enter-to,
.collapse-leave-from {
  max-height: 800px;
  opacity: 1;
}
```

- [ ] v-show → v-if + Transition
- [ ] 添加 collapse 过渡 CSS
- [ ] Commit: `feat(ui): StatusOverview 折叠过渡动画`

---

### Phase 2: 代码质量

### Task 2.1: CSS 去重 — 提取共享卡片样式

**Files:**
- Create: `src/ui/styles/cards-shared.css`
- Modify: `src/ui/components/game/cards/CraftSystemCard.vue`
- Modify: `src/ui/components/game/cards/CombatSystemCard.vue`
- Modify: `src/ui/components/game/cards/ItemSystemCard.vue`

**改动：** 将 `.stat-badge`、`.section-label`、collapse-chevron 等重复样式提取到 `cards-shared.css`，各卡片组件通过 `<style scoped>` 中的 `@import` 或直接引用全局 class 使用。

- [ ] 创建 cards-shared.css
- [ ] Craft/Combat/Item 卡片引用共享样式
- [ ] Commit: `refactor(ui): 提取共享卡片 CSS — stat-badge/section-label/collapse-btn`

### Task 2.2: ChatFlow 卡片分发 v-if 链 → 动态组件

**Files:**
- Modify: `src/ui/components/game/ChatFlow.vue`

**改动：** 4 层 `v-if/v-else-if` 改为 `component :is` + computed map

```ts
const CARD_COMPONENTS: Record<string, Component> = {
  craft: CraftSystemCard,
  char_gen: CharGenSystemCard,
  combat: CombatSystemCard,
  item_gen: ItemSystemCard,
}
```
模板：`<component :is="CARD_COMPONENTS[msg.systemEvent.type]" :event="msg.systemEvent" @collapse="collapseCard(msg.id)" />`

- [ ] 添加 CARD_COMPONENTS map
- [ ] 模板替换 v-if 链为动态组件
- [ ] Commit: `refactor(ui): ChatFlow 卡片分发 — v-if 链 → 动态组件`

### Task 2.3: SideToolbar 宽度优化

**Files:**
- Modify: `src/ui/components/game/SideToolbar.vue`

**改动：** 展开宽度 8.75rem → 6rem，按钮 padding/gap 微调

```css
.side-toolbar { width: 6rem; }
.tool-btn { padding: 10px 10px; gap: 8px; }
.tool-btn i { font-size: 0.9rem; width: 1rem; }
```

- [ ] SideToolbar 宽度 + 按钮尺寸调整
- [ ] Commit: `refactor(ui): SideToolbar 宽度 140→96px`

### Task 2.4: GamePage 微小清理

**Files:**
- Modify: `src/ui/components/game/GamePage.vue`

**改动：**
- 提取重复的 `@update:open` handler 为 `onModalOpenChange(v: boolean)` 方法
- 给 `.game-page-layout` 加 `min-width: 900px` 防止窄屏布局崩溃

- [ ] 提取 onModalOpenChange 方法
- [ ] 添加 min-width
- [ ] Commit: `fix(ui): GamePage — dedup modal handler + min-width guard`
