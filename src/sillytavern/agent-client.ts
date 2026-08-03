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
  model?: string;
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

// ========== Streaming Types ==========

const POST_FINISH_GRACE_MS = 1000;

/** 流式响应回调集合 */
export interface StreamCallbacks {
  /** 增量文本块（delta），isComplete 在最后一块为 true */
  onChunk: (text: string, isComplete: boolean) => void;
  /** 工具调用增量（name + 当前已累积的 arguments JSON 字符串） */
  onToolCall?: (toolCall: { id: string; name: string; arguments: string }) => void;
  /** 流式完成，携带最终累积状态 */
  onComplete: (result: {
    fullText: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }>;
    reasoning: string;
    tokensUsed: number;
    cacheHit: boolean;
    cacheHitTokens: number;
    cacheMissTokens: number;
    completionTokens: number;
    duration: number;
  }) => void;
  /** 流式传输中的错误 */
  onError: (error: string) => void;
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

  /** 标准化 baseUrl：去掉尾斜杠，避免拼接时出现双斜杠 */
  private get baseUrl(): string {
    return this.endpoint.baseUrl.trim().replace(/\/$/, '');
  }

  /**
   * 每 Agent 独立 userId — DeepSeek KVCache 缓存隔离的关键。
   *
   * 🔴 2026-08-02 修: **不再含 saveId**，只按 agent 区分。
   * 此前 `fp|saveId|agentId` 让每个存档都有不同 userId → DeepSeek KVCache 跨存档
   * 完全 miss（文档: user_id 参与缓存隔离），开新档每次全价重算（~0.5 元/次）。
   * 改成 `fp|agentId` 后同一 agent 的缓存跨存档复用（systemPrompt 静态前缀命中）。
   */
  get userId(): string {
    return `fp|${this.agentId}`;
  }

  /**
   * 确保 messages 至少包含一条 user 消息。
   *
   * 修复(2026-07-30): 部分 API（如 ollama.com）当 messages 只有 system 消息时
   * 返回 finish_reason="load" 和空内容（模型不加载），导致所有 agent 空回。
   * 当 messages 全是 system 时追加一条空 user 消息以触发正常生成。
   */
  private ensureUserMessage(messages: ChatRequest['messages']): ChatRequest['messages'] {
    if (messages.length === 0) return messages;
    const hasUser = messages.some((m) => m.role === 'user');
    if (hasUser) return messages;
    return [...messages, { role: 'user', content: '' }];
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
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }

    return {
      agentId: this.agentId,
      output: null,
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      completionTokens: 0,
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
    let totalCacheHitTokens = 0;
    let totalCacheMissTokens = 0;
    let totalCompletionTokens = 0;
    const allReasoning: string[] = []; // 跨轮次收集 reasoning

    for (let round = 0; round < maxRounds; round++) {
      const roundRequest: ChatRequest = {
        ...request,
        messages: conversation,
        tools: request.tools,
        tool_choice: request.tool_choice,
      };

      const innerResult = await this.chat(roundRequest, options.signal);
      totalTokens += innerResult.tokensUsed;
      totalCacheHitTokens += innerResult.cacheHitTokens ?? 0;
      totalCacheMissTokens += innerResult.cacheMissTokens ?? 0;
      totalCompletionTokens += innerResult.completionTokens ?? 0;

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
          cacheHitTokens: totalCacheHitTokens,
          cacheMissTokens: totalCacheMissTokens,
          completionTokens: totalCompletionTokens,
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
        cacheHitTokens: totalCacheHitTokens,
        cacheMissTokens: totalCacheMissTokens,
        completionTokens: totalCompletionTokens,
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
      cacheHitTokens: totalCacheHitTokens,
      cacheMissTokens: totalCacheMissTokens,
      completionTokens: totalCompletionTokens,
      duration: Date.now() - startTime,
      error: `Exceeded max tool-calling rounds (${maxRounds})`,
      toolCalls: toolCallHistory,
    };
  }

  /**
   * 流式 chat completion 请求。
   *
   * 发送 `stream: true`，通过 ReadableStream 解析 SSE 块，
   * 逐块回调 onChunk / onToolCall，最终回调 onComplete。
   *
   * @param request ChatRequest（messages/temperature/tools 等）
   * @param callbacks StreamCallbacks（onChunk / onToolCall / onComplete / onError）
   * @param signal 可选的 AbortSignal 用于外部取消
   */
  async chatStream(
    request: ChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const startTime = Date.now();
    let settled = false;
    let postFinishTimer: ReturnType<typeof setTimeout> | undefined;

    const clearPostFinishTimer = () => {
      if (postFinishTimer === undefined) return;
      clearTimeout(postFinishTimer);
      postFinishTimer = undefined;
    };

    const settleError = (message: string) => {
      if (settled) return;
      settled = true;
      clearPostFinishTimer();
      callbacks.onError(message);
    };

    const controller = new AbortController();
    let abortedByTimeout = false;
    // 流式超时：首字节等待期用 this.timeout * 3（流式请求含模型加载 + 大上下文处理，
    // ollama.com 等云端 API 首字节延迟可能 >120s）。收到首个 chunk 后清除超时
    // （数据在流动说明请求活着，不应因总时长超限而中断长文本生成）
    const streamTimeout = this.timeout * 3;
    const timeoutId = setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, streamTimeout);

    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const model = request.model || this.endpoint.defaultModel;
      const body: Record<string, any> = {
        model,
        messages: this.ensureUserMessage(request.messages),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 16384, // 真机修(2026-07-17): 侧链 request 不带 maxTokens，2048 兜底会截断 char_gen 思考链+XML → 静默解析失败
        top_p: request.topP ?? 1.0,
        frequency_penalty: request.frequencyPenalty ?? 0,
        presence_penalty: request.presencePenalty ?? 0,
        stream: true,
        stream_options: { include_usage: true }, // 🆕 让流式末尾 chunk 返回 usage（DeepSeek 命中/未命中/输出 token），否则流式永远拿不到 usage
        stop: request.stop,
        user_id: this.userId,
      };

      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.tool_choice ?? 'auto';
      }

      // 🆕 思考模式控制（与 callOnce 对齐，详见该处注释）
      if (this.endpoint.enableThinking) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'high';
      } else {
        body.thinking = { type: 'disabled' };
      }

      const res = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': this.baseUrl,
          Authorization: `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.error(
          '[AgentClient] API error — status:',
          res.status,
          'body:',
          errorText.slice(0, 500),
        );
        console.error('[AgentClient] Request model:', body.model, 'has model:', !!body.model);
        throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable (no ReadableStream)');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let fullReasoning = '';
      let tokensUsed = 0;
      let cacheHit = false;
      let cacheHitTokens = 0;
      let cacheMissTokens = 0;
      let completionTokens = 0;
      let sawFinishReason = false;

      // Accumulate tool calls by index
      const toolCallAccum: Map<number, { id: string; name: string; arguments: string }> = new Map();

      const complete = () => {
        if (settled) return;
        settled = true;
        clearPostFinishTimer();

        const toolCalls: Array<{
          id: string;
          name: string;
          arguments: Record<string, any>;
        }> = [];
        for (const [, acc] of toolCallAccum) {
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = JSON.parse(acc.arguments || '{}');
          } catch {
            parsedArgs = {};
          }
          toolCalls.push({
            id: acc.id,
            name: acc.name,
            arguments: parsedArgs,
          });
        }

        try {
          callbacks.onChunk(fullText, true);
        } finally {
          callbacks.onComplete({
            fullText,
            toolCalls,
            reasoning: fullReasoning,
            tokensUsed,
            cacheHit,
            cacheHitTokens,
            cacheMissTokens,
            completionTokens,
            duration: Date.now() - startTime,
          });
        }
      };

      const armPostFinishTimer = () => {
        clearPostFinishTimer();
        postFinishTimer = setTimeout(() => {
          if (settled) return;
          void reader.cancel().catch(() => undefined);
          controller.abort();
          complete();
        }, POST_FINISH_GRACE_MS);
      };

      const processData = (dataStr: string) => {
        if (dataStr === '[DONE]') {
          complete();
          return;
        }

        let chunk: any;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          // Skip unparseable chunks gracefully
          return;
        }

        if (typeof chunk.usage?.total_tokens === 'number') {
          tokensUsed = chunk.usage.total_tokens;
        }
        if (typeof chunk.usage?.prompt_cache_hit_tokens === 'number') {
          cacheHitTokens = chunk.usage.prompt_cache_hit_tokens;
        }
        if (typeof chunk.usage?.prompt_cache_miss_tokens === 'number') {
          cacheMissTokens = chunk.usage.prompt_cache_miss_tokens;
        }
        if (typeof chunk.usage?.completion_tokens === 'number') {
          completionTokens = chunk.usage.completion_tokens;
        }

        if (chunk.cache_hit === true || chunk.usage?.prompt_cache_hit_tokens > 0) {
          cacheHit = true;
        }

        const delta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;

        if (delta) {
          if (delta.content) {
            fullText += delta.content;
            callbacks.onChunk(delta.content, false);
          }

          if (delta.reasoning_content) {
            fullReasoning += delta.reasoning_content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;

              let acc = toolCallAccum.get(idx);
              if (!acc) {
                acc = { id: '', name: '', arguments: '' };
                toolCallAccum.set(idx, acc);
              }

              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments;
              }

              callbacks.onToolCall?.({
                id: acc.id,
                name: acc.name,
                arguments: acc.arguments,
              });
            }
          }
        }

        if (finishReason !== null && finishReason !== undefined) {
          sawFinishReason = true;
        }
        if (sawFinishReason) {
          armPostFinishTimer();
        }
      };

      const processEvent = (event: string) => {
        if (!event.trim() || settled) return;

        const dataLines: string[] = [];
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) {
          processData(dataLines.join('\n'));
        }
      };

      const processCompleteEvents = () => {
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const event of events) {
          processEvent(event);
          if (settled) break;
        }
      };

      try {
        let firstChunkReceived = false;
        while (!settled) {
          // Check for external abort between reads
          if (signal?.aborted) {
            throw new DOMException('Aborted by external signal', 'AbortError');
          }

          const { done, value } = await reader.read();
          if (done) break;

          // 收到首个数据块后清除超时 — 流式响应只要数据在流动就不应超时
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            clearTimeout(timeoutId);
          }

          buffer += decoder.decode(value, { stream: true });
          processCompleteEvents();
        }

        if (!settled) {
          buffer += decoder.decode();
          processCompleteEvents();
          if (buffer.trim()) {
            processEvent(buffer);
            buffer = '';
          }
        }

        if (!settled) {
          if (sawFinishReason) {
            complete();
          } else {
            settleError('Stream ended unexpectedly before completion');
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (abortedByTimeout) {
          settleError(
            `请求超时（${Math.round(streamTimeout / 1000)}秒内未收到响应），请重试或减少上下文注入`,
          );
        } else {
          settleError('Request aborted');
        }
      } else {
        settleError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      clearTimeout(timeoutId);
      clearPostFinishTimer();
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async callOnce(request: ChatRequest, signal?: AbortSignal): Promise<InternalAgentResult> {
    const controller = new AbortController();
    let abortedByTimeout = false;
    const timeoutId = setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, this.timeout);

    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const model = request.model || this.endpoint.defaultModel;
      const body: Record<string, any> = {
        model,
        messages: this.ensureUserMessage(request.messages),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 16384, // 真机修(2026-07-17): 侧链 request 不带 maxTokens，2048 兜底会截断 char_gen 思考链+XML → 静默解析失败
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

      // 🆕 思考模式控制：
      // - enableThinking=true → 开启思考（DeepSeek: thinking + reasoning_effort=high；Ollama: 默认开启）
      // - enableThinking=false → 显式关闭思考（thinking.type=disabled）
      //   关键修复(2026-07-30): Ollama 思考模型（glm-5.2 等）默认开启 thinking，且 think:false
      //   在 /v1/chat/completions 上被静默忽略（ollama#14820）。若不显式关闭，思考会耗尽
      //   max_tokens 导致 content 永远为空 → 所有 agent 输出空白。
      //   注意: 不用 reasoning_effort=none，因为非思考模型（如 deepseek-v4-flash）
      //   不认识 'none'（只认 high/low/medium/max/xhigh），会报 HTTP 400。
      //   改用标准 OpenAI 字段 thinking.type=disabled 关闭，兼容性更好。
      if (this.endpoint.enableThinking) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'high';
      } else {
        body.thinking = { type: 'disabled' };
      }

      const res = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': this.baseUrl,
          Authorization: `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.error(
          '[AgentClient] API error — status:',
          res.status,
          'body:',
          errorText.slice(0, 500),
        );
        console.error('[AgentClient] Request model:', body.model, 'has model:', !!body.model);
        throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }

      const raw = await res.json();
      // Cline 网关(api.cline.bot)把非流式响应整个包在顶层 data 里（流式 chunk 是标准形态）。
      // 顶层无 choices 而 data.choices 存在时解包；标准 OpenAI 网关不受影响。
      const data = !raw.choices && raw.data?.choices ? raw.data : raw;
      const choice = data.choices?.[0];
      const message = choice?.message;
      const rawResponse: string = message?.content ?? '';
      const reasoningContent: string = message?.reasoning_content ?? '';
      const tokensUsed: number = data.usage?.total_tokens ?? 0;
      // 🆕 缓存命中/未命中/输出 token 明细（缺失当 0）
      const cacheHitTokens: number = data.usage?.prompt_cache_hit_tokens ?? 0;
      const cacheMissTokens: number = data.usage?.prompt_cache_miss_tokens ?? 0;
      const completionTokens: number = data.usage?.completion_tokens ?? 0;

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
        cacheHitTokens,
        cacheMissTokens,
        completionTokens,
        duration: 0,
        _toolCalls: toolCalls,
      };
    } catch (e) {
      // 真机修(2026-07-21): 非流式路径原先只有 try/finally 无 catch，浏览器原生
      // "The user aborted a request." 直接冒泡 → 用户看不懂。翻译成友好信息（区分超时/外部取消）。
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (abortedByTimeout) {
          throw new Error(
            `请求超时（${Math.round(this.timeout / 1000)}秒内未收到完整响应），请重试或减少上下文注入`,
          );
        }
        throw new Error('请求已取消');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ========== UserId 工具函数 ==========

/**
 * 构建 userId —— 只按 agent 区分，不区分存档。
 *
 * 🔴 2026-08-02 修: 去掉 saveId。此前 `fp|saveId|agentId` 导致 DeepSeek KVCache
 * 跨存档全 miss（user_id 参与缓存隔离），开新档每次全价重算。现在同一 agent
 * 的缓存跨存档复用。
 */
export function buildUserId(saveId: string, agentId: string): string {
  // saveId 参数保留以兼容调用方；实际返回只含 agentId
  void saveId;
  return `fp|${agentId}`;
}

/** 从 userId 解析 agentId（saveId 已废弃 —— 2026-08-02 起 userId 不再区分存档） */
export function parseUserId(userId: string): { saveId: string; agentId: string } | null {
  const parts = userId.split('|');
  if (parts[0] !== 'fp') return null;
  if (parts.length === 3) {
    // 兼容旧格式 fp|saveId|agentId（老数据回溯）
    return { saveId: parts[1], agentId: parts[2] };
  }
  if (parts.length === 2) {
    // 新格式 fp|agentId
    return { saveId: '', agentId: parts[1] };
  }
  return null;
}
