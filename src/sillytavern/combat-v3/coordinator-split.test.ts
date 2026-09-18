import { describe, expect, it, vi } from 'vitest';
import { openCombat } from './index';
import { createCombatAgentSessions } from './agent-session';
import { CombatAgentDecisionError, routeEnemyCommand, routePlayerIntent } from './coordinator';
import { mkBundle } from './test-utils';
import type { ApiEndpoint } from '../types';
import type { CombatClient } from '../combat-v2-types';

function resultWith(name: string, args: Record<string, unknown>) {
  return resultWithMany([{ name, args }]);
}

function resultWithMany(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    output: '',
    rawResponse: '',
    tokensUsed: 0,
    cacheHit: false,
    duration: 0,
    toolCalls: calls.map(({ name, args }) => ({ name, arguments: args, result: { ok: true } })),
  };
}

function setup(hostResult: unknown, enemyResult: unknown) {
  const session = openCombat({ kind: 'new', bundle: mkBundle({ combatId: 'split-wire' }) });
  const hostEndpoint = { id: 'host-endpoint' } as ApiEndpoint;
  const enemyEndpoint = { id: 'enemy-endpoint' } as ApiEndpoint;
  const sessions = createCombatAgentSessions({
    battleId: 'split-wire',
    hostEndpoint,
    enemyEndpoint,
  });
  const requests = new Map<string, Array<{ messages: unknown[]; tools: unknown[] }>>();
  const factory = vi.fn((agentId: string) => {
    const response = agentId === 'combat_enemy' ? enemyResult : hostResult;
    return {
      chatWithTools: vi.fn(async (request) => {
        const rows = requests.get(agentId) ?? [];
        rows.push({
          messages: structuredClone(request.messages),
          tools: structuredClone((request.tools ?? []) as unknown[]),
        });
        requests.set(agentId, rows);
        return response;
      }),
      chat: vi.fn(),
    } as unknown as CombatClient;
  });
  const ctx = {
    agentSessions: sessions,
    getVisibility: () => ({ revealedSkillsByUnit: {} }),
    clientFactory: factory,
    endpoint: hostEndpoint,
    saveId: 'save',
    submitCommand: vi.fn(),
    waitForCommand: vi.fn(),
    abandon: vi.fn(),
    context: {
      characters: [
        { id: '甲', name: '甲', skills: [{ name: '私密剑术' }], inventory: [] },
        { id: '乙', name: '乙', skills: [{ name: '撕咬' }], inventory: [] },
      ],
    },
  };
  return { session, sessions, factory, requests, ctx };
}

describe('combat agent split coordinator wire', () => {
  it('玩家意图只进入主持人历史，敌方使用独立 id/端点和受限工具面', async () => {
    const wire = setup(
      resultWith('declare_attack', {
        actorName: '甲',
        targetName: '乙',
        intentionLevel: '常规',
      }),
      resultWith('pass_slot', { actorName: '乙', slot: 'attack' }),
    );

    await routePlayerIntent(
      '用私密剑术试探，但不要告诉敌人',
      { kind: 'PlayerCommand', unitId: '甲', unitName: '甲', round: 1 },
      wire.session,
      wire.ctx as never,
    );
    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      wire.session,
      wire.ctx as never,
    );

    expect(wire.factory).toHaveBeenCalledWith(
      'combat_v3',
      expect.objectContaining({ id: 'host-endpoint' }),
      'save',
    );
    expect(wire.factory).toHaveBeenCalledWith(
      'combat_enemy',
      expect.objectContaining({ id: 'enemy-endpoint' }),
      'save',
    );
    expect(JSON.stringify(wire.sessions.host.messages)).toContain('私密剑术');
    expect(JSON.stringify(wire.sessions.enemy.messages)).not.toContain('私密剑术');
    const enemyTools = wire.requests
      .get('combat_enemy')![0]
      .tools.map((tool) => (tool as { function: { name: string } }).function.name);
    expect(enemyTools).not.toContain('write_summary');
    expect(enemyTools).not.toContain('submit_adjudication');
  });

  it('敌方张冠李戴与空工具结果都显式失败，不生成静默 pass', async () => {
    const wrongActor = setup(
      resultWith('pass_slot', { actorName: '甲', slot: 'attack' }),
      resultWith('pass_slot', { actorName: '甲', slot: 'attack' }),
    );
    await expect(
      routeEnemyCommand(
        { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
        wrongActor.session,
        wrongActor.ctx as never,
      ),
    ).rejects.toBeInstanceOf(CombatAgentDecisionError);

    const empty = setup(resultWith('pass_slot', {}), {
      output: '',
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
      toolCalls: [],
    });
    await expect(
      routeEnemyCommand(
        { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
        empty.session,
        empty.ctx as never,
      ),
    ).rejects.toThrow('没有提交任何获准的战斗命令');
  });

  it('允许敌方在攻击后以 EndTurn 收尾', async () => {
    const wire = setup(
      resultWith('pass_slot', { actorName: '甲', slot: 'attack' }),
      resultWithMany([
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
        { name: 'end_turn', args: { actorName: '乙' } },
      ]),
    );

    const result = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      wire.session,
      wire.ctx as never,
    );

    expect(result.commands.map((command) => command.kind)).toEqual(['DeclareAttack', 'EndTurn']);
  });

  it('非法结束顺序暂停后，把精确校验原因回馈给重试请求', async () => {
    const wire = setup(
      resultWith('pass_slot', { actorName: '甲', slot: 'attack' }),
      resultWith('pass_slot', { actorName: '乙', slot: 'attack' }),
    );
    const responses = [
      resultWithMany([
        { name: 'end_turn', args: { actorName: '乙' } },
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ]),
      resultWith('pass_slot', { actorName: '乙', slot: 'attack' }),
    ];
    wire.factory.mockImplementation((agentId: string) => {
      return {
        chatWithTools: vi.fn(async (request) => {
          const rows = wire.requests.get(agentId) ?? [];
          rows.push({
            messages: structuredClone(request.messages),
            tools: structuredClone((request.tools ?? []) as unknown[]),
          });
          wire.requests.set(agentId, rows);
          return responses.shift();
        }),
        chat: vi.fn(),
      } as unknown as CombatClient;
    });
    const onCombatEvent = vi.fn();
    Object.assign(wire.ctx, {
      onCombatEvent,
      waitForAgentResume: vi.fn().mockResolvedValue('retry'),
    });

    const result = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      wire.session,
      wire.ctx as never,
    );

    expect(result.commands.map((command) => command.kind)).toEqual(['PassAttack']);
    expect(onCombatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v3_agent_paused',
        role: 'combat_enemy',
        message: '结束回合命令必须是本次决策批次的最后一条命令',
      }),
    );
    const retryMessages = JSON.stringify(wire.requests.get('combat_enemy')?.[1]?.messages);
    expect(retryMessages).toContain('上次决策未通过代码校验');
    expect(retryMessages).toContain('end_turn → declare_attack');
    expect(retryMessages).toContain('结束回合命令必须是本次决策批次的最后一条命令');
  });
});
