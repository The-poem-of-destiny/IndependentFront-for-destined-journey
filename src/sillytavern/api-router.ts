import type { ApiSettings, ApiTarget, Task } from './types';
import { withProxy } from './api-tools';

interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  [key: string]: any;
}

interface CallResult {
  targetUsed: ApiTarget;
  response: Response;
}

interface RouterDeps {
  fetch?: typeof fetch;
}

export function createApiRouter(settings: ApiSettings, deps: RouterDeps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const useSecondary = !!settings.secondary?.enabled;

  function targetFor(task: Task): ApiTarget {
    if (!useSecondary) return 'primary';
    return task === 'story' ? 'primary' : 'secondary';
  }

  function endpointFor(target: ApiTarget) {
    if (target === 'secondary' && settings.secondary) {
      return {
        baseUrl: settings.secondary.baseUrl,
        apiKey: settings.secondary.apiKey,
        model: settings.secondary.model,
      };
    }
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model };
  }

  async function callOnce(target: ApiTarget, body: ChatRequest): Promise<Response> {
    const ep = endpointFor(target);
    return await fetchImpl(withProxy(`${ep.baseUrl}/chat/completions`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({ ...body, model: ep.model }),
    });
  }

  async function call(task: Task, payload: ChatRequest): Promise<CallResult> {
    const target = targetFor(task);
    if (target === 'secondary') {
      try {
        const res = await callOnce('secondary', payload);
        if (!res.ok) throw new Error(`secondary HTTP ${res.status}`);
        return { targetUsed: 'secondary', response: res };
      } catch {
        const res = await callOnce('primary', payload);
        return { targetUsed: 'primary', response: res };
      }
    }
    const res = await callOnce('primary', payload);
    return { targetUsed: 'primary', response: res };
  }

  return { targetFor, call };
}

export type ApiRouter = ReturnType<typeof createApiRouter>;
