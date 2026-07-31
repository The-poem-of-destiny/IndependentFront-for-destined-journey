# 正文对话流设计 — 三源消息系统

**日期**: 2026-07-09
**状态**: 设计完成，待实现
**关联**: Phase 7e 游戏页 ChatFlow

---

## 1. 概述

将游戏对话流重构为**三源消息系统**，在聊天界面上分开展示 AI 正文、用户输入、系统事件三种消息。核心原则：**前端看卡片，AI 看文本**。

```
┌─────────────────────────────────────────┐
│  [assistant] 叙事正文...                  │ ← AI 回复（左对齐，衬线字体）
│                                          │
│                    [user] 我去铁匠铺看看  │ ← 用户输入（右对齐）
│                                          │
│  ┌─────────────────────────────────┐    │
│  │ 🛠️ 锻造完成 · 传说 · 霜月之刃  ▼│    │ ← 系统消息（居中，折叠通知条）
│  └─────────────────────────────────┘    │     展开后是品质色边框卡片
│                                          │
│  [assistant] 你的目光落在刀刃上...        │ ← 继续叙事
└─────────────────────────────────────────┘
```

---

## 2. 关键决策

| #   | 决策                         | 选择                                                       | 理由                                                                               |
| --- | ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | AI history 中系统消息的 role | `assistant`（非 `system`）                                 | OpenAI 协议中 `system` 是系统指令语义，mid-conversation 使用非标准，可能被模型误解 |
| 2   | AI 看到的内容                | 纯文本摘要（如 `[系统] 锻造完成：传说级武器「霜月之刃」`） | 不把 HTML/XML 塞进 API history                                                     |
| 3   | 前端渲染方式                 | C+A：折叠通知条 → 点击展开品质色卡片                       | 用户不想看时可快速跳过，想细看时展开                                               |
| 4   | `ChatMessage` 扩展           | 新增 `systemEvent` 可选字段                                | `content` 给 AI 用，`systemEvent` 给前端渲染用，语义清晰不需维护双数组             |
| 5   | 系统事件可见性               | 分类开关，高频事件默认关闭                                 | `character_update`/`item_update` 等高频但用户不关心的类型默认隐藏                  |

---

## 3. 数据模型

### 3.1 ChatMessage 扩展

```typescript
// types.ts
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string; // ← AI 看的纯文本（进 history）
  timestamp: number;

  // 🆕 系统事件数据（仅 role='system' 时有值）
  systemEvent?: SystemEvent;

  // 现有字段保留不变
  parsed?: ParsedTags;
  variables?: Record<string, string | number>;
  metadata?: {
    tokenCount?: number;
    lorebookEntries?: string[];
    processingTime?: number;
  };
  variablesAfter?: Record<string, any>;
  apiUsed?: ApiTarget;
}
```

### 3.2 SystemEvent 联合类型

```typescript
export type SystemEvent =
  | CraftSystemEvent // 制作完成
  | CharGenSystemEvent // 新角色加入
  | ItemGenSystemEvent // 新物品获得
  | CombatSystemEvent // 战斗结果
  | CharacterUpdateEvent // 角色状态微调
  | ItemUpdateEvent // 物品变动
  | QuestUpdateEvent; // 任务进度

export interface CraftSystemEvent {
  type: 'craft';
  productName: string;
  quality: QualityLevel;
  rating: CraftRating;
  narrative: string; // 给 AI 看的摘要
  details: CraftGenOutput; // 完整数据，给卡片渲染
}

export interface CharGenSystemEvent {
  type: 'char_gen';
  characterName: string;
  race: string;
  tier: number;
  narrative: string;
  details: CharGenOutput;
}

export interface ItemGenSystemEvent {
  type: 'item_gen';
  itemName: string;
  quality: QualityLevel;
  itemType: string;
  narrative: string;
  details: ItemGenOutput;
}

export interface CombatSystemEvent {
  type: 'combat';
  outcome: 'ally_win' | 'enemy_win' | 'draw' | 'fled';
  narrative: string;
  details: CombatSummaryResult;
}

export interface CharacterUpdateEvent {
  type: 'character_update';
  characterName: string;
  narrative: string; // "角色属性提升" 等简短摘要
}

export interface ItemUpdateEvent {
  type: 'item_update';
  itemName: string;
  operation: string; // consume | transfer | modify | equip | unequip
  narrative: string;
}

export interface QuestUpdateEvent {
  type: 'quest_update';
  questName: string;
  status: string;
  narrative: string;
}
```

### 3.3 两条数据通路

| 字段          | 消费者               | 内容                               |
| ------------- | -------------------- | ---------------------------------- |
| `content`     | AI（API history）    | 纯文本摘要，role 转成 `assistant`  |
| `systemEvent` | 前端（Vue 卡片组件） | 完整结构化数据，驱动品质色卡片渲染 |

**发给 API 时的转换**（`buildAgentMessages` 中）：

```
role='system' 的 ChatMessage → { role: 'assistant', content: msg.content }
```

---

## 4. Orchestrator → ChatMessage 桥接

```
AgentOrchestrator
  ├── onCraftGenRequest → CraftGenOutput → toSystemMessage('craft', ...)
  ├── onCombatTrigger   → CombatSummaryResult → toSystemMessage('combat', ...)
  ├── onCharGenRequest  → CharGenOutput → toSystemMessage('char_gen', ...)
  ├── onItemGenRequest  → ItemGenOutput → toSystemMessage('item_gen', ...)
  └── ...其他事件
        │
        ▼
     toSystemMessage(event): ChatMessage
        │
        ▼
     推入 ChatSession.messages[]
```

**工厂函数**：

```typescript
function toSystemMessage(event: SystemEvent): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system', // 前端用 'system' 区分三种来源
    content: event.narrative, // API 看到的是纯文本
    timestamp: Date.now(),
    systemEvent: event, // 前端读这个渲染卡片
  };
}
```

---

## 5. 系统事件可见性控制

### 5.1 全局开关

设置项 `showSystemEvents: boolean`，关闭后所有系统消息不渲染。

### 5.2 分类开关

| 事件类型                      | 默认值 | 理由               |
| ----------------------------- | ------ | ------------------ |
| `craft` (制作完成)            | ✅ ON  | 重要成果，用户关心 |
| `char_gen` (新角色加入)       | ✅ ON  | 剧情关键节点       |
| `combat` (战斗结果)           | ✅ ON  | 战斗产出           |
| `item_gen` (新物品获得)       | ✅ ON  | 战利品/任务奖励    |
| `character_update` (角色微调) | ❌ OFF | 高频，变化微小     |
| `item_update` (物品变动)      | ❌ OFF | 消耗/转移太频繁    |
| `quest_update` (任务进度)     | ❌ OFF | 仅关键节点展示     |

存储位置：`gameStore.systemEventFilters: Record<string, boolean>`

---

## 6. 前端渲染方案

### 6.1 三条消息流

| 来源 | role        | 对齐 | 样式                          |
| ---- | ----------- | ---- | ----------------------------- |
| AI   | `assistant` | 左   | 深色气泡 + 衬线字体（叙事感） |
| 用户 | `user`      | 右   | 浅色/主色气泡                 |
| 系统 | `system`    | 居中 | 折叠通知条 → 展开品质色卡片   |

### 6.2 系统卡片组件

| 类型               | 卡片组件              | 渲染级别                                                            |
| ------------------ | --------------------- | ------------------------------------------------------------------- |
| `craft`            | **CraftSystemCard**   | 完整卡片：品质色顶栏 + 检定摘要 + 词条列表 + 材料/EXP/FP 结算       |
| `char_gen`         | **CharGenSystemCard** | 完整卡片：名字 + 身份标签 + 五维 + 背景摘要 + [查看完整角色卡] 链接 |
| `combat`           | **CombatSystemCard**  | 完整卡片：胜负图标 + 回合数 + 战利品 + 伤害统计 + EXP/FP            |
| `item_gen`         | **ItemSystemCard**    | 中等卡片：物品名 + 品质色 + 类型图标 + 效果描述                     |
| `character_update` | **SimpleNotifBar**    | 轻量通知条                                                          |
| `item_update`      | **SimpleNotifBar**    | 轻量通知条                                                          |
| `quest_update`     | **QuestProgressBar**  | 任务进度条                                                          |

### 6.3 品质色系统（参考原版 v4.2.1 角色卡）

| 品质 | 色值      | CSS class           |
| ---- | --------- | ------------------- |
| 普通 | `#c4cad3` | `quality-common`    |
| 优良 | `#7be495` | `quality-uncommon`  |
| 稀有 | `#62bbff` | `quality-rare`      |
| 史诗 | `#cf95ff` | `quality-epic`      |
| 传说 | `#ffc46b` | `quality-legendary` |
| 神话 | `#ff78c5` | `quality-mythic`    |
| 唯一 | `#00ffff` | `quality-unique`    |

### 6.4 原版参考

- **角色查看器 v3.0.5** (Script #11): Vue 3 SPA + Pinia，8 Tab（档案/技能/装备/背包/登神长阶/背景故事/状态效果），64KB minified。我们的 Card 取其摘要版，点击链接跳转完整查看器。
- **战斗&制作美化** (Script #10): 动态面板系统，`{标题}` 分段 + `|行|` 数据行，可折叠。我们改为 Vue 组件替代 regex HTML 注入。
- **命运抽卡** (Script #8): 抽卡风格按钮列表 + 弹窗详情。品质色按钮 + 粒子动画。

---

## 7. 待实现清单

- [ ] `types.ts` — 新增 `SystemEvent` 联合类型及 7 个子类型
- [ ] `types.ts` — `ChatMessage` 新增 `systemEvent?: SystemEvent` 字段
- [ ] `toSystemMessage()` 工厂函数模块
- [ ] `buildAgentMessages()` — system → assistant role 转换逻辑
- [ ] 7 个系统卡片 Vue 组件 + 轻量通知条组件
- [ ] `ChatFlow.vue` — 三条消息流的渲染逻辑 + 折叠/展开交互
- [ ] `game-store.ts` — `systemEventFilters` 状态 + `addMessage()` 方法
- [ ] 设置页 — 系统事件分类开关 UI
- [ ] orchestrator 回调 → `toSystemMessage()` → `messages[]` 全链路接通
- [ ] 测试覆盖

---

## 8. 变更记录

| 日期       | 变更                                                                  |
| ---------- | --------------------------------------------------------------------- |
| 2026-07-09 | 初始设计：三源消息系统 + SystemEvent 类型 + 可见性控制 + 前端卡片方案 |
