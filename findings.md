# Findings & Decisions

## Requirements

### 前端
- 默认暗金主题，可切换（暗色/白色/粉色/浅绿色）
- 首页：标题 + 新存档/读取存档/设置/创意工坊
- 捏人页面（参考 v4.2.1 自定义开局脚本，CDN 页面）
- 游戏页面三栏：左（记忆/剧情规划/快照/创意工坊）| 中（对话框+选项）| 右（NPC/背包/技能/任务/地图）
- 状态栏（参考 v4.2.1 状态栏脚本）
- 输入框：Enter 发送，Ctrl+Enter 换行，中断按钮
- 桌面 Web 应用（监听端口，浏览器访问）
- 简单动画，无需音效

### 后端
- 多 Agent 管线：记忆召回 → 剧情规划(并行) → 正文 AI → 变量更新 → 角色更新(并行×N) → 记忆总结 → 剧情修正
- DeepSeek 特化：Agent 用 4 Flash，正文用 4 Pro
- 每 Agent 独立 userID 缓存隔离
- Prompt 前固定后可变（缓存优化）
- 记忆系统：MEM00XXX 编号，时间跨度，正文(≥200字)，暗线
- 剧情规划：嵌套事件结构，开局/每年初始化，世界线变动
- 战斗&制作：函数调用形式，后端结算，禁止口胡
- 角色可插拔：统一 NPC/主角/怪物接口
- 变量更新：JSON Patch (replace/delta/insert)
- 快照回滚：15-30 快照/存档，10 存档槽
- 输出违规检测：正则库，每次注入
- 手动 Agent 重生成（保持流程单向性）

### 数据
- 浏览器 IndexedDB 持久化
- 10 存档槽，每档 30 快照
- API Key 本地存储

---

## Research Findings

### 从 v4.2.1_chara_card.json 发现
- **12 个 regex_scripts**：首页、自定义开局、状态栏、命运抽卡、变量更新等
- 脚本通过 `$('body').load(CDN_URL)` 注入外部 HTML 页面
- 状态栏脚本 ID: `f84dd111-3c26-4f02-a365-aa6b92b6da13`，findRegex: `<StatusPlaceHolderImpl/>`
- 首页脚本 ID: `73844570-ac84-46d1-815a-d2c883a02f67`，findRegex: `【首页】`
- 自定义开局脚本 ID: `02af59f9-2429-4b56-ad17-e731cecdd3b3`，findRegex: `<customized>...</customized>`

### 从命定之诗 JSON（605 条世界规则）发现
- **mvu_update 协议**：变量更新使用 JSON Patch 格式 (replace/delta/insert)
- **战斗协议**：<action_info> 面板，d20 掷骰，回合制（1攻击+1动作/回合）
- **生产协议**：三级加工（基础→半成品→成品），四种生产类型
- **状态规则**：状态有层数、剩余时间、来源、效果数值化
- world book 条目使用 `{{getvar::系统名}}` 动态变量引用（EJS 风格）

### EJS 模板在 world book 中的使用模式
- 世界规则条目中大量使用 `{{变量名}}`、`{{getvar::路径}}` 动态引用
- 需要在扫描匹配时解析这些模板变量
- 考虑使用轻量模板引擎或手写正则解析

### 现有代码复用评估
| 模块 | 复用率 | 说明 |
|------|--------|------|
| database.ts | 80% | 加表即可 |
| types.ts | 50% | 大量新类型 |
| lorebook-engine.ts | 70% | 关键词匹配保留，注入位置改 |
| importer.ts | 90% | ST 格式导入完全可用 |
| variables.ts | 40% | mvu_update 格式需重写 |
| vars-merger.ts | 60% | 需加 delta 操作 |
| api-router.ts | 20% | 双→多 Agent 基本重写 |
| prompt-assembler.ts | 30% | 单管线→多 Agent 模板 |
| stream-parser.ts | 60% | XML 解析可用 |
| vanilla-store.ts | 50% | 状态维度大幅扩展 |

## Technical Decisions

| 决策 | 理由 |
|------|------|
| Agent 调度用 DAG | 支持串行+并行混合，可表达依赖关系 |
| 角色用统一 Character 接口 | 扩展角色卡只需实现接口，可插拔 |
| 记忆/剧情独立表存储 | 量级不同于聊天消息，需独立索引 |
| JSON Patch 做变量更新 | 与现有 mvu_update 协议兼容 |
| 快照做全量而非增量 | 30 个快照量不大，全量更简单可靠 |
| 本地 IndexedDB 而非服务器 DB | 隐私优先，Key 不出本地 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 现有 api-router 仅双 API | 重构为多 Agent 调度器，每 Agent 独立 endpoint |
| world book 中有 EJS 模板语法 | 需在 prompt-assembler 中增加模板渲染步骤 |
| DeepSeek 缓存隔离文档不明确 | 需实际测试 userID 参数对缓存的影响 |

## Resources

- 本仓库：`src/sillytavern/` — 现有引擎代码
- v4.2.1_chara_card.json — 首页/捏人/状态栏脚本参考
- 命定之诗与黄昏之歌v4.2 绿灯命中微调版 (1).json — 605 条世界规则
- ARCHITECTURE_TEMPLATE.md — 用户填写的详细需求
- ARCHITECTURE_backup_20260613.md — 初始架构文档备份
- `.claude/skills/sillytavern-web/templates/` — React 组件模板（可参考）

## Visual/Browser Findings

- 角色卡脚本通过 `$('body').load(URL)` 加载前端页面 — 模式可复用但需改为本地服务
- 状态栏参考 CDN: `testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html`
- 首页参考 CDN: 同路径 `dist/home/index.html`
- 捏人参考 CDN: 同路径 `dist/custom_start/index.html`
- InitVar YAML 结构：{事件, 世界{时间,地点}, 任务列表, 主角{种族,身份,职业,生命层级,等级,属性{五维},HP/MP/SP,状态效果,金钱,背包,技能,**登神长阶{要素,权能,法则,神位,神国}**}, 命运点数, 关系列表, 新闻{三大板块}}
- DLC 地理拓扑：EJS 模板解析 `getMessageVar('stat_data.世界.地点')` 后匹配 geographyDB 输出拓扑路线图
- 系统级变量命名空间：`stat_data.世界.*` / `stat_data.主角.*` / `stat_data.任务列表.*` 等

---

## Phase 1 补充设计（用户反馈修正 v2）

### 修正 1: CharacterState 补充登神长阶 & 完整属性

从 InitVar（`[128325]`）YAML 结构推导，完整角色状态：

```typescript
interface CharacterState {
  // ===== 基础信息 =====
  id: string;
  type: 'player' | 'npc' | 'monster' | 'summon';
  name: string;
  race: string;
  identity: string[];          // 身份标签
  occupation: string[];        // 职业标签

  // ===== 生命层级 =====
  tier: number;                // 1-7
  tierName: string;            // '普通' | '中坚' | '精英' | '史诗' | '传说' | '神话' | '神祗'
  level: number;               // 1-25
  totalExp: number;
  expToNext: number;

  // ===== 五维属性 =====
  attributes: {
    str: number;  dex: number;  con: number;
    int: number;  spi: number;
  };
  freeAttrPoints: number;

  // ===== 资源 =====
  hp: number;   maxHp: number;
  mp: number;   maxMp: number;
  sp: number;   maxSp: number;

  // ===== 登神长阶 (Lv.13+) =====
  ascension: {
    enabled: boolean;            // 是否开启登神长阶
    elements: Record<string, ElementDetail>;   // 要素 (Lv.13-16, 上限3)
    authority: Record<string, AuthorityDetail>; // 权能 (Lv.17-20, 3要素→1权能)
    law: Record<string, LawDetail>;            // 法则 (Lv.21-24)
    deityPosition: string;       // 神位 (Lv.25)
    divineKingdom: {             // 神国 (Lv.25巅峰)
      name: string;
      description: string;
    };
  };

  // ===== 装备/技能/背包 =====
  equipment: EquipmentSlot[];
  skills: Skill[];
  inventory: InventoryItem[];
  statusEffects: StatusEffect[];

  // ===== 经济 =====
  money: number;               // G

  // ===== 位置 =====
  location: string;            // 当前详细位置路径

  // ===== 冒险者等级 =====
  adventurerRank: string;      // '未评级' | 'D' | 'C' | 'B' | 'A' | 'S'

  // ===== 扩展字段 =====
  customFields: Record<string, any>;
}

// 要素详情
interface ElementDetail {
  name: string;
  description: string;
  effects: string[];           // 被动效果列表
}

// 权能详情
interface AuthorityDetail {
  name: string;
  description: string;
  effects: string[];
  costDescription: string;     // 消耗描述 (如 '25% 最大MP+SP+攻击+动作')
}

// 法则详情
interface LawDetail {
  name: string;
  description: string;
  effects: string[];
  costDescription: string;
}
```

### 修正 2: Prompt vs Code 边界 & EJS 策略

**核心原则**：简单逻辑交给 code，复杂逻辑交给 prompt（AI 执行）。

```
┌─────────────────────────────────────────────────────┐
│  CODE（确定性，无需缓存优化）                          │
│  · 战斗数值结算 (d20 公式)                           │
│  · HP/MP/SP 计算                                    │
│  · 等级/层级判定                                     │
│  · 经验值结算                                        │
│  · 制作系统检定                                       │
│  · 状态效果倒计时                                     │
│  · 变量 JSON Patch 执行                              │
│  · 数据校验 & 类型约束                                │
│  · 输出违规检测（正则匹配）                            │
└─────────────────────────────────────────────────────┘
                         │
                         │ 提供结构化数据
                         ▼
┌─────────────────────────────────────────────────────┐
│  PROMPT（非确定性，需要缓存优化）                      │
│  · 角色性格扮演                                       │
│  · 剧情叙事生成                                       │
│  · 记忆总结 & 召回排序                                │
│  · 剧情事件匹配 & 世界线判断                           │
│  · NPC 行为推理                                       │
│  · 选项生成                                          │
│  · 角色导入时 AI 重构为 CharacterState                │
└─────────────────────────────────────────────────────┘
```

**EJS 策略修正（ADR-04 更新）**：

> ❌ 旧方案：世界书 EJS 在每次 scan 时渲染 → 每次 Prompt 不同 → 缓存 miss
> ✅ 新方案：**禁用世界书内的 EJS，改为静态 pre-render**

```
导入流程:
  世界书原始条目（含 {{getvar::}} EJS）
       ↓
  AI 重构 → 生成静态 content（EJS 变量展开为固定值）
       ↓
  存入 lorebook (content 为纯静态文本)
       ↓
  后续 scan 时直接匹配静态文本 → 每次相同 → 缓存命中
```

**EJS 转移策略**：
- 世界书条目中的 EJS → **禁用**。导入时做一次静态化
- 角色卡 customFields 中的动态内容 → **保留为 code 层处理**（不经过 Prompt）
- `{{getvar::}}` 语法在 code 层处理 → 每次渲染结果视为纯数据注入到 `variableContext`

**缓存优化效果**（修正后）：
| Agent | 修正前估计命中率 | 修正后估计命中率 |
|-------|----------------|----------------|
| story | 60% | **85%+**（世界书不再引入动态变化） |
| memory_recall | 80% | **90%+** |
| plot_check | 75% | **88%+** |

### 修正 3: 组件树调整 & 地图拓扑

```
GamePage
├── 左侧栏 (EnginePanel)             250px
│   ├── MemoryPanel
│   ├── PlotPanel
│   ├── SnapshotPanel
│   └── WorkshopPanel(fold)
├── 中央栏 (MainPanel)               flex:1
│   ├── MainTextPane
│   ├── OptionList
│   ├── ThinkingFold(fold)
│   └── InputBar
└── 右侧栏 (GamePanel)               280px
    ├── StatusBar                   ← 移到此处，上方
    ├── NPCPanel
    ├── InventoryPanel
    ├── SkillPanel
    ├── QuestPanel
    └── MapTopologyPanel            ← 新增，下方
```

**地图拓扑方案**：
- 从 `stat_data.世界.地点` 读取当前位置
- 匹配 DLC 地理拓扑条目（`[580370]`）中的 `geographyDB`
- 渲染为 ASCII 拓扑图：`[当前城市] <=(地形/距离)=> [相邻城市]`
- 参考 `[626480]` 的长途移动数据（徒步/骑乘/马车/传送 的日行距离）

```typescript
interface MapTopology {
  currentNode: string;
  neighbors: TopologyEdge[];
  distanceUnit: 'km' | '天';
}

interface TopologyEdge {
  from: string;
  to: string;
  terrain: '平原' | '河流' | '沼泽' | '森林' | '山地' | '沙漠';
  distance: number;       // 距离数值
  travelTime: {           // 计算后的旅行时间
    walk: number;         // 徒步（天）
    ride: number;         // 骑乘
    carriage: number;     // 马车
  };
}
```

### 修正 4: API 总控 & Agent 配置

```typescript
// ===== API 总控 =====

interface ApiEndpoint {
  id: string;                   // UUID
  name: string;                 // 用户自定义名称，如 'DeepSeek主号'
  provider: string;             // 'deepseek' | 'openai' | 'moonshot' | 'custom'
  baseUrl: string;
  apiKey: string;               // 加密存储
  defaultModel: string;
  models: string[];             // 可用模型列表
  timeout: number;
}

interface AgentConfig {
  agentId: string;              // 'story' | 'memory_recall' | ...
  enabled: boolean;             // 是否启用
  apiEndpointId: string;        // 指向 ApiEndpoint.id
  model: string;                // 覆盖 endpoint 的默认 model
  temperature: number;
  maxTokens: number;
  retryOnFail: boolean;
  timeout: number;
  userId: string;               // DeepSeek 缓存隔离（自动生成）
  promptTemplate: {             // Prompt 模板
    fixedSystem: string;
    fixedExamples: string;
  };
}

interface AppSettings {
  // ... 原有字段 ...
  apiEndpoints: ApiEndpoint[];     // API 总控列表
  agentConfigs: AgentConfig[];     // 每 Agent 的详细配置
  agentPipeline: PipelineStage[];  // 管线配置（可调整顺序）
}
```

**API 总控 UI 设计**：
```
设置 → API 管理
├── API 端点列表
│   ├── [+ 添加新端点]   → 弹窗：名称/提供商/baseUrl/apiKey/默认模型
│   ├── DeepSeek主号      → [编辑] [删除]
│   ├── DeepSeek备号      → [编辑] [删除]
│   └── Kimi备用          → [编辑] [删除]
├── Agent 配置
│   ├── 正文 AI (story)       → 使用 [DeepSeek主号 ▼] 模型 [deepseek-chat ▼]
│   ├── 记忆召回 (memory)     → 使用 [DeepSeek备号 ▼] 模型 [deepseek-chat ▼]
│   ├── 剧情规划 (plot)       → 使用 [DeepSeek主号 ▼] 模型 [deepseek-chat ▼]
│   ├── 变量更新 (vars)       → 使用 [Kimi备用 ▼]   模型 [moonshot-v1-8k ▼]
│   └── 角色更新 (char)       → 使用 [DeepSeek备号 ▼] 模型 [deepseek-chat ▼]
└── 管线顺序调整（拖拽）
```

---

### 架构决策记录 (ADR) 更新

| ID | 决策 | 理由 | 变更 |
|----|------|------|------|
| ADR-04 | ~~世界书模板在扫描时渲染~~ → **导入时静态化，禁用 EJS** | 缓存命中优先，动态变量通过 code 层 variableContext 注入 | ⚡ 已修正 |
| ADR-11 | Prompt vs Code 边界：确定性逻辑归 Code，创造性推理归 Prompt | 战斗/制作/数值由 code 结算不出错，叙事/角色由 AI 发挥 | 🆕 |
| ADR-12 | 世界书 EJS 禁用，变量动态性转移到 variableContext | 每轮 Prompt 的 fixedSystem 完全不变 → 最大化缓存命中 | 🆕 |
| ADR-13 | API 端点与 Agent 配置分离 | 一个端点可被多个 Agent 共享，Agent 可独立切换 API | 🆕 |
| ADR-14 | 地图拓扑从 DLC 地理数据库静态生成 | 检测 location → 匹配 geographyDB → 拓扑图，不占用 Prompt | 🆕 |
| ADR-15 | 角色卡导入时由 AI 重构为 CharacterState | 非结构化角色卡 → AI 提取 → 结构化存储，后续只维护结构体 | 🆕 |

---

## Phase 1 Architecture Design

### 1. 前端架构设计

#### 1.1 路由 & 页面结构

```
开发服务器 (localhost:5173)
├── /                    → 首页 (HomePage)
├── /create              → 捏人页 (CharacterCreate)
├── /game/:saveId        → 游戏页 (GamePage)
├── /settings            → 设置页（如果弹出层不够用）
└── /workshop            → 创意工坊（世界书管理）
```

#### 1.2 组件树（游戏页三栏布局）

```
GamePage
├── 左侧栏 (EnginePanel)          250px 宽
│   ├── MemoryPanel               ← 记忆召回展示
│   ├── PlotPanel                 ← 剧情规划展示
│   ├── SnapshotPanel             ← 快照管理
│   └── WorkshopPanel(fold)       ← 创意工坊入口
├── 中央栏 (MainPanel)            flex:1
│   ├── StatusBar                 ← 状态栏（HP/MP/时间/地点）
│   ├── MainTextPane              ← 正文流式显示
│   ├── OptionList                ← 选项列表（右侧排列）
│   ├── ThinkingFold(fold)        ← 思考过程折叠
│   └── InputBar                  ← 输入框 + 发送/中断按钮
└── 右侧栏 (GamePanel)            250px 宽
    ├── NPCPanel                  ← NPC 列表
    ├── InventoryPanel            ← 背包
    ├── SkillPanel                ← 技能
    ├── QuestPanel                ← 任务
    └── MapPanel                  ← 地图（可折叠）
```

#### 1.3 数据流（Store → UI）

```
sillytavernStore (观察者模式)
  ├── settings: AppSettings        → 全局设置
  ├── activeSave: SaveSlot         → 当前存档
  │   ├── characters: Character[]  → 角色列表 (NPC + 主角)
  │   ├── memories: Memory[]       → 记忆列表
  │   ├── plotEvents: PlotEvent[]  → 剧情事件
  │   ├── variables: VarsState     → 全局变量快照
  │   ├── snapshots: Snapshot[]    → 快照历史
  │   └── chatMessages: Message[]  → 聊天下文
  ├── lorebooks: Lorebook[]        → 世界书列表
  └── presets: Preset[]            → 预设列表

每轮对话数据流:
  userInput → Store.sendMessage()
    → AgentOrchestrator.run(pipeline)
      → MemoryAgent.call()
      → PlotAgent.call()
      → StoryAgent.call()
      → VarsAgent.call()
      → CharacterAgent.call() × N (并行)
      → MemorySummaryAgent.call()
      → PlotCorrectionAgent.call()
    → Store.saveSnapshot()
  → notify() → UI 重渲染
```

### 2. 后端架构设计 (Agent 管线)

#### 2.1 Agent 清单 & 职责

| Agent ID | 名称 | 模型 | 输入 | 输出 | 依赖 |
|----------|------|------|------|------|------|
| `memory_recall` | 记忆召回 | 4 Flash | userInput + history | MEM[] 列表 | 无 |
| `plot_check` | 剧情规划 | 4 Flash | userInput + 当前事件 | 匹配的小事件 | 无（可并行） |
| `story` | 正文 AI | 4 Pro | memory[] + plot + lorebook + 角色 | XML 正文+选项 | memory_recall, plot_check |
| `vars_update` | 变量更新 | 4 Flash | story 输出 + 当前变量 | JSON Patch[] | story |
| `char_update` | 角色更新 | 4 Flash | story + 角色当前状态 | CharacterState (每角色) | story, vars_update |
| `memory_summary` | 记忆总结 | 4 Flash | story + 本轮 action | 新 MEM | story |
| `plot_correct` | 剧情修正 | 4 Flash | story + 当前事件 | 修改后的事件 | story, memory_summary |

#### 2.2 Agent 管线 DAG

```
                   ┌─────────────┐
                   │  userInput   │
                   └──────┬──────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
      ┌─────▼─────┐ ┌────▼─────┐       │
      │memory_recall│ │plot_check│       │
      │  (4 Flash)  │ │ (4 Flash) │       │
      └─────┬─────┘ └────┬─────┘       │
            │             │             │
            └──────┬──────┘             │
                   │                    │
            ┌──────▼──────┐             │
            │    story     │◄────────────┘  ← lorebook injection
            │   (4 Pro)    │
            └──────┬──────┘
                   │
            ┌──────▼──────┐
            │ vars_update  │
            │  (4 Flash)   │
            └──────┬──────┘
                   │
     ┌─────────────┼─────────────┐
     │   (并行, 每个角色一个)      │
     ├─────────────┤             │
┌────▼────┐ ┌─────▼────┐  ┌─────▼────┐
│char_upd │ │char_upd  │  │char_upd  │  ... × N
│ 主角     │ │ NPC1     │  │ NPC2     │
│(4 Flash)│ │(4 Flash) │  │(4 Flash) │
└────┬────┘ └─────┬────┘  └─────┬────┘
     └─────────────┼─────────────┘
                   │
            ┌──────▼──────┐
            │memory_summary│
            │  (4 Flash)   │
            └──────┬──────┘
                   │
            ┌──────▼──────┐
            │plot_correct  │
            │  (4 Flash)   │
            └──────┬──────┘
                   │
            ┌──────▼──────┐
            │  saveSnapshot │
            └──────────────┘
```

### 3. Agent 编排引擎数据结构

```typescript
// ===== Agent 定义 =====

interface AgentDefinition {
  id: string;                          // 'memory_recall' | 'story' | ...
  name: string;                        // 显示名
  description: string;                 // 职责描述
  model: string;                       // 'deepseek-chat' | 'deepseek-reasoner'
  temperature: number;
  maxTokens: number;
  userId: string;                      // DeepSeek 缓存隔离 key
  dependsOn: string[];                 // 依赖的 Agent ID 列表
  systemPrompt: {
    fixed: string;                     // 前固定部分（缓存命中关键）
    variable: (ctx: AgentContext) => string;  // 后可变部分
  };
  outputSchema?: object;               // 输出 JSON Schema (用于 function calling)
}

// ===== 管线定义 =====

interface PipelineStage {
  agents: string[];                    // 本阶段运行的 Agent（同阶段可并行）
  waitFor: string[];                   // 等待哪些 Agent 完成
}

interface Pipeline {
  stages: PipelineStage[];             // 顺序执行的阶段
  timeout: number;                     // 整体超时
  retryOnFail: boolean;                // 失败重试策略
}

// ===== 运行上下文 =====

interface AgentContext {
  userInput: string;
  history: ChatMessage[];
  lorebookMatches: MatchedEntry[];
  characters: CharacterState[];
  variables: Record<string, any>;
  plotEvents: PlotEvent[];
  memories: MemoryRecord[];
  agentOutputs: Map<string, any>;      // 上游 Agent 的输出
}

// ===== 调度器 =====

interface OrchestratorRun {
  id: string;
  pipeline: Pipeline;
  context: AgentContext;
  startedAt: number;
  completedStages: string[];
  currentStage: string | null;
  agentResults: Map<string, AgentResult>;
  status: 'running' | 'completed' | 'failed';
}

interface AgentResult {
  agentId: string;
  output: any;                         // 解析后的输出
  rawResponse: string;
  tokensUsed: number;
  cacheHit: boolean;                   // DeepSeek 缓存命中
  duration: number;                    // ms
  error?: string;
}
```

### 4. 代码复用评估（逐文件详细分析）

#### 4.1 直接保留（改名/不用改）
| 文件 | 说明 |
|------|------|
| `importer.ts` | ST 格式导入/导出，完全保留。新增 `importCharacterCard()` 方法 |
| `editor-utils.ts` | 纯工具函数，保留 |

#### 4.2 扩展改造
| 文件 | 改造内容 | 新增接口 |
|------|---------|---------|
| `types.ts` | +Agent/Pipeline/Character/Memory/PlotEvent/Snapshot/SaveSlot | ~200行新类型 |
| `database.ts` | +memories 表 +plot_events 表 +characters 表 +snapshots 表 +saves 表 | ~100行 |
| `lorebook-engine.ts` | +EJS 模板解析钩子 `onRenderTemplate` | ~20行 |
| `variables.ts` | +JSON Patch 操作 (replace/delta/insert) +嵌套路径解析 | ~80行 |
| `vars-merger.ts` | +delta 操作 +数组 insert | ~30行 |
| `stream-parser.ts` | 保留 XML 解析，新增 JSON 解析模式 | ~30行 |

#### 4.3 重写
| 文件 | 原因 |
|------|------|
| `api-router.ts` → `agent-orchestrator.ts` | 双API→多Agent DAG调度 |
| `prompt-assembler.ts` → `prompt-builder.ts` | 单管线→多Agent模板系统 |
| `api-tools.ts` → `deepseek-client.ts` | 通用→DeepSeek特化（userID/缓存） |

#### 4.4 新建
| 文件 | 职责 |
|------|------|
| `agent-orchestrator.ts` | DAG调度引擎 |
| `agent-templates.ts` | 每Agent的Prompt模板 |
| `memory-store.ts` | 记忆召回/总结逻辑 |
| `plot-engine.ts` | 剧情规划/世界线修正 |
| `character-manager.ts` | 统一角色状态管理 |
| `combat-resolver.ts` | 战斗结算（d20 + 公式） |
| `crafting-resolver.ts` | 制作结算 |
| `snapshot-manager.ts` | 快照创建/回滚 |
| `ejs-renderer.ts` | EJS模板引擎 |
| `violation-checker.ts` | 输出违规检测 |
| `vanilla/app-store.ts` | 扩展后的Store |
| `server.ts` | 开发服务器（监听端口） |
| `components/*.html` | 前端页面 |

### 5. 多角色可插拔架构

```typescript
// ===== 统一角色定义 =====

interface CharacterState {
  id: string;
  type: 'player' | 'npc' | 'monster' | 'summon';
  name: string;
  race: string;                        // 种族
  gender: string;
  level: number;
  tier: number;                        // 生命层级 (1-7)

  // 五维属性
  attributes: {
    str: number; dex: number; con: number;
    int: number; spi: number;
  };

  // 资源
  hp: number; maxHp: number;
  mp: number; maxMp: number;
  sp: number; maxSp: number;

  // 装备 (可扩展)
  equipment: EquipmentSlot[];

  // 技能列表
  skills: Skill[];

  // 背包
  inventory: InventoryItem[];

  // 状态效果
  statusEffects: StatusEffect[];

  // 位置
  location: string;

  // 当前行为
  currentAction: string;

  // 扩展点：角色卡自定义字段
  customFields: Record<string, any>;
}

// ===== 角色卡格式（可导入） =====

interface CharacterCard {
  // 基础信息
  name: string;
  description: string;
  personality: string;                 // 五维编码 wOaGz(A)
  scenario: string;
  firstMes: string;
  mesExample: string;

  // SillyTavern 扩展
  spec: string;
  spec_version: string;
  data: {
    extensions: {
      regex_scripts?: RegexScript[];   // 前端脚本注入
    };
    character_book?: SillyTavernLorebookExport;  // 角色专属世界书
  };

  // 自定义，引擎在此注入
  _engine: {
    gameSettings: {                    // 游戏化参数
      initialLevel: number;
      initialAttributes: Record<string, number>;
      initialEquipment: EquipmentSlot[];
      initialSkills: Skill[];
    };
    displayConfig: {                   // 前端显示配置
      avatar: string;                  // 头像 URL/base64
      theme: string;                   // 角色专属配色
    };
  };
}
```

**可插拔性保证**：
- NPC/主角/怪物共用 `CharacterState` 接口
- 新的角色类型只需实现 `CharacterState` 并填写 `type` 字段
- Agent 通过 `type` 过滤处理不同类型的角色
- 角色卡 JSON 导入后自动填充 `_engine` 元数据

### 6. EJS 模板兼容方案

#### 6.1 需要解析的语法
```
{{变量名}}              → 简单变量替换，如 {{HP}} → 80
{{getvar::路径}}        → 嵌套取值，如 {{getvar::主角.HP}} → 80
{{getvar::系统名.子字段}} → 系统变量，如 {{getvar::世界.时间}}
```

#### 6.2 集成点
在 `lorebook-engine.ts` 扫描时渲染模板：

```
世界书条目 content (原始):
  "当前时间为{{getvar::世界.时间}}，位于{{getvar::世界.地点}}"

      ↓ scan() 前先调用 ejsRenderer.render(content, variables)

世界书条目 content (渲染后):
  "当前时间为光辉纪元001年-05月-24日-周日-15:30，位于北方-诺斯加德-白曜城-五馆街"
```

#### 6.3 实现方案
```typescript
// ejs-renderer.ts
export class EjsRenderer {
  render(template: string, variables: Record<string, any>): string {
    return template
      .replace(/\{\{getvar::([^}]+)\}\}/g, (_, path) => this.resolvePath(path, variables))
      .replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const value = variables[key.trim()];
        return value !== undefined ? String(value) : `{{${key}}}`;
      });
  }

  private resolvePath(path: string, vars: Record<string, any>): string {
    const parts = path.split('.');
    let value: any = vars;
    for (const p of parts) {
      if (value === undefined || value === null) return `{{getvar::${path}}}`;
      value = value[p.trim()];
    }
    return value !== undefined ? String(value) : `{{getvar::${path}}}`;
  }
}
```

**关键设计决策**：模板在 **每次扫描时** 渲染（而非导入时），因为变量值会随游戏进程变化。

### 7. DeepSeek 缓存隔离方案

#### 7.1 问题
DeepSeek 的 Prompt 缓存基于 `(model + messages 前缀 + userId)` 哈希。默认所有请求同 userId，前一个 Agent 的输出污染后续缓存。

#### 7.2 策略
```
每 Agent 独立 userId:
  userId = "fated_poem|{saveId}|{agentId}|{roundNumber}"

固定部分 = Agent 的 system prompt（不会变）
可变部分 = 动态上下文（userInput / 上游Agent输出 / 变量）

发送时:
  messages[0] = { role: 'system', content: fixedPrompt + '\n' + variableContext }

缓存命中条件:
  - 同一 saveId + 同一 agentId
  - fixedPrompt 完全相同
  - 首次发送后，后续轮次只要 fixedPrompt 不变 → 缓存命中
```

#### 7.3 userId 设计
```typescript
function buildUserId(saveId: string, agentId: string): string {
  // 每个存档+Agent 有独立的缓存空间
  return `fp|${saveId}|${agentId}`;
  // 例: "fp|save_001|story" "fp|save_001|memory_recall" "fp|save_001|char_update"
}
```

#### 7.4 Prompt 分段策略
```typescript
interface AgentPromptTemplate {
  // === 固定部分（缓存敏感） ===
  fixedSystem: string;       // Agent 职责 + 世界观基础 + 输出格式
  fixedExamples: string;     // Few-shot 示例

  // === 可变部分（每轮变化）===
  variableContext: (ctx) => string;   // 上游Agent输出 + 当前状态
  variableInstruction: (ctx) => string; // 本轮特定指令
}
```

#### 7.5 预期缓存收益
| Agent | 每轮固定 Token | 可变 Token | 估计缓存命中率 |
|-------|---------------|-----------|--------------|
| memory_recall | ~2000 | ~500 | 80%+ |
| plot_check | ~2500 | ~800 | 75%+ |
| story | ~3000 | ~2000 | 60%+ |
| vars_update | ~1500 | ~1000 | 70%+ |
| char_update | ~1500 | ~1200 | 65%+ |

> ⚠️ 需要实际测试验证。DeepSeek 缓存策略可能变化。

### 8. 架构决策记录 (ADR)

| ID | 决策 | 理由 | 权衡 |
|----|------|------|------|
| ADR-01 | 用 DAG 而非线性管线 | 支持并行（memory+plot同时），扩展性好 | 复杂度高于简单数组 |
| ADR-02 | 每 Agent 独立 userId | DeepSeek 缓存隔离，最大化命中率 | 需要维护多 userId |
| ADR-03 | Prompt 前固定后可变 | 缓存只计算前缀匹配，最大化命中 | 需要对每 Agent 仔细分割 Prompt |
| ADR-04 | 世界书模板在扫描时渲染 | 变量值动态变化，导入时渲染会过期 | 每次扫描有微小性能开销 |
| ADR-05 | JSON Patch 做变量更新 | 与 mvu_update 协议天然兼容 | 需写 delta/insert 额外逻辑 |
| ADR-06 | 快照全量保存 | 30 个快照数据量可控，逻辑简单 | 比增量费存储（但 IndexedDB 足够） |
| ADR-07 | 本地 IndexedDB 持久化 | Key 不出本地，隐私安全 | 无法多设备同步 |
| ADR-08 | 角色卡用统一 CharacterState | NPC/主角/怪物可插拔 | 需要为不同类型做兼容字段 |
| ADR-09 | 战斗用 Function Calling | LLM 不参与数值计算 | 需要实现完整的 CombatResolver |
| ADR-10 | 角色更新 Agent 并行 | N 个角色 N 个请求，快 | API 并发限制需关注 |
| ADR-16 | PlotEvent 扁平存储 (childrenIds) | 避免 IndexedDB 嵌套查询复杂度和 Dexie 类型推断循环引用 | 运行时 resolvePlotTree() 重建嵌套树，轻微性能开销 |
| ADR-17 | SaveSlot 级联删除 | 删除存档时自动清理关联快照/记忆/剧情事件 | 需要多表事务保证一致性 |
| ADR-18 | importAllData 拆分 3 transaction | Dexie TypeScript 重载最多 ~5 表参数 | 不是原子操作，但全量导入场景可接受 |

---

## Phase 2 实现记录

### 类型系统决策

| 决策 | 理由 |
|------|------|
| PlotEvent 扁平存储 (childrenIds) | 避免 IndexedDB 嵌套查询复杂度和 Dexie 类型推断循环引用 |
| CharacterState 统一接口 | NPC/主角/怪物/召唤物共用，type 字段区分 |
| VarsPatch 支持 replace/delta/insert | 与 mvu_update 协议完全兼容 |
| Snapshot 全量存储 | 30 快照数据量可控 (~1-2MB)，全量比增量可靠 |
| SaveSlot 级联删除 | 删除存档时自动清理关联快照/记忆/剧情事件 |
| 存档系统：10 槽 × 30 快照/槽 | 槽数固定 (slot: 0-9)，每槽自动 trimSnapshots() |
| importAllData 3-transaction 拆分 | Dexie 类型签名限制，非原子但全量导入场景可接受 |

### 数据库 v4 变更

**新增 6 表**：

| 表 | 主键 | 索引 | 说明 |
|----|------|------|------|
| memories | id | saveId, createdAt, realTimestamp | MEM 记忆记录 |
| plotEvents | id | saveId, parentId, status, updatedAt | 剧情事件(扁平) |
| characters | id | type | 统一角色状态 |
| snapshots | id | saveId, index, timestamp | 快照检查点 |
| saves | id | slot, updatedAt | 存档槽 |
| apiEndpoints | id | name | API 端点配置 |

**迁移策略** (v3 → v4)：
1. 读取现有 settings 记录
2. 为每条记录添加 v4 新字段默认值（apiEndpoints: [], agentConfigs: [], agentPipeline: DEFAULT_AGENT_PIPELINE 等）
3. 写回 settings 表
4. 现有 lorebooks/presets/chats 数据不变

### 新增辅助函数

- `createDefaultCharacterState(overrides?)` — 创建默认角色状态
- `resolvePlotTree(flatEvents)` — 将扁平 PlotEvent[] 重建为 PlotEventNode[] 嵌套树
- `trimSnapshots(saveId, maxCount)` — 清理超出上限的快照
- `getRecentMemories(saveId, limit)` — 按时间倒序获取最新记忆
- `getActivePlotEvents(saveId)` — 获取所有 active 状态的事件

### 遇到的问题

1. **Dexie transaction() 参数限制**：TypeScript 类型重载最多支持 ~5 个表参数，10 表全量导入需要拆分为 3 个独立的 transaction（lorebooks+presets+settings+chats / memories+plotEvents+characters / snapshots+saves+apiEndpoints）。不是原子操作，但导入场景可接受。

2. **PlotEvent.children 循环引用**：`children: PlotEvent[]` 导致 Dexie 的 mapped type（用于索引键路径推断）无限递归 → TS2615 编译错误。改用 `childrenIds: string[]` 扁平存储 + `resolvePlotTree()` 运行时重建嵌套树。`PlotEventNode` 类型提供嵌套视图。

---

## Phase 3 实现记录

### Agent 编排引擎架构

**3 个新模块**：

| 文件 | 行数 | 职责 |
|------|------|------|
| `agent-client.ts` | ~130 | API 客户端：userId 缓存隔离、重试、超时、缓存命中检测 |
| `agent-templates.ts` | ~320 | 7 Agent 的 Prompt 模板：固定前缀 + 可变后缀 |
| `agent-orchestrator.ts` | ~270 | DAG 编排引擎：阶段串行 + Agent 并行 + 单向上下文流 |

### 技术决策

| 决策 | 理由 |
|------|------|
| `fp|{saveId}|{agentId}` 作为 userId | 简洁、可逆解析、每个存档+Agent 独立缓存空间 |
| `stageDependenciesMet()` 跳过而非报错 | 上游 Agent 失败不应阻止管线继续（其他分支可能成功） |
| `regenerateAgent()` 不传播到下游 | 保持流程单向性 — 手动重生成只更新该 Agent 的结果 |
| 同阶段 Agent `Promise.allSettled` | 允许部分失败，不互相阻塞 |
| Prompt 模板用 `Record<string, AgentPromptTemplate>` | 可扩展 — 新增 Agent 只需加 key + 模板 |
| `buildAgentMessages()` 独立于 AgentClient | 关注点分离 — 模板构建 vs API 调用 |

### 测试覆盖

| 文件 | Tests | 覆盖 |
|------|-------|------|
| `agent-client.test.ts` | 15 | userId 构建/解析、成功响应、HTTP 错误、重试、超时、AbortSignal、缓存命中 |
| `agent-templates.test.ts` | 50 | 7 Agent 存在性、fixedSystem>50字、fixedExamples>20字、variableContext/variableInstruction 非空、buildAgentMessages 结构、世界书注入、角色状态注入、模板质量 |
| `agent-orchestrator.test.ts` | 16 | 管线验证(有效+无效)、单/多阶段执行、并行验证、上下文传递、错误处理(部分失败)、regenerateAgent、onlyAgents、禁用Agent、事件回调、OrchestratorRun 结构 |

### 遇到的问题

1. **AbortSignal 竞态**：外部 signal 在 `addEventListener` 注册前已 aborted → listener 永不触发 → fetch 永不取消。修复：注册前检查 `signal.aborted`。

2. **ESM require() 报错**：`createDefaultPipeline()` 中使用 `require('./types')` → type:module 下不可用。修复：改用顶层 `export { DEFAULT_AGENT_PIPELINE } from './types'`。

3. **OrchestratorRun.status 缺 'idle'**：内部状态机需要 idle → running → completed/failed 完整生命周期。修复：types.ts 中添加 'idle' 到 status 联合类型。

---

## Phase 6e 实现记录

### 对话总结 (2026-06-15)

本对话完成了 Phase 6e: Marker Protocol + SubAgent 系统的全部实现，共 +108 tests，累计 1978 tests。

#### 新建模块
| 文件 | 行数 | 职责 |
|------|------|------|
| `marker-protocol.ts` | ~220 | XML 标记检测：scanMarkers / stripMarkers / parseTagAttributes 等 8 个纯函数 |
| `char-gen-agent.ts` | ~300 | 角色生成链：detectNewCharacters / runCharGenChain / assembleCharacterState / $chargen API |

#### 修改模块
| 文件 | 变更 | 内容 |
|------|------|------|
| `types.ts` | +~130 行 | 10 个新类型 + `add_character` StatePatchOp |
| `agent-templates.ts` | +~180 行 | craft_gen / char_gen / item_gen 模板，REGISTERED_AGENT_IDS 10→13 |
| `agent-orchestrator.ts` | +~80 行 | 3 个 Marker 回调 + processStageMarkers + pendingCombatMarkers |
| `index.ts` | +4 行 | 导出新模块 + VERSION → 4.0.0 |

#### 关键架构决策

1. **Combat 延迟到 Stage 2 后** (主人反馈修正):
   - 原始设计: Stage 1 story 后立即触发 combat
   - 修正后: Stage 1 暂存 combat_trigger → Stage 2 char_gen 先执行 → 再执行 combat
   - 理由: 正文中可能同时出现 `<char_detect>` 和 `<combat_trigger>`，新敌人/monster 必须在战斗开始前生成完毕

2. **Craft 阻塞注入**: Stage 1 story 后扫描 craft_request → 调 Craft Agent → 用 position 精确替换标记块为制作结果叙事

3. **Char Gen 链式触发**: vars_update 检测 char_detect → char_gen → item_gen (仅1次, ADR-26) → Stage 3 并行 char_update

#### Pipeline 最终形态
```
Stage 0: memory_recall + plot_pre_check     (并行)
Stage 1: story → craft 🛑阻塞注入 + combat 🚩暂存
Stage 2: vars_update → char_detect 👤 → combat 🚩执行 (新敌人已就绪)
Stage 3: char_update × N (并行，含新NPC)
Stage 4: memory_summary
Stage 5: plot_post_check
```

### 犯过的错误 (自省)

1. **架构假设错误 — Combat 时序**:
   - 错误: 最初设计 combat 在 Stage 1 story 后立即触发
   - 根因: 没有考虑到 `<char_detect>` 和 `<combat_trigger>` 可以同时出现在正文中，新敌人需要在战斗前生成
   - 教训: 多人/多实体场景要考虑数据依赖顺序，标记处理要考虑交叉场景
   - 主人纠正后修正

2. **类型不匹配 — TierConfig 字段名臆测**:
   - 错误: 使用 `tierConfig.mpSpMultiplier`，实际字段是分开的 `mpMultiplier` 和 `spMultiplier`
   - 根因: 凭记忆写代码，没有先查 tier-constants.ts 的 TierConfig 接口定义
   - 教训: 引用外部类型字段前必须先 grep 确认字段名

3. **类型不匹配 — EquipmentSlot 结构臆测**:
   - 错误: 假设 EquipmentSlot 是 `{id, slot, item: {id, name, ...}}`，实际是 `{slot, itemId, name}`
   - 根因: 同上，没有查 types.ts 中 EquipmentSlot 的实际定义
   - 教训: 涉及数据库/持久化类型的结构体必须查源定义，不能凭其他项目经验猜测

4. **类型不匹配 — StatePatchOp 未包含新 op**:
   - 错误: 在 char-gen-agent.ts 中使用 `add_character` 操作，但 StatePatchOp 联合类型中没有此项
   - 根因: 添加新操作时只改了使用方，忘了改类型定义方
   - 教训: 新增枚举/联合类型的成员时，要同步修改类型定义和使用方

5. **测试文件导入路径错误**:
   - 错误: 从 `./types` 导入 `CharGenRequest` / `CharGenAgentDeps` / `CharGenClient`，但这些类型定义在 `./char-gen-agent` 中
   - 根因: 写完 char-gen-agent.ts 后写测试，大脑默认"所有类型都在 types.ts"
   - 教训: 写测试前先确认每个类型的实际定义位置

6. **VERSION 号未及时更新**:
   - 错误: 新增 2 个模块后仍保持 VERSION = '3.0.0'
   - 教训: 模块级里程碑完成后应更新版本号
