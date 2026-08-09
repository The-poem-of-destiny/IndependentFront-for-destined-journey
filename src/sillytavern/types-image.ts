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

import type {
  CharacterAppearance,
  CharacterAppearancePatch,
  ParsedCharacterAppearance,
} from './character-appearance';

// ═══ 开关与分级 ═══

/** 三档开关（D14） */
export type ImageGenMode = 'off' | 'manual' | 'auto';

// ═══ 出图后端（图像 v2 / C1）═══

/**
 * 出图后端标识（C1）。
 *
 * 🔴 **与方言正交**（C2）：后端说的是「谁来画」，方言说的是「怎么跟它说话」。
 * ComfyUI 上同时挂动漫检查点与 krea2 —— 吃法不是后端的属性，所以两者各有一个字段，
 * 绝不合并成一个「模式」枚举。
 */
export type ImageProviderId = 'novelai' | 'comfyui';

/**
 * 一个后端的**能力位**（C1）—— 装配层与限额层据此分叉。
 *
 * 🔴 **能力位属于 provider，不属于方言**（C7）：方言是纯数据、由内容包提供，
 * 让它声明「我支持角色槽」等于让内容作者宣布一件后端做不到的事，而**败法是静默丢角色**
 * （没有报错，只是画面里少了个人）。所以这三格由引擎按后端硬定义。
 */
export interface ImageProviderCapabilities {
  id: ImageProviderId;
  /**
   * 有没有 per-character 提示词槽（C7）。
   * NAI V4 有（官方抗串味手段，§6.2）；ComfyUI 没有 —— 装配层把各角色 positive
   * 按标记顺序压平进 base、negative 并进 baseNegative。
   */
  supportsCharacterSlots: boolean;
  /**
   * 谁付钱（C9）。`'paid'` 才启用 L1/L2 花钱防线；`'local'` 不设上限。
   * L3（同回合去重）是**正确性**规则，与本字段无关，对所有后端恒开。
   */
  costModel: 'paid' | 'local';
  /**
   * 单次请求的超时（C13）。
   * 🔴 **是后端属性不是全局常量**：NAI 的 120s 拿去卡本地 ComfyUI，会把一张仍在渲染的图
   * 记成失败，随后它又悄悄落进输出目录 —— 用户看到的是「失败了但硬盘上有图」。
   */
  defaultTimeoutMs: number;
}

// ═══ 提示词方言（图像 v2 / C3·C4）═══

/**
 * 一条**提示词方言** —— 「怎么跟这个画图模型说话」的**整个装配契约**（C3/C4）。
 *
 * 🔴 **不是只换一句 systemPrompt**。只换侧链提示词的话，`composePrompt` 螺栓上去的
 *    六段一段都不会变，krea2 仍会收到 `…, night, rain, wide shot, rating:explicit,
 *    masterpiece, no text` 这种 danbooru 尾巴。所以分隔符、归一化、外貌渲染器、
 *    世界/分级/人数三段的形态、负向支不支持、后缀、基础负向、构图词**全在方言里**。
 *
 * 🔴 **纯数据 + 封闭旋钮集**（C4）：私有内容仓不能跨边界发代码，所以行为被压成引擎
 *    解释的封闭枚举。加旋钮要同时改引擎的解释器 —— 这正是我们想要的摩擦，
 *    它让「内容包能改什么」永远是一份看得见的清单。
 *
 * 落点：`data/content/image-dialects.json`，内容注册表第 7 面（pack 可整份替换）。
 */
export interface ImageDialect {
  /** 稳定标识，用户设置与 `SceneImageRecord.dialectId` 都存它 */
  id: string;
  /** 设置页下拉里显示的中文名 */
  label: string;
  /** 段与段之间的连接串。danbooru 系是 `', '`，散文系是 `'. '` */
  separator: string;
  /**
   * 归一化器（`'none'` 时恒等）。
   * danbooru 档会折叠空白、统一半角标点、去重标签；散文档**必须**是 `'none'` ——
   * 拿标签归一化去洗一个英文句子，洗出来的是碎片。
   */
  normalize: 'danbooru' | 'none';
  /** 角色外貌九槽渲染成哪种形态（`renderAppearance*` 二选一） */
  appearance: 'danbooru' | 'prose';
  /** 世界状态段（时段/天气，D39）：出标签还是整段不出。`'phrase'` 预留，v2 不做 */
  world: 'tags' | 'none';
  /** 分级段：出 `rating:*` 标签还是不出 */
  rating: 'tag' | 'none';
  /**
   * 人数段：出 `1girl` / `2girls` 这类标签还是不出。
   * 🔴 剥离模型自写人数标签的那条正则**只在本档为 `'tag'` 时启用** ——
   *    它只匹配 tag 形态，但散文里的 "two women" 不该有任何正则去碰。
   */
  count: 'tag' | 'none';
  /**
   * 这套吃法认不认负向提示词。
   * flux / krea 这类 CFG 1.0 的模型**根本不吃**；`false` 时 UI 要**可见地禁用**
   * 负向输入框，而不是收下再静默丢掉（C6）。
   */
  supportsNegative: boolean;
  /** 画质后缀（拼在**末尾**，顺序即权重）。散文档通常为空串 */
  qualitySuffix: string;
  /** 基础负向。`supportsNegative:false` 时应为空串 */
  baseNegative: string;
  /** 固定构图词 */
  composition: string;
  /**
   * `image_prompt` 侧链的 systemPrompt。
   *
   * 空串 = 本方言没自带提示词，装配层回落到别处（agent-config / 模板）——
   * **不是错误**，所以解析器不为空串报警。
   */
  systemPrompt: string;
}

/**
 * 用户对某条方言四个字符串旋钮的覆盖（C6）。
 *
 * 🔴 **按方言 id 键控，不是全局一份**：全局单份会把用户为 danbooru 调的画质后缀
 *    原样带进 prose 档，静默废掉整个特性。存储形状是
 *    `imageDialectOverrides[dialectId]`，缺席/空串 = 回落方言 JSON 的默认值。
 *
 * 🔴 **空字符串不算覆盖**（`resolveImageDialect` 的合并规则）：设置页的输入框清空
 *    表达的是「我不改了，用默认」，不是「我要一个空的画质后缀」。想要真的清空，
 *    该由方言自己（或私有仓的方言）把默认值写成空串。
 */
export interface ImageDialectOverride {
  systemPrompt?: string;
  qualitySuffix?: string;
  baseNegative?: string;
  composition?: string;
}

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
  /**
   * 还没有外貌基线的角色名（D57）。
   *
   * 🔴 **模型自己判断不出「这是不是第一次出场」** —— 它看不到库。规则里那句
   *    「第一次出场就把九个槽写全」于是永远不会触发，D57 在实践中不可达。
   *    引擎知道谁没有基线，就该直接告诉它。这与 D39（时段天气由 Code 给）
   *    是同一条：Code 知道的事实不要问 AI。
   */
  charactersNeedingBaseline?: string[];
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
  /**
   * 这一段正文里 AI 观察到的**角色外貌变化**（D56/D57）。缺席或空数组 = 没有变化。
   *
   * 🔴 与场景串走**同一次调用**：那一段正文侧链本来就在看，「她换了身衣服」正是从
   *    同一份材料里读出来的。另开一次 LLM 是双倍的钱与延迟换一个更差的答案。
   */
  appearances?: ParsedCharacterAppearance[];
}

// ═══ 渲染分段 ═══

export type NarrativeSegment =
  { kind: 'text'; text: string } | { kind: 'image'; occurrence: number; marker: SceneImageMarker };

// ═══ 视觉预设（只剩角色，D59）═══

/**
 * 🔴 **地点预设已废除（D59，2026-08-04）**，这个联合从此只有一个成员。
 *
 * 理由是**地点无法穷举**：总能再往下找到一个子地点（宫殿 → 宴会厅 → 宴会厅的盥洗室）。
 * 给「宫殿」写一份定义，画盥洗室时它就是错的；给每个子地点都写，那是永远写不完的表。
 * 角色与地点在这件事上根本不同 —— 角色是**有限的实体清单**，地点是无限的层级空间。
 * 地点现在由 `image_prompt` 侧链在场景串里现写（它本来就收 `location` 字段）。
 *
 * 留成联合类型而不是直接删掉，是因为 D56 之后这里还要长出别的**角色侧**分支
 * （初始定义 / 会话定义）；到那时它仍是「这条预设是什么」的那个字段。
 */
export type ImagePresetKind = 'character';

/**
 * Dexie v19 `characterAppearances` —— 角色外貌的**会话副本**（D56）。
 *
 * 🔴 **按存档隔离，删存档连带删**：它记的是「这一周目里她现在长什么样」。
 *    基线（`ImagePreset.appearance`）是全局的、干净的、用户可编辑的；这一份由出图 AI
 *    自动写入，脏了随时可以重置回基线（每角色一个重置 / 整档一个重置）。
 *
 * 存的是 **patch 而不是全量快照**（`diffFromBase` 的产物）：只记与基线不同的槽。
 * 存全量的话，「重置」会退化成「重置回一堆基线的复制品」，而且基线日后被用户改了
 * 也传导不到已有存档。
 */
export interface CharacterSessionAppearance {
  /** 主键 = `` `${saveId}:${name}` ``。名字是**原始字符串**（铁律 1，不归一化） */
  key: string;
  saveId: string;
  name: string;
  /** 只含与基线不同的槽；空对象 = 与基线一致（正常不落库，见 `isMeaningfulPatch`） */
  patch: CharacterAppearancePatch;
  updatedAt: number;
}

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
  /**
   * 外貌**基线**的属性槽（D56/D58）。缺席 = 这条还是老的手写预设，装配时退回
   * `dialects.danbooru`。
   *
   * 🔴 槽在则以槽为准：两者都有时**不合并**——那会让同一个特征出现两次且措辞不一，
   *    正是 D58 要消灭的歧义。迁移路径是把手写串填进槽，不是让两者共存生效。
   */
  appearance?: CharacterAppearance;
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
export type AnlasFreeAllowanceBreach =
  | 'pixels'
  | 'steps'
  | 'samples'
  | 'invalid-input'
  /**
   * 账户档位不是 Opus（Tablet / Scroll / 免订阅买点数）—— **免费额度整个不存在**，
   * 每张都按牌价扣 Anlas。参数本身可能完全在 Opus 免费档内，所以这一项与
   * `pixels`/`steps` 互不蕴含：它说的是「谁在付钱」，不是「参数超没超」。
   */
  | 'no-free-allowance'
  /**
   * 用户还没说自己是哪一档（默认值）。**一律按会花钱报**，与 `invalid-input` 同一条
   * doctrine：把「不知道」显示成「免费」是这个指示器最不该犯的错。UI 靠这一项把
   * 「确定要花钱」与「取决于你的订阅」分开措辞。
   */
  | 'tier-unknown';

/**
 * NovelAI 账户档位 —— 决定**免费额度存不存在**（2026-08-04 真机实测催生）。
 *
 * 起因：`NAI_ANLAS_RULES` 编码的是 **Opus 专属**的免费生成规则（单张 / 面积 ≤ 1024² /
 * 步数 ≤ 28）。默认的 `1216×832 / 23 步` 满足全部三条，于是指示器对**任何**账户都显示
 * 「在免费额度内」。对 Tablet / Scroll、以及免订阅直接买 Anlas 的账户，这句话是**错的**：
 * 那些账户每张都扣约 17 点，而界面正告诉他不要钱。
 *
 * - `opus`    —— Opus 订阅：满足三条即不扣点
 * - `metered` —— Tablet / Scroll / 免订阅买点数：**没有免费额度**，每张按牌价扣
 * - `unset`   —— 默认。没说 = 不猜，一律按会花钱报并说明取决于档位
 */
export type NaiBillingTier = 'opus' | 'metered' | 'unset';

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

  /**
   * 哪个后端画的（C14，图像 v2）。
   *
   * 🔴 **缺席 = `'novelai'`**。v1 的记录里没有这个字段，而它们**全部**是 NAI 画的 ——
   * 缺省读作 novelai 让老记录免迁移，写入侧照常一律显式写。别把 `undefined` 读成
   * 「不知道」再去弹一个「无法重画」，那是给历史记录凭空造一个残缺态。
   */
  provider?: ImageProviderId;
  /**
   * 用哪条方言装配的（C14）。
   *
   * 重画时与**当前**方言比对：一致 → 复用缓存的 `scenePrompt`（D31 的缓存只在方言内
   * 有效）；不一致 → 重跑 `image_prompt` 侧链。缺席 = v1 老记录，按 danbooru 系处理。
   */
  dialectId?: string;
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

  /**
   * 装配这张图时攒下的告警（C15）。缺席或空数组 = 装配一切正常。
   *
   * 🔴 落库是为了让告警**有人消费**：`ComposedPrompt.warnings` 在 v1 里产出后
   * 全仓无人读，于是「这个角色在当前方言下没有可用形象，已跳过」这件事对玩家完全不可见 ——
   * 他只看到画面里少了个人。CG 详情页读这一格，写一行说明为何某角色缺席。
   * 🔴 刻意**不做运行时 toast**：每张图都会响。
   */
  composeWarnings?: ComposeWarning[];

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

/**
 * 一个存档的插画用量（只读统计，§7.5）—— 设置页「存档数据」分区那一行的数据源。
 *
 * 🔴 用量是**每存档**的数字，所以它归存档数据分区（那里本来就有 saveId 上下文），
 * 不在图像分区 —— 图像分区整个存的是全局 `UiSettings`，把「本存档 20 MB」摆在
 * 一屏全局设置里会被读成「总共 20 MB」。
 *
 * 「张数」有两个都不多余的口径：`storedCount` 是**占着字节**的，`records` 是图鉴
 * 目录的长度（含清理过的）。清理之后前者归零而后者一条不少 —— 这正是 D47 想让
 * 用户看见的事。
 */
export interface SceneImageUsage {
  /** 记录总数，含 `blobDropped` 的（= 图鉴目录长度） */
  records: number;
  /** 仍占着字节的记录数 */
  storedCount: number;
  /**
   * 上述记录的字节合计。
   *
   * 取的是记录里的 `bytes` 元数据而**不是**去把 Blob 一个个读出来量 —— 后者要把
   * 整个存档的图都materialize 一遍，只为在设置页显示一行字。`bytes` 缺失的记录按
   * 0 计（那是写入侧的漏，不该在这里补猜）。
   */
  storedBytes: number;
  /** 其中被收藏的 —— 清理默认豁免（D6 留的位 / §7.5） */
  favoriteCount: number;
  /** 收藏那部分的字节合计 */
  favoriteBytes: number;
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
  | 'bad-response' // content-type 不是 zip，或 zip 里没有图
  /**
   * ComfyUI: 图**在跑起来之前**就被拒（缺 checkpoint、未知节点、占位符替换失败）。
   *
   * 🔴 与 `execution` **重试语义相反**，所以是两类不是一类（C12）：图本身有问题，
   * 再按一百次「重试」都是同样的拒绝。文案要点名违规的节点 id。
   * 🔴 `POST /prompt` 会带着 `node_errors` 返回 **HTTP 200** —— 只看状态码的分类器
   * 会把它当成功。判据必须落在响应体上（与 v1「content-type 撒谎扔掉付费图」同形状的坑）。
   */
  | 'workflow'
  /** ComfyUI: 跑到一半挂了（OOM、节点崩溃）。**可重试** —— 换个时机常常就过了（C12） */
  | 'execution';

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
