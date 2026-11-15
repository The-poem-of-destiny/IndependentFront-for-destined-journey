/**
 * plugin-isolation-gate.test.ts —— 插件系统红线 A 与红线 C 的源码扫描闸门。
 *
 * 钉的是插件系统设计（docs/planning/2026-11-15-plugin-system-design.md）里两条
 * 「破坏时不会报错」的结构约束：往插件模块里 import 一个持有密钥的 store、或往插件目录
 * 路由里加一行写文件，编译得过、测试全绿，代价是红线悄悄失守。
 *
 * ## 一、红线 A：密钥不可达（§4.5）
 *
 * 扫描范围：`src/core/plugins/**`、`src/ui/lib/plugin-*.ts`、`src/ui/stores/plugin-*.ts`
 * （§4.5 点名的是 plugin-bridge / plugin-store / plugin-frame，这里按前缀扩到整族，
 * 新加的插件模块自动纳入）。三类判据：
 *
 * 1. 禁止 import（按说明符位置匹配：静态 import / export-from / 动态 import / require）：
 *    - §4.5 原文：`api-source-store`、`settings-store`、`discord-auth-client`、`workshop-social-store`；
 *    - 本闸门补充：`src/core/api/`（LLM / 图像调用层，带端点与密钥）、`endpoint-resolver`、
 *      `image-client`、`api-key-migration`、`types-api`（端点与密钥的类型定义）。
 * 2. 禁止标识符：
 *    - §4.5 原文：`apiEndpoints`、`imageApiConnections`、`debugTurns`、`promptSessions`；
 *    - 本闸门补充：`apiKey` / `apiKeys`（设置里的密钥字段）、`localStorage` / `sessionStorage`
 *      （设置与凭据的旧存放处）、`indexedDB`（插件数据只经 `core/persistence/plugin-storage.ts`，
 *      该文件不在扫描范围内）、`document.cookie`。
 * 3. 联网原语（`fetch(`、`.fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`、
 *    `importScripts`）只许出现在下方 `NETWORK_ALLOWED` 登记过的文件里，且次数逐条钉死：
 *    宿主侧只许同源相对地址 `/api/plugins…`（另有断言钉住两处地址常量）；自检探针里的原语
 *    是送进插件帧执行的源码字符串，不在宿主上下文运行。
 *
 * ## 二、红线 C：本地文件（§4.6）
 *
 * 扫描 `server/plugin-dir.ts`、`server/plugin-canary.ts`、`server/routes/plugins.ts`，不得出现
 * 任何写盘 / 改名 / 删除 / 建目录 / 跟随链接的调用：`writeFile`、`appendFile`、`rename`、
 * `unlink`、`mkdir`、`mkdtemp`、`rm(`、`rmSync`、`rmdir`、`realpath`、`copyFile`、`cp(`、
 * `symlink`、`link(`、`truncate`、`createWriteStream`、`chmod`、`chown`、`utimes`、
 * `child_process`；`open(` 只许不带标志或带只读标志 `'r'`。
 *
 * ## 判据的口径
 *
 * - 扫的是**原始源码文本**，不剥注释：剥注释的正则会把 `${scheme}//${host}` 这类模板里的
 *   `//` 当注释起点吞掉后半行，反而开出一条藏东西的缝。代价是注释里也不能写这些标识符 ——
 *   要写就换个说法。
 * - 例外一律进 `NETWORK_ALLOWED` 并写明理由与次数；次数对不上、登记的文件不存在都算失败，
 *   免得旧登记掩护新代码。
 * - 文件末尾有扫描器自检：拿夹具字符串证明每条判据确实会报。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');

const toPosix = (path: string) => path.split(sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

function prefixed(dir: string, prefix: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((name) => name.startsWith(prefix) && /\.ts$/.test(name))
    .map((name) => join(REPO_ROOT, dir, name));
}

interface SourceFile {
  rel: string;
  text: string;
}

function load(paths: string[]): SourceFile[] {
  return paths
    .map((path) => ({ rel: toPosix(relative(REPO_ROOT, path)), text: readFileSync(path, 'utf8') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// ──────────────────────────────────────────────────────────────────────────────
// 红线 A 判据
// ──────────────────────────────────────────────────────────────────────────────

/** 禁止出现在 import 说明符里的路径片段 */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  // §4.5 原文
  'api-source-store',
  'settings-store',
  'discord-auth-client',
  'workshop-social-store',
  // 本闸门补充：调用层与端点 / 密钥定义
  'core/api/',
  'endpoint-resolver',
  'image-client',
  'api-key-migration',
  'types-api',
] as const;

/** 说明符位置：from '…' / import('…') / require('…') */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

/** 相对说明符里 `../api/`（引擎内）也指向 core/api；归一成 `core/api/` 再比对 */
function normalizeSpecifier(spec: string, rel: string): string {
  if (rel.startsWith('src/core/') && /^(\.\.\/)+api\//.test(spec)) {
    return spec.replace(/^(\.\.\/)+api\//, 'core/api/');
  }
  return spec;
}

function findForbiddenImports(text: string, rel: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const spec = normalizeSpecifier(match[2], rel);
    for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
      if (spec.includes(fragment)) hits.push(`${fragment} ← ${match[2]}`);
    }
  }
  return hits;
}

/** 禁止标识符（整词匹配） */
const FORBIDDEN_IDENTIFIERS = [
  // §4.5 原文
  'apiEndpoints',
  'imageApiConnections',
  'debugTurns',
  'promptSessions',
  // 本闸门补充
  'apiKey',
  'apiKeys',
  'localStorage',
  'sessionStorage',
  'indexedDB',
] as const;

function findForbiddenIdentifiers(text: string): string[] {
  const hits: string[] = [];
  for (const id of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${id}\\b`).test(text)) hits.push(id);
  }
  if (/\bdocument\s*\.\s*cookie\b/.test(text)) hits.push('document.cookie');
  return hits;
}

/** 联网原语 */
const NETWORK_PRIMITIVE =
  /\bfetch\s*\(|\.fetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b/g;

function countNetworkPrimitives(text: string): number {
  return [...text.matchAll(NETWORK_PRIMITIVE)].length;
}

/**
 * 联网原语的登记表：文件 → 次数 + 理由。
 * 次数 = `NETWORK_PRIMITIVE` 在该文件里的命中数，改动代码时必须同步改这里。
 */
const NETWORK_ALLOWED: Record<string, { count: number; reason: string }> = {
  'src/ui/lib/plugin-client.ts': {
    count: 2,
    reason:
      '宿主取本地插件清单与文件：只用同源相对地址 /api/plugins（LIST_URL），fetch 可注入（options.fetch / globalThis.fetch 各一处）',
  },
  'src/ui/stores/plugin-store.ts': {
    count: 3,
    reason:
      '启动自检向同源 BFF 登记 / 查询金丝雀：只打相对地址 /api/plugins/__selfcheck/（SELFCHECK_API）；' +
      '另 1 处是 S5 之前对「另一个回环主机名」（localhost ↔ 127.0.0.1，同协议同端口）的 no-cors 探活，路径仍是 SELFCHECK_API',
  },
  'src/ui/lib/plugin-selfcheck.ts': {
    count: 18,
    reason:
      '自检探针（§4.8 S0–S7）：15 处在送进插件帧 / 探针文档执行的源码字符串与标签映射里，2 处是读探针地址表的 u.fetch 键（只取字符串），用来证明 CSP 拦得住它们，宿主上下文不调用；' +
      '另 1 处是管线孪生帧（宿主自写、无插件代码）文档字符串里的 fetch，证明金丝雀管线本身通',
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// 红线 C 判据
// ──────────────────────────────────────────────────────────────────────────────

const SERVER_FILES = [
  'server/plugin-dir.ts',
  'server/plugin-canary.ts',
  'server/routes/plugins.ts',
];

/** 写盘 / 改名 / 删除 / 建目录 / 跟随链接 */
const FS_WRITE_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'writeFile', re: /\bwriteFile\w*/ },
  { label: 'appendFile', re: /\bappendFile\w*/ },
  { label: 'rename', re: /\brename\w*/ },
  { label: 'unlink', re: /\bunlink\w*/ },
  { label: 'mkdir', re: /\bmkdir\w*/ },
  { label: 'mkdtemp', re: /\bmkdtemp\w*/ },
  { label: 'rm(', re: /\brm\s*\(/ },
  { label: 'rmSync', re: /\brmSync\b/ },
  { label: 'rmdir', re: /\brmdir\w*/ },
  { label: 'realpath', re: /\brealpath\w*/i },
  { label: 'copyFile', re: /\bcopyFile\w*/ },
  { label: 'cp(', re: /\bcp(?:Sync)?\s*\(/ },
  { label: 'symlink', re: /\bsymlink\w*/ },
  { label: 'link(', re: /\blink(?:Sync)?\s*\(/ },
  { label: 'truncate', re: /\b(?:f?truncate)\w*/ },
  { label: 'createWriteStream', re: /\bcreateWriteStream\b/ },
  { label: 'chmod', re: /\b[fl]?chmod\w*/ },
  { label: 'chown', re: /\b[fl]?chown\w*/ },
  { label: 'utimes', re: /\b[fl]?utimes\w*/ },
  { label: 'child_process', re: /child_process/ },
];

/** `open(` / `openSync(` 的调用，捕获到右括号为止的实参 */
const OPEN_CALL = /\bopen(?:Sync)?\s*\(([^)]*)\)/g;

function findServerWriteIdentifiers(text: string): string[] {
  const hits = FS_WRITE_PATTERNS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  for (const match of text.matchAll(OPEN_CALL)) {
    const args = match[1];
    // 只许单实参（默认只读）或第二实参是字面量 'r'
    const readOnly = !args.includes(',') || /,\s*(['"`])r\1\s*(?:,|$)/.test(args.trim());
    if (!readOnly) hits.push(`open 带写标志：${match[0]}`);
  }
  return hits;
}

// ──────────────────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────────────────

const pluginClientFiles = load([
  ...walk(join(REPO_ROOT, 'src', 'core', 'plugins')),
  ...prefixed(join('src', 'ui', 'lib'), 'plugin-'),
  ...prefixed(join('src', 'ui', 'stores'), 'plugin-'),
]);

describe('红线 A：插件模块够不着密钥（§4.5）', () => {
  it('扫描范围非空，且覆盖 §4.5 点名的模块', () => {
    const rels = pluginClientFiles.map((f) => f.rel);
    expect(rels).toEqual(
      expect.arrayContaining([
        'src/ui/lib/plugin-bridge.ts',
        'src/ui/lib/plugin-frame.ts',
        'src/ui/stores/plugin-store.ts',
        'src/core/plugins/plugin-projection.ts',
      ]),
    );
  });

  it('不 import 持有密钥或端点的模块', () => {
    const violations = pluginClientFiles.flatMap((f) =>
      findForbiddenImports(f.text, f.rel).map((hit) => `${f.rel}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it('不出现密钥 / 调试记录 / 浏览器存储标识符', () => {
    const violations = pluginClientFiles.flatMap((f) =>
      findForbiddenIdentifiers(f.text).map((hit) => `${f.rel}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it('联网原语只出现在登记过的文件里，次数与登记一致', () => {
    const actual: Record<string, number> = {};
    for (const f of pluginClientFiles) {
      const count = countNetworkPrimitives(f.text);
      if (count > 0) actual[f.rel] = count;
    }
    const expected = Object.fromEntries(
      Object.entries(NETWORK_ALLOWED).map(([rel, { count }]) => [rel, count]),
    );
    expect(actual).toEqual(expected);
  });

  it('宿主侧的两处请求地址都是同源相对的 /api/plugins', () => {
    const client = readFileSync(join(REPO_ROOT, 'src/ui/lib/plugin-client.ts'), 'utf8');
    const store = readFileSync(join(REPO_ROOT, 'src/ui/stores/plugin-store.ts'), 'utf8');
    expect(client).toMatch(/const LIST_URL = '\/api\/plugins';/);
    expect(store).toMatch(/const SELFCHECK_API = '\/api\/plugins\/__selfcheck\/';/);
    // 宿主侧 fetch 的首个实参只能从这两个常量派生；
    // 唯一例外是第二回环主机名探活：前缀 loopbackOrigin 只能由 localhost ↔ 127.0.0.1 互换得来
    for (const match of store.matchAll(/\bfetch\s*\(\s*([^,)]+)/g)) {
      expect(match[1].trim()).toMatch(/^`(?:\$\{loopbackOrigin\})?\$\{SELFCHECK_API\}/);
    }
    expect(store).toMatch(
      /hostname === 'localhost' \? '127\.0\.0\.1' : hostname === '127\.0\.0\.1' \? 'localhost' : null;/,
    );
    expect(store).toMatch(
      /const loopbackOrigin = `\$\{location\.protocol\}\/\/\$\{host\}\$\{location\.port \? `:\$\{location\.port\}` : ''\}`;/,
    );
  });
});

describe('红线 C：插件目录的服务端代码不写盘、不跟随链接（§4.6）', () => {
  const serverFiles = load(SERVER_FILES.map((rel) => join(REPO_ROOT, rel)));

  it('三个文件都不出现写盘 / 改名 / 删除 / realpath 等调用', () => {
    const violations = serverFiles.flatMap((f) =>
      findServerWriteIdentifiers(f.text).map((hit) => `${f.rel}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it('plugin-dir.ts 确实在用 lstat / readlink / 只读 open（扫描对象没走样）', () => {
    const dir = serverFiles.find((f) => f.rel === 'server/plugin-dir.ts')!;
    expect(dir.text).toMatch(/\blstat\b/);
    expect(dir.text).toMatch(/\breadlink\b/);
    expect(dir.text).toMatch(/\bopen\([^)]*'r'\)/);
  });
});

describe('扫描器自检：每条判据都会报', () => {
  it('禁止 import：静态、动态、require 与引擎内相对路径都能抓到', () => {
    expect(
      findForbiddenImports(`import { x } from '../stores/settings-store';`, 'src/ui/lib/a.ts'),
    ).toHaveLength(1);
    expect(
      findForbiddenImports(`const m = await import('./api-source-store');`, 'x.ts'),
    ).toHaveLength(1);
    expect(findForbiddenImports(`require("../../core/api/transport")`, 'x.ts')).toHaveLength(1);
    expect(
      findForbiddenImports(`export * from '../api/transport';`, 'src/core/plugins/a.ts'),
    ).toHaveLength(1);
    expect(
      findForbiddenImports(`import type { A } from '../types/types-api';`, 'x.ts'),
    ).toHaveLength(1);
    // 注释里提到模块名不算 import
    expect(findForbiddenImports(`// 与 discord-auth-client 同一口径`, 'x.ts')).toEqual([]);
  });

  it('禁止标识符：整词匹配，抓得到属性访问，不误报更长的名字', () => {
    expect(findForbiddenIdentifiers('settings.apiEndpoints[0]')).toEqual(['apiEndpoints']);
    expect(findForbiddenIdentifiers('window.localStorage.getItem(k)')).toEqual(['localStorage']);
    expect(findForbiddenIdentifiers('const db = indexedDB.open(n)')).toEqual(['indexedDB']);
    expect(findForbiddenIdentifiers('document . cookie')).toEqual(['document.cookie']);
    expect(findForbiddenIdentifiers('const apiKeyLabel = 1')).toEqual([]);
  });

  it('联网原语计数', () => {
    expect(countNetworkPrimitives("fetch('/x'); new WebSocket(u); navigator.sendBeacon(u)")).toBe(
      3,
    );
    expect(countNetworkPrimitives('const impl = options.fetch ?? globalThis.fetch;')).toBe(2);
    expect(countNetworkPrimitives('fetchLocalPlugins()')).toBe(0);
  });

  it('红线 C：写盘调用与带写标志的 open 都能抓到，只读 open 与 readlink 放行', () => {
    expect(findServerWriteIdentifiers('await writeFile(p, b)')).toEqual(['writeFile']);
    expect(findServerWriteIdentifiers('fs.renameSync(a, b)')).toEqual(['rename']);
    expect(findServerWriteIdentifiers('await rm(dir, { recursive: true })')).toEqual(['rm(']);
    expect(findServerWriteIdentifiers('await realpath(p)')).toEqual(['realpath']);
    expect(findServerWriteIdentifiers("import { mkdir } from 'node:fs/promises'")).toEqual([
      'mkdir',
    ]);
    expect(findServerWriteIdentifiers("await open(p, 'w')")).toHaveLength(1);
    expect(findServerWriteIdentifiers("await open(p, 'a+')")).toHaveLength(1);
    expect(findServerWriteIdentifiers('await open(p, flags)')).toHaveLength(1);
    expect(findServerWriteIdentifiers("await open(p, 'r')")).toEqual([]);
    expect(findServerWriteIdentifiers('await open(p)')).toEqual([]);
    expect(findServerWriteIdentifiers('await readlink(p); await lstat(p)')).toEqual([]);
  });
});
