/**
 * tier-constants.ts — Layer 2 生命层级常量 & 计算公式 测试 (Phase 5)
 * 数值对齐世界书 #417617 [核心数值表]
 */
import { describe, it, expect } from 'vitest';
import {
  TIER_CONFIGS,
  getTierConfig,
  calcResources,
  calcExpToNext,
  totalExpForLevel,
  calcAttributePoints,
  getTierQualityCap,
  getCombatCoefficient,
  canBreakthrough,
} from './tier-constants';

// ========== TIER_CONFIGS 结构 ==========

describe('TIER_CONFIGS', () => {
  it('应有 7 个层级条目', () => {
    expect(TIER_CONFIGS).toHaveLength(7);
  });

  it('tier 编号应从 1 到 7 顺序排列', () => {
    TIER_CONFIGS.forEach((cfg, i) => {
      expect(cfg.tier).toBe(i + 1);
    });
  });

  it('每个条目的名称应正确', () => {
    const expectedNames = ['普通', '中坚', '精英', '史诗', '传说', '神话', '神祗'];
    TIER_CONFIGS.forEach((cfg, i) => {
      expect(cfg.name).toBe(expectedNames[i]);
    });
  });

  it('每个条目应包含所有必需的 TierConfig 字段', () => {
    const requiredKeys = [
      'tier', 'name', 'levelRange', 'hpMultiplier', 'mpMultiplier',
      'spMultiplier', 'combatCoefficient', 'expCap', 'qualityCap',
      'populationWeight', 'attributeCap',
    ];
    TIER_CONFIGS.forEach((cfg) => {
      for (const key of requiredKeys) {
        expect(cfg).toHaveProperty(key);
      }
    });
  });

  it('每个 tier 的 levelRange 应为二元组且 lower <= upper', () => {
    TIER_CONFIGS.forEach((cfg) => {
      expect(cfg.levelRange).toHaveLength(2);
      expect(cfg.levelRange[0]).toBeLessThanOrEqual(cfg.levelRange[1]);
    });
  });

  it('属性上限应遵循世界书硬上限 20 (仅 T7 可达)', () => {
    expect(TIER_CONFIGS[0].attributeCap).toBe(8);
    expect(TIER_CONFIGS[6].attributeCap).toBe(20);
    TIER_CONFIGS.forEach((cfg) => {
      expect(cfg.attributeCap).toBeLessThanOrEqual(20);
    });
  });

  it('HP乘数应匹配世界书 [1,2,4,10,20,40,100]', () => {
    const expected = [1, 2, 4, 10, 20, 40, 100];
    TIER_CONFIGS.forEach((cfg, i) => {
      expect(cfg.hpMultiplier).toBe(expected[i]);
    });
  });

  it('战斗系数应匹配世界书 [2.0,2.8,4.0,8.0,15.0,35.0,80.0]', () => {
    const expected = [2.0, 2.8, 4.0, 8.0, 15.0, 35.0, 80.0];
    TIER_CONFIGS.forEach((cfg, i) => {
      expect(cfg.combatCoefficient).toBe(expected[i]);
    });
  });
});

// ========== getTierConfig 查询 ==========

describe('getTierConfig', () => {
  it('有效 tier 应返回正确的 TierConfig', () => {
    const cfg = getTierConfig(1);
    expect(cfg).toBeDefined();
    expect(cfg!.name).toBe('普通');
    expect(cfg!.tier).toBe(1);
    expect(cfg!.hpMultiplier).toBe(1);
  });

  it('tier=0 应返回 undefined', () => {
    expect(getTierConfig(0)).toBeUndefined();
  });

  it('tier=8 (超出范围) 应返回 undefined', () => {
    expect(getTierConfig(8)).toBeUndefined();
  });

  it('tier=-1 (负数) 应返回 undefined', () => {
    expect(getTierConfig(-1)).toBeUndefined();
  });
});

// ========== calcResources 资源计算（世界书公式） ==========

describe('calcResources', () => {
  it('T1, 全属性 10（五维和 50）→ HP=1050, MP=1000, SP=1000', () => {
    // HP = 10×100×1 + 50 = 1050
    // MP = (10+10)×50×1 = 1000
    // SP = (10+10)×50×1 = 1000
    const result = calcResources(1, { str: 10, dex: 10, con: 10, int: 10, spi: 10 });
    expect(result.hp).toBe(1050);
    expect(result.mp).toBe(1000);
    expect(result.sp).toBe(1000);
  });

  it('T3, str8/dex9/con6/int9/spi10（五维和 42）→ HP=2442, MP=5700, SP=5100', () => {
    // HP = 6×100×4 + 42 = 2442
    // MP = (9+10)×50×6 = 5700
    // SP = (8+9)×50×6 = 5100
    const result = calcResources(3, { str: 8, dex: 9, con: 6, int: 9, spi: 10 });
    expect(result.hp).toBe(2442);
    expect(result.mp).toBe(5700);
    expect(result.sp).toBe(5100);
  });

  it('T2, str6/dex6/con8/int9/spi5（五维和 34）→ HP=1634, MP=1750, SP=1500', () => {
    // HP = 8×100×2 + 34 = 1634
    // MP = (9+5)×50×2.5 = 1750
    // SP = (6+6)×50×2.5 = 1500
    const result = calcResources(2, { str: 6, dex: 6, con: 8, int: 9, spi: 5 });
    expect(result.hp).toBe(1634);
    expect(result.mp).toBe(1750);
    expect(result.sp).toBe(1500);
  });

  it('无效 tier (99 或 0) 应返回兜底值 {hp:100, maxHp:100, mp:50, maxMp:50, sp:50, maxSp:50}', () => {
    expect(calcResources(99, { str: 10, dex: 10, con: 10, int: 10, spi: 10 })).toEqual({ hp: 100, maxHp: 100, mp: 50, maxMp: 50, sp: 50, maxSp: 50 });
    expect(calcResources(0, { str: 10, dex: 10, con: 10, int: 10, spi: 10 })).toEqual({ hp: 100, maxHp: 100, mp: 50, maxMp: 50, sp: 50, maxSp: 50 });
  });

  it('T7, 极限属性 20（五维和 100）→ HP=200100, MP=320000, SP=320000', () => {
    // HP = 20×100×100 + 100 = 200100
    // MP = (20+20)×50×160 = 320000
    // SP = (20+20)×50×160 = 320000
    const result = calcResources(7, { str: 20, dex: 20, con: 20, int: 20, spi: 20 });
    expect(result.hp).toBe(200100);
    expect(result.mp).toBe(320000);
    expect(result.sp).toBe(320000);
  });
});

// ========== calcExpToNext 升级经验 ==========

describe('calcExpToNext', () => {
  it('level=1 → floor(100 × 1.5^0) = 100', () => {
    expect(calcExpToNext(1)).toBe(100);
  });

  it('level=5 → floor(100 × 1.5^4) = floor(506.25) = 506', () => {
    expect(calcExpToNext(5)).toBe(506);
  });

  it('应单调递增: 1 到 25 级每级所需经验只增不减', () => {
    let prev = calcExpToNext(1);
    for (let lv = 2; lv <= 25; lv++) {
      const curr = calcExpToNext(lv);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });

  it('结果应始终为正整数', () => {
    for (let lv = 1; lv <= 25; lv++) {
      const val = calcExpToNext(lv);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThan(0);
    }
  });

  it('tier 参数不影响计算 (当前实现忽略 _tier)', () => {
    expect(calcExpToNext(1, 1)).toBe(calcExpToNext(1));
    expect(calcExpToNext(1, 7)).toBe(calcExpToNext(1));
  });
});

// ========== totalExpForLevel 总经验值 ==========

describe('totalExpForLevel', () => {
  it('level=1 总经验应为 0 (无升级)', () => {
    expect(totalExpForLevel(1)).toBe(0);
  });

  it('level=0 边界: 循环不执行, 返回 0', () => {
    expect(totalExpForLevel(0)).toBe(0);
  });

  it('level=5 → 前 4 级 exp 之和', () => {
    const expected = calcExpToNext(1) + calcExpToNext(2) + calcExpToNext(3) + calcExpToNext(4);
    // 100 + 150 + 225 + 337 = 812
    expect(totalExpForLevel(5)).toBe(expected);
  });

  it('level=5 具体值应为 812', () => {
    // 100 + 150 + 225 + 337 = 812
    expect(totalExpForLevel(5)).toBe(812);
  });

  it('应单调非递减', () => {
    let prev = totalExpForLevel(1);
    for (let lv = 2; lv <= 25; lv++) {
      const curr = totalExpForLevel(lv);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });
});

// ========== calcAttributePoints 属性点数 ==========

describe('calcAttributePoints', () => {
  it('level 1-4 (T1) 应返回 5 点', () => {
    for (let lv = 1; lv <= 4; lv++) {
      expect(calcAttributePoints(lv)).toBe(5);
    }
  });

  it('level 5-8 (T2) 应返回 4 点', () => {
    for (let lv = 5; lv <= 8; lv++) {
      expect(calcAttributePoints(lv)).toBe(4);
    }
  });

  it('level 9-12 (T3) 应返回 3 点', () => {
    for (let lv = 9; lv <= 12; lv++) {
      expect(calcAttributePoints(lv)).toBe(3);
    }
  });

  it('level 13-20 (T4-T5) 应返回 2 点', () => {
    for (let lv = 13; lv <= 20; lv++) {
      expect(calcAttributePoints(lv)).toBe(2);
    }
  });

  it('level >= 21 (T6-T7) 应返回 1 点', () => {
    for (let lv = 21; lv <= 25; lv++) {
      expect(calcAttributePoints(lv)).toBe(1);
    }
  });
});

// ========== getTierQualityCap 品质上限 ==========

describe('getTierQualityCap', () => {
  it('T1 品质上限应为 "优良"', () => {
    expect(getTierQualityCap(1)).toBe('优良');
  });

  it('T2 品质上限应为 "稀有"', () => {
    expect(getTierQualityCap(2)).toBe('稀有');
  });

  it('T3 品质上限应为 "史诗"', () => {
    expect(getTierQualityCap(3)).toBe('史诗');
  });

  it('T4 品质上限应为 "传说"', () => {
    expect(getTierQualityCap(4)).toBe('传说');
  });

  it('T5 品质上限应为 "神话"', () => {
    expect(getTierQualityCap(5)).toBe('神话');
  });

  it('T6 品质上限应为 "唯一"', () => {
    expect(getTierQualityCap(6)).toBe('唯一');
  });

  it('T7 品质上限应为 "唯一"', () => {
    expect(getTierQualityCap(7)).toBe('唯一');
  });

  it('无效 tier 应返回默认值 "优良"', () => {
    expect(getTierQualityCap(0)).toBe('优良');
    expect(getTierQualityCap(99)).toBe('优良');
  });
});

// ========== getCombatCoefficient 战斗系数 ==========

describe('getCombatCoefficient', () => {
  it('T1 应返回 2.0', () => {
    expect(getCombatCoefficient(1)).toBe(2.0);
  });

  it('T7 应返回 80.0', () => {
    expect(getCombatCoefficient(7)).toBe(80.0);
  });

  it('中间层级系数应单调递增', () => {
    const coeffs = [1, 2, 3, 4, 5, 6, 7].map(t => getCombatCoefficient(t));
    for (let i = 1; i < coeffs.length; i++) {
      expect(coeffs[i]).toBeGreaterThan(coeffs[i - 1]);
    }
  });

  it('无效 tier 应返回默认值 2.0', () => {
    expect(getCombatCoefficient(0)).toBe(2.0);
    expect(getCombatCoefficient(-1)).toBe(2.0);
  });
});

// ========== canBreakthrough 层级突破校验 ==========

describe('canBreakthrough', () => {
  it('目标层级不高于当前层级 (同层) 应拒绝', () => {
    const result = canBreakthrough(4, 1, 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('目标层级不高于当前层级');
  });

  it('目标层级低于当前层级应拒绝', () => {
    const result = canBreakthrough(4, 2, 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('目标层级不高于当前层级');
  });

  it('等级不足 (未达到当前层级满级) 应拒绝', () => {
    // T1 levelRange=[1,4], 满级=4. currentLevel=3 < 4, 不应突破到 T2
    const result = canBreakthrough(3, 1, 2, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('需要达到当前层级满级');
    expect(result.reason).toContain('Lv.4');
  });

  it('等级足够且低层突破 (T1→T2) 应允许', () => {
    // T1 满级=4, currentLevel=4 满足条件, T2<4 不需要登神要素
    const result = canBreakthrough(4, 1, 2, 0);
    expect(result.allowed).toBe(true);
  });

  it('T4+ 突破需要登神要素, 不足时应拒绝', () => {
    // T3→T4: targetTier=4, 需要 ascensionElements >= min(3, 4-3)=1
    // T3 满级=12, currentLevel=12 满足等级条件, 但 ascensionElements=0 < 1
    const result = canBreakthrough(12, 3, 4, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('需要更多登神要素');
  });

  it('T4+ 突破登神要素足够时应允许', () => {
    // T3→T4: 需要 ascensionElements >= 1
    const result = canBreakthrough(12, 3, 4, 1);
    expect(result.allowed).toBe(true);
  });

  it('高层突破需要更多登神要素 (T5→T6 需 3 个)', () => {
    // T5→T6: targetTier=6, min(3, 6-3)=3, 需要 ascensionElements >= 3
    const resultInsufficient = canBreakthrough(20, 5, 6, 2);
    expect(resultInsufficient.allowed).toBe(false);
    expect(resultInsufficient.reason).toContain('需要更多登神要素');

    const resultSufficient = canBreakthrough(20, 5, 6, 3);
    expect(resultSufficient.allowed).toBe(true);
  });

  it('无效目标层级应拒绝', () => {
    const result = canBreakthrough(25, 7, 8, 99);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('无效的目标层级');
  });

  it('T2→T3 (目标<4) 不需要登神要素即可突破', () => {
    // T2 满级=8, currentLevel=8 满足等级条件, targetTier=3<4 不需要登神要素
    const result = canBreakthrough(8, 2, 3, 0);
    expect(result.allowed).toBe(true);
  });
});
