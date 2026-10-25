/**
 * StoryMemoryV2Panel.test.ts — 测试档记忆面板（计划 §12.2）
 *
 * 1. 长期总览只列当前分支上有效的归档，点开看到详细记录、依据与来源原文；
 * 2. 未结事件按事件名列出未归档摘要；
 * 3. 短期摘要按回合列出，已归档的标注出来，原文可展开回查；
 * 4. 普通存档的记忆面板不显示这一套。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { ChatMessage, StoryArchiveRecord, StoryTurnSummaryRecord } from '@engine/types/types';
import { collectCompleteStoryTurns } from '@engine/memory/memory-context';
import { storyTurnSource, storySegmentFingerprint } from '@engine/memory/story-memory-source';

const { getStoryTurnSummariesMock, getStoryArchivesMock } = vi.hoisted(() => ({
  getStoryTurnSummariesMock: vi.fn(),
  getStoryArchivesMock: vi.fn(),
}));

let mockGame: Record<string, unknown>;
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('@engine/persistence/database', () => ({
  getStoryTurnSummaries: getStoryTurnSummariesMock,
  getStoryArchives: getStoryArchivesMock,
  deleteMemory: vi.fn(),
}));

import MemoryPanel from '../../../../src/ui/components/game/MemoryPanel.vue';

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '接委托', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '老人托你送信。', timestamp: 2 },
  { id: 'u2', role: 'user', content: '找猫', timestamp: 3 },
  { id: 'a2', role: 'assistant', content: '你在巷子里看见一只猫。', timestamp: 4 },
  { id: 'u3', role: 'user', content: '交信', timestamp: 5 },
  { id: 'a3', role: 'assistant', content: '收信人收下了信。', timestamp: 6 },
];

function seg(id: string, turn: number, eventName: string, content: string): StoryTurnSummaryRecord {
  return {
    id,
    saveId: 's1',
    ...storyTurnSource(collectCompleteStoryTurns(messages).find((t) => t.key === `u${turn}`)!),
    order: 0,
    content,
    eventName,
    createdAt: turn,
  };
}

const archive: StoryArchiveRecord = {
  id: 'arc1',
  saveId: 's1',
  eventName: '送信',
  outcome: 'completed',
  evidence: '收信人收下了信',
  overview: '把信送到了收信人手里',
  detail: { cause: '老人托付', process: '', ending: '送达', promises: '报酬三十银币', impact: '' },
  detailSource: 'source-text',
  coveredSegmentIds: ['s1', 's3'],
  ...storyTurnSource(collectCompleteStoryTurns(messages)[2]),
  coveredSources: [0, 2].map((i) => storyTurnSource(collectCompleteStoryTurns(messages)[i])),
  coveredSegmentFingerprints: Object.fromEntries(
    [seg('s1', 1, '送信', '接下送信委托'), seg('s3', 3, '送信', '把信交出去')].map((s) => [
      s.id,
      storySegmentFingerprint(s),
    ]),
  ),
  sequence: 0,
  createdAt: 3,
};

beforeEach(() => {
  mockGame = {
    activeSaveId: 's1',
    activeSave: { id: 's1', metadata: { storyContextV2: { schema: 1, markedAt: 1 } } },
    messages,
    isGenerating: false,
    recentMemories: [],
    characters: [],
  };
  getStoryTurnSummariesMock.mockReset();
  getStoryArchivesMock.mockReset();
  getStoryTurnSummariesMock.mockResolvedValue([
    seg('s1', 1, '送信', '接下送信委托'),
    seg('s2', 2, '寻猫', '看见一只猫'),
    seg('s3', 3, '送信', '把信交出去'),
  ]);
  getStoryArchivesMock.mockResolvedValue([archive]);
});

async function mountPanel() {
  const wrapper = mount(MemoryPanel);
  await flushPromises();
  return wrapper;
}

describe('StoryMemoryV2Panel', () => {
  it('长期总览列出有效归档；点开看到详细记录、依据与来源原文', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain('把信送到了收信人手里');
    expect(wrapper.text()).toContain('成功完成');

    await wrapper.find('button[aria-label="查看归档：送信"]').trigger('click');
    const text = wrapper.text();
    expect(text).toContain('依据事件原文整理');
    expect(text).toContain('报酬三十银币');
    expect(text).toContain('收信人收下了信');
    expect(text).toContain('来源原文（2 个回合）');
    expect(text).toContain('老人托你送信。');
    expect(text).not.toContain('你在巷子里看见一只猫。');
  });

  it('回退掉的归档不显示', async () => {
    getStoryArchivesMock.mockResolvedValue([{ ...archive, sourceMessageIds: ['u9', 'a9'] }]);
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain('还没有事件结束。');
  });

  it('未结事件只列未归档的事件', async () => {
    const wrapper = await mountPanel();
    await wrapper.findAll('[role="tab"]')[1].trigger('click');
    expect(wrapper.text()).toContain('寻猫');
    expect(wrapper.text()).toContain('看见一只猫');
    expect(wrapper.text()).not.toContain('接下送信委托');
  });

  it('短期摘要标注已归档，原文可展开回查', async () => {
    const wrapper = await mountPanel();
    await wrapper.findAll('[role="tab"]')[2].trigger('click');
    expect(wrapper.text()).toContain('第 3 回合');
    expect(wrapper.findAll('.archived-tag')).toHaveLength(2);
    expect(wrapper.text()).not.toContain('你在巷子里看见一只猫。');
    const toggle = wrapper.findAll('button[aria-expanded]')[1]; // 第 2 回合（新的在前）
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.text()).toContain('你在巷子里看见一只猫。');
  });

  it('普通存档不显示新模式记忆面板', async () => {
    mockGame.activeSave = { id: 's1', metadata: {} };
    const wrapper = await mountPanel();
    expect(wrapper.find('.v2-memory').exists()).toBe(false);
    expect(getStoryTurnSummariesMock).not.toHaveBeenCalled();
  });
});

describe('A12 摘要定位信息与来源失效说明', () => {
  it('显示人物、地点、主题和原回合时间范围，缺字段标未知不伪造', async () => {
    const time = { era: '纪元', year: 1, month: 2, day: 3, weekday: 1, hour: 21, minute: 30 };
    getStoryTurnSummariesMock.mockResolvedValue([
      {
        ...seg('s2', 2, '寻猫', '看见一只猫'),
        characters: ['旅伴'],
        locations: ['北巷'],
        topics: ['寻猫'],
        gameTimeRange: { start: time, end: null },
      },
      seg('s3', 3, '送信', '把信交出去'),
    ]);
    const wrapper = await mountPanel();
    await wrapper.findAll('[role="tab"]')[2].trigger('click');
    const text = wrapper.get('[role="tabpanel"]').text();
    expect(text).toContain('人物旅伴');
    expect(text).toContain('地点北巷');
    expect(text).toContain('主题寻猫');
    expect(text).toContain('21:30 — 未知');
    expect(text).toContain('未知（未记录）');
  });

  it('旧缺指纹摘要和同 ID 正文修订摘要均失效，面板明确说明需补建', async () => {
    const old = { ...seg('s2', 2, '寻猫', '旧内容不应展示'), sourceFingerprint: undefined };
    getStoryTurnSummariesMock.mockResolvedValue([old]);
    const wrapper = await mountPanel();
    await wrapper.findAll('[role="tab"]')[2].trigger('click');
    expect(wrapper.text()).not.toContain('旧内容不应展示');
    expect(wrapper.text()).toContain('无法验证，需重新补建');
    wrapper.unmount();
    getStoryTurnSummariesMock.mockResolvedValue([seg('s2', 2, '寻猫', '旧内容不应展示')]);
    mockGame.messages = messages.map((m) =>
      m.id === 'a2' ? { ...m, content: '同 ID 的新正文' } : m,
    );
    const changed = await mountPanel();
    await changed.findAll('[role="tab"]')[2].trigger('click');
    expect(changed.text()).not.toContain('旧内容不应展示');
    expect(changed.text()).toContain('无法验证，需重新补建');
  });
});

it('同 ID 覆盖摘要语义被改写时，不显示旧归档、不再标记已归档', async () => {
  getStoryTurnSummariesMock.mockResolvedValue([
    seg('s1', 1, '送信', '同ID新摘要'),
    seg('s3', 3, '送信', '把信交出去'),
  ]);
  const wrapper = await mountPanel();
  expect(wrapper.text()).not.toContain('把信送到了收信人手里');
  await wrapper.findAll('[role="tab"]')[2].trigger('click');
  expect(wrapper.text()).toContain('同ID新摘要');
  expect(wrapper.findAll('.archived-tag')).toHaveLength(0);
});
