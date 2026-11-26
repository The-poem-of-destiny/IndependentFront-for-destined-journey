/**
 * 世界 / 命运点数 / 地点 / 任务 / 新闻 / 变量的翻译（自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import { advanceTime } from '../../time/time-system';
import { createDefaultQuest, type CharacterState, type Quest } from '../../types/types';
import {
  coerceFatePointsDelta,
  coerceNumber,
  coerceQuestPriority,
  coerceQuestStatus,
  coerceText,
  coerceTimeAdvance,
  pickKnownKeys,
} from '../state-tree-codecs';
import type { ResolvedTreePath } from '../state-tree-patch';
import { UNCATEGORIZED_NEWS_COLUMN } from '../state-tree-projection';
import { stateTreeChildKeys, stateTreeKernelOf } from '../state-tree-spec';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import { VAR_NAMESPACES, getVar } from '../var-resolver';
import { Drop, charTarget, hasOwn, take, type OpContext } from './common';
import type { TranslatorHost } from './host';
import { QUEST_SPEC } from './rules';

const NAMESPACES = new Set<string>(Object.values(VAR_NAMESPACES));
const NAMESPACE_ROOT_REASON = '不能整块写或删变量命名空间，请写到 /变量/<命名空间>/<键>';

// ---------- 世界 / 命运点数 ----------

export function translateWorld(h: TranslatorHost, ctx: OpContext, t: ResolvedTreePath): void {
  const w = ctx.op;
  const key = t.segments[1];
  if (key === undefined) return h.expand(ctx, t);
  if (key === '时间') {
    if (w.op !== 'delta' && w.op !== 'replace' && w.op !== 'add')
      throw new Drop('时间只能 delta（分钟）或 replace 成时间串');
    const minutes = take(
      coerceTimeAdvance(w.op === 'delta' ? 'delta' : 'replace', w.value, h.state.profile.gameTime),
      ctx.notes,
    );
    ctx.value = w.op === 'delta' ? minutes : w.value;
    if (minutes > 0) {
      h.addDeltaMinutes(minutes);
      // 写时复制：换一份档案，不改旧版对象（已建的视图还要读它）
      h.setState({
        characters: h.state.characters,
        profile: {
          ...h.state.profile,
          gameTime: advanceTime(h.state.profile.gameTime, minutes),
        },
      });
    }
    return;
  }
  if (key === '地点') {
    const player = h.state.characters.find((c) => c.type === 'player');
    if (!player) throw new Drop('存档里没有主角');
    return setLocation(h, ctx, player);
  }
  throw new Drop(`「${key}」不可写`);
}

export function translateFatePoints(h: TranslatorHost, ctx: OpContext): void {
  const w = ctx.op;
  if (w.op !== 'delta' && w.op !== 'replace' && w.op !== 'add')
    throw new Drop('命运点数只能 replace 或 delta');
  const cur = h.state.profile.fp;
  const amount = take(
    coerceFatePointsDelta(cur, w.op === 'delta' ? 'delta' : 'replace', w.value),
    ctx.notes,
  );
  ctx.value = w.op === 'delta' ? amount : cur + amount;
  if (amount !== 0) h.commit([{ op: 'delta_variable', target: 'profile.fp', amount }]);
}

export function setLocation(h: TranslatorHost, ctx: OpContext, char: CharacterState): void {
  const w = ctx.op;
  if (w.op !== 'replace' && w.op !== 'add') throw new Drop('地点只能 replace');
  const loc = take(coerceText(w.value), ctx.notes);
  if (!loc) throw new Drop('地点不能为空');
  ctx.value = loc;
  if (loc === char.location) return;
  h.commit([{ op: 'set_location', target: charTarget(char.name), value: loc }]);
}

// ---------- 任务 ----------

export function translateQuest(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
): void {
  const w = ctx.op;
  if (!t.entry) return h.expand(ctx, t);
  const name = t.entry.name;
  const quests = h.state.profile.quests;
  const exists = hasOwn(quests, name);
  if (t.subPath.length === 0) {
    if (w.op === 'remove') {
      if (!exists) throw new Drop(`任务「${name}」不存在`);
      h.commit([{ op: 'remove_quest', target: 'quests', value: { name } }]);
      return;
    }
    if (w.op === 'move') {
      if (!f?.entry || f.root !== 'quests' || f.subPath.length > 0)
        throw new Drop('任务只能从任务条目 move');
      const old = quests[f.entry.name];
      if (!old) throw new Drop(`任务「${f.entry.name}」不存在`);
      if (exists) throw new Drop(`任务「${name}」已存在`);
      h.commit([
        { op: 'remove_quest', target: 'quests', value: { name: f.entry.name } },
        { op: 'update_quest', target: 'quests', value: { ...jsonClone(old), name } },
      ]);
      return;
    }
    if (w.op === 'delta') throw new Drop('任务不能 delta');
    if (!isPlainObject(w.value)) throw new Drop('写入任务需要对象');
    const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(QUEST_SPEC)), ctx.notes);
    const fields: Partial<Quest> = {};
    for (const [k, v] of Object.entries(picked)) Object.assign(fields, questField(k, v, ctx.notes));
    ctx.value = picked;
    const value = w.op === 'replace' ? { ...createDefaultQuest(), ...fields } : fields;
    if (!exists && fields.status === undefined) {
      value.status = '进行中';
      ctx.notes.push('缺少状态，兜底「进行中」');
    }
    h.commit([{ op: 'update_quest', target: 'quests', value: { name, ...value } }]);
    return;
  }
  if (w.op === 'remove') throw new Drop('任务字段不能删除，请用 replace');
  if (w.op === 'delta' || w.op === 'move') throw new Drop(`任务字段不能 ${w.op}`);
  const key = t.subPath[0];
  if (!exists) ctx.notes.push(`任务「${name}」不存在，已新建`);
  const fields = questField(key, w.value, ctx.notes);
  ctx.value = Object.values(fields)[0];
  h.commit([{ op: 'update_quest', target: 'quests', value: { name, ...fields } }]);
}

function questField(key: string, raw: unknown, notes: string[]): Partial<Quest> {
  const field = stateTreeKernelOf(QUEST_SPEC, key) as keyof Quest | undefined;
  if (!field) throw new Drop(`「${key}」不是任务字段`);
  if (field === 'status') return { status: take(coerceQuestStatus(raw), notes, key) };
  if (field === 'priority') return { priority: take(coerceQuestPriority(raw), notes, key) };
  return { [field]: take(coerceText(raw), notes, key) };
}

// ---------- 新闻（只增不删） ----------

export function translateNews(h: TranslatorHost, ctx: OpContext, t: ResolvedTreePath): void {
  const w = ctx.op;
  if (w.op === 'remove') throw new Drop('新闻只增不删');
  if (w.op === 'move' || w.op === 'delta') throw new Drop(`新闻不能 ${w.op}`);
  if (t.segments.length < 3) return h.expand(ctx, t);
  const column = t.segments[1];
  const title = t.segments[2];
  const content = take(coerceText(w.value), ctx.notes);
  if (!content) throw new Drop('新闻正文不能为空');
  const known = (h.state.profile.news ?? []).some((n) => n.category === column);
  const category = column === UNCATEGORIZED_NEWS_COLUMN && !known ? '' : column;
  if (t.entry?.exists) ctx.notes.push('新闻只增不删，已追加一条同标题新闻');
  ctx.value = content;
  h.commit([{ op: 'add_news', target: 'news', value: { title, content, category } }]);
}

// ---------- 变量（ADR-30 vars 空间） ----------

export function translateVariables(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
): void {
  const w = ctx.op;
  const vp = t.variablePath ?? [];
  if (vp.length === 0) throw new Drop('请写到具体变量（/变量/<命名空间>/…）');
  if (!NAMESPACES.has(vp[0]))
    throw new Drop(`变量顶层只认命名空间（${[...NAMESPACES].join(' / ')}）`);
  // 命名空间根不可整块写或删（AI 与玩家同样）：至少写到 /变量/<命名空间>/<键>
  if (vp.length < 2) throw new Drop(NAMESPACE_ROOT_REASON);
  const path = vp.join('.');
  const target = `variables.${path}`;
  const vars = h.state.profile.variables;
  switch (w.op) {
    case 'replace':
      h.commit([{ op: 'set_variable', target, value: jsonClone(w.value) }]);
      return;
    case 'add': {
      const last = vp[vp.length - 1];
      const parent = vp.slice(0, -1).join('.');
      const parentValue = vp.length > 1 ? getVar(vars, parent) : undefined;
      if (Array.isArray(parentValue) && (last === '-' || /^\d+$/.test(last))) {
        h.commit([
          {
            op: 'insert_variable',
            target: `variables.${parent}`,
            value: jsonClone(w.value),
            ...(last === '-' ? {} : { metadata: { index: Number(last) } }),
          },
        ]);
        // 记录读父数组（前后值 = 插入前后的整个数组）：撤销按前值整份写回，下标插入也一样
        ctx.pointer = t.pointer;
        ctx.segments = ['变量', ...vp.slice(0, -1)];
        return;
      }
      h.commit([{ op: 'set_variable', target, value: jsonClone(w.value) }]);
      return;
    }
    case 'remove':
      if (getVar(vars, path) === undefined) throw new Drop('变量不存在');
      h.commit([{ op: 'remove_variable', target }]);
      return;
    case 'delta': {
      const cur = getVar(vars, path);
      if (cur !== undefined && typeof cur !== 'number') throw new Drop('变量现值不是数值');
      const n = take(coerceNumber(w.value), ctx.notes);
      ctx.value = n;
      h.commit([{ op: 'delta_variable', target, amount: n }]);
      return;
    }
    case 'move': {
      const fp = f?.variablePath;
      if (f?.root !== 'variables' || !fp || fp.length === 0)
        throw new Drop('变量只能在 /变量 内 move');
      if (!NAMESPACES.has(fp[0]))
        throw new Drop(`变量顶层只认命名空间（${[...NAMESPACES].join(' / ')}）`);
      if (fp.length < 2) throw new Drop(`from：${NAMESPACE_ROOT_REASON}`);
      if (getVar(vars, fp.join('.')) === undefined) throw new Drop('from 变量不存在');
      h.commit([
        { op: 'move_variable', target: `variables.${fp.join('.')}`, metadata: { toPath: path } },
      ]);
      return;
    }
  }
}
