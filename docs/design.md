# 命定之诗 — 前端设计规范

> **最后更新:** 2026-07-19（玄墨深度重设计同步）
> **适用范围:** 所有 `src/ui/` 下的页面和组件
> **状态:** 玄墨（古籍/手稿沉浸奇幻风）体系已落地 — 本文档持续更新

---

## 1. 设计理念

命定之诗是一款**文字 RPG 沉浸式叙事游戏**。UI 的目标是让玩家感觉自己在**读一本精美的古籍手稿**，而不是在使用一个工具。视觉锚点：BG3 日志面板、Fallen London、Disco Elysium。

### 核心原则

| 原则         | 说明                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| **叙事优先** | 正文区是视觉主角，所有面板退后服务于叙事                                                               |
| **玄墨基调** | 暖墨深底（`--theme-window-bg` #191512）+ 古金强调（`--theme-primary` #c9a86a），暖色由强调色与字体承载 |
| **纸面层次** | 用 `box-shadow` + `border-radius` 模拟纸张叠层，避免扁平化                                             |
| **品质可见** | 品质用**色点 + 名字着色**表达（见 5.3），禁止品质色左边条                                              |
| **衬线叙事** | 叙事正文和标题使用 `var(--theme-font-title)`（Noto Serif SC 衬线），UI 标签使用系统无衬线              |
| **主题无关** | 所有颜色来自 CSS 变量，不从特定主题色调出发设计                                                        |

### 绝对禁令（design hook 强制扫描）

| 禁令                                                                                   | 替代方案                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **侧边条强调**：`border-left/right` > 1px 的彩色强调条（卡片/列表项/callout）          | 全边 1px `color-mix(强调色 25-55%, var(--theme-card-border))` 边框 + 6-15% 染底 |
| **渐变文字**：`background-clip: text` + 渐变                                           | 单色 + 字重/字号表达强调                                                        |
| **布局属性过渡**：`transition: width/height/max-height/padding`                        | `transform: scaleX()` / opacity / `grid-template-rows`                          |
| **硬编码 `#fff` 于 primary 底上**                                                      | `var(--theme-primary-text)`（金底墨字 #1c150c）                                 |
| **不存在的 token**：`--theme-border` / `--theme-bg-primary` / `--theme-primary-rgb` 等 | 查 `variables.css` 确认后再引用；边框统一 `--theme-card-border`                 |

**激活态/强调徽章通用配方：**

```css
/* 激活态：染底 + 混合边框 */
background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
/* 语义徽章：success/error/warning 同理 */
background: color-mix(in srgb, var(--theme-success) 12%, transparent);
color: var(--theme-success);
border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
```

---

## 2. 排版

### 2.1 字体家族

| 用途               | 字体                       | CSS 变量                  | 示例                                 |
| ------------------ | -------------------------- | ------------------------- | ------------------------------------ |
| 叙事正文/标题      | Noto Serif SC, serif       | `var(--theme-font-title)` | 对话流正文、页面标题、物品名、角色名 |
| UI 标签/辅助文字   | system-ui, sans-serif      | (默认)                    | 按钮、标签、提示文字                 |
| 英文副标题（装饰） | Palatino Linotype, serif   | —                         | 首页英文副标                         |
| 风味引文（装饰）   | KaiTi/楷体                 | —                         | 首页风味文字                         |
| 代码/脚本          | 'Cascadia Code', monospace | —                         | 脚本展示区、正则预览                 |

**层级约定**：分区大标题（设置页 section h3 等）用 `var(--theme-font-title)` + `1.3-1.4rem`，正文与列表保持无衬线，形成"手稿标题 + 工整正文"的古籍对比。

> 🔴 这两个变量的取值**由用户在设置页决定**（正文字体 / 标题字体两格），主题不参与。
> 写组件时照旧按语义选变量 —— 叙事与标题用 `--theme-font-title`，UI 标签用
> `--theme-font-body` —— 不要硬写字体名，也不要假设 title 一定是衬线。详见 §7.4。

### 2.2 字号层级

| 层级          | 字号                    | 用途                     |
| ------------- | ----------------------- | ------------------------ |
| **页面标题**  | `1.125rem` (18px)       | 角色详情名、物品详情名   |
| **区块标题**  | `0.875rem` (14px)       | NPC 名、消息气泡正文     |
| **正文**      | `0.8125rem` (13px)      | 列表项、描述文字、属性值 |
| **辅助文字**  | `0.75rem` (12px)        | 标签、meta 信息          |
| **小字/徽章** | `0.6875rem` (11px) 以下 | 时间戳、计数 badge、提示 |
| **导航按钮**  | `0.875rem` (14px)       | SideToolbar、Tab 按钮    |

### 2.3 字重

| 用途                      | 字重              |
| ------------------------- | ----------------- |
| 页面标题（角色名/物品名） | `700` (bold)      |
| 列表项名                  | `600` (semi-bold) |
| 正文/描述                 | `400` — `500`     |
| 标签/辅助                 | `400` — `500`     |
| 品质徽章                  | `600`             |

### 2.4 行高

| 场景                    | `line-height`             |
| ----------------------- | ------------------------- |
| **叙事正文** (ChatFlow) | `1.7`                     |
| **描述文字** (详情面板) | `1.55` — `1.7`            |
| **列表项**              | `1.5`（单行截断用省略号） |

### 2.5 首行缩进

叙事正文段落（`.narrative-body p`）必须设置 `text-indent: 2em`，段落间距 `margin-bottom: 0.6em`。对话卡片内的段落不缩进。

---

## 3. 间距

### 3.1 Token 系统

所有间距从 `variables.css` 中取值，**禁止硬编码像素**：

| Token                 | 值   | 用途                     |
| --------------------- | ---- | ------------------------ |
| `--theme-spacing-xs`  | 4px  | 紧密元素间距             |
| `--theme-spacing-sm`  | 8px  | 标签间距、图标间隙       |
| `--theme-spacing-md`  | 12px | 卡片内 padding、模块间距 |
| `--theme-spacing-lg`  | 16px | 面板 padding、主区块间距 |
| `--theme-spacing-xl`  | 24px | 大段间隔                 |
| `--theme-spacing-2xl` | 32px | 页面级间距               |

### 3.2 模块间距

| 模块                  | 内部 gap       | 外部 margin/padding        |
| --------------------- | -------------- | -------------------------- |
| 面板根容器            | `gap: 12-14px` | `padding: 16px` (Modal 内) |
| Section 区块          | `gap: 8-10px`  | 上下 `padding: 10-12px`    |
| 列表项                | `gap: 3-6px`   | `padding: 7-10px`          |
| 卡片（NPC/装备/技能） | `gap: 8-10px`  | `padding: 10px`            |
| Tab 按钮              | `gap: 6px`     | `padding: 7-10px`          |

---

## 4. 组件样式规范

### 4.1 按钮

遵循已定义的 `AppButton.vue` 四种变体：

| 变体          | 背景              | 文字色       | 边框                  | hover              |
| ------------- | ----------------- | ------------ | --------------------- | ------------------ |
| **primary**   | `--theme-primary` | primary-text | primary               | `brightness(1.1)`  |
| **secondary** | `--theme-card-bg` | primary      | `--theme-card-border` | bg → surface-muted |
| **danger**    | `--theme-error`   | `#fff`       | error                 | `brightness(1.1)`  |
| **ghost**     | transparent       | secondary    | transparent           | bg → hover         |

**自定义按钮（不在 AppButton 范围内的）：**

- 圆角：`var(--theme-radius-sm)`（4px）
- 过渡：`var(--theme-transition-fast)`（0.15s ease）
- hover: 背景色变化 + 文字色变化，禁止 scale 变换
- 触摸目标：≥ 36px 高度

### 4.2 卡片 — 统一外壳

所有**信息面板卡片**（概述卡片、物品详情、角色详情、系统卡片）共享以下规则：

| 属性            | 值                                   |
| --------------- | ------------------------------------ |
| `background`    | `var(--theme-card-bg)`               |
| `border`        | `1px solid var(--theme-card-border)` |
| `border-radius` | `var(--theme-radius-md)` (6px)       |
| `box-shadow`    | 叠纸阴影（见下）                     |
| 内部 padding    | `10-16px`（根据上下文）              |

**叠纸阴影（`--paper-stack`）：**

```css
--paper-stack:
  0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
  0 4px 12px rgba(0, 0, 0, 0.08);
```

**品质色点 + 名字着色（项目统一方案）：** 物品/装备/角色列表项在名字前放一个品质色圆点（`8px` 圆形，`background: qualityVar(...)`），名字本身着品质色。**禁止 `border-left: 3px solid` 品质色左边条。**

**品质光晕：** 详情面板通过 CSS 自定义属性 `--item-detail-glow` 传递品质色，在 `.d-header` 底部用 `box-shadow` 实现微弱光晕。

**选中态：** 选中卡片使用 8% 染底（`color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg))`）+ `box-shadow: 0 0 0 1px var(--theme-color-primary)` 环绕光晕环。

### 4.3 导航 Tab

**下划线式 Tab（推荐用于详情面板）：**

- 背景：`transparent`
- 未选中：`color: var(--theme-text-muted)`，底部透明线
- 选中：`color: var(--theme-text-primary)`，`border-bottom: 2px solid var(--theme-primary)`
- 字体：`var(--theme-font-title)`，`letter-spacing: 0.03em`
- Tab 之间 `gap: 0`，底部边框线连续

**分段按钮式 Tab（推荐用于主类别切换，如背包/装备/技能）：**

- 外层容器：`background: var(--theme-surface-muted)` + `border-radius: var(--theme-radius-md)` + `padding: 4px`
- 未选中按钮：`background: transparent` + `color: var(--theme-text-secondary)`
- 选中按钮：`background: var(--theme-card-bg)` + `color: var(--theme-text-primary)` + `font-weight: 600` + `box-shadow: var(--theme-shadow-sm)`
- hover：`background: var(--theme-tab-hover-bg)` + `color: var(--theme-text-primary)`

### 4.4 面板（Panel）

**信息页面板（Modal 内打开）：**

- Master-Detail 两栏布局：左栏 `18rem`（列表）+ `gap: 16px` + 右栏 `flex:1`（详情）
- 左栏列表：卡片背景 + `box-shadow: var(--paper-stack)`
- 右栏详情：同上 + Section 标题用 `::after` 渐变装饰线

**侧边面板（ScenePanel / StatusHUD）：**

- 背景：`var(--theme-content-bg)`
- 分隔：`border-right` 或 `border-left: 1px solid var(--theme-card-border)`

### 4.5 Modal 对话框

| 属性            | 值                                                       |
| --------------- | -------------------------------------------------------- |
| `background`    | `var(--theme-overlay-bg)` + `backdrop-filter: blur(4px)` |
| `border-radius` | `var(--theme-radius-xl)` (12px)                          |
| `box-shadow`    | `var(--theme-shadow-lg)`                                 |
| 关闭按钮        | × 字符，hover 变色                                       |
| Esc 关闭        | 必须支持                                                 |

### 4.6 系统通知条 / 折叠卡片

- 折叠态通知条：窄条 + 名字前品质色点 + 右箭头 `▶`（不使用品质色左边框）
- 展开态：完整卡片（参考 cards-shared.css）
- 过渡：卡片展开用 `<Transition>` 内的 `v-if`

---

## 5. 装饰规范

### 5.1 Section 标题装饰线

块级 section 标题（如"效果""描述""基础信息"）使用 `::after` 伪元素画渐变装饰线：

```css
.d-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
```

标题本身设置 `display: flex; align-items: center; gap: 6px;` 使装饰线填充剩余空间。

### 5.2 空态

空态不使用纯文字"暂无数据"，统一为：

```html
<div class="empty-tab">
  <!-- ::before 伪元素渲染装饰分隔符 -->
  暂无物品 / 暂无角色 / 书页尚空…
</div>
```

CSS：

```css
.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}
```

### 5.3 品质色使用

所有与物品/角色/装备品质相关的颜色统一通过 `quality-colors.ts` 的 `qualityVar()` 获取：

```ts
import { qualityVar } from '../../lib/quality-colors'
// 用法：内联 style 绑定
:style="{ color: qualityVar(item.rarity) }"        // 名字着色
:style="{ background: qualityVar(item.rarity) }"   // 品质色点
```

**表达形式统一为"色点 + 名字着色"**，禁止品质色左边条。**禁止在组件中硬编码品质色 hex。**

---

## 6. 过渡与动画

### 6.1 微交互

| 场景          | 时长             | 效果                                                            |
| ------------- | ---------------- | --------------------------------------------------------------- |
| 按钮 hover    | `0.15s ease`     | 背景色/边框色过渡                                               |
| Tab 切换      | `0.15-0.2s ease` | 颜色 + 下划线过渡                                               |
| 卡片展开/折叠 | `0.25s ease`     | `grid-template-rows: 0fr→1fr` + opacity（禁止 max-height 过渡） |
| 消息入场      | `0.35s ease`     | opacity + translateY(12px)                                      |

### 6.2 面板切换

Modal 打开：`<Transition name="modal">` — fade + scale(0.97→1)

### 6.3 prefers-reduced-motion

全局已设置 `@media (prefers-reduced-motion: reduce)` 禁用所有动画。所有自定义动画必须配合此媒体查询。

---

## 7. 数据展示模式

### 7.1 Master-Detail 布局

信息页（背包、角色列表）统一使用 Master-Detail：

- **左栏（Master）:** `width: 18rem`，列表/卡片区，可滚动
- **右栏（Detail）:** `flex: 1`，选中项详情，可滚动
- 两栏间距：`gap: 16px`

### 7.2 KV 信息网格

属性信息使用 grid 布局：

```css
.ov-info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 14px;
}
```

每个 KV 行：`display: flex; justify-content: space-between`，左侧标签 `color: --theme-text-muted`，右侧值 `color: --theme-text-primary`。

### 7.3 装备/技能列表

每项用独立卡片：`padding: 10px` + `border: 1px solid var(--theme-card-border)` + 名字前品质色点 + 效果行用虚线分隔。

---

## 7.4 字体：设置严格压过主题（2026-08-05 定案）

> 本节此前是「已知问题 · 未修复」，记着两个待拍板的方案。**主人已拍板：走方案 A
> 的严格版，并把三档单选拆成正文 / 标题两格独立设置。**

### 规则

**字体由设置页「外观主题」分区的两格决定，主题一律不参与。**

| 设置项       | 写的变量             | 出厂默认              | 影响面                                           |
| ------------ | -------------------- | --------------------- | ------------------------------------------------ |
| **正文字体** | `--theme-font-body`  | 无衬线 (Noto Sans SC) | UI 标签、表单、列表、说明文字                    |
| **标题字体** | `--theme-font-title` | 衬线 (Noto Serif SC)  | 分区标题、叙事正文、角色名、物品名（111 处引用） |

`--theme-font-display`（Cinzel）**不可配置** —— 它是纯装饰拉丁字体，没有中文字形，
只服务英文副标/章节数字。

### 三条硬约束

1. **主题 CSS 里不许出现 `--theme-font-*` 声明。** 唯一允许的地方是
   `themes/variables.css` 的 `:root`（没有 JS 时的兜底）。闸门：`themes/theme-fonts.test.ts`
   逐文件扫描，注释里提这个名字可以，写成声明就红。
2. **`initFonts()` 必须在挂载前跑**（`main.ts`，紧跟 `init()` / `initFontSize()`）。
   它把两格写成 `<html>` 的**内联变量** —— 内联压得过任何 `[data-theme]` 规则，
   「设置说了算」就是靠这个强制的。
3. **默认值也要写内联变量**，不能因为「等于默认」就跳过。跳过等于在默认档上把
   决定权又交还给主题。

### 修掉的三处（症状全都不在改动处）

1. `setFonts()` 往 `fated-poem-fonts` **写了却没有任何读取点** —— 刷新后 ref 重置、
   DOM 无内联覆盖，字体退回主题说了算，而下拉框仍显示用户选的值。补 `initFonts()`。
2. `parchment` / `ivory` 把 `--theme-font-body` 定义成衬线 —— 换主题悄悄改掉正文字体。
   已从主题 CSS 移除（`misty-lilac` 那两行只是原样重复 `:root`，一并删掉，
   留着会诱使人以为「主题可以定字体」）。
3. `mixed` 档写的是 `'Noto Sans SC', 'Noto Serif SC', sans-serif` —— 一条字体栈，
   有中文字形的字符全部命中第一个，**渲染出来和 `sans` 一模一样**。三个选项实际只有
   两种结果。拆成两格后这一档自然消失。

### 字体从哪来 —— 自托管，零外部请求（2026-08-05）

2026-08-05 之前，字体与图标从两个 CDN **运行时加载**（`fonts.googleapis.com` 与
`cdnjs.cloudflare.com`）。现已全部自托管，`index.html` 里**一条外链都不剩**。

| 资源                                       | 包                              | 许可                                 |
| ------------------------------------------ | ------------------------------- | ------------------------------------ |
| Noto Sans SC / Noto Serif SC / Cinzel      | `@fontsource-variable/*`        | SIL OFL 1.1                          |
| Font Awesome Free 6.7.2（solid + regular） | `@fortawesome/fontawesome-free` | 图标 CC BY 4.0 · 字体 OFL · 代码 MIT |

**为什么必须改**：CDN 失败时**没有任何报错** —— `font-display: swap` 安静地落到系统字体，
图标退化成方框，而设置页仍显示「衬线」。`fonts.googleapis.com` 在中国大陆长期不可达，
对一款中文游戏来说，这意味着相当一部分玩家从来没见过设计里那套字体。§1「玄墨基调」
写着「暖色由强调色**与字体**承载」，而那一半此前是挂在一条会静默失效的外链上的。

**用变量字体而不是逐字重静态包**：静态包 4 字重 × 2 中文族约 34MB，变量包一共 10.6MB
覆盖 100–900 全区间。两者都保留 Google 的 unicode-range 切片（每族 101 个子集），
浏览器只下载正文用到的那几片。

🔴 **族名带 `Variable` 后缀**（`'Noto Sans SC Variable'`）。写成不带后缀的名字不会报错，
只会安静地退回系统字体 —— 与它替掉的那个 bug 一模一样的失败形态。闸门：
`tests/theme-fonts-invariant.test.ts` 逐条断言第一顺位必须带后缀。

🔴 **署名是许可义务，不是装饰**：Font Awesome 图标按 CC BY 4.0 授权，要求署名可见 ——
写在设置页「关于」分区，删之前先读 `THIRD-PARTY-NOTICES.md`。许可证全文随 `dist` 分发在
`/licenses/`（`public/licenses/` 被 Vite 逐字复制）。

🔴 **CSS 里那批专有系统字体不能打包**（Monaco / Menlo / Consolas / Courier New /
Palatino Linotype / KaiTi / STKaiti）。它们只是兜底：本应用从不下载，用户机器上有就用。
**按名字引用不是分发**，把 `.ttf` 放进仓库才是侵权。这条边界别越过去。

闸门：`tests/no-external-assets.test.ts`（无外链 / 只引用到的 FA 分册 / 许可证与署名齐全）。

### 旧设置怎么迁

旧的三档只影响正文，从没碰过 `--theme-font-title`。所以**照用户实际看到的样子迁**：
`'serif'` → 正文衬线；`'sans'` / `'mixed'` → 正文无衬线；标题一律取默认衬线。
迁移只在两个新键都没设过时发生（`theme-store.fonts.test.ts` 钉住）。

---

## 8. 检查清单

每个新页面/组件交付前应确认：

- [ ] 所有颜色来自 CSS 变量，无硬编码 hex（primary 底上文字用 `--theme-primary-text`，不用 `#fff`）
- [ ] 没有引用不存在的 token（`--theme-border` / `--theme-bg-primary` 等）
- [ ] 没有 >1px 的彩色侧边条（border-left/right），品质用色点 + 名字着色
- [ ] 没有渐变文字（`background-clip: text`）
- [ ] 过渡不使用布局属性（width/height/max-height/padding）
- [ ] 叙事/标题文字使用 `var(--theme-font-title)`（Noto Serif SC）
- [ ] 间距使用 `--theme-spacing-*` 变量
- [ ] 卡片使用 `--paper-stack` 阴影或等效纸叠效果
- [ ] 空态有装饰符 + 斜体说明文字
- [ ] Section 标题有 `::after` 渐变装饰线
- [ ] 品质相关颜色通过 `qualityVar()` 获取
- [ ] 按钮 hover/active 有过渡动画
- [ ] 可折叠区域使用 `<Transition>` 包裹
- [ ] `prefers-reduced-motion` 已考虑
- [ ] 触摸目标高度 ≥ 36px（桌面端最低要求）
- [ ] 交互元素有 `role` / `aria-label` / 键盘事件（如适用）
