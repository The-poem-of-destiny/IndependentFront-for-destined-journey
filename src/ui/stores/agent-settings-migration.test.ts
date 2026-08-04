/**
 * per-Agent map → `agents` 形状迁移（Q-18 第 4 步）
 *
 * 这份测试守的是四条「错了不会编译报错、只会在真机上表现成设置丢失」的性质：
 *   1. 一个 agent 的 12 个字段必须落到**同一条** entry（第一版就在这里错过）
 *   2. `historyLayers` / `historySlice` 缺省时**键必须不存在**（不是 undefined）
 *   3. 迁移**不合默认值** —— 没设过的项就是没有，不能被写成 0.7
 *   4. 幂等：跑第二遍什么都不做
 */
import { describe, it, expect } from 'vitest';
import { migrateLegacyAgentMaps, LEGACY_AGENT_MAPS } from './agent-settings-migration';

/** 一个「老用户」的袋子：12 张 map 都有，两个 agent */
function legacyBag(): Record<string, any> {
  return {
    agentModels: { story: 'ep1:gpt', char_gen: 'ep2:claude' },
    agentWorldbookEnabled: { story: true },
    agentWorldbookIds: { story: ['wb_a', 'wb_b'] },
    agentPrompts: { story: '你是叙事者' },
    agentTemplates: { story: '{{HISTORY}}' },
    agentTemperature: { story: 1.2, char_gen: 0.3 },
    agentTopP: { story: 0.9 },
    agentFreqPen: { story: 0.1 },
    agentPresPen: { story: 0.2 },
    agentMaxTokens: { story: 8192 },
    agentHistoryLayers: { story: 3 },
    agentHistorySlice: { story: 1500 },
    // 这两个不参与迁移
    agentDirty: { story: true },
    agentPromptEdited: false,
    // 无关设置
    hoverDelayMs: 200,
  };
}

describe('migrateLegacyAgentMaps', () => {
  it('全新用户（一张旧 map 都没有）→ 什么都不做，只保证 agents 是对象', () => {
    const bag: Record<string, any> = { hoverDelayMs: 200 };
    const r = migrateLegacyAgentMaps(bag);
    expect(r.migrated).toBe(false);
    expect(r.agentIds).toEqual([]);
    expect(r.removedKeys).toEqual([]);
    expect(bag.agents).toEqual({});
    expect(bag.hoverDelayMs).toBe(200);
  });

  it('🔴 一个 agent 的 12 个字段全部落到**同一条** entry', () => {
    // 第一版在这里错过：循环里现查「agents 有没有这个 id」，于是第一张 map 建好
    // agents.story 之后，后面 11 张全被自己刚建的那条判成冲突跳过。
    const bag = legacyBag();
    migrateLegacyAgentMaps(bag);
    expect(bag.agents.story).toEqual({
      model: 'ep1:gpt',
      worldBookEnabled: true,
      worldBookIds: ['wb_a', 'wb_b'],
      systemPrompt: '你是叙事者',
      template: '{{HISTORY}}',
      temperature: 1.2,
      topP: 0.9,
      freqPen: 0.1,
      presPen: 0.2,
      maxTokens: 8192,
      historyLayers: 3,
      historySlice: 1500,
    });
  });

  it('多个 agent 各自独立，只搬各自 map 里真有的键', () => {
    const bag = legacyBag();
    migrateLegacyAgentMaps(bag);
    // char_gen 只在 agentModels / agentTemperature 里出现过
    expect(bag.agents.char_gen).toEqual({ model: 'ep2:claude', temperature: 0.3 });
  });

  it('🔴 迁移**不合默认值** —— 没设过的项就是不存在', () => {
    // 合默认是读取时（getAgentSettings）的事。在这里补会把「从没设过」与
    // 「设成了恰好等于默认的值」永久混为一谈，之后再也分不开。
    const bag = legacyBag();
    migrateLegacyAgentMaps(bag);
    expect('maxTokens' in bag.agents.char_gen).toBe(false);
    expect('topP' in bag.agents.char_gen).toBe(false);
    expect('systemPrompt' in bag.agents.char_gen).toBe(false);
  });

  it('🔴 historyLayers / historySlice 缺省 → 键**不存在**，不是 undefined', () => {
    // 「键存在」在这两项上编码的是「用户显式设过」，会挡掉引擎按 agent 类别给的默认。
    // 写一个 undefined 进去会让 `in` 成立，语义就反了。
    const bag: Record<string, any> = { agentModels: { story: 'ep1' } };
    migrateLegacyAgentMaps(bag);
    expect('historyLayers' in bag.agents.story).toBe(false);
    expect('historySlice' in bag.agents.story).toBe(false);
  });

  it('historyLayers = 0 是有效值，必须搬过来（不能被当成 falsy 丢掉）', () => {
    const bag: Record<string, any> = { agentHistoryLayers: { story: 0 } };
    migrateLegacyAgentMaps(bag);
    expect(bag.agents.story.historyLayers).toBe(0);
    expect('historyLayers' in bag.agents.story).toBe(true);
  });

  it('搬完删掉全部 12 个旧键，且只删这 12 个', () => {
    const bag = legacyBag();
    const r = migrateLegacyAgentMaps(bag);
    expect(r.removedKeys.sort()).toEqual(LEGACY_AGENT_MAPS.map(([k]) => k).sort());
    for (const [key] of LEGACY_AGENT_MAPS) expect(key in bag).toBe(false);
    // 这三个不在迁移范围内，必须原样还在
    expect(bag.agentDirty).toEqual({ story: true });
    expect(bag.agentPromptEdited).toBe(false);
    expect(bag.hoverDelayMs).toBe(200);
  });

  it('幂等：跑第二遍是 no-op，不动已经搬好的 agents', () => {
    const bag = legacyBag();
    migrateLegacyAgentMaps(bag);
    const snapshot = JSON.parse(JSON.stringify(bag.agents));
    const second = migrateLegacyAgentMaps(bag);
    expect(second.migrated).toBe(false);
    expect(second.removedKeys).toEqual([]);
    expect(bag.agents).toEqual(snapshot);
  });

  it('🔴 agents 与旧 map 同时存在（跨标签页写回）→ agents 赢，旧值被跳过并记账', () => {
    const bag: Record<string, any> = {
      agents: { story: { model: '新标签页刚选的' } },
      agentModels: { story: '旧标签页写回的', char_gen: 'ep2' },
      agentTemperature: { story: 9.9 },
    };
    const r = migrateLegacyAgentMaps(bag);
    expect(bag.agents.story).toEqual({ model: '新标签页刚选的' });
    expect(r.skippedAgentIds).toEqual(['story']);
    // 不冲突的那个照搬
    expect(bag.agents.char_gen).toEqual({ model: 'ep2' });
    // 旧键仍然清掉 —— 留着下次还会再来一遍同样的冲突
    expect('agentModels' in bag).toBe(false);
  });

  it('旧键被写坏成非对象（字符串 / 数组 / null）→ 当它不存在，不抛也不清', () => {
    const bag: Record<string, any> = {
      agentModels: 'corrupted',
      agentTemperature: ['also', 'wrong'],
      agentTopP: null,
      agentPrompts: { story: 'ok' },
    };
    const r = migrateLegacyAgentMaps(bag);
    expect(bag.agents.story).toEqual({ systemPrompt: 'ok' });
    // 只有形状对的那张被认作源、被删；坏的三张原样留着给人排查
    expect(r.removedKeys).toEqual(['agentPrompts']);
    expect(bag.agentModels).toBe('corrupted');
    expect(bag.agentTopP).toBeNull();
  });

  it('agentIds 按首次出现顺序，便于排查', () => {
    const bag: Record<string, any> = {
      agentModels: { b: 'x', a: 'y' },
      agentTemperature: { c: 1 },
    };
    expect(migrateLegacyAgentMaps(bag).agentIds).toEqual(['b', 'a', 'c']);
  });

  it('LEGACY_AGENT_MAPS 覆盖 12 项，且不含 agentDirty / agentPromptEdited', () => {
    // agentDirty 是「有未保存改动」的 UI 状态，不是设置：混进条目会跟着
    // saveAsDefault 一路写进 data/defaults/agent-config.json。
    const keys = LEGACY_AGENT_MAPS.map(([k]) => k);
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain('agentDirty');
    expect(keys).not.toContain('agentPromptEdited');
    expect(new Set(keys).size).toBe(12);
    expect(new Set(LEGACY_AGENT_MAPS.map(([, f]) => f)).size).toBe(12);
  });
});
