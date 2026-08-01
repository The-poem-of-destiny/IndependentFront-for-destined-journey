/**
 * combat-v3/no-nondeterminism.test.ts — 反非确定性守卫（M0，铁律 1/2）
 *
 * plan §1.3 铁律：
 *   1. combat-v3/ 内禁用 Math.random()
 *   2. combat-v3/ 内禁用 new Function / eval
 *
 * 本测试用 Vite 的 `import.meta.glob` + `?raw` 扫描
 * src/sillytavern/combat-v3/ 下全部 .ts 文件的源码文本
 * （排除 *.test.ts），用正则断言不含上述非确定性构造。
 *
 * 为什么不用 node:fs（参考 SettingsPage.engine-imports.test.ts 注释）：
 *   - 仓库没装 @types/node —— src/** 下 import 'fs' 会让裸 tsc 报 TS2307
 *   - ?raw 的类型由 src/env.d.ts 引的 vite/client 提供，类型就是 string
 *   - 走 import.meta.glob 而不是相对路径算术，文件挪窝也不用改
 *
 * 这是底线保护：即使将来有 ESLint 规则失效或被绕过，本测试仍会红。
 * 排除 *.test.ts 是因为测试代码本身可能需要在错误消息中引用这些构造名做断言。
 */

import { describe, expect, it } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// 用 import.meta.glob 批量加载 combat-v3 下 .ts 源码（eager + raw）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * eager: true —— 模块在测试启动时同步导入（不需 lazy 调用）
 * query: '?raw' —— Vite 把文件作为原始字符串导入（等价于 `import x from '...?raw'`）
 * import: 'default' —— 取 default export（?raw 的 default 就是文件全文）
 *
 * glob 模式 '@engine/combat-v3/(双星号斜杠).ts' 走 tsconfig 已注册的 @engine 别名，
 * 真解析不到时是导入期硬报错，不会静默退化。
 */
const SOURCES: Record<string, string> = import.meta.glob('@engine/combat-v3/**/*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * 过滤出非测试源文件（排除 *.test.ts）。
 *
 * key 形如 '/src/sillytavern/combat-v3/dice-tape.ts' 或 '@engine/combat-v3/...'，
 * 统一取 basename 判断后缀。
 */
function getSourceFiles(): { path: string; content: string }[] {
  const entries: { path: string; content: string }[] = [];
  for (const [path, content] of Object.entries(SOURCES)) {
    // basename 取最后一段
    const basename = path.split(/[/\\]/).pop() ?? path;
    if (basename.endsWith('.test.ts')) continue;
    if (typeof content !== 'string') continue;
    entries.push({ path: basename, content });
  }
  return entries;
}

// ──────────────────────────────────────────────────────────────────────────────
// 禁用模式定义
// ──────────────────────────────────────────────────────────────────────────────

interface ForbiddenPattern {
  /** 规则名（用于错误消息） */
  name: string;
  /** 匹配该模式即违规 */
  regex: RegExp;
  /** 解释为何禁用 */
  reason: string;
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    name: 'Math.random',
    // 匹配 Math.random() 调用（含 .random 后跟可选空格和括号）
    regex: /Math\s*\.\s*random\s*\(/,
    reason: '战斗 v3 必须可重放（架构 §一 1.2 P3 / 铁律 1），所有骰值只能来自 DiceTape',
  },
  {
    name: 'new Function',
    // 匹配 new Function( 构造
    regex: /new\s+Function\s*\(/,
    reason: '战斗 v3 禁止任意 JS 执行（架构 §一 1.6 / 审查报告 C1），改用封闭微文法表达式解释器',
  },
  {
    name: 'eval',
    // 匹配 eval( 调用（前面不能是字母/数字/下划线/点，排除 reevaluate / myeval 等合法标识符）
    regex: /(?<![.\w$])eval\s*\(/,
    reason: '战斗 v3 禁止 eval（架构 §一 1.6 / 审查报告 C1）',
  },
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────────────────

describe('combat-v3 反非确定性守卫（铁律 1/2）', () => {
  const sourceFiles = getSourceFiles();

  it('扫描目录至少包含 dice-tape.ts 源文件（确认 glob 路径正确）', () => {
    // 如果这条断言红了，说明 glob 路径不对或目录还没建
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(sourceFiles.some((f) => f.path === 'dice-tape.ts')).toBe(true);
    expect(sourceFiles.some((f) => f.path === 'types.ts')).toBe(true);
  });

  it('combat-v3 目录内零 Math.random()', () => {
    const violations: string[] = [];
    const pattern = FORBIDDEN_PATTERNS.find((p) => p.name === 'Math.random')!;

    for (const { path, content } of sourceFiles) {
      if (pattern.regex.test(content)) {
        violations.push(path);
      }
    }

    expect(
      violations,
      `发现 Math.random() 的文件: ${violations.join(', ')}。原因: ${pattern.reason}`,
    ).toEqual([]);
  });

  it('combat-v3 目录内零 new Function', () => {
    const violations: string[] = [];
    const pattern = FORBIDDEN_PATTERNS.find((p) => p.name === 'new Function')!;

    for (const { path, content } of sourceFiles) {
      if (pattern.regex.test(content)) {
        violations.push(path);
      }
    }

    expect(
      violations,
      `发现 new Function 的文件: ${violations.join(', ')}。原因: ${pattern.reason}`,
    ).toEqual([]);
  });

  it('combat-v3 目录内零 eval() 调用', () => {
    const violations: string[] = [];
    const pattern = FORBIDDEN_PATTERNS.find((p) => p.name === 'eval')!;

    for (const { path, content } of sourceFiles) {
      if (pattern.regex.test(content)) {
        violations.push(path);
      }
    }

    expect(
      violations,
      `发现 eval() 的文件: ${violations.join(', ')}。原因: ${pattern.reason}`,
    ).toEqual([]);
  });

  it('扫描结果排除 *.test.ts（本文件自身不被扫描）', () => {
    const basenames = sourceFiles.map((f) => f.path);
    expect(basenames).not.toContain('no-nondeterminism.test.ts');
    expect(basenames).not.toContain('dice-tape.test.ts');
  });
});
