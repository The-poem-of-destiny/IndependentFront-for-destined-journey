/**
 * plot-thread-debug.test.ts — 调试区块纯函数：判据必须来自生产函数（不复制第二份）
 */
import { describe, expect, it } from 'vitest';

import {
  applyThreadDeclarations,
  applyPlotThreadRevealed,
  type PlotThreadFlags,
} from '@engine/plot-threads';
import type { PlotEvent } from '@engine/types';
import type { GameTime } from '@engine/time-system';
import { buildPlotThreadDebugInfo, plotThreadGateReasonLabel } from './plot-thread-debug';

const TIME: GameTime = { era: '', year: 488, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 };

function flagsWith(): PlotThreadFlags {
  let flags = { nodes: {} } as PlotThreadFlags;
  flags = applyThreadDeclarations(
    flags,
    [
      { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      { name: 'B', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'dormant' },
      { name: 'C', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
    ],
    100,
  ).flags;
  flags = applyThreadDeclarations(flags, [], 100).flags;
  flags = applyPlotThreadRevealed(flags, ['A', 'B']).flags;
  flags = { ...flags, lastAdvancedTurn: 5, lastCommittedTurn: 5 };
  return flags;
}

function pendingEvents(
  win: Array<{ start: string; end: string } | undefined> = [{ start: '488-06', end: '488-07' }],
  extra: Partial<PlotEvent> = {},
): PlotEvent[] {
  return win.map((w, i) => {
    const base: PlotEvent = {
      id: `e${i}`,
      saveId: 's',
      title: `E${i}`,
      description: '',
      status: 'pending',
      childrenIds: [],
      order: i,
      relatedCharacterIds: [],
      worldLineChanged: false,
      visibility: 'hidden',
      depth: 0,
      createdAt: 0,
      updatedAt: 0,
      timeWindow: w,
    };
    return { ...base, ...extra } as PlotEvent;
  });
}

describe('buildPlotThreadDebugInfo —— 生产判据 + 计数', () => {
  it('计数与未揭示数准确；上次推进/收口回合来自 flags', () => {
    const info = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'main',
      saveId: 'save-debug',
      totalTurns: 8,
      currentTime: TIME,
      combatActive: false,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: pendingEvents(),
    });
    expect(info.nodeCount).toBe(3);
    expect(info.counts.active).toBe(2);
    expect(info.counts.dormant).toBe(1);
    expect(info.counts.resolved).toBe(0);
    expect(info.hiddenCount).toBe(1); // C 未揭示
    expect(info.lastAdvancedTurn).toBe(5);
    expect(info.lastCommittedTurn).toBe(5);
  });

  it('🔴 闸门结果是生产函数（evaluatePlotThreadGate）的直接输出：主线 + 非战斗 → 放行', () => {
    const info = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'main',
      saveId: 'save-debug',
      totalTurns: 8,
      currentTime: TIME,
      combatActive: false,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: pendingEvents(),
    });
    expect(info.gate.reason).toBe('allowed');
    expect(info.gate.distanceDays).toBe(149); // 与 plot-threads.test 同口径
  });

  it('非主线模式 → enabled=false 且 gate=mode_off', () => {
    const info = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'side',
      saveId: 's',
      totalTurns: 1,
      currentTime: TIME,
      combatActive: false,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: [],
    });
    expect(info.enabled).toBe(false);
    expect(info.gate.reason).toBe('mode_off');
  });

  it('战斗会话中 → combat_active；已在事件窗口内也不再拦截（改版后放行）', () => {
    const combat = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'main',
      saveId: 's',
      totalTurns: 9,
      currentTime: TIME,
      combatActive: true,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: pendingEvents(),
    });
    expect(combat.gate.reason).toBe('combat_active');

    const inWindow = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'main',
      saveId: 's',
      totalTurns: 9,
      currentTime: TIME,
      combatActive: false,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: pendingEvents([{ start: '488-01', end: '488-02' }]),
    });
    expect(inWindow.gate.reason).toBe('allowed');
  });

  it('原因标签给中文（展示层），机器 token 保留在判据侧', () => {
    const info = buildPlotThreadDebugInfo({
      flags: flagsWith(),
      mode: 'off',
      saveId: 's',
      totalTurns: 1,
      currentTime: TIME,
      combatActive: false,
      outlineTitle: 'Outline',
      chapterTitles: [],
      plotEvents: [],
    });
    expect(plotThreadGateReasonLabel(info)).toContain('未开启主线');
  });
});
