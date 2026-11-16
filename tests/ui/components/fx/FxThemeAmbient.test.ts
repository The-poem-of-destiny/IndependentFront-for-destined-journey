/**
 * FxThemeAmbient — 主题氛围层的组件契约
 *
 * 钉的是：按 `<html data-theme>` 渲染对应的氛围（ocean 焦散 / misty-lilac 极光 / 其余空根）；
 * forest / ivory 的一次性效果走偶发排期（假定时器驱动），播完由 animationend 摘掉；
 * 换主题与卸载都会取消排期、作废正在播的一次性效果；样式守住 alpha ≤ 0.08 与「每主题至多一个循环」。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FxThemeAmbient from '../../../../src/ui/components/fx/FxThemeAmbient.vue';
import source from '../../../../src/ui/components/fx/FxThemeAmbient.vue?raw';
import {
  CONDENSATION_INTERVAL,
  GOLD_THREAD_INTERVAL,
} from '../../../../src/ui/lib/fx-theme-signature';

const root = document.documentElement;
let wrapper: VueWrapper | null = null;

function mountAmbient(theme: string | null) {
  if (theme === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  wrapper = mount(FxThemeAmbient, { attachTo: document.body });
  return wrapper;
}

const layer = () => document.querySelector('.fx-theme-ambient');

/** 换主题：属性由 MutationObserver 观察，回调走微任务，再等一拍渲染 */
async function switchTheme(theme: string) {
  root.setAttribute('data-theme', theme);
  await flushPromises();
}

function styleBlocks(): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
}

beforeEach(() => {
  // 偶发排期只在闸门打开、页面可见时真的跑
  root.setAttribute('data-fx', 'on');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
  root.removeAttribute('data-fx');
  root.removeAttribute('data-theme');
});

describe('FxThemeAmbient — 按主题渲染', () => {
  it('ocean：左右侧条各一份焦散纹理，反向那份带 reverse 类', () => {
    mountAmbient('ocean');
    const el = layer();
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.classList.contains('fx-overlay')).toBe(true);
    expect(el?.getAttribute('data-ambient')).toBe('caustics');
    expect(el?.querySelectorAll('.fx-amb-strip')).toHaveLength(2);
    expect(el?.querySelectorAll('.fx-amb-caustic')).toHaveLength(2);
    expect(el?.querySelectorAll('.fx-amb-caustic--reverse')).toHaveLength(1);
  });

  it('misty-lilac：只有顶带一条极光', () => {
    mountAmbient('misty-lilac');
    const el = layer();
    expect(el?.getAttribute('data-ambient')).toBe('aurora');
    expect(el?.querySelectorAll('.fx-amb-band .fx-amb-aurora')).toHaveLength(1);
    expect(el?.querySelector('.fx-amb-strip')).toBeNull();
  });

  it.each(['obsidian', 'crimson', 'sakura'])('%s：只留空的覆盖层根，不排期', (theme) => {
    vi.useFakeTimers();
    mountAmbient(theme);
    const el = layer();
    expect(el).not.toBeNull();
    expect(el?.hasAttribute('data-ambient')).toBe(false);
    expect(el?.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没有主题属性时同样只留空根', () => {
    mountAmbient(null);
    expect(layer()?.children).toHaveLength(0);
  });

  it('换主题即重渲染：ocean → misty-lilac', async () => {
    mountAmbient('ocean');
    expect(layer()?.querySelector('.fx-amb-caustic')).not.toBeNull();
    await switchTheme('misty-lilac');
    expect(layer()?.querySelector('.fx-amb-caustic')).toBeNull();
    expect(layer()?.querySelector('.fx-amb-aurora')).not.toBeNull();
  });
});

describe('FxThemeAmbient — 偶发一次性效果', () => {
  it('forest：挂载即排一次，到点凝出一颗露珠，animationend 后摘掉并继续排下一次', async () => {
    vi.useFakeTimers();
    mountAmbient('forest');
    expect(vi.getTimerCount()).toBe(1);
    expect(layer()?.querySelector('.fx-amb-drop')).toBeNull();

    vi.advanceTimersByTime(CONDENSATION_INTERVAL.maxMs);
    await flushPromises();
    const drop = layer()?.querySelector<HTMLElement>('.fx-amb-drop');
    expect(drop).not.toBeNull();
    expect(drop?.querySelector('.fx-amb-drop-bead')).not.toBeNull();
    // 落点只写在内联定位上：左或右其一 + top
    expect(drop?.style.top).toMatch(/vh$/);
    expect(drop?.style.left || drop?.style.right).toMatch(/vw$/);
    // 跑完照常重排（偶发，不是一次性就停）
    expect(vi.getTimerCount()).toBe(1);

    drop?.dispatchEvent(new Event('animationend'));
    await flushPromises();
    expect(layer()?.querySelector('.fx-amb-drop')).toBeNull();
  });

  it('ivory：到点划过一缕金线，类名带落点那一侧', async () => {
    vi.useFakeTimers();
    mountAmbient('ivory');
    vi.advanceTimersByTime(GOLD_THREAD_INTERVAL.maxMs);
    await flushPromises();
    const thread = layer()?.querySelector('.fx-amb-thread');
    expect(thread).not.toBeNull();
    expect(thread?.className).toMatch(/fx-amb-thread--(left|right)/);
    expect(thread?.querySelector('.fx-amb-thread-glint')).not.toBeNull();
  });

  it('闸门关着时到点跳过本次，不出效果但照常重排', async () => {
    vi.useFakeTimers();
    mountAmbient('forest');
    root.removeAttribute('data-fx');
    vi.advanceTimersByTime(CONDENSATION_INTERVAL.maxMs);
    await flushPromises();
    expect(layer()?.querySelector('.fx-amb-drop')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('换主题即取消旧排期、作废正在播的效果；换到无偶发的主题后不再排期', async () => {
    vi.useFakeTimers();
    mountAmbient('forest');
    vi.advanceTimersByTime(CONDENSATION_INTERVAL.maxMs);
    await flushPromises();
    expect(layer()?.querySelector('.fx-amb-drop')).not.toBeNull();

    // forest → ivory：旧露珠立即作废，新排期按金线间隔
    await switchTheme('ivory');
    expect(layer()?.querySelector('.fx-amb-drop')).toBeNull();
    expect(layer()?.querySelector('.fx-amb-thread')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    // ivory → obsidian：没有偶发效果，定时器清空
    await switchTheme('obsidian');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(GOLD_THREAD_INTERVAL.maxMs * 2);
    await flushPromises();
    expect(layer()?.children).toHaveLength(0);
  });

  it('卸载即清掉定时器、停止观察主题', async () => {
    vi.useFakeTimers();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    mountAmbient('ivory');
    expect(vi.getTimerCount()).toBe(1);

    wrapper?.unmount();
    wrapper = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();

    // 卸载后再换主题也不会重新排期
    await switchTheme('forest');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FxThemeAmbient — 样式契约', () => {
  const css = styleBlocks();

  it('opacity 一律 ≤ 0.08', () => {
    const values = [...css.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(0.08);
  });

  it('循环动画只有焦散与极光两条（各属一个主题），一次性效果不循环', () => {
    const infinite = [...css.matchAll(/animation:\s*([\w-]+)[^;]*infinite/g)].map((m) => m[1]);
    expect(infinite.sort()).toEqual(['fx-amb-aurora-sway', 'fx-amb-caustic-drift']);
  });

  it('不用 mix-blend-mode / backdrop-filter', () => {
    expect(css).not.toMatch(/mix-blend-mode|backdrop-filter/);
  });
});
