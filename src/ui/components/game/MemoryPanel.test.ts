/**
 * MemoryPanel.test.ts — 记忆面板卡片墙 + 详情视图的界面性质
 *
 * 1. **规模可控** —— 超过一页（24 条）时分页出现，翻页能翻出后面的记忆。
 * 2. **找得到** —— 搜索过滤 content+keywords、重要度筛选、排序切换即时生效。
 * 3. **看得清** —— 卡片显示 ★/摘要/关键词/游戏时间；点卡进详情，全文不截断、
 *    关联角色解析成名字；返回回到卡片墙。
 * 4. **删除** —— 从详情删除调 deleteMemory 且从 store 移除、回到列表。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import type { MemoryRecord, CharacterState } from '@engine/types';
import { createDefaultCharacterState } from '@engine/types';

// ── 假 store ──

const deleteMemoryMock = vi.hoisted(() => vi.fn(async () => {}));
const recentMemories: MemoryRecord[] = reactive([]);
let mockGame: {
  recentMemories: MemoryRecord[];
  characters: CharacterState[];
};

vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('@engine/database', () => ({ deleteMemory: deleteMemoryMock }));

import MemoryPanel from './MemoryPanel.vue';

function mem(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    saveId: 's1',
    createdAt: 100,
    realTimestamp: 100,
    timeRange: { start: '复兴纪元488年3月5日', end: '复兴纪元488年3月8日' },
    content: `记忆${id}的正文，这是一个足够长以展示摘要截断行为的记忆内容，里面提到了铁蹄与血誓。`,
    hiddenLine: '',
    keywords: ['铁蹄', '血誓', '军粮'],
    relatedCharacterIds: [],
    importance: 5,
    ...over,
  };
}

function char(id: string, name: string): CharacterState {
  return createDefaultCharacterState({ id, type: 'npc', name, race: '人' });
}

beforeEach(() => {
  recentMemories.length = 0;
  mockGame = {
    recentMemories,
    characters: [char('player', '主角'), char('npc_001', '苏婉')],
  };
});

afterEach(() => {
  deleteMemoryMock.mockClear();
});

async function mountPanel() {
  const wrapper = mount(MemoryPanel, { attachTo: document.body });
  await nextTick();
  return wrapper;
}

describe('MemoryPanel 卡片墙', () => {
  it('按时间倒序渲染卡片墙，点卡进入详情、返回回到列表', async () => {
    recentMemories.push(mem('MEM000001', { createdAt: 1 }), mem('MEM000002', { createdAt: 2 }));

    const wrapper = await mountPanel();

    const cards = wrapper.findAll('.memory-card');
    expect(cards).toHaveLength(2);
    // 时间倒序：新（2）在前
    expect(cards[0]!.text()).toContain('MEM000002');
    expect(cards[1]!.text()).toContain('MEM000001');

    await cards[0]!.trigger('click');
    await nextTick();

    expect(wrapper.find('.memory-detail').exists()).toBe(true);
    expect(wrapper.find('.detail-content').text()).toContain('记忆MEM000002的正文');

    await wrapper.find('.back-btn').trigger('click');
    await nextTick();
    expect(wrapper.find('.memory-detail').exists()).toBe(false);
    expect(wrapper.findAll('.memory-card')).toHaveLength(2);
  });

  it('超过一页时显示分页，翻页能看到后面的记忆', async () => {
    for (let i = 1; i <= 30; i++)
      recentMemories.push(mem(`MEM${String(i).padStart(6, '0')}`, { createdAt: i }));

    const wrapper = await mountPanel();

    expect(wrapper.findAll('.memory-card')).toHaveLength(24);
    expect(wrapper.find('.pagination').exists()).toBe(true);
    expect(wrapper.find('.page-info').text()).toContain('第 1 / 2 页');

    await wrapper.find('.page-btn:last-child').trigger('click');
    await nextTick();
    expect(wrapper.findAll('.memory-card')).toHaveLength(6);
    expect(wrapper.find('.page-info').text()).toContain('第 2 / 2 页');
  });

  it('搜索即时过滤内容与关键词，无匹配时显示空态', async () => {
    recentMemories.push(
      mem('MEM000001', { content: '王城外的第一场雨', keywords: ['雨水'] }),
      mem('MEM000002', { content: '铁蹄踏过平原', keywords: ['军马'] }),
    );

    const wrapper = await mountPanel();
    await wrapper.find('.search-input').setValue('铁蹄');

    expect(wrapper.findAll('.memory-card')).toHaveLength(1);
    expect(wrapper.find('.memory-card').text()).toContain('铁蹄踏过平原');

    await wrapper.find('.search-input').setValue('不存在的词');
    expect(wrapper.findAll('.memory-card')).toHaveLength(0);
    expect(wrapper.find('.empty').text()).toContain('无匹配记忆');
  });

  it('重要度筛选只保留对应区间', async () => {
    recentMemories.push(
      mem('MEM000001', { importance: 9, content: '高重要度记忆内容' }),
      mem('MEM000002', { importance: 5, content: '中重要度记忆内容' }),
      mem('MEM000003', { importance: 2, content: '低重要度记忆内容' }),
    );

    const wrapper = await mountPanel();
    await wrapper.findAll('.sort-select')[1]!.setValue('high');
    expect(wrapper.findAll('.memory-card')).toHaveLength(1);
    expect(wrapper.find('.memory-card').text()).toContain('高重要度记忆内容');

    await wrapper.findAll('.sort-select')[1]!.setValue('low');
    expect(wrapper.findAll('.memory-card')).toHaveLength(1);
    expect(wrapper.find('.memory-card').text()).toContain('低重要度记忆内容');
  });

  it('排序切换：按重要度降序', async () => {
    recentMemories.push(
      mem('MEM000001', { createdAt: 3, importance: 3, content: '低重要度内容' }),
      mem('MEM000002', { createdAt: 2, importance: 9, content: '高重要度内容' }),
      mem('MEM000003', { createdAt: 1, importance: 6, content: '中重要度内容' }),
    );

    const wrapper = await mountPanel();
    await wrapper.findAll('.sort-select')[0]!.setValue('importance');

    const cards = wrapper.findAll('.memory-card');
    expect(cards[0]!.text()).toContain('高重要度内容');
    expect(cards[1]!.text()).toContain('中重要度内容');
  });
});

describe('MemoryPanel 详情', () => {
  it('显示全文（不截断）、全部关键词、关联角色名、ID 与真实时间', async () => {
    const longContent = '长'.repeat(300);
    recentMemories.push(
      mem('MEM000001', {
        content: longContent,
        keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        relatedCharacterIds: ['npc_001', 'player'],
        realTimestamp: 1700000000000,
      }),
    );

    const wrapper = await mountPanel();
    await wrapper.find('.memory-card').trigger('click');
    await nextTick();

    expect(wrapper.find('.detail-content').text()).toBe(longContent);
    expect(wrapper.findAll('.keyword')).toHaveLength(8);
    expect(wrapper.find('.detail-chars').text()).toContain('苏婉');
    expect(wrapper.find('.detail-chars').text()).toContain('主角');
    expect(wrapper.find('.detail-id').text()).toContain('MEM000001');
  });

  it('删除调 deleteMemory 并从 store 移除、回到卡片墙', async () => {
    recentMemories.push(mem('MEM000001'));

    const wrapper = await mountPanel();
    await wrapper.find('.memory-card').trigger('click');
    await nextTick();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await wrapper.find('.detail-actions .btn-danger').trigger('click');
    await flushPromises();

    expect(deleteMemoryMock).toHaveBeenCalledWith('MEM000001');
    expect(recentMemories).toHaveLength(0);
    expect(wrapper.find('.memory-detail').exists()).toBe(false);
    expect(wrapper.findAll('.memory-card')).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('复制内容调用 clipboard', async () => {
    recentMemories.push(mem('MEM000001', { content: '要复制的话' }));

    const wrapper = await mountPanel();
    await wrapper.find('.memory-card').trigger('click');
    await nextTick();

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await wrapper.find('.detail-actions .btn-secondary').trigger('click');

    expect(writeText).toHaveBeenCalledWith('要复制的话');
  });
});
