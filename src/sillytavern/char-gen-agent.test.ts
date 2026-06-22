/**
 * char-gen-agent.test.ts — 角色生成编排模块测试
 *
 * Phase 6e: 测试 detectNewCharacters / assembleCharacterState / buildCharGenPatches /
 * callCharGenAgent / callItemGenAgent / runCharGenChain / $chargen
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectNewCharacters,
  assembleCharacterState,
  buildCharGenPatches,
  callCharGenAgent,
  callItemGenAgent,
  runCharGenChain,
  $chargen,
} from './char-gen-agent';
import type {
  CharGenRequest,
  CharGenAgentDeps,
  CharGenClient,
} from './char-gen-agent';
import type {
  CharDetectMarker,
  CharGenOutput,
  ItemGenOutput,
  CharacterState,
  ApiEndpoint,
  AgentContext,
} from './types';

// ========== Factory Helpers ==========

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'ep-test',
    name: 'Test Endpoint',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat'],
    timeout: 60000,
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: 'test input',
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

function makeCharDetect(overrides: Partial<CharDetectMarker> = {}): CharDetectMarker {
  return {
    type: 'char_detect',
    rawContent: '<char_detect characterName="测试角色">测试描述</char_detect>',
    position: 0,
    characterName: '测试角色',
    characterType: 'npc',
    bodyText: '测试描述',
    ...overrides,
  };
}

function makeCharGenOutput(overrides: Partial<CharGenOutput> = {}): CharGenOutput {
  return {
    name: '艾琳',
    race: '精灵',
    tier: 2,
    level: 8,
    attributes: { str: 4, dex: 10, con: 5, int: 7, spi: 8 },
    identity: ['巡林者'],
    occupation: ['弓箭手'],
    background: '精灵巡林者背景故事',
    appearance: '银发精灵外貌',
    personality: '冷静果断',
    ascension: { enabled: false, path: '', description: '' },
    ...overrides,
  };
}

function makeItemGenOutput(overrides: Partial<ItemGenOutput> = {}): ItemGenOutput {
  return {
    skills: [
      {
        name: '精准射击',
        description: '精准瞄准，命中率+20%',
        type: 'active',
        cost: { type: 'SP', amount: 15 },
        cooldown: 3,
      },
    ],
    equipment: [
      {
        slot: '武器',
        name: '精灵长弓',
        description: '轻量化长弓',
        stats: { 攻击力: 18, 敏捷: 2 },
        durability: 120,
        quality: '优良',
      },
    ],
    inventory: [
      {
        name: '猎人箭袋',
        description: '装有30支箭矢',
        quantity: 1,
        type: '消耗品',
        rarity: '普通',
      },
    ],
    ...overrides,
  };
}

function makeMockClient(
  response: string | object,
  overrides: Partial<CharGenClient> = {},
): CharGenClient {
  const rawResponse = typeof response === 'string' ? response : JSON.stringify(response);
  return {
    chat: vi.fn().mockResolvedValue({
      output: typeof response === 'string' ? response : JSON.stringify(response),
      rawResponse,
      tokensUsed: 500,
      cacheHit: false,
      duration: 1000,
    }),
    ...overrides,
  };
}

function makeDeps(mockClient: CharGenClient): CharGenAgentDeps {
  return {
    clientFactory: () => mockClient,
  };
}

function makeRequest(overrides: Partial<CharGenRequest> = {}): CharGenRequest {
  return {
    saveId: 'save-test',
    detection: makeCharDetect(),
    context: makeContext(),
    endpoint: makeEndpoint(),
    ...overrides,
  };
}

// ========== detectNewCharacters ==========

describe('detectNewCharacters', () => {
  it('无标记时应返回空数组', () => {
    const result = detectNewCharacters('普通正文无标记', []);
    expect(result).toHaveLength(0);
  });

  it('应检测单个 char_detect 标记', () => {
    const text = '<char_detect characterName="小明">一个新角色</char_detect>';
    const result = detectNewCharacters(text, []);
    expect(result).toHaveLength(1);
    expect(result[0].characterName).toBe('小明');
  });

  it('应检测多个 char_detect 标记', () => {
    const text =
      '<char_detect characterName="小明">角色A</char_detect>正文<char_detect characterName="小红">角色B</char_detect>';
    const result = detectNewCharacters(text, []);
    expect(result).toHaveLength(2);
  });

  it('应过滤已存在的角色名 (大小写不敏感)', () => {
    const existingChars = [
      { name: '小明', type: 'npc' } as CharacterState,
    ];
    const text = '<char_detect characterName="小明">已存在</char_detect><char_detect characterName="小红">新角色</char_detect>';
    const result = detectNewCharacters(text, existingChars);
    expect(result).toHaveLength(1);
    expect(result[0].characterName).toBe('小红');
  });

  it('没有名字的 char_detect 不应被过滤 (需要 AI 生成名字)', () => {
    const existingChars = [
      { name: '路人甲', type: 'npc' } as CharacterState,
    ];
    const text = '<char_detect>无名角色</char_detect>';
    const result = detectNewCharacters(text, existingChars);
    expect(result).toHaveLength(1);
    expect(result[0].characterName).toBeUndefined();
  });

  it('所有角色都已存在时应返回空数组', () => {
    const existingChars = [
      { name: '小明', type: 'npc' },
      { name: '小红', type: 'npc' },
    ] as CharacterState[];
    const text = '<char_detect characterName="小明">A</char_detect><char_detect characterName="小红">B</char_detect>';
    const result = detectNewCharacters(text, existingChars);
    expect(result).toHaveLength(0);
  });

  it('空字符串应返回空数组', () => {
    expect(detectNewCharacters('', [])).toHaveLength(0);
  });
});

// ========== assembleCharacterState ==========

describe('assembleCharacterState', () => {
  it('应生成有效的 CharacterState', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput();
    const result = assembleCharacterState(charData, itemData);

    expect(result.name).toBe('艾琳');
    expect(result.race).toBe('精灵');
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe('中坚');
    expect(result.level).toBe(8);
    expect(result.type).toBe('npc');
  });

  it('应正确合并五维属性', () => {
    const charData = makeCharGenOutput({
      attributes: { str: 5, dex: 12, con: 6, int: 8, spi: 9 },
    });
    const result = assembleCharacterState(charData, makeItemGenOutput());

    expect(result.attributes.str).toBe(5);
    expect(result.attributes.dex).toBe(12);
    expect(result.attributes.con).toBe(6);
    expect(result.attributes.int).toBe(8);
    expect(result.attributes.spi).toBe(9);
  });

  it('T1 角色 tierName 应为"普通"', () => {
    const charData = makeCharGenOutput({ tier: 1, level: 3 });
    const result = assembleCharacterState(charData, makeItemGenOutput());
    expect(result.tierName).toBe('普通');
    expect(result.tier).toBe(1);
  });

  it('应合并技能列表', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      skills: [
        { name: '技能A', description: '描述A', type: 'active' },
        { name: '技能B', description: '描述B', type: 'passive' },
      ],
    });
    const result = assembleCharacterState(charData, itemData);
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].name).toBe('技能A');
    expect(result.skills[1].name).toBe('技能B');
  });

  it('应合并装备列表', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      equipment: [
        { slot: '武器', name: '测试剑', description: 'A test sword', stats: { 攻击力: 10 } },
      ],
    });
    const result = assembleCharacterState(charData, itemData);
    expect(result.equipment).toHaveLength(1);
    expect(result.equipment[0].slot).toBe('武器');
  });

  it('应合并背包物品', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      inventory: [
        { name: '药水', description: '回复药水', quantity: 5, type: '消耗品' },
      ],
    });
    const result = assembleCharacterState(charData, itemData);
    expect(result.inventory).toHaveLength(1);
    expect(result.inventory[0].name).toBe('药水');
    expect(result.inventory[0].quantity).toBe(5);
  });

  it('应处理空物品数据', () => {
    const charData = makeCharGenOutput();
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    expect(result.skills).toHaveLength(0);
    expect(result.equipment).toHaveLength(0);
    expect(result.inventory).toHaveLength(0);
  });

  it('应存储背景/外貌/性格到 customFields', () => {
    const charData = makeCharGenOutput({
      background: '测试背景故事',
      appearance: '测试外貌',
      personality: '测试性格',
    });
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    expect(result.customFields.background).toBe('测试背景故事');
    expect(result.customFields.appearance).toBe('测试外貌');
    expect(result.customFields.personality).toBe('测试性格');
  });

  it('应处理登神长阶', () => {
    const charData = makeCharGenOutput({
      tier: 5,
      level: 15,
      ascension: { enabled: true, path: '火焰之道', description: '掌控火之要素' },
    });
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    expect(result.ascension.enabled).toBe(true);
    expect(result.customFields.ascensionPath).toBe('火焰之道');
  });

  it('应支持 overrides 参数', () => {
    const charData = makeCharGenOutput();
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] }, {
      id: 'custom-id',
      location: '白曜城',
    });
    expect(result.id).toBe('custom-id');
    expect(result.location).toBe('白曜城');
  });

  it('高层级角色应有更高的 HP（体质×层级乘数）', () => {
    const charData = makeCharGenOutput({ tier: 5, level: 15, attributes: { str: 8, dex: 8, con: 10, int: 8, spi: 8 } });
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    // T5: hpMultiplier=20, mpMultiplier=35, spMultiplier=35
    // con=10 → 20*10=200, int=8 → 35*8=280, spi=8 → 35*8=280
    expect(result.maxHp).toBe(200);
    expect(result.maxMp).toBe(280);
    expect(result.maxSp).toBe(280);
  });
});

// ========== buildCharGenPatches ==========

describe('buildCharGenPatches', () => {
  it('应生成 add_character patch', () => {
    const charData = makeCharGenOutput();
    const character = assembleCharacterState(charData, makeItemGenOutput());
    const patches = buildCharGenPatches(character);

    const addCharPatch = patches.find((p) => p.op === 'add_character');
    expect(addCharPatch).toBeDefined();
    if (addCharPatch) {
      expect(addCharPatch.target).toBe(`characters.${character.id}`);
      expect(addCharPatch.metadata?.source).toBe('char_gen');
    }
  });

  it('应生成 add_skill patches', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      skills: [
        { name: '技能1', description: 'D1', type: 'active' },
        { name: '技能2', description: 'D2', type: 'passive' },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    const skillPatches = patches.filter((p) => p.op === 'add_skill');
    expect(skillPatches).toHaveLength(2);
    expect(skillPatches[0].metadata?.source).toBe('item_gen');
  });

  it('应生成 add_item patches', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      inventory: [
        { name: '物品A', description: 'DA', quantity: 1, type: '消耗品' },
        { name: '物品B', description: 'DB', quantity: 3, type: '材料' },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    const itemPatches = patches.filter((p) => p.op === 'add_item');
    expect(itemPatches).toHaveLength(2);
  });

  it('应生成 equip_item patches', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      equipment: [
        { slot: '武器', name: '剑', description: 'D', stats: { 攻击力: 10 } },
        { slot: '护甲', name: '甲', description: 'D', stats: { 防御力: 5 } },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    const equipPatches = patches.filter((p) => p.op === 'equip_item');
    expect(equipPatches).toHaveLength(2);
  });

  it('空物品数据时应只有 add_character patch', () => {
    const charData = makeCharGenOutput();
    const character = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    const patches = buildCharGenPatches(character);
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_character');
  });
});

// ========== callCharGenAgent (with mock) ==========

describe('callCharGenAgent', () => {
  it('应成功调用并返回 CharGenOutput', async () => {
    const mockClient = makeMockClient(makeCharGenOutput());
    const deps = makeDeps(mockClient);
    const request = makeRequest();

    const result = await callCharGenAgent(request, deps);

    expect(result.name).toBe('艾琳');
    expect(result.race).toBe('精灵');
    expect(result.attributes.str).toBe(4);
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
  });

  it('API 返回错误时应抛出异常', async () => {
    const mockClient: CharGenClient = {
      chat: vi.fn().mockResolvedValue({
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 100,
        error: 'Network error',
      }),
    };
    const deps = makeDeps(mockClient);

    await expect(callCharGenAgent(makeRequest(), deps)).rejects.toThrow('char_gen Agent 调用失败');
  });

  it('应处理 markdown 代码块包裹的 JSON', async () => {
    const rawResponse = '```json\n' + JSON.stringify(makeCharGenOutput()) + '\n```';
    const mockClient = makeMockClient(rawResponse);
    const deps = makeDeps(mockClient);

    const result = await callCharGenAgent(makeRequest(), deps);
    expect(result.name).toBe('艾琳');
  });

  it('应处理 markdown 代码块 (无 json 标记)', async () => {
    const rawResponse = '```\n' + JSON.stringify(makeCharGenOutput()) + '\n```';
    const mockClient = makeMockClient(rawResponse);
    const deps = makeDeps(mockClient);

    const result = await callCharGenAgent(makeRequest(), deps);
    expect(result.name).toBe('艾琳');
  });
});

// ========== callItemGenAgent (with mock) ==========

describe('callItemGenAgent', () => {
  it('应成功调用并返回 ItemGenOutput', async () => {
    const mockClient = makeMockClient(makeItemGenOutput());
    const deps = makeDeps(mockClient);
    const request = makeRequest();

    const result = await callItemGenAgent(makeCharGenOutput(), request, deps);

    expect(result.skills).toHaveLength(1);
    expect(result.equipment).toHaveLength(1);
    expect(result.inventory).toHaveLength(1);
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
  });

  it('API 错误时应返回空物品数据 (不阻断流程)', async () => {
    const mockClient: CharGenClient = {
      chat: vi.fn().mockResolvedValue({
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 100,
        error: 'Timeout',
      }),
    };
    const deps = makeDeps(mockClient);

    const result = await callItemGenAgent(makeCharGenOutput(), makeRequest(), deps);
    expect(result.skills).toHaveLength(0);
    expect(result.equipment).toHaveLength(0);
    expect(result.inventory).toHaveLength(0);
  });
});

// ========== runCharGenChain (integration) ==========

describe('runCharGenChain', () => {
  it('应运行完整的角色生成链', async () => {
    // 使用两个不同的 mock client (char_gen → item_gen)
    const charClient = makeMockClient(makeCharGenOutput());
    const itemClient = makeMockClient(makeItemGenOutput());
    const clientMap: Record<string, CharGenClient> = {
      char_gen: charClient,
      item_gen: itemClient,
    };

    const deps: CharGenAgentDeps = {
      clientFactory: (agentId: string) => clientMap[agentId],
    };

    const request = makeRequest();
    const result = await runCharGenChain(request, deps);

    expect(result.character).toBeDefined();
    expect(result.character.name).toBe('艾琳');
    expect(result.patches).toBeDefined();
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.narrativeSummary).toContain('艾琳');
    expect(charClient.chat).toHaveBeenCalledTimes(1);
    expect(itemClient.chat).toHaveBeenCalledTimes(1);
  });

  it('应可选地调用 stateManager.commitChatState', async () => {
    const charClient = makeMockClient(makeCharGenOutput());
    const itemClient = makeMockClient(makeItemGenOutput());
    const commitChatState = vi.fn().mockResolvedValue(undefined);

    const deps: CharGenAgentDeps = {
      clientFactory: (agentId: string) => agentId === 'char_gen' ? charClient : itemClient,
      stateManager: { commitChatState },
    };

    const result = await runCharGenChain(makeRequest(), deps);
    expect(commitChatState).toHaveBeenCalledTimes(1);
    expect(commitChatState).toHaveBeenCalledWith(result.patches);
  });

  it('无 stateManager 时不应报错', async () => {
    const charClient = makeMockClient(makeCharGenOutput());
    const itemClient = makeMockClient(makeItemGenOutput());

    const deps: CharGenAgentDeps = {
      clientFactory: (agentId: string) => agentId === 'char_gen' ? charClient : itemClient,
      // 不提供 stateManager
    };

    const result = await runCharGenChain(makeRequest(), deps);
    expect(result.character).toBeDefined();
  });
});

// ========== $chargen API ==========

describe('$chargen', () => {
  it('应暴露 detect 方法', () => {
    expect($chargen.detect).toBe(detectNewCharacters);
  });

  it('应暴露 generate 方法', () => {
    expect($chargen.generate).toBe(runCharGenChain);
  });

  it('应暴露 assemble 方法', () => {
    expect($chargen.assemble).toBe(assembleCharacterState);
  });
});
