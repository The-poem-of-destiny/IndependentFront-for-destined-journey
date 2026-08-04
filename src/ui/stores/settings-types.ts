/**
 * `settings-store` 的状态形状（Q-18）。
 *
 * ## 为什么它值得单独一个文件
 *
 * 这袋子是全应用**最热**的状态：模型选择、温度、systemPrompt、世界书勾选、
 * 主题、音量、剧情偏好全在里面，九个组件用 `const s = settings.settings` 拿到别名后
 * 直接把 `v-model` 绑在 `s.<任意键>` 上。此前它的类型是 `Record<string, any>`，于是：
 *
 * - 模板里一个笔误（`agentTopp` / `hoverDelayMS`）**不是错误**，是一个被 deep watch
 *   永久写进 localStorage 的幽灵键；
 * - 每个消费点自己重新声明一遍形状（`as boolean` / `as Record<string, string[]>` /
 *   `as 'tiered' | 'dense'`），三十来处，各自可以漂移；
 * - 失败只在真机上表现成「设置页改了、引擎行为没变」，正是 debug loop 里最贵的一类。
 *
 * ## 🔴 为什么是 `type` 而不是 `interface`
 *
 * TypeScript 只给**类型别名**隐式索引签名，不给 `interface`。而这袋子整份会被传进
 * 五处 `settings: Record<string, unknown>` 参数（`serializeSettingsForLocalStorage`、
 * `containsApiPoolKey`、`migrateApiKeysToDexie`、`runLegacyMigration`、
 * 各 `*-migration.ts`）—— 写成 `interface` 会让这五处当场编译不过。
 *
 * 也**不能**为此加一条 `[key: string]: unknown` 显式索引签名：那会让 `s.agentTopp`
 * 重新变成合法的 `unknown`，把这次改动的全部收益退回去。
 *
 * ## 🔴 哪些键刻意不在这里
 *
 * 迁移标志位与已迁出的历史大块（`worldBooksMigratedAt` / `worldBooks` /
 * `beautifierRules` / `beautifierPresetRules` / `apiKeysMigratedAt` / …）**一个都不声明**。
 * 它们只被 `*-migration.ts` 通过 `Record<string, unknown>` 参数按运行时字符串键读写，
 * 隐式索引签名已经让那条路走得通；而声明它们会招来两个后果：
 *   1. `settings-store.ts:135-138` 与 `:203-207` 两段注释明写「留个默认值会让消费端
 *      以为这里仍是真相来源，而 deep watch 又会把它写回 localStorage」；
 *   2. 应用代码从此可以 `s.worldBooks` 直接读写 —— 那正是 Phase 0 / P0b 花力气搬走的东西。
 *
 * 不声明 = 应用代码碰它就是编译错误，迁移模块照常工作。这是想要的效果。
 */
import type { ApiEntry, PresetItem } from './settings-store';
import type { AgentSettingsEntry } from './agent-settings';

/** 剧情难度层级。`'adaptive'` = 按玩家层级动态；数字 = 钉死 T1-T7 */
export type PlotDifficultyTier = 'adaptive' | number | string;

/** 快照保留模式（`main.ts` 原样转发给引擎的 `EngineSettings`，无运行时校验） */
export type SnapshotRetentionMode = 'tiered' | 'dense';

/** 播放列表循环模式 */
export type AudioRepeatMode = 'off' | 'all' | 'one';

export type UiSettings = {
  // ═══ API 池 ═══
  /** 🔴 落 localStorage 前 `apiKey` 会被抹成空串；真密钥在 Dexie `apiEndpoints` */
  apiPool: ApiEntry[];

  // ═══ Agent 配置 ═══
  /** 设置页当前选中的 Agent（null = 还没选） */
  activeAgent: string | null;
  /** per-Agent 设置，一个 agent 一条。唯一读写口是 `agent-settings.ts` */
  agents: Record<string, AgentSettingsEntry>;
  /**
   * 「这个 Agent 有未保存的改动」。
   * 🔴 今天全仓 **15 处写、0 处读**（Q-18 核查）—— 本该驱动子导航上的「●」角标，
   *    那个角标没有被实现。不是设置，所以不进 `agents`。
   */
  agentDirty: Record<string, boolean>;
  /** 提示词输入框被改动过。🔴 同样是**只写不读**的状态（9 写 0 读） */
  agentPromptEdited: boolean;

  // ═══ 预设系统（正文 Agent 专用）═══
  presets: PresetItem[];
  activePresetId: string;

  // ═══ 世界书（书本体在 Dexie，这里只有 UI 选择/开关）═══
  activeWorldBookId: string | null;
  worldBookDirty: boolean;
  /** 允许编辑内置世界书（默认只读保护） */
  allowEditBuiltInBooks: boolean;

  // ═══ 剧情系统（新档默认值，捏人页初始化时读入）═══
  /** `'off' | 'side' | 'main'`，但历史数据可能是别的字符串，故不收窄 */
  plotMode: string;
  plotDurationYears: number;
  /**
   * 🔴 类型是 `string | number` 而**不是**收窄的联合，因为两个写入方形状不同：
   * 设置页的 `<select>` 写字符串（`'adaptive'` / `'1'`…`'7'`），
   * `create-store` 写数字。消费端 `create-store.ts:875` 已经在做 `Number(tier)` 的
   * 防御性归一，这里如实声明现状，不在类型层假装它统一过。
   */
  plotDifficultyTier: PlotDifficultyTier;
  plotAllowNonWorldbookNpc: boolean;
  /** 引擎侧 `PlotSettings.main.genrePreference` 是收窄联合，这里刻意更宽 */
  plotGenrePreference: string[];
  plotCustomPreference: string;
  plotFocusRegion: string;
  plotTabooContent: string;
  /** 0 = 让 AI 自己判断 */
  plotChapterCount: number;
  /** 0 = 让 AI 自己判断 */
  plotEventsPerChapter: number;

  // ═══ 记忆 & 缓存 ═══
  memoryRecallCount: number;
  memoryCompressionThreshold: number;
  /** 🔴 `main.ts` 原样转发给引擎，无运行时校验 —— 必须是 number */
  memorySnapshotLimit: number;
  /** 🔴 同上，必须正好是这两个字面量之一 */
  snapshotRetentionMode: SnapshotRetentionMode;
  /** `'aggressive' | 'balanced' | 'conservative'`；历史值可能超出，故不收窄 */
  memoryCacheStrategy: string;

  // ═══ 交互 ═══
  /** 悬停浮层延迟（ms）。0 = 立即。全站唯一实现 `useHoverPopup` 读它 */
  hoverDelayMs: number;
  /** 额外强制开启「减少动态效果」；系统偏好始终独立生效 */
  reducedMotion: boolean;

  // ═══ 消息 & 系统事件可见性 ═══
  systemEventsVisible: boolean;
  /** 事件类型 → 是否在对话流里渲染。键是开放的（引擎可以新增事件类型） */
  systemEventFilters: Record<string, boolean>;

  // ═══ 音频（全局环境属性，不属于存档状态）═══
  audioMasterVolume: number;
  audioMasterMuted: boolean;
  audioMusicVolume: number;
  audioMusicMuted: boolean;
  audioSfxVolume: number;
  audioSfxMuted: boolean;
  audioRepeat: AudioRepeatMode;
  audioShuffle: boolean;
  audioLastPlaylistId: string;
  /** 内置曲目不可删，只能隐藏 */
  audioHiddenBuiltinIds: string[];
  /** 进入新地点时自动换 BGM。关掉后 AI 的 `<play_audio>` 也不生效 */
  audioSceneAutoPlay: boolean;

  // ═══ 输出美化（规则本体在 Dexie）═══
  beautifierEnabled: boolean;
  beautifierBuiltinDisabled: string[];

  // ═══ 下面几项**不在 `getDefaults()` 里**，但生产代码确实读它们 ═══

  /**
   * 记忆向量化用的 API 池条目 id。
   *
   * 🔴 **今天没有任何代码写它**（Q-18 核查）：`getDefaults()` 不给默认值，
   *    设置页也没有对应的选择器。于是 `GamePipeline.buildEmbeddingEndpoint()`
   *    （game-pipeline.ts:1309）永远拿到 undefined → 永远返回 undefined →
   *    `summarizeAndSave` 从不计算向量，记忆召回静默退化成纯重要度排序。
   *    记忆分区的文案却写着「Embedding 端点请在「API 配置」中添加」——
   *    加一条 `apiType: 'embedding'` 的 API 并不会设置这个键。
   *    声明成可选是**如实记录现状**，不是认可它；接线是独立一步。
   */
  embeddingEndpointId?: string | null;
  /** 覆盖 embedding 端点的默认模型。缺省同上：无人写入 */
  embeddingModel?: string;
  /**
   * 工坊安装时的 uid 发号游标（单调递增，卸载不回收）。
   * 由 `workshop-store` 按常量键读写，不进 `getDefaults()` —— 全新用户没有它。
   */
  workshopUidCursor?: number;
  /**
   * 战斗引擎分支开关（架构 §14.5）。
   *
   * 🔴 同样**无人写入**，且这是刻意的：v2 运行时已在 M5 真正删除，
   *    `game-pipeline.ts:1329` 的 `?? 'v3'` 兜底就是生产行为，打回 `'v2'` 那条
   *    分支只会弹一句退役提示。声明成可选是为了让这个读取点有类型可依，
   *    不是暗示应该给它做个开关。
   */
  combatEngineVersion?: 'v2' | 'v3';
};
