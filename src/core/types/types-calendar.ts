/**
 * 日历系统 v1 的类型分册。日历完全本地、按存档隔离，**不进入任何提示词**。
 * 设计见 docs/planning/2026-11-13-calendar-system-v1-design.md。
 */
import type { LoreKeyDate, LoreKeyDateRepeat, LoreKeyDateWhen } from './types';
import type { CharacterAgeAnchor } from './types-character';

/** 沉浸 = 只有玩家自己录入的条目；普通 = 再加自动载入的节庆与角色生日 */
export type CalendarMode = 'immersive' | 'normal';
type CalendarItemKind = 'user' | 'festival' | 'birthday';
/** 可以被整类隐藏的自动来源 */
export type CalendarAutoKind = Exclude<CalendarItemKind, 'user'>;

export interface CalendarMonthDay {
  month: number; // 1-12
  day: number; // 1-30
}

/** 玩家自己录入的日子 */
export interface CalendarUserEntry {
  id: string;
  title: string;
  note?: string;
  start: CalendarMonthDay;
  /** 缺省 = 单日；早于 `start` 表示跨年 */
  end?: CalendarMonthDay;
  /** 缺省 = 每年重复；给了就只在那一年 */
  year?: number;
  createdAt: number;
}

/** 每存档一行（Dexie `saveCalendars`）。缺行即默认值，见 `defaultSaveCalendar`。 */
export interface SaveCalendar {
  saveId: string;
  mode: CalendarMode;
  entries: CalendarUserEntry[];
  /** 存「隐藏了什么」而不是「显示了什么」：新出现的节庆与角色默认可见 */
  hiddenKinds: CalendarAutoKind[];
  hiddenRegions: string[];
  hiddenKeys: string[];
  /** 只显示主角所在地区的节庆（无地区的全大陆节庆始终显示） */
  localRegionOnly: boolean;
  updatedAt: number;
}

/** 三类来源归一后的日历项。日期与重复规则沿用关键日期的形状，判定函数共用。 */
export interface CalendarItem {
  /** `user:<id>` / `<条目 uid>#<关键日期 id>` / `birthday:<characterId>` */
  key: string;
  kind: CalendarItemKind;
  title: string;
  note?: string;
  when: LoreKeyDateWhen;
  repeat?: LoreKeyDateRepeat;
  regions?: string[];
  approximate?: boolean;
  major?: boolean;
  category?: string;
  timeNote?: string;
  tags?: string[];
  highlights?: LoreKeyDate['highlights'];
  /** 仅生日项：用来算「这一年满几岁」 */
  ageAnchor?: CharacterAgeAnchor;
}

/** 某一天格子里的一项 */
export interface CalendarDayItem {
  item: CalendarItem;
  /** 仅生日项：这一年满几岁 */
  age?: number;
}

interface CalendarDayCell {
  day: number; // 1-30
  /** 1=周日 … 7=周六，同 `GameTime.weekday` */
  weekday: number;
  isToday: boolean;
  items: CalendarDayItem[];
}

export interface CalendarMonthView {
  year: number;
  month: number;
  days: CalendarDayCell[];
  /** 只精确到本月、不占具体日期格的项 */
  undated: CalendarItem[];
}

export interface CalendarUpcomingItem extends CalendarDayItem {
  date: { year: number; month: number; day: number };
  /** 距今天数；0 = 今天（含正在进行的多日节庆） */
  daysAway: number;
}
