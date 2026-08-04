/**
 * 「保存为项目默认」的装配（Q-25 第 9 步）
 *
 * 守的是那条 story / 非 story 的分叉：两侧存的是**两样东西**，
 * 写串了不会编译报错，只会在下次「恢复项目默认」时把用户的正文提示词换成空串。
 */
import { describe, it, expect } from 'vitest';
import { buildAgentDefaultEntry } from './agent-defaults';
import { AGENT_SETTINGS_DEFAULTS, type AgentSettingsEntry } from '../../../stores/agent-settings';
import type { PresetItem } from '../../../stores/settings-store';

function settings(over: Partial<AgentSettingsEntry> = {}): AgentSettingsEntry {
  return {
    model: 'ep1',
    worldBookEnabled: true,
    worldBookIds: ['world_setting'],
    systemPrompt: '袋子里存着的旧提示词',
    template: '袋子里存着的旧模板',
    temperature: 1.2,
    topP: 0.9,
    freqPen: 0.1,
    presPen: 0.2,
    maxTokens: 8192,
    historyLayers: 3,
    ...over,
  };
}

const preset = (): PresetItem => ({
  id: 'p1',
  name: '默认预设',
  settings: { prompts: [{ name: 'main', content: '第二人称叙事' }] },
  createdAt: 1,
  updatedAt: 2,
});

describe('buildAgentDefaultEntry — 非 story', () => {
  it('存草稿里的 systemPrompt / template，预设两项留空', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'vars_update',
      settings: settings(),
      promptDraft: '只输出补丁',
      templateDraft: '{{HISTORY}}',
      activePresetId: 'p1',
      activePreset: preset(),
    });
    expect(e.systemPrompt).toBe('只输出补丁');
    expect(e.template).toBe('{{HISTORY}}');
    // 🔴 就算此刻选着预设也不能存进来 —— 非 story 没有预设这回事
    expect(e.presetId).toBe('');
    expect(e.preset).toBeNull();
  });

  it('数值旋钮与世界书原样带过去', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'char_gen',
      settings: settings(),
      promptDraft: '',
      templateDraft: '',
      activePresetId: '',
      activePreset: null,
    });
    expect(e.temperature).toBe(1.2);
    expect(e.maxTokens).toBe(8192);
    expect(e.historyLayers).toBe(3);
    expect(e.worldBookIds).toEqual(['world_setting']);
    expect(e.model).toBe('ep1');
  });

  it('草稿为空 → 存空串（而不是把袋子里的旧值漏出去）', () => {
    // 袋子里 systemPrompt 是「袋子里存着的旧提示词」；用户把编辑框清空了，
    // 保存为默认就该是空，不能悄悄回退成旧值。
    const e = buildAgentDefaultEntry({
      agentId: 'char_gen',
      settings: settings(),
      promptDraft: '',
      templateDraft: '',
      activePresetId: '',
      activePreset: null,
    });
    expect(e.systemPrompt).toBe('');
    expect(e.template).toBe('');
  });
});

describe('buildAgentDefaultEntry — story', () => {
  it('存 presetId + 整份 preset，systemPrompt / template 留空', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'story',
      settings: settings(),
      promptDraft: '这段不该被存',
      templateDraft: '这段也不该',
      activePresetId: 'p1',
      activePreset: preset(),
    });
    expect(e.presetId).toBe('p1');
    expect(e.preset?.id).toBe('p1');
    // 🔴 正文的系统提示词由预设提供；再存一份就是两个真源
    expect(e.systemPrompt).toBe('');
    expect(e.template).toBe('');
  });

  it('🔴 preset 是深拷贝 —— 之后改 store 里那份不会动到已保存的默认', () => {
    const p = preset();
    const e = buildAgentDefaultEntry({
      agentId: 'story',
      settings: settings(),
      promptDraft: '',
      templateDraft: '',
      activePresetId: 'p1',
      activePreset: p,
    });
    (p.settings as Record<string, unknown>).prompts = [{ name: 'main', content: '被改掉了' }];
    expect((e.preset!.settings as any).prompts[0].content).toBe('第二人称叙事');
    expect(e.preset).not.toBe(p);
  });

  it('没选预设 → presetId 空、preset 为 null（不塞一个半截对象）', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'story',
      settings: settings(),
      promptDraft: '',
      templateDraft: '',
      activePresetId: '',
      activePreset: null,
    });
    expect(e.presetId).toBe('');
    expect(e.preset).toBeNull();
  });

  it('activePresetId 有值但整份预设取不到 → 只存 id，不伪造 preset', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'story',
      settings: settings(),
      promptDraft: '',
      templateDraft: '',
      activePresetId: 'p_missing',
      activePreset: null,
    });
    expect(e.presetId).toBe('p_missing');
    expect(e.preset).toBeNull();
  });
});

describe('buildAgentDefaultEntry — 与 AgentSettingsEntry 同形', () => {
  it('缺省的数值项落 AGENT_SETTINGS_DEFAULTS（由调用方的 getAgentSettings 合上）', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'item_gen',
      settings: {
        ...settings(),
        temperature: AGENT_SETTINGS_DEFAULTS.temperature,
        maxTokens: AGENT_SETTINGS_DEFAULTS.maxTokens,
      },
      promptDraft: '',
      templateDraft: '',
      activePresetId: '',
      activePreset: null,
    });
    expect(e.temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
    expect(e.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
  });

  it('historyLayers 缺省时不会被补成 0（键在语义上必须能缺席）', () => {
    const e = buildAgentDefaultEntry({
      agentId: 'item_gen',
      settings: settings({ historyLayers: undefined, historySlice: undefined }),
      promptDraft: '',
      templateDraft: '',
      activePresetId: '',
      activePreset: null,
    });
    expect(e.historyLayers).toBeUndefined();
    expect(e.historySlice).toBeUndefined();
  });
});
