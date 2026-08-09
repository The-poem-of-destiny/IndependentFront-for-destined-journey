/**
 * image-prompt.ts — 提示词装配（设计 §5.2 / §3.2b）
 *
 * 本模块把三样东西装成一个 `ComposedPrompt`：
 *   ① `image_prompt` 侧链产出的 **danbooru 场景串**（或用户在图鉴里改过的那一版）
 *   ② 角色 / 地点**视觉预设**（`ImagePreset`，D40 起同一张表两个 kind）
 *   ③ 世界状态标签与各项常量（`ComposeOptions`）
 *
 * 🔴 **纯函数**：无随机、不读时钟、不碰 Dexie / 网络 / DOM。
 *    中文→标签的转换是一次 LLM 调用，发生在 §8.5 的侧链里，**不属于本层**
 *    （设计 §5.2 明写这条边界：否则这里会被塞进一个网络调用而失去可测性）。
 *
 * 🔴 `normalizeTagString` 由本模块 **export**，是全仓唯一一份 ——
 *    `image-prompt-agent.ts` 归一化模型输出时 import 它，不要另抄一份。
 *
 * 🔴 **装配是方言参数化的**（图像 v2 / C3，`ComposeOptions.dialect`）：分隔符、归一化器、
 *    外貌渲染器、世界/分级/人数三段的形态、负向支不支持，全部由 `ImageDialect` 决定。
 *    不传方言时逐字节等于 v1 的 danbooru 行为（`FALLBACK_IMAGE_DIALECT`），
 *    `image-prompt.test.ts` 里那条金测试就是这条保证本身。
 *
 * 类型全部来自 `types-image.ts`（本子系统的分册，见该文件头注释）；
 * 常量默认值在 `image-defaults.ts`。本文件不重复定义两者中的任何一个。
 */

import { renderAppearanceDanbooru, renderAppearanceProse } from './character-appearance';
import { baselineOf, characterPresetKey } from './character-appearance-resolve';
import { FALLBACK_IMAGE_DIALECT } from './image-dialect';
import type {
  ComposedCharacter,
  ComposedPrompt,
  ComposeWarning,
  ImageDialect,
  ImagePreset,
  ImageRating,
  SceneImageMarker,
} from './types-image';

// ═══════════════════════════════════════════════════════════
// normalizeTagString（设计 §3.2b）
// ═══════════════════════════════════════════════════════════

/**
 * danbooru 标签串的**标点归一化**。任何标签串（`image_prompt` 的输出、
 * 用户手打的预设）进装配前都要过一遍。
 *
 * 为什么必须有：产出标签串的模型工作在中文语境里，极易把全角逗号 `，` 与
 * 书名号 `《》` 带进标签串。`，` 不是合法分隔符 → 整串被当成**一个巨型标签**；
 * `《》` 会毁掉 `<lora:…>` 这类尖括号语法。两者**都不报错**，只静默产出一张
 * 莫名其妙的图 —— 最难查的那一类。
 *
 * 处理顺序（§3.2b）：
 *   ① 换行与 `<br>` → `", "`（AI 常按行分组标签）
 *   ② `《》` → `<>`（恢复尖括号语法）
 *   ③ `，` / `、` / `；` → ASCII `,`
 *   ④⑤ 折叠 `\s*,\s*` 与连续逗号 → 单个 `", "`；折叠连续空白；去首尾逗号与空白
 *
 * 🔴 **只动标点，不动内容**：权重语法（`{{}}` / `[[]]` / `-0.8::feet::` /
 *    `<lora:…>`）在第 ② 步之后一个字符都不许改。
 * 🔴 **绝不用在标记正文上** —— 那是一句中文，全角标点在那里是正确的（§3.1）。
 */
export function normalizeTagString(input: string): string {
  return (
    input
      // ① <br> 各写法与换行都视作分隔
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/[\r\n]+/g, ', ')
      // ② 恢复尖括号语法
      .replace(/《/g, '<')
      .replace(/》/g, '>')
      // ③ 全角逗号 / 顿号 / 全角分号 → ASCII 逗号
      .replace(/[，、；]/g, ',')
      // ④⑤ 一段「空白 + 逗号」的连续体整体折叠成一个 ", "
      //     （`a,,b` / `a , b` / `a,\n,b` 都收敛到 `a, b`）
      .replace(/(?:\s*,\s*)+/g, ', ')
      // 剩余的连续空白折叠成单空格（上一步已保证 ", " 内只有一个空格）
      .replace(/\s+/g, ' ')
      // 去首尾的逗号与空白
      .replace(/^[\s,]+/, '')
      .replace(/[\s,]+$/, '')
  );
}

// ═══════════════════════════════════════════════════════════
// ComposeOptions
// ═══════════════════════════════════════════════════════════

/**
 * `composePrompt` 的可配置项。
 *
 * 刻意住在本文件而不是 `types-image.ts`：它是本模块的入参形状，随本模块演进；
 * 设计 §5.2 的代码块也是这么写的。数据模型类型仍全部在 `types-image.ts`。
 */
export interface ComposeOptions {
  /** 按模型的画质后缀常量，**追加在末尾**（§6.2）。默认值见 `DEFAULT_IMAGE_QUALITY_SUFFIX` */
  qualitySuffix: string;
  /** 固定的横构图词。默认值见 `DEFAULT_IMAGE_COMPOSITION_TAGS` */
  compositionTags: string;
  /** 我们自己维护的基础负向。默认值见 `DEFAULT_IMAGE_BASE_NEGATIVE` */
  baseNegative: string;
  /** 设置里的全局追加负向 */
  extraNegative: string;
  /**
   * 🔴 **上限，不是默认值**（D38）。标记写的 rating 会被钳到这里。
   *
   * 旧名 `defaultRating` 是个陷阱：那让**模型**决定内容尺度，还能盖过用户偏好。
   * 标记没写 rating 时同样取这个值，所以「默认」的行为没变，变的是它现在还封顶。
   */
  maxRating: ImageRating;
  /**
   * 世界状态标签（D39）：时段 + 天气，由 **Code 查引擎**得出，不问 AI。
   *
   * 🔴 本函数**不做**任何时段/天气推导，只原样拼接 —— 那张中文自由文本到标签的
   * 映射表在调用方，映射不中的值一律不贡献标签。空串合法。
   */
  worldTags: string;
  /** 缺省 6（NAI 官方多角色上限，§6.2） */
  maxCharacters?: number;
  /**
   * 提示词**方言**（图像 v2 / C3）。缺省 `FALLBACK_IMAGE_DIALECT` = v1 的 danbooru 行为。
   *
   * 🔴 本参数只管**行为旋钮**（分隔符 / 归一化 / 外貌渲染器 / 世界·分级·人数三段的形态 /
   *    支不支持负向）。方言那四个**字符串**旋钮（`qualitySuffix` / `baseNegative` /
   *    `composition` / `systemPrompt`）**不从这里读** —— 它们照旧从上面那几个 opts 字段进来，
   *    由调用方先用 `resolveImageDialect` 把「方言默认值 + 用户覆盖」解析成最终值（C6）。
   *    本层若也去读 `dialect.qualitySuffix`，同一个值就有了两个来源：用户在设置里改过的
   *    覆盖会被方言的默认值悄悄顶掉，而两边都是合法字符串，**不报错也看不出来**。
   *
   * 🔴 缺省必须等价于「没有方言」那条路：`scene-image-seams` 之外还有若干调用点不传它，
   *    一旦缺省值与 v1 有一个字节的差别，那些路径就在无人察觉的情况下换了吃法。
   *    金测试（`composePrompt(..., {dialect: FALLBACK_IMAGE_DIALECT})` 与不传时逐字段相等）
   *    守的就是这条。
   */
  dialect?: ImageDialect;
  /**
   * 把角色**压平进 base**，而不是各进 `characters[]`（C7，无槽后端）。
   *
   * NAI V4 有 per-character 提示词槽（官方抗串味手段），ComfyUI 没有对应物。
   * `true` 时：每个角色的 positive 按**标记顺序**插在场景段之后、negative 并进
   * `baseNegative`，`ComposedPrompt.characters` 返回空数组。
   *
   * 🔴 能力位属于 **provider 不属于方言**（C7）：让内容包声明一件后端做不到的事，
   *    败法是**静默丢角色** —— 画面里少了个人，没有任何报错。所以这一格由引擎按
   *    后端能力传，不从 `ImageDialect` 里读。
   */
  flattenCharacters?: boolean;
}

/** 人数标签（`1girl` / `2girls` / `no humans`）—— 侧链禁写，由本函数从阵容推 */
const COUNT_TAG_RE =
  /\b(?:\d+\s*(?:girls?|boys?|others?)|no\s+humans?|multiple\s+(?:girls|boys))\b/gi;

/**
 * 从**已解析的角色槽**推出场面的人数标签（2026-08-05 真机催生）。
 *
 * 🔴 起因：人数是侧链**唯一**怎么调提示词都压不下去的错误 —— 三轮采样稳定在 22–28%
 *    写错（双人场景写成 `2girls, 1boy`、单人场景干脆不写）。而**引擎自己知道**这一格
 *    有谁：`marker.characters` 是名单，每个角色的 `count` 槽写着他是 `1girl` 还是
 *    `1boy`。既然是 Code 知道的事实，就不该问 AI —— 与 D39（时段天气）同一条。
 *
 * 只数**有槽的角色**：老的手写预设没有 `count` 槽，数不出来的宁可不写，
 * 也不猜一个可能凭空造人的标签。
 */
function deriveCountTags(
  names: readonly string[],
  presets: ReadonlyMap<string, ImagePreset>,
): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const token = (presets.get(characterPresetKey(name))?.appearance?.count ?? '')
      .trim()
      .toLowerCase();
    if (token === '') continue;
    // `1girl` / `1boy` → 归一到 girl/boy 再计数；写了别的（如 `1other`）原样计
    const m = /^(\d+)\s*(girls?|boys?|others?)$/.exec(token);
    if (!m) continue;
    const kind = m[2].replace(/s$/, '');
    counts.set(kind, (counts.get(kind) ?? 0) + Number(m[1]));
  }
  if (counts.size === 0) return '';
  const order = ['girl', 'boy', 'other'];
  return [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([kind, n]) => (n === 1 ? `1${kind}` : `${n}${kind}s`))
    .join(', ');
}

// ═══════════════════════════════════════════════════════════
// rating 钳位（D38）
// ═══════════════════════════════════════════════════════════

/** `general < sensitive < questionable < explicit`（§5.2） */
const RATING_ORDER: readonly ImageRating[] = ['general', 'sensitive', 'questionable', 'explicit'];

/**
 * 取 `min(要求, 上限)`。
 *
 * 🔴 **静默钳位、不产 warning**：上限是用户自己设的、正按预期工作；
 *    每张图提醒一句「本来可以更露骨」是纯噪音。
 *
 * 导出是给**手动开火那一侧**用的（正文按钮 / 右键「为这一段配图」）：那里在
 * `composePrompt` 之前就要把 rating 写进记录，而记录里那个值还会喂给 `image_prompt`
 * 侧链。钳位只在拼接时做的话，上限就管得住图、管不住送去侧链的那句话。
 */
export function clampRating(requested: ImageRating | undefined, max: ImageRating): ImageRating {
  const maxIndex = RATING_ORDER.indexOf(max);
  const wantIndex = requested === undefined ? maxIndex : RATING_ORDER.indexOf(requested);
  // 未知取值（类型外的脏数据）一律退回上限，绝不越过它
  const safeMax = maxIndex < 0 ? RATING_ORDER.length - 1 : maxIndex;
  const safeWant = wantIndex < 0 ? safeMax : wantIndex;
  return RATING_ORDER[Math.min(safeWant, safeMax)];
}

// ═══════════════════════════════════════════════════════════
// 拼接
// ═══════════════════════════════════════════════════════════

/** `normalize:'none'` 时的归一化器 —— 恒等 */
const identity = (value: string): string => value;

/**
 * 这条方言该用哪个归一化器。
 *
 * 🔴 `'none'` 必须是**真恒等**，不是「弱一点的归一化」：散文档吃的是英文句子，
 *    折叠标点/去重标签会把一句话洗成碎片，而碎片照样能画出图 —— 错得不显眼。
 */
function normalizerOf(dialect: ImageDialect): (value: string) => string {
  return dialect.normalize === 'danbooru' ? normalizeTagString : identity;
}

/**
 * 各段用方言的分隔符连接，**空段直接跳过** —— 绝不产出 `", ,"` 或首尾多余逗号（§5.2 不变式）。
 *
 * 每段先过一遍方言的归一化器：danbooru 档下既保证段内不会自带首尾逗号把连接搞脏，
 * 也顺手接住用户在预设里手打的全角标点（§3.2b 的「进装配前」就是这里）。
 * 归一化不动权重语法，因此透传不变式仍然成立。
 *
 * 🔴 「空不空」判的是 `trim()` 后的长度，而**推进去的是未 trim 的原值**：
 *    danbooru 档下 `normalizeTagString` 的产物本来就不带首尾空白，两种判法逐字节等价；
 *    `normalize:'none'` 档下则挡住了「一段只有空格」被当成真内容连进句子（`a.  . b`）。
 */
function joinSegments(
  segments: readonly string[],
  separator: string,
  normalize: (value: string) => string,
): string {
  const cleaned: string[] = [];
  for (const raw of segments) {
    const value = normalize(raw);
    if (value.trim().length > 0) cleaned.push(value);
  }
  return cleaned.join(separator);
}

/**
 * 取预设在**当前方言**下的正/负向。
 *
 * 🔴 **有属性槽就以槽为准（D58）**，没有才退回**同一方言的**手写串
 *    （`dialects.danbooru` / `dialects.prose`）。两者**不合并** —— 合并会让同一个特征
 *    出现两次且措辞不一（`silver hair` 与 `white hair` 同时在场），正是槽模型要消灭的
 *    那种歧义。迁移路径是把手写串填进槽，不是让两者共存生效。
 *
 * 🔴 **跨方言不透传**（C15，用户裁定）：prose 方言下只有 `dialects.danbooru` 的老预设
 *    **不降级透传**，它会走成 `missing-preset`（跳过 + 告警）。把一串 danbooru 标签塞进
 *    吃句子的模型，产出的是一张谁也没要的图，而调用方还以为角色被钉住了。告警有人消费：
 *    `SceneImageRecord.composeWarnings` 落库、CG 详情页写明某角色为何缺席。
 *
 * 负向仍从 `dialects.*.negative` 取：槽描述的是「她长什么样」，
 * 而角色负向是「别把她画成什么样」，两者不同源。
 *
 * 🔴 判据是 `baselineOf`（= 槽里**有内容**）而**不是** `preset.appearance !== undefined`。
 *    设置页的编辑器总是整份写回九个槽（D58：留空即空值），所以「只填了正向标签框、
 *    九个槽全留空」的预设带着一个**存在但全空**的 `appearance` —— 按存在性判会让它
 *    产出空串，于是这条用户明明填过的预设被当成「没有预设」丢掉，画出来是个随机人。
 *    不报错、不告警，只是那个角色永远不像。
 */
function appearanceOf(
  preset: ImagePreset | undefined,
  mode: ImageDialect['appearance'],
): { positive: string; negative: string } | undefined {
  if (!preset) return undefined;
  const handwritten = mode === 'prose' ? preset.dialects?.prose : preset.dialects?.danbooru;
  const negative = handwritten?.negative ?? '';
  const appearance = baselineOf(preset);
  if (appearance) {
    const positive =
      mode === 'prose' ? renderAppearanceProse(appearance) : renderAppearanceDanbooru(appearance);
    return { positive, negative };
  }
  return handwritten;
}

/**
 * 装配一次生成所需的完整提示词。
 *
 * @param scenePrompt   🔴 **danbooru 场景串**，来自 `image_prompt` 侧链（或用户编辑版）——
 *                      **不是** `marker.bodyText`（那是一句中文，D28）
 * @param sceneNegative 场景专属追加负向；侧链产出，通常空串
 * @param marker        角色名与 rating 仍取自标记（D30）
 * @param presets       键是 `` `${kind}:${name}` ``（`ImagePreset.key`）。**只剩角色**（D59）
 *
 * 🔴 **不再有地点参数（D59，2026-08-04）**：地点无法穷举（宫殿 → 宴会厅 → 盥洗室），
 *    穷举表永远写不完，写了也总会在下一级子地点上失效。地点现在由 `image_prompt`
 *    侧链在 `scenePrompt` 里现写 —— 侧链本来就收 `location` 字段，这里只是不再查表。
 *    代价：同一地点在两张图里不保证长得一样。要一致性的正解是把侧链**这次写出来的**
 *    地点串按名字缓存进会话，不是回头去写那张表。
 */
export function composePrompt(
  scenePrompt: string,
  sceneNegative: string,
  marker: Pick<SceneImageMarker, 'characters' | 'rating'>,
  presets: ReadonlyMap<string, ImagePreset>,
  opts: ComposeOptions,
): ComposedPrompt {
  const warnings: ComposeWarning[] = [];

  // 🔴 缺省 = v1 的 danbooru 形态。没有这一句，所有不传方言的调用点会当场换吃法
  const dialect = opts.dialect ?? FALLBACK_IMAGE_DIALECT;
  const separator = dialect.separator;
  const normalize = normalizerOf(dialect);

  // ── rating 钳位（D38），静默 ──
  // 🔴 钳位**照算不误**，即便本方言不出 rating 段：调用方拿这个值往记录里写、
  //    也往侧链里喂（见 clampRating 的注释）。只在拼接时跳过那一段。
  const rating = clampRating(marker.rating, opts.maxRating);

  // ── 人数：Code 推，且**把模型写的那个剥掉**（2026-08-05）──
  // 🔴 提示词已明令不许写人数，但规则是概率性的（三轮采样 22–28% 写错）。
  //    这里的剥离是确定性的：两个人数标签同时出现会让 NAI 画出多余的人。
  // 🔴 `count:'none'` 时**连剥离一起关掉**（C4 那条注释的原话）：`COUNT_TAG_RE` 只认
  //    tag 形态，可散文里的句子不该有任何正则去碰 —— 剥了不报错，只是把一句英文咬掉一块。
  const maxCharactersForCount = opts.maxCharacters ?? 6;
  const countTags =
    dialect.count === 'tag'
      ? deriveCountTags(marker.characters.slice(0, Math.max(0, maxCharactersForCount)), presets)
      : '';
  const sceneWithoutCounts = countTags === '' ? scenePrompt : scenePrompt.replace(COUNT_TAG_RE, '');

  // ── 角色：顺序 = 标记里 characters 的顺序（V4 的 use_order 依赖它），别排序别去重 ──
  const maxCharacters = opts.maxCharacters ?? 6;
  const names = marker.characters;

  // 🔴 截断按**标记里的名字数**算，不按最终槽位数算：这样 dropped 与预设存不存在无关，
  //    同一份标记永远给出同一份告警。截掉的名字不再查预设，也就不会同时产 missing-preset。
  const kept = maxCharacters >= 0 ? names.slice(0, maxCharacters) : [];
  const dropped = names.slice(kept.length);

  const characters: ComposedCharacter[] = [];
  let seed: number | undefined;

  for (const name of kept) {
    const preset = presets.get(characterPresetKey(name));
    const rendered = appearanceOf(preset, dialect.appearance);
    const positive = rendered === undefined ? '' : normalize(rendered.positive);
    if (positive.trim() === '') {
      // 没预设、或预设在**当前方言**下没有可用正向 = 这个槽给不出任何一致性信息。
      // 🔴 跳过该角色并告警，**不报错** —— AI 刚造的 NPC 没人写过预设，
      //    只画场景也比拒绝生成好得多。C15 让这条告警最终落库并出现在 CG 详情页。
      warnings.push({ kind: 'missing-preset', name });
      continue;
    }
    characters.push({
      name,
      positive,
      // 🔴 `supportsNegative:false`（flux / krea 那类 CFG 1.0 模型）时**当场清空**，
      //    不是收下再让下游默默丢掉 —— 后者没有任何一处看得见，用户会一直以为
      //    「别把她画成金发」这句话生效了。
      negative: dialect.supportsNegative ? normalize(rendered?.negative ?? '') : '',
    });
    // seed 取**第一个**带 pinnedSeed 的角色的值；都没有则 undefined = 随机
    if (seed === undefined && preset?.pinnedSeed !== undefined) seed = preset.pinnedSeed;
  }

  // 🔴 超出上限要**告警**，不静默丢
  if (dropped.length > 0) warnings.push({ kind: 'characters-truncated', dropped });

  // ── C7：无槽后端把角色压平进 base（场景段之后，标记顺序），负向并进 baseNegative ──
  const flatten = opts.flattenCharacters === true;
  const flattenedPositives = flatten ? characters.map((row) => row.positive) : [];
  const flattenedNegatives = flatten ? characters.map((row) => row.negative) : [];

  // ── base：顺序即权重，画质后缀压在最后（§5.2）──
  //    地点那一段没了，场景串自己带（D59）；人数由 Code 推（见 deriveCountTags）
  const base = joinSegments(
    [
      countTags, // [0] 人数 —— **Code 推的**，压在最前（NAI 靠它决定画几个人）
      sceneWithoutCounts, // [1] 场景 —— 这一刻正在发生什么（含地点长什么样）
      ...flattenedPositives, // [1.5] 无槽后端的角色（C7）；有槽后端这里是空数组
      dialect.world === 'none' ? '' : opts.worldTags, // [2] 世界状态 —— 天光如何
      opts.compositionTags, // [3] 构图
      dialect.rating === 'none' ? '' : `rating:${rating}`, // [4] 分级
      opts.qualitySuffix, // [5] 🔴 画质后缀在末尾，不是开头
    ],
    separator,
    normalize,
  );

  // ── baseNegative：全局 ∪ 追加 ∪ 场景（地点那一段随 D59 一起没了）──
  // 🔴 有槽后端下角色的 negative **不在这里** —— 它进各自的槽（官方的抗串味手段，§6.2）。
  //    只有压平模式才把它们并进来，因为那种后端根本没有槽可进。
  const baseNegative = dialect.supportsNegative
    ? joinSegments(
        [opts.baseNegative, opts.extraNegative, sceneNegative, ...flattenedNegatives],
        separator,
        normalize,
      )
    : '';

  return {
    base,
    baseNegative,
    // 🔴 压平之后 `characters` 必须是**空数组**：内容已经在 base 里了，两处都留会让
    //    NAI 形状的下游把同一个角色写两遍（`novelai.ts` 的三重冗余会照单展开）。
    characters: flatten ? [] : characters,
    warnings,
    seed,
  };
}
