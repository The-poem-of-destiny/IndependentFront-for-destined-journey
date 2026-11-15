/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  buildCageDocument,
  CAGE_MESSAGE_SOURCE,
  type CageDocumentOptions,
  type CageHostMessage,
} from '../../../src/ui/lib/frame-cage';

const CSP = "default-src 'none'; script-src 'unsafe-inline'; frame-src 'none'";

function options(overrides: Partial<CageDocumentOptions> = {}): CageDocumentOptions {
  return {
    csp: CSP,
    inner: '<!doctype html><p>插件正文</p>',
    innerMode: 'srcdoc',
    link: 'relay',
    channel: 'chan-1',
    ...overrides,
  };
}

interface FakeEventInit {
  data: unknown;
  source: unknown;
  ports?: unknown[];
}

/**
 * 在 jsdom 里真跑牢笼脚本：从生成的文档里取出唯一那段宿主脚本，放进一个全新的
 * 子窗口执行；`parent` 换成可观察的假宿主，`URL.createObjectURL` 由测试提供
 * （jsdom 没实现）。返回牢笼窗口、内层 iframe 与宿主收到的消息。
 */
function bootCage(opts: CageDocumentOptions) {
  const hostMessages: { data: unknown; ports: unknown[] }[] = [];
  const host = {
    postMessage: vi.fn((data: unknown, _origin: string, ports: unknown[] = []) => {
      hostMessages.push({ data, ports });
    }),
  };
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:cage-test');
  const revokeObjectURL = vi.fn();

  const parsed = new DOMParser().parseFromString(buildCageDocument(opts), 'text/html');
  const scripts = parsed.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  const source = scripts[0].textContent ?? '';

  const holder = document.createElement('iframe');
  document.body.appendChild(holder);
  const cageWindow = holder.contentWindow as Window & typeof globalThis;
  const run = new Function(
    'parent',
    'addEventListener',
    'removeEventListener',
    'document',
    'URL',
    'Blob',
    source,
  ) as (...args: unknown[]) => void;
  run(
    host,
    cageWindow.addEventListener.bind(cageWindow),
    cageWindow.removeEventListener.bind(cageWindow),
    cageWindow.document,
    { createObjectURL, revokeObjectURL },
    Blob,
  );

  const frame = cageWindow.document.querySelector('iframe');
  const innerPosts: { data: unknown; ports: unknown[] }[] = [];
  const innerWindow = frame?.contentWindow ?? null;
  if (innerWindow) {
    Object.defineProperty(innerWindow, 'postMessage', {
      configurable: true,
      value: (data: unknown, _origin: string, ports: unknown[] = []) => {
        innerPosts.push({ data, ports });
      },
    });
  }
  const dispatch = ({ data, source: from, ports = [] }: FakeEventInit) => {
    const event = new cageWindow.Event('message');
    Object.defineProperty(event, 'data', { value: data });
    Object.defineProperty(event, 'source', { value: from });
    Object.defineProperty(event, 'ports', { value: ports });
    cageWindow.dispatchEvent(event);
  };
  const fireInnerLoad = () => frame?.dispatchEvent(new cageWindow.Event('load'));
  return {
    window: cageWindow,
    frame,
    host,
    hostMessages,
    innerWindow,
    innerPosts,
    dispatch,
    fireInnerLoad,
    createObjectURL,
    revokeObjectURL,
  };
}

function lastHostMessage(cage: ReturnType<typeof bootCage>): unknown {
  return cage.hostMessages[cage.hostMessages.length - 1]?.data;
}

function cageMessage(type: CageHostMessage['type'], channel = 'chan-1'): CageHostMessage {
  return { source: CAGE_MESSAGE_SOURCE, channel, type };
}

describe('牢笼帧文档结构', () => {
  it('带传入的 CSP meta，且 CSP 中的引号被转义成属性安全形式', () => {
    const html = buildCageDocument(options({ csp: `default-src 'none'; x "y"` }));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(meta?.getAttribute('content')).toBe(`default-src 'none'; x "y"`);
  });

  it('提供 scriptNonce 时宿主脚本带 nonce，不提供时不带', () => {
    const withNonce = new DOMParser().parseFromString(
      buildCageDocument(options({ scriptNonce: 'abc123+/=' })),
      'text/html',
    );
    expect(withNonce.querySelector('script')?.getAttribute('nonce')).toBe('abc123+/=');

    const without = new DOMParser().parseFromString(buildCageDocument(options()), 'text/html');
    expect(without.querySelector('script')?.hasAttribute('nonce')).toBe(false);
  });

  it('非法 nonce 直接拒绝，不拼进属性', () => {
    expect(() => buildCageDocument(options({ scriptNonce: '"><script>' }))).toThrow();
  });

  it('文档里只有一段宿主脚本，没有任何静态 iframe', () => {
    const doc = new DOMParser().parseFromString(buildCageDocument(options()), 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('恶意 inner 含 </script><script> 也无法越出宿主脚本', () => {
    const evil =
      '</script><script>window.__pwned = true</script><img src=x onerror="window.__pwned=1">' +
      '<!-- \u2028 \u2029 "quote"';
    const html = buildCageDocument(options({ inner: evil }));
    expect(html).not.toContain('</script><script>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('img')).toHaveLength(0);

    // 真跑一遍：脚本完好执行，inner 原样落进内层 srcdoc，宿主窗口没被污染。
    const cage = bootCage(options({ inner: evil }));
    expect(cage.frame?.getAttribute('srcdoc')).toBe(evil);
    expect((cage.window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(cage.hostMessages.map((m) => m.data)).toContainEqual(cageMessage('cage-ready'));
  });

  it('channel 里的 </script> 同样被转义', () => {
    const html = buildCageDocument(options({ channel: '</script><b>x</b>' }));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('b')).toBeNull();
  });
});

describe('内层帧装载', () => {
  it('srcdoc 模式：inner 写进 srcdoc，不挂 sandbox，不用 blob', () => {
    const cage = bootCage(options({ innerMode: 'srcdoc' }));
    expect(cage.frame?.getAttribute('srcdoc')).toBe('<!doctype html><p>插件正文</p>');
    expect(cage.frame?.hasAttribute('sandbox')).toBe(false);
    expect(cage.frame?.hasAttribute('allow')).toBe(false);
    expect(cage.frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(cage.createObjectURL).not.toHaveBeenCalled();
  });

  it('blob 模式：inner 以 text/html Blob 经 object URL 装载，首次 load 后回收', async () => {
    const cage = bootCage(options({ innerMode: 'blob' }));
    expect(cage.createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = cage.createObjectURL.mock.calls[0];
    expect(blob.type).toBe('text/html');
    expect(await blob.text()).toBe('<!doctype html><p>插件正文</p>');
    expect(cage.frame?.getAttribute('src')).toBe('blob:cage-test');
    expect(cage.frame?.hasAttribute('srcdoc')).toBe(false);

    cage.fireInnerLoad();
    expect(cage.revokeObjectURL).toHaveBeenCalledWith('blob:cage-test');
  });

  it('启动即上报 cage-ready，内层首次 load 上报 inner-ready', () => {
    const cage = bootCage(options());
    expect(cage.hostMessages.map((m) => m.data)).toEqual([cageMessage('cage-ready')]);
    cage.fireInnerLoad();
    expect(cage.hostMessages.map((m) => m.data)).toEqual([
      cageMessage('cage-ready'),
      cageMessage('inner-ready'),
    ]);
  });

  it('内层第二次 load（被导航走）：拆掉内层并上报 cage-violation', () => {
    const cage = bootCage(options());
    cage.fireInnerLoad();
    cage.fireInnerLoad();
    expect(cage.window.document.querySelector('iframe')).toBeNull();
    expect(lastHostMessage(cage)).toEqual(cageMessage('cage-violation'));

    // 违规后不再转发任何消息。
    cage.dispatch({ data: { hello: 1 }, source: cage.host });
    expect(cage.innerPosts).toHaveLength(0);
  });
});

describe('relay 连接', () => {
  it('宿主 → 内层、内层 → 宿主的消息原样双向转发（含端口）', () => {
    const cage = bootCage(options({ link: 'relay' }));
    const port = { fake: 'port' };
    cage.dispatch({ data: { type: 'theme', values: { a: 1 } }, source: cage.host, ports: [port] });
    expect(cage.innerPosts).toEqual([{ data: { type: 'theme', values: { a: 1 } }, ports: [port] }]);

    const ready = { source: 'fated-poem-beautifier', bridgeId: 'b', type: 'ready' };
    cage.dispatch({ data: ready, source: cage.innerWindow });
    expect(cage.hostMessages[cage.hostMessages.length - 1]).toEqual({ data: ready, ports: [] });
  });

  it('内层冒充牢笼协议的消息不转给宿主，宿主的牢笼协议消息也不转给内层', () => {
    const cage = bootCage(options({ link: 'relay' }));
    const before = cage.hostMessages.length;
    cage.dispatch({ data: cageMessage('cage-violation'), source: cage.innerWindow });
    expect(cage.hostMessages).toHaveLength(before);

    cage.dispatch({
      data: { source: CAGE_MESSAGE_SOURCE, channel: 'chan-1', type: 'port' },
      source: cage.host,
    });
    expect(cage.innerPosts).toHaveLength(0);
  });

  it('来源既非宿主也非内层的消息一律丢弃', () => {
    const cage = bootCage(options({ link: 'relay' }));
    const before = cage.hostMessages.length;
    cage.dispatch({ data: { x: 1 }, source: { stranger: true } });
    expect(cage.innerPosts).toHaveLength(0);
    expect(cage.hostMessages).toHaveLength(before);
  });
});

describe('port-handoff 连接', () => {
  const portMessage = { source: CAGE_MESSAGE_SOURCE, channel: 'chan-1', type: 'port' };
  const bootMessage = { source: CAGE_MESSAGE_SOURCE, channel: 'chan-1', type: 'boot' };

  it('先收端口后收 boot：boot 到达时把端口转交内层', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    const port = { close: vi.fn() };
    cage.dispatch({ data: portMessage, source: cage.host, ports: [port] });
    expect(cage.innerPosts).toHaveLength(0);

    cage.dispatch({ data: bootMessage, source: cage.innerWindow });
    expect(cage.innerPosts).toEqual([{ data: portMessage, ports: [port] }]);
  });

  it('先收 boot 后收端口：端口一到即转交', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    const port = { close: vi.fn() };
    cage.dispatch({ data: bootMessage, source: cage.innerWindow });
    cage.dispatch({ data: portMessage, source: cage.host, ports: [port] });
    expect(cage.innerPosts).toEqual([{ data: portMessage, ports: [port] }]);
  });

  it('转交后不再转发任何消息，第二个端口也不会再交出', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    cage.dispatch({ data: portMessage, source: cage.host, ports: [{ close: vi.fn() }] });
    cage.dispatch({ data: bootMessage, source: cage.innerWindow });
    const hostBefore = cage.hostMessages.length;

    cage.dispatch({ data: portMessage, source: cage.host, ports: [{ close: vi.fn() }] });
    cage.dispatch({ data: { any: 1 }, source: cage.host });
    cage.dispatch({ data: { any: 2 }, source: cage.innerWindow });
    expect(cage.innerPosts).toHaveLength(1);
    expect(cage.hostMessages).toHaveLength(hostBefore);
  });

  it('不是 boot 形状的内层消息、channel 不符的端口消息都不触发转交', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    cage.dispatch({
      data: { ...portMessage, channel: 'other' },
      source: cage.host,
      ports: [{ close: vi.fn() }],
    });
    cage.dispatch({ data: { type: 'boot' }, source: cage.innerWindow });
    cage.dispatch({ data: bootMessage, source: cage.innerWindow });
    expect(cage.innerPosts).toHaveLength(0);
  });

  it('普通消息不做 relay 转发', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    const before = cage.hostMessages.length;
    cage.dispatch({ data: { hello: 1 }, source: cage.host });
    cage.dispatch({ data: { hello: 2 }, source: cage.innerWindow });
    expect(cage.innerPosts).toHaveLength(0);
    expect(cage.hostMessages).toHaveLength(before);
  });

  it('端口未交出时违规：关闭端口并上报 cage-violation', () => {
    const cage = bootCage(options({ link: 'port-handoff' }));
    const port = { close: vi.fn() };
    cage.dispatch({ data: portMessage, source: cage.host, ports: [port] });
    cage.fireInnerLoad();
    cage.fireInnerLoad();
    expect(port.close).toHaveBeenCalled();
    expect(lastHostMessage(cage)).toEqual(cageMessage('cage-violation'));
  });
});
