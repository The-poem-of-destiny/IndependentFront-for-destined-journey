/**
 * asset-filename.ts — 素材文件名的解析 / 格式化 / 校验 (Asset System v1)
 *
 * 为什么存在: **文件名就是素材包的格式**（D1）。没有约定，`立绘` 一落地
 * 每个美术包都会变得二义。所以约定是：
 *
 *     <name>[_<type>][_<variant>].<ext>
 *
 * 解析锚定在**类型 token** 上，把下划线段**从右往左**扫，第一个整段命中的
 * token 即类型；它之前全是名字，之后全是变体。这样名字自己可以带下划线
 * （`圣殿_内庭_头像.png` → 名字 `圣殿_内庭`）。类型 token **可省，缺省为
 * `头像`** —— 常见路径零仪式。
 *
 * 命名不变式 (D16): **name 的任何一个下划线段、variant 的任何一个段，都不得
 * 等于类型 token。** 违反即拒（返回 null），不修补。这条不变式是
 * `parse(format(row)) === row` 成立的唯一理由 —— 有了它，格式化出来的文件名
 * 里**恰好一个**类型 token，从右扫和从左扫结论一致。
 * 反例（不变式缺席时）: 行 `(苏婉, 头像, 变体=立绘)` 格式化成
 * `苏婉_头像_立绘.png`，再解析回来变成 `(苏婉_头像, 立绘, 无变体)` —— 导出
 * 再导入静默改行。
 *
 * 往返的定义是**逻辑行相等，不是文件名字节相等**（§2.3）: `苏婉.png` 会
 * 格式化成 `苏婉_头像.png` —— 不同的文件名，同一行。
 *
 * `ParsedAssetName` 是**解析结果形状，不是落库实体**，所以本地声明本地导出，
 * 与 audio-scene.ts / audio-tags.ts 自持返回形状同一个规矩；它不进 types.ts。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §2 / §2.3
 */

import { isAssetExtension, isAssetTypeToken, isMediaAllowed } from './asset-types';
import type { AssetType } from './types';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/**
 * 解析结果。
 *
 * 刻意**不含 mime** —— mime 由 `mimeForAssetExtension(ext)` 从
 * `ASSET_MIME_BY_EXTENSION` 现场查（asset-types.ts 是唯一来源）。塞进来就是
 * 把同一份路由表复制进每个解析结果，且让往返断言多一个派生字段要对齐。
 */
export interface ParsedAssetName {
  /** 原始字符串，未做任何归一化（D2） */
  name: string;
  type: AssetType;
  /** 无变体时**缺省**，不是空串 */
  variant?: string;
  /** 小写，不含点 */
  ext: string;
}

/**
 * 拒收理由。命名对齐 §6.1 `PlannedSkip.reason`，导入器可直接透传：
 * - `unknown-extension` 扩展名不在路由表里（含"根本没有扩展名"）
 * - `naming-invariant` name/variant 里含类型 token，或 name 为空（D16）
 * - `mp4-on-立绘` 媒体规则（D7）
 */
export type AssetFilenameRejection = 'unknown-extension' | 'naming-invariant' | 'mp4-on-立绘';

/** 解析的完整结论 —— 带理由，供导入摘要分类计数 */
export type AssetFilenameResult =
  | { ok: true; parsed: ParsedAssetName }
  | { ok: false; reason: AssetFilenameRejection };

/** 类型 token 缺省值（D1）—— 零仪式路径 */
export const DEFAULT_ASSET_TYPE: AssetType = '头像';

// ═══════════════════════════════════════════════════════════
// 不变式
// ═══════════════════════════════════════════════════════════

/** 该字符串的下划线段里是否有整段等于类型 token 的 */
function hasTypeTokenSegment(value: string): boolean {
  return value.split('_').some(isAssetTypeToken);
}

/**
 * 是否违反命名不变式（D16）: name 的任何段、或 variant 的任何段等于类型 token。
 *
 * 导入与改名（D14）两条路都走它 —— 一份规则，两个入口，UI 不会放出非法状态。
 * 只管类型 token 这一件事（空名字之类的基础校验由调用方各自负责，
 * 免得这个函数的名字与它做的事对不上）。
 */
export function violatesNamingInvariant(name: string, variant?: string): boolean {
  if (hasTypeTokenSegment(name)) return true;
  if (variant !== undefined && variant !== '' && hasTypeTokenSegment(variant)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════

/**
 * 解析 basename，给出带理由的结论。
 *
 * ⚠️ 前置条件: 传进来的必须是 **basename**（导入器负责把 zip 路径拍平），
 * 本函数不认目录分隔符 —— 带 `/` 的输入会把分隔符当成名字的一部分。
 */
export function explainAssetFilename(basename: string): AssetFilenameResult {
  const raw = basename ?? '';

  // 扩展名: 只认真正的尾缀。dot > 0 排除了"整串就是扩展名"（`.png` 的 dot === 0），
  // 剥完就空了，那不是任何人的意思。
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'unknown-extension' };
  const ext = raw.slice(dot + 1).toLowerCase();
  if (!isAssetExtension(ext)) return { ok: false, reason: 'unknown-extension' };

  const stem = raw.slice(0, dot);
  const segments = stem.split('_');

  // 从右往左找第一个**整段**命中的类型 token（保留 RPT 的右锚定：
  // 名字自己可以带下划线）。
  let typeIndex = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (isAssetTypeToken(segments[i])) {
      typeIndex = i;
      break;
    }
  }

  let name: string;
  let type: AssetType;
  let variant: string | undefined;

  if (typeIndex === -1) {
    // 没有类型 token —— 整串都是名字，类型取缺省（D1）
    name = stem;
    type = DEFAULT_ASSET_TYPE;
    variant = undefined;
  } else {
    name = segments.slice(0, typeIndex).join('_');
    type = segments[typeIndex] as AssetType;
    const tail = segments.slice(typeIndex + 1).join('_');
    // 空尾巴（`苏婉_头像_.png`）当作无变体 —— 空串变体与缺省是同一行，
    // 留着空串只会让往返多一种等价形状。
    variant = tail === '' ? undefined : tail;
  }

  // 名字为空 —— `头像.png`（整串就是 token）、`_头像.png`。归到不变式违反：
  // 这类文件在约定下是畸形的，不是"只是有点怪"。
  if (name === '') return { ok: false, reason: 'naming-invariant' };

  // 不变式 (D16)。右锚定保证 variant 里不会有 token，所以这里实际在拦
  // **name 里含 token** 的那一半：`苏婉_头像_立绘.png` → name `苏婉_头像`。
  if (violatesNamingInvariant(name, variant)) return { ok: false, reason: 'naming-invariant' };

  // 媒体规则 (D7): mp4 只能落在不需要 alpha 的类型上
  if (!isMediaAllowed(type, ext)) return { ok: false, reason: 'mp4-on-立绘' };

  return { ok: true, parsed: variant === undefined ? { name, type, ext } : { name, type, variant, ext } };
}

/**
 * 解析 basename；不合约定返回 `null`。
 *
 * 需要知道**为什么**被拒（导入摘要要按 `命名冲突 n` / `未知扩展名 n` 分类
 * 计数）时用 `explainAssetFilename` —— 两者共用同一份解析实现。
 */
export function parseAssetFilename(basename: string): ParsedAssetName | null {
  const result = explainAssetFilename(basename);
  return result.ok ? result.parsed : null;
}

// ═══════════════════════════════════════════════════════════
// 格式化
// ═══════════════════════════════════════════════════════════

/**
 * 把一行格式化成文件名（导出用）。
 *
 * **类型总是显式写出**，即便它就是缺省的 `头像` —— 这是往返成立的前提之一：
 * 省掉类型后，名字最后一段恰好是 token 的行就再也解析不回来了。
 *
 * 不做校验、不抛异常（导出路径不该因为一行脏数据整体失败）。调用方在**写入**
 * 之前用 `violatesNamingInvariant` 拦，不要等到导出。
 */
export function formatAssetFilename(row: {
  name: string;
  type: AssetType;
  variant?: string;
  ext: string;
}): string {
  const parts = [row.name, row.type];
  if (row.variant !== undefined && row.variant !== '') parts.push(row.variant);
  return `${parts.join('_')}.${row.ext.trim().toLowerCase()}`;
}
