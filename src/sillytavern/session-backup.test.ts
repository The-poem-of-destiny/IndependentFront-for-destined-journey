/**
 * session-backup.ts — 单存档导出/导入测试
 *
 * Uses fake-indexeddb (injected via src/test-setup.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDatabase,
  initializeDatabase,
  clearAllData,
  createDefaultSaveProfile,
  deleteSaveSlot,
  characterAppearanceKey,
  exportAllData,
} from './database';
import type { ContentPackRecord } from './database';
import { createDefaultCharacterState } from './types';
import type {
  SaveSlot,
  SaveProfile,
  CharacterState,
  ChatMessage,
  Snapshot,
  MemoryRecord,
  PlotEvent,
  PlotOutline,
  WorldBook,
  WorkshopProject,
  ChatPreset,
} from './types';
import type { SceneImageRecord, CharacterSessionAppearance, ImagePreset } from './types-image';
import {
  isSessionBackup,
  isFullBackupFile,
  exportSessionSave,
  checkSessionSaveDependencies,
  importSessionSave,
} from './session-backup';
import type { SessionBackup } from './session-backup';

// ========== Helpers ==========

const SAVE_ID = 'save_session_test';
const PLAYER_ID = 'char_player';
const NPC_ID = 'char_npc';
const MSG_A = 'msg_a';
const MSG_B = 'msg_b';
const SNAP_ID = 'snap_1';
const PLOT_ROOT = 'plot_root';
const PLOT_CHILD = 'plot_child';

function makeWorldBook(overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: crypto.randomUUID(),
    name: '测试世界书',
    partition: 'system_core',
    entries: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** 世界书条目夹具；`workshop` 传了就写进 `extra.workshop`（跨机身份的来源） */
function makeEntry(
  uid: number,
  name: string,
  workshop?: { projectId: string; projectName: string; sourceUid: string | number },
): WorldBook['entries'][number] {
  return {
    uid,
    name,
    content: '正文',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 0,
    position: 0,
    ...(workshop
      ? {
          extra: {
            workshop: { ...workshop, sourceComment: name, sourceHash: 'hash' },
          },
        }
      : {}),
  };
}

function makeWorkshopProject(overrides: Partial<WorkshopProject> = {}): WorkshopProject {
  return {
    id: 'proj_uuid_1',
    rootProjectId: 'root_1',
    name: '测试工坊项目',
    description: '测试用二创项目',
    version: '2.0.0',
    authorName: '测试作者',
    tags: ['系统'],
    downloadUrl: 'https://example.invalid/pkg.json',
    fileSize: 1024,
    installState: 'installed',
    installedVersion: '1.5.0',
    installedAt: Date.now(),
    fetchedAt: Date.now(),
    uidRange: { start: 900000, end: 900999 },
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * 内容包夹具 —— 默认**拥有 `book_core`**，而存档启用了 `system_core:100`，
 * 于是它是「这份存档真的用到的包」（Finding 4 的判据①）。
 */
function makePackRecord(overrides: Partial<ContentPackRecord> = {}): ContentPackRecord {
  return {
    packId: 'test-pack',
    packVersion: '1.0.0',
    installedAt: Date.now(),
    payload: {
      formatVersion: 1,
      packId: 'test-pack',
      packVersion: '1.0.0',
      name: '测试内容包',
      worldBooks: [
        makeWorldBook({
          id: 'book_core',
          name: '核心设定',
          partition: 'system_core',
          entries: [makeEntry(100, '命定核心')],
        }),
      ],
    } as ContentPackRecord['payload'],
    ...overrides,
  };
}

function makeSceneImage(overrides: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'img_1',
    saveId: SAVE_ID,
    messageId: MSG_B,
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 2,
    status: 'done',
    source: 'auto',
    title: '雨中的桥',
    description: '主角站在石桥上',
    intent: '主角站在石桥上，雨水打湿了斗篷',
    scenePrompt: '1boy, bridge, rain',
    sceneNegative: '',
    characters: ['莱恩'],
    rating: 'general',
    positive: '1boy, bridge, rain, masterpiece',
    negative: 'lowres',
    model: 'test-model',
    seed: 12345,
    params: {},
    mime: 'image/png',
    bytes: 2048,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * 播一个「能玩」的最小存档：saves + saveProfile + characters + messages +
 * snapshots（内嵌副本齐全）+ memories + plotEvents + plotOutlines +
 * sceneImages（含字节行）+ characterAppearances。
 *
 * 内部引用刻意都埋上：activeSnapshotId / sceneImages.messageId /
 * plotEvent.parentId+childrenIds / memory.relatedCharacterIds。
 */
async function seedSave(): Promise<void> {
  const db = getDatabase();

  const player: CharacterState = createDefaultCharacterState({
    id: PLAYER_ID,
    saveId: SAVE_ID,
    type: 'player',
    name: '莱恩',
  });
  const npc: CharacterState = createDefaultCharacterState({
    id: NPC_ID,
    saveId: SAVE_ID,
    type: 'npc',
    name: '莉薇娅',
  });

  const messages: ChatMessage[] = [
    {
      id: MSG_A,
      role: 'user',
      content: '我走上石桥',
      timestamp: Date.now(),
      saveId: SAVE_ID,
      turn: 1,
    },
    {
      id: MSG_B,
      role: 'assistant',
      content: '雨水打湿了你的斗篷。',
      timestamp: Date.now(),
      saveId: SAVE_ID,
      turn: 2,
    },
  ];

  const profile: SaveProfile = {
    ...createDefaultSaveProfile(SAVE_ID),
    affections: { 莉薇娅: 45 },
    contracts: [
      {
        id: 'contract_1',
        targetId: NPC_ID,
        targetName: '莉薇娅',
        tier: 1,
        fpSpent: 50,
        affectionLevel: '友好',
        createdAt: Date.now(),
      },
    ],
  };

  const plotRoot: PlotEvent = {
    id: PLOT_ROOT,
    saveId: SAVE_ID,
    title: '商队失踪',
    description: '一支商队消失在森林里',
    status: 'active',
    childrenIds: [PLOT_CHILD],
    order: 0,
    relatedCharacterIds: [PLAYER_ID, '莉薇娅'],
    worldLineChanged: false,
    visibility: 'revealed',
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const plotChild: PlotEvent = {
    ...plotRoot,
    id: PLOT_CHILD,
    title: '搜索森林',
    childrenIds: [],
    parentId: PLOT_ROOT,
    relatedCharacterIds: [NPC_ID],
    depth: 1,
  };

  const snapshot: Snapshot = {
    id: SNAP_ID,
    saveId: SAVE_ID,
    createdAt: Date.now(),
    reason: 'turn',
    turn: 2,
    characters: [structuredClone(player), structuredClone(npc)],
    saveProfile: structuredClone(profile),
    plotEvents: [structuredClone(plotRoot), structuredClone(plotChild)],
    messages: structuredClone(messages),
  };

  const save: SaveSlot = {
    id: SAVE_ID,
    name: '测试冒险',
    slot: 3,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    activeSnapshotId: SNAP_ID,
    metadata: {
      characterName: '莱恩',
      userName: '玩家',
      gameStartTime: '001-01-01',
      totalTurns: 2,
      enabledWorldBookEntries: ['system_core:100', 'creative_workshop:900001', 'dlc:777'],
    },
  };

  const memory: MemoryRecord = {
    id: 'MEM000001',
    saveId: SAVE_ID,
    createdAt: Date.now(),
    realTimestamp: Date.now(),
    timeRange: { start: '001-01-01', end: '001-01-02' },
    content: '莱恩在酒馆听说了商队失踪的消息。'.repeat(8),
    hiddenLine: '蒙面人是盗贼团的眼线',
    keywords: ['商队'],
    relatedCharacterIds: [PLAYER_ID, '莉薇娅'],
    importance: 7,
  };

  const outline: PlotOutline = {
    id: 'outline_1',
    saveId: SAVE_ID,
    mode: 'main',
    title: '血色纹章',
    summary: '边境的阴谋逐渐浮出水面',
    content: '大纲正文',
    chapters: [{ title: '商队失踪', summary: '起点', status: 'active' }],
    confirmed: true,
    version: 1,
    timeRange: { start: '001-01-01', end: '001-02-01' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const appearance: CharacterSessionAppearance = {
    key: characterAppearanceKey(SAVE_ID, '莉薇娅'),
    saveId: SAVE_ID,
    name: '莉薇娅',
    patch: { outfit: '沾着麦粉的皮革围裙' } as CharacterSessionAppearance['patch'],
    updatedAt: Date.now(),
  };

  await db.saves.put(save);
  await db.saveProfiles.put(profile);
  await db.characters.bulkPut([player, npc]);
  await db.messages.bulkPut(messages);
  await db.snapshots.put(snapshot);
  await db.memories.put(memory);
  await db.plotEvents.bulkPut([plotRoot, plotChild]);
  await db.plotOutlines.put(outline);
  await db.sceneImages.put(makeSceneImage());
  await db.sceneImageBlobs.put({ id: 'img_1', blob: new Blob(['x']) });
  await db.characterAppearances.put(appearance);
}

/** 播内容侧：世界书条目 / 工坊项目 / 内容包 / story 预设 */
async function seedContent(): Promise<void> {
  const db = getDatabase();
  await db.worldBooks.bulkPut([
    makeWorldBook({
      id: 'book_core',
      name: '核心设定',
      partition: 'system_core',
      entries: [makeEntry(100, '命定核心')],
    }),
    makeWorldBook({
      id: 'book_workshop',
      name: '测试工坊项目',
      partition: 'creative_workshop',
      entries: [
        makeEntry(900001, '二创条目', {
          projectId: 'proj_uuid_1',
          projectName: '测试工坊项目',
          sourceUid: 1,
        }),
      ],
    }),
    makeWorldBook({
      id: 'book_dlc',
      name: '扩展内容',
      partition: 'dlc',
      entries: [makeEntry(777, '隐藏副本')],
    }),
  ]);
  await db.workshopProjects.put(makeWorkshopProject());
  await db.contentPacks.put(makePackRecord());
  await db.presets.put({
    id: 'preset_story',
    name: '叙事预设',
    settings: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ChatPreset);
}

const STORY_PRESET = { id: 'preset_story', name: '叙事预设' };

// ========== Setup & Teardown ==========

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* db may not exist yet */
  }
  await initializeDatabase();
});

// ========== isSessionBackup ==========

describe('isSessionBackup', () => {
  it('按 kind 分流：只认单存档备份', () => {
    expect(isSessionBackup({ kind: 'fated-poem-session-save' })).toBe(true);
    expect(isSessionBackup({ version: 21, saves: [] })).toBe(false);
    expect(isSessionBackup(null)).toBe(false);
    expect(isSessionBackup('fated-poem-session-save')).toBe(false);
    expect(isSessionBackup([{ kind: 'fated-poem-session-save' }])).toBe(false);
  });
});

// ========== 导出 ==========

describe('exportSessionSave', () => {
  it('存档不存在时抛中文错误', async () => {
    await expect(exportSessionSave('no_such_save')).rejects.toThrow(/存档不存在/);
  });

  it('收齐每存档的行，字节不随行', async () => {
    await seedSave();
    await seedContent();

    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });

    expect(backup.kind).toBe('fated-poem-session-save');
    expect(Number.isFinite(backup.version)).toBe(true);
    expect(backup.save.id).toBe(SAVE_ID);
    expect(backup.profile?.saveId).toBe(SAVE_ID);
    expect(backup.characters).toHaveLength(2);
    expect(backup.messages).toHaveLength(2);
    expect(backup.snapshots).toHaveLength(1);
    expect(backup.memories).toHaveLength(1);
    expect(backup.plotEvents).toHaveLength(2);
    expect(backup.plotOutlines).toHaveLength(1);
    expect(backup.sceneImages).toHaveLength(1);
    expect(backup.characterAppearances).toHaveLength(1);
    // 字节表没有对应字段 —— 图片字节走独立路径，不进 JSON
    expect(Object.keys(backup)).not.toContain('sceneImageBlobs');
  });

  it('导出的插画副本打上 blobDropped，库里的行一个字节不动', async () => {
    await seedSave();

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.sceneImages[0].blobDropped).toBe(true);

    const live = await getDatabase().sceneImages.get('img_1');
    expect(live?.blobDropped).toBeUndefined();
    expect(await getDatabase().sceneImageBlobs.get('img_1')).toBeDefined();
  });

  it('依赖清单：世界书条目带书名/条目名注释，解析不出的 token 照样进清单', async () => {
    await seedSave();
    await seedContent();
    // 把 dlc:777 那本删掉 —— 导出方自己都缺的条目不该被藏起来
    await getDatabase().worldBooks.delete('book_dlc');

    const backup = await exportSessionSave(SAVE_ID);
    const entries = backup.dependencies.worldBookEntries;

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      token: 'system_core:100',
      bookName: '核心设定',
      entryTitle: '命定核心',
    });
    expect(entries[2]).toEqual({ token: 'dlc:777' });
  });

  it('依赖清单：工坊项目走条目溯源，版本取 installedVersion', async () => {
    await seedSave();
    await seedContent();

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.workshopProjects).toEqual([
      { id: 'proj_uuid_1', name: '测试工坊项目', version: '1.5.0' },
    ]);
  });

  it('依赖清单：条目无溯源时回退 uidRange 匹配', async () => {
    await seedSave();
    await seedContent();
    const db = getDatabase();
    const book = await db.worldBooks.get('book_workshop');
    book!.entries[0].extra = undefined;
    await db.worldBooks.put(book!);

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.workshopProjects.map((p) => p.id)).toEqual(['proj_uuid_1']);
  });

  it('依赖清单：内容包与 story 预设原样收录', async () => {
    await seedSave();
    await seedContent();

    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });
    expect(backup.dependencies.packs).toEqual([
      { packId: 'test-pack', packVersion: '1.0.0', name: '测试内容包' },
    ]);
    expect(backup.dependencies.storyPreset).toEqual(STORY_PRESET);
  });

  it('依赖清单：这份存档没用到的包不进清单（否则收件人被无关告警淹掉）', async () => {
    await seedSave();
    await seedContent();
    // 装着、但它的书一条都没被本存档启用，也没带地图
    await getDatabase().contentPacks.put(
      makePackRecord({
        packId: 'other-pack',
        payload: {
          formatVersion: 1,
          packId: 'other-pack',
          packVersion: '1.0.0',
          name: '无关内容包',
          worldBooks: [
            makeWorldBook({
              id: 'book_other',
              partition: 'dlc',
              entries: [makeEntry(555, '没启用的条目')],
            }),
          ],
        } as ContentPackRecord['payload'],
      }),
    );

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.packs.map((p) => p.packId)).toEqual(['test-pack']);
  });

  it('依赖清单：地图包按 packStamp 认（存档确实在这张地图上落过位）', async () => {
    await seedSave();
    const db = getDatabase();
    // 只装一个「没有任何启用条目」的地图包 —— 唯一的联系是存档档案里的戳
    await db.contentPacks.put(
      makePackRecord({
        packId: 'map-pack',
        payload: {
          formatVersion: 1,
          packId: 'map-pack',
          packVersion: '1.0.0',
          name: '地图包',
          mapPack: { contentHash: 'hash-map-v1' },
        } as ContentPackRecord['payload'],
      }),
    );

    const profile = (await db.saveProfiles.get(SAVE_ID))!;
    profile.worldFlags = { map: { packStamp: 'hash-map-v1' } };
    await db.saveProfiles.put(profile);

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.packs.map((p) => p.packId)).toEqual(['map-pack']);

    // 戳对不上就不算用到
    profile.worldFlags = { map: { packStamp: 'hash-map-v2' } };
    await db.saveProfiles.put(profile);
    expect((await exportSessionSave(SAVE_ID)).dependencies.packs).toEqual([]);
  });

  it('不传 storyPreset 时清单里就没有这一项（引擎不去猜全局 UI 状态）', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.storyPreset).toBeUndefined();
  });
});

// ========== 导入往返 ==========

describe('importSessionSave — 往返', () => {
  it('全部行落到新 saveId 下，数量一致', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });

    const { saveId: newId } = await importSessionSave(backup);
    expect(newId).not.toBe(SAVE_ID);

    const db = getDatabase();
    expect(await db.saves.count()).toBe(2);
    expect((await db.characters.where('saveId').equals(newId).toArray()).length).toBe(2);
    expect((await db.messages.where('saveId').equals(newId).toArray()).length).toBe(2);
    expect((await db.snapshots.where('saveId').equals(newId).toArray()).length).toBe(1);
    expect((await db.memories.where('saveId').equals(newId).toArray()).length).toBe(1);
    expect((await db.plotEvents.where('saveId').equals(newId).toArray()).length).toBe(2);
    expect((await db.plotOutlines.where('saveId').equals(newId).toArray()).length).toBe(1);
    expect((await db.sceneImages.where('saveId').equals(newId).toArray()).length).toBe(1);
    expect((await db.characterAppearances.where('saveId').equals(newId).toArray()).length).toBe(1);
    expect((await db.saveProfiles.get(newId))?.saveId).toBe(newId);
  });

  it('内部引用指向重发后的行', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const { saveId: newId } = await importSessionSave(backup);
    const db = getDatabase();

    const save = await db.saves.get(newId);
    const snaps = await db.snapshots.where('saveId').equals(newId).toArray();
    expect(snaps).toHaveLength(1);
    expect(save?.activeSnapshotId).toBe(snaps[0].id);
    expect(save?.activeSnapshotId).not.toBe(SNAP_ID);

    const msgs = await db.messages.where('saveId').equals(newId).toArray();
    const imgs = await db.sceneImages.where('saveId').equals(newId).toArray();
    const targetMsg = msgs.find((m) => m.role === 'assistant');
    expect(imgs[0].messageId).toBe(targetMsg?.id);
    expect(imgs[0].messageId).not.toBe(MSG_B);

    // 剧情父子链跟着一起搬
    const events = await db.plotEvents.where('saveId').equals(newId).toArray();
    const root = events.find((e) => e.title === '商队失踪')!;
    const child = events.find((e) => e.title === '搜索森林')!;
    expect(child.parentId).toBe(root.id);
    expect(root.childrenIds).toEqual([child.id]);
    expect(root.id).not.toBe(PLOT_ROOT);

    // 会话外貌主键重拼
    const appearances = await db.characterAppearances.where('saveId').equals(newId).toArray();
    expect(appearances[0].key).toBe(characterAppearanceKey(newId, '莉薇娅'));
  });

  it('快照内嵌副本用同一套映射改写（回退时才不会把旧 id 复活回库）', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const { saveId: newId } = await importSessionSave(backup);
    const db = getDatabase();

    const snap = (await db.snapshots.where('saveId').equals(newId).toArray())[0];
    const chars = await db.characters.where('saveId').equals(newId).toArray();
    const msgs = await db.messages.where('saveId').equals(newId).toArray();
    const events = await db.plotEvents.where('saveId').equals(newId).toArray();

    expect(new Set(snap.characters.map((c) => c.id))).toEqual(new Set(chars.map((c) => c.id)));
    expect(new Set(snap.messages?.map((m) => m.id))).toEqual(new Set(msgs.map((m) => m.id)));
    expect(new Set(snap.plotEvents?.map((e) => e.id))).toEqual(new Set(events.map((e) => e.id)));
    // 内嵌副本的 saveId 也得改，否则回退写回库之后行归属错乱
    expect(snap.saveProfile.saveId).toBe(newId);
    expect(snap.characters.every((c) => c.saveId === newId)).toBe(true);
    expect(snap.plotEvents?.every((e) => e.saveId === newId)).toBe(true);
    expect(snap.messages?.every((m) => m.saveId === newId)).toBe(true);
  });

  it('软引用：角色 id 跟着改，名字/契约目标各按其义', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const { saveId: newId } = await importSessionSave(backup);
    const db = getDatabase();

    const chars = await db.characters.where('saveId').equals(newId).toArray();
    const player = chars.find((c) => c.type === 'player')!;
    const npc = chars.find((c) => c.type === 'npc')!;

    const memory = (await db.memories.where('saveId').equals(newId).toArray())[0];
    expect(memory.relatedCharacterIds).toContain(player.id);
    // 名字不是 id —— 查不到就原样留着，绝不能被改写成 UUID
    expect(memory.relatedCharacterIds).toContain('莉薇娅');

    const profile = await db.saveProfiles.get(newId);
    expect(profile?.contracts[0].targetId).toBe(npc.id);
    // affections 的键是名字（铁律 1），刻意不动
    expect(profile?.affections['莉薇娅']).toBe(45);
  });

  it('槽位取现有最大 +1；createdAt/metadata 保留，updatedAt 盖新戳', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const before = Date.now();
    const { saveId: newId } = await importSessionSave(backup);

    const save = await getDatabase().saves.get(newId);
    expect(save?.slot).toBe(4); // 原档 slot=3
    expect(save?.createdAt).toBe(backup.save.createdAt);
    expect(save?.name).toBe('测试冒险');
    expect(save?.metadata.enabledWorldBookEntries).toEqual(
      backup.save.metadata.enabledWorldBookEntries,
    );
    expect(save?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('记忆编号保留 MEM 格式且不与全库现有编号相撞', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const { saveId: newId } = await importSessionSave(backup);

    const memory = (await getDatabase().memories.where('saveId').equals(newId).toArray())[0];
    expect(memory.id).toMatch(/^MEM\d{6}$/);
    expect(memory.id).not.toBe('MEM000001');
    expect(await getDatabase().memories.count()).toBe(2);
  });

  it('备份可以导进一个空库（原档已删也照样还原）', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    await deleteSaveSlot(SAVE_ID);
    expect(await getDatabase().saves.count()).toBe(0);

    const { saveId: newId } = await importSessionSave(backup);
    const db = getDatabase();
    expect(await db.saves.count()).toBe(1);
    expect((await db.characters.where('saveId').equals(newId).toArray()).length).toBe(2);
    expect((await db.saves.get(newId))?.slot).toBe(0);
  });
});

// ========== 双份导入 ==========

describe('importSessionSave — 同一份文件导两次', () => {
  it('得到两个互不相干的存档，行 id 无交集', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);

    const first = await importSessionSave(backup);
    const second = await importSessionSave(backup);
    expect(first.saveId).not.toBe(second.saveId);

    const db = getDatabase();
    expect(await db.saves.count()).toBe(3); // 原档 + 两份导入

    const idsOf = async (saveId: string) => ({
      chars: (await db.characters.where('saveId').equals(saveId).toArray()).map((r) => r.id),
      msgs: (await db.messages.where('saveId').equals(saveId).toArray()).map((r) => r.id),
      snaps: (await db.snapshots.where('saveId').equals(saveId).toArray()).map((r) => r.id),
      mems: (await db.memories.where('saveId').equals(saveId).toArray()).map((r) => r.id),
      plots: (await db.plotEvents.where('saveId').equals(saveId).toArray()).map((r) => r.id),
      imgs: (await db.sceneImages.where('saveId').equals(saveId).toArray()).map((r) => r.id),
    });

    const a = await idsOf(first.saveId);
    const b = await idsOf(second.saveId);
    for (const key of Object.keys(a) as Array<keyof typeof a>) {
      expect(a[key].length).toBeGreaterThan(0);
      expect(a[key].length).toBe(b[key].length);
      const overlap = a[key].filter((id) => b[key].includes(id));
      expect(overlap).toEqual([]);
    }

    // 原档的行一条没被覆盖
    expect((await db.characters.where('saveId').equals(SAVE_ID).toArray()).length).toBe(2);
  });

  it('删掉其中一份，另一份完好', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const first = await importSessionSave(backup);
    const second = await importSessionSave(backup);

    await deleteSaveSlot(first.saveId);

    const db = getDatabase();
    expect(await db.saves.get(first.saveId)).toBeUndefined();
    expect(await db.saves.get(second.saveId)).toBeDefined();
    expect((await db.characters.where('saveId').equals(second.saveId).toArray()).length).toBe(2);
    expect((await db.messages.where('saveId').equals(second.saveId).toArray()).length).toBe(2);
    expect((await db.snapshots.where('saveId').equals(second.saveId).toArray()).length).toBe(1);
    expect((await db.sceneImages.where('saveId').equals(second.saveId).toArray()).length).toBe(1);
    expect(
      (await db.characterAppearances.where('saveId').equals(second.saveId).toArray()).length,
    ).toBe(1);
  });
});

// ========== 依赖体检 ==========

describe('checkSessionSaveDependencies', () => {
  it('内容齐全 → ok:true', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });

    const check = await checkSessionSaveDependencies(backup);
    expect(check).toEqual({
      ok: true,
      missingEntries: [],
      packMismatches: [],
    });
  });

  it('世界书条目缺失 → missingEntries 带上导出侧的注释', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID);

    await getDatabase().worldBooks.delete('book_dlc');

    const check = await checkSessionSaveDependencies(backup);
    expect(check.ok).toBe(false);
    expect(check.missingEntries).toEqual([
      { token: 'dlc:777', bookName: '扩展内容', entryTitle: '隐藏副本' },
    ]);
  });

  it('内容包版本不一致 / 压根没装 → packMismatches', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID);
    const db = getDatabase();

    await db.contentPacks.put(makePackRecord({ packVersion: '2.0.0' }));
    let check = await checkSessionSaveDependencies(backup);
    expect(check.ok).toBe(false);
    expect(check.packMismatches).toEqual([
      {
        packId: 'test-pack',
        name: '测试内容包',
        expectedVersion: '1.0.0',
        installedVersion: '2.0.0',
      },
    ]);

    await db.contentPacks.delete('test-pack');
    check = await checkSessionSaveDependencies(backup);
    expect(check.packMismatches).toEqual([
      {
        packId: 'test-pack',
        name: '测试内容包',
        expectedVersion: '1.0.0',
        installedVersion: null,
      },
    ]);
  });

  it('story 预设缺失 → missingStoryPreset', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });

    await getDatabase().presets.delete('preset_story');

    const check = await checkSessionSaveDependencies(backup);
    expect(check.ok).toBe(false);
    expect(check.missingStoryPreset).toEqual(STORY_PRESET);
  });

  it('只读：体检不写任何一张表', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });
    const db = getDatabase();
    await db.worldBooks.delete('book_dlc');

    const before = await db.saves.count();
    await checkSessionSaveDependencies(backup);
    expect(await db.saves.count()).toBe(before);
    expect(await db.worldBooks.count()).toBe(2);
    expect(await db.presets.get('preset_story')).toBeDefined();
  });

  it('清单缺失（手编文件）时不炸，按「无依赖」处理', async () => {
    const bare = { kind: 'fated-poem-session-save' } as unknown as SessionBackup;
    const check = await checkSessionSaveDependencies(bare);
    expect(check.ok).toBe(true);
    expect(check.missingEntries).toEqual([]);
  });
});

// ========== 工坊条目跨机身份（Finding 1/2）==========
//
// 工坊 uid 由**本机分区级单调游标**发号，同一个项目在另一台机器上按不同安装顺序
// 拿到的 uid 完全不同。裸 token 比对的两种败法都不报错：假通过（uid 撞上别的项目）
// 与假缺失（同项目不同号）。这一组把两种都钉住。

describe('工坊条目按身份而非 uid 比对', () => {
  /** 把收件人库里的工坊书换成「同一项目、不同本机 uid」 */
  async function reinstallWorkshopAt(uid: number, projectId = 'proj_uuid_1'): Promise<void> {
    await getDatabase().worldBooks.put(
      makeWorldBook({
        id: 'book_workshop',
        name: '测试工坊项目',
        partition: 'creative_workshop',
        entries: [
          makeEntry(uid, '二创条目', { projectId, projectName: '测试工坊项目', sourceUid: 1 }),
        ],
      }),
    );
  }

  it('导出清单给工坊条目带上跨机身份（项目 id + 上游 uid）', async () => {
    await seedSave();
    await seedContent();

    const backup = await exportSessionSave(SAVE_ID);
    const workshopRef = backup.dependencies.worldBookEntries.find((e) =>
      e.token.startsWith('creative_workshop:'),
    )!;
    expect(workshopRef.workshopProjectId).toBe('proj_uuid_1');
    expect(workshopRef.workshopSourceUid).toBe(1);
    // 非工坊条目不带身份（那些 uid 是内容仓固定编号，本来就跨机稳定）
    const coreRef = backup.dependencies.worldBookEntries.find(
      (e) => e.token === 'system_core:100',
    )!;
    expect(coreRef.workshopProjectId).toBeUndefined();
  });

  it('(a) 同项目、收件人本机 uid 不同 → 不报缺失，且导入时 token 被改写成本机 uid', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID);

    // 收件人那边这个项目装在 900500（安装顺序不同），而备份里写的是 900001
    await reinstallWorkshopAt(900500);

    const check = await checkSessionSaveDependencies(backup);
    expect(check.missingEntries).toEqual([]);
    expect(check.ok).toBe(true);

    const { saveId } = await importSessionSave(backup);
    const tokens = (await getDatabase().saves.get(saveId))!.metadata.enabledWorldBookEntries!;
    expect(tokens).toContain('creative_workshop:900500');
    expect(tokens).not.toContain('creative_workshop:900001');
    // 非工坊 token 一个字节不动
    expect(tokens).toContain('system_core:100');
    expect(tokens).toContain('dlc:777');
  });

  it('(b) 同一个 uid 被**另一个项目**占着 → 照报缺失（裸 token 比对会在这里假通过）', async () => {
    await seedSave();
    await seedContent();
    const backup = await exportSessionSave(SAVE_ID);

    await reinstallWorkshopAt(900001, 'proj_uuid_OTHER');

    const check = await checkSessionSaveDependencies(backup);
    expect(check.ok).toBe(false);
    expect(check.missingEntries.map((e) => e.token)).toEqual(['creative_workshop:900001']);

    // 导入不去硬凑：认不出身份就原样留着，绝不指向别的项目的条目
    const { saveId } = await importSessionSave(backup);
    const tokens = (await getDatabase().saves.get(saveId))!.metadata.enabledWorldBookEntries!;
    expect(tokens).toContain('creative_workshop:900001');
  });

  it('(c) 清单项没有身份（老备份 / 手工条目）→ 退回裸 token 比对', async () => {
    await seedSave();
    await seedContent();
    // 导出**之前**抹掉溯源 → 清单里这一条不带身份
    const db = getDatabase();
    const book = (await db.worldBooks.get('book_workshop'))!;
    book.entries[0].extra = undefined;
    await db.worldBooks.put(book);

    const backup = await exportSessionSave(SAVE_ID);
    expect(backup.dependencies.worldBookEntries.every((e) => !e.workshopProjectId)).toBe(true);

    // token 还在 → 齐全
    expect((await checkSessionSaveDependencies(backup)).ok).toBe(true);

    // token 换个号 → 报缺失（没有身份可依，只能按号比）
    await reinstallWorkshopAt(900500);
    const book2 = (await db.worldBooks.get('book_workshop'))!;
    book2.entries[0].extra = undefined;
    await db.worldBooks.put(book2);
    const check = await checkSessionSaveDependencies(backup);
    expect(check.missingEntries.map((e) => e.token)).toEqual(['creative_workshop:900001']);
  });
});

// ========== 整库备份文件识别（Finding 3）==========

describe('isFullBackupFile', () => {
  it('只有一个数字 version 的 JSON 不算整库备份（角色卡/预设全长这样）', () => {
    expect(isFullBackupFile({ version: 2, name: '某角色', description: 'x' })).toBe(false);
    expect(isFullBackupFile({ spec: 'chara_card_v2', spec_version: '2.0', data: {} })).toBe(false);
    expect(isFullBackupFile(null)).toBe(false);
    expect(isFullBackupFile([])).toBe(false);
    expect(isFullBackupFile({ version: 'v21', saves: [] })).toBe(false);
  });

  it('真的整库备份 → true', async () => {
    const backup = await exportAllData();
    expect(isFullBackupFile(backup)).toBe(true);
    // 只要有一条签名数组在场就认（老备份缺后加的表是正常的）
    expect(isFullBackupFile({ version: 21, saves: [] })).toBe(true);
  });

  it('单存档备份不算整库备份（两条导入路径必须分得开）', async () => {
    await seedSave();
    const session = await exportSessionSave(SAVE_ID);
    expect(isFullBackupFile(session)).toBe(false);
    expect(isSessionBackup(session)).toBe(true);
  });
});

// ========== 导入校验 ==========

describe('importSessionSave — 校验', () => {
  const bad = (payload: unknown) => importSessionSave(payload as SessionBackup);

  it('null / 非对象 → 中文错误', async () => {
    await expect(bad(null)).rejects.toThrow(/备份格式无效/);
    await expect(bad('x')).rejects.toThrow(/备份格式无效/);
  });

  it('kind 不匹配 → 中文错误（别把整库备份当单存档导）', async () => {
    await expect(bad({ version: 21, save: {} })).rejects.toThrow(/备份格式无效/);
  });

  it('version 非有限数 → 中文错误', async () => {
    await expect(
      bad({ kind: 'fated-poem-session-save', version: 'v21', save: {} }),
    ).rejects.toThrow(/version/);
  });

  it('缺 save 主记录 → 中文错误', async () => {
    await expect(bad({ kind: 'fated-poem-session-save', version: 21 })).rejects.toThrow(/save/);
  });

  it('数组字段「在但不是数组」→ 中文错误', async () => {
    await expect(
      bad({
        kind: 'fated-poem-session-save',
        version: 21,
        save: { id: 'x', metadata: {} },
        characters: { nope: true },
      }),
    ).rejects.toThrow(/characters 必须是数组/);
  });

  it('数组字段缺席 → 当空数组容忍（三态语义，同 FullBackup）', async () => {
    const { saveId } = await bad({
      kind: 'fated-poem-session-save',
      version: 21,
      save: {
        id: 'legacy',
        name: '残缺档',
        slot: 0,
        createdAt: 1,
        updatedAt: 1,
        activeSnapshotId: null,
        metadata: { characterName: 'A', userName: 'B', gameStartTime: 'c', totalTurns: 0 },
      },
      profile: null,
    });

    const db = getDatabase();
    expect((await db.saves.get(saveId))?.name).toBe('残缺档');
    expect(await db.characters.count()).toBe(0);
    expect(await db.saveProfiles.count()).toBe(0);
  });

  it('activeSnapshotId 指向备份里没有的快照 → 置 null', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    backup.snapshots = [];

    const { saveId } = await importSessionSave(backup);
    expect((await getDatabase().saves.get(saveId))?.activeSnapshotId).toBeNull();
  });
});

// ========== 全局表不受影响 ==========

describe('importSessionSave — 不碰全局表', () => {
  it('worldBooks / presets / imagePresets / contentPacks 行数与内容不变', async () => {
    await seedSave();
    await seedContent();
    const db = getDatabase();
    const imagePreset: ImagePreset = {
      key: 'character:莉薇娅',
      kind: 'character',
      name: '莉薇娅',
      dialects: { danbooru: { positive: 'elf', negative: '' } },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.imagePresets.put(imagePreset);

    const backup = await exportSessionSave(SAVE_ID, { storyPreset: STORY_PRESET });
    const before = {
      worldBooks: await db.worldBooks.count(),
      presets: await db.presets.count(),
      imagePresets: await db.imagePresets.count(),
      contentPacks: await db.contentPacks.count(),
      workshopProjects: await db.workshopProjects.count(),
    };

    await importSessionSave(backup);

    expect({
      worldBooks: await db.worldBooks.count(),
      presets: await db.presets.count(),
      imagePresets: await db.imagePresets.count(),
      contentPacks: await db.contentPacks.count(),
      workshopProjects: await db.workshopProjects.count(),
    }).toEqual(before);
    expect((await db.imagePresets.get('character:莉薇娅'))?.dialects.danbooru?.positive).toBe(
      'elf',
    );
  });

  it('插画字节表不随导入产生新行（备份里本就没有字节）', async () => {
    await seedSave();
    const backup = await exportSessionSave(SAVE_ID);
    const before = await getDatabase().sceneImageBlobs.count();

    const { saveId } = await importSessionSave(backup);

    expect(await getDatabase().sceneImageBlobs.count()).toBe(before);
    const imgs = await getDatabase().sceneImages.where('saveId').equals(saveId).toArray();
    // 记录还在、配方齐全，只是字节已清理 —— 图鉴显示「重画」而不是坏图
    expect(imgs[0].blobDropped).toBe(true);
    expect(imgs[0].status).toBe('done');
    expect(imgs[0].scenePrompt).toBe('1boy, bridge, rain');
  });
});
