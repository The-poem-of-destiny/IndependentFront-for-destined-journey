/**
 * @vitest-environment jsdom
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgentActivityRun } from '@engine/types/types';
import TurnActivityLedger from '../../../../src/ui/components/game/TurnActivityLedger.vue';

function makeRun(overrides: Partial<AgentActivityRun> = {}): AgentActivityRun {
  return {
    id: 'run-1',
    sourceMessageId: 'message-1',
    status: 'running',
    startedAt: Date.now(),
    standalone: false,
    steps: [
      {
        id: 'step-1',
        agentId: 'craft_gen',
        label: '处理制作请求',
        status: 'running',
        startedAt: Date.now(),
        tools: [
          {
            id: 'tool-1',
            label: '查看随身物品',
            detail: '莱恩 · 3 件',
            status: 'completed',
            completedAt: Date.now(),
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('TurnActivityLedger', () => {
  it('shows game-language activity and nested tools without technical payloads', () => {
    const wrapper = mount(TurnActivityLedger, { props: { run: makeRun() } });

    expect(wrapper.text()).toContain('回合进程');
    expect(wrapper.text()).toContain('处理制作请求');
    expect(wrapper.text()).toContain('查看随身物品');
    expect(wrapper.text()).toContain('莱恩 · 3 件');
    expect(wrapper.text()).not.toContain('craft_gen');
    expect(wrapper.text()).not.toContain('get_inventory');
    wrapper.unmount();
  });

  it('润色侧链不写成回合：标题是「润色中 / 润色完成 / 润色未完成」（GAME-17）', async () => {
    const step = {
      id: 'step-p',
      agentId: 'prose_rewrite',
      label: '润色这一段正文',
      status: 'running' as const,
      startedAt: Date.now(),
      tools: [],
    };
    const wrapper = mount(TurnActivityLedger, {
      props: { run: makeRun({ standalone: true, steps: [step] }) },
    });
    expect(wrapper.get('.activity-heading strong').text()).toBe('润色中');
    expect(wrapper.text()).not.toContain('回合');

    await wrapper.setProps({
      run: makeRun({ standalone: true, status: 'completed', steps: [step] }),
    });
    expect(wrapper.get('.activity-heading strong').text()).toBe('润色完成');
    await wrapper.setProps({
      run: makeRun({ standalone: true, status: 'failed', steps: [step] }),
    });
    expect(wrapper.get('.activity-heading strong').text()).toBe('润色未完成');
    wrapper.unmount();
  });

  it('is keyboard-native and collapses from its heading button', async () => {
    const wrapper = mount(TurnActivityLedger, { props: { run: makeRun() } });
    const heading = wrapper.get('button.activity-heading');
    expect(heading.attributes('aria-expanded')).toBe('true');

    await heading.trigger('click');
    expect(heading.attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('offers retry only when the caller authorizes it', async () => {
    const run = makeRun({
      status: 'failed',
      completedAt: Date.now(),
      message: '世界的回应在此中断，可以再次尝试。',
    });
    const wrapper = mount(TurnActivityLedger, { props: { run, canRetry: true } });
    expect(wrapper.get('button.activity-heading').attributes('aria-expanded')).toBe('true');
    await wrapper.get('.activity-recovery button').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
    wrapper.unmount();
  });

  it('keeps a player-cancelled run open so recovery remains visible', () => {
    const run = makeRun({
      status: 'cancelled',
      completedAt: Date.now(),
      message: '本回合已停下，可以再次尝试。',
    });
    const wrapper = mount(TurnActivityLedger, { props: { run, canRetry: true } });

    expect(wrapper.get('button.activity-heading').attributes('aria-expanded')).toBe('true');
    expect(wrapper.text()).toContain('本回合已停下，可以再次尝试。');
    expect(wrapper.find('.activity-recovery button').exists()).toBe(true);
    wrapper.unmount();
  });

  it.each([
    ['failed', '世界的回应在此中断，可以再次尝试。'],
    ['cancelled', '本回合已停下，可以再次尝试。'],
  ] as const)(
    'reopens a manually collapsed active run when it becomes %s',
    async (status, message) => {
      const run = makeRun();
      const wrapper = mount(TurnActivityLedger, { props: { run, canRetry: true } });
      const heading = wrapper.get('button.activity-heading');

      await heading.trigger('click');
      expect(heading.attributes('aria-expanded')).toBe('false');

      await wrapper.setProps({
        run: {
          ...run,
          status,
          completedAt: Date.now(),
          message,
        },
      });

      expect(heading.attributes('aria-expanded')).toBe('true');
      expect(wrapper.get('.activity-recovery').text()).toContain(message);
      wrapper.unmount();
    },
  );

  // ===== GAME-05 / GAME-16 =====

  it('失败卡片写出归类原因、出错步骤与折叠的技术详情；密钥类给「去设置」', () => {
    const run = makeRun({
      status: 'failed',
      completedAt: Date.now(),
      message: '世界的回应在此中断，已写入的状态不会自动撤销。',
      failure: { category: 'auth', stepLabel: '书写此刻', detail: 'HTTP 401: [已隐藏的密钥]' },
    });
    const wrapper = mount(TurnActivityLedger, { props: { run, canRetry: true } });
    const recovery = wrapper.get('.activity-recovery');
    expect(recovery.text()).toContain('API 密钥无效或没有权限');
    expect(recovery.text()).toContain('出错的步骤：书写此刻');
    expect(recovery.get('details summary').text()).toBe('技术详情');
    expect(recovery.get('details').attributes('open')).toBeUndefined();
    expect(recovery.get('details code').text()).toBe('HTTP 401: [已隐藏的密钥]');
    expect(recovery.findAll('button').map((b) => b.text())).toContain('去设置');
    wrapper.unmount();
  });

  it('限流类不给「去设置」', () => {
    const run = makeRun({
      status: 'failed',
      completedAt: Date.now(),
      message: '中断',
      failure: { category: 'rate_limit' },
    });
    const wrapper = mount(TurnActivityLedger, { props: { run, canRetry: true } });
    expect(wrapper.get('.activity-recovery').text()).toContain('被模型服务限流');
    expect(wrapper.findAll('.activity-recovery button').map((b) => b.text())).not.toContain(
      '去设置',
    );
    wrapper.unmount();
  });

  it('两条出路说清楚：「再次尝试」保留已写内容、「回退并重试」先回退；各自发各自的事件', async () => {
    const run = makeRun({ status: 'failed', completedAt: Date.now(), message: '中断' });
    const wrapper = mount(TurnActivityLedger, {
      props: { run, canRetry: true, canRollbackRetry: true },
    });
    const text = wrapper.get('.activity-recovery').text();
    expect(text).toContain('保留这一回合已经写入的内容');
    expect(text).toContain('先回到上一回合结束时的状态');
    const buttons = wrapper.findAll('.activity-recovery button');
    await buttons.find((b) => b.text() === '回退并重试')!.trigger('click');
    expect(wrapper.emitted('rollback-retry')).toHaveLength(1);
    await buttons.find((b) => b.text() === '再次尝试')!.trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
    wrapper.unmount();
  });

  it('开场回合不能回退：只给「再次尝试」，并写明原因', () => {
    const run = makeRun({ status: 'failed', completedAt: Date.now(), message: '中断' });
    const wrapper = mount(TurnActivityLedger, {
      props: {
        run,
        canRetry: true,
        canRollbackRetry: false,
        rollbackBlockedReason: '开场回合不能回退或重新生成',
      },
    });
    const labels = wrapper.findAll('.activity-recovery button').map((b) => b.text());
    expect(labels).toContain('再次尝试');
    expect(labels).not.toContain('回退并重试');
    expect(wrapper.get('.activity-recovery').text()).toContain('开场回合不能回退或重新生成');
    wrapper.unmount();
  });
});
