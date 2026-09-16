import type { ApiEndpoint } from '../types';
import type { JsonObject, LlmProtocol } from '../types-api';

export interface LlmTransportRequest {
  endpoint: ApiEndpoint;
  body: JsonObject;
  stream: boolean;
  signal: AbortSignal;
}

function protocolFor(endpoint: ApiEndpoint): LlmProtocol {
  const protocol = endpoint.protocol ?? 'openai-chat';
  if (protocol !== 'openai-chat' && protocol !== 'gemini' && protocol !== 'anthropic-messages') {
    throw new Error(`Endpoint ${endpoint.name || endpoint.id} is not an LLM source`);
  }
  if (endpoint.kind !== undefined && endpoint.kind !== 'llm') {
    throw new Error(
      `Endpoint ${endpoint.name || endpoint.id} has kind ${endpoint.kind}, expected llm`,
    );
  }
  return protocol;
}

export function buildLlmTransportHeaders(
  endpoint: ApiEndpoint,
  stream: boolean,
): Record<string, string> {
  const protocol = protocolFor(endpoint);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'X-Target-Base-URL': endpoint.baseUrl.trim().replace(/\/+$/, ''),
    'X-Model-ID': endpoint.defaultModel,
    'X-LLM-Stream': String(stream),
  };
  if (protocol === 'openai-chat') headers.Authorization = `Bearer ${endpoint.apiKey}`;
  if (protocol === 'gemini') headers['x-goog-api-key'] = endpoint.apiKey;
  if (protocol === 'anthropic-messages') {
    headers['x-api-key'] = endpoint.apiKey;
    headers['anthropic-version'] = endpoint.anthropicVersion || '2023-06-01';
    if (endpoint.anthropicBeta?.length) {
      headers['anthropic-beta'] = endpoint.anthropicBeta.join(',');
    }
  }
  return headers;
}

export async function postLlmRequest(request: LlmTransportRequest): Promise<Response> {
  const protocol = protocolFor(request.endpoint);
  return fetch(`/api/llm/${protocol}/generate`, {
    method: 'POST',
    headers: buildLlmTransportHeaders(request.endpoint, request.stream),
    body: JSON.stringify(request.body),
    signal: request.signal,
  });
}

export async function fetchLlmModels(
  endpoint: ApiEndpoint,
  signal?: AbortSignal,
): Promise<string[]> {
  const protocol = protocolFor(endpoint);
  const headers = buildLlmTransportHeaders(endpoint, false);
  const models: string[] = [];
  let pageToken = '';

  // Bound pagination so a malformed provider cannot keep the settings UI in an infinite loop.
  for (let page = 0; page < 20; page++) {
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const response = await fetch(`/api/llm/${protocol}/models${query}`, { headers, signal });
    if (!response.ok) throw new Error(`Model list HTTP ${response.status}`);
    const raw = (await response.json()) as Record<string, unknown>;
    const data = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
    models.push(
      ...data
        .map((item) => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object') return '';
          const row = item as Record<string, unknown>;
          const id = row.id ?? row.name;
          return typeof id === 'string' ? id.replace(/^models\//u, '') : '';
        })
        .filter(Boolean),
    );

    const nextPageToken = raw.nextPageToken;
    if (typeof nextPageToken === 'string' && nextPageToken) {
      pageToken = nextPageToken;
      continue;
    }
    const hasMore = raw.has_more === true;
    const lastId = raw.last_id;
    if (hasMore && typeof lastId === 'string' && lastId) {
      pageToken = lastId;
      continue;
    }
    break;
  }

  return [...new Set(models)];
}
