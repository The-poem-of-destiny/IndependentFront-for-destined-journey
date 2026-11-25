/**
 * TurnSeal — 回合印记
 *
 * 守的是：主题 → 形制只有一张表（表外落到方印）；随 `<html data-theme>` 切换形制；
 * 只在 `pressed` 时挂盖印类与洇墨环；对读屏隐藏；所有印记共用 fx-theme-signature 的
 * 一份主题观察（引用计数开关），最后一枚卸载即停。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import TurnSeal from '../../../../src/ui/components/game/TurnSeal.vue';

/** 透传真实实现，只记调用：确认印记复用 fx-theme-signature 的主题观察 */
const themeSpy = vi.hoisted(() => ({ observe: 0, stop: 0 }));

vi.mock('../../../../src/ui/lib/fx-theme-signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/ui/lib/fx-theme-signature')>();
  return {
    ...actual,
    observeThemeSlug: (cb: (slug: string | null) => void) => {
      themeSpy.observe++;
      const stop = actual.observeThemeSlug(cb);
      return () => {
        themeSpy.stop++;
        stop();
      };
    },
  };
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

function shapeUnder(theme: string | null): string | undefined {
  if (theme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const wrapper = mount(TurnSeal);
  const shape = wrapper.find('svg').attributes('data-shape');
  wrapper.unmount();
  return shape;
}

describe('主题 → 印记形制（唯一一张表）', () => {
  it('朱文方印 / 火漆圆封 / 星芒符印，表外与缺省落到方印', () => {
    const expected: Record<string, string> = {
      parchment: 'square',
      indigo: 'square',
      sakura: 'square',
      crimson: 'square',
      bronze: 'wax',
      ivory: 'wax',
      forest: 'wax',
      obsidian: 'star',
      ocean: 'star',
      'misty-lilac': 'star',
      'unknown-theme': 'square',
    };
    for (const [theme, shape] of Object.entries(expected)) {
      expect(shapeUnder(theme), theme).toBe(shape);
    }
    expect(shapeUnder(null)).toBe('square');
  });
});

describe('TurnSeal', () => {
  it('随 data-theme 切换形制，且对读屏隐藏', async () => {
    document.documentElement.setAttribute('data-theme', 'ocean');
    const wrapper = mount(TurnSeal);
    const svg = wrapper.find('svg');
    expect(svg.attributes('data-shape')).toBe('star');
    expect(svg.attributes('aria-hidden')).toBe('true');

    document.documentElement.setAttribute('data-theme', 'bronze');
    await flushPromises();
    expect(wrapper.find('svg').attributes('data-shape')).toBe('wax');
    wrapper.unmount();
  });

  it('只有 pressed 时才挂盖印类与洇墨环', async () => {
    const wrapper = mount(TurnSeal);
    expect(wrapper.classes()).not.toContain('is-pressed');
    expect(wrapper.find('.turn-seal-ring').exists()).toBe(false);
    await wrapper.setProps({ pressed: true });
    expect(wrapper.classes()).toContain('is-pressed');
    expect(wrapper.find('.turn-seal-ring').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('主题观察复用 fx-theme-signature', () => {
  it('多枚印记共用一份观察，最后一枚卸载才停；之后再挂重新观察', async () => {
    themeSpy.observe = 0;
    themeSpy.stop = 0;
    document.documentElement.setAttribute('data-theme', 'forest');
    const a = mount(TurnSeal);
    const b = mount(TurnSeal);
    expect(themeSpy.observe).toBe(1);

    document.documentElement.setAttribute('data-theme', 'obsidian');
    await flushPromises();
    expect(a.find('svg').attributes('data-shape')).toBe('star');
    expect(b.find('svg').attributes('data-shape')).toBe('star');

    a.unmount();
    expect(themeSpy.stop).toBe(0);
    b.unmount();
    expect(themeSpy.stop).toBe(1);

    // 无印记期间换主题，新挂的印记读到当前值
    document.documentElement.setAttribute('data-theme', 'ivory');
    const c = mount(TurnSeal);
    expect(themeSpy.observe).toBe(2);
    expect(c.find('svg').attributes('data-shape')).toBe('wax');
    c.unmount();
    expect(themeSpy.stop).toBe(2);
  });
});
