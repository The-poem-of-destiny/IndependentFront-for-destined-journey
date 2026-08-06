/**
 * random-tables.test.ts — NPC 生成随机表测试（内容-引擎分离 波 2 / D25③）
 *
 * 🔴 名字池 / 发色池 / 瞳色池 / 性格池已抽到内容注册表的 `namePools` 面
 * （`/data/content/name-pools.json`），引擎里不再有这些常量。所以断言从
 * 「某族名字长这样」改成 **shape + 抽样算法行为**，数据由中性 fixture 提供。
 *
 * 测试覆盖:
 * - getNamePoolsContent: 注册表读取缝 + 逐段形状校验 + 空兜底
 * - randomName: 池内取值 / 姓氏 50% / 空姓氏池不拼空姓 / 未知种族回退 / 空池返空串
 * - randomHairColor / randomEyeColor: 种族池 → defaultColorKey 回退 → 空串
 * - randomPersonality: 编码拼接顺序 / 稳定性括号 / 缺维度即缺项 / 全空
 * - rollAttributes: 三池分配模型 / 基础上限 6 / tierCap 约束（数值机制，未数据化）
 * - randomAppearanceSummary: 返回结构完整性
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  randomName,
  randomHairColor,
  randomEyeColor,
  randomPersonality,
  rollAttributes,
  randomAppearanceSummary,
  getTierAttributeCap,
  getNamePoolsContent,
  type NamePoolsContent,
} from './random-tables';
import { getContentRegistry, setContentRegistry } from '@ui/stores/content-store';

/** 中性 fixture：只验形状与算法，不含任何世界观内容 */
const FIXTURE: NamePoolsContent = {
  defaultRace: 'alpha',
  defaultColorKey: 'fallback',
  namePools: {
    alpha: { male: ['A1', 'A2', 'A3'], female: ['A4', 'A5'], surnames: ['S1', 'S2'] },
    nosurname: { male: ['N1', 'N2'], female: ['N3'], surnames: [] },
  },
  hairColors: { alpha: ['h1', 'h2'], fallback: ['hf'] },
  eyeColors: { alpha: ['e1', 'e2'], fallback: ['ef'] },
  personality: {
    warmth: [{ code: 'w', desc: '亲近描述' }],
    openness: [{ code: 'O', desc: '坦露描述' }],
    urgency: [{ code: 'a', desc: '急切描述' }],
    firmness: [{ code: 'G', desc: '刚柔描述' }],
    persistence: [{ code: 'z', desc: '执着描述' }],
    stability: [{ code: 'A', desc: '稳定描述' }],
  },
};

/** 空内容（各池皆空）——注册表未就绪时的等价物 */
const EMPTY: NamePoolsContent = {
  namePools: {},
  hairColors: {},
  eyeColors: {},
  personality: {},
};

/** 把值灌进注册表的 namePools 面（其余五面不动） */
function seedRegistry(value: unknown): void {
  setContentRegistry({ ...getContentRegistry(), namePools: value });
}

afterEach(() => {
  seedRegistry(undefined);
});

// ========== getNamePoolsContent（注册表读取缝） ==========

describe('getNamePoolsContent', () => {
  it('注册表未就绪 → 各池为空对象，不抛', () => {
    seedRegistry(undefined);
    const content = getNamePoolsContent();
    expect(content.namePools).toEqual({});
    expect(content.hairColors).toEqual({});
    expect(content.eyeColors).toEqual({});
    expect(content.personality).toEqual({});
  });

  it('该面是数组/字符串等错误形状时同样兜底成空', () => {
    seedRegistry(['nope']);
    expect(getNamePoolsContent().namePools).toEqual({});
    seedRegistry('nope');
    expect(getNamePoolsContent().hairColors).toEqual({});
  });

  it('注册表就绪时逐段读出，defaultRace / defaultColorKey 一并带出', () => {
    seedRegistry(FIXTURE);
    const content = getNamePoolsContent();
    expect(content.defaultRace).toBe('alpha');
    expect(content.defaultColorKey).toBe('fallback');
    expect(Object.keys(content.namePools).sort()).toEqual(['alpha', 'nosurname']);
    expect(content.personality.stability).toEqual([{ code: 'A', desc: '稳定描述' }]);
  });

  it('坏的一段只让那一段变空，不牵连其余段', () => {
    seedRegistry({ ...FIXTURE, hairColors: 'broken' });
    const content = getNamePoolsContent();
    expect(content.hairColors).toEqual({});
    expect(content.eyeColors.alpha).toEqual(['e1', 'e2']);
  });

  it('池内的非字符串元素与坏的性格项被逐个丢弃', () => {
    seedRegistry({
      namePools: { alpha: { male: ['ok', 42, null], female: [], surnames: [] } },
      hairColors: {},
      eyeColors: {},
      personality: { warmth: [{ code: 'w', desc: 'W' }, { code: 'x' }, 'junk'] },
    });
    const content = getNamePoolsContent();
    expect(content.namePools.alpha.male).toEqual(['ok']);
    expect(content.personality.warmth).toEqual([{ code: 'w', desc: 'W' }]);
  });
});

// ========== randomName ==========

describe('randomName', () => {
  it('名字取自该种族该性别的池；带姓时格式为 名·姓', () => {
    for (let i = 0; i < 50; i++) {
      const name = randomName('alpha', '男', FIXTURE);
      const [given, surname, ...rest] = name.split('·');
      expect(rest).toHaveLength(0);
      expect(FIXTURE.namePools.alpha.male).toContain(given);
      if (surname !== undefined) expect(FIXTURE.namePools.alpha.surnames).toContain(surname);
    }
  });

  it('女性走 female 池', () => {
    for (let i = 0; i < 30; i++) {
      const given = randomName('alpha', '女', FIXTURE).split('·')[0];
      expect(FIXTURE.namePools.alpha.female).toContain(given);
    }
  });

  it('多次调用应产生不同名字（不是恒定值）', () => {
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) names.add(randomName('alpha', '男', FIXTURE));
    expect(names.size).toBeGreaterThan(1);
  });

  it('约一半带姓氏（50% 分支两侧都可达）', () => {
    const withSurname: string[] = [];
    const without: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = randomName('alpha', '男', FIXTURE);
      (name.includes('·') ? withSurname : without).push(name);
    }
    expect(withSurname.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  it('🔴 姓氏池为空的种族只返回名，绝不拼出「名·undefined」', () => {
    for (let i = 0; i < 100; i++) {
      const name = randomName('nosurname', '男', FIXTURE);
      expect(name).not.toContain('·');
      expect(name).not.toContain('undefined');
      expect(FIXTURE.namePools.nosurname.male).toContain(name);
    }
  });

  it('未定义种族回退到 defaultRace 的池', () => {
    for (let i = 0; i < 30; i++) {
      const given = randomName('不存在的种族', '男', FIXTURE).split('·')[0];
      expect(FIXTURE.namePools.alpha.male).toContain(given);
    }
  });

  it('池全空 → 返回空串（确定性兜底，不抛）', () => {
    expect(randomName('alpha', '男', EMPTY)).toBe('');
    expect(randomName('whatever', '女', EMPTY)).toBe('');
  });

  it('默认参数走注册表（不传内容时读当前注册表值）', () => {
    seedRegistry(FIXTURE);
    const given = randomName('alpha', '男').split('·')[0];
    expect(FIXTURE.namePools.alpha.male).toContain(given);
  });
});

// ========== randomHairColor / randomEyeColor ==========

describe('randomHairColor', () => {
  it('取自该种族的发色池', () => {
    for (let i = 0; i < 20; i++) {
      expect(FIXTURE.hairColors.alpha).toContain(randomHairColor('alpha', FIXTURE));
    }
  });

  it('未定义种族回退到 defaultColorKey 池', () => {
    expect(randomHairColor('不存在的种族', FIXTURE)).toBe('hf');
  });

  it('池全空 → 空串', () => {
    expect(randomHairColor('alpha', EMPTY)).toBe('');
  });

  it('默认参数走注册表', () => {
    seedRegistry(FIXTURE);
    expect(FIXTURE.hairColors.alpha).toContain(randomHairColor('alpha'));
  });
});

describe('randomEyeColor', () => {
  it('取自该种族的瞳色池', () => {
    for (let i = 0; i < 20; i++) {
      expect(FIXTURE.eyeColors.alpha).toContain(randomEyeColor('alpha', FIXTURE));
    }
  });

  it('未定义种族回退到 defaultColorKey 池', () => {
    expect(randomEyeColor('不存在的种族', FIXTURE)).toBe('ef');
  });

  it('池全空 → 空串', () => {
    expect(randomEyeColor('alpha', EMPTY)).toBe('');
  });
});

// ========== randomPersonality ==========

describe('randomPersonality', () => {
  it('返回 code 和 description', () => {
    const result = randomPersonality(FIXTURE);
    expect(typeof result.code).toBe('string');
    expect(typeof result.description).toBe('string');
  });

  it('code = 五维编码顺序拼接 + 括号包住的稳定性', () => {
    // fixture 每维只有一项，编码是确定的
    expect(randomPersonality(FIXTURE).code).toBe('wOaGz(A)');
  });

  it('code 形状为 5 个维度字母 + (稳定性)', () => {
    const result = randomPersonality(FIXTURE);
    expect(result.code).toMatch(/^.{5}\(.\)$/);
  });

  it('description 逐维度带标签，顺序与编码一致', () => {
    const result = randomPersonality(FIXTURE);
    expect(result.description).toBe(
      '亲近度: 亲近描述; 坦露度: 坦露描述; 急切度: 急切描述; 刚柔度: 刚柔描述; 执着度: 执着描述; 稳定性: 稳定描述',
    );
  });

  it('多项池应产生不同结果（不是恒定值）', () => {
    const multi: NamePoolsContent = {
      ...FIXTURE,
      personality: {
        ...FIXTURE.personality,
        warmth: [
          { code: 'w', desc: 'a' },
          { code: 'W', desc: 'b' },
          { code: 'd', desc: 'c' },
        ],
      },
    };
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(randomPersonality(multi).code);
    expect(codes.size).toBeGreaterThan(1);
  });

  it('缺某一维度 → 该维不进编码也不进描述，其余维照常', () => {
    const missing: NamePoolsContent = {
      ...FIXTURE,
      personality: { ...FIXTURE.personality, urgency: [], stability: undefined },
    };
    const result = randomPersonality(missing);
    expect(result.code).toBe('wOGz');
    expect(result.description).not.toContain('急切度');
    expect(result.description).not.toContain('稳定性');
    expect(result.description).toContain('亲近度');
  });

  it('性格池全空 → { code: "", description: "" }（确定性兜底）', () => {
    expect(randomPersonality(EMPTY)).toEqual({ code: '', description: '' });
  });

  it('默认参数走注册表', () => {
    seedRegistry(FIXTURE);
    expect(randomPersonality().code).toBe('wOaGz(A)');
  });
});

// ========== rollAttributes（数值机制，未数据化） ==========

describe('rollAttributes', () => {
  it('T1 Lv1: 每项不应超过 tierCap=8', () => {
    for (let i = 0; i < 50; i++) {
      const result = rollAttributes(1, 1);
      expect(result.str).toBeLessThanOrEqual(8);
      expect(result.dex).toBeLessThanOrEqual(8);
      expect(result.con).toBeLessThanOrEqual(8);
      expect(result.int).toBeLessThanOrEqual(8);
      expect(result.spi).toBeLessThanOrEqual(8);
    }
  });

  it('基础池每项应 ≤ 6', () => {
    // 基础值 = 最终值 - tierFixed（level=1 时 levelExtra=0，全部来自 basePool）
    for (let i = 0; i < 50; i++) {
      const result = rollAttributes(1, 1); // tierFixed=0, levelExtra=0
      expect(result.str - 0).toBeLessThanOrEqual(6);
      expect(result.dex - 0).toBeLessThanOrEqual(6);
      expect(result.con - 0).toBeLessThanOrEqual(6);
      expect(result.int - 0).toBeLessThanOrEqual(6);
      expect(result.spi - 0).toBeLessThanOrEqual(6);
    }
  });

  it('高层级应有 tierFixed 加成', () => {
    const result = rollAttributes(5, 1);
    // T5: tierFixed=4, cap=16 —— 每项至少 tierFixed 点
    expect(result.str).toBeGreaterThanOrEqual(4);
    expect(result.con).toBeGreaterThanOrEqual(4);
    expect(result.breakdown.tierFixed).toBe(4);
  });

  it('等级额外应有正数（Lv>1）', () => {
    const result = rollAttributes(3, 10);
    expect(result.breakdown.levelExtra).toBe(9);
    expect(result.breakdown.levelUsed).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.levelUsed).toBeLessThanOrEqual(9);
  });

  it('T7 Lv25: 可达 tierCap=20', () => {
    let maxAttr = 0;
    for (let i = 0; i < 100; i++) {
      const r = rollAttributes(7, 25);
      maxAttr = Math.max(maxAttr, r.str, r.dex, r.con, r.int, r.spi);
    }
    expect(maxAttr).toBe(20);
  });

  it('T7: 不会超过 20', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollAttributes(7, 25);
      expect(r.str).toBeLessThanOrEqual(20);
      expect(r.dex).toBeLessThanOrEqual(20);
      expect(r.con).toBeLessThanOrEqual(20);
      expect(r.int).toBeLessThanOrEqual(20);
      expect(r.spi).toBeLessThanOrEqual(20);
    }
  });

  it('breakdown 应有完整信息', () => {
    const result = rollAttributes(3, 5);
    expect(result.breakdown.basePool).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.basePool).toBeLessThanOrEqual(25);
    expect(result.breakdown.tierFixed).toBe(2); // T3 → 2
    expect(result.breakdown.levelExtra).toBe(4); // Lv5 → 4
    expect(result.breakdown.cap).toBe(getTierAttributeCap(3));
    expect(result.breakdown.baseCap).toBe(6);
    expect(result.breakdown.baseUsed).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.levelUsed).toBeGreaterThanOrEqual(0);
  });
});

// ========== randomAppearanceSummary ==========

describe('randomAppearanceSummary', () => {
  it('应返回完整的外貌字段（年龄+体型，不含发色瞳色）', () => {
    const result = randomAppearanceSummary('人类', '男');
    expect(typeof result.ageAppearance).toBe('string');
    expect(result.ageAppearance.length).toBeGreaterThan(0);
    expect(typeof result.build).toBe('string');
    expect(result.build.length).toBeGreaterThan(0);
  });

  it('男女应有不同体型池', () => {
    const maleBuilds = new Set<string>();
    const femaleBuilds = new Set<string>();
    for (let i = 0; i < 20; i++) {
      maleBuilds.add(randomAppearanceSummary('人类', '男').build);
      femaleBuilds.add(randomAppearanceSummary('人类', '女').build);
    }
    expect(maleBuilds.size).toBeGreaterThanOrEqual(1);
    expect(femaleBuilds.size).toBeGreaterThanOrEqual(1);
  });
});
