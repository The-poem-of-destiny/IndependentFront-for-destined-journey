/**
 * state-manager.map-income.test.ts — F08 收益记收账本的**接线**测试
 * （docs/known-issue.md「地图 v1.2 结算的两条收益丢账」第 2 条 / F08_recoverable_map_income.md）
 *
 * 为什么是链路测试而不是纯函数测试：借据的折叠（`buildMapIncomeEntry`）、幂等合并
 * （`mergeMapIncomePending`）与防御性消费在接线层（state-manager.ts「🧾 收益记收账本」节），
 * 算术在 map-dynamics / time-ledger 已测透。这里要钉的全是**接线**才会错的事 ——
 * 收益有没有在结算**同一拍**落成持久借据、给钱和标记是不是同一事务、崩溃/写失败之后
 * 重放是不是**恰好一次**、快照回退会不会重复支付/丢账。
 *
 * 所以一律从真入口出发，落到真 Dexie（fake-indexeddb）上回读：
 *   · `commitChatState(tile_building_add / tile_building_update)` 造产业
 *   · `applyTimeAdvance` 推进时间（锁内记收 + 锁外重放）
 *   · `settlePendingMapIncome` 显式重放
 *   · `createSnapshot` / `restoreSnapshot` 验证快照回退一致性
 *
 * 故障注入用 `db.characters.put` 单点失败：推进 65 天时锁内没有任何别的 characters 写
 * （既无到期状态效果、patches 自提交也早退），所以唯一命中的就是重放事务里的那一次 put ——
 * Dexie 整事务回滚，借据保持未应用，正好复现「跨过收益边界 → 收款写失败」的病灶。
 *
 * 🔴 夹具零真实地名（承 D25①，照 state-manager.map-facts.test.ts）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllData,
  getCharacters,
  getDatabase,
  initializeDatabase,
  saveCharacter,
} from './database';
import * as saveProfileModule from './save-profile';
import {
  createStateManager,
  getMapIncomeFlags,
  type MapIncomeFlags,
  type MapIncomePendingEntry,
} from './state-manager';
import { installMapPack, resetMapRuntime } from './map-runtime';
import { createDefaultCharacterState } from './types';
import { createDefaultTime } from './time-system';
import type { StatePatch } from './types';
import type { MapPack, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具（同 map-facts 测试：Charlie = 产业区）
// ═══════════════════════════════════════════════════════════

const SAVE_ID = 'save-map-income';

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
    mainBuildingNames: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'],
    countries: [{ id: 'north', name: 'Northland', color: [1, 2, 3], anchorTileId: 1 }],
    midTiers: [
      { id: 'zone-a', name: 'Zone Alpha', countryId: 'north', climateId: 'cold', anchorTileId: 1 },
    ],
    climates: { cold: { name: 'Cold Zone', table: { 春季: [['snow', 1]] } } },
    tiles: [tile(1, 'Alpha'), tile(3, 'Charlie', { development: 3 })],
    adjacency: [[1, 3, 90]],
    straits: [],
    placeBindings: {},
  };
}

// ═══════════════════════════════════════════════════════════
// 装台
// ═══════════════════════════════════════════════════════════

async function seedPlayer(): Promise<void> {
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero-1',
      saveId: SAVE_ID,
      name: 'Hero',
      type: 'player',
      location: 'Northland-Zone Alpha-Alpha',
      money: 100,
    }),
  );
}

/** profile 必须先存在（`gameTime` 从缺省起算 = 第 0 游戏日） */
async function seedProfile(): Promise<void> {
  const profile = await saveProfileModule.getProfile(SAVE_ID);
  profile.gameTime = createDefaultTime();
  await saveProfileModule.updateProfile(profile);
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

async function readMoney(): Promise<number | undefined> {
  return (await getCharacters(SAVE_ID)).find((c) => c.type === 'player')?.money;
}

async function readBag(): Promise<MapIncomeFlags> {
  return getMapIncomeFlags(await saveProfileModule.getProfile(SAVE_ID));
}

function makeEntry(overrides: Partial<MapIncomePendingEntry>): MapIncomePendingEntry {
  return {
    id: 'Charlie::Tavern::slot::0..65',
    tile: 'Charlie',
    building: 'Tavern',
    recipient: 'Hero',
    amount: 100,
    fromDay: 0,
    toDay: 65,
    recordedAtDay: 65,
    applied: false,
    ...overrides,
  };
}

/** 直接把一份借据袋塞进存档（重放/防御用例的起手式，绕开记收路径） */
async function seedBag(pending: MapIncomePendingEntry[]): Promise<void> {
  const profile = await saveProfileModule.getProfile(SAVE_ID);
  profile.worldFlags.mapIncome = { pending };
  await saveProfileModule.updateProfile(profile);
}

/** 在现代 `Charlie` 挂一座玩家酒馆：每 30 天 50 G，锚在第 0 天 */
async function seedTavern(): Promise<void> {
  await commit([
    tileOp('tile_building_add', {
      tile: 'Charlie',
      name: 'Tavern',
      playerOwned: true,
      income: { amount: 50 },
    }),
  ]);
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
// F08 回归 —— 病灶：跨收益边界 → 收款写失败 → 该期收益本应永久丢失
// ═══════════════════════════════════════════════════════════

describe('F08 可恢复收益（持久借据 + 幂等重放）', () => {
  it('🔴 回归主案：收款写失败 → 借据保留 → 重放恰好一次入账，不丢不重', async () => {
    await seedTavern();

    // 注入：重放事务里的角色写失败一次（推进 65 天时锁内没有任何别的 characters 写，
    // 详情见文件头）。Dexie 整事务回滚 → 钱没给、标记没写，借据原样在袋里。
    const putSpy = vi
      .spyOn(getDatabase().characters, 'put')
      .mockRejectedValueOnce(new Error('injected recipient write failure'));
    await advanceDays(65); // 跨 2 个 30 天锚点
    putSpy.mockRestore();

    // 时间已推进、借据已落、钱没到（旧实现里这一步之后就是永久丢失）
    expect(await readMoney()).toBe(100);
    const bag = await readBag();
    expect(bag.pending).toHaveLength(1);
    expect(bag.pending[0]).toMatchObject({
      tile: 'Charlie',
      building: 'Tavern',
      amount: 100,
      fromDay: 0,
      toDay: 65,
      applied: false,
    });

    // 重放：恰一次入账
    const sm = createStateManager(SAVE_ID);
    const first = await sm.settlePendingMapIncome();
    expect(first).toEqual({ credited: 1, failed: 0, rolledBack: false });
    expect(await readMoney()).toBe(100 + 100);
    expect((await readBag()).pending[0]?.applied).toBe(true);
    expect((await readBag()).pending[0]?.appliedAtDay).toBe(65);

    // 丢了确认后再重放：已经是 applied → 跳过，绝不多给
    const second = await sm.settlePendingMapIncome();
    expect(second).toEqual({ credited: 0, failed: 0, rolledBack: false });
    expect(await readMoney()).toBe(200);
  });

  it('🔴 结构断言：结算那一次档案写里，事实与借据同袋（窗口推进不先于记账）', async () => {
    await seedTavern();
    const updateSpy = vi.spyOn(saveProfileModule, 'updateProfile');

    await advanceDays(65);

    // 存在同一次 `updateProfile` 调用既带更新后的事实态、又带借据 —— 拆开写就是病灶。
    // （`applyTimeAdvance` 第一步「时间推进」的那次写不会带 mapIncome，可区分。）
    const settledCall = updateSpy.mock.calls
      .map((call) => call[0])
      .find((p) => getMapIncomeFlags(p).pending.length > 0);
    expect(settledCall).toBeDefined();
    expect(settledCall?.worldFlags.mapFacts).toBeDefined();
    updateSpy.mockRestore();
  });

  it('收不到确认再重放：applied 借据被跳过、unapplied 借据照常入账（不连坐）', async () => {
    await seedBag([
      makeEntry({ id: 'Charlie::Tavern::slot::0..30', amount: 30, applied: true }),
      makeEntry({ id: 'Charlie::Inn::slot::0..30', building: 'Inn', amount: 70 }),
    ]);

    const sm = createStateManager(SAVE_ID);
    const result = await sm.settlePendingMapIncome();

    expect(result).toEqual({ credited: 1, failed: 0, rolledBack: false });
    expect(await readMoney()).toBe(170); // 100 + 70（applied 那条不重付）
    const bag = await readBag();
    expect(bag.pending.find((p) => p.building === 'Tavern')?.applied).toBe(true);
    expect(bag.pending.find((p) => p.building === 'Inn')?.applied).toBe(true);
  });

  it('重复 id 借据只入账首条（坏备份防御），畸形金额跳过不标记不丢账', async () => {
    await seedBag([
      makeEntry({ amount: 40 }),
      makeEntry({}), // 同 id 第二条
      makeEntry({ id: 'Charlie::Drain::slot::0..30', building: 'Drain', amount: 0 }),
    ]);

    const sm = createStateManager(SAVE_ID);
    const result = await sm.settlePendingMapIncome();

    expect(result.credited).toBe(1); // 只入首条
    expect(result.failed).toBe(2); // 重复 + 畸形各计一次失败
    expect(await readMoney()).toBe(140); // 100 + 40

    const dupes = (await readBag()).pending.filter((p) => p.id === 'Charlie::Tavern::slot::0..65');
    expect(dupes).toHaveLength(2);
    expect(dupes[0]?.applied).toBe(true); // 数组序 = 消费序：首条入账
    expect(dupes[0]?.amount).toBe(40);
    expect(dupes[1]?.applied).toBe(false); // 第二条跳过不标记
    expect((await readBag()).pending.find((p) => p.building === 'Drain')?.applied).toBe(false);
  });

  it('主建筑产业同样走借据（main 事件入账 + applied 标记）', async () => {
    await commit([
      tileOp('tile_building_update', {
        tile: 'Charlie',
        main: true,
        playerOwned: true,
        income: { amount: 200 },
      }),
    ]);

    await advanceDays(65); // 跨 2 期 → 自动记收 + 自动重放

    expect(await readMoney()).toBe(100 + 200 * 2);
    const bag = await readBag();
    expect(bag.pending).toHaveLength(1);
    expect(bag.pending[0]).toMatchObject({
      building: 'S3',
      main: true,
      amount: 400,
      applied: true,
    });
  });

  it('零收益推进：不产生借据、不写袋、不干扰新闻', async () => {
    await advanceDays(60);
    expect((await readBag()).pending).toEqual([]);
    expect(await readMoney()).toBe(100);
    expect((await saveProfileModule.getProfile(SAVE_ID)).news).toEqual([]);
  });

  it('分段推进与整段推进的总入账相同（借据按窗口推导，不因拆段变堆叠/变丢失）', async () => {
    await seedTavern(); // anchor 0 / 每 30 天 50 G

    await advanceDays(30); // (0, 30]  恰 1 期 → +50
    expect(await readMoney()).toBe(150);
    await advanceDays(35); // (30, 65] 再 1 期 → +50
    expect(await readMoney()).toBe(200);
    await advanceDays(65); // (65, 130] 跨第 95 / 125 两个锚点 → +100

    // 130 个游戏日的累计期数由锚纯推导 = floor(130/30) = 4 期，与拆成几次推进无关
    expect(await readMoney()).toBe(100 + 50 * 4);
  });

  it('没有玩家角色：借据保留待查（不标记、不删除、不抛），入账对象缺失不是丢弃理由', async () => {
    await seedBag([makeEntry({})]);
    await getDatabase().characters.delete('hero-1');

    const sm = createStateManager(SAVE_ID);
    await expect(sm.settlePendingMapIncome()).resolves.toMatchObject({
      credited: 0,
      rolledBack: false,
    });

    expect((await readBag()).pending[0]?.applied).toBe(false); // 保留
  });

  describe('快照回退一致性（借据与 money 同档同滚）', () => {
    it('借据 unapplied 时回退 → 重放恰好一次补偿', async () => {
      await seedTavern();
      // 第一次推进的收款写失败 → 借据落袋、钱未到
      const putSpy = vi
        .spyOn(getDatabase().characters, 'put')
        .mockRejectedValueOnce(new Error('injected'));
      await advanceDays(65);
      putSpy.mockRestore();
      expect(await readMoney()).toBe(100);

      const sm = createStateManager(SAVE_ID);
      const snapshot = await sm.createSnapshot('manual', 1);
      await sm.restoreSnapshot(snapshot.id);

      // 快照整档回滚：借据（unapplied）和钱（100）回到推进前
      expect(await readMoney()).toBe(100);
      expect((await readBag()).pending).toHaveLength(1);

      await sm.settlePendingMapIncome();
      expect(await readMoney()).toBe(200);
      await sm.settlePendingMapIncome();
      expect(await readMoney()).toBe(200); // 恰一次
    });

    it('借据 applied 后回退 → 重放不重复支付（别把旧 applied 当成可再入账）', async () => {
      await seedTavern();
      await advanceDays(65); // 正常路径：入账完成
      expect(await readMoney()).toBe(200);

      const sm = createStateManager(SAVE_ID);
      const snapshot = await sm.createSnapshot('manual', 1);
      await sm.restoreSnapshot(snapshot.id);

      // 快照里有已入账的钱和 applied 借据 —— 哪里都不该再多给
      expect(await readMoney()).toBe(200);
      await sm.settlePendingMapIncome();
      expect(await readMoney()).toBe(200);
    });
  });
});
