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
  era: string; // 纪元名，如 "光辉纪元"
  year: number; // 1-based
  month: number; // 1-12
  day: number; // 1-30 (统一每月30天)
  weekday: number; // 1-7 (1=周日 … 7=周六，对齐 WEEKDAY_NAMES[weekday-1]，见常量注释)
  hour: number; // 0-23
  minute: number; // 0-59
}

/** 季节性时间 — 用于剧情大纲等粗粒度时间排序（AI 只能预测到年+季节精度） */
export interface SeasonalTime {
  year: number; // 绝对年份，如 512
  season: number; // 1=春 2=夏 3=秋 4=冬
  month?: number; // 可选，1-12
}

/** 季节名常量（1-based 索引：下标 0=春） */
export const SEASON_NAMES = ['春', '夏', '秋', '冬'] as const;

/** 月份名 */
export const MONTH_NAMES = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
] as const;

/**
 * 星期名 — weekday 数值约定（写死，#31）:
 * weekday 1-7 与本数组下标对齐，即 weekday=1 → WEEKDAY_NAMES[0]='周日' … weekday=7 → WEEKDAY_NAMES[6]='周六'。
 * parseGameTime / formatGameTime 均以 `WEEKDAY_NAMES[weekday-1]` 为唯一映射，
 * 禁止再引入 1=周一…7=周日 的 ISO 序（曾导致 parse(format(t)) 往返漂移: 周日→7→'周六'）。
 */
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 每日分钟数 */
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;

// ========== 时间戳纪元（Unix time_t 模型，最小粒度 1 分钟）==========
/**
 * 纪元基准年：复兴纪元488年01月01日 00:00 = 第 0 分钟（时间戳 0）。
 * 仿 Unix epoch（1970-01-01），最小粒度 1 分钟。所有比较/推进经 toEpochMinutes 归一为整数。
 */
export const GAME_EPOCH_YEAR = 488;
/** 纪元日（488-01-01）是周几：1=周日 … 7=周六。幻想日历无外部基准，声明值。 */
const EPOCH_WEEKDAY = 1; // 周日
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR; // 1440
const MINUTES_PER_MONTH = DAYS_PER_MONTH * MINUTES_PER_DAY; // 43200
const MINUTES_PER_YEAR = MONTHS_PER_YEAR * MINUTES_PER_MONTH; // 518400

// ========== 默认时间 ==========

/**
 * 创建默认起始时间（游戏开局时刻）= 复兴纪元488年01月01日 08:00（epoch 第 480 分钟）。
 * 纪元 0 点定义在 488-01-01 00:00；开局时刻 08:00 与纪元定义分离（同 Unix epoch=00:00 不代表程序 00:00 启动）。
 */
export function createDefaultTime(era: string = '复兴纪元'): GameTime {
  return {
    era,
    year: GAME_EPOCH_YEAR,
    month: 1,
    day: 1,
    weekday: EPOCH_WEEKDAY, // 周日
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

  // #31: 名字 → 数值映射直接从 WEEKDAY_NAMES 推导（1=周日 … 7=周六），
  // 与 formatGameTime 的 WEEKDAY_NAMES[weekday-1] 结构性对齐，杜绝双约定漂移。
  const weekdayIdx = WEEKDAY_NAMES.indexOf(match[5] as (typeof WEEKDAY_NAMES)[number]);

  return {
    era: match[1],
    year: parseInt(match[2], 10),
    month: parseInt(match[3], 10),
    day: parseInt(match[4], 10),
    weekday: weekdayIdx >= 0 ? weekdayIdx + 1 : 1,
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

/**
 * 推进指定分钟 — 仿 Unix：时间戳相加再拆回。
 * toEpochMinutes(time) + minutes → fromEpochMinutes，保留原 era 标签。负数合法（可回拨/纪元前）。
 */
export function advanceTime(time: GameTime, minutes: number): GameTime {
  const advanced = fromEpochMinutes(toEpochMinutes(time) + minutes);
  return { ...advanced, era: time.era };
}

/** 推进小时 */
export function advanceHours(time: GameTime, hours: number): GameTime {
  return advanceTime(time, hours * MINUTES_PER_HOUR);
}

/** 推进天 */
export function advanceDays(time: GameTime, days: number): GameTime {
  return advanceTime(time, days * HOURS_PER_DAY * MINUTES_PER_HOUR);
}

// ========== 时间戳转换（mktime / gmtime 对偶）==========

/**
 * GameTime → 时间戳（分钟数）。仿 Unix mktime。
 * 纪元：复兴纪元488年01月01日 00:00 = 0。weekday 不参与（派生量，非独立时间维度）。
 * 负值合法（纪元前/回拨），同 Unix time_t 允许负数。
 */
export function toEpochMinutes(time: GameTime): number {
  return (
    (time.year - GAME_EPOCH_YEAR) * MINUTES_PER_YEAR +
    (time.month - 1) * MINUTES_PER_MONTH +
    (time.day - 1) * MINUTES_PER_DAY +
    time.hour * MINUTES_PER_HOUR +
    time.minute
  );
}

/**
 * 时间戳（分钟数）→ GameTime。仿 Unix gmtime。
 * weekday 由纪元日起算（每 1440 分钟进一日，7 日一循环），非存储独立量。
 */
export function fromEpochMinutes(em: number): GameTime {
  let rem = em;
  const yearOffset = Math.floor(rem / MINUTES_PER_YEAR);
  rem -= yearOffset * MINUTES_PER_YEAR;
  const month = Math.floor(rem / MINUTES_PER_MONTH) + 1;
  rem -= (month - 1) * MINUTES_PER_MONTH;
  const day = Math.floor(rem / MINUTES_PER_DAY) + 1;
  rem -= (day - 1) * MINUTES_PER_DAY;
  const hour = Math.floor(rem / MINUTES_PER_HOUR);
  rem -= hour * MINUTES_PER_HOUR;
  const minute = rem;
  const daysSinceEpoch = Math.floor(em / MINUTES_PER_DAY);
  const weekday = ((((daysSinceEpoch + EPOCH_WEEKDAY - 1) % 7) + 7) % 7) + 1;
  return {
    era: '复兴纪元',
    year: yearOffset + GAME_EPOCH_YEAR,
    month,
    day,
    weekday,
    hour,
    minute,
  };
}

// ========== 时间比较 ==========

/** a 是否在 b 之前 */
export function isBefore(a: GameTime, b: GameTime): boolean {
  return toEpochMinutes(a) < toEpochMinutes(b);
}

/** a 是否在 b 之后 */
export function isAfter(a: GameTime, b: GameTime): boolean {
  return toEpochMinutes(a) > toEpochMinutes(b);
}

/** 两个时间的分钟差 (a - b) */
export function diffMinutes(a: GameTime, b: GameTime): number {
  return toEpochMinutes(a) - toEpochMinutes(b);
}

/** 两个时间的天数差 */
export function diffDays(a: GameTime, b: GameTime): number {
  return Math.floor(diffMinutes(a, b) / MINUTES_PER_DAY);
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

// ========== 季节性时间（剧情大纲排序用） ==========

/**
 * 解析季节性时间字符串
 * 接受格式: "512-春" / "512-夏-06" / "512-冬"
 * @returns SeasonalTime 对象，无效格式返回 null
 */
export function parseSeasonalTime(str: string): SeasonalTime | null {
  const regex = /^(\d+)-(春|夏|秋|冬)(?:-(\d{1,2}))?$/;
  const match = str.match(regex);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const seasonName = match[2];
  const seasonMap: Record<string, number> = { 春: 1, 夏: 2, 秋: 3, 冬: 4 };
  const season = seasonMap[seasonName];

  if (match[3] !== undefined) {
    const month = parseInt(match[3], 10);
    if (month < 1 || month > 12) return null;
    return { year, season, month };
  }

  return { year, season };
}

/**
 * 格式化季节性时间为字符串
 * "512-春" 或 "512-夏-06"（如有 month）
 */
export function formatSeasonalTime(t: SeasonalTime): string {
  const name = SEASON_NAMES[t.season - 1] ?? '春';
  if (t.month !== undefined) {
    const pad = String(t.month).padStart(2, '0');
    return `${t.year}-${name}-${pad}`;
  }
  return `${t.year}-${name}`;
}

/**
 * 比较两个季节性时间
 * 排序: year → season → month（缺 month 视为季节开头 < 任何有 month 的值）
 * @returns 负数 a<b，正数 a>b，0 相等
 */
export function compareSeasonalTime(a: SeasonalTime, b: SeasonalTime): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.season !== b.season) return a.season - b.season;
  // both undefined → equal; one undefined → that one is "less" (start of season)
  if (a.month === undefined && b.month === undefined) return 0;
  if (a.month === undefined) return -1;
  if (b.month === undefined) return 1;
  return a.month - b.month;
}

// ========== $time Namespace ==========

/** AI 可读的 $time API */
export const $time = {
  GAME_EPOCH_YEAR,
  createDefaultTime,
  toEpochMinutes,
  fromEpochMinutes,
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
  parseSeasonalTime,
  formatSeasonalTime,
  compareSeasonalTime,
  SEASON_NAMES,
  MONTH_NAMES,
  WEEKDAY_NAMES,
} as const;
