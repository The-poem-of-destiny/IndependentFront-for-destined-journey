/**
 * state-manager.map-facts.test.ts — 地块事实的**接线**测试（地图 v1.2 / ADR-33 §2·§3·§4）
 *
 * 为什么又是链路测试而不是纯函数测试：算术在 `map-dynamics.test.ts` 与 `time-ledger.test.ts`
 * 里已经测透了。这里要钉的全是**接线**才会错的事 ——
 * op 有没有接进分发表、值有没有落进 `worldFlags.mapFacts`、结算钩子在不在时间推进之后、
 * 收益补丁有没有真的进到自提交的那个数组、首访有没有跟着落位一起发生。
 * 这些全是「逻辑对但没人供值」那一类：纯函数测试全绿也照样漏。
 *
 * 所以一律从真入口出发（`commitChatState(六个 op)` / `applyTimeAdvance` /
 * `commitChatState(set_location)`），落到真 Dexie（fake-indexeddb）上回读。
 *
 * 覆盖（每条都对应一种不报错的错）:
 * - 六个 op 各自的 happy path（状态/建筑/发展度/编年史）
 * - 认不出的地块名 → warn + **零写入**，且 `errors` 为空（裁定 §8-3 解析失败不否决）
 * - copy-on-write 播种：首个 op 就把**当时的** pack 基线（起始档 + 初始建筑）种进去（§3）
 * - 结算钩子：状态到期出新闻 / 收益进玩家 `money` 且出新闻 / 降档摧毁出新闻
 * - **休眠地块冻结**：名字不在现行包里 → 不到期、不入账（§3）
 * - 首访只记一次（`applySetLocation` 旁观，§F5）
 * - 换包自愈**不碰** `mapFacts`（§3：事实不是派生态，与 `worldFlags.map` 语义相反）
 *
 * 🔴 夹具零真实地名（承 D25①）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAllData, getCharacters, initializeDatabase, saveCharacter } from './database';
import { getMapFactsFlags, getProfile, updateProfile } from './save-profile';
import { createStateManager } from './state-manager';
import { installMapPack, resetMapRuntime } from './map-runtime';
import { createDefaultCharacterState } from './types';
import { createDefaultTime } from './time-system';
import type { StatePatch } from './types';
import type { MapFactsFlags, MapPack, MapTile, TileFactsEntry } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具
// ═══════════════════════════════════════════════════════════

const SAVE_ID = 'save-map-facts';

/** 一游戏日；与 state-manager 里那个常量同值（独立写一份，好让漂移变红） */
const MINUTES_PER_DAY = 1440;

function tile(id: number, name: string, patch: Partial<MapTile> = {}): MapTile {
  return {
    id,
    name,
    terrain: 'plains',
    water: null,
    impassable: false,
    countryId: 'north',
    midTierId: 'zone-a',
    centroid: [id * 10, id * 10],
    areaPx: 100,
    ...patch,
  };
}

/**
 * 4 块地:
 *   1 Alpha —— 缺 `development`（v1.0 旧包的常态）→ 基线档 1、1 个空槽
 *   2 Bravo —— 起始档 2 + 两座初始建筑（降档摧毁那条用：最高号槽住着 Beacon）
 *   3 Charlie —— 起始档 3（收益/产业那条用）
 *   9 Lagoon —— 湖（`water`）→ **没有**发展度与建筑槽，但状态照挂（裁定 §8-1）
 */
function buildPack(contentHash: string): MapPack {
  return {
    version: '1.2.0',
    contentHash,
    resolution: { w: 200, h: 200 },
    kmPerPx: 2,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 120 },
      embarkCost: 5,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    developmentLevels: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'],
    // v1.2 §F4b：主建筑通名表（与档名表并排随包）
    mainBuildingNames: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'],
    countries: [{ id: 'north', name: 'Northland', color: [1, 2, 3], anchorTileId: 1 }],
    midTiers: [
      { id: 'zone-a', name: 'Zone Alpha', countryId: 'north', climateId: 'cold', anchorTileId: 1 },
    ],
    climates: { cold: { name: 'Cold Zone', table: { 春季: [['snow', 1]] } } },
    tiles: [
      tile(1, 'Alpha'),
      tile(2, 'Bravo', {
        development: 2,
        buildings: [{ name: 'Granary' }, { name: 'Beacon', ownerFlavor: 'Watch Guild' }],
      }),
      tile(3, 'Charlie', { development: 3 }),
      tile(9, 'Lagoon', { water: 'lake' }),
    ],
    adjacency: [
      [1, 2, 120],
      [2, 3, 90],
    ],
    straits: [],
    placeBindings: {},
  };
}

// ═══════════════════════════════════════════════════════════
// 装台
// ═══════════════════════════════════════════════════════════

async function seedPlayer(location = 'Northland-Zone Alpha-Alpha'): Promise<void> {
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero-1',
      saveId: SAVE_ID,
      name: 'Hero',
      type: 'player',
      location,
      money: 100,
    }),
  );
}

/** profile 必须先存在（`gameTime` 从缺省起算 = 第 0 游戏日） */
async function seedProfile(): Promise<void> {
  const profile = await getProfile(SAVE_ID);
  profile.gameTime = createDefaultTime();
  await updateProfile(profile);
}

async function commit(patches: StatePatch[]): Promise<void> {
  const sm = createStateManager(SAVE_ID);
  const result = await sm.commitChatState(patches);
  expect(result.errors).toEqual([]);
}

/** 一条地块 op 的糖：`target` 恒为 'map'，寻址在 `value.tile`（ADR-33 §2） */
function tileOp(op: StatePatch['op'], value: Record<string, unknown>): StatePatch {
  return { op, target: 'map', value };
}

async function readFacts(): Promise<MapFactsFlags> {
  return getMapFactsFlags(await getProfile(SAVE_ID));
}

async function readEntry(name: string): Promise<TileFactsEntry | undefined> {
  return (await readFacts()).tiles[name];
}

async function readNews(): Promise<{ title: string; content: string; category: string }[]> {
  return (await getProfile(SAVE_ID)).news;
}

async function readMoney(): Promise<number | undefined> {
  return (await getCharacters(SAVE_ID)).find((c) => c.type === 'player')?.money;
}

/** 直接把一份事实塞进存档（结算/休眠用例的起手式，绕开 op 层） */
async function seedFacts(tiles: Record<string, TileFactsEntry>): Promise<void> {
  const profile = await getProfile(SAVE_ID);
  profile.worldFlags.mapFacts = { tiles };
  await updateProfile(profile);
}

async function advanceDays(days: number): Promise<void> {
  await createStateManager(SAVE_ID).applyTimeAdvance(days * MINUTES_PER_DAY);
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首跑时库还不存在 */
  }
  await initializeDatabase();
  resetMapRuntime();
  installMapPack(buildPack('hash-v1'));
  await seedProfile();
  await seedPlayer();
});

// ═══════════════════════════════════════════════════════════
// 六个 op（ADR-33 §2）
// ═══════════════════════════════════════════════════════════

describe('tile_status_add / tile_status_remove', () => {
  it('挂一条限时状态 → 落进 mapFacts，锚在当天，效果词汇被收窄到 devProgressPerMonth', async () => {
    await commit([
      tileOp('tile_status_add', {
        tile: 'Alpha',
        title: 'Flood',
        description: 'Water everywhere.',
        durationDays: 30,
        effects: [
          { kind: 'devProgressPerMonth', amount: -2 },
          { kind: 'notAThing', amount: 99 }, // 认不出的效果逐条丢
        ],
        reason: 'heavy rain',
      }),
    ]);

    const entry = await readEntry('Alpha');
    expect(entry?.statuses).toHaveLength(1);
    expect(entry?.statuses[0]).toMatchObject({
      title: 'Flood',
      description: 'Water everywhere.',
      durationDays: 30,
      appliedAtDay: 0,
      effects: [{ kind: 'devProgressPerMonth', amount: -2 }],
    });
    // 裁定 §8-14：状态的挂与除**刻意不记编年史**（同名刷新会把 10 格 FIFO 刷屏）
    expect(entry?.history).toEqual([]);
  });

  it('同名再下发 = 整条刷新（不长出第二条，周期效果不会翻倍结算）', async () => {
    await commit([
      tileOp('tile_status_add', { tile: 'Alpha', title: 'Flood', durationDays: 30 }),
      tileOp('tile_status_add', { tile: 'Alpha', title: 'Flood', durationDays: -1 }),
    ]);

    const entry = await readEntry('Alpha');
    expect(entry?.statuses).toHaveLength(1);
    expect(entry?.statuses[0]?.durationDays).toBe(-1); // 限时 ↔ 永久可互转
  });

  it('durationDays 认不出 → 读作永久（-1）而不是 0（0 = 当天就到期，等于静默什么都没发生）', async () => {
    await commit([tileOp('tile_status_add', { tile: 'Alpha', title: 'Curse' })]);
    expect((await readEntry('Alpha'))?.statuses[0]?.durationDays).toBe(-1);
  });

  it('湖面照挂状态（裁定 §8-1：状态任意地块，机制面静默无效）', async () => {
    await commit([tileOp('tile_status_add', { tile: 'Lagoon', title: 'Storm', durationDays: 5 })]);
    const entry = await readEntry('Lagoon');
    expect(entry?.statuses).toHaveLength(1);
    expect(entry?.development).toBeUndefined(); // 没有发展面
    expect(entry?.buildings).toBeUndefined(); // 没有建筑槽
  });

  it('移除永久状态 —— 这是它唯一的出口；移除不存在的状态一个字节都不写', async () => {
    await commit([tileOp('tile_status_add', { tile: 'Alpha', title: 'Curse', durationDays: -1 })]);
    await commit([tileOp('tile_status_remove', { tile: 'Alpha', title: 'Curse' })]);
    expect((await readEntry('Alpha'))?.statuses).toEqual([]);

    // 池外的名字：不播种、不写库（AI 复读「解除一条根本不在的状态」是常态）
    await commit([tileOp('tile_status_remove', { tile: 'Charlie', title: 'Nope' })]);
    expect(await readEntry('Charlie')).toBeUndefined();
  });
});

describe('tile_building_add / tile_building_update', () => {
  it('新建筑落最小空槽，记 built 编年史，收益的周期与锚由 Code 补（铁律3）', async () => {
    await commit([
      tileOp('tile_building_add', {
        tile: 'Charlie',
        name: 'Tavern',
        description: 'A warm hall.',
        ownerFlavor: 'Old Marn',
        playerOwned: true,
        // AI 只填金额；periodDays / anchorDay 由 Code 写定（AI 自己写锚就能提前拿钱）
        income: { amount: 50, periodDays: 1, anchorDay: -999 },
        reason: 'bought the deed',
      }),
    ]);

    const entry = await readEntry('Charlie');
    expect(entry?.development).toEqual({ level: 3, progress: 0 });
    expect(entry?.buildings?.[0]).toMatchObject({
      name: 'Tavern',
      ownerFlavor: 'Old Marn',
      playerOwned: true,
      income: { amount: 50, periodDays: 30, anchorDay: 0 },
    });
    expect(entry?.history.map((h) => h.kind)).toEqual(['built', 'acquired']);
    expect(entry?.history[0]?.reason).toBe('bought the deed');
  });

  it('playerOwned 由假翻真 → 记一条 acquired（裁定 §8-14 第六类）', async () => {
    await commit([tileOp('tile_building_add', { tile: 'Charlie', name: 'Mill' })]);
    await commit([
      tileOp('tile_building_update', {
        tile: 'Charlie',
        name: 'Mill',
        playerOwned: true,
        reason: 'inherited',
      }),
    ]);

    const entry = await readEntry('Charlie');
    expect(entry?.buildings?.[0]?.playerOwned).toBe(true);
    const acquired = entry?.history.filter((h) => h.kind === 'acquired') ?? [];
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.reason).toBe('inherited');
  });

  it('补丁里没提的字段保持原值（undefined ≠ 清空）', async () => {
    await commit([
      tileOp('tile_building_add', { tile: 'Charlie', name: 'Mill', description: 'Stone wheel.' }),
    ]);
    await commit([
      tileOp('tile_building_update', { tile: 'Charlie', name: 'Mill', ownerFlavor: 'Guild' }),
    ]);

    expect((await readEntry('Charlie'))?.buildings?.[0]).toMatchObject({
      description: 'Stone wheel.',
      ownerFlavor: 'Guild',
    });
  });

  it('🔴 main:true → 改的是**主建筑**（不按名字寻址，playerOwned 翻真记 acquired）', async () => {
    await commit([
      tileOp('tile_building_update', {
        tile: 'Charlie',
        main: true,
        playerOwned: true,
        ownerFlavor: '玩家',
        income: { amount: 200, periodDays: 1, anchorDay: -999 },
        reason: '受封领地',
      }),
    ]);

    const entry = await readEntry('Charlie');
    // 名字按当前档（3）从包的通名表派生并就此钉住；周期与锚仍由 Code 补（铁律3）
    expect(entry?.mainBuilding).toEqual({
      name: 'S3',
      ownerFlavor: '玩家',
      playerOwned: true,
      income: { amount: 200, periodDays: 30, anchorDay: 0 },
    });
    // 主建筑不占编号槽：起始档 3 → 三个空槽，一个都没被它吃掉
    expect(entry?.buildings).toEqual([null, null, null]);
    expect(entry?.history).toEqual([
      { day: 0, kind: 'acquired', building: 'S3', reason: '受封领地' },
    ]);
  });

  it('main:true 带 name → 那是**改名**（记 renamed），不是寻址', async () => {
    await commit([tileOp('tile_building_update', { tile: 'Charlie', main: true, name: '铁誓堡' })]);
    const entry = await readEntry('Charlie');
    expect(entry?.mainBuilding?.name).toBe('铁誓堡');
    expect(entry?.history).toEqual([{ day: 0, kind: 'renamed', building: '铁誓堡' }]);
  });

  it('🔴 tile_building_add 永远造不出主建筑（每块地恒有一座，不能新建也不能替换）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commit([tileOp('tile_building_add', { tile: 'Charlie', main: true, name: '新城堡' })]);
    expect(await readEntry('Charlie')).toBeUndefined(); // 连播种都不落
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('main:true 落在无发展度的湖面上 → warn + 零写入（那里没有主建筑）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commit([
      tileOp('tile_building_update', { tile: 'Lagoon', main: true, playerOwned: true }),
    ]);
    expect(await readEntry('Lagoon')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('main:true 但地块名认不出 → warn + 零写入，且不打断提交（裁定 §8-3）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commit([
      tileOp('tile_building_update', { tile: '不存在的地', main: true, playerOwned: true }),
    ]);
    expect(Object.keys((await readFacts()).tiles)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('找不到的建筑名 → warn + 无变化（不凭空造一座）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commit([tileOp('tile_building_update', { tile: 'Charlie', name: 'Ghost' })]);
    expect(await readEntry('Charlie')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('tile_dev_progress_add / tile_history_note', () => {
  it('+100 → 升一档、进度清 0，并记 levelUp（含 reason）', async () => {
    await commit([
      tileOp('tile_dev_progress_add', { tile: 'Alpha', amount: 100, reason: 'rebuilt the canal' }),
    ]);

    const entry = await readEntry('Alpha');
    expect(entry?.development).toEqual({ level: 2, progress: 0 });
    expect(entry?.buildings).toHaveLength(2); // 槽数 = 档数
    const levelUp = entry?.history.find((h) => h.kind === 'levelUp');
    expect(levelUp).toMatchObject({ fromLevel: 1, toLevel: 2, reason: 'rebuilt the canal' });
  });

  it('无发展度的湖面上恒无变化（机制面静默无效，flavor 归状态）', async () => {
    await commit([tileOp('tile_dev_progress_add', { tile: 'Lagoon', amount: 50 })]);
    expect(await readEntry('Lagoon')).toBeUndefined();
  });

  it('note 落进编年史并带当天日期', async () => {
    await commit([
      tileOp('tile_history_note', { tile: 'Bravo', text: 'The oath was sworn here.' }),
    ]);
    expect((await readEntry('Bravo'))?.history).toEqual([
      { day: 0, kind: 'note', text: 'The oath was sworn here.' },
    ]);
  });
});

describe('地块名解析（裁定 §8-3：失败 warn + no-op，绝不否决提交）', () => {
  it('认不出的地块名 → 零写入、零报错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sm = createStateManager(SAVE_ID);
    const result = await sm.commitChatState([
      tileOp('tile_status_add', { tile: '不存在的地方', title: 'Flood', durationDays: 5 }),
    ]);

    expect(result.errors).toEqual([]); // 正文提交照常成功
    expect(result.patchesApplied).toBe(1);
    expect(Object.keys((await readFacts()).tiles)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('缺 value.tile → 同样只是 no-op', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commit([tileOp('tile_history_note', { text: 'orphan note' })]);
    expect(Object.keys((await readFacts()).tiles)).toEqual([]);
    warn.mockRestore();
  });
});

describe('copy-on-write 播种（§3）', () => {
  it('首个 op 就把当时的 pack 基线（起始档 + 初始建筑）种进事实', async () => {
    await commit([tileOp('tile_history_note', { tile: 'Bravo', text: 'first record' })]);

    const entry = await readEntry('Bravo');
    expect(entry?.seededAtDay).toBe(0);
    expect(entry?.development).toEqual({ level: 2, progress: 0 });
    expect(entry?.buildings?.map((b) => b?.name)).toEqual(['Granary', 'Beacon']);
    // 播种**不写编年史**：初始建筑不是「落成」事件
    expect(entry?.history.map((h) => h.kind)).toEqual(['note']);
  });

  it('播种之后事实为权威：删掉的建筑不会被 pack 基线复活', async () => {
    await commit([
      // 档 2 → 降到档 1，最高号槽（Beacon）连槽带建筑一起没
      tileOp('tile_dev_progress_add', { tile: 'Bravo', amount: -50 }),
    ]);
    const entry = await readEntry('Bravo');
    expect(entry?.development).toEqual({ level: 1, progress: 50 });
    expect(entry?.buildings?.map((b) => b?.name)).toEqual(['Granary']);
    expect(entry?.history.find((h) => h.kind === 'destroyed')?.building).toBe('Beacon');
  });
});

// ═══════════════════════════════════════════════════════════
// 首访记档（§F5）
// ═══════════════════════════════════════════════════════════

describe('首访记档 —— set_location 旁观', () => {
  it('玩家落位 → 记一条 firstVisit；来回走同一块地只记一次', async () => {
    await commit([{ op: 'set_location', target: 'characters.Hero', value: 'Alpha' }]);
    expect((await readEntry('Alpha'))?.history.map((h) => h.kind)).toEqual(['firstVisit']);

    await commit([{ op: 'set_location', target: 'characters.Hero', value: 'Bravo' }]);
    await commit([{ op: 'set_location', target: 'characters.Hero', value: 'Alpha' }]);

    const alpha = await readEntry('Alpha');
    expect(alpha?.history.filter((h) => h.kind === 'firstVisit')).toHaveLength(1);
    expect((await readEntry('Bravo'))?.history.map((h) => h.kind)).toEqual(['firstVisit']);
  });

  it('NPC 换位置一个字节都不写（player only，口径同落位钩子）', async () => {
    await saveCharacter(
      createDefaultCharacterState({
        id: 'scout-1',
        saveId: SAVE_ID,
        name: 'Scout',
        type: 'npc',
        location: 'Alpha',
      }),
    );
    await commit([{ op: 'set_location', target: 'characters.Scout', value: 'Charlie' }]);
    expect(Object.keys((await readFacts()).tiles)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 换包自愈边界（§3：事实不是派生态）
// ═══════════════════════════════════════════════════════════

describe('packStamp 自愈**不碰** mapFacts', () => {
  it('换包后派生态清空重落位，事实原样还在', async () => {
    await commit([tileOp('tile_history_note', { tile: 'Alpha', text: 'kept' })]);

    installMapPack(buildPack('hash-v2')); // contentHash 变了 → 触发派生态自愈
    await commit([{ op: 'set_location', target: 'characters.Hero', value: 'Bravo' }]);

    const profile = await getProfile(SAVE_ID);
    expect(profile.worldFlags.map.packStamp).toBe('hash-v2'); // 派生态确实自愈过
    expect(getMapFactsFlags(profile).tiles['Alpha']?.history[0]?.text).toBe('kept');
  });
});

// ═══════════════════════════════════════════════════════════
// 按期结算（§4 时间账本）
// ═══════════════════════════════════════════════════════════

describe('applyTimeAdvance → 地块按期结算', () => {
  it('限时状态到期 → 摘掉 + 出一条中文系统新闻', async () => {
    await commit([tileOp('tile_status_add', { tile: 'Alpha', title: 'Flood', durationDays: 10 })]);

    await advanceDays(20);

    expect((await readEntry('Alpha'))?.statuses).toEqual([]);
    const news = await readNews();
    expect(news.some((n) => n.title.includes('Alpha') && n.content.includes('Flood'))).toBe(true);
    expect(news.some((n) => n.content.includes('到期'))).toBe(true);
  });

  it('玩家产业到入账点 → 钱真的进了玩家 money，并出一条新闻', async () => {
    await commit([
      tileOp('tile_building_add', {
        tile: 'Charlie',
        name: 'Tavern',
        playerOwned: true,
        income: { amount: 50 },
      }),
    ]);

    await advanceDays(65); // 跨 2 个 30 天锚点 → 补结算两期

    expect(await readMoney()).toBe(100 + 50 * 2);
    expect((await readNews()).some((n) => n.content.includes('Tavern'))).toBe(true);
  });

  it('🔴 主建筑产业同样入账（住独立字段，漏扫 = 王冠级产业静默不给钱）', async () => {
    await commit([
      tileOp('tile_building_update', {
        tile: 'Charlie',
        main: true,
        playerOwned: true,
        income: { amount: 200 },
      }),
    ]);

    await advanceDays(65);

    expect(await readMoney()).toBe(100 + 200 * 2);
    // 新闻里说得清这笔钱是主建筑来的（`main` 标记的用处）
    const news = await readNews();
    expect(news.some((n) => n.content.includes('主建筑「S3」入账'))).toBe(true);
  });

  it('🔴 降档摧毁最高号槽，主建筑毫发无伤（降档免疫，裁定 §8-17）', async () => {
    await commit([
      tileOp('tile_building_update', { tile: 'Bravo', main: true, ownerFlavor: '守望公会' }),
      tileOp('tile_status_add', {
        tile: 'Bravo',
        title: 'Blight',
        durationDays: -1,
        effects: [{ kind: 'devProgressPerMonth', amount: -60 }],
      }),
    ]);

    await advanceDays(31);

    const entry = await readEntry('Bravo');
    expect(entry?.development?.level).toBe(1);
    expect(entry?.buildings?.map((b) => b?.name)).toEqual(['Granary']); // Beacon 连槽带人没了
    expect(entry?.mainBuilding).toEqual({ name: 'S2', ownerFlavor: '守望公会' });
  });

  it('周期效果压到降档 → 摧毁最高号槽的建筑并出新闻（引用在场的负面状态）', async () => {
    await commit([
      tileOp('tile_status_add', {
        tile: 'Bravo',
        title: 'Blight',
        durationDays: -1,
        effects: [{ kind: 'devProgressPerMonth', amount: -60 }],
      }),
    ]);

    await advanceDays(31);

    const entry = await readEntry('Bravo');
    expect(entry?.development?.level).toBe(1);
    expect(entry?.buildings?.map((b) => b?.name)).toEqual(['Granary']);

    const news = await readNews();
    expect(news.some((n) => n.content.includes('Beacon') && n.content.includes('Blight'))).toBe(
      true,
    );
  });

  it('休眠地块整块冻结：名字不在现行包里 → 不到期、不入账（§3）', async () => {
    await seedFacts({
      Ghostwood: {
        seededAtDay: 0,
        development: { level: 2, progress: 0 },
        statuses: [
          { title: 'Flood', description: '', effects: [], durationDays: 5, appliedAtDay: 0 },
        ],
        buildings: [
          {
            name: 'Lodge',
            playerOwned: true,
            income: { amount: 40, periodDays: 30, anchorDay: 0 },
          },
          null,
        ],
        history: [],
      },
    });

    await advanceDays(90);

    // 状态没被摘、钱没入账 —— 时间对休眠块冻结
    expect((await readEntry('Ghostwood'))?.statuses).toHaveLength(1);
    expect(await readMoney()).toBe(100);
    expect(await readNews()).toEqual([]);
  });

  it('没有任何事实时零开销、零写入（新档的常态）', async () => {
    await advanceDays(60);
    expect(Object.keys((await readFacts()).tiles)).toEqual([]);
    expect(await readNews()).toEqual([]);
  });
});
