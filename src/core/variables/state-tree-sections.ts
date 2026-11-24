/**
 * 状态树缓存分区（状态树协议 T4，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §3.4）
 *
 * 把 `buildStateTree` 的产物按固定切点切成 `{路径: 值}`，供缓存直出（T9a）与 Agent 模式 Delta 会话（T16）
 * 共用。分区键就是树路径，值整块替换该路径。
 *
 * 切点（§3.4）：
 * - `/世界`、`/命运点数`、`/新闻`、`/变量`
 * - `/任务列表/<任务名>`
 * - `/主角/<子键>`、`/关系列表/<人物名>/<子键>`：全量人物节点的每个直接子键（含 `背包` / `装备`）
 * - `/关系列表/<人物名>`：摘要角色整块
 *
 * 路径段按 JSON Pointer 规则转义（`~` → `~0`，`/` → `~1`），名字里带斜杠也不会切错。
 * 不变式（闸门测试钉住）：分区互不重叠；`joinStateTreeSections(split(tree))` 深等于原树；
 * 同一棵树两次 `serializeStateTreeValue` 字节相同。
 */

import { isStateTreePersonSummary } from './state-tree-projection';
import type { StateTreeObject, StateTreeValue } from './state-tree-projection';

/** 分区：路径 → 该路径下的整块值。 */
export type StateTreeSections = Record<string, StateTreeValue>;

/** 按名字作键、逐条成为分区的根字典。 */
const RECORD_ROOT_KEYS = ['任务列表', '关系列表'] as const;

const PLAYER_KEY = '主角';
const RELATION_KEY = '关系列表';

// ========== 路径 ==========

/** 路径段转义（JSON Pointer，RFC 6901）。 */
export function escapeStateTreeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 路径段反转义。 */
function unescapeStateTreeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 段数组 → `/a/b/c`。 */
export function joinStateTreePath(segments: readonly string[]): string {
  return segments.map((s) => '/' + escapeStateTreeSegment(s)).join('');
}

/** `/a/b/c` → 段数组（只认以 `/` 开头的路径）。 */
export function splitStateTreePath(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`状态树路径必须以 / 开头：${path}`);
  return path.slice(1).split('/').map(unescapeStateTreeSegment);
}

// ========== 切分 ==========

function isObject(value: StateTreeValue | undefined): value is StateTreeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function setEntry(target: StateTreeObject, key: string, value: StateTreeValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** 全量人物节点：每个直接子键一个分区。 */
function splitPerson(out: StateTreeSections, prefix: readonly string[], node: StateTreeObject) {
  for (const [key, value] of Object.entries(node)) {
    out[joinStateTreePath([...prefix, key])] = value;
  }
}

/**
 * 状态树 → 分区（§3.4 切点）。不认识的根键整块成一个分区（向前兼容，保证合起来仍等于整树）。
 * 输出键序确定：按树的根键顺序，字典按条目顺序。
 */
export function splitStateTreeSections(tree: StateTreeObject): StateTreeSections {
  const out: StateTreeSections = {};
  for (const [rootKey, value] of Object.entries(tree)) {
    if (rootKey === PLAYER_KEY && isObject(value)) {
      splitPerson(out, [PLAYER_KEY], value);
      continue;
    }
    if ((RECORD_ROOT_KEYS as readonly string[]).includes(rootKey) && isObject(value)) {
      for (const [name, entry] of Object.entries(value)) {
        if (rootKey === RELATION_KEY && isObject(entry) && !isStateTreePersonSummary(entry)) {
          splitPerson(out, [RELATION_KEY, name], entry);
        } else {
          out[joinStateTreePath([rootKey, name])] = entry;
        }
      }
      continue;
    }
    // 世界 / 命运点数 / 新闻 / 变量，以及将来新增的根键
    out[joinStateTreePath([rootKey])] = value;
  }
  return out;
}

/**
 * 分区 → 状态树（`splitStateTreeSections` 的逆）。两个根字典（任务列表 / 关系列表）恒建出来，
 * 与 `buildStateTree` 的「恒出现」约定一致。路径重叠（某分区是另一分区的前缀）直接抛错。
 */
export function joinStateTreeSections(sections: StateTreeSections): StateTreeObject {
  const overlap = findOverlappingSections(Object.keys(sections));
  if (overlap) throw new Error(`状态树分区重叠：${overlap[0]} 与 ${overlap[1]}`);

  const tree: StateTreeObject = {};
  for (const key of RECORD_ROOT_KEYS) setEntry(tree, key, {});
  for (const [path, value] of Object.entries(sections)) {
    const segments = splitStateTreePath(path);
    let cursor = tree;
    for (const seg of segments.slice(0, -1)) {
      if (!hasOwn(cursor, seg)) setEntry(cursor, seg, {});
      cursor = cursor[seg] as StateTreeObject;
    }
    // 无重叠保证这里只会覆盖预建的根字典空壳
    setEntry(cursor, segments[segments.length - 1], value);
  }
  return tree;
}

/**
 * 找出第一对重叠的分区路径（一条是另一条按段的前缀，或两条相同）；没有则返回 null。
 * 闸门测试与 `joinStateTreeSections` 共用。
 */
export function findOverlappingSections(paths: readonly string[]): [string, string] | null {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) return [path, path];
    seen.add(path);
  }
  for (const path of paths) {
    // 逐个检查按段的真前缀（不能靠排序后相邻比较：`/a!b` 会插在 `/a` 与 `/a/c` 之间）
    let idx = path.indexOf('/', 1);
    while (idx !== -1) {
      const prefix = path.slice(0, idx);
      if (seen.has(prefix)) return [prefix, path];
      idx = path.indexOf('/', idx + 1);
    }
  }
  return null;
}

// ========== 确定性序列化 ==========

function sortKeysDeep(value: StateTreeValue): StateTreeValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isObject(value)) return value;
  const out: StateTreeObject = {};
  for (const key of Object.keys(value).sort()) setEntry(out, key, sortKeysDeep(value[key]));
  return out;
}

/** 确定性序列化：对象键按码点升序递归排序，数组保持顺序。同一值两次序列化字节相同。 */
export function serializeStateTreeValue(value: StateTreeValue): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** 分区逐块确定性序列化（`{路径: 序列化串}`，路径按码点升序）。 */
export function serializeStateTreeSections(sections: StateTreeSections): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(sections).sort()) {
    out[path] = serializeStateTreeValue(sections[path]);
  }
  return out;
}
