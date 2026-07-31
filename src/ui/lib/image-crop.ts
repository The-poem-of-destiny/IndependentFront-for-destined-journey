/**
 * image-crop.ts — 从一张源图切出真字节 (Asset System)
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md（素材命名与媒体规则 D7 / D12）
 *
 * 为什么要**真裁**而不是只存一个矩形: 取景（`AssetFraming`，types.ts）解决的是
 * 「同一张图在不同框里怎么摆」，可逆、可反复调，所以是元数据。而这里解决的是
 * 「我要从这张源图**造出**一张头像和一张立绘」—— 两张独立素材，各自有名字、有
 * 类型、有哈希、能被去重、能进导出包往返。那就必须是两份真字节。存矩形办不到:
 * 一条 `(sourceId, rect)` 的引用没有哈希、进不了 zip 契约、源图一删两张全废。
 *
 * 纯度与注入缝（对齐 media-hash.ts 的惰性特性检测 + asset-url.ts 的注入 seam）:
 * - 所有浏览器全局（`createImageBitmap` / `OffscreenCanvas` / `document`）**只在函数体内**
 *   惰性取，仅 import 本模块在 vitest `environment:'node'` 下不触碰任何浏览器 API；
 * - 解码与画布两处都能从 options 注入，于是**不需要真画布也能测**整条裁剪逻辑
 *   （夹逼、零面积、maxEdge 等比缩放、mime 选择全是可测的纯算术）。
 *
 * 错误纪律 —— 与 media-hash.ts **刻意相反**，别照抄那边:
 * 哈希算不出只是"少一次去重"，所以那边返回 `undefined` 永不抛；而裁剪失败意味着
 * **拿不到用户要的那张图**，静默返回一个空 PNG 会让一张全透明的图片当作头像存进库里，
 * 之后谁也说不清它是怎么来的。所以这里**一律抛 {@link ImageCropError}**，带 `code`
 * 供调用方分类（照 asset-zip.ts 的 `AssetZipError` 先例：判 `code`，别 match 文案）。
 *
 * 🔴 **视频永远出不去也进不来**: mp4 在这里既不能当源（画布只能拿到某一帧，
 * 而"哪一帧"从来没人指定过）也不能当输出。调用方传视频进来是**调用方的错**，
 * 所以是抛错而不是降级 —— D7 允许 mp4 落在 `头像`/`立绘bg` 上，但那条路是原样存字节，
 * 跟裁剪没有交集。
 */

// ═══════════════════════════════════════════════════════════
// 对外形状
// ═══════════════════════════════════════════════════════════

/** 裁剪矩形，单位是**源图像素**（不是框像素、不是百分比） */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ImageCropErrorCode =
  /** 源是视频，或调用方点名要一个 `video/*` 输出 —— 两者都不可能 */
  | 'video-source'
  /** 源是 0 字节 */
  | 'empty-source'
  /** 环境里没有 `createImageBitmap`（且没注入 decode seam） */
  | 'no-decoder'
  /** 解码失败：不是图片、字节损坏、或格式本机不支持 */
  | 'decode-failed'
  /** 矩形夹逼之后没有面积：零宽/零高、非有限数，或整块落在图外 */
  | 'empty-rect'
  /** 环境里没有可用画布（且没注入 createCanvas seam） */
  | 'no-canvas'
  /** 画布编码没吐出 blob */
  | 'encode-failed';

/** 裁剪失败的唯一错误类型。**按 `code` 判别，别去 match `message`** */
export class ImageCropError extends Error {
  readonly code: ImageCropErrorCode;

  constructor(code: ImageCropErrorCode, message: string) {
    super(message);
    this.name = 'ImageCropError';
    this.code = code;
  }
}

// ── 注入缝的窄接口（只声明本模块真正用到的成员，不引 DOM 全量类型）──

/** 解码结果只需要尺寸 + 可画；`close` 可选（`ImageBitmap` 有，替身可以没有） */
export interface CropBitmapLike {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

export interface CropContextLike {
  drawImage(
    source: CropBitmapLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * 画布替身。`OffscreenCanvas`（`convertToBlob`）与 `<canvas>`（`toBlob`）两套 API
 * 都认，谁在就用谁 —— 两者能力等价，差别只在回调还是 Promise。
 */
export interface CropCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CropContextLike | null;
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Blob>;
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

/** 字节 → 位图 */
export type CropDecoder = (blob: Blob) => Promise<CropBitmapLike>;
/** 尺寸 → 画布；造不出返回 null（调用方据此报 `'no-canvas'`） */
export type CropCanvasFactory = (width: number, height: number) => CropCanvasLike | null;

/** 两个入口共用的注入缝 */
export interface ImageCropSeams {
  /** 默认惰性取 `globalThis.createImageBitmap` */
  decode?: CropDecoder;
  /** 默认 `OffscreenCanvas` → `document.createElement('canvas')` */
  createCanvas?: CropCanvasFactory;
}

export interface ImageCropOptions extends ImageCropSeams {
  /**
   * 点名要的输出 MIME。不给就按源类型推（见 {@link resolveOutputMime}）。
   * 传 `video/*` 一律抛 `'video-source'`。
   */
  mime?: string;
  /**
   * 长边上限（像素）。裁出来的长边超过它就**等比**缩到它。
   *
   * 为什么需要: 一张 8000px 的源图切出来的"头像"仍然是几千像素、几十 MB，
   * 而它最终显示在一个 2.5rem 的圆里 —— 那不是画质，是把用户的 IndexedDB 配额
   * 烧掉。不给这个值就不缩（导出原尺寸是合法诉求）。
   */
  maxEdge?: number;
  /** 有损编码的质量 [0,1]，只对 `image/jpeg` / `image/webp` 有意义 */
  quality?: number;
}

// ═══════════════════════════════════════════════════════════
// 默认 seam（惰性引用全局）
// ═══════════════════════════════════════════════════════════

interface CreateImageBitmapLike {
  (blob: Blob): Promise<CropBitmapLike>;
}

interface OffscreenCanvasCtorLike {
  new (width: number, height: number): CropCanvasLike;
}

interface DocumentLike {
  createElement(tag: 'canvas'): CropCanvasLike;
}

function resolveDecoder(seam?: CropDecoder): CropDecoder {
  if (seam) return seam;
  const fn = (globalThis as { createImageBitmap?: CreateImageBitmapLike }).createImageBitmap;
  if (typeof fn !== 'function') {
    throw new ImageCropError('no-decoder', '这个环境没有 createImageBitmap，无法解码图片。');
  }
  // 绑回全局：`createImageBitmap` 在部分实现里对 this 敏感
  return (blob: Blob) => fn.call(globalThis, blob);
}

function resolveCanvasFactory(seam?: CropCanvasFactory): CropCanvasFactory {
  if (seam) return seam;
  return (width: number, height: number): CropCanvasLike | null => {
    const Off = (globalThis as { OffscreenCanvas?: OffscreenCanvasCtorLike }).OffscreenCanvas;
    if (typeof Off === 'function') return new Off(width, height);
    const doc = (globalThis as { document?: DocumentLike }).document;
    if (doc && typeof doc.createElement === 'function') {
      const el = doc.createElement('canvas');
      el.width = width;
      el.height = height;
      return el;
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════
// MIME 决策
// ═══════════════════════════════════════════════════════════

/**
 * 原样保留的输出类型 —— **无损或带动画，且画布确实编得出来**。
 *
 * 名单只有这两个，是两条约束的交集:
 * - `image/gif` 虽然是动画格式，但**没有浏览器的画布能编码 GIF**（`toBlob('image/gif')`
 *   静默吐 PNG）。写进名单只会让 `blob.type` 与真实字节对不上，比诚实降级更糟。
 * - `image/avif` 的编码支持零散，同理。
 * - `image/jpeg` 是有损的: 裁一刀再存回 JPEG 等于第二次有损编码，块状伪影会叠加。
 *
 * 所以名单外的一律落到 PNG。
 *
 * 🔴 **`image/webp` 留在名单里，但它只是"点名要"，不是"一定拿得到"**:
 * 画布的 webp **编码**并非哪儿都有（Firefox 就没有），`toBlob('image/webp')`
 * 按 HTML 规范会静默产出 **PNG 字节**。gif/avif 是"确定编不出"所以直接不写进名单，
 * webp 是"多数引擎编得出"所以照样请求 —— 但**这两者的结论是同一条**:
 * 谁都不许把请求的类型当成产出的类型去记账。
 * 输出类型的**唯一权威是产出的 `blob.type`**，调用方必须读它（见
 * {@link cropImageBlob} 的返回值说明），拿不到明确类型时按 {@link FALLBACK_OUTPUT_MIME}
 * 记 —— 那正是规范给画布定的默认。
 *
 * ⚠️ 一个诚实的损失，读代码的人该知道: 动态 WebP 经过画布只剩**第一帧**（画布本来
 * 就只能画一帧）。输出仍标 `image/webp`，但它是静态的。裁剪这件事本身就没法保留动画，
 * 换成任何别的格式也一样 —— 想留动画就别裁，走原样导入那条路。
 */
const PRESERVED_OUTPUT_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/webp']);

/**
 * 名单外一律落这里；**也是"产出的 blob 不肯说自己是什么"时唯一站得住的记法** ——
 * HTML 规范给画布定的默认就是它（请求的类型不被支持 → `image/png`）。
 * 导出成常量是为了让调用方的兜底与本模块的兜底是**同一个值**，而不是两处各写一遍。
 */
export const FALLBACK_OUTPUT_MIME = 'image/png';

function assertNotVideoMime(mime: string, what: string): void {
  if (mime.toLowerCase().startsWith('video/')) {
    throw new ImageCropError(
      'video-source',
      `${what}是视频（${mime}）。视频没法在这里裁剪 —— 画布只能取到某一帧，而"哪一帧"从来没人指定过。`,
    );
  }
}

/**
 * 决定输出 MIME: 显式指定 > 源类型（在保留名单里才留）> PNG。
 *
 * 导出成函数是为了让调用方能在**开裁之前**问出"这次会产出什么扩展名" ——
 * 素材 store 要拿它先过一遍命名闸门，不该等到字节都烘好了才发现名字不合法。
 */
export function resolveOutputMime(sourceMime: string | undefined, requested?: string): string {
  if (requested !== undefined && requested !== '') {
    assertNotVideoMime(requested, '指定的输出类型');
    return requested;
  }
  const src = (sourceMime ?? '').toLowerCase();
  if (src !== '') assertNotVideoMime(src, '源文件');
  return PRESERVED_OUTPUT_MIMES.has(src) ? src : FALLBACK_OUTPUT_MIME;
}

// ═══════════════════════════════════════════════════════════
// 矩形
// ═══════════════════════════════════════════════════════════

/**
 * 把矩形夹进源图边界，得到一个**整像素**矩形。
 *
 * 纯函数、单独导出，因为它是本模块唯一有分支的算术，值得脱离画布单测。
 *
 * 规则:
 * - 非有限数（NaN / Infinity）一律判成没有面积 —— 不猜、不当 0 处理；
 * - 负的 `w` / `h` 同样没有面积（不做"反向矩形"的自动翻转: 一个负宽的矩形
 *   多半是调用方算错了，替它翻过来只会把 bug 藏进一张裁歪的图里）；
 * - 边界外的部分**裁掉**（这是"夹逼"该做的），但整块都在图外时就真的没面积了；
 * - 取整之后不足 1px 也算没面积 —— 一个 0×N 的画布画不出任何东西。
 *
 * @returns 有面积时给整像素矩形，否则 `null`（调用方抛 `'empty-rect'`）
 */
export function clampCropRect(
  rect: CropRect,
  sourceWidth: number,
  sourceHeight: number,
): CropRect | null {
  const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n);
  if (!finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) return null;
  if (rect.w <= 0 || rect.h <= 0) return null;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;

  const left = Math.max(0, Math.min(sourceWidth, rect.x));
  const top = Math.max(0, Math.min(sourceHeight, rect.y));
  const right = Math.max(0, Math.min(sourceWidth, rect.x + rect.w));
  const bottom = Math.max(0, Math.min(sourceHeight, rect.y + rect.h));

  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(right) - x;
  const h = Math.round(bottom) - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/**
 * 长边压到 `maxEdge`，**等比**。不给 maxEdge、或本来就没超，就原样返回。
 *
 * 两端都至少留 1px: 一个 2000×3 的长条压到 maxEdge=100 时短边会算成 0，
 * 而 0 宽画布是画不出东西的（表现成"细长图裁完是空的"）。
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge?: number,
): { width: number; height: number } {
  if (maxEdge === undefined || !Number.isFinite(maxEdge) || maxEdge <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

async function decodeSource(src: Blob, seams?: ImageCropSeams): Promise<CropBitmapLike> {
  if (src.size === 0) {
    throw new ImageCropError('empty-source', '这个文件是空的（0 字节），没有可解码的图像。');
  }
  assertNotVideoMime(src.type ?? '', '源文件');
  const decode = resolveDecoder(seams?.decode);
  let bitmap: CropBitmapLike;
  try {
    bitmap = await decode(src);
  } catch (e) {
    throw new ImageCropError(
      'decode-failed',
      `这个文件解码不出图像：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!(bitmap.width > 0) || !(bitmap.height > 0)) {
    throw new ImageCropError('decode-failed', '解码出来的图像尺寸为 0。');
  }
  return bitmap;
}

/**
 * 读源图的像素尺寸。裁剪编辑器要先知道画布多大才能画选框。
 *
 * 会**解码整张图**（`createImageBitmap` 没有"只读头"的模式），所以别在列表里
 * 逐条调它；它是编辑器打开那一下用的。用完立刻 `close()` 释放解码后的位图。
 */
export async function readImageSize(
  src: Blob,
  seams?: ImageCropSeams,
): Promise<{ w: number; h: number }> {
  const bitmap = await decodeSource(src, seams);
  try {
    return { w: bitmap.width, h: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

/**
 * 从 `src` 里切出 `rect` 那一块，返回**新的一份真字节**。
 *
 * - `rect` 会被夹进源图边界；**完全落在图外、或零面积一律抛 `'empty-rect'`**，
 *   绝不静默返回一张空白 PNG —— 一张全透明的图存进库里之后没人查得出它是怎么来的。
 * - `options.maxEdge` 把长边压下来，等比。
 * - 输出 MIME 见 {@link resolveOutputMime}；`video/*` 永远抛错。
 *
 * 🔴 **返回的 `blob.type` 才是这次产出的真类型，别用 {@link resolveOutputMime}
 * 的预测去记账**: 那个函数回答的是"这次**要**编成什么"，而画布**不保证**照办
 * （webp 编码在 Firefox 上没有，会静默退回 PNG 字节）。把预测写进库里，得到的
 * 就是一行 `ext: webp` 盖在 PNG 字节上的记录 —— 显示看不出来（浏览器嗅探字节），
 * 但导出文件名、再导入路由、"ext 是权威"的契约全在说谎。
 * `blob.type` 为空或不认识时按 {@link FALLBACK_OUTPUT_MIME} 记。
 *
 * @throws {ImageCropError} 一切失败路径，带 `code`
 */
export async function cropImageBlob(
  src: Blob,
  rect: CropRect,
  options: ImageCropOptions = {},
): Promise<Blob> {
  // MIME 先算 —— 它可能抛 `'video-source'`，而那种情况下解码整张图纯属白干
  const outputMime = resolveOutputMime(src.type, options.mime);

  const bitmap = await decodeSource(src, options);
  try {
    const clamped = clampCropRect(rect, bitmap.width, bitmap.height);
    if (clamped === null) {
      throw new ImageCropError(
        'empty-rect',
        `裁剪区域在这张 ${bitmap.width}×${bitmap.height} 的图里没有面积（可能整块落在图外，或宽高为 0）。`,
      );
    }

    const out = fitWithinMaxEdge(clamped.w, clamped.h, options.maxEdge);
    const canvas = resolveCanvasFactory(options.createCanvas)(out.width, out.height);
    if (!canvas) {
      throw new ImageCropError('no-canvas', '这个环境没有可用的画布，无法裁剪图片。');
    }
    // 注入的替身可能是先造后设尺寸的，统一在这里对齐一次
    canvas.width = out.width;
    canvas.height = out.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new ImageCropError('no-canvas', '拿不到画布的 2d 上下文，无法裁剪图片。');
    }
    ctx.drawImage(bitmap, clamped.x, clamped.y, clamped.w, clamped.h, 0, 0, out.width, out.height);

    return await encodeCanvas(canvas, outputMime, options.quality);
  } finally {
    bitmap.close?.();
  }
}

/** `convertToBlob`（OffscreenCanvas）与 `toBlob`（`<canvas>`）都认，谁在用谁 */
async function encodeCanvas(canvas: CropCanvasLike, mime: string, quality?: number): Promise<Blob> {
  let blob: Blob | null = null;
  try {
    if (typeof canvas.convertToBlob === 'function') {
      blob = await canvas.convertToBlob({
        type: mime,
        ...(quality !== undefined ? { quality } : {}),
      });
    } else if (typeof canvas.toBlob === 'function') {
      const toBlob = canvas.toBlob.bind(canvas);
      blob = await new Promise<Blob | null>((resolve) => {
        toBlob((b) => resolve(b), mime, quality);
      });
    } else {
      throw new ImageCropError('no-canvas', '这个画布既没有 convertToBlob 也没有 toBlob。');
    }
  } catch (e) {
    if (e instanceof ImageCropError) throw e;
    throw new ImageCropError(
      'encode-failed',
      `裁剪结果编码失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!blob || blob.size === 0) {
    throw new ImageCropError('encode-failed', '裁剪结果编码后是空的，没有产出任何字节。');
  }
  return blob;
}
