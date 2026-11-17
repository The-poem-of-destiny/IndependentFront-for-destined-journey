/**
 * agent-client.ts — 引擎日志埋点：三协议 × 流式/非流式的 llm.request / llm.response，
 * 记录的 body 与实际 fetch 的 body 一致、密钥不落日志、日志器关闭时零条目且 thunk 不执行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEndpoint } from '../../../src/core/types/types';
import type { LlmProtocol } from '../../../src/core/types/types-api';
import type {
  EngineLogEntry,
  EngineLogLayerHead,
  EngineLogSink,
} from '../../../src/core/runtime/engine-logger';

// 包一层 buildLlmTransportHeaders：agent-client 只在 llm.request 的 thunk 里调它，
// 于是它的调用次数 = request thunk 的执行次数（transport 内部走的是模块内引用，不经过这里）
const headerSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../src/core/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/api/transport')>();
  return {
    ...actual,
    buildLlmTransportHeaders: (...args: Parameters<typeof actual.buildLlmTransportHeaders>) => {
      headerSpy.calls += 1;
      return actual.buildLlmTransportHeaders(...args);
    },
  };
});

import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  resetEngineLoggerForTest,
} from '../../../src/core/runtime/engine-logger';

const API_KEY = 'sk-logging-secret-0123456789';
const HEADER_SECRET = 'custom-header-secret-abcdef';

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

function makeEndpoint(protocol: LlmProtocol): ApiEndpoint {
  return {
    id: `ep_${protocol}`,
    name: `Test ${protocol}`,
    provider: 'custom',
    kind: 'llm',
    protocol,
    baseUrl: 'https://api.example.test/v1',
    apiKey: API_KEY,
    defaultModel: 'test-model',
    models: ['test-model'],
    timeout: 60000,
    headerOverrides: { 'X-Trace-Token': HEADER_SECRET },
  } as ApiEndpoint;
}

/** 各协议的非流式响应 */
const JSON_RESPONSES: Record<LlmProtocol, unknown> = {
  'openai-chat': {
    choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
  gemini: {
    candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  },
  'anthropic-messages': {
    content: [{ type: 'text', text: '你好' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  },
};

/** 各协议的 SSE 事件序列 */
const SSE_EVENTS: Record<LlmProtocol, unknown[] | string[]> = {
  'openai-chat': [
    { choices: [{ delta: { content: '你' } }] },
    { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] },
    '[DONE]',
  ],
  gemini: [
    { candidates: [{ content: { role: 'model', parts: [{ text: '你' }] } }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '好' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    },
  ],
  'anthropic-messages': [
    { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ],
};

function sseText(protocol: LlmProtocol): string {
  return SSE_EVENTS[protocol]
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
}

function mockJsonFetch(protocol: LlmProtocol) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => JSON_RESPONSES[protocol],
    text: async () => JSON.stringify(JSON_RESPONSES[protocol]),
  });
}

function mockStreamFetch(protocol: LlmProtocol) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText(protocol)));
      controller.close();
    },
  });
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    body,
    text: async () => '',
  });
}

function makeClient(protocol: LlmProtocol): AgentClient {
  return new AgentClient({
    endpoint: makeEndpoint(protocol),
    agentId: 'story',
    saveId: 'save-log',
    maxRetries: 0,
  });
}

const REQUEST = {
  messages: [
    { role: 'system' as const, content: '你是叙事者' },
    { role: 'user' as const, content: '走进铁匠铺' },
  ],
  temperature: 0.7,
  maxTokens: 256,
};

async function runStream(client: AgentClient): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    void client.chatStream(REQUEST, {
      onChunk: () => undefined,
      onComplete: (result) => resolve(result.fullText),
      onError: (error) => reject(new Error(error)),
    });
  });
}

let sink: MemorySink;

beforeEach(() => {
  resetEngineLoggerForTest();
  headerSpy.calls = 0;
  sink = new MemorySink();
  installEngineLogSink(sink);
});

afterEach(() => {
  resetEngineLoggerForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PROTOCOLS: LlmProtocol[] = ['openai-chat', 'gemini', 'anthropic-messages'];

describe('llm.request / llm.response 埋点', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol} 非流式：记录的 body 与实际 fetch 一致，响应原文落日志，密钥不落`, async () => {
      configureEngineLogger({ enabled: true, level: 'trace' });
      const fetchMock = mockJsonFetch(protocol);
      vi.stubGlobal('fetch', fetchMock);

      const result = await makeClient(protocol).chat(REQUEST);
      expect(result.error).toBeUndefined();
      expect(result.rawResponse).toBe('你好');
      await flushEngineLog();

      const [request] = sink.byCat('llm.request');
      const [response] = sink.byCat('llm.response');
      expect(request).toBeDefined();
      expect(response).toBeDefined();
      expect(request.level).toBe('info');
      expect(request.agentId).toBe('story');
      expect(request.saveId).toBe('save-log');
      expect(response.callId).toBe(request.callId);

      const requestPayload = JSON.parse(request.payload);
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(requestPayload.body).toEqual(sentBody);
      expect(requestPayload.protocol).toBe(protocol);
      expect(requestPayload.baseUrl).toBe('https://api.example.test/v1');
      expect(requestPayload.stream).toBe(false);
      // 请求头只记名字
      expect(requestPayload.headerNames).toContain('X-Custom-Headers');
      // 反证「关闭时 thunk 不执行」那条断言的探针确实有效
      expect(headerSpy.calls).toBeGreaterThan(0);

      const responsePayload = JSON.parse(response.payload);
      expect(responsePayload.raw).toEqual(JSON_RESPONSES[protocol]);
      expect(typeof responsePayload.durationMs).toBe('number');

      const all = JSON.stringify(sink.rows);
      expect(all).not.toContain(API_KEY);
      expect(all).not.toContain(HEADER_SECRET);
    });

    it(`${protocol} 流式：记录快照与 trace 级原始 SSE，body 与实际 fetch 一致`, async () => {
      configureEngineLogger({ enabled: true, level: 'trace' });
      const fetchMock = mockStreamFetch(protocol);
      vi.stubGlobal('fetch', fetchMock);

      const fullText = await runStream(makeClient(protocol));
      expect(fullText).toBe('你好');
      await flushEngineLog();

      const [request] = sink.byCat('llm.request');
      expect(request).toBeDefined();
      const requestPayload = JSON.parse(request.payload);
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(requestPayload.body).toEqual(sentBody);
      expect(requestPayload.stream).toBe(true);

      const responses = sink.byCat('llm.response');
      const snapshot = responses.find((row) => row.level === 'info');
      const raw = responses.find((row) => row.level === 'trace');
      expect(snapshot).toBeDefined();
      expect(raw).toBeDefined();
      expect(snapshot!.callId).toBe(request.callId);
      const snapshotPayload = JSON.parse(snapshot!.payload);
      expect(snapshotPayload.fullText).toBe('你好');
      expect(snapshotPayload.stream).toBe(true);
      expect(JSON.parse(raw!.payload).raw).toBe(sseText(protocol));

      const all = JSON.stringify(sink.rows);
      expect(all).not.toContain(API_KEY);
      expect(all).not.toContain(HEADER_SECRET);
    });
  }

  it('info 级时不累积原始 SSE（只有快照一条响应）', async () => {
    configureEngineLogger({ enabled: true, level: 'info' });
    vi.stubGlobal('fetch', mockStreamFetch('openai-chat'));
    await runStream(makeClient('openai-chat'));
    await flushEngineLog();
    const responses = sink.byCat('llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0].level).toBe('info');
  });

  it('上游 HTTP 错误记 llm.error，并经 redactSecrets 处理错误文本', async () => {
    configureEngineLogger({ enabled: true, level: 'trace' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => `invalid key Bearer ${API_KEY}`,
      }),
    );
    const result = await makeClient('openai-chat').chat(REQUEST);
    expect(result.error).toContain('HTTP 401');
    await flushEngineLog();
    const errors = sink.byCat('llm.error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((row) => JSON.parse(row.payload).status === 401)).toBe(true);
    expect(JSON.stringify(sink.rows)).not.toContain(API_KEY);
  });

  it('重试循环记 llm.retry', async () => {
    vi.useFakeTimers();
    try {
      configureEngineLogger({ enabled: true, level: 'trace' });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => 'boom',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => JSON_RESPONSES['openai-chat'],
          text: async () => '',
        });
      vi.stubGlobal('fetch', fetchMock);
      const client = new AgentClient({
        endpoint: makeEndpoint('openai-chat'),
        agentId: 'story',
        saveId: 'save-log',
        maxRetries: 1,
      });
      const pending = client.chat(REQUEST);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.error).toBeUndefined();
      await vi.runAllTimersAsync();
      await flushEngineLog();
      const [retry] = sink.byCat('llm.retry');
      expect(retry).toBeDefined();
      expect(JSON.parse(retry.payload)).toMatchObject({ mode: 'chat', attempt: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('日志器关闭', () => {
  it('三协议流式与非流式都不产生任何条目，且 request thunk 不执行', async () => {
    for (const protocol of PROTOCOLS) {
      vi.stubGlobal('fetch', mockJsonFetch(protocol));
      const result = await makeClient(protocol).chat(REQUEST);
      expect(result.rawResponse).toBe('你好');
      vi.stubGlobal('fetch', mockStreamFetch(protocol));
      expect(await runStream(makeClient(protocol))).toBe('你好');
    }
    await flushEngineLog();
    expect(sink.rows).toHaveLength(0);
    expect(headerSpy.calls).toBe(0);
  });
});
