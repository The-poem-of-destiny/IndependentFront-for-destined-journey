/**
 * prompt-state-projection.plot-threads.test.ts — 主线细化层的投影/delta/assembler 契约（T3 验收）
 *
 * 钉的都是「不报错、只是模型看到陈旧/残留」那一类：
 * - **plot scope 并入事件线快照**：持久节点走 plot（baseline 与 delta 字段语义一致）
 * - **节点无变化不产生节点 delta**（规范化深比较）
 * - **清空必须显式发 set null**——旧实现只发非 null，模型会保留旧节点视图
 * - **wire transcript 前缀稳定**：增加节点不破坏成功 wire transcript 前缀
 * - **PLOT_THREAD_TURN 走 turn_context（ephemeral）**：gate 变化进 delta 轮 user 消息
 */
import { describe, expect, it } from 'vitest';

import type { AgentContext, ChatMessage } from './types';
import { applyPlotThreadRevealed, applyThreadDeclarations } from './plot-threads';
import type { PlotThreadFlags } from './plot-threads';
import { diffPromptState, projectPromptState } from './prompt-state-projection';
import { resetPromptSessionsForTest, preparePromptSession } from './prompt-session-assembler';
import { getDefaultTemplate } from './placeholder-registry';
import { createDefaultTime } from './time-system';

function baseContext(): AgentContext {
  return {
    userInput: '继续',
    history: [] as ChatMessage[],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    gameTime: createDefaultTime(),
  };
}

function flagsWithNodes(): PlotThreadFlags {
  return applyThreadDeclarations(
    { nodes: {} },
    [
      { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      { name: 'B', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'dormant' },
    ],
    100,
  ).flags;
}

/** A 揭示后进表层投影（dispatcher 只有 revealed+active 可看） */
function flagsWithRevealed(): PlotThreadFlags {
  return applyPlotThreadRevealed(flagsWithNodes(), ['A']).flags;
}

function assembleInput(
  agentId: string,
  ctx: AgentContext,
  staticConfig: Record<string, unknown> = {},
) {
  const config = {
    agentId,
    systemPrompt: 'sys',
    template: getDefaultTemplate(agentId) || '{{SYS_PROMPT}}',
    maxTokens: 4096,
    ...staticConfig,
  };
  return {
    agentId,
    saveId: 'save-thread',
    ctx,
    configs: [config as never] as any[],
  };
}

describe('projectPromptState —— plot scope 并入事件线快照', () => {
  it('无事件无节点 → plot null；只有节点 → threads 可见、events 空数组', () => {
    const none = projectPromptState('plot_pre_check', baseContext(), '');
    expect(none.plot).toBeNull();

    const ctx = baseContext();
    ctx.plotThreadFlags = flagsWithNodes();
    const withThreads = projectPromptState('plot_pre_check', ctx, '');
    expect(withThreads.plot).toEqual({
      events: [],
      threads: [
        { name: 'A', status: 'active', thread: 't', visibility: 'hidden' },
        { name: 'B', status: 'dormant', thread: 't', visibility: 'hidden' },
      ],
    });
  });

  it('与既有 active/pending 事件共存于同一 plot scope', () => {
    const ctx = baseContext();
    ctx.plotEvents = [
      { id: 'e1', title: 'E1', order: 1, status: 'active' } as never,
      { id: 'e2', title: 'E2', order: 2, status: 'pending' } as never,
    ];
    ctx.plotThreadFlags = flagsWithNodes();
    const projection = projectPromptState('plot_pre_check', ctx, '');
    expect(projection.plot).toMatchObject({
      events: [
        { title: 'E1', status: 'active' },
        { title: 'E2', status: 'pending' },
      ],
    });
  });
});

describe('diffPromptState —— plot 变化语义', () => {
  it('节点无变化 → 不产生 plot delta（深比较）；节点变化 → set', () => {
    const ctx = baseContext();
    ctx.plotThreadFlags = flagsWithNodes();
    const p1 = projectPromptState('plot_pre_check', ctx, '');
    const p2 = projectPromptState('plot_pre_check', ctx, '');
    const noChange = diffPromptState(p1, p2);
    expect(noChange.filter((op) => op.op === 'set' && op.scope === 'plot')).toHaveLength(0);

    // 投影面只含 name/status/thread/visibility —— 用「新增节点」驱动变化
    const evolved = applyThreadDeclarations(
      ctx.plotThreadFlags,
      [{ name: 'C', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' }],
      200,
    ).flags;
    const ctx2 = baseContext();
    ctx2.plotThreadFlags = evolved;
    const p3 = projectPromptState('plot_pre_check', ctx2, '');
    const changed = diffPromptState(p1, p3);
    const plotOps = changed.filter((op) => op.op === 'set' && op.scope === 'plot');
    expect(plotOps).toHaveLength(1);
  });

  it('🔴 快照清空（变化回 null）必须显式发 set null（旧实现会静默保留旧视图）', () => {
    const ctx = baseContext();
    ctx.plotThreadFlags = flagsWithNodes();
    const p1 = projectPromptState('plot_pre_check', ctx, '');
    const p2 = projectPromptState('plot_pre_check', baseContext(), '');
    const delta = diffPromptState(p1, p2);
    const plotOps = delta.filter((op) => op.op === 'set' && op.scope === 'plot');
    expect(plotOps).toHaveLength(1);
    expect((plotOps[0] as { value?: unknown }).value).toBeNull();
  });
});

describe('prompt-session-assembler —— wire transcript 与 turn_context', () => {
  it('PLOT_THREAD_TURN/PLOT_THREAD_SURFACE 按 ephemeral 进 turn_context；首轮基线含渲染值', async () => {
    resetPromptSessionsForTest();
    const ctx = baseContext();
    ctx.plotThreadFlags = flagsWithNodes();
    ctx.plotThreadGate = {
      allowed: true,
      reason: 'allowed',
      distanceDays: 12,
      windowAt: '489-02',
    };
    ctx.plotThreadTurnContext = {
      turnNo: 3,
      acceptedDeclarations: [
        { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      ],
      acceptedUpdates: [],
      revealedNames: [],
      gate: ctx.plotThreadGate,
    };

    // dispatcher：表层投影必须不含 motive / 连线 —— UX 安全由 resolver 保证
    // （hidden 节点一律不可见，只有 revealed+active 的 A 出现）
    const dispatcherCtx = { ...ctx, plotThreadFlags: flagsWithRevealed() };
    const input = assembleInput('request_dispatcher', dispatcherCtx);
    const first = await preparePromptSession(input);
    expect(first.rebased).toBe(true);
    const system = first.messages.find((m) => m.role === 'system')?.content ?? '';
    // resolver 渲染成功 = 占位符被替换成 <plot_thread_surface> 外壳
    expect(system).not.toContain('PLOT_THREAD_SURFACE');
    expect(system).toContain('<plot_thread_surface>');
    // 表层投影不允许带到 motive / 连线意向
    expect(system).not.toContain('动机:');
    expect(system).not.toContain('埋向:');
    expect(system).not.toContain('回收:');
  });

  it('第二轮：节点变化只产生 plot delta，不重基线；wire transcript 前缀字节稳定', async () => {
    resetPromptSessionsForTest();
    const ctx = baseContext();
    ctx.plotThreadFlags = flagsWithNodes();
    const agentId = 'plot_post_check';
    const input0 = { ...assembleInput(agentId, ctx) };
    const first = await preparePromptSession(input0);
    expect(first.rebased).toBe(true);

    // 先完成首轮（模拟成功响应入 transcript）
    const { completePromptSession } = await import('./prompt-session-assembler');
    completePromptSession(first.handle!, { rawResponse: '{}', output: null } as never);

    // 第二轮：新增节点 C + 闸门变化 → 同 session delta（plot set + turn_context），不重基线
    const evolved = applyThreadDeclarations(
      ctx.plotThreadFlags,
      [{ name: 'C', gist: 'g-new', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' }],
      300,
    ).flags;
    const ctx2: AgentContext = {
      ...baseContext(),
      history: [...ctx.history],
      plotThreadFlags: evolved,
      plotThreadGate: {
        allowed: false,
        reason: 'combat_active',
        distanceDays: 12,
        windowAt: '489-02',
      },
    };
    const second = await preparePromptSession({ ...input0, ctx: ctx2 });
    expect(second.rebased).toBe(false);
    // 前缀稳定 = system+首轮 user 字节不动（assistant 响应已按设计入 transcript）
    expect(JSON.stringify(second.messages.slice(0, 2))).toBe(
      JSON.stringify(first.messages.slice(0, 2)),
    );
    expect(second.messages[2]).toMatchObject({ role: 'assistant', content: '{}' });
    const userDelta = second.messages[second.messages.length - 1].content;
    expect(userDelta).toContain('context_delta');
    expect(userDelta).toContain('"name":"C"'); // 新节点进 plot delta（投影面只含 name/status/thread/visibility）
    expect(userDelta).toContain('战斗会话进行中'); // 闸门进 turn_context（PLOT_THREAD_TURN 的中文行）
    resetPromptSessionsForTest();
  });
});
