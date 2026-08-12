/**
 * map-provinces-raster.ts — `provinces.png` → `idBuf` 的**唯一** canvas 接触点（地图 v1 / §9）
 *
 * 装什么: 取字节（fetch）→ 解码成位图 → 画进离屏画布 → `getImageData` → 交给
 *         `map-political.decodeProvinceIds` 出 `ProvinceRaster`。
 * 不装什么: 任何判定与任何绘制。着色 / 描边 / 命中 / 变换全在 `map-political.ts`（纯函数），
 *           状态与生命周期在 `composables/useMapPolitical.ts`。
 *
 * 为什么单独一个文件: jsdom **没有 2D 上下文**（本仓没装 `canvas` 包），所以组件测试不可能
 * 走真解码。把这一步单独关进一个模块，测试就能 `vi.mock` 掉它、灌一份合成栅格进去 ——
 * 而不必给组件加一个只为测试存在的注入参数（那种参数生产代码里永远是 undefined，
 * 于是「注入的那条路」其实从没被生产走过）。
 *
 * 🔴 **永不抛**（照 `workshop-client.ts` / `image-client.ts` 的判别联合口径）：这张图在公开仓
 *    **根本不存在**（占位包是十几块合成地块，没有像素面，见 `content-store.MAP_PROVINCES_URL`
 *    那条注释），取它就是 404。势力地图页签必须退化成友好空态，且**绝不影响标记地图页签** ——
 *    一个 throw 会把整个 Modal 打成白屏。
 *
 * 🔴 **原生尺寸解码，不缩放、不平滑**：`imageSmoothingEnabled = false` + 按 `naturalWidth`
 *    建画布。缩一次或插值一次，块色就会在边界处被混成中间色 —— 那些像素随后全部变成
 *    `UNKNOWN_TILE`，表现是「每块地的轮廓上有一圈点不中的毛边」，且不报错。
 */

import { decodeProvinceIds, type ProvinceRaster, type TileColorLookup } from './map-political';

/** 失败的四种形状（措辞归 UI，这里只给分类与技术细节） */
type ProvinceRasterFailure = 'missing' | 'decode' | 'unsupported' | 'aborted';

export type ProvinceRasterResult =
  | { ok: true; raster: ProvinceRaster }
  | { ok: false; reason: ProvinceRasterFailure; detail?: string };

/** 位图来源：`ImageBitmap` 或 `HTMLImageElement`（两条路都能直接 `drawImage`） */
type DecodedBitmap = { source: CanvasImageSource; width: number; height: number; close(): void };

async function decodeBlob(blob: Blob): Promise<DecodedBitmap | null> {
  // createImageBitmap 是首选：不进 DOM、可显式释放（8.7M 像素的图不该挂在一个 <img> 上等 GC）
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      /* 某些环境不支持 blob 直解，退回 <img> */
    }
  }

  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

/** 离屏画布 + 2D 上下文；拿不到上下文返回 null（jsdom / 极老浏览器） */
function createDecodeContext(
  w: number,
  h: number,
): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null {
  const options = { willReadFrequently: true } as const;
  if (typeof OffscreenCanvas === 'function') {
    // 断言：`OffscreenCanvas.getContext` 的重载在带 options 时退化成联合 `RenderingContext`
    const ctx = new OffscreenCanvas(w, h).getContext(
      '2d',
      options,
    ) as OffscreenCanvasRenderingContext2D | null;
    if (ctx) return { ctx };
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // 假值判据（不是 `=== null`）：没装 canvas 包的 jsdom 返回的可能是 undefined
  const ctx = canvas.getContext('2d', options) as CanvasRenderingContext2D | null;
  return ctx ? { ctx } : null;
}

/**
 * 取 `provinces.png` 并解码成 `idBuf`。
 *
 * `lookup` 由 `buildTileColorLookup(pack.tiles)` 给 —— 颜色↔id 的对应关系是承重假设，
 * 全部解释写在 `map-political.ts` 文件头那条红线里。
 */
export async function loadProvinceRaster(
  url: string,
  lookup: TileColorLookup,
  signal?: AbortSignal,
): Promise<ProvinceRasterResult> {
  // 🔴 写成函数而不是逐处 `signal?.aborted === true`：`aborted` 是只读 boolean，
  //    TS 会在第一次判定后把它**收窄成 false**，后面每一处同样的判定都变成
  //    「类型上不可能成立」的编译错误。取消检查必须每次真的重读那一格。
  const aborted = (): boolean => signal !== undefined && signal.aborted;

  let blob: Blob;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      return { ok: false, reason: 'missing', detail: `HTTP ${response.status}` };
    }
    blob = await response.blob();
  } catch (err) {
    if (aborted()) return { ok: false, reason: 'aborted' };
    return {
      ok: false,
      reason: 'missing',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (aborted()) return { ok: false, reason: 'aborted' };

  const bitmap = await decodeBlob(blob);
  if (bitmap === null) return { ok: false, reason: 'decode', detail: 'bitmap decode failed' };

  try {
    if (aborted()) return { ok: false, reason: 'aborted' };
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0) {
      return { ok: false, reason: 'decode', detail: 'zero-sized raster' };
    }
    const target = createDecodeContext(width, height);
    if (target === null) return { ok: false, reason: 'unsupported', detail: 'no 2d context' };

    target.ctx.imageSmoothingEnabled = false;
    target.ctx.drawImage(bitmap.source, 0, 0);
    const pixels = target.ctx.getImageData(0, 0, width, height);
    return { ok: true, raster: decodeProvinceIds(pixels, lookup) };
  } catch (err) {
    return {
      ok: false,
      reason: 'decode',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    bitmap.close();
  }
}
