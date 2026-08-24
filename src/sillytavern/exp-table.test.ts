/**
 * exp-table.ts — 经验表 / 升级判定 / 登神飞升 / 模式系数表 测试（经验系统改造 v1，2026-08-24）
 *
 * 语义对齐参考脚本（config/index.ts 的 LevelXpTable + services/experience.ts 的
 * processExperienceAndLevel + 主人裁定的登神放宽版）。
 */
import { describe, it, expect } from 'vitest';
import {
  LEVEL_XP_TABLE,
  EXP_MAX_NUMBER,
  MILESTONE_LEVELS,
  getRequiredXpForLevel,
  isMaxLevel,
  getTierForLevel,
  tierNameForTier,
  xpToNextNumber,
  canPassAscensionGate,
  resolveLevelUps,
  resolveAscensionFlyup,
  getExperienceCoefficient,
  applyExpFloor,
  EXPERIENCE_COEFFICIENTS,
  type LevelUpInput,
  type AscensionFlyupInput,
} from './exp-table';

// ========== 累计经验表 ==========

describe('LEVEL_XP_TABLE', () => {
  it('应覆盖 0-25 全部等级', () => {
    for (let lv = 0; lv <= 25; lv++) {
      expect(LEVEL_XP_TABLE).toHaveProperty(String(lv));
    }
  });

  it('关键数值应对齐脚本 LevelXpTable', () => {
    expect(LEVEL_XP_TABLE[0]).toBe(0);
    expect(LEVEL_XP_TABLE[1]).toBe(120);
    expect(LEVEL_XP_TABLE[2]).toBe(360);
    expect(LEVEL_XP_TABLE[12]).toBe(28440);
    expect(LEVEL_XP_TABLE[13]).toBe(38840);
    expect(LEVEL_XP_TABLE[17]).toBe(100340);
    expect(LEVEL_XP_TABLE[21]).toBe(236240);
    expect(LEVEL_XP_TABLE[24]).toBe(401840);
    expect(LEVEL_XP_TABLE[25]).toBe('MAX');
  });

  it('累计门槛应严格单调递增（1-24）', () => {
    let prev = -1;
    for (let lv = 1; lv < 25; lv++) {
      const v = getRequiredXpForLevel(lv);
      expect(typeof v).toBe('number');
      expect(v as number).toBeGreaterThan(prev);
      prev = v as number;
    }
  });
});

describe('getRequiredXpForLevel', () => {
  it('Lv1=120 / Lv2=360', () => {
    expect(getRequiredXpForLevel(1)).toBe(120);
    expect(getRequiredXpForLevel(2)).toBe(360);
  });

  it('Lv25 → MAX', () => {
    expect(getRequiredXpForLevel(25)).toBe('MAX');
  });

  it('越界（26 / -1）→ MAX', () => {
    expect(getRequiredXpForLevel(26)).toBe('MAX');
    expect(getRequiredXpForLevel(-1)).toBe('MAX');
  });

  it('Lv0 → 0（占位，防御性读取）', () => {
    expect(getRequiredXpForLevel(0)).toBe(0);
  });
});

describe('isMaxLevel / xpToNextNumber', () => {
  it('isMaxLevel 只在 >= 25 时成立', () => {
    expect(isMaxLevel(24)).toBe(false);
    expect(isMaxLevel(25)).toBe(true);
    expect(isMaxLevel(26)).toBe(true);
    expect(isMaxLevel(1)).toBe(false);
  });

  it('xpToNextNumber 把 MAX 转成哨兵 EXP_MAX_NUMBER', () => {
    expect(xpToNextNumber(1)).toBe(120);
    expect(xpToNextNumber(25)).toBe(EXP_MAX_NUMBER);
    expect(EXP_MAX_NUMBER).toBe(999999);
  });
});

// ========== 层级 ==========

describe('getTierForLevel / tierNameForTier', () => {
  it('等级区间 → 层级（对齐 TIER_CONFIGS.levelRange）', () => {
    expect(getTierForLevel(1)).toBe(1);
    expect(getTierForLevel(4)).toBe(1);
    expect(getTierForLevel(5)).toBe(2);
    expect(getTierForLevel(9)).toBe(3);
    expect(getTierForLevel(13)).toBe(4);
    expect(getTierForLevel(17)).toBe(5);
    expect(getTierForLevel(21)).toBe(6);
    expect(getTierForLevel(25)).toBe(7);
  });

  it('tierNameForTier 对齐 TIER_CONFIGS.name', () => {
    expect(tierNameForTier(1)).toBe('普通');
    expect(tierNameForTier(4)).toBe('史诗');
    expect(tierNameForTier(7)).toBe('神祗');
  });

  it('tierNameForTier 越界兜底 "普通"', () => {
    expect(tierNameForTier(0)).toBe('普通');
    expect(tierNameForTier(8)).toBe('普通');
  });

  it('MILESTONE_LEVELS 覆盖 5/9/13/17/21/25', () => {
    for (const lv of [5, 9, 13, 17, 21, 25]) {
      expect(MILESTONE_LEVELS[lv]).toBeDefined();
    }
    expect(MILESTONE_LEVELS[13]).toEqual({ attributeBonus: 1, tier: 4 });
  });
});

// ========== 升级判定（resolveLevelUps） ==========

function makeLevelInput(overrides: Partial<LevelUpInput> = {}): LevelUpInput {
  return {
    level: 1,
    totalExp: 0,
    expToNext: 120,
    freeAttrPoints: 0,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    tier: 1,
    tierName: '普通',
    ascension: { elements: [], authority: [], law: [], deityPosition: '' },
    ...overrides,
  };
}

describe('resolveLevelUps —— 升级循环', () => {
  it('totalExp 未达门槛 → 原样返回，不升级', () => {
    const res = resolveLevelUps(makeLevelInput({ totalExp: 100 }));
    expect(res.level).toBe(1);
    expect(res.levelsGained).toBe(0);
    expect(res.freeAttrPoints).toBe(0);
    expect(res.ascensionBlocked).toBe(false);
  });

  it('Lv1 totalExp=120 → 升到 Lv2，expToNext=360，+1 自由点', () => {
    const res = resolveLevelUps(makeLevelInput({ level: 1, totalExp: 120 }));
    expect(res.level).toBe(2);
    expect(res.expToNext).toBe(360);
    expect(res.freeAttrPoints).toBe(1);
    expect(res.levelsGained).toBe(1);
    // totalExp 永不清空
    expect(res.totalExp).toBe(120);
  });

  it('经验溢出跨多级连升（totalExp=1200 从 Lv1 直冲 Lv4）', () => {
    const res = resolveLevelUps(makeLevelInput({ level: 1, totalExp: 1200 }));
    // 1200 >= 120 → Lv2；>= 360 → Lv3；>= 720 → Lv4；1200 < 1200? 1200 >= 1200 → Lv5?
    // Lv4 门槛=1200，1200>=1200 → 还会升到 Lv5（门槛 2400 > 1200 停）。
    expect(res.level).toBe(5);
    expect(res.freeAttrPoints).toBe(4);
    expect(res.levelsGained).toBe(4);
  });

  it('里程碑 5 级：全属性 +1 且 tier 提升到 2（中坚）', () => {
    const res = resolveLevelUps(
      makeLevelInput({
        level: 4,
        // Lv4 门槛=1200，Lv5 门槛=2400 —— 2399 只够升到 5（若 2400 会继续升 6）
        totalExp: 2399,
        attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
      }),
    );
    expect(res.level).toBe(5);
    expect(res.tier).toBe(2);
    expect(res.tierName).toBe('中坚');
    expect(res.attributes).toEqual({ str: 6, dex: 6, con: 6, int: 6, spi: 6 });
    // 4→5 这一级 +1 自由点
    expect(res.freeAttrPoints).toBe(1);
  });

  it('满级（25）不再升级', () => {
    const res = resolveLevelUps(
      makeLevelInput({ level: 25, totalExp: 9999999, expToNext: EXP_MAX_NUMBER }),
    );
    expect(res.level).toBe(25);
    expect(res.levelsGained).toBe(0);
    expect(res.freeAttrPoints).toBe(0);
  });

  it('关键等级 12 无要素 → ascensionBlocked，totalExp 截断到 12 级门槛', () => {
    const res = resolveLevelUps(makeLevelInput({ level: 12, totalExp: 99999, expToNext: 28440 }));
    expect(res.ascensionBlocked).toBe(true);
    expect(res.level).toBe(12);
    expect(res.totalExp).toBe(28440); // 截断到当前级门槛
  });

  it('关键等级 12 有要素 → 放行升级到 13', () => {
    const res = resolveLevelUps(
      makeLevelInput({
        level: 12,
        totalExp: 28440,
        expToNext: 28440,
        ascension: {
          elements: [{ name: '火', description: '' }],
          authority: [],
          law: [],
          deityPosition: '',
        },
      }),
    );
    expect(res.ascensionBlocked).toBe(false);
    expect(res.level).toBe(13);
    expect(res.expToNext).toBe(38840);
  });
});

// ========== 登神门槛（canPassAscensionGate） ==========

describe('canPassAscensionGate', () => {
  it('Lv12 需要素；Lv16 需权能；Lv20 需法则；Lv24 需神位', () => {
    const empty = { elements: [], authority: [], law: [], deityPosition: '' };
    expect(canPassAscensionGate(12, empty)).toBe(false);
    expect(canPassAscensionGate(12, { ...empty, elements: [{}] })).toBe(true);
    expect(canPassAscensionGate(16, { ...empty, authority: [{}] })).toBe(true);
    expect(canPassAscensionGate(16, empty)).toBe(false);
    expect(canPassAscensionGate(20, { ...empty, law: [{}] })).toBe(true);
    expect(canPassAscensionGate(24, { ...empty, deityPosition: '晨曦神位' })).toBe(true);
    expect(canPassAscensionGate(24, empty)).toBe(false);
  });

  it('非关键等级恒放行', () => {
    const empty = { elements: [], authority: [], law: [], deityPosition: '' };
    for (const lv of [1, 5, 10, 13, 18, 23]) {
      expect(canPassAscensionGate(lv, empty)).toBe(true);
    }
  });
});

// ========== 登神飞升（resolveAscensionFlyup，放宽版） ==========

function flyupInput(overrides: Partial<AscensionFlyupInput> = {}): AscensionFlyupInput {
  return {
    level: 1,
    ascension: { elements: [], authority: [], law: [], deityPosition: '' },
    ...overrides,
  };
}

describe('resolveAscensionFlyup —— 持物即飞升 + 层级-1 硬性限制', () => {
  it('无任何登神物 → 不飞升', () => {
    expect(resolveAscensionFlyup(flyupInput({ level: 12 }))).toEqual({ flyup: false });
  });

  it('T3（Lv12）持要素 → 飞升 T4 升到 13', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 12,
        ascension: { elements: [{}], authority: [], law: [], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(true);
    expect(res.nextLevel).toBe(13);
    expect(res.nextTier).toBe(4);
  });

  it('T2（Lv8）持要素 → 层级不足，不触发（硬性限制）', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 8,
        ascension: { elements: [{}], authority: [], law: [], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(false);
    expect(res.reason).toBe('层级不足');
  });

  it('T4 持权能 → 飞升 T5 升到 17', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 13,
        ascension: { elements: [], authority: [{}], law: [], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(true);
    expect(res.nextLevel).toBe(17);
    expect(res.nextTier).toBe(5);
  });

  it('T5 持法则 → 飞升 T6 升到 21', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 17,
        ascension: { elements: [], authority: [], law: [{}], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(true);
    expect(res.nextLevel).toBe(21);
    expect(res.nextTier).toBe(6);
  });

  it('T6 持神位 → 飞升 T7 升到 25', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 21,
        ascension: { elements: [], authority: [], law: [], deityPosition: '晨曦神位' },
      }),
    );
    expect(res.flyup).toBe(true);
    expect(res.nextLevel).toBe(25);
    expect(res.nextTier).toBe(7);
  });

  it('同时持多个登神物 → 取最高目标（神位 > 法则 > 权能 > 要素）', () => {
    // T5（Lv17）既有权能又有法则 → 法则（T6）胜出
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 17,
        ascension: { elements: [{}], authority: [{}], law: [{}], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(true);
    expect(res.nextLevel).toBe(21);
    expect(res.nextTier).toBe(6);
  });

  it('已超过目标层级（T4 但只有要素）→ 不飞升', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 15,
        ascension: { elements: [{}], authority: [], law: [], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(false);
  });

  it('T6 持法则（法则目标是 T6）→ 层级不足（法则只能从 T5 飞）', () => {
    const res = resolveAscensionFlyup(
      flyupInput({
        level: 22,
        ascension: { elements: [], authority: [], law: [{}], deityPosition: '' },
      }),
    );
    expect(res.flyup).toBe(false);
    expect(res.reason).toBe('层级不足');
  });
});

// ========== 模式系数表（简单/普通分档） ==========

describe('EXPERIENCE_COEFFICIENTS / getExperienceCoefficient', () => {
  it('normal = 世界书 [经验值获取规则] 层级系数', () => {
    expect(EXPERIENCE_COEFFICIENTS.normal).toEqual([10, 20, 50, 100, 250, 600]);
  });

  it('easy = 主人裁定方案 B 系数', () => {
    expect(EXPERIENCE_COEFFICIENTS.easy).toEqual([20, 36, 76, 130, 260, 500]);
  });

  it('normal 各 tier 系数', () => {
    expect(getExperienceCoefficient('normal', 1)).toBe(10);
    expect(getExperienceCoefficient('normal', 3)).toBe(50);
    expect(getExperienceCoefficient('normal', 6)).toBe(600);
  });

  it('easy 各 tier 系数（一层 2 倍、二层 1.8 倍、三层 ~1.5 倍）', () => {
    expect(getExperienceCoefficient('easy', 1)).toBe(20);
    expect(getExperienceCoefficient('easy', 2)).toBe(36);
    expect(getExperienceCoefficient('easy', 3)).toBe(76);
    expect(getExperienceCoefficient('easy', 6)).toBe(500);
  });

  it('T7（满级）clamp 到最后一档', () => {
    expect(getExperienceCoefficient('normal', 7)).toBe(600);
    expect(getExperienceCoefficient('easy', 7)).toBe(500);
  });

  it('越界 tier / 缺省 mode 兜底', () => {
    expect(getExperienceCoefficient(undefined, 1)).toBe(10);
    expect(getExperienceCoefficient(undefined as never, 0)).toBe(10);
    expect(getExperienceCoefficient('normal', 0)).toBe(10);
  });

  it('easy 一层约为 normal 的 2 倍、二层 1.8 倍', () => {
    expect(getExperienceCoefficient('easy', 1) / getExperienceCoefficient('normal', 1)).toBe(2);
    expect(
      Math.round(
        (getExperienceCoefficient('easy', 2) / getExperienceCoefficient('normal', 2)) * 10,
      ),
    ).toBe(18);
  });
});

// ========== 旧档经验保底归一化（applyExpFloor，方案 A） ==========

describe('applyExpFloor（旧档经验保底归一化，方案 A）', () => {
  it('旧档 Lv5 totalExp=2 → 抬到 1200（升到 5 级门槛），expToNext 重算 2400', () => {
    const char = { level: 5, totalExp: 2, expToNext: 1000 };
    const { changed } = applyExpFloor(char);
    expect(changed).toBe(true);
    expect(char.totalExp).toBe(1200);
    expect(char.expToNext).toBe(2400);
  });

  it('正常新语义存档 → 原地不变、changed=false（幂等，不炸正常档）', () => {
    const char = { level: 5, totalExp: 2000, expToNext: 2400 };
    const { changed } = applyExpFloor(char);
    expect(changed).toBe(false);
    expect(char).toEqual({ level: 5, totalExp: 2000, expToNext: 2400 });
  });

  it('Lv1 新档（totalExp 0 / expToNext 120）→ 不变', () => {
    const char = { level: 1, totalExp: 0, expToNext: 120 };
    expect(applyExpFloor(char).changed).toBe(false);
    expect(char.totalExp).toBe(0);
  });

  it('Lv1 旧档 expToNext=100 → 仅 expToNext 抬到 120，totalExp 保持 0', () => {
    const char = { level: 1, totalExp: 0, expToNext: 100 };
    expect(applyExpFloor(char).changed).toBe(true);
    expect(char.totalExp).toBe(0);
    expect(char.expToNext).toBe(120);
  });

  it('高等级但经验极低（脏档 Lv10 totalExp=0）→ 抬到 Lv9 门槛 11940', () => {
    const char = { level: 10, totalExp: 0, expToNext: 1000 };
    expect(applyExpFloor(char).changed).toBe(true);
    expect(char.totalExp).toBe(11940); // LevelXpTable[9]（升到 Lv10 的门槛）
    expect(char.expToNext).toBe(16940); // LevelXpTable[10]
  });

  it('满级 Lv25（totalExp 足够）→ 不变', () => {
    const char = { level: 25, totalExp: 500000, expToNext: 999999 };
    expect(applyExpFloor(char).changed).toBe(false);
    expect(char).toEqual({ level: 25, totalExp: 500000, expToNext: 999999 });
  });

  it('只抬不平：totalExp 已高于门槛绝不削减', () => {
    const char = { level: 3, totalExp: 3000, expToNext: 100 };
    expect(applyExpFloor(char).changed).toBe(true); // 仅 expToNext 变
    expect(char.totalExp).toBe(3000); // 3000 > 720，不动
    expect(char.expToNext).toBe(720);
  });
});
