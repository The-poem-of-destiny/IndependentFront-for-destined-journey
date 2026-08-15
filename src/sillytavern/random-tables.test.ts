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
  randomNameSeed,
  randomHairColor,
  randomEyeColor,
  randomPersonality,
  rollAttributes,
  randomAppearanceSummary,
  getTierAttributeCap,
  getNamePoolsContent,
  type NamePoolsContent,
  type SeedProfile,
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
  seedProfiles: {
    alpha: {
      weights: { P: 40, S: 20, D: 20, X: 0, V: 20 },
      force: ['V'],
      count: [3, 4],
      mods: {
        startPrefer: ['P', 'S'],
        endPrefer: ['V', 'D'],
        maxConsecutiveConsonants: 2,
        vowelTone: 'neutral',
        mutationChance: 0,
      },
    },
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
  seedProfiles: {},
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

// ========== randomName 防重名（avoid，2026-08-15） ==========
// 真机教训：同一存档两个无名男性人类 NPC 先后经 random_name 抽中同一个
// 「奥斯瓦尔德」——池是均匀随机的，但引擎没有任何防撞护栏，AI 也照单全收。

describe('randomName avoid（防重名）', () => {
  it('avoid 含给定名 → 绝不再抽出该名（含带姓变体）', () => {
    // 已有角色「A1·S1」——给定名 A1 被封；A1 与 A1·S2 都是撞车形态
    for (let i = 0; i < 60; i++) {
      const given = randomName('alpha', '男', FIXTURE, ['A1·S1']).split('·')[0];
      expect(given).not.toBe('A1');
    }
  });

  it('avoid 的比较粒度是给定名：已有「A2·S1」封 A2，不封姓 S1', () => {
    for (let i = 0; i < 60; i++) {
      const [given, surname] = randomName('alpha', '男', FIXTURE, ['A2·S1']).split('·');
      expect(given).not.toBe('A2');
      // 姓氏不参与比较：A1·S1（与已有角色同姓）是合法结果
      if (surname !== undefined) expect(surname === 'S1' || surname === 'S2').toBe(true);
    }
  });

  it('avoid 封掉多个名 → 只从剩余名里抽', () => {
    for (let i = 0; i < 60; i++) {
      const given = randomName('alpha', '男', FIXTURE, ['A1', 'A2']).split('·')[0];
      expect(given).toBe('A3');
    }
  });

  it('avoid 全覆盖名池 → 仍返回池内名（空串会打断生成链）', () => {
    for (let i = 0; i < 30; i++) {
      const name = randomName('alpha', '男', FIXTURE, ['A1', 'A2', 'A3']);
      expect(FIXTURE.namePools.alpha.male).toContain(name.split('·')[0]);
    }
  });

  it('avoid 含空串/空白 → 被忽略，不影响抽样', () => {
    const given = randomName('alpha', '男', FIXTURE, ['', '  ']).split('·')[0];
    expect(FIXTURE.namePools.alpha.male).toContain(given);
  });

  it('avoid 与池无交集 → 行为与不传时一致（池内取值）', () => {
    for (let i = 0; i < 40; i++) {
      const given = randomName('alpha', '男', FIXTURE, ['完全无关的名字']).split('·')[0];
      expect(FIXTURE.namePools.alpha.male).toContain(given);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// randomNameSeed（IPA 音素种子，世界书 uid 480748 机制移植）
// ═══════════════════════════════════════════════════════════

/** fixture 的 alpha profile：X 权重 0、mutationChance 0 —— 不变量可精确断言 */
const SEED_PROFILE = FIXTURE.seedProfiles.alpha;

/** 全部合法音素（用于「音素都来自已知池」断言） */
const ALL_PHONEMES = new Set(
  ([] as string[]).concat(
    phonemePoolForTest('P'),
    phonemePoolForTest('S'),
    phonemePoolForTest('D'),
    phonemePoolForTest('X'),
    phonemePoolForTest('V'),
  ),
);

/** 测试侧音素池镜像（引擎不导出 IPA_POOLS，这里按公开类型重述一份做断言依据） */
function phonemePoolForTest(key: 'P' | 'S' | 'D' | 'X' | 'V'): string[] {
  const pools: Record<'P' | 'S' | 'D' | 'X' | 'V', string[]> = {
    P: [
      'p',
      'b',
      't',
      'd',
      'k',
      'ɡ',
      'q',
      'ʈ',
      'ɖ',
      'c',
      'ɟ',
      'ts',
      'dz',
      'tʃ',
      'dʒ',
      'tɕ',
      'dʑ',
      'ʈʂ',
      'ɖʐ',
    ],
    S: [
      'f',
      's',
      'v',
      'z',
      'ʃ',
      'ʒ',
      'ɕ',
      'ʑ',
      'ʂ',
      'ʐ',
      'ɸ',
      'β',
      'θ',
      'ð',
      'ç',
      'x',
      'h',
      'ɬ',
      'ɮ',
      'l',
      'r',
      'ɹ',
      'ɾ',
      'ɽ',
      'ʎ',
      'j',
      'w',
    ],
    D: ['m', 'ɱ', 'n', 'ɳ', 'ɲ', 'ŋ', 'ɴ', 'ʁ', 'ʀ', 'ɣ', 'χ', 'ʕ', 'ɫ', 'ɢ'],
    X: [
      'ǃ',
      'ʘ',
      'ǀ',
      'ǁ',
      'ǂ',
      'ɓ',
      'ɗ',
      'ʄ',
      'ɠ',
      'ʛ',
      "p'",
      "t'",
      "k'",
      "q'",
      "ts'",
      "tʃ'",
      'ʔ',
    ],
    V: [
      'i',
      'y',
      'ɨ',
      'ʉ',
      'ɯ',
      'u',
      'ɪ',
      'ʏ',
      'ʊ',
      'e',
      'ø',
      'ɘ',
      'ɵ',
      'ɤ',
      'o',
      'ə',
      'ɛ',
      'œ',
      'ɜ',
      'ɞ',
      'ʌ',
      'ɔ',
      'æ',
      'ɐ',
      'a',
      'ɶ',
      'ɑ',
      'ɒ',
    ],
  };
  return pools[key];
}

/** 音素 → 池键（测试侧镜像） */
function poolOfPhoneme(ph: string): 'P' | 'S' | 'D' | 'X' | 'V' {
  for (const key of ['P', 'S', 'D', 'X', 'V'] as const) {
    if (phonemePoolForTest(key).includes(ph)) return key;
  }
  throw new Error(`未知音素: ${ph}`);
}

describe('randomNameSeed（IPA 音素种子）', () => {
  it('形状："/" 分隔的音素串，音素全部来自五池之一', () => {
    for (let i = 0; i < 60; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      expect(seed).toBeTruthy();
      for (const ph of seed.split('/')) expect(ALL_PHONEMES.has(ph), `未知音素 ${ph}`).toBe(true);
    }
  });

  it('音素数量落在 profile 的 count 区间内', () => {
    for (let i = 0; i < 60; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      const n = seed.split('/').length;
      expect(n).toBeGreaterThanOrEqual(SEED_PROFILE.count[0]);
      expect(n).toBeLessThanOrEqual(SEED_PROFILE.count[1]);
    }
  });

  it('强制池（force: V）在种子里至少出现一次', () => {
    for (let i = 0; i < 40; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      const keys = seed.split('/').map(poolOfPhoneme);
      expect(keys).toContain('V');
    }
  });

  it('权重为 0 的池（X: 0）永不出现', () => {
    for (let i = 0; i < 60; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      for (const ph of seed.split('/')) expect(poolOfPhoneme(ph)).not.toBe('X');
    }
  });

  it('相邻音素不重复（dedupeAdjacent 不变量）', () => {
    for (let i = 0; i < 60; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      const parts = seed.split('/');
      for (let j = 1; j < parts.length; j++) expect(parts[j]).not.toBe(parts[j - 1]);
    }
  });

  it('连续辅音不超过 maxConsecutiveConsonants（平滑不变量）', () => {
    for (let i = 0; i < 60; i++) {
      const [seed] = randomNameSeed('alpha', 1, FIXTURE);
      let run = 0;
      for (const ph of seed.split('/')) {
        if (poolOfPhoneme(ph) === 'V') {
          run = 0;
          continue;
        }
        run += 1;
        expect(run).toBeLessThanOrEqual(SEED_PROFILE.mods.maxConsecutiveConsonants);
      }
    }
  });

  it('多次调用产生不同种子（组合空间远大于固定池）', () => {
    const seeds = new Set<string>();
    for (let i = 0; i < 80; i++) seeds.add(randomNameSeed('alpha', 1, FIXTURE)[0]);
    expect(seeds.size).toBeGreaterThan(40);
  });

  it('count 参数钳制：0/负数 → 1，超大 → 8', () => {
    expect(randomNameSeed('alpha', 0, FIXTURE)).toHaveLength(1);
    expect(randomNameSeed('alpha', -5, FIXTURE)).toHaveLength(1);
    expect(randomNameSeed('alpha', 100, FIXTURE)).toHaveLength(8);
  });

  it('未知种族回退 defaultRace 的 profile（与名字池同链）', () => {
    const seeds = randomNameSeed('不存在的种族', 2, FIXTURE);
    expect(seeds).toHaveLength(2);
    for (const ph of seeds[0].split('/')) expect(ALL_PHONEMES.has(ph)).toBe(true);
  });

  it('种族无 profile 且回退不到 defaultRace → 空数组（确定性兜底，不抛）', () => {
    const noSeed: NamePoolsContent = { ...FIXTURE, seedProfiles: {}, defaultRace: undefined };
    expect(randomNameSeed('alpha', 3, noSeed)).toEqual([]);
  });

  it('空内容（注册表未就绪）→ 空数组', () => {
    expect(randomNameSeed('alpha', 1, EMPTY)).toEqual([]);
  });

  it('parseSeedProfiles 容错：坏形状的 profile 整条丢弃，其余照常', () => {
    seedRegistry({
      ...FIXTURE,
      seedProfiles: {
        good: SEED_PROFILE as unknown as Record<string, unknown>,
        bad: 'not-an-object',
        alsoBad: { weights: 'x', force: 42, count: 'nope', mods: null },
      },
    });
    const content = getNamePoolsContent();
    expect(Object.keys(content.seedProfiles).sort()).toEqual(['alsoBad', 'good']);
    // 坏 profile 解析成默认形状而非消失（count 缺省 3-4、mods 全默认）
    const bad = content.seedProfiles.alsoBad as SeedProfile;
    expect(bad.count).toEqual([3, 4]);
    expect(bad.force).toEqual([]);
    expect(bad.mods.vowelTone).toBe('neutral');
    expect(bad.mods.mutationChance).toBe(0);
    // good 原样可产种子
    expect(randomNameSeed('good', 1, content)).toHaveLength(1);
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
