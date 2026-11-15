/**
 * 势力地图的「按名字找地方」（审计 MAP-03，2026-11-14）—— 纯函数，零 DOM。
 *
 * 在地图包的三层名字里做子串匹配：地块名、中层名、势力名。每条结果带上
 * **选中哪一块**（`tileId`，地块自己 / 中层与势力取锚地块，缺锚退第一块成员）与
 * **取景框住哪些块**（`frameTileIds`，地块只框自己，中层与势力框全部成员）。
 *
 * 🔴 只做**精确的子串匹配**，不做拼音/模糊：落位契约是「绝不模糊匹配」（ADR-31），
 *    搜索虽然只是看，但一条「看着像」的模糊结果会让玩家以为那是同一个地方。
 */
import type { MapPack } from '@engine/types/types-map';

export type PlaceSearchKind = 'tile' | 'midTier' | 'country';

export interface PlaceSearchResult {
  /** 列表 key（同名的地块与中层并存时也不撞） */
  key: string;
  kind: PlaceSearchKind;
  name: string;
  /** 次要说明：地块 → 「中层 · 势力」，中层 → 势力名，势力 → 空 */
  context: string;
  /** 选中后打开信息卡的那一块 */
  tileId: number;
  /** 取景要框住的地块（至少含 `tileId`） */
  frameTileIds: number[];
}

/** 结果条数上限：下拉框一屏放得下，再多就该继续打字了 */
export const PLACE_SEARCH_LIMIT = 12;

/** 种类在同一匹配档内的先后：先大后小（搜「甲」时势力「甲国」比地块「甲一」更可能是要找的） */
const KIND_ORDER: Record<PlaceSearchKind, number> = { country: 0, midTier: 1, tile: 2 };

/** 匹配档：全等 0 / 前缀 1 / 中间包含 2 / 不匹配 -1 */
function matchRank(name: string, needle: string): number {
  const hay = name.toLowerCase();
  if (hay === needle) return 0;
  if (hay.startsWith(needle)) return 1;
  return hay.includes(needle) ? 2 : -1;
}

/**
 * 按名字搜地方。空查询返回空数组；结果按「全等 → 前缀 → 包含」排，同档内势力 → 中层 → 地块，
 * 再按名字长短（短的更像要找的那个），最后保持包内顺序。
 */
export function searchMapPlaces(
  pack: MapPack,
  query: string,
  limit: number = PLACE_SEARCH_LIMIT,
): PlaceSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0 || limit <= 0) return [];

  const countryName = new Map(pack.countries.map((c) => [c.id, c.name]));
  const midTierName = new Map(pack.midTiers.map((m) => [m.id, m.name]));
  const tilesByMid = new Map<string, number[]>();
  const tilesByCountry = new Map<string, number[]>();
  for (const tile of pack.tiles) {
    if (tile.midTierId) {
      const list = tilesByMid.get(tile.midTierId) ?? [];
      list.push(tile.id);
      tilesByMid.set(tile.midTierId, list);
    }
    if (tile.countryId) {
      const list = tilesByCountry.get(tile.countryId) ?? [];
      list.push(tile.id);
      tilesByCountry.set(tile.countryId, list);
    }
  }

  const ranked: { rank: number; result: PlaceSearchResult }[] = [];

  for (const tile of pack.tiles) {
    if (!tile.name) continue;
    const rank = matchRank(tile.name, needle);
    if (rank < 0) continue;
    const parts = [
      tile.midTierId ? midTierName.get(tile.midTierId) : undefined,
      tile.countryId ? countryName.get(tile.countryId) : undefined,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    ranked.push({
      rank,
      result: {
        key: `tile:${tile.id}`,
        kind: 'tile',
        name: tile.name,
        context: parts.join(' · '),
        tileId: tile.id,
        frameTileIds: [tile.id],
      },
    });
  }

  for (const mid of pack.midTiers) {
    if (!mid.name) continue;
    const rank = matchRank(mid.name, needle);
    if (rank < 0) continue;
    const members = tilesByMid.get(mid.id) ?? [];
    // 没有成员地块的空壳中层选不中任何东西 —— 不列出来（同标签那条：空壳不出标签）
    const target = mid.anchorTileId ?? members[0];
    if (target === undefined) continue;
    ranked.push({
      rank,
      result: {
        key: `mid:${mid.id}`,
        kind: 'midTier',
        name: mid.name,
        context: countryName.get(mid.countryId) ?? '',
        tileId: target,
        frameTileIds: members.length > 0 ? members : [target],
      },
    });
  }

  for (const country of pack.countries) {
    // 无主之地是占位国，不是一个能「找到」的地方
    if (!country.name || country.unclaimed === true) continue;
    const rank = matchRank(country.name, needle);
    if (rank < 0) continue;
    const members = tilesByCountry.get(country.id) ?? [];
    const target = country.anchorTileId ?? members[0];
    if (target === undefined) continue;
    ranked.push({
      rank,
      result: {
        key: `country:${country.id}`,
        kind: 'country',
        name: country.name,
        context: '',
        tileId: target,
        frameTileIds: members.length > 0 ? members : [target],
      },
    });
  }

  // 再往后的平手保持包内顺序（sort 是稳定的）—— 不按字典序：中文按拼音排与按笔画排
  // 各环境不一致，同一个查询换台机器顺序就变了
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      KIND_ORDER[a.result.kind] - KIND_ORDER[b.result.kind] ||
      a.result.name.length - b.result.name.length,
  );
  return ranked.slice(0, limit).map((r) => r.result);
}

/** 列表里每条的种类小标签（与信息卡「国家 / 中层」、着色档「势力 / 中层 / 地块」同一套叫法） */
export const PLACE_KIND_LABEL: Record<PlaceSearchKind, string> = {
  country: '势力',
  midTier: '中层',
  tile: '地块',
};

/** 键盘高亮项的移动（↑/↓ 循环；空列表恒为 -1） */
export function stepHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
