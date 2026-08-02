import { getDatabase } from '@engine/database';
import type { ApiEndpoint } from '@engine/types';

type AppDatabase = ReturnType<typeof getDatabase>;

export const API_KEYS_MIGRATED_FLAG = 'apiKeysMigratedAt';

export interface StoredApiEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  maskedKey: string;
  model: string;
  models: string[];
  apiType: 'chat' | 'embedding';
  enableThinking?: boolean;
}

export type ApiKeyMigrationOutcome =
  | { status: 'already-migrated'; entries: StoredApiEntry[] }
  | { status: 'migrated'; entries: StoredApiEntry[]; keyCount: number }
  | {
      status: 'failed';
      stage: 'read' | 'write' | 'verify' | 'scrub';
      message: string;
      entries: StoredApiEntry[];
      legacyKeysRetained: boolean;
    };

export interface ApiKeyMigrationDeps {
  settings: Record<string, unknown>;
  /** Writes the redacted settings snapshot. Returning false means localStorage was not changed. */
  persistSettings: () => boolean;
  db?: AppDatabase;
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? `${key.slice(0, 3)}***` : '';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

function readEntries(settings: Record<string, unknown>): StoredApiEntry[] {
  const raw = settings.apiPool;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object'),
    )
    .map((entry) => {
      const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : '';
      return {
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
        apiKey,
        maskedKey:
          typeof entry.maskedKey === 'string' && entry.maskedKey
            ? entry.maskedKey
            : maskApiKey(apiKey),
        model: typeof entry.model === 'string' ? entry.model : '',
        models: Array.isArray(entry.models)
          ? entry.models.filter((model): model is string => typeof model === 'string')
          : [],
        apiType: entry.apiType === 'embedding' ? 'embedding' : 'chat',
        enableThinking: entry.enableThinking === true,
      };
    });
}

export function apiEntryToEndpoint(entry: StoredApiEntry): ApiEndpoint {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.apiType,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    defaultModel: entry.model,
    models: [...entry.models],
    timeout: 60000,
    enableThinking: entry.enableThinking,
  };
}

export function apiEndpointToEntry(endpoint: ApiEndpoint, local?: StoredApiEntry): StoredApiEntry {
  const apiKey = endpoint.apiKey || local?.apiKey || '';
  return {
    id: endpoint.id,
    name: local?.name ?? endpoint.name,
    baseUrl: local?.baseUrl ?? endpoint.baseUrl,
    apiKey,
    maskedKey: maskApiKey(apiKey),
    model: local?.model ?? endpoint.defaultModel,
    models: local?.models?.length ? [...local.models] : [...(endpoint.models ?? [])],
    apiType:
      local?.apiType ?? (endpoint.provider === 'embedding' ? 'embedding' : ('chat' as const)),
    enableThinking: local?.enableThinking ?? endpoint.enableThinking ?? false,
  };
}

function mergeEntries(rows: ApiEndpoint[], localEntries: StoredApiEntry[]): StoredApiEntry[] {
  const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
  const merged = rows.map((row) => apiEndpointToEntry(row, localById.get(row.id)));
  const rowIds = new Set(rows.map((row) => row.id));
  for (const entry of localEntries) {
    if (!rowIds.has(entry.id)) merged.push(entry);
  }
  return merged;
}

/**
 * Moves legacy `settings.apiPool[*].apiKey` values into Dexie. The source is scrubbed only after
 * the transaction has been read back and verified. Any failure leaves the legacy localStorage
 * string untouched so it remains the recoverable copy on the next startup.
 */
export async function migrateApiKeysToDexie(
  deps: ApiKeyMigrationDeps,
): Promise<ApiKeyMigrationOutcome> {
  const localEntries = readEntries(deps.settings);
  const legacyKeysRetained = localEntries.some((entry) => Boolean(entry.apiKey));
  const ids = localEntries.map((entry) => entry.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return {
      status: 'failed',
      stage: 'read',
      message: 'API endpoint IDs are missing or duplicated',
      entries: localEntries,
      legacyKeysRetained,
    };
  }

  let db: AppDatabase;
  let existingRows: ApiEndpoint[];
  try {
    db = deps.db ?? getDatabase();
    existingRows = await db.apiEndpoints.toArray();
  } catch (error) {
    return {
      status: 'failed',
      stage: 'read',
      message: String(error),
      entries: localEntries,
      legacyKeysRetained,
    };
  }

  // A flag is not enough if a previous localStorage write restored a key-bearing snapshot.
  if (deps.settings[API_KEYS_MIGRATED_FLAG] && !legacyKeysRetained) {
    return { status: 'already-migrated', entries: mergeEntries(existingRows, localEntries) };
  }

  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const rows = localEntries.map((entry) => {
    const existing = existingById.get(entry.id);
    return apiEntryToEndpoint({
      ...entry,
      apiKey: entry.apiKey || existing?.apiKey || '',
    });
  });

  try {
    await db.transaction('rw', db.apiEndpoints, async () => {
      if (rows.length > 0) await db.apiEndpoints.bulkPut(rows);
    });
  } catch (error) {
    return {
      status: 'failed',
      stage: 'write',
      message: String(error),
      entries: localEntries,
      legacyKeysRetained,
    };
  }

  let allRows: ApiEndpoint[];
  try {
    const readBack = await db.apiEndpoints.bulkGet(rows.map((row) => row.id));
    for (let index = 0; index < rows.length; index += 1) {
      const expected = rows[index];
      const actual = readBack[index];
      if (!actual || actual.id !== expected.id || actual.apiKey !== expected.apiKey) {
        throw new Error(`API endpoint verification failed: ${expected.id}`);
      }
    }
    allRows = await db.apiEndpoints.toArray();
  } catch (error) {
    return {
      status: 'failed',
      stage: 'verify',
      message: String(error),
      entries: localEntries,
      legacyKeysRetained,
    };
  }

  const previousFlag = deps.settings[API_KEYS_MIGRATED_FLAG];
  deps.settings[API_KEYS_MIGRATED_FLAG] = Date.now();
  if (!deps.persistSettings()) {
    if (previousFlag === undefined) delete deps.settings[API_KEYS_MIGRATED_FLAG];
    else deps.settings[API_KEYS_MIGRATED_FLAG] = previousFlag;
    return {
      status: 'failed',
      stage: 'scrub',
      message: 'Unable to replace the legacy localStorage snapshot',
      entries: mergeEntries(allRows, localEntries),
      legacyKeysRetained,
    };
  }

  return {
    status: 'migrated',
    entries: mergeEntries(allRows, localEntries),
    keyCount: rows.filter((row) => Boolean(row.apiKey)).length,
  };
}
