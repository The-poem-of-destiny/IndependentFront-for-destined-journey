/**
 * combat-intention.ts 测试
 * 覆盖: 关键词解析 / 意图配置 / 意图判定 / 层级压制 / 失能/处决 / 非致死
 */
import { describe, it, expect } from 'vitest';
import {
  parseIntentionFromInput,
  getIntentionConfig,
  resolveIntention,
  checkNonLethal,
  isClusterIntentionBlocked,
} from './combat-intention';

// ========== 关键词解析 ==========

describe('parseIntentionFromInput', () => {
  it('空输入返回常规', () => {
    expect(parseIntentionFromInput('')).toBe('常规');
    expect(parseIntentionFromInput('   ')).toBe('常规');
  });

  it('模糊描述返回常规', () => {
    expect(parseIntentionFromInput('砍向敌人')).toBe('常规');
    expect(parseIntentionFromInput('全力攻击')).toBe('常规');
    expect(parseIntentionFromInput('奋力一击')).toBe('常规');
  });

  it('明确部位 → 战术', () => {
    expect(parseIntentionFromInput('瞄准眼睛刺去')).toBe('战术');
    expect(parseIntentionFromInput('攻击关节要害')).toBe('战术');
    expect(parseIntentionFromInput('射向喉咙')).toBe('战术');
  });

  it('超凡概念 → 核心', () => {
    expect(parseIntentionFromInput('攻击魔力回路')).toBe('核心');
    expect(parseIntentionFromInput('破坏权能节点')).toBe('核心');
    expect(parseIntentionFromInput('摧毁法则具象')).toBe('核心');
  });

  it('抹杀描述 → 抹杀', () => {
    expect(parseIntentionFromInput('斩首')).toBe('抹杀');
    expect(parseIntentionFromInput('粉碎心脏')).toBe('抹杀');
    expect(parseIntentionFromInput('贯穿要害')).toBe('抹杀');
  });

  it('概念攻击 → 概念', () => {
    expect(parseIntentionFromInput('湮灭目标')).toBe('概念');
    expect(parseIntentionFromInput('吞噬灵魂')).toBe('概念');
    expect(parseIntentionFromInput('概念抹消')).toBe('概念');
  });

  it('非致死声明', () => {
    expect(parseIntentionFromInput('打晕他')).toBe('非致死');
    expect(parseIntentionFromInput('活捉敌人')).toBe('非致死');
    expect(parseIntentionFromInput('不要杀死，制服即可')).toBe('非致死');
  });
});

// ========== 意图配置 ==========

describe('getIntentionConfig', () => {
  it('常规: 无需检定，系数 1.0', () => {
    const cfg = getIntentionConfig('常规');
    expect(cfg.level).toBe('常规');
    expect(cfg.coefficient).toBe(1.0);
    expect(cfg.requiresContest).toBe(false);
    expect(cfg.triggersExtraEffects).toBe(false);
  });

  it('战术: 需要检定，难度 3，系数 1.2', () => {
    const cfg = getIntentionConfig('战术');
    expect(cfg.difficulty).toBe(3);
    expect(cfg.coefficient).toBe(1.2);
    expect(cfg.requiresContest).toBe(true);
  });

  it('机能: 难度 5，系数 1.05，触发额外效果 (对齐世界书)', () => {
    const cfg = getIntentionConfig('机能');
    expect(cfg.difficulty).toBe(5);
    expect(cfg.coefficient).toBe(1.05);
    expect(cfg.triggersExtraEffects).toBe(true);
  });

  it('概念: 难度 20，系数 1.6 (对齐世界书)', () => {
    const cfg = getIntentionConfig('概念');
    expect(cfg.difficulty).toBe(20);
    expect(cfg.coefficient).toBe(1.6);
  });

  it('未知意图回退到常规', () => {
    const cfg = getIntentionConfig('不存在' as any);
    expect(cfg.level).toBe('常规');
  });
});

// ========== 意图判定 ==========

describe('resolveIntention', () => {
  const baseInput = {
    attackerTier: 3,
    defenderTier: 3,
    defenderIncapacitated: false,
    isExecutionIntent: false,
    nonLethal: false,
    attackerD20: 12,
    defenderD20: 8,
  };

  it('常规意图 → 无需判定，系数 1.0', () => {
    const result = resolveIntention({ ...baseInput, intentionLevel: '常规' });
    expect(result.verdict).toBe('无需判定');
    expect(result.coefficient).toBe(1.0);
    expect(result.extraEffects).toHaveLength(0);
  });

  it('非致死意图 → 无需判定', () => {
    const result = resolveIntention({ ...baseInput, intentionLevel: '非致死' });
    expect(result.verdict).toBe('无需判定');
  });

  it('战术意图 → 对抗检定 (攻方T×5+d20 vs 守方T×5+d20+3)', () => {
    const result = resolveIntention({ ...baseInput, intentionLevel: '战术' });
    // 攻方: 3×5+12=27, 守方: 3×5+8+3=26 → 成功
    expect(result.verdict).toBe('成功');
    expect(result.coefficient).toBe(1.2);
    expect(result.contested).toBeDefined();
    expect(result.contested!.attackerValue).toBe(27);
    expect(result.contested!.defenderValue).toBe(26);
  });

  it('战术意图失败: 攻方骰运差', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '战术',
      attackerD20: 3, // 3×5+3=18, vs 3×5+8+3=26 → 失败
    });
    expect(result.verdict).toBe('失败');
    expect(result.coefficient).toBe(1.0); // 重置为 1.0
    expect(result.extraEffects).toHaveLength(0);
  });

  it('概念意图高难度', () => {
    // 攻方 T5, 守方 T3: 5×5+15=40 vs 3×5+5+20=40 → 成功(平局)
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '概念',
      attackerTier: 5,
      defenderTier: 3,
      attackerD20: 15,
      defenderD20: 5,
    });
    expect(result.verdict).toBe('成功');
    expect(result.coefficient).toBe(1.6); // 概念系数 (世界书 1.6)
    expect(result.contested!.attackerValue).toBe(40);
    expect(result.contested!.defenderValue).toBe(40);
  });

  it('层级压制: 攻方 T1 < 守方 T4 → 强制无效', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '抹杀',
      attackerTier: 1,
      defenderTier: 4,
    });
    expect(result.verdict).toBe('强制无效');
    expect(result.coefficient).toBe(1.0);
    expect(result.narrativeNote).toContain('层级压制');
  });

  it('层级压制不触发: 攻方 T2 vs 守方 T3 (差距=1)', () => {
    // T2 < T3-1? T3-1=2, T2≮T2 → 不触发压制
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '战术',
      attackerTier: 2,
      defenderTier: 3,
    });
    expect(result.verdict).not.toBe('强制无效');
  });

  it('失能目标 → 自动成功', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '核心',
      defenderIncapacitated: true,
    });
    expect(result.verdict).toBe('自动成功');
    expect(result.coefficient).toBe(1.2); // 核心系数 (世界书 1.2)
  });

  it('处决目标 → 自动成功 (战意动摇)', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '处决',
      isExecutionIntent: true,
      defenderMorale: 'shaken',
    });
    expect(result.verdict).toBe('自动成功');
    expect(result.coefficient).toBe(1.3); // 处决系数 (世界书保底暴击 1.3)
    expect(result.narrativeNote).toContain('评级保底为暴击');
  });

  it('处决目标 → 自动成功 (战意崩溃)', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '处决',
      isExecutionIntent: true,
      defenderMorale: 'routing',
    });
    expect(result.verdict).toBe('自动成功');
  });

  it('处决目标不触发 (士气稳定)', () => {
    const result = resolveIntention({
      ...baseInput,
      intentionLevel: '处决',
      isExecutionIntent: true,
      defenderMorale: 'steady',
    });
    // 没有战意动摇 → 走正常对抗检定
    expect(result.verdict).not.toBe('自动成功');
  });
});

// ========== 非致死判定 ==========

describe('checkNonLethal', () => {
  it('非致死未声明 → 正常结算', () => {
    const result = checkNonLethal({
      nonLethal: false,
      ratingCoefficient: 1.0,
      finalDamage: 50,
      currentHp: 30,
    });
    expect(result.applied).toBe(false);
    expect(result.adjustedHp).toBe(0); // HP 归零 (不低于0)
    expect(result.accidentalKill).toBe(false);
  });

  it('非致死 + 有效评级 → HP 锁定为 1 + 昏迷', () => {
    const result = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 1.0, // 有效
      finalDamage: 50,
      currentHp: 30,
    });
    expect(result.applied).toBe(true);
    expect(result.adjustedHp).toBe(1);
    expect(result.unconscious).toBe(true);
    expect(result.accidentalKill).toBe(false);
  });

  it('非致死 + 勉强评级 → HP 锁定为 1 + 昏迷', () => {
    const result = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 0.8, // 勉强
      finalDamage: 30,
      currentHp: 10,
    });
    expect(result.adjustedHp).toBe(1);
    expect(result.unconscious).toBe(true);
  });

  it('非致死 + 暴击 → 失手致死', () => {
    const result = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 1.3, // 暴击
      finalDamage: 30,
      currentHp: 20,
    });
    expect(result.accidentalKill).toBe(true);
    expect(result.adjustedHp).toBe(0);
    expect(result.unconscious).toBe(false);
  });

  it('非致死 + 强暴击 → 失手致死', () => {
    const result = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 1.6,
      finalDamage: 40,
      currentHp: 30,
    });
    expect(result.accidentalKill).toBe(true);
  });

  it('非致死但伤害不致死 → 正常结算', () => {
    const result = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 1.0,
      finalDamage: 10,
      currentHp: 50,
    });
    expect(result.applied).toBe(false);
    expect(result.adjustedHp).toBe(40);
    expect(result.accidentalKill).toBe(false);
  });
});

// ========== 集群意图限制 ==========

describe('isClusterIntentionBlocked', () => {
  it('集群目标阻止意图/部位攻击', () => {
    expect(isClusterIntentionBlocked(true)).toBe(true);
    expect(isClusterIntentionBlocked(false)).toBe(false);
  });
});
