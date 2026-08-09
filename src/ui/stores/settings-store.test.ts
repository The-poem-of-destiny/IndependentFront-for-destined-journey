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
    // D22（内容-引擎分离波 1）：presets 镜像已删，真源在 Dexie（usePresets composable）；
    // settings 只留 activePresetId。与 worldBooks 同口径 —— 不留默认值避免消费端误以为是真相。
    expect(keys).not.toContain('presets');
    expect(keys).toContain('activePresetId');
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

  // ═══ 图像设置：构造完成的那一拍就必须是合法袋子 ═══
  //
  // image-settings-migration.ts 的文件头写着「必须在 ref() 之前，否则设置页那一拍会
  // 炸在 undefined 上」—— 那是一条**关于 store 怎么接线**的断言，而此前只有纯函数级
  // 用例：把 settings-store 里那两行删掉，纯函数测试一条都不会红。

  /** 用一份指定的 localStorage 内容重新构造一个 store（迁移只在构造期跑一次） */
  function bootWith(payload: Record<string, unknown>) {
    store_.clear();
    store_.set('fated-poem-settings', JSON.stringify(payload));
    setActivePinia(createPinia());
    return useSettingsStore();
  }

  it('v1 平铺档案：useSettingsStore() 返回时已是袋子形状，旧平铺键一个不剩', () => {
    const s = bootWith({
      imageEndpointId: 'ep_nai',
      imageModel: 'nai-diffusion-3',
      imageSampler: 'k_dpmpp_2m',
      imageMaxPerMessage: 5,
      imageMaxPerHour: 7,
      imageQualitySuffix: 'mine',
    });

    expect(s.settings.imageNovelai).toEqual({
      endpointId: 'ep_nai',
      model: 'nai-diffusion-3',
      sampler: 'k_dpmpp_2m',
      noiseSchedule: 'karras',
      ucPreset: 0,
      tier: 'unset',
      maxPerMessage: 5,
      maxPerHour: 7,
    });
    expect(s.settings.imageDialectOverrides).toEqual({
      'danbooru-anime': { qualitySuffix: 'mine' },
    });
    for (const key of ['imageEndpointId', 'imageModel', 'imageSampler', 'imageQualitySuffix']) {
      expect(key in s.settings).toBe(false);
    }
  });

  it('🔴 已迁过的档案里袋子被写坏 → 构造时就修好（此前只有带旧键时才修）', () => {
    // 症状不在这里：下游 checkQuota 读 `s.imageNovelai.maxPerMessage`，
    // 袋子是 null / 数字时直接 TypeError 炸在 admitAndEnqueue 里。
    const s = bootWith({ imageNovelai: null, imageComfy: 5, imageDialectOverrides: 'nope' });

    expect(s.settings.imageNovelai.maxPerMessage).toBe(2);
    expect(s.settings.imageComfy.baseUrl).toBe('http://127.0.0.1:8188');
    expect(s.settings.imageDialectOverrides).toEqual({});
  });

  it('🔴 袋内缺字段用 getDefaults() 补齐 —— 浅合并只盖一层，缺的格不会自己出现', () => {
    const s = bootWith({ imageNovelai: { endpointId: 'ep', maxPerMessage: 4 } });

    // 模块兜底那份 model 是空串；这里必须是生产默认值 → 证明 store 确实把 defaults 传了进去
    expect(s.settings.imageNovelai.model).toBe('nai-diffusion-4-5-full');
    expect(s.settings.imageNovelai.tier).toBe('unset');
    expect(s.settings.imageNovelai.maxPerHour).toBe(20);
    // 用户存过的两格原样保留
    expect(s.settings.imageNovelai.endpointId).toBe('ep');
    expect(s.settings.imageNovelai.maxPerMessage).toBe(4);
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
