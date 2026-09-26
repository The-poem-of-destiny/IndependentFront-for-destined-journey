import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  deleteApiEndpoint,
  deleteImageApiConnection,
  getApiEndpoints,
  getImageApiConnections,
  saveApiEndpoint,
  saveImageApiConnection,
} from '@engine/database';
import type { ApiEndpoint } from '@engine/types';
import { parseApiSource } from '@engine/api/source-config';
import type { ApiSource, ApiSourceKind, ImageApiConnection } from '@engine/types-api';
import { credentialIdFor } from '@engine/api-rpm-limiter';
import { maskApiKey } from './api-key-migration';
import { detach } from './db-write';
import { useSettingsStore, type ApiEntry } from './settings-store';

export function sourceForStorage(source: ApiSource): ApiEndpoint {
  const parsed = parseApiSource(source);
  return {
    ...parsed,
    provider: parsed.kind,
    timeout: parsed.timeoutMs,
  };
}

function toProjection(source: ApiSource): ApiEntry {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    maskedKey: maskApiKey(source.apiKey),
    model: source.defaultModel,
    models: [...source.models],
    apiType: source.kind === 'llm' ? 'chat' : source.kind,
    kind: source.kind,
    protocol: source.protocol,
    timeoutMs: source.timeoutMs,
    // Pinia wraps nested source data in proxies. Browser structuredClone rejects those proxies,
    // while the settings projection is deliberately JSON-shaped, so use the shared detach seam.
    bodyOverrides: detach(source.bodyOverrides),
    bodyOmitPaths: [...source.bodyOmitPaths],
    revision: source.revision,
    contextWindowTokens: source.kind === 'llm' ? source.contextWindowTokens : undefined,
    anthropicVersion: source.kind === 'llm' ? source.anthropicVersion : undefined,
    anthropicBeta: source.kind === 'llm' ? source.anthropicBeta : undefined,
  };
}

export const useApiSourceStore = defineStore('api-sources', () => {
  const sources = ref<ApiSource[]>([]);
  const imageConnections = ref<ImageApiConnection[]>([]);
  const initialized = ref(false);
  const error = ref<string | null>(null);
  /**
   * 加载时被跳过的旧格式行 id（缺 kind/protocol 等，无法识别）。
   *
   * 🔴 旧行**不自动迁移、不自动删除**（「rejects legacy rows without rewriting them」是
   * 刻意设计）：这里只记住 id 供 UI 提示，清理必须由用户显式触发（`purgeInvalidSources`）。
   * 之所以要单独记：一条坏行不能让整批加载抛错 —— 那会连「保存 / 删除」都做不了
   * （那些入口都先 `await initialize()`），等于把 API 分区锁死。
   */
  const invalidSourceIds = ref<string[]>([]);
  let initPromise: Promise<void> | null = null;

  const llmSources = computed(() => sources.value.filter((source) => source.kind === 'llm'));
  const embeddingSources = computed(() =>
    sources.value.filter((source) => source.kind === 'embedding'),
  );
  const rerankerSources = computed(() =>
    sources.value.filter((source) => source.kind === 'reranker'),
  );

  function publishProjection() {
    useSettingsStore().settings.apiPool = sources.value.map(toProjection);
  }

  async function credentialId(connection: { baseUrl: string; apiKey: string; name: string }) {
    return credentialIdFor({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      label: connection.name,
    });
  }

  async function credentialStillReferenced(id: string, exceptId?: string): Promise<boolean> {
    for (const connection of [...sources.value, ...imageConnections.value]) {
      if (connection.id === exceptId) continue;
      if ((await credentialId(connection)) === id) return true;
    }
    return false;
  }

  async function migrateRpmPolicy(
    previous: { id: string; baseUrl: string; apiKey: string; name: string } | undefined,
    next: { baseUrl: string; apiKey: string; name: string },
  ) {
    if (!previous) return;
    const [previousId, nextId] = await Promise.all([credentialId(previous), credentialId(next)]);
    if (previousId === nextId) return;
    const settings = useSettingsStore();
    const oldPolicy = settings.apiRpmPolicies.find((policy) => policy.credentialId === previousId);
    if (!oldPolicy) return;
    const targetExists = settings.apiRpmPolicies.some((policy) => policy.credentialId === nextId);
    if (!targetExists) await settings.updateRpmPolicy(nextId, oldPolicy.rpmLimit);
    if (!(await credentialStillReferenced(previousId, previous.id))) {
      await settings.updateRpmPolicy(previousId, undefined);
    }
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await useSettingsStore().initApiSecrets();
        const [storedSources, storedImageConnections] = await Promise.all([
          getApiEndpoints(),
          getImageApiConnections(),
        ]);
        // 🔴 逐行解析、坏行跳过：一条旧格式行（缺 kind/protocol）不能让整批加载抛错，
        //    否则所有先 `await initialize()` 的入口（保存 / 删除）全被连坐锁死。
        //    坏行不重写不删除，只记 id，等用户显式清理。
        const valid: ApiSource[] = [];
        const invalid: string[] = [];
        for (const raw of storedSources) {
          try {
            valid.push(parseApiSource(raw));
          } catch (cause) {
            const id = (raw as { id?: unknown })?.id;
            if (typeof id === 'string' && id) invalid.push(id);
            console.warn('[api-sources] 跳过无法识别的旧配置行:', cause);
          }
        }
        sources.value = valid;
        invalidSourceIds.value = invalid;
        imageConnections.value = storedImageConnections.map((connection) => detach(connection));
        publishProjection();
        error.value = null;
        initialized.value = true;
      } catch (cause) {
        error.value = String(cause);
        throw cause;
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  }

  /** 显式清理无法识别的旧配置行（用户点按钮才调；不重写有效行）。返回清理条数。 */
  async function purgeInvalidSources(): Promise<number> {
    await initialize();
    const ids = [...invalidSourceIds.value];
    for (const id of ids) await deleteApiEndpoint(id);
    invalidSourceIds.value = [];
    return ids.length;
  }

  async function saveSource(input: ApiSource): Promise<ApiSource> {
    await initialize();
    const previous = sources.value.find((candidate) => candidate.id === input.id);
    const source = parseApiSource({
      ...input,
      revision: (previous?.revision ?? input.revision ?? 0) + 1,
    });
    await saveApiEndpoint(sourceForStorage(source));
    const index = sources.value.findIndex((candidate) => candidate.id === source.id);
    if (index >= 0) sources.value[index] = source;
    else sources.value.push(source);
    await migrateRpmPolicy(previous, source);
    publishProjection();
    return source;
  }

  async function removeSource(id: string): Promise<void> {
    await initialize();
    const previous = sources.value.find((source) => source.id === id);
    await deleteApiEndpoint(id);
    sources.value = sources.value.filter((source) => source.id !== id);
    if (previous) {
      const previousId = await credentialId(previous);
      if (!(await credentialStillReferenced(previousId))) {
        await useSettingsStore().updateRpmPolicy(previousId, undefined);
      }
    }
    publishProjection();
  }

  async function saveImageConnection(input: ImageApiConnection): Promise<ImageApiConnection> {
    await initialize();
    const previous = imageConnections.value.find((candidate) => candidate.id === input.id);
    const connection: ImageApiConnection = {
      ...detach(input),
      revision: (previous?.revision ?? input.revision ?? 0) + 1,
    };
    await saveImageApiConnection(connection);
    const index = imageConnections.value.findIndex((candidate) => candidate.id === connection.id);
    if (index >= 0) imageConnections.value[index] = connection;
    else imageConnections.value.push(connection);
    await migrateRpmPolicy(previous, connection);
    return connection;
  }

  async function removeImageConnection(id: string): Promise<void> {
    await initialize();
    const previous = imageConnections.value.find((source) => source.id === id);
    await deleteImageApiConnection(id);
    imageConnections.value = imageConnections.value.filter((source) => source.id !== id);
    if (previous) {
      const previousId = await credentialId(previous);
      if (!(await credentialStillReferenced(previousId))) {
        await useSettingsStore().updateRpmPolicy(previousId, undefined);
      }
    }
  }

  function byKind(kind: ApiSourceKind): ApiSource[] {
    return sources.value.filter((source) => source.kind === kind);
  }

  return {
    sources,
    imageConnections,
    invalidSourceIds,
    llmSources,
    embeddingSources,
    rerankerSources,
    initialized,
    error,
    initialize,
    purgeInvalidSources,
    saveSource,
    removeSource,
    saveImageConnection,
    removeImageConnection,
    byKind,
    credentialStillReferenced,
  };
});
