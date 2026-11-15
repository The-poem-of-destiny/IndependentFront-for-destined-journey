/**
 * game-pipeline.plugins.test.ts —— 回合管线的插件接线（插件系统计划 D5，设计 §6.1 / §5.8）
 *
 * 管线只经 `plugin-run-signals` 这条接缝与插件运行时交换信号，这里钉五件事：
 *   ① 发送侧等待：回合开始前已在途的插件写入落地之后才组上下文；
 *   ② 每回合恰好一对信号：turn.start + turn.end（成功）或 turn.start + turn.failed（失败 / 取消）；
 *   ③ buildContext 从 provider 取插件提示词输入，填进 ctx.pluginNotes / ctx.pluginContext；
 *   ④ 成功收口时按本回合回合号清掉已消费的待告知条目，失败回合一条不清；
 *   ⑤ 直出模式的收口点同样清理。
 *
 * 夹具照 `game-pipeline.boundaries.test.ts`：真 game-store + fake-indexeddb，只替换网络与 advanceTurn。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GamePipeline } from '../../../src/ui/lib/game-pipeline';
import { useGameStore } from '../../../src/ui/stores/game-store';
import {
  onPluginTurnSignal,
  resetPluginRunSignalsForTest,
  setPluginPromptInputProvider,
  trackPluginWrite,
  type PluginTurnSignal,
} from '../../../src/ui/lib/plugin-run-signals';
import { AgentClient } from '@engine/agents/agent-client';
import { clearAllData, getDatabase, saveSaveSlot } from '@engine/persistence/database';
import { withSaveWriteLock } from '@engine/state/state-write-queue';
import { resetPromptSessionsForTest } from '@engine/prompts/prompt-session-assembler';
import { clearPluginNotesForTurn, enqueuePluginNote, getProfile } from '@engine/state/save-profile';
import type { SaveSlot } from '@engine/types/types';
import { createDefaultCharacterState } from '@engine/types/types';
import type { PluginRunGuard } from '@engine/types/types-plugin';

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
// 清理入口换成透传的 spy：既能断言回合号，又真的落库
vi.mock('@engine/state/save-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/state/save-profile')>();
  return {
    ...actual,
    clearPluginNotesForTurn: vi.fn(actual.clearPluginNotesForTurn),
  };
});
vi.mock('../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

const saveId = 'pipeline-plugins';
const OK: PluginRunGuard = () => 'ok';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  await getProfile(saveId);
  const game = useGameStore();
  game.saves = [save];
  game.activeSaveId = saveId;
  game.messages = [];
  return { game, pipeline: configure(game) };
}

function result(agentId: string, rawResponse: string) {
  return { agentId, output: rawResponse, rawResponse, tokensUsed: 0, cacheHit: false, duration: 0 };
}

function network(story = '旅人推开了酒馆的门。') {
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

/** 订阅回合信号，返回收到的序列 */
function recordSignals(): PluginTurnSignal[] {
  const seen: PluginTurnSignal[] = [];
  onPluginTurnSignal((signal) => seen.push(signal));
  return seen;
}

async function pendingNotes() {
  const profile = await getProfile(saveId);
  return (profile.worldFlags?.pluginNotes ?? []) as Array<{ text: string; turn: number }>;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  resetPromptSessionsForTest();
  resetPluginRunSignalsForTest();
  await clearAllData();
});
afterEach(async () => {
  await withSaveWriteLock(saveId, async () => {});
  resetPluginRunSignalsForTest();
  vi.restoreAllMocks();
});

describe('发送侧等待（设计 §6.1）', () => {
  it('回合开始前在途的插件写入未落地时，不组上下文；落地之后才组', async () => {
    const { pipeline } = await fixture();
    network();
    const order: string[] = [];
    const p = pipeline as any;
    // 准入改成立即放行：否则它本身的异步耗时会掩盖「没等写入」
    p.admitPackLease = async () => true;
    const realBuild = p.buildContext.bind(p);
    p.buildContext = (...args: unknown[]) => {
      order.push('buildContext');
      return realBuild(...args);
    };
    const write = deferred<void>();
    void trackPluginWrite(
      write.promise.then(() => {
        order.push('pluginWrite');
      }),
    );

    const running = pipeline.run('点一杯麦酒');
    // 让出若干拍：写入不落地，上下文就不能开始组
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);

    write.resolve();
    expect(await running).toBe(true);
    expect(order[0]).toBe('pluginWrite');
    expect(order[1]).toBe('buildContext');
  });

  it('turn.start 在等待之前就发出（此后插件写入被判 BUSY）', async () => {
    const { game, pipeline } = await fixture();
    network();
    const seen = recordSignals();
    const write = deferred<void>();
    void trackPluginWrite(write.promise);
    const running = pipeline.run('点一杯麦酒');
    await Promise.resolve();
    expect(seen).toEqual([{ type: 'turn.start', saveId }]);
    expect(game.isGenerating).toBe(true);
    write.resolve();
    await running;
  });
});

describe('回合信号：每回合恰好一对 start + end / failed', () => {
  it('成功回合：turn.start → turn.end', async () => {
    const { pipeline } = await fixture();
    network();
    const seen = recordSignals();
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    expect(seen).toEqual([
      { type: 'turn.start', saveId },
      { type: 'turn.end', saveId },
    ]);
  });

  it('turn.end 发出时 isGenerating 已复位（插件随后写入不会被判 BUSY）', async () => {
    const { game, pipeline } = await fixture();
    network();
    const generatingAtEnd: boolean[] = [];
    onPluginTurnSignal((signal) => {
      if (signal.type === 'turn.end') generatingAtEnd.push(game.isGenerating);
    });
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    expect(generatingAtEnd).toEqual([false]);
  });

  it('advanceTurn 失败：turn.start → turn.failed', async () => {
    const { pipeline } = await fixture();
    network();
    advance.mockRejectedValueOnce(new Error('回合推进写库失败'));
    const seen = recordSignals();
    expect(await pipeline.run('点一杯麦酒')).toBe(false);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.failed']);
  });

  it('玩家中途停止：turn.start → turn.failed', async () => {
    const { game, pipeline } = await fixture();
    network();
    vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      if (game.messages.some((m) => m.role === 'assistant')) pipeline.abort();
    });
    const seen = recordSignals();
    expect(await pipeline.run('点一杯麦酒')).toBe(false);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.failed']);
  });

  it('网络层抛错（story 失败）：turn.start → turn.failed', async () => {
    const { pipeline } = await fixture();
    vi.spyOn(AgentClient.prototype, 'chat').mockRejectedValue(new Error('上游 500'));
    const seen = recordSignals();
    expect(await pipeline.run('点一杯麦酒')).toBe(false);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.failed']);
  });

  it('收尾本身抛错也照样发 turn.failed / turn.end 之一', async () => {
    const { game, pipeline } = await fixture();
    network();
    vi.spyOn(game, 'refreshFromDb').mockRejectedValue(new Error('回读失败'));
    const seen = recordSignals();
    await expect(pipeline.run('点一杯麦酒')).rejects.toThrow('回读失败');
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.end']);
  });

  it('准入被拒（不开回合）时一条信号都不发', async () => {
    const { pipeline } = await fixture();
    (pipeline as any).abortController = new AbortController(); // 上一轮仍在跑
    const seen = recordSignals();
    expect(await (pipeline as any).executeRun('点一杯麦酒')).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('提示词输入（决定 13）', () => {
  it('buildContext 从 provider 取 notes / contexts 填进 ctx', async () => {
    const { pipeline } = await fixture();
    network();
    setPluginPromptInputProvider(() => ({
      notes: [{ pluginName: '商店', text: '玩家买了一把短剑' }],
      contexts: [{ pluginName: '天气站', text: '今夜有雪' }],
    }));
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    const ctx = (pipeline as any).currentContext;
    expect(ctx.pluginNotes).toEqual([{ pluginName: '商店', text: '玩家买了一把短剑' }]);
    expect(ctx.pluginContext).toEqual([{ pluginName: '天气站', text: '今夜有雪' }]);
  });

  it('没有 provider 时供空列表，回合照常', async () => {
    const { pipeline } = await fixture();
    network();
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    const ctx = (pipeline as any).currentContext;
    expect(ctx.pluginNotes).toEqual([]);
    expect(ctx.pluginContext).toEqual([]);
  });

  it('插件可见告知（system 消息）不进入历史', async () => {
    const { game, pipeline } = await fixture();
    network();
    game.messages = [
      {
        id: 'sys',
        role: 'system',
        content: '【商店】玩家买了一把短剑',
        timestamp: 1,
        saveId,
        systemEvent: {
          type: 'plugin_note',
          pluginId: 'shop',
          pluginName: '商店',
          text: '玩家买了一把短剑',
          narrative: '【商店】玩家买了一把短剑',
        },
      } as any,
    ];
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    const ctx = (pipeline as any).currentContext;
    expect(ctx.history.some((m: { content: string }) => m.content.includes('短剑'))).toBe(false);
  });
});

describe('待告知条目的清理（C5 回合号语义）', () => {
  it('成功回合按本回合回合号 N = totalTurns + 1 清掉 turn < N 的条目', async () => {
    const { game, pipeline } = await fixture();
    network();
    game.saves[0].metadata.totalTurns = 4;
    await enqueuePluginNote(saveId, 'shop', '商店', '上回合买的剑', { turn: 4 }, OK);
    await enqueuePluginNote(saveId, 'shop', '商店', '更早的告知', { turn: 2 }, OK);
    // 理论上回合中写入会被拒；即便有一条记着本回合号，也不属于本回合消费的那一批
    await enqueuePluginNote(saveId, 'map', '地图', '本回合之后的告知', { turn: 5 }, OK);

    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    expect(vi.mocked(clearPluginNotesForTurn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearPluginNotesForTurn)).toHaveBeenCalledWith(saveId, 5);
    expect((await pendingNotes()).map((n) => n.text)).toEqual(['本回合之后的告知']);
  });

  it('失败回合一条不清，条目留给下一次尝试', async () => {
    const { pipeline } = await fixture();
    network();
    await enqueuePluginNote(saveId, 'shop', '商店', '买了一把剑', { turn: 0 }, OK);
    advance.mockRejectedValueOnce(new Error('回合推进写库失败'));
    expect(await pipeline.run('点一杯麦酒')).toBe(false);
    expect(vi.mocked(clearPluginNotesForTurn)).not.toHaveBeenCalled();
    expect((await pendingNotes()).map((n) => n.text)).toEqual(['买了一把剑']);
  });

  it('取消的回合同样不清', async () => {
    const { game, pipeline } = await fixture();
    network();
    await enqueuePluginNote(saveId, 'shop', '商店', '买了一把剑', { turn: 0 }, OK);
    vi.spyOn(game, 'setPendingOptions').mockImplementation(() => {
      if (game.messages.some((m) => m.role === 'assistant')) pipeline.abort();
    });
    expect(await pipeline.run('点一杯麦酒')).toBe(false);
    expect((await pendingNotes()).map((n) => n.text)).toEqual(['买了一把剑']);
  });

  it('清理失败不致命：回合仍算成功', async () => {
    const { pipeline } = await fixture();
    network();
    vi.mocked(clearPluginNotesForTurn).mockRejectedValueOnce(new Error('写锁超时'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = recordSignals();
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.end']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('插件待告知条目清理失败'),
      expect.any(Error),
    );
  });

  it('清理不在存档写锁内调用（否则自身取锁会死锁）', async () => {
    const { pipeline } = await fixture();
    network();
    await enqueuePluginNote(saveId, 'shop', '商店', '买了一把剑', { turn: 0 }, OK);
    // 真实实现自己进锁；能跑完且条目被清，就说明调用点不在锁内
    expect(await pipeline.run('点一杯麦酒')).toBe(true);
    expect(await pendingNotes()).toEqual([]);
  });
});

describe.each(['direct', 'direct_cached'] as const)('%s 模式收口', (mode) => {
  async function directFixture() {
    const { game, pipeline } = await fixture();
    game.activeSave!.metadata.generationMode = mode;
    await saveSaveSlot(JSON.parse(JSON.stringify(game.activeSave!)));
    const { createDirectPreset, createCachedDirectPreset } =
      await import('@engine/prompts/direct-prompt');
    const preset = mode === 'direct_cached' ? createCachedDirectPreset() : createDirectPreset();
    const p = pipeline as any;
    p.loadPresets = async () => ({ presets: [preset], agentDefaults: {} });
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
          ? `<maintext>旅人继续前行。</maintext><character_updates>{"characters":[]}</character_updates>${valid ? '<direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{"characters":{"delta":[]}},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>' : ''}`
          : this.agentId === 'memory_summary'
            ? JSON.stringify({ segments: [{ content: '旅人继续前行。' }] })
            : '{}';
      return result(this.agentId, raw);
    });
  }

  it('接纳后清掉已消费条目并发 turn.end', async () => {
    const { pipeline } = await directFixture();
    directNetwork();
    await enqueuePluginNote(saveId, 'shop', '商店', '买了一把剑', { turn: 0 }, OK);
    setPluginPromptInputProvider(() => ({
      notes: [{ pluginName: '商店', text: '买了一把剑' }],
      contexts: [],
    }));
    const seen = recordSignals();
    expect(await pipeline.run('前进')).toBe(true);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.end']);
    expect(vi.mocked(clearPluginNotesForTurn)).toHaveBeenCalledWith(saveId, 1);
    expect(await pendingNotes()).toEqual([]);
    expect((pipeline as any).currentContext.pluginNotes).toEqual([
      { pluginName: '商店', text: '买了一把剑' },
    ]);
  });

  it('输出被拒（未接纳）时不清，发 turn.failed', async () => {
    const { pipeline } = await directFixture();
    directNetwork(false);
    await enqueuePluginNote(saveId, 'shop', '商店', '买了一把剑', { turn: 0 }, OK);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = recordSignals();
    expect(await pipeline.run('前进')).toBe(false);
    expect(seen.map((s) => s.type)).toEqual(['turn.start', 'turn.failed']);
    expect(vi.mocked(clearPluginNotesForTurn)).not.toHaveBeenCalled();
    expect((await pendingNotes()).map((n) => n.text)).toEqual(['买了一把剑']);
  });
});
