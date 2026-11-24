/**
 * status-view.ts —— 状态效果剩余时长展示（durationText 优先，状态树协议 §5.7）纯函数测试。
 */
import { describe, it, expect } from 'vitest';
import {
  durationTextOf,
  statusChipDuration,
  statusDurationLabel,
} from '../../../src/ui/lib/status-view';

describe('statusDurationLabel', () => {
  it('有 durationText 时优先显示它，不再显示成「永久」', () => {
    expect(statusDurationLabel({ remainingTime: null, durationText: '直到离开城镇' })).toBe(
      '直到离开城镇',
    );
    expect(statusDurationLabel({ remainingTime: null, durationText: '月圆之夜前' }, '长期')).toBe(
      '月圆之夜前',
    );
  });
  it('无文本时走原来的数值格式化', () => {
    expect(statusDurationLabel({ remainingTime: null })).toBe('永久');
    expect(statusDurationLabel({ remainingTime: 3, timeUnit: '小时' })).toBe('3小时');
    expect(statusDurationLabel({ remainingTime: 999, timeUnit: '回合' })).toBe('999回合');
    expect(statusDurationLabel({ remainingTime: 999, timeUnit: '回合' }, '长期')).toBe('长期');
  });
  it('遗留行 remainingTime 整键缺席读作「永久」，不印「undefined」', () => {
    expect(statusDurationLabel({ timeUnit: '小时' })).toBe('永久');
  });
  it('空白 durationText 视为没有', () => {
    expect(durationTextOf({ durationText: '   ' })).toBeNull();
    expect(statusDurationLabel({ remainingTime: 2, timeUnit: '天', durationText: ' ' })).toBe(
      '2天',
    );
  });
});

describe('statusChipDuration', () => {
  it('≥999 的约定值不显示；文本与普通数值照常显示', () => {
    expect(statusChipDuration({ remainingTime: 999, timeUnit: '小时' })).toBeNull();
    expect(statusChipDuration({ remainingTime: 5, timeUnit: '分钟' })).toBe('5分钟');
    expect(statusChipDuration({ remainingTime: null })).toBe('永久');
    expect(statusChipDuration({ remainingTime: null, durationText: '直至解除契约' })).toBe(
      '直至解除契约',
    );
  });
});
