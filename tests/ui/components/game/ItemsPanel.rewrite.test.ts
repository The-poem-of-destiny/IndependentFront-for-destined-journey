/**
 * ItemsPanel — 单条目重铸 UI（2026-08-24）
 *
 * 覆盖：
 * - 背包/装备/技能条目都出现「重铸」按钮
 * - 点击展开描述输入 + 确认
 * - 确认后调 game.rewriteLoadoutItem（角色名 = 玩家名，target 含当前条目完整数据，含玩家描述）
 * - 成功/失败 toast
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ItemsPanel from '../../../../src/ui/components/game/ItemsPanel.vue';
import {
  pluginEntriesFake,
  pluginEntry,
  pluginRuntimeFake,
  pluginSurface,
  resetPluginUiFakes,
} from '../../../helpers/plugin-ui-fakes';

// ---- Mocks ----

let mockGame: any;
let mockUi: any;

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => mockUi,
}));

// 插件运行时与贡献点用替身（真 store 会去读 game.saves，这里的 game-store 是精简 mock）
vi.mock('../../../../src/ui/stores/plugin-runtime-store', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginRuntimeStoreModule(),
);
vi.mock('../../../../src/ui/composables/usePluginContributions', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginContributionsModule(),
);

function makePlayer() {
  return {
    name: '理查德',
    type: 'player',
    money: 500,
    inventory: [
      { name: '生命药水', quantity: 3, type: '消耗品', rarity: '普通', description: '回血药水' },
      {
        name: '精铁长剑',
        quantity: 1,
        type: '装备',
        rarity: '稀有',
        equippedSlot: '武器',
        stats: { 攻击力: 30 },
        description: '锋利长剑',
      },
    ],
    skills: [
      {
        name: '火球术',
        type: 'active',
        description: '掷出火球',
        level: 1,
        cost: { type: 'MP', amount: 10 },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginUiFakes();
  mockGame = {
    player: makePlayer(),
    pendingItemFocus: null,
    clearItemFocus: vi.fn(),
    removeItem: vi.fn(async () => ({ ok: true })),
    removeSkill: vi.fn(async () => ({ ok: true })),
    rewriteLoadoutItem: vi.fn(async () => ({ ok: true })),
  };
  mockUi = {
    toast: vi.fn(),
  };
});

function mountPanel() {
  return mount(ItemsPanel);
}

describe('ItemsPanel — 重铸', () => {
  it('背包条目：重铸按钮出现，展开描述输入，确认后调 rewriteLoadoutItem（inventory target）', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    // 默认背包 tab；列表按品质排序（精铁长剑 稀有 在 生命药水 普通 之前），点中生命药水那一行
    const rows = wrapper.findAll('.item-row');
    const potionRow = rows.find((r) => r.text().includes('生命药水'))!;
    await potionRow.trigger('click');
    await flushPromises();

    const btn = wrapper.find('.rewrite-btn');
    expect(btn.exists()).toBe(true);

    await btn.trigger('click');
    const body = wrapper.find('.rewrite-body');
    expect(body.exists()).toBe(true);
    expect(wrapper.find('.rewrite-desc').exists()).toBe(true);

    await wrapper.find('.rewrite-desc').setValue('生命药水效果不对，应该回 50 HP');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    expect(mockGame.rewriteLoadoutItem).toHaveBeenCalledTimes(1);
    const [charId, target, desc] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(charId).toBe('理查德');
    expect(desc).toBe('生命药水效果不对，应该回 50 HP');
    expect(target.kind).toBe('inventory');
    expect(target.entry.name).toBe('生命药水');
    expect(target.entry.quantity).toBe(3);
    expect(mockUi.toast).toHaveBeenCalledWith(expect.stringContaining('生命药水'), 'success');
  });

  it('装备条目：切到装备 tab，重铸 target 是 equipment（含 slot/stats）', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    // 切到装备 tab
    const catBtns = wrapper.findAll('.cat-tabs button');
    await catBtns[1].trigger('click');
    await flushPromises();

    const btn = wrapper.find('.rewrite-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    const [, target] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(target.kind).toBe('equipment');
    expect(target.entry.name).toBe('精铁长剑');
    expect(target.entry.slot).toBe('武器');
    expect(target.entry.stats).toEqual({ 攻击力: 30 });
  });

  it('技能条目：切到技能 tab，重铸 target 是 skill', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const catBtns = wrapper.findAll('.cat-tabs button');
    await catBtns[2].trigger('click');
    await flushPromises();

    const btn = wrapper.find('.rewrite-btn');
    await btn.trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    const [, target] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(target.kind).toBe('skill');
    expect(target.entry.name).toBe('火球术');
    expect(target.entry.cost).toEqual({ type: 'MP', amount: 10 });
  });

  it('重铸失败 → toast error 显示引擎 reason', async () => {
    mockGame.rewriteLoadoutItem = vi.fn(async () => ({
      ok: false,
      reason: 'item_gen 未声明替换目标（replace 属性缺失或点名与目标不符）',
    }));
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    expect(mockUi.toast).toHaveBeenCalledWith(expect.stringContaining('未声明替换目标'), 'error');
  });

  it('切换条目后重铸输入区收起', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    expect(wrapper.find('.rewrite-body').exists()).toBe(true);

    // 点击列表第二个条目（精铁长剑在背包 tab 也可见）
    const rows = wrapper.findAll('.item-row');
    await rows[1].trigger('click');
    await flushPromises();

    expect(wrapper.find('.rewrite-body').exists()).toBe(false);
  });
});

/**
 * 插件插槽 `panel.items.footer`（插件系统设计 §5.7）：每个贡献先是一颗入口按钮；
 * panel 形态打开后内联成 PluginSurface，随面板卸载一起关掉；window / overlay 形态交给游戏页图层。
 */
describe('ItemsPanel — 插件插槽 panel.items.footer', () => {
  it('没有贡献时不渲染插槽', () => {
    const wrapper = mountPanel();
    expect(wrapper.find('.plugin-footer').exists()).toBe(false);
  });

  it('只收 panel.items.footer 贡献：入口按钮文本插值，点了 openSurface', async () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'panel.items.footer', contributionId: 'appraise', label: '<i>鉴定</i>' }),
      pluginEntry({ slot: 'game.toolbar', contributionId: 'shop' }),
    ];
    const wrapper = mountPanel();
    const buttons = wrapper.findAll('[data-plugin-slot]');
    expect(buttons.map((b) => b.attributes('data-plugin-slot'))).toEqual(['shop/appraise']);
    expect(buttons[0].find('.plugin-footer-label').text()).toBe('<i>鉴定</i>');
    expect(buttons[0].find('.plugin-footer-label i').exists()).toBe(false);
    await buttons[0].trigger('click');
    expect(pluginRuntimeFake.openSurface).toHaveBeenCalledWith('shop', 'appraise');
  });

  it('入口按钮的图标只用宿主重编码的 PNG', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    pluginEntriesFake.value = [pluginEntry({ slot: 'panel.items.footer', icon: png })];
    const wrapper = mountPanel();
    expect(wrapper.get('[data-plugin-slot="shop/main"] img').attributes('src')).toBe(png);
  });

  it('panel 形态已打开 → 内联 PluginSurface 并挂帧，卸载面板时关掉它', async () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'panel.items.footer', contributionId: 'appraise', surface: 'panel' }),
    ];
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({ surfaceId: 's-panel', contributionId: 'appraise', mode: 'panel' }),
    ];
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-plugin-slot]').exists()).toBe(false);
    const surface = wrapper.get('.plugin-footer .plugin-surface');
    expect(surface.classes()).toContain('ps-panel');
    expect(pluginRuntimeFake.mountFrameFor).toHaveBeenCalledWith('s-panel');

    wrapper.unmount();
    expect(pluginRuntimeFake.closeSurface).toHaveBeenCalledWith('s-panel');
  });

  it('window 形态开着时插槽仍显示入口按钮（窗口归游戏页图层），卸载面板不关它', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'panel.items.footer', contributionId: 'appraise', surface: 'window' }),
    ];
    pluginRuntimeFake.openSurfaces = [
      pluginSurface({ surfaceId: 's-win', contributionId: 'appraise', mode: 'window' }),
    ];
    const wrapper = mountPanel();
    expect(wrapper.find('[data-plugin-slot="shop/appraise"]').exists()).toBe(true);
    expect(wrapper.find('.plugin-footer .plugin-surface').exists()).toBe(false);
    wrapper.unmount();
    expect(pluginRuntimeFake.closeSurface).not.toHaveBeenCalled();
  });
});
