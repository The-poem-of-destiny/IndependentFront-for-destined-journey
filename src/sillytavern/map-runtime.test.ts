/**
 * map-runtime.test.ts — 现行地图包注入缝的守卫测试（地图系统 v1 / 设计 §3.3·§5）
 *
 * 钉的三件事，全是「坏了不报错」那一类:
 * - **没装过 = 空包**（兜底合同，不是异常）：引擎侧全部消费方都以 `isEmptyMapPack` 早退，
 *   这里给的若不是空包，落位与天气会在一份来历不明的数据上跑
 * - **索引跟着包换**：`installMapPack` 是索引缓存唯一的失效点。缓存不失效的症状是
 *   **沿着旧地图落位**（棋子落在换图前的块上，一个字节的报错都没有）
 * - **`resetMapRuntime` 真的回到没装过**：模块级状态在 vitest 里跨用例存活，
 *   还原失败的方向是让后面每一条「空包应当整段不出」的断言**变绿**
 *
 * 🔴 夹具零真实地名（承 D25①，先例 `map-index.test.ts`）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { getMapIndex, getMapPack, installMapPack, resetMapRuntime } from './map-runtime';
import { EMPTY_MAP_PACK, isEmptyMapPack } from './map-pack';
import type { MapPack, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具
// ═══════════════════════════════════════════════════════════

function tile(id: number, name: string, patch: Partial<MapTile> = {}): MapTile {
  return {
    id,
    name,
    terrain: 'plains',
    water: null,
    impassable: false,
    countryId: null,
    midTierId: null,
    centroid: [id * 10, id * 10],
    areaPx: 100,
    ...patch,
  };
}

function pack(contentHash: string, tiles: MapTile[]): MapPack {
  return {
    version: '1.0.0',
    contentHash,
    resolution: { w: 100, h: 100 },
    kmPerPx: 1,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 120 },
      embarkCost: 5,
      terrainFactor: {},
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles,
    adjacency: [],
    straits: [],
    placeBindings: {},
  };
}

afterEach(() => {
  resetMapRuntime();
});

// ═══════════════════════════════════════════════════════════
// 缝
// ═══════════════════════════════════════════════════════════

describe('map-runtime —— 现行包注入缝', () => {
  it('没装过 → 空包（兜底合同）', () => {
    expect(isEmptyMapPack(getMapPack())).toBe(true);
    expect(getMapIndex().tileById.size).toBe(0);
  });

  it('装上之后 getMapPack 返回**同一个对象**（缝不做拷贝、也不做容错）', () => {
    const p = pack('h1', [tile(1, 'Alpha')]);
    installMapPack(p);
    expect(getMapPack()).toBe(p);
  });

  it('索引按现行包记忆化：同一个包两次调用是同一份索引', () => {
    installMapPack(pack('h1', [tile(1, 'Alpha')]));
    expect(getMapIndex()).toBe(getMapIndex());
  });

  it('换包 → 索引重建（缓存不失效的症状是沿着旧地图落位）', () => {
    installMapPack(pack('h1', [tile(1, 'Alpha')]));
    const first = getMapIndex();
    expect(first.tileById.get(1)?.name).toBe('Alpha');

    installMapPack(pack('h2', [tile(7, 'Golf')]));
    const second = getMapIndex();
    expect(second).not.toBe(first);
    expect(second.tileById.has(1)).toBe(false);
    expect(second.tileById.get(7)?.name).toBe('Golf');
  });

  it('装同一个对象两次不重建索引（幂等，热重载路径会重复调用）', () => {
    const p = pack('h1', [tile(1, 'Alpha')]);
    installMapPack(p);
    const first = getMapIndex();
    installMapPack(p);
    expect(getMapIndex()).toBe(first);
  });

  it('两份 contentHash 相同但对象不同的包照样各自建索引（键是同一性，不是 hash）', () => {
    installMapPack(pack('same', [tile(1, 'Alpha')]));
    const first = getMapIndex();
    installMapPack(pack('same', [tile(2, 'Bravo')]));
    expect(getMapIndex()).not.toBe(first);
    expect(getMapIndex().tileById.has(2)).toBe(true);
  });

  it('交进 null/undefined（注册表那一面缺席）→ 落成空包，不抛也不留半份状态', () => {
    installMapPack(pack('h1', [tile(1, 'Alpha')]));
    installMapPack(undefined as unknown as MapPack);
    expect(isEmptyMapPack(getMapPack())).toBe(true);
    expect(getMapIndex().tileById.size).toBe(0);
  });

  it('resetMapRuntime 回到没装过', () => {
    installMapPack(pack('h1', [tile(1, 'Alpha')]));
    resetMapRuntime();
    expect(getMapPack()).toBe(EMPTY_MAP_PACK);
    expect(getMapIndex().tileById.size).toBe(0);
  });
});
