/**
 * Agent API Client — OpenAI 兼容 /chat/completions 客户端
 *
 * 特性:
 * - 每 Agent 独立 userId (DeepSeek 缓存隔离)
 * - 自动重试 (指数退避)
 * - 超时控制
 * - 缓存命中检测
 * - 支持 AbortSignal 外部取消
 * - 🆕 Phase 8.5: chatWithTools() 多轮工具调用
 */

import type { ApiEndpoint, AgentResult, ToolDefinition } from './types';

/** 内部扩展 — 包含原始 tool_calls 数据 */
type InternalAgentResult = AgentResult & { _toolCalls?: any[] };

// ========== Types ==========

export interface ChatRequest {
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  /** 🆕 Agentic: 可用工具列表 */
  tools?: ToolDefinition[];
  /** 🆕 Agentic: 工具调用策略 */
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /** 🆕 DeepSeek 思考模式 */
  reasoning?: boolean;
}

export interface AgentClientOptions {
  endpoint: ApiEndpoint;
  agentId: string;
  saveId: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ChatWithToolsOptions {
  /** 最大工具调用轮数，默认 5 */
  maxRounds?: number;
  signal?: AbortSignal;
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
   * 发送 chat completion 请求（非 agentic 路径）
   * @returns AgentResult — 即使失败也返回带 error 字段的结果（不抛异常）
   */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<InternalAgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.callOnce(request, signal);
        result.duration = Date.now() - startTime;
        return result;
      } catch (e) {
        lastError = e as Error;
        if (attempt < this.maxRetries) {
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

  /**
   * 🆕 Agentic 路径: 发送带工具的消息，支持多轮工具调用。
   *
   * 流程:
   *   1. 发送初始 messages + tools + tool_choice
   *   2. 如果 AI 返回 tool_calls → 执行工具 → 追加 tool result 消息 → 回到步骤 1
   *   3. 如果 AI 返回 content（无 tool_calls）→ 最终输出
   *   4. 超过 maxRounds → 强制结束
   *
   * @param request 包含 tools 的 ChatRequest
   * @param toolExecutor 工具执行回调 (name, args) => result
   * @param options maxRounds / signal
   */
  async chatWithTools(
    request: ChatRequest,
    toolExecutor: (name: string, args: Record<string, any>) => Promise<any>,
    options: ChatWithToolsOptions = {},
  ): Promise<AgentResult> {
    const maxRounds = options.maxRounds ?? 5;
    const startTime = Date.now();
    const toolCallHistory: Array<{ name: string; arguments: any; result: any }> = [];

    // 复制消息列表（后续轮次会追加 assistant + tool 消息）
    const conversation = [...request.messages];
    let totalTokens = 0;
    const allReasoning: string[] = [];  // 跨轮次收集 reasoning

    for (let round = 0; round < maxRounds; round++) {
      const roundRequest: ChatRequest = {
        ...request,
        messages: conversation,
        tools: request.tools,
        tool_choice: request.tool_choice,
      };

      const innerResult = await this.chat(roundRequest, options.signal);
      totalTokens += innerResult.tokensUsed;

      // 收集每轮的 reasoning（不会被子调用覆盖）
      if (innerResult.reasoning) {
        allReasoning.push(`[Round ${round + 1}] ${innerResult.reasoning}`);
      }

      if (innerResult.error) {
        return {
          ...innerResult,
          reasoning: allReasoning.join('\n'),
          toolCalls: toolCallHistory,
          tokensUsed: totalTokens,
          duration: Date.now() - startTime,
        };
      }

      // 检查是否有 tool_calls（从 raw API 响应中获取）
      const toolCalls = innerResult._toolCalls;
      if (toolCalls && toolCalls.length > 0) {
        // 添加 assistant 消息（含 tool_calls）
        conversation.push({
          role: 'assistant',
          content: innerResult.rawResponse || null,
          tool_calls: toolCalls,
        });

        // 逐个执行工具调用
        for (const tc of toolCalls) {
          const funcName = tc.function?.name ?? tc.name ?? '';
          const funcArgsStr = tc.function?.arguments ?? '{}';

          let args: Record<string, any>;
          try {
            args = JSON.parse(funcArgsStr);
          } catch {
            args = {};
          }

          let toolResult: any;
          let toolError: string | undefined;
          try {
            toolResult = await toolExecutor(funcName, args);
          } catch (e) {
            toolError = e instanceof Error ? e.message : String(e);
            toolResult = null;
          }

          toolCallHistory.push({
            name: funcName,
            arguments: args,
            result: toolError ? { error: toolError } : toolResult,
          });

          // 追加 tool 结果消息
          conversation.push({
            role: 'tool',
            tool_call_id: tc.id ?? '',
            name: funcName,
            content: JSON.stringify(toolError ? { error: toolError } : toolResult),
          });
        }

        // 继续下一轮 — AI 会看到工具结果并决定下一步
        continue;
      }

      // 没有 tool_calls — 这是最终响应
      return {
        agentId: this.agentId,
        output: innerResult.output,
        rawResponse: innerResult.rawResponse,
        reasoning: allReasoning.join('\n'),
        tokensUsed: totalTokens,
        cacheHit: innerResult.cacheHit,
        duration: Date.now() - startTime,
        toolCalls: toolCallHistory,
      };
    }

    // 超出最大轮数
    return {
      agentId: this.agentId,
      output: null,
      rawResponse: '',
      reasoning: allReasoning.join('\n'),
      tokensUsed: totalTokens,
      cacheHit: false,
      duration: Date.now() - startTime,
      error: `Exceeded max tool-calling rounds (${maxRounds})`,
      toolCalls: toolCallHistory,
    };
  }

  private async callOnce(request: ChatRequest, signal?: AbortSignal): Promise<InternalAgentResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const body: Record<string, any> = {
        model: this.endpoint.defaultModel,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 2048,
        top_p: request.topP ?? 1.0,
        frequency_penalty: request.frequencyPenalty ?? 0,
        presence_penalty: request.presencePenalty ?? 0,
        stream: false,
        stop: request.stop,
        user_id: this.userId,
      };

      // 🆕 注入 tools / tool_choice（如果提供）
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.tool_choice ?? 'auto';
      }

      // 🆕 DeepSeek 思考模式
      if (request.reasoning && this.endpoint.provider === 'deepseek') {
        body.thinking = { type: 'enabled' };
      }

      const res = await fetch(`${this.endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      const message = choice?.message;
      const rawResponse: string = message?.content ?? '';
      const reasoningContent: string = message?.reasoning_content ?? '';
      const tokensUsed: number = data.usage?.total_tokens ?? 0;

      // 提取 tool_calls（如果存在）
      const toolCalls = message?.tool_calls;

      // DeepSeek 缓存命中标记
      const cacheHit: boolean =
        data.cache_hit === true ||
        data.usage?.prompt_cache_hit_tokens > 0 ||
        res.headers.get('x-ds-cache-hit') === 'true';

      return {
        agentId: this.agentId,
        output: rawResponse,
        rawResponse,
        reasoning: reasoningContent || undefined,
        tokensUsed,
        cacheHit,
        duration: 0,
        _toolCalls: toolCalls,
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
