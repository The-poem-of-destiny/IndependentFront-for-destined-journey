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
  buildLabelsForMode,
  buildMidTierLabels,
  buildModePaint,
  buildPoliticalPaint,
  buildPoliticalTint,
  buildRoutePolyline,
  buildRouteWaypoints,
  buildTileColorLookup,
  buildTileLabels,
  buildTraceKeys,
  formatPolylinePoints,
  tileCentroidWorld,
  centerStageView,
  clampStageView,
  composeDepartureDirective,
  decodeProvinceIds,
  describeTile,
  fitStageView,
  frameStageOnPoints,
  IMPASSABLE_ALPHA,
  IMPASSABLE_HATCH_RGB,
  AUTO_TILE_ZOOM_OVER_MIN,
  IMPASSABLE_RGB,
  LABEL_MIN_ZOOM_OVER_MIN,
  labelsVisibleAtZoom,
  projectLabelsToScreen,
  projectToScreen,
  provinceColorForTileId,
  resolveEffectiveTintMode,
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

  it('🔴 pack 带的权威色优先，哈希只是回落 —— 有色的地块用哈希查不到', () => {
    // 权威色刻意与哈希色不同：工具链 `allocColor` 为撞色加过盐时，真实颜色正是这样偏离哈希的
    const explicit: [number, number, number] = [3, 5, 7];
    const lookup = buildTileColorLookup([{ id: 1, color: explicit }]);
    expect(lookup.byColor.get(rgbKey(3, 5, 7))).toBe(1);
    const hashed = provinceColorForTileId(1);
    expect(hashed).not.toEqual(explicit);
    expect(lookup.byColor.has(rgbKey(hashed[0], hashed[1], hashed[2]))).toBe(false);
    expect(lookup.ambiguous).toBe(0);
  });

  it('🔴 逐块判断，不是整包二选一：混合包里有色的用色、无色的回落哈希', () => {
    const lookup = buildTileColorLookup([{ id: 1, color: [3, 5, 7] }, { id: 2 }]);
    expect(lookup.byColor.get(rgbKey(3, 5, 7))).toBe(1);
    const two = provinceColorForTileId(2);
    expect(lookup.byColor.get(rgbKey(two[0], two[1], two[2]))).toBe(2);
    expect(lookup.byColor.size).toBe(2);
  });

  it('权威色也走同一条撞色防线（两边一起丢），纯黑同样不入表', () => {
    const collide = buildTileColorLookup([
      { id: 1, color: [9, 9, 9] },
      { id: 2, color: [9, 9, 9] },
      { id: 3, color: [4, 4, 4] },
    ]);
    expect(collide.byColor.has(rgbKey(9, 9, 9))).toBe(false);
    expect(collide.ambiguous).toBe(2);
    expect(collide.byColor.get(rgbKey(4, 4, 4))).toBe(3);
    // 纯黑是「未绘制」的保留色：映射到它的地块会把整片没画的区域认成自己的领土
    const black = buildTileColorLookup([{ id: 1, color: [0, 0, 0] }]);
    expect(black.byColor.size).toBe(0);
  });

  it('权威色画出来的栅格能反查到地块（解码端与查表端同一口径）', () => {
    const tiles = [
      { id: 1, color: [3, 5, 7] as [number, number, number] },
      { id: 2, color: [200, 100, 50] as [number, number, number] },
    ];
    const data = new Uint8ClampedArray([3, 5, 7, 255, 200, 100, 50, 255]);
    const raster = decodeProvinceIds({ width: 2, height: 1, data }, buildTileColorLookup(tiles));
    expect([raster.idBuf[0], raster.idBuf[1]]).toEqual([1, 2]);
    expect(raster.unknownPixels).toBe(0);
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
// 着色方式（势力 / 中层 / 地块）与地块名标签
// ═══════════════════════════════════════════════════════════

describe('着色方式', () => {
  it('势力档与 buildPoliticalPaint **逐项相同** —— 组件据此复用舞台烘好的缓冲', () => {
    // 🔴 这条守的是「加了开关之后势力档逐像素不变」：组件在 country 档直接用
    //    `stage.tint`（composable 用 buildPoliticalPaint 烘的），只有这条等价成立才合法。
    const pack = makePack();
    const viaMode = buildModePaint(pack, 'country');
    const direct = buildPoliticalPaint(pack);
    expect([...viaMode.fillByTile.entries()]).toEqual([...direct.fillByTile.entries()]);
    expect([...viaMode.hatchByTile.entries()]).toEqual([...direct.hatchByTile.entries()]);
  });

  it('地块档：pack 的权威块色优先，缺席才回落哈希', () => {
    const pack = makePack({
      tiles: [
        tile({ id: 1, name: '甲一', color: [9, 8, 7] }),
        tile({ id: 2, name: '甲二' }), // 没有 color → 回落
      ],
    });
    const paint = buildModePaint(pack, 'tile');
    expect(paint.fillByTile.get(1)).toEqual([9, 8, 7]);
    expect(paint.fillByTile.get(2)).toEqual(provinceColorForTileId(2));
  });

  it('中层档：同中层同色、不同中层不同色，没有中层的陆块走中性色', () => {
    const pack = makePack({
      midTiers: [
        { id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 1 },
        { id: 'm-2', name: '乙州', countryId: 'c-b', climateId: '', anchorTileId: 3 },
      ],
      tiles: [
        tile({ id: 1, midTierId: 'm-1' }),
        tile({ id: 2, midTierId: 'm-1' }),
        tile({ id: 3, midTierId: 'm-2' }),
        tile({ id: 4 }), // 没有中层
      ],
    });
    const paint = buildModePaint(pack, 'midTier');
    expect(paint.fillByTile.get(1)).toEqual(paint.fillByTile.get(2));
    expect(paint.fillByTile.get(3)).not.toEqual(paint.fillByTile.get(1));
    expect(paint.fillByTile.get(4)).toEqual([...UNCLAIMED_RGB]);
    // 颜色出自既有的那个哈希，**没有第二个颜色算法**（序号 +1，见被测文件那条注释）
    expect(paint.fillByTile.get(1)).toEqual(provinceColorForTileId(1));
    expect(paint.fillByTile.get(3)).toEqual(provinceColorForTileId(2));
  });

  it('两个新档都不画水域与天堑（势力档的影线是势力档的问题）', () => {
    const pack = makePack();
    for (const mode of ['midTier', 'tile'] as const) {
      const paint = buildModePaint(pack, mode);
      expect(paint.fillByTile.has(5), `${mode} 不该画内海`).toBe(false);
      expect(paint.fillByTile.has(6), `${mode} 不该画雪脊`).toBe(false);
      expect(paint.hatchByTile.size, `${mode} 不该有影线`).toBe(0);
    }
  });

  it('换档只是换一张颜色表：同一份 idBuf 直接喂 buildPoliticalTint 就能出新缓冲', () => {
    const pack = makePack();
    const raster = decode(STRIPES, pack);
    const tint = buildPoliticalTint(raster, buildModePaint(pack, 'tile'));
    expect(rgbAt(tint, 6, 0, 0)).toEqual([...provinceColorForTileId(1)]);
    expect(alphaAt(tint, 6, 0, 0)).toBe(TERRITORY_ALPHA);
    expect(alphaAt(tint, 6, 5, 0)).toBe(0); // 内海仍然留空
    expect(alphaAt(tint, 6, 2, 0)).toBe(0); // 天堑在这一档也留空
  });
});

describe('地图标签', () => {
  it('地块档：每块地一个标签，落在形心；没名字的跳过', () => {
    const pack = makePack({
      tiles: [
        tile({ id: 1, name: '甲一', centroid: [2, 1] }),
        tile({ id: 2, name: '   ' }), // 空白名 = 没名字
        tile({ id: 3, name: '' }),
      ],
    });
    expect(buildTileLabels(pack, 6, 3)).toEqual([{ key: 't1', name: '甲一', x: 2, y: 1 }]);
  });

  it('形心按 resolution → 实际栅格的比例折算（两者理论相等但不假设）', () => {
    const pack = makePack({
      resolution: { w: 6, h: 3 },
      tiles: [tile({ id: 1, name: '甲一', centroid: [3, 1] })],
    });
    // 栅格是 resolution 的两倍宽高
    expect(buildTileLabels(pack, 12, 6)[0]).toEqual({ key: 't1', name: '甲一', x: 6, y: 2 });
  });

  it('中层档：一个中层**一个**标签（不是它辖下每块地一个），落在锚地块形心', () => {
    const pack = makePack({
      midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 2 }],
      tiles: [
        tile({ id: 1, name: '甲一', midTierId: 'm-1', centroid: [0, 0], areaPx: 1 }),
        tile({ id: 2, name: '甲二', midTierId: 'm-1', centroid: [4, 2], areaPx: 1 }),
        tile({ id: 3, name: '甲三', midTierId: 'm-1', centroid: [0, 0], areaPx: 1 }),
      ],
    });
    // 三块地只出一个标签，且用的是锚地块（2 号）的形心而不是三者平均
    expect(buildMidTierLabels(pack, 6, 3)).toEqual([{ key: 'mm-1', name: '甲州', x: 4, y: 2 }]);
  });

  it('中层档：没有锚地块时用**按面积加权**的形心（碎块拽不走标签）', () => {
    const pack = makePack({
      midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: null }],
      tiles: [
        // 主体块占 99 像素在 x=0，一个碎块占 1 像素在 x=100
        tile({ id: 1, midTierId: 'm-1', centroid: [0, 0], areaPx: 99 }),
        tile({ id: 2, midTierId: 'm-1', centroid: [100, 0], areaPx: 1 }),
      ],
    });
    // 等权平均会落在 x=50（主体外面）；加权后落在 x=1 附近
    expect(buildMidTierLabels(pack, 6, 3)[0].x).toBeCloseTo(1, 6);
  });

  it('中层档：面积全为 0 时退回等权平均，绝不产出 NaN', () => {
    const pack = makePack({
      midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: null }],
      tiles: [
        tile({ id: 1, midTierId: 'm-1', centroid: [0, 0], areaPx: 0 }),
        tile({ id: 2, midTierId: 'm-1', centroid: [4, 2], areaPx: 0 }),
      ],
    });
    expect(buildMidTierLabels(pack, 6, 3)[0]).toEqual({ key: 'mm-1', name: '甲州', x: 2, y: 1 });
  });

  it('中层档：没有成员地块的空壳中层不出标签（真包里就有几个）', () => {
    const pack = makePack({
      midTiers: [
        { id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 1 },
        // 空壳：没有任何地块的 midTierId 指向它 —— 哪怕锚地块指得到一块地
        { id: 'm-空', name: '幽州', countryId: 'c-a', climateId: '', anchorTileId: 1 },
        { id: 'm-2', name: '   ', countryId: 'c-a', climateId: '', anchorTileId: 1 },
      ],
      tiles: [tile({ id: 1, midTierId: 'm-1', centroid: [1, 1] })],
    });
    expect(buildMidTierLabels(pack, 6, 3).map((l) => l.name)).toEqual(['甲州']);
  });

  it('棋子落点 = 地块形心，且照 resolution → 栅格比例折算', () => {
    const pack = makePack({
      resolution: { w: 6, h: 3 },
      tiles: [tile({ id: 1, centroid: [3, 1] })],
    });
    expect(tileCentroidWorld(pack, 1, 6, 3)).toEqual({ x: 3, y: 1 });
    expect(tileCentroidWorld(pack, 1, 12, 6)).toEqual({ x: 6, y: 2 });
    // 查不到的地块 → null（调用方据此不画棋子，而不是画到 (0,0)）
    expect(tileCentroidWorld(pack, 99, 6, 3)).toBeNull();
  });

  it('路线折线按 tilePath 的**顺序**连点；查不到的地块跳过而不是中断', () => {
    const pack = makePack({
      tiles: [
        tile({ id: 1, centroid: [0, 0] }),
        tile({ id: 2, centroid: [1, 1] }),
        tile({ id: 3, centroid: [2, 2] }),
      ],
    });
    expect(buildRoutePolyline(pack, [3, 1, 2], 6, 3)).toEqual([
      { x: 2, y: 2 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    // 中间夹一个不存在的地块：整条线仍在，只是少一个顶点
    expect(buildRoutePolyline(pack, [1, 99, 3], 6, 3)).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ]);
  });

  it('points 串：不足两点给空串（调用方据此整条不渲染）', () => {
    expect(formatPolylinePoints([])).toBe('');
    expect(formatPolylinePoints([{ x: 1, y: 2 }])).toBe('');
    expect(
      formatPolylinePoints([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toBe('1,2 3,4');
  });

  it('途经点只标**真的落在路线上**的那些，且按路线顺序（不是点选顺序）', () => {
    const pack = makePack({
      tiles: [
        tile({ id: 1, centroid: [0, 0] }),
        tile({ id: 2, centroid: [1, 0] }),
        tile({ id: 3, centroid: [2, 0] }),
        tile({ id: 4, centroid: [3, 0] }),
      ],
    });
    // 🔴 via 是软约束：findPath 绕不过去时会给一条不经过它的路。4 号没在路线上 →
    //    不该标，否则地图会在一块根本没经过的地上点一个「途经」。
    const marks = buildRouteWaypoints(pack, [1, 2, 3], [3, 2, 4], 6, 3);
    expect(marks).toEqual([
      { tileId: 2, x: 1, y: 0 },
      { tileId: 3, x: 2, y: 0 },
    ]);
  });

  it('世界坐标 → 屏幕坐标：先缩放再加位移', () => {
    const view: StageView = { s: 2, x: 10, y: -5, min: 1, max: 50 };
    expect(projectToScreen({ x: 3, y: 4 }, view)).toEqual({ x: 16, y: 3 });
  });

  it('投影后按视口裁剪：视口外（超过留白）的标签不进 DOM', () => {
    // 🔴 深缩放时 310 个标签里绝大多数在视口外；不裁的话 DOM 里挂着几百个看不见的节点
    const view: StageView = { s: 1, x: 0, y: 0, min: 1, max: 50 };
    const labels = [
      { key: 'a', name: '中间', x: 50, y: 50 },
      { key: 'b', name: '左外', x: -500, y: 50 },
      { key: 'c', name: '右外', x: 5000, y: 50 },
      { key: 'd', name: '下外', x: 50, y: 5000 },
      { key: 'e', name: '贴边', x: -10, y: 50 }, // 中心点出界但字还该露出来 → 留白内，保留
    ];
    const kept = projectLabelsToScreen(labels, view, 200, 200).map((l) => l.name);
    expect(kept).toEqual(['中间', '贴边']);
  });

  it('裁剪留白可调，且投影出来的是**屏幕**坐标（不是原样透传世界坐标）', () => {
    const view: StageView = { s: 2, x: 100, y: 0, min: 1, max: 50 };
    const labels = [{ key: 'a', name: '甲', x: 10, y: 10 }];
    expect(projectLabelsToScreen(labels, view, 400, 400)).toEqual([
      { key: 'a', name: '甲', x: 120, y: 20 },
    ]);
    // 留白收到 0 时，正好落在边界上仍算在内
    expect(projectLabelsToScreen(labels, view, 120, 20, 0)).toHaveLength(1);
    expect(projectLabelsToScreen(labels, view, 119, 20, 0)).toHaveLength(0);
  });

  it('按档分派：势力不画、中层出中层名、地块出地块名', () => {
    const pack = makePack({
      midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 1 }],
      tiles: [
        tile({ id: 1, name: '甲一', midTierId: 'm-1' }),
        tile({ id: 2, name: '甲二', midTierId: 'm-1' }),
      ],
    });
    expect(buildLabelsForMode(pack, 'country', 6, 3)).toEqual([]);
    expect(buildLabelsForMode(pack, 'midTier', 6, 3).map((l) => l.name)).toEqual(['甲州']);
    expect(buildLabelsForMode(pack, 'tile', 6, 3).map((l) => l.name)).toEqual(['甲一', '甲二']);
  });

  it('自动档：粒度跟着缩放走，两个阈值都按**取等号即进位**', () => {
    const at = (ratio: number): StageView => ({ s: 2 * ratio, x: 0, y: 0, min: 2, max: 500 });
    expect(resolveEffectiveTintMode('auto', at(1))).toBe('country');
    // 恰好 T_MID：进中层（>= 不是 >）。中层阈值就是标签起显阈值本身（见下一条用例）
    expect(resolveEffectiveTintMode('auto', at(LABEL_MIN_ZOOM_OVER_MIN - 0.0001))).toBe('country');
    expect(resolveEffectiveTintMode('auto', at(LABEL_MIN_ZOOM_OVER_MIN))).toBe('midTier');
    // 恰好 T_TILE：进地块
    expect(resolveEffectiveTintMode('auto', at(AUTO_TILE_ZOOM_OVER_MIN - 0.0001))).toBe('midTier');
    expect(resolveEffectiveTintMode('auto', at(AUTO_TILE_ZOOM_OVER_MIN))).toBe('tile');
    expect(resolveEffectiveTintMode('auto', at(50))).toBe('tile');
  });

  it('自动档进中层的那一刻**正是**标签起显的那一刻（同一个常量，构造上不可能分叉）', () => {
    // 🔴 差一点点就会出现「变了色却没有名字」的一小段缩放区间，看起来像掉了东西。
    //    resolveEffectiveTintMode 直接引用 LABEL_MIN_ZOOM_OVER_MIN（不设别名常量），
    //    这里从两个入口各问一次，钉住它们在同一缩放下同时翻转。
    const view: StageView = { s: 2 * LABEL_MIN_ZOOM_OVER_MIN, x: 0, y: 0, min: 2, max: 500 };
    expect(resolveEffectiveTintMode('auto', view)).toBe('midTier');
    expect(labelsVisibleAtZoom(view)).toBe(true);
  });

  it('手动三档原样透传（显式覆盖不受缩放影响）', () => {
    const deep: StageView = { s: 100, x: 0, y: 0, min: 2, max: 500 };
    const shallow: StageView = { s: 2, x: 0, y: 0, min: 2, max: 500 };
    for (const mode of ['country', 'midTier', 'tile'] as const) {
      expect(resolveEffectiveTintMode(mode, deep)).toBe(mode);
      expect(resolveEffectiveTintMode(mode, shallow)).toBe(mode);
    }
  });

  it('自动档遇退化视图（未布局）退到最粗的势力档，不产出 NaN 分档', () => {
    expect(resolveEffectiveTintMode('auto', { s: 1, x: 0, y: 0, min: 0, max: 1 })).toBe('country');
    expect(resolveEffectiveTintMode('auto', { s: Number.NaN, x: 0, y: 0, min: 2, max: 5 })).toBe(
      'country',
    );
  });

  it('缩放阈值：低于 min 的 1.5 倍不画（单一阈值，不做逐标签避让）', () => {
    const view = (s: number): StageView => ({ s, x: 0, y: 0, min: 2, max: 50 });
    expect(labelsVisibleAtZoom(view(2))).toBe(false);
    expect(labelsVisibleAtZoom(view(2 * LABEL_MIN_ZOOM_OVER_MIN))).toBe(true);
    expect(labelsVisibleAtZoom(view(40))).toBe(true);
    // 退化视图（未布局）不该把标签画到一个还没有尺寸的舞台上
    expect(labelsVisibleAtZoom({ s: 1, x: 0, y: 0, min: 0, max: 1 })).toBe(false);
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
