/**
 * reduced-motion.ts — 减动效判定
 *
 * 守的是「两个来源是**或**的关系」：系统偏好与应用内开关各自都能独立生效。
 * 只认其中一个，就会出现「CSS 不动了但 JS 还在平滑滚动」这种半吊子状态。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyReducedMotion, isReducedMotion, scrollBehavior } from './reduced-motion';

/** 装一个可控的 matchMedia —— jsdom 默认没有 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches })) as unknown as typeof matchMedia);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('applyReducedMotion', () => {
  it('开 → 写属性；关 → 移除属性（不留 "false"）', () => {
    applyReducedMotion(true);
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('true');
    applyReducedMotion(false);
    // 留个 "false" 只是噪音，还会诱使别处写出 `!== 'false'` 这种反向判断
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
  });
});

describe('isReducedMotion', () => {
  it('系统没开、开关没开 → false', () => {
    stubMatchMedia(false);
    expect(isReducedMotion()).toBe(false);
  });

  it('只有系统开 → true', () => {
    stubMatchMedia(true);
    expect(isReducedMotion()).toBe(true);
  });

  it('★ 只有应用内开关开 → true（系统没开也算数，这是本开关存在的理由）', () => {
    stubMatchMedia(false);
    applyReducedMotion(true);
    expect(isReducedMotion()).toBe(true);
  });

  it('开关关掉后系统偏好仍独立生效 —— 本开关只做"额外强制开启"', () => {
    stubMatchMedia(true);
    applyReducedMotion(false);
    expect(isReducedMotion()).toBe(true);
  });

  it('matchMedia 不存在时不抛，只当作拿不到系统偏好', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isReducedMotion()).toBe(false);
    applyReducedMotion(true);
    expect(isReducedMotion()).toBe(true);
  });

  it('matchMedia 抛异常时同样兜住', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('boom');
      }) as unknown as typeof matchMedia,
    );
    expect(isReducedMotion()).toBe(false);
  });
});

describe('scrollBehavior', () => {
  it('减动效 → auto；否则 smooth', () => {
    stubMatchMedia(false);
    expect(scrollBehavior()).toBe('smooth');
    applyReducedMotion(true);
    expect(scrollBehavior()).toBe('auto');
  });
});
