/**
 * script-backend.ts —— 词条脚本求值后端接口（SEC-02 收口）
 *
 * ## 为什么要有这层
 * `script-executor` 原先用 `new Function` 在**应用同源主线程**上跑 AI 写的效果脚本。
 * 那是 2026-08-09 审查里唯一一条越红线 ③ 的发现：构造器逃逸
 * （`({}).constructor.constructor("return globalThis")()`）拿回的是**应用自己的** `globalThis`，
 * 于是 `indexedDB` → Dexie → `apiEndpoints.apiKey` 全在手上，而应用没有任何 CSP，`fetch` 直接出网。
 * 更阴的一条不需要出网：改掉 Dexie 里那行 `baseUrl`，下一回合**应用自己**会把 Key
 * 连同全部对话送到攻击者那里（`agent-client.ts` 的 `X-Target-Base-URL` + `Authorization`）。
 *
 * 收口办法与 EJS 同一道边界：**QuickJS(wasm) realm 隔离**。guest 里根本不存在
 * `indexedDB` / `fetch` / 宿主 `globalThis`，不是「被挡住」而是「不存在」——
 * 读 Key、改端点、清库、打本地 BFF 四条路一起断，因为它们够得着的那些对象没被造出来。
 *
 * ## 与 `ejs-backend.ts` 的一处**刻意不同**：没有 Legacy
 * EJS 那边留了 `LegacyBackend`（`new Function`）给 5000+ 单测省 wasm 启动成本。
 * 本模块**不留** —— 脚本执行面就是 SEC-02 本身，留一个可安装的 `new Function` 实现，
 * 等于把刚拆掉的那把枪放回抽屉里。脚本相关的测试文件只有三个，各自 `beforeAll` 装一次真隔离即可
 * （见 `script-executor.test.ts` 顶部），顺带让「兼容性」这件事是**被测出来的**而不是被假设的。
 *
 * ## 默认 fail-closed
 * 没装隔离 = 脚本**一行都不跑**，不是「先用 new Function 跑着」。理由照抄 EJS 那条：
 * 没有隔离时你知道自己没有；有一个会静默失效的隔离，你会按「有隔离」去做决策。
 */

import type { ScriptQuickJsBackend } from './script-quickjs-backend';

// ═══════════════════════════════════════════════════════════
// 契约
// ═══════════════════════════════════════════════════════════

/**
 * 一次脚本执行的沙盒面 —— 就是 `buildSandbox()` 的返回值，原样交进来。
 *
 * 🔴 后端**从这个对象推导** guest 侧的 API 形状，不另维护一份名单。
 *    另维护一份的败法这仓库踩过很多次（`marker-protocol` 的 MARKER_SPECS、
 *    `image-prompt` 的 normalizeTagString 都是为此收敛的）：加了 `$foo` 忘了同步，
 *    脚本调用时 `ReferenceError`，而它长得像「AI 又写错了」。
 */
export type ScriptSandboxSpec = Record<string, unknown>;

/** 一次脚本执行的结果 —— 副作用**不**在这里，它们经宿主闭包落进 `ScriptEffects` */
export interface ScriptRunOutcome {
  ok: boolean;
  /** `ok: false` 时的原因摘要（进 console，形状对齐旧实现的 `err.message`） */
  error?: string;
}

export interface ScriptBackend {
  /** 诊断用名字 */
  readonly name: string;
  /** 能否中断长执行。`false` = 死循环会冻住调用线程 */
  readonly interruptible: boolean;
  /**
   * 跑一段脚本。**永不抛** —— 失败经 `ScriptRunOutcome.ok` 回答。
   *
   * 同步：三个调用点（`effect-wiring` / `state-manager` / `subscription-manager`）
   * 都是同步路径，改成异步会波及整条事件链。QuickJS 的 `newRuntime`/`evalCode`
   * 在 wasm 装好之后本来就是同步的，所以装载放在 `installProductionScriptBackend()` 里预热。
   */
  run(script: string, sandbox: ScriptSandboxSpec): ScriptRunOutcome;
  /** 释放后端资源（wasm 实例等） */
  dispose(): void;
}

// ═══════════════════════════════════════════════════════════
// FailClosedScriptBackend —— 未装隔离时的唯一形态
// ═══════════════════════════════════════════════════════════

/**
 * 什么都不跑。
 *
 * 后果是「带脚本的物品/状态失去效果」，与脚本系统上线前的行为一致 —— 可接受。
 * 拿它换掉「无声地把 API Key 交给内容作者」，这笔交易不用犹豫。
 *
 * 🔴 **每次都 warn**，不做去重限频。这条路径在生产上不该被走到，
 *    真被走到时它是「玩法静默失效」的唯一线索；压掉它等于把线索也压掉。
 */
class FailClosedScriptBackend implements ScriptBackend {
  readonly name = 'fail-closed(隔离不可用)';
  readonly interruptible = true; // 什么都不跑，自然卡不住

  constructor(private readonly reason: string) {}

  run(script: string, _sandbox: ScriptSandboxSpec): ScriptRunOutcome {
    if (script.trim().length > 0) {
      console.warn(`[ScriptExecutor] 脚本未执行（${this.reason}）—— 效果脚本已停用`);
    }
    return { ok: false, error: `脚本未执行（${this.reason}）` };
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
 * 🔴 默认 **fail-closed**（与 `ejs-backend.ts` 默认 Legacy 相反，理由见文件头）。
 *    生产由 `installProductionScriptBackend()` 换成 QuickJS；测试显式装。
 */
let current: ScriptBackend = new FailClosedScriptBackend('隔离后端未装载');

export function getScriptBackend(): ScriptBackend {
  return current;
}

/**
 * 换后端。会 `dispose()` 旧后端 —— 换的时候旧的 wasm 实例必须放掉。
 *
 * 🔴 **模块私有，刻意不导出**。EJS 那边的同名函数是导出的（测试要注入假后端），
 *    这边不给：脚本执行面就是 SEC-02 本身，一个「谁都能换掉当前后端」的公开入口
 *    等于把 fail-closed 默认值变成建议。真要注入替身，改这里比绕过它更该被看见。
 */
function setScriptBackend(backend: ScriptBackend): void {
  if (backend === current) return;
  try {
    current.dispose();
  } catch {
    // 释放失败不该阻断切换
  }
  current = backend;
}

/**
 * 回到 fail-closed —— **测试 teardown 专用**。
 * 生产代码不该调它：调了就等于把脚本系统关掉。
 */
export function resetScriptBackend(): void {
  installPromise = null;
  setScriptBackend(new FailClosedScriptBackend('隔离后端未装载'));
}

/** 装配结果记忆 —— 重复调用不会把正在服役的后端 dispose 掉再建一个 */
let installPromise: Promise<boolean> | null = null;

/**
 * 生产装配：切到 QuickJS 隔离后端。
 *
 * 由应用入口调用一次，**必须 await 或接住返回值** —— 返回 `false` 时要让用户看见，
 * 否则他会按「脚本系统能用」去理解一个悄悄停摆的玩法面。
 *
 * ## `true` 的含义是「wasm 真的起来了」
 * 不是「JS 模块 import 成功了」。所以 `doInstall` 必须 `warmup()`（真跑一次探针求值）——
 * EJS 那边正是在这里栽过：装配止步于 import，wasm 取不到时照样报成功。
 *
 * @returns 是否成功切到隔离后端
 */
export function installProductionScriptBackend(): Promise<boolean> {
  if (installPromise) return installPromise;
  // 先关窗：装载是异步的，这期间任何 run 都必须 fail closed
  setScriptBackend(new FailClosedScriptBackend('隔离后端装载中'));
  installPromise = doInstall();
  return installPromise;
}

async function doInstall(): Promise<boolean> {
  let backend: ScriptQuickJsBackend | null = null;
  try {
    // **动态** import：wasm 有体积，不能被静态图拖进每一条 import 链
    const { createScriptQuickJsBackend } = await import('./script-quickjs-backend');
    backend = createScriptQuickJsBackend();
    await backend.warmup();
    setScriptBackend(backend);
    return true;
  } catch (err) {
    try {
      backend?.dispose();
    } catch {
      // 释放失败不该阻断降级
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[ScriptExecutor] 隔离后端装载失败，效果脚本停用:', err);
    setScriptBackend(new FailClosedScriptBackend(`隔离后端装载失败: ${reason}`));
    return false;
  }
}
