export const BEAUTIFIER_FRAME_SANDBOX = 'allow-scripts';

export const BEAUTIFIER_FRAME_MESSAGE_SOURCE = 'fated-poem-beautifier';

export const BEAUTIFIER_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
export const BEAUTIFIER_STORAGE_MAX_KEYS = 1024;
export const BEAUTIFIER_STORAGE_MAX_KEY_BYTES = 4096;

export type BeautifierStorageMutation =
  { kind: 'set'; key: string; value: string } | { kind: 'remove'; key: string } | { kind: 'clear' };

export type BeautifierStorageEntry = readonly [key: string, value: string];

/**
 * 帧内脚本策略 —— 按 markup 的**作者**分档，不是按内容长相。
 *
 * - `allow` —— 用户装过的规则（内置预设 / 自建 / 工坊）。保持工坊兼容：脚本、
 *   `eval`、内联事件、远程资源、网络 API 全开，边界是 opaque sandbox 本身。
 * - `block` —— 本轮**模型输出**合成的卡片（`<item_info>` / `<task_info>`）。世界书、
 *   角色卡与工坊文案都能牵着模型正文走，所以这一档不给脚本面：CSP 只放行带 nonce 的
 *   宿主引导脚本，卡片自带的 `<script>` / `onerror=` 一律被**浏览器**拦掉（不是正则
 *   消毒），`connect-src` 收成 `'none'`，共享正则存储也不注入。样式、图片、字体、
 *   媒体照旧，卡片该长什么样还长什么样。
 */
export type BeautifierFrameScriptPolicy = 'allow' | 'block';

export function buildBeautifierFrameCsp(
  scripts: BeautifierFrameScriptPolicy,
  scriptNonce: string,
): string {
  const shared = [
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "manifest-src 'none'",
    "style-src http: https: data: blob: 'unsafe-inline'",
    'img-src http: https: data: blob:',
    'font-src http: https: data: blob:',
    'media-src http: https: data: blob:',
  ];

  if (scripts === 'block') {
    return [
      "default-src 'none'",
      ...shared,
      "connect-src 'none'",
      "worker-src 'none'",
      `script-src 'nonce-${scriptNonce}'`,
      "script-src-attr 'none'",
    ].join('; ');
  }

  return [
    'default-src http: https: data: blob:',
    ...shared,
    'connect-src http: https: ws: wss: data: blob:',
    'worker-src blob:',
    "script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
    "script-src-attr 'unsafe-inline'",
  ].join('; ');
}

/** 规则帧（`scripts: 'allow'`）的策略串。模型帧按 nonce 逐帧生成，见 `buildBeautifierFrameCsp`。 */
export const BEAUTIFIER_FRAME_CSP = buildBeautifierFrameCsp('allow', '');

export interface BeautifierFrameDocumentOptions {
  markup: string;
  bridgeId: string;
  forwardContextMenu?: boolean;
  storageEntries?: readonly BeautifierStorageEntry[];
  /** 见 `BeautifierFrameScriptPolicy`。默认 `allow`（规则帧）。 */
  scripts?: BeautifierFrameScriptPolicy;
  /** 仅用于测试注入确定性 nonce；生产走 `createBeautifierBridgeId()`。 */
  scriptNonce?: string;
}

export interface BeautifierFrameMessage {
  source: typeof BEAUTIFIER_FRAME_MESSAGE_SOURCE;
  bridgeId: string;
  type: 'ready' | 'height' | 'contextmenu' | 'storage-mutate';
  height?: number;
  x?: number;
  y?: number;
  sequence?: number;
  mutations?: BeautifierStorageMutation[];
}

interface RichDocumentParts {
  head: string;
  body: string;
  htmlAttributes: string;
  bodyAttributes: string;
}

function inlineScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
 * Build an opaque iframe document for one rich beautifier match.
 *
 * This is intentionally not an HTML sanitizer: the markup, styles, inline
 * handlers, and scripts are retained verbatim. The security boundary is the
 * opaque iframe sandbox plus CSP.
 *
 * With `scripts: 'allow'` (rule-authored markup) remote resources and network
 * APIs stay available for workshop compatibility. With `scripts: 'block'`
 * (model-authored cards) the embedded markup gets no script execution, no
 * network API, and no shared regex storage — enforced by CSP, not by filtering
 * the markup. Either way parent/storage access, nested frames, forms, popups,
 * downloads, external anchor navigation, and top-level navigation are blocked.
 */
export function buildBeautifierFrameDocument({
  markup,
  bridgeId,
  forwardContextMenu = false,
  storageEntries = [],
  scripts = 'allow',
  scriptNonce,
}: BeautifierFrameDocumentOptions): string {
  const parts = splitRichDocument(markup);
  const bridgeLiteral = JSON.stringify(bridgeId);
  const sourceLiteral = JSON.stringify(BEAUTIFIER_FRAME_MESSAGE_SOURCE);
  const contextMenuLiteral = forwardContextMenu ? 'true' : 'false';
  const mayUseFixedLayoutLiteral = /position\s*:\s*fixed/i.test(markup) ? 'true' : 'false';
  // 模型帧不注入共享正则命名空间：那份快照会整份内嵌进 srcdoc 源码里。
  const storageEntriesLiteral = inlineScriptLiteral(scripts === 'block' ? [] : storageEntries);
  const persistStorageLiteral = scripts === 'block' ? 'false' : 'true';
  const nonce = scriptNonce ?? createBeautifierBridgeId();
  const nonceAttribute = scripts === 'block' ? ` nonce="${nonce}"` : '';
  const htmlAttributes = /(?:^|\s)lang\s*=/i.test(parts.htmlAttributes)
    ? parts.htmlAttributes
    : `lang="zh-CN" ${parts.htmlAttributes}`.trim();

  return `<!doctype html>
<html ${htmlAttributes}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildBeautifierFrameCsp(scripts, nonce)}">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-width: 0; background: transparent; }
body {
  color: var(--theme-text-primary, inherit);
  font-family: var(--theme-font-title, "Noto Serif SC", serif);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
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
<script${nonceAttribute}>
// window.localStorage throws for an opaque origin before user code can fall
// back. A global lexical binding shadows that accessor for ordinary legacy
// references. Its data is a host-owned, regex-only namespace; no application
// storage object or namespace selector crosses the iframe seam.
const __beautifierUtf8Bytes = (value) => new TextEncoder().encode(String(value)).byteLength;
const __beautifierStorageBatchSize = ${BEAUTIFIER_STORAGE_MAX_KEYS};
const __beautifierMakeStorage = (initialEntries = [], onMutation = null) => {
  const values = new Map();
  for (const entry of initialEntries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    if (typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    values.set(entry[0], entry[1]);
  }
  const quotaBytes = ${BEAUTIFIER_STORAGE_QUOTA_BYTES};
  const maxKeys = ${BEAUTIFIER_STORAGE_MAX_KEYS};
  const maxKeyBytes = ${BEAUTIFIER_STORAGE_MAX_KEY_BYTES};
  const byteSize = () => {
    let total = 0;
    for (const [key, value] of values) total += __beautifierUtf8Bytes(key) + __beautifierUtf8Bytes(value);
    return total;
  };
  const quotaError = () => new DOMException('Regex storage quota exceeded', 'QuotaExceededError');
  const assertSetAllowed = (key, value) => {
    if (__beautifierUtf8Bytes(key) > maxKeyBytes) throw quotaError();
    const isNew = !values.has(key);
    if (isNew && values.size >= maxKeys) throw quotaError();
    const previous = values.get(key);
    values.set(key, value);
    const overQuota = byteSize() > quotaBytes;
    if (previous === undefined) values.delete(key);
    else values.set(key, previous);
    if (overQuota) throw quotaError();
  };
  const apply = (mutation, emit = false) => {
    if (!mutation || typeof mutation !== 'object') return;
    if (mutation.kind === 'set' && typeof mutation.key === 'string' && typeof mutation.value === 'string') {
      assertSetAllowed(mutation.key, mutation.value);
      const previous = values.get(mutation.key) ?? null;
      if (previous === mutation.value) return;
      values.set(mutation.key, mutation.value);
      if (emit && onMutation) onMutation(mutation);
      return { key: mutation.key, oldValue: previous, newValue: mutation.value };
    }
    if (mutation.kind === 'remove' && typeof mutation.key === 'string') {
      const previous = values.get(mutation.key);
      if (previous === undefined) return;
      values.delete(mutation.key);
      if (emit && onMutation) onMutation(mutation);
      return { key: mutation.key, oldValue: previous, newValue: null };
    }
    if (mutation.kind === 'clear') {
      if (values.size === 0) return;
      values.clear();
      if (emit && onMutation) onMutation(mutation);
      return { key: null, oldValue: null, newValue: null };
    }
  };
  const storage = {
    get length() { return values.size; },
    clear() { apply({ kind: 'clear' }, true); },
    getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },
    key(index) { return [...values.keys()][Number(index)] ?? null; },
    removeItem(key) { apply({ kind: 'remove', key: String(key) }, true); },
    setItem(key, value) { apply({ kind: 'set', key: String(key), value: String(value) }, true); },
  };
  const proxy = new Proxy(storage, {
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
  return { storage: proxy, apply, entries: () => [...values.entries()] };
};
let __beautifierQueueStorageMutation = () => {};
const __beautifierSharedStorage = ${persistStorageLiteral};
const __beautifierPersistentStorage = __beautifierMakeStorage(
  ${storageEntriesLiteral},
  __beautifierSharedStorage ? (mutation) => __beautifierQueueStorageMutation(mutation) : null,
);
const localStorage = __beautifierPersistentStorage.storage;
const sessionStorage = __beautifierMakeStorage().storage;

(() => {
  'use strict';
  const bridgeId = ${bridgeLiteral};
  const source = ${sourceLiteral};
  const forwardContextMenu = ${contextMenuLiteral};
  const mayUseFixedLayout = ${mayUseFixedLayoutLiteral};
  let lastHeight = -1;
  let scheduled = false;
  let storageSequence = 0;
  let pendingStorageMutations = [];
  let storageFlushScheduled = false;

  // Opaque sandbox origins do not expose browser storage. localStorage is a
  // synchronous mirror of the dedicated persistent regex namespace;
  // sessionStorage remains private to this frame lifetime.
  for (const name of ['localStorage', 'sessionStorage']) {
    try { Object.defineProperty(window, name, { configurable: true, value: name === 'localStorage' ? localStorage : sessionStorage }); } catch (_) {}
  }
  // regexStorage 是「共享且持久」的承诺；模型帧那份只是本帧内存，别用同一个名字骗人。
  if (__beautifierSharedStorage) {
    try { Object.defineProperty(window, 'regexStorage', { configurable: true, value: localStorage }); } catch (_) {}
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
  __beautifierQueueStorageMutation = (mutation) => {
    pendingStorageMutations.push(mutation);
    if (storageFlushScheduled) return;
    storageFlushScheduled = true;
    queueMicrotask(() => {
      storageFlushScheduled = false;
      const mutations = pendingStorageMutations;
      pendingStorageMutations = [];
      for (let offset = 0; offset < mutations.length; offset += __beautifierStorageBatchSize) {
        post('storage-mutate', {
          sequence: ++storageSequence,
          mutations: mutations.slice(offset, offset + __beautifierStorageBatchSize),
        });
      }
    });
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
    if (data.type === 'storage-sync' && Array.isArray(data.mutations)) {
      for (const mutation of data.mutations) {
        try {
          const detail = __beautifierPersistentStorage.apply(mutation, false);
          if (detail) dispatchEvent(new StorageEvent('storage', { ...detail, storageArea: null, url: location.href }));
        } catch (_) {}
      }
    }
    if (data.type === 'storage-reset' && Array.isArray(data.entries)) {
      try {
        __beautifierPersistentStorage.apply({ kind: 'clear' }, false);
        for (const entry of data.entries) {
          if (Array.isArray(entry) && entry.length === 2) {
            __beautifierPersistentStorage.apply({ kind: 'set', key: String(entry[0]), value: String(entry[1]) }, false);
          }
        }
      } catch (_) {}
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
  if (data.source !== BEAUTIFIER_FRAME_MESSAGE_SOURCE || data.bridgeId !== bridgeId) return false;
  if (data.type === 'ready' || data.type === 'height' || data.type === 'contextmenu') return true;
  if (
    data.type !== 'storage-mutate' ||
    !Number.isSafeInteger(data.sequence) ||
    data.sequence! < 1
  ) {
    return false;
  }
  if (
    !Array.isArray(data.mutations) ||
    data.mutations.length === 0 ||
    data.mutations.length > BEAUTIFIER_STORAGE_MAX_KEYS
  ) {
    return false;
  }
  return data.mutations.every((mutation) => {
    if (!mutation || typeof mutation !== 'object') return false;
    if (mutation.kind === 'clear') return true;
    if (mutation.kind === 'remove') return typeof mutation.key === 'string';
    return (
      mutation.kind === 'set' &&
      typeof mutation.key === 'string' &&
      typeof mutation.value === 'string'
    );
  });
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
