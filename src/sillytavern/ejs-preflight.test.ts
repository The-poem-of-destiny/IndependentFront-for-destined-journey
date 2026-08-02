/**
 * ejs-preflight.ts 测试 —— 装前检视（能力面 §10 / 切片 T8）
 *
 * 预检的价值全在**准确度**：漏报让创作者装上才发现，误报让他们学会忽略提示。
 * 故这里既测「该报的报了」，也测「不该报的没报」。
 */

import { describe, it, expect } from 'vitest';
import { preflightEntry, preflightEntries, summarizePreflight } from './ejs-preflight';

const codesOf = (content: string) => preflightEntry(content).issues.map((i) => i.code);
const symbolsOf = (content: string) =>
  preflightEntry(content)
    .issues.map((i) => i.symbol)
    .filter(Boolean);

describe('语法', () => {
  it('正常条目零问题', () => {
    const r = preflightEntry('<%_ if (stats.主角.等级 >= 10) { _%>达标<%_ } _%>');
    expect(r.compiles).toBe(true);
    expect(r.hasBlocking).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('语法错误 → error 级，并说明后果', () => {
    const r = preflightEntry('<% if ( %>');
    expect(r.compiles).toBe(false);
    expect(r.hasBlocking).toBe(true);
    expect(r.issues[0].code).toBe('syntax-error');
    expect(r.issues[0].hint).toContain('原文注入');
  });

  it('await 被识别（生产走异步预渲染，不算问题）', () => {
    const r = preflightEntry('<% const x = await lore.get("a") %>');
    expect(r.isAsync).toBe(true);
    expect(r.hasBlocking).toBe(false);
  });
});

describe('代码位内嵌宏', () => {
  it('{{roll}} / {{random}} 合法，不报', () => {
    expect(codesOf('<%_ if ({{roll 1d100}} >= 50) { _%>命中<%_ } _%>')).not.toContain(
      'macro-in-code',
    );
    expect(codesOf('<%= {{random::A,B}} %>')).not.toContain('macro-in-code');
  });

  it('其余宏嵌在代码位 → error 并给出改法', () => {
    const r = preflightEntry('<% const x = {{getvar::键}} %>');
    expect(r.issues.some((i) => i.code === 'macro-in-code')).toBe(true);
    expect(r.issues.find((i) => i.code === 'macro-in-code')?.hint).toContain('正文位置');
  });

  it('正文位置的宏不报（那是它们该待的地方）', () => {
    expect(codesOf('玩家 {{user}} 掷了 {{roll 1d6}} 点')).toEqual([]);
  });
});

describe('未知符号', () => {
  it('能力面里的 12 个顶层符号不报', () => {
    const code =
      '<% stats; vars; local.keys(); char.all(); world.回合; quest.all(); lore.list("a"); chat.text(); fmt.num(1); rng.float(); ui.log("x"); engine.version; print("y"); _.size([]) %>';
    expect(codesOf(code)).toEqual([]);
  });

  it('未知符号 → warning，说明会回退', () => {
    const r = preflightEntry('<% 完全不存在的东西() %>');
    const issue = r.issues.find((i) => i.code === 'unknown-symbol');
    expect(issue?.symbol).toBe('完全不存在的东西');
    expect(issue?.hint).toContain('ReferenceError');
  });

  it('本地声明不误报（const/let/function/形参/catch/for）', () => {
    const code = [
      '<%',
      'const a = 1; let b = 2; var c = 3;',
      'function f(p1, p2) { return p1 + p2; }',
      'const g = (x) => x * 2;',
      'try { f(a, b); } catch (err) { g(err); }',
      'for (const item of [1,2]) { print(item + c); }',
      '%>',
    ].join('\n');
    expect(codesOf(code)).toEqual([]);
  });

  it('成员名不误报（`obj.foo` 里的 foo 不是自由变量）', () => {
    expect(codesOf('<% const o = { 甲: 1 }; print(o.甲); print(stats.主角.生命值) %>')).toEqual([]);
  });

  it('字符串里的词不误报', () => {
    expect(codesOf('<% print("这里有 一个未知符号 但它在字符串里") %>')).toEqual([]);
  });

  it('别名层 → info 级（能用，但建议改）', () => {
    const r = preflightEntry('<%= getMessageVar("stat_data.主角.等级") %>');
    const issue = r.issues.find((i) => i.code === 'deprecated-alias');
    expect(issue?.level).toBe('info');
    expect(r.hasBlocking).toBe(false);
  });
});

describe('跨后端不一致（§3.14 C 档）', () => {
  it('Intl / localeCompare / toLocaleString / structuredClone / 命名捕获组', () => {
    expect(symbolsOf('<% new Intl.NumberFormat() %>')).toContain('Intl');
    expect(symbolsOf('<% "a".localeCompare("b") %>')).toContain('localeCompare');
    expect(symbolsOf('<% (1).toLocaleString() %>')).toContain('toLocale*');
    expect(symbolsOf('<% structuredClone({}) %>')).toContain('structuredClone');
    expect(symbolsOf('<% /(?<n>\\d+)/.exec("a1") %>')).toContain('命名捕获组');
  });

  it('给的是可执行的替代建议不是「别用」', () => {
    const r = preflightEntry('<% "a".localeCompare("b") %>');
    expect(r.issues.find((i) => i.symbol === 'localeCompare')?.hint).toContain('fmt.compareName');
  });

  it('编号捕获组不报（只有命名的有问题）', () => {
    expect(symbolsOf('<% /(\\d+)/.exec("a1") %>')).not.toContain('命名捕获组');
  });
});

describe('不可复现的随机（§7）', () => {
  it('Math.random / _.random / Date.now → info + 指向 rng', () => {
    expect(symbolsOf('<% Math.random() %>')).toContain('Math.random');
    expect(symbolsOf('<% _.sample([1,2]) %>')).toContain('_.random / _.sample');
    expect(symbolsOf('<% Date.now() %>')).toContain('Date.now');
    expect(preflightEntry('<% Math.random() %>').issues[0].hint).toContain('rng');
  });

  it('rng.* 不报（那是推荐写法）', () => {
    expect(codesOf('<%= rng.roll("1d100") %>')).toEqual([]);
  });

  it('都是 info 级，不阻断', () => {
    expect(preflightEntry('<% Math.random() %>').hasBlocking).toBe(false);
  });
});

describe('批量与汇总', () => {
  it('preflightEntries 按条目分组', () => {
    const reports = preflightEntries([
      { uid: 1, name: '好条目', content: '<%= 1 %>' },
      { uid: 2, name: '坏条目', content: '<% if ( %>' },
    ]);
    expect(reports).toHaveLength(2);
    expect(reports[0].report.hasBlocking).toBe(false);
    expect(reports[1].report.hasBlocking).toBe(true);
  });

  it('summarizePreflight 出一句话', () => {
    const reports = preflightEntries([
      { uid: 1, content: '<% if ( %>' },
      { uid: 2, content: '<% 未知符号x() %>' },
      { uid: 3, content: '<% Math.random() %>' },
    ]);
    const s = summarizePreflight(reports);
    expect(s.errors).toBeGreaterThan(0);
    expect(s.warnings).toBeGreaterThan(0);
    expect(s.infos).toBeGreaterThan(0);
    expect(s.text).toContain('回退');
  });

  it('全干净时给出正面结论', () => {
    expect(summarizePreflight(preflightEntries([{ uid: 1, content: '<%= 1 %>' }])).text).toBe(
      '未发现问题',
    );
  });
});

describe('预检自身永不抛', () => {
  it('空 / null / 超长 / 畸形输入', () => {
    expect(() => preflightEntry('')).not.toThrow();
    expect(() => preflightEntry(null as unknown as string)).not.toThrow();
    expect(() => preflightEntry('<%'.repeat(5000))).not.toThrow();
    expect(() => preflightEntry('<%= `${`${`${1}`}`}` %>')).not.toThrow();
  });
});
