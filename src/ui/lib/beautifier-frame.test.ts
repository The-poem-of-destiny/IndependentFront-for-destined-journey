import { describe, expect, it } from 'vitest';
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
  });

  it('installs frame-local storage and host-API shims before legacy head scripts run', () => {
    const document = buildBeautifierFrameDocument({
      markup:
        '<!doctype html><html><head><script>window.legacyHeadRan=true</script></head>' +
        '<body>body</body></html>',
      bridgeId: 'bridge-2',
    });

    expect(document.indexOf('const localStorage = __beautifierMakeStorage()')).toBeLessThan(
      document.indexOf('window.legacyHeadRan=true'),
    );
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
