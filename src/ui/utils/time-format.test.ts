/**
 * formatRel 相对时间格式化的单元测试。
 * 通过注入 `now` 锁定参考时刻，覆盖全部分支。
 */
import { describe, it, expect } from 'vitest';
import { formatRel } from './time-format';

// 固定参考时刻: 2026-07-12 14:30 (本地时间)
const NOW = new Date(2026, 6, 12, 14, 30, 0).getTime();

describe('formatRel 守护', () => {
  it('undefined → 空串', () => {
    expect(formatRel(undefined, NOW)).toBe('');
  });
  it('null → 空串', () => {
    expect(formatRel(null, NOW)).toBe('');
  });
  it('0 → 空串', () => {
    expect(formatRel(0, NOW)).toBe('');
  });
  it('NaN → 空串', () => {
    expect(formatRel(NaN, NOW)).toBe('');
  });
  it('Infinity → 空串', () => {
    expect(formatRel(Infinity, NOW)).toBe('');
  });
  it('-Infinity → 空串', () => {
    expect(formatRel(-Infinity, NOW)).toBe('');
  });
});

describe('formatRel 分支', () => {
  it('diff < 60s → 刚刚', () => {
    expect(formatRel(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatRel(NOW - 59_999, NOW)).toBe('刚刚');
  });

  it('60s ≤ diff < 60min → N分钟前', () => {
    expect(formatRel(NOW - 60_000, NOW)).toBe('1分钟前');
    expect(formatRel(NOW - 5 * 60_000, NOW)).toBe('5分钟前');
    expect(formatRel(NOW - 59 * 60_000, NOW)).toBe('59分钟前');
  });

  it('今天（超过 60min 但同日）→ 今天 HH:MM', () => {
    // 当天 09:05
    const ts = new Date(2026, 6, 12, 9, 5, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('今天 09:05');
    // 当天 00:10（距 now 超过 60min）
    const ts2 = new Date(2026, 6, 12, 0, 10, 0).getTime();
    expect(formatRel(ts2, NOW)).toBe('今天 00:10');
  });

  it('昨天 → 昨天 HH:MM', () => {
    const ts = new Date(2026, 6, 11, 18, 45, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('昨天 18:45');
    const ts2 = new Date(2026, 6, 11, 0, 5, 0).getTime();
    expect(formatRel(ts2, NOW)).toBe('昨天 00:05');
  });

  it('更早（跨月）→ M-D 不补零', () => {
    // 2026-06-14 03:08
    const ts = new Date(2026, 5, 14, 3, 8, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('6-14');
  });

  it('更早（跨年）→ M-D 不补零', () => {
    // 2025-12-31 23:59
    const ts = new Date(2025, 11, 31, 23, 59, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('12-31');
  });

  it('更早（单月单日）→ M-D 不补零（如 3-7）', () => {
    // 2026-03-07 10:00
    const ts = new Date(2026, 2, 7, 10, 0, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('3-7');
  });
});

describe('formatRel 未来时间', () => {
  it('60s 内未来 → 刚刚', () => {
    expect(formatRel(NOW + 30_000, NOW)).toBe('刚刚');
  });

  it('同日未来超过 60min → 今天 HH:MM', () => {
    // 当天 18:35
    const ts = new Date(2026, 6, 12, 18, 35, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('今天 18:35');
  });

  it('未来跨日 → M-D 降级显示（不写"后"）', () => {
    // 次日 10:00
    const ts = new Date(2026, 6, 13, 10, 0, 0).getTime();
    expect(formatRel(ts, NOW)).toBe('7-13');
  });

  it('未来且不输出"后"字', () => {
    const ts = new Date(2026, 11, 25, 8, 0, 0).getTime();
    const out = formatRel(ts, NOW);
    expect(out.includes('后')).toBe(false);
  });
});

describe('formatRel 稳定性', () => {
  it('同一 ts 多次结果一致', () => {
    const ts = new Date(2026, 5, 14, 3, 8, 0).getTime();
    expect(formatRel(ts, NOW)).toBe(formatRel(ts, NOW));
  });
});
