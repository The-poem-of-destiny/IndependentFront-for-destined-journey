/**
 * plot-threads.test.ts — 主线细化层纯领域逻辑守卫测试
 *
 * 钉的都是「改坏了不报错、只会静默把节点算错/泄露」那一类：
 * - **闸门只留硬保险**（2026-09-11）：非主线 / 无大纲锚 / 战斗进行中三因关门，其余一律放行
 *   —— 软时机（窗口距离、空白期、冷却）撤销，交 AI 的场合判断（sceneMode/suitableForPlot）
 * - **reducer 语义**：同名不增行、空字段不覆盖、pre 不终结、post 未提及不消散、
 *   dormant 复活、终态保留、去重边、前向引用不造空节点、揭示单向
 * - **投影防剧透**：surface 只含 revealed+active 四字段；snapshot 必须含 dormant 与引用闭包
 */

import { describe, expect, it } from 'vitest';

import {
  applyPlotThreadRevealed,
  applyThreadDeclarations,
  applyThreadUpdates,
  buildPlotThreadSnapshot,
  collectDanglingReferences,
  collectPlotThreadAnchors,
  collectPlotThreadEdges,
  evaluateNextPlotWindow,
  evaluatePlotThreadGate,
  projectPlotThreadSurface,
} from './plot-threads';
import type { PlotThreadFlags, PlotThreadGateInput } from './plot-threads';
import type { GameTime } from './time-system';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

/** 488-01-01 08:00（纪元日内，一切易算） */
const TIME: GameTime = { era: '', year: 488, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 };

function gateInput(overrides: Partial<PlotThreadGateInput> = {}): PlotThreadGateInput {
  return {
    saveId: 'save-a',
    turnNo: 5,
    currentTime: TIME,
    combatActive: false,
    mode: 'main',
    outlineTitle: 'Outline Cave',
    chapterTitles: ['Chapter 1'],
    chapterEventTitles: [],
    pendingEvents: [
      // 488-06 月窗口（当月起约 150 天）
      { timeWindow: { start: '488-06', end: '488-07' } },
    ],
    activeEventCount: 0,
    flags: { nodes: {} },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// 节奏闸门
// ═══════════════════════════════════════════════════════════

describe('evaluatePlotThreadGate', () => {
  it('mode !== main → mode_off（side/off 不产生节点）', () => {
    expect(evaluatePlotThreadGate(gateInput({ mode: 'off' })).reason).toBe('mode_off');
    expect(evaluatePlotThreadGate(gateInput({ mode: 'side' })).reason).toBe('mode_off');
  });

  it('无有效锚 → no_anchor（directionAnchors 不拆成标题）', () => {
    expect(
      evaluatePlotThreadGate(gateInput({ outlineTitle: undefined, chapterTitles: [] })).reason,
    ).toBe('no_anchor');
  });

  it('2026-09-11 改版：无未来窗口 / 有 active 事件 / 已在窗口内，一律不再拦截（放行）', () => {
    // 旧窗口不当作距离为零，但也不再阻挡
    expect(
      evaluatePlotThreadGate(
        gateInput({ pendingEvents: [{ timeWindow: { start: '450-01', end: '450-02' } }] }),
      ).allowed,
    ).toBe(true);
    expect(
      evaluatePlotThreadGate(
        gateInput({ pendingEvents: [{ timeWindow: { start: 'bad', end: 'worse' } }] }),
      ).reason,
    ).toBe('allowed');
    // 有 active 大纲事件（旧 blank_period）→ 现在放行
    expect(evaluatePlotThreadGate(gateInput({ activeEventCount: 1 })).allowed).toBe(true);
    // 当前 488-01-01，窗口 488-01 ~ 488-02 → 已在窗口内 → 放行
    expect(
      evaluatePlotThreadGate(
        gateInput({ pendingEvents: [{ timeWindow: { start: '488-01', end: '488-02' } }] }),
      ).reason,
    ).toBe('allowed');
  });

  it('战斗会话活跃 → combat_active（唯一会因时机关闭的硬保险）', () => {
    const g = evaluatePlotThreadGate(gateInput({ combatActive: true }));
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe('combat_active');
  });

  it('确定性：同输入结果完全一致（已无随机抽样）', () => {
    const a = evaluatePlotThreadGate(gateInput());
    const b = evaluatePlotThreadGate(gateInput());
    expect(a).toEqual(b);
    expect(a.reason).toBe('allowed');
  });

  it('窗口距离仅作展示（488-06 窗口约 149 天），不再影响放行', () => {
    const gate = evaluatePlotThreadGate(gateInput());
    expect(gate.distanceDays).toBe(149);
    expect(gate.windowAt).toBe('488-06');
    expect(gate.allowed).toBe(true);
  });

  it('跨年窗口（489-01 以 488 为纪元计算距离）', () => {
    const gate = evaluatePlotThreadGate(
      gateInput({ pendingEvents: [{ timeWindow: { start: '489-01', end: '489-02' } }] }),
    );
    expect(gate.windowAt).toBe('489-01');
    expect(gate.allowed).toBe(true);
    expect(gate.distanceDays).toBe(359); // 488-01-01 08:00 → 489-01-01 00:00 = 359 天 + 16 小时
  });
});

describe('evaluateNextPlotWindow', () => {
  it('无合法窗口 → null', () => {
    expect(evaluateNextPlotWindow([], TIME)).toBeNull();
    expect(evaluateNextPlotWindow([{ timeWindow: undefined }], TIME)).toBeNull();
  });

  it('取最近未来窗口起点；月窗口从当月首日开始', () => {
    const info = evaluateNextPlotWindow(
      [
        { timeWindow: { start: '488-12', end: '489-01' } },
        { timeWindow: { start: '488-06', end: '488-07' } },
      ],
      TIME,
    );
    expect(info?.windowStart).toBe('488-06');
  });

  it('当前处于窗口内 → insideWindow=true（即使后面还有更近的未来窗口）', () => {
    const info = evaluateNextPlotWindow(
      [
        { timeWindow: { start: '488-01', end: '488-02' } },
        { timeWindow: { start: '488-03', end: '488-04' } },
      ],
      TIME,
    );
    expect(info?.insideWindow).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 锚集
// ═══════════════════════════════════════════════════════════

describe('collectPlotThreadAnchors', () => {
  it('去重精确集合；空白与 undefined 不进入', () => {
    const anchors = collectPlotThreadAnchors(
      'Outline Cave',
      ['Chapter 1', 'Chapter 1', ''],
      ['Beat 2'],
    );
    expect(anchors).toEqual(['Outline Cave', 'Chapter 1', 'Beat 2']);
    expect(collectPlotThreadAnchors(undefined, [], [])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// reducer：declarations
// ═══════════════════════════════════════════════════════════

describe('applyThreadDeclarations', () => {
  it('同名更新不重复插入，seededAt 不变；空字段不覆盖已有非空叙事', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    const first = applyThreadDeclarations(
      flags,
      [
        {
          name: 'A',
          gist: 'gist-a',
          thread: 't',
          motive: 'm',
          involvedNpcs: ['N1'],
          status: 'active',
        },
      ],
      100,
    );
    flags = first.flags;
    expect(Object.keys(flags.nodes)).toHaveLength(1);
    const second = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: '', thread: '', motive: '', involvedNpcs: [], status: 'active' }],
      200,
    );
    flags = second.flags;
    expect(Object.keys(flags.nodes)).toHaveLength(1);
    expect(flags.nodes['A'].seededAt).toBe(100);
    expect(flags.nodes['A'].gist).toBe('gist-a');
    expect(flags.nodes['A'].thread).toBe('t');
  });

  it('新声明默认 hidden；pre 不终结节点（终态不可被降级覆盖）', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' }],
      100,
    ).flags;
    flags = applyThreadUpdates(flags, [{ name: 'A', status: 'resolved' }], 300).flags;
    const r = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: '', thread: '', motive: '', involvedNpcs: [], status: 'active' }],
      400,
    );
    expect(r.flags.nodes['A'].status).toBe('resolved'); // 不被 pre 复活
    expect(r.ignored).toContain('A');
  });

  it('dormant 再声明可复活；声明 dormant 的活跃节点转入休眠', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'dormant' }],
      100,
    ).flags;
    expect(flags.nodes['A'].status).toBe('dormant');
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: '', thread: '', motive: '', involvedNpcs: [], status: 'active' }],
      200,
    ).flags;
    expect(flags.nodes['A'].status).toBe('active');
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: '', thread: '', motive: '', involvedNpcs: [], status: 'dormant' }],
      300,
    ).flags;
    expect(flags.nodes['A'].status).toBe('dormant');
  });

  it('坏条目独立丢弃：缺 name 或非法 status 只进 ignored，不影响其他有效条目', () => {
    const r = applyThreadDeclarations(
      { nodes: {} },
      [
        { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
        { name: '', status: 'active' } as never,
        { name: 'B', status: 'weird' } as never,
      ],
      100,
    );
    expect(Object.keys(r.flags.nodes)).toEqual(['A']);
    expect(r.ignored).toContain('<invalid>');
  });

  it('前向引用允许目标暂未出现：保存引用但不制造空节点；自引用剔除', () => {
    const r = applyThreadDeclarations(
      { nodes: {} },
      [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          foreshadows: ['B', 'B', ' A '],
        },
      ],
      100,
    );
    expect(r.flags.nodes['A'].foreshadows).toEqual(['B']);
    expect(r.flags.nodes['B']).toBeUndefined();
    expect(collectDanglingReferences(r.flags)).toEqual([{ from: 'A', to: 'B' }]);
  });

  it('不产生独立边表：foreshadows 与 payoffs 同向推导去重', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          foreshadows: ['B'],
        },
      ],
      100,
    ).flags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'B',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          payoffs: ['A'],
        },
      ],
      200,
    ).flags;
    // A.foreshadows=[B] 与 B.payoffs=[A] 是同一对边
    const edges = collectPlotThreadEdges(flags);
    expect(edges).toEqual([{ from: 'A', to: 'B' }]);
  });
});

// ═══════════════════════════════════════════════════════════
// reducer：updates / revealed
// ═══════════════════════════════════════════════════════════

describe('applyThreadUpdates', () => {
  it('首次确认终态写 resolvedAt；重复结算 no-op 不改时间戳', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' }],
      100,
    ).flags;
    const up = applyThreadUpdates(flags, [{ name: 'A', status: 'resolved' }], 500);
    expect(up.flags.nodes['A'].status).toBe('resolved');
    expect(up.flags.nodes['A'].resolvedAt).toBe(500);
    const up2 = applyThreadUpdates(up.flags, [{ name: 'A', status: 'resolved' }], 800);
    expect(up2.flags.nodes['A'].resolvedAt).toBe(500);
    expect(up2.settled).toEqual([]); // 已终态节点再结算无变化
  });

  it('post 未提及不消散；未知结算名字 ignored 不创建', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [{ name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' }],
      100,
    ).flags;
    const up = applyThreadUpdates(flags, [{ name: 'Ghost', status: 'dissolved' }], 500);
    expect(up.ignored).toEqual(['Ghost']);
    expect(up.flags.nodes['A'].status).toBe('active'); // 未提及不消散
    expect(up.flags.nodes['Ghost']).toBeUndefined();
  });

  it('payoffs 只在 post 结算时确认；预声明连线由 post 固化', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          foreshadows: ['B'],
        },
        { name: 'B', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      ],
      100,
    ).flags;
    flags = applyThreadUpdates(
      flags,
      [{ name: 'B', status: 'resolved', payoffs: ['A'] }],
      500,
    ).flags;
    expect(collectPlotThreadEdges(flags)).toEqual([{ from: 'A', to: 'B' }]);
  });
});

describe('applyPlotThreadRevealed', () => {
  it('单向置 revealed；未知名字告警并跳过；re-reveal 只计一次', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
        { name: 'B', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      ],
      100,
    ).flags;
    const r1 = applyPlotThreadRevealed(flags, ['A', 'Ghost']);
    expect(r1.revealed).toEqual(['A']);
    expect(r1.ignored).toEqual(['Ghost']);
    expect(r1.flags.nodes['A'].visibility).toBe('revealed');
    expect(r1.flags.nodes['B'].visibility).toBe('hidden');
    // reveal 后的节点才进表层投影；B 未 reveal → 不在 surface
    expect(projectPlotThreadSurface(r1.flags).map((e) => e.name)).toEqual(['A']);
    const r2 = applyPlotThreadRevealed(r1.flags, ['A']);
    expect(r2.revealed).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 快照与投影
// ═══════════════════════════════════════════════════════════

describe('buildPlotThreadSnapshot / projectPlotThreadSurface', () => {
  function flagsWith(): PlotThreadFlags {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'Active1',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: ['N'],
          status: 'active',
          foreshadows: ['Dormant1'],
        },
        {
          name: 'Dormant1',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'dormant',
        },
        {
          name: 'Resolved1',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
        },
        {
          name: 'Hidden1',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      100,
    ).flags;
    flags = applyThreadUpdates(flags, [{ name: 'Resolved1', status: 'resolved' }], 300).flags;
    flags = applyPlotThreadRevealed(flags, ['Active1', 'Hidden1']).flags;
    return flags;
  }

  it('快照包含全部 active、未回收 dormant 及被引用闭包；不因 hidden 缺失', () => {
    const flags = flagsWith();
    const snap = buildPlotThreadSnapshot(flags, 999);
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain('Active1');
    expect(names).toContain('Dormant1');
    expect(names).toContain('Hidden1');
    expect(names).toContain('Resolved1');
    // 未揭示但活跃的节点对 pre/post 可见（防剧透只在 UI/dispatcher 面）
    const hiddenEntry = snap.entries.find((e) => e.name === 'Hidden1');
    expect(hiddenEntry?.visibility).toBe('revealed');
    const dormantEntry = snap.entries.find((e) => e.name === 'Dormant1');
    expect(dormantEntry?.motive).toBe('m');
  });

  it('引用闭包 visited 去重（合法环不无限展开）', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          foreshadows: ['B'],
          payoffs: ['C'],
        },
        {
          name: 'B',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
          foreshadows: ['A'],
        },
        { name: 'C', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      ],
      100,
    ).flags;
    const snap = buildPlotThreadSnapshot(flags, 999);
    expect(snap.entries).toHaveLength(3);
  });

  it('近期终态最多保留 10 条（其余仍存库，只是不入快照）', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    const decls: Array<{
      name: string;
      gist: string;
      thread: string;
      motive: string;
      involvedNpcs: string[];
      status: 'active';
    }> = [];
    for (let i = 0; i < 15; i++)
      decls.push({
        name: `T${i}`,
        gist: 'g',
        thread: 't',
        motive: 'm',
        involvedNpcs: [],
        status: 'active',
      });
    flags = applyThreadDeclarations(flags, decls, 100).flags;
    flags = applyThreadUpdates(
      flags,
      decls.map((d) => ({ name: d.name, status: 'resolved' })),
      200,
    ).flags;
    expect(Object.values(flags.nodes)).toHaveLength(15); // 全在库，只是快照收窄
    const snap = buildPlotThreadSnapshot(flags, 999);
    expect(snap.entries).toHaveLength(10);
  });

  it('表层投影仅 revealed+active 的四个字段（无 motive、无连线意向、无 hidden/dormant/终态）', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'R',
          gist: 'g',
          thread: 't',
          motive: 'SECRET',
          involvedNpcs: ['N'],
          status: 'active',
          foreshadows: ['H'],
        },
        {
          name: 'H',
          gist: 'g',
          thread: 't',
          motive: 'SECRET2',
          involvedNpcs: [],
          status: 'active',
        },
        {
          name: 'D',
          gist: 'g',
          thread: 't',
          motive: 'SECRET3',
          involvedNpcs: [],
          status: 'dormant',
        },
        {
          name: 'X',
          gist: 'g',
          thread: 't',
          motive: 'SECRET4',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      100,
    ).flags;
    flags = applyPlotThreadRevealed(flags, ['R', 'D']).flags;
    const surface = projectPlotThreadSurface(flags);
    expect(surface.map((e) => e.name)).toEqual(['R']); // D 虽 revealed 但 dormant 不暴露
    const entry = surface[0];
    expect(entry).toEqual({ name: 'R', gist: 'g', involvedNpcs: ['N'], thread: 't' });
    expect(Object.keys(entry).sort()).toEqual(['gist', 'involvedNpcs', 'name', 'thread']);
    // resolved 节点不回 surface
    flags = applyThreadUpdates(flags, [{ name: 'X', status: 'resolved' }], 500).flags;
    flags = applyPlotThreadRevealed(flags, ['X']).flags;
    expect(projectPlotThreadSurface(flags).map((e) => e.name)).toEqual(['R']);
  });
});
