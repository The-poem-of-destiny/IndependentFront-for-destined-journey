/**
 * DebugPanel.vue — 最近 10 回合 Agent 调试历史
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import DebugPanel from './DebugPanel.vue';
import { useGameStore } from '../../stores/game-store';
import type { DebugAgentEntry, DebugTurnRecord } from '@engine/types';

beforeEach(() => setActivePinia(createPinia()));

function entry(turnId: string, agentId: string, hit: number): DebugAgentEntry {
  return {
    invocationId: `${turnId}:${agentId}:1`,
    turnId,
    agentId,
    label: agentId,
    endpointId: 'ep',
    endpointName: 'DeepSeek',
    baseUrl: 'https://api.example.test',
    model: 'model',
    messages: [{ role: 'system', content: `${agentId}-prompt` }],
    rawResponse: `${agentId}-response`,
    providerRounds: [
      { round: 1, tokensUsed: hit + 2, cacheHit: hit > 0, cacheHitTokens: hit, duration: 12 },
    ],
    promptSessionRevision: agentId === 'story' ? 2 : undefined,
    promptRebased: false,
    tokensUsed: hit + 2,
    cacheHit: hit > 0,
    cacheHitTokens: hit,
    cacheMissTokens: 1,
    completionTokens: 1,
    duration: 12,
    startedAt: 100,
    completedAt: 112,
  };
}

function turn(id: string, number: number, entries: DebugAgentEntry[]): DebugTurnRecord {
  return {
    id,
    saveId: 'save-debug',
    turn: number,
    status: 'completed',
    startedAt: number * 100,
    completedAt: number * 100 + 20,
    entries,
  };
}

describe('DebugPanel · Agent 历史', () => {
  it('可切换最近回合，且汇总包含 memory_recall', async () => {
    const game = useGameStore();
    game.agentLogHistory.push(
      turn('run-1', 1, [entry('run-1', 'story', 3)]),
      turn('run-2', 2, [entry('run-2', 'memory_recall', 7)]),
    );

    const wrapper = mount(DebugPanel);

    expect(wrapper.get('select.debug-turn-select').attributes('aria-label')).toBe(
      '选择调试历史回合',
    );
    expect(wrapper.text()).toContain('Agent 调用历史 (2/10 回合)');
    expect(wrapper.findAll('.debug-turn-select option')).toHaveLength(2);
    expect(wrapper.text()).toContain('含记忆召回 · 1 次调用');
    expect(wrapper.text()).toContain('命中 7');

    await wrapper.find('.debug-turn-select').setValue('run-1');
    expect(wrapper.text()).toContain('story');
    expect(wrapper.text()).toContain('Delta revision 2');
    expect(wrapper.text()).toContain('Provider 往返 (1)');
  });
});
