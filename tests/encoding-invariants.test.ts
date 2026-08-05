import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 编码不变式闸门 —— 把 AGENTS.md 那条「改中文文本之后必须验编码」的**手工命令**变成 CI 断言。
 *
 * ## 为什么值得单开一条测试
 * 编码坏字**不会让任何别的测试变红**。它只会让模型看到坏输入、让正则悄悄失效：
 * - `agent-config.json` 一度带着 47 个 U+FFFD，其中一个落在**闭合 XML 标签的标签名里** ——
 *   模型看到的是坏标签，而 diff 看着完全正常（`1812d1b` 又修了一轮 19 处）。
 * - 2026-08-05 本闸门上线当天就在 `ejs-backend-parity.test.ts` 抓到两个**真 0x08 退格**：
 *   作者想写的是正则里的单词边界，落地成了退格字节，于是 `Intl` 那条豁免分支
 *   **永远匹配不到任何东西**，测试却一直是绿的。这正是 AGENTS.md 描述的那个坑。
 *
 * ## 三条判据（缺一不可，对齐 AGENTS.md）
 * 1. U+FFFD（替换字符）为 0
 * 2. 控制字符为 0（放行 \t \n \r，其余 C0 一律算坏）
 * 3. `.json` 必须能解析
 *
 * ## 为什么还要查**解析后的值**
 * 判据 2 只扫源码字节，抓的是「脚本把真控制字符写进了文件」。但退格也可以用 JSON 的
 * **合法转义**写出来（反斜杠 + u0008）：那样源码干干净净、`JSON.parse` 也不报错，
 * 落进字符串值里却仍是一个真退格 —— 症状一模一样。所以 raw 与 parsed 两遍都要扫。
 *
 * ## 扫描范围
 * - `data/`：我们自己写的、**喂给模型**的那批文件（提示词 / 世界书 / 预设 / 美化规则）。
 * - `src/` `server/` `tests/` `scripts/` 的源码：坏字在这里同样静默 —— 见上面那个退格。
 * - **不扫** `reference/`：那是从上游下载的语料快照，本身就带着上游的坏字（实测 workshop
 *   正则快照 8 个 U+FFFD、某第三方角色卡 21 个 0x1C）。不是我们能修的，纳进来只会让闸门
 *   第一天就红。同理不扫 `docs/`：讲这个坑的文档迟早要引用坏字本身当例子。
 *
 * 🔴 本文件里凡是需要控制字符的地方一律走 `String.fromCharCode` / 数值比较，注释里也不写
 * 转义字面量 —— 初稿就栽在这：那句解释转义的注释，自己被引号层吃成了一个真 0x08 字节。
 */

const REPO_ROOT = join(__dirname, '..');
const DATA_ROOT = join(REPO_ROOT, 'data');
const SOURCE_ROOTS = ['src', 'server', 'tests', 'scripts'];

const DATA_FILE = /\.(json|txt|md)$/i;
const SOURCE_FILE = /\.(ts|tsx|vue|css|mjs|cjs)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ui', 'coverage', '.git']);

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** C0 控制字符，放行 \t(09) \n(0A) \r(0D)。 */
function isForbiddenControl(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f)
  );
}

function listFiles(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, match, out);
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** 出错时给一段上下文，否则「第 31291 个字符坏了」根本没法定位。 */
function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 24);
  return `…${text.slice(start, at + 24).replace(/[\r\n]/g, ' ')}…`;
}

interface Hit {
  kind: string;
  where: string;
  excerpt: string;
}

function scanText(text: string, where: string): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === REPLACEMENT_CHAR) {
      hits.push({ kind: 'U+FFFD', where: `${where}@${i}`, excerpt: excerpt(text, i) });
    } else if (isForbiddenControl(text.charCodeAt(i))) {
      const code = text.charCodeAt(i).toString(16).padStart(2, '0');
      hits.push({ kind: `控制字符 0x${code}`, where: `${where}@${i}`, excerpt: excerpt(text, i) });
    }
  }
  return hits;
}

/** 递归扫解析后的 JSON：只有字符串叶子需要查，路径带上便于定位是哪个提示词字段。 */
function scanParsed(node: unknown, trail: string, hits: Hit[]): void {
  if (typeof node === 'string') {
    hits.push(...scanText(node, trail));
  } else if (Array.isArray(node)) {
    node.forEach((child, index) => scanParsed(child, `${trail}[${index}]`, hits));
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) scanParsed(child, `${trail}.${key}`, hits);
  }
}

function describeHits(hits: Hit[]): string {
  return hits.map((hit) => `${hit.kind} ${hit.where} ${hit.excerpt}`).join('\n');
}

const repoRel = (file: string) => relative(REPO_ROOT, file).split(sep).join('/');
const dataRel = (file: string) => relative(DATA_ROOT, file).split(sep).join('/');

const dataFiles = listFiles(DATA_ROOT, DATA_FILE);
const sourceFiles = SOURCE_ROOTS.flatMap((root) => listFiles(join(REPO_ROOT, root), SOURCE_FILE));

describe('编码不变式', () => {
  // 🔴 空扫描等于假绿：路径写错 / 目录被搬走时，下面每条断言都会「全部通过」。
  // 这两条是那种失败模式唯一的哨兵。
  it('确实扫到了文件（防止路径写错导致的假绿）', () => {
    expect(dataFiles.length).toBeGreaterThan(10);
    expect(dataFiles.map(dataRel)).toContain('defaults/agent-config.json');
    expect(sourceFiles.length).toBeGreaterThan(400);
  });

  describe('data/', () => {
    it.each(dataFiles.map((file) => [dataRel(file), file]))('%s 源码无坏字', (_name, file) => {
      const hits = scanText(readFileSync(file, 'utf8'), 'raw');
      expect(hits, describeHits(hits)).toEqual([]);
    });

    const jsonFiles = dataFiles.filter((file) => file.endsWith('.json'));

    it.each(jsonFiles.map((file) => [dataRel(file), file]))(
      '%s 可解析且值内无坏字',
      (_name, file) => {
        const raw = readFileSync(file, 'utf8');

        let parsed: unknown;
        expect(
          () => {
            parsed = JSON.parse(raw);
          },
          `${dataRel(file)} JSON 解析失败`,
        ).not.toThrow();

        const hits: Hit[] = [];
        scanParsed(parsed, '$', hits);
        expect(hits, describeHits(hits)).toEqual([]);
      },
    );
  });

  describe('源码', () => {
    // 源码逐文件开用例会多出 600 条噪音，故聚合成一条 —— 失败时把**全部**offender 列出来。
    it('src/ server/ tests/ scripts/ 无 U+FFFD 与控制字符', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles) {
        const hits = scanText(readFileSync(file, 'utf8'), 'raw');
        if (hits.length > 0) offenders.push(`${repoRel(file)}\n  ${describeHits(hits)}`);
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });
});
