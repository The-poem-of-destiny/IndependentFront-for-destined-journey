import type { JsonObject, NormalizedLlmResponse } from '../types-api';
import type { LlmBuildInput, LlmStreamAccumulator, LlmStreamEventResult } from './llm-adapter';
import { asObject, finiteNumber, parseToolArguments } from './adapter-utils';

function cacheReadTokens(usage: JsonObject): number | undefined {
  const details =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? asObject(usage.prompt_tokens_details, 'prompt_tokens_details')
      : {};
  return finiteNumber(details.cached_tokens);
}

export function buildOpenAiBody(input: LlmBuildInput): JsonObject {
  const body: JsonObject = {
    model: input.model,
    messages: input.messages.map(({ native: _native, ...message }) => message) as never,
    temperature: input.temperature ?? 0.7,
    max_tokens: input.maxTokens ?? 65_536,
    top_p: input.topP ?? 1,
    frequency_penalty: input.frequencyPenalty ?? 0,
    presence_penalty: input.presencePenalty ?? 0,
    stream: input.stream,
    user_id: input.userId,
  };
  if (input.stop !== undefined) body.stop = input.stop;
  if (input.stream) body.stream_options = { include_usage: true };
  if (input.tools?.length) {
    body.tools = input.tools as never;
    body.tool_choice = (input.toolChoice ?? 'auto') as never;
  }
  return body;
}

export function parseOpenAiResponse(input: unknown): NormalizedLlmResponse {
  const raw = asObject(input, 'OpenAI response');
  const unwrapped =
    !Array.isArray(raw.choices) && raw.data && typeof raw.data === 'object'
      ? asObject(raw.data, 'OpenAI response.data')
      : raw;
  const choice = Array.isArray(unwrapped.choices) ? unwrapped.choices[0] : undefined;
  const choiceObject = choice && typeof choice === 'object' ? asObject(choice, 'choice') : {};
  const message =
    choiceObject.message && typeof choiceObject.message === 'object'
      ? asObject(choiceObject.message, 'message')
      : {};
  const usage =
    unwrapped.usage && typeof unwrapped.usage === 'object'
      ? asObject(unwrapped.usage, 'usage')
      : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((value, index) => {
        const call = asObject(value, `tool_calls[${index}]`);
        const fn = call.function ? asObject(call.function, 'tool function') : {};
        return {
          id: typeof call.id === 'string' ? call.id : `openai-tool-${index}`,
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: parseToolArguments(fn.arguments),
        };
      })
    : [];
  return {
    text: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls,
    finishReason:
      typeof choiceObject.finish_reason === 'string' ? choiceObject.finish_reason : undefined,
    usage: {
      inputTokens: finiteNumber(usage.prompt_tokens),
      outputTokens: finiteNumber(usage.completion_tokens),
      totalTokens: finiteNumber(usage.total_tokens),
      cacheHit: unwrapped.cache_hit === true,
      cacheReadTokens: cacheReadTokens(usage),
      cacheMissTokens: finiteNumber(usage.prompt_cache_miss_tokens),
    },
    nativeAssistant: {
      protocol: 'openai-chat',
      value: message,
    },
    raw: unwrapped,
  };
}

export class OpenAiStreamAccumulator implements LlmStreamAccumulator {
  terminal = false;
  private fullText = '';
  private reasoning = '';
  private finishReason: string | undefined;
  private usage: Record<string, number | undefined> = {};
  private calls = new Map<number, { id: string; name: string; arguments: string }>();

  accept(value: unknown): LlmStreamEventResult[] {
    const chunk = asObject(value, 'OpenAI stream event');
    const out: LlmStreamEventResult[] = [];
    const usage =
      chunk.usage && typeof chunk.usage === 'object' ? asObject(chunk.usage, 'usage') : {};
    this.usage = {
      inputTokens: finiteNumber(usage.prompt_tokens) ?? this.usage.inputTokens,
      outputTokens: finiteNumber(usage.completion_tokens) ?? this.usage.outputTokens,
      totalTokens: finiteNumber(usage.total_tokens) ?? this.usage.totalTokens,
      cacheReadTokens: cacheReadTokens(usage) ?? this.usage.cacheReadTokens,
      cacheMissTokens: finiteNumber(usage.prompt_cache_miss_tokens) ?? this.usage.cacheMissTokens,
    };
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice || typeof choice !== 'object') return out;
    const choiceObject = asObject(choice, 'choice');
    const delta =
      choiceObject.delta && typeof choiceObject.delta === 'object'
        ? asObject(choiceObject.delta, 'delta')
        : {};
    if (typeof delta.content === 'string' && delta.content) {
      this.fullText += delta.content;
      out.push({ textDelta: delta.content });
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      this.reasoning += delta.reasoning_content;
      out.push({ reasoningDelta: delta.reasoning_content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls) {
        const call = asObject(item, 'tool call delta');
        const index = finiteNumber(call.index) ?? 0;
        const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
        const fn =
          call.function && typeof call.function === 'object'
            ? asObject(call.function, 'function')
            : {};
        if (typeof call.id === 'string') current.id = call.id;
        if (typeof fn.name === 'string') current.name += fn.name;
        if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
        this.calls.set(index, current);
        out.push({ toolCall: { ...current } });
      }
    }
    if (typeof choiceObject.finish_reason === 'string') {
      this.finishReason = choiceObject.finish_reason;
      this.terminal = true;
    }
    return out;
  }

  snapshot() {
    const toolCalls = [...this.calls.values()];
    const content: JsonObject = { role: 'assistant', content: this.fullText || null };
    if (toolCalls.length) {
      content.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })) as never;
    }
    return {
      fullText: this.fullText,
      reasoning: this.reasoning,
      toolCalls,
      usage: this.usage,
      finishReason: this.finishReason,
      nativeAssistant: { protocol: 'openai-chat' as const, value: content },
    };
  }
}
