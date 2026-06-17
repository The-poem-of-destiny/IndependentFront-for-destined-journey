# Phase 4 规划 v2: 记忆系统 & 剧情规划

> **更新**: 根据主人反馈重新规划。核心改动：Embedding 记忆召回、剧情三模式、记忆压缩、大纲-自检-事件生成流程。

---

## 一、主人核心需求总结

### 1.1 记忆召回 → Embedding 方案
- ❌ 废弃：code 层关键词粗筛 → Agent 精选
- ✅ 新方案：Embedding 向量相似度检索
  - 候选模型：Qwen/Qwen3-VL-Embedding-8B（或其他 OpenAI 兼容 embedding 端点）
  - 存入记忆时计算 embedding，召回时用余弦相似度排序
  - 配置每轮最大返回条数（如 20 条），即使有 2000 条记忆上下文也不爆炸

### 1.2 记忆上限 → 不删除 + 压缩
- ❌ 废弃：超出上限删最低重要度
- ✅ 新方案：
  - **永不删除记忆**
  - 用 `maxMemoriesRecall` 限制每轮返回数量
  - **超过 100 轮后**：把前 100 轮的记忆压缩为一条「完整事件摘要」

### 1.3 剧情系统 → 三模式 + 大纲-自检-事件
- ❌ 废弃：简单的开局生成 + 每年追加
- ✅ 新方案：
  - **三种模式**：完全关闭 / 仅支线 / 主线
  - **仅支线**：每年生成一次，专注地区冲突，不过于宏大
  - **主线模式**：
    - 配置项：持续年份、是否引入世界书外 NPC、事件难度（层级）、剧情偏向（战斗/解密/人际/恋爱）、自定义偏好输入框
    - 流程：AI 生成大纲 → AI 自检精彩程度 → 确认 → 生成剧情事件
  - **剧情 AI 调用两次**：
    - **正文前**：固定设定 + 大纲 + 上轮正文/记忆/角色状态 → AI 判断召回/触发
    - **正文后**：固定设定 + 大纲 + 本轮正文/记忆/角色状态 → AI 判断世界线变动 → 修改大纲 → 修改剧情树

### 1.4 其他确认
- 世界线变动传播：保留（默认 2 层）
- 条件表达式：保留 EJS 语法
- 剧情事件完成/失败时自动生成关联记忆（重要度高）

---

## 二、新架构设计

### 2.1 数据模型新增

```typescript
// ===== 剧情大纲 =====
interface PlotOutline {
  id: string;
  saveId: string;
  mode: 'off' | 'side' | 'main';
  /** 大纲正文（AI 生成的叙事大纲） */
  content: string;
  /** 自检结果（AI 对大纲的评价） */
  selfCritique?: string;
  /** 是否已确认 */
  confirmed: boolean;
  /** 大纲版本号（每次世界线变动 +1） */
  version: number;
  /** 大纲覆盖的时间范围 */
  timeRange: { start: string; end: string };
  createdAt: number;
  updatedAt: number;
}

// ===== 剧情配置（存入 AppSettings） =====
interface PlotSettings {
  mode: 'off' | 'side' | 'main';
  /** 主线专属 */
  main?: {
    durationYears: number;          // 主线持续年份
    allowNonWorldbookNpc: boolean;  // 是否引入世界书外 NPC
    difficultyTier: number;         // 事件难度层级 (1-7, 对应生命层级)
    genrePreference: Array<'combat' | 'mystery' | 'social' | 'romance'>;
    customPreference: string;       // 自定义偏好输入框
  };
  /** 支线专属 */
  side?: {
    yearlyGeneration: boolean;      // 每年自动生成
    focusRegion: string;            // 专注区域（空=当前区域）
  };
}

// ===== 记忆 Embedding =====
// 存储在 MemoryRecord 中（新增字段）
// embedding: number[];  // 向量（维度取决于模型）
```

### 2.2 AppSettings 新增字段

```typescript
interface AppSettings {
  // ... 现有字段 ...

  // Phase 4 新增
  plotSettings: PlotSettings;           // 剧情模式配置
  embeddingEndpointId: string | null;   // Embedding 使用的 API 端点
  embeddingModel: string;               // Embedding 模型名
  embeddingDimension: number;           // 向量维度
  maxMemoriesRecall: number;            // 每轮最大召回记忆数 (默认 20)
  memoryCompressionThreshold: number;   // 多少轮后压缩旧记忆 (默认 100)
}
```

### 2.3 新管线顺序（更新后的 Agent DAG）

```
Stage 0: memory_recall  (Embedding召回) + plot_pre_check  (剧情触发检查)  ← 并行
Stage 1: story           (正文 AI)
Stage 2: vars_update     (变量更新)
Stage 3: char_update     (角色更新)
Stage 4: memory_summary  (记忆总结 + Embedding)
Stage 5: plot_post_check (剧情修正 + 大纲更新 + 世界线变动)
        ↓
  [异步] memory_compress  (每10轮检查一次，超过阈值则压缩旧记忆)
```

---

## 三、模块设计

### 3.1 `memory-store.ts` — 记忆召回引擎

**职责**: Embedding 向量检索 + 候选排序 + 压缩触发。

**流程**:
```
新记忆存入时:
  saveMemory()
      ↓
  [Code] 调用 embedding API → 获取向量
      ↓
  存入 MemoryRecord.embedding

每轮召回时:
  userInput
      ↓
  [Code] 调用 embedding API → 获取查询向量
      ↓
  [Code] 对所有 MemoryRecord.embedding 做余弦相似度
      ↓
  [Code] 取 top-K（K = maxMemoriesRecall, 默认 20）
      ↓
  注入 AgentContext.memories → story Agent 使用

每 10 轮检查:
  当前轮数 > memoryCompressionThreshold？
      ↓ Yes
  [Code] 将前 threshold 轮的旧记忆合并
      ↓
  [Prompt] 调用 memory_summary Agent → 压缩为单条「完整事件摘要」记忆
      ↓
  [Code] 删除被压缩的旧记忆，保留摘要记忆 + 重新计算 embedding
```

**待实现函数**:
- `computeEmbedding(text: string, endpoint: ApiEndpoint, model: string): Promise<number[]>`
- `cosineSimilarity(a: number[], b: number[]): number`
- `recallMemories(saveId: string, query: string, topK: number): Promise<MemoryRecord[]>`
- `compressOldMemories(saveId: string, threshold: number): Promise<void>`
- `getRoundCount(saveId: string): Promise<number>`

**可配置项**:
- `maxMemoriesRecall: number` — 默认 20
- `memoryCompressionThreshold: number` — 默认 100（轮）
- `compressionCheckInterval: number` — 默认 10（每 10 轮检查一次）

---

### 3.2 `memory-summarizer.ts` — 记忆总结引擎

**职责**: 每轮记忆总结 + 自动生成 MEM 编号 + Embedding 计算 + 持久化。

**流程**:
```
本轮 story 输出
    ↓
[Prompt] memory_summary Agent → 生成 MemoryRecord JSON
    ↓
[Code] 校验 content ≥ 200 字
[Code] 生成 MEM 编号（自增）
[Code] 补充 timeRange / saveId / realTimestamp
[Code] 调用 embedding API → 计算向量
    ↓
saveMemory() → IndexedDB
```

**待实现函数**:
- `generateMemoryId(saveId: string): Promise<string>` — MEM000001, MEM000002...
- `summarizeAndSave(...)` — 编排 memory_summary Agent + 校验 + embedding + 持久化

---

### 3.3 `plot-outline.ts` — 剧情大纲管理

**职责**: 大纲 CRUD + AI 生成 + AI 自检 + 事件树生成。

**流程**:
```
开局时 (mode = side | main):
  用户配置 (PlotSettings)
      ↓
  [Prompt] PlotOutlineAgent:
    Step 1: 生成剧情大纲
    Step 2: 深度思考大纲精彩程度 → 自检报告
    Step 3: 确认 → 输出大纲 JSON
      ↓
  [Code] 保存 PlotOutline (confirmed = true)
      ↓
  [Prompt] 基于大纲生成 PlotEvent[] 事件树
      ↓
  [Code] 解析 → 扁平化 → savePlotEvents()

每年 (mode = side):
  同上流程，但大纲范围限定为「本年度 + 地区冲突」

主线更新 (mode = main, 世界线变动时):
  读取当前 PlotOutline
      ↓
  [Prompt] 根据本轮变化修改大纲 (+ version++)
      ↓
  [Code] 保存新版本大纲
```

**待实现函数**:
- `generateOutline(saveId: string, settings: PlotSettings, character: CharacterState): Promise<PlotOutline>`
- `selfCritiqueOutline(outline: PlotOutline): Promise<PlotOutline>` — AI 自检
- `outlineToEvents(outline: PlotOutline, character: CharacterState): Promise<PlotEvent[]>`
- `updateOutline(outline: PlotOutline, storyContext: string): Promise<PlotOutline>` — 世界线变动更新

---

### 3.4 `plot-engine.ts` — 剧情运行时引擎

**职责**: 正文前触发检查 + 正文后世界线修正。一个模块，两个调用点。

**流程**:
```
=== 正文前 (plot_pre_check) ===
  userInput + 大纲 + 上轮情节 + 角色状态
      ↓
  [Prompt] plot_check Agent:
    "根据大纲和当前状况，判断需要触发哪些剧情事件、需要召回哪些剧情背景"
      ↓
  [Code] 将触发的 PlotEvent 注入 AgentContext.plotEvents
      ↓
  → story Agent 使用

=== 正文后 (plot_post_check) ===
  本轮 story 输出 + 大纲 + 角色状态
      ↓
  [Prompt] plot_correct Agent:
    "分析是否有世界线变动，判断是否需要修改大纲，修改剧情事件状态"
      ↓
  [Code] 应用状态变更
  [Code] 如有 worldLineChanged → 级联修正子事件
  [Code] 如大纲需修改 → 调用 updateOutline()
  [Code] 完成/失败事件 → 自动生成 MemoryRecord
      ↓
  savePlotEvents() + savePlotOutline()
```

**待实现函数**:
- `preCheckPlot(userInput, outline, context): Promise<PlotEvent[]>` — 正文前触发
- `postCheckPlot(storyOutput, outline, context): Promise<PlotCorrectionResult>` — 正文后修正
- `evaluateCondition(condition: string, variables: Record<string, any>): boolean` — EJS 条件
- `propagateWorldLineChange(events: PlotEvent[], changedId: string, depth: number): PlotEvent[]`
- `eventToMemory(event: PlotEvent): MemoryRecord` — 事件完成/失败 → 记忆

---

## 四、更新后的文件清单

```
src/sillytavern/
├── memory-store.ts            # Embedding 召回 + 压缩触发
├── memory-summarizer.ts       # 记忆总结 + MEM 编号 + embedding
├── plot-outline.ts            # 大纲管理（CRUD + AI生成 + 自检 + →事件树）
├── plot-engine.ts             # 剧情运行时（pre-check + post-check 合一）
│
├── memory-store.test.ts
├── memory-summarizer.test.ts
├── plot-outline.test.ts
└── plot-engine.test.ts
```

**修改现有文件**:
- `types.ts` — 新增 PlotOutline / PlotSettings / MemoryRecord.embedding
- `database.ts` — 新增 plot_outlines 表 + CRUD
- `agent-templates.ts` — 新增 plot_outline_agent 模板 + 更新现有 plot_check/plot_correct 模板
- `agent-orchestrator.ts` — 管线更新（Stage 0/5 调整）
- `AppSettings` — 新增 plotSettings / embeddingEndpointId 等

---

## 五、Agent Prompt 结构（按主人指定）

### 5.1 正文前 — plot_pre_check

```
[system]
# 固定设定（世界设定、角色设定、你的职责）
{worldSettings + characterInfo + agentRole}

# 剧情大纲
{PlotOutline.content}

[user]
# 上一轮的正文
{lastRoundStory}

# 相关记忆
{recalledMemories}

# 角色当前状态
{characterStates}

请分析当前状况，判断需要触发哪些剧情事件，以及需要召回哪些剧情背景信息。
```

### 5.2 正文后 — plot_post_check

```
[system]
# 固定设定（世界设定、角色设定、你的职责）
{worldSettings + characterInfo + agentRole}

# 剧情大纲
{PlotOutline.content}

[user]
# 本轮正文
{thisRoundStory}

# 相关记忆
{recalledMemories}

# 角色当前状态
{characterStates}

请分析:
1. 是否有世界线变动？
2. 是否需要修改剧情大纲？
3. 需要更新哪些剧情事件的状态？
```

---

## 六、实现顺序

| 步骤 | 内容 | 预估 |
|------|------|------|
| 1 | types.ts 新增类型（PlotOutline/PlotSettings/MemoryRecord.embedding） | 小 |
| 2 | database.ts 新增 plot_outlines 表 + CRUD | 小 |
| 3 | AppSettings 新增字段 + DEFAULT_SETTINGS 更新 | 小 |
| 4 | agent-templates.ts 新增/更新 3 个模板 | 中 |
| 5 | `memory-store.ts` — Embedding 召回 + 余弦相似度 | 中 |
| 6 | `memory-summarizer.ts` — 总结 + 编号 + embedding | 中 |
| 7 | `plot-outline.ts` — 大纲生成 + 自检 + →事件树 | 大 |
| 8 | `plot-engine.ts` — pre-check + post-check | 大 |
| 9 | agent-orchestrator.ts 管线更新 | 小 |
| 10 | 全部测试文件 | 中 |
| 11 | 编译 + 测试验证 | — |

---

*文档版本: v2*
*更新时间: 2026-06-13*
