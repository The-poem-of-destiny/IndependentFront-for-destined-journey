/**
 * ejs-quickjs-backend.ts —— QuickJS(wasm) 求值后端（能力面设计 §0.1 / 切片 T7）
 *
 * ## 它解决什么
 * `LegacyBackend`（`new Function`）**不是安全边界**：`Object.constructor("return globalThis")()`
 * 一行拿回真全局 → API Key + 存档 + 本地 BFF（SEC-02）。参数遮蔽挡不住，因为权限来自 **realm**。
 *
 * QuickJS 换的正是 realm。实测（2026-08-01，quickjs-emscripten 0.32）四条全部成立：
 *
 * | 攻击 | 结果 |
 * |---|---|
 * | `Object.constructor("return globalThis")().fetch` | `undefined` —— 拿到的是 **guest 自己的**全局 |
 * | `while(true){}` | interrupt 掐断 ✓ |
 * | `/(a+)+b/.test("a".repeat(40))`（灾难性回溯） | interrupt 掐断 ✓（762ms） |
 * | `"x".repeat(1e9)` | 内存上限拒绝 ✓ |
 *
 * 第三条是**关键**：单表达式、无循环无调用，AST 方案的 `__tick` 注入永远执行不到，
 * 而真机语料 19 个条目用正则字面量 —— 那是内容作者可写的真实 DoS 面。
 *
 * ## 跑主线程，不跑 Worker
 * interrupt 在主线程就能掐死死循环，realm 隔离也不依赖 Worker。
 * 跑主线程 = 宿主能力调用**全部同步**（`lore.get` 直接返回），不需要 SharedArrayBuffer / COOP-COEP 头。
 * 代价是预算内的耗时会卡住 UI —— 那是性能项，由 §6.2 的 pass 级天花板兜住，不是安全前提。
 *
 * ## 编组模型
 * 一个 pass 一次性建 context → 注入能力面 → 按序跑完全部条目 → 取回 `vars` → dispose。
 * `vars` 草稿**留在 guest 内**跨条目演化（「前条目写→后条目立即可见」的语义因此免费保住），
 * 只在 pass 结束时整体回传一次。
 *
 * ## 已知能力差异（§3.14 已登记）
 * QuickJS 无 `Intl` / `structuredClone`，`localeCompare` 非本地化，
 * **命名捕获组不可用**（实测 `exec` 返回 null；真机语料 0 处使用，不阻塞）。
 * 创作者应走 `fmt.*`。
 */

import type { EjsBackend, EjsEntryOutcome, EjsPassEntry } from './ejs-backend';
import type { EjsEvalContext } from './ejs-runtime';
import { buildEjsCapabilities, LOCAL_ROOT } from './ejs-capabilities';
import { createEjsRng } from './ejs-rng';
import { ejsFmt } from './ejs-fmt';
import { ejsLodash } from './ejs-lodash-shim';

// ═══════════════════════════════════════════════════════════
// 预算（能力面 §6.2）
// ═══════════════════════════════════════════════════════════

export interface QuickJsBudget {
  /** 单条目执行时间（ms）。超时 → 该条目回退原文，**继续下一条** */
  entryTimeoutMs: number;
  /** 单 pass 总时间（ms）。超时 → 剩余条目全部回退。**这是 DoS 防线不是性能项** */
  passTimeoutMs: number;
  /** guest 内存上限（字节） */
  memoryLimitBytes: number;
  /** guest 最大栈（字节） */
  maxStackBytes: number;
}

export const DEFAULT_QUICKJS_BUDGET: QuickJsBudget = {
  entryTimeoutMs: 50,
  // 🔴 没有 pass 天花板时，109 个动态条目各吃满 50ms = 5.5 秒主线程冻结
  passTimeoutMs: 1500,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
};

// ═══════════════════════════════════════════════════════════
// 依赖装载（惰性，且允许缺席）
// ═══════════════════════════════════════════════════════════

/** `quickjs-emscripten` 的最小结构类型 —— 不引它的类型定义，免得后端接口被第三方类型绑死 */
interface QuickJsModuleLike {
  newRuntime(): QuickJsRuntimeLike;
}
interface QuickJsRuntimeLike {
  setMemoryLimit(n: number): void;
  setMaxStackSize(n: number): void;
  setInterruptHandler(h: () => boolean): void;
  removeInterruptHandler?(): void;
  newContext(): QuickJsContextLike;
  dispose(): void;
}
interface QuickJsContextLike {
  evalCode(code: string, filename?: string): { error?: any; value?: any };
  unwrapResult(r: any): any;
  dump(handle: any): unknown;
  newFunction(name: string, fn: (...args: any[]) => any): any;
  newString(s: string): any;
  setProp(target: any, key: string, value: any): void;
  getProp(target: any, key: string): any;
  global: any;
  undefined: any;
  dispose(): void;
}

type ModuleLoader = () => Promise<QuickJsModuleLike>;

/**
 * 默认装载器：动态 import。
 *
 * **动态**而非静态：wasm 有体积，装不上/加载失败时应当退回 Legacy 而不是让整个应用起不来。
 * 测试通过 `createQuickJsBackend({ loadModule })` 注入假实现（口径同 audio / asset 的注入缝）。
 */
const defaultLoader: ModuleLoader = async () => {
  const mod = (await import('quickjs-emscripten')) as unknown as {
    getQuickJS: () => Promise<QuickJsModuleLike>;
  };
  return mod.getQuickJS();
};

// ═══════════════════════════════════════════════════════════
// 宿主 ↔ guest 编组
// ═══════════════════════════════════════════════════════════

/**
 * 把宿主值塞进 guest：**只走 JSON**。
 *
 * 刻意不做逐句柄构造：能力面的数据轴契约本来就是 JSON-ish（§3.2/§3.3），
 * 用 JSON 一次性过境比逐字段建句柄快得多，也不会漏释放句柄。
 * 不可序列化（含环）→ 返回 `undefined`，由调用方按 D8 处理。
 */
function toGuestJson(value: unknown): string | undefined {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** guest 侧运行时前导：把宿主注入的 JSON 与桥接函数装配成完整的能力面 */
const GUEST_PRELUDE = `
globalThis.__ejs = (function () {
  'use strict';
  var out = [];
  return {
    reset: function () { out = []; },
    push: function (v) { out.push(v === undefined || v === null ? '' : String(v)); },
    take: function () { var s = out.join(''); out = []; return s; },
  };
})();
`;

// ═══════════════════════════════════════════════════════════
// 后端
// ═══════════════════════════════════════════════════════════

export interface QuickJsBackendOptions {
  budget?: Partial<QuickJsBudget>;
  /** 注入缝：测试用假模块，生产留空走动态 import */
  loadModule?: ModuleLoader;
}

/**
 * QuickJS 后端。
 *
 * ⚠️ **首次 `runPass` 才装载 wasm**（构造函数不装）：装载失败时抛在 `runPass` 内，
 * 由 `worldbook-loader` 的 D8 兜住，退化成「全部条目原文注入」——
 * 比在应用启动期炸掉好得多。
 */
export class QuickJsBackend implements EjsBackend {
  readonly name = 'quickjs(wasm)';
  /** 这正是它存在的理由 */
  readonly interruptible = true;

  private readonly budget: QuickJsBudget;
  private readonly loadModule: ModuleLoader;
  private modulePromise: Promise<QuickJsModuleLike> | null = null;

  constructor(options: QuickJsBackendOptions = {}) {
    this.budget = { ...DEFAULT_QUICKJS_BUDGET, ...(options.budget ?? {}) };
    this.loadModule = options.loadModule ?? defaultLoader;
  }

  private module(): Promise<QuickJsModuleLike> {
    if (!this.modulePromise) this.modulePromise = this.loadModule();
    return this.modulePromise;
  }

  async runPass(entries: EjsPassEntry[], ctx: EjsEvalContext): Promise<EjsEntryOutcome[]> {
    if (entries.length === 0) return [];

    let QuickJS: QuickJsModuleLike;
    try {
      QuickJS = await this.module();
    } catch (err) {
      // 装载失败 → 整 pass 回退原文（D8），不抛穿
      const reason = `QuickJS 装载失败: ${err instanceof Error ? err.message : String(err)}`;
      return entries.map((e) => ({ uid: e.uid, text: e.content, ok: false, error: reason }));
    }

    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.budget.memoryLimitBytes);
    runtime.setMaxStackSize(this.budget.maxStackBytes);

    const context = runtime.newContext();
    const out: EjsEntryOutcome[] = [];
    const passStart = Date.now();

    try {
      this.installCapabilities(context, ctx);

      for (const entry of entries) {
        // pass 天花板：剩余条目一律回退，不再进 guest
        if (Date.now() - passStart > this.budget.passTimeoutMs) {
          out.push({
            uid: entry.uid,
            text: entry.content,
            ok: false,
            error: `pass 执行预算 ${this.budget.passTimeoutMs}ms 耗尽`,
          });
          continue;
        }
        out.push(this.runEntry(runtime, context, entry, ctx));
      }

      // 草稿整体回传（pass 内一直留在 guest，到这里才过境一次）
      this.readBackVars(context, ctx);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      for (const entry of entries.slice(out.length)) {
        out.push({ uid: entry.uid, text: entry.content, ok: false, error: reason });
      }
    } finally {
      try {
        context.dispose();
      } catch {
        /* 释放失败不该盖住结果 */
      }
      try {
        runtime.dispose();
      } catch {
        /* 同上 */
      }
    }

    return out;
  }

  /**
   * 装配 guest 侧的能力面。
   *
   * 分工（§3.14 的实现约束）：
   * - **纯函数**（`fmt` / `_` / `rng`）→ 走桥接函数，宿主实现、guest 调用。
   *   它们吃回调时回调是 guest 函数，故只桥**不吃回调**的那部分；吃回调的
   *   （`_.mapValues` 等）在 guest 侧用 JSON 往返退化为「先取值再自己遍历」。
   * - **数据**（`stats` / `vars` / `world` / …）→ JSON 一次性过境。
   * - **宿主查询**（`lore` / `chat` / `ui`）→ 桥接函数，同步返回。
   */
  private installCapabilities(context: QuickJsContextLike, ctx: EjsEvalContext): void {
    const caps = buildEjsCapabilities(ctx.vars, ctx.historyText ?? '', ctx.capabilities);
    const rng = createEjsRng(`${ctx.seed ?? 'no-seed'}|pass`);

    // 前导 + 数据轴
    context.unwrapResult(context.evalCode(GUEST_PRELUDE));
    const data = {
      stats: ctx.stats ?? {},
      vars: ctx.vars ?? {},
      world: {
        时间: caps.world.时间,
        时间详情: caps.world.时间详情,
        地点: caps.world.地点,
        天气: caps.world.天气,
        回合: caps.world.回合,
      },
      charLoreBook: caps.charLoreBook,
      engine: { name: caps.engine.name, version: caps.engine.version },
    };
    const json = toGuestJson(data);
    if (json === undefined) throw new Error('EJS 数据轴不可序列化（含环或宿主对象）');
    context.unwrapResult(
      context.evalCode(`globalThis.__ejsData = ${json};
globalThis.stats = __ejsData.stats;
globalThis.vars = __ejsData.vars;
globalThis.world = __ejsData.world;
globalThis.charLoreBook = __ejsData.charLoreBook;
globalThis.engine = __ejsData.engine;`),
    );

    // 桥接函数：宿主实现，guest 用 JSON 收发（返回值一律 JSON 串，guest 侧 parse）
    const bridge = (name: string, impl: (...args: unknown[]) => unknown): void => {
      const handle = context.newFunction(name, (...handles: any[]) => {
        const args = handles.map((h) => context.dump(h));
        let result: unknown;
        try {
          result = impl(...args);
        } catch {
          result = null; // P3：能力永不抛，抛了也不能穿过边界
        }
        return context.newString(toGuestJson(result ?? null) ?? 'null');
      });
      context.setProp(context.global, name, handle);
      handle.dispose?.();
    };

    bridge('__b_chat_at', (i, role) => caps.chat.at(Number(i), role as string | undefined));
    bridge('__b_chat_slice', (a, b, role) =>
      caps.chat.slice(Number(a), Number(b), role as string | undefined),
    );
    bridge('__b_chat_match', (p) => caps.chat.match(p));
    bridge('__b_chat_text', () => caps.chat.text());
    bridge('__b_char', (op, name) => {
      switch (op) {
        case 'player':
          return caps.char.player();
        case 'get':
          return caps.char.get(String(name ?? ''));
        case 'present':
          return caps.char.present();
        case 'all':
          return caps.char.all();
        case 'has':
          return caps.char.has(String(name ?? ''));
        case 'affection':
          return caps.char.affection(String(name ?? ''));
        case 'affectionLabel':
          return caps.char.affectionLabel(String(name ?? ''));
        default:
          return null;
      }
    });
    bridge('__b_quest', (op, name) => {
      switch (op) {
        case 'all':
          return caps.quest.all();
        case 'active':
          return caps.quest.active();
        case 'get':
          return caps.quest.get(String(name ?? ''));
        case 'has':
          return caps.quest.has(String(name ?? ''));
        case 'focus':
          return caps.quest.focus();
        default:
          return null;
      }
    });
    bridge('__b_lore', (op, a, b) => {
      if (op === 'get')
        return caps.lore.get(String(a ?? ''), b === undefined ? undefined : String(b));
      if (op === 'has')
        return caps.lore.has(String(a ?? ''), b === undefined ? undefined : String(b));
      if (op === 'list') return caps.lore.list(String(a ?? ''));
      return null;
    });
    bridge('__b_local', (op, key, value) => {
      switch (op) {
        case 'get':
          return caps.local.get(String(key ?? ''), value);
        case 'set':
          caps.local.set(String(key ?? ''), value);
          return null;
        case 'has':
          return caps.local.has(String(key ?? ''));
        case 'remove':
          caps.local.remove(String(key ?? ''));
          return null;
        case 'keys':
          return caps.local.keys();
        default:
          return null;
      }
    });
    bridge('__b_ui', (op, msg, level) => {
      if (op === 'notify') caps.ui.notify(String(msg ?? ''), level as any);
      else caps.ui.log(msg);
      return null;
    });
    bridge('__b_engine_has', (path) => caps.engine.has(path));
    bridge('__b_fmt', (op, ...args) => (ejsFmt as any)[String(op)]?.(...args) ?? '');
    bridge('__b_rng', (op, ...args) => (rng as any)[String(op)]?.(...args) ?? null);
    bridge('__b_lodash', (op, ...args) => {
      const fn = (ejsLodash as any)[String(op)];
      // 吃回调的方法在 guest 侧自己实现（跨边界传函数不可行，§3.14 实现约束）
      return typeof fn === 'function' ? fn(...args) : null;
    });

    // guest 侧门面：把桥接函数包成 §3 的 namespace 形状
    context.unwrapResult(context.evalCode(GUEST_FACADE));
  }

  /** 跑单条目：编译 + 执行 + 取输出，全程受 interrupt 约束 */
  private runEntry(
    runtime: QuickJsRuntimeLike,
    context: QuickJsContextLike,
    entry: EjsPassEntry,
    _ctx: EjsEvalContext,
  ): EjsEntryOutcome {
    const deadline = Date.now() + this.budget.entryTimeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    try {
      const source = entry.content ?? '';
      const wrapped = `(function(){ __ejs.reset(); ${compileToGuestBody(source)} })(); __ejs.take()`;
      const result = context.evalCode(wrapped, `entry-${entry.uid}.js`);
      if (result.error) {
        const detail = context.dump(result.error) as { name?: string; message?: string };
        result.error.dispose?.();
        return {
          uid: entry.uid,
          text: entry.content,
          ok: false,
          error: `${detail?.name ?? 'Error'}: ${detail?.message ?? '未知'}`,
        };
      }
      const text = String(context.dump(result.value) ?? '');
      result.value.dispose?.();
      return { uid: entry.uid, text, ok: true };
    } catch (err) {
      return {
        uid: entry.uid,
        text: entry.content,
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    } finally {
      runtime.removeInterruptHandler?.();
    }
  }

  /** pass 结束把 guest 侧的 `vars` 草稿整体搬回宿主对象（**就地**，调用方持有同一引用） */
  private readBackVars(context: QuickJsContextLike, ctx: EjsEvalContext): void {
    const r = context.evalCode('JSON.stringify(globalThis.vars)');
    if (r.error) {
      r.error.dispose?.();
      return;
    }
    const raw = String(context.dump(r.value) ?? '');
    r.value.dispose?.();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 🔴 `_local` 不参与回传：`local.*` 走的是**宿主桥接**（要走预算与序列化校验），
      //    写入直接落在 ctx.vars._local 上；guest 侧那份 vars 快照里没有这些写。
      //    整体覆盖会把它们抹掉 —— 必须留住。
      const localBucket = ctx.vars[LOCAL_ROOT];
      for (const k of Object.keys(ctx.vars)) delete ctx.vars[k];
      Object.assign(ctx.vars, parsed);
      if (localBucket !== undefined) ctx.vars[LOCAL_ROOT] = localBucket;
    } catch {
      // 回传失败 → 草稿保持 pass 开始的样子（不半写）
    }
  }

  dispose(): void {
    // runtime/context 是 per-pass 的，这里没有常驻资源；模块句柄留着复用
    this.modulePromise = null;
  }
}

/** guest 侧门面源码：把 `__b_*` 桥接函数包成创作者写的 namespace 形状 */
const GUEST_FACADE = `
(function () {
  'use strict';
  var P = function (s) { try { return JSON.parse(s); } catch (e) { return null; } };
  globalThis.chat = {
    at: function (i, role) { return P(__b_chat_at(i, role)) || ''; },
    last: function (role) { return P(__b_chat_at(-1, role)) || ''; },
    slice: function (a, b, role) { return P(__b_chat_slice(a, b, role)) || []; },
    match: function (p) { return !!P(__b_chat_match(p instanceof RegExp ? p.source : p)); },
    text: function () { return P(__b_chat_text()) || ''; },
  };
  globalThis.char = {
    player: function () { return P(__b_char('player')); },
    get: function (n) { return P(__b_char('get', n)); },
    present: function () { return P(__b_char('present')) || []; },
    all: function () { return P(__b_char('all')) || []; },
    has: function (n) { return !!P(__b_char('has', n)); },
    affection: function (n) { return P(__b_char('affection', n)) || 0; },
    affectionLabel: function (n) { return P(__b_char('affectionLabel', n)) || ''; },
  };
  globalThis.quest = {
    all: function () { return P(__b_quest('all')) || []; },
    active: function () { return P(__b_quest('active')) || []; },
    get: function (n) { return P(__b_quest('get', n)); },
    has: function (n) { return !!P(__b_quest('has', n)); },
    focus: function () { return P(__b_quest('focus')); },
  };
  globalThis.lore = {
    get: function (a, b) { return P(__b_lore('get', a, b)) || ''; },
    has: function (a, b) { return !!P(__b_lore('has', a, b)); },
    list: function (b) { return P(__b_lore('list', b)) || []; },
  };
  globalThis.local = {
    get: function (k, d) { var v = P(__b_local('get', k, d)); return v === null ? (d === undefined ? null : d) : v; },
    set: function (k, v) { __b_local('set', k, v); },
    has: function (k) { return !!P(__b_local('has', k)); },
    remove: function (k) { __b_local('remove', k); },
    keys: function () { return P(__b_local('keys')) || []; },
  };
  globalThis.ui = {
    notify: function (m, l) { __b_ui('notify', m, l); },
    log: function () { __b_ui('log', Array.prototype.slice.call(arguments).join(' ')); },
  };
  globalThis.engine.has = function (p) { return !!P(__b_engine_has(p)); };

  var fmtNames = ['yaml','json','table','list','num','pct','bar','pad','truncate','compareName','sortNames'];
  globalThis.fmt = {};
  fmtNames.forEach(function (n) { globalThis.fmt[n] = function () { return P(__b_fmt.apply(null, [n].concat(Array.prototype.slice.call(arguments)))); }; });

  var rngNames = ['roll','rollDetail','int','float','pick','pickN','shuffle','chance'];
  globalThis.rng = {};
  rngNames.forEach(function (n) { globalThis.rng[n] = function () { return P(__b_rng.apply(null, [n].concat(Array.prototype.slice.call(arguments)))); }; });

  // lodash：不吃回调的走桥接；吃回调的在 guest 侧现写（跨边界传函数不可行）
  var lo = {};
  ['get','trim','isArray','isObject','isObjectLike','isEmpty','values','keys','has','uniq',
   'isPlainObject','isNumber','isString','size','cloneDeep','omit','pick'].forEach(function (n) {
    lo[n] = function () { return P(__b_lodash.apply(null, [n].concat(Array.prototype.slice.call(arguments)))); };
  });
  lo.mapValues = function (o, f) { var r = {}; Object.keys(o || {}).forEach(function (k) { r[k] = f(o[k], k, o); }); return r; };
  lo.mapKeys = function (o, f) { var r = {}; Object.keys(o || {}).forEach(function (k) { r[String(f(o[k], k, o))] = o[k]; }); return r; };
  lo.pickBy = function (o, f) { var r = {}; Object.keys(o || {}).forEach(function (k) { if (f(o[k], k)) r[k] = o[k]; }); return r; };
  lo.forOwn = function (o, f) { Object.keys(o || {}).forEach(function (k) { f(o[k], k, o); }); return o; };
  lo.find = function (c, f) { return (c || []).filter(function (x, i) { return f(x, i); })[0]; };
  lo.flatMap = function (c, f) { return (c || []).map(f).reduce(function (a, b) { return a.concat(b); }, []); };
  lo.keyBy = function (c, f) { var r = {}; (c || []).forEach(function (x) { r[String(typeof f === 'function' ? f(x) : x[f])] = x; }); return r; };
  globalThis._ = lo;
})();
`;

/**
 * EJS 正文 → guest 侧函数体。
 *
 * 与 `ejs-runtime.buildFnBody` **同一套规则**（文本 push、代码内联、`<%=` push(String(expr))），
 * 但输出走 guest 的 `__ejs` 收集器。刻意重写而非复用：那边的产物绑在宿主 `new Function` 的
 * 形参注入模型上，这边的能力是 guest 全局，两套装配方式不同，硬合并只会让两边都别扭。
 */
function compileToGuestBody(source: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < source.length) {
    const open = source.indexOf('<%', pos);
    if (open === -1) {
      parts.push(`__ejs.push(${JSON.stringify(source.slice(pos))});`);
      break;
    }
    if (open > pos) parts.push(`__ejs.push(${JSON.stringify(source.slice(pos, open))});`);
    if (source[open + 2] === '%') {
      parts.push('__ejs.push("<%");');
      pos = open + 3;
      continue;
    }
    let cursor = open + 2;
    let kind: 'code' | 'out' | 'comment' = 'code';
    const marker = source[cursor];
    if (marker === '_') cursor++;
    else if (marker === '=' || marker === '-') {
      kind = 'out';
      cursor++;
    } else if (marker === '#') {
      kind = 'comment';
      cursor++;
    }
    const close = source.indexOf('%>', cursor);
    if (close === -1) {
      parts.push(`__ejs.push(${JSON.stringify(source.slice(open))});`);
      break;
    }
    let end = close;
    const prev = source[close - 1];
    if (prev === '_' || prev === '-') end = close - 1;
    const raw = source.slice(cursor, end);
    if (kind === 'code') parts.push(raw);
    else if (kind === 'out') parts.push(`__ejs.push(${raw.trim() || 'undefined'});`);
    pos = close + 2;
  }
  return parts.join('\n');
}

/** 造一个 QuickJS 后端（生产用默认参数；测试可注入假模块与更小预算） */
export function createQuickJsBackend(options: QuickJsBackendOptions = {}): QuickJsBackend {
  return new QuickJsBackend(options);
}
