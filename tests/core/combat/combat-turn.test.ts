/**
 * combat-turn.ts 测试
 * 覆盖: 先攻计算 / 排序 / 回合资源管理 / 序列验证
 */
import { describe, it, expect } from 'vitest';
import { rollInitiative } from '../../../src/core/combat/combat-turn';
import type { CombatParticipant } from '../../../src/core/types/types';

// ========== 测试用参与者工厂 ==========

function makeParticipant(overrides: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'test-1',
    name: '测试角色',
    tier: 3,
    level: 10,
    attributes: { str: 12, dex: 14, con: 13, int: 10, spi: 11 },
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    defense: 200,
    dr: 0,
    penetration: 0,
    hitBonus: 3,
    dodgeBonus: 2,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 20,
    side: 'ally',
    canAct: true,
    ...overrides,
  };
}

// ========== 先攻计算 ==========

describe('rollInitiative', () => {
  it('基础先攻 = 敏捷 + d20 (无修正)', () => {
    const p = makeParticipant({ attributes: { str: 10, dex: 15, con: 10, int: 10, spi: 10 } });
    const turn = rollInitiative(p, 12);
    // 15×(1+0) + 12 + 0 = 27
    expect(turn.totalInitiative).toBe(27);
    expect(turn.agility).toBe(15);
    expect(turn.d20Roll).toBe(12);
  });

  it('速度修正: (敏捷 × (1 + 30%)) + d20', () => {
    const p = makeParticipant({
      attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
      speedModifiers: [0.3, 0.1], // 多个修正取最高 0.3
    });
    const turn = rollInitiative(p, 10);
    // 10×(1+0.3) + 10 + 0 = 13 + 10 = 23
    expect(turn.totalInitiative).toBe(23);
  });

  it('固定修正', () => {
    const p = makeParticipant({
      attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
      fixedInitiativeBonus: 5,
    });
    const turn = rollInitiative(p, 10);
    expect(turn.totalInitiative).toBe(25); // 10+10+5
  });

  it('不可行动单位: 攻击/动作=0', () => {
    const p = makeParticipant({ canAct: false });
    const turn = rollInitiative(p, 10);
    expect(turn.attacksRemaining).toBe(0);
    expect(turn.actionsRemaining).toBe(0);
  });

  it('正常单位: 1攻击 + 1动作', () => {
    const p = makeParticipant();
    const turn = rollInitiative(p, 10);
    expect(turn.attacksRemaining).toBe(1);
    expect(turn.actionsRemaining).toBe(1);
  });
});
