/**
 * agent-templates.ts — Prompt 模板系统测试 (Phase 10 更新)
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_TEMPLATES,
  getAgentTemplate,
  buildAgentMessages,
  REGISTERED_AGENT_IDS,
  defaultHistoryLayers,
  defaultHistorySlice,
} from './agent-templates';
import type { AgentContext, AgentConfig, WorldBook, WorldBookEntry } from './types';

// ========== Test Context ==========

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    lorebookMatches: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

// ========== Template Existence ==========

describe('AGENT_TEMPLATES', () => {
  it('应注册全部 13 个 Agent (含 Phase 4+6e 新增)', () => {
    expect(REGISTERED_AGENT_IDS).toHaveLength(13);
  });

  // Phase 3-6e 完整模板 Agent
  const fullAgents = [
    'memory_recall',
    'plot_pre_check',
    'story',
    'vars_update',
    'char_update',
    'memory_summary',
    'plot_post_check',
    'plot_outline',
    'char_gen',
  ];

  // v3 兼容别名 + systemPrompt 迁移到 agent-config.json 的 agent（短模板，仅保留接口兼容）
  const stubAgents = ['plot_check', 'plot_correct', 'craft_gen', 'item_gen'];

  for (const agentId of fullAgents) {
    describe(`${agentId}`, () => {
      it('应有模板', () => {
        expect(AGENT_TEMPLATES[agentId]).toBeDefined();
      });

      it('fixedSystem 应非空 (Phase 10: 最小存根，仅需 >0)', () => {
        expect(AGENT_TEMPLATES[agentId].fixedSystem.length).toBeGreaterThan(0);
      });

      it('variableContext 应返回字符串', () => {
        const ctx = makeContext();
        const result = AGENT_TEMPLATES[agentId].variableContext(ctx);
        expect(typeof result).toBe('string');
      });

      it('variableInstruction 应返回字符串', () => {
        const ctx = makeContext({ agentOutputs: new Map([['story', '测试正文输出']]) });
        const result = AGENT_TEMPLATES[agentId].variableInstruction(ctx);
        expect(typeof result).toBe('string');
        // Phase 10: variableInstruction 仍然必须非空（用户消息）
        expect(result.length).toBeGreaterThan(0);
      });
    });
  }

  // Phase 10: Agents with externalized prompts (craft_gen, char_gen, item_gen) have empty fixedExamples
  const emptyExamplesAgents = ['craft_gen', 'char_gen', 'item_gen'] as const;
  for (const agentId of emptyExamplesAgents) {
    it(`${agentId} 的 fixedExamples 可为空 (提示词在 agent-config.json)`, () => {
      expect(AGENT_TEMPLATES[agentId].fixedExamples).toBe('');
    });
  }

  // v3 兼容别名 — 仅验证存在
  for (const agentId of stubAgents) {
    it(`${agentId} (v3 兼容别名) 应存在`, () => {
      expect(AGENT_TEMPLATES[agentId]).toBeDefined();
    });
  }
});

// ========== getAgentTemplate ==========

describe('getAgentTemplate', () => {
  it('应返回有效 Agent 的模板', () => {
    expect(getAgentTemplate('story')).toBeDefined();
    expect(getAgentTemplate('story')!.fixedSystem).toBe(AGENT_TEMPLATES.story.fixedSystem);
  });

  it('无效 Agent 返回 undefined', () => {
    expect(getAgentTemplate('nonexistent')).toBeUndefined();
    expect(getAgentTemplate('')).toBeUndefined();
  });
});

// ========== buildAgentMessages ==========

describe('buildAgentMessages', () => {
  it('应返回 1 条 system 消息 (Phase 10: 统一模板解析)', () => {
    const ctx = makeContext({
      userInput: '去铁匠铺',
      agentOutputs: new Map([['story', '正文内容']]),
    });
    const messages = buildAgentMessages('memory_recall', ctx);
    expect(messages).toHaveLength(1);
    expect(messages![0].role).toBe('system');
  });

  it('system 应包含 fixedSystem (fallback, 无模板)', () => {
    // plot_check has no default template → uses buildFallbackMessages which returns 2 messages
    const ctx = makeContext();
    const messages = buildAgentMessages('plot_check', ctx);
    expect(messages![0].content).toContain(AGENT_TEMPLATES.plot_check.fixedSystem);
  });

  it('system 应包含 fixedExamples (Phase 10: SYS_PROMPT fallback via template)', () => {
    // memory_recall has a default template; SYS_PROMPT falls back to fixedSystem+fixedExamples
    const ctx = makeContext();
    const messages = buildAgentMessages('memory_recall', ctx);
    expect(messages![0].content).toContain(AGENT_TEMPLATES.memory_recall.fixedExamples);
  });

  it('variableContext 可返回空字符串 (Phase 10: 模板已外部化)', () => {
    const ctx = makeContext({ variables: { HP: 80, MP: 50, 位置: '白曜城' } });
    // vars_update has empty variableContext in Phase 10
    const result = AGENT_TEMPLATES.vars_update.variableContext(ctx);
    expect(result).toBe('');
  });

  it('用户输入应出现在模板解析结果中 (Phase 10: via {{USER_INPUT}})', () => {
    const ctx = makeContext({ userInput: '独特输入ABC123' });
    const messages = buildAgentMessages('memory_recall', ctx);
    // Phase 10: user input resolved via {{USER_INPUT}} into the single system message
    expect(messages![0].content).toContain('独特输入ABC123');
  });

  it('story 模板解析结果应包含用户输入 (Phase 10: via {{USER_INPUT}})', () => {
    const ctx = makeContext({ userInput: '测试指令' });
    const messages = buildAgentMessages('story', ctx);
    expect(messages![0].content).toContain('测试指令');
  });

  it('无效 agentId 返回 null', () => {
    const ctx = makeContext();
    expect(buildAgentMessages('invalid_agent', ctx)).toBeNull();
  });

  it('story agent 应注入世界书内容 (Phase 10: via {{LORE_BOOK}} with configs+worldBooks)', () => {
    const ctx = makeContext({
      userInput: '探索古墓',
      agentOutputs: new Map([['story', '正文']]),
    });
    const cfg = makeCfg('story', { worldBookIds: ['wb_test'] });
    const entry: WorldBookEntry = {
      uid: 1,
      name: '北境古墓',
      content: '**北境古墓**: 位于诺斯加德北部的古老墓穴，传说埋藏着远古帝王的宝藏。',
      enabled: true,
      constant: true,
      key: ['古墓'],
      keysecondary: [],
      selectiveLogic: 0,
      order: 0,
      position: 1,
    };
    const wb: WorldBook = {
      id: 'wb_test',
      name: '测试书',
      partition: 'character',
      entries: [entry],
    };
    const messages = buildAgentMessages('story', ctx, [cfg], [wb]);
    expect(messages![0].content).toContain('北境古墓');
  });

  it('story agent 应注入角色状态和用户输入 (Phase 10: template resolves all)', () => {
    const ctx = makeContext({
      userInput: '查看状态',
      characters: [
        {
          id: 'c1',
          type: 'player',
          name: '阿尔萨斯',
          race: '人类',
          identity: [],
          occupation: [],
          tier: 1,
          tierName: '普通',
          level: 5,
          totalExp: 0,
          expToNext: 100,
          attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
          freeAttrPoints: 0,
          hp: 80, maxHp: 100,
          mp: 30, maxMp: 50,
          sp: 30, maxSp: 50,
          ascension: { enabled: false, elements: [], authority: [], law: [], deityPosition: '', divineKingdom: { name: '', description: '' } },
          equipment: [],
          skills: [],
          inventory: [],
          statusEffects: [],
          money: 100,
          location: '白曜城',
          adventurerRank: 'D',
          currentAction: '探索中',
          customFields: {},
        },
      ],
      agentOutputs: new Map([['story', '正文']]),
    });
    const messages = buildAgentMessages('story', ctx);
    // Phase 10: template resolves all placeholders into single system message
    // system 消息应包含 fixedSystem (via SYS_PROMPT fallback)
    expect(messages![0].content).toContain('命定之诗叙事引擎');
    // user input resolved via {{USER_INPUT}}
    expect(messages![0].content).toContain('查看状态');
  });
});

// ========== Template Quality Checks (Phase 10: relaxed for externalized prompts) ==========

// Phase 10: craft_gen/char_gen/item_gen have prompts in agent-config.json, not here
const EXTERNALIZED_IDS = new Set(['plot_check', 'plot_correct', 'item_gen', 'craft_gen', 'char_gen']);
const activeTemplates = Object.entries(AGENT_TEMPLATES)
  .filter(([id]) => !EXTERNALIZED_IDS.has(id));

describe('模板质量 (Phase 10)', () => {
  it('所有完整模板 fixedSystem 应非空', () => {
    for (const [id, tpl] of activeTemplates) {
      expect(tpl.fixedSystem.length).toBeGreaterThan(0);
    }
  });

  it('所有完整模板 fixedExamples 应非空', () => {
    for (const [id, tpl] of activeTemplates) {
      expect(tpl.fixedExamples.length).toBeGreaterThan(0);
    }
  });

  it('不应有完全空的 fixedSystem', () => {
    for (const [id, tpl] of activeTemplates) {
      expect(tpl.fixedSystem.trim().length).toBeGreaterThan(0);
    }
  });
});

// ========== Phase 8.6: 历史注入 per-Agent 配置 ==========

function makeHistory(n: number): AgentContext['history'] {
  const h: AgentContext['history'] = [];
  for (let i = 0; i < n; i++) {
    h.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `消息${i}内容`.repeat(20) });
  }
  return h;
}
function makeCfg(agentId: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { agentId, enabled: true, apiEndpointId: '', model: '', temperature: 0.7,
    maxTokens: 4096, topP: 1, frequencyPenalty: 0, presencePenalty: 0, retryOnFail: false, timeout: 0,
    userId: '', promptTemplate: { fixedSystem: '', fixedExamples: '' }, worldBookIds: [], ...overrides };
}
function countHistoryEntries(userContent: string): number {
  return (userContent.match(/^\[(user|assistant)\]:/gm) || []).length;
}

describe('默认历史层数 defaultHistoryLayers', () => {
  it('story 类给较多轮(6)、后置型给 1、其余适中', () => {
    expect(defaultHistoryLayers('story')).toBe(6);
    expect(defaultHistoryLayers('memory_summary')).toBe(4);
    expect(defaultHistoryLayers('plot_post_check')).toBe(4);
    expect(defaultHistoryLayers('memory_recall')).toBe(3);
    expect(defaultHistoryLayers('vars_update')).toBe(1);
    expect(defaultHistoryLayers('char_gen')).toBe(1);
    expect(defaultHistoryLayers('item_gen')).toBe(1);
  });
  it('未知 agent 回退中等值', () => {
    expect(defaultHistoryLayers('unknown')).toBeGreaterThanOrEqual(1);
  });
});

describe('默认截断字数 defaultHistorySlice', () => {
  it('长正文 agent 大、后置型小', () => {
    expect(defaultHistorySlice('story')).toBe(1500);
    expect(defaultHistorySlice('memory_summary')).toBe(1500);
    expect(defaultHistorySlice('vars_update')).toBe(800);
    expect(defaultHistorySlice('char_gen')).toBe(800);
  });
});

describe('formatHistory 读取 per-agent 配置', () => {
  it('story 默认注入最近 6*2=12 条 (历史不足则全注入)', () => {
    const ctx = makeContext({ history: makeHistory(8) });   // 8 条历史 < 12
    const cfg = makeCfg('story');
    const msgs = buildAgentMessages('story', ctx, [cfg]);
    // Phase 10: NARRATIVE resolved into single system message via defaultHistoryLayers(6)
    expect(countHistoryEntries(msgs![0].content)).toBe(8);  // 全部 8 条
  });
  it('memory_summary 默认(4层)注入最近 8 条历史 (Phase 10: via {{NARRATIVE:layers=4:slice=1500}})', () => {
    const ctx = makeContext({
      history: makeHistory(10),
      agentOutputs: new Map([['story', 'SOME_STORY_OUTPUT']]),
    });
    const cfg = makeCfg('memory_summary');
    const msgs = buildAgentMessages('memory_summary', ctx, [cfg]);
    const u = msgs![0].content;
    // NARRATIVE placeholder resolves into system message; params in template dictate layers/slice
    expect(countHistoryEntries(u)).toBe(8); // 4 layers * 2 = 8
  });
  it('vars_update template does not include NARRATIVE (Phase 10: template-driven)', () => {
    // vars_update default template has no {{NARRATIVE}} → config historyLayers is not used
    const ctx = makeContext({
      history: makeHistory(8),
      agentOutputs: new Map([['story', 'SOME_STORY_OUTPUT']]),
    });
    const cfg = makeCfg('vars_update', { historyLayers: 0 });
    const msgs = buildAgentMessages('vars_update', ctx, [cfg]);
    const u = msgs![0].content;
    expect(countHistoryEntries(u)).toBe(0);
  });
  it('plot_pre_check 默认注入最近 6 条 (Phase 10: via {{NARRATIVE:layers=3:slice=1000}})', () => {
    const ctx = makeContext({
      history: makeHistory(10),
      agentOutputs: new Map([['story', 'X']]),
    });
    const cfg = makeCfg('plot_pre_check');
    const msgs = buildAgentMessages('plot_pre_check', ctx, [cfg]);
    expect(countHistoryEntries(msgs![0].content)).toBe(6);
  });
  it('story 默认 historySlice=1500 限制正文截断字数', () => {
    const long = '长'.repeat(2000);
    const ctx = makeContext({
      history: [{ role: 'user', content: long }, { role: 'assistant', content: long }],
      agentOutputs: new Map([['story', 'X']]),
    });
    const cfg = makeCfg('story');
    const msgs = buildAgentMessages('story', ctx, [cfg]);
    const u = msgs![0].content;
    // story NARRATIVE uses defaultHistorySlice(1500); 2000-char content truncated to 1500
    // 2 entries * 1500 chars = 3000 '长' chars
    expect((u.match(/长/g) || []).length).toBe(3000);
  });
  it('不传 config (测试/非 orchestrator 路径) → 走类别默认不报错', () => {
    const ctx = makeContext({ history: makeHistory(4) });
    const msgs = buildAgentMessages('story', ctx);
    expect(countHistoryEntries(msgs![0].content)).toBe(4);
  });
  it('buildAgentMessages 不会 mutate 共享 ctx.agentConfig (并行安全)', () => {
    const ctx = makeContext({ history: makeHistory(2) });
    const cfgStory = makeCfg('story');
    buildAgentMessages('story', ctx, [cfgStory]);
    // 调用后 ctx 不应被注入 agentConfig (orchestrator 同 stage 多 agent 共享 ctx)
    expect(ctx.agentConfig).toBeUndefined();
  });
});
