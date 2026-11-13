/**
 * 日历视图的纯计算：合并来源并应用模式与显示选择、月视图、近期列表。
 * 不读时钟、不做 I/O；「今天」与所有数据都由调用方传入。历法 12 月 × 30 日。
 */
import type {
  CalendarDayItem,
  CalendarItem,
  CalendarMonthView,
  CalendarUpcomingItem,
  SaveCalendar,
} from '../types/types-calendar';
import { keyDateCoversDay, keyDateOccursInYear } from '../content/lore-key-dates';
import { ageTurningInYear } from '../character/character-age';
import { advanceDays, fromEpochMinutes, toEpochMinutes } from '../time/time-system';
import { locationPathMatches } from '../content/lore-activation';
import { userEntryItems } from './calendar-sources';

const DAYS_PER_MONTH = 30;
type Day = { year: number; month: number; day: number };

const asGameTime = (date: Day) => ({ ...date, era: '', weekday: 1, hour: 0, minute: 0 });

export interface CalendarItemSources {
  calendar: Pick<
    SaveCalendar,
    'mode' | 'entries' | 'hiddenKinds' | 'hiddenRegions' | 'hiddenKeys' | 'localRegionOnly'
  >;
  /** `deriveFestivalItems` 的结果 */
  festivals: readonly CalendarItem[];
  /** `deriveBirthdayItems` 的结果 */
  birthdays: readonly CalendarItem[];
  /** 主角当前位置路径（各段），供「只看所在地区」；匹配规则同 `activation.locations` */
  locationPath?: readonly string[];
}

/**
 * 当前应当显示的全部日历项。
 *
 * 沉浸模式下自动来源**完全不参与**（不是算了再藏）；玩家条目两种模式都在，且不受隐藏设置影响。
 * 有多个地区的节庆，只要还有一个地区没被隐藏就显示。
 */
export function buildCalendarItems(sources: CalendarItemSources): CalendarItem[] {
  const { calendar } = sources;
  const user = userEntryItems(calendar.entries);
  if (calendar.mode === 'immersive') return user;
  const hiddenKeys = new Set(calendar.hiddenKeys);
  const hiddenRegions = new Set(calendar.hiddenRegions);
  const visible = (item: CalendarItem): boolean => {
    if (item.kind !== 'user' && calendar.hiddenKinds.includes(item.kind)) return false;
    if (hiddenKeys.has(item.key)) return false;
    const regions = item.regions ?? [];
    if (regions.length === 0) return true;
    if (regions.every((region) => hiddenRegions.has(region))) return false;
    return !calendar.localRegionOnly || locationPathMatches(sources.locationPath ?? [], regions);
  };
  return [...user, ...sources.festivals.filter(visible), ...sources.birthdays.filter(visible)];
}

/** 这一项在这一天是否出现；生日顺带算出满几岁，尚未出生的年份不出现。 */
function dayItem(item: CalendarItem, date: Day): CalendarDayItem | null {
  if (!keyDateCoversDay(item, date)) return null;
  if (item.kind !== 'birthday' || !item.ageAnchor) return { item };
  const age = ageTurningInYear(item.ageAnchor, date.year);
  return age >= 1 ? { item, age } : null;
}

/** 月视图：30 个日期格（含星期与当日项）+ 只精确到本月的项。 */
export function buildMonthView(
  year: number,
  month: number,
  items: readonly CalendarItem[],
  today?: Day | null,
): CalendarMonthView {
  const days = Array.from({ length: DAYS_PER_MONTH }, (_, index) => {
    const date = { year, month, day: index + 1 };
    return {
      day: date.day,
      weekday: fromEpochMinutes(toEpochMinutes(asGameTime(date))).weekday,
      isToday: !!today && today.year === year && today.month === month && today.day === date.day,
      items: items.flatMap((item) => dayItem(item, date) ?? []),
    };
  });
  const undated = items.filter(
    (item) =>
      item.when.precision === 'month' &&
      item.when.month === month &&
      keyDateOccursInYear(item, year),
  );
  return { year, month, days, undated };
}

/** 只到季节或完全没有日期的项：不属于任何月份，单独列出。只列在 `year` 这一年举办的。 */
export function listUndatedItems(items: readonly CalendarItem[], year: number): CalendarItem[] {
  return items.filter(
    (item) =>
      (item.when.precision === 'season' || item.when.precision === 'none') &&
      keyDateOccursInYear(item, year),
  );
}

/**
 * 从今天起 `days` 天内出现的项，按日期排列；每项只列一次（取它在窗口内的第一天）。
 * 正在进行中的多日节庆算作今天。
 */
export function listUpcoming(
  items: readonly CalendarItem[],
  today: Day,
  days: number,
): CalendarUpcomingItem[] {
  const result: CalendarUpcomingItem[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < days; offset++) {
    const { year, month, day } = advanceDays(asGameTime(today), offset);
    const date = { year, month, day };
    for (const item of items) {
      if (seen.has(item.key)) continue;
      const hit = dayItem(item, date);
      if (!hit) continue;
      seen.add(item.key);
      result.push({ ...hit, date, daysAway: offset });
    }
  }
  return result;
}
