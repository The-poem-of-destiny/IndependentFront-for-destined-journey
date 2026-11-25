/**
 * 直出接线（状态树协议 T9a）：`stateProtocol: 'tree'` 下的读侧投影、缓存分区增量、
 * 写侧解析 → 建补丁 → `commitDirectTurn` 落库 → 读回，以及旧形状回落。
 * legacy 口径由既有直出测试原样钉住，这里只补 tree 分支与两协议的切换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDirectPatches,
  parseDirectOutput,
  type DirectUpdates,
} from '../../../src/core/agents/direct-output';
import { generateDirectTurn } from '../../../src/core/agents/direct-main';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  buildDirectProtocol,
  createDirectPreset,
  DIRECT_OUTPUT_REMINDER,
} from '../../../src/core/prompts/direct-prompt';
import {
  acceptDirectContext,
  buildDirectCacheProtocol,
  DIRECT_CACHE_PROTOCOL,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';
import {
  STATE_TREE_CACHE_PROTOCOL,
  STATE_TREE_WRITE_PROTOCOL,
} from '../../../src/core/prompts/state-tree-prompt';
import { setEngineSettingsProvider } from '../../../src/core/runtime/engine-settings';
import { createStateManager } from '../../../src/core/state/state-manager';
import { getProfile } from '../../../src/core/state/save-profile';
import {
  clearAllData,
  getCharacters,
  getMessages,
  saveCharacter,
  saveMessages,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { collectCompleteStoryTurns } from '../../../src/core/memory/memory-context';
import { storyTurnSource } from '../../../src/core/memory/story-memory-source';
import { buildStateTree } from '../../../src/core/variables/state-tree-projection';
import { findOverlappingSections } from '../../../src/core/variables/state-tree-sections';
import { createDefaultTime } from '../../../src/core/time/time-system';
import {
  createDefaultCharacterState,
  type AgentConfig,
  type AgentContext,
  type ChatMessage,
  type SaveSlot,
} from '../../../src/core/types/types';

const saveId = 'direct-tree-test';
const POOL: DirectDicePool = [{ sides: 20, values: [7] }];

function wrap(updates: unknown, characters: unknown[] = []): string {
  return `<maintext>你把铁块交给铁匠。</maintext><options>1. 等待</options><character_updates>${JSON.stringify({ characters })}</character_updates><direct_updates>${typeof updates === 'string' ? updates : JSON.stringify(updates)}</direct_updates>`;
}

function player() {
  return createDefaultCharacterState({
    id: 'p',
    saveId,
    name: '旅人',
    type: 'player',
    maxHp: 100,
    hp: 80,
    maxMp: 100,
    mp: 90,
    maxSp: 100,
    sp: 75,
    location: '王都/铁匠铺',
    present: true,
    inventory: [{ name: '铁', quantity: 2 }],
  });
}

function ella(present: boolean) {
  return createDefaultCharacterState({
    id: 'e',
    saveId,
    name: '艾拉',
    type: 'npc',
    maxHp: 100,
    hp: 60,
    location: present ? '王都/铁匠铺' : '港口',
    present,
  });
}

function source(): ChatMessage[] {
  return [
    {
      id: 'u',
      saveId,
      role: 'user',
      content: '交出铁块',
      timestamp: 1,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
    {
      id: 'a',
      saveId,
      role: 'assistant',
      content: '你把铁块交给铁匠。',
      timestamp: 2,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
  ];
}

async function fixture() {
  await saveSaveSlot({
    id: saveId,
    name: 'Tree',
    slot: 1,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      generationMode: 'direct',
      characterName: '旅人',
      userName: '',
      gameStartTime: '',
      totalTurns: 0,
    },
  } as SaveSlot);
  await saveCharacter(player());
  await saveCharacter(ella(false));
  await saveMessages(source());
  await getProfile(saveId);
}

const SMITH = {
  成长: { 等级: 6, 属性: { 力量: 8, 敏捷: 6, 体质: 7, 智力: 5, 精神: 5 } },
  地点: '王都/铁匠铺',
  在场: true,
  档案: { 种族: '矮人' },
};

beforeEach(async () => {
  await clearAllData();
  setEngineSettingsProvider(() => ({ stateProtocol: 'tree' }));
});
afterEach(() => {
  setEngineSettingsProvider(undefined);
  invalidateDirectContext(saveId);
  vi.restoreAllMocks();
});

describe('协议文字（tree）', () => {
  it.each([false, true])('结构化战斗=%s：状态写入段替换旧协议各行，其余行保留', (structured) => {
    const legacy = buildDirectProtocol(structured).split('\n');
    const tree = buildDirectProtocol(structured, 'tree');
    expect(buildDirectProtocol(structured, 'legacy')).toBe(legacy.join('\n'));
    expect(tree).toContain(STATE_TREE_WRITE_PROTOCOL);
    for (const prefix of [
      'tile_ops 每项含',
      'plot:{} 或',
      'diceUsed:',
      '输出顺序：',
      '仅用提供的骰池',
    ])
      expect(tree.split('\n').filter((line) => line.startsWith(prefix))).toEqual(
        legacy.filter((line) => line.startsWith(prefix)),
      );
    for (const gone of ['state.characters', 'effects:[', '"version":1', 'entities 项只有两种'])
      expect(tree).not.toContain(gone);
    expect(tree).toContain('本楼经 patch 新建的人物');
  });
});

describe('写侧解析（tree）', () => {
  it('认 version 2 的 patch：op 进 treePatch，信封进 v1 骨架', () => {
    const draft = parseDirectOutput(
      wrap({
        version: 2,
        patch: [{ op: 'delta', path: '/主角/生命值/当前', value: -10 }],
        plot: {},
        diceUsed: [{ sides: 20, index: 0, purpose: '锻造', target: '短剑' }],
        tile_ops: [],
      }),
      POOL,
      { stateProtocol: 'tree', structuredCombat: false },
    );
    expect(draft.treePatch?.ops).toHaveLength(1);
    expect(draft.treePatch?.ops[0]).toMatchObject({ op: 'delta', path: '/主角/生命值/当前' });
    expect(draft.updates.entities).toEqual([]);
    expect(draft.updates.state).toEqual({});
    expect(draft.updates.diceUsed).toEqual([
      { sides: 20, index: 0, purpose: '锻造', target: '短剑' },
    ]);
    expect(draft.normalized).toBeUndefined();
    expect(draft.dropped).toBeUndefined();
  });

  it('plot / diceUsed / combat 缺了按空处理，不记纠正', () => {
    const draft = parseDirectOutput(wrap({ version: 2, patch: [] }), POOL, {
      stateProtocol: 'tree',
      structuredCombat: true,
    });
    expect(draft.treePatch?.ops).toEqual([]);
    expect(draft.updates.combat).toBeNull();
    expect(draft.updates.plot).toEqual({});
    expect(draft.normalized).toBeUndefined();
  });

  it('旧形状回落到 v1 解析并记一条纠正', () => {
    const legacy: DirectUpdates = {
      version: 1,
      world: {},
      time: { delta_time: 5 },
      entities: [],
      state: { characters: { delta: [{ name: '旅人', path: 'hp', amount: -10 }] } },
      effects: [],
      plot: {},
      combat: null,
      diceUsed: [],
    };
    const draft = parseDirectOutput(wrap(legacy), POOL, {
      stateProtocol: 'tree',
      structuredCombat: false,
    });
    expect(draft.treePatch).toBeUndefined();
    expect(draft.normalized?.[0]).toMatch(/^direct_updates：区块是旧形状/);
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    expect(built.patches).toMatchObject([
      { op: 'delta_hp', target: 'characters.旅人', amount: -10 },
    ]);
    expect(built.deltaTime).toBe(5);
    expect(built.stateUpdates).toBeUndefined();
  });

  it('原型污染键与整段 JSON 写坏且一条 op 都没救回时整楼拒收', () => {
    const opts = { stateProtocol: 'tree' as const, structuredCombat: false };
    expect(() =>
      parseDirectOutput(
        wrap('{"version":2,"patch":[{"op":"replace","path":"/变量/__proto__/x","value":1}]}'),
        POOL,
        opts,
      ),
    ).toThrow(/^直出结果无效：/);
    expect(() =>
      parseDirectOutput(wrap('{"version":2,"patch":[{"op":"delta","path":"/主角/金'), POOL, opts),
    ).toThrow('直出结果无效：direct_updates 整段 JSON 写坏了，逐条恢复后一条操作都没能救回');
    expect(() => parseDirectOutput(wrap('不是 JSON'), POOL, opts)).toThrow(/^直出结果无效：/);
  });

  it('JSON 完好但唯一一条 op 解析期就坏（非对象 / 未知 op / 缺 path）：只丢那条，本楼照常接纳', () => {
    const opts = { stateProtocol: 'tree' as const, structuredCombat: false };
    for (const patch of [
      ['坏'],
      [{ op: 'explode', path: '/主角/金钱', value: 1 }],
      [{ op: 'delta', value: 1 }],
    ]) {
      const draft = parseDirectOutput(wrap({ version: 2, patch }), POOL, opts);
      expect(draft.treePatch?.ops, JSON.stringify(patch)).toEqual([]);
      expect(draft.dropped?.length, JSON.stringify(patch)).toBe(1);
    }
  });

  it('坏元素只丢那一条，截断的前半段保住', () => {
    const draft = parseDirectOutput(
      wrap(
        '{"version":2,"patch":[{"op":"delta","path":"/主角/生命值/当前","value":-10},{"op":"delta","pa',
      ),
      POOL,
      { stateProtocol: 'tree', structuredCombat: false },
    );
    expect(draft.treePatch?.ops).toHaveLength(1);
    expect(draft.dropped?.length).toBeGreaterThan(0);
  });

  it('legacy 协议下仍按 v1 解析（不认 patch）', () => {
    const draft = parseDirectOutput(wrap({ version: 2, patch: [] }), POOL, {
      structuredCombat: false,
    });
    expect(draft.treePatch).toBeUndefined();
    expect(draft.dropped).toContain('direct_updates：含未支持的字段 patch，已剥除');
  });
});

describe('端到端（tree）：解析 → 建补丁 → commitDirectTurn → 读回', () => {
  async function run(
    patch: unknown[],
    extra: Record<string, unknown> = {},
    narrative: unknown[] = [],
  ) {
    await fixture();
    const draft = parseDirectOutput(wrap({ version: 2, patch, ...extra }, narrative), POOL, {
      stateProtocol: 'tree',
      structuredCombat: false,
    });
    const profile = await getProfile(saveId);
    const built = buildDirectPatches(draft, {
      characters: await getCharacters(saveId),
      definitions: [],
      sourceTurnKey: 'u',
      profile,
    });
    const outcome = await createStateManager(saveId).commitDirectTurn({
      patches: built.patches,
      messages: source(),
      turnKey: 'u',
      combat: null,
      isCurrent: () => true,
    });
    return { draft, built, outcome };
  }

  it('资源、库存、新物品、新人物、好感度一次落库，读回的树与写入一致', async () => {
    const { built, outcome } = await run([
      { op: 'delta', path: '/世界/时间', value: 30 },
      { op: 'delta', path: '/主角/生命值/当前', value: -10 },
      { op: 'delta', path: '/主角/背包/铁/数量', value: -1 },
      { op: 'add', path: '/主角/背包/短剑', value: { 类型: '武器', 数量: 1, 描述: '新打的短剑' } },
      { op: 'add', path: '/关系列表/铁匠', value: SMITH },
      { op: 'delta', path: '/关系列表/艾拉/好感度', value: 5 },
    ]);
    expect(outcome).toBe('committed');
    expect(built.dropped).toEqual([]);
    expect(built.deltaTime).toBe(30);
    expect(built.stateUpdates?.deltaMinutes).toBe(30);
    expect(built.stateUpdates?.ops).toHaveLength(6);
    expect(built.stateUpdates?.ops.every((op) => op.status !== '已丢弃')).toBe(true);
    expect(built.characters.map((c) => c.name).sort()).toEqual(['旅人', '艾拉', '铁匠'].sort());

    const characters = await getCharacters(saveId);
    const profile = await getProfile(saveId);
    const me = characters.find((c) => c.name === '旅人')!;
    expect(me.hp).toBe(70);
    expect(me.inventory).toMatchObject([
      { name: '铁', quantity: 1 },
      { name: '短剑', quantity: 1, description: '新打的短剑' },
    ]);
    expect(characters.find((c) => c.name === '铁匠')).toMatchObject({
      level: 6,
      location: '王都/铁匠铺',
      present: true,
      introducedBy: 'u',
    });
    expect(profile.affections['艾拉']).toBe(5);
    const tree = buildStateTree({ characters, profile }, { visibility: { mode: 'all' } });
    expect((tree['主角'] as any)['生命值']['当前']).toBe(70);
    expect((tree['主角'] as any)['背包']['短剑']['数量']).toBe(1);
    expect((tree['关系列表'] as any)['艾拉']['好感度']).toBe(5);
  });

  it('坏 op 只丢那一条并进 dropped 与记录，其余照落', async () => {
    const { built } = await run([
      { op: 'delta', path: '/主角/生命值/当前', value: -10 },
      { op: 'replace', path: '/主角/成长/等级', value: 9 },
    ]);
    expect(built.dropped).toHaveLength(1);
    expect(built.dropped[0]).toContain('累计经验值');
    expect(built.stateUpdates?.ops.map((op) => op.status)).toEqual(['已应用', '已丢弃']);
    expect((await getCharacters(saveId)).find((c) => c.name === '旅人')!.hp).toBe(70);
  });

  it('没写 /世界/时间 时接受旧写法 time.delta_time；两者都写以 patch 为准', async () => {
    const legacyOnly = await run([], { time: { delta_time: 12 } });
    expect(legacyOnly.built.deltaTime).toBe(12);
    await clearAllData();
    const both = await run([{ op: 'delta', path: '/世界/时间', value: 30 }], {
      time: { delta_time: 12 },
    });
    expect(both.built.deltaTime).toBe(30);
    expect(both.built.dropped).toEqual([
      'time.delta_time：本楼已用 /世界/时间 推进时间，旧写法已忽略',
    ]);
  });

  // 回归（审查 A8）：档案路径写入曾走叙事更新旁路，不在 commitDirectTurn 事务内
  it('档案路径写入产补丁、随 commitDirectTurn 落；character_updates 显式写的同字段后落生效', async () => {
    const { built, outcome } = await run(
      [
        { op: 'replace', path: '/关系列表/艾拉/档案/外貌', value: '银发' },
        { op: 'replace', path: '/关系列表/艾拉/档案/性格', value: '冷淡' },
      ],
      {},
      [{ name: '艾拉', profile_changes: { personality: '温和' }, chronicle: [] }],
    );
    expect(outcome).toBe('committed');
    expect(built.patches).toEqual([
      { op: 'update_character', target: 'characters.艾拉', value: { appearance: '银发' } },
      { op: 'update_character', target: 'characters.艾拉', value: { personality: '冷淡' } },
    ]);
    // 叙事更新只剩显式写的那份，不再并入路径写入
    expect(built.characterUpdates).toEqual([
      { name: '艾拉', profile_changes: { personality: '温和' }, chronicle: [] },
    ]);
    const afterTurn = (await getCharacters(saveId)).find((c) => c.name === '艾拉')!;
    expect(afterTurn).toMatchObject({ appearance: '银发', personality: '冷淡' });

    // 管线在接纳后才落叙事更新：显式写的同字段后落覆盖
    const turn = collectCompleteStoryTurns(await getMessages(saveId)).find((t) => t.key === 'u')!;
    const warnings = await createStateManager(saveId).commitCharacterUpdates(
      built.characterUpdates,
      storyTurnSource(turn),
    );
    expect(warnings).toEqual([]);
    const ella = (await getCharacters(saveId)).find((c) => c.name === '艾拉')!;
    expect(ella).toMatchObject({ appearance: '银发', personality: '温和' });
  });

  it('档案路径写入在 commitDirectTurn 事务内：后续补丁抛错时一并回滚', async () => {
    await fixture();
    const draft = parseDirectOutput(
      wrap({
        version: 2,
        patch: [{ op: 'replace', path: '/关系列表/艾拉/档案/外貌', value: '银发' }],
      }),
      POOL,
      { stateProtocol: 'tree', structuredCombat: false },
    );
    const built = buildDirectPatches(draft, {
      characters: await getCharacters(saveId),
      definitions: [],
      sourceTurnKey: 'u',
      profile: await getProfile(saveId),
    });
    expect(built.patches[0]).toMatchObject({ op: 'update_character', target: 'characters.艾拉' });
    const before = (await getCharacters(saveId)).find((c) => c.name === '艾拉')!.appearance;
    await expect(
      createStateManager(saveId).commitDirectTurn({
        patches: [
          ...built.patches,
          { op: 'update_character', target: 'characters.不存在的人', value: { hp: 1 } },
        ],
        messages: source(),
        turnKey: 'u',
        combat: null,
        isCurrent: () => true,
      }),
    ).rejects.toThrow();
    const ella = (await getCharacters(saveId)).find((c) => c.name === '艾拉')!;
    expect(ella.appearance).toBe(before);
    expect(ella.appearance).not.toBe('银发');
  });

  it('tree 草稿缺 profile 时明确报错', () => {
    const draft = parseDirectOutput(wrap({ version: 2, patch: [] }), POOL, {
      stateProtocol: 'tree',
      structuredCombat: false,
    });
    expect(() =>
      buildDirectPatches(draft, { characters: [player()], definitions: [], sourceTurnKey: 'u' }),
    ).toThrow('profile');
  });
});

describe('读侧（tree）', () => {
  const config: AgentConfig = {
    agentId: 'direct_main',
    enabled: true,
    apiEndpointId: 'ep',
    model: 'test',
    maxTokens: 1000,
    temperature: 0.7,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 30000,
    userId: 'test',
    historyLayers: 2,
    presetId: createDirectPreset().id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
  };
  const endpoint = {
    id: 'ep',
    name: 'test',
    provider: 'openai' as const,
    baseUrl: 'https://invalid.example/v1',
    apiKey: '',
    defaultModel: 'test',
    models: ['test'],
    timeout: 30000,
  };
  const reply = wrap({ version: 2, patch: [] });

  function context(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      userInput: '继续',
      characters: [player(), ella(false)],
      characterDefinitions: [],
      variables: {},
      history: [],
      worldBooks: [],
      memories: [],
      plotEvents: [],
      gameTime: createDefaultTime(),
      quests: {},
      affections: { 艾拉: 3 },
      agentOutputs: new Map([['memory_recall', '']]),
      ...overrides,
    };
  }
  function mockChat() {
    return vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: reply,
      rawResponse: reply,
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
    });
  }
  function turn(ctx: AgentContext, cached: boolean) {
    return generateDirectTurn(
      {
        config,
        endpoint,
        context: ctx,
        configs: [config],
        worldBooks: [],
        presets: [createDirectPreset()],
        combat: null,
        dice: POOL,
        ...(cached ? { cache: { saveId, policy: 'prefix' as const } } : {}),
      },
      new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 }),
    );
  }
  /** 缓存请求里留存的最后一条 direct_context */
  function directContext(messages: Array<{ content?: unknown }>) {
    const text = messages
      .map((m) => String(m.content ?? ''))
      .filter((c) => c.includes('<direct_context>'))
      .pop()!;
    return JSON.parse(text.match(/<direct_context>\n([\s\S]*?)\n<\/direct_context>/)![1]) as {
      set: Record<string, unknown>;
      remove: string[];
    };
  }
  function turnContext(messages: Array<{ content?: unknown }>) {
    const last = String(messages[messages.length - 1].content);
    return JSON.parse(last.match(/<turn_context>\n([\s\S]*?)\n<\/turn_context>/)![1]);
  }

  it('无缓存直出：direct_state 带 stat_data，不在场角色给摘要，并列键照旧；协议换成状态写入段', async () => {
    const chat = mockChat();
    const { draft } = await turn(context(), false);
    expect(draft.treePatch).toBeDefined();
    const messages = chat.mock.calls[0][0].messages;
    const last = String(messages[messages.length - 1].content);
    const state = JSON.parse(last.match(/<direct_state>\n([\s\S]*?)\n<\/direct_state>/)![1]);
    // 缺席的并列键（地图、openingPrompt、plotSettings）在 JSON 里不出键
    expect(Object.keys(state)).toEqual(['stat_data', 'plot']);
    for (const key of ['characters', 'existingNames', 'variables', 'gameTime', 'affections'])
      expect(state).not.toHaveProperty(key);
    expect(state.stat_data['主角']['生命值']['当前']).toBe(80);
    expect(state.stat_data['关系列表']['艾拉']).toEqual({ 在场: false, 地点: '港口', 好感度: 3 });
    expect(last.endsWith(DIRECT_OUTPUT_REMINDER)).toBe(true);
    const system = String(messages[0].content);
    expect(system).toBe(buildDirectProtocol(false, 'tree'));
    expect(system).toContain(STATE_TREE_WRITE_PROTOCOL);
    expect(system).not.toContain('direct_updates 所有顶层键都必需');
    expect(system).toContain('tile_ops 每项含');
  });

  it('本轮输入点名的不在场角色给全量节点', async () => {
    const chat = mockChat();
    await turn(context({ userInput: '去找艾拉' }), false);
    const messages = chat.mock.calls[0][0].messages;
    const last = String(messages[messages.length - 1].content);
    const state = JSON.parse(last.match(/<direct_state>\n([\s\S]*?)\n<\/direct_state>/)![1]);
    expect(state.stat_data['关系列表']['艾拉']).toHaveProperty('档案');
  });

  it('缓存直出：分区键即树路径，协议文字换成树分区措辞', async () => {
    mockChat();
    const { result } = await turn(context(), true);
    const messages = result.requestMessages!;
    expect(String(messages[0].content)).toBe(
      `${buildDirectProtocol(false, 'tree')}\n${buildDirectCacheProtocol('tree')}`,
    );
    expect(buildDirectCacheProtocol('tree')).toContain(STATE_TREE_CACHE_PROTOCOL);
    expect(buildDirectCacheProtocol('legacy')).toBe(DIRECT_CACHE_PROTOCOL);
    const { set, remove } = directContext(messages);
    expect(remove).toEqual([]);
    expect(set).toHaveProperty('/主角/生命值');
    expect(set).toHaveProperty('/关系列表/艾拉');
    expect(set).toHaveProperty('/世界');
    expect(set).not.toHaveProperty('resources');
    expect(Object.keys(set).some((key) => key.startsWith('character/'))).toBe(false);
    expect(findOverlappingSections(Object.keys(set).filter((k) => k.startsWith('/')))).toBeNull();
  });

  async function acceptFirst(ctx: AgentContext) {
    const first = await turn(ctx, true);
    const accepted: ChatMessage[] = [
      { id: 'u1', saveId, role: 'user', content: ctx.userInput, timestamp: 1 },
      { id: 'a1', saveId, role: 'assistant', content: first.draft.content, timestamp: 2 },
    ];
    await acceptDirectContext(first.cache!.ticket, { acceptedMessages: accepted });
    return accepted;
  }

  it('缓存增量：摘要 → 全量切换时 remove 旧摘要分区、set 新的子键分区，互不重叠', async () => {
    mockChat();
    const history = await acceptFirst(context());
    const second = await turn(context({ history, characters: [player(), ella(true)] }), true);
    expect(second.cache!.ticket.rebaseReason).toBeUndefined();
    const { set, remove } = directContext(second.result.requestMessages!);
    expect(remove).toEqual(['/关系列表/艾拉']);
    expect(set).toHaveProperty('/关系列表/艾拉/档案');
    expect(set).toHaveProperty('/关系列表/艾拉/生命值');
    expect(findOverlappingSections(Object.keys(set))).toBeNull();
    // 艾拉的资源分区已在本次 set 里，尾部只重申未变的主角资源
    expect(Object.keys(turnContext(second.result.requestMessages!).current).sort()).toEqual(
      ['/主角/体力值', '/主角/法力值', '/主角/生命值'].sort(),
    );
  });

  it('缓存增量：全量 → 摘要切换时 remove 全部旧子键分区', async () => {
    mockChat();
    const history = await acceptFirst(context({ characters: [player(), ella(true)] }));
    const second = await turn(context({ history }), true);
    const { set, remove } = directContext(second.result.requestMessages!);
    expect(set['/关系列表/艾拉']).toEqual({ 在场: false, 地点: '港口', 好感度: 3 });
    expect(remove.length).toBeGreaterThan(1);
    expect(remove.every((key) => key.startsWith('/关系列表/艾拉/'))).toBe(true);
    expect(remove).toContain('/关系列表/艾拉/生命值');
  });

  it('缓存增量：分区消失即 remove（任务被删）；未变的在场资源分区在尾部重申', async () => {
    mockChat();
    const quest = { 寻找戒指: { name: '寻找戒指', status: '进行中' } as never };
    const history = await acceptFirst(
      context({ quests: quest, characters: [player(), ella(true)] }),
    );
    const second = await turn(context({ history, characters: [player(), ella(true)] }), true);
    const { remove } = directContext(second.result.requestMessages!);
    expect(remove).toEqual(['/任务列表/寻找戒指']);
    const current = turnContext(second.result.requestMessages!).current;
    expect(Object.keys(current).sort()).toEqual(
      [
        '/主角/体力值',
        '/主角/法力值',
        '/主角/生命值',
        '/关系列表/艾拉/体力值',
        '/关系列表/艾拉/法力值',
        '/关系列表/艾拉/生命值',
      ].sort(),
    );
  });

  it('切换协议让会话冷建一次', async () => {
    mockChat();
    setEngineSettingsProvider(() => ({ stateProtocol: 'legacy' }));
    const history = await acceptFirst(context());
    setEngineSettingsProvider(() => ({ stateProtocol: 'tree' }));
    const second = await turn(context({ history }), true);
    expect(second.cache!.ticket.rebaseReason).toBe('configuration_or_lore_changed');
  });
});
