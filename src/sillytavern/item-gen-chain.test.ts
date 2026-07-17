/**
 * item-gen-chain.test.ts — 独立物品/技能生成链测试 (Phase 9c)
 *
 * 测试:
 * - buildItemGenPatches: 纯函数 (补 id / 装备两步 patch / 技能 patches)
 * - runItemGenChain: 集成 (mock client → XML 解析 → patches → stateManager 持久化)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runItemGenChain,
  buildItemGenPatches,
} from './item-gen-chain';
import type { ItemGenChainClient, ItemGenChainDeps } from './item-gen-chain';
import type {
  ItemGenRequestMarker,
  ItemGenOutput,
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
  it('装备生成 add_item + equip_item 两步，equip 按 name+slot 寻址', () => {
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
    expect(equipPatches).toHaveLength(1);

    const addItem = addPatches[0].value as any;
    const equipItem = equipPatches[0].value as any;
    // M2 契约: equip_item 按 name+slot 寻址；add_item 的 id 仅占可选位 // M3 删
    expect(addItem.id).toBeTruthy();
    expect(equipItem.name).toBe(addItem.name);
    expect(equipItem.name).toBe('法师长袍');
    expect(equipItem.slot).toBe('身体');
  });

  it('背包物品生成 add_item 且补 id', () => {
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
    expect((addPatches[0].value as any).id).toBeTruthy();
    expect((addPatches[0].value as any).quantity).toBe(1);
    expect((addPatches[0].value as any).name).toBe('磨损铜币');
  });

  it('技能生成 add_skill 且补 id', () => {
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
    expect((skillPatches[0].value as any).id).toBeTruthy();
    expect((skillPatches[0].value as any).name).toBe('灼热射线');
  });

  it('空输出返回空 patches', () => {
    const patches = buildItemGenPatches({ skills: [], equipment: [], inventory: [] }, 'char-001');
    expect(patches).toEqual([]);
  });

  it('target 指向 owner 角色字符路径', () => {
    const patches = buildItemGenPatches(
      { skills: [], equipment: [], inventory: [{ name: 'x', description: '', quantity: 1, type: '材料' }] },
      'char-007',
    );
    expect(patches[0].target).toBe('characters.char-007');
  });
});

// ========== runItemGenChain (集成) ==========

describe('runItemGenChain', () => {
  it('应从 item_gen XML 输出生成 patches', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const result = await runItemGenChain(makeRequest(makeMarker()), deps);

    // 1 技能 + 1 装备 (add_item+equip 两步) + 1 物品 = 4 patches
    expect(result.patches.length).toBe(4);
    expect(result.patches.some((p) => p.op === 'add_skill')).toBe(true);
    expect(result.patches.filter((p) => p.op === 'add_item')).toHaveLength(2);
    expect(result.patches.some((p) => p.op === 'equip_item')).toBe(true);
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
      chat: vi.fn().mockResolvedValue({ output: '<item_result></item_result>', rawResponse: '', tokensUsed: 0, cacheHit: false, duration: 0 }),
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
    expect((client.chatWithTools as any)).toHaveBeenCalledTimes(1);
    expect((client.chat as any)).not.toHaveBeenCalled();
    // 防回归: maxRounds 必须为 10（5 轮会让 equipment 类生成触顶失败）
    expect((client.chatWithTools as any)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { maxRounds: 10 },
    );
  });

  it('owner 缺省时 target 兜底 player_1', async () => {
    const client = makeMockClient(makeItemGenXML());
    const deps: ItemGenChainDeps = { clientFactory: () => client };
    const marker = makeMarker({ attributes: { itemType: 'equipment', source: 'story' } } as any);
    const result = await runItemGenChain(makeRequest(marker), deps);
    expect(result.patches.every((p) => p.target === 'characters.player_1')).toBe(true);
  });
});