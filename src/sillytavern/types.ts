/**
 * SillyTavern Web / 命定之诗 Fated Poem — Core Types
 *
 * v4: 多 Agent 引擎架构 — 新增角色/记忆/剧情/存档/Agent 管线类型
 */

import type { GameTime } from './time-system';
// type-only 循环安全：effect-types 反向 import 本文件的 AttributeName/DivinityLevel/DamageType 也是 type-only
import type { Modifier } from './effect-types';

// 音频子系统的接口/seam 类型拆分在 types-audio.ts（本文件已逾 800 行）。
// 从这里统一再导出，「types.ts 是唯一类型来源」这条 import 路径依然成立。
// 注意: 音频**数据模型**类型 (AudioTrack / AudioPlaylist / ...) 仍定义在本文件下方，
// 不在 types-audio.ts 里 —— 避免第二个真相来源。
export * from './types-audio';

// ========== World Book (Lorebook) Types (v3, deprecated) ==========
// Phase 8 用新 WorldBook 类型替代，旧 Lorebook/LorebookEntry 保留兼容导入

// ========== World Book Types (Phase 8) ==========

export type WorldBookPartition =
  | 'world_setting' // 世界设定 — 宇宙观/规则/层级/登神
  | 'race' // 种族 — 全部族血脉与特性
  | 'faction' // 势力 — 国家/城邦/政治实体
  | 'character' // 角色 — NPC/命定核心/人物卡
  | 'event' // 事件 — 剧情线/EJS 事件脚本
  | 'adventure_area' // 冒险区域 — 地下城/危险地带
  | 'monster_ecology' // 怪物生态 — 魔物/BOSS/生态链
  | 'industry' // 产业 — 经济/贸易/锻造/炼金/服务业
  | 'organization' // 组织 — 公会/商会/秘密结社
  | 'system_core' // 系统 — 命定核心/变量更新/数值公式
  | 'variable' // 变量 — 初始设定/变量规则/output_format
  | 'quick_feature' // 快捷功能 — 命运抽卡/盲盒/FP扩展
  | 'extra_setting' // 额外设定 — 数值表/战斗/制作/旅行/状态
  | 'cot' // COT — Chain-of-Thought 推理模板
  | 'dlc' // DLC — 可开关扩展内容
  | 'creative_workshop'; // 创意工坊 — 社区二创内容

export interface WorldBookEntry {
  uid: number; // 唯一标识（来自原版世界书 UID）
  name: string; // 条目名称（对应 ST 的 comment）
  content: string; // 注入正文
  enabled: boolean; // 开关（false 时该条目对所有 agent 都不注入）
  key: string[]; // 关键词
  keysecondary: string[]; // 辅助关键词
  selectiveLogic: 0 | 1 | 2 | 3; // AND_ANY / NOT_ALL / NOT_ANY / AND_ALL
  order: number; // 排序（越大越靠后）
  position: number; // 世界书内位置分组（ST 兼容保留）
  /**
   * 条目溯源（D14）—— 仅由安装/更新流程写入，正常编辑不碰。
   * 目前只有创意工坊一种来源；未来其它来源在此并列加字段，不改 WorldBookEntry 顶层形状。
   */
  extra?: {
    workshop?: {
      projectId: string;
      projectName: string;
      sourceUid: string | number; // 上游原始 uid，仅溯源
      sourceComment: string; // 上游 comment（= 本引擎的 name）
      sourceHash: string; // 安装时正文哈希 —— 供 D15 精确判定是否被改过
    };
  };
}

export interface WorldBook {
  id: string;
  name: string;
  partition: WorldBookPartition;
  description?: string;
  entries: WorldBookEntry[];
  builtIn?: boolean; // Phase 8: 项目内置世界书，禁止删除
  /**
   * 最后写入时间（v14 索引字段）。
   *
   * 可选是因为 `data/worldbooks/*.json` 里的内置书没有该字段——它由 worldbook-store
   * 在每次落库时盖戳。Dexie 索引容忍缺值行（该行不进 updatedAt 索引，主键查询不受影响）。
   */
  updatedAt?: number;
}

// ========== Creative Workshop Types (D13) ==========

/**
 * 一条处置记录的类别 —— **「丢了」和「装上了但会这样」不是一回事**。
 *
 * 首版把两者合流成一个 `string[]`，UI 统一按「N 项内容未导入」报数，于是一条
 * 装好了、也启用了、只是 `<script>` 不执行的正则，会被算进「未导入」——
 * 用户读到的是安装失败，实际内容装得好好的。类别就是为了让 UI 不再说这个谎。
 *
 * - `dropped` —— ST 字段在本引擎无对应物，**确实丢了**（`placement` / `minDepth`
 *   / `maxDepth` / `runOnEdit` / `substituteRegex` / `trimStrings`；`promptOnly`
 *   更是整条不产出规则）
 * - `degraded` —— **装了**，但渲染不完整（```` ``` ```` 围栏无渲染器、完整 HTML
 *   文档被解析器截断、`<script>` 在 v-html 里惰性、`{{...}}` 宏原样输出）
 * - `sideEffect` —— **装了**，且有**规则自身之外**的副作用（`<style>` 全局生效，
 *   可能覆盖应用主题 token）。单独成类是因为它是唯一会影响其它 UI 的，该最显眼。
 */
export type WorkshopNoteKind = 'dropped' | 'degraded' | 'sideEffect';

/** 带类别的处置记录 */
export interface WorkshopNote {
  kind: WorkshopNoteKind;
  text: string;
}

/**
 * 落库形态 —— **裸字符串是历史数据**。
 *
 * P1 首版把 `droppedNotes` 写成了 `string[]`，用户库里已经有这种行了。读侧一律
 * 经 `normalizeWorkshopNotes()` 归一（裸串按 `dropped` 处理，与旧文案语气一致），
 * 不做迁移脚本：这是纯展示字段，为它扫全表升级不划算，就地兼容即可。
 */
export type WorkshopNoteLike = string | WorkshopNote;

/**
 * 创意工坊项目元数据。
 *
 * 一个项目对应一本 `partition: 'creative_workshop'` 的 WorldBook（D7），
 * 本类型只承载 WorldBook 没有字段位的项目生命周期数据。
 * 上游 `project` 响应有 34 字段，此处只落自己要的 —— 原始响应不整包存库（否则即第二真相来源，违反铁律4）。
 */
export interface WorkshopProject {
  id: string; // 上游 uuid，跨版本稳定
  rootProjectId: string; // 版本族系根
  name: string;
  description: string;
  version: string; // 上游自由填，本引擎只做串比对不解析
  authorName: string; // authorGlobalName 优先，回退 authorName
  tags: string[]; // 仅展示与筛选，不参与 partition（D6）
  coverUrl?: string;
  downloadUrl: string;
  fileSize: number;

  // ===== 本地状态 =====
  installState: 'installed' | 'update_available' | 'broken';
  installedVersion: string;
  installedAt: number;
  fetchedAt: number; // 上次拉取上游元数据时间（TTL 判定）
  uidRange: { start: number; end: number };
  /**
   * 安装时的处置记录，供 UI 提示。
   *
   * ⚠️ 元素类型是 `string | WorkshopNote` 的联合而不只是 `WorkshopNote`：老行里
   * 存的是裸字符串（P1 首版），读侧必须过 `normalizeWorkshopNotes()`。新写入一律
   * 是结构化的。
   */
  droppedNotes?: WorkshopNoteLike[];
  /** 最后写入时间（v14 索引字段），每次落库盖戳 */
  updatedAt: number;
}

// ========== World Book (Lorebook) Types (v3, deprecated) ==========
// Phase 8 已迁移到 WorldBook / WorldBookEntry，以下类型保留供 ST 导入兼容

/** @deprecated Phase 8: 用 WorldBookEntry 替代 */
export interface LorebookEntry {
  id: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment?: string;
  order: number;
  /** SillyTavern position: 0=before_char, 1=after_char, 2=before_example(AN top), 3=after_example(AN bottom), 4=at_depth, 5=example_msg_top, 6=example_msg_bottom, 7=outlet */
  position:
    | 'before_char'
    | 'after_char'
    | 'before_example'
    | 'after_example'
    | 'at_depth'
    | 'example_msg_top'
    | 'example_msg_bottom'
    | 'outlet';
  depth?: number;
  role?: number;
  selective: boolean;
  /** 0=and_any(not_any?), 1=or(not_all?), actual SillyTavern has 4 logics but we normalize to and/or where possible */
  selectiveLogic: 'and_any' | 'not_all' | 'not_any' | 'and_all';
  constant: boolean;
  probability: number;
  useProbability?: boolean;
  addMemo: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  weight?: number;
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  useGroupScoring?: boolean;
  matchPersonaDescription?: boolean;
  matchCharacterDescription?: boolean;
  matchCharacterPersonality?: boolean;
  matchCharacterDepthPrompt?: boolean;
  matchScenario?: boolean;
  matchCreatorNotes?: boolean;
  group?: string;
  decorators?: string[];
  characterFilter?: {
    isExclude?: boolean;
    names?: string[];
    tags?: number[];
  };
}

/** @deprecated Phase 8: 用 WorldBook 替代 */
export interface Lorebook {
  id: string;
  name: string;
  description?: string;
  entries: LorebookEntry[];
  recursiveScanning: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SillyTavernLorebookExport {
  name: string;
  description?: string;
  entries: Record<
    string,
    {
      uid: number;
      key: string[];
      keysecondary: string[];
      comment: string;
      content: string;
      constant: boolean;
      selective: boolean;
      selectiveLogic: 0 | 1 | 2 | 3;
      addMemo: boolean;
      order: number;
      position: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      role: number;
      disable: boolean;
      probability: number;
      depth: number;
      group: string;
      useProbability: boolean;
      excluded: boolean;
      sticky: number;
      cooldown: number;
      delay: number;
      weight: number;
      scanDepth: number;
      caseSensitive: boolean;
      matchWholeWords: boolean;
      excludeRecursion: boolean;
      preventRecursion: boolean;
      useGroupScoring: boolean;
      matchPersonaDescription: boolean;
      matchCharacterDescription: boolean;
      matchCharacterPersonality: boolean;
      matchCharacterDepthPrompt: boolean;
      matchScenario: boolean;
      matchCreatorNotes: boolean;
      decorators: string[];
      characterFilter: {
        isExclude?: boolean;
        names?: string[];
        tags?: number[];
      };
    }
  >;
  settings?: {
    recursive_scanning?: boolean;
    case_sensitive?: boolean;
    match_whole_words?: boolean;
  };
}

export interface MatchedEntry {
  entry: LorebookEntry;
  score: number;
  matchedKeywords: string[];
}

// ========== Preset Types ==========

/** SillyTavern-compatible chat completion preset.
 *  `settings` stores the raw SillyTavern preset JSON (temp_openai, prompt_order, prompts, etc.)
 */
export interface ChatPreset {
  id: string;
  name: string;
  description?: string;
  /** Raw SillyTavern preset fields. For OpenAI presets this includes temp_openai, prompt_order, prompts, etc. */
  settings: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

// ========== Settings Types ==========

export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
  secondary?: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
}

// ========== v4 API 总控 & Agent 配置 ==========

/** 单个 API 端点定义 */
export interface ApiEndpoint {
  id: string; // UUID
  name: string; // 用户自定义名称，如 'DeepSeek主号'
  provider: string; // 'deepseek' | 'openai' | 'moonshot' | 'custom'
  baseUrl: string;
  apiKey: string; // 加密存储
  defaultModel: string;
  models: string[]; // 可用模型列表
  timeout: number;
  /** DeepSeek 思考模式：设 true 后所有走这个 endpoint 的请求都会开启 thinking */
  enableThinking?: boolean;
}

/** 单个 Agent 的配置 */
export interface AgentConfig {
  agentId: string; // 'story' | 'memory_recall' | 'plot_check' | 'request_dispatcher' | 'vars_update' | 'memory_summary' | 'plot_correct'
  enabled: boolean; // 是否启用
  apiEndpointId: string; // 指向 ApiEndpoint.id
  model: string; // 覆盖 endpoint 的默认 model
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  retryOnFail: boolean;
  timeout: number;
  userId: string; // DeepSeek 缓存隔离（自动生成）
  promptTemplate: {
    // Prompt 模板
    fixedSystem: string; // 前固定部分（缓存命中关键）
    fixedExamples: string; // Few-shot 示例
  };
  worldBookIds: string[]; // Phase 8: 该 Agent 挂载的世界书 ID 列表
  presetId?: string; // Phase 8: 该 Agent 使用的预设 ID
  /** 🆕 Agentic: 启用 OpenAI function calling（工具调用），默认 false */
  toolsEnabled?: boolean;
  /** 🆕 Agentic: 最大工具调用轮数，超限后强制输出（默认 5） */
  maxToolCallRounds?: number;
  /** 🆕 Agentic: 允许的工具 ID 列表（空=全部白名单） */
  allowedToolIds?: string[];
  /** 🆕 Phase 8.6: 历史对话注入层数（几轮 user+ai 对，0=不注入，不填=按 agent 类别默认） */
  historyLayers?: number;
  /** 🆕 Phase 8.6: 每条历史正文截断字数（不填=按 agent 类别默认，长正文 agent 默认更大） */
  historySlice?: number;
  /** 🆕 Phase 9: 覆盖模板中的 fixedSystem（agent-config.json 的 systemPrompt 字段）。
   * 如果设置了此字段，buildAgentMessages 将优先使用它，而不是模板中的 fixedSystem+fixedExamples。 */
  systemPrompt?: string;
  /** 🆕 Phase 10: Custom template string with {{PLACEHOLDER}} references.
   *  If not set, the default template from placeholder-registry.ts is used. */
  template?: string;
  /** 🆕 工坊 Phase 2 / ADR-30 D5: 该 Agent 的装配 pass 是否产出 EJS `vars` 差量提交候选。
   *  默认只有 story 持权（agent-config.json 置 true）；无权 pass 求值照常、草稿即弃。
   *  机制是逐 Agent 声明的前瞻设计——将来某工坊书需要「对特定 Agent 可见 + 持久状态机」时发权即可。 */
  ejsVarsCommit?: boolean;
  /** 🆕 Phase 7e: AbortSignal for external cancellation（用于 GamePipeline abort） */
  abortSignal?: AbortSignal;
  /** 🆕 Phase 7e: 流式回调 — 设置后编排器使用 chatStream() 替代 chat() */
  streamCallbacks?: import('./agent-client').StreamCallbacks;
}

// ========== Preset (Phase 8) ==========

/** Agent 预设 — 每个 Agent 的固定提示词（职责/思维链/格式） */
export interface AgentPreset {
  id: string;
  name: string;
  fixedSystem: string; // 固定系统提示词（缓存敏感）
  fixedExamples: string; // Few-shot 示例
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

/**
 * Agent Prompt 模板（运行时使用）
 * @deprecated Phase 10: Replaced by placeholder-based template system.
 *   fixedSystem/fixedExamples kept as fallback for agents without agent-config.json entries.
 *   variableContext/variableInstruction are no longer used.
 */
export interface AgentPromptTemplate {
  /** 固定部分（缓存敏感 — 不变则命中） */
  fixedSystem: string;
  fixedExamples: string;
  /** 可变部分（每轮变化 — 不影响缓存前缀）
   * @deprecated Use {{PLACEHOLDER}} template instead */
  variableContext: (ctx: AgentContext) => string;
  /** @deprecated Use {{PLACEHOLDER}} template instead */
  variableInstruction: (ctx: AgentContext) => string;
}

/** Phase 10: Placeholder resolver function signature */
export type PlaceholderResolver = (
  ctx: AgentContext,
  config: AgentConfig,
  params?: Record<string, string>,
) => string;

/** Phase 10: Local params injected by chain orchestrators (story→craft→item) */
export type LocalParams = Record<string, string>;

export interface PipelineStage {
  agents: string[]; // 本阶段运行的 Agent ID（同阶段可并行）
  waitFor: string[]; // 等待哪些 Agent 完成
}

export interface Pipeline {
  stages: PipelineStage[]; // 顺序执行的阶段
  timeout: number; // 整体超时 ms
  retryOnFail: boolean; // 失败重试策略
}

/** 默认 Agent 管线 (Phase 10 更新) */
export const DEFAULT_AGENT_PIPELINE: Pipeline = {
  timeout: 120000,
  retryOnFail: true,
  stages: [
    // Stage 0: 记忆召回 + 剧情触发检查（并行）
    { agents: ['memory_recall', 'plot_pre_check'], waitFor: [] },
    // Stage 1: 正文 AI
    { agents: ['story'], waitFor: ['memory_recall', 'plot_pre_check'] },
    // Stage 2: 请求调度（原 vars_update，判断新-vs-已有，分派 request 标签）
    { agents: ['request_dispatcher'], waitFor: ['story'] },
    // Stage 3: 变量更新（合并原 char_update + item_update，执行状态写入 + 可选环境效果 script）
    { agents: ['vars_update'], waitFor: ['story', 'request_dispatcher'] },
    // Stage 4: 记忆总结
    { agents: ['memory_summary'], waitFor: ['story'] },
    // Stage 5: 剧情修正 + 大纲更新 + 世界线变动
    { agents: ['plot_post_check'], waitFor: ['story', 'memory_summary'] },
  ],
};

// ========== 剧情设置 (Phase 4) ==========

/** 剧情配置 — 存入 AppSettings */
export interface PlotSettings {
  mode: 'off' | 'side' | 'main';
  /** 雷点 — 生成剧情大纲时的绝对禁区（所有模式通用，仅 plot_outline 生成/重写时注入；空串=无雷点） */
  tabooContent: string;
  /** 主线专属 */
  main?: {
    durationYears: number; // 主线持续年份
    allowNonWorldbookNpc: boolean; // 是否引入世界书外 NPC
    difficultyTier?: number; // 事件难度层级 (1-7, 对应生命层级; 不填=自适应)
    genrePreference: Array<
      | 'combat'
      | 'mystery'
      | 'social'
      | 'romance'
      | 'exploration'
      | 'politics'
      | 'survival'
      | 'tragedy'
    >;
    customPreference: string; // 自定义偏好输入框
    chapterCount?: number; // 章节数量（用户输入的数字，空=AI 自己判断）
    eventsPerChapter?: number; // 每章事件数（用户输入的数字，空=AI 自己判断）
  };
  /** 支线专属 */
  side?: {
    focusRegion: string; // 专注区域（空=当前区域）
    chapterCount?: number; // 章节数量（用户输入的数字，0=AI 自己判断）
    eventsPerChapter?: number; // 每章事件数（用户输入的数字，0=AI 自己判断）
  };
}

export const DEFAULT_PLOT_SETTINGS: PlotSettings = {
  mode: 'off',
  tabooContent: '',
};

// ========== 剧情大纲 (Phase 4) ==========

/** 剧情大纲 — AI 生成 + 自检 + 确认 */
export interface PlotOutline {
  id: string;
  saveId: string;
  mode: 'off' | 'side' | 'main';
  /** 大纲标题（AI 生成，如"血色纹章"）— PlotPanel 头部显示 */
  title: string;
  /** 一句话摘要（≤80字，防剧透层下的可见部分） */
  summary: string;
  /** 大纲正文（AI 生成的叙事大纲） */
  content: string;
  /** 大事件结构化存储（不再每次从 content 正则重新解析） */
  chapters: Array<{ title: string; summary: string; status: 'pending' | 'active' | 'completed' }>;
  /** 自检结果（AI 对大纲的评价） */
  selfCritique?: string;
  /** 是否已确认 */
  confirmed: boolean;
  /** 大纲版本号（每次世界线变动 +1） */
  version: number;
  /** 大纲覆盖的时间范围 */
  timeRange: { start: string; end: string };
  /** 大方向锚（核心张力 / 主角主题 / 关键关系人）— post_check 演化时的「不偏离」判据 */
  directionAnchors?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  key?: string;
  api: ApiSettings;
  /** 'single' = primary API handles all tasks. 'dual' = primary handles story, secondary handles variables. */
  apiMode: 'single' | 'dual';
  activePresetId: string | null;
  activeLorebookIds: string[];
  userName: string;
  characterName: string;
  theme: 'dark' | 'light';
  language: 'zh' | 'en';
  autoSave: boolean;
  autoSaveInterval: number;
  uiMode: 'game' | 'chat';
  customTags: string[];
  formatPromptTemplate: string;
  thinkingDisplay: 'fold' | 'hide' | 'inline';

  // ===== v4 新增字段 =====
  /** API 端点列表 */
  apiEndpoints: ApiEndpoint[];
  /** 每 Agent 的详细配置 */
  agentConfigs: AgentConfig[];
  /** 管线配置（可调整顺序和并行策略） */
  agentPipeline: Pipeline;
  /** 缓存策略 */
  cacheStrategy: 'disabled' | 'userid_isolated' | 'aggressive';
  /** 快照保留数上限 */
  maxSnapshotsPerSave: number;
  /** 快照保留模式：tiered=阶梯淘汰(最近5全留+旧层稀疏化) / dense=每轮都留(FIFO) */
  snapshotRetentionMode: 'tiered' | 'dense';
  /** 记忆召回上限 */
  maxMemoriesRecall: number;
  /** Phase 4: 剧情模式配置 */
  plotSettings: PlotSettings;
  /** Phase 4: Embedding 使用的 API 端点 ID */
  embeddingEndpointId: string | null;
  /** Phase 4: Embedding 模型名 */
  embeddingModel: string;
  /** Phase 4: 向量维度 */
  embeddingDimension: number;
  /** Phase 4: 多少轮后触发记忆压缩 (默认 100) */
  memoryCompressionThreshold: number;
  /** Phase 7e: 输出美化 */
  beautifierEnabled: boolean;
  /**
   * @deprecated Phase 0b: 用户规则的唯一真源已是 Dexie `beautifierRules` 表
   *   （入口 `src/ui/stores/beautifier-store.ts`）。本字段属于 v1–v3 遗留的死表
   *   `settings`，生产零读写，保留仅为不改 DEFAULT_SETTINGS 形状。
   *
   * 🔴 Phase 10i 曾并列的 `beautifierPresetRules` 已**删除**：内置 22 条预设规则
   *   （~378 KB）是 `loadPresetRules()` 从 data/defaults/beautifier-rules.json
   *   现算出来的派生缓存，给它任何持久化字段位都是制造第二真相来源。
   */
  beautifierRules: BeautifierRule[];
  /**
   * v3 M0：战斗引擎版本 feature flag（架构 §14.5）。
   * - `'v2'`（默认）：走现有 `combat-runner` + Agent 主持流程
   * - `'v3'`：走 `combat-v3` 内核主持流程
   * 分支点唯一（game-pipeline.handleCombatTrigger），粒度按整场战斗，
   * openCombat 时冻结进 CombatState.provenance 不可中途变更。
   * M5 已翻转为 `'v3'`（默认走 v3 内核）。打回 `'v2'` 仍可用（保留一个版本周期）。
   */
  combatEngineVersion: 'v2' | 'v3';
}

export const DEFAULT_FORMAT_PROMPT = `你必须严格按照以下 XML 标签格式输出回复，不要使用 Markdown 包裹：
<thinking>……</thinking>     ← 可选；内部任何字符都视为思考过程，不被解析
<maintext>……</maintext>     ← 必填；本回合的剧情正文，可多段，保留换行
<option>选项 A
选项 B
选项 C</option>              ← 必填；至少 2 项，每行一个
<sum>……</sum>               ← 必填；本回合一句话总结
<vars>{ "金钱": +10, "HP": 38 }</vars>   ← 选填；JSON 深合并`;

export const DEFAULT_TAGS = ['maintext', 'option', 'sum', 'vars', 'thinking', 'think'] as const;
export const DEFAULT_OPAQUE_TAGS = ['thinking', 'think'] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    timeout: 60000,
  },
  apiMode: 'single',
  activePresetId: null,
  activeLorebookIds: [],
  userName: '用户',
  characterName: 'AI',
  theme: 'dark',
  language: 'zh',
  autoSave: true,
  autoSaveInterval: 30,
  uiMode: 'game',
  customTags: ['maintext', 'option', 'sum', 'vars', 'thinking', 'think'],
  formatPromptTemplate: DEFAULT_FORMAT_PROMPT,
  thinkingDisplay: 'fold',
  // v4 新增
  apiEndpoints: [],
  agentConfigs: [],
  agentPipeline: DEFAULT_AGENT_PIPELINE,
  cacheStrategy: 'userid_isolated',
  maxSnapshotsPerSave: 30,
  snapshotRetentionMode: 'tiered',
  maxMemoriesRecall: 20,
  // Phase 4 新增
  plotSettings: DEFAULT_PLOT_SETTINGS,
  embeddingEndpointId: null,
  embeddingModel: 'Qwen/Qwen3-VL-Embedding-8B',
  embeddingDimension: 4096,
  memoryCompressionThreshold: 100,
  /** Phase 7e: 输出美化 */
  beautifierEnabled: true,
  beautifierRules: [],
  /** v3 M5: 战斗引擎版本（M5 翻为 v3 默认；打回 v2 仍可用，保留一个版本周期） */
  combatEngineVersion: 'v3',
};

// ========== Chat Types ==========

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** 🆕 Phase 10h: 消息所属存档 ID（持久化到 messages 表时设置） */
  saveId?: string;
  /** 🆕 Phase 10h: 消息轮次编号（持久化到 messages 表时设置） */
  turn?: number;
  /** 🆕 系统事件数据 — 仅 role='system' 时有值，供前端渲染卡片 */
  systemEvent?: SystemEvent;
}

// ========== Constants ==========

/** Common SillyTavern prompt_order identifiers used in OpenAI presets. */
export const DEFAULT_PROMPT_ORDER = [
  { identifier: 'main', name: 'Main Prompt', role: 'system' as const },
  { identifier: 'worldInfoBefore', name: 'World Info (Before)', role: 'system' as const },
  { identifier: 'charDescription', name: 'Character Description', role: 'system' as const },
  { identifier: 'charPersonality', name: 'Character Personality', role: 'system' as const },
  { identifier: 'scenario', name: 'Scenario', role: 'system' as const },
  { identifier: 'personaDescription', name: 'Persona Description', role: 'system' as const },
  { identifier: 'dialogueExamples', name: 'Dialogue Examples', role: 'system' as const },
  { identifier: 'chatHistory', name: 'Chat History', role: 'system' as const },
  { identifier: 'worldInfoAfter', name: 'World Info (After)', role: 'system' as const },
  { identifier: 'groupNudge', name: 'Group Nudge', role: 'system' as const },
];

export function createDefaultPreset(): Omit<ChatPreset, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '默认预设',
    description: 'SillyTavern 兼容的默认 OpenAI 预设',
    settings: {
      temp_openai: 0.8,
      freq_pen_openai: 0,
      pres_pen_openai: 0,
      top_p_openai: 0.9,
      top_k_openai: 0,
      top_a_openai: 0,
      min_p_openai: 0,
      repetition_penalty_openai: 1,
      openai_max_context: 4096,
      openai_max_tokens: 2048,
      stream_openai: false,
      max_context_unlocked: false,
      chat_completion_source: 'openai',
      openai_model: 'gpt-3.5-turbo',
      main: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
      nsfw: '',
      jailbreak: '',
      enhanceDefinitions: '',
      impersonation_prompt: '',
      new_chat_prompt: '',
      new_group_chat_prompt: '',
      new_example_chat_prompt: '',
      continue_nudge_prompt: '',
      wi_format: '',
      group_nudge_prompt: '',
      scenario_format: '',
      personality_format: '',
      prompts: [],
      prompt_order: DEFAULT_PROMPT_ORDER.map((p, i) => ({ ...p, enabled: true })),
    },
  };
}

// ========== v3 Game Mode Types ==========

export interface ParsedTags {
  thinking: string;
  maintext: string;
  options: string[];
  sum: string;
  varsRaw: string;
  varsCommands: VarsPatch;
  unknown: Record<string, string>;
}

/** 输出美化规则 — 正则替换管道 */
export interface BeautifierRule {
  id: string;
  name: string;
  scope: 'maintext' | 'options' | 'summary' | 'thinking' | 'global';
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
  order: number;
  isBuiltin: boolean;
  /** 自动启用绑定 — 匹配时规则自动 enable 且不可手动关 */
  autoEnable?: {
    /** 世界书 ID 集合（如 ['system_core']） */
    worldBookIds?: string[];
    /** 具体条目 UID（如 [413] 妲丽安核心） */
    worldBookEntryUids?: number[];
    /** 角色名集合（如 ['妲丽安']） */
    characterNames?: string[];
  };
  /** 分组标签 — UI 折叠区按来源分组 */
  group?: string;
  /** 🔒 系统自动管理标记（运行时计算，不持久化） */
  locked?: boolean;
}

/** 变量更新补丁 — 支持 mvu_update 协议的 replace/delta/insert */
export interface VarsPatch {
  /** 深合并到 chat.variables */
  merge: Record<string, any>;
  /** v4 新增: replace 操作 — 直接替换指定路径的值 */
  replace?: Array<{ path: string; value: any }>;
  /** v4 新增: delta 操作 — 对数值型变量做增量 */
  delta?: Array<{ path: string; amount: number }>;
  /** v4 新增: insert 操作 — 在数组指定位置插入 */
  insert?: Array<{ path: string; value: any; index?: number }>;
}

export type Task = 'story' | 'summary' | 'vars';
export type ApiTarget = 'primary' | 'secondary';

// ═══════════════════════════════════════════════════════════
// v4 新增类型 — 多 Agent 引擎架构
// ═══════════════════════════════════════════════════════════

// ========== 角色系统 (Character System) ==========

// M2: EquipmentSlot 接口已删除 — 装备不是独立实体，是物品的状态。
// 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）。

/** 技能 */
export interface Skill {
  /** @deprecated 逻辑键=name（规范铁律1）。M2 起引擎不再读写，M3 后翻译层不再生成，仅为旧存档数据兼容保留字段位 */
  id?: string;
  name: string;
  description: string;
  type: 'active' | 'passive';
  cost?: { type: 'HP' | 'MP' | 'SP'; amount: number };
  cooldown?: number; // 剩余冷却时间
  maxCooldown?: number;
  level?: number;
  /** 🆕 效果词条: 词条名→中文描述 (AI写, 前端展示) */
  effects?: Record<string, string>;
  /** 🆕 脚本注册表: 脚本名→可执行代码 (AI写, 引擎执行) */
  scripts?: Record<string, string>;
}

/** 背包物品 */
export interface InventoryItem {
  /** @deprecated 逻辑键=name（规范铁律1）。M2 起引擎不再读写，M3 后翻译层不再生成，仅为旧存档数据兼容保留字段位 */
  id?: string;
  name: string;
  description?: string;
  quantity: number;
  /** 🆕 穿戴槽位（EQUIP_SLOTS 枚举值）；null/undefined = 躺背包。装备不是独立实体，是物品的状态（规范 §3） */
  equippedSlot?: string | null;
  type?: string; // 'weapon' | 'armor' | 'consumable' | 'material' | 'quest'
  rarity?: '普通' | '优良' | '稀有' | '史诗' | '传说' | '神话' | '唯一';
  /** 🆕 M2: 装备数值加成（装备并入物品后归物品所有，规范 §3.1） */
  stats?: Record<string, number>;
  /** 🆕 M2: 当前耐久（规范 §3.1） */
  durability?: number;
  /** 🆕 M2: 最大耐久（规范 §3.1） */
  maxDurability?: number;
  data?: Record<string, any>;
  /** 🆕 效果词条: 词条名→中文描述 (AI写, 前端展示) */
  effects?: Record<string, string>;
  /** 🆕 脚本注册表: 脚本名→可执行代码 (AI写, 引擎执行) */
  scripts?: Record<string, string>;
  /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明（6 大类 modifier，来自 item_gen <modifiers> 子元素）。
   *  装备进入战斗时由 collect_mods event 收集，注入 8 步伤害管线（架构 §4.1） */
  modifiers?: Modifier[];
  /** 🆕 战斗 v2 (M4 5.5b): 该物品/装备附带的 buff 定义（由附加效果类 modifier 转 buff 或 AI 直接声明） */
  buffs?: StatusEffect[];
  /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（挂整件装备，缺省=0；§6.2 决策 d，冲突仲裁见 resolveDivinityConflict） */
  divinity?: DivinityLevel;
}

/** 状态效果 */
export interface StatusEffect {
  /** @deprecated 逻辑键=name（规范铁律1）。M2 起引擎不再读写，M3 后翻译层不再生成，仅为旧存档数据兼容保留字段位 */
  id?: string;
  name: string;
  description: string;
  category: '增益' | '减益' | '特殊'; // 世界书三分类
  stacks: number; // 层数
  /** 🆕 最大层数, undefined=无上限, 1 且 stackable=false=不可叠 */
  maxStacks?: number;
  /** 🆕 是否可叠加层数, 默认 true. false=永远1层 */
  stackable?: boolean;
  remainingTime: number | null; // 剩余时间, null=永久
  timeUnit: '回合' | '分钟' | '小时'; // 时间单位（战斗中=回合，脱战=分钟/小时）
  source: string; // 来源 [分类]-[施加者]; [解除方式]
  effects: Record<string, number>; // 效果数值化 (保留, 简单数值效果)
  /** 🆕 效果词条: 词条名→中文描述 (AI写, 前端展示) */
  effectDescriptions?: Record<string, string>;
  /** 🆕 脚本注册表: 脚本名→可执行代码 (AI写, 引擎执行) */
  scripts?: Record<string, string>;
  /** 🆕 施加时执行的脚本引用 */
  onApply?: string;
  /** 🆕 每回合/时间单位执行的脚本引用 */
  onTick?: string;
  /** 🆕 移除时执行的脚本引用 */
  onRemove?: string;
  /** 🆕 条件触发时执行的脚本引用 */
  onTrigger?: string;
  /** 🆕 M2: buff id 前缀 —— 施加该 buff 的物品/技能名（"幽怨之剑"）。
   *  buff id = sourceKey ? `${sourceKey}.${name}` : name。与 source 展示串正交（source 承载"[分类]-[施加者];[解除方式]"） */
  sourceKey?: string;
  /** 🆕 M2: 生命周期类型（对齐 [状态规则] 4 种）。缺省=按 timeUnit 推导（'回合'→战斗型；remainingTime=null→持续型） */
  lifecycle?: '战斗' | '持续' | '触发' | '条件';
  /** 🆕 M2: 登神等级（大部分 buff 无；缺省=普通 0）。神位级 buff 才带 */
  divinity?: DivinityLevel;
}

// ===== 登神长阶 (Ascension) 子类型 =====

/** 要素 (Lv.13-16, 上限3) */
export interface ElementDetail {
  name: string;
  description: string;
  effects: string[]; // 被动效果列表
  /** 🆕 Phase 9: 词条名→中文描述 (AI 编写, 前端展示, 与 Skill.effects 对齐) */
  effectDescriptions?: Record<string, string>;
  /** 🆕 Phase 9: 脚本注册表: lifecycle→JS code (AI 编写, 引擎执行, 与 Skill.scripts 对齐) */
  scripts?: Record<string, string>;
}

/** 权能 (Lv.17-20, 3要素→1权能) */
export interface AuthorityDetail {
  name: string;
  description: string;
  effects: string[];
  costDescription: string; // 消耗描述 (如 '25% 最大MP+SP+攻击+动作')
  /** 🆕 Phase 9: 词条名→中文描述 */
  effectDescriptions?: Record<string, string>;
  /** 🆕 Phase 9: 脚本注册表 */
  scripts?: Record<string, string>;
}

/** 法则 (Lv.21-24) */
export interface LawDetail {
  name: string;
  description: string;
  effects: string[];
  costDescription: string;
  /** 🆕 Phase 9: 词条名→中文描述 */
  effectDescriptions?: Record<string, string>;
  /** 🆕 Phase 9: 脚本注册表 */
  scripts?: Record<string, string>;
}

/** 统一角色状态 — NPC/主角/怪物/召唤物 共用 */
export interface CharacterState {
  // ===== 基础信息 =====
  id: string;
  /** 🆕 归属存档（一等字段，数据字段规范 铁律1/第1.2节；替代 customFields.saveId） */
  saveId: string;
  type: 'player' | 'npc' | 'monster' | 'summon';
  name: string;
  race: string;
  identity: string[]; // 身份标签
  occupation: string[]; // 职业标签

  // ===== 生命层级 =====
  tier: number; // 1-7
  tierName: string; // '普通' | '中坚' | '精英' | '史诗' | '传说' | '神话' | '神祗'
  level: number; // 1-25
  totalExp: number;
  expToNext: number;

  // ===== 五维属性 =====
  attributes: {
    str: number;
    dex: number;
    con: number;
    int: number;
    spi: number;
  };
  freeAttrPoints: number;

  // ===== 资源 =====
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;

  // ===== 登神长阶 (Lv.13+) =====
  ascension: {
    enabled: boolean; // 是否开启登神长阶
    elements: ElementDetail[]; // 要素 (Array, 有序, Phase 9: Record→Array)
    authority: AuthorityDetail[]; // 权能 (Array, 有序, Phase 9: Record→Array)
    law: LawDetail[]; // 法则 (Array, 有序, Phase 9: Record→Array)
    deityPosition: string; // 神位 (Lv.25)
    divineKingdom: {
      // 神国 (Lv.25巅峰)
      name: string;
      description: string;
    };
  };

  // ===== 装备/技能/背包 =====
  // M2: equipment[] 已删除 — 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）
  skills: Skill[];
  inventory: InventoryItem[];
  statusEffects: StatusEffect[];

  // ===== 经济 =====
  money: number; // G

  // ===== 位置 =====
  location: string; // 当前详细位置路径（地理）
  /** 是否在主角附近/同场景（在场）。true=可被叙事直接互动；false=离场/远处/退场。
   *  AI 通过 vars_update 在角色进场/离场时切换。严格 === true 判断。 */
  present: boolean;

  // ===== 冒险者等级 =====
  adventurerRank: string; // '未评级' | 'D' | 'C' | 'B' | 'A' | 'S'

  // ===== 当前行为 =====
  currentAction: string;

  // ===== 血脉 (Phase 5) =====
  /** 血脉 ID 列表 — AI 通过世界书演绎具体效果 */
  bloodlineIds?: string[];

  /** 🆕 怪物/召唤物集群数量（哥布林 ×3 = 一条记录）。仅 type='monster'|'summon' 使用，缺省 1（规范 §2.2） */
  quantity?: number;
  /** 🆕 外貌描述（从 customFields.physics/appearance 升正式字段，规范 §2.1） */
  appearance?: string;
  /** 🆕 背景故事（从 customFields.backstory/background 升正式字段） */
  background?: string;
  /** 🆕 性格（从 customFields.personality 升正式字段） */
  personality?: string;
  /** 🆕 性别（从 customFields.gender 升正式字段） */
  gender?: string;
  /** 🆕 服装（从 customFields.clothing/outfit 升正式字段） */
  outfit?: string;
  /** 🆕 心里话（从 customFields.thoughts 升正式字段，好感度系统的叙事侧数据） */
  thoughts?: string;

  // ===== 扩展字段 =====
  customFields: Record<string, any>;
}

/** 创建默认空角色状态 */
export function createDefaultCharacterState(
  overrides: Partial<CharacterState> = {},
): CharacterState {
  return {
    id: crypto.randomUUID(),
    saveId: '',
    type: 'npc',
    name: '',
    race: '人类',
    identity: [],
    occupation: [],
    tier: 1,
    tierName: '普通',
    level: 1,
    totalExp: 0,
    expToNext: 100,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    freeAttrPoints: 0,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    ascension: {
      enabled: false,
      elements: [],
      authority: [],
      law: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    skills: [],
    inventory: [],
    statusEffects: [],
    money: 0,
    location: '',
    present: true,
    adventurerRank: '未评级',
    currentAction: '',
    customFields: {},
    ...overrides,
  };
}

// ========== 角色卡导入格式 ==========

/** 可导入的角色卡格式 */
export interface CharacterCard {
  name: string;
  description: string;
  personality: string; // 五维编码 wOaGz(A)
  scenario: string;
  firstMes: string;
  mesExample: string;

  // SillyTavern 扩展
  spec: string;
  spec_version: string;
  data: {
    extensions: {
      regex_scripts?: any[]; // 前端脚本注入
    };
    character_book?: SillyTavernLorebookExport; // 角色专属世界书
  };

  // 引擎元数据
  _engine: {
    gameSettings: {
      initialLevel: number;
      initialAttributes: Record<string, number>;
      // M2: initialEquipment 改为带 equippedSlot 的物品（装备=物品的状态，规范 §3）
      initialEquipment: InventoryItem[];
      initialSkills: Skill[];
    };
    displayConfig: {
      avatar: string; // 头像 URL/base64
      theme: string; // 角色专属配色
    };
  };
}

// ========== 记忆系统 (Memory System) ==========

/** 记忆记录 — MEM00XXX 编号 */
export interface MemoryRecord {
  id: string; // 'MEM000001'
  saveId: string; // 所属存档
  createdAt: number; // 游戏时间戳
  realTimestamp: number; // 真实时间戳
  timeRange: {
    // 时间跨度
    start: string; // 游戏时间字符串
    end: string; // 游戏时间字符串
  };
  /** 正文 — 对 AI 可见，≥200 字 */
  content: string;
  /** 暗线 — 仅引擎使用，AI 不可见 */
  hiddenLine: string;
  /** 关键词索引（用于召回匹配） */
  keywords: string[];
  /** 关联的角色 ID */
  relatedCharacterIds: string[];
  /** 重要度 (0-10) */
  importance: number;
  /** Embedding 向量（Phase 4 — 用于语义召回，维度取决于 embedding 模型） */
  embedding?: number[];
}

// ========== 剧情系统 (Plot System) ==========

/** 嵌套剧情事件 — 扁平存储，childrenIds 引用 */
export interface PlotEvent {
  id: string;
  saveId: string;
  title: string;
  description: string;
  /** 事件状态 */
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  /** 触发条件（世界演化/收束条件的自然语言提示） */
  triggerCondition?: string;
  /** 完成条件（世界演化/收束条件的自然语言提示） */
  completeCondition?: string;
  /** 失败条件（世界演化/收束条件的自然语言提示） */
  failCondition?: string;
  /** 时间范围 */
  timeWindow?: { start: string; end: string };
  /** 子事件 ID 列表（扁平存储，运行时通过 resolvePlotTree() 重建嵌套树） */
  childrenIds: string[];
  /** 父事件 ID */
  parentId?: string;
  /** 排序权重 */
  order: number;
  /** 关联角色 */
  relatedCharacterIds: string[];
  /** 关联地点 */
  location?: string;
  /** 世界线变动标记 */
  worldLineChanged: boolean;
  /** 玩家可见性: hidden=未揭示(面板不显示) / revealed=已揭示（pre_check 触发时翻转） */
  visibility: 'hidden' | 'revealed';
  /** 所属大事件标题（逻辑键=名字，铁律1） */
  chapterTitle?: string;
  /** 此大事件涉及的关键 NPC 议程（去中心化行动线索，自然语言多议程描述；主要 depth 0 大事件用） */
  npcAgendas?: string;
  /** 主角不介入时，该态势的世界默认演化（反事实基线；主要 depth 0 大事件用） */
  ifAbsent?: string;
  /** 剧情层级深度 */
  depth: number;
  createdAt: number;
  updatedAt: number;
}

/** 运行时剧情树节点 — 嵌套结构 */
export interface PlotEventNode extends Omit<PlotEvent, 'childrenIds'> {
  children: PlotEventNode[];
}

/** 将扁平 PlotEvent 列表重建为嵌套树 */
export function resolvePlotTree(flatEvents: PlotEvent[]): PlotEventNode[] {
  const map = new Map<string, PlotEventNode>();
  const roots: PlotEventNode[] = [];

  for (const e of flatEvents) {
    const { childrenIds, ...rest } = e;
    map.set(e.id, { ...rest, children: [] });
  }
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by order
  const sortChildren = (nodes: PlotEventNode[]) => {
    nodes.sort((a, b) => a.order - b.order);
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);
  return roots;
}

// ========== 存档系统 (Save System) ==========

/** 快照 — 存档内的状态检查点（M5 规范 §11.2: 打快照 = 整份深拷贝 / 恢复 = 覆写 + 对话回滚） */
export interface Snapshot {
  /** Code 生成 UUID */
  id: string;
  /** 所属存档（一等字段） */
  saveId: string;
  /** 现实时间戳 */
  createdAt: number;
  /** 触发原因: turn=每轮一拍 / manual=手动 / pre-combat=战斗前 */
  reason: 'turn' | 'manual' | 'pre-combat';
  /** 对话回合游标（恢复时截断 messages 用） */
  turn: number;
  /** 角色状态深拷贝 */
  characters: CharacterState[];
  /** 存档档案深拷贝（任务/时间/好感/变量随行） */
  saveProfile: SaveProfile;
  /** 剧情事件深拷贝（🆕 回退时覆写恢复；可选=兼容旧快照，恢复时空数组兜底） */
  plotEvents?: PlotEvent[];
}

/** 存档槽 — 10 槽，快照上限见 AppSettings.maxSnapshotsPerSave */
export interface SaveSlot {
  id: string;
  name: string;
  slot: number; // 0-9
  createdAt: number;
  updatedAt: number;
  /** 当前活跃快照 ID（指向 snapshots 表记录；恢复机制 M5 重建） */
  activeSnapshotId: string | null;
  /** 存档级元数据 */
  metadata: {
    characterName: string;
    userName: string;
    gameStartTime: string;
    totalTurns: number;
    /** Phase 10h: 存档级启用的世界书条目 ID (如 'system_core:408', 'character:313') */
    enabledWorldBookEntries?: string[];
    /** Phase 10h: 创角时的开场提示词文本 */
    openingPrompt?: string;
    /** Phase 10h: 开场 Prompt 是否已发送给 AI */
    openingPromptConsumed?: boolean;
  };
}

// ========== Agent 编排引擎 (Agent Orchestration) ==========

// ═══════════════════════════════════════════════════════════
// Agentic Tool Calling Types (Phase 8.5)
// ═══════════════════════════════════════════════════════════

/** OpenAI 兼容的函数定义（工具 schema） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>; // JSON Schema 对象
  };
}

/** AI 响应中的单次工具调用 */
export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded arguments string
  };
}

/** 工具执行结果 */
export interface ToolCallResult {
  toolCallId: string;
  functionName: string;
  result: any; // 工具返回的原始值
  error?: string; // 执行失败时的错误消息
}

/** 工具执行所需的运行时上下文（非纯函数工具需要） */
export interface ToolExecutionContext {
  characters: CharacterState[];
  variables: Record<string, any>;
  saveId: string;
}

/** Agent 定义 */
export interface AgentDefinition {
  id: string; // 'story' | 'memory_recall' | 'plot_check' | ...
  name: string; // 显示名
  description: string; // 职责描述
  model: string; // 'deepseek-chat' | 'deepseek-reasoner'
  temperature: number;
  maxTokens: number;
  userId: string; // DeepSeek 缓存隔离 key
  dependsOn: string[]; // 依赖的 Agent ID 列表
  systemPrompt: {
    fixed: string; // 前固定部分（缓存命中关键）
    variable: (ctx: AgentContext) => string; // 后可变部分
  };
  outputSchema?: object; // 输出 JSON Schema (用于 function calling)
}

// ═══════════════════════════════════════════════════════════
// Phase 8 — Variable Zone 可见性系统
// ═══════════════════════════════════════════════════════════

/** Variable Zone 可见性级别 */
export type VisibilityLevel = 'FULL' | 'NARRATIVE' | 'SUMMARY' | 'KEYS' | 'NONE';

/** 8 个 Zone ID */
export type ZoneId =
  'memory' | 'npc' | 'world' | 'quest' | 'craft' | 'combat' | 'outline' | 'variable';

/** Zone 注入行为配置 */
export interface ZoneConfig {
  orderBy?: string; // 注入排序字段
  limit?: number; // 注入截断上限
  injectAs?: 'json' | 'list' | 'table' | 'summary';
}

/** 单个 Variable Zone — 三层自描述容器 */
export interface VariableZone {
  config: ZoneConfig;
  visibility: string[]; // Agent ID 可见白名单
  content: Record<string, any>;
}

/** Per-Agent 的 Zone 可见性矩阵 */
export interface ZoneVisibilityMatrix {
  memory: VisibilityLevel;
  npc: VisibilityLevel;
  world: VisibilityLevel;
  quest: VisibilityLevel;
  craft: VisibilityLevel;
  combat: VisibilityLevel;
  outline: VisibilityLevel;
  variable: VisibilityLevel;
}

/** Agent 运行上下文 */
export interface AgentContext {
  userInput: string;
  history: ChatMessage[];
  /** @deprecated Phase 8: 用 worldBooks 替代 */
  lorebookMatches: MatchedEntry[];
  worldBooks: WorldBookEntry[]; // Phase 8: 本 Agent 可见的世界书条目
  characters: CharacterState[];
  variables: Record<string, any>;
  plotEvents: PlotEvent[];
  memories: MemoryRecord[];
  /** 用户任务列表 (Phase 10g) */
  quests?: Record<string, Quest>;
  agentOutputs: Map<string, any>; // 上游 Agent 的输出

  // --- Phase 10: Plot mode ---
  /** 剧情模式配置（用于 orchestrator 决定是否跳过 plot_* agent） */
  plotSettings?: PlotSettings;

  // --- Phase 8: Variable Zone 可见性系统 ---
  /** 8-zone 变量区（由 buildZoneContext() 组装） */
  zones?: Record<ZoneId, VariableZone>;
  /** per-call 过滤 — vars_update 并行时指定当前目标角色 ID */
  targetCharacterId?: string;

  // --- Phase 8.6: per-Agent 可调上下文（由 buildAgentMessages 注入，读 AgentConfig） ---
  /** 当前 Agent 的配置（含 historyLayers/historySlice 等），模板函数借此读 per-agent 设置 */
  agentConfig?: AgentConfig;

  /** 存档级游戏时间（供 memory_summary 等 Agent 注入时间上下文） */
  gameTime?: GameTime;

  // --- 工坊 Phase 2 / ADR-30: 世界书 EJS 求值两轴 ---
  /**
   * 轴①`stats` 只读面快照（`buildStatData()` 产出）。
   * 每回合在 game-pipeline 构建一次，同回合多 Agent 复用；
   * 每个装配 pass 再克隆一份进 `ejsPass.stats`，杜绝跨 pass 写泄漏（设计 D4/D9）。
   */
  statData?: Record<string, any>;
  /**
   * 轴②`vars` 草稿暂存 —— **仅持 `ejsVarsCommit` 权的 Agent** 的 pass 会写入本表（keyed by agentId）。
   *
   * 容器由 game-pipeline 创建（`new Map()`），`buildAgentMessages` 每 pass 往里 set；
   * `draft` 与该 pass `ejsPass.vars` 是**同一对象引用** —— EJS 求值写入后这里拿到的就是最终态。
   * `base` 是 pass 开始时的独立克隆，供回合结算做深 diff（消费方见 T6/game-pipeline，本表只负责运输）。
   */
  ejsVarsDrafts?: Map<string, { base: Record<string, any>; draft: Record<string, any> }>;
  /**
   * 本次装配 pass 的 EJS 求值上下文 —— 由 `buildAgentMessages` 构造并挂在**浅拷贝** tplCtx 上，
   * 供 `{{LORE_BOOK}}` resolver / `buildFallbackMessages` 消费。形状对齐 `ejs-runtime` 的 `EjsEvalContext`。
   * 缺席（外部直接调 resolver 等极端路径）时调用方退化为一次性空草稿。
   */
  ejsPass?: {
    stats: Record<string, any>;
    vars: Record<string, any>;
    historyText: string;
    /**
     * pass 级 `{{LORE_BOOK}}` 渲染 memo（**由 resolver 自己填写**，其他人只读）。
     *
     * 为什么必须有：D7 明文支持把 `{{LORE_BOOK:section=static}}` 与 `:section=dynamic`
     * 拆到模板两处 —— 同一 pass 里 resolver 就会被调用两次。EJS 条目**不保证幂等**
     * （`setMessageVar("计数", 计数+1)` 这类写法在语料里合法），重复求值会让写翻倍落库。
     * 故首次求值后把整份结果缓存在本 pass 上，后续出现只挑段、不再求值。
     *
     * `agentId` 是自校验：ejsPass 本就是 per-pass 新建（天然按 Agent 隔离），
     * 万一将来有人复用同一个 ejsPass 跨 Agent，这个字段会让 memo 失效而不是串味。
     */
    loreRender?: {
      agentId: string;
      staticText: string;
      dynamicText: string;
      fallbackEntries: Array<{ uid: number; error: string }>;
    };
  };
}

/** 单个 Agent 的运行结果 */
export interface AgentResult {
  agentId: string;
  output: any; // 解析后的输出
  rawResponse: string;
  /** 🆕 DeepSeek 思考模式 — 思维链内容 */
  reasoning?: string;
  tokensUsed: number;
  cacheHit: boolean; // DeepSeek 缓存命中
  /** 🆕 命中缓存的 prompt token 数（usage.prompt_cache_hit_tokens） */
  cacheHitTokens?: number;
  /** 🆕 未命中缓存的 prompt token 数（usage.prompt_cache_miss_tokens，缺失当 0） */
  cacheMissTokens?: number;
  /** 🆕 输出 token 数（usage.completion_tokens） */
  completionTokens?: number;
  duration: number; // ms
  error?: string;
  /** 🆕 Agentic: 本 Agent 产生的所有工具调用记录 */
  toolCalls?: Array<{ name: string; arguments: any; result: any }>;
  /** 🆕 Debug: 发送给 AI 的完整请求消息（含系统提示词+上下文），用于调试面板导出 */
  requestMessages?: Array<{ role: string; content: string | null }>;
}

/** 编排器运行记录 */
export interface OrchestratorRun {
  id: string;
  pipeline: Pipeline;
  context: AgentContext;
  startedAt: number;
  completedStages: string[];
  currentStage: string | null;
  agentResults: Map<string, AgentResult>;
  status: 'idle' | 'running' | 'completed' | 'failed';
}

// ═══════════════════════════════════════════════════════════
// Phase 4.5 — 事件系统基础设施 (GameEvent + StateManager)
// ═══════════════════════════════════════════════════════════

// ========== GameEvent ==========

/** 游戏事件类型 */
export type GameEventType =
  | 'character_action'
  | 'combat_action'
  | 'craft_action'
  | 'status_effect'
  | 'variable_change'
  | 'plot_trigger'
  | 'item_use'
  | 'skill_use'
  | 'location_change'
  | 'quest_update'
  | 'system';

/** 游戏事件 — 结构化的事件记录 */
export interface GameEvent {
  id: string;
  type: GameEventType;
  /** 事件来源: Agent ID 或 'system' */
  source: string;
  timestamp: number;
  /** 游戏内时间戳 */
  gameTime?: string;
  /** 事件数据负载 */
  data: Record<string, any>;
  /** 是否已被处理 */
  processed: boolean;
  /** 处理结果 */
  result?: EffectResult[];
}

// ========== StatePatch ==========

/** 状态变更操作类型 */
export type StatePatchOp =
  | 'set_variable'
  | 'delta_variable'
  | 'add_character'
  | 'update_character'
  // M2: 按名寻址角色 ops (规范章节: characters §2)
  | 'remove_character' // 删除角色（按名）— 死亡/离场清理 (规范 §2)
  | 'rename_character' // 角色改名 — 逻辑键=名字，改名需专用 op 迁移键 (规范 §2)
  | 'add_status_effect'
  | 'remove_status_effect'
  | 'add_item'
  | 'remove_item'
  // M2: 按名寻址物品 ops (规范章节: items §3)
  | 'update_item' // 更新物品字段（按名）— 描述/词条/耐久等 (规范 §3)
  | 'transfer_item' // 物品转移（按名）— 角色间背包移动 (规范 §3)
  | 'equip_item'
  | 'unequip_item'
  | 'add_skill'
  | 'update_skill'
  // M2: 按名寻址技能 ops (规范章节: skills §4)
  | 'remove_skill' // 删除技能（按名）— 遗忘/替换 (规范 §4)
  | 'set_location'
  | 'set_hp'
  | 'set_mp'
  | 'set_sp'
  | 'delta_hp'
  | 'delta_mp'
  | 'delta_sp'
  | 'add_memory'
  | 'update_plot_event'
  // Phase 4.6: RFC 6902 JSON Patch ops
  | 'remove_variable'
  | 'move_variable'
  | 'insert_variable'
  // Phase 10g: Quest ops
  | 'update_quest'
  | 'remove_quest'
  // M2: 好感度/新闻 ops (规范章节: affections §7 / news §8)
  | 'set_affection' // 设置好感度绝对值（按角色名） (规范 §7)
  | 'delta_affection' // 好感度增量（按角色名） (规范 §7)
  | 'add_news'; // 追加世界新闻条目 (规范 §8)

/** 原子状态补丁 — StateManager 的唯一输入格式 */
export interface StatePatch {
  op: StatePatchOp;
  /** 目标路径: 'characters.<名字>' | 'variables.<path>' | 'plotEvents.<id>' */
  target: string;
  value?: any;
  amount?: number;
  metadata?: Record<string, any>;
}

/** StateManager.commitChatState() 的返回结果 */
export interface StateCommitResult {
  success: boolean;
  patchesApplied: number;
  eventsGenerated: GameEvent[];
  /** M5 起 commitChatState 不再产快照（#28），字段保留供未来快照类操作回传 */
  snapshotId?: string;
  errors: string[];
}

// ========== Effect System ==========

/** 效果定义类型 */
export type EffectType =
  | 'vars_patch'
  | 'status_effect'
  | 'character_update'
  | 'dice_roll'
  | 'item_effect'
  | 'skill_effect';

/** 声明式效果定义 */
export interface EffectDefinition {
  id: string;
  type: EffectType;
  /** 效果来源: agent | system | resolver */
  source: 'agent' | 'system' | 'resolver';
  /** 效果负载（声明式） */
  payload:
    | VarsPatch
    | StatusEffectPayload
    | CharacterUpdatePayload
    | DiceRollPayload
    | ItemEffectPayload
    | SkillEffectPayload;
  /** 优先级（低→高执行） */
  priority: number;
  /** 执行条件（EJS 表达式） */
  condition?: string;
  /** 关联的事件 ID */
  relatedEventId?: string;
}

/** 效果执行结果 */
export interface EffectResult {
  effectId: string;
  success: boolean;
  /** 此效果产生的 StatePatch */
  patches: StatePatch[];
  /** 连锁触发的子效果 */
  childEffects: EffectDefinition[];
  error?: string;
  duration: number; // ms
}

// ========== Effect Payload Types ==========

/** StatusEffect 效果负载 */
export interface StatusEffectPayload {
  action: 'add' | 'remove' | 'update';
  targetCharacterId: string;
  effect: {
    name: string;
    description: string;
    stacks: number;
    remainingTime: number;
    source: string;
    effects: Record<string, number>;
  };
}

/** 角色更新效果负载 */
export interface CharacterUpdatePayload {
  characterId: string;
  changes: Partial<{
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    sp: number;
    maxSp: number;
    level: number;
    tier: number;
    exp: number;
    attributes: Record<string, number>;
    location: string;
    statusEffects: StatusEffect[];
    skills: Skill[];
    inventory: InventoryItem[];
    money: number;
    currentAction: string;
  }>;
}

/** 骰子效果负载 */
export interface DiceRollPayload {
  formula: string; // 'd20' | '2d6+3' | 'd100'
  advantage?: boolean; // 优势
  disadvantage?: boolean; // 劣势
  modifier?: number; // 加值
  reason?: string; // 掷骰原因
  targetDC?: number; // 目标 DC（用于判定成功/失败）
}

/** 物品效果负载 */
export interface ItemEffectPayload {
  action: 'use' | 'equip' | 'unequip' | 'drop' | 'transfer';
  characterId: string;
  itemId: string;
  quantity?: number;
}

/** 技能效果负载 */
export interface SkillEffectPayload {
  action: 'use' | 'learn' | 'forget';
  characterId: string;
  skillId: string;
  targetId?: string; // 技能目标
}

// ========== Dice System (Layer 2) ==========

/** 骰子投掷结果 */
export interface DiceRollResult {
  formula: string;
  rolls: number[]; // 每次投掷的结果
  total: number; // 总和
  modifier: number;
  advantage: boolean;
  disadvantage: boolean;
  criticalSuccess: boolean; // 大成功 (如 d20=20)
  criticalFailure: boolean; // 大失败 (如 d20=1)
  meetsDC?: boolean; // 是否达到目标 DC
  description: string; // 人类可读描述
}

// ========== Resource Calculator (Layer 2) ==========

/** 资源计算结果 */
export interface ResourceQuery {
  characterId: string;
  query:
    | 'hp_percent'
    | 'mp_percent'
    | 'sp_percent'
    | 'tier'
    | 'level'
    | 'stat'
    | 'can_afford'
    | 'has_item'
    | 'has_skill'
    | 'has_status';
  params?: Record<string, any>;
}

/** 资源查询结果 */
export interface ResourceResult {
  characterId: string;
  query: string;
  value: number | boolean | string;
  description: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════
// Phase 6a — Combat System Types (对齐世界书 #837805 [战斗协议])
// ═══════════════════════════════════════════════════════════

// ========== Combat Types (世界书: 6 种) ==========

/** 战斗类型 — 影响士气阈值和集群行为 */
export type CombatType = '切磋' | '竞技' | '压制' | '死斗' | '标准' | '守卫';

/** 各战斗类型的士气溃败阈值 */
export const COMBAT_TYPE_MORALE_THRESHOLDS: Record<CombatType, number> = {
  切磋: 0.4,
  竞技: 0.3,
  压制: 0.5,
  死斗: 0.1,
  标准: 0.3,
  守卫: 0.35,
};

// ========== Damage Types (世界书: 4 种伤害类型) ==========

/** 4 种伤害类型 */
export type DamageType = '物理' | '能量' | '精神' | '真实';

/** 伤害类型 → 属性减免公式映射 */
export const DAMAGE_TYPE_FORMULAS: Record<DamageType, string> = {
  物理: '(最终体质+最终力量+最终敏捷)×0.25%',
  能量: '(最终精神+最终智力)×0.4%',
  精神: '最终精神×0.8%',
  真实: '0 (真实伤害无视所有减免)',
};

// ========== Hit Rating (世界书: 7 级命中评级) ==========

/** 命中评级 — 基于检定总值 (d20 + 命中 - 闪避) */
export interface HitRating {
  level: string; // '超暴击' | '强暴击' | '暴击' | '有效' | '勉强' | '擦伤' | '失手'
  coefficient: number; // 伤害倍率
  minCheckValue: number; // 最低检定总值
  triggersStatus: boolean; // 是否触发状态效果
}

/** 7 级命中评级表 (对齐世界书) */
export const HIT_RATINGS: HitRating[] = [
  { level: '超暴击', coefficient: 2.0, minCheckValue: 30, triggersStatus: true },
  { level: '强暴击', coefficient: 1.6, minCheckValue: 25, triggersStatus: true },
  { level: '暴击', coefficient: 1.3, minCheckValue: 20, triggersStatus: true },
  { level: '有效', coefficient: 1.0, minCheckValue: 11, triggersStatus: false }, // 需对抗检定
  { level: '勉强', coefficient: 0.8, minCheckValue: 8, triggersStatus: false }, // 需对抗检定
  { level: '擦伤', coefficient: 0.3, minCheckValue: 4, triggersStatus: false }, // 不触发
  { level: '失手', coefficient: 0.0, minCheckValue: -999, triggersStatus: false }, // 不触发
];

/** 根据检定总值获取命中评级 */
export function getHitRating(checkValue: number): HitRating {
  for (const r of HIT_RATINGS) {
    if (checkValue >= r.minCheckValue) return r;
  }
  return HIT_RATINGS[HIT_RATINGS.length - 1]; // 失手
}

// ========== Intention System (世界书: 6 级意图 + 非致死 + 处决) ==========

/** 意图层级 — 由用户输入触发判定 */
export type IntentionLevel =
  '非致死' | '常规' | '战术' | '机能' | '核心' | '抹杀' | '概念' | '处决';

/** 意图配置 — 各层级的判定难度与系数 */
export interface IntentionConfig {
  level: IntentionLevel;
  /** 意图难度（加到守方对抗中） */
  difficulty: number;
  /** 成功时的伤害系数 */
  coefficient: number;
  /** 是否需要对抗检定 */
  requiresContest: boolean;
  /** 是否触发额外状态效果 */
  triggersExtraEffects: boolean;
}

/** 意图配置表 (对齐世界书 #417617 战术部位与致死意图表 + #837805 战斗协议)
 *
 *  世界书6级: 非致死(1.0) / 常规(1.0) / 机能限制(1.05) / 核心要害(1.2) / 抹杀意图(1.4) / 概念破碎(1.6)
 *  代码扩展: '战术'(难度3,系数1.2) 填补常规→机能过渡; '处决'(系数1.3) 保底暴击机制独立化
 */
export const INTENTION_CONFIGS: Record<string, IntentionConfig> = {
  非致死: {
    level: '非致死',
    difficulty: 0,
    coefficient: 1.0,
    requiresContest: false,
    triggersExtraEffects: false,
  },
  常规: {
    level: '常规',
    difficulty: 0,
    coefficient: 1.0,
    requiresContest: false,
    triggersExtraEffects: false,
  },
  战术: {
    level: '战术',
    difficulty: 3,
    coefficient: 1.2,
    requiresContest: true,
    triggersExtraEffects: false,
  },
  机能: {
    level: '机能',
    difficulty: 5,
    coefficient: 1.05,
    requiresContest: true,
    triggersExtraEffects: true,
  },
  核心: {
    level: '核心',
    difficulty: 10,
    coefficient: 1.2,
    requiresContest: true,
    triggersExtraEffects: true,
  },
  抹杀: {
    level: '抹杀',
    difficulty: 15,
    coefficient: 1.4,
    requiresContest: true,
    triggersExtraEffects: true,
  },
  概念: {
    level: '概念',
    difficulty: 20,
    coefficient: 1.6,
    requiresContest: true,
    triggersExtraEffects: true,
  },
  处决: {
    level: '处决',
    difficulty: 0,
    coefficient: 1.3,
    requiresContest: false,
    triggersExtraEffects: true,
  },
};

/** 意图解析结果 */
export interface IntentionResult {
  level: IntentionLevel;
  /** 意图判定结果类型 */
  verdict: '无需判定' | '成功' | '失败' | '自动成功' | '强制无效';
  /** 对抗检定详情 */
  contested?: {
    attackerFormula: string; // '(攻方层级×5 + d20)'
    attackerValue: number;
    defenderFormula: string; // '(守方层级×5 + d20 + 意图难度)'
    defenderValue: number;
  };
  /** 最终生效的伤害系数 */
  coefficient: number;
  /** 额外状态效果（成功时） */
  extraEffects: string[];
  /** 叙事注释 */
  narrativeNote: string;
}

/** @deprecated 使用 IntentionLevel 代替 */
export type IntentionTier = IntentionLevel;

// ========== Readonly Hooks (M1 事件管道注入缝) ==========

/** 五维属性键: str=力量 / dex=敏捷 / con=体质 / int=智力 / spi=精神
 *  代码内统一用英文键（对齐 CharacterState.attributes），叙事/AI 输出用中文。 */
export type AttributeName = 'str' | 'dex' | 'con' | 'int' | 'spi';

/** 登神长阶强度 9 级（世界书 #265160 + 架构 §4.2）。
 *  冲突仲裁: 高阶压低阶（§13 决策 c 差值压制表，见 effect-types.resolveDivinityConflict） */
export type DivinityLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 登神等级 → 中文名（展示用） */
export const DIVINITY_LEVEL_NAMES: Record<DivinityLevel, string> = {
  0: '普通',
  1: '微弱要素',
  2: '完整要素',
  3: '微弱权能',
  4: '完整权能',
  5: '微弱法则',
  6: '完整法则',
  7: '神位',
  8: '神国',
};

/** 角色只读查询钩子集 — 注入给 ScriptContext（脚本沙盒 $resource/$char）
 *  与 ChainContext.readHooks（emitChain 链上 handler），供其读取角色状态。
 *
 *  - 缺省实现返回 0 / false（兼容未注入场景，现有测试无需改）
 *  - 写入不经过此处 — HP/属性修改仍走 ScriptEffects 收集器，由 state-manager 统一 apply
 *  - 红线：脚本不得通过此钩子直接动 HP（getHp 只读，无 setHp） */
export interface ReadonlyHookSet {
  getHp(charId: string): number;
  getMaxHp(charId: string): number;
  getMp(charId: string): number;
  getMaxMp(charId: string): number;
  getSp(charId: string): number;
  getMaxSp(charId: string): number;
  getHpPercent(charId: string): number;
  getAttr(charId: string, attr: AttributeName): number;
  getTier(charId: string): number;
  isPresent(charId: string): boolean;
  /** 🆕 M2: 读角色现有状态效果列表（供 $status.query/has/getStacks） */
  getStatusEffects(charId: string): StatusEffect[];
  /** 🆕 M2: 查角色是否持有某 buff（按 buffId 或裸 name 匹配） */
  hasStatus(charId: string, buffIdOrName: string): boolean;
  /** 🆕 M2: 查角色某 buff 的层数（未持有返回 0） */
  getBuffStacks(charId: string, buffIdOrName: string): number;
}

// ========== Combat Participant ==========

/** 战斗参与者 — 角色 + 战斗专用字段 */
export interface CombatParticipant {
  characterId: string;
  name: string;
  tier: number;
  level: number;
  /** 五维属性 (战斗中为"最终"值，含装备/状态修正) */
  attributes: {
    str: number;
    dex: number;
    con: number;
    int: number;
    spi: number;
  };
  /** 当前资源 */
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;
  /** 防御值 */
  defense: number;
  /** 伤害减免 (DR, 百分比) */
  dr: number;
  /** 穿透 (百分比) */
  penetration: number;
  /** 命中加值 */
  hitBonus: number;
  /** 闪避加值 */
  dodgeBonus: number;
  /** 速度修正 (百分比列表, 多来源取最高) */
  speedModifiers: number[];
  /** 固定先攻修正 (多来源取最高) */
  fixedInitiativeBonus: number;
  /** 当前回合可用资源 */
  attacksRemaining: number;
  actionsRemaining: number;
  /** 当前状态效果列表 */
  statusEffects: StatusEffect[];
  /** 武器攻击力 */
  weaponAtk: number;
  /** 阵营: 友方/敌方 */
  side: 'ally' | 'enemy';
  /** 是否可行动 */
  canAct: boolean;
  /** 战意状态 (Phase 6c) */
  morale?: MoraleState;
}

// ========== Combat State ==========

/** 完整战斗状态 — 一场战斗的瞬时快照 */
export interface CombatState {
  combatId: string;
  combatType: CombatType;
  round: number;
  participants: CombatParticipant[];
  turnOrder: CombatUnitTurn[];
  /** 当前行动者索引 */
  currentTurnIndex: number;
  /** 战斗状态 */
  status: 'active' | 'paused' | 'ended';
  /** 胜利方 */
  winner?: 'ally' | 'enemy' | 'draw';
  /** 环境描述 */
  environment: string;
  /** 本次战斗产生的所有 StatePatch */
  patches: StatePatch[];
  /** 回合日志 */
  roundLogs: CombatRoundLog[];
}

/** 单回合战斗日志 */
export interface CombatRoundLog {
  round: number;
  actions: CombatActionLog[];
  summary: string;
}

/** 单次行动日志 */
export interface CombatActionLog {
  attackerId: string;
  defenderId: string;
  action: string;
  hitRating: HitRating;
  damage: number;
  effects: string[];
  description: string;
}

// ========== Combat Action Request/Result ==========

/** 战斗动作请求 — AI 调用 $combat.attack() 时生成 */
export interface CombatActionRequest {
  attackerId: string;
  defenderId: string;
  action: 'attack' | 'defend' | 'skill' | 'item' | 'flee' | 'wait';
  skillId?: string;
  skillName?: string;
  itemId?: string;
  /** 意图描述关键词（来自用户输入） */
  intentionKeywords?: string;
  /** 非致死标记 */
  nonLethal?: boolean;
  /** 技能标签 (如多段/连击/范围等) */
  skillTags?: string[];
  /** 多段攻击次数 */
  multiHitCount?: number;
  /** 战斗类型 */
  combatType?: CombatType;
  /** 当前回合 */
  round?: number;
  /** 技能威力 */
  skillPower?: number;
  /** 关联属性 (用于伤害公式) */
  relevantAttribute?: string;
  /** 伤害类型 */
  damageType?: DamageType;
  /** 武器名称 */
  weaponName?: string;
  /** 武器攻击力 */
  weaponAtk?: number;
  /** 消耗 */
  costs?: { hp?: number; mp?: number; sp?: number };
}

/** 完整的战斗动作结果 (对齐世界书三级面板) */
export interface CombatActionResult {
  request: CombatActionRequest;

  // 意图判定
  intention: IntentionResult;

  // 攻击检定
  attackRoll: {
    diceUsed: number;
    advantage: boolean;
    disadvantage: boolean;
    diceRolls: number[];
    dodgeNegated: boolean;
    dodgeNegatedReason?: string;
    hitBonus: number;
    dodgeBonus: number;
    checkValue: number;
    rating: HitRating;
  };

  // 伤害管线 (8 步)
  damage: CombatDamageBreakdown;

  // 最终结算
  finalHp: number;
  maxHp: number;
  isDead: boolean;
  isNarrativeAlive: boolean;

  // 状态施加
  statusApplied: Array<{ name: string; duration: number; effect: string }>;

  // 产生的 StatePatch
  patches: StatePatch[];

  // 面板描述 (用于 <action_info> 生成)
  panelLines: string[];

  // 人类可读描述
  description: string;
}

/** 伤害管线 8 步分解 (对齐世界书) */
export interface CombatDamageBreakdown {
  // Step 1: 初始伤害 = 关联属性×10×层级系数 + 技能威力 + 武器攻击力
  initialDamage: number;
  initialFormula: string;

  // Step 2: 多段分割 (如有)
  afterMultiSplit: number;
  multiSplitInfo?: { count: number; perHit: number };

  // Step 3: 穿透修正 — 有效防御 = 防御 × (1 - 穿透%)
  penetration: { originalDef: number; penetrationRate: number; effectiveDef: number };

  // Step 4: 装备减免 — 伤害 × (有效防御 / (有效防御 + 2000))
  equipmentReduction: number;
  afterEquipmentReduction: number;

  // Step 5: 类型减免 (按伤害类型)
  typeReductionRate: number;
  typeReductionAmount: number;
  afterTypeReduction: number;

  // Step 6: 评级系数 + 意图系数
  ratingCoefficient: number;
  intentionCoefficient: number;
  afterRating: number;

  // Step 7: DR 修正
  drRate: number;
  drReduction: number;
  afterDr: number;

  // Step 8: 最终伤害
  finalDamage: number;
}

// ═══════════════════════════════════════════════════════════
// Phase 6b — Crafting System Types (对齐世界书 #683615 [生产制作协议])
// ═══════════════════════════════════════════════════════════

// ========== Unified Quality Type ==========

/** 7 级品质体系 (对齐世界书) */
export type QualityLevel = '普通' | '优良' | '稀有' | '史诗' | '传说' | '神话' | '唯一';

/** 品质等级数值索引 (普通=0 → 唯一=6) */
export const QUALITY_RANK: Record<QualityLevel, number> = {
  普通: 0,
  优良: 1,
  稀有: 2,
  史诗: 3,
  传说: 4,
  神话: 5,
  唯一: 6,
};

/** 按 rank 索引取品质名 */
export const QUALITY_BY_RANK: QualityLevel[] = [
  '普通',
  '优良',
  '稀有',
  '史诗',
  '传说',
  '神话',
  '唯一',
];

// ========== Craft Industry & Stage ==========

/** 制作行业类型 (对齐世界书: 4 种) */
export type CraftIndustry = '锻造' | '炼金' | '烹饪' | '裁缝';

/** 行业→核心属性映射 */
export const CRAFT_INDUSTRY_ATTRIBUTE: Record<CraftIndustry, string> = {
  锻造: '力量',
  炼金: '智力',
  烹饪: '精神',
  裁缝: '敏捷',
};

/** 制作阶段 (对齐世界书: 3 级加工) */
export type CraftStage = '基础加工' | '半成品' | '成品';

/** 制作检定评级 */
export type CraftRating = '大失败' | '失败' | '成功' | '精益求精';

/** 各评级的产出数值区间 (成品) */
export const CRAFT_RATING_VALUE_RANGE: Record<CraftRating, { min: number; max: number }> = {
  大失败: { min: 0, max: 0 },
  失败: { min: 0, max: 0 },
  成功: { min: 0.4, max: 0.6 },
  精益求精: { min: 0.9, max: 1.0 },
};

// ========== Craft DC Configuration (对齐世界书 #265160 品质数值总表) ==========

/** 品质 DC 基准 (品质→基准DC) */
export const CRAFT_DC_BASE: Record<QualityLevel, number> = {
  普通: 6,
  优良: 10,
  稀有: 16,
  史诗: 22,
  传说: 30,
  神话: 40,
  唯一: 0, // 唯一品质无法生产制作获得
};

/** 品质 DC 修正范围 (材料/半成品 DC 修正) */
export const CRAFT_DC_MODIFIER_RANGE: Record<QualityLevel, [number, number]> = {
  普通: [0, 0],
  优良: [1, 2],
  稀有: [3, 5],
  史诗: [6, 9],
  传说: [10, 15],
  神话: [16, 25],
  唯一: [0, 0],
};

/** 品质经验表 (单次产出，对齐世界书 #284017) */
export const CRAFT_QUALITY_EXP: Record<QualityLevel, number> = {
  普通: 50,
  优良: 120,
  稀有: 400,
  史诗: 1200,
  传说: 3000,
  神话: 6000,
  唯一: 0,
};

// ========== Quality Production Bonuses (对齐世界书 #265160 生产加成表) ==========

export interface CraftProductionBonus {
  dcReduction: [number, number]; // DC 减轻范围
  resourceReduction: [number, number]; // 资源消耗减轻 %
  timeReduction: [number, number]; // 时间减轻 %
  batchBonus?: string; // 批量加成描述
  materialSave?: { d20Threshold: number; savePercent: number }; // 材料节省
  failureProtection: number; // 损毁率降至 (0=完全保护)
  perfectionThresholdReduction: number; // 精益求精阈值降低
  canUpgradeQuality?: boolean; // 品质提升 (传→神)
  greatFailureImmunity?: boolean; // 大失败豁免
}

/** 品质产能加成配置表 */
export const CRAFT_PRODUCTION_BONUSES: Record<QualityLevel, CraftProductionBonus> = {
  普通: {
    dcReduction: [1, 1],
    resourceReduction: [0, 0],
    timeReduction: [0, 0],
    failureProtection: 1.0,
    perfectionThresholdReduction: 0,
  },
  优良: {
    dcReduction: [2, 3],
    resourceReduction: [3, 5],
    timeReduction: [0, 0],
    failureProtection: 1.0,
    perfectionThresholdReduction: 0,
  },
  稀有: {
    dcReduction: [4, 5],
    resourceReduction: [6, 10],
    timeReduction: [20, 25],
    batchBonus: '产量+1',
    failureProtection: 1.0,
    perfectionThresholdReduction: 0,
  },
  史诗: {
    dcReduction: [6, 8],
    resourceReduction: [11, 16],
    timeReduction: [26, 35],
    materialSave: { d20Threshold: 16, savePercent: 25 },
    failureProtection: 0.25,
    perfectionThresholdReduction: 0,
  },
  传说: {
    dcReduction: [0, 0], // 传说自身不提供DC减免(但可通过材料)
    resourceReduction: [17, 24],
    timeReduction: [36, 50],
    materialSave: { d20Threshold: 14, savePercent: 25 },
    failureProtection: 0.15,
    perfectionThresholdReduction: 3,
  },
  神话: {
    dcReduction: [0, 0],
    resourceReduction: [25, 30],
    timeReduction: [51, 70],
    materialSave: { d20Threshold: 12, savePercent: 50 },
    failureProtection: 0.0,
    perfectionThresholdReduction: 6,
    canUpgradeQuality: true,
    greatFailureImmunity: true,
  },
  唯一: {
    dcReduction: [0, 0],
    resourceReduction: [0, 0],
    timeReduction: [0, 0],
    failureProtection: 1.0,
    perfectionThresholdReduction: 0,
  },
};

// ========== Craft Material / Input ==========

/** 制作投入物 */
export interface CraftMaterial {
  itemId: string;
  itemName: string;
  quantity: number;
  quality: QualityLevel;
  dcModifier: number; // 该材料带来的 DC 修正
  isRegulated?: boolean; // 管制投入物 (史诗+需许可)
  hasLicense?: boolean; // 是否有许可
}

// ========== Craft Action Request ==========

/** 制作动作请求 — AI 调用 $craft.startProject() 时生成 */
export interface CraftActionRequest {
  /** 制作者 ID */
  characterId: string;
  /** 制作行业 */
  industry: CraftIndustry;
  /** 制作阶段 */
  stage: CraftStage;
  /** 目标物品名称 */
  productName: string;
  /** 目标品质 */
  targetQuality: QualityLevel;
  /** 制作数量 */
  quantity: number;
  /** 图纸 ID (成品阶段需要) */
  recipeId?: string;
  /** 是否拥有图纸 */
  hasRecipe?: boolean;
  /** 投入物列表 */
  materials: CraftMaterial[];
  /** 制作者层级 */
  crafterTier: number;
  /** 制作者等级 */
  crafterLevel: number;
  /** 核心属性值 (由行业决定) */
  coreAttributeValue: number;
  /** 工具/设施加值 */
  toolBonus?: number;
  /** 技能加值 */
  skillBonus?: number;
  /** 身份/称号加值 */
  identityBonus?: number;
  /** 地点加值 */
  locationBonus?: number;
  /** 资源消耗 (HP/MP/SP) */
  resourceCosts: { hp: number; mp: number; sp: number };
  /** 当前资源 */
  currentResources: { hp: number; mp: number; sp: number };
  /** d20 骰值 (用于检定) */
  d20Rolls: number[]; // [d20_1, d20_2] for advantage/disadvantage/normal
  /** d20 骰值 (用于材料节省判定) */
  d20MaterialSave?: number;
  /** d20 骰值 (用于品质提升判定, 神话) */
  d20QualityUpgrade?: number;
}

// ========== Craft Check Breakdown ==========

/** 制作检定分解 (对齐世界书 第二阶段: 制作检定) */
export interface CraftCheckBreakdown {
  /** 基础 DC (由目标品质决定) */
  baseDC: number;
  /** 材料 DC 修正总和 */
  materialDCModifier: number;
  /** 材料 DC 明细 */
  materialDCDetails: Array<{ materialName: string; dcModifier: number }>;
  /** 工具/技能/道具 DC 减免 */
  bonusDCReduction: number;
  /** 最终 DC */
  finalDC: number;

  /** 固定加值 = 核心属性 + 技能 + 道具 + 身份 */
  fixedBonus: number;
  fixedBonusBreakdown: { attribute: number; skill: number; tool: number; identity: number };

  /** 骰池信息 */
  diceUsed: number;
  advantage: boolean;
  disadvantage: boolean;
  diceRolls: number[];
  diceValue: number;

  /** 判定 */
  totalValue: number;
  rating: CraftRating;

  /** 精益求精阈值 (DC+20, 可被降低) */
  perfectionThreshold: number;
}

// ========== Craft Settlement Breakdown ==========

/** 制作结算分解 (对齐世界书 第三阶段: 结算) */
export interface CraftSettlementBreakdown {
  /** 投入物损耗 */
  materialLoss: {
    lossRate: number; // 0/0.5/1.0
    lostMaterials: Array<{ itemName: string; quantity: number }>;
  };

  /** 产出物品质 (可能因品质继承降级) */
  outputQuality: QualityLevel;
  qualityDowngraded: boolean;
  qualityDowngradeReason?: string;

  /** 精益求精增益 */
  perfectionBonus?: {
    batchExtraYield?: number; // 批量+10%产量
    singleExtraAffix?: string; // 单件额外词条
    dcModifierDowngrade?: number; // 半成品单件 DC 修正降级
  };

  /** 产出物 DC 修正 (随机范围内) */
  productDCModifier: number;

  /** 成品数值区间 */
  valueRange?: { min: number; max: number };

  /** 管制物徽记 */
  certification?: string;

  /** 经验结算 */
  expReward: {
    baseExp: number;
    tierSuppressed: boolean; // 层级压制归零
    actualExp: number;
  };

  /** FP 奖励 */
  fpReward: number;

  /** 资源消耗 */
  resourceCost: { hp: number; mp: number; sp: number };
  resourceSufficient: boolean;
}

// ========== Craft Phase Results ==========

/** 制作阶段一: 生产准备 结果 */
export interface CraftPrepResult {
  stage: 'preparation';
  /** 能否继续 (资源不足则终止) */
  canProceed: boolean;
  /** 终止原因 */
  stopReason?: string;
  /** 实际批量数 */
  batchCount: number;
  /** 是否强制单件 */
  forcedSingle: boolean;
  forcedSingleReason?: string;
  /** 管制物检查 */
  regulatedCheck: { passed: boolean; missingLicenses: string[] };
  /** 品质要求检查 */
  qualityReqCheck: { passed: boolean; downgradeReason?: string };
  /** 资源预检 */
  resourceCheck: { sufficient: boolean; shortage: string[] };
}

/** 制作阶段二: 制作检定 结果 */
export interface CraftCheckResult {
  stage: 'check';
  breakdown: CraftCheckBreakdown;
}

/** 制作阶段三: 结算 结果 */
export interface CraftSettleResult {
  stage: 'settlement';
  breakdown: CraftSettlementBreakdown;
}

// ========== Craft Action Result ==========

/** 完整的制作动作结果 (对齐世界书三级面板) */
export interface CraftActionResult {
  /** 原始请求 */
  request: CraftActionRequest;

  /** 是否成功 (大失败/失败=false) */
  success: boolean;

  /** 产出物信息 */
  productId?: string;
  productName: string;
  productQuantity: number;
  outputQuality: QualityLevel;

  /** 三阶段结果 */
  prepResult: CraftPrepResult;
  checkResult: CraftCheckResult;
  settleResult: CraftSettleResult;

  /** 经验/FP */
  xpGained: number;
  fpGained: number;

  /** 产物效果定义 (如有) */
  effects: EffectDefinition[];

  /** 产生的 StatePatch */
  patches: StatePatch[];

  /** 面板描述 (用于 <action_info> 生成) */
  panelLines: string[];

  /** 人类可读描述 */
  description: string;
}

/** 制作产物 (用于记录产出) */
export interface CraftProduct {
  productId: string;
  productName: string;
  stage: CraftStage;
  industry: CraftIndustry;
  quality: QualityLevel;
  quantity: number;
  dcModifier: number;
  effects: EffectDefinition[];
  certification?: string;
}

// ═══════════════════════════════════════════════════════════
// Phase 4.6+ — Foundation & Expansion Types
// ═══════════════════════════════════════════════════════════

// ========== SaveProfile (Phase 4.6) ==========

export interface SaveProfile {
  saveId: string;
  fp: number;
  fpHistory: FPTransaction[];
  contracts: FateContract[];
  achievements: Achievement[];
  news: NewsItem[];
  quests: Record<string, Quest>;
  /** 焦点任务名 (key into quests) */
  focusQuest: string;
  /** 好感度映射: characterId → [-100, +100] */
  affections: Record<string, number>;
  /** 🆕 存档级全局游戏时间 */
  gameTime: GameTime;
  /** 🆕 叙事变量唯一真源（user./sys. 命名空间；从快照寄生迁出，规范 §12。M5 接管读写） */
  variables: Record<string, any>;
  worldFlags: Record<string, any>;
  updatedAt: number;
}

export interface FPTransaction {
  id: string;
  timestamp: number;
  amount: number;
  reason: string;
  balance: number;
  source:
    | 'task'
    | 'intimacy'
    | 'achievement'
    | 'contract'
    | 'skill_fusion'
    | 'craft'
    | 'resurrection'
    | 'other';
}

export interface FateContract {
  id: string;
  targetId: string;
  targetName: string;
  tier: number;
  fpSpent: number;
  affectionLevel: string;
  createdAt: number;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  unlockedAt: number;
  fpReward: number;
}

export interface NewsItem {
  id: string;
  title: string;
  content: string;
  category: string;
  publishedAt: number;
  read: boolean;
}

// ========== Quest System (Phase 7e) ==========

/** 任务 — 对齐原版 data_schema/utils.ts TaskSchema */
export interface Quest {
  /** 任务状态: 进行中 / 已完成 / 失败 / 搁置 等 */
  status: string;
  /** 关注度: 高 / 中 / 低 */
  priority: '低' | '中' | '高';
  /** 当前进展描述 */
  progress: string;
  /** 任务详情 */
  detail: string;
  /** 任务目标 */
  objective: string;
  /** 奖励描述 */
  reward: string;
}

/** 默认任务值 */
export function createDefaultQuest(): Quest {
  return {
    status: '',
    priority: '中',
    progress: '',
    detail: '',
    objective: '',
    reward: '',
  };
}

// ========== Effect Parser (Phase 4.6) ==========

export interface ParsedEffect {
  key: string;
  rawKey: string;
  value: number;
  isPercentage: boolean;
  isSubtractive: boolean;
}

// ========== Death & Resurrection (Phase 5) ==========

/** 死亡记录 — 复活由 AI 叙事处理 */
export interface DeathState {
  characterId: string;
  characterName: string;
  deathTimestamp: number;
  deathLocation: string;
  deathCount: number;
}

// ========== Bloodline (Phase 5) ==========

export interface Bloodline {
  id: string;
  name: string;
  description: string;
  tier: number;
  racialTraits: RacialTrait[];
  statModifiers: Partial<Record<string, number>>;
  specialAbilities: string[];
}

export interface RacialTrait {
  name: string;
  description: string;
  effect: string;
}

// ========== Tier Constants (Phase 5) ==========

export interface TierConfig {
  tier: number;
  name: string;
  levelRange: [number, number];
  hpMultiplier: number;
  mpMultiplier: number;
  spMultiplier: number;
  combatCoefficient: number;
  expCap: number;
  qualityCap: string;
  populationWeight: number;
  attributeCap: number;
}

// ========== Intention System (Phase 6a) — see INTENTION_CONFIGS and IntentionResult above ==========
// IntentionTier is defined above as an alias for IntentionLevel
// DamageInput/DamageResult replaced by CombatDamageBreakdown and CombatActionResult

// ========== Cluster & Morale (Phase 6c) ==========

/** 集群状态 — ≥3 同类低级单位自动聚合 */
export interface ClusterState {
  /** 组成单位的模板 ID */
  unitTemplateId: string;
  /** 初始数量 */
  initialCount: number;
  /** 当前存活数量 (按 HP% 折算) */
  currentCount: number;
  /** 集群总 HP */
  clusterHp: number;
  /** 集群最大 HP (= 个体MaxHP × 初始数量) */
  clusterMaxHp: number;
  /** 本回合攻击次数 (由 HP% 决定: ≥80%→3, ≥50%→2, <50%→1) */
  attacksPerRound: number;
}

/** 集群形成结果 */
export interface ClusterFormResult {
  cluster: ClusterState;
  /** 被合并的个体角色 ID 列表 */
  mergedIds: string[];
  /** 形成原因描述 */
  reason: string;
}

/** 集群减员结果 */
export interface ClusterAttritionResult {
  /** 更新后的集群状态 (或 null 表示全灭) */
  cluster: ClusterState | null;
  /** 本回合减员数 */
  casualtiesThisRound: number;
  /** HP 百分比更新 */
  hpPercentBefore: number;
  hpPercentAfter: number;
}

/** 4 级战意状态 — steady → shaken → wavering → routing */
export type MoraleState = 'steady' | 'shaken' | 'wavering' | 'routing';

/** 士气检查结果 */
export interface MoraleCheckResult {
  /** 当前战意状态 */
  moraleState: MoraleState;
  /** 是否触发了战意事件 */
  triggered: boolean;
  /** 触发类型: auto=高阈值自动 / check=需d20检定 / none=未触发 */
  triggerType: 'auto' | 'check' | 'none';
  /** d20 检定详情 (仅 triggerType='check' 时) */
  checkRoll?: {
    d20Roll: number;
    target: number; // 目标值 (固定 12)
    passed: boolean; // d20 < 12 → 战意崩溃
  };
  /** 战意结果池输出 (投降/认输/溃逃等) */
  outcome?: string;
  /** 叙事情境描述 */
  narrative: string;
}

/** 战意结果池 — 对齐世界书 #837805 第五阶段 §3 */
export const MORALE_OUTCOME_POOL: Record<MoraleState, string[]> = {
  steady: [],
  shaken: ['继续战斗但动作犹豫', '表现出恐惧但未撤退'],
  wavering: ['投降', '认输', '求饶', '撤退', '中止战斗'],
  routing: ['溃逃', '阵线溃散', '被击昏', '被俘虏', '内讧', '投降', '求饶'],
};

/** 战意状态描述 (人类可读) */
export const MORALE_STATE_LABELS: Record<MoraleState, string> = {
  steady: '坚定',
  shaken: '动摇',
  wavering: '战意动摇',
  routing: '丧失战意/崩溃',
};

// ========== Turn & Initiative (Phase 6a) ==========

export interface TurnOrder {
  sequence: CombatUnitTurn[];
  round: number;
}

export interface CombatUnitTurn {
  characterId: string;
  name: string;
  agility: number;
  d20Roll: number;
  speedModifiers: number[];
  totalInitiative: number;
  attacksRemaining: number;
  actionsRemaining: number;
}

// ========== Phase 6e: Marker Protocol + SubAgent Types ==========

/** 已知 XML 标记标签名 — 正文与引擎的通信协议 (ADR-25) */
export type MarkerType =
  | 'craft_request'
  | 'combat_trigger'
  | 'char_detect' // 旧（保留向后兼容）
  | 'char_gen_request'
  | 'char_update_request' // 角色调度
  | 'item_gen_request'
  | 'item_update_request' // 物品调度
  | 'craft_gen_request' // 制作调度（统一 _request 后缀）
  | 'play_audio'; // 场景配乐（Story 直接输出，非阻塞）

/** 所有标记的公共字段 */
export interface DetectedMarkerBase {
  /** 标记类型 */
  type: MarkerType;
  /** 含标签的完整 XML 原文 */
  rawContent: string;
  /** 在源文本中的字符偏移 (0-based) */
  position: number;
}

/**
 * <craft_request> 标记 — Story AI 在正文中产生制作意图时输出。
 * 🚩 延迟型: Stage 1 正文结束后暂存，Stage 2 统一执行 craft_gen → item_gen 链。
 */
export interface CraftRequestMarker extends DetectedMarkerBase {
  type: 'craft_request';
  /** 执行制作的角色 ID */
  characterId?: string;
  /** 制作行业: 锻造/炼金/烹饪/裁缝 */
  industry?: string;
  /** 目标产物名称 */
  productName?: string;
  /** 目标品质 */
  targetQuality?: string;
  /** 🆕 用户对该制品的期望需求 / 特殊效果要求 */
  expects?: string;
  /** 标签内部正文 (AI 描述的制作意图和背景) */
  bodyText?: string;
}

/**
 * <combat_trigger> 标记 — request_dispatcher 读叙事判定"交战"后输出（M5.1: 原 Story 直接输出，现统一到调度器）。
 * 🚩 独立型: dispatcher 输出后唤起独立战斗面板，不影响正文上下文。
 */
export interface CombatTriggerMarker extends DetectedMarkerBase {
  type: 'combat_trigger';
  /** 战斗类型: 切磋/竞技/压制/死斗/标准/守卫 */
  combatType?: string;
  /** 战斗环境描述 */
  environment?: string;
  /** 标签内部正文 (AI 描述的战斗场景和参战方) */
  bodyText?: string;
}

/**
 * <char_detect> 标记 — Story AI 引入新角色时输出。
 * 👤 隐式型: vars_update (Stage 2) 扫描后异步触发 char_gen → item_gen 链。
 */
export interface CharDetectMarker extends DetectedMarkerBase {
  type: 'char_detect';
  /** AI 推断的角色名 (可能为空) */
  characterName?: string;
  /** 角色类型: npc/monster/summon */
  characterType?: string;
  /** 标签内部正文 (AI 描述的角色外观、言行、场景) */
  bodyText?: string;
}

/**
 * <play_audio> 标记 — Story AI 在场景/氛围发生转折时输出，切换 BGM。
 *
 * **地点不由 AI 提供**：位置已经在游戏状态里（`player.location`），让 AI 再写一遍
 * 只会多一处漂移源。AI 只负责它独有的判断——此刻是什么情绪、什么情境。
 *
 * 自闭合与成对写法都认：
 *   `<play_audio situation="战斗" mood="紧张"/>`
 *   `<play_audio>战斗, 紧张</play_audio>`（正文按逗号拆成自由词，喂给情绪与情境两维）
 */
export interface PlayAudioMarker extends DetectedMarkerBase {
  type: 'play_audio';
  /** 情境词（探索/战斗/潜行/仪式…），逗号或顿号分隔 */
  situation?: string;
  /** 情绪词（紧张/平静/悲壮…），逗号或顿号分隔 */
  mood?: string;
  /** 指定人物主题曲（可选；缺省由调用方按在场角色填） */
  character?: string;
  /** 氛围变体 A/B */
  variant?: string;
  /** `stop` = 停止当前 BGM，不再选曲 */
  action?: string;
  /** 标签内部正文：自由词，逗号分隔 */
  bodyText?: string;
}

/** 三种标记的联合类型 */
export type DetectedMarker =
  | CraftRequestMarker
  | CombatTriggerMarker
  | CharDetectMarker // 旧（保留）
  | CharGenRequestMarker
  | CharUpdateRequestMarker
  | ItemGenRequestMarker
  | ItemUpdateRequestMarker
  | CraftGenRequestMarker
  | PlayAudioMarker;

/**
 * <char_gen_request> 标记 — request_dispatcher 检测到新角色时输出。
 * 触发 char_gen → item_gen 链，为新角色生成完整状态。
 */
export interface CharGenRequestMarker extends DetectedMarkerBase {
  type: 'char_gen_request';
  attributes: {
    characterName?: string;
    race?: string;
    tier?: string;
    characterType?: string;
    faction?: string;
  };
  bodyText: string;
}

/**
 * <char_update_request> 标记 — request_dispatcher 检测到已有角色状态变化时输出。
 * 保留在调度器输出中，由 Stage 3 vars_update 读取处理。
 */
export interface CharUpdateRequestMarker extends DetectedMarkerBase {
  type: 'char_update_request';
  attributes: {
    target: string; // 必填：角色 ID
  };
  bodyText: string;
}

/**
 * <item_gen_request> 标记 — request_dispatcher 检测到新物品/技能时输出。
 * 触发独立 item_gen 调用。
 */
export interface ItemGenRequestMarker extends DetectedMarkerBase {
  type: 'item_gen_request';
  attributes: {
    itemType: string; // equipment | skill | consumable | material | ascension
    source?: string; // craft | loot | gift | story
    owner?: string; // 归属角色 ID
  };
  bodyText: string;
}

/**
 * <item_update_request> 标记 — request_dispatcher 检测到已存在物品变更时输出。
 * 由 Stage 3 vars_update 读取处理。
 */
export interface ItemUpdateRequestMarker extends DetectedMarkerBase {
  type: 'item_update_request';
  attributes: {
    target: string; // 物品 ID 或名
    operation: string; // consume | transfer | modify | equip | unequip
    quantity?: string;
    owner?: string;
  };
  bodyText: string;
}

/**
 * <craft_gen_request> 标记 — request_dispatcher 检测到制作场景时输出。
 * 触发 craft_gen → item_gen 链。与旧 <craft_request> 语义相同，统一后缀。
 */
export interface CraftGenRequestMarker extends DetectedMarkerBase {
  type: 'craft_gen_request';
  attributes: {
    characterId?: string;
    industry?: string;
    productName?: string;
    targetQuality?: string;
  };
  bodyText: string;
}

/** 扫描文本后的标记检测结果 */
export interface MarkerScanResult {
  /** 检测到的所有标记，按 position 升序排列 */
  markers: DetectedMarker[];
  /** 剥离所有标记块后的纯文本 (非标记 XML 标签保留) */
  cleanText: string;
}

// ========== SubAgent 输出类型 ==========

/** Craft Agent (craft_gen) 的输出 — 制作创意效果 + 叙事注入 */
/** @deprecated 请使用 CraftGenOutput（定义在下方或 craft-gen-chain.ts） */
export interface CraftAgentOutput {
  /** 难度判定 */
  difficultyJudgment: {
    /** DC 修正值 (叠加到基础 DC) */
    dcModifier: number;
    /** 判定理由 */
    reasoning: string;
  };
  /** 创意效果词条列表 (AI 生成) */
  creativeEffects: Array<{
    /** 词条名称 */
    name: string;
    /** 词条自然语言描述 */
    description: string;
    /** 词条类型 */
    type: '增益' | '减益' | '特殊';
    /** 🆕 结构化数值效果: 效果名 → 数值 (如 {"atk": 5, "def": -3}) */
    effects?: Record<string, number>;
    /** 🆕 持续回合数 (null=永久) */
    duration?: number | null;
    /** 🆕 持续时长单位 */
    durationUnit?: '回合' | '分钟' | '小时';
    /** 🆕 是否可叠加层数 */
    stackable?: boolean;
    /** 🆕 最大层数 */
    maxStacks?: number;
    /** 🆕 伤害类型 (如 "物理"/"能量"/"精神"/"真实"/"毒") */
    damageType?: string;
    /** 🆕 施加状态效果的名称引用 */
    appliesStatus?: string;
    /** 🆕 词条脚本注册表: 脚本名→可执行代码（支持 $event.on/off, $call, @parent 等） */
    scripts?: Record<string, string>;
  }>;
  /** 效果声明列表 (可被 effect-parser 解析) */
  effectDeclarations: string[];
  /** 注入回正文的制作叙事片段 */
  narrativeFlavor: string;
  /** 传递给 $craft API 的工具调用参数 */
  craftToolCall: {
    industry: string;
    productName: string;
    targetQuality: string;
    quantity: number;
    materials: string[];
    /** 🆕 用户对该制品的期望需求 / 特殊效果要求 */
    expects?: string;
  };
}

/**
 * craft_gen 解析后的结构化输出（与 craft-gen-chain.ts 中的定义保持一致）
 * 这是制作系统的真实输出类型，用于 CraftSystemEvent.details
 */
export interface CraftGenOutput {
  success: boolean;
  productName: string;
  quality: QualityLevel;
  rating: CraftRating;
  checkSummary: string;
  perfectionBonus?: string;
  itemRequests: ItemRequest[];
  narrative: string;
  craftParams: {
    industry: CraftIndustry;
    targetQuality: QualityLevel;
    stage: string;
    quantity: number;
    materials: string;
    expGained: number;
    fpGained: number;
  };
}

/**
 * craft_gen 的 <request> 子元素 — 派发给 item_gen 的制品需求
 */
export interface ItemRequest {
  type: 'equipment' | 'inventory';
  slot?: string; // equipment: 武器/头部/身体/腿部/脚部/首饰/戒指/项链
  quality: string;
  description: string; // 纯自然语言，不含数值
}

/** Char Gen Agent (char_gen) 的输出 — 新 NPC 完整数据 (对齐世界书 #865613) */
export interface CharGenOutput {
  name: string;
  race: string;
  /** 性别 ('男'|'女'|'无性'|'双性'|'其他') */
  gender: string;
  /** 阵营/所属势力 */
  faction?: string;
  tier: number;
  level: number;
  /** 五维属性 (范围由 tier 决定) */
  attributes: {
    str: number;
    dex: number;
    con: number;
    int: number;
    spi: number;
  };
  /** 身份标签 */
  identity: string[];
  /** 职业标签 */
  occupation: string[];
  /** 角色背景故事 (80-150 tokens) */
  background: string;
  /** 外貌描述 — 裸体 (100-200 tokens，含私密部位) */
  appearance: string;
  /** 衣物装饰 (80-150 tokens，全身从头到脚) */
  clothing: string;
  /** 性格描述 (40-80 tokens，含性格编码) */
  personality: string;
  /** 喜爱/偏好 (20-50 tokens) */
  likes: string;
  /** 🆕 心里话（40-80 tokens，角色内心独白/当前真实想法） */
  thoughts?: string;
  /** 登神长阶 (Lv.13+ 可用) */
  ascension: {
    enabled: boolean;
    /** 登神路径描述 */
    path: string;
    description: string;
    /** 要素 (Lv.13-16, 1-3个) — 使用 ElementDetail 统一类型 */
    elements: Array<Pick<ElementDetail, 'name' | 'description' | 'effects'>>;
    /** 权能 (Lv.17-20, 1个) — 使用 AuthorityDetail 统一类型 */
    authorities: Array<
      Pick<AuthorityDetail, 'name' | 'description' | 'effects' | 'costDescription'>
    >;
    /** 法则 (Lv.21-24, 1-2个) */
    laws: Array<{
      name: string;
      description: string;
      passiveEffects: string[];
      activeEffects: string[];
      costDescription: string;
    }>;
    /** 神位 (Lv.25) */
    deityPosition: string;
    /** 神国 (Lv.25 巅峰) */
    divineKingdom: { name: string; description: string };
  };
  /** 🆕 char_gen 自身生成的技能 (供异步 item_gen 参考，也直接写入角色) */
  skills: Array<{
    name: string;
    description: string;
    type: 'active' | 'passive';
    cost?: { type: 'HP' | 'MP' | 'SP'; amount: number };
    cooldown?: number;
    effects?: Record<string, string>;
    scripts?: Record<string, string>;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明（6 大类 modifier） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该技能附带的 buff 定义 */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8 */
    divinity?: DivinityLevel;
  }>;
  /** 🆕 char_gen 自身生成的装备 */
  equipment: Array<{
    slot: string;
    name: string;
    description: string;
    stats: Record<string, number>;
    durability?: number;
    quality?: string;
    effects?: Record<string, string>;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明（6 大类 modifier） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该装备附带的 buff 定义 */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（挂整件装备） */
    divinity?: DivinityLevel;
  }>;
  /** 🆕 char_gen 自身生成的背包物品 */
  inventory: Array<{
    name: string;
    description: string;
    quantity: number;
    type: string;
    rarity?: string;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明（6 大类 modifier） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该物品附带的 buff 定义 */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（挂整件装备） */
    divinity?: DivinityLevel;
  }>;
  /** 🆕 真机 fix(2026-07-18): char_gen 原始 XML 输出，供 item_gen 提取 <item_requests>/<skill_requests>/<equipment_requests> */
  rawXml?: string;
}

/** Item Gen Agent (item_gen) 的输出 — 角色装备/技能/道具 (对齐世界书 #261442 + #265160) */
export interface ItemGenOutput {
  /** 技能列表 */
  skills: Array<{
    name: string;
    description: string;
    type: 'active' | 'passive';
    /** 消耗 (可选) */
    cost?: {
      type: 'HP' | 'MP' | 'SP';
      amount: number;
    };
    /** 冷却回合数 (可选) */
    cooldown?: number;
    /** 🆕 Phase 8.5: 词条效果 <effect name="...">...</effect> */
    effects?: Record<string, string>;
    /** 🆕 Phase 8.5: 脚本 <script name="init|cast|tick|cleanup">code</script> */
    scripts?: Record<string, string>;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明，来自 <modifiers> 子元素（6 大类，对齐 effect-types.ts Modifier 联合） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该元素附带的 buff 定义（由附加效果类 modifier 转换或 AI 直接声明） */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（神位级技能才填，缺省=0） */
    divinity?: DivinityLevel;
  }>;
  /** 装备列表 */
  equipment: Array<{
    /** 装备槽位 */
    slot: string;
    name: string;
    description: string;
    /** 属性加成 */
    stats: Record<string, number>;
    /** 耐久度 (可选) */
    durability?: number;
    /** 品质 (可选) */
    quality?: string;
    /** 🆕 真机 fix(2026-07-18): 词条效果 <effect name="...">...</effect> */
    effects?: Record<string, string>;
    /** 🆕 真机 fix(2026-07-18): 脚本 <script name="...">code</script> */
    scripts?: Record<string, string>;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明，来自 <modifiers> 子元素（6 大类，对齐 effect-types.ts Modifier 联合） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该元素附带的 buff 定义（由附加效果类 modifier 转换或 AI 直接声明） */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（挂整件装备，缺省=0；§6.2 决策 d） */
    divinity?: DivinityLevel;
  }>;
  /** 背包物品列表 */
  inventory: Array<{
    name: string;
    description: string;
    quantity: number;
    type: string;
    /** 稀有度 (可选) */
    rarity?: string;
    /** 🆕 真机 fix(2026-07-18): 词条效果 <effect name="...">...</effect> */
    effects?: Record<string, string>;
    /** 🆕 真机 fix(2026-07-18): 脚本 <script name="...">code</script> */
    scripts?: Record<string, string>;
    /** 🆕 战斗 v2 (M4 5.5b): 战斗管线修正声明，来自 <modifiers> 子元素（6 大类，对齐 effect-types.ts Modifier 联合） */
    modifiers?: Modifier[];
    /** 🆕 战斗 v2 (M4 5.5b): 该元素附带的 buff 定义（由附加效果类 modifier 转换或 AI 直接声明） */
    buffs?: StatusEffect[];
    /** 🆕 战斗 v2 (M4 5.5b): 登神等级 0-8（挂整件装备，缺省=0；§6.2 决策 d） */
    divinity?: DivinityLevel;
  }>;
  /** 🆕 Phase 9: 登神要素 (含 scripts + effectDescriptions) */
  elements?: Array<
    Pick<ElementDetail, 'name' | 'description' | 'effects' | 'effectDescriptions' | 'scripts'>
  >;
  /** 🆕 Phase 9: 权能 (含 scripts + effectDescriptions) */
  authorities?: Array<
    Pick<
      AuthorityDetail,
      'name' | 'description' | 'effects' | 'costDescription' | 'effectDescriptions' | 'scripts'
    >
  >;
}

/** Char Gen 链的最终结果 — char_gen → item_gen → 完整 CharacterState + Patches */
export interface CharGenChainResult {
  /** 组装后的完整角色状态 */
  character: CharacterState;
  /** 需要提交的状态补丁 */
  patches: StatePatch[];
  /** 叙事摘要 (供 vars_update 注入上下文) */
  narrativeSummary: string;
}

/** Combat Summary Agent 的输出 — 战斗结束后回注正文的摘要 */
export interface CombatSummaryResult {
  /** 战斗叙事摘要 (注入回正文上下文) */
  narrativeSummary: string;
  /** 战斗产生的状态补丁 (批量写入) */
  patches: StatePatch[];
  /** 总经验值 */
  totalExp: number;
  /** 总命运点数 */
  totalFp: number;
  /** 战利品列表 */
  loot: Array<{
    name: string;
    description: string;
    quantity: number;
    quality?: string;
  }>;
  /** 战斗回合数 */
  rounds: number;
  /** 胜负结果 */
  outcome: 'ally_win' | 'enemy_win' | 'draw' | 'fled';
}

// ========== ChatFlow 系统事件类型 (Phase 7e) ==========

/** 系统事件联合类型 — 前端根据 type 渲染不同卡片 */
export type SystemEvent =
  | CraftSystemEvent
  | CharGenSystemEvent
  | ItemGenSystemEvent
  | CombatSystemEvent
  | CharacterUpdateEvent
  | ItemUpdateEvent
  | QuestUpdateEvent;

export interface CraftSystemEvent {
  type: 'craft';
  productName: string;
  quality: QualityLevel;
  rating: CraftRating;
  narrative: string;
  details: CraftGenOutput;
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
  narrative: string;
}

export interface ItemUpdateEvent {
  type: 'item_update';
  itemName: string;
  operation: string;
  narrative: string;
}

export interface QuestUpdateEvent {
  type: 'quest_update';
  questName: string;
  status: string;
  narrative: string;
}

// ========== Geography Types (Phase G) ==========

export interface LocationNode {
  id: string;
  name: string;
  type: 'continent' | 'region' | 'city' | 'area' | 'point';
  parentId: string | null;
  tier: number;
  description: string;
  neighbors: LocationEdge[];
}

export interface LocationEdge {
  targetId: string;
  terrain: TerrainType;
  distance: number;
  fromDirection?: string;
  toDirection?: string;
}

export type TerrainType =
  | '平原'
  | '河流'
  | '沼泽'
  | '森林'
  | '山地'
  | '沙漠'
  | '海洋'
  | '冻原'
  | '冰原'
  | '湿地'
  | '城市'
  | '飞艇';

export interface TravelResult {
  path: LocationEdge[];
  totalDistanceKm: number;
  travelTime: { walk: number; ride: number; carriage: number; teleport: number };
  dangerLevel: number;
}

// ═══════════════════════════════════════════════════════════
// Phase 7e — Map System Types
// ═══════════════════════════════════════════════════════════

/** 地图标记图标 — Font Awesome class names */
export type MapMarkerIcon =
  | 'fa-solid fa-location-dot'
  | 'fa-solid fa-star'
  | 'fa-solid fa-flag'
  | 'fa-solid fa-landmark'
  | 'fa-solid fa-skull-crossbones'
  | 'fa-solid fa-city'
  | 'fa-solid fa-mountain'
  | 'fa-solid fa-tree'
  | 'fa-solid fa-water'
  | 'fa-solid fa-campground';

/** 地图标记 — 对齐原版 map-markers.d.ts */
export interface MapMarker {
  id: string;
  name: string;
  group?: string;
  description?: string;
  imageUrls?: string[];
  icon?: MapMarkerIcon;
  color?: string;
  /** OSD 归一化坐标 (0-1)，原点左上角 */
  position: { nx: number; ny: number };
}

// ═══════════════════════════════════════════════════════════
// Audio System — 音频子系统 (Dexie v11)
// 设计: docs/planning/2026-07-26-audio-system-design.md §2
// ═══════════════════════════════════════════════════════════

/** Where the audio bytes come from. 'url' was cut from v1 — re-adding it is purely additive. */
export type AudioSourceKind = 'blob' | 'builtin' | 'file';

/** What the track is for. Drives decode policy; the size guard (§4.4) is the rail when it's wrong. */
export type AudioTrackKind = 'music' | 'sfx';

/** Track metadata — cheap to list, holds no audio bytes (§3.2) */
export interface AudioTrack {
  id: string;
  name: string;
  kind: AudioTrackKind;
  source: AudioSourceKind;
  url?: string; // source='builtin': the manifest path
  mimeType?: string;
  size?: number; // compressed bytes
  duration?: number; // seconds, backfilled after first load
  tags: string[]; // scene tags — the AI hook's only addressing scheme (§8)
  builtin?: boolean; // cannot be deleted, only hidden
  /** source='file': filename within the library folder. The folder handle is stored separately. */
  relativePath?: string;
  /** source='file': the file was gone at last scan. Row is kept so tags/playlist slots survive. */
  missing?: boolean;
  /**
   * sha-256 of the bytes, written by the unified zip importer (D12 / §4.4).
   *
   * **Non-indexed property — needs no Dexie version bump.** Only new writes carry it;
   * rows without it fall through to `uniqueAudioName` exactly as before, and existing
   * tracks are never rewritten. Absent whenever `crypto.subtle` was unavailable
   * (insecure context), in which case dedupe is skipped rather than approximated.
   */
  hash?: string;
  /**
   * Attribution carried by an import pack's `manifest.json` (D10 / §5.2), and the
   * only place it can survive — a filename cannot express it.
   *
   * **Non-indexed properties — no Dexie version bump**, same as `hash` above: only new
   * writes carry them, rows without them behave exactly as before, and existing tracks
   * are never rewritten. Absent when the pack shipped no manifest entry for the file.
   *
   * The built-in library already models this per track in `public/audio/manifest.json`
   * (`credit: "Aoo"` / `license: "PLACEHOLDER-PENDING-REVIEW"`); before these columns
   * existed those values reached no Dexie row at all, so attribution died at the
   * loader. Retrofitting it onto a shipped library is materially harder than carrying
   * it from the start (§12).
   */
  credit?: string;
  license?: string;
  createdAt: number;
  updatedAt: number;
}

/** Audio bytes, stored apart from metadata and read only at play time */
export interface AudioBlobRecord {
  id: string; // === AudioTrack.id
  blob: Blob;
}

/**
 * Persisted File System Access handle for the user's music library folder.
 * Handles are structured-cloneable, so IndexedDB stores them directly —
 * they cannot go in localStorage; they are not JSON.
 */
export interface AudioHandleRecord {
  id: string; // 'library-root' — one row today
  handle: FileSystemDirectoryHandle;
  addedAt: number;
}

/** Playlists are a sequencer concept — music tracks only (§4.3) */
export interface AudioPlaylist {
  id: string;
  name: string;
  trackIds: string[]; // ordered; dangling ids pruned on track delete
  createdAt: number;
  updatedAt: number;
}

export type AudioRepeatMode = 'off' | 'all' | 'one';

/**
 * Discrete playback state. Deliberately excludes position — that is a getter
 * sampled on demand, never broadcast (§6.3).
 */
export interface AudioPlaybackState {
  music: {
    status: 'idle' | 'playing' | 'paused';
    trackId: string | null;
    playlistId: string | null;
    index: number;
    durationSec: number;
    volume: number; // 0..1, channel gain
    muted: boolean;
    repeat: AudioRepeatMode;
    shuffle: boolean;
  };
  sfx: {
    volume: number;
    muted: boolean;
    liveVoices: number;
  };
  masterVolume: number;
  masterMuted: boolean;
  /** AudioContext resumed by a user gesture yet (§7) */
  unlocked: boolean;
}

// ═══════════════════════════════════════════════════════════
// Asset System — 素材子系统 (Dexie v13)
// 设计: docs/planning/2026-07-29-asset-management-system-design.md §2 / §4.1
// ═══════════════════════════════════════════════════════════

/**
 * 素材类型（D4）。三者都可导入，v1 **一个都不渲染** —— v1 只交付管理系统，
 * 类型先立好，今天打包的素材包才能活到 v2。
 *
 * 为什么住在 types.ts 而不是 field-enums.ts: field-enums.ts 只收 **AI 提名**
 * 的游戏数据枚举（每个都配一个 normalize*()，铁律5 治的是模型输出漂移）。
 * AssetType 由用户在 UI 控件里选，模型永不提名它 —— 与 AudioSourceKind /
 * AudioTrackKind 同级，照音频先例走。
 */
export type AssetType = '头像' | '立绘' | '立绘bg';

/**
 * 素材大类。v1 只有 'character' —— 头像/立绘/立绘bg 都是角色美术。
 * 别名保留是因为 背景/全景/CG/misc 迟早要来；那时这里加联合成员即可。
 *
 * **永不落库**（§4.1）: 由 type 经 `categoryForType()` 派生，
 * 存一份就是第二个真相来源，违反铁律4（每类数据唯一真源）。
 */
export type AssetCategory = 'character';

/**
 * AssetType 的运行时清单 —— 文件名解析要拿它做**整段相等**比对
 * （见 asset-types.ts 的 isAssetTypeToken）。顺序即 UI 展示顺序。
 */
export const ASSET_TYPES: readonly AssetType[] = ['头像', '立绘', '立绘bg'];

/**
 * 一张素材在它的显示框里怎么摆 —— 焦点 + 缩放，**不改字节**。
 *
 * 为什么存在: 右栏那种「顶对齐的大画像」拿到的框比图窄得多，`object-fit: cover`
 * 只会按框中心裁，于是一张全身立绘被裁成腰腹。裁剪编辑器（另做真裁）解决的是
 * 「我要从这张源图切出头像和立绘」，而 framing 解决的是**同一张图在不同框里怎么摆**
 * —— 后者必须可逆、可反复调，所以只能是元数据，绝不能烘进字节。
 *
 * 三个字段刻意都是**与框尺寸无关的百分比/倍数**，而不是像素偏移: 框会随主题、
 * 缩放、窗口宽度变，存像素的话换个主题就全偏了。渲染侧的对应写法是
 * `object-position: x% y%` + `transform: scale()`（或等价的 background-size/position）。
 *
 * **单位与端点是契约的一部分**，别改口径:
 * - `x` / `y` 是 CSS `object-position` 的百分比语义 —— 0% 表示"图的左/上边贴框的左/上边"，
 *   100% 表示右/下边贴齐。所以 `y: 0` 就是**顶对齐**（脸在上方的画像最常要的那个）。
 * - `scale` 的 1 表示"恰好 cover"，即图刚好铺满框、没有多余部分可平移。
 *   小于 1 会在框里露出空白，所以下限就是 1；上限 3 是「放大到能只取一张脸」够用、
 *   同时不至于让一张 512px 的图糊成马赛克的经验值。
 *
 * ⚠️ 落库但**不建索引**（Dexie v13 的 `assetMeta` 索引串不含它）。Dexie 的
 * `stores()` 只声明索引，不声明列 —— 非索引字段随对象整体存取，**加它不需要升版**。
 * 反过来说也别指望能按 framing 查询，也不该有人这么查。
 *
 * 归一化: 任何来路不明的 framing（存量行没有、手改过的库、旧版写的越界值）
 * 一律先过 `clampAssetFraming()`（asset-types.ts）再交给渲染 —— 渲染层永远
 * 不该收到 NaN，一个 NaN 会让整条 CSS 声明失效，表现成"这张图偶尔没对齐"。
 */
export interface AssetFraming {
  /** 水平焦点 0-100(%)，50 = 居中 */
  x: number;
  /** 垂直焦点 0-100(%)，0 = 顶对齐 */
  y: number;
  /** 缩放倍数，1 = 恰好 cover；有效范围 [1, 3] */
  scale: number;
}

/**
 * 没调过的那张图该怎么摆 —— **顶对齐、水平居中、不放大**。
 *
 * 为什么默认 `y: 0` 而不是 50: 这三个类型全是角色美术，脸在上方。居中裁一张
 * 全身立绘得到的是腰，顶对齐得到的是脸 —— 后者在"用户还没调过"这个最常见的
 * 状态下明显更对。
 *
 * `Object.freeze` 不是洁癖: 这是个**被到处引用的共享默认值**，谁写一句
 * `row.framing = DEFAULT_ASSET_FRAMING` 再拖一下滑块，全库的默认值就一起变了。
 */
export const DEFAULT_ASSET_FRAMING: AssetFraming = Object.freeze({ x: 50, y: 0, scale: 1 });

/**
 * 素材元数据 —— 列表用，不含字节（字节在 assetBlobs 表，理由同音频 §3.2）。
 */
export interface AssetMetaRecord {
  id: string;
  /** 原始字符串，用 `===` 匹配角色名，**不做任何归一化**（D2） */
  name: string;
  type: AssetType;
  /** 情绪/表情，以及碰撞时自动分配的编号（D11） */
  variant?: string;
  /** 小写，不含点 */
  ext: string;
  mime: string;
  /** 未压缩前的字节数 */
  bytes: number;
  /** sha-256；`crypto.subtle` 不可用时缺省，此时退化到编号路径（§4.4） */
  hash?: string;
  /** 素材作者署名 —— 文件名带不了，只能由 manifest.json 补（D10） */
  credit?: string;
  license?: string;
  /**
   * 这张图在显示框里怎么摆（{@link AssetFraming}）。
   *
   * **可选，且缺省就是"没调过"** —— 不是"数据缺失"。存量行、导入进来的新行都没有它，
   * 读方一律 `clampAssetFraming(row.framing)` 拿到 {@link DEFAULT_ASSET_FRAMING}。
   * 非索引字段，加它**不需要 Dexie 升版**（见 AssetFraming 的说明）。
   *
   * ⚠️ **不进 zip 往返**: 文件名承载不了它，manifest 又只准补 tags/credit/license（D10）。
   * 所以导出再导入之后 framing 会回到默认 —— 这是刻意的取舍，不是漏做:
   * 它是"这台机器上这个框里怎么摆"的本地偏好，不是素材本身的属性。
   */
  framing?: AssetFraming;
  createdAt: number;
  updatedAt: number;
}

/**
 * 素材字节 —— 与元数据分表存储（§4.1），照 AudioBlobRecord 先例。
 * 分表的意义: `assetMeta.toArray()` 列全库时永不反序列化任何字节。
 * **存 Blob，永不 base64**（§4.2: base64 +33% 不可回收，且主线程反序列化）。
 */
export interface AssetBlobRecord {
  id: string; // === AssetMetaRecord.id
  blob: Blob;
}
