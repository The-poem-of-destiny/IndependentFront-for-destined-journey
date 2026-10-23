import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  initializeDatabase,
  getDatabase,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import { withSaveWriteLock } from '../../../src/core/state/state-write-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await saveSaveSlot({
    id: 'cancel',
    name: 'cancel',
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: { characterName: '甲', userName: '玩家', gameStartTime: '', totalTurns: 1 },
  });
});

describe('queued Story state cancellation guard', () => {
  it.each(['patches', 'advance', 'time'] as const)(
    '%s取消于排队期间，在首次副作用前抛AbortError',
    async (mode) => {
      const gate = deferred(),
        entered = deferred();
      let current = true;
      const held = withSaveWriteLock('cancel', async () => {
        entered.resolve();
        await gate.promise;
        current = false;
      });
      await entered.promise;
      const manager = createStateManager('cancel');
      const work =
        mode === 'patches'
          ? manager.commitChatState([{ op: 'set_variable', target: 'variables.test', value: 1 }], {
              isCurrent: () => current,
            })
          : mode === 'advance'
            ? manager.advanceTurn(() => current)
            : manager.applyTimeAdvance(60, () => current);
      const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
      gate.resolve();
      await held;
      await rejected;
      const db = getDatabase();
      expect((await db.saves.get('cancel'))!.metadata.totalTurns).toBe(1);
      expect(await db.saveProfiles.get('cancel')).toBeUndefined();
      expect(await db.snapshots.where('saveId').equals('cancel').count()).toBe(0);
    },
  );
});
