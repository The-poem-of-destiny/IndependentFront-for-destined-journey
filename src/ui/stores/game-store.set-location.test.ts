/**
 * game-store.setPlayerLocation — 势力地图「设为当前位置」的唯一写入口（地图 v1 / ADR-31）
 *
 * 这一组守的是一条**架构**性质而不是功能性质的事实：手动落位只准提交**一条**
 * `set_location`，地块投影留给 `applySetLocation` 里的 `syncMapLocation` 钩子。
 * 顺手补一份 `worldFlags.map.lastTileId` 是很诱人的（少等一次回读、棋子立刻就动），
 * 而它的坏法完全无声 —— 那份派生态没有 patch 背书，换包自愈与快照回退都会与它打架。
 *
 * 所以这里**不 mock 掉** StateManager，而是把 `commitChatState` 包一层录音：
 * 真实的引擎照常跑（位置真的落库），补丁的形状同时被钉住。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGameStore } from './game-store';
import {
  initializeDatabase,
  clearAllData,
  saveSaveSlot,
  saveCharacter,
  saveSaveProfile,
} from '@engine/database';
import { createDefaultCharacterState } from '@engine/types';
import type { SaveSlot, SaveProfile, CharacterState, StatePatch } from '@engine/types';

/**
 * 录音式替身：`createStateManager` 仍返回**真的**那一个，只是把 `commitChatState`
 * 包一层。断言补丁形状与断言真实落库效果因此可以在同一个用例里做。
 */
const commitCalls = vi.hoisted(() => [] as StatePatch[][]);
vi.mock('@engine/state-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/state-manager')>();
  return {
    ...actual,
    createStateManager: (saveId: string) => {
      const sm = actual.createStateManager(saveId);
      const original = sm.commitChatState.bind(sm);
      sm.commitChatState = (patches: StatePatch[]) => {
        commitCalls.push(patches);
        return original(patches);
      };
      return sm;
    },
  };
});

const SAVE_ID = 'save-set-location';

function makeSaveSlot(): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'Set Location Test',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: '理查德',
      userName: 'Tester',
      gameStartTime: '001-01-01',
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
    worldFlags: {},
  } as unknown as SaveProfile;
}

function makeChar(overrides: Partial<CharacterState>): CharacterState {
  return { ...createDefaultCharacterState(), saveId: SAVE_ID, ...overrides } as CharacterState;
}

function makeStore() {
  setActivePinia(createPinia());
  return useGameStore();
}

async function seed(): Promise<void> {
  await saveSaveSlot(makeSaveSlot());
  await saveCharacter(
    makeChar({ id: 'player-1', name: '理查德', type: 'player', location: '起始村庄' }),
  );
  await saveSaveProfile(makeProfile());
}

describe('setPlayerLocation（手动落位）', () => {
  beforeEach(async () => {
    commitCalls.length = 0;
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  it('只提交**一条** set_location，target 指玩家、value 是地块名', async () => {
    await seed();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    commitCalls.length = 0; // 载入过程自己也会提交，从这里开始录

    const result = await store.setPlayerLocation('金谷城西部');
    expect(result.ok).toBe(true);

    // 🔴 恰好一次提交、恰好一条补丁 —— 多出来的任何一条都意味着开了第二条写路径
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]).toHaveLength(1);
    expect(commitCalls[0][0]).toEqual({
      op: 'set_location',
      target: 'characters.理查德',
      value: '金谷城西部',
    });
  });

  it('提交后回读：玩家的位置路径真的变了（不是只改了内存）', async () => {
    await seed();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(store.player?.location).toBe('起始村庄');

    await store.setPlayerLocation('金谷城西部');
    expect(store.player?.location).toBe('金谷城西部');
  });

  it('**不自己写 worldFlags.map**：落位投影归引擎钩子（这里一个字节都不碰）', async () => {
    await seed();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    commitCalls.length = 0;

    await store.setPlayerLocation('金谷城西部');
    // 提交里只有 set_location —— 没有任何 vars_update / 直写 map 旗标的补丁混进来
    const ops = commitCalls.flat().map((p) => p.op);
    expect(ops).toEqual(['set_location']);
  });

  it('地块名为空 / 没有存档 → 如实报错，且一次都不提交', async () => {
    await seed();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    commitCalls.length = 0;

    expect((await store.setPlayerLocation('   ')).ok).toBe(false);
    expect((await store.setPlayerLocation('')).ok).toBe(false);
    expect(commitCalls).toHaveLength(0);

    const empty = makeStore();
    const result = await empty.setPlayerLocation('金谷城西部');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('存档');
    expect(commitCalls).toHaveLength(0);
  });
});
