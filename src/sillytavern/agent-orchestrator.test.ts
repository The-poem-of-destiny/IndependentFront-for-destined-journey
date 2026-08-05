/**
 * agent-orchestrator.ts — DAG 编排引擎测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentOrchestrator } from './agent-orchestrator';
import type { AgentContext, AgentConfig, ApiEndpoint, Pipeline } from './types';

// state-manager mock: 捕获 commitChatState 收到的 patches（Stage3 <json> 解析测试用）
const { commitChatStateMock } = vi.hoisted(() => ({
  commitChatStateMock: vi.fn(async (patches: any[]) => ({
    success: true,
    patchesApplied: patches.length,
    eventsGenerated: [],
    errors: [] as string[],
  })),
}));
vi.mock('./state-manager', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./state-manager')>();
  return {
    ...orig,
    createStateManager: vi.fn(() => ({
      commitChatState: commitChatStateMock,
      applyTimeAdvance: vi.fn(),
    })),
  };
});

// ========== Helpers ==========

function mockFetch(content: string, tokens = 50, cacheHit = false) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(cacheHit ? { 'x-ds-cache-hit': 'true' } : {}),
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { total_tokens: tokens },
      ...(cacheHit ? { cache_hit: true } : {}),
    }),
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  });
}

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'ep_1',
    name: 'Default',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test',
    defaultModel: 'test-model',
    models: ['test-model'],
    timeout: 60000,
    ...overrides,
  };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'story',
    enabled: true,
    apiEndpointId: 'ep_1',
    model: 'test-model',
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1.0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 30000,
    userId: 'fp|test|story',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

function makeSimplePipeline(agents: string[]): Pipeline {
  return {
    timeout: 30000,
    retryOnFail: false,
    stages: [{ agents, waitFor: [] }],
  };
}

const ALL_AGENT_CONFIGS: AgentConfig[] = [
  makeAgentConfig({ agentId: 'memory_recall' }),
  makeAgentConfig({ agentId: 'plot_check' }),
  makeAgentConfig({ agentId: 'story' }),
  makeAgentConfig({ agentId: 'request_dispatcher' }),
  makeAgentConfig({ agentId: 'vars_update' }),
  makeAgentConfig({ agentId: 'memory_summary' }),
  makeAgentConfig({ agentId: 'plot_correct' }),
];

// ========== Pipeline Validation ==========

describe('AgentOrchestrator — 管线验证', () => {
  it('有效管线应通过验证', async () => {
    globalThis.fetch = mockFetch('ok');
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();
    expect(run.status).toBe('completed');
  });

  it('未知 Agent 应失败', async () => {
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['nonexistent_agent']),
      context: makeContext(),
      agentConfigs: ALL_AGENT_CONFIGS,
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();
    expect(run.status).toBe('failed');
  });

  it('等待异步完成回调后才结束管线', async () => {
    globalThis.fetch = mockFetch('ok');
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onAgentComplete = vi.fn(() => persisted);
    const orch = new AgentOrchestrator(
      {
        pipeline: makeSimplePipeline(['story']),
        context: makeContext(),
        agentConfigs: [makeAgentConfig({ agentId: 'story' })],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onAgentComplete },
    );

    let settled = false;
    const run = orch.run().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(onAgentComplete).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    release();
    await expect(run).resolves.toMatchObject({ status: 'completed' });
  });

  it('fails a required agent when its completion handler rejects', async () => {
    globalThis.fetch = mockFetch('ok');
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: true,
      requiredAgents: ['story'],
      stages: [
        { agents: ['memory_recall'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall'] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };
    const orch = new AgentOrchestrator(
      {
        pipeline,
        context: makeContext(),
        agentConfigs: [
          makeAgentConfig({ agentId: 'memory_recall' }),
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      {
        onAgentComplete: (result) => {
          if (result.agentId === 'story') throw new Error('persistence failed');
        },
      },
    );

    const run = await orch.run();
    const results = orch.getResults();

    expect(run.status).toBe('failed');
    expect(results.get('story')?.error).toContain('persistence failed');
    expect(results.get('request_dispatcher')).toBeUndefined();
  });
});

describe('AgentOrchestrator — 流式回调桥接', () => {
  function makeStreamingOrchestrator() {
    return new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });
  }

  it('向配置层转发 chunk、tool call 与完成事件', async () => {
    const onChunk = vi.fn();
    const onToolCall = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const config = makeAgentConfig({
      agentId: 'story',
      streamCallbacks: { onChunk, onToolCall, onComplete, onError },
    });
    const streamResult = {
      fullText: '正文',
      toolCalls: [],
      reasoning: '',
      tokensUsed: 3,
      cacheHit: false,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      completionTokens: 2,
      duration: 10,
    };
    const client = {
      chatStream: vi.fn(
        async (_request: unknown, callbacks: import('./agent-client').StreamCallbacks) => {
          callbacks.onChunk('正文', false);
          callbacks.onToolCall?.({ id: 'call', name: 'tool', arguments: '{}' });
          callbacks.onComplete(streamResult);
        },
      ),
    };

    const result = await (makeStreamingOrchestrator() as any).callAgentStreaming(
      client,
      { messages: [] },
      config,
    );

    expect(onChunk).toHaveBeenCalledWith('正文', false);
    expect(onToolCall).toHaveBeenCalledWith({ id: 'call', name: 'tool', arguments: '{}' });
    expect(onComplete).toHaveBeenCalledWith(streamResult);
    expect(onError).not.toHaveBeenCalled();
    expect(result).toMatchObject({ output: '正文', rawResponse: '正文', tokensUsed: 3 });
  });

  it('向配置层转发错误并结算为失败结果', async () => {
    const onError = vi.fn();
    const config = makeAgentConfig({
      agentId: 'story',
      streamCallbacks: {
        onChunk: vi.fn(),
        onComplete: vi.fn(),
        onError,
      },
    });
    const client = {
      chatStream: vi.fn(
        async (_request: unknown, callbacks: import('./agent-client').StreamCallbacks) => {
          callbacks.onError('stream failed');
        },
      ),
    };

    const result = await (makeStreamingOrchestrator() as any).callAgentStreaming(
      client,
      { messages: [] },
      config,
    );

    expect(onError).toHaveBeenCalledWith('stream failed');
    expect(result).toMatchObject({ output: null, error: 'stream failed' });
  });
});

// ========== Basic Execution ==========

describe('AgentOrchestrator — 基本执行', () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch('{"result": "ok"}');
  });

  it('单 Agent 单阶段应正常完成', async () => {
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'save_1',
    });

    const run = await orch.run();
    expect(run.status).toBe('completed');
    expect(run.completedStages).toHaveLength(1);

    const results = orch.getResults();
    expect(results.has('story')).toBe(true);
    expect(results.get('story')!.error).toBeUndefined();
  });

  it('多阶段串行应正确执行', async () => {
    globalThis.fetch = mockFetch('result');
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['memory_recall'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall'] },
        { agents: ['memory_summary'], waitFor: ['story'] },
      ],
    };

    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext({ userInput: '测试' }),
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall' }),
        makeAgentConfig({ agentId: 'story' }),
        makeAgentConfig({ agentId: 'memory_summary' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'save_1',
    });

    const run = await orch.run();
    expect(run.status).toBe('completed');
    expect(run.completedStages).toHaveLength(3);
  });

  it('Context 应在阶段间传递（单向流）', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '来自memory的输出' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '来自story的输出' } }],
          usage: { total_tokens: 20 },
        }),
        text: async () => '',
      });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['memory_recall'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall'] },
      ],
    };

    const context = makeContext({ userInput: '探索地下城' });
    const orch = new AgentOrchestrator({
      pipeline,
      context,
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall' }),
        makeAgentConfig({ agentId: 'story' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    await orch.run();

    // context.agentOutputs should contain memory_recall's output
    expect(context.agentOutputs!.has('memory_recall')).toBe(true);
    expect(context.agentOutputs!.get('memory_recall')).toBe('来自memory的输出');
    expect(context.agentOutputs!.get('story')).toBe('来自story的输出');
  });

  it('同阶段 Agent 应并行执行', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      });
    });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [{ agents: ['memory_recall', 'plot_check'], waitFor: [] }],
    };

    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall' }),
        makeAgentConfig({ agentId: 'plot_check' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const start = Date.now();
    await orch.run();
    const elapsed = Date.now() - start;

    // Parallel execution should finish in roughly one API call time
    // Both calls happen concurrently, so < 100ms is reasonable with mocked fetch
    expect(elapsed).toBeLessThan(500);
  });
});

// ========== Error Handling ==========

describe('AgentOrchestrator — 错误处理', () => {
  it('Agent 失败不应阻止同阶段其他 Agent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'plot_check OK' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: true,
      requiredAgents: ['story'],
      stages: [
        { agents: ['memory_recall', 'plot_check'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall', 'plot_check'] },
      ],
    };

    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall' }),
        makeAgentConfig({ agentId: 'plot_check' }),
        makeAgentConfig({ agentId: 'story' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();
    const results = orch.getResults();
    // memory_recall failed (HTTP 500 error)
    expect(results.get('memory_recall')!.error).toBeDefined();
    // plot_check succeeded — proves parallel execution with independent outcomes
    expect(results.get('plot_check')!.error).toBeUndefined();
    // story stage depends on memory_recall which failed
    // stageDependenciesMet returns false → story stage skipped → no result recorded
    expect(results.has('story')).toBe(false);
    expect(run.status).toBe('failed');
  });

  it('required Agent 返回 null 时整条管线应失败', async () => {
    globalThis.fetch = mockFetch('unused');
    const pipeline: Pipeline = {
      ...makeSimplePipeline(['story']),
      requiredAgents: ['story'],
    };
    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext({ plotSettings: { mode: 'off', tabooContent: '' } }),
      agentConfigs: [makeAgentConfig({ agentId: 'story', enabled: false })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();

    expect(orch.getResults().get('story')?.output).toBeNull();
    expect(run.status).toBe('failed');
  });

  it('required Agent 返回空白字符串时整条管线应失败', async () => {
    globalThis.fetch = mockFetch('   ');
    const pipeline: Pipeline = {
      ...makeSimplePipeline(['story']),
      requiredAgents: ['story'],
    };
    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story', retryOnFail: false })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();

    expect(run.agentResults.get('story')?.output).toBe('   ');
    expect(run.status).toBe('failed');
  });

  it('required Agent 报错时整条管线应失败', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'memory ok' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'story failed',
      });
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: true,
      requiredAgents: ['story'],
      stages: [
        { agents: ['memory_recall'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall'] },
      ],
    };
    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall', retryOnFail: false }),
        makeAgentConfig({ agentId: 'story', retryOnFail: false }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();

    expect(run.agentResults.get('story')?.error).toBeDefined();
    expect(run.status).toBe('failed');
  });

  it('required story 有效时，下游可选 Agent 失败仍应完成', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '<maintext>有效正文</maintext>' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'summary failed',
      });
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: true,
      requiredAgents: ['story'],
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['memory_summary'], waitFor: ['story'] },
      ],
    };
    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'story', retryOnFail: false }),
        makeAgentConfig({ agentId: 'memory_summary', retryOnFail: false }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();

    expect(run.agentResults.get('story')?.error).toBeUndefined();
    expect(run.agentResults.get('memory_summary')?.error).toBeDefined();
    expect(run.status).toBe('completed');
  });
});

// ========== regenerateAgent ==========

describe('AgentOrchestrator — 手动重生成', () => {
  it('应重生成指定 Agent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'first run' } }],
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'regenerated' } }],
          usage: { total_tokens: 15 },
        }),
        text: async () => '',
      });

    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    await orch.run();
    const firstResult = orch.getResults().get('story')!;
    expect(firstResult.output).toBe('first run');

    // Regenerate
    const regenResult = await orch.regenerateAgent('story');
    expect(regenResult.output).toBe('regenerated');
    expect(regenResult.error).toBeUndefined();
  });

  it('重生成未配置的 Agent 应返回错误', async () => {
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const result = await orch.regenerateAgent('nonexistent');
    expect(result.error).toContain('not configured');
  });
});

// ========== onlyAgents ==========

describe('AgentOrchestrator — onlyAgents 过滤', () => {
  it('只应执行指定的 Agent', async () => {
    globalThis.fetch = mockFetch('ok');
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['memory_recall', 'plot_check'], waitFor: [] },
        { agents: ['story'], waitFor: ['memory_recall', 'plot_check'] },
      ],
    };

    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'memory_recall' }),
        makeAgentConfig({ agentId: 'plot_check' }),
        makeAgentConfig({ agentId: 'story' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
      onlyAgents: ['memory_recall'],
    });

    await orch.run();
    const results = orch.getResults();
    expect(results.has('memory_recall')).toBe(true);
    expect(results.get('memory_recall')!.output).toBe('ok');
    // plot_check and story should not have results (not run)
    expect(results.get('plot_check')?.output).toBeFalsy();
    expect(results.get('story')?.output).toBeFalsy();
  });
});

// ========== 禁用 Agent ==========

describe('AgentOrchestrator — 禁用 Agent', () => {
  it('禁用的 Agent 应被跳过', async () => {
    globalThis.fetch = mockFetch('ok');
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story', enabled: false })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    await orch.run();
    const result = orch.getResults().get('story')!;
    expect(result.output).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.tokensUsed).toBe(0);
  });
});

// ========== 事件回调 ==========

describe('AgentOrchestrator — 事件回调', () => {
  it('应触发 onStageStart 和 onStageComplete', async () => {
    globalThis.fetch = mockFetch('ok');
    const stageStart = vi.fn();
    const stageComplete = vi.fn();
    const agentStart = vi.fn();
    const agentComplete = vi.fn();

    const orch = new AgentOrchestrator(
      {
        pipeline: makeSimplePipeline(['story']),
        context: makeContext(),
        agentConfigs: [makeAgentConfig({ agentId: 'story' })],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      {
        onStageStart: stageStart,
        onStageComplete: stageComplete,
        onAgentStart: agentStart,
        onAgentComplete: agentComplete,
      },
    );

    await orch.run();
    expect(stageStart).toHaveBeenCalledTimes(1);
    expect(agentStart).toHaveBeenCalledWith('story', expect.any(Object));
    expect(agentComplete).toHaveBeenCalledTimes(1);
    expect(stageComplete).toHaveBeenCalledTimes(1);
  });
});

// ========== Phase 6e: Marker Protocol 回调 ==========

describe('AgentOrchestrator — Phase 6e Marker 回调', () => {
  it('新 Agent ID (craft_gen, char_gen, item_gen, combat_summary) 应被 validatePipeline 接受', async () => {
    globalThis.fetch = mockFetch('ok');
    const orch = new AgentOrchestrator({
      pipeline: {
        timeout: 30000,
        retryOnFail: false,
        stages: [{ agents: ['craft_gen', 'char_gen', 'item_gen', 'combat_summary'], waitFor: [] }],
      },
      context: makeContext(),
      agentConfigs: [
        makeAgentConfig({ agentId: 'craft_gen' }),
        makeAgentConfig({ agentId: 'char_gen' }),
        makeAgentConfig({ agentId: 'item_gen' }),
        makeAgentConfig({ agentId: 'combat_summary' }),
      ],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();
    // Should complete, not fail with "unknown agent"
    expect(run.status).toBe('completed');
  });

  it('onCraftRequest 应在 vars_update stage 后触发 (延迟执行)', async () => {
    const storyContent = '正文开头<craft_request industry="锻造">制作长剑</craft_request>正文结尾';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: storyContent } }],
          usage: { total_tokens: 100 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: { total_tokens: 20 },
        }),
        text: async () => '',
      });

    const onCraftRequest = vi.fn().mockResolvedValue('【制作成功：长剑已锻造完成】');

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };

    const orch = new AgentOrchestrator(
      {
        pipeline,
        context: makeContext(),
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCraftRequest },
    );

    await orch.run();

    expect(onCraftRequest).toHaveBeenCalledTimes(1);
    const callArgs = onCraftRequest.mock.calls[0];
    expect(callArgs[0].type).toBe('craft_request');
    expect(callArgs[0].industry).toBe('锻造');
  });

  it('onCraftRequest 返回结果应注入 story output (延迟到 Stage 2)', async () => {
    const storyContent = '前言<craft_request>制作</craft_request>后语';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: storyContent } }],
          usage: { total_tokens: 50 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: { total_tokens: 20 },
        }),
        text: async () => '',
      });

    const craftResult = '【制作结果叙事】';
    const onCraftRequest = vi.fn().mockResolvedValue(craftResult);

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };

    const context = makeContext();
    const orch = new AgentOrchestrator(
      {
        pipeline,
        context,
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCraftRequest },
    );

    await orch.run();

    // story output should have the marker replaced with craft result
    const modifiedOutput = context.agentOutputs!.get('story');
    expect(modifiedOutput).toBe('前言' + craftResult + '后语');
  });

  it('onCraftRequest 返回 null 应跳过注入 (延迟到 Stage 2)', async () => {
    const storyContent = '前言<craft_request>制作</craft_request>后语';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: storyContent } }],
          usage: { total_tokens: 50 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: { total_tokens: 20 },
        }),
        text: async () => '',
      });

    const onCraftRequest = vi.fn().mockResolvedValue(null);

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };

    const context = makeContext();
    const orch = new AgentOrchestrator(
      {
        pipeline,
        context,
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCraftRequest },
    );

    await orch.run();

    // story output should remain unchanged
    expect(context.agentOutputs!.get('story')).toBe(storyContent);
  });

  it('onCombatTrigger 应在 request_dispatcher 输出 combat_trigger 时触发', async () => {
    // M5.1: combat_trigger 改由 request_dispatcher 输出（story 只叙事，停在开战前）
    const storyContent = '英雄与魔王对峙，剑拔弩张，战斗一触即发。';
    const dispatcherContent = '<combat_trigger combatType="死斗">英雄 vs 魔王</combat_trigger>';
    globalThis.fetch = vi
      .fn()
      // Stage 1: story（纯叙事）
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: storyContent } }],
          usage: { total_tokens: 80 },
        }),
        text: async () => '',
      })
      // Stage 2: request_dispatcher（输出 combat_trigger）
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: dispatcherContent } }],
          usage: { total_tokens: 30 },
        }),
        text: async () => '',
      });

    const onCombatTrigger = vi.fn().mockResolvedValue(null);

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };

    const orch = new AgentOrchestrator(
      {
        pipeline,
        context: makeContext(),
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCombatTrigger },
    );

    await orch.run();

    // Combat should fire AFTER vars_update (Stage 2), not after story (Stage 1)
    expect(onCombatTrigger).toHaveBeenCalledTimes(1);
    expect(onCombatTrigger.mock.calls[0][0].type).toBe('combat_trigger');
    expect(onCombatTrigger.mock.calls[0][0].combatType).toBe('死斗');
  });

  it('无回调时不应报错 (向后兼容)', async () => {
    const storyContent =
      '正文<craft_request>制作</craft_request><combat_trigger>战斗</combat_trigger><char_detect>角色</char_detect>结束';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: storyContent } }],
        usage: { total_tokens: 60 },
      }),
      text: async () => '',
    });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [{ agents: ['story'], waitFor: [] }],
    };

    // No callbacks at all
    const orch = new AgentOrchestrator({
      pipeline,
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'test',
    });

    const run = await orch.run();
    expect(run.status).toBe('completed');
  });

  it('标记不应在非 story/vars_update stage 上触发回调', async () => {
    const content = '<craft_request>制作</craft_request>';
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 20 } }),
      text: async () => '',
    });

    const onCraftRequest = vi.fn().mockResolvedValue(null);

    // memory_recall is NOT the story stage
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [{ agents: ['memory_recall'], waitFor: [] }],
    };

    const orch = new AgentOrchestrator(
      {
        pipeline,
        context: makeContext(),
        agentConfigs: [makeAgentConfig({ agentId: 'memory_recall' })],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCraftRequest },
    );

    await orch.run();

    // onCraftRequest should NOT be called because memory_recall is not the story stage
    // (even if the output contains craft markers, we only process after the story stage)
    expect(onCraftRequest).not.toHaveBeenCalled();
  });

  // M3: char_detect 死路径已删除 — 角色检测统一走 request_dispatcher 的 char_gen_request
  it('多个 craft_request 应依次处理 (延迟到 Stage 2)', async () => {
    const storyContent =
      '<craft_request>第一件</craft_request>和<craft_request>第二件</craft_request>';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: storyContent } }],
          usage: { total_tokens: 50 },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: { total_tokens: 20 },
        }),
        text: async () => '',
      });

    const craftResults = ['【结果1】', '【结果2】'];
    let callCount = 0;
    const onCraftRequest = vi.fn().mockImplementation(() => {
      return Promise.resolve(craftResults[callCount++]);
    });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
        { agents: ['request_dispatcher'], waitFor: ['story'] },
      ],
    };

    const context = makeContext();
    const orch = new AgentOrchestrator(
      {
        pipeline,
        context,
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'request_dispatcher' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'test',
      },
      { onCraftRequest },
    );

    await orch.run();

    expect(onCraftRequest).toHaveBeenCalledTimes(2);
    // Both markers should be replaced
    const modifiedOutput = context.agentOutputs!.get('story');
    expect(modifiedOutput).toBe('【结果1】和【结果2】');
  });
});

// ========== OrchestratorRun 结构 ==========

describe('AgentOrchestrator — OrchestratorRun', () => {
  it('返回的 run 应有完整字段', async () => {
    globalThis.fetch = mockFetch('output text', 100, true);
    const orch = new AgentOrchestrator({
      pipeline: makeSimplePipeline(['story']),
      context: makeContext({ userInput: '探索' }),
      agentConfigs: [makeAgentConfig({ agentId: 'story' })],
      endpoints: [makeEndpoint()],
      saveId: 'my_save',
    });

    const run = await orch.run();
    expect(run.id).toBeTruthy();
    expect(run.status).toBe('completed');
    expect(run.completedStages).toHaveLength(1);
    expect(run.currentStage).toBe('stage_0');
    expect(run.startedAt).toBeGreaterThan(0);
    expect(run.pipeline.stages).toHaveLength(1);
    // AgentResults should be in the run
    expect(run.agentResults.has('story')).toBe(true);
  });
});

// ========== Stage 3 vars_update <json> characters.add 解析 ==========

function varsJsonOutput(json: object): string {
  return `<json>\n${JSON.stringify(json)}\n</json>`;
}

/** 跑一个单 stage vars_update 管线，返回 commitChatState 收到的全部 patches */
async function runVarsUpdateWithJson(
  json: object,
  events: Record<string, any> = {},
): Promise<any[]> {
  globalThis.fetch = mockFetch(varsJsonOutput(json));
  const orch = new AgentOrchestrator(
    {
      pipeline: makeSimplePipeline(['vars_update']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'vars_update' })],
      endpoints: [makeEndpoint()],
      saveId: 'save_1',
    },
    events,
  );
  await orch.run();
  return commitChatStateMock.mock.calls.flatMap((c) => c[0]);
}

describe('AgentOrchestrator — Stage3 characters.add 解析', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
  });

  it('path=inventory → add_item（M3: 无 id 生成，含 equippedSlot）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [
          {
            name: 'c1',
            path: 'inventory',
            value: { name: '金色钥匙挂坠', description: '表面有刻文', quantity: 1 },
          },
        ],
        remove: [],
      },
      items: {},
    });
    const p = patches.find((x) => x.op === 'add_item');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    // M3: 不再生成 id（无 varsupd_inv_ 前缀）
    expect('id' in (p.value as Record<string, unknown>)).toBe(false);
    expect(p.value.name).toBe('金色钥匙挂坠');
    expect(p.value.description).toBe('表面有刻文');
    expect(p.value.quantity).toBe(1);
    expect(p.value.equippedSlot).toBeNull();
    // 防回归: 不能再出现携带 inventory 键的 update_character（会被 Object.assign 整体替换数组）
    expect(patches.some((x) => x.op === 'update_character' && x.value?.inventory)).toBe(false);
  });

  it('path=equipment 无 itemId → 单 add_item + equippedSlot（M3: 不再 add+equip 两步）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [
          {
            name: 'c1',
            path: 'equipment',
            value: { name: '法师长袍', type: '防具', slot: '身体' },
          },
        ],
        remove: [],
      },
      items: {},
    });
    const addP = patches.find((x) => x.op === 'add_item');
    expect(addP).toBeDefined();
    // M3: 不再生成 id
    expect('id' in (addP.value as Record<string, unknown>)).toBe(false);
    // M3: 单 add_item，type 强制为 '装备'，equippedSlot 直传
    expect(addP.value.name).toBe('法师长袍');
    expect(addP.value.type).toBe('装备');
    expect(addP.value.quantity).toBe(1);
    expect(addP.value.equippedSlot).toBe('身体');
    // M3: 不再产生 equip_item patch（单 add_item 一步到位）
    expect(patches.filter((x) => x.op === 'equip_item')).toHaveLength(0);
  });

  it('path=equipment 夹带 itemId → 忽略 itemId 按 name 落库（M4: itemId 过渡读已拆）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [
          {
            name: 'c1',
            path: 'equipment',
            value: { itemId: 'item_9', slot: '武器', name: '白橡木法杖' },
          },
        ],
        remove: [],
      },
      items: {},
    });
    // M3: 装备统一走 add_item（含 equippedSlot），不再走 equip_item
    expect(patches.filter((x) => x.op === 'add_item')).toHaveLength(1);
    expect(patches.filter((x) => x.op === 'equip_item')).toHaveLength(0);
    const addP = patches[0];
    expect('id' in (addP.value as Record<string, unknown>)).toBe(false);
    expect(addP.value.name).toBe('白橡木法杖');
    expect(addP.value.type).toBe('装备');
    expect(addP.value.equippedSlot).toBe('武器');
  });

  it('path=equipment slot 未知 → 只 add_item 不发 equip_item（物品留背包）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [{ name: 'c1', path: 'equipment', value: { name: '神秘披风' } }],
        remove: [],
      },
      items: {},
    });
    // M2: slot 未知不再发 '未知' 垃圾值（normalizeSlot 会拒 → throw），跳过 equip
    expect(patches.filter((x) => x.op === 'add_item')).toHaveLength(1);
    expect(patches.filter((x) => x.op === 'equip_item')).toHaveLength(0);
  });

  // M2 T14 评审修复: type='防具'（非 slot 名）→ normalizeSlot 拒，不发 equip_item // M3 重写
  it('path=equipment type=防具 非槽位 → 不发 equip_item（防具在背包,不 throw）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [{ name: 'c1', path: 'equipment', value: { name: '铁甲', type: '防具' } }],
        remove: [],
      },
      items: {},
    });
    expect(patches.filter((x) => x.op === 'add_item')).toHaveLength(1);
    expect(patches.filter((x) => x.op === 'equip_item')).toHaveLength(0);
  });

  it('path=skills / statusEffects 原有分支不受影响', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [
          { name: 'c1', path: 'skills', value: { name: '火球术' } },
          { name: 'c1', path: 'statusEffects', value: { name: '灼烧' } },
        ],
        remove: [],
      },
      items: {},
    });
    expect(patches.some((x) => x.op === 'add_skill')).toBe(true);
    expect(patches.some((x) => x.op === 'add_status_effect')).toBe(true);
  });

  it('characters.remove path=skills → remove_skill {name}（M2: removeSkill 假字段已废）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [],
        delta: [],
        add: [],
        remove: [{ name: 'c1', path: 'skills', target: '火球术' }],
      },
      items: {},
    });
    const p = patches.find((x) => x.op === 'remove_skill');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    expect(p.value).toEqual({ name: '火球术' });
    // 防回归: 不能再出现 removeSkill 假字段的 update_character（白名单会 throw）
    expect(patches.some((x) => x.op === 'update_character' && x.value?.removeSkill)).toBe(false);
  });

  it('M4 名字寻址唯一化: 条目只有 id 无 name → 全部跳过不产 patch', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [{ id: 'uuid-1', path: 'hp', value: 10 }],
        delta: [{ id: 'uuid-1', path: 'hp', amount: -5 }],
        add: [{ id: 'uuid-1', path: 'skills', value: { name: '火球术' } }],
        remove: [{ id: 'uuid-1', path: 'skills', target: '火球术' }],
      },
      items: {},
    });
    expect(patches).toHaveLength(0);
  });

  it('items.modify → update_item {name, changes}（M2: itemUpdate 假字段已废，禁改键剥离）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [], remove: [] },
      items: {
        modify: [
          {
            owner: 'c1',
            target: '铁剑',
            changes: { description: '缺了口', name: '不许改名', quantity: 99 },
          },
        ],
      },
    });
    const p = patches.find((x) => x.op === 'update_item');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    expect(p.value.name).toBe('铁剑');
    expect(p.value.changes).toEqual({ description: '缺了口' }); // name/quantity 禁改键已剥离
    expect(patches.some((x) => x.op === 'update_character' && x.value?.itemUpdate)).toBe(false);
  });

  it('items.equip / items.unequip → 按名对象形态', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [], remove: [] },
      items: {
        equip: [{ owner: 'c1', target: '白橡木法杖', slot: '武器' }],
        unequip: [{ owner: 'c1', target: '旧皮甲' }],
      },
    });
    const eq = patches.find((x) => x.op === 'equip_item');
    const uneq = patches.find((x) => x.op === 'unequip_item');
    expect(eq.value).toEqual({ name: '白橡木法杖', slot: '武器' });
    expect(uneq.value).toEqual({ name: '旧皮甲' });
  });
});

// ========== Stage 3 vars_update <json> affections 解析 (M5 #15 #44) ==========

describe('AgentOrchestrator — Stage3 affections 解析', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
  });

  it('affections.set → set_affection patch（target=affections.角色名, value 直传）', async () => {
    const patches = await runVarsUpdateWithJson({
      affections: { set: [{ name: '雷娜', value: 50 }], delta: [] },
    });
    const p = patches.find((x) => x.op === 'set_affection');
    expect(p).toBeDefined();
    expect(p.target).toBe('affections.雷娜');
    expect(p.value).toBe(50);
    expect(p.metadata?.source).toBe('vars_update');
  });

  it('affections.delta → delta_affection patch（amount 直传）', async () => {
    const patches = await runVarsUpdateWithJson({
      affections: { set: [], delta: [{ name: '汉斯', amount: 5 }] },
    });
    const p = patches.find((x) => x.op === 'delta_affection');
    expect(p).toBeDefined();
    expect(p.target).toBe('affections.汉斯');
    expect(p.amount).toBe(5);
    expect(p.metadata?.source).toBe('vars_update');
  });

  it('affections 条目缺 name → 跳过不产 patch（M4 名字寻址纪律对齐）', async () => {
    const patches = await runVarsUpdateWithJson({
      affections: { set: [{ value: 30 }], delta: [{ amount: -10 }] },
    });
    expect(
      patches.filter((x) => x.op === 'set_affection' || x.op === 'delta_affection'),
    ).toHaveLength(0);
  });

  it('affections 与 characters/items 同批提交（同一 patches batch）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [{ name: 'c1', path: 'hp', value: 42 }],
        delta: [],
        add: [],
        remove: [],
      },
      affections: { set: [{ name: '雷娜', value: 20 }], delta: [] },
    });
    expect(patches.some((x) => x.op === 'set_hp')).toBe(true);
    expect(patches.some((x) => x.op === 'set_affection')).toBe(true);
  });
});

// ========== Stage 2 request_dispatcher <json> 世界新闻 → add_news (M5 #16) ==========

/** 跑一个单 stage request_dispatcher 管线，返回 commitChatState 收到的全部 patches */
async function runDispatcherWithJson(
  json: object,
  events: Record<string, any> = {},
): Promise<any[]> {
  globalThis.fetch = mockFetch(varsJsonOutput(json));
  const orch = new AgentOrchestrator(
    {
      pipeline: makeSimplePipeline(['request_dispatcher']),
      context: makeContext(),
      agentConfigs: [makeAgentConfig({ agentId: 'request_dispatcher' })],
      endpoints: [makeEndpoint()],
      saveId: 'save_1',
    },
    events,
  );
  await orch.run();
  return commitChatStateMock.mock.calls.flatMap((c) => c[0]);
}

describe('AgentOrchestrator — Stage2 世界新闻 → add_news', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
  });

  it('replace path=世界新闻(字符串值) → add_news patch，不再产 set_variable 世界新闻', async () => {
    const patches = await runDispatcherWithJson({
      delta_time: 30,
      replace: [
        { path: '天气', value: '小雨' },
        { path: '世界新闻', value: '帝国边境爆发兽潮，北境商路中断。' },
      ],
    });
    const news = patches.find((x) => x.op === 'add_news');
    expect(news).toBeDefined();
    expect(news.value.content).toBe('帝国边境爆发兽潮，北境商路中断。');
    expect(typeof news.value.title).toBe('string');
    expect(news.value.title.length).toBeGreaterThan(0);
    expect(news.metadata?.source).toBe('request_dispatcher');
    // 世界新闻不再走 set_variable 双轨（#16 退役）
    expect(
      patches.some((x) => x.op === 'set_variable' && String(x.target).includes('世界新闻')),
    ).toBe(false);
    // 其他全局变量（天气）不受影响
    const weather = patches.find((x) => x.op === 'set_variable');
    expect(weather).toBeDefined();
    expect(weather.target).toBe('variables.天气');
  });

  it('insert path=世界新闻(对象值) → add_news 直用 title/content/category，不产 insert_variable', async () => {
    const patches = await runDispatcherWithJson({
      delta_time: 10,
      insert: [
        {
          path: '世界新闻',
          value: { title: '兽潮警报', content: '北境商路因兽潮中断', category: '军事' },
        },
      ],
    });
    const news = patches.find((x) => x.op === 'add_news');
    expect(news).toBeDefined();
    expect(news.value).toEqual({
      title: '兽潮警报',
      content: '北境商路因兽潮中断',
      category: '军事',
    });
    expect(patches.some((x) => x.op === 'insert_variable')).toBe(false);
  });

  it('世界新闻值为数组 → 逐条产 add_news', async () => {
    const patches = await runDispatcherWithJson({
      delta_time: 5,
      replace: [
        {
          path: '世界新闻',
          value: ['帝都举行丰收祭。', { title: '王室公告', content: '王储将巡视北境' }],
        },
      ],
    });
    const newsPatches = patches.filter((x) => x.op === 'add_news');
    expect(newsPatches).toHaveLength(2);
    expect(newsPatches[0].value.content).toBe('帝都举行丰收祭。');
    expect(newsPatches[1].value).toEqual({ title: '王室公告', content: '王储将巡视北境' });
    expect(patches.some((x) => x.op === 'set_variable')).toBe(false);
  });

  it('世界新闻值为空串/null → 跳过不产 patch 也不落变量', async () => {
    const patches = await runDispatcherWithJson({
      delta_time: 5,
      replace: [{ path: '世界新闻', value: '' }],
      insert: [{ path: '世界新闻', value: null }],
    });
    expect(patches.filter((x) => x.op === 'add_news')).toHaveLength(0);
    expect(patches.some((x) => String(x.target ?? '').includes('世界新闻'))).toBe(false);
  });

  it('世界新闻 {date, event} 形状（真机实测 2026-07-17）→ event 作 content + date 拼前缀', async () => {
    const patches = await runDispatcherWithJson({
      delta_time: 5,
      insert: [
        {
          path: '世界新闻',
          value: {
            date: '复兴纪元001年01月02日',
            event: '一座古老召唤阵被激活，六人被召唤至此。幸存者苏醒于废弃古堡。',
          },
        },
      ],
    });
    const news = patches.find((x) => x.op === 'add_news');
    expect(news).toBeDefined();
    expect(news.value.content).toBe(
      '【复兴纪元001年01月02日】一座古老召唤阵被激活，六人被召唤至此。幸存者苏醒于废弃古堡。',
    );
    // 标题从剥掉日期前缀的首句截断
    expect(news.value.title).toBe('一座古老召唤阵被激活，六人被召唤至此');
  });
});

// ========== onStateCommitError 上浮 ==========

describe('AgentOrchestrator — onStateCommitError 上浮', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
  });

  it('commit errors 非空时应触发回调（source=vars_update）', async () => {
    commitChatStateMock.mockImplementation(async () => ({
      success: false,
      patchesApplied: 0,
      eventsGenerated: [],
      errors: ['角色不存在: x'],
    }));
    const onStateCommitError = vi.fn();
    await runVarsUpdateWithJson(
      {
        characters: {
          replace: [{ name: 'x', path: 'hp', value: 10 }],
          delta: [],
          add: [],
          remove: [],
        },
        items: {},
      },
      { onStateCommitError },
    );
    expect(onStateCommitError).toHaveBeenCalled();
    expect(onStateCommitError.mock.calls[0][0]).toBe('vars_update');
    expect(onStateCommitError.mock.calls[0][1]).toContain('角色不存在: x');
  });

  it('errors 为空时不触发回调', async () => {
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
    const onStateCommitError = vi.fn();
    await runVarsUpdateWithJson(
      {
        characters: {
          replace: [{ name: 'x', path: 'hp', value: 10 }],
          delta: [],
          add: [],
          remove: [],
        },
        items: {},
      },
      { onStateCommitError },
    );
    expect(onStateCommitError).not.toHaveBeenCalled();
  });
});

// ========== 工坊 P2 (ADR-30 D5): onEjsVarsFlush 时序 ==========

describe('AgentOrchestrator — onEjsVarsFlush (工坊 P2 / D5)', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
  });

  it('每个 stage 跑完各调一次，参数是该 stage 的 agentId 列表', async () => {
    globalThis.fetch = mockFetch('正文');
    const seen: string[][] = [];
    const orch = new AgentOrchestrator(
      {
        pipeline: {
          timeout: 30000,
          retryOnFail: false,
          stages: [
            { agents: ['story'], waitFor: [] },
            { agents: ['memory_summary'], waitFor: [] },
          ],
        },
        context: makeContext(),
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'memory_summary' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'save_ejs',
      },
      { onEjsVarsFlush: (ids) => void seen.push([...ids]) },
    );
    await orch.run();
    expect(seen).toEqual([['story'], ['memory_summary']]);
  });

  it('🔒 顺序契约: story stage 的 flush 早于 vars_update 的 AI 补丁提交', async () => {
    globalThis.fetch = mockFetch(
      varsJsonOutput({
        characters: {
          replace: [{ name: 'c1', path: 'location', value: '熔火裂谷' }],
          delta: [],
          add: [],
          remove: [],
        },
        items: {},
      }),
    );
    const order: string[] = [];
    commitChatStateMock.mockImplementation(async (patches: any[]) => {
      order.push('commit');
      return { success: true, patchesApplied: patches.length, eventsGenerated: [], errors: [] };
    });

    const orch = new AgentOrchestrator(
      {
        pipeline: {
          timeout: 30000,
          retryOnFail: false,
          stages: [
            { agents: ['story'], waitFor: [] },
            { agents: ['vars_update'], waitFor: [] },
          ],
        },
        context: makeContext(),
        agentConfigs: [
          makeAgentConfig({ agentId: 'story' }),
          makeAgentConfig({ agentId: 'vars_update' }),
        ],
        endpoints: [makeEndpoint()],
        saveId: 'save_ejs2',
      },
      {
        onEjsVarsFlush: async (ids) => {
          if (ids.includes('story')) order.push('flush:story');
        },
      },
    );
    await orch.run();

    expect(order[0]).toBe('flush:story');
    expect(order).toContain('commit');
  });

  it('flush 抛错不让 stage 失败（簿记旁路不吞正文）', async () => {
    globalThis.fetch = mockFetch('正文');
    const orch = new AgentOrchestrator(
      {
        pipeline: makeSimplePipeline(['story']),
        context: makeContext(),
        agentConfigs: [makeAgentConfig({ agentId: 'story' })],
        endpoints: [makeEndpoint()],
        saveId: 'save_ejs3',
      },
      {
        onEjsVarsFlush: async () => {
          throw new Error('落库炸了');
        },
      },
    );
    const run = await orch.run();
    expect(run.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════
// Q-14: 三类失败各有各的回执，不许混成一条
// ═══════════════════════════════════════════════════════════

describe('AgentOrchestrator — 失败回执分家（Q-14）', () => {
  let warns: string[];
  let errors: string[];

  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true,
      patchesApplied: patches.length,
      eventsGenerated: [],
      errors: [],
    }));
    warns = [];
    errors = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => void warns.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: any[]) => void errors.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 跑一个单 stage vars_update，正文由调用方给（可以是坏 JSON） */
  async function runVarsRaw(output: string, onStateCommitError?: any): Promise<void> {
    globalThis.fetch = mockFetch(output);
    const orch = new AgentOrchestrator(
      {
        pipeline: makeSimplePipeline(['vars_update']),
        context: makeContext(),
        agentConfigs: [makeAgentConfig({ agentId: 'vars_update' })],
        endpoints: [makeEndpoint()],
        saveId: 'save_q14',
      },
      onStateCommitError ? { onStateCommitError } : {},
    );
    await orch.run();
  }

  it('JSON 解析失败 → 说「解析失败」，不上浮给 UI', async () => {
    const seen: string[] = [];
    await runVarsRaw('<json>{ 这不是 JSON </json>', (src: string) => seen.push(src));

    expect(warns.some((w) => w.includes('vars_update <json> 解析失败'))).toBe(true);
    expect(seen).toEqual([]);
    expect(commitChatStateMock).not.toHaveBeenCalled();
  });

  it('JSON 合法但结构不对 → 说「结构不符」，与解析失败分开，也不上浮', async () => {
    const seen: string[] = [];
    // characters.replace 给成对象：JSON 本身合法，但对象不可迭代，for..of 当场抛。
    // （给字符串不行 —— 字符串是可迭代的，会被逐字符走一遍，只落进「缺 name 跳过」）
    await runVarsRaw('<json>{"characters":{"replace":{"理查德":88}}}</json>', (src: string) =>
      seen.push(src),
    );

    expect(warns.some((w) => w.includes('vars_update <json> 结构不符'))).toBe(true);
    expect(warns.some((w) => w.includes('解析失败'))).toBe(false);
    expect(seen).toEqual([]);
    expect(commitChatStateMock).not.toHaveBeenCalled();
  });

  it('落库抛异常 → 说「状态提交抛异常」并上浮 onStateCommitError（旧实现印成「解析失败」且不上浮）', async () => {
    commitChatStateMock.mockImplementation(async () => {
      throw new Error('Dexie 写失败');
    });
    const seen: Array<[string, string[]]> = [];
    await runVarsRaw(
      '<json>{"characters":{"replace":[{"name":"理查德","path":"hp","value":88}]}}</json>',
      (src: string, errs: string[]) => seen.push([src, errs]),
    );

    expect(errors.some((e) => e.includes('vars_update 状态提交抛异常'))).toBe(true);
    // 这条是关键：落库炸了不许被说成 AI 输出格式问题
    expect(warns.some((w) => w.includes('解析失败'))).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('vars_update');
    expect(seen[0][1][0]).toContain('Dexie 写失败');
  });

  it('quests 分支复用同一个 parsed —— 同一段 <json> 不再 parse 两遍', async () => {
    await runVarsRaw(
      '<json>{"characters":{"replace":[{"name":"理查德","path":"hp","value":88}]},' +
        '"quests":{"upsert":[{"name":"寻剑"}]}}</json>',
    );

    const sources = commitChatStateMock.mock.calls.map((c: any) => c[0][0]?.metadata?.source);
    expect(sources).toContain('vars_update');
    const ops = commitChatStateMock.mock.calls.flatMap((c: any) => c[0]).map((p: any) => p.op);
    expect(ops).toContain('set_hp');
    expect(ops).toContain('update_quest');
    // 两批各自提交，互不连累
    expect(commitChatStateMock.mock.calls.length).toBe(2);
  });
});
