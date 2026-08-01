/**
 * ejs-backend.ts —— EJS 求值后端接口（能力面设计 §0.1 / 切片 T1）
 *
 * ## 为什么要有这层
 * 求值后端最终要换成 **QuickJS（wasm，主线程）**：realm 隔离 + 可中断 + 内存上限，
 * 把「构造器逃逸拿回真全局」（SEC-02）从根上堵死。但换引擎是 T7 的事，而在此之前
 * T2-T6 要建的能力面（`stats`/`chat`/`lore`/`fmt`/…）是**后端无关**的。
 *
 * 故先立缝：能力面按本接口写，两个后端各自实现，跑**同一套测试**。
 * 换后端时上层一行不改；后端出问题也能一行切回去。
 *
 * ## 三个实现
 * - `QuickJsBackend`：**生产唯一**。realm 隔离、可中断、有内存上限。
 * - `FailClosedBackend`（本文件）：隔离装不上时的生产形态 —— 条目原文注入，**不退回 Legacy**。
 * - `LegacyBackend`（本文件）：现行 `new Function`。快、无依赖，**不是安全边界**、不可中断。
 *   **只服务测试**（5000+ 用例不必背 wasm 启动成本）+ 真机走查期间当诊断参照物。
 *   走查结束、语料基线在 QuickJS 上重建之后即删除（能力面 §11.2 ③）。
 *
 * ## pass 粒度不是条目粒度
 * `runPass` 一次吃下整个装配 pass 的全部条目。理由是 QuickJS 后端的编组开销按**次**算而非按量算：
 * 每条目一个来回意味着 stats/vars 反复过境。整批送进去、在 guest 内按序跑完、整批回来，
 * 「前条目写→后条目立即可见」的语义天然保住（草稿始终在后端内），来回从 N 次降到 1 次。
 */

import {
  compileEjsEntry,
  executeEjsEntryAsync,
  type CompiledEjsEntry,
  type EjsEvalContext,
} from './ejs-runtime';

// ═══════════════════════════════════════════════════════════
// 契约
// ═══════════════════════════════════════════════════════════

/** 送进后端的一个条目 */
export interface EjsPassEntry {
  /** 条目 uid（回退告警与诊断用） */
  uid: number;
  /** 条目正文 */
  content: string;
}

/** 单条目求值结果 */
export interface EjsEntryOutcome {
  uid: number;
  /** 成功 = 渲染串；失败 = 原文（调用方直接用，无需再判） */
  text: string;
  ok: boolean;
  /** 失败原因摘要（`ok: false` 时有值） */
  error?: string;
}

export interface EjsBackend {
  /** 诊断用名字（进回退告警与调试面板） */
  readonly name: string;
  /**
   * 能否中断长时间执行。`false` = 死循环会冻住调用线程 ——
   * 对抗测试（合成语料 E 组）据此决定是否真跑危险用例。
   */
  readonly interruptible: boolean;
  /**
   * 跑一个装配 pass：条目**按序**执行，`ctx.vars` 草稿跨条目演化。
   *
   * **永不抛**。单条目失败 → 该条目 `ok:false` + `text` 为原文，不影响其余条目
   * （D8 条目级隔离），其半途写入整体回滚。
   */
  runPass(entries: EjsPassEntry[], ctx: EjsEvalContext): Promise<EjsEntryOutcome[]>;
  /** 释放后端资源（wasm 实例等）。Legacy 后端是空操作 */
  dispose(): void;
}

// ═══════════════════════════════════════════════════════════
// 编译缓存（后端间共享 —— 缓存键是正文，与后端无关）
// ═══════════════════════════════════════════════════════════

type CompileCacheHit = { ok: true; compiled: CompiledEjsEntry } | { ok: false; error: string };

/** session 级，不淘汰（全语料 ≈1500 块，无内存压力） */
const compileCache = new Map<string, CompileCacheHit>();

/** 取（或建）编译产物；语法错误也缓存，避免每回合重炸一遍 */
export function getCompiledEntry(content: string): CompileCacheHit {
  const cached = compileCache.get(content);
  if (cached) return cached;
  let result: CompileCacheHit;
  try {
    result = { ok: true, compiled: compileEjsEntry(content) };
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
  compileCache.set(content, result);
  return result;
}

/** 清空编译缓存（测试/性能计时用；生产路径无需调用） */
export function clearEjsBackendCache(): void {
  compileCache.clear();
}

// ═══════════════════════════════════════════════════════════
// LegacyBackend —— 现行 new Function
// ═══════════════════════════════════════════════════════════

export class LegacyBackend implements EjsBackend {
  readonly name = 'legacy(new Function)';
  /** 同步主线程执行，没有任何中断手段 —— 死循环即冻结 */
  readonly interruptible = false;

  async runPass(entries: EjsPassEntry[], ctx: EjsEvalContext): Promise<EjsEntryOutcome[]> {
    const out: EjsEntryOutcome[] = [];
    for (const entry of entries) {
      const content = entry.content ?? '';
      const compiled = getCompiledEntry(content);
      if (!compiled.ok) {
        out.push({ uid: entry.uid, text: content, ok: false, error: compiled.error });
        continue;
      }
      // 逐条 await：条目**必须按序**执行（后条目要读到前条目的写）
      const executed = await executeEjsEntryAsync(compiled.compiled, ctx);
      out.push(
        executed.ok
          ? { uid: entry.uid, text: executed.rendered, ok: true }
          : { uid: entry.uid, text: content, ok: false, error: executed.error },
      );
    }
    return out;
  }

  dispose(): void {
    /* 无资源可释放 */
  }
}

// ═══════════════════════════════════════════════════════════
// FailClosedBackend —— 隔离不可用时的**唯一**生产形态
// ═══════════════════════════════════════════════════════════

/**
 * 什么都不求值：全部条目按 D8 原文注入。
 *
 * ## 为什么不是「退回 Legacy」
 * 曾经的 `installProductionEjsBackend` 在装 wasm 失败时**静默退回 `new Function`**，
 * 只留一行 `console.warn`，而 `main.ts` 连返回值都丢了。那比「没有隔离」更糟：
 * 没有隔离时你知道自己没有；有一个会静默失效的隔离，你会**按「有隔离」去做决策**
 * （比如据此解封工坊入口）。
 *
 * 回退原文 = 今天的现状，**最坏情况等于 EJS 没上线**（D8 一直就是这个语义）——
 * 拿它换掉「无声地把 API Key / 存档 / 本地 BFF 暴露给内容作者」，这笔交易不用犹豫。
 */
export class FailClosedBackend implements EjsBackend {
  readonly name = 'fail-closed(隔离不可用)';
  readonly interruptible = true; // 什么都不跑，自然不会被卡住

  constructor(private readonly reason: string) {}

  async runPass(entries: EjsPassEntry[], _ctx: EjsEvalContext): Promise<EjsEntryOutcome[]> {
    return entries.map((e) => ({
      uid: e.uid,
      text: e.content,
      ok: false,
      error: `EJS 未求值（${this.reason}）`,
    }));
  }

  dispose(): void {
    /* 无资源可释放 */
  }
}

// ═══════════════════════════════════════════════════════════
// 当前后端（单例 + 可替换）
// ═══════════════════════════════════════════════════════════

/**
 * 当前后端。
 *
 * **默认 Legacy，且这个默认值只服务测试**：本模块被 5000+ 单测直接/间接 import，
 * 默认加载 wasm 会让每个测试文件都背上启动成本，而绝大多数测试跑的是渲染语义不是隔离属性。
 *
 * 🔴 **生产永远不会停在这个默认值上**：`installProductionEjsBackend()` 第一件事就是
 * 把它换成 `FailClosedBackend`（关掉「装载期间悄悄用 Legacy 渲染」的时间窗），
 * 装成功再换 QuickJS，装失败就**留在 fail-closed**。
 *
 * 待办（能力面 §11.2 ③）：真机走查 + 语料基线重建之后删掉 Legacy，
 * 这里的默认值改成 `FailClosedBackend`，测试改为显式 `setEjsBackend(...)`。
 */
let current: EjsBackend = new LegacyBackend();

/** 取当前后端 */
export function getEjsBackend(): EjsBackend {
  return current;
}

/**
 * 换后端（生产切 QuickJS / 测试注入假后端）。
 * 会 `dispose()` 旧后端 —— 换的时候旧的 wasm 实例必须放掉。
 */
export function setEjsBackend(backend: EjsBackend): void {
  if (backend === current) return;
  try {
    current.dispose();
  } catch {
    // 释放失败不该阻断切换
  }
  current = backend;
}

/**
 * 恢复默认（Legacy）后端 —— **测试 teardown 专用**。
 * 生产代码不该调它：调了就等于把隔离关掉（见 `current` 的说明）。
 */
export function resetEjsBackend(): void {
  installPromise = null;
  setEjsBackend(new LegacyBackend());
}

/**
 * 装配结果记忆 —— 重复调用不会把**正在服役的** QuickJS 后端 dispose 掉再重建一个。
 * `resetEjsBackend()` 会清掉它（测试要能重跑装配）。
 */
let installPromise: Promise<boolean> | null = null;

/**
 * 生产装配：切到隔离后端（能力面 §11 切片 T8 / §11.2 ①）。
 *
 * 由应用入口调用一次，**必须 await 或接住返回值**。
 *
 * ## 失败时 fail closed，不退回 Legacy
 * 装不上 wasm → `FailClosedBackend` → 世界书条目**原文注入**（D8 语义，最坏等于 EJS 没上线）。
 * 刻意不退回 `new Function`：那会在用户毫不知情的情况下把隔离摘掉，
 * 而下游（例如工坊入口的解封判断）是**按「有隔离」在做决策**的。宁可不求值，不可假装安全。
 *
 * 装载期间也已经是 fail-closed —— 不留「还没装完所以先用 Legacy 渲染一轮」的窗口。
 *
 * @returns 是否成功切到隔离后端；`false` 时调用方应向用户明示「EJS 未启用」
 */
export function installProductionEjsBackend(): Promise<boolean> {
  if (installPromise) return installPromise;
  // 先关窗：装载是异步的，这期间任何 runPass 都必须 fail closed 而不是落到 Legacy
  setEjsBackend(new FailClosedBackend('隔离后端装载中'));
  installPromise = doInstall();
  return installPromise;
}

async function doInstall(): Promise<boolean> {
  try {
    const { createQuickJsBackend } = await import('./ejs-quickjs-backend');
    setEjsBackend(createQuickJsBackend());
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[EJS] 隔离后端装载失败，EJS 停用（条目原文注入）:', err);
    setEjsBackend(new FailClosedBackend(`隔离后端装载失败: ${reason}`));
    return false;
  }
}
