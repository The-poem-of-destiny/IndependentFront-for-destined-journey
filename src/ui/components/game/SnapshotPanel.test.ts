/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import SnapshotPanel from './SnapshotPanel.vue';

enableAutoUnmount(afterEach);

const getSnapshots = vi.hoisted(() => vi.fn());
const ui = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn() }));
const game = vi.hoisted(() => ({
  activeSaveId: 'save-1' as string | null,
  activeSave: { activeSnapshotId: null as string | null },
  activeModal: 'snapshots' as string | null,
  isInCombat: false,
  closeModal: vi.fn(),
  restoreToSnapshot: vi.fn(),
}));

vi.mock('@engine/database', () => ({ getSnapshots }));
vi.mock('../../stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ui }));

describe('SnapshotPanel 时间线恢复结果', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.activeSaveId = 'save-1';
    game.activeSave = { activeSnapshotId: null };
    game.activeModal = 'snapshots';
    game.isInCombat = false;
    getSnapshots.mockResolvedValue([
      {
        id: 'snap-1',
        saveId: 'save-1',
        createdAt: 1000,
        reason: 'turn',
        turn: 1,
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('投影重载失败会提示并返回首页', async () => {
    game.restoreToSnapshot.mockResolvedValueOnce({
      status: 'projection-failed',
      error: '时间线已恢复，但界面重载失败，请重新进入存档',
    });
    const wrapper = mount(SnapshotPanel);
    await flushPromises();

    await wrapper.get('.snap-actions button').trigger('click');
    await flushPromises();

    expect(ui.toast).toHaveBeenCalledWith('时间线已恢复，但界面重载失败，请重新进入存档', 'error');
    expect(ui.navigate).toHaveBeenCalledWith('home');
    expect(game.closeModal).not.toHaveBeenCalled();
  });

  it('完整恢复成功会关闭面板且不导航', async () => {
    game.restoreToSnapshot.mockResolvedValueOnce({ status: 'restored' });
    const wrapper = mount(SnapshotPanel);
    await flushPromises();

    await wrapper.get('.snap-actions button').trigger('click');
    await flushPromises();

    expect(game.closeModal).toHaveBeenCalledTimes(1);
    expect(ui.navigate).not.toHaveBeenCalled();
  });

  it('恢复期间切换存档只提示 warning，不关闭新存档的弹窗', async () => {
    game.restoreToSnapshot.mockResolvedValueOnce({
      status: 'restored',
      warning: '时间线已恢复；当前已切换到其他存档',
    });
    const wrapper = mount(SnapshotPanel);
    await flushPromises();

    await wrapper.get('.snap-actions button').trigger('click');
    await flushPromises();

    expect(ui.toast).toHaveBeenCalledWith('时间线已恢复；当前已切换到其他存档', 'warning');
    expect(game.closeModal).not.toHaveBeenCalled();
    expect(ui.navigate).not.toHaveBeenCalled();
  });

  it('恢复前被拒绝会在面板内显示原因且恢复按钮可再次使用', async () => {
    game.restoreToSnapshot.mockResolvedValueOnce({
      status: 'rejected',
      error: '生成进行中，无法恢复',
    });
    const wrapper = mount(SnapshotPanel);
    await flushPromises();

    const button = wrapper.get('.snap-actions button');
    await button.trigger('click');
    await flushPromises();

    expect(wrapper.get('.error').text()).toBe('生成进行中，无法恢复');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(ui.navigate).not.toHaveBeenCalled();
  });
});
