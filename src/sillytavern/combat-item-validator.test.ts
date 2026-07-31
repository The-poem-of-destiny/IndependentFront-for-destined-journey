/**
 * combat-item-validator 测试 (M4 战斗 v2 · 任务 5.5a)
 *
 * 覆盖 §6.6 全部 4 条可测规则（#1 category / #2 五维铁律 / #3 buff sourceKey / #4 divinity）：
 *  - 6 类 modifier 各一个正例（返回空数组）
 *  - category 非法 / 各类缺必填字段 / 检定缺 attribute / 非检定改五维 / divinity 越界
 *  - buff 合规正例 / 缺 sourceKey / 缺必填字段 / category 非法 / divinity 越界
 *  - validateItemOutput 汇总（混合合规 + 违规）
 *
 * 对齐: docs/reference/combat-agent-api.md §6.1 / §6.2 / §6.3 / §6.6
 */
import { describe, it, expect } from 'vitest';
import { validateModifier, validateBuff, validateItemOutput } from './combat-item-validator';

// ═══════════════════════════════════════════════════════════
// validateModifier · 6 类正例
// ═══════════════════════════════════════════════════════════

describe('validateModifier · 6 类正例（合规返回空）', () => {
  it('固伤类合规', () => {
    const mod = { category: '固伤', source: '幽怨之剑', amount: 200, damageType: '物理' };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('百分比类合规', () => {
    const mod = { category: '百分比', source: '狂战戒指', coefficient: 0.2, target: 'damage' };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('资源类合规', () => {
    const mod = { category: '资源', source: '血瓶', resource: 'hp', amount: 500 };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('检定类合规（命中）', () => {
    const mod = { category: '检定', source: '准星护符', checkType: '命中', bonus: 5 };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('检定类合规（属性 + attribute）', () => {
    const mod = {
      category: '检定',
      source: '巨力腰带',
      checkType: '属性',
      attribute: 'str',
      bonus: 3,
    };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('附加效果类合规', () => {
    const mod = {
      category: '附加效果',
      source: '毒刃',
      buffName: '流血',
      sourceKey: '毒刃',
      stacks: 1,
      duration: 3,
      lifecycle: '战斗',
    };
    expect(validateModifier(mod)).toEqual([]);
  });

  it('特殊机制类合规', () => {
    const mod = { category: '特殊机制', source: '破甲锤', mechanism: '穿透', value: 20 };
    expect(validateModifier(mod)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// validateModifier · 反例（§6.6 #1 category + 各类缺必填）
// ═══════════════════════════════════════════════════════════

describe('validateModifier · category 与必填字段违规', () => {
  it('category 非法 → 违规', () => {
    const reasons = validateModifier({ category: '伤害', source: 'X', amount: 10 });
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((r) => r.includes('category') && r.includes('6 类'))).toBe(true);
  });

  it('category 缺失 → 违规', () => {
    const reasons = validateModifier({ source: 'X', amount: 10 });
    expect(reasons.some((r) => r.includes('category'))).toBe(true);
  });

  it('source 缺失 → 违规', () => {
    const reasons = validateModifier({ category: '固伤', amount: 10 });
    expect(reasons.some((r) => r.includes('source'))).toBe(true);
  });

  it('source 空字符串 → 违规', () => {
    const reasons = validateModifier({ category: '固伤', source: '   ', amount: 10 });
    expect(reasons.some((r) => r.includes('source'))).toBe(true);
  });

  it('固伤类缺 amount → 违规', () => {
    const reasons = validateModifier({ category: '固伤', source: 'X' });
    expect(reasons.some((r) => r.includes('amount'))).toBe(true);
  });

  it('百分比类缺 coefficient → 违规', () => {
    const reasons = validateModifier({ category: '百分比', source: 'X', target: 'damage' });
    expect(reasons.some((r) => r.includes('coefficient'))).toBe(true);
  });

  it('百分比类 target 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '百分比',
      source: 'X',
      coefficient: 0.2,
      target: 'attack',
    });
    expect(reasons.some((r) => r.includes('target'))).toBe(true);
  });

  it('资源类 resource 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '资源',
      source: 'X',
      resource: '体力',
      amount: 10,
    });
    expect(reasons.some((r) => r.includes('resource'))).toBe(true);
  });

  it('资源类缺 amount → 违规', () => {
    const reasons = validateModifier({ category: '资源', source: 'X', resource: 'hp' });
    expect(reasons.some((r) => r.includes('amount'))).toBe(true);
  });

  it('检定类 checkType 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '检定',
      source: 'X',
      checkType: '暴击',
      bonus: 5,
    });
    expect(reasons.some((r) => r.includes('checkType'))).toBe(true);
  });

  it('检定类 checkType=属性 但缺 attribute → 违规', () => {
    const reasons = validateModifier({
      category: '检定',
      source: 'X',
      checkType: '属性',
      bonus: 3,
    });
    expect(reasons.some((r) => r.includes('attribute') && r.includes('str'))).toBe(true);
  });

  it('检定类 attribute 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '检定',
      source: 'X',
      checkType: '属性',
      attribute: 'luck',
      bonus: 3,
    });
    expect(reasons.some((r) => r.includes('attribute'))).toBe(true);
  });

  it('检定类缺 bonus → 违规', () => {
    const reasons = validateModifier({
      category: '检定',
      source: 'X',
      checkType: '命中',
    });
    expect(reasons.some((r) => r.includes('bonus'))).toBe(true);
  });

  it('附加效果类缺 buffName → 违规', () => {
    const reasons = validateModifier({
      category: '附加效果',
      source: '毒刃',
      sourceKey: '毒刃',
    });
    expect(reasons.some((r) => r.includes('buffName'))).toBe(true);
  });

  it('附加效果类缺 sourceKey → 违规', () => {
    const reasons = validateModifier({
      category: '附加效果',
      source: '毒刃',
      buffName: '流血',
    });
    expect(reasons.some((r) => r.includes('sourceKey'))).toBe(true);
  });

  it('附加效果类 lifecycle 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '附加效果',
      source: '毒刃',
      buffName: '流血',
      sourceKey: '毒刃',
      lifecycle: '永久',
    });
    expect(reasons.some((r) => r.includes('lifecycle'))).toBe(true);
  });

  it('特殊机制类 mechanism 非法 → 违规', () => {
    const reasons = validateModifier({
      category: '特殊机制',
      source: 'X',
      mechanism: '无敌',
      value: 10,
    });
    expect(reasons.some((r) => r.includes('mechanism'))).toBe(true);
  });

  it('特殊机制类缺 value → 违规', () => {
    const reasons = validateModifier({
      category: '特殊机制',
      source: 'X',
      mechanism: 'DR',
    });
    expect(reasons.some((r) => r.includes('value'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// validateModifier · 五维铁律（§6.6 #2 / #265160）
// ═══════════════════════════════════════════════════════════

describe('validateModifier · 非检定类不得直接改五维（铁律）', () => {
  it('固伤类顶层含 str → 违规（五维只能走检定类）', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      str: 5,
    });
    expect(reasons.some((r) => r.includes('五维'))).toBe(true);
  });

  it('资源类 effects 含 dex → 违规', () => {
    const reasons = validateModifier({
      category: '资源',
      source: 'X',
      resource: 'hp',
      amount: 10,
      effects: { dex: 3 },
    });
    expect(reasons.some((r) => r.includes('五维'))).toBe(true);
  });

  it('附加效果类顶层含 "体" 别名 → 违规', () => {
    const reasons = validateModifier({
      category: '附加效果',
      source: 'X',
      buffName: '流血',
      sourceKey: 'X',
      体: 5,
    });
    expect(reasons.some((r) => r.includes('五维'))).toBe(true);
  });

  it('检定类含 str 字段 → 合规（检定类允许五维）', () => {
    const reasons = validateModifier({
      category: '检定',
      source: 'X',
      checkType: '属性',
      attribute: 'str',
      bonus: 3,
      str: 5,
    });
    // 检定类不触发五维铁律，仅校验必填字段；只要 category 合规就不该出现"五维"违规
    expect(reasons.some((r) => r.includes('五维'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// validateModifier · divinity（§6.2 / §6.6 #4）
// ═══════════════════════════════════════════════════════════

describe('validateModifier · divinity 校验', () => {
  it('divinity=0 合规（缺省普通）', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      divinity: 0,
    });
    expect(reasons.some((r) => r.includes('divinity'))).toBe(false);
  });

  it('divinity=8 合规（神国级上限）', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      divinity: 8,
    });
    expect(reasons.some((r) => r.includes('divinity'))).toBe(false);
  });

  it('divinity 缺省 → 合规（可选字段）', () => {
    const reasons = validateModifier({ category: '固伤', source: 'X', amount: 10 });
    expect(reasons.some((r) => r.includes('divinity'))).toBe(false);
  });

  it('divinity=9 越界 → 违规', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      divinity: 9,
    });
    expect(reasons.some((r) => r.includes('divinity') && r.includes('0-8'))).toBe(true);
  });

  it('divinity=-1 越界 → 违规', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      divinity: -1,
    });
    expect(reasons.some((r) => r.includes('divinity') && r.includes('0-8'))).toBe(true);
  });

  it('divinity=2.5 非整数 → 违规', () => {
    const reasons = validateModifier({
      category: '固伤',
      source: 'X',
      amount: 10,
      divinity: 2.5,
    });
    expect(reasons.some((r) => r.includes('divinity') && r.includes('整数'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// validateBuff · 正例 + 反例
// ═══════════════════════════════════════════════════════════

describe('validateBuff', () => {
  it('合规 buff（带 sourceKey）→ 空数组', () => {
    const buff = {
      name: '流血',
      description: '每回合失去5%生命值',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: '魔法-毒刃;净化',
      sourceKey: '毒刃',
      effects: { dotPercent: 0.05 },
    };
    expect(validateBuff(buff)).toEqual([]);
  });

  it('合规永久 buff（remainingTime=null）', () => {
    const buff = {
      name: '光环',
      description: '范围内队友攻击+10%',
      category: '增益',
      stacks: 1,
      remainingTime: null,
      timeUnit: '回合',
      source: '光环-圣骑士;离开范围',
      sourceKey: '圣骑士光环',
      effects: { atkPercent: 0.1 },
    };
    expect(validateBuff(buff)).toEqual([]);
  });

  it('缺 sourceKey → 违规（AI buff 必须带前缀）', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: '魔法-X;净化',
      effects: {},
    };
    const reasons = validateBuff(buff);
    expect(reasons.some((r) => r.includes('sourceKey'))).toBe(true);
  });

  it('sourceKey 空字符串 → 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: '   ',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('sourceKey'))).toBe(true);
  });

  it('缺 name → 违规', () => {
    const buff = {
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('name'))).toBe(true);
  });

  it('缺 description → 违规', () => {
    const buff = {
      name: '流血',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('description'))).toBe(true);
  });

  it('category 非法 → 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '中性',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('category'))).toBe(true);
  });

  it('stacks 非数字 → 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: '两层',
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('stacks'))).toBe(true);
  });

  it('remainingTime 非法（字符串）→ 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: '永久',
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('remainingTime'))).toBe(true);
  });

  it('timeUnit 非法 → 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '秒',
      source: 'x',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('timeUnit'))).toBe(true);
  });

  it('缺 source → 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      sourceKey: 'X',
      effects: {},
    };
    expect(validateBuff(buff).some((r) => r.includes('source'))).toBe(true);
  });

  it('effects 非对象（字符串）→ 违规', () => {
    const buff = {
      name: '流血',
      description: 'x',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: 'x',
      sourceKey: 'X',
      effects: '攻击+5',
    };
    expect(validateBuff(buff).some((r) => r.includes('effects'))).toBe(true);
  });

  it('divinity=9 越界 → 违规', () => {
    const buff = {
      name: '神罚',
      description: 'x',
      category: '特殊',
      stacks: 1,
      remainingTime: null,
      timeUnit: '回合',
      source: '神-X;无',
      sourceKey: 'X',
      effects: {},
      divinity: 9,
    };
    expect(validateBuff(buff).some((r) => r.includes('divinity') && r.includes('0-8'))).toBe(true);
  });

  it('divinity=7 合规（神位级）', () => {
    const buff = {
      name: '神罚',
      description: 'x',
      category: '特殊',
      stacks: 1,
      remainingTime: null,
      timeUnit: '回合',
      source: '神-X;无',
      sourceKey: 'X',
      effects: {},
      divinity: 7,
    };
    expect(validateBuff(buff).some((r) => r.includes('divinity'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// validateItemOutput · 汇总
// ═══════════════════════════════════════════════════════════

describe('validateItemOutput · 汇总', () => {
  it('全合规 → valid=true，错误数组全空', () => {
    const result = validateItemOutput({
      modifiers: [
        { category: '固伤', source: '剑', amount: 100 },
        { category: '检定', source: '符', checkType: '命中', bonus: 3 },
      ],
      buffs: [
        {
          name: '流血',
          description: 'x',
          category: '减益',
          stacks: 1,
          remainingTime: 3,
          timeUnit: '回合',
          source: '魔法-剑;净化',
          sourceKey: '剑',
          effects: {},
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.modifierErrors).toEqual([[], []]);
    expect(result.buffErrors).toEqual([[]]);
  });

  it('混合：1 个合规 modifier + 1 个违规 modifier + 1 个违规 buff → valid=false', () => {
    const result = validateItemOutput({
      modifiers: [
        { category: '固伤', source: '剑', amount: 100 }, // 合规
        { category: '百分比', source: '戒', coefficient: 0.2 }, // 缺 target 违规
      ],
      buffs: [
        {
          // 缺 sourceKey 违规
          name: '流血',
          description: 'x',
          category: '减益',
          stacks: 1,
          remainingTime: 3,
          timeUnit: '回合',
          source: 'x',
          effects: {},
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.modifierErrors[0]).toEqual([]);
    expect(result.modifierErrors[1].some((r) => r.includes('target'))).toBe(true);
    expect(result.buffErrors[0].some((r) => r.includes('sourceKey'))).toBe(true);
  });

  it('空入参（无 modifiers/buffs）→ valid=true（nothing to validate）', () => {
    const result = validateItemOutput({});
    expect(result.valid).toBe(true);
    expect(result.modifierErrors).toEqual([]);
    expect(result.buffErrors).toEqual([]);
  });

  it('modifiers/buffs 为空数组 → valid=true', () => {
    const result = validateItemOutput({ modifiers: [], buffs: [] });
    expect(result.valid).toBe(true);
  });

  it('非对象 modifier（字符串）→ 该条违规', () => {
    const result = validateItemOutput({ modifiers: ['不是对象'] });
    expect(result.valid).toBe(false);
    expect(result.modifierErrors[0].some((r) => r.includes('对象'))).toBe(true);
  });
});
