/**
 * Windows 便携版 zip 冒烟测试 —— 模拟玩家「解压 → 双击 Start.bat」的真实路径。
 *
 * 用法：node scripts/smoke-portable.mjs release/narrative-engine-v<版本>-win-x64.zip
 *
 * 做的事：
 *   1. 端口 15173 已被占用就直接失败（不碰占用者）。
 *   2. 用系统自带 tar.exe 与 PowerShell Expand-Archive 各解压一份，文件数必须一致
 *      （玩家多半用资源管理器解压，Expand-Archive 与之同源；两者对中文名/UTF-8 标志的处理都要过）。
 *      解压目录故意带空格和中文。
 *   3. 在极简环境（PATH 只剩 System32、没有任何 node）里跑 `cmd /c Start.bat --no-open`，
 *      逐条打 PASS / FAIL。
 *   4. 只结束自己启动的那棵进程树，清理临时目录。任何 FAIL → 退出码 1。
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ORIGIN = 'http://127.0.0.1:15173';
const PORT = 15173;
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const SYSTEM32 = join(SYSTEM_ROOT, 'System32');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function portIsFree() {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolvePort(true)));
  });
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n++;
  }
  return n;
}

function singleRoot(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    die(`解压结果应只有一个顶层目录，实际：${entries.map((e) => e.name).join(', ')}`);
  }
  return join(dir, entries[0].name);
}

/** 玩家机器上的环境：没有 node、没有开发工具，PATH 只剩 System32 */
function minimalEnv() {
  return {
    SystemRoot: SYSTEM_ROOT,
    ComSpec: join(SYSTEM32, 'cmd.exe'),
    PATH: SYSTEM32,
    TEMP: tmpdir(),
    TMP: tmpdir(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${ORIGIN}/api/status`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(250);
  }
  return false;
}

async function runChecks(appWebDir) {
  {
    const res = await fetch(`${ORIGIN}/`);
    const type = res.headers.get('content-type') ?? '';
    check(
      'GET / → 200 text/html',
      res.status === 200 && type.includes('text/html'),
      `${res.status} ${type}`,
    );
  }
  {
    const assetsDir = join(appWebDir, 'assets');
    const wasm = existsSync(assetsDir)
      ? readdirSync(assetsDir).find((f) => f.endsWith('.wasm'))
      : undefined;
    if (!wasm) check('app/web/assets 下有 .wasm', false);
    else {
      const res = await fetch(`${ORIGIN}/assets/${wasm}`);
      const type = res.headers.get('content-type') ?? '';
      const bytes = new Uint8Array(await res.arrayBuffer());
      const magic =
        bytes.length >= 4 &&
        bytes[0] === 0 &&
        bytes[1] === 0x61 &&
        bytes[2] === 0x73 &&
        bytes[3] === 0x6d;
      check(
        `GET /assets/${wasm} → application/wasm 且魔数 \\0asm`,
        res.status === 200 && type.includes('application/wasm') && magic,
        `${res.status} ${type} 前 4 字节 ${Buffer.from(bytes.slice(0, 4)).toString('hex')}`,
      );
    }
  }
  {
    const res = await fetch(`${ORIGIN}/assets/nope.wasm`);
    await res.arrayBuffer();
    check('GET /assets/nope.wasm → 404', res.status === 404, String(res.status));
  }
  {
    const res = await fetch(`${ORIGIN}/api/status`);
    const body = await res.json().catch(() => null);
    check(
      'GET /api/status → ok',
      res.status === 200 && body?.ok === true,
      `${res.status} ${JSON.stringify(body)}`,
    );
  }
  {
    const res = await fetch(`${ORIGIN}/api/nope`);
    const type = res.headers.get('content-type') ?? '';
    const body = await res.json().catch(() => null);
    check(
      'GET /api/nope → 404 JSON',
      res.status === 404 && type.includes('application/json') && body !== null,
      `${res.status} ${type}`,
    );
  }
  {
    const res = await fetch(`${ORIGIN}/api/defaults/x`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await res.arrayBuffer();
    check(
      'PUT /api/defaults/x → 501（便携版无内容目录，不可写）',
      res.status === 501,
      String(res.status),
    );
  }
  {
    const res = await fetch(`${ORIGIN}/api/status`, { headers: { Origin: 'null' } });
    await res.arrayBuffer();
    check('Origin: null 访问 /api/* → 403', res.status === 403, String(res.status));
  }
}

function killTree(pid) {
  spawnSync(join(SYSTEM32, 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
}

async function main() {
  if (process.platform !== 'win32') die('冒烟测试只能在 Windows 上跑');
  const zipArg = process.argv[2];
  if (!zipArg) die('用法：node scripts/smoke-portable.mjs <zip 路径>');
  const zipPath = resolve(zipArg);
  if (!existsSync(zipPath)) die(`找不到 zip：${zipPath}`);
  if (!(await portIsFree()))
    die(`端口 ${PORT} 已被占用，请先关掉占用者再跑冒烟测试（本脚本不会结束任何进程）`);

  // 故意带空格和中文：Start.bat 的 %~dp0 与 node 的路径处理都要扛得住
  const base = join(tmpdir(), `poem smoke 测试-${randomBytes(4).toString('hex')}`);
  const tarDir = join(base, 'tar');
  const psDir = join(base, 'expand-archive');
  mkdirSync(tarDir, { recursive: true });
  mkdirSync(psDir, { recursive: true });

  let server = null;
  try {
    const tar = spawnSync(join(SYSTEM32, 'tar.exe'), ['-xf', zipPath, '-C', tarDir], {
      encoding: 'utf8',
    });
    check('tar.exe 解压成功', tar.status === 0, tar.stderr);
    const ps = spawnSync(
      join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:SMOKE_ZIP -DestinationPath $env:SMOKE_DEST",
      ],
      // 不继承 PSModulePath：从 pwsh 7 里启动时它指向 7.x 的 Archive 模块，5.1 加载后 Expand-Archive 直接报错
      { encoding: 'utf8', env: { ...minimalEnv(), SMOKE_ZIP: zipPath, SMOKE_DEST: psDir } },
    );
    check('Expand-Archive 解压成功', ps.status === 0, ps.stderr);
    if (failures > 0) return;

    const tarRoot = singleRoot(tarDir);
    const psRoot = singleRoot(psDir);
    const tarCount = countFiles(tarRoot);
    const psCount = countFiles(psRoot);
    check(
      `两种解压的文件数一致（${tarCount}）`,
      tarCount === psCount,
      `tar ${tarCount} / Expand-Archive ${psCount}`,
    );
    check(
      '解压出 使用说明.txt（中文文件名）',
      existsSync(join(tarRoot, '使用说明.txt')) && existsSync(join(psRoot, '使用说明.txt')),
    );

    const cmd = join(SYSTEM32, 'cmd.exe');
    const env = minimalEnv();
    let stdout = '';
    let stderr = '';
    // cwd 设在解压根目录（仓库之外），用相对名调 Start.bat，免去 cmd 对带空格中文路径的引号处理
    server = spawn(cmd, ['/c', 'Start.bat', '--no-open'], {
      cwd: tarRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    server.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    const ready = await waitReady(server, 30_000);
    check(
      'Start.bat 启动后 30 秒内就绪',
      ready,
      `退出码 ${server.exitCode} stdout: ${stdout} stderr: ${stderr}`,
    );
    if (!ready) return;

    await runChecks(join(tarRoot, 'app', 'web'));

    const second = spawnSync(cmd, ['/c', 'Start.bat', '--no-open'], {
      cwd: tarRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    check(
      '再次运行 Start.bat → 退出码 0 且提示「已在运行」',
      second.status === 0 && second.stdout.includes('已在运行'),
      `退出码 ${second.status} stdout: ${second.stdout} stderr: ${second.stderr}`,
    );

    check('首个 Start.bat 的 stderr 为空', stderr.trim() === '', stderr);
  } finally {
    if (server && server.exitCode === null && server.pid !== undefined) {
      const exited = new Promise((r) => server.once('exit', r));
      killTree(server.pid);
      await Promise.race([exited, sleep(5000)]);
    }
    // node.exe 退出后句柄释放可能稍晚，带重试
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
