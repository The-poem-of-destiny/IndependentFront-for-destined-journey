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
    imageEndpointId: null,
    imageModel: 'nai-diffusion-4-5-full',
    imageQualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
    imageBaseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
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
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  resetSettings();
});

describe('ImageRenderCard —— 免费额度指示（D43）', () => {
  it('默认参数（1216×832 / 23 步）报免费，且**一个点数都不出现**', () => {
    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-free');
    expect(line.text()).toContain('估算');
    // 🔴 牌价在免费档内也是正数 —— 渲染它就成了「免费，约 N 点」
    expect(line.text()).not.toContain('点/张');
  });

  it('尺寸调大到免费额度之外 → 报收费，并给出每张点数', () => {
    mockSettings.imageWidth = 2048;
    mockSettings.imageHeight = 2048;

    const line = mount(ImageRenderCard).find('.anlas-line');
    expect(line.classes()).toContain('anlas-billed');
    expect(line.text()).toMatch(/约 \d+ 点\/张/);
  });

  it('步数越界（>28）同样报收费 —— 免费判据不只看尺寸', () => {
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

  it('规则快照标签渲染出来了 —— 「这是哪一版规则」要看得见', () => {
    expect(mount(ImageRenderCard).find('.anlas-ruleset').text()).toContain('规则快照');
  });
});

describe('ImageRenderCard —— 三档开关与自动档确认（D44）', () => {
  /** 三档按钮的渲染顺序：off / manual / auto */
  function modeButtons(w: ReturnType<typeof mount>) {
    return w.findAll('.mode-item');
  }

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
    mockSettings.imageMaxPerMessage = 5;
    mockSettings.imageMaxPerHour = 7;

    const hint = mount(ImageRenderCard).findAll('.mode-hint')[2].text();
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

  it('🔴 画质后缀绑的是 UiSettings.imageQualitySuffix，且默认值不带前导逗号', () => {
    const w = mount(ImageRenderCard);
    const textareas = w.findAll('textarea');
    expect((textareas[0].element as HTMLTextAreaElement).value).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX.startsWith(',')).toBe(false);
  });

  it('这张卡写明自己管的是「图」的提示词（与 Agent 的提示词区分开）', () => {
    expect(mount(ImageRenderCard).find('.image-card-scope').text()).toContain('NovelAI');
  });
});
