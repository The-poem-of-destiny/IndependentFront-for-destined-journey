/**
 * asset-types.ts — 素材类型的规则与表 (Asset System v1)
 *
 * 为什么存在: 三件事必须在全项目只有一份答案 —— ①type → category 的派生
 * ②扩展名 → MIME 的路由表 ③哪个 type 允许 mp4。三者散开就会漂移：导入器、
 * 改名校验、导出、UI 过滤器各拿一份，第一次加类型就分叉。
 *
 * 分工: 本文件只放**逻辑与表**，不放数据模型类型。`AssetType` /
 * `AssetCategory` / `ASSET_TYPES` / `AssetMetaRecord` 住在 types.ts
 * （唯一类型来源），这里 re-export 逻辑而非类型。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局 —— 与 audio-names.ts
 * 同级的纯函数模块，必须在 vitest environment:'node' 下可导入。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §2 / §6.2
 */

import {
  ASSET_TYPES,
  DEFAULT_ASSET_FRAMING,
  type AssetCategory,
  type AssetFraming,
  type AssetType,
} from './types';
import { normalizeExtension } from './asset-path';

// ═══════════════════════════════════════════════════════════
// 类型 → 大类
// ═══════════════════════════════════════════════════════════

/**
 * 由 type 派生大类。v1 三个类型全是角色美术，所以恒为 'character'。
 *
 * 这不是"暂时没用的抽象": category **刻意不落库**（§4.1），派生函数就是它
 * 唯一的存在方式。背景/CG 到来时只改这一处，assetMeta 表不动。
 */
export function categoryForType(_type: AssetType): AssetCategory {
  return 'character';
}

/**
 * 该 segment 是否**整段**等于某个类型 token。
 *
 * 🔴 必须整段相等，**绝不能用 substring/includes**: `立绘bg` 把 `立绘` 含在
 * 里面，子串匹配会把每一个 `立绘bg` 文件名都解析成 `立绘` + 变体 `bg`，
 * 静默毁掉整批素材。
 *
 * 严格 `===`，不 trim、不折叠大小写 —— 沿用 D2「素材名不做归一化」的口径：
 * ` 头像` 与 `头像` 是两个不同的 segment，前者只是名字的一部分。
 */
export function isAssetTypeToken(segment: string): boolean {
  return ASSET_TYPES.includes(segment as AssetType);
}

// ═══════════════════════════════════════════════════════════
// 扩展名表 —— 全项目唯一来源
// ═══════════════════════════════════════════════════════════

/** 认可的图片扩展名 → MIME */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

/**
 * 认可的视频扩展名 → MIME。
 *
 * **只有 mp4**（§2.4 / D8）:
 * - `.webm` 归音频 —— `AUDIO_MIME_BY_EXTENSION` 已占用它（audio-names.ts），
 *   改判是回退；而带 alpha 的动画在 v1 用 **animated WebP** 解决。
 * - 带 alpha 的视频**没有一个格式全浏览器可用**（§2.5），所以不引进第二个。
 */
const VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
};

/**
 * 认可的素材扩展名 → MIME。
 *
 * 这份表是**全项目唯一来源**，UI 层反向 import 它（引擎层禁止 import
 * `src/ui/`，所以只能反向共享）—— 与 audio-names.ts:28-31 对
 * `AUDIO_MIME_BY_EXTENSION` 立的规矩同一条。两层各存一份路由表，
 * 就是路由静默漂移的来路。
 *
 * **不含 `svg`**（§2.4）: 它是能带脚本的文档格式，当头像也很怪，排除零成本。
 */
export const ASSET_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...IMAGE_MIME_BY_EXTENSION,
  ...VIDEO_MIME_BY_EXTENSION,
};

/** 认可的素材扩展名（小写，不含点） */
export const ASSET_FILE_EXTENSIONS: readonly string[] = Object.keys(ASSET_MIME_BY_EXTENSION);

/** 认可的图片扩展名（小写，不含点） */
export const ASSET_IMAGE_EXTENSIONS: readonly string[] = Object.keys(IMAGE_MIME_BY_EXTENSION);

/** 认可的视频扩展名（小写，不含点） */
export const ASSET_VIDEO_EXTENSIONS: readonly string[] = Object.keys(VIDEO_MIME_BY_EXTENSION);

const IMAGE_SET = new Set(ASSET_IMAGE_EXTENSIONS);
const VIDEO_SET = new Set(ASSET_VIDEO_EXTENSIONS);

// 归一化扩展名（去前导点 + trim + 小写）—— Q-16 起唯一实现在 `asset-path.ts`，
// 本模块与 asset-zip 曾各存一份。表查询前一律先过它。

/** 该扩展名是否是认可的素材扩展名（图片或视频） */
export function isAssetExtension(ext: string): boolean {
  const key = normalizeExtension(ext);
  return IMAGE_SET.has(key) || VIDEO_SET.has(key);
}

/** 该扩展名是否是图片 */
export function isImageExtension(ext: string): boolean {
  return IMAGE_SET.has(normalizeExtension(ext));
}

/** 该扩展名是否是视频 */
export function isVideoExtension(ext: string): boolean {
  return VIDEO_SET.has(normalizeExtension(ext));
}

/** 扩展名 → MIME；不认识则 undefined（调用方据此判"未知扩展名"跳过） */
export function mimeForAssetExtension(ext: string): string | undefined {
  return ASSET_MIME_BY_EXTENSION[normalizeExtension(ext)];
}

// ═══════════════════════════════════════════════════════════
// 媒体规则 (D7)
// ═══════════════════════════════════════════════════════════

/**
 * 该类型是否允许视频（mp4）。
 *
 * 规则的正确表述是 **「alpha 用不上的地方就允许 mp4」**（§2.2）:
 * - `头像` ✅ —— 圆形裁切填满，什么都不合成，不需要 alpha
 * - `立绘bg` ✅ —— 整幅铺满，同理
 * - `立绘` ❌ —— 是要抠像叠在背景上的立牌，mp4 没有合成 alpha，
 *   动画立绘会渲染成人物背后一块黑框
 *
 * RPT 的原规则结论正确但表述绑在具体类型上（排除 `头像`），这里换成
 * 按需求表述，于是新类型进来时答案不用猜。
 */
export function allowsVideo(type: AssetType): boolean {
  return type !== '立绘';
}

/**
 * (type, ext) 这对组合是否合法 —— 扩展名认识，且视频没落在禁视频的类型上。
 * 解析与导入两处都走它，媒体规则只有一份实现。
 */
export function isMediaAllowed(type: AssetType, ext: string): boolean {
  if (!isAssetExtension(ext)) return false;
  return !isVideoExtension(ext) || allowsVideo(type);
}

// ═══════════════════════════════════════════════════════════
// 取景（framing）的有效区间 —— 全项目唯一一份
// ═══════════════════════════════════════════════════════════

/** 焦点百分比下限（`object-position` 语义：0% = 左/上边贴齐） */
export const ASSET_FRAMING_MIN_PERCENT = 0;
/** 焦点百分比上限（100% = 右/下边贴齐） */
export const ASSET_FRAMING_MAX_PERCENT = 100;
/** 缩放下限 —— 1 就是"恰好 cover"，再小框里会露白 */
export const ASSET_FRAMING_MIN_SCALE = 1;
/** 缩放上限 —— 够放大到只取一张脸，又不至于把 512px 的源图放成马赛克 */
export const ASSET_FRAMING_MAX_SCALE = 3;

/**
 * 一个数收进 [min, max]；**不是数、或不是有限数，就退回 fallback**。
 *
 * `Number.isFinite` 这一关是重点而不是形式: `NaN` 参与任何比较都是 false，
 * 于是 `Math.min(Math.max(NaN, 0), 100)` 照样是 `NaN` —— 裸夹逼**拦不住 NaN**。
 * 而一个 NaN 流到 `object-position: NaN% 0%` 会让整条 CSS 声明被丢弃，
 * 表现成"这张图偶尔没对齐"，是最难查的那类样式 bug。
 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * 把任意来路的取景值收成一个**一定能安全渲染**的 {@link AssetFraming}。
 *
 * 为什么是纯函数而不是校验器: 取景没有"非法"这回事 —— 少一个字段、拖出界、
 * 从旧版本读到越界的 scale，正确反应都是**当作默认/贴边**继续渲染，而不是报错
 * 或者拒绝显示这张图。所以这里只收敛，不判错、不抛。
 *
 * 唯一的读取入口: 渲染面、store 写入前、任何拿到 `row.framing` 的地方，
 * 一律先过这里。`undefined`（存量行、刚导入的行）得到 {@link DEFAULT_ASSET_FRAMING}
 * 的副本 —— **副本**，因为默认值是冻结的共享对象，调用方拿去改滑块不该改到它。
 *
 * @param input 任意值: `AssetFraming` / 局部对象 / `undefined` / 从 JSON 读回来的垃圾
 */
export function clampAssetFraming(input?: unknown): AssetFraming {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return {
    x: clampNumber(
      src.x,
      DEFAULT_ASSET_FRAMING.x,
      ASSET_FRAMING_MIN_PERCENT,
      ASSET_FRAMING_MAX_PERCENT,
    ),
    y: clampNumber(
      src.y,
      DEFAULT_ASSET_FRAMING.y,
      ASSET_FRAMING_MIN_PERCENT,
      ASSET_FRAMING_MAX_PERCENT,
    ),
    scale: clampNumber(
      src.scale,
      DEFAULT_ASSET_FRAMING.scale,
      ASSET_FRAMING_MIN_SCALE,
      ASSET_FRAMING_MAX_SCALE,
    ),
  };
}

/** 这份取景是不是就是默认值（存库前可据此省掉一个字段，UI 可据此显示"未调整"） */
export function isDefaultAssetFraming(framing?: unknown): boolean {
  const f = clampAssetFraming(framing);
  return (
    f.x === DEFAULT_ASSET_FRAMING.x &&
    f.y === DEFAULT_ASSET_FRAMING.y &&
    f.scale === DEFAULT_ASSET_FRAMING.scale
  );
}
