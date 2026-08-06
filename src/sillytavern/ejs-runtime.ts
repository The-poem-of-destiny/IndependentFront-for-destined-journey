/**
 * ejs-runtime.ts — 世界书条目 EJS 求值运行时（工坊 Phase 2 / ADR-30）
 *
 * ## 为什么重写
 * Phase 4.6 的旧实现把每个 `<% %>` 块编译成**独立** `new Function`，而语料的主导模式是
 * 跨块控制流（`<%_ if (x) { _%> 正文 <%_ } _%>`，event.json 118 处）——拆开编译时
 * `if (x) {` 单独是语法错误，条件正文会无条件泄出。故推倒执行层，改**整片编译**
 * （经典 EJS 模型，设计 D2）：一个条目的全部 token 编进同一个函数体。
 *
 * ```
 * tokenize(content) → applyTrim → buildFnBody → new Function(...沙盒参数, body) → fn(...实参)
 * ```
 *
 * ## 求值契约（两轴，设计 D4/D5）
 * - `stats`：只读快照（调用方保证是孤儿深拷贝）。EJS 就地改它不污染引擎，pass 结束即弃。
 * - `vars`：可变草稿（= `SaveProfile.variables.sys` 的 pass 级副本），AI 与 EJS 共写同一棵树。
 *
 * ## 沙盒与信任模型（设计 D3）
 * `new Function` + 参数遮蔽危险全局。**这不是安全边界**——
 * `({}).constructor.constructor('return globalThis')()` 类逃逸堵不死（口径同 script-executor.ts）。
 * 信任模型：用户装什么内容是用户的选择，沙盒是**失误防护**（防手滑改全局、防意外网络请求），
 * 不是恶意代码防线。
 *
 * ## ST 值宏内嵌（`{{roll}}` / `{{random::}}`）
 * 上游宏先展开、EJS 后求值；本引擎顺序相反（D1）。故编译期把**代码位**里的自足值宏
 * 降成沙盒调用（`rewriteCodeMacros`），文本位的宏一律不动、照旧交下游宏链。
 *
 * ## 不支持
 * 同步执行，不支持 `await`（全语料 ≤1 处）；不支持 `include()`（0 处）。
 * 中招条目由调用方按 D8 回退原文注入。
 */

import { ejsLodash } from './ejs-lodash-shim';
import { createEjsRng } from './ejs-rng';
import { ejsFmt } from './ejs-fmt';
import { buildEjsCapabilities, type EjsCapabilityInput } from './ejs-capabilities';
import { DANGEROUS_PATH_SEGMENTS } from './var-resolver';

// ═══════════════════════════════════════════════════════════
// 公开类型
// ═══════════════════════════════════════════════════════════

/** EJS 求值上下文（两轴 + 历史正文 + 确定性种子） */
export interface EjsEvalContext {
  /**
   * pass 级随机种子串（`buildPassSeed(saveId, 回合号)`）。
   * 缺省时退化为固定串——同一次运行内仍确定，只是不跨会话复现（设计 §7）。
   */
  seed?: string;
  /** 只读快照——调用方保证是孤儿深拷贝，EJS 改它不回流引擎 */
  stats: Record<string, any>;
  /** 可变草稿——调用方持有该对象引用，EJS 的写就是真实写 */
  vars: Record<string, any>;
  /** 近层聊天正文拼接串（`matchChatMessages` 的检索面） */
  historyText: string;
  /**
   * 引擎侧能力面的输入（`chat`/`char`/`world`/`quest`/`lore`/`local`/`ui`/`engine`）。
   * 缺省 → 那些 namespace 仍然存在但全部返回安全默认值（设计 P3：能力永不抛）。
   */
  capabilities?: EjsCapabilityInput;
}

/** 编译产物（内部形状，调用方只需原样传回 `executeEjsEntry`） */
export interface CompiledEjsEntry {
  /** 原始条目正文（用于缓存键/调试） */
  readonly source: string;
  /** 生成的函数体（调试用，出错时定位） */
  readonly body: string;
  /** 编译好的执行函数（`isAsync` 时返回 Promise） */
  readonly fn: (...args: any[]) => string | Promise<string>;
  /**
   * 正文含 `await` → 编译成 `AsyncFunction`（真机语料 3 条：`await getwi(...)`）。
   *
   * **为什么不无脑全用 AsyncFunction**：那样每个条目都返回 Promise，
   * `executeEjsEntry` 只能变异步，全仓上百处同步调用点（含 123 个单测）跟着塌方。
   * 而 async 条目占比 3/109 —— 让少数派走异步路径，多数派保持同步，churn 最小、语义不损。
   */
  readonly isAsync: boolean;
}

/** 执行结果——**永不抛出**；失败时该条目对 `ctx.vars` 的写已整体回滚 */
export type EjsExecuteResult = { ok: true; rendered: string } | { ok: false; error: string };

// ═══════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════

type EjsTokenType = 'text' | 'code' | 'output' | 'unescaped' | 'comment';
/** 右侧空白处置：`_%>` 吞空白+一个换行；`-%>` 只吞一个换行 */
type TrimRightMode = 'none' | 'slurp' | 'newline';

export interface EjsToken {
  type: EjsTokenType;
  content: string;
  /** 来自 `<%_`：吞掉紧邻前文的行内空白 */
  trimLeft: boolean;
  trimRight: TrimRightMode;
}

/**
 * 切分模板为 token 序列。
 *
 * 识别：`<%` / `<%_` / `<%=` / `<%-` / `<%#` / `<%%`（字面 `<%`）；
 * 闭合统一扫 `%>`，再回看前一字符判 `_%>` / `-%>`。
 * 未闭合的 `<%` 原样降级为文本（与旧实现一致，保证渲染不吞内容）。
 */
function tokenize(template: string): EjsToken[] {
  const tokens: EjsToken[] = [];
  const pushText = (content: string): void => {
    if (content.length === 0) return;
    tokens.push({ type: 'text', content, trimLeft: false, trimRight: 'none' });
  };

  let pos = 0;
  const len = template.length;

  while (pos < len) {
    const open = template.indexOf('<%', pos);
    if (open === -1) {
      pushText(template.slice(pos));
      break;
    }
    if (open > pos) pushText(template.slice(pos, open));

    // `<%%` → 字面 "<%"
    if (template[open + 2] === '%') {
      pushText('<%');
      pos = open + 3;
      continue;
    }

    let cursor = open + 2;
    let type: EjsTokenType = 'code';
    let trimLeft = false;
    const marker = template[cursor];
    if (marker === '_') {
      trimLeft = true;
      cursor++;
    } else if (marker === '=') {
      type = 'output';
      cursor++;
    } else if (marker === '-') {
      type = 'unescaped';
      cursor++;
    } else if (marker === '#') {
      type = 'comment';
      cursor++;
    }

    const close = template.indexOf('%>', cursor);
    if (close === -1) {
      // 未闭合 → 原样当文本
      pushText(template.slice(open));
      break;
    }

    let codeEnd = close;
    let trimRight: TrimRightMode = 'none';
    if (close > cursor) {
      const prevCh = template[close - 1];
      if (prevCh === '_') {
        trimRight = 'slurp';
        codeEnd = close - 1;
      } else if (prevCh === '-') {
        trimRight = 'newline';
        codeEnd = close - 1;
      }
    }

    const raw = template.slice(cursor, codeEnd);
    // 代码块保留原始换行（多行代码/行注释都靠它），输出表达式去空白
    const normalized = type === 'code' || type === 'comment' ? raw : raw.trim();
    tokens.push({
      type,
      // 注释整块丢弃，不必改写；其余代码位的 ST 值宏先降成沙盒调用（见 rewriteCodeMacros）
      content: type === 'comment' ? normalized : rewriteCodeMacros(normalized),
      trimLeft,
      trimRight,
    });

    pos = close + 2;
  }

  return tokens;
}

// ═══════════════════════════════════════════════════════════
// ST 值宏 → 沙盒调用改写（仅代码位）
// ═══════════════════════════════════════════════════════════

/**
 * 代码位里的 ST 值宏改写表。
 *
 * 上游（ST + 酒馆助手）里宏由 ST 核心先行展开，EJS 拿到的已是字面值，所以语料写得出
 * `<%_ if ({{roll 1d100}} >= 100) { _%>`（event.json uid 358）。本引擎的顺序是**反的**
 * （ADR-30 D1：EJS 求值在前、宏剥离在后），照直编译就是 `if ({{roll 1d100}} >= 100)` ——
 * SyntaxError，整条目回退原文注入。
 *
 * 修法不是调换 D1 顺序（那会让 EJS 产出的宏引用失去下游解析），而是**在编译期把代码位里的
 * 值宏降成沙盒函数调用**：`{{roll 1d100}}` → `__roll("1d100")`。
 *
 * 三点不变式：
 * 1. **只动代码位**（`<% %>` / `<%= %>` / `<%- %>` 内），文本位的宏原样交给下游宏链——
 *    `{{user}}` / `{{getvar::}}` / `{{setvar::}}` 的既有行为零改动。
 * 2. **只认自足值宏**（`roll` / `random`）——取值不依赖宏链的 setvar 表，何时求值都对。
 *    `{{user}}` 这类在代码位多半嵌在字符串字面量里（dlc#479 / system_core#417 实测 5 处），
 *    改写它反而会破坏输出，故**不在表内**。
 * 3. **改写成调用而非字面值**——正文字节不变 → `getCompiled` 的 session 级编译缓存照常命中，
 *    且每次执行真正重掷（字面值代换会把首轮结果冻死在缓存里）。
 */
const CODE_MACRO_REWRITES: ReadonlyArray<{ re: RegExp; fn: string }> = [
  // `{{roll 1d100}}` / `{{roll::1d100}}`（ST 两种写法都收）
  { re: /\{\{roll(?:\s*::\s*|\s+)([^{}]*?)\}\}/gi, fn: '__roll' },
  // `{{random::A,B,C}}`（语义对齐 preset-loader.resolveRandoms）
  { re: /\{\{random::([^{}]*?)\}\}/gi, fn: '__random' },
];

/**
 * 把代码位里的自足值宏改写成沙盒调用；无命中时原样返回。
 *
 * 🔴 **导出给 QuickJS 后端复用**：那边自建了一套 guest 侧编译器，一开始漏了这一步，
 * 结果同一条 `{{roll 1d100}}` 在 Legacy 下渲染正常、在 QuickJS 下报
 * `SyntaxError: invalid property name`（真机语料命中 4 条）。两个后端**必须共用同一套改写规则**。
 */
export function rewriteCodeMacros(code: string): string {
  if (!code.includes('{{')) return code;
  let out = code;
  for (const { re, fn } of CODE_MACRO_REWRITES) {
    // JSON.stringify 兜住引号/反斜杠——宏参数是用户内容，不能裸拼进源码
    out = out.replace(re, (_m, arg: string) => `${fn}(${JSON.stringify(arg)})`);
  }
  return out;
}

/**
 * 应用 `<%_` / `_%>` / `-%>` 的空白吞噬（对齐 EJS：
 * `[ \t]*<%_` 与 `_%>[ \t]*` 去行内空白，`_%>` / `-%>` 再各吞一个紧邻换行）。
 */
function applyTrim(tokens: EjsToken[]): EjsToken[] {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'text') continue;

    if (t.trimLeft) {
      const prev = tokens[i - 1];
      if (prev && prev.type === 'text') {
        prev.content = prev.content.replace(/[ \t]*$/, '');
      }
    }

    if (t.trimRight !== 'none') {
      const next = tokens[i + 1];
      if (next && next.type === 'text') {
        let s = next.content;
        if (t.trimRight === 'slurp') s = s.replace(/^[ \t]*/, '');
        s = s.replace(/^(?:\r\n|\r|\n)/, '');
        next.content = s;
      }
    }
  }
  return tokens;
}

/**
 * 切分模板并应用 trim 语义，产出可直接编译的 token 序列。
 *
 * 🔴 **导出给 QuickJS 后端复用**：guest 侧曾自建一套编译器，只跳过 `<%_`/`_%>`/`-%>`
 * 的标记字符却**没吞空白**，同一条 `甲\n<%_ x _%>\n乙` 在 Legacy 下渲染 `甲\n乙`、
 * 在 QuickJS 下多出一行 `甲\n\n乙`（scrambled 语料 107/109 命中）。两个后端共用本函数后，
 * trim 语义与宏改写（tokenize 内已 rewriteCodeMacros）逐字节对齐。
 */
export function tokenizeTrimmed(template: string): EjsToken[] {
  return applyTrim(tokenize(template ?? ''));
}

// ═══════════════════════════════════════════════════════════
// 编译
// ═══════════════════════════════════════════════════════════

/** 沙盒注入面（顺序必须与 `buildSandboxArgs` 一一对应） */
const SANDBOX_PARAM_NAMES = [
  // 两轴
  'stats',
  'vars',
  // 别名层（承接存量语料）
  'getMessageVar',
  'setMessageVar',
  'getvar',
  'setvar',
  'getLocalVar',
  'setLocalVar',
  'variables',
  'matchChatMessages',
  // ST 值宏的降级落点（由 rewriteCodeMacros 生成调用，模板作者不直接写）
  '__roll',
  '__random',
  // —— 能力面 §3（T2/T4/T5）：创作者直接写的 12 个顶层符号 ——
  'rng',
  'fmt',
  'chat',
  'char',
  'world',
  'quest',
  'lore',
  'local',
  'ui',
  'engine',
  // —— 上游别名层（§5，仅为存量内容）——
  'getChatMessage',
  'getChatMessages',
  'getwi',
  'YAML',
  'TavernHelper',
  'toastr',
  'alert',
  'message_id',
  'lastMessageId',
  'charLoreBook',
  'localStorage',
  'console',
  '_',
  // 原生直传
  'Math',
  'JSON',
  'String',
  'Number',
  'Boolean',
  'RegExp',
  'Array',
  'Object',
] as const;

/**
 * 遮蔽为 `undefined` 的危险全局（同名形参遮蔽，使模板内直接引用拿到 undefined）。
 * ⚠️ 见文件头：这是失误防护，不是安全边界。
 */
const SHADOWED_GLOBALS = [
  'globalThis',
  'window',
  'document',
  'fetch',
  'XMLHttpRequest',
  // ⚠️ `localStorage` **不在这里** —— 它已被别名层接管（映射到 `local` 私有 KV，§5）。
  //    同名既做遮蔽形参又做能力形参 = 严格模式下重复形参名 = SyntaxError，整份编译炸掉。
  'indexedDB',
  'self',
  'top',
  'parent',
  'frames',
  'navigator',
  'location',
  // 对齐 script-executor.ts 的同款名单（设计 D3 要求两处沙盒同口径）：
  // `Function` 遮蔽掉最直接的构造器逃逸写法；定时器/长连接遮蔽掉「条目跑完还在后台跑」的手滑。
  // ⚠️ 编译期用的是本模块外层作用域的 `new Function`，形参遮蔽只作用于模板代码作用域，编译不受影响。
  'Function',
  'setTimeout',
  'setInterval',
  'WebSocket',
  'sessionStorage',
] as const;

/** token 序列 → 单个函数体（整片编译的核心） */
function buildFnBody(tokens: EjsToken[]): string {
  const lines: string[] = [
    '"use strict";',
    'const __ejsOut = [];',
    'const __ejsStr = (v) => (v === undefined || v === null) ? "" : String(v);',
    // EJS 语言自带的输出函数（不是上游酒馆助手 API）。必须在函数体内声明——
    // 它要闭包住 __ejsOut，做不成沙盒形参。语料 dlc.json#477 用到。
    'const print = (v) => { __ejsOut.push(__ejsStr(v)); };',
  ];

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        if (t.content.length > 0) lines.push(`__ejsOut.push(${JSON.stringify(t.content)});`);
        break;
      case 'code':
        // 原样内联 —— 跨块 if/for 由此天然成立
        lines.push(t.content);
        break;
      case 'output':
      case 'unescaped':
        // `<%=` 与 `<%-` 同义：本引擎注入的是提示词纯文本，不做 HTML 转义
        lines.push(`__ejsOut.push(__ejsStr(${t.content.length > 0 ? t.content : 'undefined'}));`);
        break;
      case 'comment':
        break;
    }
  }

  lines.push('return __ejsOut.join("");');
  return lines.join('\n');
}

/**
 * 编译单个条目正文。
 *
 * @param content 条目正文
 * @returns 可复用的编译产物（调用方可按 content 做缓存）
 * @throws SyntaxError 正文里的 JS 语法错误（调用方按 D8 回退原文注入）
 */
export function compileEjsEntry(content: string): CompiledEjsEntry {
  const tokens = applyTrim(tokenize(content ?? ''));
  const body = buildFnBody(tokens);
  // 只看代码位有没有 `await`：文本位出现「await」这个词是正文，不该触发异步编译
  const isAsync = tokens.some(
    (t) => t.type !== 'text' && t.type !== 'comment' && HAS_AWAIT.test(t.content),
  );
  const Ctor = isAsync ? AsyncFunctionCtor : Function;
  const fn = new Ctor(...SANDBOX_PARAM_NAMES, ...SHADOWED_GLOBALS, body) as (
    ...args: any[]
  ) => string | Promise<string>;
  return { source: content ?? '', body, fn, isAsync };
}

/** `await` 关键字（词边界，避开 `awaited` / `myawait` 之类） */
const HAS_AWAIT = /\bawait\b/;

/** `AsyncFunction` 构造器 —— 全局里没有这个名字，只能从一个 async 函数的原型链上取 */
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {})
  .constructor as FunctionConstructor;

// ═══════════════════════════════════════════════════════════
// 沙盒注入面
// ═══════════════════════════════════════════════════════════

// 原型污染防御的键集来自 var-resolver（全仓唯一定义）；命中即**整次写入**静默拒绝

/** 读选项——`scope` / `noCache` 静默忽略（设计 §4 降级清单） */
interface EjsReadOptions {
  defaults?: any;
  [key: string]: any;
}

/** 剥 `stat_data` 前缀：`'stat_data'` → `''`，`'stat_data.a.b'` → `'a.b'` */
function stripStatDataPrefix(path: string): string {
  return path.replace(/^stat_data(?:\.|$)/, '');
}

function hasStatDataPrefix(path: string): boolean {
  return /^stat_data(?:\.|$)/.test(path);
}

/** 点路径切段（丢弃空段） */
function splitPath(path: unknown): string[] {
  if (typeof path !== 'string') return [];
  const trimmed = path.trim();
  if (!trimmed) return [];
  return trimmed.split('.').filter((p) => p.length > 0);
}

/** 沿点路径取值；任一层为 null/undefined 即返回 undefined */
function getByPath(root: any, parts: string[]): any {
  let cur: any = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 深拷贝（纯数据面）：数组/Date/纯对象递归，其余（函数、类实例）原样返回。
 * 用途有二：stats 侧子树读的隔离拷贝；执行失败回滚的 vars 快照。
 *
 * **环安全**：`vars` 是 AI 与 EJS 共写的草稿，条目完全可能写出 `vars.a = vars` 这类自引用
 * （旧实现会在下一条目取快照时栈溢出，异常越过 `executeEjsEntry` 漏给调用方）。
 * 这里用 `seen` 表记已克隆节点，**环按引用保留** —— 克隆图里对应位置仍然成环
 * （语义对齐 `structuredClone`），不断开、不抛错。
 */
function deepClone<T>(value: T, seen?: WeakMap<object, any>): T {
  if (value === null || typeof value !== 'object') return value;
  const node = value as unknown as object;
  const map = seen ?? new WeakMap<object, any>();
  if (map.has(node)) return map.get(node) as T;

  if (Array.isArray(value)) {
    const arr: any[] = [];
    map.set(node, arr);
    for (const v of value) arr.push(deepClone(v, map));
    return arr as unknown as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, any> = {};
  map.set(node, out);
  for (const k of Object.keys(value as Record<string, any>)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = deepClone((value as Record<string, any>)[k], map);
  }
  return out as unknown as T;
}

/**
 * 整树读（空路径 / 裸 `variables.stat_data`）的合并面。
 *
 * - `vars` 侧保**活引用** —— 那是共写草稿，模板深改它就是契约内的写。
 * - `stats` 侧顶层值**深克隆** —— 只读契约：模板做 `variables.stat_data.主角.生命值 = 999`
 *   这类深改时，绝不能污染 pass 级共享的 stats（同 pass 后续条目必须读到原值）。
 * - stats 顶层键胜出（同名时只读面优先）。
 */
function mergeVarsWithClonedStats(ctx: EjsEvalContext): Record<string, any> {
  const out: Record<string, any> = { ...ctx.vars };
  const stats = ctx.stats ?? {};
  for (const k of Object.keys(stats)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = deepClone(stats[k]);
  }
  return out;
}

/**
 * 统一读链（设计 D5 三种读形）：
 * 1. 空路径 → 合并 `vars`(活引用) + `stats`(顶层深克隆，见 `mergeVarsWithClonedStats`)
 * 2. stats 上取到非 undefined → **stats 命中**，返回深克隆（只读隔离）
 * 3. 否则落 vars → 返回**活引用**（对其属性赋值就是真实草稿写）
 * 4. 都没有 → `opts.defaults`
 */
function readPath(ctx: EjsEvalContext, parts: string[], defaults?: any): any {
  if (parts.length === 0) return mergeVarsWithClonedStats(ctx);

  const fromStats = getByPath(ctx.stats, parts);
  if (fromStats !== undefined) return deepClone(fromStats);

  const fromVars = getByPath(ctx.vars, parts);
  if (fromVars !== undefined) return fromVars;

  return defaults;
}

/** 统一写链：永远只写 `vars` 草稿，永不触碰 `stats` */
function writePath(ctx: EjsEvalContext, parts: string[], value: any): void {
  if (parts.length === 0) return;
  // 🔒 危险段命中 → 整次写入静默拒绝（不做部分写）
  if (parts.some((p) => DANGEROUS_PATH_SEGMENTS.has(p))) return;

  let cur: Record<string, any> = ctx.vars;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * 构建一次求值所需的全部沙盒实参（顺序对齐 SANDBOX_PARAM_NAMES）。
 *
 * @param sourceKey 条目正文 —— 与 `ctx.seed` 一起决定本条目的随机序列（设计 §7）。
 *                  同 pass 内不同条目因此拿到互不相关的序列，重放又完全一致。
 */
function buildSandboxArgs(ctx: EjsEvalContext, sourceKey: string): any[] {
  const rng = createEjsRng(`${ctx.seed ?? 'no-seed'}|${sourceKey}`);

  // —— 能力面（§3）。**必须早于别名层构建**：`getLocalVar` / `setLocalVar` 等别名直接转发到这里 ——
  const caps = buildEjsCapabilities(ctx.vars, ctx.historyText ?? '', ctx.capabilities);

  const getMessageVar = (path: string, opts?: EjsReadOptions): any =>
    readPath(ctx, splitPath(stripStatDataPrefix(String(path ?? ''))), opts?.defaults);

  const setMessageVar = (path: string, value: any): void =>
    writePath(ctx, splitPath(stripStatDataPrefix(String(path ?? ''))), value);

  /** getvar/setvar：带 `stat_data` 前缀时剥前缀，否则整个 key 当点路径 */
  const normalizeVarKey = (key: unknown): string => {
    const raw = String(key ?? '');
    return hasStatDataPrefix(raw) ? stripStatDataPrefix(raw) : raw;
  };

  const getvar = (key: string, opts?: EjsReadOptions): any =>
    readPath(ctx, splitPath(normalizeVarKey(key)), opts?.defaults);

  const setvar = (key: string, value: any): void =>
    writePath(ctx, splitPath(normalizeVarKey(key)), value);

  /**
   * `getLocalVar` / `setLocalVar` —— **直接转 `local.*`**，不另开一套键空间。
   *
   * 🔴 早先这俩别名读写的是扁平的 `vars._local[key]`，而 `local.*` 落的是
   * `vars._local.<projectId>[key]`：同一个键，一个存进去另一个看不见；
   * 而且别名那条路绕开了单键 / 单项目体积上限与可序列化校验。
   * 现在两条路共用同一个桶、同一套护栏（口径也与 QuickJS 后端的 guest 侧别名一致）。
   */
  const getLocalVar = (key: string, opts?: EjsReadOptions): any => {
    const v = caps.local.get(String(key), undefined);
    // `local.get` 查不到给 null；别名的历史语义是「没有就落 defaults（可为 undefined）」
    return v === null || v === undefined ? opts?.defaults : v;
  };

  const setLocalVar = (key: string, value: any): void => {
    const k = String(key);
    if (DANGEROUS_PATH_SEGMENTS.has(k)) return;
    caps.local.set(k, value);
  };

  // 裸全局 `variables`：语料形态是 `_.get(variables, 'stat_data.关系列表', {})`
  // stats 侧顶层深克隆（只读契约），vars 侧活引用（共写草稿）——见 mergeVarsWithClonedStats
  const variables = { stat_data: mergeVarsWithClonedStats(ctx) };

  const matchChatMessages = (pattern: unknown): boolean => {
    const text = ctx.historyText ?? '';
    if (typeof pattern === 'string') return text.includes(pattern);
    if (pattern instanceof RegExp) {
      // 剥掉 g/y —— 带 lastIndex 的正则连续 test 结果会漂移
      const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
      return re.test(text);
    }
    return false;
  };

  /**
   * `{{roll <公式>}}` 的实现——走 `rng`（种子随机），**不用 `Math.random`**：
   * 快照回退重放必须产出同一份世界书正文（设计 §7）。
   * 公式不可解析时返回 `0`：这是**数值位**，抛错会把整条目推去回退，比一个 0 糟得多。
   */
  const __roll = (formula: unknown): number => rng.roll(String(formula ?? ''));

  /** `{{random::A,B,C}}` 的实现——逗号分隔等概率取一，空表返回空串（对齐 resolveRandoms） */
  const __random = (options: unknown): string => {
    const parts = String(options ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return rng.pick(parts) ?? '';
  };

  // —— 上游别名层（§5）：全部映射到上面的能力，不引入第三种状态 ——
  const YAML = { stringify: (v: unknown, o?: any) => ejsFmt.yaml(v, o) };
  const toastr = {
    info: (m: unknown) => caps.ui.notify(String(m ?? ''), 'info'),
    success: (m: unknown) => caps.ui.notify(String(m ?? ''), 'success'),
    warning: (m: unknown) => caps.ui.notify(String(m ?? ''), 'warning'),
    error: (m: unknown) => caps.ui.notify(String(m ?? ''), 'error'),
  };
  // 上游 `alert` 是阻塞对话框；我们**刻意降级成非阻塞提示**（§3.11 边界）
  const alertShim = (m: unknown) => caps.ui.notify(String(m ?? ''), 'warning');
  const TavernHelper = {
    getLastMessageId: () => caps.world.回合,
    getVariables: () => variables,
  };
  // 上游 localStorage 的实际用途是「本 DLC 自己的持久 UI 偏好」→ 映射到 local，
  // **永远碰不到真的 window.localStorage**（那里躺着 API Key）
  const localStorageShim = {
    getItem: (k: unknown) => {
      const v = caps.local.get(String(k ?? ''), null);
      if (v === null || v === undefined) return null;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    setItem: (k: unknown, v: unknown) => caps.local.set(String(k ?? ''), String(v ?? '')),
    removeItem: (k: unknown) => caps.local.remove(String(k ?? '')),
  };
  const consoleShim = {
    log: (...a: unknown[]) => caps.ui.log(...a),
    info: (...a: unknown[]) => caps.ui.log(...a),
    warn: (...a: unknown[]) => caps.ui.log(...a),
    error: (...a: unknown[]) => caps.ui.log(...a),
    debug: (...a: unknown[]) => caps.ui.log(...a),
  };

  return [
    // 🔴 **每条目一份深拷贝**：`stats` 是 pass 级共享对象，直传引用时条目 A 的
    //    `stats.主角.背包.push(...)` 会被同 pass 的条目 B 看见 —— 既背离
    //    `engine-ejs.d.ts` 的「拿到的是一份拷贝」承诺，也与 QuickJS 后端（每条目 JSON 编组）分叉。
    //    stats 是小投影，克隆成本可忽略；口径与 `mergeVarsWithClonedStats` 一致。
    deepClone(ctx.stats ?? {}),
    ctx.vars,
    getMessageVar,
    setMessageVar,
    getvar,
    setvar,
    getLocalVar,
    setLocalVar,
    variables,
    matchChatMessages,
    __roll,
    __random,
    // 能力面 §3
    rng,
    ejsFmt,
    caps.chat,
    caps.char,
    caps.world,
    caps.quest,
    caps.lore,
    caps.local,
    caps.ui,
    caps.engine,
    // 上游别名层 §5
    (i: unknown, role?: unknown) =>
      caps.chat.at(Number(i), role === undefined ? undefined : String(role)),
    (a: unknown, b: unknown, role?: unknown) =>
      caps.chat
        .slice(Number(a), Number(b), role === undefined ? undefined : String(role))
        .join('\n'),
    (a: unknown, b?: unknown) =>
      caps.lore.get(String(a ?? ''), b === undefined ? undefined : String(b)),
    YAML,
    TavernHelper,
    toastr,
    alertShim,
    caps.world.回合,
    caps.world.回合,
    caps.charLoreBook,
    localStorageShim,
    consoleShim,
    ejsLodash,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
  ];
}

/**
 * 就地恢复 vars（保持对象引用不变——调用方持有的是同一引用）。
 * 只动顶层键，不递归 —— 快照本身可能含环（见 `deepClone`），这里天然环安全。
 * 注意：草稿原本自引用（`vars.a === vars`）时，恢复后 `vars.a` 指向的是快照那份克隆，
 * 不再回指 `vars` 本身。回滚保的是**内容**，不保自引用的身份。
 */
function restoreInPlace(target: Record<string, any>, snapshot: Record<string, any>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, snapshot);
}

/** 把任意抛出物压成可读字符串——`String(err)` 自身也可能抛（throwing toString），故再包一层 */
function describeError(err: unknown): string {
  try {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } catch {
    return 'UnknownError: 抛出物无法字符串化';
  }
}

// ═══════════════════════════════════════════════════════════
// 执行
// ═══════════════════════════════════════════════════════════

/**
 * 执行编译产物。**永不向外抛异常**。
 *
 * 失败时该条目对 `ctx.vars` 的半途写入**整体回滚**（设计 D8：条目级写缓冲，
 * 成功才留在草稿上），避免半执行状态污染后续条目。
 *
 * @param compiled `compileEjsEntry` 的产物
 * @param ctx 求值上下文（`ctx.vars` 会被就地修改）
 */
export function executeEjsEntry(compiled: CompiledEjsEntry, ctx: EjsEvalContext): EjsExecuteResult {
  if (compiled.isAsync) {
    // 同步入口拿不到 async 条目的结果（Promise 无法同步 drain）。不假装成功，
    // 直接给一个可读失败 → 调用方按 D8 回退原文。生产路径走 `executeEjsEntryAsync`。
    return { ok: false, error: 'AsyncEntryError: 条目含 await，需经 executeEjsEntryAsync 执行' };
  }
  // ⚠️ P2 性能项（已知取舍，刻意不优化）：快照成本 O(条目数 × 草稿树体积)——每个动态条目
  // 都全量深克隆一次 vars。真机实测（大草稿 × 数十动态条目）之前不引入写缓冲/首写才克隆，
  // 那会把「条目按序写→读立即可见」的简单语义换成代理层复杂度。等实测数据再谈。
  let snapshot: Record<string, any> | undefined;
  try {
    // 🔴 快照必须在 try 内：上一条目可能已把草稿写成自引用结构或带抛错 getter，
    // 克隆本身就可能抛；漏出去就违反「executeEjsEntry 永不抛」的契约（环已由 deepClone 兜住，
    // 这层 try 兜的是剩余未知抛点）。
    snapshot = deepClone(ctx.vars);
    const args = buildSandboxArgs(ctx, compiled.source);
    const rendered = compiled.fn(...args, ...SHADOWED_GLOBALS.map(() => undefined));
    return { ok: true, rendered: typeof rendered === 'string' ? rendered : String(rendered ?? '') };
  } catch (err) {
    rollback(ctx, snapshot);
    return { ok: false, error: describeError(err) };
  }
}

/**
 * 异步执行入口 —— 同步与 async 条目**都吃**。生产装配路径（预渲染）用这个。
 *
 * 与同步版共享全部语义（永不抛、失败整体回滚草稿）；差别只在它 `await` 编译产物的返回值，
 * 因而能跑 `await getwi(...)` 这类存量写法。
 */
export async function executeEjsEntryAsync(
  compiled: CompiledEjsEntry,
  ctx: EjsEvalContext,
): Promise<EjsExecuteResult> {
  let snapshot: Record<string, any> | undefined;
  try {
    snapshot = deepClone(ctx.vars);
    const args = buildSandboxArgs(ctx, compiled.source);
    const rendered = await compiled.fn(...args, ...SHADOWED_GLOBALS.map(() => undefined));
    return { ok: true, rendered: typeof rendered === 'string' ? rendered : String(rendered ?? '') };
  } catch (err) {
    rollback(ctx, snapshot);
    return { ok: false, error: describeError(err) };
  }
}

/** 失败回滚：就地恢复草稿；回滚自身失败也不外抛（草稿状态不可信，但契约是永不抛） */
function rollback(ctx: EjsEvalContext, snapshot: Record<string, any> | undefined): void {
  if (snapshot === undefined) return;
  try {
    restoreInPlace(ctx.vars, snapshot);
  } catch {
    // 冻结/不可配置属性等 → 无能为力，但仍不外抛
  }
}
