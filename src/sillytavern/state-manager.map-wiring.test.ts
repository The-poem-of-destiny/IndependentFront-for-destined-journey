/**
 * state-manager.map-wiring.test.ts — 地图接线的**链路**测试（地图系统 v1 / 设计 §5·§7·§8.2）
 *
 * 为什么是链路测试而不是纯函数测试：设计 §10 最后一条点名了这件事 ——
 * 「教训是 `blurByDefault`：单组件测试证明逻辑对、证明不了有人供值；两处天气漂移同因」。
 * 所以这里一律从**真入口**出发（`commitChatState(set_location)` / `applyTimeAdvance` /
 * `syncMapJourney`），落到**真 Dexie**（fake-indexeddb）里的 `SaveProfile.worldFlags.map` 上回读。
 * 落位算得对但没人调用、或者算完了没人落库，这个文件必须变红。
 *
 * 用真库（不 mock `./database` 与 `./save-profile`）的第二个理由：命名写入口
 * `updateMapFlags` 落的是**整份 profile**，「天气标签与它的戳不可能只落一半」这条断言
 * 在 mock 上是恒真的。
 *
 * 覆盖（每条都对应一种「不报错的错」）:
 * - 玩家 `set_location` → `lastTileId` 落库；**NPC 一个字节都不写**（裁定 §12-3 player only）
 * - 认不出的位置 → `lastTileId` **保持原值**（§8.2-5，绝不模糊落位）
 * - 不相邻的跳跃 → `lastMoveDiscontinuity`（只校验不否决，裁定 §12-4）；相邻移动清掉它
 * - 落到 `journey.toTileId` → 到达即清旗
 * - 换包（`packStamp` 不符）→ 派生态清空 + 按当前位置路径**立刻**重落位（§3.4-2 自愈）
 * - 跨天 → 写 `variables.sys.天气` + 戳；**同日同区不重写**（AI 覆盖要能活过这一天，§12-6）
 * - 同日**换区** → 重断言（戳是 `{day, zoneId}` 两轴，少比一轴就是无声的错）
 * - `sys.旅行目的地` 的设 / 清 / 认不出 / 无路 四条路径（裁定 §12-8）
 * - 没装地图包 → 整条链 no-op（地图是**可选**子系统）
 *
 * 🔴 夹具零真实地名（承 D25①）。季节键用的是 `getSeason()` 真会产出的值 —— 天气表按
 *    季节键查表，夹具写个别的词就会静默走「回退第一张表」，那时这些用例测的是回退路径。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData, getCharacters, initializeDatabase, saveCharacter } from './database';
import { getMapFlags, getProfile, updateProfile } from './save-profile';
import { createStateManager } from './state-manager';
import { installMapPack, resetMapRuntime } from './map-runtime';
import { createDefaultCharacterState } from './types';
import { createDefaultTime, toEpochMinutes } from './time-system';
import type { MapPack, MapSaveFlags, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 合成夹具
// ═══════════════════════════════════════════════════════════

const SAVE_ID = 'save-map-wiring';

/** 一游戏日；与 state-manager 里那个常量同值（这里独立写一份，好让漂移变红） */
const MINUTES_PER_DAY = 1440;

/** `createDefaultTime()` = 488-01-01 08:00 → epoch 480 分 → 第 0 游戏日 */
const START_MINUTE = toEpochMinutes(createDefaultTime());

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
 * 4 块地 + 1 座孤岛，两个气候区:
 *   1 Alpha ↔ 2 Bravo ↔ 3 Charlie —— 线状；**1 与 3 不相邻**（有 2 跳的路，但没有直接边）
 *   3 Charlie / 4 Delta 在 zone-b（换区重断言用）
 *   9 Island —— 一条边都没有：`findPath` 到它必然无路（在途旗「无路仍设旗」那条）
 *
 * 天气表每区**只有一行**（权重 1）→ 采样结果确定：zone-a = snow，zone-b = rain。
 * 一行表是刻意的：这些用例要断言的是「什么时候重断言」，不是加权采样（那在 map-weather.test.ts）。
 */
function buildPack(contentHash: string): MapPack {
  return {
    version: '1.0.0',
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
    countries: [{ id: 'north', name: 'Northland', color: [1, 2, 3], anchorTileId: 1 }],
    midTiers: [
      { id: 'zone-a', name: 'Zone Alpha', countryId: 'north', climateId: 'cold', anchorTileId: 1 },
      { id: 'zone-b', name: 'Zone Beta', countryId: 'north', climateId: 'mild', anchorTileId: 3 },
    ],
    climates: {
      cold: { name: 'Cold Zone', table: { 春季: [['snow', 1]] } },
      mild: { name: 'Mild Zone', table: { 春季: [['rain', 1]] } },
    },
    tiles: [
      tile(1, 'Alpha'),
      tile(2, 'Bravo'),
      tile(3, 'Charlie', { midTierId: 'zone-b' }),
      tile(4, 'Delta', { midTierId: 'zone-b' }),
      tile(9, 'Island', { midTierId: null, countryId: null }),
    ],
    adjacency: [
      [1, 2, 120],
      [2, 3, 90],
      [3, 4, 60],
    ],
    straits: [],
    placeBindings: { 'Alpha Gate': 1 },
  };
}

// ═══════════════════════════════════════════════════════════
// 装台
// ═══════════════════════════════════════════════════════════

async function seedPlayer(location: string): Promise<void> {
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero-1',
      saveId: SAVE_ID,
      name: 'Hero',
      type: 'player',
      location,
    }),
  );
}

async function seedNpc(location: string): Promise<void> {
  await saveCharacter(
    createDefaultCharacterState({
      id: 'scout-1',
      saveId: SAVE_ID,
      name: 'Scout',
      type: 'npc',
      location,
    }),
  );
}

/** profile 必须先存在（`gameTime` 从缺省起算），否则第一次 getProfile 才创建它 */
async function seedProfile(patch: Partial<MapSaveFlags> | null = null): Promise<void> {
  const profile = await getProfile(SAVE_ID);
  profile.gameTime = createDefaultTime();
  if (patch !== null) profile.worldFlags.map = patch;
  await updateProfile(profile);
}

async function setLocation(charName: string, value: string): Promise<void> {
  const sm = createStateManager(SAVE_ID);
  const result = await sm.commitChatState([
    { op: 'set_location', target: `characters.${charName}`, value },
  ]);
  expect(result.errors).toEqual([]);
}

async function readFlags(): Promise<MapSaveFlags> {
  return getMapFlags(await getProfile(SAVE_ID));
}

async function readWeather(): Promise<unknown> {
  const profile = await getProfile(SAVE_ID);
  return (profile.variables?.sys as Record<string, unknown> | undefined)?.天气;
}

async function setTravelDestination(value: string): Promise<void> {
  const profile = await getProfile(SAVE_ID);
  profile.variables = { ...(profile.variables ?? {}), sys: { 旅行目的地: value } };
  await updateProfile(profile);
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首跑时库还不存在 */
  }
  await initializeDatabase();
  resetMapRuntime();
});

/** 位置路径这个**真源**当前是什么（地图层永不改写它，裁定 §12-1） */
async function readPlayerLocation(): Promise<string | undefined> {
  return (await getCharacters(SAVE_ID)).find((c) => c.type === 'player')?.location;
}

// ═══════════════════════════════════════════════════════════
// 落位（§8.2）
// ═══════════════════════════════════════════════════════════

describe('落位钩子 —— set_location → worldFlags.map.lastTileId', () => {
  it('玩家换位置 → lastTileId 落库，并盖上现行包的 contentHash 戳', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile();
    await seedPlayer('Northland-Zone Alpha-Alpha');

    await setLocation('Hero', 'Northland-Zone Alpha-Bravo-码头区');

    const flags = await readFlags();
    expect(flags.lastTileId).toBe(2); // 最深的钉位段赢，子地块段「码头区」被忽略
    expect(flags.packStamp).toBe('hash-v1');
  });

  it('绑定名字空间（placeBindings）里的聚落名同样钉位', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile();
    await seedPlayer('Alpha Gate');

    await setLocation('Hero', 'Alpha Gate');

    expect((await readFlags()).lastTileId).toBe(1);
  });

  it('🔴 NPC 换位置 → 地图派生态一个字节都不写（裁定 §12-3 player only）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile();
    await seedNpc('Alpha');

    await setLocation('Scout', 'Charlie');

    expect((await getProfile(SAVE_ID)).worldFlags.map).toBeUndefined();
    // NPC 的位置路径本身照常落库 —— 不跟踪指的是不进地图派生态，不是不改位置
    const scout = (await getCharacters(SAVE_ID)).find((c) => c.name === 'Scout');
    expect(scout?.location).toBe('Charlie');
  });

  it('🔴 认不出的位置 → lastTileId 保持原值（绝不模糊落位，§8.2-5）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 2 });
    await seedPlayer('Bravo');

    await setLocation('Hero', 'Nowhere-Untranslated Place');

    expect((await readFlags()).lastTileId).toBe(2);
  });

  it('🔴 不相邻的跳跃 → 照常落位 + lastMoveDiscontinuity=1（只校验不否决）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');

    // 1 与 3 之间有 2 跳的路，但**没有直接边** —— 一步到位就是不连续
    await setLocation('Hero', 'Charlie');

    const flags = await readFlags();
    expect(flags.lastTileId).toBe(3);
    expect(flags.lastMoveDiscontinuity).toBe(1);
  });

  it('随后一次相邻移动清掉 lastMoveDiscontinuity（否则提示行会一直挂着）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 3, lastMoveDiscontinuity: 1 });
    await seedPlayer('Charlie');

    await setLocation('Hero', 'Delta');

    const flags = await readFlags();
    expect(flags.lastTileId).toBe(4);
    expect(flags.lastMoveDiscontinuity).toBeUndefined();
  });

  it('落到目的地 → 在途旗即清（在途旗是数据不是状态机）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({
      packStamp: 'hash-v1',
      lastTileId: 1,
      journey: { toTileId: 2, plannedPath: [1, 2], arriveAtMinute: START_MINUTE + MINUTES_PER_DAY },
    });
    await seedPlayer('Alpha');

    await setLocation('Hero', 'Bravo');

    const flags = await readFlags();
    expect(flags.lastTileId).toBe(2);
    expect(flags.journey).toBeUndefined();
  });

  it('🔴 没装地图包 → 整条链 no-op（地图是可选子系统）', async () => {
    await seedProfile();
    await seedPlayer('Alpha');

    await setLocation('Hero', 'Bravo');

    expect((await getProfile(SAVE_ID)).worldFlags.map).toBeUndefined();
    // 位置路径这个真源照旧写进去了 —— no-op 说的是地图层，不是整条 op
    expect(await readPlayerLocation()).toBe('Bravo');
  });
});

// ═══════════════════════════════════════════════════════════
// 换包自愈（§3.4-2）
// ═══════════════════════════════════════════════════════════

describe('换包自愈 —— packStamp 不符 → 清派生态 + 立刻重落位', () => {
  it('时间推进这条路上也自愈：旧派生态清空，按当前位置路径重落位', async () => {
    installMapPack(buildPack('hash-v2'));
    await seedProfile({
      packStamp: 'hash-v1-old',
      lastTileId: 4, // 旧地图上的块号
      lastMoveDiscontinuity: 1,
      journey: { toTileId: 3, plannedPath: [4, 3], arriveAtMinute: 999 },
      weatherStamp: { day: 77, zoneId: 'zone-old' },
    });
    await seedPlayer('Alpha');

    await createStateManager(SAVE_ID).applyTimeAdvance(60);

    const flags = await readFlags();
    expect(flags.packStamp).toBe('hash-v2');
    // 🔴 「立刻」是关键：不等下一次移动，否则棋子会在地图上消失整整一段游玩
    expect(flags.lastTileId).toBe(1);
    expect(flags.journey).toBeUndefined();
    expect(flags.lastMoveDiscontinuity).toBeUndefined();
    // 旧戳（day 77 / zone-old）已被本次断言换掉
    expect(flags.weatherStamp).toEqual({ day: 0, zoneId: 'zone-a' });
  });

  it('落位钩子这条路上同样自愈，且随后按新位置投影', async () => {
    installMapPack(buildPack('hash-v2'));
    await seedProfile({ packStamp: 'hash-v1-old', lastTileId: 4 });
    await seedPlayer('Alpha');

    await setLocation('Hero', 'Bravo');

    const flags = await readFlags();
    expect(flags.packStamp).toBe('hash-v2');
    expect(flags.lastTileId).toBe(2);
    // 🔴 换包后的第一次移动**不该**报不连续：自愈是在 location 落库之后跑的，所以它算出的
    //    「上一块」就是这一次的目的地 —— 而「上一跳跨了多远」这个说法在换图之后本就不成立
    //    （旧包的块号与新包无关）。旧的 lastTileId=4 绝不能拿来跟新包的 2 比邻接。
    expect(flags.lastMoveDiscontinuity).toBeUndefined();
  });

  it('自愈时位置路径认不出 → 只留新戳（棋子未定位，但不崩、也不瞎指）', async () => {
    installMapPack(buildPack('hash-v2'));
    await seedProfile({ packStamp: 'hash-v1-old', lastTileId: 4 });
    await seedPlayer('Somewhere Unmapped');

    await createStateManager(SAVE_ID).applyTimeAdvance(60);

    expect(await readFlags()).toEqual({ packStamp: 'hash-v2' });
  });
});

// ═══════════════════════════════════════════════════════════
// 天气（§7 / 裁定 §12-6）
// ═══════════════════════════════════════════════════════════

describe('天气断言 —— applyTimeAdvance 跨天/换区才重掷', () => {
  it('首次推进 → 写 variables.sys.天气 + weatherStamp', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');

    await createStateManager(SAVE_ID).applyTimeAdvance(30);

    expect(await readWeather()).toBe('snow');
    expect((await readFlags()).weatherStamp).toEqual({ day: 0, zoneId: 'zone-a' });
  });

  it('跨天 → 重断言（戳的 day 跟着走）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({
      packStamp: 'hash-v1',
      lastTileId: 1,
      weatherStamp: { day: 0, zoneId: 'zone-a' },
    });
    await seedPlayer('Alpha');

    await createStateManager(SAVE_ID).applyTimeAdvance(MINUTES_PER_DAY);

    expect(await readWeather()).toBe('snow');
    expect((await readFlags()).weatherStamp).toEqual({ day: 1, zoneId: 'zone-a' });
  });

  it('🔴 同日同区再推进 → 不重写：AI 覆盖的叙事性天气要能活过这一天', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');

    const sm = createStateManager(SAVE_ID);
    await sm.applyTimeAdvance(30);
    expect(await readWeather()).toBe('snow');

    // AI 经既有写路径覆盖（冲突 AI 赢）
    await sm.commitChatState([{ op: 'set_variable', target: 'variables.sys.天气', value: '血月' }]);

    await sm.applyTimeAdvance(30); // 同一天、同一区
    expect(await readWeather()).toBe('血月');
    expect((await readFlags()).weatherStamp).toEqual({ day: 0, zoneId: 'zone-a' });
  });

  it('🔴 同日**换区** → 重断言（戳是 {day, zoneId} 两轴，少比一轴就是无声的错）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');

    const sm = createStateManager(SAVE_ID);
    await sm.applyTimeAdvance(30);
    expect(await readWeather()).toBe('snow');

    await setLocation('Hero', 'Charlie'); // zone-b
    await sm.applyTimeAdvance(30); // 仍是第 0 天

    expect(await readWeather()).toBe('rain');
    expect((await readFlags()).weatherStamp).toEqual({ day: 0, zoneId: 'zone-b' });
  });

  it('没落位 → 不断言（不知道在哪个气候区就什么都不写）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1' });
    await seedPlayer('Somewhere Unmapped');

    await createStateManager(SAVE_ID).applyTimeAdvance(30);

    expect(await readWeather()).toBeUndefined();
    expect((await readFlags()).weatherStamp).toBeUndefined();
  });

  it('落在没有中层的孤岛 → 无气候区，不断言', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 9 });
    await seedPlayer('Island');

    await createStateManager(SAVE_ID).applyTimeAdvance(30);

    expect(await readWeather()).toBeUndefined();
    expect((await readFlags()).weatherStamp).toBeUndefined();
  });

  it('包里一张可用天气表都没有 → 只更新戳，绝不凭空造标签', async () => {
    const noWeather = buildPack('hash-dry');
    noWeather.climates = {};
    installMapPack(noWeather);
    await seedProfile({ packStamp: 'hash-dry', lastTileId: 1 });
    await seedPlayer('Alpha');

    await createStateManager(SAVE_ID).applyTimeAdvance(30);

    expect(await readWeather()).toBeUndefined();
    expect((await readFlags()).weatherStamp).toEqual({ day: 0, zoneId: 'zone-a' });
  });

  it('没装地图包 → 时间照常推进，天气一格不碰', async () => {
    await seedProfile();
    await seedPlayer('Alpha');

    await createStateManager(SAVE_ID).applyTimeAdvance(MINUTES_PER_DAY);

    const profile = await getProfile(SAVE_ID);
    expect(profile.worldFlags.map).toBeUndefined();
    expect(toEpochMinutes(profile.gameTime)).toBe(START_MINUTE + MINUTES_PER_DAY);
  });
});

// ═══════════════════════════════════════════════════════════
// 在途旗（§8.2 / 裁定 §12-8）
// ═══════════════════════════════════════════════════════════

describe('在途旗胶水 —— sys.旅行目的地 → worldFlags.map.journey', () => {
  it('有目的地且落位成功 → 设旗（含计划路线与到达估算）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');
    await setTravelDestination('Charlie');

    await createStateManager(SAVE_ID).syncMapJourney();

    const journey = (await readFlags()).journey;
    expect(journey?.toTileId).toBe(3);
    expect(journey?.plannedPath).toEqual([1, 2, 3]);
    // 到达时刻 = 现在 + 天数 × 1440（天数由 findPath 估算，至少 1 天）
    expect(journey?.arriveAtMinute).toBeGreaterThanOrEqual(START_MINUTE + MINUTES_PER_DAY);
    expect((journey!.arriveAtMinute - START_MINUTE) % MINUTES_PER_DAY).toBe(0);
  });

  it('目的地清空 → 清旗', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({
      packStamp: 'hash-v1',
      lastTileId: 1,
      journey: { toTileId: 3, plannedPath: [1, 2, 3], arriveAtMinute: 9999 },
    });
    await seedPlayer('Alpha');
    await setTravelDestination('   ');

    await createStateManager(SAVE_ID).syncMapJourney();

    const flags = await readFlags();
    expect(flags.journey).toBeUndefined();
    expect(flags.lastTileId).toBe(1); // 别的格子一个都不动
  });

  it('目的地 = 当前所在块 → 清旗（已经到了）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({
      packStamp: 'hash-v1',
      lastTileId: 3,
      journey: { toTileId: 3, plannedPath: [1, 2, 3], arriveAtMinute: 9999 },
    });
    await seedPlayer('Charlie');
    await setTravelDestination('Charlie');

    await createStateManager(SAVE_ID).syncMapJourney();

    expect((await readFlags()).journey).toBeUndefined();
  });

  it('🔴 目的地认不出 → 什么都不做（不设旗、不清旗、不报错）', async () => {
    installMapPack(buildPack('hash-v1'));
    const existing = {
      packStamp: 'hash-v1',
      lastTileId: 1,
      journey: { toTileId: 3, plannedPath: [1, 2, 3], arriveAtMinute: 4242 },
    };
    await seedProfile(existing);
    await seedPlayer('Alpha');
    await setTravelDestination('Untranslated Destination');

    await createStateManager(SAVE_ID).syncMapJourney();

    expect(await readFlags()).toEqual(existing);
  });

  it('无路可走（孤岛）→ 照样设旗，但没有计划路线、到达时刻 = 现在', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({ packStamp: 'hash-v1', lastTileId: 1 });
    await seedPlayer('Alpha');
    await setTravelDestination('Island');

    await createStateManager(SAVE_ID).syncMapJourney();

    const journey = (await readFlags()).journey;
    expect(journey?.toTileId).toBe(9);
    expect(journey?.plannedPath).toBeUndefined();
    expect(journey?.arriveAtMinute).toBe(START_MINUTE);
  });

  it('目的地只写到国家粗度、且队伍已在域内 → 清旗（AI 在说模糊话）', async () => {
    installMapPack(buildPack('hash-v1'));
    await seedProfile({
      packStamp: 'hash-v1',
      lastTileId: 1,
      journey: { toTileId: 3, plannedPath: [1, 2, 3], arriveAtMinute: 9999 },
    });
    await seedPlayer('Alpha');
    await setTravelDestination('Northland');

    await createStateManager(SAVE_ID).syncMapJourney();

    expect((await readFlags()).journey).toBeUndefined();
  });

  it('🔴 没装地图包 → no-op（连 profile 都不该被盖上地图袋子）', async () => {
    await seedProfile();
    await seedPlayer('Alpha');
    await setTravelDestination('Charlie');

    await createStateManager(SAVE_ID).syncMapJourney();

    expect((await getProfile(SAVE_ID)).worldFlags.map).toBeUndefined();
  });

  it('同步过程中顺带自愈（换包后第一次胶水就把旧派生态清掉）', async () => {
    installMapPack(buildPack('hash-v2'));
    await seedProfile({
      packStamp: 'hash-v1-old',
      lastTileId: 4,
      weatherStamp: { day: 9, zoneId: 'x' },
    });
    await seedPlayer('Alpha');
    await setTravelDestination('');

    await createStateManager(SAVE_ID).syncMapJourney();

    expect(await readFlags()).toEqual({ packStamp: 'hash-v2', lastTileId: 1 });
  });
});
