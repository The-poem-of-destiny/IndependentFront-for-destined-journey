/**
 * types-image.ts — 图像生成子系统的类型集中定义（图像生成 v1 / NovelAI 情景插画）
 *
 * 设计全文: `docs/planning/2026-08-04-image-generation-design.md`（本文件 = 该设计 §4）。
 *
 * 为什么与 types.ts 分开:
 * `types.ts` 是唯一类型来源，但 CLAUDE.md「设计约定」明确允许**大型联合类型拆分为
 * `types-*.ts`**。先例是 `types-audio.ts`。与音频分册不同的是，本子系统的**数据模型类型
 * 也全部集中在此**（设计 §4 的裁定）—— 图像生成没有任何一条需要与 types.ts 的既有实体
 * 交织，集中放反而只有一个真相来源。
 *
 * 唯一的例外是 `SceneImageMarker`: 它必须进 `types.ts` 的 `DetectedMarker` 联合，
 * 那里以 type-only import 反向引用本文件。本文件**不 import types.ts**，边不成环。
 *
 * 🔴 本文件里带 🔴 的注释记录的是设计阶段已经踩到或推演出的坑，不是装饰。改之前先读设计文档。
 */

// ═══ 开关与分级 ═══

/** 三档开关（D14） */
export type ImageGenMode = 'off' | 'manual' | 'auto';

/** 内容分级。v1 只映射成 NAI 提示词里的 `rating:*` tag（§6.2） */
export type ImageRating = 'general' | 'sensitive' | 'questionable' | 'explicit';

// ═══ 标记 ═══

/** `<scene_image>` 的扫描产物。加入 `DetectedMarker` 联合 */
export interface SceneImageMarker {
  type: 'scene_image';
  rawContent: string;
  position: number;
  /**
   * 🔴 **一句中文描述**，不是 danbooru 串（D28）。空串 = 无效标记。
   * **不过 `normalizeTagString`** —— 全角标点在中文句子里是对的。
   */
  bodyText: string;
  /**
   * 已过 sanitizeCaption；可能是空串。
   * **必须来自 story**（D30）—— 手动档的按钮要在 `image_prompt` 跑之前就有标签。
   */
  title: string;
  /** 原样，未归一化（D2 / 铁律 1）。**必须来自 story**（D30）—— agent 抽名字会漂 */
  characters: string[];
  /** 缺省时为 undefined，由设置里的默认档兜底 */
  rating?: ImageRating;
}

// ═══ image_prompt 侧链（D28）═══

/** 喂给 `image_prompt` 的上下文。全部来自 Code，agent 不必自己查 */
export interface ImagePromptRequest {
  /** 标记正文：那句中文描述 */
  intent: string;
  /** 出场角色名（agent **只用来理解场景**，外观仍由预设决定，D4） */
  characters: string[];
  /** 所属消息正文（已剥掉全部标记），给 agent 判断氛围/光线/时间 */
  narrative: string;
  /** 当前地点名 —— 引擎知道，不必让 agent 猜 */
  location?: string;
  rating: ImageRating;
}

/**
 * `image_prompt` 的产出。
 *
 * 用 XML 标签而非裸文本：模型爱在答案前面写一段废话，而本仓已有
 * `story-rescue.ts` 处理同一类缺陷 —— 标签让抽取变成确定的事。
 *
 * ```xml
 * <image_prompt>tavern interior, warm candlelight, sitting, campfire, …</image_prompt>
 * <image_negative>modern clothing</image_negative>
 * <image_desc>苏婉第一次说起她的家乡</image_desc>
 * ```
 */
export interface ImagePromptOutput {
  /** 场景 danbooru 串。**已过 `normalizeTagString`**（D27） */
  scenePrompt: string;
  /** 该场景专属的追加负向；通常空串 */
  sceneNegative: string;
  /** 图鉴副标题（D30 的注解：这一条可以让 agent 写） */
  desc: string;
}

// ═══ 渲染分段 ═══

export type NarrativeSegment =
  { kind: 'text'; text: string } | { kind: 'image'; occurrence: number; marker: SceneImageMarker };

// ═══ 视觉预设（角色 + 地点，同一张表，D40）═══

/**
 * 角色预设管**人**的一致性，地点预设管**场景**的一致性 —— 两者形状完全一样，
 * 所以是同一张表加一个 `kind`，不是两张表（D40）。
 */
export type ImagePresetKind = 'character' | 'location';

/** Dexie v17 `imagePresets`，全局键控，进 FullBackup（纯文本、很小） */
export interface ImagePreset {
  /**
   * 🔴 主键 = `` `${kind}:${name}` ``。
   *
   * 合表之后不能再拿 `name` 当主键 —— 幻想设定里人名与地名撞车是会发生的
   * （某人以某地为名）。`name` 保留**原始字符串**供 `===` 匹配，主键只是它的派生。
   */
  key: string;
  kind: ImagePresetKind;
  /** 🔴 原始字符串，`===` 匹配，不 trim / 不折叠大小写 / 不 NFKC（铁律 1 / 素材系统 D2） */
  name: string;
  dialects: {
    /** v1 唯一在用 */
    danbooru?: { positive: string; negative: string };
    /** v2 的 OpenAI/Gemini 用。形状先留好（D11） */
    prose?: { positive: string; negative: string };
  };
  /**
   * 角色一致性的穷人版；缺省 = 每次随机。仅 `kind==='character'` 有意义。
   *
   * ⚠️ 同一 seed 只让构图更接近，**不保证同一张脸** —— 编辑器里要照实说。
   * 唯一实际可用的设置路径是图鉴详情的「把这次的 seed 钉给他」（§10.3），
   * 没人会手打一个十位随机整数。
   */
  pinnedSeed?: number;
  createdAt: number;
  updatedAt: number;
}

// ═══ 提示词装配的中间产物 ═══

/**
 * `image-prompt` 的输出、`novelai` 的输入。
 *
 * 🔴 **刻意不是一个字符串**：NAI V4 要把同样的内容展开到三处（§6.1），
 * 而角色是分槽位的。中间结构是三重冗余能被一处保证的前提。
 */
export interface ComposedPrompt {
  /** 场景 + 构图 + rating tag + 画质后缀（后缀在**末尾**） */
  base: string;
  /** 全局负向（我们自己维护的文本 ∪ 设置里的追加） */
  baseNegative: string;
  /** 逐角色，**顺序 = 标记里 characters 的顺序**（V4 的 use_order 依赖它）。最多 6 个 */
  characters: ComposedCharacter[];
  /** 装配过程中的可播报问题，不阻断生成 */
  warnings: ComposeWarning[];
  /** 若任一角色预设带 pinnedSeed 则取第一个；否则 undefined = 随机 */
  seed?: number;
}

export interface ComposedCharacter {
  name: string;
  /** 该角色预设的 positive */
  positive: string;
  /** 该角色预设的 negative → 进 `characterPrompts[].uc`（官方的抗串味手段，§6.2） */
  negative: string;
}

export type ComposeWarning =
  { kind: 'missing-preset'; name: string } | { kind: 'characters-truncated'; dropped: string[] };

// ═══ 限额 ═══

export type QuotaReason = 'per-message' | 'rolling-window' | 'same-turn';

export type QuotaVerdict = { ok: true } | { ok: false; reason: QuotaReason; message: string };

// ═══ Anlas 估算（D43）═══

/**
 * 🔴 **两个取值都带「估算」语义，没有一个是保证**（D43 / §11.2）。
 *
 * 刻意不叫 `isFree` / `free` 之类：NAI 的免费档规则随时会变，我们手里只有一份
 * 记录在 `NAI_ANLAS_RULES` 里的快照。说「在免费额度内」是一句提示，说「免费」
 * 是一句我们守不住的承诺 —— 名字本身就该拦住后者。
 *
 * - `within-free-allowance` —— 按当前记录的订阅规则估算，这次请求落在免费额度内
 * - `consumes-anlas` —— 按同一份规则估算，这次请求会扣点数
 */
export type AnlasVerdict = 'within-free-allowance' | 'consumes-anlas';

/**
 * 把这次请求推出免费额度的**具体**参数，供 UI 指出「是宽高还是步数超了」。
 *
 * `invalid-input` 是第四种：任一参数不是正的有限数（设置页输入框清空 → `NaN`）。
 * 读不懂的参数**一律报成会花钱**，绝不乐观 —— 这个指示器唯一的职责就是挡账单惊吓，
 * 把「不知道」显示成「免费」正好是它最不该犯的错。
 */
export type AnlasFreeAllowanceBreach = 'pixels' | 'steps' | 'samples' | 'invalid-input';

/** `estimateAnlasCost()` 的产出。全部字段都是**估算值**，见 `AnlasVerdict`。 */
export interface AnlasEstimate {
  verdict: AnlasVerdict;
  /**
   * **不计免费额度**时的单张定价估算 —— 即 §11.2 里「约 N 点/张」的 N。
   *
   * 🔴 免费额度内它也是个正数（那是这张图的牌价），别拿它判断免不免费，
   * 判断只看 `verdict`。
   */
  anlasPerSample: number;
  /** 计入免费额度后，这一次请求的总点数估算。`within-free-allowance` 时恒为 0 */
  estimatedAnlas: number;
  /** 越界项；`within-free-allowance` 时为空数组 */
  breaches: AnlasFreeAllowanceBreach[];
  /**
   * 估算依据的规则集标签，直接进 UI 那句「按当前订阅规则估算」。
   *
   * 带上它是为了让「这是哪一版规则」在界面上**看得见** —— 规则变了而我们没跟上时，
   * 用户至少知道自己在看一份什么时候的快照。
   */
  rulesetLabel: string;
}

// ═══ 落库记录 ═══

/**
 * 🔴 `queued` 与 `generating` 是**两个**状态（D35），不是一个 `pending`。
 *
 * 一条消息的多个标记串行发，第 3 张可能要等 3 分钟才开始 —— 三个一模一样的转圈
 * 会被读成「卡死了」。而且两者的**取消语义不同**：排队取消不花钱，在飞中止照样计费（D36）。
 */
export type SceneImageStatus = 'queued' | 'generating' | 'done' | 'failed';

/**
 * 图挂在哪儿（D34）。
 *
 * `marker` —— story 写的 `<scene_image>`，`occurrence` 是它在该消息里的序号（D2）。
 * `message-end` —— 玩家从右键菜单主动要的（D33），排在消息正文之后，`occurrence` 是
 *                  同类里的序号。
 *
 * 两者都只按 `messageId` 反查，所以 D2 白送的「快照回滚 → 图自动重挂」对二者同样成立。
 */
export type SceneImageAnchorKind = 'marker' | 'message-end';

export interface SceneImageRecord {
  id: string;
  saveId: string;
  messageId: string;
  /** 见 SceneImageAnchorKind（D34） */
  anchorKind: SceneImageAnchorKind;
  /** 该消息里第几个（同 anchorKind 内计数），与渲染段编号对齐（D2） */
  occurrence: number;
  /** 同一处的第几次重画，从 0 起（D17）。正文显示最大者，图鉴显示全部 */
  take: number;
  /** 剧情顺序 —— 图鉴默认排序键 + D23 同回合去重键。取自所属消息的 turn */
  turn: number;

  status: SceneImageStatus;
  /**
   * 自动开火还是玩家点的。
   * 不是审计字段，是**限流账本**：D23 只看 'auto'，滚动窗口两者都计。
   */
  source: 'auto' | 'manual';

  // ── 图鉴展示面（AI 写，用户可改，D18）──
  title: string;
  description: string;
  /** 用户收藏，将来做清理时的豁免位 */
  favorite?: boolean;
  /**
   * 用户把这一 take 钉成正文里显示的那张（D45）。
   *
   * 同一 `(messageId, anchorKind, occurrence)` 下**至多一条**为 true；没有任何一条为 true
   * 时正文显示 `take` 最大者。没有这个字段，重画就是事实上的破坏性操作 —— 新的更差时，
   * 之后每次读到这条消息都看到更差的那张。
   */
  pinned?: boolean;

  // ── 复现所需（D8：备份存的是配方）──
  /** 标记正文原文 —— story 写的**那句中文**（D28），保留原始字节供排查 */
  intent: string;
  /**
   * `image_prompt` 产出的 danbooru 场景串（已过 `normalizeTagString`）。
   *
   * **缓存在这里**，于是重试 / 重画不再重跑侧链 agent（D31）——
   * 除非用户改过（见下）。
   */
  scenePrompt: string;
  /** `image_prompt` 产出的场景专属追加负向；通常空串 */
  sceneNegative: string;
  /**
   * 用户在图鉴里改过的场景提示词。
   *
   * **存在时，「重画」优先用它、且跳过 `image_prompt`**（D26 + D31）—— 用户改完
   * 提示词点重画，结果却按 agent 的原话生成，是这类界面最挫败的一种失败。
   * `scenePrompt` 保持原样不被覆盖，于是"改回去"永远可行。
   */
  editedScenePrompt?: string;
  characters: string[];
  rating: ImageRating;
  /** 真正发出去的完整正向/负向（含预设与后缀） */
  positive: string;
  negative: string;
  model: string;
  seed?: number;
  /** 原样请求参数 */
  params: Record<string, unknown>;

  // ── 字节元数据（status='done' 时才有）──
  mime?: string;
  bytes?: number;
  hash?: string;
  /**
   * 字节被「清理」删掉了，但记录留着（D47）。
   *
   * `status` 仍是 `'done'` —— 这张图**画出来过**，那是历史事实，不因为腾空间而改写。
   * 图鉴照常列出（缩略位显示「已清理」+ 重画按钮），配方（prompt/seed/model）都还在。
   */
  blobDropped?: boolean;

  /** status='failed' 时的可读原因（已本地化，§12） */
  error?: string;
  /** 失败分类，供统计与"要不要显示重试" */
  errorKind?: ImageGenFailureKind;

  createdAt: number;
  /**
   * 真正开始发请求的时刻（进入 `generating` 时写）。
   * 用途只有一个：算「已用 N 秒」（D37）。**不要**拿 `createdAt` 算 —— 那是入队时刻，
   * 排在第三位的图会一上来就显示「已用 180 秒」。
   */
  startedAt?: number;
}

/** 字节表，与 assetBlobs 同形状 */
export interface SceneImageBlobRecord {
  id: string; // === SceneImageRecord.id
  blob: Blob;
}

// ═══ 失败分类 ═══

export type ImageGenFailureKind =
  | 'prompt-agent' // image_prompt 侧链失败：调用出错、或输出里抽不到 <image_prompt>
  | 'auth' // 401：令牌无效/过期
  | 'payment' // 402：Anlas 不足
  | 'rate-limit' // 429
  | 'bad-request' // 400：请求体不合法（带上游 detail）
  | 'upstream' // 5xx
  | 'network' // 连不上 / 超时
  | 'aborted' // 用户取消 / 切存档
  | 'bad-response'; // content-type 不是 zip，或 zip 里没有图

export interface ImageGenFailure {
  ok: false;
  kind: ImageGenFailureKind;
  /** 已本地化的一句话，直接进 UI */
  message: string;
  /** 上游原始信息，只进 console 与记录，不进 UI */
  detail?: string;
  /** 这一类要不要显示"重试"按钮 */
  retryable: boolean;
}
