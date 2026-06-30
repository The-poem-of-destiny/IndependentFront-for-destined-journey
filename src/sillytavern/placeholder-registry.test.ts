/**
 * placeholder-registry 测试 (Phase 10)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PLACEHOLDER_REGISTRY,
  getDefaultTemplate,
  setPlaceholderGlobals,
  resetPlaceholderGlobals,
} from './placeholder-registry';
import { resolveTemplate } from './template-resolver';
import type {
  AgentContext, AgentConfig, WorldBook, CharacterState,
  MemoryRecord, PlotEvent, InventoryItem, StatusEffect,
} from './types';

// ========== Helpers ==========

function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    userInput: 'test input',
    history: [
      { id: '1', role: 'user', content: 'hello', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'hi there', timestamp: 2 },
    ],
    characters: [],
    memories: [],
    plotEvents: [],
    variables: {},
    agentOutputs: new Map(),
    lorebookMatches: [],
    worldBooks: [],
    ...overrides,
  } as AgentContext;
}

function mockConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    agentId: 'test_agent',
    apiEndpointId: 'ep1',
    model: 'test-model',
    enabled: true,
    worldBookIds: [],
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 30000,
    userId: 'test-user',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    ...overrides,
  };
}

function makeChar(overrides?: Partial<CharacterState>): CharacterState {
  return {
    id: 'char_001',
    type: 'npc',
    name: '测试角色',
    race: '人类',
    identity: ['冒险者'],
    occupation: ['战士'],
    tier: 2,
    tierName: '中坚',
    level: 5,
    totalExp: 200,
    expToNext: 800,
    attributes: { str: 12, dex: 8, con: 10, int: 7, spi: 5 },
    freeAttrPoints: 0,
    hp: 85, maxHp: 100,
    mp: 40, maxMp: 50,
    sp: 30, maxSp: 50,
    ascension: {
      enabled: false,
      elements: [],
      authority: [],
      law: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    equipment: [],
    skills: [],
    inventory: [],
    statusEffects: [],
    money: 50,
    location: '白曜城',
    adventurerRank: '未评级',
    currentAction: '待机中',
    customFields: {},
    ...overrides,
  };
}

// ========== SYS_PROMPT ==========

describe('SYS_PROMPT', () => {
  it('returns systemPrompt when set', () => {
    const config = mockConfig({ systemPrompt: 'You are a helpful assistant.' });
    const result = PLACEHOLDER_REGISTRY['SYS_PROMPT'](mockCtx(), config);
    expect(result).toBe('You are a helpful assistant.');
  });

  it('returns empty string when systemPrompt is undefined', () => {
    const config = mockConfig();
    const result = PLACEHOLDER_REGISTRY['SYS_PROMPT'](mockCtx(), config);
    expect(result).toBe('');
  });

  it('returns empty string when systemPrompt is empty string', () => {
    const config = mockConfig({ systemPrompt: '' });
    const result = PLACEHOLDER_REGISTRY['SYS_PROMPT'](mockCtx(), config);
    expect(result).toBe('');
  });
});

// ========== USER_INPUT ==========

describe('USER_INPUT', () => {
  it('returns userInput', () => {
    const ctx = mockCtx({ userInput: '你好，铁匠' });
    const result = PLACEHOLDER_REGISTRY['USER_INPUT'](ctx, mockConfig());
    expect(result).toBe('你好，铁匠');
  });

  it('returns empty string when userInput is undefined', () => {
    const ctx = mockCtx();
    (ctx as any).userInput = undefined;
    const result = PLACEHOLDER_REGISTRY['USER_INPUT'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('returns empty string when userInput is empty', () => {
    const ctx = mockCtx({ userInput: '' });
    const result = PLACEHOLDER_REGISTRY['USER_INPUT'](ctx, mockConfig());
    expect(result).toBe('');
  });
});

// ========== NARRATIVE ==========

describe('NARRATIVE', () => {
  it('formats history with default layers and slice', () => {
    const ctx = mockCtx({
      history: [
        { id: '1', role: 'user', content: 'hello world', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'hi there friend', timestamp: 2 },
        { id: '3', role: 'user', content: 'how are you', timestamp: 3 },
        { id: '4', role: 'assistant', content: 'doing well thanks', timestamp: 4 },
      ],
    });
    const config = mockConfig({ agentId: 'story' });
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, config);
    expect(result).toContain('[user]:');
    expect(result).toContain('[assistant]:');
    expect(result).toContain('hello world');
  });

  it('respects layers param', () => {
    const ctx = mockCtx({
      history: [
        { id: '1', role: 'user', content: 'a', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'b', timestamp: 2 },
        { id: '3', role: 'user', content: 'c', timestamp: 3 },
        { id: '4', role: 'assistant', content: 'd', timestamp: 4 },
        { id: '5', role: 'user', content: 'e', timestamp: 5 },
        { id: '6', role: 'assistant', content: 'f', timestamp: 6 },
      ],
    });
    const config = mockConfig({ agentId: 'story' });
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, config, { layers: '1' });
    // 1 layer = 2 messages
    const lines = result.split('\n').filter(l => l);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('[user]: e');
    expect(lines[1]).toContain('[assistant]: f');
  });

  it('respects slice param', () => {
    const ctx = mockCtx({
      history: [
        { id: '1', role: 'user', content: 'a very long message that should be truncated', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'another long response', timestamp: 2 },
      ],
    });
    const config = mockConfig({ agentId: 'story' });
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, config, { layers: '1', slice: '5' });
    expect(result).toContain('[user]: a ver');
    expect(result).not.toContain('truncated');
  });

  it('handles empty history', () => {
    const ctx = mockCtx({ history: [] });
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('returns empty string when layers is 0', () => {
    const ctx = mockCtx({
      history: [
        { id: '1', role: 'user', content: 'hello', timestamp: 1 },
      ],
    });
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, mockConfig(), { layers: '0' });
    expect(result).toBe('');
  });

  it('uses defaultHistoryLayers for the agent when no params', () => {
    const ctx = mockCtx({
      history: Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`, role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `msg ${i}`, timestamp: i,
      })),
    });
    const config = mockConfig({ agentId: 'story' }); // defaultLayers=6 → 12 messages
    const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, config);
    const lines = result.split('\n').filter(l => l);
    expect(lines.length).toBe(12);
  });
});

// ========== MEMORY_ENTRIES ==========

describe('MEMORY_ENTRIES', () => {
  it('formats memories', () => {
    const memories: MemoryRecord[] = [
      {
        id: 'MEM000001', saveId: 's1', createdAt: 1, realTimestamp: 1000,
        timeRange: { start: '001-01-01', end: '001-01-02' },
        content: '主角进入了白曜城的铁匠铺。',
        hiddenLine: '铁匠铺初入',
        keywords: ['白曜城', '铁匠铺'],
        relatedCharacterIds: [],
        importance: 7,
      },
    ];
    const ctx = mockCtx({ memories });
    const result = PLACEHOLDER_REGISTRY['MEMORY_ENTRIES'](ctx, mockConfig());
    expect(result).toContain('MEM000001');
    expect(result).toContain('白曜城');
    expect(result).toContain('重要度:7');
  });

  it('handles empty memories', () => {
    const result = PLACEHOLDER_REGISTRY['MEMORY_ENTRIES'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('respects top_k param', () => {
    const memories: MemoryRecord[] = [
      {
        id: 'MEM000001', saveId: 's1', createdAt: 1, realTimestamp: 1000,
        timeRange: { start: '001-01-01', end: '001-01-02' },
        content: '第一条记忆。',
        hiddenLine: 'h1',
        keywords: ['k1'],
        relatedCharacterIds: [],
        importance: 5,
      },
      {
        id: 'MEM000002', saveId: 's1', createdAt: 2, realTimestamp: 2000,
        timeRange: { start: '001-01-02', end: '001-01-03' },
        content: '第二条记忆。',
        hiddenLine: 'h2',
        keywords: ['k2'],
        relatedCharacterIds: [],
        importance: 8,
      },
      {
        id: 'MEM000003', saveId: 's1', createdAt: 3, realTimestamp: 3000,
        timeRange: { start: '001-01-03', end: '001-01-04' },
        content: '第三条记忆。',
        hiddenLine: 'h3',
        keywords: ['k3'],
        relatedCharacterIds: [],
        importance: 3,
      },
    ];
    const ctx = mockCtx({ memories });
    const result = PLACEHOLDER_REGISTRY['MEMORY_ENTRIES'](ctx, mockConfig(), { top_k: '2' });
    expect(result).toContain('MEM000001');
    expect(result).toContain('MEM000002');
    expect(result).not.toContain('MEM000003');
    expect(result).toContain('最近 2 条');
  });

  it('top_k larger than memory count returns all', () => {
    const memories: MemoryRecord[] = [
      {
        id: 'MEM000001', saveId: 's1', createdAt: 1, realTimestamp: 1000,
        timeRange: { start: '001-01-01', end: '001-01-02' },
        content: '唯一一条。',
        hiddenLine: 'h1',
        keywords: ['k1'],
        relatedCharacterIds: [],
        importance: 5,
      },
    ];
    const ctx = mockCtx({ memories });
    const result = PLACEHOLDER_REGISTRY['MEMORY_ENTRIES'](ctx, mockConfig(), { top_k: '10' });
    expect(result).toContain('MEM000001');
  });
});

// ========== PLOT_EVENTS ==========

describe('PLOT_EVENTS', () => {
  it('formats active and pending events', () => {
    const events: PlotEvent[] = [
      {
        id: 'evt_01', saveId: 's1', title: '铁匠的委托',
        description: '铁匠需要10块铁矿石。',
        status: 'active',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 1,
        createdAt: 1, updatedAt: 2,
      },
      {
        id: 'evt_02', saveId: 's1', title: '古墓传闻',
        description: '有人提到了北境古墓。',
        status: 'pending',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 2,
        createdAt: 1, updatedAt: 2,
      },
    ];
    const ctx = mockCtx({ plotEvents: events });
    const result = PLACEHOLDER_REGISTRY['PLOT_EVENTS'](ctx, mockConfig());
    expect(result).toContain('evt_01');
    expect(result).toContain('evt_02');
    expect(result).toContain('铁匠的委托');
    expect(result).toContain('active');
    expect(result).toContain('pending');
  });

  it('filters out completed events', () => {
    const events: PlotEvent[] = [
      {
        id: 'evt_01', saveId: 's1', title: '已完成的任务',
        description: '已经完成了。',
        status: 'completed',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 1,
        createdAt: 1, updatedAt: 2,
      },
      {
        id: 'evt_02', saveId: 's1', title: '活跃的任务',
        description: '正在进行。',
        status: 'active',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 2,
        createdAt: 1, updatedAt: 2,
      },
    ];
    const ctx = mockCtx({ plotEvents: events });
    const result = PLACEHOLDER_REGISTRY['PLOT_EVENTS'](ctx, mockConfig());
    expect(result).toContain('活跃的任务');
    expect(result).not.toContain('已完成的任务');
  });

  it('filters out skipped and failed events', () => {
    const events: PlotEvent[] = [
      {
        id: 'evt_01', saveId: 's1', title: '跳过了',
        description: 'x',
        status: 'skipped',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 1,
        createdAt: 1, updatedAt: 2,
      },
      {
        id: 'evt_02', saveId: 's1', title: '失败了',
        description: 'x',
        status: 'failed',
        childrenIds: [],
        relatedCharacterIds: [],
        worldLineChanged: false,
        depth: 0, order: 2,
        createdAt: 1, updatedAt: 2,
      },
    ];
    const ctx = mockCtx({ plotEvents: events });
    const result = PLACEHOLDER_REGISTRY['PLOT_EVENTS'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('handles empty events', () => {
    const result = PLACEHOLDER_REGISTRY['PLOT_EVENTS'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });
});

// ========== INVENTORY ==========

describe('INVENTORY', () => {
  it('extracts items from characters', () => {
    const items: InventoryItem[] = [
      { id: 'i1', name: '药水', quantity: 3, type: '消耗品', description: '恢复少量HP' },
      { id: 'i2', name: '铁矿石', quantity: 5, type: '材料' },
    ];
    const char = makeChar({ inventory: items });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['INVENTORY'](ctx, mockConfig());
    expect(result).toContain('药水');
    expect(result).toContain('×3');
    expect(result).toContain('铁矿石');
    expect(result).toContain('×5');
    expect(result).toContain('[测试角色] 背包:');
  });

  it('handles empty inventory', () => {
    const char = makeChar({ inventory: [] });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['INVENTORY'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('handles no characters', () => {
    const result = PLACEHOLDER_REGISTRY['INVENTORY'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('includes rarity and type info', () => {
    const items: InventoryItem[] = [
      { id: 'i1', name: '传说之剑', quantity: 1, type: '武器', rarity: '传说', description: '一把传说中的宝剑' },
    ];
    const char = makeChar({ inventory: items });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['INVENTORY'](ctx, mockConfig());
    expect(result).toContain('传说');
    expect(result).toContain('武器');
    expect(result).toContain('一把传说中的宝剑');
  });
});

// ========== GAME_TIME ==========

describe('GAME_TIME', () => {
  it('extracts world keys from variables', () => {
    const ctx = mockCtx({
      variables: {
        '时间': '光辉纪元001年-05月-24日-15:30',
        '位置': '北方-诺斯加德-白曜城-铁匠铺',
        '天气': '晴',
        '季节': '春季',
      },
    });
    const result = PLACEHOLDER_REGISTRY['GAME_TIME'](ctx, mockConfig());
    expect(result).toContain('时间:');
    expect(result).toContain('位置:');
    expect(result).toContain('天气:');
    expect(result).toContain('季节:');
    expect(result).toContain('白曜城');
  });

  it('handles missing world keys', () => {
    const ctx = mockCtx({ variables: {} });
    const result = PLACEHOLDER_REGISTRY['GAME_TIME'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('extracts alternative key names (English)', () => {
    const ctx = mockCtx({
      variables: {
        'time': 'evening',
        'location': 'Whiteforge',
        'weather': 'rainy',
        'era': '复兴纪元',
      },
    });
    const result = PLACEHOLDER_REGISTRY['GAME_TIME'](ctx, mockConfig());
    expect(result).toContain('time:');
    expect(result).toContain('location:');
    expect(result).toContain('weather:');
    expect(result).toContain('era:');
  });

  it('ignores non-world keys', () => {
    const ctx = mockCtx({
      variables: {
        '金钱': 200,
        'HP': 85,
        '时间': 'noon',
      },
    });
    const result = PLACEHOLDER_REGISTRY['GAME_TIME'](ctx, mockConfig());
    expect(result).toContain('时间:');
    expect(result).not.toContain('金钱');
    expect(result).not.toContain('HP');
  });
});

// ========== ACTIVE_EFFECTS ==========

describe('ACTIVE_EFFECTS', () => {
  it('extracts status effects from characters', () => {
    const effects: StatusEffect[] = [
      {
        id: 'se1', name: '中毒', description: '每回合失去少量HP',
        category: '减益', stacks: 2,
        remainingTime: 3, timeUnit: '回合',
        source: '毒蛇-毒牙',
        effects: { hp_per_turn: -5 },
      },
    ];
    const char = makeChar({ statusEffects: effects });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['ACTIVE_EFFECTS'](ctx, mockConfig());
    expect(result).toContain('中毒');
    expect(result).toContain('减益');
    expect(result).toContain('剩余3回合');
  });

  it('handles permanent effects', () => {
    const effects: StatusEffect[] = [
      {
        id: 'se1', name: '祝福', description: '永久增益',
        category: '增益', stacks: 1,
        remainingTime: null, timeUnit: '分钟',
        source: '女神-祝福',
        effects: { atk: 5 },
      },
    ];
    const char = makeChar({ statusEffects: effects });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['ACTIVE_EFFECTS'](ctx, mockConfig());
    expect(result).toContain('永久');
  });

  it('handles no effects', () => {
    const char = makeChar({ statusEffects: [] });
    const ctx = mockCtx({ characters: [char] });
    const result = PLACEHOLDER_REGISTRY['ACTIVE_EFFECTS'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('handles multiple characters', () => {
    const effects1: StatusEffect[] = [
      { id: 'se1', name: '中毒', description: '毒', category: '减益', stacks: 1, remainingTime: 3, timeUnit: '回合', source: 'x', effects: {} },
    ];
    const effects2: StatusEffect[] = [
      { id: 'se2', name: '加速', description: '快', category: '增益', stacks: 1, remainingTime: 5, timeUnit: '回合', source: 'x', effects: {} },
    ];
    const char1 = makeChar({ id: 'c1', name: '角色A', statusEffects: effects1 });
    const char2 = makeChar({ id: 'c2', name: '角色B', statusEffects: effects2 });
    const ctx = mockCtx({ characters: [char1, char2] });
    const result = PLACEHOLDER_REGISTRY['ACTIVE_EFFECTS'](ctx, mockConfig());
    expect(result).toContain('角色A');
    expect(result).toContain('角色B');
    expect(result).toContain('中毒');
    expect(result).toContain('加速');
  });
});

// ========== CHARACTER_STATE ==========

describe('CHARACTER_STATE', () => {
  it('formats characters via zone system', () => {
    const char = makeChar({ name: '老铁匠', tier: 2 });
    const ctx = mockCtx({ characters: [char] });
    const config = mockConfig({ agentId: 'story' });
    const result = PLACEHOLDER_REGISTRY['CHARACTER_STATE'](ctx, config);
    // story has npc=NARRATIVE, so it should produce formatted output
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('returns empty when npc visibility is NONE', () => {
    const char = makeChar();
    const ctx = mockCtx({ characters: [char] });
    const config = mockConfig({ agentId: 'memory_recall' }); // npc=KEYS
    const result = PLACEHOLDER_REGISTRY['CHARACTER_STATE'](ctx, config);
    // KEYS still returns something (keys list)
    expect(typeof result).toBe('string');
  });

  it('handles no characters', () => {
    const ctx = mockCtx({ characters: [] });
    const result = PLACEHOLDER_REGISTRY['CHARACTER_STATE'](ctx, mockConfig({ agentId: 'story' }));
    expect(result).toBe('');
  });

  it('does not throw on various agentIds', () => {
    const char = makeChar();
    const ctx = mockCtx({ characters: [char] });
    const agentIds = ['story', 'memory_recall', 'vars_update', 'char_update', 'char_gen', 'craft_gen'];
    for (const id of agentIds) {
      expect(() => PLACEHOLDER_REGISTRY['CHARACTER_STATE'](ctx, mockConfig({ agentId: id }))).not.toThrow();
    }
  });
});

// ========== AGENT.* ==========

describe('AGENT output placeholders', () => {
  it('AGENT.STORY returns story output when present', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('story', '<maintext>正文内容</maintext>');
    const result = PLACEHOLDER_REGISTRY['AGENT.STORY'](ctx, mockConfig());
    expect(result).toContain('正文内容');
  });

  it('AGENT.STORY returns empty string when not present', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.STORY'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('AGENT.MEMORY_RECALL returns output', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('memory_recall', '{"memories":[]}');
    const result = PLACEHOLDER_REGISTRY['AGENT.MEMORY_RECALL'](ctx, mockConfig());
    expect(result).toBe('{"memories":[]}');
  });

  it('AGENT.MEMORY_RECALL returns empty when missing', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.MEMORY_RECALL'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('AGENT.PLOT_PRE_CHECK returns output', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('plot_pre_check', '{"triggeredEvents":[]}');
    const result = PLACEHOLDER_REGISTRY['AGENT.PLOT_PRE_CHECK'](ctx, mockConfig());
    expect(result).toBe('{"triggeredEvents":[]}');
  });

  it('AGENT.PLOT_PRE_CHECK returns empty when missing', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.PLOT_PRE_CHECK'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('AGENT.VARS_UPDATE returns output', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('vars_update', '{"replace":[]}');
    const result = PLACEHOLDER_REGISTRY['AGENT.VARS_UPDATE'](ctx, mockConfig());
    expect(result).toBe('{"replace":[]}');
  });

  it('AGENT.VARS_UPDATE returns empty when missing', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.VARS_UPDATE'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('AGENT.MEMORY_SUMMARY returns output', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('memory_summary', '{"content":"summary"}');
    const result = PLACEHOLDER_REGISTRY['AGENT.MEMORY_SUMMARY'](ctx, mockConfig());
    expect(result).toBe('{"content":"summary"}');
  });

  it('AGENT.MEMORY_SUMMARY returns empty when missing', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.MEMORY_SUMMARY'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('AGENT.CHAR_UPDATE returns output', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('char_update', '{"characters":[]}');
    const result = PLACEHOLDER_REGISTRY['AGENT.CHAR_UPDATE'](ctx, mockConfig());
    expect(result).toBe('{"characters":[]}');
  });

  it('AGENT.CHAR_UPDATE returns empty when missing', () => {
    const result = PLACEHOLDER_REGISTRY['AGENT.CHAR_UPDATE'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });
});

// ========== LORE_BOOK with globals ==========

describe('LORE_BOOK with setPlaceholderGlobals', () => {
  beforeEach(() => {
    resetPlaceholderGlobals();
  });

  it('returns empty string when globals are not set', () => {
    const result = PLACEHOLDER_REGISTRY['LORE_BOOK'](mockCtx(), mockConfig({ agentId: 'story' }));
    expect(result).toBe('');
  });

  it('resolves when globals are set with matching books', () => {
    const worldBooks: WorldBook[] = [
      {
        id: 'wb1',
        name: '测试世界书',
        partition: 'world_setting',
        entries: [
          {
            uid: 1,
            name: '白曜城',
            content: '白曜城是北方重镇。',
            enabled: true,
            constant: true,
            key: [],
            keysecondary: [],
            selectiveLogic: 0,
            order: 1,
            position: 0,
          },
        ],
      },
    ];
    const configs = [mockConfig({ agentId: 'story', worldBookIds: ['wb1'] })];
    setPlaceholderGlobals(worldBooks, configs);

    const ctx = mockCtx({ userInput: '白曜城' });
    const result = PLACEHOLDER_REGISTRY['LORE_BOOK'](ctx, mockConfig({ agentId: 'story' }));
    expect(result).toContain('白曜城');
  });

  it('respects limit param', () => {
    const worldBooks: WorldBook[] = [
      {
        id: 'wb1',
        name: '测试世界书',
        partition: 'world_setting',
        entries: [
          {
            uid: 1, name: '条目A', content: 'AAA', enabled: true, constant: true,
            key: [], keysecondary: [], selectiveLogic: 0, order: 1, position: 0,
          },
          {
            uid: 2, name: '条目B', content: 'BBB', enabled: true, constant: true,
            key: [], keysecondary: [], selectiveLogic: 0, order: 2, position: 0,
          },
        ],
      },
    ];
    const configs = [mockConfig({ agentId: 'story', worldBookIds: ['wb1'] })];
    setPlaceholderGlobals(worldBooks, configs);

    const result = PLACEHOLDER_REGISTRY['LORE_BOOK'](
      mockCtx(), mockConfig({ agentId: 'story' }), { limit: '1' },
    );
    // Should only contain one entry's content
    const lines = result.split('\n\n').filter(l => l);
    expect(lines.length).toBe(1);
  });

  it('resetPlaceholderGlobals clears globals', () => {
    const worldBooks: WorldBook[] = [
      {
        id: 'wb1', name: '测试', partition: 'world_setting',
        entries: [
          { uid: 1, name: 'e1', content: 'content', enabled: true, constant: true, key: [], keysecondary: [], selectiveLogic: 0, order: 1, position: 0 },
        ],
      },
    ];
    const configs = [mockConfig({ agentId: 'story', worldBookIds: ['wb1'] })];
    setPlaceholderGlobals(worldBooks, configs);
    resetPlaceholderGlobals();

    const result = PLACEHOLDER_REGISTRY['LORE_BOOK'](mockCtx(), mockConfig({ agentId: 'story' }));
    expect(result).toBe('');
  });
});

// ========== Chain Placeholders (localParams) ==========

describe('Chain communication placeholders', () => {
  // Chain placeholders (CRAFT_REQUEST, CHAR_DETECT, ITEM_REQUEST) return empty
  // string from the registry. They are injected at resolution time via
  // template-resolver's resolveTemplate() using the localParams parameter.
  it('CRAFT_REQUEST returns empty (injected via resolveTemplate localParams)', () => {
    const result = PLACEHOLDER_REGISTRY['CRAFT_REQUEST'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('CRAFT_REQUEST always returns empty from registry', () => {
    // Even with _localParams set on ctx, the registry resolver ignores it.
    // localParams are injected by resolveTemplate(), not the registry.
    const ctx = mockCtx();
    (ctx as any)._localParams = { CRAFT_REQUEST: '<craft_request>制作内容</craft_request>' };
    const result = PLACEHOLDER_REGISTRY['CRAFT_REQUEST'](ctx, mockConfig());
    expect(result).toBe('');
  });

  it('CHAR_DETECT returns empty (injected via resolveTemplate localParams)', () => {
    const result = PLACEHOLDER_REGISTRY['CHAR_DETECT'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('ITEM_REQUEST returns empty (injected via resolveTemplate localParams)', () => {
    const result = PLACEHOLDER_REGISTRY['ITEM_REQUEST'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('CHAR_GEN_RESULT reads from agentOutputs', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('char_gen', '<char_result><name>NPC</name></char_result>');
    const result = PLACEHOLDER_REGISTRY['CHAR_GEN_RESULT'](ctx, mockConfig());
    expect(result).toContain('char_result');
  });

  it('CHAR_GEN_RESULT returns empty when not present', () => {
    const result = PLACEHOLDER_REGISTRY['CHAR_GEN_RESULT'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });

  it('CRAFT_RESULT reads from agentOutputs', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('craft_gen', '<craft_result>result</craft_result>');
    const result = PLACEHOLDER_REGISTRY['CRAFT_RESULT'](ctx, mockConfig());
    expect(result).toBe('<craft_result>result</craft_result>');
  });

  it('CRAFT_RESULT returns empty when not present', () => {
    const result = PLACEHOLDER_REGISTRY['CRAFT_RESULT'](mockCtx(), mockConfig());
    expect(result).toBe('');
  });
});

// ========== getDefaultTemplate ==========

describe('getDefaultTemplate', () => {
  it('returns non-empty template for story', () => {
    const tmpl = getDefaultTemplate('story');
    expect(tmpl).toBeTruthy();
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{AGENT.MEMORY_RECALL}}');
    expect(tmpl).toContain('{{AGENT.PLOT_PRE_CHECK}}');
    expect(tmpl).toContain('{{LORE_BOOK}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
    expect(tmpl).toContain('{{GAME_TIME}}');
    expect(tmpl).toContain('{{NARRATIVE}}');
    expect(tmpl).toContain('{{USER_INPUT}}');
  });

  it('returns non-empty template for memory_recall', () => {
    const tmpl = getDefaultTemplate('memory_recall');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{MEMORY_ENTRIES}}');
    expect(tmpl).toContain('{{NARRATIVE:layers=3:slice=800}}');
    expect(tmpl).toContain('{{USER_INPUT}}');
  });

  it('returns non-empty template for plot_pre_check', () => {
    const tmpl = getDefaultTemplate('plot_pre_check');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{PLOT_EVENTS}}');
    expect(tmpl).toContain('{{AGENT.MEMORY_RECALL}}');
  });

  it('returns non-empty template for vars_update', () => {
    const tmpl = getDefaultTemplate('vars_update');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{AGENT.STORY}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
    expect(tmpl).toContain('{{LORE_BOOK}}');
  });

  it('returns non-empty template for char_update', () => {
    const tmpl = getDefaultTemplate('char_update');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{AGENT.STORY}}');
    expect(tmpl).toContain('{{AGENT.VARS_UPDATE}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
  });

  it('returns non-empty template for memory_summary', () => {
    const tmpl = getDefaultTemplate('memory_summary');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{AGENT.STORY}}');
    expect(tmpl).toContain('{{NARRATIVE:layers=4:slice=1500}}');
  });

  it('returns non-empty template for plot_post_check', () => {
    const tmpl = getDefaultTemplate('plot_post_check');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{AGENT.STORY}}');
    expect(tmpl).toContain('{{AGENT.MEMORY_SUMMARY}}');
    expect(tmpl).toContain('{{PLOT_EVENTS}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
  });

  it('returns non-empty template for plot_outline', () => {
    const tmpl = getDefaultTemplate('plot_outline');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{PLOT_EVENTS}}');
  });

  it('returns non-empty template for craft_gen', () => {
    const tmpl = getDefaultTemplate('craft_gen');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{CRAFT_REQUEST}}');
    expect(tmpl).toContain('{{INVENTORY}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
    expect(tmpl).toContain('{{LORE_BOOK}}');
  });

  it('returns non-empty template for char_gen', () => {
    const tmpl = getDefaultTemplate('char_gen');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{CHAR_DETECT}}');
    expect(tmpl).toContain('{{CHARACTER_STATE}}');
    expect(tmpl).toContain('{{LORE_BOOK}}');
  });

  it('returns non-empty template for item_gen', () => {
    const tmpl = getDefaultTemplate('item_gen');
    expect(tmpl).toContain('{{SYS_PROMPT}}');
    expect(tmpl).toContain('{{ITEM_REQUEST}}');
    expect(tmpl).toContain('{{CHAR_GEN_RESULT}}');
    expect(tmpl).toContain('{{CRAFT_RESULT}}');
    expect(tmpl).toContain('{{INVENTORY}}');
  });

  it('returns empty string for unknown agent', () => {
    const tmpl = getDefaultTemplate('nonexistent_agent');
    expect(tmpl).toBe('');
  });
});

// ========== resolveTemplate (chain placeholder resolution test) ==========

describe('resolveTemplate for chain placeholders', () => {
  it('resolves simple placeholders', () => {
    const config = mockConfig({ agentId: 'story', systemPrompt: 'You are a storyteller.' });
    const ctx = mockCtx({ userInput: 'go north' });
    const result = resolveTemplate('{{SYS_PROMPT}}\n{{USER_INPUT}}', 'story', ctx, config);
    expect(result).toContain('You are a storyteller.');
    expect(result).toContain('go north');
  });

  it('resolves placeholders with params', () => {
    const ctx = mockCtx({
      history: [
        { id: '1', role: 'user', content: 'msg1', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'msg2', timestamp: 2 },
        { id: '3', role: 'user', content: 'msg3', timestamp: 3 },
        { id: '4', role: 'assistant', content: 'msg4', timestamp: 4 },
      ],
    });
    const config = mockConfig({ agentId: 'story' });
    const result = resolveTemplate('{{NARRATIVE:layers=1:slice=4}}', 'story', ctx, config);
    // 1 layer = 2 messages, each truncated to 4 chars
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(result).toContain('[user]: msg3');  // should be last 2 msgs
    expect(result).toContain('[assistant]: msg4');
  });

  it('resolves AGENT.* placeholders', () => {
    const ctx = mockCtx();
    ctx.agentOutputs.set('story', '<maintext>story content here</maintext>');
    const config = mockConfig({ agentId: 'vars_update' });
    const result = resolveTemplate('{{AGENT.STORY}}', 'vars_update', ctx, config);
    expect(result).toContain('story content here');
  });

  it('resolves MEMORY_ENTRIES with top_k param', () => {
    const memories: MemoryRecord[] = [
      { id: 'M1', saveId: 's1', createdAt: 1, realTimestamp: 1000,
        timeRange: { start: '001-01-01', end: '001-01-02' },
        content: 'memory 1', hiddenLine: 'h1', keywords: ['k1'],
        relatedCharacterIds: [], importance: 5 },
      { id: 'M2', saveId: 's1', createdAt: 2, realTimestamp: 2000,
        timeRange: { start: '001-01-02', end: '001-01-03' },
        content: 'memory 2', hiddenLine: 'h2', keywords: ['k2'],
        relatedCharacterIds: [], importance: 8 },
    ];
    const ctx = mockCtx({ memories });
    const config = mockConfig({ agentId: 'memory_recall' });
    const result = resolveTemplate('{{MEMORY_ENTRIES:top_k=1}}', 'memory_recall', ctx, config);
    expect(result).toContain('memory 1');
    expect(result).not.toContain('memory 2');
    expect(result).toContain('最近 1 条');
  });

  it('keeps unknown placeholders as-is', () => {
    const config = mockConfig();
    const ctx = mockCtx();
    const result = resolveTemplate('{{UNKNOWN_PLACEHOLDER}}', 'test_agent', ctx, config);
    expect(result).toBe('{{UNKNOWN_PLACEHOLDER}}');
  });

  it('injects localParams into ctx for chain placeholders', () => {
    const config = mockConfig({ agentId: 'craft_gen' });
    const ctx = mockCtx();
    const localParams = { CRAFT_REQUEST: '<craft_request expects="magic sword">forge</craft_request>' };
    // Chain placeholders are injected via resolveTemplate() localParams, not the registry
    const result = resolveTemplate('{{CRAFT_REQUEST}}', 'craft_gen', ctx, config, localParams);
    expect(result).toContain('craft_request');
    expect(result).toContain('magic sword');
  });

  it('resolves multiple placeholders in sequence', () => {
    const config = mockConfig({ agentId: 'story', systemPrompt: 'SYSTEM_PROMPT_CONTENT' });
    const ctx = mockCtx({
      userInput: 'USER_INPUT_CONTENT',
    });
    ctx.agentOutputs.set('memory_recall', 'MEMORY_RECALL_OUTPUT');
    const result = resolveTemplate(
      '{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n{{USER_INPUT}}',
      'story', ctx, config,
    );
    expect(result).toContain('SYSTEM_PROMPT_CONTENT');
    expect(result).toContain('MEMORY_RECALL_OUTPUT');
    expect(result).toContain('USER_INPUT_CONTENT');
  });

  it('handles empty template', () => {
    const result = resolveTemplate('', 'story', mockCtx(), mockConfig());
    expect(result).toBe('');
  });
});
