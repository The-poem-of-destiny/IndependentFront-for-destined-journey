/**
 * AgentUpdateCenter.vue —— 覆写差异面板接线测试（D44 修正 4 重定位后）
 *
 * 核心行为（v1.2 重定位）：
 *   · 没有覆写条目 → 不渲染（让空态的「← 请从左侧选择」独占）
 *   · 覆写层有任意键的 agent → 列出来 + per-agent「清除覆写」
 *   · 多于 1 条时额外渲染「全部清除覆写」
 *   · story 的世界书/旋钮覆写也列（只不显示提示词字段，但 story 的其它覆写仍可清）
 *   · 「清除覆写」后该条从列表消失（reactive 重算），model 保留
 *
 * v1.1 首版（提示词更新中心）的行为已被取代 —— 它曾对四位测试者永远报「全部与最新
 * 默认不同」，因为他们的覆写层存着 boot 播种抄进去的旧默认 systemPrompt。指纹迁移
 * （修正 3）清掉那些之后，本面板对他们不再误报。
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

describe('AgentUpdateCenter —— 渲染门控（覆写差异）', () => {
  it('覆写层为空 → 不渲染', () => {
    expect(mountCenter().find('.update-center').exists()).toBe(false);
  });

  it('覆写层有条目 → 渲染并列出', () => {
    mockSettings.agents.char_gen = { systemPrompt: '用户改的' };
    const w = mountCenter();
    expect(w.find('.update-center').exists()).toBe(true);
    expect(w.find('.update-row-name').text()).toBe('角色生成');
    expect(w.find('.update-row-fields').text()).toContain('提示词');
    // 只列 1 条时不显示「全部清除覆写」
    expect(w.findAll('.update-all')).toHaveLength(0);
  });

  it('多条覆写 → 渲染「全部清除覆写」', () => {
    mockSettings.agents.char_gen = { systemPrompt: 'A' };
    mockSettings.agents.item_gen = { systemPrompt: 'B' };
    mockSettings.agents.vars_update = { temperature: 0.5 };
    const w = mountCenter();
    expect(w.findAll('.update-row')).toHaveLength(3);
    expect(w.find('.update-all').exists()).toBe(true);
  });

  it('覆写字段标签中文化（temperature → Temperature 等）', () => {
    mockSettings.agents.char_gen = {
      temperature: 0.5,
      worldBookEnabled: true,
      maxTokens: 8192,
    };
    const w = mountCenter();
    const fields = w.find('.update-row-fields').text();
    expect(fields).toContain('Temperature');
    expect(fields).toContain('世界书开关');
    expect(fields).toContain('Max Tokens');
  });
});

describe('AgentUpdateCenter —— 清除覆写动作', () => {
  it('per-agent「清除覆写」→ 清掉该 agent 除 model 外的覆写 + toast', async () => {
    mockSettings.agents.char_gen = {
      systemPrompt: '用户改的',
      model: 'deepseek-chat', // model 应保留
      temperature: 1.5,
    };
    mockSettings.agents.item_gen = { systemPrompt: 'B' };

    const w = mountCenter();
    await w.findAllComponents(AppButton)[0].vm.$emit('click');

    // char_gen 的非 model 字段清光，model 保留
    expect(mockSettings.agents.char_gen).toEqual({ model: 'deepseek-chat' });
    // item_gen 没被动
    expect(mockSettings.agents.item_gen.systemPrompt).toBe('B');
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('🔴 清除后该条从列表消失（reactive 重算）', async () => {
    mockSettings.agents.char_gen = { systemPrompt: 'A' };
    mockSettings.agents.item_gen = { systemPrompt: 'B' };

    const w = mountCenter();
    expect(w.findAll('.update-row')).toHaveLength(2);

    await w.findAllComponents(AppButton)[0].vm.$emit('click');
    // 被清的那条（model 也没有 → 整条删）消失
    expect(w.findAll('.update-row')).toHaveLength(1);
  });

  it('「全部清除覆写」→ 清所有（边遍历边改 reactive 源不跳条）+ 单 toast', async () => {
    mockSettings.agents.char_gen = { systemPrompt: 'A', model: 'm1' };
    mockSettings.agents.item_gen = { systemPrompt: 'B', model: 'm2' };
    mockSettings.agents.vars_update = { systemPrompt: 'C', model: 'm3' };

    const w = mountCenter();
    const buttons = w.findAllComponents(AppButton);
    const clearAllBtn = buttons[buttons.length - 1];
    await clearAllBtn.vm.$emit('click');

    // 全部清成只剩 model
    expect(mockSettings.agents.char_gen).toEqual({ model: 'm1' });
    expect(mockSettings.agents.item_gen).toEqual({ model: 'm2' });
    expect(mockSettings.agents.vars_update).toEqual({ model: 'm3' });
    // 全部清除后列表清空
    expect(w.findAll('.update-row')).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toContain('3');
  });

  it('清除后解析值回默认层（applyProjectDefaultToAgent 清覆写，默认层接管）', async () => {
    mockStore.projectAgentDefaults = {
      agents: { char_gen: { systemPrompt: '默认提示词', temperature: 0.4 } },
    };
    mockSettings.agents.char_gen = {
      systemPrompt: '用户改的',
      model: 'ep-user',
      temperature: 1.5,
    };

    const w = mountCenter();
    await w.findAllComponents(AppButton)[0].vm.$emit('click');

    // 清后 model 保留、其余走默认层
    const got = getAgentSettings(mockSettings, 'char_gen', mockStore.projectAgentDefaults!.agents);
    expect(got.model).toBe('ep-user'); // 保留
    expect(got.systemPrompt).toBe('默认提示词'); // 默认层接管
    expect(got.temperature).toBe(0.4); // 默认层接管
  });
});
