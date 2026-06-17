/**
 * $time — 游戏时间系统 (Layer 2, AI 可读)
 *
 * Phase 5 模块。职责:
 * 1. 游戏内时间表示 (纪元/年/月/日/星期/时/分)
 * 2. 时间推进 (advance)
 * 3. 时间比较 (isBefore/isAfter/diff)
 * 4. 时间格式化
 */

// ========== 时间类型 ==========

/** 游戏内时间 */
export interface GameTime {
  era: string;               // 纪元名，如 "光辉纪元"
  year: number;              // 1-based
  month: number;             // 1-12
  day: number;               // 1-30 (统一每月30天)
  weekday: number;           // 1-7
  hour: number;              // 0-23
  minute: number;            // 0-59
}

/** 月份名 */
export const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
] as const;

/** 星期名 */
export const WEEKDAY_NAMES = [
  '周日', '周一', '周二', '周三', '周四', '周五', '周六',
] as const;

/** 每日分钟数 */
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;

// ========== 默认时间 ==========

/** 创建默认起始时间 */
export function createDefaultTime(era: string = '复兴纪元'): GameTime {
  return {
    era,
    year: 1,
    month: 1,
    day: 1,
    weekday: 1, // 周日
    hour: 8,
    minute: 0,
  };
}

// ========== 时间解析 ==========

/**
 * 解析游戏时间字符串
 * 格式: "复兴纪元001年-05月-24日-周日-15:30"
 */
export function parseGameTime(timeStr: string): GameTime | null {
  const regex = /^(.+?)(\d{1,4})年-(\d{2})月-(\d{2})日-(周[一二三四五六日])-(\d{2}):(\d{2})$/;
  const match = timeStr.match(regex);
  if (!match) return null;

  const weekdayMap: Record<string, number> = {
    '周一': 1, '周二': 2, '周三': 3, '周四': 4,
    '周五': 5, '周六': 6, '周日': 7,
  };

  return {
    era: match[1],
    year: parseInt(match[2], 10),
    month: parseInt(match[3], 10),
    day: parseInt(match[4], 10),
    weekday: weekdayMap[match[5]] ?? 7,
    hour: parseInt(match[6], 10),
    minute: parseInt(match[7], 10),
  };
}

// ========== 时间格式化 ==========

/** 格式化游戏时间 */
export function formatGameTime(time: GameTime): string {
  const pad = (n: number, len: number = 2) => String(n).padStart(len, '0');
  const eraYear = `${time.era}${pad(time.year, 4)}年`;
  const monthDay = `${pad(time.month)}月-${pad(time.day)}日`;
  const wd = WEEKDAY_NAMES[time.weekday - 1] ?? '周日';
  const hm = `${pad(time.hour)}:${pad(time.minute)}`;
  return `${eraYear}-${monthDay}-${wd}-${hm}`;
}

/** 简短格式 */
export function formatGameTimeShort(time: GameTime): string {
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')} ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

// ========== 时间推进 ==========

/** 推进指定分钟 */
export function advanceTime(time: GameTime, minutes: number): GameTime {
  let totalMinutes = time.minute + minutes;

  let { hour, day, month, year, weekday } = time;

  // 进位到小时
  while (totalMinutes >= MINUTES_PER_HOUR) {
    totalMinutes -= MINUTES_PER_HOUR;
    hour++;
  }
  while (totalMinutes < 0) {
    totalMinutes += MINUTES_PER_HOUR;
    hour--;
  }

  // 进位到天
  while (hour >= HOURS_PER_DAY) {
    hour -= HOURS_PER_DAY;
    day++;
    weekday = (weekday % 7) + 1;
  }
  while (hour < 0) {
    hour += HOURS_PER_DAY;
    day--;
    weekday = ((weekday + 5) % 7) + 1;
  }

  // 进位到月
  while (day > DAYS_PER_MONTH) {
    day -= DAYS_PER_MONTH;
    month++;
  }
  while (day < 1) {
    day += DAYS_PER_MONTH;
    month--;
  }

  // 进位到年
  while (month > MONTHS_PER_YEAR) {
    month -= MONTHS_PER_YEAR;
    year++;
  }
  while (month < 1) {
    month += MONTHS_PER_YEAR;
    year--;
  }

  return {
    era: time.era,
    year: Math.max(1, year),
    month: Math.max(1, Math.min(MONTHS_PER_YEAR, month)),
    day: Math.max(1, Math.min(DAYS_PER_MONTH, day)),
    weekday: ((weekday - 1 + 7) % 7) + 1,
    hour: Math.max(0, Math.min(HOURS_PER_DAY - 1, hour)),
    minute: Math.max(0, Math.min(MINUTES_PER_HOUR - 1, totalMinutes)),
  };
}

/** 推进小时 */
export function advanceHours(time: GameTime, hours: number): GameTime {
  return advanceTime(time, hours * MINUTES_PER_HOUR);
}

/** 推进天 */
export function advanceDays(time: GameTime, days: number): GameTime {
  return advanceTime(time, days * HOURS_PER_DAY * MINUTES_PER_HOUR);
}

// ========== 时间比较 ==========

/** 转换为总分钟数（用于比较） */
export function toTotalMinutes(time: GameTime): number {
  return (
    time.year * MONTHS_PER_YEAR * DAYS_PER_MONTH * HOURS_PER_DAY * MINUTES_PER_HOUR +
    (time.month - 1) * DAYS_PER_MONTH * HOURS_PER_DAY * MINUTES_PER_HOUR +
    (time.day - 1) * HOURS_PER_DAY * MINUTES_PER_HOUR +
    time.hour * MINUTES_PER_HOUR +
    time.minute
  );
}

/** a 是否在 b 之前 */
export function isBefore(a: GameTime, b: GameTime): boolean {
  return toTotalMinutes(a) < toTotalMinutes(b);
}

/** a 是否在 b 之后 */
export function isAfter(a: GameTime, b: GameTime): boolean {
  return toTotalMinutes(a) > toTotalMinutes(b);
}

/** 两个时间的分钟差 (a - b) */
export function diffMinutes(a: GameTime, b: GameTime): number {
  return toTotalMinutes(a) - toTotalMinutes(b);
}

/** 两个时间的天数差 */
export function diffDays(a: GameTime, b: GameTime): number {
  return Math.floor(diffMinutes(a, b) / (HOURS_PER_DAY * MINUTES_PER_HOUR));
}

// ========== 时间段 ==========

/** 判断是否为白天 (6:00-18:00) */
export function isDaytime(time: GameTime): boolean {
  return time.hour >= 6 && time.hour < 18;
}

/** 获取时段描述 */
export function getTimeOfDay(time: GameTime): string {
  const h = time.hour;
  if (h < 6) return '凌晨';
  if (h < 9) return '早晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 21) return '傍晚';
  return '深夜';
}

/** 获取月份所属季节 */
export function getSeason(month: number): string {
  if (month <= 3) return '春季';
  if (month <= 6) return '夏季';
  if (month <= 9) return '秋季';
  return '冬季';
}

// ========== $time Namespace ==========

/** AI 可读的 $time API */
export const $time = {
  createDefaultTime,
  parseGameTime,
  formatGameTime,
  formatGameTimeShort,
  advanceTime,
  advanceHours,
  advanceDays,
  isBefore,
  isAfter,
  diffMinutes,
  diffDays,
  isDaytime,
  getTimeOfDay,
  getSeason,
  MONTH_NAMES,
  WEEKDAY_NAMES,
} as const;
