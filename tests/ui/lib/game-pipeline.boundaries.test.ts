import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GamePipeline } from '../../../src/ui/lib/game-pipeline';
import { useGameStore } from '../../../src/ui/stores/game-store';
import { AgentClient } from '@engine/agents/agent-client';
import { AgentOrchestrator } from '@engine/agents/agent-orchestrator';
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
import { StateManager } from '@engine/state/state-manager';
import { resetPromptSessionsForTest } from '@engine/prompts/prompt-session-assembler';
import { setEngineSettingsProvider } from '@engine/runtime/engine-settings';
import type { DirectCombatRecord } from '@engine/combat/direct-combat';
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
  setEngineSettingsProvider(undefined);
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
    function directNetwork(valid: boolean | (() => boolean) = true) {
      return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any) {
        const ok = typeof valid === 'function' ? valid() : valid;
        const raw =
          this.agentId === 'direct_main'
            ? `<maintext>旅人继续前行。</maintext><character_updates>{"characters":[]}</character_updates>${ok ? '<direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{"characters":{"delta":[{"name":"旅人","path":"hp","amount":-10}]}},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>' : '<direct_updates>{坏掉的</direct_updates>'}`
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
    it('把设置里的重建时机传给引擎（仅缓存直出）', async () => {
      const { pipeline } = await directFixture();
      const p = pipeline as any;
      Object.assign(p.settings.settings, {
        directCacheRebuildTurns: 2,
        directCacheGrowthLimit: 2.2,
      });
      const runDirect = vi.spyOn(AgentOrchestrator.prototype, 'runDirect');
      const chat = directNetwork();
      for (const input of ['前进', '继续前进', '再前进'])
        expect(await pipeline.run(input)).toBe(true);
      expect(runDirect).toHaveBeenCalledTimes(3);
      for (const call of runDirect.mock.calls)
        expect(call[2]).toEqual(
          mode === 'direct_cached' ? { maxTurns: 2, growthLimit: 2.2 } : undefined,
        );
      if (mode === 'direct_cached') {
        // 引擎确实按 2 楼上限执行：第 2 楼复用第 1 楼留存前缀，第 3 楼冷建
        const main = chat.mock.calls
          .filter((_, i) => (chat.mock.contexts[i] as any).agentId === 'direct_main')
          .map((c) => c[0].messages);
        const retained = main[0].length - 1;
        const sameLead = (m: unknown[]) =>
          JSON.stringify(m.slice(0, retained)) === JSON.stringify(main[0].slice(0, retained));
        expect(sameLead(main[1])).toBe(true);
        expect(sameLead(main[2])).toBe(false);
      }
    });
    it('分节断点随接纳后的正文消息落库（content 已剥标记）', async () => {
      const { game, pipeline } = await directFixture();
      vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any) {
        const raw =
          this.agentId === 'direct_main'
            ? `<maintext>旅人继续前行。\n<beat enter="艾拉"/>\n艾拉从林间走出。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>`
            : this.agentId === 'memory_summary'
              ? JSON.stringify({ segments: [{ content: '旅人继续前行。' }] })
              : '{}';
        return result(this.agentId, raw);
      });
      expect(await pipeline.run('前进')).toBe(true);
      const message = game.messages.find((m) => m.role === 'assistant')!;
      expect(message.content).toBe('旅人继续前行。\n\n艾拉从林间走出。');
      const at = message.content.indexOf('\n\n') + 2;
      expect(message.stage).toEqual({ breaks: [at], enters: [{ name: '艾拉', at }] });
      const stored = await getDatabase().messages.get(message.id);
      expect(stored?.storyTurnStatus).toBe('accepted');
      expect(stored?.stage).toEqual(message.stage);
    });
    it('没有分节标记时消息不带 stage 字段', async () => {
      const { game, pipeline } = await directFixture();
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const message = game.messages.find((m) => m.role === 'assistant')!;
      expect('stage' in message).toBe(false);
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
      if (mode === 'direct_cached') {
        // 最后一条是不留存的本轮尾部；其前的留存部分原样成为下一楼前缀，后接上一楼正文
        const retained = first.length - 1;
        expect(first[retained].content).toMatch(/^<turn_context>/);
        expect(second.slice(0, retained)).toEqual(first.slice(0, retained));
        expect(second[retained]).toEqual({ role: 'assistant', content: '旅人继续前行。' });
        expect(second).not.toContainEqual(first[retained]);
        // 冷建时资源整份在留存消息的 set 里（开局 80），尾部不再重复
        expect(first[retained - 1].content).toContain('"hp":80');
        expect(first[retained].content).not.toContain('"current"');
        // 第二楼资源变成第一楼接纳后的 70：只进本轮留存消息的 set，尾部不重复
        const secondRetained = second[second.length - 2].content;
        expect(secondRetained).toContain('"hp":70');
        expect(secondRetained).not.toContain('"hp":80');
        const tail = second[second.length - 1].content;
        expect(tail).toMatch(/^<turn_context>/);
        expect(tail).not.toContain('"resources"');
      }
      expect(JSON.stringify(second)).toContain('旅人继续前行');
      expect((await getDatabase().characters.get('player'))?.hp).toBe(60);
    });
    it.runIf(mode === 'direct_cached')(
      'retries a rejected attempt on the accepted cached prefix instead of rebuilding',
      async () => {
        const { game, pipeline } = await directFixture();
        let valid = true;
        const chat = directNetwork(() => valid);
        expect(await pipeline.run('前进')).toBe(true);
        valid = false;
        expect(await pipeline.run('继续前进')).toBe(false);
        const failed = game.messages.find((m) => m.role === 'user' && m.content === '继续前进')!;
        expect(failed.storyTurnStatus).toBe('failed');
        valid = true;
        expect(await pipeline.run('继续前进', undefined, false, failed.id)).toBe(true);
        const mainCalls = chat.mock.calls.filter(
          (_, index) => (chat.mock.contexts[index] as any).agentId === 'direct_main',
        );
        expect(mainCalls).toHaveLength(3);
        const first = mainCalls[0][0].messages;
        const retry = mainCalls[2][0].messages;
        // 第一楼留存部分（不含尾部）原样复用，后接已接纳的正文；被拒的那次不留痕
        const retained = first.length - 1;
        expect(retry.slice(0, retained)).toEqual(first.slice(0, retained));
        expect(retry[retained]).toEqual({ role: 'assistant', content: '旅人继续前行。' });
        expect(retry).toHaveLength(retained + 3);
        expect((await getDatabase().characters.get('player'))?.hp).toBe(60);
      },
    );
    it.runIf(mode === 'direct_cached').each([
      ['before', false],
      ['after', true],
    ] as const)(
      'a commit failure %s the core commit started rebuilds the cached session: %s',
      async (_, started) => {
        const { game, pipeline } = await directFixture();
        const chat = directNetwork();
        expect(await pipeline.run('前进')).toBe(true);
        vi.spyOn(StateManager.prototype, 'commitDirectTurn').mockImplementationOnce(
          async (input) => {
            if (started) input.onCommitStart?.();
            throw new Error('写入失败');
          },
        );
        expect(await pipeline.run('继续前进')).toBe(false);
        const failed = game.messages.find((m) => m.role === 'user' && m.content === '继续前进')!;
        expect(await pipeline.run('继续前进', undefined, false, failed.id)).toBe(true);
        const mainCalls = chat.mock.calls.filter(
          (_, index) => (chat.mock.contexts[index] as any).agentId === 'direct_main',
        );
        expect(mainCalls).toHaveLength(3);
        const first = mainCalls[0][0].messages;
        const retry = mainCalls[2][0].messages;
        // 复用会话时第一楼的留存消息（带 player_input 标签的上一楼输入）原样在前缀里；
        // 冷建时上一楼只以历史形式出现，留存消息只有本轮这一条
        const retained = first.length - 1;
        const reusesAcceptedSession =
          JSON.stringify(retry.slice(0, retained)) === JSON.stringify(first.slice(0, retained));
        expect(reusesAcceptedSession).toBe(!started);
        expect(
          retry.filter((m: any) => String(m.content).includes('<player_input>\n前进\n')),
        ).toHaveLength(started ? 0 : 1);
        expect((await getDatabase().characters.get('player'))?.hp).toBe(60);
      },
    );
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

    function directReply(mainRaw: string) {
      return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any) {
        return result(
          this.agentId,
          this.agentId === 'direct_main'
            ? mainRaw
            : this.agentId === 'memory_summary'
              ? JSON.stringify({ segments: [{ content: '旅人继续前行。' }] })
              : '{}',
        );
      });
    }

    it('有丢弃项时接纳后只提示一次合计数，角色更新用过滤后的版本，调试记录带丢弃项', async () => {
      const { game, pipeline } = await directFixture();
      // 解析期丢 1 项（effects[0] 动作无效）+ 建补丁时丢 1 项（角色更新指向不存在的人物）
      const characterUpdates = JSON.stringify({
        characters: [{ name: '幽灵', profile_changes: { goals: '游荡' } }],
      });
      const updates = JSON.stringify({
        version: 1,
        world: {},
        time: { delta_time: 0 },
        entities: [],
        state: { characters: { delta: [{ name: '旅人', path: 'hp', amount: -10 }] } },
        effects: [{ owner: '旅人', action: 'explode', value: { name: '灼烧' } }],
        plot: {},
        combat: null,
        diceUsed: [],
      });
      directReply(
        `<maintext>旅人继续前行。</maintext><character_updates>${characterUpdates}</character_updates><direct_updates>${updates}</direct_updates>`,
      );
      const commitUpdates = vi.spyOn(StateManager.prototype, 'commitCharacterUpdates');
      expect(await pipeline.run('前进')).toBe(true);
      expect(toast).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith(
        '本楼已接纳；2 项状态更新格式有误已忽略（调试面板可查看）',
        'warning',
        6000,
      );
      expect(commitUpdates).toHaveBeenCalledOnce();
      expect(commitUpdates.mock.calls[0][0]).toEqual([]);
      // 其余更新照常接纳
      expect((await getDatabase().characters.get('player'))?.hp).toBe(70);
      const entry = game.agentLogHistory
        .flatMap((turn) => turn.entries)
        .find((e) => e.agentId === 'direct_main');
      expect(entry?.outputWarnings).toHaveLength(2);
      expect(entry?.outputWarnings?.[0]).toMatch(/^effects\[0\]/);
      expect(entry?.outputWarnings?.[1]).toContain('幽灵');
    });

    it('本楼已被接纳过（already-accepted）时不提示丢弃项', async () => {
      const { pipeline } = await directFixture();
      const characterUpdates = JSON.stringify({
        characters: [{ name: '幽灵', profile_changes: { goals: '游荡' } }],
      });
      const updates = JSON.stringify({
        version: 1,
        world: {},
        time: { delta_time: 0 },
        entities: [],
        state: {},
        effects: [{ owner: '旅人', action: 'explode', value: { name: '灼烧' } }],
        plot: {},
        combat: null,
        diceUsed: [],
      });
      directReply(
        `<maintext>旅人继续前行。</maintext><character_updates>${characterUpdates}</character_updates><direct_updates>${updates}</direct_updates>`,
      );
      const commit = vi
        .spyOn(StateManager.prototype, 'commitDirectTurn')
        .mockResolvedValueOnce('already-accepted');
      expect(await pipeline.run('前进')).toBe(true);
      expect(commit).toHaveBeenCalledOnce();
      expect(toast).not.toHaveBeenCalled();
    });

    it('模型没写状态更新区块时只保存正文，并给出另一句提示', async () => {
      const { pipeline } = await directFixture();
      directReply(
        '<maintext>旅人继续前行。</maintext><character_updates>{"characters":[]}</character_updates>',
      );
      expect(await pipeline.run('前进')).toBe(true);
      expect(toast).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith(
        '本楼只保存了正文：模型没有输出状态更新，可回退后重新生成',
        'warning',
        6000,
      );
      expect((await getDatabase().characters.get('player'))?.hp).toBe(80);
    });

    it('没有丢弃项且有状态更新时不提示', async () => {
      const { pipeline } = await directFixture();
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      expect(toast).not.toHaveBeenCalled();
    });

    describe('状态树协议（stateProtocol: tree）', () => {
      function treeReply(patch: unknown[]) {
        return `<maintext>旅人继续前行。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify({ version: 2, patch, plot: {}, diceUsed: [] })}</direct_updates>`;
      }
      beforeEach(() => {
        setEngineSettingsProvider(() => ({ stateProtocol: 'tree' }));
      });

      it('传入存档档案建补丁，时间按 /世界/时间 推进，更新记录落到本楼正文消息', async () => {
        const { game, pipeline } = await directFixture();
        const { getProfile } = await import('@engine/state/save-profile');
        const before = { ...(await getProfile(saveId)).gameTime };
        directReply(
          treeReply([
            { op: 'delta', path: '/世界/时间', value: 30 },
            { op: 'delta', path: '/主角/生命值/当前', value: -10 },
          ]),
        );
        expect(await pipeline.run('前进')).toBe(true);
        expect((await getDatabase().characters.get('player'))?.hp).toBe(70);
        const after = (await getDatabase().saveProfiles.get(saveId))!.gameTime;
        expect(after.hour * 60 + after.minute - (before.hour * 60 + before.minute)).toBe(30);
        const message = game.messages.find((m) => m.role === 'assistant')!;
        const stored = await getDatabase().messages.get(message.id);
        expect(stored?.storyTurnStatus).toBe('accepted');
        expect(stored?.stateUpdates?.deltaMinutes).toBe(30);
        expect(stored?.stateUpdates?.ops).toHaveLength(2);
        const hp = stored!.stateUpdates!.ops.find((op) => op.path === '/主角/生命值/当前')!;
        expect(hp).toMatchObject({ op: 'delta', value: -10, before: 80, after: 70 });
        expect(message.stateUpdates).toEqual(stored?.stateUpdates);
        // 用户消息不挂记录
        const user = await getDatabase().messages.get(
          game.messages.find((m) => m.role === 'user')!.id,
        );
        expect(user && 'stateUpdates' in user).toBe(false);
      });

      it('接纳新一楼时清掉上一楼记录的前值与后值，其余字段保留，最新一楼保留', async () => {
        const { game, pipeline } = await directFixture();
        directReply(treeReply([{ op: 'delta', path: '/主角/生命值/当前', value: -10 }]));
        expect(await pipeline.run('前进')).toBe(true);
        expect(await pipeline.run('继续前进')).toBe(true);
        const [first, second] = game.messages.filter((m) => m.role === 'assistant');
        const firstStored = await getDatabase().messages.get(first.id);
        const secondStored = await getDatabase().messages.get(second.id);
        expect(firstStored?.stateUpdates?.ops).toEqual([
          { path: '/主角/生命值/当前', op: 'delta', value: -10, status: '已应用' },
        ]);
        expect(first.stateUpdates).toEqual(firstStored?.stateUpdates);
        expect(secondStored?.stateUpdates?.ops[0]).toMatchObject({ before: 70, after: 60 });
        expect((await getDatabase().characters.get('player'))?.hp).toBe(60);
      });

      it('建补丁期的纠正与丢弃一起进调试记录', async () => {
        const { game, pipeline } = await directFixture();
        directReply(
          treeReply([
            { op: 'delta', path: '/主角/生命值/当前', value: -1000 },
            { op: 'delta', path: '/关系列表/幽灵/好感度', value: 5 },
          ]),
        );
        expect(await pipeline.run('前进')).toBe(true);
        const entry = game.agentLogHistory
          .flatMap((turn) => turn.entries)
          .find((e) => e.agentId === 'direct_main');
        const stored = await getDatabase().messages.get(
          game.messages.find((m) => m.role === 'assistant')!.id,
        );
        const statuses = stored!.stateUpdates!.ops.map((op) => op.status);
        expect(statuses).toEqual(['已纠正', '已丢弃']);
        const warnings = entry?.outputWarnings ?? [];
        expect(warnings.filter((w) => w.startsWith('已纠正：'))).toHaveLength(1);
        expect(warnings.some((w) => !w.startsWith('已纠正：') && w.includes('幽灵'))).toBe(true);
      });

      it('建补丁后补全状态写入统计（§7.1），写进 direct_main 结果与调试记录', async () => {
        const { game, pipeline } = await directFixture();
        directReply(
          treeReply([
            { op: 'delta', path: '/主角/生命值/当前', value: -1000 },
            { op: 'delta', path: '/关系列表/幽灵/好感度', value: 5 },
          ]),
        );
        expect(await pipeline.run('前进')).toBe(true);
        const entry = game.agentLogHistory
          .flatMap((turn) => turn.entries)
          .find((e) => e.agentId === 'direct_main');
        const expected = {
          protocol: 'tree',
          ops: 2,
          applied: 0,
          corrected: 1,
          dropped: 1,
          rejected: false,
        };
        expect(entry?.stateWriteStats).toEqual(expected);
        expect((pipeline as any).orch.getResults().get('direct_main').stateWriteStats).toEqual(
          expected,
        );
      });

      it('存档新闻随 runDirect 进读侧投影的 新闻', async () => {
        const { game, pipeline } = await directFixture();
        const news = [
          {
            id: 'n1',
            title: '王都戒严',
            content: '城门午后关闭。',
            category: '王都',
            publishedAt: 1,
            read: false,
          },
        ];
        game.saveProfile = { ...game.saveProfile!, news };
        const runDirect = vi.spyOn(AgentOrchestrator.prototype, 'runDirect');
        directReply(treeReply([]));
        expect(await pipeline.run('前进')).toBe(true);
        expect(runDirect.mock.calls[0][3]).toEqual({ news });
        const chat = vi.mocked(AgentClient.prototype.chat);
        const index = chat.mock.contexts.findIndex(
          (client: any) => client.agentId === 'direct_main',
        );
        expect(JSON.stringify(chat.mock.calls[index][0].messages)).toContain('王都戒严');
      });
    });

    it('旧协议（legacy）楼层不挂状态更新记录', async () => {
      const { game, pipeline } = await directFixture();
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const message = game.messages.find((m) => m.role === 'assistant')!;
      expect('stateUpdates' in message).toBe(false);
      const stored = await getDatabase().messages.get(message.id);
      expect(stored && 'stateUpdates' in stored).toBe(false);
    });

    it('旧协议（legacy）楼层接纳时不为清理前后值读全档消息', async () => {
      const { pipeline } = await directFixture();
      const p = pipeline as any;
      const strip = vi.spyOn(p, 'stripEarlierStateUpdateValues');
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      expect(strip).toHaveBeenCalledWith(false);
      // 本楼无记录、内存里也没有带前后值的记录：整个跳过，不进写锁读库
      p.currentTurnMessages = [];
      const where = vi.spyOn(getDatabase().messages, 'where');
      await p.stripEarlierStateUpdateValues(false);
      expect(where).not.toHaveBeenCalled();
    });

    it('更早楼层记录里的条目整对象前值（entryBefore）接纳新一楼时一并清掉，折叠字段保留', async () => {
      const { game, pipeline } = await directFixture();
      const p = pipeline as any;
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const message = game.messages.find((m) => m.role === 'assistant')!;
      const record = {
        deltaMinutes: 0,
        ops: [
          {
            path: '/主角/背包/药水/数量',
            op: 'delta',
            value: -1,
            status: '已应用',
            mergedFrom: [1],
          },
          {
            path: '/主角/背包/药水/数量',
            op: 'delta',
            value: -1,
            status: '已应用',
            foldedInto: 0,
            foldKind: 'fold',
            entryBefore: { name: '药水', quantity: 1, description: '一瓶红色药水' },
          },
        ],
      };
      const row = await getDatabase().messages.get(message.id);
      await getDatabase().messages.put({ ...row!, stateUpdates: record as never });
      message.stateUpdates = JSON.parse(JSON.stringify(record));
      // 模拟下一楼（legacy）接纳：只有 entryBefore 也不能走快速跳过
      p.currentTurnMessages = [];
      await p.stripEarlierStateUpdateValues(false);
      const expected = [
        { path: '/主角/背包/药水/数量', op: 'delta', value: -1, status: '已应用', mergedFrom: [1] },
        {
          path: '/主角/背包/药水/数量',
          op: 'delta',
          value: -1,
          status: '已应用',
          foldedInto: 0,
          foldKind: 'fold',
        },
      ];
      const stored = await getDatabase().messages.get(message.id);
      expect(stored?.stateUpdates?.ops).toEqual(expected);
      expect(message.stateUpdates?.ops).toEqual(expected);
    });

    it('legacy 楼层但内存里还有更早的带前后值记录时照常清理', async () => {
      const { game, pipeline } = await directFixture();
      const p = pipeline as any;
      directNetwork();
      expect(await pipeline.run('前进')).toBe(true);
      const message = game.messages.find((m) => m.role === 'assistant')!;
      const record = {
        deltaMinutes: 0,
        ops: [
          {
            path: '/主角/生命值/当前',
            op: 'delta',
            value: -10,
            status: '已应用',
            before: 80,
            after: 70,
          },
        ],
      };
      const row = await getDatabase().messages.get(message.id);
      await getDatabase().messages.put({ ...row!, stateUpdates: record as never });
      message.stateUpdates = JSON.parse(JSON.stringify(record));
      // 模拟下一楼接纳：上面那楼已是「更早楼层」
      p.currentTurnMessages = [];
      const where = vi.spyOn(getDatabase().messages, 'where');
      await p.stripEarlierStateUpdateValues(false);
      expect(where).toHaveBeenCalled();
      const stored = await getDatabase().messages.get(message.id);
      expect(stored?.stateUpdates?.ops).toEqual([
        { path: '/主角/生命值/当前', op: 'delta', value: -10, status: '已应用' },
      ]);
      expect(message.stateUpdates?.ops).toEqual(stored?.stateUpdates?.ops);
    });

    it('finishes turn bookkeeping when the run is cancelled right after the core commit', async () => {
      const { game, pipeline } = await directFixture();
      const db = getDatabase();
      await db.characters.put(createDefaultCharacterState({ id: 'guide', saveId, name: '向导' }));
      const { getProfile } = await import('@engine/state/save-profile');
      const before = { ...(await getProfile(saveId)).gameTime };
      const updates = JSON.stringify({
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
      });
      const chat = vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (
        this: any,
      ) {
        return result(
          this.agentId,
          this.agentId === 'direct_main'
            ? `<maintext>向导同意出发。</maintext><character_updates>${updates}</character_updates><direct_updates>{"version":1,"world":{},"time":{"delta_time":90},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>`
            : JSON.stringify({ segments: [{ content: '向导同意出发。' }] }),
        );
      });
      // 核心提交刚返回（setPendingOptions 紧随其后）就离开游戏页：dispose 绕过提交中的停止保护
      vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
        if (game.messages.some((m) => m.storyTurnStatus === 'accepted')) pipeline.dispose();
      });
      expect(await pipeline.run('邀请向导同行')).toBe(true);
      expect(advance).toHaveBeenCalledOnce();
      const after = (await db.saveProfiles.get(saveId))!.gameTime;
      expect(after).not.toEqual(before);
      expect(after.hour * 60 + after.minute - (before.hour * 60 + before.minute)).toBe(90);
      expect((await db.characters.get('guide'))?.goals).toBe('前往渡口');
      expect(
        (await db.characterChronicle.toArray()).filter((e) => e.characterId === 'guide'),
      ).toHaveLength(1);
      // 收尾完成后取消才生效：可选的记忆摘要不再发起
      expect(chat.mock.contexts.map((client: any) => client.agentId)).toEqual(['direct_main']);
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
      // 结构化战斗是显式开启的能力（默认关），本用例验证开启后的跨楼战斗路径
      setEngineSettingsProvider(() => ({ directStructuredCombat: true }));
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

    it('结构化战斗默认关：带完整战斗块的回复照常接纳，资源走 state，不建战斗记录', async () => {
      const { game, pipeline } = await directFixture();
      vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (this: any) {
        if (this.agentId !== 'direct_main')
          return result(
            this.agentId,
            JSON.stringify({ segments: [{ content: '旅人挨了一刀。' }] }),
          );
        const data = {
          version: 1,
          world: {},
          time: { delta_time: 0 },
          entities: [],
          state: { characters: { delta: [{ name: '旅人', path: 'hp', amount: -10 }] } },
          effects: [],
          plot: {},
          diceUsed: [],
          combat: {
            meta: { round: 1, combatType: '标准', environment: '街道', phase: 'active' },
            units: [
              {
                name: '旅人',
                origin: 'save',
                side: 'ally',
                hp: 50,
                mp: 10,
                sp: 10,
                statusEffects: [],
              },
            ],
          },
        };
        return result(
          this.agentId,
          `<maintext>旅人挨了一刀。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify(data)}</direct_updates>`,
        );
      });
      expect(await pipeline.run('迎击敌人')).toBe(true);
      expect((await getDatabase().characters.get('player'))!.hp).toBe(70);
      expect(
        (await getDatabase().saveProfiles.get(saveId))!.worldFlags.directCombat,
      ).toBeUndefined();
      expect(game.isInCombat).toBe(false);
      expect(game.player!.hp).toBe(70);
    });

    it('结构化战斗默认关：存档里进行中的战斗记录只休眠，不投影、不拦接纳、不被清掉', async () => {
      const { game, pipeline } = await directFixture();
      const record: DirectCombatRecord = {
        sourceTurnKey: 'earlier-turn',
        state: {
          meta: {
            round: 2,
            combatType: '标准',
            environment: '街道',
            coordinateRange: 8,
            actionOrder: ['旅人'],
            phase: 'active',
            regions: [],
          },
          units: {
            旅人: {
              name: '旅人',
              tier: 1,
              level: 1,
              race: '人类',
              attributes: { str: 1, dex: 1, con: 1, int: 1, spi: 1 },
              hp: 30,
              maxHp: 100,
              mp: 50,
              maxMp: 50,
              sp: 50,
              maxSp: 50,
              statusEffects: [],
              origin: 'save',
              side: 'ally',
              pos: 1,
              facing: 'right',
              slots: { attack: 1, action: 1 },
              alive: true,
              canAct: true,
              morale: 'steady',
            },
          },
        },
      };
      const { getProfile } = await import('@engine/state/save-profile');
      const profile = await getProfile(saveId);
      profile.worldFlags.directCombat = record;
      await getDatabase().saveProfiles.put(JSON.parse(JSON.stringify(profile)));
      await game.refreshFromDb(saveId);
      expect(game.player!.hp).toBe(80);
      expect(game.isInCombat).toBe(false);
      directNetwork();
      expect(await pipeline.run('继续前进')).toBe(true);
      expect((await getDatabase().characters.get('player'))!.hp).toBe(70);
      expect((await getDatabase().saveProfiles.get(saveId))!.worldFlags.directCombat).toEqual(
        record,
      );
      expect(game.isInCombat).toBe(false);
    });
  },
);
