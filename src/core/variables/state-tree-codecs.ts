/**
 * 状态树叶子值的纠正与编解码（状态树协议 T1，设计 §5.2）
 *
 * 纯函数集：每个函数只看一个值（加少量上下文，如有效上限、当前持有量），返回
 * 「是否成功 + 纠正后的值 + 是否纠正 + 中文说明」。说明由上层（翻译层 T6）原样记进本楼更新记录。
 *
 * 约定：
 * - 成功且原样接受：`corrected: false`、无 `note`；成功但改过值：`corrected: true` 且必有 `note`。
 * - 失败只给 `reason`，由上层丢该条 op。
 * - 枚举**只查 `content/field-enums.ts` 的词表与别名表**，不做模糊匹配（§5.2）。
 *   关注度、技能类型、关联属性、伤害类型这四种 field-enums 未收录，只认内核固定取值的精确词。
 */

import {
  EQUIP_SLOTS,
  normalizeItemType,
  normalizeQuestStatus,
  normalizeRarity,
  normalizeSlot,
  normalizeStatusCategory,
  type EquipSlot,
  type ItemType,
  type QuestStatus,
  type Rarity,
  type StatusCategory,
} from '../content/field-enums';
import { parseGameTime, toEpochMinutes, type GameTime } from '../time/time-system';
import type { Skill, StatusEffect } from '../types/types';
import {
  ATTRIBUTE_LABELS,
  DAMAGE_TYPES,
  QUEST_PRIORITIES,
  SKILL_TYPE_LABELS,
  isReadonlyKey,
  stripReadonlyPrefix,
  type StateTreeEnumKind,
} from './state-tree-spec';
import { isPlainObject } from './state-tree-utils';

// ========== 结果类型 ==========

export type CodecResult<T> =
  { ok: true; value: T; corrected: boolean; note?: string } | { ok: false; reason: string };

function accept<T>(value: T, note?: string): CodecResult<T> {
  return note ? { ok: true, value, corrected: true, note } : { ok: true, value, corrected: false };
}

function reject<T>(reason: string): CodecResult<T> {
  return { ok: false, reason };
}

/** 把两步纠正的说明串起来（前一步的说明在前）。 */
function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const list = notes.filter((n): n is string => !!n);
  return list.length > 0 ? list.join('；') : undefined;
}

function show(raw: unknown): string {
  if (typeof raw === 'string') return `「${raw}」`;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

// ========== 数值 ==========

const PURE_NUMBER_RE = /^[-+]?\d+(?:\.\d+)?$/;
const FIRST_NUMBER_RE = /[-+]?\d+(?:\.\d+)?/;

export interface NumberOptions {
  /** 要整数：非整数四舍五入并记录。 */
  integer?: boolean;
}

/**
 * 数值：数字字符串转数字；`"80/120"` 这类取首个数；要整数的四舍五入。
 * NaN、Infinity、对象、布尔、不含数字的文本一律失败。
 */
export function coerceNumber(raw: unknown, options: NumberOptions = {}): CodecResult<number> {
  let n: number;
  let note: string | undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject(`${show(raw)} 不是有限数值`);
    n = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (PURE_NUMBER_RE.test(s)) {
      n = Number(s);
      note = `数字字符串 ${show(raw)} 已转为数字`;
    } else {
      const m = FIRST_NUMBER_RE.exec(s);
      if (!m) return reject(`${show(raw)} 不是数值`);
      n = Number(m[0]);
      note = `${show(raw)} 取首个数 ${n}`;
    }
    if (!Number.isFinite(n)) return reject(`${show(raw)} 不是有限数值`);
  } else {
    return reject(`${show(raw)} 不是数值`);
  }
  if (options.integer && !Number.isInteger(n)) {
    const r = Math.round(n);
    note = joinNotes(note, `${n} 已四舍五入为 ${r}`);
    n = r;
  }
  return accept(n, note);
}

/** 把数值钳进 [min, max]；越界时记录。`label` 进说明。 */
export function clampNumber(
  value: number,
  min: number,
  max: number,
  label = '数值',
): CodecResult<number> {
  if (value < min) return accept(min, `${label} ${value} 低于下限，已钳到 ${min}`);
  if (value > max) return accept(max, `${label} ${value} 超过上限，已钳到 ${max}`);
  return accept(value);
}

/** 先按整数解析再钳制，两步说明合并。 */
function integerInRange(
  raw: unknown,
  min: number,
  max: number,
  label: string,
): CodecResult<number> {
  const n = coerceNumber(raw, { integer: true });
  if (!n.ok) return n;
  const c = clampNumber(n.value, min, max, label);
  if (!c.ok) return c;
  return accept(c.value, joinNotes(n.note, c.note));
}

/** 资源当前值：整数，钳到 [0, 有效上限]。 */
export function coerceResourceCurrent(raw: unknown, effectiveMax: number): CodecResult<number> {
  return integerInRange(raw, 0, Math.max(0, effectiveMax), '当前值');
}

/** 上限的 `额外`：整数，可为负；钳到「基础 + 额外 ≥ 1」。 */
export function coerceCapBonus(raw: unknown, base: number): CodecResult<number> {
  return integerInRange(raw, 1 - base, Number.POSITIVE_INFINITY, '额外');
}

/** 上限写成单个数：换算成「额外 = 该数 − 基础」并记录，再按 `额外` 的规则钳制。 */
export function coerceCapTotal(raw: unknown, base: number): CodecResult<number> {
  const n = coerceNumber(raw, { integer: true });
  if (!n.ok) return n;
  const bonus = n.value - base;
  const c = coerceCapBonus(bonus, base);
  if (!c.ok) return c;
  return accept(
    c.value,
    joinNotes(
      n.note,
      `上限写成单个数 ${n.value}，已换算为额外 = ${n.value} − 基础 ${base} = ${bonus}`,
      c.note,
    ),
  );
}

/** 金钱：写入后的结果钳到不小于 0（不允许负债，§9 #5）。`next` 是作用后的结果值。 */
export function coerceMoneyResult(next: number): CodecResult<number> {
  if (!Number.isFinite(next)) return reject(`${show(next)} 不是有限数值`);
  return clampNumber(next, 0, Number.POSITIVE_INFINITY, '金钱');
}

/**
 * 命运点数：结果钳到不小于 0，换算成账本增量。
 * `op` 为 `replace` 时 `raw` 是目标值，为 `delta` 时是增量；返回的是交给账本的增量。
 */
export function coerceFatePointsDelta(
  current: number,
  op: 'replace' | 'delta',
  raw: unknown,
): CodecResult<number> {
  const n = coerceNumber(raw, { integer: true });
  if (!n.ok) return n;
  const target = op === 'replace' ? n.value : current + n.value;
  if (target < 0) {
    return accept(
      -current,
      joinNotes(n.note, `命运点数结果 ${target} 低于 0，已钳到 0（增量 ${-current}）`),
    );
  }
  return accept(target - current, n.note);
}

/** 好感度：整数，钳到 [-100, 100]。 */
export function coerceAffection(raw: unknown): CodecResult<number> {
  return integerInRange(raw, -100, 100, '好感度');
}

/** 数量 / 层数的解析结果：`remove` 为 true 时调用方按移除处理。 */
export interface CountValue {
  count: number;
  remove: boolean;
}

/** 数量：整数；小于等于 0 视为移除。 */
export function coerceQuantity(raw: unknown): CodecResult<CountValue> {
  const n = coerceNumber(raw, { integer: true });
  if (!n.ok) return n;
  if (n.value <= 0) {
    return accept({ count: 0, remove: true }, joinNotes(n.note, `数量 ${n.value} ≤ 0，视为移除`));
  }
  return accept({ count: n.value, remove: false }, n.note);
}

/** 扣减数量超过持有量时钳到持有量并记录。 */
export function clampQuantityDecrease(held: number, decrease: number): CodecResult<number> {
  if (decrease > held) {
    return accept(held, `扣减 ${decrease} 超过持有量 ${held}，已钳到 ${held}`);
  }
  return accept(decrease);
}

/** 层数：整数；小于等于 0 视为移除状态；受层数上限封顶。 */
export function coerceStacks(raw: unknown, maxStacks?: number): CodecResult<CountValue> {
  const n = coerceNumber(raw, { integer: true });
  if (!n.ok) return n;
  if (n.value <= 0) {
    return accept(
      { count: 0, remove: true },
      joinNotes(n.note, `层数 ${n.value} ≤ 0，视为移除状态`),
    );
  }
  if (maxStacks !== undefined && Number.isFinite(maxStacks) && n.value > maxStacks) {
    return accept(
      { count: maxStacks, remove: false },
      joinNotes(n.note, `层数 ${n.value} 超过上限，已封顶为 ${maxStacks}`),
    );
  }
  return accept({ count: n.value, remove: false }, n.note);
}

/** 数值字典（物品 `属性`）：逐项按数值纠正，认不出的项剔除并记录。 */
export function coerceNumberDict(raw: unknown): CodecResult<Record<string, number>> {
  if (!isPlainObject(raw)) return reject(`${show(raw)} 不是对象`);
  const out: Record<string, number> = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const n = coerceNumber(v);
    if (n.ok) {
      out[k] = n.value;
      if (n.note) notes.push(`${k}：${n.note}`);
    } else {
      notes.push(`${k}：${n.reason}，已剔除`);
    }
  }
  return accept(out, joinNotes(...notes));
}

// ========== 文本 ==========

/** 文本：数字和布尔转字符串，去首尾空白；对象（含 null、数组）失败。 */
export function coerceText(raw: unknown): CodecResult<string> {
  if (typeof raw === 'string') return accept(raw.trim());
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return accept(String(raw), `${show(raw)} 已转为文本`);
  }
  return reject(`${show(raw)} 不是文本`);
}

/** 文本数组的拆分符：顿号、逗号（全半角）、斜杠（全半角）。 */
const TEXT_ARRAY_SPLIT_RE = /[、，,/／]/;

/** 文本数组：字符串按顿号、逗号、斜杠拆开；非字符串元素剔除。不丢弃。 */
export function coerceTextArray(raw: unknown): CodecResult<string[]> {
  if (Array.isArray(raw)) {
    const kept: string[] = [];
    let removed = 0;
    for (const el of raw) {
      if (typeof el === 'string') {
        const t = el.trim();
        if (t) kept.push(t);
      } else {
        removed += 1;
      }
    }
    return accept(kept, removed > 0 ? `剔除 ${removed} 个非文本元素` : undefined);
  }
  if (typeof raw === 'string') {
    const parts = raw
      .split(TEXT_ARRAY_SPLIT_RE)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return accept(parts, `文本 ${show(raw)} 已拆成 ${parts.length} 项`);
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return accept([String(raw)], `${show(raw)} 已转为单项数组`);
  }
  return accept([], `${show(raw)} 不是文本，已按空数组处理`);
}

/** 字符串值写成词条字典时用的词条名。 */
const DEFAULT_EFFECT_KEY = '效果';

/** 词条字典：字符串转 `{效果: 文本}`；数组合并成一条；非文本的词条值剔除。不丢弃。 */
export function coerceEffectDict(raw: unknown): CodecResult<Record<string, string>> {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return accept({}, '空文本，按空词条处理');
    return accept({ [DEFAULT_EFFECT_KEY]: t }, `文本已转为词条「${DEFAULT_EFFECT_KEY}」`);
  }
  if (Array.isArray(raw)) {
    const texts = raw
      .filter((el) => typeof el === 'string' || typeof el === 'number')
      .map((el) => String(el).trim())
      .filter((t) => t.length > 0);
    if (texts.length === 0) return accept({}, '数组里没有文本，按空词条处理');
    return accept(
      { [DEFAULT_EFFECT_KEY]: texts.join('；') },
      `数组 ${texts.length} 项已合并为词条「${DEFAULT_EFFECT_KEY}」`,
    );
  }
  if (isPlainObject(raw)) {
    const out: Record<string, string> = {};
    const notes: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      const t = coerceText(v);
      if (t.ok) {
        out[k] = t.value;
        if (t.note) notes.push(`${k}：${t.note}`);
      } else {
        notes.push(`${k}：${t.reason}，已剔除`);
      }
    }
    return accept(out, joinNotes(...notes));
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return accept(
      { [DEFAULT_EFFECT_KEY]: String(raw) },
      `${show(raw)} 已转为词条「${DEFAULT_EFFECT_KEY}」`,
    );
  }
  return accept({}, `${show(raw)} 不是词条，已按空词条处理`);
}

// ========== 布尔 ==========

const TRUE_WORDS = new Set(['是', '在场', 'true', '1']);
const FALSE_WORDS = new Set(['否', '离场', 'false', '0']);

/** 布尔：认「是 / 否 / 在场 / 离场 / true / false / 1 / 0」，其他失败。 */
export function coerceBoolean(raw: unknown): CodecResult<boolean> {
  if (typeof raw === 'boolean') return accept(raw);
  if (raw === 1 || raw === 0) return accept(raw === 1, `${raw} 已转为${raw === 1 ? '是' : '否'}`);
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return accept(true, `${show(raw)} 已转为是`);
    if (FALSE_WORDS.has(s)) return accept(false, `${show(raw)} 已转为否`);
  }
  return reject(`${show(raw)} 不是布尔值`);
}

// ========== 枚举 ==========

/** 只认字符串；其他类型统一当认不出。 */
function enumInput(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim() : undefined;
}

function aliasNote(raw: string, value: string): string | undefined {
  return raw === value ? undefined : `「${raw}」已归一为「${value}」`;
}

/** 品质：认不出则省略（值为 undefined）。 */
export function coerceRarity(raw: unknown): CodecResult<Rarity | undefined> {
  const s = enumInput(raw);
  const v = s === undefined ? undefined : normalizeRarity(s);
  if (v === undefined) return accept(undefined, `品质 ${show(raw)} 认不出，已省略`);
  return accept(v, aliasNote(s as string, v));
}

/** 物品类型：认不出则省略。 */
export function coerceItemType(raw: unknown): CodecResult<ItemType | undefined> {
  const s = enumInput(raw);
  const v = s === undefined ? undefined : normalizeItemType(s);
  if (v === undefined) return accept(undefined, `物品类型 ${show(raw)} 认不出，已省略`);
  return accept(v, aliasNote(s as string, v));
}

/** 状态分类：认不出兜底「特殊」。 */
export function coerceStatusCategory(raw: unknown): CodecResult<StatusCategory> {
  const s = enumInput(raw);
  if (s === undefined) return accept('特殊', `状态分类 ${show(raw)} 认不出，兜底「特殊」`);
  const v = normalizeStatusCategory(s);
  return accept(v, aliasNote(s, v));
}

/** 任务状态：认不出兜底「进行中」。 */
export function coerceQuestStatus(raw: unknown): CodecResult<QuestStatus> {
  const s = enumInput(raw);
  if (s === undefined) return accept('进行中', `任务状态 ${show(raw)} 认不出，兜底「进行中」`);
  const v = normalizeQuestStatus(s);
  return accept(v, aliasNote(s, v));
}

/** 关注度：只认「低 / 中 / 高」，认不出兜底「中」。 */
export function coerceQuestPriority(raw: unknown): CodecResult<(typeof QUEST_PRIORITIES)[number]> {
  const s = enumInput(raw);
  const hit = QUEST_PRIORITIES.find((p) => p === s);
  if (hit) return accept(hit);
  return accept('中', `关注度 ${show(raw)} 认不出，兜底「中」`);
}

/** 技能类型：「主动 / 被动」→ 内核 `active / passive`；认不出兜底主动。 */
export function coerceSkillType(raw: unknown): CodecResult<Skill['type']> {
  const s = enumInput(raw);
  if (s === SKILL_TYPE_LABELS.active) return accept('active');
  if (s === SKILL_TYPE_LABELS.passive) return accept('passive');
  if (s === 'active' || s === 'passive')
    return accept(s, `「${s}」已归一为「${SKILL_TYPE_LABELS[s]}」`);
  return accept('active', `技能类型 ${show(raw)} 认不出，兜底「主动」`);
}

type AttributeKey = keyof typeof ATTRIBUTE_LABELS;

/** 关联属性：中文五维名 → 内核键；认不出则省略。 */
export function coerceAttribute(raw: unknown): CodecResult<AttributeKey | undefined> {
  const s = enumInput(raw);
  const keys = Object.keys(ATTRIBUTE_LABELS) as AttributeKey[];
  const byLabel = keys.find((k) => ATTRIBUTE_LABELS[k] === s);
  if (byLabel) return accept(byLabel);
  const byKey = keys.find((k) => k === s);
  if (byKey) return accept(byKey, `「${byKey}」已归一为「${ATTRIBUTE_LABELS[byKey]}」`);
  return accept(undefined, `关联属性 ${show(raw)} 认不出，已省略`);
}

/** 伤害类型：只认内核四值，认不出则省略。 */
export function coerceDamageType(
  raw: unknown,
): CodecResult<(typeof DAMAGE_TYPES)[number] | undefined> {
  const s = enumInput(raw);
  const hit = DAMAGE_TYPES.find((d) => d === s);
  if (hit) return accept(hit);
  return accept(undefined, `伤害类型 ${show(raw)} 认不出，已省略`);
}

/** 按枚举种类分派（词表里 `enumKind` 直接喂进来）。返回内核存储值。 */
export function coerceEnum(kind: StateTreeEnumKind, raw: unknown): CodecResult<string | undefined> {
  switch (kind) {
    case 'rarity':
      return coerceRarity(raw);
    case 'itemType':
      return coerceItemType(raw);
    case 'statusCategory':
      return coerceStatusCategory(raw);
    case 'questStatus':
      return coerceQuestStatus(raw);
    case 'questPriority':
      return coerceQuestPriority(raw);
    case 'skillType':
      return coerceSkillType(raw);
    case 'attribute':
      return coerceAttribute(raw);
    case 'damageType':
      return coerceDamageType(raw);
  }
}

// ========== 装备位置 ==========

export type SlotValue = { kind: 'equip'; slot: EquipSlot } | { kind: 'unequip' };

const UNEQUIP_WORDS = new Set(['', '无', '背包']);

/** 位置：过 `normalizeSlot`；空串、null、「无」、「背包」视为卸下；认不出的槽位失败（不猜穿哪）。 */
export function coerceSlot(raw: unknown): CodecResult<SlotValue> {
  if (raw === null || raw === undefined) return accept({ kind: 'unequip' }, '位置为空，视为卸下');
  if (typeof raw !== 'string') return reject(`位置 ${show(raw)} 不是槽位`);
  const s = raw.trim();
  if (UNEQUIP_WORDS.has(s)) return accept({ kind: 'unequip' }, `位置 ${show(raw)} 视为卸下`);
  const slot = normalizeSlot(s);
  if (!slot) {
    return reject(`位置 ${show(raw)} 不是可选槽位（${EQUIP_SLOTS.join(' / ')}）`);
  }
  return accept({ kind: 'equip', slot }, aliasNote(s, slot));
}

// ========== 剩余时间 ==========

type DurationUnit = StatusEffect['timeUnit'];

export type DurationValue =
  | { kind: 'timed'; remainingTime: number; timeUnit: DurationUnit }
  | { kind: 'permanent' }
  | { kind: 'text'; durationText: string };

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(回合|分钟|小时|天|周)$/;
const PERMANENT_WORDS = new Set(['永久', '直至解除']);
const HOURS_PER_UNIT: Record<string, number> = { 天: 24, 周: 168 };

/**
 * 剩余时间文本 → 数值加单位 / 永久 / 原文。
 * 认「数字 + 回合 / 分钟 / 小时 / 天 / 周」，天和周折成小时；「永久 / 直至解除」视为永久；
 * 其余文本原样进 `durationText`。只有对象等非文本才失败。
 */
export function parseDuration(raw: unknown): CodecResult<DurationValue> {
  if (raw === null) return accept({ kind: 'permanent' }, '剩余时间为空，视为永久');
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject(`${show(raw)} 不是剩余时间`);
    return accept({ kind: 'text', durationText: String(raw) }, `${raw} 缺少单位，按文本保存`);
  }
  if (typeof raw !== 'string') return reject(`${show(raw)} 不是剩余时间`);
  const s = raw.trim();
  if (!s) return accept({ kind: 'permanent' }, '剩余时间为空，视为永久');
  if (PERMANENT_WORDS.has(s)) return accept({ kind: 'permanent' });
  const m = DURATION_RE.exec(s);
  if (!m) return accept({ kind: 'text', durationText: s });

  const amount = Number(m[1]);
  const unitWord = m[2];
  let value = amount;
  let unit: DurationUnit;
  let note: string | undefined;
  if (unitWord in HOURS_PER_UNIT) {
    value = amount * HOURS_PER_UNIT[unitWord];
    unit = '小时';
    note = `${s} 已折算为 ${value} 小时`;
  } else {
    unit = unitWord as DurationUnit;
  }
  if (!Number.isInteger(value)) {
    if (unit === '小时' && Number.isInteger(value * 60)) {
      note = joinNotes(note, `${value} 小时已换算为 ${value * 60} 分钟`);
      value *= 60;
      unit = '分钟';
    } else {
      const r = Math.round(value);
      note = joinNotes(note, `${value}${unit} 已四舍五入为 ${r}${unit}`);
      value = r;
    }
  }
  return accept({ kind: 'timed', remainingTime: value, timeUnit: unit }, note);
}

/** 状态的剩余时间 → 树上的文本：`durationText` 优先，`null` 为「永久」，否则「数字 + 单位」。 */
export function formatDuration(
  effect: Pick<StatusEffect, 'remainingTime' | 'timeUnit' | 'durationText'>,
): string {
  if (effect.durationText) return effect.durationText;
  if (effect.remainingTime === null) return '永久';
  return `${effect.remainingTime}${effect.timeUnit}`;
}

// ========== 技能消耗 ==========

export type SkillCostValue =
  | { kind: 'cost'; cost: NonNullable<Skill['cost']> }
  | { kind: 'text'; costText: string }
  | { kind: 'none' };

type CostType = NonNullable<Skill['cost']>['type'];

const COST_UNIT: Record<string, CostType> = {
  hp: 'HP',
  mp: 'MP',
  sp: 'SP',
  生命: 'HP',
  法力: 'MP',
  体力: 'SP',
};
const COST_UNIT_SRC = 'HP|MP|SP|生命|法力|体力';
const COST_NUM_FIRST_RE = new RegExp(`^(\\d+)\\s*(${COST_UNIT_SRC})值?$`, 'i');
const COST_UNIT_FIRST_RE = new RegExp(`^(${COST_UNIT_SRC})值?\\s*[:：]?\\s*(\\d+)$`, 'i');
const NO_COST_WORDS = new Set(['', '无']);

/**
 * 技能消耗文本 → `cost` / `costText` / 无消耗。
 * 认「数字 + HP / MP / SP（或 生命 / 法力 / 体力）」（单位在前亦可）；其余文本原样进 `costText`。
 */
export function parseSkillCost(raw: unknown): CodecResult<SkillCostValue> {
  if (raw === null || raw === undefined) return accept({ kind: 'none' });
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject(`${show(raw)} 不是技能消耗`);
    return accept({ kind: 'text', costText: String(raw) }, `${raw} 缺少资源类型，按文本保存`);
  }
  if (isPlainObject(raw)) {
    const type = typeof raw.type === 'string' ? COST_UNIT[raw.type.toLowerCase()] : undefined;
    const amount = raw.amount;
    if (type && typeof amount === 'number' && Number.isFinite(amount)) {
      return accept({ kind: 'cost', cost: { type, amount } }, `消耗对象已转为「${amount}${type}」`);
    }
    return reject(`${show(raw)} 不是技能消耗`);
  }
  if (typeof raw !== 'string') return reject(`${show(raw)} 不是技能消耗`);
  const s = raw.trim();
  if (NO_COST_WORDS.has(s)) return accept({ kind: 'none' });
  let m = COST_NUM_FIRST_RE.exec(s);
  if (m)
    return accept({
      kind: 'cost',
      cost: { type: COST_UNIT[m[2].toLowerCase()], amount: Number(m[1]) },
    });
  m = COST_UNIT_FIRST_RE.exec(s);
  if (m)
    return accept({
      kind: 'cost',
      cost: { type: COST_UNIT[m[1].toLowerCase()], amount: Number(m[2]) },
    });
  return accept({ kind: 'text', costText: s });
}

/** 技能消耗 → 树上的文本：`costText` 优先，其次「数字 + 类型」，都没有为空串。 */
export function formatSkillCost(skill: Pick<Skill, 'cost' | 'costText'>): string {
  if (skill.costText) return skill.costText;
  if (skill.cost) return `${skill.cost.amount}${skill.cost.type}`;
  return '';
}

// ========== 时间 ==========

/**
 * 时间写入 → 本楼推进的分钟数。
 * `delta` 的值是分钟、不能为负；`replace` 成时间串时用 `parseGameTime` 解析后与当前时间求差。
 * 时间倒退、解析不了一律失败。
 */
export function coerceTimeAdvance(
  op: 'delta' | 'replace',
  raw: unknown,
  current: GameTime,
): CodecResult<number> {
  if (op === 'delta') {
    const n = coerceNumber(raw, { integer: true });
    if (!n.ok) return n;
    if (n.value < 0) return reject(`时间不能倒退（${n.value} 分钟）`);
    return accept(n.value, n.note);
  }
  if (typeof raw !== 'string') return reject(`${show(raw)} 不是时间串`);
  const parsed = parseGameTime(raw.trim());
  if (!parsed) return reject(`时间串 ${show(raw)} 解析不了`);
  const diff = toEpochMinutes(parsed) - toEpochMinutes(current);
  if (diff < 0) return reject(`时间不能倒退（${show(raw)} 早于当前时间）`);
  return accept(diff, diff > 0 ? `时间串已换算为前进 ${diff} 分钟` : undefined);
}

// ========== 整实体 ==========

/**
 * 整实体值的键过滤：只留词表里的键，未知键剥除并记录；写了只读键（`_` 前缀）的也剥除。
 * 忽略 `_` 前缀匹配（写 `生命层级` 也认得出是只读键 `_生命层级`）。`allowedKeys` 是该实体节点的子键。
 */
export function pickKnownKeys(
  raw: unknown,
  allowedKeys: readonly string[],
): CodecResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return reject(`${show(raw)} 不是对象`);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  const readonly: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const canonical =
      allowedKeys.find((a) => a === k) ??
      allowedKeys.find((a) => stripReadonlyPrefix(a) === stripReadonlyPrefix(k));
    if (canonical === undefined) {
      unknown.push(k);
    } else if (isReadonlyKey(canonical)) {
      readonly.push(k);
    } else {
      out[canonical] = v;
    }
  }
  return accept(
    out,
    joinNotes(
      unknown.length > 0 ? `未知键 ${unknown.join('、')} 已剥除` : undefined,
      readonly.length > 0 ? `只读键 ${readonly.join('、')} 由代码维护，已剥除` : undefined,
    ),
  );
}
