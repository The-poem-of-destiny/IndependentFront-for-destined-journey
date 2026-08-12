/**
 * map-literals-gate.test.ts — 结构闸门：地图引擎模块内零中文字面量（设计 §3.4-1 / §10）
 *
 * 钉的是「换图零改码」这条契约本身。地图 v1 的需求原文：**不承诺旧存档观感兼容，
 * 但换图绝不允许动引擎代码**。做法是把随图而变的一切压成 pack 字段（地形词汇与系数 /
 * 费率 / 天气词汇 / 国家与中层名 / 绑定表 / 比例尺），引擎只留类型、算法与兜底值。
 *
 * 这条契约**破坏时不会报错**：某天有人为了让某种地形走得慢一点，在 `map-path.ts` 里写下
 *   `if (tile.terrain === '沼泽') factor = 2;`
 * 测试全绿、真机也对 —— 直到换一版地图，那种地形改了名字，那行代码静默失效
 * （或者更糟：新地图里真有一种叫这个名字的地形，但系数该是别的值）。
 * 所以判据只能是结构性的：**剥掉注释后的代码里不许出现任何 CJK 字符**。
 *
 * 覆盖面用 glob 取，**新增 `map-*.ts` 自动纳入**（不用手工维护清单 —— 清单会漏，
 * 而漏掉的那个文件恰恰是没人想起来的那个）。
 *
 * 为什么不用 node:fs（照 `combat-v3/no-nondeterminism.test.ts` 与
 * `SettingsPage.engine-imports.test.ts` 的先例）：
 *   - 仓库 tsconfig 里 `types: []`、没装 @types/node —— `src/**` 下 import 'fs'
 *     测试能跑但 `npm run typecheck` 会 TS2307 红
 *   - `?raw` 的类型由 `src/env.d.ts` 引的 vite/client 提供，就是 string
 *   - 走 `import.meta.glob` 而不是相对路径算术，文件挪窝不用改测试
 *
 * 🔴 **中文注释是对的、也是被鼓励的**（仓库风格）。闸门只管注释之外的代码，所以本测试
 *    的第一件事是把剥注释器本身测通 —— 一个把整份文件都当成注释的剥离器会让闸门恒绿，
 *    而那种失败是完全无声的（先例：`blurByDefault` 那种「逻辑对但没人供值」的空转测试）。
 */

import { describe, expect, it } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// 覆盖面
// ──────────────────────────────────────────────────────────────────────────────

/**
 * eager: true —— 测试启动时同步导入
 * query: '?raw' —— 文件全文作为字符串
 * import: 'default' —— `?raw` 的 default 就是全文
 *
 * 两条 pattern：`map-*.ts`（现在与将来的全部地图模块）+ `types-map.ts`（类型分册；
 * 它同样不许有中文字面量 —— 一个写进类型的字面量联合 `'沼泽' | '苔原'` 会把地形词汇
 * 焊死在引擎里，而那比一个 if 更难拆）。
 *
 * 别名 `@engine` 在 `vitest.config.ts` 里注册；解析不到时是导入期硬报错，不会静默退化成空集。
 */
const SOURCES: Record<string, string> = import.meta.glob(
  ['@engine/map-*.ts', '@engine/types-map.ts'],
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>;

/** 取非测试源文件（排除 `*.test.ts` —— 本文件自身与 `map-pack.test.ts` 都不该被扫） */
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
// 剥注释器
// ──────────────────────────────────────────────────────────────────────────────

/**
 * CJK 统一汉字区（`一-鿿`）—— 判据与设计 §10 一致。
 * 刻意**不带 `g` 标志**：带 `g` 的正则 `.test()` 会推进 `lastIndex`，
 * 同一个实例连续测多个文件时会从上次的位置继续找 —— 那是无声的漏判。
 */
const CJK = /[一-鿿]/;

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释，**保留字符串/模板/正则的内容**。
 *
 * 为什么要逐字符扫而不是两条正则：两个方向都会错，且都错得无声。
 *   - 只用正则剥注释，`'https://example.com'` 里的 `//` 会把这一行后半截当注释吃掉；
 *     真要是那半截里有中文字面量，闸门就漏了
 *   - 反过来，`// 说明` 里的引号会让「先剥字符串」的实现进入错误状态，
 *     从那之后整份文件的分类全乱
 *
 * 正则字面量按标准启发式判定（`/` 之前最后一个有效字符若是运算符/开括号/行首，
 * 则这个 `/` 开始一条正则）—— 少了它，`/['"]/` 这种模式里的引号会污染扫描状态。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  // 上一个「有效」字符（跳空白），用于判定 `/` 是除号还是正则开头
  let prevSignificant = '';

  const isRegexStart = (): boolean => {
    if (prevSignificant === '') return true;
    return '(,=:[!&|?{};+-*%~^<>\n'.includes(prevSignificant);
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // ── 注释 ──
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue; // 换行留给下一轮原样输出
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      // 注释在语法上是空白：留一个空格，免得把两侧标识符粘成一个
      out += ' ';
      continue;
    }

    // ── 字符串 / 模板 ──
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

    // ── 正则字面量 ──
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
        if (cur === '\n') break; // 未闭合：当作除号处理，不吞掉整份文件
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

// ──────────────────────────────────────────────────────────────────────────────
// 剥注释器自测 —— 闸门可信度的前提
// ──────────────────────────────────────────────────────────────────────────────

describe('stripComments —— 闸门自身的可信度', () => {
  it('剥掉行注释与块注释里的中文', () => {
    expect(findCjkLines('// 这是注释\nconst a = 1;\n')).toEqual([]);
    expect(findCjkLines('/**\n * 中文文档注释\n */\nexport const a = 1;\n')).toEqual([]);
    expect(findCjkLines('const a = 1; // 尾随注释\n')).toEqual([]);
  });

  it('抓住字符串字面量里的中文（单引号/双引号/模板）', () => {
    expect(findCjkLines("const a = '沼泽';\n")).toHaveLength(1);
    expect(findCjkLines('const a = "沼泽";\n')).toHaveLength(1);
    expect(findCjkLines('const a = `沼泽${x}`;\n')).toHaveLength(1);
  });

  it('抓住类型层的中文字面量联合（比 if 更难拆的那种焊死）', () => {
    expect(findCjkLines("export type T = '沼泽' | '苔原';\n")).toHaveLength(1);
  });

  it('抓住正则字面量里的中文', () => {
    expect(findCjkLines('const re = /沼泽/;\n')).toHaveLength(1);
  });

  it('字符串里的 `//` 不当注释 —— 否则同行后半截的中文会漏掉', () => {
    expect(findCjkLines("const u = 'https://x.example'; const t = '沼泽';\n")).toHaveLength(1);
  });

  it('注释里的引号不打乱扫描状态 —— 否则从那以后整份文件分类全乱', () => {
    expect(findCjkLines("// 别人的 'quote' 在注释里\nconst a = '沼泽';\n")).toHaveLength(1);
  });

  it('含引号的正则不打乱扫描状态', () => {
    expect(findCjkLines("const re = /['\"]/g;\nconst a = '沼泽';\n")).toHaveLength(1);
  });

  it('除号不被当成正则开头（否则后面的代码会被整段吞掉）', () => {
    expect(findCjkLines("const r = a / b; const t = '沼泽';\n")).toHaveLength(1);
  });

  it('报出行号，定位得到违规处', () => {
    const hits = findCjkLines('const a = 1;\nconst b = 2;\nconst c = 沼泽;\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('L3');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 闸门
// ──────────────────────────────────────────────────────────────────────────────

describe('地图引擎模块结构闸门（设计 §3.4-1 换图零改码）', () => {
  const sourceFiles = getSourceFiles();

  it('glob 真的取到了地图模块（确认覆盖面非空）', () => {
    const names = sourceFiles.map((f) => f.path);
    expect(names).toContain('map-pack.ts');
    expect(names).toContain('types-map.ts');
  });

  it('排除 *.test.ts（本文件与 map-pack.test.ts 都不被扫）', () => {
    const names = sourceFiles.map((f) => f.path);
    expect(names).not.toContain('map-literals-gate.test.ts');
    expect(names).not.toContain('map-pack.test.ts');
  });

  it('剥掉注释后零 CJK 字面量', () => {
    const violations: string[] = [];
    for (const { path, content } of sourceFiles) {
      for (const hit of findCjkLines(content)) violations.push(`${path} ${hit}`);
    }
    expect(
      violations,
      [
        '地图引擎模块里出现了中文字面量。地形词汇/天气词汇/地名/系数全部随图而变，',
        '必须活在 pack 数据里（设计 §3.4-1「换图零改码」）——',
        '要调某种地形的系数，改 mapdata 侧的规则文件后重编译，不要在引擎里写 if。',
        '注释里写中文是对的，本闸门不管注释。违规明细:',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('每个被扫文件的注释里都确实有中文（反证闸门不是因为全仓无中文才绿的）', () => {
    // 如果哪天有人「顺手」把剥注释器改成剥掉一切，上一条会恒绿；
    // 这条从反方向钉住：源码原文里必须找得到 CJK（在注释里），剥完才没有。
    for (const { path, content } of sourceFiles) {
      expect(CJK.test(content), `${path} 的注释里一个中文都没有，闸门可能在空转`).toBe(true);
    }
  });
});
