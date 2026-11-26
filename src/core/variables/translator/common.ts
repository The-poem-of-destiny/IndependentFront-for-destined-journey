/**
 * 翻译层内部共用：丢弃信号、工作 op / op 上下文类型与几个小工具（自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import { coerceNumber, type CodecResult } from '../state-tree-codecs';
import type { TreeOpKind, TreePathStyle } from '../state-tree-patch';
import type { StateTreeValue } from '../state-tree-projection';
import { isPlainObject } from '../state-tree-utils';

// ========== 内部类型 ==========

/** 丢弃信号：handler 里抛出，顶层收成「已丢弃」记录。 */
export class Drop extends Error {}

export interface WorkOp {
  readonly index: number;
  readonly op: TreeOpKind;
  readonly rawPath: string;
  readonly segments: readonly string[];
  readonly style: TreePathStyle;
  readonly value?: unknown;
  readonly hasValue: boolean;
  readonly fromRaw?: string;
  readonly fromSegments?: readonly string[];
  readonly fromStyle?: TreePathStyle;
  /** 折叠进本条的另一条 op 的序号（删一边加一边）。 */
  readonly foldedFrom?: number;
  readonly preNotes: readonly string[];
}

export interface OpContext {
  readonly op: WorkOp;
  readonly notes: string[];
  /** 解析后的路径（记录用）；解析不了时缺席。 */
  pointer?: string;
  segments?: readonly string[];
  fromPointer?: string;
  fromSegments?: readonly string[];
  /** 纠正后的写入值（树上的形状）。 */
  value?: unknown;
  hasValue: boolean;
  /** 本条消费掉的同批后续 op（槽位取自它们）。 */
  readonly consumed: number[];
  /** 记录里写的动作（纠正后与原动作不同时才给，如叠到已穿戴物品上的 add 记成 `装备/<物>/数量` 的 delta）。 */
  recordOp?: TreeOpKind;
}

export type Row = Record<string, unknown>;

// ========== 小工具 ==========

export function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 取纠正结果：失败抛 Drop；有说明记进 notes（带标签）。 */
export function take<T>(r: CodecResult<T>, notes: string[], label?: string): T {
  if (!r.ok) throw new Drop(label ? `${label}：${r.reason}` : r.reason);
  if (r.note) notes.push(label ? `${label}：${r.note}` : r.note);
  return r.value;
}

export const charTarget = (name: string): string => `characters.${name}`;

/** 整数写入（replace 取值、delta 加到现值上）。 */
export function numberWrite(
  ctx: OpContext,
  op: TreeOpKind,
  current: number,
  label: string,
): number {
  if (op !== 'replace' && op !== 'delta') throw new Drop(`${label}只能 replace 或 delta`);
  const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
  return op === 'delta' ? current + n : n;
}

/** 读树上某路径的值（投影出来的那棵）。 */
export function readStateTreeValue(
  tree: StateTreeValue | undefined,
  segments: readonly string[],
): StateTreeValue | undefined {
  let cur: StateTreeValue | undefined = tree;
  for (const s of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const i = Number(s);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else {
      if (!hasOwn(cur, s)) return undefined;
      cur = cur[s];
    }
  }
  return cur;
}

/** 在字典 / 文本数组叶子上按子键编辑（`效果/<词条>`、`标签/<序号>`）。 */
export function editKeyed(
  current: unknown,
  op: TreeOpKind,
  leafKey: string,
  value: unknown,
  asArray: boolean,
): unknown {
  if (asArray) {
    const arr = Array.isArray(current) ? [...(current as unknown[])] : [];
    const idx = leafKey === '-' ? arr.length : Number(leafKey);
    if (op === 'remove') {
      if (Number.isInteger(idx) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
      else {
        const at = arr.indexOf(leafKey);
        if (at < 0) throw new Drop(`标签里没有「${leafKey}」`);
        arr.splice(at, 1);
      }
      return arr;
    }
    if (!Number.isInteger(idx) || idx < 0) throw new Drop(`「${leafKey}」不是数组序号`);
    if (op === 'add') arr.splice(Math.min(idx, arr.length), 0, value);
    else arr[idx] = value;
    return arr;
  }
  const dict: Row = isPlainObject(current) ? { ...current } : {};
  if (op === 'remove') {
    if (!hasOwn(dict, leafKey)) throw new Drop(`没有子键「${leafKey}」`);
    delete dict[leafKey];
  } else if (op === 'delta') {
    const cur = typeof dict[leafKey] === 'number' ? (dict[leafKey] as number) : 0;
    const n = coerceNumber(value);
    if (!n.ok) throw new Drop(n.reason);
    dict[leafKey] = cur + n.value;
  } else {
    Object.defineProperty(dict, leafKey, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return dict;
}

/** 在普通对象上按段写值（`remove` 时删键）；中间缺的层补空对象。 */
export function setPlain(obj: Row, segs: readonly string[], value: unknown, remove: boolean): void {
  let cur: Row = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!isPlainObject(cur[s])) {
      if (remove) return;
      cur[s] = {};
    }
    cur = cur[s] as Row;
  }
  const last = segs[segs.length - 1];
  if (remove) delete cur[last];
  else
    Object.defineProperty(cur, last, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}
