/**
 * FxAtmosphere — 时段 / 天气 / 战斗氛围层
 *
 * 本组件没有脚本状态，一切由 html 上的 data-fx-* 属性经 CSS 驱动，所以这里钉的是**结构契约**：
 * 每一层都常驻且 aria-hidden；战斗暗角 Teleport 到 body 且叠在战斗遮罩之上；
 * 样式源码守住设计约束（时段染色 alpha 0.08–0.09、染色与雾都遮掉阅读栏、雨丝 0.135、
 * 不用混合模式 / 背景滤镜、不动 background-position）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import FxAtmosphere from '../../../../src/ui/components/fx/FxAtmosphere.vue';
import source from '../../../../src/ui/components/fx/FxAtmosphere.vue?raw';
import combatSource from '../../../../src/ui/components/game/combat/CombatPanel.vue?raw';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function mountLayer() {
  wrapper = mount(FxAtmosphere, { attachTo: document.body });
  return wrapper;
}

/** 选择器列表里含 `selector` 的每条规则的声明体（不含 @ 规则里的嵌套块） */
function rulesFor(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').some((s) => s.trim() === selector))
    .map(([, , body]) => body);
}

/** 只取 <style> 块（注释里允许提到被禁止的写法） */
function styleBlocks(): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
}

describe('FxAtmosphere — 结构', () => {
  it('根是不吃指针的覆盖层，三层时段染色 + 雾 + 两条雨丝常驻', () => {
    mountLayer();
    const root = document.querySelector('.fx-atmosphere');
    expect(root).not.toBeNull();
    expect(root?.classList.contains('fx-overlay')).toBe(true);
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    for (const p of ['dawn', 'dusk', 'night']) {
      expect(root?.querySelector(`.fx-atmosphere__tint--${p}`)).not.toBeNull();
    }
    expect(root?.querySelector('.fx-atmosphere__fog')).not.toBeNull();
    expect(root?.querySelectorAll('.fx-atmosphere__rain-strip')).toHaveLength(2);
  });

  it('战斗暗角 Teleport 到 body，不在游戏页布局里', () => {
    mountLayer();
    const vignette = document.querySelector('body > .fx-combat-vignette');
    expect(vignette).not.toBeNull();
    expect(vignette?.getAttribute('aria-hidden')).toBe('true');
    expect(vignette?.querySelector('.fx-combat-vignette__shade')).not.toBeNull();
  });
});

describe('FxAtmosphere — 样式契约', () => {
  const css = styleBlocks();

  it('时段染色 alpha：黎明 / 黄昏 0.08、夜晚 0.09（深色主题上要看得出，又不超过 0.09）', () => {
    const tints = Object.fromEntries(
      [...css.matchAll(/\.fx-atmosphere__tint--(\w+)\s*\{\s*background:\s*rgba\(([^)]+)\)/g)].map(
        ([, part, args]) => [part, Number(args.split(',').pop())],
      ),
    );
    expect(tints).toEqual({ dawn: 0.08, dusk: 0.08, night: 0.09 });
  });

  it('时段染色与雾都用 25/50/25 遮罩抠掉中间阅读栏', () => {
    for (const cls of ['fx-atmosphere__tint', 'fx-atmosphere__fog']) {
      const masked = rulesFor(css, `.${cls}`).filter((body) => /(^|[^-])mask-image:/.test(body));
      expect(masked, cls).toHaveLength(1);
      expect(masked[0]).toMatch(/#000 19%,\s*transparent 25%,\s*transparent 75%,\s*#000 81%/);
    }
  });

  it('雨丝开启时整层 opacity 为 0.135（原 0.09 的 1.5 倍）', () => {
    const body = rulesFor(css, ":root[data-fx-weather='rain'] .fx-atmosphere__rain")[0] ?? '';
    expect(body).toMatch(/opacity:\s*0\.135;/);
  });

  it('不用 mix-blend-mode / backdrop-filter，不动 background-position', () => {
    expect(css).not.toMatch(/mix-blend-mode/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/background-position/);
  });

  it('不做常驻循环动画（雨丝是静止的）', () => {
    expect(css).not.toMatch(/infinite/);
  });

  it('战斗暗角 z-index 高于战斗遮罩及其固定控件', () => {
    const combatZ = [...combatSource.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
    const vignetteZ = Number(
      /\.fx-combat-vignette\s*\{\s*z-index:\s*(\d+)/.exec(css)?.[1] ?? Number.NaN,
    );
    expect(vignetteZ).toBeGreaterThan(Math.max(...combatZ));
    // 仍低于 Toast（2000）
    expect(vignetteZ).toBeLessThan(2000);
  });

  it('战斗中把 .combat-panel 的 --combat-inlay 染向 --theme-error', () => {
    expect(combatSource).toMatch(/--combat-inlay:/);
    expect(css).toMatch(
      /\[data-fx-combat='on'\] \.combat-panel\s*\{\s*--combat-inlay:[^}]*var\(--theme-error\)/,
    );
  });
});
