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

vi.mock('@engine/database', () => ({
  deleteApiEndpoint: vi.fn(async () => undefined),
  deleteImageApiConnection: vi.fn(async () => undefined),
  getDatabase: vi.fn(),
  saveApiEndpoint,
  saveImageApiConnection,
}));

vi.mock('./api-key-migration', () => ({
  maskApiKey: (key: string) => `${key.slice(0, 2)}***`,
}));

vi.mock('./api-config-migration', () => ({
  migrateApiConfiguration: async () => ({ sources: [], imageConnections: [] }),
  sourceForStorage: (source: unknown) => source,
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
