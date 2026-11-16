/**
 * 插件子系统启动自检 —— 插件系统设计 §4.8（另见 §4.3、§4.6）。
 *
 * 目的：在这台机器、这个浏览器上证明「带插件同款 CSP 的帧够不着本机」与「插件存档里的
 * 两档美化帧够不着本机」。判据是 BFF 上的金丝雀：BFF 就在 loopback 上，所以「零命中」
 * 直接等于「够不着本机」。
 *
 * 流程：
 * 1. 为每种手段各生成一对 nonce（对照组 `c_…` / 探针 `p_…`），整批登记到 BFF。
 * 2. CAGE：用生产的 `mountPluginFrame` 挂主探针帧，先试 `srcdoc` 内层，等不到 `ready`
 *    再试 `blob`，记下能用的那种；`ready` 带 error 也算没起来。两种都不行则插件帧相关各项判失败。
 * 3. 其余探针帧与全部对照帧一起挂上。对照帧 = 沙盒标志相同、不带 CSP、不套牢笼的帧，
 *    把探针用到的**每一种**手段各打一次金丝雀（S0）。
 * 4. 轮询对照组的核心通道，量出命中延迟；每个插件探针帧都要证明自己跑过（`ready` 或牢笼报导航），
 *    证明不了的所属项判「探测帧未运行」。等待窗口 = max(2 秒, 3 × 延迟)，从最晚的执行证明起算，
 *    窗口结束后一次性查询。
 * 5. 手段分核心与可选两类（见 `ProbeMethod.optional`）。核心通道的对照组不命中 → S0 失败
 *    （金丝雀管线未被证明）；可选通道的对照组不命中只在所属项里注明「本引擎不支持」，
 *    不判失败。S5 是尽力而为的一项，不进 S0：对照组不命中只标「未自检」。
 *    探针（无论核心还是可选）任何一次命中 → 所属项失败。
 *    另挂一个「管线孪生帧」（宿主自写的对照文档，沙盒 `allow-scripts allow-same-origin`，
 *    不跑插件代码，用完即拆）证明金丝雀管线本身通：它不命中 → S0 失败；它命中而不透明来源的
 *    核心对照组**全部**不命中 → 浏览器拦了不透明来源访问本机（Chromium 本地网络访问保护），
 *    S0 通过并记 `browserBlocksLocal`；只有一部分不命中 → 结果自相矛盾，S0 失败。
 *    任何一项失败，整轮失败，插件子系统禁用。
 * 6. S7（文件选择器）：主探针帧挂载时带 `probePickers`，帧内引导脚本在插件代码运行前、
 *    无用户激活地调用三种选择器，结局随 `ready` 报回；管线孪生帧里同样调用一次，
 *    拿到本引擎「缺用户激活」那句拒绝作对照。插件帧的 SecurityError 原文与对照不同 ⇒
 *    引擎在检查激活之前就按隔离条件拒绝了（Chromium 实测：先查沙盒 / 不透明来源再查激活），
 *    有没有点击都一样 ⇒ 通过；判不出时回退到 `PICKER_VERIFIED_ENGINES`（见 `judgePicker`）。
 *    🔴 只比对原文是否相同，不按报错文字内容匹配：与界面语言、引擎措辞无关。
 *    🔴 安全前提：两种帧都放在屏幕外（容器 `pointer-events:none`）、从不接收输入；并且两边的探测脚本
 *       在**每次**调用前都同步确认本帧 `navigator.userActivation.isActive === false`，读不到或为 true
 *       就不调用（报 `skipped-active`，判不出）。
 *       📌 2026-11-15 实测更正：原先写的「用户激活只沿祖先方向传播、不会从宿主页传给子帧」不成立 ——
 *       Chromium 里宿主页点一下，`allow-same-origin` 的屏幕外孪生帧 isActive 也变 true，
 *       `showOpenFilePicker()` 能越过激活检查（会弹真对话框）。所以安全只靠调用前的这道检查。
 *
 * 探针帧全部由生产生成器建：插件帧走 `mountPluginFrame`（内部是 `buildPluginFrameDocument`
 * → `buildPluginFrameCsp`），探针代码作为插件包的入口 HTML 经端口送进帧内，与真插件同路；
 * 美化帧走 `buildBeautifierFrameDocument({hardened: true})`。唯一例外是 S5：它要放行
 * 本机明文 HTTP 地址，生产生成器按设计产不出，只能手写一份测试策略。
 *
 * 所有环境访问（挂帧、BFF 调用、计时、UA）都经 `deps` 注入，本模块不碰宿主 DOM。
 * 探针脚本只在沙盒帧里运行；为避免宿主侧 URL 汇点闸门把帧内文本误判成宿主汇点，
 * 帧内脚本统一经 `A(el, name, value)` 设置 URL 属性。
 */
import {
  buildBeautifierFrameDocument,
  BEAUTIFIER_FRAME_SANDBOX,
  type BeautifierFrameScriptPolicy,
} from './beautifier-frame';
import type { CageInnerMode } from './frame-cage';
import {
  normalizePickerProbe,
  PICKER_NAMES,
  PLUGIN_FRAME_SANDBOX,
  type mountPluginFrame,
  type PickerName,
  type PickerProbeResult,
  type PluginFrameEnv,
} from './plugin-frame';

// ──────────────────────────────────────────────────────────────────────────────
// 对外类型
// ──────────────────────────────────────────────────────────────────────────────

type PluginSelfCheckItemId = 'CAGE' | 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';

interface PluginSelfCheckItem {
  id: PluginSelfCheckItemId;
  status: 'pass' | 'fail' | 'skipped';
  /** 给扩展管理页看的说明（简体中文） */
  detail: string;
}

export interface PluginSelfCheckResult {
  ok: boolean;
  /** 能用的内层装载方式；插件探针帧两种都起不来时为 null */
  innerMode: CageInnerMode | null;
  items: PluginSelfCheckItem[];
  /** 开跑时刻（`deps.now()`，毫秒） */
  ranAt: number;
  /**
   * 浏览器拦截了不透明来源帧对本机的全部请求（本地网络访问保护）：管线孪生帧命中、
   * 不透明来源的核心对照组全部不命中。此时红线 D 由浏览器兜底，S0 照样通过。
   */
  browserBlocksLocal?: boolean;
}

type BrowserEngine = 'chromium' | 'gecko' | 'webkit';

/** 人工矩阵里文件选择器一项已验过的引擎与大版本 */
interface PickerVerifiedEngine {
  engine: BrowserEngine;
  major: number;
}

/**
 * 文件选择器「人工矩阵已验」表（§4.8 S7、裁定 Q5）。出厂为空。
 * 📌 2026-11-15 起它只是**回退**：S7 先跑自动判定（插件帧与对照帧的拒绝原文对比），
 * 判不出时才查这张表；插件帧里有选择器、自动判定又判不出、引擎也不在表里 ⇒ 禁用插件子系统。
 */
export const PICKER_VERIFIED_ENGINES: readonly PickerVerifiedEngine[] = [];

interface SelfCheckMountHandle {
  dispose(): void;
}

/** 与 `mountPluginFrame` 第二个参数同形：生产代码直接传 `(o) => mountPluginFrame(容器, o)` */
type PluginProbeMountOptions = Parameters<typeof mountPluginFrame>[1];

export interface PluginSelfCheckDeps {
  /** 当前页面的 origin（应用就在 loopback 上）；金丝雀的绝对地址由它拼出 */
  origin: string;
  mount: {
    /**
     * 挂一个插件探针帧。生产实现：`(o) => mountPluginFrame(容器, o)`。
     * 🔴 容器必须参与渲染（离屏、透明都行，但不能 `display:none`），否则 CSS `url()`、
     * 字体这些手段不发请求，对照组会恒不命中。
     */
    plugin(options: PluginProbeMountOptions): SelfCheckMountHandle;
    /**
     * 挂一个 srcdoc 帧（对照帧、美化帧、S5）：生产实现建 iframe，设 `sandbox` 与 `srcdoc`。
     * 传了 `onMessage` 时，把**这个帧自己**（`event.source` 是它的 contentWindow）发给宿主窗口的
     * 消息交给它 —— 只有管线孪生帧用（报 S7 对照结局）。
     */
    document(options: {
      html: string;
      sandbox: string;
      onMessage?: (data: unknown) => void;
    }): SelfCheckMountHandle;
  };
  /** `/api/plugins/__selfcheck/register`：登记成功返回 true（每批 ≤128 个） */
  register(nonces: string[]): Promise<boolean>;
  /** `/api/plugins/__selfcheck/hits`：返回每个 nonce 是否命中（每批 ≤128 个） */
  hits(nonces: string[]): Promise<Record<string, boolean>>;
  sleep(ms: number): Promise<void>;
  now(): number;
  userAgent: string;
  /** S5 用的第二个 loopback 主机名（如 `127.0.0.1`）；没有时 S5 标「未自检」 */
  secondLoopbackHost?: string | null;
  /** 覆盖 `PICKER_VERIFIED_ENGINES`（测试用） */
  pickerVerifiedEngines?: readonly PickerVerifiedEngine[];
}

// ──────────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────────

/** 探针帧 `network` 的占位：合规的公网域名（RFC 2606 文档专用），探针从不请求它 */
const PROBE_NETWORK_HOST = 'selfcheck.example.com';
const PROBE_PLUGIN_ID = '__selfcheck';
const PROBE_ENTRY = 'probe.html';
const CANARY_PATH = '/api/plugins/__canary/';
const CANARY_REDIRECT_PATH = '/api/plugins/__canary-redirect/';

const MIN_WAIT_WINDOW_MS = 2000;
const WAIT_WINDOW_FACTOR = 3;
const READY_TIMEOUT_MS = 8000;
const CONTROL_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 100;
/** BFF 每次登记 / 查询最多 128 个 nonce */
const NONCE_BATCH = 100;

/**
 * 管线孪生帧的沙盒：带 allow-same-origin，请求以应用自己的 origin 发出，不受「不透明来源访问本机」
 * 的拦截。🔴 只装宿主自写的对照文档，绝不装插件代码；量完立即拆掉。
 */
const PIPELINE_TWIN_SANDBOX = 'allow-scripts allow-same-origin';
const PIPELINE_KEYS = ['fetch', 'img', 'cssUrl'] as const;
/** 孪生帧报 S7 对照结局时的消息标记 */
const TWIN_PICKER_SOURCE = 'fated-poem-selfcheck-twin';
/** 等孪生帧报对照结局的上限（从挂帧起算）；帧内每种选择器自带 1.5 秒限时 */
const TWIN_PICKER_WAIT_MS = 3000;
const PARTIAL_BLOCK_DETAIL = '浏览器只拦截了部分不透明来源通道，结果不可信';

const BROWSER_BLOCKS_LOCAL_DETAIL =
  '浏览器已拦截不透明来源帧访问本机（本地网络访问保护），红线 D 由浏览器兜底';

/** 判「零命中」前的等待窗口：对照组实测命中延迟 × 3，至少 2 秒（§4.8） */
export function selfCheckWaitWindow(controlLatencyMs: number): number {
  const latency = Number.isFinite(controlLatencyMs) && controlLatencyMs > 0 ? controlLatencyMs : 0;
  return Math.max(MIN_WAIT_WINDOW_MS, Math.ceil(latency * WAIT_WINDOW_FACTOR));
}

// ──────────────────────────────────────────────────────────────────────────────
// 探针单元
// ──────────────────────────────────────────────────────────────────────────────

type ProbeFrameKind = 'plugin' | 'beautifier-model' | 'beautifier-rule' | 'redirect';
type ProbeTransport = 'http' | 'ws' | 'redirect';

interface ProbeMethod {
  /** 单元内唯一的键，也是帧内脚本里 `U` 的字段名 */
  key: string;
  item: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
  label: string;
  transport?: ProbeTransport;
  /**
   * 可选通道：子帧或某些引擎里可能根本不存在（推测规则、资源提示、ping、object/embed 等）。
   * 对照组不命中只记一句「本引擎不支持」，不判失败；探针命中照样判失败。
   * 缺省 = 核心通道：对照组必须命中，否则金丝雀管线未被证明，整轮失败。
   */
  optional?: true;
}

/** 可选通道的方法键（核心 / 可选的取舍见文件头与 `ProbeMethod.optional`） */
const OPTIONAL_METHOD_KEYS: ReadonlySet<string> = new Set([
  'video',
  'prefetch',
  'preload',
  'modulepreload',
  'speculation',
  'object',
  'embed',
]);

const UNSUPPORTED_NOTE = '本引擎不支持该通道（对照组未命中），不构成外发途径';
const S6_FORM_NOTE = '表单提交由美化帧沙盒（无 allow-forms）直接禁止，不另测';
const S5_UNREACHABLE = '未自检：第二个本机主机名不可达';

/**
 * 核心通道：对照组必须命中，否则 S0 失败。可选通道不算；S5 也不算 ——
 * 它按 §4.8 是尽力而为的一项，第二个本机主机名可能根本没在监听，对照组不命中只让 S5 标「未自检」。
 */
function isCoreMethod(p: { method: ProbeMethod }): boolean {
  return !p.method.optional && p.method.item !== 'S5';
}

interface ProbeUnit {
  id: string;
  frame: ProbeFrameKind;
  methods: readonly ProbeMethod[];
  /** 生成 body 内容（含内联脚本）；`u` 是方法键 → 金丝雀 URL */
  body(u: Readonly<Record<string, string>>): string;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 嵌进 `<script>` 的 JS 字面量：转义 `<` 防越狱，转义行分隔符 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** CSS `url("…")` 片段 */
function cssUrl(value: string): string {
  return ['url(', JSON.stringify(value), ')'].join('');
}

/** 帧内内联脚本：`U` 是本单元用到的字符串表，`T` 吞掉同步异常与被拒的 Promise，`A` 设属性 */
function inlineScript(values: Record<string, string>, body: string): string {
  return `<script>
(() => {
  'use strict';
  const U = ${jsLiteral(values)};
  const T = (f) => { try { const r = f(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {} };
  const A = (el, name, value) => el.setAttribute(name, value);
${body}
})();
</script>`;
}

/**
 * 孪生帧里的 S7 对照脚本：无用户激活地调用三种选择器，把结局报给父窗口。
 * 宿主自写，与插件帧引导脚本里的探测同形（结局格式见 `PickerProbeResult`）。
 */
function twinPickerScript(token: string): string {
  return inlineScript(
    { source: TWIN_PICKER_SOURCE, token },
    [
      `  const one = (name) => new Promise((resolve) => {`,
      `    const fn = window[name];`,
      `    if (typeof fn !== 'function') { resolve({ name, outcome: 'absent' }); return; }`,
      // 宿主页的点击会让同源的本帧也带上激活（Chromium 实测）：每次调用前确认没有激活，否则不调用
      `    const ua = navigator.userActivation;`,
      `    if (!ua || ua.isActive !== false) { resolve({ name, outcome: 'skipped-active' }); return; }`,
      `    const rejected = (e) => ({ name, outcome: 'rejected', errorName: e && typeof e.name === 'string' ? e.name : '', message: e && typeof e.message === 'string' ? e.message : String(e) });`,
      `    setTimeout(() => resolve({ name, outcome: 'pending' }), 1500);`,
      `    try { Promise.resolve(fn.call(window)).then(() => resolve({ name, outcome: 'resolved' }), (e) => resolve(rejected(e))); }`,
      `    catch (e) { resolve(rejected(e)); }`,
      `  });`,
      `  T(() => Promise.all(${jsLiteral(PICKER_NAMES)}.map(one)).then((pickers) => parent.postMessage({ source: U.source, token: U.token, pickers }, '*')));`,
    ].join('\n'),
  );
}

/** 资源类手段的静态标记（模型帧没有脚本面，只能靠它们） */
const RESOURCE_MARKUP: Record<string, (url: string) => string> = {
  img: (url) => `<img src="${escapeAttr(url)}" alt="" width="1" height="1">`,
  stylesheet: (url) => `<link rel="stylesheet" href="${escapeAttr(url)}">`,
  cssUrl: (url) =>
    `<style>.sc-bg{width:8px;height:8px;background-image:${cssUrl(url)}}</style><div class="sc-bg"></div>`,
  font: (url) =>
    `<style>@font-face{font-family:"sc-probe";src:${cssUrl(url)}}.sc-font{font-family:"sc-probe"}</style><span class="sc-font">字</span>`,
  video: (url) => `<video src="${escapeAttr(url)}" preload="auto" muted playsinline></video>`,
  prefetch: (url) => `<link rel="prefetch" href="${escapeAttr(url)}">`,
  preload: (url) => `<link rel="preload" as="image" href="${escapeAttr(url)}">`,
  modulepreload: (url) => `<link rel="modulepreload" href="${escapeAttr(url)}">`,
  speculation: (url) =>
    `<script type="speculationrules">${jsLiteral({ prefetch: [{ source: 'list', urls: [url] }] })}</script>`,
  object: (url) => `<object data="${escapeAttr(url)}" width="1" height="1"></object>`,
  embed: (url) => `<embed src="${escapeAttr(url)}" width="1" height="1">`,
  scriptSrc: (url) => `<script src="${escapeAttr(url)}"></script>`,
};

/** 脚本类手段（帧内 JS），引用 `U[key]` */
const SCRIPT_SNIPPETS: Record<string, string> = {
  fetch: `  T(() => fetch(U.fetch, { mode: 'no-cors', cache: 'no-store' }));`,
  xhr: `  T(() => { const x = new XMLHttpRequest(); x.open('GET', U.xhr); x.send(); });`,
  beacon: `  T(() => navigator.sendBeacon(U.beacon, 'p'));`,
  websocket: `  T(() => { const s = new WebSocket(U.websocket); s.onerror = () => {}; });`,
  eventsource: `  T(() => { const e = new EventSource(U.eventsource); setTimeout(() => e.close(), 5000); });`,
};

/** 子文档：在里面重做 `fetch` 与 `<img>`（S3） */
function childDocument(fetchUrl: string, imgUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><img src="${escapeAttr(imgUrl)}" alt=""><script>fetch(${jsLiteral(fetchUrl)},{mode:"no-cors"}).catch(function(){});</script>`;
}

/** blob Worker 源码：`fetch` 与 `importScripts`（S4） */
function workerSource(fetchUrl: string, importUrl: string): string {
  return `fetch(${jsLiteral(fetchUrl)},{mode:"no-cors"}).catch(function(){});try{importScripts(${jsLiteral(importUrl)})}catch(e){}`;
}

function pick(
  u: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = u[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function resources(u: Readonly<Record<string, string>>, keys: readonly string[]): string {
  return keys
    .map((key) => {
      const url = u[key];
      const render = RESOURCE_MARKUP[key];
      return url !== undefined && render ? render(url) : '';
    })
    .join('\n');
}

function scripts(u: Readonly<Record<string, string>>, keys: readonly string[]): string {
  const lines = keys.map((key) => SCRIPT_SNIPPETS[key] ?? '').join('\n');
  return inlineScript(pick(u, keys), lines);
}

const S1_RESOURCE_KEYS = [
  'img',
  'stylesheet',
  'cssUrl',
  'font',
  'video',
  'prefetch',
  'preload',
  'modulepreload',
  'speculation',
  'object',
  'embed',
  'scriptSrc',
] as const;
const SCRIPT_KEYS = ['fetch', 'xhr', 'beacon', 'websocket', 'eventsource'] as const;
const S6_RESOURCE_KEYS = ['img', 'stylesheet', 'cssUrl', 'font', 'video'] as const;

const METHOD_LABELS: Record<string, string> = {
  img: '<img>',
  stylesheet: '样式表',
  cssUrl: 'CSS url()',
  font: '@font-face',
  video: '<video>',
  prefetch: '<link rel=prefetch>',
  preload: '<link rel=preload>',
  modulepreload: '<link rel=modulepreload>',
  speculation: '推测规则',
  object: '<object>',
  embed: '<embed>',
  scriptSrc: '<script src>',
  fetch: 'fetch',
  xhr: 'XHR',
  beacon: 'sendBeacon',
  websocket: 'WebSocket',
  eventsource: 'EventSource',
};

function methodsOf(item: ProbeMethod['item'], keys: readonly string[]): ProbeMethod[] {
  return keys.map((key) => ({
    key,
    item,
    label: METHOD_LABELS[key] ?? key,
    ...(key === 'websocket' ? { transport: 'ws' as const } : {}),
    ...(OPTIONAL_METHOD_KEYS.has(key) ? { optional: true as const } : {}),
  }));
}

/**
 * 导航类单元（每种导航独占一帧：导航会让文档消失）。
 * `withForm` 为 false 时不测表单提交：美化帧沙盒（`BEAUTIFIER_FRAME_SANDBOX`）没有 `allow-forms`，
 * 表单提交在沙盒这一层就被禁止 —— 对照帧同沙盒也提交不出去，对照组永远打不中，S0 会恒失败。
 */
function navigationUnits(
  prefix: string,
  frame: ProbeFrameKind,
  item: 'S2' | 'S6',
  withForm: boolean,
): ProbeUnit[] {
  const units: ProbeUnit[] = [
    {
      id: `${prefix}-location`,
      frame,
      methods: [{ key: 'location', item, label: 'location 导航' }],
      body: (u) => inlineScript(pick(u, ['location']), `  T(() => location.assign(U.location));`),
    },
    {
      id: `${prefix}-refresh`,
      frame,
      // 动态插入的 meta refresh 并非每个引擎都执行：可选通道
      methods: [{ key: 'refresh', item, label: '脚本插入的 meta refresh', optional: true }],
      // 插件装载器会剥掉静态的 meta refresh，这里由脚本插入，对照帧同样如此
      body: (u) =>
        inlineScript(
          pick(u, ['refresh']),
          `  T(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + U.refresh; document.head.appendChild(m); });`,
        ),
    },
    {
      id: `${prefix}-anchor`,
      frame,
      methods: [{ key: 'anchor', item, label: '锚点点击' }],
      body: (u) =>
        `<a id="sc-anchor" href="${escapeAttr(u.anchor ?? '')}">a</a>\n` +
        inlineScript({}, `  T(() => document.getElementById('sc-anchor').click());`),
    },
  ];
  if (!withForm) return units;
  units.push({
    id: `${prefix}-form`,
    frame,
    methods: [{ key: 'form', item, label: '表单提交' }],
    body: (u) =>
      `<form id="sc-form" method="post" action="${escapeAttr(u.form ?? '')}"><input type="hidden" name="p" value="1"></form>\n` +
      inlineScript({}, `  T(() => document.getElementById('sc-form').submit());`),
  });
  return units;
}

const PLUGIN_MAIN_UNIT_ID = 'plugin-main';

function buildProbeUnits(withRedirect: boolean): ProbeUnit[] {
  const units: ProbeUnit[] = [
    {
      // 主探针帧：S1 的全部非导航手段、S3 的子帧、S4 的 Worker；它的 ready 同时给出 CAGE 与 S7
      id: PLUGIN_MAIN_UNIT_ID,
      frame: 'plugin',
      methods: [
        ...methodsOf('S1', S1_RESOURCE_KEYS),
        ...methodsOf('S1', SCRIPT_KEYS),
        // 空白子帧只能由父帧伸手进去操作（about:blank 里放不进脚本）；沙盒父帧没有
        // allow-same-origin 时，有的引擎给子帧一个新的 opaque origin，contentDocument 为 null、
        // contentWindow.fetch 抛错，对照组同样够不着：可选通道（探针与对照代码相同）
        { key: 'blankFetch', item: 'S3', label: '空白子帧 fetch', optional: true },
        { key: 'blankImg', item: 'S3', label: '空白子帧 <img>', optional: true },
        { key: 'srcdocFetch', item: 'S3', label: 'srcdoc 子帧 fetch' },
        { key: 'srcdocImg', item: 'S3', label: 'srcdoc 子帧 <img>' },
        // opaque origin 里建 blob: / data: 子帧并非处处允许：可选通道
        { key: 'blobFrameFetch', item: 'S3', label: 'blob: 子帧 fetch', optional: true },
        { key: 'blobFrameImg', item: 'S3', label: 'blob: 子帧 <img>', optional: true },
        { key: 'dataFrameFetch', item: 'S3', label: 'data: 子帧 fetch', optional: true },
        { key: 'dataFrameImg', item: 'S3', label: 'data: 子帧 <img>', optional: true },
        { key: 'workerFetch', item: 'S4', label: 'blob Worker fetch' },
        { key: 'workerImport', item: 'S4', label: 'blob Worker importScripts' },
      ],
      body: (u) => {
        const docs = {
          blankFetch: u.blankFetch ?? '',
          blankImg: u.blankImg ?? '',
          srcdocDoc: childDocument(u.srcdocFetch ?? '', u.srcdocImg ?? ''),
          blobDoc: childDocument(u.blobFrameFetch ?? '', u.blobFrameImg ?? ''),
          dataDoc: childDocument(u.dataFrameFetch ?? '', u.dataFrameImg ?? ''),
          workerSrc: workerSource(u.workerFetch ?? '', u.workerImport ?? ''),
        };
        const nested = inlineScript(
          docs,
          [
            `  const frame = () => { const f = document.createElement('iframe'); A(f, 'width', '1'); A(f, 'height', '1'); return f; };`,
            `  T(() => {`,
            `    const f = frame(); document.body.appendChild(f);`,
            `    const w = f.contentWindow; const d = f.contentDocument;`,
            `    T(() => w.fetch(U.blankFetch, { mode: 'no-cors' }));`,
            `    T(() => { const img = d.createElement('img'); A(img, 'src', U.blankImg); (d.body || d.documentElement).appendChild(img); });`,
            `  });`,
            `  T(() => { const f = frame(); A(f, 'srcdoc', U.srcdocDoc); document.body.appendChild(f); });`,
            `  T(() => { const f = frame(); A(f, 'src', URL.createObjectURL(new Blob([U.blobDoc], { type: 'text/html' }))); document.body.appendChild(f); });`,
            `  T(() => { const f = frame(); A(f, 'src', 'data:text/html;charset=utf-8,' + encodeURIComponent(U.dataDoc)); document.body.appendChild(f); });`,
            `  T(() => { const w = new Worker(URL.createObjectURL(new Blob([U.workerSrc], { type: 'text/javascript' }))); w.onerror = () => {}; });`,
          ].join('\n'),
        );
        return [resources(u, S1_RESOURCE_KEYS), scripts(u, SCRIPT_KEYS), nested].join('\n');
      },
    },
    {
      id: 'plugin-ping',
      frame: 'plugin',
      // Firefox 默认关闭 ping：可选通道
      methods: [{ key: 'ping', item: 'S1', label: '<a ping>', optional: true }],
      // 点击带 ping 的锚点；href 只是同文档片段，导航由 S2 单独测
      body: (u) =>
        `<a id="sc-ping" href="#sc" ping="${escapeAttr(u.ping ?? '')}">p</a>\n` +
        inlineScript({}, `  T(() => document.getElementById('sc-ping').click());`),
    },
    ...navigationUnits('plugin', 'plugin', 'S2', true),
    {
      id: 'plugin-nav-blob',
      frame: 'plugin',
      methods: [
        { key: 'fetch', item: 'S3', label: '导航到 blob: 后 fetch', optional: true },
        { key: 'img', item: 'S3', label: '导航到 blob: 后 <img>', optional: true },
      ],
      body: (u) =>
        inlineScript(
          { doc: childDocument(u.fetch ?? '', u.img ?? '') },
          `  T(() => location.assign(URL.createObjectURL(new Blob([U.doc], { type: 'text/html' }))));`,
        ),
    },
    {
      id: 'plugin-nav-data',
      frame: 'plugin',
      methods: [
        { key: 'fetch', item: 'S3', label: '导航到 data: 后 fetch', optional: true },
        { key: 'img', item: 'S3', label: '导航到 data: 后 <img>', optional: true },
      ],
      body: (u) =>
        inlineScript(
          { doc: childDocument(u.fetch ?? '', u.img ?? '') },
          `  T(() => location.assign('data:text/html;charset=utf-8,' + encodeURIComponent(U.doc)));`,
        ),
    },
    {
      // 模型帧（scripts: 'block'）：没有脚本面，只有资源类手段
      id: 'model-resources',
      frame: 'beautifier-model',
      methods: methodsOf('S6', S6_RESOURCE_KEYS).map((m) => ({ ...m, label: `模型帧 ${m.label}` })),
      body: (u) => resources(u, S6_RESOURCE_KEYS),
    },
    {
      id: 'model-refresh',
      frame: 'beautifier-model',
      methods: [{ key: 'refresh', item: 'S6', label: '模型帧 <meta http-equiv=refresh>' }],
      body: (u) => `<meta http-equiv="refresh" content="0;url=${escapeAttr(u.refresh ?? '')}">`,
    },
    {
      // 规则帧（scripts: 'allow'）：S1 的脚本手段
      id: 'rule-scripts',
      frame: 'beautifier-rule',
      methods: methodsOf('S6', SCRIPT_KEYS).map((m) => ({ ...m, label: `规则帧 ${m.label}` })),
      body: (u) => scripts(u, SCRIPT_KEYS),
    },
    // 规则帧：S2 的导航手段（表单提交除外：美化帧沙盒本身禁止，见 navigationUnits）
    ...navigationUnits('rule', 'beautifier-rule', 'S6', false).map((unit) => ({
      ...unit,
      methods: unit.methods.map((m) => ({ ...m, label: `规则帧 ${m.label}` })),
    })),
  ];
  if (withRedirect) {
    units.push({
      id: 'redirect',
      frame: 'redirect',
      methods: [
        { key: 'fetch', item: 'S5', label: '重定向 fetch', transport: 'redirect' },
        { key: 'img', item: 'S5', label: '重定向 <img>', transport: 'redirect' },
      ],
      body: (u) => `${resources(u, ['img'])}\n${scripts(u, ['fetch'])}`,
    });
  }
  return units;
}

// ──────────────────────────────────────────────────────────────────────────────
// 文档组装
// ──────────────────────────────────────────────────────────────────────────────

function wrapDocument(body: string, csp?: string): string {
  const cspMeta =
    csp === undefined
      ? ''
      : `\n<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">${cspMeta}
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * S5 的测试策略（不经生产生成器，§4.8）：只放行应用自己的 origin，
 * 请求它上面一个 302 到第二个 loopback 主机名的端点，看 CSP 是否对重定向的下一跳重新检查。
 */
function redirectTestCsp(origin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    `connect-src ${origin}`,
    `img-src ${origin}`,
  ].join('; ');
}

function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PlannedMethod {
  unitId: string;
  method: ProbeMethod;
  probeNonce: string;
  controlNonce: string;
}

interface PlannedUnit {
  unit: ProbeUnit;
  probeUrls: Record<string, string>;
  controlUrls: Record<string, string>;
}

function canaryUrlFor(
  origin: string,
  nonce: string,
  transport: ProbeTransport,
  secondHost: string | null,
): string {
  if (transport === 'ws') return origin.replace(/^http/, 'ws') + CANARY_PATH + nonce;
  if (transport === 'redirect') {
    return `${origin}${CANARY_REDIRECT_PATH}${nonce}?host=${encodeURIComponent(secondHost ?? '')}`;
  }
  return origin + CANARY_PATH + nonce;
}

function engineOf(userAgent: string): PickerVerifiedEngine | null {
  const firefox = /Firefox\/(\d+)/.exec(userAgent);
  if (firefox) return { engine: 'gecko', major: Number(firefox[1]) };
  const chromium = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (chromium) return { engine: 'chromium', major: Number(chromium[1]) };
  const safari = /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//.exec(userAgent);
  if (safari) return { engine: 'webkit', major: Number(safari[1]) };
  return null;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function queryHits(
  deps: PluginSelfCheckDeps,
  nonces: readonly string[],
): Promise<Record<string, boolean>> {
  const merged: Record<string, boolean> = {};
  for (const batch of chunk(nonces, NONCE_BATCH)) {
    Object.assign(merged, await deps.hits(batch));
  }
  return merged;
}

const ITEM_ORDER: readonly PluginSelfCheckItemId[] = [
  'CAGE',
  'S0',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
];

function failAll(detail: string, ranAt: number): PluginSelfCheckResult {
  return {
    ok: false,
    innerMode: null,
    items: ITEM_ORDER.map((id) => ({ id, status: 'fail', detail })),
    ranAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────────────────────────

/** 跑一轮自检。从不抛错：任何环境故障都折成失败项 */
export async function runPluginSelfCheck(
  deps: PluginSelfCheckDeps,
): Promise<PluginSelfCheckResult> {
  const ranAt = deps.now();
  const secondHost = deps.secondLoopbackHost ? deps.secondLoopbackHost : null;
  const units = buildProbeUnits(secondHost !== null);

  const planned: PlannedMethod[] = [];
  const plannedUnits: PlannedUnit[] = units.map((unit) => {
    const probeUrls: Record<string, string> = {};
    const controlUrls: Record<string, string> = {};
    for (const method of unit.methods) {
      const tag = `${unit.id}-${method.key}`.replace(/[^A-Za-z0-9_-]/g, '_');
      const probeNonce = `p_${tag}_${randomToken()}`.slice(0, 64);
      const controlNonce = `c_${tag}_${randomToken()}`.slice(0, 64);
      const transport = method.transport ?? 'http';
      probeUrls[method.key] = canaryUrlFor(deps.origin, probeNonce, transport, secondHost);
      controlUrls[method.key] = canaryUrlFor(deps.origin, controlNonce, transport, secondHost);
      planned.push({ unitId: unit.id, method, probeNonce, controlNonce });
    }
    return { unit, probeUrls, controlUrls };
  });

  const pipeline = PIPELINE_KEYS.map((key) => {
    const nonce = `q_pipeline-${key}_${randomToken()}`.slice(0, 64);
    return {
      key,
      label: METHOD_LABELS[key] ?? key,
      nonce,
      url: canaryUrlFor(deps.origin, nonce, 'http', null),
    };
  });
  const pipelineNonces = pipeline.map((p) => p.nonce);
  const allNonces = [...planned.flatMap((p) => [p.probeNonce, p.controlNonce]), ...pipelineNonces];
  try {
    for (const batch of chunk(allNonces, NONCE_BATCH)) {
      if (!(await deps.register(batch)))
        return failAll('金丝雀登记被 BFF 拒绝，自检无法进行', ranAt);
    }
  } catch {
    return failAll('无法连接 BFF 登记金丝雀，自检无法进行', ranAt);
  }

  const handles: SelfCheckMountHandle[] = [];
  const track = (handle: SelfCheckMountHandle) => {
    handles.push(handle);
    return handle;
  };

  try {
    // ── CAGE：主探针帧，srcdoc 优先，失败再试 blob ──
    const main = plannedUnits.find((p) => p.unit.id === PLUGIN_MAIN_UNIT_ID);
    let innerMode: CageInnerMode | null = null;
    let env: PluginFrameEnv | null = null;
    const attempts: string[] = [];
    for (const mode of ['srcdoc', 'blob'] as const) {
      if (!main) break;
      const probe = mountPluginProbe(deps, main.unit, main.probeUrls, mode, track, true);
      const outcome = await awaitPluginProbe(deps, probe);
      if (outcome.kind === 'ready') {
        innerMode = mode;
        env = outcome.env;
        break;
      }
      probe.handle.dispose();
      attempts.push(`${mode}：${outcomeReason(outcome)}`);
    }

    // ── 其余探针帧 + 全部对照帧 + 管线孪生帧 ──
    const mountedAt = deps.now();
    const pipelineUrls = Object.fromEntries(pipeline.map((p) => [p.key, p.url]));
    // 孪生帧顺带给 S7 的对照：本引擎「缺用户激活」时的拒绝原文
    const twinToken = randomToken();
    let twinPickers: PickerProbeResult[] | null = null;
    const pipelineHandle = deps.mount.document({
      html: wrapDocument(
        [
          resources(pipelineUrls, ['img', 'cssUrl']),
          scripts(pipelineUrls, ['fetch']),
          twinPickerScript(twinToken),
        ].join('\n'),
      ),
      sandbox: PIPELINE_TWIN_SANDBOX,
      onMessage: (data) => {
        if (twinPickers !== null || !data || typeof data !== 'object') return;
        const record = data as Record<string, unknown>;
        if (record.source !== TWIN_PICKER_SOURCE || record.token !== twinToken) return;
        twinPickers = normalizePickerProbe(record.pickers);
      },
    });
    let pipelineDisposed = false;
    const disposePipeline = () => {
      if (pipelineDisposed) return;
      pipelineDisposed = true;
      pipelineHandle.dispose();
    };
    track({ dispose: disposePipeline });
    const pluginProbes: { unitId: string; probe: PluginProbeMount }[] = [];
    for (const p of plannedUnits) {
      track(
        deps.mount.document({
          html: wrapDocument(p.unit.body(p.controlUrls)),
          sandbox: sandboxOf(p.unit.frame),
        }),
      );
      if (p.unit.id === PLUGIN_MAIN_UNIT_ID) continue;
      if (p.unit.frame === 'plugin') {
        if (innerMode !== null) {
          const probe = mountPluginProbe(deps, p.unit, p.probeUrls, innerMode, track);
          pluginProbes.push({ unitId: p.unit.id, probe });
        }
        continue;
      }
      track(mountProbeDocument(deps, p, plannedUnits.indexOf(p)));
    }

    // ── 轮询对照组，量延迟 ──
    // 只等核心通道：可选通道与尽力而为的 S5 的对照组可能永远不命中，等它们只会把每轮拖满超时
    // 管线孪生帧命中后，不透明来源的核心对照组若在它的等待窗口里一个都没中，就判作浏览器在拦截，
    // 不再空等到超时
    const controlNonces = planned.filter(isCoreMethod).map((p) => p.controlNonce);
    let controlLatency: number | null = null;
    let pipelineLatency: number | null = null;
    // 提前判定「浏览器在拦」时不把孪生帧延迟当成对照组延迟：之后对照组若又命中，判部分拦截
    let blockedEarly = false;
    for (;;) {
      const hits = await queryHits(deps, [...controlNonces, ...pipelineNonces]);
      const elapsed = deps.now() - mountedAt;
      if (pipelineLatency === null && pipelineNonces.every((n) => hits[n] === true)) {
        pipelineLatency = elapsed;
        // S7 对照还没报回时先留着它，轮询结束后再等一小会儿
        if (twinPickers !== null) disposePipeline();
      }
      if (controlNonces.every((n) => hits[n] === true)) {
        controlLatency = elapsed;
        break;
      }
      if (
        pipelineLatency !== null &&
        controlNonces.every((n) => hits[n] !== true) &&
        elapsed >= selfCheckWaitWindow(pipelineLatency)
      ) {
        blockedEarly = true;
        break;
      }
      if (elapsed >= CONTROL_TIMEOUT_MS) break;
      await deps.sleep(POLL_INTERVAL_MS);
    }
    while (twinPickers === null && deps.now() - mountedAt < TWIN_PICKER_WAIT_MS) {
      await deps.sleep(POLL_INTERVAL_MS);
    }
    disposePipeline();
    // ── 每个插件探针帧都得证明自己跑过，等待窗口从最晚的那个证明起算 ──
    // 没跑起来的帧零命中毫无意义：判「探测帧未运行」，不算通过
    const unranUnits = new Set<string>();
    let windowStart = mountedAt;
    for (const { unitId, probe } of pluginProbes) {
      const outcome = await awaitPluginProbe(deps, probe);
      if (probeRan(outcome)) {
        windowStart = Math.max(windowStart, probe.settledAt() ?? deps.now());
      } else {
        unranUnits.add(unitId);
      }
    }

    const windowMs = selfCheckWaitWindow(controlLatency ?? pipelineLatency ?? 0);
    const remaining = windowStart + windowMs - deps.now();
    if (remaining > 0) await deps.sleep(remaining);

    const hits = await queryHits(deps, allNonces);
    const pipelineMissed = pipeline.filter((p) => hits[p.nonce] !== true).map((p) => p.label);
    const items = judge({
      planned,
      hits,
      pipelineMissed,
      unranUnits,
      innerMode,
      env,
      attempts,
      controlLatency,
      blockedEarly,
      windowMs,
      secondHost,
      engine: engineOf(deps.userAgent),
      verified: deps.pickerVerifiedEngines ?? PICKER_VERIFIED_ENGINES,
      twinPickers,
    });
    const s0 = items.find((i) => i.id === 'S0');
    return {
      ok: items.every((i) => i.status !== 'fail'),
      innerMode,
      items,
      ranAt,
      ...(s0?.status === 'pass' && s0.detail.startsWith(BROWSER_BLOCKS_LOCAL_DETAIL)
        ? { browserBlocksLocal: true }
        : {}),
    };
  } catch {
    return failAll('自检过程中查询金丝雀失败', ranAt);
  } finally {
    for (const handle of handles) {
      try {
        handle.dispose();
      } catch {
        // 拆帧失败不影响结果
      }
    }
  }
}

function sandboxOf(frame: ProbeFrameKind): string {
  return frame === 'beautifier-model' || frame === 'beautifier-rule'
    ? BEAUTIFIER_FRAME_SANDBOX
    : PLUGIN_FRAME_SANDBOX;
}

/** 美化帧走生产的加固生成器；S5 用手写测试策略 */
function mountProbeDocument(
  deps: PluginSelfCheckDeps,
  p: PlannedUnit,
  index: number,
): SelfCheckMountHandle {
  const body = p.unit.body(p.probeUrls);
  if (p.unit.frame === 'redirect') {
    return deps.mount.document({
      html: wrapDocument(body, redirectTestCsp(deps.origin)),
      sandbox: PLUGIN_FRAME_SANDBOX,
    });
  }
  const scriptsPolicy: BeautifierFrameScriptPolicy =
    p.unit.frame === 'beautifier-model' ? 'block' : 'allow';
  const html = buildBeautifierFrameDocument({
    markup: body,
    bridgeId: `selfcheck-${index}-${randomToken()}`,
    scripts: scriptsPolicy,
    hardened: true,
  });
  return deps.mount.document({ html, sandbox: BEAUTIFIER_FRAME_SANDBOX });
}

/**
 * 插件探针帧的结局。`ready` 与 `violation` 都证明探针脚本**跑过**：
 * 装载器同步执行完入口里的内联脚本才发 `ready`；牢笼报内层被导航走，只能是导航探针的脚本动了手。
 * `load-error`（`ready` 带 error）与 `timeout` 都说明探针代码没跑起来。
 */
type PluginProbeOutcome =
  | { kind: 'ready'; env: PluginFrameEnv }
  | { kind: 'violation' }
  | { kind: 'load-error'; error: string }
  | { kind: 'timeout' };

interface PluginProbeMount {
  handle: SelfCheckMountHandle;
  /** 已有结局时立即返回，否则 null */
  peek(): PluginProbeOutcome | null;
  settled: Promise<PluginProbeOutcome>;
  /** 得到结局的时刻（`deps.now()`），未有结局时为 null */
  settledAt(): number | null;
  /** 挂帧时刻（`deps.now()`），就绪超时从这里算 */
  mountedAt: number;
}

/** 用生产的插件帧挂一个探针：探针 HTML 作为插件包的入口文件送进帧内 */
function mountPluginProbe(
  deps: PluginSelfCheckDeps,
  unit: ProbeUnit,
  urls: Record<string, string>,
  innerMode: CageInnerMode,
  track: (handle: SelfCheckMountHandle) => SelfCheckMountHandle,
  probePickers = false,
): PluginProbeMount {
  let outcome: PluginProbeOutcome | null = null;
  let outcomeAt: number | null = null;
  let resolveSettled: (value: PluginProbeOutcome) => void = () => {};
  const settled = new Promise<PluginProbeOutcome>((resolve) => {
    resolveSettled = resolve;
  });
  const settle = (value: PluginProbeOutcome) => {
    if (outcome) return;
    outcome = value;
    outcomeAt = deps.now();
    resolveSettled(value);
  };
  const mountedAt = deps.now();
  const handle = track(
    deps.mount.plugin({
      pluginId: PROBE_PLUGIN_ID,
      network: [PROBE_NETWORK_HOST],
      entry: PROBE_ENTRY,
      files: [
        {
          path: PROBE_ENTRY,
          mime: 'text/html',
          bytes: new TextEncoder().encode(wrapDocument(unit.body(urls))),
        },
      ],
      theme: {},
      innerMode,
      ...(probePickers ? { probePickers: true } : {}),
      onReady: (env) => settle({ kind: 'ready', env }),
      onLoadError: (error) => settle({ kind: 'load-error', error }),
      onViolation: () => settle({ kind: 'violation' }),
    }),
  );
  return { handle, peek: () => outcome, settled, settledAt: () => outcomeAt, mountedAt };
}

/** 等探针帧给出结局，最晚等到挂帧后 `READY_TIMEOUT_MS`；已有结局时不调 `sleep` */
async function awaitPluginProbe(
  deps: PluginSelfCheckDeps,
  probe: PluginProbeMount,
): Promise<PluginProbeOutcome> {
  const known = probe.peek();
  if (known) return known;
  const remaining = probe.mountedAt + READY_TIMEOUT_MS - deps.now();
  if (remaining <= 0) return { kind: 'timeout' };
  return Promise.race([
    probe.settled,
    deps.sleep(remaining).then(() => probe.peek() ?? ({ kind: 'timeout' } as const)),
  ]);
}

/** 主探针帧未起来时给 CAGE 的原因 */
function outcomeReason(outcome: PluginProbeOutcome): string {
  switch (outcome.kind) {
    case 'ready':
      return '';
    case 'violation':
      return '牢笼报告内层帧被导航走';
    case 'load-error':
      return `帧内装载失败：${outcome.error}`;
    case 'timeout':
      return `${READY_TIMEOUT_MS / 1000} 秒内未就绪`;
  }
}

/** 探针帧是否证明自己执行过（零命中只有在探针确实跑过时才算数） */
function probeRan(outcome: PluginProbeOutcome): boolean {
  return outcome.kind === 'ready' || outcome.kind === 'violation';
}

// ──────────────────────────────────────────────────────────────────────────────
// 判定
// ──────────────────────────────────────────────────────────────────────────────

interface JudgeInput {
  planned: readonly PlannedMethod[];
  hits: Record<string, boolean>;
  /** 管线孪生帧里没命中的手段（空 = 金丝雀管线已被证明） */
  pipelineMissed: readonly string[];
  /** 没证明自己执行过的插件探针帧（单元 id） */
  unranUnits: ReadonlySet<string>;
  innerMode: CageInnerMode | null;
  env: PluginFrameEnv | null;
  attempts: readonly string[];
  controlLatency: number | null;
  /** 轮询阶段已按「对照组一个不中」提前收尾 */
  blockedEarly: boolean;
  windowMs: number;
  secondHost: string | null;
  engine: PickerVerifiedEngine | null;
  verified: readonly PickerVerifiedEngine[];
  /** 管线孪生帧报回的对照结局；没报回为 null */
  twinPickers: readonly PickerProbeResult[] | null;
}

const PLUGIN_FRAME_ITEMS = new Set<PluginSelfCheckItemId>(['S1', 'S2', 'S3', 'S4']);

function judge(input: JudgeInput): PluginSelfCheckItem[] {
  const { planned, hits, innerMode, env } = input;
  const items: PluginSelfCheckItem[] = [];

  items.push(
    innerMode === null
      ? {
          id: 'CAGE',
          status: 'fail',
          detail: `插件探针帧没能启动（${input.attempts.join('；') || '未知原因'}）`,
        }
      : {
          id: 'CAGE',
          status: 'pass',
          detail:
            innerMode === 'srcdoc'
              ? '牢笼帧与内层插件帧启动正常（srcdoc 装载）'
              : `srcdoc 装载不可用，改用 blob 装载后启动正常（${input.attempts.join('；')}）`,
        },
  );

  const controlMisses = planned.filter((p) => hits[p.controlNonce] !== true);
  const coreMisses = controlMisses.filter(isCoreMethod);
  const unsupported = controlMisses.filter((p) => p.method.optional);
  const coreCount = planned.filter(isCoreMethod).length;
  const unsupportedNote =
    unsupported.length > 0 ? `；另有 ${unsupported.length} 种可选通道本引擎不支持` : '';
  const missedNames = coreMisses.map((p) => `${p.method.item} ${p.method.label}`).join('、');
  // 浏览器整体拦截的前提：不透明来源的对照组（核心与可选）一个都没中，探针也一个都没中
  const anyOpaqueHit = planned.some(
    (p) => hits[p.controlNonce] === true || hits[p.probeNonce] === true,
  );
  if (input.pipelineMissed.length > 0) {
    items.push({
      id: 'S0',
      status: 'fail',
      detail: `管线孪生帧未命中：${input.pipelineMissed.join('、')}。金丝雀管线未被证明，自检判失败`,
    });
  } else if (
    (coreMisses.length === coreCount && anyOpaqueHit) ||
    (coreMisses.length === 0 && input.blockedEarly)
  ) {
    items.push({
      id: 'S0',
      status: 'fail',
      detail: `${PARTIAL_BLOCK_DETAIL}（管线孪生帧命中，不透明来源通道有的被拦、有的命中），自检判失败`,
    });
  } else if (coreMisses.length === 0) {
    items.push({
      id: 'S0',
      status: 'pass',
      detail: `对照组 ${coreCount} 种核心通道全部命中（延迟 ${Math.round(input.controlLatency ?? 0)} 毫秒，等待窗口 ${input.windowMs} 毫秒）${unsupportedNote}`,
    });
  } else if (coreMisses.length === coreCount) {
    // 管线通、不透明来源一个都打不中：浏览器整体拦截了不透明来源访问本机
    items.push({
      id: 'S0',
      status: 'pass',
      detail: `${BROWSER_BLOCKS_LOCAL_DETAIL}（管线孪生帧命中，${coreCount} 种不透明来源对照通道全部被拦，等待窗口 ${input.windowMs} 毫秒）`,
    });
  } else {
    items.push({
      id: 'S0',
      status: 'fail',
      detail: `对照组核心通道部分未命中：${missedNames}。管线孪生帧命中而不透明来源对照组时中时不中，结果不可信，自检判失败`,
    });
  }

  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const) {
    if (id === 'S5' && input.secondHost === null) {
      items.push({
        id,
        status: 'skipped',
        detail: '本机没有第二个可用的 loopback 主机名，重定向一项未自检',
      });
      continue;
    }
    if (PLUGIN_FRAME_ITEMS.has(id) && innerMode === null) {
      items.push({ id, status: 'fail', detail: '插件探针帧没能启动，本项无法自检' });
      continue;
    }
    const own = planned.filter((p) => p.method.item === id);
    const leaked = own.filter((p) => hits[p.probeNonce] === true);
    if (id === 'S5') {
      items.push(judgeRedirect(own, leaked, hits));
      continue;
    }
    const unran = own.filter((p) => input.unranUnits.has(p.unitId));
    const missingChannels = own.filter(
      (p) =>
        p.method.optional &&
        !input.unranUnits.has(p.unitId) &&
        hits[p.controlNonce] !== true &&
        hits[p.probeNonce] !== true,
    );
    const notes: string[] = [];
    if (missingChannels.length > 0) {
      notes.push(`${UNSUPPORTED_NOTE}：${missingChannels.map((p) => p.method.label).join('、')}`);
    }
    if (id === 'S6') notes.push(S6_FORM_NOTE);
    const note = notes.map((n) => `。${n}`).join('');
    const failures: string[] = [];
    if (leaked.length > 0) {
      failures.push(`探针命中了本机金丝雀：${leaked.map((p) => p.method.label).join('、')}`);
    }
    if (unran.length > 0) {
      failures.push(`探测帧未运行：${unran.map((p) => p.method.label).join('、')}`);
    }
    items.push(
      failures.length > 0
        ? { id, status: 'fail', detail: `${failures.join('；')}${note}` }
        : { id, status: 'pass', detail: `金丝雀零命中（${own.length} 种手段）${note}` },
    );
  }

  items.push(judgePicker(env, input.engine, input.verified, input.twinPickers));
  return items;
}

/** S5（尽力而为）：探针命中 ⇒ 失败；对照组没全中 ⇒ 未自检；否则通过 */
function judgeRedirect(
  own: readonly PlannedMethod[],
  leaked: readonly PlannedMethod[],
  hits: Record<string, boolean>,
): PluginSelfCheckItem {
  if (leaked.length > 0) {
    return {
      id: 'S5',
      status: 'fail',
      detail: `探针命中了本机金丝雀：${leaked.map((p) => p.method.label).join('、')}`,
    };
  }
  if (own.some((p) => hits[p.controlNonce] !== true)) {
    return { id: 'S5', status: 'skipped', detail: S5_UNREACHABLE };
  }
  return { id: 'S5', status: 'pass', detail: `金丝雀零命中（${own.length} 种手段）` };
}

type PickerVerdict =
  | { name: PickerName; kind: 'absent' | 'isolated' }
  | { name: PickerName; kind: 'escaped'; reason: string }
  | { name: PickerName; kind: 'inconclusive'; reason: string };

const ENV_PICKER_FLAG: Record<
  PickerName,
  'hasSaveFilePicker' | 'hasOpenFilePicker' | 'hasDirectoryPicker'
> = {
  showSaveFilePicker: 'hasSaveFilePicker',
  showOpenFilePicker: 'hasOpenFilePicker',
  showDirectoryPicker: 'hasDirectoryPicker',
};

/**
 * 单种选择器的判定（§4.8 S7，2026-11-15 实测后改）：
 * - 不存在 ⇒ absent；无激活调用居然兑现、或限时内没结果（对话框可能已经开着）⇒ escaped（整项直接失败）
 * - 调用前读到本帧带激活而没调用（skipped-active）⇒ 判不出
 * - 插件帧被拒且是 SecurityError，原文与孪生帧（同引擎、同源、无激活）的拒绝原文不同 ⇒
 *   引擎在查激活之前就按隔离条件拒了，有没有点击都一样 ⇒ isolated
 * - 其余（错误名不是 SecurityError、原文与对照相同、对照缺席 / 没调用 / 拒绝不是 SecurityError）⇒ 判不出
 * 只比较两段原文是否相同，从不看原文写了什么。
 */
function judgeOnePicker(
  name: PickerName,
  env: PluginFrameEnv,
  twin: readonly PickerProbeResult[] | null,
): PickerVerdict {
  const own = env.pickerProbe?.find((p) => p.name === name);
  if (!own) {
    return env[ENV_PICKER_FLAG[name]]
      ? { name, kind: 'inconclusive', reason: '插件帧没有报回调用结果' }
      : { name, kind: 'absent' };
  }
  if (own.outcome === 'absent') return { name, kind: 'absent' };
  if (own.outcome === 'resolved') {
    return { name, kind: 'escaped', reason: '在没有点击时返回了结果' };
  }
  if (own.outcome === 'pending') {
    return { name, kind: 'escaped', reason: '调用在限时内既没返回也没被拒（对话框可能已打开）' };
  }
  if (own.outcome === 'skipped-active') {
    return { name, kind: 'inconclusive', reason: '插件帧带着用户激活，为免弹窗没有调用' };
  }
  if (own.errorName !== 'SecurityError') {
    return {
      name,
      kind: 'inconclusive',
      reason: `报错不是 SecurityError（${own.errorName || '无名称'}）`,
    };
  }
  if (twin === null) return { name, kind: 'inconclusive', reason: '对照帧没有报回结果' };
  const control = twin.find((p) => p.name === name);
  if (control?.outcome === 'skipped-active') {
    return { name, kind: 'inconclusive', reason: '对照帧带着用户激活，为免弹窗没有调用' };
  }
  if (!control || control.outcome !== 'rejected') {
    return { name, kind: 'inconclusive', reason: '对照帧里它没有被拒绝' };
  }
  if (control.errorName !== 'SecurityError') {
    return {
      name,
      kind: 'inconclusive',
      reason: `对照帧的拒绝不是 SecurityError（${control.errorName || '无名称'}）`,
    };
  }
  if (!own.message || !control.message) {
    return { name, kind: 'inconclusive', reason: '拒绝原文为空，无从比较' };
  }
  if (own.message === control.message) {
    return { name, kind: 'inconclusive', reason: '与对照帧「缺用户激活」的拒绝原文相同' };
  }
  return { name, kind: 'isolated' };
}

/**
 * S7：任何一种无激活调用兑现或悬而未决 ⇒ 失败（不看已验表）；每种都是 absent / isolated ⇒ 通过；
 * 有判不出的 ⇒ 回退到人工已验表（引擎 + 大版本在表里才通过）。
 */
function judgePicker(
  env: PluginFrameEnv | null,
  engine: PickerVerifiedEngine | null,
  verified: readonly PickerVerifiedEngine[],
  twin: readonly PickerProbeResult[] | null,
): PluginSelfCheckItem {
  if (!env) return { id: 'S7', status: 'fail', detail: '插件探针帧没能启动，读不到帧内环境' };
  const verdicts = PICKER_NAMES.map((name) => judgeOnePicker(name, env, twin));
  const escaped = verdicts.flatMap((v) => (v.kind === 'escaped' ? [`${v.name} ${v.reason}`] : []));
  if (escaped.length > 0) {
    return {
      id: 'S7',
      status: 'fail',
      detail: `插件帧里 ${escaped.join('；')}，文件选择器没被隔离`,
    };
  }
  const isolated = verdicts.filter((v) => v.kind === 'isolated').length;
  const absent = verdicts.filter((v) => v.kind === 'absent').length;
  const unsure = verdicts.flatMap((v) =>
    v.kind === 'inconclusive' ? [`${v.name}：${v.reason}`] : [],
  );
  if (unsure.length === 0) {
    const absentNote = absent > 0 ? `；另有 ${absent} 种插件帧里不存在` : '';
    return {
      id: 'S7',
      status: 'pass',
      detail:
        isolated > 0
          ? `文件选择器在插件帧里被隔离拒绝（无需点击即可确认），共 ${isolated} 种${absentNote}`
          : `插件帧里没有文件选择器（${absent} 种都不存在）`,
    };
  }
  const name = engine ? `${engine.engine} ${engine.major}` : '未识别的浏览器引擎';
  const listed =
    engine !== null && verified.some((v) => v.engine === engine.engine && v.major === engine.major);
  const head = `无法自动判定（${unsure.join('；')}），回退到人工已验表`;
  return listed
    ? { id: 'S7', status: 'pass', detail: `${head}：${name} 已通过人工矩阵的文件选择器一项` }
    : { id: 'S7', status: 'fail', detail: `${head}：${name} 不在人工矩阵已验表里` };
}

// ──────────────────────────────────────────────────────────────────────────────
// 人工矩阵探针
// ──────────────────────────────────────────────────────────────────────────────

/** 由片段拼出的本机样例地址（源码里不出现字面 URL）：ComfyUI 的默认端口 */
const LOOPBACK_SAMPLE = ['http:', '', '127.0.0.1:8188', ''].join('/');

/**
 * 人工矩阵探针文档（§4.8「人工矩阵」、§4.3、§4.6）：开发者模式下作为插件入口挂进
 * 真实的插件帧，由人逐个点按钮并对照抓包。覆盖自检测不到的几项：
 * 文件选择器的错误名、`mailto:` 与自定义协议、`window.open`、WebRTC 非法 ufrag、
 * `preconnect` / `dns-prefetch`。结果写在页面里，供人工抄回设计文档。
 */
export function buildManualMatrixProbe(): string {
  const config = jsLiteral({ loopback: LOOPBACK_SAMPLE });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件人工矩阵探针</title>
<style>
body { font: 14px/1.6 system-ui, sans-serif; margin: 12px; }
section { border: 1px solid #8884; border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; }
h2 { font-size: 15px; margin: 0 0 6px; }
button { margin: 2px 6px 2px 0; }
output { display: block; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body>
<h1 style="font-size:17px">插件人工矩阵探针</h1>
<p>在 Chromium、Firefox、Safari 的真实 localhost 页面上逐项点击，结果与抓包结论写回设计文档 §4.8。</p>
<section>
<h2>文件选择器（§4.6）</h2>
<p>需要人亲手点击。期望：方法不存在，或抛出 SecurityError（不是 NotAllowedError / AbortError）。</p>
<button id="picker-save">showSaveFilePicker</button>
<button id="picker-open">showOpenFilePicker</button>
<button id="picker-dir">showDirectoryPicker</button>
<output id="picker-out"></output>
</section>
<section>
<h2>外部协议（§4.3）</h2>
<p>期望：不拉起邮件客户端或外部程序。</p>
<a id="ext-mailto" href="mailto:selfcheck@example.com">mailto: 链接</a>
<a id="ext-custom" href="fated-poem-selfcheck:probe">自定义协议链接</a>
<button id="ext-assign">脚本导航到自定义协议</button>
<output id="ext-out"></output>
</section>
<section>
<h2>window.open（§4.3）</h2>
<p>期望：返回 null，不出现新窗口。</p>
<button id="open-btn">window.open</button>
<output id="open-out"></output>
</section>
<section>
<h2>WebRTC 非法 ufrag（§4.3、Q2）</h2>
<p>改写 SDP，塞进含空格或 CR/LF 的 ufrag。期望：setLocalDescription 拒绝。另请抓包确认 STUN 报文内容。</p>
<button id="rtc-space">含空格的 ufrag</button>
<button id="rtc-crlf">含 CR/LF 的 ufrag</button>
<output id="rtc-out"></output>
</section>
<section>
<h2>资源提示（§4.3、Q2）</h2>
<p>插入指向本机的 preconnect 与 dns-prefetch，请用抓包工具确认是否建连或查询。</p>
<button id="hint-preconnect">插入 preconnect</button>
<button id="hint-dns">插入 dns-prefetch</button>
<output id="hint-out"></output>
</section>
<script>
(() => {
  'use strict';
  const C = ${config};
  const $ = (id) => document.getElementById(id);
  const setAttr = (el, name, value) => el.setAttribute(name, value);
  const log = (id, text) => { $(id).textContent += text + '\\n'; };
  const describe = (err) => (err && err.name ? err.name : String(err)) + (err && err.message ? '：' + err.message : '');

  const picker = (name, out) => async () => {
    const fn = window[name];
    if (typeof fn !== 'function') { log(out, name + '：不存在'); return; }
    try { await fn.call(window); log(out, name + '：未抛错（失败）'); }
    catch (err) { log(out, name + '：' + describe(err)); }
  };
  $('picker-save').addEventListener('click', picker('showSaveFilePicker', 'picker-out'));
  $('picker-open').addEventListener('click', picker('showOpenFilePicker', 'picker-out'));
  $('picker-dir').addEventListener('click', picker('showDirectoryPicker', 'picker-out'));

  $('ext-mailto').addEventListener('click', () => log('ext-out', '已点击 mailto: 链接，请观察是否拉起邮件客户端'));
  $('ext-custom').addEventListener('click', () => log('ext-out', '已点击自定义协议链接，请观察是否弹出外部程序'));
  $('ext-assign').addEventListener('click', () => {
    try { location.assign('fated-poem-selfcheck:assign'); log('ext-out', '已尝试脚本导航'); }
    catch (err) { log('ext-out', '脚本导航抛错：' + describe(err)); }
  });

  $('open-btn').addEventListener('click', () => {
    try {
      const w = window.open(C.loopback, '_blank');
      log('open-out', w === null ? 'window.open 返回 null（通过）' : 'window.open 返回了窗口（失败）');
    } catch (err) { log('open-out', 'window.open 抛错：' + describe(err)); }
  });

  const rtc = (bad, label) => async () => {
    if (typeof RTCPeerConnection !== 'function') { log('rtc-out', label + '：没有 RTCPeerConnection'); return; }
    const pc = new RTCPeerConnection();
    try {
      pc.createDataChannel('probe');
      const offer = await pc.createOffer();
      const sdp = offer.sdp.replace(/a=ice-ufrag:[^\\r\\n]*/g, 'a=ice-ufrag:' + bad);
      await pc.setLocalDescription({ type: 'offer', sdp });
      log('rtc-out', label + '：setLocalDescription 接受了非法 ufrag（失败）');
    } catch (err) {
      log('rtc-out', label + '：被拒绝 —— ' + describe(err));
    } finally { pc.close(); }
  };
  $('rtc-space').addEventListener('click', rtc('ab cd', '含空格'));
  $('rtc-crlf').addEventListener('click', rtc('ab\\r\\nGET / HTTP/1.1', '含 CR/LF'));

  const hint = (rel) => () => {
    const link = document.createElement('link');
    link.rel = rel;
    setAttr(link, 'href', C.loopback);
    document.head.appendChild(link);
    log('hint-out', '已插入 <link rel=' + rel + '>，目标 ' + C.loopback);
  };
  $('hint-preconnect').addEventListener('click', hint('preconnect'));
  $('hint-dns').addEventListener('click', hint('dns-prefetch'));
})();
</script>
</body>
</html>`;
}
