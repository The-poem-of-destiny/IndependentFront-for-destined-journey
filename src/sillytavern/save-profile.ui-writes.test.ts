/**
 * save-profile.ts — P1-09 UI 辅助字段写入口的**并发**契约（2026-08-17 评审修）
 *
 * 钉的是提交级缓存（`CommitScope`）落地后暴露出来的那条竞态：
 * `commitChatState` 现在把 profile 的读收进作用域、把写收到出口的一次整档 flush，
 * 于是「UI 直写一份整档」这个老做法有了两种败法，**两种都不报错**：
 *
 *   ① 不进写队列 → UI 的写落在提交的读与写之间，被出口那次整档 flush 直接盖掉
 *      （缓存之前每个补丁各自重读一次库，把 UI 的写顺带吸收了 —— 那是巧合不是设计）。
 *   ② 只加锁、仍写 UI 手里那份陈旧整档 → 反过来把提交刚落的 fp / 任务 / 新闻抹回旧值。
 *
 * 所以本文件的两条主用例都**同时**验两个方向：锁段里发生一次整档 flush 之后，
 * UI 那一格改成功了 **且** flush 写进去的其余字段一格没丢。
 *
 * 夹具用 Map 假库（`./database` 被 mock）+ **真的** `state-write-queue` ——
 * 队列正是被测对象，mock 掉它这两条用例会双双恒绿。
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

import {
  persistFocusQuest,
  persistNewsRead,
  persistQuestStatus,
  persistRemoveQuest,
} from './save-profile';
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
    news: [
      {
        id: 'n1',
        title: '边境异动',
        content: '正文',
        category: 'world',
        publishedAt: 1,
        read: false,
      },
    ],
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

/** 模拟 `commitChatState` 出口那一次整档 flush（读的是它进锁时那份，与 UI 的写无关） */
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

describe('persistFocusQuest —— 锁内窄字段读-改-写', () => {
  it('🔴 写排在提交之后，且提交期间的整档 flush 与 UI 的写互不吞噬', async () => {
    const saveId = 'save_focus';
    rows.set(saveId, makeProfile(saveId));

    // ① 有人（= commitChatState 那一段）占着这个存档的写锁
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const commitSection = withSaveWriteLock(saveId, () => held);

    // ② 玩家此刻在任务面板选了焦点任务
    const uiWrite = persistFocusQuest(saveId, '找回项链');
    await settleMicrotasks();
    expect(
      mockSaveSaveProfile,
      'UI 的写必须排队，不能插进提交的读-改-写中间',
    ).not.toHaveBeenCalled();

    // ③ 提交在锁里落它那份整档（fp 涨了、还多了一条新闻；focusQuest 仍是进锁时的空串）
    commitFlush(saveId, (p) => {
      p.fp = 999;
      p.news.push({
        id: 'n2',
        title: '战报',
        content: '正文',
        category: 'world',
        publishedAt: 2,
        read: false,
      });
    });

    release();
    await commitSection;
    await uiWrite;

    const stored = rows.get(saveId)!;
    // UI 那一格改上了 —— 不进队列的话它会被 ③ 的整档 flush 盖掉
    expect(stored.focusQuest).toBe('找回项链');
    // 提交写进去的其余字段一格没丢 —— 拿 UI 手里那份陈旧整档写回去的话，这两条会被抹回旧值
    expect(stored.fp).toBe(999);
    expect(stored.news.map((n) => n.id)).toEqual(['n1', 'n2']);
    // 锁内确实重读过一次（先读后写，且读发生在 flush 之后）
    expect(mockGetSaveProfile).toHaveBeenCalledWith(saveId);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });

  it('连续两次选择按 FIFO 落库，后一次胜出', async () => {
    const saveId = 'save_focus_seq';
    rows.set(saveId, makeProfile(saveId));

    await Promise.all([persistFocusQuest(saveId, '任务甲'), persistFocusQuest(saveId, '任务乙')]);

    expect(rows.get(saveId)!.focusQuest).toBe('任务乙');
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(2);
  });
});

describe('persistNewsRead —— 锁内窄字段读-改-写', () => {
  it('🔴 只翻中选那一条的 read；提交期间新增的新闻与 FP 都留着', async () => {
    const saveId = 'save_news';
    rows.set(saveId, makeProfile(saveId));

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const commitSection = withSaveWriteLock(saveId, () => held);

    const uiWrite = persistNewsRead(saveId, 'n1');
    await settleMicrotasks();
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();

    commitFlush(saveId, (p) => {
      p.fp = 42;
      p.news.push({
        id: 'n3',
        title: '新到的消息',
        content: '正文',
        category: 'world',
        publishedAt: 3,
        read: false,
      });
    });

    release();
    await commitSection;
    await uiWrite;

    const stored = rows.get(saveId)!;
    expect(stored.news.find((n) => n.id === 'n1')!.read).toBe(true);
    // 提交期间新到的那条**仍是未读**（窄改只碰 n1，不整份覆盖）
    expect(stored.news.find((n) => n.id === 'n3')!.read).toBe(false);
    expect(stored.fp).toBe(42);
  });

  it('库里没有这个 newsId（快照回退撤掉了）时静默不改，不抛', async () => {
    const saveId = 'save_news_missing';
    rows.set(saveId, makeProfile(saveId));

    await expect(persistNewsRead(saveId, '不存在的新闻')).resolves.toBeUndefined();
    expect(rows.get(saveId)!.news.every((n) => !n.read)).toBe(true);
  });
});

describe('persistQuestStatus / persistRemoveQuest —— 锁内窄字段读-改-写', () => {
  /** 测试任务的最小形状 */
  function makeQuest(status: string, priority: '低' | '中' | '高') {
    return { status, priority, progress: '', detail: '', objective: '', reward: '' };
  }

  it('persistQuestStatus 只翻那一个任务的 status；提交期间的整档 flush 互不吞噬', async () => {
    const saveId = 'save_quest_status';
    rows.set(
      saveId,
      makeProfile(saveId, {
        quests: { 找回项链: makeQuest('进行中', '高') },
      }),
    );

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const commitSection = withSaveWriteLock(saveId, () => held);

    // 玩家此刻在任务面板点「标记完成」
    const uiWrite = persistQuestStatus(saveId, '找回项链', '已完成');
    await settleMicrotasks();
    expect(
      mockSaveSaveProfile,
      'UI 的写必须排队，不能插进提交的读-改-写中间',
    ).not.toHaveBeenCalled();

    // 提交在锁里落它那份整档（fp 涨了、还多开了一个任务；找回项链仍是进锁时的「进行中」）
    commitFlush(saveId, (p) => {
      p.fp = 123;
      p.quests['另一任务'] = makeQuest('进行中', '中');
    });

    release();
    await commitSection;
    await uiWrite;

    const stored = rows.get(saveId)!;
    // UI 那一格改上了 —— 不进队列的话它会被 commitFlush 的整档盖掉
    expect(stored.quests['找回项链'].status).toBe('已完成');
    // 提交写进去的其余字段一格没丢 —— 拿 UI 手里那份陈旧整档写回去的话会被抹回旧值
    expect(stored.fp).toBe(123);
    expect(stored.quests['另一任务']).toBeDefined();
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });

  it('persistRemoveQuest 只删那一个任务键；提交期间的整档 flush 互不吞噬', async () => {
    const saveId = 'save_quest_remove';
    rows.set(
      saveId,
      makeProfile(saveId, {
        quests: {
          讨伐魔物: makeQuest('已完成', '中'),
          继续赶路: makeQuest('进行中', '高'),
        },
      }),
    );

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const commitSection = withSaveWriteLock(saveId, () => held);

    const uiWrite = persistRemoveQuest(saveId, '讨伐魔物');
    await settleMicrotasks();
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();

    commitFlush(saveId, (p) => {
      p.fp = 456;
      p.quests['又一任务'] = makeQuest('进行中', '低');
    });

    release();
    await commitSection;
    await uiWrite;

    const stored = rows.get(saveId)!;
    expect(stored.quests['讨伐魔物']).toBeUndefined();
    // 提交期间新增的任务与 fp 都留着
    expect(stored.quests['又一任务']).toBeDefined();
    expect(stored.quests['继续赶路']).toBeDefined();
    expect(stored.fp).toBe(456);
  });

  it('两者对不存在的任务都静默跳过，不抛', async () => {
    const saveId = 'save_quest_missing';
    rows.set(saveId, makeProfile(saveId));

    await expect(persistQuestStatus(saveId, '不存在的任务', '已完成')).resolves.toBeUndefined();
    await expect(persistRemoveQuest(saveId, '不存在的任务')).resolves.toBeUndefined();
    expect(Object.keys(rows.get(saveId)!.quests)).toEqual([]);
  });
});
