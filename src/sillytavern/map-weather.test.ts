/**
 * map-weather.test.ts — 确定性天气采样的守卫测试（地图系统 v1 / 设计 §7·§10）
 *
 * 钉的都是「改坏了不报错、只会静默把天气算错」那一类:
 * - **确定性**：同 `(saveSeed, zoneId, gameDay)` 永远同标签。这条一旦破，症状不是报错，而是
 *   快照回退 / 重发之后世界的天气变了（`ejs-rng.ts` 文件头那整段理由）
 * - **权重真的被尊重**：9:1 的表必须约 9:1。加权采样坏掉的典型姿势（NaN 污染累加 → 恒取
 *   最后一行、`<=` 写成 `<` 之类）全都产出合法标签，只是分布不对 —— 单次调用测不出来
 * - **相邻日 / 相邻区不同相位**：种子拼接撞号会让两个区共享同一条天气序列，看着完全正常
 * - **回退链三级**（气候 → 第一个画像 → null）：坏包不许让整条链抛，也不许凭空造标签串
 * - **结构闸门**：本模块源码里不许出现 `Math.random` 或时钟（否则「确定性」只是注释里的承诺）
 *
 * 🔴 **fixture 零真实地名与零真实天气词**（承 `map-pack.test.ts` 的口径 / D25①）。这里的季节键
 *    叫 spring/summer、天气叫 sun/rain/snow —— 词汇是**包定义**的，引擎一个字都不认识。
 *    用中性词做夹具本身就是在证明这件事：换一套完全不同的词汇表，采样行为一模一样。
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_MAP_PACK } from './map-pack';
import { weatherAt, weatherZoneOfTile } from './map-weather';
import type { ClimateProfile, MapPack, MapTile, WeatherWeight } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具
// ═══════════════════════════════════════════════════════════

const SEED = 'save-a';

function makeTile(id: number, name: string, midTierId: string | null): MapTile {
  return {
    id,
    name,
    terrain: 'plains',
    water: null,
    impassable: false,
    countryId: 'north',
    midTierId,
    centroid: [id * 10, id * 10],
    areaPx: 100,
  };
}

/** 只有 `midTiers` / `climates` / `tiles` 三节参与天气，其余节给合法空壳 */
function makePack(parts: {
  midTiers: MapPack['midTiers'];
  climates: Record<string, ClimateProfile>;
  tiles?: MapTile[];
}): MapPack {
  return {
    version: '1.0.0',
    contentHash: 'hash-1',
    resolution: { w: 100, h: 100 },
    kmPerPx: 1,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 120 },
      embarkCost: 10,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    countries: [{ id: 'north', name: 'Northland', color: [10, 20, 30], anchorTileId: 1 }],
    midTiers: parts.midTiers,
    climates: parts.climates,
    tiles: parts.tiles ?? [],
    adjacency: [],
    straits: [],
    placeBindings: {},
  };
}

const NINE_TO_ONE: WeatherWeight[] = [
  ['rain', 9],
  ['sun', 1],
];
const FIFTY_FIFTY: WeatherWeight[] = [
  ['sun', 1],
  ['rain', 1],
];

/**
 * 主夹具：四个中层覆盖气候解析的四种入口（直命中 / 未指定 / 悬空 id / 与别人共用同一气候），
 * 两块地覆盖 `weatherZoneOfTile` 的两种出口。
 */
const PACK = makePack({
  midTiers: [
    { id: 'vale', name: 'North Vale', countryId: 'north', climateId: 'zone-lean', anchorTileId: 1 },
    {
      id: 'reach',
      name: 'South Reach',
      countryId: 'north',
      climateId: 'zone-even',
      anchorTileId: 2,
    },
    {
      id: 'echo',
      name: 'Echo Flats',
      countryId: 'north',
      climateId: 'zone-even',
      anchorTileId: null,
    },
    { id: 'waste', name: 'Blank Waste', countryId: 'north', climateId: '', anchorTileId: null },
    {
      id: 'ghost',
      name: 'Ghost March',
      countryId: 'north',
      climateId: 'zone-gone',
      anchorTileId: null,
    },
  ],
  climates: {
    'zone-lean': {
      name: 'Lean',
      table: { spring: NINE_TO_ONE, winter: [['snow', 1]] },
    },
    'zone-even': { name: 'Even', table: { spring: FIFTY_FIFTY } },
  },
  tiles: [
    makeTile(1, 'Alpha', 'vale'),
    makeTile(2, 'Bravo', 'reach'),
    makeTile(3, 'Charlie', null),
  ],
});

/** 取一段连续日的标签序列（`null` 折成 '-'，方便整段比较） */
function labelsOverDays(
  pack: MapPack,
  zoneId: string,
  seasonKey: string,
  days: number,
  seed = SEED,
): string[] {
  const out: string[] = [];
  for (let day = 0; day < days; day++) {
    out.push(weatherAt(pack, zoneId, seasonKey, day, seed)?.label ?? '-');
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 确定性
// ═══════════════════════════════════════════════════════════

describe('weatherAt —— 确定性（快照回退/重发的前提）', () => {
  it('同 (seed, zone, day) 反复调用逐次同结果', () => {
    const first = weatherAt(PACK, 'vale', 'spring', 5, SEED);
    expect(first).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      expect(weatherAt(PACK, 'vale', 'spring', 5, SEED)).toEqual(first);
    }
  });

  it('两份内容相同、对象不同的包给出同结果（不依赖对象身份/遍历以外的状态）', () => {
    const twin = makePack({
      midTiers: PACK.midTiers.map((row) => ({ ...row })),
      climates: {
        'zone-lean': { name: 'Lean', table: { spring: [...NINE_TO_ONE], winter: [['snow', 1]] } },
        'zone-even': { name: 'Even', table: { spring: [...FIFTY_FIFTY] } },
      },
      tiles: PACK.tiles.map((row) => ({ ...row })),
    });
    for (let day = 0; day < 30; day++) {
      expect(weatherAt(twin, 'vale', 'spring', day, SEED)).toEqual(
        weatherAt(PACK, 'vale', 'spring', day, SEED),
      );
    }
  });

  it('同一天的小数日与整日同结果（天气是按天的量）', () => {
    const whole = weatherAt(PACK, 'vale', 'spring', 7, SEED);
    expect(weatherAt(PACK, 'vale', 'spring', 7.9, SEED)).toEqual(whole);
  });

  it('非有穷日不抛、读作第 0 天', () => {
    const zero = weatherAt(PACK, 'vale', 'spring', 0, SEED);
    expect(weatherAt(PACK, 'vale', 'spring', Number.NaN, SEED)).toEqual(zero);
    expect(weatherAt(PACK, 'vale', 'spring', Number.POSITIVE_INFINITY, SEED)).toEqual(zero);
  });
});

// ═══════════════════════════════════════════════════════════
// 去相关（换日 / 换区 / 换存档）
// ═══════════════════════════════════════════════════════════

describe('weatherAt —— 换日/换区/换存档都要换相位', () => {
  it('200 天里 50/50 的两个标签都出现过（不是钉在一个值上）', () => {
    const seq = labelsOverDays(PACK, 'reach', 'spring', 200);
    expect(new Set(seq)).toEqual(new Set(['sun', 'rain']));
  });

  it('同气候的两个区序列不同（种子含 zoneId，且拼接不撞号）', () => {
    const reach = labelsOverDays(PACK, 'reach', 'spring', 200);
    const echo = labelsOverDays(PACK, 'echo', 'spring', 200);
    expect(echo).not.toEqual(reach);
  });

  it('两个存档同区同日序列不同（天气按存档隔离）', () => {
    const a = labelsOverDays(PACK, 'reach', 'spring', 200, 'save-a');
    const b = labelsOverDays(PACK, 'reach', 'spring', 200, 'save-b');
    expect(b).not.toEqual(a);
  });
});

// ═══════════════════════════════════════════════════════════
// 权重
// ═══════════════════════════════════════════════════════════

describe('weatherAt —— 加权表真的被尊重', () => {
  it('9:1 的表在 2000 天里落在 90% ± 3pp', () => {
    const seq = labelsOverDays(PACK, 'vale', 'spring', 2000);
    const share = seq.filter((label) => label === 'rain').length / seq.length;
    expect(share, `rain share = ${share}`).toBeGreaterThan(0.87);
    expect(share, `rain share = ${share}`).toBeLessThan(0.93);
  });

  it('单行表恒取该行', () => {
    const seq = labelsOverDays(PACK, 'vale', 'winter', 50);
    expect(new Set(seq)).toEqual(new Set(['snow']));
  });

  it('0 / 负 / NaN / Infinity 权重的行被跳过（NaN 会污染累加、Infinity 会吞掉全部概率）', () => {
    const pack = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: {
        c: {
          name: 'C',
          table: {
            spring: [
              ['zero', 0],
              ['negative', -3],
              ['nan', Number.NaN],
              ['infinite', Number.POSITIVE_INFINITY],
              ['fog', 5],
            ],
          },
        },
      },
    });
    const seq = labelsOverDays(pack, 'z', 'spring', 200);
    expect(new Set(seq)).toEqual(new Set(['fog']));
  });

  it('标签为空串的行被跳过（空串写进 sys.天气 比没有天气更坏）', () => {
    const pack = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: {
        c: {
          name: 'C',
          table: {
            spring: [
              ['', 99],
              ['fog', 1],
            ],
          },
        },
      },
    });
    expect(new Set(labelsOverDays(pack, 'z', 'spring', 100))).toEqual(new Set(['fog']));
  });

  it('全部权重不合法 → null（不凭空造标签串）', () => {
    const pack = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: {
        c: {
          name: 'C',
          table: {
            spring: [
              ['zero', 0],
              ['nan', Number.NaN],
            ],
          },
        },
      },
    });
    expect(weatherAt(pack, 'z', 'spring', 1, SEED)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 季节回退
// ═══════════════════════════════════════════════════════════

describe('weatherAt —— 季节回退（引擎不认识季节，只查表）', () => {
  const pack = makePack({
    midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
    climates: { c: { name: 'C', table: { autumn: [['fog', 1]] } } },
  });

  it('季节键缺席 → 取画像里第一张可用表', () => {
    expect(weatherAt(pack, 'z', 'spring', 3, SEED)).toEqual({ label: 'fog' });
  });

  it('季节键为空串 → 同样回退（不当成一个真的键去查）', () => {
    expect(weatherAt(pack, 'z', '', 3, SEED)).toEqual({ label: 'fog' });
  });

  it('季节键命中但那一季全是废行 → 与「缺席」走同一条回退（map-pack 明写的契约）', () => {
    const partial = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: {
        c: { name: 'C', table: { spring: [], summer: [['zero', 0]], autumn: [['fog', 1]] } },
      },
    });
    expect(weatherAt(partial, 'z', 'spring', 3, SEED)).toEqual({ label: 'fog' });
    expect(weatherAt(partial, 'z', 'summer', 3, SEED)).toEqual({ label: 'fog' });
  });

  it('整个画像一张可用表都没有 → null', () => {
    const barren = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: { c: { name: 'C', table: {} } },
    });
    expect(weatherAt(barren, 'z', 'spring', 3, SEED)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 气候回退
// ═══════════════════════════════════════════════════════════

describe('weatherAt —— 气候回退（第一个画像；一个都没有则 null）', () => {
  /** 两个画像各只有一个独占标签 —— 「回退到哪一个」于是可以逐值断言 */
  const pack = makePack({
    midTiers: [
      {
        id: 'good',
        name: 'Good',
        countryId: 'north',
        climateId: 'zone-second',
        anchorTileId: null,
      },
      { id: 'blank', name: 'Blank', countryId: 'north', climateId: '', anchorTileId: null },
      {
        id: 'ghost',
        name: 'Ghost',
        countryId: 'north',
        climateId: 'zone-gone',
        anchorTileId: null,
      },
    ],
    climates: {
      'zone-first': { name: 'First', table: { spring: [['aurora', 1]] } },
      'zone-second': { name: 'Second', table: { spring: [['sandstorm', 1]] } },
    },
  });

  it('中层指定的气候直命中（不走回退）', () => {
    expect(weatherAt(pack, 'good', 'spring', 1, SEED)).toEqual({ label: 'sandstorm' });
  });

  it('中层没指定气候 → 第一个画像', () => {
    expect(weatherAt(pack, 'blank', 'spring', 1, SEED)).toEqual({ label: 'aurora' });
  });

  it('中层的气候 id 悬空 → 第一个画像', () => {
    expect(weatherAt(pack, 'ghost', 'spring', 1, SEED)).toEqual({ label: 'aurora' });
  });

  it('中层根本不存在（含空串 zoneId）→ 第一个画像', () => {
    expect(weatherAt(pack, 'no-such-zone', 'spring', 1, SEED)).toEqual({ label: 'aurora' });
    expect(weatherAt(pack, '', 'spring', 1, SEED)).toEqual({ label: 'aurora' });
  });

  it('回退目标只看包顺序、不看「哪个画像恰好有这一季」（写在最前的空画像会让回退变 null）', () => {
    const emptyFirst = makePack({
      midTiers: [],
      climates: {
        'zone-empty': { name: 'Empty', table: {} },
        'zone-usable': { name: 'Usable', table: { spring: [['aurora', 1]] } },
      },
    });
    expect(weatherAt(emptyFirst, 'no-such-zone', 'spring', 1, SEED)).toBeNull();
  });

  it('一个画像都没有 → null', () => {
    const noClimates = makePack({
      midTiers: [{ id: 'z', name: 'Zed', countryId: 'north', climateId: 'c', anchorTileId: null }],
      climates: {},
    });
    expect(weatherAt(noClimates, 'z', 'spring', 1, SEED)).toBeNull();
  });

  it('空包 → null（空包是合同不是异常，§3.4-2）', () => {
    expect(weatherAt(EMPTY_MAP_PACK, 'z', 'spring', 1, SEED)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// weatherZoneOfTile
// ═══════════════════════════════════════════════════════════

describe('weatherZoneOfTile —— 落位 → 气候区（weatherStamp.zoneId 的来源）', () => {
  it('返回地块所属中层 id（稳定键，不是显示名）', () => {
    expect(weatherZoneOfTile(PACK, 1)).toBe('vale');
    expect(weatherZoneOfTile(PACK, 2)).toBe('reach');
  });

  it('地块不属于任何中层 → null', () => {
    expect(weatherZoneOfTile(PACK, 3)).toBeNull();
  });

  it('地块 id 查不到 / 非有穷 → null（不抛）', () => {
    expect(weatherZoneOfTile(PACK, 999)).toBeNull();
    expect(weatherZoneOfTile(PACK, Number.NaN)).toBeNull();
  });

  it('空包 → null', () => {
    expect(weatherZoneOfTile(EMPTY_MAP_PACK, 1)).toBeNull();
  });

  it('悬空 midTierId 原样返回（不打回 null —— 否则跨区移动不重掷天气）', () => {
    const pack = makePack({
      midTiers: [],
      climates: {},
      tiles: [makeTile(7, 'Golf', 'orphan-zone')],
    });
    expect(weatherZoneOfTile(pack, 7)).toBe('orphan-zone');
  });
});

// ═══════════════════════════════════════════════════════════
// 结构闸门 —— 「确定性」不能只是注释里的承诺
// ═══════════════════════════════════════════════════════════

/**
 * 扫本模块源码文本（先例 `combat-v3/no-nondeterminism.test.ts`：不用 node:fs，仓库
 * `types: []` 没装 @types/node，`src/**` 下 import 'fs' 会让裸 tsc 报 TS2307）。
 */
const SELF_SOURCE: Record<string, string> = import.meta.glob('@engine/map-weather.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * 判据要求**带左括号**（照 `no-nondeterminism.test.ts` 的同款正则）—— 少了它，源码注释里
 * 「本模块不许用 Math.random」这句解释本身就会让闸门变红，于是下一个人的修法是把解释删掉。
 * 代价是注释里写出 `Math.random()` 带括号的形态会误报；那是可接受的一侧
 * （误报有人看得见，漏报没人看得见）。
 */
const FORBIDDEN = {
  random: /Math\s*\.\s*random\s*\(/,
  clockNow: /Date\s*\.\s*now\s*\(/,
  clockCtor: /new\s+Date\s*\(/,
} as const;

describe('map-weather.ts 结构闸门（纯函数 / 无随机 / 无时钟）', () => {
  const source = Object.values(SELF_SOURCE)[0];

  it('glob 真的读到了源码（否则下面全是空转）', () => {
    expect(typeof source).toBe('string');
    expect(source).toContain('export function weatherAt');
  });

  it('判据本身抓得住违规（反证闸门不是恒绿的）', () => {
    expect(FORBIDDEN.random.test('const u = Math.random();')).toBe(true);
    expect(FORBIDDEN.clockNow.test('const t = Date.now();')).toBe(true);
    expect(FORBIDDEN.clockCtor.test('const d = new Date();')).toBe(true);
  });

  it('不含 Math.random（真随机会让快照回退后天气变样，且 debug loop 复现不了）', () => {
    expect(FORBIDDEN.random.test(source)).toBe(false);
  });

  it('不含时钟（Date.now / new Date）—— 同一天的两次查询必须同答案', () => {
    expect(FORBIDDEN.clockNow.test(source)).toBe(false);
    expect(FORBIDDEN.clockCtor.test(source)).toBe(false);
  });
});
