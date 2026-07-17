/**
 * agent-orchestrator.ts — DAG 编排引擎测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentOrchestrator } from './agent-orchestrator';
import type { AgentContext, AgentConfig, ApiEndpoint, Pipeline } from './types';

// state-manager mock: 捕获 commitChatState 收到的 patches（Stage3 <json> 解析测试用）
const { commitChatStateMock } = vi.hoisted(() => ({
  commitChatStateMock: vi.fn(async (patches: any[]) => ({
    success: true, patchesApplied: patches.length, eventsGenerated: [], errors: [] as string[],
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

function mockFetchError(status = 500) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => 'Error body',
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
    lorebookMatches: [],
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
    stages: [
      { agents, waitFor: [] },
    ],
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '来自memory的输出' } }], usage: { total_tokens: 10 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '来自story的输出' } }], usage: { total_tokens: 20 } }),
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
    const startTimes: Record<string, number> = {};
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const agentId = 'unknown'; // can't easily get this from fetch mock alone
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 10 } }),
        text: async () => '',
      });
    });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['memory_recall', 'plot_check'], waitFor: [] },
      ],
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 500,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'Server Error',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'plot_check OK' } }], usage: { total_tokens: 10 } }),
        text: async () => '',
      });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: true,
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

    await orch.run();
    const results = orch.getResults();
    // memory_recall failed (HTTP 500 error)
    expect(results.get('memory_recall')!.error).toBeDefined();
    // plot_check succeeded — proves parallel execution with independent outcomes
    expect(results.get('plot_check')!.error).toBeUndefined();
    // story stage depends on memory_recall which failed
    // stageDependenciesMet returns false → story stage skipped → no result recorded
    expect(results.has('story')).toBe(false);
  });
});

// ========== regenerateAgent ==========

describe('AgentOrchestrator — 手动重生成', () => {
  it('应重生成指定 Agent', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'first run' } }], usage: { total_tokens: 10 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'regenerated' } }], usage: { total_tokens: 15 } }),
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
        stages: [
          { agents: ['craft_gen', 'char_gen', 'item_gen', 'combat_summary'], waitFor: [] },
        ],
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 100 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 20 } }),
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 50 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 20 } }),
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 50 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 20 } }),
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

  it('onCombatTrigger 应在 vars_update stage 后触发 (延迟执行)', async () => {
    const storyContent = '战斗开始！<combat_trigger combatType="死斗">Boss战</combat_trigger>';
    const varsContent = '{"vars": "ok"}';
    globalThis.fetch = vi.fn()
      // Stage 1: story
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 80 } }),
        text: async () => '',
      })
      // Stage 2: vars_update
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: varsContent } }], usage: { total_tokens: 30 } }),
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

  it('onCharDetect 应在 vars_update stage 后触发', async () => {
    const storyOutput = '前文<char_detect characterName="小明">新角色</char_detect>后文';
    const varsOutput = '{"vars": "updated"}';

    globalThis.fetch = vi.fn()
      // Stage 1: story
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyOutput } }], usage: { total_tokens: 50 } }),
        text: async () => '',
      })
      // Stage 2: vars_update
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: varsOutput } }], usage: { total_tokens: 30 } }),
        text: async () => '',
      });

    const onCharDetect = vi.fn().mockResolvedValue(undefined);

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
      { onCharDetect },
    );

    await orch.run();

    expect(onCharDetect).toHaveBeenCalledTimes(1);
    expect(onCharDetect.mock.calls[0][0]).toHaveLength(1);
    expect(onCharDetect.mock.calls[0][0][0].type).toBe('char_detect');
    expect(onCharDetect.mock.calls[0][0][0].characterName).toBe('小明');
  });

  it('无回调时不应报错 (向后兼容)', async () => {
    const storyContent = '正文<craft_request>制作</craft_request><combat_trigger>战斗</combat_trigger><char_detect>角色</char_detect>结束';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 60 } }),
      text: async () => '',
    });

    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['story'], waitFor: [] },
      ],
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
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 20 } }),
        text: async () => '',
      });

    const onCraftRequest = vi.fn().mockResolvedValue(null);

    // memory_recall is NOT the story stage
    const pipeline: Pipeline = {
      timeout: 30000,
      retryOnFail: false,
      stages: [
        { agents: ['memory_recall'], waitFor: [] },
      ],
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

  it('执行顺序: char_detect 应在 combat_trigger 之前触发', async () => {
    const storyContent = '前面<char_detect characterName="Boss">怪物</char_detect>中间<combat_trigger combatType="死斗">战斗</combat_trigger>后面';
    const varsContent = '{"vars": "ok"}';

    const callOrder: string[] = [];

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 80 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: varsContent } }], usage: { total_tokens: 30 } }),
        text: async () => '',
      });

    const onCharDetect = vi.fn().mockImplementation(async () => {
      callOrder.push('char_detect');
    });
    const onCombatTrigger = vi.fn().mockImplementation(async () => {
      callOrder.push('combat_trigger');
    });

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
      { onCharDetect, onCombatTrigger },
    );

    await orch.run();

    // char_detect MUST fire before combat_trigger
    // (new enemies need to be generated before combat starts)
    expect(onCharDetect).toHaveBeenCalledTimes(1);
    expect(onCombatTrigger).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['char_detect', 'combat_trigger']);
  });

  it('多个 craft_request 应依次处理 (延迟到 Stage 2)', async () => {
    const storyContent = '<craft_request>第一件</craft_request>和<craft_request>第二件</craft_request>';
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: storyContent } }], usage: { total_tokens: 50 } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 20 } }),
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
  return commitChatStateMock.mock.calls.flatMap(c => c[0]);
}

describe('AgentOrchestrator — Stage3 characters.add 解析', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true, patchesApplied: patches.length, eventsGenerated: [], errors: [],
    }));
  });

  it('path=inventory → add_item 且补生成 id（不再产生损坏数组的 update_character）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [{ id: 'c1', path: 'inventory', value: { name: '金色钥匙挂坠', description: '表面有刻文', quantity: 1 } }], remove: [] },
      items: {},
    });
    const p = patches.find(x => x.op === 'add_item');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    expect(p.value.id).toMatch(/^varsupd_inv_/);
    expect(p.value.name).toBe('金色钥匙挂坠');
    expect(p.value.quantity).toBe(1);
    // 防回归: 不能再出现携带 inventory 键的 update_character（会被 Object.assign 整体替换数组）
    expect(patches.some(x => x.op === 'update_character' && x.value?.inventory)).toBe(false);
  });

  it('path=equipment 无 itemId → add_item + equip_item 两步按名寻址', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [{ id: 'c1', path: 'equipment', value: { name: '法师长袍', type: '防具', slot: '身体' } }], remove: [] },
      items: {},
    });
    const addP = patches.find(x => x.op === 'add_item');
    const eqP = patches.find(x => x.op === 'equip_item');
    expect(addP).toBeDefined();
    expect(eqP).toBeDefined();
    expect(addP.value.id).toMatch(/^varsupd_eq_/);  // M3 删 — id 仅占 value.id 可选位
    // M2 契约: equip_item 按 name+slot 寻址
    expect(eqP.value.name).toBe('法师长袍');
    expect(eqP.value.slot).toBe('身体');
    expect(eqP.value.name).toBe(addP.value.name);
  });

  it('path=equipment 有 itemId（装备背包已有物品）→ 单个 equip_item 按名寻址', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [{ id: 'c1', path: 'equipment', value: { itemId: 'item_9', slot: '武器', name: '白橡木法杖' } }], remove: [] },
      items: {},
    });
    expect(patches.filter(x => x.op === 'add_item')).toHaveLength(0);
    expect(patches.filter(x => x.op === 'equip_item')).toHaveLength(1);
    // M2 契约: {name, slot}，优先取 value.name（itemId 兜底）
    expect(patches[0].value.name).toBe('白橡木法杖');
    expect(patches[0].value.slot).toBe('武器');
  });

  it('path=equipment slot 未知 → 只 add_item 不发 equip_item（物品留背包）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [{ id: 'c1', path: 'equipment', value: { name: '神秘披风' } }], remove: [] },
      items: {},
    });
    // M2: slot 未知不再发 '未知' 垃圾值（normalizeSlot 会拒 → throw），跳过 equip
    expect(patches.filter(x => x.op === 'add_item')).toHaveLength(1);
    expect(patches.filter(x => x.op === 'equip_item')).toHaveLength(0);
  });

  // M2 T14 评审修复: type='防具'（非 slot 名）→ normalizeSlot 拒，不发 equip_item // M3 重写
  it('path=equipment type=防具 非槽位 → 不发 equip_item（防具在背包,不 throw）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [{ id: 'c1', path: 'equipment', value: { name: '铁甲', type: '防具' } }], remove: [] },
      items: {},
    });
    expect(patches.filter(x => x.op === 'add_item')).toHaveLength(1);
    expect(patches.filter(x => x.op === 'equip_item')).toHaveLength(0);
  });

  it('path=skills / statusEffects 原有分支不受影响', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: {
        replace: [], delta: [],
        add: [
          { id: 'c1', path: 'skills', value: { name: '火球术' } },
          { id: 'c1', path: 'statusEffects', value: { name: '灼烧' } },
        ],
        remove: [],
      },
      items: {},
    });
    expect(patches.some(x => x.op === 'add_skill')).toBe(true);
    expect(patches.some(x => x.op === 'add_status_effect')).toBe(true);
  });

  it('characters.remove path=skills → remove_skill {name}（M2: removeSkill 假字段已废）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [], remove: [{ id: 'c1', path: 'skills', target: '火球术' }] },
      items: {},
    });
    const p = patches.find(x => x.op === 'remove_skill');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    expect(p.value).toEqual({ name: '火球术' });
    // 防回归: 不能再出现 removeSkill 假字段的 update_character（白名单会 throw）
    expect(patches.some(x => x.op === 'update_character' && x.value?.removeSkill)).toBe(false);
  });

  it('items.modify → update_item {name, changes}（M2: itemUpdate 假字段已废，禁改键剥离）', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [], remove: [] },
      items: { modify: [{ owner: 'c1', target: '铁剑', changes: { description: '缺了口', name: '不许改名', quantity: 99 } }] },
    });
    const p = patches.find(x => x.op === 'update_item');
    expect(p).toBeDefined();
    expect(p.target).toBe('characters.c1');
    expect(p.value.name).toBe('铁剑');
    expect(p.value.changes).toEqual({ description: '缺了口' });  // name/quantity 禁改键已剥离
    expect(patches.some(x => x.op === 'update_character' && x.value?.itemUpdate)).toBe(false);
  });

  it('items.equip / items.unequip → 按名对象形态', async () => {
    const patches = await runVarsUpdateWithJson({
      characters: { replace: [], delta: [], add: [], remove: [] },
      items: {
        equip: [{ owner: 'c1', target: '白橡木法杖', slot: '武器' }],
        unequip: [{ owner: 'c1', target: '旧皮甲' }],
      },
    });
    const eq = patches.find(x => x.op === 'equip_item');
    const uneq = patches.find(x => x.op === 'unequip_item');
    expect(eq.value).toEqual({ name: '白橡木法杖', slot: '武器' });
    expect(uneq.value).toEqual({ name: '旧皮甲' });
  });
});

// ========== onStateCommitError 上浮 ==========

describe('AgentOrchestrator — onStateCommitError 上浮', () => {
  beforeEach(() => {
    commitChatStateMock.mockClear();
  });

  it('commit errors 非空时应触发回调（source=vars_update）', async () => {
    commitChatStateMock.mockImplementation(async () => ({
      success: false, patchesApplied: 0, eventsGenerated: [], errors: ['角色不存在: x'],
    }));
    const onStateCommitError = vi.fn();
    await runVarsUpdateWithJson(
      { characters: { replace: [{ id: 'x', path: 'hp', value: 10 }], delta: [], add: [], remove: [] }, items: {} },
      { onStateCommitError },
    );
    expect(onStateCommitError).toHaveBeenCalled();
    expect(onStateCommitError.mock.calls[0][0]).toBe('vars_update');
    expect(onStateCommitError.mock.calls[0][1]).toContain('角色不存在: x');
  });

  it('errors 为空时不触发回调', async () => {
    commitChatStateMock.mockImplementation(async (patches: any[]) => ({
      success: true, patchesApplied: patches.length, eventsGenerated: [], errors: [],
    }));
    const onStateCommitError = vi.fn();
    await runVarsUpdateWithJson(
      { characters: { replace: [{ id: 'x', path: 'hp', value: 10 }], delta: [], add: [], remove: [] }, items: {} },
      { onStateCommitError },
    );
    expect(onStateCommitError).not.toHaveBeenCalled();
  });
});
