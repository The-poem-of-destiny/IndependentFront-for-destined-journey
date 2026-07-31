/**
 * image-crop.test.ts — 裁剪原语
 *
 * 覆盖:
 * 1. `clampCropRect` 纯算术: 夹进边界 / 零面积 / 完全在图外 / 非有限数 / 负宽高
 * 2. `fitWithinMaxEdge` 等比缩放，短边永不塌成 0
 * 3. `cropImageBlob` 端到端（走注入的解码器与画布替身）:
 *    - 传给 `drawImage` 的源矩形确实是**夹逼后**的那个
 *    - 零面积 / 完全在图外 **抛错**，绝不静默产出一张空白 PNG（这是本文件最要紧的一条）
 *    - `maxEdge` 缩长边、保比例
 *    - mp4 源 / `video/*` 输出 一律抛 `'video-source'`
 *    - 输出 MIME: png/webp 原样保留，jpeg/gif/avif 落到 png
 * 4. `readImageSize` 读尺寸并释放位图
 *
 * **全程不需要真画布** —— 解码与画布两处都从 options 注入，所以整条逻辑能在
 * vitest `environment:'node'` 下跑（与 media-hash / asset-url 同一条纪律）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  clampCropRect,
  cropImageBlob,
  fitWithinMaxEdge,
  readImageSize,
  resolveOutputMime,
  ImageCropError,
  type CropBitmapLike,
  type CropCanvasLike,
  type CropContextLike,
  type ImageCropSeams,
} from './image-crop';

// ═══════════════════════════════════════════════════════════
// 替身
// ═══════════════════════════════════════════════════════════

interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface Rig extends ImageCropSeams {
  draws: DrawCall[];
  canvases: { width: number; height: number }[];
  encoded: { type?: string; quality?: number }[];
  closed: number;
}

/** 造一套注入缝: 固定尺寸的位图 + 记录一切的画布 */
function makeRig(
  imageWidth: number,
  imageHeight: number,
  opts: { canvas?: 'offscreen' | 'element' | 'none'; blob?: Blob | null } = {},
): Rig {
  const rig: Partial<Rig> = { draws: [], canvases: [], encoded: [], closed: 0 };

  const bitmap: CropBitmapLike = {
    width: imageWidth,
    height: imageHeight,
    close: () => {
      rig.closed = (rig.closed ?? 0) + 1;
    },
  };

  const ctx: CropContextLike = {
    drawImage: (_src, sx, sy, sw, sh, dx, dy, dw, dh) => {
      rig.draws?.push({ sx, sy, sw, sh, dx, dy, dw, dh });
    },
  };

  const mode = opts.canvas ?? 'offscreen';
  const encodedBlob = opts.blob === undefined ? new Blob([new Uint8Array([1, 2, 3])]) : opts.blob;

  const createCanvas = (width: number, height: number): CropCanvasLike | null => {
    if (mode === 'none') return null;
    const canvas: CropCanvasLike = {
      width,
      height,
      getContext: () => ctx,
    };
    if (mode === 'offscreen') {
      canvas.convertToBlob = async (o) => {
        rig.encoded?.push({ ...(o ?? {}) });
        rig.canvases?.push({ width: canvas.width, height: canvas.height });
        if (!encodedBlob) throw new Error('编码器罢工');
        return encodedBlob;
      };
    } else {
      canvas.toBlob = (cb, type, quality) => {
        rig.encoded?.push({ type, quality });
        rig.canvases?.push({ width: canvas.width, height: canvas.height });
        cb(encodedBlob);
      };
    }
    return canvas;
  };

  rig.decode = async () => bitmap;
  rig.createCanvas = createCanvas;
  return rig as Rig;
}

/** 非空的伪源字节 */
function sourceBlob(type = 'image/png'): Blob {
  return new Blob([new Uint8Array([9, 9, 9, 9])], { type });
}

async function expectCropError(p: Promise<unknown>, code: string): Promise<ImageCropError> {
  await expect(p).rejects.toBeInstanceOf(ImageCropError);
  const err = await p.then(
    () => null,
    (e: unknown) => e as ImageCropError,
  );
  expect(err?.code).toBe(code);
  return err as ImageCropError;
}

// ═══════════════════════════════════════════════════════════
// 1. clampCropRect
// ═══════════════════════════════════════════════════════════

describe('clampCropRect', () => {
  it('完全在图内的矩形原样通过（取整）', () => {
    expect(clampCropRect({ x: 10, y: 20, w: 30, h: 40 }, 100, 100)).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
  });

  it('越界的部分被裁掉，而不是把整块判废', () => {
    expect(clampCropRect({ x: -10, y: -10, w: 50, h: 50 }, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 40,
      h: 40,
    });
    expect(clampCropRect({ x: 80, y: 80, w: 50, h: 50 }, 100, 100)).toEqual({
      x: 80,
      y: 80,
      w: 20,
      h: 20,
    });
  });

  it('整块落在图外 → null（左侧 / 右侧 / 上方 / 下方 都一样）', () => {
    expect(clampCropRect({ x: -100, y: 0, w: 50, h: 50 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 200, y: 0, w: 50, h: 50 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 0, y: -100, w: 50, h: 50 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 0, y: 500, w: 50, h: 50 }, 100, 100)).toBeNull();
  });

  it('零面积 / 负宽高 → null（不自动翻转反向矩形）', () => {
    expect(clampCropRect({ x: 10, y: 10, w: 0, h: 20 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 10, y: 10, w: 20, h: 0 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 50, y: 50, w: -20, h: -20 }, 100, 100)).toBeNull();
  });

  it('取整之后不足 1px 也算没面积', () => {
    expect(clampCropRect({ x: 10.1, y: 10, w: 0.2, h: 20 }, 100, 100)).toBeNull();
  });

  it('非有限数 → null，不猜也不当 0 处理', () => {
    expect(clampCropRect({ x: NaN, y: 0, w: 10, h: 10 }, 100, 100)).toBeNull();
    expect(clampCropRect({ x: 0, y: 0, w: Infinity, h: 10 }, 100, 100)).toBeNull();
  });

  it('源图尺寸为 0 → null', () => {
    expect(clampCropRect({ x: 0, y: 0, w: 10, h: 10 }, 0, 100)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. fitWithinMaxEdge
// ═══════════════════════════════════════════════════════════

describe('fitWithinMaxEdge', () => {
  it('不给 maxEdge / 没超上限 → 原样', () => {
    expect(fitWithinMaxEdge(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithinMaxEdge(800, 600, 1000)).toEqual({ width: 800, height: 600 });
    expect(fitWithinMaxEdge(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });

  it('长边压到上限，短边等比 —— 宽图与高图都对', () => {
    expect(fitWithinMaxEdge(8000, 4000, 512)).toEqual({ width: 512, height: 256 });
    expect(fitWithinMaxEdge(4000, 8000, 512)).toEqual({ width: 256, height: 512 });
  });

  it('比例误差不超过 1px（取整的代价，不是缩放算错）', () => {
    const out = fitWithinMaxEdge(1234, 567, 400);
    expect(out.width).toBe(400);
    expect(Math.abs(out.height - (567 * 400) / 1234)).toBeLessThan(1);
  });

  it('极端长条的短边保底 1px，不塌成 0（0 宽画布画不出东西）', () => {
    expect(fitWithinMaxEdge(2000, 3, 100)).toEqual({ width: 100, height: 1 });
  });
});

// ═══════════════════════════════════════════════════════════
// 3. resolveOutputMime
// ═══════════════════════════════════════════════════════════

describe('resolveOutputMime', () => {
  it('无损/动画且画布编得出的（png / webp）原样保留', () => {
    expect(resolveOutputMime('image/png')).toBe('image/png');
    expect(resolveOutputMime('image/webp')).toBe('image/webp');
  });

  it('jpeg / gif / avif / 未知 一律落到 png', () => {
    expect(resolveOutputMime('image/jpeg')).toBe('image/png');
    expect(resolveOutputMime('image/gif')).toBe('image/png');
    expect(resolveOutputMime('image/avif')).toBe('image/png');
    expect(resolveOutputMime(undefined)).toBe('image/png');
    expect(resolveOutputMime('')).toBe('image/png');
  });

  it('显式指定优先于源类型', () => {
    expect(resolveOutputMime('image/png', 'image/jpeg')).toBe('image/jpeg');
  });

  it('video/* 无论出现在源还是输出，都抛 video-source', () => {
    expect(() => resolveOutputMime('video/mp4')).toThrow(ImageCropError);
    expect(() => resolveOutputMime('image/png', 'video/mp4')).toThrow(ImageCropError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. cropImageBlob
// ═══════════════════════════════════════════════════════════

describe('cropImageBlob', () => {
  it('把夹逼后的源矩形交给 drawImage，画布尺寸即输出尺寸', async () => {
    const rig = makeRig(200, 300);
    await cropImageBlob(sourceBlob(), { x: -10, y: 10, w: 60, h: 80 }, rig);

    expect(rig.draws).toHaveLength(1);
    // x 被夹到 0，宽度相应缩成 50
    expect(rig.draws[0]).toMatchObject({
      sx: 0,
      sy: 10,
      sw: 50,
      sh: 80,
      dx: 0,
      dy: 0,
      dw: 50,
      dh: 80,
    });
    expect(rig.canvases[0]).toEqual({ width: 50, height: 80 });
    // 位图用完即释放
    expect(rig.closed).toBe(1);
  });

  it('🔴 零面积 → 抛 empty-rect，绝不静默产出一张空白图', async () => {
    const rig = makeRig(200, 300);
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 10, y: 10, w: 0, h: 50 }, rig),
      'empty-rect',
    );
    // 一个像素都没画、一个字节都没编
    expect(rig.draws).toHaveLength(0);
    expect(rig.encoded).toHaveLength(0);
    // 失败路径上位图同样要释放
    expect(rig.closed).toBe(1);
  });

  it('🔴 整块落在图外 → 同样抛 empty-rect，而不是返回一张 0 面积的图', async () => {
    const rig = makeRig(200, 300);
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 900, y: 900, w: 50, h: 50 }, rig),
      'empty-rect',
    );
    expect(rig.encoded).toHaveLength(0);
  });

  it('maxEdge 压长边、保比例，源矩形不受影响', async () => {
    const rig = makeRig(8000, 8000);
    await cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 8000, h: 4000 }, { ...rig, maxEdge: 512 });

    expect(rig.draws[0]).toMatchObject({ sx: 0, sy: 0, sw: 8000, sh: 4000, dw: 512, dh: 256 });
    expect(rig.canvases[0]).toEqual({ width: 512, height: 256 });
  });

  it('mp4 源 → video-source，且**根本不解码**（解码器一次都没被调用）', async () => {
    const rig = makeRig(200, 200);
    const decode = vi.fn(rig.decode!);
    await expectCropError(
      cropImageBlob(sourceBlob('video/mp4'), { x: 0, y: 0, w: 10, h: 10 }, { ...rig, decode }),
      'video-source',
    );
    expect(decode).not.toHaveBeenCalled();
  });

  it('点名要 video/* 输出 → 同样 video-source', async () => {
    const rig = makeRig(200, 200);
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 10, h: 10 }, { ...rig, mime: 'video/mp4' }),
      'video-source',
    );
  });

  it('输出 MIME: png/webp 保留，jpeg 落 png（有损再编码会叠伪影）', async () => {
    const png = makeRig(100, 100);
    await cropImageBlob(sourceBlob('image/png'), { x: 0, y: 0, w: 10, h: 10 }, png);
    expect(png.encoded[0].type).toBe('image/png');

    const webp = makeRig(100, 100);
    await cropImageBlob(sourceBlob('image/webp'), { x: 0, y: 0, w: 10, h: 10 }, webp);
    expect(webp.encoded[0].type).toBe('image/webp');

    const jpeg = makeRig(100, 100);
    await cropImageBlob(sourceBlob('image/jpeg'), { x: 0, y: 0, w: 10, h: 10 }, jpeg);
    expect(jpeg.encoded[0].type).toBe('image/png');
  });

  it('`<canvas>` 的 toBlob 路径与 OffscreenCanvas 等价', async () => {
    const rig = makeRig(100, 100, { canvas: 'element' });
    const out = await cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 20, h: 20 }, rig);
    expect(out.size).toBeGreaterThan(0);
    expect(rig.encoded[0].type).toBe('image/png');
  });

  it('空源文件 → empty-source', async () => {
    const rig = makeRig(100, 100);
    await expectCropError(
      cropImageBlob(new Blob([], { type: 'image/png' }), { x: 0, y: 0, w: 10, h: 10 }, rig),
      'empty-source',
    );
  });

  it('解码抛错 → decode-failed（原样上浮会让调用方看到一个陌生的错误类型）', async () => {
    const rig = makeRig(100, 100);
    await expectCropError(
      cropImageBlob(
        sourceBlob(),
        { x: 0, y: 0, w: 10, h: 10 },
        {
          ...rig,
          decode: async () => {
            throw new Error('这不是图片');
          },
        },
      ),
      'decode-failed',
    );
  });

  it('造不出画布 → no-canvas', async () => {
    const rig = makeRig(100, 100, { canvas: 'none' });
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 10, h: 10 }, rig),
      'no-canvas',
    );
  });

  it('编码吐出空 blob → encode-failed，而不是把空字节当成结果返回', async () => {
    const rig = makeRig(100, 100, { blob: null });
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 10, h: 10 }, rig),
      'encode-failed',
    );
  });

  it('没有解码器且没注入 → no-decoder（node 环境下没有 createImageBitmap）', async () => {
    const hadGlobal = 'createImageBitmap' in globalThis;
    if (hadGlobal) return; // 环境自带解码器时这条不适用
    await expectCropError(
      cropImageBlob(sourceBlob(), { x: 0, y: 0, w: 10, h: 10 }, {}),
      'no-decoder',
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 5. readImageSize
// ═══════════════════════════════════════════════════════════

describe('readImageSize', () => {
  it('给出源图像素尺寸并释放位图', async () => {
    const rig = makeRig(1920, 1080);
    expect(await readImageSize(sourceBlob(), rig)).toEqual({ w: 1920, h: 1080 });
    expect(rig.closed).toBe(1);
  });

  it('视频源同样拒收 —— 编辑器不该给一段 mp4 画选框', async () => {
    const rig = makeRig(100, 100);
    await expectCropError(readImageSize(sourceBlob('video/mp4'), rig), 'video-source');
  });

  it('解码出 0 尺寸也算 decode-failed', async () => {
    await expectCropError(
      readImageSize(sourceBlob(), { decode: async () => ({ width: 0, height: 0 }) }),
      'decode-failed',
    );
  });
});
