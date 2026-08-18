# 记忆 & 快照面板打磨 — 交接记录（2026-08-10）

> 本次会话对游戏页的两个弹窗面板做了「规范对齐 + 轻交互升级」（主人拍板的范围），
> 行为逻辑零改动。本文是交接文档：改了什么、怎么验证的、还欠什么。

## 范围与裁定

- **目标文件**：`src/ui/components/game/MemoryPanel.vue`、`src/ui/components/game/SnapshotPanel.vue`（仅这两个）。
- **范围裁定**（用户选项）：规范打磨 + 轻交互升级；**不做**信息架构重设计。
- **行为零改动**：筛选/排序/分页/详情导航/复制/删除/恢复流程/战斗锁定全部原样；
  `window.confirm` 是全应用惯例（14 处在用），刻意保留。

## 修掉的规范违规（依据 `docs/design.md`）

两个面板共同的：

- **假 token**：`SnapshotPanel` 引用了根本不存在的 `--theme-danger` / `--theme-on-primary`，
  实际渲染一直走 fallback 硬编码色（`#e5484d` / `#fff`，后者恰好踩中「primary 底上禁 #fff」）。
  已换成真 token（`--theme-error` / 激活态配方）。
- **硬编码 hex**：`MemoryPanel` 星级三色（`#f59e0b` / `#94a3b8` / `#64748b`）清除；
  两文件现在 **0 个 hex 字面量**，全部走 CSS 变量 + `color-mix` 配方。
- **空态**：裸文字 → §5.2 装饰空态（`::before '—'` + 斜体 muted）。
- **卡片外壳**：`radius-sm` → `--theme-radius-md`，补 `--paper-stack` 叠纸阴影。
- **间距**：裸 px → `--theme-spacing-*` token。
- **字体层级**：面板/详情标题与叙事性内容改用 `var(--theme-font-title)`（衬线）。
- **交互态**：交互元素补 `:focus-visible`、hover 过渡走 `--theme-transition-fast`，
  过渡只碰 color/background/border-color/box-shadow（无布局属性过渡）。

## 轻交互升级

### MemoryPanel（记忆）

- 重要度从 `'★'.repeat(n)`（最长 10 个星字符）换成克制的 `★ N` 徽章，
  三档阈值不变（≥8 / ≥5 / 其余），按 §1 染底配方着色
  （primary / text-secondary / text-muted）；★ 加 `aria-hidden`，数字是可访问内容。
  `starText()` 删除，`starClass()` 更名 `importanceClass()`。
- 详情视图：徽章旁加「重要度 N/10」文字；「内容」「关键词」两个 §5.1 装饰线小节标题。
- 卡片层次：记忆正文为主角（衬线、line-clamp 3 保留），id 单行截断，
  关键词改成 chip（最多 3 个）。
- 顺手修了一个布局缺陷：`.memory-wall` 补 `min-height:0` flex 列，
  让 `.card-grid` 既有的 `flex:1; overflow-y:auto` 真正滚动（此前在块级父容器里失效）。

### SnapshotPanel（快照）

- 列表改成**回合时间线**：每行是 20px 沟槽 + 卡片的两列 grid，
  沟槽里是节点圆点（当前快照 primary 实心）+ 1px 连接线（伪元素，
  **不是**被禁的卡片彩色边条）；行距由卡片 margin 供给使连接线连续，首尾行修边。
- 「当前」徽章从实心 primary+白字改为激活态配方（8% 染底 + 30% 混合边框 + primary 字）。
- 战斗警告 / 错误行改语义徽章配方（`--theme-warning` / `--theme-error` 染底）。
- 当前卡片：8% primary 染底 + `0 0 0 1px` 光晕环 + 叠纸阴影。

## 验证证据

| 闸门                                                              | 结果                          |
| ----------------------------------------------------------------- | ----------------------------- |
| impeccable 机械检测器（两文件）                                   | 0 违规                        |
| `npm run typecheck` + `npm run typecheck:vue`                     | 全过                          |
| `MemoryPanel.test.ts`                                             | 8/8 过（未改测试）            |
| 全量 `npm run test -- --run`                                      | 7341 过 / 1 挂 / 9 跳过       |
| `npm run lint`（--max-warnings 0）                                | 零输出通过                    |
| diff 六判据复查（逻辑不变/无 hex/无假 token/无彩边条/无布局过渡） | 全过                          |
| Prettier                                                          | 两文件均已 `--write` 且 clean |

**那 1 个挂的**：`src/ui/stores/content-store-registry.test.ts`
（「装包后再跑一轮加载不会把 pack 面冲掉」）—— 单独跑 17/17 全过，
是跨文件并行顺序 flake，与本次两个纯展示组件改动无关（本次 diff 无任何 store/逻辑变更）。

## 欠着的（下个会话按需接手）

1. **真机视觉走查未做**：预览浏览器是全新 profile 没有存档、面板隐藏时无法出截图，
   两个面板都在游戏页弹窗里需要活存档才能打开。按仓库惯例记「待真机」——
   走一遍：进游戏 → 侧栏打开「记忆」「快照」弹窗，重点看时间线连接线的首尾修边、
   重要度徽章三档在 10 个主题下的对比度。
2. **预先存在的主题缺口（非本次引入）**：`ivory.css` / `ocean.css` / `parchment.css`
   没定义 `--paper-stack`，这三个主题下卡片无阴影 —— CharacterListPanel/ItemsPanel
   早有同样缺口，宜一并补 token 而不是逐组件绕。
3. **等宽字体无 token**：`.detail-real` / `.card-time` 等仍写字面 `monospace`
   （`variables.css` 没有 `--theme-font-mono`），全仓同状况，未动。
