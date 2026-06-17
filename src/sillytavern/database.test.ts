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
} from './database';
import type {
  MemoryRecord,
  PlotEvent,
  CharacterState,
  Snapshot,
  SaveSlot,
  ApiEndpoint,
  AppSettings,
} from './types';
import { createDefaultCharacterState } from './types';

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
  return {
    id: crypto.randomUUID(),
    saveId: 'save_test',
    index: 0,
    timestamp: Date.now(),
    gameTime: '001-01-01-12:00',
    variables: { HP: 100, MP: 50 },
    characters: [],
    plotEvents: [],
    memoryIds: [],
    turnNumber: 1,
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
    snapshots: [],
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

  it('getSnapshots 应按 index 排序', async () => {
    await saveSnapshot(makeSnapshot({ id: 's0', index: 0 }));
    await saveSnapshot(makeSnapshot({ id: 's1', index: 1 }));
    await saveSnapshot(makeSnapshot({ id: 's2', index: 2 }));

    const all = await getSnapshots('save_test');
    expect(all.map(s => s.index)).toEqual([0, 1, 2]);
  });

  it('getLatestSnapshot 应返回 index 最大的快照', async () => {
    await saveSnapshot(makeSnapshot({ id: 's0', index: 0 }));
    await saveSnapshot(makeSnapshot({ id: 's5', index: 5 }));

    const latest = await getLatestSnapshot('save_test');
    expect(latest).toBeDefined();
    expect(latest!.index).toBe(5);
  });

  it('getLatestSnapshot 无快照时返回 undefined', async () => {
    const latest = await getLatestSnapshot('save_empty');
    expect(latest).toBeUndefined();
  });

  it('trimSnapshots 应删除超出上限的旧快照', async () => {
    for (let i = 0; i < 10; i++) {
      await saveSnapshot(makeSnapshot({ id: `s${i}`, index: i }));
    }

    await trimSnapshots('save_test', 5);
    const remaining = await getSnapshots('save_test');
    expect(remaining).toHaveLength(5);
    // 应保留最新的 5 个 (index 5-9)
    const indices = remaining.map(s => s.index).sort();
    expect(indices).toEqual([5, 6, 7, 8, 9]);
  });

  it('trimSnapshots 数量不超上限时不过删除', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSnapshot(makeSnapshot({ id: `s${i}`, index: i }));
    }
    await trimSnapshots('save_test', 10);
    expect(await getSnapshots('save_test')).toHaveLength(3);
  });
});

// ========== SaveSlots CRUD ==========

describe('SaveSlots CRUD', () => {
  it('saveSaveSlot 应保存存档', async () => {
    const s = makeSaveSlot();
    const id = await saveSaveSlot(s);
    expect(id).toBe(s.id);
  });

  it('getSaves 应按 slot 排序', async () => {
    await saveSaveSlot(makeSaveSlot({ id: 'save_1', slot: 1 }));
    await saveSaveSlot(makeSaveSlot({ id: 'save_0', slot: 0 }));
    await saveSaveSlot(makeSaveSlot({ id: 'save_2', slot: 2 }));

    const all = await getSaves();
    expect(all.map(s => s.slot)).toEqual([0, 1, 2]);
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
  it('exportAllData 应包含所有 10 表', async () => {
    await saveMemory(makeMemory({ id: 'exp_mem' }));
    await savePlotEvent(makePlotEvent({ id: 'exp_plot' }));
    await saveApiEndpoint(makeApiEndpoint({ id: 'exp_api' }));

    const backup = await exportAllData();
    expect(backup.version).toBe(7);
    expect(Array.isArray(backup.lorebooks)).toBe(true);
    expect(Array.isArray(backup.presets)).toBe(true);
    expect(Array.isArray(backup.settings)).toBe(true);
    expect(Array.isArray(backup.chats)).toBe(true);
    expect(Array.isArray(backup.memories)).toBe(true);
    expect(Array.isArray(backup.plotEvents)).toBe(true);
    expect(Array.isArray(backup.characters)).toBe(true);
    expect(Array.isArray(backup.snapshots)).toBe(true);
    expect(Array.isArray(backup.saves)).toBe(true);
    expect(Array.isArray(backup.apiEndpoints)).toBe(true);
    expect(Array.isArray(backup.createPresets)).toBe(true);
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
