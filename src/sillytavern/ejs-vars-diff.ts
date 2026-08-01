/**
 * ejs-vars-diff.ts — EJS `vars` 草稿差量计算 (工坊 Phase 2, ADR-30 / 设计 D5)
 *
 * 为什么存在: 装配 pass 开始时 `vars = deepClone(variables.sys)`，条目按序在
 * 这棵草稿上任意读写。回合结算时需要把「回合开始的克隆」与「最终草稿」的差别
 * 变成变量补丁，经**现有**写入入口落库 —— 不开第二条写路径（ADR-21）。
 *
 * 归因说明: 草稿是普通对象，深 diff **无法归因**「哪本书写了哪条路径」
 * （要归因得上 Proxy 全程拦截，不值得）。因此提交权是 pass 粒度不是书粒度。
 *
 * 输出形状: `{ replace, remove }` —— 与 `var-resolver.ts` 的
 * `applyVarsPatch(variables, patch)` 参数结构兼容，可直接消费；路径一律带
 * `sys.` 命名空间前缀（`EJS_VARS_PATH_PREFIX`）。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue。只依赖 JSON / TextEncoder。
 *
 * 🔴 已知限制（刻意不做）:
 * - 路径按 `.` 拼接。**键名自身含 `.`** 时（如 `vars['a.b']`）产出的路径与
 *   嵌套路径不可区分 —— 这是全项目变量路径的既有口径（`parseVarPath` 同样
 *   按 `.` 切分），本模块不额外发明转义。
 * - 数组按值整体替换，不做数组内细粒度 diff（语料写数组都是整根赋值）。
 * - 非纯对象的宿主对象（Date / Map / class 实例）按引用比较、按引用拷贝 ——
 *   `vars` 契约是 JSON-ish 数据，出现这类值本身即越界。
 */

// ═══════════════════════════════════════════════════════════
// 类型与常量
// ═══════════════════════════════════════════════════════════

/** 变量路径前缀 —— `vars` 草稿持久位置是 `SaveProfile.variables.sys` */
export const EJS_VARS_PATH_PREFIX = 'sys';

/**
 * EJS 差量体积上限（字节，序列化后）。
 *
 * 超限**整份拒绝**，不截断不部分提交 —— 截断状态机的半棵写入比冻结它更糟（D5）。
 * 初值 256 KB，实测后可调。AI 补丁不受此护栏影响。
 */
export const EJS_DIFF_SIZE_LIMIT = 256 * 1024;

/**
 * 🔒 危险路径段 —— 原型污染防御。
 *
 * 与 `var-resolver.ts` 的 `DANGEROUS_PATH_SEGMENTS` 同口径（那边是路径切分后
 * 拦截，这边是遍历时剔键）。base / draft **两侧都跳**：既不产出针对危险键的
 * set，也不产出针对它的 del。
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** 深 diff 产物 —— 结构上与 var-resolver 的 applyVarsPatch 入参兼容 */
export interface EjsVarsDiff {
  /** 新增/修改 → 按路径整体覆盖（值为 draft 侧深拷贝） */
  replace: Array<{ path: string; value: unknown }>;
  /** base 有 draft 无 → 删除该路径 */
  remove: Array<{ path: string }>;
}

// ═══════════════════════════════════════════════════════════
// 纯函数工具
// ═══════════════════════════════════════════════════════════

/** 纯对象判定（排除 null / 数组 / Date 等宿主对象） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** 自有可枚举键，剔除危险键与值为 undefined 的键（undefined 视同不存在） */
function safeKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((k) => !DANGEROUS_KEYS.has(k) && obj[k] !== undefined);
}

/** 该键在对象上是否"存在"（自有 + 非危险 + 值非 undefined） */
function hasSafeKey(obj: Record<string, unknown>, key: string): boolean {
  if (DANGEROUS_KEYS.has(key)) return false;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  return obj[key] !== undefined;
}

/**
 * 深相等。
 *
 * - NaN 与 NaN 视为相等（`===` 不满足，单独兜住）
 * - 数组：长度 + 逐元素深相等
 * - 纯对象：安全键集合相同 + 逐值深相等
 * - 其余（含宿主对象）：引用/值相等
 */
export function deepEqualVars(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqualVars(item, b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = safeKeys(a);
    const kb = safeKeys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => hasSafeKey(b, k) && deepEqualVars(a[k], b[k]));
  }

  return false;
}

/** 深拷贝（剔除危险键与 undefined 值；宿主对象按引用带过） */
function deepCloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepCloneValue(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of safeKeys(value)) {
      out[key] = deepCloneValue(value[key]);
    }
    return out;
  }
  return value;
}

// ═══════════════════════════════════════════════════════════
// 主 API
// ═══════════════════════════════════════════════════════════

function walk(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  prefix: string,
  out: EjsVarsDiff,
): void {
  // 新增 / 修改
  for (const key of safeKeys(draft)) {
    const path = `${prefix}.${key}`;
    const draftValue = draft[key];
    const inBase = hasSafeKey(base, key);
    const baseValue = inBase ? base[key] : undefined;

    if (inBase && isPlainObject(baseValue) && isPlainObject(draftValue)) {
      // 两侧都是纯对象 → 下钻，让删除也能落到嵌套路径
      walk(baseValue, draftValue, path, out);
      continue;
    }

    // 类型变化（对象 vs 非对象 / 数组 vs 对象…）与值变化，一律整体替换
    if (!inBase || !deepEqualVars(baseValue, draftValue)) {
      out.replace.push({ path, value: deepCloneValue(draftValue) });
    }
  }

  // 删除：base 有 draft 无
  for (const key of safeKeys(base)) {
    if (!hasSafeKey(draft, key)) {
      out.remove.push({ path: `${prefix}.${key}` });
    }
  }
}

/**
 * 深比较「回合开始的 `variables.sys` 克隆」与「EJS 求值后的最终草稿」。
 *
 * @param base  回合开始时的 sys 克隆
 * @param draft pass 结束时的最终草稿
 * @returns 路径带 `sys.` 前缀的 set/del 补丁（可直接喂 var-resolver 的 applyVarsPatch）
 */
export function diffVars(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): EjsVarsDiff {
  const out: EjsVarsDiff = { replace: [], remove: [] };
  walk(base ?? {}, draft ?? {}, EJS_VARS_PATH_PREFIX, out);
  return out;
}

/**
 * 差量体积（JSON 序列化后的 UTF-8 字节数）。
 *
 * 无法序列化（循环引用等）时返回 `Number.POSITIVE_INFINITY` —— 必然超限，
 * 由调用方按"整份拒绝"处理，绝不半份落库。
 */
export function measureDiffSize(diff: EjsVarsDiff): number {
  let json: string;
  try {
    json = JSON.stringify(diff);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
}
