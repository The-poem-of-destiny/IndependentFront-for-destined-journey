import { scheduleApiRequest } from '../api-rpm-limiter';
import type { EmbeddingApiSource, JsonObject } from '../types-api';
import { applyBodyParameters } from './body-parameters';
import { asObject, finiteNumber } from './adapter-utils';

export interface EmbeddingResult {
  embedding: number[];
  model?: string;
  usage: { inputTokens?: number; totalTokens?: number };
  raw: JsonObject;
}

export function buildEmbeddingBody(
  source: EmbeddingApiSource,
  input: string | string[],
): JsonObject {
  return applyBodyParameters({
    protocol: source.protocol,
    baseBody: { model: source.defaultModel, input },
    bodyOverrides: source.bodyOverrides,
    bodyOmitPaths: source.bodyOmitPaths,
  }).body;
}

export function parseEmbeddingResponse(value: unknown): EmbeddingResult {
  const raw = asObject(value, 'Embedding response');
  const data = Array.isArray(raw.data) ? raw.data : [];
  const first = data[0] && typeof data[0] === 'object' ? asObject(data[0], 'data[0]') : {};
  if (!Array.isArray(first.embedding)) throw new Error('Embedding API 返回数据格式异常');
  if (
    first.embedding.length === 0 ||
    first.embedding.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    throw new Error('Embedding 响应向量非法: 必须是非空有限数数组');
  }
  const usage = raw.usage && typeof raw.usage === 'object' ? asObject(raw.usage, 'usage') : {};
  return {
    embedding: first.embedding as number[],
    model: typeof raw.model === 'string' ? raw.model : undefined,
    usage: {
      inputTokens: finiteNumber(usage.prompt_tokens),
      totalTokens: finiteNumber(usage.total_tokens),
    },
    raw,
  };
}

export async function requestEmbedding(
  source: EmbeddingApiSource,
  input: string | string[],
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  const body = buildEmbeddingBody(source, input);
  const baseUrl = source.baseUrl.replace(/\/+$/u, '');
  const response = await scheduleApiRequest(
    { baseUrl, apiKey: source.apiKey, label: source.name },
    signal,
    () =>
      fetch('/api/embeddings', {
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
    throw new Error(`Embedding API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return parseEmbeddingResponse(await response.json());
}
