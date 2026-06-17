/**
 * validate.ts — $validate 数值约束引擎测试
 *
 * Layer 1 纯函数: clamp / 校验 / 结果构造器。覆盖所有导出。
 */
import { describe, it, expect } from 'vitest';
import {
  clamp,
  clampHp,
  clampMp,
  clampSp,
  validateCharacterState,
  validateStatePatch,
  validateEquipment,
  validateSkill,
  validateItem,
  validateVarsPatch,
  validResult,
  errorResult,
  TIER_RANGE,
  LEVEL_RANGE,
  RESOURCE_MAX,
  ATTR_RANGE,
  MAX_STATUS_STACKS,
  IMPORTANCE_RANGE,
  MAX_INVENTORY_SIZE,
  $validate,
} from './validate';
import { createDefaultCharacterState } from './types';
import type {
  CharacterState,
  EquipmentSlot,
  Skill,
  InventoryItem,
  StatusEffect,
  StatePatch,
  VarsPatch,
} from './types';

// ========== 常量 ==========

describe('常量', () => {
  it('TIER_RANGE 应该是 min=1 max=7', () => {
    expect(TIER_RANGE).toEqual({ min: 1, max: 7 });
  });

  it('LEVEL_RANGE 应该是 min=1 max=25', () => {
    expect(LEVEL_RANGE).toEqual({ min: 1, max: 25 });
  });

  it('RESOURCE_MAX 应该是 99999', () => {
    expect(RESOURCE_MAX).toBe(99999);
  });

  it('ATTR_RANGE 应该是 min=1 max=20 (世界书硬上限)', () => {
    expect(ATTR_RANGE).toEqual({ min: 1, max: 20 });
  });

  it('MAX_STATUS_STACKS 应该是 99', () => {
    expect(MAX_STATUS_STACKS).toBe(99);
  });

  it('IMPORTANCE_RANGE 应该是 min=1 max=10', () => {
    expect(IMPORTANCE_RANGE).toEqual({ min: 1, max: 10 });
  });

  it('MAX_INVENTORY_SIZE 应该是 200', () => {
    expect(MAX_INVENTORY_SIZE).toBe(200);
  });
});

// ========== clamp ==========

describe('clamp', () => {
  it('正常值在范围内应原样返回', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('低于 min 时返回 min', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('高于 max 时返回 max', () => {
    expect(clamp(999, 0, 100)).toBe(100);
  });

  it('等于 min 时返回 min', () => {
    expect(clamp(0, 0, 100)).toBe(0);
  });

  it('等于 max 时返回 max', () => {
    expect(clamp(100, 0, 100)).toBe(100);
  });

  it('零范围 (min === max) 时总是返回该值', () => {
    expect(clamp(0, 5, 5)).toBe(5);
    expect(clamp(10, 5, 5)).toBe(5);
    expect(clamp(-3, 5, 5)).toBe(5);
  });
});

// ========== clampHp / clampMp / clampSp ==========

describe('clampHp', () => {
  it('正常 HP 原样返回', () => {
    expect(clampHp(50, 100)).toBe(50);
  });

  it('零 HP (死亡) 应返回 0', () => {
    expect(clampHp(0, 100)).toBe(0);
  });

  it('负 HP 应返回 0', () => {
    expect(clampHp(-5, 100)).toBe(0);
  });

  it('HP 超过 maxHp 应被截断到 maxHp', () => {
    expect(clampHp(200, 100)).toBe(100);
    expect(clampHp(150, 100)).toBe(100);
  });

  it('HP 超过 RESOURCE_MAX 且 maxHp 也超过时，应截断到 RESOURCE_MAX', () => {
    expect(clampHp(200000, 200000)).toBe(RESOURCE_MAX);
  });
});

describe('clampMp', () => {
  it('正常 MP 原样返回', () => {
    expect(clampMp(30, 50)).toBe(30);
  });

  it('负 MP 应返回 0', () => {
    expect(clampMp(-1, 50)).toBe(0);
  });

  it('MP 超过 maxMp 应被截断', () => {
    expect(clampMp(80, 50)).toBe(50);
  });
});

describe('clampSp', () => {
  it('正常 SP 原样返回', () => {
    expect(clampSp(25, 50)).toBe(25);
  });

  it('负 SP 应返回 0', () => {
    expect(clampSp(-1, 50)).toBe(0);
  });

  it('SP 超过 maxSp 应被截断', () => {
    expect(clampSp(80, 50)).toBe(50);
  });
});

// ========== validResult / errorResult ==========

describe('validResult / errorResult', () => {
  it('validResult 返回 valid=true 且 errors/warnings 为空', () => {
    const r = validResult();
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errorResult 返回 valid=false 且包含传入的错误消息', () => {
    const r = errorResult('参数无效');
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(['参数无效']);
    expect(r.warnings).toEqual([]);
  });
});

// ========== validateCharacterState ==========

describe('validateCharacterState', () => {
  it('有效的默认角色状态应通过校验', () => {
    const char = createDefaultCharacterState({ id: 'test-char-1' });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('缺少 id 应报错', () => {
    const char = createDefaultCharacterState({ id: '' });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('缺少 id');
  });

  it('tier 超出范围 (0 或 8) 应报错', () => {
    const c1 = createDefaultCharacterState({ id: 'c1', tier: 0 });
    expect(validateCharacterState(c1).valid).toBe(false);
    expect(validateCharacterState(c1).errors.some((e) => e.includes('tier'))).toBe(true);

    const c2 = createDefaultCharacterState({ id: 'c2', tier: 8 });
    expect(validateCharacterState(c2).valid).toBe(false);
    expect(validateCharacterState(c2).errors.some((e) => e.includes('tier'))).toBe(true);
  });

  it('level 超出范围应报错', () => {
    const char = createDefaultCharacterState({ id: 'c3', level: 0 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('level'))).toBe(true);
  });

  it('hp 为负应报 hp 溢出', () => {
    const char = createDefaultCharacterState({ id: 'c4', hp: -1 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('hp 溢出');
  });

  it('hp 超过 RESOURCE_MAX 应报 hp 溢出', () => {
    const char = createDefaultCharacterState({ id: 'c5', hp: RESOURCE_MAX + 1 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('hp 溢出');
  });

  it('hp > maxHp 应产生 warning', () => {
    const char = createDefaultCharacterState({ id: 'c6', hp: 50, maxHp: 40 });
    const r = validateCharacterState(char);
    expect(r.warnings.some((w) => w.includes('hp') && w.includes('maxHp'))).toBe(true);
  });

  it('mp 溢出应报错', () => {
    const char = createDefaultCharacterState({ id: 'c7', mp: -1 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('mp 溢出');
  });

  it('sp 溢出应报错', () => {
    const char = createDefaultCharacterState({ id: 'c8', sp: RESOURCE_MAX + 1 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('sp 溢出');
  });

  it('属性值超出 ATTR_RANGE 应报错', () => {
    const char = createDefaultCharacterState({
      id: 'c9',
      attributes: { str: 0, dex: 10, con: 10, int: 10, spi: 10 },
    });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('属性') && e.includes('str'))).toBe(true);
  });

  it('金钱为负应报错', () => {
    const char = createDefaultCharacterState({ id: 'c10', money: -100 });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('金钱'))).toBe(true);
  });

  it('状态效果层数超过 MAX_STATUS_STACKS 应报错', () => {
    const status: StatusEffect = {
      id: 'se1',
      name: '中毒',
      description: '每回合损失 HP',
      stacks: 100, // 超过 99
      remainingTime: 5,
      source: '毒蛇',
      category: '减益' as const,
      timeUnit: '回合' as const,
      effects: { hpDelta: -5 },
    };
    const char = createDefaultCharacterState({
      id: 'c11',
      statusEffects: [status],
    });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('层数') && e.includes('上限'))).toBe(true);
  });

  it('背包物品过多应产生 warning (非 error)', () => {
    const items: InventoryItem[] = Array.from({ length: MAX_INVENTORY_SIZE + 1 }, (_, i) => ({
      id: `item-${i}`,
      name: `物品${i}`,
      quantity: 1,
    }));
    const char = createDefaultCharacterState({ id: 'c12', inventory: items });
    const r = validateCharacterState(char);
    // 背包溢出是 warning 不是 error
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('背包'))).toBe(true);
  });

  it('name/race 为空时仅产生 warning 而非 error', () => {
    const char = createDefaultCharacterState({ id: 'c13', name: '', race: '' });
    const r = validateCharacterState(char);
    expect(r.valid).toBe(true);
    expect(r.warnings).toContain('角色名称为空');
    expect(r.warnings).toContain('种族为空');
  });
});

// ========== validateStatePatch ==========

describe('validateStatePatch', () => {
  it('缺少 op 应报错', () => {
    const patch = { target: 'characters.c1' } as unknown as StatePatch;
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('缺少 op');
  });

  it('缺少 target 应报错', () => {
    const patch = { op: 'set_hp' } as unknown as StatePatch;
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('缺少 target');
  });

  it('delta_hp amount 超过 RESOURCE_MAX 应报异常过大', () => {
    const patch: StatePatch = { op: 'delta_hp', target: 'characters.c1', amount: RESOURCE_MAX + 1 };
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('异常过大'))).toBe(true);
  });

  it('set_hp value 超过 RESOURCE_MAX 应报超出范围', () => {
    const patch: StatePatch = { op: 'set_hp', target: 'characters.c1', value: RESOURCE_MAX + 1 };
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('超出范围'))).toBe(true);
  });

  it('set_hp value 为负应报超出范围', () => {
    const patch: StatePatch = { op: 'set_hp', target: 'characters.c1', value: -5 };
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('超出范围'))).toBe(true);
  });

  it('正常的 delta_hp patch 应通过', () => {
    const patch: StatePatch = { op: 'delta_hp', target: 'characters.c1', amount: -50 };
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(true);
  });

  it('正常的 set_variable patch 应通过', () => {
    const patch: StatePatch = { op: 'set_variable', target: 'variables.test' };
    const r = validateStatePatch(patch);
    expect(r.valid).toBe(true);
  });
});

// ========== validateEquipment ==========

describe('validateEquipment', () => {
  it('有效装备通过校验', () => {
    const equip: EquipmentSlot = { slot: 'weapon', itemId: 'sword_01', name: '铁剑' };
    const r = validateEquipment(equip);
    expect(r.valid).toBe(true);
  });

  it('缺少 slot 应报错', () => {
    const equip = { itemId: 'sword_01', name: '铁剑' } as unknown as EquipmentSlot;
    const r = validateEquipment(equip);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('装备缺少 slot');
  });

  it('缺少 itemId 应报错', () => {
    const equip = { slot: 'weapon', name: '铁剑' } as unknown as EquipmentSlot;
    const r = validateEquipment(equip);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('装备缺少 itemId');
  });
});

// ========== validateSkill ==========

describe('validateSkill', () => {
  it('有效技能通过校验', () => {
    const skill: Skill = {
      id: 'sk1',
      name: '火球术',
      description: '发射一枚火球',
      type: 'active',
      cost: { type: 'MP', amount: 10 },
    };
    const r = validateSkill(skill);
    expect(r.valid).toBe(true);
  });

  it('缺少 id 应报错', () => {
    const skill = { name: '火球术', description: '', type: 'active' as const } as unknown as Skill;
    const r = validateSkill(skill);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('技能缺少 id');
  });

  it('缺少 name 应报错', () => {
    const skill = { id: 'sk1', description: '', type: 'active' as const } as unknown as Skill;
    const r = validateSkill(skill);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('技能缺少 name');
  });

  it('技能消耗为负应报错', () => {
    const skill: Skill = {
      id: 'sk1',
      name: '火球术',
      description: '',
      type: 'active',
      cost: { type: 'MP', amount: -5 },
    };
    const r = validateSkill(skill);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('消耗'))).toBe(true);
  });

  it('无 cost 的技能也应通过 (被动技能)', () => {
    const skill: Skill = {
      id: 'sk2',
      name: '钢铁意志',
      description: '被动提升防御',
      type: 'passive',
    };
    const r = validateSkill(skill);
    expect(r.valid).toBe(true);
  });
});

// ========== validateItem ==========

describe('validateItem', () => {
  it('有效物品通过校验', () => {
    const item: InventoryItem = { id: 'it1', name: '回复药', quantity: 3 };
    const r = validateItem(item);
    expect(r.valid).toBe(true);
  });

  it('缺少 id 应报错', () => {
    const item = { name: '回复药', quantity: 3 } as unknown as InventoryItem;
    const r = validateItem(item);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('物品缺少 id');
  });

  it('缺少 name 应报错', () => {
    const item = { id: 'it1', quantity: 3 } as unknown as InventoryItem;
    const r = validateItem(item);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('物品缺少 name');
  });

  it('数量为负应报错', () => {
    const item: InventoryItem = { id: 'it1', name: '回复药', quantity: -1 };
    const r = validateItem(item);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('数量为负'))).toBe(true);
  });

  it('数量为零应通过 (合法: 表示已用完但保留记录)', () => {
    const item: InventoryItem = { id: 'it1', name: '回复药', quantity: 0 };
    const r = validateItem(item);
    expect(r.valid).toBe(true);
  });
});

// ========== validateVarsPatch ==========

describe('validateVarsPatch', () => {
  it('空 VarsPatch 应通过', () => {
    const patch: VarsPatch = { merge: {} };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(true);
  });

  it('有效 delta 应通过', () => {
    const patch: VarsPatch = { merge: {}, delta: [{ path: 'user.gold', amount: 100 }] };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(true);
  });

  it('delta amount 不是数字应报错', () => {
    const patch: VarsPatch = {
      merge: {},
      delta: [{ path: 'user.gold', amount: '一百' as unknown as number }],
    };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('amount 不是数字'))).toBe(true);
  });

  it('delta amount 超过 1,000,000 应报异常过大', () => {
    const patch: VarsPatch = {
      merge: {},
      delta: [{ path: 'user.gold', amount: 2_000_000 }],
    };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('异常过大'))).toBe(true);
  });

  it('replace 缺少 value 应报错', () => {
    const patch: VarsPatch = {
      merge: {},
      replace: [{ path: 'user.name', value: undefined }],
    };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('缺少 value'))).toBe(true);
  });

  it('replace 有合法 value 应通过', () => {
    const patch: VarsPatch = {
      merge: {},
      replace: [{ path: 'user.name', value: 'Alice' }],
    };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(true);
  });

  it('delta amount 为 0 应通过', () => {
    const patch: VarsPatch = {
      merge: {},
      delta: [{ path: 'user.gold', amount: 0 }],
    };
    const r = validateVarsPatch(patch);
    expect(r.valid).toBe(true);
  });

  it('delta amount 恰好等于 1,000,000 应通过 (边界值)', () => {
    const patch: VarsPatch = {
      merge: {},
      delta: [{ path: 'user.gold', amount: 1_000_000 }],
    };
    const r = validateVarsPatch(patch);
    // amount 为 1,000,000 时 Math.abs 不大于 1,000,000，所以通过
    expect(r.valid).toBe(true);
  });
});

// ========== $validate namespace ==========

describe('$validate namespace', () => {
  it('应包含 clamp / clampHp / clampMp / clampSp', () => {
    expect($validate.clamp).toBe(clamp);
    expect($validate.clampHp).toBe(clampHp);
    expect($validate.clampMp).toBe(clampMp);
    expect($validate.clampSp).toBe(clampSp);
  });

  it('应包含所有常量', () => {
    expect($validate.TIER_RANGE).toBe(TIER_RANGE);
    expect($validate.LEVEL_RANGE).toBe(LEVEL_RANGE);
    expect($validate.RESOURCE_MAX).toBe(RESOURCE_MAX);
    expect($validate.ATTR_RANGE).toBe(ATTR_RANGE);
    expect($validate.MAX_STATUS_STACKS).toBe(MAX_STATUS_STACKS);
    expect($validate.MAX_INVENTORY_SIZE).toBe(MAX_INVENTORY_SIZE);
  });

  it('应包含所有校验函数', () => {
    expect($validate.validateCharacterState).toBe(validateCharacterState);
    expect($validate.validateStatePatch).toBe(validateStatePatch);
    expect($validate.validateEquipment).toBe(validateEquipment);
    expect($validate.validateSkill).toBe(validateSkill);
    expect($validate.validateItem).toBe(validateItem);
    expect($validate.validateVarsPatch).toBe(validateVarsPatch);
  });

  it('应包含 validResult / errorResult', () => {
    expect($validate.validResult).toBe(validResult);
    expect($validate.errorResult).toBe(errorResult);
  });
});
