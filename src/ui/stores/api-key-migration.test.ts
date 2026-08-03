import { describe, expect, it, vi } from 'vitest';
import {
  API_KEYS_MIGRATED_FLAG,
  migrateApiKeysToDexie,
  type StoredApiEntry,
} from './api-key-migration';
import type { ApiEndpoint } from '@engine/types';

function entry(apiKey = 'sk-legacy-only-copy'): StoredApiEntry {
  return {
    id: 'ep-1',
    name: 'Primary',
    baseUrl: 'https://api.example.test',
    apiKey,
    maskedKey: 'sk-***copy',
    model: 'model-1',
    models: ['model-1'],
    apiType: 'chat',
  };
}

function fakeDb(options: { failWrite?: boolean } = {}) {
  const rows = new Map<string, ApiEndpoint>();
  const table = {
    toArray: async () => [...rows.values()],
    bulkPut: async (incoming: ApiEndpoint[]) => {
      if (options.failWrite) throw new Error('IndexedDB write failed');
      for (const row of incoming) rows.set(row.id, structuredClone(row));
    },
    bulkGet: async (ids: string[]) => ids.map((id) => rows.get(id)),
  };
  return {
    rows,
    db: {
      apiEndpoints: table,
      transaction: async (_mode: string, _table: unknown, callback: () => Promise<void>) =>
        callback(),
    } as any,
  };
}

describe('API key migration', () => {
  it('落库失败时不调用 scrub，旧密钥仍是唯一且完整的副本', async () => {
    const settings: Record<string, unknown> = { apiPool: [entry()] };
    const persistSettings = vi.fn(() => true);
    const { db } = fakeDb({ failWrite: true });

    const outcome = await migrateApiKeysToDexie({ settings, persistSettings, db });

    expect(outcome).toMatchObject({
      status: 'failed',
      stage: 'write',
      legacyKeysRetained: true,
    });
    expect(persistSettings).not.toHaveBeenCalled();
    expect((settings.apiPool as StoredApiEntry[])[0].apiKey).toBe('sk-legacy-only-copy');
    expect(settings[API_KEYS_MIGRATED_FLAG]).toBeUndefined();
  });

  it('localStorage scrub 失败时保留旧副本且不留下完成标志', async () => {
    const settings: Record<string, unknown> = { apiPool: [entry()] };
    const { db, rows } = fakeDb();

    const outcome = await migrateApiKeysToDexie({
      settings,
      persistSettings: () => false,
      db,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      stage: 'scrub',
      legacyKeysRetained: true,
    });
    expect(rows.get('ep-1')?.apiKey).toBe('sk-legacy-only-copy');
    expect((settings.apiPool as StoredApiEntry[])[0].apiKey).toBe('sk-legacy-only-copy');
    expect(settings[API_KEYS_MIGRATED_FLAG]).toBeUndefined();
  });

  it('已迁移启动从 Dexie 水合密钥而不依赖 localStorage', async () => {
    const settings: Record<string, unknown> = {
      [API_KEYS_MIGRATED_FLAG]: 1,
      apiPool: [entry('')],
    };
    const { db, rows } = fakeDb();
    rows.set('ep-1', {
      id: 'ep-1',
      name: 'Primary',
      provider: 'chat',
      baseUrl: 'https://api.example.test',
      apiKey: 'sk-from-indexeddb',
      defaultModel: 'model-1',
      models: ['model-1'],
      timeout: 60000,
    });

    const outcome = await migrateApiKeysToDexie({
      settings,
      persistSettings: vi.fn(() => true),
      db,
    });

    expect(outcome.status).toBe('already-migrated');
    expect(outcome.entries[0].apiKey).toBe('sk-from-indexeddb');
  });
});
