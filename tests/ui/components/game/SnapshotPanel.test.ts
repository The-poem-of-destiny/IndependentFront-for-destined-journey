/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import SnapshotPanel from '../../../../src/ui/components/game/SnapshotPanel.vue';

enableAutoUnmount(afterEach);

const getSnapshots = vi.hoisted(() => vi.fn());
const ui = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn() }));
const game = vi.hoisted(() => ({
  activeSaveId: 'save-1' as string | null,
  activeSave: { activeSnapshotId: null as string | null },
  activeModal: 'snapshots' as string | null,
  isInCombat: false,
  isAgentCombat: false,
  isGenerating: false,
  messages: [] as unknown[],
  closeModal: vi.fn(),
  restoreToSnapshot: vi.fn(),
}));

const confirmDialog = vi.hoisted(() => vi.fn());
vi.mock('@engine/persistence/database', () => ({ getSnapshots }));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ui }));

describe('SnapshotPanel 时间线恢复结果', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.activeSaveId = 'save-1';
    game.activeSave = { activeSnapshotId: null };
    game.activeModal = 'snapshots';
    game.isInCombat = false;
    game.isAgentCombat = false;
    game.isGenerating = false;
    game.messages = [];
    confirmDialog.mockResolvedValue(true);
    getSnapshots.mockResolvedValue([
      {
        id: 'snap-1',
        saveId: 'save-1',
        createdAt: 1000,
        reason: 'turn',
        turn: 1,
      },
    ]);
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
    game.restoreToSnapshot.mockResolvedValueOnce({
      status: 'restored',
      continuation: 'same-save',
    });
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
      continuation: 'save-switched',
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

describe('SnapshotPanel 辨认信息与状态（SNP-01/03/04）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    game.activeSaveId = 'save-1';
    game.activeSave = { activeSnapshotId: null };
    game.activeModal = 'snapshots';
    game.isAgentCombat = false;
    game.isGenerating = false;
    game.messages = [];
    confirmDialog.mockResolvedValue(true);
    getSnapshots.mockResolvedValue([
      { id: 'snap-1', saveId: 'save-1', createdAt: 1000, reason: 'turn', turn: 1 },
    ]);
  });

  it('行上显示那一回合的玩家输入与正文首句；恢复确认框复述输入', async () => {
    const longInput =
      '我拔出长剑，悄悄绕到守卫身后，准备在他转身之前把他击倒，然后夺下钥匙打开牢门救出同伴';
    game.messages = [
      { id: 'u1', role: 'user', content: longInput, timestamp: 500, turn: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '<maintext>守卫猛然回头。火光在他眼中跳动。</maintext>',
        timestamp: 600,
        turn: 1,
      },
    ];
    const wrapper = mount(SnapshotPanel);
    await flushPromises();

    const ctx = wrapper.get('.snap-context');
    expect(ctx.text()).toContain('守卫猛然回头。');
    expect(ctx.text()).not.toContain('火光');
    // 截断的输入可展开看全文
    expect(ctx.get('details .snap-input-full').text()).toBe(longInput);
    expect(ctx.get('summary').text()).toContain('…');

    await wrapper.get('.snap-actions button').trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        danger: true,
        title: expect.stringContaining('第 1 回合'),
        details: expect.arrayContaining([expect.stringContaining('我拔出长剑')]),
      }),
    );
  });

  it('找不到对应消息时不显示辨认信息', async () => {
    game.messages = [{ id: 'u9', role: 'user', content: '别的回合', timestamp: 500, turn: 2 }];
    const wrapper = mount(SnapshotPanel);
    await flushPromises();
    expect(wrapper.find('.snap-context').exists()).toBe(false);
  });

  it('确认框取消则不恢复', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = mount(SnapshotPanel);
    await flushPromises();
    await wrapper.get('.snap-actions button').trigger('click');
    await flushPromises();
    expect(game.restoreToSnapshot).not.toHaveBeenCalled();
  });

  it('生成进行中：恢复按钮置灰并显示原因', async () => {
    game.isGenerating = true;
    const wrapper = mount(SnapshotPanel);
    await flushPromises();
    expect(wrapper.get('.snap-actions button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.combat-warn').text()).toContain('正在生成');
  });

  it('读取失败显示错误态（不是「暂无快照」），可重试', async () => {
    getSnapshots.mockRejectedValueOnce(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(SnapshotPanel);
    await flushPromises();
    expect(wrapper.find('.empty').exists()).toBe(false);
    expect(wrapper.get('.load-error').text()).toContain('读取失败');

    await wrapper.get('.load-error button').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.snapshot-card')).toHaveLength(1);
  });
});
