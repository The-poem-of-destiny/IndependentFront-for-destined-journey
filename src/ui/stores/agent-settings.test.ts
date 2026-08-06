/**
 * agent-settings 专项测试（Q-18）
 *
 * 三条真正会被下一次改动打破的性质：
 *   1. 数值默认只有一处 —— 断言读到的就是 `AGENT_SETTINGS_DEFAULTS`，不是复述的字面量
 *   2. `historyLayers` / `historySlice` **不合默认**，且「没给」= 删键
 *      —— 那条语义只写在注释里，一旦被「顺手补全」，引擎按 agent 类别给的默认会被静默盖掉
 *   3. `fillMissingAgentSettings` 只填空位、不覆盖用户已改的
 *
 * 形状：`bag.agents[agentId]` 一条（Q-18 合并后）。老用户那 12 张 map 怎么折进来
 * 是 `agent-settings-migration.test.ts` 的事，本文件只测合并**之后**的读写口。
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_SETTINGS_DEFAULTS,
  applyProjectDefaultToAgent,
  fillMissingAgentSettings,
  getAgentSettings,
  listConfiguredAgents,
  patchAgentSettings,
  resetAgentSettings,
  updateAgentWorldBookIds,
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

  it('读到的是袋子里那条 agents 记录的值', () => {
    const b: Record<string, any> = {
      agents: { story: { model: 'ep_1', temperature: 1.2, historyLayers: 3 } },
    };
    const got = getAgentSettings(b, 'story');
    expect(got.model).toBe('ep_1');
    expect(got.temperature).toBe(1.2);
    expect(got.historyLayers).toBe(3);
    // 没配的仍走默认
    expect(got.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
  });

  it('worldBookIds 返回副本，改它不影响袋子', () => {
    const b: Record<string, any> = { agents: { story: { worldBookIds: ['a'] } } };
    getAgentSettings(b, 'story').worldBookIds.push('b');
    expect(b.agents.story.worldBookIds).toEqual(['a']);
  });

  it('每个 agentId 各自独立', () => {
    const b: Record<string, any> = { agents: { story: { temperature: 1.5 } } };
    expect(getAgentSettings(b, 'story').temperature).toBe(1.5);
    expect(getAgentSettings(b, 'vars_update').temperature).toBe(
      AGENT_SETTINGS_DEFAULTS.temperature,
    );
  });
});

describe('patchAgentSettings', () => {
  it('只改给到的字段，其余不动', () => {
    const b: Record<string, any> = { agents: { story: { temperature: 1.5 } } };
    patchAgentSettings(b, 'story', { maxTokens: 999 });
    expect(b.agents.story.temperature).toBe(1.5);
    expect(b.agents.story.maxTokens).toBe(999);
  });

  it('🔴 传 undefined = 删键，不是写入 undefined', () => {
    const b: Record<string, any> = { agents: { story: { historyLayers: 3 } } };
    patchAgentSettings(b, 'story', { historyLayers: undefined });
    expect('historyLayers' in b.agents.story).toBe(false);
    // 「键存在但值是 undefined」会让 `field in entry` 成立，从而挡掉引擎默认 —— 那是 bug
  });

  it('agents / 条目都不存在时就地建出来', () => {
    const b = bag();
    patchAgentSettings(b, 'story', { model: 'ep_1' });
    expect(b.agents).toEqual({ story: { model: 'ep_1' } });
  });

  it('🔴 只读不建结构 —— 读一个从没配过的 agent 不该在袋子里留下空壳', () => {
    const b = bag();
    getAgentSettings(b, 'story');
    expect(b.agents).toBeUndefined();
  });
});

describe('resetAgentSettings', () => {
  it('不传来源 = 恢复出厂，数值落默认、字符串清空', () => {
    const b: Record<string, any> = { agents: { story: { model: 'ep_1', temperature: 1.9 } } };
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
    const b: Record<string, any> = { agents: { story: { historyLayers: 3, historySlice: 200 } } };
    resetAgentSettings(b, 'story', { temperature: 0.5 });
    expect('historyLayers' in b.agents.story).toBe(false);
    expect('historySlice' in b.agents.story).toBe(false);
  });

  it('来源给了 historyLayers 就写进去', () => {
    const b = bag();
    resetAgentSettings(b, 'story', { historyLayers: 5 });
    expect(getAgentSettings(b, 'story').historyLayers).toBe(5);
  });
});

describe('updateAgentWorldBookIds', () => {
  it('投影出所有 agent 的清单交给变换，再写回条目', () => {
    const b: Record<string, any> = {
      agents: {
        story: { worldBookIds: ['a'], temperature: 1.5 },
        char_gen: { worldBookIds: [] },
      },
    };
    updateAgentWorldBookIds(b, (current) => {
      expect(current).toEqual({ story: ['a'], char_gen: [] });
      return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, [...v, 'ws_1']]));
    });
    expect(b.agents.story.worldBookIds).toEqual(['a', 'ws_1']);
    expect(b.agents.char_gen.worldBookIds).toEqual(['ws_1']);
    // 🔴 只动 worldBookIds，其余字段一个不碰
    expect(b.agents.story.temperature).toBe(1.5);
  });

  it('没有 worldBookIds 的条目投影成空数组（工坊纯函数不必判空）', () => {
    const b: Record<string, any> = { agents: { story: { model: 'ep' } } };
    updateAgentWorldBookIds(b, (current) => {
      expect(current).toEqual({ story: [] });
      return current;
    });
  });

  it('一个 agent 都没配过 → 变换收到空对象，不建结构', () => {
    const b: Record<string, any> = {};
    updateAgentWorldBookIds(b, (current) => {
      expect(current).toEqual({});
      return current;
    });
    expect(b.agents).toBeUndefined();
  });
});

describe('listConfiguredAgents', () => {
  it('列出已有条目的 agentId；袋子为空时是空数组', () => {
    expect(listConfiguredAgents({})).toEqual([]);
    expect(listConfiguredAgents({ agents: { a: {}, b: {} } })).toEqual(['a', 'b']);
  });
});

describe('fillMissingAgentSettings', () => {
  it('只填空位，不覆盖用户已改过的项', () => {
    const b: Record<string, any> = { agents: { story: { temperature: 1.9 } } };
    fillMissingAgentSettings(b, 'story', { temperature: 0.3, maxTokens: 4096 });
    expect(b.agents.story.temperature).toBe(1.9); // 用户的值保住
    expect(b.agents.story.maxTokens).toBe(4096); // 空位被填
  });

  it('来源缺项时空位仍落默认（与旧逐行实现一致）', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { model: 'ep_1' });
    expect(getAgentSettings(b, 'story').temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
    expect(b.agents.story.systemPrompt).toBe('');
  });

  it('template 只在来源真的给了才写（空串不写）', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { template: '' });
    expect('template' in b.agents.story).toBe(false);
    fillMissingAgentSettings(b, 'vars_update', { template: '{{X}}' });
    expect(b.agents.vars_update.template).toBe('{{X}}');
  });

  it('historyLayers/historySlice 来源没给就不写键', () => {
    const b = bag();
    fillMissingAgentSettings(b, 'story', { temperature: 0.5 });
    expect('historyLayers' in b.agents.story).toBe(false);
    expect(getAgentSettings(b, 'story').historyLayers).toBeUndefined();
  });

  it('值为 0 的旋钮也算「已配置」，不会被来源顶掉', () => {
    const b: Record<string, any> = { agents: { story: { historyLayers: 0 } } };
    fillMissingAgentSettings(b, 'story', { historyLayers: 4 });
    expect(b.agents.story.historyLayers).toBe(0);
  });
});

describe('applyProjectDefaultToAgent', () => {
  it('🔴 model 保留不动（用户自己选的 API 与模型不该被默认值覆盖）', () => {
    const b: Record<string, any> = { agents: { char_gen: { model: 'deepseek-chat' } } };
    applyProjectDefaultToAgent(b, 'char_gen', { systemPrompt: '新版', model: 'ignored-model' });
    expect(getAgentSettings(b, 'char_gen').model).toBe('deepseek-chat');
  });

  it('拉提示词/模板/世界书/旋钮到来源的值', () => {
    const b: Record<string, any> = { agents: { char_gen: { model: 'm', systemPrompt: '旧' } } };
    applyProjectDefaultToAgent(b, 'char_gen', {
      systemPrompt: '新版',
      template: '{{X}}',
      worldBookEnabled: true,
      worldBookIds: ['wb1'],
      temperature: 0.3,
      maxTokens: 8192,
    });
    const got = getAgentSettings(b, 'char_gen');
    expect(got.systemPrompt).toBe('新版');
    expect(got.template).toBe('{{X}}');
    expect(got.worldBookEnabled).toBe(true);
    expect(got.worldBookIds).toEqual(['wb1']);
    expect(got.temperature).toBe(0.3);
    expect(got.maxTokens).toBe(8192);
  });

  it('🔴 template 空串 → 删键（不是写空串），把「走引擎默认」语义还回去', () => {
    const b: Record<string, any> = {
      agents: { char_gen: { model: 'm', template: '{{旧}}' } },
    };
    applyProjectDefaultToAgent(b, 'char_gen', { template: '' });
    expect('template' in b.agents.char_gen).toBe(false);
  });

  it('historyLayers/historySlice 来源没给就删键', () => {
    const b: Record<string, any> = {
      agents: { char_gen: { model: 'm', historyLayers: 3, historySlice: 500 } },
    };
    applyProjectDefaultToAgent(b, 'char_gen', { systemPrompt: 'x' });
    expect('historyLayers' in b.agents.char_gen).toBe(false);
    expect('historySlice' in b.agents.char_gen).toBe(false);
  });

  it('来源缺项时旋钮落 AGENT_SETTINGS_DEFAULTS（与其它路径同源）', () => {
    const b: Record<string, any> = { agents: { char_gen: { model: 'm' } } };
    applyProjectDefaultToAgent(b, 'char_gen', {});
    const got = getAgentSettings(b, 'char_gen');
    expect(got.temperature).toBe(AGENT_SETTINGS_DEFAULTS.temperature);
    expect(got.maxTokens).toBe(AGENT_SETTINGS_DEFAULTS.maxTokens);
  });
});
