/**
 * 技能与状态效果的翻译（自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import { findByName } from '../../state/patch-reducer';
import type { CharacterState, Skill, StatusEffect } from '../../types/types';
import { coerceNumber, coerceStacks, parseDuration, pickKnownKeys } from '../state-tree-codecs';
import type { ResolvedTreePath } from '../state-tree-patch';
import { stateTreeChildKeys } from '../state-tree-spec';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import { Drop, charTarget, editKeyed, take, type OpContext, type Row } from './common';
import { buildSkillFields, buildStatusFields, statusPayload } from './fields';
import type { TranslatorHost } from './host';
import { SKILL_SPEC, STATUS_SPEC, childOf, keyOf } from './rules';

// ---------- 技能 ----------

export function translateSkill(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
  char: CharacterState,
): void {
  const w = ctx.op;
  const name = t.entry!.name;
  const target = charTarget(char.name);
  const skill = findByName(char.skills, name);
  if (t.subPath.length === 0 && t.leafKey === undefined) {
    if (w.op === 'remove') {
      if (!skill) throw new Drop(`技能「${name}」不存在`);
      h.commit([{ op: 'remove_skill', target, value: { name } }]);
      return;
    }
    if (w.op === 'move') {
      const fe = f?.entry;
      if (!f?.person || !fe || fe.record !== '技能' || f.subPath.length > 0)
        throw new Drop('技能只能从技能条目 move');
      if (f.person.name !== char.name) throw new Drop('技能不能在人物之间转移');
      const old = findByName(char.skills, fe.name);
      if (!old) throw new Drop(`技能「${fe.name}」不存在`);
      if (skill) throw new Drop(`技能「${name}」已存在`);
      const copy = jsonClone(old);
      delete copy.id;
      h.commit([
        { op: 'remove_skill', target, value: { name: old.name } },
        { op: 'add_skill', target, value: { ...copy, name } },
      ]);
      return;
    }
    if (w.op === 'delta') throw new Drop('技能条目不能 delta');
    if (!isPlainObject(w.value)) throw new Drop('写入技能条目需要对象');
    const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(SKILL_SPEC)), ctx.notes);
    const built = buildSkillFields(picked, ctx.notes, true);
    ctx.value = picked;
    if (!skill || w.op === 'add') {
      h.commit([{ op: 'add_skill', target, value: { name, ...built.fields } }]);
      return;
    }
    const changes: Partial<Skill> = { ...built.fields };
    if (built.clearCost) Object.assign(changes, { cost: undefined, costText: '' });
    h.commit([{ op: 'update_skill', target, value: { name, changes } }]);
    return;
  }
  if (!skill) throw new Drop(`技能「${name}」不存在`);
  if (w.op === 'move') throw new Drop('move 只用于技能条目');
  const field = t.subPath[0] ?? '';
  const node = childOf(SKILL_SPEC, field);
  const kernel = node?.rule === 'skillField' ? (node.kernel as keyof Skill) : undefined;
  if (!kernel) throw new Drop(`「${field}」不可写`);
  let changes: Partial<Skill>;
  if (w.op === 'remove' && t.leafKey === undefined) {
    if (kernel === 'type' || kernel === 'description')
      throw new Drop(`${field}不能删除，请用 replace`);
    changes =
      kernel === 'cost'
        ? ({ cost: undefined, costText: '' } as Partial<Skill>)
        : { [kernel]: undefined };
  } else if (t.leafKey !== undefined) {
    if (w.op === 'delta') throw new Drop(`${field}不能 delta`);
    const raw = editKeyed(
      skill[kernel],
      w.op,
      t.leafKey,
      w.op === 'remove' ? undefined : w.value,
      kernel === 'tags',
    );
    changes = buildSkillFields({ [field]: raw }, ctx.notes, false).fields;
  } else if (w.op === 'delta') {
    if (kernel !== 'cooldown' && kernel !== 'skillPower') throw new Drop(`${field}不能 delta`);
    const cur = typeof skill[kernel] === 'number' ? (skill[kernel] as number) : 0;
    const n = take(coerceNumber(w.value, { integer: kernel === 'cooldown' }), ctx.notes);
    changes = { [kernel]: cur + n };
    ctx.value = n;
  } else {
    const built = buildSkillFields({ [field]: w.value }, ctx.notes, false);
    changes = { ...built.fields };
    if (built.clearCost) Object.assign(changes, { cost: undefined, costText: '' });
  }
  h.commit([{ op: 'update_skill', target, value: { name, changes } }]);
}

// ---------- 状态效果 ----------

export function translateStatus(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
  char: CharacterState,
): void {
  const w = ctx.op;
  const name = t.entry!.name;
  const target = charTarget(char.name);
  const effect = findByName(char.statusEffects, name);
  if (t.subPath.length === 0 && t.leafKey === undefined) {
    if (w.op === 'remove') {
      if (!effect) throw new Drop(`状态「${name}」不存在`);
      h.commit([{ op: 'remove_status_effect', target, value: { name } }]);
      return;
    }
    if (w.op === 'move') {
      const fe = f?.entry;
      if (!f?.person || !fe || fe.record !== '状态效果' || f.subPath.length > 0)
        throw new Drop('状态只能从状态条目 move');
      if (f.person.name !== char.name) throw new Drop('状态不能在人物之间转移');
      const old = findByName(char.statusEffects, fe.name);
      if (!old) throw new Drop(`状态「${fe.name}」不存在`);
      if (effect) throw new Drop(`状态「${name}」已存在`);
      h.commit([
        { op: 'remove_status_effect', target, value: { name: old.name } },
        { op: 'add_status_effect', target, value: { ...statusPayload(old), name } },
      ]);
      return;
    }
    if (w.op === 'delta') throw new Drop('状态条目不能 delta');
    if (!isPlainObject(w.value)) throw new Drop('写入状态条目需要对象');
    const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(STATUS_SPEC)), ctx.notes);
    const built = buildStatusFields(picked, ctx.notes, effect?.maxStacks);
    if (built.removeByStacks) throw new Drop('层数 ≤ 0，不施加');
    if (picked[keyOf(STATUS_SPEC, 'category')] === undefined && !effect) {
      built.fields.category = '特殊';
      ctx.notes.push('缺少类型，兜底「特殊」');
    }
    ctx.value = picked;
    const payload = { name, ...built.fields };
    if (!effect || w.op === 'add') {
      h.commit([{ op: 'add_status_effect', target, value: payload }]);
      return;
    }
    // replace 已有状态：整份覆盖（删旧加新）
    h.commit([
      { op: 'remove_status_effect', target, value: { name } },
      { op: 'add_status_effect', target, value: payload },
    ]);
    return;
  }
  if (!effect) throw new Drop(`状态「${name}」不存在`);
  if (w.op === 'move') throw new Drop('move 只用于状态条目');
  const field = t.subPath[0] ?? '';
  const node = childOf(STATUS_SPEC, field);
  if (node?.rule === 'statusStacks') {
    const op = w.op === 'add' ? 'replace' : w.op;
    if (op !== 'replace' && op !== 'delta') throw new Drop('层数只能 replace 或 delta');
    const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
    const wantStacks = op === 'delta' ? effect.stacks + n : n;
    // delta 恰好减到 0 是正常消耗（层数用完），不是纠正；显式写 ≤0 的 replace、减过头才记纠正
    const s = take(
      coerceStacks(wantStacks, effect.maxStacks),
      op === 'delta' && wantStacks === 0 ? [] : ctx.notes,
    );
    ctx.value = op === 'delta' ? n : s.remove ? 0 : s.count;
    if (s.remove) {
      h.commit([{ op: 'remove_status_effect', target, value: { name } }]);
      return;
    }
    if (s.count !== effect.stacks)
      h.commit([{ op: 'update_status_effect', target, value: { name, stacks: s.count } }]);
    return;
  }
  if (node?.rule === 'statusDuration') {
    if (w.op === 'remove') throw new Drop('剩余时间不能删除，请写「永久」');
    if (w.op === 'delta') {
      if (effect.durationText || effect.remainingTime === null)
        throw new Drop('文本或永久时长不能 delta');
      const n = take(coerceNumber(w.value), ctx.notes);
      const next = Math.max(0, effect.remainingTime + n);
      ctx.value = n;
      h.commit([{ op: 'update_status_effect', target, value: { name, remainingTime: next } }]);
      return;
    }
    const d = take(parseDuration(w.value), ctx.notes);
    ctx.value = w.value;
    if (d.kind === 'text') {
      h.commit([
        { op: 'update_status_effect', target, value: { name, durationText: d.durationText } },
      ]);
    } else if (d.kind === 'permanent') {
      h.commit([{ op: 'update_status_effect', target, value: { name, remainingTime: null } }]);
    } else if (d.timeUnit === effect.timeUnit) {
      h.commit([
        { op: 'update_status_effect', target, value: { name, remainingTime: d.remainingTime } },
      ]);
    } else {
      // 单位变了：update_status_effect 改不了单位，删旧加新
      const p = statusPayload(effect);
      delete p.durationText;
      h.commit([
        { op: 'remove_status_effect', target, value: { name } },
        {
          op: 'add_status_effect',
          target,
          value: { ...p, remainingTime: d.remainingTime, timeUnit: d.timeUnit },
        },
      ]);
    }
    return;
  }
  // 其余叶子：内核没有改描述的 op，读出现值后删旧加新（§5.3）
  const kernel = node?.rule === 'statusField' ? (node.kernel as keyof StatusEffect) : undefined;
  if (!kernel) throw new Drop(`「${field}」不可写`);
  const payload = statusPayload(effect);
  if (w.op === 'remove' && t.leafKey === undefined) {
    if (kernel !== 'effectDescriptions' && kernel !== 'maxStacks')
      throw new Drop(`${field}不能删除，请用 replace`);
    delete (payload as Row)[kernel];
  } else if (w.op === 'delta' && t.leafKey === undefined) {
    if (kernel !== 'maxStacks') throw new Drop(`${field}不能 delta`);
    const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
    const built = buildStatusFields({ [field]: (effect.maxStacks ?? 0) + n }, ctx.notes, undefined);
    Object.assign(payload, built.fields);
    ctx.value = n;
  } else {
    if (w.op === 'delta') throw new Drop(`${field}不能 delta`);
    let raw: unknown = w.value;
    if (t.leafKey !== undefined)
      raw = editKeyed(
        effect.effectDescriptions,
        w.op,
        t.leafKey,
        w.op === 'remove' ? undefined : w.value,
        false,
      );
    const built = buildStatusFields({ [field]: raw }, ctx.notes, undefined);
    Object.assign(payload, built.fields);
  }
  if (payload.maxStacks && payload.stacks && payload.stacks > payload.maxStacks) {
    ctx.notes.push(`层数已按新上限封顶为 ${payload.maxStacks}`);
    payload.stacks = payload.maxStacks;
  }
  h.commit([
    { op: 'remove_status_effect', target, value: { name } },
    { op: 'add_status_effect', target, value: payload },
  ]);
}
