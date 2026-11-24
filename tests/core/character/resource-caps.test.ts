/**
 * resource-caps.ts — 资源上限「基础 + 额外」不变式（状态树协议 §5.6）
 */
import { describe, expect, it } from 'vitest';
import {
  baseResourceCaps,
  bonusForTotalCap,
  effectiveCap,
  readResourceCaps,
  recomputeResourceCaps,
  solidifyResourceBonuses,
} from '../../../src/core/character/resource-caps';
import { calcResources } from '../../../src/core/character/tier-constants';
import { createDefaultCharacterState } from '../../../src/core/types/types';

const ATTRS = { str: 10, dex: 8, con: 12, int: 6, spi: 9 };

describe('baseResourceCaps', () => {
  it('基础等于 calcResources 的三个上限', () => {
    const r = calcResources(2, ATTRS);
    expect(baseResourceCaps(2, ATTRS)).toEqual({ hp: r.maxHp, mp: r.maxMp, sp: r.maxSp });
  });
});

describe('readResourceCaps', () => {
  it('旧档角色（无 *Bonus）读出的有效上限等于原 maxHp / maxMp / maxSp', () => {
    const char = createDefaultCharacterState({
      tier: 2,
      attributes: ATTRS,
      maxHp: 5000,
      maxMp: 777,
      maxSp: 3,
    });
    const caps = readResourceCaps(char);
    expect(caps.hp.effective).toBe(5000);
    expect(caps.mp.effective).toBe(777);
    expect(caps.sp.effective).toBe(3);
    const base = baseResourceCaps(2, ATTRS);
    expect(caps.hp.bonus).toBe(5000 - base.hp);
    expect(caps.sp.bonus).toBe(3 - base.sp);
  });

  it('按公式生成的角色额外读作 0', () => {
    const r = calcResources(3, ATTRS);
    const char = createDefaultCharacterState({
      tier: 3,
      attributes: ATTRS,
      maxHp: r.maxHp,
      maxMp: r.maxMp,
      maxSp: r.maxSp,
    });
    const caps = readResourceCaps(char);
    expect(caps.hp).toEqual({ base: r.maxHp, bonus: 0, effective: r.maxHp });
    expect(caps.mp.bonus).toBe(0);
  });

  it('字段在场时以字段为准，有效上限 = 基础 + 额外', () => {
    const base = baseResourceCaps(1, ATTRS);
    const char = createDefaultCharacterState({
      tier: 1,
      attributes: ATTRS,
      maxHp: 1, // 陈旧总值，不参与
      maxHpBonus: 50,
    });
    expect(readResourceCaps(char).hp).toEqual({
      base: base.hp,
      bonus: 50,
      effective: base.hp + 50,
    });
  });

  it('额外为大负数时有效上限兜底为 1', () => {
    const char = createDefaultCharacterState({ tier: 1, attributes: ATTRS, maxMpBonus: -99999 });
    expect(readResourceCaps(char).mp.effective).toBe(1);
  });
});

describe('effectiveCap', () => {
  it('取 max(1, 基础 + 额外)', () => {
    expect(effectiveCap(100, 20)).toBe(120);
    expect(effectiveCap(100, -100)).toBe(1);
    expect(effectiveCap(100, -150)).toBe(1);
  });
});

describe('solidifyResourceBonuses + recomputeResourceCaps', () => {
  it('升层级后按新基础重算，额外保持；上限上升时当前值不变', () => {
    const oldBase = baseResourceCaps(1, ATTRS);
    const char = createDefaultCharacterState({
      tier: 1,
      attributes: ATTRS,
      hp: 10,
      maxHp: oldBase.hp + 30,
      mp: 5,
      maxMp: oldBase.mp,
      sp: 7,
      maxSp: oldBase.sp - 10,
    });
    const bonuses = solidifyResourceBonuses(char);
    expect(bonuses).toEqual({ hp: 30, mp: 0, sp: -10 });

    const out = recomputeResourceCaps({
      tier: 2,
      attributes: ATTRS,
      bonuses,
      previousMax: { hp: char.maxHp, mp: char.maxMp, sp: char.maxSp },
      current: { hp: char.hp, mp: char.mp, sp: char.sp },
    });
    const newBase = baseResourceCaps(2, ATTRS);
    expect(out.maxHp).toBe(newBase.hp + 30);
    expect(out.maxSp).toBe(newBase.sp - 10);
    expect(out.maxHpBonus).toBe(30);
    expect(out.maxSpBonus).toBe(-10);
    expect(out.hp).toBe(10); // 不白送恢复
    expect(out.mp).toBe(5);
  });

  it('上限下降时当前值钳到新上限', () => {
    const base = baseResourceCaps(1, ATTRS);
    const out = recomputeResourceCaps({
      tier: 1,
      attributes: ATTRS,
      bonuses: { hp: -base.hp + 10, mp: 0, sp: 0 },
      previousMax: { hp: base.hp, mp: base.mp, sp: base.sp },
      current: { hp: base.hp, mp: base.mp, sp: base.sp },
    });
    expect(out.maxHp).toBe(10);
    expect(out.hp).toBe(10);
    expect(out.mp).toBe(base.mp);
  });

  it('上限下降但仍高于当前值时，当前值不动', () => {
    const base = baseResourceCaps(1, ATTRS);
    const lowered = { ...ATTRS, con: ATTRS.con - 1 };
    const newBase = baseResourceCaps(1, lowered);
    const out = recomputeResourceCaps({
      tier: 1,
      attributes: lowered,
      bonuses: { hp: 0, mp: 0, sp: 0 },
      previousMax: { hp: base.hp, mp: base.mp, sp: base.sp },
      current: { hp: 1, mp: 1, sp: 1 },
    });
    expect(out.maxHp).toBe(newBase.hp);
    expect(out.hp).toBe(1);
  });
});

describe('bonusForTotalCap', () => {
  it('旧写法 maxHp: n 换算成额外 = n − 基础', () => {
    const char = createDefaultCharacterState({ tier: 2, attributes: ATTRS });
    const base = baseResourceCaps(2, ATTRS);
    expect(bonusForTotalCap(char, 'hp', base.hp + 40)).toBe(40);
    expect(bonusForTotalCap(char, 'mp', base.mp - 5)).toBe(-5);
  });
});
