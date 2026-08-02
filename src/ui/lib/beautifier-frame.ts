export const BEAUTIFIER_FRAME_SANDBOX = 'allow-scripts';

export const BEAUTIFIER_FRAME_MESSAGE_SOURCE = 'fated-poem-beautifier';

export const BEAUTIFIER_FRAME_CSP = [
  'default-src http: https: data: blob:',
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  'connect-src http: https: ws: wss: data: blob:',
  'worker-src blob:',
  "script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "script-src-attr 'unsafe-inline'",
  "style-src http: https: data: blob: 'unsafe-inline'",
  'img-src http: https: data: blob:',
  'font-src http: https: data: blob:',
  'media-src http: https: data: blob:',
  "manifest-src 'none'",
].join('; ');

export interface BeautifierFrameDocumentOptions {
  markup: string;
  bridgeId: string;
  forwardContextMenu?: boolean;
}

export interface BeautifierFrameMessage {
  source: typeof BEAUTIFIER_FRAME_MESSAGE_SOURCE;
  bridgeId: string;
  type: 'ready' | 'height' | 'contextmenu';
  height?: number;
  x?: number;
  y?: number;
}

interface RichDocumentParts {
  head: string;
  body: string;
  htmlAttributes: string;
  bodyAttributes: string;
}

/**
 * Several installed rules wrap a complete HTML document in a Markdown fence.
 * A beautifier iframe already owns the document shell, so retain the supplied
 * head/body contents while removing only those transport wrappers.
 */
export function splitRichDocument(markup: string): RichDocumentParts {
  let source = markup.trim();
  const outerFence = source.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (outerFence) source = outerFence[1].trim();
  else source = source.replace(/```(?:html)?\s*([\s\S]*?)\s*```/i, '$1');

  source = source.replace(/<!doctype[^>]*>/i, '');
  const htmlMatch = /<html(\s[^>]*)?>([\s\S]*?)<\/html\s*>/i.exec(source);
  const htmlAttributes = htmlMatch?.[1]?.trim() ?? '';
  const beforeHtml = htmlMatch ? source.slice(0, htmlMatch.index) : '';
  const afterHtml = htmlMatch ? source.slice(htmlMatch.index + htmlMatch[0].length) : '';
  const documentContent = htmlMatch?.[2] ?? source;
  const headMatch = /<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/i.exec(documentContent);
  const bodyMatch = /<body(\s[^>]*)?>([\s\S]*?)<\/body\s*>/i.exec(documentContent);
  const head = headMatch?.[1] ?? '';
  const bodyAttributes = bodyMatch?.[1]?.trim() ?? '';

  if (bodyMatch) {
    const beforeBody = documentContent.slice(0, bodyMatch.index).replace(headMatch?.[0] ?? '', '');
    const afterBody = documentContent.slice(bodyMatch.index + bodyMatch[0].length);
    return {
      head,
      body: `${beforeHtml}${beforeBody}${bodyMatch[2]}${afterBody}${afterHtml}`,
      htmlAttributes,
      bodyAttributes,
    };
  }

  if (htmlMatch) {
    return {
      head,
      body: `${beforeHtml}${documentContent.replace(headMatch?.[0] ?? '', '')}${afterHtml}`,
      htmlAttributes,
      bodyAttributes: '',
    };
  }

  return { head: '', body: source, htmlAttributes: '', bodyAttributes: '' };
}

export function recommendedFrameMinHeight(markup: string): number {
  return /<!doctype|<html[\s>]|<body[\s>]|position\s*:\s*fixed|<canvas[\s>]/i.test(markup)
    ? 240
    : 1;
}

/**
 * Build an opaque iframe document for one committed narrative message.
 *
 * This is intentionally not an HTML sanitizer: the rule's markup, styles,
 * inline handlers, and scripts are retained. The security boundary is the
 * opaque iframe sandbox plus CSP. Remote resources and network APIs are
 * available for workshop compatibility, while parent/storage access, nested
 * frames, forms, popups, downloads, external anchor navigation, and top-level
 * navigation remain blocked.
 */
export function buildBeautifierFrameDocument({
  markup,
  bridgeId,
  forwardContextMenu = false,
}: BeautifierFrameDocumentOptions): string {
  const parts = splitRichDocument(markup);
  const bridgeLiteral = JSON.stringify(bridgeId);
  const sourceLiteral = JSON.stringify(BEAUTIFIER_FRAME_MESSAGE_SOURCE);
  const contextMenuLiteral = forwardContextMenu ? 'true' : 'false';
  const mayUseFixedLayoutLiteral = /position\s*:\s*fixed/i.test(markup) ? 'true' : 'false';
  const htmlAttributes = /(?:^|\s)lang\s*=/i.test(parts.htmlAttributes)
    ? parts.htmlAttributes
    : `lang="zh-CN" ${parts.htmlAttributes}`.trim();

  return `<!doctype html>
<html ${htmlAttributes}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${BEAUTIFIER_FRAME_CSP}">
<style>
:root { color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-width: 0; background: transparent; }
body {
  color: var(--theme-text-primary, inherit);
  font-family: var(--theme-font-title, "Noto Serif SC", serif);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
[data-beautifier-source-text] { white-space: pre-wrap; }
img, svg, video, canvas { max-width: 100%; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
</style>
<script>
// window.localStorage throws for an opaque origin before user code can fall
// back. A global lexical binding shadows that accessor for ordinary legacy
// references while remaining private to this one frame/document.
const __beautifierMakeStorage = () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },
    key(index) { return [...values.keys()][Number(index)] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
  return new Proxy(storage, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver);
      return target.getItem(key);
    },
    set(target, key, value, receiver) {
      if (typeof key !== 'string' || key in target) return Reflect.set(target, key, value, receiver);
      target.setItem(key, value);
      return true;
    },
  });
};
const localStorage = __beautifierMakeStorage();
const sessionStorage = __beautifierMakeStorage();

(() => {
  'use strict';
  const bridgeId = ${bridgeLiteral};
  const source = ${sourceLiteral};
  const forwardContextMenu = ${contextMenuLiteral};
  const mayUseFixedLayout = ${mayUseFixedLayoutLiteral};
  let lastHeight = -1;
  let scheduled = false;

  // Opaque sandbox origins do not expose browser storage. A per-frame memory
  // implementation keeps existing UI preferences functional without exposing
  // the app's real localStorage/IndexedDB or persisting arbitrary rule data.
  for (const name of ['localStorage', 'sessionStorage']) {
    try { Object.defineProperty(window, name, { configurable: true, value: name === 'localStorage' ? localStorage : sessionStorage }); } catch (_) {}
  }

  // Common SillyTavern globals are represented by local, empty compatibility
  // surfaces. They let visual rules initialize, but deliberately expose no save,
  // message, credential, parent-DOM, or model-generation capability.
  const variables = Object.create(null);
  const assignVariables = (value) => {
    if (value && typeof value === 'object') Object.assign(variables, value);
    return true;
  };
  const helper = window.TavernHelper || {
    getVariables: () => variables,
    replaceVariables: assignVariables,
    insertOrAssignVariables: assignVariables,
    getCurrentMessageId: () => -1,
    generateRaw: async () => '',
  };
  try { window.TavernHelper = helper; } catch (_) {}
  if (typeof window.getVariables !== 'function') window.getVariables = helper.getVariables;
  if (typeof window.setVariables !== 'function') window.setVariables = assignVariables;
  if (typeof window.replaceVariables !== 'function') window.replaceVariables = assignVariables;
  if (!window.SillyTavern) {
    window.SillyTavern = {
      getContext: () => ({
        chat: [],
        chatMetadata: { variables },
        saveMetadata() {},
        saveChat() {},
        executeSlashCommandsWithOptions: async () => ({ pipe: '' }),
      }),
    };
  }
  if (!window.Mvu) {
    window.Mvu = {
      getMvuData: () => null,
      replaceMvuData: async () => false,
    };
  }
  if (!window._) {
    window._ = {
      get(object, path, fallback) {
        const value = String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], object);
        return value === undefined ? fallback : value;
      },
      set(object, path, value) {
        const keys = String(path).split('.');
        let current = object;
        while (keys.length > 1) {
          const key = keys.shift();
          if (!current[key] || typeof current[key] !== 'object') current[key] = {};
          current = current[key];
        }
        current[keys[0]] = value;
        return object;
      },
    };
  }

  // Navigation remains outside the compatibility surface. The sandbox omits
  // allow-popups/allow-forms/allow-downloads/top-navigation as the hard guard.
  try { window.open = () => null; } catch (_) {}

  const post = (type, detail = {}) => {
    parent.postMessage({ source, bridgeId, type, ...detail }, '*');
  };
  const measure = () => {
    scheduled = false;
    const root = document.documentElement;
    const body = document.body;
    let fixedOverlayHeight = 0;
    if (mayUseFixedLayout && body) {
      for (const element of body.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' || style.display === 'none' || style.visibility === 'hidden') {
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width >= root.clientWidth * 0.5 || rect.height >= 200) {
          fixedOverlayHeight = Math.min(900, Math.max(480, Math.floor((screen.availHeight || 720) * 0.75)));
          break;
        }
      }
    }
    const height = Math.ceil(Math.max(
      root.scrollHeight,
      root.offsetHeight,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      fixedOverlayHeight,
    ));
    if (height !== lastHeight) {
      lastHeight = height;
      post('height', { height });
    }
  };
  const scheduleMeasure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(measure);
  };

  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.source !== source || data.bridgeId !== bridgeId) {
      return;
    }
    if (data.type === 'theme' && data.values && typeof data.values === 'object') {
      for (const [name, value] of Object.entries(data.values)) {
        if (name.startsWith('--theme-') && typeof value === 'string') {
          document.documentElement.style.setProperty(name, value);
        }
      }
      scheduleMeasure();
    }
  });

  if (forwardContextMenu) {
    addEventListener('contextmenu', (event) => {
      event.preventDefault();
      post('contextmenu', { x: event.clientX, y: event.clientY });
    });
  }

  addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (href && !/^\\s*(?:#|data:|blob:|javascript:)/i.test(href)) event.preventDefault();
  }, true);
  addEventListener('submit', (event) => event.preventDefault(), true);

  addEventListener('load', scheduleMeasure);
  addEventListener('resize', scheduleMeasure);
  new ResizeObserver(scheduleMeasure).observe(document.documentElement);
  addEventListener('DOMContentLoaded', () => {
    if (!document.body) return;
    new MutationObserver(scheduleMeasure).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    scheduleMeasure();
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMeasure);
  post('ready');
  scheduleMeasure();
})();
</script>
${parts.head}
</head>
<body ${parts.bodyAttributes}>${parts.body}</body>
</html>`;
}

export function isBeautifierFrameMessage(
  value: unknown,
  bridgeId: string,
): value is BeautifierFrameMessage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<BeautifierFrameMessage>;
  return (
    data.source === BEAUTIFIER_FRAME_MESSAGE_SOURCE &&
    data.bridgeId === bridgeId &&
    (data.type === 'ready' || data.type === 'height' || data.type === 'contextmenu')
  );
}

export function collectThemeValues(style: CSSStyleDeclaration): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (!name.startsWith('--theme-')) continue;
    const value = style.getPropertyValue(name).trim();
    if (value) values[name] = value;
  }
  return values;
}

export function createBeautifierBridgeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `beautifier-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
