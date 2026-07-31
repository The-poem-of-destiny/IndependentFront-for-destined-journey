/**
 * api-tools.ts — /models 探测与错误报告测试
 *
 * 真机踩坑(2026-07-31, Cline 401 排查): fetchModels 先试 Bearer、再试 Azure 风格
 * api-key 兜底。非 Azure 端点普遍对 api-key 鉴权回 401，若 lastError 被兜底覆盖，
 * Bearer 明明是 404（端点没实现 /models，如 api.cline.bot）也会误报成
 * "HTTP 401（Key 无效…）"，把用户往换 key 的死路上带。
 * 错误报告必须以 Bearer 首次尝试为准。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fetchModels } from './api-tools';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 按鉴权方式分别指定 /models 的响应状态；成功时返回 models 列表 */
function mockModelsFetch(opts: { bearer: number | string[]; apiKey: number | string[] }) {
  globalThis.fetch = (async (_url: any, init?: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const plan = headers['Authorization'] ? opts.bearer : opts.apiKey;
    if (Array.isArray(plan)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: plan.map((id) => ({ id })) }),
      } as Response;
    }
    return { ok: false, status: plan, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

const target = { baseUrl: 'https://api.cline.bot/api/v1', apiKey: 'sk_valid' };

describe('fetchModels 错误报告', () => {
  it('Bearer 404 + api-key 兜底 401 → 报 404（不被兜底覆盖）', async () => {
    mockModelsFetch({ bearer: 404, apiKey: 401 });
    const r = await fetchModels(target);
    expect(r.source).toBe('fallback');
    expect(r.error).toContain('404');
    expect(r.error).not.toContain('401');
  });

  it('两次都是 401（key 真的无效）→ 报 401', async () => {
    mockModelsFetch({ bearer: 401, apiKey: 401 });
    const r = await fetchModels(target);
    expect(r.source).toBe('fallback');
    expect(r.error).toContain('401');
  });

  it('Bearer 直接成功 → remote 模型列表，不触发兜底', async () => {
    mockModelsFetch({ bearer: ['m/a', 'm/b'], apiKey: 401 });
    const r = await fetchModels(target);
    expect(r.source).toBe('remote');
    expect(r.models).toEqual(['m/a', 'm/b']);
  });

  it('Bearer 401 但 api-key 兜底成功（真 Azure 端点）→ remote', async () => {
    mockModelsFetch({ bearer: 401, apiKey: ['azure/gpt'] });
    const r = await fetchModels(target);
    expect(r.source).toBe('remote');
    expect(r.models).toEqual(['azure/gpt']);
  });
});
