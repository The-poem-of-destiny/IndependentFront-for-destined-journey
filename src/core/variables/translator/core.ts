/**
 * 翻译器本体：工作状态、补丁落地、op 折叠与逐条记录、按根分派（自 `state-tree-translator.ts` 拆出，行为不变）。
 * 各根的具体翻译在同目录的职责模块里，经 `TranslatorHost` 回调本体。
 */

import { reduceStatePatch, type ReducibleState } from '../../state/patch-reducer';
import { resolveCharacterByName, validateStatePatch } from '../../state/patch-rules';
import type { CharacterState, StatePatch, StateUpdateOpRecord } from '../../types/types';
import {
  resolveTreePath,
  type ResolvedTreePath,
  type TreeOp,
  type TreeOpKind,
  type TreePathStyle,
} from '../state-tree-patch';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import { Drop, errorText, type OpContext, type WorkOp } from './common';
import type { TranslatorHost } from './host';
import { translatePerson } from './person';
import { CAP_FIRST_KEYS } from './rules';
import type { TreeTranslateOptions, TreeTranslateResult, TreeTranslateSnapshot } from './types';
import {
  translateFatePoints,
  translateNews,
  translateQuest,
  translateVariables,
  translateWorld,
} from './world-quest-vars';
import { StateView, cowTouch, depletedEntry, workingReduceContext } from './working-state';

export class TreeTranslator implements TranslatorHost {
  /** 工作状态：入参的深拷贝，按补丁顺序经 patch-reducer 推进（后面的 op 看得到前面的结果）。 */
  state: ReducibleState;
  private readonly patches: StatePatch[] = [];
  private deltaMinutes = 0;
  readonly newCharacters: CharacterState[] = [];
  private readonly records = new Map<number, StateUpdateOpRecord>();
  private readonly dropped: string[] = [];
  private readonly normalized: string[] = [];
  /** 当前版本工作状态的视图（每次换状态时作废重建）。 */
  private currentView: StateView | null = null;
  queue: WorkOp[] = [];
  readonly consumed = new Set<number>();
  /** 被折叠 / 被消费的 op 序号 → 代表它落地的那条 op 序号（记录里转成 `foldedInto` / `mergedFrom`）。 */
  private readonly links = new Map<number, { host: number; kind: 'fold' | 'slot' }>();
  /** 本批开始时各人物的类别（按名；改名时跟着搬）。删人物按它判，不信本批中途的改动。 */
  readonly startTypes = new Map<string, CharacterState['type']>();

  constructor(
    snapshot: TreeTranslateSnapshot,
    readonly options: TreeTranslateOptions,
  ) {
    const prof = snapshot.profile;
    this.state = {
      characters: jsonClone([...snapshot.characters]),
      profile: {
        fp: typeof prof.fp === 'number' ? prof.fp : 0,
        quests: jsonClone(prof.quests ?? {}),
        news: jsonClone(prof.news ?? []),
        variables: jsonClone(prof.variables ?? {}),
        gameTime: jsonClone(prof.gameTime),
        affections: jsonClone(prof.affections ?? {}),
      },
    };
    for (const c of snapshot.characters) this.startTypes.set(c.name, c.type);
  }

  // ---------- 读工作状态 ----------

  /** 当前工作状态的树视图（按读到的分区惰性投影）。 */
  view(): StateView {
    this.currentView ??= new StateView(this.state);
    return this.currentView;
  }

  /** 换上新一版工作状态（旧版对象原样留给已建的视图读）。 */
  setState(next: ReducibleState): void {
    this.state = next;
    this.currentView = null;
  }

  addDeltaMinutes(minutes: number): void {
    this.deltaMinutes += minutes;
  }

  resolve(segments: readonly string[], style: TreePathStyle, notes: string[]): ResolvedTreePath {
    const r = resolveTreePath(
      segments,
      { characters: this.state.characters, profile: this.state.profile },
      style,
    );
    if (!r.ok) {
      // 背包条目没有 `位置` 键：给出裁定的说法（§5.3，不加 fitSlot）
      const n = segments.length;
      if (n >= 3 && segments[n - 1] === '位置' && segments[n - 3] === '背包') {
        throw new Drop('背包物品不记位置，穿戴请 move 到装备并写位置');
      }
      throw new Drop(r.reason);
    }
    notes.push(...r.notes);
    return r.target;
  }

  character(name: string): CharacterState {
    return resolveCharacterByName(this.state.characters, name);
  }

  // ---------- 落补丁 ----------

  /**
   * 一组补丁：在工作状态的写时副本上逐条跑 `patch-reducer`（与 StateManager 提交时同一份纯变换），
   * 全部成功才换上副本；任一条抛错整组不落，报错文案即提交时的报错。
   *
   * 写时复制（审查报告 R6a 性能修复）：副本只浅拷角色数组与档案，补丁要改的那几个角色 / 档案分区
   * 在作用前才深拷一份（`cowTouch`），其余对象与旧版共享 —— 旧版对象因此永不被改。
   */
  commit(group: readonly StatePatch[]): void {
    if (group.length === 0) return;
    const next: ReducibleState = {
      characters: [...this.state.characters],
      profile: { ...this.state.profile },
    };
    const copied = new Set<object>();
    const ctx = workingReduceContext(this.options.actor, next);
    for (const patch of group) {
      try {
        validateStatePatch(patch);
        cowTouch(next, patch, copied);
        // 补丁先深拷一份：reducer 会把补丁里的值并进状态，工作状态不与要提交的补丁共享引用
        // （structuredClone 保留 undefined 键，清除语义不丢）
        reduceStatePatch(next, structuredClone(patch), ctx);
      } catch (e) {
        throw new Drop(`${patch.op}（${patch.target}）：${errorText(e)}`);
      }
    }
    this.setState(next);
    this.patches.push(...group);
  }

  // ---------- 入口 ----------

  run(ops: readonly TreeOp[]): TreeTranslateResult {
    const parseNotes = new Map<number, string[]>();
    for (const n of this.options.parseNormalized ?? []) {
      if (n.index < 0) continue;
      parseNotes.set(n.index, [...(parseNotes.get(n.index) ?? []), n.message]);
    }
    const work: WorkOp[] = ops.map((o) => ({
      index: o.index,
      op: o.op,
      rawPath: o.path,
      segments: o.segments,
      style: o.pathStyle,
      ...(o.hasValue ? { value: o.value } : {}),
      hasValue: o.hasValue,
      ...(o.fromSegments
        ? { fromRaw: o.from, fromSegments: o.fromSegments, fromStyle: o.fromStyle }
        : {}),
      preNotes: parseNotes.get(o.index) ?? [],
    }));
    this.queue = this.fold(work);
    // 新建人物先落（§4.3）
    const creations = this.queue.filter((w) => this.isCreation(w));
    const rest = this.queue.filter((w) => !creations.includes(w));
    for (const w of [...creations, ...rest]) {
      if (this.consumed.has(w.index)) continue;
      this.process(w);
    }
    return {
      patches: this.patches,
      deltaMinutes: this.deltaMinutes,
      newCharacters: this.newCharacters,
      records: this.linkedRecords(),
      dropped: this.dropped,
      normalized: this.normalized,
    };
  }

  /** 记录按 op 序号排好，并把折叠关系写成结构化下标（`ops` 数组位置，不是 op 序号）。 */
  private linkedRecords(): StateUpdateOpRecord[] {
    const sorted = [...this.records.entries()].sort((a, b) => a[0] - b[0]);
    const position = new Map(sorted.map(([index], pos) => [index, pos]));
    const out = sorted.map((e) => e[1]);
    for (const [index, link] of this.links) {
      const pos = position.get(index);
      const hostPos = position.get(link.host);
      if (pos === undefined || hostPos === undefined) continue;
      out[pos].foldedInto = hostPos;
      out[pos].foldKind = link.kind;
      const host = out[hostPos];
      host.mergedFrom = [...(host.mergedFrom ?? []), pos].sort((a, b) => a - b);
    }
    return out;
  }

  private isCreation(w: WorkOp): boolean {
    if ((w.op !== 'add' && w.op !== 'replace') || !isPlainObject(w.value)) return false;
    try {
      const t = this.resolve(w.segments, w.style, []);
      return (
        t.root === 'relation' &&
        t.segments.length === 2 &&
        t.person !== undefined &&
        !t.person.exists
      );
    } catch {
      return false;
    }
  }

  /** 同批「删一边、加一边」（背包 ↔ 装备，同人同物）折叠成一条 move（§5.3）。 */
  private fold(work: WorkOp[]): WorkOp[] {
    const info = work.map((w) => {
      if (w.op !== 'remove' && w.op !== 'add') return null;
      try {
        const t = this.resolve(w.segments, w.style, []);
        const e = t.entry;
        if (!t.isEntryRoot || !t.person || !e || (e.record !== '背包' && e.record !== '装备'))
          return null;
        return {
          person: t.person.name,
          item: e.name,
          dict: e.record,
          exists: e.exists,
          loc: e.itemLocation,
          t,
        };
      } catch {
        return null;
      }
    });
    const out = [...work];
    const used = new Set<number>();
    for (let i = 0; i < work.length; i++) {
      const a = info[i];
      if (!a || used.has(i)) continue;
      for (let j = i + 1; j < work.length; j++) {
        const b = info[j];
        if (!b || used.has(j) || b.person !== a.person || b.item !== a.item || b.dict === a.dict)
          continue;
        if (work[i].op === work[j].op) continue;
        const rm = work[i].op === 'remove' ? a : b;
        const add = work[i].op === 'remove' ? work[j] : work[i];
        const removed = work[i].op === 'remove' ? work[i] : work[j];
        // 只折叠「物品确实在被删的那一边」的情形
        const expected = rm.dict === '背包' ? 'bag' : 'equipped';
        if (!rm.exists || rm.loc !== expected) continue;
        used.add(i);
        used.add(j);
        out[i] = {
          index: work[i].index,
          op: 'move',
          rawPath: add.rawPath,
          segments: add.segments,
          style: add.style,
          ...(add.hasValue ? { value: add.value } : {}),
          hasValue: add.hasValue,
          fromRaw: removed.rawPath,
          fromSegments: removed.segments,
          fromStyle: removed.style,
          foldedFrom: work[j].index,
          preNotes: [
            ...work[i].preNotes,
            ...work[j].preNotes,
            `与第 ${work[j].index + 1} 条（删一边、加一边）折叠成 move`,
          ],
        };
        this.consumed.add(work[j].index);
        break;
      }
    }
    return out;
  }

  private process(w: WorkOp): void {
    const ctx: OpContext = {
      op: w,
      notes: [...w.preNotes],
      hasValue: w.hasValue,
      ...(w.hasValue ? { value: jsonClone(w.value) } : {}),
      consumed: [],
    };
    const beforeTree = this.view();
    try {
      this.translate(ctx);
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      this.record(ctx, beforeTree, beforeTree, e.message);
      if (w.foldedFrom !== undefined)
        this.recordSibling(
          w.foldedFrom,
          ctx,
          beforeTree,
          beforeTree,
          `随第 ${w.index + 1} 条一并丢弃`,
          true,
          'fold',
        );
      return;
    }
    const afterTree = this.view();
    this.record(ctx, beforeTree, afterTree);
    if (w.foldedFrom !== undefined)
      this.recordSibling(
        w.foldedFrom,
        ctx,
        beforeTree,
        afterTree,
        `已与第 ${w.index + 1} 条折叠成 move`,
        false,
        'fold',
      );
    for (const idx of ctx.consumed) {
      this.consumed.add(idx);
      this.recordSibling(
        idx,
        ctx,
        beforeTree,
        afterTree,
        `位置已并入第 ${w.index + 1} 条的穿戴`,
        false,
        'slot',
      );
    }
  }

  private record(
    ctx: OpContext,
    beforeTree: StateView,
    afterTree: StateView,
    dropReason?: string,
  ): void {
    const w = ctx.op;
    const path = ctx.pointer ?? w.rawPath;
    const rec: StateUpdateOpRecord = { path, op: ctx.recordOp ?? w.op, status: '已应用' };
    if (w.op === 'move') rec.from = ctx.fromPointer ?? w.fromRaw;
    if (w.op !== 'remove' && ctx.hasValue) rec.value = jsonClone(ctx.value);
    const segs = ctx.segments;
    const fromSegs = ctx.fromSegments;
    const before =
      w.op === 'move' && fromSegs
        ? beforeTree.read(fromSegs)
        : segs
          ? beforeTree.read(segs)
          : undefined;
    const after = segs ? afterTree.read(segs) : undefined;
    if (before !== undefined) rec.before = jsonClone(before);
    if (
      dropReason === undefined &&
      segs &&
      (w.op === 'delta' || w.op === 'replace' || w.op === 'add')
    ) {
      const entry = depletedEntry(segs, beforeTree, afterTree);
      if (entry !== undefined) rec.entryBefore = jsonClone(entry);
    }
    if (dropReason !== undefined) {
      rec.status = '已丢弃';
      const notes = [...ctx.notes];
      rec.note = [dropReason, ...notes].join('；');
      if (before !== undefined) rec.after = jsonClone(before);
      this.dropped.push(`${w.rawPath || path}：${dropReason}，已忽略`);
    } else {
      if (after !== undefined) rec.after = jsonClone(after);
      if (ctx.notes.length > 0) {
        rec.status = '已纠正';
        rec.note = ctx.notes.join('；');
        for (const n of ctx.notes) this.normalized.push(`${path}：${n}`);
      }
    }
    this.records.set(w.index, rec);
  }

  /** 被折叠或被消费的那条 op 的记录。 */
  private recordSibling(
    index: number,
    host: OpContext,
    beforeTree: StateView,
    afterTree: StateView,
    note: string,
    dropped: boolean,
    kind: 'fold' | 'slot',
  ): void {
    this.links.set(index, { host: host.op.index, kind });
    const w = this.queue.find((q) => q.index === index) ?? null;
    const raw = w?.rawPath ?? '';
    const op: TreeOpKind = w?.op ?? 'replace';
    const segs = host.segments;
    const rec: StateUpdateOpRecord = {
      path: raw,
      op,
      status: dropped ? '已丢弃' : '已纠正',
      note,
    };
    if (w?.hasValue) rec.value = jsonClone(w.value);
    const before = segs ? beforeTree.read(segs) : undefined;
    const after = segs ? (dropped ? beforeTree : afterTree).read(segs) : undefined;
    if (before !== undefined) rec.before = jsonClone(before);
    if (after !== undefined) rec.after = jsonClone(after);
    if (dropped) this.dropped.push(`${raw}：${note}，已忽略`);
    else this.normalized.push(`${raw}：${note}`);
    this.records.set(index, rec);
  }

  // ---------- 分派 ----------

  private translate(ctx: OpContext): void {
    const w = ctx.op;
    const t = this.resolve(w.segments, w.style, ctx.notes);
    ctx.pointer = t.pointer;
    ctx.segments = t.segments;
    let f: ResolvedTreePath | undefined;
    if (w.op === 'move') {
      if (!w.fromSegments) throw new Drop('move 缺少 from');
      f = this.resolve(w.fromSegments, w.fromStyle ?? 'pointer', ctx.notes);
      ctx.fromPointer = f.pointer;
      ctx.fromSegments = f.segments;
      if (f.readonly) throw new Drop(`from：${f.readonlyReason ?? '只读'}`);
      if (f.root !== t.root && !(isPersonRoot(f.root) && isPersonRoot(t.root)))
        throw new Drop('move 不能跨区移动');
    }
    if (t.readonly) throw new Drop(t.readonlyReason ?? '由代码维护');
    switch (t.root) {
      case 'world':
        return translateWorld(this, ctx, t);
      case 'fatePoints':
        return translateFatePoints(this, ctx);
      case 'player':
      case 'relation':
        return translatePerson(this, ctx, t, f);
      case 'quests':
        return translateQuest(this, ctx, t, f);
      case 'news':
        return translateNews(this, ctx, t);
      case 'variables':
        return translateVariables(this, ctx, t, f);
    }
  }

  /** 把一个对象写入展开成逐键子 op（分支写成整对象、已有人物整对象写入）。 */
  expand(ctx: OpContext, t: ResolvedTreePath, note?: string): void {
    const w = ctx.op;
    if (w.op === 'remove') throw new Drop('不能删除整个分支，请删具体条目');
    if (w.op !== 'add' && w.op !== 'replace')
      throw new Drop(`${w.op} 不能用在分支「${t.pattern}」上`);
    if (!isPlainObject(w.value)) throw new Drop('写入分支需要对象');
    if (note) ctx.notes.push(note);
    let ok = 0;
    // 「上限」「额外」先于「当前」展开：当前值按上限钳制，整对象写资源（如
    // `{当前:6000,上限:7000}`）若先写当前，会被旧上限钳掉 —— 结果不能依赖模型写的键序（A7）。
    // 稳定排序：其余键保持原有相对顺序。
    const keys = Object.keys(w.value).sort(
      (a, b) => Number(!CAP_FIRST_KEYS.has(a)) - Number(!CAP_FIRST_KEYS.has(b)),
    );
    for (const key of keys) {
      const sub: OpContext = {
        op: {
          index: w.index,
          op: w.op,
          rawPath: `${t.pointer}/${key}`,
          segments: [...t.segments, key],
          style: 'array',
          value: w.value[key],
          hasValue: true,
          preNotes: [],
        },
        notes: [],
        hasValue: true,
        value: jsonClone(w.value[key]),
        consumed: ctx.consumed,
      };
      try {
        this.translate(sub);
        ok++;
        for (const n of sub.notes) ctx.notes.push(`${key}：${n}`);
      } catch (e) {
        if (!(e instanceof Drop)) throw e;
        ctx.notes.push(`${key}：${e.message}，已忽略`);
      }
    }
    if (keys.length > 0 && ok === 0) throw new Drop('对象里的每个键都写不进去');
  }
}

function isPersonRoot(root: ResolvedTreePath['root']): boolean {
  return root === 'player' || root === 'relation';
}
