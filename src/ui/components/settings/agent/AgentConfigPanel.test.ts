/**
 * AgentConfigPanel.vue —— 可复用配置面的接线测试
 *
 * 这个组件是从 `AgentSection` 抽出来的壳，抽的过程中最容易掉在地上的是**草稿载入**：
 *
 *   `watch(() => props.agentId, loadDrafts, { immediate: true })`
 *
 * Agent 分区在 SettingsPage 里是 `v-if`，每次进分区本组件都是新挂载的 ——
 * 少了 `immediate`，两个 textarea 会空着渲染，用户随手点一下「保存设置」就把
 * **空串**写进了自己的 systemPrompt。这条 bug 不会让类型检查变红、也不会让页面
 * 报错，只会静默吃掉用户的提示词。所以下面第一组用例是真正的看门人。
 *
 * 另外钉住两件抽壳时同样容易破的事：
 *   · story 走 PresetManager、其余走 AgentPromptCard（分叉发生在**本组件**）；
 *   · `AgentSection` 必须是**单根** `<section class="section centered">`
 *     （`.centered` 是 SettingsPage 的 scoped 规则，只够得到子组件根节点）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// ---- Mocks ----
// 引擎模板层：只需要「最后一级兜底」这个行为，不必把 worldbook-loader / preset-loader
// 整条链拖进 jsdom
vi.mock('@engine/agent-templates', () => ({
  getAgentTemplate: (id: string) => ({
    fixedSystem: `[引擎模板:${id}]`,
    fixedExamples: '',
  }),
}));

// settings-store：绕开启动期的 fetch / IndexedDB，只给本组件用到的表面
const mockSettings = reactive<Record<string, any>>({});
const mockStore = {
  settings: mockSettings,
  projectAgentDefaults: null as { agents: Record<string, any> } | null,
  saveAgentProjectDefaults: vi.fn(async () => true),
};
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => mockStore,
}));

import AgentConfigPanel from './AgentConfigPanel.vue';
import AgentPromptCard from './AgentPromptCard.vue';
import PresetManager from './PresetManager.vue';
import AgentSection from './AgentSection.vue';
import AppButton from '../../shared/AppButton.vue';

function resetSettings() {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    agents: {},
    agentDirty: {},
    agentPromptEdited: false,
    presets: [],
    activePresetId: '',
    apiPool: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  resetSettings();
  mockStore.projectAgentDefaults = null;
});

/** shallow：三张卡各自的内部实现不在本测试的射程内，只看接线 */
function mountPanel(agentId: string) {
  return mount(AgentConfigPanel, { props: { agentId }, shallow: true });
}

describe('AgentConfigPanel —— 草稿载入（immediate watch 看门人）', () => {
  it('🔴 挂载那一刻草稿就已经载好 —— 用户自定义值直接出现在提示词卡上', () => {
    mockSettings.agents.char_gen = { systemPrompt: '用户自定义提示词', template: '用户模板' };

    const w = mountPanel('char_gen');
    const card = w.findComponent(AgentPromptCard);

    // 少了 immediate 时这两条都会是空串 —— 那正是"保存设置写空串"的前一秒
    expect(card.props('prompt')).toBe('用户自定义提示词');
    expect(card.props('template')).toBe('用户模板');
  });

  it('没有用户值时落项目默认（agent-config.json）', () => {
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };

    const card = mountPanel('char_gen').findComponent(AgentPromptCard);
    expect(card.props('prompt')).toBe('项目默认提示词');
    expect(card.props('template')).toBe('项目默认模板');
  });

  it('项目默认也没有时落引擎内置模板（三级回退的最后一级）', () => {
    const card = mountPanel('char_gen').findComponent(AgentPromptCard);
    expect(card.props('prompt')).toBe('[引擎模板:char_gen]');
  });

  it('切 Agent 时草稿跟着换（watch 的 source 确实是 props.agentId）', async () => {
    mockSettings.agents.char_gen = { systemPrompt: '角色生成的提示词' };
    mockSettings.agents.item_gen = { systemPrompt: '物品生成的提示词' };

    const w = mountPanel('char_gen');
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('角色生成的提示词');

    await w.setProps({ agentId: 'item_gen' });
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('物品生成的提示词');
  });
});

describe('AgentConfigPanel —— 分叉与动作栏', () => {
  it('story 走预设面板，不渲染提示词卡', () => {
    const w = mountPanel('story');
    expect(w.findComponent(PresetManager).exists()).toBe(true);
    expect(w.findComponent(AgentPromptCard).exists()).toBe(false);
  });

  it('非 story 走提示词卡，不渲染预设面板', () => {
    const w = mountPanel('char_gen');
    expect(w.findComponent(AgentPromptCard).exists()).toBe(true);
    expect(w.findComponent(PresetManager).exists()).toBe(false);
  });

  it('🔴 hidePrompt 真的不渲染提示词卡（图像分区的 image_prompt 用）', () => {
    const w = mount(AgentConfigPanel, {
      props: { agentId: 'image_prompt', hidePrompt: true },
      shallow: true,
    });

    expect(w.findComponent(AgentPromptCard).exists()).toBe(false);
    // 参数卡与动作栏照旧 —— 藏的只是提示词那一张
    expect(w.findComponent(PresetManager).exists()).toBe(false);
    expect(w.findAllComponents(AppButton)).toHaveLength(2);
  });

  it('不传 hidePrompt 时一切照旧（默认 false，Agent 分区一个字不用改）', () => {
    expect(mountPanel('image_prompt').findComponent(AgentPromptCard).exists()).toBe(true);
  });

  it('🔴 hidePrompt 只藏渲染：草稿等于解析默认时「保存设置」照旧不写覆写层', async () => {
    mockStore.projectAgentDefaults = {
      agents: { image_prompt: { systemPrompt: '项目默认提示词' } },
    };
    const w = mount(AgentConfigPanel, {
      props: { agentId: 'image_prompt', hidePrompt: true },
      shallow: true,
    });

    await w.findAllComponents(AppButton)[1].vm.$emit('click');

    // 藏起来的草稿没被当成「用户清空了提示词」写成空串 —— 那正是 immediate watch 那条 bug 的形状
    expect(mockSettings.agents.image_prompt?.systemPrompt).toBeUndefined();
  });

  it('动作栏两个按钮（恢复默认 / 保存设置）—— 占位态无「保存为默认」（D14）', () => {
    expect(mountPanel('char_gen').findAllComponents(AppButton)).toHaveLength(2);
  });

  it('🔴「保存设置」提交的是载好的草稿，不是空串（草稿 ≠ 默认 → 写覆写）', async () => {
    // 草稿 ≠ 默认时，diff-write 会把草稿写进覆写层
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };
    const w = mountPanel('char_gen');
    // 载好的草稿来自默认层（= '项目默认提示词'）。改成用户编辑版，让 diff-write 真的写
    const card = w.findComponent(AgentPromptCard);
    await card.vm.$emit('update:prompt', '用户改过的提示词');
    await card.vm.$emit('update:template', '用户改过的模板');
    // 动作栏顺序：恢复成最新 / 保存设置
    await w.findAllComponents(AppButton)[1].vm.$emit('click');

    // 覆写层现在有用户版
    expect(mockSettings.agents.char_gen.systemPrompt).toBe('用户改过的提示词');
    expect(mockSettings.agents.char_gen.template).toBe('用户改过的模板');
    expect(mockSettings.agentDirty.char_gen).toBe(true);
  });

  it('🔴 D44 修正 4：草稿 === 解析默认 → 不写覆写（diff-write 删键，默认层接管）', async () => {
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };
    const w = mountPanel('char_gen');
    // 草稿载好 = 默认层的值（没改过）。点「保存设置」→ diff 相等 → 不写覆写键
    await w.findAllComponents(AppButton)[1].vm.$emit('click');

    // 🔴 覆写层**整条都不存在** —— 不只是键不存在，连空壳条目也不能留。
    //    （此前 patchAgentSettings 的 ensure 会在覆写层建 `{ char_gen: {} }` 空壳，
    //    那是「用户没改任何东西却冒出脏数据」。）
    expect('char_gen' in mockSettings.agents).toBe(false);
    expect(mockSettings.agents.char_gen).toBeUndefined();
    expect(mockSettings.agentDirty.char_gen).toBe(true);
  });

  it('story 的「保存设置」不写 systemPrompt（正文走预设子系统）', async () => {
    const w = mountPanel('story');
    await w.findAllComponents(AppButton)[1].vm.$emit('click');

    expect(mockSettings.agents.story?.systemPrompt).toBeUndefined();
    expect(mockSettings.agentDirty.story).toBe(true);
  });
});

describe('AgentSection —— 分区壳', () => {
  it('🔴 单根 <section class="section centered">（.centered 只够得到根节点）', () => {
    const w = mount(AgentSection, { props: { agentId: 'char_gen' }, shallow: true });
    expect(w.element.tagName).toBe('SECTION');
    expect(w.classes()).toContain('section');
    expect(w.classes()).toContain('centered');
  });

  it('页头显示 Agent 中文名，配置面按同一个 agentId 渲染', () => {
    const w = mount(AgentSection, { props: { agentId: 'char_gen' }, shallow: true });
    expect(w.find('.agent-detail-head h3').text()).toBe('角色生成');
    expect(w.findComponent(AgentConfigPanel).props('agentId')).toBe('char_gen');
  });
});
