/**
 * state-manager.random-events.test.ts — 随机事件接线的**链路**测试
 * （随机事件系统 v1 / 设计 §4·§5.2·§6）
 *
 * 为什么是链路测试而不是纯函数测试：调度器本身在 `random-event-scheduler.test.ts` 里已经
 * 逐条测过了。这个文件要钉的是**另一类错**——「算得对但没人调用」「算完了没人落库」
 * 「设置读了但没往下传」。所以一律从**真入口**出发（`applyTimeAdvance` /
 * `commitChatState(set_location)` / `confirmRandomEventTrigger`），落到**真 Dexie**
 * （fake-indexeddb）里的 `SaveProfile.worldFlags.randomEvents` 上回读
 * （harness 照 `state-manager.map-wiring.test.ts`，理由同那份文件头）。
 *
 * 覆盖（每条都对应一种「不报错的错」）:
 * - 跨天推进 → 逐天掷骰入池并落库；**同存档同天重放同结果**（铁则 3 种子化）
 * - 首次 ensure **不补历史**（玩到第 300 天才装包的存档不该被 300 天的骰子砸中）
 * - `randomEventsEnabled: false` → flags **一个字节都不动**（关掉不等于清空，§6）
 * - `randomEventsFrequency` 真的乘进了权重（频率读了却没往下传是纯函数测不出来的）
 * - 没装事件包 → 整条链 no-op（随机事件是**可选**子系统）
 * - 钩子抛错 → `applyTimeAdvance` 照常成功（候选池是旁路账本，§4 钩子形状 ④）
 * - 首访：点名地点强制入池 → 离开即撤 → 回来再入池 → **触发之后**才记足迹（§4.2）
 * - 地点键取**地块名**而不是位置路径末段（换图后足迹要存活，§4.2）
 * - NPC 换位置 → 一个字节都不写（player only，同地图落位钩子）
 * - 结算：清全部非 forced / forced 留在池里 / 记档案 / 起全局冷却 / emit `random_event`
 * - 结算的两条 warn-noop：名字不在池中（AI 幻觉不奖励）、系统关闭
 * - 调试入池（`devForceArmRandomEvent`）：绕过硬门槛与权重、免疫池满与保洁、名字认不出就 no-op
 *
 * 🔴 夹具零真实地名与零真实事件名（承 D25①）：事件定义是**内容包数据**，
 *    夹具里写真名会让人误以为引擎认识它们。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAllData, getCharacters, initializeDatabase, saveCharacter } from './database';
import { getProfile, getRandomEventFlags, updateProfile } from './save-profile';
import { createStateManager } from './state-manager';
import { setEngineSettingsProvider } from './engine-settings';
import {
  getRandomEventPack,
  installRandomEventPack,
  resetRandomEventRuntime,
} from './random-event-runtime';
import { buildRandomEventOffer } from './random-event-context';
import { buildRandomEventRollContext } from './random-event-snapshot';
import { installMapPack, resetMapRuntime } from './map-runtime';
import type { RandomEventPack } from './random-event-pack';
import { DEFAULT_RANDOM_EVENT_CONFIG } from './types-random-events';
import type {
  PendingRandomEvent,
  RandomEventConfig,
  RandomEventDef,
  RandomEventSaveFlags,
} from './types-random-events';
import { createDefaultCharacterState } from './types';
import { createDefaultTime } from './time-system';
import type { MapPack, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

const SAVE_ID = 'save-random-events';

/** 一游戏日；与 state-manager 里那个常量同值（这里独立写一份，好让漂移变红） */
const MINUTES_PER_DAY = 1440;

/** `createDefaultTime()` = 488-01-01 08:00 → 第 0 游戏日 */
const START_DAY = 0;

function buildPack(
  defs: RandomEventDef[],
  config: Partial<RandomEventConfig> = {},
): RandomEventPack {
  return { config: { ...DEFAULT_RANDOM_EVENT_CONFIG, ...config }, defs };
}

/** `mtthDays: 1` → `p = min(1, 1/1) = 1` → `rng.chance(1)` 恒真：掷中与否不参与断言 */
function alwaysDef(name: string, patch: Partial<RandomEventDef> = {}): RandomEventDef {
  return { name, brief: `brief-of-${name}`, trigger: { type: 'mtth', mtthDays: 1 }, ...patch };
}

function firstVisitDef(
  name: string,
  places: string[],
  patch: Partial<RandomEventDef> = {},
): RandomEventDef {
  return {
    name,
    brief: `brief-of-${name}`,
    trigger: { type: 'first_visit', scope: { anyOf: places } },
    ...patch,
  };
}

/** 只有一块地的最小地图包：地块名（Alpha）与绑定名（Alpha Gate）**刻意不同** */
function buildMapPack(): MapPack {
  const tile: MapTile = {
    id: 1,
    name: 'Alpha',
    terrain: 'plains',
    water: null,
    impassable: false,
    countryId: null,
    midTierId: null,
    centroid: [10, 10],
    areaPx: 100,
  };
  return {
    version: '1.0.0',
    contentHash: 'hash-v1',
    resolution: { w: 100, h: 100 },
    kmPerPx: 2,
    terrains: ['plains'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 120 },
      embarkCost: 5,
      terrainFactor: { plains: 1 },
      modes: [],
    },
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [tile],
    adjacency: [],
    straits: [],
    placeBindings: { 'Alpha Gate': 1 },
  };
}

// ═══════════════════════════════════════════════════════════
// 装台
// ═══════════════════════════════════════════════════════════

async function seedPlayer(location: string, level = 3): Promise<void> {
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero-1',
      saveId: SAVE_ID,
      name: 'Hero',
      type: 'player',
      location,
      level,
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
async function seedProfile(flags: RandomEventSaveFlags | null = null): Promise<void> {
  const profile = await getProfile(SAVE_ID);
  profile.gameTime = createDefaultTime();
  if (flags !== null) profile.worldFlags.randomEvents = flags;
  await updateProfile(profile);
}

async function advanceDays(days: number): Promise<void> {
  await createStateManager(SAVE_ID).applyTimeAdvance(days * MINUTES_PER_DAY);
}

async function setLocation(charName: string, value: string): Promise<void> {
  const result = await createStateManager(SAVE_ID).commitChatState([
    { op: 'set_location', target: `characters.${charName}`, value },
  ]);
  expect(result.errors).toEqual([]);
}

async function readFlags(): Promise<RandomEventSaveFlags> {
  return getRandomEventFlags(await getProfile(SAVE_ID));
}

async function readRawFlags(): Promise<unknown> {
  return (await getProfile(SAVE_ID)).worldFlags.randomEvents;
}

async function pendingNames(): Promise<string[]> {
  return ((await readFlags()).pending ?? []).map((entry) => entry.name);
}

async function resetWorld(): Promise<void> {
  try {
    await clearAllData();
  } catch {
    /* 首跑时库还不存在 */
  }
  await initializeDatabase();
}

beforeEach(async () => {
  await resetWorld();
  resetRandomEventRuntime();
  resetMapRuntime();
  setEngineSettingsProvider(undefined);
});

afterEach(() => {
  setEngineSettingsProvider(undefined);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════
// MTTH 掷骰（§4.1）
// ═══════════════════════════════════════════════════════════

describe('掷骰钩子 —— applyTimeAdvance → worldFlags.randomEvents', () => {
  it('跨天推进 → 逐天掷骰，掷中的条目入池并落库', async () => {
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile({ lastRollDay: START_DAY });
    await seedPlayer('Camp');

    await advanceDays(2);

    const flags = await readFlags();
    expect(flags.lastRollDay).toBe(START_DAY + 2);
    expect(flags.pending).toHaveLength(1);
    // 第一个走到的日子就掷中（p=1），且**只入一次**（已在池中的定义后续天数跳过）
    expect(flags.pending?.[0]).toMatchObject({
      name: 'Encounter',
      armedDay: START_DAY + 1,
      expiresDay: START_DAY + 1 + DEFAULT_RANDOM_EVENT_CONFIG.offerTtlDays,
      brief: 'brief-of-Encounter',
    });
  });

  /**
   * 🔴 用一条**真会掷骰**的定义（`p = 1/3`，不是恒中的 `mtthDays: 1`）：恒中的定义两次跑
   *    出来当然一样，那证明不了种子化。这里连「哪一天掷中」都是金值 —— 种子编码一旦被动过
   *    （比如少了长度前缀），`armedDay` 会换一个数字，而两次跑仍然彼此相等。
   */
  it('🔴 同一存档同一天重放 → 同一份候选池（铁则 3：种子化，快照回退可复现）', async () => {
    const run = async (): Promise<RandomEventSaveFlags> => {
      await resetWorld();
      installRandomEventPack(
        buildPack([alwaysDef('Coin', { trigger: { type: 'mtth', mtthDays: 3 } })]),
      );
      await seedProfile({ lastRollDay: START_DAY });
      await seedPlayer('Camp');
      await advanceDays(6);
      return readFlags();
    };

    const first = await run();
    const second = await run();

    // 先证明这不是在比两个空池（否则本用例恒绿）
    expect(first.pending).toHaveLength(1);
    expect(first.pending?.[0]).toMatchObject({ name: 'Coin', armedDay: START_DAY + 5 });
    expect(second).toEqual(first);
  });

  it('🔴 首次 ensure 只置 lastRollDay，不补历史', async () => {
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile(); // 存量存档：一格 randomEvents 都没有
    await seedPlayer('Camp');

    await advanceDays(5);

    const flags = await readFlags();
    expect(flags.lastRollDay).toBe(START_DAY + 5);
    expect(flags.pending).toBeUndefined();
  });

  it('🔴 关闭时不掷骰、不清池（关掉 ≠ 清空，§6），只把 lastRollDay 盖到当天', async () => {
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    const stale: PendingRandomEvent = {
      name: 'Encounter',
      armedDay: START_DAY,
      expiresDay: START_DAY + 99,
      priority: 0,
      brief: 'brief-of-Encounter',
    };
    await seedProfile({
      lastRollDay: START_DAY,
      pending: [stale],
      visited: ['Alpha'],
      fired: { Encounter: { count: 1, lastDay: START_DAY } },
    });
    await seedPlayer('Camp');

    await advanceDays(3);

    const flags = await readFlags();
    // 关闭期间的天数按「跳过不补掷」处理（见下一条用例的理由）
    expect(flags.lastRollDay).toBe(START_DAY + 3);
    // 其余三格是**事实**，一个字节都不许动
    expect(flags.pending).toEqual([stale]);
    expect(flags.visited).toEqual(['Alpha']);
    expect(flags.fired).toEqual({ Encounter: { count: 1, lastDay: START_DAY } });
  });

  /**
   * 🔴 关掉系统 → 过很多天 → 再打开，**不许倒灌**（2026-08-16 审查修复）。
   *
   * 关闭期间掷骰整段 no-op，`lastRollDay` 若停在关掉那天，重新打开后逐天循环会把
   * 这些天一次走完 —— 候选池当场被塞满（`maxPending` 上限内），玩家的第一回合就被
   * 一堆事件砸中。判据取 `armedDay`：它必须落在**重新打开之后**的那几天里。
   */
  it('🔴 关闭 200 天再打开 → 只掷新的那一天，池子不被倒灌', async () => {
    installRandomEventPack(buildPack([alwaysDef('Encounter'), alwaysDef('Rumor')]));
    await seedProfile({ lastRollDay: START_DAY });
    await seedPlayer('Camp');

    // 关着过 200 天
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    await advanceDays(200);
    expect((await readFlags()).pending).toBeUndefined();

    // 重新打开，只过 1 天
    setEngineSettingsProvider(undefined);
    await advanceDays(1);

    const flags = await readFlags();
    expect(flags.lastRollDay).toBe(START_DAY + 201);
    // 先证明这不是在比一个空池（否则本用例恒绿）
    expect((flags.pending ?? []).length).toBeGreaterThan(0);
    for (const entry of flags.pending ?? []) {
      expect(entry.armedDay).toBe(START_DAY + 201);
    }
  });

  it('从没掷过骰的存档：关着时一个字节都不写（不为「关着」也去建一袋 flags）', async () => {
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile();
    await seedPlayer('Camp');

    await advanceDays(5);

    expect(await readRawFlags()).toBeUndefined();
  });

  it('🔴 频率系数 0 → 权重归零，什么都不入池（证明设置真的传到了掷骰里）', async () => {
    setEngineSettingsProvider(() => ({ randomEventsFrequency: 0 }));
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile({ lastRollDay: START_DAY });
    await seedPlayer('Camp');

    await advanceDays(10);

    expect((await readFlags()).pending).toBeUndefined();
  });

  it('没装事件包 → 整条链 no-op（worldFlags.randomEvents 压根不出现）', async () => {
    await seedProfile();
    await seedPlayer('Camp');

    await advanceDays(3);

    expect(await readRawFlags()).toBeUndefined();
  });

  it('🔴 钩子抛错不让 applyTimeAdvance 失败（候选池是旁路账本）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 读第一条定义就抛的坏包：`defs.length` 仍是 1，所以空包判据放行，抛在掷骰循环里
    const defs: RandomEventDef[] = [];
    Object.defineProperty(defs, '0', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    installRandomEventPack(buildPack(defs));

    await seedProfile({ lastRollDay: START_DAY });
    await seedPlayer('Camp');

    await expect(advanceDays(2)).resolves.toBeUndefined();

    // 时间照常推进；随机事件那一袋保持原样
    const profile = await getProfile(SAVE_ID);
    expect(profile.gameTime.day).not.toBe(createDefaultTime().day);
    expect(getRandomEventFlags(profile)).toEqual({ lastRollDay: START_DAY });
    expect(warn).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 首访强制（§4.2）
// ═══════════════════════════════════════════════════════════

describe('首访钩子 —— set_location → forced 条目', () => {
  it('点名地点首访 → forced 入池；离开即撤；回来再入池（足迹还没记）', async () => {
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'], { priority: 9 })]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Alpha');
    const armed = await readFlags();
    expect(armed.pending).toHaveLength(1);
    expect(armed.pending?.[0]).toMatchObject({
      name: 'Arrival',
      forced: true,
      placeKey: 'Alpha',
      priority: 9,
    });
    // 🔴 足迹在**触发时**记账，不在入池时
    expect(armed.visited).toBeUndefined();

    await setLocation('Hero', 'Bravo');
    expect(await pendingNames()).toEqual([]);

    await setLocation('Hero', 'Alpha');
    expect(await pendingNames()).toEqual(['Arrival']);
  });

  it('🔴 触发之后才记足迹，此后再来不重复入池', async () => {
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'])]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Alpha');
    await createStateManager(SAVE_ID).confirmRandomEventTrigger('Arrival');

    const settled = await readFlags();
    expect(settled.visited).toEqual(['Alpha']);
    expect(settled.pending ?? []).toEqual([]);

    await setLocation('Hero', 'Bravo');
    await setLocation('Hero', 'Alpha');
    expect(await pendingNames()).toEqual([]);
  });

  it('🔴 地点键取地块名而不是位置路径末段（换图后足迹要存活）', async () => {
    installMapPack(buildMapPack());
    // scope 写的是**地块名** Alpha；玩家走到的是绑定名 Alpha Gate
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'])]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Alpha Gate');

    expect((await readFlags()).pending?.[0]).toMatchObject({ name: 'Arrival', placeKey: 'Alpha' });
  });

  it('没落位时降级成位置路径最深段（首访语义降级但不失效）', async () => {
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Harbor'])]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Northland-Midlands-Harbor');

    expect((await readFlags()).pending?.[0]).toMatchObject({ placeKey: 'Harbor' });
  });

  it('scope 没命中 → 什么也不做（普通新地点不起事件是有意语义，裁定 §13-3）', async () => {
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'])]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Nowhere');

    expect(await readRawFlags()).toBeUndefined();
  });

  it('🔴 NPC 换位置 → 一个字节都不写（player only，同地图落位钩子）', async () => {
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'])]));
    await seedProfile();
    await seedNpc('Outpost');

    await setLocation('Scout', 'Alpha');

    expect(await readRawFlags()).toBeUndefined();
    // 不跟踪指的是不进候选池，不是不改位置
    const scout = (await getCharacters(SAVE_ID)).find((c) => c.name === 'Scout');
    expect(scout?.location).toBe('Alpha');
  });

  it('关闭时首访也不入池', async () => {
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    installRandomEventPack(buildPack([firstVisitDef('Arrival', ['Alpha'])]));
    await seedProfile();
    await seedPlayer('Outpost');

    await setLocation('Hero', 'Alpha');

    expect(await readRawFlags()).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 触发结算（§5.2）
// ═══════════════════════════════════════════════════════════

describe('confirmRandomEventTrigger —— marker 回执的结算', () => {
  const forcedEntry: PendingRandomEvent = {
    name: 'Arrival',
    armedDay: START_DAY,
    forced: true,
    placeKey: 'Alpha',
    priority: 9,
    brief: 'brief-of-Arrival',
  };
  const normalEntry: PendingRandomEvent = {
    name: 'Encounter',
    armedDay: START_DAY,
    expiresDay: START_DAY + 5,
    priority: 1,
    brief: 'brief-of-Encounter',
  };
  const spareEntry: PendingRandomEvent = { ...normalEntry, name: 'Rumor', priority: 0 };

  async function seedPool(): Promise<void> {
    installRandomEventPack(
      buildPack([alwaysDef('Encounter'), alwaysDef('Rumor'), firstVisitDef('Arrival', ['Alpha'])]),
    );
    await seedProfile({ pending: [forcedEntry, normalEntry, spareEntry] });
    await seedPlayer('Alpha');
  }

  it('触发 → 清全部非 forced、forced 留池、记档案、起全局冷却、emit random_event', async () => {
    await seedPool();
    const sm = createStateManager(SAVE_ID);

    await sm.confirmRandomEventTrigger('Encounter');

    const flags = await readFlags();
    // 一次触发一波：非 forced 全清（含没被触发的 Rumor，裁定 §13-5）
    expect((flags.pending ?? []).map((e) => e.name)).toEqual(['Arrival']);
    expect(flags.fired?.Encounter).toEqual({ count: 1, lastDay: START_DAY });
    expect(flags.lastTriggerDay).toBe(START_DAY);
    // forced 没被触发 → 不记足迹
    expect(flags.visited).toBeUndefined();

    const events = sm.getEvents().filter((e) => e.type === 'random_event');
    expect(events).toHaveLength(1);
    expect(events[0].data.value).toMatchObject({
      name: 'Encounter',
      day: START_DAY,
      forced: false,
    });
  });

  it('🔴 名字不在池中 → warn 忽略（AI 幻觉触发不奖励），flags 一个字节都不动', async () => {
    await seedPool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await readFlags();
    const sm = createStateManager(SAVE_ID);

    await sm.confirmRandomEventTrigger('NeverArmed');

    expect(await readFlags()).toEqual(before);
    expect(sm.getEvents().filter((e) => e.type === 'random_event')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('🔴 系统关闭时收到 marker → warn 忽略', async () => {
    await seedPool();
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await readFlags();

    await createStateManager(SAVE_ID).confirmRandomEventTrigger('Encounter');

    expect(await readFlags()).toEqual(before);
    expect(warn).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 每回合保洁（§4.3）
// ═══════════════════════════════════════════════════════════

describe('syncRandomEventsForTurn —— 每回合的轻量保洁', () => {
  it('过期条目撤下，未过期的留着；lastRollDay 不动（只保洁不掷骰）', async () => {
    installRandomEventPack(buildPack([alwaysDef('Stale'), alwaysDef('Fresh')]));
    await seedProfile({
      lastRollDay: START_DAY,
      pending: [
        {
          name: 'Stale',
          armedDay: START_DAY - 10,
          expiresDay: START_DAY - 1,
          priority: 0,
          brief: 'b',
        },
        { name: 'Fresh', armedDay: START_DAY, expiresDay: START_DAY + 5, priority: 0, brief: 'b' },
      ],
    });
    await seedPlayer('Camp');

    await createStateManager(SAVE_ID).syncRandomEventsForTurn();

    const flags = await readFlags();
    expect((flags.pending ?? []).map((e) => e.name)).toEqual(['Fresh']);
    expect(flags.lastRollDay).toBe(START_DAY);
  });

  it('定义已不存在的条目静默剔除（换包后名字对不上，铁则 4）', async () => {
    installRandomEventPack(buildPack([alwaysDef('Fresh')]));
    await seedProfile({
      pending: [
        { name: 'Ghost', armedDay: START_DAY, expiresDay: START_DAY + 5, priority: 0, brief: 'b' },
        { name: 'Fresh', armedDay: START_DAY, expiresDay: START_DAY + 5, priority: 0, brief: 'b' },
      ],
    });
    await seedPlayer('Camp');

    await createStateManager(SAVE_ID).syncRandomEventsForTurn();

    expect(await pendingNames()).toEqual(['Fresh']);
  });

  it('无变化 → 不写库；关闭 / 空包 → 整段 no-op', async () => {
    await seedProfile();
    await seedPlayer('Camp');

    // 空包
    await createStateManager(SAVE_ID).syncRandomEventsForTurn();
    expect(await readRawFlags()).toBeUndefined();

    // 关闭
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await createStateManager(SAVE_ID).syncRandomEventsForTurn();
    expect(await readRawFlags()).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 调试入池（开发者面板「下回合触发」）
// ═══════════════════════════════════════════════════════════

describe('devForceArmRandomEvent —— 开发者面板专用的强制入池', () => {
  it('按 forced 入池并落库，简报按真实入池那条路固化（槽位采样 + {{place}}）', async () => {
    installRandomEventPack(
      buildPack([
        alwaysDef('Encounter', {
          // `mtthDays` 大到实质掷不中：入池只可能来自这个按钮
          trigger: { type: 'mtth', mtthDays: 1e12 },
          brief: 'a {{goods}} at {{place}}',
          slots: { goods: { pick: ['relic'] } },
        }),
      ]),
    );
    await seedProfile();
    await seedPlayer('Camp');

    const result = await createStateManager(SAVE_ID).devForceArmRandomEvent('Encounter');

    expect(result).toEqual({ ok: true });
    const flags = await readFlags();
    expect(flags.pending).toHaveLength(1);
    expect(flags.pending?.[0]).toMatchObject({
      name: 'Encounter',
      forced: true,
      armedDay: START_DAY,
      brief: 'a relic at Camp',
    });
    // forced 条目不设过期（撤池条件是离开 / available 不再满足，不是时间）
    expect(flags.pending?.[0].expiresDay).toBeUndefined();
  });

  it('🔴 绕过 available 硬门槛与权重 ×0 —— 这就是这个按钮存在的理由', async () => {
    installRandomEventPack(
      buildPack([
        alwaysDef('Blocked', {
          available: { playerLevel: { gte: 99 } },
          weights: [{ when: {}, multiply: 0 }],
        }),
      ]),
    );
    await seedProfile();
    await seedPlayer('Camp', 3);

    expect(await createStateManager(SAVE_ID).devForceArmRandomEvent('Blocked')).toEqual({
      ok: true,
    });
    expect(await pendingNames()).toEqual(['Blocked']);
  });

  it('名字不在事件包里 → warn + 一个字节都不写（换包 / 手滑都走这一条）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile();
    await seedPlayer('Camp');

    const result = await createStateManager(SAVE_ID).devForceArmRandomEvent('Ghost');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    expect(await readRawFlags()).toBeUndefined();
  });

  it('空名字 / 没装包 → 同样 no-op（不建 flags 袋子）', async () => {
    await seedProfile();
    await seedPlayer('Camp');

    expect((await createStateManager(SAVE_ID).devForceArmRandomEvent('   ')).ok).toBe(false);
    expect((await createStateManager(SAVE_ID).devForceArmRandomEvent('Encounter')).ok).toBe(false);
    expect(await readRawFlags()).toBeUndefined();
  });

  it('🔴 池满时也进得去，且随后的保洁不把它撤掉（forced 免疫淘汰与过期）', async () => {
    installRandomEventPack(
      buildPack(
        [
          alwaysDef('Dev', { trigger: { type: 'mtth', mtthDays: 1e12 } }),
          alwaysDef('A'),
          alwaysDef('B'),
        ],
        { maxPending: 2 },
      ),
    );
    await seedProfile({
      pending: [
        { name: 'A', armedDay: START_DAY, expiresDay: START_DAY + 5, priority: 5, brief: 'a' },
        { name: 'B', armedDay: START_DAY, expiresDay: START_DAY + 5, priority: 4, brief: 'b' },
      ],
      lastRollDay: START_DAY,
    });
    await seedPlayer('Camp');

    await createStateManager(SAVE_ID).devForceArmRandomEvent('Dev');
    expect(await pendingNames()).toEqual(['A', 'B', 'Dev']);

    // 每回合保洁跑一遍：forced 条目必须还在（撤掉的话「下回合触发」就是一句空话）
    await createStateManager(SAVE_ID).syncRandomEventsForTurn();
    expect(await pendingNames()).toContain('Dev');
  });

  it('同名条目已在池 → 换成 forced，绝不出现两行同名候选', async () => {
    installRandomEventPack(buildPack([alwaysDef('Encounter')]));
    await seedProfile({
      pending: [
        {
          name: 'Encounter',
          armedDay: START_DAY,
          expiresDay: START_DAY + 5,
          priority: 0,
          brief: 'stale',
        },
      ],
    });
    await seedPlayer('Camp');

    await createStateManager(SAVE_ID).devForceArmRandomEvent('Encounter');

    const flags = await readFlags();
    expect(flags.pending).toHaveLength(1);
    expect(flags.pending?.[0].forced).toBe(true);
  });

  it('入池后进得了注入块，且带 forced 标（下一回合 story 真看得见）', async () => {
    installRandomEventPack(
      buildPack([alwaysDef('Encounter', { trigger: { type: 'mtth', mtthDays: 1e12 } })]),
    );
    await seedProfile();
    await seedPlayer('Camp');

    await createStateManager(SAVE_ID).devForceArmRandomEvent('Encounter');

    const profile = await getProfile(SAVE_ID);
    const offer = buildRandomEventOffer(
      getRandomEventPack().defs,
      getRandomEventPack().config,
      getRandomEventFlags(profile),
      buildRandomEventRollContext(profile, (await getCharacters(SAVE_ID))[0]),
      START_DAY,
    );
    expect(offer.map((e) => [e.name, e.forced])).toEqual([['Encounter', true]]);
  });
});
