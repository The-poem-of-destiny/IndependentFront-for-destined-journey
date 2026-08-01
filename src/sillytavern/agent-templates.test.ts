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
  buildEjsHistoryText,
} from './agent-templates';
import { getDefaultTemplate } from './placeholder-registry';
import type { AgentContext, AgentConfig, AgentPreset, WorldBook, WorldBookEntry } from './types';

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

function makeCfg(agentId: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId,
    enabled: true,
    apiEndpointId: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 0,
    userId: '',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: [],
    ...overrides,
  };
}

// ========== Template Existence ==========

describe('AGENT_TEMPLATES', () => {
  it('应注册全部 14 个 Agent (含 Phase 10 重命名 + M4 combat)', () => {
    expect(REGISTERED_AGENT_IDS).toHaveLength(14);
  });

  // Phase 3-6e 完整模板 Agent
  const fullAgents = [
    'memory_recall',
    'plot_pre_check',
    'story',
    'request_dispatcher',
    'request_dispatcher',
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

      it('variableContext 应返回字符串 (Phase 10: 可为空)', () => {
        const ctx = makeContext();
        const result = AGENT_TEMPLATES[agentId].variableContext(ctx);
        expect(typeof result).toBe('string');
      });

      it('variableInstruction 应返回字符串 (Phase 10: 可为空)', () => {
        const ctx = makeContext({ agentOutputs: new Map([['story', '测试正文输出']]) });
        const result = AGENT_TEMPLATES[agentId].variableInstruction(ctx);
        expect(typeof result).toBe('string');
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
    // request_dispatcher has empty variableContext in Phase 10
    const result = AGENT_TEMPLATES.request_dispatcher.variableContext(ctx);
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
          saveId: 'test',
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
          hp: 80,
          maxHp: 100,
          mp: 30,
          maxMp: 50,
          sp: 30,
          maxSp: 50,
          ascension: {
            enabled: false,
            elements: [],
            authority: [],
            law: [],
            deityPosition: '',
            divineKingdom: { name: '', description: '' },
          },
          skills: [],
          inventory: [],
          statusEffects: [],
          money: 100,
          location: '白曜城',
          present: true,
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

// ========== Phase 10: localParams 注入 (链式 Agent 数据注入) ==========

describe('buildAgentMessages — Phase 10 localParams', () => {
  it('craft_gen 模板解析 {{CRAFT_REQUEST}} from localParams', () => {
    const ctx = makeContext();
    const cfg = makeCfg('craft_gen', { systemPrompt: 'Craft AI' });
    const messages = buildAgentMessages('craft_gen', ctx, [cfg], [], undefined, {
      CRAFT_REQUEST: '<craft_request expects="sword">forge a blade</craft_request>',
    });
    expect(messages).not.toBeNull();
    expect(messages![0].content).toContain('forge a blade');
  });

  it('char_gen 模板解析 {{CHAR_DETECT}} from localParams', () => {
    const ctx = makeContext();
    const cfg = makeCfg('char_gen', { systemPrompt: 'Char Gen AI' });
    const messages = buildAgentMessages('char_gen', ctx, [cfg], [], undefined, {
      CHAR_DETECT: '<char_detect characterName="NPC">a mysterious figure</char_detect>',
    });
    expect(messages).not.toBeNull();
    expect(messages![0].content).toContain('a mysterious figure');
  });

  it('item_gen 模板解析 {{ITEM_REQUEST}} + {{CHAR_GEN_RESULT}} from localParams', () => {
    const ctx = makeContext();
    const cfg = makeCfg('item_gen', { systemPrompt: 'Item Gen AI' });
    const messages = buildAgentMessages('item_gen', ctx, [cfg], [], undefined, {
      ITEM_REQUEST: '<request type="equipment" slot="武器">a sharp sword</request>',
      CHAR_GEN_RESULT: '<char_result><name>Test</name></char_result>',
    });
    expect(messages).not.toBeNull();
    expect(messages![0].content).toContain('a sharp sword');
    expect(messages![0].content).toContain('char_result');
  });

  it('链占位符未传 localParams 时保持空 (不回退到错误值)', () => {
    const ctx = makeContext();
    const cfg = makeCfg('craft_gen', { systemPrompt: 'Craft AI' });
    const messages = buildAgentMessages('craft_gen', ctx, [cfg]);
    expect(messages).not.toBeNull();
    // {{CRAFT_REQUEST}} stays empty (registry returns '')
    // The template should still resolve successfully, just without craft_request content
    expect(messages![0].content).toContain('Craft AI');
  });
});

// ========== Phase 10: config.template 优先级 ==========

describe('buildAgentMessages — template priority', () => {
  it('传入 config.template 时优先使用 (而非 getDefaultTemplate)', () => {
    const ctx = makeContext({ userInput: 'hello' });
    const cfg = makeCfg('story', {
      systemPrompt: 'Custom sys prompt',
      template: '{{SYS_PROMPT}}\n{{USER_INPUT}}',
    });
    const messages = buildAgentMessages('story', ctx, [cfg]);
    expect(messages).not.toBeNull();
    expect(messages![0].content).toContain('Custom sys prompt');
    expect(messages![0].content).toContain('hello');
    // 不应包含默认模板里的占位符
    expect(messages![0].content).not.toContain('{{NARRATIVE}}');
  });

  it('未传 template 时回退到 getDefaultTemplate(agentId)', () => {
    const ctx = makeContext({ userInput: 'test' });
    const cfg = makeCfg('request_dispatcher', {
      systemPrompt: 'VARS_AI_PROMPT',
      template: undefined,
    });
    const messages = buildAgentMessages('request_dispatcher', ctx, [cfg]);
    expect(messages).not.toBeNull();
    // default vars_update template has AGENT.STORY, CHARACTER_STATE, LORE_BOOK
    expect(messages![0].content).toContain('VARS_AI_PROMPT');
  });

  it('memory_recall 默认模板包含 NARRATIVE 占位符内容 (Phase 10 replaced)', () => {
    const ctx = makeContext({
      userInput: '去古墓探险',
      history: [{ role: 'user', content: '上次去了铁匠铺' } as any],
    });
    const cfg = makeCfg('memory_recall', { systemPrompt: 'Memory recall system' });
    const messages = buildAgentMessages('memory_recall', ctx, [cfg]);
    expect(messages).not.toBeNull();
    // NARRATIVE placeholder should resolve to formatted history
    expect(messages![0].content).toContain('铁匠铺');
  });
});

// ========== Phase 10: SYS_PROMPT 组装 ==========

describe('buildAgentMessages — SYS_PROMPT assembly', () => {
  it('非 story Agent 使用 config.systemPrompt', () => {
    const ctx = makeContext();
    const cfg = makeCfg('request_dispatcher', { systemPrompt: 'REQUEST_DISP_SYSPROMPT' });
    const messages = buildAgentMessages('request_dispatcher', ctx, [cfg]);
    expect(messages).not.toBeNull();
    expect(messages![0].content).toContain('REQUEST_DISP_SYSPROMPT');
  });

  it('无 systemPrompt + 无 template 时回退到 fixedSystem+fixedExamples', () => {
    const ctx = makeContext();
    const cfg = makeCfg('memory_recall', { systemPrompt: '' });
    const messages = buildAgentMessages('memory_recall', ctx, [cfg]);
    expect(messages).not.toBeNull();
    // 应包含 AGENT_TEMPLATES.memory_recall.fixedSystem 或 fixedExamples fallback
    expect(messages![0].content).toContain('记忆召回系统');
  });

  it('story agent + presets 时使用 assemblePresetContent()', () => {
    const ctx = makeContext({ userInput: 'test' });
    const cfg = makeCfg('story', {
      systemPrompt: 'should-not-be-used',
      presetId: 'test-preset',
    });
    const presets: AgentPreset[] = [
      {
        id: 'test-preset',
        name: 'Test Preset',
        fixedSystem: 'PRESET_CONTENT',
        fixedExamples: '',
      } as AgentPreset,
    ];
    const messages = buildAgentMessages('story', ctx, [cfg], [], presets);
    expect(messages).not.toBeNull();
    // 预设内容应出现在结果中
    expect(messages![0].content).toContain('PRESET_CONTENT');
  });

  // 真机修(2026-07-23): story 走 ST 预设路径，预设内部 <本次任务信息参考> 区块含全套系统占位符。
  // resolveTemplate 单层不递归 SYS_PROMPT 内部 → 预解析预设内容把占位符就地渲染 + 简化 template 去重。
  it('story + 规范预设(含系统占位符) → 预解析内部占位符 + template 简化去重(不裸奔/不重复)', () => {
    const ctx = makeContext({
      userInput: '探索古墓',
      agentOutputs: new Map([['memory_recall', '{"memories":[{"id":"M1"}]}']]),
    });
    const cfg = makeCfg('story', { presetId: 'spec-preset' });
    const presets: AgentPreset[] = [
      {
        id: 'spec-preset',
        name: 'Spec Preset',
        fixedSystem:
          'VOID 核心提示词。\n<本次任务信息参考>\n<LORE_BOOK>{{LORE_BOOK}}</LORE_BOOK>\n<USER_INPUT>{{USER_INPUT}}</USER_INPUT>\n<MEMORY>{{AGENT.MEMORY_RECALL}}</MEMORY>\n</本次任务信息参考>',
        fixedExamples: '',
      } as AgentPreset,
    ];
    const messages = buildAgentMessages('story', ctx, [cfg], [], presets);
    expect(messages).not.toBeNull();
    const content = messages![0].content;
    // 预设内部占位符已被预解析渲染 — 不残留裸占位符（旧实现会全部裸奔）
    expect(content).not.toContain('{{LORE_BOOK}}');
    expect(content).not.toContain('{{USER_INPUT}}');
    expect(content).not.toContain('{{AGENT.MEMORY_RECALL}}');
    // 用户输入/memory 输出通过预设内部占位符原地渲染
    expect(content).toContain('探索古墓');
    expect(content).toContain('{"memories":[{"id":"M1"}]}');
    // 去重: template 已简化为 {{SYS_PROMPT}}，不再追加重复的 {{USER_INPUT}} → 用户输入只出现一次
    expect(content.split('探索古墓').length - 1).toBe(1);
  });
});

// ========== Phase 10: 单消息返回格式 ==========

describe('buildAgentMessages — return format (Phase 10 single system msg)', () => {
  const agentsWithTemplates = [
    'story',
    'memory_recall',
    'plot_pre_check',
    'request_dispatcher',
    'request_dispatcher',
    'memory_summary',
    'plot_post_check',
    'plot_outline',
    'craft_gen',
    'char_gen',
    'item_gen',
  ];

  for (const agentId of agentsWithTemplates) {
    it(`${agentId} 返回单条 system 消息`, () => {
      const ctx = makeContext({ userInput: 'test' });
      const cfg = makeCfg(agentId, { systemPrompt: 'Test prompt' });
      const messages = buildAgentMessages(agentId, ctx, [cfg]);
      expect(messages).toBeDefined();
      expect(messages!.length).toBeGreaterThanOrEqual(1);
      for (const m of messages!) {
        expect(m.role).toBe('system');
      }
    });
  }
});

// ========== Template Quality Checks (Phase 10: relaxed for externalized prompts) ==========

// Phase 10: craft_gen/char_gen/item_gen have prompts in agent-config.json, not here
const EXTERNALIZED_IDS = new Set([
  'plot_check',
  'plot_correct',
  'item_gen',
  'craft_gen',
  'char_gen',
  'combat',
]);
const activeTemplates = Object.entries(AGENT_TEMPLATES).filter(([id]) => !EXTERNALIZED_IDS.has(id));

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
    h.push({
      id: `hist-${i}`,
      timestamp: Date.now() + i * 1000,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息${i}内容`.repeat(20),
    } as any);
  }
  return h;
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
    expect(defaultHistoryLayers('request_dispatcher')).toBe(1);
    expect(defaultHistoryLayers('request_dispatcher')).toBe(1);
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
    expect(defaultHistorySlice('request_dispatcher')).toBe(800);
    expect(defaultHistorySlice('request_dispatcher')).toBe(800);
    expect(defaultHistorySlice('char_gen')).toBe(800);
  });
});

describe('formatHistory 读取 per-agent 配置', () => {
  it('story 默认注入最近 6*2=12 条 (历史不足则全注入)', () => {
    const ctx = makeContext({ history: makeHistory(8) }); // 8 条历史 < 12
    const cfg = makeCfg('story');
    const msgs = buildAgentMessages('story', ctx, [cfg]);
    // Phase 10: NARRATIVE resolved into single system message via defaultHistoryLayers(6)
    expect(countHistoryEntries(msgs![0].content)).toBe(8); // 全部 8 条
  });
  it('memory_summary 默认(4层)注入最近 8 条历史 (Phase 10: via {{NARRATIVE:layers=4}})', () => {
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
  it('request_dispatcher template does not include NARRATIVE (Phase 10: template-driven)', () => {
    // request_dispatcher default template has no {{NARRATIVE}} → config historyLayers is not used
    const ctx = makeContext({
      history: makeHistory(8),
      agentOutputs: new Map([['story', 'SOME_STORY_OUTPUT']]),
    });
    const cfg = makeCfg('request_dispatcher', { historyLayers: 0 });
    const msgs = buildAgentMessages('request_dispatcher', ctx, [cfg]);
    const u = msgs![0].content;
    expect(countHistoryEntries(u)).toBe(0);
  });
  it('plot_pre_check 默认注入最近 6 条 (Phase 10: via {{NARRATIVE:layers=3}})', () => {
    const ctx = makeContext({
      history: makeHistory(10),
      agentOutputs: new Map([['story', 'X']]),
    });
    const cfg = makeCfg('plot_pre_check');
    const msgs = buildAgentMessages('plot_pre_check', ctx, [cfg]);
    expect(countHistoryEntries(msgs![0].content)).toBe(6);
  });
  // :slice 已退役，NARRATIVE 不再截断正文
  it('story 默认不再截断正文（:slice 已退役）', () => {
    const long = '长'.repeat(2000);
    const ctx = makeContext({
      history: [
        { role: 'user', content: long } as any,
        { role: 'assistant', content: long } as any,
      ],
      agentOutputs: new Map([['story', 'X']]),
    });
    const cfg = makeCfg('story');
    const msgs = buildAgentMessages('story', ctx, [cfg]);
    const u = msgs![0].content;
    // :slice retired — full 2000-char content is preserved
    expect((u.match(/长/g) || []).length).toBe(4000);
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

// ========== 工坊 P2: EJS pass 上下文（statData / vars 草稿 / 提交权）==========

describe('buildAgentMessages × EJS pass 上下文 (ADR-30 D4/D5)', () => {
  /** 读 stats + 写 vars 的动态条目 */
  function makeEjsWorldBook(): WorldBook {
    return {
      id: 'wb_ejs',
      name: 'EJS 书',
      partition: 'world_setting',
      entries: [
        {
          uid: 1,
          name: '动态条目',
          content:
            '<% setMessageVar("计数", (getMessageVar("计数") ?? 0) + 1) %>HP=<%= stats.主角.生命值 %>',
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 1,
          position: 0,
        },
      ],
    };
  }

  it('ctx.statData 注入 → EJS 读得到 stats 面', () => {
    const ctx = makeContext({ statData: { 主角: { 生命值: 66 } } });
    const cfg = makeCfg('story', { worldBookIds: ['wb_ejs'] });
    const msgs = buildAgentMessages('story', ctx, [cfg], [makeEjsWorldBook()]);
    expect(msgs![0].content).toContain('HP=66');
  });

  it('ejsVarsDrafts 只在持权 Agent 的 pass 被填充', () => {
    const drafts = new Map<string, { base: Record<string, any>; draft: Record<string, any> }>();
    const ctx = makeContext({
      statData: { 主角: { 生命值: 1 } },
      variables: { sys: { 计数: 5 } },
      ejsVarsDrafts: drafts,
    });
    const wb = makeEjsWorldBook();

    // 无权 Agent：求值照跑，但不登记草稿
    const noRight = makeCfg('request_dispatcher', { worldBookIds: ['wb_ejs'] });
    buildAgentMessages('request_dispatcher', ctx, [noRight], [wb]);
    expect(drafts.size).toBe(0);

    // 持权 Agent：登记 { base, draft }，draft 带上 EJS 的写
    const withRight = makeCfg('story', { worldBookIds: ['wb_ejs'], ejsVarsCommit: true });
    buildAgentMessages('story', ctx, [withRight], [wb]);
    expect([...drafts.keys()]).toEqual(['story']);
    expect(drafts.get('story')!.base.计数).toBe(5);
    expect(drafts.get('story')!.draft.计数).toBe(6);
  });

  it('草稿是克隆 —— EJS 的写不回流 ctx.variables.sys（提交由回合结算负责）', () => {
    const drafts = new Map<string, { base: Record<string, any>; draft: Record<string, any> }>();
    const sys = { 计数: 5 };
    const ctx = makeContext({
      statData: {},
      variables: { sys },
      ejsVarsDrafts: drafts,
    });
    const cfg = makeCfg('story', { worldBookIds: ['wb_ejs'], ejsVarsCommit: true });
    buildAgentMessages('story', ctx, [cfg], [makeEjsWorldBook()]);
    expect(sys.计数).toBe(5);
  });

  it('无 ejsVarsDrafts 容器（老调用方）→ 持权 Agent 也不炸', () => {
    const ctx = makeContext({ statData: {}, variables: { sys: {} } });
    const cfg = makeCfg('story', { worldBookIds: ['wb_ejs'], ejsVarsCommit: true });
    expect(() => buildAgentMessages('story', ctx, [cfg], [makeEjsWorldBook()])).not.toThrow();
  });

  it('buildEjsHistoryText 按 historyLayers 取窗口、拼正文、不截断', () => {
    const long = '文'.repeat(3000);
    const ctx = makeContext({
      history: [
        { role: 'user', content: '第一条' } as any,
        { role: 'assistant', content: '第二条' } as any,
        { role: 'user', content: long } as any,
      ],
    });
    const text = buildEjsHistoryText('story', ctx, makeCfg('story', { historyLayers: 1 }));
    expect(text).not.toContain('第一条');
    expect(text).toContain('第二条');
    expect((text.match(/文/g) || []).length).toBe(3000);
    expect(buildEjsHistoryText('story', ctx, makeCfg('story', { historyLayers: 0 }))).toBe('');
  });
});
