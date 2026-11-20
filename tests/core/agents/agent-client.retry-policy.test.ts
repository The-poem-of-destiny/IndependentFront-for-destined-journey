/**
 * agent-client.ts — 重试策略与流式空闲超时（2026-11-20）
 *
 * 覆盖：4xx 不重试 / 429 照 Retry-After 等 / 已有输出的流中途失败至多重试 1 次 /
 * 流式输出空闲超时 / 退避等待期间取消立即停。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentClient, LlmHttpError } from '../../../src/core/agents/agent-client';
import type { ApiEndpoint } from '../../../src/core/types/types';

function makeEndpoint(): ApiEndpoint {
  return {
    id: 'ep_test',
    name: 'Test',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test',
    defaultModel: 'test-model',
    models: ['test-model'],
    timeout: 60000,
  };
}

function clientOf(maxRetries: number, timeout = 5000): AgentClient {
  return new AgentClient({
    endpoint: makeEndpoint(),
    agentId: 'story',
    saveId: 's1',
    timeout,
    maxRetries,
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}, body = 'err') {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => body,
  };
}

function okJsonResponse(content: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 1 } }),
    text: async () => '{}',
  };
}

function streamResponse(chunks: string[], close = true) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' };
}

const PARTIAL_CHUNK = `data: ${JSON.stringify({
  choices: [{ delta: { content: 'partial' }, finish_reason: null }],
})}\n\n`;

const OK_STREAM = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const MESSAGES = { messages: [{ role: 'user' as const, content: 'test' }] };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgentClient 重试策略 — 不可重试的 4xx', () => {
  it.each([400, 401, 402, 403, 404])('chat：HTTP %i 只发 1 次，立即失败', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(status));
    globalThis.fetch = fetchMock;
    const result = await clientOf(3).chat(MESSAGES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 文案保持旧格式，turn-failure.ts 依赖它分类
    expect(result.error).toBe(`HTTP ${status}: err`);
  });

  it('chatStream：HTTP 401 只发 1 次，onError 一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    globalThis.fetch = fetchMock;
    const onError = vi.fn();
    await clientOf(3).chatStream(MESSAGES, { onChunk: vi.fn(), onComplete: vi.fn(), onError });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });

  it('408 仍按可重试处理', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? errorResponse(408) : okJsonResponse('fine'));
    });
    const p = clientOf(3).chat(MESSAGES);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await p;
    expect(calls).toBe(2);
    expect(result.output).toBe('fine');
  });

  it('LlmHttpError 携带结构化状态码与 Retry-After，文案与旧格式一致', () => {
    const e = new LlmHttpError(429, 'slow down', 3000);
    expect(e.message).toBe('HTTP 429: slow down');
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(3000);
  });
});

describe('AgentClient 重试策略 — 429 与 Retry-After', () => {
  it('Retry-After 秒数：等满该时长才重试', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1 ? errorResponse(429, { 'Retry-After': '5' }) : okJsonResponse('after wait'),
      );
    });
    const p = clientOf(3).chat(MESSAGES);
    await vi.advanceTimersByTimeAsync(4900);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    const result = await p;
    expect(calls).toBe(2);
    expect(result.output).toBe('after wait');
  });

  it('Retry-After HTTP-date：按与当前时间的差值等待', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? errorResponse(429, { 'Retry-After': 'Fri, 20 Nov 2026 00:00:08 GMT' })
          : okJsonResponse('dated'),
      );
    });
    const p = clientOf(3).chat(MESSAGES);
    await vi.advanceTimersByTimeAsync(7900);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(calls).toBe(2);
  });

  it('Retry-After 过大时封顶 60 秒', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1 ? errorResponse(429, { 'Retry-After': '3600' }) : okJsonResponse('capped'),
      );
    });
    const p = clientOf(3).chat(MESSAGES);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(calls).toBe(2);
  });

  it('chatStream：429 同样照 Retry-After 等待后重试', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1 ? errorResponse(429, { 'Retry-After': '3' }) : streamResponse([OK_STREAM]),
      );
    });
    const onComplete = vi.fn();
    const onError = vi.fn();
    const p = clientOf(3).chatStream(MESSAGES, { onChunk: vi.fn(), onComplete, onError });
    await vi.advanceTimersByTimeAsync(2900);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(calls).toBe(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'ok' }));
  });
});

describe('AgentClient 重试策略 — 流中途失败', () => {
  it('已收到输出后才失败：maxRetries=3 也至多再重试 1 次（共 2 次请求）', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(streamResponse([PARTIAL_CHUNK])));
    globalThis.fetch = fetchMock;
    const onError = vi.fn();
    const p = clientOf(3).chatStream(MESSAGES, {
      onChunk: vi.fn(),
      onComplete: vi.fn(),
      onError,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Stream ended unexpectedly before completion');
  });

  it('尚无输出时失败（5xx）仍按 maxRetries 重试', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(503)));
    globalThis.fetch = fetchMock;
    const onError = vi.fn();
    const p = clientOf(3).chatStream(MESSAGES, {
      onChunk: vi.fn(),
      onComplete: vi.fn(),
      onError,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('AgentClient — 流式输出空闲超时', () => {
  it('收到首块后连接停滞不关闭 → 到 timeout 报「流式输出空闲超时」，不再挂死', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(streamResponse([PARTIAL_CHUNK], false));
    const onError = vi.fn();
    const onComplete = vi.fn();
    const p = clientOf(0, 5000).chatStream(MESSAGES, { onChunk: vi.fn(), onComplete, onError });
    await vi.advanceTimersByTimeAsync(4900);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('流式输出空闲超时'));
  });

  it('空闲超时属于流中途失败：maxRetries=3 也只再重试 1 次', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(streamResponse([PARTIAL_CHUNK], false)));
    globalThis.fetch = fetchMock;
    const onError = vi.fn();
    const p = clientOf(3, 5000).chatStream(MESSAGES, {
      onChunk: vi.fn(),
      onComplete: vi.fn(),
      onError,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('流式输出空闲超时'));
  });

  it('数据持续流动时每块重置空闲定时器，不误报超时', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push: ((s: string) => void) | undefined;
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (s) => controller.enqueue(encoder.encode(s));
        close = () => controller.close();
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body });
    const onError = vi.fn();
    const onComplete = vi.fn();
    const p = clientOf(0, 5000).chatStream(MESSAGES, { onChunk: vi.fn(), onComplete, onError });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      push?.(PARTIAL_CHUNK);
    }
    await vi.advanceTimersByTimeAsync(4000);
    push?.(OK_STREAM);
    close?.();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('AgentClient 重试策略 — 退避等待可被取消', () => {
  it('chat：Retry-After 等待期间取消 → 立即返回，不等定时器、不再发请求', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(errorResponse(429, { 'Retry-After': '30' })));
    globalThis.fetch = fetchMock;
    const controller = new AbortController();
    const p = clientOf(3).chat(MESSAGES, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    // 不推进定时器：若等待不可取消，这里会一直挂到 30 秒
    const result = await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('HTTP 429');
  });

  it('chatStream：退避等待期间取消 → onError("Request aborted") 一次，不再发请求', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(errorResponse(429, { 'Retry-After': '30' })));
    globalThis.fetch = fetchMock;
    const controller = new AbortController();
    const onError = vi.fn();
    const p = clientOf(3).chatStream(
      MESSAGES,
      { onChunk: vi.fn(), onComplete: vi.fn(), onError },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Request aborted');
  });
});
