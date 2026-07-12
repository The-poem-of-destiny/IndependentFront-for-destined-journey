# 更新日志 — 2026-07-12

## 主线：游戏页 ScenePanel 视觉打磨 + 三段式重构

### 背景
主人指出游戏页左侧 `ScenePanel` 三个问题：与顶栏时间职责重复、底部太空、在场 NPC 太简陋。经一轮 Explore + Plan 双 agent 实证后定下**三段式架构**。

### 完成
- **TopBar 做减法**：去除时间职责（与左侧 ScenePanel 重复），改为「首页 / 存档名 / 全屏」极简窗口控制条。
- **ScenePanel 三段式重构**（宽度 190 → 240px，外层不滚交给内层）：
  - **上段**：时间 + 位置 + 天气合并区。时间视觉升级为 7 档时段图标（凌晨/早晨/中午/傍晚…）+ 氛围色 glow + 纪元标题字字重层级。
  - **中段**：在场 NPC 可滚动列表。每行升级为 hash 色首字母头像（28px）+ 名字 + tier 徽章（品质色描边），**点击单选展开心声气泡**，`scrollIntoView` 跟随。
  - **下段**：世界消息（新闻）。未读红点 + 相对时间（刚刚/N分钟前/今天 HH:MM/昨天/M-D）+ 点击展开全文。
- **game-store 补 4 项能力**：`latestVariables`（最新变量快照）/ `news`（带坏数据守护）/ `getThoughts()`（心里话三路径兼容 + customFields 回退）/ `hydratePreview`（预览注入 action）。
- **顺带修一个现存 bug**：`CharacterListPanel` 心里话卡片 `v-if="customFields?.thoughts"` 在真存档下恒 false，改用 `game.getThoughts()` 双路径读取让它真正可见。
- **新建两个纯函数工具件**（各带单测，共 33 测试）：
  - `utils/name-color.ts` — DJB2 hash → 品质色池，`nameColorVar` + `initialsOf`（与 AvatarPanel 强一致）。
  - `utils/time-format.ts` — 相对时间 `formatRel`，便于后续 MemoryPanel/QuestsPanel 复用。
- **test-fixtures 扩展**：`Ctrl+Shift+T` 预览注入可看到三段式全量数据（3 NPC + 2 新闻 + 末条 `variablesAfter` 演示心里话路径 A）。

### 数据真相（本轮关键认知）
"心里话"是项目核心设计的一环，存于两条路径 —— 运行时流变的 `chat.variablesAfter.stat_data['关系列表'][角色名].心里话`（路径 A，由 vars_update 写）和存档固化的 `CharacterState.customFields.thoughts`（路径 B）。本轮发现 **`src/` 里没有任何环节写入 `variablesAfter`**，故路径 A 在生产中恒 null；本轮接通 **路径 B 让中段真正可见**，路径 A 仅预埋三路径 fallback，等引擎层接 vars_update 后启用。验收不得将"看不到路径 A"当 bug。

### 验收
- `npm run typecheck`：本次涉及文件 0 新增错误（项目预存 TS error 与本任务无关）。
- `npm run test:run`：64 文件 / 2574 测试全绿（含本轮新增 33 工具件测试）。

### 提交
分支 `feat/scenepanel-three-section` 已 push 到 origin。