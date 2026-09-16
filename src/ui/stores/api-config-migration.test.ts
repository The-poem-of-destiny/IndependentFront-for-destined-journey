import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAllData, getDatabase } from '@engine/database';
import type { ApiEndpoint } from '@engine/types';
import { migrateApiConfiguration } from './api-config-migration';

function legacy(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'legacy-chat',
    name: 'Legacy chat',
    provider: 'chat',
    baseUrl: 'https://api.example/v1',
    apiKey: 'secret',
    defaultModel: 'model',
    models: ['model'],
    timeout: 60_000,
    ...overrides,
  };
}

describe('API configuration v2 migration', () => {
  afterEach(async () => clearAllData());

  it('keeps source IDs and moves every image credential into the image table idempotently', async () => {
    const db = getDatabase();
    await db.apiEndpoints.bulkPut([
      legacy(),
      legacy({ id: 'unnamed', name: '' }),
      legacy({
        id: 'rerank-a',
        name: 'Reranker',
        provider: 'reranker',
        kind: 'reranker',
        protocol: 'openai-rerank',
      }),
      legacy({ id: 'image-a', name: 'NAI A', provider: 'image', apiKey: 'key-a' }),
      legacy({ id: 'image-b', name: 'NAI B', provider: 'image', apiKey: 'key-b' }),
    ]);

    const first = await migrateApiConfiguration();
    expect(first.sources).toHaveLength(3);
    expect(first.sources.find((source) => source.id === 'legacy-chat')).toMatchObject({
      id: 'legacy-chat',
      kind: 'llm',
      protocol: 'openai-chat',
    });
    expect(first.sources.find((source) => source.id === 'rerank-a')).toMatchObject({
      kind: 'reranker',
      protocol: 'openai-rerank',
    });
    expect(first.sources.find((source) => source.id === 'unnamed')?.name).toBe('unnamed');
    expect(first.imageConnections.map((row) => [row.id, row.apiKey])).toEqual([
      ['image-a', 'key-a'],
      ['image-b', 'key-b'],
    ]);

    const second = await migrateApiConfiguration();
    expect(second.imageConnections).toHaveLength(2);
    expect(await db.apiEndpoints.get('image-a')).toBeUndefined();
    expect(await db.apiConfigMigrations.get('api-configuration-v2')).toMatchObject({
      status: 'written',
    });
  });
});
