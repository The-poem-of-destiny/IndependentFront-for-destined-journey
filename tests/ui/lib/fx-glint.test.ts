/**
 * fx-glint.ts — 偶发闪光的选框 / 选边 / 关键帧与运行器
 *
 * 守的是：只挑可见框、边太短或出视口不划；关键帧只动 transform / opacity；
 * 排期 40–90 秒、只播一次不循环；crimson 与无可见框跳过；无 animate 时不播；dispose 收干净。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLINT_DURATION_MS,
  GLINT_MAX_MS,
  GLINT_MIN_MS,
  createGlintRunner,
  edgeTrack,
  glintKeyframes,
  isRectVisible,
  planGlint,
  streakLength,
} from '../../../src/ui/lib/fx-glint';

const VP = { width: 1000, height: 600 };

function seq(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

function stubRect(el: Element, left: number, top: number, width: number, height: number) {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
}

function fakeTimers() {
  const pending: Array<{ cb: () => void; ms: number }> = [];
  return {
    timers: {
      setTimeout: vi.fn((cb: () => void, ms: number) => {
        const h = { cb, ms };
        pending.push(h);
        return h;
      }),
      clearTimeout: vi.fn((h: unknown) => {
        const i = pending.indexOf(h as (typeof pending)[number]);
        if (i >= 0) pending.splice(i, 1);
      }),
    },
    pending,
    fire() {
      const h = pending.shift();
      h?.cb();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('纯函数', () => {
  it('isRectVisible：无面积或完全在视口外为否', () => {
    expect(isRectVisible({ left: 0, top: 0, width: 10, height: 10 }, VP)).toBe(true);
    expect(isRectVisible({ left: 0, top: 0, width: 0, height: 10 }, VP)).toBe(false);
    expect(isRectVisible({ left: 1200, top: 0, width: 10, height: 10 }, VP)).toBe(false);
    expect(isRectVisible({ left: 0, top: -50, width: 10, height: 50 }, VP)).toBe(false);
  });

  it('edgeTrack：让出圆角并夹到视口；太短或出视口返回 null', () => {
    const r = { left: 100, top: 50, width: 300, height: 200 };
    expect(edgeTrack(r, 'top', VP)).toEqual({ axis: 'x', x: 112, y: 50, length: 276 });
    expect(edgeTrack(r, 'right', VP)).toEqual({ axis: 'y', x: 399, y: 62, length: 176 });
    expect(edgeTrack({ left: 0, top: 0, width: 50, height: 50 }, 'top', VP)).toBeNull();
    expect(edgeTrack({ left: 0, top: 590, width: 300, height: 100 }, 'bottom', VP)).toBeNull();
  });

  it('streakLength 夹在 [40, 180]', () => {
    expect(streakLength(50)).toBe(40);
    expect(streakLength(400)).toBe(88);
    expect(streakLength(5000)).toBe(180);
  });

  it('planGlint 只在可见框里挑，并带回下标与边', () => {
    const rects = [
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 100, top: 50, width: 300, height: 200 },
    ];
    const plan = planGlint(rects, VP, seq(0, 0));
    expect(plan?.index).toBe(1);
    expect(plan?.edge).toBe('top');
    expect(plan?.streak).toBe(streakLength(276));
    expect(planGlint([rects[0]], VP, seq(0))).toBeNull();
    expect(planGlint([], VP, seq(0))).toBeNull();
  });

  it('关键帧只含 transform / opacity，自起点外滑到终点外', () => {
    const frames = glintKeyframes('x', 300, 60);
    for (const f of frames) {
      for (const k of Object.keys(f)) expect(['transform', 'opacity', 'offset']).toContain(k);
    }
    expect(frames[0].transform).toBe('translateX(-60px)');
    expect(frames[frames.length - 1].transform).toBe('translateX(300px)');
    expect(glintKeyframes('y', 10, 5)[0].transform).toBe('translateY(-5px)');
  });
});

describe('createGlintRunner', () => {
  function mount() {
    document.body.innerHTML = `
      <div class="scene-panel" id="a"></div>
      <div class="status-hud" id="b"></div>
      <div id="track"><div id="streak"></div></div>
    `;
    stubRect(document.getElementById('a')!, 0, 0, 300, 500);
    stubRect(document.getElementById('b')!, 0, 0, 0, 0);
    return {
      track: document.getElementById('track') as HTMLElement,
      streak: document.getElementById('streak') as HTMLElement,
    };
  }

  it('排期落在 40–90 秒，跑完再排下一次（每次只播一遍）', () => {
    const els = mount();
    const t = fakeTimers();
    const runner = createGlintRunner(els, {
      rng: seq(0.5),
      timers: t.timers,
      isHidden: () => false,
      isEnabled: () => true,
      viewport: () => VP,
    });
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0].ms).toBeGreaterThanOrEqual(GLINT_MIN_MS);
    expect(t.pending[0].ms).toBeLessThanOrEqual(GLINT_MAX_MS);
    t.fire();
    expect(t.pending).toHaveLength(1);
    runner.dispose();
    expect(t.pending).toHaveLength(0);
  });

  it('有 animate 时播一次 900ms 动画，结束后藏起轨道', () => {
    const els = mount();
    const anim = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
    const animate = vi.fn(() => anim);
    (els.streak as unknown as { animate: typeof animate }).animate = animate;
    const t = fakeTimers();
    const runner = createGlintRunner(els, { rng: seq(0), timers: t.timers, viewport: () => VP });

    expect(runner.runOnce()).toBe(true);
    expect(els.track.hidden).toBe(false);
    expect(els.track.style.width).toBe('276px');
    const calls = animate.mock.calls as unknown as Array<[Keyframe[], KeyframeAnimationOptions]>;
    expect(calls[0][1].duration).toBe(GLINT_DURATION_MS);
    expect(calls[0][1].iterations).toBeUndefined();
    // 在播时不叠第二道
    expect(runner.runOnce()).toBe(false);
    anim.onfinish?.();
    expect(els.track.hidden).toBe(true);
    runner.dispose();
  });

  it('dispose 取消在播的动画并藏起轨道', () => {
    const els = mount();
    const anim = { onfinish: null, oncancel: null, cancel: vi.fn() };
    (els.streak as unknown as { animate: () => unknown }).animate = () => anim;
    const runner = createGlintRunner(els, {
      rng: seq(0),
      timers: fakeTimers().timers,
      viewport: () => VP,
    });
    runner.runOnce();
    runner.dispose();
    expect(anim.cancel).toHaveBeenCalledTimes(1);
    expect(els.track.hidden).toBe(true);
  });

  it('jsdom 无 animate：不播、轨道保持藏着', () => {
    const els = mount();
    const runner = createGlintRunner(els, {
      rng: seq(0),
      timers: fakeTimers().timers,
      viewport: () => VP,
    });
    expect(runner.runOnce()).toBe(true);
    expect(els.track.hidden).toBe(true);
    runner.dispose();
  });

  it('crimson 主题与无可见框时跳过', () => {
    const els = mount();
    const runner = createGlintRunner(els, {
      rng: seq(0),
      timers: fakeTimers().timers,
      viewport: () => VP,
    });
    document.documentElement.setAttribute('data-theme', 'crimson');
    expect(runner.runOnce()).toBe(false);
    document.documentElement.setAttribute('data-theme', 'obsidian');
    stubRect(document.getElementById('a')!, 0, 0, 0, 0);
    expect(runner.runOnce()).toBe(false);
    runner.dispose();
  });

  it('有可见弹窗时只在弹窗框里挑', () => {
    const els = mount();
    const modal = document.createElement('div');
    modal.className = 'modal-content';
    document.body.appendChild(modal);
    stubRect(modal, 400, 100, 400, 300);
    const anim = { onfinish: null, oncancel: null, cancel: vi.fn() };
    (els.streak as unknown as { animate: () => unknown }).animate = () => anim;
    const runner = createGlintRunner(els, {
      rng: seq(0),
      timers: fakeTimers().timers,
      viewport: () => VP,
    });
    runner.runOnce();
    expect(els.track.style.transform).toBe('translate3d(412.0px, 100.0px, 0)');
    runner.dispose();
  });
});
