/**
 * 每楼变量更新块的展示层判定（状态树协议 T13，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §12）
 *
 * 纯函数，不 mount 可测（照 `character-viewer.ts` / `state-editor-view.ts` 的先例）：
 * - 显不显示（已接纳、带记录、逐节演出放完）、哪一楼是「最新一楼」、可不可改及原因；
 * - 记录 → 行视图（路径、动作、前值 → 后值、状态标记、从属行、每行能做什么）；
 * - 编辑输入的解析（改值 / 重新应用 / 新增一条）；
 * - 更早楼层「在变量修改器中打开此路径」的落点。
 *
 * 🔴 已裁定（§9）：逐条补差（#16）、模型原文不落消息（#17，从调试记录读）、手改不告知模型（#18）。
 *    本模块不产任何「玩家修正」提示。
 * 🔴 `foldedInto` / `mergedFrom` 是 ops 数组下标：这里只读，绝不删行或重排。
 */

import type {
  ChatMessage,
  DebugTurnRecord,
  StateTreeOpAction,
  StateUpdateOpRecord,
  StateUpdateOpStatus,
  StateUpdateRecord,
} from '@engine/types/types';
import { revisionBlockReason, type PlayerEditOp } from '@engine/variables/state-tree-edit';
import { isDiscardedAttempt } from '../../lib/turn-recovery';
import {
  findEditorNode,
  formatEditorValue,
  parentPointer,
  type EditorNode,
} from './state-editor-view';

// ═══════════════════════════════════════════════════════════
// 显示与「最新一楼」
// ═══════════════════════════════════════════════════════════

/** 已接纳的正文楼层（pending / failed 不算；旧消息无状态字段视作已接纳）。 */
function isAcceptedNarrative(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant' || msg.diagnostic || isDiscardedAttempt(msg)) return false;
  return msg.storyTurnStatus === undefined || msg.storyTurnStatus === 'accepted';
}

/**
 * 这条消息下要不要挂更新块（§12.1、§12.4）：已接纳的正文、带非空记录（只有 tree 协议有）、
 * 逐节演出已放完（与行动选项同一时机）。流式期间消息还是 pending，不显示。
 *
 * @param stageFinished 这条消息的逐节演出是否已放完（没在演出 = true）
 */
export function shouldShowUpdateBlock(msg: ChatMessage, stageFinished: boolean): boolean {
  if (!isAcceptedNarrative(msg)) return false;
  if (!msg.stateUpdates || msg.stateUpdates.ops.length === 0) return false;
  return stageFinished;
}

/**
 * 最新一楼的消息 id：最后一条已接纳的正文楼层（不论它有没有记录）。
 * 它没有记录时返回 null —— 更早楼层的记录一律只读（前值 / 后值已被清掉）。
 */
export function latestUpdateFloorId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isAcceptedNarrative(msg)) continue;
    return msg.stateUpdates ? msg.id : null;
  }
  return null;
}

export interface UpdateBlockEditability {
  /** 是最新一楼（可改那一楼）。 */
  readonly latest: boolean;
  /** 现在能改（最新一楼且没被锁）。 */
  readonly editable: boolean;
  /** 最新一楼但被锁时的原因；其余为空串。 */
  readonly lockReason: string;
}

/**
 * 可改判定（§12.3）：只有最新一楼可改；回合生成中、润色中、战斗中不可改
 * （锁定原因由调用方传入，复用变量修改器同一组判据 `stateEditorLockReason`）。
 */
export function updateBlockEditability(
  msg: ChatMessage,
  messages: readonly ChatMessage[],
  lockReason: string,
): UpdateBlockEditability {
  const latest = latestUpdateFloorId(messages) === msg.id;
  if (!latest) return { latest: false, editable: false, lockReason: '' };
  return { latest: true, editable: lockReason === '', lockReason };
}

// ═══════════════════════════════════════════════════════════
// 行视图
// ═══════════════════════════════════════════════════════════

const OP_LABELS: Readonly<Record<StateTreeOpAction, string>> = {
  replace: '修改',
  add: '新增',
  remove: '删除',
  delta: '增减',
  move: '移动',
};

function opLabel(op: StateTreeOpAction): string {
  return OP_LABELS[op] ?? op;
}

/** 状态标记的语气（样式用）；已应用无标记。 */
export type UpdateRowTone = 'applied' | 'corrected' | 'dropped' | 'revised';

const TONE_OF: Readonly<Record<StateUpdateOpStatus, UpdateRowTone>> = {
  已应用: 'applied',
  已纠正: 'corrected',
  已丢弃: 'dropped',
  已手动修订: 'revised',
};

interface UpdateRowActions {
  /** 改一条已生效 op 的值。 */
  readonly edit: boolean;
  /** 撤销一条已生效的 op。 */
  readonly revert: boolean;
  /** 被丢弃的 op 改好后重新应用。 */
  readonly reapply: boolean;
}

export interface UpdateRowView {
  /** 在 `ops` 里的下标（修订时原样交回）。 */
  readonly index: number;
  readonly path: string;
  readonly from?: string;
  readonly op: StateTreeOpAction;
  readonly opLabel: string;
  /** 写入值的文字（remove 缺席）。 */
  readonly valueText?: string;
  /** 前值 → 后值；记录里两者都缺席时为 null（更早楼层已清掉）。 */
  readonly change: { readonly before: string; readonly after: string } | null;
  readonly status: StateUpdateOpStatus;
  readonly tone: UpdateRowTone;
  /** 状态标记文字（已应用为 null）。 */
  readonly badge: string | null;
  readonly note?: string;
  /** 从属行：已并入第 N 条（1 起，给人看）。 */
  readonly foldedIntoNo: number | null;
  /** 本行吸收了哪些行（1 起）。 */
  readonly mergedFromNos: readonly number[];
  /** 这一行不能在更新块里修订的原因（时间、累计经验值、新建人物、登神长阶）。 */
  readonly blockedReason: string | null;
  readonly actions: UpdateRowActions;
}

export interface UpdateBlockView {
  /** 「本楼状态更新 N 项」的 N：不计从属行。 */
  readonly count: number;
  readonly corrected: number;
  readonly dropped: number;
  readonly revised: number;
  readonly deltaMinutes: number;
  readonly rows: readonly UpdateRowView[];
}

const NO_ACTIONS: UpdateRowActions = { edit: false, revert: false, reapply: false };

function rowActions(record: StateUpdateOpRecord, blocked: string | null): UpdateRowActions {
  if (record.foldedInto !== undefined || blocked) return NO_ACTIONS;
  if (record.status === '已丢弃') return { edit: false, revert: false, reapply: true };
  return {
    // 叠加型 add 里算不出安全差额的只能撤销（引擎同一判据，补差时同样会被拒）
    edit: record.op !== 'remove' && record.op !== 'move' && !revisionBlockReason(record, 'edit'),
    revert: true,
    reapply: false,
  };
}

/**
 * 记录 → 行视图。`editable` 为假（更早楼层或被锁）时每行都不给动作；
 * blocked 原因也只在可改时显示（只读楼层整块只读，不必逐行说明）。
 */
export function buildUpdateBlockView(
  record: StateUpdateRecord,
  editable: boolean,
): UpdateBlockView {
  let count = 0;
  let corrected = 0;
  let dropped = 0;
  let revised = 0;
  const rows = record.ops.map((r, index): UpdateRowView => {
    const folded = r.foldedInto !== undefined;
    if (!folded) {
      count++;
      if (r.status === '已纠正') corrected++;
      else if (r.status === '已丢弃') dropped++;
      else if (r.status === '已手动修订') revised++;
    }
    const blocked = folded ? null : revisionBlockReason(r);
    const hasChange = r.before !== undefined || r.after !== undefined;
    return {
      index,
      path: r.path,
      ...(r.from !== undefined ? { from: r.from } : {}),
      op: r.op,
      opLabel: opLabel(r.op),
      ...(r.op !== 'remove' && r.value !== undefined
        ? { valueText: formatEditorValue(r.value) }
        : {}),
      change: hasChange
        ? {
            before: formatEditorValue(r.before),
            after:
              r.op === 'remove' && r.after === undefined ? '（删除）' : formatEditorValue(r.after),
          }
        : null,
      status: r.status,
      tone: TONE_OF[r.status] ?? 'applied',
      badge: r.status === '已应用' ? null : r.status,
      ...(r.note ? { note: r.note } : {}),
      foldedIntoNo: folded ? r.foldedInto! + 1 : null,
      mergedFromNos: (r.mergedFrom ?? []).map((i) => i + 1),
      blockedReason: editable ? blocked : null,
      actions: editable ? rowActions(r, blocked) : NO_ACTIONS,
    };
  });
  return { count, corrected, dropped, revised, deltaMinutes: record.deltaMinutes, rows };
}

/** 标题行的计数角标（有纠正 / 丢弃 / 手动修订才出）。 */
export function updateBlockBadges(
  view: Pick<UpdateBlockView, 'corrected' | 'dropped' | 'revised'>,
): { tone: UpdateRowTone; text: string }[] {
  const out: { tone: UpdateRowTone; text: string }[] = [];
  if (view.corrected > 0) out.push({ tone: 'corrected', text: `纠正 ${view.corrected}` });
  if (view.dropped > 0) out.push({ tone: 'dropped', text: `丢弃 ${view.dropped}` });
  if (view.revised > 0) out.push({ tone: 'revised', text: `手改 ${view.revised}` });
  return out;
}

// ═══════════════════════════════════════════════════════════
// 编辑输入
// ═══════════════════════════════════════════════════════════

export type ParsedInput = { ok: true; value: unknown } | { ok: false; reason: string };

/** 值 → 编辑框初始文字（与 `parseRevisionInput` 互逆）。 */
export function revisionInputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return JSON.stringify(value);
}

const TRUE_WORDS = new Set(['是', 'true', '真']);
const FALSE_WORDS = new Set(['否', 'false', '假']);

/**
 * 编辑框文字 → 值，按「原值的类型」解析：数字只收有限数，布尔收 是/否，
 * 对象 / 数组收 JSON，文本原样。原值缺席时按 `parseLooseValue` 猜。
 */
export function parseRevisionInput(template: unknown, text: string): ParsedInput {
  const t = text.trim();
  if (typeof template === 'number') {
    const n = Number(t);
    return t !== '' && Number.isFinite(n)
      ? { ok: true, value: n }
      : { ok: false, reason: '请输入数字' };
  }
  if (typeof template === 'boolean') {
    if (TRUE_WORDS.has(t.toLowerCase())) return { ok: true, value: true };
    if (FALSE_WORDS.has(t.toLowerCase())) return { ok: true, value: false };
    return { ok: false, reason: '请输入「是」或「否」' };
  }
  if (typeof template === 'string') return { ok: true, value: text };
  if (template !== undefined && template !== null) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(template) !== Array.isArray(v) || typeof v !== 'object' || v === null)
        return {
          ok: false,
          reason: Array.isArray(template) ? '请输入 JSON 数组' : '请输入 JSON 对象',
        };
      return { ok: true, value: v };
    } catch {
      return { ok: false, reason: '不是合法的 JSON' };
    }
  }
  return parseLooseValue(text);
}

/** 没有类型参照时的宽松解析：数字 → 数字，是/否 → 布尔，JSON 对象 / 数组 → 结构，其余文本。 */
export function parseLooseValue(text: string): ParsedInput {
  const t = text.trim();
  if (t === '') return { ok: false, reason: '请输入值' };
  const n = Number(t);
  if (Number.isFinite(n) && /^[-+]?\d/.test(t)) return { ok: true, value: n };
  if (TRUE_WORDS.has(t.toLowerCase())) return { ok: true, value: true };
  if (FALSE_WORDS.has(t.toLowerCase())) return { ok: true, value: false };
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { ok: true, value: JSON.parse(t) as unknown };
    } catch {
      return { ok: false, reason: '不是合法的 JSON' };
    }
  }
  return { ok: true, value: text };
}

/** 「新增一条」可选的动作（move 要两个路径，第一期不在更新块里给）。 */
export const APPEND_OPS: readonly { op: PlayerEditOp['op']; label: string }[] = [
  { op: 'replace', label: '修改' },
  { op: 'add', label: '新增' },
  { op: 'delta', label: '增减' },
  { op: 'remove', label: '删除' },
];

export type ParsedAppend = { ok: true; op: PlayerEditOp } | { ok: false; reason: string };

/** 「新增一条」表单 → op。路径必须以 `/` 开头；增减只收数字；删除不要值。 */
export function parseAppendInput(
  op: PlayerEditOp['op'],
  pathText: string,
  valueText: string,
): ParsedAppend {
  const path = pathText.trim();
  if (!path.startsWith('/') || path.length < 2)
    return { ok: false, reason: '路径要以 / 开头，例如 /主角/生命值/当前' };
  if (op === 'remove') return { ok: true, op: { op, path } };
  const parsed = op === 'delta' ? parseRevisionInput(0, valueText) : parseLooseValue(valueText);
  if (!parsed.ok) return parsed;
  return { ok: true, op: { op, path, value: parsed.value } };
}

// ═══════════════════════════════════════════════════════════
// 查看原文（调试记录）
// ═══════════════════════════════════════════════════════════

/**
 * 本楼模型原文（§12.1 次级入口、§9 #17：不落消息，从调试记录读）。
 * 按这条正文之前最近的玩家输入找调试回合（同一输入重试多次取最新一个完成的），
 * 取其中最后一次有原文且无错误的直出主生成。取不到返回 null（入口不显示）。
 */
export function findRawResponse(
  msg: ChatMessage,
  messages: readonly ChatMessage[],
  history: readonly DebugTurnRecord[],
): string | null {
  const at = messages.findIndex((m) => m.id === msg.id);
  if (at < 0) return null;
  let userId: string | null = null;
  for (let i = at - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userId = messages[i].id;
      break;
    }
  }
  if (!userId) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.sourceMessageId !== userId || turn.status !== 'completed') continue;
    for (let j = turn.entries.length - 1; j >= 0; j--) {
      const e = turn.entries[j];
      if (e.agentId === 'direct_main' && !e.error && e.rawResponse.trim()) return e.rawResponse;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 跳转到变量修改器
// ═══════════════════════════════════════════════════════════

/** 更早楼层每行跳转的目标路径：move 跳到去处（来源已空），其余就是本行路径。 */
export function editorJumpPath(row: Pick<StateUpdateOpRecord, 'path' | 'op'>): string {
  return row.path;
}

export interface EditorFocus {
  /** 左栏要选中的节点。 */
  readonly nodePath: string;
  /** 要展开的祖先节点（含自身）。 */
  readonly expand: readonly string[];
  /** 右栏要滚到的字段（路径恰好是该节点下的字段时）。 */
  readonly fieldPath?: string;
}

/**
 * 变量修改器的落点：从目标路径逐级往上找第一个存在的树节点（叶子路径落到持有它的节点；
 * 已被删掉的条目落到它的上级）。一个都找不到返回 null（面板照常打开在默认位置）。
 */
export function resolveEditorFocus(nodes: readonly EditorNode[], path: string): EditorFocus | null {
  let p = path;
  let node: EditorNode | undefined;
  while (p) {
    node = findEditorNode(nodes, p);
    if (node) break;
    p = parentPointer(p);
  }
  if (!node) return null;
  const expand: string[] = [];
  for (let q = node.path; q; q = parentPointer(q)) expand.unshift(q);
  const field = node.fields.find((f) => f.path === path);
  return { nodePath: node.path, expand, ...(field ? { fieldPath: field.path } : {}) };
}
