# 2026-07-13 更新日志

## 全流程打通 Phase 1: 基础设施 + 创角页改造

今天完成了「验证游戏全流程可行性」工作的一半，聚焦在数据库基础设施升级和捏人页面改造。

### 数据库 v8

新增 `messages` 表用于独立于 ChatSession 保存对话历史，支持 `saveId` 索引隔离不同存档、`[saveId+turn]` 复合索引按轮次排序。扩展了 `ChatMessage` 类型（新增 `saveId`/`turn` 字段）、`SaveSlot.metadata`（新增 `enabledWorldBookEntries`/`openingPrompt`/`openingPromptConsumed` 字段），并在 `Snapshot` 预留了 `messageIds` 字段供后续快照系统使用。消息持久化采用只存原始 AI 输出、加载时按需 beautify 的策略 —— 正则管道处理百条消息在微秒级，无需缓存 HTML。

### 创角页改造

**命运核心**不再使用硬编码列表，改为从 `system_core` 世界书条目动态加载，以紧凑单选列表展示，点击展开可查看内容摘要，选中后详情卡片显示在列表上方，支持取消重选。

**角色启用**为新增步骤（第 3 步），从 `character` 世界书条目加载所有角色卡，以多选网格展示，支持勾选/取消，底部显示已选计数。选中的世界书条目以 `partition:uid` 格式写入存档 metadata，游戏加载时按此列表过滤 Agent 可见的世界书上下文。

**基础信息**新增四个自由文本字段：性格、身材、身世、补充，使用可拉伸的 textarea 输入，内容注入 CharacterState.customFields 和开场提示词。

**装备选择**移除了下方开局/背景区域。

**背景故事**新增独立的自定义背景 textarea，始终可见，与预设背景择一使用。

**角色预设** Modal UI 革新，改为可展开的卡片式列表 —— 点击卡片头查看全字段详情（姓名/种族/身份/性格/身材/装备/技能等），逐项保存/加载/导出/导入。

### 统计数据

- 新增 1 个文件，修改 10 个文件
- 64 个测试文件 / 2582 个测试用例全部通过
- Build 零错误

### 下一步

Plan 3（GamePipeline 桥接层 + GamePage 接入引擎）和 Plan 4（端到端集成验证）。
