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

const { advance, toast } = vi.hoisted(() => ({ advance: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('@engine/state/state-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@engine/state/state-manager')>()),
  createStateManager: () => ({
    advanceTurn: advance,
    syncRandomEventsForTurn: async () => {},
    commitChatState: async () => ({
      success: true,
      patchesApplied: 0,
      eventsGenerated: [],
      errors: [],
    }),
  }),
}));
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
function network(story = 'The story was produced.') {
  return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (
    this: any,
    _request,
    signal,
  ) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const raw =
      this.agentId === 'story'
        ? `<maintext>${story}</maintext>`
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
