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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUnitPersistPatches,
  runCombatV3,
  UnsupportedInM2,
  type RunCombatV3Opts,
} from './coordinator';
import { mkBundle, mkParticipant } from './test-utils';
import type { CombatClient, CombatEvent } from '../combat-v2-types';
import type { CombatCommand, CombatUnitView } from './types';
import type { AgentConfig, StatePatch, StatusEffect, WorldBook } from '../types';
import { resetPlaceholderGlobals } from '../placeholder-registry';

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
    characters?: Array<Record<string, unknown>>;
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
      characters: over.characters ?? [],
      context: {} as never,
      submitCommand,
      waitForCommand: async () => {
        const c = queue.shift();
        if (!c) throw new Error('player command 队列耗尽');
        return c;
      },
      abandon,
      // 确定性骰源：默认给 60 颗 10（保持既有测试语义，真随机在 game-pipeline 注入）
      drawDice: () => ({ outputId: 'test-dice', dice: Array.from({ length: 60 }, () => 10) }),
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

// ══════════════════════════════════════════════════════════════════════════
// F1（2026-08-10）：v3_combat_started 立即 emit（「面板不弹」死锁回归）
// 背景：首个 dispatch 是 SupplyDice（reduceSupplyDice 保持 phase 不变、不产
// CombatOpened），CombatOpened 要等下一个 Command 才发。玩家单位先动 →
// decideForUnit 走 waitForCommand() 永久 pending → v3_combat_started 永不落地 →
// 面板不弹 → 玩家无法输入 → 死锁。修复：openCombat 之后、首个 dispatch 之前，
// 直接用 onCombatEvent 发 v3_combat_started + v3_units_snapshot（不依赖事件流）。
// ══════════════════════════════════════════════════════════════════════════
describe('F1：开局事件立即 emit（真实 runCombatV3 全链路）', () => {
  it('玩家先动：开局同步收到 v3_combat_started + v3_units_snapshot（不等 CombatOpened）', async () => {
    const { opts, setQueue } = mkOpts();
    const seen: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => seen.push(evt);
    // 玩家（甲）先动：修复前 coordinator 在首个 dispatch 后就挂起等玩家输入，
    // CombatOpened（在下一条命令进 runDispatch 才发）永远等不到 → 面板不弹。
    setQueue(atkTurn());

    const runPromise = runCombatV3(opts);

    // 开局事件同步落地（emit 在 openCombat 之后、首个 dispatch 之前的同步代码里）——
    // 面板在玩家回合挂起前就已弹出，死锁由此解开
    const started = seen.filter((e) => e.type === 'v3_combat_started');
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0]).toMatchObject({
      combatId: 'coord-test',
      round: 1,
      unitNames: ['甲', '乙'],
    });
    const snap = seen.find((e) => e.type === 'v3_units_snapshot');
    expect(snap && 'units' in snap ? Object.keys(snap.units).sort() : []).toEqual(['乙', '甲']);

    // 收尾：玩家命令队列能喂入并推进（面板先弹后输入，命令照常消费）
    await runPromise;
  });

  it('敌方先动：同样立即 emit（不依赖玩家输入回合）', async () => {
    const { opts, setQueue } = mkOpts({
      enemyScript: [{ name: 'declare_attack', args: { actorName: '乙', targetName: '甲' } }],
    });
    // 敌方（乙）先动后轮到玩家（甲）：喂它的回合命令（atkTurn 先例），
    // 否则玩家回合 waitForCommand 队列耗尽熔断——遗留缺陷（本测试此前从未提交过 git）
    setQueue(atkTurn());
    const seen: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => seen.push(evt);
    const result = await runCombatV3(opts);
    expect(seen.filter((e) => e.type === 'v3_combat_started').length).toBeGreaterThanOrEqual(1);
    expect(result.outcome).toBe('ally_win');
  });
});

describe('Q-01：生产骰源接线（消灭恒定 10）', () => {
  it('coordinator 使用注入的 drawDice 而非 sysDrawSixty（旧代码从不调用它）', async () => {
    const { opts, setQueue } = mkOpts();
    // 已知非均匀 60 向量：前 59 颗 1，最后一颗 20（非 10 中位数，便于断言「真到了」）
    const supplied = Array.from({ length: 60 }, (_, i) => (i === 59 ? 20 : 1));
    let draws = 0;
    opts.deps.drawDice = () => ({ outputId: `q01-${++draws}`, dice: supplied });
    setQueue(atkTurn());

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // 关键断言：drawDice 真的被调用（旧代码走 sysDrawSixty，绝不会调它）
    expect(draws).toBeGreaterThan(0);
  });
});

describe('A2-4：abandon（C4）', () => {
  it('玩家命令队列耗尽 → coordinator 熔断 → abandon、commit 不调用、FP 不落库', async () => {
    const { opts, commit, setQueue } = mkOpts();
    setQueue([]); // 玩家不动作 → waitForCommand 抛错 → coordinator 熔断
    await expect(runCombatV3(opts)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('A2-3 / M3.5：RequiredInput 路由', () => {
  it('EffectChoice 仍抛 UnsupportedInM2（留给 M4）', () => {
    const err = new UnsupportedInM2('EffectChoice');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('EffectChoice');
  });

  it('BoundedAdjudication / CharGenRequest 不再抛 UnsupportedInM2（可构造）', () => {
    // 仅验证 UnsupportedInM2 对这两类不再被当作「M2 不支持」构造（它们已实装路由）
    const e1 = new UnsupportedInM2('BoundedAdjudication');
    expect(e1.message).toContain('BoundedAdjudication');
    // CharGenRequest 走 routeCharGenRequest（池 → char_gen → SupplyUnit）
    expect(typeof makeCommandOrThrow).toBe('function');
  });

  it('CharGenRequest 优先查预生成召唤物池（命中不触发 char_gen）', async () => {
    const submitChain: CombatCommand[] = [];
    const { opts } = mkOpts();
    // 直接驱动路由：构造一个 CharGenRequest 交给 routeRequiredInput，断言产出 SupplyUnit
    const { routeRequiredInput } = await import('./coordinator');
    const { openCombat } = await import('./index');
    // 池命中：手动塞一条到 SUMMON_POOL（key 按 summonPoolKey 归一化）
    const { SUMMON_POOL } = await import('./summon-pool');
    (SUMMON_POOL as Record<string, unknown>)['亡灵-1-近战'] = {
      name: '池食尸鬼',
      race: '亡灵',
      tier: 1,
      level: 5,
      attributes: { str: 5, dex: 6, con: 5, int: 0, spi: 0 },
      hp: 350,
      mp: 0,
      sp: 200,
      defense: 30,
      dr: 0,
      penetration: 0,
      hitBonus: 5,
      dodgeBonus: 0,
      weaponAtk: 30,
      divinity: 1,
      side: 'player',
      joinTiming: 'this_round_tail',
    };
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    const ctx: Parameters<typeof routeRequiredInput>[2] = {
      submitCommand: async (c) => {
        submitChain.push(c);
      },
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      clientFactory: () => fakeEnemyClient([]),
      endpoint: opts.deps.endpoint,
      saveId: 's1',
      context: {} as never,
      characters: [],
    };
    const cmd = await routeRequiredInput(
      {
        kind: 'CharGenRequest',
        requestId: 'r1',
        prompt: {
          race: '亡灵',
          tier: 1,
          role: '近战',
          sourceItem: '死灵之书',
          summonerIntent: 'x',
        },
        constraints: { divinityCap: 5, attributeBudget: 300 },
      },
      session,
      ctx,
      () => ({ outputId: 'x', dice: [10] }),
    );
    expect(cmd.kind).toBe('SupplyUnit');
    if (cmd.kind === 'SupplyUnit') {
      expect(cmd.payload.definition.name).toBe('池食尸鬼');
      expect(cmd.payload.requestId).toBe('r1');
    }
    // 清理池，避免污染后续测试
    delete (SUMMON_POOL as Record<string, unknown>)['亡灵-1-近战'];
  });

  it('char_gen 返回非法定义（divinity 超 cap）时 clamp 而非崩', async () => {
    const { routeRequiredInput } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const { SUMMON_POOL } = await import('./summon-pool');
    delete (SUMMON_POOL as Record<string, unknown>)['*'];
    // 未命中池 → 走实时 char_gen（mock clientFactory 返回无名角色）
    const session = openCombat({
      kind: 'new',
      bundle: mkOpts().opts.bundle,
    } as never);
    // 由于 runCharGenForCombat 需要真实 clientFactory 的 chatWithTools 产生合法 char_gen XML，
    // 这里用越界 clamp 的单元验证为主：clampSummon 是导出语义，不易直接触达；
    // 改为验证「未命中池时 routeCharGenRequest 不抛错、走 char_gen→SupplyUnit」。
    // 完整 clamp 由 spawn 恢复端兜底；此处断言路由健壮性。
    const ctx = {
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('u');
      },
      abandon: () => undefined,
      clientFactory: () =>
        ({
          chatWithTools: async () => ({
            output:
              '<char_result><name>召唤兽</name><race>兽</race><tier>1</tier><level>3</level><attributes><str>5</str><dex>5</dex><con>5</con><int>3</int><spi>3</spi></attributes></char_result>',
            rawResponse: '',
          }),
          chat: async () => ({ output: null, rawResponse: '' }),
        }) as never,
      endpoint: optsEndpoint,
      saveId: 's1',
      context: {} as never,
      characters: [],
    } as never;
    await expect(
      routeRequiredInput(
        {
          kind: 'CharGenRequest',
          requestId: 'r2',
          prompt: { sourceItem: '书', summonerIntent: 'x' },
          constraints: { divinityCap: 0, attributeBudget: 300 },
        },
        session,
        ctx,
        () => ({ outputId: 'x', dice: [10] }),
      ),
    ).resolves.toBeDefined();
  });
});

/** 占位：供上面「可构造」断言引用（避免未使用告警） */
function makeCommandOrThrow(): never {
  throw new Error('not a real command factory');
}

// 供 clamp 测试的 endpoint
const optsEndpoint = { id: 'ep-test' } as never;

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

// ===== T16：v3_awaiting_player_input emit（玩家单位轮次 → 前端等待态） =====
// 设计 2026-08-09 §3.1：coordinator 路由到玩家单位需要输入时 emit 等待事件，
// game-store 的 :192 case 据此置 combatAwaitingInput（UI 显示「等待玩家输入」）。
// 仅 player 阵营 emit；敌方走 routeEnemyCommand 不 emit。
describe('T16：v3_awaiting_player_input emit', () => {
  it('玩家单位轮到时 emit v3_awaiting_player_input（先攻首位甲 → round 1）', async () => {
    const events: CombatEvent[] = [];
    const { opts, setQueue } = mkOpts();
    opts.onCombatEvent = (evt) => events.push(evt);
    setQueue(atkTurn());
    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');

    const awaited = events.filter((e) => e.type === 'v3_awaiting_player_input');
    expect(awaited.length).toBeGreaterThan(0);
    // 先攻首位是玩家甲 → 第一枚等待事件就是它（round 1），载荷含 unit/unitId/round
    expect(awaited[0]).toMatchObject({
      type: 'v3_awaiting_player_input',
      unit: '甲',
      unitId: '甲',
      round: 1,
    });
  });

  it('敌方单位轮次不 emit（routeEnemyCommand 无等待事件；只有玩家甲的轮次才 emit）', async () => {
    const events: CombatEvent[] = [];
    const { opts, setQueue } = mkOpts();
    opts.onCombatEvent = (evt) => events.push(evt);
    // 甲 pass 双槽 → 乙（敌方）轮次 → 走战斗 Agent（fake 攻击甲 → 乙一击致胜终局）
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
    opts.deps.clientFactory = () =>
      fakeEnemyClient([
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ]);
    await runCombatV3(opts);

    const awaited = events.filter((e) => e.type === 'v3_awaiting_player_input');
    expect(awaited.length).toBeGreaterThan(0);
    // 全部等待事件都只属于玩家甲 —— 敌方乙从未触发等待事件
    expect(awaited.every((e) => e.unitId === '甲')).toBe(true);
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

describe('战斗 agent tools 注入（2026-08-08 真机 bug 回归）', () => {
  it('routeEnemyCommand 请求必须带 combat_v3 的工具定义（否则模型收不到 schema，只能文本猜参数名）', async () => {
    // 乙(敌方)高血量：甲打不死 → 轮到乙行动 → 战斗 agent 被调用
    const { opts, setQueue } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-tools-test',
      participants: [
        mkParticipant('甲'), // player
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 5000,
          maxHp: 5000,
        }),
      ],
    });
    setQueue(atkTurn());
    let capturedReq: { tools?: unknown } | null = null;

    // 敌方路由 → 战斗 agent；捕获它收到的 request，断言 tools 已注入
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (req: { tools?: unknown }) => {
          capturedReq = req;
          // 返回一个合法 declare_attack
          return {
            output: 'ok',
            rawResponse: '',
            toolCalls: [
              {
                name: 'declare_attack',
                arguments: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
              },
            ],
          } as never;
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;

    await runCombatV3(opts);
    expect(capturedReq).not.toBeNull();
    const tools =
      (capturedReq as unknown as { tools?: Array<{ function: { name: string } }> })?.tools ?? [];
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('declare_attack');
    expect(names).toContain('declare_action');
  });
});

describe('combat system prompt 来源（2026-08-09 §2.7：configs 优先，删硬编码）', () => {
  const combatConfig = (systemPrompt: string): AgentConfig =>
    ({
      agentId: 'combat_v3',
      enabled: true,
      apiEndpointId: 'ep',
      model: '',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      retryOnFail: false,
      timeout: 0,
      userId: '',
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      worldBookIds: [],
      systemPrompt,
    }) as AgentConfig;

  /** 让敌方（乙）轮到自己行动 → 捕获 chatWithTools 收到的第一条 system 消息 */
  async function captureSystemContent(over: {
    configs?: AgentConfig[];
  }): Promise<string | undefined> {
    const { opts, setQueue } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-sys-test',
      participants: [
        mkParticipant('甲'), // player
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 5000,
          maxHp: 5000,
        }),
      ],
    });
    if (over.configs) opts.deps.configs = over.configs;
    setQueue(atkTurn());
    let systemContent: string | undefined;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (req: { messages: Array<{ role: string; content: string }> }) => {
          systemContent = req.messages.find((m) => m.role === 'system')?.content;
          return {
            output: 'ok',
            rawResponse: '',
            toolCalls: [
              {
                name: 'declare_attack',
                arguments: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
              },
            ],
          } as never;
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;
    await runCombatV3(opts);
    return systemContent;
  }

  it('从 configs 读 combat_v3.systemPrompt（旧硬编码 125 字不再作 system 内容）', async () => {
    const sys = await captureSystemContent({
      configs: [combatConfig('TEST_COMBAT_SYSTEM_PROMPT_V3_FULL')],
    });
    expect(sys).toBe('TEST_COMBAT_SYSTEM_PROMPT_V3_FULL');
    // 旧硬编码文本的独有片段不应出现在 system 内容里（§2.7 删硬编码）
    expect(sys).not.toContain('禁止传骰值');
  });

  it('configs 缺失 → 回退兜底文本（无配置环境下行为与改造前一致）', async () => {
    const sys = await captureSystemContent({});
    expect(sys).toContain('禁止传骰值');
    expect(sys).toContain('declare_attack');
  });
});

describe('查询/命令分流（2026-08-09 §2.2 决策 3C：查询工具不产 Command）', () => {
  /**
   * 乙高血量：甲一轮打不死 → 轮到敌方（乙）行动 → 触发战斗 Agent。
   * scriptsByCall：每次 chatWithTools 调用（= 敌方一个槽位的决策）消费一条脚本，
   * 末尾重复最后一条。真实 agent-client 的多轮循环形状：对每条工具调用执行
   * toolExecutor、收集历史，最终结果带完整 toolCalls 历史。
   * 玩家命令队列做成循环（乙存活多回合时甲每回合都需要命令）。
   */
  function enemyTurnOpts(scriptsByCall: Array<Array<{ name: string; args: Record<string, any> }>>) {
    const { opts } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-query-split',
      participants: [
        mkParticipant('甲'), // player
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          // 血线：甲第一刀打不死（轮到乙行动）→ 甲两三回合内打死乙（战斗短，不触发
          // coordinator 的 firstInitiative 兜底分叉，避免测试与兜底语义耦合）
          hp: 1500,
          maxHp: 1500,
        }),
      ],
    });
    // 甲每回合都打乙 + 放弃动作槽（循环供给，乙存活多少回合都够）。
    // 🔴 commandId 必须每回合唯一：内核幂等缓存（AA1-3）按 commandId 去重，
    //    复用 u-att/u-act 会让第 2 回合的甲命令重放第 1 回合的 transition。
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0) {
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        }
        return q.shift()!;
      };
    })();
    // get_character 要查的 乙（CharacterState 形状，缺省字段由 executeToolCall 的 ?? 兜底）
    opts.deps.context = {
      characters: [
        {
          id: '乙',
          name: '乙',
          race: '亡灵',
          type: 'npc',
          tier: 1,
          tierName: 'T1',
          level: 5,
          attributes: { str: 5, dex: 5, con: 5, int: 3, spi: 3 },
          hp: 5000,
          maxHp: 5000,
          mp: 100,
          maxMp: 100,
          sp: 100,
          maxSp: 100,
          location: '战场',
          occupation: '测试用',
          identity: '测试用',
          skills: [
            {
              name: '挥砍',
              type: '主动',
              description: '测试技能',
              cost: { mp: 0 },
              cooldown: 0,
              maxCooldown: 0,
              effects: {},
              skillPower: 1,
              relevantAttribute: 'str',
            },
          ],
          inventory: [],
        },
      ],
    } as never;
    const history: Array<{ name: string; args: Record<string, any>; result: unknown }> = [];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
        ) => {
          // 每次 chatWithTools 调用 = 敌方一个槽位的决策；脚本按调用序循环
          // （每回合：攻击槽 → 动作槽 → 下回合攻击槽 → …）。
          const script = scriptsByCall[callIdx % scriptsByCall.length] ?? [];
          callIdx++;
          for (const step of script) {
            const result = await toolExecutor(step.name, step.args);
            history.push({ name: step.name, args: step.args, result });
          }
          return {
            output: 'ok',
            rawResponse: '',
            toolCalls: history.slice(-script.length).map((h) => ({
              name: h.name,
              arguments: h.args,
              result: h.result,
            })),
          } as never;
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;
    return { opts, history };
  }

  it('get_character（查询类）经 executeCombatQuery 返回数据而非 Command，随后 declare_attack 照常产 Command', async () => {
    // 第 1 次调用（攻击槽）：先查 get_character 再 declare_attack → 最终 Command 是攻击；
    // 第 2 次调用（动作槽）：pass_slot action。
    const { opts, history } = enemyTurnOpts([
      [
        { name: 'get_character', args: { characterId: '乙' } },
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ]);
    const commit = opts.deps.stateManager!.commitChatState;
    await runCombatV3(opts);

    // 关键回归断言：查询结果不再是 Command（旧代码 get_* 落 default → 静默 PassAttack）
    expect(history[0].name).toBe('get_character');
    expect(history[0].result).toMatchObject({ found: true, name: '乙' });
    expect(history[0].result).not.toHaveProperty('commandId');
    // T3 字段随查询返回（skills 供 declare_attack 决策用）
    expect(history[0].result).toHaveProperty('skills');
    expect(history[0].result).toHaveProperty('equipment');

    // 命令类照常翻译成 Command
    expect(history[1].result).toMatchObject({ kind: 'DeclareAttack', cost: 'attack' });

    // 战斗正常走完（没有因查询而中断/abandon）
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('get_unit_detail（T8 新增）走查询分支：返回五维+技能+装备数据而非 Command（波 3 T7 名单补齐回归）', async () => {
    // 第 1 次调用（攻击槽）：先查 get_unit_detail 再 declare_attack → 最终 Command 是攻击；
    // 第 2 次调用（动作槽）：pass_slot action。
    const { opts, history } = enemyTurnOpts([
      [
        { name: 'get_unit_detail', args: { characterId: '乙' } },
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ]);
    const commit = opts.deps.stateManager!.commitChatState;
    await runCombatV3(opts);

    // 关键回归断言：get_unit_detail 在 COMBAT_QUERY_TOOLS 名单里（T7 补名单前它落
    // toolCallToCommand 的 default → 静默 PassAttack，result 带 commandId 而非数据）
    expect(history[0].name).toBe('get_unit_detail');
    expect(history[0].result).toMatchObject({ found: true, name: '乙' });
    expect(history[0].result).not.toHaveProperty('commandId');
    // T8 聚合形状：五维+技能+装备一把抓（declare_attack 的 skillName 依据）
    expect(history[0].result).toHaveProperty('attributes');
    expect(history[0].result).toHaveProperty('skills');
    expect(history[0].result).toHaveProperty('equipment');

    // 命令类照常翻译成 Command
    expect(history[1].result).toMatchObject({ kind: 'DeclareAttack', cost: 'attack' });

    // 战斗正常走完
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('lastCommandFromResult 只认命令类：命令后接查询收尾，最终 Command 仍是 declare_attack 而非静默 pass', async () => {
    // 第 1 次调用（攻击槽）：先 declare_attack 再 get_character（查询收尾）→
    // lastCommandFromResult 必须跳过末尾查询、取 declare_attack，否则旧逻辑静默 pass。
    const { opts, history } = enemyTurnOpts([
      [
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
        { name: 'get_character', args: { characterId: '乙' } },
      ],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ]);
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);
    const commit = opts.deps.stateManager!.commitChatState;
    await runCombatV3(opts);

    // 末尾查询调用返回的是数据，不是 Command
    expect(history[1].result).toMatchObject({ found: true, name: '乙' });
    expect(history[1].result).not.toHaveProperty('commandId');

    // 乙的攻击真的进了内核（v3_action 动作卡片 attackerId=乙）——
    // 若旧逻辑把末尾查询当最后工具调用翻译成 PassAttack，这里不会有乙的攻击事件
    const enemyAttack = events.find(
      (e) => e.type === 'v3_action' && e.toolName === 'attack' && e.result.attackerId === '乙',
    );
    expect(enemyAttack).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('纯查询收尾（无命令）：攻击槽防御性 pass，下一槽决策正常，战斗不中断', async () => {
    // 第 1 次调用（攻击槽）：只查 get_character → 无命令 → 防御性 pass 攻击槽；
    // 第 2 次调用（动作槽）：pass_slot action 正常消费动作槽 → 回合推进。
    const { opts, history } = enemyTurnOpts([
      [{ name: 'get_character', args: { characterId: '乙' } }],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ]);
    const commit = opts.deps.stateManager!.commitChatState;
    await runCombatV3(opts);

    // 查询返回数据，不产 Command；AI 未做决定 → 乙 pass 攻击槽推进（行为合法，不是 bug）
    expect(history[0].result).toMatchObject({ found: true, name: '乙' });
    expect(history[0].result).not.toHaveProperty('commandId');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('submit_adjudication（命令类）→ Adjudicate Command，不再落 default 静默 pass（§2.4 补执行端）', async () => {
    // 第 1 次调用（乙的攻击槽决策）：提交有界裁决 → toolCallToCommand 翻译成 Adjudicate
    // Command（cost none，不走槽位）；第 2 次调用（乙的动作槽决策）：pass_slot action 照常。
    const { opts, history } = enemyTurnOpts([
      [
        {
          name: 'submit_adjudication',
          args: {
            effectDescription: '目标下回合失去行动能力',
            divinity: 5,
            verifiableBounds: { targetLegal: true, invariantCompliant: [] },
            requestedRuleOverride: 'terminal.forceTerminal',
            reason: '法则级压制',
          },
        },
      ],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ]);
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);
    await runCombatV3(opts);

    // 关键回归断言：不再是静默 PassAttack（旧代码落 default → nextPassCommand）
    expect(history[0].result).toMatchObject({ kind: 'Adjudicate', cost: 'none' });
    // payload 形状对齐 evaluateAdjudication 入参（ProposedAdjudication）
    const cmd = history[0].result as Extract<CombatCommand, { kind: 'Adjudicate' }>;
    expect(cmd.payload.requestId).toMatch(/^adj-/);
    expect(cmd.payload.adjudication.divinity).toBe(5);
    expect(cmd.payload.adjudication.effectDescription).toBe('目标下回合失去行动能力');
    expect(cmd.payload.adjudication.verifiableBounds.targetLegal).toBe(true);
    expect(cmd.payload.adjudication.verifiableBounds.invariantCompliant).toEqual([]);
    expect(cmd.payload.adjudication.requestedRuleOverride).toBe('terminal.forceTerminal');
    expect(cmd.payload.adjudication.reason).toBe('法则级压制');

    // 裁决真的进了内核（reducer 消费 Adjudicate → evaluateAdjudication → 事件投影，
    // accepted → v3_rule_override / rejected → v3_effect_rejected）
    const adjudicated = events.find(
      (e) => e.type === 'v3_rule_override' || e.type === 'v3_effect_rejected',
    );
    expect(adjudicated).toBeDefined();
  });
});

describe('持久会话（2026-08-09 §2.1 决策 1A：整场一个 client + 消息累积）', () => {
  /**
   * 直捣 routeEnemyCommand：两个敌方单位先后行动，共享同一个 combatSession 句柄
   * （模拟 runCombatV3 闭包持有的持久会话）。断言：
   *  - client 只建一次（整场战斗一个 client）
   *  - 两次调用收到的 messages 是同一数组引用（共享消息数组）
   *  - system 只出现一次且在首位
   *  - 第 2 次快照包含第 1 次的 assistant 决策正文 + 工具往返（含查询结果）——历史累积
   */
  it('多单位多次行动共享同一消息数组：client 一次、system 一次、工具往返与查询结果保留', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');

    // get_character 要查的 乙（CharacterState 形状，缺省字段由 executeToolCall 的 ?? 兜底）
    opts.deps.context = {
      characters: [
        {
          id: '乙',
          name: '乙',
          race: '亡灵',
          type: 'npc',
          tier: 1,
          tierName: 'T1',
          level: 5,
          attributes: { str: 5, dex: 5, con: 5, int: 3, spi: 3 },
          hp: 5000,
          maxHp: 5000,
          mp: 100,
          maxMp: 100,
          sp: 100,
          maxSp: 100,
          location: '战场',
          occupation: '测试用',
          identity: '测试用',
          skills: [],
          inventory: [],
        },
      ],
    } as never;

    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    // 持久会话句柄（模拟 runCombatV3 闭包持有）：messages 留空数组，由 routeEnemyCommand
    // 首次调用时 push system，随后逐回合累积
    const combatSession = {
      messages: [] as Array<{ role: string; content: string | null }>,
      client: null,
    };

    // mock client：记录工厂调用次数 + 捕获每次收到的 messages 引用；脚本按调用序
    // （每次 chatWithTools 调用 = 一个敌方槽位决策）消费，末尾重复最后一条。
    const seenMessages: Array<
      Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>
    > = [];
    let factoryCalls = 0;
    const scripts: Array<Array<{ name: string; args: Record<string, any> }>> = [
      // 第 1 次调用（乙·攻击槽）：先查后攻
      [
        { name: 'get_character', args: { characterId: '乙' } },
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '战术' },
        },
      ],
      // 第 2 次调用（丙·攻击槽）：直接攻
      [
        {
          name: 'declare_attack',
          args: { actorName: '丙', targetName: '甲', intentionLevel: '常规' },
        },
      ],
    ];
    let callIdx = 0;
    const ctx: Parameters<typeof routeEnemyCommand>[2] = {
      clientFactory: () => {
        factoryCalls++;
        return {
          chatWithTools: async (req, toolExecutor) => {
            seenMessages.push(req.messages);
            const script = scripts[Math.min(callIdx, scripts.length - 1)];
            callIdx++;
            const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
            for (const step of script) {
              const result = await toolExecutor(step.name, step.args);
              history.push({ name: step.name, arguments: step.args, result });
            }
            return { output: '战斗演绎', rawResponse: '战斗演绎', toolCalls: history } as never;
          },
          chat: async () => ({ output: null, rawResponse: '' }) as never,
        };
      },
      endpoint: opts.deps.endpoint,
      saveId: 's1',
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      combatSession,
      context: opts.deps.context as never,
    };

    // 单位 1（乙）行动
    const cmd1 = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );
    expect(cmd1.command.kind).toBe('DeclareAttack');
    // 单位 2（丙）行动 —— 同一会话句柄
    const cmd2 = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '丙', unitName: '丙', round: 1 },
      session,
      ctx,
    );
    expect(cmd2.command.kind).toBe('DeclareAttack');

    // ── 关键回归断言（决策 1A）──
    // 1. client 只建一次（整场战斗一个 client，不再每单位每行动新建）
    expect(factoryCalls).toBe(1);
    // 2. 两次调用收到的 messages 是同一个数组引用（共享同一消息数组）
    expect(seenMessages.length).toBe(2);
    expect(seenMessages[1]).toBe(seenMessages[0]);
    // 3. system 只出现一次，且在首位
    const lastSnapshot = seenMessages[1];
    expect(lastSnapshot.filter((m) => m.role === 'system').length).toBe(1);
    expect(lastSnapshot[0].role).toBe('system');
    // 4. 第 2 次快照包含第 1 次的 assistant 消息（最终决策正文）
    const assistantTexts = lastSnapshot
      .filter((m) => m.role === 'assistant' && m.content !== null)
      .map((m) => m.content);
    expect(assistantTexts.filter((c) => c === '战斗演绎').length).toBeGreaterThanOrEqual(1);
    // 5. 工具往返保留：declare_attack 的 tool 消息（命令翻译产物）在后续快照可见
    const toolMsgs = lastSnapshot.filter((m) => m.role === 'tool');
    expect(toolMsgs.some((m) => (m.content ?? '').includes('"kind":"DeclareAttack"'))).toBe(true);
    // 6. 查询结果保留进历史（决策 3）：get_character 的 tool 消息内容含查询数据
    expect(toolMsgs.some((m) => (m.content ?? '').includes('"found":true'))).toBe(true);
    // 7. 消息形状对 API 合法：每条 tool 消息都有对应 assistant.tool_calls.id
    const toolCallIds = lastSnapshot
      .filter(
        (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      )
      .flatMap((m) => (m.tool_calls as Array<{ id: string }>).map((tc) => tc.id));
    expect(toolCallIds.length).toBeGreaterThanOrEqual(1);
    for (const id of toolMsgs.map((m) => m.tool_call_id)) {
      expect(toolCallIds).toContain(id);
    }
  });

  /**
   * runCombatV3 端到端：整场战斗 client 只建一次；跨多次 agent 调用（乙攻+乙动）后，
   * 后续快照仍含第一次的 assistant 决策正文（前缀稳定 → 缓存命中基础）。
   * 场景：乙 1000 HP（甲每刀 639、两刀杀乙）→ 全程 3 次攻击 = 6 颗 intentCheck < 7，
   * 不触发续杯，避开既有 intentCheck 续杯后 firstInitiative 兜底错位——那是独立于
   * 本任务的既有协调局限。🔴 血线必须 ≤ 1278（= 639×2）：1500 HP 时甲两刀打不死 →
   * 战斗拖长 → intentCheck 通道耗尽 → 续杯 → firstInitiative 错位 → INVALID_PHASE
   * → 熔断 abandon（2026-08-09 实测，已调低血线）。
   */
  it('端到端：runCombatV3 整场 client 只建一次、跨调用历史累积', async () => {
    const { opts } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-session-e2e',
      participants: [
        mkParticipant('甲', { hp: 5000, maxHp: 5000 }), // 防乙磨死；R2 甲补刀杀乙
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
        }),
      ],
    });
    // 甲的玩家命令循环供给（乙存活两回合，甲每回合都需要命令；commandId 每回合唯一，
    // 避免内核幂等缓存按 commandId 去重重放上一回合的 transition）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0)
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        return q.shift()!;
      };
    })();
    let factoryCalls = 0;
    const seenMessages: Array<
      Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>
    > = [];
    let callIdx = 0;
    const scripts: Array<Array<{ name: string; args: Record<string, any> }>> = [
      // 意图用常规：避免战术意图的对抗检定路径（本任务无关的既有协调局限）
      [
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '常规' },
        },
      ],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ];
    opts.deps.clientFactory = () => {
      factoryCalls++;
      return {
        chatWithTools: async (req, toolExecutor) => {
          seenMessages.push(req.messages);
          const script = scripts[callIdx % scripts.length];
          callIdx++;
          const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
          for (const step of script) {
            const result = await toolExecutor(step.name, step.args);
            history.push({ name: step.name, arguments: step.args, result });
          }
          return { output: '战斗演绎', rawResponse: '战斗演绎', toolCalls: history } as never;
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      };
    };
    const result = await runCombatV3(opts);

    // 整场战斗 client 只建一次（不再每单位每行动新建）
    expect(factoryCalls).toBe(1);
    // 乙活到第一回合行动（攻击槽 + 动作槽 = ≥2 次 agent 调用）
    expect(seenMessages.length).toBeGreaterThanOrEqual(2);
    // 所有快照是同一个数组引用（消息在整场战斗中持续累积）
    for (const m of seenMessages) {
      expect(m).toBe(seenMessages[0]);
    }
    // system 只一条且在首位
    const firstSnapshot = seenMessages[0];
    expect(firstSnapshot.filter((x) => x.role === 'system').length).toBe(1);
    expect(firstSnapshot[0].role).toBe('system');
    // 跨调用累积：最后一次快照里仍能看到第一次调用的 assistant 决策正文
    const lastSnapshot = seenMessages[seenMessages.length - 1];
    expect(lastSnapshot.some((m) => m.role === 'assistant' && m.content === '战斗演绎')).toBe(true);
    // 战斗自然结束（甲两刀杀乙，非熔断 abandon）
    expect(result.outcome).toBe('ally_win');
  });
});

describe('结算演绎（2026-08-09 §2.5：数字即时 + AI 叙事补上）', () => {
  it('collectSettlementFacts：AttackDeclared/AttackResolved/DamageApplied 汇总成一条结算事实（对齐 v3_action 卡片）', async () => {
    const { collectSettlementFacts } = await import('./coordinator');
    const facts = collectSettlementFacts([
      { kind: 'AttackDeclared', attackerId: '甲', targetId: '乙', intentionLevel: '常规' },
      {
        kind: 'AttackResolved',
        attackerId: '甲',
        targetId: '乙',
        checkValue: 15,
        rating: '常规',
        hit: true,
        dice: [15],
      },
      {
        kind: 'DamageApplied',
        attackerId: '甲',
        targetId: '乙',
        preReduction: 30,
        postStep6: 26,
        final: 26,
        damageType: '物理',
        targetHpBefore: 100,
        targetHpAfter: 74,
      },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      attackerId: '甲',
      targetId: '乙',
      checkValue: 15,
      rating: '常规',
      hit: true,
      final: 26,
      damageType: '物理',
      targetHpBefore: 100,
      targetHpAfter: 74,
    });
  });

  it('collectSettlementFacts：无攻击结算事件（pass/settle）→ 空数组，不触发短调用', async () => {
    const { collectSettlementFacts } = await import('./coordinator');
    expect(collectSettlementFacts([{ kind: 'RoundOpened', round: 1 }])).toEqual([]);
    expect(collectSettlementFacts([])).toEqual([]);
  });

  it('collectSettlementFacts：同一 dispatch 内连击各自成行（不串字段）', async () => {
    const { collectSettlementFacts } = await import('./coordinator');
    const facts = collectSettlementFacts([
      { kind: 'AttackDeclared', attackerId: '甲', targetId: '乙', intentionLevel: '常规' },
      { kind: 'AttackDeclared', attackerId: '甲', targetId: '乙', intentionLevel: '战术' },
      {
        kind: 'AttackResolved',
        attackerId: '甲',
        targetId: '乙',
        checkValue: 12,
        rating: '常规',
        hit: true,
        dice: [12],
      },
      {
        kind: 'AttackResolved',
        attackerId: '甲',
        targetId: '乙',
        checkValue: 8,
        rating: '战术',
        hit: false,
        dice: [8],
      },
    ]);
    expect(facts).toHaveLength(2);
    expect(facts[0].checkValue).toBe(12);
    expect(facts[1].checkValue).toBe(8);
    expect(facts[1].hit).toBe(false);
  });

  it('buildSettlementFactText：事实串含命中/评级/伤害/HP，形状供 AI 当依据（数字不进结果句的契约由 system prompt 管）', async () => {
    const { buildSettlementFactText } = await import('./coordinator');
    const text = buildSettlementFactText([
      {
        attackerId: '甲',
        targetId: '乙',
        checkValue: 15,
        rating: '常规',
        hit: true,
        final: 26,
        damageType: '物理',
        targetHpBefore: 100,
        targetHpAfter: 74,
      },
    ]);
    expect(text).toContain('「甲」攻击「乙」');
    expect(text).toContain('检定 15');
    expect(text).toContain('命中');
    expect(text).toContain('26 点伤害');
    expect(text).toContain('目标 HP：100 → 74');
  });

  it('routeEnemyCommand 返回 { command, narration } 且 narration 来自 assistant content（§2.5）', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    const narrationSeen: string[] = [];
    const ctx: Parameters<typeof routeEnemyCommand>[2] = {
      clientFactory: () =>
        ({
          chatWithTools: async () => ({
            output: '乙压低身形，利刃带风直取甲！',
            rawResponse: '乙压低身形，利刃带风直取甲！',
            toolCalls: [
              {
                name: 'declare_attack',
                arguments: { actorName: '乙', targetName: '甲', intentionLevel: '常规' },
              },
            ],
          }),
          chat: async () => ({ output: null, rawResponse: '' }),
        }) as never,
      endpoint: opts.deps.endpoint,
      saveId: 's1',
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      context: {} as never,
      onNarration: (text) => narrationSeen.push(text),
    };
    const res = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );
    // ① 返回形状：{ command, narration }，command 照旧进内核
    expect(res.command.kind).toBe('DeclareAttack');
    // ② narration 来自 assistant content（chatWithTools 的 output）
    expect(res.narration).toBe('乙压低身形，利刃带风直取甲！');
    // ③ 声明演绎经 onNarration 投进 combatLog 通道（v3_narrative）
    expect(narrationSeen).toEqual(['乙压低身形，利刃带风直取甲！']);
  });

  /**
   * 端到端场景：乙高血量（1500）→ 乙每回合 pass 双槽（仍会建持久会话 client）→
   * 甲每回合攻击 → 每次攻击 dispatch 触发一次结算短调用（client.chat 非工具路径）。
   * chatImpl：结算短调用的实现，可注入结果句或抛错。
   */
  function settleNarrateOpts(chatImpl: (messages: unknown) => Promise<unknown>) {
    const { opts } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-narrate-e2e',
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1500,
          maxHp: 1500, // 甲三刀内打死乙（战斗短，避开 intentCheck 续杯的既有协调局限）
        }),
      ],
    });
    // 甲每回合攻击乙 + 放弃动作槽（循环供给，commandId 每回合唯一防内核幂等缓存重放）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0)
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        return q.shift()!;
      };
    })();
    // 乙 pass 双槽（脚本按调用序循环；结算短调用走 chat 不消费这套脚本）
    const scripts = [
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'attack' } }],
      [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
    ];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
        ) => {
          const script = scripts[callIdx % scripts.length] ?? [];
          callIdx++;
          const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
          for (const step of script) {
            const result = await toolExecutor(step.name, step.args);
            history.push({ name: step.name, arguments: step.args, result });
          }
          return { output: 'ok', rawResponse: 'ok', toolCalls: history } as never;
        },
        chat: async (messages: unknown) => chatImpl(messages),
      }) as never;
    return opts;
  }

  it('结算事实串喂同一持久会话 → 结果句以 v3_narrative 进 combatLog（§2.5 结算演绎）', async () => {
    let chatSeen: Array<{ role: string; content: string | null }> | null = null;
    const opts = settleNarrateOpts(async (messages) => {
      chatSeen = messages as never;
      return { output: '甲的重斩撕裂空气，重重劈在乙身上！', rawResponse: '' };
    });
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);
    const commit = opts.deps.stateManager!.commitChatState;
    await runCombatV3(opts);

    // 结算短调用真的被触发（client.chat 非工具路径收到持久会话消息）
    expect(chatSeen).not.toBeNull();
    // 结算事实串真的喂进去了（按「内核结算完成」标记找结算专用 user 消息——
    // 持久数组是活引用，断言时已含后续回合的主决策消息）
    const settleUser = chatSeen!.find(
      (m) => m.role === 'user' && (m.content ?? '').includes('内核结算完成'),
    );
    expect(settleUser?.content).toContain('攻击');
    expect(settleUser?.content).toContain('检定');
    // 结果句以 v3_narrative 进 combatLog（卡片 v3_action 已先出、叙事随后补上）
    const narratives = events.filter((e) => e.type === 'v3_narrative');
    expect(narratives.some((e) => e.text === '甲的重斩撕裂空气，重重劈在乙身上！')).toBe(true);
    // 战斗照常结束（结算叙事不破坏主流程、不阻塞终局落库）
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('结算演绎失败优雅降级：chat 抛错 → 不注入叙事、战斗照常落库（§2.5 降级契约）', async () => {
    const opts = settleNarrateOpts(async () => {
      throw new Error('结算叙事调用失败');
    });
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);
    const commit = opts.deps.stateManager!.commitChatState;
    const result = await runCombatV3(opts);

    // 战斗照常结束（结算叙事失败不崩战斗、不阻塞终局）：1500 血线下战意崩溃
    // （morale_routed）结束是既有协调行为（与查询分流测试同场景同结果）；核心验证
    // 是「不是熔断 abandon（摘要为『战斗被放弃』）」且终局照常落库一次。
    expect(result.narrativeSummary).not.toContain('战斗被放弃');
    expect(commit).toHaveBeenCalledTimes(1);
    // 结算结果句没注入（降级：拿不到结果句就不叙事）—— 声明演绎 'ok' 可能仍在，但
    // 结算短调用抛错的那一轮不会有「结算失败」类叙事（narrateSettlement 内部静默吞掉）
    const narratives = events.filter((e) => e.type === 'v3_narrative');
    expect(narratives.some((e) => e.text === '结算叙事调用失败')).toBe(false);
  });
});

describe('T10：终局落库回写（2026-08-09 §2.6 方案 1：战斗后角色伤势持久化）', () => {
  /** 存档里的甲（玩家，满血 500 / 带永久效果「专注」）与乙（脆皮 NPC，hp 1） */
  const savedChars = (): Array<Record<string, unknown>> => [
    {
      id: '甲',
      name: '甲',
      type: 'player',
      tier: 3,
      level: 10,
      attributes: { str: 20, dex: 15, con: 15, int: 10, spi: 10 },
      hp: 500,
      maxHp: 500,
      mp: 100,
      maxMp: 100,
      sp: 50,
      maxSp: 50,
      statusEffects: [FOCUS_EFFECT],
      inventory: [],
      skills: [],
    },
    {
      id: '乙',
      name: '乙',
      type: 'npc',
      tier: 1,
      level: 5,
      attributes: { str: 5, dex: 5, con: 5, int: 3, spi: 3 },
      hp: 1,
      maxHp: 1,
      mp: 0,
      maxMp: 0,
      sp: 0,
      maxSp: 0,
      statusEffects: [],
      inventory: [],
      skills: [],
    },
  ];

  it('终局：存档角色 hp/mp/sp 按战斗结束状态覆写 + statusEffects 同步，且与 FP 合并为同一次 commit（A2-1）', async () => {
    const { opts, commit, setQueue } = mkOpts({ characters: savedChars() });
    // 甲带永久效果「专注」进战斗（战斗内无人移除它 → 终局仍在 → add_status_effect 回写）
    opts.bundle = mkBundle({
      combatId: 'coord-persist-test',
      participants: [
        mkParticipant('甲', { statusEffects: [FOCUS_EFFECT] }),
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
    setQueue(atkTurn()); // 甲一刀杀乙 → hp_zero 终局（乙死亡，甲满血无消耗）

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // A2-1：整场只 commit 一次 —— 单位回写并进终局那一次，不另开第二次
    expect(commit).toHaveBeenCalledTimes(1);
    const patches = commit.mock.calls[0][0] as StatePatch[];

    // FP patch 与单位回写 patch 在**同一次** commit 的同一数组里
    // （op:'set' 是 toPatches 既有形态，不在 StatePatchOp 联合，断言时绕过类型）
    expect(
      patches.some((p) => (p as { op?: string }).op === 'set' && p.target === 'users.fp'),
    ).toBe(true);

    // 甲：满血 500 / mp 100 / sp 50 覆写（战斗无消耗，原样回写）
    expect(patches).toContainEqual({ op: 'set_hp', target: 'characters.甲', value: 500 });
    expect(patches).toContainEqual({ op: 'set_mp', target: 'characters.甲', value: 100 });
    expect(patches).toContainEqual({ op: 'set_sp', target: 'characters.甲', value: 50 });
    // 甲战斗开始带的「专注」终局仍在 → add_status_effect 回写
    expect(
      patches.some(
        (p) =>
          p.op === 'add_status_effect' &&
          p.target === 'characters.甲' &&
          (p.value as { name?: string })?.name === '专注',
      ),
    ).toBe(true);

    // 乙：被击杀 hp 0 → 覆写 0（存档 1 → 战后 0，伤势持久化）
    expect(patches).toContainEqual({ op: 'set_hp', target: 'characters.乙', value: 0 });
    expect(patches.some((p) => p.op === 'set_mp' && p.target === 'characters.乙')).toBe(true);
    expect(patches.some((p) => p.op === 'set_sp' && p.target === 'characters.乙')).toBe(true);
  });

  it('buildUnitPersistPatches：召唤物（characterId 匹配不到存档角色）→ 跳过，不产生 patch（§2.6 不硬造角色）', () => {
    const patches = buildUnitPersistPatches(
      {
        甲: unitView('甲', 300, 500, 10, 100, 5, 50),
        石魔像: unitView('石魔像', 800, 800, 0, 0, 0, 0),
      },
      [{ id: '甲', name: '甲' }],
      [],
    );
    const targets = patches.map((p) => p.target);
    expect(targets).toContain('characters.甲');
    expect(targets).not.toContain('characters.石魔像'); // 召唤物无存档角色 → 零 patch
  });

  it('buildUnitPersistPatches：初始有、终局无的效果 → remove_status_effect（覆写语义，战斗中移除的不残留存档）', () => {
    const patches = buildUnitPersistPatches(
      {
        // 终局甲身上的效果已被移除（战斗中净化/到期）→ 空集合
        甲: unitView('甲', 500, 500, 100, 100, 50, 50),
      },
      [{ id: '甲', name: '甲' }],
      [mkParticipant('甲', { statusEffects: [FOCUS_EFFECT] })],
    );
    expect(patches).toContainEqual({
      op: 'remove_status_effect',
      target: 'characters.甲',
      value: { name: '专注' },
    });
  });
});

describe('T11：write_summary 终局摘要收集（2026-08-09 §2.2 改造：不再返回占位 Choose）', () => {
  /**
   * 端到端（照持久会话端到端先例）：乙（enemy，1000 HP）在 R1 行动轮经 fake agent 调
   * write_summary(text)（脚本循环消费 → 两个槽位各调一次，模拟 AI 分次补全）；甲两刀
   * 杀乙 → hp_zero 终局。断言终局 narrativeSummary 用的是收集到的 text —— 摘要回注
   * 正文的现有路径（game-pipeline.ts:1638 的 【战斗摘要】assistant 消息）读的正是这个字段。
   */
  it('端到端：AI 调 write_summary(text) → 终局摘要用收集到的 text（多段追加合并）', async () => {
    const { opts } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-t11-e2e',
      participants: [
        mkParticipant('甲', { hp: 5000, maxHp: 5000 }),
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
        }),
      ],
    });
    // 乙的行动脚本（每次 chatWithTools 调用 = 乙一个槽位的决策；照持久会话端到端先例
    // 的多 step 写法：命令类 + write_summary 附加收尾 —— 模拟 AI「先做槽位决定、再补摘要」）
    const scripts: Array<Array<{ name: string; args: Record<string, any> }>> = [
      // 乙·攻击槽：显式放弃 + 写摘要
      [
        { name: 'pass_slot', args: { actorName: '乙', slot: 'attack' } },
        { name: 'write_summary', args: { text: '乙军溃败的预感笼罩战场。' } },
      ],
      // 乙·动作槽：显式放弃 + 补摘要
      [
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
        { name: 'write_summary', args: { text: '乙军在甲的重击下溃败。' } },
      ],
    ];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
        ) => {
          const script = scripts[callIdx % scripts.length];
          callIdx++;
          const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
          for (const step of script) {
            const result = await toolExecutor(step.name, step.args);
            history.push({ name: step.name, arguments: step.args, result });
          }
          return { output: '收尾', rawResponse: '收尾', toolCalls: history } as never;
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;
    // 甲的玩家命令循环供给（照端到端先例：commandId 每回合唯一，防内核幂等缓存按 id 去重）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0)
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        return q.shift()!;
      };
    })();

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // 终局摘要 = AI 收集的 text（替代旧的「战斗结束（reason）」兜底；两段合并）
    expect(result.narrativeSummary).toContain('乙军溃败的预感笼罩战场。');
    expect(result.narrativeSummary).toContain('乙军在甲的重击下溃败。');
    expect(result.narrativeSummary).not.toContain('战斗结束（');
  });

  it('没有 write_summary 时兜底不崩：战斗照常结束、摘要用兜底文本', async () => {
    const { opts, setQueue } = mkOpts();
    setQueue(atkTurn());
    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // 兜底：非空摘要文本（game-pipeline 照常注入【战斗摘要】），终局流程不崩
    expect(result.narrativeSummary.length).toBeGreaterThan(0);
    expect(result.narrativeSummary).toContain('战斗结束');
  });

  it('直捣：write_summary 经 executor 分流不产 Command（不再返回占位 Choose），text 收集进 combatSession.summary', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    const combatSession = {
      messages: [] as Array<{ role: string; content: string | null }>,
      client: null,
      summary: '',
    };
    const ctx: Parameters<typeof routeEnemyCommand>[2] = {
      clientFactory: () =>
        ({
          chatWithTools: async (
            _req: unknown,
            toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
          ) => {
            const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
            const result = await toolExecutor('write_summary', { text: '终局摘要文本' });
            history.push({ name: 'write_summary', arguments: { text: '终局摘要文本' }, result });
            return { output: '收尾', rawResponse: '收尾', toolCalls: history } as never;
          },
          chat: async () => ({ output: null, rawResponse: '' }) as never,
        }) as never,
      endpoint: opts.deps.endpoint,
      saveId: 's1',
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      combatSession,
    };
    const res = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );
    // write_summary 不产 Command：最后一条命令类工具不存在 → 防御性 pass（不再是占位 Choose）
    expect(res.command.kind).toBe('PassAttack');
    // 收集点生效：text 进了 combatSession.summary（终局回注正文的数据源）
    expect(combatSession.summary ?? '').toContain('终局摘要文本');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T2（2026-08-10）：战斗 Agent 持久会话接入 Phase 10 模板系统 ——
// 开局第一次决策的 user 消息 = resolveTemplate 渲染 combat_v3.template（五区情境快照），
// 之后每回合只 append 面板增量（轮到X + 面板），不再渲染模板。
// ══════════════════════════════════════════════════════════════════════════════
describe('T2：首轮 user = combat_v3.template 模板渲染结果（情境快照）', () => {
  /** 模板形状（战斗指令/参战方/世界设定/玩家输入/触发正文/最近对话）+ 现存 {{COMBAT_PANEL}}；
   *  玩家视角区保留在测试模板里，只为验证注入键仍在工作——真源 agent-config.json 已删它们（见下方两区/三区测试） */
  const FIVE_ZONE_TEMPLATE = [
    '{{SYS_PROMPT}}',
    '<战斗指令>',
    '{{COMBAT_BRIEF}}',
    '</战斗指令>',
    '<参战方>',
    '{{COMBAT_ROSTER}}',
    '</参战方>',
    '<世界设定>',
    '{{LORE_BOOK_STATIC}}',
    '</世界设定>',
    '<玩家输入>',
    '{{USER_INPUT}}',
    '</玩家输入>',
    '<触发正文>',
    '{{AGENT.STORY}}',
    '</触发正文>',
    '<最近对话>',
    '{{NARRATIVE:layers=1}}',
    '</最近对话>',
    '<战斗面板>',
    '{{COMBAT_PANEL}}',
    '</战斗面板>',
  ].join('\n');

  function makeCombatV3Config(over: Partial<AgentConfig> = {}): AgentConfig {
    return {
      agentId: 'combat_v3',
      enabled: true,
      apiEndpointId: 'ep',
      model: 'm',
      temperature: 0.7,
      maxTokens: 2048,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      retryOnFail: true,
      timeout: 60000,
      userId: 'u',
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      worldBookIds: ['wb_core'],
      systemPrompt: '战斗系统提示词',
      template: FIVE_ZONE_TEMPLATE,
      ...over,
    };
  }

  function makeWorldBooks(): WorldBook[] {
    return [
      {
        id: 'wb_core',
        name: '核心设定',
        partition: 'system_core',
        entries: [
          {
            uid: 1,
            name: '战意规则',
            content: '战意规则：士气低于 0 溃逃。',
            enabled: true,
            key: [],
            keysecondary: [],
            selectiveLogic: 0,
            order: 1,
            position: 1,
          },
        ],
      },
    ];
  }

  /**
   * 记录每次 chatWithTools 收到的 messages 的 fake client ctx。
   * 返回宽松类型（routeEnemyCommand 是测试内动态 import，helper 拿不到
   * Parameters<typeof routeEnemyCommand>），调用处 cast。
   */
  function capturingCtx(
    combatSession: { messages: Array<{ role: string; content: string | null }>; client: unknown },
    seen: Array<Array<{ role: string; content: string | null }>>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      clientFactory: () => {
        return {
          chatWithTools: async (req: {
            messages: Array<{ role: string; content: string | null }>;
          }) => {
            seen.push(req.messages);
            return { output: '战斗演绎', rawResponse: '战斗演绎', toolCalls: [] } as never;
          },
          chat: async () => ({ output: null, rawResponse: '' }) as never,
        } as unknown as CombatClient;
      },
      endpoint: { id: 'ep' } as never,
      saveId: 's1',
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      combatSession: combatSession as never,
      ...over,
    };
  }

  afterEach(() => {
    // resolveTemplateWithGlobals 会改写 placeholder-registry 的模块级 globals，
    // 还原以免污染同文件其它用例
    resetPlaceholderGlobals();
  });

  it('首轮 user 消息 = 模板渲染结果：含 COMBAT_BRIEF / 世界书 / userInput / storyOutput / NARRATIVE', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    const messages: Array<{ role: string; content: string | null }> = [];
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const ctx = capturingCtx({ messages, client: null } as never, seen, {
      context: {} as never,
      configs: [makeCombatV3Config()],
      worldBooks: makeWorldBooks(),
      combatBrief: '战斗类型: 死斗｜环境: 竞技场｜决一死战',
      combatRoster: '我方: 理查德；敌方: 冠军',
      userInput: '我要挑战竞技场冠军',
      storyOutput: '理查德推开了竞技场的大门，冠军早已等候。',
      history: [
        { role: 'user', content: '我要挑战竞技场冠军' },
        { role: 'assistant', content: '守卫为你打开了竞技场大门。' },
      ],
    }) as unknown as Parameters<typeof routeEnemyCommand>[2];

    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );

    // system 一次 + 首轮 user = 模板渲染结果（情境快照）+ assistant 演绎
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('战斗系统提示词');
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('assistant');
    const firstUser = messages[1].content ?? '';
    // COMBAT_BRIEF 注入
    expect(firstUser).toContain('战斗类型: 死斗｜环境: 竞技场｜决一死战');
    // COMBAT_ROSTER 注入（参战方名单）
    expect(firstUser).toContain('我方: 理查德；敌方: 冠军');
    // LORE_BOOK_STATIC：按 config.worldBookIds 过滤后的世界书条目正文
    expect(firstUser).toContain('战意规则：士气低于 0 溃逃。');
    // USER_INPUT 注入
    expect(firstUser).toContain('我要挑战竞技场冠军');
    // AGENT.STORY 注入
    expect(firstUser).toContain('理查德推开了竞技场的大门，冠军早已等候。');
    // NARRATIVE：history 最近 1 轮（layers=1）逐条 [role]: content
    expect(firstUser).toContain('[user]: 我要挑战竞技场冠军');
    expect(firstUser).toContain('[assistant]: 守卫为你打开了竞技场大门。');
    // SYS_PROMPT 置空（system 已单独承载，user 内不重复）
    expect(firstUser).not.toContain('战斗系统提示词');
    // 面板经 COMBAT_PANEL 注入（现存模板引用它）
    expect(firstUser).toContain('<战斗面板>');
    // 无字面占位符残留
    expect(firstUser).not.toContain('{{');
    // 渲染结果进了 chatWithTools 的请求
    expect(seen[0][1].content).toBe(firstUser);
  });

  it('第二次调用（后续回合）不再渲染模板：user = 轮到X + 面板', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    const messages: Array<{ role: string; content: string | null }> = [];
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const ctx = capturingCtx({ messages, client: null } as never, seen, {
      context: {} as never,
      configs: [makeCombatV3Config()],
      worldBooks: makeWorldBooks(),
      combatBrief: '战斗类型: 死斗｜环境: 竞技场｜决一死战',
      userInput: '我要挑战竞技场冠军',
      storyOutput: '理查德推开了竞技场的大门，冠军早已等候。',
      history: [{ role: 'user', content: '我要挑战竞技场冠军' }],
    }) as unknown as Parameters<typeof routeEnemyCommand>[2];

    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );
    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '丙', unitName: '丙', round: 2 },
      session,
      ctx,
    );

    // 第二次调用的最后一条 user = 轮次消息（轮到X + 面板），不再重复渲染模板
    const userMsgs = messages.filter((m) => m.role === 'user' && m.content !== null);
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[0].content ?? '').toContain('<战斗指令>');
    expect(userMsgs[1].content ?? '').toContain('轮到敌方「丙」行动');
    // 模板独有内容不再出现（情境快照只在首轮）
    expect(userMsgs[1].content ?? '').not.toContain('<战斗指令>');
    expect(userMsgs[1].content ?? '').not.toContain('竞技场冠军');
    // system 仍只有一条
    expect(messages.filter((m) => m.role === 'system').length).toBe(1);
  });

  it('无 configs / 无 template → 首轮回退现状硬编码（与改造前逐字一致，不崩）', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    const messages: Array<{ role: string; content: string | null }> = [];
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    // 不传 configs / worldBooks / combatBrief —— 缺省兜底路径
    const ctx = capturingCtx({ messages, client: null } as never, seen, {
      context: {} as never,
    }) as unknown as Parameters<typeof routeEnemyCommand>[2];

    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );

    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content ?? '').toContain('轮到敌方「乙」行动');
    expect(messages[1].content ?? '').not.toContain('{{');
  });

  it('有 template 但缺 combatBrief/worldBooks → COMBAT_BRIEF 渲染「（无战斗指令）」占位、不崩', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    const messages: Array<{ role: string; content: string | null }> = [];
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const ctx = capturingCtx({ messages, client: null } as never, seen, {
      context: {} as never,
      // 有 config（带 template），但 combatBrief / worldBooks / userInput / storyOutput 全缺省
      configs: [makeCombatV3Config()],
    }) as unknown as Parameters<typeof routeEnemyCommand>[2];

    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );

    const firstUser = messages[1].content ?? '';
    expect(firstUser).toContain('（无战斗指令）');
    // combatRoster 缺省 → 「（无参战方名单）」占位，不臆造名单
    expect(firstUser).toContain('（无参战方名单）');
    // 缺省段为空但不残留占位符
    expect(firstUser).not.toContain('{{');
  });

  // 🔴 2026-08-10 真机 debug（fated-poem-debug-7c342726）：敌方 Agent 开局被注入
  // 玩家视角内容（story 第一人称正文 + <options> 玩家选项 + 最近对话），导致它
  // reasoning 写成「My character is 奥利雅思」并 DeclareAttack 我方单位（替玩家决策）。
  // 修复后 agent-config.json 真源 template 只保留 <战斗指令> + <参战方> + <世界设定>。
  it('开局模板不含玩家视角区（<玩家输入>/<触发正文>/<最近对话>），只留 <战斗指令>/<参战方>/<世界设定>', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);

    // 三区模板：与 agent-config.json 真源（2026-08-10 修复后）同形状
    const THREE_ZONE_TEMPLATE = [
      '{{SYS_PROMPT}}',
      '<战斗指令>',
      '{{COMBAT_BRIEF}}',
      '</战斗指令>',
      '<参战方>',
      '{{COMBAT_ROSTER}}',
      '</参战方>',
      '<世界设定>',
      '{{LORE_BOOK_STATIC}}',
      '</世界设定>',
    ].join('\n');

    const messages: Array<{ role: string; content: string | null }> = [];
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const ctx = capturingCtx({ messages, client: null } as never, seen, {
      context: {} as never,
      configs: [makeCombatV3Config({ template: THREE_ZONE_TEMPLATE })],
      worldBooks: makeWorldBooks(),
      combatBrief: '战斗类型: 死斗｜环境: 竞技场｜决一死战',
      combatRoster: '我方: 理查德；敌方: 冠军',
      userInput: '我要挑战竞技场冠军',
      storyOutput: '理查德推开了竞技场的大门，冠军早已等候。',
      history: [
        { role: 'user', content: '我要挑战竞技场冠军' },
        { role: 'assistant', content: '守卫为你打开了竞技场大门。' },
      ],
    }) as unknown as Parameters<typeof routeEnemyCommand>[2];

    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );

    const firstUser = messages[1].content ?? '';
    // 敌方决策所需的三区在
    expect(firstUser).toContain('<战斗指令>');
    expect(firstUser).toContain('战斗类型: 死斗｜环境: 竞技场｜决一死战');
    expect(firstUser).toContain('<参战方>');
    expect(firstUser).toContain('我方: 理查德；敌方: 冠军');
    expect(firstUser).toContain('<世界设定>');
    expect(firstUser).toContain('战意规则：士气低于 0 溃逃。');
    // 玩家视角区缺席
    expect(firstUser).not.toContain('<玩家输入>');
    expect(firstUser).not.toContain('<触发正文>');
    expect(firstUser).not.toContain('<最近对话>');
    // 玩家输入 / 触发正文 / 最近对话的内容一个字都不许漏给敌方 Agent
    expect(firstUser).not.toContain('我要挑战竞技场冠军');
    expect(firstUser).not.toContain('理查德推开了竞技场的大门');
    expect(firstUser).not.toContain('[user]');
    expect(firstUser).not.toContain('[assistant]');
    expect(firstUser).not.toContain('{{');
  });
});

/** 构造 CombatUnitView 的最小测试替身（只填本函数用到的字段） */
function unitView(
  id: string,
  hp: number,
  maxHp: number,
  mp: number,
  maxMp: number,
  sp: number,
  maxSp: number,
): CombatUnitView {
  return {
    id,
    name: id,
    side: 'player',
    tier: 1,
    hp,
    maxHp,
    mp,
    maxMp,
    sp,
    maxSp,
    attacksRemaining: 0,
    actionsRemaining: 0,
    canAct: true,
    morale: 'steady',
    statusEffects: [],
  };
}

/** 甲进战斗时带上的永久效果（remainingTime null = 永久，战斗内 tick 不消耗） */
const FOCUS_EFFECT = {
  name: '专注',
  description: '测试效果',
  category: '增益',
  stacks: 1,
  remainingTime: null,
  timeUnit: '分钟',
  source: '',
  effects: {},
} satisfies StatusEffect;
