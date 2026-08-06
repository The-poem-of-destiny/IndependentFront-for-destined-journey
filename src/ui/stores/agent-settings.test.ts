/**
 * agent-settings 专项测试（Q-18；内容-引擎分离波 1 / D44 v1.2 大修）
 *
 * 四组性质（每组都对应一条 D44 修正）：
 *   1. **修正 1：resolve 覆盖全部 12 键**（getAgentSettings 合默认层）—— 覆写 ?? 默认 ?? 兜底
 *   2. **修正 2：名册迭代改源** —— listConfiguredAgents/updateAgentWorldBookIds 用解析名册
 *   3. **修正 3：指纹迁移** —— migrateLegacyAgentOverrides 命中删除、未命中保留
 *   4. **修正 4：覆写制造面** —— resetAgentSettings/applyProjectDefaultToAgent 清覆写层
 *
 * 形状：`bag.agents[agentId]` 一条（Q-18 合并后）。老用户那 12 张 map 怎么折进来
 * 是 `agent-settings-migration.test.ts` 的事，本文件只测合并**之后**的读写口。
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_SETTINGS_DEFAULTS,
  applyProjectDefaultToAgent,
  getAgentSettings,
  listConfiguredAgents,
  migrateLegacyAgentOverrides,
  patchAgentSettings,
  resetAgentSettings,
  updateAgentWorldBookIds,
  type AgentDefaultsLayer,
} from './agent-settings';
// 真实 agent-config.json —— 指纹迁移测试要拿它的字段值造「命中指纹」的覆写
import realAgentConfig from '../../../data/defaults/agent-config.json';

const bag = (): Record<string, any> => ({});

// ═══════════════════════════════════════════════════════════════
// 修正 1：resolve 覆盖全部 12 键（getAgentSettings 合默认层）
// ═══════════════════════════════════════════════════════════════

describe('getAgentSettings —— 修正 1（合默认层）', () => {
  it('🔴 空覆写层 + 空默认层 → 数值项落 AGENT_SETTINGS_DEFAULTS，字符串项落空', () => {
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

  it('🔴 空覆写层 + 默认层 → 全部 12 键走默认层', () => {
    const layer: AgentDefaultsLayer = {
      story: {
        model: 'ep-default',
        worldBookEnabled: true,
        worldBookIds: ['world_setting', 'character'],
        systemPrompt: '默认提示词',
        template: '默认模板',
        temperature: 0.4,
        topP: 0.9,
        freqPen: 0.1,
        presPen: 0.2,
        maxTokens: 8192,
        historyLayers: 6,
        historySlice: 1500,
      },
    };
    const got = getAgentSettings(bag(), 'story', layer);
    expect(got.model).toBe('ep-default');
    expect(got.worldBookEnabled).toBe(true);
    expect(got.worldBookIds).toEqual(['world_setting', 'character']);
    expect(got.systemPrompt).toBe('默认提示词');
    expect(got.template).toBe('默认模板');
    expect(got.temperature).toBe(0.4);
    expect(got.topP).toBe(0.9);
    expect(got.freqPen).toBe(0.1);
    expect(got.presPen).toBe(0.2);
    expect(got.maxTokens).toBe(8192);
    expect(got.historyLayers).toBe(6);
    expect(got.historySlice).toBe(1500);
  });

  it('🔴 覆写层优先于默认层（覆写 ?? 默认）', () => {
    const b: Record<string, any> = { agents: { story: { temperature: 1.2, model: 'ep-user' } } };
    const layer: AgentDefaultsLayer = {
      story: { temperature: 0.4, model: 'ep-default', systemPrompt: '默认' },
    };
    const got = getAgentSettings(b, 'story', layer);
    expect(got.temperature).toBe(1.2); // 覆写赢
    expect(got.model).toBe('ep-user'); // 覆写赢
    expect(got.systemPrompt).toBe('默认'); // 覆写层没给 → 默认层
  });

  it('🔴 看门人：空覆写层 + 默认层 → story worldBookIds 非空（D44 修正 1 管线测试）', () => {
    // 删 boot 播种后世界书唯一来源就是默认层 —— 不给默认层 = 全体 agent 静默失去世界书
    const layer: AgentDefaultsLayer = {
      story: { worldBookEnabled: true, worldBookIds: ['fated_core', 'character'] },
    };
    const got = getAgentSettings(bag(), 'story', layer);
    expect(got.worldBookEnabled).toBe(true);
    expect(got.worldBookIds).toEqual(['fated_core', 'character']);
  });

  it('🔴 historyLayers / historySlice 两层都没给 → undefined（不合默认）', () => {
    const got = getAgentSettings(bag(), 'story', { story: { temperature: 0.5 } });
    expect(got.historyLayers).toBeUndefined();
    expect(got.historySlice).toBeUndefined();
  });

  it('historyLayers/historySlice 覆写层有键就赢（哪怕默认层给了别的）', () => {
    const b: Record<string, any> = { agents: { story: { historyLayers: 2 } } };
    const layer: AgentDefaultsLayer = { story: { historyLayers: 6 } };
    expect(getAgentSettings(b, 'story', layer).historyLayers).toBe(2);
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

  it('默认层只读 agent-config.json 给的字段（historyLayers 缺席 = undefined）', () => {
    const layer: AgentDefaultsLayer = {
      story: { temperature: 0.5, systemPrompt: 'x' }, // 没给 historyLayers
    };
    const got = getAgentSettings(bag(), 'story', layer);
    expect(got.temperature).toBe(0.5);
    expect(got.systemPrompt).toBe('x');
    expect(got.historyLayers).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// patchAgentSettings（基本写入语义）
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 修正 4：resetAgentSettings / applyProjectDefaultToAgent（清覆写层）
// ═══════════════════════════════════════════════════════════════

describe('resetAgentSettings —— 修正 4（清覆写层）', () => {
  it('清掉该 agent 的整条覆写，袋子回退到没该条目的状态', () => {
    const b: Record<string, any> = {
      agents: { story: { model: 'ep_1', temperature: 1.9 }, char_gen: { model: 'ep_2' } },
    };
    resetAgentSettings(b, 'story');
    expect('story' in b.agents).toBe(false);
    expect('char_gen' in b.agents).toBe(true); // 别的 agent 不动
  });

  it('清掉后解析值走默认层（getAgentSettings 合默认层）', () => {
    const b: Record<string, any> = { agents: { story: { temperature: 1.9 } } };
    const layer: AgentDefaultsLayer = { story: { temperature: 0.5, systemPrompt: '默认' } };
    resetAgentSettings(b, 'story');
    const got = getAgentSettings(b, 'story', layer);
    expect(got.temperature).toBe(0.5); // 默认层接管
    expect(got.systemPrompt).toBe('默认');
  });

  it('袋子没该 agent 也不炸（幂等）', () => {
    const b = bag();
    resetAgentSettings(b, 'story');
    expect(b.agents).toBeUndefined();
  });

  it('袋子没 agents 对象也不炸', () => {
    const b = bag();
    resetAgentSettings(b, 'story');
    expect(b.agents).toBeUndefined();
  });
});

describe('applyProjectDefaultToAgent —— 修正 4（清覆写层，保留 model）', () => {
  it('🔴 清掉除 model 外的全部覆写字段（model = 用户选的 API 池，不该被默认值覆盖）', () => {
    const b: Record<string, any> = {
      agents: {
        char_gen: {
          model: 'deepseek-chat',
          systemPrompt: '用户改的提示词',
          temperature: 1.5,
          worldBookEnabled: true,
          worldBookIds: ['wb1'],
          historyLayers: 3,
        },
      },
    };
    applyProjectDefaultToAgent(b, 'char_gen');
    // model 留着
    expect(b.agents.char_gen.model).toBe('deepseek-chat');
    // 其余字段清光
    expect('systemPrompt' in b.agents.char_gen).toBe(false);
    expect('temperature' in b.agents.char_gen).toBe(false);
    expect('worldBookEnabled' in b.agents.char_gen).toBe(false);
    expect('worldBookIds' in b.agents.char_gen).toBe(false);
    expect('historyLayers' in b.agents.char_gen).toBe(false);
  });

  it('清掉后解析值回默认层（pack > 占位）', () => {
    const b: Record<string, any> = {
      agents: { char_gen: { model: 'm', systemPrompt: '旧版', temperature: 1.9 } },
    };
    const layer: AgentDefaultsLayer = {
      char_gen: { systemPrompt: '新版默认', temperature: 0.4 },
    };
    applyProjectDefaultToAgent(b, 'char_gen');
    const got = getAgentSettings(b, 'char_gen', layer);
    expect(got.systemPrompt).toBe('新版默认'); // 默认层接管
    expect(got.temperature).toBe(0.4);
    expect(got.model).toBe('m'); // model 保留
  });

  it('覆写层没 model 时整条删掉', () => {
    const b: Record<string, any> = {
      agents: { char_gen: { systemPrompt: 'x', temperature: 1.5 } },
    };
    applyProjectDefaultToAgent(b, 'char_gen');
    expect('char_gen' in b.agents).toBe(false); // 没 model 可留 → 整条删
  });

  it('覆写层本就没有该 agent 时不炸（已走默认层）', () => {
    const b: Record<string, any> = { agents: { story: { model: 'm' } } };
    applyProjectDefaultToAgent(b, 'char_gen'); // char_gen 不在覆写层
    expect('char_gen' in b.agents).toBe(false);
  });

  it('覆写层本就空（bag.agents 不存在）不炸', () => {
    const b = bag();
    applyProjectDefaultToAgent(b, 'char_gen');
    expect(b.agents).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 修正 2：名册迭代改源（listConfiguredAgents / updateAgentWorldBookIds）
// ═══════════════════════════════════════════════════════════════

describe('listConfiguredAgents —— 修正 2（解析名册）', () => {
  it('不传默认层：只列覆写层键（向后兼容）', () => {
    expect(listConfiguredAgents({})).toEqual([]);
    expect(listConfiguredAgents({ agents: { a: {}, b: {} } })).toEqual(['a', 'b']);
  });

  it('🔴 传默认层：默认层键 ∪ 覆写层键（解析名册）', () => {
    const layer: AgentDefaultsLayer = { story: {}, char_gen: {}, item_gen: {} };
    const b: Record<string, any> = { agents: { story: {}, vars_update: {} } };
    const roster = listConfiguredAgents(b, layer);
    expect(roster.sort()).toEqual(['char_gen', 'item_gen', 'story', 'vars_update']);
  });

  it('🔴 覆写层为空 + 默认层非空 → 解析名册含全部默认层键', () => {
    // 这正是工坊装书「授权给零个 agent」bug 的看门人：覆写层空时仍要能列出全名册
    const layer: AgentDefaultsLayer = {
      story: {},
      char_gen: {},
      item_gen: {},
      memory_recall: {},
    };
    expect(listConfiguredAgents(bag(), layer).sort()).toEqual([
      'char_gen',
      'item_gen',
      'memory_recall',
      'story',
    ]);
  });
});

describe('updateAgentWorldBookIds —— 修正 2（解析名册投影）', () => {
  it('投影出覆写层 agent 的清单交给变换，再写回条目', () => {
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

  it('🔴 传默认层：覆写层空的 agent 也进投影（工坊 grant 达全名册的看门人）', () => {
    const layer: AgentDefaultsLayer = {
      story: { worldBookIds: ['world_setting'] },
      char_gen: { worldBookIds: ['world_setting'] },
      item_gen: { worldBookIds: [] },
    };
    const b: Record<string, any> = {}; // 覆写层完全空
    let seen: Record<string, string[]> = {};
    updateAgentWorldBookIds(
      b,
      (current) => {
        seen = current;
        // grant ws_1 给全部
        return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, [...v, 'ws_1']]));
      },
      layer,
    );
    // 三个 agent 全进投影（含覆写层没的 item_gen）
    expect(Object.keys(seen).sort()).toEqual(['char_gen', 'item_gen', 'story']);
    expect(seen.story).toEqual(['world_setting']); // 默认层给的清单
    expect(seen.item_gen).toEqual([]); // 默认层空
    // grant 写回：全部 agent 都拿到 ws_1
    expect(b.agents.story.worldBookIds).toEqual(['world_setting', 'ws_1']);
    expect(b.agents.char_gen.worldBookIds).toEqual(['world_setting', 'ws_1']);
    expect(b.agents.item_gen.worldBookIds).toEqual(['ws_1']);
  });

  it('没有 worldBookIds 的覆写条目投影成空数组', () => {
    const b: Record<string, any> = { agents: { story: { model: 'ep' } } };
    updateAgentWorldBookIds(b, (current) => {
      expect(current).toEqual({ story: [] });
      return current;
    });
  });

  it('不传默认层 + 一个 agent 都没配过 → 变换收到空对象，不建结构', () => {
    const b: Record<string, any> = {};
    updateAgentWorldBookIds(b, (current) => {
      expect(current).toEqual({});
      return current;
    });
    expect(b.agents).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 修正 3：指纹迁移（migrateLegacyAgentOverrides）
// ═══════════════════════════════════════════════════════════════

describe('migrateLegacyAgentOverrides —— 修正 3（指纹迁移）', () => {
  // 用真实指纹表（从 data/defaults/agent-config.json 生成）做断言。
  // 它是 import 进来的常量，覆盖当前 agent-config.json 的 12 键全部字段值。

  it('🔴 命中历史默认指纹的覆写键删除（旧 boot 播种值被清）', () => {
    // 用真实 agent-config.json 里 story 的完整一条作为覆写 —— 每个字段都命中指纹
    const realStory = (realAgentConfig as any).agents.story;
    // 只取 12 键（剥掉 presetId/preset）
    const twelveKeys = [
      'model',
      'worldBookEnabled',
      'worldBookIds',
      'systemPrompt',
      'template',
      'temperature',
      'topP',
      'freqPen',
      'presPen',
      'maxTokens',
      'historyLayers',
      'historySlice',
    ] as const;
    const overrideEntry: Record<string, unknown> = {};
    for (const k of twelveKeys) overrideEntry[k] = realStory[k];
    const b: Record<string, any> = { agents: { story: { ...overrideEntry } } };

    const cleared = migrateLegacyAgentOverrides(b);
    // 全部 12 键命中指纹 → 全清 → 整条删
    expect(cleared.story.sort()).toEqual([...twelveKeys].sort());
    expect('story' in b.agents).toBe(false); // 整条空了就删
  });

  it('🔴 用户真正改过的值指纹不匹配 → 保留', () => {
    const realStory = (realAgentConfig as any).agents.story;
    const b: Record<string, any> = {
      agents: {
        story: {
          // systemPrompt 改过（≠ 默认）→ 不匹配 → 保留
          systemPrompt: '用户自定义的提示词，与默认不同',
          // temperature 没改（= 默认）→ 匹配 → 清
          temperature: realStory.temperature,
        },
      },
    };
    const cleared = migrateLegacyAgentOverrides(b);
    expect(cleared.story).toEqual(['temperature']); // 只清了 temperature
    expect(b.agents.story.systemPrompt).toBe('用户自定义的提示词，与默认不同'); // 保留
    expect('temperature' in b.agents.story).toBe(false); // 清了
  });

  it('覆写层有 agent-config.json 没有的 agent → 不动（没指纹可比）', () => {
    const b: Record<string, any> = {
      agents: { some_unknown_agent: { systemPrompt: 'x', temperature: 0.7 } },
    };
    const cleared = migrateLegacyAgentOverrides(b);
    expect(cleared).toEqual({}); // 没指纹可比 → 不清
    expect(b.agents.some_unknown_agent).toEqual({ systemPrompt: 'x', temperature: 0.7 });
  });

  it('覆写层的字段在指纹表里没有（agent-config.json 没该字段）→ 保留', () => {
    const b: Record<string, any> = {
      agents: { story: { someRandomExtraField: 'x' } },
    };
    const cleared = migrateLegacyAgentOverrides(b);
    expect(cleared).toEqual({}); // someRandomExtraField 不在指纹表 → 不清
    expect(b.agents.story.someRandomExtraField).toBe('x');
  });

  it('覆写层为空（bag.agents 不存在）→ 返回空、不炸', () => {
    const b = bag();
    expect(migrateLegacyAgentOverrides(b)).toEqual({});
  });

  it('迁移幂等：跑两次第二次无命中（已清光）', () => {
    const realCharGen = (realAgentConfig as any).agents.char_gen;
    const b: Record<string, any> = {
      agents: {
        char_gen: { temperature: realCharGen.temperature, maxTokens: realCharGen.maxTokens },
      },
    };
    const first = migrateLegacyAgentOverrides(b);
    expect(first.char_gen.sort()).toEqual(['maxTokens', 'temperature']);
    const second = migrateLegacyAgentOverrides(b);
    expect(second).toEqual({}); // 第二次无命中
  });

  it('迁移后只剩 model 的条目保留 model（不删整条）', () => {
    const realItemGen = (realAgentConfig as any).agents.item_gen;
    const b: Record<string, any> = {
      agents: {
        item_gen: {
          model: 'user-picked-pool', // 用户自己选的（≠ 默认）→ 不匹配 → 保留
          temperature: realItemGen.temperature, // = 默认 → 匹配 → 清
        },
      },
    };
    migrateLegacyAgentOverrides(b);
    expect(b.agents.item_gen).toEqual({ model: 'user-picked-pool' }); // 只剩 model
  });
});
