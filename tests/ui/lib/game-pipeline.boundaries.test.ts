import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GamePipeline } from '../../../src/ui/lib/game-pipeline';
import { useGameStore } from '../../../src/ui/stores/game-store';
import { AgentClient } from '@engine/agents/agent-client';
import {
  clearAllData,
  getDatabase,
  getStoryTurnSummaries,
  getStoryArchives,
  getStoryArchiveRetries,
  saveSaveSlot,
  saveMessages,
} from '@engine/persistence/database';
import {
  collectCompleteStoryTurns,
  findStoryTurnsMissingSummary,
} from '@engine/memory/memory-context';
import { storyTurnSource } from '@engine/memory/story-memory-source';
import { withSaveWriteLock } from '@engine/state/state-write-queue';
import { resetPromptSessionsForTest } from '@engine/prompts/prompt-session-assembler';
import type { ChatMessage, SaveSlot } from '@engine/types/types';
import { createDefaultCharacterState } from '@engine/types/types';

const { advance, toast } = vi.hoisted(() => ({ advance: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('@engine/state/state-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/state/state-manager')>();
  return {
    ...actual,
    createStateManager: (id: string) => {
      const manager = actual.createStateManager(id);
      manager.advanceTurn = advance;
      manager.syncRandomEventsForTurn = async () => {};
      manager.commitChatState = async () => ({
        success: true,
        patchesApplied: 0,
        eventsGenerated: [],
        errors: [],
      });
      return manager;
    },
  };
});
vi.mock('../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

const saveId = 'pipeline-boundaries';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const endpoint = {
  id: 'ep',
  name: 'test',
  baseUrl: 'https://invalid.example/v1',
  protocol: 'openai-chat' as const,
  kind: 'llm' as const,
  apiKey: 'test',
  defaultModel: 'test',
  timeout: 1000,
};
function configure(game: ReturnType<typeof useGameStore>) {
  const pipeline = new GamePipeline({
    gameStore: game,
    settingsStore: {
      settings: {
        storyContextV2Enabled: true,
        agents: { story: { historyLayers: 1 } },
        apiPool: [],
        audioSceneAutoPlay: false,
      },
    } as any,
    saveId,
  });
  const p = pipeline as any;
  p.buildEndpoints = () => [endpoint];
  p.loadPlotData = async () => {};
  p.loadPresets = async () => ({ presets: [], agentDefaults: {}, legacyBookAudiences: {} });
  p.loadActiveWorldBooks = async () => [];
  p.getEndpointForAgent = () => endpoint;
  p.buildEmbeddingEndpoint = () => undefined;
  p.buildRetrievalEndpoint = () => undefined;
  p.buildAgentConfigs = () =>
    [
      'memory_recall',
      'plot_pre_check',
      'story',
      'request_dispatcher',
      'memory_summary',
      'vars_update',
      'plot_post_check',
    ].map((agentId) => ({
      agentId,
      enabled: ['story', 'request_dispatcher', 'memory_summary', 'vars_update'].includes(agentId),
      apiEndpointId: endpoint.id,
      model: 'test',
      maxTokens: 1000,
      maxRetries: 0,
      abortSignal: p.abortController.signal,
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
    }));
  return pipeline;
}
async function fixture(messages: ChatMessage[] = []) {
  const save: SaveSlot = {
    id: saveId,
    name: 'test',
    slot: 1,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '',
      userName: '',
      gameStartTime: '',
      totalTurns: 0,
      storyContextV2: { schema: 1, markedAt: 1 },
      plotSettings: { mode: 'off', tabooContent: '' },
    } as SaveSlot['metadata'],
  };
  await saveSaveSlot(save);
  await saveMessages(messages);
  const game = useGameStore();
  game.saves = [save];
  game.activeSaveId = saveId;
  game.messages = messages;
  return { game, pipeline: configure(game) };
}
function result(agentId: string, rawResponse: string) {
  return { agentId, output: rawResponse, rawResponse, tokensUsed: 0, cacheHit: false, duration: 0 };
}
function network(story = 'The story was produced.', characterUpdates = '') {
  return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (
    this: any,
    _request,
    signal,
  ) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const raw =
      this.agentId === 'story'
        ? `<maintext>${story}</maintext>${characterUpdates}`
        : this.agentId === 'memory_summary'
          ? JSON.stringify({ segments: [{ content: story }] })
          : '{}';
    return result(this.agentId, raw);
  });
}
function originalMessages(): ChatMessage[] {
  return [
    { id: 'u', role: 'user', content: 'Deliver the parcel.', timestamp: 1, saveId },
    {
      id: 'a',
      role: 'assistant',
      content: 'The parcel was delivered, the commission is complete.',
      timestamp: 2,
      saveId,
    },
  ];
}

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  resetPromptSessionsForTest();
  await clearAllData();
});
afterEach(async () => {
  await withSaveWriteLock(saveId, async () => {});
  vi.restoreAllMocks();
});

describe('A05/A06: actual pipeline, orchestrator and message persistence', () => {
  it('commits narrator character updates after acceptance, never after a stopped response', async () => {
    const { game, pipeline } = await fixture();
    const db = getDatabase();
    await db.characters.put(createDefaultCharacterState({ id: 'guide', saveId, name: '向导' }));
    const updates = `<character_updates>${JSON.stringify({
      characters: [
        {
          name: '向导',
          profile_changes: { goals: '前往渡口' },
          chronicle: [
            {
              title: '同行之约',
              summary: '答应一同前往渡口。',
              time: { kind: 'this_turn' },
              importance: 8,
            },
          ],
        },
      ],
    })}</character_updates>`;
    const chat = network('向导同意出发。', updates);
    const stop = vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      if (game.messages.some((m) => m.role === 'assistant')) pipeline.abort();
    });
    expect(await pipeline.run('邀请向导同行')).toBe(false);
    expect(await db.characterChronicle.count()).toBe(0);
    expect((await db.characters.get('guide'))?.goals).toBeUndefined();
    stop.mockRestore();
    expect(await pipeline.run('再次邀请向导同行')).toBe(true);
    const rows = await db.characterChronicle.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ characterId: 'guide', importance: 8, origin: 'experience' });
    expect((await db.characters.get('guide'))?.goals).toBe('前往渡口');
    expect(
      game.messages
        .filter((m) => m.role === 'assistant')
        .every((m) => !m.content.includes('character_updates')),
    ).toBe(true);
    const callsBefore = chat.mock.calls.length;
    await pipeline.run('询问向导的打算');
    expect((pipeline as any).currentContext.characterChronicle).toHaveLength(1);
    expect(chat.mock.calls.length - callsBefore).toBe(4);
  });
  it('stopping immediately after Story append rejects completion and advance; attempts never enter backfill', async () => {
    const { game, pipeline } = await fixture();
    network();
    vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      if (game.messages.some((m) => m.role === 'assistant')) pipeline.abort();
    });
    expect(await pipeline.run('hello')).toBe(false);
    expect(advance).not.toHaveBeenCalled();
    expect(game.agentActivityRuns[0]?.status).toBe('cancelled');
    expect(collectCompleteStoryTurns(game.messages)).toEqual([]);
    expect(findStoryTurnsMissingSummary(game.messages, [])).toEqual([]);
    const persisted = await getDatabase().messages.where('saveId').equals(saveId).toArray();
    expect(persisted.map((m) => m.storyTurnStatus)).toEqual(['failed', 'failed']);
  });

  it('completion projection failure leaves failed, not accepted, Story and retries exclude the whole source', async () => {
    const { game, pipeline } = await fixture();
    const chat = network('Rejected attempt.');
    const projection = vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      if (game.messages.some((m) => m.role === 'assistant')) throw new Error('projection failed');
    });
    expect(await pipeline.run('retry me')).toBe(false);
    const user = game.messages.find((m) => m.role === 'user')!;
    expect(findStoryTurnsMissingSummary(game.messages, [])).toEqual([]);
    projection.mockRestore();
    chat.mockRestore();
    network('Accepted replacement.');
    expect(await pipeline.run(user.content, undefined, false, user.id)).toBe(true);
    expect(game.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    const turns = collectCompleteStoryTurns(game.messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].storyMessages.map((m) => m.content)).toEqual(['Accepted replacement.']);
    expect((pipeline as any).currentContext.history).toEqual([]);
    expect(await getStoryTurnSummaries(saveId)).toHaveLength(1);
  });

  it('successful Story is pending while completion is handling and accepted only at formal commit', async () => {
    const { game, pipeline } = await fixture();
    network();
    const statuses: Array<ChatMessage['storyTurnStatus']> = [];
    const projection = game.setPendingOptions;
    vi.spyOn(game, 'setPendingOptions').mockImplementation((options) => {
      statuses.push(
        ...game.messages.filter((m) => m.role === 'assistant').map((m) => m.storyTurnStatus),
      );
      projection(options);
    });
    expect(await pipeline.run('hello')).toBe(true);
    expect(statuses).toEqual(['pending']);
    expect(game.messages.map((m) => m.storyTurnStatus)).toEqual(['accepted', 'accepted']);
    expect(advance).toHaveBeenCalledOnce();
    expect((await getStoryTurnSummaries(saveId))[0].sourceMessageIds).toEqual(
      game.messages.map((m) => m.id),
    );
  });

  it('cancel while formal acceptance is waiting for the save lock performs no acceptance or advance', async () => {
    const { game, pipeline } = await fixture();
    network();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = game.setStoryTurnStatus;
    vi.spyOn(game, 'setStoryTurnStatus').mockImplementation(async (...args) => {
      if (args[1] === 'accepted') {
        void withSaveWriteLock(saveId, async () => {
          entered.resolve();
          await release.promise;
        });
      }
      return original(...args);
    });
    const running = pipeline.run('hello');
    await entered.promise;
    expect(pipeline.abort()).toBe(true);
    release.resolve();
    expect(await running).toBe(false);
    expect(advance).not.toHaveBeenCalled();
    expect(collectCompleteStoryTurns(game.messages)).toEqual([]);
  });

  it('once actual formal write begins, Stop explicitly reports saving rather than claiming atomic rollback', async () => {
    const { game, pipeline } = await fixture();
    network();
    const table = getDatabase().messages;
    const original = table.bulkPut.bind(table);
    let stopResult: boolean | undefined;
    vi.spyOn(table, 'bulkPut').mockImplementation(((rows: ChatMessage[]) => {
      if (rows.some((m) => m.storyTurnStatus === 'accepted')) stopResult = pipeline.abort();
      return original(rows);
    }) as any);
    expect(await pipeline.run('hello')).toBe(true);
    expect(stopResult).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('不会自动撤销'), 'warning', 6000);
    expect(advance).toHaveBeenCalledOnce();
    expect(game.messages.every((m) => m.storyTurnStatus === 'accepted')).toBe(true);
  });

  it('assistant-only opening gets a self key at first write and can be formally accepted', async () => {
    const { game, pipeline } = await fixture();
    network('Opening without a user message.');
    expect(await pipeline.run('opening', undefined, false)).toBe(true);
    expect(game.messages).toHaveLength(1);
    expect(game.messages[0].storyTurnKey).toBe(game.messages[0].id);
    expect(collectCompleteStoryTurns(game.messages)).toHaveLength(1);
    expect((await getStoryTurnSummaries(saveId))[0].sourceTurnKey).toBe(game.messages[0].id);
  });

  it('advance failure does not report completion or delete already committed messages', async () => {
    const { game, pipeline } = await fixture();
    network();
    advance.mockRejectedValueOnce(new Error('advance write failure'));
    expect(await pipeline.run('hello')).toBe(false);
    expect(game.agentActivityRuns[0]?.status).toBe('failed');
    expect(game.agentActivityRuns[0]?.message).toContain('不会自动撤销');
    expect(await getDatabase().messages.where('saveId').equals(saveId).count()).toBe(2);
    expect(collectCompleteStoryTurns(game.messages)).toEqual([]);
  });

  it('v2 plot_post_check receives segment text while raw JSON remains available to the v2 parser', async () => {
    const { game, pipeline } = await fixture();
    (game.saves[0].metadata as Record<string, unknown>).plotSettings = {
      mode: 'main',
      tabooContent: '',
    };
    const p = pipeline as any;
    const original = p.buildAgentConfigs;
    p.buildAgentConfigs = () =>
      original().map((config: any) =>
        config.agentId === 'plot_post_check' ? { ...config, enabled: true } : config,
      );
    const rawSummary = JSON.stringify({
      archives: [],
      segments: [{ event: 'Delivery', content: 'Delivered a parcel.' }],
    });
    let postPrompt = '';
    vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any, request) {
      if (this.agentId === 'plot_post_check')
        postPrompt = request.messages.map((m) => m.content).join('\n');
      return result(
        this.agentId,
        this.agentId === 'story'
          ? '<maintext>Delivered a parcel.</maintext>'
          : this.agentId === 'memory_summary'
            ? rawSummary
            : '{}',
      );
    });
    expect(await pipeline.run('deliver')).toBe(true);
    expect(postPrompt).toContain('【Delivery】Delivered a parcel.');
    expect(postPrompt).not.toContain(rawSummary);
    expect(p.currentContext.agentOutputs.get('memory_summary')).toBe(rawSummary);
    expect((await getStoryTurnSummaries(saveId))[0].content).toBe('Delivered a parcel.');
  });

  it('retry legacy failed source never attaches a1 to u0; marked diagnostics do not become Story', async () => {
    const { game, pipeline } = await fixture([
      { id: 'u0', role: 'user', content: 'previous', timestamp: 1, saveId },
      { id: 'a0', role: 'assistant', content: 'previous story', timestamp: 2, saveId },
      { id: 'u1', role: 'user', content: 'retry', timestamp: 3, saveId },
      { id: 'a1', role: 'assistant', content: 'failed attempt', timestamp: 4, saveId },
    ]);
    const context = (pipeline as any).buildContext('retry', 'u1');
    expect(context.history.map((m: ChatMessage) => m.id)).toEqual(['u0', 'a0']);
    (pipeline as any).buildEventHandlers().onStateCommitError('vars_update', ['failed']);
    const diagnostic = game.messages[game.messages.length - 1];
    expect(diagnostic.diagnostic).toBe(true);
    expect(collectCompleteStoryTurns(game.messages)[1].storyMessages.map((m) => m.id)).toEqual([
      'a1',
    ]);
  });
});

describe('A02/A07: async source replacement in actual memory commit/backfill', () => {
  it.each(['commit', 'backfill'] as const)(
    '%s rejects replacing only assistant while retaining the user',
    async (operation) => {
      const { game, pipeline } = await fixture(originalMessages());
      const p = pipeline as any;
      p.runMode = 'v2';
      p.lastStoryMessage = game.messages[1];
      p.v2SummaryDraft = { segments: [{ content: 'Delivered the parcel.' }], archives: [] };
      const paused = deferred<boolean>();
      vi.spyOn(p, 'embedStoryMemoryRecords').mockReturnValue(paused.promise);
      p.getClientFactory = () => () => ({
        chat: async () =>
          result(
            'memory_summary',
            JSON.stringify({ segments: [{ content: 'Delivered the parcel.' }] }),
          ),
      });
      const work =
        operation === 'commit' ? p.commitStoryTurnSummary() : p.backfillMissingStorySummaries();
      await vi.waitFor(() => expect(p.embedStoryMemoryRecords).toHaveBeenCalledOnce());
      game.messages[1] = { ...game.messages[1], id: 'a-new', content: 'The parcel was lost.' };
      await getDatabase().messages.delete('a');
      await saveMessages(JSON.parse(JSON.stringify([game.messages[1]])));
      paused.resolve(true);
      await work;
      expect(await getStoryTurnSummaries(saveId)).toEqual([]);
    },
  );

  it('same-ID content revision during embedding also rejects the old summary', async () => {
    const { game, pipeline } = await fixture(originalMessages());
    const p = pipeline as any;
    p.runMode = 'v2';
    p.lastStoryMessage = game.messages[1];
    p.v2SummaryDraft = { segments: [{ content: 'Delivered.' }], archives: [] };
    const paused = deferred<boolean>();
    vi.spyOn(p, 'embedStoryMemoryRecords').mockReturnValue(paused.promise);
    const work = p.commitStoryTurnSummary();
    game.messages[1].content = 'A different ending.';
    await saveMessages(JSON.parse(JSON.stringify([game.messages[1]])));
    paused.resolve(true);
    await work;
    expect(await getStoryTurnSummaries(saveId)).toEqual([]);
  });
});

describe('R01: durable original-turn archive draft, not next-turn evidence', () => {
  it('atomic write failure saves original summaries; later production turn retries original source before backfill', async () => {
    const messages = originalMessages();
    const { game, pipeline } = await fixture(messages);
    const p = pipeline as any;
    p.runMode = 'v2';
    p.lastStoryMessage = messages[1];
    p.v2SummaryDraft = {
      segments: [{ content: 'The commission completed.', eventName: 'Delivery' }],
      archives: [
        {
          eventName: 'Delivery',
          outcome: 'completed',
          evidence: 'the commission is complete',
          overview: 'Delivered the parcel.',
          detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
        },
      ],
    };
    p.getClientFactory = () => () => ({
      chat: async () => result('memory_summary', '{"ending":"Delivery completed."}'),
    });
    vi.spyOn(getDatabase().storyArchives, 'bulkPut').mockRejectedValueOnce(
      new Error('injected archive failure'),
    );
    await p.commitStoryTurnSummary();
    expect(await getStoryTurnSummaries(saveId)).toEqual([]);
    const retries = await getStoryArchiveRetries(saveId);
    expect(retries).toHaveLength(1);
    expect(retries[0].summaries).toHaveLength(1);
    const backfill = vi.fn();
    p.getClientFactory = () => () => ({ chat: backfill });
    await p.backfillMissingStorySummaries();
    expect(backfill).not.toHaveBeenCalled();

    // New pipeline models a refresh; pending work must not live only on the old instance.
    const next = configure(game);
    const detail = vi.fn(async (_request: any) =>
      result('memory_summary', '{"ending":"Original delivery completed."}'),
    );
    (next as any).getClientFactory = () => () => ({ chat: detail });
    network('You leave the city, far from the old commission.');
    expect(await next.run('Travel away.')).toBe(true);
    expect(await getStoryArchiveRetries(saveId)).toEqual([]);
    const archives = await getStoryArchives(saveId);
    expect(archives).toHaveLength(1);
    expect(archives[0].sourceTurnKey).toBe('u');
    expect(archives[0].evidence).toBe('the commission is complete');
    expect(
      (await getStoryTurnSummaries(saveId)).some((s) => s.id === retries[0].summaries![0].id),
    ).toBe(true);
    const prompt = detail.mock.calls[0]?.[0] as any;
    expect(prompt.messages[1].content).toContain('The parcel was delivered');
    expect(prompt.messages[1].content).not.toContain('You leave the city');
  });

  it('backfill reads only original message time facts, never the current profile', async () => {
    const messages = originalMessages();
    const time = { era: 'test', year: 3, month: 1, day: 2, weekday: 2, hour: 4, minute: 5 };
    messages[0].storyGameTime = time;
    messages[1].storyGameTime = { ...time, minute: 6 };
    const { pipeline } = await fixture(messages);
    const p = pipeline as any;
    p.runMode = 'v2';
    p.getClientFactory = () => () => ({
      chat: async () => result('memory_summary', '{"segments":[{"content":"Delivered."}]}'),
    });
    await p.backfillMissingStorySummaries();
    expect((await getStoryTurnSummaries(saveId))[0].gameTimeRange).toEqual({
      start: time,
      end: { ...time, minute: 6 },
    });
    // The source helper itself remains ID-independent for backup remapping.
    expect(storyTurnSource(collectCompleteStoryTurns(messages)[0]).sourceFingerprint).toMatch(
      /^story-source-v1:/,
    );
  });
});

describe.each(['direct', 'direct_cached'] as const)(
  '%s pipeline preserves memory and isolates non-memory generation',
  (mode) => {
    async function directFixture() {
      const { game, pipeline } = await fixture();
      game.activeSave!.metadata.generationMode = mode;
      await saveSaveSlot(JSON.parse(JSON.stringify(game.activeSave!)));
      const { createDirectPreset, createCachedDirectPreset } =
        await import('@engine/prompts/direct-prompt');
      const preset = mode === 'direct_cached' ? createCachedDirectPreset() : createDirectPreset();
      const p = pipeline as any;
      p.loadPresets = async () => ({ presets: [preset], agentDefaults: {} });
      // Exercise the production direct configuration path rather than the Agent fixture shim.
      delete p.buildAgentConfigs;
      await getDatabase().characters.put(
        createDefaultCharacterState({
          id: 'player',
          saveId,
          name: '旅人',
          type: 'player',
          hp: 80,
          maxHp: 100,
        }),
      );
      return { game, pipeline };
    }
    function directNetwork(valid = true) {
      return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any) {
        const raw =
          this.agentId === 'direct_main'
            ? `<maintext>旅人继续前行。</maintext><character_updates>{"characters":[]}</character_updates>${valid ? '<direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{"characters":{"delta":[{"name":"旅人","path":"hp","amount":-10}]}},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>' : ''}`
            : this.agentId === 'memory_summary'
              ? JSON.stringify({ segments: [{ content: '旅人继续前行。' }] })
              : '{}';
        return result(this.agentId, raw);
      });
    }
    it('uses the selected mode model and memory window independently', async () => {
      const { pipeline } = await directFixture();
      const p = pipeline as any;
      const cachedEndpoint = { ...endpoint, id: 'cached-ep', defaultModel: 'cached-model' };
      p.buildEndpoints = () => [endpoint, cachedEndpoint];
      Object.assign(p.settings.settings, {
        directInitialized: true,
        directCachedInitialized: true,
        agents: {
          direct_main: { model: 'ep', historyLayers: 2 },
          direct_cached: { model: 'cached-ep', historyLayers: 4 },
        },
      });
      const chat = directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const index = chat.mock.contexts.findIndex((client: any) => client.agentId === 'direct_main');
      expect(chat.mock.calls[index][0].model).toBe(
        mode === 'direct_cached' ? 'cached-model' : 'test',
      );
      const context = await p.prepareStoryContextV2({});
      expect(context.windowTurns).toBe(mode === 'direct_cached' ? 4 : 2);
    });
    it('continues from accepted history and current resources on the next turn', async () => {
      const { pipeline } = await directFixture();
      const chat = directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      expect(await pipeline.run('继续前进')).toBe(true);
      const mainCalls = chat.mock.calls.filter(
        (_, index) => (chat.mock.contexts[index] as any).agentId === 'direct_main',
      );
      expect(mainCalls).toHaveLength(2);
      const first = mainCalls[0][0].messages;
      const second = mainCalls[1][0].messages;
      if (mode === 'direct_cached') expect(second.slice(0, first.length)).toEqual(first);
      expect(JSON.stringify(second)).toContain('旅人继续前行');
      expect((await getDatabase().characters.get('player'))?.hp).toBe(60);
    });
    it('accepts one main call, keeps Story v2 summaries, blocks replay and never enters side chains', async () => {
      const { game, pipeline } = await directFixture();
      const chat = directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const agents = chat.mock.contexts.map((client: any) => client.agentId);
      expect(agents.filter((id) => !id.startsWith('memory_'))).toEqual(['direct_main']);
      expect(agents).toContain('memory_summary');
      expect((await getDatabase().characters.get('player'))?.hp).toBe(70);
      expect(await getStoryTurnSummaries(saveId)).toHaveLength(1);
      const user = game.messages.find((m) => m.role === 'user')!;
      expect(user.storyTurnStatus).toBe('accepted');
      const calls = chat.mock.calls.length;
      expect(await pipeline.run('前进', undefined, false, user.id)).toBe(false);
      expect(chat).toHaveBeenCalledTimes(calls);
      expect((await getDatabase().characters.get('player'))?.hp).toBe(70);
    });
    it('does not silently repair malformed main output or change game state', async () => {
      const { game, pipeline } = await directFixture();
      const chat = directNetwork(false);
      expect(await pipeline.run('前进')).toBe(false);
      expect(chat.mock.contexts.map((client: any) => client.agentId)).toEqual(['direct_main']);
      expect((await getDatabase().characters.get('player'))?.hp).toBe(80);
      expect(game.messages.some((m) => m.storyTurnStatus === 'accepted')).toBe(false);
    });
    it('keeps accepted state accepted if auxiliary snapshot creation fails', async () => {
      const { game, pipeline } = await directFixture();
      directNetwork();
      advance.mockRejectedValueOnce(new Error('snapshot unavailable'));
      expect(await pipeline.run('前进')).toBe(true);
      expect(
        game.messages
          .filter((m) => m.role !== 'system')
          .every((m) => m.storyTurnStatus === 'accepted'),
      ).toBe(true);
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('本楼已接纳'), 'warning', 6000);
    });

    it('keeps legacy recall and summary persistence outside the single main request', async () => {
      const { game, pipeline } = await directFixture();
      delete game.activeSave!.metadata.storyContextV2;
      await saveSaveSlot(JSON.parse(JSON.stringify(game.activeSave!)));
      (pipeline as any).settings.settings.storyContextV2Enabled = false;
      await game.refreshFromDb(saveId);
      const summary = '旅人把铁交给铁匠，双方约定日落后回来取剑。'.repeat(15);
      const chat = directNetwork();
      const mainReply = chat.getMockImplementation()!;
      chat.mockImplementation(async function (this: any, ...args) {
        if (this.agentId === 'memory_recall') return result(this.agentId, '铁匠已经收到材料');
        if (this.agentId === 'memory_summary')
          return result(
            this.agentId,
            JSON.stringify({
              content: summary,
              hiddenLine: '铁匠准备按约交付',
              keywords: ['铁匠'],
              importance: 5,
            }),
          );
        expect(JSON.stringify(args[0].messages)).toContain('铁匠已经收到材料');
        return mainReply.apply(this, args);
      });
      expect(await pipeline.run('继续制作')).toBe(true);
      expect(chat.mock.contexts.map((client: any) => client.agentId)).toEqual([
        'memory_recall',
        'direct_main',
        'memory_summary',
      ]);
      expect(await getDatabase().memories.where('saveId').equals(saveId).toArray()).toMatchObject([
        { content: summary },
      ]);
      expect(await getStoryTurnSummaries(saveId)).toHaveLength(0);
    });

    it('carries crafted inventory and active combat into later turns, then settles combat once', async () => {
      const { game, pipeline } = await directFixture();
      await getDatabase().characters.update('player', { inventory: [{ name: '铁', quantity: 2 }] });
      await game.refreshFromDb(saveId);
      let mainCalls = 0;
      const contexts: any[] = [];
      const chat = vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (
        this: any,
        request,
      ) {
        if (this.agentId !== 'direct_main')
          return result(
            this.agentId,
            JSON.stringify({ segments: [{ content: '旅人打造短剑，随后应对袭击。' }] }),
          );
        const wire = request.messages.map((m) => String(m.content)).join('\n');
        if (mode === 'direct') {
          contexts.push(
            JSON.parse(wire.match(/<direct_state>\s*([\s\S]*?)\s*<\/direct_state>/)![1]),
          );
        } else {
          const state: Record<string, unknown> = {};
          for (const match of wire.matchAll(
            /<direct_context>\s*([\s\S]*?)\s*<\/direct_context>/g,
          )) {
            const change = JSON.parse(match[1]);
            Object.assign(state, change.set);
            for (const key of change.remove) delete state[key];
          }
          contexts.push(state);
        }
        mainCalls++;
        const craft = mainCalls === 1;
        const data = {
          version: 1,
          world: {},
          time: { delta_time: 0 },
          effects: [],
          plot: {},
          diceUsed: [],
          entities: craft
            ? [
                {
                  kind: 'loadout',
                  owner: '旅人',
                  output: {
                    skills: [],
                    equipment: [],
                    inventory: [
                      {
                        name: '短剑',
                        description: '刚打造的短剑',
                        quantity: 1,
                        type: '装备',
                        protocolText: '锋利的剑刃',
                      },
                    ],
                    statuses: [],
                  },
                },
              ]
            : [],
          state: craft
            ? { items: { consume: [{ owner: '旅人', target: '铁', quantity: 2 }] } }
            : {},
          combat: craft
            ? null
            : {
                meta: {
                  round: mainCalls - 1,
                  combatType: '标准',
                  environment: '街道',
                  phase: mainCalls === 2 ? 'active' : 'ended',
                  ...(mainCalls === 3 ? { outcome: 'ally_win' } : {}),
                },
                units: [
                  {
                    name: '旅人',
                    origin: 'save',
                    side: 'ally',
                    hp: mainCalls === 2 ? 60 : 40,
                    mp: game.player!.mp,
                    sp: game.player!.sp,
                    statusEffects: [],
                  },
                ],
              },
        };
        return result(
          this.agentId,
          `<maintext>旅人打造短剑，随后应对袭击。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify(data)}</direct_updates>`,
        );
      });
      expect(await pipeline.run('制作短剑')).toBe(true);
      expect(game.player!.inventory).toMatchObject([{ name: '短剑', quantity: 1 }]);
      expect(await pipeline.run('迎击敌人')).toBe(true);
      expect(game.isInCombat).toBe(true);
      expect(game.isAgentCombat).toBe(false);
      expect(game.player!.hp).toBe(60);
      expect((await getDatabase().characters.get('player'))!.hp).toBe(80);
      expect(await pipeline.run('结束战斗')).toBe(true);
      expect(
        mode === 'direct_cached'
          ? contexts[1]['character/旅人/inventory']
          : contexts[1].characters[0].inventory,
      ).toMatchObject([{ name: '短剑' }]);
      expect(
        mode === 'direct_cached' ? contexts[2].resources[0].hp : contexts[2].characters[0].hp,
      ).toBe(60);
      expect(game.isInCombat).toBe(false);
      expect((await getDatabase().characters.get('player'))!.hp).toBe(40);
      expect(await getStoryTurnSummaries(saveId)).toHaveLength(3);
      expect(
        chat.mock.contexts
          .filter((client: any) => !client.agentId.startsWith('memory_'))
          .map((client: any) => client.agentId),
      ).toEqual(['direct_main', 'direct_main', 'direct_main']);
    });
  },
);
