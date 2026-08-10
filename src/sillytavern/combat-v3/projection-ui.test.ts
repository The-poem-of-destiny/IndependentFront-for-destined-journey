/**
 * combat-v3/projection-ui.test.ts — 投影 A 映射（M2）
 *
 * 验收对应（plan §4.9 / §4.11 A2-6）：
 *   - 穷尽：每个 DomainEvent 变体都有映射目标（projectToUi 对 DomainEvent switch 无
 *     「静默丢弃」分支；新增变体未接映射编译不过）
 *   - 映射正确性：CombatOpened → v3_combat_started；DamageApplied → v3_action 等
 *   - 29 个 DomainEvent 全部有映射目标（A2-6）
 */

import { describe, expect, it } from 'vitest';
import { projectToUi } from './projection-ui';
import type { CombatUnitView, DomainEvent } from './types';

/** 覆盖 29 个 DomainEvent 变体的样本集（M1 已有的 + M2 扩展的结构占位） */
const ALL_EVENTS: DomainEvent[] = [
  // 生命周期 8
  { kind: 'CombatOpened', combatId: 'c', combatType: '标准', unitIds: ['甲'], bundleHash: 'h' },
  { kind: 'RoundOpened', round: 1 },
  { kind: 'InitiativeRolled', round: 1, order: [{ unitId: '甲', value: 10, roll: 10 }] },
  { kind: 'TurnOpened', unitId: '甲', attacksRemaining: 1, actionsRemaining: 1 },
  { kind: 'TurnClosed', unitId: '甲', attacksConsumed: 1, actionsConsumed: 1 },
  { kind: 'RoundClosed', round: 1 },
  { kind: 'CombatEnded', reason: 'hp_zero', winner: 'player' },
  { kind: 'SettlementCommitted', settlementId: 's', fpDelta: -50, reason: 'hp_zero' },
  // 结算 11
  {
    kind: 'AttackDeclared',
    attackerId: '甲',
    targetId: '乙',
    skill: '剑',
    intentionLevel: '常规',
  },
  {
    kind: 'AttackResolved',
    attackerId: '甲',
    targetId: '乙',
    checkValue: 15,
    rating: '有效',
    hit: true,
    dice: [10],
  },
  {
    kind: 'DamageApplied',
    attackerId: '甲',
    targetId: '乙',
    preReduction: 100,
    postStep6: 90,
    final: 90,
    damageType: '物理',
    targetHpBefore: 500,
    targetHpAfter: 410,
  },
  { kind: 'HpFloored', unitId: '乙', hp: 0 },
  { kind: 'UnitDowned', unitId: '乙', hp: 0 },
  { kind: 'UnitDefeated', unitId: '乙', winnerSide: 'player' },
  {
    kind: 'StatusApplied',
    unitId: '乙',
    statusId: '流血',
    stacks: 1,
    duration: 2,
  },
  { kind: 'StatusRemoved', unitId: '乙', statusId: '流血' },
  { kind: 'StatusExpired', unitId: '乙', statusId: '流血' },
  { kind: 'ResourceSpent', unitId: '甲', resource: 'sp', amount: 20 },
  { kind: 'MoraleChanged', unitId: '乙', threshold: 10, roll: 5, state: 'routing' },
  // v3 新增 10
  { kind: 'UnitSummoned', unitId: '食尸鬼', joinTiming: 'this_round_tail', duration: 3 },
  { kind: 'UnitDespawned', unitId: '食尸鬼', reason: 'expired' },
  { kind: 'DamagePrevented', unitId: '甲', amount: 80, keptHp: 1 },
  { kind: 'DamageReflected', rootChainId: 'c1', depth: 1, base: 100, amount: 30 },
  { kind: 'MiracleTriggered', effectDescription: '奇迹', divinity: 6 },
  { kind: 'AdjudicationAccepted', ruleKey: 'death.threshold', divinity: 6, reason: 'ok' },
  { kind: 'RuleOverridden', ruleKey: 'death.threshold', divinity: 6 },
  { kind: 'EffectRejected', code: 'INVALID', detail: 'x' },
  { kind: 'DiceEpochBegan', outputId: 'out-2' },
  { kind: 'NarrativeCue', text: '旁白', severity: 1 },
  { kind: 'FleeAttempt', unitId: '甲', success: true, roll: 18 },
];

describe('A2-6：29 个 DomainEvent 全部有映射（穷尽）', () => {
  it('projectToUi 不抛错且每个事件产出至少一个 CombatEvent（无静默丢弃）', () => {
    const out = projectToUi(ALL_EVENTS);
    expect(out.length).toBe(ALL_EVENTS.length); // 一一对应，无丢弃
    expect(out.every((e) => e && e.type)).toBe(true);
  });
});

describe('映射正确性', () => {
  it('CombatOpened → v3_combat_started; RoundOpened → v3_round_started', () => {
    const out = projectToUi([
      { kind: 'CombatOpened', combatId: 'c', combatType: '标准', unitIds: ['甲'], bundleHash: 'h' },
      { kind: 'RoundOpened', round: 3 },
    ]);
    expect(out[0]).toEqual({
      type: 'v3_combat_started',
      combatId: 'c',
      round: 1,
      unitNames: ['甲'],
    });
    expect(out[1]).toEqual({ type: 'v3_round_started', round: 3 });
  });

  it('T13：CombatOpened 且传 units → 补发 v3_units_snapshot（紧随 v3_combat_started，内容完整）', () => {
    const units: Record<string, CombatUnitView> = {
      甲: {
        id: '甲',
        name: '甲',
        side: 'player',
        tier: 1,
        hp: 100,
        maxHp: 100,
        mp: 50,
        maxMp: 50,
        sp: 50,
        maxSp: 50,
        attacksRemaining: 1,
        actionsRemaining: 1,
        canAct: true,
        morale: 'steady',
        statusEffects: [],
      },
      乙: {
        id: '乙',
        name: '乙',
        side: 'enemy',
        tier: 3,
        hp: 320,
        maxHp: 320,
        mp: 0,
        maxMp: 0,
        sp: 0,
        maxSp: 0,
        attacksRemaining: 1,
        actionsRemaining: 1,
        canAct: true,
        morale: 'steady',
        statusEffects: [],
      },
    };
    const out = projectToUi(
      [
        {
          kind: 'CombatOpened',
          combatId: 'c',
          combatType: '标准',
          unitIds: ['甲', '乙'],
          bundleHash: 'h',
        },
      ],
      { units },
    );
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('v3_combat_started'); // 快照必须紧随其后（store 先建对象再填 units）
    expect(out[1]).toEqual({ type: 'v3_units_snapshot', units });
  });

  it('T13：不传 units → 不产 v3_units_snapshot（与 T13 前逐字节一致，A2-6 一一对应保持）', () => {
    const out = projectToUi([
      { kind: 'CombatOpened', combatId: 'c', combatType: '标准', unitIds: ['甲'], bundleHash: 'h' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('v3_combat_started');
  });

  it('DamageApplied → v3_action（合并成动作卡片载荷）', () => {
    const out = projectToUi([
      {
        kind: 'DamageApplied',
        attackerId: '甲',
        targetId: '乙',
        preReduction: 100,
        postStep6: 90,
        final: 90,
        damageType: '物理',
        targetHpBefore: 500,
        targetHpAfter: 410,
      },
    ]);
    expect(out[0].type).toBe('v3_action');
    if (out[0].type === 'v3_action') {
      expect(out[0].result.final).toBe(90);
      expect(out[0].result.damageType).toBe('物理');
    }
  });

  it('终局与单位状态事件映射到专用变体', () => {
    const out = projectToUi([
      { kind: 'UnitDowned', unitId: '乙', hp: 0 },
      { kind: 'MoraleChanged', unitId: '乙', threshold: 10, roll: 5, state: 'routing' },
      { kind: 'CombatEnded', reason: 'hp_zero', winner: 'player' },
    ]);
    expect(out[0].type).toBe('v3_unit_state_changed');
    expect(out[1].type).toBe('v3_morale_changed');
    expect(out[2]).toEqual({ type: 'v3_combat_ended', reason: 'hp_zero', winner: 'player' });
  });
});
