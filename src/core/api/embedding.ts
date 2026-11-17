import { scheduleApiRequest } from './api-rpm-limiter';
import type { EmbeddingApiSource, JsonObject } from '../types/types-api';
import { applyBodyParameters } from './body-parameters';
import { buildCustomHeadersValue } from './header-overrides';
import { asObject, finiteNumber } from './adapter-utils';
import { logEngine, registerLogSecret } from '../runtime/engine-logger';
import { redactSecrets } from '../utils/redact-secrets';

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
  const customHeaders = buildCustomHeadersValue(source.headerOverrides);
  registerLogSecret(source.apiKey);
  for (const value of Object.values(source.headerOverrides ?? {})) registerLogSecret(value);
  const startTime = Date.now();
  logEngine('info', 'retrieval.embedding.request', `Embedding 请求：${source.name}`, () => ({
    baseUrl,
    model: body.model ?? source.defaultModel,
    inputCount: Array.isArray(input) ? input.length : 1,
    body,
  }));
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
          ...(customHeaders ? { 'X-Custom-Headers': customHeaders } : {}),
        },
        body: JSON.stringify(body),
        signal,
      }),
  );
  if (!response.ok) {
    const errorText = await response.text();
    logEngine('error', 'retrieval.embedding.error', `Embedding HTTP ${response.status}`, () => ({
      status: response.status,
      durationMs: Date.now() - startTime,
      body: redactSecrets(errorText),
    }));
    throw new Error(`Embedding API ${response.status}: ${errorText.slice(0, 200)}`);
  }
  const result = parseEmbeddingResponse(await response.json());
  // 🔴 不记向量本体：只记维度、数量与 usage
  logEngine('info', 'retrieval.embedding.response', `Embedding 完成：${source.name}`, () => ({
    durationMs: Date.now() - startTime,
    model: result.model,
    dimensions: result.embedding.length,
    vectorCount: Array.isArray(result.raw.data) ? result.raw.data.length : 1,
    usage: result.usage,
  }));
  return result;
}
