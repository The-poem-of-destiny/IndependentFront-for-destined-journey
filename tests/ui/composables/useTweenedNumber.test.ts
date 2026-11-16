/**
 * useTweenedNumber — 数值滚动只改显示、不改数据
 *
 * 守的是 PRODUCT.md「一个真相来源」在动效层的落实：
 * 终点恒等于源值、挂载不滚、非整数不插值、减动效直接到位、中途改道从当前显示值出发。
 */
import { describe, it, expect } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useTweenedNumber, type FrameDriver } from '../../../src/ui/composables/useTweenedNumber';

/** 手动帧驱动：测试决定「时间走到哪」和「下一帧什么时候来」 */
function manualFrames() {
  let time = 0;
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const driver: FrameDriver = {
    now: () => time,
    request(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
  };
  return {
    driver,
    pendingCount: () => pending.size,
    /** 时间推进 ms 后跑一帧 */
    tick(ms: number) {
      time += ms;
      const batch = [...pending.values()];
      pending.clear();
      batch.forEach((cb) => cb());
    },
  };
}

function setup(initial: number, opts: { reduced?: boolean; duration?: number } = {}) {
  const source = ref(initial);
  const frames = manualFrames();
  const scope = effectScope();
  const tween = scope.run(() =>
    useTweenedNumber(() => source.value, {
      duration: opts.duration ?? 400,
      frames: frames.driver,
      reducedMotion: () => opts.reduced ?? false,
    }),
  )!;
  return { source, frames, scope, ...tween };
}

describe('useTweenedNumber', () => {
  it('挂载时直接显示真值，不从 0 数上来', () => {
    const { display, trend, frames } = setup(1250);
    expect(display.value).toBe(1250);
    expect(trend.value).toBeNull();
    expect(frames.pendingCount()).toBe(0);
  });

  it('上涨：中途是介于两端的整数，终点恰好等于源值，结束后 trend 清空', async () => {
    const { source, display, trend, frames } = setup(100);
    source.value = 300;
    await nextTick();
    expect(trend.value).toBe('up');

    frames.tick(100);
    const mid = display.value;
    expect(Number.isInteger(mid)).toBe(true);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(300);

    frames.tick(400);
    expect(display.value).toBe(300);
    expect(trend.value).toBeNull();
    expect(frames.pendingCount()).toBe(0);
  });

  it('下跌标记 down', async () => {
    const { source, trend } = setup(80);
    source.value = 20;
    await nextTick();
    expect(trend.value).toBe('down');
  });

  it('中途改道：从当前显示值出发去新终点，不先跳回旧终点', async () => {
    const { source, display, frames } = setup(0);
    source.value = 1000;
    await nextTick();
    frames.tick(100);
    const reached = display.value;
    expect(reached).toBeGreaterThan(0);

    source.value = 500;
    await nextTick();
    // 改道那一刻显示值不动；下一帧开始朝 500 走
    expect(display.value).toBe(reached);
    frames.tick(1000);
    expect(display.value).toBe(500);
  });

  it('非整数不插值，直接显示源值（插出来的小数是谁也没写过的数）', async () => {
    const { source, display, trend, frames } = setup(10);
    source.value = 12.5;
    await nextTick();
    expect(display.value).toBe(12.5);
    expect(trend.value).toBeNull();
    expect(frames.pendingCount()).toBe(0);
  });

  it('减动效时直接到位', async () => {
    const { source, display, trend, frames } = setup(10, { reduced: true });
    source.value = 99;
    await nextTick();
    expect(display.value).toBe(99);
    expect(trend.value).toBeNull();
    expect(frames.pendingCount()).toBe(0);
  });

  it('作用域销毁时取消在途的帧', async () => {
    const { source, frames, scope } = setup(0);
    source.value = 50;
    await nextTick();
    expect(frames.pendingCount()).toBe(1);
    scope.stop();
    expect(frames.pendingCount()).toBe(0);
  });
});
