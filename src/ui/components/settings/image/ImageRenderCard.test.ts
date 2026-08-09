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
 * 3. **后端切换**（图像 v2 / C9·C16）。ComfyUI 下那七样 NAI 专属的东西（端点/模型/
 *    采样器/UC 预设/账户档位/Anlas 估算/每消息与每小时上限）必须**整块消失** ——
 *    留着就是一句「看着权威、其实不生效」的话，与 D43 谎报免费同一类错误。
 *
 * 4. **方言**（C6）。四个字符串旋钮按方言 id 键控；`supportsNegative:false` 时负向框
 *    **可见地禁用**，不是收下再静默丢掉。
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

/**
 * 内容注册表的第 7 面（方言）。整层替掉是为了不把 Dexie / fetch 拖进 jsdom ——
 * 本文件关心的是「下拉里列了什么」「supportsNegative 怎么影响那一格」，
 * 不是注册表自己的加载时序。
 */
let dialectFace: unknown;
vi.mock('../../../stores/content-store', () => ({
  getContentRegistry: () => ({ imageDialects: dialectFace }),
  ensureContentRegistryLoaded: async () => {},
}));

/** 两条方言：一条吃负向（danbooru），一条不吃（散文 / CFG 1.0 那类模型） */
const DIALECT_FIXTURE = {
  dialects: [
    {
      id: 'danbooru-anime',
      label: '动漫标签',
      supportsNegative: true,
      qualitySuffix: 'masterpiece',
      baseNegative: 'lowres',
      systemPrompt: '把场景转成标签',
    },
    {
      id: 'natural-prose',
      label: '自然语言',
      supportsNegative: false,
      qualitySuffix: '',
      baseNegative: '',
      composition: '',
      systemPrompt: '写一句英文描述',
    },
  ],
};

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
    // 图像 v2 / C8：后端与两个 provider 袋子。默认 novelai = 重构前唯一存在的那条路
    imageProvider: 'novelai',
    imageComfy: {
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: '',
      timeoutMs: 600_000,
      pollIntervalMs: 1_500,
    },
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

/** 后端选择器（第三组 mode-list） */
function providerItems(w: ReturnType<typeof mount>) {
  return w.get('[aria-label="出图后端"]').findAll('.mode-item');
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  resetSettings();
  dialectFace = DIALECT_FIXTURE;
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

describe('🔴 ImageRenderCard —— 后端切换（C9/C16）', () => {
  it('三个后端专属块的默认相：NovelAI 那套全在，ComfyUI 那套一个不出', () => {
    const w = mount(ImageRenderCard);

    expect(w.find('[aria-label="NovelAI 账户档位"]').exists()).toBe(true);
    expect(w.find('.anlas-line').exists()).toBe(true);
    expect(w.find('.quota-per-message').exists()).toBe(true);
    expect(w.find('.comfy-base-url').exists()).toBe(false);
    expect(w.find('.workflow-input').exists()).toBe(false);
  });

  it('设置里压根没有 imageProvider（迁移之前的老档）也走 NovelAI 那条路', () => {
    delete mockSettings.imageProvider;
    expect(mount(ImageRenderCard).find('.anlas-line').exists()).toBe(true);
  });

  it('🔴 切到 ComfyUI：端点/模型/档位/Anlas/限额**整块消失**（画出来就是假话）', async () => {
    const w = mount(ImageRenderCard);
    await providerItems(w)[1].trigger('click');
    expect(mockSettings.imageProvider).toBe('comfyui');

    expect(w.find('[aria-label="NovelAI 账户档位"]').exists()).toBe(false);
    expect(w.find('.anlas-line').exists()).toBe(false);
    expect(w.find('.anlas-ruleset').exists()).toBe(false);
    expect(w.find('.quota-per-message').exists()).toBe(false);
    expect(w.find('.quota-per-hour').exists()).toBe(false);
    // 端点下拉（NAI 那格）也跟着走 —— 只剩分级上限与方言两个 select
    expect(w.findAll('select')).toHaveLength(2);
  });

  it('共享的宽/高/步数/CFG 在两个后端下都在（comfy 侧是 %token% 的替换值）', async () => {
    const w = mount(ImageRenderCard);
    const numbersBefore = w.findAll('input[type="number"]').length;
    expect(numbersBefore).toBeGreaterThan(0);

    await providerItems(w)[1].trigger('click');
    const labels = w.findAll('.form-label').map((l) => l.text());
    expect(labels.some((t) => t.startsWith('宽（px）'))).toBe(true);
    expect(labels.some((t) => t.startsWith('高（px）'))).toBe(true);
    expect(labels.some((t) => t.startsWith('步数'))).toBe(true);
    expect(labels.some((t) => t.startsWith('CFG scale'))).toBe(true);
  });

  it('🔴 auto 的后果行在 ComfyUI 下换说法 —— 不许承诺一个根本不存在的上限', async () => {
    mockSettings.imageProvider = 'comfyui';
    const hint = modeItems(mount(ImageRenderCard))[2].find('.mode-hint').text();

    expect(hint).not.toContain('每条消息最多 2 张');
    expect(hint).toContain('不设每消息');
  });

  it('ComfyUI 档下说明白「为什么这里没有上限」，而不是默默少几个框', async () => {
    mockSettings.imageProvider = 'comfyui';
    expect(mount(ImageRenderCard).find('.local-quota-note').text()).toContain('不设每消息');
  });
});

describe('🔴 ImageRenderCard —— ComfyUI 三格（C11/C13/C16）', () => {
  function mountComfy() {
    mockSettings.imageProvider = 'comfyui';
    return mount(ImageRenderCard);
  }

  it('地址 / 轮询间隔直接绑 imageComfy 袋，不进 API 池', async () => {
    const w = mountComfy();

    await w.find('.comfy-base-url').setValue('http://192.168.1.9:8188');
    expect(mockSettings.imageComfy.baseUrl).toBe('http://192.168.1.9:8188');

    await w.find('.comfy-poll').setValue('2000');
    expect(mockSettings.imageComfy.pollIntervalMs).toBe(2000);

    // 池子那边一个字都不该多出来
    expect(mockSettings.apiPool).toHaveLength(0);
  });

  it('超时按**秒**显示、按**毫秒**存（600000 那串零没人数得清）', async () => {
    const w = mountComfy();
    expect((w.find('.comfy-timeout').element as HTMLInputElement).value).toBe('600');

    await w.find('.comfy-timeout').setValue('300');
    expect(mockSettings.imageComfy.timeoutMs).toBe(300_000);
  });

  it('🔴 超时清空（读不懂的输入）不写 —— 存成 0 等于每张图一发出去就超时', async () => {
    const w = mountComfy();
    await w.find('.comfy-timeout').setValue('');
    expect(mockSettings.imageComfy.timeoutMs).toBe(600_000);
  });

  it('工作流坏 JSON：失焦时就地报错，说明是哪儿不对', async () => {
    const w = mountComfy();
    const ta = w.find('.workflow-input');

    await ta.setValue('{ 这不是 JSON');
    await ta.trigger('blur');

    const err = w.find('.workflow-error');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain('JSON');
  });

  it('🔴 留空 = 用内置最小 SDXL 图，**不是错误**（对着默认状态报红最气人）', async () => {
    const w = mountComfy();
    const ta = w.find('.workflow-input');

    await ta.setValue('{ 坏的');
    await ta.trigger('blur');
    expect(w.find('.workflow-error').exists()).toBe(true);

    await ta.setValue('');
    await ta.trigger('blur');
    expect(w.find('.workflow-error').exists()).toBe(false);
  });

  it('合法的 API 格式工作流不报错，并原样存进袋子', async () => {
    const w = mountComfy();
    const graph = '{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}';
    const ta = w.find('.workflow-input');

    await ta.setValue(graph);
    await ta.trigger('blur');

    expect(w.find('.workflow-error').exists()).toBe(false);
    expect(mockSettings.imageComfy.workflowJson).toBe(graph);
  });
});

describe('🔴 ImageRenderCard —— 方言选择与覆盖（C2/C6）', () => {
  it('下拉列的是注册表里的方言（label + id 都看得见）', () => {
    const options = mount(ImageRenderCard).find('.dialect-select').findAll('option');

    expect(options).toHaveLength(2);
    expect(options[0].text()).toContain('动漫标签');
    expect(options[0].text()).toContain('danbooru-anime');
    expect(options[1].text()).toContain('自然语言');
  });

  it('注册表这一面缺席（404 / pack 清空）时退化成内置兜底，而不是一个空下拉', () => {
    dialectFace = undefined;
    const options = mount(ImageRenderCard).find('.dialect-select').findAll('option');

    expect(options).toHaveLength(1);
    expect(options[0].text()).toContain('danbooru-anime');
  });

  it('选中方言写进 imageDialectId', async () => {
    const w = mount(ImageRenderCard);
    await w.find('.dialect-select').setValue('natural-prose');
    expect(mockSettings.imageDialectId).toBe('natural-prose');
  });

  it('两个覆盖框的占位符 = 当前方言自己的默认值（改没改过一眼看得出）', async () => {
    const w = mount(ImageRenderCard);
    const textareas = w.findAll('textarea');

    expect(textareas[0].attributes('placeholder')).toBe('masterpiece');
    expect(textareas[1].attributes('placeholder')).toBe('lowres');
  });

  it('🔴 切了方言之后写的覆盖落在**新**方言那一格，不串门', async () => {
    const w = mount(ImageRenderCard);
    await w.find('.dialect-select').setValue('natural-prose');
    await w.findAll('textarea')[0].setValue('prose suffix');

    expect(mockSettings.imageDialectOverrides['natural-prose'].qualitySuffix).toBe('prose suffix');
    expect(mockSettings.imageDialectOverrides['danbooru-anime']).toBeUndefined();
  });

  it('🔴 supportsNegative:false → 「我的追加」**可见地禁用**，并说明为什么', async () => {
    mockSettings.imageDialectId = 'natural-prose';
    const w = mount(ImageRenderCard);

    expect(w.find('.extra-negative').attributes('disabled')).toBeDefined();
    const offs = w.findAll('.negative-off');
    expect(offs.length).toBeGreaterThan(0);
    expect(offs[offs.length - 1].text()).toContain('不支持负向');
  });

  it('🔴 supportsNegative:false → **方言级**基础负向也一起停用（两格是同一次丢弃）', async () => {
    // 装配层（image-prompt.ts 的 supportsNegative 分支）在这条方言下把基础负向整段丢成
    // 空串 —— 只停用旁边那格、这格照收，就成了「这格生效那格不生效」的猜谜
    mockSettings.imageDialectId = 'natural-prose';
    const w = mount(ImageRenderCard);

    expect(w.find('.base-negative').attributes('disabled')).toBeDefined();
    expect(w.findAll('.negative-off')).toHaveLength(2);
  });

  it('吃负向的方言下那两格照常可用（禁用是方言属性，不是永久状态）', () => {
    const w = mount(ImageRenderCard);
    expect(w.find('.extra-negative').attributes('disabled')).toBeUndefined();
    expect(w.find('.base-negative').attributes('disabled')).toBeUndefined();
    expect(w.find('.negative-off').exists()).toBe(false);
  });
});

describe('🔴 ImageRenderCard —— 覆盖的清空语义（与 ImagePromptCard 同一条纪律）', () => {
  it('清空 = **删键**，不是写一个空串（空串键是永远不生效的脏数据）', async () => {
    mockSettings.imageDialectOverrides = {
      'danbooru-anime': { qualitySuffix: '旧后缀', baseNegative: '旧负向' },
    };
    const w = mount(ImageRenderCard);
    const textareas = w.findAll('textarea');

    await textareas[0].setValue('');
    expect('qualitySuffix' in mockSettings.imageDialectOverrides['danbooru-anime']).toBe(false);
    // 另一格不受牵连
    expect(mockSettings.imageDialectOverrides['danbooru-anime'].baseNegative).toBe('旧负向');

    await textareas[1].setValue('');
    expect('baseNegative' in mockSettings.imageDialectOverrides['danbooru-anime']).toBe(false);
  });

  it('🔴 只剩空白也算清空 —— 一个空格是一份完全合法的覆盖，装配层会照单收下', async () => {
    mockSettings.imageDialectOverrides = { 'danbooru-anime': { qualitySuffix: '旧后缀' } };
    const w = mount(ImageRenderCard);

    await w.findAll('textarea')[0].setValue('  \n ');
    expect('qualitySuffix' in mockSettings.imageDialectOverrides['danbooru-anime']).toBe(false);
  });

  it('清空时不凭空造出一个空覆盖记录（本来没有的方言仍然没有）', async () => {
    const w = mount(ImageRenderCard);
    await w.findAll('textarea')[0].setValue(' ');
    expect(mockSettings.imageDialectOverrides['danbooru-anime']).toBeUndefined();
  });

  it('写非空值时仍存**原样文本**（回写 trim 后的值会在打字途中抹掉刚敲的空格）', async () => {
    const w = mount(ImageRenderCard);
    await w.findAll('textarea')[0].setValue('masterpiece, ');
    expect(mockSettings.imageDialectOverrides['danbooru-anime'].qualitySuffix).toBe(
      'masterpiece, ',
    );
  });
});
