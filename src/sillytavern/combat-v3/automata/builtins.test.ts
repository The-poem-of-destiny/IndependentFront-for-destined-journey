/**
 * combat-v3/automata/builtins.test.ts — 内建 adapter 注册表测试（M3, 验收 A3-4）
 *
 * 覆盖（plan §5.8 / §5.3）：15 条内建映射逐条断言编译结果的 window + intent kind。
 *   - 攻方固伤 → collect_attacker_mods + AddModifier(slot:'fixedDamage')
 *   - 伤害+N% → collect_attacker_mods + AddModifier(slot:'damageMult')
 *   - 受到伤害-N%（修 M-6）→ collect_defender_mods + AddModifier(slot:'damageTaken')
 *   - etc.
 *   - 不匹配 → null（UnsupportedCapability 入口）
 */

import { describe, it, expect } from 'vitest';
import { compileParsedEffect, BUILTIN_ADAPTERS } from './builtins';
import type { BuiltinSeed } from './builtins';
import type { ParsedEffect } from '../../types';

const seed: BuiltinSeed = {
  owner: '理查德',
  source: '真理·虚数偏折',
  idPrefix: 'item',
  divinity: 3,
};

function mkEffect(partial: Partial<ParsedEffect>): ParsedEffect {
  return {
    key: 'hp',
    rawKey: 'HP',
    value: 0,
    isPercentage: false,
    isSubtractive: false,
    ...partial,
  };
}

describe('builtins — 15 条内建映射', () => {
  it('#1 攻方固伤 → collect_attacker_mods + fixedDamage', () => {
    const a = compileParsedEffect(mkEffect({ key: 'physicalDmg', value: 50 }), seed);
    expect(a).not.toBeNull();
    expect(a!.subscribe).toBe('collect_attacker_mods');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'fixedDamage', value: 50 });
  });

  it('#2 伤害+N% → collect_attacker_mods + damageMult', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'damageMult', value: 20, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('collect_attacker_mods');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'damageMult', value: 0.2 });
  });

  it('#3 受到伤害-N%（修 M-6）→ collect_defender_mods + damageTaken', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'damageTaken', value: 20, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('collect_defender_mods');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'damageTaken', value: -0.2 });
  });

  it('#4 命中+N → check.hit + hitBonus', () => {
    const a = compileParsedEffect(mkEffect({ key: 'hit', value: 5 }), seed);
    expect(a!.subscribe).toBe('check.hit');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'hitBonus', value: 5 });
  });

  it('#5 闪避+N → check.hit + dodge', () => {
    const a = compileParsedEffect(mkEffect({ key: 'dodge', value: 3 }), seed);
    expect(a!.subscribe).toBe('check.hit');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'dodge', value: 3 });
  });

  it('#6 先攻+N → initiative.before + initiative', () => {
    const a = compileParsedEffect(mkEffect({ key: 'initiative', value: 2 }), seed);
    expect(a!.subscribe).toBe('initiative.before');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'initiative', value: 2 });
  });

  it('#7 DR N% → collect_defender_mods + dr', () => {
    const a = compileParsedEffect(mkEffect({ key: 'dr', value: 10, isPercentage: true }), seed);
    expect(a!.subscribe).toBe('collect_defender_mods');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'dr', value: 0.1 });
  });

  it('#8 穿透 N% → collect_attacker_mods + penetration', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'penetration', value: 30, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('collect_attacker_mods');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'penetration', value: 0.3 });
  });

  it('#9 反弹 N% → damage.after + ScheduleIntent(DealDamage isReaction)', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'reflect', value: 30, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('damage.after');
    const s = a!.intents[0];
    expect(s.kind).toBe('ScheduleIntent');
    if (s.kind === 'ScheduleIntent') {
      expect(s.intent).toMatchObject({
        kind: 'DealDamage',
        isReaction: true,
        doesNotConsumeSlot: true,
        damageType: 'true',
        hitPolicy: { consumeDice: true, advantage: 'adv' },
      });
    }
  });

  it('#10 吸血 N% → damage.after + Heal(self, ctx.damage.final * N)', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'lifesteal', value: 15, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('damage.after');
    // trigger 表达 'ctx.damage.final > 0'
    expect(a!.triggerAst.t).toBe('bin');
    const h = a!.intents[0];
    expect(h.kind).toBe('Heal');
  });

  it('#11 护盾 N → turn.open + ApplyStatus(护盾)', () => {
    const a = compileParsedEffect(mkEffect({ key: 'shield', value: 200 }), seed);
    expect(a!.subscribe).toBe('turn.open');
    const s = a!.intents[0];
    expect(s.kind).toBe('ApplyStatus');
    if (s.kind === 'ApplyStatus') {
      expect(s.statusId).toContain('护盾');
      expect(s.layers).toBe(200);
    }
  });

  it('#12 每回合扣 N% maxHp → round.close + DealDamage(doesNotConsumeSlot)', () => {
    const a = compileParsedEffect(mkEffect({ key: 'dot', value: 5, isPercentage: true }), seed);
    expect(a!.subscribe).toBe('round.close');
    const d = a!.intents[0];
    expect(d.kind).toBe('DealDamage');
    if (d.kind === 'DealDamage') {
      expect(d.doesNotConsumeSlot).toBe(true);
      expect(d.hitPolicy?.consumeDice).toBe(false);
    }
  });

  it('#13 每回合回 N HP → round.open + Heal', () => {
    const a = compileParsedEffect(mkEffect({ key: 'hot', value: 30 }), seed);
    expect(a!.subscribe).toBe('round.open');
    expect(a!.intents[0]).toMatchObject({ kind: 'Heal', amount: 30 });
  });

  it('#14 暴击率+N% → check.hit + critThreshold', () => {
    const a = compileParsedEffect(
      mkEffect({ key: 'critRate', value: 15, isPercentage: true }),
      seed,
    );
    expect(a!.subscribe).toBe('check.hit');
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'critThreshold' });
  });

  it('不匹配任何内建 → null（UnsupportedCapability 入口）', () => {
    const a = compileParsedEffect(mkEffect({ key: 'fireDmg', value: 10 }), seed);
    expect(a).toBeNull();
  });
});

describe('builtins — 注册表完整性', () => {
  it('15 条 key 全部可访问', () => {
    const keys = [
      'physicalDmg',
      'damageMult',
      'damageTaken',
      'hit',
      'dodge',
      'initiative',
      'dr',
      'penetration',
      'reflect',
      'lifesteal',
      'shield',
      'dot',
      'hot',
      'critRate',
    ];
    for (const k of keys) {
      expect(typeof BUILTIN_ADAPTERS[k]).toBe('function');
    }
  });
});
