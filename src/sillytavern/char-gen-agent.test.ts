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
  ToolDefinition,
} from './types';
import { executeToolCall } from './agent-tools';

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
    gender: '女',
    tier: 2,
    level: 8,
    attributes: { str: 4, dex: 10, con: 5, int: 7, spi: 8 },
    identity: ['巡林者'],
    occupation: ['弓箭手'],
    background: '精灵巡林者背景故事',
    appearance: '银发精灵外貌',
    clothing: '绿色斗篷与皮甲',
    personality: '冷静果断',
    likes: '森林、弓箭',
    skills: [],
    equipment: [],
    inventory: [],
    ascension: {
      enabled: false, path: '', description: '',
      elements: [], authorities: [], laws: [],
      deityPosition: '', divineKingdom: { name: '', description: '' },
    },
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
    // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）
    const equipped = result.inventory.filter(i => i.equippedSlot);
    expect(equipped).toHaveLength(1);
    expect(equipped[0].equippedSlot).toBe('武器');
  });

  it('应合并背包物品', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      inventory: [
        { name: '药水', description: '回复药水', quantity: 5, type: '消耗品' },
      ],
    });
    const result = assembleCharacterState(charData, itemData);
    // M2: 装备也是物品 — 默认 itemData 的 精灵长弓 以 equippedSlot 非空形式并入 inventory（规范 §3）
    const looseItems = result.inventory.filter(i => !i.equippedSlot);
    expect(looseItems).toHaveLength(1);
    expect(looseItems[0].name).toBe('药水');
    expect(looseItems[0].quantity).toBe(5);
  });

  it('应处理空物品数据', () => {
    const charData = makeCharGenOutput();
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    expect(result.skills).toHaveLength(0);
    // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）
    expect(result.inventory.filter(i => i.equippedSlot)).toHaveLength(0);
    expect(result.inventory).toHaveLength(0);
  });

  it('应存储背景/外貌/性格到正式字段（非customFields）', () => {
    const charData = makeCharGenOutput({
      background: '测试背景故事',
      appearance: '测试外貌',
      personality: '测试性格',
    });
    const result = assembleCharacterState(charData, { skills: [], equipment: [], inventory: [] });
    // M3: 这些是正式字段，不在 customFields
    expect(result.background).toBe('测试背景故事');
    expect(result.appearance).toBe('测试外貌');
    expect(result.personality).toBe('测试性格');
    expect(result.customFields.background).toBeUndefined();
    expect(result.customFields.appearance).toBeUndefined();
    expect(result.customFields.personality).toBeUndefined();
  });

  it('应处理登神长阶', () => {
    const charData = makeCharGenOutput({
      tier: 5,
      level: 15,
      ascension: {
        enabled: true, path: '火焰之道', description: '掌控火之要素',
        elements: [], authorities: [], laws: [],
        deityPosition: '', divineKingdom: { name: '', description: '' },
      },
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
      expect(addCharPatch.target).toBe(`characters.${character.name}`);
      expect(addCharPatch.metadata?.source).toBe('char_gen');
    }
  });

  it('M3: 应无独立 add_skill patch（技能嵌入 add_character value）', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      skills: [
        { name: '技能1', description: 'D1', type: 'active' },
        { name: '技能2', description: 'D2', type: 'passive' },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    // M3: 所有数据内嵌在 add_character value，无独立 add_skill patch
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_character');
    const addCharPatch = patches[0];
    expect(addCharPatch.value.skills).toHaveLength(2);
    expect(addCharPatch.value.skills[0].name).toBe('技能1');
    expect(addCharPatch.value.skills[1].name).toBe('技能2');
  });

  it('M3: 应无独立 add_item patch（物品嵌入 add_character value）', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      inventory: [
        { name: '物品A', description: 'DA', quantity: 1, type: '消耗品' },
        { name: '物品B', description: 'DB', quantity: 3, type: '材料' },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    // M3: 所有数据内嵌在 add_character value，无独立 add_item patch
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_character');
    const addCharPatch = patches[0];
    // 背包物品 + 默认装备 都并入 inventory
    const looseItems = addCharPatch.value.inventory.filter((i: any) => !i.equippedSlot);
    expect(looseItems.length).toBeGreaterThanOrEqual(2);
  });

  it('M3: 应无独立 equip_item patch（装备嵌入 add_character value）', () => {
    const charData = makeCharGenOutput();
    const itemData = makeItemGenOutput({
      equipment: [
        { slot: '武器', name: '剑', description: 'D', stats: { 攻击力: 10 } },
        { slot: '护甲', name: '甲', description: 'D', stats: { 防御力: 5 } },
      ],
    });
    const character = assembleCharacterState(charData, itemData);
    const patches = buildCharGenPatches(character);

    // M3: 所有数据内嵌在 add_character value，无独立 equip_item patch
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_character');
    const addCharPatch = patches[0];
    const equipped = addCharPatch.value.inventory.filter((i: any) => i.equippedSlot);
    expect(equipped.length).toBeGreaterThanOrEqual(2);
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

// ═══════════════════════════════════════════════════════════════
// 🆕 Phase 8.5 Agentic 路径测试 (function calling 多轮循环)
// ═══════════════════════════════════════════════════════════════

// ── Test helpers ──

/**
 * 测试专用的工具执行器。
 * - 纯函数工具（dice/random/attributes）→ 调真实 executeToolCall()
 * - 需要 character context 的工具 → 空 context 自然降级
 * - get_inventory 需要 characterId，空 context 会 throw → catch 降级
 */
async function executeToolCallForTest(functionName: string, args: Record<string, any>): Promise<any> {
  // get_inventory 需要 characterId → 空 context 找不到角色会抛错 → 降级
  if (functionName === 'get_inventory') {
    return {
      _test_mode: true,
      itemCount: 0,
      items: [],
      hint: '测试环境无背包数据，请根据角色背景自行设计物品',
    };
  }

  // get_character 不传 characterId → 返回空字符列表（天然降级语义）
  // 其余所有工具（roll_d20, random_name, roll_attributes, etc.）→ 纯函数，context 不读取
  return executeToolCall(functionName, args, {
    characters: [],
    variables: {},
    saveId: 'test-save',
  });
}

interface ToolCallStep {
  /** 本轮 AI 要调的工具 */
  calls: Array<{ name: string; args: Record<string, any> }>;
}

/**
 * 构造模拟多轮 Agentic 循环的 CharGenClient。
 *
 * 工作方式:
 * - toolCallSequence: 每轮模拟 AI "调了哪些工具"（按顺序执行并向 conversation 回注结果）
 * - finalOutput: 所有工具调用完成后返回的最终输出
 * - 工具执行使用 executeToolCallForTest（纯函数→真实 / context→降级）
 */
function makeAgenticMockClient(
  toolCallSequence: ToolCallStep[],
  finalOutput: string,
): CharGenClient {
  return {
    chat: vi.fn().mockResolvedValue({
      output: 'mock chat response',
      rawResponse: 'mock chat response',
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
    }),
    chatWithTools: vi.fn().mockImplementation(
      async (request, toolExecutor, _options) => {
        const conversation = [...request.messages];

        for (const step of toolCallSequence) {
          // 注入 assistant 消息（含 tool_calls）
          const toolCalls = step.calls.map((c) => ({
            id: `call_${c.name}_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args),
            },
          }));

          conversation.push({
            role: 'assistant',
            content: `Calling ${step.calls.map((c) => c.name).join(', ')}...`,
            tool_calls: toolCalls,
          } as any);

          // 逐个执行工具并回注 tool 消息
          for (const c of step.calls) {
            const result = await toolExecutor(c.name, c.args);
            conversation.push({
              role: 'tool',
              tool_call_id: `call_${c.name}`,
              name: c.name,
              content: JSON.stringify(result),
            } as any);
          }
        }

        return {
          output: finalOutput,
          rawResponse: finalOutput,
          tokensUsed: 500,
          cacheHit: false,
          duration: 1000,
        };
      },
    ),
  };
}

// ── Agentic callCharGenAgent 测试 ──

describe('callCharGenAgent (Agentic 路径)', () => {
  it('应通过多轮工具调用生成角色', async () => {
    const mockClient = makeAgenticMockClient(
      [
        // 第 1 轮: 调查重 + 随机名
        {
          calls: [
            { name: 'get_character', args: {} },
            { name: 'random_name', args: { race: '精灵', gender: '女' } },
          ],
        },
        // 第 2 轮: 调属性骰 + 性格
        {
          calls: [
            { name: 'roll_attributes', args: { tier: 2, level: 8 } },
            { name: 'random_personality', args: {} },
          ],
        },
      ],
      // 最终输出 (模拟 AI 看到工具结果后生成的 XML)
      `<char_result>
<name>艾琳</name>
<race>精灵</race>
<tier>2</tier>
<level>8</level>
<attributes str="4" dex="10" con="5" int="7" spi="8"/>
<identity>巡林者</identity>
<occupation>弓箭手</occupation>
<background>精灵巡林者背景故事</background>
<appearance>银发精灵外貌描述</appearance>
<personality code="wOaGz(A)">冷静果断的性格描述</personality>
<ascension enabled="false" path="" description=""/>
</char_result>`,
    );

    const deps = makeDeps(mockClient);
    const result = await callCharGenAgent(makeRequest(), deps);

    expect(result.name).toBe('艾琳');
    expect(result.race).toBe('精灵');
    expect(result.tier).toBe(2);
    expect(result.attributes.str).toBe(4);
    expect(mockClient.chatWithTools).toHaveBeenCalledTimes(1);
  });

  it('get_character 空 context 应返回空角色列表（自然降级）', async () => {
    const result = await executeToolCallForTest('get_character', {});
    // 不传 characterId → 返回所有角色列表（空数组）
    expect(result.characters).toBeDefined();
    expect(result.characters).toEqual([]);
  });

  it('get_inventory 空 context 应返回测试降级提示', async () => {
    const result = await executeToolCallForTest('get_inventory', { characterId: 'nonexistent' });
    expect(result._test_mode).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.hint).toBeDefined();
  });

  it('纯函数工具应返回真实数据', async () => {
    const diceResult = await executeToolCallForTest('roll_d20', { modifier: 0, reason: 'test' });
    expect(diceResult.total).toBeGreaterThanOrEqual(1);
    expect(diceResult.total).toBeLessThanOrEqual(20);
    expect(diceResult.formula).toBeDefined();

    const nameResult = await executeToolCallForTest('random_name', { race: '人类', gender: '女' });
    expect(nameResult.name).toBeDefined();
    expect(nameResult.race).toBe('人类');
    expect(nameResult.gender).toBe('女');

    const personalityResult = await executeToolCallForTest('random_personality', {});
    expect(personalityResult.code).toBeDefined();
    expect(personalityResult.description).toBeDefined();

    const attrResult = await executeToolCallForTest('roll_attributes', { tier: 2, level: 8 });
    expect(attrResult.str).toBeDefined();
    // roll_attributes 返回 { str, dex, con, int, spi, breakdown } 不带 tier

    // craft_get_base_dc 在 item_gen 白名单中
    const dcResult = await executeToolCall('craft_get_base_dc', { quality: '稀有' }, { characters: [], variables: {}, saveId: 'test' });
    expect(dcResult.baseDC).toBeDefined();
    expect(dcResult.quality).toBe('稀有');
  });

  it('Agentic 路径失败应抛出异常', async () => {
    const mockClient: CharGenClient = {
      chat: vi.fn().mockResolvedValue({
        output: 'mock chat response',
        rawResponse: 'mock chat response',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
      }),
      chatWithTools: vi.fn().mockResolvedValue({
        output: null,
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 100,
        error: 'API timeout',
      }),
    };
    const deps = makeDeps(mockClient);

    await expect(callCharGenAgent(makeRequest(), deps)).rejects.toThrow('char_gen Agent 调用失败');
  });

  it('应回退到旧路径 (无 chatWithTools 时)', async () => {
    // makeMockClient 只提供 chat，不提供 chatWithTools → 应走旧路径
    const mockClient = makeMockClient(makeCharGenOutput());
    const deps = makeDeps(mockClient);

    const result = await callCharGenAgent(makeRequest(), deps);
    expect(result.name).toBe('艾琳');
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
  });
});

// ── Agentic callItemGenAgent 测试 ──

describe('callItemGenAgent (Agentic 路径)', () => {
  it('应通过多轮工具调用生成物品', async () => {
    const mockClient = makeAgenticMockClient(
      [
        // 第 1 轮: 查品质基准 DC + 查角色数据
        {
          calls: [
            { name: 'craft_get_base_dc', args: { quality: '优良' } },
            { name: 'get_character', args: {} },
          ],
        },
        // 第 2 轮: 掷骰确定数量
        {
          calls: [
            { name: 'roll_dice', args: { formula: '2d3', reason: '确定技能数量' } },
            { name: 'roll_dice', args: { formula: '1d3+1', reason: '确定装备数量' } },
          ],
        },
      ],
      `<item_result>
<skills>
<skill name="精准射击" type="active" cost_type="SP" cost_amount="15" cooldown="3">精准瞄准，命中率+20%</skill>
</skills>
<equipment>
<equip slot="武器" name="精灵长弓" quality="优良" durability="120" stats="攻击力:18,敏捷:2">轻量化长弓</equip>
</equipment>
<inventory>
<item name="猎人箭袋" quantity="1" type="消耗品" rarity="普通">装有30支箭矢</item>
</inventory>
</item_result>`,
    );

    const deps = makeDeps(mockClient);
    const result = await callItemGenAgent(makeCharGenOutput(), makeRequest(), deps);

    expect(result.skills).toHaveLength(1);
    expect(result.equipment).toHaveLength(1);
    expect(result.inventory).toHaveLength(1);
    expect(result.skills[0].name).toBe('精准射击');
    expect(mockClient.chatWithTools).toHaveBeenCalledTimes(1);
  });

  it('Agentic 路径失败应返回空物品（不阻断流程）', async () => {
    const mockClient: CharGenClient = {
      chat: vi.fn().mockResolvedValue({
        output: 'mock chat response',
        rawResponse: 'mock chat response',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
      }),
      chatWithTools: vi.fn().mockResolvedValue({
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

// ── Agentic runCharGenChain 集成测试 ──

describe('runCharGenChain (Agentic 路径)', () => {
  it('应通过 Agentic 路径运行完整角色生成链', async () => {
    const charXml = `<char_result>
<name>格雷厄姆</name>
<race>人类</race>
<tier>2</tier>
<level>7</level>
<attributes str="11" dex="5" con="10" int="5" spi="4"/>
<identity>白曜城铁匠, 退役老兵</identity>
<occupation>铁匠, 武器匠人</occupation>
<background>曾在边境战争中服役十五年，失去左臂后开了铁匠铺</background>
<appearance>魁梧老兵，花白短发，独臂</appearance>
<personality code="w-aG-z+(S)">沉默寡言，对武器有近乎偏执的追求</personality>
<ascension enabled="false" path="" description=""/>
</char_result>`;

    const itemXml = `<item_result>
<skills>
<skill name="锻打强化" type="active" cost_type="SP" cost_amount="10" cooldown="2">利用锻造技巧增强武器威力</skill>
</skills>
<equipment>
<equip slot="武器" name="锻铁大锤" quality="优良" durability="150" stats="攻击力:22,力量:3">沉重铁锤</equip>
</equipment>
<inventory>
<item name="精炼铁矿石" quantity="15" type="材料" rarity="优良">上好的铁矿石</item>
</inventory>
</item_result>`;

    // char_gen: 2 轮工具调用 → 最终输出 charXml
    const charClient = makeAgenticMockClient(
      [
        { calls: [{ name: 'get_character', args: {} }, { name: 'random_name', args: { race: '人类', gender: '男' } }] },
        { calls: [{ name: 'roll_attributes', args: { tier: 2, level: 7 } }, { name: 'random_personality', args: {} }] },
      ],
      charXml,
    );

    // item_gen: 1 轮工具调用 → 最终输出 itemXml
    const itemClient = makeAgenticMockClient(
      [
        { calls: [{ name: 'craft_get_base_dc', args: { quality: '优良' } }, { name: 'roll_dice', args: { formula: '1d3+1' } }] },
      ],
      itemXml,
    );

    const clientMap: Record<string, CharGenClient> = {
      char_gen: charClient,
      item_gen: itemClient,
    };

    const deps: CharGenAgentDeps = {
      clientFactory: (agentId: string) => clientMap[agentId],
    };

    const result = await runCharGenChain(makeRequest(), deps);

    expect(result.character).toBeDefined();
    expect(result.character.name).toBe('格雷厄姆');
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.narrativeSummary).toContain('格雷厄姆');
    expect(charClient.chatWithTools).toHaveBeenCalledTimes(1);
    expect(itemClient.chatWithTools).toHaveBeenCalledTimes(1);
  });
});

// ========== parseItemGenOutput — JSON 兜底（真机 2026-07-17 形状） ==========

describe('parseItemGenOutput — <item_result> 内嵌 JSON 兜底', () => {
  it('AI 在 <item_result> 里塞 markdown JSON 单对象（真机实测形状）→ 归一到 equipment', async () => {
    const { parseItemGenOutput } = await import('./char-gen-agent');
    const raw = [
      '我已经查询了角色和脚本参考。现在开始设计。',
      '',
      '## 物品生成结果',
      '',
      '<item_result>',
      '',
      '```json',
      JSON.stringify({
        name: '暮星纹章长袍',
        type: 'equipment',
        slot: '身体',
        quality: '史诗',
        description: '深蓝色天鹅绒裁制的长袍。',
        stats: { defense: 12, magicDefense: 18 },
        scripts: { init: "$event.on('combat_round_start', '__tick__');", cleanup: "$event.off('combat_round_start');" },
        tags: ['神秘', '防具'],
        flavorText: '它一直在等你。',
      }),
      '```',
      '',
      '</item_result>',
      '',
      '### 设计说明',
      '| 维度 | 说明 |',
    ].join('\n');

    const out = parseItemGenOutput(raw);
    expect(out.equipment).toHaveLength(1);
    expect(out.equipment[0].name).toBe('暮星纹章长袍');
    expect(out.equipment[0].slot).toBe('身体');
    expect(out.equipment[0].quality).toBe('史诗');
    expect(out.equipment[0].stats).toEqual({ defense: 12, magicDefense: 18 });
    expect((out.equipment[0] as any).scripts?.init).toContain('$event.on');
    expect(out.skills).toHaveLength(0);
    expect(out.inventory).toHaveLength(0);
  });

  it('JSON 数组混合类型 → 按 type/slot 分组归一', async () => {
    const { parseItemGenOutput } = await import('./char-gen-agent');
    const raw = [
      '<item_result>',
      '```json',
      JSON.stringify([
        { name: '铁剑', type: '装备', slot: '武器', rarity: '普通', stats: { atk: 10 } },
        { name: '火球术', type: 'active', description: '一颗火球', cost: { type: 'MP', amount: 10 }, cooldown: 2 },
        { name: '治疗药水', type: '消耗品', quantity: 3, description: '恢复少量生命' },
      ]),
      '```',
      '</item_result>',
    ].join('\n');

    const out = parseItemGenOutput(raw);
    expect(out.equipment).toHaveLength(1);
    expect(out.equipment[0].slot).toBe('武器');
    expect(out.equipment[0].quality).toBe('普通');  // rarity→quality 映射
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].name).toBe('火球术');
    expect(out.skills[0].cost).toEqual({ type: 'MP', amount: 10 });
    expect(out.inventory).toHaveLength(1);
    expect(out.inventory[0].quantity).toBe(3);
  });

  it('标准 XML 子元素路径不受影响（回归）', async () => {
    const { parseItemGenOutput } = await import('./char-gen-agent');
    const raw = [
      '<item_result>',
      '<equipment>',
      '<equip slot="武器" name="精铁长剑" quality="优良" durability="80">锋利的长剑<stat name="atk">15</stat></equip>',
      '</equipment>',
      '</item_result>',
    ].join('\n');
    const out = parseItemGenOutput(raw);
    expect(out.equipment).toHaveLength(1);
    expect(out.equipment[0].name).toBe('精铁长剑');
  });
});

// ========== parseCharGenOutput — 嵌套标签剥离（真机 2026-07-17 薇拉形状） ==========

describe('parseCharGenOutput — 叙事字段嵌套 XML 剥离', () => {
  it('AI 在 appearance/personality 里自作主张嵌套子标签 → 落库前剥为纯文本', async () => {
    const { parseCharGenOutput } = await import('./char-gen-agent');
    const raw = [
      '<char_result>',
      '<name>薇拉</name>',
      '<race>灵体</race>',
      '<gender>女</gender>',
      '<tier>2</tier>',
      '<level>8</level>',
      '<attributes str="1" dex="4" con="3" int="5" spi="2" />',
      '<identity>幻书管理者</identity>',
      '<occupation>管理者</occupation>',
      '<appearance>',
      '  <physical>无物理实体。仅能以少女声音在意识中回响。</physical>',
      '  <voice>清亮中带着书卷气的慵懒。</voice>',
      '</appearance>',
      '<personality>',
      '  <code>wHlRY(A)（底层参考）</code>',
      '  <description>表层性格完全傲娇化，内心孤独。</description>',
      '</personality>',
      '<background>在钥匙中沉睡了不知多久。</background>',
      '</char_result>',
    ].join('\n');

    const out = parseCharGenOutput(raw);
    expect(out.name).toBe('薇拉');
    // 嵌套标签剥离：内容保留、标签消失
    expect(out.appearance).not.toMatch(/<[a-z_]+/i);
    expect(out.appearance).toContain('无物理实体');
    expect(out.appearance).toContain('清亮中带着书卷气');
    expect(out.personality).not.toMatch(/<[a-z_]+/i);
    expect(out.personality).toContain('傲娇');
    expect(out.background).toBe('在钥匙中沉睡了不知多久。');
  });
});

// ========== parseCharGenOutput — JSON 兜底（真机 2026-07-17 妲丽安形状） ==========

describe('parseCharGenOutput — <char_result> 内嵌 JSON 兜底', () => {
  it('AI 在 <char_result> 里塞 JSON（真机妲丽安形状）→ 结构化归一而非全兜底未命名', async () => {
    const { parseCharGenOutput } = await import('./char-gen-agent');
    const raw = [
      '好的，数据已生成完毕。现在输出完整的角色卡。',
      '',
      '<char_result>',
      JSON.stringify({
        name: '妲丽安',
        race: '愿灵（物灵）',
        type: 'npc',
        tier: 1,
        level: 1,
        faction: '无',
        description: '寄宿在理查德脑海中的意识体。',
        appearance: {
          summary: '无实体形态。意识空间中呈现为古典长裙少女虚影。',
          hair_color: '银灰色',
          eye_color: '琥珀金',
        },
        personality: {
          code: 'WOary(F)',
          summary: '傲慢且傲娇，对贡品有强烈执念。',
        },
        attributes: { str: 0, dex: 0, con: 0, int: 3, spi: 1 },
        abilities: [],
        equipment: [],
        inventory: [],
        lore: {
          identity: '通往壶中之天的大门',
          origin: '来历不明，寄宿于理查德脑海。',
        },
      }),
      '</char_result>',
    ].join('\n');

    const out = parseCharGenOutput(raw);
    expect(out.name).toBe('妲丽安');
    expect(out.race).toBe('愿灵（物灵）');
    // 0 属性保留（意识体无实体），不被 ||10 打回默认
    expect(out.attributes.str).toBe(0);
    expect(out.attributes.dex).toBe(0);
    expect(out.attributes.int).toBe(3);
    expect(out.attributes.spi).toBe(1);
    // appearance/personality 对象 → 取 summary 纯文本
    expect(out.appearance).toContain('无实体形态');
    expect(out.appearance).not.toMatch(/\{|\[object/);
    expect(out.personality).toContain('傲慢且傲娇');
    // background 从 lore.origin 兜底
    expect(out.background).toContain('寄宿');
  });

  it('XML 子元素 0 属性不再被 ||10 打回默认（回归）', async () => {
    const { parseCharGenOutput } = await import('./char-gen-agent');
    const raw = [
      '<char_result>',
      '<name>幽灵</name>',
      '<race>灵体</race>',
      '<gender>女</gender>',
      '<tier>1</tier>',
      '<level>1</level>',
      '<attributes str="0" dex="0" con="0" int="5" spi="2" />',
      '<identity>幽魂</identity>',
      '<occupation>无</occupation>',
      '<background>无实体的幽灵。</background>',
      '</char_result>',
    ].join('\n');
    const out = parseCharGenOutput(raw);
    expect(out.attributes.str).toBe(0);
    expect(out.attributes.con).toBe(0);
    expect(out.attributes.int).toBe(5);
  });
});
