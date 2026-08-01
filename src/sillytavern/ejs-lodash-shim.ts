/**
 * ejs-lodash-shim.ts — 世界书 EJS 沙盒里 `_` 的自研实现（工坊 Phase 2 / D5）
 *
 * 为什么自研而不引 lodash：语料实测 EJS 块内只用到 **纯读边** 的 17 个方法
 * （`get/trim/isArray/isObject/isEmpty/isObjectLike/mapValues/find/flatMap/
 *   pick/pickBy/values/keys/has/uniq/keyBy/chain`），大半十行内可实现，
 * 为 ~50 次调用引整包不成比例（设计 D5）。
 *
 * 语义对齐 lodash 文档，但**刻意保留的简化**（不追求逐位复刻）：
 * - `toPath` 只支持 `a.b[0].c` / `a["b"]` 两种常见括号形态
 * - iteratee 的 `_.matches` 简写用浅 `===` 比较（lodash 是深偏序比较）
 * - `pick` 支持深路径，但结果对象按路径重建（与 lodash 一致）
 * - 不支持 lodash 的 guard 参数（`_.map(x, fn, guard)` 那套内部约定）
 *
 * 本模块**只读不写调用方对象**（`pick/pickBy/mapValues` 等一律产出新对象）。
 */

/** 原型污染防御：与 var-resolver.ts 同口径 */
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

// ========== 内部工具 ==========

/** lodash `_.toPath`：`'a.b[0].c'` → `['a','b','0','c']` */
export function toPath(path: string | number | Array<string | number>): string[] {
  if (Array.isArray(path)) return path.map((p) => String(p));
  if (path === null || path === undefined) return [];
  const raw = String(path);
  if (!raw) return [];
  return raw
    .replace(/\[(-?\d+)\]/g, '.$1')
    .replace(/\[["']([^"']*)["']\]/g, '.$1')
    .split('.')
    .filter((p) => p.length > 0);
}

/** 沿 parts 逐层写入，中间节点缺失自动建对象；命中危险段整次放弃 */
function setDeep(target: Record<string, any>, parts: string[], value: any): void {
  if (parts.length === 0) return;
  if (parts.some((p) => DANGEROUS_PATH_SEGMENTS.has(p))) return;
  let cur: any = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 把 iteratee 简写（函数 / 属性名 / [路径,值] / 部分对象 / 省略）统一成函数 */
function toIteratee(it: any): (value: any, key?: any, collection?: any) => any {
  if (it === null || it === undefined) return (v: any) => v;
  if (typeof it === 'function') return it as (value: any, key?: any, collection?: any) => any;
  if (typeof it === 'string' || typeof it === 'number') return (v: any) => get(v, String(it));
  if (Array.isArray(it) && it.length === 2) {
    const [p, expected] = it;
    return (v: any) => get(v, p) === expected;
  }
  if (typeof it === 'object') {
    const src = it as Record<string, any>;
    return (v: any) => Object.keys(src).every((k) => get(v, k) === src[k]);
  }
  return (v: any) => v;
}

/** 把集合（数组/字符串/对象）铺成 [key, value] 序列 */
function entriesOf(collection: any): Array<[any, any]> {
  if (collection === null || collection === undefined) return [];
  if (Array.isArray(collection)) return collection.map((v, i) => [i, v] as [any, any]);
  if (typeof collection === 'string')
    return Array.from(collection).map((v, i) => [i, v] as [any, any]);
  if (typeof collection === 'object')
    return Object.keys(collection).map((k) => [k, (collection as any)[k]] as [any, any]);
  return [];
}

// ========== 公开方法（17 个） ==========

/** `_.get(object, path, [defaultValue])` */
export function get(
  object: any,
  path: string | number | Array<string | number>,
  defaultValue?: any,
): any {
  const parts = toPath(path);
  if (parts.length === 0) return defaultValue;
  let cur: any = object;
  for (const p of parts) {
    if (cur === null || cur === undefined) return defaultValue;
    cur = cur[p];
  }
  return cur === undefined ? defaultValue : cur;
}

/** `_.trim(string, [chars])` */
export function trim(value?: any, chars?: string): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (chars === undefined || chars === null) return s.trim();
  const set = new Set(String(chars).split(''));
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}

/** `_.isArray(value)` */
export function isArray(value: any): boolean {
  return Array.isArray(value);
}

/** `_.isObject(value)` — 含函数、数组、正则；不含 null */
export function isObject(value: any): boolean {
  const t = typeof value;
  return value !== null && (t === 'object' || t === 'function');
}

/** `_.isObjectLike(value)` — `typeof === 'object'` 且非 null（函数返回 false） */
export function isObjectLike(value: any): boolean {
  return typeof value === 'object' && value !== null;
}

/** `_.isEmpty(value)` */
export function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) || typeof value === 'string') return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return true;
}

/** `_.mapValues(object, [iteratee])` */
export function mapValues(object: any, iteratee?: any): Record<string, any> {
  const fn = toIteratee(iteratee);
  const out: Record<string, any> = {};
  if (object === null || object === undefined || typeof object !== 'object') return out;
  for (const k of Object.keys(object)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = fn((object as any)[k], k, object);
  }
  return out;
}

/** `_.find(collection, [predicate], [fromIndex])` */
export function find(collection: any, predicate?: any, fromIndex = 0): any {
  const fn = toIteratee(predicate);
  const entries = entriesOf(collection);
  const isIndexed = Array.isArray(collection) || typeof collection === 'string';
  let start = 0;
  if (isIndexed && fromIndex) {
    start = fromIndex < 0 ? Math.max(entries.length + fromIndex, 0) : fromIndex;
  }
  for (let i = start; i < entries.length; i++) {
    const [k, v] = entries[i];
    if (fn(v, k, collection)) return v;
  }
  return undefined;
}

/** `_.flatMap(collection, [iteratee])` — 映射后展平一层 */
export function flatMap(collection: any, iteratee?: any): any[] {
  const fn = toIteratee(iteratee);
  const out: any[] = [];
  for (const [k, v] of entriesOf(collection)) {
    const mapped = fn(v, k, collection);
    if (Array.isArray(mapped)) out.push(...mapped);
    else out.push(mapped);
  }
  return out;
}

/** `_.pick(object, [paths])` — 支持深路径，结果按路径重建 */
export function pick(object: any, ...paths: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (object === null || object === undefined) return out;
  const list: any[] = [];
  for (const p of paths) {
    if (Array.isArray(p)) list.push(...p);
    else list.push(p);
  }
  for (const p of list) {
    const parts = toPath(p);
    if (parts.length === 0) continue;
    if (!has(object, parts)) continue;
    setDeep(out, parts, get(object, parts));
  }
  return out;
}

/** `_.pickBy(object, [predicate])` — 默认按值真假筛选 */
export function pickBy(object: any, predicate?: any): Record<string, any> {
  const fn = toIteratee(predicate);
  const out: Record<string, any> = {};
  if (object === null || object === undefined || typeof object !== 'object') return out;
  for (const k of Object.keys(object)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    const v = (object as any)[k];
    if (fn(v, k, object)) out[k] = v;
  }
  return out;
}

/** `_.values(object)` */
export function values(object: any): any[] {
  if (object === null || object === undefined) return [];
  if (Array.isArray(object)) return object.slice();
  if (typeof object === 'string') return Array.from(object);
  if (typeof object !== 'object') return [];
  return Object.keys(object).map((k) => (object as any)[k]);
}

/** `_.keys(object)` — 数组/字符串返回下标串 */
export function keys(object: any): string[] {
  if (object === null || object === undefined) return [];
  if (typeof object === 'string') return Array.from(object).map((_v, i) => String(i));
  if (typeof object !== 'object') return [];
  return Object.keys(object);
}

/** `_.has(object, path)` — 逐层 own property 检查 */
export function has(object: any, path: string | number | Array<string | number>): boolean {
  const parts = toPath(path);
  if (parts.length === 0) return false;
  let cur: any = object;
  for (const p of parts) {
    if (cur === null || cur === undefined) return false;
    if (!Object.prototype.hasOwnProperty.call(Object(cur), p)) return false;
    cur = cur[p];
  }
  return true;
}

/** `_.uniq(array)` — SameValueZero 去重 */
export function uniq(array: any): any[] {
  if (!Array.isArray(array)) return [];
  return Array.from(new Set(array));
}

/** `_.keyBy(collection, [iteratee])` */
export function keyBy(collection: any, iteratee?: any): Record<string, any> {
  const fn = toIteratee(iteratee);
  const out: Record<string, any> = {};
  for (const [k, v] of entriesOf(collection)) {
    const key = String(fn(v, k, collection));
    if (DANGEROUS_PATH_SEGMENTS.has(key)) continue;
    out[key] = v;
  }
  return out;
}

// ========== T5 补齐（能力面 §3.13：17 → 26 方法）==========
//
// 真机语料实测用到 24 个 lodash 方法，旧 shim 只有 17 个 —— 缺的那几个让
// `月历球` / `资产管理` / `言灵` 等条目在 `_.cloneDeep is not a function` 上整条回退。
// 补的**全部是读边**：`_.set` / `_.assign` / `_.merge` 这类写方法**永不提供**
//（1524 个 EJS 块里出现 0 次；散文里那些是教 AI 写 vars_update 的示例 DSL，与 EJS 无关）。

/** 纯对象判定（排除数组与宿主对象） */
export function isPlainObject(value: any): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isNumber(value: any): boolean {
  return typeof value === 'number';
}

export function isString(value: any): boolean {
  return typeof value === 'string';
}

export function isFunction(value: any): boolean {
  return typeof value === 'function';
}

/** 集合长度：数组/字符串取 length，对象取自有键数，其余 0 */
export function size(value: any): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value) || typeof value === 'string') return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/**
 * 深拷贝（纯数据面）。
 * 危险键就地剔除 —— 拷贝是把数据送进创作者手里，不该顺手把原型污染载体也送过去。
 * 环用 seen 表兜住（`vars` 是共写草稿，自引用完全可能）。
 */
export function cloneDeep<T>(value: T, seen?: WeakMap<object, any>): T {
  if (value === null || typeof value !== 'object') return value;
  const node = value as unknown as object;
  const map = seen ?? new WeakMap<object, any>();
  if (map.has(node)) return map.get(node) as T;
  if (Array.isArray(value)) {
    const arr: any[] = [];
    map.set(node, arr);
    for (const v of value) arr.push(cloneDeep(v, map));
    return arr as unknown as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, any> = {};
  map.set(node, out);
  for (const k of Object.keys(value as Record<string, any>)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = cloneDeep((value as Record<string, any>)[k], map);
  }
  return out as unknown as T;
}

/** 剔除指定键（`pick` 的反面） */
export function omit(object: any, ...paths: any[]): Record<string, any> {
  const drop = new Set(paths.flat().map((p) => String(p)));
  const out: Record<string, any> = {};
  if (object === null || typeof object !== 'object') return out;
  for (const k of Object.keys(object)) {
    if (drop.has(k) || DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = object[k];
  }
  return out;
}

/** 按 iteratee 重映射键（值不动） */
export function mapKeys(object: any, iteratee?: any): Record<string, any> {
  const fn = toIteratee(iteratee);
  const out: Record<string, any> = {};
  for (const [k, v] of entriesOf(object)) {
    const key = String(fn(v, k, object));
    if (DANGEROUS_PATH_SEGMENTS.has(key)) continue;
    out[key] = v;
  }
  return out;
}

/** 遍历自有键值；回调返回 `false` 提前中断（对齐 lodash） */
export function forOwn(object: any, iteratee?: any): any {
  const fn = toIteratee(iteratee);
  for (const [k, v] of entriesOf(object)) {
    if (fn(v, k, object) === false) break;
  }
  return object;
}

/**
 * `_.random(min, max)` / `_.sample(list)`。
 *
 * ⚠️ 用 `Math.random`，**不可复现**。创作者要快照可复现请用 `rng.int` / `rng.pick`
 *（能力面 §7）。这里保持上游语义是为了存量内容不炸，不是推荐写法。
 */
export function random(min?: any, max?: any): number {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo)) return Math.random() < 0.5 ? 0 : 1;
  if (!Number.isFinite(hi)) {
    hi = lo;
    lo = 0;
  }
  if (hi < lo) [lo, hi] = [hi, lo];
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

export function sample<T>(collection: T[]): T | undefined {
  if (!Array.isArray(collection) || collection.length === 0) return undefined;
  return collection[Math.floor(Math.random() * collection.length)];
}

// ========== chain ==========

/** 可链式调用的方法表（全部形如 `fn(value, ...args)`） */
const CHAIN_METHODS: Record<string, (value: any, ...args: any[]) => any> = {
  get: (v, ...a) => get(v, a[0], a[1]),
  trim: (v, ...a) => trim(v, a[0]),
  isArray: (v) => isArray(v),
  isObject: (v) => isObject(v),
  isObjectLike: (v) => isObjectLike(v),
  isEmpty: (v) => isEmpty(v),
  mapValues: (v, ...a) => mapValues(v, a[0]),
  find: (v, ...a) => find(v, a[0], a[1]),
  flatMap: (v, ...a) => flatMap(v, a[0]),
  pick: (v, ...a) => pick(v, ...a),
  pickBy: (v, ...a) => pickBy(v, a[0]),
  values: (v) => values(v),
  keys: (v) => keys(v),
  has: (v, ...a) => has(v, a[0]),
  uniq: (v) => uniq(v),
  keyBy: (v, ...a) => keyBy(v, a[0]),
};

/** `_.chain()` 的惰性壳：每次调用即时求值并重新包裹，`.value()` 取出 */
export interface EjsLodashChain {
  /** 取出当前链上的值 */
  value(): any;
  [method: string]: (...args: any[]) => any;
}

/** `_.chain(value)` — 仅支持 CHAIN_METHODS 里的方法 + `.value()` */
export function chain(value: any): EjsLodashChain {
  const wrap = (v: any): EjsLodashChain => {
    const w: Record<string, (...args: any[]) => any> = {
      value: () => v,
    };
    for (const name of Object.keys(CHAIN_METHODS)) {
      w[name] = (...args: any[]) => wrap(CHAIN_METHODS[name](v, ...args));
    }
    return w as EjsLodashChain;
  };
  return wrap(value);
}

// ========== 注入面 ==========

/** 注入到 EJS 沙盒里的 `_` 对象 */
export const ejsLodash = {
  get,
  trim,
  isArray,
  isObject,
  isObjectLike,
  isEmpty,
  mapValues,
  find,
  flatMap,
  pick,
  pickBy,
  values,
  keys,
  has,
  uniq,
  keyBy,
  chain,
  toPath,
  // T5 补齐（能力面 §3.13：17 → 27 方法，**全部读边**）
  isPlainObject,
  isNumber,
  isString,
  isFunction,
  size,
  cloneDeep,
  omit,
  mapKeys,
  forOwn,
  random,
  sample,
} as const;

export type EjsLodash = typeof ejsLodash;
