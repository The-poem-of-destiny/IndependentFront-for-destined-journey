import { describe, expect, it } from 'vitest';
import type { EmbeddingApiSource, RerankerApiSource } from '../types-api';
import { buildEmbeddingBody, parseEmbeddingResponse } from './embedding';
import { applyRerank, buildRerankerBody, parseRerankerResponse } from './reranker';

const common = {
  id: 'source',
  name: 'source',
  baseUrl: 'https://api.example/v1',
  apiKey: 'secret',
  defaultModel: 'model',
  models: ['model'],
  timeoutMs: 1000,
  bodyOverrides: {},
  bodyOmitPaths: [],
};

describe('retrieval adapters', () => {
  it('builds and parses embeddings while protecting input', () => {
    const source: EmbeddingApiSource = {
      ...common,
      kind: 'embedding',
      protocol: 'openai-embeddings',
      bodyOverrides: { dimensions: 3 },
    };
    expect(buildEmbeddingBody(source, 'text')).toEqual({
      model: 'model',
      input: 'text',
      dimensions: 3,
    });
    expect(
      parseEmbeddingResponse({ data: [{ embedding: [1, 2, 3] }], usage: { total_tokens: 5 } }),
    ).toMatchObject({ embedding: [1, 2, 3], usage: { totalTokens: 5 } });
  });

  it('validates reranker indices and fills partial results from original order', () => {
    const source: RerankerApiSource = {
      ...common,
      kind: 'reranker',
      protocol: 'openai-rerank',
      bodyOverrides: { return_documents: false },
    };
    expect(buildRerankerBody(source, 'q', ['a', 'b', 'c'], 2)).toMatchObject({
      query: 'q',
      documents: ['a', 'b', 'c'],
      top_n: 2,
      return_documents: false,
    });
    const scores = parseRerankerResponse({ results: [{ index: 2, relevance_score: 0.9 }] }, 3);
    expect(applyRerank(['a', 'b', 'c'], scores, 3)).toEqual(['c', 'a', 'b']);
    expect(() =>
      parseRerankerResponse(
        {
          results: [
            { index: 0, relevance_score: 1 },
            { index: 0, relevance_score: 0.5 },
          ],
        },
        2,
      ),
    ).toThrow('duplicate');
  });
});
