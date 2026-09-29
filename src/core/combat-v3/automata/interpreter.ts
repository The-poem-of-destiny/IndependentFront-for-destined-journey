/**
 * combat-v3/automata/interpreter.ts — 表达式 AST 解释器（零 eval，M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §七 7.3（表达式微文法）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.2（解释器）
 *
 * `evaluate(ast, ctx)` 在 immutable snapshot 之上解释执行，返回 number | string | boolean。
 *   - **零 `new Function` / `eval`**（铁律 2 / 验收 A3-2）——纯递归求值
 *   - 除法零除返回 0（不抛）
 *   - `ctx.*` path 走类型化白名单（window 分型）；未定义路径 ⇒ 抛 `ExprEvalError`，
 *     该 automaton **整批 reject**（错误隔离，架构 §五 5.4）
 *   - 比较/算术/逻辑/内建函数（min/max/floor/ceil/abs/percent/has）
 *
 * 无副作用；`evaluate` 是纯函数（不持有状态，不读外部变量）。
 */

import type { ExprAst, ExprValue, WindowCtx, WindowKey } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// 错误类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 表达式求值错误——`ctx.*` 路径未定义（未在 window 白名单内）或类型不可算。
 * 抛给 evaluateWindow，该 automaton 整批 intent 作废 + 产 EffectRejected（EVAL_ERROR）。
 */
export class ExprEvalError extends Error {
  /** 出错路径（如 'self.hp'） */
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`ExprEvalError: 路径「${path}」求值失败（${detail}）`);
    this.name = 'ExprEvalError';
    this.path = path;
  }
}

// 每窗口暴露的根段白名单（用于编译校验 #7 与运行时检查）
const WINDOW_ROOTS: Readonly<Record<WindowKey, readonly string[]>> = {
  'round.open': ['self', 'round', 'charges'],
  'round.close': ['self', 'round', 'charges'],
  'initiative.before': ['self', 'round', 'charges'],
  'initiative.after': ['self', 'round', 'charges'],
  'turn.open': ['self', 'round', 'charges'],
  'turn.close': ['self', 'round', 'charges'],
  'action.declared': ['self', 'round', 'charges'],
  'check.intent': ['self', 'target', 'round', 'charges'],
  'check.hit': ['self', 'target', 'round', 'charges'],
  collect_attacker_mods: ['self', 'target', 'round', 'charges'],
  collect_defender_mods: ['self', 'target', 'round', 'charges'],
  'damage.preview': ['self', 'target', 'damage', 'round', 'charges'],
  'damage.compute': ['self', 'target', 'damage', 'round', 'charges'],
  'damage.after': ['self', 'target', 'damage', 'round', 'depth', 'charges'],
  'unit.beforeDown': ['self', 'target', 'damage', 'round', 'charges'],
  'morale.before': ['self', 'round', 'charges'],
  'morale.after': ['self', 'round', 'charges'],
  'settlement.before': ['self', 'round', 'charges'],
};

/**
 * 查询指定窗口可访问的 ctx 根段（含内部缓存）。纯查询，无副作用。
 * 供 windows.ts / compile.ts 校验 `ctx.*` 路径根段 ∈ WindowCtxMap[subscribe] 键集。
 */
export function windowCtxRoots(key: WindowKey): readonly string[] {
  return WINDOW_ROOTS[key];
}

// ──────────────────────────────────────────────────────────────────────────────
// path → ExprValue 解析（类型化白名单）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 从 window ctx 递归取路径值。
 *
 * @throws ExprEvalError 路径未定义 / 根段不在窗口白名单 —— automaton 整批 reject
 */
function resolvePath<K extends WindowKey>(
  ctx: WindowCtx<K>,
  segments: readonly string[],
): ExprValue {
  if (segments.length === 0) {
    throw new ExprEvalError('<empty>', '空路径');
  }
  const root = segments[0];
  // 根段必须是已知 ctx 根（self/target/damage/round/depth/charges）。
  // 每窗口还可访问的根段集由 caller（windows.ts）传 window 分型的 ctx 决定，
  // 编译期校验 #7 已按 WindowCtxMap[subscribe] 键集兜底；这里只做运行时存在性检查。
  if (!KNOWN_CCTX_ROOTS.has(root)) {
    throw new ExprEvalError(segments.join('.'), `未知 ctx 根段「${root}」`);
  }

  let cur: unknown;
  switch (root) {
    case 'self':
      cur = (ctx as { self?: unknown }).self;
      break;
    case 'target':
      cur = (ctx as { target?: unknown }).target;
      break;
    case 'damage':
      cur = (ctx as { damage?: unknown }).damage;
      break;
    case 'round':
      cur = (ctx as { round?: unknown }).round;
      break;
    case 'depth':
      cur = (ctx as { depth?: unknown }).depth;
      break;
    case 'charges':
      cur = (ctx as { charges?: unknown }).charges;
      break;
    default:
      throw new ExprEvalError(segments.join('.'), `未知根段「${root}」`);
  }

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (cur === undefined || cur === null || typeof cur !== 'object') {
      throw new ExprEvalError(segments.join('.'), `「${segments.slice(0, i).join('.')}」非对象`);
    }
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
      throw new ExprEvalError(segments.join('.'), `「${seg}」字段未定义`);
    }
    cur = obj[seg];
  }
  return cur as ExprValue;
}

/** 已知 ctx 根段集合（interpreter 运行时存在性检查用） */
const KNOWN_CCTX_ROOTS: ReadonlySet<string> = new Set([
  'self',
  'target',
  'damage',
  'round',
  'depth',
  'charges',
]);

// ──────────────────────────────────────────────────────────────────────────────
// 值工具
// ──────────────────────────────────────────────────────────────────────────────

/** 把任意值强制为数字（供算术用；null→0，bool→1/0） */
function toNumber(v: ExprValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** 比较两值（宽松相等语义：数字/字符串/布尔） */
function looseEqual(a: ExprValue, b: ExprValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if ((a === null && b === null) || (typeof a === 'boolean' && typeof b === 'boolean')) {
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  // 跨类型：尝试数值比较（如 ctx.damage.final == 97）

  const an = typeof a === 'string' || typeof a === 'boolean' || a === null ? toNumber(a) : NaN;
  const bn = typeof b === 'string' || typeof b === 'boolean' || b === null ? toNumber(b) : NaN;
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// 内建函数（架构 §七 7.3 表）
// ──────────────────────────────────────────────────────────────────────────────

function builtinFn(fn: string, args: readonly ExprValue[]): ExprValue {
  const nums = args.map(toNumber);
  switch (fn) {
    case 'min':
      return nums.length === 0 ? 0 : Math.min(...nums);
    case 'max':
      return nums.length === 0 ? 0 : Math.max(...nums);
    case 'floor':
      return Math.floor(nums[0] ?? 0);
    case 'ceil':
      return Math.ceil(nums[0] ?? 0);
    case 'abs':
      return Math.abs(nums[0] ?? 0);
    case 'percent': {
      // percent(a, b) = a * b / 100
      const a = nums[0] ?? 0;
      const b = nums[1] ?? 0;
      return (a * b) / 100;
    }
    case 'has': {
      const list = args[0];
      if (Array.isArray(list)) {
        return list.some((x) => String(x) === String(args[1]));
      }
      return args[1] === undefined ? false : String(list ?? '').includes(String(args[1]));
    }
    default:
      throw new ExprEvalError(fn, `未知内建函数「${fn}」`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 主求值
// ──────────────────────────────────────────────────────────────────────────────

function evalNode(ast: ExprAst, ctx: WindowKeyWide): ExprValue {
  switch (ast.t) {
    case 'num':
      return ast.v;
    case 'str':
      return ast.v;
    case 'bool':
      return ast.v;
    case 'null':
      return null;
    case 'path':
      return resolvePath(ctx, ast.segments);
    case 'call': {
      const args = ast.args.map((a) => evalNode(a, ctx));
      return builtinFn(ast.fn, args);
    }
    case 'unary': {
      const v = evalNode(ast.operand, ctx);
      if (ast.op === '!') return !truthy(v);
      return -toNumber(v);
    }
    case 'bin': {
      return evalBin(ast, ctx);
    }
  }
}

type WindowKeyWide = WindowCtx<WindowKey>;

function evalBin(ast: Extract<ExprAst, { t: 'bin' }>, ctx: WindowKeyWide): ExprValue {
  const { op, l, r } = ast;
  // 短路
  if (op === '&&') {
    const lv = evalNode(l, ctx);
    return truthy(lv) && truthy(evalNode(r, ctx));
  }
  if (op === '||') {
    const lv = evalNode(l, ctx);
    return truthy(lv) || truthy(evalNode(r, ctx));
  }

  const lv = evalNode(l, ctx);
  const rv = evalNode(r, ctx);

  switch (op) {
    case '==':
      return looseEqual(lv, rv);
    case '!=':
      return !looseEqual(lv, rv);
    case '<':
      return toNumber(lv) < toNumber(rv);
    case '<=':
      return toNumber(lv) <= toNumber(rv);
    case '>':
      return toNumber(lv) > toNumber(rv);
    case '>=':
      return toNumber(lv) >= toNumber(rv);
    case '+':
      return toNumber(lv) + toNumber(rv);
    case '-':
      return toNumber(lv) - toNumber(rv);
    case '*':
      return toNumber(lv) * toNumber(rv);
    case '/': {
      const denom = toNumber(rv);
      // 除法零除返回 0（不抛，架构 §七 7.3）
      if (denom === 0) return 0;
      return toNumber(lv) / denom;
    }
  }
}

/** 逻辑真值判定（数字 0/false → 假；非 0 / 非空 → 真） */
function truthy(v: ExprValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * 解释执行表达式 AST。
 *
 * @param ast parser 产出的 AST
 * @param ctx 窗口分型的上下文（WindowCtxMap[window]）
 * @returns number | string | boolean
 * @throws ExprEvalError 路径未定义或类型不可算（该 automaton 整批 reject）
 */
export function evaluate<K extends WindowKey>(
  ast: ExprAst,
  ctx: WindowCtx<K>,
): number | string | boolean {
  const v = evalNode(ast, ctx as WindowKeyWide);
  // 归一：null → 0（表达式约定返回值是 number | string | boolean）
  if (v === null) return 0;
  return v as number | string | boolean;
}
