import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_MAP } from '../src/sillytavern/agent-tools';

/**
 * Agent 默认 prompt 与工具白名单契约（真机 bug 回归：2026-08-08）
 *
 * 背景：旧版 char_gen 提示词把 `call_item_gen` 列为可用工具，而
 * `AGENT_TOOL_MAP.char_gen` 白名单里没有它 —— 模型一调就收到「未知工具」，
 * 随即放弃全部工具、手编随机值（性格编码 `WoAgy(F)` 不符合 wOaGz(A) 格式、
 * 五维/发色/瞳色全靠编）。报错侧已改可行动文案（agent-tools.ts default 分支），
 * 这里防的是**默认提示词再把不存在的工具写进去**。
 *
 * 住 `tests/` 而非 `src/`：主 tsconfig `"types": []`，`node:fs` 在 src 会挂
 * `tsc --noEmit`（与 memory-summary-prompt-contract.test.ts 同款仓库级闸门）。
 */
describe('Agent 默认提示词广告的工具 ⊆ 工具白名单', () => {
  const cfg = JSON.parse(readFileSync('public/data/defaults/agent-config.json', 'utf8')) as {
    agents: Record<string, { systemPrompt?: string }>;
  };

  /** 从提示词「可用工具」小节抠工具名列表。
   *  只抠**小节本身**（到下个空行/标题为止）：工具名是下划线 snake_case
   * （`roll_d20` / `get_character`），但正文里也会出现 `item_gen`（下游 Agent 名）、
   * `cost_type`（字段名）这类同形状的词 —— 截断到小节结尾就能排除它们。
   *  `(?<!<)` 排除 `<skill_requests>` 这类 XML 标签。 */
  function advertisedTools(prompt: string): string[] {
    const start = prompt.indexOf('可用工具');
    if (start < 0) return [];
    const rest = prompt.slice(start);
    const endMatch = rest.match(/\n\s*\n|\n#/);
    const section = endMatch ? rest.slice(0, endMatch.index) : rest;
    const names = new Set<string>();
    for (const m of section.matchAll(/(?<!<)\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      names.add(m[0]);
    }
    return [...names];
  }

  for (const agentId of Object.keys(cfg.agents)) {
    const prompt = cfg.agents[agentId]?.systemPrompt ?? '';
    if (!prompt.includes('可用工具')) continue;

    it(`${agentId}: 提示词列出的工具必须都在 AGENT_TOOL_MAP 白名单内`, () => {
      const whitelist = AGENT_TOOL_MAP[agentId] ?? [];
      const advertised = advertisedTools(prompt);
      expect(advertised.length).toBeGreaterThan(0);
      for (const name of advertised) {
        expect(whitelist, `「${agentId}」提示词广告了白名单外的工具 ${name}`).toContain(name);
      }
    });
  }
});
