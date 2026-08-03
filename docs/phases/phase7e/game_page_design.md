# Phase 7e: 游戏页面设计规划 & 引擎支撑审计

> 基于 `docs/reference/status_page_architecture.md` 原版架构分析
>
> - UI/UX Pro Max 设计系统推荐
> - 引擎核心类型 & $API 全面审计
>
> 日期：2026-06-17

---

## 一、UI/UX 设计系统（AI 推荐 + 项目适配）

### 1.1 自动推荐结果

| 维度         | 推荐                                                 | 适配本项目                                                |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| **风格**     | Dark Mode (OLED) — 暗色主题、低光发射、高对比度      | ✅ 10 主题中有 obsidian/crimson/indigo 等暗色主题可直接用 |
| **字体**     | Heading: Orbitron (科幻HUD风) / Body: JetBrains Mono | ⚠️ 项目已有 Cinzel(衬线标题) + 系统字体，保持一致性优先   |
| **主色**     | Primary: `#15803D` (绿) / Accent: `#D97706` (金)     | ⚠️ 主题系统已有完整 Token，按主题颜色体系走               |
| **效果**     | 最小发光(text-shadow glow)、暗→亮过渡、可读性优先    | ✅ 可用 CSS `text-shadow` + `box-shadow` 实现             |
| **模式**     | Dark Only (纯暗色)                                   | ⚠️ 项目有浅色主题(ivory/misty-lilac)，需支持双模式        |
| **交互模式** | 沉浸式体验、引导式产品巡览、交互后 CTA               | ✅ 游戏 HUD 天然沉浸式                                    |

### 1.2 项目适配结论

**不盲从推荐，结合项目现有资源做设计决策：**

| 设计决策 | 选择                                    | 理由                                                                                                       |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 色彩体系 | 沿用项目 **10 主题 CSS 变量**           | 已有完整 Token 体系(50+ 变量)，与设置页主题系统打通。**暗色/浅色职责由主题系统承担**，不做独立的双模式开关 |
| 字体     | 保持 **Cinzel(标题) + system-ui(正文)** | 避免引入新字体增加加载成本，现有字体已有 fantasy 调性                                                      |
| 发光效果 | **品质色 glow**                         | 神话/传说品质装备使用对应颜色的 `text-shadow` glow                                                         |
| 动画     | CSS transition + `<Transition>`         | 轻量，不需 GSAP（Vue 内置）                                                                                |
| 布局     | 三栏对话流                              | 左侧工具入口 + 中间对话流 + 右侧角色状态                                                                   |

---

## 二、游戏页面整体架构（修订版）

> 修订依据：对话区与正文区意义重合，改为统一的对话流；左侧放游戏内工具入口；顶部极简化。

### 2.1 布局方案：三栏对话流

```
┌──────────────────────────────────────────────────────────────┐
│  TopBar (极简，高度 ~36px)                                     │
│  [← 首页]                                    [⛶ 全屏]        │
├────────┬──────────────────────────────────┬───────────────────┤
│        │                                  │  ⏰ 复兴纪元        │
│ 左侧   │     对话流 (主内容区)              │  📍 酒馆·翡翠之心   │
│ 工具栏 │     消息气泡流                     │  ───────────────── │
│        │                                  │  ┌─────────────┐  │
│ 可折叠 │  你:                              │  │ 👤  A (头像) │  │
│        │  "老板，来一杯麦酒！"               │  │   亚瑟       │  │
│ 📦 背包│                                  │  │   人类·战士   │  │
│ 👥 角色│  正文:                             │  │   T4·Lv.12  │  │
│ 📋 任务│  "你推开沉重的橡木门，酒馆里弥漫     │  │   A级冒险者  │  │
│ 📖 剧情│   着麦酒和烤肉的香气..."             │  └─────────────┘  │
│ 🗺 地图│                                  │  ┌─────────────┐  │
│ 🧠 记忆│  ⚡ 触发: 制作 — 锻造一把长剑       │  │ ResourceBar  │  │
│ 📸 快照│  "铁砧的火花在你眼前迸发..."         │  │ HP MP SP EXP │  │
│        │                                  │  └─────────────┘  │
│ ⚙ 设置 │                                  │  ┌─────────────┐  │
│        │                                  │  │ 五维属性     │  │
│        │                                  │  │ S10 D12 C14  │  │
│        │                                  │  │ I8  S6      │  │
│        │                                  │  └─────────────┘  │
│        │                                  │  ┌─────────────┐  │
│        │                                  │  │ BuffChip     │  │
│        │                                  │  │ 💊力量↑ 💊护盾│  │
│        │                                  │  └─────────────┘  │
│        │                                  │  ┌─────────────┐  │
│        │                                  │  │ 装备摘要      │  │
│        │                                  │  │ 🗡️ 🛡️ 💍  │  │
│        │                                  │  └─────────────┘  │
│        │                                  │  ┌─────────────┐  │
│        │                                  │  │ 焦点任务      │  │
│        │                                  │  │ 追查失踪商队   │  │
│        ├──────────────────────────────────┤  └─────────────┘  │
│        │  输入栏                            │                   │
│        │  [📋 选项] [输入你的行动...] [📨]   │                   │
└────────┴──────────────────────────────────┴───────────────────┘
```

### 2.2 设计理念

**核心理念**：正文叙事和玩家输入是同一股"对话流"——AI 叙述故事，玩家通过输入行动来推进剧情。不需要把"历史消息"和"当前正文"拆成两个区域，它们天然就是同一个时间线上的消息序列。

**对话流三种气泡**：

| 气泡类型     | 前缀       | 样式                    | 内容                                     |
| ------------ | ---------- | ----------------------- | ---------------------------------------- |
| **玩家消息** | `你:`      | 右侧对齐，偏暗背景      | 用户输入的角色行动                       |
| **正文回复** | `正文:`    | 左侧对齐，standard 背景 | AI 生成的故事叙事                        |
| **触发消息** | `⚡ 触发:` | 居中卡片，品质色边框    | 制作/战斗/状态变化等特殊事件触发时的提示 |

**右侧状态栏布局（从上到下）**：

| 位置    | 内容                                                          | 说明                                   |
| ------- | ------------------------------------------------------------- | -------------------------------------- |
| 最顶部  | ⏰ 游戏时间 + 📍 当前位置                                     | 从顶栏移入                             |
| 第 1 区 | **角色概览** — 头像(最大)·名字·种族·职业·层级·等级·冒险者等级 | 头像无图片时用随机底色+首字母 fallback |
| 第 2 区 | ResourceBar — HP/MP/SP/EXP                                    | 已有组件                               |
| 第 3 区 | 五维属性 — 紧凑 grid                                          | 力量/敏捷/体质/智力/精神               |
| 第 4 区 | BuffChip 药丸列表                                             | 已有组件                               |
| 第 5 区 | 装备摘要 — 5 槽位预览                                         | 武器/防具/饰品 × 品质色                |
| 第 6 区 | 焦点任务追踪                                                  | 当前追踪的任务目标+进展                |

**头像 Fallback 规则**：

- 有头像 URL → 显示图片
- 无头像 → 随机底色（基于名字 hash）+ 名字首字母（大写）
- 随机颜色池：品质色 + 主题色共 ~10 种，确保暗/亮主题下均可见

### 2.3 组件树

```
GamePage.vue
├── TopBar.vue                          # 极简顶栏
│   ├── HomeButton ("← 首页")           # 回到首页
│   └── FullscreenButton ("⛶")         # 全屏切换
│
├── GameLayout.vue                      # 三栏布局容器 (CSS Grid)
│   │
│   ├── SideToolbar.vue                 # 左: 工具栏 (可折叠)
│   │   ├── ToolButton × 8              # 图标+文字 → 折叠后仅图标
│   │   │   ├── 背包 (inventory)
│   │   │   ├── 角色列表 (characters)
│   │   │   ├── 任务 (quests)
│   │   │   ├── 剧情规划 (plot)
│   │   │   ├── 地图 (map)
│   │   │   ├── 记忆 (memory)
│   │   │   ├── 快照 (snapshots)
│   │   │   └── 设置 (settings)
│   │   └── CollapseToggle              # 折叠/展开按钮
│   │
│   ├── ChatFlow.vue                    # 中: 对话流 (主内容)
│   │   ├── PlayerBubble × N            # "你:" 玩家消息 (右侧对齐)
│   │   ├── NarrativeBubble × N         # "正文:" AI 叙事 (左侧对齐)
│   │   ├── TriggerBubble × N           # "⚡ 触发:" 特殊事件卡片
│   │   ├── LoadingIndicator            # "AI 正在生成..." 动画
│   │   ├── CraftPanel (条件覆盖)       # 制作流程面板
│   │   └── CombatPanel (条件覆盖)      # 战斗流程面板
│   │
│   └── StatusHUD.vue                   # 右: 状态栏 (可切换内容)
│       ├── TimeLocationBar             # ⏰ 游戏时间 + 📍 当前位置
│       ├── [默认视图] StatusOverview
│       │   ├── AvatarPanel.vue         # ✅ 已有 (fallback: 随机色+首字母)
│       │   ├── PlayerName              # 角色名
│       │   ├── IdentityLine            # 种族·职业·层级·Lv.X·冒险者等级
│       │   ├── ResourceBar.vue         # ✅ 已有
│       │   ├── AttributeGrid           # 五维属性 (紧凑 grid)
│       │   ├── BuffChipGroup           # Buff/Debuff 药丸 (已有组件)
│       │   ├── EquipmentPreview        # 5槽位装备预览
│       │   └── QuestTracker            # 焦点任务追踪
│       │
│       └── [切换视图 — 点击工具栏触发]
│           ├── ItemsPanel              # 背包/装备/技能 (三分类)
│           ├── CharacterListPanel      # NPC 列表 + 好感度
│           ├── QuestsPanel             # 任务列表
│           ├── PlotPanel               # 剧情大纲/事件树
│           ├── MapPanel                # 地图查看 (可降级)
│           ├── MemoryPanel             # 记忆列表
│           ├── SnapshotsModal          # 快照管理 (弹出 Modal)
│           └── SettingsModal           # 设置 (弹出 Modal)
│
└── InputBar.vue                        # 底: 固定输入栏
    ├── OptionPicker                    # 📋 选项按钮 → 点击展开 3-4 个 AI 生成的选项
    ├── MessageInput                    # 文本输入框 (选项选中后自动填入)
    └── SendButton                      # 发送按钮
```

### 2.4 输入栏 & 选项系统

#### 选项机制

```
点击 [📋 选项]
  │
  ▼
┌─────────────────────────────┐
│ 📋 可选行动                   │
│ ┌─────────────────────────┐ │
│ │ 🗡️ 拔出武器，质问盗贼     │ │  ← AI 生成 (未来)
│ │ 💬 试着和盗贼谈判         │ │
│ │ 🏃 趁乱溜走              │ │
│ │ ✍️ 自定义...             │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
  │ 点击某个选项
  ▼
输入栏自动填入所选文本 → 用户可编辑 → 点击发送
```

选项由 AI 在每回合结束后生成（基于当前剧情上下文），Phase 7e 初期可先用静态占位选项，后续接入 `vars_update` Agent 输出。

### 2.5 对话流三种气泡详细设计

| 气泡         | 前缀       | 对齐 | 背景                      | 字体                 | 附加信息                          |
| ------------ | ---------- | ---- | ------------------------- | -------------------- | --------------------------------- |
| **玩家消息** | `你:`      | 右侧 | `--theme-card-bg` 加深    | system-ui            | 时间戳                            |
| **正文回复** | `正文:`    | 左侧 | `--theme-content-bg`      | Cinzel(中文fallback) | 时间戳 + (可选)位置标签           |
| **触发消息** | `⚡ 触发:` | 居中 | 品质色左边框 + 半透明背景 | system-ui            | 触发类型标签(制作/战斗/状态/剧情) |

### 2.4 交互流程

#### 2.4.1 左侧工具栏交互

```
默认状态: StatusHUD 显示角色状态概览

点击 [📦 背包]
  → StatusHUD 切换为 ItemsPanel (三分类: 背包/装备/技能)
  → 再次点击 [📦 背包] 或按 ×
  → StatusHUD 恢复为默认角色概览

点击 [👥 角色列表]
  → StatusHUD 切换为 CharacterListPanel (NPC 列表)

点击 [📋 任务]
  → StatusHUD 切换为 QuestsPanel

点击 [📖 剧情规划]
  → StatusHUD 切换为 PlotPanel (大纲/事件树)

点击 [🗺 地图]
  → 全屏 MapModal (地图太大不适合右侧小面板)

点击 [🧠 记忆]
  → StatusHUD 切换为 MemoryPanel

点击 [📸 快照]
  → 弹出 SnapshotsModal

点击 [⚙ 设置]
  → 弹出 SettingsModal
```

#### 2.4.2 右侧面板状态

```
rightPanelMode:
  'status'      → StatusOverview (默认)
  'items'       → ItemsPanel
  'characters'  → CharacterListPanel
  'quests'      → QuestsPanel
  'plot'        → PlotPanel
  'memory'      → MemoryPanel
```

#### 2.4.3 页面显示状态

```
GamePage 显示模式 (互斥):

1. 正常对话模式: SideToolbar | ChatFlow | StatusHUD | InputBar
2. 制作中:  CraftPanel 覆盖 ChatFlow (正文 AI 暂停，制作 Agent 工作)
3. 战斗中:  CombatPanel 覆盖 ChatFlow (独立战斗窗口)
4. 全屏状态栏: StatusHUD 全屏展开 (忽略三栏)
```

### 2.5 响应式行为

```
桌面 (>1024px):         平板 (768-1024px):       手机 (<768px):
┌──┬────────┬──┐       ┌──┬──────────┐          ┌──────────┐
│左│ 对话流  │右│       │左│ 对话流    │          │ 对话流    │
│侧│        │侧│       │侧│ + 底部Tab │          │ (全屏)    │
│工│        │状│       │工│ 切换右侧  │          │          │
│具│        │态│       │具│ 面板内容  │          │ 底部Tab  │
│栏│        │栏│       │栏│          │          │ 切面板    │
├──┴────────┴──┤       ├──┴──────────┤          ├──────────┤
│   输入栏      │       │   输入栏     │          │  输入栏   │
└──────────────┘       └─────────────┘          └──────────┘

右侧栏在窄屏时:
- 变成底部 Tab 或可滑出的 Drawer
- 左侧工具栏缩为极窄图标条 (仅图标，无文字)
- 地图/快照/设置始终弹出 Modal
```

---

## 三、引擎支撑审计

### 3.1 CharacterState 字段 × 状态栏需求映射

| 状态栏功能               | CharacterState 字段                      | 类型   | 引擎读写                | 状态 |
| ------------------------ | ---------------------------------------- | ------ | ----------------------- | ---- |
| 角色名                   | `name: string`                           | 基础   | $char API               | ✅   |
| 种族                     | `race: string`                           | 基础   | $char API               | ✅   |
| 身份标签                 | `identity: string[]`                     | 数组   | $char API               | ✅   |
| 职业标签                 | `occupation: string[]`                   | 数组   | $char API               | ✅   |
| 生命层级                 | `tier: number (1-7)` + `tierName`        | 数值   | tier-constants          | ✅   |
| 等级                     | `level: number`                          | 数值   | $char API               | ✅   |
| 经验值                   | `totalExp: number` + `expToNext: number` | 数值   | resource-calc           | ✅   |
| HP                       | `hp: number` / `maxHp: number`           | 数值   | $resource API           | ✅   |
| MP                       | `mp: number` / `maxMp: number`           | 数值   | $resource API           | ✅   |
| SP                       | `sp: number` / `maxSp: number`           | 数值   | $resource API           | ✅   |
| 力量/敏捷/体质/智力/精神 | `attributes: {str,dex,con,int,spi}`      | 数值   | $char API               | ✅   |
| 自由属性点               | `freeAttrPoints: number`                 | 数值   | $char API               | ✅   |
| 装备槽                   | `equipment: EquipmentSlot[]`             | 数组   | $char API               | ✅   |
| 技能列表                 | `skills: Skill[]`                        | 数组   | $char API               | ✅   |
| 背包物品                 | `inventory: InventoryItem[]`             | 数组   | $char API               | ✅   |
| 状态效果                 | `statusEffects: StatusEffect[]`          | 数组   | $status API             | ✅   |
| 金钱                     | `money: number`                          | 数值   | $char API               | ✅   |
| 冒险者等级               | `adventurerRank: string`                 | 字符串 | $char API               | ✅   |
| 当前位置                 | `location: string`                       | 字符串 | location-db + $location | ✅   |
| 登神长阶                 | `ascension: {...}`                       | 对象   | $char API               | ✅   |
| 血脉                     | `bloodlineIds?: string[]`                | 数组   | bloodlines              | ✅   |
| 自定义字段               | `customFields: Record<string,any>`       | 字典   | $var API                | ✅   |

### 3.2 SaveProfile 字段（存档级数据）

| 状态栏功能    | SaveProfile 字段                 | 引擎读写 | 状态 |
| ------------- | -------------------------------- | -------- | ---- |
| 命运点数 (FP) | `fp: number`                     | $fp API  | ✅   |
| FP 交易记录   | `fpHistory: FPTransaction[]`     | $fp API  | ✅   |
| 命运契约      | `contracts: FateContract[]`      | $fp API  | ✅   |
| 成就列表      | `achievements: Achievement[]`    | $fp API  | ✅   |
| 新闻          | `news: NewsItem[]`               | 直接读写 | ✅   |
| 世界标记      | `worldFlags: Record<string,any>` | $var API | ✅   |

### 3.3 战斗/制作状态

| 功能         | 类型                        | 引擎            | 状态 |
| ------------ | --------------------------- | --------------- | ---- |
| 当前战斗状态 | `CombatState`               | $combat API     | ✅   |
| 战斗参与者   | `CombatParticipant[]`       | combat-resolver | ✅   |
| 8步伤害管线  | `CombatDamageBreakdown`     | combat-damage   | ✅   |
| 战斗面板 XML | `<action_info>` 生成        | combat-panel    | ✅   |
| 制作三阶段   | `CraftActionRequest/Result` | $craft API      | ✅   |
| 制作面板     | `<action_info>` 生成        | craft-resolver  | ✅   |

### 3.4 记忆/剧情系统

| 功能         | 类型             | 引擎         | 状态 |
| ------------ | ---------------- | ------------ | ---- |
| 最近记忆     | `MemoryRecord[]` | memory-store | ✅   |
| 活跃剧情事件 | `PlotEvent[]`    | plot-engine  | ✅   |
| 剧情大纲     | `PlotOutline`    | plot-outline | ✅   |
| 世界线状态   | `PlotSettings`   | plot-engine  | ✅   |

### 3.5 地图/位置

| 功能              | 引擎                                                  | 状态 |
| ----------------- | ----------------------------------------------------- | ---- |
| 32 节点位置数据库 | location-db                                           | ✅   |
| 10 势力拓扑       | location-db (`$location` API)                         | ✅   |
| 完整层级路径      | `getLocationPath()`                                   | ✅   |
| 相邻节点查询      | `areAdjacent()` / `getNeighbors()`                    | ✅   |
| 地图标记 (Marker) | ❌ 无引擎类型 → 需新增 `MapMarker` + 存 `SaveProfile` | ⚠️   |
| 地图图片/瓦片     | ❌ 前端自行管理 (OpenSeadragon + SW Cache)            | ⚠️   |

---

## 四、引擎缺口分析

### 4.1 🔴 P0 缺口：任务系统 (Quests)

**现状**：引擎没有 `Quest`/`Task` 类型。

**原版依赖**：原 status 页面读取 `stat_data.任务列表`（Record<string, {状态, 关注度, 进展, 详情, 目标, 奖励}>）

**影响**：QuestsTab 完全无法工作。

**建议**：

```typescript
// 方案 A: 加入 SaveProfile（推荐 — 任务是存档级数据）
export interface Quest {
  name: string;
  status: string; // 进行中/已完成/失败/搁置
  priority: '高' | '中' | '低';
  progress: string; // 当前进展描述
  detail: string; // 任务详情
  objective: string; // 任务目标
  reward: string; // 奖励描述
}
// SaveProfile 新增字段
quests: Record<string, Quest>;
```

### 4.2 ✅ 伙伴系统 (Partners/Relations) — 已有完整支撑

**现状**：引擎已有完整的 NPC + 好感度体系，无需新增类型。

```
伙伴 = CharacterState (type='npc') + AffectionMap[characterId]
```

| 能力                | 接口                                            | 位置                  |
| ------------------- | ----------------------------------------------- | --------------------- |
| 获取所有 NPC        | `getNpcs()`                                     | `char-query.ts`       |
| 按位置过滤/在场查询 | `filterByLocation()` / `getPresentCharacters()` | `char-query.ts`       |
| 角色状态摘要        | `summarizeChar()`                               | `char-query.ts`       |
| 好感度 CRUD         | `$affection.get/set/add/batch`                  | `affection-system.ts` |
| 好感度 11 级标签    | `getAffectionLabel()`                           | `affection-system.ts` |
| NPC 自动生成        | `runCharGenChain()`                             | `char-gen-agent.ts`   |
| 完整角色数据        | `CharacterState` (20+字段)                      | `types.ts`            |

**CharacterListPanel 实现**：调用 `getNpcs()` → 交叉 `AffectionMap` → 渲染卡片列表即可。

### 4.3 🟡 P1 缺口：MapMarker 类型 + 持久化

**现状**：地图标记系统需要 `MapMarker` 类型（id/name/group/description/imageUrls/icon/color/position），引擎目前没有。

**决策**：保留标记系统，仅砍掉 DrawCanvas 自由绘制。标记数据存 `SaveProfile.worldFlags.mapMarkers`。

**所需新增**：

```typescript
// types.ts
export interface MapMarker {
  id: string;
  name: string;
  group?: string;
  description?: string;
  imageUrls?: string[];
  icon?: string; // Font Awesome icon class
  color?: string; // hex color
  position: { nx: number; ny: number }; // OSD 归一化坐标 (0-1)
}
```

**Phase 7e MapTab 组件**（对标原版，仅砍 DrawCanvas）：

```
MapTab / MapModal
├── MapToolbar
│   ├── 地图源切换: [小地图] [大地图]
│   └── 标记工作台开关
├── MapViewerStage
│   ├── OpenSeadragon Viewer
│   └── MarkerOverlay (标记叠加层)
├── MarkerWorkbench
│   ├── 搜索输入框
│   ├── 标记列表 (markerList)
│   └── MarkerEditor (名称/分组/描述/图片/图标/颜色)
├── MapMarkerCard (地图上的标记卡片弹窗)
└── MarkerPanel (全屏标记面板)
```

### 4.4 🟡 P1 缺口：新闻系统

**现状**：`SaveProfile.news: NewsItem[]` **已存在**但字段偏简单。

```typescript
// 现有类型 (已足够)
export interface NewsItem {
  id: string;
  title: string;
  content: string;
  category: string;
  publishedAt: number;
}
```

✅ 够用，无需新增类型。

### 4.5 🟢 已有且充足的部分

| 系统                      | 引擎支持                    | 评价                                                                    |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| 角色数据 (CharacterState) | ✅ 完整                     | 20+ 字段，覆盖全部状态栏需求                                            |
| $ API 体系                | ✅ 9 个 namespace           | combat/craft/dice/char/var/time/resource/validate/fp/affection/location |
| 品质系统                  | ✅ 7 级                     | QualityBadge 组件已有                                                   |
| 主题系统                  | ✅ 10 主题                  | CSS 变量体系完整                                                        |
| 资源条                    | ✅ ResourceBar 组件已有     | HP/MP/SP/EXP 四色                                                       |
| 存档系统                  | ✅ SaveSlot + SaveProfile   | FP/成就/新闻/世界标记                                                   |
| 位置系统                  | ✅ 32 节点 + 拓扑           | location-db                                                             |
| 登神长阶                  | ✅ CharacterState.ascension | 要素/权能/法则/神位/神国                                                |
| 状态效果                  | ✅ StatusEffect[]           | buff/debuff/special 分类                                                |

---

## 五、实现优先级（修订版）

### Phase 7e-1: 游戏页骨架 + 对话流 + 状态栏（最小可用）

```
目标: GamePage 可加载存档、显示角色状态、展示对话流
组件: TopBar + GameLayout(SideToolbar + ChatFlow + StatusHUD(ResourceBar + Avatar + 属性摘要)) + InputBar
引擎: ✅ 全部已有支撑
```

### Phase 7e-2: 左侧工具栏联动 + 右侧面板切换

```
目标: 点击工具栏 → 右侧面板切换对应内容
组件: ItemsPanel + QuestsPanel + CharacterListPanel + MemoryPanel + PlotPanel
新增类型: Quest (加入 SaveProfile)
引擎: ⚠️ 需新增 Quest 类型
```

### Phase 7e-3: 战斗 & 制作覆盖面板

```
目标: 战斗中覆盖 ChatFlow 显示 CombatPanel，制作中显示 CraftPanel
组件: CombatPanel + CraftPanel
引擎: ✅ $combat + $craft 完整支撑
```

### Phase 7e-4: 弹出层 + 地图（可降级）

```
目标: MapModal + SnapshotsModal + SettingsModal
组件: 全屏地图 Modal、快照管理 Modal、设置 Modal
引擎: ⚠️ 需地图标记方案 (可降级为静态展示)
```

---

## 六、组件对标表（修订版）

### 6.1 布局/结构组件

| 组件                                    | 说明                                                     | 引擎支撑          | 优先级 |
| --------------------------------------- | -------------------------------------------------------- | ----------------- | ------ |
| `TopBar.vue` (←首页 + 全屏)             | 极简顶栏，无其他内容                                     | ✅                | P0     |
| `SideToolbar.vue` (8 工具入口 + 可折叠) | 折叠后仅图标，展开图标+文字                              | ✅                | P0     |
| `ChatFlow.vue` (对话流)                 | 三种气泡: 玩家(`你:`)/正文(`正文:`)/触发(`⚡ 触发:`)     | ✅                | P0     |
| `StatusHUD.vue` (右侧状态栏容器)        | 时间+地点→头像(含fallback)→身份→资源→属性→Buff→装备→任务 | ✅ CharacterState | P0     |
| `InputBar.vue`                          | [📋 选项] + 输入框 + [发送]，选项点击自动填入            | ✅                | P0     |

### 6.2 右侧面板组件（替换 StatusHUD 内容）

| 面板                                         | 触发         | 引擎支撑                             | 优先级 |
| -------------------------------------------- | ------------ | ------------------------------------ | ------ |
| `StatusOverview.vue`                         | 默认显示     | ✅ CharacterState                    | P0     |
| `ItemsPanel.vue` (背包/装备/技能 三分类)     | 点击 📦 背包 | ✅ EquipmentSlot/Skill/InventoryItem | P1     |
| `CharacterListPanel.vue` (NPC 列表 + 好感度) | 点击 👥 角色 | ✅ getNpcs() + $affection            | P1     |
| `QuestsPanel.vue` (任务列表 + 焦点选择)      | 点击 📋 任务 | ⚠️ 需新增 Quest 类型                 | P1     |
| `PlotPanel.vue` (剧情大纲/事件树)            | 点击 📖 剧情 | ✅ PlotOutline/PlotEvent             | P1     |
| `MemoryPanel.vue` (记忆列表)                 | 点击 🧠 记忆 | ✅ MemoryRecord[]                    | P1     |

### 6.3 弹出层组件

| 组件                                       | 触发         | 引擎支撑                        | 优先级 |
| ------------------------------------------ | ------------ | ------------------------------- | ------ |
| `MapModal.vue` (全屏地图，仅砍 DrawCanvas) | 点击 🗺 地图  | ⚠️ 需 MapMarker 类型 + OSD 集成 | P2     |
| `SnapshotsModal.vue` (快照管理)            | 点击 📸 快照 | ✅ Snapshot[]                   | P2     |
| `SettingsModal.vue` (游戏内设置)           | 点击 ⚙ 设置  | ✅ 复用 SettingsPage            | P2     |

### 6.4 覆盖层组件

| 组件                              | 触发     | 引擎支撑   | 优先级 |
| --------------------------------- | -------- | ---------- | ------ |
| `CombatPanel.vue` (覆盖 ChatFlow) | 战斗触发 | ✅ $combat | P1     |
| `CraftPanel.vue` (覆盖 ChatFlow)  | 制作触发 | ✅ $craft  | P1     |

### 6.5 已有组件复用

| 已有组件                          | 使用位置                                              | 状态                        |
| --------------------------------- | ----------------------------------------------------- | --------------------------- |
| `ResourceBar.vue`                 | StatusOverview (HP/MP/SP/EXP)                         | ✅ 直接复用                 |
| `AvatarPanel.vue`                 | StatusOverview (角色头像 + fallback: 随机底色+首字母) | ✅ 已有，增加 fallback 模式 |
| `BuffChip.vue`                    | StatusOverview (Buff/Debuff 药丸)                     | ✅ 已有，组合使用           |
| `AppModal.vue`                    | Modals 弹出层                                         | ✅ 已有                     |
| `QualityBadge.vue`                | 品质徽章 (物品列表)                                   | ✅ 已有                     |
| `AppCard.vue`                     | 卡片容器                                              | ✅ 已有                     |
| `AppTabs.vue`                     | 面板内 Tab 切换                                       | ✅ 已有                     |
| `AppButton.vue`                   | 各类按钮                                              | ✅ 已有                     |
| `AppModal.vue`                    | Modals 弹出层                                         | ✅ 已有                     |
| `QualityBadge.vue`                | 品质徽章 (物品列表)                                   | ✅ 已有                     |
| `AppCard.vue`                     | 卡片容器                                              | ✅ 已有                     |
| `AppTabs.vue`                     | 面板内 Tab 切换                                       | ✅ 已有                     |
| `AppButton.vue`                   | 各类按钮                                              | ✅ 已有                     |
| `StatusEffectDisplay`             | `BuffChipGroup.vue` (复用 BuffChip)                   | ✅ BuffChip 已有            | P0  |
| `Ascension`                       | `AscensionPanel.vue` (新建)                           | ✅ CharacterState.ascension | P2  |
| `ConfirmModal/DeleteConfirmModal` | ✅ 已有 `AppModal.vue` (扩展)                         | ✅                          | P1  |

---

## 七、数据流设计

### 7.1 GamePage 初始化流程

```
GamePage mounted(saveId)
  │
  ├─ gameStore.loadSave(saveId)
  │   ├─ getSave(saveId)                     → activeSave
  │   ├─ getCharacters(saveId)               → characters[] (player + npcs)
  │   ├─ getMemories(saveId)                 → recentMemories[]
  │   ├─ getPlotEvents(saveId)               → activePlotEvents[]
  │   └─ getSaveProfile(saveId)              → saveProfile (fp/news/achievements)
  │
  ├─ 主题初始化 (themeStore)
  │   └─ applyTheme(saveId 对应主题)
  │
  └─ 定位当前位置
      └─ location-db.getLocationNode(player.location)
```

### 7.2 实时更新数据流

```
AI 生成回合完成
  │
  ├─ AgentOrchestrator 输出
  │   ├─ StatePatch[] → StateManager.commitChatState()
  │   │   └─ 更新 CharacterState (hp/mp/attributes/effects...)
  │   ├─ MemoryRecord → memoryStore
  │   └─ PlotEvent → plotEngine
  │
  ├─ gameStore 响应式更新 (Pinia)
  │   ├─ player.hp 变化 → ResourceBar 自动重渲染
  │   ├─ player.statusEffects 变化 → BuffChip 自动更新
  │   └─ messages 新增 → ChatFlow 追加消息气泡
  │
  └─ UI 层动画
      ├─ ResourceBar: CSS transition 250ms 血量变化
      ├─ BuffChip: 淡入动画 (新效果)
      └─ 消息气泡: 从下向上滑入 (新消息)
```

#### 7.2.1 生成与正文渲染契约

- `GamePipeline` 在把当前玩家消息写入对话流之前快照历史；当前输入只通过
  `AgentContext.userInput` 发送，不能同时出现在 `history`。
- `AgentClient.chatStream()` 以 SSE 的 `[DONE]`、`finish_reason + EOF` 或显式错误完成一次且仅一次；
  `story-output.ts` 是流式预览与最终入库共用的正文/选项投影入口；流式内容在 `<maintext>`
  开标签到达前保持缓冲，避免前导分析进入玩家视图。
- 默认管线把 `story` 声明为必需 Agent；缺失、报错、投影后无可见正文或完成处理失败时本回合失败，
  不推进回合。异步 `onAgentComplete` 持久化完成后，编排器才进入后续阶段。
- `compileBeautifierSegments()` 只让后续规则消费尚未命中的原文，并按原生 JavaScript
  replacement 语义展开 `$1..$99`、`$&`、`$$`、命名组等；先前 replacement 不会被后续规则重写。
- 工坊规则只把含 AI-output `placement=2` 的一侧接入 assistant renderer；`minDepth`/`maxDepth`
  从最新 user/assistant 消息起按 0 计数、忽略 system event，并按含边界语义筛选。
- 未命中正文与内置对话卡片始终用 Vue 文本绑定渲染；HTML/CSS/script replacement 不清洗，
  每次富命中各自进入一个无 same-origin 的 `sandbox="allow-scripts"` iframe。由此规则的全局 CSS/布局只影响
  自己的命中，不能触及普通正文或其它命中；跨命中 DOM 查询不兼容。frame 使用 `credentialless` + `no-referrer`，外部 HTTP(S) 资源与
  原生网络 API 放行；form、popup、download、top navigation 与嵌套 frame 仍由 sandbox/CSP 阻断。
- frame 不能读 parent DOM、IndexedDB、应用 Dexie/storage 或 API Key；应用自有 `/api` 拒绝 `Origin: null`。
  正则唯一持久能力是 Dexie v16 `regexStorage` 代表的共享不可信命名空间：所有正则、信任级别与预览共用，
  authored `<head>` script 前完成 hydration，iframe 通过同步 `localStorage` 镜像和 `window.regexStorage` 别名读写，
  mutation 异步落库并跨 frame 广播。`sessionStorage` 仍只活在当前 frame。
- regex namespace 限 5 MiB / 1024 keys / 单 key 4096 UTF-8 bytes，进入 `FullBackup`，工坊更新/卸载不清理。
  规则向远程/本地网络发请求，或外传它可见的正文与 regex-namespace 数据，是为兼容现有工坊内容而明确接受的暴露。
- 流式正文始终按原生文本预览，提交后才创建富文本 frame，避免每个 token 重跑脚本；已完成正文、
  战斗正文和规则预览共用同一 renderer。完整 HTML 文档与外层 Markdown HTML 围栏由 frame 装配器归一化。

### 7.3 Store 设计补充（修订版）

```typescript
// game-store.ts 需补充的字段
interface GameStore {
  // ... 现有字段 ...

  // 🆕 UI 布局状态
  sidebarCollapsed: boolean; // 左侧工具栏是否折叠
  rightPanelMode: string; // 右侧面板当前显示:
  // 'status' | 'items' | 'characters' |
  // 'quests' | 'plot' | 'memory'
  fullscreenStatus: boolean; // 状态栏全屏模式

  // 🆕 对话流
  messages: ChatMessage[]; // 对话流所有消息
  isGenerating: boolean; // AI 是否正在生成

  // 🆕 战斗/制作覆盖
  activeCombat: CombatState | null; // 非 null → CombatPanel 覆盖 ChatFlow
  activeCraft: CraftActionResult | null; // 非 null → CraftPanel 覆盖 ChatFlow

  // 🆕 伙伴 (从 characters 派生)
  partners: ComputedRef<CharacterState[]>; // type='npc' + 有 Affection 记录

  // 🆕 任务
  quests: Quest[]; // 需新增 Quest 类型 (P1)
}
```

---

## 八、关键 UX 规范 (UI/UX Pro Max 提取)

### 8.1 必须遵守

| 规范                   | 应用场景                                         |
| ---------------------- | ------------------------------------------------ |
| **触摸目标 ≥ 44×44px** | 所有可点击元素 (BuffChip/Tab/装备槽)             |
| **间距 8px+**          | 列表项之间、按钮之间                             |
| **动画 150-300ms**     | Tab 切换、血量变化、消息出现                     |
| **加载反馈 < 100ms**   | 发送消息后立即显示 loading 态                    |
| **键盘导航**           | Tab 键可在状态栏各区域间跳转                     |
| **Focus 可见**         | 所有交互元素有 `:focus-visible` 样式             |
| **色彩不是唯一指示**   | 品质色 + 文字标签同时存在 (不是只靠颜色区分品质) |
| **减少动画偏好**       | 尊重 `prefers-reduced-motion`                    |

### 8.2 暗色/浅色双模式

| 规则               | 做法                                            |
| ------------------ | ----------------------------------------------- |
| 文字对比度 ≥ 4.5:1 | 用 CSS 变量 `--theme-text-primary` (主题已保证) |
| 边框可见           | `--theme-card-border` 双模式下均有足够对比度    |
| 交互状态           | hover/pressed/disabled 三种状态双模式分别测试   |
| Modal scrim        | 40-60% 黑色遮罩，不随主题变化                   |

### 8.3 游戏页面特有 UX

| 规则                | 做法                                              |
| ------------------- | ------------------------------------------------- |
| **状态栏可折叠**    | 对话为主时收起右侧 HUD，专注叙事                  |
| **战斗/制作覆盖层** | 触发时替换叙事面板，不可被打断但可最小化          |
| **消息自动滚动**    | 新消息 → `scrollIntoView({ behavior: 'smooth' })` |
| **输入栏固定底部**  | `position: sticky; bottom: 0;` 不随内容滚动       |
| **Toasts 非阻塞**   | 存档成功/FP 变化用 Toast 提示，3-5 秒自动消失     |

---

## 九、总结

### ✅ 引擎支撑良好的部分（可立即开始开发）

- 角色状态展示 (CharacterState 完整)
- 资源条 (HP/MP/SP/EXP)
- 属性面板 (五维 + 自由点)
- 装备/技能/背包列表
- 状态效果药丸
- 战斗面板 ($combat API)
- 制作面板 ($craft API)
- 主题系统 (10 主题 CSS 变量)
- 存档/FP/成就 (SaveProfile)
- 位置信息 (location-db)
- 新闻展示 (NewsItem[])

### ⚠️ 需新增引擎支持

| 缺口                  | 优先级 | 建议                                 |
| --------------------- | ------ | ------------------------------------ |
| 任务系统 (Quest 类型) | P0     | 新增 `Quest` 接口 + 加入 SaveProfile |
| 地图标记              | P1     | UI 层数据存 SaveProfile.worldFlags   |

### 📐 实施路线

```
Phase 7e-1 (本周): 游戏页骨架 + 状态栏 HUD (ResourceBar + Avatar + 属性摘要)
Phase 7e-2 (下周): 完整 Tab 系统 (状态/物品/任务/新闻)
Phase 7e-3: 战斗 & 制作面板覆盖
Phase 7e-4: 伙伴 & 地图 (如时间允许)
```
