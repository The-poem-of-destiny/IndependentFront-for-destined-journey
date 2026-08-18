/**
 * layering-gate.test.ts — 结构闸门：`src/sillytavern/`（引擎）不许依赖 `src/ui/`（前端）
 *
 * 钉的是**依赖方向**这条契约本身。收口之前引擎里有 6 条反向边：
 *   · agent-tools / bloodlines / location-db / random-tables → `ui/stores/content-store`
 *   · content-source → `ui/lib/media-hash`
 *   · database → `ui/stores/create-store`（**type-only**，最容易被当成「不算依赖」放过去）
 * 外加 5 个引擎单测拿前端 store 当夹具。
 *
 * 这条契约**破坏时不会报错**：反向 import 编译得过、跑得通、测试全绿，代价是引擎从此
 * 拖着 Vue + Pinia + Dexie 整条前端链 —— headless 跑批与引擎单测都得把整个 store 拉起来，
 * 而 review 里一行 `import type { X } from '../ui/...'` 看上去人畜无害。
 *
 * 正确形状是**注入缝**：前端往缝里装，引擎只读。四条既有的缝是
 * `content-registry-runtime.ts` / `engine-settings.ts` / `map-runtime.ts` /
 * `random-event-runtime.ts`。要在引擎里用前端的东西，答案永远是「搬进引擎」或「开一条缝」。
 *
 * 🔴 **为什么 eslint 之外还要这一道**：`no-restricted-imports`（eslint.config.js 里
 *    `files: ['src/sillytavern/**\/*.ts']` 那一档）只认**静态** import/export-from。
 *    动态 `import('../ui/x')`、`import.meta.glob`、以及把路径存进变量再 import 的写法，
 *    它一概看不见。本闸门直接扫源码字符串，专治那三种。两道网互补，缺一条就留一条静默的路。
 *
 * 🔴 **`?raw` 源码读取不算依赖边**：`engine-settings.provider-wiring.test.ts` 这类
 *    「供值链路」测试用 `import.meta.glob('@ui/main.ts', { query: '?raw' })` 把前端源码
 *    当**字符串**读进来，断言「main.ts 真的往缝里装了值」。它没有把任何前端模块拉进图里，
 *    而它守的恰恰是缝的另一半（blurByDefault 那个教训：单模块测试证明不了有人供值）。
 *    所以判据是「**命中行自己**是不是真的在读源码字符串」（说明符里带 `?raw`，或本行就是
 *    带 raw 查询的 `import.meta.glob`），不是文件白名单、也不是「附近出现过 `?raw`」——
 *    白名单会被拿去掩护真 import，而「附近出现过」一句 `// ?raw` 注释就能绕开（2026-08-17 收紧）。
 *
 * 用 `node:fs` 而不是 `import.meta.glob('?raw')`（与 `map-literals-gate.test.ts` 相反）：
 * `tests/**` 在 `tsconfig.tools.json` 里带 `types: ["node"]`，读盘是这里的常规写法
 * （先例 `tests/no-world-content.test.ts`），顺带把 `combat-v3/` 等子目录一并递归到。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');
const ENGINE_DIR = join(REPO_ROOT, 'src', 'sillytavern');

// ──────────────────────────────────────────────────────────────────────────────
// 判据
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 前端路径片段。命中即违规（除非同语句里有 `?raw`）。
 *
 * 既列别名形（`@ui/`）也列相对形（`../ui/`）与绝对形（`src/ui/`）：三种写法解析到同一处，
 * 只堵一种等于留两条路。目录名单按 `src/ui/` 的实际子目录取，新增子目录时
 * 前两条（`@ui/` / `../ui/`）已经兜住了 —— 目录名单是给「有人写了 `src/ui/foo`」这种绕法用的。
 */
const UI_PATH_PATTERNS = [
  '@ui/',
  '../ui/',
  'src/ui/',
  'ui/stores/',
  'ui/lib/',
  'ui/components/',
  'ui/composables/',
] as const;

/**
 * 框架依赖。引擎里出现 `ref()` / `defineStore()` 是同一条边的另一种写法，
 * 而它比路径 import 更难在 review 里看出来。
 *
 * 匹配的是**说明符位置**（`from 'vue'` / `import('vue')` / `require('vue')`），
 * 不是裸词 `vue` —— 否则注释里提一句 Vue 就红了。
 */
const FRAMEWORK_MODULES = ['vue', 'pinia'] as const;

function frameworkPatterns(): string[] {
  const out: string[] = [];
  for (const m of FRAMEWORK_MODULES) {
    for (const q of ["'", '"']) {
      out.push(`from ${q}${m}${q}`, `import(${q}${m}${q})`, `require(${q}${m}${q})`);
    }
  }
  return out;
}

/**
 * 显式豁免清单（文件相对路径 → 理由）。
 *
 * 🔴 **它是空的，并且应当一直是空的**。留这个口子只为让「确有必要的例外」有地方写理由，
 *    而不是让人把闸门整条注释掉。真要往里加一条之前先问：这不是该开一条缝吗？
 *    （`?raw` 源码读取**不需要**登记在这里 —— 那由 `?raw` 判据处理，见文件头。）
 */
const EXEMPTIONS: Readonly<Record<string, string>> = {};

/**
 * 一行是不是纯注释行（`//` / `/* ... *\/` 的续行 `*` / 块注释首尾）。
 *
 * 为什么需要它：收口时留下的几处**说明性注释**里原文写着被删掉的那条 import
 * （`content-registry-runtime.ts` 的文件头、`start-catalog.ts` 的用法示例、
 * `types.ts` 里 `CreatePreset` 那段搬家说明）。那些注释是这次改动最有价值的产物之一，
 * 不该为了让扫描器好写就删掉。
 *
 * 判据刻意只看**行首**：以 `*` / `//` / `/*` 开头的行不可能同时是可执行代码，
 * 所以这个放行没有把真 import 漏掉的路径。反过来，`import x from '../ui/y'; // 注释`
 * 行首是 `import`，照样被抓。
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** 去掉行尾的 `//` 注释 —— 判豁免只看**可执行的那半行**（见 `isRawSourceRead`） */
function stripLineComment(line: string): string {
  const i = line.indexOf('//');
  return i < 0 ? line : line.slice(0, i);
}

/** 说明符自带 `?raw` 查询串：`import x from '@ui/main.ts?raw'`（引号内、紧贴结尾） */
const RAW_IN_SPECIFIER = /['"][^'"]*\?raw['"]/;

/** `import.meta.glob` 的 raw 选项：`query: '?raw'`（现行）/ `as: 'raw'`（上游旧写法） */
const RAW_GLOB_OPTION = /(query\s*:\s*['"]\?raw['"]|as\s*:\s*['"]raw['"])/;

/**
 * 这一处命中是不是 `?raw` 源码读取。
 *
 * 🔴 **判据必须落在命中行自己身上**（2026-08-17 评审收紧）。此前的写法是「命中行往后
 *    5 行的窗口里出现过 `?raw` 就放行」，于是一行注释就能把两道网一起绕过去：
 *
 *      await import('../ui/stores/content-store'); // ?raw
 *
 *    eslint 的 `no-restricted-imports` 看不见动态 import，本闸门又被那句注释豁免掉 ——
 *    这正是本闸门存在的理由（真 import 藏在动态写法里）被自己的豁免口子放走。
 *
 * 收紧后只认两种**真的在读源码字符串**的形态：
 *   ① 说明符里自带 `?raw`（单行就能判完，`RAW_IN_SPECIFIER`）；
 *   ② 命中行是 `import.meta.glob(` 调用，且它的选项对象里有 raw 查询 —— 只有这一种
 *      形态才准往后看窗口，因为它的选项对象天生跨行（三处既有的供值链路测试正是这个形状）。
 * 两条都先剥掉行尾注释：注释里写什么都不该改变一行代码的定性。
 */
function isRawSourceRead(lines: string[], index: number): boolean {
  const code = stripLineComment(lines[index] ?? '');
  if (RAW_IN_SPECIFIER.test(code)) return true;
  if (!code.includes('import.meta.glob(')) return false;
  return lines.slice(index, index + 5).some((l) => RAW_GLOB_OPTION.test(stripLineComment(l)));
}

/** 扫一份源码，返回违规明细（`L<行号>: <内容>`） */
function findLayeringViolations(source: string): string[] {
  const lines = source.split('\n');
  const patterns = [...UI_PATH_PATTERNS, ...frameworkPatterns()];
  const hits: string[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!patterns.some((p) => line.includes(p))) return;
    if (isRawSourceRead(lines, index)) return;
    hits.push(`L${index + 1}: ${line.trim().slice(0, 140)}`);
  });
  return hits;
}

// ──────────────────────────────────────────────────────────────────────────────
// 覆盖面
// ──────────────────────────────────────────────────────────────────────────────

/** 递归列 `src/sillytavern/**\/*.ts`（含 `.test.ts`；相对 ENGINE_DIR，正斜杠） */
function engineSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.name.endsWith('.ts')) out.push(rel);
    }
  };
  walk(ENGINE_DIR, '');
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 扫描器自测 —— 闸门可信度的前提
// ──────────────────────────────────────────────────────────────────────────────

describe('findLayeringViolations —— 闸门自身的可信度', () => {
  it('抓住静态 import（相对形 / 别名形 / type-only）', () => {
    expect(
      findLayeringViolations("import { x } from '../ui/stores/content-store';\n"),
    ).toHaveLength(1);
    expect(findLayeringViolations("import { x } from '@ui/lib/media-hash';\n")).toHaveLength(1);
    expect(
      findLayeringViolations("import type { CreatePreset } from '../ui/stores/create-store';\n"),
    ).toHaveLength(1);
  });

  it('抓住 eslint 看不见的三种写法：动态 import / require / 字符串路径', () => {
    expect(findLayeringViolations("await import('../ui/stores/content-store');\n")).toHaveLength(1);
    expect(findLayeringViolations("const m = require('@ui/lib/media-hash');\n")).toHaveLength(1);
    // 把路径先存进变量再 import —— 静态分析这一步就断了
    expect(findLayeringViolations("const P = '@ui/stores/content-store';\n")).toHaveLength(1);
  });

  it('抓住 vue / pinia（说明符位置，单双引号都算）', () => {
    expect(findLayeringViolations("import { ref } from 'vue';\n")).toHaveLength(1);
    expect(findLayeringViolations('import { defineStore } from "pinia";\n')).toHaveLength(1);
    expect(findLayeringViolations("const m = await import('pinia');\n")).toHaveLength(1);
  });

  it('注释里提到旧 import 不算违规（那些说明是收口留下的最有价值的东西）', () => {
    expect(
      findLayeringViolations(
        "/**\n * 此前是 `import { getContentRegistry } from '../ui/stores/content-store'`\n */\nexport const a = 1;\n",
      ),
    ).toEqual([]);
    expect(findLayeringViolations("// import { ref } from 'vue';\n")).toEqual([]);
  });

  it('注释里提到 Vue 这个词不算违规（判据在说明符位置，不是裸词）', () => {
    expect(findLayeringViolations('// 引擎不许依赖 Vue 的响应式\nconst a = 1;\n')).toEqual([]);
  });

  it('`?raw` 源码读取放行（它读的是字符串，不是模块）', () => {
    const src = [
      "const UI_SOURCES = import.meta.glob('@ui/main.ts', {",
      '  eager: true,',
      "  query: '?raw',",
      "  import: 'default',",
      '});',
      '',
    ].join('\n');
    expect(findLayeringViolations(src)).toEqual([]);
  });

  it('说明符自带 `?raw` 放行（单行形态）', () => {
    expect(findLayeringViolations("import mainSource from '@ui/main.ts?raw';\n")).toEqual([]);
    expect(findLayeringViolations("const s = await import('../ui/main.ts?raw');\n")).toEqual([]);
  });

  it("上游旧写法 `as: 'raw'` 的 glob 也放行", () => {
    const src = ["const S = import.meta.glob('@ui/main.ts', {", "  as: 'raw',", '});', ''].join(
      '\n',
    );
    expect(findLayeringViolations(src)).toEqual([]);
  });

  it('🔴 `// ?raw` 注释绕不过豁免（收紧前它能同时骗过两道网）', () => {
    // eslint 的 no-restricted-imports 看不见动态 import，本闸门此前又被这句注释豁免掉
    expect(
      findLayeringViolations("await import('../ui/stores/content-store'); // ?raw\n"),
    ).toHaveLength(1);
    expect(findLayeringViolations("import { ref } from 'vue'; // ?raw\n")).toHaveLength(1);
    // 注释单独占一行、紧挨着真 import 也不行
    expect(
      findLayeringViolations("// ?raw\nimport { x } from '@ui/stores/content-store';\n"),
    ).toHaveLength(1);
  });

  it('🔴 真 import 借下方合法 glob 的 `?raw` 掩护也照抓（窗口只对 glob 行开放）', () => {
    const src = [
      "import { getContentRegistry } from '@ui/stores/content-store';",
      "const S = import.meta.glob('@ui/main.ts', {",
      '  eager: true,',
      "  query: '?raw',",
      '});',
      '',
    ].join('\n');
    // 收紧前：第 1 行的 5 行窗口里有 '?raw' → 被豁免
    const hits = findLayeringViolations(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('L1');
  });

  it('`?raw` 放行**不是**文件级白名单：同文件里的真 import 照抓', () => {
    const src = [
      "const UI_SOURCES = import.meta.glob('@ui/main.ts', {",
      '  eager: true,',
      "  query: '?raw',",
      '});',
      '',
      '',
      '',
      "import { getContentRegistry } from '@ui/stores/content-store';",
      '',
    ].join('\n');
    expect(findLayeringViolations(src)).toHaveLength(1);
  });

  it('行尾带注释的真 import 照抓（行首判据不会被尾注释绕开）', () => {
    expect(
      findLayeringViolations("import { x } from '../ui/stores/content-store'; // 临时\n"),
    ).toHaveLength(1);
  });

  it('报出行号，定位得到违规处', () => {
    const hits = findLayeringViolations("const a = 1;\nconst b = 2;\nimport x from '@ui/y';\n");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('L3');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 闸门
// ──────────────────────────────────────────────────────────────────────────────

describe('分层闸门：引擎不依赖前端', () => {
  const files = engineSourceFiles();

  it('扫描面非空且确实覆盖到已知文件与子目录（确认不是在空转）', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('content-registry-runtime.ts');
    expect(files).toContain('database.ts');
    expect(files).toContain('media-hash.ts');
    // 子目录也递归到了
    expect(files.some((f) => f.startsWith('combat-v3/'))).toBe(true);
    // `.test.ts` 一并扫 —— 引擎单测拿前端 store 当夹具正是被收口的一类
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(true);
  });

  it('豁免清单为空（有例外先问「这不是该开一条缝吗」）', () => {
    expect(Object.keys(EXEMPTIONS)).toEqual([]);
  });

  it('src/sillytavern/**/*.ts 零前端依赖（含 vue / pinia / 动态 import / 字符串路径）', () => {
    const violations: string[] = [];
    for (const rel of files) {
      if (rel in EXEMPTIONS) continue;
      const source = readFileSync(join(ENGINE_DIR, rel), 'utf8');
      for (const hit of findLayeringViolations(source)) violations.push(`${rel} ${hit}`);
    }
    expect(
      violations,
      [
        '引擎（src/sillytavern）里出现了对前端（src/ui）或 Vue/Pinia 的依赖。',
        '依赖方向只有一个：前端 → 引擎。要在引擎里用前端的东西，',
        '要么把它搬进 src/sillytavern（先例：media-hash.ts、types.ts 的 CreatePreset），',
        '要么开一条注入缝由前端往里装（先例：content-registry-runtime.ts / engine-settings.ts /',
        'map-runtime.ts / random-event-runtime.ts）。违规明细:',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('四条注入缝都还在（闸门要求的那条退路不能被顺手删掉）', () => {
    for (const seam of [
      'content-registry-runtime.ts',
      'engine-settings.ts',
      'map-runtime.ts',
      'random-event-runtime.ts',
    ]) {
      expect(files, `注入缝 ${seam} 不见了`).toContain(seam);
    }
  });
});
