import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDirectOutput,
  buildDirectPatches,
  type DirectUpdates,
} from '../../../src/core/agents/direct-output';
import { generateDirectTurn, rollDirectDice } from '../../../src/core/agents/direct-main';
import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  buildDirectCombat,
  projectDirectCombatCharacters,
} from '../../../src/core/combat/direct-combat';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import { createStateManager } from '../../../src/core/state/state-manager';
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
  type AgentContext,
  type AgentConfig,
  type SaveSlot,
  type ChatMessage,
  type StatePatch,
} from '../../../src/core/types/types';
import { projectStreamingStory } from '../../../src/core/story/story-output';

const saveId = 'direct-test';
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
  it('projects prose, hides partial JSON, rejects incomplete and conflicting output', () => {
    const raw = response();
    expect(parseDirectOutput(raw, 1)).toMatchObject({
      content: '你把材料交给铁匠。',
      options: ['等待', '离开'],
    });
    expect(projectStreamingStory(raw.slice(0, -12))).not.toContain('direct_updates');
    expect(() => parseDirectOutput(raw.replace('</direct_updates>', ''), 1)).toThrow();
    expect(() => parseDirectOutput(raw + '<direct_updates>{}</direct_updates>', 1)).toThrow();
    const data = updates();
    data.state = {
      characters: {
        replace: [{ name: '旅人', path: 'hp', value: 70 }],
        delta: [{ name: '旅人', path: 'hp', amount: -10 }],
      },
    };
    expect(() => parseDirectOutput(response(data), 1)).toThrow('重复');
    data.state = {
      characters: { replace: [{ name: '旅人', path: 'generationMode', value: 'agent' }] },
    };
    expect(() => parseDirectOutput(response(data), 1)).toThrow('白名单');
    data.state = {};
    data.diceUsed = [
      { index: 0, purpose: '制作', target: '短剑' },
      { index: 0, purpose: '重投', target: '短剑' },
    ];
    expect(() => parseDirectOutput(response(data), 1)).toThrow('骰');
  });

  it('creates a complete new NPC with author binding and rejects narrative-only NPC creation', () => {
    const data = updates();
    data.entities.push({
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
    });
    const narrative = [{ name: '铁匠', profile_changes: { personality: '直率' }, chronicle: [] }];
    const draft = parseDirectOutput(response(data, narrative), 1);
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
    const noEntity = parseDirectOutput(response(updates(), narrative), 1);
    expect(() =>
      buildDirectPatches(noEntity, { characters: [player()], definitions: [], sourceTurnKey: 'u' }),
    ).toThrow('缺少完整实体');
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
  it('rolls finite dice within their stated faces with unique consumable indices', () => {
    const dice = rollDirectDice();
    expect(dice.length).toBeGreaterThan(100);
    expect(new Set(dice.map((d) => d.index)).size).toBe(dice.length);
    expect(dice.every((d) => Number.isInteger(d.value) && d.value >= 1 && d.value <= d.sides)).toBe(
      true,
    );
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
