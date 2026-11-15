/**
 * map-place-search — 势力地图按名字找地方（审计 MAP-03）
 */
import { describe, it, expect } from 'vitest';
import type { MapPack, MapTile } from '@engine/types/types-map';
import {
  PLACE_SEARCH_LIMIT,
  searchMapPlaces,
  stepHighlight,
} from '../../../src/ui/lib/map-place-search';

function tile(partial: Partial<MapTile> & { id: number }): MapTile {
  return {
    name: `块${partial.id}`,
    terrain: '平地',
    water: null,
    impassable: false,
    countryId: null,
    midTierId: null,
    centroid: [0, 0],
    areaPx: 1,
    ...partial,
  };
}

function pack(partial: Partial<MapPack>): MapPack {
  return {
    version: '1',
    contentHash: 'h',
    resolution: { w: 1, h: 1 },
    kmPerPx: 1,
    terrains: [],
    travelRules: {
      rates: { land: 1, nearSea: 1, farSea: 1 },
      embarkCost: 0,
      terrainFactor: {},
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [],
    adjacency: [],
    straits: [],
    placeBindings: {},
    ...partial,
  };
}

const PACK = pack({
  countries: [
    { id: 'c-a', name: '甲国', color: [0, 0, 0], anchorTileId: 2 },
    { id: 'c-x', name: '无主甲地', color: [0, 0, 0], anchorTileId: null, unclaimed: true },
  ],
  midTiers: [
    { id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: null },
    { id: 'm-empty', name: '甲空州', countryId: 'c-a', climateId: '', anchorTileId: null },
  ],
  tiles: [
    tile({ id: 1, name: '东甲城', countryId: 'c-a', midTierId: 'm-1' }),
    tile({ id: 2, name: '甲', countryId: 'c-a', midTierId: 'm-1' }),
    tile({ id: 3, name: '甲港', countryId: 'c-a' }),
    tile({ id: 4, name: '乙城' }),
  ],
});

describe('searchMapPlaces', () => {
  it('空查询 / 纯空白 → 空数组', () => {
    expect(searchMapPlaces(PACK, '')).toEqual([]);
    expect(searchMapPlaces(PACK, '   ')).toEqual([]);
  });

  it('排序：全等 → 前缀 → 包含；同档内势力 → 中层 → 地块，再按名字长短', () => {
    const names = searchMapPlaces(PACK, '甲').map((r) => `${r.kind}:${r.name}`);
    expect(names).toEqual([
      'tile:甲', // 全等
      'country:甲国', // 前缀
      'midTier:甲州',
      'tile:甲港',
      'tile:东甲城', // 包含
    ]);
  });

  it('地块结果：选自己、只框自己，并带「中层 · 势力」说明', () => {
    const [hit] = searchMapPlaces(PACK, '东甲');
    expect(hit).toMatchObject({
      kind: 'tile',
      tileId: 1,
      frameTileIds: [1],
      context: '甲州 · 甲国',
    });
  });

  it('中层缺锚 → 选第一块成员、框全部成员；势力有锚 → 选锚', () => {
    const mid = searchMapPlaces(PACK, '甲州')[0];
    expect(mid).toMatchObject({
      kind: 'midTier',
      tileId: 1,
      frameTileIds: [1, 2],
      context: '甲国',
    });
    const country = searchMapPlaces(PACK, '甲国')[0];
    expect(country).toMatchObject({ kind: 'country', tileId: 2, frameTileIds: [1, 2, 3] });
  });

  it('无主占位国与无成员的空壳中层不列出（选中它们什么也打不开）', () => {
    const keys = searchMapPlaces(PACK, '甲').map((r) => r.key);
    expect(keys).not.toContain('country:c-x');
    expect(keys).not.toContain('mid:m-empty');
  });

  it('不做模糊匹配：只有子串命中才算', () => {
    // 「东城」的字都在「东甲城」里，但不连续 —— 不算命中
    expect(searchMapPlaces(PACK, '东城')).toEqual([]);
  });

  it('拉丁字母不分大小写', () => {
    const latin = pack({ tiles: [tile({ id: 9, name: 'Northwatch' })] });
    expect(searchMapPlaces(latin, 'north').map((r) => r.tileId)).toEqual([9]);
  });

  it(`结果至多 ${PLACE_SEARCH_LIMIT} 条`, () => {
    const many = pack({
      tiles: Array.from({ length: 30 }, (_, i) => tile({ id: i + 1, name: `城${i + 1}` })),
    });
    expect(searchMapPlaces(many, '城')).toHaveLength(PLACE_SEARCH_LIMIT);
    expect(searchMapPlaces(many, '城', 3)).toHaveLength(3);
  });
});

describe('stepHighlight', () => {
  it('↓ 从无高亮到第一项、↑ 从无高亮到最后一项，两端循环', () => {
    expect(stepHighlight(-1, 1, 3)).toBe(0);
    expect(stepHighlight(-1, -1, 3)).toBe(2);
    expect(stepHighlight(2, 1, 3)).toBe(0);
    expect(stepHighlight(0, -1, 3)).toBe(2);
    expect(stepHighlight(1, 1, 3)).toBe(2);
  });

  it('空列表恒为 -1', () => {
    expect(stepHighlight(0, 1, 0)).toBe(-1);
  });
});
