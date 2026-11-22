import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDirectOutput,
  buildDirectPatches,
  type DirectUpdates,
} from '../../../src/core/agents/direct-output';
import { DirectTurnError, generateDirectTurn } from '../../../src/core/agents/direct-main';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import { AgentClient } from '../../../src/core/agents/agent-client';
import { AgentOrchestrator } from '../../../src/core/agents/agent-orchestrator';
import {
  buildDirectCombat,
  projectDirectCombatCharacters,
} from '../../../src/core/combat/direct-combat';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import {
  installDirectCacheStore,
  invalidateDirectContext,
  type DirectCacheRecord,
} from '../../../src/core/prompts/direct-context-session';
import { createStateManager } from '../../../src/core/state/state-manager';
import { GAME_EPOCH_YEAR, createDefaultTime } from '../../../src/core/time/time-system';
import { withSaveWriteLock } from '../../../src/core/state/state-write-queue';
import {
  getDatabase,
  clearAllData,
  saveSaveSlot,
  saveCharacter,
  saveMessages,
  getCharacters,
} from '../../../src/core/persistence/database';
import { getProfile } from '../../../src/core/state/save-profile';
import {
  createDefaultCharacterState,
  DEFAULT_AGENT_PIPELINE,
  type AgentContext,
  type AgentConfig,
  type AgentResult,
  type ApiEndpoint,
  type SaveSlot,
  type ChatMessage,
  type StatePatch,
} from '../../../src/core/types/types';
import { projectStreamingStory } from '../../../src/core/story/story-output';

const saveId = 'direct-test';
/** 解析用的最小骰池 */
const POOL: DirectDicePool = [{ sides: 20, values: [7] }];
function updates(): DirectUpdates {
  return {
    version: 1,
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: {},
    combat: null,
    diceUsed: [],
  };
}
function response(data = updates(), characters: unknown[] = []) {
  return `<maintext>你把材料交给铁匠。</maintext><options>1. 等待\n2. 离开</options><character_updates>${JSON.stringify({ characters })}</character_updates><direct_updates>${JSON.stringify(data)}</direct_updates>`;
}
/** 一个完整的新人物实体（铁匠），供人物创建与路径报错用例共用 */
function smithEntity(): DirectUpdates['entities'][number] {
  return {
    kind: 'character',
    placement: { location: '铁匠铺', present: true },
    output: {
      skills: [],
      equipment: [],
      inventory: [],
      character: {
        name: '铁匠',
        race: '人类',
        gender: '男',
        tier: 1,
        level: 1,
        attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
        identity: ['铁匠'],
        occupation: [],
        background: '在城里长大',
        appearance: '围裙',
        clothing: '工作服',
        personality: '直率',
        likes: '打铁',
        skills: [],
        equipment: [],
        inventory: [],
        ascension: {
          enabled: false,
          path: '',
          description: '',
          elements: [],
          authorities: [],
          laws: [],
        } as any,
      },
    },
  };
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
    inventory: [{ name: '铁', quantity: 2 }],
  });
}
function source(): ChatMessage[] {
  return [
    {
      id: 'u',
      saveId,
      role: 'user',
      content: '制作短剑',
      timestamp: 1,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
    {
      id: 'a',
      saveId,
      role: 'assistant',
      content: '短剑做好了',
      timestamp: 2,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
  ];
}
async function fixture() {
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
  await getProfile(saveId);
}
beforeEach(async () => {
  await clearAllData();
});
afterEach(() => vi.restoreAllMocks());

describe('direct protocol and native entities', () => {
  it('projects prose, hides partial JSON, rejects incomplete blocks, drops conflicting rows', () => {
    const raw = response();
    expect(parseDirectOutput(raw, POOL)).toMatchObject({
      content: '你把材料交给铁匠。',
      options: ['等待', '离开'],
    });
    expect(projectStreamingStory(raw.slice(0, -12))).not.toContain('direct_updates');
    expect(() => parseDirectOutput(raw.replace('</direct_updates>', ''), POOL)).toThrow();
    expect(() => parseDirectOutput(raw + '<direct_updates>{}</direct_updates>', POOL)).toThrow();
    const data = updates();
    data.state = {
      characters: {
        replace: [{ name: '旅人', path: 'hp', value: 70 }],
        delta: [{ name: '旅人', path: 'hp', amount: -10 }],
      },
    };
    const conflict = parseDirectOutput(response(data), POOL);
    expect(conflict.content).toBe('你把材料交给铁匠。');
    expect((conflict.updates.state as any).characters).toEqual({
      replace: [{ name: '旅人', path: 'hp', value: 70 }],
      delta: [],
    });
    expect(conflict.dropped).toEqual(['state.characters.delta[0]：人物字段重复声明，已忽略']);
    data.state = {
      characters: { replace: [{ name: '旅人', path: 'generationMode', value: 'agent' }] },
    };
    expect(parseDirectOutput(response(data), POOL).dropped).toEqual([
      'state.characters.replace[0]：人物字段不属于 direct state 白名单，已忽略',
    ]);
    data.state = {};
    data.diceUsed = [
      { sides: 20, index: 0, purpose: '制作', target: '短剑' },
      { sides: 20, index: 0, purpose: '重投', target: '短剑' },
    ];
    const dice = parseDirectOutput(response(data), POOL);
    expect(dice.updates.diceUsed).toEqual([
      { sides: 20, index: 0, purpose: '制作', target: '短剑' },
    ]);
    expect(dice.dropped).toEqual(['diceUsed[1]：重复使用了同一颗骰，已忽略']);
  });

  it('creates a complete new NPC with author binding and drops narrative-only NPC updates', () => {
    const data = updates();
    data.entities.push(smithEntity());
    const narrative = [{ name: '铁匠', profile_changes: { personality: '直率' }, chronicle: [] }];
    const draft = parseDirectOutput(response(data, narrative), POOL);
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [
        {
          id: 'author-smith',
          name: '铁匠',
          profile: { personality: '谨慎' },
          assets: { portrait: 'smith.png' },
          initialChronicle: [],
        } as any,
      ],
      sourceTurnKey: 'u',
    });
    expect(built.characters[1]).toMatchObject({
      name: '铁匠',
      location: '铁匠铺',
      present: true,
      introducedBy: 'u',
      definition: { id: 'author-smith' },
    });
    expect(built.characters[1].maxHp).toBeGreaterThan(0);
    expect(built.characterUpdates.map((update) => update.name)).toEqual(['铁匠']);
    expect(built.dropped).toEqual([]);
    const noEntity = parseDirectOutput(response(updates(), narrative), POOL);
    const orphan = buildDirectPatches(noEntity, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    expect(orphan.characterUpdates).toEqual([]);
    expect(orphan.dropped).toEqual(['character_updates：人物 铁匠 缺少完整实体，已忽略']);
  });
});

describe('direct protocol: 丢弃说明带键名与路径', () => {
  it('direct_updates 顶层多余键剥除并列出键名，其余照收', () => {
    const data = { ...updates(), extraTop: 1 } as unknown as DirectUpdates;
    const draft = parseDirectOutput(response(data), POOL);
    expect(draft.content).toBe('你把材料交给铁匠。');
    expect(draft.updates).not.toHaveProperty('extraTop');
    expect(draft.dropped).toEqual(['direct_updates：含未支持的字段 extraTop，已剥除']);
  });

  it('实体 output 多余键带下标路径，实体照建', () => {
    const data = updates();
    const entity = smithEntity();
    (entity.output as unknown as Record<string, unknown>).bogus = true;
    data.entities.push(entity);
    const draft = parseDirectOutput(response(data), POOL);
    expect(draft.dropped).toEqual(['entities[0].output：含未支持的字段 bogus，已剥除']);
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    expect(built.characters.map((c) => c.name)).toEqual(['旅人', '铁匠']);
  });

  it('skills 非数组时按所在路径换成 []', () => {
    const nested = updates();
    const inner = smithEntity();
    (inner.output.character as unknown as Record<string, unknown>).skills = '剑术';
    nested.entities.push(inner);
    expect(parseDirectOutput(response(nested), POOL).dropped).toEqual([
      'entities[0].output.character.skills：必须是数组，已忽略',
    ]);

    const top = updates();
    const outer = smithEntity();
    (outer.output as unknown as Record<string, unknown>).skills = '剑术';
    top.entities.push(outer);
    const draft = parseDirectOutput(response(top), POOL);
    expect(draft.dropped).toEqual(['entities[0].output.skills：必须是数组，已忽略']);
    expect(draft.updates.entities[0].output.skills).toEqual([]);
  });

  it('多余键最多列 5 个并截断超长键名', () => {
    const extra: Record<string, number> = {};
    for (let i = 1; i <= 8; i++) extra[`k${i}`] = i;
    const many = { ...updates(), ...extra } as unknown as DirectUpdates;
    let message = parseDirectOutput(response(many), POOL).dropped!.join('\n');
    expect(message).toContain('k1、k2、k3、k4、k5');
    expect(message).not.toContain('k6');
    expect(message).toContain('等 8 个');

    const longKey = 'x'.repeat(100);
    const long = { ...updates(), [longKey]: 1 } as unknown as DirectUpdates;
    message = parseDirectOutput(response(long), POOL).dropped!.join('\n');
    expect(message).toContain(`${'x'.repeat(24)}…`);
    expect(message).not.toContain('x'.repeat(25));
  });

  it('direct_updates 内容非法 JSON 时给出明确原因', () => {
    const raw = response().replace(
      /<direct_updates>[\s\S]*<\/direct_updates>/,
      '<direct_updates>{坏掉的</direct_updates>',
    );
    expect(() => parseDirectOutput(raw, POOL)).toThrow(
      '直出结果无效：direct_updates 不是合法 JSON',
    );
  });
});

describe('direct rejected output keeps the raw reply', () => {
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
  function generate(
    overrides: Partial<AgentContext> = {},
    configOverrides: Partial<AgentConfig> = {},
  ) {
    const turnConfig = { ...config, ...configOverrides };
    const context: AgentContext = {
      userInput: '继续',
      characters: [player()],
      variables: {},
      history: [],
      worldBooks: [],
      memories: [],
      plotEvents: [],
      agentOutputs: new Map(),
      ...overrides,
    };
    return generateDirectTurn(
      {
        config: turnConfig,
        endpoint,
        context,
        configs: [turnConfig],
        worldBooks: [],
        presets: [createDirectPreset()],
        combat: null,
      },
      new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 }),
    );
  }

  it('被拒输出抛 DirectTurnError 并带原文与请求消息', async () => {
    const raw = '<maintext>只有正文</maintext><direct_updates>{坏掉的</direct_updates>';
    const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: raw,
      rawResponse: raw,
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
    });
    const error = await generate().catch((e: unknown) => e);
    // 其它解析失败不重试
    expect(chat).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DirectTurnError);
    const failed = error as DirectTurnError;
    expect(failed.message).toContain('direct_updates 不是合法 JSON');
    expect(failed.result.rawResponse).toBe(raw);
    expect(failed.result.requestMessages?.length).toBeGreaterThan(0);
  });

  it('provider 返回 error 结果时同样带上 result', async () => {
    const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: null,
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
      error: 'HTTP 503',
    });
    const error = await generate().catch((e: unknown) => e);
    // provider error 结果正文也为空，但不走空正文重试
    expect(chat).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DirectTurnError);
    expect((error as DirectTurnError).message).toContain('HTTP 503');
    expect((error as DirectTurnError).result.error).toBe('HTTP 503');
    expect((error as DirectTurnError).result.requestMessages?.length).toBeGreaterThan(0);
  });

  /** 只有思考、没有正文的回复 */
  function emptyReply(overrides: Partial<AgentResult> = {}): AgentResult {
    return {
      agentId: 'direct_main',
      output: '',
      rawResponse: '',
      reasoning: '先想想铁匠会怎么回应。',
      tokensUsed: 7000,
      cacheHit: false,
      completionTokens: 6805,
      finishReason: 'stop',
      duration: 5,
      ...overrides,
    };
  }
  function fullReply(): AgentResult {
    const raw = response();
    return {
      agentId: 'direct_main',
      output: raw,
      rawResponse: raw,
      tokensUsed: 100,
      cacheHit: false,
      completionTokens: 50,
      finishReason: 'stop',
      duration: 2,
    };
  }

  it('空正文先自动重试一次，第二次有正文则正常接纳', async () => {
    const chat = vi
      .spyOn(AgentClient.prototype, 'chat')
      .mockResolvedValueOnce(emptyReply())
      .mockResolvedValueOnce(fullReply());
    const generated = await generate();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0]).toBe(chat.mock.calls[0][0]);
    expect(generated.draft.content).toBe('你把材料交给铁匠。');
    const rounds = generated.result.providerRounds!;
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round: 1, finishReason: 'stop', completionTokens: 6805 });
    expect(rounds[0].error).toMatch(/^模型返回了空正文/);
    expect(rounds[1]).toMatchObject({ round: 2, completionTokens: 50 });
    expect(rounds[1].error).toBeUndefined();
    // 顶层计量只记最终那次，不累加
    expect(generated.result.tokensUsed).toBe(100);
  });

  it('两次都是空正文：抛 DirectTurnError，报错写明只有思考与结束原因', async () => {
    const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue(emptyReply());
    const error = await generate().catch((e: unknown) => e);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(DirectTurnError);
    const failed = error as DirectTurnError;
    expect(failed.message).toMatch(/^模型返回了空正文：只输出了思考（约 \d+ 字）/);
    expect(failed.message).toContain('结束原因：stop');
    expect(failed.message).toContain('输出 6805 token');
    expect(failed.message).toContain('已自动重试 1 次仍为空');
    expect(failed.message).not.toContain('direct_updates');
    expect(failed.message).not.toContain('直出结果无效');
    expect(failed.result.reasoning).toBe('先想想铁匠会怎么回应。');
    expect(failed.result.providerRounds).toHaveLength(2);
    expect(failed.result.providerRounds![1].error).toBe(failed.message);
  });

  it('纯空白正文同样按空正文处理', async () => {
    const chat = vi
      .spyOn(AgentClient.prototype, 'chat')
      .mockResolvedValue(emptyReply({ rawResponse: ' \n\t ', output: ' \n\t ', reasoning: '' }));
    const error = await generate().catch((e: unknown) => e);
    expect(chat).toHaveBeenCalledTimes(2);
    expect((error as Error).message).toMatch(/^模型返回了空正文：没有任何输出。/);
  });

  it('结束原因为 length 的空正文不重试', async () => {
    const chat = vi
      .spyOn(AgentClient.prototype, 'chat')
      .mockResolvedValue(emptyReply({ finishReason: 'length' }));
    const error = await generate().catch((e: unknown) => e);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DirectTurnError);
    const failed = error as DirectTurnError;
    expect(failed.message).toMatch(/^模型返回了空正文/);
    expect(failed.message).toContain('结束原因：length');
    expect(failed.message).toContain('已达到输出上限');
    expect(failed.message).not.toContain('已自动重试');
    expect(failed.result.providerRounds).toBeUndefined();
  });

  it('首次空正文后已取消：不再发第二次请求，原样抛取消错误', async () => {
    const controller = new AbortController();
    const chat = vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async () => {
      controller.abort();
      return emptyReply();
    });
    const error = await generate({}, { abortSignal: controller.signal }).catch((e: unknown) => e);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(error).not.toBeInstanceOf(DirectTurnError);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('重试请求传输失败：按普通传输失败上报，不带第一次的结果', async () => {
    const chat = vi
      .spyOn(AgentClient.prototype, 'chat')
      .mockResolvedValueOnce(emptyReply())
      .mockRejectedValueOnce(new Error('网络中断'));
    const error = await generate().catch((e: unknown) => e);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(error).not.toBeInstanceOf(DirectTurnError);
    expect((error as Error).message).toBe('网络中断');
  });

  it('direct_state 里的年龄按游戏时间现算，不带冻结年龄与原始锚点', async () => {
    vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: null,
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
      error: 'HTTP 503',
    });
    const aged = {
      ...player(),
      ageAnchor: { startAge: 18, month: 3, day: 15 },
      customFields: { age: 18, birthday: '3月15日' },
    };
    const error = (await generate({
      characters: [aged],
      gameTime: { ...createDefaultTime(), year: GAME_EPOCH_YEAR + 1, month: 3, day: 15 },
    }).catch((e: unknown) => e)) as DirectTurnError;
    const messages = error.result.requestMessages!;
    const last = messages[messages.length - 1];
    const content = typeof last.content === 'string' ? last.content : '';
    const state = JSON.parse(content.match(/<direct_state>\n([\s\S]*?)\n<\/direct_state>/)![1]);
    const projected = state.characters[0];
    expect(projected.age).toBe(20);
    expect(projected.birthday).toBe('3月15日');
    expect(projected).not.toHaveProperty('ageAnchor');
    expect(projected.customFields).toEqual({});
  });
});

describe('atomic direct acceptance', () => {
  const craft: StatePatch[] = [
    { op: 'remove_item' as const, target: 'characters.旅人', value: { name: '铁', quantity: 2 } },
    {
      op: 'add_item' as const,
      target: 'characters.旅人',
      value: {
        name: '短剑',
        quantity: 1,
        type: '装备',
        protocolText: '命中时造成额外伤害',
        tags: ['锋利'],
      },
    },
    { op: 'delta_variable' as const, target: 'profile.fp', amount: 3 },
  ];
  function commit(patches = craft, isCurrent = () => true) {
    return createStateManager(saveId).commitDirectTurn({
      patches,
      messages: source(),
      turnKey: 'u',
      combat: null,
      isCurrent,
    });
  }
  it('commits materials, native inventory, rewards and messages once, and restores everything on a message write failure', async () => {
    await fixture();
    const before = (await getProfile(saveId)).fp;
    const failure = vi
      .spyOn(getDatabase().messages, 'bulkPut')
      .mockRejectedValueOnce(new Error('disk failure'));
    await expect(commit()).rejects.toThrow('disk failure');
    failure.mockRestore();
    expect((await getCharacters(saveId))[0].inventory).toEqual([{ name: '铁', quantity: 2 }]);
    expect((await getProfile(saveId)).fp).toBe(before);
    expect(await commit()).toBe('committed');
    expect(await commit()).toBe('already-accepted');
    expect((await getCharacters(saveId))[0].inventory).toMatchObject([
      { name: '短剑', quantity: 1, protocolText: '命中时造成额外伤害', tags: ['锋利'] },
    ]);
    expect((await getProfile(saveId)).fp).toBe(before + 3);
    expect(
      (await getDatabase().messages.toArray()).every((m) => m.storyTurnStatus === 'accepted'),
    ).toBe(true);
  });
  it('rejects insufficient materials before accepting the floor', async () => {
    await fixture();
    await expect(
      commit([{ ...craft[0], value: { name: '铁', quantity: 3 } }, ...craft.slice(1)]),
    ).rejects.toThrow('数量不足');
    expect((await getCharacters(saveId))[0].inventory).toEqual([{ name: '铁', quantity: 2 }]);
    expect((await getDatabase().messages.get('a'))?.storyTurnStatus).toBe('pending');
  });
  it('rechecks cancellation after waiting for another save write', async () => {
    await fixture();
    let release!: () => void;
    let held!: () => void;
    const started = new Promise<void>((resolve) => {
      held = resolve;
    });
    const lock = withSaveWriteLock(saveId, async () => {
      held();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    let current = true;
    const pending = commit(craft, () => current);
    const assertion = expect(pending).rejects.toThrow('取消');
    current = false;
    release();
    await lock;
    await assertion;
    expect((await getCharacters(saveId))[0].inventory[0].quantity).toBe(2);
  });
});

describe('direct combat across floors', () => {
  it('projects active resources without mutating saved characters, requires all units, and settles exact statuses without duplicate rewards', async () => {
    await fixture();
    const p = player();
    p.statusEffects = [
      {
        name: '护盾',
        category: '增益',
        description: '防护',
        stacks: 2,
        remainingTime: 4,
        timeUnit: '回合',
        source: '',
        effects: {},
        protocolText: '减少伤害',
      },
    ];
    await saveCharacter(p);
    const output = {
      meta: { round: 1, combatType: '标准', environment: '街道', phase: 'active' },
      units: [
        {
          name: p.name,
          origin: 'save',
          side: 'ally',
          hp: 60,
          mp: 80,
          sp: 50,
          statusEffects: [
            { ...p.statusEffects[0], stacks: 1, remainingTime: 2 },
            {
              name: '燃烧',
              category: '减益',
              stacks: 1,
              remainingTime: 2,
              timeUnit: '回合',
              protocolText: '每回合失去 5 HP',
              tags: ['火焰'],
            },
          ],
        },
      ],
    } as const;
    const active = buildDirectCombat(output as any, null, [p], [], 'u');
    expect(projectDirectCombatCharacters([p], active.record)[0].hp).toBe(60);
    expect(p.hp).toBe(80);
    expect(projectDirectCombatCharacters([p], active.record)[0].statusEffects[0].protocolText).toBe(
      '减少伤害',
    );
    expect(() => buildDirectCombat(null, active.record, [p], [], 'v')).toThrow('进行中');
    expect(() =>
      buildDirectCombat(
        output as any,
        null,
        [p],
        [{ op: 'delta_hp', target: `characters.${p.name}`, amount: -20 }],
        'u',
      ),
    ).toThrow('只能');
    const end = buildDirectCombat(
      { ...output, meta: { ...output.meta, round: 2, phase: 'ended', outcome: 'ally_win' } } as any,
      active.record,
      [p],
      [],
      'u',
    );
    await createStateManager(saveId).commitDirectTurn({
      patches: end.patches,
      combat: end.record,
      messages: source(),
      turnKey: 'u',
      isCurrent: () => true,
    });
    const saved = (await getCharacters(saveId))[0];
    expect(saved).toMatchObject({ hp: 60, mp: 80, sp: 50, totalExp: p.totalExp });
    expect(saved.statusEffects).toMatchObject([
      { name: '护盾', stacks: 1, remainingTime: 2, protocolText: '减少伤害' },
      { name: '燃烧', protocolText: '每回合失去 5 HP', tags: ['火焰'] },
    ]);
  });
});

describe('single non-memory request', () => {
  it.each([false, true])(
    'sends full context once without tools or a lore selector (Story v2=%s)',
    async (v2) => {
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
      const context: AgentContext = {
        userInput: '制作唯一短剑',
        openingPrompt: '制作唯一短剑',
        characters: [player()],
        characterDefinitions: [],
        variables: {},
        history: [],
        worldBooks: [],
        memories: [],
        plotEvents: [],
        agentOutputs: new Map([['memory_recall', '召回事实']]),
      };
      const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
        agentId: 'direct_main',
        output: response(),
        rawResponse: response(),
        tokensUsed: 0,
        cacheHit: false,
        duration: 1,
      });
      const result = await generateDirectTurn(
        {
          config,
          endpoint,
          context,
          configs: [config],
          worldBooks: [],
          presets: [createDirectPreset()],
          combat: null,
          ...(v2 ? { storyContext: { windowTurns: 2, segments: [], archives: [] } } : {}),
        },
        new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 }),
      );
      expect(result.draft.content).toContain('铁匠');
      expect(chat).toHaveBeenCalledTimes(1);
      const request = chat.mock.calls[0][0];
      expect(request.tools).toBeUndefined();
      const rendered = JSON.stringify(request.messages);
      expect(rendered.match(/制作唯一短剑/g)).toHaveLength(1);
      expect(rendered).toContain('召回事实');
      expect(rendered).toContain('铁');
      expect(rendered).toContain('character_updates');
      expect(rendered).toContain('direct_updates');
    },
  );
});

describe('direct memory admission', () => {
  function orchestrator(v2 = false) {
    const endpoint: ApiEndpoint = {
      id: 'recall-gate',
      name: 'Test',
      provider: 'openai',
      baseUrl: 'https://invalid.example/v1',
      apiKey: '',
      defaultModel: 'test',
      models: ['test'],
      timeout: 1000,
    };
    const agentConfigs: AgentConfig[] = ['memory_recall', 'direct_main'].map((agentId) => ({
      agentId,
      enabled: true,
      apiEndpointId: endpoint.id,
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      model: 'test',
      maxTokens: 1000,
      temperature: 0.7,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      retryOnFail: false,
      timeout: 1000,
      userId: 'test',
    }));
    const context: AgentContext = {
      userInput: '继续',
      characters: [player()],
      variables: {},
      history: [],
      worldBooks: [],
      memories: [],
      plotEvents: [],
      agentOutputs: new Map(),
    };
    const onAgentComplete = vi.fn();
    const onAgentStart = vi.fn();
    const onAgentError = vi.fn();
    const instance = new AgentOrchestrator(
      {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context,
        saveId,
        endpoints: [endpoint],
        agentConfigs,
        ...(v2 ? { storyContext: { windowTurns: 2, segments: [], archives: [] } } : {}),
      },
      { onAgentComplete, onAgentStart, onAgentError },
    );
    return { instance, context, onAgentComplete, onAgentStart, onAgentError };
  }

  it('被拒输出：调试回调收到原文与请求消息，向下游抛原始错误', async () => {
    const { instance, onAgentError } = orchestrator(true);
    const raw = '<maintext>只有正文</maintext><direct_updates>{坏掉的</direct_updates>';
    vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: raw,
      rawResponse: raw,
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
    });
    const error = await instance.runDirect(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DirectTurnError);
    expect((error as Error).message).toContain('直出结果无效');
    expect(onAgentError).toHaveBeenCalledWith(
      'direct_main',
      expect.stringContaining('直出结果无效'),
      expect.objectContaining({ rawResponse: raw, requestMessages: expect.any(Array) }),
    );
  });

  it('runDirect: 空正文两次：调试回调收到思考与结束原因，向下游抛原始错误', async () => {
    const { instance, onAgentError } = orchestrator(true);
    vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: '',
      rawResponse: '',
      reasoning: '只想不写',
      tokensUsed: 10,
      cacheHit: false,
      completionTokens: 8,
      finishReason: 'stop',
      duration: 1,
    });
    const error = await instance.runDirect(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DirectTurnError);
    expect((error as Error).message).toMatch(/^模型返回了空正文/);
    expect(onAgentError).toHaveBeenCalledWith(
      'direct_main',
      expect.stringContaining('结束原因：stop'),
      expect.objectContaining({ reasoning: '只想不写', finishReason: 'stop' }),
    );
  });

  it('请求直接失败（无回复）时调试回调第三参为 undefined', async () => {
    const { instance, onAgentError } = orchestrator(true);
    vi.spyOn(AgentClient.prototype, 'chat').mockRejectedValue(new Error('网络中断'));
    await expect(instance.runDirect(null)).rejects.toThrow('网络中断');
    expect(onAgentError).toHaveBeenCalledWith('direct_main', '网络中断', undefined);
  });

  it.each([undefined, 'prefix'] as const)(
    'blocks main generation after legacy recall fails (cache=%s)',
    async (cachePolicy) => {
      const { instance, context, onAgentComplete, onAgentStart } = orchestrator();
      const chat = vi
        .spyOn(AgentClient.prototype, 'chat')
        .mockResolvedValue({
          agentId: 'direct_main',
          output: response(),
          rawResponse: response(),
          tokensUsed: 0,
          cacheHit: false,
          duration: 1,
        })
        .mockResolvedValueOnce({
          agentId: 'memory_recall',
          output: null,
          rawResponse: '',
          tokensUsed: 0,
          cacheHit: false,
          duration: 1,
          error: 'HTTP 503',
        });
      await expect(instance.runDirect(null, cachePolicy)).rejects.toThrow('HTTP 503');
      expect(chat).toHaveBeenCalledTimes(1);
      expect(onAgentComplete).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'memory_recall', error: 'HTTP 503' }),
      );
      expect(onAgentStart.mock.calls.map(([agentId]) => agentId)).toEqual(['memory_recall']);
      expect(context.agentOutputs.has('story')).toBe(false);
    },
  );

  it.each([undefined, 'prefix'] as const)(
    'keeps the v2 empty recall result non-blocking (cache=%s)',
    async (cachePolicy) => {
      const { instance, context, onAgentComplete } = orchestrator(true);
      const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
        agentId: 'direct_main',
        output: response(),
        rawResponse: response(),
        tokensUsed: 0,
        cacheHit: false,
        duration: 1,
      });
      await expect(instance.runDirect(null, cachePolicy)).resolves.toMatchObject({
        content: '你把材料交给铁匠。',
      });
      expect(onAgentComplete.mock.calls[0][0]).toMatchObject({
        agentId: 'memory_recall',
        output: '',
      });
      expect(onAgentComplete.mock.calls[0][0].error).toBeUndefined();
      expect(chat).toHaveBeenCalledTimes(1);
      expect(context.agentOutputs.get('story')).toBe('你把材料交给铁匠。');
    },
  );

  it('接纳缓存回合时会话历史只追加玩家看到的正文', async () => {
    let record: DirectCacheRecord | undefined;
    installDirectCacheStore({
      load: async () => undefined,
      save: async (value) => {
        record = structuredClone(value);
      },
      delete: async () => {},
    });
    invalidateDirectContext(saveId);
    try {
      const { instance } = orchestrator(true);
      vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
        agentId: 'direct_main',
        output: response(),
        rawResponse: response(),
        tokensUsed: 0,
        cacheHit: false,
        duration: 1,
      });
      await instance.runDirect(null, 'prefix');
      await instance.acceptDirectCache([
        { id: 'u1', role: 'user', content: '继续', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '你把材料交给铁匠。', timestamp: 2 },
      ]);
      const last = record!.transcript[record!.transcript.length - 1];
      expect(last).toEqual({ role: 'assistant', content: '你把材料交给铁匠。' });
      // 原始回复（含 <maintext> 外壳与状态块）不进历史
      const assistants = record!.transcript.filter((m) => m.role === 'assistant');
      expect(assistants.some((m) => m.content?.includes('<maintext>') || m.native)).toBe(false);
      expect(JSON.stringify(record!.transcript)).not.toContain('<turn_context>');
    } finally {
      installDirectCacheStore();
      invalidateDirectContext(saveId);
    }
  });
});

it('persists active combat in snapshots and remaps its source when importing a direct save', async () => {
  await fixture();
  const manager = createStateManager(saveId);
  const baseline = await manager.createSnapshot('manual', 0);
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
    'u',
  );
  await manager.commitDirectTurn({
    patches: [],
    combat: battle.record,
    messages: source(),
    turnKey: 'u',
    isCurrent: () => true,
  });
  await manager.advanceTurn();
  const { exportSessionSave, importSessionSave } =
    await import('../../../src/core/persistence/session-backup');
  const backup = await exportSessionSave(saveId);
  const imported = await importSessionSave(backup);
  const saved = await exportSessionSave(imported.saveId);
  expect(saved.save.metadata.generationMode).toBe('direct');
  const key = saved.messages.find((m) => m.role === 'user')!.id;
  expect(key).not.toBe('u');
  expect(saved.profile!.worldFlags.directCombat).toMatchObject({
    sourceTurnKey: key,
    state: { units: { 旅人: { hp: 50 } } },
  });
  expect(
    saved.snapshotPayloads.some(
      (snapshot) => snapshot.saveProfile?.worldFlags.directCombat?.sourceTurnKey === key,
    ),
  ).toBe(true);
  expect((await manager.restoreSnapshot(baseline.id)).success).toBe(true);
  expect((await getProfile(saveId)).worldFlags.directCombat).toBeUndefined();
});

describe('direct protocol: gametxt 同义正文信封', () => {
  const swap = (raw: string) => raw.replace(/maintext/g, 'gametxt');

  it('只有 gametxt 的回复通过，内容与 maintext 版一致', () => {
    const raw = response();
    const { raw: gametxtRaw, ...gametxt } = parseDirectOutput(swap(raw), POOL);
    const { raw: maintextRaw, ...maintext } = parseDirectOutput(raw, POOL);
    expect(gametxt).toEqual(maintext);
    expect(gametxtRaw).toBe(swap(maintextRaw));
  });

  it('maintext 包裹 gametxt 通过', () => {
    const raw = response().replace(
      '<maintext>你把材料交给铁匠。</maintext>',
      '<maintext><gametxt>你把材料交给铁匠。</gametxt></maintext>',
    );
    expect(parseDirectOutput(raw, POOL)).toMatchObject({ content: '你把材料交给铁匠。' });
  });

  it('两个 <gametxt 开标签被拒', () => {
    const raw = swap(response()).replace('<gametxt>', '<gametxt>前文</gametxt><gametxt>');
    expect(() => parseDirectOutput(raw, POOL)).toThrow('需要一个完整的 maintext（或 gametxt）区块');
  });

  it('gametxt 缺闭标签被拒', () => {
    const raw = swap(response()).replace('</gametxt>', '');
    expect(() => parseDirectOutput(raw, POOL)).toThrow('需要一个完整的 maintext（或 gametxt）区块');
  });
});

describe('直出骰池：按骰面分组定位', () => {
  const pool: DirectDicePool = [
    { sides: 6, values: [3, 5] },
    { sides: 20, values: [7, 18] },
  ];
  function withDice(diceUsed: unknown[]): string {
    const data = updates();
    data.diceUsed = diceUsed as DirectUpdates['diceUsed'];
    return response(data);
  }

  it('同一下标在不同骰面上可各用一次', () => {
    const draft = parseDirectOutput(
      withDice([
        { sides: 6, index: 1, purpose: '伤害', target: '狼' },
        { sides: 20, index: 1, purpose: '命中', target: '狼' },
      ]),
      pool,
    );
    expect(draft.updates.diceUsed).toEqual([
      { sides: 6, index: 1, purpose: '伤害', target: '狼' },
      { sides: 20, index: 1, purpose: '命中', target: '狼' },
    ]);
  });

  /** 一颗骰的行被丢弃：其余骰照收，正文照收 */
  function droppedDice(rows: unknown[]): string[] {
    const draft = parseDirectOutput(
      withDice([...rows, { sides: 20, index: 1, purpose: '命中', target: '狼' }]),
      pool,
    );
    expect(draft.content).toBe('你把材料交给铁匠。');
    expect(draft.updates.diceUsed).toEqual([
      { sides: 20, index: 1, purpose: '命中', target: '狼' },
    ]);
    return draft.dropped ?? [];
  }

  it('骰面数不在骰池中时丢那一行', () => {
    expect(droppedDice([{ sides: 8, index: 0, purpose: '伤害', target: '狼' }])).toEqual([
      'diceUsed[0]：骰面数不在骰池中，已忽略',
    ]);
  });

  it('缺少 sides 的行丢弃', () => {
    expect(droppedDice([{ index: 0, purpose: '命中', target: '狼' }])).toEqual([
      'diceUsed[0]：骰面数不在骰池中，已忽略',
    ]);
  });

  it('下标超出对应骰组长度时丢那一行', () => {
    expect(droppedDice([{ sides: 6, index: 2, purpose: '伤害', target: '狼' }])).toEqual([
      'diceUsed[0]：骰索引超出 d6 骰组范围，已忽略',
    ]);
    expect(droppedDice([{ sides: 20, index: -1, purpose: '命中', target: '狼' }])).toHaveLength(1);
    expect(droppedDice([{ sides: 20, index: 0.5, purpose: '命中', target: '狼' }])).toHaveLength(1);
  });

  it('用途与对象仍须具名，否则丢那一行', () => {
    expect(droppedDice([{ sides: 20, index: 0, purpose: '', target: '狼' }])).toEqual([
      'diceUsed[0]：purpose 名字／引用不能为空，已忽略',
    ]);
  });
});

describe('直出骰池：请求注入', () => {
  const pool: DirectDicePool = [
    { sides: 6, values: [3, 5] },
    { sides: 20, values: [7, 18, 1] },
  ];
  const lines = ['d6: {3, 5}', 'd20: {7, 18, 1}'];
  function setup() {
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
    const context: AgentContext = {
      userInput: '挥剑',
      characters: [player()],
      characterDefinitions: [],
      variables: {},
      history: [],
      worldBooks: [],
      memories: [],
      plotEvents: [],
      agentOutputs: new Map([['memory_recall', '']]),
    };
    const chat = vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
      agentId: 'direct_main',
      output: response(),
      rawResponse: response(),
      tokensUsed: 0,
      cacheHit: false,
      duration: 1,
    });
    const input = {
      config,
      endpoint,
      context,
      configs: [config],
      worldBooks: [],
      presets: [createDirectPreset()],
      combat: null,
      dice: pool,
    };
    const client = new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 });
    return { input, client, chat };
  }

  it('非缓存：末条 user 消息带按骰面分行的 <dice_pool>', async () => {
    const { input, client, chat } = setup();
    await generateDirectTurn(input, client);
    const messages = chat.mock.calls[0][0].messages;
    const last = String(messages[messages.length - 1].content);
    expect(last).toContain(`<dice_pool>\n${lines.join('\n')}\n</dice_pool>`);
  });

  it('缓存：turn_context.dice_pool 按原顺序携带同样的行', async () => {
    invalidateDirectContext(saveId);
    try {
      const { input, client } = setup();
      const result = await generateDirectTurn(
        { ...input, cache: { saveId, policy: 'prefix' } },
        client,
      );
      const messages = result.result.requestMessages!;
      const match = String(messages[messages.length - 1].content).match(
        /<turn_context>\n([\s\S]*?)\n<\/turn_context>/,
      );
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]).dice_pool).toEqual(lines);
    } finally {
      invalidateDirectContext(saveId);
    }
  });
});

describe('直出实体：容忍平铺的人物字段', () => {
  /** 规范嵌套形状（带 thoughts），与平铺形状一一对应 */
  function nestedSmith(): DirectUpdates['entities'][number] {
    const entity = smithEntity();
    entity.output.character!.thoughts = '想着炉火';
    return entity;
  }
  /** 模型实际写出的平铺形状：人物字段直接放在 output 上 */
  function flatSmith(extra: Record<string, unknown> = {}): {
    kind: string;
    placement: { location: string; present: boolean };
    output: Record<string, unknown>;
  } {
    return {
      kind: 'character',
      placement: { location: '铁匠铺', present: true },
      output: { ...nestedSmith().output.character, ...extra },
    };
  }
  function withEntity(entity: unknown): string {
    const data = updates();
    data.entities.push(entity as DirectUpdates['entities'][number]);
    return response(data);
  }
  function build(draft: ReturnType<typeof parseDirectOutput>) {
    const character = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    }).characters[1];
    return { ...character, id: undefined };
  }

  it('平铺形状归位后与嵌套形状解析与组装结果一致', () => {
    const flat = parseDirectOutput(withEntity(flatSmith()), POOL);
    const nested = parseDirectOutput(withEntity(nestedSmith()), POOL);
    expect(flat.updates.entities).toEqual(nested.updates.entities);
    expect(flat.flattenedCharacters).toEqual(['铁匠']);
    expect(nested.flattenedCharacters).toBeUndefined();
    expect(build(flat)).toEqual(build(nested));
    expect(build(flat)).toMatchObject({ name: '铁匠', thoughts: '想着炉火', location: '铁匠铺' });
  });

  it('平铺时随身技能/装备/背包进人物，组装结果不丢条目', () => {
    const flat = parseDirectOutput(
      withEntity(
        flatSmith({
          skills: [{ name: '锻打', description: '敲打铁块', type: '主动' }],
          equipment: [{ name: '铁锤', description: '沉重', slot: '主手', stats: {} }],
          inventory: [{ name: '铁锭', description: '原料', quantity: 3 }],
        }),
      ),
      POOL,
    );
    expect(flat.updates.entities[0].output.skills).toEqual([]);
    const character = build(flat);
    expect(character.skills.map((s) => s.name)).toEqual(['锻打']);
    expect(character.inventory.map((i) => i.name).sort()).toEqual(['铁锤', '铁锭'].sort());
  });

  it('平铺并带 statuses 时 statuses 留在外层', () => {
    const status = {
      name: '专注',
      owner: '铁匠',
      description: '心无旁骛',
      category: '增益',
      stacks: 1,
      remainingTime: null,
      timeUnit: '分钟',
    };
    const draft = parseDirectOutput(withEntity(flatSmith({ statuses: [status] })), POOL);
    const output = draft.updates.entities[0].output;
    expect(output.statuses).toEqual([status]);
    expect(output.character).not.toHaveProperty('statuses');
    expect(build(draft).statusEffects.map((s) => s.name)).toEqual(['专注']);
  });

  it('平铺但缺少 name 时不归位：丢掉这个实体，另一个实体照建', () => {
    const entity = flatSmith();
    delete entity.output.name;
    const data = updates();
    const other = smithEntity();
    other.output.character!.name = '学徒';
    data.entities.push(entity as unknown as DirectUpdates['entities'][number], other);
    const draft = parseDirectOutput(response(data), POOL);
    expect(draft.content).toBe('你把材料交给铁匠。');
    expect(draft.updates.entities.map((e) => e.output.character?.name)).toEqual(['学徒']);
    expect(draft.dropped).toEqual(['entities[0]：人物 必须是对象，已忽略']);
    expect(build(draft).name).toBe('学徒');
  });

  it('loadout 里平铺人物字段不归位：剥掉多余键、剥掉 character，物品照收', () => {
    const flat = {
      kind: 'loadout',
      owner: '旅人',
      output: {
        ...flatSmith().output,
        inventory: [{ name: '铁锭', description: '原料', quantity: 3 }],
      },
    };
    const flatDraft = parseDirectOutput(withEntity(flat), POOL);
    expect(flatDraft.dropped).toEqual([
      expect.stringMatching(/^entities\[0\]\.output：含未支持的字段 .+ 等 \d+ 个，已剥除$/),
    ]);
    const built = buildDirectPatches(flatDraft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
    });
    expect(built.patches.some((p) => p.op === 'add_item' && (p.value as any).name === '铁锭')).toBe(
      true,
    );
    const nested = { kind: 'loadout', owner: '旅人', output: nestedSmith().output };
    const nestedDraft = parseDirectOutput(withEntity(nested), POOL);
    expect(nestedDraft.updates.entities[0].output).not.toHaveProperty('character');
    expect(nestedDraft.dropped).toEqual([
      'entities[0].output.character：归属物不能再次创建人物，已忽略',
    ]);
  });
});
