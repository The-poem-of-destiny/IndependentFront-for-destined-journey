/**
 * Agent API Client — OpenAI 兼容 /chat/completions 客户端
 *
 * 特性:
 * - 每 Agent 独立 userId (DeepSeek 缓存隔离)
 * - 自动重试 (指数退避)
 * - 超时控制
 * - 缓存命中检测
 * - 支持 AbortSignal 外部取消
 */

import type { ApiEndpoint, AgentResult } from './types';

// ========== Types ==========

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface AgentClientOptions {
  endpoint: ApiEndpoint;
  agentId: string;
  saveId: string;
  timeout?: number;
  maxRetries?: number;
}

// ========== AgentClient ==========

export class AgentClient {
  private endpoint: ApiEndpoint;
  private agentId: string;
  private saveId: string;
  private timeout: number;
  private maxRetries: number;

  constructor(options: AgentClientOptions) {
    this.endpoint = options.endpoint;
    this.agentId = options.agentId;
    this.saveId = options.saveId;
    this.timeout = options.timeout ?? 60000;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 每 Agent 独立 userId — DeepSeek 缓存隔离的关键 */
  get userId(): string {
    return `fp|${this.saveId}|${this.agentId}`;
  }

  /**
   * 发送 chat completion 请求
   * @returns AgentResult — 即使失败也返回带 error 字段的结果（不抛异常）
   */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.callOnce(request, signal);
        // Success — attach retry metadata
        result.duration = Date.now() - startTime;
        return result;
      } catch (e) {
        lastError = e as Error;
        if (attempt < this.maxRetries) {
          // 指数退避: 1s, 2s, 4s...
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }

    return {
      agentId: this.agentId,
      output: null,
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: Date.now() - startTime,
      error: lastError?.message ?? 'Unknown error',
    };
  }

  private async callOnce(request: ChatRequest, signal?: AbortSignal): Promise<AgentResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // 合并外部 signal 和超时 signal
    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(`${this.endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: this.endpoint.defaultModel,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 2048,
          stream: false,
          stop: request.stop,
          // DeepSeek cache isolation
          user: this.userId,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await res.json();
      const rawResponse: string = data.choices?.[0]?.message?.content ?? '';
      const tokensUsed: number = data.usage?.total_tokens ?? 0;

      // DeepSeek 缓存命中标记 (多种检测方式)
      const cacheHit: boolean =
        data.cache_hit === true ||
        data.usage?.prompt_cache_hit_tokens > 0 ||
        res.headers.get('x-ds-cache-hit') === 'true';

      return {
        agentId: this.agentId,
        output: rawResponse,
        rawResponse,
        tokensUsed,
        cacheHit,
        duration: 0, // filled by caller
      };
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ========== UserId 工具函数 ==========

/** 构建标准 userId 用于 DeepSeek 缓存隔离 */
export function buildUserId(saveId: string, agentId: string): string {
  return `fp|${saveId}|${agentId}`;
}

/** 从 userId 解析 saveId 和 agentId */
export function parseUserId(userId: string): { saveId: string; agentId: string } | null {
  const parts = userId.split('|');
  if (parts.length === 3 && parts[0] === 'fp') {
    return { saveId: parts[1], agentId: parts[2] };
  }
  return null;
}
