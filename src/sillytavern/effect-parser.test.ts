/**
 * effect-parser.ts — 效果声明解析器纯函数测试 (Phase 4.6)
 */
import { describe, it, expect } from 'vitest';
import {
  parseEffectDeclaration,
  normalizeEffectKey,
  getEffectValue,
  sumEffectValues,
  $effect,
} from './effect-parser';

// ========== parseEffectDeclaration ==========

describe('parseEffectDeclaration', () => {
  // --- 基础解析 ---

  it('"攻击力: +50" 应解析为 {key:"atk", value:50}', () => {
    const result = parseEffectDeclaration('攻击力: +50');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'atk',
      rawKey: '攻击力',
      value: 50,
      isPercentage: false,
      isSubtractive: false,
    });
  });

  it('"DR: 5%" 应标记 isPercentage: true', () => {
    const result = parseEffectDeclaration('DR: 5%');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('dr');
    expect(result[0].value).toBe(5);
    expect(result[0].isPercentage).toBe(true);
  });

  it('"火焰抗性: +30" 应映射为 fireResist', () => {
    const result = parseEffectDeclaration('火焰抗性: +30');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('fireResist');
    expect(result[0].rawKey).toBe('火焰抗性');
    expect(result[0].value).toBe(30);
  });

  it('负值应标记 isSubtractive: true', () => {
    const result = parseEffectDeclaration('防御力: -10');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('def');
    expect(result[0].value).toBe(-10);
    expect(result[0].isSubtractive).toBe(true);
  });

  it('多效果以英文逗号分隔', () => {
    const result = parseEffectDeclaration('攻击力: +50, 防御力: +20, HP: +100');
    expect(result).toHaveLength(3);
    expect(result[0].key).toBe('atk');
    expect(result[1].key).toBe('def');
    expect(result[2].key).toBe('hp');
  });

  it('多效果以英文分号分隔', () => {
    const result = parseEffectDeclaration('力量: +5; 敏捷: +3; 体质: +4');
    expect(result).toHaveLength(3);
    expect(result[0].key).toBe('str');
    expect(result[1].key).toBe('dex');
    expect(result[2].key).toBe('con');
  });

  it('多效果以中文逗号分隔', () => {
    const result = parseEffectDeclaration('攻击力: +50，防御力: +20，HP: +100');
    expect(result).toHaveLength(3);
    expect(result[0].key).toBe('atk');
    expect(result[1].key).toBe('def');
    expect(result[2].key).toBe('hp');
  });

  it('多效果以中文分号分隔', () => {
    const result = parseEffectDeclaration('力量: +5；敏捷: +3；体质: +4');
    expect(result).toHaveLength(3);
    expect(result[0].key).toBe('str');
    expect(result[1].key).toBe('dex');
    expect(result[2].key).toBe('con');
  });

  it('混合分隔符', () => {
    const result = parseEffectDeclaration('攻击力: +50; DR: 5%, 火焰抗性: +30；冰霜抗性: -10');
    expect(result).toHaveLength(4);
    expect(result[0].key).toBe('atk');
    expect(result[1].key).toBe('dr');
    expect(result[2].key).toBe('fireResist');
    expect(result[3].key).toBe('iceResist');
    expect(result[3].isSubtractive).toBe(true);
  });

  it('空字符串应返回空数组', () => {
    expect(parseEffectDeclaration('')).toEqual([]);
    expect(parseEffectDeclaration('   ')).toEqual([]);
  });

  it('无有效键值对时返回空数组', () => {
    expect(parseEffectDeclaration('废话连篇')).toEqual([]);
  });

  // --- 未知键 ---

  it('未知中文键应保留为小写（空格转下划线）', () => {
    const result = parseEffectDeclaration('未知属性: +99');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('未知属性');
    expect(result[0].rawKey).toBe('未知属性');
    expect(result[0].value).toBe(99);
  });

  it('英文未知键应保留为小写', () => {
    const result = parseEffectDeclaration('someCustomStat: +42');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('somecustomstat');
    expect(result[0].rawKey).toBe('someCustomStat');
  });

  // --- 数值格式 ---

  it('无符号数值应视为正 (isSubtractive: false)', () => {
    const result = parseEffectDeclaration('攻击力: 50');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('atk');
    expect(result[0].value).toBe(50);
    expect(result[0].isSubtractive).toBe(false);
  });

  it('小数数值', () => {
    const result = parseEffectDeclaration('暴击率: +3.5%');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('critRate');
    expect(result[0].value).toBe(3.5);
    expect(result[0].isPercentage).toBe(true);
  });

  it('负小数', () => {
    const result = parseEffectDeclaration('移速: -2.5');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('moveSpeed');
    expect(result[0].value).toBe(-2.5);
    expect(result[0].isSubtractive).toBe(true);
  });

  // --- 空白处理 ---

  it('冒号前后无空格', () => {
    const result = parseEffectDeclaration('攻击力:+50');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('atk');
    expect(result[0].value).toBe(50);
  });

  it('键值两侧有多余空白', () => {
    const result = parseEffectDeclaration('  攻击力  :   +50  ');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('atk');
    expect(result[0].value).toBe(50);
  });

  it('含空白的效果段应被跳过', () => {
    const result = parseEffectDeclaration('攻击力: +50, , 防御力: +20');
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe('atk');
    expect(result[1].key).toBe('def');
  });

  // --- 各种映射键覆盖 ---

  it('HP 别名 生命值 应映射为 hp', () => {
    const result = parseEffectDeclaration('生命值: +200');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('hp');
  });

  it('伤害减免 应映射为 dr', () => {
    const result = parseEffectDeclaration('伤害减免: 10%');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('dr');
    expect(result[0].isPercentage).toBe(true);
  });

  it('经验加成 应映射为 expBonus', () => {
    const result = parseEffectDeclaration('经验加成: +25%');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('expBonus');
    expect(result[0].value).toBe(25);
    expect(result[0].isPercentage).toBe(true);
  });

  it('技能威力 应映射为 skillPower', () => {
    const result = parseEffectDeclaration('技能威力: +15');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('skillPower');
    expect(result[0].value).toBe(15);
  });

  it('HP恢复 应映射为 hpRegen', () => {
    const result = parseEffectDeclaration('HP恢复: +5');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('hpRegen');
  });

  it('生命恢复 别名 应映射为 hpRegen', () => {
    const result = parseEffectDeclaration('生命恢复: +5');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('hpRegen');
  });
});

// ========== normalizeEffectKey ==========

describe('normalizeEffectKey', () => {
  it('已知键 攻击力 → atk', () => {
    expect(normalizeEffectKey('攻击力')).toBe('atk');
  });

  it('已知键 DR → dr', () => {
    expect(normalizeEffectKey('DR')).toBe('dr');
  });

  it('已知键 暴击率 → critRate', () => {
    expect(normalizeEffectKey('暴击率')).toBe('critRate');
  });

  it('已知键 雷电抗性 → lightningResist', () => {
    expect(normalizeEffectKey('雷电抗性')).toBe('lightningResist');
  });

  it('已知键 冷却缩减 → cooldownReduction', () => {
    expect(normalizeEffectKey('冷却缩减')).toBe('cooldownReduction');
  });

  it('未知键返回小写（空格转下划线）', () => {
    expect(normalizeEffectKey('Some Custom Key')).toBe('some_custom_key');
  });

  it('完全未知的中文键返回自身小写', () => {
    expect(normalizeEffectKey('奇怪的属性')).toBe('奇怪的属性');
  });

  it('返回空字符串对于空输入', () => {
    // 空字符串不在映射表中，toLowerCase 后仍为空
    expect(normalizeEffectKey('')).toBe('');
  });
});

// ========== getEffectValue ==========

describe('getEffectValue', () => {
  const effects = [
    { key: 'atk', rawKey: '攻击力', value: 50, isPercentage: false, isSubtractive: false },
    { key: 'def', rawKey: '防御力', value: 20, isPercentage: false, isSubtractive: false },
    { key: 'hp', rawKey: 'HP', value: 100, isPercentage: false, isSubtractive: false },
  ];

  it('找到匹配 key 返回对应 value', () => {
    expect(getEffectValue(effects, 'atk')).toBe(50);
    expect(getEffectValue(effects, 'def')).toBe(20);
    expect(getEffectValue(effects, 'hp')).toBe(100);
  });

  it('找不到匹配 key 时返回默认值 0', () => {
    expect(getEffectValue(effects, 'spi')).toBe(0);
  });

  it('可指定自定义默认值', () => {
    expect(getEffectValue(effects, 'spi', 999)).toBe(999);
    expect(getEffectValue(effects, 'atk', 999)).toBe(50); // 找到时应忽略默认值
  });

  it('空效果列表返回默认值', () => {
    expect(getEffectValue([], 'atk')).toBe(0);
    expect(getEffectValue([], 'atk', 10)).toBe(10);
  });
});

// ========== sumEffectValues ==========

describe('sumEffectValues', () => {
  it('单个匹配直接返回值', () => {
    const effects = [{ key: 'atk', rawKey: '攻击力', value: 50, isPercentage: false, isSubtractive: false }];
    expect(sumEffectValues(effects, 'atk')).toBe(50);
  });

  it('多个同 key 求和', () => {
    const effects = [
      { key: 'atk', rawKey: '攻击力', value: 50, isPercentage: false, isSubtractive: false },
      { key: 'atk', rawKey: '攻击力', value: 30, isPercentage: false, isSubtractive: false },
      { key: 'def', rawKey: '防御力', value: 20, isPercentage: false, isSubtractive: false },
      { key: 'atk', rawKey: '攻击力', value: -10, isPercentage: false, isSubtractive: true },
    ];
    // 50 + 30 + (-10) = 70
    expect(sumEffectValues(effects, 'atk')).toBe(70);
  });

  it('混合正负值求和', () => {
    const effects = [
      { key: 'hp', rawKey: 'HP', value: 100, isPercentage: false, isSubtractive: false },
      { key: 'hp', rawKey: 'HP', value: -50, isPercentage: false, isSubtractive: true },
      { key: 'hp', rawKey: 'HP', value: 30, isPercentage: false, isSubtractive: false },
    ];
    expect(sumEffectValues(effects, 'hp')).toBe(80);
  });

  it('无匹配时应返回 0', () => {
    const effects = [{ key: 'atk', rawKey: '攻击力', value: 50, isPercentage: false, isSubtractive: false }];
    expect(sumEffectValues(effects, 'hp')).toBe(0);
  });

  it('空数组返回 0', () => {
    expect(sumEffectValues([], 'atk')).toBe(0);
  });
});

// ========== $effect Namespace ==========

describe('$effect namespace', () => {
  it('$effect.parse 等同于 parseEffectDeclaration', () => {
    expect($effect.parse).toBe(parseEffectDeclaration);
  });

  it('$effect.normalizeKey 等同于 normalizeEffectKey', () => {
    expect($effect.normalizeKey).toBe(normalizeEffectKey);
  });

  it('$effect.getValue 等同于 getEffectValue', () => {
    expect($effect.getValue).toBe(getEffectValue);
  });

  it('$effect.sumValues 等同于 sumEffectValues', () => {
    expect($effect.sumValues).toBe(sumEffectValues);
  });

  it('$effect.mapping 为只读的 CHINESE_TO_KEY 映射表引用', () => {
    expect($effect.mapping).toBeDefined();
    expect($effect.mapping['攻击力']).toBe('atk');
    expect($effect.mapping['火焰抗性']).toBe('fireResist');
  });

  it('$effect.parse 与直接调用 parseEffectDeclaration 结果一致', () => {
    const direct = parseEffectDeclaration('攻击力: +50, DR: 5%');
    const viaNS = $effect.parse('攻击力: +50, DR: 5%');
    expect(viaNS).toEqual(direct);
  });

  it('$effect.normalizeKey 与直接调用 normalizeEffectKey 结果一致', () => {
    expect($effect.normalizeKey('暴击伤害')).toBe(normalizeEffectKey('暴击伤害'));
  });

  it('$effect.getValue 与直接调用 getEffectValue 结果一致', () => {
    const effects = [{ key: 'atk', rawKey: '攻击力', value: 50, isPercentage: false, isSubtractive: false }];
    expect($effect.getValue(effects, 'atk')).toBe(50);
  });

  it('$effect.sumValues 与直接调用 sumEffectValues 结果一致', () => {
    const effects = [
      { key: 'hp', rawKey: 'HP', value: 30, isPercentage: false, isSubtractive: false },
      { key: 'hp', rawKey: 'HP', value: 20, isPercentage: false, isSubtractive: false },
    ];
    expect($effect.sumValues(effects, 'hp')).toBe(50);
  });
});
