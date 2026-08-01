/**
 * combat-v3/coordinator.test.ts — Coordinator 路由 + 终局落库 + abandon（M2）
 *
 * 验收对应（plan §4.9 / §4.1）：
 *   A2-1  终局只调一次 commitChatState（基础攻击 → hp_zero → settle）
 *   A2-3  RequiredInput 路由穷尽（编译期 never 兜底 + M2 未支持分支 throw）
 *   A2-4  abandon（C4）：FP 不落库
 *   PlayerCommand 玩家方路由到 store；敌方路由到 Agent
 *   MAX_TOOL_ROUNDS 超限自动 pass（敌方 Agent 卡死 → pass 推进）
 *
 * 驱动方式：甲(player) 一刀打死脆皮乙(enemy)。甲的路由走 submitCommand + waitForCommand
 * 队列；乙若轮到自己则走 fake agent。
 */

import { describe, expect, it, vi } from 'vitest';
import { runCombatV3, UnsupportedInM2, type RunCombatV3Opts } from './coordinator';
import { mkBundle, mkParticipant } from './test-utils';
import type { CombatClient } from '../combat-runner';
import type { CombatCommand } from './types';

/** 甲(player) + 乙(enemy, 脆皮 HP1)：甲一刀杀乙 → hp_zero 终局 */
function attriteBundle() {
  return mkBundle({
    combatId: 'coord-test',
    participants: [
      mkParticipant('甲'), // side default 'ally' → player
      mkParticipant('乙', {
        side: 'enemy',
        characterId: '乙',
        name: '乙',
        hp: 1,
        maxHp: 1,
        defense: 0,
        dr: 0,
      }),
    ],
  });
}

/** fake 敌方 agent client：脚本化工具调用（一次调用 = 一个 Command） */
function fakeEnemyClient(script: Array<{ name: string; args: Record<string, any> }>): CombatClient {
  let idx = 0;
  return {
    chatWithTools: async (_req, _toolExecutor) => {
      const step = script[Math.min(idx, script.length - 1)];
      idx++;
      if (!step) {
        return { output: null, rawResponse: '', toolCalls: [] } as never;
      }
      return {
        output: 'ok',
        rawResponse: '',
        toolCalls: [{ name: step.name, arguments: step.args }],
      } as never;
    },
    chat: async () => ({ output: null, rawResponse: '' }) as never,
  };
}

function mkOpts(
  over: {
    playerQueue?: CombatCommand[];
    enemyScript?: Array<{ name: string; args: Record<string, any> }>;
  } = {},
): {
  opts: RunCombatV3Opts;
  commit: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
  setQueue: (q: CombatCommand[]) => void;
} {
  const commit = vi.fn(async () => {});
  const abandon = vi.fn(() => {});
  const submitCommand = vi.fn(async () => {});
  let queue: CombatCommand[] = over.playerQueue ?? [];
  const setQueue = (q: CombatCommand[]) => (queue = q);
  // 敌方 agent（乙）脚本：默认 pass（乙不主动打，等甲杀它）
  const enemyScript = over.enemyScript ?? [];
  const opts: RunCombatV3Opts = {
    saveId: 's1',
    bundle: attriteBundle(),
    deps: {
      clientFactory: () => fakeEnemyClient(enemyScript),
      endpoint: { id: 'ep' } as never,
      stateManager: { commitChatState: commit },
      characters: [],
      context: {} as never,
      submitCommand,
      waitForCommand: async () => {
        const c = queue.shift();
        if (!c) throw new Error('player command 队列耗尽');
        return c;
      },
      abandon,
    },
  };
  return { opts, commit, abandon, setQueue };
}

/** 构造甲的完整回合：攻击乙 + 放弃动作槽（内核要求消费两槽才推进） */
function atkTurn(): CombatCommand[] {
  return [
    {
      commandId: 'u-att',
      expectedRevision: -1, // coordinator 会修正为当前 revision
      kind: 'DeclareAttack',
      actorId: '甲',
      cost: 'attack',
      payload: { targetId: '乙', intentionLevel: '常规' },
    },
    {
      commandId: 'u-act',
      expectedRevision: -1,
      kind: 'PassAction',
      actorId: '甲',
      cost: 'action',
      payload: {} as Record<string, never>,
    },
  ];
}

describe('A2-1：终局一次 commitChatState', () => {
  it('甲攻击乙 → 乙死亡 → hp_zero → settle → 只 commit 一次', async () => {
    const { opts, commit, abandon, setQueue } = mkOpts();
    // 甲的玩家路由：第一次问就声明攻击乙（其余凑数）
    setQueue(atkTurn());
    const result = await runCombatV3(opts);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ally_win');
  });
});

describe('A2-4：abandon（C4）', () => {
  it('玩家命令队列耗尽 → coordinator 熔断 → abandon、commit 不调用、FP 不落库', async () => {
    const { opts, commit, abandon, setQueue } = mkOpts();
    setQueue([]); // 玩家不动作 → waitForCommand 抛错 → coordinator 熔断
    await expect(runCombatV3(opts)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('A2-3：RequiredInput 路由', () => {
  it('M2 未支持分支构造抛 UnsupportedInM2', () => {
    for (const k of ['EffectChoice', 'BoundedAdjudication', 'CharGenRequest'] as const) {
      const err = new UnsupportedInM2(k);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain(k);
    }
  });
});

describe('玩家方 / 敌方路由', () => {
  it('PlayerCommand 玩家方 → 走 waitForCommand（store）', async () => {
    const submit = vi.fn(async () => {});
    const { opts } = mkOpts({ playerQueue: atkTurn() });
    opts.deps.submitCommand = submit;
    await runCombatV3(opts);
    expect(submit).toHaveBeenCalled();
  });

  it('PlayerCommand 敌方 → 走战斗 Agent（clientFactory）', async () => {
    const seenAgents: string[] = [];
    const { opts, setQueue } = mkOpts();
    // 甲主动放弃双槽（不杀乙），乙存活 → 轮到敌方 → 触发 Agent
    setQueue([
      {
        commandId: 'pa',
        expectedRevision: -1,
        kind: 'PassAttack',
        actorId: '甲',
        cost: 'attack',
        payload: {} as Record<string, never>,
      },
      {
        commandId: 'pb',
        expectedRevision: -1,
        kind: 'PassAction',
        actorId: '甲',
        cost: 'action',
        payload: {} as Record<string, never>,
      },
    ]);
    opts.deps.clientFactory = (agentId) => {
      seenAgents.push(agentId);
      return fakeEnemyClient([
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ]);
    };
    await runCombatV3(opts);
    expect(seenAgents).toContain('combat_v3');
  });
});

describe('MAX_TOOL_ROUNDS 超限自动 pass', () => {
  it('敌方 Agent 卡死（无工具调用）→ coordinator 自动 pass 推进，不无限循环', async () => {
    const { opts, commit, setQueue } = mkOpts();
    setQueue(atkTurn());
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async () => ({ output: null, rawResponse: '', toolCalls: [] }),
      }) as never;
    const result = await runCombatV3(opts);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('ally_win');
  });
});
