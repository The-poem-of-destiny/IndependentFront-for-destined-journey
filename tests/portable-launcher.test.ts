import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const startBat = readFileSync('scripts/portable/Start.bat', 'utf8');
const readme = readFileSync('scripts/portable/README.txt', 'utf8');
const lines = startBat.split('\r\n');

describe('便携版启动器 Start.bat', () => {
  it('全文使用 CRLF 行尾，没有孤立的 LF', () => {
    expect(startBat).toContain('\r\n');
    expect(startBat).not.toMatch(/(?<!\r)\n/);
  });

  it('注释行（:: 或 rem）一律纯 ASCII', () => {
    const comments = lines.filter((line) => /^(?:::|rem\b)/i.test(line.trim()));
    expect(comments.length).toBeGreaterThan(0);
    for (const line of comments) {
      expect(line).toMatch(/^[\x20-\x7e\t]*$/);
    }
  });

  it('整个文件（含 echo 文本）一律纯 ASCII', () => {
    // echo 是玩家看得见的输出，最容易被顺手写成中文 —— 单独点名一次
    const echoes = lines.filter((line) => /^echo\b/i.test(line.trim()));
    expect(echoes.length).toBeGreaterThan(0);
    for (const line of echoes) {
      expect(line).toMatch(/^[\x20-\x7e\t]*$/);
    }
    lines.forEach((line, i) => {
      expect(line, `第 ${i + 1} 行`).toMatch(/^[\x20-\x7e\t]*$/);
    });
  });

  it('不终止任何进程，也不使用 timeout /t', () => {
    expect(startBat).not.toMatch(/taskkill/i);
    expect(startBat).not.toMatch(/timeout\s+\/t/i);
  });

  it('用自带的 runtime\\node.exe 启动 app\\server.mjs', () => {
    expect(startBat).toContain('runtime\\node.exe');
    expect(startBat).toContain('app\\server.mjs');
  });

  it('不使用括号块，也不切换工作目录', () => {
    const code = lines.filter((line) => !/^(?:::|rem\b)/i.test(line.trim()));
    for (const line of code) {
      expect(line).not.toMatch(/\(\s*$/);
      expect(line.trim()).not.toMatch(/^\)/);
      expect(line.trim()).not.toMatch(/^(?:cd|chdir|pushd)\b/i);
    }
  });
});

describe('便携版使用说明 README.txt', () => {
  it('包含版本号与游戏地址占位符', () => {
    expect(readme).toContain('{{VERSION}}');
    expect(readme).toContain('{{URL}}');
  });
});
