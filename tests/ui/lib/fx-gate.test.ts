/**
 * fx-gate.ts — 界面特效唯一闸门
 *
 * 守的是：设置开 **且** 不减动效才开闸；关闸时属性被移除（不留反值）；
 * 共享响应式镜像与 DOM 恒等。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { syncFxGate, isFxEnabled, useFxEnabled } from '../../../src/ui/lib/fx-gate';
import { applyReducedMotion } from '../../../src/ui/lib/reduced-motion';

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches })) as unknown as typeof matchMedia);
}

afterEach(() => {
  vi.unstubAllGlobals();
  applyReducedMotion(false);
  syncFxGate(false);
});

describe('syncFxGate', () => {
  it('设置开、无减动效 → 写 data-fx="on"', () => {
    stubMatchMedia(false);
    expect(syncFxGate(true)).toBe(true);
    expect(document.documentElement.getAttribute('data-fx')).toBe('on');
    expect(isFxEnabled()).toBe(true);
  });

  it('设置关 → 移除属性（不留 "off"）', () => {
    stubMatchMedia(false);
    syncFxGate(true);
    expect(syncFxGate(false)).toBe(false);
    expect(document.documentElement.hasAttribute('data-fx')).toBe(false);
    expect(isFxEnabled()).toBe(false);
  });

  it('应用内减动效开着 → 设置开也不开闸', () => {
    stubMatchMedia(false);
    applyReducedMotion(true);
    expect(syncFxGate(true)).toBe(false);
    expect(document.documentElement.hasAttribute('data-fx')).toBe(false);
  });

  it('系统偏好减动效 → 设置开也不开闸', () => {
    stubMatchMedia(true);
    expect(syncFxGate(true)).toBe(false);
    expect(isFxEnabled()).toBe(false);
  });
});

describe('useFxEnabled', () => {
  it('返回的共享 ref 随 syncFxGate 变化', () => {
    stubMatchMedia(false);
    const a = useFxEnabled();
    const b = useFxEnabled();
    expect(a.value).toBe(false);
    syncFxGate(true);
    expect(a.value).toBe(true);
    expect(b.value).toBe(true);
    syncFxGate(false);
    expect(a.value).toBe(false);
  });

  it('取用时以 DOM 为准校正镜像', () => {
    stubMatchMedia(false);
    syncFxGate(true);
    document.documentElement.removeAttribute('data-fx');
    expect(useFxEnabled().value).toBe(false);
  });
});
