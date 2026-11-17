/**
 * FxFrameTrace — 弹窗入场的四角描线
 *
 * 钉住三件事：按面板矩形外扩摆位、四个角各一横一竖、到点自行通知移除
 * （靠定时器而非 animationend —— 后者在 jsdom / 后台标签页都不保证派发）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FxFrameTrace from '../../../../src/ui/components/shared/FxFrameTrace.vue';
import { FX_TRACE_TOTAL_MS } from '../../../../src/ui/components/shared/fx-frame-trace-timing';

const rect = { left: 100, top: 50, width: 520, height: 300 };

afterEach(() => {
  vi.useRealTimers();
});

describe('FxFrameTrace', () => {
  it('按面板矩形向外扩 6px 摆位，并给出夹逼后的臂长', () => {
    const w = mount(FxFrameTrace, { props: { rect } });
    const el = w.element as HTMLElement;
    expect(el.style.left).toBe('94px');
    expect(el.style.top).toBe('44px');
    expect(el.style.width).toBe('532px');
    expect(el.style.height).toBe('312px');
    // 520 × 18% = 93.6 → 94；300 × 18% = 54
    expect(el.style.getPropertyValue('--fx-trace-arm-x')).toBe('94px');
    expect(el.style.getPropertyValue('--fx-trace-arm-y')).toBe('54px');
  });

  it('臂长夹在 20–96px 之间', () => {
    const tiny = mount(FxFrameTrace, { props: { rect: { ...rect, width: 40, height: 2000 } } });
    const el = tiny.element as HTMLElement;
    expect(el.style.getPropertyValue('--fx-trace-arm-x')).toBe('20px');
    expect(el.style.getPropertyValue('--fx-trace-arm-y')).toBe('96px');
  });

  it('四个角各有一条横臂与一条竖臂，整体 aria-hidden', () => {
    const w = mount(FxFrameTrace, { props: { rect } });
    expect(w.attributes('aria-hidden')).toBe('true');
    const corners = w.findAll('.fx-frame-trace__corner');
    expect(corners.map((c) => c.classes().find((k) => k.includes('--')))).toEqual([
      'fx-frame-trace__corner--tl',
      'fx-frame-trace__corner--tr',
      'fx-frame-trace__corner--bl',
      'fx-frame-trace__corner--br',
    ]);
    for (const c of corners) {
      expect(c.findAll('.fx-frame-trace__arm--h')).toHaveLength(1);
      expect(c.findAll('.fx-frame-trace__arm--v')).toHaveLength(1);
    }
  });

  it('整段结束时发出 done，且只发一次', () => {
    vi.useFakeTimers();
    const w = mount(FxFrameTrace, { props: { rect } });
    vi.advanceTimersByTime(FX_TRACE_TOTAL_MS - 1);
    expect(w.emitted('done')).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(w.emitted('done')).toHaveLength(1);
    vi.advanceTimersByTime(FX_TRACE_TOTAL_MS);
    expect(w.emitted('done')).toHaveLength(1);
  });

  it('提前卸载时清掉定时器，不再发 done', () => {
    vi.useFakeTimers();
    const w = mount(FxFrameTrace, { props: { rect } });
    const emitted = w.emitted();
    w.unmount();
    vi.advanceTimersByTime(FX_TRACE_TOTAL_MS * 2);
    expect(emitted.done).toBeUndefined();
  });
});
