import { scheduleApiRequest } from '../api-rpm-limiter';
import type { JsonObject, RerankerApiSource } from '../types-api';
import { applyBodyParameters } from './body-parameters';
import { asObject } from './adapter-utils';

export interface RerankScore {
  index: number;
  relevanceScore: number;
}

export function buildRerankerBody(
  source: RerankerApiSource,
  query: string,
  documents: string[],
  topN?: number,
): JsonObject {
  const base: JsonObject = { model: source.defaultModel, query, documents };
  if (topN !== undefined) base.top_n = topN;
  return applyBodyParameters({
    protocol: source.protocol,
    baseBody: base,
    bodyOverrides: source.bodyOverrides,
    bodyOmitPaths: source.bodyOmitPaths,
  }).body;
}

export function parseRerankerResponse(value: unknown, documentCount: number): RerankScore[] {
  const raw = asObject(value, 'Reranker response');
  if (!Array.isArray(raw.results)) throw new Error('Reranker response has no results array');
  if (documentCount > 0 && raw.results.length === 0) {
    throw new Error('Reranker returned an empty result set');
  }
  const seen = new Set<number>();
  return raw.results.map((entry, position) => {
    const row = asObject(entry, `results[${position}]`);
    const index = row.index;
    const score = row.relevance_score;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= documentCount) {
      throw new Error(`Reranker returned invalid index at results[${position}]`);
    }
    if (seen.has(index as number)) throw new Error(`Reranker returned duplicate index ${index}`);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`Reranker returned invalid score at results[${position}]`);
    }
    seen.add(index as number);
    return { index: index as number, relevanceScore: score };
  });
}

export function applyRerank<T>(
  candidates: readonly T[],
  scores: readonly RerankScore[],
  limit: number,
): T[] {
  const picked = new Set<number>();
  const output: T[] = [];
  for (const score of scores) {
    if (output.length >= limit) break;
    picked.add(score.index);
    output.push(candidates[score.index]);
  }
  for (let index = 0; index < candidates.length && output.length < limit; index++) {
    if (!picked.has(index)) output.push(candidates[index]);
  }
  return output;
}

export async function requestRerank(
  source: RerankerApiSource,
  query: string,
  documents: string[],
  topN?: number,
  signal?: AbortSignal,
): Promise<RerankScore[]> {
  const body = buildRerankerBody(source, query, documents, topN);
  const baseUrl = source.baseUrl.replace(/\/+$/u, '');
  const response = await scheduleApiRequest(
    { baseUrl, apiKey: source.apiKey, label: source.name },
    signal,
    () =>
      fetch('/api/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': baseUrl,
          Authorization: `Bearer ${source.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      }),
  );
  if (!response.ok)
    throw new Error(`Reranker API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return parseRerankerResponse(await response.json(), documents.length);
}
