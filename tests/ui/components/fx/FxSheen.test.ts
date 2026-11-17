/**
 * FxSheen / FxGlint — 应用级光泽与闪光层的组件契约
 *
 * 钉的是：结构（aria-hidden、puck / ring 类名是 T6 的契约）、挂载即接管悬停、卸载摘净监听与定时器、
 * 样式守住强度上限（puck 峰值 ≤ 15%）与 crimson 下闪光整层不显示。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import FxSheen from '../../../../src/ui/components/fx/FxSheen.vue';
import FxGlint from '../../../../src/ui/components/fx/FxGlint.vue';
import sheenSource from '../../../../src/ui/components/fx/FxSheen.vue?raw';
import glintSource from '../../../../src/ui/components/fx/FxGlint.vue?raw';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-fx');
});

function styleBlocks(source: string): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
}

function hover(el: Element) {
  const ev = new Event('pointerover', { bubbles: true });
  Object.defineProperties(ev, {
    clientX: { value: 5 },
    clientY: { value: 5 },
    pointerType: { value: 'mouse' },
  });
  el.dispatchEvent(ev);
}

describe('FxSheen', () => {
  it('根是 aria-hidden 覆盖层，内含唯一的 puck 与 ring', () => {
    wrapper = mount(FxSheen, { attachTo: document.body });
    const root = document.querySelector('.fx-sheen');
    expect(root?.classList.contains('fx-overlay')).toBe(true);
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.querySelectorAll('.fx-sheen-puck')).toHaveLength(1);
    expect(root?.querySelectorAll('.fx-sheen-ring')).toHaveLength(1);
  });

  it('悬停控件点亮 puck；卸载后摘掉文档监听', () => {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    document.body.appendChild(btn);
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    wrapper = mount(FxSheen, { attachTo: document.body });

    hover(btn);
    expect(document.querySelector('.fx-sheen-puck')?.classList.contains('is-active')).toBe(true);

    wrapper.unmount();
    wrapper = null;
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(['pointerover', 'pointerout', 'scroll']));
  });

  it('样式：puck 峰值 alpha ≤ 15%，按主题设色在本层根上而不是 :root', () => {
    const css = styleBlocks(sheenSource);
    const puck = /\n\.fx-sheen-puck \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const percents = [...puck.matchAll(/var\(--fx-sheen-color\)\s+(\d+(?:\.\d+)?)%/g)].map((m) =>
      Number(m[1]),
    );
    expect(percents.length).toBeGreaterThan(0);
    expect(Math.max(...percents)).toBeLessThanOrEqual(15);
    expect(css).toMatch(/:root\[data-theme='bronze'\] \.fx-sheen \{/);
    expect(css).not.toMatch(/:root\[data-theme='[^']+'\]\s*\{/);
  });
});

describe('FxGlint', () => {
  it('根是 aria-hidden 覆盖层，轨道默认藏着', () => {
    wrapper = mount(FxGlint, { attachTo: document.body });
    const root = document.querySelector('.fx-glint');
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect((root?.querySelector('.fx-glint-track') as HTMLElement).hidden).toBe(true);
  });

  it('挂载即排期一次偶发，卸载清掉定时器', () => {
    vi.useFakeTimers();
    wrapper = mount(FxGlint, { attachTo: document.body });
    expect(vi.getTimerCount()).toBe(1);
    // 闸门关着：到点跳过但照常重排
    vi.advanceTimersByTime(90_000);
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    wrapper = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('样式：crimson 下整层 display: none，且没有循环动画', () => {
    const css = styleBlocks(glintSource);
    expect(css).toMatch(/:root\[data-theme='crimson'\] \.fx-overlay\.fx-glint \{\s*display: none;/);
    expect(css).not.toMatch(/infinite|animation:/);
  });
});
