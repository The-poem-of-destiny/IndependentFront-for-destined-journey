/**
 * game-store 每楼变量更新块接线（状态树协议 T13，设计 §12.3）：
 * 试算（只认最新一楼、锁定守卫、冲突）→ 提交走变量修改器同一写入口 → 记录写回本楼消息
 * （只改 stateUpdates，正文不变）；跳转到变量修改器的一次性定位路径。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  clearAllData,
  getCharacters,
  getDatabase,
  initializeDatabase,
  saveCharacter,
  saveMessage,
  saveSaveProfile,
  saveSaveSlot,
} from '@engine/persistence/database';
import {
  createDefaultCharacterState,
  type ChatMessage,
  type SaveProfile,
  type SaveSlot,
  type StateUpdateRecord,
} from '@engine/types/types';
import { useGameStore } from '../../../src/ui/stores/game-store';

const SAVE_ID = 'save-state-update-store';

function makeSave(): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'State Update Store Test',
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

/** 本楼记录：金钱 +20（10 → 30）。 */
const LATEST: StateUpdateRecord = {
  deltaMinutes: 0,
  ops: [{ path: '/主角/金钱', op: 'delta', value: 20, status: '已应用', before: 10, after: 30 }],
};
/** 更早楼层：前后值已清掉。 */
const EARLIER: StateUpdateRecord = {
  deltaMinutes: 0,
  ops: [{ path: '/主角/金钱', op: 'delta', value: 5, status: '已应用' }],
};

function message(
  id: string,
  role: 'user' | 'assistant',
  turn: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: role === 'user' ? '向北走' : `第 ${turn} 楼正文`,
    timestamp: turn,
    saveId: SAVE_ID,
    turn,
    storyTurnStatus: 'accepted',
    ...extra,
  };
}

async function seedStore(money = 30) {
  await saveSaveSlot(makeSave());
  await saveSaveProfile(makeProfile());
  await saveCharacter(
    createDefaultCharacterState({
      id: 'hero',
      saveId: SAVE_ID,
      name: '阿黑',
      type: 'player',
      money,
    }),
  );
  await saveMessage(message('u1', 'user', 1));
  await saveMessage(message('a1', 'assistant', 1, { stateUpdates: EARLIER }));
  await saveMessage(message('u2', 'user', 2));
  await saveMessage(message('a2', 'assistant', 2, { stateUpdates: LATEST }));
  const store = useGameStore();
  await store.loadSave(SAVE_ID);
  return store;
}

async function heroMoney() {
  return (await getCharacters(SAVE_ID)).find((c) => c.id === 'hero')?.money;
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

describe('game-store 更新块修订', () => {
  it('改值：按差额补到当前状态，记录写回本楼（只改 stateUpdates，正文不变）', async () => {
    const store = await seedStore();
    const revision = { kind: 'edit' as const, value: 5 };
    const plan = await store.planStateUpdateRevision('a2', 0, revision);
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.ops).toEqual([{ op: 'delta', path: '/主角/金钱', value: -15 }]);

    const result = await store.commitStateUpdateRevision('a2', 0, revision, plan.ops, '更新块');
    expect(result.ok).toBe(true);
    expect(await heroMoney()).toBe(15);
    // 与变量修改器同一个写入口：进撤销栈
    expect(store.stateEditUndoStack).toHaveLength(1);

    const row = await getDatabase().messages.get('a2');
    expect(row?.content).toBe('第 2 楼正文');
    expect(row?.storyTurnStatus).toBe('accepted');
    expect(row?.stateUpdates?.ops).toHaveLength(1);
    expect(row?.stateUpdates?.ops[0]).toMatchObject({
      status: '已手动修订',
      value: 5,
      after: 15,
      before: 10,
    });
    const shown = store.messages.find((m) => m.id === 'a2');
    expect(shown?.stateUpdates?.ops[0].status).toBe('已手动修订');
    expect(shown?.content).toBe('第 2 楼正文');
  });

  it('修订后从修改器撤销：状态与本楼记录一并还原（库与展示副本），再修订该行不报冲突', async () => {
    const store = await seedStore();
    const revision = { kind: 'edit' as const, value: 5 };
    const plan = await store.planStateUpdateRevision('a2', 0, revision);
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    expect((await store.commitStateUpdateRevision('a2', 0, revision, plan.ops, 'x')).ok).toBe(true);
    expect(await heroMoney()).toBe(15);

    const undo = await store.undoLastStateEdit();
    expect(undo.ok).toBe(true);
    expect(await heroMoney()).toBe(30);
    expect(store.stateEditUndoStack).toHaveLength(0);
    expect((await getDatabase().messages.get('a2'))?.stateUpdates).toEqual(LATEST);
    expect(store.messages.find((m) => m.id === 'a2')?.stateUpdates).toEqual(LATEST);

    const again = await store.planStateUpdateRevision('a2', 0, revision);
    expect(again.kind).toBe('ok');
  });

  it('本楼消息没有记录时修订整批失败：状态不变、不入撤销栈', async () => {
    const store = await seedStore();
    await getDatabase().messages.update('a2', { stateUpdates: undefined });
    const result = await store.commitStateUpdateRevision(
      'a2',
      0,
      { kind: 'revert' },
      [{ op: 'delta', path: '/主角/金钱', value: -20 }],
      'x',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toContain('记录写回失败');
    expect(await heroMoney()).toBe(30);
    expect(store.stateEditUndoStack).toHaveLength(0);
  });

  it('新增一条：追加在末尾，不动原有下标', async () => {
    const store = await seedStore();
    const revision = {
      kind: 'append' as const,
      op: { op: 'replace' as const, path: '/主角/金钱', value: 99 },
    };
    const plan = await store.planStateUpdateRevision('a2', null, revision);
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect((await store.commitStateUpdateRevision('a2', null, revision, plan.ops, 'x')).ok).toBe(
      true,
    );
    const ops = (await getDatabase().messages.get('a2'))?.stateUpdates?.ops ?? [];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ status: '已应用', after: 30 });
    expect(ops[1]).toMatchObject({ status: '已手动修订', path: '/主角/金钱' });
    expect(await heroMoney()).toBe(99);
  });

  it('现值与记录后值不符 → 冲突；force 仍然覆盖', async () => {
    const store = await seedStore(50);
    const plan = await store.planStateUpdateRevision('a2', 0, { kind: 'revert' });
    expect(plan).toMatchObject({ kind: 'conflict', path: '/主角/金钱', expected: 30, current: 50 });
    const forced = await store.planStateUpdateRevision(
      'a2',
      0,
      { kind: 'revert' },
      { force: true },
    );
    expect(forced.kind).toBe('ok');
    if (forced.kind !== 'ok') return;
    await store.commitStateUpdateRevision('a2', 0, { kind: 'revert' }, forced.ops, 'x');
    expect(await heroMoney()).toBe(10);
  });

  it('更早楼层与锁定时不给试算、不提交', async () => {
    const store = await seedStore();
    const earlier = await store.planStateUpdateRevision('a1', 0, { kind: 'revert' });
    expect(earlier.kind).toBe('invalid');
    const commitEarlier = await store.commitStateUpdateRevision(
      'a1',
      0,
      { kind: 'revert' },
      [{ op: 'delta', path: '/主角/金钱', value: -5 }],
      'x',
    );
    expect(commitEarlier.ok).toBe(false);
    expect(await heroMoney()).toBe(30);

    store.isGenerating = true;
    const locked = await store.planStateUpdateRevision('a2', 0, { kind: 'revert' });
    expect(locked.kind).toBe('invalid');
    if (locked.kind === 'invalid') expect(locked.reasons[0]).toContain('生成中');
  });

  it('跳转定位：openStateEditorAt 打开修改器，路径只被取走一次；clearActive 清掉', async () => {
    const store = await seedStore();
    store.openStateEditorAt('/主角/金钱');
    expect(store.activeModal).toBe('variables');
    expect(store.consumeStateEditorFocus()).toBe('/主角/金钱');
    expect(store.consumeStateEditorFocus()).toBeNull();
    store.openStateEditorAt('/主角/金钱');
    store.clearActive();
    expect(store.stateEditorFocusPath).toBeNull();
  });
});
