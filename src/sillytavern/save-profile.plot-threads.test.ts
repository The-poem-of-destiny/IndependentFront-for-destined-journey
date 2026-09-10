/**
 * save-profile.plot-threads.test.ts — 主线细化层成功回合收口的写入口契约（2026-09-09）
 *
 * 钉的是与 `persistFocusQuest` 同一族的两条铁律（提交级缓存落地后暴露 + P1-09 修法）：
 * ① 进 `withSaveWriteLock` —— 与 `commitChatState` 的读-改-写串行，不被出口那次整档 flush 盖掉；
 * ② **锁内重读新鲜 profile** —— 拿管线侧手里那份陈旧整档写回去，会把提交刚落的
 *    fp/变量/地图状态抹回旧值；锁解决交错，解决不了陈旧。
 *
 * 外加收口本身的幂等契约：同回合重复提交 no-op（不重复推进冷却 / 不改时间戳）。
 * 夹具与 save-profile.ui-writes.test.ts 同款（Map 假库 + 真 state-write-queue）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SaveProfile } from './types';
import { createDefaultTime } from './time-system';

// ---- 假库（Map 存储；结构化克隆模拟 Dexie 的进出都是副本）----

const mockGetSaveProfile = vi.fn();
const mockSaveSaveProfile = vi.fn();
const mockCreateDefaultSaveProfile = vi.fn();

vi.mock('./database', () => ({
  getSaveProfile: (...args: any[]) => mockGetSaveProfile(...args),
  saveSaveProfile: (...args: any[]) => mockSaveSaveProfile(...args),
  createDefaultSaveProfile: (...args: any[]) => mockCreateDefaultSaveProfile(...args),
}));

import { commitPlotThreadTurn, getPlotThreadFlags } from './save-profile';
import { withSaveWriteLock } from './state-write-queue';

/** 假库本体 */
let rows: Map<string, SaveProfile>;

function makeProfile(saveId: string, overrides: Partial<SaveProfile> = {}): SaveProfile {
  return {
    saveId,
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: createDefaultTime(),
    variables: {},
    worldFlags: {},
    updatedAt: 1,
    ...overrides,
  };
}

/** 模拟 `commitChatState` 出口那一次整档 flush（读的是它进锁时那份，与收口的写无关） */
function commitFlush(saveId: string, mutate: (p: SaveProfile) => void): void {
  const staleWholeProfile = structuredClone(rows.get(saveId)!);
  mutate(staleWholeProfile);
  rows.set(saveId, staleWholeProfile);
}

/** 让排在微任务队列里的东西跑完（用来断言「此刻还没写」） */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  mockGetSaveProfile.mockImplementation(async (saveId: string) => {
    const row = rows.get(saveId);
    return row === undefined ? undefined : structuredClone(row);
  });
  mockSaveSaveProfile.mockImplementation(async (p: SaveProfile) => {
    rows.set(p.saveId, structuredClone(p));
  });
  mockCreateDefaultSaveProfile.mockImplementation((saveId: string) => makeProfile(saveId));
});

describe('commitPlotThreadTurn —— 锁内窄字段读-改-写 + 幂等', () => {
  it('🔴 写排在提交之后，且提交期间的整档 flush 与细化收口互不吞噬', async () => {
    const saveId = 'save_threads';
    rows.set(saveId, makeProfile(saveId, { fp: 1 }));

    // ① 有人（= commitChatState 那一段）占着这个存档的写锁
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const commitSection = withSaveWriteLock(saveId, () => held);

    // ② 成功回合收口此刻发起（管线已完成、post 已暂存）
    const commit = commitPlotThreadTurn(saveId, {
      turnNo: 7,
      declarations: [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: ['N'],
          status: 'active' as const,
        },
      ],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 1000,
    });
    await settleMicrotasks();
    expect(mockSaveSaveProfile, '收口必须排队，不能插进提交的读-改-写中间').not.toHaveBeenCalled();

    // ③ 提交在锁里落它那份整档（fp 涨了；plotThreads 此时还没写入 — 是空档）
    commitFlush(saveId, (p) => {
      p.fp = 42;
      p.variables['user.gold'] = 100;
    });
    release();
    await commitSection;
    const result = await commit;

    expect(result.committed).toBe(true);
    // ④ 收口写进去的节点在，**且提交刚落的 fp/变量一格没丢**（锁内重读，不是写陈旧整档）
    const finalProfile = rows.get(saveId)!;
    expect(finalProfile.fp).toBe(42);
    expect(finalProfile.variables['user.gold']).toBe(100);
    expect(getPlotThreadFlags(finalProfile).nodes['A'].seededAt).toBe(1000);
    expect(getPlotThreadFlags(finalProfile).lastAdvancedTurn).toBe(7);
    expect(getPlotThreadFlags(finalProfile).lastCommittedTurn).toBe(7);
  });

  it('同回合重复提交 no-op：冷却与时间戳不推进', async () => {
    const saveId = 'save_idem';
    rows.set(saveId, makeProfile(saveId));
    const batch = {
      turnNo: 7,
      declarations: [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active' as const,
        },
      ],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 1000,
    };
    const first = await commitPlotThreadTurn(saveId, batch);
    expect(first.committed).toBe(true);
    // 模拟 advanceTurn 后同轮重交（失败重试的保护：第二次进来时 lastCommittedTurn 已 = 7）
    const second = await commitPlotThreadTurn(saveId, batch);
    expect(second.committed).toBe(false);
    const flags = getPlotThreadFlags(rows.get(saveId)!);
    expect(flags.lastCommittedTurn).toBe(7);
    expect(flags.lastAdvancedTurn).toBe(7);
  });

  it('post 有正文证据的结算不受闸门约束：空声明 + 结算也能落库（收口语义）', async () => {
    const saveId = 'save_settle';
    rows.set(saveId, makeProfile(saveId));
    const r1 = await commitPlotThreadTurn(saveId, {
      turnNo: 3,
      declarations: [
        {
          name: 'A',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active' as const,
        },
      ],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 100,
    });
    expect(r1.committed).toBe(true);
    // 下一轮（闸门可能未放行声明）仍可通过收口结算已有节点
    const r2 = await commitPlotThreadTurn(saveId, {
      turnNo: 4,
      declarations: [],
      updates: [{ name: 'A', status: 'resolved', payoffs: [] }],
      revealedNames: ['A'],
      seededAtEpochMinutes: 200,
    });
    expect(r2.committed).toBe(true);
    const flags = getPlotThreadFlags(rows.get(saveId)!);
    expect(flags.nodes['A'].status).toBe('resolved');
    expect(flags.nodes['A'].resolvedAt).toBe(200);
    expect(flags.nodes['A'].visibility).toBe('revealed');
  });

  it('失败放弃的回合（根本没 commit）不消费冷却：worldFlags 不出 节点袋', async () => {
    const saveId = 'save_abort';
    rows.set(saveId, makeProfile(saveId));
    // 取消/失败路径 = 不调用 write entry；这里断言「不调用时库里没有该袋」
    const profile = rows.get(saveId)!;
    expect(profile.worldFlags['plotThreads']).toBeUndefined();
  });
});
