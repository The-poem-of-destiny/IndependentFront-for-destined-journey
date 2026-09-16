import { getDatabase } from '@engine/database';
import type { ApiEndpoint } from '@engine/types';
import type {
  ApiConfigMigrationRecord,
  ApiSource,
  ApiSourceKind,
  ImageApiConnection,
} from '@engine/types-api';
import { parseApiSource } from '@engine/api/source-config';

const API_CONFIG_MIGRATION_ID = 'api-configuration-v2';

function legacyKind(row: ApiEndpoint): ApiSourceKind | 'image' {
  if (row.kind === 'embedding' || row.provider === 'embedding') return 'embedding';
  if (row.kind === 'reranker' || row.provider === 'reranker') return 'reranker';
  if (row.provider === 'image') return 'image';
  return 'llm';
}

function sourceFromRow(row: ApiEndpoint): ApiSource {
  const kind = legacyKind(row);
  if (kind === 'image') throw new Error('Image endpoints are migrated separately');
  return parseApiSource({
    ...row,
    // Legacy UI allowed an empty display name. Normalize only at the migration boundary; new
    // saves still go through the strict parser and cannot create another unnamed row.
    name: row.name?.trim() || row.id,
    kind,
    protocol:
      row.protocol ??
      (kind === 'embedding'
        ? 'openai-embeddings'
        : kind === 'reranker'
          ? 'openai-rerank'
          : 'openai-chat'),
    timeoutMs: row.timeoutMs ?? row.timeout ?? 60_000,
    bodyOverrides: row.bodyOverrides ?? {},
    bodyOmitPaths: row.bodyOmitPaths ?? [],
    revision: row.revision ?? 1,
  });
}

function storedSource(source: ApiSource): ApiEndpoint {
  return {
    ...source,
    provider: source.kind,
    timeout: source.timeoutMs,
  };
}

/**
 * Idempotently converts legacy rows after the old localStorage key migration has hydrated Dexie.
 * The transaction checkpoint prevents a later stale localStorage snapshot from reviving image rows.
 */
export async function migrateApiConfiguration(): Promise<{
  sources: ApiSource[];
  imageConnections: ImageApiConnection[];
}> {
  const db = getDatabase();
  await db.transaction(
    'rw',
    db.apiEndpoints,
    db.imageApiConnections,
    db.apiConfigMigrations,
    async () => {
      const rows = await db.apiEndpoints.toArray();
      for (const row of rows) {
        if (legacyKind(row) === 'image') {
          const existing = await db.imageApiConnections.get(row.id);
          await db.imageApiConnections.put({
            id: row.id,
            name: row.name,
            provider: 'novelai',
            baseUrl: 'https://image.novelai.net',
            apiKey: row.apiKey || existing?.apiKey || '',
            timeoutMs: row.timeoutMs ?? row.timeout ?? existing?.timeoutMs ?? 120_000,
            revision: Math.max(existing?.revision ?? 0, row.revision ?? 0, 1),
          });
          await db.apiEndpoints.delete(row.id);
        } else {
          await db.apiEndpoints.put(storedSource(sourceFromRow(row)));
        }
      }
      const previousCheckpoint = await db.apiConfigMigrations.get(API_CONFIG_MIGRATION_ID);
      if (previousCheckpoint?.status !== 'cleaned') {
        const checkpoint: ApiConfigMigrationRecord = {
          id: API_CONFIG_MIGRATION_ID,
          version: 2,
          status: 'written',
          updatedAt: Date.now(),
          details: { apiPoolRemovedFromLocalStorage: true },
        };
        await db.apiConfigMigrations.put(checkpoint);
      }
    },
  );
  const [rows, imageConnections] = await Promise.all([
    db.apiEndpoints.toArray(),
    db.imageApiConnections.toArray(),
  ]);
  return { sources: rows.map(sourceFromRow), imageConnections };
}

export function sourceForStorage(source: ApiSource): ApiEndpoint {
  return storedSource(parseApiSource(source));
}
