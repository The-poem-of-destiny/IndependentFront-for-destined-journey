/**
 * combat-v3/automata/parser.test.ts — 表达式 parser 测试（M3, 验收 A3-1）
 *
 * 覆盖（plan §5.8 / 验收 A3-1）：
 *   - 每个优先级层级各 1 例（mul / add / cmp / and / or / unary / paren）
 *   - `a < b < c` 非结合报错（带列号）
 *   - 词法期拒绝：`=`、`[`、`eval(`、`new`、`function`、`this`、未知标识符，全部带列号
 *   - `ctx.` 路径解析为 path 节点
 *   - 白名单函数调用
 */

import { describe, it, expect } from 'vitest';
import { parseExpression, ExprSyntaxError } from './parser';
import type { ExprAst } from '../types';

/** 断言抛 ExprSyntaxError 且列号正确 */
function expectErrAt(src: string, col: number, fragment?: string) {
  try {
    parseExpression(src);
    expect.unreachable(`应抛 ExprSyntaxError：${src}`);
  } catch (e) {
    expect(e).toBeInstanceOf(ExprSyntaxError);
    const err = e as ExprSyntaxError;
    expect(err.column).toBe(col);
    expect(err.message).toContain(`第 ${col} 列`);
    if (fragment) expect(err.message).toContain(fragment);
  }
}

describe('parser — 字面量', () => {
  it('数字', () => {
    expect(parseExpression('42')).toEqual({ t: 'num', v: 42 });
    expect(parseExpression('3.14')).toEqual({ t: 'num', v: 3.14 });
  });
  it('字符串（单引号，支持转义）', () => {
    expect(parseExpression("'hello'")).toEqual({ t: 'str', v: 'hello' });
    expect(parseExpression("'it\\'s'")).toEqual({ t: 'str', v: "it's" });
  });
  it('布尔 / null', () => {
    expect(parseExpression('true')).toEqual({ t: 'bool', v: true });
    expect(parseExpression('false')).toEqual({ t: 'bool', v: false });
    expect(parseExpression('null')).toEqual({ t: 'null' });
  });
});

describe('parser — ctx 路径', () => {
  it('解析点分路径', () => {
    expect(parseExpression('ctx.self.hpPercent')).toEqual({
      t: 'path',
      segments: ['self', 'hpPercent'],
    });
    expect(parseExpression('ctx.damage.preReduction')).toEqual({
      t: 'path',
      segments: ['damage', 'preReduction'],
    });
  });
  it('裸 ctx（无路径）报错', () => {
    expectErrAt('ctx', 1, 'ctx. 点分路径');
  });
});

describe('parser — 优先级层级', () => {
  it('乘除（mul）绑定比加减紧：1 + 2 * 3 => 1 + (2*3)', () => {
    const ast = parseExpression('1 + 2 * 3');
    expect(ast.t).toBe('bin');
    if (ast.t === 'bin') {
      expect(ast.op).toBe('+');
      const r = ast.r as ExprAst;
      expect(r.t).toBe('bin');
      if (r.t === 'bin') {
        expect(r.op).toBe('*');
        expect(r.l).toEqual({ t: 'num', v: 2 });
        expect(r.r).toEqual({ t: 'num', v: 3 });
      }
    }
  });
  it('比较（cmp）绑定比加减松：1 + 1 < 3', () => {
    const ast = parseExpression('1 + 1 < 3');
    expect(ast.t).toBe('bin');
    if (ast.t === 'bin') {
      expect(ast.op).toBe('<');
      const l = ast.l as ExprAst;
      expect(l.t).toBe('bin'); // 1+1
      expect((l as { t: 'bin'; op: string }).op).toBe('+');
    }
  });
  it('逻辑与（and）', () => {
    const ast = parseExpression('ctx.self.hp < 50 && ctx.self.mp > 10');
    expect(ast.t).toBe('bin');
    if (ast.t === 'bin') {
      expect(ast.op).toBe('&&');
      const l = ast.l as { t: 'bin'; op: string; l: unknown };
      expect(l.t).toBe('bin');
      expect(l.op).toBe('<');
    }
  });
  it('逻辑或（or）比 与 松', () => {
    const real = parseExpression('ctx.a < 1 || ctx.b > 2 && ctx.c') as {
      t: string;
      op: string;
      r: unknown;
    };
    expect(real.t).toBe('bin');
    expect(real.op).toBe('||');
    const r = real.r as { t: string; op: string };
    expect(r.t).toBe('bin');
    expect(r.op).toBe('&&');
  });
  it('一元（unary）', () => {
    expect(parseExpression('-5')).toEqual({ t: 'unary', op: '-', operand: { t: 'num', v: 5 } });
    expect(parseExpression('!true')).toEqual({
      t: 'unary',
      op: '!',
      operand: { t: 'bool', v: true },
    });
  });
  it('括号', () => {
    expect(parseExpression('(1 + 2) * 3')).toEqual({
      t: 'bin',
      op: '*',
      l: { t: 'bin', op: '+', l: { t: 'num', v: 1 }, r: { t: 'num', v: 2 } },
      r: { t: 'num', v: 3 },
    });
  });
});

describe('parser — 白名单函数', () => {
  it('无参 / 多参调用', () => {
    expect(parseExpression('min(1, 2)')).toEqual({
      t: 'call',
      fn: 'min',
      args: [
        { t: 'num', v: 1 },
        { t: 'num', v: 2 },
      ],
    });
    expect(parseExpression('percent(ctx.a, ctx.b)')).toEqual({
      t: 'call',
      fn: 'percent',
      args: [
        { t: 'path', segments: ['a'] },
        { t: 'path', segments: ['b'] },
      ],
    });
  });
  it('括号常量绑定：percent((ctx.a+ctx.b), 100)', () => {
    const ast = parseExpression('has(ctx.list, ctx.x)');
    expect(ast.t).toBe('call');
    if (ast.t === 'call') {
      expect(ast.fn).toBe('has');
      expect(ast.args.length).toBe(2);
    }
  });
});

describe('parser — 比较非结合', () => {
  it('a < b < c 报错', () => {
    // `ctx.a < ctx.b < ctx.c`：第二个 `<` 起于 index14 → col15
    expectErrAt('ctx.a < ctx.b < ctx.c', 15, '非结合');
  });
  it('a <= b == c 报错', () => {
    expect(() => parseExpression('ctx.self.hp <= ctx.self.maxHp == true')).toThrow(ExprSyntaxError);
  });
});

describe('parser — 词法期拒绝（验收 A3-1）', () => {
  it('= 单等号报错带列号', () => {
    // `ctx.a = 1`：= 起于 index6 → col7
    expectErrAt('ctx.a = 1', 7, '=');
  });
  it('= 单等号（裸前缀也被拒，报未知标识符）', () => {
    expect(() => parseExpression('a = 1')).toThrow(ExprSyntaxError);
  });
  it('[ 数组报错带列号', () => {
    // `ctx.a[0]`：[ 起于 index5 → col6
    expectErrAt('ctx.a[0]', 6, '[');
  });
  it('eval( 报错带列号', () => {
    expectErrAt('eval(x)', 1, 'eval');
  });
  it('new 关键字报错带列号', () => {
    expectErrAt('new Promise', 1, 'new');
  });
  it('function 关键字报错', () => {
    expectErrAt('function f(){}', 1, 'function');
  });
  it('this 关键字报错', () => {
    // `ctx.damage > this`：this 起于 index13 → col14
    expectErrAt('ctx.damage > this', 14, 'this');
  });
  it('函数外地未知标识符报错', () => {
    expect(() => parseExpression('Math.random()')).toThrow(ExprSyntaxError);
  });
  it('{} 对象字面量报错', () => {
    // `ctx.a == {}`：{ 起于 index9 → col10 （先吃 ==，再遇 {）
    expectErrAt('ctx.a == {}', 10, '{');
  });
  it('模板串报错', () => {
    // `ctx.a > `` ：反引号起于 index7 → col9
    expectErrAt('ctx.a > `tpl`', 9, '`');
  });
  it('分号报错', () => {
    // `ctx.a; b`：; 起于 index5 → col6
    expectErrAt('ctx.a; b', 6, ';');
  });
});

describe('parser — 不匹配符字报错信息格式', () => {
  it('错误消息含「第 N 列」', () => {
    const err = (() => {
      try {
        parseExpression('1 + ');
        expect.unreachable();
      } catch (e) {
        return e as ExprSyntaxError;
      }
    })();
    expect(err.column).toBe(5); // 末尾缺右操作数
    expect(err.message).toMatch(/第 5 列/);
    expect(err.message).toContain('期望');
  });
});
