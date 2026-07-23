/**
 * database.ts — v4 数据库 CRUD & 迁移测试
 *
 * Uses fake-indexeddb (injected via src/test-setup.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDatabase,
  initializeDatabase,
  clearAllData,
  exportAllData,
  importAllData,
  // Memories
  getMemories,
  getMemoriesByIds,
  saveMemory,
  deleteMemory,
  getRecentMemories,
  // PlotEvents
  getPlotEvents,
  getActivePlotEvents,
  savePlotEvent,
  savePlotEvents,
  deletePlotEvent,
  // Characters
  getCharacters,
  getCharacter,
  saveCharacter,
  saveCharacters,
  deleteCharacter,
  // Snapshots
  getSnapshots,
  getSnapshot,
  getLatestSnapshot,
  saveSnapshot,
  deleteSnapshot,
  trimSnapshots,
  // Saves
  getSaves,
  getSave,
  getSaveBySlot,
  saveSaveSlot,
  deleteSaveSlot,
  // API Endpoints
  getApiEndpoints,
  saveApiEndpoint,
  deleteApiEndpoint,
  // Settings
  getSettings,
  saveSettings,
  // Messages
  saveMessage,
  saveMessages,
  getMessages,
  deleteMessagesBySaveId,
  deleteMessagesAfterTurn,
} from './database';
import type {
  ChatMessage,
  MemoryRecord,
  PlotEvent,
  PlotOutline,
  CharacterState,
  Snapshot,
  SaveSlot,
  ApiEndpoint,
  AppSettings,
} from './types';
import { createDefaultCharacterState } from './types';
import { createDefaultSaveProfile, saveSaveProfile, savePlotOutline } from './database';
import { createStateManager } from './state-manager';

// ========== Helpers ==========

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `MEM${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
    saveId: 'save_test',
    createdAt: Date.now(),
    realTimestamp: Date.now(),
    timeRange: { start: '001-01-01', end: '001-01-02' },
    content: '这是一条测试记忆，内容足够长以满足最低字数要求。'.repeat(4),
    hiddenLine: '暗线内容：测试暗线数据',
    keywords: ['测试', '记忆'],
    relatedCharacterIds: ['char_1'],
    importance: 5,
    ...overrides,
  };
}

function makePlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: crypto.randomUUID(),
    saveId: 'save_test',
    title: '测试事件',
    description: '测试描述',
    status: 'pending',
    childrenIds: [],
    parentId: undefined,
    order: 0,
    relatedCharacterIds: [],
    location: undefined,
    worldLineChanged: false,
    visibility: 'hidden',
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCharacter(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: crypto.randomUUID(),
    ...overrides,
  });
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  // M5 规范 §11.2: 快照 = characters + saveProfile 整份深拷贝
  return {
    id: crypto.randomUUID(),
    saveId: 'save_test',
    createdAt: Date.now(),
    reason: 'turn',
    turn: 1,
    characters: [],
    saveProfile: createDefaultSaveProfile('save_test'),
    ...overrides,
  };
}

function makeSaveSlot(overrides: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id: crypto.randomUUID(),
    name: 'Test Save',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: 'TestChar',
      userName: 'Tester',
      gameStartTime: '001-01-01',
      totalTurns: 0,
    },
    ...overrides,
  };
}

function makeApiEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: crypto.randomUUID(),
    name: 'Test API',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    timeout: 60000,
    ...overrides,
  };
}

// ========== Setup & Teardown ==========

beforeEach(async () => {
  // Reset the database singleton completely
  try { await clearAllData(); } catch { /* db may not exist yet */ }
  await initializeDatabase();
});

// ========== Initialize & Version ==========

describe('initializeDatabase', () => {
  it('应自动创建默认 preset 和 settings', async () => {
    const db = getDatabase();
    const presets = await db.presets.count();
    const settings = await db.settings.count();
    expect(presets).toBeGreaterThanOrEqual(1);
    expect(settings).toBe(1);
  });

  it('重复调用不应创建重复数据', async () => {
    await initializeDatabase();
    await initializeDatabase();
    const db = getDatabase();
    const presetCount = await db.presets.count();
    const settingsCount = await db.settings.count();
    expect(presetCount).toBe(1);
    expect(settingsCount).toBe(1);
  });

  it('settings 应含 v4 默认字段', async () => {
    const s = await getSettings();
    expect(s).toBeDefined();
    expect(s!.apiEndpoints).toEqual([]);
    expect(s!.agentConfigs).toEqual([]);
    expect(s!.cacheStrategy).toBe('userid_isolated');
    expect(s!.maxSnapshotsPerSave).toBe(30);
    expect(s!.maxMemoriesRecall).toBe(20);
  });
});

// ========== v4 Tables Exist ==========

describe('v4 新表存在性', () => {
  it('memories 表应存在', async () => {
    const count = await getDatabase().memories.count();
    expect(typeof count).toBe('number');
  });

  it('plotEvents 表应存在', async () => {
    const count = await getDatabase().plotEvents.count();
    expect(typeof count).toBe('number');
  });

  it('characters 表应存在', async () => {
    const count = await getDatabase().characters.count();
    expect(typeof count).toBe('number');
  });

  it('snapshots 表应存在', async () => {
    const count = await getDatabase().snapshots.count();
    expect(typeof count).toBe('number');
  });

  it('saves 表应存在', async () => {
    const count = await getDatabase().saves.count();
    expect(typeof count).toBe('number');
  });

  it('apiEndpoints 表应存在', async () => {
    const count = await getDatabase().apiEndpoints.count();
    expect(typeof count).toBe('number');
  });
});

// ========== Memories CRUD ==========

describe('Memories CRUD', () => {
  it('saveMemory 应保存并返回 id', async () => {
    const m = makeMemory();
    const id = await saveMemory(m);
    expect(id).toBe(m.id);

    const all = await getMemories('save_test');
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe(m.content);
  });

  it('getMemories 应按 saveId 过滤', async () => {
    await saveMemory(makeMemory({ saveId: 'save_a', id: 'MEM000001' }));
    await saveMemory(makeMemory({ saveId: 'save_b', id: 'MEM000002' }));

    const a = await getMemories('save_a');
    const b = await getMemories('save_b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].saveId).toBe('save_a');
    expect(b[0].saveId).toBe('save_b');
  });

  it('getMemoriesByIds 应按 ID 批量获取', async () => {
    await saveMemory(makeMemory({ id: 'MEM000001' }));
    await saveMemory(makeMemory({ id: 'MEM000002' }));
    await saveMemory(makeMemory({ id: 'MEM000003' }));

    const result = await getMemoriesByIds(['MEM000001', 'MEM000003']);
    expect(result).toHaveLength(2);
  });

  it('deleteMemory 应删除记忆', async () => {
    const m = makeMemory({ id: 'MEM_TO_DELETE' });
    await saveMemory(m);
    await deleteMemory(m.id);
    const all = await getMemories('save_test');
    expect(all).toHaveLength(0);
  });

  it('getRecentMemories 应按时间倒序返回 limit 条', async () => {
    const base = Date.now();
    await saveMemory(makeMemory({ id: 'MEM000001', createdAt: base - 3000 }));
    await saveMemory(makeMemory({ id: 'MEM000002', createdAt: base - 2000 }));
    await saveMemory(makeMemory({ id: 'MEM000003', createdAt: base - 1000 }));

    const recent = await getRecentMemories('save_test', 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].createdAt).toBeGreaterThan(recent[1].createdAt);
  });
});

// ========== PlotEvents CRUD ==========

describe('PlotEvents CRUD', () => {
  it('savePlotEvent 应保存事件', async () => {
    const e = makePlotEvent();
    const id = await savePlotEvent(e);
    expect(id).toBe(e.id);

    const all = await getPlotEvents('save_test');
    expect(all).toHaveLength(1);
  });

  it('savePlotEvents 应批量保存', async () => {
    const events = [
      makePlotEvent({ id: 'e1' }),
      makePlotEvent({ id: 'e2' }),
      makePlotEvent({ id: 'e3' }),
    ];
    await savePlotEvents(events);
    const all = await getPlotEvents('save_test');
    expect(all).toHaveLength(3);
  });

  it('getActivePlotEvents 只返回 active 状态', async () => {
    await savePlotEvent(makePlotEvent({ id: 'e1', status: 'active' }));
    await savePlotEvent(makePlotEvent({ id: 'e2', status: 'pending' }));
    await savePlotEvent(makePlotEvent({ id: 'e3', status: 'completed' }));

    const active = await getActivePlotEvents('save_test');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('e1');
  });

  it('savePlotEvent 应自动更新 updatedAt', async () => {
    const e = makePlotEvent();
    const oldUpdatedAt = e.updatedAt;
    await new Promise(r => setTimeout(r, 10));
    await savePlotEvent(e);
    const all = await getPlotEvents('save_test');
    expect(all[0].updatedAt).toBeGreaterThan(oldUpdatedAt);
  });

  it('deletePlotEvent 应删除事件', async () => {
    const e = makePlotEvent({ id: 'to_delete' });
    await savePlotEvent(e);
    await deletePlotEvent('to_delete');
    const all = await getPlotEvents('save_test');
    expect(all).toHaveLength(0);
  });

  it('应正确存储 childrenIds 扁平引用', async () => {
    const parent = makePlotEvent({ id: 'parent', childrenIds: ['child1', 'child2'] });
    await savePlotEvent(parent);
    const all = await getPlotEvents('save_test');
    expect(all[0].childrenIds).toEqual(['child1', 'child2']);
  });
});

// ========== Characters CRUD ==========

describe('Characters CRUD', () => {
  it('saveCharacter 应保存角色', async () => {
    const c = makeCharacter();
    const id = await saveCharacter(c);
    expect(id).toBe(c.id);
  });

  it('getCharacter 应按 id 获取', async () => {
    const c = makeCharacter({ id: 'char_001', name: 'Alice' });
    await saveCharacter(c);
    const found = await getCharacter('char_001');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Alice');
  });

  it('saveCharacters 应批量保存', async () => {
    const chars = [
      makeCharacter({ id: 'c1' }),
      makeCharacter({ id: 'c2' }),
    ];
    await saveCharacters(chars);
    expect(await getCharacter('c1')).toBeDefined();
    expect(await getCharacter('c2')).toBeDefined();
  });

  it('deleteCharacter 应删除角色', async () => {
    const c = makeCharacter({ id: 'to_delete' });
    await saveCharacter(c);
    await deleteCharacter('to_delete');
    expect(await getCharacter('to_delete')).toBeUndefined();
  });
});

// ========== Snapshots CRUD ==========

describe('Snapshots CRUD', () => {
  it('saveSnapshot 应保存快照', async () => {
    const s = makeSnapshot();
    const id = await saveSnapshot(s);
    expect(id).toBe(s.id);
  });

  it('getSnapshots 应按 createdAt 升序排序', async () => {
    await saveSnapshot(makeSnapshot({ id: 's1', createdAt: 2000 }));
    await saveSnapshot(makeSnapshot({ id: 's0', createdAt: 1000 }));
    await saveSnapshot(makeSnapshot({ id: 's2', createdAt: 3000 }));

    const all = await getSnapshots('save_test');
    expect(all.map(s => s.id)).toEqual(['s0', 's1', 's2']);
  });

  it('getLatestSnapshot 应返回 createdAt 最大的快照', async () => {
    await saveSnapshot(makeSnapshot({ id: 's0', createdAt: 1000 }));
    await saveSnapshot(makeSnapshot({ id: 's5', createdAt: 5000 }));

    const latest = await getLatestSnapshot('save_test');
    expect(latest).toBeDefined();
    expect(latest!.id).toBe('s5');
  });

  it('getLatestSnapshot 无快照时返回 undefined', async () => {
    const latest = await getLatestSnapshot('save_empty');
    expect(latest).toBeUndefined();
  });

  it('trimSnapshots 应按 createdAt 删除超出上限的旧快照（保留最新 N 个）', async () => {
    for (let i = 0; i < 10; i++) {
      await saveSnapshot(makeSnapshot({ id: `s${i}`, createdAt: 1000 + i }));
    }

    await trimSnapshots('save_test', 5);
    const remaining = await getSnapshots('save_test');
    expect(remaining).toHaveLength(5);
    // 应保留 createdAt 最新的 5 个 (s5-s9)
    expect(remaining.map(s => s.id).sort()).toEqual(['s5', 's6', 's7', 's8', 's9']);
  });

  it('trimSnapshots 数量不超上限时不过删除', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSnapshot(makeSnapshot({ id: `s${i}`, createdAt: 1000 + i }));
    }
    await trimSnapshots('save_test', 10);
    expect(await getSnapshots('save_test')).toHaveLength(3);
  });

  it('🆕 trimSnapshots(tiered) 阶梯淘汰：最近5全留 + 旧层稀疏化（40回合→11档）', async () => {
    // turn 1..40 各打一张 turn 快照
    for (let t = 1; t <= 40; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    await trimSnapshots('save_test', 30, 'tiered');
    const remaining = (await getSnapshots('save_test')).map(s => s.turn).sort((a, b) => a - b);
    // tier0(36-40 全留) + tier1 每4(32,28,24,20,16) + tier2 每8(8)
    expect(remaining).toEqual([8, 16, 20, 24, 28, 32, 36, 37, 38, 39, 40]);
  });

  it('🆕 trimSnapshots(tiered) 铁律：最近5个 turn 档永不淘汰（即使上限<5）', async () => {
    for (let t = 1; t <= 10; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    // maxCount=3，但最近5(turn 6-10)必须全保留
    await trimSnapshots('save_test', 3, 'tiered');
    const remaining = (await getSnapshots('save_test')).map(s => s.turn).sort((a, b) => a - b);
    expect(remaining).toEqual([6, 7, 8, 9, 10]);
  });

  it('🆕 trimSnapshots(tiered) 非 turn 档(manual/pre-combat)受保护永不淘汰', async () => {
    await saveSnapshot(makeSnapshot({ id: 'manual-1', turn: 5, reason: 'manual', createdAt: 500 }));
    await saveSnapshot(makeSnapshot({ id: 'combat-1', turn: 7, reason: 'pre-combat', createdAt: 700 }));
    for (let t = 1; t <= 40; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    await trimSnapshots('save_test', 30, 'tiered');
    const remaining = await getSnapshots('save_test');
    expect(remaining.find(s => s.id === 'manual-1')).toBeDefined();
    expect(remaining.find(s => s.id === 'combat-1')).toBeDefined();
  });

  it('🆕 trimSnapshots(dense) 向后兼容：保留最新 N 个（FIFO）', async () => {
    for (let t = 1; t <= 10; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    await trimSnapshots('save_test', 5, 'dense');
    const remaining = (await getSnapshots('save_test')).map(s => s.turn).sort((a, b) => a - b);
    expect(remaining).toEqual([6, 7, 8, 9, 10]);
  });

  it('快照 characters/saveProfile 整份落库可读回（M5 §11.2）', async () => {
    const hero = createDefaultCharacterState({ id: 'h1', name: '主角', saveId: 'save_test', hp: 77 });
    const profile = createDefaultSaveProfile('save_test');
    profile.fp = 9;
    profile.variables = { sys: { 进度: '第二章' } };
    await saveSnapshot(makeSnapshot({ id: 'snap_full', characters: [hero], saveProfile: profile }));

    const loaded = await getSnapshot('snap_full');
    expect(loaded).toBeDefined();
    expect(loaded!.characters[0].hp).toBe(77);
    expect(loaded!.saveProfile.fp).toBe(9);
    expect(loaded!.saveProfile.variables).toEqual({ sys: { 进度: '第二章' } });
  });
});

// ========== SaveSlots CRUD ==========

describe('SaveSlots CRUD', () => {
  it('saveSaveSlot 应保存存档', async () => {
    const s = makeSaveSlot();
    const id = await saveSaveSlot(s);
    expect(id).toBe(s.id);
  });

  it('getSaves 应按更新时间倒序排列（越新越靠前）', async () => {
    // saveSaveSlot 内部会设置 updatedAt = Date.now()
    await saveSaveSlot(makeSaveSlot({ id: 'save_1', slot: 1 }));
    await new Promise(r => setTimeout(r, 2)); // 确保不同毫秒
    await saveSaveSlot(makeSaveSlot({ id: 'save_0', slot: 0 }));
    await new Promise(r => setTimeout(r, 2));
    await saveSaveSlot(makeSaveSlot({ id: 'save_2', slot: 2 }));

    const all = await getSaves();
    // 倒序：最后创建的 save_2(slot=2) → save_0(slot=0) → save_1(slot=1)
    expect(all.map(s => s.slot)).toEqual([2, 0, 1]);
  });

  it('getSaveBySlot 应按槽号查找', async () => {
    await saveSaveSlot(makeSaveSlot({ id: 'save_5', slot: 5 }));
    const found = await getSaveBySlot(5);
    expect(found).toBeDefined();
    expect(found!.slot).toBe(5);
  });

  it('getSave 应按 id 查找', async () => {
    await saveSaveSlot(makeSaveSlot({ id: 'my_save' }));
    expect(await getSave('my_save')).toBeDefined();
    expect(await getSave('nonexistent')).toBeUndefined();
  });

  it('saveSaveSlot 应自动更新 updatedAt', async () => {
    const s = makeSaveSlot();
    const oldTime = s.updatedAt;
    await new Promise(r => setTimeout(r, 10));
    await saveSaveSlot(s);
    const saved = await getSave(s.id);
    expect(saved!.updatedAt).toBeGreaterThan(oldTime);
  });

  it('deleteSaveSlot 应级联删除关联数据', async () => {
    const saveId = 'save_to_delete';
    // Create save + related data
    await saveSaveSlot(makeSaveSlot({ id: saveId, slot: 3 }));
    await saveMemory(makeMemory({ id: 'mem_x', saveId }));
    await savePlotEvent(makePlotEvent({ id: 'plot_x', saveId }));
    await saveSnapshot(makeSnapshot({ id: 'snap_x', saveId }));

    await deleteSaveSlot(saveId);

    expect(await getSave(saveId)).toBeUndefined();
    expect(await getMemories(saveId)).toHaveLength(0);
    expect(await getPlotEvents(saveId)).toHaveLength(0);
    expect(await getSnapshots(saveId)).toHaveLength(0);
  });

  it('deleteSaveSlot 级联删除该存档的 characters（修 #9 删档残留）', async () => {
    await saveSaveSlot(makeSaveSlot({ id: 'save_del' }));
    await saveCharacter(createDefaultCharacterState({ id: 'cd1', name: '将删', saveId: 'save_del' }));
    await saveCharacter(createDefaultCharacterState({ id: 'cd2', name: '留下', saveId: 'save_other' }));
    await deleteSaveSlot('save_del');
    const all = await getCharacters();
    expect(all.map(c => c.id)).not.toContain('cd1');
    expect(all.map(c => c.id)).toContain('cd2');
  });
});

// ========== deleteSaveSlot 事务化 (M6 Task 4, M1 终审 Minor 遗留) ==========

describe('deleteSaveSlot 事务化 (M6 Task 4)', () => {
  const TARGET = 'save_tx_target';
  const OTHER = 'save_tx_other';

  function makeOutlineFor(saveId: string): PlotOutline {
    return {
      id: `outline_${saveId}`,
      saveId,
      mode: 'main',
      title: '测试大纲',
      summary: '摘要',
      content: '测试大纲内容',
      chapters: [],
      confirmed: true,
      version: 1,
      timeRange: { start: '001-01-01', end: '001-02-01' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function makeMessageFor(saveId: string): ChatMessage {
    return {
      id: `msg_${saveId}`,
      role: 'assistant',
      content: '一段测试正文',
      timestamp: Date.now(),
      saveId,
      turn: 1,
    };
  }

  /** 给一个存档在全部 8 张关联表各播 1 条数据 */
  async function seedSave(saveId: string, slot: number): Promise<void> {
    await saveSaveSlot(makeSaveSlot({ id: saveId, slot }));
    await saveMemory(makeMemory({ id: `mem_${saveId}`, saveId }));
    await savePlotEvent(makePlotEvent({ id: `plot_${saveId}`, saveId }));
    await savePlotOutline(makeOutlineFor(saveId));
    await saveSnapshot(makeSnapshot({ id: `snap_${saveId}`, saveId }));
    await saveMessage(makeMessageFor(saveId));
    await saveCharacter(createDefaultCharacterState({ id: `char_${saveId}`, name: `角色_${saveId}`, saveId }));
    await saveSaveProfile(createDefaultSaveProfile(saveId));
  }

  /** 该存档在 8 张表中的记录数（表名 → 条数） */
  async function countAll(saveId: string): Promise<Record<string, number>> {
    const db = getDatabase();
    return {
      saves: (await db.saves.get(saveId)) ? 1 : 0,
      memories: await db.memories.where('saveId').equals(saveId).count(),
      plotEvents: await db.plotEvents.where('saveId').equals(saveId).count(),
      plotOutlines: await db.plotOutlines.where('saveId').equals(saveId).count(),
      snapshots: await db.snapshots.where('saveId').equals(saveId).count(),
      messages: await db.messages.where('saveId').equals(saveId).count(),
      characters: await db.characters.where('saveId').equals(saveId).count(),
      saveProfiles: (await db.saveProfiles.get(saveId)) ? 1 : 0,
    };
  }

  it('8 表全清 + 其他存档数据不受影响', async () => {
    await seedSave(TARGET, 7);
    await seedSave(OTHER, 8);

    await deleteSaveSlot(TARGET);

    const targetCounts = await countAll(TARGET);
    for (const [table, count] of Object.entries(targetCounts)) {
      expect(count, `目标存档 ${table} 表应清空`).toBe(0);
    }
    const otherCounts = await countAll(OTHER);
    for (const [table, count] of Object.entries(otherCounts)) {
      expect(count, `其他存档 ${table} 表不应被误删`).toBe(1);
    }
  });

  it('事务原子性：末步 saves 删除失败 → 前置 7 表删除整体回滚（不留半删存档）', async () => {
    await seedSave(TARGET, 9);
    const db = getDatabase();

    // own property 遮蔽原型方法，让最后一步 saves.delete 抛错
    (db.saves as any).delete = () => {
      throw new Error('模拟 saves 表删除失败');
    };
    try {
      await expect(deleteSaveSlot(TARGET)).rejects.toThrow();
    } finally {
      delete (db.saves as any).delete;
    }

    // Dexie 事务回滚：8 张表数据全部保留
    const counts = await countAll(TARGET);
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} 表应随事务回滚保留`).toBe(1);
    }
  });
});

// ========== API Endpoints CRUD ==========

describe('API Endpoints CRUD', () => {
  it('saveApiEndpoint 应保存端点', async () => {
    const ep = makeApiEndpoint();
    const id = await saveApiEndpoint(ep);
    expect(id).toBe(ep.id);
  });

  it('getApiEndpoints 应返回所有端点', async () => {
    await saveApiEndpoint(makeApiEndpoint({ id: 'ep1', name: 'DeepSeek主号' }));
    await saveApiEndpoint(makeApiEndpoint({ id: 'ep2', name: 'Kimi备用' }));

    const all = await getApiEndpoints();
    expect(all).toHaveLength(2);
  });

  it('deleteApiEndpoint 应删除端点', async () => {
    await saveApiEndpoint(makeApiEndpoint({ id: 'ep_del' }));
    await deleteApiEndpoint('ep_del');
    expect(await getApiEndpoints()).toHaveLength(0);
  });
});

// ========== Full Backup ==========

describe('exportAllData / importAllData', () => {
  it('exportAllData 应包含所有表数据', async () => {
    await saveMemory(makeMemory({ id: 'exp_mem' }));
    await savePlotEvent(makePlotEvent({ id: 'exp_plot' }));
    await saveApiEndpoint(makeApiEndpoint({ id: 'exp_api' }));

    const backup = await exportAllData();
    expect(backup.version).toBe(10);
    expect(Array.isArray(backup.lorebooks)).toBe(true);
    expect(Array.isArray(backup.presets)).toBe(true);
    expect(Array.isArray(backup.settings)).toBe(true);
    expect(Array.isArray(backup.memories)).toBe(true);
    expect(Array.isArray(backup.plotEvents)).toBe(true);
    expect(Array.isArray(backup.characters)).toBe(true);
    expect(Array.isArray(backup.snapshots)).toBe(true);
    expect(Array.isArray(backup.saves)).toBe(true);
    expect(Array.isArray(backup.apiEndpoints)).toBe(true);
    expect(Array.isArray(backup.createPresets)).toBe(true);
    expect(Array.isArray(backup.messages)).toBe(true);
  });

  it('importAllData 应还原数据', async () => {
    // Seed some data
    await saveMemory(makeMemory({ id: 'seed_mem' }));
    await saveApiEndpoint(makeApiEndpoint({ id: 'seed_api' }));

    const backup = await exportAllData();

    // Clear and re-import
    await clearAllData();
    await initializeDatabase();
    await importAllData(backup);

    const mems = await getMemories('save_test');
    const apis = await getApiEndpoints();
    expect(mems).toHaveLength(1);
    expect(apis).toHaveLength(1);
    expect(mems[0].id).toBe('seed_mem');
    expect(apis[0].id).toBe('seed_api');
  });

  it('importAllData 无效格式应抛错', async () => {
    await expect(importAllData(null as any)).rejects.toThrow('备份格式无效');
    await expect(importAllData('string' as any)).rejects.toThrow('备份格式无效');
  });

  it('importAllData 导入 pre-v9 备份应回填角色一等 saveId（getCharacters 可查到）', async () => {
    const backup = await exportAllData();
    // 构造 pre-v9 形状角色：无一等 saveId，只有 customFields.saveId
    const legacyChar: any = createDefaultCharacterState({ id: 'legacy_1', name: '旧备份角色' });
    delete legacyChar.saveId;
    legacyChar.customFields = { saveId: 'save_legacy' };
    backup.characters = [legacyChar];
    // pre-v9 SaveProfile：无 variables 字段
    const legacyProfile: any = {
      saveId: 'save_legacy', fp: 0, fpHistory: [], contracts: [], achievements: [],
      news: [], quests: {}, focusQuest: '', affections: {},
      gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 },
      worldFlags: {}, updatedAt: Date.now(),
    };
    backup.saveProfiles = [legacyProfile];

    await importAllData(backup);

    const chars = await getCharacters('save_legacy');
    expect(chars).toHaveLength(1);
    expect(chars[0].id).toBe('legacy_1');
    expect(chars[0].saveId).toBe('save_legacy');

    const db = getDatabase();
    const profile = await db.saveProfiles.get('save_legacy');
    expect(profile).toBeDefined();
    expect(profile!.variables).toEqual({});
  });
});

// ========== Settings Persistence ==========

describe('Settings Persistence', () => {
  it('saveSettings + getSettings 应正常读写', async () => {
    const s = await getSettings();
    expect(s).toBeDefined();
    s!.theme = 'light';
    s!.cacheStrategy = 'aggressive';
    await saveSettings(s!);

    const reloaded = await getSettings();
    expect(reloaded!.theme).toBe('light');
    expect(reloaded!.cacheStrategy).toBe('aggressive');
  });

  it('保存 settings 自动带 key', async () => {
    const s = await getSettings();
    await saveSettings(s!);
    const all = await getDatabase().settings.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].key).toBe('settings');
  });
});

// ========== Messages CRUD (Phase 10h) ==========

describe('Messages CRUD (Phase 10h)', () => {
  const SAVE_ID = 'msg-test-save';

  function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '测试消息',
      timestamp: Date.now(),
      saveId: SAVE_ID,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await deleteMessagesBySaveId(SAVE_ID);
  });

  it('saveMessage: 写入单条消息并可读取', async () => {
    const msg = makeMsg({ content: 'AI 回复正文' });
    await saveMessage(msg);

    const msgs = await getMessages(SAVE_ID);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('AI 回复正文');
    expect(msgs[0].role).toBe('assistant');
  });

  it('saveMessages: 批量写入多条消息', async () => {
    const msgs = [
      makeMsg({ role: 'user', content: '你好' }),
      makeMsg({ role: 'assistant', content: '你好啊冒险者' }),
    ];
    await saveMessages(msgs);

    const loaded = await getMessages(SAVE_ID);
    expect(loaded).toHaveLength(2);
  });

  it('getMessages: 按 saveId 隔离，不同存档消息不混淆', async () => {
    await saveMessage(makeMsg({ content: '存档A的消息' }));
    await saveMessage(makeMsg({
      id: crypto.randomUUID(),
      content: '存档B的消息',
      saveId: 'other-save',
      role: 'assistant',
    }));

    const loaded = await getMessages(SAVE_ID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('存档A的消息');

    const other = await getMessages('other-save');
    expect(other).toHaveLength(1);
    expect(other[0].content).toBe('存档B的消息');
  });

  it('deleteMessagesBySaveId: 清空指定存档全部消息', async () => {
    await saveMessage(makeMsg());
    await saveMessage(makeMsg({ id: crypto.randomUUID() }));
    expect((await getMessages(SAVE_ID)).length).toBe(2);

    await deleteMessagesBySaveId(SAVE_ID);
    expect((await getMessages(SAVE_ID)).length).toBe(0);
  });

  it('getMessages: 返回结果按时间戳升序排列', async () => {
    const base = Date.now();
    await saveMessage(makeMsg({ id: crypto.randomUUID(), timestamp: base + 100, content: '第二条' }));
    await saveMessage(makeMsg({ id: crypto.randomUUID(), timestamp: base, content: '第一条' }));
    await saveMessage(makeMsg({ id: crypto.randomUUID(), timestamp: base + 200, content: '第三条' }));

    const msgs = await getMessages(SAVE_ID);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('第一条');
    expect(msgs[1].content).toBe('第二条');
    expect(msgs[2].content).toBe('第三条');
  });
});

// ========== v9: characters saveId 一等索引 (M1 #43) ==========

describe('v9: characters saveId 一等索引', () => {
  it('getCharacters(saveId) 按一等字段过滤（不再读 customFields）', async () => {
    const a = createDefaultCharacterState({ id: 'ca', name: '甲', saveId: 'save_A' });
    const b = createDefaultCharacterState({ id: 'cb', name: '乙', saveId: 'save_B' });
    await saveCharacters([a, b]);
    const got = await getCharacters('save_A');
    expect(got.map(c => c.id)).toEqual(['ca']);
  });

  it('customFields.saveId 不再参与过滤', async () => {
    const c = createDefaultCharacterState({ id: 'cc', name: '丙', saveId: '', customFields: { saveId: 'save_A' } });
    await saveCharacter(c);
    const got = await getCharacters('save_A');
    expect(got.find(x => x.id === 'cc')).toBeUndefined();
  });
});

// ========== deleteMessagesAfterTurn (M5 #49 复合索引启用) ==========

describe('deleteMessagesAfterTurn — [saveId+turn] 复合索引 (M5 #49)', () => {
  const SID = 'save_turncut';
  function mk(id: string, turn: number, saveId = SID): ChatMessage {
    return { id, role: 'assistant', content: id, timestamp: turn, saveId, turn };
  }

  it('删除 turn 大于给定值的消息，边界 turn 本身保留', async () => {
    await saveMessages([mk('t1', 1), mk('t2a', 2), mk('t2b', 2), mk('t3', 3), mk('t4', 4)]);
    await deleteMessagesAfterTurn(SID, 2);
    const rest = await getMessages(SID);
    expect(rest.map(m => m.id).sort()).toEqual(['t1', 't2a', 't2b']);
  });

  it('不同存档的消息不受影响', async () => {
    await saveMessages([mk('a3', 3), mk('other3', 3, 'save_other')]);
    await deleteMessagesAfterTurn(SID, 0);
    expect(await getMessages(SID)).toHaveLength(0);
    const other = await getMessages('save_other');
    expect(other.map(m => m.id)).toEqual(['other3']);
  });
});

// ========== restoreSnapshot 集成 (M5 Task 3: 覆写 + 对话回滚) ==========

describe('restoreSnapshot 集成 — 真实 DB (M5 §11.2)', () => {
  it('restoreSnapshot: 状态覆写 + 对话回滚到快照 turn', async () => {
    const saveId = 'save_restore';
    await saveSaveSlot(makeSaveSlot({ id: saveId }));

    // 角色 hp=80 + profile fp=5 + 变量第一章
    const hero = createDefaultCharacterState({ id: 'hero-1', name: '主角', type: 'player', saveId, hp: 80, maxHp: 100 });
    await saveCharacter(hero);
    const { getProfile, updateProfile } = await import('./save-profile');
    const p1 = await getProfile(saveId);
    p1.fp = 5;
    p1.variables = { sys: { 进度: '第一章' } };
    await updateProfile(p1);

    // 造 3 轮对话消息(turn 1/2/3)，前两轮在快照前
    const mkMsg = (id: string, turn: number, content: string): ChatMessage =>
      ({ id, role: 'user', content, timestamp: turn, saveId, turn });
    await saveMessage(mkMsg('m1', 1, '第一轮'));
    await saveMessage(mkMsg('m2', 2, '第二轮'));

    // turn2 时打快照(角色 hp=80, fp=5)
    const sm = createStateManager(saveId);
    const snap = await sm.createSnapshot('turn', 2);

    // → turn3 后: 角色 hp=30、fp=9、变量第三章、新增消息、新增 NPC
    hero.hp = 30;
    await saveCharacter(hero);
    await saveCharacter(createDefaultCharacterState({ id: 'npc-late', name: '路人', type: 'npc', saveId }));
    const p2 = await getProfile(saveId);
    p2.fp = 9;
    p2.variables = { sys: { 进度: '第三章' } };
    await updateProfile(p2);
    await saveMessage(mkMsg('m3', 3, '第三轮'));

    // → restoreSnapshot
    const result = await sm.restoreSnapshot(snap.id);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);

    // 断言: hp 回 80 + 整体覆写（快照后加入的 NPC 消失）
    const chars = await getCharacters(saveId);
    expect(chars).toHaveLength(1);
    expect(chars[0].id).toBe('hero-1');
    expect(chars[0].hp).toBe(80);

    // fp 回 5、variables 随 profile 回滚
    const restored = await getProfile(saveId);
    expect(restored.fp).toBe(5);
    expect(restored.variables).toEqual({ sys: { 进度: '第一章' } });

    // turn3 消息已删、turn1/2 消息还在
    const msgs = await getMessages(saveId);
    expect(msgs.map(m => m.id).sort()).toEqual(['m1', 'm2']);

    // activeSnapshotId 指向该快照
    const slot = await getSave(saveId);
    expect(slot?.activeSnapshotId).toBe(snap.id);
  });

  it('跨存档快照恢复被拒: snapshot.saveId ≠ 当前 saveId → errors[]', async () => {
    await saveSaveSlot(makeSaveSlot({ id: 'save_a', slot: 0 }));
    await saveSaveSlot(makeSaveSlot({ id: 'save_b', slot: 1 }));
    const snapA = await createStateManager('save_a').createSnapshot('manual', 1);

    const result = await createStateManager('save_b').restoreSnapshot(snapA.id);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('不属于当前存档');
  });
});
