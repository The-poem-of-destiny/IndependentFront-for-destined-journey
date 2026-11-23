/**
 * 状态树补丁的区块解析与路径解析（状态树协议 T5，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §4、§5.1、§5.4）
 *
 * 两步，都是纯函数（无 I/O、无时钟、无随机）：
 *
 * 1. `parseTreePatchBlock`：`<direct_updates>` 区块文本（或已 parse 的对象）→ 规范化的 op 列表。
 *    - 整段 `JSON.parse` 失败时**逐元素恢复**：在 `patch` 数组里按花括号配对抠出每个对象单独解析，
 *      坏的丢掉并记原因；截断的最后一条丢掉，前半段保住；坏对象内部还能找到含 `"op"` 的完整对象时一并救回。
 *    - op 别名、缺 op、三种路径写法与 `stat_data` 前缀在这里纠正，每处记一条 `normalized`。
 *    - 旧形状（有 `state` / `entities` / `effects` 而无 `patch`）返回 `kind: 'legacy'`，由上层走旧解析器（§2）。
 *    - 任何层级出现原型污染键（含路径段）返回 `kind: 'rejected'`，整楼拒收（§5.4）。
 * 2. `resolveTreePath`：规范化后的段 → 结构化目标（根、人物正名、所在 Record 条目、叶子 spec、是否只读）。
 *    对的是完整内核状态（§3.4「路径解析对的是完整内核状态」），不是投影出来的那部分。
 *
 * 🔴 本模块**不**纠正值、**不**产 StatePatch —— 那是翻译层（T6）的事。名字段解析复用
 *    `state/patch-rules.ts` 的 `resolveCharacterByName`，不另写一份；不做模糊匹配。
 */

import { resolveCharacterByName } from '../state/patch-rules';
import type { CharacterState, SaveProfile } from '../types/types';
import { extractJsonPayload } from '../utils/model-json';
import { joinStateTreePath, splitStateTreePath } from './state-tree-sections';
import {
  PERSON_NODE_CHILDREN,
  STATE_TREE_FORBIDDEN_KEYS,
  STATE_TREE_PATCH_OPS,
  STATE_TREE_SPEC,
  findChildSpec,
  isReadonlyKey,
  stripReadonlyPrefix,
  type StateTreeBranchSpec,
  type StateTreeLeafKind,
  type StateTreeNodeSpec,
  type StateTreePatchOp,
  type StateTreeRecordSpec,
} from './state-tree-spec';

// ========== 类型：区块解析 ==========

/** 规范 op 集合（§4.3）；合法 op 的唯一真源是 `variables/state-tree-spec.ts` 的 `STATE_TREE_PATCH_OPS`。 */
export type TreeOpKind = StateTreePatchOp;

/** 路径写法：`/a/b`（JSON Pointer）、`a.b`（点号，可带 `["…"]` 段）、段数组。 */
export type TreePathStyle = 'pointer' | 'dot' | 'array';

/** 规范化后的一条 op（尚未解析路径、尚未纠正值）。 */
export interface TreeOp {
  /** 在 patch 数组里的序号（从 0 起；逐元素恢复时按恢复顺序编号，坏元素也占号）。 */
  readonly index: number;
  readonly op: TreeOpKind;
  /** 模型原文路径（数组写法记成 JSON 文本），给「模型原文路径：原因，已忽略」用。 */
  readonly path: string;
  /** 规范化后的段（已去 `stat_data` 前缀、已解 `~1` / `~0`），名字段未解析。 */
  readonly segments: readonly string[];
  readonly pathStyle: TreePathStyle;
  /** 仅 move：模型原文的 from。 */
  readonly from?: string;
  readonly fromSegments?: readonly string[];
  readonly fromStyle?: TreePathStyle;
  /** 原样的 value（未纠正）；`hasValue` 区分「没写」与「写了 null」。 */
  readonly value?: unknown;
  readonly hasValue: boolean;
}

/** 一条丢弃或纠正说明。`index` 为 -1 表示针对整块而非某一条。 */
export interface TreeOpIssue {
  readonly index: number;
  /** 模型原文路径；不知道时为空串。 */
  readonly path: string;
  readonly message: string;
}

/** 新形状：有 `patch`（或就是一个 op 数组）。 */
export interface TreePatchParsed {
  readonly kind: 'patch';
  readonly ops: readonly TreeOp[];
  /** 被丢弃的元素（坏 JSON、截断、缺字段、未知 op、路径写坏）。 */
  readonly dropped: readonly TreeOpIssue[];
  /** 纠正说明（op 别名、缺 op、路径写法、前缀、逐元素恢复等）。 */
  readonly normalized: readonly TreeOpIssue[];
  /** 除 `patch` 外的顶层字段（plot / diceUsed / tile_ops / combat / version …）；逐元素恢复时为 null。 */
  readonly envelope: Readonly<Record<string, unknown>> | null;
  /** 整段 JSON 解析失败、走了逐元素恢复。 */
  readonly salvaged: boolean;
  /** 区块是空文本（零 op 且不是错误）。 */
  readonly empty: boolean;
  /**
   * 整段 JSON 解析失败、走了逐元素恢复，却一条 op 都没救回 —— 上层按 §5.4 整楼拒收。
   * JSON 完好时坏 op 只丢那一条（记进 `dropped`），即使一条都不剩也不置位。
   */
  readonly nothingRecovered: boolean;
}

/** 旧形状（有 state / entities / effects 而无 patch）：交给旧解析器，记一条纠正（§2 并存期回落）。 */
interface TreePatchLegacy {
  readonly kind: 'legacy';
  /** 整段能解析时的对象；解析失败时为 null（旧解析器自己处理原文）。 */
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly note: string;
}

/** 整楼拒收（原型污染键）。 */
interface TreePatchRejected {
  readonly kind: 'rejected';
  readonly reason: string;
}

/** 不是 JSON、也找不到 patch 数组或旧形状。上层按「不是 JSON 对象」整楼拒收。 */
interface TreePatchUnparseable {
  readonly kind: 'unparseable';
  readonly reason: string;
}

export type TreePatchParseResult =
  TreePatchParsed | TreePatchLegacy | TreePatchRejected | TreePatchUnparseable;

// ========== 类型：路径解析 ==========

/** 路径的根。`/关系列表/主角` 之类解析到主角时根是 `player`。 */
type TreeRootKind =
  'world' | 'fatePoints' | 'player' | 'relation' | 'quests' | 'news' | 'variables';

/** 路径上的人物（`/主角` 或 `/关系列表/<名>`）。 */
interface TreePersonRef {
  /** 内核正名；新人物是模型写的名字。 */
  readonly name: string;
  readonly isPlayer: boolean;
  /** 快照里有没有这个人物（没有 = 按新建处理，§4.4）。 */
  readonly exists: boolean;
  readonly character?: CharacterState;
}

/** 路径经过的一个 Record 条目（外层在前，如 `关系列表` → `背包`）。 */
interface TreeEntryRef {
  /** Record 的键：`关系列表` / `背包` / `装备` / `技能` / `状态效果` / `要素` / `权能` / `法则` / `任务列表` / `新闻` / `{栏目}`。 */
  readonly record: string;
  /** Record 的规格。 */
  readonly recordSpec: StateTreeRecordSpec;
  /** 条目名（已解析为内核正名；不存在时是模型写的名字）。 */
  readonly name: string;
  readonly exists: boolean;
  /** `背包` / `装备` 条目：同名物品在内核里的实际位置（物品名在同一人物下唯一）。 */
  readonly itemLocation?: 'bag' | 'equipped';
  /** 这个条目名在规范段里的下标。 */
  readonly segmentIndex: number;
}

/** 解析成功的目标。 */
export interface ResolvedTreePath {
  readonly root: TreeRootKind;
  /** 规范段（名字段为内核正名，`/主角/地点` 已改写成 `/世界/地点`；含 `leafKey` 与变量段）。 */
  readonly segments: readonly string[];
  /** 规范段的 JSON Pointer 形式。 */
  readonly pointer: string;
  /** 规格路径模式（名字段写作 `{…}`），与 `listStateTreePaths` 的 `pattern` 一一对应。 */
  readonly pattern: string;
  /** 路径终点的节点规格（叶子 / 分支 / Record）。 */
  readonly spec: StateTreeNodeSpec;
  readonly person?: TreePersonRef;
  readonly entries: readonly TreeEntryRef[];
  /** 最内层条目（`entries` 末项）。 */
  readonly entry?: TreeEntryRef;
  /** 路径终点就是最内层条目的根（整实体写入，§4.4）。 */
  readonly isEntryRoot: boolean;
  /** 最内层条目之下、到终点的子段（如 `['耐久', '当前']`）。 */
  readonly subPath: readonly string[];
  /** 字典型叶子（效果 / 属性 / 标签）下的子键。 */
  readonly leafKey?: string;
  /** `/变量/…` 之后的段，原样保留不翻译。 */
  readonly variablePath?: readonly string[];
  readonly readonly: boolean;
  /** 只读原因（「由代码维护」；主角等级附「请改累计经验值」）。 */
  readonly readonlyReason?: string;
}

type TreePathErrorCode =
  /** 树外路径 */
  | 'outside'
  /** 写法不合法（空路径、变量段含 `.`） */
  | 'invalid'
  /** 别名不唯一 */
  | 'ambiguous'
  /** 存档里没有主角 */
  | 'noPlayer'
  /** 原型污染键（整楼拒收） */
  | 'polluted';

export type TreePathResolution =
  | { readonly ok: true; readonly target: ResolvedTreePath; readonly notes: readonly string[] }
  | { readonly ok: false; readonly code: TreePathErrorCode; readonly reason: string };

/** 路径解析所需的状态快照（完整内核状态，不是投影）。 */
export interface TreePathSnapshot {
  readonly characters: readonly CharacterState[];
  readonly profile?: Readonly<Partial<Pick<SaveProfile, 'quests' | 'news'>>> | null;
}

// ========== 常量 ==========

/** op 别名 → 规范 op（§4.3）；规范 op 自身取自 `STATE_TREE_PATCH_OPS`。 */
const OP_ALIASES: Readonly<Record<string, TreeOpKind>> = {
  ...(Object.fromEntries(STATE_TREE_PATCH_OPS.map((op) => [op, op])) as Record<string, TreeOpKind>),
  set: 'replace',
  update: 'replace',
  assign: 'replace',
  insert: 'add',
  push: 'add',
  append: 'add',
  delete: 'remove',
  unset: 'remove',
  inc: 'delta',
  increment: 'delta',
};

/** 旧协议的顶层字段（§2）。 */
const LEGACY_KEYS = ['state', 'entities', 'effects'] as const;

const FORBIDDEN = new Set<string>(STATE_TREE_FORBIDDEN_KEYS);

/** 可以再下一段子键的叶子类型。 */
const KEYED_LEAVES: ReadonlySet<StateTreeLeafKind> = new Set([
  'effectDict',
  'numberDict',
  'textArray',
]);

const ROOT_KIND_BY_KEY: Readonly<Record<string, TreeRootKind>> = {
  世界: 'world',
  命运点数: 'fatePoints',
  主角: 'player',
  关系列表: 'relation',
  任务列表: 'quests',
  新闻: 'news',
  变量: 'variables',
};

function childOf(parent: StateTreeBranchSpec, key: string): StateTreeNodeSpec {
  const c = parent.children.find((n) => n.key === key);
  if (!c) throw new Error(`状态树词表缺键 ${key}`);
  return c;
}

const WORLD_SPEC = childOf(STATE_TREE_SPEC, '世界') as StateTreeBranchSpec;
const PLAYER_SPEC = childOf(STATE_TREE_SPEC, '主角') as StateTreeBranchSpec;
const RELATION_SPEC = childOf(STATE_TREE_SPEC, '关系列表') as StateTreeRecordSpec;

const READONLY_REASON = '由代码维护';
const PLAYER_LEVEL_REASON = '由代码维护（主角等级由累计经验值推导），请改累计经验值';

// ========== 原型污染 ==========

/** 深扫对象 / 数组的键，找到原型污染键就返回它；没有返回 null。 */
function findPrototypePollutionKey(value: unknown, depth = 0): string | null {
  if (depth > 64 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findPrototypePollutionKey(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(value)) {
    if (FORBIDDEN.has(k)) return k;
    const hit = findPrototypePollutionKey((value as Record<string, unknown>)[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function pollutedReason(key: string): string {
  return `出现原型污染键「${key}」，整楼拒收`;
}

// ========== 路径规范化 ==========

export type TreePathNormalization =
  | {
      readonly ok: true;
      readonly segments: readonly string[];
      readonly style: TreePathStyle;
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly polluted?: boolean };

/** 点号写法分词：`a.b["c.d"][0]` → `['a', 'b', 'c.d', '0']`。括号段不再按点拆。 */
function splitDotPath(text: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') {
      out.push(cur);
      cur = '';
      i++;
    } else if (ch === '[') {
      if (cur) out.push(cur);
      cur = '';
      const close = text.indexOf(']', i);
      if (close < 0) return null;
      let inner = text.slice(i + 1, close).trim();
      if (
        inner.length >= 2 &&
        (inner[0] === '"' || inner[0] === "'") &&
        inner[inner.length - 1] === inner[0]
      ) {
        inner = inner.slice(1, -1);
      }
      out.push(inner);
      i = close + 1;
      // 括号段之后可以直接跟 `.` 或 `[`
      if (text[i] === '.') i++;
    } else {
      cur += ch;
      i++;
    }
  }
  if (cur || text.endsWith('.')) out.push(cur);
  return out;
}

/**
 * 把模型写的路径规范化成段数组：接受 `/a/b`、`a.b`（含 `["…"]` 段）、段数组；去掉 `stat_data` 前缀；
 * 去掉空段。名字段不在这里解析。
 */
export function normalizeTreePath(raw: unknown): TreePathNormalization {
  const notes: string[] = [];
  let segments: string[];
  let style: TreePathStyle;

  if (Array.isArray(raw)) {
    style = 'array';
    segments = [];
    for (const s of raw) {
      if (typeof s === 'string') segments.push(s);
      else if (typeof s === 'number' && Number.isFinite(s)) segments.push(String(s));
      else return { ok: false, reason: '路径数组里有不是字符串的段' };
    }
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { ok: false, reason: '路径为空' };
    if (text.startsWith('/') || text.includes('/')) {
      style = 'pointer';
      if (!text.startsWith('/')) notes.push(`路径「${text}」缺开头的 /，已补上`);
      segments = splitStateTreePath(text.startsWith('/') ? text : `/${text}`);
    } else {
      style = 'dot';
      const parts = splitDotPath(text);
      if (!parts) return { ok: false, reason: `路径「${text}」的方括号没有闭合` };
      segments = parts;
      notes.push(`路径「${text}」按点号写法拆段`);
    }
  } else {
    return { ok: false, reason: '路径不是字符串或数组' };
  }

  segments = segments.map((s) => s.trim());
  const nonEmpty = segments.filter((s) => s !== '');
  if (nonEmpty.length !== segments.length) {
    notes.push('路径里的空段已去掉');
    segments = nonEmpty;
  }
  for (const s of segments) {
    if (FORBIDDEN.has(s)) return { ok: false, reason: pollutedReason(s), polluted: true };
  }
  if (segments[0] === 'stat_data') {
    segments = segments.slice(1);
    notes.push('去掉了路径的 stat_data 前缀');
  }
  if (segments.length === 0) return { ok: false, reason: '路径为空' };
  return { ok: true, segments, style, notes };
}

// ========== op 规范化 ==========

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rawPathText(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p === undefined) return '';
  try {
    return JSON.stringify(p) ?? '';
  } catch {
    return '';
  }
}

type ElementOutcome =
  | { kind: 'op'; op: TreeOp; notes: string[] }
  | { kind: 'drop'; path: string; reason: string }
  | { kind: 'reject'; reason: string };

/** 一个 patch 元素 → 规范 op（或丢弃原因）。 */
function normalizeElement(el: unknown, index: number): ElementOutcome {
  if (!isPlainObject(el)) return { kind: 'drop', path: '', reason: '不是对象' };
  const polluted = findPrototypePollutionKey(el);
  if (polluted) return { kind: 'reject', reason: pollutedReason(polluted) };

  const path = rawPathText(el.path);
  const notes: string[] = [];
  const hasValue = Object.prototype.hasOwnProperty.call(el, 'value');

  let op: TreeOpKind;
  if (el.op === undefined || el.op === null || el.op === '') {
    if (!hasValue) return { kind: 'drop', path, reason: '缺少 op' };
    op = 'replace';
    notes.push('缺少 op，按 replace 处理');
  } else if (typeof el.op !== 'string') {
    return { kind: 'drop', path, reason: 'op 不是字符串' };
  } else {
    const rawOp = el.op.trim();
    const mapped = OP_ALIASES[rawOp.toLowerCase()];
    if (!mapped) return { kind: 'drop', path, reason: `不支持的 op「${rawOp}」` };
    if (rawOp !== mapped) notes.push(`op「${rawOp}」按 ${mapped} 处理`);
    op = mapped;
  }

  if (el.path === undefined) return { kind: 'drop', path, reason: '缺少 path' };
  const norm = normalizeTreePath(el.path);
  if (!norm.ok) {
    if (norm.polluted) return { kind: 'reject', reason: norm.reason };
    return { kind: 'drop', path, reason: norm.reason };
  }
  notes.push(...norm.notes);

  if ((op === 'replace' || op === 'add' || op === 'delta') && !hasValue) {
    return { kind: 'drop', path, reason: `${op} 缺少 value` };
  }

  let from: string | undefined;
  let fromSegments: readonly string[] | undefined;
  let fromStyle: TreePathStyle | undefined;
  if (op === 'move') {
    if (el.from === undefined || el.from === null || el.from === '') {
      return { kind: 'drop', path, reason: 'move 缺少 from' };
    }
    const fn = normalizeTreePath(el.from);
    if (!fn.ok) {
      if (fn.polluted) return { kind: 'reject', reason: fn.reason };
      return { kind: 'drop', path, reason: `from：${fn.reason}` };
    }
    from = rawPathText(el.from);
    fromSegments = fn.segments;
    fromStyle = fn.style;
    notes.push(...fn.notes.map((n) => `from：${n}`));
  } else if (el.from !== undefined) {
    notes.push(`${op} 不用 from，已忽略`);
  }

  const result: TreeOp = {
    index,
    op,
    path,
    segments: norm.segments,
    pathStyle: norm.style,
    ...(from !== undefined ? { from, fromSegments, fromStyle } : {}),
    ...(hasValue ? { value: el.value } : {}),
    hasValue,
  };
  return { kind: 'op', op: result, notes };
}

// ========== 逐元素恢复 ==========

interface Span {
  readonly start: number;
  /** 不含 */
  readonly end: number;
  readonly closed: boolean;
}

/**
 * 在 `[from, to)` 里找顶层对象（跳过字符串里的括号）。`stopAtArrayClose` 时遇到顶层 `]` 就停。
 * 最后一个对象没闭合时以 `closed: false` 返回（截断）。
 */
function scanObjects(text: string, from: number, to: number, stopAtArrayClose: boolean): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      // 字符串只在对象内部有意义；顶层的游离引号也按字符串跳过
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0) spans.push({ start, end: i + 1, closed: true });
      }
    } else if (ch === ']' && depth === 0 && stopAtArrayClose) {
      return spans;
    }
  }
  if (depth > 0 && start >= 0) spans.push({ start, end: to, closed: false });
  return spans;
}

type SalvagedElement = { value: unknown } | { error: string };

/** 坏对象内部再找含 `"op"` 的完整对象（截断 / 少括号把后面几条吞进来的情形）。 */
function salvageNested(text: string, from: number, to: number, depth: number): unknown[] {
  if (depth > 8) return [];
  const found: unknown[] = [];
  for (const span of scanObjects(text, from, to, false)) {
    const slice = text.slice(span.start, span.end);
    if (!slice.includes('"op"')) continue;
    if (span.closed) {
      try {
        const v: unknown = JSON.parse(slice);
        if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, 'op')) {
          found.push(v);
          continue;
        }
      } catch {
        // 落到下面的再向内找
      }
    }
    found.push(...salvageNested(text, span.start + 1, span.end - (span.closed ? 1 : 0), depth + 1));
  }
  return found;
}

/** 从 `arrayStart`（`[` 之后）开始逐元素恢复。 */
function salvageArray(text: string, arrayStart: number): SalvagedElement[] {
  const out: SalvagedElement[] = [];
  for (const span of scanObjects(text, arrayStart, text.length, true)) {
    const slice = text.slice(span.start, span.end);
    if (span.closed) {
      try {
        out.push({ value: JSON.parse(slice) as unknown });
        continue;
      } catch {
        out.push({ error: '这一条 JSON 写坏了' });
      }
    } else {
      out.push({ error: '输出被截断，残缺的最后一条' });
    }
    const innerEnd = span.closed ? span.end - 1 : span.end;
    for (const v of salvageNested(text, span.start + 1, innerEnd, 0)) out.push({ value: v });
  }
  return out;
}

const FORBIDDEN_KEY_RE = new RegExp(`"(?:${STATE_TREE_FORBIDDEN_KEYS.join('|')})"\\s*:`);

// ========== 区块解析 ==========

interface Collected {
  readonly ops: TreeOp[];
  readonly dropped: TreeOpIssue[];
  readonly normalized: TreeOpIssue[];
}

/** 逐条规范化并收进 `base`；遇原型污染抛 `RejectSignal`。 */
function collect(elements: readonly SalvagedElement[], base: Collected): void {
  elements.forEach((el, index) => {
    if ('error' in el) {
      base.dropped.push({ index, path: '', message: el.error });
      return;
    }
    const r = normalizeElement(el.value, index);
    if (r.kind === 'reject') throw new RejectSignal(r.reason);
    if (r.kind === 'drop') {
      base.dropped.push({ index, path: r.path, message: r.reason });
      return;
    }
    base.ops.push(r.op);
    for (const n of r.notes) base.normalized.push({ index, path: r.op.path, message: n });
  });
}

class RejectSignal extends Error {}

function hasLegacyKeys(obj: Record<string, unknown>): string[] {
  return LEGACY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function legacyNote(keys: readonly string[]): string {
  return `区块是旧形状（${keys.join(' / ')}，无 patch），已交给旧解析器`;
}

function finish(
  c: Collected,
  envelope: Record<string, unknown> | null,
  salvaged: boolean,
): TreePatchParsed {
  return {
    kind: 'patch',
    ops: c.ops,
    dropped: c.dropped,
    normalized: c.normalized,
    envelope,
    salvaged,
    empty: false,
    // 只有走了逐元素恢复（整段 JSON 解析失败）且一条都没救回才整楼拒收（§5.4）；
    // JSON 完好时坏 op 只丢那一条、本楼照常接纳（与「坏项丢弃继续」口径一致）
    nothingRecovered: salvaged && c.ops.length === 0,
  };
}

function fromParsed(value: unknown): TreePatchParseResult {
  const polluted = findPrototypePollutionKey(value);
  if (polluted) return { kind: 'rejected', reason: pollutedReason(polluted) };

  const c: Collected = { ops: [], dropped: [], normalized: [] };
  let elements: unknown[];
  let envelope: Record<string, unknown> | null = null;

  if (Array.isArray(value)) {
    elements = value;
    c.normalized.push({ index: -1, path: '', message: '区块是裸 op 数组，按 patch 处理' });
  } else if (isPlainObject(value)) {
    const { patch, ...rest } = value;
    const hasPatch = Object.prototype.hasOwnProperty.call(value, 'patch');
    const legacy = hasLegacyKeys(value);
    if (!hasPatch && legacy.length > 0) {
      return { kind: 'legacy', payload: value, note: legacyNote(legacy) };
    }
    envelope = rest;
    if (hasPatch && legacy.length > 0) {
      c.normalized.push({
        index: -1,
        path: '',
        message: `同时带有旧字段（${legacy.join(' / ')}），只按 patch 处理`,
      });
    }
    if (!hasPatch) {
      if (Object.prototype.hasOwnProperty.call(value, 'op') && value.path !== undefined) {
        elements = [value];
        envelope = null;
        c.normalized.push({ index: -1, path: '', message: '区块是单条 op，按 patch 处理' });
      } else {
        elements = [];
        c.normalized.push({ index: -1, path: '', message: '缺少 patch，按空 patch 处理' });
      }
    } else if (Array.isArray(patch)) {
      elements = patch;
    } else if (patch === null || patch === undefined) {
      elements = [];
    } else if (isPlainObject(patch)) {
      elements = [patch];
      c.normalized.push({ index: -1, path: '', message: 'patch 不是数组，按单条处理' });
    } else {
      elements = [];
      c.dropped.push({ index: -1, path: '', message: 'patch 不是数组' });
    }
  } else {
    return { kind: 'unparseable', reason: '区块不是 JSON 对象' };
  }

  try {
    collect(
      elements.map((v) => ({ value: v })),
      c,
    );
  } catch (e) {
    if (e instanceof RejectSignal) return { kind: 'rejected', reason: e.message };
    throw e;
  }
  return finish(c, envelope, false);
}

function fromBrokenText(text: string): TreePatchParseResult {
  const forbidden = text.match(FORBIDDEN_KEY_RE);
  if (forbidden) {
    const key = forbidden[0].slice(1, forbidden[0].indexOf('"', 1));
    return { kind: 'rejected', reason: pollutedReason(key) };
  }

  let arrayStart = -1;
  const patchKey = /"patch"\s*:\s*\[/.exec(text);
  if (patchKey) {
    arrayStart = patchKey.index + patchKey[0].length;
  } else {
    const legacy = LEGACY_KEYS.filter((k) => new RegExp(`"${k}"\\s*:`).test(text));
    if (legacy.length > 0) return { kind: 'legacy', payload: null, note: legacyNote(legacy) };
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[')) arrayStart = text.indexOf('[') + 1;
  }
  if (arrayStart < 0) {
    return { kind: 'unparseable', reason: '区块不是合法 JSON，也找不到 patch 数组' };
  }

  const c: Collected = {
    ops: [],
    dropped: [],
    normalized: [
      {
        index: -1,
        path: '',
        message: '整段 JSON 解析失败，已逐条恢复 patch；patch 以外的字段未恢复',
      },
    ],
  };
  const elements = salvageArray(text, arrayStart);
  try {
    collect(elements, c);
  } catch (e) {
    if (e instanceof RejectSignal) return { kind: 'rejected', reason: e.message };
    throw e;
  }
  return finish(c, null, true);
}

/**
 * `<direct_updates>` 区块（或 Agent 模式 `<json>` 内文）→ op 列表。
 *
 * @param input 区块文本（可带 ```json 围栏 / `<json>` 标签 / 前后解说），或已 parse 的值
 */
export function parseTreePatchBlock(input: unknown): TreePatchParseResult {
  if (typeof input !== 'string') return fromParsed(input);
  if (!input.trim()) {
    return {
      kind: 'patch',
      ops: [],
      dropped: [],
      normalized: [],
      envelope: null,
      salvaged: false,
      empty: true,
      nothingRecovered: false,
    };
  }
  const payload = extractJsonPayload(input) ?? input.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return fromBrokenText(payload);
  }
  return fromParsed(parsed);
}

// ========== 路径解析 ==========

interface EntryLookup {
  readonly name: string;
  readonly character?: CharacterState;
  readonly itemLocation?: 'bag' | 'equipped';
}

type LookupFn = (name: string) => EntryLookup | null;

class AmbiguousSignal extends Error {}

/** 剩余段能否在条目规格下继续走（新建条目时决定名字占几段）。 */
function canDescend(entry: StateTreeNodeSpec, rest: readonly string[]): boolean {
  if (rest.length === 0) return true;
  if (entry.type === 'record') return true;
  if (entry.type === 'leaf') return KEYED_LEAVES.has(entry.leaf) && rest.length === 1;
  return findChildSpec(entry, rest[0]) !== undefined;
}

interface Picked {
  readonly name: string;
  readonly consumed: number;
  readonly found: EntryLookup | null;
  readonly note?: string;
}

/**
 * 名字段：精确 / 别名（由 lookup 负责）→ 名字含分隔符时把剩余段拼起来再试（贪心，长的先试）
 * → 都不存在则按新条目，名字取「剩余段仍能在条目规格下走通」的最短拼接。
 */
function pickEntry(
  segs: readonly string[],
  i: number,
  joiner: string | null,
  lookup: LookupFn,
  entrySpec: StateTreeNodeSpec,
): Picked {
  const direct = lookup(segs[i]);
  if (direct) return { name: direct.name, consumed: 1, found: direct };
  const remain = segs.length - i;
  if (joiner) {
    for (let k = remain; k >= 2; k--) {
      const joined = segs.slice(i, i + k).join(joiner);
      const hit = lookup(joined);
      if (hit) {
        return {
          name: hit.name,
          consumed: k,
          found: hit,
          note: `名字含「${joiner}」，已把 ${k} 段拼成「${joined}」`,
        };
      }
    }
    for (let k = 1; k <= remain; k++) {
      if (canDescend(entrySpec, segs.slice(i + k))) {
        const name = segs.slice(i, i + k).join(joiner);
        return {
          name,
          consumed: k,
          found: null,
          ...(k > 1 ? { note: `名字含「${joiner}」，已把 ${k} 段拼成「${name}」` } : {}),
        };
      }
    }
  }
  return { name: segs[i], consumed: 1, found: null };
}

function characterLookup(chars: readonly CharacterState[]): LookupFn {
  return (name) => {
    try {
      const c = resolveCharacterByName(chars, name);
      return { name: c.name, character: c };
    } catch (e) {
      if (e instanceof Error && e.message.includes('不唯一')) throw new AmbiguousSignal(e.message);
      return null;
    }
  };
}

function namesLookup(names: Iterable<string>): LookupFn {
  const set = new Set(names);
  return (name) => (set.has(name) ? { name } : null);
}

function outside(reason: string): TreePathResolution {
  return { ok: false, code: 'outside', reason: `树外路径：${reason}` };
}

/**
 * 逐段把规范段解析成结构化目标（§5.1 第 1 步）。
 *
 * @param segments `normalizeTreePath` / `TreeOp.segments` 的产物
 * @param snapshot 完整内核状态
 * @param style 路径写法，决定名字含分隔符时用什么拼接（数组写法不拼）
 */
export function resolveTreePath(
  segments: readonly string[],
  snapshot: TreePathSnapshot,
  style: TreePathStyle = 'pointer',
): TreePathResolution {
  if (segments.length === 0) return { ok: false, code: 'invalid', reason: '路径为空' };
  for (const s of segments) {
    if (FORBIDDEN.has(s)) return { ok: false, code: 'polluted', reason: pollutedReason(s) };
  }
  try {
    return walk(segments, snapshot, style === 'array' ? null : style === 'dot' ? '.' : '/');
  } catch (e) {
    if (e instanceof AmbiguousSignal) return { ok: false, code: 'ambiguous', reason: e.message };
    throw e;
  }
}

function walk(
  segs: readonly string[],
  snapshot: TreePathSnapshot,
  joiner: string | null,
): TreePathResolution {
  const notes: string[] = [];
  const chars = snapshot.characters;
  const player = chars.find((c) => c.type === 'player');

  let node: StateTreeNodeSpec = STATE_TREE_SPEC;
  let root: TreeRootKind | undefined;
  let out: string[] = [];
  let pattern: string[] = [];
  let entries: TreeEntryRef[] = [];
  let person: TreePersonRef | undefined;
  let readonly = false;
  let readonlyReason: string | undefined;
  let leafKey: string | undefined;
  let variablePath: string[] | undefined;
  /** 最内层条目在 out 里的下标（之后的段是 subPath）。 */
  let lastEntryAt = -1;
  /** 当前所在的新闻栏目名（`{栏目}` → `{标题}` 用）。 */
  let newsColumn: string | undefined;

  const enterPlayer = (): TreePathResolution | null => {
    if (!player) return { ok: false, code: 'noPlayer', reason: '存档里没有主角' };
    person = { name: player.name, isPlayer: true, exists: true, character: player };
    return null;
  };

  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];

    if (node.type === 'leaf') {
      if (node.leaf === 'variables') {
        const rest = segs.slice(i);
        const dotted = rest.find((s) => s.includes('.'));
        if (dotted !== undefined) {
          return { ok: false, code: 'invalid', reason: `变量路径的段「${dotted}」含「.」` };
        }
        variablePath = rest;
        break;
      }
      if (KEYED_LEAVES.has(node.leaf) && i === segs.length - 1) {
        leafKey = seg;
        i++;
        break;
      }
      return outside(`「${node.key}」是叶子，下面没有「${seg}」`);
    }

    if (node.type === 'branch') {
      // 主角没有 `地点` 键：主角位置在 /世界/地点（T1 约定）
      if (node === PLAYER_SPEC && stripReadonlyPrefix(seg) === '地点') {
        notes.push('主角的地点在 /世界/地点，已改写');
        node = WORLD_SPEC;
        root = 'world';
        out = ['世界'];
        pattern = ['世界'];
        entries = [];
        person = undefined;
        lastEntryAt = -1;
        continue;
      }
      const child = findChildSpec(node, seg);
      if (!child) {
        if (node === PLAYER_SPEC) {
          const rel = PERSON_NODE_CHILDREN.find(
            (c) => c.relationOnly && stripReadonlyPrefix(c.key) === stripReadonlyPrefix(seg),
          );
          if (rel) return outside(`「${rel.key}」只属于关系列表里的人物，主角没有这个键`);
        }
        const where = node === STATE_TREE_SPEC ? '状态树的顶层' : `「${node.key}」下`;
        return outside(`「${seg}」不是${where}的键`);
      }
      if (child.key !== seg) notes.push(`「${seg}」按「${child.key}」处理`);
      if (node === STATE_TREE_SPEC) {
        root = ROOT_KIND_BY_KEY[child.key];
        if (child === PLAYER_SPEC) {
          const err = enterPlayer();
          if (err) return err;
        }
      }
      if (!readonly && isReadonlyKey(child.key)) {
        readonly = true;
        readonlyReason = READONLY_REASON;
      }
      if (!readonly && person?.isPlayer && child.playerReadonly) {
        readonly = true;
        readonlyReason = PLAYER_LEVEL_REASON;
      }
      out.push(child.key);
      pattern.push(child.key);
      node = child;
      i++;
      continue;
    }

    // ---- Record：名字段 ----
    const rec: StateTreeRecordSpec = node;
    const lookup = recordLookup(rec, snapshot, person, entries, newsColumn);
    const picked = pickEntry(segs, i, joiner, lookup, rec.entry);
    if (picked.note) notes.push(picked.note);

    if (rec === RELATION_SPEC) {
      const c = picked.found?.character;
      if (c && c.type === 'player') {
        notes.push(`关系列表里的「${segs[i]}」是主角，按 /主角 处理`);
        const err = enterPlayer();
        if (err) return err;
        root = 'player';
        out = ['主角'];
        pattern = ['主角'];
        entries = [];
        lastEntryAt = -1;
        node = PLAYER_SPEC;
        i += picked.consumed;
        continue;
      }
      if (picked.found && picked.name !== segs[i]) {
        notes.push(`「${segs[i]}」解析为「${picked.name}」`);
      }
      person = {
        name: picked.name,
        isPlayer: false,
        exists: picked.found !== null,
        ...(c ? { character: c } : {}),
      };
    }
    if (rec.key === '新闻') newsColumn = picked.name;

    out.push(picked.name);
    pattern.push(rec.entry.key);
    entries.push({
      record: rec.key,
      recordSpec: rec,
      name: picked.name,
      exists: picked.found !== null,
      ...(picked.found?.itemLocation ? { itemLocation: picked.found.itemLocation } : {}),
      segmentIndex: out.length - 1,
    });
    lastEntryAt = out.length - 1;
    node = rec.entry;
    i += picked.consumed;
  }

  const fullSegments = [
    ...out,
    ...(leafKey !== undefined ? [leafKey] : []),
    ...(variablePath ?? []),
  ];
  const entry = entries[entries.length - 1];
  const target: ResolvedTreePath = {
    root: root ?? 'world',
    segments: fullSegments,
    pointer: joinStateTreePath(fullSegments),
    pattern: '/' + pattern.join('/'),
    spec: node,
    ...(person ? { person } : {}),
    entries,
    ...(entry ? { entry } : {}),
    isEntryRoot: entry !== undefined && lastEntryAt === out.length - 1 && leafKey === undefined,
    subPath: lastEntryAt >= 0 ? out.slice(lastEntryAt + 1) : [],
    ...(leafKey !== undefined ? { leafKey } : {}),
    ...(variablePath ? { variablePath } : {}),
    readonly,
    ...(readonlyReason ? { readonlyReason } : {}),
  };
  return { ok: true, target, notes };
}

/** 某个 Record 下已有的条目名。 */
function recordLookup(
  rec: StateTreeRecordSpec,
  snapshot: TreePathSnapshot,
  person: TreePersonRef | undefined,
  entries: readonly TreeEntryRef[],
  newsColumn: string | undefined,
): LookupFn {
  const none: LookupFn = () => null;
  const c = person?.character;
  switch (rec.key) {
    case '关系列表':
      return characterLookup(snapshot.characters);
    case '背包':
    case '装备': {
      if (!c) return none;
      return (name) => {
        const item = c.inventory.find((it) => it.name === name);
        if (!item) return null;
        return { name: item.name, itemLocation: item.equippedSlot ? 'equipped' : 'bag' };
      };
    }
    case '技能':
      return c ? namesLookup(c.skills.map((s) => s.name)) : none;
    case '状态效果':
      return c ? namesLookup(c.statusEffects.map((s) => s.name)) : none;
    case '要素':
      return c ? namesLookup((c.ascension?.elements ?? []).map((e) => e.name)) : none;
    case '权能':
      return c ? namesLookup((c.ascension?.authority ?? []).map((e) => e.name)) : none;
    case '法则':
      return c ? namesLookup((c.ascension?.law ?? []).map((e) => e.name)) : none;
    case '任务列表':
      return namesLookup(Object.keys(snapshot.profile?.quests ?? {}));
    case '新闻':
      return namesLookup((snapshot.profile?.news ?? []).map((n) => n.category));
    case '{栏目}': {
      const column = newsColumn ?? entries[entries.length - 1]?.name;
      return namesLookup(
        (snapshot.profile?.news ?? []).filter((n) => n.category === column).map((n) => n.title),
      );
    }
    default:
      return none;
  }
}
