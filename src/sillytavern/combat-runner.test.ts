/**
 * combat-runner 测试 (M5 路径 X · 按行动轴逐单位调度 + 事件流 + 暂停恢复)
 *
 * 聚焦 runner 的调度逻辑（行动轴推进 / 敌方自主 / 我方等输入 / hp 同步 / 死单位跳过 /
 * 事件流 emit 顺序 / 摘要解析）。真实管线（executeCombatToolCall 内部）由 agent-tools.test.ts
 * 覆盖；真实 LLM 行为留 M6 真机验证。
 *
 * 策略：vi.mock executeCombatToolCall（不碰真管线）+ scripted mock client（按调用顺序触发工具/返回叙事）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock agent-tools：getToolsForAgent 返空数组；executeCombatToolCall 按 test 配置 ──
vi.mock('./agent-tools', () => ({
  getToolsForAgent: vi.fn(() => []),
  executeCombatToolCall: vi.fn(async () => ({
    toolCallId: 'tc',
    functionName: 'unknown',
    result: {},
  })),
}));

import { runCombat, inferOutcome } from './combat-runner';
import type { CombatClient, CombatRunDeps, CombatEvent } from './combat-runner';
import { executeCombatToolCall } from './agent-tools';
import type { CombatState, CombatParticipant, CombatActionResult } from './types';

// ========== Helpers ==========

/** 造一个最小 CombatParticipant（填全必填字段） */
function makeParticipant(opts: {
  id: string;
  name: string;
  side: 'ally' | 'enemy';
  hp?: number;
}): CombatParticipant {
  return {
    characterId: opts.id,
    name: opts.name,
    tier: 2,
    level: 1,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    hp: opts.hp ?? 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    defense: 50,
    dr: 0.1,
    penetration: 0,
    hitBonus: 5,
    dodgeBonus: 2,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 20,
    side: opts.side,
    canAct: true,
  };
}

/** 造 CombatState（allies/enemies 按名建，turnOrder 与 participants 同序） */
function makeCombatState(allies: string[], enemies: string[]): CombatState {
  const a = allies.map((n, i) => makeParticipant({ id: `a${i}`, name: n, side: 'ally' }));
  const e = enemies.map((n, i) => makeParticipant({ id: `e${i}`, name: n, side: 'enemy' }));
  const participants = [...a, ...e];
  return {
    combatId: 'c1',
    combatType: '标准',
    round: 1,
    participants,
    turnOrder: participants.map((p) => ({
      characterId: p.characterId,
      name: p.name,
      agility: 10,
      d20Roll: 10,
      speedModifiers: [],
      totalInitiative: 20,
      attacksRemaining: 1,
      actionsRemaining: 1,
    })),
    currentTurnIndex: 0,
    status: 'active',
    environment: '森林',
    patches: [],
    roundLogs: [],
  };
}

/** 造 combat_attack 的 mock 结果（只填 runner 用到的字段） */
function makeAttackResult(
  defenderId: string,
  finalHp: number,
  isDead: boolean,
): Partial<CombatActionResult> {
  return {
    request: { attackerId: 'x', defenderId, action: 'attack' } as any,
    finalHp,
    maxHp: 100,
    isDead,
    patches: [
      { op: 'delta_hp', target: `characters.${defenderId}`, amount: -(100 - finalHp) } as any,
    ],
  };
}

/** scripted mock client：第 i 次 chatWithTools 调用 → 触发 step[i].tools 后返回 step[i].output */
interface ScriptedStep {
  /** 调用前先触发这些工具（模拟 agent 调工具） */
  tools?: Array<{ name: string; args: Record<string, any> }>;
  output: string;
}
function makeScriptedClient(steps: ScriptedStep[]): CombatClient {
  let i = 0;
  return {
    chatWithTools: vi.fn(async (_req, toolExecutor: any) => {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      if (step.tools) {
        for (const t of step.tools) {
          await toolExecutor(t.name, t.args);
        }
      }
      return {
        output: step.output,
        rawResponse: step.output,
        tokensUsed: 100,
        cacheHit: false,
        duration: 10,
      };
    }),
    chat: vi.fn(async () => ({
      output: '',
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
    })),
  };
}

const baseRequest = {
  saveId: 'test-save',
  marker: {
    type: 'combat_trigger' as const,
    combatType: '标准',
    environment: '森林',
    bodyText: '英雄遭遇哥布林',
    rawContent: '<combat_trigger>战斗</combat_trigger>',
    position: 0,
  },
  storyOutput: '英雄走进森林，一只哥布林跳了出来。',
  context: { characters: [], variables: {}, agentOutputs: new Map() } as any,
  endpoint: {} as any,
};

function makeDeps(
  client: CombatClient,
  extra?: Partial<CombatRunDeps>,
): {
  deps: CombatRunDeps;
  events: CombatEvent[];
  /** ref.submit — registerSubmitter 注册的提交器（用 ref 避免 primitive 值拷贝丢失更新） */
  ref: { submit: ((t: string) => void) | null };
} {
  const events: CombatEvent[] = [];
  const ref = { submit: null as ((t: string) => void) | null };
  const deps: CombatRunDeps = {
    clientFactory: () => client,
    eventBus: { emitChain: vi.fn(async (_e: string, p: any) => p) } as any,
    characters: [],
    registerSubmitter: (s) => {
      ref.submit = s;
    },
    ...extra,
  };
  return { deps, events, ref };
}

/** 等待 events 里出现指定类型（让 runner 的 await playerInput 有机会挂起） */
async function waitForEvent(events: CombatEvent[], type: CombatEvent['type']): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === type)) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitForEvent 超时：未等到 ${type}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ========== Tests ==========

describe('inferOutcome（纯函数）', () => {
  it('winner 参数优先', () => {
    expect(inferOutcome(undefined, 'ally')).toBe('ally_win');
    expect(inferOutcome(undefined, 'enemy')).toBe('enemy_win');
  });

  it('从摘要文本推断', () => {
    expect(inferOutcome('英雄获胜，击败哥布林', undefined)).toBe('ally_win');
    expect(inferOutcome('英雄战败，全军覆没', undefined)).toBe('enemy_win');
    expect(inferOutcome('英雄见势不妙，成功逃脱', undefined)).toBe('fled');
    expect(inferOutcome('双方暂时停手', undefined)).toBe('draw');
  });
});

describe('runCombat · 路径 X 调度', () => {
  it('初始化回合调 combat_start → emit combat_started；敌方投降 → combat_ended', async () => {
    const state = makeCombatState(['英雄'], ['哥布林']);
    // 让哥布林（敌方）排在第一个，英雄第二个
    state.turnOrder = [state.turnOrder[1]!, state.turnOrder[0]!];

    vi.mocked(executeCombatToolCall).mockImplementation(async (name) => {
      if (name === 'combat_start') {
        return { toolCallId: 'tc', functionName: name, result: { _combatState: state } } as any;
      }
      if (name === 'combat_end') {
        return { toolCallId: 'tc', functionName: name, result: { exp: 50, fp: 5 } } as any;
      }
      return { toolCallId: 'tc', functionName: name, result: {} } as any;
    });

    const client = makeScriptedClient([
      { tools: [{ name: 'combat_start', args: {} }], output: '战斗开始！哥布林龇牙咧嘴。' },
      {
        tools: [{ name: 'combat_end', args: { winner: 'ally' } }],
        output:
          '哥布林不堪一击，转身逃跑。<combat_summary>我方获胜，英雄击败了哥布林，获得 50 EXP。</combat_summary>',
      },
    ]);

    const { deps, events } = makeDeps(client);
    const result = await runCombat(baseRequest as any, deps, (e) => events.push(e));

    // 摘要 + 胜负
    expect(result.outcome).toBe('ally_win');
    expect(result.totalExp).toBe(50);
    expect(result.narrativeSummary).toContain('我方获胜');

    // 事件流顺序
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('combat_started');
    expect(types).toContain('turn_started');
    expect(types[events.length - 1]).toBe('combat_ended');
    // 敌方回合不应 emit awaiting_player_input
    expect(types).not.toContain('awaiting_player_input');
  });

  it('我方单位回合 → emit awaiting_player_input → submitPlayerInput 后继续', async () => {
    const state = makeCombatState(['英雄'], ['哥布林']);
    // 哥布林（敌方）第一，英雄（我方）第二 —— 哥布林先自主打一轮，英雄回合才暂停等玩家
    state.turnOrder = [state.turnOrder[1]!, state.turnOrder[0]!];
    const goblinId = 'e0';

    vi.mocked(executeCombatToolCall).mockImplementation(async (name, args) => {
      if (name === 'combat_start') {
        return { toolCallId: 'tc', functionName: name, result: { _combatState: state } } as any;
      }
      if (name === 'combat_attack') {
        // 哥布林(e0)作为目标时被杀；英雄(a0)作为目标时掉血不死
        const isGoblinTarget = args.defenderId === goblinId;
        return {
          toolCallId: 'tc',
          functionName: name,
          result: makeAttackResult(args.defenderId, isGoblinTarget ? 0 : 80, isGoblinTarget),
        } as any;
      }
      if (name === 'combat_end') {
        return { toolCallId: 'tc', functionName: name, result: { exp: 50 } } as any;
      }
      return { toolCallId: 'tc', functionName: name, result: {} } as any;
    });

    const client = makeScriptedClient([
      { tools: [{ name: 'combat_start', args: {} }], output: '战斗开始。' },
      // 哥布林回合（敌方自主）：打英雄，英雄不死
      {
        tools: [{ name: 'combat_attack', args: { attackerId: goblinId, defenderId: 'a0' } }],
        output: '哥布林扑向英雄。',
      },
      // 英雄回合（我方，submit 后）：杀哥布林 + 结束
      {
        tools: [
          { name: 'combat_attack', args: { attackerId: 'a0', defenderId: goblinId } },
          { name: 'combat_end', args: { winner: 'ally' } },
        ],
        output: '英雄挥剑斩杀哥布林。<combat_summary>我方获胜。</combat_summary>',
      },
    ]);

    const { deps, events, ref } = makeDeps(client);
    const runPromise = runCombat(baseRequest as any, deps, (e) => events.push(e));

    // 等 runner 挂起等我方输入（英雄回合）
    await waitForEvent(events, 'awaiting_player_input');
    expect(ref.submit).toBeTruthy();
    ref.submit!('英雄用幽怨之剑砍向哥布林');

    const result = await runPromise;

    // 玩家文本被注入 messages（第 3 次 chatWithTools = 英雄回合，入参 messages 含玩家指令）
    const heroCallArgs = (client.chatWithTools as any).mock.calls[2][0];
    expect(
      heroCallArgs.messages.some(
        (m: any) => m.content.includes('幽怨之剑') && m.content.includes('玩家指令'),
      ),
    ).toBe(true);

    expect(result.outcome).toBe('ally_win');
    expect(events.map((e) => e.type)).toContain('awaiting_player_input');
  });

  it('combat_attack 后同步 defender hp；死亡单位下轮被跳过', async () => {
    const state = makeCombatState(['英雄'], ['哥布林', '萨满']);
    const goblinId = 'e0';
    // 哥布林第一、英雄第二、萨满第三
    state.turnOrder = [state.turnOrder[1]!, state.turnOrder[0]!, state.turnOrder[2]!];

    vi.mocked(executeCombatToolCall).mockImplementation(async (name, _args, ctx) => {
      if (name === 'combat_start') {
        return { toolCallId: 'tc', functionName: name, result: { _combatState: state } } as any;
      }
      if (name === 'combat_attack') {
        return {
          toolCallId: 'tc',
          functionName: name,
          result: makeAttackResult(goblinId, 0, true),
        } as any;
      }
      if (name === 'combat_end') {
        return { toolCallId: 'tc', functionName: name, result: { exp: 50 } } as any;
      }
      return { toolCallId: 'tc', functionName: name, result: {} } as any;
    });

    const client = makeScriptedClient([
      { tools: [{ name: 'combat_start', args: {} }], output: '战斗开始。' },
      // 哥布林回合（敌方）打英雄 — 但 mock attack 恒杀哥布林（不影响：测的是 hp 同步到哥布林）
      {
        tools: [{ name: 'combat_attack', args: { attackerId: '哥布林', defenderId: goblinId } }],
        output: '哥布林扑上来，被英雄反杀。',
      },
      // 英雄回合（我方）
      {
        tools: [{ name: 'combat_attack', args: {} }],
        output: '英雄继续战斗。',
      },
      // 萨满回合（敌方）→ 结束
      {
        tools: [{ name: 'combat_end', args: { winner: 'ally' } }],
        output: '<combat_summary>我方获胜。</combat_summary>',
      },
    ]);

    const { deps, events, ref } = makeDeps(client);
    const runPromise = runCombat(baseRequest as any, deps, (e) => events.push(e));
    await waitForEvent(events, 'awaiting_player_input');
    ref.submit!('英雄攻击');
    await runPromise;

    // 哥布林 hp 被同步为 0
    const goblin = state.participants.find((p) => p.characterId === goblinId)!;
    expect(goblin.hp).toBe(0);
    expect(goblin.canAct).toBe(false);
  });

  it('client 不支持 chatWithTools 时抛错', async () => {
    const brokenClient: CombatClient = {
      chat: vi.fn(async () => ({
        output: 'x',
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
      })),
    };
    const { deps } = makeDeps(brokenClient);
    await expect(runCombat(baseRequest as any, deps)).rejects.toThrow(/chatWithTools/);
  });

  it('未调 combat_start 时抛错', async () => {
    vi.mocked(executeCombatToolCall).mockResolvedValue({
      toolCallId: 'tc',
      functionName: 'x',
      result: {},
    } as any);
    const client = makeScriptedClient([{ output: 'agent 没调 combat_start 直接叙事' }]);
    const { deps } = makeDeps(client);
    await expect(runCombat(baseRequest as any, deps)).rejects.toThrow(/combat_start/);
  });
});
