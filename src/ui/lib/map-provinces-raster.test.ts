/**
 * map-provinces-raster.test.ts — 取图/解码那条缝（地图 v1 / 设计 §9）
 * @vitest-environment jsdom
 *
 * 这一层的全部价值是**永不抛**加**按原生尺寸不平滑地解码**，而两者坏掉都不报错：
 *   · 抛出去 → 势力页签把整个地图 Modal 打成白屏（标记页签一起没了）
 *   · 缩放或插值一次 → 块色在边界被混成中间色，那些像素全变 UNKNOWN，
 *     表现是「每块地轮廓上一圈点不中的毛边」
 * 所以这里连 `imageSmoothingEnabled` 与 `getImageData` 的入参都断言。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTileColorLookup, provinceColorForTileId } from './map-political';
import { loadProvinceRaster } from './map-provinces-raster';

const LOOKUP = buildTileColorLookup([{ id: 1 }, { id: 2 }]);

/** 2×1 的假图：左像素是块 1，右像素是块 2 */
function fakePixels(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(2 * 4);
  for (const [i, id] of [1, 2].entries()) {
    const [r, g, b] = provinceColorForTileId(id);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: 2, height: 1, data };
}

function stubFetchOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['png']) })),
  );
}

/** 位图解码：跳过真 PNG（jsdom 解不了），只保留尺寸 */
function stubBitmap(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
}

interface FakeCtx {
  imageSmoothingEnabled: boolean;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
}

/** 把 2D 上下文换成假的（jsdom 没有真的）；返回它以便断言解码口径 */
function stubContext(): FakeCtx {
  const ctx: FakeCtx = {
    imageSmoothingEnabled: true,
    drawImage: vi.fn(),
    getImageData: vi.fn(() => fakePixels()),
  };
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return ctx;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadProvinceRaster', () => {
  it('404 → missing（公开仓占位包没有这张图，这是常态不是异常）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })),
    );
    const result = await loadProvinceRaster('/x.png', LOOKUP);
    expect(result).toEqual({ ok: false, reason: 'missing', detail: 'HTTP 404' });
  });

  it('网络异常 → missing 且不抛穿', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const result = await loadProvinceRaster('/x.png', LOOKUP);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
      expect(result.detail).toContain('offline');
    }
  });

  it('取消 → aborted（调用方据此什么都不改）', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('aborted by signal');
      }),
    );
    const result = await loadProvinceRaster('/x.png', LOOKUP, controller.signal);
    expect(result).toEqual({ ok: false, reason: 'aborted' });
  });

  it('拿不到 2D 上下文 → unsupported（jsdom / 老浏览器），不是崩', async () => {
    stubFetchOk();
    stubBitmap(2, 1);
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const result = await loadProvinceRaster('/x.png', LOOKUP);
    expect(result).toEqual({ ok: false, reason: 'unsupported', detail: 'no 2d context' });
  });

  it('零尺寸位图 → decode（不去建一张 0 像素的画布）', async () => {
    stubFetchOk();
    stubBitmap(0, 0);
    const result = await loadProvinceRaster('/x.png', LOOKUP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('decode');
  });

  it('成功路径：按原生尺寸、关掉平滑、整幅读回来解成 idBuf', async () => {
    stubFetchOk();
    stubBitmap(2, 1);
    const ctx = stubContext();
    const result = await loadProvinceRaster('/x.png', LOOKUP);

    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.raster.idBuf]).toEqual([1, 2]);
      expect(result.raster.unknownPixels).toBe(0);
    }
  });

  it('getImageData 抛（跨源污染画布那类）→ decode，不抛穿', async () => {
    stubFetchOk();
    stubBitmap(2, 1);
    const ctx = stubContext();
    ctx.getImageData.mockImplementation(() => {
      throw new Error('tainted canvas');
    });
    const result = await loadProvinceRaster('/x.png', LOOKUP);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('decode');
      expect(result.detail).toContain('tainted');
    }
  });
});
