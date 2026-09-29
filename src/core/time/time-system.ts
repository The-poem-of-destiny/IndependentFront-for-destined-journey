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
  /**
   * 纪元名 —— **纯标签**，由内容侧供给（branding 面），引擎不解释其含义（D9）。
   *
   * 🔴 引擎不认识任何具体纪元名：所有时间算术只用 `year/month/day/hour/minute`
   * （见 `GAME_EPOCH_YEAR`）。era 只参与显示与解析，且**只跟着调用方给的值走** ——
   * 任何在引擎里写死一个纪元名的地方，都会在往返（`toEpochMinutes` → `fromEpochMinutes`）
   * 时把存档盖章的那个值冲掉。
   */
  era: string;
  year: number; // 1-based
  month: number; // 1-12
  day: number; // 1-30 (统一每月30天)
  weekday: number; // 1-7 (1=周日 … 7=周六，对齐 WEEKDAY_NAMES[weekday-1]，见常量注释)
  hour: number; // 0-23
  minute: number; // 0-59
}

/**
 * 大纲时间 — 年-月粒度，用于剧情大纲时间窗口（AI 可预测到月精度）。
 * 字符串格式 "512-03"（年-月，month 补零）；旧「年-季节」格式（"512-春"）已弃用，
 * 旧存档里遗留的字符串只作展示原样直存，不经本类型解析。
 */
export interface MonthTime {
  year: number; // 绝对年份，如 512
  month: number; // 1-12
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
 * 纪元基准年：第 488 年 01月01日 00:00 = 第 0 分钟（时间戳 0）。
 * 仿 Unix epoch（1970-01-01），最小粒度 1 分钟。所有比较/推进经 toEpochMinutes 归一为整数。
 *
 * 🔴 这是**时间算术原点**（引擎常量，D9），不是内容：它与叫什么纪元名无关，
 * 换一份内容包也不会变 —— 变了等于所有存档的既有时间戳集体漂移。
 */
export const GAME_EPOCH_YEAR = 488;
/** 纪元日（488-01-01）是周几：1=周日 … 7=周六。幻想日历无外部基准，声明值。 */
const EPOCH_WEEKDAY = 1; // 周日
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR; // 1440
const MINUTES_PER_MONTH = DAYS_PER_MONTH * MINUTES_PER_DAY; // 43200
const MINUTES_PER_YEAR = MONTHS_PER_YEAR * MINUTES_PER_MONTH; // 518400

// ========== 默认时间 ==========

/**
 * 引擎侧的中性纪元名（D9）= **空串**。
 *
 * 🔴 刻意不给一个「像样的」缺省名：引擎里任何具体纪元名都是内容。
 * 真值由内容侧（branding 面）在**存档创建时盖章**进 `SaveProfile.gameTime.era`，
 * 此后只读存档、永不活读内容包 —— 否则卸包会追溯改名每一个存档的历法。
 * 空串还有一个好处：漏接线时显示成「0488年-…」一眼看得出来，
 * 而一个看着合理的缺省名会把「盖章没接上」伪装成正常。
 */
const NEUTRAL_ERA = '';

/**
 * 创建默认起始时间（游戏开局时刻）= 第 488 年 01月01日 08:00（epoch 第 480 分钟）。
 * 纪元 0 点定义在 488-01-01 00:00；开局时刻 08:00 与纪元定义分离（同 Unix epoch=00:00 不代表程序 00:00 启动）。
 *
 * @param era 纪元名，由调用方（存档创建路径）从内容侧取；缺省为中性空串（D9）
 */
export function createDefaultTime(era: string = NEUTRAL_ERA): GameTime {
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
 * 格式: "<纪元名>0001年-05月-24日-周日-15:30"
 *
 * 🔴 纪元名段是 `(.*?)` 而非 `(.+?)`（D9）：era 可以为空（中性缺省），
 * 而 `formatGameTime` 对空 era 会产出 "0488年-…"。用 `.+?` 会让
 * `parseGameTime(formatGameTime(t))` 这条既有往返不变式在空 era 下静默返回 null。
 */
export function parseGameTime(timeStr: string): GameTime | null {
  const regex = /^(.*?)(\d{1,4})年-(\d{2})月-(\d{2})日-(周[一二三四五六日])-(\d{2}):(\d{2})$/;
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
 *
 * era 直接**传进** fromEpochMinutes（D9），不再「先被冲成硬编码值、再靠展开覆盖回来」。
 */
export function advanceTime(time: GameTime, minutes: number): GameTime {
  return fromEpochMinutes(toEpochMinutes(time) + minutes, time.era);
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
 * 纪元：第 488 年 01月01日 00:00 = 0。**era 不参与**（纯标签，D9），
 * weekday 也不参与（派生量，非独立时间维度）。
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
 *
 * 🔴 era 由**调用方供给**（D9）。时间戳里没有纪元名这一维，所以这里凭空补一个具体名字
 * 就等于「每次 epoch→GameTime 往返都把存档盖章的那个值冲掉」—— 这正是 D9 点名要拆的坑。
 * 缺省是中性空串，不是任何具体纪元。
 *
 * @param era 纪元标签，原样写进返回值；缺省中性空串
 */
export function fromEpochMinutes(em: number, era: string = NEUTRAL_ERA): GameTime {
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
    era,
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

/**
 * GameTime → **游戏内日序**（`floor(时间戳 / 1440)`，纪元日 = 0，负值合法）。
 *
 * 这个数是地图 v1.2 / 随机事件 v1 那套「锚 + 纯推导」调度的通用坐标：状态的
 * `appliedAtDay`、收益的 `anchorDay`、编年史条目的 `day` 全都以它为单位。
 * 单列成函数是因为它此前在提示装配侧被就地重算 —— 而重算意味着 `1440` 这个常量
 * 要在每个调用点各抄一遍，抄错了不会红，只是「还剩几天」全线偏移。
 */
export function toGameDay(time: GameTime): number {
  return Math.floor(toEpochMinutes(time) / MINUTES_PER_DAY);
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

// ========== 大纲时间（剧情大纲时间窗口用，年-月粒度） ==========

/**
 * 解析大纲时间字符串
 * 接受格式: "512-03"（年-月，month 1-12，可 1 位或补零 2 位）
 * @returns MonthTime 对象，无效格式返回 null
 */
export function parseMonthTime(str: string): MonthTime | null {
  const regex = /^(\d+)-(\d{1,2})$/;
  const match = str.match(regex);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) return null;

  return { year, month };
}

/**
 * 格式化大纲时间为字符串
 * "512-03"（month 补零 2 位）
 */
export function formatMonthTime(t: MonthTime): string {
  const pad = String(t.month).padStart(2, '0');
  return `${t.year}-${pad}`;
}

/**
 * 比较两个大纲时间
 * 排序: year → month
 * @returns 负数 a<b，正数 a>b，0 相等
 */
export function compareMonthTime(a: MonthTime, b: MonthTime): number {
  if (a.year !== b.year) return a.year - b.year;
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
  parseMonthTime,
  formatMonthTime,
  compareMonthTime,
  SEASON_NAMES,
  MONTH_NAMES,
  WEEKDAY_NAMES,
} as const;
