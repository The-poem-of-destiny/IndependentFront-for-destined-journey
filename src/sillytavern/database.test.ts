/**
 * database.ts — v4 数据库 CRUD & 迁移测试
 *
 * Uses fake-indexeddb (injected via src/test-setup.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
  // Audio (v11)
  getAudioTracks,
  getAudioTrack,
  saveAudioTrack,
  deleteAudioTrack,
  getAudioBlob,
  getAudioPlaylists,
  getAudioPlaylist,
  saveAudioPlaylist,
  deleteAudioPlaylist,
  // Audio 本地文件夹句柄 (v12)
  getAudioHandle,
  saveAudioHandle,
  deleteAudioHandle,
  // Asset (v13)
  getAssets,
  getAsset,
  saveAsset,
  deleteAsset,
  deleteAssets,
  getAssetBlob,
  // 角色外貌会话副本 (v19 / D56)
  characterAppearanceKey,
  getCharacterAppearances,
  saveCharacterAppearance,
} from './database';
import type { FullBackup } from './database';
import type {
  ChatMessage,
  MemoryRecord,
  PlotEvent,
  PlotOutline,
  CharacterState,
  Snapshot,
  SaveSlot,
  ApiEndpoint,
  AudioTrack,
  AudioPlaylist,
  AudioHandleRecord,
  AssetMetaRecord,
  WorkshopProject,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import Dexie from 'dexie';
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

function makeWorkshopProject(overrides: Partial<WorkshopProject> = {}): WorkshopProject {
  return {
    id: crypto.randomUUID(),
    rootProjectId: 'root_1',
    name: '测试工坊项目',
    description: '测试用二创项目',
    version: '1.0.0',
    authorName: '测试作者',
    tags: ['系统', '外挂'],
    downloadUrl: 'https://example.invalid/pkg.json',
    fileSize: 1024,
    installState: 'installed',
    installedVersion: '1.0.0',
    installedAt: Date.now(),
    fetchedAt: Date.now(),
    uidRange: { start: 900000, end: 900999 },
    updatedAt: Date.now(),
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

function makeAudioTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: crypto.randomUUID(),
    name: '测试音轨',
    kind: 'music',
    source: 'blob',
    mimeType: 'audio/mpeg',
    size: 1234,
    tags: ['战斗'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeAudioPlaylist(overrides: Partial<AudioPlaylist> = {}): AudioPlaylist {
  return {
    id: crypto.randomUUID(),
    name: '测试列表',
    trackIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * 目录句柄夹具：fake-indexeddb 走结构化克隆，普通对象即可往返。
 * 不要尝试构造真实 FileSystemDirectoryHandle —— node 环境下不存在该 API。
 */
function makeAudioHandle(overrides: Partial<AudioHandleRecord> = {}): AudioHandleRecord {
  return {
    id: 'library-root',
    handle: { kind: 'directory', name: '我的音乐' } as unknown as FileSystemDirectoryHandle,
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeAsset(overrides: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  return {
    id: crypto.randomUUID(),
    name: '苏婉',
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 4096,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ========== Setup & Teardown ==========

beforeEach(async () => {
  // Reset the database singleton completely
  try {
    await clearAllData();
  } catch {
    /* db may not exist yet */
  }
  await initializeDatabase();
});

// ========== Initialize & Version ==========

describe('initializeDatabase', () => {
  it('应自动创建默认 preset；settings 表刻意**不**播种（Q-06）', async () => {
    const db = getDatabase();
    const presets = await db.presets.count();
    expect(presets).toBeGreaterThanOrEqual(1);
    // 播种出来的那行只会是一份没人读的影子配置 —— 设置的真源在 localStorage，
    // 引擎经 engine-settings 注入缝读它。
    expect(await db.settings.count()).toBe(0);
  });

  it('重复调用不应创建重复数据', async () => {
    await initializeDatabase();
    await initializeDatabase();
    const db = getDatabase();
    const presetCount = await db.presets.count();
    expect(presetCount).toBe(1);
    expect(await db.settings.count()).toBe(0);
  });

  it.skip('settings 应含 v4 默认字段（Q-06：不再播种，此断言随之失效）', async () => {
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
    await new Promise((r) => setTimeout(r, 10));
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
    const chars = [makeCharacter({ id: 'c1' }), makeCharacter({ id: 'c2' })];
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
    expect(all.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
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
    expect(remaining.map((s) => s.id).sort()).toEqual(['s5', 's6', 's7', 's8', 's9']);
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
    const remaining = (await getSnapshots('save_test')).map((s) => s.turn).sort((a, b) => a - b);
    // tier0(36-40 全留) + tier1 每4(32,28,24,20,16) + tier2 每8(8)
    expect(remaining).toEqual([8, 16, 20, 24, 28, 32, 36, 37, 38, 39, 40]);
  });

  it('🆕 trimSnapshots(tiered) 铁律：最近5个 turn 档永不淘汰（即使上限<5）', async () => {
    for (let t = 1; t <= 10; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    // maxCount=3，但最近5(turn 6-10)必须全保留
    await trimSnapshots('save_test', 3, 'tiered');
    const remaining = (await getSnapshots('save_test')).map((s) => s.turn).sort((a, b) => a - b);
    expect(remaining).toEqual([6, 7, 8, 9, 10]);
  });

  it('🆕 trimSnapshots(tiered) 非 turn 档(manual/pre-combat)受保护永不淘汰', async () => {
    await saveSnapshot(makeSnapshot({ id: 'manual-1', turn: 5, reason: 'manual', createdAt: 500 }));
    await saveSnapshot(
      makeSnapshot({ id: 'combat-1', turn: 7, reason: 'pre-combat', createdAt: 700 }),
    );
    for (let t = 1; t <= 40; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    await trimSnapshots('save_test', 30, 'tiered');
    const remaining = await getSnapshots('save_test');
    expect(remaining.find((s) => s.id === 'manual-1')).toBeDefined();
    expect(remaining.find((s) => s.id === 'combat-1')).toBeDefined();
  });

  it('🆕 trimSnapshots(dense) 向后兼容：保留最新 N 个（FIFO）', async () => {
    for (let t = 1; t <= 10; t++) {
      await saveSnapshot(makeSnapshot({ id: `turn-${t}`, turn: t, createdAt: 1000 + t }));
    }
    await trimSnapshots('save_test', 5, 'dense');
    const remaining = (await getSnapshots('save_test')).map((s) => s.turn).sort((a, b) => a - b);
    expect(remaining).toEqual([6, 7, 8, 9, 10]);
  });

  it('快照 characters/saveProfile 整份落库可读回（M5 §11.2）', async () => {
    const hero = createDefaultCharacterState({
      id: 'h1',
      name: '主角',
      saveId: 'save_test',
      hp: 77,
    });
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
    await new Promise((r) => setTimeout(r, 2)); // 确保不同毫秒
    await saveSaveSlot(makeSaveSlot({ id: 'save_0', slot: 0 }));
    await new Promise((r) => setTimeout(r, 2));
    await saveSaveSlot(makeSaveSlot({ id: 'save_2', slot: 2 }));

    const all = await getSaves();
    // 倒序：最后创建的 save_2(slot=2) → save_0(slot=0) → save_1(slot=1)
    expect(all.map((s) => s.slot)).toEqual([2, 0, 1]);
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
    await new Promise((r) => setTimeout(r, 10));
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
    await saveCharacter(
      createDefaultCharacterState({ id: 'cd1', name: '将删', saveId: 'save_del' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'cd2', name: '留下', saveId: 'save_other' }),
    );
    await deleteSaveSlot('save_del');
    const all = await getCharacters();
    expect(all.map((c) => c.id)).not.toContain('cd1');
    expect(all.map((c) => c.id)).toContain('cd2');
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
    await saveCharacter(
      createDefaultCharacterState({ id: `char_${saveId}`, name: `角色_${saveId}`, saveId }),
    );
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
    // 🔴 跟随 DB_VERSION，而 DB_VERSION 必须等于最后一个 `this.version(n)` ——
    // 这条断言曾经写着 17 而 schema 已经到 19（v18 删地点预设行 / v19 角色外貌会话副本），
    // 于是它把漂移**固定**下来而不是拦下来。升版时 database.ts 与这里一起改。
    expect(backup.version).toBe(19);
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
    expect(Array.isArray(backup.worldBooks)).toBe(true);
    expect(Array.isArray(backup.workshopProjects)).toBe(true);
    expect(Array.isArray(backup.regexStorage)).toBe(true);
    // v17 —— 元数据进备份，字节（sceneImageBlobs）刻意不进（设计 §7.3）
    expect(Array.isArray(backup.sceneImages)).toBe(true);
    expect(Array.isArray(backup.imagePresets)).toBe(true);
    expect('sceneImageBlobs' in backup).toBe(false);
    // v19 —— 角色外貌会话副本与 sceneImages 同为「每存档」数据，必须同进同出
    expect(Array.isArray(backup.characterAppearances)).toBe(true);
  });

  /**
   * 🔴 会话外貌漏出备份时**不会有任何报错** —— 存档的其余部分完好，只是每个角色的
   * 本档变化静默退回基线，症状看起来像「AI 忘了她换过装」。所以这条走完整往返。
   */
  it('exportAllData/importAllData 应往返角色外貌会话副本（v19/D56）', async () => {
    const db = getDatabase();
    await saveCharacterAppearance({
      key: characterAppearanceKey('save_test', '艾莉丝'),
      saveId: 'save_test',
      name: '艾莉丝',
      patch: { outfit: 'dark travel cloak', condition: 'soaked' },
      updatedAt: 1_700_000_000_000,
    });

    const backup = await exportAllData();
    expect(backup.characterAppearances).toHaveLength(1);

    // 清空这张表，模拟「换一台设备后导入」
    await db.characterAppearances.clear();
    expect(await getCharacterAppearances('save_test')).toHaveLength(0);

    await importAllData(backup);

    const restored = await getCharacterAppearances('save_test');
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('艾莉丝');
    expect(restored[0].patch).toEqual({ outfit: 'dark travel cloak', condition: 'soaked' });
  });

  /** 三态语义：pre-v19 的旧备份对这张表**无话可说**，就不该有权删它 */
  it('导入缺 characterAppearances 字段的旧备份应保留现有会话外貌', async () => {
    await saveCharacterAppearance({
      key: characterAppearanceKey('save_test', '苏婉'),
      saveId: 'save_test',
      name: '苏婉',
      patch: { hairStyle: 'short hair' },
      updatedAt: 1_700_000_000_000,
    });

    const backup = await exportAllData();
    delete (backup as Partial<FullBackup>).characterAppearances;

    await importAllData(backup as FullBackup);

    const kept = await getCharacterAppearances('save_test');
    expect(kept).toHaveLength(1);
    expect(kept[0].patch).toEqual({ hairStyle: 'short hair' });
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
      saveId: 'save_legacy',
      fp: 0,
      fpHistory: [],
      contracts: [],
      achievements: [],
      news: [],
      quests: {},
      focusQuest: '',
      affections: {},
      gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 },
      worldFlags: {},
      updatedAt: Date.now(),
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

  /**
   * v14 三态语义（**缺席 ≠ 空数组**）—— 世界书迁进 Dexie 后这两张表装着不可再生的用户数据:
   *   · 字段缺席（pre-v14 备份）→ 表原样不动，连 clear 都不执行
   *   · 字段为空数组           → 合法的「用户确实没有」，照常清空
   *   · 字段有数据             → 正常覆盖
   * 若把守卫写在 clear() 之后（或用 `?? []` 抹平 undefined），第一条会退化成「清空整张表」，
   * 「恢复一份旧备份」就会静默抹掉用户全部世界书。以下六条把三态逐一钉死。
   */
  describe('importAllData × v14 新表三态语义', () => {
    /** 预置：worldBooks 两行 + workshopProjects 两行 */
    async function seedV14Tables() {
      const db = getDatabase();
      await db.worldBooks.bulkPut([
        { id: 'wb_user', name: '用户自建书', partition: 'extra_setting', entries: [] },
        {
          id: 'workshop:proj_seed',
          name: '工坊书',
          partition: 'creative_workshop',
          entries: [],
        },
      ]);
      await db.workshopProjects.bulkPut([
        makeWorkshopProject({ id: 'proj_seed', name: '种子项目' }),
        makeWorkshopProject({ id: 'proj_seed2', name: '种子项目2' }),
      ]);
    }

    it('缺 worldBooks 字段（pre-v14 备份）：整张表逐行原样保留', async () => {
      await seedV14Tables();
      const legacyBackup: any = await exportAllData();
      delete legacyBackup.worldBooks;
      legacyBackup.version = 13;
      expect('worldBooks' in legacyBackup).toBe(false);

      await expect(importAllData(legacyBackup)).resolves.toBeUndefined();

      const db = getDatabase();
      expect(await db.worldBooks.count()).toBe(2);
      expect((await db.worldBooks.get('wb_user'))!.name).toBe('用户自建书');
      expect((await db.worldBooks.get('workshop:proj_seed'))!.partition).toBe('creative_workshop');
    });

    it('worldBooks: [] （字段存在但为空）：表被清空', async () => {
      await seedV14Tables();
      const backup = await exportAllData();
      backup.worldBooks = [];

      await importAllData(backup);

      expect(await getDatabase().worldBooks.count()).toBe(0);
    });

    it('worldBooks 含数据：正常覆盖', async () => {
      await seedV14Tables();
      const backup = await exportAllData();
      backup.worldBooks = [
        { id: 'wb_from_backup', name: '备份里的书', partition: 'dlc', entries: [] },
      ];

      await importAllData(backup);

      const db = getDatabase();
      expect(await db.worldBooks.count()).toBe(1);
      expect((await db.worldBooks.get('wb_from_backup'))!.name).toBe('备份里的书');
      expect(await db.worldBooks.get('wb_user')).toBeUndefined();
    });

    it('缺 workshopProjects 字段（pre-v14 备份）：整张表逐行原样保留', async () => {
      await seedV14Tables();
      const legacyBackup: any = await exportAllData();
      delete legacyBackup.workshopProjects;
      legacyBackup.version = 13;
      expect('workshopProjects' in legacyBackup).toBe(false);

      await expect(importAllData(legacyBackup)).resolves.toBeUndefined();

      const db = getDatabase();
      expect(await db.workshopProjects.count()).toBe(2);
      expect((await db.workshopProjects.get('proj_seed'))!.name).toBe('种子项目');
      expect((await db.workshopProjects.get('proj_seed2'))!.name).toBe('种子项目2');
    });

    it('workshopProjects: [] （字段存在但为空）：表被清空', async () => {
      await seedV14Tables();
      const backup = await exportAllData();
      backup.workshopProjects = [];

      await importAllData(backup);

      expect(await getDatabase().workshopProjects.count()).toBe(0);
    });

    it('workshopProjects 含数据：正常覆盖', async () => {
      await seedV14Tables();
      const backup = await exportAllData();
      backup.workshopProjects = [makeWorkshopProject({ id: 'proj_from_backup', name: '备份项目' })];

      await importAllData(backup);

      const db = getDatabase();
      expect(await db.workshopProjects.count()).toBe(1);
      expect((await db.workshopProjects.get('proj_from_backup'))!.name).toBe('备份项目');
      expect(await db.workshopProjects.get('proj_seed')).toBeUndefined();
    });

    it('两个字段同时缺席（真实 pre-v14 备份形状）：两张表都原样保留，其它表照常导入', async () => {
      await seedV14Tables();
      await saveApiEndpoint(makeApiEndpoint({ id: 'api_before' }));
      const legacyBackup: any = await exportAllData();
      delete legacyBackup.worldBooks;
      delete legacyBackup.workshopProjects;
      legacyBackup.version = 13;

      await expect(importAllData(legacyBackup)).resolves.toBeUndefined();

      const db = getDatabase();
      expect(await db.worldBooks.count()).toBe(2);
      expect(await db.workshopProjects.count()).toBe(2);
      // 其它表仍按整库替换语义正常导入
      expect((await getApiEndpoints()).map((e) => e.id)).toContain('api_before');
      expect(await db.presets.count()).toBeGreaterThan(0);
    });
  });

  describe('importAllData × v15 beautifierRules 三态语义', () => {
    /** 预置：两条用户美化规则 */
    async function seedV15Table() {
      await getDatabase().beautifierRules.bulkPut([
        {
          id: 'rule_user_a',
          name: '用户规则A',
          scope: 'maintext',
          pattern: 'aaa',
          flags: 'gm',
          replacement: '<b>aaa</b>',
          enabled: true,
          order: 1,
          isBuiltin: false,
        },
        {
          id: 'rule_user_b',
          name: '用户规则B',
          scope: 'global',
          pattern: 'bbb',
          flags: 'g',
          replacement: '<i>bbb</i>',
          enabled: false,
          order: 2,
          isBuiltin: false,
        },
      ]);
    }

    it('缺 beautifierRules 字段（pre-v15 备份）：整张表逐行原样保留', async () => {
      await seedV15Table();
      const legacyBackup: any = await exportAllData();
      delete legacyBackup.beautifierRules;
      legacyBackup.version = 14;
      expect('beautifierRules' in legacyBackup).toBe(false);

      await expect(importAllData(legacyBackup)).resolves.toBeUndefined();

      const db = getDatabase();
      expect(await db.beautifierRules.count()).toBe(2);
      expect((await db.beautifierRules.get('rule_user_a'))!.replacement).toBe('<b>aaa</b>');
      expect((await db.beautifierRules.get('rule_user_b'))!.enabled).toBe(false);
    });

    it('beautifierRules: [] （字段存在但为空）：表被清空', async () => {
      await seedV15Table();
      const backup = await exportAllData();
      backup.beautifierRules = [];

      await importAllData(backup);

      expect(await getDatabase().beautifierRules.count()).toBe(0);
    });

    it('beautifierRules 含数据：正常覆盖', async () => {
      await seedV15Table();
      const backup = await exportAllData();
      backup.beautifierRules = [
        {
          id: 'rule_from_backup',
          name: '备份里的规则',
          scope: 'maintext',
          pattern: 'zzz',
          flags: 'g',
          replacement: '<u>zzz</u>',
          enabled: true,
          order: 5,
          isBuiltin: false,
        },
      ];

      await importAllData(backup);

      const db = getDatabase();
      expect(await db.beautifierRules.count()).toBe(1);
      expect((await db.beautifierRules.get('rule_from_backup'))!.name).toBe('备份里的规则');
      expect(await db.beautifierRules.get('rule_user_a')).toBeUndefined();
    });

    it('exportAllData / importAllData 往返保留 beautifierRules', async () => {
      await seedV15Table();
      const backup = await exportAllData();
      expect(backup.beautifierRules).toHaveLength(2);

      await getDatabase().beautifierRules.clear();
      await importAllData(backup);

      const rows = await getDatabase().beautifierRules.toArray();
      expect(rows.map((r) => r.id).sort()).toEqual(['rule_user_a', 'rule_user_b']);
    });
  });

  describe('importAllData × v16 regexStorage 三态语义', () => {
    async function seedV16Table() {
      await getDatabase().regexStorage.bulkPut([
        { key: 'theme', value: 'dark', updatedAt: 1 },
        { key: 'viewer-state', value: '{"tab":"inventory"}', updatedAt: 2 },
      ]);
    }

    it('缺 regexStorage 字段（pre-v16 备份）：整张表逐行原样保留', async () => {
      await seedV16Table();
      const legacyBackup: any = await exportAllData();
      delete legacyBackup.regexStorage;
      legacyBackup.version = 15;

      await expect(importAllData(legacyBackup)).resolves.toBeUndefined();

      const rows = await getDatabase().regexStorage.toArray();
      expect(rows).toHaveLength(2);
      expect((await getDatabase().regexStorage.get('theme'))?.value).toBe('dark');
    });

    it('regexStorage: []（字段存在但为空）：表被清空', async () => {
      await seedV16Table();
      const backup = await exportAllData();
      backup.regexStorage = [];

      await importAllData(backup);

      expect(await getDatabase().regexStorage.count()).toBe(0);
    });

    it('regexStorage 含数据：正常覆盖', async () => {
      await seedV16Table();
      const backup = await exportAllData();
      backup.regexStorage = [{ key: 'fresh', value: 'restored', updatedAt: 3 }];

      await importAllData(backup);

      const db = getDatabase();
      expect(await db.regexStorage.count()).toBe(1);
      expect((await db.regexStorage.get('fresh'))?.value).toBe('restored');
      expect(await db.regexStorage.get('theme')).toBeUndefined();
    });

    it('exportAllData / importAllData 往返保留 regexStorage', async () => {
      await seedV16Table();
      const backup = await exportAllData();
      await getDatabase().regexStorage.clear();

      await importAllData(backup);

      const rows = await getDatabase().regexStorage.toArray();
      expect(rows.map((row) => [row.key, row.value])).toEqual([
        ['theme', 'dark'],
        ['viewer-state', '{"tab":"inventory"}'],
      ]);
    });
  });

  it('exportAllData / importAllData 往返应保留 worldBooks 与 workshopProjects', async () => {
    const db = getDatabase();
    await db.worldBooks.put({
      id: 'workshop:proj_1',
      name: '工坊书',
      partition: 'creative_workshop',
      builtIn: false,
      entries: [
        {
          uid: 900001,
          name: '工坊条目',
          content: '正文',
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 100,
          position: 0,
          extra: {
            workshop: {
              projectId: 'proj_1',
              projectName: '测试项目',
              sourceUid: 42,
              sourceComment: '上游注释',
              sourceHash: 'deadbeef',
            },
          },
        },
      ],
    });
    await db.workshopProjects.put(makeWorkshopProject({ id: 'proj_1' }));

    const backup = await exportAllData();
    await clearAllData();
    await initializeDatabase();
    await importAllData(backup);

    const db2 = getDatabase();
    const book = await db2.worldBooks.get('workshop:proj_1');
    expect(book).toBeDefined();
    expect(book!.partition).toBe('creative_workshop');
    expect(book!.entries[0].extra?.workshop?.sourceHash).toBe('deadbeef');
    const proj = await db2.workshopProjects.get('proj_1');
    expect(proj).toBeDefined();
    expect(proj!.uidRange).toEqual({ start: 900000, end: 900999 });
  });
});

// ========== Settings Persistence ==========

describe('Settings Persistence', () => {
  // Q-06：settings 表不再被播种，所以先写一行再读。
  // 这张表在生产里已无读写（只剩 FullBackup 为老备份往返照搬），
  // 这几条只是保住表本身的读写 API 还能用。
  it('saveSettings + getSettings 应正常读写', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, key: 'settings' });
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
    await saveSettings({ ...DEFAULT_SETTINGS, key: 'settings' });
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
    await saveMessage(
      makeMsg({
        id: crypto.randomUUID(),
        content: '存档B的消息',
        saveId: 'other-save',
        role: 'assistant',
      }),
    );

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
    await saveMessage(
      makeMsg({ id: crypto.randomUUID(), timestamp: base + 100, content: '第二条' }),
    );
    await saveMessage(makeMsg({ id: crypto.randomUUID(), timestamp: base, content: '第一条' }));
    await saveMessage(
      makeMsg({ id: crypto.randomUUID(), timestamp: base + 200, content: '第三条' }),
    );

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
    expect(got.map((c) => c.id)).toEqual(['ca']);
  });

  it('customFields.saveId 不再参与过滤', async () => {
    const c = createDefaultCharacterState({
      id: 'cc',
      name: '丙',
      saveId: '',
      customFields: { saveId: 'save_A' },
    });
    await saveCharacter(c);
    const got = await getCharacters('save_A');
    expect(got.find((x) => x.id === 'cc')).toBeUndefined();
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
    expect(rest.map((m) => m.id).sort()).toEqual(['t1', 't2a', 't2b']);
  });

  it('不同存档的消息不受影响', async () => {
    await saveMessages([mk('a3', 3), mk('other3', 3, 'save_other')]);
    await deleteMessagesAfterTurn(SID, 0);
    expect(await getMessages(SID)).toHaveLength(0);
    const other = await getMessages('save_other');
    expect(other.map((m) => m.id)).toEqual(['other3']);
  });
});

// ========== restoreSnapshot 集成 (M5 Task 3: 覆写 + 对话回滚) ==========

describe('restoreSnapshot 集成 — 真实 DB (M5 §11.2)', () => {
  it('restoreSnapshot: 状态覆写 + 对话回滚到快照 turn', async () => {
    const saveId = 'save_restore';
    await saveSaveSlot(makeSaveSlot({ id: saveId }));

    // 角色 hp=80 + profile fp=5 + 变量第一章
    const hero = createDefaultCharacterState({
      id: 'hero-1',
      name: '主角',
      type: 'player',
      saveId,
      hp: 80,
      maxHp: 100,
    });
    await saveCharacter(hero);
    const { getProfile, updateProfile } = await import('./save-profile');
    const p1 = await getProfile(saveId);
    p1.fp = 5;
    p1.variables = { sys: { 进度: '第一章' } };
    await updateProfile(p1);

    // 造 3 轮对话消息(turn 1/2/3)，前两轮在快照前
    const mkMsg = (id: string, turn: number, content: string): ChatMessage => ({
      id,
      role: 'user',
      content,
      timestamp: turn,
      saveId,
      turn,
    });
    await saveMessage(mkMsg('m1', 1, '第一轮'));
    await saveMessage(mkMsg('m2', 2, '第二轮'));

    // turn2 时打快照(角色 hp=80, fp=5)
    const sm = createStateManager(saveId);
    const snap = await sm.createSnapshot('turn', 2);

    // → turn3 后: 角色 hp=30、fp=9、变量第三章、新增消息、新增 NPC
    hero.hp = 30;
    await saveCharacter(hero);
    await saveCharacter(
      createDefaultCharacterState({ id: 'npc-late', name: '路人', type: 'npc', saveId }),
    );
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
    expect(msgs.map((m) => m.id).sort()).toEqual(['m1', 'm2']);

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

// ========== Audio (v11) ==========

describe('Audio CRUD (v11)', () => {
  it('音轨保存/读取应往返一致', async () => {
    const track = makeAudioTrack({ name: '序曲', tags: ['开场', '和平'] });
    const id = await saveAudioTrack(track);
    expect(id).toBe(track.id);

    const loaded = await getAudioTrack(track.id);
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('序曲');
    expect(loaded!.kind).toBe('music');
    expect(loaded!.tags).toEqual(['开场', '和平']);
  });

  it('saveAudioTrack 应自行打上 updatedAt', async () => {
    const before = Date.now();
    const track = makeAudioTrack({ updatedAt: 0 });
    await saveAudioTrack(track);
    const loaded = await getAudioTrack(track.id);
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('saveAudioPlaylist 应自行打上 updatedAt', async () => {
    const before = Date.now();
    const list = makeAudioPlaylist({ updatedAt: 0 });
    await saveAudioPlaylist(list);
    const loaded = await getAudioPlaylist(list.id);
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('blob 应与元数据分表存储，可单独读取', async () => {
    const track = makeAudioTrack();
    const blob = new Blob(['fake-audio-bytes']);
    await saveAudioTrack(track, blob);

    const loadedBlob = await getAudioBlob(track.id);
    expect(loadedBlob).toBeDefined();
    expect(await loadedBlob!.text()).toBe('fake-audio-bytes');
  });

  it('未传 blob 时不应写入 audioBlobs', async () => {
    const track = makeAudioTrack();
    await saveAudioTrack(track);
    expect(await getAudioBlob(track.id)).toBeUndefined();
  });

  it('getAudioTracks() 返回的元数据行不应携带音频字节', async () => {
    const track = makeAudioTrack();
    await saveAudioTrack(track, new Blob(['bytes']));

    const tracks = await getAudioTracks();
    expect(tracks).toHaveLength(1);
    expect((tracks[0] as any).blob).toBeUndefined();
    expect(Object.keys(tracks[0])).not.toContain('blob');
  });

  it('删除音轨应同时清除元数据与字节', async () => {
    const track = makeAudioTrack();
    await saveAudioTrack(track, new Blob(['bytes']));

    await deleteAudioTrack(track.id);
    expect(await getAudioTrack(track.id)).toBeUndefined();
    expect(await getAudioBlob(track.id)).toBeUndefined();
  });

  it('删除音轨应从所有播放列表中剔除该 id', async () => {
    const t1 = makeAudioTrack({ name: 'A' });
    const t2 = makeAudioTrack({ name: 'B' });
    await saveAudioTrack(t1);
    await saveAudioTrack(t2);

    const l1 = makeAudioPlaylist({ trackIds: [t1.id, t2.id] });
    const l2 = makeAudioPlaylist({ trackIds: [t2.id] });
    await saveAudioPlaylist(l1);
    await saveAudioPlaylist(l2);

    await deleteAudioTrack(t2.id);

    expect((await getAudioPlaylist(l1.id))!.trackIds).toEqual([t1.id]);
    expect((await getAudioPlaylist(l2.id))!.trackIds).toEqual([]);
  });

  it('删除播放列表不应级联删除其中的音轨', async () => {
    const track = makeAudioTrack();
    await saveAudioTrack(track, new Blob(['bytes']));
    const list = makeAudioPlaylist({ trackIds: [track.id] });
    await saveAudioPlaylist(list);

    await deleteAudioPlaylist(list.id);

    expect(await getAudioPlaylist(list.id)).toBeUndefined();
    expect(await getAudioTrack(track.id)).toBeDefined();
    expect(await getAudioBlob(track.id)).toBeDefined();
  });

  it('播放列表 CRUD 应往返一致', async () => {
    const list = makeAudioPlaylist({ name: '战斗歌单', trackIds: ['t1', 't2'] });
    await saveAudioPlaylist(list);

    let all = await getAudioPlaylists();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('战斗歌单');
    expect(all[0].trackIds).toEqual(['t1', 't2']);

    list.name = '和平歌单';
    list.trackIds = ['t3'];
    await saveAudioPlaylist(list);
    const updated = await getAudioPlaylist(list.id);
    expect(updated!.name).toBe('和平歌单');
    expect(updated!.trackIds).toEqual(['t3']);

    await deleteAudioPlaylist(list.id);
    all = await getAudioPlaylists();
    expect(all).toHaveLength(0);
  });

  // ---------- 本地文件夹 (v12) ----------

  it('source=file 的音轨应无 blob 往返（文件夹路径不存字节）', async () => {
    const track = makeAudioTrack({
      name: '外部曲目',
      source: 'file',
      relativePath: 'bgm/序曲.mp3',
      missing: false,
      mimeType: undefined,
      size: undefined,
    });
    await saveAudioTrack(track);

    const loaded = await getAudioTrack(track.id);
    expect(loaded).toBeDefined();
    expect(loaded!.source).toBe('file');
    expect(loaded!.relativePath).toBe('bgm/序曲.mp3');
    expect(loaded!.missing).toBe(false);
    // 文件夹路径不存字节
    expect(await getAudioBlob(track.id)).toBeUndefined();
  });

  it('missing=true 的音轨行应保留（曲目丢失不删行，保住 tags/歌单槽位）', async () => {
    const track = makeAudioTrack({ source: 'file', relativePath: 'gone.mp3', missing: true });
    await saveAudioTrack(track);
    const loaded = await getAudioTrack(track.id);
    expect(loaded!.missing).toBe(true);
    expect(loaded!.tags).toEqual(['战斗']);
  });

  it('目录句柄保存/读取应往返一致', async () => {
    const record = makeAudioHandle();
    const id = await saveAudioHandle(record);
    expect(id).toBe('library-root');

    const loaded = await getAudioHandle('library-root');
    expect(loaded).toBeDefined();
    expect(loaded!.addedAt).toBe(record.addedAt);
    expect((loaded!.handle as any).name).toBe('我的音乐');
  });

  it('saveAudioHandle 未带 addedAt 时应补时间戳', async () => {
    const before = Date.now();
    const record = makeAudioHandle({ addedAt: 0 });
    await saveAudioHandle(record);
    const loaded = await getAudioHandle('library-root');
    expect(loaded!.addedAt).toBeGreaterThanOrEqual(before);
  });

  it('删除目录句柄后应读不到', async () => {
    await saveAudioHandle(makeAudioHandle());
    await deleteAudioHandle('library-root');
    expect(await getAudioHandle('library-root')).toBeUndefined();
  });

  it('不存在的目录句柄应返回 undefined', async () => {
    expect(await getAudioHandle('library-root')).toBeUndefined();
    expect(await getAudioHandle('不存在的id')).toBeUndefined();
  });
});

// ========== Asset (v13) ==========

/**
 * v12 完整 schema —— 迁移回归测试用（见本文件末尾"v13 升版不得丢数据"）。
 * 这份副本是**刻意的**: 它冻结了升版前的真实形状，改动 database.ts 的 v13 块不会连带改到它，
 * 所以"漏写某表 = 静默删表"这个 Dexie 陷阱才会被测出来而不是一起改坏。
 */
const V12_STORES = {
  lorebooks: 'id, name, updatedAt',
  presets: 'id, name, updatedAt',
  settings: 'key',
  memories: 'id, saveId, createdAt, realTimestamp',
  plotEvents: 'id, saveId, parentId, status, updatedAt',
  characters: 'id, saveId, type',
  snapshots: 'id, saveId, createdAt',
  saves: 'id, slot, updatedAt',
  apiEndpoints: 'id, name',
  plotOutlines: 'id, saveId, updatedAt',
  saveProfiles: 'saveId, updatedAt',
  createPresets: 'id, name, updatedAt',
  messages: 'id, saveId, [saveId+turn]',
  audioTracks: 'id, name, kind, *tags, updatedAt',
  audioBlobs: 'id',
  audioPlaylists: 'id, name, updatedAt',
  audioHandles: 'id',
} as const;

describe('Asset CRUD (v13)', () => {
  it('assetMeta / assetBlobs 表应存在', async () => {
    expect(typeof (await getDatabase().assetMeta.count())).toBe('number');
    expect(typeof (await getDatabase().assetBlobs.count())).toBe('number');
  });

  it('保存/读取素材元数据应往返一致', async () => {
    const asset = makeAsset({
      name: '苏婉',
      type: '立绘',
      variant: '微笑',
      ext: 'webp',
      mime: 'image/webp',
    });
    const id = await saveAsset(asset);
    expect(id).toBe(asset.id);

    const loaded = await getAsset(asset.id);
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('苏婉');
    expect(loaded!.type).toBe('立绘');
    expect(loaded!.variant).toBe('微笑');
    expect(loaded!.ext).toBe('webp');
    expect(loaded!.mime).toBe('image/webp');
    expect(loaded!.bytes).toBe(4096);
  });

  it('saveAsset 应自行打上 updatedAt', async () => {
    const before = Date.now();
    const asset = makeAsset({ updatedAt: 0 });
    await saveAsset(asset);
    const loaded = await getAsset(asset.id);
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('可选字段（hash/credit/license）应原样往返', async () => {
    const asset = makeAsset({ hash: 'a'.repeat(64), credit: 'Aoo', license: 'CC-BY-4.0' });
    await saveAsset(asset);
    const loaded = await getAsset(asset.id);
    expect(loaded!.hash).toBe('a'.repeat(64));
    expect(loaded!.credit).toBe('Aoo');
    expect(loaded!.license).toBe('CC-BY-4.0');
  });

  it('传入 blob 时应同时写入 assetBlobs', async () => {
    const asset = makeAsset();
    const blob = new Blob(['fake-png-bytes']);
    await saveAsset(asset, blob);

    const loadedBlob = await getAssetBlob(asset.id);
    expect(loadedBlob).toBeDefined();
    expect(await loadedBlob!.text()).toBe('fake-png-bytes');
  });

  it('未传 blob 时不应写入 assetBlobs（元数据可先落库）', async () => {
    const asset = makeAsset();
    await saveAsset(asset);
    expect(await getAsset(asset.id)).toBeDefined();
    expect(await getAssetBlob(asset.id)).toBeUndefined();
  });

  it('getAssets 应只返回元数据、不触碰 assetBlobs（列全库不反序列化字节）', async () => {
    await saveAsset(makeAsset({ name: '苏婉' }), new Blob(['bytes-1']));
    await saveAsset(
      makeAsset({ name: '林秋', type: '立绘bg', ext: 'mp4', mime: 'video/mp4' }),
      new Blob(['bytes-2']),
    );

    const all = await getAssets();
    expect(all).toHaveLength(2);
    // 元数据行本身不含 blob 字段
    for (const row of all) {
      expect((row as unknown as Record<string, unknown>).blob).toBeUndefined();
    }
    // 字节确实在，只是要单独取
    expect(all.map((a) => a.name).sort()).toEqual(['林秋', '苏婉']);
    for (const row of all) {
      expect(await getAssetBlob(row.id)).toBeDefined();
    }
  });

  it('不存在的 id 应返回 undefined', async () => {
    expect(await getAsset('不存在的id')).toBeUndefined();
    expect(await getAssetBlob('不存在的id')).toBeUndefined();
  });

  it('删除素材应连带清掉字节（不留孤儿 blob）', async () => {
    const asset = makeAsset();
    await saveAsset(asset, new Blob(['bytes']));

    await deleteAsset(asset.id);

    expect(await getAsset(asset.id)).toBeUndefined();
    expect(await getAssetBlob(asset.id)).toBeUndefined();
    expect(await getDatabase().assetBlobs.count()).toBe(0);
  });

  it('批量删除应清掉指定行的元数据与字节，其余保留', async () => {
    const a = makeAsset({ name: 'A' });
    const b = makeAsset({ name: 'B' });
    const c = makeAsset({ name: 'C' });
    await saveAsset(a, new Blob(['a']));
    await saveAsset(b, new Blob(['b']));
    await saveAsset(c, new Blob(['c']));

    await deleteAssets([a.id, b.id]);

    expect(await getAsset(a.id)).toBeUndefined();
    expect(await getAsset(b.id)).toBeUndefined();
    expect(await getAssetBlob(a.id)).toBeUndefined();
    expect(await getAssetBlob(b.id)).toBeUndefined();
    expect(await getAsset(c.id)).toBeDefined();
    expect(await getAssetBlob(c.id)).toBeDefined();
    expect(await getAssets()).toHaveLength(1);
  });

  it('批量删除空数组应为无操作', async () => {
    await saveAsset(makeAsset(), new Blob(['bytes']));
    await deleteAssets([]);
    expect(await getAssets()).toHaveLength(1);
    expect(await getDatabase().assetBlobs.count()).toBe(1);
  });

  it('[name+type] 复合索引应可查询（去重按 (name, type) 定域，§4.4）', async () => {
    await saveAsset(makeAsset({ name: '苏婉', type: '头像', hash: 'h1' }));
    await saveAsset(makeAsset({ name: '苏婉', type: '头像', variant: '微笑', hash: 'h2' }));
    await saveAsset(makeAsset({ name: '苏婉', type: '立绘', hash: 'h3' }));
    await saveAsset(makeAsset({ name: '林秋', type: '头像', hash: 'h4' }));

    const scoped = await getDatabase()
      .assetMeta.where('[name+type]')
      .equals(['苏婉', '头像'])
      .toArray();
    expect(scoped).toHaveLength(2);
    expect(scoped.map((a) => a.hash).sort()).toEqual(['h1', 'h2']);

    // 同名不同类型不落入同一定域 —— 去重不该跨类型
    const other = await getDatabase()
      .assetMeta.where('[name+type]')
      .equals(['苏婉', '立绘'])
      .toArray();
    expect(other).toHaveLength(1);
    expect(other[0].hash).toBe('h3');

    // name 单列索引仍可用（按名分组浏览）
    const byName = await getDatabase().assetMeta.where('name').equals('苏婉').toArray();
    expect(byName).toHaveLength(3);
  });

  it('type 与 createdAt 单列索引应可查询', async () => {
    await saveAsset(makeAsset({ type: '头像', createdAt: 1000 }));
    await saveAsset(makeAsset({ type: '立绘', createdAt: 2000 }));
    await saveAsset(makeAsset({ type: '立绘', createdAt: 3000 }));

    expect(await getDatabase().assetMeta.where('type').equals('立绘').count()).toBe(2);
    const recent = await getDatabase().assetMeta.where('createdAt').above(1500).toArray();
    expect(recent).toHaveLength(2);
  });

  it('素材不应进入 FullBackup（D13 —— zip 导出才是迁移路径）', async () => {
    await saveAsset(makeAsset(), new Blob(['bytes']));
    const backup = await exportAllData();
    const asRecord = backup as unknown as Record<string, unknown>;
    expect(asRecord.assetMeta).toBeUndefined();
    expect(asRecord.assetBlobs).toBeUndefined();
  });

  it('clearAllData 应销毁素材表（整库 db.delete()，无需额外拆卸代码）', async () => {
    await saveAsset(makeAsset(), new Blob(['bytes']));
    expect(await getAssets()).toHaveLength(1);

    await clearAllData();
    await initializeDatabase();

    expect(await getAssets()).toHaveLength(0);
    expect(await getDatabase().assetBlobs.count()).toBe(0);
  });

  /**
   * 回归守卫: 以 v12 schema 真实写一遍数据，再以 v13 打开，逐表验数据还在 + 表册齐全。
   *
   * ⚠️ 关于"漏写即删表"这个说法（database.ts 的 v12 注释这么写）: **对 Dexie 4 不成立。**
   * `Version.stores()` 跨版本累加 schema，缺席的表从上一版继承；删表必须显式 `表名: null`
   * （v9 的 `chats: null` 就是唯一的删表写法）。已实测: 把 audioPlaylists 从 v13 块里删掉，
   * 数据照样在。所以本测试的真实守卫价值不在"漏写"，而在:
   *   · 升版路径本身不吃数据（比如误加 upgrade 回调 clear 了某表）
   *   · 表册不缺员（比如误写 `表名: null`，或新表根本没声明）—— 见下方 EXPECTED_V13_TABLES 断言
   */
  it('升版不得丢数据 —— 以 v12 写入后再以当前版打开应逐表保留', async () => {
    const dbName = getDatabase().name;
    // 从零起：先销毁 beforeEach 建好的当前版库
    await clearAllData();

    // ---- 以 v12 schema 打开并逐表写入一行 ----
    const legacy = new Dexie(dbName);
    legacy.version(12).stores({ ...V12_STORES });
    await legacy.open();
    expect(legacy.verno).toBe(12);

    const rows: Record<string, unknown> = {
      lorebooks: { id: 'lb1', name: '测试世界书', updatedAt: 1 },
      presets: { id: 'p1', name: '测试预设', updatedAt: 1 },
      settings: { key: 'settings', legacyMarker: true },
      memories: makeMemory({ id: 'MEM000001' }),
      plotEvents: makePlotEvent({ id: 'pe1' }),
      characters: makeCharacter({ id: 'ch1', saveId: 'save_test' }),
      snapshots: makeSnapshot({ id: 'sn1' }),
      saves: makeSaveSlot({ id: 'sv1' }),
      apiEndpoints: makeApiEndpoint({ id: 'api1' }),
      plotOutlines: { id: 'po1', saveId: 'save_test', updatedAt: 1 },
      saveProfiles: createDefaultSaveProfile('save_test'),
      createPresets: { id: 'cp1', name: '捏人预设', createdAt: 1, updatedAt: 1, data: {} },
      messages: {
        id: 'msg1',
        saveId: 'save_test',
        turn: 1,
        role: 'user',
        content: '你好',
        timestamp: 1,
      },
      audioTracks: makeAudioTrack({ id: 'tr1' }),
      audioBlobs: { id: 'tr1', blob: new Blob(['legacy-audio']) },
      audioPlaylists: makeAudioPlaylist({ id: 'pl1', trackIds: ['tr1'] }),
      audioHandles: makeAudioHandle(),
    };
    for (const [table, row] of Object.entries(rows)) {
      await legacy.table(table).put(row as never);
    }
    // 前置断言：v12 库里确实每表一行（否则下面的"数据还在"是空断言）
    for (const table of Object.keys(V12_STORES)) {
      expect(await legacy.table(table).count(), `v12 ${table} 应有 1 行`).toBe(1);
    }
    legacy.close();

    // ---- 以当前版 (AppDatabase) 打开：触发升版 ----
    await initializeDatabase();
    const db = getDatabase();
    expect(db.verno).toBe(19); // v18 = D59 删地点预设；v19 = D56 角色外貌会话副本

    // 表册齐全: v12 的 17 张 + 素材两张 + 工坊两张 + 美化规则一张 + 正则 KV 一张
    //           + 图像生成三张 + 角色外貌会话副本一张（v19/D56），一个不少
    //（误写 `表名: null` 或漏声明会在这里炸 —— 尤其 lorebooks/settings 两张死表按 D3 必须保留）
    const EXPECTED_TABLES = [
      ...Object.keys(V12_STORES),
      'assetMeta',
      'assetBlobs',
      'worldBooks',
      'workshopProjects',
      'beautifierRules',
      'regexStorage',
      'sceneImages',
      'sceneImageBlobs',
      'imagePresets',
      'characterAppearances',
    ].sort();
    expect(db.tables.map((t) => t.name).sort()).toEqual(EXPECTED_TABLES);

    // 每一张旧表的数据都必须还在（漏写任一表会让这里归零）
    for (const table of Object.keys(V12_STORES)) {
      expect(await db.table(table).count(), `升版后 ${table} 数据丢失`).toBe(1);
    }
    // 抽查内容而非仅行数
    expect((await db.lorebooks.get('lb1'))!.name).toBe('测试世界书');
    expect(await getAudioBlob('tr1')).toBeDefined();
    expect(await (await getAudioBlob('tr1'))!.text()).toBe('legacy-audio');
    expect((await db.audioPlaylists.get('pl1'))!.trackIds).toEqual(['tr1']);
    // 新表就位且为空
    expect(await getAssets()).toHaveLength(0);
    expect(await db.assetBlobs.count()).toBe(0);
    expect(await db.worldBooks.count()).toBe(0);
    expect(await db.workshopProjects.count()).toBe(0);
    expect(await db.beautifierRules.count()).toBe(0);
    expect(await db.regexStorage.count()).toBe(0);
    expect(await db.sceneImages.count()).toBe(0);
    expect(await db.sceneImageBlobs.count()).toBe(0);
    expect(await db.imagePresets.count()).toBe(0);

    // 升版后新表可正常写入
    const asset = makeAsset();
    await saveAsset(asset, new Blob(['post-upgrade']));
    expect(await (await getAssetBlob(asset.id))!.text()).toBe('post-upgrade');
    await db.regexStorage.put({ key: 'post-upgrade', value: 'ok', updatedAt: 1 });
    expect((await db.regexStorage.get('post-upgrade'))?.value).toBe('ok');
  });
});
