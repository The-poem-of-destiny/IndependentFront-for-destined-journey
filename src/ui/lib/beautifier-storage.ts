import type { Table } from 'dexie';
import { getDatabase } from '@engine/database';
import type { RegexStorageRecord } from '@engine/types';
import {
  BEAUTIFIER_STORAGE_MAX_KEY_BYTES,
  BEAUTIFIER_STORAGE_MAX_KEYS,
  BEAUTIFIER_STORAGE_QUOTA_BYTES,
  type BeautifierStorageEntry,
  type BeautifierStorageMutation,
} from './beautifier-frame';

type RegexStorageDatabase = ReturnType<typeof getDatabase> & {
  regexStorage: Table<RegexStorageRecord, string>;
};

export interface BeautifierStorageSession {
  snapshot(): BeautifierStorageEntry[];
  commit(mutations: readonly BeautifierStorageMutation[]): Promise<void>;
  close(): void;
}

export type BeautifierStorageCommitListener = (
  mutations: readonly BeautifierStorageMutation[],
) => void;

const encoder = new TextEncoder();
const values = new Map<string, string>();
const listeners = new Map<symbol, BeautifierStorageCommitListener>();
let loadPromise: Promise<void> | undefined;
let persistenceAvailable = true;
let commitTail = Promise.resolve();

function database(): RegexStorageDatabase {
  return getDatabase() as RegexStorageDatabase;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function quotaError(): DOMException {
  return new DOMException('Regex storage quota exceeded', 'QuotaExceededError');
}

function assertWithinLimits(candidate: Map<string, string>, changedKey: string): void {
  if (utf8Bytes(changedKey) > BEAUTIFIER_STORAGE_MAX_KEY_BYTES) throw quotaError();
  if (candidate.size > BEAUTIFIER_STORAGE_MAX_KEYS) throw quotaError();

  let total = 0;
  for (const [key, value] of candidate) {
    total += utf8Bytes(key) + utf8Bytes(value);
    if (total > BEAUTIFIER_STORAGE_QUOTA_BYTES) throw quotaError();
  }
}

function copyMutations(
  mutations: readonly BeautifierStorageMutation[],
): BeautifierStorageMutation[] {
  return mutations.map((mutation) => {
    if (mutation.kind === 'clear') return { kind: 'clear' };
    if (mutation.kind === 'remove' && typeof mutation.key === 'string') {
      return { kind: 'remove', key: mutation.key };
    }
    if (
      mutation.kind === 'set' &&
      typeof mutation.key === 'string' &&
      typeof mutation.value === 'string'
    ) {
      return { kind: 'set', key: mutation.key, value: mutation.value };
    }
    throw new TypeError('Invalid regex storage mutation');
  });
}

function projectMutations(mutations: readonly BeautifierStorageMutation[]): Map<string, string> {
  const next = new Map(values);
  for (const mutation of mutations) {
    if (mutation.kind === 'clear') {
      next.clear();
    } else if (mutation.kind === 'remove') {
      next.delete(mutation.key);
    } else {
      next.set(mutation.key, mutation.value);
      assertWithinLimits(next, mutation.key);
    }
  }
  return next;
}

async function load(): Promise<void> {
  try {
    const rows = await database().regexStorage.toArray();
    const hydrated = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        hydrated.set(row.key, row.value);
        assertWithinLimits(hydrated, row.key);
      }
    }
    values.clear();
    for (const [key, value] of hydrated) values.set(key, value);
  } catch {
    values.clear();
    persistenceAvailable = false;
  }
}

function ensureLoaded(): Promise<void> {
  // Serialize re-hydration with writes from a frame that is being torn down.
  loadPromise ??= enqueue(load);
  return loadPromise;
}

async function persist(mutations: readonly BeautifierStorageMutation[]): Promise<void> {
  if (!persistenceAvailable || mutations.length === 0) return;
  const db = database();
  const updatedAt = Date.now();
  await db.transaction('rw', db.regexStorage, async () => {
    for (const mutation of mutations) {
      if (mutation.kind === 'clear') await db.regexStorage.clear();
      else if (mutation.kind === 'remove') await db.regexStorage.delete(mutation.key);
      else await db.regexStorage.put({ key: mutation.key, value: mutation.value, updatedAt });
    }
  });
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const result = commitTail.then(task, task);
  commitTail = result.catch(() => undefined);
  return result;
}

/** Open a view onto the single shared, regex-only persistent namespace. */
export async function openBeautifierStorageSession(
  onCommitted: BeautifierStorageCommitListener,
): Promise<BeautifierStorageSession> {
  await ensureLoaded();
  const id = Symbol('beautifier-storage-session');
  listeners.set(id, onCommitted);
  let closed = false;

  return {
    snapshot: () => [...values.entries()],
    commit(mutations) {
      if (closed) return Promise.reject(new Error('Beautifier storage session is closed'));
      const batch = copyMutations(mutations);
      return enqueue(async () => {
        const next = projectMutations(batch);
        await persist(batch);
        values.clear();
        for (const [key, value] of next) values.set(key, value);
        for (const [listenerId, listener] of listeners) {
          if (listenerId === id) continue;
          try {
            listener(batch);
          } catch {
            // A detached frame must not make an already-durable commit fail.
          }
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.delete(id);
      // Import/clear operations happen while the game view (and therefore all
      // frame sessions) is unmounted. Re-read Dexie on the next 0 -> 1 open so
      // a restored backup cannot be overwritten by a stale module cache.
      if (listeners.size === 0 && persistenceAvailable) loadPromise = undefined;
    },
  };
}
