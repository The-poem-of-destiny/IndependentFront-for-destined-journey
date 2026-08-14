/**
 * 开发启动器分发器 —— `npm run dev` 的唯一入口，按平台转发到对应的启动器。
 *
 *   Windows       → dev.bat（cmd 专属：注释纯 ASCII / netstat 三细节 / CRLF）
 *   macOS / Linux → dev.sh （POSIX 孪生实现，行为一致）
 *
 * 两个启动器的行为约定与踩坑记录都在 docs/reference/dev-bat-notes.md。
 *
 * 为什么要这一层：package.json 的 `"dev": "dev.bat"` 在 macOS 上直接找不到命令，
 * 而 npm 没有「按平台选 script」的机制。分发放在 node 里是唯一不引依赖的写法。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);

// Windows 必须经 cmd.exe 调 .bat：Node 18 起 spawn 不再直接执行 .bat/.cmd
// （CVE-2024-27980），而 `shell: true` 又会多套一层引号解析。显式 `cmd /c` 两头都避开。
// POSIX 侧显式用 `bash` 调用而不是 `./dev.sh`，这样即使可执行位在
// Windows 检出里丢失（core.filemode=false 是常态），Mac 上也照样能跑。
const [command, commandArgs] =
  process.platform === 'win32'
    ? [process.env.COMSPEC || 'cmd.exe', ['/c', join(ROOT, 'dev.bat'), ...args]]
    : ['bash', [join(ROOT, 'dev.sh'), ...args]];

const child = spawn(command, commandArgs, { stdio: 'inherit', cwd: ROOT });

// Ctrl+C 在终端里会同时投递给整个进程组，子进程自己收得到；这里把父进程的
// 默认处理换成空操作，免得父进程先退、把还在收尾的 Vite 变成孤儿。
process.on('SIGINT', () => {});

child.on('error', (err) => {
  console.error(`[dev] 启动失败: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
