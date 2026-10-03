/**
 * runner.test.ts —— 系统提示组装 + 单次 exchange + 续战循环
 */
import { describe, it, expect } from 'vitest';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import {
  assembleCombatSystemPrompt,
  buildCombatFlowText,
  buildCombatRosterText,
  runCombatSandbox,
  runCombatSandboxLoop,
} from '../../../../src/core/combat/sandbox/runner';
import type {
  CombatSandboxClient,
  CombatSandboxClientResult,
} from '../../../../src/core/combat/sandbox/runner';
import { createCombatState } from '../../../../src/core/combat/sandbox/state';
import type { CombatState } from '../../../../src/core/combat/sandbox/types';

type Executor = (name: string, args: Record<string, any>) => Promise<unknown>;

function makeChar(name = '艾莉丝') {
  return createDefaultCharacterState({ id: name, saveId: 's1', name, hp: 200, maxHp: 200 });
}

function makeState(): CombatState {
  return createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
}

function mockClient(
  fn: (call: number, executor: Executor) => Promise<CombatSandboxClientResult>,
): CombatSandboxClient & { calls: number } {
  const client: CombatSandboxClient & { calls: number } = {
    calls: 0,
    async chatWithTools(_request, executor) {
      client.calls += 1;
      return fn(client.calls, executor);
    },
  };
  return client;
}

describe('系统提示组装', () => {
  it('buildCombatFlowText 含关键流程节点', () => {
    const flow = buildCombatFlowText();
    expect(flow).toContain('combat_set_meta');
    expect(flow).toContain('combat_yield_to_player');
    expect(flow).toContain('禁止自己编造骰值');
  });

  it('buildCombatRosterText 列出单位资源', () => {
    const text = buildCombatRosterText(makeState());
    expect(text).toContain('艾莉丝');
    expect(text).toContain('HP 200/200');
  });

  it('assembleCombatSystemPrompt 注入协议 / 流程 / 表单 / 状态', () => {
    const prompt = assembleCombatSystemPrompt({ protocolText: '协议正文', state: makeState() });
    expect(prompt).toContain('<战斗协议>\n协议正文\n</战斗协议>');
    expect(prompt).toContain('<战斗流程>');
    expect(prompt).toContain('<参战单位>');
    expect(prompt).toContain('<当前战斗状态>');
    expect(prompt).toContain('"艾莉丝"');
  });

  it('无协议文本时给兜底说明', () => {
    const prompt = assembleCombatSystemPrompt({ state: makeState() });
    expect(prompt).toContain('未装载战斗协议文本');
  });

  it('flowText 覆盖内置流程（agent-config 的 combat.systemPrompt 优先）', () => {
    const prompt = assembleCombatSystemPrompt({
      state: makeState(),
      flowText: 'FLOW_FROM_CONFIG',
    });
    expect(prompt).toContain('<战斗流程>\nFLOW_FROM_CONFIG\n</战斗流程>');
  });
});

describe('runCombatSandbox', () => {
  it('开局建 system+user 消息，工具维护状态，终局产出写回补丁', async () => {
    const state = makeState();
    const client = mockClient(async (_call, executor) => {
      await executor('combat_update_unit', {
        name: '艾莉丝',
        ops: [{ op: 'dec', field: 'hp', value: 50 }],
      });
      await executor('combat_set_meta', { patch: { phase: 'ended', outcome: 'ally_win' } });
      return { output: '战斗结束。' };
    });

    const result = await runCombatSandbox({
      state,
      client,
      protocolText: '协议',
      saveCharacters: [makeChar()],
    });

    expect(result.ended).toBe(true);
    expect(result.outcome).toBe('ally_win');
    expect(result.state.units['艾莉丝'].hp).toBe(150);
    expect(result.transcript[0].role).toBe('system');
    expect(result.transcript[1]).toEqual({ role: 'user', content: '战斗开始。' });
    expect(result.transcript[2]).toEqual({ role: 'assistant', content: '战斗结束。' });
    expect(result.patches.some((p) => p.op === 'set_hp' && p.value === 150)).toBe(true);
  });

  it('yield 后 awaitingPlayer 为真、未终局不产补丁', async () => {
    const state = makeState();
    const client = mockClient(async (_call, executor) => {
      await executor('combat_yield_to_player', { unit: '艾莉丝', prompt: '轮到你' });
      return { output: '轮到你行动。' };
    });
    const result = await runCombatSandbox({ state, client });
    expect(result.ended).toBe(false);
    expect(result.awaitingPlayer).toBe(true);
    expect(result.patches).toEqual([]);
    expect(result.state.meta.pendingPlayerUnit).toBe('艾莉丝');
  });

  it('续战：传入 transcript + playerInput，system 不重复插入', async () => {
    const state = makeState();
    const first = mockClient(async (_call, executor) => {
      await executor('combat_yield_to_player', { unit: '艾莉丝', prompt: '轮到你' });
      return { output: '等待你。' };
    });
    const r1 = await runCombatSandbox({ state, client: first });

    const second = mockClient(async (_call, executor) => {
      await executor('combat_update_unit', {
        name: '艾莉丝',
        ops: [{ op: 'dec', field: 'hp', value: 1 }],
      });
      await executor('combat_set_meta', { patch: { phase: 'ended', outcome: 'draw' } });
      return { output: '结束。' };
    });
    const r2 = await runCombatSandbox({
      state: r1.state,
      client: second,
      transcript: r1.transcript,
      playerInput: '我攻击',
    });
    expect(r2.transcript.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(r2.transcript.some((m) => m.role === 'user' && m.content === '我攻击')).toBe(true);
    expect(r2.ended).toBe(true);
  });

  it('client 缺少 chatWithTools 直接抛错', async () => {
    await expect(runCombatSandbox({ state: makeState(), client: {} })).rejects.toThrow(
      /chatWithTools/,
    );
  });

  it('onToolResult 回调被调用', async () => {
    const seen: string[] = [];
    const client = mockClient(async (_call, executor) => {
      await executor('calc', { expression: '1+1' });
      await executor('combat_set_meta', { patch: { phase: 'ended', outcome: 'draw' } });
      return { output: '' };
    });
    await runCombatSandbox({ state: makeState(), client, onToolResult: (name) => seen.push(name) });
    expect(seen).toEqual(['calc', 'combat_set_meta']);
  });

  it('续接 continuationMessages（生产 AgentClient 的工具往返整段回注）', async () => {
    const client = mockClient(async () => ({
      output: '结束。',
      continuationMessages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'roll_d20' }] },
        { role: 'tool', tool_call_id: 't1', name: 'roll_d20', content: '{"total":15}' },
        { role: 'assistant', content: '结束。' },
      ],
    }));
    const result = await runCombatSandbox({ state: makeState(), client });
    expect(result.transcript.some((m) => m.role === 'tool')).toBe(true);
    // 续接整段时不再额外压一条裸 output
    expect(result.transcript.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('systemPrompt 作为流程正文注入', async () => {
    let systemContent = '';
    const client: CombatSandboxClient = {
      async chatWithTools(request) {
        systemContent = String(request.messages[0]?.content ?? '');
        return { output: 'ok' };
      },
    };
    await runCombatSandbox({
      state: makeState(),
      client,
      protocolText: '协议',
      systemPrompt: 'FLOW_FROM_CONFIG',
    });
    expect(systemContent).toContain('FLOW_FROM_CONFIG');
  });
});

describe('runCombatSandboxLoop', () => {
  it('依次回注玩家输入，直到终局', async () => {
    const state = makeState();
    let call = 0;
    const client = mockClient(async (_call, executor) => {
      call += 1;
      if (call === 1) {
        await executor('combat_yield_to_player', { unit: '艾莉丝', prompt: '轮到你' });
        return { output: '第一轮。' };
      }
      await executor('combat_set_meta', { patch: { phase: 'ended', outcome: 'ally_win' } });
      return { output: '第二轮。' };
    });

    const result = await runCombatSandboxLoop({
      state,
      client,
      playerInputs: ['准备', '我上'],
    });
    expect(call).toBe(2);
    expect(result.ended).toBe(true);
    expect(result.transcript.filter((m) => m.role === 'user' && m.content === '我上')).toHaveLength(
      1,
    );
  });

  it('无输入时至少跑一轮开场', async () => {
    const client = mockClient(async () => ({ output: '开场。' }));
    const result = await runCombatSandboxLoop({ state: makeState(), client });
    expect(client.calls).toBe(1);
    expect(result.output).toBe('开场。');
  });
});
