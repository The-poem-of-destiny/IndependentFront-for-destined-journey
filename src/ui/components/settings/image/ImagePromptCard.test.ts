/**
 * ImagePromptCard.vue —— 提示词生成卡的两条边界
 *
 * 1. **systemPrompt 的真源换了地方**（图像 v2 / C3·C6）。它不再住 `agents.image_prompt`
 *    的袋子里，而是**方言属性**：默认值来自方言 JSON，用户改动按方言 id 键控存进
 *    `imageDialectOverrides[dialectId].systemPrompt`。所以这张卡必须给
 *    `AgentConfigPanel` 传 `hide-prompt` —— 留着那个旧框就是两个长得一样的框，
 *    一个跟方言走一个不跟，改完看着生效、换条方言又变回去，且两边都不报错。
 *
 * 2. **清空 = 删键，不是写空串**。`resolveImageDialect` 把空串当「没覆盖」，
 *    留一个空串键只会在设置里攒下永远不生效的脏数据（与 AgentConfigPanel 的
 *    diff-write「相等就删键」同一条纪律）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mockSettings = reactive<Record<string, any>>({});
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}));

/** 内容注册表第 7 面（方言）—— 整层替掉，不把 Dexie / fetch 拖进 jsdom */
let dialectFace: unknown;
vi.mock('../../../stores/content-store', () => ({
  getContentRegistry: () => ({ imageDialects: dialectFace }),
  ensureContentRegistryLoaded: async () => {},
}));

import ImagePromptCard from './ImagePromptCard.vue';
import AgentConfigPanel from '../agent/AgentConfigPanel.vue';
import AppButton from '../../shared/AppButton.vue';

const DIALECT_FIXTURE = {
  dialects: [
    { id: 'danbooru-anime', label: '动漫标签', systemPrompt: '把场景转成 danbooru 标签' },
    { id: 'natural-prose', label: '自然语言', systemPrompt: '写一句英文描述' },
  ],
};

/**
 * `AgentConfigPanel` 整块 stub：它自己的接线（草稿 / 三个动作）有独立测试，
 * 拖进来只会把 usePresets → Dexie 那条链一起拖进 jsdom。
 */
function mountCard() {
  return mount(ImagePromptCard, { global: { stubs: { AgentConfigPanel: true } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  dialectFace = DIALECT_FIXTURE;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    imageDialectId: 'danbooru-anime',
    imageDialectOverrides: {},
  });
});

describe('🔴 ImagePromptCard —— 提示词不许开两个入口（C6/D53）', () => {
  it('把 image_prompt 交给 AgentConfigPanel（同一份 agents 存储），并要求它藏掉提示词卡', () => {
    const panel = mount(ImagePromptCard, { shallow: true }).findComponent(AgentConfigPanel);

    expect(panel.props('agentId')).toBe('image_prompt');
    expect(panel.props('hidePrompt')).toBe(true);
  });

  it('卡上写明这里的提示词管什么（与「出图」卡那两处提示词区分开）', () => {
    const text = mountCard().find('.image-card-scope').text();
    expect(text).toContain('出图');
    expect(text).toContain('方言');
  });
});

describe('ImagePromptCard —— 按方言分档的 systemPrompt（C6）', () => {
  it('标题写着当前方言，占位符是这条方言自带的默认提示词', () => {
    const w = mountCard();

    expect(w.find('.dialect-prompt-head h4').text()).toContain('动漫标签');
    expect(w.find('.dialect-prompt-input').attributes('placeholder')).toBe(
      '把场景转成 danbooru 标签',
    );
  });

  it('🔴 写进去的是 id 键控的那一格，不是全局一份', async () => {
    const w = mountCard();
    await w.find('.dialect-prompt-input').setValue('我的转写规则');

    expect(mockSettings.imageDialectOverrides['danbooru-anime'].systemPrompt).toBe('我的转写规则');
    expect(mockSettings.agents?.image_prompt).toBeUndefined();
  });

  it('🔴 切方言之后写的落在新方言那一格，旧方言的覆盖原样留着', async () => {
    mockSettings.imageDialectOverrides = { 'danbooru-anime': { systemPrompt: '标签版' } };
    const w = mountCard();

    // 切方言（这一格由「出图」卡的下拉写，这里直接改设置模拟）
    mockSettings.imageDialectId = 'natural-prose';
    await w.vm.$nextTick();

    expect((w.find('.dialect-prompt-input').element as HTMLTextAreaElement).value).toBe('');
    await w.find('.dialect-prompt-input').setValue('散文版');

    expect(mockSettings.imageDialectOverrides['natural-prose'].systemPrompt).toBe('散文版');
    expect(mockSettings.imageDialectOverrides['danbooru-anime'].systemPrompt).toBe('标签版');
  });

  it('🔴 清空 = **删键**，不是写一个空串（空串键是永远不生效的脏数据）', async () => {
    mockSettings.imageDialectOverrides = { 'danbooru-anime': { systemPrompt: '旧的' } };
    const w = mountCard();

    await w.find('.dialect-prompt-input').setValue('');
    expect('systemPrompt' in mockSettings.imageDialectOverrides['danbooru-anime']).toBe(false);
  });

  it('🔴 只剩空白也算清空 —— 一个空格会成为这条侧链的**全部**系统提示词', async () => {
    // resolveImageDialect 只看 length > 0、装配层只看真假：' ' 是一份完全合法的覆盖，
    // 于是 image_prompt 顶着一个内容为空格的 systemPrompt 去跑，产出垃圾且无人报错
    mockSettings.imageDialectOverrides = { 'danbooru-anime': { systemPrompt: '旧的' } };
    const w = mountCard();

    await w.find('.dialect-prompt-input').setValue('   \n ');
    expect('systemPrompt' in mockSettings.imageDialectOverrides['danbooru-anime']).toBe(false);
    expect(w.find('.dialect-prompt-state').text()).toContain('方言自带');
  });

  it('清空时不凭空造出一个空覆盖记录（本来没有的方言仍然没有）', async () => {
    const w = mountCard();
    await w.find('.dialect-prompt-input').setValue(' ');
    expect(mockSettings.imageDialectOverrides['danbooru-anime']).toBeUndefined();
  });

  it('「恢复本方言默认」按钮清掉覆盖，且只在真有覆盖时可按', async () => {
    const w = mountCard();
    const button = () => w.findAllComponents(AppButton).find((b) => b.text().includes('恢复'))!;

    // 没覆盖过 → 按钮是禁用的（点了没反应的按钮比没有按钮更糟）
    expect(button().props('disabled')).toBe(true);

    await w.find('.dialect-prompt-input').setValue('我的转写规则');
    expect(button().props('disabled')).toBe(false);

    await button().find('button').trigger('click');
    expect(mockSettings.imageDialectOverrides['danbooru-anime'].systemPrompt).toBeUndefined();
    expect((w.find('.dialect-prompt-input').element as HTMLTextAreaElement).value).toBe('');
  });

  it('状态行如实说「现在用的是哪一份」', async () => {
    const w = mountCard();
    expect(w.find('.dialect-prompt-state').text()).toContain('方言自带');

    await w.find('.dialect-prompt-input').setValue('我的转写规则');
    expect(w.find('.dialect-prompt-state').text()).toContain('已覆盖');
  });

  it('注册表这一面缺席时退化成内置兜底方言，不炸也不空白', () => {
    dialectFace = undefined;
    const w = mountCard();

    expect(w.find('.dialect-prompt-head h4').text()).toContain('动漫标签');
    // 兜底方言**自带 v1 那段完整提示词**（2026-08-08 修）：占位符直接把它摆出来，
    // 用户看得见「留空会用哪一份」。此前这里是空的、占位符只说一句「会回落到内置模板」——
    // 而那个「内置模板」其实是 agent-templates 的一行 stub，规则一条都没有
    expect(w.find('.dialect-prompt-input').attributes('placeholder')).toContain('<image_prompt>');
  });
});
