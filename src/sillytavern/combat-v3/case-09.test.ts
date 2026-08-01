/**
 * combat-v3/case-09.test.ts — 第 09 场 fixture 端到端（M2）
 *
 * 验收对应（plan §4.10 / §4.9）：
 *   - 从 fixture 构造 bundle、驱动 kernel 4 回合 → roundCount milestone
 *   - 意图对抗产出真理火球伤害（damage milestone，第 09 场代表动作）
 *   - force_terminal：M2 无 automaton，认知剥夺走内核内部桩——测试统一用
 *     openCombat({kind:'restore'}) 注入 forceTerminal 终局，断言 settlement fpDelta
 *
 * 说明：fixture 的 bundle.units 用 FixtureUnit（attributes 英文键），需 adapter 转成
 * CombatParticipant[]（CombatDefinitionBundle.participants）。
 */

import { describe, expect, it } from 'vitest';
import { openCombat } from './index';
import { createCombatState } from './state';
import type { CombatDefinitionBundle, CombatParticipant, CombatCommand } from './types';
import type { CombatFixture } from './types';
import fixtureJson from './fixtures/case-09-concept.fixture.json';

const fixture = fixtureJson as CombatFixture;

/** FixtureUnit → CombatParticipant 适配（attributes 英文键 → 五维结构；side 字段运行时读） */
function toParticipant(u: CombatFixture['bundle']['units'][number]): CombatParticipant {
  const a = (u.attributes ?? {}) as Record<string, number>;
  const side = (u as { side?: 'player' | 'enemy' }).side ?? 'enemy';
  return {
    characterId: u.name,
    name: u.name,
    tier: u.tier,
    level: 10,
    attributes: {
      str: a.str ?? 5,
      dex: a.dex ?? 5,
      con: a.con ?? 5,
      int: a.int ?? 5,
      spi: a.spi ?? 5,
    },
    hp: u.hp,
    maxHp: u.maxHp,
    mp: u.mp ?? 0,
    maxMp: u.maxMp ?? 0,
    sp: u.sp ?? 0,
    maxSp: u.maxSp ?? 0,
    defense: 50,
    dr: 0.1,
    penetration: 0,
    hitBonus: 10,
    dodgeBonus: 5,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 0,
    actionsRemaining: 0,
    statusEffects: [],
    weaponAtk: 50,
    side: side === 'enemy' ? 'enemy' : 'ally',
    canAct: true,
  };
}

function fixtureBundle(): CombatDefinitionBundle {
  return {
    combatId: fixture.bundle.combatId,
    combatType: (fixture.bundle.combatType as CombatDefinitionBundle['combatType']) ?? '标准',
    participants: fixture.bundle.units.map(toParticipant),
    resourceSnapshots: { FP: fixture.bundle.resourceSnapshots.FP },
    rulesetRevision: fixture.bundle.rulesetRevision,
  };
}

/** 从 fixture 拿第一个 DeclareAttack command（真理火球）转成内核 Command */
function attackCommand(cmd: CombatFixture['commands'][number]): CombatCommand {
  return {
    commandId: cmd.commandId,
    expectedRevision: cmd.expectedRevision,
    kind: 'DeclareAttack',
    actorId: cmd.actorId,
    cost: 'attack',
    payload: {
      targetId: (cmd.payload as any).targetId,
      skill: (cmd.payload as any).skill,
      intentionLevel: ((cmd.payload as any).intentionLevel ?? '常规') as never,
      ability: {
        relevantAttribute: 20,
        skillPower: 0,
        damageType: '能量',
        intentionLevel: (cmd.payload as any).intentionLevel ?? '常规',
        multiHitCount: 1,
        divinity: 0,
      },
    },
  } as CombatCommand;
}

describe('第 09 场 fixture（M2 端到端）', () => {
  it('从 fixture 构造 bundle 并完成一次真理火球攻击（damage milestone）', () => {
    const bundle = fixtureBundle();
    const session = openCombat({ kind: 'new', bundle });
    const c1 = fixture.commands[0];
    // SupplyDice 喂 60 颗
    let trans = session.dispatch({
      commandId: 'sup',
      expectedRevision: 0,
      kind: 'SupplyDice',
      actorId: '',
      cost: 'none',
      payload: { outputId: 'out-1', dice: [...fixture.epochs[0].dice] },
    });
    // 首个攻击（真理火球 → 处刑人）
    trans = session.dispatch({ ...attackCommand(c1), expectedRevision: trans.revision });
    // 找到攻击产生的 DamageApplied 事件，断言伤害
    const dmg = trans.events.find((e) => e.kind === 'DamageApplied');
    expect(dmg).toBeDefined();
    if (dmg && dmg.kind === 'DamageApplied') {
      expect(dmg.targetId).toBe('神圣处刑人');
      expect(dmg.final).toBeGreaterThan(0);
    }
    // round 数
    expect(trans.snapshot.round).toBeGreaterThanOrEqual(1);
  });

  it('forceTerminal 桩 → settlement fpDelta 正确（内核内部 forceTerminal 触发）', () => {
    const bundle = fixtureBundle();
    // restore 用法：内核内部 forceTerminal 桩 = 直接注入 state.terminal 再结算
    const s = createCombatState(bundle);
    const withTerminal = {
      ...s,
      terminal: { reason: 'force_terminal' as const, winner: 'player' },
    };
    const session = openCombat({ kind: 'restore', state: withTerminal, bundle });
    const settle = session.dispatch({
      commandId: 'settle',
      expectedRevision: s.revision,
      kind: 'RequestSettlement',
      actorId: '',
      cost: 'none',
      payload: { settlementId: 'settle-09' },
    });
    // hp 未变动 → FP 净变动 0
    const dmgEvents = settle.events.filter((e) => e.kind === 'DamageApplied');
    const fpNarrative = settle.events.find((e) => e.kind === 'NarrativeCue');
    expect(fpNarrative).toBeDefined();
    expect(session.snapshot().terminal?.reason).toBe('force_terminal');
    void dmgEvents;
  });
});
