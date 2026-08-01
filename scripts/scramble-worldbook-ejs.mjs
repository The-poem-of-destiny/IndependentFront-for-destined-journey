/**
 * scramble-worldbook-ejs.mjs —— 真实世界书 EJS 条目「混淆语料」生成器
 *
 * 为什么存在（设计 §10.5）：
 * 我们需要一个**对着真实内容形状**的回归闸门，但不能把 4.4 MB 世界观正文搬进 git
 * （体积 + 《内容二创与素材使用授权协议》）。故本脚本把真实条目**结构留下、内容抹掉**，
 * 产出可提交的混淆夹具，让 CI 无需人工、无需真机安装就能跑真实形状的语料。
 *
 * 混淆策略（三条，各有各的理由）：
 *
 * 1. **正文（`<% %>` 之外）整体替换成填充串** —— 不做字符置换。
 *    置换保留字频，几 MB 中文做频率分析可部分还原；直接换掉则不可还原。
 *    保留：换行结构、`{{宏}}` 片段（那是**结构**，静动分层判定要用）、长度量级（超长段截断到
 *    `MAX_TEXT_RUN`，结构不变、体积暴降）。
 *
 * 2. **代码区的 CJK 走一致置换** —— 同一个字全局映射到同一个字。
 *    必须一致：`getvar('系统核心')` 与 `if (x === '系统核心')` 得继续相等，
 *    `setMessageVar('事件.X')` 写完后 `getMessageVar('事件.X')` 得读得回来。
 *    置换后是无意义中文，但读写链、对象键一致性全部保住。
 *
 * 3. **代码区的 ASCII 标识符走一致重命名** —— 抹掉 `_ellia*` / `_carmilla*` 这类音译人名。
 *    白名单（宿主 API + JS 内建 + 契约 token 如 `stat_data`）永不重命名，否则解析链路会变形、
 *    错误类别漂移，基线就测不出真东西了。
 *
 * 产物：`tests/fixtures/ejs-scrambled-corpus.json`
 *   - `entries[]`：混淆后的条目（含来源书名哈希、uid、块数、特征标签）
 *   - `fragments[]`：按 API/语法特征切出来的**代码片段**补充用例（设计 §10.5「真实条目片段补充」）
 *   - 基线状态**不在这里**——由 `ejs-scrambled-corpus.test.ts` 自己跑出来比对（见该文件头注释）
 *
 * 用法（仅维护者本地刷新夹具时跑，CI 不跑）：
 *   node scripts/scramble-worldbook-ejs.mjs --src "E:/.../SillyTavern/data/default-user/worlds" --seed 20260801
 */

import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════
// 参数
// ═══════════════════════════════════════════════════════════

function parseArgs(argv) {
  const out = { src: '', seed: 20260801, outFile: 'tests/fixtures/ejs-scrambled-corpus.json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') out.src = argv[++i];
    else if (argv[i] === '--seed') out.seed = Number(argv[++i]);
    else if (argv[i] === '--out') out.outFile = argv[++i];
  }
  return out;
}

/** 超长正文段截断阈值——保结构、砍体积 */
const MAX_TEXT_RUN = 160;
/** 宏载荷截断阈值（`{{setvar::键::大段规则}}` 这类，保形即可） */
const MAX_MACRO_LEN = 48;

// ═══════════════════════════════════════════════════════════
// 确定性随机
// ═══════════════════════════════════════════════════════════

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ═══════════════════════════════════════════════════════════
// 字符池
// ═══════════════════════════════════════════════════════════

const CJK_POOL = Array.from(
  '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥角亢氐房心尾箕斗牛女虚危室壁奎娄胃昴毕觜参井鬼柳星张翼轸',
);
const FILLER_POOL = Array.from('墨羽languid澜川霜序云章石阶雾原风信木铃水痕沙丘星轨');

const isCjk = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch);

// ═══════════════════════════════════════════════════════════
// 一致映射表
// ═══════════════════════════════════════════════════════════

/** 白名单：永不重命名的 ASCII 标识符 / 契约 token */
const KEEP_IDENTIFIERS = new Set([
  // JS 关键字与字面量
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'undefined', 'true', 'false', 'void',
  'await', 'async', 'yield', 'class', 'extends', 'super', 'static', 'get', 'set',
  // JS 内建
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'RegExp', 'Date', 'Set',
  'Map', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Error', 'TypeError', 'RangeError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'globalThis', 'Infinity', 'NaN',
  'Function', 'Reflect', 'Proxy', 'BigInt', 'Intl',
  // 常用方法名（重命名它们会把代码打断成不可执行）
  'length', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every', 'sort', 'reverse',
  'includes', 'indexOf', 'lastIndexOf', 'keys', 'values', 'entries', 'hasOwnProperty', 'call',
  'apply', 'bind', 'toString', 'valueOf', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'match', 'matchAll', 'test', 'exec', 'toFixed', 'toLowerCase', 'toUpperCase', 'startsWith',
  'endsWith', 'padStart', 'padEnd', 'repeat', 'charAt', 'charCodeAt', 'fromCharCode', 'stringify',
  'parse', 'assign', 'freeze', 'isArray', 'floor', 'ceil', 'round', 'abs', 'min', 'max', 'random',
  'pow', 'sqrt', 'now', 'add', 'has', 'delete', 'clear', 'size', 'then', 'catch', 'flat', 'flatMap',
  'isInteger', 'isFinite', 'from', 'of', 'fill', 'at', 'fromEntries', 'raw', 'trunc', 'sign',
  'localeCompare', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'normalize',
  'codePointAt', 'search', 'substring', 'substr', 'findLast', 'findLastIndex', 'getPrototypeOf',
  'getOwnPropertyNames', 'defineProperty', 'seal', 'toSorted', 'toReversed', 'toISOString',
  // 宿主对象的成员（重命名它们会把「调用存在的方法」变成「调用 undefined」，错误类别失真）
  'log', 'warn', 'info', 'error', 'debug', 'name', 'stack', 'constructor', 'prototype',
  // 宿主 API（EJS 面 + 上游别名层）——重命名会让解析链路变形，基线失真
  'getMessageVar', 'setMessageVar', 'getvar', 'setvar', 'getLocalVar', 'setLocalVar',
  'matchChatMessages', 'variables', 'print', 'getChatMessage', 'getChatMessages', 'getwi',
  'TavernHelper', 'SillyTavern', 'YAML', 'toastr', 'alert', 'message_id', 'charLoreBook',
  'lastMessageId', 'lastUserMessageId', 'triggerSlash', 'getButtonEvent',
  // 宿主对象的方法名（localStorage / TavernHelper / toastr / 能力面）——同 lodash 的道理：
  // 改了它们，测出来就是「方法名被改坏」而不是「引擎缺不缺这个能力」
  'getItem', 'setItem', 'removeItem', 'getVariables', 'getLastMessageId',
  'notify', 'player', 'present', 'affection', 'affectionLabel', 'focus', 'active',
  'roll', 'rollDetail', 'int', 'float', 'pick', 'pickN', 'shuffle', 'chance',
  'yaml', 'json', 'table', 'num', 'pct', 'bar', 'truncate', 'compareName', 'sortNames',
  // lodash 方法名 —— 也是宿主 API。漏掉会让 `_.chain(...)` 变成 `_.n1dbx(...)`，
  // 测出来的是「方法名被改坏」而不是「shim 缺不缺这个方法」，基线彻底失真。
  'chain', 'value', 'pick', 'pickBy', 'omit', 'omitBy', 'isEmpty', 'isPlainObject', 'isObject',
  'isObjectLike', 'isNumber', 'isString', 'isFunction', 'isNil', 'isUndefined', 'uniq', 'uniqBy',
  'mapValues', 'mapKeys', 'cloneDeep', 'clone', 'forOwn', 'forIn', 'keyBy', 'sample', 'sampleSize',
  'merge', 'defaults', 'defaultsDeep', 'groupBy', 'orderBy', 'sortBy', 'sumBy', 'maxBy', 'minBy',
  'countBy', 'toPairs', 'fromPairs', 'invert', 'difference', 'intersection', 'union', 'without',
  'compact', 'chunk', 'head', 'last', 'nth', 'take', 'drop', 'range', 'times', 'clamp', 'identity',
  'noop', 'capitalize', 'startCase', 'camelCase', 'kebabCase', 'snakeCase', 'escapeRegExp',
  'window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'setTimeout', 'setInterval',
  'stats', 'vars', 'local', 'char', 'world', 'quest', 'lore', 'chat', 'fmt', 'rng', 'ui', 'engine',
  'defaults', 'scope', 'noCache', 'type', 'role', 'blockQuote', 'indent', 'withMsg', 'id',
  // 契约 token（出现在字符串路径里，改了 stat_data 前缀剥离就失效）
  'stat_data', 'user', 'assistant', 'system', 'message', 'global', 'sys',
]);

class ScrambleMaps {
  constructor(seed) {
    this.rand = makeRng(seed);
    this.seed = seed;
    this.cjk = new Map();
    this.ident = new Map();
  }

  /** CJK 一致置换：同字恒同 */
  mapCjk(ch) {
    let v = this.cjk.get(ch);
    if (v === undefined) {
      v = CJK_POOL[(hashString(ch + ':' + this.seed) + this.cjk.size) % CJK_POOL.length];
      this.cjk.set(ch, v);
    }
    return v;
  }

  /** ASCII 标识符一致重命名；白名单与短名（≤2 字符，多是循环变量）原样保留 */
  mapIdent(name) {
    if (KEEP_IDENTIFIERS.has(name)) return name;
    if (name.length <= 2) return name;
    if (/^_+$/.test(name)) return name;
    let v = this.ident.get(name);
    if (v === undefined) {
      const lead = name.startsWith('_') ? '_' : '';
      v = `${lead}n${(hashString(name + ':' + this.seed) % 100000).toString(36)}`;
      // 撞名兜底：加序号直到唯一
      let n = 0;
      const taken = new Set(this.ident.values());
      while (taken.has(v)) v = `${lead}n${(hashString(name) % 100000).toString(36)}_${++n}`;
      this.ident.set(name, v);
    }
    return v;
  }
}

// ═══════════════════════════════════════════════════════════
// 正文区混淆
// ═══════════════════════════════════════════════════════════

/**
 * 正文段 → 填充串。
 *
 * **必须逐字节保住的结构**（引擎行为依赖）：首尾空白与换行（`<%_`/`_%>`/`-%>` 的空白吞噬按它们生效）、
 * `{{...}}` 宏片段（静动分层三根针之一 + 下游宏链要解析）。
 * **可以砍的**：正文本身 —— 压到 `MAX_TEXT_RUN` 个填充字 + 至多 3 个换行。
 * 夹具体积几乎全在这里，而结构测试不需要几百行正文。
 */
function scrambleProse(text, maps) {
  if (!text) return text;

  // 宏**保形不保内容**：`{{setvar::键::载荷}}` 的载荷就是世界观正文（系统名/规则条文…），
  // 原样留会直接泄露。做法：ASCII 骨架（`{{setvar::` / `::` / `}}` / `{{user}}`）原样，
  // CJK 走一致置换（键与引用仍能对上），超长载荷截断。
  const macros = (text.match(/\{\{[^{}]*\}\}/g) || []).map((m) => {
    const s = scrambleLiteralBody(m, maps);
    return s.length <= MAX_MACRO_LEN ? s : s.slice(0, MAX_MACRO_LEN - 2) + '}}';
  });

  // 首尾空白逐字节保留 —— `<%_` / `_%>` / `-%>` 的空白吞噬语义按它们生效
  const lead = text.match(/^\s*/)[0];
  const tail = text.match(/\s*$/)[0];
  const core = text.slice(lead.length, text.length - tail.length);
  if (!core) return text;

  const visible = Math.min(core.replace(/\s/g, '').length, MAX_TEXT_RUN);
  const newlines = Math.min((core.match(/\n/g) || []).length, 3);

  let filler = '';
  for (let i = 0; i < visible; i++) {
    filler += FILLER_POOL[Math.floor(maps.rand() * FILLER_POOL.length)];
  }
  // 插回若干换行（多行正文的结构特征）
  if (newlines > 0 && filler.length > newlines) {
    const step = Math.floor(filler.length / (newlines + 1));
    let out = '';
    for (let i = 0; i < newlines; i++) out += filler.slice(i * step, (i + 1) * step) + '\n';
    filler = out + filler.slice(newlines * step);
  }

  return lead + macros.join('') + filler + tail;
}

// ═══════════════════════════════════════════════════════════
// 代码区混淆（轻量扫描器：识别字符串/模板/正则/注释，其余按标识符处理）
// ═══════════════════════════════════════════════════════════

/** 字符串/模板/注释内部：只置换 CJK，ASCII 原样（保住 `stat_data.` 前缀与英文键） */
function scrambleLiteralBody(body, maps) {
  let out = '';
  for (const ch of body) out += isCjk(ch) ? maps.mapCjk(ch) : ch;
  return out;
}

/**
 * 代码区混淆。手写扫描器而非正则整段替换——正则会把字符串里的东西也当标识符改掉。
 *
 * 正则字面量识别用「前一个有意义字符」启发式（`(`/`,`/`=`/`:`/`[`/`!`/`&`/`|`/`?`/`{`/`;`/`return`
 * 之后的 `/` 视为正则开头）。语料里正则都出现在这些位置，误判成本也只是那段少改几个字。
 */
function scrambleCode(code, maps) {
  let out = '';
  let i = 0;
  let prevMeaningful = '';

  const pushIdent = (name) => {
    out += maps.mapIdent(name);
  };

  while (i < code.length) {
    const ch = code[i];

    // 行注释
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += '//' + scrambleLiteralBody(code.slice(i + 2, stop), maps);
      i = stop;
      continue;
    }
    // 块注释
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += '/*' + scrambleLiteralBody(code.slice(i + 2, stop - 2), maps) + '*/';
      i = stop;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let body = '';
      while (j < code.length) {
        if (code[j] === '\\') {
          body += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (code[j] === quote) break;
        body += code[j];
        j++;
      }
      out += quote + scrambleLiteralBody(body, maps) + quote;
      i = j + 1;
      prevMeaningful = quote;
      continue;
    }
    // 模板串：`${}` 里是代码，要递归处理
    if (ch === '`') {
      out += '`';
      let j = i + 1;
      let lit = '';
      while (j < code.length) {
        if (code[j] === '\\') {
          lit += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (code[j] === '`') break;
        if (code[j] === '$' && code[j + 1] === '{') {
          out += scrambleLiteralBody(lit, maps);
          lit = '';
          // 找配对的 }
          let depth = 1;
          let k = j + 2;
          while (k < code.length && depth > 0) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}') depth--;
            if (depth > 0) k++;
          }
          out += '${' + scrambleCode(code.slice(j + 2, k), maps) + '}';
          j = k + 1;
          continue;
        }
        lit += code[j];
        j++;
      }
      out += scrambleLiteralBody(lit, maps) + '`';
      i = j + 1;
      prevMeaningful = '`';
      continue;
    }
    // 正则字面量
    if (ch === '/' && /[(,=:[!&|?{;+\-*%~^<>]|^$/.test(prevMeaningful)) {
      let j = i + 1;
      let inClass = false;
      let body = '';
      while (j < code.length) {
        if (code[j] === '\\') {
          body += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        else if (code[j] === '/' && !inClass) break;
        else if (code[j] === '\n') break;
        body += code[j];
        j++;
      }
      if (code[j] === '/') {
        let flags = '';
        let k = j + 1;
        while (k < code.length && /[a-z]/.test(code[k])) flags += code[k++];
        out += '/' + scrambleLiteralBody(body, maps) + '/' + flags;
        i = k;
        prevMeaningful = '/';
        continue;
      }
      // 不是正则 → 当普通除号
      out += ch;
      i++;
      prevMeaningful = ch;
      continue;
    }
    // 标识符 / CJK 属性名
    if (/[A-Za-z_$\u3400-\u9fff]/.test(ch)) {
      let j = i;
      let name = '';
      while (j < code.length && /[\w$\u3400-\u9fff]/.test(code[j])) name += code[j++];
      if (/[\u3400-\u9fff]/.test(name)) {
        // 含 CJK 的标识符（多是中文属性名）→ 逐字置换，ASCII 部分保留
        out += scrambleLiteralBody(name, maps);
      } else {
        pushIdent(name);
      }
      i = j;
      prevMeaningful = 'a';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) prevMeaningful = ch;
    i++;
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 条目级混淆
// ═══════════════════════════════════════════════════════════

const EJS_OPEN = /<%/;

/** 按 `<% %>` 切分为 [{kind:'text'|'code', raw, prefix, suffix}] */
function splitEjs(content) {
  const parts = [];
  let pos = 0;
  while (pos < content.length) {
    const open = content.indexOf('<%', pos);
    if (open === -1) {
      parts.push({ kind: 'text', raw: content.slice(pos) });
      break;
    }
    if (open > pos) parts.push({ kind: 'text', raw: content.slice(pos, open) });
    const close = content.indexOf('%>', open + 2);
    if (close === -1) {
      parts.push({ kind: 'text', raw: content.slice(open) });
      break;
    }
    // 保留开闭标记的修饰符（`<%_` / `<%=` / `_%>` …）——静动分层与空白吞噬都依赖它们
    const chunk = content.slice(open, close + 2);
    const m = chunk.match(/^<%([_=\-#]?)([\s\S]*?)([_-]?)%>$/);
    if (m) parts.push({ kind: 'code', open: m[1], raw: m[2], closeMod: m[3] });
    else parts.push({ kind: 'text', raw: chunk });
    pos = close + 2;
  }
  return parts;
}

function scrambleEntry(content, maps) {
  return splitEjs(content)
    .map((p) => {
      if (p.kind === 'text') return scrambleProse(p.raw, maps);
      if (p.open === '#') return `<%#${scrambleLiteralBody(p.raw, maps)}${p.closeMod}%>`;
      return `<%${p.open}${scrambleCode(p.raw, maps)}${p.closeMod}%>`;
    })
    .join('');
}

// ═══════════════════════════════════════════════════════════
// 特征标签（让夹具自解释「这条在测什么」）
// ═══════════════════════════════════════════════════════════

const FEATURES = [
  ['跨块控制流', /<%[_\s]*(if|for|while)[\s\S]*?\{[\s\S]*?%>/],
  ['await', /\bawait\s/],
  ['IIFE', /\(\s*(?:async\s*)?function|\(\s*\(\s*\)\s*=>/],
  ['模板串', /`/],
  ['标签模板', /[A-Za-z_$][\w$]*`/],
  ['正则字面量', /[(=,:[!&|?]\s*\/[^/\s\n][^\n]*\/[gimsuy]*/],
  ['展开', /\.\.\./],
  ['可选链', /\?\./],
  ['计算下标', /[\w)\]]\s*\[\s*[A-Za-z_$][\w.$]*\s*\]/],
  ['try/catch', /\btry\s*\{/],
  ['lodash', /\b_\.[a-z]/i],
  ['lodash链式', /\b_\.chain\(/],
  ['宏内嵌代码位', /<%[^%]*\{\{/],
  ['getMessageVar', /\bgetMessageVar\s*\(/],
  ['setMessageVar', /\bsetMessageVar\s*\(/],
  ['getvar/setvar', /\b(getvar|setvar)\s*\(/],
  ['LocalVar', /\b(getLocalVar|setLocalVar)\s*\(/],
  ['matchChatMessages', /\bmatchChatMessages\s*\(/],
  ['getChatMessage', /\bgetChatMessages?\s*\(/],
  ['getwi', /\bgetwi\s*\(/],
  ['YAML', /\bYAML\./],
  ['TavernHelper', /\bTavernHelper\./],
  ['localStorage', /\blocalStorage\./],
  ['toastr/alert', /\b(toastr\.|alert\s*\()/],
  ['print', /\bprint\s*\(/],
  ['裸 variables', /(^|[^.\w])variables\b/],
];

function detectFeatures(content) {
  const code = (content.match(/<%[\s\S]*?%>/g) || []).join('\n');
  return FEATURES.filter(([, re]) => re.test(code)).map(([name]) => name);
}

// ═══════════════════════════════════════════════════════════
// 片段抽取（设计 §10.5「真实条目片段补充」）
// ═══════════════════════════════════════════════════════════

/**
 * 每个特征抽 ≤ FRAGMENT_PER_FEATURE 个**最小可编译块**当聚焦用例。
 * 取整块 `<% %>`（不切半），保证片段本身是合法编译单元。
 */
const FRAGMENT_PER_FEATURE = 2;
const FRAGMENT_MAX_LEN = 900;

function extractFragments(scrambledEntries) {
  const byFeature = new Map();
  for (const entry of scrambledEntries) {
    const blocks = entry.content.match(/<%[\s\S]*?%>/g) || [];
    for (const block of blocks) {
      if (block.length > FRAGMENT_MAX_LEN) continue;
      // 🔒 自足性闸门：语料主导模式是**跨块控制流**（`<%_ if (x) { _%>` … `<%_ } _%>`），
      //    单块切出来是 `if (x) {` —— 语法不完整。只收自己能编译过的块，
      //    否则「片段应全部可编译」这条断言测的就不是引擎而是切法。
      if (!minimalCompileOk(block)) continue;
      for (const [name, re] of FEATURES) {
        if (!re.test(block)) continue;
        const list = byFeature.get(name) || [];
        if (list.length >= FRAGMENT_PER_FEATURE) continue;
        if (list.some((f) => f.code === block)) continue;
        // `await` 片段结构自足但今天的引擎（`new Function`，非 async）编译不过 ——
        // 标出来，测试按 needsAsync 分流；T1 落地后这批会转绿（反向闸门）
        list.push({ feature: name, from: entry.id, code: block, needsAsync: /\bawait\s/.test(block) });
        byFeature.set(name, list);
      }
    }
  }
  return [...byFeature.values()].flat();
}

// ═══════════════════════════════════════════════════════════
// 自检：混淆前后编译结果必须一致
// ═══════════════════════════════════════════════════════════

/**
 * 最小版 EJS→函数体（**刻意重写而非 import 引擎**）：
 * 生成器是 .mjs、引擎是 TS，跨过去要引构建链；且这里只需要判「语法通不通过」，
 * 规则简单到重写比接管更稳（text→push、code→内联、`<%=`→push(expr)）。
 *
 * ⚠️ 这不是引擎行为的复制品，只是**语法闸门**。它与引擎的差异不影响结论：
 * 我们比的是「同一段代码混淆前后是否同样通过/同样失败」，两边用同一把尺子。
 */
function minimalCompileOk(content) {
  const parts = splitEjs(content);
  const lines = ['"use strict";', 'const __o=[];', 'const __p=(v)=>{__o.push(v)};'];
  for (const p of parts) {
    if (p.kind === 'text') lines.push(`__o.push(${JSON.stringify(p.raw)});`);
    else if (p.open === '#') continue;
    else if (p.open === '=' || p.open === '-') lines.push(`__o.push(String(${p.raw || 'undefined'}));`);
    else lines.push(p.raw);
  }
  lines.push('return __o.join("");');
  try {
    // 与引擎一致：编译成 async 函数（存量语料有 `await`）
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction(lines.join('\n'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 逐条目比对「原文编译结果 == 混淆后编译结果」。
 * 不一致 = 混淆器把语法改坏了（或把坏的改好了），夹具不可信 → **拒绝写出**。
 */
function verifyScramble(pairs) {
  const bad = [];
  for (const { id, original, scrambled } of pairs) {
    const a = minimalCompileOk(original);
    const b = minimalCompileOk(scrambled);
    if (a !== b) bad.push({ id, original: a, scrambled: b });
  }
  return bad;
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

function main() {
  const args = parseArgs(process.argv);
  if (!args.src) {
    console.error('用法: node scripts/scramble-worldbook-ejs.mjs --src <worlds 目录> [--seed N]');
    process.exit(1);
  }

  // --src 支持逗号分隔的多路径；目录则取其下全部 .json
  const files = args.src
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((p) =>
      fs.statSync(p).isDirectory()
        ? fs
            .readdirSync(p)
            .filter((f) => f.endsWith('.json'))
            .map((f) => path.join(p, f))
        : [p],
    );

  const maps = new ScrambleMaps(args.seed);
  const entries = [];
  const pairs = [];
  let scanned = 0;

  for (const file of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const raw = json.entries
      ? Array.isArray(json.entries)
        ? json.entries
        : Object.values(json.entries)
      : Array.isArray(json)
        ? json
        : [];
    // 书名哈希：不泄露书名，但同一本书的条目可归组
    const bookTag = 'wb' + (hashString(path.basename(file)) % 1000).toString(36);

    for (const e of raw) {
      scanned++;
      const content = e.content || '';
      if (!EJS_OPEN.test(content)) continue;
      const features = detectFeatures(content);
      const id = `${bookTag}#${e.uid}`;
      const scrambled = scrambleEntry(content, maps);
      pairs.push({ id, original: content, scrambled });
      entries.push({
        id,
        blocks: (content.match(/<%[\s\S]*?%>/g) || []).length,
        features,
        content: scrambled,
      });
    }
  }

  // 🔒 自检闸门：混淆不得改变编译结果，否则夹具是假的
  const bad = verifyScramble(pairs);
  if (bad.length > 0) {
    console.error(`❌ 混淆自检失败 ${bad.length} 条 —— 拒绝写出夹具：`);
    for (const b of bad.slice(0, 10)) {
      console.error(`   ${b.id}: 原文编译=${b.original} 混淆后=${b.scrambled}`);
    }
    process.exit(1);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const fragments = extractFragments(entries);

  const payload = {
    $schema: 'ejs-scrambled-corpus/v1',
    generatedBy: 'scripts/scramble-worldbook-ejs.mjs',
    seed: args.seed,
    note: '真实世界书条目的**结构**副本：正文替换为填充串、代码区 CJK 与 ASCII 标识符一致混淆。不含任何可读的世界观内容。',
    stats: { 扫描条目: scanned, 含EJS条目: entries.length, 片段: fragments.length },
    entries,
    fragments,
  };

  const outPath = path.resolve(args.outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`✅ ${outPath}`);
  console.log(`   扫描 ${scanned} 条目 → 含 EJS ${entries.length} 条 / 片段 ${fragments.length} 个 / ${kb} KB`);
  console.log(`   CJK 映射 ${maps.cjk.size} 字 · 标识符映射 ${maps.ident.size} 个`);
}

main();
