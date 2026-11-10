import type {
  DirectCachePolicy,
  JsonObject,
  LlmMessage,
  LlmProtocol,
  NormalizedLlmUsage,
} from '../types/types-api';

/** Only explicit direct-cache callers opt into provider parameters. No model/URL guessing. */
export function applyPromptCaching(
  body: JsonObject,
  input: {
    protocol: LlmProtocol;
    messages: LlmMessage[];
    cachePolicy?: DirectCachePolicy;
    cacheKey?: string;
  },
): void {
  if (!input.cachePolicy || input.cachePolicy === 'prefix') return;
  if (input.cachePolicy === 'anthropic') {
    if (input.protocol !== 'anthropic-messages')
      throw new Error('Claude 缓存策略需要 Claude Messages 协议');
    const system = input.messages.filter((m) => m.role === 'system' && m.content);
    body.system = system.map((m, i) => ({
      type: 'text',
      text: m.content,
      ...(i === 0 || i === system.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    })) as JsonObject[];
    body.cache_control = { type: 'ephemeral' };
  } else {
    if (input.protocol !== 'openai-chat')
      throw new Error('OpenAI 缓存策略需要 Chat Completions 协议');
    body.prompt_cache_key = input.cacheKey ?? 'direct-cache-v1';
    const messages = body.messages as JsonObject[];
    const lastSystem = input.messages.findIndex((m) => m.role !== 'system') - 1;
    for (const i of new Set([0, lastSystem, messages.length - 1])) {
      if (i >= 0 && messages[i]) messages[i].prompt_cache_breakpoint = { mode: 'explicit' };
    }
  }
}

export function directCacheUsage(
  protocol: LlmProtocol,
  usage: NormalizedLlmUsage,
): NormalizedLlmUsage {
  if (protocol !== 'anthropic-messages')
    return {
      ...usage,
      cacheMissTokens:
        usage.cacheMissTokens ??
        (usage.inputTokens !== undefined && usage.cacheReadTokens !== undefined
          ? usage.inputTokens - usage.cacheReadTokens
          : undefined),
    };
  const inputTokens =
    usage.inputTokens === undefined ||
    usage.cacheReadTokens === undefined ||
    usage.cacheWriteTokens === undefined
      ? undefined
      : usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    ...usage,
    inputTokens,
    cacheMissTokens: usage.inputTokens,
    totalTokens:
      inputTokens === undefined || usage.outputTokens === undefined
        ? undefined
        : inputTokens + usage.outputTokens,
  };
}
