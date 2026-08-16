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
    await getDatabase().apiEndpoints.clear();
    // 🔴 清 localStorage 必须**紧贴 store 构造**，中间不许有 await。
    //
    //    此前它在 `await` 之前，于是留出了一个让出事件循环的窗口 —— 上一轮 store
    //    构造期那个 `setTimeout(0)` 启动任务会在窗口里落地。它经
    //    `loadAgentProjectDefaults → content-store → beautifier-store.refreshPresetRules`
    //    调 `useSettingsStore().saveNow()`，而那个 `useSettingsStore()` 解析的是
    //    **当时活跃的 pinia**（还是上一轮的），于是把上一轮那份**脱敏**快照写回了
    //    刚清空的 localStorage。下一个 store 构造时读到它，`apiPool[0]` 成了上一轮的
    //    `apiKey: ''` 条目，`saveApiEntry` 于是把新条目 push 到 index 1 ——
    //    「API 密钥写入 Dexie…」那条用例便以 `apiPool[0].apiKey === ''` 偶发失败。
    //    只在全量 + CPU 高负载下复现（启动任务被拖慢到刚好落在这个窗口里）。
    store_.clear();
    setActivePinia(createPinia());
    store = useSettingsStore();
  });

  afterEach(async () => {
    // 销毁本轮 store：取消它构造期那个 `setTimeout(0)` 启动任务，少一个游荡的写入者。
    // （只能覆盖 beforeEach 建的这一个 —— 用例内部自建的 store 各自负责，
    //   所以上面 beforeEach 的「清空紧贴构造」才是真正的兜底。）
    store?.$dispose();
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
    expect(store.settings.developerMode).toBe(false);
  });

  it('开发者模式默认关闭，并随设置袋持久化', async () => {
    expect(store.settings.developerMode).toBe(false);

    store.settings.developerMode = true;
    await nextTick();

    const saved = JSON.parse(localStorage.getItem('fated-poem-settings')!);
    expect(saved.developerMode).toBe(true);

    store.resetAll();
    expect(store.settings.developerMode).toBe(false);
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
    expect(keys).toContain('developerMode');
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

  // ═══════════════════════════════════════════════════════════
  // 构造期启动任务（`setTimeout(0)`）的两条回归
  //
  // 同一个根因的两个症状：那个任务此前**绕开 `saveNow()` 直接写 localStorage**，
  // 而且**无主** —— 不随 store 销毁而取消。
  // 两条都用宏任务推进强制交错，不依赖机器负载。
  // ═══════════════════════════════════════════════════════════
  const drainMacrotasks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('启动任务不得在密钥迁移验证通过之前覆写 localStorage（老档唯一副本保护）', async () => {
    // 老档：密钥的**唯一副本**还在 localStorage；另有一个 presets 键触发镜像迁移。
    store_.set(
      'fated-poem-settings',
      JSON.stringify({
        presets: [],
        apiPool: [
          {
            id: 'legacy-1',
            name: 'legacy',
            baseUrl: 'https://legacy.example.test',
            apiKey: 'sk-only-copy',
            maskedKey: 'sk-***copy',
            model: 'legacy-model',
            models: ['legacy-model'],
            apiType: 'chat',
          },
        ],
      }),
    );
    setActivePinia(createPinia());
    const legacyStore = useSettingsStore();

    // 刻意**不**调 initApiSecrets —— 模拟启动任务先于迁移落地那一拍
    await drainMacrotasks(6);

    // 🔴 迁移尚未验证，localStorage 仍是唯一副本，一个字节都不许动。
    //    此前这里会被写成 `apiKey: ""`：Dexie 若写不进（无痕 / 配额 / IndexedDB 不可用），
    //    用户的密钥就永久没了。
    expect(localStorage.getItem('fated-poem-settings')).toContain('sk-only-copy');

    // 迁移跑完之后才允许脱敏落盘，且运行时仍读得到
    const outcome = await legacyStore.initApiSecrets();
    expect(outcome.status).toBe('migrated');
    expect(legacyStore.settings.apiPool[0].apiKey).toBe('sk-only-copy');
    expect(localStorage.getItem('fated-poem-settings')).not.toContain('sk-only-copy');
    legacyStore.$dispose();
  });

  it('已销毁的 store 不得再把自己的快照写回 localStorage', async () => {
    // 先把**其它**用例遗留的启动任务抽干 —— 它们经 beautifier-store 的
    // `useSettingsStore()` 会写到「当时活跃」的那个 store 上，与本条要测的东西无关。
    await drainMacrotasks(6);

    setActivePinia(createPinia());
    const ghost = useSettingsStore();
    ghost.settings.apiPool = [
      {
        id: 'ghost-1',
        name: 'ghost',
        baseUrl: 'http://ghost',
        apiKey: 'k',
        maskedKey: '***',
        model: 'm',
        models: ['m'],
        apiType: 'chat',
      },
    ] as never;

    // 下一个用例的 afterEach/beforeEach 形状：销毁 → 清空 → 让出事件循环。
    // 🔴 2026-08-16（真实根因）：**必须在让出事件循环之前把活跃 pinia 换掉**。
    //    幽灵 store 的构造期启动链（loadAgentProjectDefaults → content-store →
    //    beautifier-store.refreshPresetRules → useSettingsStore()）在 $dispose 后
    //    仍会跑完它的 await 段；那一刻 `useSettingsStore()` 解析的是「当时活跃的
    //    pinia」。若活跃 pinia 还是幽灵的（未换），Pinia 会在**同一个 pinia** 上
    //    重建同名 store，而重建的 store 经序列化把幽灵 apiPool 写回 localStorage
    //    —— 这就是注释里「只在全量 + CPU 高负载下复现」的机制：负载把幽灵链的
    //    落点拖进了这个窗口。换掉 pinia 后，幽灵链重建的 store 读到的是已清空
    //    的 localStorage，写入的只能是默认快照，幽灵条目无处藏身。
    ghost.$dispose();
    store_.clear();
    setActivePinia(createPinia());
    await drainMacrotasks(6);

    // 🔴 幽灵 store 的启动任务此刻不得复活那份快照。
    //    复活的后果不是「多一条脏数据」，而是下一个 store 会把它当成自己的 apiPool 读进来
    //    —— 那条脱敏条目占住 index 0，新存的密钥被 push 到 index 1。
    //
    //    🔴 断言对象从「localStorage 必须为 null」改为「**污染不得进入新 store**」：
    //    $dispose 后 Pinia 的 useStore 会在活跃 pinia 上**重建** store，重建 store 的
    //    启动任务写一份「默认快照」是合法行为（闸门 settingsPersistenceEnabled 只拦
    //    密钥迁移期的写入）—— 在负载变化下把「localStorage 有值」一律判成幽灵复活，
    //    正是注释里那句「只在全量 + CPU 高负载下复现」的脆弱来源。
    //    幽灵污染与默认快照的差别是决定性的：前者带 ghost-1 进 apiPool，后者为空。
    setActivePinia(createPinia());
    const fresh = useSettingsStore();
    expect(fresh.settings.apiPool).toHaveLength(0);
    fresh.$dispose();
  });
});
