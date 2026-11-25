/**
 * AgentConfigPanel.vue —— 可复用配置面的接线测试
 *
 * 这个组件是从 `AgentSection` 抽出来的壳，抽的过程中最容易掉在地上的是**草稿载入**：
 *
 *   `watch(() => props.agentId, loadDrafts, { immediate: true })`
 *
 * Agent 分区在 SettingsPage 里是 `v-if`，每次进分区本组件都是新挂载的 ——
 * 少了 `immediate`，两个 textarea 会空着渲染，用户随手点一下「保存提示词」就把
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
import { reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// ---- Mocks ----
// 引擎模板层：只需要「最后一级兜底」这个行为，不必把 worldbook-loader / preset-loader
// 整条链拖进 jsdom
vi.mock('@engine/prompts/agent-templates', () => ({
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
vi.mock('../../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => mockStore,
}));

const mockPresets = ref<any[]>([]);
const upsertPreset = vi.fn(async (preset: any) => {
  mockPresets.value.push(preset);
});
const effectivePreset = vi.fn(() => ({ presetId: '', preset: null }));
// 替身照真实 writeSelection 的口径写选择键：story 存空串，其余空值删键
const SELECTION_KEYS: Record<string, string> = {
  story: 'activePresetId',
  direct: 'directPresetId',
  direct_cached: 'directCachedPresetId',
};
const selectPreset = vi.fn((profile: string, id: string) => {
  const key = SELECTION_KEYS[profile];
  if (key === 'activePresetId') mockSettings.activePresetId = id;
  else if (id) mockSettings[key] = id;
  else delete mockSettings[key];
});
vi.mock('../../../../../src/ui/composables/usePresets', () => ({
  usePresets: () => ({
    presets: mockPresets,
    upsertPreset,
    effectivePreset,
    pristineEffectivePreset: effectivePreset,
    selectPreset,
  }),
}));

import AgentConfigPanel from '../../../../../src/ui/components/settings/agent/AgentConfigPanel.vue';
import AgentPromptCard from '../../../../../src/ui/components/settings/agent/AgentPromptCard.vue';
import PresetManager from '../../../../../src/ui/components/settings/agent/PresetManager.vue';
import AgentPresetBar from '../../../../../src/ui/components/settings/agent/AgentPresetBar.vue';
import AgentSection from '../../../../../src/ui/components/settings/agent/AgentSection.vue';
import AppButton from '../../../../../src/ui/components/shared/AppButton.vue';

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
  mockPresets.value = [];
});

/** shallow：三张卡各自的内部实现不在本测试的射程内，只看接线 */
function mountPanel(agentId: string) {
  return mount(AgentConfigPanel, { props: { agentId }, shallow: true });
}

/** 动作栏按钮按 data-testid 取（不按下标 —— 按钮的有无随 Agent 类型变化） */
function button(w: ReturnType<typeof mountPanel>, testId: string) {
  return w.findAllComponents(AppButton).find((b) => b.attributes('data-testid') === testId);
}
async function click(w: ReturnType<typeof mountPanel>, testId: string) {
  const b = button(w, testId);
  if (!b) throw new Error(`找不到按钮 ${testId}`);
  await b.vm.$emit('click');
}

describe('AgentConfigPanel —— 草稿载入（immediate watch 看门人）', () => {
  it('🔴 挂载那一刻草稿就已经载好 —— 用户自定义值直接出现在提示词卡上', () => {
    mockSettings.agents.entity_gen = { systemPrompt: '用户自定义提示词', template: '用户模板' };

    const w = mountPanel('entity_gen');
    const card = w.findComponent(AgentPromptCard);

    // 少了 immediate 时这两条都会是空串 —— 那正是"保存设置写空串"的前一秒
    expect(card.props('prompt')).toBe('用户自定义提示词');
    expect(card.props('template')).toBe('用户模板');
  });

  it('没有用户值时落项目默认（agent-config.json）', () => {
    mockStore.projectAgentDefaults = {
      agents: { entity_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };

    const card = mountPanel('entity_gen').findComponent(AgentPromptCard);
    expect(card.props('prompt')).toBe('项目默认提示词');
    expect(card.props('template')).toBe('项目默认模板');
  });

  it('项目默认也没有时落引擎内置模板（三级回退的最后一级）', () => {
    const card = mountPanel('entity_gen').findComponent(AgentPromptCard);
    expect(card.props('prompt')).toBe('[引擎模板:entity_gen]');
  });

  it('切 Agent 时草稿跟着换（watch 的 source 确实是 props.agentId）', async () => {
    mockSettings.agents.entity_gen = { systemPrompt: '实体生成的提示词' };
    mockSettings.agents.vars_update = { systemPrompt: '状态更新的提示词' };

    const w = mountPanel('entity_gen');
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('实体生成的提示词');

    await w.setProps({ agentId: 'vars_update' });
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('状态更新的提示词');
  });
});

describe('AgentConfigPanel —— 分叉与动作栏', () => {
  it.each([
    ['direct_main', 'directPresetId'],
    ['direct_cached', 'directCachedPresetId'],
  ])('恢复 %s 默认 = 清空选择键（跟随默认），不再往库里补预设', async (agentId, field) => {
    const preset = { id: `${agentId}-project`, name: 'Project preset', settings: {} };
    mockStore.projectAgentDefaults = { agents: { [agentId]: { presetId: preset.id, preset } } };
    mockSettings[field] = 'user-preset';
    const w = mountPanel(agentId);
    await click(w, 'restore-all-defaults');
    expect(mockSettings[field]).toBeUndefined();
    expect(upsertPreset).not.toHaveBeenCalled();
  });

  it.each([
    ['story', 'story'],
    ['direct_main', 'direct'],
    ['direct_cached', 'direct_cached'],
  ])(
    '🔴 恢复 %s 默认经 usePresets().selectPreset(profile, 空串)，不直接写选择键（R7）',
    async (agentId, profile) => {
      const w = mountPanel(agentId);
      await click(w, 'restore-all-defaults');
      expect(selectPreset).toHaveBeenCalledTimes(1);
      expect(selectPreset).toHaveBeenCalledWith(profile, '');
    },
  );

  it('非预设 Agent「全部恢复默认」不碰选择入口', async () => {
    const w = mountPanel('entity_gen');
    await click(w, 'restore-all-defaults');
    expect(selectPreset).not.toHaveBeenCalled();
  });

  it('恢复 story 默认 = 选择键置空串，不写库', async () => {
    const preset = { id: 'story-project', name: 'Project preset', settings: {} };
    mockStore.projectAgentDefaults = { agents: { story: { presetId: preset.id, preset } } };
    mockSettings.activePresetId = 'user-preset';
    const w = mountPanel('story');
    await click(w, 'restore-all-defaults');
    expect(mockSettings.activePresetId).toBe('');
    expect(upsertPreset).not.toHaveBeenCalled();
  });

  it('🔴 缓存直出「全部恢复默认」同时清掉渠道策略（回到默认 prefix）', async () => {
    mockSettings.directCacheProvider = 'anthropic';
    const w = mountPanel('direct_cached');
    await click(w, 'restore-all-defaults');
    expect(mockSettings.directCacheProvider ?? 'prefix').toBe('prefix');
  });

  it('缓存直出「全部恢复默认」同时删掉两个重建时机键（回到引擎默认）', async () => {
    mockSettings.directCacheRebuildTurns = 12;
    mockSettings.directCacheGrowthLimit = 2;
    const w = mountPanel('direct_cached');
    await click(w, 'restore-all-defaults');
    expect(mockSettings).not.toHaveProperty('directCacheRebuildTurns');
    expect(mockSettings).not.toHaveProperty('directCacheGrowthLimit');
  });

  it.each(['story', 'entity_gen', 'direct_main'])(
    '🔴 「全部恢复默认」在没有任何项目默认时也保留 API 池绑定（model）：%s',
    async (agentId) => {
      mockStore.projectAgentDefaults = null;
      mockSettings.agents[agentId] = { model: 'pool-1', temperature: 0.1, systemPrompt: 'x' };
      mockSettings.activePresetId = 'user-preset';
      const w = mountPanel(agentId);
      await click(w, 'restore-all-defaults');
      expect(mockSettings.agents[agentId]).toEqual({ model: 'pool-1' });
    },
  );

  it('「全部恢复默认」后草稿按默认层重载', async () => {
    mockStore.projectAgentDefaults = { agents: { entity_gen: { systemPrompt: '项目默认' } } };
    mockSettings.agents.entity_gen = { systemPrompt: '用户版' };
    const w = mountPanel('entity_gen');
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('用户版');
    await click(w, 'restore-all-defaults');
    expect(w.findComponent(AgentPromptCard).props('prompt')).toBe('项目默认');
  });

  it('story 走预设面板，不渲染提示词卡', () => {
    const w = mountPanel('story');
    expect(w.findComponent(PresetManager).exists()).toBe(true);
    expect(w.findComponent(AgentPromptCard).exists()).toBe(false);
  });

  it('非 story 走提示词卡，不渲染预设面板', () => {
    const w = mountPanel('entity_gen');
    expect(w.findComponent(AgentPromptCard).exists()).toBe(true);
    expect(w.findComponent(PresetManager).exists()).toBe(false);
  });

  it.each(['story', 'direct_main', 'entity_gen', 'image_prompt'])(
    '每个 Agent 都有「预设」状态条：%s',
    (agentId) => {
      expect(mountPanel(agentId).findComponent(AgentPresetBar).props('agentId')).toBe(agentId);
    },
  );

  it('🔴 预设条的「恢复默认」（非预设 Agent）只清 systemPrompt / 上下文模板两项覆写', async () => {
    mockStore.projectAgentDefaults = {
      agents: { entity_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };
    mockSettings.agents.entity_gen = {
      model: 'pool-1',
      temperature: 0.3,
      systemPrompt: '用户提示词',
      template: '用户模板',
    };
    const w = mountPanel('entity_gen');
    await w.findComponent(AgentPresetBar).vm.$emit('reset-prompt');
    expect(mockSettings.agents.entity_gen).toEqual({ model: 'pool-1', temperature: 0.3 });
    const card = w.findComponent(AgentPromptCard);
    expect(card.props('prompt')).toBe('项目默认提示词');
    expect(card.props('template')).toBe('项目默认模板');
  });

  it('预设条恢复后只剩空壳时，覆写层整条删掉', async () => {
    mockSettings.agents.entity_gen = { systemPrompt: '用户提示词' };
    const w = mountPanel('entity_gen');
    await w.findComponent(AgentPresetBar).vm.$emit('reset-prompt');
    expect('entity_gen' in mockSettings.agents).toBe(false);
  });

  it('🔴 hidePrompt 真的不渲染提示词卡（图像分区的 image_prompt 用）', () => {
    const w = mount(AgentConfigPanel, {
      props: { agentId: 'image_prompt', hidePrompt: true },
      shallow: true,
    });

    expect(w.findComponent(AgentPromptCard).exists()).toBe(false);
    expect(w.findComponent(PresetManager).exists()).toBe(false);
    expect(w.findComponent(AgentPresetBar).exists()).toBe(false);
    // 参数卡与「全部恢复默认」照旧；没有可保存的提示词，故无「保存提示词」
    expect(button(w, 'restore-all-defaults')).toBeDefined();
    expect(button(w, 'save-prompt')).toBeUndefined();
  });

  it('不传 hidePrompt 时一切照旧（默认 false，Agent 分区一个字不用改）', () => {
    expect(mountPanel('image_prompt').findComponent(AgentPromptCard).exists()).toBe(true);
  });

  it('非预设 Agent 动作栏：全部恢复默认 / 保存提示词 —— 占位态无「保存为默认」（D14）', () => {
    const w = mountPanel('entity_gen');
    expect(w.findAllComponents(AppButton).map((b) => b.attributes('data-testid'))).toEqual([
      'restore-all-defaults',
      'save-prompt',
    ]);
    // 按钮文字要真渲染 AppButton 才看得到（shallow 的桩不渲染插槽）
    const real = mount(AgentConfigPanel, {
      props: { agentId: 'entity_gen' },
      shallow: true,
      global: { stubs: { AppButton: false } },
    });
    expect(real.find('[data-testid="save-prompt"]').text()).toBe('保存提示词');
    expect(real.find('[data-testid="restore-all-defaults"]').text()).toBe('全部恢复默认');
  });

  it.each(['story', 'direct_main', 'direct_cached'])(
    '预设型 Agent 没有「保存」按钮（预设改动当场落库）：%s',
    (agentId) => {
      const w = mountPanel(agentId);
      expect(button(w, 'save-prompt')).toBeUndefined();
      expect(button(w, 'restore-all-defaults')).toBeDefined();
    },
  );

  it('🔴「保存提示词」提交的是载好的草稿，不是空串（草稿 ≠ 默认 → 写覆写）', async () => {
    // 草稿 ≠ 默认时，diff-write 会把草稿写进覆写层
    mockStore.projectAgentDefaults = {
      agents: { entity_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };
    const w = mountPanel('entity_gen');
    // 载好的草稿来自默认层（= '项目默认提示词'）。改成用户编辑版，让 diff-write 真的写
    const card = w.findComponent(AgentPromptCard);
    await card.vm.$emit('update:prompt', '用户改过的提示词');
    await card.vm.$emit('update:template', '用户改过的模板');
    await click(w, 'save-prompt');

    // 覆写层现在有用户版
    expect(mockSettings.agents.entity_gen.systemPrompt).toBe('用户改过的提示词');
    expect(mockSettings.agents.entity_gen.template).toBe('用户改过的模板');
    expect(mockSettings.agentDirty.entity_gen).toBe(true);
  });

  it('🔴 D44 修正 4：草稿 === 解析默认 → 不写覆写（diff-write 删键，默认层接管）', async () => {
    mockStore.projectAgentDefaults = {
      agents: { entity_gen: { systemPrompt: '项目默认提示词', template: '项目默认模板' } },
    };
    const w = mountPanel('entity_gen');
    // 草稿载好 = 默认层的值（没改过）。点「保存提示词」→ diff 相等 → 不写覆写键
    await click(w, 'save-prompt');

    // 🔴 覆写层**整条都不存在** —— 不只是键不存在，连空壳条目也不能留。
    //    （此前 patchAgentSettings 的 ensure 会在覆写层建 `{ entity_gen: {} }` 空壳，
    //    那是「用户没改任何东西却冒出脏数据」。）
    expect('entity_gen' in mockSettings.agents).toBe(false);
    expect(mockSettings.agents.entity_gen).toBeUndefined();
    expect(mockSettings.agentDirty.entity_gen).toBe(true);
  });
});

describe('AgentSection —— 分区壳', () => {
  it('🔴 单根 <section class="section centered">（.centered 只够得到根节点）', () => {
    const w = mount(AgentSection, { props: { agentId: 'entity_gen' }, shallow: true });
    expect(w.element.tagName).toBe('SECTION');
    expect(w.classes()).toContain('section');
    expect(w.classes()).toContain('centered');
  });

  it('页头显示 Agent 中文名，配置面按同一个 agentId 渲染', () => {
    const w = mount(AgentSection, { props: { agentId: 'entity_gen' }, shallow: true });
    expect(w.find('.agent-detail-head h3').text()).toBe('实体生成');
    expect(w.findComponent(AgentConfigPanel).props('agentId')).toBe('entity_gen');
  });
});

describe('S-15 未保存的提示词修改', () => {
  it('改了草稿 → 显示「未保存」并通知壳层；保存后清掉', async () => {
    const { promptDraftDirty } =
      await import('../../../../../src/ui/components/settings/agent/prompt-dirty-guard');
    mockSettings.agents.entity_gen = { systemPrompt: '原提示词', template: '原模板' };
    const w = mountPanel('entity_gen');
    expect(w.find('.unsaved-marker').exists()).toBe(false);
    expect(promptDraftDirty.value).toBe(false);

    await w.findComponent(AgentPromptCard).vm.$emit('update:prompt', '改过的提示词');
    expect(w.get('.unsaved-marker').text()).toBe('未保存');
    expect(promptDraftDirty.value).toBe(true);

    // 动作栏最后一个按钮是「保存设置」
    const buttons = w.findAllComponents(AppButton);
    await buttons[buttons.length - 1].vm.$emit('click');
    expect(mockSettings.agents.entity_gen.systemPrompt).toBe('改过的提示词');
    expect(w.find('.unsaved-marker').exists()).toBe(false);
    expect(promptDraftDirty.value).toBe(false);
  });

  it('改回原样 = 不算未保存；卸载时清掉标志，不带到下一次挂载', async () => {
    const { promptDraftDirty } =
      await import('../../../../../src/ui/components/settings/agent/prompt-dirty-guard');
    mockSettings.agents.entity_gen = { systemPrompt: '原提示词', template: '原模板' };
    const w = mountPanel('entity_gen');
    const card = w.findComponent(AgentPromptCard);
    await card.vm.$emit('update:template', '临时改动');
    expect(promptDraftDirty.value).toBe(true);
    await card.vm.$emit('update:template', '原模板');
    expect(promptDraftDirty.value).toBe(false);
    await card.vm.$emit('update:template', '又改了');
    expect(promptDraftDirty.value).toBe(true);
    w.unmount();
    expect(promptDraftDirty.value).toBe(false);
  });
});
