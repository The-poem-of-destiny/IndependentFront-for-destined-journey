import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('源码与自动化测试分离', () => {
  it('src 不包含自动化测试、测试目录或 Vitest 初始化文件', () => {
    const files = readdirSync(resolve(__dirname, '../src'), { recursive: true }) as string[];
    const misplaced = files.filter(
      (file) =>
        /\.test\.(ts|tsx|js)$/.test(file) ||
        /(?:^|[/\\])(?:__tests__|fixtures)(?:[/\\]|$)/.test(file) ||
        file === 'test-setup.ts',
    );
    expect(misplaced).toEqual([]);
  });

  it('引擎根目录仅保留公共入口和指令文件', () => {
    const files = readdirSync(resolve(__dirname, '../src/core'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    expect(files).toEqual(['AGENTS.md', 'CLAUDE.md', 'index.ts']);
  });
});
