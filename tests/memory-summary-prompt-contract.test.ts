import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 出厂 memory_summary 默认 prompt 与解析器契约对齐（真机 bug 回归：2026-08-07）
 *
 * 背景：开局（剧情事件/时间为空）时，旧默认 systemPrompt 教模型
 * 「hiddenLine 必须留空」，而 `parseMemorySummaryOutput`（memory-summarizer.ts）
 * 要求 hiddenLine 非空（Q-03 裁定：hiddenLine 缺失不落库，记忆宁缺毋滥）——
 * 模型照做 → 整条记忆被弃，症状是「游戏过了 N 轮，记忆库里只有 1 条」。
 *
 * 解析器侧的严格是刻意的裁定，**回归的必须是默认 prompt**：它只能教模型
 * 写非空兜底句（「当前世界暂无明显幕后动向」之类），绝不能教它留空。
 *
 * 住 `tests/` 而非 `src/` 的理由：主 tsconfig 是 `"types": []`，`node:fs`
 * 在 src 里会挂 `tsc --noEmit`；这里与 encoding-invariants.test.ts 同属
 * 仓库级契约闸门。
 */
describe('出厂 memory_summary 默认 prompt 与解析器契约对齐', () => {
  function defaultMemorySummaryPrompt(): string {
    const raw = readFileSync('public/data/defaults/agent-config.json', 'utf8');
    const cfg = JSON.parse(raw) as { agents: Record<string, { systemPrompt?: string }> };
    return cfg.agents.memory_summary?.systemPrompt ?? '';
  }

  it('不得教模型把 hiddenLine 留空（空串会被解析器弃掉整条记忆）', () => {
    const prompt = defaultMemorySummaryPrompt();
    expect(prompt).not.toMatch(/hiddenLine[^\n]{0,12}留空/);
    expect(prompt).not.toContain('必须留空');
  });

  it('必须要求 hiddenLine 非空（含事件/时间为空时的兜底指引）', () => {
    const prompt = defaultMemorySummaryPrompt();
    expect(prompt).toContain('hiddenLine 必须是非空字符串');
    expect(prompt).toMatch(/兜底/);
  });
});
