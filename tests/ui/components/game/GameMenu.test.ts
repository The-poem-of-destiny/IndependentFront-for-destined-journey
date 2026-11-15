/**
 * GameMenu — 游戏页的二级菜单（2026-09-13）
 *
 * 这个组件存在的理由就是「顶栏不再直接摆着退出/设置/全屏三颗按钮」，所以这里测的
 * 几乎全是**接线**：每一项点下去到底调了谁的哪个入口。断错了不会报错，只会静默不生效。
 *
 * 覆盖:
 * - 五项齐全（少一项 = 某个入口从界面上消失）、且没有已退役的「全屏」项
 * - 设置 / 扩展 / 存档管理 / 返回首页 各自的目标调用 + 触发后关菜单
 * - 帮助说明是**二级面板**（不 navigate、不 close，标题跟着换），且能退回主菜单
 * - 每次重新打开都回到主菜单（否则第二次打开会停在帮助页）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import GameMenu from '../../../../src/ui/components/game/GameMenu.vue';
import {
  pluginEntriesFake,
  pluginEntry,
  pluginRuntimeFake,
  resetPluginUiFakes,
} from '../../../helpers/plugin-ui-fakes';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSaveManager: vi.fn(),
  confirmLeaveGame: vi.fn(async (_destination: string) => true),
}));

vi.mock('../../../../src/ui/lib/leave-game-guard', () => ({
  confirmLeaveGame: mocks.confirmLeaveGame,
}));

vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ navigate: mocks.navigate, openSaveManager: mocks.openSaveManager }),
}));

// 插件运行时与贡献点用替身（真 store 会去读 game.saves，这里的 game-store 是精简 mock）
vi.mock('../../../../src/ui/stores/plugin-runtime-store', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginRuntimeStoreModule(),
);
vi.mock('../../../../src/ui/composables/usePluginContributions', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginContributionsModule(),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirmLeaveGame.mockResolvedValue(true);
  resetPluginUiFakes();
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

/** 弹窗 Teleport 到 body，断言一律在 document 上找；每次挂载前先拆上次的 */
function menu(open = true) {
  wrapper?.unmount();
  wrapper = mount(GameMenu, { props: { open }, attachTo: document.body });
  return wrapper;
}

const item = (id: string) =>
  document.querySelector(`[data-menu="${id}"]`) as HTMLButtonElement | null;
const label = (id: string) => item(id)?.querySelector('.menu-item-label')?.textContent?.trim();
const title = () => document.querySelector('.modal-title')?.textContent?.trim();

describe('GameMenu — 主菜单', () => {
  it('open=false 时不渲染', () => {
    menu(false);
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('五项按“设置 / 扩展 / 存档管理 / 返回首页 / 帮助说明”排序', () => {
    menu();
    expect(
      [...document.querySelectorAll('[data-menu]')].map((el) => el.getAttribute('data-menu')),
    ).toEqual(['settings', 'extensions', 'saves', 'home', 'help']);
    expect(item('fullscreen')).toBeNull();
  });

  it('点「设置」→ navigate 设置页并关菜单', async () => {
    menu();
    item('settings')!.click();
    await flushPromises();
    expect(mocks.confirmLeaveGame).toHaveBeenCalledWith('设置');
    expect(mocks.navigate).toHaveBeenCalledWith('settings');
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('点「存档管理」→ 直接打开应用级窗口，不导航，并关菜单', async () => {
    menu();
    item('saves')!.click();
    await wrapper!.vm.$nextTick();
    expect(mocks.openSaveManager).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('点「返回首页」→ navigate home 并关菜单', async () => {
    menu();
    item('home')!.click();
    await flushPromises();
    expect(mocks.navigate).toHaveBeenCalledWith('home');
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('点「扩展」→ navigate 扩展管理页并关菜单', async () => {
    menu();
    expect(label('extensions')).toBe('扩展');
    item('extensions')!.click();
    await flushPromises();
    expect(mocks.navigate).toHaveBeenCalledWith('extensions');
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });
});

describe('GameMenu — 离开游戏页确认（GAME-08）', () => {
  it.each([
    ['settings', '设置'],
    ['extensions', '扩展'],
    ['home', '首页'],
  ])('「%s」在离开确认被取消时不导航，但菜单照样关掉', async (id, destination) => {
    mocks.confirmLeaveGame.mockResolvedValueOnce(false);
    menu();
    item(id)!.click();
    await flushPromises();
    expect(mocks.confirmLeaveGame).toHaveBeenCalledWith(destination);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('「存档管理」不离开游戏页，不需要确认', async () => {
    menu();
    item('saves')!.click();
    await flushPromises();
    expect(mocks.confirmLeaveGame).not.toHaveBeenCalled();
  });
});

describe('GameMenu — 帮助说明（二级面板）', () => {
  it('点「帮助说明」→ 换面板而非导航', async () => {
    menu();
    item('help')!.click();
    await wrapper!.vm.$nextTick();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toBeUndefined();
    expect(title()).toBe('帮助说明');
    expect(document.querySelector('[data-menu="help"]')).toBeNull();
    expect(document.querySelectorAll('.help-row').length).toBeGreaterThan(0);
  });

  it('帮助内容覆盖 Esc 与右键菜单这两条容易漏的交互', async () => {
    menu();
    item('help')!.click();
    await wrapper!.vm.$nextTick();
    const text = document.querySelector('.help-panel')!.textContent ?? '';
    expect(text).toContain('Esc');
    expect(text).toContain('右键');
  });

  it('「← 返回菜单」→ 回到五项', async () => {
    menu();
    item('help')!.click();
    await wrapper!.vm.$nextTick();
    (document.querySelector('.help-back') as HTMLButtonElement).click();
    await wrapper!.vm.$nextTick();
    expect(title()).toBe('游戏菜单');
    expect(item('home')).not.toBeNull();
  });

  it('关掉再打开 → 重新停在主菜单', async () => {
    menu();
    item('help')!.click();
    await wrapper!.vm.$nextTick();
    await wrapper!.setProps({ open: false });
    await wrapper!.setProps({ open: true });
    expect(title()).toBe('游戏菜单');
    expect(item('help')).not.toBeNull();
  });
});

/** 插件菜单项（插件系统设计 §5.7 `game.menu`）：排在内置五项之后，纯文本，点了先关菜单再开界面 */
describe('GameMenu — 插件菜单项', () => {
  it('只有 game.menu 贡献进菜单，排在内置五项之后', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'game.menu', contributionId: 'ledger', label: '账本' }),
      pluginEntry({ slot: 'game.toolbar', contributionId: 'shop' }),
    ];
    menu();
    const pluginItems = [...document.querySelectorAll('[data-plugin-menu]')];
    expect(pluginItems.map((el) => el.getAttribute('data-plugin-menu'))).toEqual(['shop/ledger']);
    const all = [...document.querySelectorAll('.menu-list > button')];
    expect(all[all.length - 1]).toBe(pluginItems[0]);
    // 内置五项不受影响
    expect(document.querySelectorAll('[data-menu]')).toHaveLength(5);
  });

  it('标签与插件名只做文本插值，不显示插件图标', () => {
    pluginEntriesFake.value = [
      pluginEntry({
        slot: 'game.menu',
        label: '<b>账本</b>',
        icon: 'data:image/png;base64,iVBORw0KGgo=',
      }),
    ];
    menu();
    const el = document.querySelector('[data-plugin-menu="shop/main"]')!;
    expect(el.querySelector('.menu-item-label')!.textContent).toBe('<b>账本</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.menu-item-hint')!.textContent).toContain('杂货铺');
  });

  it('点插件项 → 先关菜单，再 openSurface', async () => {
    pluginEntriesFake.value = [pluginEntry({ slot: 'game.menu', contributionId: 'ledger' })];
    menu();
    (document.querySelector('[data-plugin-menu="shop/ledger"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(wrapper!.emitted('close')).toHaveLength(1);
    expect(pluginRuntimeFake.openSurface).toHaveBeenCalledWith('shop', 'ledger');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
