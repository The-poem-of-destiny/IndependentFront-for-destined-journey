import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEndpoint } from '../../../src/core/types/types';
import { buildLlmTransportHeaders, fetchLlmModels } from '../../../src/core/api/transport';

function endpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'source-1',
    name: 'source',
    provider: 'openai',
    kind: 'llm',
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1/',
    apiKey: 'secret',
    defaultModel: 'model-a',
    models: [],
    timeout: 30_000,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('LLM transport', () => {
  it('builds only the explicit protocol authentication headers', () => {
    expect(buildLlmTransportHeaders(endpoint(), false)).toMatchObject({
      Authorization: 'Bearer secret',
      'X-Target-Base-URL': 'https://example.test/v1',
    });
    expect(buildLlmTransportHeaders(endpoint({ protocol: 'gemini' }), false)).toMatchObject({
      'x-goog-api-key': 'secret',
    });
    expect(
      buildLlmTransportHeaders(
        endpoint({
          protocol: 'anthropic-messages',
          anthropicVersion: '2023-06-01',
          anthropicBeta: ['tools-2024-04-04'],
        }),
        false,
      ),
    ).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04',
    });
  });

  it('源级自定义请求头打成 X-Custom-Headers 载荷（无自定义头时不出该头）', () => {
    expect(buildLlmTransportHeaders(endpoint(), false)).not.toHaveProperty('X-Custom-Headers');

    const headers = buildLlmTransportHeaders(
      endpoint({ headerOverrides: { 'x-opencode-session': '790766510' } }),
      false,
    );
    expect(decodeURIComponent(headers['X-Custom-Headers'])).toBe(
      '{"x-opencode-session":"790766510"}',
    );
  });

  it('follows provider pagination without treating the model cache as an allow-list', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'models/gemini-a' }], nextPageToken: 'p2' }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'models/gemini-b' }] })),
      );

    await expect(fetchLlmModels(endpoint({ protocol: 'gemini' }))).resolves.toEqual([
      'gemini-a',
      'gemini-b',
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/llm/gemini/models',
      '/api/llm/gemini/models?pageToken=p2',
    ]);
  });
});
