/**
 * map-index.test.ts — 运行时索引与落位契约的守卫测试（地图系统 v1 / 设计 §8.2·§10）
 *
 * 钉的都是「改坏了不报错，只会让棋子静默出现在别的地方」那一类:
 * - **落位契约五条**（§8.2）逐条三态：钉位段 / 只圈域 / 全落空
 * - **深度是主键**：路径里同时有中层段与更深的地块段时地块赢，那个中层段属于别的域时也一样
 * - **两档匹配、没有第三档**：原文 → 归一化 → 放弃。子串/超串/大小写差异一律**不**命中 ——
 *   认不出的代价是保持 `lastTileId` 不动（安全），认成别的块的代价是队伍无声地挪窝
 * - **屏幕坐标 y 向下**：北 = 负 Δy。写反了不报错，只是每条邻接行的南北都是错的
 * - **邻接表含不可通行块与湖**：`MAP_CONTEXT` 要照标它们；在索引层就剔掉等于让 AI 看不见
 *   挡在西边的那道山脊（剔除是寻路图的事）
 * - **tileId 0 是真实存在的 id**：查表一律与 `undefined` 比较，`if (hit)` 会让 0 号块永远
 *   落不了位
 * - **空包是合同不是异常**：0 地块的包落位永远 `null`
 *
 * 🔴 **夹具零真实地名**（承 D25①，先例 `map-pack.test.ts`）。12 块地叫 Alpha…Lima，地形叫
 *    plains/ridge，国家叫 Northland —— 词汇是**包定义**的，引擎一个字都不认识。用中性词做
 *    夹具本身就是在证明这件事（设计 §3.4-1「换图零改码」）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildMapIndex,
  compassOf,
  countryOfTile,
  findDomainByName,
  findTileByName,
  isTileInDomain,
  midTierOfTile,
  normalizeMapName,
  resolveDomainAnchor,
  resolveTileByLocation,
  splitLocationSegments,
  type MapCompass,
  type MapDomainKind,
  type MapDomainRef,
  type MapIndex,
  type MapNameLookup,
  type MapNeighborLink,
} from './map-index';
import { EMPTY_MAP_PACK } from './map-pack';
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

/**
 * 12 块地 / 4 国 / 5 中层。刻意布下的六处「陷阱地形」:
 *   · 8 Hotel  —— 不可通行，且面积比同域任何块都大 → 最大块兜底必须跳过它
 *   · 11 Kilo  —— 湖，面积更大 → 同上
 *   · 10 Juliett —— north-b 里最大的**可落脚**块 → 无锚中层的兜底答案
 *   · 12 Lima  —— `countryId` 为 null 但中层属 south → 国家链的补链那一环
 *   · 0 Zulu   —— **id 为 0**（§3.1 的保留 id）：真值判断会让它永远落不了位
 *   · Twin     —— 一个中层名与一个国家名同串 → 「取更具体的层」
 */
const FIXTURE: MapPack = {
  version: '1.0.0',
  contentHash: 'fixture',
  resolution: { w: 400, h: 300 },
  kmPerPx: 2,
  terrains: ['plains', 'forest', 'hills', 'ridge', 'ocean', 'still-water'],
  travelRules: {
    rates: { land: 30, nearSea: 60, farSea: 120 },
    embarkCost: 12,
    terrainFactor: { plains: 1, forest: 1.4 },
    modes: [],
  },
  countries: [
    { id: 'north', name: 'Northland', color: [10, 20, 30], anchorTileId: 1 },
    { id: 'south', name: 'Southmark', color: [200, 10, 10], anchorTileId: 3 },
    // 无主占位国：一块地都没有 + 没有锚 → 锚解析必须诚实地给 null
    { id: 'nobody', name: 'Nowhere', color: [128, 128, 128], unclaimed: true, anchorTileId: null },
    // 与 twin-tier 同名的国家：域解析必须取中层（更具体的层）
    { id: 'twin-country', name: 'Twin', color: [1, 2, 3], anchorTileId: 3 },
  ],
  midTiers: [
    { id: 'north-a', name: 'North Vale', countryId: 'north', climateId: 'cold', anchorTileId: 1 },
    // 无锚中层：兜底走「域内最大可落脚块」
    {
      id: 'north-b',
      name: 'North Ridge',
      countryId: 'north',
      climateId: 'cold',
      anchorTileId: null,
    },
    { id: 'south-a', name: 'South Reach', countryId: 'south', climateId: 'mild', anchorTileId: 3 },
    // 锚指向不存在的块 + 域内一块地都没有 → null（悬空锚闸门）
    { id: 'ghost', name: 'Ghost March', countryId: 'south', climateId: 'mild', anchorTileId: 99 },
    { id: 'twin-tier', name: 'Twin', countryId: 'north', climateId: 'cold', anchorTileId: 2 },
  ],
  climates: {
    cold: { name: 'Cold Zone', table: { winter: [['snow', 4]] } },
    mild: { name: 'Mild Zone', table: { spring: [['clear', 5]] } },
  },
  tiles: [
    tile(0, 'Zulu', { countryId: 'north', midTierId: 'north-a', centroid: [4, 6], areaPx: 120 }),
    tile(1, 'Alpha', { countryId: 'north', midTierId: 'north-a', centroid: [10, 10], areaPx: 900 }),
    tile(2, 'Bravo', {
      terrain: 'forest',
      countryId: 'north',
      midTierId: 'north-a',
      centroid: [30, 12],
      areaPx: 750,
    }),
    tile(3, 'Charlie', {
      terrain: 'hills',
      countryId: 'south',
      midTierId: 'south-a',
      centroid: [60, 40],
      areaPx: 640,
    }),
    tile(4, 'Delta', { centroid: [8, 40], areaPx: 500 }),
    tile(5, 'Echo', { terrain: 'ocean', water: 'sea', centroid: [45, 15], areaPx: 1200 }),
    tile(6, 'Foxtrot', { terrain: 'ocean', water: 'sea', centroid: [70, 18], areaPx: 1500 }),
    tile(7, 'Golf', { terrain: 'still-water', water: 'lake', centroid: [12, 55], areaPx: 200 }),
    tile(8, 'Hotel', {
      terrain: 'ridge',
      impassable: true,
      countryId: 'north',
      midTierId: 'north-b',
      centroid: [32, 30],
      areaPx: 5000,
    }),
    tile(9, 'India', { countryId: 'north', midTierId: 'north-b', centroid: [36, 34], areaPx: 400 }),
    tile(10, 'Juliett', {
      countryId: 'north',
      midTierId: 'north-b',
      centroid: [40, 38],
      areaPx: 1000,
    }),
    tile(11, 'Kilo', {
      terrain: 'still-water',
      water: 'lake',
      countryId: 'north',
      midTierId: 'north-b',
      centroid: [44, 42],
      areaPx: 9000,
    }),
    tile(12, 'Lima', { countryId: null, midTierId: 'south-a', centroid: [66, 46], areaPx: 300 }),
  ],
  adjacency: [
    [1, 2, 100],
    [2, 3, 80],
    [1, 4, 50],
    [2, 5, 60],
    [5, 6, 200],
    [2, 8, 10],
    [9, 10, 30],
    [0, 1, 15],
  ],
  straits: [[5, 3]],
  placeBindings: {
    'Alpha Town': 1,
    'Bravo Keep': 2,
    'Charlie Hold': 3,
    // 撞地块名的绑定（指向别的块）：地块名必须赢
    Bravo: 3,
    // 悬空绑定：必须整条丢掉
    'Ghost Port': 99,
  },
};

function fixture(): MapPack {
  return JSON.parse(JSON.stringify(FIXTURE)) as MapPack;
}

function index(): MapIndex {
  return buildMapIndex(fixture());
}

/** 邻接表 → `[tileId, sharedEdgePx]` 对，便于断言 */
function neighborsOf(idx: MapIndex, tileId: number): [number, number][] {
  const links: readonly MapNeighborLink[] = idx.neighbors.get(tileId) ?? [];
  return links.map((link) => [link.tileId, link.sharedEdgePx]);
}

/** 域引用（`kind` 走 `MapDomainKind`，两层的名字空间是分开的） */
function domainRef(kind: MapDomainKind, id: string): MapDomainRef {
  return { kind, id };
}

// ═══════════════════════════════════════════════════════════
// buildMapIndex —— 索引形状
// ═══════════════════════════════════════════════════════════

describe('buildMapIndex —— 地块表与链', () => {
  it('每块地都查得到，未知 id 给 undefined', () => {
    const idx = index();
    expect(idx.tileById.size).toBe(13);
    expect(idx.tileById.get(3)?.name).toBe('Charlie');
    expect(idx.tileById.get(99)).toBeUndefined();
  });

  it('持有的是同一份包引用（不深拷贝 —— 对抗 mutation 的手段是重建）', () => {
    const pack = fixture();
    expect(buildMapIndex(pack).pack).toBe(pack);
  });

  it('链：地块 → 中层 → 国家', () => {
    const idx = index();
    expect(midTierOfTile(idx, 1)?.name).toBe('North Vale');
    expect(countryOfTile(idx, 1)?.name).toBe('Northland');
  });

  it('地块自有 countryId 优先于中层的国家（飞地/自治领不该被省吞掉）', () => {
    const pack = fixture();
    // 3 Charlie 在 south-a（属 south），但它自己声明属 north
    pack.tiles = pack.tiles.map((row) =>
      row.id === 3 ? tile(3, 'Charlie', { countryId: 'north', midTierId: 'south-a' }) : row,
    );
    const idx = buildMapIndex(pack);
    expect(idx.midTierIdByTileId.get(3)).toBe('south-a');
    expect(idx.countryIdByTileId.get(3)).toBe('north');
  });

  it('countryId 为 null 时经中层补链（12 Lima）', () => {
    const idx = index();
    expect(idx.tileById.get(12)?.countryId).toBeNull();
    expect(countryOfTile(idx, 12)?.id).toBe('south');
  });

  it('无主之地（国家与中层都没有）不进链，且不崩', () => {
    const idx = index();
    expect(idx.midTierIdByTileId.has(4)).toBe(false);
    expect(idx.countryIdByTileId.has(4)).toBe(false);
    expect(midTierOfTile(idx, 4)).toBeNull();
    expect(countryOfTile(idx, 4)).toBeNull();
  });

  it('悬空外键：链留原文 id，解析成行时给 null（不显示所有者，而不是崩）', () => {
    const pack = fixture();
    pack.tiles = pack.tiles.map((row) =>
      row.id === 0 ? tile(0, 'Zulu', { countryId: 'atlantis', midTierId: 'nowhere-tier' }) : row,
    );
    const idx = buildMapIndex(pack);
    expect(idx.countryIdByTileId.get(0)).toBe('atlantis');
    expect(countryOfTile(idx, 0)).toBeNull();
    // 悬空中层根本不入链（指向空气的一环没有用处）
    expect(idx.midTierIdByTileId.has(0)).toBe(false);
    expect(midTierOfTile(idx, 0)).toBeNull();
  });

  it('中层/国家按 id 与按名字都查得到', () => {
    const idx = index();
    expect(idx.midTierById.get('south-a')?.name).toBe('South Reach');
    expect(idx.countryById.get('south')?.name).toBe('Southmark');
    expect(findDomainByName(idx, 'South Reach')).toEqual(domainRef('midTier', 'south-a'));
    expect(findDomainByName(idx, 'Southmark')).toEqual(domainRef('country', 'south'));
    expect(findDomainByName(idx, 'Atlantis')).toBeNull();
  });

  it('中层名与国家名同串时取更具体的层（§8.2-4）', () => {
    expect(findDomainByName(index(), 'Twin')).toEqual(domainRef('midTier', 'twin-tier'));
  });

  it('空包：形状完整、全表为空（合同不是异常）', () => {
    const idx = buildMapIndex(EMPTY_MAP_PACK);
    expect(idx.tileById.size).toBe(0);
    expect(idx.neighbors.size).toBe(0);
    expect(idx.tileIdByName.exact.size).toBe(0);
    expect(idx.tileIdByName.normalized.size).toBe(0);
  });
});

describe('buildMapIndex —— 合并后的无向邻接表', () => {
  it('邻接是双向的，共享边长照抄', () => {
    const idx = index();
    expect(neighborsOf(idx, 1)).toEqual([
      [0, 15],
      [2, 100],
      [4, 50],
    ]);
    expect(neighborsOf(idx, 4)).toEqual([[1, 50]]);
  });

  it('海峡并进同一张表，共享边长记 0（像素上本来就不相邻）', () => {
    const idx = index();
    expect(neighborsOf(idx, 3)).toEqual([
      [2, 80],
      [5, 0],
    ]);
    expect(neighborsOf(idx, 5)).toEqual([
      [2, 60],
      [3, 0],
      [6, 200],
    ]);
  });

  it('不可通行块与湖**留在**邻接表里（剔除是寻路图的事，MAP_CONTEXT 要标它们）', () => {
    const idx = index();
    expect(idx.tileById.get(8)?.impassable).toBe(true);
    expect(neighborsOf(idx, 2)).toEqual([
      [1, 100],
      [3, 80],
      [5, 60],
      [8, 10],
    ]);
    expect(neighborsOf(idx, 8)).toEqual([[2, 10]]);
  });

  it('孤块给空数组，未知 id 给 undefined（两者分得开）', () => {
    const idx = index();
    expect(idx.neighbors.get(12)).toEqual([]);
    expect(idx.neighbors.get(99)).toBeUndefined();
  });

  it('自环、悬空端点、重复对一律丢；重复时共享边长以第一条为准', () => {
    const pack = fixture();
    pack.adjacency = [
      [1, 1, 50], // 自环
      [1, 99, 50], // 悬空端点
      [1, 2, 100],
      [2, 1, 7], // 反向重复：第一条说了算
    ];
    pack.straits = [[1, 2]]; // 与邻接重复：合并幂等，不改共享边长
    const idx = buildMapIndex(pack);
    expect(neighborsOf(idx, 1)).toEqual([[2, 100]]);
    expect(neighborsOf(idx, 2)).toEqual([[1, 100]]);
  });

  it('非有穷/负共享边长读作 0（NaN 权重会一路漂到代价计算里且不报错）', () => {
    const pack = fixture();
    pack.adjacency = [
      [1, 2, Number.NaN],
      [1, 4, -30],
    ];
    pack.straits = [];
    const idx = buildMapIndex(pack);
    expect(neighborsOf(idx, 1)).toEqual([
      [2, 0],
      [4, 0],
    ]);
  });

  it('列表按 tileId 升序 —— 与包里边的书写顺序无关（提示词前缀字节稳定）', () => {
    const pack = fixture();
    pack.adjacency = [...FIXTURE.adjacency].reverse();
    const shuffled = buildMapIndex(pack);
    const original = index();
    for (const tileId of original.tileById.keys()) {
      expect(neighborsOf(shuffled, tileId)).toEqual(neighborsOf(original, tileId));
    }
  });
});

describe('buildMapIndex —— 绑定名字空间', () => {
  it('地块名与绑定名都能钉位', () => {
    const idx = index();
    expect(findTileByName(idx, 'Charlie')).toBe(3);
    expect(findTileByName(idx, 'Alpha Town')).toBe(1);
    expect(findTileByName(idx, 'Charlie Hold')).toBe(3);
  });

  it('绑定表撞地块名时地块赢（一行补充数据不许静默重定向一个地块）', () => {
    // 夹具里 placeBindings['Bravo'] = 3，而 2 号块就叫 Bravo
    expect(findTileByName(index(), 'Bravo')).toBe(2);
  });

  it('悬空绑定整条丢（落位「成功」到查不到的块比落位失败更坏）', () => {
    expect(findTileByName(index(), 'Ghost Port')).toBeNull();
  });

  it('中层名与国家名不在钉位表里（它们只圈域）', () => {
    const idx = index();
    expect(findTileByName(idx, 'North Vale')).toBeNull();
    expect(findTileByName(idx, 'Northland')).toBeNull();
  });

  it('tileId 0 查得出来（真值判断会让 0 号块永远落不了位）', () => {
    expect(findTileByName(index(), 'Zulu')).toBe(0);
  });

  it('两档是两张分开的表（原文表不含归一化键，反之亦然）', () => {
    const lookup: MapNameLookup<number> = index().tileIdByName;
    expect(lookup.exact.get('Alpha Town')).toBe(1);
    expect(lookup.exact.get('AlphaTown')).toBeUndefined();
    expect(lookup.normalized.get('AlphaTown')).toBe(1);
    // 空键绝不入表（否则空段会命中某个真名字）
    expect(lookup.normalized.has('')).toBe(false);
    expect(lookup.exact.has('')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 归一化 —— 两档匹配的第二档
// ═══════════════════════════════════════════════════════════

describe('normalizeMapName —— 只做 NFKC + 去空白', () => {
  it('去掉全部空白（含首尾与内部）', () => {
    expect(normalizeMapName('  Alpha  Town  ')).toBe('AlphaTown');
  });

  it('全角/半角经 NFKC 归一', () => {
    expect(normalizeMapName('Ａlpha')).toBe('Alpha');
    expect(normalizeMapName('Alpha　Town')).toBe('AlphaTown');
  });

  it('刻意不折叠大小写（认不出是安全兜底，认成别的块不是）', () => {
    expect(normalizeMapName('ALPHA')).not.toBe(normalizeMapName('alpha'));
  });

  it('空输入给空串（空键绝不入表）', () => {
    expect(normalizeMapName('')).toBe('');
    expect(normalizeMapName('   ')).toBe('');
  });
});

describe('splitLocationSegments —— 由细到粗', () => {
  it('按正典分隔符拆段并倒序（最深段在前）', () => {
    expect(splitLocationSegments('RegionEast-Northland-Alpha Town-Docks')).toEqual([
      'Docks',
      'Alpha Town',
      'Northland',
      'RegionEast',
    ]);
  });

  it('全角连字符与斜杠一并认', () => {
    expect(splitLocationSegments('Northland／Alpha')).toEqual(['Alpha', 'Northland']);
    expect(splitLocationSegments('Northland－Alpha')).toEqual(['Alpha', 'Northland']);
  });

  it('单段输入原样返回；空段丢掉', () => {
    expect(splitLocationSegments('Alpha')).toEqual(['Alpha']);
    expect(splitLocationSegments('---')).toEqual([]);
    expect(splitLocationSegments('   ')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 罗盘
// ═══════════════════════════════════════════════════════════

describe('compassOf —— 屏幕坐标，y 向下增长', () => {
  const origin: [number, number] = [100, 100];

  it('北 = 负 Δy（写反了不报错，只是每条邻接行的南北都错）', () => {
    expect(compassOf(origin, [100, 40])).toBe('N');
    expect(compassOf(origin, [100, 160])).toBe('S');
  });

  it('八方向逐条', () => {
    const table: [target: [number, number], token: MapCompass][] = [
      [[100, 40], 'N'],
      [[160, 40], 'NE'],
      [[160, 100], 'E'],
      [[160, 160], 'SE'],
      [[100, 160], 'S'],
      [[40, 160], 'SW'],
      [[40, 100], 'W'],
      [[40, 40], 'NW'],
    ];
    for (const [target, token] of table) expect(compassOf(origin, target)).toBe(token);
  });

  it('对向互为相反（罗盘不偏心）', () => {
    const a: [number, number] = [10, 10];
    const b: [number, number] = [50, 30];
    expect(compassOf(a, b)).toBe('SE');
    expect(compassOf(b, a)).toBe('NW');
  });

  it('扇区按 22.5° 四舍五入切分（结论不随浮点末位跳变）', () => {
    // tan(22.5°) ≈ 0.4142 是 N|NE 的分界：略超一点归 NE，略欠一点归 N
    expect(compassOf([0, 0], [0.5, -1])).toBe('NE');
    expect(compassOf([0, 0], [0.3, -1])).toBe('N');
  });

  it('退化输入（零位移 / 非有穷）给确定值，绝不给出 undefined 令牌', () => {
    expect(compassOf(origin, [100, 100])).toBe('N');
    expect(compassOf(origin, [Number.NaN, 100])).toBe('N');
    expect(compassOf([Number.POSITIVE_INFINITY, 0], [0, 0])).toBe('N');
  });
});

// ═══════════════════════════════════════════════════════════
// 域与锚地块
// ═══════════════════════════════════════════════════════════

describe('isTileInDomain / resolveDomainAnchor', () => {
  it('中层域按链第一环，国家域按链第二环', () => {
    const idx = index();
    expect(isTileInDomain(idx, 2, domainRef('midTier', 'north-a'))).toBe(true);
    expect(isTileInDomain(idx, 2, domainRef('midTier', 'north-b'))).toBe(false);
    expect(isTileInDomain(idx, 2, domainRef('country', 'north'))).toBe(true);
    // 12 Lima 自己无主，经中层归 south
    expect(isTileInDomain(idx, 12, domainRef('country', 'south'))).toBe(true);
    // 不在包里的块永远不算在域内（换包后的旧派生态）
    expect(isTileInDomain(idx, 99, domainRef('country', 'north'))).toBe(false);
  });

  it('有锚就用锚', () => {
    const idx = index();
    expect(resolveDomainAnchor(idx, domainRef('midTier', 'north-a'))).toBe(1);
    expect(resolveDomainAnchor(idx, domainRef('country', 'south'))).toBe(3);
  });

  it('无锚 → 域内最大**可落脚**块：跳过不可通行块与湖（§8.2-3）', () => {
    // north-b 里：8 Hotel 5000 不可通行 / 11 Kilo 9000 是湖 / 10 Juliett 1000 / 9 India 400
    expect(resolveDomainAnchor(index(), domainRef('midTier', 'north-b'))).toBe(10);
  });

  it('面积相同时取较小 id（结论不随 tiles 行序变）', () => {
    const pack = fixture();
    for (const row of pack.tiles) {
      if (row.midTierId === 'north-b') row.areaPx = 500;
    }
    const forward = buildMapIndex(pack);
    const reversedPack = fixture();
    for (const row of reversedPack.tiles) {
      if (row.midTierId === 'north-b') row.areaPx = 500;
    }
    reversedPack.tiles.reverse();
    const backward = buildMapIndex(reversedPack);
    expect(resolveDomainAnchor(forward, domainRef('midTier', 'north-b'))).toBe(9);
    expect(resolveDomainAnchor(backward, domainRef('midTier', 'north-b'))).toBe(9);
  });

  it('悬空锚不当真，回落最大块', () => {
    const pack = fixture();
    pack.midTiers = pack.midTiers.map((row) =>
      row.id === 'north-a' ? { ...row, anchorTileId: 99 } : row,
    );
    // north-a 里最大的可落脚块是 1 Alpha（900）
    expect(resolveDomainAnchor(buildMapIndex(pack), domainRef('midTier', 'north-a'))).toBe(1);
  });

  it('域内一块地都没有 → null（诚实地报「没有落脚点」）', () => {
    const idx = index();
    expect(resolveDomainAnchor(idx, domainRef('midTier', 'ghost'))).toBeNull();
    expect(resolveDomainAnchor(idx, domainRef('country', 'nobody'))).toBeNull();
  });

  it('未知域 → null', () => {
    expect(resolveDomainAnchor(index(), domainRef('country', 'atlantis'))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 落位契约五条（§8.2）
// ═══════════════════════════════════════════════════════════

describe('resolveTileByLocation —— 契约 1：可钉位的名字', () => {
  it('地块名钉位', () => {
    expect(resolveTileByLocation(index(), 'RegionEast-Northland-Bravo', null)).toBe(2);
  });

  it('绑定名（聚落/标记）钉位', () => {
    expect(resolveTileByLocation(index(), 'RegionEast-Northland-Alpha Town', null)).toBe(1);
  });

  it('中层名与国家名**不**直接钉位（它们只圈域 → 走锚，不是走同名地块）', () => {
    const idx = index();
    // 只圈 north-a：当前块在域外（3 Charlie）→ 落锚 1
    expect(resolveTileByLocation(idx, 'North Vale', 3)).toBe(1);
    // 只圈 north：同样落锚
    expect(resolveTileByLocation(idx, 'Northland', 3)).toBe(1);
  });
});

describe('resolveTileByLocation —— 契约 2：取最深的钉位段', () => {
  it('多个钉位段时取最深（同域）', () => {
    // Alpha(1) 更浅、Bravo Keep(2) 更深
    expect(resolveTileByLocation(index(), 'Northland-Alpha-Bravo Keep', null)).toBe(2);
  });

  it('比地块更细的段匹配不上 → 被忽略，落在上一层的钉位段', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'Northland-Alpha Town-DockDistrict', null)).toBe(1);
    expect(resolveTileByLocation(idx, 'Northland-Alpha Town-DockDistrict-Warehouse 3', null)).toBe(
      1,
    );
  });

  it('中层段 + 更深的地块段 → 地块赢', () => {
    expect(resolveTileByLocation(index(), 'Northland-North Vale-Bravo', 3)).toBe(2);
  });

  it('中层段属于**别的**域时地块段照样赢（深度是唯一排序键）', () => {
    // South Reach 圈的是 south-a，而钉位段 Alpha 在 north-a：钉位优先，不去管两者矛盾
    expect(resolveTileByLocation(index(), 'South Reach-Alpha', 3)).toBe(1);
  });

  it('钉位段比域段更浅时也赢（钉位优先于圈域，与相对深度无关）', () => {
    // 路径写颠倒了（地块在前、中层在后）：仍应钉在地块上
    expect(resolveTileByLocation(index(), 'Alpha-South Reach', 3)).toBe(1);
  });
});

describe('resolveTileByLocation —— 契约 3：只圈域时的两条分支', () => {
  it('当前块已在中层域内 → 原地不动（AI 在说模糊话）', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'North Vale', 2)).toBe(2);
    expect(resolveTileByLocation(idx, 'North Vale', 0)).toBe(0); // tileId 0 也算「在域内」
  });

  it('当前块已在国家域内 → 原地不动（含经中层补链的那种归属）', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'Southmark', 12)).toBe(12);
  });

  it('当前块在域外 → 落锚地块', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'South Reach', 1)).toBe(3);
    expect(resolveTileByLocation(idx, 'Southmark', 1)).toBe(3);
  });

  it('当前块未知（首次落位 / 换包后派生态已清）→ 落锚', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'North Vale', null)).toBe(1);
    expect(resolveTileByLocation(idx, 'North Vale', undefined)).toBe(1);
    // 旧存档带着一个新包里不存在的 id：当作域外，走锚（§3.4-2 投影自愈）
    expect(resolveTileByLocation(idx, 'North Vale', 99)).toBe(1);
  });

  it('无锚中层 + 域外 → 最大可落脚块', () => {
    expect(resolveTileByLocation(index(), 'North Ridge', 1)).toBe(10);
  });

  it('域内一块地都没有 → null（落位失败，调用方保持原值）', () => {
    expect(resolveTileByLocation(index(), 'Ghost March', 1)).toBeNull();
  });

  it('多个域段时取最深的那个', () => {
    // Northland(国家, 浅) + South Reach(中层, 深) → 按 south-a 圈域，当前块 1 在域外 → 锚 3
    expect(resolveTileByLocation(index(), 'Northland-South Reach', 1)).toBe(3);
  });

  it('同名时按更具体的层圈域（中层赢）', () => {
    // Twin 既是中层（锚 2）又是国家（锚 3）→ 取中层
    expect(resolveTileByLocation(index(), 'Twin', null)).toBe(2);
  });
});

describe('resolveTileByLocation —— 契约 4：只有原文与归一化两档', () => {
  it('原文相等命中', () => {
    expect(resolveTileByLocation(index(), 'Alpha Town', null)).toBe(1);
  });

  it('归一化命中：空白差异与全角/半角差异', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, ' Alpha   Town ', null)).toBe(1);
    expect(resolveTileByLocation(idx, 'AlphaTown', null)).toBe(1);
    expect(resolveTileByLocation(idx, 'Ａlpha Town', null)).toBe(1);
  });

  it('深度是主键：更深段只归一化命中，也赢过更浅段的原文命中', () => {
    // Alpha 是原文命中(1)，AlphaTown 归一化命中(1)… 换成两个不同块来验：
    // Charlie 原文命中(3) 在浅处，'Bravo Keep' 去空白后归一化命中(2) 在深处
    expect(resolveTileByLocation(index(), 'Charlie-BravoKeep', null)).toBe(2);
  });

  it('绝不子串匹配', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'Alph', null)).toBeNull();
    expect(resolveTileByLocation(idx, 'Alpha Tow', null)).toBeNull();
    expect(resolveTileByLocation(idx, 'Alpha Town Docks', null)).toBeNull();
  });

  it('绝不相似度匹配（一个字之差就是不认识）', () => {
    expect(resolveTileByLocation(index(), 'Alpna Town', null)).toBeNull();
  });

  it('大小写差异不认（刻意保守：认不出只是保持原位）', () => {
    expect(resolveTileByLocation(index(), 'alpha town', null)).toBeNull();
  });
});

describe('resolveTileByLocation —— 契约 5：全落空给 null', () => {
  it('一个段都认不出 → null（调用方保持 lastTileId 原值）', () => {
    const idx = index();
    expect(resolveTileByLocation(idx, 'Atlantis-Elsewhere', 2)).toBeNull();
    expect(resolveTileByLocation(idx, '', 2)).toBeNull();
    expect(resolveTileByLocation(idx, '   ', 2)).toBeNull();
    expect(resolveTileByLocation(idx, '---', 2)).toBeNull();
  });

  it('空包：任何路径都给 null（含在别的包里存在的名字）', () => {
    const empty = buildMapIndex(EMPTY_MAP_PACK);
    expect(resolveTileByLocation(empty, 'Northland-Alpha Town', 1)).toBeNull();
    expect(resolveTileByLocation(empty, 'North Vale', 1)).toBeNull();
  });

  it('落位是纯查询：不改索引、不改包', () => {
    const pack = fixture();
    const before = JSON.stringify(pack);
    const idx = buildMapIndex(pack);
    resolveTileByLocation(idx, 'Northland-North Vale-Bravo', 3);
    resolveTileByLocation(idx, 'Ghost March', 1);
    expect(JSON.stringify(pack)).toBe(before);
  });

  it('同一份包重建两次结论一致（重建便宜、没有缓存）', () => {
    const pack = fixture();
    const a = buildMapIndex(pack);
    const b = buildMapIndex(pack);
    for (const path of ['Northland-Alpha Town', 'North Ridge', 'Twin', 'Atlantis']) {
      expect(resolveTileByLocation(a, path, 3)).toBe(resolveTileByLocation(b, path, 3));
    }
  });
});
