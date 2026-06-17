/**
 * agent-templates.ts — Prompt 模板系统测试
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_TEMPLATES,
  getAgentTemplate,
  buildAgentMessages,
  REGISTERED_AGENT_IDS,
} from './agent-templates';
import type { AgentContext } from './types';

// ========== Test Context ==========

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    lorebookMatches: [],
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
    'craft_gen',
    'char_gen',
    'item_gen',
  ];

  // v3 兼容别名（短模板，仅保留接口兼容）
  const stubAgents = ['plot_check', 'plot_correct'];

  for (const agentId of fullAgents) {
    describe(`${agentId}`, () => {
      it('应有模板', () => {
        expect(AGENT_TEMPLATES[agentId]).toBeDefined();
      });

      it('fixedSystem 不应为空', () => {
        expect(AGENT_TEMPLATES[agentId].fixedSystem.length).toBeGreaterThan(50);
      });

      it('fixedExamples 不应为空', () => {
        expect(AGENT_TEMPLATES[agentId].fixedExamples.length).toBeGreaterThan(20);
      });

      it('variableContext 应返回字符串', () => {
        const ctx = makeContext();
        const result = AGENT_TEMPLATES[agentId].variableContext(ctx);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      });

      it('variableInstruction 应返回字符串', () => {
        const ctx = makeContext({ agentOutputs: new Map([['story', '测试正文输出']]) });
        const result = AGENT_TEMPLATES[agentId].variableInstruction(ctx);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      });
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
  it('应返回 system + user 两条消息', () => {
    const ctx = makeContext({
      userInput: '去铁匠铺',
      agentOutputs: new Map([['story', '正文内容']]),
    });
    const messages = buildAgentMessages('memory_recall', ctx);
    expect(messages).toHaveLength(2);
    expect(messages![0].role).toBe('system');
    expect(messages![1].role).toBe('user');
  });

  it('system 应包含 fixedSystem', () => {
    const ctx = makeContext();
    const messages = buildAgentMessages('plot_check', ctx);
    expect(messages![0].content).toContain(AGENT_TEMPLATES.plot_check.fixedSystem);
  });

  it('system 应包含 fixedExamples', () => {
    const ctx = makeContext();
    const messages = buildAgentMessages('memory_recall', ctx);
    expect(messages![0].content).toContain(AGENT_TEMPLATES.memory_recall.fixedExamples);
  });

  it('system 应包含 variableContext 输出', () => {
    const ctx = makeContext({
      userInput: '特殊测试内容',
      variables: { HP: 80, MP: 50, 位置: '白曜城' },
    });
    const messages = buildAgentMessages('memory_recall', ctx);
    // variableContext of memory_recall contains "当前记忆库" and "最近对话" blocks
    expect(messages![0].content).toContain('当前记忆库');
    expect(messages![0].content).toContain('最近对话');
  });

  it('variableInstruction 应包含用户输入', () => {
    const ctx = makeContext({ userInput: '独特输入ABC123' });
    const messages = buildAgentMessages('memory_recall', ctx);
    // user message = variableInstruction, should contain user input
    expect(messages![1].content).toContain('独特输入ABC123');
  });

  it('user 消息应包含 variableInstruction 输出', () => {
    const ctx = makeContext({ userInput: '测试指令' });
    const messages = buildAgentMessages('story', ctx);
    expect(messages![1].content).toContain('测试指令');
  });

  it('无效 agentId 返回 null', () => {
    const ctx = makeContext();
    expect(buildAgentMessages('invalid_agent', ctx)).toBeNull();
  });

  it('story agent 应注入世界书内容', () => {
    const ctx = makeContext({
      userInput: '探索古墓',
      lorebookMatches: [
        {
          entry: {
            id: 'lb_1',
            keys: ['古墓'],
            secondaryKeys: [],
            content: '**北境古墓**: 位于诺斯加德北部的古老墓穴，传说埋藏着远古帝王的宝藏。',
            order: 0,
            position: 'before_char',
            selective: false,
            selectiveLogic: 'and_any',
            constant: false,
            probability: 100,
            addMemo: false,
          },
          score: 1,
          matchedKeywords: ['古墓'],
        },
      ],
      agentOutputs: new Map([['story', '正文']]),
    });
    const messages = buildAgentMessages('story', ctx);
    expect(messages![0].content).toContain('北境古墓');
  });

  it('story agent 应注入角色状态', () => {
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
          ascension: { enabled: false, elements: {}, authority: {}, law: {}, deityPosition: '', divineKingdom: { name: '', description: '' } },
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
    expect(messages![0].content).toContain('阿尔萨斯');
    expect(messages![0].content).toContain('HP:80/100');
  });
});

// ========== Template Quality Checks ==========

// Skip v3 compat stubs — they're intentionally minimal
const STUB_IDS = new Set(['plot_check', 'plot_correct']);
const activeTemplates = Object.entries(AGENT_TEMPLATES)
  .filter(([id]) => !STUB_IDS.has(id));

describe('模板质量', () => {
  it('所有完整模板 fixedSystem 应包含输出格式说明', () => {
    for (const [id, tpl] of activeTemplates) {
      const hasFormat = tpl.fixedSystem.includes('输出格式') || tpl.fixedSystem.includes('JSON');
      expect(hasFormat).toBe(true);
    }
  });

  it('所有完整模板 fixedExamples 应包含 "示例"', () => {
    for (const [id, tpl] of activeTemplates) {
      expect(tpl.fixedExamples).toContain('示例');
    }
  });

  it('不应有空的 fixedSystem', () => {
    for (const [id, tpl] of activeTemplates) {
      expect(tpl.fixedSystem.trim().length).toBeGreaterThan(100);
    }
  });
});
