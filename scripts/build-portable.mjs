/**
 * Windows 便携版（portable zip）打包脚本 —— `npm run release:portable`。
 *
 * 产物：`release/narrative-engine-v<版本>-win-x64.zip`，解压后布局：
 *
 *   narrative-engine-v<版本>-win-x64/
 *     Start.bat                 启动器（scripts/portable/Start.bat 原样）
 *     使用说明.txt               scripts/portable/README.txt 填好占位符，CRLF + UTF-8 BOM
 *     THIRD-PARTY-NOTICES.md
 *     runtime/node.exe          当前运行本脚本的 node（process.execPath）
 *     runtime/NODE-LICENSE.txt
 *     app/server.mjs            server/standalone.ts 经 Vite SSR 打成的单文件
 *     app/config.json           { packServerUrl }
 *     app/build-info.json       { version, node, commit, dirty, builtAt }
 *     app/licenses/             服务端打进 server.mjs 的依赖许可证
 *     app/web/**                前端构建产物
 *
 * 用法：
 *   node scripts/build-portable.mjs --pack-server-url https://packs.example.com
 *   POEM_PACK_SERVER_URL=https://packs.example.com node scripts/build-portable.mjs
 *   node scripts/build-portable.mjs --no-pack-server      不配置内容中心服（内容包功能不可用）
 *
 * 🔴 只在 Windows x64 上跑：zip 里的 node.exe 就是本机这个 node，跨平台打出来的包不能用。
 * 🔴 前端产物里绝不能烧进 VITE_PACK_SERVER_URL：便携版的中心服地址只走 app/config.json，
 *    由本地 BFF 读取；两处都配会出现「前端直连 + BFF 代理」两套来源，见 discord-auth-client.ts。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RELEASE_DIR = join(REPO, 'release');
const STAGING_DIR = join(RELEASE_DIR, 'staging');

/** 与 server/standalone-app.ts 的 STANDALONE_ORIGIN 一致（.mjs 无法直接 import TS，这里抄一份） */
const PORTABLE_URL = 'http://127.0.0.1:15173/';

/** 前端构建用的 Vite mode；.env 守卫按同一个 mode 用 loadEnv 判断 */
const WEB_BUILD_MODE = 'production';

/** 服务端打进 server.mjs 的第三方依赖：许可证随包分发 */
const SERVER_BUNDLED_DEPS = ['hono', '@hono/node-server'];

/** 本身已压缩的格式：再 deflate 只浪费时间，体积几乎不降 */
const STORE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'flac',
  'mp4',
  'webm',
  'woff',
  'woff2',
  'zip',
  'gz',
  'br',
  '7z',
]);

/** 开发启动器（仓库根的 dev.bat / dev.sh / dev.local.bat / update.bat 与 scripts/dev.mjs），绝不能进便携包 */
const DEV_LAUNCHER_NAMES = new Set(['dev.bat', 'dev.sh', 'dev.local.bat', 'dev.mjs', 'update.bat']);

/** 返回 zip 条目名里命中开发启动器的那些（按文件名比对，大小写不敏感） */
export function findDevLaunchers(names) {
  return names.filter((name) => DEV_LAUNCHER_NAMES.has(name.split('/').pop().toLowerCase()));
}

/** 按文件名判断 zip 条目用 store（不压缩）还是 deflate */
export function shouldStore(name) {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return STORE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function waitDrain(stream) {
  return new Promise((resolveDrain, rejectDrain) => {
    const onDrain = () => {
      stream.off('error', onError);
      resolveDrain();
    };
    const onError = (err) => {
      stream.off('drain', onDrain);
      rejectDrain(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

/**
 * 流式写 zip：条目逐个顺序处理，每喂一块数据就检查写流背压，内存占用与包体积无关。
 * 文件名按 UTF-8 写入（fflate 遇到非 ASCII 名字会自动置通用标志位 bit 11）。
 *
 * @param {string} outFile 输出 zip 路径
 * @param {Array<{ name: string; file: string }>} entries name 为 zip 内路径（用 `/` 分隔），file 为磁盘源文件
 */
export async function writeZip(outFile, entries) {
  mkdirSync(dirname(outFile), { recursive: true });
  const out = createWriteStream(outFile);
  let needDrain = false;
  let zipError = null;
  let finished = false;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      return;
    }
    if (!out.write(chunk)) needDrain = true;
    if (final) finished = true;
  });
  const flush = async () => {
    if (zipError) throw zipError;
    if (needDrain) {
      needDrain = false;
      await waitDrain(out);
    }
  };

  try {
    for (const entry of entries) {
      const file = shouldStore(entry.name)
        ? new ZipPassThrough(entry.name)
        : new ZipDeflate(entry.name, { level: 9 });
      file.mtime = statSync(entry.file).mtime;
      zip.add(file);
      const input = createReadStream(entry.file);
      let pending = null;
      for await (const chunk of input) {
        // 推前一块、留最后一块：最后一块要带 final 标志
        if (pending) {
          file.push(pending);
          await flush();
        }
        pending = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      file.push(pending ?? new Uint8Array(0), true);
      await flush();
    }
    zip.end();
    await flush();
    if (!finished) throw new Error('zip 未正常收尾');
  } catch (err) {
    out.destroy();
    throw err;
  }
  await new Promise((resolveEnd, rejectEnd) => {
    out.once('error', rejectEnd);
    out.end(resolveEnd);
  });
}

/**
 * 解析 `git ls-files -z ...` 的输出：按 NUL 切分，丢掉末尾空串。
 * 不 trim —— 文件名本身可以带首尾空格。
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parseNulSeparated(output) {
  return output.split('\0').filter((entry) => entry !== '');
}

/**
 * 把 `git ls-files -z --others --ignored --exclude-standard -- public`（在仓库根执行）的输出
 * 映射成 web 产物目录里的对应路径；不在 `public/` 下的条目忽略。纯函数，不碰磁盘。
 *
 * @param {string} webDir 前端产物目录（Vite 把 public/ 原样复制到这里）
 * @param {string} gitOutput
 * @returns {string[]}
 */
export function ignoredPublicTargets(webDir, gitOutput) {
  const targets = [];
  for (const rel of parseNulSeparated(gitOutput)) {
    if (!rel.startsWith('public/')) continue;
    targets.push(join(webDir, ...rel.slice('public/'.length).split('/')));
  }
  return targets;
}

/**
 * 从 web 产物里删掉 git 忽略的 public/ 文件，返回实际删除的个数。
 *
 * @param {string} webDir
 * @param {string} gitOutput `git ls-files -z ...` 的原始输出
 * @returns {number}
 */
export function stripIgnoredPublicFiles(webDir, gitOutput) {
  let removed = 0;
  for (const target of ignoredPublicTargets(webDir, gitOutput)) {
    if (existsSync(target)) {
      rmSync(target, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * 用 Vite 自己的 `loadEnv` 找出各 mode 下会被注入前端的 `VITE_PACK_SERVER_URL`。
 * 与 Vite 读 `.env` / `.env.local` / `.env.[mode]` / `.env.[mode].local` 与 `process.env`
 * 的规则完全一致（含 `KEY: value` 写法），不自己抄一份正则。
 *
 * @param {string} root envDir（本仓 vite.config.ts 未设 envDir，即仓库根）
 * @param {string[]} modes
 * @returns {Promise<Array<{ mode: string; value: string }>>}
 */
export async function findPackServerEnv(root, modes) {
  const { loadEnv } = await import('vite');
  const found = [];
  for (const mode of modes) {
    const value = loadEnv(mode, root, 'VITE_').VITE_PACK_SERVER_URL;
    if (typeof value === 'string' && value.trim() !== '') found.push({ mode, value });
  }
  return found;
}

/**
 * 在构建产物里找包含任一字符串的文件（只看 .js / .mjs / .html）。返回命中的文件路径。
 *
 * @param {string[]} files 绝对路径列表
 * @param {string[]} needles
 * @returns {string[]}
 */
export function filesContaining(files, needles) {
  const wanted = needles.filter((n) => n.trim() !== '');
  if (wanted.length === 0) return [];
  return files.filter((file) => {
    if (!/\.(?:m?js|html)$/i.test(file)) return false;
    const text = readFileSync(file, 'utf8');
    return wanted.some((needle) => text.includes(needle));
  });
}

// ---------------------------------------------------------------------------
// 以下只在直接执行时用到
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[便携版打包] ${message}`);
}

function parseArgs(argv) {
  const args = { packServerUrl: undefined, noPackServer: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-pack-server') args.noPackServer = true;
    else if (arg === '--pack-server-url') {
      args.packServerUrl = argv[++i];
      if (args.packServerUrl === undefined) fail('--pack-server-url 缺少参数值');
    } else if (arg.startsWith('--pack-server-url=')) {
      args.packServerUrl = arg.slice('--pack-server-url='.length);
    } else fail(`未知参数：${arg}`);
  }
  return args;
}

/** 校验规则与 server/content-pack-release.ts 的 resolvePackServerUrl 一致 */
function validatePackServerUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail(`内容中心服地址不是合法 URL：${raw}`);
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    fail(`内容中心服地址必须为 HTTPS origin（仅本机回环允许 HTTP）：${raw}`);
  }
  return url.origin;
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkPreconditions(args) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail(
      `便携版只能在 Windows x64 上打包（zip 内的 node.exe 取自当前 node），当前是 ${process.platform}-${process.arch}`,
    );
  }

  const nvmrcPath = join(REPO, '.nvmrc');
  if (existsSync(nvmrcPath)) {
    const wanted = readFileSync(nvmrcPath, 'utf8').trim();
    if (compareVersions(process.version, wanted) < 0) {
      console.warn(
        `⚠️  当前 node ${process.version} 低于 .nvmrc 要求的 ${wanted}；zip 会附带这个较旧的 node.exe。`,
      );
    }
  }

  if (args.noPackServer) {
    if (args.packServerUrl !== undefined)
      fail('--no-pack-server 与 --pack-server-url 不能同时使用');
    return null;
  }
  const raw = args.packServerUrl ?? process.env.POEM_PACK_SERVER_URL;
  if (!raw || raw.trim() === '') {
    fail(
      '缺少内容中心服地址：用 --pack-server-url <origin> 或环境变量 POEM_PACK_SERVER_URL 指定；确实不需要时加 --no-pack-server。',
    );
  }
  return validatePackServerUrl(raw);
}

function git(argv) {
  return execFileSync('git', argv, { cwd: REPO, encoding: 'utf8' });
}

/** 递归列出目录下全部文件（绝对路径） */
function listFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

async function buildWeb(webDir) {
  const { build } = await import('vite');
  await build({
    root: REPO,
    configFile: join(REPO, 'vite.config.ts'),
    mode: WEB_BUILD_MODE,
    logLevel: 'warn',
    build: { outDir: webDir, emptyOutDir: true, sourcemap: false },
  });

  // public/ 里被 git 忽略的文件（本机音频素材等授权未定的东西）不进包。
  // 🔴 必须 -z：默认输出在 core.quotepath=true 时会把中文名转义成带引号的八进制序列，
  //    按行解析就对不上磁盘文件，被忽略的文件会静默进包。
  const ignoredOutput = git([
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    'public',
  ]);
  const removed = stripIgnoredPublicFiles(webDir, ignoredOutput);
  if (removed > 0) log(`已剔除 ${removed} 个 git 忽略的 public/ 文件`);

  const files = listFiles(webDir);
  if (!existsSync(join(webDir, 'index.html'))) fail('前端产物缺少 index.html');
  if (!files.some((f) => f.endsWith('.wasm')))
    fail('前端产物里没有 .wasm（quickjs 沙盒会装载失败）');
  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length > 0) fail(`前端产物里不应有 sourcemap：${maps.slice(0, 5).join(', ')}`);
}

async function buildServer(appDir) {
  const { build } = await import('vite');
  const tmpOut = join(STAGING_DIR, '.ssr');
  await build({
    root: REPO,
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    // 不复制 public/：那是前端静态资源，已在 app/web 里
    publicDir: false,
    build: {
      ssr: join(REPO, 'server', 'standalone.ts'),
      outDir: tmpOut,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: { format: 'es', entryFileNames: 'server.mjs', inlineDynamicImports: true },
      },
    },
    ssr: { noExternal: true, target: 'node' },
  });
  const outputs = listFiles(tmpOut);
  if (outputs.length !== 1 || !outputs[0].endsWith('server.mjs')) {
    fail(`服务端打包应只产出一个 server.mjs，实际：${outputs.map((f) => relative(tmpOut, f))}`);
  }
  const code = readFileSync(outputs[0], 'utf8');
  // 除 node: 内置模块外不允许任何外部导入 —— 便携包里没有 node_modules
  const specifiers = new Set();
  // 静态导入只认行首语句（rollup 输出的 import/export 都在行首），避免误报 JSDoc 示例里的 `import ... from 'hono'`
  const patterns = [
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.add(match[1]);
  }
  const external = [...specifiers].filter((s) => !s.startsWith('node:'));
  if (external.length > 0) fail(`server.mjs 仍有非 node: 的外部导入：${external.join(', ')}`);
  copyFileSync(outputs[0], join(appDir, 'server.mjs'));
  rmSync(tmpOut, { recursive: true, force: true });
}

async function copyNodeRuntime(runtimeDir) {
  copyFileSync(process.execPath, join(runtimeDir, 'node.exe'));
  const target = join(runtimeDir, 'NODE-LICENSE.txt');
  const local = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(local)) {
    copyFileSync(local, target);
    return;
  }
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  log(`node 安装目录没有 LICENSE，从 ${url} 获取`);
  let text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    fail(
      `拿不到 Node.js 许可证（${err instanceof Error ? err.message : String(err)}），不能分发 node.exe`,
    );
  }
  if (!text.includes('Node.js')) fail('下载到的 Node.js LICENSE 内容不对');
  writeFileSync(target, text);
}

function readPackageJson(name) {
  return JSON.parse(readFileSync(join(REPO, 'node_modules', name, 'package.json'), 'utf8'));
}

function copyServerLicenses(licensesDir) {
  const rows = [];
  for (const name of SERVER_BUNDLED_DEPS) {
    const pkgDir = join(REPO, 'node_modules', name);
    const licenseFile = readdirSync(pkgDir).find((f) => /^licen[sc]e(\.|$)/i.test(f));
    if (!licenseFile) fail(`${name} 没有 LICENSE 文件`);
    const outName = `${name.replace('/', '__')}-LICENSE.txt`;
    copyFileSync(join(pkgDir, licenseFile), join(licensesDir, outName));
    const pkg = readPackageJson(name);
    rows.push({
      name,
      version: pkg.version,
      license: pkg.license,
      file: `app/licenses/${outName}`,
    });
  }
  return rows;
}

function writeNotices(rootDir, serverRows, packageJson) {
  const webDeps = Object.keys(packageJson.dependencies ?? {})
    .filter((name) => !SERVER_BUNDLED_DEPS.includes(name))
    .sort()
    .map((name) => {
      const pkg = readPackageJson(name);
      const license = typeof pkg.license === 'string' ? pkg.license : '见上游仓库';
      return `| ${name} | ${pkg.version} | ${license} |`;
    });
  const lines = [
    '# 第三方组件声明',
    '',
    '本便携版包含以下第三方软件。各组件版权归其各自作者所有。',
    '',
    '## 运行环境',
    '',
    `- **Node.js ${process.version}**（\`runtime/node.exe\`）—— 许可证全文见 \`runtime/NODE-LICENSE.txt\`。`,
    '',
    '## 本地服务（打包进 `app/server.mjs`）',
    '',
    '| 组件 | 版本 | 许可证 | 全文 |',
    '| --- | --- | --- | --- |',
    ...serverRows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | \`${r.file}\` |`),
    '',
    '## 前端（打包进 `app/web/`）',
    '',
    '| 组件 | 版本 | 许可证 |',
    '| --- | --- | --- |',
    ...webDeps,
    '',
  ];
  writeFileSync(join(rootDir, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'));
}

function writeReadme(rootDir, version) {
  const template = readFileSync(join(HERE, 'portable', 'README.txt'), 'utf8');
  const filled = template
    .replaceAll('{{VERSION}}', `v${version}`)
    .replaceAll('{{URL}}', PORTABLE_URL)
    .replace(/\r?\n/g, '\r\n');
  if (filled.includes('{{')) fail('README.txt 还有未填的占位符');
  // 记事本等老程序靠 BOM 认 UTF-8，没有 BOM 中文会乱码
  writeFileSync(join(rootDir, '使用说明.txt'), `\uFEFF${filled}`, 'utf8');
}

function sha256(file) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectHash)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packServerUrl = checkPreconditions(args);
  const packageJson = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const rootName = `narrative-engine-v${version}-win-x64`;
  const zipPath = join(RELEASE_DIR, `${rootName}.zip`);

  rmSync(STAGING_DIR, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  const rootDir = join(STAGING_DIR, rootName);
  const appDir = join(rootDir, 'app');
  const runtimeDir = join(rootDir, 'runtime');
  const licensesDir = join(appDir, 'licenses');
  for (const dir of [appDir, runtimeDir, licensesDir]) mkdirSync(dir, { recursive: true });

  // 开发期 overlay 与前端直连地址都不许漏进发行包（vite.config.ts 加载时读这两个变量）
  const shellPackServerEnv = process.env.VITE_PACK_SERVER_URL;
  delete process.env.POEM_CONTENT_DIR;
  delete process.env.VITE_PACK_SERVER_URL;

  // Vite 会把 .env* 里的 VITE_PACK_SERVER_URL 烧进前端产物：用 Vite 自己的 loadEnv 判，
  // 前端构建用的是 production mode —— 这个 mode 下读得到就拒绝打包。
  const envHits = await findPackServerEnv(REPO, [WEB_BUILD_MODE]);
  if (envHits.length > 0) {
    fail(
      `仓库根的 .env* 在 ${envHits.map((h) => h.mode).join(', ')} mode 下定义了 VITE_PACK_SERVER_URL，会被烧进前端产物。便携版的中心服地址只走 app/config.json，请先移除该定义。`,
    );
  }
  // 其他 mode（.env.development 等）与 shell 里的值本不该进 production 产物；构建后再扫一遍产物兜底
  const leakNeedles = [
    ...(await findPackServerEnv(REPO, ['development'])).map((h) => h.value),
    ...(shellPackServerEnv ? [shellPackServerEnv] : []),
  ];

  log('构建前端…');
  await buildWeb(join(appDir, 'web'));
  if (leakNeedles.length > 0) {
    const leaked = filesContaining(listFiles(join(appDir, 'web')), leakNeedles);
    if (leaked.length > 0) {
      fail(
        `前端产物里出现了 VITE_PACK_SERVER_URL 的值：${leaked.map((f) => relative(REPO, f)).join(', ')}`,
      );
    }
  }
  log('打包服务端…');
  await buildServer(appDir);
  log('复制运行环境与许可证…');
  await copyNodeRuntime(runtimeDir);
  const serverRows = copyServerLicenses(licensesDir);
  writeNotices(rootDir, serverRows, packageJson);
  copyFileSync(join(HERE, 'portable', 'Start.bat'), join(rootDir, 'Start.bat'));
  writeReadme(rootDir, version);

  writeFileSync(join(appDir, 'config.json'), `${JSON.stringify({ packServerUrl }, null, 2)}\n`);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim() !== '';
  writeFileSync(
    join(appDir, 'build-info.json'),
    `${JSON.stringify(
      { version, node: process.version, commit, dirty, builtAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );

  log('压缩…');
  const files = listFiles(rootDir).sort();
  const entries = files.map((file) => ({
    name: relative(STAGING_DIR, file).split(sep).join('/'),
    file,
  }));
  const devHits = findDevLaunchers(entries.map((e) => e.name));
  if (devHits.length > 0) fail(`便携包里混进了开发启动器：${devHits.join(', ')}`);
  await writeZip(zipPath, entries);

  const size = statSync(zipPath).size;
  log(`完成：${relative(REPO, zipPath)}`);
  log(`文件数：${entries.length}`);
  log(`大小：${(size / 1024 / 1024).toFixed(1)} MiB（${size} 字节）`);
  const digest = await sha256(zipPath);
  log(`SHA-256：${digest}`);
  if (dirty) console.warn('⚠️  工作区有未提交改动，build-info.json 已标记 dirty: true。');
}

// 只有直接执行时才跑；被测试 import 时不跑。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
