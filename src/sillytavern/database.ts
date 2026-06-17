/**
 * IndexedDB Database Layer — v4 多 Agent 引擎
 *
 * Tables: lorebooks, presets, settings, chats (v1-v3)
 *         memories, plot_events, characters, snapshots, saves, api_endpoints (v4 new)
 */

import Dexie, { Table } from 'dexie';
import type {
  Lorebook, ChatPreset, AppSettings, ChatSession,
  MemoryRecord, PlotEvent, CharacterState, Snapshot, SaveSlot, ApiEndpoint,
  PlotOutline, SaveProfile,
} from './types';
import type { CreatePreset } from '../ui/stores/create-store';
import { DEFAULT_SETTINGS } from './types';

/** 捏人预设记录 (DB 存储格式) */
export interface CreatePresetRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: CreatePreset;
}

const DB_NAME = 'SillyTavernWebDB';
const DB_VERSION = 7;

class AppDatabase extends Dexie {
  // v1-v3 tables
  lorebooks!: Table<Lorebook>;
  presets!: Table<ChatPreset>;
  settings!: Table<AppSettings>;
  chats!: Table<ChatSession>;

  // v4 new tables
  memories!: Table<MemoryRecord>;
  plotEvents!: Table<PlotEvent>;
  characters!: Table<CharacterState>;
  snapshots!: Table<Snapshot>;
  saves!: Table<SaveSlot>;
  apiEndpoints!: Table<ApiEndpoint>;

  // v5 new table (Phase 4)
  plotOutlines!: Table<PlotOutline>;

  // v6 new table (Phase 4.6)
  saveProfiles!: Table<SaveProfile>;

  // v7 new table (Phase 7d)
  createPresets!: Table<CreatePresetRecord>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
    });

    this.version(2).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
    });

    this.version(3).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
    }).upgrade(async tx => {
      const settings = await tx.table('settings').toCollection().toArray();
      for (const s of settings) {
        if (s.uiMode === undefined) s.uiMode = 'game';
        if (s.customTags === undefined) s.customTags = ['maintext', 'option', 'sum', 'vars', 'thinking', 'think'];
        if (s.thinkingDisplay === undefined) s.thinkingDisplay = 'fold';
        if (s.formatPromptTemplate === undefined) s.formatPromptTemplate = '';
        if (s.api && s.api.secondary === undefined) {
          s.api.secondary = { enabled: false, baseUrl: '', apiKey: '', model: '' };
        }
        await tx.table('settings').put(s);
      }
    });

    // v4: 多 Agent 引擎 — 新增 6 表 + Settings 字段扩展
    this.version(4).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
    }).upgrade(async tx => {
      // 迁移现有 settings — 添加 v4 新字段
      const settings = await tx.table('settings').toCollection().toArray();
      for (const s of settings) {
        if (s.apiEndpoints === undefined) s.apiEndpoints = [];
        if (s.agentConfigs === undefined) s.agentConfigs = [];
        if (s.agentPipeline === undefined) {
          const { DEFAULT_AGENT_PIPELINE } = await import('./types');
          s.agentPipeline = DEFAULT_AGENT_PIPELINE;
        }
        if (s.cacheStrategy === undefined) s.cacheStrategy = 'userid_isolated';
        if (s.maxSnapshotsPerSave === undefined) s.maxSnapshotsPerSave = 30;
        if (s.maxMemoriesRecall === undefined) s.maxMemoriesRecall = 10;
        await tx.table('settings').put(s);
      }
    });

    // v5: Phase 4 — 剧情大纲表 + Settings 扩展字段
    this.version(5).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
    }).upgrade(async tx => {
      // 迁移现有 settings — 添加 Phase 4 新字段
      const settings = await tx.table('settings').toCollection().toArray();
      for (const s of settings) {
        if (s.plotSettings === undefined) {
          const { DEFAULT_PLOT_SETTINGS } = await import('./types');
          s.plotSettings = DEFAULT_PLOT_SETTINGS;
        }
        if (s.embeddingEndpointId === undefined) s.embeddingEndpointId = null;
        if (s.embeddingModel === undefined) s.embeddingModel = 'Qwen/Qwen3-VL-Embedding-8B';
        if (s.embeddingDimension === undefined) s.embeddingDimension = 4096;
        if (s.memoryCompressionThreshold === undefined) s.memoryCompressionThreshold = 100;
        // Fix: maxMemoriesRecall 默认改为 20
        if (s.maxMemoriesRecall === undefined || s.maxMemoriesRecall === 10) s.maxMemoriesRecall = 20;
        await tx.table('settings').put(s);
      }
    });

    // v6: Phase 4.6 — SaveProfile 存档档案
    this.version(6).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
    });

    // v7: Phase 7d — 捏人预设表
    this.version(7).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
      createPresets: 'id, name, updatedAt',
    });
  }
}

let dbInstance: AppDatabase | null = null;

export function getDatabase(): AppDatabase {
  if (!dbInstance) {
    dbInstance = new AppDatabase();
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<void> {
  const db = getDatabase();

  const presetCount = await db.presets.count();
  if (presetCount === 0) {
    const { createDefaultPreset } = await import('./types');
    const defaultPreset = createDefaultPreset();
    await db.presets.add({
      ...defaultPreset,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as ChatPreset);
  }

  const settingsCount = await db.settings.count();
  if (settingsCount === 0) {
    await db.settings.put({ ...DEFAULT_SETTINGS, key: 'settings' });
  }
}

export async function clearAllData(): Promise<void> {
  const db = getDatabase();
  await db.delete();
  dbInstance = null;
}

// ========== Full Backup (v4) ==========

export interface FullBackup {
  version: number;
  exportedAt: number;
  lorebooks: Lorebook[];
  presets: ChatPreset[];
  settings: AppSettings[];
  chats: ChatSession[];
  // v4
  memories: MemoryRecord[];
  plotEvents: PlotEvent[];
  characters: CharacterState[];
  snapshots: Snapshot[];
  saves: SaveSlot[];
  apiEndpoints: ApiEndpoint[];
  // v5 Phase 4
  plotOutlines: PlotOutline[];
  // v6 Phase 4.6
  saveProfiles: SaveProfile[];
  // v7 Phase 7d
  createPresets: CreatePresetRecord[];
}

export async function exportAllData(): Promise<FullBackup> {
  const db = getDatabase();
  const [
    lorebooks, presets, settings, chats,
    memories, plotEvents, characters, snapshots, saves, apiEndpoints, plotOutlines, saveProfiles, createPresets,
  ] = await Promise.all([
    db.lorebooks.toArray(),
    db.presets.toArray(),
    db.settings.toArray(),
    db.chats.toArray(),
    db.memories.toArray(),
    db.plotEvents.toArray(),
    db.characters.toArray(),
    db.snapshots.toArray(),
    db.saves.toArray(),
    db.apiEndpoints.toArray(),
    db.plotOutlines.toArray(),
    db.saveProfiles.toArray(),
    db.createPresets.toArray(),
  ]);
  return {
    version: DB_VERSION,
    exportedAt: Date.now(),
    lorebooks, presets, settings, chats,
    memories, plotEvents, characters, snapshots, saves, apiEndpoints, plotOutlines, saveProfiles, createPresets,
  };
}

export async function importAllData(backup: FullBackup): Promise<void> {
  if (!backup || typeof backup !== 'object') {
    throw new Error('备份格式无效');
  }
  const db = getDatabase();

  // Split into 3 transactions — Dexie overload limit (~5 tables per call)
  await db.transaction('rw', db.lorebooks, db.presets, db.settings, db.chats, async () => {
    await db.lorebooks.clear();
    await db.presets.clear();
    await db.settings.clear();
    await db.chats.clear();
    if (Array.isArray(backup.lorebooks)) await db.lorebooks.bulkPut(backup.lorebooks);
    if (Array.isArray(backup.presets)) await db.presets.bulkPut(backup.presets);
    if (Array.isArray(backup.settings)) await db.settings.bulkPut(backup.settings);
    if (Array.isArray(backup.chats)) await db.chats.bulkPut(backup.chats);
  });

  await db.transaction('rw', db.memories, db.plotEvents, db.characters, async () => {
    await db.memories.clear();
    await db.plotEvents.clear();
    await db.characters.clear();
    if (Array.isArray(backup.memories)) await db.memories.bulkPut(backup.memories);
    if (Array.isArray(backup.plotEvents)) await db.plotEvents.bulkPut(backup.plotEvents);
    if (Array.isArray(backup.characters)) await db.characters.bulkPut(backup.characters);
  });

  await db.transaction('rw', db.snapshots, db.saves, db.apiEndpoints, async () => {
    await db.snapshots.clear();
    await db.saves.clear();
    await db.apiEndpoints.clear();
    if (Array.isArray(backup.snapshots)) await db.snapshots.bulkPut(backup.snapshots);
    if (Array.isArray(backup.saves)) await db.saves.bulkPut(backup.saves);
    if (Array.isArray(backup.apiEndpoints)) await db.apiEndpoints.bulkPut(backup.apiEndpoints);
  });

  await db.transaction('rw', db.plotOutlines, db.saveProfiles, async () => {
    await db.plotOutlines.clear();
    await db.saveProfiles.clear();
    if (Array.isArray(backup.plotOutlines)) await db.plotOutlines.bulkPut(backup.plotOutlines);
    if (Array.isArray(backup.saveProfiles)) await db.saveProfiles.bulkPut(backup.saveProfiles);
  });

  // v7 transaction
  await db.transaction('rw', db.createPresets, async () => {
    await db.createPresets.clear();
    if (Array.isArray(backup.createPresets)) await db.createPresets.bulkPut(backup.createPresets);
  });
}

// ========== v1-v3 CRUD (unchanged) ==========

export async function getLorebooks(): Promise<Lorebook[]> {
  return getDatabase().lorebooks.toArray();
}

export async function saveLorebook(lorebook: Lorebook): Promise<string> {
  await getDatabase().lorebooks.put(lorebook);
  return lorebook.id;
}

export async function deleteLorebook(id: string): Promise<void> {
  await getDatabase().lorebooks.delete(id);
}

export async function getPresets(): Promise<ChatPreset[]> {
  return getDatabase().presets.toArray();
}

export async function savePreset(preset: ChatPreset): Promise<string> {
  await getDatabase().presets.put(preset);
  return preset.id;
}

export async function deletePreset(id: string): Promise<void> {
  await getDatabase().presets.delete(id);
}

export async function getSettings(): Promise<AppSettings | undefined> {
  const all = await getDatabase().settings.toArray();
  return all[0];
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await getDatabase().settings.put({ ...settings, key: 'settings' });
}

export async function getChats(): Promise<ChatSession[]> {
  return getDatabase().chats.toArray();
}

export async function saveChat(chat: ChatSession): Promise<string> {
  await getDatabase().chats.put(chat);
  return chat.id;
}

export async function deleteChat(id: string): Promise<void> {
  await getDatabase().chats.delete(id);
}

export async function setVariables(chatId: string, variables: Record<string, any>): Promise<void> {
  const db = getDatabase();
  const chat = await db.chats.get(chatId);
  if (!chat) return;
  chat.variables = variables;
  chat.updatedAt = Date.now();
  await db.chats.put(chat);
}

// ========== v4 新表 CRUD ==========

// --- Memories ---

export async function getMemories(saveId: string): Promise<MemoryRecord[]> {
  return getDatabase().memories.where('saveId').equals(saveId).toArray();
}

export async function getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
  return getDatabase().memories.bulkGet(ids).then(arr => arr.filter(Boolean) as MemoryRecord[]);
}

export async function saveMemory(memory: MemoryRecord): Promise<string> {
  await getDatabase().memories.put(memory);
  return memory.id;
}

export async function deleteMemory(id: string): Promise<void> {
  await getDatabase().memories.delete(id);
}

export async function getRecentMemories(saveId: string, limit: number): Promise<MemoryRecord[]> {
  return getDatabase().memories
    .where('saveId').equals(saveId)
    .reverse()
    .sortBy('createdAt')
    .then(arr => arr.slice(0, limit));
}

// --- Plot Events ---

export async function getPlotEvents(saveId: string): Promise<PlotEvent[]> {
  return getDatabase().plotEvents.where('saveId').equals(saveId).toArray();
}

export async function getActivePlotEvents(saveId: string): Promise<PlotEvent[]> {
  return getDatabase().plotEvents
    .where('saveId').equals(saveId)
    .and(e => e.status === 'active')
    .toArray();
}

export async function savePlotEvent(event: PlotEvent): Promise<string> {
  event.updatedAt = Date.now();
  await getDatabase().plotEvents.put(event);
  return event.id;
}

export async function savePlotEvents(events: PlotEvent[]): Promise<void> {
  const now = Date.now();
  for (const e of events) e.updatedAt = now;
  await getDatabase().plotEvents.bulkPut(events);
}

export async function deletePlotEvent(id: string): Promise<void> {
  await getDatabase().plotEvents.delete(id);
}

// --- Characters ---

export async function getCharacters(saveId?: string): Promise<CharacterState[]> {
  if (saveId) {
    // Filter by saveId stored in customFields
    const all = await getDatabase().characters.toArray();
    return all.filter(c => c.customFields?.saveId === saveId);
  }
  return getDatabase().characters.toArray();
}

export async function getCharacter(id: string): Promise<CharacterState | undefined> {
  return getDatabase().characters.get(id);
}

export async function getCharactersByType(type: CharacterState['type']): Promise<CharacterState[]> {
  return getDatabase().characters.where('type').equals(type).toArray();
}

export async function saveCharacter(character: CharacterState): Promise<string> {
  await getDatabase().characters.put(character);
  return character.id;
}

export async function saveCharacters(characters: CharacterState[]): Promise<void> {
  await getDatabase().characters.bulkPut(characters);
}

export async function deleteCharacter(id: string): Promise<void> {
  await getDatabase().characters.delete(id);
}

// --- Snapshots ---

export async function getSnapshots(saveId: string): Promise<Snapshot[]> {
  return getDatabase().snapshots
    .where('saveId').equals(saveId)
    .sortBy('index');
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return getDatabase().snapshots.get(id);
}

export async function getLatestSnapshot(saveId: string): Promise<Snapshot | undefined> {
  const snapshots = await getDatabase().snapshots
    .where('saveId').equals(saveId)
    .reverse()
    .sortBy('index');
  return snapshots[0];
}

export async function saveSnapshot(snapshot: Snapshot): Promise<string> {
  await getDatabase().snapshots.put(snapshot);
  return snapshot.id;
}

export async function deleteSnapshot(id: string): Promise<void> {
  await getDatabase().snapshots.delete(id);
}

/** 删除超出上限的旧快照（保留最新的 maxCount 个） */
export async function trimSnapshots(saveId: string, maxCount: number): Promise<void> {
  const snapshots = await getDatabase().snapshots
    .where('saveId').equals(saveId)
    .reverse()
    .sortBy('index');
  if (snapshots.length > maxCount) {
    const toDelete = snapshots.slice(maxCount);
    await getDatabase().snapshots.bulkDelete(toDelete.map(s => s.id));
  }
}

// --- Saves ---

export async function getSaves(): Promise<SaveSlot[]> {
  return getDatabase().saves.orderBy('slot').toArray();
}

export async function getSave(id: string): Promise<SaveSlot | undefined> {
  return getDatabase().saves.get(id);
}

export async function getSaveBySlot(slot: number): Promise<SaveSlot | undefined> {
  return getDatabase().saves.where('slot').equals(slot).first();
}

export async function saveSaveSlot(saveSlot: SaveSlot): Promise<string> {
  saveSlot.updatedAt = Date.now();
  await getDatabase().saves.put(saveSlot);
  return saveSlot.id;
}

export async function deleteSaveSlot(id: string): Promise<void> {
  const db = getDatabase();
  // 级联删除关联数据
  const snapshots = await db.snapshots.where('saveId').equals(id).toArray();
  await db.snapshots.bulkDelete(snapshots.map(s => s.id));
  const memories = await db.memories.where('saveId').equals(id).toArray();
  await db.memories.bulkDelete(memories.map(m => m.id));
  const plotEvents = await db.plotEvents.where('saveId').equals(id).toArray();
  await db.plotEvents.bulkDelete(plotEvents.map(p => p.id));
  const plotOutlines = await db.plotOutlines.where('saveId').equals(id).toArray();
  await db.plotOutlines.bulkDelete(plotOutlines.map(o => o.id));
  await db.saveProfiles.where('saveId').equals(id).delete();
  await db.saves.delete(id);
}

// --- API Endpoints ---

export async function getApiEndpoints(): Promise<ApiEndpoint[]> {
  return getDatabase().apiEndpoints.toArray();
}

export async function getApiEndpoint(id: string): Promise<ApiEndpoint | undefined> {
  return getDatabase().apiEndpoints.get(id);
}

export async function saveApiEndpoint(endpoint: ApiEndpoint): Promise<string> {
  await getDatabase().apiEndpoints.put(endpoint);
  return endpoint.id;
}

export async function deleteApiEndpoint(id: string): Promise<void> {
  await getDatabase().apiEndpoints.delete(id);
}

// --- Plot Outlines (Phase 4) ---

export async function getPlotOutlines(saveId: string): Promise<PlotOutline[]> {
  return getDatabase().plotOutlines
    .where('saveId').equals(saveId)
    .sortBy('updatedAt');
}

export async function getPlotOutline(id: string): Promise<PlotOutline | undefined> {
  return getDatabase().plotOutlines.get(id);
}

export async function getLatestPlotOutline(saveId: string): Promise<PlotOutline | undefined> {
  const outlines = await getDatabase().plotOutlines
    .where('saveId').equals(saveId)
    .reverse()
    .sortBy('version');
  return outlines[0];
}

export async function savePlotOutline(outline: PlotOutline): Promise<string> {
  outline.updatedAt = Date.now();
  await getDatabase().plotOutlines.put(outline);
  return outline.id;
}

export async function deletePlotOutline(id: string): Promise<void> {
  await getDatabase().plotOutlines.delete(id);
}

// --- Save Profiles (Phase 4.6) ---

export async function getSaveProfile(saveId: string): Promise<SaveProfile | undefined> {
  return getDatabase().saveProfiles.get(saveId);
}

export async function saveSaveProfile(profile: SaveProfile): Promise<void> {
  profile.updatedAt = Date.now();
  await getDatabase().saveProfiles.put(profile);
}

export async function deleteSaveProfile(saveId: string): Promise<void> {
  await getDatabase().saveProfiles.delete(saveId);
}

export function createDefaultSaveProfile(saveId: string): SaveProfile {
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

// ═══════════════════════════════════════════════════════════
// Phase 7d — 捏人预设 CRUD
// ═══════════════════════════════════════════════════════════

export async function getCreatePresets(): Promise<CreatePresetRecord[]> {
  return getDatabase().createPresets.orderBy('updatedAt').reverse().toArray();
}

export async function getCreatePreset(id: string): Promise<CreatePresetRecord | undefined> {
  return getDatabase().createPresets.get(id);
}

export async function saveCreatePreset(preset: CreatePresetRecord): Promise<string> {
  return getDatabase().createPresets.put(preset);
}

export async function deleteCreatePreset(id: string): Promise<void> {
  await getDatabase().createPresets.delete(id);
}
