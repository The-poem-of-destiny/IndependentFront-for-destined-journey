/**
 * plot-chapter-mask.test.ts — 章节 / 总纲摘要的防剧透判定（PLT-01）
 *
 * 钉的是：未到达的章节标题与摘要、总纲摘要此前从不打码；现在与事件同一口径 ——
 * 剧透模式只允许逐条 peek，当前章与已过去的章始终可见；时间线章节条同样遵守。
 */
import { describe, expect, it } from 'vitest';
import type { PlotEvent } from '@engine/types/types';
import {
  chapterPeekKey,
  isChapterMasked,
  isOutlineEventMasked,
  maskedChapterLabel,
} from '../../../../src/ui/components/game/plot-thread-view';
import { buildPlotTimeline } from '../../../../src/ui/components/game/plot-timeline';

function ev(over: Partial<PlotEvent> & { id: string; title: string }): PlotEvent {
  return {
    saveId: 's1',
    description: '',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    visibility: 'revealed',
    depth: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const none = new Set<string>();

describe('章节蒙版判定', () => {
  it('pending 且未揭示的章节蒙版；active / completed 始终可见', () => {
    expect(isChapterMasked({ title: '甲', status: 'pending' }, none)).toBe(true);
    expect(isChapterMasked({ title: '甲', status: 'active' }, none)).toBe(false);
    expect(isChapterMasked({ title: '甲', status: 'completed' }, none)).toBe(false);
  });

  it('对应大事件已揭示时，pending 章节也可见', () => {
    expect(isChapterMasked({ title: '甲', status: 'pending', visibility: 'revealed' }, none)).toBe(
      false,
    );
  });

  it('peek 之后可见；peek 键与事件 id 不撞车', () => {
    expect(isChapterMasked({ title: '甲', status: 'pending' }, new Set(['甲']))).toBe(true);
    expect(
      isChapterMasked({ title: '甲', status: 'pending' }, new Set([chapterPeekKey('甲')])),
    ).toBe(false);
  });

  it('蒙版标题只暴露序号', () => {
    expect(maskedChapterLabel(2)).toBe('第 3 章 · ？？？');
  });

  it('事件蒙版口径不变：未揭示且未 peek', () => {
    const hidden = { id: 'e1', visibility: 'hidden' as const };
    expect(isOutlineEventMasked(hidden, none)).toBe(true);
    expect(isOutlineEventMasked(hidden, new Set(['e1']))).toBe(false);
    expect(isOutlineEventMasked({ id: 'e2', visibility: 'revealed' }, none)).toBe(false);
  });
});

describe('时间线章节条蒙版', () => {
  const events = (): PlotEvent[] => [
    ev({ id: 'ch-1', title: '王都惊变', chapterTitle: '王都惊变', depth: 0, status: 'active' }),
    ev({
      id: 'ch-2',
      title: '血色纹章',
      chapterTitle: '血色纹章',
      depth: 0,
      order: 1,
      status: 'pending',
      visibility: 'hidden',
    }),
    ev({ id: 'e1', title: '甲', chapterTitle: '王都惊变', parentId: 'ch-1' }),
    ev({ id: 'e2', title: '乙', chapterTitle: '血色纹章', parentId: 'ch-2' }),
  ];

  it('🔴 未到达章节的真名不进显示名；路由仍按真名连线', () => {
    const model = buildPlotTimeline({
      events: events(),
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 20,
    });
    const names = model.chapters.map((c) => c.name);
    expect(names).toContain('王都惊变');
    expect(names).toContain('第 2 章 · ？？？');
    expect(names).not.toContain('血色纹章');
    expect(model.chapters.find((c) => c.key === '血色纹章')?.masked).toBe(true);
    // 两章各一条「章节条 → 事件」连线，蒙版不影响路由
    expect(model.edges.filter((e) => e.kind === 'outline')).toHaveLength(2);
  });

  it('peek 章节键后显示真名', () => {
    const model = buildPlotTimeline({
      events: events(),
      threadView: null,
      nowEpochMinutes: null,
      peekedEventIds: new Set([chapterPeekKey('血色纹章')]),
      pxPerDay: 20,
    });
    expect(model.chapters.map((c) => c.name)).toContain('血色纹章');
  });
});
