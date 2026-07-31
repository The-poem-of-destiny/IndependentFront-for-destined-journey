/**
 * item-gen-chain.test.ts — 独立物品/技能生成链测试 (Phase 9c)
 *
 * 测试:
 * - buildItemGenPatches: 纯函数 (补 id / 装备两步 patch / 技能 patches)
 * - runItemGenChain: 集成 (mock client → XML 解析 → patches → stateManager 持久化)
 */

import { describe, it, expect, vi } from 'vitest';
import { runItemGenChain, buildItemGenPatches } from './item-gen-chain';
import type { ItemGenChainClient, ItemGenChainDeps } from './item-gen-chain';
import type { ItemGenRequestMarker, ItemGenOutput, ApiEndpoint, AgentContext } from './types';

// ========== Factory Helpers ==========

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'ep-test',
    name: 'Test Endpoint',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    models: [],
    timeout: 30000,
    ...overrides,
  };
}

function makeContext(): AgentContext {
  return {
    saveId: 'save-test',
    characters: [],
    variables: {},
    agentOutputs: new Map(),
  } as unknown as AgentContext;
}

function makeMarker(overrides: Partial<ItemGenRequestMarker> = {}): ItemGenRequestMarker {
  return {
    type: 'item_gen_request',
    attributes: {
      itemType: 'equipment',
      source: 'story',
      owner: 'char-001',
    },
    bodyText: '一件华丽的旧式法师长袍，深蓝色天鹅绒面料',
    position: 0,
    rawContent: '',
    ...overrides,
  } as ItemGenRequestMarker;
}

function makeItemGenXML(): string {
  return `<item_result>
<skills>
<skill name="灼热射线" type="active" cost_type="MP" cost_amount="100" cooldown="0">
  一道凝练炽热的射线。
  <effect name="能量伤害">造成100%能量伤害</effect>
</skill>
</skills>
<equipment>
<equip slot="身体" name="法师长袍" quality="优良" durability="80" stats="防御:60">
  厚实的蓝色天鹅绒。
  <effect name="法力增幅">降低8%MP消耗</effect>
</equip>
</equipment>
<inventory>
<item name="磨损铜币" quantity="1" type="材料" rarity="普通">
  一枚磨损严重的铜币。
</item>
</inventory>
</item_result>`;
}

function makeMockClient(rawOutput: string): ItemGenChainClient {
  return {
    chat: vi.fn().mockResolvedValue({
      output: rawOutput,
      rawResponse: rawOutput,
      tokensUsed: 100,
      cacheHit: false,
      duration: 10,
    }),
  };
}

function makeRequest(marker: ItemGenRequestMarker) {
  return {
    saveId: 'save-test',
    marker,
    storyOutput: '',
    context: makeContext(),
    endpoint: makeEndpoint(),
  };
}

// ========== buildItemGenPatches (纯函数) ==========

describe('buildItemGenPatches', () => {
  it('装备生成单 add_item 含 equippedSlot，M3 废除两步落库', () => {
    const itemOutput: ItemGenOutput = {
      skills: [],
      equipment: [
        {
          slot: '身体',
          name: '法师长袍',
          description: '厚实天鹅绒',
          stats: { 防御: 60 },
          durability: 80,
          quality: '优良',
        },
      ],
      inventory: [],
    };
    const patches = buildItemGenPatches(itemOutput, 'char-001');

    const addPatches = patches.filter((p) => p.op === 'add_item');
    const equipPatches = patches.filter((p) => p.op === 'equip_item');
    expect(addPatches).toHaveLength(1);
    // M3: 不再有 equip_item — 装备直接通过 add_item 的 equippedSlot 落库
    expect(equipPatches).toHaveLength(0);

    const addItem = addPatches[0].value as any;
    // M3: 废除 id 生成，不再断言 id
    expect(addItem.name).toBe('法师长袍');
    expect(addItem.equippedSlot).toBe('身体');
    expect(addItem.type).toBe('装备');
    expect(addItem.rarity).toBe('优良');
    expect(addItem.quantity).toBe(1);
    expect(addItem.stats).toEqual({ 防御: 60 });
    expect(addItem.durability).toBe(80);
  });

  it('背包物品生成 add_item，M3 不再补 id', () => {
    const itemOutput: ItemGenOutput = {
      skills: [],
      equipment: [],
      inventory: [
        { name: '磨损铜币', description: '一枚铜币', quantity: 1, type: '材料', rarity: '普通' },
      ],
    };
    const patches = buildItemGenPatches(itemOutput, 'char-001');
    const addPatches = patches.filter((p) => p.op === 'add_item');
    expect(addPatches).toHaveLength(1);
    // M3: 废除 id 生成，不再断言 id
    expect((addPatches[0].value as any).quantity).toBe(1);
    expect((addPatches[0].value as any).name).toBe('磨损铜币');
    expect((addPatches[0].value as any).type).toBe('材料');
    expect((addPatches[0].value as any).rarity).toBe('普通');
  });

  it('技能生成 add_skill，M3 不再补 id', () => {
    const itemOutput: ItemGenOutput = {
      skills: [
        {
          name: '灼热射线',
          description: '一道射线',
          type: 'active',
          cost: { type: 'MP', amount: 100 },
          effects: { 能量伤害: '100%' },
        },
      ],
      equipment: [],
      inventory: [],
    };
    const patches = buildItemGenPatches(itemOutput, 'char-001');
    const skillPatches = patches.filter((p) => p.op === 'add_skill');
    expect(skillPatches).toHaveLength(1);
    // M3: 废除 id 生成，不再断言 id
    expect((skillPatches[0].value as any).name).toBe('灼热射线');
    expect((skillPatches[0].value as any).type).toBe('active');
    expect((skillPatches[0].value as any).cost).toEqual({ type: 'MP', amount: 100 });
  });

  it('空输出返回空 patches', () => {
    const patches = buildItemGenPatches({ skills: [], equipment: [], inventory: [] }, 'char-001');
    expect(patches).toEqual([]);
  });

  it('target 指向 owner 角色字符路径', () => {
    const patches = buildItemGenPatches(
      {
        skills: [],
        equipment: [],
        inventory: [{ name: 'x', description: '', quantity: 1, type: '材料' }],
      },
      'char-007',
    );
    expect(patches[0].target).toBe('characters.char-007');
  });
});

// ========== runItemGenChain (集成) ==========

describe('runItemGenChain', () => {
  it('应从 item_gen XML 输出生成 patches（M3: 装备单 add_item 含 equippedSlot）', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const result = await runItemGenChain(makeRequest(makeMarker()), deps);

    // M3: 1 技能 + 1 装备(add_item with equippedSlot) + 1 物品 = 3 patches
    expect(result.patches.length).toBe(3);
    expect(result.patches.some((p) => p.op === 'add_skill')).toBe(true);
    // 2 add_item: 1 equipment + 1 inventory
    expect(result.patches.filter((p) => p.op === 'add_item')).toHaveLength(2);
    // M3: 废除 equip_item 两步模式
    expect(result.patches.filter((p) => p.op === 'equip_item')).toHaveLength(0);
  });

  it('应调用 stateManager.commitChatState', async () => {
    const client = makeMockClient(makeItemGenXML());
    const commitChatState = vi.fn().mockResolvedValue(undefined);
    const deps: ItemGenChainDeps = {
      clientFactory: () => client,
      stateManager: { commitChatState },
    };
    const result = await runItemGenChain(makeRequest(makeMarker()), deps);
    expect(commitChatState).toHaveBeenCalledTimes(1);
    expect(commitChatState).toHaveBeenCalledWith(result.patches);
  });

  it('无 stateManager 时不应报错', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const result = await runItemGenChain(makeRequest(makeMarker()), deps);
    expect(result.patches.length).toBeGreaterThan(0);
  });

  it('item_gen 失败不阻断 — 返回空 patches', async () => {
    const client: ItemGenChainClient = {
      chat: vi.fn().mockRejectedValue(new Error('API down')),
    };
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const result = await runItemGenChain(makeRequest(makeMarker()), deps);
    expect(result.patches).toEqual([]);
  });

  it('Agentic 路径 (chatWithTools) 优先', async () => {
    const client: ItemGenChainClient = {
      chat: vi.fn().mockResolvedValue({
        output: '<item_result></item_result>',
        rawResponse: '',
        tokensUsed: 0,
        cacheHit: false,
        duration: 0,
      }),
      chatWithTools: vi.fn().mockResolvedValue({
        output: makeItemGenXML(),
        rawResponse: makeItemGenXML(),
        tokensUsed: 100,
        cacheHit: false,
        duration: 0,
      }),
    };
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    await runItemGenChain(makeRequest(makeMarker()), deps);
    expect(client.chatWithTools as any).toHaveBeenCalledTimes(1);
    expect(client.chat as any).not.toHaveBeenCalled();
    // 防回归: maxRounds 必须为 10（5 轮会让 equipment 类生成触顶失败）
    expect(client.chatWithTools as any).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { maxRounds: 10 },
    );
  });

  it('owner 缺省时 target 兜底 context 玩家名（M3: 不再用 player_1）', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const marker = makeMarker({ attributes: { itemType: 'equipment', source: 'story' } } as any);
    // M3: owner 解析链路 — marker.attributes.owner ?? context.characters 中 type='player' 的 name
    // marker 无 owner，context 无 player 角色 → 返回空 patches
    const result = await runItemGenChain(makeRequest(marker), deps);
    expect(result.patches).toEqual([]);
  });

  it('owner 缺省时若 context 有玩家角色则 target 用玩家名', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const marker = makeMarker({ attributes: { itemType: 'equipment', source: 'story' } } as any);
    // M3: 有玩家角色时应兜底用玩家名，非 'player_1'
    const contextWithPlayer = makeContext();
    (contextWithPlayer as any).characters = [{ type: 'player', name: '阿尔萨斯' }];
    const request = makeRequest(marker);
    (request as any).context = contextWithPlayer;
    const result = await runItemGenChain(request, deps);
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.patches.every((p) => p.target === 'characters.阿尔萨斯')).toBe(true);
  });
});
