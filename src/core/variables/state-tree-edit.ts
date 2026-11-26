/**
 * 玩家编辑与更新块修订的规划层（状态树协议 T10，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §11.2–11.4、§12.3）
 *
 * 纯函数，不碰 I/O。写入口是 `StateManager.commitPlayerEdit`，本模块只负责：
 * - `previewPlayerEdit`：不落库试算（面板「将要发生的变更」），并给出整批会不会被拒及原因；
 * - `planUpdateBlockRevision`：更新块逐条补差（§12.3），产出作用在**当前状态**上的补偿 op
 *   （其中「撤销一行」仍是逐条反向 op，`inverseOpsOf`）；
 * - `applyRevisionToRecord`：提交成功后改写本楼记录（被修订行标「已手动修订」）；
 * - `playerEditFingerprint`：撤销凭据的指纹（修改器撤销改为内核快照整体还原，2026-11-25 审查 R4）。
 *
 * 🔴 已裁定（§9）：修改器不能强改只读键（#14）、不能改时间（#15）；更新块逐条补差、不从前置快照重放（#16）；
 *    手改不告知模型（#18）—— 本模块不产任何「玩家修正」清单。
 * 🔴 只有最新一楼可改由调用方（UI）把守；本模块只看传进来的那一条记录。
 */

import type {
  CharacterState,
  SaveProfile,
  StateUpdateOpRecord,
  StateUpdateRecord,
} from '../types/types';
import {
  normalizeTreePath,
  parseTreePatchBlock,
  resolveTreePath,
  type TreeOp,
  type TreePathSnapshot,
} from './state-tree-patch';
import { coerceNumber } from './state-tree-codecs';
import { buildStateTree, type StateTreeValue } from './state-tree-projection';
import {
  STATE_TREE_DEPLETABLE_LEAF,
  STATE_TREE_NAMED_RECORD_KEYS,
  isReadonlyKey,
  type StateTreePatchOp,
} from './state-tree-spec';
import {
  readStateTreeValue,
  translateTreeOps,
  type TreeTranslateResult,
  type TreeTranslateSnapshot,
} from './state-tree-translator';

// ========== 对外类型 ==========

/** 玩家编辑的一条 op（线上形状同 §4.3，路径用 JSON Pointer）。可直接存进撤销栈。 */
export interface PlayerEditOp {
  readonly op: StateTreePatchOp;
  readonly path: string;
  readonly value?: unknown;
  /** 仅 move。 */
  readonly from?: string;
}

/** 玩家编辑补丁的 `metadata.source`，引擎日志分类是 `state.manual_edit`。 */
export const PLAYER_EDIT_SOURCE = 'player_edit';

/** 试算结果（§11.2「将要发生的变更」）。 */
export interface PlayerEditPreview {
  /** 整批能否提交（`reasons` 为空）。 */
  readonly ok: boolean;
  /** 整批被拒的原因（只读键、时间、被丢弃的条目、解析失败）。 */
  readonly reasons: string[];
  /** 逐条前值 → 后值（翻译层记录）；解析失败时为空。 */
  readonly records: StateUpdateOpRecord[];
  readonly dropped: string[];
  readonly normalized: string[];
  /** 完整翻译产物（写入口直接用它提交）；解析失败时为 null。 */
  readonly translation: TreeTranslateResult | null;
}

/**
 * 修改器「撤销上一次修改」的凭据（§11.4；2026-11-25 审查 R4 改为内核快照整体还原）。
 *
 * `commitPlayerEdit` 在锁内记下提交前被触及的角色与档案（整份内核形状，含投影里没有的内部字段），
 * 以及更新块修订时该楼的记录；`undoPlayerEdit` 在同锁同事务里核对指纹后整体写回。
 * 不再由前值生成反向 op —— 反向 op 不是真逆（钳制、顶替、新建 id 都还原不了）。
 */
export interface PlayerEditUndoToken {
  readonly saveId: string;
  /** 提交前被触及角色的整份快照：id → 角色；null = 这次提交新建的角色（撤销时删除）。 */
  readonly characters: Readonly<Record<string, CharacterState | null>>;
  /** 提交前的档案；这次提交没改档案时缺席。 */
  readonly profile?: SaveProfile;
  /** 提交前该楼的更新记录（更新块修订时才有）。 */
  readonly message?: { readonly id: string; readonly stateUpdates: StateUpdateRecord };
  /** 提交后被触及部分的指纹；撤销前现状必须与它一致。 */
  readonly fingerprint: string;
}

/** `undoPlayerEdit` 的结果。 */
export type PlayerEditUndoResult =
  | {
      readonly ok: true;
      /** 一并还原的本楼记录（UI 据此刷新展示副本）。 */
      readonly message?: { readonly id: string; readonly stateUpdates: StateUpdateRecord };
    }
  | { readonly ok: false; readonly reasons: string[] };

/** 更新块修订时随状态同事务写回的本楼记录（`commitPlayerEdit` 的可选参数）。 */
export interface PlayerEditRecordWriteback {
  readonly messageId: string;
  /** 被修订行的下标；`append` 时为 null。 */
  readonly index: number | null;
  readonly revision: UpdateBlockRevision;
}

/** `commitPlayerEdit` 的结果。 */
export type PlayerEditCommitResult =
  | {
      readonly ok: true;
      readonly records: StateUpdateOpRecord[];
      readonly normalized: string[];
      /** 撤销凭据，交给 `undoPlayerEdit`。 */
      readonly undo: PlayerEditUndoToken;
      /** 同事务写回后的本楼记录（传了 `record` 时才有）。 */
      readonly stateUpdates?: StateUpdateRecord;
    }
  | {
      readonly ok: false;
      readonly reasons: string[];
      readonly records: StateUpdateOpRecord[];
      readonly dropped: string[];
    };

/** 更新块的一次修订（§12.3）。 */
export type UpdateBlockRevision =
  /** 改一条已应用 op 的值。 */
  | { readonly kind: 'edit'; readonly value: unknown }
  /** 撤销一条已应用的 op。 */
  | { readonly kind: 'revert' }
  /** 把一条被丢弃的 op 改好后重新应用（缺省沿用记录里的 op / path / from / value）。 */
  | { readonly kind: 'reapply'; readonly op?: PlayerEditOp; readonly value?: unknown }
  /** 新增一条（不依附任何既有行）。 */
  | { readonly kind: 'append'; readonly op: PlayerEditOp };

export type RevisionPlan =
  | {
      readonly kind: 'ok';
      /** 作用在当前状态上的补偿 op（交给 `commitPlayerEdit`）。 */
      readonly ops: PlayerEditOp[];
      /** 补偿 op 在当前状态上的试算。 */
      readonly preview: PlayerEditPreview;
    }
  | {
      /** 现值已不等于记录的后值（之后又被改过），由玩家决定是否强制（`force`）。 */
      readonly kind: 'conflict';
      readonly path: string;
      readonly expected: unknown;
      readonly current: unknown;
    }
  /** 这类记录行不可在更新块里修订（需回退本楼）。 */
  | { readonly kind: 'blocked'; readonly reason: string }
  /** 修订本身不成立（动作不对、值不对、试算被拒）。 */
  | { readonly kind: 'invalid'; readonly reasons: string[] };

export interface RevisionOptions {
  /** 冲突时仍按目标值覆盖。 */
  readonly force?: boolean;
}

// ========== 内部工具 ==========

const TIME_POINTER = '/世界/时间';
const TIME_REASON = '时间在修改器里只读（只能前进，且会触发天气、随机事件、地块结算）';
const READONLY_SUFFIX = '修改器不能改只读键';

function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 键序无关的深比较（投影键序固定，但记录可能来自旧序列化）。 */
function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function segmentsOf(path: string): readonly string[] | null {
  const n = normalizeTreePath(path);
  return n.ok ? n.segments : null;
}

function isTimePath(segments: readonly string[] | null): boolean {
  return !!segments && segments[0] === '世界' && segments[1] === '时间';
}

function fullTree(snapshot: TreeTranslateSnapshot): StateTreeValue {
  return buildStateTree(
    { characters: snapshot.characters, profile: snapshot.profile },
    { visibility: { mode: 'all' }, newsLimit: Number.MAX_SAFE_INTEGER },
  );
}

function pathSnapshot(snapshot: TreeTranslateSnapshot): TreePathSnapshot {
  return { characters: snapshot.characters, profile: snapshot.profile };
}

/** 线上形状 → TreeOp（复用区块解析器：别名、路径写法、原型污染一并处理）。 */
function parsePlayerOps(
  ops: readonly PlayerEditOp[],
): { ok: true; ops: readonly TreeOp[] } | { ok: false; reasons: string[] } {
  const parsed = parseTreePatchBlock(
    ops.map((o) => ({
      op: o.op,
      path: o.path,
      ...(o.from !== undefined ? { from: o.from } : {}),
      ...(o.value !== undefined ? { value: o.value } : {}),
    })),
  );
  if (parsed.kind === 'rejected' || parsed.kind === 'unparseable')
    return { ok: false, reasons: [parsed.reason] };
  if (parsed.kind !== 'patch') return { ok: false, reasons: ['不是状态树 op 列表'] };
  if (parsed.dropped.length > 0)
    return {
      ok: false,
      reasons: parsed.dropped.map((d) => `${d.path || `第 ${d.index + 1} 条`}：${d.message}`),
    };
  return { ok: true, ops: parsed.ops };
}

/**
 * 只读键与时间的整批闸门（§11.3）：路径本身、move 的 from、以及对象值里嵌套的键。
 * 解析不了的路径不在这里判（翻译层会丢它，整批照样被拒）。
 */
function guardReasons(ops: readonly TreeOp[], snapshot: TreeTranslateSnapshot): string[] {
  const snap = pathSnapshot(snapshot);
  const reasons: string[] = [];
  const check = (segments: readonly string[] | undefined, raw: string, value?: unknown) => {
    if (!segments || segments.length === 0) return;
    if (isTimePath(segments)) {
      reasons.push(`${raw}：${TIME_REASON}`);
      return;
    }
    const r = resolveTreePath(segments, snap);
    if (!r.ok) return;
    const t = r.target;
    if (t.readonly) {
      reasons.push(`${raw}：${t.readonlyReason ?? '由代码维护'}，${READONLY_SUFFIX}`);
      return;
    }
    if (t.root === 'world' && t.segments.length === 1 && isPlainObject(value) && '时间' in value) {
      reasons.push(`${raw}/时间：${TIME_REASON}`);
    }
    if (t.root === 'variables' || !isPlainObject(value)) return;
    // 新建人物走独立组装管线（字段是整实体形状），只拦显式的 `_` 键
    const creatingPerson = t.root === 'relation' && !!t.person && !t.person.exists;
    scanValue(t.segments, value, raw, creatingPerson, 0);
  };
  const scanValue = (
    base: readonly string[],
    value: Record<string, unknown>,
    raw: string,
    creatingPerson: boolean,
    depth: number,
  ) => {
    if (depth > 8) return;
    for (const [k, v] of Object.entries(value)) {
      const segs = [...base, k];
      if (isReadonlyKey(k)) {
        reasons.push(`${raw}/${k}：由代码维护，${READONLY_SUFFIX}`);
        continue;
      }
      if (!creatingPerson) {
        const r = resolveTreePath(segs, snap);
        if (r.ok && r.target.readonly) {
          reasons.push(
            `${raw}/${k}：${r.target.readonlyReason ?? '由代码维护'}，${READONLY_SUFFIX}`,
          );
          continue;
        }
      }
      if (isPlainObject(v)) scanValue(segs, v, `${raw}/${k}`, creatingPerson, depth + 1);
    }
  };
  for (const o of ops) {
    check(o.segments, o.path, o.hasValue ? o.value : undefined);
    if (o.op === 'move' && o.fromSegments) check(o.fromSegments, o.from ?? '');
  }
  return reasons;
}

// ========== 试算 ==========

/**
 * 不落库试算玩家编辑（§11.2）：逐条前值 → 后值，以及整批会不会被拒。
 *
 * 整批被拒的情形：路径或值里有只读键；写了时间；任一条被翻译层丢弃（玩家看不出半成功）；解析失败。
 * 纠正（`normalized`）不算失败，照常显示给玩家确认。
 *
 * @param ops 玩家编辑的 op
 * @param snapshot 当前内核状态（不会被修改）
 */
export function previewPlayerEdit(
  ops: readonly PlayerEditOp[],
  snapshot: TreeTranslateSnapshot,
): PlayerEditPreview {
  const empty = { records: [], dropped: [], normalized: [], translation: null };
  if (ops.length === 0) return { ok: false, reasons: ['没有要提交的修改'], ...empty };
  const parsed = parsePlayerOps(ops);
  if (!parsed.ok) return { ok: false, reasons: parsed.reasons, ...empty };
  const reasons = guardReasons(parsed.ops, snapshot);
  const translation = translateTreeOps(parsed.ops, snapshot, { actor: 'player' });
  if (translation.deltaMinutes > 0 && !reasons.some((r) => r.includes(TIME_REASON)))
    reasons.push(`${TIME_POINTER}：${TIME_REASON}`);
  // 只读与时间已经说过的条目不再重复报「已忽略」
  if (reasons.length === 0) reasons.push(...translation.dropped);
  return {
    ok: reasons.length === 0,
    reasons,
    records: translation.records,
    dropped: translation.dropped,
    normalized: translation.normalized,
    translation,
  };
}

// ========== 反向 op ==========

/**
 * 投影值 → 可写回的整实体值：剥掉 `_` 只读键；人物根把 `成长._属性` 还原成新建所需的 `成长.属性`。
 */
function writableValue(value: unknown, segments: readonly string[] | null): unknown {
  const personRoot = !!segments && segments[0] === '关系列表' && segments.length === 2;
  const strip = (v: unknown, depth: number, parentKey: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1, null));
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (isReadonlyKey(k)) {
        if (personRoot && depth === 1 && parentKey === '成长' && k === '_属性') {
          out['属性'] = strip(x, depth + 1, '属性');
        }
        continue;
      }
      out[k] = strip(x, depth + 1, k);
    }
    return out;
  };
  return strip(jsonClone(value), 0, null);
}

/** 路径终点是不是一个名字字典的条目（整实体），或变量、新闻标题这类可删的键。字典键取自词表。 */
function isEntryRootPath(segments: readonly string[] | null): boolean {
  if (!segments || segments.length < 2) return false;
  if (segments[0] === '变量') return true;
  if (segments[0] === '新闻') return segments.length === 3;
  return STATE_TREE_NAMED_RECORD_KEYS.has(segments[segments.length - 2]);
}

/** 投影里缺席的叶子对应的空值（投影省略空值，`装备` 里的数量 1 也省略）。认不出类型返回 undefined。 */
function emptyLeafValue(segments: readonly string[] | null, after: unknown): unknown {
  if (segments && segments[segments.length - 1] === '数量') return 1;
  // 档案文字不接受空串（纠正层丢弃），清不回去：不产 op，由快照兜底
  if (typeof after === 'string') return segments?.includes('档案') ? undefined : '';
  if (Array.isArray(after)) return [];
  if (isPlainObject(after)) return {};
  return undefined;
}

/** 被折叠 / 被消费的兄弟记录：宿主那条已经代表了它（撤销与补差都跳过）。读翻译层写的结构化标记。 */
function isSibling(record: StateUpdateOpRecord): boolean {
  return record.foldedInto !== undefined;
}

/**
 * 路径是不是「可减没条目」的 `数量` / `层数` 叶子；是则返回条目段与叶子键。
 * 判据与翻译层写 `entryBefore` 的同一份（词表 `STATE_TREE_DEPLETABLE_LEAF`）。
 */
function depletableLeaf(
  segs: readonly string[] | null,
): { entrySegs: readonly string[]; leaf: string } | null {
  if (!segs || segs.length < 4) return null;
  const n = segs.length;
  if (STATE_TREE_DEPLETABLE_LEAF[segs[n - 3]] !== segs[n - 1]) return null;
  return { entrySegs: segs.slice(0, -1), leaf: segs[n - 1] };
}

/** 「可减没条目」叶子所在的条目现在是否存在。 */
function entryExists(segs: readonly string[] | null, tree: StateTreeValue): boolean {
  const d = depletableLeaf(segs);
  return !!d && readStateTreeValue(tree, d.entrySegs) !== undefined;
}

/** JSON Pointer 去掉末段（条目叶子 → 条目根）。 */
function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

/**
 * 被本条减没的条目按 `entryBefore` 整对象重建的 add（§12.3）；`leafValue` 给出时把 `数量` / `层数` 设成它。
 * 不是这种记录返回 null；给了 `tree` 且条目现在已存在（之前重建过或又获得了）也返回 null，
 * 由调用方退回叶子 delta / replace —— 否则每撤销一次就多重建一件。
 */
function rebuildDepleted(
  record: StateUpdateOpRecord,
  segs: readonly string[] | null,
  leafValue?: number,
  tree?: StateTreeValue,
): PlayerEditOp | null {
  if (record.entryBefore === undefined) return null;
  if (tree && entryExists(segs, tree)) return null;
  if (record.op !== 'delta' && record.op !== 'replace' && record.op !== 'add') return null;
  const d = depletableLeaf(segs);
  if (!d || !isPlainObject(record.entryBefore)) return null;
  const value = writableValue(record.entryBefore, d.entrySegs) as Record<string, unknown>;
  if (leafValue !== undefined) value[d.leaf] = leafValue;
  return { op: 'add', path: parentPath(record.path), value };
}

/**
 * 变量数组插入（`add /变量/…/-` 或 `/…/<下标>`）：翻译层记的前后值是插入前后的整个父数组。
 * 认出来返回父数组路径，否则 null（下标写到对象键上是普通覆盖，不算）。
 */
function arrayInsert(record: StateUpdateOpRecord): { parent: string } | null {
  if (record.op !== 'add') return null;
  const segs = segmentsOf(record.path);
  if (!segs || segs[0] !== '变量' || segs.length < 4) return null;
  const last = segs[segs.length - 1];
  if (last !== '-' && !/^\d+$/.test(last)) return null;
  const { before, after } = record;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length !== before.length + 1)
    return null;
  return { parent: parentPath(record.path) };
}

/** 一条已生效记录的反向 op（不生效、兄弟行、时间行返回空）。 */
function inverseOf(record: StateUpdateOpRecord, tree?: StateTreeValue): PlayerEditOp[] {
  if (record.status === '已丢弃' || isSibling(record)) return [];
  const segs = segmentsOf(record.path);
  if (isTimePath(segs)) return [];
  const { path, before, after } = record;
  // 条目被本条减没了（用掉最后一件、层数到 0）且现在仍不存在：按记录的条目整对象前值重建
  const rebuilt = rebuildDepleted(record, segs, undefined, tree);
  if (rebuilt) return [rebuilt];
  // 数组插入：父数组整份写回插入前的样子（`replace …/-` 会被翻译成写一个名为「-」的键）
  const inserted = arrayInsert(record);
  if (inserted) return [{ op: 'replace', path: inserted.parent, value: jsonClone(before) }];
  switch (record.op) {
    case 'delta': {
      if (typeof before === 'number' && typeof after === 'number') {
        const diff = before - after;
        return diff === 0 ? [] : [{ op: 'delta', path, value: diff }];
      }
      return typeof record.value === 'number' && record.value !== 0
        ? [{ op: 'delta', path, value: -record.value }]
        : [];
    }
    case 'replace':
    case 'add': {
      if (before === undefined) {
        if (after === undefined) return [];
        if (isEntryRootPath(segs)) return [{ op: 'remove', path }];
        // 叶子在投影里缺席 = 空值（或数量 1），写回空值而不是删字段
        const empty = emptyLeafValue(segs, after);
        return empty === undefined ? [] : [{ op: 'replace', path, value: empty }];
      }
      if (sameValue(before, after)) return [];
      return [{ op: 'replace', path, value: writableValue(before, segs) }];
    }
    case 'remove':
      return before === undefined ? [] : [{ op: 'add', path, value: writableValue(before, segs) }];
    case 'move': {
      if (!record.from) return [];
      const fromSegs = segmentsOf(record.from);
      let value: unknown;
      // 从装备卸下（或移出）的反向是穿回原槽
      const fromEquip = !!fromSegs && fromSegs[fromSegs.length - 2] === '装备';
      if (fromEquip && isPlainObject(before) && typeof before['位置'] === 'string')
        value = before['位置'];
      else if (typeof record.value === 'number') value = record.value;
      return [
        {
          op: 'move',
          from: path,
          path: record.from,
          ...(value !== undefined ? { value } : {}),
        },
      ];
    }
  }
}

/**
 * 单行反向 op（更新块「撤销这一行」的基础，不看当前状态）：
 * 数值增量按实际前后差反向；覆盖还原前值、新建 → remove；remove ↔ add 按前值整对象重建（只读键剥除）；
 * move 反向（从装备移出的穿回原槽）。丢弃行、折叠兄弟行与时间行返回空。
 *
 * 🔴 变量修改器的撤销**不走这里**：它在 `StateManager.undoPlayerEdit` 里按内核快照整体还原
 *    （2026-11-25 审查 R4）。逐条反向 op 只留给更新块逐行撤销（主人裁定）。
 */
export function inverseOpsOf(record: StateUpdateOpRecord): PlayerEditOp[] {
  return inverseOf(record);
}

/**
 * 撤销凭据的指纹：被触及角色（id → 现状；null = 不存在）、档案、本楼记录的键序无关序列化。
 * `commitPlayerEdit` 用提交后的现状算一次，`undoPlayerEdit` 用撤销前的现状再算一次，不等即拒绝。
 */
export function playerEditFingerprint(parts: {
  readonly characters: Readonly<Record<string, CharacterState | null | undefined>>;
  readonly profile?: SaveProfile | null;
  readonly stateUpdates?: StateUpdateRecord | null;
}): string {
  const chars: Record<string, unknown> = {};
  for (const id of Object.keys(parts.characters)) chars[id] = parts.characters[id] ?? null;
  return canonical({
    characters: chars,
    ...(parts.profile !== undefined ? { profile: parts.profile ?? null } : {}),
    ...(parts.stateUpdates !== undefined ? { stateUpdates: parts.stateUpdates ?? null } : {}),
  });
}

// ========== 更新块补差 ==========

/**
 * 这条记录行能不能在更新块里修订（§12.3）；不能时返回原因，UI 据此把这行置为只读。
 * 时间、累计经验值（升级不可逆）、新建人物、登神长阶需回退本楼；把条目减没却缺整对象前值的行同样只读。
 *
 * 传 `action: 'edit'` 时再加「只能撤销、不能改值」的情形：叠加型 add（落在已有条目上的增量）里
 * 无法安全按差额补偿的那几类（见 `incrementalEditBlock`）。
 *
 * @param record 本楼的那一行
 * @param action 要做的修订；缺省 = 整行判定（撤销与改值都不行的情形）
 */
export function revisionBlockReason(
  record: StateUpdateOpRecord,
  action?: UpdateBlockRevision['kind'],
): string | null {
  const segs = segmentsOf(record.path);
  if (!segs) return null;
  const whole = wholeRowBlock(record, segs);
  if (whole) return whole;
  if (action === 'edit') return incrementalEditBlock(record, segs);
  return null;
}

function wholeRowBlock(record: StateUpdateOpRecord, segs: readonly string[]): string | null {
  if (isTimePath(segs)) return '时间不能在更新块里修订，需回退本楼';
  const last = segs[segs.length - 1];
  if (last === '累计经验值' && segs[segs.length - 2] === '成长')
    return '累计经验值（升级不可逆）不能在更新块里修订，需回退本楼';
  if (segs.includes('登神长阶')) return '登神长阶不能在更新块里修订，需回退本楼';
  if (
    segs[0] === '关系列表' &&
    segs.length === 2 &&
    (record.op === 'add' || record.op === 'replace') &&
    record.before === undefined
  )
    return '新建人物不能在更新块里修订，需回退本楼';
  // 把条目减没了却没有整对象前值（旧记录）：反向 op 会打在已不存在的条目上
  const d = depletableLeaf(segs);
  if (
    d &&
    segs[segs.length - 3] !== '装备' && // 装备的数量 1 在投影里省略，后值缺席不代表条目没了
    record.status !== '已丢弃' &&
    (record.op === 'delta' || record.op === 'replace' || record.op === 'add') &&
    record.before !== undefined &&
    record.after === undefined &&
    record.entryBefore === undefined
  )
    return '这一条把条目减没了，记录里没有条目原样，不能在更新块里修订，需回退本楼';
  // 新闻只增不删：撤销会变成再追加一条，改值同理（被丢弃的行仍可改好后重新应用）
  if (segs[0] === '新闻' && record.status !== '已丢弃') return NEWS_REASON;
  // 追加到数组末尾却认不出插入前后（记录不全）：反向 op 定位不到插入的那一项
  if (
    segs[0] === '变量' &&
    record.op === 'add' &&
    record.status !== '已丢弃' &&
    segs[segs.length - 1] === '-' &&
    !arrayInsert(record)
  )
    return '记录里认不出数组插入前后的样子，无法定位插入的那一项，需回退本楼';
  return null;
}

const NEWS_REASON = '新闻只增不删，无法在此撤销';

/** 叠加型 add（落在已有条目上，`before` 存在）。 */
function isStackingAdd(record: StateUpdateOpRecord): boolean {
  return record.op === 'add' && record.before !== undefined && record.status !== '已丢弃';
}

const ONLY_REVERT = '只能撤销，不能改值';

/**
 * 改值专属的封锁（§12.3）：add 落在已有条目上是增量语义，按目标值覆盖会改错（药水 3 + 2 = 5，
 * 把这行改成 +1 的意图是 4，覆盖却得 1）。背包物品按数量差额补偿（`planUpdateBlockRevision`），
 * 其余算不出安全差额的一律只能撤销。
 */
function incrementalEditBlock(record: StateUpdateOpRecord, segs: readonly string[]): string | null {
  const n = segs.length;
  if (segs[0] === '变量') {
    // 数组插入（`-` 或下标）：记录的前后值是整个父数组，改值无从对齐到那一项
    if (arrayInsert(record)) return `变量数组插入${ONLY_REVERT}`;
    return null;
  }
  if (!isStackingAdd(record)) return null;
  if (segs[n - 2] === '状态效果')
    return `叠加到已有状态上的 add ${ONLY_REVERT}（层数封顶与时长合并算不出差额）`;
  if (segs[n - 1] === '背包' || segs[n - 1] === '状态效果')
    return `整块 add 含叠加到已有条目的增量，${ONLY_REVERT}`;
  if ((segs[0] === '主角' && n === 1) || (segs[0] === '关系列表' && n === 2))
    return `对已有人物整对象 add 可能含叠加的增量，${ONLY_REVERT}`;
  return null;
}

/** 写入值里的物品数量（数字或含 `数量` 的对象；缺省 1，与翻译层「只叠数量」一致）。认不出返回 null。 */
function addQuantityOf(value: unknown): number | null {
  const raw = isPlainObject(value) ? value['数量'] : value;
  if (raw === undefined) return isPlainObject(value) ? 1 : null;
  const n = coerceNumber(raw, { integer: true });
  return n.ok && n.value > 0 ? n.value : null;
}

function readCurrent(tree: StateTreeValue, path: string): unknown {
  const segs = segmentsOf(path);
  return segs ? readStateTreeValue(tree, segs) : undefined;
}

/** 现值与记录的后值不符即冲突（move 还要求来源处仍为空）。 */
function findConflict(
  record: StateUpdateOpRecord,
  tree: StateTreeValue,
): Extract<RevisionPlan, { kind: 'conflict' }> | null {
  const checkPath = arrayInsert(record)?.parent ?? record.path;
  const current = readCurrent(tree, checkPath);
  if (!sameValue(current, record.after))
    return { kind: 'conflict', path: checkPath, expected: record.after, current };
  if (record.op === 'move' && record.from && record.from !== record.path) {
    const fromNow = readCurrent(tree, record.from);
    if (fromNow !== undefined)
      return { kind: 'conflict', path: record.from, expected: undefined, current: fromNow };
  }
  return null;
}

function finish(ops: PlayerEditOp[], snapshot: TreeTranslateSnapshot): RevisionPlan {
  if (ops.length === 0) return { kind: 'invalid', reasons: ['修订前后没有差别'] };
  const preview = previewPlayerEdit(ops, snapshot);
  if (!preview.ok) return { kind: 'invalid', reasons: preview.reasons };
  return { kind: 'ok', ops, preview };
}

/**
 * 更新块逐条补差（§12.3）：根据「记录的前值、记录的后值、玩家想要的结果」算出补偿 op，作用在当前状态上。
 *
 * - 改值：数值增量按差额补（原 −30 改 −10 就补 +20；钳制过的按「前值 + 新增量」与现值求差）；
 *   覆盖型按目标值设；新增条目改成整对象覆盖；叠在已有背包物品上的 add 按数量差额补；
 *   把条目减没的那条先按整对象前值重建、再设成新数量 / 层数。
 * - 撤销：同 `inverseOpsOf` 的单条反向。
 * - 重新应用 / 新增：原样（或改好后）的那条 op。
 *
 * 改值与撤销先核现值：已不等于记录的后值 → 返回冲突（含现值），`force` 时跳过。
 *
 * @param record 本楼的那一行（`append` 时可传 null）
 * @param revision 玩家想做的修订
 * @param currentSnapshot 当前内核状态（锁外读的即可；真正提交时写入口会在锁内重算）
 */
export function planUpdateBlockRevision(
  record: StateUpdateOpRecord | null,
  revision: UpdateBlockRevision,
  currentSnapshot: TreeTranslateSnapshot,
  options: RevisionOptions = {},
): RevisionPlan {
  if (revision.kind === 'append') return finish([revision.op], currentSnapshot);
  if (!record) return { kind: 'invalid', reasons: ['缺少要修订的记录行'] };
  if (isSibling(record))
    return { kind: 'invalid', reasons: ['这一行已并入同楼另一条 op，请修订那一条'] };
  const blocked = revisionBlockReason(record, revision.kind);
  if (blocked) return { kind: 'blocked', reason: blocked };

  if (revision.kind === 'reapply') {
    if (record.status !== '已丢弃')
      return { kind: 'invalid', reasons: ['只有被丢弃的行可以重新应用'] };
    const base: PlayerEditOp = revision.op ?? {
      op: record.op,
      path: record.path,
      ...(record.from !== undefined ? { from: record.from } : {}),
      ...(revision.value !== undefined
        ? { value: revision.value }
        : record.value !== undefined
          ? { value: record.value }
          : {}),
    };
    return finish([base], currentSnapshot);
  }

  if (record.status === '已丢弃')
    return { kind: 'invalid', reasons: ['被丢弃的行请改好后重新应用'] };
  if (revision.kind === 'edit' && (record.op === 'remove' || record.op === 'move'))
    return { kind: 'invalid', reasons: [`${record.op} 没有可改的值，请撤销后新增`] };

  const tree = fullTree(currentSnapshot);
  if (!options.force) {
    const conflict = findConflict(record, tree);
    if (conflict) return conflict;
  }

  if (revision.kind === 'revert') {
    // 强制：不再信任记录的后值，数值增量也按「设回前值」覆盖（其余动作的反向本来就是覆盖 / 重建）
    if (
      options.force &&
      record.op === 'delta' &&
      typeof record.before === 'number' &&
      (record.entryBefore === undefined || entryExists(segmentsOf(record.path), tree))
    )
      return finish([{ op: 'replace', path: record.path, value: record.before }], currentSnapshot);
    return finish(inverseOf(record, tree), currentSnapshot);
  }

  // edit
  const value = revision.value;
  const segs = segmentsOf(record.path);
  if (record.entryBefore !== undefined && depletableLeaf(segs) && !entryExists(segs, tree)) {
    // 条目已被本条减没：先按整对象前值重建，再把数量 / 层数设成「玩家想要的结果」
    if (typeof value !== 'number' || !Number.isFinite(value))
      return { kind: 'invalid', reasons: ['数量 / 层数必须是数字'] };
    const leafBefore = typeof record.before === 'number' ? record.before : 1;
    const target = record.op === 'delta' ? leafBefore + value : value;
    if (target <= 0) return finish([], currentSnapshot);
    const op = rebuildDepleted(record, segs, Math.round(target));
    return finish(op ? [op] : [], currentSnapshot);
  }
  if (isStackingAdd(record) && segs && segs[segs.length - 2] === '背包') {
    // 叠在已有物品上的 add 是增量：按「新增量 − 原增量」补数量差额
    const oldQ = addQuantityOf(record.value);
    const newQ = addQuantityOf(value);
    if (newQ === null) return { kind: 'invalid', reasons: ['数量必须是正整数'] };
    if (oldQ === null) return { kind: 'invalid', reasons: ['记录里没有可比较的数量'] };
    const diff = newQ - oldQ;
    return finish(
      diff === 0 ? [] : [{ op: 'delta', path: `${record.path}/数量`, value: diff }],
      currentSnapshot,
    );
  }
  switch (record.op) {
    case 'delta': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { kind: 'invalid', reasons: ['增量必须是数字'] };
      const current = readCurrent(tree, record.path);
      let diff: number;
      if (typeof record.before === 'number' && typeof current === 'number')
        diff = record.before + value - current;
      else if (typeof record.value === 'number') diff = value - record.value;
      else return { kind: 'invalid', reasons: ['记录里没有可比较的数值'] };
      return finish(
        diff === 0 ? [] : [{ op: 'delta', path: record.path, value: diff }],
        currentSnapshot,
      );
    }
    default:
      // replace / 非叠加的 add（remove / move 已在上面拒绝；叠加型 add 已在上面补差或被封锁）：按目标值整体覆盖
      return finish([{ op: 'replace', path: record.path, value }], currentSnapshot);
  }
}

/**
 * 补差提交成功后改写本楼记录（§12.3）：被修订行标「已手动修订」、后值取自这次提交的记录；
 * `append` 把这次提交的记录追加成新行。返回新对象，不改入参。
 *
 * @param update 本楼的 `ChatMessage.stateUpdates`
 * @param index 被修订行的下标（`append` 时忽略）
 * @param revision 已提交的修订
 * @param committed `commitPlayerEdit` 返回的记录
 */
export function applyRevisionToRecord(
  update: StateUpdateRecord,
  index: number | null,
  revision: UpdateBlockRevision,
  committed: readonly StateUpdateOpRecord[],
): StateUpdateRecord {
  const ops = update.ops.map((r) => ({ ...r }));
  if (revision.kind === 'append') {
    for (const c of committed) {
      if (c.status === '已丢弃') continue;
      ops.push({ ...jsonClone(c), status: '已手动修订', note: joinNote(c.note, '玩家新增') });
    }
    return { ...update, ops };
  }
  if (index === null || index < 0 || index >= ops.length) return { ...update, ops };
  const row = ops[index];
  const hit = committedAfter(row, committed);
  const next: StateUpdateOpRecord = { ...row, status: '已手动修订' };
  // 条目整对象前值只属于「本条把条目减没了」的那一刻：修订后若又减没了，取这次提交的；否则删掉
  if (revision.kind === 'revert' || revision.kind === 'edit') {
    if (hit?.entryBefore !== undefined) next.entryBefore = jsonClone(hit.entryBefore);
    else delete next.entryBefore;
  }
  if (revision.kind === 'revert') {
    next.note = joinNote(undefined, '玩家已撤销');
    setOptional(next, 'after', hit ? hit.after : row.before);
  } else if (revision.kind === 'edit') {
    next.value = jsonClone(revision.value);
    next.note = joinNote(undefined, '玩家已修订');
    if (hit) setOptional(next, 'after', hit.after);
  } else {
    const op = revision.op;
    if (op) {
      next.op = op.op;
      next.path = op.path;
      if (op.from !== undefined) next.from = op.from;
      else delete next.from;
      if (op.value !== undefined) next.value = jsonClone(op.value);
      else delete next.value;
    } else if (revision.value !== undefined) next.value = jsonClone(revision.value);
    next.note = joinNote(undefined, '玩家已改好后重新应用');
    const hit2 = [...committed]
      .reverse()
      .find((c) => c.path === next.path && c.status !== '已丢弃');
    if (hit2) setOptional(next, 'after', hit2.after);
  }
  ops[index] = next;
  return { ...update, ops };
}

/**
 * 从这次提交的记录里取被修订行的新后值。补偿 op 不一定落在行的路径上：
 * - 同一路径 → 直接取；
 * - 落在行的上层（重建整条目、数组整份写回）→ 从它的后值里按相对路径读下去；
 * - 落在行的下层（叠加 add 补到 `…/数量`）→ 在行原后值上把那一处换成它的后值。
 * 数组插入行以父数组为准（与冲突检查同一口径）。都对不上返回 null。
 */
function committedAfter(
  row: StateUpdateOpRecord,
  committed: readonly StateUpdateOpRecord[],
): { after: unknown; entryBefore?: unknown } | null {
  const rowPath = arrayInsert(row)?.parent ?? row.path;
  const rowSegs = segmentsOf(rowPath);
  if (!rowSegs) return null;
  for (const c of [...committed].reverse()) {
    if (c.status === '已丢弃') continue;
    const cs = segmentsOf(c.path);
    if (!cs) continue;
    if (startsWith(rowSegs, cs)) {
      const rel = rowSegs.slice(cs.length);
      return {
        after: rel.length === 0 ? c.after : readIn(c.after, rel),
        ...(rel.length === 0 && c.entryBefore !== undefined ? { entryBefore: c.entryBefore } : {}),
      };
    }
    if (startsWith(cs, rowSegs) && isPlainObject(row.after)) {
      const after = jsonClone(row.after);
      writeIn(after, cs.slice(rowSegs.length), c.after);
      return { after };
    }
  }
  return null;
}

function startsWith(full: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((s, i) => full[i] === s);
}

function readIn(value: unknown, rel: readonly string[]): unknown {
  let cur = value;
  for (const k of rel) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function writeIn(obj: Record<string, unknown>, rel: readonly string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < rel.length - 1; i++) {
    const next = cur[rel[i]];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  const last = rel[rel.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = jsonClone(value);
}

function joinNote(prev: string | undefined, note: string): string {
  return prev ? `${note}；${prev}` : note;
}

function setOptional(rec: StateUpdateOpRecord, key: 'after', value: unknown): void {
  if (value === undefined) delete rec[key];
  else rec[key] = jsonClone(value);
}
