/**
 * start-catalog-mechanics.test.ts — 捏人目录机制半边（D24）。
 *
 * 🔴 **全部用 fixture，一条真实 IP 内容都不断言**：真实七池已抽进
 * `data/content/catalog.json`，换个内容包就该整份不同。断言「有 24 枚命定核心」
 * 这类数字，等于把内容焊回测试。
 */
import { describe, it, expect } from 'vitest';
import {
  DIFFICULTY_PRESETS,
  GENDER_OPTIONS,
  BACKGROUND_RESTRICTIONS,
  CUSTOM_COST_FALLBACK,
  EMPTY_CATALOG,
  parseCatalogData,
  isCatalogPopulated,
  findDifficultyPreset,
  lookupCost,
  costTableOptions,
  flattenLocationTree,
  classifyBackground,
  filterBackgroundsByCategory,
  countBackgroundsByCategory,
  type BackgroundTemplate,
  type CascaderOption,
} from './start-catalog-mechanics';

// ═══════════════════════════════════════════════════════════
// fixture（通用奇幻占位，与任何真实内容无关）
// ═══════════════════════════════════════════════════════════

const bg = (id: string, extra: Partial<BackgroundTemplate> = {}): BackgroundTemplate => ({
  id,
  name: id,
  description: '',
  fullText: '',
  ...extra,
});

const FIXTURE_BACKGROUNDS: BackgroundTemplate[] = [
  bg('plain-a'),
  bg('plain-b'),
  bg('guild', { requiredIdentity: '学徒' }),
  bg('winged', { requiredRace: '羽族' }),
  bg('harbor', { requiredLocation: '灰港' }),
  bg('marked', { requiredDestinyCore: '晨星' }),
];

const FIXTURE_TREE: CascaderOption[] = [
  {
    label: '北境',
    value: 'north',
    children: [
      {
        label: '灰石王国',
        value: 'north-greystone',
        children: [
          { label: '灰港', value: '北境-灰石王国-灰港' },
          { label: '风磨镇', value: '北境-灰石王国-风磨镇' },
        ],
      },
    ],
  },
  { label: '孤岛', value: '孤岛' },
];

const FIXTURE_CATALOG = {
  version: 1,
  destinyCores: [{ id: 'dc_dawn', name: '晨星', author: 'fixture', theme: 'fixture' }],
  equipmentPool: [{ id: 'eq_1', name: '木剑', category: 'equipment', rarity: 'common' }],
  itemPool: [{ id: 'it_1', name: '干粮', category: 'item', rarity: 'common' }],
  skillPool: [],
  backgrounds: FIXTURE_BACKGROUNDS,
  raceCosts: { 人类: 0, 羽族: 30, 自定义: 80 },
  identityCosts: { 自定义: 80, 学徒: 10, 流浪者: -10 },
  startLocations: FIXTURE_TREE,
};

// ═══════════════════════════════════════════════════════════
// 机制常量
// ═══════════════════════════════════════════════════════════

describe('机制常量（不进 pack，随引擎走）', () => {
  it('难度六档，id 唯一，点数递减到地狱档', () => {
    const ids = DIFFICULTY_PRESETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('creative');
    expect(ids).toContain('hell');
    expect(findDifficultyPreset('hell')!.points).toBeLessThan(
      findDifficultyPreset('normal')!.points,
    );
  });

  it('findDifficultyPreset 查无此档返回 undefined（调用方保持原状，不许静默换档）', () => {
    expect(findDifficultyPreset('nonexistent')).toBeUndefined();
    expect(findDifficultyPreset('')).toBeUndefined();
  });

  it('性别枚举含「自定义」兜底项', () => {
    expect(GENDER_OPTIONS).toContain('自定义');
  });

  it('BACKGROUND_RESTRICTIONS 仍是覆盖表形状（限定条件已内联到条目自身）', () => {
    expect(typeof BACKGROUND_RESTRICTIONS).toBe('object');
  });

  it('🔴 机制文件里不许出现具体条目内容 —— 没有导出任何池数组', async () => {
    // 这条是**结构闸门**：D24 的切分线一旦被人「顺手」加回一个池，这里立刻红。
    const mod: Record<string, unknown> = await import('./start-catalog-mechanics');
    for (const forbidden of [
      'DEFAULT_EQUIPMENT_POOL',
      'DEFAULT_ITEM_POOL',
      'DEFAULT_SKILL_POOL',
      'DEFAULT_BACKGROUNDS',
      'DEFAULT_DESTINY_CORES',
      'DEFAULT_RACE_COSTS',
      'DEFAULT_IDENTITY_COSTS',
      'START_LOCATIONS',
    ]) {
      expect(mod[forbidden], `${forbidden} 属于内容，不该留在机制文件里`).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// parseCatalogData —— 注册表 unknown → CatalogData
// ═══════════════════════════════════════════════════════════

describe('parseCatalogData', () => {
  it('正常输入逐面透传', () => {
    const c = parseCatalogData(FIXTURE_CATALOG);
    expect(c.destinyCores).toHaveLength(1);
    expect(c.equipmentPool[0].name).toBe('木剑');
    expect(c.backgrounds).toHaveLength(6);
    expect(c.raceCosts['羽族']).toBe(30);
    expect(c.startLocations).toHaveLength(2);
  });

  it('未加载 / 坏输入一律退化成空目录，**不抛**', () => {
    for (const raw of [undefined, null, 42, 'nope', [], { catalog: 'wrong-shape' }]) {
      expect(() => parseCatalogData(raw)).not.toThrow();
      expect(parseCatalogData(raw)).toEqual(EMPTY_CATALOG);
    }
  });

  it('逐面独立降级：一面坏了不带塌其余面', () => {
    const c = parseCatalogData({ ...FIXTURE_CATALOG, backgrounds: 'broken', raceCosts: 7 });
    expect(c.backgrounds).toEqual([]);
    expect(c.raceCosts).toEqual({});
    expect(c.equipmentPool).toHaveLength(1); // 其余面照常
  });

  it('点数表丢弃非有限数字（内容侧自由文本，不许把 NaN 带进结算）', () => {
    const c = parseCatalogData({
      ...FIXTURE_CATALOG,
      raceCosts: { 人类: 0, 坏值: 'ten', 无穷: Infinity, 空: null },
    });
    expect(c.raceCosts).toEqual({ 人类: 0 });
  });

  it('🔴 点数表丢弃原型键（内容侧的键是自由文本，下游拿它查表）', () => {
    const c = parseCatalogData({
      ...FIXTURE_CATALOG,
      identityCosts: JSON.parse('{"__proto__": 1, "constructor": 2, "学徒": 10}'),
    });
    expect(c.identityCosts).toEqual({ 学徒: 10 });
    expect(lookupCost(c.identityCosts, '__proto__')).toBe(CUSTOM_COST_FALLBACK);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('isCatalogPopulated（加载门判据）', () => {
  it('全空 → false', () => {
    expect(isCatalogPopulated(EMPTY_CATALOG)).toBe(false);
  });

  it('🔴 判据是「任何一面非空」：skillPool 今天就是空的，用「全部非空」会永远卡加载态', () => {
    const c = parseCatalogData(FIXTURE_CATALOG);
    expect(c.skillPool).toEqual([]);
    expect(isCatalogPopulated(c)).toBe(true);
  });

  it('只有点数表也算有内容', () => {
    const c = parseCatalogData({ raceCosts: { 人类: 0 } });
    expect(isCatalogPopulated(c)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 点数查表
// ═══════════════════════════════════════════════════════════

describe('lookupCost / costTableOptions', () => {
  const costs = { 人类: 0, 羽族: 30, 奴隶: -20, 自定义: 80 };

  it('命中返回表内值（含 0 与负数 —— 0 不许被 `??` 之外的真值判断吃掉）', () => {
    expect(lookupCost(costs, '人类')).toBe(0);
    expect(lookupCost(costs, '奴隶')).toBe(-20);
  });

  it('查无此项落兜底 80', () => {
    expect(lookupCost(costs, '未知种族')).toBe(CUSTOM_COST_FALLBACK);
    expect(lookupCost({}, '任何')).toBe(CUSTOM_COST_FALLBACK);
  });

  it('「自定义」走表内值；表里没有也落同一个兜底', () => {
    expect(lookupCost(costs, '自定义')).toBe(80);
    expect(lookupCost({ 人类: 0 }, '自定义')).toBe(CUSTOM_COST_FALLBACK);
  });

  it('costTableOptions 保留原序，「自定义」永远排最后（位置由引擎钉死）', () => {
    expect(costTableOptions({ 自定义: 80, 学徒: 10, 流浪者: -10 })).toEqual([
      '学徒',
      '流浪者',
      '自定义',
    ]);
  });

  it('costTableOptions 对空表也给出「自定义」一项（不会出现空下拉）', () => {
    expect(costTableOptions({})).toEqual(['自定义']);
  });
});

// ═══════════════════════════════════════════════════════════
// 地点树
// ═══════════════════════════════════════════════════════════

describe('flattenLocationTree', () => {
  it('只出叶子，label 逐级拼接', () => {
    expect(flattenLocationTree(FIXTURE_TREE)).toEqual([
      { label: '北境 > 灰石王国 > 灰港', value: '北境-灰石王国-灰港' },
      { label: '北境 > 灰石王国 > 风磨镇', value: '北境-灰石王国-风磨镇' },
      { label: '孤岛', value: '孤岛' },
    ]);
  });

  it('🔴 中间节点不进结果 —— 它们的 value 是分组键，不是合法出生地', () => {
    const values = flattenLocationTree(FIXTURE_TREE).map((o) => o.value);
    expect(values).not.toContain('north');
    expect(values).not.toContain('north-greystone');
  });

  it('空树 / children 为空数组 → 空结果或叶子', () => {
    expect(flattenLocationTree([])).toEqual([]);
    expect(flattenLocationTree([{ label: '孤峰', value: 'v', children: [] }])).toEqual([
      { label: '孤峰', value: 'v' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// 背景分类
// ═══════════════════════════════════════════════════════════

describe('背景分类（计数与筛选同源）', () => {
  it('四类判定', () => {
    expect(classifyBackground(bg('a'))).toBe('universal');
    expect(classifyBackground(bg('b', { requiredIdentity: '学徒' }))).toBe('identity');
    expect(classifyBackground(bg('c', { requiredRace: '羽族' }))).toBe('race');
    expect(classifyBackground(bg('d', { requiredLocation: '灰港' }))).toBe('location');
    expect(classifyBackground(bg('e', { requiredDestinyCore: '晨星' }))).toBe('location');
  });

  it('多重限定时身份优先（与旧 if/else 链一致）', () => {
    expect(classifyBackground(bg('x', { requiredIdentity: '学徒', requiredRace: '羽族' }))).toBe(
      'identity',
    );
    expect(classifyBackground(bg('y', { requiredRace: '羽族', requiredLocation: '灰港' }))).toBe(
      'race',
    );
  });

  it('🔴 计数 = 筛选结果长度（侧栏数字与列表长度必须对得上）', () => {
    const counts = countBackgroundsByCategory(FIXTURE_BACKGROUNDS);
    for (const cat of ['universal', 'identity', 'race', 'location'] as const) {
      expect(filterBackgroundsByCategory(FIXTURE_BACKGROUNDS, cat)).toHaveLength(counts[cat]);
    }
    // 四类之和 = 全池（没有条目落在分类之外，也没有条目被数两次）
    const total = counts.universal + counts.identity + counts.race + counts.location;
    expect(total).toBe(FIXTURE_BACKGROUNDS.length);
  });

  it('空池 → 四类全 0', () => {
    expect(countBackgroundsByCategory([])).toEqual({
      universal: 0,
      identity: 0,
      race: 0,
      location: 0,
    });
  });
});
