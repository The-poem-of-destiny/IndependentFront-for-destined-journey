/**
 * PluginSurfaceLayer — 游戏页的插件界面图层（插件系统设计 §4.7、§5.7、§6.5）
 *
 * 覆盖：
 * - 按 openSurfaces 渲染 PluginSurface（window / overlay），属性与 mountFrame 接线、close / focus 回调
 * - panel 形态：属于 panel.items.footer 的交给 ItemsPanel（图层跳过），别的贡献点退化成浮动窗
 * - 浮动窗层级按聚焦序取名次，夹在 overlay 与页面级弹窗之间
 * - 外链弹窗：v-if externalLink，关闭 → closeExternalLink
 * - 锁横幅：waiting / unsupported 显示且带「重试」，held / released 不显示
 * - 插件窗口不碰 game.activeModal（图层压根不读 game-store）
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PluginSurfaceLayer from '../../../../src/ui/components/game/PluginSurfaceLayer.vue';
import PluginSurface from '../../../../src/ui/components/game/PluginSurface.vue';
import {
  pluginEntriesFake,
  pluginEntry,
  pluginRuntimeFake,
  pluginSurface,
  resetPluginUiFakes,
} from '../../../helpers/plugin-ui-fakes';

vi.mock('../../../../src/ui/stores/plugin-runtime-store', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginRuntimeStoreModule(),
);
vi.mock('../../../../src/ui/composables/usePluginContributions', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginContributionsModule(),
);

/** 图层不该读 game-store（插件窗不占 activeModal）：一旦有人引入就当场炸 */
const gameStoreTouched = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => {
    gameStoreTouched.count += 1;
    return new Proxy(
      {},
      {
        get(_t, key) {
          throw new Error(`插件图层不该读 game-store（读了 ${String(key)}）`);
        },
      },
    );
  },
}));

let wrapper: VueWrapper | null = null;

function mountLayer() {
  wrapper = mount(PluginSurfaceLayer, { attachTo: document.body });
  return wrapper;
}

beforeEach(() => {
  resetPluginUiFakes();
  gameStoreTouched.count = 0;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('PluginSurfaceLayer — 界面渲染', () => {
  it('没有打开的界面时什么都不画', () => {
    const w = mountLayer();
    expect(w.findAllComponents(PluginSurface)).toHaveLength(0);
    expect(w.find('[data-testid="plugin-lock-banner"]').exists()).toBe(false);
  });

  it('每个打开的界面一块 PluginSurface，属性原样传下去，帧经 mountFrameFor 挂', async () => {
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({
        surfaceId: 's-1',
        networked: true,
        width: 480,
        height: 320,
        requestedSize: { width: 500, height: 300 },
      }),
      pluginSurface({ surfaceId: 's-2', contributionId: 'board', mode: 'overlay', zIndex: 3 }),
    ];
    const w = mountLayer();
    await flushPromises();
    const surfaces = w.findAllComponents(PluginSurface);
    expect(surfaces).toHaveLength(2);

    const first = surfaces[0].props();
    expect(first).toMatchObject({
      pluginId: 'shop',
      pluginName: '杂货铺',
      networked: true,
      mode: 'window',
      title: '商店',
      width: 480,
      height: 320,
      requestedSize: { width: 500, height: 300 },
    });
    expect(surfaces[1].props('mode')).toBe('overlay');
    expect(pluginRuntimeFake.mountFrameFor).toHaveBeenCalledWith('s-1');
    expect(pluginRuntimeFake.mountFrameFor).toHaveBeenCalledWith('s-2');
  });

  it('close → closeSurface，focus → focusSurface', async () => {
    pluginRuntimeFake.openSurfaces = [pluginSurface({ surfaceId: 's-1' })];
    const w = mountLayer();
    const surface = w.getComponent(PluginSurface);
    surface.vm.$emit('focus');
    expect(pluginRuntimeFake.focusSurface).toHaveBeenCalledWith('s-1');
    surface.vm.$emit('close');
    expect(pluginRuntimeFake.closeSurface).toHaveBeenCalledWith('s-1');
    await flushPromises();
    expect(w.findAllComponents(PluginSurface)).toHaveLength(0);
  });

  it('点界面上的关闭按钮同样走 closeSurface', async () => {
    pluginRuntimeFake.openSurfaces = [pluginSurface({ surfaceId: 's-1' })];
    const w = mountLayer();
    await w.get('[data-testid="plugin-surface-close"]').trigger('click');
    expect(pluginRuntimeFake.closeSurface).toHaveBeenCalledWith('s-1');
  });

  it('浮动窗层级按聚焦序取名次：后聚焦的在上，且夹在 overlay 与弹窗遮罩之间', () => {
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({ surfaceId: 's-a', contributionId: 'a', zIndex: 57 }),
      pluginSurface({ surfaceId: 's-b', contributionId: 'b', zIndex: 4 }),
    ];
    const w = mountLayer();
    const [a, b] = w.findAllComponents(PluginSurface);
    const za = a.props('zIndex')!;
    const zb = b.props('zIndex')!;
    expect(za).toBeGreaterThan(zb);
    expect(zb).toBeGreaterThan(200);
    expect(za).toBeLessThan(300);
  });

  it('panel 形态属于 panel.items.footer 的交给 ItemsPanel，图层跳过', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'panel.items.footer', contributionId: 'appraise', surface: 'panel' }),
    ];
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({ surfaceId: 's-p', contributionId: 'appraise', mode: 'panel' }),
    ];
    const w = mountLayer();
    expect(w.findAllComponents(PluginSurface)).toHaveLength(0);
  });

  it('别的贡献点上的 panel 形态没有面板可挂，退化成浮动窗', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'game.toolbar', contributionId: 'notes', surface: 'panel' }),
    ];
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({ surfaceId: 's-n', contributionId: 'notes', mode: 'panel' }),
    ];
    const w = mountLayer();
    expect(w.getComponent(PluginSurface).props('mode')).toBe('window');
  });

  it('插件窗口不碰 game.activeModal：图层不读 game-store', () => {
    pluginRuntimeFake.openSurfaces = [pluginSurface()];
    mountLayer();
    expect(gameStoreTouched.count).toBe(0);
  });
});

describe('PluginSurfaceLayer — 外链弹窗', () => {
  it('externalLink 为 null 时不弹', () => {
    mountLayer();
    expect(document.querySelector('[data-external-url]')).toBeNull();
  });

  it('有外链请求 → 弹窗显示插件名与完整地址；关闭 → closeExternalLink', async () => {
    pluginRuntimeFake.externalLink = {
      pluginName: '杂货铺',
      url: 'https://example.org/wiki/shop',
    };
    mountLayer();
    await flushPromises();
    expect(document.querySelector('[data-external-url]')!.textContent).toBe(
      'https://example.org/wiki/shop',
    );
    expect(document.body.textContent).toContain('杂货铺');
    (document.querySelector('[data-link-action="close"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(pluginRuntimeFake.closeExternalLink).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-external-url]')).toBeNull();
  });
});

describe('PluginSurfaceLayer — 跨标签页锁横幅（§6.5）', () => {
  it.each(['held', 'released'] as const)('lockState=%s 时不显示横幅', (state) => {
    pluginRuntimeFake.lockState = state;
    const w = mountLayer();
    expect(w.find('[data-testid="plugin-lock-banner"]').exists()).toBe(false);
  });

  it('waiting：说明另一个标签页持有存档、插件写入已暂停', () => {
    pluginRuntimeFake.lockState = 'waiting';
    const w = mountLayer();
    const banner = w.get('[data-testid="plugin-lock-banner"]');
    expect(banner.text()).toContain('另一个标签页');
    expect(banner.text()).toContain('插件写入已暂停');
    expect(banner.attributes('role')).toBe('status');
  });

  it('unsupported：说明浏览器环境不支持、插件写入已禁用', () => {
    pluginRuntimeFake.lockState = 'unsupported';
    const w = mountLayer();
    const banner = w.get('[data-testid="plugin-lock-banner"]');
    expect(banner.text()).toContain('不支持');
    expect(banner.text()).toContain('插件写入已禁用');
  });

  it('点「重试」→ retryLock；锁拿到后横幅收起', async () => {
    pluginRuntimeFake.lockState = 'waiting';
    const w = mountLayer();
    await w.get('[data-testid="plugin-lock-retry"]').trigger('click');
    expect(pluginRuntimeFake.retryLock).toHaveBeenCalledTimes(1);
    pluginRuntimeFake.lockState = 'held';
    await flushPromises();
    expect(w.find('[data-testid="plugin-lock-banner"]').exists()).toBe(false);
  });
});
