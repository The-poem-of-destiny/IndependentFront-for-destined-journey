/**
 * combat-turn.ts 测试
 * 覆盖: 先攻计算 / 排序 / 回合资源管理 / 序列验证
 */
import { describe, it, expect } from 'vitest';
import {
  rollInitiative,
  rollAndSortInitiative,
  nextTurnOrder,
  getCurrentActor,
  getNextActiveIndex,
  isRoundOver,
  consumeAttack,
  consumeAction,
  resetTurnResources,
  formatInitiativeSequence,
  validateInitiative,
} from './combat-turn';
import type { CombatParticipant } from './types';

// ========== 测试用参与者工厂 ==========

function makeParticipant(overrides: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'test-1',
    name: '测试角色',
    tier: 3,
    level: 10,
    attributes: { str: 12, dex: 14, con: 13, int: 10, spi: 11 },
    hp: 100, maxHp: 100,
    mp: 50, maxMp: 50,
    sp: 50, maxSp: 50,
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

// ========== 批量先攻排序 ==========

describe('rollAndSortInitiative', () => {
  it('按先攻从高到低排序', () => {
    const p1 = makeParticipant({ characterId: 'a', name: 'A', attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 } });
    const p2 = makeParticipant({ characterId: 'b', name: 'B', attributes: { str: 10, dex: 18, con: 10, int: 10, spi: 10 } });
    const p3 = makeParticipant({ characterId: 'c', name: 'C', attributes: { str: 10, dex: 8, con: 10, int: 10, spi: 10 }, side: 'enemy' });

    const order = rollAndSortInitiative([p1, p2, p3], [10, 10, 10]);

    expect(order.sequence).toHaveLength(3);
    expect(order.round).toBe(1);
    // B(28) > A(20) > C(18)
    expect(order.sequence[0].name).toBe('B');
    expect(order.sequence[0].totalInitiative).toBeGreaterThan(order.sequence[1].totalInitiative);
    expect(order.sequence[1].totalInitiative).toBeGreaterThan(order.sequence[2].totalInitiative);
  });

  it('nextTurnOrder 正确设置回合数', () => {
    const p = makeParticipant();
    const order = nextTurnOrder([p], [15], 3);
    expect(order.round).toBe(3);
  });
});

// ========== 行动顺序管理 ==========

describe('getCurrentActor', () => {
  it('返回当前索引的行动者', () => {
    const p = makeParticipant({ name: '当前' });
    const order = rollAndSortInitiative([p], [15]);
    const actor = getCurrentActor(order, 0);
    expect(actor).toBeDefined();
    expect(actor!.name).toBe('当前');
  });

  it('越界返回 null', () => {
    const p = makeParticipant();
    const order = rollAndSortInitiative([p], [15]);
    expect(getCurrentActor(order, -1)).toBeNull();
    expect(getCurrentActor(order, 99)).toBeNull();
  });
});

describe('getNextActiveIndex', () => {
  it('从当前位置找下一个有行动力的单位', () => {
    const p1 = makeParticipant({ characterId: 'a', name: 'A' });
    const p2 = makeParticipant({ characterId: 'b', name: 'B' });
    const p3 = makeParticipant({ characterId: 'c', name: 'C' });
    const order = rollAndSortInitiative([p1, p2, p3], [15, 12, 8]);

    // 消耗 A 的攻击和动作
    order.sequence[0].attacksRemaining = 0;
    order.sequence[0].actionsRemaining = 0;

    const next = getNextActiveIndex(order, 0);
    expect(order.sequence[next].name).toBe('B');
    expect(next).toBeGreaterThan(0);
  });

  it('所有人用完行动力 → 回合结束 (-1)', () => {
    const p1 = makeParticipant({ characterId: 'a' });
    const p2 = makeParticipant({ characterId: 'b' });
    const order = rollAndSortInitiative([p1, p2], [15, 12]);
    order.sequence[0].attacksRemaining = 0;
    order.sequence[0].actionsRemaining = 0;
    order.sequence[1].attacksRemaining = 0;
    order.sequence[1].actionsRemaining = 0;

    expect(getNextActiveIndex(order, 0)).toBe(-1);
  });
});

describe('isRoundOver', () => {
  it('所有单位用完资源回合结束', () => {
    const p = makeParticipant();
    const order = rollAndSortInitiative([p], [10]);
    order.sequence[0].attacksRemaining = 0;
    order.sequence[0].actionsRemaining = 0;
    expect(isRoundOver(order)).toBe(true);
  });

  it('有单位还有攻击 → 回合未结束', () => {
    const p = makeParticipant();
    const order = rollAndSortInitiative([p], [10]);
    expect(isRoundOver(order)).toBe(false);
  });
});

// ========== 资源消耗 ==========

describe('consumeAttack / consumeAction', () => {
  it('消耗 1 次攻击', () => {
    const p = makeParticipant({ characterId: 'test' });
    const order = rollAndSortInitiative([p], [10]);
    consumeAttack(order, 'test');
    expect(order.sequence[0].attacksRemaining).toBe(0);
  });

  it('消耗 1 个动作', () => {
    const p = makeParticipant({ characterId: 'test' });
    const order = rollAndSortInitiative([p], [10]);
    consumeAction(order, 'test');
    expect(order.sequence[0].actionsRemaining).toBe(0);
  });

  it('不存在的 ID 无影响', () => {
    const p = makeParticipant({ characterId: 'test' });
    const order = rollAndSortInitiative([p], [10]);
    consumeAttack(order, '不存在');
    expect(order.sequence[0].attacksRemaining).toBe(1);
  });

  it('不能消耗为负数', () => {
    const p = makeParticipant({ characterId: 'test' });
    const order = rollAndSortInitiative([p], [10]);
    consumeAttack(order, 'test');
    consumeAttack(order, 'test');
    expect(order.sequence[0].attacksRemaining).toBe(0);
  });
});

// ========== 重置 ==========

describe('resetTurnResources', () => {
  it('重置所有单位到 1攻击+1动作', () => {
    const p1 = makeParticipant({ characterId: 'a' });
    const p2 = makeParticipant({ characterId: 'b' });
    const order = rollAndSortInitiative([p1, p2], [10, 12]);
    consumeAttack(order, 'a');
    consumeAction(order, 'b');

    resetTurnResources(order);
    for (const u of order.sequence) {
      expect(u.attacksRemaining).toBe(1);
      expect(u.actionsRemaining).toBe(1);
    }
  });
});

// ========== 格式化 ==========

describe('formatInitiativeSequence', () => {
  it('生成人类可读序列描述', () => {
    const p1 = makeParticipant({ characterId: 'a', name: '劍士' });
    const p2 = makeParticipant({ characterId: 'b', name: '法師' });
    const order = rollAndSortInitiative([p1, p2], [15, 8]);

    const output = formatInitiativeSequence(order);
    expect(output).toContain('劍士');
    expect(output).toContain('法師');
    expect(output).toContain('序列');
  });

  it('空序列显示占位', () => {
    const output = formatInitiativeSequence({ sequence: [], round: 1 });
    expect(output).toContain('(空)');
  });
});

// ========== 验证 ==========

describe('validateInitiative', () => {
  it('最少 2 名参与者', () => {
    const result = validateInitiative([makeParticipant()]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('2'))).toBe(true);
  });

  it('需要友方和敌方', () => {
    const allies = [makeParticipant({ characterId: 'a', side: 'ally' }), makeParticipant({ characterId: 'b', side: 'ally' })];
    const result = validateInitiative(allies);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('敌方'))).toBe(true);
  });

  it('有效的战斗配置', () => {
    const chars = [
      makeParticipant({ characterId: 'a', side: 'ally' }),
      makeParticipant({ characterId: 'b', side: 'enemy' }),
    ];
    const result = validateInitiative(chars);
    expect(result.valid).toBe(true);
  });

  it('检查无效敏捷', () => {
    const chars = [
      makeParticipant({ characterId: 'a', side: 'ally', attributes: { str: 10, dex: 0, con: 10, int: 10, spi: 10 } }),
      makeParticipant({ characterId: 'b', side: 'enemy' }),
    ];
    const result = validateInitiative(chars);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('敏捷'))).toBe(true);
  });
});
