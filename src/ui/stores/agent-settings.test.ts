/**
 * agent-settings 专项测试（Q-18）
 *
 * 三条真正会被下一次改动打破的性质：
 *   1. 数值默认只有一处 —— 断言读到的就是 `AGENT_SETTINGS_DEFAULTS`，不是复述的字面量
 *   2. `historyLayers` / `historySlice` **不合默认**，且「没给」= 删键
 *      —— 那条语义只写在注释里，一旦被「顺手补全」，引擎按 agent 类别给的默认会被静默盖掉
 *   3. `fillMissingAgentSettings` 只填空位、不覆盖用户已改的
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_SETTINGS_DEFAULTS,
  fillMissingAgentSettings,
  getAgentSettings,
  patchAgentSettings,
  resetAgentSettings,
} from './agent-settings';

const bag = (): Record<string, any> => ({});

describe('getAgentSettings', () => {
  it('空袋子 → 数值项落 AGENT_SETTINGS_DEFAULTS，字符串项落空', () => {
    const got = getAgentSettings(bag(), 'story');
    expect(got.temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
    expect(got.topP).toBe(AGENT_SETTINGS_DEFAULTS.topP);
    expect(got.freqPen).toBe(AGENT_SETTINGS_DEFAULTS.freqPen);
    expect(got.presPen).toBe(AGENT_SETTINGS_DEFAULTS.presPen);
    expect(got.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
    expect(got.model).toBe('');
    expect(got.systemPrompt).toBe('');
    expect(got.worldBookEnabled).toBe(false);
    expect(got.worldBookIds).toEqual([]);
  });

  it('🔴 historyLayers / historySlice 不合默认 —— 缺省就是 undefined', () => {
    // 「键不存在」编码的是「按 agent 类别走引擎默认」，合并会把那条语义静默覆盖
    const got = getAgentSettings(bag(), 'story');
    expect(got.historyLayers).toBeUndefined();
    expect(got.historySlice).toBeUndefined();
  });

  it('读到的是袋子里那 13 张 map 的值', () => {
    const b: Record<string, any> = {
      agentModels: { story: 'ep_1' },
      agentTemperature: { story: 1.2 },
      agentHistoryLayers: { story: 3 },
    };
    const got = getAgentSettings(b, 'story');
    expect(got.model).toBe('ep_1');
    expect(got.temperature).toBe(1.2);
    expect(got.historyLayers).toBe(3);
    // 没配的仍走默认
    expect(got.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
  });

  it('worldBookIds 返回副本，改它不影响袋子', () => {
    const b: Record<string, any> = { agentWorldbookIds: { story: ['a'] } };
    getAgentSettings(b, 'story').worldBookIds.push('b');
    expect(b.agentWorldbookIds.story).toEqual(['a']);
  });

  it('每个 agentId 各自独立', () => {
    const b: Record<string, any> = { agentTemperature: { story: 1.5 } };
    expect(getAgentSettings(b, 'story').temperature).toBe(1.5);
    expect(getAgentSettings(b, 'vars_update').temperature).toBe(
      AGENT_SETTINGS_DEFAULTS.temperature,
    );
  });
});

describe('patchAgentSettings', () => {
  it('只改给到的字段，其余不动', () => {
    const b: Record<string, any> = { agentTemperature: { story: 1.5 } };
    patchAgentSettings(b, 'story', { maxTokens: 999 });
    expect(b.agentTemperature.story).toBe(1.5);
    expect(b.agentMaxTokens.story).toBe(999);
  });

  it('🔴 传 undefined = 删键，不是写入 undefined', () => {
    const b: Record<string, any> = { agentHistoryLayers: { story: 3 } };
    patchAgentSettings(b, 'story', { historyLayers: undefined });
    expect('story' in b.agentHistoryLayers).toBe(false);
    // 「键存在但值是 undefined」会让 `agentId in map` 成立，从而挡掉引擎默认 —— 那是 bug
  });

  it('目标 map 不存在时就地建出来', () => {
    const b = bag();
    patchAgentSettings(b, 'story', { model: 'ep_1' });
    expect(b.agentModels).toEqual({ story: 'ep_1' });
  });
});

describe('resetAgentSettings', () => {
  it('不传来源 = 恢复出厂，数值落默认、字符串清空', () => {
    const b: Record<string, any> = {
      agentModels: { story: 'ep_1' },
      agentTemperature: { story: 1.9 },
    };
    resetAgentSettings(b, 'story');
    const got = getAgentSettings(b, 'story');
    expect(got.model).toBe('');
    expect(got.temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
  });

  it('给来源时用来源的值，来源缺项落默认', () => {
    const b = bag();
    resetAgentSettings(b, 'story', { temperature: 0.1, model: 'ep_x' });
    const got = getAgentSettings(b, 'story');
    expect(got.temperature).toBe(0.1);
    expect(got.model).toBe('ep_x');
    expect(got.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
  });

  it('🔴 来源没给 historyLayers/historySlice → 删键（把「走引擎默认」还回去）', () => {
    const b: Record<string, any> = {
      agentHistoryLayers: { story: 3 },
      agentHistorySlice: { story: 200 },
    };
    resetAgentSettings(b, 'story', { temperature: 0.5 });
    expect('story' in b.agentHistoryLayers).toBe(false);
    expect('story' in b.agentHistorySlice).toBe(false);
  });

  it('来源给了 historyLayers 就写进去', () => {
    const b = bag();
    resetAgentSettings(b, 'story', { historyLayers: 5 });
    expect(getAgentSettings(b, 'story').historyLayers).toBe(5);
  });
});

describe('fillMissingAgentSettings', () => {
  it('只填空位，不覆盖用户已改过的项', () => {
    const b: Record<string, any> = { agentTemperature: { story: 1.9 } };
    fillMissingAgentSettings(b, 'story', { temperature: 0.3, maxTokens: 4096 });
    expect(b.agentTemperature.story).toBe(1.9); // 用户的值保住
    expect(b.agentMaxTokens.story).toBe(4096); // 空位被填
  });

  it('来源缺项时空位仍落默认（与旧逐行实现一致）', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { model: 'ep_1' });
    expect(getAgentSettings(b, 'story').temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
    expect(b.agentPrompts.story).toBe('');
  });

  it('template 只在来源真的给了才写（空串不写）', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { template: '' });
    expect(b.agentTemplates?.story).toBeUndefined();
    fillMissingAgentSettings(b, 'vars_update', { template: '{{X}}' });
    expect(b.agentTemplates.vars_update).toBe('{{X}}');
  });

  it('historyLayers/historySlice 来源没给就不写键', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { temperature: 0.5 });
    expect(b.agentHistoryLayers?.story).toBeUndefined();
    expect(getAgentSettings(b, 'story').historyLayers).toBeUndefined();
  });

  it('值为 0 的旋钮也算「已配置」，不会被来源顶掉', () => {
    const b: Record<string, any> = { agentHistoryLayers: { story: 0 } };
    fillMissingAgentSettings(b, 'story', { historyLayers: 4 });
    expect(b.agentHistoryLayers.story).toBe(0);
  });
});
