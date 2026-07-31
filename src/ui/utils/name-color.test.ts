/**
 * 名字 hash 首字母头像配色工具的单元测试。
 * 覆盖: hashName 确定性/空串/分布, nameColorVar 输出形式/兜底/稳定, initialsOf 边界。
 */
import { describe, it, expect } from 'vitest';
import { hashName, nameColorVar, initialsOf } from './name-color';

describe('hashName', () => {
  it('空串返回 0', () => {
    expect(hashName('')).toBe(0);
  });

  it('同名同结果（确定性）', () => {
    expect(hashName('艾莉雅')).toBe(hashName('艾莉雅'));
    expect(hashName('Alice')).toBe(hashName('Alice'));
  });

  it('不同名分布到不同 hash', () => {
    const names = ['张三', '李四', '王五', '赵六', '艾莉雅', '影刃', 'Alice', 'Bob'];
    const hashes = names.map((n) => hashName(n));
    // 不存在两个相同
    expect(new Set(hashes).size).toBe(hashes.length);
    // 7 取模后仍应有合理分散
    const buckets = new Set(hashes.map((h) => h % 7));
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('返回值为非负整数（无符号）', () => {
    expect(hashName('任意名字')).toBeGreaterThanOrEqual(0);
  });
});

describe('nameColorVar', () => {
  it('始终返回 var(--theme-quality-...) 形式', () => {
    const names = ['张三', '李四', '王五', 'Alice', '影刃', '艾莉雅'];
    for (const n of names) {
      expect(nameColorVar(n)).toMatch(/^var\(--theme-quality-[a-z]+\)$/);
    }
  });

  it('空 name fallback 到 var(--theme-quality-common)', () => {
    expect(nameColorVar('')).toBe('var(--theme-quality-common)');
  });

  it('同名稳定返回同一颜色', () => {
    expect(nameColorVar('艾莉雅')).toBe(nameColorVar('艾莉雅'));
  });

  it('多个不同名的取模 7 分散结果', () => {
    const names = ['张三', '李四', '王五', '赵六', '艾莉雅', '影刃', '塞流斯', '诺斯加德'];
    const colors = new Set(names.map((n) => nameColorVar(n)));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('颜色池仅命中 7 个已知品质变量', () => {
    const valid = new Set([
      'var(--theme-quality-common)',
      'var(--theme-quality-uncommon)',
      'var(--theme-quality-rare)',
      'var(--theme-quality-epic)',
      'var(--theme-quality-legendary)',
      'var(--theme-quality-mythic)',
      'var(--theme-quality-unique)',
    ]);
    const names = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    for (const n of names) {
      expect(valid.has(nameColorVar(n))).toBe(true);
    }
  });
});

describe('initialsOf', () => {
  it('空串返回空串', () => {
    expect(initialsOf('')).toBe('');
  });

  it('undefined 返回空串', () => {
    expect(initialsOf(undefined)).toBe('');
  });

  it('null 返回空串', () => {
    expect(initialsOf(null)).toBe('');
  });

  it('取中文前 2 字', () => {
    expect(initialsOf('艾莉雅')).toBe('艾莉');
    expect(initialsOf('影')).toBe('影');
  });

  it('取英文前 2 字母', () => {
    expect(initialsOf('Alice')).toBe('Al');
    expect(initialsOf('A')).toBe('A');
  });

  it('与 AvatarPanel.slice(0,2) 行为一致', () => {
    const sample = ['艾莉雅', '影刃', 'Alice', '塞流斯', '诺斯加德联盟', '一'];
    for (const s of sample) {
      expect(initialsOf(s)).toBe(s.slice(0, 2));
    }
  });
});
