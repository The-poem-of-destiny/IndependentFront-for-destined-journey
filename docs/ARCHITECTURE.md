# 《命定之诗》完整架构书

> v1.0 · 最后更新：2026-06-13
>
> 本文档是《命定之诗》项目的完整技术架构与世界观参考。
> 分为两大部分：**软件架构**（前端 / 后端 / 数据流）和 **世界观架构**（宇宙 / 规则 / 势力）。

---

# 第一部分：软件架构

## 一、系统全景

```
┌─────────────────────────────────────────────────────────────┐
│                        用 户 界 面                           │
│  index.html  /  React GameView  /  Vue Chat                  │
│  (SettingsModal · LorebookModal · PresetModal · VariablePanel)│
└──────────────────────┬──────────────────────────────────────┘
                       │  import
┌──────────────────────▼──────────────────────────────────────┐
│                Vanilla Store (sillytavern-store.ts)          │
│  响应式状态中心 · Observer 模式 · 单例                        │
│  lorebooks / presets / settings / chats / activeChat         │
└──────┬──────────────┬───────────────┬───────────────────────┘
       │              │               │
┌──────▼──────┐ ┌─────▼─────┐ ┌──────▼──────────────┐
│  数据库层    │ │  引擎层    │ │  API 通信层          │
│ database.ts │ │ (6 模块)   │ │ api-router.ts        │
│ Dexie/IDB   │ │            │ │ api-tools.ts         │
│ 4 张表      │ │            │ │ fetch → LLM 服务     │
└──────┬──────┘ └─────┬─────┘ └──────┬──────────────┘
       │              │               │
       └──────────────┼───────────────┘
                      │ 共享类型
┌─────────────────────▼───────────────────────────────────────┐
│                   types.ts (所有接口定义)                     │
│  Lorebook · LorebookEntry · ChatPreset · AppSettings         │
│  ChatSession · ChatMessage · ParsedTags · VarsPatch          │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**：引擎层是纯逻辑，不依赖任何 UI 框架。Store 层提供框架无关的响应式状态。UI 层消费 Store。

---

## 二、仓库结构

```
fated_poem_independent/
├── src/
│   ├── sillytavern/              ← 核心引擎（30+ 模块）
│   │   ├── types.ts              # 所有 TypeScript 类型 (~45 接口)
│   │   ├── database.ts           # Dexie/IndexedDB 持久化层 (10 表)
│   │   ├── agent-orchestrator.ts # Agent DAG 编排引擎 (5 Stage)
│   │   ├── agent-templates.ts    # 11 Agent Prompt 模板
│   │   ├── agent-client.ts       # API 客户端 (重试+缓存)
│   │   ├── state-manager.ts      # 唯一状态写入入口 (ADR-21)
│   │   ├── effect-parser.ts      # 中文→结构化 ParsedEffect
│   │   ├── effect-runtime.ts     # 声明式效果运行时 (6类型)
│   │   ├── game-event.ts         # EventBus 发布-订阅
│   │   ├── dice.ts               # 骰子系统
│   │   ├── script-executor.ts    # 脚本沙盒 ($event.on/off + $call + init/cleanup)
│   │   ├── subscription-manager.ts # 持久订阅管理 (递归保护+僵尸兜底)
│   │   ├── combat-resolver.ts    # $combat API + 8步伤害管线
│   │   ├── craft-resolver.ts     # $craft API (3阶段)
│   │   ├── char-gen-agent.ts     # 角色生成编排 (char_gen→item_gen)
│   │   ├── marker-protocol.ts    # XML 标记检测 (craft/combat/char)
│   │   ├── memory-store.ts       # 记忆存储 + Embedding 召回
│   │   ├── memory-summarizer.ts  # 记忆压缩
│   │   ├── plot-engine.ts        # 剧情引擎
│   │   ├── plot-outline.ts       # 剧情大纲
│   │   ├── tier-constants.ts     # 核心数值表 (T1-T7)
│   │   ├── bloodlines.ts         # 血脉系统 (23种族)
│   │   ├── location-db.ts        # 位置数据库 (10势力/32节点)
│   │   ├── char-query.ts         # 角色查询
│   │   ├── resource-calc.ts      # 资源计算
│   │   ├── time-system.ts        # 游戏时间系统
│   │   ├── worldbook-loader.ts   # 世界书条目匹配/注入（现役实现）
│   │   ├── variables.ts          # 变量提取+命名空间隔离
│   │   ├── vars-merger.ts        # VarsPatch 深合并
│   │   ├── ...                   # 还有更多模块
│   │   └── index.ts              # 统一导出入口
│   ├── ui/                       # Vue 3 前端 (10主题/16组件/4页面)
│   │   ├── main.ts / App.vue
│   │   ├── themes/ / stores/ / components/
│   │   └── styles/
├── docs/
│   ├── ARCHITECTURE.md           # 本文档
│   ├── phases/                   # Phase 计划
│   ├── planning/                 # 会话追踪
│   └── reference/                # 参考文档
├── CLAUDE.md                     # Claude Code 工作指导
├── package.json
├── tsconfig.json
├── reference/
│   ├── v4.2.1.png                # 角色卡图片
│   ├── v4.2.1_chara_card.json    # 角色卡 JSON
│   └── 命定之诗Kemini5-3.8.json  # 605 条世界规则
```

---

## 三、前端架构

### 3.1 UI 模式

系统支持两种 UI 模式，由 `AppSettings.uiMode` 控制：

| 模式     | 值     | 适用场景            | 核心组件                       |
| -------- | ------ | ------------------- | ------------------------------ |
| 聊天模式 | `chat` | 传统对话式 AI 交互  | 消息列表 + 输入框              |
| 游戏模式 | `game` | 文字 RPG 沉浸式体验 | 正文面板 + 选项列表 + 思考折叠 |

### 3.2 UI 组件树（以游戏模式为例）

```
App
├── GameView                          ← 游戏主界面（v3 React）
│   ├── MainTextPane                  ← <maintext> 正文流式显示
│   ├── ThinkingFold                  ← <thinking> 折叠/隐藏/内联
│   ├── OptionList                    ← <option> 选项列表（可点击/可自由输入）
│   ├── HistoryDrawer                 ← 历史楼层回溯（变量快照）
│   ├── EntryForm                     ← 底部自由输入框
│   └── 工具栏
│       ├── SettingsModal             ← 设置面板
│       │   ├── API 配置（主/次）
│       │   ├── UI 模式切换
│       │   ├── 标签集管理
│       │   └── 思考显示偏好
│       ├── LorebookModal             ← 世界书列表
│       │   └── LorebookEditorModal   ← 单书条目编辑器
│       │       └── EntryForm         ← 条目字段表单
│       ├── PresetModal               ← 预设管理（4个Tab）
│       │   ├── 采样参数
│       │   ├── Prompt 文本
│       │   ├── 自定义 Prompts
│       │   └── PromptOrderEditor     ← prompt_order 排序
│       ├── VariablesModal            ← 变量查看/编辑
│       └── ChatModal                 ← 多 Session 对话管理
```

### 3.3 状态管理（Vanilla Store）

不使用 Redux/Zustand/Pinia。自行实现的 Observer 模式 Store：

```
createSillytavernStore()
  ├── 内部可变状态（闭包私有）
  │   ├── lorebooks: Lorebook[]
  │   ├── presets: ChatPreset[]
  │   ├── settings: AppSettings | null
  │   ├── activeLorebookIds: string[]
  │   ├── chats: ChatSession[]
  │   └── activeChatId: string | null
  ├── 只读访问（getter 属性）
  │   └── store.lorebooks / store.activeChat / store.isSending ...
  ├── 异步操作
  │   ├── loadAll()          — 初始化 DB + 加载全部数据
  │   ├── sendMessage()      — 完整消息发送流程（核心方法）
  │   ├── createChat()       — 创建新对话
  │   ├── editMessage()      — 编辑历史消息并重新生成
  │   ├── deleteMessagesFrom() — 截断历史
  │   └── branchFromMessage() — 分支对话
  └── 观察者通知
      └── subscribe(cb) → unsubscribe
```

---

## 四、后端架构（Prompt & Agent）

### 4.1 Prompt 组装管线

这是系统的"后端大脑"——将用户输入 + 世界观上下文 + 游戏状态 → 组装成发给 LLM 的完整 Prompt。

```
用户输入 + 当前聊天历史
        │
┌───────▼──────────────────────────────────────────┐
│  Step 1: 世界书扫描 (worldbook-loader.ts)          │
│  ─────────────────────────────────────             │
│  · 对 [用户输入 + 最近3条历史] 进行关键词匹配        │
│  · 4 种选择性逻辑: and_any / not_all / not_any      │
│  · constant 条目始终包含                            │
│  · probability 概率掷骰                             │
│  · recursiveScan: 匹配内容可触发新一轮扫描 (max 3)   │
│  → 输出: WorldBookEntry[] (按 order 排序、去重)     │
└───────┬──────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────┐
│  Step 2: Prompt 组装 (agent-templates +          │
│           placeholder-registry + assemblePreset) │
│  ─────────────────────────────────────             │
│  · 按 preset.prompt_order 逐段构建系统消息           │
│  · worldInfoBefore / worldInfoAfter 位置注入世界书   │
│  · {{user}} {{char}} {{variable}} 宏替换           │
│  · 注入 [当前状态] 变量块                            │
│  · 追加 DEFAULT_FORMAT_PROMPT (XML 输出格式)        │
│  · 追加聊天历史 (截断至 ~80% max_context)            │
│  · 追加当前用户输入                                   │
│  → 输出: OpenAI-compatible messages[]               │
└───────┬──────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────┐
│  Step 3: API 路由 (api-router.ts)                  │
│  ─────────────────────────────────────             │
│  · 单 API 模式: 全部请求 → primary                  │
│  · 双 API 模式:                                     │
│    - story (剧情/选项) → primary                    │
│    - summary + vars → secondary (便宜模型)          │
│  · secondary 失败 → 自动 fallback primary            │
│  → 发送 fetch() 到 OpenAI-compatible endpoint       │
└───────┬──────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────┐
│  Step 4: 响应解析 (agent-client 内联 SSE +        │
│           story-output.ts)                        │
│  ─────────────────────────────────────             │
│  · 流式 XML 状态机解析 AI 回复                        │
│  · 提取 <maintext> <option> <sum> <vars> <thinking>│
│  · Opaque 标签 (thinking/think) 抑制内部误解析       │
│  · parseVarsBlock() → JSON 深合并到游戏变量         │
│  · 保存 AssistantMessage + 变量快照到 IndexedDB      │
└──────────────────────────────────────────────────┘
```

### 4.2 Agent 编排架构（Phase 3-6e 已实现）

已从"单次请求-响应"升级为多 Agent DAG 编排：

```
Stage 0:  memory_recall + plot_pre_check    (并行)
Stage 1:  story (+ craft_gen 阻塞注入)      (正文生成)
Stage 2:  vars_update (+ char_gen 异步)     (变量更新+角色生成)
Stage 3:  char_update (并行×N)              (角色状态更新)
Stage 4:  memory_summary                    (记忆压缩)
Stage 5:  plot_post_check                   (剧情后校验)
```

Agent 编排引擎: `agent-orchestrator.ts`

- 阶段串行 + 同阶段 Agent 并行
- 流程单向性: 上游输出 → context.agentOutputs → 下游读取
- 事件回调: onStageStart / onAgentStart / onAgentComplete / onAgentError
- Marker 回调: onCraftRequest / onCombatTrigger / onCharDetect
- 11 个 Agent 模板: `agent-templates.ts`

### 4.3 XML 输出契约

系统通过 `DEFAULT_FORMAT_PROMPT` 模板指令 LLM 按以下格式输出：

```xml
<thinking>思考过程（可选，内部不解析其他标签）</thinking>
<maintext>剧情正文，支持多行</maintext>
<option>选项A
选项B
选项C</option>
<sum>本回合一句话总结</sum>
<vars>{ "HP": 38, "金钱": +10 }</vars>
```

| 标签         | 必填 | 流式显示位置             | 说明                               |
| ------------ | ---- | ------------------------ | ---------------------------------- |
| `<thinking>` | 否   | ThinkingFold（默认折叠） | Opaque，内部 `<` 不会触发解析      |
| `<maintext>` | 是   | MainTextPane             | 正文区域，支持多行                 |
| `<option>`   | 是   | OptionList               | 每行一个选项，玩家可点选或自由输入 |
| `<sum>`      | 是   | 历史楼层列表             | 回合总结，用于回溯导航             |
| `<vars>`     | 否   | 不显示                   | JSON 格式，深合并到游戏变量        |

标签集可在 Settings 中自定义增删（必须保留 `maintext` 和 `option`）。

---

## 五、数据架构

### 5.1 持久化（IndexedDB / Dexie）

4 张表，全部以 `id` 为主键，`name` 和 `updatedAt` 为二级索引：

| 表          | 存储内容     | 关键字段                                               |
| ----------- | ------------ | ------------------------------------------------------ |
| `lorebooks` | 世界书       | entries[], recursiveScanning, caseSensitive            |
| `presets`   | 预设         | settings: Record<string,any>（SillyTavern 原始 JSON）  |
| `settings`  | 应用设置     | api, apiMode, uiMode, customTags, formatPromptTemplate |
| `chats`     | 聊天 Session | messages[], variables, characterName, presetId         |

**变量快照机制**：每条 `ChatMessage` 携带创建时的 `variables` 副本。这意味着：

- 回溯到历史楼层时，变量自动恢复到该时刻的值
- 删除后续消息时，变量回退到最后保留消息的快照
- 分支对话从分叉点的变量快照继续

### 5.2 数据流（一轮对话）

```
用户输入 "我要上前迎击"
        │
┌───────▼────────┐
│ Store.sendMessage()
│ · 创建 UserMessage (含当前变量快照)
│ · 追加到 activeChat.messages
└───────┬────────┘
        │
┌───────▼────────┐
│ assemblePrompt()
│ · scan 世界书 → 匹配条目
│ · 组装 system prompt (prompt_order)
│ · 注入变量块 + 格式模板
│ · 截断历史 → messages[]
└───────┬────────┘
        │
┌───────▼────────┐
│ apiRouter.call()
│ · 路由到 primary/secondary
│ · fetch → LLM
└───────┬────────┘
        │
┌───────▼────────┐
│ 响应处理
│ · agent-client 内联 SSE 解析 XML
│ · extractVariables (兼容 <var> 标签)
│ · mergeVariables → 新变量快照
│ · 创建 AssistantMessage
│ · saveChat() → IndexedDB
└───────┬────────┘
        │
┌───────▼────────┐
│ notify() → UI 重渲染
└────────────────┘
```

### 5.3 SillyTavern 兼容

内部格式与 SillyTavern 原始格式的差异由 `importer.ts` 处理（v3 世界书栈已退役，现由 `workshop-manifest.ts` / 工坊导入链承担）：

| 字段             | 内部格式                     | SillyTavern 格式 |
| ---------------- | ---------------------------- | ---------------- |
| `position`       | 字符串枚举 (`'before_char'`) | 数值 (0-7)       |
| `selectiveLogic` | 字符串枚举 (`'and_any'`)     | 数值 (0-3)       |
| `entry key`      | `string` (UUID)              | `number` (uid)   |

所有导入/导出通过工坊导入链（`workshop-manifest.ts` → `workshop-install-plan.ts`）转换。

---

## 六、已实现 & 待建设

| 模块              | 状态      | 实现                                                             |
| ----------------- | --------- | ---------------------------------------------------------------- |
| 多 Agent 协作     | ✅ 已完成 | `agent-orchestrator.ts` — 5 Stage DAG + 11 Agent                 |
| 记忆召回 Agent    | ✅ 已完成 | `memory-store.ts` + `memory-summarizer.ts` — Embedding 向量召回  |
| Schema-first 状态 | ✅ 已完成 | `types.ts` — ~45 接口/类型，所有状态结构强类型                   |
| 前端 UI (Vue 3)   | ✅ 已完成 | `src/ui/` — 10 主题/16 组件/4 页面/单URL架构                     |
| 流式输出          | ✅ 已完成 | `agent-client.ts` 内联 SSE 流式解析 + `story-output.ts`          |
| 脚本沙盒          | ✅ 已完成 | `script-executor.ts` — $event.on/off 持久订阅 + $call 跨对象引用 |
| 持久订阅管理      | ✅ 已完成 | `subscription-manager.ts` — init/cleanup 生命周期 + 递归保护     |
| 测试覆盖          | ✅ 已完成 | 53 files / 2171 tests — Vitest + fake-indexeddb                  |
| 登神长阶系统      | ⬜ 待建设 | AscensionAbility 统一类型 + $ascension API                       |
| 创意工坊前端      | ⬜ 待建设 | Phase 7f `/workshop`                                             |

---

