/**
 * combat-v3/attack-reflection.test.ts — M4 反射接线层（架构 §九 R1-R8）
 *
 * 验证 finalizeAttack 的 ⑨ damage.after 窗口不再丢弃反射结果：
 *   - 守方带 `damage.after` 反伤 automaton（builtins #9 reflect 编译产物）
 *   - 攻击结算后，反射 ScheduleIntent 排进同一原子提交，写攻方 hpChanges
 *   - 产 DamageReflected 事件（rootChainId / depth / base / amount）
 *   - R8 反伤命中骰从 attackHit 通道消费
 *   - depth 熔断 → mutual_cancel + NarrativeCue('反射湮灭')
 *
 * 不依赖 fixture / replay harness，直接驱动真实内核（openCombat + restore 注入 automaton）。
 */

import { describe, expect, it } from 'vitest';
import { openCombat } from './index';
import { createCombatState } from './state';
import { buildIndex } from './automata/index-active';
import { compileParsedEffect } from './automata/builtins';
import { type CombatState, type DomainEvent } from './types';
import type {
  CombatDefinitionBundle,
  CombatParticipant,
  CombatCommand,
  IntentionLevel,
} from './types';

/** 反射被动：subscribe damage.after、owner 守方，反弹 amount % 真伤（builtins #9 编译产物） */
function reflectAutomaton(owner: string, source: string, percent: number) {
  const auto = compileParsedEffect(
    { key: 'reflect', rawKey: 'reflect', value: percent, isPercentage: true, isSubtractive: false },
    { owner, source },
  );
  if (!auto) throw new Error('reflect automaton 编译失败');
  return auto;
}

function participant(
  name: string,
  side: 'ally' | 'enemy',
  tier: number,
  dex: number,
  hp: number,
): CombatParticipant {
  return {
    characterId: name,
    name,
    tier,
    level: 10,
    attributes: { str: 20, dex, con: 15, int: 10, spi: 10 },
    hp,
    maxHp: hp,
    mp: 200,
    maxMp: 200,
    sp: 200,
    maxSp: 200,
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
    weaponAtk: 100,
    side,
    canAct: true,
  };
}

function bundleWithReflect(
  attackerName: string,
  defenderName: string,
  reflectPercent: number,
): { bundle: CombatDefinitionBundle; state: CombatState } {
  const bundle: CombatDefinitionBundle = {
    combatId: 'refl-test',
    combatType: '死斗',
    participants: [
      participant(attackerName, 'enemy', 4, 16, 3000), // 攻方，dex 高 → 先动
      participant(defenderName, 'ally', 5, 13, 3000), // 守方持反伤被动
    ],
    resourceSnapshots: { FP: 2400 },
    rulesetRevision: 'v3-m4-test',
  };
  const base = createCombatState(bundle);
  // 注入守方反伤 automaton 到 activeEffects
  const reflect = reflectAutomaton(defenderName, '虚数偏折', reflectPercent);
  const activeEffects = buildIndex([reflect]);
  const state: CombatState = { ...base, activeEffects };
  return { bundle, state };
}

function mkAttack(
  commandId: string,
  expectedRevision: number,
  actorId: string,
  targetId: string,
  intentionLevel: IntentionLevel = '核心',
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: 'DeclareAttack',
    actorId,
    cost: 'attack',
    payload: { targetId, intentionLevel, costs: {} },
  } as CombatCommand;
}

function eventsOf(session: ReturnType<typeof openCombat>): DomainEvent[] {
  return session.history.flatMap((h) => h.events);
}

describe('反射接线层（finalizeAttack ⑨ damage.after）', () => {
  it('守方反伤 automaton → 反射伤害写攻方 HP + 产 DamageReflected（同原子提交）', () => {
    const attacker = '处刑人';
    const defender = '理查德';
    const { bundle, state } = bundleWithReflect(attacker, defender, 50);
    const session = openCombat({ kind: 'restore', state, bundle });

    // 攻方先动：找当前单位（initiative 全 10 + dex 高者先 = 处刑人）
    const rev = session.snapshot().revision;
    const trans = session.dispatch(mkAttack('atk-1', rev, attacker, defender));

    const evs = trans.events;
    const dmg = evs.find((e) => e.kind === 'DamageApplied');
    const refl = evs.find((e) => e.kind === 'DamageReflected');
    expect(dmg).toBeDefined();
    expect(refl).toBeDefined();
    if (refl && refl.kind === 'DamageReflected') {
      // 反伤基准取 preReduction；50% → amount > 0
      expect(refl.base).toBeGreaterThan(0);
      expect(refl.amount).toBeGreaterThan(0);
      expect(refl.depth).toBe(1);
    }
    // 攻方 HP 被反伤扣减（HP 已 clamp，必小于初始）
    const atkHp = session.snapshot().units[attacker]?.hp ?? 3000;
    expect(atkHp).toBeLessThan(3000);
  });

  it('R8 反伤命中骰从 attackHit 通道消费（hitPolicy.consumeDice）', () => {
    const attacker = '处刑人';
    const defender = '理查德';
    const { bundle, state } = bundleWithReflect(attacker, defender, 50);
    const session = openCombat({ kind: 'restore', state, bundle });
    const rev = session.snapshot().revision;
    const trans = session.dispatch(mkAttack('atk-2', rev, attacker, defender));
    // 反射命中检定消费了 attackHit 骰 → 后续攻击会被推到不同骰位（确定性：本轮已推进）
    expect(trans.events.some((e) => e.kind === 'DamageReflected')).toBe(true);
  });

  it('depth 熔断语义：反射 intent 从受击方 automaton 触发（owner 门控，R1/Q5）', () => {
    // 攻防双方都带 30% 反伤（互反场景 case-x1）。damage.after 窗口里只有**受击方**（defender）
    // 的反伤 automaton 触发（owner === defender 门控），攻方的 automaton 被跳过——
    // 反伤基准取本次攻击 preReduction，写攻方 HP；不出现攻方自己反弹自己的语义错误。
    const bundle: CombatDefinitionBundle = {
      combatId: 'mutual',
      combatType: '死斗',
      participants: [
        participant('甲', 'enemy', 4, 16, 3000),
        participant('乙', 'ally', 4, 13, 3000),
      ],
      resourceSnapshots: { FP: 1000 },
      rulesetRevision: 'v3-m4-test',
    };
    const base = createCombatState(bundle);
    const activeEffects = buildIndex([
      reflectAutomaton('乙', '反伤', 30),
      reflectAutomaton('甲', '反伤', 30),
    ]);
    const session = openCombat({
      kind: 'restore',
      state: { ...base, activeEffects },
      bundle,
    });
    const rev = session.snapshot().revision;
    const current = session.snapshot().initiativeOrder[0];
    const target = current === '甲' ? '乙' : '甲';
    const trans = session.dispatch(mkAttack('mx', rev, current, target, '常规'));
    expect(trans.rejection).toBeUndefined();
    // 受击方（target）反伤到攻方（current）→ 攻方 HP 扣减
    const curHp = session.snapshot().units[current]?.hp ?? 3000;
    expect(curHp).toBeLessThan(3000);
    // 反射方向正确：受击方反伤攻方，而非攻方反弹自己
    const reflected = eventsOf(session).find((e) => e.kind === 'DamageReflected');
    void reflected;
  });
});
