/**
 * 状态写入统计（状态树协议设计 §7.1 / T14）：`summarizeStateWrites` 的口径、
 * generateDirectTurn 的解析期统计与整楼拒收日志，以及 runDirect 把存档新闻转给读侧投影。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDirectPatches, parseDirectOutput } from '../../../src/core/agents/direct-output';
import { DirectTurnError, generateDirectTurn } from '../../../src/core/agents/direct-main';
import { summarizeStateWrites } from '../../../src/core/agents/direct-write-stats';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import { AgentClient } from '../../../src/core/agents/agent-client';
import { AgentOrchestrator } from '../../../src/core/agents/agent-orchestrator';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import { invalidateDirectContext } from '../../../src/core/prompts/direct-context-session';
import { setEngineSettingsProvider } from '../../../src/core/runtime/engine-settings';
import {
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  resetEngineLoggerForTest,
  type EngineLogEntry,
  type EngineLogLayerHead,
  type EngineLogSink,
} from '../../../src/core/runtime/engine-logger';
import { getProfile } from '../../../src/core/state/save-profile';
import { clearAllData } from '../../../src/core/persistence/database';
import { createDefaultTime } from '../../../src/core/time/time-system';
import {
  createDefaultCharacterState,
  DEFAULT_AGENT_PIPELINE,
  type AgentConfig,
  type AgentContext,
  type ApiEndpoint,
} from '../../../src/core/types/types';

const saveId = 'direct-write-stats';
const POOL: DirectDicePool = [{ sides: 20, values: [7] }];

class MemorySink implements EngineLogSink {
  rows: EngineLogEntry[] = [];
  async write(entries: EngineLogEntry[]): Promise<void> {
    this.rows.push(...entries.map((entry) => ({ ...entry })));
  }
  async getLayerHead(): Promise<EngineLogLayerHead> {
    return { layer: 0 };
  }
}

let sink: MemorySink;

function wrap(updates: unknown): string {
  return `<maintext>你把铁块交给铁匠。</maintext><options>1. 等待</options><character_updates>{"characters":[]}</character_updates><direct_updates>${typeof updates === 'string' ? updates : JSON.stringify(updates)}</direct_updates>`;
}

function player() {
  return createDefaultCharacterState({
    id: 'p',
    saveId,
    name: '旅人',
    type: 'player',
    maxHp: 100,
    hp: 80,
    location: '王都/铁匠铺',
    present: true,
  });
}

const endpoint: ApiEndpoint = {
  id: 'ep',
  name: 'test',
  provider: 'openai',
  baseUrl: 'https://invalid.example/v1',
  apiKey: '',
  defaultModel: 'test-model',
  models: ['test-model'],
  timeout: 1000,
};

function agentConfig(agentId: string): AgentConfig {
  return {
    agentId,
    enabled: true,
    apiEndpointId: endpoint.id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    model: 'test-model',
    maxTokens: 1000,
    temperature: 0.7,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 1000,
    userId: 'test',
  };
}

function context(): AgentContext {
  return {
    userInput: '继续',
    characters: [player()],
    characterDefinitions: [],
    variables: {},
    history: [],
    worldBooks: [],
    memories: [],
    plotEvents: [],
    gameTime: createDefaultTime(),
    quests: {},
    affections: {},
    agentOutputs: new Map([['memory_recall', '']]),
  };
}

function mockReply(raw: string) {
  return vi.spyOn(AgentClient.prototype, 'chat').mockResolvedValue({
    agentId: 'direct_main',
    output: raw,
    rawResponse: raw,
    tokensUsed: 0,
    cacheHit: false,
    duration: 1,
  });
}

function turn() {
  const config = { ...agentConfig('direct_main'), presetId: createDirectPreset().id };
  return generateDirectTurn(
    {
      config,
      endpoint,
      context: context(),
      configs: [config],
      worldBooks: [],
      presets: [createDirectPreset()],
      combat: null,
      dice: POOL,
    },
    new AgentClient({ endpoint, agentId: 'direct_main', saveId, maxRetries: 0 }),
  );
}

beforeEach(async () => {
  await clearAllData();
  resetEngineLoggerForTest();
  sink = new MemorySink();
  installEngineLogSink(sink);
  configureEngineLogger({ enabled: true, level: 'trace' });
  setEngineSettingsProvider(() => ({ stateProtocol: 'tree' }));
});

afterEach(() => {
  setEngineSettingsProvider(undefined);
  resetEngineLoggerForTest();
  invalidateDirectContext(saveId);
  vi.restoreAllMocks();
});

describe('summarizeStateWrites（tree）', () => {
  it('建补丁后按翻译记录逐条计；解析期与建补丁期的丢弃合计；ops = 三者之和', async () => {
    const draft = parseDirectOutput(
      wrap({
        version: 2,
        patch: [
          { op: 'delta', path: '/主角/生命值/当前', value: -10 },
          // 提交时注定抛错：建补丁期丢弃
          { op: 'replace', path: '/主角/成长/等级', value: 9 },
          // 缺路径：解析期丢弃
          { op: 'delta', value: 1 },
        ],
      }),
      POOL,
      { stateProtocol: 'tree', structuredCombat: false },
    );
    expect(draft.dropped).toHaveLength(1);
    const parseOnly = summarizeStateWrites('tree', draft);
    expect(parseOnly).toEqual({
      protocol: 'tree',
      ops: 3,
      applied: 2,
      corrected: 0,
      dropped: 1,
      rejected: false,
    });
    const built = buildDirectPatches(draft, {
      characters: [player()],
      definitions: [],
      sourceTurnKey: 'u',
      profile: await getProfile(saveId),
    });
    expect(built.dropped).toHaveLength(1);
    expect(summarizeStateWrites('tree', draft, built)).toEqual({
      protocol: 'tree',
      ops: 3,
      applied: 1,
      corrected: 0,
      dropped: 2,
      rejected: false,
    });
  });

  it('缺 direct_updates 区块时标 updatesMissing', () => {
    const raw =
      '<maintext>钟声响起。</maintext><character_updates>{"characters":[]}</character_updates>';
    const draft = parseDirectOutput(raw, POOL, { stateProtocol: 'tree', structuredCombat: false });
    expect(draft.updatesMissing).toBe(true);
    expect(summarizeStateWrites('tree', draft)).toMatchObject({
      ops: 0,
      dropped: 0,
      rejected: false,
      updatesMissing: true,
    });
  });
});

describe('summarizeStateWrites（legacy）', () => {
  it('按写入单元近似：时间推进与 state 操作行各计 1', () => {
    const draft = parseDirectOutput(
      wrap({
        version: 1,
        world: {},
        time: { delta_time: 10 },
        entities: [],
        state: { fp: { delta: 1 } },
        effects: [],
        plot: {},
        combat: null,
        diceUsed: [],
      }),
      POOL,
      { stateProtocol: 'legacy', structuredCombat: false },
    );
    const stats = summarizeStateWrites('legacy', draft, { dropped: [] });
    expect(stats).toMatchObject({ protocol: 'legacy', ops: 2, dropped: 0, rejected: false });
    expect(stats.applied + stats.corrected + stats.dropped).toBe(stats.ops);
  });
});

describe('generateDirectTurn 的统计', () => {
  it('接纳的楼带解析期统计，不在这里记 state.write_stats（留给建补丁之后）', async () => {
    mockReply(wrap({ version: 2, patch: [{ op: 'delta', path: '/主角/生命值/当前', value: -5 }] }));
    const { result } = await turn();
    expect(result.stateWriteStats).toEqual({
      protocol: 'tree',
      ops: 1,
      applied: 1,
      corrected: 0,
      dropped: 0,
      rejected: false,
    });
    await flushEngineLog();
    expect(sink.rows.filter((row) => row.cat === 'state.write_stats')).toHaveLength(0);
  });

  it('整楼拒收：结果带 rejected 统计，记一条带模型名的 state.write_stats', async () => {
    mockReply(wrap('{坏掉的'));
    const error = await turn().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DirectTurnError);
    expect((error as DirectTurnError).result.stateWriteStats).toEqual({
      protocol: 'tree',
      ops: 0,
      applied: 0,
      corrected: 0,
      dropped: 0,
      rejected: true,
    });
    await flushEngineLog();
    const rows = sink.rows.filter((row) => row.cat === 'state.write_stats');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      protocol: 'tree',
      rejected: true,
      model: 'test-model',
    });
  });
});

describe('runDirect 转发新闻（T9b 缺口）', () => {
  it('tree 下存档新闻进 stat_data 的 新闻', async () => {
    const chat = mockReply(wrap({ version: 2, patch: [] }));
    const instance = new AgentOrchestrator(
      {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context: context(),
        saveId,
        endpoints: [endpoint],
        agentConfigs: ['memory_recall', 'direct_main'].map(agentConfig),
        storyContext: { windowTurns: 2, segments: [], archives: [] },
      },
      {},
    );
    await instance.runDirect(null, undefined, undefined, {
      news: [
        {
          id: 'n1',
          title: '王都戒严',
          content: '城门午后关闭。',
          category: '王都',
          publishedAt: 1,
          read: false,
        },
      ],
    });
    const messages = chat.mock.calls[chat.mock.calls.length - 1][0].messages;
    const last = String(messages[messages.length - 1].content);
    const state = JSON.parse(last.match(/<direct_state>\n([\s\S]*?)\n<\/direct_state>/)![1]);
    expect(JSON.stringify(state.stat_data['新闻'])).toContain('王都戒严');
  });
});
