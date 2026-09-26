import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';

const state = vi.hoisted(() => ({
  settings: {
    apiPool: [] as unknown[],
    agents: {},
    embeddingSourceId: '',
    rerankerSourceId: '',
  },
}));

const saveApiEndpoint = vi.hoisted(() => vi.fn(async () => undefined));
const saveImageApiConnection = vi.hoisted(() => vi.fn(async () => undefined));
const deleteApiEndpoint = vi.hoisted(() => vi.fn(async () => undefined));
const getApiEndpoints = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const getImageApiConnections = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock('@engine/database', () => ({
  deleteApiEndpoint,
  deleteImageApiConnection: vi.fn(async () => undefined),
  getApiEndpoints,
  getImageApiConnections,
  saveApiEndpoint,
  saveImageApiConnection,
}));

vi.mock('./settings-store', () => ({
  useSettingsStore: () => ({
    settings: state.settings,
    apiRpmPolicies: [],
    initApiSecrets: async () => undefined,
    saveNow: () => false,
    updateRpmPolicy: vi.fn(async () => undefined),
  }),
}));

import { useApiSourceStore } from './api-source-store';

describe('api-source-store Vue proxy boundaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.settings.apiPool = [];
    saveApiEndpoint.mockClear();
    saveImageApiConnection.mockClear();
    deleteApiEndpoint.mockClear();
    getApiEndpoints.mockReset();
    getApiEndpoints.mockResolvedValue([]);
    getImageApiConnections.mockReset();
    getImageApiConnections.mockResolvedValue([]);
  });

  const VALID_LLM = {
    id: 'good-llm',
    name: 'Good LLM',
    kind: 'llm',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-key',
    defaultModel: 'model-a',
    models: ['model-a'],
    timeoutMs: 60_000,
  };

  it('🔴 一条旧格式行不再连坐：坏行跳过不抛，有效行照常加载，且不重写坏行', async () => {
    const legacy = {
      id: 'legacy-chat',
      name: 'Legacy chat',
      provider: 'chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret-key',
      defaultModel: 'model-a',
      models: ['model-a'],
      timeout: 60_000,
    };
    getApiEndpoints.mockResolvedValue([legacy, VALID_LLM]);

    const store = useApiSourceStore();
    // 修之前这里会 reject（'kind must be a non-empty string'），把保存/删除全锁死
    await expect(store.initialize()).resolves.toBeUndefined();

    expect(store.sources.map((entry) => entry.id)).toEqual(['good-llm']);
    expect(store.invalidSourceIds).toEqual(['legacy-chat']);
    // 刻意设计：不自动迁移 / 不自动删除旧行
    expect(saveApiEndpoint).not.toHaveBeenCalled();
    expect(deleteApiEndpoint).not.toHaveBeenCalled();
  });

  it('purgeInvalidSources 只删被跳过的坏行（用户显式触发）', async () => {
    getApiEndpoints.mockResolvedValue([
      { id: 'legacy-chat', name: 'Legacy', provider: 'chat', baseUrl: 'https://x/v1', apiKey: '' },
      VALID_LLM,
    ]);
    const store = useApiSourceStore();
    await store.initialize();

    expect(await store.purgeInvalidSources()).toBe(1);
    expect(deleteApiEndpoint).toHaveBeenCalledWith('legacy-chat');
    expect(store.invalidSourceIds).toEqual([]);
    expect(store.sources.map((entry) => entry.id)).toEqual(['good-llm']);
  });

  it('publishes nested body overrides after Pinia makes the saved source reactive', async () => {
    const store = useApiSourceStore();
    await store.saveSource({
      id: 'llm-a',
      name: 'LLM A',
      kind: 'llm',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret-key',
      defaultModel: 'model-a',
      models: ['model-a'],
      timeoutMs: 60_000,
      bodyOverrides: { reasoning: { effort: 'high' } },
      bodyOmitPaths: [],
    });

    expect(state.settings.apiPool).toHaveLength(1);
    expect(state.settings.apiPool[0]).toMatchObject({
      bodyOverrides: { reasoning: { effort: 'high' } },
    });
    expect(saveApiEndpoint).toHaveBeenCalledOnce();
  });

  it('accepts a reactive image connection without passing its proxy to structured clone', async () => {
    const store = useApiSourceStore();
    await store.saveImageConnection(
      reactive({
        id: 'novelai-a',
        name: 'NovelAI A',
        provider: 'novelai' as const,
        baseUrl: 'https://image.novelai.net',
        apiKey: 'image-key',
        timeoutMs: 60_000,
      }),
    );

    expect(saveImageApiConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'novelai-a', revision: 1 }),
    );
  });
});
