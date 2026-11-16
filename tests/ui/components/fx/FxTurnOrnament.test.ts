/**
 * FxTurnOrnament — 顶栏回合纹饰
 *
 * 守的是：只在星盘 / 机巧两套主题渲染；挂载首帧直接落在当前角度、不带过渡；
 * 之后小步递增才过渡，倒退直接到位；换主题跟着换（或撤掉）纹饰；卸载断开监听。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FxTurnOrnament from '../../../../src/ui/components/fx/FxTurnOrnament.vue';
import ornamentSource from '../../../../src/ui/components/fx/FxTurnOrnament.vue?raw';

function setTheme(slug: string | null): void {
  if (slug === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', slug);
}

afterEach(() => {
  setTheme(null);
});

describe('FxTurnOrnament', () => {
  it('星盘：首帧直接落在当前角度，不带过渡', () => {
    setTheme('obsidian');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 5 } });
    const pointer = w.get('[data-part="pointer"]');
    expect(w.get('.fx-turn-ornament').attributes('data-ornament')).toBe('orrery');
    expect(pointer.attributes('style')).toContain('rotate(30deg)');
    expect(pointer.classes()).not.toContain('is-stepping');
    expect(w.find('.fx-orn-ring').exists()).toBe(true);
    w.unmount();
  });

  it('星盘：回合 +1 时指针走 6° 并带过渡', async () => {
    setTheme('obsidian');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 5 } });
    await w.setProps({ settledTurn: 6 });
    const pointer = w.get('[data-part="pointer"]');
    expect(pointer.attributes('style')).toContain('rotate(36deg)');
    expect(pointer.classes()).toContain('is-stepping');
    w.unmount();
  });

  it('回档（回合倒退）与大跨度跳变直接到位', async () => {
    setTheme('obsidian');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 5 } });
    await w.setProps({ settledTurn: 6 });
    await w.setProps({ settledTurn: 4 });
    expect(w.get('[data-part="pointer"]').classes()).not.toContain('is-stepping');
    await w.setProps({ settledTurn: 40 });
    const pointer = w.get('[data-part="pointer"]');
    expect(pointer.classes()).not.toContain('is-stepping');
    expect(pointer.attributes('style')).toContain('rotate(240deg)');
    w.unmount();
  });

  it('机巧：擒纵轮每回合走一齿，首帧不过渡、递增才过渡', async () => {
    setTheme('bronze');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 2 } });
    const gear = () => w.get('[data-part="gear"]');
    expect(gear().attributes('style')).toContain('rotate(60deg)');
    expect(gear().classes()).not.toContain('is-stepping');
    await w.setProps({ settledTurn: 3 });
    expect(gear().attributes('style')).toContain('rotate(90deg)');
    expect(gear().classes()).toContain('is-stepping');
    w.unmount();
  });

  it('其它主题什么都不渲染', () => {
    for (const slug of ['crimson', 'sakura', 'parchment', 'indigo', 'ocean', 'ivory']) {
      setTheme(slug);
      const w = mount(FxTurnOrnament, { props: { settledTurn: 3 } });
      expect(w.find('.fx-turn-ornament').exists()).toBe(false);
      expect(w.find('svg').exists()).toBe(false);
      w.unmount();
    }
  });

  it('换主题跟着换纹饰，新纹饰首帧同样不过渡', async () => {
    setTheme('obsidian');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 5 } });
    await w.setProps({ settledTurn: 6 });

    setTheme('bronze');
    await flushPromises();
    expect(w.get('.fx-turn-ornament').attributes('data-ornament')).toBe('escapement');
    expect(w.get('[data-part="gear"]').classes()).not.toContain('is-stepping');

    setTheme('crimson');
    await flushPromises();
    expect(w.find('.fx-turn-ornament').exists()).toBe(false);
    w.unmount();
  });

  it('强度集中在三档变量：次刻度 < 刻度环 < 指针 / 齿轮，且不超过 50%', () => {
    const css = [...ornamentSource.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n');
    const levels = Object.fromEntries(
      [...css.matchAll(/--fx-orn-alpha-(\w+):\s*(\d+(?:\.\d+)?)%/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    const read = (name: string) => levels[name];
    const minor = read('minor');
    const ring = read('ring');
    const accent = read('accent');
    expect(minor).toBeLessThan(ring);
    expect(ring).toBeLessThan(accent);
    expect(accent).toBeLessThanOrEqual(50);
    // 不再有写死的百分比：所有 color-mix 都走这三档变量
    expect(css).not.toMatch(/var\(--theme-primary\)\s+\d/);
  });

  it('星盘：次刻度与主刻度分档，指针走强调档', () => {
    setTheme('obsidian');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 1 } });
    expect(w.findAll('.fx-orn-ring .fx-orn-minor').length).toBeGreaterThan(0);
    expect(w.findAll('.fx-orn-ring .fx-orn-major').length).toBeGreaterThan(0);
    expect(w.find('[data-part="pointer"] .fx-orn-accent').exists()).toBe(true);
    w.unmount();
  });

  it('卸载后不再跟随主题变化', async () => {
    setTheme('crimson');
    const w = mount(FxTurnOrnament, { props: { settledTurn: 1 } });
    w.unmount();
    setTheme('obsidian');
    await flushPromises();
    expect(w.find('.fx-turn-ornament').exists()).toBe(false);
  });
});
