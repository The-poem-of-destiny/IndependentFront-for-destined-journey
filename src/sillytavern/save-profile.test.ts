/**
 * save-profile.ts — 存档档案管理测试 (Phase 4.6)
 *
 * 覆盖所有导出函数: getProfile / updateProfile / getFP / addFP / spendFP /
 * canAffordFP / addContract / getContracts / getContractByTarget /
 * addAchievement / addNews / markNewsRead
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SaveProfile, FPTransaction, FateContract, Achievement, NewsItem } from './types';

// ---- Mocks ----
const mockGetSaveProfile = vi.fn();
const mockSaveSaveProfile = vi.fn();
const mockCreateDefaultSaveProfile = vi.fn();

vi.mock('./database', () => ({
  getSaveProfile: (...args: any[]) => mockGetSaveProfile(...args),
  saveSaveProfile: (...args: any[]) => mockSaveSaveProfile(...args),
  createDefaultSaveProfile: (...args: any[]) => mockCreateDefaultSaveProfile(...args),
}));

import {
  getProfile,
  updateProfile,
  getFP,
  addFP,
  spendFP,
  canAffordFP,
  addContract,
  getContracts,
  getContractByTarget,
  addAchievement,
  addNews,
  markNewsRead,
} from './save-profile';

// ---- Helpers ----

function makeProfile(overrides: Partial<SaveProfile> = {}): SaveProfile {
  return {
    saveId: 'save_test',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    worldFlags: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeDefaultProfile(saveId: string): SaveProfile {
  return {
    saveId,
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    worldFlags: {},
    updatedAt: Date.now(),
  };
}

// ---- getProfile ----

describe('getProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing profile when found in database', async () => {
    const existing = makeProfile({ saveId: 'save_1', fp: 100 });
    mockGetSaveProfile.mockResolvedValue(existing);

    const result = await getProfile('save_1');

    expect(result).toBe(existing);
    expect(mockGetSaveProfile).toHaveBeenCalledWith('save_1');
    expect(mockCreateDefaultSaveProfile).not.toHaveBeenCalled();
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('creates and saves default profile when none exists', async () => {
    mockGetSaveProfile.mockResolvedValue(undefined);
    const created = makeDefaultProfile('save_2');
    mockCreateDefaultSaveProfile.mockReturnValue(created);
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await getProfile('save_2');

    expect(result).toBe(created);
    expect(mockGetSaveProfile).toHaveBeenCalledWith('save_2');
    expect(mockCreateDefaultSaveProfile).toHaveBeenCalledWith('save_2');
    expect(mockSaveSaveProfile).toHaveBeenCalledWith(created);
  });

  it('saves the newly created default profile before returning', async () => {
    mockGetSaveProfile.mockResolvedValue(undefined);
    const created = makeDefaultProfile('save_3');
    mockCreateDefaultSaveProfile.mockReturnValue(created);
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await getProfile('save_3');

    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
    expect(mockSaveSaveProfile).toHaveBeenCalledWith(created);
  });
});

// ---- updateProfile ----

describe('updateProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls saveSaveProfile with the given profile', async () => {
    const profile = makeProfile({ fp: 50 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await updateProfile(profile);

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

// ---- getFP ----

describe('getFP', () => {
  it('returns the fp value from profile', () => {
    const profile = makeProfile({ fp: 250 });
    expect(getFP(profile)).toBe(250);
  });

  it('returns 0 when profile has no fp', () => {
    const profile = makeProfile({ fp: 0 });
    expect(getFP(profile)).toBe(0);
  });

  it('returns the exact fp value from a profile with history', () => {
    const profile = makeProfile({
      fp: 75,
      fpHistory: [
        { id: 'tx1', timestamp: 1, amount: 100, reason: '初始', balance: 100, source: 'other' },
        { id: 'tx2', timestamp: 2, amount: -25, reason: '消费', balance: 75, source: 'craft' },
      ],
    });
    expect(getFP(profile)).toBe(75);
  });
});

// ---- addFP ----

describe('addFP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increases fp by the given amount', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addFP(profile, 50, '任务奖励', 'task');

    expect(result.fp).toBe(150);
  });

  it('logs a transaction with positive amount', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addFP(profile, 50, '任务奖励', 'task');

    expect(result.fpHistory).toHaveLength(1);
    const tx = result.fpHistory[0];
    expect(tx.amount).toBe(50);
    expect(tx.reason).toBe('任务奖励');
    expect(tx.balance).toBe(150);
    expect(tx.source).toBe('task');
    expect(tx.id).toBeTruthy();
    expect(tx.timestamp).toBeGreaterThan(0);
  });

  it('calls updateProfile (via saveSaveProfile) after adding fp', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await addFP(profile, 50, '奖励');

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });

  it('returns profile unchanged when amount is negative (no-op)', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addFP(profile, -50, '负数测试');

    expect(result.fp).toBe(100);
    expect(result.fpHistory).toHaveLength(0);
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('returns profile unchanged when amount is zero (no-op)', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addFP(profile, 0, '零测试');

    expect(result.fp).toBe(100);
    expect(result.fpHistory).toHaveLength(0);
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('defaults source to "other" when not specified', async () => {
    const profile = makeProfile({ fp: 50 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addFP(profile, 10, '默认来源');

    expect(result.fpHistory[0].source).toBe('other');
  });
});

// ---- spendFP ----

describe('spendFP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deducts fp and logs a negative-amount transaction', async () => {
    const profile = makeProfile({ fp: 200 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await spendFP(profile, 80, '制作消耗', 'craft');

    expect(result.fp).toBe(120);
    expect(result.fpHistory).toHaveLength(1);
    const tx = result.fpHistory[0];
    expect(tx.amount).toBe(-80);
    expect(tx.reason).toBe('制作消耗');
    expect(tx.balance).toBe(120);
    expect(tx.source).toBe('craft');
  });

  it('throws an error when insufficient fp', async () => {
    const profile = makeProfile({ fp: 30 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await expect(spendFP(profile, 50, '超支'))
      .rejects.toThrow('FP 不足: 需要 50, 当前 30');

    expect(profile.fp).toBe(30); // unchanged
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('allows spending exact remaining balance', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await spendFP(profile, 100, '全部消耗');

    expect(result.fp).toBe(0);
    expect(result.fpHistory[0].amount).toBe(-100);
    expect(result.fpHistory[0].balance).toBe(0);
  });

  it('returns profile unchanged when amount is negative (no-op)', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await spendFP(profile, -20, '负数扣减');

    expect(result.fp).toBe(100);
    expect(result.fpHistory).toHaveLength(0);
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('returns profile unchanged when amount is zero (no-op)', async () => {
    const profile = makeProfile({ fp: 100 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await spendFP(profile, 0, '零扣减');

    expect(result.fp).toBe(100);
    expect(result.fpHistory).toHaveLength(0);
    expect(mockSaveSaveProfile).not.toHaveBeenCalled();
  });

  it('calls updateProfile after successful deduction', async () => {
    const profile = makeProfile({ fp: 150 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await spendFP(profile, 30, '消费');

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

// ---- canAffordFP ----

describe('canAffordFP', () => {
  it('returns true when profile has enough fp', () => {
    const profile = makeProfile({ fp: 100 });
    expect(canAffordFP(profile, 50)).toBe(true);
  });

  it('returns false when profile has insufficient fp', () => {
    const profile = makeProfile({ fp: 20 });
    expect(canAffordFP(profile, 50)).toBe(false);
  });

  it('returns true when fp equals the exact amount', () => {
    const profile = makeProfile({ fp: 100 });
    expect(canAffordFP(profile, 100)).toBe(true);
  });

  it('returns true when fp exceeds amount by a large margin', () => {
    const profile = makeProfile({ fp: 9999 });
    expect(canAffordFP(profile, 1)).toBe(true);
  });

  it('returns false when fp is 0', () => {
    const profile = makeProfile({ fp: 0 });
    expect(canAffordFP(profile, 1)).toBe(false);
  });
});

// ---- Contracts ----

describe('addContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a contract with auto-generated id and createdAt timestamp', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addContract(profile, {
      targetId: 'char_1',
      targetName: '艾莉丝',
      tier: 3,
      fpSpent: 100,
      affectionLevel: '信任',
    });

    expect(result.contracts).toHaveLength(1);
    const c = result.contracts[0];
    expect(c.id).toBeTruthy();
    expect(c.createdAt).toBeGreaterThan(0);
    expect(c.targetId).toBe('char_1');
    expect(c.targetName).toBe('艾莉丝');
    expect(c.tier).toBe(3);
    expect(c.fpSpent).toBe(100);
    expect(c.affectionLevel).toBe('信任');
  });

  it('appends to existing contracts without overwriting', async () => {
    const existingContract: FateContract = {
      id: 'existing_contract',
      targetId: 'char_0',
      targetName: '旧角色',
      tier: 1,
      fpSpent: 50,
      affectionLevel: '陌生',
      createdAt: 1000,
    };
    const profile = makeProfile({ contracts: [existingContract] });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addContract(profile, {
      targetId: 'char_2',
      targetName: '新角色',
      tier: 2,
      fpSpent: 75,
      affectionLevel: '友好',
    });

    expect(result.contracts).toHaveLength(2);
    expect(result.contracts[0]).toBe(existingContract);
    expect(result.contracts[1].targetId).toBe('char_2');
  });

  it('calls updateProfile after adding contract', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await addContract(profile, {
      targetId: 'char_3',
      targetName: '测试',
      tier: 1,
      fpSpent: 10,
      affectionLevel: '初次见面',
    });

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

describe('getContracts', () => {
  it('returns all contracts from profile', () => {
    const contracts: FateContract[] = [
      { id: 'c1', targetId: 't1', targetName: '角色A', tier: 2, fpSpent: 40, affectionLevel: '友好', createdAt: 1000 },
      { id: 'c2', targetId: 't2', targetName: '角色B', tier: 3, fpSpent: 120, affectionLevel: '信赖', createdAt: 2000 },
    ];
    const profile = makeProfile({ contracts });

    expect(getContracts(profile)).toBe(contracts);
    expect(getContracts(profile)).toHaveLength(2);
  });

  it('returns empty array when no contracts exist', () => {
    const profile = makeProfile();
    expect(getContracts(profile)).toEqual([]);
  });
});

describe('getContractByTarget', () => {
  const contracts: FateContract[] = [
    { id: 'c1', targetId: 'char_alice', targetName: '艾莉丝', tier: 3, fpSpent: 100, affectionLevel: '信赖', createdAt: 1000 },
    { id: 'c2', targetId: 'char_bob', targetName: '鲍勃', tier: 1, fpSpent: 30, affectionLevel: '陌生', createdAt: 2000 },
  ];

  it('returns the contract matching the targetId', () => {
    const profile = makeProfile({ contracts });
    const result = getContractByTarget(profile, 'char_alice');
    expect(result).toBe(contracts[0]);
  });

  it('returns undefined when no contract matches targetId', () => {
    const profile = makeProfile({ contracts });
    const result = getContractByTarget(profile, 'char_nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns undefined when contracts array is empty', () => {
    const profile = makeProfile();
    const result = getContractByTarget(profile, 'char_any');
    expect(result).toBeUndefined();
  });
});

// ---- Achievements ----

describe('addAchievement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an achievement with auto-generated id and unlockedAt timestamp', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addAchievement(profile, {
      name: '初次邂逅',
      description: '签订第一份命运契约',
      fpReward: 5,
    });

    expect(result.achievements).toHaveLength(1);
    const a = result.achievements[0];
    expect(a.id).toBeTruthy();
    expect(a.unlockedAt).toBeGreaterThan(0);
    expect(a.name).toBe('初次邂逅');
    expect(a.description).toBe('签订第一份命运契约');
    expect(a.fpReward).toBe(5);
  });

  it('appends to existing achievements', async () => {
    const existingAch: Achievement = {
      id: 'ach_old',
      name: '旧成就',
      description: '早就解锁了',
      unlockedAt: 500,
      fpReward: 10,
    };
    const profile = makeProfile({ achievements: [existingAch] });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addAchievement(profile, {
      name: '新成就',
      description: '刚刚解锁',
      fpReward: 20,
    });

    expect(result.achievements).toHaveLength(2);
    expect(result.achievements[0]).toBe(existingAch);
    expect(result.achievements[1].name).toBe('新成就');
  });

  it('calls updateProfile after adding achievement', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await addAchievement(profile, {
      name: '测试成就',
      description: '测试描述',
      fpReward: 1,
    });

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

// ---- News ----

describe('addNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a news item with read=false and auto-generated id and publishedAt', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addNews(profile, {
      title: '王都日报',
      content: '今日王都发生了一件大事...',
      category: 'world',
    });

    expect(result.news).toHaveLength(1);
    const n = result.news[0];
    expect(n.id).toBeTruthy();
    expect(n.publishedAt).toBeGreaterThan(0);
    expect(n.read).toBe(false);
    expect(n.title).toBe('王都日报');
    expect(n.content).toBe('今日王都发生了一件大事...');
    expect(n.category).toBe('world');
  });

  it('appends to existing news items', async () => {
    const existingNews: NewsItem = {
      id: 'news_old',
      title: '旧新闻',
      content: '旧内容',
      category: 'local',
      publishedAt: 500,
      read: true,
    };
    const profile = makeProfile({ news: [existingNews] });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await addNews(profile, {
      title: '新新闻',
      content: '新内容',
      category: 'world',
    });

    expect(result.news).toHaveLength(2);
    expect(result.news[0]).toBe(existingNews);
    expect(result.news[1].read).toBe(false);
  });

  it('calls updateProfile after adding news', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await addNews(profile, {
      title: '测试新闻',
      content: '测试',
      category: 'system',
    });

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

describe('markNewsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets read=true on the matching news item', async () => {
    const news: NewsItem[] = [
      { id: 'n1', title: '标题1', content: '内容1', category: 'world', publishedAt: 100, read: false },
      { id: 'n2', title: '标题2', content: '内容2', category: 'local', publishedAt: 200, read: false },
    ];
    const profile = makeProfile({ news });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await markNewsRead(profile, 'n1');

    expect(result.news[0].read).toBe(true);
    expect(result.news[1].read).toBe(false); // other item unchanged
  });

  it('does nothing when newsId is not found (no-op)', async () => {
    const news: NewsItem[] = [
      { id: 'n1', title: '标题1', content: '内容1', category: 'world', publishedAt: 100, read: false },
    ];
    const profile = makeProfile({ news });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await markNewsRead(profile, 'nonexistent_id');

    expect(result.news[0].read).toBe(false); // still false
    expect(result.news).toBe(news); // same array reference
  });

  it('does not change read status if already true', async () => {
    const news: NewsItem[] = [
      { id: 'n1', title: '已读新闻', content: '内容', category: 'system', publishedAt: 100, read: true },
    ];
    const profile = makeProfile({ news });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const result = await markNewsRead(profile, 'n1');

    expect(result.news[0].read).toBe(true);
  });

  it('calls updateProfile even when newsId not found', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await markNewsRead(profile, 'no_such_news');

    expect(mockSaveSaveProfile).toHaveBeenCalledWith(profile);
    expect(mockSaveSaveProfile).toHaveBeenCalledTimes(1);
  });
});

// ---- Integration-like: multiple operations on same profile ----

describe('chained operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('addFP then spendFP produces consistent history', async () => {
    const profile = makeProfile({ fp: 0 });
    mockSaveSaveProfile.mockResolvedValue(undefined);

    await addFP(profile, 200, '初始资金', 'achievement');
    await addFP(profile, 50, '签到奖励', 'task');
    await spendFP(profile, 100, '购买道具', 'craft');

    expect(profile.fp).toBe(150);
    expect(profile.fpHistory).toHaveLength(3);
    expect(profile.fpHistory[0].balance).toBe(200);
    expect(profile.fpHistory[1].balance).toBe(250);
    expect(profile.fpHistory[2].balance).toBe(150);
  });

  it('addContract then getContractByTarget finds the newly added contract', async () => {
    const profile = makeProfile();
    mockSaveSaveProfile.mockResolvedValue(undefined);

    const updated = await addContract(profile, {
      targetId: 'char_test',
      targetName: '测试角色',
      tier: 2,
      fpSpent: 50,
      affectionLevel: '友好',
    });

    const found = getContractByTarget(updated, 'char_test');
    expect(found).toBeDefined();
    expect(found!.targetName).toBe('测试角色');
    expect(found!.tier).toBe(2);

    const notFound = getContractByTarget(updated, 'other');
    expect(notFound).toBeUndefined();
  });
});
