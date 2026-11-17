/**
 * GamePipeline × 引擎日志回合作用域：正式回合开作用域并以来源玩家消息 id 作 layerKey，
 * 成功 / 失败都会 end。走真实管线（照 game-pipeline.boundaries.test.ts 的夹具）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GamePipeline } from '../../../src/ui/lib/game-pipeline';
import { useGameStore } from '../../../src/ui/stores/game-store';
import { AgentClient } from '@engine/agents/agent-client';
import { clearAllData, saveSaveSlot } from '@engine/persistence/database';
import { withSaveWriteLock } from '@engine/state/state-write-queue';
import { resetPromptSessionsForTest } from '@engine/prompts/prompt-session-assembler';
import type { SaveSlot } from '@engine/types/types';

const { beginLogScope, scopeEnd } = vi.hoisted(() => {
  const scopeEnd = vi.fn();
  return { scopeEnd, beginLogScope: vi.fn(() => ({ end: scopeEnd })) };
});
vi.mock('@engine/runtime/engine-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/runtime/engine-logger')>();
  return { ...actual, beginLogScope };
});
vi.mock('@engine/state/state-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/state/state-manager')>();
  return {
    ...actual,
    createStateManager: (id: string) => {
      const manager = actual.createStateManager(id);
      manager.advanceTurn = async () => {};
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
vi.mock('../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast: vi.fn() }) }));

const saveId = 'pipeline-engine-log';
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

async function fixture() {
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
  const game = useGameStore();
  game.saves = [save];
  game.activeSaveId = saveId;
  game.messages = [];
  return { game, pipeline: configure(game) };
}

function network() {
  return vi.spyOn(AgentClient.prototype, 'chat').mockImplementation(async function (
    this: any,
    _request,
    signal,
  ) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const raw =
      this.agentId === 'story'
        ? '<maintext>故事继续。</maintext>'
        : this.agentId === 'memory_summary'
          ? JSON.stringify({ segments: [{ content: '故事继续。' }] })
          : '{}';
    return {
      agentId: this.agentId,
      output: raw,
      rawResponse: raw,
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
    };
  });
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

describe('GamePipeline 引擎日志回合作用域', () => {
  it('正式回合以来源玩家消息 id 作 layerKey 开作用域，成功后以 completed 结束；重新生成沿用同一 layerKey', async () => {
    const { game, pipeline } = await fixture();
    network();

    expect(await pipeline.run('推开木门')).toBe(true);
    const user = game.messages.find((m) => m.role === 'user')!;
    expect(beginLogScope).toHaveBeenCalledTimes(1);
    expect(beginLogScope).toHaveBeenCalledWith(
      expect.objectContaining({ saveId, layerKey: user.id, turn: 1 }),
    );
    expect(scopeEnd).toHaveBeenCalledTimes(1);
    expect(scopeEnd).toHaveBeenCalledWith('completed');

    // 重新生成同一条输入：同一个来源消息 id → 引擎侧归入当前层
    await pipeline.run(user.content, undefined, false, user.id);
    expect(beginLogScope).toHaveBeenCalledTimes(2);
    expect(beginLogScope).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ layerKey: user.id }),
    );
    expect(scopeEnd).toHaveBeenCalledTimes(2);
  });

  it('回合失败时作用域也会以 failed 结束', async () => {
    const { game, pipeline } = await fixture();
    network();
    vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      throw new Error('投影失败');
    });

    expect(await pipeline.run('推开木门')).toBe(false);
    expect(beginLogScope).toHaveBeenCalledTimes(1);
    expect(scopeEnd).toHaveBeenCalledTimes(1);
    expect(scopeEnd).toHaveBeenCalledWith('failed');
  });
});
