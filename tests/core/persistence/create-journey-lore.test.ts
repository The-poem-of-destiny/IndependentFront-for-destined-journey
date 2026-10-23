import { beforeEach, describe, expect, it } from 'vitest';
import { createJourney } from '../../../src/core/persistence/create-journey';
import { StateManager } from '../../../src/core/state/state-manager';
import {
  clearAllData,
  createDefaultSaveProfile,
  getDatabase,
  initializeDatabase,
  exportAllData,
  importAllData,
} from '../../../src/core/persistence/database';
import { exportSessionSave, importSessionSave } from '../../../src/core/persistence/session-backup';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { SaveSlot, WorldBook, WorldBookEntry } from '../../../src/core/types/types';

function entry(uid: number, content: string, enabled = false): WorldBookEntry {
  return {
    uid,
    content,
    name: `entry-${uid}`,
    enabled,
    order: uid,
    position: 0,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    extra: { lore: { audiences: ['story'] } },
  };
}
function input() {
  const character = createDefaultCharacterState({
    id: 'player',
    name: 'player',
    type: 'player',
    saveId: 'save',
  });
  const save: SaveSlot = {
    id: 'save',
    name: 'journey',
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: 'player',
      userName: 'user',
      gameStartTime: 'start',
      totalTurns: 0,
      storyContextV2: { schema: 1, markedAt: 1 },
      enabledWorldBookEntries: ['system_core:2'],
    },
  };
  const revival = entry(433, '{{getvar::revival}}', true);
  revival.extra!.lore = {
    audiences: ['story'],
    key: 'rules:revival',
    section: 'fixed',
    evaluation: 'onCreate',
  };
  const worldBooks: WorldBook[] = [
    { id: 'rules', name: 'rules', partition: 'extra_setting', builtIn: true, entries: [revival] },
    {
      id: 'cores',
      name: 'cores',
      partition: 'system_core',
      builtIn: true,
      entries: [entry(1, '{{setvar::revival::OTHER}}'), entry(2, '{{setvar::revival::SELECTED}}')],
    },
  ];
  return {
    character,
    save,
    worldBooks,
    era: '',
    experienceMode: 'normal' as const,
    destinyPoints: 0,
    events: [],
  };
}

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
});

describe('opening lore persistence', () => {
  it('does not require or persist an opening revival snapshot for ordinary fixed content', async () => {
    const value = input();
    delete value.worldBooks[0].entries[0].extra!.lore!.evaluation;
    value.worldBooks[1].entries[1].content =
      '<% if (true) { %>{{setvar::revival::SELECTED}}<% } %>';
    await createJourney(value);
    const saved = (await getDatabase().saves.get('save'))!;
    expect(saved.metadata.fixedLore?.['rules:revival']).toBeUndefined();
    expect(await getDatabase().characters.count()).toBe(1);
  });

  it('freezes only the explicitly selected core before publishing, without changing global entries', async () => {
    const value = input();
    const original = JSON.stringify(value);
    await createJourney(value);
    const saved = (await getDatabase().saves.get('save'))!;
    expect(saved.metadata.fixedLore?.['rules:revival'].text).toBe('SELECTED');
    expect(saved.metadata.fixedLore?.['rules:revival'].definitionSources.revival).toBe('cores#2');
    expect(JSON.stringify(value)).toBe(original);
    expect((await getDatabase().saveProfiles.get('save'))?.variables).toEqual({});
  });

  it.each([
    ['realm', 1, true],
    ['outside', 1, false],
    ['realm', 6, false],
  ])(
    'freezes against the actual profile date and player location: %s month=%s readable=%s',
    async (location, month, readable) => {
      const value = input();
      value.character.location = location;
      value.worldBooks[1].entries[1].extra!.lore!.activation = {
        readWhen: {
          any: [
            {
              locations: ['realm'],
              annualWindow: {
                start: { month: 1, day: 1 },
                end: { month: 1, day: 1 },
                beforeDays: 0,
                afterDays: 0,
              },
            },
          ],
        },
      };
      const db = getDatabase();
      const profile = createDefaultSaveProfile(value.save.id, 'existing-era');
      profile.gameTime.month = month;
      await db.saveProfiles.put(profile);
      if (readable) {
        await createJourney(value);
        expect((await db.saves.get('save'))?.metadata.fixedLore?.['rules:revival'].text).toBe(
          'SELECTED',
        );
        expect((await db.saveProfiles.get('save'))?.gameTime).toEqual(profile.gameTime);
      } else {
        await expect(createJourney(value)).rejects.toThrow('missing definitions');
        expect(await db.saves.count()).toBe(0);
        expect(await db.characters.count()).toBe(0);
        expect(await db.saveProfiles.get('save')).toEqual(profile);
      }
    },
  );

  it('rolls back a newly initialized profile when the opening read gate rejects its definition', async () => {
    const value = input();
    value.character.location = 'realm';
    value.save.metadata.openingPrompt = 'festival';
    value.worldBooks[1].entries[1].extra!.lore!.activation = {
      readWhen: {
        any: [
          {
            locations: ['realm'],
            annualWindow: {
              start: { month: 2, day: 1 },
              end: { month: 2, day: 1 },
              beforeDays: 0,
              afterDays: 0,
            },
          },
          { keywords: ['festival'] },
        ],
      },
    };
    await expect(createJourney(value)).rejects.toThrow('missing definitions');
    const db = getDatabase();
    expect(await db.saves.count()).toBe(0);
    expect(await db.characters.count()).toBe(0);
    expect(await db.saveProfiles.count()).toBe(0);
  });

  it('missing or empty opening definitions publish no partial save/character/profile', async () => {
    const value = input();
    value.worldBooks[1].entries[1].content = '{{setvar::revival::}}';
    await expect(createJourney(value)).rejects.toThrow('empty text');
    const db = getDatabase();
    expect(await db.saves.count()).toBe(0);
    expect(await db.characters.count()).toBe(0);
    expect(await db.saveProfiles.count()).toBe(0);
  });

  it('does not initialize opening lore for legacy saves', async () => {
    const value = input();
    delete value.save.metadata.storyContextV2;
    await createJourney(value);
    expect((await getDatabase().saves.get('save'))?.metadata.fixedLore).toBeUndefined();
  });

  it('keeps opening facts through a real snapshot rollback', async () => {
    const value = input();
    await createJourney(value);
    const db = getDatabase();
    const before = (await db.saves.get('save'))!.metadata.fixedLore;
    const manager = new StateManager({ saveId: 'save' });
    const snapshot = await manager.createSnapshot('manual', 0);
    const profile = (await db.saveProfiles.get('save'))!;
    profile.variables = { sys: { revival: 'CHANGED' } };
    await db.saveProfiles.put(profile);
    expect((await manager.restoreSnapshot(snapshot.id)).success).toBe(true);
    expect((await db.saves.get('save'))!.metadata.fixedLore).toEqual(before);
    expect((await db.saveProfiles.get('save'))!.variables).toEqual({});
  });

  it('preserves opening results through a full database backup restore', async () => {
    await createJourney(input());
    const backup = await exportAllData();
    const expected = (await getDatabase().saves.get('save'))!.metadata.fixedLore;
    await clearAllData();
    await importAllData(JSON.parse(JSON.stringify(backup)));
    expect((await getDatabase().saves.get('save'))!.metadata.fixedLore).toEqual(expected);
  });

  it('opening results travel unchanged through single-save export/import', async () => {
    const value = input();
    await getDatabase().worldBooks.bulkPut(value.worldBooks);
    await createJourney(value);
    const backup = await exportSessionSave('save');
    const original = backup.save.metadata.fixedLore;
    value.worldBooks[1].entries[1].content = '{{setvar::revival::UPDATED}}';
    await getDatabase().worldBooks.bulkPut(value.worldBooks);
    const imported = await importSessionSave(JSON.parse(JSON.stringify(backup)));
    expect(imported.saveId).not.toBe('save');
    expect((await getDatabase().saves.get(imported.saveId))?.metadata.fixedLore).toEqual(original);
    expect(original?.['rules:revival'].text).toBe('SELECTED');
  });
});
