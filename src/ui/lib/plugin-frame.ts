/**
 * 插件帧（宿主侧挂载 + 帧内引导脚本）—— 插件系统设计 §3.2、§4.1、§4.5、§4.7、§5.1。
 *
 * 结构：宿主在 shadow tree 里挂外层牢笼帧（`frame-cage.ts`，`port-handoff` 连接），
 * 牢笼帧再创建内层插件帧。内层文档完全由本模块生成：CSP `<meta>` + 一段宿主引导脚本，
 * 插件自己的入口 HTML 不进这份文档，而是经端口以字节形式送进帧内，由引导脚本里的
 * 装载器解析、采纳节点、按序重建 `<script>`（附录 A：插件源码绝不能和引导脚本拼进同一段
 * 脚本，否则插件的全局函数声明会先于引导代码实例化并顶替内建对象）。
 *
 * 端口协议（与 `plugin-bridge.ts` 对齐）：
 * - 宿主 → 帧：`{type:'init', pluginId, apiVersion, entry, files, theme}`（本模块发，仅一次）、
 *   `{type:'res', id, ok, …}`、`{type:'event', name, payload}`、`{type:'view', view, value}`、
 *   `{type:'theme', values}`。
 * - 帧 → 宿主：`{type:'ready', env, error?, pickers?}`、`{type:'req', id, method, args}`。
 *   `pickers` 只在 init 带 `probePickers: true`（宿主自检专用）时出现，见 `PickerProbeResult`。
 *
 * 帧内全局 `host` 的方法全部是请求-响应：`commit` 兑现为完整的 `CommitResult`，
 * 其余方法成功时兑现 `value`，失败时以带 `code` / `index` 的 Error 拒绝。
 * `subscribe` / `on` 兑现为取消函数。原始 MessagePort 只存在于引导脚本的闭包里，
 * 端口上的读写都走引导时缓存的原生函数，插件改原型也拿不到它。
 *
 * 主题只下发 `--theme-*` 自定义属性（§4.5），宿主侧与帧内各过滤一次。
 */
import { buildPluginFrameCsp } from '../../core/plugins/plugin-network';
import { PLUGIN_API_VERSION } from '../../core/plugins/plugin-surface';
import {
  buildCageDocument,
  CAGE_MESSAGE_SOURCE,
  type CageHostMessage,
  type CageInnerBootMessage,
  type CageInnerMode,
  type CageLinkMode,
  type CagePortMessage,
} from './frame-cage';

/**
 * 外层牢笼帧的沙盒标志（§4.1 逐项表）：不给 `allow-same-origin`（红线 A 的地基）、
 * 不给弹窗 / 顶层导航 / 下载 / 模态框。内层帧不写 sandbox，从这里继承。
 */
export const PLUGIN_FRAME_SANDBOX = 'allow-scripts allow-forms allow-pointer-lock';

const LINK_MODE: CageLinkMode = 'port-handoff';
const THEME_PREFIX = '--theme-';

/**
 * 帧内自报的运行环境：只用于自检与提示，不作运行期安全判据。
 * 由引导脚本在插件代码运行前取得；插件拿不到端口，伪造不了 `ready`。
 */
export interface PluginFrameEnv {
  hasSaveFilePicker: boolean;
  hasOpenFilePicker: boolean;
  hasDirectoryPicker: boolean;
  /** 只在挂帧时 `probePickers: true` 才有：无用户激活时调用三种文件选择器的结局（§4.8 S7） */
  pickerProbe?: PickerProbeResult[];
}

export const PICKER_NAMES = [
  'showSaveFilePicker',
  'showOpenFilePicker',
  'showDirectoryPicker',
] as const;
export type PickerName = (typeof PICKER_NAMES)[number];

/**
 * 一种文件选择器在**无用户激活**时被调用的结局：
 * absent = 方法不存在；resolved = 居然返回了结果；rejected = 被拒（带错误名与原文）；
 * pending = 限时内既没兑现也没拒绝；skipped-active = 调用前读到本帧带着用户激活
 * （或读不到 `navigator.userActivation`），为免弹出真对话框**没有调用**。
 */
export interface PickerProbeResult {
  name: PickerName;
  outcome: 'absent' | 'resolved' | 'rejected' | 'pending' | 'skipped-active';
  errorName?: string;
  message?: string;
}

/** 校验并规整帧（或对照帧）报回的选择器结局；形状不对返回 null */
export function normalizePickerProbe(raw: unknown): PickerProbeResult[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PickerProbeResult[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const name = PICKER_NAMES.find((n) => n === record.name);
    const outcome = record.outcome;
    if (
      name === undefined ||
      (outcome !== 'absent' &&
        outcome !== 'resolved' &&
        outcome !== 'rejected' &&
        outcome !== 'pending' &&
        outcome !== 'skipped-active')
    ) {
      return null;
    }
    const result: PickerProbeResult = { name, outcome };
    if (outcome === 'rejected') {
      result.errorName = typeof record.errorName === 'string' ? record.errorName : '';
      result.message = typeof record.message === 'string' ? record.message : '';
    }
    out.push(result);
  }
  return out;
}

/** 随 `init` 送进帧内的包内文件 */
export interface PluginFrameFile {
  path: string;
  mime: string;
  bytes: Uint8Array;
}

interface PluginFrameDocumentOptions {
  network: string[];
  innerMode?: CageInnerMode;
  channel: string;
}

interface MountPluginFrameOptions {
  pluginId: string;
  network: string[];
  /** 包内入口 HTML 的相对路径 */
  entry: string;
  files: PluginFrameFile[];
  theme: Record<string, string>;
  innerMode?: CageInnerMode;
  /** 后台页面：不可见 */
  hidden?: boolean;
  /**
   * 仅供启动自检（§4.8 S7）：引导脚本在装载插件代码**之前**、无用户激活地调用三种文件选择器，
   * 把结局随 `ready` 报回（`env.pickerProbe`）。随 `init` 下发，插件代码读不到也改不了。
   * 🔴 只给离屏、永不接收输入的自检帧开；有可见界面的插件帧不得开。
   */
  probePickers?: boolean;
  /** 帧内装载成功（`ready` 不带 `error`）。装载失败时**不**调用它，改调 `onLoadError` */
  onReady?: (env: PluginFrameEnv) => void;
  /** 帧报告了 `ready.error`（入口缺失、装载抛错等）：插件没有正常起来 */
  onLoadError?: (error: string, env: PluginFrameEnv) => void;
  onViolation?: () => void;
}

interface PluginFrameHandle {
  /** 宿主一侧的端口，交给 `createPluginBridge` */
  port: MessagePort;
  dispose(): void;
}

/** 嵌进 `<script>` 的 JS 字面量：转义 `<` 防 `</script>` 越狱，转义行分隔符 */
function inlineScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 只留 `--theme-*` 且值为字符串的项（§4.5） */
export function filterPluginThemeValues(values: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || typeof values !== 'object') return out;
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (name.startsWith(THEME_PREFIX) && typeof value === 'string') out[name] = value;
  }
  return out;
}

/**
 * 帧内引导脚本正文（静态文本，`String.raw` 保留正则里的反斜杠）。
 * 运行前由 `buildInnerDocument` 在前面拼上 `const config = {…};`（只含牢笼协议字段），
 * 插件的任何内容都不会进入这段脚本。
 * 🔴 正文里不得出现模板插值写法与反引号。
 */
const BOOTSTRAP_BODY = String.raw`
  const apply = Reflect.apply;
  const freeze = Object.freeze;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const PromiseCtor = Promise;
  const MapCtor = Map;
  const ErrorCtor = Error;
  const isView = ArrayBuffer.isView;
  const decoder = new TextDecoder();
  const win = window;
  const doc = document;

  // 在插件代码运行前取好环境：插件之后自己定义同名函数也改不了这份结果。
  const env = freeze({
    hasSaveFilePicker: 'showSaveFilePicker' in win,
    hasOpenFilePicker: 'showOpenFilePicker' in win,
    hasDirectoryPicker: 'showDirectoryPicker' in win,
  });
  // 自检用（init.probePickers）：同样在插件代码运行前取好选择器函数本身。
  const pickerFns = freeze({
    showSaveFilePicker: win.showSaveFilePicker,
    showOpenFilePicker: win.showOpenFilePicker,
    showDirectoryPicker: win.showDirectoryPicker,
  });
  const setTimer = win.setTimeout;

  // 端口消息的 data 用缓存的原生 getter 读：插件改 MessageEvent.prototype 也拿不到事件（进而拿不到端口）。
  let dataGetter = null;
  try {
    const descriptor = getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    dataGetter = descriptor && descriptor.get ? descriptor.get : null;
  } catch (_) {}
  const readData = (event) => {
    if (!dataGetter) return undefined;
    try { return apply(dataGetter, event, []); } catch (_) { return undefined; }
  };

  const self = doc.currentScript;
  if (self && self.parentNode) self.parentNode.removeChild(self);

  let port = null;
  let portPost = null;
  let nextId = 1;
  let initialized = false;
  const pending = new MapCtor();
  const views = new MapCtor();
  const events = new MapCtor();
  const files = new MapCtor();
  let themeValues = {};
  let themeKeys = [];

  const send = (message) => apply(portPost, port, [message]);

  const report = (err) => {
    try { console.error('[plugin]', err); } catch (_) {}
  };

  const makeError = (data) => {
    const err = new ErrorCtor(typeof data.message === 'string' ? data.message : String(data.code));
    err.code = data.code;
    if (typeof data.index === 'number') err.index = data.index;
    return err;
  };

  const request = (method, args, raw) => new PromiseCtor((resolve, reject) => {
    if (!port) { reject(new ErrorCtor('host 尚未连接')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject, raw });
    try {
      send({ type: 'req', id, method, args });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });

  const settle = (data) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (entry.raw) {
      if (data.ok === true) { entry.resolve({ ok: true }); return; }
      const result = { ok: false, code: data.code, message: data.message };
      if (typeof data.index === 'number') result.index = data.index;
      entry.resolve(result);
      return;
    }
    if (data.ok === true) entry.resolve(data.value);
    else entry.reject(makeError(data));
  };

  const dispatch = (map, name, value) => {
    const list = map.get(name);
    if (!list) return;
    for (const cb of list.slice()) {
      try { cb(value); } catch (err) { report(err); }
    }
  };

  const removeListener = (map, name, cb, offMethod) => {
    const list = map.get(name);
    if (list) {
      if (cb === undefined) list.length = 0;
      else {
        const index = list.indexOf(cb);
        if (index >= 0) list.splice(index, 1);
      }
      if (list.length > 0) return PromiseCtor.resolve();
      map.delete(name);
    }
    return request(offMethod, [name], false).then(() => undefined);
  };

  const addListener = (map, name, cb, onMethod, offMethod) => {
    if (typeof cb !== 'function') return PromiseCtor.reject(new TypeError('回调必须是函数'));
    let list = map.get(name);
    if (!list) { list = []; map.set(name, list); }
    list.push(cb);
    return request(onMethod, [name], false).then(
      () => () => removeListener(map, name, cb, offMethod),
      (err) => {
        const current = map.get(name);
        if (current) {
          const index = current.indexOf(cb);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) map.delete(name);
        }
        throw err;
      },
    );
  };

  const applyTheme = (values) => {
    if (!values || typeof values !== 'object') return;
    const style = doc.documentElement.style;
    const next = {};
    const keys = [];
    for (const name of Object.keys(values)) {
      const value = values[name];
      if (name.indexOf('--theme-') !== 0 || typeof value !== 'string') continue;
      style.setProperty(name, value);
      next[name] = value;
      keys.push(name);
    }
    for (const old of themeKeys) if (keys.indexOf(old) < 0) style.removeProperty(old);
    themeKeys = keys;
    themeValues = next;
  };

  // ── 包内文件与相对引用 ──────────────────────────────────────────────

  const dirOf = (path) => {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash + 1);
  };

  /** 相对引用 → 包内规范路径；外部、片段、带协议的引用返回 null（保持原样） */
  const resolvePath = (ref, baseDir) => {
    if (typeof ref !== 'string') return null;
    const trimmed = ref.trim();
    if (!trimmed || trimmed[0] === '#') return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.slice(0, 2) === '//') return null;
    let decoded = trimmed;
    try { decoded = decodeURIComponent(trimmed); } catch (_) {}
    const joined = decoded[0] === '/' ? decoded.slice(1) : baseDir + decoded;
    const out = [];
    for (const segment of joined.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(segment);
    }
    return out.length ? out.join('/') : null;
  };

  const isCss = (path, file) => file.mime === 'text/css' || /\.css$/i.test(path);

  const rewriteCss = (text, baseDir, stack) => text
    .replace(/url\(\s*(['"]?)([^'"()\s]+)\1\s*\)/g, (match, _q, ref) => {
      const target = urlForRef(ref, baseDir, stack);
      return target ? 'url("' + target + '")' : match;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/g, (match, _q, ref) => {
      const target = urlForRef(ref, baseDir, stack);
      return target ? '@import "' + target + '"' : match;
    });

  const urlForPath = (path, stack) => {
    const file = files.get(path);
    if (!file) return null;
    if (file.url) return file.url;
    let blob;
    if (isCss(path, file)) {
      // CSS 循环 @import：链上已有的文件不再展开，引用保持原样。
      if (stack.indexOf(path) >= 0) return null;
      const css = rewriteCss(decoder.decode(file.bytes), dirOf(path), stack.concat([path]));
      blob = new Blob([css], { type: file.mime });
    } else {
      blob = new Blob([file.bytes], { type: file.mime });
    }
    file.url = URL.createObjectURL(blob);
    return file.url;
  };

  /** 引用 → 帧内 blob URL；保留片段（SVG 雪碧图要用），丢弃查询串 */
  function urlForRef(ref, baseDir, stack) {
    if (typeof ref !== 'string') return null;
    const hash = ref.indexOf('#');
    const fragment = hash >= 0 ? ref.slice(hash) : '';
    let pathPart = hash >= 0 ? ref.slice(0, hash) : ref;
    const query = pathPart.indexOf('?');
    if (query >= 0) pathPart = pathPart.slice(0, query);
    const path = resolvePath(pathPart, baseDir);
    if (path === null) return null;
    const target = urlForPath(path, stack);
    return target ? target + fragment : null;
  }

  const rewriteSrcset = (value, baseDir) => value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const target = parts[0] ? urlForRef(parts[0], baseDir, []) : null;
      if (target) parts[0] = target;
      return parts.join(' ');
    })
    .join(', ');

  const isSvgElement = (el) => typeof el.namespaceURI === 'string' && /\/svg$/.test(el.namespaceURI);
  const NAVIGATING = { a: 1, area: 1, base: 1, form: 1 };

  /** 改写一棵（DOMParser 产出的）元素树里的相对引用 */
  const rewriteTree = (root, baseDir) => {
    const elements = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const el of elements) {
      const tag = el.localName;
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name;
        let next = null;
        if (name === 'src' || name === 'poster') {
          next = urlForRef(attr.value, baseDir, []);
        } else if (name === 'href' || name === 'xlink:href') {
          // 只改「取资源」的 href；会导航的（a/area/base/form）保持原样。
          const takesResource = tag === 'link' || (isSvgElement(el) && !NAVIGATING[tag]);
          if (takesResource) next = urlForRef(attr.value, baseDir, []);
        } else if (name === 'srcset') {
          next = rewriteSrcset(attr.value, baseDir);
        } else if (name === 'style') {
          next = rewriteCss(attr.value, baseDir, []);
        }
        if (next !== null && next !== attr.value) el.setAttribute(name, next);
      }
      if (tag === 'style') el.textContent = rewriteCss(el.textContent || '', baseDir, []);
      if (tag === 'meta' && /^refresh$/i.test(el.getAttribute('http-equiv') || '')) el.remove();
    }
  };

  const copyAttributes = (from, to) => {
    if (!from || !to) return;
    for (const attr of Array.from(from.attributes)) to.setAttribute(attr.name, attr.value);
  };

  /** 解析入口 HTML、采纳节点、按序重建脚本；不用 document.open / write */
  const loadEntry = async (entryPath) => {
    const path = resolvePath(entryPath, '');
    const file = path === null ? undefined : files.get(path);
    if (!file) throw new ErrorCtor('入口文件不存在：' + entryPath);
    const parsed = new DOMParser().parseFromString(decoder.decode(file.bytes), 'text/html');
    rewriteTree(parsed.documentElement, dirOf(path));

    // 解析出的 <script> 是惰性的：先换成占位注释，节点全部就位后再逐个重建执行。
    const scripts = [];
    for (const original of Array.from(parsed.querySelectorAll('script'))) {
      const placeholder = parsed.createComment('plugin-script');
      original.replaceWith(placeholder);
      scripts.push({ original, placeholder });
    }

    copyAttributes(parsed.documentElement, doc.documentElement);
    copyAttributes(parsed.body, doc.body);
    applyTheme(themeValues);
    for (const node of Array.from(parsed.head.childNodes)) doc.head.appendChild(doc.adoptNode(node));
    for (const node of Array.from(parsed.body.childNodes)) doc.body.appendChild(doc.adoptNode(node));

    for (const { original, placeholder } of scripts) {
      const fresh = doc.createElement('script');
      for (const attr of Array.from(original.attributes)) fresh.setAttribute(attr.name, attr.value);
      fresh.text = original.text;
      const waits = fresh.hasAttribute('src') && !fresh.hasAttribute('async');
      const loaded = waits
        ? new PromiseCtor((resolve) => {
            fresh.addEventListener('load', resolve, { once: true });
            fresh.addEventListener('error', resolve, { once: true });
          })
        : null;
      placeholder.replaceWith(fresh);
      if (loaded) await loaded;
    }
  };

  // ── 帧内 host 对象 ────────────────────────────────────────────────

  const lookupAsset = (path) => {
    const resolved = resolvePath(path, '');
    return resolved === null ? undefined : files.get(resolved);
  };
  const missingAsset = (path) => {
    const err = new ErrorCtor('包内文件不存在：' + path);
    err.code = 'NOT_FOUND';
    return err;
  };

  const storageArea = (area) => freeze({
    get: (key) => request('storage.' + area + '.get', [key], false),
    set: (key, value) => request('storage.' + area + '.set', [key, value], false),
    remove: (key) => request('storage.' + area + '.remove', [key], false),
  });

  const installHost = (pluginId, apiVersion) => {
    const host = freeze({
      pluginId,
      apiVersion,
      env,
      read: (view) => request('read', [view], false),
      subscribe: (view, cb) => addListener(views, view, cb, 'subscribe', 'unsubscribe'),
      unsubscribe: (view, cb) => removeListener(views, view, cb, 'unsubscribe'),
      on: (name, cb) => addListener(events, name, cb, 'on', 'off'),
      off: (name, cb) => removeListener(events, name, cb, 'off'),
      commit: (input) => request('commit', [input], true),
      storage: freeze({ save: storageArea('save'), global: storageArea('global') }),
      assets: freeze({
        read: (path) => {
          const file = lookupAsset(path);
          return file ? PromiseCtor.resolve(file.bytes.slice().buffer) : PromiseCtor.reject(missingAsset(path));
        },
        readText: (path) => {
          const file = lookupAsset(path);
          return file ? PromiseCtor.resolve(decoder.decode(file.bytes)) : PromiseCtor.reject(missingAsset(path));
        },
        url: (path) => {
          const resolved = resolvePath(path, '');
          const target = resolved === null ? null : urlForPath(resolved, []);
          if (!target) throw missingAsset(path);
          return target;
        },
      }),
      ui: freeze({
        close: () => request('ui.close', [], false),
        resize: (width, height) => request('ui.resize', [width, height], false),
        toast: (text) => request('ui.toast', [text], false),
        fillInput: (text) => request('ui.fillInput', [text], false),
        openExternal: (url) => request('ui.openExternal', [url], false),
      }),
      ai: freeze({
        note: (text, options) => request('ai.note', options === undefined ? [text] : [text, options], false),
        context: freeze({
          set: (text) => request('ai.context.set', [text === undefined ? null : text], false),
        }),
      }),
    });
    defineProperty(win, 'host', { value: host, enumerable: true });
  };

  const indexFiles = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item.path !== 'string' || !isView(item.bytes)) continue;
      const path = resolvePath(item.path, '');
      if (path === null) continue;
      const view = item.bytes;
      files.set(path, {
        mime: typeof item.mime === 'string' ? item.mime : 'application/octet-stream',
        bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        url: null,
      });
    }
  };

  // 无用户激活地调用三种文件选择器，收集结局（§4.8 S7）。只在宿主自检挂帧时跑，帧在屏幕外、不接收输入。
  // 📌 2026-11-15 实测更正：「用户激活只沿祖先方向传播、不会传给子帧」不成立 —— Chromium 里宿主页点一下，
  // 同源的屏幕外 srcdoc 子帧 navigator.userActivation.isActive 也变 true（同源激活可见性）。
  // 所以每次调用前都同步确认本帧 isActive === false；读不到或为 true 就不调用，报 skipped-active。
  const notActivated = () => {
    try {
      const ua = win.navigator.userActivation;
      return !!ua && ua.isActive === false;
    } catch (_) { return false; }
  };
  const pickerError = (name, err) => ({
    name,
    outcome: 'rejected',
    errorName: err && typeof err.name === 'string' ? err.name : '',
    message: err && typeof err.message === 'string' ? err.message : String(err),
  });
  const probeOne = (name) => new PromiseCtor((resolve) => {
    const fn = pickerFns[name];
    if (typeof fn !== 'function') { resolve({ name, outcome: 'absent' }); return; }
    if (!notActivated()) { resolve({ name, outcome: 'skipped-active' }); return; }
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try { apply(setTimer, win, [() => finish({ name, outcome: 'pending' }), 1500]); } catch (_) {}
    let result;
    try { result = apply(fn, win, []); } catch (err) { finish(pickerError(name, err)); return; }
    PromiseCtor.resolve(result).then(
      () => finish({ name, outcome: 'resolved' }),
      (err) => finish(pickerError(name, err)),
    );
  });
  const probePickers = () => PromiseCtor.all([
    probeOne('showSaveFilePicker'),
    probeOne('showOpenFilePicker'),
    probeOne('showDirectoryPicker'),
  ]);

  const start = async (init) => {
    // 先于插件代码跑完：插件之后做什么都影响不了这份结局
    let pickers;
    if (init.probePickers === true) {
      try { pickers = await probePickers(); } catch (err) { report(err); }
    }
    indexFiles(init.files);
    applyTheme(init.theme);
    installHost(String(init.pluginId), String(init.apiVersion));
    let error;
    try {
      await loadEntry(String(init.entry));
    } catch (err) {
      error = err && err.message ? String(err.message) : String(err);
      report(err);
    }
    // 文档早已解析完：给依赖这两个事件启动的插件补发一次。
    try { doc.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (err) { report(err); }
    try { win.dispatchEvent(new Event('load')); } catch (err) { report(err); }
    const ready = { type: 'ready', env };
    if (error !== undefined) ready.error = error;
    if (pickers !== undefined) ready.pickers = pickers;
    send(ready);
  };

  const onPortMessage = (event) => {
    const data = readData(event);
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'init':
        if (initialized) return;
        initialized = true;
        void start(data);
        return;
      case 'res':
        settle(data);
        return;
      case 'event':
        dispatch(events, data.name, data.payload);
        return;
      case 'view':
        dispatch(views, data.view, data.value);
        return;
      case 'theme':
        applyTheme(data.values);
        return;
    }
  };

  // ── 与牢笼握手：报 boot，收端口 ─────────────────────────────────────

  const onWindowMessage = (event) => {
    if (port || event.source !== parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== config.source || data.channel !== config.channel || data.type !== 'port') return;
    const ports = event.ports;
    if (!ports || ports.length !== 1) return;
    removeEventListener('message', onWindowMessage);
    port = ports[0];
    portPost = port.postMessage;
    port.onmessage = onPortMessage;
  };
  addEventListener('message', onWindowMessage);
  parent.postMessage(config.boot, '*');
`;

/** 内层插件帧文档：CSP meta + 引导脚本，别无他物 */
function buildInnerDocument(csp: string, channel: string): string {
  const boot: CageInnerBootMessage = { source: CAGE_MESSAGE_SOURCE, channel, type: 'boot' };
  const config = inlineScriptLiteral({ source: CAGE_MESSAGE_SOURCE, channel, boot });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<script>
(() => {
  'use strict';
  const config = ${config};
${BOOTSTRAP_BODY}
})();
</script>
</head>
<body></body>
</html>`;
}

/**
 * 生成插件帧的牢笼文档。牢笼与内层共用同一份 CSP（§4.1：srcdoc 继承父策略，两份不同会取交集）。
 * `network` 由 `buildPluginFrameCsp` 重验，不合格直接抛错。
 */
export function buildPluginFrameDocument({
  network,
  innerMode = 'srcdoc',
  channel,
}: PluginFrameDocumentOptions): { cage: string; csp: string } {
  const csp = buildPluginFrameCsp(network, { innerFrame: innerMode });
  const cage = buildCageDocument({
    csp,
    inner: buildInnerDocument(csp, channel),
    innerMode,
    link: LINK_MODE,
    channel,
  });
  return { cage, csp };
}

function createChannelId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `plugin-${crypto.randomUUID()}`;
  }
  return `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCageMessage(data: unknown, channel: string): data is CageHostMessage {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record.source === CAGE_MESSAGE_SOURCE && record.channel === channel;
}

function normalizeEnv(raw: unknown): PluginFrameEnv {
  const env = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    hasSaveFilePicker: env.hasSaveFilePicker === true,
    hasOpenFilePicker: env.hasOpenFilePicker === true,
    hasDirectoryPicker: env.hasDirectoryPicker === true,
  };
}

/**
 * 在 `container` 里挂一个插件帧：外层 iframe 放进 shadow root（附录 A 的 T3：
 * 别的帧在 `window.frames` 里枚举不到它），沙盒 = `PLUGIN_FRAME_SANDBOX`，不写 `allow`。
 * 牢笼报 `cage-ready` 后把帧侧端口交给它；`init` 立即排进端口队列。
 * 只认来源是本外层帧窗口、channel 相符的牢笼消息；`cage-violation` 时回调并拆除。
 */
export function mountPluginFrame(
  container: HTMLElement,
  options: MountPluginFrameOptions,
): PluginFrameHandle {
  const channelId = createChannelId();
  const { cage } = buildPluginFrameDocument({
    network: options.network,
    innerMode: options.innerMode,
    channel: channelId,
  });
  const doc = container.ownerDocument;
  const view = doc.defaultView ?? window;

  const wrapper = doc.createElement('div');
  wrapper.style.display = options.hidden ? 'none' : 'block';
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  if (options.hidden) wrapper.setAttribute('aria-hidden', 'true');
  const shadow = wrapper.attachShadow({ mode: 'open' });

  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', PLUGIN_FRAME_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', options.pluginId);
  frame.style.display = 'block';
  frame.style.border = '0';
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.background = 'transparent';
  frame.setAttribute('srcdoc', cage);

  const channel = new MessageChannel();
  const hostPort = channel.port1;
  let framePort: MessagePort | null = channel.port2;
  let disposed = false;
  let readyFired = false;

  const onPortMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (readyFired || !data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    if (record.type !== 'ready') return;
    readyFired = true;
    const env = normalizeEnv(record.env);
    const pickerProbe = normalizePickerProbe(record.pickers);
    if (pickerProbe !== null) env.pickerProbe = pickerProbe;
    // 带 error 的 ready 只说明引导跑完了，不说明插件起来了：不能当成功报
    if (record.error !== undefined) {
      const error = typeof record.error === 'string' ? record.error : '插件装载失败';
      options.onLoadError?.(error, env);
      return;
    }
    options.onReady?.(env);
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (disposed || event.source === null || event.source !== frame.contentWindow) return;
    const data: unknown = event.data;
    if (!isCageMessage(data, channelId)) return;
    if (data.type === 'cage-ready' && framePort && frame.contentWindow) {
      const message: CagePortMessage = {
        source: CAGE_MESSAGE_SOURCE,
        channel: channelId,
        type: 'port',
      };
      const port = framePort;
      framePort = null;
      frame.contentWindow.postMessage(message, '*', [port]);
      return;
    }
    if (data.type === 'cage-violation') {
      options.onViolation?.();
      dispose();
    }
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    view.removeEventListener('message', onWindowMessage);
    hostPort.removeEventListener('message', onPortMessage);
    hostPort.close();
    framePort?.close();
    framePort = null;
    wrapper.remove();
  }

  hostPort.addEventListener('message', onPortMessage);
  hostPort.start();
  view.addEventListener('message', onWindowMessage);
  hostPort.postMessage({
    type: 'init',
    pluginId: options.pluginId,
    apiVersion: PLUGIN_API_VERSION,
    entry: options.entry,
    files: options.files.map((file) => ({ path: file.path, mime: file.mime, bytes: file.bytes })),
    theme: filterPluginThemeValues(options.theme),
    ...(options.probePickers === true ? { probePickers: true } : {}),
  });

  shadow.appendChild(frame);
  container.appendChild(wrapper);
  return { port: hostPort, dispose };
}
