/**
 * game-store.updatePlayerPersona — UI 到 StateManager 的人设保存接线。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
  saveSaveProfile,
  saveSaveSlot,
} from '@engine/database';
import { createDefaultCharacterState, type SaveProfile, type SaveSlot } from '@engine/types';
import { useGameStore } from './game-store';

const SAVE_ID = 'save-persona-store';

function makeSave(): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'Persona Store Test',
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '阿黑',
      userName: 'Tester',
      gameStartTime: '0488-01-01',
      totalTurns: 0,
    },
  };
}

function makeProfile(): SaveProfile {
  return {
    saveId: SAVE_ID,
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: { era: '复兴纪元', year: 488, month: 1, day: 1, weekday: 7, hour: 8, minute: 0 },
    variables: {},
    worldFlags: {},
    updatedAt: 1,
  };
}

async function seedStore() {
  await saveSaveSlot(makeSave());
  await saveSaveProfile(makeProfile());
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero',
      saveId: SAVE_ID,
      name: '阿黑',
      type: 'player',
      personality: '天真',
      appearance: '身形纤细',
      background: '来自异世界',
      hp: 42,
      maxHp: 100,
    }),
  );
  const store = useGameStore();
  await store.loadSave(SAVE_ID);
  return store;
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时数据库尚未建立 */
  }
  await initializeDatabase();
  setActivePinia(createPinia());
});

describe('game-store.updatePlayerPersona', () => {
  it('成功后用权威返回值替换 Pinia 主角并持久化', async () => {
    const store = await seedStore();

    const result = await store.updatePlayerPersona({
      personality: '冷静但心软',
      appearance: '银发金瞳',
      background: '在边境长大',
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(store.player).toMatchObject({
      personality: '冷静但心软',
      appearance: '银发金瞳',
      background: '在边境长大',
      hp: 42,
    });
    expect((await getCharacters(SAVE_ID))[0]).toMatchObject({
      personality: '冷静但心软',
      appearance: '银发金瞳',
      background: '在边境长大',
    });
  });

  it('生成中拒绝保存，数据库和内存都不变', async () => {
    const store = await seedStore();
    store.isGenerating = true;

    const result = await store.updatePlayerPersona({
      personality: '不应写入',
      appearance: '不应写入',
      background: '不应写入',
    });

    expect(result).toEqual({ ok: false, error: '当前回合生成中，暂时无法编辑人设' });
    expect(store.player?.personality).toBe('天真');
    expect((await getCharacters(SAVE_ID))[0].personality).toBe('天真');
  });

  it('战斗中拒绝保存', async () => {
    const store = await seedStore();
    store.combatReady = { combatType: '遭遇战' };

    const result = await store.updatePlayerPersona({
      personality: '不应写入',
      appearance: '不应写入',
      background: '不应写入',
    });

    expect(result).toEqual({ ok: false, error: '战斗结束后才能编辑人设' });
    expect(store.player?.personality).toBe('天真');
  });

  it('无活跃存档时拒绝', async () => {
    const store = useGameStore();
    const result = await store.updatePlayerPersona({
      personality: 'A',
      appearance: 'B',
      background: 'C',
    });
    expect(result).toEqual({ ok: false, error: '无活跃存档' });
  });
});
