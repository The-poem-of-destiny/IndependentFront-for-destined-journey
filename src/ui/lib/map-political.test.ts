/**
 * map-political.test.ts — 势力地图纯逻辑（地图 v1 / 设计 §9）
 *
 * 全部用**合成小栅格**（几十个像素）与合成包，零真实地名（承 D25①的口径：
 * 引擎/前端测试不进真实内容）。这样每条断言都能手算出期望值 ——
 * 8.7M 像素的真图只能验「没崩」，验不了「算对了」。
 *
 * 🔴 本组特意钉住三条**坏起来不报错**的性质:
 *    ① 撞色的两块地必须**一起丢**（否则会把一整块地画/点成另一块，见被测文件头那条红线）
 *    ② 高亮必须是**一份**补丁（逐块 put 会互相清空 —— `putImageData` 是覆盖不是混合）
 *    ③ 缩放锚点：光标下那一点缩放前后必须还在光标下（漂一点点的实现每一步都「看着对」）
 */

import { describe, expect, it } from 'vitest';
import { buildMapIndex } from '@engine/map-index';
import type { MapPack, MapTile } from '@engine/types-map';
import {
  buildBorderPaths,
  buildHighlightPatch,
  buildPoliticalPaint,
  buildPoliticalTint,
  buildTileColorLookup,
  buildTraceKeys,
  centerStageView,
  clampStageView,
  composeDepartureDirective,
  decodeProvinceIds,
  describeTile,
  fitStageView,
  frameStageOnPoints,
  IMPASSABLE_ALPHA,
  IMPASSABLE_HATCH_RGB,
  IMPASSABLE_RGB,
  provinceColorForTileId,
  rgbKey,
  stagePointToWorld,
  TERRITORY_ALPHA,
  tileAtRasterPoint,
  tileNameOf,
  TRACE_IMPASSABLE,
  TRACE_UNCLAIMED,
  TRACE_WATER,
  UNCLAIMED_RGB,
  UNKNOWN_TILE,
  VOID_TILE,
  zoomStageView,
  type ProvinceRaster,
  type RasterPixels,
  type StageView,
} from './map-political';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

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

/**
 * 合成包：两国 + 无主 + 一块海 + 一道天堑。
 * 天堑（4）与甲国的 1 共享 90 像素、与乙国的 2 共享 10 像素 —— 邻主投票该是甲国。
 */
function makePack(overrides: Partial<MapPack> = {}): MapPack {
  return {
    version: '1',
    contentHash: 'hash-a',
    resolution: { w: 6, h: 3 },
    kmPerPx: 1,
    terrains: ['平地', '山地', '水面'],
    travelRules: {
      rates: { land: 10, nearSea: 20, farSea: 30 },
      embarkCost: 1,
      terrainFactor: { 平地: 1, 山地: 2 },
    },
    countries: [
      { id: 'c-a', name: '甲国', color: [10, 20, 30], anchorTileId: 1 },
      { id: 'c-b', name: '乙国', color: [200, 100, 50], anchorTileId: 2 },
      { id: 'c-none', name: '荒野', color: [7, 7, 7], unclaimed: true, anchorTileId: null },
    ],
    midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 1 }],
    climates: {},
    tiles: [
      tile({
        id: 1,
        name: '甲一',
        countryId: 'c-a',
        midTierId: 'm-1',
        centroid: [0, 1],
        areaPx: 3,
      }),
      tile({ id: 2, name: '甲二', countryId: 'c-a', centroid: [1, 1], areaPx: 3 }),
      tile({ id: 3, name: '乙一', countryId: 'c-b', centroid: [3, 1], areaPx: 3 }),
      tile({ id: 4, name: '荒地', countryId: 'c-none', centroid: [4, 1], areaPx: 3 }),
      tile({ id: 5, name: '内海', terrain: '水面', water: 'sea', centroid: [5, 1], areaPx: 3 }),
      tile({ id: 6, name: '雪脊', terrain: '山地', impassable: true, centroid: [2, 1], areaPx: 3 }),
    ],
    adjacency: [
      [1, 2, 40],
      [2, 6, 90],
      [6, 3, 10],
      [3, 4, 20],
      [4, 5, 20],
    ],
    straits: [],
    placeBindings: {},
    ...overrides,
  };
}

/** 二维 id 表 → RGBA 栅格（`0` = 未绘制纯黑；负数 = 一个查不到的颜色） */
function rasterPixels(rows: number[][]): RasterPixels {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = rows[y][x];
      const o = (y * w + x) * 4;
      const rgb = id === 0 ? [0, 0, 0] : id < 0 ? [1, 2, 3] : provinceColorForTileId(id);
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function decode(rows: number[][], pack: MapPack = makePack()): ProvinceRaster {
  return decodeProvinceIds(rasterPixels(rows), buildTileColorLookup(pack.tiles));
}

/** 6×3：甲一/甲二 | 天堑 | 乙一 | 荒地 | 内海 竖条带 */
const STRIPES: number[][] = [
  [1, 2, 6, 3, 4, 5],
  [1, 2, 6, 3, 4, 5],
  [1, 2, 6, 3, 4, 5],
];

const alphaAt = (buf: Uint8ClampedArray, w: number, x: number, y: number): number =>
  buf[(y * w + x) * 4 + 3];
const rgbAt = (buf: Uint8ClampedArray, w: number, x: number, y: number): number[] => {
  const o = (y * w + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
};

// ═══════════════════════════════════════════════════════════
// 颜色查表与解码
// ═══════════════════════════════════════════════════════════

describe('像素 → 地块 id', () => {
  it('块色是 id 的确定性函数，且永不是纯黑（纯黑保留给未绘制）', () => {
    expect(provinceColorForTileId(42)).toEqual(provinceColorForTileId(42));
    expect(provinceColorForTileId(1)).not.toEqual(provinceColorForTileId(2));
    for (const id of [0, 1, 7, 316, 99999]) {
      const [r, g, b] = provinceColorForTileId(id);
      expect(rgbKey(r, g, b)).not.toBe(0);
    }
  });

  it('查表覆盖包里每一块地', () => {
    const pack = makePack();
    const lookup = buildTileColorLookup(pack.tiles);
    expect(lookup.ambiguous).toBe(0);
    for (const t of pack.tiles) {
      const [r, g, b] = provinceColorForTileId(t.id);
      expect(lookup.byColor.get(rgbKey(r, g, b))).toBe(t.id);
    }
  });

  it('撞色的两块地一起丢 —— 绝不让其中一块顶替另一块（文件头红线）', () => {
    // 5948 与 8811 的哈希色相同（[200,241,78]），暴力扫出来的定值：哈希确定，永远成立
    const lookup = buildTileColorLookup([{ id: 5948 }, { id: 8811 }, { id: 1 }]);
    const [r, g, b] = provinceColorForTileId(5948);
    expect(provinceColorForTileId(8811)).toEqual([r, g, b]);
    expect(lookup.byColor.has(rgbKey(r, g, b))).toBe(false);
    expect(lookup.ambiguous).toBe(2);
    // 没撞的那一块照常在表里（半懂的图比整张丢掉有用）
    const one = provinceColorForTileId(1);
    expect(lookup.byColor.get(rgbKey(one[0], one[1], one[2]))).toBe(1);
  });

  it('解码出 idBuf / 包围盒 / 未识别像素数', () => {
    const raster = decode(STRIPES);
    expect(raster.w).toBe(6);
    expect(raster.h).toBe(3);
    expect(raster.idBuf[0]).toBe(1);
    expect(raster.idBuf[5]).toBe(5);
    expect(raster.unknownPixels).toBe(0);
    expect(raster.bounds.get(3)).toEqual({ minX: 3, minY: 0, maxX: 3, maxY: 2, count: 3 });
  });

  it('纯黑读作未绘制、认不出的颜色读作未知并计数（两者分开）', () => {
    const raster = decode([
      [0, -1, 1],
      [0, -1, 1],
    ]);
    expect(raster.idBuf[0]).toBe(VOID_TILE);
    expect(raster.idBuf[1]).toBe(UNKNOWN_TILE);
    expect(raster.unknownPixels).toBe(2);
    expect(raster.bounds.has(UNKNOWN_TILE)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 着色
// ═══════════════════════════════════════════════════════════

describe('政治着色', () => {
  it('领土着国家色、无主用中性色、水域不着色', () => {
    const pack = makePack();
    const paint = buildPoliticalPaint(pack);
    expect(paint.fillByTile.get(1)).toEqual([10, 20, 30]);
    expect(paint.fillByTile.get(3)).toEqual([200, 100, 50]);
    // unclaimed 的那一棵按类型契约用中性色，不画它声明的势力色
    expect(paint.fillByTile.get(4)).toEqual([...UNCLAIMED_RGB]);
    expect(paint.fillByTile.has(5)).toBe(false);
    expect(paint.fillByTile.has(6)).toBe(false);
  });

  it('天堑按「共享边最长的邻主」掺色（不是随便一个邻居）', () => {
    const paint = buildPoliticalPaint(makePack());
    const hatch = paint.hatchByTile.get(6);
    expect(hatch).toBeDefined();
    // 甲国（[10,20,30]，共享 90）赢过乙国（[200,100,50]，共享 10）：底色应偏向甲国 = 变暗
    const base = hatch?.[0] ?? [0, 0, 0];
    expect(base[0]).toBeLessThan(IMPASSABLE_RGB[0]);
    // 没有邻主时退回纯石板灰
    const lonely = buildPoliticalPaint(
      makePack({ adjacency: [], tiles: [tile({ id: 6, impassable: true })] }),
    );
    expect(lonely.hatchByTile.get(6)).toEqual([[...IMPASSABLE_RGB], [...IMPASSABLE_HATCH_RGB]]);
  });

  it('缓冲区里领土半透明、天堑更重且带影线、水域整格留空', () => {
    const pack = makePack();
    const raster = decode(STRIPES, pack);
    const tint = buildPoliticalTint(raster, buildPoliticalPaint(pack));

    expect(alphaAt(tint, 6, 0, 0)).toBe(TERRITORY_ALPHA);
    expect(rgbAt(tint, 6, 0, 0)).toEqual([10, 20, 30]);
    expect(alphaAt(tint, 6, 5, 0)).toBe(0); // 内海：底图的海自己就够看
    expect(alphaAt(tint, 6, 2, 0)).toBe(IMPASSABLE_ALPHA);
    // 影线：(x - y) % 6 < 2 那两条与其余不同色
    expect(rgbAt(tint, 6, 2, 0)).not.toEqual(rgbAt(tint, 6, 2, 1));
  });
});

// ═══════════════════════════════════════════════════════════
// 边界
// ═══════════════════════════════════════════════════════════

describe('边界折线', () => {
  it('分类键：天堑 / 水域 / 无主各有自己的档', () => {
    const keys = buildTraceKeys(makePack());
    expect(keys.get(6)).toBe(TRACE_IMPASSABLE);
    expect(keys.get(5)).toBe(TRACE_WATER);
    expect(keys.get(4)).toBe(TRACE_UNCLAIMED);
    expect(keys.get(1)).toBe(keys.get(2)); // 同国 → 同键（它们之间只画块界）
    expect(keys.get(1)).not.toBe(keys.get(3));
  });

  it('四类线各就各位：同国块界 / 国界 / 海岸 / 天堑', () => {
    const pack = makePack();
    const raster = decode(STRIPES, pack);
    const paths = buildBorderPaths(raster, buildTraceKeys(pack));
    expect(paths.province).not.toBe(''); // 甲一↔甲二
    expect(paths.national).not.toBe(''); // 乙一↔荒地
    expect(paths.coast).not.toBe(''); // 荒地↔内海
    expect(paths.impassable).not.toBe(''); // 甲二↔雪脊
  });

  it('RDP 把一条直边简化成两个点（不简化的话每像素一个点）', () => {
    const pack = makePack();
    // 8 行高的两国竖直分界：未简化会是 9 个点
    const rows = Array.from({ length: 8 }, () => [1, 3]);
    const paths = buildBorderPaths(decode(rows, pack), buildTraceKeys(pack));
    expect(paths.national).toBe('M1 0L1 8');
  });

  it('空栅格不抛、四条都是空串（SVG 照样合法）', () => {
    const empty: ProvinceRaster = {
      w: 0,
      h: 0,
      idBuf: new Int32Array(0),
      bounds: new Map(),
      unknownPixels: 0,
    };
    expect(buildBorderPaths(empty, new Map())).toEqual({
      province: '',
      national: '',
      coast: '',
      impassable: '',
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 命中与高亮
// ═══════════════════════════════════════════════════════════

describe('命中检测与高亮补丁', () => {
  it('栅格坐标 → 地块；越界与未绘制都给 VOID', () => {
    const raster = decode(STRIPES);
    expect(tileAtRasterPoint(raster, 3.2, 1)).toBe(3);
    expect(tileAtRasterPoint(raster, -1, 0)).toBe(VOID_TILE);
    expect(tileAtRasterPoint(raster, 99, 0)).toBe(VOID_TILE);
    expect(tileAtRasterPoint(raster, Number.NaN, 0)).toBe(VOID_TILE);
  });

  it('一批地块 → 一份补丁：只染命中的像素，邻块被留空而不是被清掉', () => {
    const raster = decode(STRIPES);
    const patch = buildHighlightPatch(
      raster,
      new Map([
        [1, [1, 2, 3, 40] as const],
        [3, [9, 8, 7, 60] as const],
      ]),
    );
    expect(patch).not.toBeNull();
    // 并集包围盒覆盖 x∈[0,3]
    expect(patch?.x).toBe(0);
    expect(patch?.w).toBe(4);
    const data = patch?.data ?? new Uint8ClampedArray();
    expect(alphaAt(data, 4, 0, 0)).toBe(40); // 块 1
    expect(alphaAt(data, 4, 3, 0)).toBe(60); // 块 3
    expect(alphaAt(data, 4, 1, 0)).toBe(0); // 中间的甲二没被点名 → 透明，不是被覆盖
  });

  it('一块都没命中时返回 null（不分配 35MB 的空图）', () => {
    const raster = decode(STRIPES);
    expect(buildHighlightPatch(raster, new Map())).toBeNull();
    expect(buildHighlightPatch(raster, new Map([[999, [0, 0, 0, 1] as const]]))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 变换数学
// ═══════════════════════════════════════════════════════════

describe('平移缩放', () => {
  it('fit 把整图放进视口并居中', () => {
    const view = fitStageView(200, 100, 400, 400);
    expect(view.s).toBeCloseTo(0.25);
    expect(view.x).toBeCloseTo(50);
    expect(view.y).toBeCloseTo(0);
    expect(view.min).toBeCloseTo(0.225);
    expect(view.max).toBeGreaterThan(view.s);
  });

  it('视口/世界尺寸退化时不产出 NaN（未布局的容器每次都会走到这里）', () => {
    const view = fitStageView(0, 0, 400, 400);
    expect(Number.isFinite(view.s)).toBe(true);
    expect(Number.isFinite(view.x)).toBe(true);
  });

  it('平移夹逼：世界比视口小就居中，大就不许露白边', () => {
    const small = clampStageView({ s: 0.1, x: 999, y: 999, min: 0.05, max: 4 }, 200, 100, 400, 400);
    expect(small.x).toBeCloseTo((200 - 40) / 2);
    const big = clampStageView({ s: 2, x: 50, y: 50, min: 0.05, max: 4 }, 200, 100, 400, 400);
    expect(big.x).toBe(0);
    expect(big.y).toBe(0);
  });

  it('缩放锚点：光标下那一点缩放前后仍在光标下', () => {
    const before = fitStageView(400, 400, 400, 400);
    const anchor = { px: 130, py: 90 };
    const worldBefore = stagePointToWorld(before, anchor.px, anchor.py);
    const after = zoomStageView(before, anchor.px, anchor.py, 2, 400, 400, 400, 400);
    const worldAfter = stagePointToWorld(after, anchor.px, anchor.py);
    expect(after.s).toBeCloseTo(before.s * 2);
    expect(worldAfter.wx).toBeCloseTo(worldBefore.wx, 5);
    expect(worldAfter.wy).toBeCloseTo(worldBefore.wy, 5);
  });

  it('缩放不越过 min/max，且非法倍数原样返回', () => {
    const base: StageView = { s: 1, x: 0, y: 0, min: 0.5, max: 2 };
    expect(zoomStageView(base, 0, 0, 100, 200, 200, 200, 200).s).toBe(2);
    expect(zoomStageView(base, 0, 0, 0.001, 200, 200, 200, 200).s).toBe(0.5);
    expect(zoomStageView(base, 0, 0, Number.NaN, 200, 200, 200, 200).s).toBe(1);
  });

  it('取景：单点定点近观，多点按包围盒', () => {
    const base = fitStageView(400, 200, 800, 400);
    const one = frameStageOnPoints(base, [[400, 200]], 400, 200, 800, 400);
    expect(one.s).toBeGreaterThan(base.s);
    const many = frameStageOnPoints(
      base,
      [
        [100, 100],
        [700, 300],
      ],
      400,
      200,
      800,
      400,
    );
    expect(Number.isFinite(many.s)).toBe(true);
    // 空输入 / 非有穷坐标 → 原样返回（不该把镜头甩到 NaN 去）
    expect(frameStageOnPoints(base, [], 400, 200, 800, 400)).toEqual(base);
    expect(frameStageOnPoints(base, [[Number.NaN, 0]], 400, 200, 800, 400)).toEqual(base);
  });

  it('centerStageView 把世界点推到视口中心', () => {
    const base = { s: 1, x: 0, y: 0, min: 0.1, max: 4 };
    const view = centerStageView(base, 100, 50, 200, 100, 400, 200);
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 展示投影与出发指令
// ═══════════════════════════════════════════════════════════

describe('展示投影', () => {
  it('describeTile 给出名字/国家/中层/地形/通行性', () => {
    const index = buildMapIndex(makePack());
    expect(describeTile(index, 1)).toEqual({
      tileId: 1,
      name: '甲一',
      countryName: '甲国',
      midTierName: '甲州',
      terrain: '平地',
      impassable: false,
      waterLabel: null,
    });
    expect(describeTile(index, 5)?.waterLabel).toBe('海域');
    expect(describeTile(index, 6)?.impassable).toBe(true);
    expect(describeTile(index, 999)).toBeNull();
  });

  it('tileNameOf 只按名字说话（tileId 永不外泄，§8.3）', () => {
    const index = buildMapIndex(makePack());
    expect(tileNameOf(index, 3)).toBe('乙一');
    expect(tileNameOf(index, null)).toBeNull();
    expect(tileNameOf(index, 999)).toBeNull();
  });
});

describe('出发指令（§8.2）', () => {
  it('四段齐全时逐字符合设计的措辞', () => {
    expect(
      composeDepartureDirective({
        destination: '乙一',
        via: ['甲二'],
        avoid: ['雪脊'],
        days: 7,
      }),
    ).toBe('【地图】玩家决定启程前往乙一，取道甲二，避开雪脊，约 7 天');
  });

  it('空子句整段省略', () => {
    expect(composeDepartureDirective({ destination: '乙一' })).toBe('【地图】玩家决定启程前往乙一');
    expect(composeDepartureDirective({ destination: '乙一', days: 0 })).toBe(
      '【地图】玩家决定启程前往乙一',
    );
    expect(composeDepartureDirective({ destination: '乙一', via: ['甲二', '荒地'], days: 3 })).toBe(
      '【地图】玩家决定启程前往乙一，取道甲二、荒地，约 3 天',
    );
    expect(composeDepartureDirective({ destination: '乙一', avoid: ['雪脊'] })).toBe(
      '【地图】玩家决定启程前往乙一，避开雪脊',
    );
  });

  it('目的地为空 → 空串（调用方据此什么都不做）', () => {
    expect(composeDepartureDirective({ destination: '   ' })).toBe('');
    expect(composeDepartureDirective({ destination: '', via: ['甲二'] })).toBe('');
  });

  it('名字去重去空、天数取整不为负', () => {
    expect(
      composeDepartureDirective({
        destination: '乙一',
        via: ['甲二', ' 甲二 ', ''],
        days: 2.4,
      }),
    ).toBe('【地图】玩家决定启程前往乙一，取道甲二，约 2 天');
    expect(composeDepartureDirective({ destination: '乙一', days: -5 })).toBe(
      '【地图】玩家决定启程前往乙一',
    );
  });
});
