/**
 * state-editor-view.ts — 变量修改器的展示层纯函数（状态树协议 T11，零副作用，不 mount 可测）
 *
 * 设计真源：docs/planning/2026-11-22-mvu-projection-protocol-design.md §11（以 §9 裁定为准）。
 * 照 character-viewer.ts 的先例单独一层：面板那边全是样式与滚动容器，而这里每一条都是**判定**——
 * 哪个键只读、哪个控件、一次编辑落成哪条 op、试算结果怎么摆。判错的症状是「能改不该改的键」
 * 或「改了却没发出 op」，那种缺陷在模板表达式里钉不住。
 *
 * 约定：
 * - 树来自 `buildStateTree(…, { visibility: { mode: 'all' } })`（全部全量）；键与叶子类型一律取自
 *   `state-tree-spec.ts` 的词表，这里不另立一张键表。
 * - 编辑产生的只有 §4.3 的 op（`PlayerEditOp`），路径是 JSON Pointer（名字段按 `~0` / `~1` 转义）。
 * - `_` 只读键可见、不可编辑（§11.3）；主角 `等级` 只读（§9 #2）；时间只读（§9 #15）。
 * - 🔴 手改不告知模型（§9 #18）：本模块不产任何「修正提示」。
 *
 * 纯度约束：无 Vue、无 Pinia、无 I/O、无浏览器全局。
 */
import {
  findChildSpec,
  isReadonlyKey,
  STATE_TREE_ENUM_VALUES,
  STATE_TREE_FORBIDDEN_KEYS,
  STATE_TREE_SLOT_VALUES,
  STATE_TREE_SPEC,
  stripReadonlyPrefix,
  type StateTreeBranchSpec,
  type StateTreeLeafKind,
  type StateTreeLeafSpec,
  type StateTreeNodeSpec,
  type StateTreeRecordSpec,
} from '@engine/variables/state-tree-spec';
import type { StateTreeObject, StateTreeValue } from '@engine/variables/state-tree-projection';
import type {
  PlayerEditOp,
  PlayerEditPreview,
  PlayerEditUndoToken,
} from '@engine/variables/state-tree-edit';
import type { StateUpdateOpStatus } from '@engine/types/types';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 表单控件（§11.1：数值步进、枚举下拉、布尔开关、文本框、文本数组标签、字典增删条目）。 */
type EditorControl =
  'number' | 'text' | 'textarea' | 'select' | 'toggle' | 'tags' | 'dict' | 'display';

/** 右栏的一个可编辑（或只读展示的）叶子。 */
export interface EditorField {
  /** JSON Pointer，形如 `/主角/生命值/上限/额外`。 */
  readonly path: string;
  /** 显示名（去掉 `_` 前缀；嵌套分支用「上限 · 额外」连接）。 */
  readonly label: string;
  readonly control: EditorControl;
  /** 叶子类型；变量空间里的值为 `variables`。 */
  readonly leaf: StateTreeLeafKind;
  /** 投影里的现值；缺席（可选键未投影）为 undefined。 */
  readonly value: StateTreeValue | undefined;
  /** 下拉选项（枚举 / 装备位置）。 */
  readonly options?: readonly string[];
  /** 数值上下限（只作控件提示，纠正与钳制仍归引擎）。 */
  readonly min?: number;
  readonly max?: number;
  /** 字典值的类型（`dict` 控件）。 */
  readonly dictValue?: 'text' | 'number';
  readonly readonly: boolean;
  /** 只读原因（界面在锁形图标旁显示）。 */
  readonly readonlyReason?: string;
  /** 变量空间的键可删除（结构编辑）。 */
  readonly removable?: boolean;
}

type EditorNodeKind = 'group' | 'record' | 'entry' | 'variables';

/** 左栏状态树的一个节点。 */
export interface EditorNode {
  readonly path: string;
  readonly label: string;
  readonly kind: EditorNodeKind;
  readonly fields: readonly EditorField[];
  readonly children: readonly EditorNode[];
  /** 可在此节点下新增条目（字典 / 变量命名空间）。 */
  readonly canAdd: boolean;
  /** 条目可删除。 */
  readonly canRemove: boolean;
  /** 条目可改名（同一字典内 move）。 */
  readonly canRename: boolean;
}

// ═══════════════════════════════════════════════════════════
// 路径
// ═══════════════════════════════════════════════════════════

/** JSON Pointer 单段转义（RFC 6901：`~` → `~0`，`/` → `~1`）。名字里可能含 `/`。 */
export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 段 → JSON Pointer。 */
export function pointerOf(segments: readonly string[]): string {
  return segments.map((s) => `/${encodePointerSegment(s)}`).join('');
}

/** 指针的父路径（根返回空串）。 */
export function parentPointer(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

// ═══════════════════════════════════════════════════════════
// 只读判定
// ═══════════════════════════════════════════════════════════

export const READONLY_BY_CODE = '由代码维护';
export const READONLY_ATTRIBUTES = '由代码维护（属性点请在状态总览里分配）';
export const READONLY_PLAYER_LEVEL = '主角等级由经验推导，请改累计经验值';
export const READONLY_TIME = '时间只读：只能前进，且一改就会触发天气、随机事件与地块结算';
const READONLY_COMPLEX_VARIABLE = '复杂值不在修改器里编辑';

interface WalkContext {
  readonly isPlayer: boolean;
  /** 祖先上已有的只读原因（`_属性` 之下的五维等）。 */
  readonly inherited?: string;
}

/** 某节点在给定上下文里的只读原因；可写返回 undefined。 */
function readonlyReasonOf(spec: StateTreeNodeSpec, ctx: WalkContext): string | undefined {
  if (ctx.inherited) return ctx.inherited;
  if (spec.type === 'leaf' && spec.leaf === 'gameTime') return READONLY_TIME;
  if (isReadonlyKey(spec.key)) {
    return stripReadonlyPrefix(spec.key) === '属性' || stripReadonlyPrefix(spec.key) === '属性点'
      ? READONLY_ATTRIBUTES
      : READONLY_BY_CODE;
  }
  if (ctx.isPlayer && spec.playerReadonly) return READONLY_PLAYER_LEVEL;
  return undefined;
}

// ═══════════════════════════════════════════════════════════
// 控件
// ═══════════════════════════════════════════════════════════

/** 长文本字段用多行框。 */
const TEXTAREA_KEYS = new Set([
  '描述',
  '外貌',
  '着装',
  '性格',
  '背景故事',
  '规则文本',
  '进展',
  '详情',
  '心里话',
]);

const NUMBER_LEAVES: ReadonlySet<StateTreeLeafKind> = new Set([
  'number',
  'resourceCurrent',
  'capBase',
  'capBonus',
  'money',
  'fatePoints',
  'affection',
  'quantity',
  'stacks',
]);

function numberBounds(kind: StateTreeLeafKind): { min?: number; max?: number } {
  if (kind === 'affection') return { min: -100, max: 100 };
  if (kind === 'money' || kind === 'fatePoints' || kind === 'resourceCurrent') return { min: 0 };
  if (kind === 'quantity' || kind === 'stacks') return { min: 0 };
  return {};
}

/** 叶子 → 控件描述（§11.1）。 */
function controlOf(
  spec: StateTreeLeafSpec,
): Pick<EditorField, 'control' | 'options' | 'min' | 'max' | 'dictValue'> {
  const kind = spec.leaf;
  if (NUMBER_LEAVES.has(kind)) return { control: 'number', ...numberBounds(kind) };
  switch (kind) {
    case 'enum':
      return {
        control: 'select',
        options: spec.enumKind ? STATE_TREE_ENUM_VALUES[spec.enumKind] : [],
      };
    case 'slot':
      return { control: 'select', options: STATE_TREE_SLOT_VALUES };
    case 'boolean':
      return { control: 'toggle' };
    case 'textArray':
      return { control: 'tags' };
    case 'effectDict':
      return { control: 'dict', dictValue: 'text' };
    case 'numberDict':
      return { control: 'dict', dictValue: 'number' };
    case 'gameTime':
      return { control: 'display' };
    default:
      return { control: TEXTAREA_KEYS.has(spec.key) ? 'textarea' : 'text' };
  }
}

// ═══════════════════════════════════════════════════════════
// 建树
// ═══════════════════════════════════════════════════════════

function isObject(v: unknown): v is StateTreeObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function childValue(value: StateTreeValue | undefined, key: string): StateTreeValue | undefined {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

/** 子树里有没有按名字作键的字典（决定该分支是「容器」还是「扁平表单」）。 */
function containsRecord(spec: StateTreeNodeSpec): boolean {
  if (spec.type === 'record') return true;
  if (spec.type === 'branch') return spec.children.some(containsRecord);
  return false;
}

function leafField(
  spec: StateTreeLeafSpec,
  value: StateTreeValue | undefined,
  segments: readonly string[],
  label: string,
  ctx: WalkContext,
): EditorField {
  const reason = readonlyReasonOf(spec, ctx);
  return {
    path: pointerOf(segments),
    label,
    leaf: spec.leaf,
    value,
    ...controlOf(spec),
    ...(reason ? { control: 'display' as const } : {}),
    readonly: reason !== undefined,
    ...(reason ? { readonlyReason: reason } : {}),
  };
}

/** 无字典的分支：把所有叶子摊平成一张表单（嵌套分支加前缀）。 */
function flattenFields(
  spec: StateTreeBranchSpec,
  value: StateTreeValue | undefined,
  segments: readonly string[],
  prefix: string,
  ctx: WalkContext,
): EditorField[] {
  const out: EditorField[] = [];
  for (const child of spec.children) {
    const segs = [...segments, child.key];
    const label = `${prefix}${stripReadonlyPrefix(child.key)}`;
    const v = childValue(value, child.key);
    if (child.type === 'leaf') {
      out.push(leafField(child, v, segs, label, ctx));
    } else if (child.type === 'branch') {
      const inherited = readonlyReasonOf(child, ctx);
      out.push(...flattenFields(child, v, segs, `${label} · `, { ...ctx, inherited }));
    }
  }
  return out;
}

/** 允许新增条目的字典（§11.3：新建人物第一期不做，新闻只增不删且由 AI 写）。 */
const ADDABLE_RECORDS = new Set(['背包', '技能', '状态效果', '任务列表', '要素', '权能', '法则']);
/** 条目可删除的字典（主角不在任何字典里，天然不可删）。 */
const REMOVABLE_RECORDS = new Set([
  '背包',
  '装备',
  '技能',
  '状态效果',
  '任务列表',
  '要素',
  '权能',
  '法则',
  '关系列表',
]);
/** 条目可改名的字典（人物改名牵涉记忆与关系，第一期不开放）。 */
const RENAMABLE_RECORDS = new Set([
  '背包',
  '装备',
  '技能',
  '状态效果',
  '任务列表',
  '要素',
  '权能',
  '法则',
]);

function branchNode(
  spec: StateTreeBranchSpec,
  value: StateTreeValue | undefined,
  segments: readonly string[],
  label: string,
  kind: EditorNodeKind,
  ctx: WalkContext,
  entryOf?: string,
): EditorNode {
  const flags = {
    canAdd: false,
    canRemove: entryOf !== undefined && REMOVABLE_RECORDS.has(entryOf),
    canRename: entryOf !== undefined && RENAMABLE_RECORDS.has(entryOf),
  };
  if (!containsRecord(spec)) {
    return {
      path: pointerOf(segments),
      label,
      kind,
      fields: flattenFields(spec, value, segments, '', ctx),
      children: [],
      ...flags,
    };
  }
  const fields: EditorField[] = [];
  const children: EditorNode[] = [];
  for (const child of spec.children) {
    const segs = [...segments, child.key];
    const v = childValue(value, child.key);
    const childLabel = stripReadonlyPrefix(child.key);
    if (child.type === 'leaf') fields.push(leafField(child, v, segs, childLabel, ctx));
    else if (child.type === 'branch')
      children.push(branchNode(child, v, segs, childLabel, 'group', ctx));
    else children.push(recordNode(child, v, segs, childLabel, ctx));
  }
  return { path: pointerOf(segments), label, kind, fields, children, ...flags };
}

function recordNode(
  spec: StateTreeRecordSpec,
  value: StateTreeValue | undefined,
  segments: readonly string[],
  label: string,
  ctx: WalkContext,
): EditorNode {
  const children: EditorNode[] = [];
  const entry = spec.entry;
  if (isObject(value) && entry.type === 'branch') {
    for (const name of Object.keys(value)) {
      children.push(
        branchNode(entry, value[name], [...segments, name], name, 'entry', ctx, spec.key),
      );
    }
  }
  return {
    path: pointerOf(segments),
    label,
    kind: 'record',
    fields: [],
    children,
    canAdd: ADDABLE_RECORDS.has(spec.key),
    canRemove: false,
    canRename: false,
  };
}

/** 变量叶子：只给原样可编辑的标量与文本数组，其余复杂值只读展示（§11.6 不直接编辑原始 JSON）。 */
function variableField(
  value: StateTreeValue,
  segments: readonly string[],
  label: string,
): EditorField {
  const base = {
    path: pointerOf(segments),
    label,
    leaf: 'variables' as const,
    value,
    removable: true,
  };
  if (typeof value === 'number') return { ...base, control: 'number', readonly: false };
  if (typeof value === 'boolean') return { ...base, control: 'toggle', readonly: false };
  if (typeof value === 'string') return { ...base, control: 'text', readonly: false };
  if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    return { ...base, control: 'tags', readonly: false };
  return { ...base, control: 'display', readonly: true, readonlyReason: READONLY_COMPLEX_VARIABLE };
}

/** ADR-30 变量空间：对象成节点，标量成字段。顶层只认命名空间，故根不可新增键（引擎同口径）。 */
function variablesNode(
  value: StateTreeValue | undefined,
  segments: readonly string[],
  label: string,
): EditorNode {
  const fields: EditorField[] = [];
  const children: EditorNode[] = [];
  const isRoot = segments.length === 1;
  if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      const segs = [...segments, key];
      if (isObject(v)) children.push({ ...variablesNode(v, segs, key), canRemove: !isRoot });
      else fields.push(variableField(v, segs, key));
    }
  }
  return {
    path: pointerOf(segments),
    label,
    kind: 'variables',
    fields,
    children,
    canAdd: !isRoot,
    canRemove: false,
    canRename: false,
  };
}

function rootChild(key: string): StateTreeNodeSpec | undefined {
  return findChildSpec(STATE_TREE_SPEC, key);
}

/**
 * 状态树（全量投影）→ 左栏节点（§11.1：世界、主角、关系列表、任务列表、变量）。
 *
 * - `世界` 节点同时带上根上的 `命运点数`（根叶子没有自己的分组）；
 * - 新闻是 AI 写的只增不删流水，不进修改器（§11.6 范围之外的展示面）。
 */
export function buildEditorTree(tree: StateTreeObject): EditorNode[] {
  const nodes: EditorNode[] = [];
  const npc: WalkContext = { isPlayer: false };

  const worldSpec = rootChild('世界');
  const fateSpec = rootChild('命运点数');
  if (worldSpec?.type === 'branch') {
    const world = branchNode(worldSpec, tree['世界'], ['世界'], '世界', 'group', npc);
    const extra =
      fateSpec?.type === 'leaf'
        ? [leafField(fateSpec, tree['命运点数'], ['命运点数'], '命运点数', npc)]
        : [];
    nodes.push({ ...world, fields: [...world.fields, ...extra] });
  }

  const playerSpec = rootChild('主角');
  if (playerSpec?.type === 'branch' && tree['主角'] !== undefined) {
    nodes.push(branchNode(playerSpec, tree['主角'], ['主角'], '主角', 'group', { isPlayer: true }));
  }

  for (const key of ['关系列表', '任务列表']) {
    const spec = rootChild(key);
    if (spec?.type === 'record') nodes.push(recordNode(spec, tree[key], [key], key, npc));
  }

  nodes.push(variablesNode(tree['变量'], ['变量'], '变量'));
  return nodes;
}

/** 深度优先查节点。 */
export function findEditorNode(nodes: readonly EditorNode[], path: string): EditorNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = findEditorNode(n.children, path);
    if (hit) return hit;
  }
  return undefined;
}

/** 整棵树的字段索引（按路径），收集草稿 op 用。 */
export function indexEditorFields(nodes: readonly EditorNode[]): Map<string, EditorField> {
  const map = new Map<string, EditorField>();
  const walk = (list: readonly EditorNode[]) => {
    for (const n of list) {
      for (const f of n.fields) map.set(f.path, f);
      walk(n.children);
    }
  };
  walk(nodes);
  return map;
}

// ═══════════════════════════════════════════════════════════
// 搜索
// ═══════════════════════════════════════════════════════════

export interface EditorSearchResult {
  /** 需要显示的节点（命中节点 + 其全部祖先）。 */
  readonly visible: ReadonlySet<string>;
  /** 需要展开的节点（命中节点的祖先）。 */
  readonly expanded: ReadonlySet<string>;
  /** 命中的节点（名字、路径或其字段名命中）。 */
  readonly matched: ReadonlySet<string>;
}

/**
 * 按名字或路径搜索（不分大小写的子串匹配，§11.1）。空查询返回 null（不过滤）。
 * 节点命中条件：节点名、节点路径、或它的任一字段名 / 字段路径包含查询串。
 */
export function searchEditorTree(
  nodes: readonly EditorNode[],
  query: string,
): EditorSearchResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const visible = new Set<string>();
  const expanded = new Set<string>();
  const matched = new Set<string>();
  const hits = (n: EditorNode) =>
    n.label.toLowerCase().includes(q) ||
    n.path.toLowerCase().includes(q) ||
    n.fields.some((f) => f.label.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  const walk = (n: EditorNode, ancestors: readonly string[]): boolean => {
    let any = false;
    for (const c of n.children) if (walk(c, [...ancestors, n.path])) any = true;
    const self = hits(n);
    if (self) matched.add(n.path);
    if (self || any) {
      visible.add(n.path);
      for (const a of ancestors) {
        visible.add(a);
        expanded.add(a);
      }
      if (any) expanded.add(n.path);
    }
    return self || any;
  };
  for (const n of nodes) walk(n, []);
  return { visible, expanded, matched };
}

// ═══════════════════════════════════════════════════════════
// 草稿 ⇄ op
// ═══════════════════════════════════════════════════════════

/** 字典控件的一行草稿。 */
export interface DictDraftRow {
  key: string;
  value: string;
}

/** 草稿值：数值 / 文本 / 下拉为字符串，开关为布尔，标签为字符串数组，字典为行数组。 */
export type FieldDraft = string | boolean | string[] | DictDraftRow[];

/** 字段现值 → 初始草稿。 */
export function initialDraft(field: EditorField): FieldDraft {
  const v = field.value;
  switch (field.control) {
    case 'toggle':
      return v === true;
    case 'tags':
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    case 'dict':
      return isObject(v)
        ? Object.entries(v).map(([key, value]) => ({ key, value: formatScalar(value) }))
        : [];
    default:
      return v === undefined || v === null ? '' : formatScalar(v);
  }
}

function formatScalar(v: StateTreeValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** 草稿解析结果。 */
export type DraftParse =
  | { readonly ok: true; readonly value: StateTreeValue | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * 草稿 → 写入值。`undefined` 表示「留空」（缺席的可选键没填 = 不产 op）。
 * 数值框与数值字典要求能解析成有限数；其余纠正（取整、钳制、别名）归引擎纠正层。
 */
export function parseDraft(field: EditorField, draft: FieldDraft): DraftParse {
  switch (field.control) {
    case 'toggle':
      return { ok: true, value: draft === true };
    case 'tags': {
      const list = Array.isArray(draft) ? (draft as unknown[]) : [];
      return {
        ok: true,
        value: list
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .map((x) => x.trim()),
      };
    }
    case 'dict': {
      const rows = Array.isArray(draft) ? (draft as DictDraftRow[]) : [];
      const out: StateTreeObject = {};
      for (const row of rows) {
        const key = typeof row?.key === 'string' ? row.key.trim() : '';
        if (!key) continue;
        if ((STATE_TREE_FORBIDDEN_KEYS as readonly string[]).includes(key))
          return { ok: false, reason: `「${field.label}」里的键「${key}」不能使用` };
        if (Object.prototype.hasOwnProperty.call(out, key))
          return { ok: false, reason: `「${field.label}」里有重复的键「${key}」` };
        if (field.dictValue === 'number') {
          const n = Number(String(row.value).trim());
          if (String(row.value).trim() === '' || !Number.isFinite(n))
            return { ok: false, reason: `「${field.label} · ${key}」要填数字` };
          Object.defineProperty(out, key, {
            value: n,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          Object.defineProperty(out, key, {
            value: String(row.value ?? ''),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return { ok: true, value: out };
    }
    case 'number': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') {
        return field.value === undefined
          ? { ok: true, value: undefined }
          : { ok: false, reason: `「${field.label}」要填数字` };
      }
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, reason: `「${field.label}」要填数字` };
      return { ok: true, value: n };
    }
    default: {
      const text = typeof draft === 'string' ? draft : '';
      if (text === '' && field.value === undefined) return { ok: true, value: undefined };
      return { ok: true, value: text };
    }
  }
}

/** 键序无关的深比较。 */
function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 字段草稿是否与现值不同（解析失败也算改动，由预览把原因报出来）。 */
export function isFieldDirty(field: EditorField, draft: FieldDraft): boolean {
  if (field.readonly) return false;
  const parsed = parseDraft(field, draft);
  if (!parsed.ok) return true;
  if (parsed.value === undefined) return false;
  return canonical(parsed.value) !== canonical(field.value);
}

/**
 * 收集全部改动过的草稿 → op 列表（`replace`；数值也用 replace，由翻译层换算成差量，§4.3）。
 * 只读字段与没改的字段不产 op；解析失败的收进 `errors`，有错时不应提交。
 */
export function collectDraftOps(
  fields: ReadonlyMap<string, EditorField>,
  drafts: ReadonlyMap<string, FieldDraft>,
): { ops: PlayerEditOp[]; errors: string[] } {
  const ops: PlayerEditOp[] = [];
  const errors: string[] = [];
  for (const [path, draft] of drafts) {
    const field = fields.get(path);
    if (!field || field.readonly || !isFieldDirty(field, draft)) continue;
    const parsed = parseDraft(field, draft);
    if (!parsed.ok) {
      errors.push(parsed.reason);
      continue;
    }
    if (parsed.value === undefined) continue;
    ops.push({ op: 'replace', path, value: parsed.value });
  }
  return { ops, errors };
}

// ═══════════════════════════════════════════════════════════
// 结构编辑（字典增删改名）
// ═══════════════════════════════════════════════════════════

/** 新条目名的校验：非空、非原型污染键、不与同级已有条目重名。返回错误原因，通过返回 null。 */
export function validateEntryName(
  parent: EditorNode,
  name: string,
  ignorePath?: string,
): string | null {
  const n = name.trim();
  if (!n) return '名字不能为空';
  if ((STATE_TREE_FORBIDDEN_KEYS as readonly string[]).includes(n)) return `「${n}」不能用作名字`;
  if (isReadonlyKey(n)) return '名字不能以 _ 开头（那是只读键的标记）';
  const target = `${parent.path}/${encodePointerSegment(n)}`;
  const taken =
    parent.children.some((c) => c.path === target && c.path !== ignorePath) ||
    parent.fields.some((f) => f.path === target && f.path !== ignorePath);
  return taken ? `已经有叫「${n}」的条目了` : null;
}

/**
 * 在字典 / 变量命名空间下新增一条。
 * 字典条目写空整对象：缺省值由翻译层补齐（数量 1、层数 1、分类「特殊」、任务默认值，§5.2「整实体值」）；
 * 变量新增一个空文本键。
 */
export function addEntryOp(parent: EditorNode, name: string): PlayerEditOp {
  const path = `${parent.path}/${encodePointerSegment(name.trim())}`;
  return { op: 'add', path, value: parent.kind === 'variables' ? '' : {} };
}

/** 删除条目或变量键。 */
export function removeEntryOp(path: string): PlayerEditOp {
  return { op: 'remove', path };
}

/** 同一字典内改名（§4.3 move：同一字典内是改名）。 */
export function renameEntryOp(path: string, newName: string): PlayerEditOp {
  return {
    op: 'move',
    from: path,
    path: `${parentPointer(path)}/${encodePointerSegment(newName.trim())}`,
  };
}

// ═══════════════════════════════════════════════════════════
// 试算展示
// ═══════════════════════════════════════════════════════════

const OP_LABELS: Readonly<Record<PlayerEditOp['op'], string>> = {
  replace: '修改',
  add: '新增',
  remove: '删除',
  delta: '增减',
  move: '移动',
};

/** 值 → 一行人能读的文字（缺席显示「（无）」）。 */
export function formatEditorValue(v: unknown): string {
  if (v === undefined) return '（无）';
  if (v === null) return '（空）';
  if (typeof v === 'string') return v === '' ? '（空）' : v;
  if (typeof v === 'number' || typeof v === 'boolean')
    return v === true ? '是' : v === false ? '否' : String(v);
  if (Array.isArray(v))
    return v.length === 0 ? '（空）' : v.map((x) => formatEditorValue(x)).join('、');
  if (isObject(v)) {
    const entries = Object.entries(v);
    if (entries.length === 0) return '（空）';
    return entries.map(([k, x]) => `${k}：${formatEditorValue(x)}`).join('；');
  }
  return String(v);
}

interface PreviewRow {
  readonly path: string;
  readonly from?: string;
  readonly op: string;
  readonly before: string;
  readonly after: string;
  readonly status: StateUpdateOpStatus;
  readonly note?: string;
}

export interface PreviewView {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly rows: readonly PreviewRow[];
}

/** 试算结果 → 「将要发生的变更」清单（§11.2：逐条前值 → 后值，以及被纠正或被拒的条目）。 */
export function describePreview(preview: PlayerEditPreview): PreviewView {
  return {
    ok: preview.ok,
    reasons: preview.reasons,
    rows: preview.records.map((r) => ({
      path: r.path,
      ...(r.from ? { from: r.from } : {}),
      op: OP_LABELS[r.op] ?? r.op,
      before: formatEditorValue(r.before),
      after: r.op === 'remove' ? '（删除）' : formatEditorValue(r.after ?? r.value),
      status: r.status,
      ...(r.note ? { note: r.note } : {}),
    })),
  };
}

/** 一批 op 的简短名字（撤销栈里显示「撤销：…」）。 */
export function describeOps(ops: readonly PlayerEditOp[]): string {
  if (ops.length === 0) return '';
  const first = ops[0];
  const head = `${OP_LABELS[first.op] ?? first.op} ${first.path}`;
  return ops.length > 1 ? `${head} 等 ${ops.length} 项` : head;
}

// ═══════════════════════════════════════════════════════════
// 锁定与撤销
// ═══════════════════════════════════════════════════════════

/**
 * 整面只读的原因（§11.4：回合生成中、正文润色中、战斗中）。可编辑返回空串。
 * 判据与玩家人设编辑同一组（`isGenerating` / `isInCombat`），另加润色中（`isRewriting`）。
 */
export function stateEditorLockReason(flags: {
  readonly isGenerating: boolean;
  readonly isRewriting: boolean;
  readonly isInCombat: boolean;
}): string {
  if (flags.isGenerating) return '当前回合生成中，结束后才能修改变量';
  if (flags.isRewriting) return '正文润色中，结束后才能修改变量';
  if (flags.isInCombat) return '战斗进行中，结束后才能修改变量';
  return '';
}

/** 撤销栈的一项（内存，§11.4）。 */
export interface StateEditUndoEntry {
  /** 这次修改的简述。 */
  readonly label: string;
  /** 引擎给的撤销凭据（提交前的内核快照 + 提交后的指纹，2026-11-25 审查 R4）。 */
  readonly undo: PlayerEditUndoToken;
}

/**
 * 「撤销上一次修改」可不可点；不可点时给原因。只看栈顶：更早的修改要先撤掉后来的。
 * 快照还原对任何修改都成立，所以栈非空即可点；现状已被别处改过时由引擎在撤销时拒绝并说明。
 */
export function undoAvailability(stack: readonly StateEditUndoEntry[]): {
  readonly canUndo: boolean;
  readonly reason: string;
} {
  const top = stack[stack.length - 1];
  if (!top) return { canUndo: false, reason: '本回合还没有可撤销的修改' };
  return { canUndo: true, reason: '' };
}
