/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameDocument,
  isBeautifierFrameMessage,
  recommendedFrameMinHeight,
  splitRichDocument,
} from './beautifier-frame';

describe('beautifier iframe document', () => {
  it('retains fenced full-document rule CSS, markup, and scripts', () => {
    const parts = splitRichDocument(
      '```html\n<!doctype html><html><head><style>.card{color:red}</style></head>' +
        '<body><div class="card">legacy</div><script>window.ready=true</script></body></html>\n```',
    );

    expect(parts.head).toContain('.card{color:red}');
    expect(parts.body).toContain('<div class="card">legacy</div>');
    expect(parts.body).toContain('<script>window.ready=true</script>');
    expect(parts.htmlAttributes).toBe('');
    expect(parts.bodyAttributes).toBe('');
    expect(recommendedFrameMinHeight('<!doctype html><html></html>')).toBe(240);
    expect(recommendedFrameMinHeight('<span>inline</span>')).toBe(1);
  });

  it('allows remote resources in an opaque script sandbox without sanitizing markup', () => {
    const document = buildBeautifierFrameDocument({
      markup:
        '<button onclick="clicked()">open</button>' +
        '<script>fetch("https://example.com")</script>',
      bridgeId: 'bridge-1',
    });

    expect(BEAUTIFIER_FRAME_SANDBOX).toBe('allow-scripts');
    for (const blockedCapability of [
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-downloads',
      'allow-top-navigation',
    ]) {
      expect(BEAUTIFIER_FRAME_SANDBOX).not.toContain(blockedCapability);
    }
    expect(document).toContain('connect-src http: https: ws: wss: data: blob:');
    expect(document).toContain('default-src http: https: data: blob:');
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("form-action 'none'");
    const policy = document.match(/Content-Security-Policy" content="([^"]+)/)?.[1] ?? '';
    expect(policy).toContain('https:');
    expect(policy).toContain('unsafe-eval');
    expect(document).toContain('onclick="clicked()"');
    expect(document).toContain('<script>fetch("https://example.com")</script>');
  });

  it('accepts only bridge messages for the current frame', () => {
    expect(
      isBeautifierFrameMessage(
        { source: 'fated-poem-beautifier', bridgeId: 'a', type: 'height', height: 100 },
        'a',
      ),
    ).toBe(true);
    expect(
      isBeautifierFrameMessage(
        { source: 'fated-poem-beautifier', bridgeId: 'stale', type: 'height' },
        'a',
      ),
    ).toBe(false);
    expect(
      isBeautifierFrameMessage(
        {
          source: 'fated-poem-beautifier',
          bridgeId: 'a',
          type: 'storage-mutate',
          sequence: 1,
          mutations: [{ kind: 'set', key: 'theme', value: 'dark' }],
        },
        'a',
      ),
    ).toBe(true);
    expect(
      isBeautifierFrameMessage(
        {
          source: 'fated-poem-beautifier',
          bridgeId: 'a',
          type: 'storage-mutate',
          sequence: 1,
          mutations: [{ kind: 'set', key: 'theme' }],
        },
        'a',
      ),
    ).toBe(false);
  });

  it('hydrates the shared regex namespace before legacy head scripts run', () => {
    const document = buildBeautifierFrameDocument({
      markup:
        '<!doctype html><html><head><script>window.initialTheme=localStorage.getItem("theme")</script></head>' +
        '<body>body</body></html>',
      bridgeId: 'bridge-2',
      storageEntries: [['theme', 'dark']],
    });

    expect(document.indexOf('const __beautifierPersistentStorage')).toBeLessThan(
      document.indexOf('window.initialTheme=localStorage'),
    );
    expect(document).toContain('[["theme","dark"]]');
    expect(document).toContain("Object.defineProperty(window, 'regexStorage'");
    expect(document).toContain("post('storage-mutate'");
    expect(document).toContain('mutations.slice(offset, offset + __beautifierStorageBatchSize)');
    expect(document).toContain("data.type === 'storage-sync'");
    expect(document).toContain('Object.defineProperty(window, name');
    expect(document).toContain('window.TavernHelper = helper');
    expect(document).toContain('window.SillyTavern =');
    expect(document).not.toContain('window.fetch = blockedNetwork');
    expect(document).not.toContain('navigator.sendBeacon = () => false');
    expect(document).toContain('window.open = () => null');
    expect(document).toContain('fixedOverlayHeight');
    expect(document).toContain('new MutationObserver(scheduleMeasure)');

    const bootstrap = document.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
    expect(bootstrap).toBeTruthy();
    expect(() => new Function(bootstrap!)).not.toThrow();
  });

  it('escapes persisted values before embedding them in the bootstrap script', () => {
    const document = buildBeautifierFrameDocument({
      markup: '<p>safe body</p>',
      bridgeId: 'bridge-storage-escape',
      storageEntries: [['payload', '</script><script>window.escaped=false</script>']],
    });

    expect(document).not.toContain('</script><script>window.escaped=false</script>');
    expect(document).toContain('\\u003c/script>\\u003cscript>window.escaped=false\\u003c/script>');
    const bootstrap = document.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
    expect(() => new Function(bootstrap!)).not.toThrow();
  });

  it('executes and splits large ordered mutation bursts into valid bridge batches', async () => {
    const frameDocument = buildBeautifierFrameDocument({
      markup: '<p>runtime</p>',
      bridgeId: 'bridge-runtime',
    });
    const bootstrap = frameDocument.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
    expect(bootstrap).toBeTruthy();

    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const child = iframe.contentWindow! as Window & typeof globalThis;
    Object.defineProperties(child, {
      TextEncoder: { configurable: true, value: TextEncoder },
      ResizeObserver: {
        configurable: true,
        value: class {
          observe() {}
        },
      },
      requestAnimationFrame: { configurable: true, value: () => 1 },
    });
    const postMessage = vi.fn();
    Object.defineProperty(child, '__captureBeautifierMessage', {
      configurable: true,
      value: postMessage,
    });
    const runtimeBootstrap = bootstrap!.replace(
      "parent.postMessage({ source, bridgeId, type, ...detail }, '*');",
      'window.__captureBeautifierMessage({ source, bridgeId, type, ...detail });',
    );
    expect(runtimeBootstrap).not.toBe(bootstrap);

    try {
      const run = child.Function(
        `${runtimeBootstrap}\nfor (let i = 0; i < 1025; i++) localStorage.setItem('same', String(i));`,
      );
      run();
      await Promise.resolve();

      const batches = postMessage.mock.calls
        .map(([message]) => message as { type?: string; mutations?: unknown[] })
        .filter((message) => message.type === 'storage-mutate');
      expect(batches.map((message) => message.mutations?.length)).toEqual([1024, 1]);
    } finally {
      iframe.remove();
    }
  });

  it('preserves document attributes and content outside an embedded HTML fence', () => {
    const parts = splitRichDocument(
      '<StatusPlaceHolderImpl/>```html\n<!doctype html><html class="theme"><head></head>' +
        '<body class="viewer"><main>content</main></body></html>\n```',
    );

    expect(parts.htmlAttributes).toBe('class="theme"');
    expect(parts.bodyAttributes).toBe('class="viewer"');
    expect(parts.body).toContain('<StatusPlaceHolderImpl/>');
    expect(parts.body).toContain('<main>content</main>');
  });
});
