/**
 * FxPlateParallax — 底盘视差层的组件契约
 *
 * 钉的是：只在 obsidian / misty-lilac 渲染底盘副本并注册 -2px 视差；其余主题（含 bronze / forest
 * 这两个有对位叠层的）不渲染也不注册；换主题与卸载时注销；样式只靠 inherit，不改主题表。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const unregister = vi.fn();
const registerParallax = vi.fn((_el: HTMLElement, _depth: number) => unregister);
vi.mock('../../../../src/ui/lib/fx-pointer', () => ({
  registerParallax: (el: HTMLElement, depth: number) => registerParallax(el, depth),
  subscribePointer: () => () => {},
}));

import FxPlateParallax from '../../../../src/ui/components/fx/FxPlateParallax.vue';
import source from '../../../../src/ui/components/fx/FxPlateParallax.vue?raw';
import { useThemeStore } from '../../../../src/ui/stores/theme-store';

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  registerParallax.mockClear();
  unregister.mockClear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

async function mountWithTheme(theme: string) {
  useThemeStore().current = theme;
  wrapper = mount(FxPlateParallax, { attachTo: document.body });
  await nextTick();
  return wrapper;
}

describe('FxPlateParallax', () => {
  it.each(['obsidian', 'misty-lilac'])('%s：渲染底盘副本与静止描边，注册 -2px 视差', async (t) => {
    await mountWithTheme(t);
    const root = document.querySelector('.fx-plate-parallax');
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.classList.contains('fx-plate-parallax--active')).toBe(true);
    const plate = root?.querySelector('.fx-plate');
    expect(plate).not.toBeNull();
    expect(root?.querySelector('.fx-plate-frame')).not.toBeNull();
    expect(registerParallax).toHaveBeenCalledTimes(1);
    expect(registerParallax).toHaveBeenCalledWith(plate, -2);
  });

  it.each(['bronze', 'forest', 'crimson', 'parchment', 'ivory', 'ocean', 'indigo', 'sakura'])(
    '%s：不渲染底盘副本、不注册视差',
    async (t) => {
      await mountWithTheme(t);
      const root = document.querySelector('.fx-plate-parallax');
      expect(root).not.toBeNull();
      expect(root?.classList.contains('fx-plate-parallax--active')).toBe(false);
      expect(root?.querySelector('.fx-plate')).toBeNull();
      expect(registerParallax).not.toHaveBeenCalled();
    },
  );

  it('切到不支持的主题即注销；卸载时也注销', async () => {
    await mountWithTheme('obsidian');
    useThemeStore().current = 'bronze';
    await nextTick();
    await nextTick();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.fx-plate')).toBeNull();

    useThemeStore().current = 'misty-lilac';
    await nextTick();
    await nextTick();
    expect(registerParallax).toHaveBeenCalledTimes(2);
    wrapper?.unmount();
    wrapper = null;
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it('样式只用 inherit 取底盘，不出现任何主题选择器或背景图', () => {
    const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n');
    expect(css).not.toMatch(/data-theme/);
    expect(css).not.toMatch(/url\(/);
    expect(css).toMatch(/background: inherit/);
    expect(css).toMatch(/box-shadow: inherit/);
  });
});
