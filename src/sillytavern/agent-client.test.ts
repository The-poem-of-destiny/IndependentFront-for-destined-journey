/**
 * agent-client.ts — API 客户端测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentClient, buildUserId, parseUserId } from './agent-client';
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

// ========== buildUserId / parseUserId ==========

describe('buildUserId', () => {
  it('应返回 fp|saveId|agentId 格式', () => {
    expect(buildUserId('save_1', 'story')).toBe('fp|save_1|story');
  });

  it('应支持各种 agentId', () => {
    expect(buildUserId('s1', 'memory_recall')).toBe('fp|s1|memory_recall');
    expect(buildUserId('s1', 'char_update')).toBe('fp|s1|char_update');
  });
});

describe('parseUserId', () => {
  it('应正确解析有效 userId', () => {
    expect(parseUserId('fp|save_1|story')).toEqual({ saveId: 'save_1', agentId: 'story' });
  });

  it('无效格式返回 null', () => {
    expect(parseUserId('invalid')).toBeNull();
    expect(parseUserId('x|y|z')).toBeNull();
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

  describe('userId', () => {
    it('应返回正确的缓存隔离 userId', () => {
      expect(client.userId).toBe('fp|save_test|story');
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
      expect(body.user_id).toBe('fp|save_test|story');
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
          return Promise.resolve({ ok: false, status: 503, headers: new Headers(), json: async () => ({}), text: async () => 'Service Unavailable' });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ choices: [{ message: { content: 'finally!' } }], usage: { total_tokens: 50 } }),
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

  describe('chat — 超时', () => {
    it('超时后应返回错误', async () => {
      const timeoutClient = new AgentClient({
        endpoint: makeEndpoint(),
        agentId: 'test',
        saveId: 's1',
        timeout: 50,  // very short timeout
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
      const result = await client.chat({ messages: [{ role: 'user', content: 'test' }] }, controller.signal);
      expect(result.error).toBeDefined();
    });
  });
});
