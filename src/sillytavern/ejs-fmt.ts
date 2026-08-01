/**
 * ejs-fmt.ts —— `fmt` 格式化命名空间（能力面 §3.9 / 切片 T5）
 *
 * 全部纯函数、零 I/O、零依赖。**guest 侧实现**（§3.14 实现约束）：
 * 吃回调的 helper 一律不放宿主侧，否则换 QuickJS 后端时跨边界传函数会变成噩梦。
 *
 * ## 为什么需要 `fmt`
 * 1. 真机语料 5 个条目用 `YAML.stringify(obj, { blockQuote: 'literal' })` 把整理好的对象喂给 AI ——
 *    YAML 比 JSON 省 token 且 LLM 读得更稳。这是刚需，不是锦上添花。
 * 2. §3.14 把 `Intl` / `toLocaleString` / `localeCompare` 的**本地化行为**划进 C 档（不同后端不一致）。
 *    创作者需要一条**保证一致**的替代路径，那就是这里。`fmt.compareName` 自带排序口径，
 *    不依赖引擎的 locale 实现。
 *
 * 全部输出带长度上限：世界书正文直接进提示词，一个失手的循环能把上下文撑爆。
 */

/** 单次格式化输出上限（字符）。超出截断并附省略标记 —— 提示词预算是硬资源 */
const MAX_OUTPUT = 64 * 1024;
/** 递归深度上限，兼防环 */
const MAX_DEPTH = 12;

function clamp(s: string): string {
  return s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + '\n…（已截断）';
}

// ═══════════════════════════════════════════════════════════
// YAML
// ═══════════════════════════════════════════════════════════

/** YAML 里不需要引号的纯量（保守判定：拿不准就加引号） */
function isPlainScalar(s: string): boolean {
  if (s.length === 0) return false;
  if (/^[\s]|[\s]$/.test(s)) return false;
  if (/[:#\-?,[\]{}&*!|>'"%@`\n\r\t]/.test(s)) return false;
  // 看起来像数字/布尔/null 的字符串必须加引号，否则往返会变类型
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s)) return false;
  return true;
}

function yamlScalar(value: unknown, blockQuote: boolean, indent: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s.includes('\n')) {
    if (blockQuote) {
      // `|-` 块标量：多行中文正文的可读形态（也是语料里 blockQuote:'literal' 想要的）
      const body = s
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => `${indent}  ${line}`)
        .join('\n');
      return `|-\n${body}`;
    }
    return JSON.stringify(s);
  }
  return isPlainScalar(s) ? s : JSON.stringify(s);
}

function yamlNode(value: unknown, depth: number, indent: string, blockQuote: boolean): string {
  if (depth > MAX_DEPTH) return '"…（层级过深）"';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        const rendered = yamlNode(item, depth + 1, indent + '  ', blockQuote);
        return isContainer(item)
          ? `${indent}- ${rendered.replace(/^\s+/, '')}`
          : `${indent}- ${rendered}`;
      })
      .join('\n');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        const rendered = yamlNode(v, depth + 1, indent + '  ', blockQuote);
        if (isContainer(v) && rendered !== '[]' && rendered !== '{}') {
          return `${indent}${k}:\n${rendered}`;
        }
        return `${indent}${k}: ${rendered}`;
      })
      .join('\n');
  }
  return yamlScalar(value, blockQuote, indent);
}

function isContainer(v: unknown): boolean {
  return Array.isArray(v) || isPlainObject(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ═══════════════════════════════════════════════════════════
// 中文友好排序
// ═══════════════════════════════════════════════════════════

/**
 * 名字比较 —— **不依赖 `localeCompare`**。
 *
 * 理由见 §3.14：`localeCompare` 的本地化行为在浏览器引擎与 QuickJS 之间不一致
 *（前者按拼音，后者基本是码点），同一份内容在两个后端会排出不同顺序。
 * 这里用「码点序 + 数字段按数值比」的确定口径：跨后端一致，且 `第2章` 排在 `第10章` 前面。
 */
export function compareName(a: unknown, b: unknown): number {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ra = sa.match(/\d+|\D+/g) ?? [];
  const rb = sb.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const xa = ra[i];
    const xb = rb[i];
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const d = Number(xa) - Number(xb);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return ra.length - rb.length;
}

// ═══════════════════════════════════════════════════════════
// fmt 命名空间
// ═══════════════════════════════════════════════════════════

export interface EjsFmt {
  yaml(
    value: unknown,
    opts?: { blockQuote?: 'literal' | 'folded' | boolean; indent?: number },
  ): string;
  json(value: unknown, indent?: number): string;
  table(rows: unknown[], columns?: string[]): string;
  list(items: unknown[], bullet?: string): string;
  num(n: unknown, digits?: number): string;
  pct(n: unknown, digits?: number): string;
  bar(value: unknown, max: unknown, width?: number): string;
  pad(s: unknown, width: number, align?: 'left' | 'right' | 'center'): string;
  truncate(s: unknown, max: number, ellipsis?: string): string;
  compareName(a: unknown, b: unknown): number;
  sortNames(names: unknown[]): string[];
}

export const ejsFmt: EjsFmt = {
  yaml(value, opts) {
    const blockQuote = opts?.blockQuote === undefined ? true : opts.blockQuote !== false;
    try {
      return clamp(yamlNode(value, 0, '', blockQuote));
    } catch {
      // 环等异常结构 → 不抛（P3：能力永不抛，给安全默认值）
      return '';
    }
  },

  json(value, indent = 0) {
    try {
      return clamp(
        JSON.stringify(value, null, Math.max(0, Math.min(8, Number(indent) || 0))) ?? '',
      );
    } catch {
      return '';
    }
  },

  /** Markdown 表格。`columns` 缺省时取所有行键的并集（保首次出现顺序） */
  table(rows, columns) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const cols =
      Array.isArray(columns) && columns.length > 0
        ? columns.map(String)
        : Array.from(
            rows.reduce<Set<string>>((acc, r) => {
              if (isPlainObject(r)) for (const k of Object.keys(r)) acc.add(k);
              return acc;
            }, new Set<string>()),
          );
    if (cols.length === 0) return '';
    const cell = (r: unknown, c: string): string => {
      const v = isPlainObject(r) ? r[c] : undefined;
      if (v === null || v === undefined) return '';
      // 竖线会把表格切碎，转义掉
      return String(isContainer(v) ? JSON.stringify(v) : v).replace(/\|/g, '\\|');
    };
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${cols.map((c) => cell(r, c)).join(' | ')} |`);
    return clamp([head, sep, ...body].join('\n'));
  },

  list(items, bullet = '-') {
    if (!Array.isArray(items)) return '';
    const mark = String(bullet ?? '-');
    return clamp(
      items.map((x) => `${mark} ${x === null || x === undefined ? '' : String(x)}`).join('\n'),
    );
  },

  num(n, digits) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    const d =
      digits === undefined ? undefined : Math.max(0, Math.min(10, Math.floor(Number(digits) || 0)));
    const fixed = d === undefined ? String(v) : v.toFixed(d);
    // 千分位手工插入 —— 不走 toLocaleString（§3.14 C 档，后端间不一致）
    const [int, frac] = fixed.split('.');
    const sign = int.startsWith('-') ? '-' : '';
    const digitsOnly = sign ? int.slice(1) : int;
    const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + grouped + (frac ? `.${frac}` : '');
  },

  pct(n, digits = 1) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0%';
    const d = Math.max(0, Math.min(6, Math.floor(Number(digits) || 0)));
    return `${(v * 100).toFixed(d)}%`;
  },

  bar(value, max, width = 10) {
    const v = Number(value);
    const m = Number(max);
    const w = Math.max(1, Math.min(80, Math.floor(Number(width) || 10)));
    if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return '░'.repeat(w) + ' 0%';
    const ratio = Math.max(0, Math.min(1, v / m));
    const filled = Math.round(ratio * w);
    return '█'.repeat(filled) + '░'.repeat(w - filled) + ` ${Math.round(ratio * 100)}%`;
  },

  pad(s, width, align = 'left') {
    const str = s === null || s === undefined ? '' : String(s);
    const w = Math.max(0, Math.min(200, Math.floor(Number(width) || 0)));
    if (str.length >= w) return str;
    const gap = w - str.length;
    if (align === 'right') return ' '.repeat(gap) + str;
    if (align === 'center') {
      const left = Math.floor(gap / 2);
      return ' '.repeat(left) + str + ' '.repeat(gap - left);
    }
    return str + ' '.repeat(gap);
  },

  truncate(s, max, ellipsis = '…') {
    const str = s === null || s === undefined ? '' : String(s);
    const m = Math.max(0, Math.floor(Number(max) || 0));
    if (str.length <= m) return str;
    const tail = String(ellipsis ?? '');
    return str.slice(0, Math.max(0, m - tail.length)) + tail;
  },

  compareName,

  sortNames(names) {
    if (!Array.isArray(names)) return [];
    return names.map((n) => String(n ?? '')).sort(compareName);
  },
};
