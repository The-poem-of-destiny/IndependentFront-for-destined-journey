/**
 * agent-settings 专项测试（Q-18；内容-引擎分离波 1 / D44 v1.2 大修）
 *
 * 四组性质（每组都对应一条 D44 修正）：
 *   1. **修正 1：resolve 覆盖全部 12 键**（getAgentSettings 合默认层）—— 覆写 ?? 默认 ?? 兜底
 *   2. **修正 2：名册迭代改源** —— listConfiguredAgents 用解析名册
 *      （世界书两键已退役：retireAgentWorldBookOverrides / legacyStashBookAudiences）
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
  fingerprintValue,
  getAgentSettings,
  hasExplicitAgentModel,
  listConfiguredAgents,
  migrateLegacyAgentOverrides,
  patchAgentSettings,
  resetAgentSettings,
  resolveAgentLlmParams,
  retireAgentWorldBookOverrides,
  legacyStashBookAudiences,
  LEGACY_AGENT_WORLDBOOK_STASH_KEY,
  type AgentDefaultsLayer,
} from '../../../src/ui/stores/agent-settings';

const bag = (): Record<string, any> => ({});

// ═══ 指纹迁移测试的自造指纹表 ═══
// 内容-引擎分离波 4 / D14：真实 agent-config 已迁私有仓，公开侧不再有真实默认值。
// 指纹迁移的**逻辑**（命中删除 / 未命中保留 / 幂等）不依赖特定内容——测试用自造
// 指纹表 + 同源字段值验证，口径与生产一致（sha256(JSON.stringify(value))）。
function fpOf(value: unknown): string {
  // 与生产 migrateLegacyAgentOverrides 同口径（sha256(JSON.stringify(value))）
  return fingerprintValue(value);
}

const TEST_DEFAULTS = {
  story: {
    model: 'ep-default-story',
    worldBookEnabled: true,
    worldBookIds: ['world_setting'],
    systemPrompt: '默认提示词 story',
    template: '默认模板',
    temperature: 0.7,
    topP: 1.0,
    freqPen: 0,
    presPen: 0,
    maxTokens: 16384,
    historyLayers: 3,
    historySlice: 800,
  },
  char_gen: {
    temperature: 1.0,
    maxTokens: 4096,
  },
  item_gen: {
    temperature: 0.5,
  },
};

const TEST_FINGERPRINTS: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(TEST_DEFAULTS).map(([agentId, fields]) => [
    agentId,
    Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, fpOf(value)])),
  ]),
);

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
  });

  it('🔴 空覆写层 + 默认层 → 全部 12 键走默认层', () => {
    const layer: AgentDefaultsLayer = {
      story: {
        model: 'ep-default',
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

  it('🔴 世界书两键已退役：覆写层或旧默认层里残留也不出现在解析结果里', () => {
    // 读取范围只来自内容声明（lore.audiences），Agent 设置不再携带世界书清单
    const b: Record<string, any> = {
      agents: { story: { worldBookEnabled: true, worldBookIds: ['a'] } },
    };
    const layer = {
      story: { worldBookEnabled: true, worldBookIds: ['fated_core'] },
    } as unknown as AgentDefaultsLayer;
    const got = getAgentSettings(b, 'story', layer);
    expect(got).not.toHaveProperty('worldBookEnabled');
    expect(got).not.toHaveProperty('worldBookIds');
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

  it('🆕 T4：tailPrompt 两层都没给 → undefined（不注入，与 historyLayers 同纪律）', () => {
    const got = getAgentSettings(bag(), 'story');
    expect(got.tailPrompt).toBeUndefined();
  });

  it('🆕 T4：tailPrompt 覆写层有非空值就赢（哪怕默认层给了别的）', () => {
    const b: Record<string, any> = { agents: { story: { tailPrompt: '请用简体中文作答' } } };
    const layer: AgentDefaultsLayer = { story: { tailPrompt: '默认尾注' } };
    expect(getAgentSettings(b, 'story', layer).tailPrompt).toBe('请用简体中文作答');
  });

  it('🆕 T4：tailPrompt 覆写层没给 → 落默认层', () => {
    const layer: AgentDefaultsLayer = { story: { tailPrompt: '默认尾注' } };
    expect(getAgentSettings(bag(), 'story', layer).tailPrompt).toBe('默认尾注');
  });

  it('🆕 T4：tailPrompt 空白（全空白串）归一化为 undefined —— 覆写层给空白 = 未配置', () => {
    const b: Record<string, any> = { agents: { story: { tailPrompt: '   \n\t ' } } };
    expect(getAgentSettings(b, 'story').tailPrompt).toBeUndefined();
  });

  it('🆕 T4：tailPrompt 默认层给空白同样归一化为 undefined（不产 tail 区块）', () => {
    const layer: AgentDefaultsLayer = { story: { tailPrompt: '   ' } };
    expect(getAgentSettings(bag(), 'story', layer).tailPrompt).toBeUndefined();
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

// ═══════════════════════════════════════════════════════════════
// Agent 世界书配置退役（内容计划 §7.2）
// ═══════════════════════════════════════════════════════════════

describe('retireAgentWorldBookOverrides —— 覆写层世界书两键移入暂存', () => {
  it('🔴 两键搬进暂存，其余字段一个不碰', () => {
    const b: Record<string, any> = {
      agents: {
        story: { worldBookEnabled: true, worldBookIds: ['my_book'], temperature: 1.5 },
      },
    };
    const retired = retireAgentWorldBookOverrides(b);
    expect(retired).toEqual(['story']);
    expect(b.agents.story).toEqual({ temperature: 1.5 });
    expect(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]).toEqual({
      story: { worldBookEnabled: true, worldBookIds: ['my_book'] },
    });
  });

  it('搬空的覆写条目整条删除（不留空壳）', () => {
    const b: Record<string, any> = {
      agents: {
        char_gen: { worldBookEnabled: false, worldBookIds: [] },
        item_gen: { model: 'pool-x' },
      },
    };
    expect(retireAgentWorldBookOverrides(b)).toEqual(['char_gen']);
    expect('char_gen' in b.agents).toBe(false);
    expect(b.agents.item_gen).toEqual({ model: 'pool-x' });
    expect(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]).toEqual({
      char_gen: { worldBookEnabled: false, worldBookIds: [] },
    });
  });

  it('只有一键时只搬那一键；非字符串 id 被滤掉', () => {
    const b: Record<string, any> = {
      agents: { story: { worldBookIds: ['a', 42, 'b'] }, vars_update: { worldBookEnabled: true } },
    };
    retireAgentWorldBookOverrides(b);
    expect(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]).toEqual({
      story: { worldBookIds: ['a', 'b'] },
      vars_update: { worldBookEnabled: true },
    });
  });

  it('幂等：第二次运行无可移项，暂存不变', () => {
    const b: Record<string, any> = {
      agents: { story: { worldBookEnabled: true, worldBookIds: ['a'], model: 'ep' } },
    };
    retireAgentWorldBookOverrides(b);
    const stashAfterFirst = structuredClone(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]);
    expect(retireAgentWorldBookOverrides(b)).toEqual([]);
    expect(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]).toEqual(stashAfterFirst);
    expect(b.agents.story).toEqual({ model: 'ep' });
  });

  it('并入已有暂存：别的 Agent 保留，同一 Agent 按键覆盖', () => {
    const b: Record<string, any> = {
      [LEGACY_AGENT_WORLDBOOK_STASH_KEY]: {
        char_gen: { worldBookEnabled: true, worldBookIds: ['old'] },
        story: { worldBookEnabled: true, worldBookIds: ['old_story'] },
      },
      agents: { story: { worldBookIds: ['new_story'] } },
    };
    expect(retireAgentWorldBookOverrides(b)).toEqual(['story']);
    expect(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY]).toEqual({
      char_gen: { worldBookEnabled: true, worldBookIds: ['old'] },
      story: { worldBookEnabled: true, worldBookIds: ['new_story'] },
    });
  });

  it('没有覆写层 / 覆写层里没有两键 → 返回空、不建暂存', () => {
    const empty = bag();
    expect(retireAgentWorldBookOverrides(empty)).toEqual([]);
    expect(LEGACY_AGENT_WORLDBOOK_STASH_KEY in empty).toBe(false);

    const b: Record<string, any> = { agents: { story: { temperature: 0.3 } } };
    expect(retireAgentWorldBookOverrides(b)).toEqual([]);
    expect(LEGACY_AGENT_WORLDBOOK_STASH_KEY in b).toBe(false);
    expect(b.agents.story).toEqual({ temperature: 0.3 });
  });
});

describe('legacyStashBookAudiences —— 暂存 → 书级读取范围', () => {
  it('按书收拢 Agent，去重', () => {
    expect(
      legacyStashBookAudiences({
        story: { worldBookEnabled: true, worldBookIds: ['a', 'b', 'a'] },
        char_gen: { worldBookEnabled: true, worldBookIds: ['b'] },
      }),
    ).toEqual({ a: ['story'], b: ['story', 'char_gen'] });
  });

  it('🔴 跳过当年关着世界书开关的 Agent（他们本来就读不到）', () => {
    expect(
      legacyStashBookAudiences({
        story: { worldBookEnabled: false, worldBookIds: ['a'] },
        char_gen: { worldBookEnabled: true, worldBookIds: ['a'] },
      }),
    ).toEqual({ a: ['char_gen'] });
  });

  it('开关缺席（只暂存了清单）按开着算', () => {
    expect(legacyStashBookAudiences({ story: { worldBookIds: ['a'] } })).toEqual({
      a: ['story'],
    });
  });

  it('undefined / 空暂存 → 空映射', () => {
    expect(legacyStashBookAudiences(undefined)).toEqual({});
    expect(legacyStashBookAudiences({})).toEqual({});
  });

  it('与 retireAgentWorldBookOverrides 串起来用', () => {
    const b: Record<string, any> = {
      agents: {
        story: { worldBookEnabled: true, worldBookIds: ['my_book'] },
        vars_update: { worldBookEnabled: false, worldBookIds: ['my_book'] },
      },
    };
    retireAgentWorldBookOverrides(b);
    expect(legacyStashBookAudiences(b[LEGACY_AGENT_WORLDBOOK_STASH_KEY])).toEqual({
      my_book: ['story'],
    });
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
    const realStory = TEST_DEFAULTS.story;
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

    const cleared = migrateLegacyAgentOverrides(b, TEST_FINGERPRINTS);
    // 全部 12 键命中指纹 → 全清 → 整条删
    expect(cleared.story.sort()).toEqual([...twelveKeys].sort());
    expect('story' in b.agents).toBe(false); // 整条空了就删
  });

  it('🔴 用户真正改过的值指纹不匹配 → 保留', () => {
    const realStory = TEST_DEFAULTS.story;
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
    const cleared = migrateLegacyAgentOverrides(b, TEST_FINGERPRINTS);
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
    const realCharGen = TEST_DEFAULTS.char_gen;
    const b: Record<string, any> = {
      agents: {
        char_gen: { temperature: realCharGen.temperature, maxTokens: realCharGen.maxTokens },
      },
    };
    const first = migrateLegacyAgentOverrides(b, TEST_FINGERPRINTS);
    expect(first.char_gen.sort()).toEqual(['maxTokens', 'temperature']);
    const second = migrateLegacyAgentOverrides(b, TEST_FINGERPRINTS);
    expect(second).toEqual({}); // 第二次无命中
  });

  it('迁移后只剩 model 的条目保留 model（不删整条）', () => {
    const realItemGen = TEST_DEFAULTS.item_gen;
    const b: Record<string, any> = {
      agents: {
        item_gen: {
          model: 'user-picked-pool', // 用户自己选的（≠ 默认）→ 不匹配 → 保留
          temperature: realItemGen.temperature, // = 默认 → 匹配 → 清
        },
      },
    };
    migrateLegacyAgentOverrides(b, TEST_FINGERPRINTS);
    expect(b.agents.item_gen).toEqual({ model: 'user-picked-pool' }); // 只剩 model
  });
});

describe('hasExplicitAgentModel — 悬空绑定的来源判定', () => {
  it('覆写层有非空 model → true', () => {
    expect(hasExplicitAgentModel({ agents: { item_gen: { model: 'pool-x' } } }, 'item_gen')).toBe(
      true,
    );
  });

  it('覆写层无 model / 空串 / 只有默认层 → false', () => {
    expect(hasExplicitAgentModel(bag(), 'item_gen')).toBe(false);
    expect(hasExplicitAgentModel({ agents: { item_gen: { model: '' } } }, 'item_gen')).toBe(false);
    expect(hasExplicitAgentModel({ agents: { item_gen: { model: '   ' } } }, 'item_gen')).toBe(
      false,
    );
    expect(hasExplicitAgentModel({ agents: { item_gen: { temperature: 0.5 } } }, 'item_gen')).toBe(
      false,
    );
  });
});

describe('resolveAgentLlmParams — 参数跟随模型（Agent 覆写 > 池默认 > 默认层 > 兜底）', () => {
  const defaultsLayer: AgentDefaultsLayer = {
    story: { temperature: 0.7, topP: 1, freqPen: 0, presPen: 0, maxTokens: 65536 },
  };

  it('无覆写、无池默认 → 取默认层', () => {
    expect(resolveAgentLlmParams(bag(), 'story', defaultsLayer)).toMatchObject({
      temperature: 0.7,
      maxTokens: 65536,
    });
  });

  it('池默认压过内容包默认层（否则换模型参数永远轮不到生效）', () => {
    expect(
      resolveAgentLlmParams(bag(), 'story', defaultsLayer, { temperature: 0.2, maxTokens: 8192 }),
    ).toMatchObject({ temperature: 0.2, maxTokens: 8192 });
  });

  it('Agent 显式覆写压过池默认，且只覆写的字段生效', () => {
    const b = { agents: { story: { temperature: 1.4 } } };
    expect(
      resolveAgentLlmParams(b, 'story', defaultsLayer, { temperature: 0.2, maxTokens: 8192 }),
    ).toMatchObject({ temperature: 1.4, maxTokens: 8192 });
  });

  it('两层都缺 → 硬兜底', () => {
    expect(resolveAgentLlmParams(bag(), 'new_agent')).toMatchObject({
      temperature: AGENT_SETTINGS_DEFAULTS.temperature,
      maxTokens: AGENT_SETTINGS_DEFAULTS.maxTokens,
    });
  });

  it('池默认的 frequencyPenalty / presencePenalty 映射到 freqPen / presPen', () => {
    expect(
      resolveAgentLlmParams(bag(), 'story', defaultsLayer, {
        frequencyPenalty: 0.4,
        presencePenalty: -0.6,
      }),
    ).toMatchObject({ freqPen: 0.4, presPen: -0.6 });
  });
});
