/**
 * state-manager.plot-threads-restore.test.ts — 事件线随回合快照的**往返**（T6 验收 2）
 *
 * 钉的是「恢复旧快照后，事件线节点/冷却/收口游标是否回到旧态」：
 * - 创建节点 → 打回合快照 → 推进/结算 → 恢复旧快照 → 节点、状态、lastCommittedTurn 全回旧态；
 * - 恢复后无残留：新回合再推进不允许出现「结算了但节点还留着」的混合态
 *   （restoreSnapshot 对 saveProfile 整体覆写 —— 事件线在 worldFlags 内天然随行）。
 *
 * 全部走真入口（createStateManager.advanceTurn / restoreSnapshot + commitPlotThreadTurn），
 * 落到真 Dexie（fake-indexeddb）上回读 —— 纯函数测试全绿也照样漏的「接线」由这里兜。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData, getSaveProfile, getSnapshots, initializeDatabase } from './database';
import { commitPlotThreadTurn, getPlotThreadFlags } from './save-profile';
import { createStateManager } from './state-manager';
import { createDefaultSaveProfile } from './database';
import type { SaveSlot } from './types';

const SAVE_ID = 'save-thread-restore';

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  const db = await import('./database').then((m) => m.getDatabase());
  await db.saves.put({
    id: SAVE_ID,
    name: '恢复测试',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: { totalTurns: 0, characterName: 'Hero', userName: 'P' },
  } as SaveSlot);
  await db.saveProfiles.put(createDefaultSaveProfile(SAVE_ID));
});

describe('事件线随快照往返', () => {
  it('节点/状态/冷却游标随 restoreSnapshot 回到旧态；恢复后无混合态残留', async () => {
    const sm = createStateManager(SAVE_ID);

    // 回合 1：推进「雾蕈收购」
    await commitPlotThreadTurn(SAVE_ID, {
      turnNo: 1,
      declarations: [
        {
          name: '雾蕈收购',
          gist: 'g1',
          thread: 't',
          motive: 'm1',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 100,
    });
    await sm.advanceTurn(); // 快照 T1（turn=1）

    const snapshots = await getSnapshots(SAVE_ID);
    expect(snapshots).toHaveLength(1);
    const t1 = snapshots[0];

    // 回合 2：新节点 B 诞生 + A 被结算为 resolved
    await commitPlotThreadTurn(SAVE_ID, {
      turnNo: 2,
      declarations: [
        {
          name: '外乡人',
          gist: 'g2',
          thread: 't',
          motive: 'm2',
          involvedNpcs: [],
          status: 'dormant',
        },
      ],
      updates: [{ name: '雾蕈收购', status: 'resolved', payoffs: [] }],
      revealedNames: ['雾蕈收购'],
      seededAtEpochMinutes: 300,
    });
    await sm.advanceTurn(); // 快照 T2

    // 恢复 T1：节点 A 回到 active、B 消失、游标回到 1
    const result = await sm.restoreSnapshot(t1.id);
    expect(result.errors).toEqual([]);
    const profile = await getSaveProfile(SAVE_ID);
    expect(profile).toBeDefined();
    const flags = getPlotThreadFlags(profile!);
    expect(Object.keys(flags.nodes)).toEqual(['雾蕈收购']);
    expect(flags.nodes['雾蕈收购'].status).toBe('active');
    expect(flags.nodes['雾蕈收购'].seededAt).toBe(100);
    expect(flags.lastAdvancedTurn).toBe(1);
    expect(flags.lastCommittedTurn).toBe(1);

    // 恢复后的下一轮提交：幂等语义照旧（同轮重交 no-op；不因已恢复而叠加旧数据）
    const again = await commitPlotThreadTurn(SAVE_ID, {
      turnNo: 1,
      declarations: [],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 999,
    });
    expect(again.committed).toBe(false); // lastCommittedTurn===1 已存在 → no-op
  });

  it('不同 saveId 之间不串档：恢复不影响他人事件线', async () => {
    const db = await import('./database').then((m) => m.getDatabase());
    await db.saves.put({
      id: 'save-other',
      name: '另一存档',
      slot: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeSnapshotId: null,
      metadata: { totalTurns: 0, characterName: 'Other', userName: 'P' },
    } as SaveSlot);
    await db.saveProfiles.put(createDefaultSaveProfile('save-other'));
    await commitPlotThreadTurn('save-other', {
      turnNo: 1,
      declarations: [
        {
          name: '别人家的节点',
          gist: 'g',
          thread: 't',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      updates: [],
      revealedNames: [],
      seededAtEpochMinutes: 7,
    });
    const sm = createStateManager(SAVE_ID);
    await sm.advanceTurn();
    const snapshots = await getSnapshots(SAVE_ID);
    await sm.advanceTurn();
    await sm.restoreSnapshot(snapshots[0].id);
    const otherFlags = getPlotThreadFlags((await getSaveProfile('save-other'))!);
    expect(Object.keys(otherFlags.nodes)).toEqual(['别人家的节点']);
  });
});
