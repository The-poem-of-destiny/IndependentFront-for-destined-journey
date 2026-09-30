import { describe, expect, it } from 'vitest';
import { ApiSourceValidationError, parseApiSource } from '../../../src/core/api/source-config';
import type { LlmApiSource } from '../../../src/core/types/types-api';

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'primary',
    name: 'Primary',
    kind: 'llm',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'secret',
    defaultModel: 'model-a',
    models: ['model-a'],
    timeoutMs: 30_000,
    bodyOverrides: {},
    bodyOmitPaths: [],
    ...overrides,
  };
}

describe('parseApiSource', () => {
  it('normalizes a valid source without guessing its protocol', () => {
    expect(parseApiSource(source())).toMatchObject({
      kind: 'llm',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      timeoutMs: 30_000,
    });
  });

  it.each([
    { kind: 'llm', protocol: 'openai-embeddings' },
    { kind: 'embedding', protocol: 'openai-rerank' },
    { kind: 'reranker', protocol: 'gemini' },
  ])('rejects a kind/protocol mismatch: %o', (overrides) => {
    expect(() => parseApiSource(source(overrides))).toThrow(ApiSourceValidationError);
  });

  it('rejects unknown protocols instead of silently treating them as chat', () => {
    expect(() => parseApiSource(source({ protocol: 'future-provider' }))).toThrow(
      'Unsupported API protocol',
    );
  });

  it('rejects dangerous keys at any nesting level', () => {
    const body = JSON.parse('{"safe":{"constructor":{"x":1}}}');
    expect(() => parseApiSource(source({ bodyOverrides: body }))).toThrow('is not allowed');
  });

  it('returns detached JSON configuration', () => {
    const overrides = { generationConfig: { temperature: 0.2 } };
    const parsed = parseApiSource(source({ protocol: 'gemini', bodyOverrides: overrides }));
    (overrides.generationConfig as { temperature: number }).temperature = 1;
    expect(parsed.bodyOverrides).toEqual({ generationConfig: { temperature: 0.2 } });
  });

  it('headerOverrides 缺省为 {}，合法自定义头保留', () => {
    expect(parseApiSource(source()).headerOverrides).toEqual({});
    expect(
      parseApiSource(source({ headerOverrides: { 'x-opencode-session': '790' } })).headerOverrides,
    ).toEqual({ 'x-opencode-session': '790' });
  });

  it('headerOverrides 拒绝受保护头名与非法值', () => {
    expect(() => parseApiSource(source({ headerOverrides: { Authorization: 'x' } }))).toThrow();
    expect(() => parseApiSource(source({ headerOverrides: { 'x-a': 'a\nb' } }))).toThrow();
  });

  it('LLM 源的 defaultParameters 只认有限数字的五个键，全空 → undefined', () => {
    const parseLlm = (overrides: Record<string, unknown> = {}): LlmApiSource => {
      const parsed = parseApiSource(source(overrides));
      if (parsed.kind !== 'llm') throw new Error('expected an LLM source');
      return parsed;
    };
    expect(parseLlm().defaultParameters).toBeUndefined();
    expect(
      parseLlm({
        defaultParameters: {
          temperature: 1.2,
          topP: 0.9,
          frequencyPenalty: 0.1,
          presencePenalty: -0.3,
          maxTokens: 8192,
          unknownKey: 5,
        },
      }).defaultParameters,
    ).toEqual({
      temperature: 1.2,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: -0.3,
      maxTokens: 8192,
    });
    expect(() => parseApiSource(source({ defaultParameters: { temperature: 'hot' } }))).toThrow(
      'finite number',
    );
    expect(() => parseApiSource(source({ defaultParameters: 42 }))).toThrow('JSON object');
  });
});
