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

vi.mock('@engine/persistence/database', () => ({
  deleteApiEndpoint,
  deleteImageApiConnection: vi.fn(async () => undefined),
  getApiEndpoints,
  getImageApiConnections,
  saveApiEndpoint,
  saveImageApiConnection,
}));

vi.mock('../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: state.settings,
    apiRpmPolicies: [],
    initApiSecrets: async () => undefined,
    saveNow: () => false,
    updateRpmPolicy: vi.fn(async () => undefined),
  }),
}));

import {
  clearApiSourceBindings,
  findApiSourceBindings,
  useApiSourceStore,
} from '../../../src/ui/stores/api-source-store';

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
      headerOverrides: {},
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

describe('S-09 删除 API 源：列出并清除指向它的用户绑定', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getApiEndpoints.mockReset();
    getImageApiConnections.mockReset();
    getImageApiConnections.mockResolvedValue([]);
  });

  it('findApiSourceBindings 只列用户覆写层与检索绑定', () => {
    const bindings = findApiSourceBindings(
      {
        agents: {
          story: { model: 'x' },
          vars_update: { model: 'y' },
          image_prompt: { model: 'x' },
        },
        embeddingSourceId: 'x',
        rerankerSourceId: 'z',
      },
      'x',
    );
    expect(bindings).toEqual({ agentIds: ['story', 'image_prompt'], retrieval: ['embedding'] });
  });

  it('clearApiSourceBindings：Agent 的 model 删键（回到跟随默认），其余字段保留；检索绑定置空', () => {
    const settings = {
      agents: { story: { model: 'x', temperature: 0.5 }, plot_outline: { model: 'x' } } as Record<
        string,
        Record<string, unknown>
      >,
      embeddingSourceId: 'x',
      rerankerSourceId: 'x',
    };
    clearApiSourceBindings(settings, 'x');
    expect(settings.agents.story).toEqual({ temperature: 0.5 });
    expect(settings.agents).not.toHaveProperty('plot_outline');
    expect(settings.embeddingSourceId).toBe('');
    expect(settings.rerankerSourceId).toBe('');
  });

  it('removeSource 删除后清掉绑定，不再留下失效绑定', async () => {
    getApiEndpoints.mockResolvedValue([
      {
        id: 'doomed',
        name: 'Doomed',
        kind: 'llm',
        protocol: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        defaultModel: 'm',
        models: ['m'],
        timeoutMs: 60_000,
      },
    ]);
    state.settings.agents = { story: { model: 'doomed' } };
    state.settings.rerankerSourceId = 'doomed';
    const store = useApiSourceStore();
    await store.removeSource('doomed');
    expect(deleteApiEndpoint).toHaveBeenCalledWith('doomed');
    expect(state.settings.agents).toEqual({});
    expect(state.settings.rerankerSourceId).toBe('');
  });
});
