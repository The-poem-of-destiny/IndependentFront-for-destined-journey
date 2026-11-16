/**
 * TurnRecoveryPanel —— 「去设置」先过离开游戏页确认（GAME-05 + GAME-08）；原因未保留时如实说
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import TurnRecoveryPanel from '../../../../src/ui/components/game/TurnRecoveryPanel.vue';

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  confirmLeaveGame: vi.fn(async (_destination: string) => true),
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ openSettings: mocks.openSettings }),
}));
vi.mock('../../../../src/ui/lib/leave-game-guard', () => ({
  confirmLeaveGame: mocks.confirmLeaveGame,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirmLeaveGame.mockResolvedValue(true);
});

const configFailure = { failure: { category: 'config' as const }, message: '中断' };

describe('TurnRecoveryPanel', () => {
  it('「去设置」确认后打开 API 设置', async () => {
    const wrapper = mount(TurnRecoveryPanel, { props: configFailure });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '去设置')!
      .trigger('click');
    await flushPromises();
    expect(mocks.confirmLeaveGame).toHaveBeenCalledWith('设置');
    expect(mocks.openSettings).toHaveBeenCalledWith('api');
  });

  it('离开确认被取消 → 不打开设置', async () => {
    mocks.confirmLeaveGame.mockResolvedValueOnce(false);
    const wrapper = mount(TurnRecoveryPanel, { props: configFailure });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '去设置')!
      .trigger('click');
    await flushPromises();
    expect(mocks.openSettings).not.toHaveBeenCalled();
  });

  it('网络类失败（服务地址可能填错）也给「去设置」', () => {
    const wrapper = mount(TurnRecoveryPanel, {
      props: { failure: { category: 'network' as const }, message: '中断', canRetry: true },
    });
    expect(wrapper.findAll('button').map((b) => b.text())).toContain('去设置');
  });

  it('原因未保留时如实说明，不编造分类', () => {
    const wrapper = mount(TurnRecoveryPanel, {
      props: { message: '上一回合没有完成。', causeUnknown: true, canRetry: true },
    });
    expect(wrapper.text()).toContain('原因未保留');
    expect(wrapper.find('details').exists()).toBe(false);
  });

  it('「回退并修改输入」只在宿主开启时出现，点击发出 rollback-edit', async () => {
    const without = mount(TurnRecoveryPanel, {
      props: { message: '中断', canRetry: true, canRollbackRetry: true },
    });
    expect(without.findAll('button').map((b) => b.text())).not.toContain('回退并修改输入');

    const wrapper = mount(TurnRecoveryPanel, {
      props: { message: '中断', canRetry: true, canRollbackRetry: true, canRollbackEdit: true },
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '回退并修改输入')!
      .trigger('click');
    expect(wrapper.emitted('rollback-edit')).toHaveLength(1);
    expect(wrapper.emitted('rollback-retry')).toBeUndefined();
  });
});
