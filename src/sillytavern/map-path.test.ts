/**
 * map-path.test.ts — 混合通行图寻路的守卫测试（地图系统 v1 / 设计 §6·§10）
 *
 * 钉的都是「改坏了不报错，只会静默算错路」那一类:
 * - 路径穿过 impassable / lake —— 所以夹具里那两块**刻意配成最便宜的捷径**：忘了剔除它们的
 *   实现会立刻选中它们，而不是「恰好也选了正确那条」（后者是空转夹具，测试绿得毫无意义）
 * - 陆海混合计价：累计**时间**而不是公里；近海/远洋按**推导**分档；登/离船只加在跨界那条边上
 * - 决定性：平局按地块 id 升序 —— 两条同天数的路线互换，任何天数断言都不会红，只有玩家看得见
 * - `via` 顺序、`avoid` 生效、端点不可用、空包 —— 全部必须是 `null` 而不是一条编出来的路线
 *
 * 🔴 **夹具零真实地名**（承 D25①）：12 块地叫 Alpha…Mike，地形叫 plains/forest/tundra，
 *    国家叫 Northland/Southmark。词汇是**包定义**的，引擎一个字都不认识 —— 用中性词做夹具
 *    本身就是在证明这件事（同一套断言在任何词汇表下都成立）。
 *
 * 🔴 「预期天数」由**独立重算**（`expectedRouteDays`）给出，照设计 §6.2 的公式重写一遍，
 *    不 import 实现里的任何内部函数（先例 `image-quota.property.test.ts` 的 `expectedReason`）。
 *    与实现同源的期望值等于同义反复：公式写错时两边一起错，测试照样绿。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { findPath, type FindPathOptions } from './map-path';
import { coerceMapPack, EMPTY_MAP_PACK } from './map-pack';
import type { MapAdjacencyEdge, MapPack, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 夹具（12 块：两国 + 无主 + 三块海 + 湖 + 不可通行山脊 + 一条海峡 + 一块孤岛）
// ═══════════════════════════════════════════════════════════

/**
 * 地图长这样（x 向右、y 向下；`kmPerPx = 1`，故像素数就是公里数）:
 *
 *            5 Echo(sea)      6 Foxtrot(sea)                9 India(sea)
 *              (100,-100)       (300,-100)                    (500,-100)
 *                  |                                              |
 *               7 Golf(lake, 100,-30)  ← 便宜捷径，必须走不通
 *   1 Alpha ——— 2 Bravo ——— 3 Charlie                       10 Kilo ~~~ 11 Lima
 *   (0,0)        (100,0)      (200,0)                          (500,0)    (700,0)
 *      \      8 Hotel(impassable, 100,30) ← 便宜捷径，必须走不通      ~~~ = 海峡补边
 *       \___ 4 Delta(100,60) ___/                              12 Mike(900,0) 完全孤立
 *
 * 三条关键的「便宜捷径」安排:
 *   · 湖块 Golf 与不可通行的 Hotel 都直连 Alpha 与 Charlie，且 `ridge` 系数配成 **0.1**
 *     （比平原还便宜）—— 任何一处漏剔，`1 → 3` 的答案立刻变
 *   · `1 → 3` 的正解是绕 Delta 的**平原长路**（23.3 天）而不是穿 Bravo 的**森林短路**（30 天），
 *     所以这条断言同时钉住「按代价不按跳数」与「系数取终点地形」
 */
const FIXTURE: MapPack = {
  version: '1.0.0',
  contentHash: 'fixture-hash',
  resolution: { w: 1000, h: 400 },
  kmPerPx: 1,
  terrains: ['plains', 'forest', 'tundra', 'ridge', 'ocean', 'still-water'],
  // v1.0.0 的包没有档名表；`coerceMapPack` 给它补空表（照 `travelRules.modes` 的先例），
  // 所以这份「能从解析器里出来」的夹具也得带着它，否则自证那条会红
  developmentLevels: [],
  mainBuildingNames: [],
  travelRules: {
    rates: { land: 10, nearSea: 20, farSea: 40 },
    embarkCost: 4,
    // 🔴 `ridge` 刻意比平原便宜、`tundra` 刻意缺席（缺键必须回退 1.0）
    terrainFactor: { plains: 1, forest: 2, ridge: 0.1, 'still-water': 0.1 },
    modes: [],
  },
  countries: [
    { id: 'north', name: 'Northland', color: [10, 20, 30], anchorTileId: 1 },
    { id: 'south', name: 'Southmark', color: [200, 10, 10], anchorTileId: 3 },
  ],
  midTiers: [
    {
      id: 'north-a',
      name: 'North Vale',
      countryId: 'north',
      climateId: 'zone-cold',
      anchorTileId: 1,
    },
    {
      id: 'south-a',
      name: 'South Reach',
      countryId: 'south',
      climateId: 'zone-mild',
      anchorTileId: 3,
    },
    // 海也有中层（真实包里形如「某某海」）—— crossings 的水段就靠它报名字
    { id: 'open-water', name: 'Pale Sea', countryId: '', climateId: '', anchorTileId: null },
  ],
  climates: {},
  tiles: [
    tile(1, 'Alpha', [0, 0], 'plains', { countryId: 'north', midTierId: 'north-a' }),
    tile(2, 'Bravo', [100, 0], 'forest', { countryId: 'north', midTierId: 'north-a' }),
    tile(3, 'Charlie', [200, 0], 'plains', { countryId: 'south', midTierId: 'south-a' }),
    // 无主之地（两个外键都空）—— crossings 落到地块自己的名字那一档
    tile(4, 'Delta', [100, 60], 'plains', {}),
    tile(5, 'Echo', [100, -100], 'ocean', { water: 'sea', midTierId: 'open-water' }),
    tile(6, 'Foxtrot', [300, -100], 'ocean', { water: 'sea', midTierId: 'open-water' }),
    tile(7, 'Golf', [100, -30], 'still-water', { water: 'lake' }),
    tile(8, 'Hotel', [100, 30], 'ridge', {
      impassable: true,
      countryId: 'north',
      midTierId: 'north-a',
    }),
    tile(9, 'India', [500, -100], 'ocean', { water: 'sea', midTierId: 'open-water' }),
    tile(10, 'Kilo', [500, 0], 'plains', { countryId: 'south', midTierId: 'south-a' }),
    // 只有国家没有中层 —— crossings 的中间那一档
    tile(11, 'Lima', [700, 0], 'tundra', { countryId: 'south' }),
    tile(12, 'Mike', [900, 0], 'plains', { countryId: 'south', midTierId: 'south-a' }),
  ],
  adjacency: [
    [1, 2, 100],
    [2, 3, 80],
    [1, 4, 50],
    [4, 3, 60],
    [1, 7, 10], // 湖捷径
    [7, 3, 10],
    [1, 8, 10], // 不可通行捷径
    [8, 3, 10],
    [2, 5, 40], // 唯一的登船岸
    [5, 6, 200],
    [6, 9, 200],
    [9, 10, 40], // 唯一的离船岸
  ],
  straits: [[10, 11]],
  placeBindings: {},
};

/** 地块构造器（把夹具里那一大片重复字段压掉，只留每块真正不同的那几格） */
function tile(
  id: number,
  name: string,
  centroid: [number, number],
  terrain: string,
  extra: Partial<Pick<MapTile, 'water' | 'impassable' | 'countryId' | 'midTierId'>>,
): MapTile {
  return {
    id,
    name,
    terrain,
    water: extra.water ?? null,
    impassable: extra.impassable ?? false,
    countryId: extra.countryId ?? null,
    midTierId: extra.midTierId ?? null,
    centroid,
    areaPx: 100,
  };
}

/** 深拷贝夹具（每个用例从干净的一份出发，改一格不影响别人） */
function fixture(): MapPack {
  return JSON.parse(JSON.stringify(FIXTURE)) as MapPack;
}

// ═══════════════════════════════════════════════════════════
// 独立重算（照设计 §6.2 重写，不碰实现内部）
// ═══════════════════════════════════════════════════════════

interface ExpectedGraph {
  nodes: Map<number, MapTile>;
  edges: Map<number, Set<number>>;
}

function expectedGraph(pack: MapPack): ExpectedGraph {
  const nodes = new Map<number, MapTile>();
  for (const row of pack.tiles) {
    if (row.impassable || row.water === 'lake') continue;
    if (!nodes.has(row.id)) nodes.set(row.id, row);
  }
  const edges = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return;
    if (!edges.has(a)) edges.set(a, new Set<number>());
    if (!edges.has(b)) edges.set(b, new Set<number>());
    edges.get(a)?.add(b);
    edges.get(b)?.add(a);
  };
  for (const [a, b] of pack.adjacency) link(a, b);
  for (const [a, b] of pack.straits) link(a, b);
  return { nodes, edges };
}

/** 近海 = 通行图里挨着至少一块陆地 */
function expectedIsFarSea(graph: ExpectedGraph, id: number): boolean {
  for (const other of graph.edges.get(id) ?? []) {
    if (graph.nodes.get(other)?.water === null) return false;
  }
  return true;
}

function expectedEdgeTime(
  pack: MapPack,
  graph: ExpectedGraph,
  fromId: number,
  toId: number,
): number {
  const from = graph.nodes.get(fromId) as MapTile;
  const to = graph.nodes.get(toId) as MapTile;
  const distKm =
    Math.hypot(to.centroid[0] - from.centroid[0], to.centroid[1] - from.centroid[1]) * pack.kmPerPx;
  const rates = pack.travelRules.rates;

  let time: number;
  if (to.water === 'sea') {
    time = distKm / (expectedIsFarSea(graph, toId) ? rates.farSea : rates.nearSea);
  } else {
    time = (distKm * (pack.travelRules.terrainFactor[to.terrain] ?? 1)) / rates.land;
  }
  if ((from.water === 'sea') !== (to.water === 'sea')) {
    time += pack.travelRules.embarkCost / rates.land;
  }
  return time;
}

/** 全程时间加完再取**一次** ceil；含边的路径至少 1 天，原地不动 0 天 */
function expectedRouteDays(pack: MapPack, tilePath: number[]): number {
  if (tilePath.length <= 1) return 0;
  const graph = expectedGraph(pack);
  let total = 0;
  for (let i = 0; i + 1 < tilePath.length; i++) {
    total += expectedEdgeTime(pack, graph, tilePath[i], tilePath[i + 1]);
  }
  return Math.max(1, Math.ceil(total));
}

function hasEdge(pack: MapPack, a: number, b: number): boolean {
  const pairs: [number, number][] = [
    ...pack.adjacency.map(([x, y]): [number, number] => [x, y]),
    ...pack.straits,
  ];
  return pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

// ═══════════════════════════════════════════════════════════
// 夹具自证
// ═══════════════════════════════════════════════════════════

describe('夹具自证', () => {
  it('是一份能从 coerceMapPack 出来的合法包（否则测的是永不存在的形状）', () => {
    expect(coerceMapPack(fixture())).toEqual(FIXTURE);
  });
});

// ═══════════════════════════════════════════════════════════
// 最短路正确性
// ═══════════════════════════════════════════════════════════

describe('findPath —— 已知小图上的最短路', () => {
  it('按代价选路而不是按跳数：绕平原的长路胜过穿森林的短路', () => {
    // [1,4,3] = 2×116.62km 平原 → 23.33 天；[1,2,3] = 森林 100km×2 + 平原 100km → 30 天
    const route = findPath(fixture(), 1, 3);
    expect(route).not.toBeNull();
    expect(route?.tilePath).toEqual([1, 4, 3]);
    expect(route?.days).toBe(24);
    expect(route?.days).toBe(expectedRouteDays(FIXTURE, [1, 4, 3]));
  });

  it('系数取**终点**地形 —— 所以代价刻意不对称（走进森林贵、走出森林便宜）', () => {
    // 这条不是 bug：设计 §6.2 的 edgeFactor(边类型, terrain_b)。谁哪天「顺手把它改成对称」，
    // 沼泽/山地的进入代价会整片消失，而路线看着还挺合理。
    expect(findPath(fixture(), 1, 2)?.days).toBe(20);
    expect(findPath(fixture(), 2, 1)?.days).toBe(10);
  });

  it('未知地形按 1.0 计，且这不是「按 0 计」也不是崩', () => {
    const base = fixture(); // tundra 不在 terrainFactor 里
    expect(findPath(base, 10, 11)?.days).toBe(20); // 200km × 1.0 / 10

    const configured = fixture();
    configured.travelRules.terrainFactor.tundra = 2;
    expect(findPath(configured, 10, 11)?.days).toBe(40);
  });

  it('起点 = 终点 → 单块路径、0 天（不是 1 天，也不是 null）', () => {
    expect(findPath(fixture(), 1, 1)).toEqual({
      tilePath: [1],
      days: 0,
      timeDays: 0,
      crossings: ['North Vale'],
    });
  });

  it('形心极近的两块地也至少 1 天（含边的路径不许出现 0 天）', () => {
    const pack = fixture();
    pack.tiles[1].centroid = [0, 0]; // Bravo 挪到与 Alpha 同一点
    const route = findPath(pack, 1, 2);
    expect(route?.tilePath).toEqual([1, 2]);
    expect(route?.days).toBe(1);
  });

  it('timeDays 是取整前的总时间：days = max(1, ceil(timeDays))，与逐边口径一致', () => {
    const pack = fixture();
    const route = findPath(pack, 1, 3);
    expect(route).not.toBeNull();
    expect(route!.timeDays).toBeGreaterThan(0);
    expect(route!.days).toBe(Math.max(1, Math.ceil(route!.timeDays)));
    const graph = expectedGraph(pack);
    let total = 0;
    for (let i = 0; i + 1 < route!.tilePath.length; i++) {
      total += expectedEdgeTime(pack, graph, route!.tilePath[i], route!.tilePath[i + 1]);
    }
    expect(route!.timeDays).toBeCloseTo(total, 10);
  });
});

// ═══════════════════════════════════════════════════════════
// 通行性
// ═══════════════════════════════════════════════════════════

describe('findPath —— 通行性（这三条是夹具里最便宜的路，漏剔就会被选中）', () => {
  it('永不穿 impassable 块', () => {
    const route = findPath(fixture(), 1, 3);
    expect(route?.tilePath).not.toContain(8);
  });

  it('永不穿 lake 块', () => {
    const route = findPath(fixture(), 1, 3);
    expect(route?.tilePath).not.toContain(7);
  });

  it('反证：把那两块放开（改成可通行的陆地）后它们真的会被选中 —— 夹具不是空转的', () => {
    const pack = fixture();
    pack.tiles[7].impassable = false; // Hotel
    expect(findPath(pack, 1, 3)?.tilePath).toEqual([1, 8, 3]);

    const lakeOpened = fixture();
    lakeOpened.tiles[6].water = null; // Golf 变陆地
    expect(findPath(lakeOpened, 1, 3)?.tilePath).toEqual([1, 7, 3]);
  });

  it('端点本身是 impassable / lake → null（不是「碰巧连通」蒙一条路线出来）', () => {
    expect(findPath(fixture(), 1, 8)).toBeNull();
    expect(findPath(fixture(), 8, 3)).toBeNull();
    expect(findPath(fixture(), 1, 7)).toBeNull();
    expect(findPath(fixture(), 7, 3)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 混合水陆
// ═══════════════════════════════════════════════════════════

describe('findPath —— 混合通行图（陆海一张图，按边类型计价）', () => {
  it('海路走得通，且只在有邻接的岸线登/离船', () => {
    const route = findPath(fixture(), 1, 10);
    expect(route?.tilePath).toEqual([1, 2, 5, 6, 9, 10]);
    // 20（陆·森林）+ 5.4（登船）+ 5（远洋）+ 10（近海）+ 10.4（离船）= 50.8
    expect(route?.days).toBe(51);
    expect(route?.days).toBe(expectedRouteDays(FIXTURE, [1, 2, 5, 6, 9, 10]));

    // 每一步都必须是包里真的有的边（水段两端必是海岸邻接，§10）
    const path = route?.tilePath ?? [];
    for (let i = 0; i + 1 < path.length; i++) {
      expect(hasEdge(FIXTURE, path[i], path[i + 1])).toBe(true);
    }
  });

  it('远洋段真的按 farSea 计价（把 farSea 压到近海档，天数变多）', () => {
    const slowed = fixture();
    slowed.travelRules.rates.farSea = slowed.travelRules.rates.nearSea;
    expect(findPath(slowed, 1, 10)?.days).toBe(56); // 远洋那 200km 从 5 天变 10 天
  });

  it('登/离船代价只加在跨界那条边上（两次登离 = 两笔，不是每条边一笔）', () => {
    const free = fixture();
    free.travelRules.embarkCost = 0;
    // 51 - ceil 前的 0.8 天 → 50
    expect(findPath(free, 1, 10)?.days).toBe(50);
  });

  it('海峡补边可用；没有它那块孤岛就不可达', () => {
    expect(findPath(fixture(), 10, 11)?.tilePath).toEqual([10, 11]);

    const noStraits = fixture();
    noStraits.straits = [];
    expect(findPath(noStraits, 10, 11)).toBeNull();
  });

  it('不连通 → null（孤立块 Mike 一条边都没有）', () => {
    expect(findPath(fixture(), 1, 12)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 近海 / 远洋的推导（独立小包，两个变体只差一格）
// ═══════════════════════════════════════════════════════════

/**
 * 一条 `陆 — 海 — 海 — 海 — 陆` 的水道，中间那块海（id 3）旁边挂一块陆地（id 6）:
 * 它可通行时 id 3 算近海（慢档），它不可通行时 id 3 算远洋（快档）。
 * 两个变体只差 `impassable` 一格 —— 天数必须跟着变，否则「近海推导」根本没跑。
 */
function waterwayPack(options: { blockSpur: boolean; spurViaStrait?: boolean }): MapPack {
  const spur = tile(6, 'Spur', [200, 200], 'plains', { impassable: options.blockSpur });
  const adjacency: MapAdjacencyEdge[] = [
    [1, 2, 10],
    [2, 3, 10],
    [3, 4, 10],
    [4, 5, 10],
  ];
  return {
    version: '1.0.0',
    contentHash: 'waterway',
    resolution: { w: 400, h: 400 },
    kmPerPx: 1,
    terrains: ['plains', 'ocean'],
    travelRules: {
      rates: { land: 10, nearSea: 20, farSea: 40 },
      embarkCost: 0,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [
      tile(1, 'Port', [0, 0], 'plains', {}),
      tile(2, 'W1', [0, 100], 'ocean', { water: 'sea' }),
      tile(3, 'W2', [0, 200], 'ocean', { water: 'sea' }),
      tile(4, 'W3', [0, 300], 'ocean', { water: 'sea' }),
      tile(5, 'Harbor', [0, 400], 'plains', {}),
      spur,
    ],
    adjacency: options.spurViaStrait ? adjacency : [...adjacency, [3, 6, 10]],
    straits: options.spurViaStrait ? [[3, 6]] : [],
    placeBindings: {},
  };
}

describe('近海 / 远洋 —— 推导自通行图，不读包字段、不看地形串', () => {
  it('岸边有可通行陆地 = 近海（慢档）', () => {
    const pack = waterwayPack({ blockSpur: false });
    // 5 + 5 + 5 + 10 = 25
    expect(findPath(pack, 1, 5)?.days).toBe(25);
  });

  it('岸边只有 impassable 陆地 = 远洋（那条岸线没人上得去，不算岸）', () => {
    const pack = waterwayPack({ blockSpur: true });
    // 中间那段从 5 天（近海）变 2.5 天（远洋）→ 22.5
    expect(findPath(pack, 1, 5)?.days).toBe(23);
  });

  it('只经海峡连着的岸也算岸（否则「能从这里上船，价钱按公海算」）', () => {
    const pack = waterwayPack({ blockSpur: false, spurViaStrait: true });
    expect(findPath(pack, 1, 5)?.days).toBe(25);
  });

  it('🔴 分档与本次查询的 avoid 无关 —— 回避掉那块岸地，海路价钱一分不变', () => {
    // 若实现先按 avoid 剔点、再分档，这里会算成远洋（23 天）：同一段海路在两次查询里
    // 两个价格，而两次的路线一模一样 —— 没有任何路径断言会红。
    const pack = waterwayPack({ blockSpur: false });
    expect(findPath(pack, 1, 5, { avoid: [6] })?.days).toBe(25);
  });
});

// ═══════════════════════════════════════════════════════════
// via / avoid
// ═══════════════════════════════════════════════════════════

describe('findPath —— via（途经点逐段串联，顺序有意义）', () => {
  it('途经点被真的经过，且路线因此变贵', () => {
    const detour = findPath(fixture(), 1, 3, { via: [2] });
    expect(detour?.tilePath).toEqual([1, 2, 3]);
    expect(detour?.days).toBe(30);
    expect(detour?.days).toBeGreaterThan(findPath(fixture(), 1, 3)?.days ?? 0);
  });

  it('接点不重复（上一段的终点不会在路径里出现两次）', () => {
    const route = findPath(fixture(), 1, 10, { via: [3] });
    const counts = new Map<number, number>();
    for (const id of route?.tilePath ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it('顺序保持：[2,4] 与 [4,2] 给出不同的经过次序', () => {
    const forward = findPath(fixture(), 1, 3, { via: [2, 4] })?.tilePath ?? [];
    const backward = findPath(fixture(), 1, 3, { via: [4, 2] })?.tilePath ?? [];
    expect(forward.indexOf(2)).toBeLessThan(forward.indexOf(4));
    expect(backward.indexOf(4)).toBeLessThan(backward.indexOf(2));
  });

  it('天数是全程加完取一次 ceil，不是逐段各取一次', () => {
    // 逐段 ceil 的实现会给出 ≥ 正确值的答案，且看着同样合理 —— 只能用独立重算钉
    const route = findPath(fixture(), 1, 10, { via: [2, 5] });
    expect(route).not.toBeNull();
    expect(route?.days).toBe(expectedRouteDays(FIXTURE, route?.tilePath ?? []));
  });

  it('途经点不可用（湖 / 不存在 / 不连通 / 被 avoid）→ 整个查询 null', () => {
    expect(findPath(fixture(), 1, 3, { via: [7] })).toBeNull();
    expect(findPath(fixture(), 1, 3, { via: [999] })).toBeNull();
    expect(findPath(fixture(), 1, 3, { via: [12] })).toBeNull();
    expect(findPath(fixture(), 1, 3, { via: [2], avoid: [2] })).toBeNull();
  });
});

describe('findPath —— avoid（当成不在图里）', () => {
  it('回避正解上的那块地 → 换成次优解', () => {
    const route = findPath(fixture(), 1, 3, { avoid: [4] });
    expect(route?.tilePath).toEqual([1, 2, 3]);
    expect(route?.days).toBe(30);
  });

  it('回避掉全部通路 → null（不是退回被回避的那条）', () => {
    expect(findPath(fixture(), 1, 3, { avoid: [2, 4] })).toBeNull();
  });

  it('回避端点本身 → null', () => {
    expect(findPath(fixture(), 1, 3, { avoid: [1] })).toBeNull();
    expect(findPath(fixture(), 1, 3, { avoid: [3] })).toBeNull();
  });

  it('回避不在路线上的地块 → 答案一字不变', () => {
    const base = findPath(fixture(), 1, 10);
    expect(findPath(fixture(), 1, 10, { avoid: [11, 12] })).toEqual(base);
  });
});

// ═══════════════════════════════════════════════════════════
// 端点与空包
// ═══════════════════════════════════════════════════════════

describe('findPath —— 端点校验与空包', () => {
  it('端点不在包里 → null', () => {
    expect(findPath(fixture(), 1, 999)).toBeNull();
    expect(findPath(fixture(), 999, 1)).toBeNull();
  });

  it('空包 → null（0 地块时端点校验就命中，不必特判 isEmptyMapPack）', () => {
    expect(findPath(EMPTY_MAP_PACK, 1, 2)).toBeNull();
    expect(findPath(EMPTY_MAP_PACK, 1, 1)).toBeNull();
    expect(findPath(coerceMapPack(null), 1, 2)).toBeNull();
  });

  it('不改动入参（纯函数：调用方的包与选项原样不动）', () => {
    const pack = fixture();
    const opts: FindPathOptions = { via: [2], avoid: [4] };
    findPath(pack, 1, 3, opts);
    expect(pack).toEqual(FIXTURE);
    expect(opts).toEqual({ via: [2], avoid: [4] });
  });
});

// ═══════════════════════════════════════════════════════════
// crossings
// ═══════════════════════════════════════════════════════════

describe('findPath —— crossings（名字，不是 id）', () => {
  it('优先级 中层 → 国家 → 地块名，且按首次出现去重', () => {
    // [1,4,3]: north-a → 无主之地报块名 → south-a
    expect(findPath(fixture(), 1, 3)?.crossings).toEqual(['North Vale', 'Delta', 'South Reach']);
    // [10,11]: south-a → Lima 没有中层，落到国家名
    expect(findPath(fixture(), 10, 11)?.crossings).toEqual(['South Reach', 'Southmark']);
  });

  it('水段由海的中层报名（真实包里海也有中层）', () => {
    // [1,2,5,6,9,10]：Alpha 与 Bravo 同中层 → 去重成一条
    expect(findPath(fixture(), 1, 10)?.crossings).toEqual([
      'North Vale',
      'Pale Sea',
      'South Reach',
    ]);
  });

  it('海没有中层时报地块自己的名字（不发明兜底文案）', () => {
    const pack = fixture();
    for (const row of pack.tiles) if (row.water === 'sea') row.midTierId = null;
    expect(findPath(pack, 1, 10)?.crossings).toEqual([
      'North Vale',
      'Echo',
      'Foxtrot',
      'India',
      'South Reach',
    ]);
  });

  it('绝不含 tileId（§8.3：那个数字换图就变，AI 与 UI 都不该看见）', () => {
    const crossings = findPath(fixture(), 1, 10)?.crossings ?? [];
    expect(crossings.length).toBeGreaterThan(0);
    for (const name of crossings) expect(/^\d+$/.test(name)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 决定性
// ═══════════════════════════════════════════════════════════

/** 两条同代价路线的小图：`1 → 4` 走 2 还是走 3，几何上完全对称 */
function tiePack(reverseEdgeOrder: boolean): MapPack {
  const adjacency: MapAdjacencyEdge[] = [
    [1, 2, 10],
    [2, 4, 10],
    [1, 3, 10],
    [3, 4, 10],
  ];
  return {
    version: '1.0.0',
    contentHash: 'tie',
    resolution: { w: 300, h: 300 },
    kmPerPx: 1,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 10, nearSea: 20, farSea: 40 },
      embarkCost: 0,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [
      tile(1, 'A', [0, 0], 'plains', {}),
      tile(2, 'B', [100, 100], 'plains', {}),
      tile(3, 'C', [100, -100], 'plains', {}),
      tile(4, 'D', [200, 0], 'plains', {}),
    ],
    adjacency: reverseEdgeOrder ? [...adjacency].reverse() : adjacency,
    straits: [],
    placeBindings: {},
  };
}

/**
 * 专门逼出「取最小时的 id 平局判据」的小图 —— 上面那个对称夹具**逼不出来**（变异测试实测：
 * 把判据整条删掉，`tiePack` 照样绿），因为那里 id 小的那个恰好也是先进入 dist 的那个。
 *
 * 这里让**后进入** dist 的那个 id 更小:
 *   1(0,0) —— 9(200,0)  直连，20 天
 *   1 —— 3(0,100) —— 2(0,200)  两跳也是 20 天（3 先settle，2 才进 dist）
 *   2 与 9 到终点 4(200,200) 的距离刻意相等（都在中垂线上），故 `dist[4]` 两条都是 40
 * 于是选谁先 settle 就决定了 `prev[4]`:
 *   · 按 id 升序 → 先 2 → 路线 [1,3,2,4]
 *   · 按「dist 里先来先到」 → 先 9 → 路线 [1,9,4]
 * 两条**天数完全相同**（40），所以只有路径断言逮得住。
 */
function tieBreakPack(reverseEdgeOrder: boolean): MapPack {
  // 边刻意写成「9 在 3 前面」：这样即便邻接表没排序，1 的邻居也是 [9, 3]
  const adjacency: MapAdjacencyEdge[] = [
    [1, 9, 10],
    [1, 3, 10],
    [3, 2, 10],
    [2, 4, 10],
    [9, 4, 10],
  ];
  return {
    version: '1.0.0',
    contentHash: 'tie-break',
    resolution: { w: 300, h: 300 },
    kmPerPx: 1,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 10, nearSea: 20, farSea: 40 },
      embarkCost: 0,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [
      tile(1, 'Start', [0, 0], 'plains', {}),
      tile(2, 'Hub', [0, 200], 'plains', {}),
      tile(3, 'Mid', [0, 100], 'plains', {}),
      tile(4, 'Goal', [200, 200], 'plains', {}),
      tile(9, 'Alt', [200, 0], 'plains', {}),
    ],
    adjacency: reverseEdgeOrder ? [...adjacency].reverse() : adjacency,
    straits: [],
    placeBindings: {},
  };
}

describe('findPath —— 决定性', () => {
  it('同输入两次调用逐字段相同', () => {
    const first = findPath(fixture(), 1, 10, { via: [2], avoid: [12] });
    const second = findPath(fixture(), 1, 10, { via: [2], avoid: [12] });
    expect(second).toEqual(first);
  });

  it('同代价两条路线：不随 pack 里边的书写顺序变脸', () => {
    // 重排 adjacency 的行不该换路线，而两条路线天数完全相同 —— 没有任何天数断言会红。
    expect(findPath(tiePack(false), 1, 4)?.tilePath).toEqual([1, 2, 4]);
    expect(findPath(tiePack(true), 1, 4)?.tilePath).toEqual([1, 2, 4]);
  });

  it('🔴 平局取 id 小者，而不是「dist 里先来先到」', () => {
    for (const reversed of [false, true]) {
      const route = findPath(tieBreakPack(reversed), 1, 4);
      expect(route?.days).toBe(40); // 两条候选都是 40 天 —— 天数区分不了它们
      expect(route?.tilePath).toEqual([1, 3, 2, 4]);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 性质测试（随机网格，先例 image-quota.property.test.ts）
// ═══════════════════════════════════════════════════════════

type GridKind = 'plains' | 'forest' | 'sea' | 'lake' | 'block';

const GRID = 4;
const GRID_CELLS = GRID * GRID;

/**
 * 4×4 网格包：每格随机是平原/森林/海/湖/不可通行，边 = 上下左右四邻。
 *
 * `ridge`（不可通行块的地形）与 `still-water`（湖）的系数刻意配得**极便宜** —— 若实现漏剔
 * 它们，随机图里马上会有一堆路线穿过去，而不是靠运气逃过断言。
 */
function gridPack(kinds: GridKind[]): MapPack {
  const tiles: MapTile[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const index = row * GRID + col;
      const kind = kinds[index] ?? 'plains';
      const terrain =
        kind === 'sea'
          ? 'ocean'
          : kind === 'lake'
            ? 'still-water'
            : kind === 'block'
              ? 'ridge'
              : kind;
      tiles.push(
        tile(index + 1, `G${index + 1}`, [col * 100, row * 100], terrain, {
          water: kind === 'sea' ? 'sea' : kind === 'lake' ? 'lake' : null,
          impassable: kind === 'block',
        }),
      );
    }
  }

  const adjacency: MapAdjacencyEdge[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const id = row * GRID + col + 1;
      if (col + 1 < GRID) adjacency.push([id, id + 1, 10]);
      if (row + 1 < GRID) adjacency.push([id, id + GRID, 10]);
    }
  }

  return {
    version: '1.0.0',
    contentHash: 'grid',
    resolution: { w: GRID * 100, h: GRID * 100 },
    kmPerPx: 1.5,
    terrains: ['plains', 'forest', 'ocean', 'still-water', 'ridge'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 120 },
      embarkCost: 12,
      terrainFactor: { plains: 1, forest: 2.5, 'still-water': 0.05, ridge: 0.05 },
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles,
    adjacency,
    straits: [],
    placeBindings: {},
  };
}

const kindArb = fc.constantFrom<GridKind>('plains', 'forest', 'sea', 'lake', 'block');
const idArb = fc.integer({ min: 1, max: GRID_CELLS });

const queryArb = fc.record({
  kinds: fc.array(kindArb, { minLength: GRID_CELLS, maxLength: GRID_CELLS }),
  from: idArb,
  to: idArb,
  via: fc.array(idArb, { maxLength: 2 }),
  avoid: fc.array(idArb, { maxLength: 3 }),
});

describe('findPath 不变式（随机 4×4 网格）', () => {
  it('路径永不含 impassable / lake / 不存在的地块', () => {
    fc.assert(
      fc.property(queryArb, ({ kinds, from, to, via, avoid }) => {
        const pack = gridPack(kinds);
        const route = findPath(pack, from, to, { via, avoid });
        if (route === null) return;
        const byId = new Map(pack.tiles.map((row) => [row.id, row]));
        for (const id of route.tilePath) {
          const node = byId.get(id);
          expect(node).toBeDefined();
          expect(node?.impassable).toBe(false);
          expect(node?.water).not.toBe('lake');
        }
      }),
    );
  });

  it('每一步都是包里真的有的边，且首尾就是请求的端点', () => {
    fc.assert(
      fc.property(queryArb, ({ kinds, from, to, via, avoid }) => {
        const pack = gridPack(kinds);
        const route = findPath(pack, from, to, { via, avoid });
        if (route === null) return;
        expect(route.tilePath[0]).toBe(from);
        expect(route.tilePath[route.tilePath.length - 1]).toBe(to);
        for (let i = 0; i + 1 < route.tilePath.length; i++) {
          expect(hasEdge(pack, route.tilePath[i], route.tilePath[i + 1])).toBe(true);
        }
      }),
    );
  });

  it('avoid 里的地块永不出现在路径里；途经点按顺序出现', () => {
    fc.assert(
      fc.property(queryArb, ({ kinds, from, to, via, avoid }) => {
        const pack = gridPack(kinds);
        const route = findPath(pack, from, to, { via, avoid });
        if (route === null) return;
        for (const id of avoid) expect(route.tilePath).not.toContain(id);

        let cursor = 0;
        for (const waypoint of [from, ...via, to]) {
          const at = route.tilePath.indexOf(waypoint, cursor);
          expect(at).toBeGreaterThanOrEqual(cursor);
          cursor = at;
        }
      }),
    );
  });

  it('天数 = 全程时间加完取一次 ceil（含边至少 1 天，原地 0 天），永远是整数', () => {
    fc.assert(
      fc.property(queryArb, ({ kinds, from, to, via, avoid }) => {
        const pack = gridPack(kinds);
        const route = findPath(pack, from, to, { via, avoid });
        if (route === null) return;
        expect(Number.isInteger(route.days)).toBe(true);
        expect(route.days).toBe(expectedRouteDays(pack, route.tilePath));
        if (route.tilePath.length > 1) expect(route.days).toBeGreaterThanOrEqual(1);
        else expect(route.days).toBe(0);
      }),
    );
  });

  it('同输入必定同输出（决定性）', () => {
    fc.assert(
      fc.property(queryArb, ({ kinds, from, to, via, avoid }) => {
        const first = findPath(gridPack(kinds), from, to, { via, avoid });
        const second = findPath(gridPack(kinds), from, to, { via, avoid });
        expect(second).toEqual(first);
      }),
    );
  });

  it('多回避一块地只会更贵或走不通，绝不会变便宜（最优性的可测那一半）', () => {
    fc.assert(
      fc.property(queryArb, idArb, ({ kinds, from, to, avoid }, extra) => {
        const pack = gridPack(kinds);
        const base = findPath(pack, from, to, { avoid });
        if (base === null) return;
        const stricter = findPath(pack, from, to, { avoid: [...avoid, extra] });
        if (stricter === null) return;
        expect(stricter.days).toBeGreaterThanOrEqual(base.days);
        // 回避的那块不在原路线上时，答案必须一字不变
        if (!base.tilePath.includes(extra)) expect(stricter).toEqual(base);
      }),
    );
  });
});
