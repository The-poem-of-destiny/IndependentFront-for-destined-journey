/**
 * direct-send.ts — 直出主请求的发送与空正文重发。
 *
 * 从 direct-main.ts 拆出（2026-11-25 整合审查 R2）。不解析输出、不碰缓存会话的提交 / 丢弃：
 * 失败时的会话处置与 DirectTurnError 包装由 direct-main.ts 按 `DirectSendState` 决定。
 */
import type { AgentConfig, AgentProviderRound, AgentResult } from '../types/types';
import type { AgentClient, ChatRequest } from './agent-client';
import type { DirectCacheTicket } from '../prompts/direct-context-session';
import {
  describeEmptyDirectReply,
  isDirectOutputBudgetExhausted,
  isEmptyDirectReply,
} from './direct-output';
import { logEngine } from '../runtime/engine-logger';

/** 空正文自动重发的次数（长度截断不重发）。 */
const DIRECT_EMPTY_REPLY_RETRIES = 1;

/**
 * 发送过程的可观察状态（调用方在 catch 里读）：
 * - `result`：最后一次模型已回复的结果；传输失败或重发途中清空，避免带着上一次结果被包成 DirectTurnError；
 * - `rejected`：模型已回复但输出被拒（空正文、解析失败）—— 缓存会话只丢弃本次尝试，不整体失效。
 */
export interface DirectSendState {
  result?: AgentResult;
  rejected: boolean;
}

/**
 * 发出主请求；可见正文为空时用同一请求（同一张缓存票据，不重新组装上下文）原样重发一次。
 * 返回有正文的结果；provider error 结果、两次都空、取消一律抛出（`state` 记着本次结果）。
 */
export async function sendDirectTurn(
  client: AgentClient,
  request: ChatRequest,
  config: AgentConfig,
  cache: { cached: boolean; ticket?: DirectCacheTicket },
  state: DirectSendState,
): Promise<AgentResult> {
  const { ticket } = cache;
  const rounds: AgentProviderRound[] = [];
  for (let attempt = 0; ; attempt++) {
    const result = await sendDirectRequest(client, request, config, cache.cached);
    state.result = result;
    if (ticket) {
      result.promptSessionRevision = ticket.revision;
      result.promptRebased = !!ticket.rebaseReason;
      result.promptRebaseReason = ticket.rebaseReason;
      result.directCacheDiagnostics = ticket.diagnostics;
    }
    result.agentId = 'direct_main';
    result.requestMessages = request.messages;
    const empty = !result.error && isEmptyDirectReply(result.rawResponse);
    const emptyMessage = empty ? describeEmptyDirectReply(result, attempt > 0) : undefined;
    if (
      empty &&
      attempt < DIRECT_EMPTY_REPLY_RETRIES &&
      !isDirectOutputBudgetExhausted(result.finishReason)
    ) {
      if (config.abortSignal?.aborted)
        throw new DOMException('Direct turn cancelled', 'AbortError');
      rounds.push(directRound(result, attempt + 1, emptyMessage));
      const emptied = {
        attempt: attempt + 1,
        finishReason: result.finishReason ?? null,
        completionTokens: result.completionTokens ?? null,
        reasoningChars: result.reasoning?.length ?? 0,
      };
      logEngine('warn', 'direct.empty_reply', '直出回复没有正文，原样重发一次', () => emptied, {
        agentId: 'direct_main',
      });
      // 清掉上一次结果：重试的传输失败不得带着它被包成 DirectTurnError
      state.result = undefined;
      continue;
    }
    if (rounds.length)
      result.providerRounds = [
        ...rounds,
        directRound(result, rounds.length + 1, result.error ?? emptyMessage),
      ];
    if (result.error) throw new Error(result.error);
    if (emptyMessage) {
      state.rejected = true;
      throw new Error(emptyMessage);
    }
    return result;
  }
}

/** 一次主请求往返的计量快照（只在发生过空正文重发时记录）。 */
function directRound(result: AgentResult, round: number, error?: string): AgentProviderRound {
  return {
    round,
    tokensUsed: result.tokensUsed,
    cacheHit: result.cacheHit,
    cacheHitTokens: result.cacheHitTokens,
    cacheMissTokens: result.cacheMissTokens,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    duration: result.duration,
    finishReason: result.finishReason,
    ...(error ? { error } : {}),
  };
}

/** 发出一次主请求；不解析输出，也不碰缓存会话。 */
function sendDirectRequest(
  client: AgentClient,
  request: ChatRequest,
  config: AgentConfig,
  cached: boolean,
): Promise<AgentResult> {
  if (config.streamCallbacks) {
    return new Promise<AgentResult>((resolve, reject) => {
      void client
        .chatStream(
          request,
          {
            onChunk: config.streamCallbacks!.onChunk,
            onComplete: (stream) => {
              resolve({
                agentId: 'direct_main',
                output: stream.fullText,
                rawResponse: stream.fullText,
                reasoning: stream.reasoning,
                tokensUsed: stream.tokensUsed,
                cacheHit: stream.cacheHit,
                cacheHitTokens: stream.cacheHitTokens,
                cacheMissTokens: stream.cacheMissTokens,
                completionTokens: stream.completionTokens,
                duration: stream.duration,
                finishReason: stream.finishReason,
                ...(cached
                  ? {
                      providerUsage: stream.usage,
                      promptTokens: stream.usage?.inputTokens,
                      tokensUsed: stream.usage?.totalTokens ?? stream.tokensUsed,
                      cacheHitTokens: stream.usage?.cacheReadTokens,
                      cacheMissTokens: stream.usage?.cacheMissTokens,
                    }
                  : {}),
              });
            },
            onError: (error) => {
              config.streamCallbacks!.onError(error);
              reject(new Error(error));
            },
          },
          config.abortSignal,
        )
        .catch(reject);
    });
  }
  return client.chat(request, config.abortSignal);
}
