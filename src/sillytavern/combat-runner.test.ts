/**
 * combat-runner 测试 (M4 战斗 v2 · 任务 5.2)
 *
 * 验证 runCombat 的主流程: <combat_summary> 解析 / outcome 推断 / 兜底。
 * 工具调用链路（executeCombatToolCall）由 agent-tools.test.ts 覆盖；
 * LLM 真实行为（agent 调工具 + 叙事）留 M6 真机验证。
 */

import { describe, it, expect, vi } from 'vitest';
import { runCombat } from './combat-runner';
import type { CombatClient, CombatRunRequest, CombatRunDeps } from './combat-runner';

// ========== Mock 工厂 ==========

/** 造一个 chatWithTools 永远返回固定 output 的 mock client（不调工具，纯测 runCombat 主流程） */
function makeMockClient(output: string): CombatClient {
  const result = { output, rawResponse: output, tokensUsed: 100, cacheHit: false, duration: 10 };
  return {
    chatWithTools: vi.fn(async () => result),
    chat: vi.fn(async () => result),
  };
}

const baseRequest = {
  saveId: 'test-save',
  marker: {
    type: 'combat_trigger' as const,
    combatType: '标准',
    environment: '森林',
    bodyText: '英雄遭遇哥布林',
    rawContent: '<combat_trigger>战斗</combat_trigger>',
    position: 0,
  },
  storyOutput: '英雄走进森林，一只哥布林跳了出来。',
  context: { characters: [], variables: {}, agentOutputs: new Map() } as any,
  endpoint: {} as any,
};

function makeDeps(client: CombatClient): CombatRunDeps {
  return {
    clientFactory: () => client,
    // mock EventBus：emitChain 无订阅者时原样返回 params
    eventBus: { emitChain: vi.fn(async (_e: string, p: any) => p) } as any,
    characters: [],
  };
}

// ========== Tests ==========

describe('combat-runner', () => {
  it('解析 <combat_summary> 并返回 CombatSummaryResult', async () => {
    const client = makeMockClient(
      '英雄挥剑斩向哥布林…\n<combat_summary>我方获胜，英雄击败了哥布林，获得 50 EXP。</combat_summary>',
    );
    const result = await runCombat(baseRequest as any, makeDeps(client));

    expect(result.narrativeSummary).toContain('我方获胜');
    expect(result.narrativeSummary).toContain('击败了哥布林');
    expect(result.outcome).toBe('ally_win');
    expect(result.rounds).toBe(1);
  });

  it('敌方获胜判定', async () => {
    const client = makeMockClient('<combat_summary>英雄战败，全军覆没。</combat_summary>');
    const result = await runCombat(baseRequest as any, makeDeps(client));
    expect(result.outcome).toBe('enemy_win');
  });

  it('逃跑判定', async () => {
    const client = makeMockClient('<combat_summary>英雄见势不妙，成功逃脱。</combat_summary>');
    const result = await runCombat(baseRequest as any, makeDeps(client));
    expect(result.outcome).toBe('fled');
  });

  it('平局兜底（摘要无明确胜负）', async () => {
    const client = makeMockClient('<combat_summary>双方暂时停手，各自后撤。</combat_summary>');
    const result = await runCombat(baseRequest as any, makeDeps(client));
    expect(result.outcome).toBe('draw');
  });

  it('未生成 <combat_summary> 时走兜底（循环达上限）', async () => {
    // mock client 永远不输出 summary → runCombat 循环 MAX_TURNS 后兜底退出
    const client = makeMockClient('战斗还在继续，英雄与哥布林缠斗不休…');
    const result = await runCombat(baseRequest as any, makeDeps(client));
    expect(result.narrativeSummary).toContain('战斗结束（未生成摘要）');
    expect(result.outcome).toBe('draw');
    // 确实循环了多轮（每轮 push assistant + user 反馈）
    expect(client.chatWithTools).toHaveBeenCalled();
  });

  it('client 不支持 chatWithTools 时抛错', async () => {
    const brokenClient: CombatClient = {
      chat: vi.fn(async () => ({ output: 'x', rawResponse: '', tokensUsed: 0, cacheHit: false, duration: 0 })),
      // 无 chatWithTools
    };
    await expect(runCombat(baseRequest as any, makeDeps(brokenClient))).rejects.toThrow(/chatWithTools/);
  });
});
