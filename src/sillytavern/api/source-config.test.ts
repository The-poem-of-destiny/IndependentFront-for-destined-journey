import { describe, expect, it } from 'vitest';
import { ApiSourceValidationError, parseApiSource } from './source-config';

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
});
