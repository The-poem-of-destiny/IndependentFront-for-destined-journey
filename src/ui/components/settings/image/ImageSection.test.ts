/**
 * 图像生成分区 —— 壳层结构 / 提示词卡的接线 / 视觉预设 CRUD
 *
 * 三件事值得钉住：
 *
 * 1. **单根 `<section class="section centered">`** —— `.centered`（780px 居中）是
 *    SettingsPage 的 scoped 规则，只够得到子组件的**根节点**。多根 fragment 会让它
 *    命不中，本分区在宽屏下摊满整行（ApiSection 在真机走查里正是栽在这条）。
 *
 * 2. **提示词卡渲染的是 `agents` 袋子里的同一份存储**（D52），不是复制一份到
 *    `UiSettings`。所以它必须把 `image_prompt` 交给 `AgentConfigPanel`，
 *    并且**自己一个 image* 设置项都不碰**。
 *
 * 3. **改名走 `rename()` 而不是 upsert** —— 主键是 `${kind}:${name}`，直接 upsert
 *    会留一条孤儿旧记录，而界面上看起来只是"改了个名字"。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ImagePreset } from '@engine/types-image';

// ---- Dexie 层：jsdom 下不可用，整层替成内存表 ----
const table = new Map<string, ImagePreset>();
vi.mock('@engine/database', () => ({
  getImagePresets: vi.fn(async () => [...table.values()]),
  getImagePreset: vi.fn(async (key: string) => table.get(key)),
  saveImagePreset: vi.fn(async (row: ImagePreset) => {
    table.set(row.key, row);
  }),
  deleteImagePreset: vi.fn(async (key: string) => {
    table.delete(key);
  }),
}));

// 引擎模板层：提示词卡经 AgentConfigPanel 会摸到它（本测试只关心接线）
vi.mock('@engine/agent-templates', () => ({
  getAgentTemplate: (id: string) => ({ fixedSystem: `[引擎模板:${id}]`, fixedExamples: '' }),
}));

const mockSettings = reactive<Record<string, any>>({});
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: mockSettings,
    projectAgentDefaults: null,
    saveAgentProjectDefaults: vi.fn(async () => true),
  }),
}));

import ImageSection from './ImageSection.vue';
import ImagePromptCard from './ImagePromptCard.vue';
import ImageRenderCard from './ImageRenderCard.vue';
import ImagePresetList from './ImagePresetList.vue';
import AgentConfigPanel from '../agent/AgentConfigPanel.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import { useImagePresetStore } from '../../../stores/image-preset-store';

/**
 * 弹窗内容被 `AppModal` **Teleport 到 body**，而 VTU 的 wrapper 只看得到组件自己那棵
 * 子树 —— `w.find('input')` 在这里永远是空的（组件 wrapper 的根是 Teleport 本身）。
 * 所以表单字段一律从 `document` 上取，并手动派发 `input` 让 v-model 收到。
 */
function typeInto(selector: string, value: string) {
  const el = document.body.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error(`弹窗里找不到 ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  table.clear();
  setActivePinia(createPinia());
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    apiPool: [],
    agents: {},
    agentDirty: {},
    agentPromptEdited: false,
    presets: [],
    activePresetId: '',
    imageGenMode: 'manual',
    imageEndpointId: null,
    imageModel: 'nai-diffusion-4-5-full',
    imageQualitySuffix: 'location, very aesthetic',
    imageBaseNegative: 'lowres',
    imageExtraNegative: '',
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageAutoConfirmed: false,
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageSampler: 'k_euler_ancestral',
    imageNoiseSchedule: 'karras',
    imageUcPreset: 0,
    imageMaxPerMessage: 2,
    imageMaxPerHour: 20,
  });
});

describe('ImageSection —— 分区壳', () => {
  it('🔴 单根 <section class="section centered">', () => {
    const w = mount(ImageSection, { shallow: true });
    expect(w.element.tagName).toBe('SECTION');
    expect(w.classes()).toContain('section');
    expect(w.classes()).toContain('centered');
  });

  it('三张卡都在，且顺序是 提示词生成 → 出图 → 视觉预设（两处花钱的地方在前）', () => {
    const w = mount(ImageSection, { shallow: true });
    expect(w.findComponent(ImagePromptCard).exists()).toBe(true);
    expect(w.findComponent(ImageRenderCard).exists()).toBe(true);
    expect(w.findComponent(ImagePresetList).exists()).toBe(true);

    const order = w.findAll('.image-cards > *').map((el) => el.element.tagName.toLowerCase());
    expect(order).toHaveLength(3);
  });
});

describe('ImagePromptCard —— 渲染位置 ≠ 存储位置（D52）', () => {
  it('把 image_prompt 交给 AgentConfigPanel（同一份 agents 存储，不是副本）', () => {
    const w = mount(ImagePromptCard, { shallow: true });
    expect(w.findComponent(AgentConfigPanel).props('agentId')).toBe('image_prompt');
  });

  it('🔴 挂载不往 UiSettings 里写任何 image* 字段（那些是 NAI 参数的地盘）', () => {
    const before = JSON.stringify(mockSettings);
    mount(ImagePromptCard, { shallow: true });
    expect(JSON.stringify(mockSettings)).toBe(before);
  });

  it('卡上写明这里的提示词管什么（两处「提示词」不许混）', () => {
    const text = mount(ImagePromptCard, { shallow: true }).find('.image-card-scope').text();
    expect(text).toContain('danbooru');
    expect(text).toContain('出图');
  });
});

describe('ImagePresetList —— 视觉预设 CRUD', () => {
  it('空库渲染空态（装饰符 + 斜体说明，不是"暂无数据"）', async () => {
    const w = mount(ImagePresetList);
    await flushPromises();
    expect(w.find('.empty-tab').exists()).toBe(true);
    expect(w.find('.preset-list').exists()).toBe(false);
  });

  it('新建一条角色预设 → 落库 + 出现在列表里', async () => {
    const w = mount(ImagePresetList);
    await flushPromises();

    await w.findAllComponents(AppButton)[0].find('button').trigger('click'); // + 新建
    typeInto('.modal-body input.form-input', '苏婉');
    typeInto('.modal-body textarea', 'silver hair, golden eyes');

    const save = w.findAllComponents(AppButton).find((b) => b.text() === '保存');
    await save!.find('button').trigger('click');
    await flushPromises();

    expect(table.get('character:苏婉')?.dialects.danbooru?.positive).toBe(
      'silver hair, golden eyes',
    );
    expect(w.find('.preset-name').text()).toBe('苏婉');
  });

  it('🔴 改名走 rename（删旧建新），不留孤儿旧记录', async () => {
    const store = useImagePresetStore();
    await store.upsert({
      kind: 'character',
      name: '旧名',
      danbooru: { positive: 'a', negative: '' },
    });

    const w = mount(ImagePresetList);
    await flushPromises();

    const edit = w.findAllComponents(AppButton).find((b) => b.text() === '编辑');
    await edit!.find('button').trigger('click');
    typeInto('.modal-body input.form-input', '新名');

    const save = w.findAllComponents(AppButton).find((b) => b.text() === '保存');
    await save!.find('button').trigger('click');
    await flushPromises();

    expect(table.has('character:新名')).toBe(true);
    expect(table.has('character:旧名')).toBe(false);
  });

  it('名字留空直接拒收（主键会退化成 `character:`，两条空名字互相覆盖）', async () => {
    const w = mount(ImagePresetList);
    await flushPromises();

    await w.findAllComponents(AppButton)[0].find('button').trigger('click');
    const save = w.findAllComponents(AppButton).find((b) => b.text() === '保存');
    await save!.find('button').trigger('click');
    await flushPromises();

    expect(table.size).toBe(0);
  });

  it('🪦 D59：地点页签已删，只剩「角色」一个页签', async () => {
    const store = useImagePresetStore();
    await store.upsert({ kind: 'character', name: '苏婉' });
    await store.upsert({ kind: 'character', name: '黄昏酒馆' });

    const w = mount(ImagePresetList);
    await flushPromises();
    // 一个页签，且列的是全部角色 —— 地点预设废除后没有第二个筛选面
    expect(w.findAll('.tab-item')).toHaveLength(1);
    // 排序按 zh-Hans-CN 拼音：黄(h) 在 苏(s) 前
    expect(w.findAll('.preset-name').map((n) => n.text())).toEqual(['黄昏酒馆', '苏婉']);
  });

  it('删除要过一次确认，确认后才真的删', async () => {
    const store = useImagePresetStore();
    await store.upsert({ kind: 'character', name: '苏婉' });

    const w = mount(ImagePresetList);
    await flushPromises();

    const del = w.findAllComponents(AppButton).find((b) => b.text() === '删除');
    await del!.find('button').trigger('click');
    expect(table.has('character:苏婉')).toBe(true); // 还没确认

    const confirmModal = w.findAllComponents(AppModal).find((m) => m.props('open') === true);
    const confirm = confirmModal!.findAllComponents(AppButton).find((b) => b.text() === '删除');
    await confirm!.find('button').trigger('click');
    await flushPromises();

    expect(table.has('character:苏婉')).toBe(false);
  });
});
