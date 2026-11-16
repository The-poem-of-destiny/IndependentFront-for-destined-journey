/**
 * narrative-names.ts — 「名字初次登场」下划线的纯判定（动效 v1 · 特效层）
 *
 * 一条**刚生成**的正文里，第一次出现的已知专名（角色 / 稀有以上物品 / 地块 / 位置路径段）
 * 由左向右描一道淡淡的下划线。本模块只回答「哪些名字、在哪」，不碰 DOM、不读 store。
 *
 * 守则：
 * - 最长优先：同一位置能匹配多个名字时取最长的，**不在更长的已知名字内部**再匹配短名；
 * - 已在更早消息里出现过的名字不算「初次」；
 * - 每条消息至多 {@link MAX_FIRST_MENTIONS} 个，多了就不再是点睛而是满屏划线；
 * - 只活在本次会话：不落库、不进存档。
 */
import { QUALITY_RANK, type CharacterState, type InventoryItem } from '@engine/types/types';
import { splitLocationPath } from '@engine/audio/audio-scene';

/** 每条消息最多标几个名字 */
export const MAX_FIRST_MENTIONS = 3;
/** 名字最短长度：单字太容易撞上普通字词 */
const MIN_NAME_LENGTH = 2;
/** 物品要到这个品质（含）以上才算「专名」—— 品质序直接取引擎的 QUALITY_RANK */
const MIN_ITEM_RANK = QUALITY_RANK['稀有'];

export interface KnownNameSources {
  characters?: readonly Pick<CharacterState, 'type' | 'name' | 'location' | 'inventory'>[];
  /** 现行地图包的地块名（`getMapPack().tiles[].name`） */
  mapTileNames?: readonly string[];
}

/** 汇总已知专名（去重，过滤过短的） */
export function collectKnownNames(sources: KnownNameSources): string[] {
  const names = new Set<string>();
  const add = (raw: string | undefined | null) => {
    const name = (raw ?? '').trim();
    if (name.length >= MIN_NAME_LENGTH) names.add(name);
  };
  for (const character of sources.characters ?? []) {
    add(character.name);
    if (character.type !== 'player') continue;
    for (const item of (character.inventory ?? []) as readonly InventoryItem[]) {
      if (item.rarity && QUALITY_RANK[item.rarity] >= MIN_ITEM_RANK) add(item.name);
    }
    for (const segment of splitLocationPath(character.location ?? '')) add(segment);
  }
  for (const tile of sources.mapTileNames ?? []) add(tile);
  return [...names];
}

export interface NameMatch {
  name: string;
  start: number;
  end: number;
}

/** 按首字分桶、桶内长名在前 —— 扫描时每个位置只比对同首字的候选 */
export type NameIndex = ReadonlyMap<string, readonly string[]>;

export function buildNameIndex(names: readonly string[]): NameIndex {
  const index = new Map<string, string[]>();
  for (const name of names) {
    if (!name) continue;
    const head = name[0];
    const bucket = index.get(head);
    if (bucket) bucket.push(name);
    else index.set(head, [name]);
  }
  for (const bucket of index.values()) bucket.sort((a, b) => b.length - a.length);
  return index;
}

/**
 * 自左向右、最长优先地扫出全部不重叠的名字出现。
 * 命中后跳过整个名字，所以短名永远不会在长名内部被再匹配一次。
 */
export function scanNames(text: string, index: NameIndex): NameMatch[] {
  const out: NameMatch[] = [];
  if (index.size === 0) return out;
  let i = 0;
  while (i < text.length) {
    const bucket = index.get(text[i]);
    let hit: string | undefined;
    if (bucket) hit = bucket.find((name) => text.startsWith(name, i));
    if (hit) {
      out.push({ name: hit, start: i, end: i + hit.length });
      i += hit.length;
    } else i++;
  }
  return out;
}

/**
 * 一条新消息里「初次登场」的名字（按出现先后，至多 3 个）。
 * @param earlierTexts 本条之前的全部消息正文
 */
export function findFirstMentions(
  text: string,
  index: NameIndex,
  earlierTexts: readonly string[],
): string[] {
  const candidates: string[] = [];
  for (const match of scanNames(text, index)) {
    if (!candidates.includes(match.name)) candidates.push(match.name);
  }
  if (candidates.length === 0) return [];
  const pending = new Set(candidates);
  for (const earlier of earlierTexts) {
    if (pending.size === 0) break;
    // 粗筛：连子串都不含就不必细扫
    if (![...pending].some((name) => earlier.includes(name))) continue;
    for (const match of scanNames(earlier, index)) pending.delete(match.name);
  }
  return candidates.filter((name) => pending.has(name)).slice(0, MAX_FIRST_MENTIONS);
}
