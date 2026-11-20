/**
 * 直出结构化战斗开关（`directStructuredCombat`）专项测试。
 *
 * 关（默认）：战斗写在正文里，combat 区块不进协议契约、不进状态、不进缓存分区，
 * 模型写了也只丢弃并标记；提交时不触碰存档里休眠的战斗记录。
 * 开：与旧行为逐字节一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDirectOutput } from '../../../src/core/agents/direct-output';
import {
  generateDirectTurn,
  type DirectGenerationInput,
} from '../../../src/core/agents/direct-main';
import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  buildDirectCombat,
  isDirectStructuredCombatEnabled,
  readDirectCombat,
  type DirectCombatRecord,
} from '../../../src/core/combat/direct-combat';
import { buildDirectProtocol, createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import {
  acceptDirectContext,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';
import {
  getEngineSettings,
  setEngineSettingsProvider,
} from '../../../src/core/runtime/engine-settings';
import { createStateManager } from '../../../src/core/state/state-manager';
import {
  clearAllData,
  saveCharacter,
  saveMessages,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { getProfile, updateProfile } from '../../../src/core/state/save-profile';
import {
  createDefaultCharacterState,
  type AgentConfig,
  type AgentResult,
  type ApiEndpoint,
  type ChatMessage,
  type SaveSlot,
} from '../../../src/core/types/types';

const saveId = 'direct-structured-combat';
const OLD_COMBAT_LINE_HEAD = 'combat:null 表示无在办战斗；否则 {meta:';
const PROSE_COMBAT_LINE_HEAD = 'combat：恒填 null，不写任何战斗内容。当前未启用结构化战斗';

function updates(combat?: unknown, withCombatKey = true): Record<string, unknown> {
  return {
    version: 1,
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: {},
    ...(withCombatKey ? { combat } : {}),
    diceUsed: [],
  };
}
function raw(data: Record<string, unknown>): string {
  return `<maintext>你挥剑逼退了强盗。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify(data)}</direct_updates>`;
}
const FULL_COMBAT = {
  meta: { round: 1, combatType: '标准', environment: '街道', phase: 'active' },
  units: [
    {
      id: 'u-1',
      name: '旅人',
      origin: 'save',
      side: 'ally',
      hp: 50,
      mp: 80,
      sp: 40,
      statusEffects: [],
    },
  ],
};

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
  });
}

afterEach(() => {
  setEngineSettingsProvider(undefined);
  vi.restoreAllMocks();
});

describe('设置与协议', () => {
  it('directStructuredCombat 缺省为 false', () => {
    expect(getEngineSettings().directStructuredCombat).toBe(false);
    expect(isDirectStructuredCombatEnabled()).toBe(false);
    setEngineSettingsProvider(() => ({ directStructuredCombat: true }));
    expect(isDirectStructuredCombatEnabled()).toBe(true);
  });

  it('开启时协议含旧 combat 行；关闭时换成正文战斗说明且不再出现 phase:"active"', () => {
    const on = buildDirectProtocol(true);
    const off = buildDirectProtocol(false);
    expect(on).toContain(OLD_COMBAT_LINE_HEAD);
    expect(on).toContain('phase:"active"');
    expect(off).not.toContain(OLD_COMBAT_LINE_HEAD);
    expect(off).toContain(PROSE_COMBAT_LINE_HEAD);
    expect(off).not.toContain('phase:"active"');
    // 骨架里的 "combat":null 两种口径都保留，只有那一行不同
    expect(off).toContain('"combat":null');
    const onLines = on.split('\n');
    const offLines = off.split('\n');
    expect(offLines).toHaveLength(onLines.length);
    expect(onLines.filter((line, i) => line !== offLines[i])).toHaveLength(1);
  });

  it('两种口径都带正文分节一行；战斗逐拍只进正文战斗行', () => {
    const on = buildDirectProtocol(true);
    const off = buildDirectProtocol(false);
    for (const text of [on, off]) {
      const beatLine = text.split('\n').find((line) => line.startsWith('正文分节：'));
      expect(beatLine).toBeDefined();
      expect(beatLine).toContain('独占一行的 <beat/>');
      expect(beatLine).toContain('<beat enter="人物名"/>');
      expect(beatLine).toContain('已有实体的人物不写 enter');
    }
    expect(on).not.toContain('战斗逐拍');
    const proseLine = off.split('\n').find((line) => line.startsWith(PROSE_COMBAT_LINE_HEAD));
    expect(proseLine).toContain('战斗逐拍：一名角色的一次行为单独成一节');
    expect(proseLine).toContain('|行动者|名字|、|目标|名字或无|、|行动|技能或动作名|');
    expect(proseLine?.endsWith('临时敌人称呼前后一致。')).toBe(true);
  });

  it('关闭时 readDirectCombat 返回 null（记录休眠不删）', () => {
    const record = { sourceTurnKey: 'u', state: {} } as unknown as DirectCombatRecord;
    const profile = { worldFlags: { directCombat: record } } as never;
    expect(readDirectCombat(profile)).toBeNull();
    setEngineSettingsProvider(() => ({ directStructuredCombat: true }));
    expect(readDirectCombat(profile)).toBe(record);
  });
});

describe('关闭结构化战斗时的解析', () => {
  const off = { structuredCombat: false };

  it('缺少 combat 键也通过，combat 为 null 且不标记忽略', () => {
    const draft = parseDirectOutput(raw(updates(undefined, false)), 1, off);
    expect(draft.updates.combat).toBeNull();
    expect(draft.combatIgnored).toBeUndefined();
  });

  it('combat:null 通过且不标记忽略', () => {
    const draft = parseDirectOutput(raw(updates(null)), 1, off);
    expect(draft.updates.combat).toBeNull();
    expect(draft.combatIgnored).toBeUndefined();
  });

  it.each([
    ['垃圾字符串', 'oops'],
    ['数字', 42],
    ['完整战斗区块（内含禁止字段 id）', FULL_COMBAT],
  ])('combat 为%s时丢弃并标记 combatIgnored', (_label, combat) => {
    const draft = parseDirectOutput(raw(updates(combat)), 1, off);
    expect(draft.updates.combat).toBeNull();
    expect(draft.combatIgnored).toBe(true);
  });
});

describe('开启（缺省参数）时解析口径不变', () => {
  it('缺少 combat 键被拒', () => {
    expect(() => parseDirectOutput(raw(updates(undefined, false)), 1)).toThrow('v1 分区不完整');
  });
  it('combat 非对象被拒', () => {
    expect(() => parseDirectOutput(raw(updates('oops')), 1)).toThrow('combat 必须是对象');
  });
  it('combat 内含 id 被拒', () => {
    expect(() => parseDirectOutput(raw(updates(FULL_COMBAT)), 1)).toThrow('不允许模型填写 id');
  });
  it('combat 区块原样保留，不标记忽略', () => {
    const { id: _id, ...unit } = FULL_COMBAT.units[0];
    const combat = { ...FULL_COMBAT, units: [unit] };
    const draft = parseDirectOutput(raw(updates(combat)), 1, { structuredCombat: true });
    expect(draft.updates.combat).toEqual(combat);
    expect(draft.combatIgnored).toBeUndefined();
  });
});

function setup(): { input: DirectGenerationInput; client: AgentClient } {
  const endpoint: ApiEndpoint = {
    id: 'ep',
    name: 'test',
    provider: 'openai',
    protocol: 'openai-chat',
    baseUrl: 'https://invalid.example/v1',
    apiKey: '',
    defaultModel: 'test',
    models: ['test'],
    timeout: 1000,
  };
  const config: AgentConfig = {
    agentId: 'direct_main',
    enabled: true,
    apiEndpointId: endpoint.id,
    model: 'test',
    temperature: 0.7,
    maxTokens: 1000,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 1000,
    userId: 'test',
    historyLayers: 2,
    presetId: createDirectPreset().id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
  };
  const combat = {
    sourceTurnKey: 'old',
    state: {
      meta: { round: 2, combatType: '标准', environment: '街道', phase: 'active' },
      units: { 旅人: { name: '旅人', origin: 'save', hp: 10 } },
    },
  } as unknown as DirectCombatRecord;
  return {
    input: {
      config,
      endpoint,
      configs: [config],
      presets: [createDirectPreset()],
      worldBooks: [],
      combat,
      context: {
        userInput: '拔剑迎敌',
        characters: [player()],
        variables: {},
        history: [],
        memories: [],
        worldBooks: [],
        plotEvents: [],
        agentOutputs: new Map([['memory_recall', '']]),
      },
    },
    client: new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 }),
  };
}
function mockChat(text: string) {
  return vi
    .spyOn(AgentClient.prototype, 'chat')
    .mockImplementation(async (): Promise<AgentResult> => ({
      agentId: 'direct_main',
      output: text,
      rawResponse: text,
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
    }));
}
function block(content: unknown, tag: string): Record<string, unknown> {
  const match = String(content).match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

describe('generateDirectTurn：关闭结构化战斗', () => {
  it('非缓存：协议为正文战斗说明，<direct_state> 不含 combat，模型写的 combat 被忽略', async () => {
    const { input, client } = setup();
    const chat = mockChat(raw(updates(FULL_COMBAT)));
    const { draft } = await generateDirectTurn(input, client);
    expect(draft.combatIgnored).toBe(true);
    expect(draft.updates.combat).toBeNull();
    const messages = chat.mock.calls[0][0].messages;
    expect(String(messages[0].content)).toContain(PROSE_COMBAT_LINE_HEAD);
    const state = block(messages[messages.length - 1].content, 'direct_state');
    expect(state).not.toHaveProperty('combat');
  });

  it('开启时 <direct_state> 仍带 combat（显式开启的旧行为）', async () => {
    setEngineSettingsProvider(() => ({ directStructuredCombat: true }));
    const { input, client } = setup();
    input.combat = null;
    const chat = mockChat(raw(updates(null)));
    await generateDirectTurn(input, client);
    const messages = chat.mock.calls[0][0].messages;
    expect(String(messages[0].content)).toContain(OLD_COMBAT_LINE_HEAD);
    expect(block(messages[messages.length - 1].content, 'direct_state')).toHaveProperty(
      'combat',
      null,
    );
  });

  it('缓存：direct_context.set 与 turn_context.current 均无 combat，连续两楼前缀一致且不重建', async () => {
    invalidateDirectContext(saveId);
    const { input, client } = setup();
    input.cache = { saveId, policy: 'prefix' };
    mockChat(raw(updates(null)));
    const first = await generateDirectTurn(input, client);
    const firstMessages = first.result.requestMessages!;
    const firstRetained = firstMessages[first.cache!.ticket.retainedCount - 1];
    const firstContext = block(firstRetained.content, 'direct_context');
    expect(firstContext.set).not.toHaveProperty('combat');
    const firstTurn = block(firstMessages[firstMessages.length - 1].content, 'turn_context');
    expect((firstTurn.current as Record<string, unknown> | undefined) ?? {}).not.toHaveProperty(
      'combat',
    );
    await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });

    input.context.userInput = '乘胜追击';
    const second = await generateDirectTurn(input, client);
    expect(second.result.promptRebased).toBe(false);
    expect(second.cache!.ticket.rebaseReason).toBeUndefined();
    const retained = first.cache!.ticket.retainedCount;
    expect(second.result.requestMessages!.slice(0, retained)).toEqual(
      firstMessages.slice(0, retained),
    );
    const secondMessages = second.result.requestMessages!;
    const secondTurn = block(secondMessages[secondMessages.length - 1].content, 'turn_context');
    expect((secondTurn.current as Record<string, unknown> | undefined) ?? {}).not.toHaveProperty(
      'combat',
    );
    expect(JSON.stringify(secondMessages)).not.toContain('"phase":"active"');
    invalidateDirectContext(saveId);
  });
});

describe('commitDirectTurn：combat 缺省保留、null 清除', () => {
  function source(): ChatMessage[] {
    return [
      {
        id: 'u',
        saveId,
        role: 'user',
        content: '拔剑迎敌',
        timestamp: 1,
        storyTurnKey: 'u',
        storyTurnStatus: 'pending',
      },
      {
        id: 'a',
        saveId,
        role: 'assistant',
        content: '你挥剑逼退了强盗。',
        timestamp: 2,
        storyTurnKey: 'u',
        storyTurnStatus: 'pending',
      },
    ];
  }
  beforeEach(async () => {
    await clearAllData();
    await saveSaveSlot({
      id: saveId,
      name: 'Direct',
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
    await saveMessages(source());
    const profile = await getProfile(saveId);
    const battle = buildDirectCombat(
      {
        meta: { round: 1, combatType: '标准', environment: '街道', phase: 'active' },
        units: [
          { name: '旅人', origin: 'save', side: 'ally', hp: 50, mp: 80, sp: 40, statusEffects: [] },
        ],
      },
      null,
      [player()],
      [],
      'earlier',
    );
    profile.worldFlags.directCombat = battle.record;
    await updateProfile(profile);
  });

  it('combat 为 undefined 时不碰既有记录', async () => {
    await createStateManager(saveId).commitDirectTurn({
      patches: [],
      messages: source(),
      turnKey: 'u',
      isCurrent: () => true,
    });
    expect((await getProfile(saveId)).worldFlags.directCombat).toMatchObject({
      sourceTurnKey: 'earlier',
      state: { units: { 旅人: { hp: 50 } } },
    });
  });

  it('combat 为 null 时仍清除记录', async () => {
    await createStateManager(saveId).commitDirectTurn({
      patches: [],
      messages: source(),
      turnKey: 'u',
      combat: null,
      isCurrent: () => true,
    });
    expect((await getProfile(saveId)).worldFlags.directCombat).toBeNull();
  });
});
