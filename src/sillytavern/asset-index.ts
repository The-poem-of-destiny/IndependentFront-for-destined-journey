/**
 * asset-index.ts — 由行构建素材查找结构 (Asset System v1)
 *
 * 为什么存在: 渲染面（v2 才到，§11）每次要按 (名字, 类型, 变体) 拿素材，
 * 不能每次都线性扫一遍 assetMeta。本模块把行**预折叠**成一棵
 * `大类 → 名字 → 类型 → { base, variants }` 的树，查找归 asset-resolve.ts。
 *
 * 🔴 **只吃行，永不吃目录**（§6）: 参数是 `AssetMetaRecord[]`，没有 I/O、
 * 没有 Dexie、没有文件系统。字节从哪来是 store 的事，本模块不知道也不该知道。
 *
 * 存的是 **asset id 而不是文件名**: `assetMeta` 行才是真源，字节按 id 查
 * （assetBlobs）。存文件名等于把 `formatAssetFilename` 的结论复制进索引，
 * 改名（D14）后立刻对不上。
 *
 * 大类**派生不读行**: 走 `categoryForType(row.type)`。行里刻意没有 category
 * 列（§4.1），存一份就是第二个真相来源（铁律4）。
 *
 * `AssetIndex` 是**派生结构，不是落库实体**，所以本地声明本地导出 —— 与
 * asset-filename.ts 自持 `ParsedAssetName`、audio-scene.ts / audio-tags.ts
 * 自持返回形状同一个规矩；它不进 types.ts。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §3 / §6
 */

import { categoryForType } from './asset-types';
import type { AssetCategory, AssetMetaRecord, AssetType } from './types';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/**
 * 某个 (名字, 类型) 下的素材位。
 *
 * `base` 是无变体那一张 —— 请求变体但没有时的兜底（asset-resolve.ts）。
 * 它可以缺省: 一个只有 `苏婉_立绘_微笑.png` 的美术包就没有 base。
 */
export interface AssetTypeSlot {
  /** 无变体行的 asset id；该 (名字, 类型) 没有无变体行时缺省 */
  base?: string;
  /** 变体名 → asset id。恒为对象（可能为空），调用方不必判空 */
  variants: Record<string, string>;
}

/** 某个名字下按类型分的素材位。类型可缺（只有头像的角色就只有 `头像` 键） */
export type AssetNameSlots = Partial<Record<AssetType, AssetTypeSlot>>;

/**
 * 素材查找结构: `大类 → 名字 → 类型 → 位`。
 *
 * 名字是**原始字符串键**，`===` 匹配，不做任何归一化（D2）——
 * 刻意背离 audio-names.ts 的 `normalizeAudioName`，理由见 §3。
 */
export type AssetIndex = Record<AssetCategory, Record<string, AssetNameSlots>>;

// ═══════════════════════════════════════════════════════════
// 构建
// ═══════════════════════════════════════════════════════════

/**
 * 同一个位撞车时的排序键: `createdAt` 升序，再按 `id` 升序。
 *
 * 与 audio-names.ts:78-86 `compareStable` 同一条规则（那里不导出，
 * 且它属于音频；照抄四行胜过把两个子系统绑在一起）。刻意不 import
 * audio 任何东西 —— 素材与音频只共享规矩，不共享代码。
 */
function compareStable(a: AssetMetaRecord, b: AssetMetaRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 空变体（`undefined` / `''`）归一为"无变体" —— 与 asset-filename 的空尾巴口径一致 */
function variantKeyOf(row: AssetMetaRecord): string | undefined {
  return row.variant === undefined || row.variant === '' ? undefined : row.variant;
}

/**
 * 由行构建索引。
 *
 * 撞车（两行争同一个 base，或同一个变体）**按 `compareStable` 定胜负**:
 * createdAt 最早者胜，同 createdAt 按 id 升序。
 *
 * 为什么需要这条规则: 导入器（D11 碰撞编号）与 store 是唯一防线，理论上写不出
 * 两行同位；但"理论上不会发生"不等于"发生了可以随便处理"。若按数组顺序决胜，
 * 答案就跟着 Dexie 的返回顺序变，同一个库刷新两次给两张图。存量重名行刻意保留
 * （同音频），所以答案必须与数组顺序无关、跨次加载稳定。
 */
export function buildAssetIndex(rows: readonly AssetMetaRecord[]): AssetIndex {
  const index: AssetIndex = { character: {} };
  /** 位 → 当前胜出行，仅构建期存在，不出函数 */
  const winners = new Map<string, AssetMetaRecord>();

  for (const row of rows) {
    const category = categoryForType(row.type);
    const byName = index[category];
    const slots = (byName[row.name] ??= {});
    const slot = (slots[row.type] ??= { variants: {} });

    const variant = variantKeyOf(row);
    // 键用 JSON.stringify 而非拼接: 名字与变体是**任意用户字符串**，
    // 任何分隔符都可能出现在里面，`a` + `b` 与 `ab` 撞键会让撞车判定错位。
    const slotKey = JSON.stringify([category, row.name, row.type, variant ?? null]);

    const prev = winners.get(slotKey);
    if (prev !== undefined && compareStable(prev, row) <= 0) continue;
    winners.set(slotKey, row);

    if (variant === undefined) slot.base = row.id;
    else slot.variants[variant] = row.id;
  }

  return index;
}
