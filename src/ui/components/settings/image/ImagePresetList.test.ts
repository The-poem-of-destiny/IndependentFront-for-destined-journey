/**
 * ImagePresetList.vue —— C15 那句提示**真的被供上了值**
 *
 * 🔴 纯函数测试（`preset-dialect-form.test.ts`）能证明判据对，**证明不了有人问它** ——
 * `blurByDefault` 当年就是这么死的：逻辑对、默认值对、全仓没人传。所以这里从设置里的
 * `imageDialectId` + 内容注册表的方言表出发，一路渲染到那一行中文。
 *
 * 被替身的只有**数据源**（两个 Dexie store、内容注册表、settings 的启动期 I/O），
 * 判定链本身一步不 stub。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import type { ImagePreset } from '@engine/types-image';
import { EMPTY_APPEARANCE } from '@engine/character-appearance';
import { PRESET_NO_FORM_HINT } from './preset-dialect-form';

const mockSettings = reactive<Record<string, unknown>>({});
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}));

/**
 * 内容注册表不是响应式的，测试里换表之后重新挂载即可（生产靠**加载门**）。
 *
 * 🔴 `registryFace` 与 `ensurePromise` 都是可变的：加载门兑现**之前**注册表是空的
 * 才叫在途，而「在途时挂载会怎样」正是本文件最后一组用例要问的事。
 */
const DIALECT_FIXTURE: unknown = {
  dialects: [
    { id: 'danbooru-anime', label: '动漫标签', appearance: 'danbooru' },
    { id: 'natural-prose', label: '自然语', appearance: 'prose', normalize: 'none' },
  ],
};
let registryFace: unknown;
let ensurePromise: Promise<void>;
vi.mock('../../../stores/content-store', () => ({
  getContentRegistry: () => ({ imageDialects: registryFace }),
  ensureContentRegistryLoaded: () => ensurePromise,
}));

const presetStore = reactive({
  characters: [] as ImagePreset[],
  init: vi.fn(async () => undefined),
  upsert: vi.fn(async () => ({ ok: true as const })),
  rename: vi.fn(async () => ({ ok: true as const })),
  remove: vi.fn(async () => ({ ok: true as const })),
});
vi.mock('../../../stores/image-preset-store', () => ({ useImagePresetStore: () => presetStore }));

const sessionStore = reactive({
  rows: [] as { name: string; patch: Record<string, string>; updatedAt: number }[],
  load: vi.fn(async () => undefined),
  patchOf: vi.fn(() => undefined),
  resetOne: vi.fn(async () => ({ ok: true as const })),
  resetAll: vi.fn(async () => ({ ok: true as const })),
});
vi.mock('../../../stores/character-appearance-store', () => ({
  useCharacterAppearanceStore: () => sessionStore,
}));

vi.mock('../../../stores/ui-store', () => ({
  useUIStore: () => ({ activeSaveId: null, toast: vi.fn(), navigate: vi.fn() }),
}));

import ImagePresetList from './ImagePresetList.vue';

function preset(over: Partial<ImagePreset> = {}): ImagePreset {
  return {
    key: 'character:苏婉',
    kind: 'character',
    name: '苏婉',
    dialects: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

async function mountList() {
  const wrapper = mount(ImagePresetList);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  registryFace = DIALECT_FIXTURE;
  ensurePromise = Promise.resolve();
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, { imageDialectId: 'danbooru-anime', imageDialectOverrides: {} });
  sessionStore.rows = [];
  presetStore.characters = [
    // 只有老 danbooru 标签、九个槽全空（D62 的那一格）
    preset({
      appearance: { ...EMPTY_APPEARANCE },
      dialects: { danbooru: { positive: 'silver hair, golden eyes', negative: '' } },
    }),
    // 有属性槽 —— 任何方言下都画得出来
    preset({
      key: 'character:林岚',
      name: '林岚',
      appearance: { ...EMPTY_APPEARANCE, hairColor: 'black hair' },
    }),
  ];
});

describe('C15：当前方言下无可用形象的提示', () => {
  it('danbooru 方言下一行都不标 —— 老预设在那边照常可用', async () => {
    const wrapper = await mountList();
    expect(wrapper.text()).not.toContain(PRESET_NO_FORM_HINT);
  });

  it('🔴 切到散文方言后，只有标签形式的那一行标出来（另一行不动）', async () => {
    mockSettings.imageDialectId = 'natural-prose';

    const wrapper = await mountList();
    const rows = wrapper.findAll('.preset-row');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain('苏婉');
    expect(rows[0]?.text()).toContain(PRESET_NO_FORM_HINT);
    // 有槽的那一行不该被冤枉 —— 标错的代价是让人去删一条其实好好的预设
    expect(rows[1]?.text()).toContain('林岚');
    expect(rows[1]?.text()).not.toContain(PRESET_NO_FORM_HINT);
  });

  it('注册表里没有这条方言时退回内置 danbooru，于是不标（不是崩，也不是全标）', async () => {
    mockSettings.imageDialectId = '被内容包删掉的方言';

    const wrapper = await mountList();
    expect(wrapper.text()).not.toContain(PRESET_NO_FORM_HINT);
  });
});

describe('🔴 C15：方言表还在路上时挂载，提示行仍要活过来', () => {
  /**
   * 这一组问的是**接线**，不是判据。
   *
   * 上面那些用例都从一份**已经灌好**的注册表出发，于是「组件等的是哪个 promise」
   * 这个问题根本没被问到 —— 等一个在模块加载时就同步兑现的 promise（它只说明占位骨架
   * 就位，对 `image-dialects.json` 那次 fetch 一个字都没说）照样全绿。真机上的败法是:
   * 分区在 fetch 在途时挂载 → `dialects` 永远是 `[]` → 回落内置 danbooru →
   * `lacksForm()` 恒 false → C15 那句提示在本组件整个生命周期里都不出现。
   */
  it('挂载时注册表还空着 → 先不标；加载门兑现后那一行自己出现', async () => {
    mockSettings.imageDialectId = 'natural-prose';
    registryFace = undefined;
    let release = (): void => {};
    ensurePromise = new Promise<void>((resolve) => {
      release = () => {
        registryFace = DIALECT_FIXTURE;
        resolve();
      };
    });

    const wrapper = await mountList();
    // 空注册表 → 回落内置 danbooru → 老预设在那边照常可用，所以此刻不该标
    expect(wrapper.text()).not.toContain(PRESET_NO_FORM_HINT);

    release();
    await flushPromises();

    const rows = wrapper.findAll('.preset-row');
    expect(rows[0]?.text()).toContain(PRESET_NO_FORM_HINT);
    expect(rows[1]?.text()).not.toContain(PRESET_NO_FORM_HINT);
  });
});
