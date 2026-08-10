/**
 * @vitest-environment jsdom
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgentActivityRun } from '@engine/types';
import TurnActivityLedger from './TurnActivityLedger.vue';

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
});
