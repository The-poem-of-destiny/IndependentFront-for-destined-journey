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

import { ASSET_TYPES, type AssetCategory, type AssetType } from './types';

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

/** 归一化扩展名: 去掉前导点、trim、转小写。表查询前一律先过这里 */
function normalizeExtension(ext: string): string {
  const trimmed = (ext ?? '').trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

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
