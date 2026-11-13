/**
 * 世界书「关键日期」—— 条目元数据 `extra.lore.keyDates` 的校验、容错解析与日期判定。
 *
 * 关键日期只描述「这个日子是什么、在哪天」，供本地日历显示。它**不是提示词内容**：
 * 给模型读的仍然是条目正文（`content`），本模块的任何产物都不进入 Agent 上下文。
 *
 * 历法沿用 `time-system.ts`：12 个月 × 30 天，一年 360 天。
 * 格式与规则（R1–R11）见 docs/planning/2026-11-13-key-date-lore-format-design.md。
 */
import type {
  LoreKeyDate,
  LoreKeyDateMonthDay,
  LoreKeyDateRepeat,
  LoreKeyDateWhen,
  WorldBook,
  WorldBookEntry,
} from '../types/types';

const DAYS_PER_MONTH = 30;
const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);

/** `monthOptional`：按月重复时月份没有意义，可以省略（R4）。 */
function validMonthDay(value: unknown, monthOptional: boolean): boolean {
  if (!isObject(value) || !isInt(value.day, 1, DAYS_PER_MONTH)) return false;
  return value.month === undefined ? monthOptional : isInt(value.month, 1, 12);
}

function repeatError(repeat: unknown): string | null {
  if (repeat === undefined) return null;
  if (!isObject(repeat)) return 'invalid repeat';
  if (repeat.unit === 'month') return null;
  if (repeat.unit === 'once') return Number.isInteger(repeat.year) ? null : 'invalid repeat.year';
  if (repeat.unit !== 'year') return 'invalid repeat.unit';
  if (repeat.interval !== undefined && !isInt(repeat.interval, 1, 9999))
    return 'invalid repeat.interval';
  if (repeat.anchorYear !== undefined && !Number.isInteger(repeat.anchorYear))
    return 'invalid repeat.anchorYear';
  // R3：多年一度没有起算年就无法判定哪一年举办
  if (Number(repeat.interval ?? 1) > 1 && repeat.anchorYear === undefined)
    return 'repeat.interval > 1 requires anchorYear';
  return null;
}

function whenError(when: unknown, monthly: boolean): string | null {
  if (!isObject(when)) return 'invalid when';
  switch (when.precision) {
    case 'day':
      if (!validMonthDay(when.start, monthly)) return 'invalid when.start';
      if (when.end !== undefined && !validMonthDay(when.end, monthly)) return 'invalid when.end';
      return null;
    case 'month':
      if (monthly) return 'monthly repeat allows only day or none precision';
      return isInt(when.month, 1, 12) ? null : 'invalid when.month';
    case 'season':
      if (monthly) return 'monthly repeat allows only day or none precision';
      return (SEASONS as readonly unknown[]).includes(when.season) ? null : 'invalid when.season';
    case 'none':
      return null;
    default:
      return 'invalid when.precision';
  }
}

/** 节期天数。非日精度的项没有确定长度，按一年（360 天）封顶。 */
function spanLength(when: LoreKeyDateWhen, monthly: boolean): number {
  if (when.precision !== 'day') return 360;
  const end = when.end ?? when.start;
  if (monthly) return ((end.day - when.start.day + DAYS_PER_MONTH) % DAYS_PER_MONTH) + 1;
  const index = (md: LoreKeyDateMonthDay) => ((md.month ?? 1) - 1) * DAYS_PER_MONTH + md.day;
  return ((index(end) - index(when.start) + 360) % 360) + 1;
}

/** 单项的全部问题；空数组 = 合法。项内未知字段不算错（R8）。 */
function keyDateItemErrors(item: unknown): string[] {
  if (!isObject(item)) return ['must be an object'];
  const errors: string[] = [];
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id))
    errors.push('invalid id');
  if (!isText(item.name)) errors.push('invalid name');
  const repeat = repeatError(item.repeat);
  if (repeat) errors.push(repeat);
  const monthly = isObject(item.repeat) && item.repeat.unit === 'month';
  const when = whenError(item.when, monthly);
  if (when) errors.push(when);
  for (const field of ['aliases', 'regions', 'tags'])
    if (item[field] !== undefined && !isTextList(item[field])) errors.push(`invalid ${field}`);
  for (const field of ['summary', 'timeNote', 'category'])
    if (item[field] !== undefined && typeof item[field] !== 'string')
      errors.push(`invalid ${field}`);
  for (const field of ['approximate', 'major', 'public'])
    if (item[field] !== undefined && typeof item[field] !== 'boolean')
      errors.push(`invalid ${field}`);
  // 日程的「第几天」不能超出节期长度；日期本身不合法时上面已报错，这里只按一年封顶
  const span = when === null ? spanLength(item.when as LoreKeyDateWhen, monthly) : 360;
  if (
    item.highlights !== undefined &&
    !(
      Array.isArray(item.highlights) &&
      item.highlights.every((h) => isObject(h) && isInt(h.day, 1, span) && isText(h.title))
    )
  )
    errors.push('invalid highlights');
  return errors;
}

/**
 * 严格校验，供内容包安装时的协议校验使用。返回形如 `keyDates[1]: invalid when` 的消息。
 * `undefined` 合法（没有关键日期）。
 */
export function loreKeyDateErrors(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['keyDates must be an array'];
  const errors: string[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    for (const message of keyDateItemErrors(item)) errors.push(`keyDates[${index}]: ${message}`);
    const id = isObject(item) ? item.id : undefined;
    if (typeof id !== 'string') return;
    if (ids.has(id)) errors.push(`keyDates[${index}]: duplicate id ${id}`);
    ids.add(id);
  });
  return errors;
}

/**
 * 容错解析：永不抛。坏的一项整项跳过，不连累同条目的其他日期；重复 id 只留第一个。
 * 运行期读取一律走这里 —— 世界书可能来自工坊或用户编辑，不能假定它通过了安装校验。
 */
export function parseLoreKeyDates(value: unknown): LoreKeyDate[] {
  if (!Array.isArray(value)) return [];
  const result: LoreKeyDate[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (keyDateItemErrors(item).length > 0) continue;
    const date = item as LoreKeyDate;
    if (ids.has(date.id)) continue;
    ids.add(date.id);
    result.push(date);
  }
  return result;
}

export interface CollectedLoreKeyDate {
  /** 全局稳定键 `<条目 uid>#<id>`（R7）：玩家的显示选择按它记忆 */
  key: string;
  bookId: string;
  entryUid: string;
  date: LoreKeyDate;
}

/**
 * 汇总若干世界书里的全部关键日期。条目是否算数由调用方的 `include` 决定
 * （如「本存档启用的条目」）；缺省跳过 `enabled === false` 的条目。
 */
export function collectLoreKeyDates(
  books: readonly WorldBook[],
  include: (book: WorldBook, entry: WorldBookEntry) => boolean = (_book, entry) =>
    entry.enabled !== false,
): CollectedLoreKeyDate[] {
  const result: CollectedLoreKeyDate[] = [];
  for (const book of books) {
    for (const entry of book.entries) {
      if (!include(book, entry)) continue;
      for (const date of parseLoreKeyDates(entry.extra?.lore?.keyDates))
        result.push({ key: `${entry.uid}#${date.id}`, bookId: book.id, entryUid: entry.uid, date });
    }
  }
  return result;
}

/** 这个日期在某一年是否举办。按月重复的每年都算；多年一度按起算年取模（R3）。 */
export function keyDateOccursInYear(date: Pick<LoreKeyDate, 'repeat'>, year: number): boolean {
  const repeat: LoreKeyDateRepeat = date.repeat ?? { unit: 'year' };
  if (repeat.unit === 'month') return true;
  if (repeat.unit === 'once') return repeat.year === year;
  const interval = repeat.interval ?? 1;
  if (interval <= 1 || repeat.anchorYear === undefined) return true;
  return (((year - repeat.anchorYear) % interval) + interval) % interval === 0;
}

const dayOfYear = (md: { month: number; day: number }) => (md.month - 1) * DAYS_PER_MONTH + md.day;

function inSpan(
  value: number,
  start: number,
  end: number,
): 'no' | 'same' | 'wrapHead' | 'wrapTail' {
  if (start <= end) return value >= start && value <= end ? 'same' : 'no';
  // R2：end 早于 start 表示跨界（跨年，或按月重复时跨月）
  if (value >= start) return 'wrapHead';
  return value <= end ? 'wrapTail' : 'no';
}

/**
 * 某一天是否落在这个关键日期的日期范围内。只有 `precision: 'day'` 的项才可能为真；
 * 月 / 季 / 不定精度的项不占具体日期格。
 *
 * 跨年范围（如 12/29–1/2）归属于**起始那一年**的那一届：1 月的尾段是否算数，看的是上一年办不办。
 */
export function keyDateCoversDay(
  date: Pick<LoreKeyDate, 'when' | 'repeat'>,
  day: { year: number; month: number; day: number },
): boolean {
  const when: LoreKeyDateWhen = date.when;
  if (when.precision !== 'day') return false;
  const end: LoreKeyDateMonthDay = when.end ?? when.start;
  if (date.repeat?.unit === 'month') return inSpan(day.day, when.start.day, end.day) !== 'no';
  if (when.start.month === undefined || end.month === undefined) return false;
  const span = inSpan(
    dayOfYear(day),
    dayOfYear({ month: when.start.month, day: when.start.day }),
    dayOfYear({ month: end.month, day: end.day }),
  );
  if (span === 'no') return false;
  return keyDateOccursInYear(date, span === 'wrapTail' ? day.year - 1 : day.year);
}

/** 去掉 `keyDates` 的元数据副本：用于只关心提示词内容的指纹，日历元数据的改动不该让它变化。 */
export function withoutLoreKeyDates<T extends { keyDates?: unknown }>(
  lore: T | undefined,
): Omit<T, 'keyDates'> | undefined {
  if (lore === undefined) return undefined;
  const copy: { keyDates?: unknown } & Omit<T, 'keyDates'> = { ...lore };
  delete copy.keyDates;
  return copy;
}
