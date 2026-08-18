# InputBar 多行输入改造设计（2026-08-04）

## 背景

游戏页输入框（`src/ui/components/game/InputBar.vue`）目前是单行 `<input type="text">`，绑定 `@keydown.enter="handleSend"`，回车即发送、无法换行、Shift+Enter 也会误触发发送。

## 目标

1. **Enter = 发送，Shift+Enter = 换行**（Discord 惯例，主人在实机游玩中的需求）
2. **多行输入**：textarea 化，随内容自动增高（上限约 6 行，超出内部滚动），右下角保留拖拽手柄可手动上下拉
3. **placeholder 提示**按键习惯：`输入你的行动…（Enter 发送 · Shift+Enter 换行）`

## 方案

| 项       | 做法                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 元素     | `<input type="text">` → `<textarea rows="1">`，`v-model="input"` 数据流不变                                                                                 |
| 按键     | `@keydown` 手动判断：`e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey` → `preventDefault()` + 发送；Shift+Enter 不拦截，交给 textarea 原生换行 |
| 自动增高 | `@input` 时按 `scrollHeight` 重设高度；发送清空 / 外部填充（pendingInput）经 `watch` 兜底复位。CSS `min-height`/`max-height` 钳制行数                       |
| 拖拽     | `resize: vertical`（只允许上下拉，防左右破坏布局）                                                                                                          |
| 样式     | 复用现有 `.input-field` 类名与主题 token（`--theme-card-bg`/`--theme-card-border`/`--theme-primary` 聚焦），补齐 `line-height`、`prefers-reduced-motion`    |

## 范围

仅改动 `src/ui/components/game/InputBar.vue` 一个文件。选项弹窗（options-popup）、发送/停止按钮、emit 契约均不动。

## 测试

纯 UI 交互改动，无新增逻辑测试。验证方式：`npm run typecheck` 通过 + 主人真机按键确认。
