/**
 * direct-main.ts 与归一化的接线：剧情开关经 plotSettings.mode 传成 plotEnabled、
 * 有纠正时记 warn `direct.output_normalized`；以及协议里「输入状态区块」指向的
 * plotSettings 与存档字段名在两种直出的实际输入里都存在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateDirectTurn,
  type DirectGenerationInput,
} from '../../../src/core/agents/direct-main';
import { AgentClient } from '../../../src/core/agents/agent-client';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import { invalidateDirectContext } from '../../../src/core/prompts/direct-context-session';
import {
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  resetEngineLoggerForTest,
  type EngineLogEntry,
  type EngineLogLayerHead,
  type EngineLogSink,
} from '../../../src/core/runtime/engine-logger';
import {
  createDefaultCharacterState,
  type AgentConfig,
  type AgentResult,
  type ApiEndpoint,
  type PlotSettings,
} from '../../../src/core/types/types';

const saveId = 'direct-main-normalize';

class MemorySink implements EngineLogSink {
  rows: EngineLogEntry[] = [];
  async write(entries: EngineLogEntry[]): Promise<void> {
    this.rows.push(...entries.map((entry) => ({ ...entry })));
  }
  async getLayerHead(): Promise<EngineLogLayerHead> {
    return { layer: 0 };
  }
  byCat(cat: string): EngineLogEntry[] {
    return this.rows.filter((row) => row.cat === cat);
  }
}

let sink: MemorySink;

beforeEach(() => {
  resetEngineLoggerForTest();
  sink = new MemorySink();
  installEngineLogSink(sink);
  configureEngineLogger({ enabled: true, level: 'trace' });
});

afterEach(() => {
  resetEngineLoggerForTest();
  vi.restoreAllMocks();
});

/** 非空 plot：剧情关闭时应整体丢弃 */
const PLOT = { pre: { triggeredEvents: [{ title: '神官现身', reason: '旅人抵达神殿' }] } };

function updates(plot: unknown): Record<string, unknown> {
  return {
    version: 1,
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot,
    combat: null,
    diceUsed: [],
  };
}

function raw(data: Record<string, unknown>): string {
  return `<maintext>钟声响起。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify(data)}</direct_updates>`;
}

function setup(mode: PlotSettings['mode']): { input: DirectGenerationInput; client: AgentClient } {
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
  const player = createDefaultCharacterState({
    id: 'p',
    saveId,
    name: '旅人',
    type: 'player',
    outfit: '旅行斗篷',
  });
  return {
    input: {
      config,
      endpoint,
      configs: [config],
      presets: [createDirectPreset()],
      worldBooks: [],
      combat: null,
      context: {
        userInput: '走进神殿',
        characters: [player],
        variables: {},
        history: [],
        memories: [],
        worldBooks: [],
        plotEvents: [],
        plotSettings: { mode, tabooContent: '' },
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

function block(content: unknown, tag: string): Record<string, any> {
  const match = String(content).match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, any>;
}

describe('generateDirectTurn：剧情开关与纠正日志', () => {
  it("plotSettings.mode 为 'off' 时非空 plot 被丢弃，并记 warn direct.output_normalized", async () => {
    const { input, client } = setup('off');
    mockChat(raw(updates(PLOT)));
    const { draft } = await generateDirectTurn(input, client);
    expect(draft.updates.plot).toEqual({});
    expect(draft.normalized).toEqual(['plot：剧情系统未启用，已丢弃']);
    await flushEngineLog();
    const [entry] = sink.byCat('direct.output_normalized');
    expect(entry).toBeDefined();
    expect(entry.level).toBe('warn');
    expect(entry.agentId).toBe('direct_main');
    expect(entry.msg).toBe('直出结果形状有偏差，已自动纠正 1 处');
    expect(JSON.parse(entry.payload)).toEqual({ notes: ['plot：剧情系统未启用，已丢弃'] });
  });

  it('剧情开启时 plot 原样保留，没有纠正就不记 direct.output_normalized', async () => {
    const { input, client } = setup('main');
    mockChat(raw(updates(PLOT)));
    const { draft } = await generateDirectTurn(input, client);
    expect(draft.updates.plot).toEqual(PLOT);
    expect(draft.normalized).toBeUndefined();
    await flushEngineLog();
    expect(sink.byCat('direct.output_normalized')).toEqual([]);
  });
});

describe('协议「输入状态区块」指向的字段在两种直出里都存在', () => {
  it('非缓存：direct_state.plotSettings.mode 与人物存档字段名', async () => {
    const { input, client } = setup('off');
    const chat = mockChat(raw(updates({})));
    await generateDirectTurn(input, client);
    const messages = chat.mock.calls[0][0].messages;
    const state = block(messages[messages.length - 1].content, 'direct_state');
    expect(state.plotSettings.mode).toBe('off');
    expect(state.characters[0]).toMatchObject({ outfit: '旅行斗篷', statusEffects: [] });
    expect(state.characters[0].ascension).toHaveProperty('authority');
    expect(state.characters[0].ascension).toHaveProperty('law');
  });

  it('缓存：plotSettings 是 direct_context.set 的顶层分区，人物档案用存档字段名', async () => {
    invalidateDirectContext(saveId);
    const { input, client } = setup('off');
    input.cache = { saveId, policy: 'prefix' };
    mockChat(raw(updates({})));
    const first = await generateDirectTurn(input, client);
    const messages = first.result.requestMessages!;
    const retained = messages[first.cache!.ticket.retainedCount - 1];
    const context = block(retained.content, 'direct_context');
    expect(context.set.plotSettings.mode).toBe('off');
    expect(context).not.toHaveProperty('direct_state');
    const profile = context.set['character/旅人/profile'];
    expect(profile.outfit).toBe('旅行斗篷');
    expect(profile.ascension).toHaveProperty('authority');
    expect(context.set).toHaveProperty('character/旅人/statusEffects');
    invalidateDirectContext(saveId);
  });
});
