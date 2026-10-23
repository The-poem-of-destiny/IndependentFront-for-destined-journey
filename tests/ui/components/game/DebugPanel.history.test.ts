/**
 * DebugPanel.vue — 最近 10 回合 Agent 调试历史
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import DebugPanel from '../../../../src/ui/components/game/DebugPanel.vue';
import { useGameStore } from '../../../../src/ui/stores/game-store';
import type {
  DebugAgentEntry,
  DebugTurnRecord,
  StoryContextV2Diagnostics,
} from '@engine/types/types';

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

describe('DebugPanel · Story 分区（新模式）', () => {
  it('所选回合带 Story 新模式诊断时显示分区用量、召回与补建；旧模式回合不显示', async () => {
    const game = useGameStore();
    const v2Turn = turn('run-v2', 3, [entry('run-v2', 'story', 1)]);
    v2Turn.storyContext = {
      assembly: {
        windowTurns: 6,
        archiveIds: ['ar1'],
        windowTurnKeys: ['u1', 'u2'],
        summarySegmentIds: ['s1'],
        missingSummaryTurnKeys: ['u0'],
        zoneChars: { 1: 10, 2: 20, 3: 0, 4: 40, 5: 5 },
        totalChars: 75,
        estimatedTokens: 50,
        contextWindowTokens: 40,
        overBudget: true,
      },
      recall: {
        mode: 'llm',
        status: 'failed',
        error: '召回输出无法解析',
        notices: [],
        candidateCount: 3,
      },
      backfill: { turnKeys: ['u0'], failedTurnKeys: [] },
    };
    game.agentLogHistory.push(turn('run-old', 2, [entry('run-old', 'story', 1)]), v2Turn);

    const wrapper = mount(DebugPanel);
    expect(wrapper.text()).toContain('Story 分区（新模式 · 第 3 回合）');
    expect(wrapper.text()).toContain('各区字数: 1区 10 · 2区 20 · 3区 0 · 4区 40 · 5区 5');
    expect(wrapper.text()).toContain('⚠ 超出');
    expect(wrapper.text()).toContain('缺摘要回合: u0');
    expect(wrapper.text()).toContain('记忆召回（失败，本回合无召回）');
    expect(wrapper.text()).toContain('摘要补建: 成功 1 · 失败 0');

    await wrapper.find('.debug-turn-select').setValue('run-old');
    expect(wrapper.text()).not.toContain('Story 分区');
  });
});

it('A14 完整预算分类/实际预留/逐项原因与原文范围可定位，输入粗估不冒充provider usage', () => {
  const game = useGameStore();
  const record = turn('diagnostics-v2', 4, []);
  const categories: NonNullable<StoryContextV2Diagnostics['budgetCategories']> = {
    fixed: { chars: 10, estimatedTokens: 7 },
    longTerm: { chars: 20, estimatedTokens: 14 },
    region: { chars: 30, estimatedTokens: 20 },
    summary: { chars: 40, estimatedTokens: 27 },
    rawHistory: { chars: 50, estimatedTokens: 34 },
    turnLore: { chars: 60, estimatedTokens: 40 },
    recall: { chars: 70, estimatedTokens: 47 },
    currentFactsAndDirections: { chars: 80, estimatedTokens: 54 },
    outputReserve: { chars: 0, estimatedTokens: 1234 },
  };
  record.storyContext = {
    assembly: {
      windowTurns: 1,
      archiveIds: [],
      windowTurnKeys: ['u2'],
      summarySegmentIds: [],
      missingSummaryTurnKeys: [],
      zoneChars: { 1: 10, 2: 20, 3: 30, 4: 90, 5: 210 },
      totalChars: 360,
      estimatedTokens: 240,
      overBudget: false,
      outputReservedTokens: 1234,
      budgetCategories: categories,
      budgetRemovals: [
        {
          key: 'optional-lore',
          category: 'turnLore',
          chars: 900,
          estimatedTokens: 600,
          reason: 'EJS 前可选依赖组移除',
        },
        {
          key: 'memory_recall',
          category: 'recall',
          chars: 120,
          estimatedTokens: 80,
          reason: '保留完整原文，省略召回',
        },
      ],
    },
    lore: {
      status: 'ok',
      fixedKeys: ['fixed'],
      regionKeys: [],
      requiredKeys: [],
      candidateKeys: [],
      selectedKeys: [],
      supplementKeys: [],
      rejectedRefs: [],
      dependencyKeys: [],
      blockedDependencyKeys: ['blocked'],
      regionPath: ['北城'],
      regionSnapshotKey: 'snapshot',
      decisions: [
        { key: 'fixed', outcome: 'selected', zone: 1, reason: 'fixed' },
        { key: 'blocked', outcome: 'excluded', reason: 'dependency-not-readable' },
        { key: 'optional-lore', outcome: 'excluded', reason: 'budget-pruned' },
      ],
    },
    recall: {
      mode: 'llm',
      status: 'ok',
      candidateCount: 2,
      notices: [],
      expansion: {
        rawMode: 'snippet',
        selectedRefs: ['S1', 'S2'],
        rawTurnKeys: ['u1'],
        inWindowTurnKeys: [],
        omittedTurnKeys: ['u1'],
        rawChars: 100,
        chars: 200,
        paragraphRanges: [
          { ref: 'S1', turnKey: 'u1', start: 0, end: 2, omitted: false },
          { ref: 'S2', turnKey: 'u1', start: 8, end: 10, omitted: true },
        ],
      },
    },
  };
  // 调试展示只读显式诊断字段，不能把设备凭据或任意附加元数据整袋序列化。
  Object.assign(record.storyContext.assembly!, {
    apiKey: 'sk-device-secret',
    headers: { Authorization: 'Bearer private' },
  });
  game.agentLogHistory.push(record);
  const wrapper = mount(DebugPanel);
  const table = wrapper.get('[aria-label="Story 完整预算分类"]');
  expect(table.findAll('tbody tr')).toHaveLength(9);
  expect(table.text()).toContain('currentFactsAndDirections');
  expect(table.text()).toContain('outputReserve');
  expect(wrapper.text()).toContain('实际输出预留: 1234 token（请求参数预留，非 provider usage）');
  expect(wrapper.text()).toContain('不是 provider 计数');
  expect(wrapper.get('[aria-label="预算移除原因"]').text()).toContain(
    'optional-lore · 本轮世界资料 · 900 字符 / 约 600 token',
  );
  expect(wrapper.get('[aria-label="资料逐条选择与排除原因"]').text()).toContain(
    'blocked · 排除：依赖不可用：Story 无读取权限',
  );
  expect(wrapper.get('[aria-label="召回原文段落定位"]').text()).toContain(
    'S2 · u1 · 段落 9–11：预算省略（未展示）',
  );
  expect(wrapper.html()).not.toContain('sk-device-secret');
  expect(wrapper.html()).not.toContain('Bearer private');
});
