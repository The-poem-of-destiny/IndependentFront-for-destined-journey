/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/plugins/plugin-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/plugins/plugin-network')>();
  return { ...actual, buildPluginFrameCsp: vi.fn(actual.buildPluginFrameCsp) };
});
vi.mock('../../../src/ui/lib/beautifier-frame', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ui/lib/beautifier-frame')>();
  return { ...actual, buildBeautifierFrameDocument: vi.fn(actual.buildBeautifierFrameDocument) };
});

import { buildPluginFrameCsp } from '../../../src/core/plugins/plugin-network';
import {
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameDocument,
} from '../../../src/ui/lib/beautifier-frame';
import type { CageInnerMode } from '../../../src/ui/lib/frame-cage';
import {
  mountPluginFrame,
  PLUGIN_FRAME_SANDBOX,
  type PluginFrameEnv,
} from '../../../src/ui/lib/plugin-frame';
import {
  buildManualMatrixProbe,
  PICKER_VERIFIED_ENGINES,
  runPluginSelfCheck,
  selfCheckWaitWindow,
  type PluginSelfCheckDeps,
  type PluginSelfCheckResult,
} from '../../../src/ui/lib/plugin-selfcheck';

const ORIGIN = ['http:', '', 'localhost:5173'].join('/');
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

type PluginMountOptions = Parameters<PluginSelfCheckDeps['mount']['plugin']>[0];

interface FakeOptions {
  /** 能产出 ready 的内层装载方式 */
  readyModes?: CageInnerMode[];
  env?: Partial<PluginFrameEnv>;
  /** 对照组 nonce 是否会命中（默认全部命中） */
  controlHit?: (nonce: string) => boolean;
  /** 探针 nonce 是否会命中（默认全不命中） */
  probeHit?: (nonce: string) => boolean;
  /** 对照组从第一次查询起多久后才命中 */
  controlLatency?: number;
  secondLoopbackHost?: string | null;
  userAgent?: string;
  pickerVerifiedEngines?: PluginSelfCheckDeps['pickerVerifiedEngines'];
  registerResult?: boolean;
  /** 管线孪生帧（allow-same-origin）的 nonce 是否会命中（默认全部命中） */
  pipelineHit?: (nonce: string) => boolean;
  /**
   * 按入口 HTML 文本决定插件探针帧的结局（返回 undefined 时按 readyModes 走）：
   * silent = 装载器没跑、什么都不报；load-error = ready 带 error；violation = 牢笼报导航
   */
  probeFrame?: (text: string) => 'ready' | 'silent' | 'load-error' | 'violation' | undefined;
}

function fakeDeps(options: FakeOptions = {}) {
  let clock = 10_000;
  let controlStart: number | null = null;
  const registered: string[][] = [];
  const hitQueries: string[][] = [];
  const sleeps: number[] = [];
  const pluginMounts: { options: PluginMountOptions; disposed: boolean }[] = [];
  const documentMounts: { html: string; sandbox: string; disposed: boolean }[] = [];
  const readyModes = options.readyModes ?? ['srcdoc', 'blob'];
  const env: PluginFrameEnv = {
    hasSaveFilePicker: false,
    hasOpenFilePicker: false,
    hasDirectoryPicker: false,
    ...options.env,
  };

  const deps: PluginSelfCheckDeps = {
    origin: ORIGIN,
    mount: {
      plugin(o) {
        const record = { options: o, disposed: false };
        pluginMounts.push(record);
        const behavior = options.probeFrame?.(fileText(o));
        if (behavior === 'load-error') o.onLoadError?.('入口文件不存在：probe.html', env);
        else if (behavior === 'violation') o.onViolation?.();
        else if (behavior === 'ready') o.onReady?.(env);
        else if (behavior === undefined && o.innerMode && readyModes.includes(o.innerMode)) {
          o.onReady?.(env);
        }
        return {
          dispose: () => {
            record.disposed = true;
          },
        };
      },
      document(o) {
        const record = { ...o, disposed: false };
        documentMounts.push(record);
        return {
          dispose: () => {
            record.disposed = true;
          },
        };
      },
    },
    register: (nonces) => {
      registered.push(nonces);
      return Promise.resolve(options.registerResult ?? true);
    },
    hits: (nonces) => {
      hitQueries.push(nonces);
      if (controlStart === null && nonces.some((n) => n.startsWith('c_'))) controlStart = clock;
      const latencyOk = clock - (controlStart ?? clock) >= (options.controlLatency ?? 0);
      const out: Record<string, boolean> = {};
      for (const n of nonces) {
        if (n.startsWith('q_')) out[n] = options.pipelineHit?.(n) ?? true;
        else if (n.startsWith('c_')) out[n] = latencyOk && (options.controlHit?.(n) ?? true);
        else out[n] = options.probeHit?.(n) ?? false;
      }
      return Promise.resolve(out);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    userAgent: options.userAgent ?? CHROME_UA,
    secondLoopbackHost: options.secondLoopbackHost,
    pickerVerifiedEngines: options.pickerVerifiedEngines,
  };
  return { deps, registered, hitQueries, sleeps, pluginMounts, documentMounts };
}

function item(result: PluginSelfCheckResult, id: string) {
  const found = result.items.find((i) => i.id === id);
  if (!found) throw new Error(`缺少自检项 ${id}`);
  return found;
}

function fileText(options: PluginMountOptions): string {
  return new TextDecoder().decode(options.files[0]?.bytes);
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('runPluginSelfCheck', () => {
  it('全部通过：每项 pass，记录 srcdoc 装载与开跑时刻', async () => {
    const fake = fakeDeps({ secondLoopbackHost: '127.0.0.1' });
    const result = await runPluginSelfCheck(fake.deps);

    expect(result.ok).toBe(true);
    expect(result.innerMode).toBe('srcdoc');
    expect(result.ranAt).toBe(10_000);
    expect(result.items.map((i) => i.id)).toEqual([
      'CAGE',
      'S0',
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
    ]);
    expect(result.items.every((i) => i.status === 'pass')).toBe(true);
    // 登记分批且每批不超过 BFF 上限；对照与探针成对出现
    const all = fake.registered.flat();
    expect(fake.registered.every((batch) => batch.length <= 128)).toBe(true);
    expect(all.filter((n) => n.startsWith('c_')).length).toBe(
      all.filter((n) => n.startsWith('p_')).length,
    );
    expect(all.every((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n))).toBe(true);
    // 所有帧在结束后都被拆掉
    expect(fake.pluginMounts.every((m) => m.disposed)).toBe(true);
    expect(fake.documentMounts.every((m) => m.disposed)).toBe(true);
  });

  it('探针用应用 origin 拼出金丝雀绝对地址，WebSocket 走 ws 协议', async () => {
    const fake = fakeDeps();
    await runPluginSelfCheck(fake.deps);
    const main = fake.pluginMounts[0];
    expect(main).toBeDefined();
    const text = fileText(main!.options);
    expect(text).toContain(`${ORIGIN}/api/plugins/__canary/p_plugin-main-fetch_`);
    expect(text).toContain(
      `${ORIGIN.replace(/^http/, 'ws')}/api/plugins/__canary/p_plugin-main-websocket_`,
    );
  });

  it('核心通道的对照组未命中：S0 失败，整轮失败', async () => {
    const fake = fakeDeps({ controlHit: (n) => !n.startsWith('c_plugin-main-xhr') });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('XHR');
    expect(item(result, 'S1').status).toBe('pass');
  });

  it('可选通道的对照组未命中：整轮仍通过，所属项注明本引擎不支持', async () => {
    const fake = fakeDeps({
      controlHit: (n) =>
        !n.startsWith('c_plugin-main-speculation') &&
        !n.startsWith('c_plugin-ping') &&
        !n.startsWith('c_plugin-nav-data'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S0').detail).toContain('4 种可选通道本引擎不支持');
    const s1 = item(result, 'S1');
    expect(s1.status).toBe('pass');
    expect(s1.detail).toContain('本引擎不支持该通道（对照组未命中），不构成外发途径');
    expect(s1.detail).toContain('推测规则');
    expect(s1.detail).toContain('<a ping>');
    expect(item(result, 'S3').detail).toContain('导航到 data: 后 fetch');
    expect(item(result, 'S2').detail).not.toContain('不支持');
    // 只等核心通道：可选通道永不命中也不会把轮询拖到超时
    expect(fake.sleeps.filter((ms) => ms === 100)).toHaveLength(0);
  });

  it('可选通道的对照组未命中但探针命中：照样判失败', async () => {
    const fake = fakeDeps({
      controlHit: (n) => !n.startsWith('c_plugin-main-object'),
      probeHit: (n) => n.startsWith('p_plugin-main-object'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S1').status).toBe('fail');
    expect(item(result, 'S1').detail).toContain('<object>');
  });

  it('对照组与管线孪生帧都超时不命中时停止轮询并判失败', async () => {
    const fake = fakeDeps({ controlHit: () => false, pipelineHit: () => false });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S0').status).toBe('fail');
    // 轮询不会无限进行
    expect(fake.hitQueries.length).toBeLessThan(200);
  });

  it('任一探针命中：所属项失败，整轮失败', async () => {
    const fake = fakeDeps({
      probeHit: (n) => n.startsWith('p_plugin-location') || n.startsWith('p_rule-scripts-fetch'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S2').status).toBe('fail');
    expect(item(result, 'S2').detail).toContain('location 导航');
    expect(item(result, 'S6').status).toBe('fail');
    expect(item(result, 'S6').detail).toContain('规则帧 fetch');
    expect(item(result, 'S1').status).toBe('pass');
  });

  it('管线孪生帧：宿主自写文档、沙盒带 allow-same-origin、不含插件代码，用完拆掉', async () => {
    const fake = fakeDeps();
    await runPluginSelfCheck(fake.deps);
    const twins = fake.documentMounts.filter((m) => m.html.includes('q_pipeline-'));
    expect(twins).toHaveLength(1);
    const twin = twins[0]!;
    expect(twin.sandbox).toBe('allow-scripts allow-same-origin');
    expect(twin.html).not.toContain('Content-Security-Policy');
    expect(twin.html).toContain('q_pipeline-fetch_');
    expect(twin.html).toContain('q_pipeline-img_');
    expect(twin.html).toContain('q_pipeline-cssUrl_');
    expect(twin.disposed).toBe(true);
    expect(fake.registered.flat().filter((n) => n.startsWith('q_'))).toHaveLength(3);
  });

  it('S0 分支一：管线孪生帧未命中 ⇒ 失败，金丝雀管线未被证明', async () => {
    const fake = fakeDeps({ pipelineHit: (n) => !n.startsWith('q_pipeline-img') });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('金丝雀管线未被证明');
    expect(item(result, 'S0').detail).toContain('<img>');
    expect(result.browserBlocksLocal).toBeUndefined();
  });

  it('S0 分支二：管线与不透明来源核心对照组全部命中 ⇒ 通过，不标浏览器拦截', async () => {
    const fake = fakeDeps();
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S0').detail).toContain('全部命中');
    expect(result.browserBlocksLocal).toBeUndefined();
  });

  it('S0 分支三：管线命中而不透明来源核心对照组全部不命中 ⇒ 浏览器兜底，通过并标 browserBlocksLocal', async () => {
    const fake = fakeDeps({ controlHit: () => false });
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S0').detail).toContain(
      '浏览器已拦截不透明来源帧访问本机（本地网络访问保护），红线 D 由浏览器兜底',
    );
    expect(result.browserBlocksLocal).toBe(true);
    expect(result.ok).toBe(true);
    // 不空等到 10 秒超时
    expect(fake.sleeps.filter((ms) => ms === 100).length).toBeLessThan(30);
  });

  it('核心对照组全不中但有探针命中 ⇒ 部分拦截，S0 失败且不标 browserBlocksLocal', async () => {
    const fake = fakeDeps({
      controlHit: () => false,
      probeHit: (n) => n.startsWith('p_plugin-main-img'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.browserBlocksLocal).toBeUndefined();
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('浏览器只拦截了部分不透明来源通道，结果不可信');
    expect(item(result, 'S1').status).toBe('fail');
    expect(result.ok).toBe(false);
  });

  it('核心对照组全不中但可选通道对照组命中 ⇒ 部分拦截，S0 失败', async () => {
    const fake = fakeDeps({
      controlHit: (n) => n.startsWith('c_plugin-main-speculation'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('浏览器只拦截了部分不透明来源通道，结果不可信');
    expect(result.browserBlocksLocal).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it('提前判定浏览器拦截后对照组又全部命中 ⇒ 按部分拦截判失败，不拿孪生帧延迟当对照延迟', async () => {
    // 孪生帧立刻命中；对照组 3 秒后才命中，晚于提前收尾的 2 秒窗口。
    // 一个探针帧迟迟不就绪，让最终查询落在 8 秒就绪超时之后，那时对照组已经全中
    const fake = fakeDeps({
      controlLatency: 3_000,
      probeFrame: (text) => (text.includes('p_plugin-location-location_') ? 'silent' : undefined),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('浏览器只拦截了部分不透明来源通道，结果不可信');
    expect(result.browserBlocksLocal).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it('S0 分支四：管线命中而不透明来源核心对照组时中时不中 ⇒ 失败并点名未命中的通道', async () => {
    const fake = fakeDeps({
      controlHit: (n) =>
        !n.startsWith('c_plugin-main-fetch') && !n.startsWith('c_rule-scripts-xhr'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S0').status).toBe('fail');
    expect(item(result, 'S0').detail).toContain('S1 fetch');
    expect(item(result, 'S0').detail).toContain('S6 规则帧 XHR');
    expect(item(result, 'S0').detail).toContain('不可信');
    expect(result.browserBlocksLocal).toBeUndefined();
  });

  it('BFF 拒绝登记：所有项失败', async () => {
    const fake = fakeDeps({ registerResult: false });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(result.items.every((i) => i.status === 'fail')).toBe(true);
    expect(fake.pluginMounts).toHaveLength(0);
  });

  it('S5：没有第二个 loopback 主机名时标记未自检，且不挂重定向帧', async () => {
    const fake = fakeDeps({ secondLoopbackHost: null });
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S5').status).toBe('skipped');
    expect(result.ok).toBe(true);
    expect(fake.documentMounts.some((m) => m.html.includes('__canary-redirect'))).toBe(false);
  });

  it('S5：有第二个主机名时用手写测试策略请求重定向端点', async () => {
    const fake = fakeDeps({ secondLoopbackHost: '127.0.0.1' });
    await runPluginSelfCheck(fake.deps);
    const redirects = fake.documentMounts.filter((m) => m.html.includes('__canary-redirect'));
    expect(redirects).toHaveLength(2);
    const probe = redirects.find((m) => m.html.includes('Content-Security-Policy'));
    expect(probe?.html).toContain(`connect-src ${ORIGIN}`);
    expect(probe?.html).toContain('?host=127.0.0.1');
    expect(probe?.sandbox).toBe(PLUGIN_FRAME_SANDBOX);
  });

  it('S6：美化帧沙盒没有 allow-forms，规则帧不测表单提交，S0 不因此失败', async () => {
    // 模拟美化帧沙盒：凡是规则帧里的表单提交，对照组都打不中
    const fake = fakeDeps({ controlHit: (n) => !/^c_rule-form/.test(n) });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S0').status).toBe('pass');
    expect(fake.registered.flat().some((n) => n.includes('rule-form'))).toBe(false);
    const beautifierDocs = fake.documentMounts.filter(
      (m) => m.sandbox === BEAUTIFIER_FRAME_SANDBOX,
    );
    expect(beautifierDocs.some((m) => m.html.includes('sc-form'))).toBe(false);
    expect(item(result, 'S6').detail).toContain('allow-forms');
    // 插件帧有 allow-forms，S2 照测表单提交
    expect(fake.registered.flat().some((n) => n.startsWith('p_plugin-form-form_'))).toBe(true);
  });

  it('S5：第二个本机主机名不可达（对照组不命中）时标未自检，不拖累 S0，也不把轮询拖到超时', async () => {
    const fake = fakeDeps({
      secondLoopbackHost: '127.0.0.1',
      controlHit: (n) => !n.startsWith('c_redirect-'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S5').status).toBe('skipped');
    expect(item(result, 'S5').detail).toBe('未自检：第二个本机主机名不可达');
    expect(fake.sleeps.filter((ms) => ms === 100)).toHaveLength(0);
  });

  it('S5：对照组命中而探针命中：失败', async () => {
    const fake = fakeDeps({
      secondLoopbackHost: '127.0.0.1',
      probeHit: (n) => n.startsWith('p_redirect-img'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S5').status).toBe('fail');
    expect(item(result, 'S5').detail).toContain('重定向 <img>');
  });

  it('S5：对照组没命中但探针命中：仍判失败', async () => {
    const fake = fakeDeps({
      secondLoopbackHost: '127.0.0.1',
      controlHit: (n) => !n.startsWith('c_redirect-'),
      probeHit: (n) => n.startsWith('p_redirect-fetch'),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S5').status).toBe('fail');
  });

  it('空白子帧手段是可选通道：opaque 父帧下对照组够不着时只注明本引擎不支持', async () => {
    const fake = fakeDeps({ controlHit: (n) => !n.startsWith('c_plugin-main-blank') });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S0').status).toBe('pass');
    expect(item(result, 'S3').status).toBe('pass');
    expect(item(result, 'S3').detail).toContain('空白子帧 fetch');
    expect(item(result, 'S3').detail).toContain('本引擎不支持');
  });

  it('探针帧从未运行：零命中不算通过，所属项判「探测帧未运行」', async () => {
    const fake = fakeDeps({
      probeFrame: (text) => (text.includes('p_plugin-location-location_') ? 'silent' : undefined),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S2').status).toBe('fail');
    expect(item(result, 'S2').detail).toContain('探测帧未运行');
    expect(item(result, 'S2').detail).toContain('location 导航');
    expect(item(result, 'S1').status).toBe('pass');
    // 等过就绪超时才判没跑
    expect(fake.sleeps.some((ms) => ms > 0 && ms <= 8000)).toBe(true);
  });

  it('探针帧 ready 带 error：同样判「探测帧未运行」', async () => {
    const fake = fakeDeps({
      probeFrame: (text) => (text.includes('p_plugin-ping-ping_') ? 'load-error' : undefined),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S1').status).toBe('fail');
    expect(item(result, 'S1').detail).toContain('探测帧未运行：<a ping>');
  });

  it('导航探针被牢笼报违规：算作执行过，零命中照常通过', async () => {
    const fake = fakeDeps({
      probeFrame: (text) => (text.includes('p_plugin-anchor-anchor_') ? 'violation' : undefined),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S2').status).toBe('pass');
  });

  it('主探针帧 ready 带 error：不算起来，CAGE 退到 blob 并记录装载失败', async () => {
    let calls = 0;
    const fake = fakeDeps({
      probeFrame: (text) =>
        text.includes('p_plugin-main-fetch_') && calls++ === 0 ? 'load-error' : undefined,
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.innerMode).toBe('blob');
    expect(item(result, 'CAGE').detail).toContain('帧内装载失败');
    expect(fake.pluginMounts[0]?.disposed).toBe(true);
  });

  it('主探针帧两种装载都报 error：CAGE 失败', async () => {
    const fake = fakeDeps({
      probeFrame: (text) => (text.includes('p_plugin-main-fetch_') ? 'load-error' : undefined),
    });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.innerMode).toBeNull();
    expect(item(result, 'CAGE').status).toBe('fail');
    expect(item(result, 'CAGE').detail).toContain('帧内装载失败');
  });

  it('等待窗口从最晚的探针帧执行证明起算', async () => {
    let lateReady: (() => void) | null = null;
    const fake = fakeDeps({
      probeFrame: (text) => (text.includes('p_plugin-refresh-refresh_') ? 'silent' : undefined),
    });
    const mountPlugin = fake.deps.mount.plugin;
    fake.deps.mount.plugin = (o) => {
      if (fileText(o).includes('p_plugin-refresh-refresh_')) {
        lateReady = () =>
          o.onReady?.({
            hasSaveFilePicker: false,
            hasOpenFilePicker: false,
            hasDirectoryPicker: false,
          });
      }
      return mountPlugin(o);
    };
    // 等就绪的那次 sleep 走到一半时，迟到的帧报 ready
    const sleep = fake.deps.sleep;
    let proofAt: number | null = null;
    fake.deps.sleep = async (ms) => {
      if (lateReady && proofAt === null && ms > 2000) {
        await sleep(3000);
        proofAt = fake.deps.now();
        lateReady();
        return;
      }
      return sleep(ms);
    };
    const result = await runPluginSelfCheck(fake.deps);
    expect(item(result, 'S2').status).toBe('pass');
    expect(proofAt).not.toBeNull();
    // 最终查询不早于迟到证明后 2 秒
    expect(fake.deps.now()).toBeGreaterThanOrEqual((proofAt ?? 0) + 2000);
  });

  it('srcdoc 起不来时退到 blob，并记录退回原因', async () => {
    const fake = fakeDeps({ readyModes: ['blob'] });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.innerMode).toBe('blob');
    expect(item(result, 'CAGE').status).toBe('pass');
    expect(item(result, 'CAGE').detail).toContain('srcdoc');
    expect(fake.pluginMounts[0]?.options.innerMode).toBe('srcdoc');
    expect(fake.pluginMounts[0]?.disposed).toBe(true);
    // 其余插件探针帧都按 blob 挂
    expect(fake.pluginMounts.slice(1).every((m) => m.options.innerMode === 'blob')).toBe(true);
    expect(fake.sleeps).toContain(8000);
  });

  it('两种装载都起不来：CAGE 与插件帧各项失败，innerMode 为 null', async () => {
    const fake = fakeDeps({ readyModes: [] });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(false);
    expect(result.innerMode).toBeNull();
    for (const id of ['CAGE', 'S1', 'S2', 'S3', 'S4', 'S7']) {
      expect(item(result, id).status).toBe('fail');
    }
    expect(item(result, 'S6').status).toBe('pass');
    expect(fake.pluginMounts).toHaveLength(2);
  });
});

describe('等待窗口', () => {
  it('取对照组延迟的 3 倍，至少 2 秒', () => {
    expect(selfCheckWaitWindow(0)).toBe(2000);
    expect(selfCheckWaitWindow(500)).toBe(2000);
    expect(selfCheckWaitWindow(1000)).toBe(3000);
    expect(selfCheckWaitWindow(2500)).toBe(7500);
    expect(selfCheckWaitWindow(Number.NaN)).toBe(2000);
    expect(selfCheckWaitWindow(-5)).toBe(2000);
  });

  it('实测延迟 1 秒时，最终查询发生在挂帧后 3 秒', async () => {
    const fake = fakeDeps({ controlLatency: 1000 });
    const result = await runPluginSelfCheck(fake.deps);
    expect(result.ok).toBe(true);
    expect(item(result, 'S0').detail).toContain('延迟 1000 毫秒');
    expect(item(result, 'S0').detail).toContain('等待窗口 3000 毫秒');
    // 轮询 10 次（每次 100ms）后，再补睡到 3000ms
    expect(fake.sleeps[fake.sleeps.length - 1]).toBe(2000);
  });
});

describe('S7 文件选择器门控', () => {
  it('已验表出厂为空', () => {
    expect(PICKER_VERIFIED_ENGINES).toEqual([]);
  });

  it('插件帧里没有 showSaveFilePicker 即通过', async () => {
    const result = await runPluginSelfCheck(fakeDeps().deps);
    expect(item(result, 'S7').status).toBe('pass');
  });

  it('有 showSaveFilePicker 且引擎不在表里：失败并点名引擎与大版本', async () => {
    const result = await runPluginSelfCheck(fakeDeps({ env: { hasSaveFilePicker: true } }).deps);
    expect(result.ok).toBe(false);
    expect(item(result, 'S7').status).toBe('fail');
    expect(item(result, 'S7').detail).toContain('chromium 131');
  });

  it('有 showSaveFilePicker 且引擎与大版本在表里：通过', async () => {
    const result = await runPluginSelfCheck(
      fakeDeps({
        env: { hasSaveFilePicker: true },
        pickerVerifiedEngines: [{ engine: 'chromium', major: 131 }],
      }).deps,
    );
    expect(item(result, 'S7').status).toBe('pass');
  });

  it('大版本不同不算已验；Firefox 按 gecko 识别', async () => {
    const chromeOld = await runPluginSelfCheck(
      fakeDeps({
        env: { hasSaveFilePicker: true },
        pickerVerifiedEngines: [{ engine: 'chromium', major: 130 }],
      }).deps,
    );
    expect(item(chromeOld, 'S7').status).toBe('fail');
    const firefox = await runPluginSelfCheck(
      fakeDeps({
        env: { hasSaveFilePicker: true },
        userAgent: FIREFOX_UA,
        pickerVerifiedEngines: [{ engine: 'gecko', major: 133 }],
      }).deps,
    );
    expect(item(firefox, 'S7').status).toBe('pass');
  });
});

describe('探针由生产生成器建', () => {
  it('插件探针经 mountPluginFrame → buildPluginFrameCsp，美化探针经加固的 buildBeautifierFrameDocument', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const fake = fakeDeps();
    const realDeps: PluginSelfCheckDeps = {
      ...fake.deps,
      mount: {
        plugin: (o) => mountPluginFrame(container, o),
        document: fake.deps.mount.document,
      },
    };
    const result = await runPluginSelfCheck(realDeps);

    // jsdom 不跑帧内脚本：两种装载都等不到 ready
    expect(result.innerMode).toBeNull();
    const cspSpy = vi.mocked(buildPluginFrameCsp);
    expect(cspSpy).toHaveBeenCalledWith(['selfcheck.example.com'], { innerFrame: 'srcdoc' });
    expect(cspSpy).toHaveBeenCalledWith(['selfcheck.example.com'], { innerFrame: 'blob' });
    // 等不到 ready 的帧都被拆掉
    expect(container.children).toHaveLength(0);

    const beautifierSpy = vi.mocked(buildBeautifierFrameDocument);
    const calls = beautifierSpy.mock.calls.map(([o]) => o);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((o) => o.hardened === true)).toBe(true);
    expect(new Set(calls.map((o) => o.scripts))).toEqual(new Set(['block', 'allow']));
    // 生成器的产物原样挂上，沙盒用美化帧的生产标志
    const outputs = beautifierSpy.mock.results.map((r) => r.value as string);
    for (const html of outputs) {
      const mounted = fake.documentMounts.find((m) => m.html === html);
      expect(mounted?.sandbox).toBe(BEAUTIFIER_FRAME_SANDBOX);
    }
  });

  it('对照帧不带 CSP，沙盒标志与对应探针相同', async () => {
    const fake = fakeDeps();
    await runPluginSelfCheck(fake.deps);
    const controls = fake.documentMounts.filter((m) => m.html.includes('/api/plugins/__canary/c_'));
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((m) => !m.html.includes('Content-Security-Policy'))).toBe(true);
    const pluginControl = controls.find((m) => m.html.includes('c_plugin-main-fetch_'));
    expect(pluginControl?.sandbox).toBe(PLUGIN_FRAME_SANDBOX);
    const ruleControl = controls.find((m) => m.html.includes('c_rule-scripts-fetch_'));
    expect(ruleControl?.sandbox).toBe(BEAUTIFIER_FRAME_SANDBOX);
  });
});

describe('buildManualMatrixProbe', () => {
  it('包含人工矩阵的各项按钮，且不含字面外部地址', () => {
    const html = buildManualMatrixProbe();
    for (const id of [
      'picker-save',
      'ext-mailto',
      'ext-custom',
      'open-btn',
      'rtc-space',
      'rtc-crlf',
      'hint-preconnect',
      'hint-dns',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('127.0.0.1:8188');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
  });
});
