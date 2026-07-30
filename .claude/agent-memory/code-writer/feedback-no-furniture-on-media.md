---
name: feedback-no-furniture-on-media
description: 主人拒绝把控件盖在图像上（画像旋钮/相机徽章/浮层）——媒体位保持纯净，调节面收进一个 Modal
metadata:
  type: feedback
---

媒体展示位（角色画像、立绘、缩略图这类）上**不要盖任何控件**：按钮、徽章、悬停浮层一概不放。
要调的东西全部收进**一个** Modal，Modal 内自带实时预览。

**Why:** 2026-07-30 主人看到 StatusOverview 的画像位（常驻取景旋钮 + 相机徽章，旋钮弹出的
滑块浮层还盖住画像本身）后直接判定「horrible」——一边调取景一边看不见调的结果。

**How to apply:**
- 媒体组件写成纯呈现（只吃 props、不碰 store），调节状态与落库归调用它的对话框；
  预览用的就是同一个组件本体，不另画一份近似效果，否则迟早漂开。
- 整块媒体可点；点了去哪按「有没有东西可调」分叉——没东西可调时直接开文件选择框，
  不弹一个只有一个按钮可点的窗（多一次点击）。
- 两层 Modal 同开时，父层用 `:open="own && !childOpen"` 收起自己（见 AssetCharacterDrawer），
  否则一次 Esc 会把两层一起关掉。
