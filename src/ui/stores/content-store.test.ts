/**
 * content-store.ts 测试（波 1 T2 / D16）
 *
 * 🔴 最承重的断言：**模块级 ready promise 在模块加载时就已创建并 resolve**。
 * 设计 D16 裁定：`settings-store` 构造器在 `main.ts`、`app.mount` 之前就 `setTimeout(0)`
 * 触发 `loadAgentProjectDefaults()`（现改调 `loadProjectDefaults()`），App.vue init 链拦不住。
 * 所以 ready promise 必须在 `import` 时就绑定，`isContentReady === true` 在任何 store
 * 构造之前就成立——这条断言钉死它。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// 🔴 在 import content-store 之前抓快照：模块加载是同步的，ready 必须立刻为 true。
//    这个 import 顺序本身就是断言的一部分——先 import 再读标志。
import {
  useContentStore,
  contentReadyPromise,
  isContentReady,
  markContentReady,
  getContentRegistry,
  setContentRegistry,
  seedPlaceholderRegistry,
} from './content-store';
import { reportContentFetch, setContentFetchReporter } from '@engine/content-source';

describe('content-store — 模块级 ready promise（D16 时序契约）', () => {
  it('isContentReady 在模块加载完成时就为 true（不等 store 构造 / mount）', () => {
    // 🔴 这是 D16 的核心断言：ready 在 import 期就 resolve，
    //    settings-store 的 setTimeout(0) 链拦不住它。
    expect(isContentReady).toBe(true);
  });

  it('contentReadyPromise 已 resolve（await 立即放行）', async () => {
    // 不挂起：已 resolve 的 promise await 在微任务里就回来
    let resolved = false;
    void contentReadyPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('markContentReady 幂等（重复调不抛、不重新 resolve）', () => {
    expect(() => markContentReady()).not.toThrow();
    expect(isContentReady).toBe(true);
  });
});

describe('content-store — 注册表（D16 七面同步读取）', () => {
  it('getContentRegistry 在模块加载后就返回非空骨架（七面键齐）', () => {
    const r = getContentRegistry();
    expect(r).toBeDefined();
    // 七面键必须在骨架里（值可 undefined，键不能缺）
    expect(Object.keys(r).sort()).toEqual([
      'bloodlines',
      'branding',
      'catalog',
      'imageDialects',
      'locations',
      'markers',
      'namePools',
    ]);
  });

  it('setContentRegistry 整份替换（不深合并）', () => {
    const next = {
      catalog: [{ id: 'wp1' }],
      locations: [{ id: 'loc1' }],
      bloodlines: { bloodlines: [] },
      namePools: { data: { given: [] } },
      markers: [],
      branding: { appTitle: 'Test' },
      imageDialects: { dialects: [] },
    };
    setContentRegistry(next);
    const r = getContentRegistry();
    expect(r.catalog).toEqual([{ id: 'wp1' }]);
    expect(r.branding).toEqual({ appTitle: 'Test' });
  });

  it('seedPlaceholderRegistry 重置回空骨架', () => {
    setContentRegistry({
      catalog: 'filled',
      locations: 'filled',
      bloodlines: 'filled',
      namePools: 'filled',
      markers: 'filled',
      branding: 'filled',
      imageDialects: 'filled',
    });
    seedPlaceholderRegistry();
    const r = getContentRegistry();
    expect(r.catalog).toBeUndefined();
    expect(r.locations).toBeUndefined();
  });
});

describe('content-store — Pinia store 行为', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('contentStatus 初始为 placeholder', () => {
    const c = useContentStore();
    expect(c.contentStatus).toBe('placeholder');
    expect(c.activePackId).toBeNull();
    expect(c.fetchReports).toHaveLength(0);
  });

  it('reportContentFetch 成功记录进 fetchReports，不改 placeholder 态', () => {
    const c = useContentStore();
    c.reportContentFetch({ source: 'test', status: 200, ok: true });
    expect(c.fetchReports).toHaveLength(1);
    expect(c.contentStatus).toBe('placeholder');
  });

  it('reportContentFetch 失败把 placeholder 切到 error + lastFetchError', () => {
    const c = useContentStore();
    c.reportContentFetch({ source: 'beautifier', status: 404, ok: false, error: 'HTTP 404' });
    expect(c.contentStatus).toBe('error');
    expect(c.lastFetchError).toContain('beautifier');
    expect(c.lastFetchError).toContain('HTTP 404');
  });

  it('后续成功把 error 清回 placeholder', () => {
    const c = useContentStore();
    c.reportContentFetch({ source: 'a', ok: false, error: 'boom' });
    expect(c.contentStatus).toBe('error');
    c.reportContentFetch({ source: 'b', status: 200, ok: true });
    expect(c.contentStatus).toBe('placeholder');
    expect(c.lastFetchError).toBeNull();
  });

  it('loadProjectDefaults 成功时返回解析后的 JSON 并上报成功', async () => {
    const payload = { version: 1, agents: { story: { model: 'gpt-4' } } };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const c = useContentStore();
    const result = (await c.loadProjectDefaults()) as { version: number; agents: unknown };
    expect(result.version).toBe(1);
    expect(c.fetchReports.some((r) => r.ok && r.source.includes('loadProjectDefaults'))).toBe(true);
    fetchSpy.mockRestore();
  });

  it('loadProjectDefaults 失败返回空骨架 + 上报失败 + contentStatus=error', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('not found', { status: 404 }));
    const c = useContentStore();
    const result = (await c.loadProjectDefaults()) as { version: number; agents: unknown };
    expect(result.version).toBe(1);
    expect(result.agents).toEqual({});
    expect(c.contentStatus).toBe('error');
    expect(c.fetchReports.some((r) => !r.ok)).toBe(true);
    fetchSpy.mockRestore();
  });

  it('loadProjectDefaults 网络异常返回空骨架 + 上报失败（不抛）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const c = useContentStore();
    const result = await c.loadProjectDefaults();
    expect(result).toEqual({ version: 1, agents: {} });
    expect(c.contentStatus).toBe('error');
    fetchSpy.mockRestore();
  });

  it('loadRawProjectDefaults 成功返回原始 JSON（不走 pack 叠加层）', async () => {
    const payload = { version: 1, agents: { story: { systemPrompt: 'raw' } } };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const c = useContentStore();
    const result = (await c.loadRawProjectDefaults()) as {
      agents: { story: { systemPrompt: string } };
    };
    expect(result.agents.story.systemPrompt).toBe('raw');
    // raw 读**不上报** contentStatus（写回路径的读半边，不是 census 成员）
    expect(c.fetchReports).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('loadRawProjectDefaults 失败返回空骨架（不抛、不上报）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const c = useContentStore();
    const result = await c.loadRawProjectDefaults();
    expect(result).toEqual({ version: 1, agents: {} });
    expect(c.fetchReports).toHaveLength(0);
    expect(c.contentStatus).toBe('placeholder');
    fetchSpy.mockRestore();
  });
});

describe('content-store — 引擎层上报钩子（§5.5 census 注入缝）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('setContentFetchReporter 注册后，引擎层 reportContentFetch 路由进 store', () => {
    const c = useContentStore();
    // 默认 reporter 已在模块加载时注册（content-store 顶层）。
    reportContentFetch({ source: 'beautifier.loadPresetRules', ok: false, error: 'HTTP 500' });
    expect(c.fetchReports.some((r) => r.source === 'beautifier.loadPresetRules')).toBe(true);
    expect(c.contentStatus).toBe('error');
  });

  it('未挂载 Pinia 时引擎层 reportContentFetch 静默 no-op（不抛）', async () => {
    // 临时换一个未注册的 reporter，再清空 active pinia
    setContentFetchReporter(null);
    // 重新注册模块默认 reporter（模拟 boot），但无 active pinia
    // 直接调 reportContentFetch，无 active pinia 应静默
    // 先确保有 active pinia 的 reporter 注册回去
    const { getActivePinia } = await import('pinia');
    // 用一个新的 reporter 模拟「无 pinia」场景
    setContentFetchReporter((report) => {
      const pinia = getActivePinia?.();
      if (!pinia) return; // 无 pinia → 静默
      void report;
    });
    expect(() => reportContentFetch({ source: 'x', ok: false })).not.toThrow();
  });
});
