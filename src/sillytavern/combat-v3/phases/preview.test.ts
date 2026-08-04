/**
 * combat-v3/phases/preview.test.ts — damage.preview 全流程测试（M3, 验收 A3-5 / A3-6）
 *
 * 覆盖（plan §5.4 / §5.8）：
 *   - A3-6  无订阅者不暂停（无反应 automaton 的单位受击不触发暂停）
 *   - A3-5  有订阅者：伤害算出 → RequestChoice → RequiredInput.EffectChoice →
 *           冻结 frame → DeclareBlock → 回到 damage.compute 重算 → 伤害按格挡因子折减
 *   - 恢复不重取骰（frame 恢复用暂存 recompute，不再 draw）
 */

import { describe, it, expect } from 'vitest';
import { reduce } from '../reducer';
import { createCombatState } from '../state';
import { buildIndex } from '../automata/index-active';
import type { CombatCommand, CombatState, CompiledAutomaton, DomainEvent } from '../types';
import { mkBundle, mkAttack } from '../test-utils';

/** 造一条 格挡 反应 automaton（damage.preview → RequestChoice + blockDamageFactor） */
function blockAutomaton(owner: string, blockFactor: number): CompiledAutomaton {
  return {
    id: `item.${owner}.block`,
    name: `${owner}·格挡`,
    source: '格挡',
    owner,
    subscribe: 'damage.preview',
    priority: 0,
    divinity: 0,
    stableId: `item.${owner}.block`,
    triggerAst: { t: 'bool', v: true },
    isAdapter: true,
    intents: [
      {
        kind: 'RequestChoiceIntent',
        choiceId: `block-${owner}`,
        prompt: '格挡？',
        options: ['是', '否'],
        cost: { sp: 50, slot: 'action' },
        blockDamageFactor: blockFactor,
      },
    ],
  };
}

/** 给 state 注入一个 damage.preview 订阅索引 */
function withAutomaton(state: CombatState, auto: CompiledAutomaton): CombatState {
  return { ...state, activeEffects: buildIndex([auto]) };
}

describe('A3-6：无订阅者不暂停', () => {
  it('没有 damage.preview 订阅者 → 攻击无 requiredInput，直接结算', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    const t = reduce(bundle, s, mkAttack('a1', 0, '甲', '乙'));
    // ActiveEffectIndex 恒空（buildIndex([])）→ damage.preview 无订阅 → 不暂停
    expect(t.requiredInput?.kind).not.toBe('EffectChoice');
    // 正常推进：还有动作槽 → PlayerCommand
    expect(t.requiredInput?.kind).toBe('PlayerCommand');
  });
});

describe('A3-5：有订阅者 → 暂停并冻结 frame', () => {
  it('受击方有格挡 automaton → 冻结 frame + EffectChoice', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    s = withAutomaton(s, blockAutomaton('乙', 0.2));
    const t = reduce(bundle, s, mkAttack('a1', 0, '甲', '乙'));

    expect(t.requiredInput?.kind).toBe('EffectChoice');
    if (t.requiredInput?.kind === 'EffectChoice') {
      expect(t.requiredInput.unitId).toBe('乙');
      expect(t.requiredInput.options).toEqual(['是', '否']);
      expect(t.requiredInput.blockDamageFactor).toBe(0.2);
      expect(t.requiredInput.damagePreview).toBeGreaterThan(0);
    }
    // 帧已冻结（resolution.step === 'damage.preview'）
    expect(t.next?.resolution?.step).toBe('damage.preview');
  });
});

describe('A3-5：DeclareBlock → 回到 damage.compute 重算（487→97 路径）', () => {
  it('格挡后 final = floor(previewDamAge × blockFactor)，恢复不重取骰', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    s = withAutomaton(s, blockAutomaton('乙', 0.2));

    // ① 攻击 → 进入 damage.preview 冻结
    const attackTrans = reduce(bundle, s, mkAttack('a1', 0, '甲', '乙'));
    const preview = attackTrans.requiredInput;
    expect(preview).toBeTruthy();
    const previewDamage = preview && preview.kind === 'EffectChoice' ? preview.damagePreview : 0;
    const blockFactor =
      preview && preview.kind === 'EffectChoice' ? (preview.blockDamageFactor ?? 1) : 1;

    // ② DeclareBlock 恢复（同 revision）
    const blockTrans = reduce(bundle, attackTrans.next!, {
      commandId: 'block1',
      expectedRevision: attackTrans.next!.revision,
      kind: 'DeclareBlock',
      actorId: '乙',
      cost: 'action',
      payload: { choiceId: 'block-乙' },
    });

    // ★ 回到 damage.compute 重算：final == floor(preview × 0.2)
    const damageEvt = blockTrans.events.find((e) => e.kind === 'DamageApplied') as
      (DomainEvent & { final: number }) | undefined;
    expect(damageEvt).toBeTruthy();
    expect(damageEvt!.final).toBe(Math.floor(previewDamage * blockFactor));

    // 恢复后 resolution 已清除
    expect(blockTrans.next?.resolution).toBeUndefined();
    // 乙实际受到了重算后的伤害（HP 下降 = final）
    const hpBefore = attackTrans.next!.units['乙'].hp;
    expect(blockTrans.next!.units['乙'].hp).toBe(Math.max(0, hpBefore - damageEvt!.final));
  });

  it('blockDamageFactor 折减成比例（重算路径通用）', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    s = withAutomaton(s, blockAutomaton('乙', 0.2));
    const attackTrans = reduce(bundle, s, mkAttack('a1', 0, '甲', '乙'));
    const preview = attackTrans.requiredInput;
    const previewDamage = preview && preview.kind === 'EffectChoice' ? preview.damagePreview : 0;
    const blockTrans = reduce(bundle, attackTrans.next!, {
      commandId: 'b2',
      expectedRevision: attackTrans.next!.revision,
      kind: 'DeclareBlock',
      actorId: '乙',
      cost: 'action',
      payload: {},
    });
    const dmg = blockTrans.events.find((e) => e.kind === 'DamageApplied') as
      (DomainEvent & { final: number }) | undefined;
    expect(dmg!.final).toBe(Math.floor(previewDamage * 0.2));
  });
});

// ── Q-21：格挡重算必须沿用**当次声明**的伤害类型 ──
describe('Q-21：格挡重算沿用冻结的 damageType', () => {
  /**
   * 这一场刻意让「本次技能声明的类型」与「攻击者基础档的类型」不同 ——
   * 真实伤害无视类型减免（reductionRate 0），物理走 (con+str+dex)×0.25%。
   *
   * 修复前 `resumeBlockedAttack` 读的是 `attacker.ability?.damageType ?? '物理'`，
   * 于是 preview 按真实算、重算按物理算，格挡后的伤害凭空多挨一道 12.5% 的减免，
   * 且 `DamageApplied.damageType` 也报成物理。修复后两条路径同源于冻结的 frame。
   */
  function mkTypedAttack(revision: number): CombatCommand {
    return {
      commandId: 'a-typed',
      expectedRevision: revision,
      kind: 'DeclareAttack',
      actorId: '甲',
      cost: 'attack',
      payload: {
        targetId: '乙',
        intentionLevel: '常规',
        // 本次挥出去的是一记真实伤害技能
        ability: {
          relevantAttribute: 20,
          skillPower: 100,
          damageType: '真实',
          intentionLevel: '常规',
          multiHitCount: 1,
          divinity: 0,
        },
      },
    } as CombatCommand;
  }

  /** 攻击者基础档是物理 —— 修复前重算会回头读到它 */
  function withPhysicalBaseAbility(state: CombatState): CombatState {
    return {
      ...state,
      units: {
        ...state.units,
        甲: {
          ...state.units['甲'],
          ability: {
            relevantAttribute: 20,
            skillPower: 100,
            damageType: '物理',
            intentionLevel: '常规',
            multiHitCount: 1,
            divinity: 0,
          },
        },
      },
    };
  }

  it('技能类型异于攻击者基础档时，重算不回落到基础档', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    s = withPhysicalBaseAbility(s);
    s = withAutomaton(s, blockAutomaton('乙', 0.2));

    const attackTrans = reduce(bundle, s, mkTypedAttack(0));
    const preview = attackTrans.requiredInput;
    expect(preview?.kind).toBe('EffectChoice');
    const previewDamage = preview && preview.kind === 'EffectChoice' ? preview.damagePreview : 0;
    expect(previewDamage).toBeGreaterThan(0);

    const blockTrans = reduce(bundle, attackTrans.next!, {
      commandId: 'b-typed',
      expectedRevision: attackTrans.next!.revision,
      kind: 'DeclareBlock',
      actorId: '乙',
      cost: 'action',
      payload: { choiceId: 'block-乙' },
    });

    const dmg = blockTrans.events.find((e) => e.kind === 'DamageApplied') as
      (DomainEvent & { final: number; damageType: string }) | undefined;
    expect(dmg).toBeTruthy();
    // ① 事件如实报出当次声明的类型（修复前是 '物理'）
    expect(dmg!.damageType).toBe('真实');
    // ② 折减是**纯乘**：重算与 preview 同源，只差一个 blockDamageFactor。
    //    修复前物理的 12.5% 类型减免会让这一条不成立。
    expect(dmg!.final).toBe(Math.floor(previewDamage * 0.2));
  });

  it('未声明 ability 时仍走攻击者基础档（回退语义不变）', () => {
    const bundle = mkBundle();
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 500000, maxHp: 500000 } } };
    s = withPhysicalBaseAbility(s);
    s = withAutomaton(s, blockAutomaton('乙', 0.2));

    const attackTrans = reduce(bundle, s, mkAttack('a-base', 0, '甲', '乙'));
    const blockTrans = reduce(bundle, attackTrans.next!, {
      commandId: 'b-base',
      expectedRevision: attackTrans.next!.revision,
      kind: 'DeclareBlock',
      actorId: '乙',
      cost: 'action',
      payload: { choiceId: 'block-乙' },
    });
    const dmg = blockTrans.events.find((e) => e.kind === 'DamageApplied') as
      (DomainEvent & { damageType: string }) | undefined;
    expect(dmg!.damageType).toBe('物理');
  });
});
