/**
 * resource-calc.ts — Layer 2 $resource API 测试
 */
import { describe, it, expect } from 'vitest';
import {
  getHpPercent,
  getMpPercent,
  getSpPercent,
  isAlive,
  isUnconscious,
  isDead,
  isFullHp,
  isFullMp,
  isExhausted,
  canAffordHp,
  canAffordMp,
  canAffordSp,
  canAffordMoney,
  hasItem,
  hasSkill,
  hasStatus,
  getAttribute,
  getTier,
  getLevel,
  getAdventurerRank,
  expToLevel,
  totalExpForLevel,
  expFromMonster,
  queryResource,
  $resource,
} from './resource-calc';
import { createDefaultCharacterState } from './types';
import type { InventoryItem, Skill, StatusEffect, CharacterState } from './types';

/** 快速创建角色 fixture */
function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    name: '测试角色',
    ...overrides,
  });
}

// ========== 百分比 ==========

describe('getHpPercent', () => {
  it('满血应返回 100%', () => {
    const c = makeChar({ hp: 100, maxHp: 100 });
    expect(getHpPercent(c)).toBe(100);
  });

  it('半血应返回 50%', () => {
    const c = makeChar({ hp: 50, maxHp: 100 });
    expect(getHpPercent(c)).toBe(50);
  });

  it('0 血应返回 0%', () => {
    const c = makeChar({ hp: 0, maxHp: 100 });
    expect(getHpPercent(c)).toBe(0);
  });

  it('maxHp 为 0 时应安全返回 0%', () => {
    const c = makeChar({ hp: 100, maxHp: 0 });
    expect(getHpPercent(c)).toBe(0);
  });

  it('四舍五入: 33/100 应为 33%', () => {
    const c = makeChar({ hp: 33, maxHp: 100 });
    expect(getHpPercent(c)).toBe(33);
  });

  it('四舍五入: 1/3 应为 33%', () => {
    const c = makeChar({ hp: 1, maxHp: 3 });
    expect(getHpPercent(c)).toBe(33);
  });
});

describe('getMpPercent', () => {
  it('满蓝应返回 100%', () => {
    const c = makeChar({ mp: 50, maxMp: 50 });
    expect(getMpPercent(c)).toBe(100);
  });

  it('maxMp 为 0 时应安全返回 0%', () => {
    const c = makeChar({ mp: 10, maxMp: 0 });
    expect(getMpPercent(c)).toBe(0);
  });
});

describe('getSpPercent', () => {
  it('满体应返回 100%', () => {
    const c = makeChar({ sp: 50, maxSp: 50 });
    expect(getSpPercent(c)).toBe(100);
  });

  it('maxSp 为 0 时应安全返回 0%', () => {
    const c = makeChar({ sp: 10, maxSp: 0 });
    expect(getSpPercent(c)).toBe(0);
  });
});

// ========== 状态判断 ==========

describe('isAlive', () => {
  it('hp > 0 应存活', () => {
    const c = makeChar({ hp: 1 });
    expect(isAlive(c)).toBe(true);
  });

  it('hp === 0 不应存活', () => {
    const c = makeChar({ hp: 0 });
    expect(isAlive(c)).toBe(false);
  });

  it('hp < 0 不应存活', () => {
    const c = makeChar({ hp: -10 });
    expect(isAlive(c)).toBe(false);
  });
});

describe('isUnconscious', () => {
  it('hp === 0 应昏迷', () => {
    const c = makeChar({ hp: 0 });
    expect(isUnconscious(c)).toBe(true);
  });

  it('hp > 0 不应昏迷', () => {
    const c = makeChar({ hp: 50 });
    expect(isUnconscious(c)).toBe(false);
  });
});

describe('isDead', () => {
  it('hp === 0 应判定死亡', () => {
    const c = makeChar({ hp: 0 });
    expect(isDead(c)).toBe(true);
  });

  it('hp < 0 应判定死亡', () => {
    const c = makeChar({ hp: -5 });
    expect(isDead(c)).toBe(true);
  });

  it('hp > 0 不应死亡', () => {
    const c = makeChar({ hp: 1 });
    expect(isDead(c)).toBe(false);
  });
});

describe('isFullHp', () => {
  it('hp >= maxHp 应满血', () => {
    const c = makeChar({ hp: 100, maxHp: 100 });
    expect(isFullHp(c)).toBe(true);
  });

  it('hp > maxHp(溢出) 也应满血', () => {
    const c = makeChar({ hp: 120, maxHp: 100 });
    expect(isFullHp(c)).toBe(true);
  });

  it('hp < maxHp 不应满血', () => {
    const c = makeChar({ hp: 99, maxHp: 100 });
    expect(isFullHp(c)).toBe(false);
  });
});

describe('isFullMp', () => {
  it('mp >= maxMp 应满蓝', () => {
    const c = makeChar({ mp: 50, maxMp: 50 });
    expect(isFullMp(c)).toBe(true);
  });

  it('mp < maxMp 不应满蓝', () => {
    const c = makeChar({ mp: 30, maxMp: 50 });
    expect(isFullMp(c)).toBe(false);
  });
});

describe('isExhausted', () => {
  it('sp <= 0 应力竭', () => {
    const c = makeChar({ sp: 0 });
    expect(isExhausted(c)).toBe(true);
  });

  it('sp < 0(异常溢出) 应力竭', () => {
    const c = makeChar({ sp: -5 });
    expect(isExhausted(c)).toBe(true);
  });

  it('sp > 0 不应力竭', () => {
    const c = makeChar({ sp: 10 });
    expect(isExhausted(c)).toBe(false);
  });
});

// ========== 可支付性 ==========

describe('canAffordHp', () => {
  it('hp > amount 应可支付', () => {
    const c = makeChar({ hp: 100 });
    expect(canAffordHp(c, 50)).toBe(true);
  });

  it('hp === amount 不可支付 (不能支付到 0)', () => {
    const c = makeChar({ hp: 50 });
    expect(canAffordHp(c, 50)).toBe(false);
  });

  it('hp < amount 不可支付', () => {
    const c = makeChar({ hp: 30 });
    expect(canAffordHp(c, 50)).toBe(false);
  });

  it('amount=0 可支付 (hp>0)', () => {
    const c = makeChar({ hp: 100 });
    expect(canAffordHp(c, 0)).toBe(true);
  });
});

describe('canAffordMp', () => {
  it('mp >= amount 应可支付', () => {
    const c = makeChar({ mp: 50, maxMp: 50 });
    expect(canAffordMp(c, 50)).toBe(true);
  });

  it('mp < amount 不可支付', () => {
    const c = makeChar({ mp: 20, maxMp: 50 });
    expect(canAffordMp(c, 50)).toBe(false);
  });
});

describe('canAffordSp', () => {
  it('sp >= amount 应可支付', () => {
    const c = makeChar({ sp: 50, maxSp: 50 });
    expect(canAffordSp(c, 30)).toBe(true);
  });

  it('sp < amount 不可支付', () => {
    const c = makeChar({ sp: 10, maxSp: 50 });
    expect(canAffordSp(c, 30)).toBe(false);
  });
});

describe('canAffordMoney', () => {
  it('money >= amount 应可支付', () => {
    const c = makeChar({ money: 100 });
    expect(canAffordMoney(c, 100)).toBe(true);
  });

  it('money < amount 不可支付', () => {
    const c = makeChar({ money: 50 });
    expect(canAffordMoney(c, 100)).toBe(false);
  });

  it('money=0 时不可支付非零金额', () => {
    const c = makeChar({ money: 0 });
    expect(canAffordMoney(c, 50)).toBe(false);
  });
});

// ========== 物品/技能/状态 ==========

/** 构造一个 InventoryItem 快速 fixture */
function mkItem(id: string, qty: number): InventoryItem {
  return { id, name: id, quantity: qty };
}

describe('hasItem', () => {
  it('物品存在且数量足够应返回 true', () => {
    const c = makeChar({ inventory: [mkItem('药水', 5)] });
    expect(hasItem(c, '药水', 3)).toBe(true);
  });

  it('物品存在但数量不足应返回 false', () => {
    const c = makeChar({ inventory: [mkItem('药水', 2)] });
    expect(hasItem(c, '药水', 5)).toBe(false);
  });

  it('物品不存在应返回 false', () => {
    const c = makeChar({ inventory: [mkItem('药水', 5)] });
    expect(hasItem(c, '剑', 1)).toBe(false);
  });

  it('默认数量为 1: 存在即可', () => {
    const c = makeChar({ inventory: [mkItem('药水', 1)] });
    expect(hasItem(c, '药水')).toBe(true);
  });

  it('空背包应返回 false', () => {
    const c = makeChar({ inventory: [] });
    expect(hasItem(c, '药水')).toBe(false);
  });
});

describe('hasSkill', () => {
  it('技能存在应返回 true', () => {
    const c = makeChar({ skills: [{ id: 'fireball', name: '火球术', description: '发射火球', type: 'active' } as Skill] });
    expect(hasSkill(c, 'fireball')).toBe(true);
  });

  it('技能不存在应返回 false', () => {
    const c = makeChar({ skills: [] });
    expect(hasSkill(c, 'heal')).toBe(false);
  });
});

describe('hasStatus', () => {
  it('状态效果存在 (按 id) 应返回 true', () => {
    const c = makeChar({
      statusEffects: [
        { id: 'poison', name: '中毒', description: '持续掉血', stacks: 3, remainingTime: 5, source: '毒蛇', category: '减益' as const, timeUnit: '回合' as const, effects: { hp_per_turn: -10 } } as StatusEffect,
      ],
    });
    expect(hasStatus(c, 'poison')).toBe(true);
  });

  it('状态效果存在 (按 name) 应返回 true', () => {
    const c = makeChar({
      statusEffects: [
        { id: 'poison', name: '中毒', description: '持续掉血', stacks: 3, remainingTime: 5, source: '毒蛇', category: '减益' as const, timeUnit: '回合' as const, effects: { hp_per_turn: -10 } } as StatusEffect,
      ],
    });
    expect(hasStatus(c, '中毒')).toBe(true);
  });

  it('状态效果不存在应返回 false', () => {
    const c = makeChar({ statusEffects: [] });
    expect(hasStatus(c, '麻痹')).toBe(false);
  });
});

// ========== 属性查询 ==========

describe('getAttribute', () => {
  it('已知属性应返回对应值', () => {
    const c = makeChar({ attributes: { str: 18, dex: 14, con: 16, int: 10, spi: 12 } });
    expect(getAttribute(c, 'str')).toBe(18);
    expect(getAttribute(c, 'dex')).toBe(14);
    expect(getAttribute(c, 'con')).toBe(16);
  });

  it('未知属性应返回 0', () => {
    const c = makeChar();
    expect(getAttribute(c, 'cha')).toBe(0);
    expect(getAttribute(c, 'luck')).toBe(0);
  });
});

describe('getTier', () => {
  it('应返回角色 tier', () => {
    const c = makeChar({ tier: 3, tierName: '精英' });
    expect(getTier(c)).toBe(3);
  });
});

describe('getLevel', () => {
  it('应返回角色等级', () => {
    const c = makeChar({ level: 5 });
    expect(getLevel(c)).toBe(5);
  });
});

describe('getAdventurerRank', () => {
  it('应返回冒险者等级字符串', () => {
    const c = makeChar({ adventurerRank: 'B' });
    expect(getAdventurerRank(c)).toBe('B');
  });

  it('默认应为 未评级', () => {
    const c = makeChar();
    expect(getAdventurerRank(c)).toBe('未评级');
  });
});

// ========== 经验值计算 ==========

describe('expToLevel', () => {
  it('Lv.1 → Lv.2 需要 100 经验', () => {
    // floor(100 * 1.5^0) = floor(100 * 1) = 100
    expect(expToLevel(1)).toBe(100);
  });

  it('Lv.5 → Lv.6 需要 506 经验', () => {
    // floor(100 * 1.5^4) = floor(100 * 5.0625) = 506
    expect(expToLevel(5)).toBe(506);
  });

  it('expToLevel 应单调递增', () => {
    let prev = expToLevel(1);
    for (let lv = 2; lv <= 25; lv++) {
      const curr = expToLevel(lv);
      expect(curr).toBeGreaterThan(prev);
      prev = curr;
    }
  });

  it('expToLevel 应始终为正整数', () => {
    for (let lv = 1; lv <= 25; lv++) {
      const val = expToLevel(lv);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThan(0);
    }
  });
});

describe('totalExpForLevel', () => {
  it('Lv.1 总经验应为 0 (未升级过)', () => {
    expect(totalExpForLevel(1)).toBe(0);
  });

  it('到达 Lv.5 总经验应为前4级之和', () => {
    const expected = expToLevel(1) + expToLevel(2) + expToLevel(3) + expToLevel(4);
    expect(totalExpForLevel(5)).toBe(expected);
  });

  it('totalExpForLevel 应单调递增', () => {
    let prev = totalExpForLevel(1);
    for (let lv = 2; lv <= 25; lv++) {
      const curr = totalExpForLevel(lv);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });

  it('Lv 0 边界: 循环不执行, 返回 0', () => {
    // level=0 时 for (i=1; i<0; i++) 不执行, 返回 0
    expect(totalExpForLevel(0)).toBe(0);
  });
});

describe('expFromMonster', () => {
  it('Tier 1, Lv.1 怪物经验', () => {
    // base = 1 * 25 = 25 → floor(25 * (1 + 1*0.1)) = floor(25 * 1.1) = 27
    expect(expFromMonster(1, 1)).toBe(27);
  });

  it('Tier 1, Lv.5 怪物经验', () => {
    // base = 1 * 25 = 25 → floor(25 * (1 + 5*0.1)) = floor(25 * 1.5) = 37
    expect(expFromMonster(1, 5)).toBe(37);
  });

  it('Tier 7, Lv.25 怪物经验 (高峰)', () => {
    // base = 7 * 25 = 175 → floor(175 * (1 + 25*0.1)) = floor(175 * 3.5) = 612
    expect(expFromMonster(7, 25)).toBe(612);
  });

  it('Tier 3, Lv.10 怪物经验', () => {
    // base = 3 * 25 = 75 → floor(75 * (1 + 10*0.1)) = floor(75 * 2.0) = 150
    expect(expFromMonster(3, 10)).toBe(150);
  });

  it('expFromMonster 随 tier 单调递增', () => {
    const prev = expFromMonster(1, 1);
    const next = expFromMonster(2, 1);
    expect(next).toBeGreaterThan(prev);
  });
});

// ========== queryResource ==========

describe('queryResource', () => {
  it('query=hp_percent 应返回 HP 百分比', () => {
    const c = makeChar({ name: '亚瑟', hp: 75, maxHp: 100 });
    const result = queryResource(c, { characterId: c.id, query: 'hp_percent' });
    expect(result.value).toBe(75);
    expect(result.description).toContain('亚瑟');
    expect(result.description).toContain('75/100');
    expect(result.description).toContain('75%');
    expect(result.characterId).toBe(c.id);
  });

  it('query=mp_percent 应返回 MP 百分比', () => {
    const c = makeChar({ name: '法师', mp: 25, maxMp: 50 });
    const result = queryResource(c, { characterId: c.id, query: 'mp_percent' });
    expect(result.value).toBe(50);
    expect(result.description).toContain('25/50');
  });

  it('query=sp_percent 应返回 SP 百分比', () => {
    const c = makeChar({ name: '游侠', sp: 10, maxSp: 50 });
    const result = queryResource(c, { characterId: c.id, query: 'sp_percent' });
    expect(result.value).toBe(20);
  });

  it('query=tier 应返回层级编号', () => {
    const c = makeChar({ tier: 2, tierName: '中坚' });
    const result = queryResource(c, { characterId: c.id, query: 'tier' });
    expect(result.value).toBe(2);
    expect(result.description).toContain('T2');
  });

  it('query=level 应返回等级', () => {
    const c = makeChar({ level: 7 });
    const result = queryResource(c, { characterId: c.id, query: 'level' });
    expect(result.value).toBe(7);
    expect(result.description).toContain('Lv.7');
  });

  it('query=stat 应返回指定属性值', () => {
    const c = makeChar({ attributes: { str: 15, dex: 12, con: 10, int: 8, spi: 14 } });
    const result = queryResource(c, { characterId: c.id, query: 'stat', params: { attr: 'spi' } });
    expect(result.value).toBe(14);
    expect(result.description).toContain('spi');
  });

  it('query=stat 不带 params 时默认 str', () => {
    const c = makeChar({ attributes: { str: 18, dex: 10, con: 10, int: 10, spi: 10 } });
    const result = queryResource(c, { characterId: c.id, query: 'stat' });
    expect(result.value).toBe(18);
  });

  it('query=can_afford 金额足够应返回 true', () => {
    const c = makeChar({ money: 500 });
    const result = queryResource(c, { characterId: c.id, query: 'can_afford', params: { amount: 300 } });
    expect(result.value).toBe(true);
    expect(result.description).toBe('可支付');
  });

  it('query=can_afford 金额不足应返回 false', () => {
    const c = makeChar({ money: 100 });
    const result = queryResource(c, { characterId: c.id, query: 'can_afford', params: { amount: 300 } });
    expect(result.value).toBe(false);
    expect(result.description).toBe('资金不足');
  });

  it('query=has_item 存在应返回 true', () => {
    const c = makeChar({ inventory: [mkItem('解毒剂', 3)] });
    const result = queryResource(c, { characterId: c.id, query: 'has_item', params: { itemId: '解毒剂' } });
    expect(result.value).toBe(true);
    expect(result.description).toBe('拥有');
  });

  it('query=has_item 不存在应返回 false', () => {
    const c = makeChar({ inventory: [] });
    const result = queryResource(c, { characterId: c.id, query: 'has_item', params: { itemId: '万能药' } });
    expect(result.value).toBe(false);
    expect(result.description).toBe('未拥有');
  });

  it('query=has_skill 已习得应返回 true', () => {
    const c = makeChar({ skills: [{ id: 'slash', name: '斩击', description: '基础攻击', type: 'active' } as Skill] });
    const result = queryResource(c, { characterId: c.id, query: 'has_skill', params: { skillId: 'slash' } });
    expect(result.value).toBe(true);
    expect(result.description).toBe('已习得');
  });

  it('query=has_skill 未习得应返回 false', () => {
    const c = makeChar({ skills: [] });
    const result = queryResource(c, { characterId: c.id, query: 'has_skill', params: { skillId: 'meteor' } });
    expect(result.value).toBe(false);
    expect(result.description).toBe('未习得');
  });

  it('query=has_status 已受影响应返回 true', () => {
    const c = makeChar({
      statusEffects: [
        { id: 'burn', name: '灼烧', description: '火焰伤害', stacks: 1, remainingTime: 3, source: '火龙', category: '减益' as const, timeUnit: '回合' as const, effects: {} } as StatusEffect,
      ],
    });
    const result = queryResource(c, { characterId: c.id, query: 'has_status', params: { statusName: '灼烧' } });
    expect(result.value).toBe(true);
    expect(result.description).toBe('已受影响');
  });

  it('query=has_status 未受影响应返回 false', () => {
    const c = makeChar({ statusEffects: [] });
    const result = queryResource(c, { characterId: c.id, query: 'has_status', params: { statusName: '冰冻' } });
    expect(result.value).toBe(false);
    expect(result.description).toBe('未受影响');
  });

  it('未知 query 应返回 value=0 且描述为 未知查询', () => {
    const c = makeChar();
    const result = queryResource(c, { characterId: c.id, query: 'nonexistent' as any });
    expect(result.value).toBe(0);
    expect(result.description).toBe('未知查询');
  });

  it('每次调用应生成新的 timestamp', async () => {
    const c = makeChar();
    const r1 = queryResource(c, { characterId: c.id, query: 'level' });
    // 延迟 1ms 确保时间戳不同
    await new Promise(r => setTimeout(r, 2));
    const r2 = queryResource(c, { characterId: c.id, query: 'level' });
    expect(r2.timestamp).toBeGreaterThan(r1.timestamp);
  });
});

// ========== $resource Namespace ==========

describe('$resource namespace', () => {
  const expectedMethods = [
    'getHpPercent',
    'getMpPercent',
    'getSpPercent',
    'isAlive',
    'isUnconscious',
    'isDead',
    'isFullHp',
    'isFullMp',
    'isExhausted',
    'canAffordHp',
    'canAffordMp',
    'canAffordSp',
    'canAffordMoney',
    'hasItem',
    'hasSkill',
    'hasStatus',
    'getAttribute',
    'getTier',
    'getLevel',
    'getAdventurerRank',
    'expToLevel',
    'totalExpForLevel',
    'expFromMonster',
    'queryResource',
  ];

  it('应包含所有 24 个方法', () => {
    expect(Object.keys($resource)).toHaveLength(expectedMethods.length);
  });

  for (const method of expectedMethods) {
    it(`应导出 ${method}`, () => {
      expect($resource).toHaveProperty(method);
      expect(typeof ($resource as any)[method]).toBe('function');
    });
  }

  it('$resource 中方法应与直接导出的函数行为一致', () => {
    const c = makeChar({ hp: 50, maxHp: 100 });
    expect($resource.getHpPercent(c)).toBe(getHpPercent(c));
    expect($resource.isAlive(c)).toBe(isAlive(c));
    expect($resource.getLevel(c)).toBe(getLevel(c));
    expect($resource.expToLevel(1)).toBe(expToLevel(1));
  });

  it('$resource 引用应稳定 (同一模块导出引用)', () => {
    // $resource 声明为 `as const` (编译期 readonly deep)。
    // 运行时验证: 每个方法在 API 对象上存在且类型为 function。
    for (const method of expectedMethods) {
      expect($resource).toHaveProperty(method);
      expect(typeof ($resource as Record<string, unknown>)[method]).toBe('function');
    }
  });
});
