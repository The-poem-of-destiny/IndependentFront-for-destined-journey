/**
 * script-quickjs-backend.ts —— 词条脚本的 QuickJS(wasm) 隔离后端（SEC-02 收口）
 *
 * 与 `ejs-quickjs-backend.ts` 同一道边界、同一套踩坑经验（句柄释放 / 微任务抽干 /
 * interrupt 装在求值之前），但**契约不同**，所以不复用那个类：
 *
 * | | EJS 后端 | 本后端 |
 * |---|---|---|
 * | 粒度 | 一个装配 pass 的全部条目共享一个 context（草稿要跨条目演化） | **一次脚本一个 context**（脚本之间必须零泄漏） |
 * | 出参 | 渲染出来的字符串 | 无 —— 副作用经**宿主闭包**落进 `ScriptEffects` |
 * | 同异步 | `runPass` 是 async | `run` **必须同步**（三个调用点都在同步链上） |
 *
 * ## 副作用怎么出来的（这一层的要害）
 * guest 里**不存在** effects 收集器。guest 调 `$resource.modifyHp(...)` 时，走桥接函数回到宿主，
 * 由 `buildSandbox()` 造的那个**原封不动的宿主闭包**执行 —— 也就是说收集逻辑一行没改，
 * `_parentScripts` 盖章、`$call` 递归合并、`$event.on` 的 handle 编号全都还在宿主侧原样发生。
 * 换掉的只有「脚本代码在哪个 realm 里跑」。这正是本次改动兼容性的来源。
 *
 * ## guest 面从 `buildSandbox()` 推导，不另列名单
 * 见 `script-backend.ts` 里 `ScriptSandboxSpec` 的说明。加 `$foo` 不需要动本文件。
 */

// 仅类型（编译期擦除）——与 `script-backend.ts` 对本文件的 type-only import 构成
// 一个**类型层面的**环；这在 TS 里是合法的，且 ejs-backend ↔ ejs-quickjs-backend
// 用的就是同一个形状。值层面的边只有一条：`script-backend` 的动态 import。
import type { ScriptBackend, ScriptRunOutcome, ScriptSandboxSpec } from './script-backend';

// ═══════════════════════════════════════════════════════════
// 预算
// ═══════════════════════════════════════════════════════════

export interface ScriptQuickJsBudget {
  /** 单次脚本执行的墙钟上限（ms） */
  scriptTimeoutMs: number;
  /** guest 内存上限（字节） */
  memoryLimitBytes: number;
  /** guest 最大栈（字节） */
  maxStackBytes: number;
}

const DEFAULT_SCRIPT_BUDGET: ScriptQuickJsBudget = {
  /**
   * 50ms —— 与 EJS 单条目同档。
   *
   * 依据：效果脚本的形状是「几个 `$` 调用 + 一点算术」，实测微秒级；50ms 给到约三个数量级余量。
   * 它防的是 `init` 里一句 `for(;;);` —— 那句话在旧实现下会在**每次读档**时冻死标签页
   * （审查里那条「即使没有对手也存在的意外面」）。现在最多顿 50ms 然后这条脚本报错出局。
   */
  scriptTimeoutMs: 50,
  /** 32MB：脚本比世界书条目轻得多，不需要 EJS 那 64MB */
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
};

/** 微任务泵轮数上限 —— guest 可以写自我调度的无穷 job 链，不设上限等于放开一条绕过 interrupt 的通道 */
const MAX_DRAIN_ROUNDS = 64;

/**
 * 抽干队列允许超出脚本 deadline 的宽限（ms）。
 *
 * 🔴 抽干**不能**直接套脚本的 deadline：超时的脚本恰恰是最可能留下 job 的那种，
 *    而「一轮都不转就 dispose」正是 QuickJS Abort 整个 wasm 实例的触发条件。
 *    所以给一段独立的小预算，只用来收尾。
 */
const DRAIN_GRACE_MS = 20;

// ═══════════════════════════════════════════════════════════
// 依赖装载（惰性）
// ═══════════════════════════════════════════════════════════

interface QuickJsModuleLike {
  newRuntime(): QuickJsRuntimeLike;
}
interface QuickJsRuntimeLike {
  setMemoryLimit(n: number): void;
  setMaxStackSize(n: number): void;
  setInterruptHandler(h: () => boolean): void;
  removeInterruptHandler?(): void;
  newContext(): QuickJsContextLike;
  executePendingJobs?(maxJobs?: number): PendingJobsResultLike | undefined;
  dispose(): void;
}
interface QuickJsContextLike {
  evalCode(code: string, filename?: string): { error?: any; value?: any };
  dump(handle: any): unknown;
  newFunction(name: string, fn: (...args: any[]) => any): any;
  newString(s: string): any;
  setProp(target: any, key: string, value: any): void;
  global: any;
  dispose(): void;
}

/**
 * `executePendingJobs` 的真实返回形状 —— `{ value } | { error }` + `dispose()`，**不是 `number`**。
 * 按 `number` 声明的后果（早退判断恒不成立 / 空转满轮 / 错误句柄没人释放 → `runtime.dispose()`
 * 断言失败 Abort 整个 wasm 实例）在 `ejs-quickjs-backend.ts` 的同名类型上有完整记录。
 */
type PendingJobsResultLike = number | { value?: number; error?: unknown; dispose?(): void };

function readPumpedCount(result: PendingJobsResultLike | undefined | null): number | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'number') return result;
  const failed = result.error !== undefined && result.error !== null;
  try {
    result.dispose?.();
  } catch {
    /* 释放失败不该盖住结果 */
  }
  if (failed) return 0;
  const n = Number(result.value);
  return Number.isFinite(n) ? n : undefined;
}

type ModuleLoader = () => Promise<QuickJsModuleLike>;

const defaultLoader: ModuleLoader = async () => {
  const mod = (await import('quickjs-emscripten')) as unknown as {
    getQuickJS: () => Promise<QuickJsModuleLike>;
  };
  return mod.getQuickJS();
};

// ═══════════════════════════════════════════════════════════
// guest 前导
// ═══════════════════════════════════════════════════════════

/**
 * 宿主↔guest 的调用信封。
 *
 * `{ v: 返回值 }` 或 `{ e: 1, m: 消息 }`。
 *
 * 🔴 错误必须**显式编码**，不能指望「宿主闭包抛出的异常自动变成 guest 异常」——
 *    那个行为取决于 `quickjs-emscripten` 的版本细节。而它必须保真：旧实现里
 *    `readHooks` 抛错会打断脚本、由 `executeScript` 的 try/catch 兜住并**保留已收集的部分效果**。
 *    悄悄吞掉改成「继续往下跑」会让半个脚本的效果凭空多出来。
 */
const GUEST_PRELUDE = `
globalThis.__sbx = (function () {
  'use strict';
  return function (path) {
    var args = Array.prototype.slice.call(arguments, 1);
    var env = JSON.parse(__sbxHostCall(path, JSON.stringify(args)));
    if (env && env.e) throw new Error(env.m);
    return env ? env.v : undefined;
  };
})();
`;

/**
 * 旧实现用**同名形参遮蔽**成 `undefined` 的那批宿主全局。
 *
 * QuickJS 里它们本来就不存在，照理不必管。这里仍然显式定义成 `undefined`，
 * 为的是**保真**：旧实现下 `if (window) {...}` 取到 `undefined` 走 else 分支；
 * 不定义的话裸引用 `window` 在严格模式下是 `ReferenceError`，脚本整个中断。
 * 差别只在少数防御性写法上，但那种写法恰恰是 AI 爱写的。
 *
 * 🔴 名单里**刻意不含** `Function` / `globalThis` / `eval`：
 *    旧实现遮蔽它们是因为它们是**逃逸路径**。在 realm 隔离里它们只是 guest 自己的东西，
 *    拿到的 `globalThis` 就是这个沙盒本身，够不到宿主。留着反而更兼容。
 */
const SHADOWED_HOST_GLOBALS = [
  'window',
  'document',
  'fetch',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'importScripts',
  'process',
  'require',
];

/** 把一个 JS 值编成可嵌进 guest 源码的**字符串字面量**（U+2028/2029 一并处理） */
function toJsStringLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ═══════════════════════════════════════════════════════════
// 沙盒面拆解
// ═══════════════════════════════════════════════════════════

interface SandboxShape {
  /** 可 JSON 过境的数据（owner / target / event / self …） */
  data: Record<string, unknown>;
  /** 需要桥接的函数路径：`'$call'` 或 `'$resource.modifyHp'` */
  fnPaths: string[];
}

/**
 * 把 `buildSandbox()` 的返回值拆成「数据」与「函数路径」两半。
 *
 * 只下探**一层** —— `$` 命名空间就是一层深，再深的嵌套函数（目前没有）会落进 data 一侧
 * 被 JSON 丢掉。真出现时表现为 guest 里那个键是 `undefined`，不是静默错值。
 */
function describeSandbox(sandbox: Record<string, unknown>): SandboxShape {
  const data: Record<string, unknown> = {};
  const fnPaths: string[] = [];

  for (const [key, value] of Object.entries(sandbox)) {
    if (typeof value === 'function') {
      fnPaths.push(key);
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const bag = value as Record<string, unknown>;
      const methods = Object.keys(bag).filter((k) => typeof bag[k] === 'function');
      if (methods.length > 0) {
        for (const m of methods) fnPaths.push(`${key}.${m}`);
        // 同一个 bag 里的非函数属性照样过境（目前没有，但别让它静默消失）
        const rest: Record<string, unknown> = {};
        for (const k of Object.keys(bag)) if (typeof bag[k] !== 'function') rest[k] = bag[k];
        if (Object.keys(rest).length > 0) data[key] = rest;
        continue;
      }
    }
    data[key] = value;
  }

  return { data, fnPaths };
}

/** 按函数路径生成 guest 侧门面 */
function buildFacadeSource(fnPaths: string[]): string {
  const lines: string[] = [];
  const namespaces = new Set<string>();

  for (const path of fnPaths) {
    const dot = path.indexOf('.');
    if (dot < 0) {
      lines.push(
        `globalThis[${toJsStringLiteral(path)}] = function () { ` +
          `return __sbx.apply(null, [${toJsStringLiteral(path)}].concat(Array.prototype.slice.call(arguments))); };`,
      );
      continue;
    }
    const ns = path.slice(0, dot);
    const method = path.slice(dot + 1);
    if (!namespaces.has(ns)) {
      namespaces.add(ns);
      // 命名空间可能已经因为「bag 里有非函数属性」被数据轴建出来了 —— 那就复用，别覆盖
      lines.push(
        `globalThis[${toJsStringLiteral(ns)}] = globalThis[${toJsStringLiteral(ns)}] || {};`,
      );
    }
    lines.push(
      `globalThis[${toJsStringLiteral(ns)}][${toJsStringLiteral(method)}] = function () { ` +
        `return __sbx.apply(null, [${toJsStringLiteral(path)}].concat(Array.prototype.slice.call(arguments))); };`,
    );
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// 后端
// ═══════════════════════════════════════════════════════════

export interface ScriptQuickJsBackendOptions {
  budget?: Partial<ScriptQuickJsBudget>;
  /** 注入缝：测试用假模块，生产留空走动态 import */
  loadModule?: ModuleLoader;
}

export class ScriptQuickJsBackend implements ScriptBackend {
  readonly name = 'quickjs(wasm)';
  readonly interruptible = true;

  private readonly budget: ScriptQuickJsBudget;
  private readonly loadModule: ModuleLoader;
  private modulePromise: Promise<QuickJsModuleLike> | null = null;
  /** 预热拿到的模块 —— `run` 是同步的，只能用这份已经装好的 */
  private module: QuickJsModuleLike | null = null;

  constructor(options: ScriptQuickJsBackendOptions = {}) {
    this.budget = { ...DEFAULT_SCRIPT_BUDGET, ...(options.budget ?? {}) };
    this.loadModule = options.loadModule ?? defaultLoader;
  }

  /**
   * 预热：**真的把 wasm 装起来并跑一次探针求值**，成功后把模块留在 `this.module`。
   *
   * 🔴 `run` 是同步的，所以「装载」这件事**只能**发生在这里。装不上就抛，
   *    由 `installProductionScriptBackend()` 转成 fail-closed —— 绝不留一条
   *    「还没装好所以先用 new Function 跑一轮」的窗口。
   */
  async warmup(): Promise<void> {
    if (!this.modulePromise) this.modulePromise = this.loadModule();
    const QuickJS = await this.modulePromise;
    const runtime = QuickJS.newRuntime();
    try {
      runtime.setMemoryLimit(this.budget.memoryLimitBytes);
      runtime.setMaxStackSize(this.budget.maxStackBytes);
      const context = runtime.newContext();
      try {
        const r = context.evalCode('1');
        if (r.error) {
          r.error.dispose?.();
          throw new Error('QuickJS 探针求值失败');
        }
        r.value?.dispose?.();
      } finally {
        context.dispose();
      }
    } finally {
      runtime.dispose();
    }
    this.module = QuickJS;
  }

  /**
   * 跑一段脚本。**永不抛**。
   *
   * ## 为什么每次都新建 runtime 而不是池化
   * 1. **零泄漏**是这一层的正确性要求：脚本 A 在 guest 里种一个全局，脚本 B 绝不能看见
   *    （COR-08 就是 EJS 那边跨条目复用 `stats` 引发的同形状缺陷）。
   * 2. `$call` 会**在宿主桥接回调里**递归回到 `run` —— 那时外层 context 正在 `evalCode` 中途。
   *    在同一个 runtime 上重入建 context 是没必要冒的风险；各自一个 runtime 天然无干扰。
   * 3. wasm 装好之后 `newRuntime()` 是廉价的，而脚本执行频率是「每事件」级别，不是每帧。
   */
  run(script: string, sandbox: ScriptSandboxSpec): ScriptRunOutcome {
    const QuickJS = this.module;
    if (!QuickJS)
      return { ok: false, error: 'QuickJS 未预热（installProductionScriptBackend 未完成）' };

    let runtime: QuickJsRuntimeLike;
    try {
      runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(this.budget.memoryLimitBytes);
      runtime.setMaxStackSize(this.budget.maxStackBytes);
    } catch (err) {
      return { ok: false, error: `QuickJS 运行时创建失败: ${describeError(err)}` };
    }

    let context: QuickJsContextLike;
    try {
      context = runtime.newContext();
    } catch (err) {
      try {
        runtime.dispose();
      } catch {
        /* 释放失败不该盖住降级 */
      }
      return { ok: false, error: `QuickJS 上下文创建失败: ${describeError(err)}` };
    }

    // 🔴 deadline + interrupt 必须装在**任何 guest 代码求值之前**。装配期那几段
    //    （前导 / 数据轴 / 门面）本身跑的就是 guest 代码，虽然是我们自己写的，
    //    但 `JSON.parse` 的入参来自宿主数据轴 —— 迟装一步就是一个没有护栏的窗口。
    const deadline = Date.now() + this.budget.scriptTimeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);

    try {
      this.installSandbox(context, sandbox);

      // 同步 IIFE + `"use strict"` —— 与旧实现的 `new Function('"use strict";' + script)`
      // 逐字节同构：`var` 是函数级、顶层 `this` 是 undefined、未声明赋值 ReferenceError。
      // 刻意**不**包 async 壳（EJS 那边包是因为条目允许 `await`）：旧实现是同步的，
      // 包了会让「脚本里 await」从 SyntaxError 变成静默半执行。
      const wrapped = `(function () { "use strict";\n${script}\n})();`;
      const result = context.evalCode(wrapped, 'effect-script.js');

      if (result.error) {
        const detail = context.dump(result.error) as { name?: string; message?: string } | string;
        result.error.dispose?.();
        const timedOut = Date.now() > deadline;
        const message =
          typeof detail === 'string'
            ? detail
            : `${detail?.name ?? 'Error'}: ${detail?.message ?? '未知'}`;
        return {
          ok: false,
          error: timedOut
            ? `脚本执行超时（${this.budget.scriptTimeoutMs}ms 预算耗尽）: ${message}`
            : message,
        };
      }
      result.value?.dispose?.();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      // 🔴 抽干微任务队列。脚本里 `Promise.resolve().then(...)` 会挂 job；不抽干就 dispose，
      //    QuickJS 断言 `list_empty(&rt->gc_obj_list)` 失败并 **Abort 整个 wasm 实例**，
      //    此后所有脚本执行全部报废 —— 而外面这圈 try/catch 会把它咽掉，症状是测试全绿、
      //    stderr 刷 Aborted。EJS 后端为此栽过一次，照抄它的收尾。
      this.drainJobs(runtime, deadline);
      try {
        runtime.removeInterruptHandler?.();
      } catch {
        /* 同上 */
      }
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
  }

  dispose(): void {
    // runtime 是每次 run 自建自释的，这里没有长命资源
    this.module = null;
    this.modulePromise = null;
  }

  /** 装配 guest 侧沙盒面：前导 → 宿主全局遮蔽 → 数据轴 → 桥接 → 门面 */
  private installSandbox(context: QuickJsContextLike, sandbox: Record<string, unknown>): void {
    const { data, fnPaths } = describeSandbox(sandbox);

    this.evalSetup(context, GUEST_PRELUDE, '前导');

    // 桥接函数（前导里的 `__sbx` 要用它，所以在前导之后、门面之前装）
    const handle = context.newFunction('__sbxHostCall', (pathHandle: any, argsHandle: any) => {
      const path = String(context.dump(pathHandle) ?? '');
      const argsJson = String(context.dump(argsHandle) ?? '[]');
      let envelope: string;
      try {
        const args = JSON.parse(argsJson) as unknown[];
        const value = invokeSandbox(sandbox, path, Array.isArray(args) ? args : []);
        envelope = JSON.stringify({ v: value }) ?? '{}';
      } catch (err) {
        envelope = JSON.stringify({ e: 1, m: describeError(err) });
      }
      return context.newString(envelope);
    });
    context.setProp(context.global, '__sbxHostCall', handle);
    handle.dispose?.();

    // 宿主全局遮蔽（保真旧实现的形参遮蔽，见 SHADOWED_HOST_GLOBALS 的说明）
    this.evalSetup(
      context,
      SHADOWED_HOST_GLOBALS.map((n) => `globalThis[${toJsStringLiteral(n)}] = undefined;`).join(
        '\n',
      ),
      '宿主全局遮蔽',
    );

    // 数据轴：整份 JSON 过境后再摊到各个全局
    // 🔴 走 `JSON.parse(<字符串字面量>)` 而不是把 JSON 直接嵌成源码字面量 ——
    //    JSON 字符串里合法的 U+2028/U+2029 在旧 JS 源码里是非法行终止符。
    const dataJson = safeStringify(data);
    if (dataJson === undefined) {
      throw new Error('脚本上下文不可序列化（含环或宿主对象）');
    }
    const assigns = Object.keys(data)
      .map((k) => `globalThis[${toJsStringLiteral(k)}] = __sbData[${toJsStringLiteral(k)}];`)
      .join('\n');
    this.evalSetup(
      context,
      `globalThis.__sbData = JSON.parse(${toJsStringLiteral(dataJson)});\n${assigns}`,
      '数据轴',
    );

    // `console` 门面 —— QuickJS 不自带。旧实现下脚本能调宿主 console（没被遮蔽），
    // 有 AI 写的脚本确实在用它调试；不给就变成 ReferenceError 打断整个脚本。
    this.evalSetup(
      context,
      `globalThis.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };`,
      'console 门面',
    );

    if (fnPaths.length > 0) this.evalSetup(context, buildFacadeSource(fnPaths), '门面');
  }

  /** 装配期求值：失败即抛（装不起来就没法跑脚本），成功时**必须释放完成值句柄** */
  private evalSetup(context: QuickJsContextLike, code: string, what: string): void {
    const r = context.evalCode(code);
    if (r.error) {
      const detail = context.dump(r.error) as { message?: string };
      r.error.dispose?.();
      throw new Error(`脚本 guest ${what}装配失败: ${detail?.message ?? '未知'}`);
    }
    r.value?.dispose?.();
  }

  private drainJobs(runtime: QuickJsRuntimeLike, deadline: number): void {
    if (!runtime.executePendingJobs) return;
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      // 抽干本身也要受 deadline 约束，但**至少转一轮** —— 超时的脚本同样会留下 job，
      // 一轮都不转就直接 dispose 正是上面那条 Abort 的触发条件。
      let pumped: number;
      try {
        pumped = readPumpedCount(runtime.executePendingJobs()) ?? 0;
      } catch {
        return; // job 自己抛了 —— 与脚本结果无关，咽掉
      }
      if (pumped <= 0) return;
      if (Date.now() > deadline + DRAIN_GRACE_MS) return;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function safeStringify(value: unknown): string | undefined {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** 按 `'$ns.method'` / `'fn'` 在沙盒里找到宿主闭包并调用 */
function invokeSandbox(sandbox: Record<string, unknown>, path: string, args: unknown[]): unknown {
  const dot = path.indexOf('.');
  if (dot < 0) {
    const fn = sandbox[path];
    if (typeof fn !== 'function') throw new TypeError(`${path} is not a function`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  }
  const ns = sandbox[path.slice(0, dot)];
  if (ns === null || typeof ns !== 'object') throw new TypeError(`${path} is not a function`);
  const fn = (ns as Record<string, unknown>)[path.slice(dot + 1)];
  if (typeof fn !== 'function') throw new TypeError(`${path} is not a function`);
  // `this` 绑回命名空间对象 —— 旧实现里 `$status.add(...)` 的 `this` 就是 `$status`
  return (fn as (...a: unknown[]) => unknown).apply(ns, args);
}

export function createScriptQuickJsBackend(
  options: ScriptQuickJsBackendOptions = {},
): ScriptQuickJsBackend {
  return new ScriptQuickJsBackend(options);
}
