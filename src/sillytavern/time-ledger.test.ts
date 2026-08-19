import { describe, it, expect } from 'vitest';

import { MAX_CATCHUP_PERIODS, expiryDue, periodsDue, periodsDueCapped } from './time-ledger';

describe('periodsDue — 半开区间 (prevDay, nextDay] 的边界语义', () => {
  it('锚点当天不算一次到期', () => {
    expect(periodsDue(12, 30, 12, 12)).toBe(0);
  });

  it('第一个到期点落在 anchor + period，而不是 period 本身', () => {
    // 第 12 天生效、周期 30 天 → 第一次到期是第 42 天。
    expect(periodsDue(12, 30, 12, 41)).toBe(0);
    expect(periodsDue(12, 30, 12, 42)).toBe(1);
  });

  it('next 恰好压在边界上必须计数（右端闭）', () => {
    expect(periodsDue(0, 30, 29, 30)).toBe(1);
    expect(periodsDue(12, 30, 41, 42)).toBe(1);
  });

  it('prev 恰好压在边界上不得重复计数（左端开）', () => {
    // 上一次提交停在第 42 天并已结算过它；这一轮只该结算第 72 天那一次。
    expect(periodsDue(12, 30, 42, 72)).toBe(1);
    expect(periodsDue(12, 30, 42, 71)).toBe(0);
    expect(periodsDue(0, 30, 30, 30)).toBe(0);
  });

  it('连续区间无缝拼接，不漏也不重（30/60/90 三次各算一次）', () => {
    expect(periodsDue(0, 30, 0, 30)).toBe(1);
    expect(periodsDue(0, 30, 30, 60)).toBe(1);
    expect(periodsDue(0, 30, 60, 90)).toBe(1);
  });

  it('时间没有前进时返回 0', () => {
    expect(periodsDue(0, 30, 55, 55)).toBe(0);
  });
});

describe('periodsDue — 多期补结算', () => {
  it('一次跨 90 天、周期 30 天 = 3 期', () => {
    expect(periodsDue(0, 30, 0, 90)).toBe(3);
  });

  it('带锚偏移的多期补结算', () => {
    // 锚 12 天，到期点 42 / 72 / 102；prev=20 → next=105 跨过三个。
    expect(periodsDue(12, 30, 20, 105)).toBe(3);
  });

  it('周期为 1 天时逐天到期', () => {
    expect(periodsDue(0, 1, 0, 7)).toBe(7);
  });

  it('跨越多期但 prev 已在边界上时不多算', () => {
    expect(periodsDue(0, 30, 30, 120)).toBe(3);
  });
});

describe('periodsDue — 锚在未来', () => {
  it('整段区间都在锚之前 → 0', () => {
    expect(periodsDue(100, 30, 0, 50)).toBe(0);
  });

  it('区间跨过锚点但还没到第一个到期点 → 0（锚本身不是到期点）', () => {
    expect(periodsDue(100, 30, 50, 129)).toBe(0);
  });

  it('区间跨过锚点并越过第一个到期点 → 1', () => {
    expect(periodsDue(100, 30, 50, 130)).toBe(1);
  });
});

describe('periodsDue — 护栏', () => {
  it('周期为 0 或负数一律返回 0', () => {
    expect(periodsDue(0, 0, 0, 999)).toBe(0);
    expect(periodsDue(0, -30, 0, 999)).toBe(0);
  });

  it('时间倒流返回 0，绝不倒扣出负期数', () => {
    expect(periodsDue(0, 30, 90, 0)).toBe(0);
    expect(periodsDue(0, 30, 90, 89)).toBe(0);
  });

  it('非有限数输入一律返回 0', () => {
    expect(periodsDue(Number.NaN, 30, 0, 90)).toBe(0);
    expect(periodsDue(0, Number.NaN, 0, 90)).toBe(0);
    expect(periodsDue(0, 30, Number.NaN, 90)).toBe(0);
    expect(periodsDue(0, 30, 0, Number.NaN)).toBe(0);
    expect(periodsDue(0, 30, 0, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('返回值恒非负', () => {
    for (const next of [-100, -1, 0, 1, 29, 30, 31, 1000]) {
      expect(periodsDue(12, 30, 0, next)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('periodsDue — 确定性', () => {
  it('同参数重放逐字一致（无时钟、无随机）', () => {
    const first = periodsDue(12, 30, 20, 4000);
    for (let i = 0; i < 5; i++) {
      expect(periodsDue(12, 30, 20, 4000)).toBe(first);
    }
  });
});

describe('periodsDueCapped — 失控护栏', () => {
  it('未超限时与 periodsDue 完全一致', () => {
    expect(periodsDueCapped(0, 30, 0, 90)).toBe(3);
    expect(periodsDueCapped(12, 30, 42, 72)).toBe(1);
    expect(periodsDueCapped(0, 30, 90, 0)).toBe(0);
  });

  it('恰好等于上限时不截断', () => {
    const exact = MAX_CATCHUP_PERIODS * 30;
    expect(periodsDue(0, 30, 0, exact)).toBe(MAX_CATCHUP_PERIODS);
    expect(periodsDueCapped(0, 30, 0, exact)).toBe(MAX_CATCHUP_PERIODS);
  });

  it('荒谬的 delta_time 被夹到上限', () => {
    const absurd = 30 * 40000;
    expect(periodsDue(0, 30, 0, absurd)).toBe(40000);
    expect(periodsDueCapped(0, 30, 0, absurd)).toBe(MAX_CATCHUP_PERIODS);
  });

  it('上限是个正整数', () => {
    expect(Number.isInteger(MAX_CATCHUP_PERIODS)).toBe(true);
    expect(MAX_CATCHUP_PERIODS).toBeGreaterThan(0);
  });
});

describe('expiryDue', () => {
  it('到期日当天即触发', () => {
    expect(expiryDue(10, 5, 14)).toBe(false);
    expect(expiryDue(10, 5, 15)).toBe(true);
  });

  it('过了到期日仍然为 true（补结算不会漏掉它）', () => {
    expect(expiryDue(10, 5, 900)).toBe(true);
  });

  it('durationDays === 0 表示当天即到期', () => {
    expect(expiryDue(10, 0, 9)).toBe(false);
    expect(expiryDue(10, 0, 10)).toBe(true);
  });

  it('durationDays === -1 是永久，永不到期', () => {
    expect(expiryDue(10, -1, 10)).toBe(false);
    expect(expiryDue(10, -1, 999999)).toBe(false);
    expect(expiryDue(0, -1, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('其余负数持续时间同样永不到期（宁可留着也不误删）', () => {
    expect(expiryDue(10, -2, 999)).toBe(false);
    expect(expiryDue(10, -30, 999)).toBe(false);
  });

  it('锚在未来时尚未到期', () => {
    expect(expiryDue(100, 5, 50)).toBe(false);
  });

  it('非有限数输入一律返回 false', () => {
    expect(expiryDue(Number.NaN, 5, 100)).toBe(false);
    expect(expiryDue(10, Number.NaN, 100)).toBe(false);
    expect(expiryDue(10, 5, Number.NaN)).toBe(false);
  });
});
