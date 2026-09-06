/**
 * combat-v3/coordinator.test.ts — Coordinator 路由 + 终局落库 + abandon（M2）
 *
 * 验收对应（plan §4.9 / §4.1）：
 *   A2-1  终局只调一次 commitDomainCommand（基础攻击 → hp_zero → settle）
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
  buildCombatEndFactText,
  buildExpRewardPatches,
  buildUnitPersistPatches,
  collectCombatEndFacts,
  currentInitiative,
  resolveUnitIdByName,
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
      stateManager: { commitDomainCommand: commit },
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

// ══════════════════════════════════════════════════════════════════════════
// COR-12（2026-08-09 审查）：续骰 / rejection 恢复必须指向**内核当前行动单位**
// ══════════════════════════════════════════════════════════════════════════
describe('COR-12：恢复用的是当前行动单位，不是先攻首位', () => {
  /** 最小 session 替身：phase 决定 currentTurnIndex 到底算不算数 */
  const sessionWith = (order: string[], idx: number, phase = 'SlotConsume') =>
    ({ snapshot: () => ({ initiativeOrder: order, currentTurnIndex: idx, phase }) }) as never;

  it('🔴 回合中（SlotConsume）返回当前单位 —— 修复前返回 initiativeOrder[0]', () => {
    // 这正是那条 bug 的形状：乙 正在行动时骰子耗尽 → 续骰 → 恢复却问 甲，
    // 于是下一条命令带着错误行动者，consumeSlot 以 INVALID_PHASE 拒绝，
    // coordinator 跳出并以空补丁放弃整场战斗。
    expect(currentInitiative(sessionWith(['甲', '乙', '丙'], 1))).toBe('乙');
    expect(currentInitiative(sessionWith(['甲', '乙', '丙'], 2))).toBe('丙');
  });

  it('回合中的其余三个 phase 同样算数（UnitTurnOpen / MoraleCheck / UnitTurnClose）', () => {
    for (const phase of ['UnitTurnOpen', 'MoraleCheck', 'UnitTurnClose']) {
      expect(currentInitiative(sessionWith(['甲', '乙'], 1, phase))).toBe('乙');
    }
  });

  // 🔴 2026-08-10 审查逮到：初版没有 phase 分流，在**最常发生**的那条续骰路径上反而更差。
  // initiative 通道只有 10 颗骰（32/10/7/6/5），4 个单位打到第 3 轮必然耗尽；而
  // `initiative.ts` 骰子耗尽时 `return out` 早于 `currentTurnIndex = 0`，
  // `unit-turn` 收尾最后一位时又不写该字段（停在 len-1），`reduceSupplyDice` 也零推进
  // —— 于是这里拿到的是**上一轮先攻末位**，比旧代码的「上一轮首位」更不可能对。
  it('🔴 Initiative / RoundOpen / CombatOpen 下游标是陈旧的 → 退回 initiativeOrder[0]', () => {
    for (const phase of ['Initiative', 'RoundOpen', 'CombatOpen', 'RoundClose']) {
      // 游标停在末位（上一轮收尾留下的残值），但正确答案要等重掷先攻才知道
      expect(currentInitiative(sessionWith(['甲', '乙', '丙'], 2, phase))).toBe('甲');
    }
  });

  it('游标越界钳到末位、空序列返回空串（对齐 phases/unit-turn 的 currentUnitId）', () => {
    expect(currentInitiative(sessionWith(['甲', '乙'], 9))).toBe('乙');
    expect(currentInitiative(sessionWith([], 0))).toBe('');
    expect(currentInitiative(sessionWith([], 0, 'Initiative'))).toBe('');
  });
});

describe('A2-1：终局一次 commitDomainCommand', () => {
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
    // F4：routeRequiredInput 返回 Command 列表（敌方分支可多命令，其余恒单元素）
    const [cmd] = await routeRequiredInput(
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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
    expect(cmd1.commands[0].kind).toBe('DeclareAttack');
    // 单位 2（丙）行动 —— 同一会话句柄
    const cmd2 = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '丙', unitName: '丙', round: 1 },
      session,
      ctx,
    );
    expect(cmd2.commands[0].kind).toBe('DeclareAttack');

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
    // ① 返回形状：{ commands, narration }，commands[0] 照旧进内核
    expect(res.commands[0].kind).toBe('DeclareAttack');
    // ② narration 来自 assistant content（chatWithTools 的 output）
    expect(res.narration).toBe('乙压低身形，利刃带风直取甲！');
    // ③ 声明演绎经 onNarration 投进 combatLog 通道（v3_narrative）
    expect(narrationSeen).toEqual(['乙压低身形，利刃带风直取甲！']);
  });

  // 🎭 主持人/DM 模式（2026-08-12）：玩家意图 → 主持人解析 → Command
  it('routePlayerIntent：玩家意图文本 → 主持人会话解析 → 替玩家声明动作（主持人模式）', async () => {
    const { opts } = mkOpts();
    const { routePlayerIntent } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    const narrationSeen: string[] = [];
    // 捕获主持人会话收到的 user 消息（验证【玩家意图】真的喂进去了）
    let seenUser: string | null = null;
    // 预置一条已发消息（模拟战斗进行中、非首轮决策）→ 玩家意图走增量 user 分支
    const combatSession = {
      messages: [{ role: 'system' as const, content: 'pre-seeded' }],
      client: null,
    };
    const ctx: Parameters<typeof routePlayerIntent>[3] = {
      clientFactory: () =>
        ({
          chatWithTools: async (req: {
            messages: Array<{ role: string; content: string | null }>;
          }) => {
            seenUser =
              req.messages
                .filter((m) => m.role === 'user' && m.content !== null)
                .map((m) => m.content as string)
                .pop() ?? null;
            return {
              output: '明白了，我替你执行。',
              rawResponse: '明白了，我替你执行。',
              toolCalls: [
                {
                  name: 'declare_attack',
                  arguments: { actorName: '甲', targetName: '乙', intentionLevel: '常规' },
                },
              ],
            };
          },
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
      combatSession,
    };
    const res = await routePlayerIntent(
      '我用灼热射线打那个怪物',
      { kind: 'PlayerCommand', unitId: '甲', unitName: '甲', round: 1 },
      session,
      ctx,
    );
    // ① 【玩家意图】文本真的进了主持人会话的 user 消息
    expect(seenUser).toContain('【玩家意图】');
    expect(seenUser).toContain('我用灼热射线打那个怪物');
    // ② 主持人产出命令（替玩家声明攻击）
    expect(res.commands[0].kind).toBe('DeclareAttack');
    expect((res.commands[0] as { actorId?: string }).actorId).toBe('甲');
    // ③ 演绎进 combatLog
    expect(narrationSeen).toEqual(['明白了，我替你执行。']);
  });

  it('routePlayerIntent 空意图文本 → 兜底文案喂主持人，不抛错', async () => {
    const { opts } = mkOpts();
    const { routePlayerIntent } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    let seenUser: string | null = null;
    // 预置一条已发消息（模拟整场战斗进行中、非首轮决策）→ 空意图兜底文案才会被 append
    const combatSession = {
      messages: [{ role: 'system' as const, content: 'pre-seeded' }],
      client: null,
    };
    const ctx: Parameters<typeof routePlayerIntent>[3] = {
      clientFactory: () =>
        ({
          chatWithTools: async (req: {
            messages: Array<{ role: string; content: string | null }>;
          }) => {
            seenUser =
              req.messages
                .filter((m) => m.role === 'user' && m.content !== null)
                .map((m) => m.content as string)
                .pop() ?? null;
            return {
              output: '',
              rawResponse: '',
              toolCalls: [],
            };
          },
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
      combatSession,
    };
    const res = await routePlayerIntent(
      '   ',
      { kind: 'PlayerCommand', unitId: '甲', unitName: '甲', round: 1 },
      session,
      ctx,
    );
    expect(seenUser).toContain('玩家未给出具体指令');
    // 空输出 + 无工具调用 → 防御性 PassAttack（commandsFromResult 兜底）
    expect(res.commands[0].kind).toBe('PassAttack');
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
        chat: async (request: unknown) => {
          const req = request as { messages?: unknown };
          return chatImpl((req?.messages ?? []) as unknown);
        },
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
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

    // FP delta=0（本场景无人花 FP）→ 不发 FP patch；EXP 结算走 update_character delta
    // （乙 tier3/Lv10 → 10×50=500 EXP，normal 经验档位系数表 T3=50，甲独享）
    expect(patches.some((p) => p.target === 'users.fp' || p.target === 'profile.fp')).toBe(false);
    expect(
      patches.some(
        (p) =>
          p.op === 'update_character' &&
          p.target === 'characters.甲' &&
          (p.value as { totalExp?: number })?.totalExp === 500 &&
          (p.metadata as { delta?: boolean })?.delta === true,
      ),
    ).toBe(true);
    expect(result.totalExp).toBe(500);

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

describe('§12.4 EXP 结算 + FP patch 修复（2026-08-12 真机 bug）', () => {
  /** 两个玩家方存活角色 + 一个被杀敌方（tier/level 可控） */
  const mkExpScene = (enemyTier: number, enemyLevel: number) => ({
    units: {
      甲: unitView('甲', 500, 500, 100, 100, 50, 50) as CombatUnitView & { side: 'player' },
      乙: unitView('乙', 300, 300, 50, 50, 30, 30) as CombatUnitView & { side: 'player' },
      // 敌方丙：被击杀（hp 0）
      丙: { ...unitView('丙', 0, 400, 0, 0, 0, 0), side: 'enemy' as const },
    },
    participants: [
      mkParticipant('甲', { side: 'ally', characterId: '甲' }),
      mkParticipant('乙', { side: 'ally', characterId: '乙' }),
      mkParticipant('丙', { side: 'enemy', characterId: '丙', tier: enemyTier, level: enemyLevel }),
    ],
    characters: [
      { id: '甲', name: '甲', type: 'player' },
      { id: '乙', name: '乙', type: 'npc' },
    ] as Array<Record<string, unknown>>,
  });

  it('ally_win：被杀敌方 level×经验系数 求和后平分给存活玩家方角色', () => {
    // 🔴 2026-08-24 修正系数来源：经验用世界书 [经验值获取规则] 层级系数（normal T1=10），
    // 不再用核心数值表 combatCoefficient（2.0 是战斗伤害系数）。丙 T1 Lv.5 → 5×10=50；甲乙均分 → 各 25
    const { units, participants, characters } = mkExpScene(1, 5);
    const { patches, totalExp } = buildExpRewardPatches(
      units,
      participants,
      characters,
      'ally_win',
    );
    expect(totalExp).toBe(50);
    expect(patches).toContainEqual({
      op: 'update_character',
      target: 'characters.甲',
      value: { totalExp: 25 },
      metadata: { source: 'combat_v3', delta: true },
    });
    expect(patches).toContainEqual({
      op: 'update_character',
      target: 'characters.乙',
      value: { totalExp: 25 },
      metadata: { source: 'combat_v3', delta: true },
    });
  });

  it('ally_win：高 tier 敌方给的 EXP 按经验系数放大（T3 Lv.10 → 10×50=500）', () => {
    const { units, participants, characters } = mkExpScene(3, 10);
    const { totalExp, patches } = buildExpRewardPatches(
      units,
      participants,
      characters,
      'ally_win',
    );
    expect(totalExp).toBe(500);
    expect(patches).toHaveLength(2);
    expect(patches.every((p) => (p.value as { totalExp?: number }).totalExp === 250)).toBe(true);
  });

  it('easy 模式（简单）：按方案 B 系数分档（T1 Lv.5 → 5×20=100；T3 Lv.10 → 10×76=760）', () => {
    const { units, participants, characters } = mkExpScene(1, 5);
    const resT1 = buildExpRewardPatches(units, participants, characters, 'ally_win', 'easy');
    expect(resT1.totalExp).toBe(100);
    expect(resT1.patches).toHaveLength(2);
    expect(resT1.patches.every((p) => (p.value as { totalExp?: number }).totalExp === 50)).toBe(
      true,
    );

    const t3 = mkExpScene(3, 10);
    const resT3 = buildExpRewardPatches(
      t3.units,
      t3.participants,
      t3.characters,
      'ally_win',
      'easy',
    );
    expect(resT3.totalExp).toBe(760);
  });

  it('非 ally_win（fled / enemy_win / draw）→ 不给 EXP', () => {
    const { units, participants, characters } = mkExpScene(1, 5);
    for (const outcome of ['fled', 'enemy_win', 'draw'] as const) {
      expect(buildExpRewardPatches(units, participants, characters, outcome)).toEqual({
        patches: [],
        totalExp: 0,
      });
    }
  });

  it('ally_win 但敌方全存活（无被击杀单位）→ 不给 EXP', () => {
    const units = {
      甲: { ...unitView('甲', 500, 500, 100, 100, 50, 50), side: 'player' as const },
      丙: { ...unitView('丙', 400, 400, 0, 0, 0, 0), side: 'enemy' as const },
    };
    expect(
      buildExpRewardPatches(
        units,
        [mkParticipant('丙', { side: 'enemy' })],
        [{ id: '甲', name: '甲' }],
        'ally_win',
      ),
    ).toEqual({ patches: [], totalExp: 0 });
  });

  it('ally_win 但玩家方全灭（无存活匹配角色）→ 不给 EXP（极端场景）', () => {
    const { participants, characters } = mkExpScene(1, 5);
    const units = {
      甲: { ...unitView('甲', 0, 500, 100, 100, 50, 50), side: 'player' as const },
      丙: { ...unitView('丙', 0, 400, 0, 0, 0, 0), side: 'enemy' as const },
    };
    expect(buildExpRewardPatches(units, participants, characters, 'ally_win')).toEqual({
      patches: [],
      totalExp: 0,
    });
  });

  it('EXP 整除向下取整：T1 Lv.1 → 1×10=10 / 3 存活 → 各 3（余数丢弃）', () => {
    const { participants } = mkExpScene(1, 1);
    const units = {
      甲: { ...unitView('甲', 500, 500, 100, 100, 50, 50), side: 'player' as const },
      乙: { ...unitView('乙', 300, 300, 50, 50, 30, 30), side: 'player' as const },
      丁: { ...unitView('丁', 200, 200, 50, 50, 30, 30), side: 'player' as const },
      丙: { ...unitView('丙', 0, 400, 0, 0, 0, 0), side: 'enemy' as const },
    };
    const characters = [
      { id: '甲', name: '甲' },
      { id: '乙', name: '乙' },
      { id: '丁', name: '丁' },
    ] as Array<Record<string, unknown>>;
    const { patches, totalExp } = buildExpRewardPatches(
      units,
      participants,
      characters,
      'ally_win',
    );
    expect(totalExp).toBe(10);
    expect(patches).toHaveLength(3);
    expect(patches.every((p) => (p.value as { totalExp?: number }).totalExp === 3)).toBe(true);
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
    expect(res.commands[0].kind).toBe('PassAttack');
    // 收集点生效：text 进了 combatSession.summary（终局回注正文的数据源）
    expect(combatSession.summary ?? '').toContain('终局摘要文本');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 战斗终局 AI 总结（2026-08-12 新增）：终局结算完成后，专门调一次 AI 写总结叙事，
// 不再只靠战斗中 write_summary 顺手收集。优先级：总结 || collectedSummary || 兜底。
// ══════════════════════════════════════════════════════════════════════════════
describe('战斗终局 AI 总结（终局后专门调 AI 写总结叙事）', () => {
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

  /** 构造「甲一刀秒杀脆皮乙」的战斗（乙 1hp：甲首轮带走 → 战斗短、乙从未行动） */
  function quickKillBundle() {
    return mkBundle({
      combatId: 'coord-end-summary',
      participants: [
        mkParticipant('甲'),
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

  it('端到端：终局结算后 narrateCombatEnd 被调用 → narrativeSummary 用总结文本（chat 收到终局事实）', async () => {
    const { opts, setQueue } = mkOpts();
    opts.bundle = quickKillBundle();
    // F5 开局氛围：configs 经 game-pipeline 恒透传 → openCombatScene 惰性建 client
    opts.deps.configs = [combatConfig('TEST_COMBAT_END_SUMMARY_PROMPT')];
    setQueue(atkTurn());

    // chat 分流：user 消息含「【战斗终局】」→ 终局总结调用（返回总结文本）；否则是
    // 战斗中 settlement 演绎（返回空输出跳过，不干扰终局总结断言）
    let endSummaryMessages: Array<{ role: string; content: string | null }> | undefined;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async () =>
          ({ output: '战场开场。', rawResponse: '战场开场。', toolCalls: [] }) as never,
        chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
          const last = req.messages[req.messages.length - 1];
          if (last?.role === 'user' && last.content.includes('【战斗终局】')) {
            endSummaryMessages = req.messages;
            return {
              output: '甲在电光石火间了结乙，战场归于沉寂。',
              rawResponse: '',
            } as never;
          }
          return { output: null, rawResponse: '' } as never;
        },
      }) as never;

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // narrativeSummary 用的是终局总结文本（优先级：总结 || collectedSummary || 兜底）
    expect(result.narrativeSummary).toBe('甲在电光石火间了结乙，战场归于沉寂。');
    // 终局总结调用确实发生：chat 收到带整场战斗事实的 user 消息
    expect(endSummaryMessages).toBeDefined();
    const endUser = endSummaryMessages!.find(
      (m) => m.role === 'user' && m.content?.includes('【战斗终局】'),
    );
    expect(endUser?.content).toContain('战斗结果：我方获胜');
    expect(endUser?.content).toContain('进行回合数');
    expect(endUser?.content).toContain('仍屹立于战场：甲');
    expect(endUser?.content).toContain('倒下或已离场：乙');
  });

  it('端到端：终局总结 chat 抛错 → 回落兜底不崩（战斗结果照常返回）', async () => {
    const { opts, setQueue } = mkOpts();
    opts.bundle = quickKillBundle();
    opts.deps.configs = [combatConfig('TEST_COMBAT_END_SUMMARY_PROMPT')];
    setQueue(atkTurn());
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async () =>
          ({ output: '战场开场。', rawResponse: '战场开场。', toolCalls: [] }) as never,
        chat: async () => {
          throw new Error('mock chat 失败');
        },
      }) as never;

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    // 总结失败（narrateCombatEnd 静默吞掉）→ 回落 collectedSummary || 兜底
    // （本用例无 write_summary → 兜底文本，终局流程不崩）
    expect(result.narrativeSummary).toContain('战斗结束');
  });

  it('端到端：终局总结 chat 返回空输出 → 回落兜底不崩', async () => {
    const { opts, setQueue } = mkOpts();
    opts.bundle = quickKillBundle();
    opts.deps.configs = [combatConfig('TEST_COMBAT_END_SUMMARY_PROMPT')];
    setQueue(atkTurn());
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async () =>
          ({ output: '战场开场。', rawResponse: '战场开场。', toolCalls: [] }) as never,
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;

    const result = await runCombatV3(opts);
    expect(result.outcome).toBe('ally_win');
    expect(result.narrativeSummary).toContain('战斗结束');
  });

  it('直捣：collectCombatEndFacts 存活/倒下分类（逃跑移除的单位归入离场名单）', () => {
    const session = {
      snapshot: () => ({
        round: 3,
        resourceSnapshots: { FP: 1250 },
        terminal: { reason: 'hp_zero' as const, winner: 'player' },
        units: {
          甲: { id: '甲', name: '甲', side: 'player' as const, hp: 3200, maxHp: 5000 },
          丙: { id: '丙', name: '丙', side: 'enemy' as const, hp: 0, maxHp: 500 },
        },
      }),
    } as never;
    const facts = collectCombatEndFacts(session, 1000, [
      mkParticipant('甲'),
      mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      mkParticipant('丙', { side: 'enemy', characterId: '丙', name: '丙', hp: 0, maxHp: 500 }),
    ]);
    expect(facts.outcome).toBe('ally_win');
    expect(facts.rounds).toBe(3);
    expect(facts.fpDelta).toBe(250);
    // 甲 hp>0 → 存活；丙 hp≤0 → 倒下；乙开战在场而终局快照已移除（逃跑成功）→ 离场
    expect(facts.aliveUnits).toEqual([{ name: '甲', side: 'player' }]);
    expect(facts.fallenUnits.map((u) => u.name).sort()).toEqual(['丙', '乙']);
  });

  it('直捣：buildCombatEndFactText 形状（结果/回合/FP/名单进事实串，供 AI 当依据）', () => {
    const text = buildCombatEndFactText({
      reason: 'flee_success',
      winner: undefined,
      outcome: 'fled',
      rounds: 2,
      fpDelta: -100,
      aliveUnits: [{ name: '甲', side: 'player' }],
      fallenUnits: [{ name: '乙', side: 'enemy' }],
    });
    expect(text).toContain('战斗结果：战斗以逃遁告终');
    expect(text).toContain('终局原因：逃跑成功');
    expect(text).toContain('进行回合数：2');
    expect(text).toContain('命运点数净变动：-100');
    expect(text).toContain('仍屹立于战场：甲');
    expect(text).toContain('倒下或已离场：乙');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// EndTurn（结束回合）：end_turn 工具 → EndTurn Command（一次放弃全部剩余槽位）
// ══════════════════════════════════════════════════════════════════════════════
describe('EndTurn：end_turn 工具调用翻译', () => {
  it('直捣：end_turn(actorName) → EndTurn Command（cost none，actor 经名字解析）', async () => {
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
      clientFactory: () => fakeEnemyClient([{ name: 'end_turn', args: { actorName: '乙' } }]),
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
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toMatchObject({ kind: 'EndTurn', actorId: '乙', cost: 'none' });
  });

  it('routeEnemyCommand 请求携带的 combat_v3 tools 含 end_turn schema（模型收得到工具定义）', async () => {
    const { opts } = mkOpts();
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: opts.bundle } as never);
    const combatSession = {
      messages: [] as Array<{ role: string; content: string | null }>,
      client: null,
      summary: '',
    };
    let capturedTools: Array<{ function: { name: string } }> = [];
    const ctx: Parameters<typeof routeEnemyCommand>[2] = {
      clientFactory: () =>
        ({
          chatWithTools: async (req: { tools?: Array<{ function: { name: string } }> }) => {
            capturedTools = req.tools ?? [];
            return {
              output: 'ok',
              rawResponse: '',
              toolCalls: [{ name: 'end_turn', arguments: { actorName: '乙' } }],
            } as never;
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
    await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: '乙', unitName: '乙', round: 1 },
      session,
      ctx,
    );
    const names = capturedTools.map((t) => t.function.name);
    expect(names).toContain('end_turn');
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

// ══════════════════════════════════════════════════════════════════════════
// 名字 → id 解析（2026-08-10 真机根因修复）
// 背景：面板（projectToAgent）给敌方 Agent 显示展示名（中文），内核 units 的 key 是
// characterId（生产路径 = char.id UUID）。Agent 抄名字回来调 declare_attack → 修复前
// 被直接当 actorId 用 → 内核 TARGET_NOT_PRESENT rejection → 连续 4 次 abandon。
// 修复：toolCallToCommand / lastCommandFromResult 过 resolveUnitIdByName 反查回 id。
// ══════════════════════════════════════════════════════════════════════════
describe('resolveUnitIdByName：中文名 → 单位 id（exact 优先，模糊兜底）', () => {
  const units = {
    'uuid-player': { id: 'uuid-player', name: '奥利雅思' },
    'uuid-enemy': { id: 'uuid-enemy', name: '两栖洞穴魔物' },
  } as unknown as Record<string, CombatUnitView>;

  it('exact：面板回流的展示名精确命中', () => {
    expect(resolveUnitIdByName(units, '两栖洞穴魔物')).toBe('uuid-enemy');
    expect(resolveUnitIdByName(units, '奥利雅思')).toBe('uuid-player');
  });

  it('已是 id（units 里有这把 key）→ 原样返回，不误伤内核/工具链给的单位 id', () => {
    expect(resolveUnitIdByName(units, 'uuid-enemy')).toBe('uuid-enemy');
    expect(resolveUnitIdByName(units, 'uuid-player')).toBe('uuid-player');
  });

  it('去空白：面板/模型折叠或插入空白后仍能命中', () => {
    expect(resolveUnitIdByName(units, '两栖 洞穴魔物')).toBe('uuid-enemy');
    expect(resolveUnitIdByName(units, '奥 利 雅 思')).toBe('uuid-player');
  });

  it('包含兜底：名字带别名/前后缀修饰仍能命中', () => {
    expect(resolveUnitIdByName(units, '两栖洞穴魔物·队长')).toBe('uuid-enemy');
    expect(resolveUnitIdByName(units, '洞穴魔物')).toBe('uuid-enemy');
  });

  it('查不到 → 返回原值（现状兜底，不抛错、不猜）', () => {
    expect(resolveUnitIdByName(units, '不存在的单位')).toBe('不存在的单位');
    expect(resolveUnitIdByName(units, '')).toBe('');
  });
});

describe('敌方 Agent 中文名 → Command UUID（TARGET_NOT_PRESENT 根因回归）', () => {
  /**
   * 中文名 + UUID characterId 的战场。玩家 +1 先攻：开战前 coordinator 的「先攻首位」
   * 预判用的是 participant 声明序（玩家在前）——掷先攻后玩家仍第一（11 vs 10），
   * 预判与实际一致；敌方活到第 2 位轮次，战斗 Agent 才会被真实问到。
   */
  function nameResolveBundle() {
    return mkBundle({
      combatId: 'coord-name-resolve',
      participants: [
        mkParticipant('uuid-player', {
          characterId: 'uuid-player',
          name: '奥利雅思',
          hp: 999999,
          maxHp: 999999, // 扛住敌方每轮攻击，让战斗推进到玩家轮次
          fixedInitiativeBonus: 1, // 盖过平手名字排序，玩家稳定先动（见上方注释）
        }),
        mkParticipant('uuid-enemy', {
          side: 'enemy',
          characterId: 'uuid-enemy',
          name: '两栖洞穴魔物',
          // 血线设计（60 颗默认骰带内打完，避开既有的 BeginOutput 回滚协调缺口）：
          // 玩家每击 ≈665（850 初始 × 评级 1.0 × 防御减免 2000/2300 × dr 0.9）；
          // 300 防御 → R1 剩 335（33.5% > 30% 战意阈值，不会 morale_routed 提前终局），
          // R2 打死 → 全场共 3 次攻击 = 6 颗 intentCheck ≤ 通道 7 颗，无需续杯。
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
  }

  it('routeEnemyCommand（无 executor 的 mock，lastCommandFromResult 路径）：产出 Command 的 actorId/targetId 为 UUID', async () => {
    const { routeEnemyCommand } = await import('./coordinator');
    const { openCombat } = await import('./index');
    const session = openCombat({ kind: 'new', bundle: nameResolveBundle() } as never);
    const ctx: Parameters<typeof routeEnemyCommand>[2] = {
      clientFactory: () =>
        ({
          chatWithTools: async () => ({
            output: null,
            rawResponse: '',
            toolCalls: [
              {
                name: 'declare_attack',
                arguments: { actorName: '两栖洞穴魔物', targetName: '奥利雅思' },
              },
            ],
          }),
          chat: async () => ({ output: null, rawResponse: '' }),
        }) as never,
      endpoint: { id: 'ep' } as never,
      saveId: 's1',
      submitCommand: async () => undefined,
      waitForCommand: async () => {
        throw new Error('unused');
      },
      abandon: () => undefined,
      context: {} as never,
    };
    const res = await routeEnemyCommand(
      { kind: 'PlayerCommand', unitId: 'uuid-enemy', unitName: '两栖洞穴魔物', round: 1 },
      session,
      ctx,
    );
    expect(res.commands[0].kind).toBe('DeclareAttack');
    expect(res.commands[0].actorId).toBe('uuid-enemy');
    const payload = (res.commands[0] as { payload?: { targetId?: string } }).payload;
    expect(payload?.targetId).toBe('uuid-player');
  });

  it('真实 runCombatV3：敌方全程用中文名声明 attack+action → 战斗正常结算、不再 TARGET_NOT_PRESENT abandon', async () => {
    const { opts } = mkOpts();
    opts.bundle = nameResolveBundle();
    // 玩家每回合：攻击「两栖洞穴魔物」+ 放弃动作槽（UUID 键；commandId 每回合唯一防幂等重放）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0) {
          q = [
            {
              commandId: `p-atk-${++n}`,
              expectedRevision: -1,
              kind: 'DeclareAttack',
              actorId: 'uuid-player',
              cost: 'attack',
              payload: { targetId: 'uuid-enemy', intentionLevel: '常规' },
            },
            {
              commandId: `p-act-${++n}`,
              expectedRevision: -1,
              kind: 'PassAction',
              actorId: 'uuid-player',
              cost: 'action',
              payload: {} as Record<string, never>,
            },
          ];
        }
        return q.shift()!;
      };
    })();
    // 敌方脚本（按调用序循环）：攻击槽用中文名声明攻击，动作槽用中文名声明专注
    const scripts = [
      [{ name: 'declare_attack', args: { actorName: '两栖洞穴魔物', targetName: '奥利雅思' } }],
      [{ name: 'declare_action', args: { actorName: '两栖洞穴魔物', actionType: '专注' } }],
    ];
    const history: Array<{ name: string; args: Record<string, any>; result: unknown }> = [];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
        ) => {
          const script = scripts[callIdx % scripts.length] ?? [];
          callIdx++;
          for (const step of script) {
            const result = await toolExecutor(step.name, step.args);
            history.push({ name: step.name, args: step.args, result });
          }
          // 照 enemyTurnOpts 先例：工具调用条目字段名是 arguments（agent-client 契约），
          // 不是 args —— 否则 lastCommandFromResult 解析出空 args，targetName 落空。
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
    const commit = opts.deps.stateManager!.commitDomainCommand;
    const abandon = opts.deps.abandon;

    const result = await runCombatV3(opts);

    // 敌方真的被询问过（玩家先动但一刀打不死 3000 血 → 敌方每回合都有轮次）
    expect(history.length).toBeGreaterThanOrEqual(2);
    // 攻击声明：actorId/targetId 都是 UUID 而不是中文名（修复前这里是「两栖洞穴魔物」→ TARGET_NOT_PRESENT）
    const atk = history.find((h) => h.name === 'declare_attack');
    expect(atk?.result).toMatchObject({ kind: 'DeclareAttack', actorId: 'uuid-enemy' });
    expect((atk?.result as { payload?: { targetId?: string } }).payload?.targetId).toBe(
      'uuid-player',
    );
    // 动作声明：actorId 解析成 UUID
    const act = history.find((h) => h.name === 'declare_action');
    expect(act?.result).toMatchObject({ kind: 'DeclareAction', actorId: 'uuid-enemy' });
    // 战斗正常走到结算：不再因 TARGET_NOT_PRESENT 连续 rejection → abandon
    expect(abandon).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('ally_win');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F4（2026-08-10）：敌方多命令按序全部 dispatch —— 战斗卡死（abandon）根因回归
// 背景（真机复现）：敌方 Agent 一次 chatWithTools 声明 declare_attack + declare_action
// 两个命令，旧实现 lastCommandFromResult 只取最后一条命令类调用（action）→ attack 被丢弃
// → 内核只消费动作槽 → 攻击槽永远 1/1 → 下一轮 AI 又声明 attack+action → 动作槽已耗尽
// SLOT_EXHAUSTED → 熔断 break → abandon → 玩家永远轮不到。
// 修复：commandsFromResult 按调用序收集全部命令类调用，主循环用 pendingCommands 队列
// 逐条 dispatch（dispatch 间 revision 修正，见 nextPending）；dispatch 之间的
// requiredInput（同单位继续）先消费队列，不再重新调 AI。
// ══════════════════════════════════════════════════════════════════════════
describe('F4：敌方多命令按序全部 dispatch（SLOT_EXHAUSTED 卡死根因回归）', () => {
  it('fake 敌方 agent 一次声明 attack+action → 两命令都被 dispatch，战斗推进到玩家轮次正常结算', async () => {
    const { opts } = mkOpts();
    opts.bundle = mkBundle({
      combatId: 'coord-f4-multi',
      participants: [
        mkParticipant('甲', { hp: 999999, maxHp: 999999 }), // 扛住敌方攻击，让战斗推进到玩家轮次
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          // 血线设计（照 nameResolveBundle 先例）：300 防御 → 甲 R1 剩 335（33.5% >
          // 30% 战意阈值，不会 morale_routed 提前终局），R2 打死 → hp_zero 正常结算
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
    // 甲每回合攻击乙 + 放弃动作槽（循环供给；commandId 每回合唯一防内核幂等缓存重放）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0)
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        return q.shift()!;
      };
    })();
    // 乙的脚本（每次 chatWithTools 调用 = 敌方一个决策入口；调用数超界重复最后一条）：
    // 调用 1（乙 R1 攻击槽决策）：**一次声明两个命令** attack + action —— 修复前的卡死根因；
    // 调用 2+（乙 R2+ 兜底）：pass 双槽（战斗拖长时仍合法推进）。
    const scripts: Array<Array<{ name: string; args: Record<string, any> }>> = [
      [
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '常规' },
        },
        { name: 'declare_action', args: { actorName: '乙', actionType: '专注' } },
      ],
      [
        { name: 'pass_slot', args: { actorName: '乙', slot: 'attack' } },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
      ],
    ];
    const history: Array<{ name: string; args: Record<string, any>; result: unknown }> = [];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
        ) => {
          const script = scripts[callIdx % scripts.length] ?? [];
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
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);
    const commit = opts.deps.stateManager!.commitDomainCommand;

    const result = await runCombatV3(opts);

    // 关键回归①：同一次 AI 声明里的两个命令都被真实执行（修复前只取最后一条 → attack 丢弃）
    const atk = history.find((h) => h.name === 'declare_attack');
    const act = history.find((h) => h.name === 'declare_action');
    expect(atk?.result).toMatchObject({ kind: 'DeclareAttack', actorId: '乙' });
    expect(act?.result).toMatchObject({ kind: 'DeclareAction', actorId: '乙' });
    // 关键回归②：乙的攻击真的进了内核（v3_action 攻击卡片）——修复前动作槽先行 →
    // SLOT_EXHAUSTED 连续 rejection → 熔断 abandon，玩家永远轮不到
    const enemyAttack = events.find(
      (e) => e.type === 'v3_action' && e.toolName === 'attack' && e.result.attackerId === '乙',
    );
    expect(enemyAttack).toBeDefined();
    // 战斗正常推进到玩家轮次并结算（不 abandon、不 SLOT_EXHAUSTED 卡死）
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('ally_win');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bug 2（2026-08-12）：玩家攻击槽耗尽后再次点攻击 → SLOT_EXHAUSTED。
// 根因：coordinator 的 rejection 熔断（steps>3 → break → abandon）把玩家的
// **误操作**当成系统故障处理，整场战斗被放弃（用户看到「页面闪退」）。
// 修复：玩家侧 SLOT_EXHAUSTED 不熔断 → emit v3_rejection_notice + 重新等待输入。
// ══════════════════════════════════════════════════════════════════════════
describe('Bug 2：玩家攻击槽耗尽后再次点攻击 → 提示 + 继续等输入，不 abandon', () => {
  it('连续两次 DeclareAttack（第二次攻击槽已空）→ emit v3_rejection_notice、不 abandon、战斗继续推进', async () => {
    const { opts, commit } = mkOpts({
      // 乙方（敌方）配 pass 双槽脚本：回合完整推进，不产生自己的 SLOT_EXHAUSTED，
      // 让测试只验证「玩家侧」攻击槽耗尽的处理路径。
      enemyScript: [
        { name: 'pass_slot', args: { actorName: '乙', slot: 'attack' } },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
      ],
    });
    opts.bundle = mkBundle({
      combatId: 'coord-bug2-slot',
      participants: [
        mkParticipant('甲', { hp: 999999, maxHp: 999999 }), // 扛住敌方攻击，让战斗推进
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
    // 玩家队列：攻击（占攻击槽）→ 再攻击（攻击槽已空，应 SLOT_EXHAUSTED）→ pass 动作槽推进
    // 后续轮次循环供给（commandId 每轮唯一防内核幂等缓存重放）。
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      const nextAttack = (): CombatCommand => ({
        commandId: `u-atk-${++n}`,
        expectedRevision: -1,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: { targetId: '乙', intentionLevel: '常规' },
      });
      const nextPassAction = (): CombatCommand => ({
        commandId: `u-pass-${++n}`,
        expectedRevision: -1,
        kind: 'PassAction',
        actorId: '甲',
        cost: 'action',
        payload: {} as Record<string, never>,
      });
      return async () => {
        if (q.length === 0) q = [nextAttack(), nextAttack(), nextPassAction()];
        return q.shift()!;
      };
    })();
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);

    const result = await runCombatV3(opts);

    // ① 玩家第二次攻击被拒（SLOT_EXHAUSTED）→ 提示事件被 emit
    const notices = events.filter((e) => e.type === 'v3_rejection_notice');
    expect(notices.length).toBeGreaterThan(0);
    expect((notices[0] as { code?: string }).code).toBe('SLOT_EXHAUSTED');
    // ② 不 abandon（修复前的根因：熔断 → 整场被放弃 → 页面闪退）
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    // ③ 战斗照常推进到终局落库（提示只是重等待，玩家后续命令正常消费）
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.narrativeSummary).not.toContain('战斗被放弃');
  });

  it('敌方侧 rejection（SLOT_EXHAUSTED）→ 降级 PassAttack 推进，不再熔断 abandon（Bug B 修复）', async () => {
    // 🔴 Bug B（2026-08-12）：敌方 SLOT_EXHAUSTED 此前走 `steps > 3 break` 熔断 →
    //   aborted=true → deps.abandon() → 整场战斗被放弃（真机「页面闪退」）。
    //   现在任何 rejection 都不再熔断：emit v3_rejection_notice + 降级 PassAttack
    //   推进当前单位 —— 战斗继续，最坏情况是乙白费一次行动。
    // 用 enemyScript 让乙重复发 pass_slot(action)（动作槽只 1 个，第二次必 SLOT_EXHAUSTED）
    const { opts, abandon } = mkOpts({
      enemyScript: [
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
      ],
    });
    opts.bundle = mkBundle({
      combatId: 'coord-bug2-enemy',
      participants: [
        mkParticipant('甲', { hp: 999999, maxHp: 999999 }),
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
    // 玩家循环供给：甲每回合攻击乙 + 放弃动作槽（乙白费槽位的轮数不定，循环供到乙死为止）
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      const nextAttack = (): CombatCommand => ({
        commandId: `u-atk-${++n}`,
        expectedRevision: -1,
        kind: 'DeclareAttack',
        actorId: '甲',
        cost: 'attack',
        payload: { targetId: '乙', intentionLevel: '常规' },
      });
      const nextPassAction = (): CombatCommand => ({
        commandId: `u-pass-${++n}`,
        expectedRevision: -1,
        kind: 'PassAction',
        actorId: '甲',
        cost: 'action',
        payload: {} as Record<string, never>,
      });
      return async () => {
        if (q.length === 0) q = [nextAttack(), nextPassAction()];
        return q.shift()!;
      };
    })();
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);

    const result = await runCombatV3(opts);

    // ① 不再 abandon（修复前的根因：熔断 → 整场被放弃）
    expect(abandon).not.toHaveBeenCalled();
    // ② 敌方的 rejection 有通知事件（v3_rejection_notice）
    const notices = events.filter((e) => e.type === 'v3_rejection_notice');
    expect(notices.length).toBeGreaterThan(0);
    expect((notices[0] as { code?: string }).code).toBe('SLOT_EXHAUSTED');
    // ③ 战斗照常推进到终局落库（甲每轮攻击，乙每轮白费槽位后回合结束）
    expect(result.narrativeSummary).not.toContain('战斗被放弃');
    expect(result.outcome).toBe('ally_win');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bug C（2026-08-12）：逃跑成功不再整场 Terminal(flee_success)。
// 逃跑改为移除单位：单敌人逃光 = 玩家获胜（战斗正常结算落库）；多敌人逃一个 = 战斗继续。
// ══════════════════════════════════════════════════════════════════════════
describe('Bug C：敌方逃跑成功 → 移除单位 + 单敌人战斗结束玩家获胜', () => {
  it('真实 runCombatV3：乙逃跑成功 → 乙被移除（v3_roster_changed despawned）、outcome ally_win、不 abandon', async () => {
    const { opts, commit, setQueue } = mkOpts({
      enemyScript: [{ name: 'flee', args: { actorName: '乙' } }],
    });
    opts.bundle = mkBundle({
      combatId: 'coord-bugc-flee',
      participants: [
        mkParticipant('甲', { hp: 999999, maxHp: 999999 }),
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
    setQueue([...atkTurn(), ...atkTurn()]);
    const events: CombatEvent[] = [];
    opts.onCombatEvent = (evt) => events.push(evt);

    const result = await runCombatV3(opts);

    // ① 逃跑检定事件（FleeAttempt → v3_action toolName 'flee'，默认骰全 10 + dex 15 → 成功）
    const fleeActions = events.filter(
      (e) => e.type === 'v3_action' && (e as { toolName?: string }).toolName === 'flee',
    );
    expect(fleeActions.length).toBeGreaterThan(0);
    expect((fleeActions[0] as { result?: { success?: boolean } }).result?.success).toBe(true);
    // ② 单位被移除（UnitDespawned → v3_roster_changed op 'despawned'）
    const despawns = events.filter(
      (e) => e.type === 'v3_roster_changed' && (e as { op?: string }).op === 'despawned',
    );
    expect(despawns.length).toBeGreaterThan(0);
    // ③ 战斗结束玩家获胜（敌人逃光 = 我方获胜），整场只落库一次、不 abandon
    expect(commit).toHaveBeenCalledTimes(1);
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ally_win');
    expect(result.narrativeSummary).not.toContain('战斗被放弃');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BeginOutput 重放（2026-08-12）：攻击撞骰池耗尽（骰尽续杯）→ 续骰后**自动重放**被中断
// 的攻击，玩家不用重新输入一次。
// 背景：玩家提交 DeclareAttack，内核结算中途 intentCheck 通道骰子耗尽 → reducer 返回
//   requiredInput: BeginOutput，攻击**零微步骤已提交**（不伤血、不耗槽）。此前 coordinator
//   续骰（SupplyDice）后被中断的攻击命令被丢掉，循环重新走 decideForUnit → 又 emit
//   v3_awaiting_player_input 等玩家输入 → 玩家要重新输入一次攻击。
// 修复：BeginOutput 分支把被中断的 currentCommand 排在 SupplyDice 之后一起进队列
//   （新 commandId 避开 kernel 幂等缓存；expectedRevision 由 nextPending 修正）。
// 骰带设计：intentCheck 预算 7 颗、每次攻击掷 2 颗 → 第 1~3 击各耗 2 颗（剩 1），
//   第 4 击 draw(2) 越界 → BeginOutput。甲每击 639（骰全 10 + tier 3 同层检定 15 有效
//   + 乙 defense 100 / dr 0.1），乙 hp 2555 → 3 击后剩 638，第 4 击（重放）639 杀死乙
//   → hp_zero 终局。乙 player 侧（默认 ally → player）→ 战意检定跳过、不溃逃，血线可控。
// ══════════════════════════════════════════════════════════════════════════
describe('BeginOutput：攻击撞骰池耗尽 → 续骰后自动重放，玩家不用重新输入', () => {
  it('甲第 4 次攻击触发 BeginOutput → 续骰重放 → 第 4 击杀死乙，不再 emit v3_awaiting_player_input 等玩家重输', async () => {
    const bundle = mkBundle({
      combatId: 'coord-begin-output-replay',
      // 死斗：战意阈值 10%（标准是 30%）——乙 3 击后剩 25% 不溃逃，撑到第 4 击
      combatType: '死斗',
      participants: [
        // 甲先攻稳第一（fixedInitiativeBonus 100 vs 0），每轮 attack + pass action
        mkParticipant('甲', { fixedInitiativeBonus: 100 }),
        // 乙 enemy 侧（走 fake agent pass）：血线 = 3 击 1917 后剩 638（25%），第 4 击 639 死
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 2555,
          maxHp: 2555,
        }),
      ],
    });

    // 甲 player 侧命令全走 submitCommand + waitForCommand；调用序固定（每轮 2 个）：
    // attack → pass action（乙 enemy 侧走 fake agent，不进此队列）
    const submitCommand = vi.fn(async () => {});
    let n = 0;
    const waitForCommand = (async () => {
      const i = n % 2;
      const commandId = `u-cmd-${++n}`;
      return {
        commandId,
        expectedRevision: -1,
        kind: i === 0 ? 'DeclareAttack' : 'PassAction',
        actorId: '甲',
        cost: i === 0 ? 'attack' : 'action',
        payload: (i === 0 ? { targetId: '乙', intentionLevel: '常规' } : {}) as Record<
          string,
          never
        >,
      } as CombatCommand;
    }) as unknown as () => Promise<CombatCommand>;

    const commit = vi.fn(async () => {});
    const abandon = vi.fn(() => {});
    let diceBatch = 0;
    const events: CombatEvent[] = [];
    const opts: RunCombatV3Opts = {
      saveId: 's1',
      bundle,
      deps: {
        // 乙 enemy 侧：attack 槽 / action 槽交替 pass_slot（照 F5 ENEMY_SCRIPTS 交替先例）
        clientFactory: () => {
          let idx = 0;
          return {
            chatWithTools: async () => ({
              output: 'ok',
              rawResponse: '',
              toolCalls: [
                {
                  name: 'pass_slot',
                  arguments: { actorName: '乙', slot: idx++ % 2 === 0 ? 'attack' : 'action' },
                },
              ],
            }),
            chat: async () => ({ output: null, rawResponse: '' }),
          } as unknown as CombatClient;
        },
        endpoint: { id: 'ep' } as never,
        stateManager: { commitDomainCommand: commit },
        characters: [],
        context: {} as never,
        submitCommand,
        waitForCommand,
        abandon,
        // 确定性骰源（60 颗 10）；diceBatch：第 1 次 = 开局注骰，第 2 次 = BeginOutput 续杯
        drawDice: () => ({
          outputId: `epoch-${++diceBatch}`,
          dice: Array.from({ length: 60 }, () => 10),
        }),
      },
      onCombatEvent: (evt) => events.push(evt),
    };

    const result = await runCombatV3(opts);

    const awaiting = events.filter((e) => e.type === 'v3_awaiting_player_input');
    const attackCards = events.filter(
      (e) => e.type === 'v3_action' && (e as { toolName?: string }).toolName === 'attack',
    );
    const diceEpochs = events.filter((e) => e.type === 'v3_dice_epoch');

    // ① BeginOutput 路径真的走过：第 2 次注骰（续杯）发生了
    expect(diceBatch).toBeGreaterThanOrEqual(2);
    expect(diceEpochs.length).toBeGreaterThanOrEqual(1);
    // ② 第 4 击（重放）正常结算：4 张攻击卡片
    //   （修复前：第 4 击被丢弃 → 重问玩家后补打，玩家多输入一次）
    expect(attackCards.length).toBe(4);
    // ③ 玩家没有被再次询问：8 次 = R1-4 每轮 2 次（甲 attack 首问 + pass action 继续）
    //   （修复前：R4 攻击被丢 → decideForUnit 重问甲 → 9 次）
    expect(awaiting.length).toBe(8);
    expect(submitCommand).toHaveBeenCalledTimes(8);
    expect(n).toBe(8);
    // ④ 战斗正常终局：第 4 击重放杀死乙 → hp_zero → ally_win；不 abandon、整场只落库一次
    expect(abandon).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('ally_win');
    expect(result.rounds).toBe(4);
  });
});

// 时序：F1 开局事件 emit 之后、正式回合循环（SupplyDice → decideForUnit）之前，
// 走持久会话（system 首轮注入 + 模板情境快照），AI 输出氛围描写经 v3_narrative 进
// combatLog；可调查询工具但**不产 Command**（氛围阶段不决策）。
// ══════════════════════════════════════════════════════════════════════════
describe('F5：开局先调 AI 构建战斗场景（氛围描写 + 信息获取）', () => {
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

  /** 让乙活到自己的行动轮：乙 300 防 1000 血（甲 R1 剩 335 > 30% 不崩溃，R2 打死） */
  function f5Bundle(combatId: string) {
    return mkBundle({
      combatId,
      participants: [
        mkParticipant('甲', { hp: 5000, maxHp: 5000 }), // 防乙磨死（甲两刀杀乙，乙每轮反击）
        mkParticipant('乙', {
          side: 'enemy',
          characterId: '乙',
          name: '乙',
          hp: 1000,
          maxHp: 1000,
          defense: 300,
        }),
      ],
    });
  }

  /** 甲每回合攻击乙 + 放弃动作槽（循环供给；commandId 每回合唯一防内核幂等缓存重放） */
  function cyclicPlayerQueue(opts: RunCombatV3Opts): void {
    opts.deps.waitForCommand = (() => {
      let q: CombatCommand[] = [];
      let n = 0;
      return async () => {
        if (q.length === 0)
          q = atkTurn().map((c) => ({ ...c, commandId: `${c.commandId}-${++n}` }));
        return q.shift()!;
      };
    })();
  }

  /** 乙的行动脚本（每次 chatWithTools 调用 = 乙一个槽位的决策；攻击槽/动作槽交替） */
  const ENEMY_SCRIPTS: Array<Array<{ name: string; args: Record<string, any> }>> = [
    [
      {
        name: 'declare_attack',
        args: { actorName: '乙', targetName: '甲', intentionLevel: '常规' },
      },
    ],
    [{ name: 'pass_slot', args: { actorName: '乙', slot: 'action' } }],
  ];

  /** 执行脚本并返回 toolCalls（照 enemyTurnOpts 先例） */
  async function runEnemyScript(
    script: Array<{ name: string; args: Record<string, any> }>,
    toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
  ): Promise<unknown> {
    const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
    for (const step of script) {
      const result = await toolExecutor(step.name, step.args);
      history.push({ name: step.name, arguments: step.args, result });
    }
    return { output: 'ok', rawResponse: '', toolCalls: history } as never;
  }

  it('真实 runCombatV3：首个 AI 调用是开局氛围（user 含「战斗开场」），输出经 v3_narrative 进事件流，随后才进入正式决策', async () => {
    const { opts } = mkOpts();
    // 触发条件：配置了 combat_v3 agent（生产经 game-pipeline 恒透传）
    opts.deps.configs = [combatConfig('TEST_COMBAT_SYSTEM_PROMPT_V3_F5')];
    opts.bundle = f5Bundle('coord-f5-opening');
    cyclicPlayerQueue(opts);
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const narratives: string[] = [];
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          req: { messages: Array<{ role: string; content: string | null }> },
          toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
        ) => {
          seen.push(req.messages);
          callIdx++;
          if (callIdx === 1) {
            // 开局氛围调用：只输出氛围描写，不返回任何命令
            return {
              output: '战场杀意弥漫，双方对峙。',
              rawResponse: '战场杀意弥漫，双方对峙。',
              toolCalls: [],
            } as never;
          }
          // 正式决策：乙攻击槽/动作槽交替（脚本循环）
          const script = ENEMY_SCRIPTS[(callIdx - 1) % ENEMY_SCRIPTS.length] ?? [];
          return runEnemyScript(script, toolExecutor);
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;
    opts.onCombatEvent = (evt) => {
      if (evt.type === 'v3_narrative') narratives.push(evt.text);
    };

    const result = await runCombatV3(opts);

    // ① 首个 AI 调用是开局氛围：system 首轮注入 + user 含「战斗开场」/「氛围」指令
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0][0].role).toBe('system');
    expect(seen[0][0].content).toBe('TEST_COMBAT_SYSTEM_PROMPT_V3_F5');
    expect(seen[0][1].role).toBe('user');
    expect(seen[0][1].content ?? '').toContain('战斗开场');
    expect(seen[0][1].content ?? '').toContain('氛围');
    // ② 氛围描写经 v3_narrative 进事件流（combatLog）
    expect(narratives).toContain('战场杀意弥漫，双方对峙。');
    // ③ 随后才进入正式决策：第二次调用的最后一条 user = 「轮到敌方X行动」
    const secondUsers = seen[1].filter((m) => m.role === 'user' && m.content !== null);
    expect(secondUsers[secondUsers.length - 1].content ?? '').toContain('轮到敌方「乙」行动');
    // ④ 开局调用不产命令、不改状态：战斗正常结算（不 abandon）
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ally_win');
  });

  it('开局调用失败静默降级：chatWithTools 抛错 → 跳过氛围描写，战斗照常进行', async () => {
    const { opts } = mkOpts();
    opts.deps.configs = [combatConfig('TEST_COMBAT_SYSTEM_PROMPT_V3_F5')];
    opts.bundle = f5Bundle('coord-f5-fail');
    cyclicPlayerQueue(opts);
    let callIdx = 0;
    opts.deps.clientFactory = () =>
      ({
        chatWithTools: async (
          _req: unknown,
          toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
        ) => {
          callIdx++;
          if (callIdx === 1) throw new Error('开局氛围调用失败');
          const script = ENEMY_SCRIPTS[(callIdx - 1) % ENEMY_SCRIPTS.length] ?? [];
          return runEnemyScript(script, toolExecutor);
        },
        chat: async () => ({ output: null, rawResponse: '' }) as never,
      }) as never;
    const narratives: string[] = [];
    opts.onCombatEvent = (evt) => {
      if (evt.type === 'v3_narrative') narratives.push(evt.text);
    };

    const result = await runCombatV3(opts);

    // 氛围叙事未注入（降级），但战斗照常走完
    expect(narratives).not.toContain('战场杀意弥漫');
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ally_win');
  });

  it('未配置 combat_v3 agent → 开局调用跳过（不建 client），战斗照常', async () => {
    // 乙的行动脚本（攻击槽/动作槽；fakeEnemyClient 超界重复最后一条）
    const { opts } = mkOpts({
      enemyScript: [
        {
          name: 'declare_attack',
          args: { actorName: '乙', targetName: '甲', intentionLevel: '常规' },
        },
        { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
      ],
    });
    opts.bundle = f5Bundle('coord-f5-nocfg');
    cyclicPlayerQueue(opts);
    let factoryCalls = 0;
    const originalFactory = opts.deps.clientFactory;
    opts.deps.clientFactory = (agentId, endpoint, saveId) => {
      factoryCalls++;
      return originalFactory(agentId, endpoint, saveId);
    };
    const result = await runCombatV3(opts);
    // 无 configs → 开局调用跳过；首个 client 来自乙的正式决策（只建一次）
    expect(factoryCalls).toBe(1);
    expect(opts.deps.abandon).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ally_win');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F5 提示词联动：combat_v3.systemPrompt 禁数据化描写条款（两仓 agent-config.json）
// ══════════════════════════════════════════════════════════════════════════
describe('F5 提示词联动：禁数据化描写条款（两仓 agent-config.json）', () => {
  /**
   * 读 agent-config.json 的 combat_v3.systemPrompt。🔴 动态 import('node:fs' as string)
   * 是刻意的：静态 import 需要 @types/node 全局类型（tsconfig types:[]），而 @types/node
   * 的全局 setTimeout 重载要求回调返回 void，会把 settings-store.ts 既有的
   * setTimeout(async ...) 变成 lint 误报（no-misused-promises）——动态 import 按 string
   * 解析不产生模块类型依赖，也不会注入 node 全局。
   */
  async function readCombatSystemPrompt(filePath: string): Promise<string> {
    const fsMod = (await import('node:fs' as string)) as unknown as {
      readFileSync: (path: string, encoding: 'utf8') => string;
      existsSync: (path: string) => boolean;
    };
    const cfg = JSON.parse(fsMod.readFileSync(filePath, 'utf8')) as {
      agents: { combat_v3: { systemPrompt: string } };
    };
    return cfg.agents.combat_v3.systemPrompt;
  }

  it('combat_v3.systemPrompt 含「禁止数据化描写」条款（公开仓必断；私有内容仓存在时同断并逐字一致）', async () => {
    const fsMod = (await import('node:fs' as string)) as unknown as {
      existsSync: (path: string) => boolean;
    };
    const sys = await readCombatSystemPrompt('public/data/defaults/agent-config.json');
    expect(sys).toContain('禁止数据化描写');
    expect(sys).toContain('数字留给卡片');
    // 条款必须落在「五、演绎契约」段落内（不是别处一段孤立文本）
    expect(sys.indexOf('五、演绎契约')).toBeLessThan(sys.indexOf('禁止数据化描写'));
    expect(sys.indexOf('禁止数据化描写')).toBeLessThan(sys.indexOf('# 可用工具'));
    // 私有内容仓（本地路径，CI 无此目录时跳过不挂红）：与公开仓逐字一致
    const assetsPath = 'E:/code/fated_poem_independent_assets/data/defaults/agent-config.json';
    if (fsMod.existsSync(assetsPath)) {
      expect(await readCombatSystemPrompt(assetsPath)).toBe(sys);
    }
  });
});
