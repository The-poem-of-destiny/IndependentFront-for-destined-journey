/**
 * ImageRenderCard.vue —— 出图卡的两个看门人
 *
 * 这张卡上有两处「说错了不会报错、只会让用户吃亏」的地方，所以它们各有一组用例：
 *
 * 1. **免费额度指示**（D43 / §11.2）。`estimateAnlasCost` 的 `anlasPerSample` 在
 *    免费档内**也是正数**（那是牌价），照着渲染就会出现「免费，约 17 点」这种
 *    自相矛盾；而输入框被清空时函数返回 `consumes-anlas` + `invalid-input`，
 *    把**不知道**渲染成**免费**是这个指示器最不该犯的错。三支必须互斥且各说各话。
 *
 * 2. **自动档的一次性确认**（D44）。自动档是无人值守花钱，首次切进去必须先问一次；
 *    问过之后（`imageAutoConfirmed`）不再打断 —— 每次都弹等于训练用户闭眼点过。
 *    另外「点了 auto 但没确认」时档位**不能**已经变了，否则确认框成了摆设。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { DEFAULT_IMAGE_BASE_NEGATIVE, DEFAULT_IMAGE_QUALITY_SUFFIX } from '@engine/image-defaults';

// settings-store：绕开启动期的 fetch / IndexedDB，只给本组件用到的表面
const mockSettings = reactive<Record<string, any>>({});
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}));

import ImageRenderCard from './ImageRenderCard.vue';
import AppModal from '../../shared/AppModal.vue';
import AppButton from '../../shared/AppButton.vue';

function resetSettings() {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    apiPool: [],
    imageGenMode: 'manual',
    imageExtraNegative: '',
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageAutoConfirmed: false,
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    // 图像 v2 / C6：画质后缀与全局负向不再是平铺字段，而是**当前方言的覆盖**。
    // 覆盖表留空 = 回落方言默认（= 下面断言里的两个常量）
    imageDialectId: 'danbooru-anime',
    imageDialectOverrides: {},
    imageNovelai: {
      endpointId: null,
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      ucPreset: 0,
      // 🔴 与 getDefaults() 一致：'unset'，不是 'opus'。这里若图省事写 'opus'，
      //    「默认不谎报免费」那条用例就会在一个**测试自己造出来的**前提下变绿
      tier: 'unset',
      maxPerMessage: 2,
      maxPerHour: 20,
    },
  });
}

/** 三档出图开关（第一组 mode-list）。档位选择器复用同一套外壳类，故按 aria-label 定位 */
function modeItems(w: ReturnType<typeof mount>) {
  return w.get('[aria-label="出图档位"]').findAll('.mode-item');
}

/** 账户档位（第二组）：unset / opus / metered */
function tierItems(w: ReturnType<typeof mount>) {
  return w.get('[aria-label="NovelAI 账户档位"]').findAll('.mode-item');
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  resetSettings();
});

describe('ImageRenderCard —— 免费额度指示（D43）', () => {
  it('Opus + 默认参数（1216×832 / 23 步）报免费，且**一个点数都不出现**', () => {
    mockSettings.imageNovelai.tier = 'opus';

    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-free');
    expect(line.text()).toContain('估算');
    // 🔴 牌价在免费档内也是正数 —— 渲染它就成了「免费，约 N 点」
    expect(line.text()).not.toContain('点/张');
  });

  it('Opus + 尺寸调大到免费额度之外 → 报收费，并给出每张点数', () => {
    mockSettings.imageNovelai.tier = 'opus';
    mockSettings.imageWidth = 2048;
    mockSettings.imageHeight = 2048;

    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-billed');
    expect(line.text()).toMatch(/约 \d+ 点\/张/);
  });

  it('Opus + 步数越界（>28）同样报收费 —— 免费判据不只看尺寸', () => {
    mockSettings.imageNovelai.tier = 'opus';
    mockSettings.imageSteps = 40;
    expect(mount(ImageRenderCard).find('.anlas-line').classes()).toContain('anlas-billed');
  });

  it('🔴 输入框被清空（NaN）→ 说「算不出来」，既不说免费也不报数', () => {
    mockSettings.imageWidth = Number.NaN;

    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-unknown');
    expect(line.text()).toContain('算不出');
    expect(line.text()).not.toContain('点/张');
    // 「不知道」不许长得像「免费」
    expect(line.classes()).not.toContain('anlas-free');
    expect(line.text()).not.toContain('不消耗');
  });

  it('Opus 下规则快照标签渲染出来了 —— 「这是哪一版规则」要看得见', () => {
    mockSettings.imageNovelai.tier = 'opus';
    expect(mount(ImageRenderCard).find('.anlas-ruleset').text()).toContain('规则快照');
  });
});

describe('🔴 ImageRenderCard —— 账户档位（D43 补丁，2026-08-04 真机催生）', () => {
  it('默认档位（没设置）+ 默认参数 → **绝不**说免费，改说取决于档位', () => {
    const line = mount(ImageRenderCard).find('.anlas-line');

    expect(line.classes()).not.toContain('anlas-free');
    expect(line.text()).not.toContain('不消耗');
    expect(line.text()).toContain('取决于你的账户档位');
    // 牌价照报 —— 用户至少知道量级
    expect(line.text()).toMatch(/约 \d+ 点\/张/);
  });

  it('按点数付费 + 默认参数 → 报收费，并说明调参数也免不掉', () => {
    mockSettings.imageNovelai.tier = 'metered';

    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-billed');
    expect(line.text()).toContain('没有免费额度');
    expect(line.text()).toContain('免不掉');
    expect(line.text()).toMatch(/约 \d+ 点\/张/);
  });

  it('同一组参数：Opus 说免费、按点数付费说收费 —— 这就是那个 bug 的回归', () => {
    mockSettings.imageNovelai.tier = 'opus';
    expect(mount(ImageRenderCard).find('.anlas-line').classes()).toContain('anlas-free');

    mockSettings.imageNovelai.tier = 'metered';
    expect(mount(ImageRenderCard).find('.anlas-line').classes()).toContain('anlas-billed');
  });

  it('三个档位按钮点得动，且选中态跟着走', async () => {
    const w = mount(ImageRenderCard);
    const items = tierItems(w);
    expect(items).toHaveLength(3);

    await items[1].trigger('click');
    expect(mockSettings.imageNovelai.tier).toBe('opus');
    expect(tierItems(w)[1].classes()).toContain('mode-active');

    await tierItems(w)[2].trigger('click');
    expect(mockSettings.imageNovelai.tier).toBe('metered');
  });

  it('档位选择器写明它**不改变请求** —— 免得被当成会影响出图质量的开关', () => {
    expect(mount(ImageRenderCard).find('.tier-desc').text()).toContain('不改变任何请求');
  });

  it('非 Opus 档位的规则标签不许再自称 Opus', () => {
    mockSettings.imageNovelai.tier = 'metered';
    const label = mount(ImageRenderCard).find('.anlas-ruleset').text();
    expect(label).not.toContain('Opus 订阅 ·');
    expect(label).toContain('无免费额度');
  });
});

describe('ImageRenderCard —— 三档开关与自动档确认（D44）', () => {
  /** 三档按钮的渲染顺序：off / manual / auto（`modeItems` 已按 aria-label 隔开档位选择器） */
  const modeButtons = modeItems;

  it('off / manual 立即生效，不打断', async () => {
    const w = mount(ImageRenderCard);
    await modeButtons(w)[0].trigger('click');
    expect(mockSettings.imageGenMode).toBe('off');
    expect(w.findComponent(AppModal).props('open')).toBe(false);
  });

  it('🔴 首次切到 auto：先弹确认，**档位先不动**', async () => {
    const w = mount(ImageRenderCard);
    await modeButtons(w)[2].trigger('click');

    expect(w.findComponent(AppModal).props('open')).toBe(true);
    expect(mockSettings.imageGenMode).toBe('manual');
    expect(mockSettings.imageAutoConfirmed).toBe(false);
  });

  it('确认之后档位才变，并记住「问过了」', async () => {
    const w = mount(ImageRenderCard);
    await modeButtons(w)[2].trigger('click');

    const confirm = w.findAllComponents(AppButton).find((b) => b.text().includes('开自动'));
    await confirm!.find('button').trigger('click');

    expect(mockSettings.imageGenMode).toBe('auto');
    expect(mockSettings.imageAutoConfirmed).toBe(true);
    expect(w.findComponent(AppModal).props('open')).toBe(false);
  });

  it('已确认过的档案再切 auto 不再打断（每次都弹 = 训练用户闭眼点过）', async () => {
    mockSettings.imageAutoConfirmed = true;
    const w = mount(ImageRenderCard);
    await modeButtons(w)[2].trigger('click');

    expect(mockSettings.imageGenMode).toBe('auto');
    expect(w.findComponent(AppModal).props('open')).toBe(false);
  });

  it('auto 的后果行用**当前**限额值，不是文案里写死的数', async () => {
    mockSettings.imageNovelai.maxPerMessage = 5;
    mockSettings.imageNovelai.maxPerHour = 7;

    const hint = modeItems(mount(ImageRenderCard))[2].find('.mode-hint').text();
    expect(hint).toContain('5 张');
    expect(hint).toContain('7 张');
  });
});

describe('ImageRenderCard —— 端点筛选与两处提示词的边界', () => {
  it('端点下拉只列 apiType === image 的条目', () => {
    mockSettings.apiPool = [
      { id: 'a', name: '文本站', apiType: 'chat' },
      { id: 'b', name: 'NAI', apiType: 'image' },
      { id: 'c', name: '向量站', apiType: 'embedding' },
    ];

    const options = mount(ImageRenderCard).findAll('select')[0].findAll('option');
    // 「（未选择）」+ 唯一一条 image
    expect(options).toHaveLength(2);
    expect(options[1].text()).toBe('NAI');
  });

  it('🔴 画质后缀绑的是**当前方言的覆盖**（C6），不是一个全局字段', async () => {
    const w = mount(ImageRenderCard);
    const textareas = w.findAll('textarea');

    // 没覆盖过 → 框里是空的（空 = 回落方言默认，不是「一个空的画质后缀」）
    expect((textareas[0].element as HTMLTextAreaElement).value).toBe('');
    expect(mockSettings.imageDialectOverrides['danbooru-anime']).toBeUndefined();

    await textareas[0].setValue('my suffix');
    // 🔴 落进的是当前方言那一格 —— 全局单份会把 danbooru 的调优带进散文档
    expect(mockSettings.imageDialectOverrides['danbooru-anime'].qualitySuffix).toBe('my suffix');
    expect(mockSettings.imageQualitySuffix).toBeUndefined();

    // 默认值仍然不带前导逗号（`composePrompt` 自己用 '、' 连接各段）
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX.startsWith(',')).toBe(false);
    expect(DEFAULT_IMAGE_BASE_NEGATIVE.startsWith(',')).toBe(false);
  });

  it('全局负向（基础）同样落在当前方言那一格，两个框互不串门', async () => {
    const w = mount(ImageRenderCard);
    const textareas = w.findAll('textarea');

    await textareas[1].setValue('my negative');
    const entry = mockSettings.imageDialectOverrides['danbooru-anime'];
    expect(entry.baseNegative).toBe('my negative');
    expect(entry.qualitySuffix).toBeUndefined();
  });

  it('这张卡写明自己管的是「图」的提示词（与 Agent 的提示词区分开）', () => {
    expect(mount(ImageRenderCard).find('.image-card-scope').text()).toContain('NovelAI');
  });
});
