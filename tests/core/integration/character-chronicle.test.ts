import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  createDefaultSaveProfile,
  deleteSaveSlot,
  exportAllData,
  getDatabase,
  importAllData,
  initializeDatabase,
} from '../../../src/core/persistence/database';
import { exportSessionSave, importSessionSave } from '../../../src/core/persistence/session-backup';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { ChatMessage, SaveSlot } from '../../../src/core/types/types';
import { createStateManager } from '../../../src/core/state/state-manager';
import {
  storyMemorySourceMatches,
  storyTurnSource,
} from '../../../src/core/memory/story-memory-source';
import { collectCompleteStoryTurns } from '../../../src/core/memory/memory-context';
import type { CharacterNarrativeUpdate } from '../../../src/core/types/types-character';

let db: ReturnType<typeof getDatabase>;
const save: SaveSlot = {
  id: 's1',
  name: '测试旅程',
  slot: 0,
  createdAt: 1,
  updatedAt: 1,
  activeSnapshotId: null,
  metadata: { characterName: '旅人', userName: '玩家', gameStartTime: '', totalTurns: 0 },
};
const messages: ChatMessage[] = [
  {
    id: 'u1',
    saveId: 's1',
    role: 'user',
    content: '邀请同行',
    timestamp: 1,
    storyTurnStatus: 'accepted',
    storyTurnKey: 'u1',
  },
  {
    id: 'a1',
    saveId: 's1',
    role: 'assistant',
    content: '向导答应与你同行。',
    timestamp: 2,
    storyTurnStatus: 'accepted',
    storyTurnKey: 'u1',
  },
];
const source = storyTurnSource(collectCompleteStoryTurns(messages)[0]);
const update: CharacterNarrativeUpdate = {
  name: '向导',
  profile_changes: { goals: '一同前往渡口' },
  chronicle: [
    { title: '同行之约', summary: '答应与你同行。', time: { kind: 'this_turn' }, importance: 9 },
    {
      title: '离乡',
      summary: '曾离开河谷。',
      time: { kind: 'past', label: '多年前' },
      importance: 8,
    },
  ],
};

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
  db = getDatabase();
  await db.saves.put(save);
  await db.saveProfiles.put(createDefaultSaveProfile('s1'));
  await db.characters.put(
    createDefaultCharacterState({ id: 'c1', name: '向导', saveId: 's1', introducedBy: 'u1' }),
  );
});

describe('character history lifecycle', () => {
  it('commits once per source, skips missing characters, restores profile and history together', async () => {
    const manager = createStateManager('s1');
    const before = await manager.createSnapshot('manual', 0);
    await db.messages.bulkPut(messages);
    const warnings = await manager.commitCharacterUpdates(
      [update, { ...update, name: '未创建的人' }],
      source,
    );
    expect(warnings).toHaveLength(1);
    expect(await db.characterChronicle.count()).toBe(2);
    await manager.commitCharacterUpdates([update], source);
    expect(await db.characterChronicle.count()).toBe(2);
    expect((await db.characters.get('c1'))?.goals).toBe('一同前往渡口');
    expect((await manager.restoreSnapshot(before.id)).success).toBe(true);
    expect(await db.characterChronicle.count()).toBe(0);
    expect((await db.characters.get('c1'))?.goals).toBeUndefined();
  });
  it('rejects a stale or pending source and never invents past for an established character', async () => {
    await db.messages.bulkPut(messages.map((m) => ({ ...m, storyTurnStatus: 'pending' })));
    const manager = createStateManager('s1');
    expect(await manager.commitCharacterUpdates([update], source)).toHaveLength(1);
    expect(await db.characterChronicle.count()).toBe(0);
    await db.messages.bulkPut(messages);
    await db.characters.update('c1', { introducedBy: undefined });
    expect(await manager.commitCharacterUpdates([update], source)).toHaveLength(1);
    expect((await db.characterChronicle.toArray()).map((e) => e.origin)).toEqual(['experience']);
  });
  it('remaps both live and snapshot history on independent imports; full backup and deletion include history', async () => {
    await db.messages.bulkPut(messages);
    const manager = createStateManager('s1');
    await manager.commitCharacterUpdates([update], source);
    await manager.createSnapshot('turn', 1);
    const backup = await exportSessionSave('s1');
    const first = await importSessionSave(backup);
    const second = await importSessionSave(backup);
    expect(first.saveId).not.toBe(second.saveId);
    const rows = await db.characterChronicle.where('saveId').equals(first.saveId).toArray();
    const character = (await db.characters.where('saveId').equals(first.saveId).toArray())[0];
    const turn = collectCompleteStoryTurns(
      await db.messages.where('saveId').equals(first.saveId).sortBy('timestamp'),
    )[0];
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.characterId === character.id &&
          r.source.kind === 'turn' &&
          storyMemorySourceMatches(r.source, turn),
      ),
    ).toBe(true);
    expect(character.introducedBy).toBe(turn.key);
    const imported = (await db.saves.get(first.saveId))!;
    await db.characterChronicle.where('saveId').equals(first.saveId).delete();
    expect(
      (await createStateManager(first.saveId).restoreSnapshot(imported.activeSnapshotId!)).success,
    ).toBe(true);
    expect(await db.characterChronicle.where('saveId').equals(first.saveId).count()).toBe(2);
    const full = await exportAllData();
    await db.characterChronicle.clear();
    await importAllData(full);
    expect(await db.characterChronicle.count()).toBe(6);
    await deleteSaveSlot(first.saveId);
    expect(await db.characterChronicle.where('saveId').equals(first.saveId).count()).toBe(0);
    expect(await db.characterChronicle.where('saveId').equals('s1').count()).toBe(2);
  });
  it('freezes author definitions and preserves author history through later rollback', async () => {
    await db.characters.update('c1', { introducedBy: undefined });
    const manager = createStateManager('s1');
    await manager.initializeCharacterDefinitions([
      {
        id: 'guide',
        name: '向导',
        profile: { background: '来自河谷' },
        assets: [],
        past: [
          {
            title: '学艺',
            summary: '学习辨认道路。',
            time: { kind: 'past', label: '幼年' },
            importance: 8,
          },
        ],
      },
    ]);
    const before = await manager.createSnapshot('manual', 0);
    await db.messages.bulkPut(messages);
    await manager.commitCharacterUpdates([update], source);
    await manager.restoreSnapshot(before.id);
    expect((await db.characterChronicle.toArray()).map((e) => e.origin)).toEqual(['author']);
    expect((await db.characters.get('c1'))?.definition?.profile.background).toBe('来自河谷');
  });
  it('seeds an entity-generated author definition only after its introduction is accepted, even with no update', async () => {
    await db.characters.update('c1', {
      definition: {
        id: 'guide',
        name: '向导',
        profile: {},
        assets: [],
        past: [
          {
            title: '学艺',
            summary: '学习辨路。',
            time: { kind: 'past', label: '幼年' },
            importance: 8,
          },
        ],
      },
    });
    const manager = createStateManager('s1');
    await manager.initializeCharacterDefinitions([]);
    expect(await db.characterChronicle.count()).toBe(0);
    await db.messages.bulkPut(messages);
    await manager.initializeCharacterDefinitions([]);
    await manager.initializeCharacterDefinitions([]);
    expect((await db.characterChronicle.toArray()).map((e) => e.origin)).toEqual(['author']);
  });
});
