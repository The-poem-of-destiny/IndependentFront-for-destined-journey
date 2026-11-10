import { getDatabase } from '../persistence/database';
import { getPackRuntimeRevision, isProtectedContentInstalled } from '../content/pack-runtime';
import { withSaveWriteLock } from '../state/state-write-queue';
import {
  directCacheKey,
  type DirectCacheRecord,
  type DirectCacheStore,
} from './direct-context-session';

/** Separate record protocol, sharing the existing disposable cache table and deletion lifecycle. */
export function createDirectCacheStore(): DirectCacheStore {
  const table = () => getDatabase().table<DirectCacheRecord>('promptSessions');
  return {
    async load(saveId) {
      const revision = getPackRuntimeRevision();
      if (isProtectedContentInstalled()) return undefined;
      return withSaveWriteLock(saveId, async () => {
        const record = await table().get(directCacheKey(saveId));
        return !isProtectedContentInstalled() && revision === getPackRuntimeRevision()
          ? record
          : undefined;
      });
    },
    async save(record) {
      const revision = getPackRuntimeRevision();
      if (isProtectedContentInstalled()) return;
      await withSaveWriteLock(record.saveId, async () => {
        if (!isProtectedContentInstalled() && revision === getPackRuntimeRevision())
          await table().put(JSON.parse(JSON.stringify(record)) as DirectCacheRecord);
      });
    },
    delete: (saveId) => withSaveWriteLock(saveId, () => table().delete(directCacheKey(saveId))),
  };
}
