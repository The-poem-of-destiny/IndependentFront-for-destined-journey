/**
 * TurnSeal — 回合印记
 *
 * 守的是：主题 → 形制只有一张表（表外落到方印）；随 `<html data-theme>` 切换形制；
 * 只在 `pressed` 时挂盖印类与洇墨环；对读屏隐藏。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import TurnSeal from '../../../../src/ui/components/game/TurnSeal.vue';

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
  });

  it('只有 pressed 时才挂盖印类与洇墨环', async () => {
    const wrapper = mount(TurnSeal);
    expect(wrapper.classes()).not.toContain('is-pressed');
    expect(wrapper.find('.turn-seal-ring').exists()).toBe(false);
    await wrapper.setProps({ pressed: true });
    expect(wrapper.classes()).toContain('is-pressed');
    expect(wrapper.find('.turn-seal-ring').exists()).toBe(true);
  });
});
