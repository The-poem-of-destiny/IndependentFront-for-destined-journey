/**
 * AgentUpdateCenter.vue —— 提示词更新中心接线测试
 *
 * 核心行为：
 *   · 用户提示词 === 当前默认 → 不渲染（让空态的「← 请从左侧选择」独占）
 *   · 用户提示词 ≠ 当前默认 → 列出来 + per-agent「恢复成最新」
 *   · 多于 1 条时额外渲染「全部恢复成最新」
 *   · story 永远不进本中心（走预设，不是裸 systemPrompt 串）
 *   · 「恢复成最新」后该条从列表消失（reactive 重算）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// ---- Mocks ----
const mockSettings = reactive<Record<string, any>>({});
const mockStore = {
  settings: mockSettings,
  projectAgentDefaults: null as { agents: Record<string, any> } | null,
};
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => mockStore,
}));

const mockToast = vi.fn();
vi.mock('../../../stores/ui-store', () => ({
  useUIStore: () => ({ toast: mockToast }),
}));

import AgentUpdateCenter from './AgentUpdateCenter.vue';
import AppButton from '../../shared/AppButton.vue';
import { getAgentSettings } from '../../../stores/agent-settings';

function resetSettings() {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, { agents: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  resetSettings();
  mockStore.projectAgentDefaults = null;
});

function mountCenter() {
  return mount(AgentUpdateCenter, { shallow: true });
}

describe('AgentUpdateCenter —— 渲染门控', () => {
  it('没有项目默认时 → 不渲染', () => {
    expect(mountCenter().find('.update-center').exists()).toBe(false);
  });

  it('用户提示词 === 当前默认 → 不渲染', () => {
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '最新默认', template: '默认模板' } },
    };
    mockSettings.agents.char_gen = { systemPrompt: '最新默认', template: '默认模板' };
    expect(mountCenter().find('.update-center').exists()).toBe(false);
  });

  it('用户提示词 ≠ 当前默认 → 渲染并列出', () => {
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '新版默认', template: '新模板' } },
    };
    mockSettings.agents.char_gen = { systemPrompt: '旧版默认', template: '旧模板' };
    const w = mountCenter();
    expect(w.find('.update-center').exists()).toBe(true);
    expect(w.find('.update-row-name').text()).toBe('角色生成');
    // 只列 1 条时不显示「全部恢复成最新」
    expect(w.findAll('.update-all')).toHaveLength(0);
  });

  it('多条差异 → 渲染「全部恢复成最新」', () => {
    mockStore.projectAgentDefaults = {
      agents: {
        char_gen: { systemPrompt: '新版A' },
        item_gen: { systemPrompt: '新版B' },
        vars_update: { systemPrompt: '新版C' },
      },
    };
    mockSettings.agents.char_gen = { systemPrompt: '旧版A' };
    mockSettings.agents.item_gen = { systemPrompt: '旧版B' };
    mockSettings.agents.vars_update = { systemPrompt: '旧版C' };
    const w = mountCenter();
    expect(w.findAll('.update-row')).toHaveLength(3);
    expect(w.find('.update-all').exists()).toBe(true);
  });

  it('🔴 story 永不进本中心 —— 即使提示词不同也不列', () => {
    mockStore.projectAgentDefaults = {
      agents: {
        story: { systemPrompt: 'story 默认', presetId: '', preset: null },
        char_gen: { systemPrompt: 'char 默认' },
      },
    };
    mockSettings.agents.story = { systemPrompt: 'story 用户版' };
    mockSettings.agents.char_gen = { systemPrompt: 'char 用户版' };
    const w = mountCenter();
    // story 不列；char_gen 的提示词≠默认才列
    const names = w.findAll('.update-row-name').map((n) => n.text());
    expect(names).not.toContain('正文生成');
    expect(names).toContain('角色生成');
  });
});

describe('AgentUpdateCenter —— 恢复动作', () => {
  it('per-agent「恢复成最新」→ 只同步那一个 + toast', async () => {
    mockStore.projectAgentDefaults = {
      agents: {
        char_gen: { systemPrompt: '新版', template: '新模板', worldBookIds: [] },
        item_gen: { systemPrompt: '新版B', template: '新模板B', worldBookIds: [] },
      },
    };
    mockSettings.agents.char_gen = { systemPrompt: '旧版', model: 'deepseek-chat' };
    mockSettings.agents.item_gen = { systemPrompt: '旧版B', model: 'glm-4' };

    const w = mountCenter();
    // 点 char_gen 那条的按钮
    await w.findAllComponents(AppButton)[0].vm.$emit('click');

    const charGen = getAgentSettings(mockSettings, 'char_gen');
    expect(charGen.systemPrompt).toBe('新版');
    expect(charGen.template).toBe('新模板');
    // 🔴 model 保留不动
    expect(charGen.model).toBe('deepseek-chat');
    // item_gen 没被动
    expect(getAgentSettings(mockSettings, 'item_gen').systemPrompt).toBe('旧版B');
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('🔴 恢复后该条从列表消失（reactive 重算）', async () => {
    mockStore.projectAgentDefaults = {
      agents: {
        char_gen: { systemPrompt: '新版' },
        item_gen: { systemPrompt: '新版B' },
      },
    };
    mockSettings.agents.char_gen = { systemPrompt: '旧版' };
    mockSettings.agents.item_gen = { systemPrompt: '旧版B' };

    const w = mountCenter();
    expect(w.findAll('.update-row')).toHaveLength(2);

    await w.findAllComponents(AppButton)[0].vm.$emit('click');
    expect(w.findAll('.update-row')).toHaveLength(1);
  });

  it('「全部恢复成最新」→ 同步所有（边遍历边改 reactive 源不跳条）+ 单 toast', async () => {
    mockStore.projectAgentDefaults = {
      agents: {
        char_gen: { systemPrompt: '新版A', worldBookIds: [] },
        item_gen: { systemPrompt: '新版B', worldBookIds: [] },
        vars_update: { systemPrompt: '新版C', worldBookIds: [] },
      },
    };
    mockSettings.agents.char_gen = { systemPrompt: '旧版A', model: 'm1' };
    mockSettings.agents.item_gen = { systemPrompt: '旧版B', model: 'm2' };
    mockSettings.agents.vars_update = { systemPrompt: '旧版C', model: 'm3' };

    const w = mountCenter();
    // 最后一个 AppButton 是「全部恢复成最新」（前面每条一个）
    const buttons = w.findAllComponents(AppButton);
    const restoreAllBtn = buttons[buttons.length - 1];
    await restoreAllBtn.vm.$emit('click');

    expect(getAgentSettings(mockSettings, 'char_gen').systemPrompt).toBe('新版A');
    expect(getAgentSettings(mockSettings, 'item_gen').systemPrompt).toBe('新版B');
    expect(getAgentSettings(mockSettings, 'vars_update').systemPrompt).toBe('新版C');
    // 🔴 model 全保留
    expect(getAgentSettings(mockSettings, 'char_gen').model).toBe('m1');
    expect(getAgentSettings(mockSettings, 'item_gen').model).toBe('m2');
    expect(getAgentSettings(mockSettings, 'vars_update').model).toBe('m3');
    // 全部恢复后列表清空
    expect(w.findAll('.update-row')).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toContain('3');
  });
});
