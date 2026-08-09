/**
 * image-dialect.ts — 提示词方言的容错解析与取用（纯函数，图像 v2 / C4·C6）
 *
 * 装什么: 「一条方言的最终形态是什么」的**唯一**判定 —— 内容注册表第 7 面的容错解析
 *         （`parseImageDialects`）+ 按 id 取用并叠加用户覆盖（`resolveImageDialect`）。
 * 不装什么: 任何 I/O、任何装配逻辑。方言怎么被**用**在 `image-prompt.ts`（T2），
 *           方言 JSON 从哪来在 `content-store` 的注册表面。
 *
 * 🔴 **本模块永不抛**。方言 JSON 来自内容包（pack 可整份替换第 7 面），也就是**第三方
 *    可编辑的数据**。一个手滑的旋钮值让整条出图链炸掉是不可接受的 —— 容错原则照
 *    `workshop-manifest.ts` 的先例：认不出的值回落到 danbooru 形状的默认值，
 *    认不出的条目整条跳过，返回值永远是一个合法的 `ImageDialect[]`。
 *
 * 🔴 **注册表这一面缺席时退化成今天的行为，而不是崩**：`FALLBACK_IMAGE_DIALECT`
 *    就是 v1 那套硬编码常量（`image-defaults.ts` 的**四个**串 —— 画质后缀 / 基础负向 /
 *    构图词 / **侧链系统提示词**）穿上方言的外衣。fetch 404 / pack 把这一面清空 /
 *    用户设置里存着一个已经不存在的 id —— 三条路径全部落到它身上，画出来的图与 v1 一模一样。
 *    **提示词那一格也算数**：少了它，侧链会跑在 `agent-templates.ts` 的一行 stub 上，
 *    五条 v1 规则一条不剩，而失败是静默的（图照出、Anlas 照扣，只是内容不对）。
 *
 * 设计全文: `docs/planning/2026-08-08-comfyui-image-provider-design.md` C3/C4/C6。
 */

import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_PROMPT_SYSTEM,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from './image-defaults';
import type { ImageDialect, ImageDialectOverride } from './types-image';

// ═══ 兜底方言 ═══

/**
 * 内置兜底方言 = **v1 的行为**（C5）。
 *
 * 🔴 四个字符串旋钮直接引用 `image-defaults.ts` 的常量而**不是抄一份**：抄一份的败法
 *    是「改了默认值，兜底路径还是老的」—— 而兜底路径恰恰是没人会去手工验的那条。
 *
 * 🔴 `systemPrompt` **必须是那段完整的 v1 提示词，不是空串**（2026-08-08 修）。
 *    C5 把它从 `agent-config.json` 里删了，`data/content/image-dialects.json` 成了唯一真源；
 *    于是兜底一旦留空，装配层就只剩 `agent-templates.ts` 里那行 stub 可回落 —— 五条 v1 规则
 *    （不写外观 / 不写人数 / 不写时段天气 / 不写画质与分级 / 只输出三个标签）一条都不在，
 *    模型自己写人数、引擎再追加一份，画面里多出来的人和错掉的时段**不会报任何错**，
 *    Anlas 照扣。空串这个「本方言没话说」的语义仍然保留，但那是**内容包作者**在方言 JSON 里
 *    的表达（`readText` 收下空串），不是兜底该有的形态。
 */
export const FALLBACK_IMAGE_DIALECT: ImageDialect = {
  id: 'danbooru-anime',
  label: '动漫标签',
  separator: ', ',
  normalize: 'danbooru',
  appearance: 'danbooru',
  world: 'tags',
  rating: 'tag',
  count: 'tag',
  supportsNegative: true,
  qualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
  baseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
  composition: DEFAULT_IMAGE_COMPOSITION_TAGS,
  systemPrompt: DEFAULT_IMAGE_PROMPT_SYSTEM,
};

// ═══ 取值原语（照 workshop-manifest：拿不到就给缺省，绝不抛）═══

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 取一个**允许为空串**的字符串旋钮。
 *
 * 🔴 空串必须收下：`natural-prose` 的 `qualitySuffix` / `baseNegative` 就是空串，
 *    而那是它最要紧的一条性质（krea2 那类 CFG 1.0 模型根本不吃负向）。
 *    把空串当「没填」回落成 danbooru 默认值，等于给散文档强行接上一条动漫尾巴。
 *    只有**非字符串**（缺字段 / 写成数字 / 写成 null）才回落。
 */
function readText(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

/** 取一个**不允许为空串**的字符串旋钮（id / label / separator：空了没有任何合理解读） */
function readNonEmpty(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 取一个封闭枚举旋钮：不在白名单里（含拼错、含 `'phrase'` 这类未实现值）一律回落 */
function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = source[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// ═══ 解析 ═══

/**
 * 内容注册表 `imageDialects` 面 → `ImageDialect[]`（容错，永不抛）。
 *
 * 外层形状**只认 `{ dialects: [...] }`**，认不出 → 返回 `[]`，调用方据此退到
 * `FALLBACK_IMAGE_DIALECT`。
 *
 * 🔴 **裸数组刻意不收**（2026-08-08 修）。此前这里收，理由写的是「pack 作者少写一层时的
 *    常见形态」—— 但那条宽容**根本到不了**：`content-source.ts` 的 `objectSectionNames`
 *    把本面钉成对象，裸数组的 pack 在 `validatePackOrThrow` 就被 `bad-imageDialects-section`
 *    拦下，压根走不到解析器。两处各说一套的结果不是宽容，是一句读代码的人会信的假话。
 *    收口方向选「解析器跟校验器走」而不是反过来，是为了与另外六面同规矩：每一面的外层
 *    形状由 `Pack*Section` 类型声明、由校验器守，解析器只对**内容**宽容（旋钮认不出回落、
 *    条目认不出跳过），不替作者猜他把整节写成了什么别的形状。
 *
 * 逐条规则:
 * - 不是对象、或 `id` 不是非空字符串 → **整条跳过**（没有 id 的方言无法被设置引用，
 *   留着只会在下拉里变成一个选不中的幽灵项）
 * - id 重复 → 只留**第一条**（后来者静默丢弃；先到先得是稳定的，与遍历顺序无关的
 *   「后者赢」在数组里并不存在）
 * - 任一旋钮认不出 → 只有**那一格**回落 `FALLBACK_IMAGE_DIALECT` 的同名值，
 *   其余格照收。半懂的方言比整条丢掉有用得多。
 */
export function parseImageDialects(raw: unknown): ImageDialect[] {
  const list = isRecord(raw) && Array.isArray(raw.dialects) ? raw.dialects : undefined;
  if (!list) return [];

  const out: ImageDialect[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: readNonEmpty(item, 'label', id),
      separator: readNonEmpty(item, 'separator', FALLBACK_IMAGE_DIALECT.separator),
      normalize: readEnum(
        item,
        'normalize',
        ['danbooru', 'none'],
        FALLBACK_IMAGE_DIALECT.normalize,
      ),
      appearance: readEnum(
        item,
        'appearance',
        ['danbooru', 'prose'],
        FALLBACK_IMAGE_DIALECT.appearance,
      ),
      world: readEnum(item, 'world', ['tags', 'none'], FALLBACK_IMAGE_DIALECT.world),
      rating: readEnum(item, 'rating', ['tag', 'none'], FALLBACK_IMAGE_DIALECT.rating),
      count: readEnum(item, 'count', ['tag', 'none'], FALLBACK_IMAGE_DIALECT.count),
      supportsNegative: readBoolean(
        item,
        'supportsNegative',
        FALLBACK_IMAGE_DIALECT.supportsNegative,
      ),
      qualitySuffix: readText(item, 'qualitySuffix', FALLBACK_IMAGE_DIALECT.qualitySuffix),
      baseNegative: readText(item, 'baseNegative', FALLBACK_IMAGE_DIALECT.baseNegative),
      composition: readText(item, 'composition', FALLBACK_IMAGE_DIALECT.composition),
      systemPrompt: readText(item, 'systemPrompt', FALLBACK_IMAGE_DIALECT.systemPrompt),
    });
  }
  return out;
}

// ═══ 取用 ═══

/**
 * 按 id 取一条方言，并叠加用户对它的覆盖（C6）。
 *
 * 取用顺序:
 * 1. `dialectId` 精确命中 → 用它
 * 2. 没命中，但清单里有内置 id（`danbooru-anime`）→ 用那条。存了一个已被 pack 删掉的
 *    id 时，落到清单里那条 danbooru（它带的是**当前内容包写的**那份提示词与旋钮），
 *    比落到编译进引擎的兜底常量更贴近用户现在装着的内容
 * 3. 都没有 → `FALLBACK_IMAGE_DIALECT`（清单为空 / 注册表这一面 404 时的那条路）
 *
 * 🔴 **覆盖只认非空字符串**：设置页输入框被清空表达的是「不改了，用方言的默认值」，
 *    不是「我要一个空的画质后缀」。把空串当有效覆盖，用户一按清空就再也回不到默认值，
 *    而且界面上看不出区别 —— 这正是 `ImageDialectOverride` 那条注释警告的败法。
 *    真要空，由方言 JSON 自己把默认值写成空串（`natural-prose` 就是这么做的）。
 *
 * 🔴 **取到的不是要的那条时，整袋覆盖一并丢掉**（2026-08-08 修）。覆盖袋由调用方按
 *    **请求的 id** 取出（`imageDialectOverrides[imageDialectId]`），而上面第 2、3 步会把
 *    方言换成**别的一条**。不丢的后果：用户给 pack 方言 `krea-prose` 调过的散文
 *    systemPrompt + 构图词，会在那个 pack 被卸载后原封不动骑到 danbooru 上 ——
 *    于是拿散文提示词去驱动 danbooru 装配，每张图都不对，付费后端上还每张都花钱。
 *    覆盖是**对某一条方言**的调优，方言换了它就失去意义，不是「用户的全局口味」
 *    （全局口味另有 `imageExtraNegative` 那一格）。
 *
 * @param dialects `parseImageDialects` 的产物（可为空数组）
 * @param dialectId 用户设置里存的方言 id（可为 undefined = 没选过）
 * @param overrides 该 **id 键控**的覆盖袋（`imageDialectOverrides[dialectId]`）；
 *                  只在最终取到的正是 `dialectId` 那条时才生效
 */
export function resolveImageDialect(
  dialects: readonly ImageDialect[],
  dialectId: string | undefined,
  overrides?: ImageDialectOverride,
): ImageDialect {
  const picked =
    (dialectId !== undefined ? dialects.find((d) => d.id === dialectId) : undefined) ??
    dialects.find((d) => d.id === FALLBACK_IMAGE_DIALECT.id) ??
    FALLBACK_IMAGE_DIALECT;

  // 覆盖袋是按**请求的 id** 取出来的：回落到别的方言时它不再适用，整袋丢掉（见上方注释）
  if (!overrides || picked.id !== dialectId) return picked;
  return {
    ...picked,
    systemPrompt: overrideText(overrides.systemPrompt, picked.systemPrompt),
    qualitySuffix: overrideText(overrides.qualitySuffix, picked.qualitySuffix),
    baseNegative: overrideText(overrides.baseNegative, picked.baseNegative),
    composition: overrideText(overrides.composition, picked.composition),
  };
}

/** 覆盖值只在「是字符串且非空」时生效；其余一律保留方言默认值 */
function overrideText(override: string | undefined, base: string): string {
  return typeof override === 'string' && override.length > 0 ? override : base;
}
