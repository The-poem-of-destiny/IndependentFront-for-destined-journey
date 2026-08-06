import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BEAUTIFIER_FILE,
  DEFAULT_INPUT_DIR,
  PLACEHOLDER_VERSION,
  PRESET_FILE,
  buildPlaceholderManifest,
  extractPresetRows,
  extractRuleRows,
  hashContentDeterministic,
  hashPresetRow,
  hashRuleRow,
  hashWorldBook,
  parseArgs,
  stableSerialize,
} from '../scripts/build-placeholder-hashes.mjs';
import type { FileReader } from '../scripts/build-placeholder-hashes.mjs';

import {
  hashContentDeterministic as engineHashContent,
  hashWorldBook as engineHashBook,
} from '../src/sillytavern/content-source';
import { buildPackBaseline } from '../src/sillytavern/content-pack-plan';
import { compileEjsEntry, executeEjsEntry } from '../src/sillytavern/ejs-runtime';
import type { ContentPack } from '../src/sillytavern/types-content';
import type { WorldBook } from '../src/sillytavern/types';

/**
 * `scripts/build-placeholder-hashes.mjs` 的测试。
 *
 * 🔴 **最要紧的一组是「与引擎侧算法一致」**（describe 之一）。构建脚本是 `.mjs`，不能
 * import TS 源，故它把 `content-source.ts` / `content-pack-plan.ts` 的 hash 规则复刻了一份。
 * 复刻靠自觉是守不住的：任一侧改了而另一侧没改，症状**不是报错**，而是 D20 四态基线把每一本
 * 未动过的占位书都判成「已改」→ 首次装包全线弹冲突确认。所以这里同时 import 两侧，对同一批
 * 输入断言产出同一个 hash 串。
 */

const REPO_ROOT = resolve(__dirname, '..');
const PLACEHOLDER_DIR = join(REPO_ROOT, DEFAULT_INPUT_DIR);
const MANIFEST_FILE = join(REPO_ROOT, 'src/sillytavern/placeholder-hashes.json');

/** 内存目录树 → FileReader（不碰磁盘，缺文件路径天然可控） */
function memoryFs(files: Record<string, string>): FileReader {
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    exists: (p) => {
      const k = norm(p);
      return k in files || Object.keys(files).some((f) => f.startsWith(`${k}/`));
    },
    readText: (p) => {
      const v = files[norm(p)];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    listDir: (p) => {
      const prefix = `${norm(p)}/`;
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((f) => !f.includes('/'));
    },
  };
}

const sampleBook: WorldBook = {
  id: 'demo',
  name: '演示',
  partition: 'world_setting',
  entries: [
    {
      uid: 900002,
      name: '第二条',
      content: '后写的条目',
      enabled: true,
      key: ['乙'],
      keysecondary: [],
      selectiveLogic: 0,
      order: 110,
      position: 0,
    },
    {
      uid: 900001,
      name: '第一条',
      content: '先写的条目',
      enabled: false,
      key: ['甲', '乙'],
      keysecondary: [],
      selectiveLogic: 0,
      order: 100,
      position: 0,
    },
  ],
  builtIn: true,
};

// ═══════════════════════════════════════════════════════════

describe('与引擎侧 hash 算法一致（D20 四态基线的前提）', () => {
  it('hashContentDeterministic 与 content-source.ts 逐串等价', () => {
    const cases = ['', 'a', '甲乙丙', '  ', 'a'.repeat(1000), '<%= stats.主角?.生命值 %>', '\n\t'];
    for (const c of cases) {
      expect(hashContentDeterministic(c)).toBe(engineHashContent(c));
    }
  });

  it('hashWorldBook 与 content-source.ts 对同一本书产同一 hash', () => {
    expect(hashWorldBook(sampleBook)).toBe(engineHashBook(sampleBook));
  });

  it('15 本真实占位书逐本与引擎侧一致', () => {
    const dir = join(PLACEHOLDER_DIR, 'worldbooks');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(15);
    for (const f of files) {
      const book = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorldBook;
      expect(hashWorldBook(book)).toBe(engineHashBook(book));
    }
  });

  it('byBook / byPreset / byBeautifierRule 三键与 planner 的 buildPackBaseline 一致', () => {
    const preset = { id: 'p1', name: '演示预设', settings: { prompts: [{ b: 2, a: 1 }] } };
    const rule = {
      id: 'r1',
      name: '演示规则',
      scope: 'display',
      pattern: 'x',
      flags: 'g',
      replacement: 'y',
      defaultEnabled: true,
      order: 10,
      isBuiltin: true,
    };
    const payload = {
      worldBooks: [sampleBook],
      presets: [preset],
      beautifierRules: { version: 1, rules: [rule] },
    } as unknown as ContentPack;

    const engineBaseline = buildPackBaseline(payload);

    expect(hashWorldBook(sampleBook)).toBe(engineBaseline.byBook?.[sampleBook.id]);
    expect(hashPresetRow(preset)).toBe(engineBaseline.byPreset?.[preset.id]);
    expect(hashRuleRow(rule)).toBe(engineBaseline.byBeautifierRule?.[rule.id]);
  });
});

describe('hash 不变式', () => {
  it('同内容产同 hash（重复调用稳定）', () => {
    expect(hashWorldBook(sampleBook)).toBe(hashWorldBook(structuredClone(sampleBook)));
  });

  it('条目在数组里换个顺序不改变 hash（按 uid 稳定排序）', () => {
    const reordered: WorldBook = { ...sampleBook, entries: [...sampleBook.entries].reverse() };
    expect(hashWorldBook(reordered)).toBe(hashWorldBook(sampleBook));
  });

  it('正文改一个字 hash 就变', () => {
    const edited: WorldBook = {
      ...sampleBook,
      entries: sampleBook.entries.map((e, i) =>
        i === 0 ? { ...e, content: `${e.content}。` } : e,
      ),
    };
    expect(hashWorldBook(edited)).not.toBe(hashWorldBook(sampleBook));
  });

  it('enabled 翻转 hash 就变（它是注入与否的主宰，属内容语义）', () => {
    const flipped: WorldBook = {
      ...sampleBook,
      entries: sampleBook.entries.map((e, i) => (i === 0 ? { ...e, enabled: !e.enabled } : e)),
    };
    expect(hashWorldBook(flipped)).not.toBe(hashWorldBook(sampleBook));
  });

  it('改书名 / 分区不改变 hash（那是稳定标识，不是「被编辑过」）', () => {
    const renamed: WorldBook = { ...sampleBook, name: '换个名字', partition: 'race' };
    expect(hashWorldBook(renamed)).toBe(hashWorldBook(sampleBook));
  });

  it('stableSerialize 抹平对象键顺序，但保留数组顺序', () => {
    expect(JSON.stringify(stableSerialize({ b: 1, a: 2 }))).toBe(
      JSON.stringify(stableSerialize({ a: 2, b: 1 })),
    );
    expect(JSON.stringify(stableSerialize([1, 2]))).not.toBe(
      JSON.stringify(stableSerialize([2, 1])),
    );
  });
});

describe('分节形状解析（T16 并行产出，形状容忍）', () => {
  it('extractPresetRows 认三种形状，认不出返回空', () => {
    expect(extractPresetRows({ preset: { id: 'a', settings: {} } }).map((p) => p.id)).toEqual([
      'a',
    ]);
    expect(extractPresetRows({ presets: [{ id: 'b' }, { id: 'c' }] }).map((p) => p.id)).toEqual([
      'b',
      'c',
    ]);
    expect(extractPresetRows({ id: 'd', settings: {} }).map((p) => p.id)).toEqual(['d']);
    expect(extractPresetRows([{ id: 'e' }]).map((p) => p.id)).toEqual(['e']);
    expect(extractPresetRows({ 什么都不是: 1 })).toEqual([]);
    expect(extractPresetRows(null)).toEqual([]);
  });

  it('extractRuleRows 认 {version,rules} 与顶层数组', () => {
    expect(extractRuleRows({ version: 1, rules: [{ id: 'r' }] }).map((r) => r.id)).toEqual(['r']);
    expect(extractRuleRows([{ id: 's' }]).map((r) => r.id)).toEqual(['s']);
    expect(extractRuleRows({})).toEqual([]);
  });
});

describe('buildPlaceholderManifest', () => {
  const bookJson = JSON.stringify(sampleBook);

  it('产出四键 + version，键全部字典序（重复构建逐字节相同）', () => {
    const fs = memoryFs({
      '/in/worldbooks/b.json': JSON.stringify({ ...sampleBook, id: 'zz' }),
      '/in/worldbooks/a.json': bookJson,
      '/in/defaults/story-preset.json': JSON.stringify({ preset: { id: 'p', settings: {} } }),
      '/in/defaults/beautifier-rules.json': JSON.stringify({ version: 1, rules: [{ id: 'r' }] }),
    });
    const first = buildPlaceholderManifest({ inputDir: '/in', version: '2.0.0', fs });

    expect(first.manifest.version).toBe('2.0.0');
    expect(Object.keys(first.manifest.byBook)).toEqual(['demo', 'zz']);
    expect(Object.keys(first.manifest.byPreset)).toEqual(['p']);
    expect(Object.keys(first.manifest.byBeautifierRule)).toEqual(['r']);
    expect(Object.keys(first.manifest.bySection)).toEqual([
      'defaults/beautifier-rules',
      'defaults/story-preset',
    ]);

    const second = buildPlaceholderManifest({ inputDir: '/in', version: '2.0.0', fs });
    expect(JSON.stringify(second.manifest)).toBe(JSON.stringify(first.manifest));
  });

  it('缺文件只记跳过、不抛（T15/T16 并行时是常态）', () => {
    const fs = memoryFs({ '/in/worldbooks/a.json': bookJson });
    const { manifest, skipped } = buildPlaceholderManifest({ inputDir: '/in', fs });

    expect(manifest.byBook).toEqual({ demo: hashWorldBook(sampleBook) });
    expect(manifest.byPreset).toEqual({});
    expect(manifest.bySection).toEqual({});
    expect(skipped).toContain(`${PRESET_FILE}（文件不存在）`);
    expect(skipped).toContain(`${BEAUTIFIER_FILE}（文件不存在）`);
    expect(skipped.some((s) => s.startsWith('content/catalog.json'))).toBe(true);
  });

  it('bySection 按目录扫：清单外的新占位件也自动进清单', () => {
    const fs = memoryFs({
      '/in/worldbooks/a.json': bookJson,
      // EXPECTED_SECTION_FILES 里没有这两个 —— 目录扫描照样收
      '/in/defaults/audio-manifest.json': '[]',
      '/in/content/某个将来才有的件.json': JSON.stringify({ a: 1 }),
    });
    const { manifest } = buildPlaceholderManifest({ inputDir: '/in', fs });
    expect(Object.keys(manifest.bySection)).toEqual([
      'content/某个将来才有的件',
      'defaults/audio-manifest',
    ]);
  });

  it('bySection 的 hash 不看键序与缩进（只看内容语义）', () => {
    const a = buildPlaceholderManifest({
      inputDir: '/in',
      fs: memoryFs({ '/in/content/x.json': '{"b":1,"a":2}' }),
    });
    const b = buildPlaceholderManifest({
      inputDir: '/in',
      fs: memoryFs({ '/in/content/x.json': '{\n  "a": 2,\n  "b": 1\n}\n' }),
    });
    expect(a.manifest.bySection['content/x']).toBe(b.manifest.bySection['content/x']);

    const c = buildPlaceholderManifest({
      inputDir: '/in',
      fs: memoryFs({ '/in/content/x.json': '{"a":2,"b":9}' }),
    });
    expect(c.manifest.bySection['content/x']).not.toBe(a.manifest.bySection['content/x']);
  });

  it('整个输入根缺失也不抛，只是清单全空', () => {
    const { manifest, skipped } = buildPlaceholderManifest({ inputDir: '/nope', fs: memoryFs({}) });
    expect(manifest.byBook).toEqual({});
    expect(skipped[0]).toBe('worldbooks/（目录不存在）');
  });

  it('坏 JSON 只跳过那一个文件，其余照常出 hash', () => {
    const fs = memoryFs({
      '/in/worldbooks/good.json': bookJson,
      '/in/worldbooks/bad.json': '{ 这不是 JSON',
    });
    const { manifest, skipped } = buildPlaceholderManifest({ inputDir: '/in', fs });
    expect(Object.keys(manifest.byBook)).toEqual(['demo']);
    expect(skipped.some((s) => s.includes('bad.json') && s.includes('解析失败'))).toBe(true);
  });

  it('缺 id 的世界书跳过（否则会以 undefined 为键污染基线）', () => {
    const fs = memoryFs({ '/in/worldbooks/x.json': JSON.stringify({ entries: [] }) });
    const { manifest, skipped } = buildPlaceholderManifest({ inputDir: '/in', fs });
    expect(manifest.byBook).toEqual({});
    expect(skipped).toContain('worldbooks/x.json（缺 id）');
  });

  it('内容变了 hash 就变（清单是「被编辑过吗」的判据）', () => {
    const before = buildPlaceholderManifest({
      inputDir: '/in',
      fs: memoryFs({ '/in/worldbooks/a.json': bookJson }),
    });
    const after = buildPlaceholderManifest({
      inputDir: '/in',
      fs: memoryFs({
        '/in/worldbooks/a.json': JSON.stringify({
          ...sampleBook,
          entries: [{ ...sampleBook.entries[0], content: '被用户改过了' }, sampleBook.entries[1]],
        }),
      }),
    });
    expect(after.manifest.byBook.demo).not.toBe(before.manifest.byBook.demo);
  });
});

describe('parseArgs', () => {
  it('默认值指向占位树与引擎目录', () => {
    const o = parseArgs([]);
    expect(o.input).toBe(DEFAULT_INPUT_DIR);
    expect(o.out).toBe('src/sillytavern/placeholder-hashes.json');
    expect(o.version).toBe(PLACEHOLDER_VERSION);
    expect(o.quiet).toBe(false);
  });

  it('输入目录可换（波 4 换成 public/data 重跑，不改脚本）', () => {
    expect(parseArgs(['--input', 'public/data']).input).toBe('public/data');
    expect(parseArgs(['-i', 'public/data']).input).toBe('public/data');
  });

  it('输出与版本可覆盖', () => {
    const o = parseArgs(['--out', '/tmp/x.json', '--version', '9.9.9', '--quiet']);
    expect(o.out).toBe('/tmp/x.json');
    expect(o.version).toBe('9.9.9');
    expect(o.quiet).toBe(true);
  });

  it('未知参数直接抛（别静默用默认值跑出一份错的清单）', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/未知参数/);
    expect(() => parseArgs(['--input'])).toThrow(/--input/);
  });
});

describe('已提交的 placeholder-hashes.json', () => {
  it('byBook 与当前 data/placeholder/worldbooks 同步（改了书要重跑脚本）', () => {
    expect(existsSync(MANIFEST_FILE)).toBe(true);
    const committed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
      version: string;
      byBook: Record<string, string>;
    };
    const fresh = buildPlaceholderManifest({ inputDir: PLACEHOLDER_DIR });

    expect(committed.byBook).toEqual(fresh.manifest.byBook);
    expect(committed.version).toBe(PLACEHOLDER_VERSION);
  });

  it('15 本齐、uid 全在 900001+ 保留段（D43①）、总条目 ≤150', () => {
    const dir = join(PLACEHOLDER_DIR, 'worldbooks');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(15);

    let total = 0;
    for (const f of files) {
      const book = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorldBook;
      expect(book.builtIn).toBe(true);
      expect(book.entries.length).toBeGreaterThanOrEqual(2);
      expect(book.entries.length).toBeLessThanOrEqual(5);
      total += book.entries.length;
      for (const e of book.entries) {
        expect(e.uid).toBeGreaterThanOrEqual(900001);
      }
    }
    expect(total).toBeLessThanOrEqual(150);
  });

  it('全集至少 1 条 EJS 动态条目 + 至少 1 条纯静态条目', () => {
    expect(collectDynamicEntries().length).toBeGreaterThanOrEqual(1);

    const dir = join(PLACEHOLDER_DIR, 'worldbooks');
    let statik = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const book = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorldBook;
      statik += book.entries.filter((e) => !e.content.includes('<%')).length;
    }
    expect(statik).toBeGreaterThanOrEqual(1);
  });
});

/** 占位集里所有含 `<%` 的条目（EJS 动态条） */
function collectDynamicEntries(): Array<{ book: string; entry: WorldBook['entries'][number] }> {
  const dir = join(PLACEHOLDER_DIR, 'worldbooks');
  const out: Array<{ book: string; entry: WorldBook['entries'][number] }> = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const book = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorldBook;
    for (const entry of book.entries) {
      if (entry.content.includes('<%')) out.push({ book: book.id, entry });
    }
  }
  return out;
}

/**
 * 占位集里的动态条目**必须真的能求值**。
 *
 * 🔴 它存在的全部理由就是「让 EJS 装配链在零内容态下也被真实走到一次」。而 EJS 失败条目在
 * 生产里是**原文注入**（D8 零回归兜底）—— 写坏了不报错、不变红，只是把一段模板源码原样喂给
 * 模型。所以这条断言是这个条目唯一的守卫：两条分支（有主角 / 无主角）都要 `ok`。
 */
describe('占位集的 EJS 动态条目', () => {
  it('有主角与无主角两条分支都能求值成功（失败在生产里是静默原文注入）', () => {
    const dynamics = collectDynamicEntries();
    expect(dynamics.length).toBeGreaterThanOrEqual(1);

    for (const { book, entry } of dynamics) {
      const compiled = compileEjsEntry(entry.content);

      const withPlayer = executeEjsEntry(compiled, {
        stats: {
          主角: {
            等级: 3,
            生命层级: '凡人',
            生命值: 28,
            生命值上限: 40,
            法力值: 5,
            法力值上限: 12,
            体力值: 9,
            体力值上限: 15,
          },
          世界: { 时间: '第二年 春 午后' },
        },
        vars: {},
        historyText: '',
      });
      expect(withPlayer.ok, `${book}/${entry.name} 有主角分支`).toBe(true);
      if (withPlayer.ok) expect(withPlayer.rendered).not.toContain('<%');

      const empty = executeEjsEntry(compiled, { stats: {}, vars: {}, historyText: '' });
      expect(empty.ok, `${book}/${entry.name} 空态分支`).toBe(true);
      if (empty.ok) expect(empty.rendered).not.toContain('<%');
    }
  });
});
