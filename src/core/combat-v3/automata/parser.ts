/**
 * combat-v3/automata/parser.ts — 表达式微文法递归下降 parser（M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §七 7.3（表达式微文法）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.2（token/AST/递归下降）
 *
 * 用途：把 automaton 的 `trigger` 与 IntentTemplate 中的表达式**字符串**编译成 AST
 * （ExprAst），再由 interpreter 零 eval 解释执行于 immutable snapshot 之上。
 *
 * 安全边界（架构 §七 7.3，铁律 2——全链路零 `new Function` / `eval`）：
 *   - token 集**封闭**：数字/字符串/布尔/null/`ctx.` 点分路径/白名单函数/比较/逻辑/算术/括号
 *   - **词法期拒绝**：`=`（单等号）、`[` `]`、`{` `}`、反引号、`;`、`=>`、`new`、
 *     `function`、`this`、以及任何不以 `ctx.` 开头且不在函数白名单内的标识符
 *   - `parseCmp` **非结合**：`a < b < c` 报错（编译期抓，防误判）
 *   - 语法错误带**列号**（1-based）——验收 A3-1 / 风险 R5
 *
 * 无副作用、无全局状态；纯函数 `parseExpression(src)`。失败抛 `ExprSyntaxError`。
 */

import type { BinOp, BuiltinFn, ExprAst } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// 错误类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 表达式语法错误——**带源字符串的 1-based 列号**（plan §5.2 / 验收 A3-1）。
 *
 * 消息格式（plan §5.2）：`ExprSyntaxError: 第 N 列: 意外的 token「xxx」，期望 <期望集>`。
 * 解析在编译期抛（R5），automaton 直接不进 ActiveEffectIndex。
 */
export class ExprSyntaxError extends Error {
  /** 源字符串的 1-based 列号（出错位置） */
  readonly column: number;
  /** 出错位置的字面 token（格式化时用） */
  readonly offending: string;

  constructor(column: number, offending: string, expected: readonly string[]) {
    super(
      `ExprSyntaxError: 第 ${column} 列: 意外的 token「${offending}」，期望 <${expected.join(
        '/',
      )}>`,
    );
    this.name = 'ExprSyntaxError';
    this.column = column;
    this.offending = offending;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Token 类型
// ──────────────────────────────────────────────────────────────────────────────

type TokenType =
  | 'NUMBER'
  | 'STRING'
  | 'TRUE'
  | 'FALSE'
  | 'NULL'
  | 'IDENT'
  | 'PATH'
  | 'DOT'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'EQ'
  | 'NEQ'
  | 'LT'
  | 'LTE'
  | 'GT'
  | 'GTE'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'EOF';

interface Token {
  type: TokenType;
  /** 1-based 起始列 */
  col: number;
  /** 字面文本（报错展示用） */
  text: string;
  /** NUMBER 时数值；STRING 时解码后的字符串 */
  value?: number | string;
}

/** 白名单函数名（架构 §七 7.3 表） */
const BUILTIN_FNS: ReadonlySet<string> = new Set<BuiltinFn>([
  'min',
  'max',
  'floor',
  'ceil',
  'abs',
  'percent',
  'has',
]);

// ──────────────────────────────────────────────────────────────────────────────
// 词法器
// ──────────────────────────────────────────────────────────────────────────────

/** 词法期错误（无列号的纯拒绝类，直接映射为 ExprSyntaxError） */
function lexError(col: number, offending: string, ctx?: string): never {
  throw new ExprSyntaxError(col, offending, ctx ? [`非法字符（${ctx}）`] : ['数字/标识符/运算符']);
}

/**
 * 词法分析：把源拆成 token 流。
 *
 * 遇到**白名单外 token 一律抛 ExprSyntaxError**（plan §5.2 词法期拒绝）：
 *   - 单字符 `=`、`[`、`]`、`{`、`}`、`` ` ``、`;`、`=>` 等（它们不产生合法 token）
 *   - 关键字 `new` / `function` / `this`
 *   - 仅当标识符 = `ctx`（后跟点分路径）或 ∈ BUILTIN_FNS
 * 其余未知标识符也是词法期错误（带列号）。
 */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const col = i + 1; // 1-based 列号

    // 空白跳过
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // 数字（整数/小数，可带前导 +/- 由一元处理，这里只收非负字面量）
    if (c >= '0' && c <= '9') {
      let j = i;
      let dotSeen = false;
      while (j < n && /[0-9.]/.test(src[j])) {
        if (src[j] === '.') {
          if (dotSeen) break; // 第二个点 → 停下来，不是数字的一部分
          dotSeen = true;
        }
        j++;
      }
      tokens.push({
        type: 'NUMBER',
        col,
        text: src.slice(i, j),
        value: Number(src.slice(i, j)),
      });
      i = j;
      continue;
    }

    // 字符串字面量（单引号）
    if (c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new ExprSyntaxError(col, '字符串未闭合', ['"']);
      tokens.push({ type: 'STRING', col, text: src.slice(i, j + 1), value: out });
      i = j + 1;
      continue;
    }

    // 多字符运算符
    const two = src.slice(i, i + 2);
    if (two === '==') {
      tokens.push({ type: 'EQ', col, text: '==' });
      i += 2;
      continue;
    }
    if (two === '!=') {
      tokens.push({ type: 'NEQ', col, text: '!=' });
      i += 2;
      continue;
    }
    if (two === '<=') {
      tokens.push({ type: 'LTE', col, text: '<=' });
      i += 2;
      continue;
    }
    if (two === '>=') {
      tokens.push({ type: 'GTE', col, text: '>=' });
      i += 2;
      continue;
    }
    if (two === '&&') {
      tokens.push({ type: 'AND', col, text: '&&' });
      i += 2;
      continue;
    }
    if (two === '||') {
      tokens.push({ type: 'OR', col, text: '||' });
      i += 2;
      continue;
    }

    // 单字符运算符
    switch (c) {
      case '.':
        tokens.push({ type: 'DOT', col, text: '.' });
        i++;
        continue;
      case '(':
        tokens.push({ type: 'LPAREN', col, text: '(' });
        i++;
        continue;
      case ')':
        tokens.push({ type: 'RPAREN', col, text: ')' });
        i++;
        continue;
      case ',':
        tokens.push({ type: 'COMMA', col, text: ',' });
        i++;
        continue;
      case '+':
        tokens.push({ type: 'PLUS', col, text: '+' });
        i++;
        continue;
      case '-':
        tokens.push({ type: 'MINUS', col, text: '-' });
        i++;
        continue;
      case '*':
        tokens.push({ type: 'STAR', col, text: '*' });
        i++;
        continue;
      case '/':
        tokens.push({ type: 'SLASH', col, text: '/' });
        i++;
        continue;
      case '<':
        tokens.push({ type: 'LT', col, text: '<' });
        i++;
        continue;
      case '>':
        tokens.push({ type: 'GT', col, text: '>' });
        i++;
        continue;
      case '!':
        tokens.push({ type: 'NOT', col, text: '!' });
        i++;
        continue;
      case '=':
        lexError(col, '=', '单等号不允许（用 == 比较）');
      case '[':
        lexError(col, '[', '数组下标/字面量不允许');
      case ']':
        lexError(col, ']', '数组下标/字面量不允许');
      case '{':
        lexError(col, '{', '对象字面量不允许');
      case '}':
        lexError(col, '}', '对象字面量不允许');
      case '`':
        lexError(col, '`', '模板串不允许');
      case ';':
        lexError(col, ';', '分号不允许');
      default:
        break;
    }

    // `=>` 箭头（在 `=` 已经 lexError 的情况下，`>` 会落到默认即 `=>` 也抛，但更早被 `=` 拦）
    if (c === '=') lexError(col, '=', '单等号不允许');

    // 标识符 / 关键字 / 路径起始
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      // 关键字拒绝（词法期）
      if (
        word === 'new' ||
        word === 'function' ||
        word === 'this' ||
        word === 'class' ||
        word === 'var' ||
        word === 'let' ||
        word === 'const' ||
        word === 'return' ||
        word === 'if' ||
        word === 'else' ||
        word === 'while' ||
        word === 'for'
      ) {
        throw new ExprSyntaxError(col, word, [
          '白名单外关键字（new/function/this/var 等 一律拒绝）',
        ]);
      }
      if (word === 'true') {
        tokens.push({ type: 'TRUE', col, text: word });
        i = j;
        continue;
      }
      if (word === 'false') {
        tokens.push({ type: 'FALSE', col, text: word });
        i = j;
        continue;
      }
      if (word === 'null') {
        tokens.push({ type: 'NULL', col, text: word });
        i = j;
        continue;
      }
      if (word === 'ctx') {
        // `ctx` 后必须是 `.seg[.seg...]`；整段作为一个 PATH token（词法合并，interpreter 拆）
        if (j < n && src[j] === '.') {
          let k = j;
          const segs: string[] = [];
          while (k < n && src[k] === '.') {
            k++; // 吃 dot
            const s = k;
            while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
            const seg = src.slice(s, k);
            if (!seg) throw new ExprSyntaxError(col, 'ctx.', ['ctx 后的路径段标识符']);
            segs.push(seg);
          }
          if (segs.length === 0) throw new ExprSyntaxError(col, 'ctx.', ['dot 后路径段']);
          tokens.push({ type: 'PATH', col, text: src.slice(i, k), value: segs.join('.') });
          i = k;
          continue;
        }
        // 裸 ctx（无路径）→ 非法
        throw new ExprSyntaxError(col, 'ctx', ['ctx. 点分路径（ctx.self.hpPercent）']);
      }
      // 白名单函数
      if (BUILTIN_FNS.has(word as BuiltinFn)) {
        tokens.push({ type: 'IDENT', col, text: word, value: word });
        i = j;
        continue;
      }
      // 未知标识符 → 词法期拒绝（带列号，验收 A3-1）
      throw new ExprSyntaxError(col, word, ['白名单内建函数或 ctx. 路径']);
    }

    // 其它输入字符（无法归类）
    lexError(col, c, '无法识别的字符');
  }

  tokens.push({ type: 'EOF', col: n + 1, text: '<eof>' });
  return tokens;
}

// ──────────────────────────────────────────────────────────────────────────────
// 递归下降 parser（优先级：parseExpr → Or → And → Cmp → Add → Mul → Unary → Primary）
// ──────────────────────────────────────────────────────────────────────────────

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  /** 当前 token */
  private peek(): Token {
    return this.tokens[this.pos];
  }
  /** 前进一格并返回旧当前 token */
  private advance(): Token {
    return this.tokens[this.pos++];
  }
  /** 是否命中指定类型（命中则吃一个） */
  private eat(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** 主入口 */
  parse(): ExprAst {
    const ast = this.parseExpr();
    if (this.peek().type !== 'EOF') {
      const t = this.peek();
      throw new ExprSyntaxError(t.col, t.text, ['表达式结束']);
    }
    return ast;
  }

  // parseExpr → parseOr
  private parseExpr(): ExprAst {
    return this.parseOr();
  }

  // parseOr → parseAnd ('||' parseAnd)*
  private parseOr(): ExprAst {
    let l = this.parseAnd();
    while (this.peek().type === 'OR') {
      this.advance();
      const r = this.parseAnd();
      l = { t: 'bin', op: '||', l, r };
    }
    return l;
  }

  // parseAnd → parseCmp ('&&' parseCmp)*
  private parseAnd(): ExprAst {
    let l = this.parseCmp();
    while (this.peek().type === 'AND') {
      this.advance();
      const r = this.parseCmp();
      l = { t: 'bin', op: '&&', l, r };
    }
    return l;
  }

  // parseCmp → parseAdd (cmpOp parseAdd)?  （非结合，plan §5.2）
  private parseCmp(): ExprAst {
    const l = this.parseAdd();
    const op = this.cmpOp();
    if (!op) return l;
    this.advance();
    const r = this.parseAddNoCmp(); // 右操作数严禁再出现 cmpOperator → 非结合
    return { t: 'bin', op, l, r };
  }

  /** 当前是否为比较运算符，是则返回 op 串 */
  private cmpOp(): BinOp | null {
    switch (this.peek().type) {
      case 'EQ':
        return '==';
      case 'NEQ':
        return '!=';
      case 'LT':
        return '<';
      case 'LTE':
        return '<=';
      case 'GT':
        return '>';
      case 'GTE':
        return '>=';
      default:
        return null;
    }
  }

  /**
   * 解析 parseAdd，但**检查后续不出现比较运算符**（非结合约束）。
   * `a < b < c`：解析完 `a < b` 后，parseAddNoCmp 看到再一个 `<` → 直接抛错。
   */
  private parseAddNoCmp(): ExprAst {
    const r = this.parseAdd();
    const op = this.cmpOp();
    if (op) {
      const t = this.peek();
      throw new ExprSyntaxError(t.col, t.text, ['比较运算非结合，不允许 a < b < c']);
    }
    return r;
  }

  // parseAdd → parseMul (('+'|'-') parseMul)*
  private parseAdd(): ExprAst {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.type === 'PLUS') {
        this.advance();
        const r = this.parseMul();
        l = { t: 'bin', op: '+', l, r };
        continue;
      }
      if (t.type === 'MINUS') {
        this.advance();
        const r = this.parseMul();
        l = { t: 'bin', op: '-', l, r };
        continue;
      }
      break;
    }
    return l;
  }

  // parseMul → parseUnary (('*'|'/') parseUnary)*
  private parseMul(): ExprAst {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'STAR') {
        this.advance();
        const r = this.parseUnary();
        l = { t: 'bin', op: '*', l, r };
        continue;
      }
      if (t.type === 'SLASH') {
        this.advance();
        const r = this.parseUnary();
        l = { t: 'bin', op: '/', l, r };
        continue;
      }
      break;
    }
    return l;
  }

  // parseUnary → ('-'|'!') parseUnary | parsePrimary
  private parseUnary(): ExprAst {
    const t = this.peek();
    if (t.type === 'MINUS') {
      this.advance();
      return { t: 'unary', op: '-', operand: this.parseUnary() };
    }
    if (t.type === 'NOT') {
      this.advance();
      return { t: 'unary', op: '!', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  // parsePrimary → 字面量 | ctx 路径 | 白名单函数调用 | ( parseExpr )
  private parsePrimary(): ExprAst {
    const t = this.peek();
    switch (t.type) {
      case 'NUMBER':
        this.advance();
        return { t: 'num', v: t.value as number };
      case 'STRING':
        this.advance();
        return { t: 'str', v: t.value as string };
      case 'TRUE':
        this.advance();
        return { t: 'bool', v: true };
      case 'FALSE':
        this.advance();
        return { t: 'bool', v: false };
      case 'NULL':
        this.advance();
        return { t: 'null' };
      case 'PATH': {
        this.advance();
        const segs = (t.value as string).split('.');
        return { t: 'path', segments: segs };
      }
      case 'IDENT': {
        // 白名单函数调用：IDENT 后必须紧跟 '('
        this.advance();
        if (this.peek().type !== 'LPAREN') {
          throw new ExprSyntaxError(this.peek().col, this.peek().text, ['函数名后必须跟 (']);
        }
        this.advance();
        const args: ExprAst[] = [];
        if (this.peek().type !== 'RPAREN') {
          for (;;) {
            args.push(this.parseExpr());
            if (this.peek().type === 'COMMA') {
              this.advance();
              continue;
            }
            break;
          }
        }
        if (!this.eat('RPAREN')) {
          const nt = this.peek();
          throw new ExprSyntaxError(nt.col, nt.text, [')']);
        }
        return { t: 'call', fn: t.value as BuiltinFn, args };
      }
      case 'LPAREN': {
        this.advance();
        const inner = this.parseExpr();
        if (!this.eat('RPAREN')) {
          const nt = this.peek();
          throw new ExprSyntaxError(nt.col, nt.text, [')']);
        }
        return inner;
      }
      case 'EOF':
        throw new ExprSyntaxError(t.col, '<eof>', ['表达式']);
      default:
        throw new ExprSyntaxError(t.col, t.text, ['字面量/路径/函数/括号']);
    }
  }
}

/**
 * 编译表达式字符串 → AST（纯函数，plan §5.2）。
 *
 * @throws ExprSyntaxError 语法错误（带 1-based 列号）
 */
export function parseExpression(src: string): ExprAst {
  const p = new Parser(src);
  return p.parse();
}
