/**
 * map-pack.test.ts — 地图内容包容错解析的守卫测试（地图系统 v1 / 设计 §4·§10）
 *
 * 钉的都是「改坏了不报错，只会静默把地图算错」那一类:
 * - map-pack.json 来自**内容包**（第三方可编辑、可整份热替换），坏值必须跳过/回落而不是
 *   让整个游戏页白屏 —— `coerceMapPack` **永不抛**是它的全部要害
 * - `Number()` 的三个静默陷阱（`''`→0 / `[]`→0 / `true`→1）会让缺字段**冒充地块 0**
 * - `water` 与 `impassable` 同真时必须保 impassable（放行一块不该进的水域是安全侧的错）
 * - 悬空引用（指向不存在地块的邻接/海峡/绑定/锚）必须清掉：留着的症状是路径从中间断掉、
 *   或者落位「成功」到一个查不到的块上 —— 两者都不报错
 * - 空包是**合同**不是异常：下游五个模块都得能吃 0 地块的包（§3.4-2 投影自愈）
 *
 * 🔴 **fixture 零真实地名**（承 D25①）。这里的 8 块地叫 Alpha…Hotel，地形叫 plains/forest，
 *    天气叫 clear/rain —— 词汇是**包定义**的，引擎一个字都不认识。用中性词做夹具本身就是
 *    在证明这件事：换一套完全不同的词汇表，解析器的行为一模一样。
 */

import { describe, expect, it } from 'vitest';

import { coerceMapPack, EMPTY_MAP_PACK, isEmptyMapPack } from './map-pack';
import type { MapPack } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具（8 块：两国 + 无主 + 海带 + 湖 + 不可通行山脊 + 一条海峡）
// ═══════════════════════════════════════════════════════════

/**
 * 一份**形状完整**的包 —— 圆整往返（`coerceMapPack(FIXTURE)` 逐字节等于 `FIXTURE`）
 * 就是「解析器不擅自改动合法数据」这条性质本身。
 */
const FIXTURE: MapPack = {
  version: '1.2.0',
  contentHash: 'abc123',
  resolution: { w: 400, h: 300 },
  kmPerPx: 2.5,
  terrains: ['plains', 'forest', 'hills', 'ridge', 'ocean', 'still-water'],
  // v1.2.0 的档名表：同样是**包词汇**，中性 ASCII 十档就够证明引擎一个字都不认识
  developmentLevels: [
    'level-01',
    'level-02',
    'level-03',
    'level-04',
    'level-05',
    'level-06',
    'level-07',
    'level-08',
    'level-09',
    'level-10',
  ],
  // v1.2.0 的主建筑通名表：与档名表并排随包，同样是**按下标寻址的序数表**
  mainBuildingNames: [
    'seat-01',
    'seat-02',
    'seat-03',
    'seat-04',
    'seat-05',
    'seat-06',
    'seat-07',
    'seat-08',
    'seat-09',
    'seat-10',
  ],
  travelRules: {
    rates: { land: 30, nearSea: 60, farSea: 120 },
    embarkCost: 12,
    terrainFactor: { plains: 1, forest: 1.4, hills: 1.8, ridge: 3 },
    modes: [],
  },
  countries: [
    { id: 'north', name: 'Northland', color: [10, 20, 30], anchorTileId: 1 },
    { id: 'south', name: 'Southmark', color: [200, 10, 10], anchorTileId: 3 },
    {
      id: 'nobody',
      name: 'Unclaimed',
      color: [128, 128, 128],
      unclaimed: true,
      anchorTileId: null,
    },
  ],
  midTiers: [
    {
      id: 'north-a',
      name: 'North Vale',
      countryId: 'north',
      climateId: 'zone-cold',
      anchorTileId: 1,
    },
    {
      id: 'south-a',
      name: 'South Reach',
      countryId: 'south',
      climateId: 'zone-mild',
      anchorTileId: 3,
    },
  ],
  climates: {
    'zone-cold': {
      name: 'Cold Zone',
      table: {
        spring: [
          ['clear', 3],
          ['rain', 1],
        ],
        winter: [
          ['snow', 4],
          ['blizzard', 1],
        ],
      },
    },
    'zone-mild': {
      name: 'Mild Zone',
      table: { spring: [['clear', 5]] },
    },
  },
  tiles: [
    {
      id: 1,
      name: 'Alpha',
      terrain: 'plains',
      water: null,
      impassable: false,
      countryId: 'north',
      midTierId: 'north-a',
      // 夹具刻意**只给两块地**上色（另一块是 Echo）：`color` 是可选格，混合包是合法输入，
      // 而「有色的用色、没色的回落哈希」正是 UI 那边逐块判断的理由。
      color: [12, 34, 56],
      centroid: [10, 10],
      areaPx: 900,
      // v1.2.0 两格：起始档 + 初始建筑基线（同 `color`，只有部分地块写）
      development: 3,
      buildings: [{ name: 'Alpha Mill', description: 'A mill.', ownerFlavor: 'Miller' }],
      // 主建筑的作者命名（同 `color`：可选格，只有部分地块写；缺席的按档派生通名）
      mainBuilding: { name: 'Alpha Hall', description: 'The seat.', ownerFlavor: 'Reeve' },
    },
    {
      id: 2,
      name: 'Bravo',
      terrain: 'forest',
      water: null,
      impassable: false,
      countryId: 'north',
      midTierId: 'north-a',
      centroid: [30, 12],
      areaPx: 750,
    },
    {
      id: 3,
      name: 'Charlie',
      terrain: 'hills',
      water: null,
      impassable: false,
      countryId: 'south',
      midTierId: 'south-a',
      centroid: [60, 40],
      areaPx: 640,
    },
    {
      id: 4,
      name: 'Delta',
      terrain: 'plains',
      water: null,
      impassable: false,
      countryId: null,
      midTierId: null,
      centroid: [8, 40],
      areaPx: 500,
    },
    {
      id: 5,
      name: 'Echo',
      terrain: 'ocean',
      water: 'sea',
      impassable: false,
      countryId: null,
      midTierId: null,
      color: [200, 201, 202],
      centroid: [45, 15],
      areaPx: 1200,
    },
    {
      id: 6,
      name: 'Foxtrot',
      terrain: 'ocean',
      water: 'sea',
      impassable: false,
      countryId: null,
      midTierId: null,
      centroid: [70, 18],
      areaPx: 1500,
    },
    {
      id: 7,
      name: 'Golf',
      terrain: 'still-water',
      water: 'lake',
      impassable: false,
      countryId: null,
      midTierId: null,
      centroid: [12, 55],
      areaPx: 200,
    },
    {
      id: 8,
      name: 'Hotel',
      terrain: 'ridge',
      water: null,
      impassable: true,
      countryId: 'north',
      midTierId: 'north-a',
      centroid: [32, 30],
      areaPx: 300,
    },
  ],
  adjacency: [
    [1, 2, 100],
    [2, 3, 80],
    [1, 4, 50],
    [2, 5, 60],
    [5, 6, 200],
    [6, 3, 40],
    [4, 7, 20],
    [2, 8, 10],
  ],
  straits: [[5, 3]],
  placeBindings: { 'Alpha Town': 1, 'Bravo Keep': 2, 'Charlie Hold': 3 },
};

/** 深拷贝夹具（每个用例都从干净的一份出发，改一格不影响别人） */
function fixture(): MapPack {
  return JSON.parse(JSON.stringify(FIXTURE)) as MapPack;
}

/** 把夹具喂成 unknown（解析器的真实入口形状） */
function raw(patch: Record<string, unknown> = {}): unknown {
  return { ...(fixture() as unknown as Record<string, unknown>), ...patch };
}

// ═══════════════════════════════════════════════════════════
// 圆整往返
// ═══════════════════════════════════════════════════════════

describe('coerceMapPack —— 合法包圆整往返', () => {
  it('形状完整的包逐字段等于原样（解析器不擅自改动合法数据）', () => {
    expect(coerceMapPack(fixture())).toEqual(FIXTURE);
  });

  it('往返产物不与输入共享引用（改产物不会回写内容包）', () => {
    const input = fixture();
    const out = coerceMapPack(input);
    out.tiles[0]!.name = 'mutated';
    out.adjacency.push([1, 3, 1]);
    expect(input.tiles[0]!.name).toBe('Alpha');
    expect(input.adjacency).toHaveLength(FIXTURE.adjacency.length);
  });

  it('有地块的包不是空包', () => {
    expect(isEmptyMapPack(coerceMapPack(fixture()))).toBe(false);
  });

  it('湖 / 海 / 不可通行三种地块的标记各自保留（下游建图靠它们分流）', () => {
    const pack = coerceMapPack(fixture());
    const byName = new Map(pack.tiles.map((t) => [t.name, t]));
    expect(byName.get('Echo')!.water).toBe('sea');
    expect(byName.get('Golf')!.water).toBe('lake');
    expect(byName.get('Hotel')!.impassable).toBe(true);
    expect(byName.get('Hotel')!.water).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 整份垃圾 → 空包
// ═══════════════════════════════════════════════════════════

describe('coerceMapPack —— 整份认不出时退到空包', () => {
  const garbage: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'not a pack'],
    ['empty string', ''],
    ['boolean', true],
    ['array', [{ id: 1, name: 'Alpha' }]],
    ['NaN', Number.NaN],
  ];

  for (const [label, input] of garbage) {
    it(`${label} → 空包且不抛`, () => {
      expect(() => coerceMapPack(input)).not.toThrow();
      const pack = coerceMapPack(input);
      expect(pack).toEqual(EMPTY_MAP_PACK);
      expect(isEmptyMapPack(pack)).toBe(true);
    });
  }

  it('🔴 数组刻意不收 —— 外层形状由注册表校验器守，解析器只对内容宽容', () => {
    // 把整节写成裸数组是「作者把整节写成了别的形状」，不是「内容里有个坏值」。
    // 收下它等于在解析器里对校验器已经拦住的形状再讲一套宽容 —— 那是一句读代码的人会信的假话。
    expect(coerceMapPack(FIXTURE.tiles).tiles).toEqual([]);
  });

  it('空包每次都是**新**对象（往兜底产物里 push 不会污染下一次兜底）', () => {
    const first = coerceMapPack(null);
    first.tiles.push(FIXTURE.tiles[0]!);
    const second = coerceMapPack(null);
    expect(second.tiles).toEqual([]);
    expect(EMPTY_MAP_PACK.tiles).toEqual([]);
  });

  it('空包的版本戳是 empty，但判据是零地块而不是那个串', () => {
    expect(EMPTY_MAP_PACK.version).toBe('empty');
    expect(EMPTY_MAP_PACK.tiles).toEqual([]);
    // 忘写 version 的真包不该被误判成空包
    const versionless = coerceMapPack(raw({ version: undefined }));
    expect(versionless.version).toBe('');
    expect(isEmptyMapPack(versionless)).toBe(false);
    // 反过来：版本戳写成 empty 的真包也不该被当成空包
    expect(isEmptyMapPack(coerceMapPack(raw({ version: 'empty' })))).toBe(false);
  });

  it('🔴 空包的费率与比例尺**不是 0** —— 0 会让每段路免费 / 天数变 Infinity', () => {
    expect(EMPTY_MAP_PACK.kmPerPx).toBeGreaterThan(0);
    expect(EMPTY_MAP_PACK.travelRules.rates.land).toBeGreaterThan(0);
    expect(EMPTY_MAP_PACK.travelRules.rates.nearSea).toBeGreaterThan(0);
    expect(EMPTY_MAP_PACK.travelRules.rates.farSea).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 缺节的包
// ═══════════════════════════════════════════════════════════

describe('coerceMapPack —— 缺节的包（每节各自回落，不连坐）', () => {
  it('只有 version 的包：全节空、规则恒等、判为空包', () => {
    const pack = coerceMapPack({ version: '0.1.0' });
    expect(pack.version).toBe('0.1.0');
    expect(pack.tiles).toEqual([]);
    expect(pack.countries).toEqual([]);
    expect(pack.midTiers).toEqual([]);
    expect(pack.climates).toEqual({});
    expect(pack.adjacency).toEqual([]);
    expect(pack.straits).toEqual([]);
    expect(pack.placeBindings).toEqual({});
    expect(pack.terrains).toEqual([]);
    expect(pack.travelRules).toEqual(EMPTY_MAP_PACK.travelRules);
    expect(isEmptyMapPack(pack)).toBe(true);
  });

  it('只有 tiles 的包：地块留下，其余节空（一节坏不拖累另一节）', () => {
    const pack = coerceMapPack({ tiles: fixture().tiles });
    expect(pack.tiles).toHaveLength(8);
    expect(pack.countries).toEqual([]);
    expect(pack.climates).toEqual({});
    expect(isEmptyMapPack(pack)).toBe(false);
  });

  it('缺 travelRules → 恒等规则（显眼地错，不是静默地像）', () => {
    const pack = coerceMapPack(raw({ travelRules: undefined }));
    expect(pack.travelRules.rates).toEqual({ land: 1, nearSea: 1, farSea: 1 });
    expect(pack.travelRules.embarkCost).toBe(0);
    expect(pack.travelRules.terrainFactor).toEqual({});
    expect(pack.travelRules.modes).toEqual([]);
  });

  it('modes：坏条目整条跳过、id 重复首见胜、缺席是空数组（v1.0.0 旧包照常吃）', () => {
    const pack = coerceMapPack(
      raw({
        travelRules: {
          rates: { land: 30, nearSea: 60, farSea: 120 },
          embarkCost: 1,
          terrainFactor: {},
          modes: [
            { id: 'carriage', label: '马车', factor: 1 },
            { id: 'walk', label: '步行', factor: 2 },
            { id: 'walk', label: '重复的步行', factor: 3 }, // 重复 id：首见胜
            { id: '', label: '无名', factor: 1 }, // 空 id
            { id: 'ghost', label: '', factor: 1 }, // 空 label
            { id: 'free', label: '免费', factor: 0 }, // 0 倍率 = 瞬移，拒收
            { id: 'slow', label: '龟速', factor: -2 }, // 负倍率
            { id: 'nan', label: '坏数', factor: 'fast' }, // 认不出
            'not-an-object',
          ],
        },
      }),
    );
    expect(pack.travelRules.modes).toEqual([
      { id: 'carriage', label: '马车', factor: 1 },
      { id: 'walk', label: '步行', factor: 2 },
    ]);
    // 旧包（没有 modes 字段）不受影响
    expect(coerceMapPack(raw({})).travelRules.modes).toEqual([]);
  });

  it('travelRules 单格坏只回落那一格', () => {
    const pack = coerceMapPack(
      raw({
        travelRules: {
          rates: { land: 30, nearSea: 'oops', farSea: 0 },
          embarkCost: -5,
          terrainFactor: { plains: 1.2, forest: 'bad', hills: -2, '': 9 },
        },
      }),
    );
    expect(pack.travelRules.rates.land).toBe(30);
    expect(pack.travelRules.rates.nearSea).toBe(1);
    // 🔴 0 费率会让 days = ceil(cost / 0) = Infinity —— 必须回落而不是收下
    expect(pack.travelRules.rates.farSea).toBe(1);
    expect(pack.travelRules.embarkCost).toBe(0);
    expect(pack.travelRules.terrainFactor).toEqual({ plains: 1.2 });
  });

  it('kmPerPx 为 0 / 负 / 认不出 → 回落 1（0 会让每段路都免费）', () => {
    expect(coerceMapPack(raw({ kmPerPx: 0 })).kmPerPx).toBe(1);
    expect(coerceMapPack(raw({ kmPerPx: -3 })).kmPerPx).toBe(1);
    expect(coerceMapPack(raw({ kmPerPx: 'wide' })).kmPerPx).toBe(1);
    expect(coerceMapPack(raw({ kmPerPx: '2.5' })).kmPerPx).toBe(2.5);
  });

  it('resolution 坏 → 0×0（UI 命中检测用，引擎不读像素）', () => {
    expect(coerceMapPack(raw({ resolution: 'big' })).resolution).toEqual({ w: 0, h: 0 });
    expect(coerceMapPack(raw({ resolution: { w: -5, h: 300 } })).resolution).toEqual({
      w: 0,
      h: 300,
    });
  });

  it('terrains 只留非空字符串并去重保序', () => {
    const pack = coerceMapPack(raw({ terrains: ['plains', '', 'plains', 7, null, 'forest'] }));
    expect(pack.terrains).toEqual(['plains', 'forest']);
  });
});

// ═══════════════════════════════════════════════════════════
// 地块逐条容错
// ═══════════════════════════════════════════════════════════

describe('coerceTiles —— 坏地块整条跳过，好地块一格不动', () => {
  function tilesOf(extra: unknown[]): ReturnType<typeof coerceMapPack>['tiles'] {
    return coerceMapPack(raw({ tiles: [...fixture().tiles, ...extra] })).tiles;
  }

  it('非对象条目跳过', () => {
    expect(tilesOf([null, 42, 'Alpha', [], undefined])).toHaveLength(8);
  });

  it('id 认不出跳过（NaN / 缺失 / 非数字串）', () => {
    const base = { name: 'Bad', terrain: 'plains', centroid: [1, 1] };
    expect(
      tilesOf([
        { ...base, id: Number.NaN },
        { ...base, id: 'not-a-number' },
        { ...base, id: undefined },
        { ...base, id: null },
        { ...base, id: {} },
      ]),
    ).toHaveLength(8);
  });

  it('🔴 `Number()` 的三个静默陷阱都堵住了 —— 空串/空数组/true 不许冒充地块 0 或 1', () => {
    const base = { name: 'Bad', terrain: 'plains', centroid: [1, 1] };
    const tiles = tilesOf([
      { ...base, id: '' },
      { ...base, id: '   ' },
      { ...base, id: [] },
      { ...base, id: true },
    ]);
    expect(tiles).toHaveLength(8);
    // 真实数据里 id 0 是保留 id（设计 §3.1 那条已知缺陷），冒充它的后果尤其坏
    expect(tiles.some((t) => t.name === 'Bad')).toBe(false);
  });

  it('数字串形态的 id 收下（pack 由 CSV 编译而来，"12" 很常见）', () => {
    const tiles = tilesOf([
      { id: '12', name: 'India', terrain: 'plains', centroid: ['5', '6'], areaPx: '77' },
    ]);
    const india = tiles.find((t) => t.name === 'India')!;
    expect(india.id).toBe(12);
    expect(india.centroid).toEqual([5, 6]);
    expect(india.areaPx).toBe(77);
  });

  it('name 空/非串跳过（既进不了绑定名字空间，兜底又只能泄 tileId 给 AI）', () => {
    const base = { id: 90, terrain: 'plains', centroid: [1, 1] };
    expect(
      tilesOf([
        { ...base, name: '' },
        { ...base, id: 91, name: 42 },
        { ...base, id: 92, name: undefined },
      ]),
    ).toHaveLength(8);
  });

  it('centroid 认不出跳过（[0,0] 兜底会让这块地静默贴在原点上）', () => {
    const base = { id: 93, name: 'Bad', terrain: 'plains' };
    expect(
      tilesOf([
        { ...base, centroid: undefined },
        { ...base, id: 94, centroid: [1] },
        { ...base, id: 95, centroid: [1, 'x'] },
        { ...base, id: 96, centroid: 'far' },
        { ...base, id: 97, centroid: [Number.NaN, 2] },
      ]),
    ).toHaveLength(8);
  });

  it('id 重复只留第一条（先到先得与遍历顺序无关）', () => {
    const tiles = tilesOf([
      { id: 1, name: 'Duplicate', terrain: 'ridge', centroid: [99, 99], areaPx: 1 },
    ]);
    expect(tiles).toHaveLength(8);
    expect(tiles.find((t) => t.id === 1)!.name).toBe('Alpha');
  });

  it('可选格坏只回落那一格：terrain 空串 / water null / impassable false / 外键 null', () => {
    const tiles = tilesOf([
      {
        id: 20,
        name: 'Juliett',
        terrain: 99,
        water: 'swamp',
        impassable: 'yes',
        countryId: '',
        midTierId: 7,
        centroid: [5, 5],
        areaPx: -3,
      },
    ]);
    const j = tiles.find((t) => t.name === 'Juliett')!;
    expect(j.terrain).toBe('');
    expect(j.water).toBeNull();
    // `'yes'` 是包写错了，不是另一种写「真」的方式 —— 只认布尔 true
    expect(j.impassable).toBe(false);
    expect(j.countryId).toBeNull();
    expect(j.midTierId).toBeNull();
    expect(j.areaPx).toBe(0);
  });

  it('未知地形照收（词汇由包定义，引擎不校验；系数在使用侧回退 1.0）', () => {
    const tiles = tilesOf([
      { id: 21, name: 'Kilo', terrain: 'never-seen-terrain', centroid: [1, 2] },
    ]);
    expect(tiles.find((t) => t.name === 'Kilo')!.terrain).toBe('never-seen-terrain');
  });
});

// ═══════════════════════════════════════════════════════════
// 块色（`color`）—— UI 把像素反查成地块的钥匙
// ═══════════════════════════════════════════════════════════

describe('地块块色 —— 权威色收下，坏色只丢这一格', () => {
  function tileOf(patch: Record<string, unknown>): MapPack['tiles'][number] | undefined {
    const item = { id: 40, name: 'Painted', terrain: 'plains', centroid: [1, 2], ...patch };
    return coerceMapPack(raw({ tiles: [item] })).tiles[0];
  }

  it('权威色原样收下（数字串通道也收 —— pack 由 CSV 编译而来）', () => {
    expect(tileOf({ color: [12, 34, 56] })!.color).toEqual([12, 34, 56]);
    expect(tileOf({ color: ['0', '128', '255'] })!.color).toEqual([0, 128, 255]);
    // 第四格（有些工具会补 alpha）不妨碍前三格
    expect(tileOf({ color: [1, 2, 3, 255] })!.color).toEqual([1, 2, 3]);
  });

  it('没写这一格的地块**不长出**它（缺席是合法的，UI 据此回落哈希重算）', () => {
    const tile = tileOf({})!;
    expect(tile.color).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(tile, 'color')).toBe(false);
  });

  it('混合包：写了的留着、没写的仍然缺席（可选格不是全有或全无）', () => {
    const pack = coerceMapPack(fixture());
    expect(pack.tiles.find((t) => t.id === 1)!.color).toEqual([12, 34, 56]);
    expect(pack.tiles.find((t) => t.id === 5)!.color).toEqual([200, 201, 202]);
    expect(pack.tiles.find((t) => t.id === 2)!.color).toBeUndefined();
  });

  it('🔴 坏色 → 缺席（**不是** [0,0,0]）：地块色是反查像素的钥匙，凭空的纯黑会认成「未绘制」', () => {
    for (const bad of [
      'red',
      42,
      null,
      {},
      [1, 2], // 长度不足
      [1, 2, 'x'], // 通道认不出
      [1, 2, Number.NaN],
      [1, 2, null],
      [-1, 2, 3], // 越界：`& 255` 会把它换成另一个颜色，那是替包发明数据
      [1, 2, 256],
      [1, 2, 3.5], // 通道不可能有小数，圆整它等于猜
    ]) {
      expect(tileOf({ color: bad })!.color).toBeUndefined();
    }
  });

  it('坏色**不丢地块**（它仍要在图上占位、仍要有名字与形心）', () => {
    const tile = tileOf({ color: 'red' })!;
    expect(tile.id).toBe(40);
    expect(tile.name).toBe('Painted');
    expect(tile.centroid).toEqual([1, 2]);
  });

  it('🔴 与国家色刻意不同口径：国家坏色回落 [0,0,0]，地块坏色是缺席', () => {
    const pack = coerceMapPack(
      raw({
        countries: [{ id: 'x', name: 'X', color: 'not-a-color', anchorTileId: null }],
        tiles: [{ id: 41, name: 'Quebec', terrain: 'plains', centroid: [1, 1], color: 'nope' }],
      }),
    );
    // 国家色画成黑就行（看得见、引擎不读）；地块色不能猜（猜错 = 整块地画错/点错）
    expect(pack.countries[0]!.color).toEqual([0, 0, 0]);
    expect(pack.tiles[0]!.color).toBeUndefined();
  });

  it('边界值 0 / 255 照收 —— 纯黑该不该用是 UI 那一层的判断，不在这里改数据', () => {
    expect(tileOf({ color: [0, 0, 0] })!.color).toEqual([0, 0, 0]);
    expect(tileOf({ color: [255, 255, 255] })!.color).toEqual([255, 255, 255]);
  });
});

// ═══════════════════════════════════════════════════════════
// v1.2.0 三格：developmentLevels / tile.development / tile.buildings
// ═══════════════════════════════════════════════════════════

describe('developmentLevels —— 档名表是**序数表**，不是集合', () => {
  it('合法表原样收下（词汇随包，引擎不认识任何一档）', () => {
    expect(coerceMapPack(fixture()).developmentLevels).toEqual(FIXTURE.developmentLevels);
  });

  it('缺席 / 整节坏 → 空表（v1.0/v1.1 旧包照常吃）', () => {
    expect(coerceMapPack(raw({ developmentLevels: undefined })).developmentLevels).toEqual([]);
    expect(coerceMapPack(raw({ developmentLevels: 'ten' })).developmentLevels).toEqual([]);
    expect(coerceMapPack(raw({ developmentLevels: {} })).developmentLevels).toEqual([]);
    expect(coerceMapPack(raw({ developmentLevels: 10 })).developmentLevels).toEqual([]);
    expect(coerceMapPack({ version: '1.0.0' }).developmentLevels).toEqual([]);
    expect(EMPTY_MAP_PACK.developmentLevels).toEqual([]);
  });

  it('坏条目跳过（空串 / 非串），好条目保序', () => {
    const pack = coerceMapPack(raw({ developmentLevels: ['a', '', 7, null, 'b', {}, 'c'] }));
    expect(pack.developmentLevels).toEqual(['a', 'b', 'c']);
  });

  it('🔴 **不去重** —— 丢掉重名会让它后面每一档的序号整体前移', () => {
    const pack = coerceMapPack(raw({ developmentLevels: ['a', 'a', 'b'] }));
    expect(pack.developmentLevels).toEqual(['a', 'a', 'b']);
  });

  it('多于 10 档砍掉尾部（超出的档位引擎永远到不了）；少于 10 档照收，不补', () => {
    const many = Array.from({ length: 14 }, (_, i) => `L${i + 1}`);
    expect(coerceMapPack(raw({ developmentLevels: many })).developmentLevels).toHaveLength(10);
    expect(coerceMapPack(raw({ developmentLevels: many })).developmentLevels?.[9]).toBe('L10');
    expect(coerceMapPack(raw({ developmentLevels: ['a', 'b'] })).developmentLevels).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('tile.development —— 起始档：整数、钳进 1..10、认不出即缺席', () => {
  function tileOf(patch: Record<string, unknown>): MapPack['tiles'][number] {
    const item = { id: 50, name: 'Dev', terrain: 'plains', centroid: [1, 2], ...patch };
    return coerceMapPack(raw({ tiles: [item] })).tiles[0]!;
  }

  it('合法档原样收下（数字串也收 —— pack 由 CSV 编译而来）', () => {
    expect(tileOf({ development: 1 }).development).toBe(1);
    expect(tileOf({ development: 7 }).development).toBe(7);
    expect(tileOf({ development: 10 }).development).toBe(10);
    expect(tileOf({ development: '4' }).development).toBe(4);
  });

  it('🔴 缺席**不是档 1** —— 那格根本不长出来（海/湖/不可通行块的常态）', () => {
    const tile = tileOf({});
    expect(tile.development).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(tile, 'development')).toBe(false);
  });

  it('越界钳进合法带（12 档的地块会长出 12 个建筑槽，那是内容错在机制面的放大）', () => {
    expect(tileOf({ development: 0 }).development).toBe(1);
    expect(tileOf({ development: -4 }).development).toBe(1);
    expect(tileOf({ development: 12 }).development).toBe(10);
    expect(tileOf({ development: 999 }).development).toBe(10);
  });

  it('小数 / 认不出 / Number 陷阱值 → 缺席（档位是序数，圆整它等于猜）', () => {
    for (const bad of [3.5, 'high', '', '   ', [], true, null, {}, Number.NaN, Infinity]) {
      expect(tileOf({ development: bad }).development).toBeUndefined();
    }
  });

  it('坏档不丢地块（它仍要在图上占位）', () => {
    expect(tileOf({ development: 'high' }).name).toBe('Dev');
  });
});

describe('tile.buildings —— 初始建筑基线：坏条目跳过、同名首见胜、缺席即缺席', () => {
  function tileOf(patch: Record<string, unknown>): MapPack['tiles'][number] {
    const item = { id: 51, name: 'Built', terrain: 'plains', centroid: [1, 2], ...patch };
    return coerceMapPack(raw({ tiles: [item] })).tiles[0]!;
  }

  it('合法清单原样收下（三个字段齐全）', () => {
    const tile = tileOf({
      buildings: [
        { name: 'Mill', description: 'A mill.', ownerFlavor: 'Miller' },
        { name: 'Forge' },
      ],
    });
    expect(tile.buildings).toEqual([
      { name: 'Mill', description: 'A mill.', ownerFlavor: 'Miller' },
      { name: 'Forge' },
    ]);
  });

  it('缺席 / 非数组 → 那格不长出来（旧包逐字节等于从前）', () => {
    for (const bad of [undefined, 'Mill', 42, {}, null]) {
      const tile = tileOf(bad === undefined ? {} : { buildings: bad });
      expect(tile.buildings).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(tile, 'buildings')).toBe(false);
    }
  });

  it('name 空/非串 → 整条跳过（name 是地块内逻辑键，没有它无法被 op 寻址）', () => {
    const tile = tileOf({
      buildings: [
        { name: 'Mill' },
        { name: '' },
        { name: 42 },
        { description: 'nameless' },
        null,
        'Forge',
        [],
      ],
    });
    expect(tile.buildings).toEqual([{ name: 'Mill' }]);
  });

  it('同名首见胜（后来者整条丢，先到先得与遍历顺序无关）', () => {
    const tile = tileOf({
      buildings: [
        { name: 'Mill', description: 'first' },
        { name: 'Mill', description: 'impostor' },
      ],
    });
    expect(tile.buildings).toEqual([{ name: 'Mill', description: 'first' }]);
  });

  it('可选格坏只丢那一格（description / ownerFlavor 空串或非串 = 没写）', () => {
    const tile = tileOf({
      buildings: [{ name: 'Mill', description: '', ownerFlavor: 42 }],
    });
    expect(tile.buildings).toEqual([{ name: 'Mill' }]);
    expect(Object.prototype.hasOwnProperty.call(tile.buildings![0]!, 'description')).toBe(false);
  });

  it('🔴 `playerOwned` / `income` 不收 —— 所有权翻转只经叙事 op（裁定 §8-9）', () => {
    const tile = tileOf({
      buildings: [{ name: 'Mill', playerOwned: true, income: { amount: 100, periodDays: 30 } }],
    });
    expect(tile.buildings).toEqual([{ name: 'Mill' }]);
  });

  it('整份坏条目 → 空数组（数组在，只是一条都没剩），不是缺席', () => {
    expect(tileOf({ buildings: [null, 42, { name: '' }] }).buildings).toEqual([]);
  });

  it('条数不按起始档裁（verify 门的判据，运行时静默截断会丢作者写的建筑）', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `B${i}` }));
    expect(tileOf({ development: 2, buildings: many }).buildings).toHaveLength(12);
  });
});

describe('mainBuildingNames —— 主建筑通名表（与档名表同一套序数表规则）', () => {
  it('合法表原样收下（词汇随包，引擎不认识任何一档）', () => {
    expect(coerceMapPack(fixture()).mainBuildingNames).toEqual(FIXTURE.mainBuildingNames);
  });

  it('缺席 / 整节坏 → 空表（v1.0/v1.1 旧包照常吃；派生名走引擎的 ASCII 兜底）', () => {
    expect(coerceMapPack(raw({ mainBuildingNames: undefined })).mainBuildingNames).toEqual([]);
    expect(coerceMapPack(raw({ mainBuildingNames: 'castle' })).mainBuildingNames).toEqual([]);
    expect(coerceMapPack(raw({ mainBuildingNames: {} })).mainBuildingNames).toEqual([]);
    expect(coerceMapPack(raw({ mainBuildingNames: 10 })).mainBuildingNames).toEqual([]);
    expect(coerceMapPack({ version: '1.0.0' }).mainBuildingNames).toEqual([]);
    expect(EMPTY_MAP_PACK.mainBuildingNames).toEqual([]);
  });

  it('坏条目跳过、好条目保序、**不去重**（丢一行会让后面每一档的通名整体前移）', () => {
    const pack = coerceMapPack(raw({ mainBuildingNames: ['a', '', 7, null, 'a', {}, 'b'] }));
    expect(pack.mainBuildingNames).toEqual(['a', 'a', 'b']);
  });

  it('多于 10 档砍掉尾部；少于 10 档照收，不补', () => {
    const many = Array.from({ length: 13 }, (_, i) => `S${i + 1}`);
    expect(coerceMapPack(raw({ mainBuildingNames: many })).mainBuildingNames).toHaveLength(10);
    expect(coerceMapPack(raw({ mainBuildingNames: many })).mainBuildingNames?.[9]).toBe('S10');
    expect(coerceMapPack(raw({ mainBuildingNames: ['a'] })).mainBuildingNames).toEqual(['a']);
  });

  it('🔴 两张序数表互不影响（一张坏了不该把另一张也清空）', () => {
    const pack = coerceMapPack(raw({ mainBuildingNames: 'nope' }));
    expect(pack.mainBuildingNames).toEqual([]);
    expect(pack.developmentLevels).toEqual(FIXTURE.developmentLevels);
  });
});

describe('tile.mainBuilding —— 主建筑作者命名：坏值即缺席，绝不替作者兜一个名字', () => {
  function tileOf(patch: Record<string, unknown>): MapPack['tiles'][number] {
    const item = { id: 52, name: 'Seat', terrain: 'plains', centroid: [1, 2], ...patch };
    return coerceMapPack(raw({ tiles: [item] })).tiles[0]!;
  }

  it('合法条目原样收下（三个字段齐全）', () => {
    const tile = tileOf({
      mainBuilding: { name: 'Great Hall', description: 'The seat.', ownerFlavor: 'Lord' },
    });
    expect(tile.mainBuilding).toEqual({
      name: 'Great Hall',
      description: 'The seat.',
      ownerFlavor: 'Lord',
    });
  });

  it('🔴 缺席 / 非对象 / 无名 → 那一格不长出来（**不是**「这块地没有主建筑」，只是没被点名）', () => {
    for (const bad of [undefined, 'Hall', 42, [], null, {}, { name: '' }, { name: 42 }]) {
      const tile = tileOf(bad === undefined ? {} : { mainBuilding: bad });
      expect(tile.mainBuilding).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(tile, 'mainBuilding')).toBe(false);
    }
  });

  it('可选格坏只丢那一格（description / ownerFlavor 空串或非串 = 没写）', () => {
    const tile = tileOf({ mainBuilding: { name: 'Hall', description: '', ownerFlavor: 42 } });
    expect(tile.mainBuilding).toEqual({ name: 'Hall' });
  });

  it('🔴 `playerOwned` / `income` 不收 —— 所有权翻转只经叙事 op（裁定 §8-9·§8-19）', () => {
    const tile = tileOf({
      mainBuilding: { name: 'Hall', playerOwned: true, income: { amount: 200, periodDays: 30 } },
    });
    expect(tile.mainBuilding).toEqual({ name: 'Hall' });
  });

  it('坏值不丢地块，也不影响同地块的 buildings 那一格', () => {
    const tile = tileOf({ mainBuilding: 'Hall', buildings: [{ name: 'Mill' }] });
    expect(tile.name).toBe('Seat');
    expect(tile.buildings).toEqual([{ name: 'Mill' }]);
  });
});

// ═══════════════════════════════════════════════════════════
// v1.0 / v1.1 旧包
// ═══════════════════════════════════════════════════════════

describe('旧包（v1.0 / v1.1）—— 五格缺席时逐字节等于从前', () => {
  /** 把 v1.2.0 夹具剥回 v1.1 形状（去掉两张序数表与三个地块格） */
  function legacyRaw(): Record<string, unknown> {
    const pack = fixture() as unknown as Record<string, unknown>;
    delete pack.developmentLevels;
    delete pack.mainBuildingNames;
    pack.tiles = (pack.tiles as Record<string, unknown>[]).map((tile) => {
      const copy = { ...tile };
      delete copy.development;
      delete copy.buildings;
      delete copy.mainBuilding;
      return copy;
    });
    return pack;
  }

  it('旧包的地块一格不多长（development / buildings / mainBuilding 都不出现）', () => {
    const pack = coerceMapPack(legacyRaw());
    for (const tile of pack.tiles) {
      expect(Object.prototype.hasOwnProperty.call(tile, 'development')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(tile, 'buildings')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(tile, 'mainBuilding')).toBe(false);
    }
  });

  it('旧包除两张序数表变空数组外，其余节逐字段等于旧口径', () => {
    const pack = coerceMapPack(legacyRaw());
    expect(pack.developmentLevels).toEqual([]);
    expect(pack.mainBuildingNames).toEqual([]);
    const { developmentLevels: _levels, mainBuildingNames: _seats, ...rest } = pack;
    const expected = legacyRaw() as unknown as Omit<
      MapPack,
      'developmentLevels' | 'mainBuildingNames'
    >;
    expect(rest).toEqual(expected);
  });
});

// ═══════════════════════════════════════════════════════════
// water ∩ impassable
// ═══════════════════════════════════════════════════════════

describe('water ∩ impassable —— 保 impassable，water 打回 null', () => {
  it('声明为不可通行的海块：impassable 留真、water 变 null', () => {
    const tiles = fixture().tiles.map((t) => (t.id === 5 ? { ...t, impassable: true } : t));
    const pack = coerceMapPack(raw({ tiles }));
    const echo = pack.tiles.find((t) => t.id === 5)!;
    expect(echo.impassable).toBe(true);
    expect(echo.water).toBeNull();
  });

  it('声明为不可通行的湖块同理（旋涡级危险水域正是用 impassable 标的）', () => {
    const tiles = fixture().tiles.map((t) => (t.id === 7 ? { ...t, impassable: true } : t));
    const golf = coerceMapPack(raw({ tiles })).tiles.find((t) => t.id === 7)!;
    expect(golf.impassable).toBe(true);
    expect(golf.water).toBeNull();
  });

  it('地块不因这个冲突被丢掉（它仍要在图上占位、仍要有名字）', () => {
    const tiles = fixture().tiles.map((t) => (t.id === 5 ? { ...t, impassable: true } : t));
    expect(coerceMapPack(raw({ tiles })).tiles).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════
// 悬空引用
// ═══════════════════════════════════════════════════════════

describe('邻接 / 海峡 —— 悬空、自环、重复一律丢', () => {
  it('端点指向不存在的地块 → 丢边（留着会让路径从中间断掉）', () => {
    const pack = coerceMapPack(
      raw({
        adjacency: [
          [1, 2, 100],
          [1, 999, 50],
          [999, 998, 50],
        ],
      }),
    );
    expect(pack.adjacency).toEqual([[1, 2, 100]]);
  });

  it('地块被跳过时，它的邻接边跟着被清（不留半条边）', () => {
    // 地块 2 的 centroid 坏 → 整块跳过 → 所有以它为端点的边都该消失
    const tiles = fixture().tiles.map((t) => (t.id === 2 ? { ...t, centroid: [1] } : t));
    const pack = coerceMapPack(raw({ tiles }));
    expect(pack.tiles.some((t) => t.id === 2)).toBe(false);
    expect(pack.adjacency.some(([a, b]) => a === 2 || b === 2)).toBe(false);
  });

  it('自环丢（Dijkstra 里是纯噪声）', () => {
    expect(coerceMapPack(raw({ adjacency: [[3, 3, 10]] })).adjacency).toEqual([]);
  });

  it('端点认不出 / 长度不足 / 非数组 → 丢', () => {
    const pack = coerceMapPack(
      raw({
        adjacency: [
          [1, 2, 100],
          [1],
          ['x', 2, 5],
          [1, Number.NaN, 5],
          null,
          42,
          { a: 1, b: 2 },
          [true, 2, 5],
        ],
      }),
    );
    expect(pack.adjacency).toEqual([[1, 2, 100]]);
  });

  it('无向去重：反向重复只留第一条（共享边长以第一条为准）', () => {
    const pack = coerceMapPack(
      raw({
        adjacency: [
          [1, 2, 100],
          [2, 1, 7],
          [1, 2, 9],
        ],
      }),
    );
    expect(pack.adjacency).toEqual([[1, 2, 100]]);
  });

  it('共享边长缺席/坏/负 → 0（它不影响连通性）', () => {
    const pack = coerceMapPack(
      raw({
        adjacency: [
          [1, 2],
          [2, 3, 'wide'],
          [1, 4, -8],
        ],
      }),
    );
    expect(pack.adjacency).toEqual([
      [1, 2, 0],
      [2, 3, 0],
      [1, 4, 0],
    ]);
  });

  it('海峡表同判据，且产物是两元组', () => {
    const pack = coerceMapPack(
      raw({
        straits: [[5, 3], [5, 999], [4, 4], [3, 5], 'nope'],
      }),
    );
    expect(pack.straits).toEqual([[5, 3]]);
  });
});

describe('placeBindings —— 绑定名字空间只收落得下去的名字', () => {
  it('悬空 tileId 丢（落位「成功」到虚空比落位失败更坏）', () => {
    const pack = coerceMapPack(raw({ placeBindings: { 'Alpha Town': 1, 'Ghost Town': 999 } }));
    expect(pack.placeBindings).toEqual({ 'Alpha Town': 1 });
  });

  it('空键 / 认不出的值 / Number 陷阱值一律丢', () => {
    const pack = coerceMapPack(
      raw({
        placeBindings: {
          'Alpha Town': 1,
          '': 2,
          'Bad One': 'x',
          'Bad Two': '',
          'Bad Three': true,
          'Bad Four': null,
          'Numeric String': '3',
        },
      }),
    );
    expect(pack.placeBindings).toEqual({ 'Alpha Town': 1, 'Numeric String': 3 });
  });

  it('整节坏 → 空表', () => {
    expect(coerceMapPack(raw({ placeBindings: ['Alpha Town'] })).placeBindings).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
// 国家 / 中层
// ═══════════════════════════════════════════════════════════

describe('coerceCountries / coerceMidTiers', () => {
  it('id 缺失或重复 → 整条跳过 / 只留第一条', () => {
    const pack = coerceMapPack(
      raw({
        countries: [
          { id: 'north', name: 'Northland', color: [10, 20, 30], anchorTileId: 1 },
          { name: 'Nameless', color: [1, 2, 3] },
          { id: '', name: 'Blank' },
          { id: 'north', name: 'Impostor' },
          null,
          'north',
        ],
      }),
    );
    expect(pack.countries).toHaveLength(1);
    expect(pack.countries[0]!.name).toBe('Northland');
  });

  it('name 缺失回落 id（不是中文默认名 —— 引擎里没有任何词汇）', () => {
    const pack = coerceMapPack(raw({ countries: [{ id: 'north' }] }));
    expect(pack.countries[0]!.name).toBe('north');
  });

  it('color 坏 → 全 0（UI 画成黑，看得见；引擎不读颜色）', () => {
    const pack = coerceMapPack(
      raw({
        countries: [
          { id: 'a', color: 'red' },
          { id: 'b', color: [1, 2] },
          { id: 'c', color: [1, 'x', 3] },
          { id: 'd', color: ['4', '5', '6'] },
        ],
      }),
    );
    expect(pack.countries.map((c) => c.color)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [4, 5, 6],
    ]);
  });

  it('unclaimed 只在布尔真时出现（`"true"` 这种串不当真）', () => {
    const pack = coerceMapPack(
      raw({
        countries: [{ id: 'a', unclaimed: true }, { id: 'b', unclaimed: 'true' }, { id: 'c' }],
      }),
    );
    expect(pack.countries[0]!.unclaimed).toBe(true);
    expect(pack.countries[1]!.unclaimed).toBeUndefined();
    expect(pack.countries[2]!.unclaimed).toBeUndefined();
  });

  it('悬空 anchorTileId → null（国家/中层本身保留，名字仍要用于圈域）', () => {
    const pack = coerceMapPack(
      raw({
        countries: [{ id: 'north', name: 'Northland', color: [1, 1, 1], anchorTileId: 999 }],
        midTiers: [
          {
            id: 'north-a',
            name: 'North Vale',
            countryId: 'north',
            climateId: 'zone-cold',
            anchorTileId: 999,
          },
        ],
      }),
    );
    expect(pack.countries).toHaveLength(1);
    expect(pack.countries[0]!.anchorTileId).toBeNull();
    expect(pack.midTiers).toHaveLength(1);
    expect(pack.midTiers[0]!.anchorTileId).toBeNull();
  });

  it('anchorTileId 认不出 → null；指向真地块 → 收下', () => {
    const pack = coerceMapPack(
      raw({
        countries: [{ id: 'a', anchorTileId: 'x' }, { id: 'b', anchorTileId: '3' }, { id: 'c' }],
      }),
    );
    expect(pack.countries.map((c) => c.anchorTileId)).toEqual([null, 3, null]);
  });

  it('中层的 countryId / climateId 认不出 → 空串（外键未命中在使用侧兜底，不整条丢）', () => {
    const pack = coerceMapPack(
      raw({ midTiers: [{ id: 'orphan', countryId: 42, climateId: undefined }] }),
    );
    expect(pack.midTiers).toEqual([
      { id: 'orphan', name: 'orphan', countryId: '', climateId: '', anchorTileId: null },
    ]);
  });

  it('中层指向不存在的国家/气候区照收（那是查表未命中，不是悬空图节点）', () => {
    const pack = coerceMapPack(
      raw({ midTiers: [{ id: 'x', countryId: 'no-such', climateId: 'no-such' }] }),
    );
    expect(pack.midTiers[0]!.countryId).toBe('no-such');
    expect(pack.midTiers[0]!.climateId).toBe('no-such');
  });
});

// ═══════════════════════════════════════════════════════════
// 气候
// ═══════════════════════════════════════════════════════════

describe('coerceClimates —— 加权天气表', () => {
  it('值不是对象 → 整个气候区跳过', () => {
    const pack = coerceMapPack(
      raw({ climates: { good: { name: 'Good', table: {} }, bad: 42, worse: null } }),
    );
    expect(Object.keys(pack.climates)).toEqual(['good']);
  });

  it('name 缺失回落气候区 id', () => {
    const pack = coerceMapPack(raw({ climates: { 'zone-x': { table: {} } } }));
    expect(pack.climates['zone-x']!.name).toBe('zone-x');
  });

  it('权重 ≤ 0 / 认不出的行丢掉（0 权重永远采样不到，负权重会把加权采样弄坏）', () => {
    const pack = coerceMapPack(
      raw({
        climates: {
          z: {
            name: 'Z',
            table: {
              spring: [
                ['clear', 3],
                ['rain', 0],
                ['snow', -2],
                ['fog', 'heavy'],
                ['', 5],
                ['hail'],
                'sunny',
                ['storm', '4'],
              ],
            },
          },
        },
      }),
    );
    expect(pack.climates['z']!.table['spring']).toEqual([
      ['clear', 3],
      ['storm', 4],
    ]);
  });

  it('某季节剩 0 行 → 连键一起丢（空表与缺席必须走同一条兜底）', () => {
    const pack = coerceMapPack(
      raw({
        climates: {
          z: { name: 'Z', table: { spring: [['clear', 1]], winter: [['snow', 0]], summer: [] } },
        },
      }),
    );
    expect(Object.keys(pack.climates['z']!.table)).toEqual(['spring']);
  });

  it('table 缺失/坏 → 空表，但气候区仍在（名字还有用）', () => {
    const pack = coerceMapPack(raw({ climates: { z: { name: 'Z', table: 'sunny' } } }));
    expect(pack.climates['z']).toEqual({ name: 'Z', table: {} });
  });

  it('季节键与天气标签的词汇由包定义 —— 引擎照收任何串', () => {
    const pack = coerceMapPack(
      raw({ climates: { z: { name: 'Z', table: { 'thirteenth-moon': [['ash-fall', 2]] } } } }),
    );
    expect(pack.climates['z']!.table['thirteenth-moon']).toEqual([['ash-fall', 2]]);
  });

  it('整节坏 → 空表', () => {
    expect(coerceMapPack(raw({ climates: [1, 2] })).climates).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
// 永不抛
// ═══════════════════════════════════════════════════════════

describe('coerceMapPack —— 永不抛（整条链的最后一道兜底）', () => {
  const hostile: unknown[] = [
    {},
    { tiles: {} },
    { tiles: [[]], adjacency: {}, straits: 1, climates: 'x', placeBindings: 2 },
    { tiles: [{ id: 1, name: 'A', centroid: [0, 0] }], adjacency: [[1, 1, 1]] },
    { travelRules: { rates: 'fast' } },
    { travelRules: { rates: { land: Number.POSITIVE_INFINITY } } },
    { resolution: [] },
    { terrains: 'plains' },
    { countries: {}, midTiers: 'none' },
    Object.create(null) as unknown,
    { tiles: [Object.create(null)] },
    { version: 123, contentHash: [], kmPerPx: [] },
  ];

  for (const [index, input] of hostile.entries()) {
    it(`敌意输入 #${index} 不抛且产物形状合法`, () => {
      expect(() => coerceMapPack(input)).not.toThrow();
      const pack = coerceMapPack(input);
      expect(Array.isArray(pack.tiles)).toBe(true);
      expect(Array.isArray(pack.adjacency)).toBe(true);
      expect(Array.isArray(pack.straits)).toBe(true);
      expect(Array.isArray(pack.terrains)).toBe(true);
      expect(typeof pack.version).toBe('string');
      expect(typeof pack.contentHash).toBe('string');
      expect(Number.isFinite(pack.kmPerPx)).toBe(true);
      expect(pack.kmPerPx).toBeGreaterThan(0);
      expect(Number.isFinite(pack.travelRules.rates.land)).toBe(true);
      expect(pack.travelRules.rates.land).toBeGreaterThan(0);
    });
  }

  it('Infinity 费率被当作认不出（`Number.isFinite` 是判据）', () => {
    const pack = coerceMapPack(
      raw({ travelRules: { rates: { land: Number.POSITIVE_INFINITY, nearSea: 60, farSea: 120 } } }),
    );
    expect(pack.travelRules.rates.land).toBe(1);
    expect(pack.travelRules.rates.nearSea).toBe(60);
  });
});
