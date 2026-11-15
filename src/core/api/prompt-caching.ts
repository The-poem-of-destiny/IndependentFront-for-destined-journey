import type {
  DirectCachePolicy,
  JsonObject,
  LlmMessage,
  LlmProtocol,
  NormalizedLlmUsage,
} from '../types/types-api';
import { anthropicBlockLocations } from './anthropic-messages';

/** Only explicit direct-cache callers opt into provider parameters. No model/URL guessing. */
export function applyPromptCaching(
  body: JsonObject,
  input: {
    protocol: LlmProtocol;
    messages: LlmMessage[];
    cachePolicy?: DirectCachePolicy;
    cacheKey?: string;
    /** 消息数组开头有多少条属于静态前缀（缓存直出）；未给时沿用「第一块 + 最后一块」断点。 */
    cacheStaticSystemCount?: number;
    /**
     * 消息数组前多少条会留存进会话（缓存直出）。给了时断点落在最后一条留存消息上，
     * 其后不留存的本轮尾部不打断点：尾部每轮都换，写进缓存下一轮也读不到。
     */
    cacheRetainedMessageCount?: number;
  },
): void {
  if (!input.cachePolicy || input.cachePolicy === 'prefix') return;
  const retainedEnd =
    input.cacheRetainedMessageCount === undefined
      ? undefined
      : Math.min(input.cacheRetainedMessageCount, input.messages.length) - 1;
  if (input.cachePolicy === 'anthropic') {
    if (input.protocol !== 'anthropic-messages')
      throw new Error('Claude 缓存策略需要 Claude Messages 协议');
    const system = input.messages.filter((m) => m.role === 'system' && m.content);
    const breakpoints = new Set<number>([system.length - 1]);
    if (input.cacheStaticSystemCount === undefined) {
      breakpoints.add(0);
    } else {
      // 静态前缀末尾 = 前 N 条消息里非空 system 的条数 - 1（body.system 只收非空 system）
      const staticEnd =
        input.messages
          .slice(0, input.cacheStaticSystemCount)
          .filter((m) => m.role === 'system' && m.content).length - 1;
      if (staticEnd >= 0) breakpoints.add(staticEnd);
    }
    body.system = system.map((m, i) => ({
      type: 'text',
      text: m.content,
      ...(breakpoints.has(i) ? { cache_control: { type: 'ephemeral' } } : {}),
    })) as JsonObject[];
    if (retainedEnd === undefined) {
      body.cache_control = { type: 'ephemeral' };
      return;
    }
    // 显式断点：静态前缀末尾 + 最后一块 system + 留存末尾，共至多 3 个（上限 4）。
    // 不设顶层自动断点：它会落在请求最后一块，也就是不留存的尾部上。
    // 留存末尾与尾部同为 user 时会合并进同一条 Claude 消息，必须按块定位而不是按消息。
    const locations = anthropicBlockLocations(input.messages);
    let index = retainedEnd;
    while (index >= 0 && !locations[index]) index--;
    const location = index >= 0 ? locations[index] : undefined;
    if (location) {
      const blocks = (body.messages as JsonObject[])[location.message].content as JsonObject[];
      blocks[location.block] = { ...blocks[location.block], cache_control: { type: 'ephemeral' } };
    }
  } else {
    if (input.protocol !== 'openai-chat')
      throw new Error('OpenAI 缓存策略需要 Chat Completions 协议');
    body.prompt_cache_key = input.cacheKey ?? 'direct-cache-v1';
    const messages = body.messages as JsonObject[];
    const lastSystem = input.messages.findIndex((m) => m.role !== 'system') - 1;
    // 给了留存条数时，原本打在最后一条消息上的断点改打在最后一条留存消息上
    const tail = retainedEnd ?? messages.length - 1;
    for (const i of new Set([0, lastSystem, tail])) {
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
