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
 * ## 不支持
 * 同步执行，不支持 `await`（全语料 ≤1 处）；不支持 `include()`（0 处）。
 * 中招条目由调用方按 D8 回退原文注入。
 */

import { ejsLodash } from './ejs-lodash-shim';

// ═══════════════════════════════════════════════════════════
// 公开类型
// ═══════════════════════════════════════════════════════════

/** EJS 求值上下文（两轴 + 历史正文） */
export interface EjsEvalContext {
  /** 只读快照——调用方保证是孤儿深拷贝，EJS 改它不回流引擎 */
  stats: Record<string, any>;
  /** 可变草稿——调用方持有该对象引用，EJS 的写就是真实写 */
  vars: Record<string, any>;
  /** 近层聊天正文拼接串（`matchChatMessages` 的检索面） */
  historyText: string;
}

/** 编译产物（内部形状，调用方只需原样传回 `executeEjsEntry`） */
export interface CompiledEjsEntry {
  /** 原始条目正文（用于缓存键/调试） */
  readonly source: string;
  /** 生成的函数体（调试用，出错时定位） */
  readonly body: string;
  /** 编译好的执行函数 */
  readonly fn: (...args: any[]) => string;
}

/** 执行结果——**永不抛出**；失败时该条目对 `ctx.vars` 的写已整体回滚 */
export type EjsExecuteResult = { ok: true; rendered: string } | { ok: false; error: string };

// ═══════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════

type EjsTokenType = 'text' | 'code' | 'output' | 'unescaped' | 'comment';
/** 右侧空白处置：`_%>` 吞空白+一个换行；`-%>` 只吞一个换行 */
type TrimRightMode = 'none' | 'slurp' | 'newline';

interface EjsToken {
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
    tokens.push({
      type,
      // 代码块保留原始换行（多行代码/行注释都靠它），输出表达式去空白
      content: type === 'code' || type === 'comment' ? raw : raw.trim(),
      trimLeft,
      trimRight,
    });

    pos = close + 2;
  }

  return tokens;
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
  'localStorage',
  'indexedDB',
  'self',
  'top',
  'parent',
  'frames',
  'navigator',
  'location',
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
  const fn = new Function(...SANDBOX_PARAM_NAMES, ...SHADOWED_GLOBALS, body) as (
    ...args: any[]
  ) => string;
  return { source: content ?? '', body, fn };
}

// ═══════════════════════════════════════════════════════════
// 沙盒注入面
// ═══════════════════════════════════════════════════════════

/** 原型污染防御：与 var-resolver.ts 同口径（命中即**整次写入**静默拒绝） */
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

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
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, any> = {};
  for (const k of Object.keys(value as Record<string, any>)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = deepClone((value as Record<string, any>)[k]);
  }
  return out as unknown as T;
}

/**
 * 统一读链（设计 D5 三种读形）：
 * 1. 空路径 → 浅合并 `{ ...vars, ...stats }`（stats 顶层键胜出）
 * 2. stats 上取到非 undefined → **stats 命中**，返回深克隆（只读隔离）
 * 3. 否则落 vars → 返回**活引用**（对其属性赋值就是真实草稿写）
 * 4. 都没有 → `opts.defaults`
 */
function readPath(ctx: EjsEvalContext, parts: string[], defaults?: any): any {
  if (parts.length === 0) return { ...ctx.vars, ...ctx.stats };

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

/** 构建一次求值所需的全部沙盒实参（顺序对齐 SANDBOX_PARAM_NAMES） */
function buildSandboxArgs(ctx: EjsEvalContext): any[] {
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

  const getLocalVar = (key: string, opts?: EjsReadOptions): any => {
    const local = ctx.vars._local;
    const v =
      local !== null && typeof local === 'object'
        ? (local as Record<string, any>)[String(key)]
        : undefined;
    return v === undefined ? opts?.defaults : v;
  };

  const setLocalVar = (key: string, value: any): void => {
    const k = String(key);
    if (DANGEROUS_PATH_SEGMENTS.has(k)) return;
    if (ctx.vars._local === null || typeof ctx.vars._local !== 'object') ctx.vars._local = {};
    (ctx.vars._local as Record<string, any>)[k] = value;
  };

  // 裸全局 `variables`：语料形态是 `_.get(variables, 'stat_data.关系列表', {})`
  const variables = { stat_data: { ...ctx.vars, ...ctx.stats } };

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

  return [
    ctx.stats,
    ctx.vars,
    getMessageVar,
    setMessageVar,
    getvar,
    setvar,
    getLocalVar,
    setLocalVar,
    variables,
    matchChatMessages,
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

/** 就地恢复 vars（保持对象引用不变——调用方持有的是同一引用） */
function restoreInPlace(target: Record<string, any>, snapshot: Record<string, any>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, snapshot);
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
  const snapshot = deepClone(ctx.vars);
  try {
    const args = buildSandboxArgs(ctx);
    const rendered = compiled.fn(...args, ...SHADOWED_GLOBALS.map(() => undefined));
    return { ok: true, rendered: typeof rendered === 'string' ? rendered : String(rendered ?? '') };
  } catch (err) {
    restoreInPlace(ctx.vars, snapshot);
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, error: msg };
  }
}
