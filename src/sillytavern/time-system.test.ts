/**
 * time-system.test.ts — 游戏时间系统单元测试
 *
 * Vitest, pure functions, node environment.
 */

import { describe, it, expect } from 'vitest';
import {
  GameTime,
  createDefaultTime,
  parseGameTime,
  formatGameTime,
  formatGameTimeShort,
  advanceTime,
  advanceHours,
  advanceDays,
  toTotalMinutes,
  isBefore,
  isAfter,
  diffMinutes,
  diffDays,
  isDaytime,
  getTimeOfDay,
  getSeason,
  $time,
  MONTH_NAMES,
  WEEKDAY_NAMES,
} from './time-system';

// ========== createDefaultTime ==========

describe('createDefaultTime', () => {
  it('returns correct defaults with default era', () => {
    const t = createDefaultTime();
    expect(t.era).toBe('复兴纪元');
    expect(t.year).toBe(1);
    expect(t.month).toBe(1);
    expect(t.day).toBe(1);
    expect(t.weekday).toBe(1);
    expect(t.hour).toBe(8);
    expect(t.minute).toBe(0);
  });

  it('accepts a custom era name', () => {
    const t = createDefaultTime('混沌纪元');
    expect(t.era).toBe('混沌纪元');
    expect(t.year).toBe(1);
  });

  it('produces immutable-seeming copies (structurally independent)', () => {
    const a = createDefaultTime();
    const b = createDefaultTime();
    a.year = 99;
    expect(b.year).toBe(1);
  });
});

// ========== parseGameTime ==========

describe('parseGameTime', () => {
  it('parses a valid time string correctly', () => {
    const t = parseGameTime('复兴纪元0001年-05月-24日-周三-15:30');
    expect(t).not.toBeNull();
    expect(t!.era).toBe('复兴纪元');
    expect(t!.year).toBe(1);
    expect(t!.month).toBe(5);
    expect(t!.day).toBe(24);
    expect(t!.weekday).toBe(3); // 周三
    expect(t!.hour).toBe(15);
    expect(t!.minute).toBe(30);
  });

  it('returns null for an invalid string', () => {
    expect(parseGameTime('not a valid time')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGameTime('')).toBeNull();
  });

  it('parses large year values', () => {
    const t = parseGameTime('混沌纪元1500年-12月-30日-周六-23:59');
    expect(t).not.toBeNull();
    expect(t!.year).toBe(1500);
    expect(t!.month).toBe(12);
    expect(t!.day).toBe(30);
    expect(t!.weekday).toBe(6);
    expect(t!.hour).toBe(23);
    expect(t!.minute).toBe(59);
  });

  it('parses single-digit hour minute correctly', () => {
    const t = parseGameTime('复兴纪元0001年-01月-01日-周日-08:05');
    expect(t).not.toBeNull();
    expect(t!.hour).toBe(8);
    expect(t!.minute).toBe(5);
  });

  it('handles multi-character era names', () => {
    const t = parseGameTime('上古神代0001年-01月-01日-周日-00:00');
    expect(t).not.toBeNull();
    expect(t!.era).toBe('上古神代');
  });
});

// ========== formatGameTime ==========

describe('formatGameTime', () => {
  it('roundtrips through parseGameTime', () => {
    const original = createDefaultTime();
    original.year = 42;
    original.month = 7;
    original.day = 15;
    original.weekday = 5; // 周五
    original.hour = 14;
    original.minute = 30;

    const formatted = formatGameTime(original);
    const parsed = parseGameTime(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.era).toBe(original.era);
    expect(parsed!.year).toBe(original.year);
    expect(parsed!.month).toBe(original.month);
    expect(parsed!.day).toBe(original.day);
    expect(parsed!.hour).toBe(original.hour);
    expect(parsed!.minute).toBe(original.minute);
  });

  it('pads year to 4 digits', () => {
    const t = createDefaultTime();
    t.year = 1;
    const formatted = formatGameTime(t);
    expect(formatted).toContain('复兴纪元0001年');
  });

  it('includes weekday name in output', () => {
    const t = createDefaultTime();
    t.weekday = 4; // 周三 (WEEKDAY_NAMES[3])
    const formatted = formatGameTime(t);
    expect(formatted).toContain('周三');
  });

  it('pads single-digit month/day/hour/minute to two digits', () => {
    const t = createDefaultTime();
    t.month = 3;
    t.day = 5;
    t.hour = 8;
    t.minute = 7;
    const formatted = formatGameTime(t);
    expect(formatted).toContain('03月-05日');
    expect(formatted).toContain('08:07');
  });
});

// ========== formatGameTimeShort ==========

describe('formatGameTimeShort', () => {
  it('produces short format without era or weekday', () => {
    const t = createDefaultTime();
    t.year = 42;
    t.month = 3;
    t.day = 15;
    t.hour = 9;
    t.minute = 5;
    const short = formatGameTimeShort(t);
    expect(short).toBe('42-03-15 09:05');
  });
});

// ========== advanceTime ==========

describe('advanceTime', () => {
  const baseTime: GameTime = createDefaultTime(); // y=1,m=1,d=1,wd=1,h=8,m=0

  it('advances +30 minutes', () => {
    const t = advanceTime(baseTime, 30);
    expect(t.hour).toBe(8);
    expect(t.minute).toBe(30);
    expect(t.day).toBe(1);
  });

  it('advances +2 hours', () => {
    const t = advanceTime(baseTime, 120);
    expect(t.hour).toBe(10);
    expect(t.minute).toBe(0);
  });

  it('advances +24 hours (crosses day boundary)', () => {
    const t = advanceTime(baseTime, 1440);
    expect(t.day).toBe(2);
    expect(t.hour).toBe(8);
    expect(t.minute).toBe(0);
    // weekday should advance
    expect(t.weekday).toBe(2);
  });

  it('advances +30 days (crosses month boundary)', () => {
    const t = advanceTime(baseTime, 30 * 24 * 60);
    expect(t.month).toBe(2);
    expect(t.day).toBe(1);
    expect(t.hour).toBe(8);
    expect(t.minute).toBe(0);
  });

  it('advances +12 months (crosses year boundary)', () => {
    const t = advanceTime(baseTime, 12 * 30 * 24 * 60);
    expect(t.year).toBe(2);
    expect(t.month).toBe(1);
    expect(t.day).toBe(1);
    expect(t.hour).toBe(8);
    expect(t.minute).toBe(0);
  });

  it('handles negative minutes (rewind within same hour)', () => {
    const t = advanceTime(baseTime, -30);
    expect(t.hour).toBe(7);
    expect(t.minute).toBe(30);
    expect(t.day).toBe(1);
    expect(t.year).toBe(1);
  });

  it('handles negative hours (rewind across midnight)', () => {
    // -10h from y1/m1/d1 8:00 — wraps day/month to prev year, clamped at year=1
    const t = advanceTime(baseTime, -600);
    expect(t.hour).toBe(22);
    expect(t.minute).toBe(0);
    expect(t.day).toBe(30); // wraps to day 30 of previous month
    expect(t.month).toBe(12); // wraps to month 12
    expect(t.year).toBe(1); // clamped to min 1 by advanceTime
  });

  it('preserves era unchanged', () => {
    const customEra = createDefaultTime('混沌纪元');
    const t = advanceTime(customEra, 9999999);
    expect(t.era).toBe('混沌纪元');
  });

  it('clamps year to minimum 1', () => {
    const t = advanceTime(baseTime, -9999999);
    expect(t.year).toBeGreaterThanOrEqual(1);
  });

  it('clamps values within valid ranges on large advance', () => {
    const t = advanceTime(baseTime, 9999999);
    expect(t.month).toBeGreaterThanOrEqual(1);
    expect(t.month).toBeLessThanOrEqual(12);
    expect(t.day).toBeGreaterThanOrEqual(1);
    expect(t.day).toBeLessThanOrEqual(30);
    expect(t.hour).toBeGreaterThanOrEqual(0);
    expect(t.hour).toBeLessThanOrEqual(23);
    expect(t.minute).toBeGreaterThanOrEqual(0);
    expect(t.minute).toBeLessThanOrEqual(59);
  });
});

// ========== advanceHours / advanceDays equivalence ==========

describe('advanceHours and advanceDays', () => {
  const baseTime = createDefaultTime();

  it('advanceHours(N) equals advanceTime(N * 60)', () => {
    const t1 = advanceHours(baseTime, 5);
    const t2 = advanceTime(baseTime, 5 * 60);
    expect(t1).toEqual(t2);
  });

  it('advanceDays(N) equals advanceTime(N * 1440)', () => {
    const t1 = advanceDays(baseTime, 3);
    const t2 = advanceTime(baseTime, 3 * 24 * 60);
    expect(t1).toEqual(t2);
  });
});

// ========== toTotalMinutes ==========

describe('toTotalMinutes', () => {
  it('is monotonic with advanceTime', () => {
    const t0 = createDefaultTime();
    const t1 = advanceTime(t0, 1);
    const t2 = advanceTime(t0, 100);
    const t3 = advanceTime(t0, 9999);
    expect(toTotalMinutes(t0)).toBeLessThan(toTotalMinutes(t1));
    expect(toTotalMinutes(t1)).toBeLessThan(toTotalMinutes(t2));
    expect(toTotalMinutes(t2)).toBeLessThan(toTotalMinutes(t3));
  });

  it('returns 0 for epoch start (year=0 offset)', () => {
    const t: GameTime = { era: '零', year: 0, month: 1, day: 1, weekday: 1, hour: 0, minute: 0 };
    expect(toTotalMinutes(t)).toBe(0);
  });

  it('returns expected value for known time', () => {
    // year=1 contributes 1*12*30*24*60 = 518400, plus hour:minute = 1:1 → 61
    const t: GameTime = { era: 'test', year: 1, month: 1, day: 1, weekday: 1, hour: 1, minute: 1 };
    expect(toTotalMinutes(t)).toBe(518400 + 61);
  });
});

// ========== isBefore / isAfter ==========

describe('isBefore and isAfter', () => {
  const a = createDefaultTime();
  const b = advanceTime(a, 1);

  it('isBefore returns true when a < b', () => {
    expect(isBefore(a, b)).toBe(true);
  });

  it('isBefore returns false when b > a', () => {
    expect(isBefore(b, a)).toBe(false);
  });

  it('isAfter returns true when b > a', () => {
    expect(isAfter(b, a)).toBe(true);
  });

  it('isAfter returns false when a < b', () => {
    expect(isAfter(a, b)).toBe(false);
  });

  it('isBefore returns false for equal times', () => {
    expect(isBefore(a, a)).toBe(false);
  });

  it('isAfter returns false for equal times', () => {
    expect(isAfter(a, a)).toBe(false);
  });
});

// ========== diffMinutes / diffDays ==========

describe('diffMinutes and diffDays', () => {
  const a = createDefaultTime();
  const b = advanceTime(a, 90); // +90 minutes
  const c = advanceTime(a, -45); // -45 minutes

  it('diffMinutes positive', () => {
    expect(diffMinutes(b, a)).toBe(90);
  });

  it('diffMinutes negative', () => {
    expect(diffMinutes(c, a)).toBe(-45);
  });

  it('diffMinutes zero', () => {
    expect(diffMinutes(a, a)).toBe(0);
  });

  it('diffDays positive (single day boundary)', () => {
    const nextDay = advanceDays(a, 1);
    expect(diffDays(nextDay, a)).toBe(1);
  });

  it('diffDays negative', () => {
    // Use a time far from year boundary so negative advance works without clamping
    const midYear: GameTime = {
      era: '复兴纪元', year: 5, month: 6, day: 15, weekday: 3, hour: 12, minute: 0,
    };
    const prevDay = advanceDays(midYear, -1);
    expect(diffDays(prevDay, midYear)).toBe(-1);
  });

  it('diffDays zero', () => {
    expect(diffDays(a, a)).toBe(0);
  });

  it('diffDays truncates partial days', () => {
    const later = advanceTime(a, 25 * 60); // +25h
    expect(diffDays(later, a)).toBe(1); // 1 full day, not 2
  });
});

// ========== isDaytime ==========

describe('isDaytime', () => {
  const baseTime = createDefaultTime();

  it('returns true at 6:00 (start of daytime)', () => {
    const t = advanceTime(baseTime, -120); // 8:00 - 2h = 6:00
    expect(t.hour).toBe(6);
    expect(isDaytime(t)).toBe(true);
  });

  it('returns true at 12:00 (middle of daytime)', () => {
    const t = advanceTime(baseTime, 240); // 8:00 + 4h = 12:00
    expect(isDaytime(t)).toBe(true);
  });

  it('returns false at 18:00 (end boundary, exclusive)', () => {
    const t = advanceTime(baseTime, 600); // 8:00 + 10h = 18:00
    expect(t.hour).toBe(18);
    expect(isDaytime(t)).toBe(false);
  });

  it('returns false at 5:59', () => {
    const t: GameTime = { ...baseTime, hour: 5, minute: 59 };
    expect(isDaytime(t)).toBe(false);
  });

  it('returns false at 0:00 (midnight)', () => {
    const t: GameTime = { ...baseTime, hour: 0, minute: 0 };
    expect(isDaytime(t)).toBe(false);
  });
});

// ========== getTimeOfDay ==========

describe('getTimeOfDay', () => {
  const baseTime = createDefaultTime();

  it('returns "凌晨" before 6:00', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 0 })).toBe('凌晨');
    expect(getTimeOfDay({ ...baseTime, hour: 3 })).toBe('凌晨');
    expect(getTimeOfDay({ ...baseTime, hour: 5 })).toBe('凌晨');
  });

  it('returns "早晨" from 6:00 to 8:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 6 })).toBe('早晨');
    expect(getTimeOfDay({ ...baseTime, hour: 7 })).toBe('早晨');
    expect(getTimeOfDay({ ...baseTime, hour: 8 })).toBe('早晨');
  });

  it('returns "上午" from 9:00 to 11:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 9 })).toBe('上午');
    expect(getTimeOfDay({ ...baseTime, hour: 10 })).toBe('上午');
    expect(getTimeOfDay({ ...baseTime, hour: 11 })).toBe('上午');
  });

  it('returns "中午" from 12:00 to 13:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 12 })).toBe('中午');
    expect(getTimeOfDay({ ...baseTime, hour: 13 })).toBe('中午');
  });

  it('returns "下午" from 14:00 to 17:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 14 })).toBe('下午');
    expect(getTimeOfDay({ ...baseTime, hour: 17 })).toBe('下午');
  });

  it('returns "傍晚" from 18:00 to 20:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 18 })).toBe('傍晚');
    expect(getTimeOfDay({ ...baseTime, hour: 20 })).toBe('傍晚');
  });

  it('returns "深夜" from 21:00 to 23:59', () => {
    expect(getTimeOfDay({ ...baseTime, hour: 21 })).toBe('深夜');
    expect(getTimeOfDay({ ...baseTime, hour: 23 })).toBe('深夜');
  });
});

// ========== getSeason ==========

describe('getSeason', () => {
  it('returns "春季" for months 1-3', () => {
    expect(getSeason(1)).toBe('春季');
    expect(getSeason(2)).toBe('春季');
    expect(getSeason(3)).toBe('春季');
  });

  it('returns "夏季" for months 4-6', () => {
    expect(getSeason(4)).toBe('夏季');
    expect(getSeason(5)).toBe('夏季');
    expect(getSeason(6)).toBe('夏季');
  });

  it('returns "秋季" for months 7-9', () => {
    expect(getSeason(7)).toBe('秋季');
    expect(getSeason(8)).toBe('秋季');
    expect(getSeason(9)).toBe('秋季');
  });

  it('returns "冬季" for months 10-12', () => {
    expect(getSeason(10)).toBe('冬季');
    expect(getSeason(11)).toBe('冬季');
    expect(getSeason(12)).toBe('冬季');
  });
});

// ========== MONTH_NAMES / WEEKDAY_NAMES ==========

describe('MONTH_NAMES and WEEKDAY_NAMES', () => {
  it('MONTH_NAMES has 12 entries', () => {
    expect(MONTH_NAMES).toHaveLength(12);
  });

  it('WEEKDAY_NAMES has 7 entries', () => {
    expect(WEEKDAY_NAMES).toHaveLength(7);
  });

  it('MONTH_NAMES start with 一月 and end with 十二月', () => {
    expect(MONTH_NAMES[0]).toBe('一月');
    expect(MONTH_NAMES[11]).toBe('十二月');
  });

  it('WEEKDAY_NAMES starts with 周日', () => {
    expect(WEEKDAY_NAMES[0]).toBe('周日');
  });
});

// ========== $time namespace ==========

describe('$time namespace', () => {
  it('exposes all expected functions', () => {
    expect($time.createDefaultTime).toBe(createDefaultTime);
    expect($time.parseGameTime).toBe(parseGameTime);
    expect($time.formatGameTime).toBe(formatGameTime);
    expect($time.formatGameTimeShort).toBe(formatGameTimeShort);
    expect($time.advanceTime).toBe(advanceTime);
    expect($time.advanceHours).toBe(advanceHours);
    expect($time.advanceDays).toBe(advanceDays);
    expect($time.isBefore).toBe(isBefore);
    expect($time.isAfter).toBe(isAfter);
    expect($time.diffMinutes).toBe(diffMinutes);
    expect($time.diffDays).toBe(diffDays);
    expect($time.isDaytime).toBe(isDaytime);
    expect($time.getTimeOfDay).toBe(getTimeOfDay);
    expect($time.getSeason).toBe(getSeason);
    expect($time.MONTH_NAMES).toBe(MONTH_NAMES);
    expect($time.WEEKDAY_NAMES).toBe(WEEKDAY_NAMES);
  });

  it('$time.createDefaultTime works the same as direct call', () => {
    const t1 = $time.createDefaultTime('自定义纪元');
    const t2 = createDefaultTime('自定义纪元');
    expect(t1).toEqual(t2);
  });

  it('$time.advanceTime works the same as direct call', () => {
    const base = createDefaultTime();
    expect($time.advanceTime(base, 60)).toEqual(advanceTime(base, 60));
  });
});
