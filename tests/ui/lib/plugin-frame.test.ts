/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAGE_MESSAGE_SOURCE } from '../../../src/ui/lib/frame-cage';
import {
  buildPluginFrameDocument,
  filterPluginThemeValues,
  mountPluginFrame,
  PLUGIN_FRAME_SANDBOX,
  type PluginFrameEnv,
  type PluginFrameFile,
} from '../../../src/ui/lib/plugin-frame';
import { PLUGIN_API_VERSION } from '../../../src/core/plugins/plugin-surface';

const encoder = new TextEncoder();

function file(path: string, mime: string, text: string): PluginFrameFile {
  return { path, mime, bytes: encoder.encode(text) };
}

/** 从牢笼文档里取出内层文档（牢笼脚本里的 `const config = {…};` 是合法 JSON） */
function innerOf(cage: string): string {
  const match = /const config = (\{.*\});\n/.exec(cage);
  if (!match) throw new Error('牢笼文档里找不到 config');
  return (JSON.parse(match[1]) as { inner: string }).inner;
}

function cspOf(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null
  );
}

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
}

/**
 * 在 jsdom 子窗口里真跑内层引导脚本：`parent` 换成可观察的假宿主，`URL.createObjectURL`
 * 由测试提供（jsdom 没实现）。握手用假端口完成，返回驱动与观察用的句柄。
 */
function bootBootstrap(options: { channel?: string; beforeRun?: (win: Window) => void } = {}) {
  const channel = options.channel ?? 'chan-b1';
  const { cage } = buildPluginFrameDocument({ network: [], channel });
  const inner = new DOMParser().parseFromString(innerOf(cage), 'text/html');
  const scripts = inner.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  const source = scripts[0].textContent ?? '';

  const holder = document.createElement('iframe');
  document.body.appendChild(holder);
  const win = holder.contentWindow as Window & typeof globalThis;
  options.beforeRun?.(win);

  const parentPosts: unknown[] = [];
  const fakeParent = { postMessage: vi.fn((data: unknown) => parentPosts.push(data)) };
  const blobs = new Map<string, Blob>();
  let counter = 0;
  const fakeUrl = {
    createObjectURL: vi.fn((blob: Blob) => {
      counter += 1;
      const url = `blob:frame/${counter}`;
      blobs.set(url, blob);
      return url;
    }),
    revokeObjectURL: vi.fn(),
  };

  const run = new Function(
    'window',
    'document',
    'parent',
    'addEventListener',
    'removeEventListener',
    'URL',
    'Blob',
    'DOMParser',
    'MessageEvent',
    'Event',
    source,
  ) as (...args: unknown[]) => void;
  run(
    win,
    win.document,
    fakeParent,
    win.addEventListener.bind(win),
    win.removeEventListener.bind(win),
    fakeUrl,
    Blob,
    win.DOMParser,
    win.MessageEvent,
    win.Event,
  );

  const port: FakePort = { postMessage: vi.fn(), onmessage: null };
  const handOff = () => {
    const event = new win.Event('message');
    Object.defineProperty(event, 'data', {
      value: { source: CAGE_MESSAGE_SOURCE, channel, type: 'port' },
    });
    Object.defineProperty(event, 'source', { value: fakeParent });
    Object.defineProperty(event, 'ports', { value: [port] });
    win.dispatchEvent(event);
  };
  const deliver = (data: unknown) => {
    port.onmessage?.(new win.MessageEvent('message', { data }));
  };
  const sent = () => port.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>);
  return { win, channel, fakeParent, parentPosts, port, handOff, deliver, sent, blobs, fakeUrl };
}

type Booted = ReturnType<typeof bootBootstrap>;

/** 握手 + init，并替装载器把外部脚本的 load 依次补上，直到发出 ready */
async function initFrame(booted: Booted, init: Record<string, unknown>) {
  booted.handOff();
  booted.deliver({ type: 'init', pluginId: 'demo.shop', apiVersion: PLUGIN_API_VERSION, ...init });
  await vi.waitFor(() => {
    for (const script of Array.from(booted.win.document.querySelectorAll('script[src]'))) {
      if (!(script as HTMLElement).dataset.loadedByTest) {
        (script as HTMLElement).dataset.loadedByTest = '1';
        script.dispatchEvent(new booted.win.Event('load'));
      }
    }
    expect(booted.sent().some((m) => m.type === 'ready')).toBe(true);
  });
  return booted.sent().find((m) => m.type === 'ready') as { env: PluginFrameEnv; error?: string };
}

const SIMPLE_ENTRY = [file('index.html', 'text/html', '<!doctype html><p id="hi">你好</p>')];

interface HostApi {
  [key: string]: unknown;
}

function hostOf(booted: Booted): HostApi {
  return (booted.win as unknown as { host: HostApi }).host;
}

function lastReq(booted: Booted) {
  const reqs = booted.sent().filter((m) => m.type === 'req');
  return reqs[reqs.length - 1] as { id: number; method: string; args: unknown[] };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('插件帧文档', () => {
  it('牢笼与内层共用同一份 CSP，且等于 buildPluginFrameCsp 的产物', () => {
    const { cage, csp } = buildPluginFrameDocument({ network: ['api.example.com'], channel: 'c' });
    expect(csp).toContain('https://api.example.com');
    expect(cspOf(cage)).toBe(csp);
    expect(cspOf(innerOf(cage))).toBe(csp);
  });

  it('blob 模式：CSP 的 frame-src 变成 blob:，两层仍一致', () => {
    const { cage, csp } = buildPluginFrameDocument({
      network: [],
      innerMode: 'blob',
      channel: 'c',
    });
    expect(csp).toContain('frame-src blob:');
    expect(cspOf(innerOf(cage))).toBe(csp);
    expect(cage).toContain('"innerMode":"blob"');
  });

  it('牢笼用 port-handoff 连接', () => {
    const { cage } = buildPluginFrameDocument({ network: [], channel: 'c' });
    expect(cage).toContain('"link":"port-handoff"');
  });

  it('不合格的联网域名直接抛错', () => {
    expect(() => buildPluginFrameDocument({ network: ['127.0.0.1'], channel: 'c' })).toThrow();
  });
});

describe('mountPluginFrame', () => {
  // jsdom 不给 shadow tree 里的 iframe 建浏览上下文：用假窗口顶替 contentWindow。
  const fakeWindows = new WeakMap<HTMLIFrameElement, { postMessage: ReturnType<typeof vi.fn> }>();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  beforeEach(() => {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        if (!this.isConnected) return null;
        let fake = fakeWindows.get(this);
        if (!fake) {
          fake = { postMessage: vi.fn() };
          fakeWindows.set(this, fake);
        }
        return fake;
      },
    });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', descriptor);
  });

  function mount(overrides: Partial<Parameters<typeof mountPluginFrame>[1]> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = mountPluginFrame(container, {
      pluginId: 'demo.shop',
      network: [],
      entry: 'index.html',
      files: SIMPLE_ENTRY,
      theme: { '--theme-accent': '#c33', 'background-image': 'url(x)' },
      ...overrides,
    });
    const wrapper = container.firstElementChild as HTMLElement;
    const frame = wrapper.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    return { container, handle, wrapper, frame };
  }

  function cageSays(
    frame: HTMLIFrameElement,
    data: unknown,
    source: unknown = frame.contentWindow,
  ) {
    const event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  }

  it('外层 iframe 挂在 shadow root 里：沙盒标志精确、无 allow、无 referrer、srcdoc 为牢笼文档', () => {
    const { container, frame, handle } = mount();
    expect(container.querySelector('iframe')).toBeNull();
    expect(frame).toBeTruthy();
    expect(PLUGIN_FRAME_SANDBOX).toBe('allow-scripts allow-forms allow-pointer-lock');
    expect(frame.getAttribute('sandbox')).toBe(PLUGIN_FRAME_SANDBOX);
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain('fated-poem-cage');
    handle.dispose();
  });

  it('hidden 时不可见', () => {
    const { wrapper, handle } = mount({ hidden: true });
    expect(wrapper.style.display).toBe('none');
    handle.dispose();
  });

  it('cage-ready 后把一个端口交给牢笼；init 携带入口、文件、过滤后的主题与 API 版本', async () => {
    const { frame, handle } = mount();
    const win = frame.contentWindow as Window;
    const post = (win as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    const channel = /"channel":"([^"]+)"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    expect(channel).toBeTruthy();

    // 别处冒充的 cage-ready 不理
    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-ready' }, window);
    expect(post).not.toHaveBeenCalled();

    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-ready' });
    expect(post).toHaveBeenCalledTimes(1);
    const [message, target, transfer] = post.mock.calls[0] as unknown as [
      unknown,
      string,
      MessagePort[],
    ];
    expect(message).toEqual({ source: CAGE_MESSAGE_SOURCE, channel, type: 'port' });
    expect(target).toBe('*');
    expect(transfer).toHaveLength(1);

    const framePort = transfer[0];
    const init = await new Promise<Record<string, unknown>>((resolve) => {
      framePort.onmessage = (event) => resolve(event.data as Record<string, unknown>);
    });
    expect(init).toMatchObject({
      type: 'init',
      pluginId: 'demo.shop',
      apiVersion: PLUGIN_API_VERSION,
      entry: 'index.html',
      theme: { '--theme-accent': '#c33' },
    });
    expect((init.files as unknown[]).length).toBe(1);

    framePort.close();
    handle.dispose();
  });

  it('ready 只回调一次，env 字段被规整成布尔', async () => {
    const onReady = vi.fn();
    const { frame, handle } = mount({ onReady });
    const post = (frame.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
      .postMessage;
    const channel = /"channel":"([^"]+)"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-ready' });
    const framePort = (post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0];
    framePort.postMessage({ type: 'ready', env: { hasSaveFilePicker: true, extra: 1 } });
    framePort.postMessage({ type: 'ready', env: {} });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      hasSaveFilePicker: true,
      hasOpenFilePicker: false,
      hasDirectoryPicker: false,
    });
    framePort.close();
    handle.dispose();
  });

  it('ready 带 error：不当成功回调 onReady，改调 onLoadError 并带上错误与环境', async () => {
    const onReady = vi.fn();
    const onLoadError = vi.fn();
    const { frame, handle } = mount({ onReady, onLoadError });
    const post = (frame.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
      .postMessage;
    const channel = /"channel":"([^"]+)"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-ready' });
    const framePort = (post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0];
    framePort.postMessage({ type: 'ready', env: {}, error: '入口文件不存在：missing.html' });
    framePort.postMessage({ type: 'ready', env: {} });
    await vi.waitFor(() => expect(onLoadError).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError).toHaveBeenCalledWith('入口文件不存在：missing.html', {
      hasSaveFilePicker: false,
      hasOpenFilePicker: false,
      hasDirectoryPicker: false,
    });
    // 之后再来的 ready 也不会被当成功
    expect(onReady).not.toHaveBeenCalled();
    framePort.close();
    handle.dispose();
  });

  it('ready 带 error 且未提供 onLoadError：仍不回调 onReady', async () => {
    const onReady = vi.fn();
    const { frame, handle } = mount({ onReady });
    const post = (frame.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
      .postMessage;
    const channel = /"channel":"([^"]+)"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-ready' });
    const framePort = (post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0];
    framePort.postMessage({ type: 'ready', env: {}, error: 'boom' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onReady).not.toHaveBeenCalled();
    framePort.close();
    handle.dispose();
  });

  it('cage-violation：回调 onViolation 并拆除；其他来源发来的同形消息不算', () => {
    const onViolation = vi.fn();
    const { container, frame, handle } = mount({ onViolation });
    const channel = /"channel":"([^"]+)"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-violation' }, window);
    expect(onViolation).not.toHaveBeenCalled();

    cageSays(frame, { source: CAGE_MESSAGE_SOURCE, channel, type: 'cage-violation' });
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(0);
    handle.dispose();
  });
});

describe('主题过滤', () => {
  it('只留 --theme-* 且值为字符串的项', () => {
    expect(
      filterPluginThemeValues({
        '--theme-bg': '#000',
        '--theme-n': 3,
        '--other': 'x',
        color: 'red',
      }),
    ).toEqual({ '--theme-bg': '#000' });
    expect(filterPluginThemeValues(null)).toEqual({});
  });

  it('帧内也只应用 --theme-*，后续 theme 消息替换旧值', async () => {
    const booted = bootBootstrap();
    await initFrame(booted, {
      entry: 'index.html',
      files: SIMPLE_ENTRY,
      theme: { '--theme-bg': '#111', color: 'red', '--theme-x': 5 },
    });
    const style = booted.win.document.documentElement.style;
    expect(style.getPropertyValue('--theme-bg')).toBe('#111');
    expect(style.getPropertyValue('color')).toBe('');
    expect(style.getPropertyValue('--theme-x')).toBe('');

    booted.deliver({ type: 'theme', values: { '--theme-fg': '#eee', 'font-size': '99px' } });
    expect(style.getPropertyValue('--theme-fg')).toBe('#eee');
    expect(style.getPropertyValue('--theme-bg')).toBe('');
    expect(style.getPropertyValue('font-size')).toBe('');
  });
});

describe('帧内引导脚本', () => {
  it('启动即向 parent 发出牢笼要求的 boot 消息', () => {
    const booted = bootBootstrap();
    expect(booted.parentPosts).toEqual([
      { source: CAGE_MESSAGE_SOURCE, channel: booted.channel, type: 'boot' },
    ]);
  });

  it('不是 parent 发来、或 channel 不符的端口消息不接收', () => {
    const booted = bootBootstrap();
    const event = new booted.win.Event('message');
    Object.defineProperty(event, 'data', {
      value: { source: CAGE_MESSAGE_SOURCE, channel: booted.channel, type: 'port' },
    });
    Object.defineProperty(event, 'source', { value: booted.win });
    Object.defineProperty(event, 'ports', { value: [booted.port] });
    booted.win.dispatchEvent(event);
    expect(booted.port.onmessage).toBeNull();
    booted.handOff();
    expect(booted.port.onmessage).toBeTypeOf('function');
  });

  it('ready 携带插件代码运行前取到的文件选择器环境', async () => {
    const booted = bootBootstrap({
      beforeRun: (win) => {
        (win as unknown as Record<string, unknown>).showSaveFilePicker = () => undefined;
      },
    });
    const ready = await initFrame(booted, { entry: 'index.html', files: SIMPLE_ENTRY });
    expect(ready.env).toEqual({
      hasSaveFilePicker: true,
      hasOpenFilePicker: false,
      hasDirectoryPicker: false,
    });
    expect(ready.error).toBeUndefined();
  });

  it('入口不存在：仍发 ready 并带 error', async () => {
    const booted = bootBootstrap();
    const ready = await initFrame(booted, { entry: 'missing.html', files: SIMPLE_ENTRY });
    expect(ready.error).toContain('missing.html');
  });

  it('装载器：相对引用改写为帧内 blob URL，脚本按序重建，插件代码不进引导脚本', async () => {
    const marker = 'PLUGIN_UNIQUE_MARKER_42';
    const html = `<!doctype html><html data-app="x"><head>
<link rel="stylesheet" href="./css/main.css">
<style>.bg{background:url('img/bg.png')}</style>
<script src="js/lib.js"></script>
<script>window.${marker} = 1;</script>
</head><body style="background-image:url(img/bg.png)">
<img id="logo" src="img/logo.svg#mark" srcset="img/logo.svg 1x, img/bg.png 2x">
<a id="link" href="img/logo.svg">外链</a>
<img id="ext" src="data:image/png;base64,AA==">
</body></html>`;
    const files = [
      file('index.html', 'text/html', html),
      file('css/main.css', 'text/css', '@import "reset.css"; .x{background:url(../img/bg.png)}'),
      file('css/reset.css', 'text/css', '*{margin:0}'),
      file('img/bg.png', 'image/png', 'png'),
      file('img/logo.svg', 'image/svg+xml', '<svg/>'),
      file('js/lib.js', 'text/javascript', 'window.LIB = 1;'),
    ];
    const booted = bootBootstrap();
    await initFrame(booted, { entry: 'index.html', files });
    const doc = booted.win.document;

    const link = doc.querySelector('link') as HTMLLinkElement;
    const cssUrl = link.getAttribute('href') ?? '';
    expect(cssUrl).toMatch(/^blob:frame\//);
    const cssText = await (booted.blobs.get(cssUrl) as Blob).text();
    expect(cssText).toMatch(/@import "blob:frame\/\d+"/);
    expect(cssText).toMatch(/url\("blob:frame\/\d+"\)/);
    expect(cssText).not.toContain('../img/bg.png');

    expect(doc.querySelector('style')?.textContent).toMatch(/url\("blob:frame\/\d+"\)/);
    expect(doc.body.getAttribute('style')).toMatch(/url\("blob:frame\/\d+"\)/);
    expect(doc.documentElement.getAttribute('data-app')).toBe('x');

    const logo = doc.getElementById('logo') as HTMLImageElement;
    expect(logo.getAttribute('src')).toMatch(/^blob:frame\/\d+#mark$/);
    expect(logo.getAttribute('srcset')).toMatch(/^blob:frame\/\d+ 1x, blob:frame\/\d+ 2x$/);
    // 会导航的 href 与外部 data: 引用保持原样
    expect(doc.getElementById('link')?.getAttribute('href')).toBe('img/logo.svg');
    expect(doc.getElementById('ext')?.getAttribute('src')).toBe('data:image/png;base64,AA==');

    // 引导脚本已移除自身；插件脚本按原顺序重建为独立元素
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts).toHaveLength(2);
    expect(scripts[0].getAttribute('src')).toMatch(/^blob:frame\//);
    expect(scripts[1].text).toContain(marker);

    // 插件代码从不出现在宿主生成的任何文档里
    const { cage } = buildPluginFrameDocument({ network: [], channel: booted.channel });
    expect(cage).not.toContain(marker);
    expect(innerOf(cage)).not.toContain(marker);
  });

  it('host.assets：read / readText / url 在帧内提供，缺失文件报 NOT_FOUND', async () => {
    const booted = bootBootstrap();
    await initFrame(booted, {
      entry: 'index.html',
      files: [...SIMPLE_ENTRY, file('data/a.json', 'application/json', '{"a":1}')],
    });
    const assets = hostOf(booted).assets as {
      read(path: string): Promise<ArrayBuffer>;
      readText(path: string): Promise<string>;
      url(path: string): string;
    };
    expect(await assets.readText('./data/a.json')).toBe('{"a":1}');
    expect((await assets.read('data/a.json')).byteLength).toBe(7);
    expect(assets.url('data/a.json')).toMatch(/^blob:frame\//);
    await expect(assets.readText('nope.json')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => assets.url('nope.json')).toThrow();
    // 资源调用不经端口
    expect(booted.sent().filter((m) => m.type === 'req')).toHaveLength(0);
  });
});

describe('帧内 host API', () => {
  async function ready() {
    const booted = bootBootstrap();
    await initFrame(booted, { entry: 'index.html', files: SIMPLE_ENTRY });
    return booted;
  }

  function respond(booted: Booted, extra: Record<string, unknown>) {
    const req = lastReq(booted);
    booted.deliver({ type: 'res', id: req.id, ...extra });
  }

  const pick = (host: HostApi, path: string) =>
    path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown>)[key], host) as (
      ...args: unknown[]
    ) => Promise<unknown>;

  const CASES: { call: string; args: unknown[]; method: string; sentArgs: unknown[] }[] = [
    { call: 'read', args: ['player.money'], method: 'read', sentArgs: ['player.money'] },
    {
      call: 'storage.save.get',
      args: ['k'],
      method: 'storage.save.get',
      sentArgs: ['k'],
    },
    {
      call: 'storage.save.set',
      args: ['k', { v: 1 }],
      method: 'storage.save.set',
      sentArgs: ['k', { v: 1 }],
    },
    { call: 'storage.save.remove', args: ['k'], method: 'storage.save.remove', sentArgs: ['k'] },
    { call: 'storage.global.get', args: ['g'], method: 'storage.global.get', sentArgs: ['g'] },
    {
      call: 'storage.global.set',
      args: ['g', 2],
      method: 'storage.global.set',
      sentArgs: ['g', 2],
    },
    {
      call: 'storage.global.remove',
      args: ['g'],
      method: 'storage.global.remove',
      sentArgs: ['g'],
    },
    { call: 'ui.close', args: [], method: 'ui.close', sentArgs: [] },
    { call: 'ui.resize', args: [320, 240], method: 'ui.resize', sentArgs: [320, 240] },
    { call: 'ui.toast', args: ['好'], method: 'ui.toast', sentArgs: ['好'] },
    { call: 'ui.fillInput', args: ['去集市'], method: 'ui.fillInput', sentArgs: ['去集市'] },
    {
      call: 'ui.openExternal',
      args: ['https:x'],
      method: 'ui.openExternal',
      sentArgs: ['https:x'],
    },
    { call: 'ai.note', args: ['记一笔'], method: 'ai.note', sentArgs: ['记一笔'] },
    {
      call: 'ai.note',
      args: ['给玩家看', { visible: true }],
      method: 'ai.note',
      sentArgs: ['给玩家看', { visible: true }],
    },
    { call: 'ai.context.set', args: ['常驻'], method: 'ai.context.set', sentArgs: ['常驻'] },
    { call: 'ai.context.set', args: [], method: 'ai.context.set', sentArgs: [null] },
  ];

  it.each(CASES)('$call 发出 req（$method）并在对应 res 上兑现 value', async (c) => {
    const booted = await ready();
    const promise = pick(hostOf(booted), c.call)(...c.args);
    const req = lastReq(booted);
    expect(req.method).toBe(c.method);
    expect(req.args).toEqual(c.sentArgs);
    // 不相干的 id 不会兑现它
    booted.deliver({ type: 'res', id: req.id + 1000, ok: true, value: 'wrong' });
    respond(booted, { ok: true, value: { echo: c.method } });
    await expect(promise).resolves.toEqual({ echo: c.method });
  });

  it('失败的 res 以带 code / index 的 Error 拒绝', async () => {
    const booted = await ready();
    const promise = (hostOf(booted).read as (v: string) => Promise<unknown>)('secret');
    respond(booted, { ok: false, code: 'DENIED', message: '未声明的投影', index: 2 });
    await expect(promise).rejects.toMatchObject({
      code: 'DENIED',
      index: 2,
      message: '未声明的投影',
    });
  });

  it('commit 兑现完整的 CommitResult（成功与失败都不抛）', async () => {
    const booted = await ready();
    const commit = hostOf(booted).commit as (input: unknown) => Promise<unknown>;
    const input = { commands: [{ type: 'money.add', amount: 5 }] };
    const ok = commit(input);
    expect(lastReq(booted)).toMatchObject({ method: 'commit', args: [input] });
    respond(booted, { ok: true });
    await expect(ok).resolves.toEqual({ ok: true });

    const bad = commit(input);
    respond(booted, { ok: false, code: 'PRECONDITION_FAILED', message: '钱不够', index: 0 });
    await expect(bad).resolves.toEqual({
      ok: false,
      code: 'PRECONDITION_FAILED',
      message: '钱不够',
      index: 0,
    });
  });

  it('subscribe / unsubscribe：发 req，view 推送分发给回调，取消后不再收到', async () => {
    const booted = await ready();
    const host = hostOf(booted);
    const cb = vi.fn();
    const pending = (host.subscribe as (v: string, cb: unknown) => Promise<() => Promise<void>>)(
      'player.money',
      cb,
    );
    expect(lastReq(booted)).toMatchObject({ method: 'subscribe', args: ['player.money'] });
    respond(booted, { ok: true });
    const off = await pending;

    booted.deliver({ type: 'view', view: 'player.money', value: 12 });
    booted.deliver({ type: 'view', view: 'other', value: 99 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(12);

    const done = off();
    expect(lastReq(booted)).toMatchObject({ method: 'unsubscribe', args: ['player.money'] });
    respond(booted, { ok: true });
    await done;
    booted.deliver({ type: 'view', view: 'player.money', value: 13 });
    expect(cb).toHaveBeenCalledTimes(1);

    // 直接调 host.unsubscribe 同样发 req
    const direct = (host.unsubscribe as (v: string) => Promise<void>)('player.money');
    expect(lastReq(booted)).toMatchObject({ method: 'unsubscribe', args: ['player.money'] });
    respond(booted, { ok: true });
    await expect(direct).resolves.toBeUndefined();
  });

  it('on / off：事件推送分发给回调；被拒时回调被撤下', async () => {
    const booted = await ready();
    const host = hostOf(booted);
    const cb = vi.fn();
    const pending = (host.on as (n: string, cb: unknown) => Promise<() => Promise<void>>)(
      'turn.end',
      cb,
    );
    expect(lastReq(booted)).toMatchObject({ method: 'on', args: ['turn.end'] });
    respond(booted, { ok: true });
    await pending;
    booted.deliver({ type: 'event', name: 'turn.end', payload: { turn: 3 } });
    expect(cb).toHaveBeenCalledWith({ turn: 3 });

    const off = (host.off as (n: string, cb?: unknown) => Promise<void>)('turn.end', cb);
    expect(lastReq(booted)).toMatchObject({ method: 'off', args: ['turn.end'] });
    respond(booted, { ok: true });
    await off;

    const denied = vi.fn();
    const rejected = (host.on as (n: string, cb: unknown) => Promise<unknown>)(
      'combat.start',
      denied,
    );
    respond(booted, { ok: false, code: 'DENIED', message: '未声明的事件' });
    await expect(rejected).rejects.toMatchObject({ code: 'DENIED' });
    booted.deliver({ type: 'event', name: 'combat.start', payload: {} });
    expect(denied).not.toHaveBeenCalled();
  });

  it('host 对象冻结，任何层级都拿不到原始端口', async () => {
    const booted = await ready();
    const host = hostOf(booted);
    expect(Object.isFrozen(host)).toBe(true);
    const seen = new Set<unknown>();
    const walk = (value: unknown) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
      if (seen.has(value)) return;
      seen.add(value);
      expect(value).not.toBe(booted.port);
      for (const key of Object.keys(value as object)) walk((value as Record<string, unknown>)[key]);
    };
    walk(host);
    expect(Object.keys(host)).not.toContain('port');
    expect(() => {
      (booted.win as unknown as { host: unknown }).host = {};
    }).toThrow();
  });

  it('改了 MessageEvent.prototype.data 的插件也截不到端口事件', async () => {
    const booted = await ready();
    const captured: unknown[] = [];
    const proto = booted.win.MessageEvent.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'data');
    Object.defineProperty(proto, 'data', {
      configurable: true,
      get(this: MessageEvent) {
        captured.push(this.target);
        return original?.get?.call(this);
      },
    });
    const promise = (hostOf(booted).read as (v: string) => Promise<unknown>)('x');
    respond(booted, { ok: true, value: 1 });
    await expect(promise).resolves.toBe(1);
    expect(captured).toHaveLength(0);
    if (original) Object.defineProperty(proto, 'data', original);
  });
});
