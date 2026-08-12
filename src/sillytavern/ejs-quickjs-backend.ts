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
import { tokenizeTrimmed, type EjsEvalContext } from './ejs-runtime';
import { registerEjsCacheClear } from './ejs-backend';
import {
  buildEjsCapabilities,
  EJS_FMT_NAMES,
  EJS_RNG_NAMES,
  LOCAL_ROOT,
  marshalWorld,
  type EjsCapabilities,
} from './ejs-capabilities';
import { createEjsRng, type EjsRng } from './ejs-rng';
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
  /**
   * pass 天花板 5s（2026-08-01 上调，原值 1500ms 是拍的）。
   *
   * 实测依据：内置全语料 109 条目单 pass **348-583ms**（预热后；同口径 Legacy 6-73ms）。
   * 1500ms 只有 3 倍余量 —— 世界书动态条目再多两三倍的用户会**整片撞上天花板 → 大面积回退**，
   * 而回退是静默的。5s 给到约 10 倍余量。
   *
   * 上调的代价是**最坏情况的主线程冻结变长**。可接受的理由：这是 DoS 防线不是性能项，
   * 单条目 50ms 的闸门才是常态下的约束；能吃满 5s 的只有「上百个各自逼近 50ms 的条目」，
   * 那种书本身就该被作者优化，而不是被引擎腰斩成一堆原文注入。
   */
  passTimeoutMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
};

/** 单条目允许的微任务泵轮数上限（自我调度的 job 链不能变成绕过 interrupt 的 DoS 通道） */
const MAX_DRAIN_ROUNDS = 64;

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
  /**
   * 跑 guest 的微任务队列。
   *
   * 可选：假模块（测试注入）不实现它时，`await` 条目会走「未落定」分支回退原文，
   * 而不是崩掉——降级路径与真实模块缺席时一致。
   */
  executePendingJobs?(maxJobs?: number): PendingJobsResultLike | undefined;
  dispose(): void;
}

/**
 * `executePendingJobs` 的真实返回形状。
 *
 * 上游给的是 `DisposableResult<number, QuickJSHandle & { context }>`，
 * 也就是 `{ value: number } | { error: 句柄 }` 外加一个 `dispose()`，**不是 `number`**。
 *
 * 🔴 这里曾经按 `number` 声明，于是所有 `=== 0` / `<= 0` 判断**恒不成立**（实测 `typeof` 是
 * `'object'`），三个后果全部是静默的：
 * 1. pump 循环的「队列已空就早退」永远不触发 —— 一个悬挂 promise 的条目要烧满整条目预算；
 * 2. `drainJobs` 每条目都空转满 `MAX_DRAIN_ROUNDS` 轮；
 * 3. 失败分支里那个**活着的** QuickJSHandle 从没人释放 —— 正是 `runEntry` 里那段注释说会让
 *    `runtime.dispose()` 断言失败、Abort 整个 wasm 实例的同一类泄漏。
 *
 * 联合里保留 `number` 是给注入的假模块留的余地：朴素返回也吃得下，不逼测试去仿 DisposableResult。
 */
type PendingJobsResultLike =
  | number
  | {
      /** 成功分支：本轮执行的 job 数 */
      value?: number;
      /** 失败分支：**活着的**错误句柄，靠 `dispose()` 释放 */
      error?: unknown;
      dispose?(): void;
    };

/**
 * 归一化 `executePendingJobs` 的返回 → 本轮执行的 job 数（`undefined` = 拿不出数，按「不能再推进」处理）。
 *
 * 两个分支都调 `dispose()`：成功分支的值是数字，上游的 `DisposableSuccess.dispose()` 是空操作；
 * 失败分支的 `DisposableFail.dispose()` 才是真正释放错误句柄的那一下。
 */
function readPumpedCount(result: PendingJobsResultLike | undefined | null): number | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'number') return result;
  const failed = result.error !== undefined && result.error !== null;
  try {
    result.dispose?.();
  } catch {
    /* 释放失败不该盖住条目结果 */
  }
  if (failed) return 0; // job 自己抛了：本轮没有可继续推进的东西
  const n = Number(result.value);
  return Number.isFinite(n) ? n : undefined;
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

/** guest 侧把 RegExp 编组成的标记形状（JSON 过不了 RegExp，见 `reviveGuestPattern`） */
const GUEST_REGEX_MARKER = '__ejsRegex';

/**
 * 还原 guest 编组过来的正则。
 *
 * 🔴 曾经 guest 门面直接送 `p.source` **字符串**过来，宿主 `chat.match` 于是走字符串分支做
 * `includes()`：`chat.match(/咖啡(馆|厅)/)` 在 Legacy 下 `true`、在 QuickJS 下 `false`，
 * 而**两边都 `ok: true`** —— 静默分叉，条目照渲染，只是判断反了。
 *
 * ⚠️ 残留风险登记：还原出来的正则跑在**宿主**上，宿主没有 interrupt，灾难性回溯会冻住主线程。
 * 这与 Legacy 后端的暴露面**完全一致**（Legacy 本来就把创作者的正则直接交给宿主 V8），
 * 不是本次改动新开的面；写在条目里的正则**字面量**仍然跑在 guest 内、受 interrupt 约束。
 */
function reviveGuestPattern(pattern: unknown): unknown {
  if (pattern === null || typeof pattern !== 'object') return pattern;
  const marker = pattern as Record<string, unknown>;
  const source = marker[GUEST_REGEX_MARKER];
  if (typeof source !== 'string') return pattern;
  try {
    return new RegExp(source, typeof marker['flags'] === 'string' ? marker['flags'] : '');
  } catch {
    return source; // 源串本身非法 → 退回字符串语义，绝不抛
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

  /**
   * 预热：**真的把 wasm 装起来并跑一次探针求值**。
   *
   * 🔴 `installProductionEjsBackend()` 必须 await 它。曾经装配只 `import` 了这个 JS 模块就
   * `return true`，而 wasm 是首次 `runPass` 才惰性取的 —— wasm 取不到（CDN 挂了 / CSP 拦了 /
   * 浏览器不支持）时装配照样报成功、`main.ts` 一个失败提示都不弹，此后每个 pass 静默退化成
   * 原文注入，而下游（工坊入口解封判断等）是**按「隔离是真的」**在做决策的。
   *
   * 失败即抛，由调用方转成 fail-closed。
   */
  async warmup(): Promise<void> {
    const QuickJS = await this.module();
    const runtime = QuickJS.newRuntime();
    try {
      runtime.setMemoryLimit(this.budget.memoryLimitBytes);
      runtime.setMaxStackSize(this.budget.maxStackBytes);
      const context = runtime.newContext();
      try {
        // 探针：wasm 真的能编译并执行字节码，才算「隔离到位」
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
  }

  async runPass(entries: EjsPassEntry[], ctx: EjsEvalContext): Promise<EjsEntryOutcome[]> {
    if (entries.length === 0) return [];

    /** 整 pass 回退原文（D8）—— `runPass` 契约是**永不抛** */
    const allFallback = (reason: string): EjsEntryOutcome[] =>
      entries.map((e) => ({ uid: e.uid, text: e.content, ok: false, error: reason }));

    let QuickJS: QuickJsModuleLike;
    try {
      QuickJS = await this.module();
    } catch (err) {
      // 装载失败 → 整 pass 回退原文（D8），不抛穿
      return allFallback(`QuickJS 装载失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 🔴 建 runtime/context 必须在 try 内。曾经这三行裸在外面：`newRuntime()` 撞内存上限、
    // `newContext()` 半路失败都会**直接抛穿 runPass**，把「永不抛」的契约打破 ——
    // 调用方（worldbook-loader 的 D8）只准备了「拿到一批 ok:false」，没准备接异常。
    let runtime: QuickJsRuntimeLike;
    let context: QuickJsContextLike;
    try {
      runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(this.budget.memoryLimitBytes);
      runtime.setMaxStackSize(this.budget.maxStackBytes);
    } catch (err) {
      return allFallback(
        `QuickJS 运行时创建失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      context = runtime.newContext();
    } catch (err) {
      // runtime 已经建起来了 —— 不放掉就是泄漏一个 wasm 实例
      try {
        runtime.dispose();
      } catch {
        /* 释放失败不该盖住降级 */
      }
      return allFallback(
        `QuickJS 上下文创建失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const out: EjsEntryOutcome[] = [];
    const passStart = Date.now();
    // 逐条目换序列（`runEntry` 负责换）；holder 而非实例字段——并发 runPass 各持一份，不串味
    const rngRef = { current: createEjsRng(`${ctx.seed ?? 'no-seed'}|`) };
    // 🔴 能力面也逐条目换（同样由 `runEntry` 负责）。`buildEjsCapabilities` 的契约写得很清楚是
    // **每条目一份**：`lore.get` 的 8 次预算、`ui.notify` 的 3 条限频与去重集都是条目级的。
    // 曾经整 pass 只建一份 → 预算变成 pass 级：实测 10 条目各调一次 `lore.get`，
    // 第 9、10 条拿到的是 `''` 而 `ok` 仍为 `true`（静默失效，Legacy 下则全部正常）。
    const capsRef = {
      current: buildEjsCapabilities(ctx.vars, ctx.historyText ?? '', ctx.capabilities),
    };

    try {
      // 🔴 COR-08（2026-08-09 审查）：只读轴 `stats` 必须**每条目重建**。
      // installCapabilities 每趟只编组一次，而 runEntry 的 restore() 只回滚 vars 与 _local
      // —— 于是条目 A 的 `stats.主角.背包.push('污染')` 会漏给同一趟里后面每一条，
      // 连 A 自己抛错被回滚、原文注入的情况都不例外（对只读轴的写活了下来，进了提示词）。
      // Legacy 后端相反（`deepClone(ctx.stats)` 每条目一份），两个后端因此给出不同答案
      // 且**双方都报 ok:true**。后果不是被攻击，是 AI 收到一份伪造的上下文且无从复现
      // —— 换个后端就好了、改一下条目顺序也可能就好了。
      // 母本 `__ejsStatsJson` 在 installCapabilities 里种下并钉成不可写不可配置，
      // 重建动作在 runEntry（不变式 5）。
      this.installCapabilities(context, ctx, rngRef, capsRef);

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
        out.push(this.runEntry(runtime, context, entry, ctx, rngRef, capsRef));
      }

      // 草稿整体回传（pass 内一直留在 guest，到这里才过境一次）
      this.readBackVars(runtime, context, ctx);
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
   *
   * 桥接函数一律读 `capsRef.current` 而不是闭包捕获某一份实例 —— `runEntry` 每条目换一次
   * （条目级预算，见 `runPass` 里 `capsRef` 的说明）。
   */
  private installCapabilities(
    context: QuickJsContextLike,
    ctx: EjsEvalContext,
    rngRef: { current: EjsRng },
    capsRef: { current: EjsCapabilities },
  ): void {
    // 数据轴只在这里过境一次，用 pass 开头这份即可：world / engine / charLoreBook 与条目无关
    const caps = capsRef.current;

    // 前导 + 数据轴
    this.evalSetup(context, GUEST_PRELUDE, '前导');
    // 🔴 `world.isDaytime` 是**函数**，JSON 编组会把它整个丢掉 —— guest 里调它抛
    // `TypeError: not a function`，整条目回退原文，而 Legacy 下它工作得好好的。
    // Q-09：这条分界现在由 `marshalWorld` 表达（有签名、编译器看得见），
    // 不再是散在这里的两段注释 + 一段 as 断言。结果只取决于时（pass 内不变），
    // 所以预先算好布尔值、在 guest 侧补个同值 shim。
    const worldMarshalled = marshalWorld(caps.world);
    const data = {
      stats: ctx.stats ?? {},
      vars: ctx.vars ?? {},
      world: worldMarshalled.data,
      // 地图 v1 §5：`$map` 走**数据轴**而不是桥接函数 —— 它整面只有数据、没有一个函数
      // （`EjsMap` 的文件头说明了为什么），所以 JSON 一次过境就够，且不会出现
      // `world.isDaytime` 那种「Legacy 有、guest 没有」的分叉
      $map: caps.$map,
      charLoreBook: caps.charLoreBook,
      engine: { name: caps.engine.name, version: caps.engine.version },
    };
    const json = toGuestJson(data);
    if (json === undefined) throw new Error('EJS 数据轴不可序列化（含环或宿主对象）');
    const isDaytime = worldMarshalled.isDaytime;
    this.evalSetup(
      context,
      `globalThis.__ejsData = ${json};
// COR-08：只读轴的**不可变**母本。每条目从它 JSON.parse 出一份新的 stats（见 runEntry）。
// 钉成 writable:false + configurable:false —— 否则条目改掉这个串就能把 COR-08 换个地方复活。
Object.defineProperty(globalThis, '__ejsStatsJson', {
  value: JSON.stringify(__ejsData.stats),
  writable: false, configurable: false, enumerable: false,
});
globalThis.stats = JSON.parse(globalThis.__ejsStatsJson);
globalThis.vars = __ejsData.vars;
globalThis.world = __ejsData.world;
globalThis.world.isDaytime = function () { return ${isDaytime ? 'true' : 'false'}; };
globalThis.$map = __ejsData.$map;
globalThis.charLoreBook = __ejsData.charLoreBook;
globalThis.engine = __ejsData.engine;`,
      '数据轴',
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

    bridge('__b_chat_at', (i, role) =>
      capsRef.current.chat.at(Number(i), role as string | undefined),
    );
    bridge('__b_chat_slice', (a, b, role) =>
      capsRef.current.chat.slice(Number(a), Number(b), role as string | undefined),
    );
    // 正则经 `{__ejsRegex, flags}` 标记过境，这里还原成宿主 RegExp（见 reviveGuestPattern）
    bridge('__b_chat_match', (p) => capsRef.current.chat.match(reviveGuestPattern(p)));
    bridge('__b_chat_text', () => capsRef.current.chat.text());
    bridge('__b_char', (op, name) => {
      const char = capsRef.current.char;
      switch (op) {
        case 'player':
          return char.player();
        case 'get':
          return char.get(String(name ?? ''));
        case 'present':
          return char.present();
        case 'all':
          return char.all();
        case 'has':
          return char.has(String(name ?? ''));
        case 'affection':
          return char.affection(String(name ?? ''));
        case 'affectionLabel':
          return char.affectionLabel(String(name ?? ''));
        default:
          return null;
      }
    });
    bridge('__b_quest', (op, name) => {
      const quest = capsRef.current.quest;
      switch (op) {
        case 'all':
          return quest.all();
        case 'active':
          return quest.active();
        case 'get':
          return quest.get(String(name ?? ''));
        case 'has':
          return quest.has(String(name ?? ''));
        case 'focus':
          return quest.focus();
        default:
          return null;
      }
    });
    bridge('__b_lore', (op, a, b) => {
      const lore = capsRef.current.lore;
      if (op === 'get') return lore.get(String(a ?? ''), b === undefined ? undefined : String(b));
      if (op === 'has') return lore.has(String(a ?? ''), b === undefined ? undefined : String(b));
      if (op === 'list') return lore.list(String(a ?? ''));
      return null;
    });
    bridge('__b_local', (op, key, value) => {
      const local = capsRef.current.local;
      switch (op) {
        case 'get':
          return local.get(String(key ?? ''), value);
        case 'set':
          local.set(String(key ?? ''), value);
          return null;
        case 'has':
          return local.has(String(key ?? ''));
        case 'remove':
          local.remove(String(key ?? ''));
          return null;
        case 'keys':
          return local.keys();
        default:
          return null;
      }
    });
    bridge('__b_ui', (op, msg, level) => {
      if (op === 'notify') capsRef.current.ui.notify(String(msg ?? ''), level as any);
      else capsRef.current.ui.log(msg);
      return null;
    });
    bridge('__b_engine_has', (path) => capsRef.current.engine.has(String(path ?? '')));
    bridge('__b_fmt', (op, ...args) => (ejsFmt as any)[String(op)]?.(...args) ?? '');
    // 读 `rngRef.current` 而不是闭包捕获某一条序列 —— runEntry 每条目换一次
    bridge('__b_rng', (op, ...args) => (rngRef.current as any)[String(op)]?.(...args) ?? null);
    // `rewriteCodeMacros` 产出的两个降级落点（语义对齐 ejs-runtime 的同名实现）
    bridge('__b_roll', (formula) => rngRef.current.roll(String(formula ?? '')));
    bridge('__b_random', (options) => {
      const parts = String(options ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return parts.length === 0 ? '' : (rngRef.current.pick(parts) ?? '');
    });
    bridge('__b_lodash', (op, ...args) => {
      const fn = (ejsLodash as any)[String(op)];
      // 吃回调的方法在 guest 侧自己实现（跨边界传函数不可行，§3.14 实现约束）
      return typeof fn === 'function' ? fn(...args) : null;
    });

    // guest 侧门面：把桥接函数包成 §3 的 namespace 形状
    this.evalSetup(context, GUEST_FACADE, '门面');
  }

  /**
   * 跑单条目：编译 + 执行 + 取输出，全程受 interrupt 约束。
   *
   * 三条与 Legacy 对齐的不变式（每一条都曾经不成立，见 §0.1 的后端一致性表）：
   *
   * 1. **逐条目播种**（§7）。`rngRef` 在这里换成 `seed ‖ 条目正文` 的新序列，
   *    与 Legacy 的 `buildSandboxArgs(ctx, compiled.source)` 同口径。
   *    曾经整个 pass 共用一条序列 → 同一条目「前面跑过几条」就换个结果，重放不可复现。
   * 2. **失败整体回滚**（D8）。进 guest 前存 `vars` 快照、宿主侧存 `_local` 快照；
   *    失败即恢复。曾经失败条目的半途写留在草稿里，被 pass 末尾的 `readBackVars` 一起落库。
   * 3. **异步条目照跑**。body 统一包进 async IIFE 并 pump 微任务队列；
   *    曾经直接塞进同步 IIFE，`await` 一律 `SyntaxError`（真机语料 3 条）。
   * 4. **interrupt 全程装着**（含快照与回滚）。见下方 deadline 那段的说明。
   * 5. **`stats` 逐条目重建**（COR-08）。只读轴是活的客体对象，没 freeze 也没 proxy；
   *    整趟只编组一次时，一条目的手滑赋值会静默污染其后所有条目 —— 而 Legacy 每条目
   *    深拷贝一份。两个后端因此对同一份语料给出不同答案且都报 `ok: true`。
   */
  private runEntry(
    runtime: QuickJsRuntimeLike,
    context: QuickJsContextLike,
    entry: EjsPassEntry,
    ctx: EjsEvalContext,
    rngRef: { current: EjsRng },
    capsRef: { current: EjsCapabilities },
  ): EjsEntryOutcome {
    const source = entry.content ?? '';
    // 不变式 1：与 Legacy 同口径的逐条目种子
    rngRef.current = createEjsRng(`${ctx.seed ?? 'no-seed'}|${source}`);
    // 能力面同样逐条目换：`lore.get` / `ui.notify` 的预算与去重集是条目级的（见 runPass 的 capsRef）
    capsRef.current = buildEjsCapabilities(ctx.vars, ctx.historyText ?? '', ctx.capabilities);

    // 🔴 deadline + interrupt 必须装在**快照之前**，而不是等到跑条目正文才装。
    // 快照那句是 `JSON.stringify(globalThis.vars)` —— 它会调用 guest 自己种下的 `vars.toJSON`。
    // 前一条目只要写一行 `vars.toJSON = function () { while (true) {} }`，
    // 后续每条目的快照（以及 pass 末尾的 `readBackVars`）就永久冻住主线程，
    // interrupt 一次开口的机会都没有 —— 「可中断」这个卖点在那两个窗口里整个是假的。
    const deadline = Date.now() + this.budget.entryTimeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);

    // 不变式 2：guest 侧 vars + 宿主侧 _local 双快照（`local.*` 走桥接直写宿主，不在 guest 树里）
    const localSnapshot = toGuestJson(ctx.vars?.[LOCAL_ROOT] ?? null);
    let snapOk = false;

    const restore = (): void => {
      if (snapOk) this.evalVoid(context, `globalThis.vars = JSON.parse(globalThis.__ejsSnap);`);
      if (ctx.vars && localSnapshot !== undefined) {
        try {
          const parsed = JSON.parse(localSnapshot) as unknown;
          if (parsed === null) delete ctx.vars[LOCAL_ROOT];
          else ctx.vars[LOCAL_ROOT] = parsed as Record<string, unknown>;
        } catch {
          /* 快照本身坏了就不动——回滚失败也不能让条目结果丢 */
        }
      }
    };

    try {
      // 不变式 5（COR-08）：只读轴 `stats` 每条目重建，条目之间零泄漏。
      //
      // 从 guest 侧那个不可变母本 `JSON.parse` 一份，**不是**每条目求值一遍 stats 的
      // 源码字面量 —— 后者每次要走词法+语法+字节码生成，实测慢约一个量级
      // （109 条目 / 57KB stats：626ms vs 191ms），而 pass 天花板只有 5000ms，
      // 撞上去的后果是剩余条目**静默回退原文**。
      //
      // 用 defineProperty 而不是直接赋值，是为了让失败**响**：条目若把 `stats` 设成
      // 不可配置，赋值会静默失败（非严格模式）而 defineProperty 会抛 —— 于是下面这个
      // 返回值检查能把它变成一条诚实的失败，而不是让本条目读到上一条那份被污染的 stats。
      // 放在 try 内：早退也要走 finally 摘 interrupt。
      const statsOk = this.evalVoid(
        context,
        `Object.defineProperty(globalThis, 'stats', {
  value: JSON.parse(globalThis.__ejsStatsJson),
  writable: true, configurable: true, enumerable: true,
});`,
      );
      if (!statsOk) {
        return {
          uid: entry.uid,
          text: entry.content,
          ok: false,
          error: 'stats 只读轴重建失败（本条目不执行，避免读到上一条目的残留）',
        };
      }
      snapOk = this.evalVoid(context, `globalThis.__ejsSnap = JSON.stringify(globalThis.vars);`);
      // 不变式 3：async IIFE + 微任务泵。**无条件**走异步壳（不去嗅探 `await`）——
      // 嗅探要么误判（正文里的 "await" 字样），要么就得再写一个 token 扫描器；
      // 同步条目走这条路的额外成本只有一次「队列已空」的 pump。
      // 🔴 `'use strict'` 必须有：Legacy 的函数体是严格的，guest 不严格就会在
      // **未声明赋值**上分叉 —— `x = 1`（漏 var）在 Legacy 下 ReferenceError 回退原文，
      // 在宽松 guest 下静默建全局并渲染成功。真机语料里就有这么一条（wb5i#222488）。
      const wrapped = `globalThis.__ejsState = 0; globalThis.__ejsOut = ''; globalThis.__ejsErr = '';
(async function () { 'use strict'; __ejs.reset(); ${compileToGuestBody(source)}
  globalThis.__ejsOut = __ejs.take(); globalThis.__ejsState = 1;
})().catch(function (e) {
  globalThis.__ejsErr = String((e && (e.name + ': ' + e.message)) || e); globalThis.__ejsState = 2;
});`;
      const result = context.evalCode(wrapped, `entry-${entry.uid}.js`);
      if (result.error) {
        const detail = context.dump(result.error) as { name?: string; message?: string };
        result.error.dispose?.();
        restore();
        return {
          uid: entry.uid,
          text: entry.content,
          ok: false,
          error: `${detail?.name ?? 'Error'}: ${detail?.message ?? '未知'}`,
        };
      }
      result.value?.dispose?.();

      // 泵到 promise 落定为止。桥接全同步，正常一轮就完；
      // 循环仍以 deadline 收口——guest 里 `new Promise(() => {})` 永不落定。
      let state = this.readNumber(context, 'globalThis.__ejsState');
      while (state === 0 && Date.now() <= deadline) {
        // 归一化必不可少：上游返回的是 DisposableResult 不是 number（见 readPumpedCount）
        const pumped = readPumpedCount(runtime.executePendingJobs?.());
        state = this.readNumber(context, 'globalThis.__ejsState');
        // 队列空了还没落定 = 悬挂 promise，再泵也没用
        if (state === 0 && (pumped === undefined || pumped === 0)) break;
      }
      // 🔴 落定之后**仍要把队列抽干**。同步条目里 async IIFE 在 evalCode 返回前就已 resolve，
      // 于是 `.catch()` 挂的那个 reaction job 从没被执行过——它会一直挂在队列上，
      // `runtime.dispose()` 时 QuickJS 断言 `list_empty(&rt->gc_obj_list)` 失败并 **Abort 整个 wasm 实例**，
      // 此后该 backend 的所有 runPass 全部报废。上面那个循环因为 `state !== 0` 一次都不会转，抽干必须单列。
      this.drainJobs(runtime, deadline);

      if (state === 1) {
        return { uid: entry.uid, text: this.readString(context, 'globalThis.__ejsOut'), ok: true };
      }
      const error =
        state === 2
          ? this.readString(context, 'globalThis.__ejsErr') || 'Error: 未知'
          : `AsyncEntryError: 条目在 ${this.budget.entryTimeoutMs}ms 内未落定（悬挂 Promise？）`;
      restore();
      return { uid: entry.uid, text: entry.content, ok: false, error };
    } catch (err) {
      restore();
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

  /**
   * 抽干 guest 微任务队列。
   *
   * 有上限（`MAX_DRAIN_ROUNDS` + deadline）：guest 可以写出自我调度的无穷 job 链
   * （`function f(){ Promise.resolve().then(f) } f()`），不设上限就等于放开一条绕过
   * interrupt 的 DoS 通道。抽不干时**不报错**——条目结果已经定了，剩下的交给 dispose。
   */
  private drainJobs(runtime: QuickJsRuntimeLike, deadline: number): void {
    if (!runtime.executePendingJobs) return;
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      if (Date.now() > deadline) return;
      let pumped: number;
      try {
        pumped = readPumpedCount(runtime.executePendingJobs()) ?? 0;
      } catch {
        return; // 队列里的 job 自己抛了 —— 与条目结果无关，咽掉
      }
      if (pumped <= 0) return;
    }
  }

  /**
   * 跑装配期代码（前导 / 数据轴 / 门面）：失败即抛（装不起来就没法跑条目），
   * 但**成功时必须释放完成值句柄**。
   *
   * 🔴 曾经写的是 `context.unwrapResult(context.evalCode(x))` —— 完成值句柄没人释放，
   * 每个 pass 漏三个。`runtime.dispose()` 时 QuickJS 断言 `list_empty(&rt->gc_obj_list)` 失败、
   * `abort()` 整个 wasm 实例；而 dispose 外面那圈 try/catch 把异常**咽掉了**，
   * 于是测试全绿、stderr 里刷 38 行 Aborted 没人看见。
   */
  private evalSetup(context: QuickJsContextLike, code: string, what: string): void {
    const r = context.evalCode(code);
    if (r.error) {
      const detail = context.dump(r.error) as { message?: string };
      r.error.dispose?.();
      throw new Error(`EJS guest ${what}装配失败: ${detail?.message ?? '未知'}`);
    }
    r.value?.dispose?.();
  }

  /** 跑一段没有返回值的 guest 代码；成功与否用布尔回答，绝不外抛 */
  private evalVoid(context: QuickJsContextLike, code: string): boolean {
    try {
      const r = context.evalCode(code);
      if (r.error) {
        r.error.dispose?.();
        return false;
      }
      r.value?.dispose?.();
      return true;
    } catch {
      return false;
    }
  }

  private readString(context: QuickJsContextLike, expr: string): string {
    try {
      const r = context.evalCode(`String(${expr})`);
      if (r.error) {
        r.error.dispose?.();
        return '';
      }
      const s = String(context.dump(r.value) ?? '');
      r.value?.dispose?.();
      return s;
    } catch {
      return '';
    }
  }

  /**
   * 给一段**会执行 guest 代码**的求值套上「新鲜 deadline + 已装的 interrupt」。
   *
   * 条目正文之外还有两处会跑 guest 代码，且都很容易被忽略：`JSON.stringify(vars)`（快照 / 回传）
   * 会调 guest 种的 `vars.toJSON`。凡是这类求值都必须走本方法或 `runEntry` 里那条 deadline，
   * 否则「可中断」在那个窗口里就是空头承诺。求值本身抛了不外传 —— 返回 `undefined` 交调用方兜。
   */
  private armed<T>(runtime: QuickJsRuntimeLike, fn: () => T | undefined): T | undefined {
    const deadline = Date.now() + this.budget.entryTimeoutMs;
    try {
      runtime.setInterruptHandler(() => Date.now() > deadline);
    } catch {
      return undefined; // 装不上 interrupt 就不跑 —— 宁可不回传，也不开一个冻主线程的窗口
    }
    try {
      return fn();
    } catch {
      return undefined;
    } finally {
      try {
        runtime.removeInterruptHandler?.();
      } catch {
        /* 摘不掉不该盖住结果 */
      }
    }
  }

  private readNumber(context: QuickJsContextLike, expr: string): number {
    const n = Number(this.readString(context, expr));
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * pass 结束把 guest 侧的 `vars` 草稿整体搬回宿主对象（**就地**，调用方持有同一引用）。
   *
   * 🔴 这里**会执行 guest 代码**（`JSON.stringify` 调 `vars.toJSON`），所以必须自带
   * 一条新鲜 deadline + 已装的 interrupt —— `runEntry` 的那个已经在它的 `finally` 里摘掉了。
   * 少了这一层，条目里种一个死循环 `toJSON` 就能在 pass 收尾处永久冻住主线程。
   * 中断即视作回传失败：草稿保持 pass 开始的样子，不半写。
   */
  private readBackVars(
    runtime: QuickJsRuntimeLike,
    context: QuickJsContextLike,
    ctx: EjsEvalContext,
  ): void {
    const raw = this.armed(runtime, () => {
      const r = context.evalCode('JSON.stringify(globalThis.vars)');
      if (r.error) {
        r.error.dispose?.();
        return undefined;
      }
      const s = String(context.dump(r.value) ?? '');
      r.value?.dispose?.();
      return s;
    });
    if (raw === undefined) return;
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
  // 正则过不了 JSON：编成 { ${GUEST_REGEX_MARKER}, flags } 标记，宿主侧 reviveGuestPattern 还原。
  // 曾经这里送的是 p.source 裸字符串，宿主于是走字符串分支做 includes() ——
  // chat.match(/咖啡(馆|厅)/) 在 Legacy 下 true、在这里 false，两边还都报 ok。
  var RX = function (p) {
    return p instanceof RegExp ? { ${GUEST_REGEX_MARKER}: p.source, flags: p.flags } : p;
  };
  globalThis.chat = {
    at: function (i, role) { return P(__b_chat_at(i, role)) || ''; },
    last: function (role) { return P(__b_chat_at(-1, role)) || ''; },
    slice: function (a, b, role) { return P(__b_chat_slice(a, b, role)) || []; },
    match: function (p) { return !!P(__b_chat_match(RX(p))); },
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

  // Q-09：名单由宿主注入（EJS_SURFACE 唯一真源），不再在字符串里手写第四份。
  var fmtNames = ${JSON.stringify(EJS_FMT_NAMES)};
  globalThis.fmt = {};
  fmtNames.forEach(function (n) { globalThis.fmt[n] = function () { return P(__b_fmt.apply(null, [n].concat(Array.prototype.slice.call(arguments)))); }; });

  var rngNames = ${JSON.stringify(EJS_RNG_NAMES)};
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

  // _.chain(v).xxx().value() —— 与 Legacy 的 ejs-lodash-shim.CHAIN_METHODS **同一张表**（16 个读边方法）。
  // 曾经整个漏了：guest 里只有那 24 个散方法，链式写法一律 TypeError: not a function → 整条目回退，
  // 而 Legacy 下它工作得好好的（内置 dlc#477「月历球」+ 混淆语料 wb5i#61 / #111446 三条真机条目中招）。
  // 语义同 Legacy：每一步**即时求值**再重新包裹，.value() 取出当前值；链上方法之外的一律没有。
  var CHAIN_METHODS = ['get','trim','isArray','isObject','isObjectLike','isEmpty','mapValues',
    'find','flatMap','pick','pickBy','values','keys','has','uniq','keyBy'];
  lo.chain = function (value) {
    var wrap = function (v) {
      var w = { value: function () { return v; } };
      CHAIN_METHODS.forEach(function (n) {
        w[n] = function () {
          return wrap(lo[n].apply(null, [v].concat(Array.prototype.slice.call(arguments))));
        };
      });
      return w;
    };
    return wrap(value);
  };
  globalThis._ = lo;

  // rewriteCodeMacros 的两个降级落点（模板作者不直接写，由编译期生成调用）
  // 注意：本段处在模板字面量内，注释里不能出现反引号。
  globalThis.__roll = function (f) { return P(__b_roll(f)); };
  globalThis.__random = function (o) { return P(__b_random(o)); };

  // ===== 上游别名层（能力面 §5）=====
  // 这一层曾经**整个漏了**：guest 里没有 getMessageVar/getvar/setvar/getwi/YAML/toastr...，
  // 于是每一条用别名写法的存量条目在 QuickJS 下都是 ReferenceError → 回退原文。
  // 内置全语料靠这层才把回退做到 0，漏掉它等于把那个成果整个吐回去。
  // 语义必须与 ejs-runtime.buildSandboxArgs 的同名实现逐条对齐（读取优先级、危险键、默认值）。
  // 镜像宿主 ejs-lodash-shim 的 DANGEROUS_PATH_SEGMENTS：用**段值相等**判定，
  // 绝不走对象属性查找。写成对象字面量 { __proto__: 1 } 时 __proto__ 根本不是自有属性，
  // hasOwnProperty 永远 false → isDanger 漏判 __proto__ → writePath 走进 guest realm 的
  // Object.prototype（跨条目污染 + 合法 __proto__.桶 写入被 diff 静默丢弃，见 DEFECT B）。
  // 注意：本段处在模板字面量内，注释里不能出现反引号。
  var DANGER_SEGMENTS = ['__proto__', 'prototype', 'constructor'];
  function isDanger(k) {
    for (var __di = 0; __di < DANGER_SEGMENTS.length; __di++) {
      if (DANGER_SEGMENTS[__di] === k) return true;
    }
    return false;
  }
  function splitPath(p) {
    if (typeof p !== 'string') return [];
    return p.trim().split('.').filter(function (x) { return x.length > 0; });
  }
  function stripStat(p) { return String(p == null ? '' : p).replace(/^stat_data(?:\\.|$)/, ''); }
  function hasStat(p) { return /^stat_data(?:\\.|$)/.test(String(p == null ? '' : p)); }
  function getByPath(root, parts) {
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function mergedView() {
    var out = {};
    Object.keys(globalThis.vars || {}).forEach(function (k) { out[k] = globalThis.vars[k]; });
    Object.keys(globalThis.stats || {}).forEach(function (k) {
      if (!isDanger(k)) out[k] = JSON.parse(JSON.stringify(globalThis.stats[k]));
    });
    return out;
  }
  // 读优先级与 Legacy 一致：先 stats（只读面赢），再 vars，最后 defaults
  function readPath(parts, defaults) {
    if (parts.length === 0) return mergedView();
    var s = getByPath(globalThis.stats, parts);
    if (s !== undefined) return JSON.parse(JSON.stringify(s));
    var v = getByPath(globalThis.vars, parts);
    if (v !== undefined) return v;
    return defaults;
  }
  function writePath(parts, value) {
    if (parts.length === 0) return;
    for (var i = 0; i < parts.length; i++) if (isDanger(parts[i])) return; // 整次写入静默拒绝
    var cur = globalThis.vars;
    for (var j = 0; j < parts.length - 1; j++) {
      var k = parts[j];
      if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }
  function varKey(k) { var raw = String(k == null ? '' : k); return hasStat(raw) ? stripStat(raw) : raw; }

  globalThis.getMessageVar = function (p, o) { return readPath(splitPath(stripStat(p)), o && o.defaults); };
  globalThis.setMessageVar = function (p, v) { writePath(splitPath(stripStat(p)), v); };
  globalThis.getvar = function (k, o) { return readPath(splitPath(varKey(k)), o && o.defaults); };
  globalThis.setvar = function (k, v) { writePath(splitPath(varKey(k)), v); };
  globalThis.getLocalVar = function (k, o) {
    var v = globalThis.local.get(String(k), undefined);
    return v === null || v === undefined ? (o && o.defaults) : v;
  };
  globalThis.setLocalVar = function (k, v) { globalThis.local.set(String(k), v); };
  Object.defineProperty(globalThis, 'variables', {
    get: function () { return { stat_data: mergedView() }; },
  });
  globalThis.matchChatMessages = function (p) { return !!P(__b_chat_match(RX(p))); };
  globalThis.getChatMessage = function (i, role) { return P(__b_chat_at(i, role)); };
  globalThis.getChatMessages = function (a, b, role) {
    var arr = P(__b_chat_slice(a, b, role)) || [];
    return arr.join('\\n');
  };
  globalThis.getwi = function (a, b) { return P(__b_lore('get', a, b)); };
  globalThis.YAML = { stringify: function (v, o) { return globalThis.fmt.yaml(v, o); } };
  globalThis.TavernHelper = {
    getLastMessageId: function () { return globalThis.world.回合; },
    getVariables: function () { return { stat_data: mergedView() }; },
  };
  globalThis.toastr = {
    info: function (m) { globalThis.ui.notify(String(m), 'info'); },
    success: function (m) { globalThis.ui.notify(String(m), 'success'); },
    warning: function (m) { globalThis.ui.notify(String(m), 'warning'); },
    error: function (m) { globalThis.ui.notify(String(m), 'error'); },
  };
  // 上游 alert 是阻塞对话框；刻意降级成非阻塞提示（§3.11 边界）
  globalThis.alert = function (m) { globalThis.ui.notify(String(m), 'warning'); };
  globalThis.message_id = globalThis.world.回合;
  globalThis.lastMessageId = globalThis.world.回合;
  // 上游 localStorage 的真实用途是「本项目自己的持久 UI 偏好」→ 映射到 local，
  // 永远碰不到真的 window.localStorage（那里躺着 API Key）
  globalThis.localStorage = {
    getItem: function (k) {
      var v = globalThis.local.get(String(k), null);
      if (v === null || v === undefined) return null;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    setItem: function (k, v) { globalThis.local.set(String(k), String(v)); },
    removeItem: function (k) { globalThis.local.remove(String(k)); },
  };
  globalThis.console = {
    log: function () { globalThis.ui.log(Array.prototype.slice.call(arguments).join(' ')); },
    warn: function () { globalThis.ui.log(Array.prototype.slice.call(arguments).join(' ')); },
    error: function () { globalThis.ui.log(Array.prototype.slice.call(arguments).join(' ')); },
    info: function () { globalThis.ui.log(Array.prototype.slice.call(arguments).join(' ')); },
  };
})();
`;

/**
 * EJS 正文 → guest 侧函数体。
 *
 * 分词/trim/宏改写**全部复用 `ejs-runtime.tokenizeTrimmed`**（唯一真源），只把产物按 guest
 * 的 `__ejs` 收集器装配。曾经这里自建一套分词器，只跳过 `<%_`/`_%>`/`-%>` 的标记字符却没吞
 * 空白——同一模板在两后端渲染出不同字节。共用分词器后 trim 语义逐字节对齐（见 DEFECT A）。
 */
/**
 * guest 函数体缓存（Q-10）。
 *
 * 生产真正在跑的是本后端，而它此前**零记忆化**：每个条目每回合都重新全量分词 +
 * 字符串拼接，随后 `context.evalCode` 让 QuickJS 再解析一遍同样的源码。
 * 实测 109 条目单 pass 348-583ms（同口径 Legacy 6-73ms）—— 那是 `passTimeoutMs`
 * 从 1500 被迫上调到 5000 的背景。而条目正文在回合之间几乎从不变。
 *
 * 讽刺的是仓库里同时维护着**两份**编译缓存，却都只服务已停用的 Legacy 路径。
 *
 * 键 = 条目正文，与 `ejs-backend.getCompiledEntry` 同键；session 级不淘汰
 * （全语料 ≈1500 块，无内存压力）。
 */
const guestBodyCache = new Map<string, string>();

/**
 * 清空 guest 函数体缓存（测试/性能计时用；生产路径无需调用）。
 *
 * 已注册进 `ejs-backend` 的统一清空口 —— `clearEjsBackendCache()` 会连它一起清，
 * 免得「清了缓存」这件事又长出两个入口（那正是 Q-10 要消掉的形状）。
 */
export function clearGuestBodyCache(): void {
  guestBodyCache.clear();
}
registerEjsCacheClear(clearGuestBodyCache);

function compileToGuestBody(source: string): string {
  const cached = guestBodyCache.get(source);
  if (cached !== undefined) return cached;
  const built = buildGuestBody(source);
  guestBodyCache.set(source, built);
  return built;
}

function buildGuestBody(source: string): string {
  // `print` 是**函数体局部**而非全局（对齐 Legacy 的 buildFnBody）：它得往本条目的收集器里推，
  // 挂全局会让并发/嵌套语义变模糊。漏了它 → 用 `print()` 的条目在 QuickJS 下 ReferenceError。
  const parts: string[] = ['var print = function (v) { __ejs.push(v); };'];
  for (const t of tokenizeTrimmed(source)) {
    switch (t.type) {
      case 'text':
        // tokenize 已把 `<%%` 归成字面文本 '<%'，空文本 token 不会产生
        if (t.content.length > 0) parts.push(`__ejs.push(${JSON.stringify(t.content)});`);
        break;
      case 'code':
        // 原样内联 —— 跨块 if/for 由此天然成立（content 已 rewriteCodeMacros）
        parts.push(t.content);
        break;
      case 'output':
      case 'unescaped':
        // `<%=` 与 `<%-` 同义：注入的是提示词纯文本，不做 HTML 转义
        parts.push(`__ejs.push(${t.content.length > 0 ? t.content : 'undefined'});`);
        break;
      case 'comment':
        break;
    }
  }
  return parts.join('\n');
}

/** 造一个 QuickJS 后端（生产用默认参数；测试可注入假模块与更小预算） */
export function createQuickJsBackend(options: QuickJsBackendOptions = {}): QuickJsBackend {
  return new QuickJsBackend(options);
}
