import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MIN_CROP_SIZE,
  clampRect,
  defaultAvatarRect,
  moveRect,
  previewBackground,
  resizeRect,
  wholeImageRect,
  type CropCorner,
} from './crop-rects';

/**
 * crop-rects 的**属性测试** —— 该模块此前一条测试都没有。
 *
 * 为什么这里适合属性测试而不是例子测试：模块头写死了三条纪律（整像素 / 非有限数不猜 /
 * 锁定 1:1 以 w 为准），外加「框永远在图内」「拖角时对角不动」。这些都是
 * **对所有输入成立**的命题 —— 用例子去测只能覆盖挑出来的那几组，而拖拽产生的
 * 坐标是连续的、还会掺进 NaN（模块注释点名的「除以一个还没测量出来的 0 宽容器」）。
 *
 * 每条 `it` 只钉**一条**不变式，失败时 fast-check 会把反例缩到最小再报出来。
 */

/** 真实的图尺寸：既要有比 MIN_CROP_SIZE 还小的病态图，也要有正常尺寸 */
const imgDim = fc.integer({ min: 1, max: 4000 });

/** 坐标/位移：掺进非有限数，因为纪律 2 说的就是这些不许漏出去 */
const loose = fc.oneof(
  fc.integer({ min: -5000, max: 5000 }),
  fc.double({ min: -5000, max: 5000, noNaN: false }),
  fc.constantFrom(NaN, Infinity, -Infinity),
);

const rectArb = fc.record({ x: loose, y: loose, w: loose, h: loose });
const corner = fc.constantFrom<CropCorner>('nw', 'ne', 'sw', 'se');

/**
 * 所有产出的框都必须满足的基本契约。
 *
 * `square` 会改变**边长下限**：锁定 1:1 时边长同时受两边约束，下限是
 * `min(MIN_CROP_SIZE, imgW, imgH)`；非锁定时两轴各算各的。这不是实现的瑕疵 ——
 * 一张 2×1 的图裁不出边长 2 的正方形。初稿把这条写成了 `min(MIN, imgW)`，
 * 于是四条属性一起红在 `imgW=2, imgH=1` 这种退化图上。
 */
function expectSaneRect(
  r: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
  square = false,
) {
  const floorW = square ? Math.min(MIN_CROP_SIZE, imgW, imgH) : Math.min(MIN_CROP_SIZE, imgW);
  const floorH = square ? Math.min(MIN_CROP_SIZE, imgW, imgH) : Math.min(MIN_CROP_SIZE, imgH);
  // 纪律 1：整像素
  expect(Number.isInteger(r.x)).toBe(true);
  expect(Number.isInteger(r.y)).toBe(true);
  expect(Number.isInteger(r.w)).toBe(true);
  expect(Number.isInteger(r.h)).toBe(true);
  // 纪律 2：非有限数不许漏出去
  expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
  expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
  // 框在图内
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.w).toBeGreaterThan(0);
  expect(r.h).toBeGreaterThan(0);
  expect(r.x + r.w).toBeLessThanOrEqual(imgW);
  expect(r.y + r.h).toBeLessThanOrEqual(imgH);
  // 边长下限：图比 MIN 还小时让路（clampSize 的 lo = min(MIN, hi)）
  expect(r.w).toBeGreaterThanOrEqual(floorW);
  expect(r.h).toBeGreaterThanOrEqual(floorH);
}

describe('crop-rects 不变式', () => {
  it('clampRect 的产出永远是图内的整像素框', () => {
    fc.assert(
      fc.property(rectArb, imgDim, imgDim, (rect, w, h) => {
        expectSaneRect(clampRect(rect, w, h), w, h);
      }),
    );
  });

  it('clampRect(square) 产出的一定是正方形', () => {
    fc.assert(
      fc.property(rectArb, imgDim, imgDim, (rect, w, h) => {
        const out = clampRect(rect, w, h, true);
        expect(out.w).toBe(out.h);
        expectSaneRect(out, w, h, true);
      }),
    );
  });

  it('clampRect 幂等：已经合法的框再夹一次不变', () => {
    fc.assert(
      fc.property(rectArb, imgDim, imgDim, fc.boolean(), (rect, w, h, square) => {
        const once = clampRect(rect, w, h, square);
        expect(clampRect(once, w, h, square)).toEqual(once);
      }),
    );
  });

  it('moveRect 只挪不缩：尺寸与夹过一次的同源框一致', () => {
    fc.assert(
      fc.property(rectArb, loose, loose, imgDim, imgDim, fc.boolean(), (rect, dx, dy, w, h, sq) => {
        const base = clampRect(rect, w, h, sq);
        const moved = moveRect(base, dx, dy, w, h, sq);
        expect(moved.w).toBe(base.w);
        expect(moved.h).toBe(base.h);
        expectSaneRect(moved, w, h, sq);
      }),
    );
  });

  it('resizeRect 的产出永远合法，锁定时永远是正方形', () => {
    fc.assert(
      fc.property(
        rectArb,
        corner,
        loose,
        loose,
        imgDim,
        imgDim,
        fc.boolean(),
        (rect, c, dx, dy, w, h, square) => {
          const base = clampRect(rect, w, h, square);
          const out = resizeRect(base, c, dx, dy, w, h, square);
          expectSaneRect(out, w, h, square);
          if (square) expect(out.w).toBe(out.h);
        },
      ),
    );
  });

  it('resizeRect 拖零位移不动框', () => {
    fc.assert(
      fc.property(rectArb, corner, imgDim, imgDim, (rect, c, w, h) => {
        const base = clampRect(rect, w, h, false);
        expect(resizeRect(base, c, 0, 0, w, h, false)).toEqual(base);
      }),
    );
  });

  it('wholeImageRect / defaultAvatarRect 都产出图内的整像素框', () => {
    fc.assert(
      fc.property(imgDim, imgDim, (w, h) => {
        expectSaneRect(wholeImageRect(w, h), w, h);
        const avatar = defaultAvatarRect(w, h);
        expectSaneRect(avatar, w, h, true);
        // 头像默认框是正方形、且贴顶
        expect(avatar.w).toBe(avatar.h);
        expect(avatar.y).toBe(0);
      }),
    );
  });

  it('previewBackground 永远产出可用的 CSS（不出 NaN%）', () => {
    fc.assert(
      fc.property(rectArb, imgDim, imgDim, (rect, w, h) => {
        const bg = previewBackground(clampRect(rect, w, h), w, h);
        expect(bg.size).not.toMatch(/NaN|Infinity/);
        expect(bg.position).not.toMatch(/NaN|Infinity/);
      }),
    );
  });
});
