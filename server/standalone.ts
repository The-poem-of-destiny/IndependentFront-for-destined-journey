/**
 * 便携版独立服务器的副作用入口：`Start.bat` → 自带 node.exe → `app/server.mjs`（本文件打包产物）。
 *
 * 职责只有进程层面的事：定位 web 目录、读可选 config.json、监听固定端口、开浏览器、
 * 端口冲突时给中文指引。请求怎么处理全在 `standalone-app.ts`。
 *
 * 🔴 保持纯 node 可运行：后续会被 Vite SSR（ssr.noExternal）打成单个 server.mjs，
 *    这里不能依赖 vite / 开发期才有的任何东西。
 * 🔴 端口被占时**绝不结束任何进程** —— 占用者可能是玩家别的程序。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import {
  buildStandaloneApp,
  probeExistingInstance,
  STANDALONE_BIND,
  STANDALONE_ORIGIN,
  STANDALONE_PORT,
} from './standalone-app';

interface PortableConfig {
  packServerUrl?: string;
}

const appDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(appDir, 'web');
const shouldOpenBrowser = !process.argv.includes('--no-open');

/**
 * 本程序版本：取同目录 `build-info.json`（打包脚本写入）的 version。
 * 缺失或损坏时退回 `unknown` —— 只影响「已在运行」探测的版本比较，不阻止启动。
 */
function readEngineVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(appDir, 'build-info.json'), 'utf8'));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 同目录 config.json 可选；缺失或坏 JSON 都按「无配置」处理，不阻止启动 */
function readPortableConfig(): PortableConfig {
  let raw: string;
  try {
    raw = readFileSync(join(appDir, 'config.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PortableConfig) : {};
  } catch {
    console.warn('[便携版] config.json 不是合法 JSON，已忽略。');
    return {};
  }
}

function openBrowser(url: string): void {
  if (!shouldOpenBrowser) return;
  // `start` 的第一个带引号参数是窗口标题，所以先给一个空标题 `""`；
  // windowsVerbatimArguments 防止 node 把 `""` 再转义一遍
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '""', url], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.on('error', () => {
    console.log(`[便携版] 未能自动打开浏览器，请手动访问 ${url}`);
  });
  child.unref();
}

const config = readPortableConfig();
if (typeof config.packServerUrl === 'string' && config.packServerUrl.trim() !== '') {
  process.env.POEM_PACK_SERVER_URL ??= config.packServerUrl;
}

const engineVersion = readEngineVersion();
const app = buildStandaloneApp({ webRoot, engineVersion });
const server = createAdaptorServer({ fetch: app.fetch, hostname: STANDALONE_BIND });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('[便携版] 服务器启动失败：', err);
    process.exit(1);
  }
  void probeExistingInstance(STANDALONE_ORIGIN, engineVersion).then((result) => {
    if (result === 'ours') {
      console.log(`[便携版] 已在运行：${STANDALONE_ORIGIN}，正在打开浏览器。`);
      openBrowser(`${STANDALONE_ORIGIN}/`);
      process.exit(0);
    }
    if (result === 'ours-other-version') {
      // 不开浏览器：开了玩家看到的是旧版本，会误以为升级没生效
      console.error(
        [
          `[便携版] 已有另一个版本（较旧或不同的版本）正在运行，占用了端口 ${STANDALONE_PORT}。`,
          `当前要启动的版本：${engineVersion}`,
          '请先关闭那个版本的黑色命令行窗口，然后重新运行本目录下的 Start.bat。',
        ].join('\n'),
      );
      process.exit(1);
    }
    console.error(
      [
        `[便携版] 端口 ${STANDALONE_PORT} 已被其他程序占用，无法启动。`,
        '请关闭占用该端口的程序后重试。可在命令提示符中运行以下命令查看占用者的 PID：',
        `  netstat -ano | findstr :${STANDALONE_PORT}`,
        '然后在任务管理器「详细信息」页按 PID 找到对应程序。',
      ].join('\n'),
    );
    process.exit(1);
  });
});

server.listen(STANDALONE_PORT, STANDALONE_BIND, () => {
  console.log(`[便携版] 已启动：${STANDALONE_ORIGIN}/  （关闭此窗口即退出）`);
  openBrowser(`${STANDALONE_ORIGIN}/`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[便携版] 正在退出…');
  server.close(() => process.exit(0));
  // 有长连接（流式响应）时 close 会一直等，兜底强退
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
