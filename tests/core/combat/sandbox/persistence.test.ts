/**
 * persistence.test.ts —— 战斗沙盒 Dexie 表（v27）读写 + 存档级联删
 * 用 fake-indexeddb（tests/setup.ts 注入）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearAllData,
  deleteSaveSlot,
  getDatabase,
  initializeDatabase,
  saveSaveSlot,
} from '../../../../src/core/persistence/database';
import {
  deleteCombatSandbox,
  getCombatSandbox,
  saveCombatSandbox,
} from '../../../../src/core/combat/sandbox/persistence';
import { createCombatState } from '../../../../src/core/combat/sandbox/state';
import type { CombatSandboxRecord } from '../../../../src/core/combat/sandbox/types';

const SAVE_ID = 'sandbox-save';

function makeRecord(overrides: Partial<CombatSandboxRecord> = {}): CombatSandboxRecord {
  return {
    saveId: SAVE_ID,
    updatedAt: 1,
    state: createCombatState({
      combatants: [{ name: '哥布林', side: 'enemy', tier: 1, level: 1 }],
    }),
    transcript: [{ role: 'system', content: '主持开始' }],
    ...overrides,
  };
}

describe('combat sandbox persistence', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  it('save → get 往返（含 state / transcript / preSnapshotId）', async () => {
    await saveCombatSandbox(makeRecord({ preSnapshotId: 'snap-pre' }));
    const row = await getCombatSandbox(SAVE_ID);
    expect(row?.state.units['哥布林']).toBeDefined();
    expect(row?.transcript[0].content).toBe('主持开始');
    expect(row?.preSnapshotId).toBe('snap-pre');
  });

  it('同一 saveId 覆盖写（每存档只留一行）', async () => {
    await saveCombatSandbox(makeRecord());
    await saveCombatSandbox(makeRecord({ updatedAt: 2 }));
    expect(await getDatabase().combatSandboxes.count()).toBe(1);
    expect((await getCombatSandbox(SAVE_ID))?.updatedAt).toBe(2);
  });

  it('get 未命中返回 undefined；delete 删除', async () => {
    expect(await getCombatSandbox('none')).toBeUndefined();
    await saveCombatSandbox(makeRecord());
    await deleteCombatSandbox(SAVE_ID);
    expect(await getCombatSandbox(SAVE_ID)).toBeUndefined();
  });

  it('删除存档级联删除 combatSandboxes 行', async () => {
    await saveSaveSlot({
      id: SAVE_ID,
      slot: 1,
      name: '测试存档',
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    } as never);
    await saveCombatSandbox(makeRecord());
    expect(await getDatabase().combatSandboxes.count()).toBe(1);

    await deleteSaveSlot(SAVE_ID);
    expect(await getDatabase().combatSandboxes.count()).toBe(0);
  });
});
