/**
 * plot-thread-debug.ts — 调试面板「主线细化」区块的展示层判定（纯函数）
 *
 * 🔴 **不装任何判据的第二实现**（照 `random-event-debug.ts` 的规矩）：闸门行直接用
 * 生产函数 `evaluatePlotThreadGate`、边推导用 `collectPlotThreadEdges`、状态计数读
 * 生产 getter —— 调试面板照抄一份判据的下场是：它会在真机上说谎，而说谎的正是
 * 用来查真相的那块面板。
 *
 * 只读无副作用：evaluatePlotThreadGate 是纯函数（确定性随机、不写库），
 * 「查看面板」不推进任何随机状态（实施计划 T5 第 7 条）。
 */
import type { PlotThreadFlags, PlotThreadGateResult, PlotThreadStatus } from '@engine/plot-threads';
import { evaluatePlotThreadGate, collectPlotThreadEdges } from '@engine/plot-threads';
import type { PlotEvent } from '@engine/types';
import type { GameTime } from '@engine/time-system';

export interface PlotThreadDebugInfo {
  enabled: boolean;
  nodeCount: number;
  counts: Record<PlotThreadStatus, number>;
  hiddenCount: number;
  edgeCount: number;
  lastCommittedTurn?: number;
  lastAdvancedTurn?: number;
  /** 下一轮（= totalTurns+1）按当前状态求值的闸门结果：使用生产函数 + 明确标注 */
  gate: PlotThreadGateResult;
  mode: 'off' | 'side' | 'main';
}

export interface PlotThreadDebugInput {
  flags: PlotThreadFlags;
  mode: 'off' | 'side' | 'main';
  saveId: string;
  totalTurns: number;
  currentTime: GameTime;
  combatActive: boolean;
  outlineTitle?: string;
  chapterTitles?: string[];
  /** 全量 plotEvents（pending/active 判定从这读） */
  plotEvents: PlotEvent[];
}

export function buildPlotThreadDebugInfo(input: PlotThreadDebugInput): PlotThreadDebugInfo {
  const { flags, mode, saveId, totalTurns, currentTime, combatActive, plotEvents } = input;
  const counts: Record<PlotThreadStatus, number> = {
    active: 0,
    dormant: 0,
    resolved: 0,
    dissolved: 0,
  };
  let hiddenCount = 0;
  for (const node of Object.values(flags.nodes)) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
    if (node.visibility === 'hidden') hiddenCount += 1;
  }

  const gate = evaluatePlotThreadGate({
    saveId,
    turnNo: totalTurns + 1,
    currentTime,
    combatActive,
    mode,
    outlineTitle: input.outlineTitle,
    chapterTitles: input.chapterTitles,
    chapterEventTitles: plotEvents
      .map((e) => e.chapterTitle)
      .filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
    pendingEvents: plotEvents,
    activeEventCount: plotEvents.filter((e) => e.status === 'active').length,
    flags,
  });

  return {
    enabled: mode === 'main',
    nodeCount: Object.keys(flags.nodes).length,
    counts,
    hiddenCount,
    edgeCount: collectPlotThreadEdges(flags).length,
    lastCommittedTurn: flags.lastCommittedTurn,
    lastAdvancedTurn: flags.lastAdvancedTurn,
    gate,
    mode,
  };
}

/** 闸门原因 → 中文（仅展示；机器 token 在判据侧） */
export function plotThreadGateReasonLabel(info: PlotThreadDebugInfo): string {
  const g = info.gate;
  switch (g.reason) {
    case 'allowed':
      return `放行（距事件窗口 ${g.distanceDays ?? '?'} 天）`;
    case 'mode_off':
      return '剧情模式未开启主线（side/off 不产生节点）';
    case 'no_anchor':
      return '无有效主线锚（需要大纲标题/章节/事件标题）';
    case 'combat_active':
      return '战斗会话进行中（战斗期间不推进细化）';
    default:
      return g.reason;
  }
}
