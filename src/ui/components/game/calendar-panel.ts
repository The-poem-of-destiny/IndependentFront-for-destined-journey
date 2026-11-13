/**
 * CalendarPanel 的展示层判定（纯函数，不 mount 可测）。
 * 日历项的计算在引擎 `@engine/calendar/*`；这里只管「怎么说、怎么分组」。
 */
import type { CalendarItem, CalendarUserEntry } from '@engine/types/types-calendar';

export const KIND_LABELS: Record<CalendarItem['kind'], string> = {
  festival: '节庆',
  birthday: '生日',
  user: '我的',
};

const SEASON_LABELS = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' } as const;

/** 「9月8日」/「9月8日–14日」/「12月29日–1月2日」/「每月15日」/「5月（日期未定）」… */
export function formatItemDate(item: Pick<CalendarItem, 'when' | 'repeat'>): string {
  const { when } = item;
  if (when.precision === 'month') return `${when.month}月（日期未定）`;
  if (when.precision === 'season') return `${SEASON_LABELS[when.season]}（日期未定）`;
  if (when.precision === 'none')
    return item.repeat?.unit === 'month' ? '每月（日期未定）' : '日期未定';
  const monthly = item.repeat?.unit === 'month';
  const label = (md: { month?: number; day: number }) =>
    monthly || md.month === undefined ? `${md.day}日` : `${md.month}月${md.day}日`;
  const start = label(when.start);
  const end = when.end;
  const sameDay = !end || (end.month === when.start.month && end.day === when.start.day);
  const range = sameDay
    ? start
    : `${start}–${!monthly && end.month === when.start.month ? `${end.day}日` : label(end)}`;
  return monthly ? `每月${range}` : range;
}

/** 重复规则的补充说明；每年一次的不说。 */
export function formatItemRepeat(item: Pick<CalendarItem, 'repeat'>): string {
  const repeat = item.repeat;
  if (!repeat || repeat.unit === 'month') return '';
  if (repeat.unit === 'once') return `仅 ${repeat.year} 年`;
  return (repeat.interval ?? 1) > 1 ? `每 ${repeat.interval} 年一次` : '';
}

/** 生日项的标题带上「满 N 岁」。 */
export function itemTitle(item: CalendarItem, age?: number): string {
  if (item.kind !== 'birthday') return item.title;
  return age === undefined ? `${item.title}的生日` : `${item.title}的生日 · 满 ${age} 岁`;
}

export interface RegionGroup {
  /** 空串 = 通行全大陆 */
  region: string;
  items: CalendarItem[];
}

/** 筛选抽屉里节庆按地区分组；有多个地区的节庆归到第一个地区名下。全大陆的排最前。 */
export function groupFestivalsByRegion(festivals: readonly CalendarItem[]): RegionGroup[] {
  const groups = new Map<string, CalendarItem[]>();
  for (const item of festivals) {
    const region = item.regions?.[0] ?? '';
    groups.set(region, [...(groups.get(region) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'zh-Hans-CN')))
    .map(([region, items]) => ({ region, items }));
}

export interface EntryDraft {
  id: string | null;
  title: string;
  note: string;
  startMonth: number;
  startDay: number;
  multiDay: boolean;
  endMonth: number;
  endDay: number;
  /** true = 每年重复；false = 只在 `year` 那一年 */
  yearly: boolean;
  year: number;
}

export function newEntryDraft(date: { year: number; month: number; day: number }): EntryDraft {
  return {
    id: null,
    title: '',
    note: '',
    startMonth: date.month,
    startDay: date.day,
    multiDay: false,
    endMonth: date.month,
    endDay: date.day,
    yearly: true,
    year: date.year,
  };
}

export function draftFromEntry(entry: CalendarUserEntry, fallbackYear: number): EntryDraft {
  return {
    id: entry.id,
    title: entry.title,
    note: entry.note ?? '',
    startMonth: entry.start.month,
    startDay: entry.start.day,
    multiDay: entry.end !== undefined,
    endMonth: entry.end?.month ?? entry.start.month,
    endDay: entry.end?.day ?? entry.start.day,
    yearly: entry.year === undefined,
    year: entry.year ?? fallbackYear,
  };
}

/** 草稿 → 可落库的条目；标题为空返回 null（保存按钮据此禁用）。 */
export function entryFromDraft(
  draft: EntryDraft,
  newId: () => string,
): Omit<CalendarUserEntry, 'createdAt'> | null {
  const title = draft.title.trim();
  if (!title) return null;
  const note = draft.note.trim();
  return {
    id: draft.id ?? newId(),
    title,
    start: { month: draft.startMonth, day: draft.startDay },
    ...(draft.multiDay ? { end: { month: draft.endMonth, day: draft.endDay } } : {}),
    ...(draft.yearly ? {} : { year: draft.year }),
    ...(note ? { note } : {}),
  };
}
