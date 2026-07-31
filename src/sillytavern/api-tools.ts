/**
 * API helpers for OpenAI-compatible endpoints.
 * Used by SettingsModal for connectivity testing and model discovery.
 */

export interface ApiCallTarget {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

const COMMON_MODELS_BY_HOST: { match: string; models: string[] }[] = [
  { match: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { match: 'moonshot', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { match: 'kimi', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { match: 'dashscope', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
  { match: 'qwen', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
  { match: 'tongyi', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
  { match: 'openai', models: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini'] },
  {
    match: 'anthropic',
    models: ['claude-3-5-sonnet-latest', 'claude-3-opus-latest', 'claude-3-5-haiku-latest'],
  },
  { match: 'gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'] },
];

const FALLBACK_MODELS = ['gpt-3.5-turbo', 'gpt-4', 'deepseek-chat', 'qwen-turbo'];

export function getFallbackModels(baseUrl: string): string[] {
  const url = baseUrl.toLowerCase();
  for (const { match, models } of COMMON_MODELS_BY_HOST) {
    if (url.includes(match)) return models;
  }
  return FALLBACK_MODELS;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

async function tryFetchModels(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch('/api/models', {
    headers: { Accept: 'application/json', 'X-Target-Base-URL': baseUrl, ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // 兼容三种返回形态：顶层数组 / {data:[]} / {models:[]}；元素可为字符串或 {id}
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];
  return raw
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((x: any): x is string => !!x)
    .sort();
}

/**
 * Fetch model list from an OpenAI-compatible /models endpoint.
 * Tries Bearer auth first, then api-key header (Azure style).
 * Returns { models, source } where source is 'remote' or 'fallback'.
 */
export async function fetchModels(
  target: ApiCallTarget,
): Promise<{ models: string[]; source: 'remote' | 'fallback'; error?: string }> {
  const baseUrl = normalizeBaseUrl(target.baseUrl);
  if (!baseUrl) {
    return { models: [], source: 'fallback', error: '请填写 API 基础 URL' };
  }
  const key = target.apiKey?.trim();
  let lastError: unknown;
  try {
    const models = await tryFetchModels(baseUrl, key ? { Authorization: `Bearer ${key}` } : {});
    if (models.length > 0) return { models, source: 'remote' };
  } catch (e) {
    lastError = e;
  }
  try {
    const models = await tryFetchModels(baseUrl, key ? { 'api-key': key } : {});
    if (models.length > 0) return { models, source: 'remote' };
  } catch (e) {
    lastError = e;
  }
  return {
    models: getFallbackModels(baseUrl),
    source: 'fallback',
    error: (lastError as Error)?.message || 'unknown',
  };
}

/**
 * POST a tiny chat-completion request to verify connectivity.
 * Returns { ok, status, errorBody } so the caller can show a meaningful message.
 */
export async function testConnection(
  target: ApiCallTarget,
): Promise<{ ok: boolean; status?: number; errorBody?: string; error?: string }> {
  const baseUrl = normalizeBaseUrl(target.baseUrl);
  const key = target.apiKey?.trim();
  const model = target.model?.trim() || 'gpt-3.5-turbo';
  if (!baseUrl || !key) {
    return { ok: false, error: '请填写 URL 和 Key' };
  }
  try {
    const res = await fetch('/api/chat/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Target-Base-URL': baseUrl,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, errorBody: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
