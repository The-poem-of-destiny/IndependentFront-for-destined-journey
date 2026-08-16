/**
 * random-event-literals-gate.test.ts — 结构闸门：随机事件纯函数叶零中文字面量 / 零随机 / 零时钟
 * （随机事件系统 v1 / 设计 §10）
 *
 * 钉的是两条**破坏时不会报错**的契约：
 *
 * ① **二创零改码**（§8.1）：事件名 / 简报 / 槽位词 / 地点名全是内容包数据。某天有人为了让
 *    某个事件在某地更常见，在调度器里写下 `if (ctx.placeKey === '王都') w *= 2;` ——
 *    测试全绿、真机也对，直到换一份内容包，那个地点改了名字，那行代码静默失效
 *    （或者更糟：新包里真有一个叫这名字的地方，但系数该是别的值）。
 *    判据只能是结构性的：**剥掉注释后的代码里不许出现任何 CJK 字符**。
 *
 * ② **种子化随机**（铁则 3）：一次 `Math.random()` 或一次 `Date.now()` 就让快照回退 / 重发
 *    之后候选池换一批，而 debug loop 里复现不了。
 *
 * 🔴 **中文注释是对的、也是被鼓励的**（仓库风格）。闸门只管注释之外的代码，所以本测试的
 *    第一件事是把剥注释器本身测通 —— 一个把整份文件都当成注释的剥离器会让闸门恒绿，
 *    而那种失败是完全无声的。
 *
 * 🔴 **剥注释器是从 `map-literals-gate.test.ts` 原样搬来的**（算法与它的自测一并搬）。
 *    两份拷贝是有意的取舍：把它抽成共享工具要新开一个非测试模块（`src/**` 下多一个只有
 *    测试用得上的文件），而闸门的价值在于**判据自身可信**，那就必须连自测一起带着走。
 *    真要合并，正确的做法是把 glob 加进 `map-literals-gate.test.ts` 那一份并给它改名 ——
 *    那是一次跨文件重构，不在 W1 的范围里。
 *
 * 为什么不用 node:fs（照 `map-literals-gate.test.ts` / `combat-v3/no-nondeterminism.test.ts`）：
 * 仓库 tsconfig 里 `types: []`、没装 @types/node —— `src/**` 下 import 'fs' 测试能跑但
 * `npm run typecheck` 会 TS2307 红。
 */

import { describe, expect, it } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// 覆盖面
// ──────────────────────────────────────────────────────────────────────────────

/**
 * `random-event-*.ts` 的全部现在与将来（新增模块自动纳入 —— 手工清单会漏，
 * 而漏掉的那个文件恰恰是没人想起来的那个）。
 *
 * 🔴 类型分册 `types-random-events.ts` **不在覆盖面里**，与 `map-literals-gate` 收 `types-map.ts`
 *    的做法刻意相反：那边的地形/天气词汇有写成字面量联合的真实风险，这边的类型全是结构
 *    （名字与简报都是 `string`），而分册里**必须**有中文的地方只有注释。真要给它上闸门，
 *    收益是零、误报的来路却多一条。
 */
const SOURCES: Record<string, string> = import.meta.glob('@engine/random-event-*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** 取非测试源文件（`*.test.ts` 里有中文断言与 `Math.random` 之外的夹具，不该被扫） */
function getSourceFiles(): { path: string; content: string }[] {
  const entries: { path: string; content: string }[] = [];
  for (const [path, content] of Object.entries(SOURCES)) {
    const basename = path.split(/[/\\]/).pop() ?? path;
    if (basename.endsWith('.test.ts')) continue;
    if (typeof content !== 'string') continue;
    entries.push({ path: basename, content });
  }
  return entries;
}

// ──────────────────────────────────────────────────────────────────────────────
// 剥注释器（搬自 map-literals-gate.test.ts）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * CJK 统一汉字区（`一-鿿`）。刻意**不带 `g` 标志**：带 `g` 的正则 `.test()` 会推进
 * `lastIndex`，同一个实例连续测多个文件时会从上次的位置继续找 —— 那是无声的漏判。
 */
const CJK = /[一-鿿]/;

/**
 * 剥掉 `//` 行注释与块注释，**保留字符串/模板/正则的内容**。
 *
 * 逐字符扫而不是两条正则：`'https://x'` 里的 `//` 会被正则版当成注释吃掉半行，
 * 而 `// 说明里的 'quote'` 会让「先剥字符串」的实现从那以后整份文件分类全乱。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let prevSignificant = '';

  const isRegexStart = (): boolean => {
    if (prevSignificant === '') return true;
    return '(,=:[!&|?{};+-*%~^<>\n'.includes(prevSignificant);
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const cur = source[i];
        if (cur === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += cur;
        i++;
        if (cur === quote) break;
      }
      prevSignificant = quote;
      continue;
    }

    if (ch === '/' && isRegexStart()) {
      out += ch;
      i++;
      let inClass = false;
      while (i < source.length) {
        const cur = source[i];
        if (cur === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (cur === '\n') break;
        out += cur;
        i++;
        if (cur === '[') inClass = true;
        else if (cur === ']') inClass = false;
        else if (cur === '/' && !inClass) break;
      }
      prevSignificant = '/';
      continue;
    }

    out += ch;
    if (ch !== undefined && ch.trim().length > 0) prevSignificant = ch;
    else if (ch === '\n') prevSignificant = '\n';
    i++;
  }
  return out;
}

/** 违规明细：行号 + 该行剥注释后的内容（截断，够定位就行） */
function findCjkLines(source: string): string[] {
  const stripped = stripComments(source);
  const hits: string[] = [];
  stripped.split('\n').forEach((line, index) => {
    if (CJK.test(line)) hits.push(`L${index + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

/**
 * 随机/时钟判据 —— **带左括号**（照 `map-weather.test.ts` 的同款正则）。少了它，源码注释里
 * 「本模块不许用 Math.random」这句解释本身就会让闸门变红，于是下一个人的修法是把解释删掉。
 */
const FORBIDDEN = {
  random: /Math\s*\.\s*random\s*\(/,
  clockNow: /Date\s*\.\s*now\s*\(/,
  clockCtor: /new\s+Date\s*\(/,
} as const;

// ──────────────────────────────────────────────────────────────────────────────
// 闸门自身的可信度
// ──────────────────────────────────────────────────────────────────────────────

describe('闸门自测 —— 判据抓得住违规', () => {
  it('剥掉行注释与块注释里的中文', () => {
    expect(findCjkLines('// 这是注释\nconst a = 1;\n')).toEqual([]);
    expect(findCjkLines('/**\n * 中文文档注释\n */\nexport const a = 1;\n')).toEqual([]);
    expect(findCjkLines('const a = 1; // 尾随注释\n')).toEqual([]);
  });

  it('抓住字符串/模板/正则/类型联合里的中文', () => {
    expect(findCjkLines("const a = '王都';\n")).toHaveLength(1);
    expect(findCjkLines('const a = `王都${x}`;\n')).toHaveLength(1);
    expect(findCjkLines('const re = /王都/;\n')).toHaveLength(1);
    expect(findCjkLines("export type T = '王都' | '港口';\n")).toHaveLength(1);
  });

  it('字符串里的 `//` 不当注释；注释里的引号不打乱扫描状态', () => {
    expect(findCjkLines("const u = 'https://x.example'; const t = '王都';\n")).toHaveLength(1);
    expect(findCjkLines("// 别人的 'quote' 在注释里\nconst a = '王都';\n")).toHaveLength(1);
    expect(findCjkLines("const r = a / b; const t = '王都';\n")).toHaveLength(1);
  });

  it('报出行号，定位得到违规处', () => {
    const hits = findCjkLines('const a = 1;\nconst b = 王都;\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('L2');
  });

  it('随机/时钟判据抓得住违规（反证闸门不是恒绿的）', () => {
    expect(FORBIDDEN.random.test('const u = Math.random();')).toBe(true);
    expect(FORBIDDEN.clockNow.test('const t = Date.now();')).toBe(true);
    expect(FORBIDDEN.clockCtor.test('const d = new Date();')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 闸门
// ──────────────────────────────────────────────────────────────────────────────

describe('随机事件纯函数叶结构闸门（设计 §10）', () => {
  const sourceFiles = getSourceFiles();

  it('glob 真的取到了三个模块（否则下面全是空转）', () => {
    const paths = sourceFiles.map((f) => f.path);
    expect(paths).toContain('random-event-pack.ts');
    expect(paths).toContain('random-event-scheduler.ts');
    expect(paths).toContain('random-event-context.ts');
    expect(paths).not.toContain('random-event-scheduler.test.ts');
    expect(paths).not.toContain('random-event-literals-gate.test.ts');
  });

  it('剥掉注释后零 CJK 字面量', () => {
    const violations: string[] = [];
    for (const { path, content } of sourceFiles) {
      for (const hit of findCjkLines(content)) violations.push(`${path} ${hit}`);
    }
    expect(
      violations,
      [
        '随机事件引擎模块里出现了中文字面量。事件名/简报/槽位词/地点名全部随内容包而变，',
        '必须活在事件定义 JSON 里（设计 §8.1「二创零改码」）——',
        '要让某个事件在某地更常见，写一条 weights 修正，不要在调度器里写 if。',
        '注释里写中文是对的，本闸门不管注释。违规明细:',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('零 Math.random（真随机会让快照回退后候选池换一批，且 debug loop 复现不了）', () => {
    for (const { path, content } of sourceFiles) {
      expect(FORBIDDEN.random.test(content), `${path} 用了 Math.random`).toBe(false);
    }
  });

  it('零时钟（Date.now / new Date）—— 同一天的两次调度必须同答案', () => {
    for (const { path, content } of sourceFiles) {
      expect(FORBIDDEN.clockNow.test(content), `${path} 读了 Date.now`).toBe(false);
      expect(FORBIDDEN.clockCtor.test(content), `${path} 造了 new Date`).toBe(false);
    }
  });

  it('每个被扫文件的注释里都确实有中文（反证剥注释器不是把一切都剥了）', () => {
    for (const { path, content } of sourceFiles) {
      expect(CJK.test(content), `${path} 的注释里一个中文都没有，闸门可能在空转`).toBe(true);
    }
  });
});
