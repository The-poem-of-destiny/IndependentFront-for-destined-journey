/**
 * map-dynamics.test.ts — 地块事实态纯函数叶的契约测试（地图 v1.2 / ADR-33）
 *
 * 夹具规矩（设计 §10 + D25①）：**零真实地名**。地块名/地形词全是合成的中立英文串 ——
 * 引擎不认识它们，这正是「换图零改码」要的形状。
 *
 * 这份测试盯的几乎全是「错了也不会报错」的那类契约：
 *   · 降档摧毁**最高号槽**（挑错一座建筑毁掉，表现只是「我的磨坊怎么没了」）
 *   · 首访条目在 FIFO 压力下**钉住不淘汰**（它天然是最老的一条，纯 FIFO 会最先吃掉它）
 *   · 中途到期的状态**仍贡献到期前的节拍**（少算/多算都只是数字不一样）
 *   · 休眠地块**冻结**（换包再换回来时一次性补账，且发生在玩家看不见的地方）
 */

import { describe, expect, it } from 'vitest';

import {
  DEV_PROGRESS_MAX,
  DEV_PROGRESS_MIN,
  DEV_PROGRESS_PERIOD_DAYS,
  MAX_DEV_LEVEL,
  MIN_DEV_LEVEL,
  TILE_HISTORY_LIMIT,
  applyBuildingAdd,
  applyBuildingUpdate,
  applyDevProgressDelta,
  applyMainBuildingUpdate,
  applyTileStatusAdd,
  applyTileStatusRemove,
  effectiveTileFacts,
  hasDevelopment,
  recordFirstVisit,
  recordTileHistory,
  resolveMainBuilding,
  seedTileFacts,
  settleMapFacts,
  settleTileFacts,
  type BuildingAddResult,
  type BuildingPatch,
  type EffectiveTileFacts,
  type MainBuildingUpdateOptions,
  type MapSettlementEvent,
  type MapSettlementResult,
  type SettlementEvent,
  type TileDevDeltaOptions,
  type TileDevDeltaResult,
  type TileSettlementResult,
} from './map-dynamics';
import type { MapFactsFlags, MapPack, MapTile, TileFactsEntry, TileStatus } from './types-map';

// ══════════════════════════════════════════════════════════════
// 夹具（4 块地：有初始建筑的陆块 / 无 development 格的旧包陆块 / 海 / 不可通行）
// ══════════════════════════════════════════════════════════════

const TILE_HEARTH = 1;
const TILE_MEADOW = 2;
const TILE_SHELF = 3;
const TILE_RIDGE = 4;
const TILE_BASTION = 5;

/**
 * 主建筑通名表（10 档，零真实地名）。刻意**只给 3 档**留空以外的全部值？不 ——
 * 给满 10 档，缺行兜底另有专门用例（表本身可以缺，见「派生名」那一组）。
 */
const MAIN_NAMES = [
  'Camp',
  'Hamlet Hall',
  'Village Hall',
  'Town Hall',
  'Borough Hall',
  'City Hall',
  'Grand Hall',
  'Palace',
  'Great Palace',
  'Crown Seat',
];

function makeTile(overrides: Partial<MapTile> & Pick<MapTile, 'id' | 'name'>): MapTile {
  return {
    terrain: 'flatland',
    water: null,
    impassable: false,
    countryId: 'c-alpha',
    midTierId: null,
    centroid: [0, 0],
    areaPx: 100,
    ...overrides,
  };
}

function makePack(): MapPack {
  return {
    version: '0.0.0-fixture',
    contentHash: 'fixture-hash',
    resolution: { w: 100, h: 100 },
    kmPerPx: 1,
    terrains: ['flatland', 'shelf', 'crag'],
    travelRules: {
      rates: { land: 40, nearSea: 60, farSea: 100 },
      embarkCost: 20,
      terrainFactor: {},
      modes: [],
    },
    countries: [
      { id: 'c-alpha', name: 'Alpha Realm', color: [1, 2, 3], anchorTileId: TILE_HEARTH },
    ],
    midTiers: [],
    climates: {},
    tiles: [
      makeTile({
        id: TILE_HEARTH,
        name: 'Hearth',
        development: 3,
        buildings: [
          { name: 'Mill', description: 'a mill', ownerFlavor: 'guild' },
          { name: 'Well' },
        ],
      }),
      // 旧包（v1.0/v1.1）常态：陆块但没有 development 那一格 → 读作最低档
      makeTile({ id: TILE_MEADOW, name: 'Meadow' }),
      makeTile({ id: TILE_SHELF, name: 'Shelf', terrain: 'shelf', water: 'sea', development: 4 }),
      makeTile({ id: TILE_RIDGE, name: 'Ridge', terrain: 'crag', impassable: true }),
      // 作者点名了主建筑的地块（§F4b）：它的名字**不随档变**
      makeTile({
        id: TILE_BASTION,
        name: 'Bastion',
        development: 2,
        mainBuilding: { name: 'Old Keep', description: 'stone and moss', ownerFlavor: 'the baron' },
      }),
    ],
    adjacency: [],
    straits: [],
    placeBindings: {},
    developmentLevels: [],
  };
}

const PACK = makePack();

function tileByName(name: string): MapTile {
  const tile = PACK.tiles.find((t) => t.name === name);
  if (!tile) throw new Error(`fixture tile missing: ${name}`);
  return tile;
}

const HEARTH = tileByName('Hearth');
const MEADOW = tileByName('Meadow');
const SHELF = tileByName('Shelf');
const RIDGE = tileByName('Ridge');
const BASTION = tileByName('Bastion');

function makeStatus(overrides: Partial<TileStatus> & Pick<TileStatus, 'title'>): TileStatus {
  return {
    description: '',
    effects: [],
    durationDays: -1,
    appliedAtDay: 0,
    ...overrides,
  };
}

/** 直接搭一个「已播种」的条目，省去每个用例重复调 seedTileFacts */
function makeEntry(level: number, buildings: (string | null)[], progress = 0): TileFactsEntry {
  return {
    seededAtDay: 0,
    development: { level, progress },
    statuses: [],
    buildings: buildings.map((name) => (name === null ? null : { name })),
    history: [],
  };
}

/** 取事件流里被摧毁的建筑名（按发生顺序） */
function destroyedNames(events: SettlementEvent[]): string[] {
  return events
    .filter((e): e is Extract<SettlementEvent, { kind: 'buildingDestroyed' }> => {
      return e.kind === 'buildingDestroyed';
    })
    .map((e) => e.building);
}

// ══════════════════════════════════════════════════════════════
// 有效视图 + 播种
// ══════════════════════════════════════════════════════════════

describe('hasDevelopment —— 只有可通行陆块有发展度（裁定 §8-1）', () => {
  it('陆块 true，海与不可通行块 false（哪怕包里写了档位）', () => {
    expect(hasDevelopment(HEARTH)).toBe(true);
    expect(hasDevelopment(MEADOW)).toBe(true);
    expect(hasDevelopment(SHELF)).toBe(false);
    expect(hasDevelopment(RIDGE)).toBe(false);
  });
});

describe('effectiveTileFacts —— pack 基线 ⊕ 事实', () => {
  it('没有事实条目时全取 pack 基线：档 3 / 进度 0 / 3 槽 / 初始建筑落最小槽', () => {
    const view: EffectiveTileFacts = effectiveTileFacts(HEARTH, undefined);
    expect(view.seeded).toBe(false);
    expect(view.level).toBe(3);
    expect(view.progress).toBe(0);
    expect(view.slots).toBe(3);
    expect(view.buildings.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well', null]);
  });

  it('旧包缺 development 格的陆块读作最低档（不是「没有发展度」）', () => {
    const view = effectiveTileFacts(MEADOW, undefined);
    expect(view.hasDevelopment).toBe(true);
    expect(view.level).toBe(MIN_DEV_LEVEL);
    expect(view.slots).toBe(1);
  });

  it('海/不可通行块没有发展面，但状态照读', () => {
    const entry = { statuses: [makeStatus({ title: 'Squall' })], history: [] };
    const view = effectiveTileFacts(SHELF, entry);
    expect(view.hasDevelopment).toBe(false);
    expect(view.level).toBeNull();
    expect(view.progress).toBeNull();
    expect(view.slots).toBe(0);
    expect(view.buildings).toEqual([]);
    expect(view.statuses).toHaveLength(1);
    expect(effectiveTileFacts(RIDGE, undefined).level).toBeNull();
  });

  it('有事实条目时事实为权威（被毁的初始建筑不会因为重读 pack 而复活）', () => {
    const entry = makeEntry(3, [null, 'Well', null]);
    const view = effectiveTileFacts(HEARTH, entry);
    expect(view.buildings.map((b) => b?.name ?? null)).toEqual([null, 'Well', null]);
  });

  it('视图只补不裁：槽数少于既有建筑时也不吞掉建筑', () => {
    const entry = makeEntry(2, ['Mill', 'Well', 'Forge']);
    const view = effectiveTileFacts(HEARTH, entry);
    expect(view.slots).toBe(2);
    expect(view.buildings).toHaveLength(3);
    expect(view.buildings[2]?.name).toBe('Forge');
  });
});

describe('seedTileFacts —— copy-on-write 播种（§3）', () => {
  it('抄 pack 基线：起始档 + 初始建筑按顺序落最小空槽 + 空状态空编年史', () => {
    const entry = seedTileFacts(HEARTH, 12);
    expect(entry.seededAtDay).toBe(12);
    expect(entry.development).toEqual({ level: 3, progress: 0 });
    expect(entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well', null]);
    expect(entry.statuses).toEqual([]);
    expect(entry.history).toEqual([]);
  });

  it('初始建筑条数超过起始槽数时装不下的落不进去', () => {
    const crowded = makeTile({
      id: 99,
      name: 'Crowded',
      development: 1,
      buildings: [{ name: 'First' }, { name: 'Second' }],
    });
    const entry = seedTileFacts(crowded, 0);
    expect(entry.buildings).toHaveLength(1);
    expect(entry.buildings?.[0]?.name).toBe('First');
  });

  it('海块播种出来没有发展面与建筑槽', () => {
    const entry = seedTileFacts(SHELF, 3);
    expect(entry.development).toBeUndefined();
    expect(entry.buildings).toBeUndefined();
  });

  it('🔴 包没声明起始档的陆块（v1.0/v1.1 旧包）→ **不物化**发展面（否则走一步路就长出 Lv1）', () => {
    const entry = seedTileFacts(MEADOW, 5);
    expect(entry.seededAtDay).toBe(5);
    expect(entry.development).toBeUndefined();
    expect(entry.buildings).toBeUndefined();
    // 播种本身仍然发生（首访编年史要落在它上面），只是没有发展面
    expect(entry.statuses).toEqual([]);
    expect(entry.history).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// 状态（裁定 §8-10）
// ══════════════════════════════════════════════════════════════

describe('状态挂/除', () => {
  it('同名即刷新：限时可转永久，效果整条换掉，不长出第二条', () => {
    const base = seedTileFacts(HEARTH, 0);
    const first = applyTileStatusAdd(
      base,
      makeStatus({
        title: 'Flood',
        description: 'rising water',
        effects: [{ kind: 'devProgressPerMonth', amount: -2 }],
        durationDays: 30,
        appliedAtDay: 0,
      }),
    );
    const second = applyTileStatusAdd(
      first,
      makeStatus({
        title: 'Flood',
        description: 'it never receded',
        durationDays: -1,
        appliedAtDay: 40,
      }),
    );

    expect(second.statuses).toHaveLength(1);
    expect(second.statuses[0].description).toBe('it never receded');
    expect(second.statuses[0].durationDays).toBe(-1);
    expect(second.statuses[0].effects).toEqual([]);
    expect(second.statuses[0].appliedAtDay).toBe(40);
    // 入参不许被改
    expect(first.statuses[0].durationDays).toBe(30);
  });

  it('移除按 title 精确匹配；找不到 → null（无变化）', () => {
    const entry = applyTileStatusAdd(seedTileFacts(HEARTH, 0), makeStatus({ title: 'Flood' }));
    expect(applyTileStatusRemove(entry, 'flood')).toBeNull();
    expect(applyTileStatusRemove(entry, 'Drought')).toBeNull();
    const removed = applyTileStatusRemove(entry, 'Flood');
    expect(removed?.statuses).toEqual([]);
    expect(entry.statuses).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 发展度与升降档（裁定 §8-7 / §8-8）
// ══════════════════════════════════════════════════════════════

describe('applyDevProgressDelta —— 进位算术与钳位', () => {
  it('进度恰好满 100：升一档、进度清 0', () => {
    const result: TileDevDeltaResult | null = applyDevProgressDelta(
      makeEntry(3, [null, null, null]),
      HEARTH,
      DEV_PROGRESS_MAX,
      7,
    );
    expect(result?.entry.development).toEqual({ level: 4, progress: 0 });
    expect(result?.events).toEqual([{ kind: 'levelChanged', from: 3, to: 4 }]);
    expect(result?.entry.history[0]).toMatchObject({
      day: 7,
      kind: 'levelUp',
      fromLevel: 3,
      toLevel: 4,
    });
    // 升档长出一个空槽
    expect(result?.entry.buildings).toHaveLength(4);
  });

  it('一次增量至多跨一个档位边界：+250 从档 3 只升到档 4、进度清 0（余量丢弃）', () => {
    const result = applyDevProgressDelta(makeEntry(3, [null, null, null]), HEARTH, 250, 1);
    expect(result?.entry.development).toEqual({ level: 4, progress: 0 });
    expect(result?.events.filter((e) => e.kind === 'levelChanged')).toHaveLength(1);
    expect(result?.entry.buildings).toHaveLength(4);
  });

  it('进度跌到 −50：降一档、进度落 50', () => {
    const result = applyDevProgressDelta(makeEntry(3, [null, null, null]), HEARTH, -50, 5);
    expect(result?.entry.development).toEqual({ level: 2, progress: 50 });
  });

  it('档 1 下钳：进度停在 −50，不再掉档', () => {
    const result = applyDevProgressDelta(makeEntry(MIN_DEV_LEVEL, [null]), HEARTH, -400, 5);
    expect(result?.entry.development).toEqual({ level: MIN_DEV_LEVEL, progress: DEV_PROGRESS_MIN });
    expect(result?.events).toEqual([]);
  });

  it('档 10 上钳：进度停在 100，溢出丢弃', () => {
    const slots = new Array<null>(MAX_DEV_LEVEL).fill(null);
    const result = applyDevProgressDelta(makeEntry(MAX_DEV_LEVEL, slots), HEARTH, 999, 5);
    expect(result?.entry.development).toEqual({
      level: MAX_DEV_LEVEL,
      progress: DEV_PROGRESS_MAX,
    });
  });

  it('🔴 事实没有发展面（旧包地块）→ 按 pack 基线迟物化（播种不物化的另一半）', () => {
    const result = applyDevProgressDelta(seedTileFacts(MEADOW, 0), MEADOW, 40, 4);
    expect(result?.entry.development).toEqual({ level: MIN_DEV_LEVEL, progress: 40 });
    expect(result?.entry.buildings).toEqual([null]); // 槽数 = 档数
  });

  it('钳住之后什么都没变 → null；零增量 → null；无发展度地块 → null', () => {
    const capped = makeEntry(MAX_DEV_LEVEL, new Array<null>(MAX_DEV_LEVEL).fill(null), 100);
    expect(applyDevProgressDelta(capped, HEARTH, 20, 5)).toBeNull();
    expect(applyDevProgressDelta(makeEntry(3, [null, null, null]), HEARTH, 0, 5)).toBeNull();
    expect(applyDevProgressDelta(seedTileFacts(SHELF, 0), SHELF, -80, 5)).toBeNull();
  });
});

describe('降档摧毁 —— 严格槽位身份（裁定 §8-8）', () => {
  it('永远摧毁最高号槽里的建筑，并带上引发它的状态名', () => {
    const options: TileDevDeltaOptions = { causeStatuses: ['Flood'], reason: 'the levees broke' };
    const result = applyDevProgressDelta(
      makeEntry(3, ['Mill', 'Well', 'Forge']),
      HEARTH,
      -50,
      9,
      options,
    );
    expect(result?.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well']);
    expect(result?.events).toContainEqual({
      kind: 'buildingDestroyed',
      building: 'Forge',
      causeStatuses: ['Flood'],
    });
    expect(result?.entry.history).toContainEqual({
      day: 9,
      kind: 'destroyed',
      building: 'Forge',
      causeStatuses: ['Flood'],
      reason: 'the levees broke',
    });
  });

  it('最高号槽是空槽时照样被吸收：建筑一座没少，槽数少一格', () => {
    const result = applyDevProgressDelta(makeEntry(3, ['Mill', 'Well', null]), HEARTH, -50, 9);
    expect(result?.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well']);
    expect(result?.events.some((e) => e.kind === 'buildingDestroyed')).toBe(false);
  });

  it('玩家产业住在最高号槽也不豁免', () => {
    const entry = makeEntry(2, ['Mill', null]);
    const withTavern = applyBuildingUpdate(
      { ...entry, buildings: [{ name: 'Mill' }, { name: 'Tavern' }] },
      'Tavern',
      { playerOwned: true },
      1,
    );
    expect(withTavern).not.toBeNull();
    const result = applyDevProgressDelta(withTavern as TileFactsEntry, HEARTH, -50, 20);
    expect(result?.events).toContainEqual({
      kind: 'buildingDestroyed',
      building: 'Tavern',
      causeStatuses: [],
    });
    expect(result?.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill']);
  });

  it('一次大跌也只降一档（欠量丢弃，摧毁一座）—— 崩塌得占叙事时间', () => {
    const result = applyDevProgressDelta(makeEntry(3, ['Mill', 'Well', 'Forge']), HEARTH, -150, 9);
    expect(result?.entry.development).toEqual({ level: 2, progress: 50 });
    const destroyed = destroyedNames(result?.events ?? []);
    expect(destroyed).toEqual(['Forge']);
    expect(result?.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well']);
  });
});

// ══════════════════════════════════════════════════════════════
// 建筑（裁定 §8-8 最小空槽 / §8-9 所有权）
// ══════════════════════════════════════════════════════════════

describe('建筑落位与更新', () => {
  it('落进最小空槽（不是尾部追加）', () => {
    const entry = makeEntry(3, [null, 'Well', null]);
    const result: BuildingAddResult = applyBuildingAdd(entry, HEARTH, { name: 'Forge' }, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot).toBe(0);
    expect(result.updated).toBe(false);
    expect(result.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Forge', 'Well', null]);
    expect(result.entry.history).toContainEqual({ day: 4, kind: 'built', building: 'Forge' });
  });

  it('槽全满 → 明确拒绝（不静默丢弃）', () => {
    const full = makeEntry(2, ['Mill', 'Well']);
    const result = applyBuildingAdd(full, HEARTH, { name: 'Forge' }, 4);
    expect(result).toEqual({ ok: false, reason: 'noEmptySlot' });
  });

  it('海块 → 拒绝（判据是地块通行性，不是条目里有没有 development）', () => {
    const result = applyBuildingAdd(seedTileFacts(SHELF, 0), SHELF, { name: 'Pier' }, 1);
    expect(result).toEqual({ ok: false, reason: 'noDevelopment' });
    expect(applyBuildingAdd(seedTileFacts(RIDGE, 0), RIDGE, { name: 'Watchtower' }, 1)).toEqual({
      ok: false,
      reason: 'noDevelopment',
    });
  });

  it('🔴 条目没有发展面的陆块 → 按 pack 基线**迟物化**，不再报 noDevelopment', () => {
    // 旧包地块被首访播种过的形状（播种不物化发展面）
    const result = applyBuildingAdd(seedTileFacts(MEADOW, 0), MEADOW, { name: 'Shrine' }, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot).toBe(0); // 基线档 1 → 1 号槽
    expect(result.entry.development).toEqual({ level: MIN_DEV_LEVEL, progress: 0 });
    expect(result.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Shrine']);
    expect(result.entry.history).toContainEqual({ day: 7, kind: 'built', building: 'Shrine' });
  });

  it('🔴 迟物化仍抄 pack 的初始建筑（换包后名字落到陆块时不该把它们抹掉）', () => {
    // 事实是在这个名字还是海块时播下的：没有发展面、也没有槽数组
    const stranded: TileFactsEntry = { seededAtDay: 0, statuses: [], history: [] };
    const result = applyBuildingAdd(stranded, HEARTH, { name: 'Forge' }, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot).toBe(2); // Mill / Well 占着 0 与 1
    expect(result.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill', 'Well', 'Forge']);
    expect(result.entry.development).toEqual({ level: 3, progress: 0 });
  });

  it('同名再落 = 当更新处理（不长出第二座同名建筑）', () => {
    const entry = makeEntry(3, ['Mill', null, null]);
    const result = applyBuildingAdd(entry, HEARTH, { name: 'Mill', ownerFlavor: 'the crown' }, 6);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updated).toBe(true);
    expect(result.slot).toBe(0);
    expect(result.entry.buildings?.filter((b) => b?.name === 'Mill')).toHaveLength(1);
    expect(result.entry.buildings?.[0]?.ownerFlavor).toBe('the crown');
  });

  it('直接落一座玩家产业时记 acquired', () => {
    const result = applyBuildingAdd(
      makeEntry(2, [null, null]),
      HEARTH,
      { name: 'Tavern', playerOwned: true },
      8,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.history.map((h) => h.kind)).toEqual(['built', 'acquired']);
  });

  it('更新：找不到名字 → null；playerOwned 由假翻真时记 acquired', () => {
    const entry = makeEntry(2, ['Mill', null]);
    expect(applyBuildingUpdate(entry, 'Forge', { playerOwned: true }, 3)).toBeNull();

    const patch: BuildingPatch = {
      playerOwned: true,
      income: { amount: 50, periodDays: 30, anchorDay: 3 },
    };
    const updated = applyBuildingUpdate(entry, 'Mill', patch, 3, { reason: 'bought at auction' });
    expect(updated?.buildings?.[0]?.playerOwned).toBe(true);
    expect(updated?.buildings?.[0]?.income).toEqual({ amount: 50, periodDays: 30, anchorDay: 3 });
    expect(updated?.history).toEqual([
      { day: 3, kind: 'acquired', building: 'Mill', reason: 'bought at auction' },
    ]);
    // 已经是玩家产业时不再重复记
    const again = applyBuildingUpdate(updated as TileFactsEntry, 'Mill', { playerOwned: true }, 9);
    expect(again?.history).toHaveLength(1);
    // 入参不变
    expect(entry.buildings?.[0]?.playerOwned).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 主建筑（§F4b / 裁定 §8-17~19）
// ══════════════════════════════════════════════════════════════

describe('resolveMainBuilding —— 派生 / 作者名 / 钉住', () => {
  it('没被点名的地块按**当前档**派生通名（档变则名变）', () => {
    expect(resolveMainBuilding(HEARTH, undefined, MAIN_NAMES, 3)?.name).toBe('Village Hall');
    expect(resolveMainBuilding(HEARTH, undefined, MAIN_NAMES, 7)?.name).toBe('Grand Hall');
  });

  it('🔴 通名表缺席/缺行 → ASCII 兜底（引擎不持有中文档名）', () => {
    expect(resolveMainBuilding(HEARTH, undefined, [], 3)?.name).toBe('Seat Lv3');
    expect(resolveMainBuilding(HEARTH, undefined, ['Camp', '  '], 2)?.name).toBe('Seat Lv2');
  });

  it('作者名钉住：档从 2 升到 9 也不改名，描述与归属一并带出', () => {
    expect(resolveMainBuilding(BASTION, undefined, MAIN_NAMES, 2)).toEqual({
      name: 'Old Keep',
      description: 'stone and moss',
      ownerFlavor: 'the baron',
    });
    expect(resolveMainBuilding(BASTION, undefined, MAIN_NAMES, 9)?.name).toBe('Old Keep');
  });

  it('事实里的名字**赢过**作者名与通名（AI 改名 / 授予产业后钉住的那个）', () => {
    const entry: TileFactsEntry = {
      statuses: [],
      history: [],
      mainBuilding: { name: 'Sunspire', playerOwned: true },
    };
    const resolved = resolveMainBuilding(BASTION, entry, MAIN_NAMES, 9);
    expect(resolved).toEqual({ name: 'Sunspire', playerOwned: true });
  });

  it('海/不可通行块恒 null（主建筑代表聚落，海面上没有聚落）', () => {
    expect(resolveMainBuilding(SHELF, undefined, MAIN_NAMES, 4)).toBeNull();
    expect(resolveMainBuilding(RIDGE, undefined, MAIN_NAMES, 1)).toBeNull();
  });

  it('🔴 返回的是新对象 —— 改它不该改到存档里那份事实', () => {
    const entry: TileFactsEntry = {
      statuses: [],
      history: [],
      mainBuilding: { name: 'Sunspire', income: { amount: 10, periodDays: 30, anchorDay: 0 } },
    };
    const resolved = resolveMainBuilding(HEARTH, entry, MAIN_NAMES, 3)!;
    resolved.name = 'Tampered';
    resolved.income!.amount = 9999;
    expect(entry.mainBuilding?.name).toBe('Sunspire');
    expect(entry.mainBuilding?.income?.amount).toBe(10);
  });

  it('effectiveTileFacts 把它挂在**独立字段**上，不混进槽数组', () => {
    const view = effectiveTileFacts(HEARTH, makeEntry(3, ['Mill', null, null]), MAIN_NAMES);
    expect(view.mainBuilding?.name).toBe('Village Hall');
    expect(view.buildings.map((b) => b?.name ?? null)).toEqual(['Mill', null, null]);
    // 无发展度的地块恒 null
    expect(effectiveTileFacts(SHELF, undefined, MAIN_NAMES).mainBuilding).toBeNull();
  });

  it('seedTileFacts **不物化**它（物化 = 把当天那一档的通名永久钉死）', () => {
    expect(seedTileFacts(HEARTH, 3).mainBuilding).toBeUndefined();
    expect(seedTileFacts(BASTION, 3).mainBuilding).toBeUndefined();
  });
});

describe('applyMainBuildingUpdate —— 唯一的写面（没有 add，也没有 remove）', () => {
  const names: MainBuildingUpdateOptions = { mainBuildingNames: MAIN_NAMES };

  it('授予玩家：物化进事实、名字就此钉住、记一条 acquired（带 reason）', () => {
    const entry = makeEntry(3, [null, null, null]);
    const next = applyMainBuildingUpdate(
      entry,
      HEARTH,
      { playerOwned: true, income: { amount: 120, periodDays: 30, anchorDay: 2 } },
      2,
      { ...names, reason: 'granted by the crown' },
    );

    expect(next?.mainBuilding).toEqual({
      name: 'Village Hall',
      playerOwned: true,
      income: { amount: 120, periodDays: 30, anchorDay: 2 },
    });
    expect(next?.history).toEqual([
      { day: 2, kind: 'acquired', building: 'Village Hall', reason: 'granted by the crown' },
    ]);
    // 入参不许被改
    expect(entry.mainBuilding).toBeUndefined();
  });

  it('🔴 钉住之后名字不再随档变（这正是 seedTileFacts 不物化它的理由）', () => {
    const granted = applyMainBuildingUpdate(
      makeEntry(3, [null, null, null]),
      HEARTH,
      { playerOwned: true },
      2,
      names,
    )!;
    // 事实里的档换成 8，通名本该是 Palace —— 但已钉住
    granted.development = { level: 8, progress: 0 };
    expect(effectiveTileFacts(HEARTH, granted, MAIN_NAMES).mainBuilding?.name).toBe('Village Hall');
  });

  it('改名记 renamed（记的是新名字）；同名重写不记（AI 复读不刷屏）', () => {
    const renamed = applyMainBuildingUpdate(
      makeEntry(3, [null, null, null]),
      HEARTH,
      { name: '  Sunspire  ', ownerFlavor: 'the archon' },
      5,
      { ...names, reason: 'rebuilt after the fire' },
    )!;
    expect(renamed.mainBuilding).toEqual({
      name: 'Sunspire',
      ownerFlavor: 'the archon',
    });
    expect(renamed.history).toEqual([
      { day: 5, kind: 'renamed', building: 'Sunspire', reason: 'rebuilt after the fire' },
    ]);

    const again = applyMainBuildingUpdate(renamed, HEARTH, { name: 'Sunspire' }, 9, names)!;
    expect(again.history).toHaveLength(1);
  });

  it('已经是玩家产业时不再重复记 acquired', () => {
    const owned = applyMainBuildingUpdate(
      makeEntry(2, [null, null]),
      HEARTH,
      { playerOwned: true },
      1,
      names,
    )!;
    const again = applyMainBuildingUpdate(owned, HEARTH, { playerOwned: true }, 9, names)!;
    expect(again.history).toHaveLength(1);
  });

  it('无发展度的地块 → null；补丁一格都没提 → null（空 update 不该把名字钉住）', () => {
    expect(
      applyMainBuildingUpdate(seedTileFacts(SHELF, 0), SHELF, { playerOwned: true }, 1, names),
    ).toBeNull();
    expect(applyMainBuildingUpdate(makeEntry(2, [null, null]), HEARTH, {}, 1, names)).toBeNull();
    // 空白名不算「提了」
    expect(
      applyMainBuildingUpdate(makeEntry(2, [null, null]), HEARTH, { name: '   ' }, 1, names),
    ).toBeNull();
  });

  it('作者名的地块：一次 update 钉的是**作者名**而不是通名', () => {
    const next = applyMainBuildingUpdate(
      seedTileFacts(BASTION, 0),
      BASTION,
      { playerOwned: true },
      4,
      names,
    )!;
    expect(next.mainBuilding?.name).toBe('Old Keep');
    expect(next.mainBuilding?.ownerFlavor).toBe('the baron');
  });
});

describe('主建筑降档免疫（裁定 §8-17）', () => {
  it('🔴 降档摧毁最高号槽里的建筑，主建筑**毫发无伤**（连名字带归属都在）', () => {
    let entry = makeEntry(3, ['Mill', 'Well', 'Forge']);
    entry = applyMainBuildingUpdate(entry, HEARTH, { playerOwned: true }, 1, {
      mainBuildingNames: MAIN_NAMES,
    })!;

    const result = applyDevProgressDelta(entry, HEARTH, DEV_PROGRESS_MIN, 20)!;
    expect(destroyedNames(result.events)).toEqual(['Forge']);
    expect(result.entry.development?.level).toBe(2);
    expect(result.entry.buildings).toHaveLength(2);
    expect(result.entry.mainBuilding).toEqual({ name: 'Village Hall', playerOwned: true });
  });

  it('掉到档 1 也还在（主建筑没有任何移除路径）', () => {
    let entry = makeEntry(2, ['Mill', 'Well']);
    entry = applyMainBuildingUpdate(entry, HEARTH, { ownerFlavor: 'the reeve' }, 1, {
      mainBuildingNames: MAIN_NAMES,
    })!;
    const result = applyDevProgressDelta(entry, HEARTH, DEV_PROGRESS_MIN, 30)!;
    expect(result.entry.development?.level).toBe(MIN_DEV_LEVEL);
    expect(result.entry.mainBuilding?.ownerFlavor).toBe('the reeve');
  });
});

// ══════════════════════════════════════════════════════════════
// 编年史（裁定 §8-16）
// ══════════════════════════════════════════════════════════════

describe('编年史保留策略', () => {
  it('FIFO 上限 10 条，首访条目钉住不淘汰', () => {
    let entry: TileFactsEntry = seedTileFacts(HEARTH, 0);
    entry = recordFirstVisit(entry, 1) as TileFactsEntry;
    for (let i = 0; i < 15; i++) {
      entry = recordTileHistory(entry, { day: 10 + i, kind: 'note', text: `n${i}` });
    }

    expect(entry.history).toHaveLength(TILE_HISTORY_LIMIT);
    expect(entry.history.filter((h) => h.kind === 'firstVisit')).toHaveLength(1);
    const notes = entry.history.filter((h) => h.kind === 'note').map((h) => h.text);
    expect(notes).toEqual(['n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13', 'n14']);
  });

  it('首访只记一次（已有则 null）', () => {
    const first = recordFirstVisit(seedTileFacts(HEARTH, 0), 5);
    expect(first?.history).toEqual([{ day: 5, kind: 'firstVisit' }]);
    expect(recordFirstVisit(first as TileFactsEntry, 40)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// 结算（§4）
// ══════════════════════════════════════════════════════════════

describe('settleTileFacts —— 到期 / 周期效果 / 收益', () => {
  it('无事发生 → null（含时间没有前进的情形）', () => {
    const entry = applyTileStatusAdd(seedTileFacts(HEARTH, 0), makeStatus({ title: 'Fair Winds' }));
    expect(settleTileFacts(entry, HEARTH, 0, 10)).toBeNull();
    expect(settleTileFacts(entry, HEARTH, 10, 10)).toBeNull();
    expect(settleTileFacts(entry, HEARTH, 10, 5)).toBeNull();
  });

  it('到期日当天即到期，前一天不到期', () => {
    const entry = applyTileStatusAdd(
      seedTileFacts(HEARTH, 0),
      makeStatus({ title: 'Fog', durationDays: 5, appliedAtDay: 10 }),
    );
    expect(settleTileFacts(entry, HEARTH, 10, 14)).toBeNull();
    const settled: TileSettlementResult | null = settleTileFacts(entry, HEARTH, 14, 15);
    expect(settled?.events).toEqual([{ kind: 'statusExpired', title: 'Fog' }]);
    expect(settled?.entry.statuses).toEqual([]);
  });

  it('跨 90 天补结算 3 期（永久负面状态把档位压下去并摧毁最高号槽）', () => {
    const entry = applyTileStatusAdd(
      { ...makeEntry(3, ['Mill', 'Well', 'Forge']), statuses: [] },
      makeStatus({
        title: 'Blight',
        effects: [{ kind: 'devProgressPerMonth', amount: -20 }],
        durationDays: -1,
        appliedAtDay: 0,
      }),
    );
    const settled = settleTileFacts(entry, HEARTH, 0, 3 * DEV_PROGRESS_PERIOD_DAYS);
    expect(settled?.events).toContainEqual({
      kind: 'devPeriodApplied',
      title: 'Blight',
      amount: -20,
      periods: 3,
    });
    // 逐期 −20：−20 / −40 / −60 → 第三期跨过 −50 → 降一档、落 50
    expect(settled?.entry.development).toEqual({ level: 2, progress: 50 });
    expect(settled?.events).toContainEqual({
      kind: 'buildingDestroyed',
      building: 'Forge',
      causeStatuses: ['Blight'],
    });
    // 永久状态不到期
    expect(settled?.entry.statuses).toHaveLength(1);
  });

  it('周期效果逐期结算，长窗口里能一路走下多档（每档各摧毁最高号槽）', () => {
    const entry = applyTileStatusAdd(
      makeEntry(3, ['Mill', 'Well', 'Forge']),
      makeStatus({
        title: 'Blight',
        effects: [{ kind: 'devProgressPerMonth', amount: -20 }],
        durationDays: -1,
        appliedAtDay: 0,
      }),
    );
    // 8 期 −20：第 3 期降到档 2（落 50），第 8 期再降到档 1（落 50）
    const settled = settleTileFacts(entry, HEARTH, 0, 8 * DEV_PROGRESS_PERIOD_DAYS);
    expect(settled?.events).toContainEqual({
      kind: 'devPeriodApplied',
      title: 'Blight',
      amount: -20,
      periods: 8,
    });
    expect(settled?.entry.development).toEqual({ level: 1, progress: 50 });
    expect(destroyedNames(settled?.events ?? [])).toEqual(['Forge', 'Well']);
    expect(settled?.entry.buildings?.map((b) => b?.name ?? null)).toEqual(['Mill']);
  });

  it('中途到期的状态仍贡献到期前的节拍（90 天窗口里只结算 1 期）', () => {
    const entry = applyTileStatusAdd(
      { ...makeEntry(3, [null, null, null]), statuses: [] },
      makeStatus({
        title: 'Flood',
        effects: [{ kind: 'devProgressPerMonth', amount: -2 }],
        durationDays: 45,
        appliedAtDay: 0,
      }),
    );
    const settled = settleTileFacts(entry, HEARTH, 0, 90);
    expect(settled?.events).toContainEqual({
      kind: 'devPeriodApplied',
      title: 'Flood',
      amount: -2,
      periods: 1,
    });
    expect(settled?.entry.development).toEqual({ level: 3, progress: -2 });
    expect(settled?.events).toContainEqual({ kind: 'statusExpired', title: 'Flood' });
  });

  it('玩家产业按各自的锚补结算收益，且一分钱都不在这里动', () => {
    const owned: TileFactsEntry = {
      ...makeEntry(2, [null, null]),
      buildings: [
        { name: 'Tavern', playerOwned: true, income: { amount: 50, periodDays: 30, anchorDay: 5 } },
        { name: 'Shrine', income: { amount: 999, periodDays: 30, anchorDay: 0 } },
      ],
    };
    const settled = settleTileFacts(owned, HEARTH, 0, 70);
    expect(settled?.events).toEqual([
      { kind: 'incomeDue', building: 'Tavern', amount: 50, periods: 2 },
    ]);
    // 非玩家产业不入账；条目本身没被改写
    expect(settled?.entry).toBe(owned);
  });

  it('🔴 主建筑也在这条扫描线上（它住独立字段，漏扫 = 王冠级产业静默不入账）', () => {
    const owned: TileFactsEntry = {
      ...makeEntry(2, [null, null]),
      mainBuilding: {
        name: 'Sunspire',
        playerOwned: true,
        income: { amount: 200, periodDays: 30, anchorDay: 0 },
      },
      buildings: [
        { name: 'Tavern', playerOwned: true, income: { amount: 50, periodDays: 30, anchorDay: 0 } },
        null,
      ],
    };
    const settled = settleTileFacts(owned, HEARTH, 0, 60);
    // `main: true` 是这笔钱的唯一区分标记（事件卡措辞在接线层，本模块零散文）
    expect(settled?.events).toEqual([
      { kind: 'incomeDue', building: 'Sunspire', amount: 200, periods: 2, main: true },
      { kind: 'incomeDue', building: 'Tavern', amount: 50, periods: 2 },
    ]);
  });

  it('主建筑不是玩家产业时不入账（默认 ownerFlavor 是纯 flavor）', () => {
    const entry: TileFactsEntry = {
      ...makeEntry(2, [null, null]),
      mainBuilding: {
        name: 'Sunspire',
        ownerFlavor: 'the baron',
        income: { amount: 200, periodDays: 30, anchorDay: 0 },
      },
    };
    expect(settleTileFacts(entry, HEARTH, 0, 60)).toBeNull();
  });

  it('海块只有状态面：发展效果静默无效，flavor 状态照常到期', () => {
    let entry = seedTileFacts(SHELF, 0);
    entry = applyTileStatusAdd(
      entry,
      makeStatus({
        title: 'Squall',
        effects: [{ kind: 'devProgressPerMonth', amount: -5 }],
        durationDays: 30,
        appliedAtDay: 0,
      }),
    );
    entry = applyTileStatusAdd(entry, makeStatus({ title: 'Beacon' }));

    const settled = settleTileFacts(entry, SHELF, 0, 30);
    expect(settled?.events).toEqual([{ kind: 'statusExpired', title: 'Squall' }]);
    expect(settled?.entry.development).toBeUndefined();
    expect(settled?.entry.statuses.map((s) => s.title)).toEqual(['Beacon']);
  });
});

describe('settleMapFacts —— 全图结算与休眠冻结（§3）', () => {
  function makeFacts(): MapFactsFlags {
    const expiring = applyTileStatusAdd(
      seedTileFacts(HEARTH, 0),
      makeStatus({ title: 'Fog', durationDays: 10, appliedAtDay: 0 }),
    );
    const dormant = applyTileStatusAdd(
      seedTileFacts(MEADOW, 0),
      makeStatus({ title: 'Frost', durationDays: 10, appliedAtDay: 0 }),
    );
    return { tiles: { Hearth: expiring, Ghostmoor: dormant } };
  }

  const resolve = (name: string): MapTile | undefined => PACK.tiles.find((t) => t.name === name);

  it('结算得到的地块出事件；休眠地块（名字不在现行包里）整块冻结', () => {
    const facts = makeFacts();
    const result: MapSettlementResult | null = settleMapFacts(facts, resolve, 0, 30);
    expect(result).not.toBeNull();
    const events: MapSettlementEvent[] = result?.events ?? [];
    expect(events).toEqual([{ tile: 'Hearth', event: { kind: 'statusExpired', title: 'Fog' } }]);
    // 休眠条目原样保留（同一引用），不到期
    expect(result?.facts.tiles.Ghostmoor).toBe(facts.tiles.Ghostmoor);
    expect(result?.facts.tiles.Hearth.statuses).toEqual([]);
    // 入参不被改写
    expect(facts.tiles.Hearth.statuses).toHaveLength(1);
  });

  it('全体无事发生 → null', () => {
    expect(settleMapFacts(makeFacts(), resolve, 0, 5)).toBeNull();
    expect(settleMapFacts({ tiles: {} }, resolve, 0, 100)).toBeNull();
  });
});
