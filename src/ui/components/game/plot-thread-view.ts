/**
 * plot-thread-view.ts — 事件线面板的展示层判定（纯函数，不 mount 可测）
 *
 * 照 `random-event-debug.ts` / `character-viewer.ts` 的口径：组件里**不装任何第二份判据**，
 * 可视性 / 蒙版 / 边遮蔽 / 分组全在这一个文件，组件只负责把它画出来。
 *
 * 🔴 防剧透契约（实施计划 T5 第 4/5 条）：
 * - 隐藏节点（visibility='hidden' 且未 peek 且未开剧透模式）→ 蒙版卡，**零字段进 DOM**
 *   （名字/简述/thread/时间/人物/连线端点都不出现，tooltip/ARIA/隐藏 DOM 文本同样不出现）；
 * - 分组名（= thread 锚）只在组内存在可见节点时展示，否则整组蒙版为「未揭示」；
 * - 边只要一端隐藏 → 整条边遮蔽（不能只显示「A → ？？？」泄露 B 的存在）；
 * - motive 只在「剧透模式 + 显式点开详情」时显示；「见过节点」≠「知道全部内幕」。
 */
import { PLOT_THREAD_STATUS_LABELS } from '@engine/plot-threads';
import type { PlotThreadFlags, PlotThreadStatus } from '@engine/plot-threads';
import { collectPlotThreadEdges } from '@engine/plot-threads';

export interface ThreadDisplayNode {
  name: string;
  gist: string;
  thread: string;
  motive: string;
  involvedNpcs: string[];
  status: PlotThreadStatus;
  visibility: 'hidden' | 'revealed';
  seededAt: number;
  foreshadows: string[];
  payoffs: string[];
  /** 观众视图里这条节点是否蒙版（可见 ≠ 揭示：revealed 或 peek） */
  masked: boolean;
}

export interface ThreadDisplayGroup {
  /** 分组名 = 主线锚；组内无可见节点时整体蒙版（不泄露锚文本） */
  thread: string;
  showLabel: boolean;
  nodes: ThreadDisplayNode[];
}

export interface ThreadDisplayEdge {
  from: string;
  to: string;
  /** 任一端隐藏 → 整条边遮蔽（不可见） */
  masked: boolean;
}

export interface ThreadDisplayView {
  groups: ThreadDisplayGroup[];
  edges: ThreadDisplayEdge[];
  totalCount: number;
  visibleCount: number;
  hiddenCount: number;
}

/** 状态中文标签（唯一映射：引擎集中定义，UI 不内联第二份） */
export function threadStatusLabel(status: PlotThreadStatus): string {
  return PLOT_THREAD_STATUS_LABELS[status] ?? status;
}

/**
 * 构建面板视图。`peek` 是逐条临时揭示（剧透模式下点开）；**不写持久字段**，
 * 关剧透/切档即沉淀（组件负责清空 peek，本函数只按传入判定）。
 */
export function buildThreadDisplayView(
  flags: PlotThreadFlags,
  peek: ReadonlySet<string>,
): ThreadDisplayView {
  const nodes = Object.values(flags.nodes)
    .sort((a, b) => a.seededAt - b.seededAt || a.name.localeCompare(b.name))
    .map((n) => {
      // 🔴 剧透模式不直接解除蒙版（与 PlotPanel 同口径）：它只允许「逐条点击揭示」；
      //    蒙版判定只看揭示位 + 本次临时 peek。
      const visible = n.visibility === 'revealed' || peek.has(n.name);
      return {
        name: n.name,
        gist: n.gist,
        thread: n.thread,
        motive: n.motive,
        involvedNpcs: [...n.involvedNpcs],
        status: n.status,
        visibility: n.visibility,
        seededAt: n.seededAt,
        foreshadows: [...n.foreshadows],
        payoffs: [...n.payoffs],
        masked: !visible,
      };
    });

  // 分组：按 thread 分组；组内全部蒙版时整组蒙版（组名不外泄）
  const byThread = new Map<string, ThreadDisplayNode[]>();
  for (const node of nodes) {
    const key = node.thread || '未划分';
    const arr = byThread.get(key) ?? [];
    arr.push(node);
    byThread.set(key, arr);
  }
  const groups: ThreadDisplayGroup[] = [];
  for (const [thread, threadNodes] of byThread) {
    const hasVisible = threadNodes.some((n) => !n.masked);
    groups.push({
      thread,
      showLabel: hasVisible,
      nodes: threadNodes,
    });
  }
  groups.sort((a, b) => a.thread.localeCompare(b.thread));

  const edges: ThreadDisplayEdge[] = collectPlotThreadEdges(flags).map((e) => {
    const from = nodes.find((n) => n.name === e.from);
    const to = nodes.find((n) => n.name === e.to);
    // 端点不在面板列表里（比如旧档指向已不存在的名字）→ 按不可见处理：遮蔽不泄露
    const fromMasked = !from || from.masked;
    const toMasked = !to || to.masked;
    return { from: e.from, to: e.to, masked: fromMasked || toMasked };
  });

  const totalCount = nodes.length;
  const visibleCount = nodes.filter((n) => !n.masked).length;
  return {
    groups,
    edges,
    totalCount,
    visibleCount,
    hiddenCount: totalCount - visibleCount,
  };
}
