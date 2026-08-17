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

  /**
   * 明确豁免本闸门的 agent（**只能减不能加**：往这里塞名字等于放弃对该 agent 的管辖）。
   *
   * `vars_update`：它有工具白名单，但出厂提示词刻意不列「可用工具」小节 —— 工具由引擎侧
   * 直接喂给它，不教模型点名调用。若哪天给它加了小节，把它从这里删掉即可自动纳管。
   */
  const EXCLUDED_AGENTS = new Set(['vars_update']);

  /**
   * 受本闸门管辖的 agent **从 `AGENT_TOOL_MAP` 派生**：白名单非空 - 显式豁免。
   *
   * 🔴 两层历史教训叠在这一段上：
   * 1. 最早是 `if (!prompt.includes('可用工具')) continue;` —— 用例在这行之后才注册，
   *    于是把小节标题改个措辞（「可用工具」→「工具列表」）就会让该 agent 的用例**根本不生成**，
   *    用例数从 4 掉到 3，CI 照绿。闸门自己成了「不红但坏」的东西，而它守的正是这类故障。
   * 2. 改成硬编码名单后又留了第二个静默口子：**新 agent 拿到工具白名单却没人想起改这里**，
   *    它的提示词从此不受任何约束。派生之后，加白名单 = 自动纳管；要不管必须**显式**写进
   *    `EXCLUDED_AGENTS` 并留下理由。
   */
  const TOOL_ADVERTISING_AGENTS = Object.keys(AGENT_TOOL_MAP)
    .filter((id) => (AGENT_TOOL_MAP[id] ?? []).length > 0 && !EXCLUDED_AGENTS.has(id))
    .sort();

  it('受管辖的 agent 名单必须非空且都存在于 agent-config.json（闸门自身的存活断言）', () => {
    expect(TOOL_ADVERTISING_AGENTS.length).toBeGreaterThan(0);
    for (const agentId of TOOL_ADVERTISING_AGENTS) {
      expect(Object.keys(cfg.agents), `agent-config.json 里没有「${agentId}」`).toContain(agentId);
    }
  });

  it('豁免名单里的 agent 必须真的存在于 AGENT_TOOL_MAP（防止陈旧豁免变成永久免管）', () => {
    // agent 改名/删除后，留在这里的旧名字不会报错、只会静默地什么都不豁免；
    // 而真正危险的是反过来——新名字没人加进来，却以为「已经豁免过了」。
    for (const agentId of EXCLUDED_AGENTS) {
      expect(
        Object.keys(AGENT_TOOL_MAP),
        `EXCLUDED_AGENTS 里的「${agentId}」在 AGENT_TOOL_MAP 中不存在，豁免已陈旧`,
      ).toContain(agentId);
    }
  });

  for (const agentId of TOOL_ADVERTISING_AGENTS) {
    it(`${agentId}: 提示词列出的工具必须都在 AGENT_TOOL_MAP 白名单内`, () => {
      const prompt = cfg.agents[agentId]?.systemPrompt ?? '';
      expect(prompt.length, `「${agentId}」的 systemPrompt 为空`).toBeGreaterThan(0);
      // 措辞漂移必须在这里变红，而不是静默少生成一条用例
      expect(
        prompt,
        `「${agentId}」有工具白名单，但提示词里找不到「可用工具」小节 —— ` +
          `要么小节标题被改了措辞（请同步本闸门的提取逻辑），要么工具广告被误删`,
      ).toContain('可用工具');
      const whitelist = AGENT_TOOL_MAP[agentId] ?? [];
      const advertised = advertisedTools(prompt);
      expect(advertised.length).toBeGreaterThan(0);
      for (const name of advertised) {
        expect(whitelist, `「${agentId}」提示词广告了白名单外的工具 ${name}`).toContain(name);
      }
    });
  }
});
