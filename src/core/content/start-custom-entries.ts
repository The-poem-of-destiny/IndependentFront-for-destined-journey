/**
 * start-custom-entries.ts — 玩家自制开局条目（技能 / 物品 / 装备）的**全局库**纯函数。
 *
 * 捏人页 `CustomItemForm.vue` 产出的 `CatalogItem`（id 形如 `custom_<category>_<uuid8>`）
 * 存进 Dexie 的 `createCustomItems` 表（v35，全局：不随存档删除，进 FullBackup）。
 * 本文件只管两件事，都不碰数据库：
 *
 * - `sanitizeCustomCatalogItem`：把任意来源（表行 / 手编备份 / 旧版本数据）收窄成合法
 *   `CatalogItem`，坏输入返回 `null` 而不是抛。
 * - `planLibrarySave`：同「类别 + 名称」视为同一逻辑条目，算出要落盘的行与要替换掉的旧 id。
 *
 * 🔴 **不设品质上限**（主人裁定）：自制条目允许任意 `RARITY_LABELS` 品质，包括 `only`。
 */
import type { CatalogItem, CatalogRarityCode } from './start-catalog-mechanics';
import { RARITY_LABELS } from './start-catalog';
import type { CreateCustomItemRecord } from '../persistence/database';

const CUSTOM_ID_PREFIX = 'custom_';
const CATEGORIES: ReadonlyArray<CatalogItem['category']> = ['equipment', 'item', 'skill'];
/** 原型污染键：effect / stats 是用户自填的键值表，这三个键一律丢弃 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const COST_MIN = 1;
const COST_MAX = 9999;
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 99;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function trimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = trimmedString(t);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function sanitizeEffect(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || FORBIDDEN_KEYS.has(key) || typeof v !== 'string') continue;
    out[key] = v;
  }
  return out;
}

function sanitizeStats(raw: unknown): Record<string, number> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || FORBIDDEN_KEYS.has(key)) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把任意输入收窄成合法的自制 `CatalogItem`；无法挽救时返回 `null`（永不抛）。
 *
 * 硬条件（不满足即 `null`）：id 以 `custom_` 开头、名称非空、类别合法、
 * 点数为 1–9999 的整数。软条件（不合法时回退）：品质不认识 → `common`；
 * 物品数量不合法 → 1；描述为空 → 名称。非物品不带 quantity，非装备不带 stats，
 * 非技能不带 consume。
 */
export function sanitizeCustomCatalogItem(raw: unknown): CatalogItem | null {
  if (!isPlainRecord(raw)) return null;

  const id = trimmedString(raw.id);
  if (!id.startsWith(CUSTOM_ID_PREFIX) || id.length <= CUSTOM_ID_PREFIX.length) return null;

  const name = trimmedString(raw.name);
  if (!name) return null;

  const category = raw.category as CatalogItem['category'];
  if (!CATEGORIES.includes(category)) return null;

  const cost = raw.cost;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < COST_MIN || cost > COST_MAX) {
    return null;
  }

  const rarity: CatalogRarityCode = RARITY_LABELS.includes(raw.rarity as CatalogRarityCode)
    ? (raw.rarity as CatalogRarityCode)
    : 'common';

  const item: CatalogItem = {
    id,
    name,
    category,
    type: trimmedString(raw.type),
    rarity,
    tag: sanitizeTags(raw.tag),
    effect: sanitizeEffect(raw.effect),
    description: trimmedString(raw.description) || name,
    cost,
  };

  if (category === 'skill') {
    const consume = trimmedString(raw.consume);
    if (consume) item.consume = consume;
  }
  if (category === 'item') {
    const q = raw.quantity;
    item.quantity =
      typeof q === 'number' && Number.isInteger(q) && q >= QUANTITY_MIN && q <= QUANTITY_MAX
        ? q
        : QUANTITY_MIN;
  }
  if (category === 'equipment') {
    const stats = sanitizeStats(raw.stats);
    if (stats) item.stats = stats;
  }
  return item;
}

export interface LibrarySavePlan {
  /** 要 put 的行（主键 = item.id） */
  record: CreateCustomItemRecord;
  /** 同「类别 + 名称」的旧行 id，须与 put 同一事务删掉（不含 record.id 本身） */
  replaceIds: string[];
}

/**
 * 计算一次入库：同类别同名（名称 trim 后全等）视为同一逻辑条目，新条目替换旧条目。
 *
 * - `createdAt` 继承：同 id 的旧行优先，否则取被替换行里最早的，都没有就是 `now`。
 * - `updatedAt` 恒为 `now`。
 * - 传入的 `item` 应已经过 `sanitizeCustomCatalogItem`。
 */
export function planLibrarySave(
  existing: readonly CreateCustomItemRecord[],
  item: CatalogItem,
  now: number,
): LibrarySavePlan {
  const name = item.name.trim();
  const sameId = existing.find((r) => r.id === item.id);
  const replaced = existing.filter(
    (r) => r.id !== item.id && r.category === item.category && r.name.trim() === name,
  );

  let createdAt = now;
  if (sameId) {
    createdAt = sameId.createdAt;
  } else if (replaced.length > 0) {
    createdAt = Math.min(...replaced.map((r) => r.createdAt));
  }

  return {
    record: {
      id: item.id,
      category: item.category,
      name,
      createdAt,
      updatedAt: now,
      data: { ...item, name },
    },
    replaceIds: replaced.map((r) => r.id),
  };
}
