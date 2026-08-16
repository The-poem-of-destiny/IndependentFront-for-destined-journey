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
 *
 * 图像 v2（C8）起同一条口径也适用于 17 个平铺 `image*` 字段里被折进袋子的那些
 * （`imageEndpointId` / `imageModel` / `imageSampler` / `imageNoiseSchedule` /
 * `imageUcPreset` / `imageNaiTier` / `imageMaxPerMessage` / `imageMaxPerHour` /
 * `imageQualitySuffix` / `imageBaseNegative`）：一个都不声明，读它们就是编译错误，
 * 搬运只发生在 `image-settings-migration.ts` 里。
 */
import type { ApiEntry } from './settings-store';
import type { AgentSettingsEntry } from './agent-settings';
import type {
  ImageDialectOverride,
  ImageGenMode,
  ImageProviderId,
  ImageRating,
  NaiBillingTier,
} from '@engine/types-image';

/** 剧情难度层级。`'adaptive'` = 按玩家层级动态；数字 = 钉死 T1-T7 */
export type PlotDifficultyTier = 'adaptive' | number | string;

/** 快照保留模式（`main.ts` 原样转发给引擎的 `EngineSettings`，无运行时校验） */
export type SnapshotRetentionMode = 'tiered' | 'dense';

/** 播放列表循环模式 */
export type AudioRepeatMode = 'off' | 'all' | 'one';

/**
 * NovelAI 后端专属设置（图像 v2 / C8）。
 *
 * 🔴 **限额（`maxPerMessage` / `maxPerHour`）住在这里而不是共享区**：L1/L2 是**花钱**
 *    防线（C9），本地后端不设上限。放在共享区会让「ComfyUI 也该有个上限吧」这个
 *    看似合理的念头随时把它接回去，而那是用户明确推翻过的裁定。
 */
export type ImageNovelaiSettings = {
  /** 指向 API 池里 `apiType: 'image'` 的那条；null = 还没选 */
  endpointId: string | null;
  /** NAI 模型 id（**不是** LLM 模型）。默认见 `image-defaults.DEFAULT_IMAGE_MODEL` */
  model: string;
  /** 采样器。默认 `'k_euler_ancestral'`（录制样本值） */
  sampler: string;
  /** 噪声调度。默认 `'karras'`（录制样本值） */
  noiseSchedule: string;
  /**
   * NAI 的 UC 预设编号，按录制值原样发。
   * 🔴 它是**每模型一套**的具名清单序号，换模型语义就变 —— 所以负向文本由方言
   *    （`baseNegative`）拿着，不靠这个字段表达。
   */
  ucPreset: number;
  /**
   * NovelAI 账户档位 —— 只喂给免费额度指示器，**不影响任何请求**。
   *
   * 默认 `'unset'` = 不猜（D43 补丁）：免费额度是 Opus 专属的，默认给乐观答案等于
   * 替按点数付费的账户宣布「这些图不要钱」。
   */
  tier: NaiBillingTier;
  /** L1 每条消息上限（auto/manual 都计入） */
  maxPerMessage: number;
  /** L2 每小时上限 —— 真正的失效保护，调大之前先读设计 §9 */
  maxPerHour: number;
};

/**
 * ComfyUI 后端专属设置（图像 v2 / C8·C16）。
 *
 * 🔴 `baseUrl` **不进 API 池**（C16）：池建模的是带 key 的远端服务，ComfyUI 是无 key
 *    的本地地址，且这一格填错的败法是诚实的 connection-refused，不是 2026-08-05 那种
 *    「上游报一句指向别处的错」。
 */
export type ImageComfySettings = {
  /** ComfyUI 服务地址。默认 `'http://127.0.0.1:8188'`（假定与应用同机） */
  baseUrl: string;
  /** 用户粘贴的 API-format 工作流 JSON。**空串 = 用内置最小 SDXL 图** */
  workflowJson: string;
  /** 单张图的整体超时（ms）。默认 600000 —— 本地渲染慢，2 分钟硬闸会把还在跑的图记成失败 */
  timeoutMs: number;
  /** `/history/{id}` 轮询间隔（ms）。默认 1500 */
  pollIntervalMs: number;
};

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
  // 🔴 内容-引擎分离波 1 / D22：`presets` 镜像已删除。预设真源是 Dexie `presets` 表，
  //    响应式视图经 `usePresets` composable。这里只剩「当前选中哪条」的 UI 状态。
  activePresetId: string;

  // ═══ 内容-引擎分离波 1 / D42：占位内容版本戳 ═══
  // 占位集随引擎打包；戳前进时 content-store 对「hash 仍等于占位基线」的书重播种（D42）。
  // 缺省 = 未比对过（首启），D42 重播种当作需要写入当前占位版本。不常驻、非必填。
  placeholderVersion?: string;

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

  // ═══ 随机事件（随机事件系统 v1 / 裁定 §13-4）═══
  //
  // 🔴 这两项是**全局设置**，不是「新档默认值」——与上面那批 plot* 刚好相反。
  //    随机事件是口味开关（比照 beautifierEnabled / imageGenMode），玩家中途想关就关；
  //    不进 PlotSettings、不进存档、零迁移。引擎侧经 `engine-settings.ts` 的注入缝读
  //    （main.ts 的 provider 转发这两格），**不进 AppSettings** —— 那会让设置重新有两个真源。
  // 🔴 与剧情系统三个 Agent 的开关**彼此独立**：`plotMode === 'off'` 时随机事件照跑
  //    （调度挂在 StateManager、注入挂在 story、marker 收在 orchestrator Stage 1，
  //    三面都不在 plot agent 链上）。

  /** 随机事件总开关。关 = 调度 no-op（**保留候选池不清**）+ 注入空串 + marker 忽略 */
  randomEventsEnabled: boolean;
  /**
   * 频率系数，乘进每次 MTTH 掷骰的权重（0.5 / 1 / 2 三档，裁定 §13-6）。
   * 🔴 类型是 `number` 而不是收窄联合：它只被乘进一个概率，越界的历史值不会让引擎崩，
   *    收窄反而会让「以后想加一档」变成一次跨引擎改动。
   */
  randomEventsFrequency: number;

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
  /** 解锁调试入口与原始 Agent 诊断；默认关闭，不影响玩家可见的语义活动账本 */
  developerMode: boolean;

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

  // ═══ 图像生成（设计 §11；图像 v2 / C8 重构成 per-provider 袋子）═══
  //
  // 🔴 这里**没有** `image_prompt` 的模型/温度/世界书 —— 那些走 `agent-settings.ts`
  //    的 `agents` 袋子（D28/D52）。两者在同一个分区里挨着渲染，但存储各归各位。
  // 🔴 也**没有**画质后缀 / 基础负向 / 侧链 systemPrompt 这三个字符串旋钮：它们是
  //    **方言属性**（C6），住在 `imageDialectOverrides[dialectId]` 里，空 = 回落方言
  //    JSON 的默认值。全局单份会把 danbooru 的调优带进散文档，静默废掉整个特性。
  //    老用户那两个平铺字段由 `image-settings-migration.ts` 迁进去。

  /** 后端。默认 `'novelai'` —— 与重构前唯一存在的那条路径一致 */
  imageProvider: ImageProviderId;
  /** 当前方言 id。默认 `'danbooru-anime'`（= `FALLBACK_IMAGE_DIALECT.id`，v1 行为） */
  imageDialectId: string;
  /**
   * 用户对某条方言四个字符串旋钮的覆盖（C6）。**按方言 id 键控**。
   * 缺席 / 空串 = 回落方言 JSON，详见 `ImageDialectOverride` 的注释。
   */
  imageDialectOverrides: Record<string, ImageDialectOverride>;

  // ── 共享（两家都读；comfy 侧作为 %token% 替换值）──
  /** 三档开关。默认 `'manual'`：手动档下多几个标记只是多几个按钮，不花钱 */
  imageGenMode: ImageGenMode;
  /** 出图宽（px）。默认 1216 —— 与 832 配成 NAI 官方横构图预设，面积卡在免费档内 */
  imageWidth: number;
  /** 出图高（px）。默认 832 */
  imageHeight: number;
  /** 采样步数。默认 23（免费档上限是 28） */
  imageSteps: number;
  /** CFG scale。默认 4.5（录制样本值） */
  imageScale: number;
  /** 🔴 **上限而非默认**（D38）：标记里写的 rating 会被钳到这里 */
  imageMaxRating: ImageRating;
  /** 正文里的插画默认打码显示，点一下才揭示（D46） */
  imageBlurByDefault: boolean;
  /** 自动档那一次性确认弹过没有（D44）。弹过就不再弹 */
  imageAutoConfirmed: boolean;
  /**
   * 用户追加的负向，拼在基础负向之后。默认空串。
   *
   * 🔴 **C6 的唯一例外：它是全局的**，不按方言键控 —— 「永远别画 X」是用户口味，
   *    不是方言属性。但 `supportsNegative:false` 时 UI 要**可见地禁用**它，
   *    而不是收下再静默丢掉。
   */
  imageExtraNegative: string;

  // ── per-provider ──
  imageNovelai: ImageNovelaiSettings;
  imageComfy: ImageComfySettings;

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
