/**
 * map-context.test.ts — 两个投影的契约测试（地图系统 v1 / 设计 §8.1）
 *
 * 夹具规矩（设计 §10 + D25①）：**零真实地名**。地块名/国名/中层名全是合成的中立英文串，
 * 地形词是本夹具自造的包词汇（引擎不认识它们，这正是「换图零改码」要的）。
 * 唯一出现的中文是 `LocationNode.neighbors[].terrain` 那格 —— 它的类型 `TerrainType` 是
 * types.ts 里的封闭中文枚举（旧语义图的既有形状），不是本模块的词汇。
 *
 * 🔴 **坐标是屏幕坐标：y 向下增长**。正北 = 更小的 y。这条写反了不会报错，只会让每一条
 *    邻接行的南北颠倒（`map-index.compassOf` 的注释里有同一条警告）—— 所以下面四个方位
 *    各有一条断言，而不是只测一个。
 */

import { describe, expect, it } from 'vitest';

import { buildMapSnapshot, buildRuntimeGeoData, type MapSnapshotOptions } from './map-context';
import { EMPTY_MAP_PACK } from './map-pack';
import { findPath } from './map-path';
import type { LocationNode, TerrainType } from './types';
import type { MapPack } from './types-map';

// ══════════════════════════════════════════════════════════════
// 夹具：8 块地（两国 + 无主 + 悬空国 + 海 + 湖 + 不可通行 + 孤块）
// ══════════════════════════════════════════════════════════════

const TILE_HEARTH = 1;
const TILE_NORTH = 2;
const TILE_EAST = 3;
const TILE_LAKE = 4;
const TILE_RIDGE = 5;
const TILE_ISLE = 6;
const TILE_FAR = 7;
const TILE_LONELY = 8;

function makePack(): MapPack {
  return {
    version: '0.0.0-fixture',
    contentHash: 'fixture-hash',
    resolution: { w: 1000, h: 1000 },
    kmPerPx: 1,
    terrains: ['flatland', 'frostwaste', 'grassland', 'stillwater', 'crag', 'shelf'],
    travelRules: {
      rates: { land: 40, nearSea: 60, farSea: 100 },
      embarkCost: 20,
      terrainFactor: { flatland: 1, grassland: 1.2 },
      modes: [],
    },
    countries: [
      { id: 'c-alpha', name: 'Alpha Realm', color: [10, 20, 30], anchorTileId: TILE_HEARTH },
      { id: 'c-beta', name: 'Beta Realm', color: [40, 50, 60], anchorTileId: TILE_EAST },
    ],
    midTiers: [
      {
        id: 'm-vale',
        name: 'Vale Province',
        countryId: 'c-alpha',
        climateId: '',
        anchorTileId: TILE_HEARTH,
      },
    ],
    climates: {},
    tiles: [
      {
        id: TILE_HEARTH,
        name: 'Hearth',
        terrain: 'flatland',
        water: null,
        impassable: false,
        countryId: 'c-alpha',
        midTierId: 'm-vale',
        centroid: [100, 100],
        areaPx: 90,
      },
      {
        // 正北：y 更小
        id: TILE_NORTH,
        name: 'Frostmoor',
        terrain: 'frostwaste',
        water: null,
        impassable: false,
        countryId: 'c-alpha',
        midTierId: null,
        centroid: [100, 40],
        areaPx: 70,
      },
      {
        // 正东，异主
        id: TILE_EAST,
        name: 'Sunfield',
        terrain: 'grassland',
        water: null,
        impassable: false,
        countryId: 'c-beta',
        midTierId: null,
        centroid: [160, 100],
        areaPx: 60,
      },
      {
        // 正南，湖（v1 一律不可入，但拓扑上照样是邻块）
        id: TILE_LAKE,
        name: 'Stillmere',
        terrain: 'stillwater',
        water: 'lake',
        impassable: false,
        countryId: null,
        midTierId: null,
        centroid: [100, 160],
        areaPx: 20,
      },
      {
        // 正西，不可通行
        id: TILE_RIDGE,
        name: 'Cragspine',
        terrain: 'crag',
        water: null,
        impassable: true,
        countryId: null,
        midTierId: null,
        centroid: [40, 100],
        areaPx: 30,
      },
      {
        // 东边更远：海峡补边过去；国家 id 悬空（包里没有这一行）
        id: TILE_ISLE,
        name: 'Pale Reach',
        terrain: 'shelf',
        water: 'sea',
        impassable: false,
        countryId: 'c-ghost',
        midTierId: null,
        centroid: [220, 100],
        areaPx: 40,
      },
      {
        // 旅行目的地（两跳外，不是邻块）
        id: TILE_FAR,
        name: 'Farhold',
        terrain: 'flatland',
        water: null,
        impassable: false,
        countryId: 'c-beta',
        midTierId: null,
        centroid: [280, 100],
        areaPx: 50,
      },
      {
        // 孤块：在图里但没有任何边 → 无路可走
        id: TILE_LONELY,
        name: 'Lonely Rock',
        terrain: 'flatland',
        water: null,
        impassable: false,
        countryId: null,
        midTierId: null,
        centroid: [900, 900],
        areaPx: 10,
      },
    ],
    adjacency: [
      [TILE_HEARTH, TILE_NORTH, 12],
      [TILE_HEARTH, TILE_EAST, 14],
      [TILE_HEARTH, TILE_LAKE, 8],
      [TILE_HEARTH, TILE_RIDGE, 6],
      [TILE_EAST, TILE_FAR, 11],
    ],
    straits: [[TILE_HEARTH, TILE_ISLE]],
    placeBindings: {},
  };
}

function makeOptions(overrides: Partial<MapSnapshotOptions> = {}): MapSnapshotOptions {
  return { currentTileId: TILE_HEARTH, weatherLabel: null, ...overrides };
}

// ══════════════════════════════════════════════════════════════
// buildMapSnapshot —— 当前行
// ══════════════════════════════════════════════════════════════

describe('buildMapSnapshot —— 当前地块行', () => {
  it('给出名字/地形/通行性 + 中层名与国名（链解析）', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions({ weatherLabel: 'light snow' }));

    expect(snapshot.current).toEqual({
      name: 'Hearth',
      terrain: 'flatland',
      water: null,
      impassable: false,
      midTierName: 'Vale Province',
      countryName: 'Alpha Realm',
    });
    expect(snapshot.weatherLabel).toBe('light snow');
  });

  it('不泄露 tileId / 坐标（§8.3 保护面：AI 只见名字）', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions());

    // 键集合锁死：将来谁往投影里加一个 id/centroid，这条会红
    expect(Object.keys(snapshot.current ?? {}).sort()).toEqual([
      'countryName',
      'impassable',
      'midTierName',
      'name',
      'terrain',
      'water',
    ]);
    expect(Object.keys(snapshot.neighbors[0] ?? {}).sort()).toEqual([
      'dir',
      'impassable',
      'name',
      'ownerName',
      'terrain',
      'water',
    ]);
  });

  it('无中层/无主的地块两格给 null，而不是省掉那两个键', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions({ currentTileId: TILE_LAKE }));

    expect(snapshot.current?.midTierName).toBeNull();
    expect(snapshot.current?.countryName).toBeNull();
  });

  it('当前地块解析不到（包换版 / 从未落位）→ current 为 null 且邻接空', () => {
    const pack = makePack();

    const unknown = buildMapSnapshot(pack, makeOptions({ currentTileId: 999 }));
    expect(unknown.current).toBeNull();
    expect(unknown.neighbors).toEqual([]);

    const unlocated = buildMapSnapshot(pack, makeOptions({ currentTileId: null }));
    expect(unlocated.current).toBeNull();
    expect(unlocated.neighbors).toEqual([]);
  });

  it('空包照常返回形状完整的空快照（合同不是异常）', () => {
    const snapshot = buildMapSnapshot(
      EMPTY_MAP_PACK,
      makeOptions({
        currentTileId: TILE_HEARTH,
        weatherLabel: 'clear',
        journey: { toTileId: TILE_FAR, plannedPath: [TILE_HEARTH, TILE_FAR], arriveAtMinute: 900 },
        discontinuity: 3,
      }),
    );

    expect(snapshot).toEqual({
      current: null,
      neighbors: [],
      journey: null,
      weatherLabel: 'clear',
      discontinuity: 3,
    });
  });

  it('weatherLabel 与 discontinuity 原样搬运；discontinuity 缺席读作 null', () => {
    const pack = makePack();

    expect(buildMapSnapshot(pack, makeOptions()).discontinuity).toBeNull();
    expect(buildMapSnapshot(pack, makeOptions({ discontinuity: 4 })).discontinuity).toBe(4);
    expect(buildMapSnapshot(pack, makeOptions({ weatherLabel: null })).weatherLabel).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// buildMapSnapshot —— 邻接行
// ══════════════════════════════════════════════════════════════

describe('buildMapSnapshot —— 一跳邻接', () => {
  it('罗盘方位按屏幕坐标算：正上方 = N（y 向下增长）', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions());
    const dirs = new Map(snapshot.neighbors.map((row) => [row.name, row.dir]));

    expect(dirs.get('Frostmoor')).toBe('N');
    expect(dirs.get('Sunfield')).toBe('E');
    expect(dirs.get('Stillmere')).toBe('S');
    expect(dirs.get('Cragspine')).toBe('W');
  });

  it('邻接 ∪ 海峡都在列，两跳外的地块不在列', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions());

    expect(snapshot.neighbors.map((row) => row.name)).toEqual([
      'Frostmoor',
      'Sunfield',
      'Stillmere',
      'Cragspine',
      'Pale Reach',
    ]);
  });

  it('不可通行块与水域块照样在列，并带各自的标记位', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions());
    const rows = new Map(snapshot.neighbors.map((row) => [row.name, row]));

    expect(rows.get('Cragspine')?.impassable).toBe(true);
    expect(rows.get('Stillmere')?.water).toBe('lake');
    expect(rows.get('Pale Reach')?.water).toBe('sea');
    expect(rows.get('Frostmoor')?.water).toBeNull();
  });

  it('所有者只在异主时出现（token 经济）', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions());
    const owners = new Map(snapshot.neighbors.map((row) => [row.name, row.ownerName]));

    // 同国：不重复标一遍国名
    expect(owners.get('Frostmoor')).toBeNull();
    // 异国：标出来
    expect(owners.get('Sunfield')).toBe('Beta Realm');
    // 无主之地：异于当前国，但没有名字可给
    expect(owners.get('Stillmere')).toBeNull();
    // 悬空国 id：判得出异主，查不到行 → 同样不显示所有者
    expect(owners.get('Pale Reach')).toBeNull();
  });

  it('从无主之地看邻块时，有主的那一侧才标所有者', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions({ currentTileId: TILE_LAKE }));
    const owners = new Map(snapshot.neighbors.map((row) => [row.name, row.ownerName]));

    expect(owners.get('Hearth')).toBe('Alpha Realm');
  });

  it('孤块的邻接是空数组（而不是 current 为 null）', () => {
    const snapshot = buildMapSnapshot(makePack(), makeOptions({ currentTileId: TILE_LONELY }));

    expect(snapshot.current?.name).toBe('Lonely Rock');
    expect(snapshot.neighbors).toEqual([]);
  });

  it('顺序稳定：包里边的书写顺序不影响邻接行顺序', () => {
    const pack = makePack();
    const shuffled = makePack();
    shuffled.adjacency = [...pack.adjacency].reverse();

    expect(buildMapSnapshot(shuffled, makeOptions()).neighbors).toEqual(
      buildMapSnapshot(pack, makeOptions()).neighbors,
    );
  });
});

// ══════════════════════════════════════════════════════════════
// buildMapSnapshot —— 在途摘要
// ══════════════════════════════════════════════════════════════

describe('buildMapSnapshot —— 在途摘要', () => {
  it('目的地名 + 计划路线上的下一站 + 按当前位置重估的剩余天数', () => {
    const pack = makePack();
    const snapshot = buildMapSnapshot(
      pack,
      makeOptions({
        journey: {
          toTileId: TILE_FAR,
          plannedPath: [TILE_HEARTH, TILE_EAST, TILE_FAR],
          arriveAtMinute: 12_000,
        },
      }),
    );

    expect(snapshot.journey?.toName).toBe('Farhold');
    expect(snapshot.journey?.nextName).toBe('Sunfield');
    // 与寻路同一个答案（本层的贡献是「从哪儿到哪儿」，不是自己算路）
    expect(snapshot.journey?.remainingDays).toBe(findPath(pack, TILE_HEARTH, TILE_FAR)?.days);
    expect(snapshot.journey?.remainingDays).toBeGreaterThan(0);
  });

  it('剩余天数不读 arriveAtMinute（无时钟）：改到达时刻不改结果', () => {
    const pack = makePack();
    const base = {
      toTileId: TILE_FAR,
      plannedPath: [TILE_HEARTH, TILE_EAST, TILE_FAR],
    };

    const early = buildMapSnapshot(
      pack,
      makeOptions({ journey: { ...base, arriveAtMinute: 1 } }),
    ).journey;
    const late = buildMapSnapshot(
      pack,
      makeOptions({ journey: { ...base, arriveAtMinute: 999_999 } }),
    ).journey;

    expect(early).toEqual(late);
  });

  it('叙事偏离计划路线 → 只失去「下一站」，剩余天数照旧重估', () => {
    const pack = makePack();
    const snapshot = buildMapSnapshot(
      pack,
      makeOptions({
        currentTileId: TILE_EAST,
        journey: {
          toTileId: TILE_FAR,
          // 玩家现在在 TILE_EAST，而计划路线里根本没有这一站
          plannedPath: [TILE_HEARTH, TILE_LAKE, TILE_FAR],
          arriveAtMinute: 12_000,
        },
      }),
    );

    expect(snapshot.journey?.nextName).toBeNull();
    expect(snapshot.journey?.remainingDays).toBe(findPath(pack, TILE_EAST, TILE_FAR)?.days);
  });

  it('没有计划路线 / 当前已是路线末站 → 下一站为 null', () => {
    const pack = makePack();

    const noPlan = buildMapSnapshot(
      pack,
      makeOptions({ journey: { toTileId: TILE_FAR, arriveAtMinute: 5 } }),
    );
    expect(noPlan.journey?.nextName).toBeNull();
    expect(noPlan.journey?.toName).toBe('Farhold');

    const atEnd = buildMapSnapshot(
      pack,
      makeOptions({
        currentTileId: TILE_FAR,
        journey: { toTileId: TILE_FAR, plannedPath: [TILE_HEARTH, TILE_FAR], arriveAtMinute: 5 },
      }),
    );
    expect(atEnd.journey?.nextName).toBeNull();
  });

  it('无路可走 / 未落位 → 剩余天数为 null，但在途本身仍然报出来', () => {
    const pack = makePack();

    const isolated = buildMapSnapshot(
      pack,
      makeOptions({
        currentTileId: TILE_LONELY,
        journey: { toTileId: TILE_FAR, arriveAtMinute: 5 },
      }),
    );
    expect(isolated.journey).toEqual({
      toName: 'Farhold',
      nextName: null,
      remainingDays: null,
    });

    const unlocated = buildMapSnapshot(
      pack,
      makeOptions({
        currentTileId: null,
        journey: {
          toTileId: TILE_FAR,
          plannedPath: [TILE_HEARTH, TILE_FAR],
          arriveAtMinute: 5,
        },
      }),
    );
    expect(unlocated.journey).toEqual({
      toName: 'Farhold',
      nextName: null,
      remainingDays: null,
    });
  });

  it('目的地地块查不到（旗是旧包留下的）→ 整段 null，不造「前往未知」', () => {
    const snapshot = buildMapSnapshot(
      makePack(),
      makeOptions({ journey: { toTileId: 4242, arriveAtMinute: 5 } }),
    );

    expect(snapshot.journey).toBeNull();
  });

  it('没有在途旗 → null', () => {
    expect(buildMapSnapshot(makePack(), makeOptions()).journey).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// buildRuntimeGeoData —— uid 446 契约
// ══════════════════════════════════════════════════════════════

function makeNodes(): LocationNode[] {
  return [
    {
      id: 'root-land',
      name: 'Root Continent',
      type: 'continent',
      parentId: null,
      tier: 1,
      description: 'A wide temperate landmass.',
      neighbors: [],
    },
    {
      id: 'reg-alpha',
      name: 'Region Alpha',
      type: 'region',
      parentId: 'root-land',
      tier: 2,
      description: '',
      neighbors: [
        {
          targetId: 'reg-beta',
          terrain: '平原',
          distance: 6,
          fromDirection: '西',
          toDirection: '东',
        },
      ],
    },
    {
      id: 'reg-beta',
      name: 'Region Beta',
      type: 'region',
      parentId: 'root-land',
      tier: 2,
      description: 'Wooded uplands.',
      // 反向重复声明（数据里两侧各写一遍），且天数/地形与正向不一致
      neighbors: [{ targetId: 'reg-alpha', terrain: '森林', distance: 9 }],
    },
    {
      id: 'city-one',
      name: 'City One',
      type: 'city',
      parentId: 'reg-alpha',
      tier: 3,
      description: 'A river town.',
      neighbors: [
        // 自环 + 悬空端点：两条都该被丢掉
        { targetId: 'city-one', terrain: '平原', distance: 1 },
        { targetId: 'nowhere', terrain: '平原', distance: 2 },
      ],
    },
  ];
}

describe('buildRuntimeGeoData —— 字段改名与显著度', () => {
  it('parentId → parent，description 串 → { brief }，空说明不产该键', () => {
    const data = buildRuntimeGeoData(makeNodes(), null);
    const byName = new Map(data.places.map((place) => [place.name, place]));

    expect(byName.get('City One')).toEqual({
      id: 'city-one',
      name: 'City One',
      parent: 'reg-alpha',
      importance: 2,
      description: { brief: 'A river town.' },
    });
    expect(byName.get('Region Alpha')).not.toHaveProperty('description');
  });

  it('tier → importance 是反向的：区域必须过得了消费方 importance >= 3 的门', () => {
    const data = buildRuntimeGeoData(makeNodes(), null);
    const byName = new Map(data.places.map((place) => [place.name, place.importance]));

    expect(byName.get('Root Continent')).toBe(4);
    expect(byName.get('Region Alpha')).toBe(3);
    expect(byName.get('City One')).toBe(2);
  });

  it('异常 tier 落到最低显著度，不被提拔成「区域」', () => {
    const nodes: LocationNode[] = [
      { ...makeNodes()[3], id: 'weird', tier: Number.NaN },
      { ...makeNodes()[3], id: 'deep', tier: 12 },
      { ...makeNodes()[3], id: 'shallow', tier: -5 },
    ];
    const byId = new Map(buildRuntimeGeoData(nodes, null).places.map((p) => [p.id, p.importance]));

    expect(byId.get('weird')).toBe(1);
    expect(byId.get('deep')).toBe(1);
    expect(byId.get('shallow')).toBe(4);
  });

  it('重复 id 先到先得', () => {
    const nodes = makeNodes();
    const data = buildRuntimeGeoData([...nodes, { ...nodes[3], name: 'Impostor' }], null);

    expect(data.places.filter((place) => place.id === 'city-one')).toHaveLength(1);
    expect(data.places.find((place) => place.id === 'city-one')?.name).toBe('City One');
  });

  it('current 是原样搬运的 advisory 值（trim；空串读作 null）', () => {
    expect(buildRuntimeGeoData(makeNodes(), '  Region Alpha  ').current).toBe('Region Alpha');
    expect(buildRuntimeGeoData(makeNodes(), '   ').current).toBeNull();
    expect(buildRuntimeGeoData(makeNodes(), null).current).toBeNull();
  });

  it('空输入 → 形状完整的空数据（消费方自有区域级回退）', () => {
    expect(buildRuntimeGeoData([], null)).toEqual({ places: [], edges: [], current: null });
  });
});

describe('buildRuntimeGeoData —— 边', () => {
  it('A↔B 合成一条，先声明的那条说了算', () => {
    const data = buildRuntimeGeoData(makeNodes(), null);
    const pairs = data.edges.map((edge) => `${edge.from}>${edge.to}`);

    expect(pairs).toEqual(['reg-alpha>reg-beta']);
    expect(data.edges[0].segments).toEqual([{ days: 6, terrain: ['平原'], direction: '西-东' }]);
  });

  it('自环与悬空端点都被丢掉', () => {
    const data = buildRuntimeGeoData(makeNodes(), null);

    expect(data.edges.some((edge) => edge.from === edge.to)).toBe(false);
    expect(data.edges.some((edge) => edge.to === 'nowhere')).toBe(false);
  });

  it('两端方位齐备才产 direction（单端会让消费方反读出错话）', () => {
    const nodes = makeNodes();
    nodes[1].neighbors = [
      { targetId: 'reg-beta', terrain: '平原', distance: 3, fromDirection: '西' },
    ];
    nodes[2].neighbors = [];

    expect(buildRuntimeGeoData(nodes, null).edges[0].segments[0]).not.toHaveProperty('direction');
  });

  it('方位串自身含连接符时不产（反读会切错位置）', () => {
    const nodes = makeNodes();
    nodes[1].neighbors = [
      {
        targetId: 'reg-beta',
        terrain: '平原',
        distance: 3,
        fromDirection: '西-北',
        toDirection: '东',
      },
    ];
    nodes[2].neighbors = [];

    expect(buildRuntimeGeoData(nodes, null).edges[0].segments[0]).not.toHaveProperty('direction');
  });

  it('distance → days：整数原样，小数取整，负数与非有穷读作未知（null）', () => {
    const build = (distance: number): number | null => {
      const nodes = makeNodes();
      nodes[1].neighbors = [{ targetId: 'reg-beta', terrain: '平原', distance }];
      nodes[2].neighbors = [];
      return buildRuntimeGeoData(nodes, null).edges[0].segments[0].days;
    };

    expect(build(6)).toBe(6);
    expect(build(2.4)).toBe(2);
    expect(build(-3)).toBeNull();
    expect(build(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('空地形串不产 terrain（有源就传，无源就省）', () => {
    const nodes = makeNodes();
    nodes[1].neighbors = [{ targetId: 'reg-beta', terrain: '  ' as TerrainType, distance: 3 }];
    nodes[2].neighbors = [];

    expect(buildRuntimeGeoData(nodes, null).edges[0].segments[0]).not.toHaveProperty('terrain');
  });

  it('不产 transport 与 edge.importance（旧语义图里没有这两个维度）', () => {
    const data = buildRuntimeGeoData(makeNodes(), null);

    expect(data.edges[0]).not.toHaveProperty('importance');
    expect(data.edges[0].segments[0]).not.toHaveProperty('transport');
  });
});

describe('buildRuntimeGeoData —— 大陆哨兵 id', () => {
  it('单根大陆改写成消费方认识的哨兵，父引用与边端点一起改', () => {
    const nodes = makeNodes();
    nodes[0].neighbors = [{ targetId: 'reg-alpha', terrain: '平原', distance: 4 }];
    const data = buildRuntimeGeoData(nodes, null);
    const byName = new Map(data.places.map((place) => [place.name, place]));

    expect(byName.get('Root Continent')?.id).toBe('continent');
    expect(byName.get('Root Continent')?.parent).toBeNull();
    expect(byName.get('Region Alpha')?.parent).toBe('continent');
    expect(data.edges.some((edge) => edge.from === 'continent' || edge.to === 'continent')).toBe(
      true,
    );
    expect(data.places.some((place) => place.id === 'root-land')).toBe(false);
  });

  it('两个大陆根 → 一律不改写（改谁都是任意的）', () => {
    const nodes = makeNodes();
    nodes.push({
      id: 'root-two',
      name: 'Second Continent',
      type: 'continent',
      parentId: null,
      tier: 1,
      description: '',
      neighbors: [],
    });
    const data = buildRuntimeGeoData(nodes, null);

    expect(data.places.some((place) => place.id === 'root-land')).toBe(true);
    expect(data.places.some((place) => place.id === 'continent')).toBe(false);
    expect(data.places.find((place) => place.name === 'Region Alpha')?.parent).toBe('root-land');
  });

  it('已经有节点占用哨兵 id → 不改写（避免撞成两个同 id）', () => {
    const nodes = makeNodes();
    nodes[3].id = 'continent';
    const data = buildRuntimeGeoData(nodes, null);

    expect(data.places.filter((place) => place.id === 'continent')).toHaveLength(1);
    expect(data.places.find((place) => place.name === 'Root Continent')?.id).toBe('root-land');
  });
});
