import { describe, expect, it } from 'vitest';
import { applyBodyParameters, BodyParametersError } from './body-parameters';

describe('applyBodyParameters', () => {
  it('deep-merges objects, replaces arrays/scalars, preserves null, and leaves inputs unchanged', () => {
    const baseBody = {
      temperature: 0.7,
      stop: ['END'],
      generationConfig: { topP: 0.9, maxOutputTokens: 4096 },
    };
    const bodyOverrides = {
      temperature: null,
      stop: ['STOP'],
      generationConfig: { topP: 0.2 },
    };

    const result = applyBodyParameters({ protocol: 'gemini', baseBody, bodyOverrides });

    expect(result.body).toEqual({
      temperature: null,
      stop: ['STOP'],
      generationConfig: { topP: 0.2, maxOutputTokens: 4096 },
    });
    expect(baseBody.generationConfig.topP).toBe(0.9);
    expect(bodyOverrides.generationConfig.topP).toBe(0.2);
    expect(result.outputBudget).toBe(4096);
  });

  it('omits escaped JSON Pointer paths after applying overrides', () => {
    const result = applyBodyParameters({
      protocol: 'openai-chat',
      baseBody: { frequency_penalty: 1, extension: { 'a/b': 2, 'a~b': 3 } },
      bodyOverrides: { frequency_penalty: 0.2 },
      bodyOmitPaths: ['/frequency_penalty', '/extension/a~1b', '/extension/a~0b'],
    });
    expect(result.body).toEqual({ extension: {} });
    expect(result.omittedPaths).toEqual([
      '/frequency_penalty',
      '/extension/a~1b',
      '/extension/a~0b',
    ]);
  });

  it.each([
    ['openai-chat' as const, { messages: [] }],
    ['gemini' as const, { systemInstruction: { parts: [] } }],
    ['anthropic-messages' as const, { tools: [] }],
    ['openai-embeddings' as const, { input: 'replacement' }],
    ['openai-rerank' as const, { documents: [] }],
  ])('rejects protected overrides for %s', (protocol, bodyOverrides) => {
    expect(() => applyBodyParameters({ protocol, baseBody: {}, bodyOverrides })).toThrow(
      BodyParametersError,
    );
  });

  it('rejects protected omissions and array element omission', () => {
    expect(() =>
      applyBodyParameters({
        protocol: 'openai-chat',
        baseBody: { messages: [], stop: ['END'] },
        bodyOmitPaths: ['/messages'],
      }),
    ).toThrow('Cannot omit protected field');
    expect(() =>
      applyBodyParameters({
        protocol: 'openai-chat',
        baseBody: { stop: ['END'] },
        bodyOmitPaths: ['/stop/0'],
      }),
    ).toThrow('Array element omission is not supported');
  });

  it('rejects multi-candidate response shapes before sending', () => {
    expect(() =>
      applyBodyParameters({
        protocol: 'openai-chat',
        baseBody: {},
        bodyOverrides: { n: 2 },
      }),
    ).toThrow('only supports n = 1');
    expect(() =>
      applyBodyParameters({
        protocol: 'gemini',
        baseBody: {},
        bodyOverrides: { generationConfig: { candidateCount: 2 } },
      }),
    ).toThrow('candidateCount = 1');
  });

  it('derives the real output budget after overrides and omissions', () => {
    expect(
      applyBodyParameters({
        protocol: 'openai-chat',
        baseBody: { max_tokens: 4096 },
        bodyOverrides: { max_tokens: 512 },
      }).outputBudget,
    ).toBe(512);
    expect(
      applyBodyParameters({
        protocol: 'openai-chat',
        baseBody: { max_tokens: 4096 },
        bodyOmitPaths: ['/max_tokens'],
      }).outputBudget,
    ).toBeUndefined();
  });
});
