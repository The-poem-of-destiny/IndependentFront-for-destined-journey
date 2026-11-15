import type { ToolDefinition } from '../types/types';
import type {
  JsonObject,
  LlmMessage,
  LlmProtocol,
  NativeLlmContent,
  NormalizedLlmResponse,
  NormalizedLlmUsage,
  NormalizedToolCall,
} from '../types/types-api';
import {
  AnthropicStreamAccumulator,
  buildAnthropicBody,
  parseAnthropicResponse,
} from './anthropic-messages';
import { applyBodyParameters } from './body-parameters';
import { buildGeminiBody, GeminiStreamAccumulator, parseGeminiResponse } from './gemini';
import { applyPromptCaching } from './prompt-caching';
import { buildOpenAiBody, OpenAiStreamAccumulator, parseOpenAiResponse } from './openai-chat';

type LlmToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface LlmBuildInput {
  cachePolicy?: import('../types/types-api').DirectCachePolicy;
  cacheKey?: string;
  /** 缓存直出：消息数组开头属于静态前缀的条数，供 Claude 断点定位。 */
  cacheStaticSystemCount?: number;
  /** 缓存直出：消息数组前多少条会留存进会话，供留存末尾断点定位。 */
  cacheRetainedMessageCount?: number;
  protocol: LlmProtocol;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: LlmToolChoice;
  stream: boolean;
  userId: string;
  bodyOverrides?: JsonObject;
  bodyOmitPaths?: readonly string[];
}

export interface BuiltLlmRequest {
  body: JsonObject;
  outputBudget?: number;
  overriddenPaths: string[];
  omittedPaths: string[];
}

export function buildLlmRequest(input: LlmBuildInput): BuiltLlmRequest {
  // Claude 的块位置与请求体出自同一次转换，转交给断点定位
  let anthropic: ReturnType<typeof buildAnthropicBody> | undefined;
  const baseBody =
    input.protocol === 'openai-chat'
      ? buildOpenAiBody(input)
      : input.protocol === 'gemini'
        ? buildGeminiBody(input)
        : (anthropic = buildAnthropicBody(input)).body;
  applyPromptCaching(baseBody, input, anthropic?.locations);
  return applyBodyParameters({
    protocol: input.protocol,
    baseBody,
    bodyOverrides: input.bodyOverrides ?? {},
    bodyOmitPaths: input.bodyOmitPaths ?? [],
  });
}

export function parseLlmResponse(protocol: LlmProtocol, input: unknown): NormalizedLlmResponse {
  if (protocol === 'openai-chat') return parseOpenAiResponse(input);
  if (protocol === 'gemini') return parseGeminiResponse(input);
  return parseAnthropicResponse(input);
}

interface LlmStreamSnapshot {
  fullText: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  usage: NormalizedLlmUsage;
  finishReason?: string;
  nativeAssistant?: NativeLlmContent;
}

export interface LlmStreamEventResult {
  textDelta?: string;
  reasoningDelta?: string;
  toolCall?: { id: string; name: string; arguments: string };
  done?: boolean;
  error?: string;
}

export interface LlmStreamAccumulator {
  accept(data: unknown): LlmStreamEventResult[];
  snapshot(): LlmStreamSnapshot;
  /** True once a provider-native terminal reason/event was received. */
  readonly terminal: boolean;
}

export function createLlmStreamAccumulator(protocol: LlmProtocol): LlmStreamAccumulator {
  if (protocol === 'openai-chat') return new OpenAiStreamAccumulator();
  if (protocol === 'gemini') return new GeminiStreamAccumulator();
  return new AnthropicStreamAccumulator();
}
