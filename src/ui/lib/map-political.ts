/**
 * map-political.ts — 「势力地图」页签的**全部纯逻辑**（地图系统 v1 / 设计 §9，裁定 §12-12）
 *
 * 装什么: provinces.png 的**像素 → 地块 id** 解码（`decodeProvinceIds`）、政治着色缓冲
 *         （`buildPoliticalPaint` + `buildPoliticalTint`）、边界折线（栅格 → 单位段 → 链化 →
 *         RDP 简化 → SVG path）、命中检测、高亮补丁、平移缩放的变换数学、
 *         信息卡的展示投影、以及「出发」指令的措辞（§8.2）。
 * 不装什么: **任何 DOM / canvas / fetch**。取字节那一半在 `map-provinces-raster.ts`
 *           （唯一碰 canvas 的地方，jsdom 里没有 2D 上下文，所以它必须是可 mock 的一层缝）；
 *           状态与生命周期在 `composables/useMapPolitical.ts`；渲染在 `MapPoliticalTab.vue`。
 *
 * 为什么是**自包含移植**而不是接进 OpenSeadragon（裁定 §12-12）: sample 页那套渲染栈
 * （整幅 ImageData 着色 + RDP 矢量描边 + idBuf 命中）对着这份数据实测调通过；改写成 OSD
 * overlay 等于把坐标映射、重绘时机、命中检测对着 OSD 的缩放模型重推一遍 —— 纯集成风险、
 * v1 零收益。代价是一个 Modal 里两套平移缩放实现，已接受。
 *
 * 🔴 **像素颜色与 tileId 的对应关系是这一层的承重假设**，而 pack 现在**自己带着这张表**：
 *    每块地有 `MapTile.color`（编译期取自 `definition.csv`，与 provinces.png 的像素同源）。
 *    有这一格就**照抄，绝不再猜**。
 *    只有**没有**颜色的地块（早期包 / 手写占位包）才回落旧路：重算工具链的
 *    `colorForId(id)` 确定性哈希（`sample-map/mapdata.js`）。那条路实测与首发 mapdata 的
 *    definition.csv **316/316 全等**，但那只是**当下**碰巧全等 —— 工具链的 `allocColor`
 *    在**撞色**时会加盐（`colorForId(id + salt * 7919)`），那时某个块的真实颜色就不再是
 *    `colorForId(id)`，而哈希重算会把它算到**另一个块**的颜色上 —— 「画错一整块地」且
 *    完全无声。这正是 pack 要出这一格的理由；回落只为让老包仍然画得出来，不是等价方案。
 *    两条路径共用同一条防线：`buildTileColorLookup` 一旦发现两个 id 撞到同一个颜色
 *    键，**两边一起丢**（那两块地不着色、点不中，看得见），并把撞色数报出来。
 *    宁可漏不可猜 —— 先例 `image-world-tags`。
 *
 * 🔴 **本文件的中文字面量是对的**：引擎侧 `map-*.ts` 的零 CJK 闸门（设计 §3.4-1）管的是
 *    「随图而变的数据不许焊进引擎」。这里的中文全是**界面词汇**（不可通行 / 海域 / 出发指令
 *    的措辞），与地图数据无关，换一版地图它们一个字都不用改。地形名、国名、地块名一律
 *    从 pack 里取，本文件不认识任何一个具体地名。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`（§9 UI / §8.2 出发指令）。
 */

import { countryOfTile, midTierOfTile, type MapIndex } from '@engine/map-index';
import type { MapPack, MapRoute, MapTile } from '@engine/types-map';

// ═══════════════════════════════════════════════════════════
// 1. 像素 → 地块 id
// ═══════════════════════════════════════════════════════════

/** 未绘制（纯黑）像素的 idBuf 值 —— 与「认不出的颜色」分开，两者处置不同 */
export const VOID_TILE = 0;

/**
 * 画了、但颜色查不到地块的像素。
 *
 * 三种来源：包里没有这一块（版本错配）、撞色被丢弃（见文件头）、图被重新压缩过
 * （有损压缩会把块色搅成一片渐变 —— provinces.png 必须无损）。
 * 一律**不着色、点不中**，并计数上报，让「图和数据不是一套」这件事看得见。
 */
export const UNKNOWN_TILE = -1;

/** RGB → 24 位键（与工具链 `mapdata.js` 的 `rgbKey` 同口径） */
export function rgbKey(r: number, g: number, b: number): number {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/**
 * tileId → provinces.png 里那块地的颜色（工具链 `colorForId` 的逐位移植）。
 *
 * 🔴 **这是回落路径**（`MapTile.color` 缺席时才用它，见文件头）：pack 带了权威色就照抄。
 * 🔴 **一个数都不许改**（含那三个魔数与 `Math.imul`）：它与画图那一侧必须逐位相同，
 *    改一位的表现不是报错，是整张图查不到任何一块地（或者更坏 —— 查到别的块）。
 * 纯黑保留给「未绘制」，所以哈希落到全 0 时上游用 `[17, 17, 17]` 顶掉。
 */
export function provinceColorForTileId(id: number): [number, number, number] {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const r = (h >>> 16) & 255;
  const g = (h >>> 8) & 255;
  const b = h & 255;
  return (r | g | b) === 0 ? [17, 17, 17] : [r, g, b];
}

/** 颜色键 → tileId 的查表，外加被撞色丢弃的地块数（诊断用） */
export interface TileColorLookup {
  byColor: ReadonlyMap<number, number>;
  /** 撞色被丢弃的**地块**数（两个 id 撞一个颜色 = 计 2） */
  ambiguous: number;
}

/** 建查表要的最小地块形状 —— `MapTile` 的子集（这一层不需要地形/归属/形心） */
export interface TileColorSource {
  id: number;
  /** pack 带的**权威**块色；缺席 → 回落 `provinceColorForTileId` 哈希重算 */
  color?: readonly [number, number, number];
}

/**
 * 建颜色查表。撞色的**两边一起丢**（理由见文件头那条红线）。
 *
 * 🔴 **逐块判断用哪条路**，不是整包二选一：pack 允许「一部分地块有色、另一部分没有」
 *    （`color` 是可选格），而按整包挑一条路会让混合包里有色的那些也去走哈希 —— 恰好
 *    丢掉这一格带来的全部好处，且看不出来。
 *
 * 顺带丢掉纯黑：它是「未绘制」的保留色，一个映射到它的地块会让整片没画的区域
 * 变成那一块地的领土。（引擎侧 `coerceMapPack` 已经把坏色打回缺席，所以这里读到的
 * `color` 要么是三个 0-255 的整数、要么没有；万一仍有坏值，`rgbKey` 会把它算成 0，
 * 与纯黑同处置 —— 那也是「丢掉」这一侧。）
 */
export function buildTileColorLookup(tiles: readonly TileColorSource[]): TileColorLookup {
  const byColor = new Map<number, number>();
  const collided = new Set<number>();

  for (const tile of tiles) {
    if (!Number.isFinite(tile.id)) continue;
    const [r, g, b] = tile.color ?? provinceColorForTileId(tile.id);
    const key = rgbKey(r, g, b);
    if (key === 0) continue;
    if (byColor.has(key)) {
      collided.add(key);
      continue;
    }
    byColor.set(key, tile.id);
  }

  for (const key of collided) byColor.delete(key);
  // 撞进同一个键的地块数 = 先到的那一个 + 后来的那些。后来的没入表，故按 2 计下界。
  return { byColor, ambiguous: collided.size * 2 };
}

/** 一块地在栅格里的包围盒 —— 高亮补丁只扫这一小片，不必为每块地留一份像素表（35MB 常驻） */
interface TileBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 该块地的像素数 */
  count: number;
}

/** `decodeProvinceIds` 的产物 —— 常驻内存的只有 `idBuf`（3900×2226 时约 35MB） */
export interface ProvinceRaster {
  w: number;
  h: number;
  /** 每像素一个地块 id；`VOID_TILE` / `UNKNOWN_TILE` 见各自常量 */
  idBuf: Int32Array;
  bounds: ReadonlyMap<number, TileBounds>;
  /** 认不出颜色的像素数（>0 = 图与包很可能不是一套） */
  unknownPixels: number;
}

/** `ImageData` 的结构子集 —— 这样纯函数不必依赖 DOM 类型，测试拿裸对象就能喂 */
export interface RasterPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | number[];
}

/**
 * 整幅 RGBA → `idBuf`（`MapData.decodeProvinces` 的语义半边，去掉了 canvas 那一半）。
 *
 * 🔴 alpha **一概不看**：provinces.png 是无 alpha 的索引/真彩图，而某些导出工具会给它补一层
 *    全不透明的 alpha 通道。按 alpha 过滤会让整张图一个像素都不认（或者反过来）。
 */
export function decodeProvinceIds(src: RasterPixels, lookup: TileColorLookup): ProvinceRaster {
  const w = Math.max(0, Math.floor(src.width));
  const h = Math.max(0, Math.floor(src.height));
  const idBuf = new Int32Array(w * h);
  const bounds = new Map<number, TileBounds>();
  const data = src.data;
  let unknownPixels = 0;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      const o = k * 4;
      const key = rgbKey(data[o], data[o + 1], data[o + 2]);
      if (key === 0) continue; // 纯黑 = 未绘制，保持 VOID_TILE
      const id = lookup.byColor.get(key);
      if (id === undefined) {
        idBuf[k] = UNKNOWN_TILE;
        unknownPixels++;
        continue;
      }
      idBuf[k] = id;
      const box = bounds.get(id);
      if (box === undefined) {
        bounds.set(id, { minX: x, minY: y, maxX: x, maxY: y, count: 1 });
      } else {
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
        box.count++;
      }
    }
  }

  return { w, h, idBuf, bounds, unknownPixels };
}

// ═══════════════════════════════════════════════════════════
// 2. 政治着色
// ═══════════════════════════════════════════════════════════

/**
 * 领土色不透明度 ≈ 39%。
 *
 * 🔴 **底图必须透出来**：这一层压在手绘底图上，画成不透明就等于把美术整个盖掉，
 *    「势力地图」会变成一张色块拼图。sample 页实测这个值是可读性与保留纹理的平衡点。
 */
export const TERRITORY_ALPHA = 100;

/** 天堑（不可通行）比领土重一档，但不至于糊成一片黑 */
export const IMPASSABLE_ALPHA = 148;

/** 天堑底色 / 影线色（石板灰两档，交替画出反向影线 = 一眼与「谁的领土」区分开） */
export const IMPASSABLE_RGB: readonly [number, number, number] = [66, 62, 72];
export const IMPASSABLE_HATCH_RGB: readonly [number, number, number] = [112, 106, 122];

/** 无主之地的中性色（`MapCountry.unclaimed` 为真时也用它 —— 那不是一个势力） */
export const UNCLAIMED_RGB: readonly [number, number, number] = [138, 127, 106];

/** 天堑里掺多少邻主色（CK3 惯例：由占了它最多邻居的那一方着色） */
const IMPASSABLE_TINT_MIX = 0.3;

/** 影线周期与占比（`(x - y) % 6 < 2` = 每 6 像素两条斜线） */
const HATCH_PERIOD = 6;
const HATCH_WIDTH = 2;

/** 「哪一块地画什么色」的判定结果（与写像素分开：前者是包语义，后者是缓冲区操作） */
export interface PoliticalPaint {
  /** tileId → 领土色（水域与天堑不在表里） */
  fillByTile: ReadonlyMap<number, [number, number, number]>;
  /** tileId → 天堑双色 `[底色, 影线色]` */
  hatchByTile: ReadonlyMap<number, [[number, number, number], [number, number, number]]>;
}

function mixRgb(
  base: readonly [number, number, number],
  other: readonly [number, number, number],
  k: number,
): [number, number, number] {
  return [
    Math.round(base[0] * (1 - k) + other[0] * k),
    Math.round(base[1] * (1 - k) + other[1] * k),
    Math.round(base[2] * (1 - k) + other[2] * k),
  ];
}

/** 国家 id → 显示色；`unclaimed` 的那一棵按类型契约用中性色，不画势力色 */
function countryFillMap(pack: MapPack): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  for (const country of pack.countries) {
    const rgb: [number, number, number] = country.unclaimed
      ? [...UNCLAIMED_RGB]
      : [country.color[0], country.color[1], country.color[2]];
    out.set(country.id, rgb);
  }
  return out;
}

/**
 * 包 → 着色判定。
 *
 * 三类地各自的处置：
 *   · 水域（`water !== null`）—— **不着色**。所有权对海面没有意义，而底图的海本来就好看；
 *     盖一层灰蓝只会让海岸线变糊。它仍然在 `idBuf` 里，所以照样能悬停/点选（标「海域/湖泊」）。
 *   · 天堑（`impassable`）—— 石板灰 + 反向影线，并掺三成**邻主色**（占了它最多共享边的那一国）。
 *     纯灰虽然安全但读不出「这道屏障在谁的势力范围内」，而那正是玩家看势力地图要的信息。
 *   · 其余 —— 国家色；无主 / 查不到国家行 → 中性色。
 *
 * 邻主只看 `pack.adjacency`（带共享边像素长）：`straits` 是人工补边、没有边长，
 * 拿 0 权重参与投票只会引入一个永远不会赢却看着像在参与的分支。
 */
export function buildPoliticalPaint(pack: MapPack): PoliticalPaint {
  const countryFill = countryFillMap(pack);
  const fillByTile = new Map<number, [number, number, number]>();
  const hatchByTile = new Map<number, [[number, number, number], [number, number, number]]>();

  const tileById = new Map<number, MapTile>();
  for (const tile of pack.tiles) if (!tileById.has(tile.id)) tileById.set(tile.id, tile);

  const fillOfTile = (tile: MapTile): [number, number, number] => {
    const rgb = tile.countryId === null ? undefined : countryFill.get(tile.countryId);
    return rgb ?? [...UNCLAIMED_RGB];
  };

  for (const tile of tileById.values()) {
    if (tile.water !== null) continue;
    if (tile.impassable) continue;
    fillByTile.set(tile.id, fillOfTile(tile));
  }

  // 天堑 → 邻主投票（按共享边像素长加权；天堑邻居不投票，海面也没有主）
  const tally = new Map<number, Map<string, number>>();
  for (const [a, b, sharedEdgePx] of pack.adjacency) {
    const ta = tileById.get(a);
    const tb = tileById.get(b);
    if (ta === undefined || tb === undefined) continue;
    const weight = Number.isFinite(sharedEdgePx) && sharedEdgePx > 0 ? sharedEdgePx : 0;
    if (weight === 0) continue;
    const vote = (impassableTile: MapTile, voter: MapTile): void => {
      if (!impassableTile.impassable || voter.impassable) return;
      if (voter.countryId === null || voter.water !== null) return;
      let bag = tally.get(impassableTile.id);
      if (bag === undefined) {
        bag = new Map<string, number>();
        tally.set(impassableTile.id, bag);
      }
      bag.set(voter.countryId, (bag.get(voter.countryId) ?? 0) + weight);
    };
    vote(ta, tb);
    vote(tb, ta);
  }

  for (const tile of tileById.values()) {
    if (!tile.impassable) continue;
    const bag = tally.get(tile.id);
    let bestId: string | null = null;
    let bestWeight = 0;
    if (bag !== undefined) {
      // 平局取字典序小的 id —— 稳定即可复现，别让 adjacency 的行序决定颜色
      for (const [countryId, weight] of bag) {
        if (
          weight > bestWeight ||
          (weight === bestWeight && bestId !== null && countryId < bestId)
        ) {
          bestWeight = weight;
          bestId = countryId;
        }
      }
    }
    const owner = bestId === null ? undefined : countryFill.get(bestId);
    if (owner === undefined) {
      hatchByTile.set(tile.id, [[...IMPASSABLE_RGB], [...IMPASSABLE_HATCH_RGB]]);
    } else {
      hatchByTile.set(tile.id, [
        mixRgb(IMPASSABLE_RGB, owner, IMPASSABLE_TINT_MIX),
        mixRgb(IMPASSABLE_HATCH_RGB, owner, IMPASSABLE_TINT_MIX),
      ]);
    }
  }

  return { fillByTile, hatchByTile };
}

/**
 * 整幅着色缓冲（RGBA，可直接灌进 `ctx.createImageData(...).data`）。
 *
 * 🔴 **一次整幅、不分块**：sample 页实测 8.7M 像素约 280ms（含解码），只在页签首次打开时跑
 *    一次。分块渲染要引入「哪块脏了」的账，而这一层的数据在一次页签生命周期里根本不变。
 */
export function buildPoliticalTint(
  raster: ProvinceRaster,
  paint: PoliticalPaint,
): Uint8ClampedArray {
  const { w, h, idBuf } = raster;
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      const id = idBuf[k];
      if (id <= 0) continue; // 未绘制 / 认不出的颜色：一律不着色

      const hatch = paint.hatchByTile.get(id);
      if (hatch !== undefined) {
        const phase = (((x - y) % HATCH_PERIOD) + HATCH_PERIOD) % HATCH_PERIOD;
        const rgb = phase < HATCH_WIDTH ? hatch[1] : hatch[0];
        const o = k * 4;
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = IMPASSABLE_ALPHA;
        continue;
      }

      const fill = paint.fillByTile.get(id);
      if (fill === undefined) continue; // 水域：底图的海自己就够看
      const o = k * 4;
      out[o] = fill[0];
      out[o + 1] = fill[1];
      out[o + 2] = fill[2];
      out[o + 3] = TERRITORY_ALPHA;
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 2b. 着色方式（势力 / 中层 / 地块）
// ═══════════════════════════════════════════════════════════

/**
 * 着色方式。`country` 就是本文件第 2 节那套原样（政治层），另两档是「同一份 idBuf 换一张
 * 颜色表」—— 数据一个字节都没多，只是把哪块地画成什么色重算一遍。
 */
export type MapTintMode = 'country' | 'midTier' | 'tile';

/**
 * 玩家**选的**那一档 —— 比 `MapTintMode` 多一个 `auto`。
 *
 * 🔴 两个类型刻意分开：`auto` 只是「跟着缩放走」这条**策略**，它永远不会被拿去画像素。
 *    合并成一个类型的代价是 `buildModePaint` / `buildLabelsForMode` 都要多一个
 *    「auto 该画什么」的分支，而那个问题在那一层根本没有答案（它们看不见缩放）。
 *    所有渲染路径一律先过 `resolveEffectiveTintMode` 拿到实档。
 */
export type MapTintModeChoice = MapTintMode | 'auto';

/**
 * 中层 id → 显示色，取**它在 `pack.midTiers` 里的序号**喂给 `provinceColorForTileId`。
 *
 * 🔴 **不新写一个哈希**：中层 id 是字符串而那个哈希吃数字，所以要有一步「字符串 → 数字」。
 *    这里用序号而不是自己折一个字符串哈希 —— 后者等于往仓库里加第二个颜色算法，
 *    而这一层要的只是「相邻的中层别撞成一个色」，那个哈希的雪崩已经够了。
 *    代价说清楚：**重编包时在中层列表中间插一个，它后面所有中层会换色**。纯观感，
 *    不影响命中/路线/落位（那些一律走 id），故接受。
 * 序号 +1 是为了避开 0 —— 那个哈希对 0 落在保留色兜底那一支上。
 */
function midTierFillMap(pack: MapPack): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  pack.midTiers.forEach((midTier, index) => {
    if (out.has(midTier.id)) return;
    out.set(midTier.id, provinceColorForTileId(index + 1));
  });
  return out;
}

/**
 * 包 + 着色方式 → 着色判定（喂给 `buildPoliticalTint`，与政治层同一条管道）。
 *
 * 🔴 `country` **原样委托** `buildPoliticalPaint`：势力档必须与加这个开关之前逐像素相同，
 *    而做到这一点的唯一可靠办法是**根本不写第二份实现**（有回归测试钉住这条等价）。
 *
 * 另两档共同的处置（**与势力档刻意不同**，不是漏写）：
 *   · 水域 —— 不着色，同势力档（底图的海本来就好看）。
 *   · 天堑 —— **也不着色**，而势力档给它影线。影线回答的是「这道屏障在谁的势力范围内」，
 *     那是势力档的问题；在「中层 / 地块」两档里它只会盖掉那块地自己的颜色和名字标签。
 *   · 没有中层的陆块 —— 走无主之地那个中性色（同势力档对无主的处置），**不是留空**：
 *     留空会让一整片陆地看起来和没画的空白/海面一样。
 */
export function buildModePaint(pack: MapPack, mode: MapTintMode): PoliticalPaint {
  if (mode === 'country') return buildPoliticalPaint(pack);

  const midTierFill = mode === 'midTier' ? midTierFillMap(pack) : null;
  const neutral: [number, number, number] = [...UNCLAIMED_RGB];
  const fillByTile = new Map<number, [number, number, number]>();
  const seen = new Set<number>();

  for (const tile of pack.tiles) {
    if (seen.has(tile.id)) continue;
    seen.add(tile.id);
    if (tile.water !== null || tile.impassable) continue;

    if (midTierFill === null) {
      // 地块档：pack 带的**权威**块色优先，缺席才回落哈希（同文件头那条红线）
      fillByTile.set(tile.id, tile.color ?? provinceColorForTileId(tile.id));
      continue;
    }
    const rgb = tile.midTierId === null ? undefined : midTierFill.get(tile.midTierId);
    fillByTile.set(tile.id, rgb ?? neutral);
  }

  // 两档都没有天堑影线（理由见上）—— 空表即「一块也不画影线」
  return { fillByTile, hatchByTile: new Map() };
}

// ═══════════════════════════════════════════════════════════
// 2c. 地块名标签
// ═══════════════════════════════════════════════════════════

/**
 * 一个地图标签的落点（世界坐标 = 栅格坐标，见 `tileAtRasterPoint`）。
 *
 * `key` 是**渲染用的稳定键**，不是业务 id：两档标签的粒度不同（地块 / 中层），
 * 各自的 id 空间会撞号（地块 id 是数字、中层 id 是字符串），所以在这里就带上前缀分家。
 */
export interface MapLabel {
  key: string;
  name: string;
  x: number;
  y: number;
}

/**
 * 标签起显阈值，按 `view.min` 的倍数（不是绝对缩放）。
 *
 * 🔴 **单一阈值，刻意不做逐标签避让**：几百个标签两两测碰撞是每帧一次的活，而它换来的
 *    只是「缩小时也能看见几个名字」—— 那时候真正有用的信息是疆域形状，不是地名。
 *    低于阈值一律不画，高于阈值全画（重叠由玩家自己放大解决）。
 */
export const LABEL_MIN_ZOOM_OVER_MIN = 1.5;

/** 当前缩放该不该画标签（阈值口径唯一一处，组件不自己写这个不等式） */
export function labelsVisibleAtZoom(view: StageView): boolean {
  if (!Number.isFinite(view.s) || !Number.isFinite(view.min) || view.min <= 0) return false;
  return view.s >= view.min * LABEL_MIN_ZOOM_OVER_MIN;
}

/**
 * 自动档升到「地块」的阈值（= fit 下限的 4.5 倍）。
 *
 * 取值依据是**真包实测**而不是手感：310 块地的名字在这个缩放下视口里约剩四十来个，
 * 再往下缩就开始糊成一团（ratio≈2 时实测视口内有 265 个）。**刻意不做迟滞**：
 * 来回跨阈值会重烘一次着色（约 100ms），而加一段迟滞带换来的是「同一个缩放下
 * 显示的东西取决于你是放大还是缩小过来的」—— 那个不一致比偶尔多烘一次更难解释。
 */
export const AUTO_TILE_ZOOM_OVER_MIN = 4.5;

/**
 * 玩家选的档 → **实际用来画的档**。
 *
 * 手动三档原样返回（`auto` 之外的一切都是显式覆盖，不受缩放影响）。
 * `auto` 按 `view.s / view.min` 分三段，粒度跟着缩放走（CK3 的口径）：
 * 缩得很小时看势力连片，放大到能读名字了给中层，再放大给地块。
 * 视图退化（未布局，`min <= 0`）时给 `country` —— 那是最粗的一档，也是原先的默认。
 */
export function resolveEffectiveTintMode(mode: MapTintModeChoice, view: StageView): MapTintMode {
  if (mode !== 'auto') return mode;
  if (!Number.isFinite(view.s) || !Number.isFinite(view.min) || view.min <= 0) return 'country';
  const ratio = view.s / view.min;
  if (ratio >= AUTO_TILE_ZOOM_OVER_MIN) return 'tile';
  // 🔴 中层档阈值**就是标签起显阈值本身**，不是一个碰巧相等的数：自动档在这一档同时
  //    开始画中层色与中层名，两者必须同时发生 —— 差一点点就会出现「变了色却没有名字」
  //    （或反过来）的一小段缩放区间。所以直接引用它，而不是再写一个 1.5。
  if (ratio >= LABEL_MIN_ZOOM_OVER_MIN) return 'midTier';
  return 'country';
}

/**
 * 形心坐标系 → 世界（栅格）坐标系的比例。
 *
 * 形心存在 `pack.resolution` 那个坐标系里，而实际栅格未必同尺寸（理论相等但不假设），
 * 所以照 `MapPoliticalTab.tileWorldPoint` 的同一个比例折算。
 */
function rasterScale(pack: MapPack, rasterW: number, rasterH: number): { sx: number; sy: number } {
  const res = pack.resolution;
  return {
    sx: res.w > 0 && rasterW > 0 ? rasterW / res.w : 1,
    sy: res.h > 0 && rasterH > 0 ? rasterH / res.h : 1,
  };
}

/**
 * 包 → 地块名标签表（形心落点）。
 * 没名字的地块跳过 —— 画一个空标签只会占住位置。
 */
export function buildTileLabels(pack: MapPack, rasterW: number, rasterH: number): MapLabel[] {
  const { sx, sy } = rasterScale(pack, rasterW, rasterH);

  const out: MapLabel[] = [];
  const seen = new Set<number>();
  for (const tile of pack.tiles) {
    if (seen.has(tile.id)) continue;
    seen.add(tile.id);
    const name = typeof tile.name === 'string' ? tile.name.trim() : '';
    if (name.length === 0) continue;
    const [cx, cy] = tile.centroid;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    out.push({ key: `t${tile.id}`, name, x: cx * sx, y: cy * sy });
  }
  return out;
}

/**
 * 包 → **中层名**标签表：一个中层**一个**标签（不是它辖下每块地一个）。
 *
 * 🔴 中层档标中层名、地块档标地块名 —— 两档标签的**粒度跟着着色粒度走**。
 *    中层档把 45 个域各染一色，再往上撒 310 个地块名，读者要从颜色数名字、
 *    从名字数颜色，两边都对不上。
 *
 * 落点两条路（**锚地块优先**）：
 *   · `anchorTileId` 指得到一块地 → 用那块地的形心。它是编译期选出来的首府/代表块，
 *     比几何平均更像「这个域在人们心里的位置」。
 *   · 否则 → 成员地块形心的**按面积加权**平均。不加权的话，一个域里若有一堆小碎块和
 *     一块巨大的主体，标签会被碎块拽到主体外面去（甚至落进邻国）。
 *     面积全是 0 / 非法时退回等权平均，而不是产出 NaN。
 * **没有成员地块的中层不出标签**（真包里就有几个这样的空壳）：它在图上没有任何疆域，
 * 给它找个位置画上去等于凭空指认一块别人的地。名字为空同理。
 */
export function buildMidTierLabels(pack: MapPack, rasterW: number, rasterH: number): MapLabel[] {
  const { sx, sy } = rasterScale(pack, rasterW, rasterH);

  const tileById = new Map<number, MapTile>();
  for (const tile of pack.tiles) if (!tileById.has(tile.id)) tileById.set(tile.id, tile);

  /**
   * 中层 id → 成员地块累计（一趟扫完，不给每个中层各扫一遍地块表）。
   * 加权和与朴素和**同时**累计：面积全为 0 时才用后者，判断在扫完之后。
   */
  interface MemberSum {
    /** 面积加权的形心和 */
    wx: number;
    wy: number;
    /** 面积和（= 加权分母） */
    w: number;
    /** 等权兜底用的朴素形心和 */
    px: number;
    py: number;
    /** 成员块数（= 等权分母） */
    n: number;
  }
  const members = new Map<string, MemberSum>();
  for (const tile of tileById.values()) {
    if (tile.midTierId === null) continue;
    const [cx, cy] = tile.centroid;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const area = Number.isFinite(tile.areaPx) && tile.areaPx > 0 ? tile.areaPx : 0;
    let bag = members.get(tile.midTierId);
    if (bag === undefined) {
      bag = { wx: 0, wy: 0, w: 0, px: 0, py: 0, n: 0 };
      members.set(tile.midTierId, bag);
    }
    bag.wx += cx * area;
    bag.wy += cy * area;
    bag.w += area;
    bag.px += cx;
    bag.py += cy;
    bag.n += 1;
  }

  const out: MapLabel[] = [];
  const seen = new Set<string>();
  for (const midTier of pack.midTiers) {
    if (seen.has(midTier.id)) continue;
    seen.add(midTier.id);
    const name = typeof midTier.name === 'string' ? midTier.name.trim() : '';
    if (name.length === 0) continue;

    const bag = members.get(midTier.id);
    if (bag === undefined || bag.n === 0) continue; // 空壳中层：图上没有它的地

    const anchor = midTier.anchorTileId === null ? undefined : tileById.get(midTier.anchorTileId);
    let cx: number;
    let cy: number;
    if (anchor !== undefined && Number.isFinite(anchor.centroid[0])) {
      cx = anchor.centroid[0];
      cy = anchor.centroid[1];
    } else if (bag.w > 0) {
      cx = bag.wx / bag.w;
      cy = bag.wy / bag.w;
    } else {
      cx = bag.px / bag.n;
      cy = bag.py / bag.n;
    }
    out.push({ key: `m${midTier.id}`, name, x: cx * sx, y: cy * sy });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 2d. 世界坐标落点（棋子 / 路线折线 / 途经点）
// ═══════════════════════════════════════════════════════════

/** 世界（栅格）坐标系上的一个点 */
export interface MapPoint {
  x: number;
  y: number;
}

/**
 * 地块 → 形心的世界坐标（查不到 / 形心非法 → null）。
 *
 * 🔴 **必须过 `rasterScale`**：形心存在 `pack.resolution` 坐标系里，而世界盒是实际栅格。
 *    两者理论相等，但直接拿形心当世界坐标的代价是「棋子和路线整体偏移」——
 *    偏得不多的时候看着只是「画得不太准」，没人会怀疑是坐标系错了。
 */
export function tileCentroidWorld(
  pack: MapPack,
  tileId: number,
  rasterW: number,
  rasterH: number,
): MapPoint | null {
  const tile = pack.tiles.find((t) => t.id === tileId);
  if (tile === undefined) return null;
  const [cx, cy] = tile.centroid;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const { sx, sy } = rasterScale(pack, rasterW, rasterH);
  return { x: cx * sx, y: cy * sy };
}

/**
 * 路线地块序列 → 折线顶点（按 `tilePath` 的**顺序**，这是一条路不是一堆点）。
 *
 * 查不到的地块**跳过而不是中断**：路线本身由 `findPath` 在引擎侧算出，能出现在
 * `tilePath` 里就说明它在图里；真出现查不到的（包与图不同版）时，画一条略抄近路的线
 * 也远好过整条路线消失 —— 后者会让玩家以为「没有路」。
 */
export function buildRoutePolyline(
  pack: MapPack,
  tilePath: readonly number[],
  rasterW: number,
  rasterH: number,
): MapPoint[] {
  const out: MapPoint[] = [];
  for (const tileId of tilePath) {
    const point = tileCentroidWorld(pack, tileId, rasterW, rasterH);
    if (point !== null) out.push(point);
  }
  return out;
}

/** 世界坐标 → 屏幕（视口）坐标：先按缩放放大，再加上世界层的位移 */
export function projectToScreen(point: MapPoint, view: StageView): MapPoint {
  return { x: point.x * view.s + view.x, y: point.y * view.s + view.y };
}

/**
 * 视口外多留这么多像素才裁掉 —— 标签是**按中心点**裁的，而它本身有宽度，
 * 贴边那些的中心点已经出界、字却还该露半个。
 */
const LABEL_CULL_MARGIN_PX = 96;

/**
 * 标签（世界坐标）→ **屏幕坐标**，并裁掉视口外的。
 *
 * 🔴 标签之所以要投影到屏幕空间而不是跟着世界层缩放（2026-08-12 真机）：
 *    Chromium 对**巨大合成层**的栅格化倍率有上限，超过之后它是把已有栅格**拉大**的。
 *    于是住在那一层里的文字，无论字号怎么反缩放，都会以偏小的分辨率栅格化再被放大 ——
 *    深缩放下字必糊，而且**字号技巧一个都救不了**（问题出在层的栅格，不在字号）。
 *    搬进不缩放的屏幕层之后，12px 就是真的 12px，任何缩放下都锐利，这是构造保证的。
 * 🔴 顺带解决 DOM 规模：深缩放时 310 个标签里绝大多数在视口外，裁掉之后
 *    DOM 里只留看得见的那些（真包实测约 100 个以内）。
 *
 * 视口尺寸**显式传入**而不是在这里读 DOM：这一层不碰 DOM（jsdom 里视口恒为 0×0，
 * 测试得能自己给真实数字）。
 */
export function projectLabelsToScreen(
  labels: readonly MapLabel[],
  view: StageView,
  viewportW: number,
  viewportH: number,
  margin: number = LABEL_CULL_MARGIN_PX,
): MapLabel[] {
  const out: MapLabel[] = [];
  for (const label of labels) {
    const p = projectToScreen(label, view);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < -margin || p.x > viewportW + margin) continue;
    if (p.y < -margin || p.y > viewportH + margin) continue;
    out.push({ key: label.key, name: label.name, x: p.x, y: p.y });
  }
  return out;
}

/** 折线顶点 → SVG `points` 属性串（空/单点 → 空串，调用方据此不渲染） */
export function formatPolylinePoints(points: readonly MapPoint[]): string {
  if (points.length < 2) return '';
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** 落在路线上的一个途经点 */
export interface RouteWaypoint extends MapPoint {
  tileId: number;
}

/**
 * 途经点标记：`via` 里**真的落在这条路线上**的那些。
 *
 * 🔴 判据是「在 `tilePath` 里」而不是「玩家点过它」：`findPath` 的 via 是**软约束**
 *    （绕不过去时它会给一条不经过的路），照 `viaTileIds` 原样画会在一条根本没经过的
 *    地块上点一个「途经」标记 —— 地图在这里会撒一个看不出来的谎。
 * 顺序跟着路线走（不是玩家的点选顺序），这样标记读起来就是「先经过谁、后经过谁」。
 */
export function buildRouteWaypoints(
  pack: MapPack,
  tilePath: readonly number[],
  viaTileIds: readonly number[],
  rasterW: number,
  rasterH: number,
): RouteWaypoint[] {
  const via = new Set(viaTileIds);
  const out: RouteWaypoint[] = [];
  const seen = new Set<number>();
  for (const tileId of tilePath) {
    if (!via.has(tileId) || seen.has(tileId)) continue;
    seen.add(tileId);
    const point = tileCentroidWorld(pack, tileId, rasterW, rasterH);
    if (point !== null) out.push({ tileId, x: point.x, y: point.y });
  }
  return out;
}

/**
 * 当前着色档该画哪一批标签（**唯一**入口，组件不自己挑）。
 *
 * 势力档不画：那一档要看的是疆域连片，撒上名字只会盖住它。
 */
export function buildLabelsForMode(
  pack: MapPack,
  mode: MapTintMode,
  rasterW: number,
  rasterH: number,
): MapLabel[] {
  if (mode === 'country') return [];
  if (mode === 'midTier') return buildMidTierLabels(pack, rasterW, rasterH);
  return buildTileLabels(pack, rasterW, rasterH);
}

// ═══════════════════════════════════════════════════════════
// 3. 边界折线（栅格 → 单位段 → 链化 → RDP → SVG path）
// ═══════════════════════════════════════════════════════════

/** 描边分类键：水域与未绘制同档（海岸线画在它与陆地之间） */
export const TRACE_WATER = -3;
/** 天堑：国界在它这里终止，所以它有自己的线型（虚线 = 不可通行） */
export const TRACE_IMPASSABLE = -4;
/** 无主之地 */
export const TRACE_UNCLAIMED = -1;

/** RDP 简化容差（栅格像素）—— sample 页实测值。`buildBorderPaths` 的默认参数，不对外导出 */
const RDP_EPSILON = 1.25;

/** 四类边界各自一条 path 的 `d` 串（空串 = 这一类没有边界，SVG 照样合法） */
export interface BorderPaths {
  /** 同一势力内部的块界 */
  province: string;
  /** 国界（含无主↔有主） */
  national: string;
  /** 海岸线（陆↔水/未绘制） */
  coast: string;
  /** 天堑轮廓 */
  impassable: string;
}

/**
 * tileId → 描边分类键。
 *
 * 国家用**序号**而不是 id 串：`keyBuf` 是 Int32Array（8.7M 项），存不下字符串，
 * 而这一层只需要「两边是不是同一类」这个判断。
 */
export function buildTraceKeys(pack: MapPack): Map<number, number> {
  const countryIndex = new Map<string, number>();
  for (const country of pack.countries) {
    if (country.unclaimed) continue; // 无主统一走 TRACE_UNCLAIMED，别给它编号
    if (!countryIndex.has(country.id)) countryIndex.set(country.id, countryIndex.size);
  }

  const out = new Map<number, number>();
  for (const tile of pack.tiles) {
    if (out.has(tile.id)) continue;
    if (tile.impassable) {
      out.set(tile.id, TRACE_IMPASSABLE);
      continue;
    }
    if (tile.water !== null) {
      out.set(tile.id, TRACE_WATER);
      continue;
    }
    const idx = tile.countryId === null ? undefined : countryIndex.get(tile.countryId);
    out.set(tile.id, idx === undefined ? TRACE_UNCLAIMED : idx);
  }
  return out;
}

type BorderKind = 'province' | 'national' | 'coast' | 'impassable';

/** 单位段表：角点栅格 `(w+1) × (h+1)` 上的无向邻接 */
type SegmentMap = Map<number, number[]>;

function classifyBorder(keyA: number, keyB: number, idA: number, idB: number): BorderKind | null {
  if (keyA === keyB && idA === idB) return null;
  if (keyA === TRACE_WATER && keyB === TRACE_WATER) return null;
  if (keyA === TRACE_WATER || keyB === TRACE_WATER) return 'coast';
  // 天堑内部不画块界：整片山是一道屏障，画满细线只会糊成一团
  if (keyA === TRACE_IMPASSABLE && keyB === TRACE_IMPASSABLE) return null;
  if (keyA === TRACE_IMPASSABLE || keyB === TRACE_IMPASSABLE) return 'impassable';
  if (keyA !== keyB) return 'national';
  return 'province';
}

/**
 * Douglas-Peucker 简化。
 *
 * 🔴 **闭合环要先钉中点**：海岸线与整圈国界的首尾是同一个点，RDP 的基线退化成一个点，
 *    于是所有偏差都算成 0，整个环塌缩成两个重合点 —— 表现是「某个岛的海岸线消失了」。
 *    钉住中点把环拆成两段开链即可。
 */
function simplifyChain(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack: [number, number][] = [];
  const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) {
    const mid = pts.length >> 1;
    keep[mid] = 1;
    stack.push([0, mid], [mid, pts.length - 1]);
  } else {
    stack.push([0, pts.length - 1]);
  }

  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [s, e] = span;
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let mi = -1;
    let md = 0;
    for (let k = s + 1; k < e; k++) {
      const d = Math.abs((pts[k][0] - x1) * dy - (pts[k][1] - y1) * dx) / len;
      if (d > md) {
        md = d;
        mi = k;
      }
    }
    if (md > eps && mi > s) {
      keep[mi] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }

  return pts.filter((_, k) => keep[k] === 1);
}

/** 单位段 → 链 → 简化 → 一条 path 的 `d` 串 */
function pathOfSegments(map: SegmentMap, cornerStride: number, eps: number): string {
  const used = new Set<string>();
  const segKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  let d = '';

  map.forEach((neighbors, start) => {
    for (const first of neighbors) {
      if (used.has(segKey(start, first))) continue;
      const chain = [start];
      let cur = first;
      used.add(segKey(start, cur));
      chain.push(cur);
      for (;;) {
        const list = map.get(cur);
        const next = list?.find((c) => !used.has(segKey(cur, c)));
        if (next === undefined) break;
        used.add(segKey(cur, next));
        chain.push(next);
        cur = next;
      }
      const pts = simplifyChain(
        chain.map((c): [number, number] => [c % cornerStride, Math.floor(c / cornerStride)]),
        eps,
      );
      d += 'M' + pts.map((p) => `${p[0]} ${p[1]}`).join('L');
    }
  });

  return d;
}

/**
 * 栅格 → 四类边界折线。
 *
 * `traceKeys` 由 `buildTraceKeys` 给。未绘制/认不出的像素一律读作 `TRACE_WATER` ——
 * 它们在图上就是「没有归属的空白」，与海同处置（于是会被描一条海岸线，那是对的）。
 */
export function buildBorderPaths(
  raster: ProvinceRaster,
  traceKeys: ReadonlyMap<number, number>,
  eps: number = RDP_EPSILON,
): BorderPaths {
  const { w, h, idBuf } = raster;
  if (w <= 0 || h <= 0) return { province: '', national: '', coast: '', impassable: '' };

  const keyBuf = new Int32Array(w * h);
  for (let k = 0; k < keyBuf.length; k++) {
    const id = idBuf[k];
    keyBuf[k] = id <= 0 ? TRACE_WATER : (traceKeys.get(id) ?? TRACE_UNCLAIMED);
  }

  const cornerStride = w + 1;
  const maps: Record<BorderKind, SegmentMap> = {
    province: new Map(),
    national: new Map(),
    coast: new Map(),
    impassable: new Map(),
  };
  const addSeg = (map: SegmentMap, a: number, b: number): void => {
    let la = map.get(a);
    if (la === undefined) {
      la = [];
      map.set(a, la);
    }
    la.push(b);
    let lb = map.get(b);
    if (lb === undefined) {
      lb = [];
      map.set(b, lb);
    }
    lb.push(a);
  };

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (x + 1 < w) {
        const kind = classifyBorder(keyBuf[i], keyBuf[i + 1], idBuf[i], idBuf[i + 1]);
        // 竖直单位段：像素 x 与 x+1 之间那条边
        if (kind !== null)
          addSeg(maps[kind], y * cornerStride + x + 1, (y + 1) * cornerStride + x + 1);
      }
      if (y + 1 < h) {
        const kind = classifyBorder(keyBuf[i], keyBuf[i + w], idBuf[i], idBuf[i + w]);
        // 水平单位段：像素 y 与 y+1 之间那条边
        if (kind !== null)
          addSeg(maps[kind], (y + 1) * cornerStride + x, (y + 1) * cornerStride + x + 1);
      }
    }
  }

  return {
    province: pathOfSegments(maps.province, cornerStride, eps),
    national: pathOfSegments(maps.national, cornerStride, eps),
    coast: pathOfSegments(maps.coast, cornerStride, eps),
    impassable: pathOfSegments(maps.impassable, cornerStride, eps),
  };
}

// ═══════════════════════════════════════════════════════════
// 4. 命中检测与高亮补丁
// ═══════════════════════════════════════════════════════════

/**
 * 栅格坐标 → 地块 id（`> 0` 才是一块地）。
 *
 * 世界坐标系**就是**栅格坐标系（世界盒 = provinces.png 尺寸，底图拉伸铺满），
 * 所以这里不做任何比例换算 —— 少一个会写反的乘除。
 */
export function tileAtRasterPoint(raster: ProvinceRaster, x: number, y: number): number {
  const px = Math.round(x);
  const py = Math.round(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return VOID_TILE;
  if (px < 0 || py < 0 || px >= raster.w || py >= raster.h) return VOID_TILE;
  return raster.idBuf[py * raster.w + px];
}

/** 高亮像素补丁（按包围盒裁剪，直接 `putImageData(patch, x, y)`） */
export interface HighlightPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/**
 * 一批地块 → **一份**高亮补丁（悬停 / 选中 / 路线 / 途经 / 回避共用一次绘制）。
 *
 * 🔴 **必须是一份，不能一块一份**：`putImageData` 是**覆盖**不是混合 —— 逐块 put 时，
 *    后一块的矩形会把前一块落在同一矩形内的像素**清成透明**（两块地的像素不重叠，但它们的
 *    包围盒重叠）。表现是「路线上的高亮少了几段」，且只在地块彼此靠近时出现。
 * 🔴 **不出一张整幅的高亮图**：整幅 RGBA 是 35MB，而悬停每动一下就换一次 ——
 *    每次分配一张就是每次 35MB 垃圾。所以取这一批地块的**并集包围盒**：悬停只有一块（很小），
 *    整条路线才会大，而路线只在玩家显式操作时才变。
 * 🔴 **也不预存每块地的像素表**（sample 页那份 CSR 是又一份 35MB 常驻）：
 *    包围盒内按 `idBuf` 复查是等价的。
 *
 * 同一块地出现在多个集合里时由调用方决定最终色（`colorByTile` 后写的赢）——
 * 「选中的那一块同时在路线上」该画哪个色是界面语义，不是这一层该猜的。
 */
export function buildHighlightPatch(
  raster: ProvinceRaster,
  colorByTile: ReadonlyMap<number, readonly [number, number, number, number]>,
): HighlightPatch | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const tileId of colorByTile.keys()) {
    if (tileId <= 0) continue;
    const box = raster.bounds.get(tileId);
    if (box === undefined) continue;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw <= 0 || bh <= 0) return null;

  const data = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    const srcRow = (minY + y) * raster.w + minX;
    const dstRow = y * bw;
    for (let x = 0; x < bw; x++) {
      const rgba = colorByTile.get(raster.idBuf[srcRow + x]);
      if (rgba === undefined) continue;
      const o = (dstRow + x) * 4;
      data[o] = rgba[0];
      data[o + 1] = rgba[1];
      data[o + 2] = rgba[2];
      data[o + 3] = rgba[3];
    }
  }

  return { x: minX, y: minY, w: bw, h: bh, data };
}

// ═══════════════════════════════════════════════════════════
// 5. 平移缩放（纯变换数学）
// ═══════════════════════════════════════════════════════════

/** 视图状态：`s` 缩放、`x`/`y` 世界原点在视口里的像素位移 */
export interface StageView {
  s: number;
  x: number;
  y: number;
  min: number;
  max: number;
}

/** 缩放上限按「fit 的多少倍」定，而不是写死倍数（sample 页的实测口径） */
const MAX_ZOOM_OVER_FIT = 24;
const MIN_ABS_ZOOM = 2;
/** 下限略小于 fit，留一点「看得见全图边缘」的余量 */
const MIN_ZOOM_UNDER_FIT = 0.9;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** 视口/世界尺寸退化（0 宽高、未布局）时的安全视图 —— 绝不产出 NaN */
const DEGENERATE_VIEW: StageView = { s: 1, x: 0, y: 0, min: 1, max: 1 };

function usable(vw: number, vh: number, worldW: number, worldH: number): boolean {
  return (
    Number.isFinite(vw) &&
    Number.isFinite(vh) &&
    vw > 0 &&
    vh > 0 &&
    Number.isFinite(worldW) &&
    Number.isFinite(worldH) &&
    worldW > 0 &&
    worldH > 0
  );
}

/** 平移夹逼：世界比视口小就居中，否则不许露出空白边 */
export function clampStageView(
  view: StageView,
  vw: number,
  vh: number,
  worldW: number,
  worldH: number,
): StageView {
  if (!usable(vw, vh, worldW, worldH)) return { ...view };
  const w = worldW * view.s;
  const h = worldH * view.s;
  return {
    ...view,
    x: w <= vw ? (vw - w) / 2 : clamp(view.x, vw - w, 0),
    y: h <= vh ? (vh - h) / 2 : clamp(view.y, vh - h, 0),
  };
}

/** 整图入画（也是 `min`/`max` 的产出处） */
export function fitStageView(vw: number, vh: number, worldW: number, worldH: number): StageView {
  if (!usable(vw, vh, worldW, worldH)) return { ...DEGENERATE_VIEW };
  const s = Math.min(vw / worldW, vh / worldH);
  return {
    s,
    x: (vw - worldW * s) / 2,
    y: (vh - worldH * s) / 2,
    min: s * MIN_ZOOM_UNDER_FIT,
    max: Math.max(MIN_ABS_ZOOM, s * MAX_ZOOM_OVER_FIT),
  };
}

/**
 * 以视口内 `(px, py)` 为锚点缩放。
 *
 * 🔴 锚点公式必须**先算新位移再写 `s`**：反过来写（先改 s 再用新 s 算 x）会让光标下的
 *    那一点每次滚轮都漂一小截，而每一步都「看着差不多」。
 */
export function zoomStageView(
  view: StageView,
  px: number,
  py: number,
  factor: number,
  vw: number,
  vh: number,
  worldW: number,
  worldH: number,
): StageView {
  if (!Number.isFinite(factor) || factor <= 0) return { ...view };
  const ns = clamp(view.s * factor, view.min, view.max);
  if (ns === view.s) return { ...view };
  const ratio = ns / view.s;
  const next: StageView = {
    ...view,
    s: ns,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
  };
  return clampStageView(next, vw, vh, worldW, worldH);
}

/** 视口内偏移坐标 → 世界坐标 */
export function stagePointToWorld(
  view: StageView,
  offsetX: number,
  offsetY: number,
): { wx: number; wy: number } {
  const s = view.s || 1;
  return { wx: (offsetX - view.x) / s, wy: (offsetY - view.y) / s };
}

/** 把世界坐标 `(wx, wy)` 推到视口中心（`scale` 缺省 = 保持当前缩放） */
export function centerStageView(
  view: StageView,
  wx: number,
  wy: number,
  vw: number,
  vh: number,
  worldW: number,
  worldH: number,
  scale?: number,
): StageView {
  if (!usable(vw, vh, worldW, worldH)) return { ...view };
  const s = scale === undefined ? view.s : clamp(scale, view.min, view.max);
  return clampStageView(
    { ...view, s, x: vw / 2 - wx * s, y: vh / 2 - wy * s },
    vw,
    vh,
    worldW,
    worldH,
  );
}

/** 取景到一组世界坐标点的包围盒（留白后按短边定缩放）；不足两点退化为定点近观 */
export function frameStageOnPoints(
  view: StageView,
  points: readonly (readonly [number, number])[],
  vw: number,
  vh: number,
  worldW: number,
  worldH: number,
): StageView {
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length === 0 || !usable(vw, vh, worldW, worldH)) return { ...view };

  const fitS = Math.min(vw / worldW, vh / worldH);
  if (valid.length === 1) {
    return centerStageView(
      view,
      valid[0][0],
      valid[0][1],
      vw,
      vh,
      worldW,
      worldH,
      Math.min(view.max, fitS * 2.6),
    );
  }

  const xs = valid.map((p) => p[0]);
  const ys = valid.map((p) => p[1]);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const padX = Math.max((x1 - x0) * 0.22, worldW * 0.04);
  const padY = Math.max((y1 - y0) * 0.22, worldH * 0.04);
  x0 -= padX;
  x1 += padX;
  y0 -= padY;
  y1 += padY;
  const s = Math.min(vw / (x1 - x0), vh / (y1 - y0));
  return centerStageView(
    view,
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    vw,
    vh,
    worldW,
    worldH,
    Math.min(s, fitS * 4.5, view.max),
  );
}

// ═══════════════════════════════════════════════════════════
// 6. 展示投影（信息卡 / 提示气泡）
// ═══════════════════════════════════════════════════════════

/** 信息卡与悬停气泡共用的一份地块展示投影 */
export interface TileView {
  tileId: number;
  name: string;
  /** 国家名；无主 / 查不到国家行 → null（界面显示「无主之地」由模板决定，不在这里写死） */
  countryName: string | null;
  midTierName: string | null;
  /** 地形（pack 词汇原文；包没写就是空串） */
  terrain: string;
  impassable: boolean;
  /** 水域标签；陆块 → null */
  waterLabel: '海域' | '湖泊' | null;
}

/**
 * tileId → 展示投影（**唯一**一处，气泡与信息卡共用）。
 *
 * 各写一份的下场是「气泡说这是南岸城邦的，卡片说无主」—— 两处都不报错，
 * 而玩家会以为地图坏了。国家/中层一律走 `map-index` 的链查询（地块自有所有者优先）。
 */
export function describeTile(index: MapIndex, tileId: number): TileView | null {
  const tile = index.tileById.get(tileId);
  if (tile === undefined) return null;
  const country = countryOfTile(index, tileId);
  const midTier = midTierOfTile(index, tileId);
  return {
    tileId,
    name: tile.name,
    countryName: country === null ? null : country.name,
    midTierName: midTier === null ? null : midTier.name,
    terrain: tile.terrain,
    impassable: tile.impassable,
    waterLabel: tile.water === 'sea' ? '海域' : tile.water === 'lake' ? '湖泊' : null,
  };
}

/** 地块名（查不到 → null）—— 出发指令与在途行都按名字说话，永不露 tileId（§8.3） */
export function tileNameOf(index: MapIndex, tileId: number | null | undefined): string | null {
  if (tileId === null || tileId === undefined) return null;
  const tile = index.tileById.get(tileId);
  return tile === undefined ? null : tile.name;
}

// ═══════════════════════════════════════════════════════════
// 7. 「出发」指令（§8.2 / 裁定 §12-7 附加）
// ═══════════════════════════════════════════════════════════

export interface DepartureDirectiveInput {
  /** 目的地块名 */
  destination: string;
  /** 途经点名（顺序有意义） */
  via?: readonly string[];
  /** 回避地块名 */
  avoid?: readonly string[];
  /** 天数估算；`null` / 0 → 不写这一句（宁可不说，也别说「约 0 天」） */
  days?: number | null;
}

/**
 * 一种出行方式下的天数估算：在**取整前**的路线时间上乘倍率，再走与 `findPath` 相同的
 * 「含边至少 1 天、原地 0 天」口径。对取整后的 `days` 乘倍率会放大取整误差
 * （1.3 天的路 ceil 成 2 再 ×2 = 4 天，而真值是 ceil(2.6) = 3 天）。
 */
export function estimateModeDays(
  route: Pick<MapRoute, 'timeDays' | 'tilePath'>,
  factor: number,
): number {
  if (!Number.isFinite(factor) || factor <= 0) return 0;
  if (route.tilePath.length <= 1) return 0;
  return Math.max(1, Math.ceil(route.timeDays * factor));
}

function cleanNames(list: readonly string[] | undefined): string[] {
  if (list === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 「出发」= 一句写给 story 的中文指令，**并入下一条用户消息**（§8.2 那句
 * 「不开第二条写路径」）。
 *
 * 🔴 **一律按名字说话，永不出现 tileId**（§8.3）。
 * 🔴 **不自动发送**：它只被填进输入框，由玩家自己按发送 —— 玩家可以改措辞、也可以反悔。
 *    自动发送等于让一次误点消耗一个回合。
 * 空子句整段省略（没有途经点时不该出现一个空的「取道」）。目的地为空 → 空串，
 * 调用方据此不做任何事。
 */
export function composeDepartureDirective(input: DepartureDirectiveInput): string {
  const destination = typeof input.destination === 'string' ? input.destination.trim() : '';
  if (destination.length === 0) return '';

  const via = cleanNames(input.via);
  const avoid = cleanNames(input.avoid);
  const days =
    typeof input.days === 'number' && Number.isFinite(input.days)
      ? Math.max(0, Math.round(input.days))
      : 0;

  // 出行方式刻意不进指令（2026-08-13 主人裁定）：方式行是给玩家的纯参考，
  // 要坐什么由玩家在输入框自己写 —— 指令是可编辑文本，不替玩家做这个决定。
  let text = `【地图】玩家决定启程前往${destination}`;
  if (via.length > 0) text += `，取道${via.join('、')}`;
  if (avoid.length > 0) text += `，避开${avoid.join('、')}`;
  if (days > 0) text += `，约 ${days} 天`;
  return text;
}
