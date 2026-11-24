/**
 * game-store 变量修改器接线（状态树协议 T11，设计 §11.2 / §11.4）：
 * 从库新读快照、提交后回读活表、撤销栈的入栈 / 出栈 / 换回合清空、锁定守卫。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
  saveSaveProfile,
  saveSaveSlot,
} from '@engine/persistence/database';
import { createDefaultCharacterState, type SaveProfile, type SaveSlot } from '@engine/types/types';
import { useGameStore } from '../../../src/ui/stores/game-store';

const SAVE_ID = 'save-state-edit-store';

function makeSave(): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'State Edit Store Test',
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
      hp: 42,
      maxHp: 100,
      money: 10,
    }),
  );
  await saveCharacter(
    createDefaultCharacterState({ id: 'npc-1', saveId: SAVE_ID, name: '布兰', type: 'npc' }),
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

describe('game-store 变量修改器', () => {
  it('readStateEditorSnapshot 从库里新读', async () => {
    const store = await seedStore();
    const snap = await store.readStateEditorSnapshot();
    expect(snap?.characters.map((c) => c.name).sort()).toEqual(['布兰', '阿黑']);
    expect(snap?.profile).toMatchObject({ saveId: SAVE_ID });
  });

  it('提交成功：落库、回读活表、入撤销栈；撤销后恢复并出栈', async () => {
    const store = await seedStore();
    const result = await store.commitStateEdit(
      [{ op: 'replace', path: '/主角/金钱', value: 500 }],
      '修改 /主角/金钱',
    );
    expect(result.ok).toBe(true);
    expect(store.player?.money).toBe(500);
    expect((await getCharacters(SAVE_ID)).find((c) => c.id === 'hero')?.money).toBe(500);
    expect(store.stateEditUndoStack).toHaveLength(1);

    const undo = await store.undoLastStateEdit();
    expect(undo.ok).toBe(true);
    expect(store.player?.money).toBe(10);
    expect(store.stateEditUndoStack).toHaveLength(0);
  });

  it('删除 NPC 后内存角色表同步移除（合并回读留不住删除）', async () => {
    const store = await seedStore();
    const result = await store.commitStateEdit(
      [{ op: 'remove', path: '/关系列表/布兰' }],
      '删除 /关系列表/布兰',
    );
    expect(result.ok).toBe(true);
    expect(store.characters.map((c) => c.name)).toEqual(['阿黑']);
  });

  it('整批被拒：不落库、不入栈、原因交回', async () => {
    const store = await seedStore();
    const result = await store.commitStateEdit(
      [
        { op: 'replace', path: '/主角/金钱', value: 500 },
        { op: 'replace', path: '/主角/成长/_属性点', value: 9 },
      ],
      'x',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join()).toContain('只读');
    expect((await getCharacters(SAVE_ID)).find((c) => c.id === 'hero')?.money).toBe(10);
    expect(store.stateEditUndoStack).toHaveLength(0);
  });

  it('生成中 / 润色中 / 战斗中拒绝提交', async () => {
    const store = await seedStore();
    const op = [{ op: 'replace' as const, path: '/主角/金钱', value: 1 }];
    store.isGenerating = true;
    expect((await store.commitStateEdit(op, 'x')).ok).toBe(false);
    store.isGenerating = false;
    store.isRewriting = true;
    expect((await store.commitStateEdit(op, 'x')).ok).toBe(false);
    store.isRewriting = false;
    store.combatReady = { combatType: '遭遇战' };
    const r = await store.commitStateEdit(op, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain('战斗');
    expect((await getCharacters(SAVE_ID)).find((c) => c.id === 'hero')?.money).toBe(10);
  });

  it('换回合（新的玩家输入）清空撤销栈', async () => {
    const store = await seedStore();
    await store.commitStateEdit([{ op: 'replace', path: '/主角/金钱', value: 500 }], 'x');
    expect(store.stateEditUndoStack).toHaveLength(1);
    store.addMessage('向北走', 'user');
    await nextTick();
    expect(store.stateEditUndoStack).toHaveLength(0);
  });

  it('切存档（clearActive）清空撤销栈', async () => {
    const store = await seedStore();
    await store.commitStateEdit([{ op: 'replace', path: '/主角/金钱', value: 500 }], 'x');
    store.clearActive();
    expect(store.stateEditUndoStack).toHaveLength(0);
  });
});
