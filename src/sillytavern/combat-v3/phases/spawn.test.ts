/**
 * combat-v3/phases/spawn.test.ts — 召唤出口 SpawnOrDespawnIntent / CharGenRequest / SupplyUnit（M3.5）
 *
 * 验收（plan §6.8 / §6.1）：
 *   A35-1  templateRef 缺省（创造性召唤）→ reducer 冻结 spawn frame + RequiredInput.CharGenRequest
 *   A35-2  joinTiming='this_round_tail' → 插先攻尾部（当回合参战）；
 *          'next_round_head' → 下轮参与（不掷当前 init 骰）
 *   A35-3  duration.rounds 到期在 round.close 移除 → UnitDespawned + 从 ActiveEffectIndex 摘 automaton
 *   actionEconomy 三态槽位（full=1攻1动 / partial=仅动作 / no_action=0）
 *   召唤 FP 扣费与 UnitSummoned 同一次原子提交（不变量④）
 */

import { describe, it, expect } from 'vitest';
import { reduce } from '../reducer';
import { applyOutcome } from '../state';
import { createCombatState } from '../state';
import { buildIndex } from '../automata/index-active';
import { handleRoundClose } from './round';
import type { CombatState, CompiledAutomaton, DomainEvent, SummonedUnitDefinition } from '../types';
import { mkBundle } from '../test-utils';

/** 造一条在 action.declared 产出 SpawnOrDespawnIntent(spawn) 的 automaton（无 templateRef） */
function spawnAutomaton(owner: string): CompiledAutomaton {
  return {
    id: `skill.${owner}.necronomicon`,
    name: '死灵之书',
    source: '死灵之书-残篇',
    owner,
    subscribe: 'action.declared',
    priority: 0,
    divinity: 0,
    stableId: `skill.${owner}.necronomicon`,
    triggerAst: { t: 'bool', v: true },
    isAdapter: true,
    intents: [
      {
        kind: 'SpawnOrDespawnIntent',
        op: 'spawn',
        unitId: '腐化食尸鬼',
        count: 2,
        duration: { rounds: 2 },
        joinTiming: 'this_round_tail',
      },
      {
        kind: 'SpendResource',
        targetId: owner,
        resource: 'fp',
        amount: 100,
      },
    ],
  };
}

function withAutomaton(state: CombatState, auto: CompiledAutomaton): CombatState {
  return { ...state, activeEffects: buildIndex([auto]) };
}

/** 构造食尸鬼 SummonedUnitDefinition（name 可覆盖以区分实例） */
function ghoul(name = '腐化食尸鬼'): SummonedUnitDefinition {
  return {
    name,
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
    divinity: 0,
    side: 'player',
    joinTiming: 'this_round_tail',
    duration: { rounds: 2 },
    actionEconomy: 'full',
    sourceItem: '死灵之书-残篇',
  };
}

function findEvent<T extends DomainEvent['kind']>(events: readonly DomainEvent[], kind: T) {
  return events.find((e) => e.kind === kind) as Extract<DomainEvent, { kind: T }> | undefined;
}

/** 触发一次 DeclareAction（action.declared 产 spawn → CharGenRequest 冻结） */
function castSummon(
  state: CombatState,
  bundle: ReturnType<typeof mkBundle>,
): ReturnType<typeof reduce> {
  return reduce(bundle, state, {
    commandId: 'c1',
    expectedRevision: 0,
    kind: 'DeclareAction',
    actorId: '甲',
    cost: 'action',
    payload: { actionType: 'item', description: '死灵之书-残篇' },
  });
}

describe('A35-1：无 templateRef → CharGenRequest 冻结', () => {
  it('action.declared 产 spawn → reducer 返回 CharGenRequest + 冻结 spawn frame', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = withAutomaton(s, spawnAutomaton('甲'));

    const t = castSummon(s, bundle);

    expect(t.requiredInput?.kind).toBe('CharGenRequest');
    if (t.requiredInput?.kind === 'CharGenRequest') {
      expect(t.requiredInput.requestId).toBeTruthy();
      expect(t.requiredInput.constraints.durationRounds).toBe(2);
      expect(t.requiredInput.prompt.sourceItem).toBe('死灵之书-残篇');
    }
    expect(t.next?.resolution?.step).toBe('spawn');
  });
});

describe('A35-2：joinTiming + 原子扣费', () => {
  it('this_round_tail → SupplyUnit 插先攻尾部 + UnitSummoned + ResourceSpent(FP,100) 同批', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = withAutomaton(s, spawnAutomaton('甲'));

    const freeze = castSummon(s, bundle);
    const requestId =
      freeze.requiredInput?.kind === 'CharGenRequest' ? freeze.requiredInput.requestId : '';

    const t = reduce(bundle, freeze.next!, {
      commandId: 'c2',
      expectedRevision: freeze.next!.revision,
      kind: 'SupplyUnit',
      actorId: '甲',
      cost: 'none',
      payload: { requestId, definition: ghoul() },
    });

    expect(t.next?.units['腐化食尸鬼']).toBeTruthy();
    // initiativeOrder 尾插 + 消耗 1 initiative 骰（可经 provenance 校验 cursor 前移）
    expect(t.next?.initiativeOrder[t.next!.initiativeOrder.length - 1]).toBe('腐化食尸鬼');
    // FP 扣 100（原子提交，不变量④）
    expect(t.next?.resourceSnapshots.FP).toBe(1000 - 100);
    expect(findEvent(t.events, 'UnitSummoned')).toBeTruthy();
    expect(findEvent(t.events, 'ResourceSpent')).toBeTruthy();
    // 召唤时限 buff 已施加
    expect(t.next?.units['腐化食尸鬼'].statusEffects.some((x) => x.name === '召唤时限')).toBe(true);
    // frame 已清除
    expect(t.next?.resolution).toBeUndefined();
  });

  it('next_round_head → 追加 id 到下轮序列、本轮不给槽位', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = withAutomaton(s, spawnAutomaton('甲'));

    const freeze = castSummon(s, bundle);
    const requestId =
      freeze.requiredInput?.kind === 'CharGenRequest' ? freeze.requiredInput.requestId : '';
    const t = reduce(bundle, freeze.next!, {
      commandId: 'c2',
      expectedRevision: freeze.next!.revision,
      kind: 'SupplyUnit',
      actorId: '甲',
      cost: 'none',
      payload: {
        requestId,
        definition: { ...ghoul(), joinTiming: 'next_round_head', actionEconomy: 'no_action' },
      },
    });

    expect(t.next?.units['腐化食尸鬼']).toBeTruthy();
    expect(t.next?.units['腐化食尸鬼'].attacksRemaining).toBe(0);
    expect(t.next?.units['腐化食尸鬼'].actionsRemaining).toBe(0);
    expect(t.next?.initiativeOrder).toContain('腐化食尸鬼');
  });
});

describe('actionEconomy 三态槽位', () => {
  it('full→1攻1动 / partial→0攻1动 / no_action→0/0', () => {
    const bundle = mkBundle();

    const cases = [
      { eco: 'full' as const, name: 'G-full', atk: 1, act: 1 },
      { eco: 'partial' as const, name: 'G-pa', atk: 0, act: 1 },
      { eco: 'no_action' as const, name: 'G-no', atk: 0, act: 0 },
    ];
    for (const c of cases) {
      const fresh = withAutomaton(createCombatState(bundle), spawnAutomaton('甲'));
      const freeze = castSummon(fresh, bundle);
      const requestId =
        freeze.requiredInput?.kind === 'CharGenRequest' ? freeze.requiredInput.requestId : '';
      const t = reduce(bundle, freeze.next!, {
        commandId: `sup-${c.name}`,
        expectedRevision: freeze.next!.revision,
        kind: 'SupplyUnit',
        actorId: '甲',
        cost: 'none',
        payload: { requestId, definition: { ...ghoul(c.name), actionEconomy: c.eco } },
      });
      const unit = t.next!.units[c.name];
      expect(unit).toBeTruthy();
      expect(unit.attacksRemaining).toBe(c.atk);
      expect(unit.actionsRemaining).toBe(c.act);
    }
  });
});

describe('A35-3：duration 到期 round.close 移除 + 摘 automaton', () => {
  it('召唤时限递减到 0 → removeUnitIds + UnitDespawned + byOwner 摘除', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = withAutomaton(s, spawnAutomaton('甲'));

    // ① 触发 + SupplyUnit（召唤物 2 回合，automaton 无额外）
    const freeze = castSummon(s, bundle);
    const requestId =
      freeze.requiredInput?.kind === 'CharGenRequest' ? freeze.requiredInput.requestId : '';
    const summoned = reduce(bundle, freeze.next!, {
      commandId: 'c2',
      expectedRevision: freeze.next!.revision,
      kind: 'SupplyUnit',
      actorId: '甲',
      cost: 'none',
      payload: { requestId, definition: ghoul() },
    });
    const ghoulId = '腐化食尸鬼';
    expect(summoned.next?.units[ghoulId]).toBeTruthy();

    // ② 第一次 round.close：remainingTime 2→1，未到期
    const rc1 = handleRoundClose(bundle, summoned.next!);
    expect(rc1.removeUnitIds ?? []).not.toContain(ghoulId);
    const after1 = applyOutcome(summoned.next!, rc1);
    expect(after1.units[ghoulId]).toBeTruthy();

    // ③ 第二次 round.close：到期 → 移除
    const rc2 = handleRoundClose(bundle, after1);
    expect(rc2.removeUnitIds).toContain(ghoulId);
    const despawnEvt = rc2.events.find((e) => e.kind === 'UnitDespawned');
    expect(despawnEvt).toBeTruthy();
    const after2 = applyOutcome(after1, rc2);
    expect(after2.units[ghoulId]).toBeUndefined();
    expect(after2.activeEffects.byOwner[ghoulId]).toBeUndefined();
  });
});
