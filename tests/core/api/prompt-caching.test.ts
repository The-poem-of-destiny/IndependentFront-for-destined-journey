import { describe, expect, it } from 'vitest';
import { buildLlmRequest } from '../../../src/core/api/llm-adapter';
import { directCacheUsage } from '../../../src/core/api/prompt-caching';

describe('direct provider cache policy', () => {
  const base = {
    protocol: 'openai-chat' as const,
    model: 'test',
    stream: false,
    userId: 'test',
    messages: [
      { role: 'system' as const, content: 'stable rules' },
      { role: 'user' as const, content: 'current turn' },
    ],
  };
  it('leaves ordinary and generic compatible requests unchanged', () => {
    expect(buildLlmRequest({ ...base, cachePolicy: 'prefix' })).toEqual(buildLlmRequest(base));
  });
  it('only emits explicit OpenAI controls when selected', () => {
    const result = buildLlmRequest({ ...base, cachePolicy: 'openai', cacheKey: 'save:direct' });
    expect(result.body.prompt_cache_key).toBe('save:direct');
    expect(result.body.messages).toEqual(
      base.messages.map((m) => ({ ...m, prompt_cache_breakpoint: { mode: 'explicit' } })),
    );
    expect(() => buildLlmRequest({ ...base, cachePolicy: 'anthropic' })).toThrow('Claude');
  });
  it('marks the Claude fixed prefix and uses automatic conversation caching', () => {
    const result = buildLlmRequest({
      ...base,
      protocol: 'anthropic-messages',
      cachePolicy: 'anthropic',
    });
    expect(result.body.system).toEqual([
      { type: 'text', text: 'stable rules', cache_control: { type: 'ephemeral' } },
    ]);
    expect(result.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(
      buildLlmRequest({
        ...base,
        protocol: 'anthropic-messages',
        cachePolicy: 'anthropic',
        bodyOverrides: { cache_control: { type: 'ephemeral', ttl: '1h' } },
      }).body.cache_control,
    ).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
  it('counts Claude reads and writes as input, preserving unknown usage', () => {
    expect(
      directCacheUsage('anthropic-messages', {
        inputTokens: 50,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        outputTokens: 30,
      }),
    ).toMatchObject({
      inputTokens: 1250,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      cacheMissTokens: 50,
      totalTokens: 1280,
    });
    expect(directCacheUsage('anthropic-messages', {}).inputTokens).toBeUndefined();
    expect(directCacheUsage('anthropic-messages', { inputTokens: 50 })).toMatchObject({
      cacheMissTokens: 50,
      inputTokens: undefined,
      totalTokens: undefined,
    });
    expect(
      directCacheUsage('openai-chat', { inputTokens: 1000, cacheReadTokens: 800 }).cacheMissTokens,
    ).toBe(200);
    expect(directCacheUsage('gemini', { inputTokens: 1000 }).cacheMissTokens).toBeUndefined();
  });
});
