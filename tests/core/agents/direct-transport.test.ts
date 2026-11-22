import {
  acceptDirectContext,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../../../src/core/agents/agent-client';
import { buildLlmRequest } from '../../../src/core/api/llm-adapter';
import {
  generateDirectTurn,
  type DirectGenerationInput,
} from '../../../src/core/agents/direct-main';
import {
  createDirectPreset,
  createCachedDirectPreset,
} from '../../../src/core/prompts/direct-prompt';
import { projectStreamingStory } from '../../../src/core/story/story-output';
import {
  createDefaultCharacterState,
  type AgentConfig,
  type ApiEndpoint,
  type MemoryRecord,
  type WorldBookEntry,
} from '../../../src/core/types/types';

const raw =
  '<maintext>铁匠收好短剑。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>';

function setup(v2: boolean) {
  const endpoint: ApiEndpoint = {
    id: 'direct-wire',
    name: 'Test',
    provider: 'openai',
    protocol: 'openai-chat',
    baseUrl: 'https://invalid.example/v1',
    apiKey: 'test-only',
    defaultModel: 'test',
    models: ['test'],
    timeout: 1000,
  };
  let preview = '';
  const visible: string[] = [];
  const onError = vi.fn();
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
    maxRetries: 0,
    timeout: 1000,
    userId: 'direct-wire',
    historyLayers: 2,
    presetId: createDirectPreset().id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    streamCallbacks: {
      onChunk(text, done) {
        if (!done) {
          preview += text;
          visible.push(projectStreamingStory(preview));
        }
      },
      onComplete: vi.fn(),
      onError,
    },
  };
  const input: DirectGenerationInput = {
    config,
    endpoint,
    configs: [config],
    presets: [createDirectPreset()],
    worldBooks: [],
    combat: null,
    context: {
      userInput: '查看短剑',
      characters: [],
      variables: { 地点: '铁匠铺' },
      history: [],
      memories: [],
      worldBooks: [],
      plotEvents: [],
      agentOutputs: new Map([['memory_recall', '铁匠已收到材料']]),
    },
    ...(v2 ? { storyContext: { windowTurns: 2, segments: [], archives: [] } } : {}),
  };
  return {
    input,
    visible,
    onError,
    client: new AgentClient({
      endpoint,
      agentId: 'direct_main',
      saveId: 'direct-wire',
      maxRetries: 0,
    }),
  };
}

/** 流式 SSE 响应；`reasoning` 先以思维链增量发出，`finishReason` 在末尾单独一帧给出 */
function streamResponse(
  complete: boolean,
  text = raw,
  options: { reasoning?: string; finishReason?: string } = {},
) {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
  const events =
    (options.reasoning ? frame({ reasoning_content: options.reasoning }) : '') +
    (text ? [text.slice(0, 11), text.slice(11, 70), text.slice(70)] : [])
      .map((content) => frame({ content }))
      .join('') +
    (options.finishReason ? frame({}, options.finishReason) : '') +
    (complete ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(events);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split UTF-8 and SSE delimiters, as a real transport may do.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('direct generation through the real client and stream parser', () => {
  it.each([false, true])(
    'sends one complete request each turn and hides control JSON (v2=%s)',
    async (v2) => {
      const { input, client, visible, onError } = setup(v2);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => streamResponse(true));
      for (const location of ['铁匠铺', '街道']) {
        input.context.variables.地点 = location;
        const generated = await generateDirectTurn(input, client);
        expect(generated.draft.content).toBe('铁匠收好短剑。');
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [index, [url, init]] of fetch.mock.calls.entries()) {
        expect(url).toBe('/api/llm/openai-chat/generate');
        const body = JSON.parse(String(init!.body));
        expect(body.stream).toBe(true);
        expect(body.tools).toBeUndefined();
        const prompt = JSON.stringify(body.messages);
        expect(prompt).toContain('direct_updates');
        expect(prompt).toContain('铁匠已收到材料');
        expect(prompt).toContain(index ? '街道' : '铁匠铺');
        expect(prompt.match(/查看短剑/g)).toHaveLength(1);
      }
      expect(onError).not.toHaveBeenCalled();
      expect(visible.some((text) => text.includes('铁匠收好短剑'))).toBe(true);
      expect(
        visible.every((text) => !text.includes('direct_updates') && !text.includes('"diceUsed"')),
      ).toBe(true);
    },
  );

  it.each(['http', 'truncated'] as const)(
    'rejects %s failures without a second request',
    async (failure) => {
      const { input, client, onError } = setup(true);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () =>
          failure === 'http' ? new Response('Unavailable', { status: 503 }) : streamResponse(false),
        );
      await expect(generateDirectTurn(input, client)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );
});

describe('直出空正文自动重发（真实客户端与流解析）', () => {
  /** 只有思考没有正文的流 */
  const reasoningOnly = () =>
    streamResponse(true, '', { reasoning: '先想想铁匠会怎么说。', finishReason: 'stop' });

  it('流式结果带上 finishReason', async () => {
    const { input, client } = setup(false);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      streamResponse(true, raw, { finishReason: 'stop' }),
    );
    const generated = await generateDirectTurn(input, client);
    expect(generated.result.finishReason).toBe('stop');
    expect(generated.result.providerRounds).toBeUndefined();
  });

  it('流式只有思考没有正文：自动重发一次', async () => {
    const { input, client, onError } = setup(true);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reasoningOnly())
      .mockImplementation(async () => streamResponse(true, raw, { finishReason: 'stop' }));
    const generated = await generateDirectTurn(input, client);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][1]!.body)).toBe(String(fetch.mock.calls[0][1]!.body));
    expect(onError).not.toHaveBeenCalled();
    expect(generated.draft.content).toBe('铁匠收好短剑。');
    const rounds = generated.result.providerRounds!;
    expect(rounds).toHaveLength(2);
    expect(rounds[0].finishReason).toBe('stop');
    expect(rounds[0].error).toMatch(/^模型返回了空正文：只输出了思考/);
  });

  it('缓存直出空正文重试复用同一张票据，两次都空只记一次丢弃', async () => {
    const saveId = 'cached-empty-twice';
    invalidateDirectContext(saveId);
    const { input, client } = setup(false);
    input.cache = { saveId, policy: 'prefix' };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => streamResponse(true));
    try {
      const first = await generateDirectTurn(input, client);
      await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
      fetch
        .mockImplementationOnce(async () => reasoningOnly())
        .mockImplementationOnce(async () => reasoningOnly());
      input.context.userInput = '失败的尝试';
      await expect(generateDirectTurn(input, client)).rejects.toThrow(/^模型返回了空正文/);
      expect(fetch).toHaveBeenCalledTimes(3);
      // 两次重发是同一份请求体（同一张票据，没有重新组装）
      expect(String(fetch.mock.calls[2][1]!.body)).toBe(String(fetch.mock.calls[1][1]!.body));
      input.context.userInput = '再试一次';
      const next = await generateDirectTurn(input, client);
      expect(fetch).toHaveBeenCalledTimes(4);
      // 只记一次丢弃：没到连续丢弃上限，不会以 repeated_rejection 冷建
      expect(next.cache!.ticket.rebaseReason).toBeUndefined();
      const retained = first.cache!.ticket.retainedCount;
      expect(next.result.requestMessages!.slice(0, retained)).toEqual(
        first.result.requestMessages!.slice(0, retained),
      );
      expect(JSON.stringify(next.result.requestMessages)).not.toContain('失败的尝试');
    } finally {
      invalidateDirectContext(saveId);
    }
  });

  it('缓存直出空正文重试成功后票据仍可接纳', async () => {
    const saveId = 'cached-empty-recovered';
    invalidateDirectContext(saveId);
    const { input, client } = setup(false);
    input.cache = { saveId, policy: 'prefix' };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reasoningOnly())
      .mockImplementation(async () => streamResponse(true));
    try {
      const first = await generateDirectTurn(input, client);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(first.result.providerRounds).toHaveLength(2);
      await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
      input.context.userInput = '离开铁匠铺';
      const second = await generateDirectTurn(input, client);
      expect(second.cache!.ticket.rebaseReason).toBeUndefined();
      expect(second.result.promptRebased).toBe(false);
      const retained = first.cache!.ticket.retainedCount;
      expect(second.result.requestMessages!.slice(0, retained)).toEqual(
        first.result.requestMessages!.slice(0, retained),
      );
    } finally {
      invalidateDirectContext(saveId);
    }
  });
});

it.each([false, true])(
  'cached direct reuses the accepted wire prefix with legacy/v2=%s',
  async (v2) => {
    invalidateDirectContext('cached-wire');
    const { input, client } = setup(v2);
    input.cache = { saveId: 'cached-wire', policy: 'prefix' };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => streamResponse(true));
    const first = await generateDirectTurn(input, client);
    expect(first.cache).toBeDefined();
    await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
    input.context.userInput = '离开铁匠铺';
    input.context.variables = { 地点: '街道' };
    const second = await generateDirectTurn(input, client);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.result.promptRebased).toBe(false);
    // 前缀到第一楼留存消息为止逐条一致；第一楼的不留存尾部不再出现
    const retained = first.cache!.ticket.retainedCount;
    expect(second.result.requestMessages!.slice(0, retained)).toEqual(
      first.result.requestMessages!.slice(0, retained),
    );
    const firstTail = first.result.requestMessages![first.result.requestMessages!.length - 1];
    expect(firstTail.content).toContain('<turn_context>');
    expect(second.result.requestMessages).not.toContainEqual(firstTail);
    const secondRetained = second.result.requestMessages![second.cache!.ticket.retainedCount - 1];
    expect(secondRetained.content).toContain('街道');
    expect(secondRetained.content).toContain('<player_input>\n离开铁匠铺\n</player_input>');
    expect(
      second.result.requestMessages![second.result.requestMessages!.length - 1]!.content,
    ).toMatch(/^<turn_context>/);
    expect(second.result.providerUsage).toBeDefined();
    invalidateDirectContext('cached-wire');
  },
);

it('缓存模式把静态前缀条数（含协议消息）作为 cacheStaticSystemCount 交给客户端', async () => {
  const saveId = 'cached-static-count';
  invalidateDirectContext(saveId);
  const { input, client } = setup(false);
  input.cache = { saveId, policy: 'prefix' };
  // 正文历史会以一条易变 system 紧跟在静态前缀之后，用来区分「静态末尾」与「最后一条 system」
  input.context.history = [
    { role: 'user', content: '走进铁匠铺' },
    { role: 'assistant', content: '炉火正旺，铁匠抬头看你。' },
  ] as typeof input.context.history;
  const chatStream = vi.spyOn(client, 'chatStream');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse(true));
  try {
    await generateDirectTurn(input, client);
    expect(chatStream).toHaveBeenCalledTimes(1);
    const request = chatStream.mock.calls[0][0];
    const count = request.cacheStaticSystemCount!;
    // 静态前缀 = 协议消息 + 预设 system；不含紧随其后的正文历史 system
    expect(count).toBe(2);
    expect(request.messages.slice(0, count).every((m) => m.role === 'system')).toBe(true);
    expect(request.messages[0].content).toContain('direct_updates');
    expect(request.messages[count]).toMatchObject({ role: 'system' });
    expect(request.messages[count].content).toContain('走进铁匠铺');
    // 交给 Claude 协议时，断点落在静态末尾与最后一条 system 上
    const body = buildLlmRequest({
      protocol: 'anthropic-messages',
      model: 'test',
      stream: false,
      userId: 'test',
      messages: request.messages,
      cachePolicy: 'anthropic',
      cacheStaticSystemCount: count,
    }).body;
    expect((body.system as { cache_control?: unknown }[]).map((b) => !!b.cache_control)).toEqual([
      false,
      true,
      true,
    ]);
  } finally {
    invalidateDirectContext(saveId);
  }
});

it('缓存模式交出留存条数并把会话诊断写进结果', async () => {
  const saveId = 'cached-retained-count';
  invalidateDirectContext(saveId);
  const { input, client } = setup(false);
  input.cache = { saveId, policy: 'prefix' };
  const chatStream = vi.spyOn(client, 'chatStream');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse(true));
  try {
    const turn = await generateDirectTurn(input, client);
    const request = chatStream.mock.calls[0][0];
    expect(request.cacheRetainedMessageCount).toBe(request.messages.length - 1);
    expect(request.messages[request.cacheRetainedMessageCount! - 1].content).toContain(
      '<player_input>',
    );
    const tail = request.messages[request.messages.length - 1].content!;
    expect(tail).toMatch(/^<turn_context>/);
    // 冷建时战斗与资源已整份在留存消息的 set 里，尾部不重复现值
    expect(tail).not.toContain('"current"');
    expect(turn.result.directCacheDiagnostics).toBe(turn.cache!.ticket.diagnostics);
    expect(turn.result.directCacheDiagnostics).toMatchObject({
      rebased: true,
      tailChars: tail.length,
    });
    expect(turn.cache).toEqual({ ticket: turn.cache!.ticket });
  } finally {
    invalidateDirectContext(saveId);
  }
});

it('非缓存模式不设 cacheStaticSystemCount', async () => {
  const { input, client } = setup(false);
  const chatStream = vi.spyOn(client, 'chatStream');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse(true));
  await generateDirectTurn(input, client);
  expect(chatStream.mock.calls[0][0].cacheStaticSystemCount).toBeUndefined();
  expect(chatStream.mock.calls[0][0].cacheRetainedMessageCount).toBeUndefined();
});

it.each([
  ['rejected output', 'keeps', false],
  ['cancelled', 'keeps', false],
  ['provider failure', 'drops', true],
] as const)('a %s attempt %s the accepted cached session', async (failure, _, rebuilds) => {
  const saveId = 'cached-failure';
  invalidateDirectContext(saveId);
  const { input, client } = setup(false);
  input.cache = { saveId, policy: 'prefix' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse(true));
  try {
    const first = await generateDirectTurn(input, client);
    await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
    const controller = new AbortController();
    if (failure === 'cancelled') input.config.abortSignal = controller.signal;
    fetch.mockImplementationOnce(async () => {
      if (failure === 'cancelled') {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return failure === 'provider failure'
        ? new Response('Unavailable', { status: 503 })
        : streamResponse(
            true,
            '<maintext>缺少更新块的回复。</maintext><direct_updates>{坏掉的</direct_updates>',
          );
    });
    input.context.userInput = '失败的尝试';
    await expect(generateDirectTurn(input, client)).rejects.toThrow();
    input.config.abortSignal = undefined;
    input.context.userInput = '再试一次';
    const retry = await generateDirectTurn(input, client);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(retry.cache!.ticket.rebaseReason).toBe(rebuilds ? 'missing_session' : undefined);
    if (!rebuilds) {
      const retained = first.cache!.ticket.retainedCount;
      expect(retry.result.requestMessages!.slice(0, retained)).toEqual(
        first.result.requestMessages!.slice(0, retained),
      );
    }
    const prompt = JSON.stringify(retry.result.requestMessages);
    expect(prompt).not.toContain('失败的尝试');
    expect(prompt).not.toContain('缺少更新块');
    expect(prompt).toContain('再试一次');
  } finally {
    invalidateDirectContext(saveId);
  }
});

it('legacy memory growth appends one memory per turn instead of rebuilding the session', async () => {
  const saveId = 'cached-memory-growth';
  invalidateDirectContext(saveId);
  const { input, client } = setup(false);
  input.cache = { saveId, policy: 'prefix' };
  const memory = (i: number): MemoryRecord => ({
    id: `MEM${String(i).padStart(6, '0')}`,
    saveId,
    createdAt: i,
    realTimestamp: i,
    timeRange: { start: '未知', end: '未知' },
    content: `第${i}条记忆：`.padEnd(300, '旅人在城中行走，与人交谈，记下见闻。'),
    hiddenLine: '',
    keywords: [],
    relatedCharacterIds: [],
    importance: 5,
  });
  input.worldBooks = [
    {
      id: 'memory-growth',
      name: '规则',
      partition: 'world_setting',
      entries: [
        {
          uid: 'memory-growth:world_setting/rules',
          name: 'rules',
          content: '固定世界规则。'.repeat(3000),
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 1,
          position: 0,
          extra: { lore: { audiences: ['direct_main'], section: 'fixed' } },
        },
      ],
    },
  ];
  input.context.memories = Array.from({ length: 20 }, (_, i) => memory(i + 1));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse(true));
  try {
    const first = await generateDirectTurn(input, client);
    expect(JSON.stringify(first.cache!.ticket.messages)).toContain('memory/MEM000020');
    await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
    // 整块重发记忆库时，这个规模下每楼增量约 8.5k 字、第 3 楼触发 transcript_growth：
    // 下面的「不重建」与「增量 < 5000」两条断言各自都会拦住
    for (let turn = 2; turn <= 5; turn++) {
      input.context.memories = [...input.context.memories!, memory(19 + turn)];
      input.context.userInput = `第${turn}楼`;
      const next = await generateDirectTurn(input, client);
      const ticket = next.cache!.ticket;
      expect(ticket.rebaseReason).toBeUndefined();
      const retained = ticket.messages[ticket.retainedCount - 1].content!;
      expect(retained).toContain(`memory/MEM0000${19 + turn}`);
      expect(retained).not.toContain('memory/MEM000001');
      expect(retained.length).toBeLessThan(5000);
      await acceptDirectContext(ticket, { acceptedMessages: [] });
    }
  } finally {
    invalidateDirectContext(saveId);
  }
});

it.each([false, true])(
  'cached layout keeps regional, recalled and opted-in data current (v2=%s)',
  async (v2) => {
    const saveId = `cached-layout-${v2}`;
    invalidateDirectContext(saveId);
    const { input, client } = setup(v2);
    const preset = createCachedDirectPreset();
    preset.settings.prompts.push({
      content: '作者本轮输入 {{USER_INPUT}}',
      directCachePlacement: 'turn',
      injection_order: 100,
    });
    input.presets = [preset];
    input.config.presetId = preset.id;
    input.cache = { saveId, policy: 'prefix' };
    const entry = (
      name: string,
      content: string,
      section: 'fixed' | 'region' | 'turn',
      location?: string,
    ): WorldBookEntry => ({
      uid: `cached-layout:world_setting/${name}`,
      name,
      content,
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: 1,
      position: 0,
      extra: {
        lore: {
          audiences: ['direct_main'],
          section,
          ...(location ? { activation: { locations: [location] } } : {}),
        },
      },
    });
    input.worldBooks = [
      {
        id: 'cached-layout',
        name: '规则',
        partition: 'world_setting',
        entries: [
          entry('rules', '固定规则'.repeat(2000), 'fixed'),
          entry('inside', '城内规则', 'region', '城内'),
          entry('outside', '城外规则', 'region', '城外'),
          entry('dynamic', '当前变量<%= getMessageVar("tick") %>', 'turn'),
        ],
      },
    ];
    input.context.characters = [
      createDefaultCharacterState({
        name: '旅人',
        type: 'player',
        location: '城内',
        inventory: [{ name: '铁', quantity: 2 }],
      }),
    ];
    input.context.variables = { 地点: '城内', sys: { tick: 1 } };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => streamResponse(true));
    try {
      const first = await generateDirectTurn(input, client);
      const prompt = first.cache!.ticket.messages.map((m) => m.content).join('\n');
      expect(prompt.match(/铁匠已收到材料/g)).toHaveLength(1);
      expect(prompt).toContain('当前变量1');
      expect(prompt).toContain('作者本轮输入 查看短剑');
      await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });
      input.context.characters[0].location = '城外';
      input.context.variables = { 地点: '城外', sys: { tick: 2 } };
      input.context.userInput = '向城外走去';
      input.context.agentOutputs.set('memory_recall', '新的召回');
      const second = await generateDirectTurn(input, client);
      const messages = second.cache!.ticket.messages;
      expect(second.cache!.ticket.rebaseReason).toBeUndefined();
      const retained = first.cache!.ticket.retainedCount;
      expect(messages.slice(0, retained)).toEqual(first.cache!.ticket.messages.slice(0, retained));
      // 本轮新增 = 留存消息 + 不留存尾部
      const turn = messages
        .slice(second.cache!.ticket.retainedCount - 1)
        .map((m) => m.content)
        .join('\n');
      expect(turn).toContain('当前变量2');
      expect(turn).toContain('城外规则');
      expect(turn).not.toContain('城内规则');
      expect(turn.match(/新的召回/g)).toHaveLength(1);
      // 召回只在尾部
      expect(messages[messages.length - 1].content).toContain('新的召回');
      expect(turn).toContain('作者本轮输入 向城外走去');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      invalidateDirectContext(saveId);
    }
  },
);
