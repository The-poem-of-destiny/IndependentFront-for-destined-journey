/**
 * image-providers/novelai.ts — ComposedPrompt → NAI V4.5 请求体 / NAI 响应 zip → PNG 字节
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §5.4（签名与不变式）
 *       + §6.1（真实录制的请求体全文）+ §6.2（ucPreset 按模型各自编号的警告）。
 *
 * 本文件是**纯函数层**: 没有 fetch、没有 Dexie、没有随机、没有时钟。
 * 网络那一半在 `src/ui/lib/image-client.ts`（先例: workshop-client.ts）。
 *
 * 🔴 **三重冗余是这一层的全部要害**（§5.4 / §6.1）。V4 把同一份内容要在三处各写一遍，
 *    字段名还各不相同:
 *
 *      prompt.base         → body.input
 *                          → parameters.v4_prompt.caption.base_caption            （逐字相同）
 *      prompt.baseNegative → parameters.negative_prompt
 *                          → parameters.v4_negative_prompt.caption.base_caption   （逐字相同）
 *      prompt.characters[i]→ parameters.characterPrompts[i]  { prompt, uc, center, enabled }
 *                          → v4_prompt.caption.char_captions[i]          { char_caption, centers }
 *                          → v4_negative_prompt.caption.char_captions[i] { char_caption, centers }
 *
 *    **只填一处不会报错，只会静默产出不对的图**（角色条件丢失、负向不生效）。所以三处一律由
 *    `prompt` 这**一个**中间结构一次性展开（见 `buildCharacterSlots`），绝不允许调用方分别传，
 *    也绝不允许有人在中间插一次 filter/sort —— 那会让三个数组的下标错位。
 *
 * 🔴 **本函数不产随机**。seed 缺省时由调用方给（`opts.seed`）；两处都没有就整个字段不发，
 *    由 NAI 自己随机。测试钉住了这条 —— 有人在这里塞 `Math.random()` 会让快照复现失效。
 *
 * 🔴 **不在这里截断角色**。「最多 6 个」是 `image-prompt.ts` 的事（截断 + 告警，§6.2），
 *    本层照单全收；在这里再截一次 = 用户永远看不到那条告警。
 */

import type { ComposedPrompt, ImageGenFailure } from '../types-image';
import { IMAGE_BAD_RESPONSE_MESSAGE } from '../image-defaults';

import { unzipSync } from 'fflate';

// ═══ 线格式类型 ═══
//
// 🔴 这些**不是**本项目的领域类型，是 NovelAI 的线格式（字段名是人家定的 snake_case +
//    camelCase 混排）。领域类型集中在 `types-image.ts`；线格式随 provider 走，设计 §5.4
//    也把它们落在本文件。将来接第二家（OpenAI/Gemini，D11）时它们不该被复用。

/** V4 的 5×5 网格坐标。v1 恒 `{x:0,y:0}` + `use_coords:false` + `use_order:true`（§6.2） */
export interface NaiCenter {
  x: number;
  y: number;
}

/** `parameters.characterPrompts[i]` —— 第三处冗余，字段名换了一套 */
export interface NaiCharacterPrompt {
  prompt: string;
  uc: string;
  center: NaiCenter;
  enabled: boolean;
}

/** `v4_prompt` / `v4_negative_prompt` 里的角色槽 */
export interface NaiCharCaption {
  char_caption: string;
  centers: NaiCenter[];
}

export interface NaiCaption {
  base_caption: string;
  char_captions: NaiCharCaption[];
}

export interface NaiV4Prompt {
  caption: NaiCaption;
  use_coords: boolean;
  use_order: boolean;
}

export interface NaiV4NegativePrompt {
  caption: NaiCaption;
  legacy_uc: boolean;
}

export interface NaiParameters {
  negative_prompt: string;
  v4_prompt: NaiV4Prompt;
  v4_negative_prompt: NaiV4NegativePrompt;
  characterPrompts: NaiCharacterPrompt[];

  params_version: number;
  ucPreset: number;
  qualityToggle: boolean;
  width: number;
  height: number;
  n_samples: number;
  /** 缺省时**整个字段不出现**（NAI 自己随机）。本层不产随机 */
  seed?: number;
  sampler: string;
  noise_schedule: string;
  scale: number;
  steps: number;
  cfg_rescale: number;
  dynamic_thresholding: boolean;
  skip_cfg_above_sigma: number | null;
  use_coords: boolean;
  autoSmea: boolean;
  prefer_brownian: boolean;
  legacy: boolean;
  legacy_uc: boolean;
  legacy_v3_extend: boolean;
  deliberate_euler_ancestral_bug: boolean;
  add_original_image: boolean;
  controlnet_strength: number;
  normalize_reference_strength_multiple: boolean;
}

export interface NaiRequestBody {
  model: string;
  action: 'generate';
  /** 🔴 正向提示词在**顶层 input**，`parameters.prompt` 这个字段不存在（§6.1） */
  input: string;
  parameters: NaiParameters;
}

/** `buildNaiRequest` 的可配置面。默认值见 `image-defaults.ts` 与设置页 */
export interface NaiOptions {
  /** 'nai-diffusion-4-5-full'（§6.2 裁定 1: 不用 Curated） */
  model: string;
  /** 1216 */
  width: number;
  /** 832 */
  height: number;
  /** 23 */
  steps: number;
  /** 4.5 */
  scale: number;
  /** 'k_euler_ancestral' */
  sampler: string;
  /** 'karras' */
  noiseSchedule: string;
  /**
   * 🔴 **不是跨模型稳定常量**（§6.2）。UC 预设是**每模型一套具名清单**，`0` 是那个模型
   * 清单里的第 0 项，换模型语义就变。v1 自己维护完整负向文本，这个值按录制值原样发。
   */
  ucPreset: number;
  /** 缺省 → 落到 `prompt.seed`（角色 pinnedSeed）；再缺省 → 不发这个字段。本函数不产随机 */
  seed?: number;
}

// ═══ 固定常量（照 §6.1 录制样本原样发）═══

/** D9: 恒 1。多张要靠多次请求，不靠 n_samples —— 限额与计费都按「一次一张」记账 */
const N_SAMPLES = 1;

/** 录制样本的 `params_version` */
const PARAMS_VERSION = 3;

/** 每个槽位都要**独立**的坐标对象，不共享实例 —— 共享的话有人就地改一个会串改全部 */
function origin(): NaiCenter {
  return { x: 0, y: 0 };
}

/**
 * 三重冗余的**唯一**展开点。
 *
 * 一次 map 同时产出三种形状，于是「顺序一致」与「内容一致」是结构上的事实而不是纪律 ——
 * 想让它们错位，得先把这个函数拆开。
 */
function buildCharacterSlots(prompt: ComposedPrompt): {
  characterPrompts: NaiCharacterPrompt[];
  positiveCaptions: NaiCharCaption[];
  negativeCaptions: NaiCharCaption[];
} {
  const slots = prompt.characters.map((c) => ({
    characterPrompt: { prompt: c.positive, uc: c.negative, center: origin(), enabled: true },
    positiveCaption: { char_caption: c.positive, centers: [origin()] },
    negativeCaption: { char_caption: c.negative, centers: [origin()] },
  }));

  return {
    characterPrompts: slots.map((s) => s.characterPrompt),
    positiveCaptions: slots.map((s) => s.positiveCaption),
    negativeCaptions: slots.map((s) => s.negativeCaption),
  };
}

/**
 * ComposedPrompt + 参数 → NAI V4.5 请求体。
 *
 * 纯函数，逐字节确定（同样的入参永远出同样的 body）。
 *
 * 0 角色时 `characterPrompts` / 两处 `char_captions` **都传 `[]`** —— `v4_*` 信封是 V4 分支的
 * 固定结构，多角色关闭时同样发送、只是数组为空（§6.3 第 1 条）。
 */
export function buildNaiRequest(prompt: ComposedPrompt, opts: NaiOptions): NaiRequestBody {
  const { characterPrompts, positiveCaptions, negativeCaptions } = buildCharacterSlots(prompt);

  // 🔴 调用方给的优先；调用方没给就用装配期算出来的（角色预设的 pinnedSeed）。
  //    两处都没有 = 这个字段不发。本层**不**兜一个 Math.random()。
  const seed = opts.seed ?? prompt.seed;

  const parameters: NaiParameters = {
    // ── 冗余 2/3: 负向 ──
    negative_prompt: prompt.baseNegative,

    v4_prompt: {
      caption: {
        // ── 冗余 2/3: 正向（与顶层 input 逐字相同）──
        base_caption: prompt.base,
        char_captions: positiveCaptions,
      },
      use_coords: false,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: {
        // ── 冗余 3/3: 负向（与 negative_prompt 逐字相同）──
        base_caption: prompt.baseNegative,
        char_captions: negativeCaptions,
      },
      legacy_uc: false,
    },

    // ── 冗余 3/3: 角色（字段名换了一套）──
    characterPrompts,

    params_version: PARAMS_VERSION,
    ucPreset: opts.ucPreset,
    // 录制样本里它是 true，而画质后缀**同时**已经拼在 base 里了（composePrompt 干的）。
    // 照录制值原样发 —— 这个开关在 API 侧不代替提示词里的那串标签。
    qualityToggle: true,
    width: opts.width,
    height: opts.height,
    n_samples: N_SAMPLES,
    ...(seed === undefined ? {} : { seed }),
    sampler: opts.sampler,
    noise_schedule: opts.noiseSchedule,
    scale: opts.scale,
    steps: opts.steps,

    // ── 以下全部照 §6.1 录制样本原样发 ──
    cfg_rescale: 0,
    dynamic_thresholding: false,
    skip_cfg_above_sigma: null,
    use_coords: false,
    autoSmea: false,
    prefer_brownian: true,
    legacy: false,
    legacy_uc: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    add_original_image: true,
    controlnet_strength: 1,
    normalize_reference_strength_multiple: true,
  };

  return {
    model: opts.model,
    action: 'generate',
    // ── 冗余 1/3: 正向 ──
    input: prompt.base,
    parameters,
  };
}

// ═══ 响应解包 ═══

/**
 * §12.2 那张表里 `bad-response` 那一行。上游细节只进 `detail`，不进 UI。
 *
 * 文案取自 `image-defaults.IMAGE_BAD_RESPONSE_MESSAGE` —— `ui/lib/image-client.ts`
 * 用**另一套判据**（字节根本读不出来）产出同一句话，各存一份就会改一半漂一半。
 */
function badResponse(detail: string): ImageGenFailure {
  return {
    ok: false,
    kind: 'bad-response',
    message: IMAGE_BAD_RESPONSE_MESSAGE,
    detail,
    retryable: true,
  };
}

/** 已知图片扩展名（小写，含点） */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * 这一条是不是一张图。
 *
 * 名字与字节**任一**认得就算 —— NAI 现在出的是 `image_0.png`，但把「是不是图」这件事
 * 只押在文件名上，人家改个命名我们就整条链报 `bad-response`；只押在魔数上，
 * 将来换个我们没列的容器同样会漏。两条都试，代价是零。
 */
function looksLikeImage(name: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  const lower = name.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }

  return false;
}

/**
 * NAI 响应 zip → PNG 字节。
 *
 * - `contentType` 不含 `zip` → `bad-response`（多半是上游把错误体当 JSON 返回了，
 *   而调用方**不该**在这里 `await res.json()` —— §12.1 第 2 条）
 * - zip 解不开 → `bad-response`
 * - zip 解出 0 张图 → `bad-response`
 * - 否则按 zip 内条目顺序返回全部图片字节
 *
 * 🔴 条目顺序取自 `unzipSync` 返回对象的键序（= zip 里的条目顺序）。**纯数字文件名**会被
 *    JS 对象的整数键规则提到最前面；NAI 出的是 `image_0.png`，不受影响，但换 provider 时要记得。
 */
export function parseNaiZip(
  bytes: Uint8Array,
  contentType: string,
): { ok: true; images: Uint8Array[] } | ImageGenFailure {
  if (!contentType.toLowerCase().includes('zip')) {
    return badResponse(`content-type: ${contentType || '(空)'}`);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return badResponse(`zip 解包失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const images: Uint8Array[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (looksLikeImage(name, data)) images.push(data);
  }

  if (images.length === 0) {
    return badResponse(`zip 里没有图片条目（共 ${Object.keys(entries).length} 条）`);
  }

  return { ok: true, images };
}
