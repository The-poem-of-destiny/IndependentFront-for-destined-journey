import { beforeEach, describe, expect, it } from 'vitest';
import { createJourney } from '../../../src/core/persistence/create-journey';
import { MAX_START_LEVEL } from '../../../src/core/content/start-catalog-mechanics';
import {
  clearAllData,
  getDatabase,
  initializeDatabase,
} from '../../../src/core/persistence/database';
import { characterAge, hasGivenBirthday } from '../../../src/core/character/character-age';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { SaveSlot } from '../../../src/core/types/types';

function input(level: number) {
  const character = createDefaultCharacterState({
    id: 'player',
    name: 'player',
    type: 'player',
    saveId: 'save',
  });
  character.level = level;
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
    },
  };
  return {
    character,
    save,
    era: '',
    experienceMode: 'normal' as const,
    destinyPoints: 0,
    events: [],
  };
}

async function expectNoRows() {
  const db = getDatabase();
  expect(await db.saves.count()).toBe(0);
  expect(await db.characters.count()).toBe(0);
  expect(await db.saveProfiles.count()).toBe(0);
  expect(await db.characterChronicle.count()).toBe(0);
}

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
});

describe('createJourney 初始等级上限', () => {
  it('上限常量为 10', () => {
    expect(MAX_START_LEVEL).toBe(10);
  });

  it(`Lv${MAX_START_LEVEL} 可以建档`, async () => {
    await expect(createJourney(input(MAX_START_LEVEL))).resolves.toBe('save');
    expect((await getDatabase().characters.get('player'))?.level).toBe(MAX_START_LEVEL);
  });

  it('Lv1 可以建档', async () => {
    await expect(createJourney(input(1))).resolves.toBe('save');
  });

  it.each([MAX_START_LEVEL + 1, 25, 0, -1, 3.5, Number.NaN])(
    '等级 %s 被拒收且不留任何记录',
    async (level) => {
      await expect(createJourney(input(level))).rejects.toThrow('初始等级');
      await expectNoRows();
    },
  );
});

describe('createJourney 主角生日', () => {
  it('建号年龄 + 生日换算成年龄锚点，生日当天满岁', async () => {
    const data = input(1);
    data.character.customFields = {
      ...data.character.customFields,
      age: 18,
      birthday: { month: 3, day: 15 },
    };
    await createJourney(data);
    const stored = await getDatabase().characters.get('player');
    expect(stored?.ageAnchor).toEqual({ startAge: 18, month: 3, day: 15 });
    expect(hasGivenBirthday(stored!)).toBe(true);
    expect(characterAge(stored!, { year: 488, month: 3, day: 15 })).toBe(19);
  });
});
