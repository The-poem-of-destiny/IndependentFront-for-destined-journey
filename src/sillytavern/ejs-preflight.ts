/**
 * ejs-preflight.ts —— EJS 兼容预检（能力面 §10 / 切片 T8）
 *
 * 纯函数：给一段世界书条目正文，**不执行**它，只回答三个问题：
 *
 * 1. 语法过不过？（过不了 → 装上去就是原文注入，创作者当场就该知道）
 * 2. 用了哪些**不在能力面里**的符号？（→ 运行期 ReferenceError → 该条目回退）
 * 3. 用了哪些**跨后端不一致**的东西？（§3.14 C 档：`Intl` / `localeCompare` / 命名捕获组…）
 *
 * ## 为什么是「预检」不是「校验」
 * 它**不阻断安装**。工坊的信任模型是「用户装什么是用户的选择」，预检的职责是
 * **让人在装之前看见后果**，不是替人做决定。全部结果都是提示，没有一条是拒绝。
 *
 * ## 为什么不做静态能力封禁
 * 隔离由 QuickJS realm 提供（§0.1），不靠静态分析 —— 这里的符号扫描是**体验**功能，
 * 漏报只是少提示一句，不是安全漏洞。所以用正则而不是 AST：够用、无依赖、不会误报到烦人。
 */

import { compileEjsEntry } from './ejs-runtime';
import { EJS_ALIAS_SYMBOLS, EJS_TOP_LEVEL_SYMBOLS } from './ejs-capabilities';

// ═══════════════════════════════════════════════════════════
// 结果类型
// ═══════════════════════════════════════════════════════════

export type PreflightLevel = 'error' | 'warning' | 'info';

export interface PreflightIssue {
  level: PreflightLevel;
  /** 机器可读的问题类别 */
  code:
    | 'syntax-error'
    | 'unknown-symbol'
    | 'cross-backend-unstable'
    | 'nondeterministic'
    | 'macro-in-code'
    | 'deprecated-alias';
  /** 给人看的一句话 */
  message: string;
  /** 涉及的符号/片段 */
  symbol?: string;
  /** 建议怎么改 */
  hint?: string;
}

export interface PreflightReport {
  /** 语法过得去（过不去 = 装上必然原文注入） */
  compiles: boolean;
  /** 含 `await` → 只能走异步预渲染路径（生产就是那条路，不影响） */
  isAsync: boolean;
  issues: PreflightIssue[];
  /** 有 error 级问题 = 这条目装上去大概率不按预期工作 */
  get hasBlocking(): boolean;
}

// ═══════════════════════════════════════════════════════════
// 已知符号表
// ═══════════════════════════════════════════════════════════

// Q-09：这两张表此前是手抄的，与 ejs-capabilities 的 CAPABILITY_PATHS、
// guest 侧的 fmtNames/rngNames 并列四份靠人眼保持一致。现在都从 EJS_SURFACE 派生。

/** 能力面 §3 的顶层符号 */
const CAPABILITY_SYMBOLS = EJS_TOP_LEVEL_SYMBOLS;

/** 兼容别名（§5）—— 认得，但会提示改用新面 */
const ALIAS_SYMBOLS = EJS_ALIAS_SYMBOLS;

/** JS 语言与内建（永远可用） */
const LANGUAGE_SYMBOLS = new Set([
  'var',
  'let',
  'const',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'in',
  'of',
  'this',
  'null',
  'undefined',
  'true',
  'false',
  'void',
  'await',
  'async',
  'yield',
  'class',
  'extends',
  'super',
  'static',
  'get',
  'set',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Math',
  'JSON',
  'RegExp',
  'Date',
  'Set',
  'Map',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'Promise',
  'Error',
  'TypeError',
  'RangeError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'Infinity',
  'NaN',
  'globalThis',
  'arguments',
]);

/**
 * §3.14 C 档：跨后端**不保证一致**。
 * 不是错误，但创作者应该知道换后端时行为会变。
 */
const CROSS_BACKEND_UNSTABLE: ReadonlyArray<{ re: RegExp; symbol: string; hint: string }> = [
  { re: /\bIntl\b/, symbol: 'Intl', hint: '隔离后端里没有 Intl，改用 fmt.num / fmt.pct' },
  {
    re: /\.localeCompare\s*\(/,
    symbol: 'localeCompare',
    hint: '不同后端排序结果不同，改用 fmt.compareName / fmt.sortNames',
  },
  {
    re: /\.toLocaleString\s*\(|\.toLocaleDateString\s*\(|\.toLocaleTimeString\s*\(/,
    symbol: 'toLocale*',
    hint: '本地化行为不保证一致，改用 fmt.num / stats.世界.时间',
  },
  { re: /\bstructuredClone\s*\(/, symbol: 'structuredClone', hint: '改用 _.cloneDeep' },
  {
    re: /\(\?<[A-Za-z_$]/,
    symbol: '命名捕获组',
    hint: '隔离后端的正则引擎不支持命名捕获组，改用编号捕获组',
  },
];

/** 不可复现的随机源 —— 快照回退重放会给出不同结果（§7） */
const NONDETERMINISTIC: ReadonlyArray<{ re: RegExp; symbol: string; hint: string }> = [
  {
    re: /\bMath\.random\s*\(/,
    symbol: 'Math.random',
    hint: '改用 rng.float / rng.int，快照重放才一致',
  },
  {
    re: /\b_\.random\s*\(|\b_\.sample\s*\(/,
    symbol: '_.random / _.sample',
    hint: '改用 rng.int / rng.pick',
  },
  {
    re: /\bDate\.now\s*\(|new\s+Date\s*\(\s*\)/,
    symbol: 'Date.now',
    hint: '要游戏内时间请用 stats.世界.时间',
  },
];

// ═══════════════════════════════════════════════════════════
// 扫描
// ═══════════════════════════════════════════════════════════

/** 取出全部代码位（`<% %>` 内），注释块丢弃 */
function extractCode(content: string): string {
  const blocks = content.match(/<%[\s\S]*?%>/g) ?? [];
  return blocks.filter((b) => !b.startsWith('<%#')).join('\n');
}

/**
 * 找出代码里引用的**自由标识符**（非本地声明、非成员访问、非字符串内）。
 *
 * 启发式而非 AST：先抹掉字符串/模板/正则/注释，再收集「不跟在 `.` 后面」的标识符，
 * 减去条目内声明的名字。漏报（把某个自由变量当成本地的）只是少提示一句，可接受。
 */
function freeIdentifiers(code: string): Set<string> {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');

  const declared = new Set<string>();
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)/g))
    declared.add(m[1]);
  for (const m of stripped.matchAll(/\bfunction\s+([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)/g))
    declared.add(m[1]);
  // 形参：`function f(a, b)` 与 `(a, b) =>`
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .replace(/[=:].*$/, '')
        .trim();
      if (/^[A-Za-z_$㐀-鿿][\w$㐀-鿿]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of stripped.matchAll(/\bcatch\s*\(\s*([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)/g))
    declared.add(m[1]);
  // 对象字面量的键不是自由引用（`{ 甲: 1 }` 里的 `甲`）。
  // 刻意按 `{`/`,` 前缀匹配而不是「后面跟冒号就跳过」—— 后者会把三元的取值分支
  // （`cond ? 甲 : 乙`）一起吞掉，那是真的自由引用。
  for (const m of stripped.matchAll(/[{,]\s*([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)\s*:/g)) declared.add(m[1]);
  for (const m of stripped.matchAll(
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)/g,
  )) {
    declared.add(m[1]);
  }

  const free = new Set<string>();
  // 前面不是 `.` 也不是标识符字符 → 自由引用。
  // 字符类含 CJK：语料里中文变量名/属性名很常见（`事件阶段` 之类），漏了会把它们全当自由引用误报。
  for (const m of stripped.matchAll(/(^|[^\w$.㐀-鿿])([A-Za-z_$㐀-鿿][\w$㐀-鿿]*)/g)) {
    const name = m[2];
    if (declared.has(name)) continue;
    if (LANGUAGE_SYMBOLS.has(name)) continue;
    free.add(name);
  }
  return free;
}

// ═══════════════════════════════════════════════════════════
// 主 API
// ═══════════════════════════════════════════════════════════

/**
 * 预检一条世界书条目。
 *
 * @param content 条目正文
 * @returns 报告。**永不抛**（预检自己炸掉是最糟的体验）
 */
export function preflightEntry(content: string): PreflightReport {
  const issues: PreflightIssue[] = [];
  const source = content ?? '';
  const code = extractCode(source);

  // ① 语法
  let compiles = true;
  let isAsync = false;
  try {
    const compiled = compileEjsEntry(source);
    isAsync = compiled.isAsync;
  } catch (err) {
    compiles = false;
    issues.push({
      level: 'error',
      code: 'syntax-error',
      message: `语法错误：${err instanceof Error ? err.message : String(err)}`,
      hint: '这条目装上后会以原文注入（模板源码直接喂给 AI），请先修语法',
    });
  }

  // ② 代码位里嵌了非自足的 ST 宏 —— 那是语法错误的常见来源
  for (const m of code.matchAll(/\{\{(?!roll|random)([A-Za-z_]+)/g)) {
    issues.push({
      level: 'error',
      code: 'macro-in-code',
      message: `代码位里嵌了 {{${m[1]}}} 宏`,
      symbol: `{{${m[1]}}}`,
      hint: '只有 {{roll}} 与 {{random::}} 能嵌在代码里；其余宏请放到正文位置',
    });
  }

  // ③ 未知符号
  if (compiles) {
    for (const name of freeIdentifiers(code)) {
      if (CAPABILITY_SYMBOLS.has(name)) continue;
      if (ALIAS_SYMBOLS.has(name)) {
        issues.push({
          level: 'info',
          code: 'deprecated-alias',
          message: `用了兼容别名 \`${name}\``,
          symbol: name,
          hint: '存量内容可以继续用；新内容建议改用能力面（见 engine-ejs.d.ts）',
        });
        continue;
      }
      issues.push({
        level: 'warning',
        code: 'unknown-symbol',
        message: `\`${name}\` 不在能力面里`,
        symbol: name,
        hint: '运行时会抛 ReferenceError，该条目将回退为原文注入。请检查拼写或改用能力面里的等价能力',
      });
    }
  }

  // ④ 跨后端不一致
  for (const { re, symbol, hint } of CROSS_BACKEND_UNSTABLE) {
    if (re.test(code)) {
      issues.push({
        level: 'warning',
        code: 'cross-backend-unstable',
        message: `\`${symbol}\` 的行为不保证跨后端一致`,
        symbol,
        hint,
      });
    }
  }

  // ⑤ 不可复现的随机
  for (const { re, symbol, hint } of NONDETERMINISTIC) {
    if (re.test(code)) {
      issues.push({
        level: 'info',
        code: 'nondeterministic',
        message: `\`${symbol}\` 不可复现`,
        symbol,
        hint,
      });
    }
  }

  return {
    compiles,
    isAsync,
    issues,
    get hasBlocking() {
      return issues.some((i) => i.level === 'error');
    },
  };
}

/** 批量预检 —— 工坊「装前检视」用。返回按条目分组的报告 */
export function preflightEntries(
  entries: Array<{ uid: number; name?: string; content: string }>,
): Array<{ uid: number; name: string; report: PreflightReport }> {
  return entries.map((e) => ({
    uid: e.uid,
    name: e.name ?? `#${e.uid}`,
    report: preflightEntry(e.content),
  }));
}

/** 汇总一句话（给列表页顶栏用） */
export function summarizePreflight(reports: Array<{ report: PreflightReport }>): {
  errors: number;
  warnings: number;
  infos: number;
  text: string;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const { report } of reports) {
    for (const issue of report.issues) {
      if (issue.level === 'error') errors++;
      else if (issue.level === 'warning') warnings++;
      else infos++;
    }
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} 项会导致条目回退`);
  if (warnings > 0) parts.push(`${warnings} 项可能不按预期工作`);
  if (infos > 0) parts.push(`${infos} 项建议`);
  return { errors, warnings, infos, text: parts.length > 0 ? parts.join('，') : '未发现问题' };
}
