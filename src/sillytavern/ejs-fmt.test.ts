/**
 * ejs-fmt.ts 测试 —— `fmt` 格式化命名空间（能力面 §3.9 / §3.14）
 *
 * 重点在两处：
 * - `fmt.yaml` 是真机语料 5 个条目的刚需（`YAML.stringify(obj, {blockQuote:'literal'})`）
 * - `fmt.compareName` / `fmt.num` 是 §3.14 C 档（`localeCompare` / `toLocaleString`）的替代路径，
 *   必须**跨后端一致**，所以不依赖任何 locale 实现
 */

import { describe, it, expect } from 'vitest';
import { ejsFmt } from './ejs-fmt';

describe('fmt.yaml', () => {
  it('嵌套对象按缩进展开', () => {
    expect(ejsFmt.yaml({ 事件: { 月历: { 临时: {} } } })).toBe('事件:\n  月历:\n    临时: {}');
  });

  it('数组用 - 列项', () => {
    expect(ejsFmt.yaml({ 列表: ['甲', '乙'] })).toBe('列表:\n  - 甲\n  - 乙');
  });

  it('多行字符串用 |- 块标量（blockQuote 默认开）', () => {
    const out = ejsFmt.yaml({ 正文: '第一行\n第二行' });
    expect(out).toContain('|-');
    expect(out).toContain('第一行');
    expect(out).toContain('第二行');
  });

  it('blockQuote: false → 多行走 JSON 转义', () => {
    expect(ejsFmt.yaml({ a: 'x\ny' }, { blockQuote: false })).toBe('a: "x\\ny"');
  });

  it('像数字/布尔的字符串加引号（防往返变类型）', () => {
    expect(ejsFmt.yaml({ a: '123' })).toBe('a: "123"');
    expect(ejsFmt.yaml({ a: 'true' })).toBe('a: "true"');
    expect(ejsFmt.yaml({ a: 123 })).toBe('a: 123');
    expect(ejsFmt.yaml({ a: true })).toBe('a: true');
  });

  it('含特殊字符的字符串加引号', () => {
    expect(ejsFmt.yaml({ a: 'x: y' })).toBe('a: "x: y"');
    expect(ejsFmt.yaml({ a: ' 前后有空格 ' })).toContain('"');
  });

  it('null / undefined / 空容器', () => {
    expect(ejsFmt.yaml({ a: null })).toBe('a: null');
    expect(ejsFmt.yaml({ a: [] })).toBe('a: []');
    expect(ejsFmt.yaml({ a: {} })).toBe('a: {}');
  });

  it('环 / 超深结构不抛（P3：能力永不抛）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => ejsFmt.yaml(cyclic)).not.toThrow();
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i++) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(ejsFmt.yaml(root)).toContain('层级过深');
  });
});

describe('fmt.json / table / list', () => {
  it('json 缩进夹紧在 0-8', () => {
    expect(ejsFmt.json({ a: 1 })).toBe('{"a":1}');
    expect(ejsFmt.json({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    expect(() => ejsFmt.json({ a: 1 }, 999)).not.toThrow();
  });

  it('json 遇环不抛，返回空串', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(ejsFmt.json(cyclic)).toBe('');
  });

  it('table 生成 Markdown；列缺省取键并集；竖线被转义', () => {
    const out = ejsFmt.table([
      { 名字: '铁剑', 数量: 1 },
      { 名字: 'a|b', 品质: '稀有' },
    ]);
    expect(out.split('\n')[0]).toBe('| 名字 | 数量 | 品质 |');
    expect(out).toContain('| --- | --- | --- |');
    expect(out).toContain('a\\|b');
  });

  it('table 指定列 / 空表 / 非数组', () => {
    expect(ejsFmt.table([{ a: 1, b: 2 }], ['a'])).toContain('| a |');
    expect(ejsFmt.table([])).toBe('');
    expect(ejsFmt.table(null as unknown as unknown[])).toBe('');
  });

  it('list 带项目符号', () => {
    expect(ejsFmt.list(['甲', '乙'])).toBe('- 甲\n- 乙');
    expect(ejsFmt.list(['甲'], '*')).toBe('* 甲');
    expect(ejsFmt.list(null as unknown as unknown[])).toBe('');
  });
});

describe('fmt.num / pct / bar / pad / truncate', () => {
  it('num 千分位（不走 toLocaleString —— §3.14 C 档）', () => {
    expect(ejsFmt.num(1234567)).toBe('1,234,567');
    expect(ejsFmt.num(-1234.5, 2)).toBe('-1,234.50');
    expect(ejsFmt.num(999)).toBe('999');
    expect(ejsFmt.num('不是数')).toBe('0');
  });

  it('pct', () => {
    expect(ejsFmt.pct(0.735)).toBe('73.5%');
    expect(ejsFmt.pct(0.5, 0)).toBe('50%');
    expect(ejsFmt.pct(NaN)).toBe('0%');
  });

  it('bar 比例条；max<=0 与非数走全空', () => {
    expect(ejsFmt.bar(5, 10, 10)).toBe('█████░░░░░ 50%');
    expect(ejsFmt.bar(20, 10, 4)).toBe('████ 100%');
    expect(ejsFmt.bar(1, 0)).toContain('0%');
  });

  it('pad 三种对齐', () => {
    expect(ejsFmt.pad('ab', 5)).toBe('ab   ');
    expect(ejsFmt.pad('ab', 5, 'right')).toBe('   ab');
    expect(ejsFmt.pad('ab', 6, 'center')).toBe('  ab  ');
    expect(ejsFmt.pad('abcdef', 3)).toBe('abcdef');
  });

  it('truncate 含省略号在预算内', () => {
    expect(ejsFmt.truncate('abcdefg', 4)).toBe('abc…');
    expect(ejsFmt.truncate('abc', 10)).toBe('abc');
    expect(ejsFmt.truncate('abcdefg', 4, '...')).toBe('a...');
  });
});

describe('fmt.compareName / sortNames（§3.14 C 档替代）', () => {
  it('数字段按数值比：第2章 在 第10章 之前', () => {
    expect(ejsFmt.sortNames(['第10章', '第2章', '第1章'])).toEqual(['第1章', '第2章', '第10章']);
  });

  it('确定、可传递、与 locale 无关', () => {
    expect(ejsFmt.compareName('甲', '甲')).toBe(0);
    expect(ejsFmt.compareName('a', 'b')).toBeLessThan(0);
    expect(ejsFmt.compareName('b', 'a')).toBeGreaterThan(0);
    // 同一输入多次调用必须同结果（跨后端一致性的最低要求）
    const once = ejsFmt.sortNames(['乙', '甲', '丙']);
    expect(ejsFmt.sortNames(['乙', '甲', '丙'])).toEqual(once);
  });

  it('null / undefined / 非数组不抛', () => {
    expect(ejsFmt.compareName(null, undefined)).toBe(0);
    expect(ejsFmt.sortNames(null as unknown as unknown[])).toEqual([]);
  });
});

describe('输出上限', () => {
  it('超长输出被截断并标注（提示词预算是硬资源）', () => {
    const huge = Array.from({ length: 20000 }, (_, i) => `第${i}项`);
    const out = ejsFmt.list(huge);
    expect(out.length).toBeLessThan(70 * 1024);
    expect(out).toContain('已截断');
  });
});
