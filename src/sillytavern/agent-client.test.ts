/**
 * agent-client.ts — API 客户端测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentClient, buildUserId, parseUserId, USER_PLACEHOLDER_CONTENT } from './agent-client';
import type { ApiEndpoint } from './types';

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'ep_test',
    name: 'Test',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test',
    defaultModel: 'test-model',
    models: ['test-model'],
    timeout: 60000,
    ...overrides,
  };
}

function mockFetch(response: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
}

function mockStreamingFetch(chunks: string[], close = true) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (close) controller.close();
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

// ========== buildUserId / parseUserId ==========

describe('buildUserId', () => {
  it('🔴 回归: 只按 agent 区分，不含 saveId（DeepSeek KVCache 跨存档复用）', () => {
    expect(buildUserId('save_1', 'story')).toBe('fp|story');
  });

  it('同一 agent 不同存档 → 相同 userId（缓存可跨存档命中）', () => {
    expect(buildUserId('save_1', 'story')).toBe(buildUserId('save_2', 'story'));
  });

  it('应支持各种 agentId', () => {
    expect(buildUserId('s1', 'memory_recall')).toBe('fp|memory_recall');
    expect(buildUserId('s1', 'request_dispatcher')).toBe('fp|request_dispatcher');
  });
});

describe('parseUserId', () => {
  it('应正确解析新格式 fp|agentId', () => {
    expect(parseUserId('fp|story')).toEqual({ saveId: '', agentId: 'story' });
    expect(parseUserId('fp|memory_recall')).toEqual({ saveId: '', agentId: 'memory_recall' });
  });

  it('兼容旧格式 fp|saveId|agentId（老数据回溯）', () => {
    expect(parseUserId('fp|save_1|story')).toEqual({ saveId: 'save_1', agentId: 'story' });
  });

  it('无效格式返回 null', () => {
    expect(parseUserId('invalid')).toBeNull();
    expect(parseUserId('x|y')).toBeNull();
    expect(parseUserId('')).toBeNull();
  });
});

// ========== AgentClient ==========

describe('AgentClient', () => {
  let client: AgentClient;

  beforeEach(() => {
    client = new AgentClient({
      endpoint: makeEndpoint(),
      agentId: 'story',
      saveId: 'save_test',
      timeout: 5000,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('userId', () => {
    it('🔴 回归: 只按 agent 区分，不含 saveId（DeepSeek KVCache 跨存档复用）', () => {
      expect(client.userId).toBe('fp|story');
    });
  });

  describe('chat — 成功', () => {
    it('应返回正确解析的 AgentResult', async () => {
      const mockRes = {
        choices: [{ message: { content: 'Hello, world!' } }],
        usage: { total_tokens: 150 },
      };
      globalThis.fetch = mockFetch(mockRes);

      const result = await client.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.agentId).toBe('story');
      expect(result.output).toBe('Hello, world!');
      expect(result.rawResponse).toBe('Hello, world!');
      expect(result.tokensUsed).toBe(150);
      expect(result.error).toBeUndefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('🆕 应捕获 finish_reason（length=输出截断，大纲解析失败分诊用）', async () => {
      // 截断场景: 模型输出被 max_tokens 上限切断（finish_reason 在 choice 层，不在 message 内）
      globalThis.fetch = mockFetch({
        choices: [{ message: { content: '...<outline><title>半截' }, finish_reason: 'length' }],
        usage: { total_tokens: 300, completion_tokens: 16384 },
      });
      const truncated = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
      expect(truncated.finishReason).toBe('length');

      // 正常结束场景: finish_reason=stop
      globalThis.fetch = mockFetch({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
      });
      const stopped = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
      expect(stopped.finishReason).toBe('stop');
    });

    it('应检测缓存命中 (cache_hit 字段)', async () => {
      const mockRes = {
        choices: [{ message: { content: 'cached response' } }],
        usage: { total_tokens: 50 },
        cache_hit: true,
      };
      globalThis.fetch = mockFetch(mockRes);

      const result = await client.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.cacheHit).toBe(true);
    });

    it('应检测缓存命中 (prompt_cache_hit_tokens > 0)', async () => {
      const mockRes = {
        choices: [{ message: { content: 'cached' } }],
        usage: { total_tokens: 100, prompt_cache_hit_tokens: 500 },
      };
      globalThis.fetch = mockFetch(mockRes);

      const result = await client.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.cacheHit).toBe(true);
    });

    it('fetch 应带 user_id 参数（DeepSeek 缓存隔离）', async () => {
      const mockFn = mockFetch({
        choices: [{ message: { content: 'ok' } }],
        usage: { total_tokens: 10 },
      });
      globalThis.fetch = mockFn;

      await client.chat({ messages: [{ role: 'user', content: 'test' }] });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.user_id).toBe('fp|story');
    });

    it('应解包 Cline 网关的 data 信封（非流式响应包在顶层 data 里）', async () => {
      // 真机踩坑(2026-07-31): api.cline.bot 的非流式响应形如 {data:{choices:[...],usage:{...}}}，
      // 直接读顶层 choices 会静默解析成空字符串。流式 chunk 是标准形态，不受影响。
      const mockRes = {
        data: {
          choices: [{ message: { content: 'from cline' } }],
          usage: { total_tokens: 42 },
        },
      };
      globalThis.fetch = mockFetch(mockRes);

      const result = await client.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.rawResponse).toBe('from cline');
      expect(result.tokensUsed).toBe(42);
    });
  });

  describe('ensureUserMessage — 全 system 消息补位', () => {
    // `buildAgentMessages` 对每个 Agent 都只产出一条 system 消息，所以这条补位路径
    // 落在**每一次**生产请求上（不是边缘分支），此前零覆盖。
    const okRes = { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } };

    it('🔴 回归(2026-08-13): 补的 user 消息必须非空 —— 空串会让 Gemini 系网关 400 contents field is required', async () => {
      const mockFn = mockFetch(okRes);
      globalThis.fetch = mockFn;

      await client.chat({ messages: [{ role: 'system', content: '你是叙事引擎' }] });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1].role).toBe('user');
      // 判据是「非空」而不是「等于某个字」—— 占位词可以换，空串不行
      expect(body.messages[1].content.length).toBeGreaterThan(0);
      expect(body.messages[1].content).toBe(USER_PLACEHOLDER_CONTENT);
    });

    it('常量自身非空（换占位词时的护栏）', () => {
      expect(USER_PLACEHOLDER_CONTENT.trim()).not.toBe('');
    });

    it('已有 user 消息时不追加、不改写', async () => {
      const mockFn = mockFetch(okRes);
      globalThis.fetch = mockFn;

      await client.chat({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '玩家输入' },
        ],
      });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1].content).toBe('玩家输入');
    });

    it('空 messages 数组保持原样（不无中生有）', async () => {
      const mockFn = mockFetch(okRes);
      globalThis.fetch = mockFn;

      await client.chat({ messages: [] });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.messages).toEqual([]);
    });
  });

  describe('chat — 错误', () => {
    it('HTTP 错误应返回带 error 的 AgentResult', async () => {
      globalThis.fetch = mockFetch({ error: 'Server Error' }, 500);

      const result = await client.chat({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.error).toBeDefined();
      expect(result.error).toContain('HTTP 500');
      expect(result.output).toBeNull();
    });

    it('空 choices 应返回空字符串', async () => {
      globalThis.fetch = mockFetch({ choices: [], usage: { total_tokens: 0 } });

      const result = await client.chat({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.rawResponse).toBe('');
    });
  });

  describe('chat — 重试', () => {
    it('应在重试后成功', async () => {
      const retryClient = new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'test',
        saveId: 's1',
        maxRetries: 2,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => 'Service Unavailable',
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            choices: [{ message: { content: 'finally!' } }],
            usage: { total_tokens: 50 },
          }),
          text: async () => '{}',
        });
      });

      const result = await retryClient.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(callCount).toBe(3);
      expect(result.output).toBe('finally!');
      expect(result.error).toBeUndefined();
    });

    it('重试耗尽后返回错误', async () => {
      const retryClient = new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'test',
        saveId: 's1',
        maxRetries: 1,
      });

      globalThis.fetch = mockFetch({}, 500);

      const result = await retryClient.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.error).toBeDefined();
    });
  });

  describe('chat — 重试次数与 abort 短路（2026-08-16）', () => {
    function retryClientOf(maxRetries: number): AgentClient {
      return new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'test',
        saveId: 's1',
        maxRetries,
      });
    }

    it('maxRetries=3 时共发 4 次请求（1 次 + 3 次重试）后仍失败', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(3);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => 'Service Unavailable',
        });
      });

      const p = c.chat({ messages: [{ role: 'user', content: 'test' }] });
      await vi.advanceTimersByTimeAsync(20000); // 退避 1+2+4=7s
      const result = await p;
      expect(callCount).toBe(4);
      expect(result.error).toContain('HTTP 503');
    });

    it('maxRetries=0 时不重试（只发 1 次）', async () => {
      const c = retryClientOf(0);
      globalThis.fetch = mockFetch({}, 500);
      const result = await c.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.error).toBeDefined();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('🔴 abort 后不重试：外部取消立即停，不白等退避、不重复发请求', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(3);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => 'Service Unavailable',
        });
      });

      const controller = new AbortController();
      controller.abort();
      const p = c.chat({ messages: [{ role: 'user', content: 'test' }] }, controller.signal);
      await vi.advanceTimersByTimeAsync(20000);
      const result = await p;
      // 关键断言：只发 1 次请求（不重试）。错误文案不苛求 —— mock fetch
      // 不响应 abort signal（真实 fetch 会立刻 reject「请求已取消」）。
      expect(callCount).toBe(1);
      expect(result.error).toBeDefined();
    });

    it('🔴 abort 发生在重试退避等待期间 → 立即停', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(3);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => 'Service Unavailable',
        });
      });

      const controller = new AbortController();
      const p = c.chat({ messages: [{ role: 'user', content: 'test' }] }, controller.signal);
      // 第一次失败后进入退避等待（fake timers 下未推进）；此时用户取消
      await Promise.resolve();
      controller.abort();
      await vi.advanceTimersByTimeAsync(20000);
      const result = await p;
      expect(callCount).toBe(1);
      expect(result.error).toBeDefined();
    });
  });

  describe('chat — 超时', () => {
    it('超时后应返回错误', async () => {
      const timeoutClient = new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'test',
        saveId: 's1',
        timeout: 50, // very short timeout
        maxRetries: 0,
      });

      // Mock fetch that respects AbortSignal
      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      });

      const result = await timeoutClient.chat({ messages: [{ role: 'user', content: 'test' }] });
      expect(result.error).toBeDefined();
    });
  });

  describe('chat — AbortSignal', () => {
    it('外部 signal 应能取消请求', async () => {
      const controller = new AbortController();
      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      });

      // Abort immediately — the internal signal merges with external via onExternalAbort
      controller.abort();
      const result = await client.chat(
        { messages: [{ role: 'user', content: 'test' }] },
        controller.signal,
      );
      expect(result.error).toBeDefined();
    });
  });

  describe('chatStream — SSE settlement', () => {
    it('supports CRLF and data without a space, then includes usage sent after finish_reason', async () => {
      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch([
        [
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
          })}\r\n\r\n`,
          `data:${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\r\n\r\n`,
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              total_tokens: 42,
              prompt_cache_hit_tokens: 12,
              prompt_cache_miss_tokens: 5,
              completion_tokens: 7,
            },
          })}\r\n\r\n`,
          'data:[DONE]\r\n\r\n',
        ].join(''),
      ]);

      await client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk, onComplete, onError },
      );

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          fullText: 'Hello',
          tokensUsed: 42,
          cacheHit: true,
          cacheHitTokens: 12,
          cacheMissTokens: 5,
          completionTokens: 7,
        }),
      );
      expect(onChunk.mock.calls).toEqual([
        ['Hello', false],
        ['Hello', true],
      ]);
    });

    it('concatenates multiple CRLF data fields in one SSE event before parsing JSON', async () => {
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch([
        [
          'data: {"choices":[{"delta":\r\n',
          'data: {"content":"split"},"finish_reason":null}]}\r\n\r\n',
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\r\n\r\n`,
          'data: [DONE]\r\n\r\n',
        ].join(''),
      ]);

      await client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete, onError },
      );

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'split' }));
    });

    it('completes after a bounded grace period when finish_reason arrives but the body stays open', async () => {
      vi.useFakeTimers();
      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch(
        [
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }],
          })}\n\n`,
        ],
        false,
      );

      const streamPromise = client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk, onComplete, onError },
      );
      for (let i = 0; i < 10 && onChunk.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      expect(onChunk).toHaveBeenCalledWith('final', false);
      expect(onComplete).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      await streamPromise;

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'final' }));
    });

    it('completes on [DONE] even when no finish_reason was sent', async () => {
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'done' }, finish_reason: null }],
        })}\n\ndata: [DONE]\n\n`,
      ]);

      await client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete, onError },
      );

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'done' }));
    });

    it('flushes the final unterminated event at EOF and preserves accumulated tool calls', async () => {
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'lookup', arguments: '{"name":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data:${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"Luna"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}`,
      ]);

      await client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete, onError },
      );

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { name: 'Luna' } }],
        }),
      );
    });

    it('reports an unexpected EOF exactly once when neither finish_reason nor [DONE] arrives', async () => {
      const onComplete = vi.fn();
      const onError = vi.fn();
      globalThis.fetch = mockStreamingFetch([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'partial' }, finish_reason: null }],
        })}\n\n`,
      ]);

      await client.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete, onError },
      );

      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Stream ended unexpectedly before completion');
    });
  });

  describe('chatStream — 重试（2026-08-16）', () => {
    function retryClientOf(maxRetries: number): AgentClient {
      return new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'story',
        saveId: 's1',
        timeout: 5000,
        maxRetries,
      });
    }

    const OK_STREAM = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'retried' }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    it('🔴 失败后重试成功：fetch 2 次、onComplete 一次、重试前 onChunk("", true) 清预览', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(2);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => 'Service Unavailable',
          });
        }
        // 🔴 mockStreamingFetch 返回的是 **fetch mock**（设计为直接赋给 fetch），
        // 这里要调用它拿到 resolve 值 —— 直接返回 mock 对象会让 await 拿到
        // vi.fn() 本身，res.body 为 undefined，第二次尝试必然失败。
        return mockStreamingFetch([OK_STREAM])();
      });

      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();
      const p = c.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk, onComplete, onError },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;

      expect(callCount).toBe(2);
      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'retried' }));
      // 重试前必须清预览（onChunk('', true)），否则两段正文拼接显示
      expect(onChunk).toHaveBeenCalledWith('', true);
    });

    it('重试耗尽 → onError 一次，不再重试', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(2);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => 'Service Unavailable',
        });
      });

      const onError = vi.fn();
      const p = c.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete: vi.fn(), onError },
      );
      await vi.advanceTimersByTimeAsync(20000);
      await p;

      expect(callCount).toBe(3); // 1 + 2 重试
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    });

    it('🔴 外部 abort 不重试（取消立即停）', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(3);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => 'Service Unavailable',
        });
      });

      const controller = new AbortController();
      controller.abort();
      const onError = vi.fn();
      const p = c.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete: vi.fn(), onError },
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(20000);
      await p;

      expect(callCount).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Request aborted');
    });

    it('🔴 流中断（无 finish_reason 提前 EOF）可重试，重试成功后 onComplete 一次', async () => {
      vi.useFakeTimers();
      const c = retryClientOf(1);
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // 第一次：流中途 EOF（没有 finish_reason / [DONE]）
          return mockStreamingFetch([
            `data: ${JSON.stringify({
              choices: [{ delta: { content: 'partial' }, finish_reason: null }],
            })}\n\n`,
          ])();
        }
        return mockStreamingFetch([OK_STREAM])();
      });

      const onComplete = vi.fn();
      const onError = vi.fn();
      const p = c.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        { onChunk: vi.fn(), onComplete, onError },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await p;

      expect(callCount).toBe(2);
      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'retried' }));
    });
  });
});
