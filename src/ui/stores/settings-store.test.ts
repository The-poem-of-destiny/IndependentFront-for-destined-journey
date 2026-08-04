/**
 * settings-store 冒烟测试
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { serializeSettingsForLocalStorage, useSettingsStore } from './settings-store';
import { getApiEndpoints, getDatabase } from '@engine/database';

// Mock localStorage for Node test environment
const store_ = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store_.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store_.set(k, v);
  },
  removeItem: (k: string) => {
    store_.delete(k);
  },
  clear: () => {
    store_.clear();
  },
  get length() {
    return store_.size;
  },
  key: (i: number) => [...store_.keys()][i] ?? null,
});

describe('settings-store', () => {
  let store: ReturnType<typeof useSettingsStore>;
  beforeEach(async () => {
    store_.clear();
    await getDatabase().apiEndpoints.clear();
    setActivePinia(createPinia());
    store = useSettingsStore();
  });

  afterEach(async () => {
    await getDatabase().apiEndpoints.clear();
  });

  it('应创建 store 实例', () => {
    expect(store).toBeDefined();
  });

  it('settings 应为响应式对象', () => {
    expect(store.settings).toBeDefined();
    expect(Array.isArray(store.settings.apiPool)).toBe(true);
    expect(store.settings.plotMode).toBe('off');
    expect(store.settings.memoryRecallCount).toBe(20);
  });

  it('修改 settings 应自动写 localStorage', async () => {
    await store.initApiSecrets();
    store.settings.apiPool = [
      {
        id: '1',
        name: 'test',
        baseUrl: 'http://a',
        apiKey: 'k',
        maskedKey: '***',
        model: 'm',
        models: ['m'],
        apiType: 'chat',
      },
    ];
    await nextTick();
    const raw = localStorage.getItem('fated-poem-settings');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.apiPool).toHaveLength(1);
    expect(parsed.apiPool[0].apiKey).toBe('');
    expect(raw).not.toContain('"k"');
  });

  it('API 密钥写入 Dexie，运行时可读但 localStorage 只留脱敏元数据', async () => {
    await store.initApiSecrets();
    await store.saveApiEntry({
      id: 'secure-1',
      name: 'secure',
      baseUrl: 'https://api.example.test',
      apiKey: 'sk-runtime-secret',
      maskedKey: 'sk-***cret',
      model: 'model-1',
      models: ['model-1'],
      apiType: 'chat',
    });

    expect(store.settings.apiPool[0].apiKey).toBe('sk-runtime-secret');
    expect((await getApiEndpoints())[0].apiKey).toBe('sk-runtime-secret');
    const raw = localStorage.getItem('fated-poem-settings')!;
    expect(raw).not.toContain('sk-runtime-secret');
    expect(JSON.parse(raw).apiPool[0].apiKey).toBe('');
  });

  it('只擦除已迁移的 apiPool 密钥，不删除未知嵌套数据', () => {
    const serialized = serializeSettingsForLocalStorage({
      apiPool: [{ id: 'managed', apiKey: 'sk-managed' }],
      extensionData: { apiKey: 'not-an-api-pool-secret' },
    });

    expect(JSON.parse(serialized)).toEqual({
      apiPool: [{ id: 'managed', apiKey: '' }],
      extensionData: { apiKey: 'not-an-api-pool-secret' },
    });
  });

  it('旧 localStorage 密钥校验落库后才擦除，并在运行时恢复', async () => {
    store_.set(
      'fated-poem-settings',
      JSON.stringify({
        plotMode: 'main',
        apiPool: [
          {
            id: 'legacy-1',
            name: 'legacy',
            baseUrl: 'https://legacy.example.test',
            apiKey: 'sk-legacy-secret',
            maskedKey: 'sk-***cret',
            model: 'legacy-model',
            models: ['legacy-model'],
            apiType: 'chat',
          },
        ],
      }),
    );
    setActivePinia(createPinia());
    const legacyStore = useSettingsStore();

    const outcome = await legacyStore.initApiSecrets();

    expect(outcome.status).toBe('migrated');
    expect(legacyStore.settings.apiPool[0].apiKey).toBe('sk-legacy-secret');
    expect((await getApiEndpoints())[0].apiKey).toBe('sk-legacy-secret');
    expect(localStorage.getItem('fated-poem-settings')).not.toContain('sk-legacy-secret');
  });

  it('再次创建 store 应从 localStorage 恢复', () => {
    store.settings.plotMode = 'main';
    const store2 = useSettingsStore();
    expect(store2.settings.plotMode).toBe('main');
  });

  it('resetAll 应恢复默认值', () => {
    store.settings.plotMode = 'main';
    store.resetAll();
    expect(store.settings.plotMode).toBe('off');
  });

  it('getStorageUsage 应返回用量信息', async () => {
    const info = await store.getStorageUsage();
    if (info) {
      expect(info.used).toBeGreaterThanOrEqual(0);
      expect(info.quota).toBeGreaterThan(0);
    }
  });

  it('settings 中所有默认字段应存在', () => {
    const keys = Object.keys(store.settings);
    expect(keys).toContain('apiPool');
    // Q-18: 12 张 per-Agent map 已合并成一张 `agents` 表
    expect(keys).toContain('agents');
    expect(keys).not.toContain('agentModels');
    expect(keys).toContain('presets');
    expect(keys).toContain('plotMode');
    expect(keys).toContain('plotDurationYears');
    expect(keys).toContain('plotDifficultyTier');
    expect(keys).toContain('plotAllowNonWorldbookNpc');
    expect(keys).toContain('plotGenrePreference');
    expect(keys).toContain('plotCustomPreference');
    expect(keys).toContain('plotFocusRegion');
    expect(keys).toContain('plotTabooContent');
    expect(keys).toContain('plotChapterCount');
    expect(keys).toContain('plotEventsPerChapter');
    expect(keys).toContain('memoryRecallCount');
    expect(keys).toContain('memoryCacheStrategy');
  });

  it('剧情系统新档默认值形状对齐 create-store', () => {
    expect(store.settings.plotMode).toBe('off');
    expect(store.settings.plotDurationYears).toBe(5);
    expect(store.settings.plotDifficultyTier).toBe('adaptive');
    expect(store.settings.plotAllowNonWorldbookNpc).toBe(true);
    expect(store.settings.plotGenrePreference).toEqual(['combat', 'social']);
    expect(store.settings.plotCustomPreference).toBe('');
    expect(store.settings.plotFocusRegion).toBe('');
    expect(store.settings.plotTabooContent).toBe('');
    expect(store.settings.plotChapterCount).toBe(0);
    expect(store.settings.plotEventsPerChapter).toBe(0);
  });
});
