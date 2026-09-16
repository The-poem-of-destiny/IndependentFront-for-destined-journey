import type { ApiProtocol, ApiSource, ApiSourceKind, JsonObject, JsonValue } from '../types-api';

const DEFAULT_API_TIMEOUT_MS = 60_000;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PROTOCOL_KIND: Readonly<Record<ApiProtocol, ApiSourceKind>> = {
  'openai-chat': 'llm',
  gemini: 'llm',
  'anthropic-messages': 'llm',
  'openai-embeddings': 'embedding',
  'openai-rerank': 'reranker',
};

export class ApiSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiSourceValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiSourceValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ApiSourceValidationError(`${key} must be a positive integer`);
  }
  return value as number;
}

function copyJson(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'number') {
    throw new ApiSourceValidationError(`${path} contains a non-finite number`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new ApiSourceValidationError(`${path} is not valid JSON`);
  }
  if (seen.has(value)) throw new ApiSourceValidationError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => copyJson(item, `${path}/${index}`, seen));
    }
    const output: JsonObject = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new ApiSourceValidationError(`${path}/${key} is not allowed`);
      }
      output[key] = copyJson((value as Record<string, unknown>)[key], `${path}/${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function cloneJsonObject(value: unknown, path = 'bodyOverrides'): JsonObject {
  if (!isRecord(value)) throw new ApiSourceValidationError(`${path} must be a JSON object`);
  return copyJson(value, path, new Set()) as JsonObject;
}

function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiSourceValidationError('baseUrl must be a valid absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiSourceValidationError('baseUrl must use http or https');
  }
  return trimmed;
}

/** Strict parser for the new schema. Legacy defaults belong in the migration module. */
export function parseApiSource(input: unknown): ApiSource {
  if (!isRecord(input)) throw new ApiSourceValidationError('API source must be an object');

  const kind = requiredString(input, 'kind') as ApiSourceKind;
  const protocol = requiredString(input, 'protocol') as ApiProtocol;
  if (!(protocol in PROTOCOL_KIND)) {
    throw new ApiSourceValidationError(`Unsupported API protocol: ${protocol}`);
  }
  if (PROTOCOL_KIND[protocol] !== kind) {
    throw new ApiSourceValidationError(`Protocol ${protocol} cannot be used for kind ${kind}`);
  }

  const modelsRaw = input.models ?? [];
  if (!Array.isArray(modelsRaw) || modelsRaw.some((model) => typeof model !== 'string')) {
    throw new ApiSourceValidationError('models must be an array of strings');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    throw new ApiSourceValidationError('timeoutMs must be a positive integer');
  }
  const omitRaw = input.bodyOmitPaths ?? [];
  if (!Array.isArray(omitRaw) || omitRaw.some((path) => typeof path !== 'string')) {
    throw new ApiSourceValidationError('bodyOmitPaths must be an array of strings');
  }

  const common = {
    id: requiredString(input, 'id'),
    name: requiredString(input, 'name'),
    baseUrl: normalizeApiBaseUrl(requiredString(input, 'baseUrl')),
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    defaultModel: requiredString(input, 'defaultModel'),
    models: modelsRaw.map((model) => model.trim()).filter(Boolean),
    timeoutMs: timeoutMs as number,
    bodyOverrides: cloneJsonObject(input.bodyOverrides ?? {}),
    bodyOmitPaths: omitRaw.map((path) => path.trim()).filter(Boolean),
    revision: optionalPositiveInteger(input.revision, 'revision'),
  };

  if (kind === 'llm') {
    const betaRaw = input.anthropicBeta ?? [];
    if (!Array.isArray(betaRaw) || betaRaw.some((value) => typeof value !== 'string')) {
      throw new ApiSourceValidationError('anthropicBeta must be an array of strings');
    }
    return {
      ...common,
      kind,
      protocol: protocol as Extract<ApiProtocol, 'openai-chat' | 'gemini' | 'anthropic-messages'>,
      contextWindowTokens: optionalPositiveInteger(
        input.contextWindowTokens,
        'contextWindowTokens',
      ),
      anthropicVersion:
        typeof input.anthropicVersion === 'string' && input.anthropicVersion.trim()
          ? input.anthropicVersion.trim()
          : undefined,
      anthropicBeta: betaRaw.map((value) => value.trim()).filter(Boolean),
    };
  }
  if (kind === 'embedding') {
    return { ...common, kind, protocol: 'openai-embeddings' };
  }
  return { ...common, kind: 'reranker', protocol: 'openai-rerank' };
}
