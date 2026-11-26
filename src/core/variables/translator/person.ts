/**
 * 人物（主角与关系列表）的翻译：分派到物品 / 技能 / 状态 / 登神 / 新建人物，以及档案、成长、资源等叶子
 * （自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import {
  RESOURCE_FIELDS,
  effectiveCap,
  readResourceCaps,
  type ResourceKey,
} from '../../character/resource-caps';
import { resourceCeiling } from '../../state/patch-reducer';
import type { CharacterState } from '../../types/types';
import {
  coerceAffection,
  coerceBoolean,
  coerceCapBonus,
  coerceCapTotal,
  coerceMoneyResult,
  coerceNumber,
  coerceQuantity,
  coerceResourceCurrent,
  coerceText,
  coerceTextArray,
} from '../state-tree-codecs';
import type { ResolvedTreePath, TreeOpKind } from '../state-tree-patch';
import type { StateTreeValue } from '../state-tree-projection';
import { CHARACTER_CATEGORY_TYPES, stateTreeKernelOf } from '../state-tree-spec';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import {
  Drop,
  charTarget,
  editKeyed,
  hasOwn,
  numberWrite,
  readStateTreeValue,
  setPlain,
  take,
  type OpContext,
  type Row,
} from './common';
import { createCharacter } from './create-character';
import { treeToAscension } from './fields';
import type { TranslatorHost } from './host';
import { translateItem } from './item';
import {
  ASCENSION_SPEC,
  PERSON_SPEC,
  PROFILE_SPEC,
  emptyTree,
  resourceOf,
  stateTreeTranslationRuleOf,
  type ProfileListField,
  type ProfileTextField,
} from './rules';
import { translateSkill, translateStatus } from './skill-status';
import { setLocation } from './world-quest-vars';

export function translatePerson(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
): void {
  const w = ctx.op;
  // 路径恰为 `/关系列表`（没点名人物）时没有 person：丢这一条，不让整批翻译抛出
  if (!t.person) throw new Drop('没有指明人物，不能整体写关系列表');
  const p = t.person;
  const relSegs = t.segments.slice(p.isPlayer ? 1 : 2);
  if (relSegs.length === 0) return personRoot(h, ctx, t, f);
  if (!p.exists) throw new Drop(`人物「${p.name}」不存在`);
  const char = h.character(p.name);
  const rule = stateTreeTranslationRuleOf(t.pattern);
  if (rule === 'ascension') return ascension(h, ctx, t, f, char);
  const inner = t.entries.find((e) => e.record !== '关系列表');
  if (inner) {
    if (inner.record === '背包' || inner.record === '装备')
      return translateItem(h, ctx, t, f, char);
    if (inner.record === '技能') return translateSkill(h, ctx, t, f, char);
    if (inner.record === '状态效果') return translateStatus(h, ctx, t, f, char);
  }
  if (w.op === 'move') throw new Drop('move 只用于名字字典的条目');
  if (rule === undefined) throw new Drop(`「${t.pattern}」没有翻译规则`);
  if (rule === 'expand') {
    if (t.spec.type === 'record' && w.op === 'replace')
      return h.expand(ctx, t, '按条目逐条写入，未列出的条目保留');
    return h.expand(ctx, t);
  }
  if (w.op === 'add') {
    ctx.notes.push('add 用在叶子上，按 replace 处理');
  }
  const op = w.op === 'add' ? 'replace' : w.op;
  switch (rule) {
    case 'profileText':
    case 'profileList':
      return profileField(h, ctx, t, char, rule, op);
    case 'category':
      return category(h, ctx, char, op);
    case 'level':
      return level(h, ctx, char, op);
    case 'totalExp':
      return totalExp(h, ctx, char, op);
    case 'resourceCurrent':
      return resourceCurrent(h, ctx, char, resourceOf(relSegs[0]), op);
    case 'capTotal':
      if (isPlainObject(w.value)) return h.expand(ctx, t);
      return capBonus(h, ctx, char, resourceOf(relSegs[0]), op, true);
    case 'capBonus':
      return capBonus(h, ctx, char, resourceOf(relSegs[0]), op, false);
    case 'money':
      return money(h, ctx, char, op);
    case 'personText':
      return personText(
        h,
        ctx,
        char,
        stateTreeKernelOf(PERSON_SPEC, relSegs[0]) as 'currentAction' | 'thoughts',
        op,
      );
    case 'present':
      return present(h, ctx, char, op);
    case 'location':
      if (op !== 'replace') throw new Drop('地点只能 replace');
      return setLocation(h, ctx, char);
    case 'affection':
      return affection(h, ctx, char, op);
    case 'groupQuantity':
      return groupQuantity(h, ctx, char, op);
    default:
      throw new Drop(`「${t.pattern}」不可写`);
  }
}

function personRoot(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
): void {
  const w = ctx.op;
  const p = t.person!;
  if (w.op === 'remove') {
    if (p.isPlayer) throw new Drop('主角不可删除');
    if (!p.exists) throw new Drop(`人物「${p.name}」不存在`);
    const c = h.character(p.name);
    // 双保险：按本批开始时的类别判（本批新建的人物没有起始类别，按现值）
    const startType = h.startTypes.get(c.name) ?? c.type;
    if (h.options.actor === 'ai' && startType !== 'monster' && startType !== 'summon')
      throw new Drop('AI 只能删除怪物或召唤物');
    h.commit([{ op: 'remove_character', target: charTarget(c.name) }]);
    return;
  }
  if (w.op === 'move') {
    if (!f || !f.person || f.segments.length !== 2 || f.root !== 'relation')
      throw new Drop('改名要从 /关系列表/<旧名> move 到 /关系列表/<新名>');
    if (p.isPlayer || t.root !== 'relation') throw new Drop('改名的目标不能是主角');
    if (!f.person.exists) throw new Drop(`人物「${f.person.name}」不存在`);
    if (p.exists) throw new Drop(`新名「${p.name}」已被占用`);
    const newName = p.name.trim();
    if (!newName) throw new Drop('新名不能为空');
    const oldName = h.character(f.person.name).name;
    h.commit([{ op: 'rename_character', target: charTarget(f.person.name), value: newName }]);
    // 起始类别跟着改名走（改名后再删仍按本批开始时的类别判）
    const startType = h.startTypes.get(oldName);
    if (startType !== undefined) {
      h.startTypes.delete(oldName);
      h.startTypes.set(newName, startType);
    }
    ctx.value = newName;
    return;
  }
  if (w.op === 'delta') throw new Drop('人物不能 delta');
  if (!p.exists) return createCharacter(h, ctx, t);
  return h.expand(ctx, t, '人物已存在，按逐字段写入处理');
}

function profileField(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  char: CharacterState,
  rule: 'profileText' | 'profileList',
  op: TreeOpKind,
): void {
  const key = t.segments[t.segments.length - (t.leafKey !== undefined ? 2 : 1)];
  const kernel = stateTreeKernelOf(PROFILE_SPEC, key);
  if (kernel === undefined) throw new Drop(`「${key}」不是档案字段`);
  if (rule === 'profileText') {
    if (op !== 'replace') throw new Drop('档案文字只能 replace');
    const text = take(coerceText(ctx.op.value), ctx.notes);
    if (!text) throw new Drop('档案文字不能为空');
    ctx.value = text;
    writeProfile(h, char, kernel as ProfileTextField, text);
    return;
  }
  const field = kernel as ProfileListField;
  let list: string[];
  if (t.leafKey !== undefined) {
    if (op === 'delta') throw new Drop('文本数组不能 delta');
    const item = op === 'remove' ? undefined : take(coerceText(ctx.op.value), ctx.notes);
    list = editKeyed(char[field], op, t.leafKey, item, true) as string[];
  } else {
    if (op !== 'replace') throw new Drop('档案列表只能 replace');
    list = take(coerceTextArray(ctx.op.value), ctx.notes);
  }
  ctx.value = list;
  writeProfile(h, char, field, list);
}

/**
 * 档案文字字段 → `update_character` 补丁（八个字段都在白名单里），与改名、其余补丁同一事务落。
 * 设计稿 §5.5 原定转成 profile_changes 旁路，2026-11-25 改走补丁（审查 A8：同批改名后旁路按旧名落空）。
 */
function writeProfile(
  h: TranslatorHost,
  char: CharacterState,
  field: ProfileTextField | ProfileListField,
  value: string | string[],
): void {
  h.commit([
    {
      op: 'update_character',
      target: charTarget(char.name),
      value: { [field]: jsonClone(value) },
    },
  ]);
}

function category(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  if (op !== 'replace') throw new Drop('类别只能 replace');
  if (char.type === 'player') throw new Drop('主角没有类别');
  // AI 改已有人物的类别 = 绕过「只能删怪物 / 召唤物」（先改类别再删），对 AI 只读；新建人物整对象里的类别走组装管线
  if (h.options.actor === 'ai') throw new Drop('类别由代码维护，AI 不能改已有人物的类别');
  const text = take(coerceText(ctx.op.value), ctx.notes);
  const type = CHARACTER_CATEGORY_TYPES[text];
  if (type === undefined) throw new Drop(`类别「${text}」认不出（怪物 / 召唤物）`);
  ctx.value = text;
  if (type !== char.type)
    h.commit([{ op: 'update_character', target: charTarget(char.name), value: { type } }]);
}

function level(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  let next = numberWrite(ctx, op, char.level, '等级');
  if (next < 1 || next > 25) {
    const c = Math.max(1, Math.min(25, next));
    ctx.notes.push(`等级 ${next} 越界，已钳到 ${c}`);
    next = c;
  }
  ctx.value = next;
  if (next !== char.level)
    h.commit([{ op: 'update_character', target: charTarget(char.name), value: { level: next } }]);
}

function totalExp(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  let next = numberWrite(ctx, op, char.totalExp, '累计经验值');
  if (next < 0) {
    ctx.notes.push(`累计经验值 ${next} 低于 0，已钳到 0`);
    next = 0;
  }
  ctx.value = next;
  if (next === char.totalExp) return;
  h.commit([{ op: 'update_character', target: charTarget(char.name), value: { totalExp: next } }]);
  // 主角经验由代码接管（保底门槛、登神封顶）：结果与写入值不同时如实记下
  const after = h.character(char.name).totalExp;
  if (after !== next) ctx.notes.push(`累计经验值由代码调整为 ${after}（等级门槛 / 登神封顶）`);
}

function resourceCurrent(
  h: TranslatorHost,
  ctx: OpContext,
  char: CharacterState,
  key: ResourceKey,
  op: TreeOpKind,
): void {
  // 钳制口径与提交时同一个（角色身上的有效上限字段；上限为 0 的怪物只能写 0）
  const cap = resourceCeiling(char, key);
  const cur = char[key];
  let next: number;
  if (op === 'replace') next = take(coerceResourceCurrent(ctx.op.value, cap), ctx.notes);
  else if (op === 'delta') {
    const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
    next = take(coerceResourceCurrent(cur + n, cap), ctx.notes);
  } else throw new Drop('当前值只能 replace 或 delta');
  ctx.value = op === 'delta' ? next - cur : next;
  if (next === cur) return;
  h.commit([
    op === 'replace'
      ? { op: `set_${key}`, target: charTarget(char.name), value: next }
      : { op: `delta_${key}`, target: charTarget(char.name), amount: next - cur },
  ]);
}

function capBonus(
  h: TranslatorHost,
  ctx: OpContext,
  char: CharacterState,
  key: ResourceKey,
  op: TreeOpKind,
  total: boolean,
): void {
  const caps = readResourceCaps(char)[key];
  const field = RESOURCE_FIELDS[key].bonus;
  let next: number;
  let usedDelta = false;
  if (op === 'replace') {
    next = take(
      total ? coerceCapTotal(ctx.op.value, caps.base) : coerceCapBonus(ctx.op.value, caps.base),
      ctx.notes,
    );
  } else if (op === 'delta') {
    if (total) ctx.notes.push('上限的 delta 按额外的增量处理');
    const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
    const notesBefore = ctx.notes.length;
    next = take(coerceCapBonus(caps.bonus + n, caps.base), ctx.notes);
    usedDelta = ctx.notes.length === notesBefore;
  } else throw new Drop('上限只能 replace 或 delta');
  ctx.value =
    total && op === 'replace'
      ? effectiveCap(caps.base, next)
      : op === 'delta'
        ? next - caps.bonus
        : next;
  if (next === caps.bonus && typeof char[field] === 'number') return;
  h.commit([
    usedDelta
      ? {
          op: 'update_character',
          target: charTarget(char.name),
          value: { [field]: next - caps.bonus },
          metadata: { delta: true },
        }
      : { op: 'update_character', target: charTarget(char.name), value: { [field]: next } },
  ]);
}

function money(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  const cur = typeof char.money === 'number' ? char.money : 0;
  const raw = numberWrite(ctx, op, cur, '金钱');
  const notesBefore = ctx.notes.length;
  const next = take(coerceMoneyResult(raw), ctx.notes);
  const clamped = ctx.notes.length !== notesBefore;
  ctx.value = op === 'delta' ? next - cur : next;
  if (next === cur) return;
  h.commit([
    op === 'delta' && !clamped
      ? {
          op: 'update_character',
          target: charTarget(char.name),
          value: { money: next - cur },
          metadata: { delta: true },
        }
      : { op: 'update_character', target: charTarget(char.name), value: { money: next } },
  ]);
}

function personText(
  h: TranslatorHost,
  ctx: OpContext,
  char: CharacterState,
  field: 'currentAction' | 'thoughts',
  op: TreeOpKind,
): void {
  let text: string;
  if (op === 'remove') text = '';
  else if (op === 'replace') text = take(coerceText(ctx.op.value), ctx.notes);
  else throw new Drop('文本只能 replace');
  ctx.value = text;
  if (text === (char[field] ?? '')) return;
  h.commit([{ op: 'update_character', target: charTarget(char.name), value: { [field]: text } }]);
}

function present(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  if (op !== 'replace') throw new Drop('在场只能 replace');
  const b = take(coerceBoolean(ctx.op.value), ctx.notes);
  ctx.value = b;
  if (b === (char.present === true)) return;
  h.commit([{ op: 'update_character', target: charTarget(char.name), value: { present: b } }]);
}

function affection(h: TranslatorHost, ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
  const aff = h.state.profile.affections;
  const cur = hasOwn(aff, char.name) ? aff[char.name] : 0;
  const target = `affections.${char.name}`;
  if (op === 'replace') {
    const v = take(coerceAffection(ctx.op.value), ctx.notes);
    ctx.value = v;
    if (v !== cur || !hasOwn(aff, char.name)) h.commit([{ op: 'set_affection', target, value: v }]);
    return;
  }
  if (op !== 'delta') throw new Drop('好感度只能 replace 或 delta');
  const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
  const next = take(coerceAffection(cur + n), ctx.notes);
  ctx.value = next - cur;
  if (next !== cur) h.commit([{ op: 'delta_affection', target, amount: next - cur }]);
}

function groupQuantity(
  h: TranslatorHost,
  ctx: OpContext,
  char: CharacterState,
  op: TreeOpKind,
): void {
  if (char.type !== 'monster' && char.type !== 'summon') throw new Drop('只有怪物 / 召唤物有数量');
  const cur = char.quantity ?? 1;
  const raw = numberWrite(ctx, op, cur, '数量');
  const q = take(coerceQuantity(raw), ctx.notes);
  ctx.value = op === 'delta' ? raw - cur : raw;
  if (q.remove) {
    h.commit([{ op: 'remove_character', target: charTarget(char.name) }]);
    return;
  }
  if (q.count !== cur)
    h.commit([
      { op: 'update_character', target: charTarget(char.name), value: { quantity: q.count } },
    ]);
}

// ---------- 登神长阶 ----------

function ascension(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
  char: CharacterState,
): void {
  const w = ctx.op;
  const at = t.segments.indexOf(ASCENSION_SPEC.key);
  const rel = t.segments.slice(at + 1);
  const base = t.segments.slice(0, at + 1);
  const current = (jsonClone(h.view().read(base)) ?? {}) as Row;
  const original = jsonClone(current);
  const tree: Row = { ...emptyTree(ASCENSION_SPEC), ...current };
  let fromValue: unknown;
  if (w.op === 'move') {
    const fa = f?.segments.indexOf(ASCENSION_SPEC.key) ?? -1;
    if (!f || fa < 0 || f.person?.name !== char.name)
      throw new Drop('登神长阶只能在同一人物内 move');
    const fromRel = f.segments.slice(fa + 1);
    fromValue = readStateTreeValue(tree as StateTreeValue, fromRel);
    if (fromValue === undefined) throw new Drop('from 不存在');
    setPlain(tree, fromRel, undefined, true);
  }
  if (rel.length === 0) {
    if (w.op === 'remove') throw new Drop('登神长阶不能整份删除');
    if (w.op !== 'replace' && w.op !== 'add') throw new Drop('登神长阶整份只能 replace');
    if (!isPlainObject(w.value)) throw new Drop('写入登神长阶需要对象');
    Object.assign(tree, w.value);
  } else if (w.op === 'remove') {
    if (readStateTreeValue(tree as StateTreeValue, rel) === undefined)
      throw new Drop('要删除的条目不存在');
    setPlain(tree, rel, undefined, true);
  } else if (w.op === 'delta') {
    throw new Drop('登神长阶没有数值叶子');
  } else {
    setPlain(tree, rel, w.op === 'move' ? fromValue : jsonClone(w.value), false);
  }
  const asc = treeToAscension(tree, original, char.ascension, ctx.notes);
  h.commit([{ op: 'update_character', target: charTarget(char.name), value: { ascension: asc } }]);
}
