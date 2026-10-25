/**
 * story-context-v2.test.ts — Story 上下文新模式的分区消息组装（计划 §3.1 / §3.1.1，T29/T51/T54）。
 */
import { describe, it, expect } from 'vitest';
import {
  collectCompleteStoryTurns,
  type StoryTurnSummarySegment,
} from '../../../src/core/memory/memory-context';
import {
  storyTurnSource,
  storySegmentFingerprint,
} from '../../../src/core/memory/story-memory-source';
import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  ChatMessage,
  WorldBook,
} from '../../../src/core/types/types';
import { buildStoryContextV2Messages } from '../../../src/core/prompts/story-context-v2';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import { assessStoryContextBudget } from '../../../src/core/story/story-context-mode';
import { storyZoneIdentifier } from '../../../src/core/prompts/story-zone-placeholders';

function zone(n: 1 | 2 | 3 | 4 | 5, order: number) {
  return {
    identifier: storyZoneIdentifier(n),
    name: '',
    content: '',
    enabled: true,
    injection_order: order,
  };
}
function entry(name: string, content: string, order: number, enabled = true) {
  return {
    identifier: `custom_${name}`,
    name,
    content,
    role: 'system',
    enabled,
    injection_order: order,
  };
}

function makePreset(prompts: unknown[]): AgentPreset {
  return {
    id: 'p1',
    name: 'p1',
    fixedSystem: '',
    fixedExamples: '',
    settings: { prompts },
  } as AgentPreset;
}

const storyConfig = {
  agentId: 'story',
  presetId: 'p1',
  worldBookIds: [],
} as unknown as AgentConfig;

let seq = 0;
function msg(role: ChatMessage['role'], content: string, id = `m${++seq}`): ChatMessage {
  return { id, role, content, timestamp: seq };
}

function makeContext(history: ChatMessage[], userInput = '本轮输入'): AgentContext {
  return {
    userInput,
    history,
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map([['plot_pre_check', '去码头']]),
  };
}

function turns(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg('user', `输入${i}`, `u${i}`), msg('assistant', `正文${i}`, `a${i}`));
  }
  return out;
}

async function assemble(
  prompts: unknown[],
  history: ChatMessage[],
  windowTurns = 2,
  segments: StoryTurnSummarySegment[] = [],
) {
  return buildStoryContextV2Messages({
    ctx: makeContext(history),
    configs: [storyConfig],
    worldBooks: [],
    presets: [makePreset(prompts)],
    windowTurns,
    segments,
    archives: [],
  });
}

describe('buildStoryContextV2Messages', () => {
  it('system 只出现在最前；第 4 区原文是真实 user/assistant；末尾一条 user 含本轮输入', async () => {
    const { messages } = await assemble(
      [
        entry('规则', '你是叙事者。', 10),
        zone(1, 20),
        zone(2, 30),
        zone(3, 40),
        entry('文风', '文风要克制。', 50),
        zone(4, 60),
        entry('尾部指令', '按格式输出。', 70),
        zone(5, 80),
      ],
      turns(3),
      2,
    );
    const roles = messages.map((m) => m.role);
    const firstNonSystem = roles.findIndex((r) => r !== 'system');
    expect(roles.slice(0, firstNonSystem).every((r) => r === 'system')).toBe(true);
    expect(roles.slice(firstNonSystem)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages.slice(firstNonSystem, firstNonSystem + 4).map((m) => m.content)).toEqual([
      '输入2',
      '正文2',
      '输入3',
      '正文3',
    ]);
    // 普通条目保留穿插位置：第 4 区之前的进 system，之后的进末尾 user
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('你是叙事者。');
    expect(systemText).toContain('文风要克制。');
    const last = messages[messages.length - 1].content;
    expect(last).toContain('按格式输出。');
    expect(last).toContain('<本轮参考资料>');
    expect(last).toContain('去码头');
    expect(last.endsWith('<玩家输入>\n本轮输入\n</玩家输入>')).toBe(true);
    expect(last.indexOf('按格式输出。')).toBeLessThan(last.indexOf('<本轮参考资料>'));
  });

  it('窗口外回合缺摘要时以原文顶上并写明；有摘要时只给摘要', async () => {
    const result = await assemble([], turns(3), 1, [
      {
        id: 's1',
        ...storyTurnSource(collectCompleteStoryTurns(turns(3))[0]),
        order: 0,
        content: '摘要一',
        eventName: '启程',
      },
    ] as never);
    const system = result.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(system).toContain('- 【启程】摘要一');
    expect(system).toContain('（本回合摘要缺失，以下为原文）');
    expect(system).toContain('玩家：输入2');
    expect(system).not.toContain('正文1'); // 有摘要的回合不再给原文
    expect(result.diagnostics.missingSummaryTurnKeys).toEqual(['u2']);
    expect(result.diagnostics.windowTurnKeys).toEqual(['u3']);
  });

  it('普通条目里归分区负责的旧占位符渲染为空，周围指令保留（T54）', async () => {
    const { messages } = await assemble(
      [entry('旧上下文', '<最近对话>{{NARRATIVE}}</最近对话>请继续{{USER_INPUT}}', 10)],
      turns(2),
      2,
    );
    const all = messages.map((m) => m.content).join('\n');
    expect(all).toContain('<最近对话></最近对话>请继续');
    expect(all.match(/输入1/g)).toHaveLength(1); // 只在第 4 区原文里出现一次
  });

  it('没有预设时退回模板存根作为固定前缀；没有历史时只有 system + 本轮 user', async () => {
    const result = await buildStoryContextV2Messages({
      ctx: makeContext([]),
      configs: [{ agentId: 'story', worldBookIds: [] } as unknown as AgentConfig],
      worldBooks: [],
      presets: [],
      windowTurns: 3,
      segments: [],
      archives: [],
    });
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(result.messages[0].content.length).toBeGreaterThan(0);
  });

  it('第 2 区展示有效归档的年表；被覆盖的摘要退出第 4 区；回退掉的归档不算（D20–D23）', async () => {
    const archive = (id: string, turnKey: string, covered: string[], overview: string) => ({
      id,
      saveId: 's',
      eventName: `事件${id}`,
      outcome: 'abandoned' as const,
      evidence: '原句',
      overview,
      detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
      detailSource: 'summary' as const,
      coveredSegmentIds: covered,
      ...(collectCompleteStoryTurns(turns(3)).find((t) => t.key === turnKey)
        ? storyTurnSource(collectCompleteStoryTurns(turns(3)).find((t) => t.key === turnKey)!)
        : { sourceTurnKey: turnKey, sourceMessageIds: [turnKey, turnKey.replace('u', 'a')] }),
      coveredSources: [storyTurnSource(collectCompleteStoryTurns(turns(3))[0])],
      coveredSegmentFingerprints: {
        s1: storySegmentFingerprint({
          id: 's1',
          sourceTurnKey: 'u1',
          order: 0,
          content: '调查失踪案',
          eventName: '事件1',
        } as StoryTurnSummarySegment),
      },
      sequence: 0,
      createdAt: Number(id),
    });
    const result = await buildStoryContextV2Messages({
      ctx: makeContext(turns(3)),
      configs: [storyConfig],
      worldBooks: [],
      presets: [makePreset([])],
      windowTurns: 1,
      segments: [
        {
          id: 's1',
          ...storyTurnSource(collectCompleteStoryTurns(turns(3))[0]),
          order: 0,
          content: '调查失踪案',
          eventName: '事件1',
        },
        {
          id: 's2',
          ...storyTurnSource(collectCompleteStoryTurns(turns(3))[1]),
          order: 0,
          content: '和店主闲聊',
        },
      ],
      archives: [
        archive('1', 'u2', ['s1'], '在北城调查失踪案，因线索中断放弃'),
        archive('2', 'u9', ['s2'], '一条被回退掉的归档'),
      ],
    });
    const system = result.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(system).toContain('<长期记忆总览>');
    expect(system).toContain('- 【事件1｜放弃】在北城调查失踪案，因线索中断放弃');
    expect(system).not.toContain('一条被回退掉的归档');
    expect(system).not.toContain('【事件1】调查失踪案'); // s1 已被覆盖，退出第 4 区
    expect(system).toContain('- 和店主闲聊'); // s2 的归档无效，仍常驻
    expect(system.indexOf('<长期记忆总览>')).toBeLessThan(system.indexOf('<前情摘要>'));
    expect(result.diagnostics.archiveIds).toEqual(['1']);
  });

  it('开场只有 Story 正文的回合补一个占位输入，保证会话以 user 开头', async () => {
    const { messages } = await assemble([], [msg('assistant', '开场白', 'a0')], 2);
    const convo = messages.filter((m) => m.role !== 'system');
    expect(convo.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(convo[0].content).toBe('（开始）');
  });
});

describe('三种 LLM 协议的最终消息顺序（计划 P3「校验三种协议」）', () => {
  async function v2Messages(history: ChatMessage[]) {
    const { messages } = await assemble(
      [entry('规则', '你是叙事者。', 10), zone(1, 20), zone(4, 60), zone(5, 80)],
      history,
      2,
    );
    return messages;
  }

  it('OpenAI：消息原样发出，前导 system 之后 user / assistant 严格交替并以 user 结尾', async () => {
    const { buildLlmRequest } = await import('../../../src/core/api/llm-adapter');
    const built = buildLlmRequest({
      protocol: 'openai-chat',
      model: 'm',
      messages: await v2Messages(turns(3)),
      maxTokens: 32,
      stream: false,
      userId: 't',
    });
    const roles = (built.body.messages as Array<{ role: string }>).map((m) => m.role);
    const firstNonSystem = roles.findIndex((r) => r !== 'system');
    expect(roles.slice(firstNonSystem)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('Gemini：system 全部收进 systemInstruction，contents 以 user 开头、user / model 交替', async () => {
    const { buildLlmRequest } = await import('../../../src/core/api/llm-adapter');
    for (const history of [turns(3), [msg('assistant', '开场白', 'a0')]]) {
      const built = buildLlmRequest({
        protocol: 'gemini',
        model: 'm',
        messages: await v2Messages(history),
        maxTokens: 32,
        stream: false,
        userId: 't',
      });
      const roles = (built.body.contents as Array<{ role: string }>).map((c) => c.role);
      expect(roles[0]).toBe('user');
      expect(roles[roles.length - 1]).toBe('user');
      roles.forEach((role, i) => expect(role).toBe(i % 2 === 0 ? 'user' : 'model'));
      expect(built.body.systemInstruction).toBeDefined();
    }
  });

  it('Claude：system 进顶层字段，messages 以 user 开头、交替、以 user 结尾', async () => {
    const { buildLlmRequest } = await import('../../../src/core/api/llm-adapter');
    for (const history of [turns(3), [msg('assistant', '开场白', 'a0')]]) {
      const built = buildLlmRequest({
        protocol: 'anthropic-messages',
        model: 'm',
        messages: await v2Messages(history),
        maxTokens: 32,
        stream: false,
        userId: 't',
      });
      const roles = (built.body.messages as Array<{ role: string }>).map((m) => m.role);
      expect(roles[0]).toBe('user');
      expect(roles[roles.length - 1]).toBe('user');
      roles.forEach((role, i) => expect(role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
      expect(typeof built.body.system).toBe('string');
    }
  });
});

describe('A14 完整预算分类与逐项预算移除', () => {
  const loreBook = (): WorldBook => ({
    id: 'budget',
    name: '预算测试',
    partition: 'world_setting',
    entries: [
      {
        uid: 1,
        name: '固定',
        content: '固定世界规则',
        enabled: true,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 1,
        position: 0,
        extra: { lore: { audiences: ['story', 'lore_select'], key: 'fixed', section: 'fixed' } },
      },
      {
        uid: 2,
        name: '区域',
        content: '北城区域资料',
        enabled: true,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 2,
        position: 0,
        extra: {
          lore: {
            audiences: ['story', 'lore_select'],
            key: 'region',
            section: 'region',
            activation: { locations: ['北城'] },
          },
        },
      },
      {
        uid: 3,
        name: '本轮',
        content: '可选世界资料'.repeat(100),
        enabled: true,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 3,
        position: 0,
        extra: { lore: { audiences: ['story', 'lore_select'], key: 'optional', section: 'turn' } },
      },
    ],
  });
  async function budgetFixture(
    budgetChars?: number,
    recall = '回查押金十七枚银币',
    rewritten = false,
  ) {
    const history = turns(4);
    const source = storyTurnSource(collectCompleteStoryTurns(history)[0]);
    const segment = { id: 's1', ...source, order: 0, content: '已结束事件摘要', eventName: '委托' };
    const ctx = makeContext(history);
    ctx.characters = [
      createDefaultCharacterState({ type: 'player', name: '玩家', location: '北城' }),
    ];
    ctx.agentOutputs.set('memory_recall', recall);
    const result = await buildStoryContextV2Messages({
      ctx,
      configs: [{ ...storyConfig, tailPrompt: '固定末尾格式要求' }],
      worldBooks: [loreBook()],
      presets: [makePreset([entry('固定模板', '固定模板规则', 0)])],
      windowTurns: 1,
      segments: [
        rewritten ? { ...segment, content: '同ID改写摘要' } : segment,
        {
          id: 's2',
          ...storyTurnSource(collectCompleteStoryTurns(history)[1]),
          order: 0,
          content: '窗口外常驻摘要',
        },
      ],
      archives: [
        {
          id: 'ar1',
          saveId: 's',
          eventName: '委托',
          outcome: 'completed',
          evidence: '正文1',
          overview: '长期历史概括',
          detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
          detailSource: 'summary',
          coveredSegmentIds: ['s1'],
          ...source,
          coveredSources: [source],
          coveredSegmentFingerprints: { s1: storySegmentFingerprint(segment) },
          sequence: 0,
          createdAt: 1,
        },
      ],
      budgetChars,
      outputReservedTokens: 321,
    });
    return result;
  }

  it('九项齐全，模板/召回/指引/缺摘要原文均计入，字符分类之和等于最终消息', async () => {
    const result = await budgetFixture();
    const d = result.diagnostics;
    const categories = d.budgetCategories!;
    expect(Object.keys(categories)).toEqual([
      'fixed',
      'longTerm',
      'region',
      'summary',
      'rawHistory',
      'turnLore',
      'recall',
      'currentFactsAndDirections',
      'outputReserve',
    ]);
    for (const category of Object.keys(categories).filter((key) => key !== 'outputReserve')) {
      const item = categories[category as keyof typeof categories];
      expect(item.chars).toBeGreaterThan(0);
      expect(item.estimatedTokens).toBe(Math.ceil(item.chars / 1.5));
    }
    expect(Object.values(categories).reduce((sum, item) => sum + item.chars, 0)).toBe(d.totalChars);
    expect(d.totalChars).toBe(result.messages.reduce((sum, m) => sum + m.content.length, 0));
    expect(d.outputReservedTokens).toBe(321);
    expect(categories.outputReserve).toEqual({ chars: 0, estimatedTokens: 321 });
    expect(categories.rawHistory.chars).toBeGreaterThan('输入4正文4'.length); // 包括缺摘要回合3兜底
    expect(d.missingSummaryTurnKeys).toEqual(['u3']);
    expect(assessStoryContextBudget(d, Math.ceil(d.totalChars / 1.5) + 320).overBudget).toBe(true);
  });

  it('预算逐项记录可选条目键/估算及原因，保留不可裁剪的原文与摘要', async () => {
    const result = await budgetFixture(0);
    const d = result.diagnostics;
    expect(d.budgetDroppedLoreKeys).toEqual(['optional']);
    expect(d.budgetDroppedRecall).toBe(true);
    expect(d.budgetRemovals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'optional',
          category: 'turnLore',
          chars: loreBook().entries[2].content.length,
          reason: expect.stringContaining('依赖组移除'),
        }),
        expect.objectContaining({
          key: 'memory_recall',
          category: 'recall',
          reason: expect.stringContaining('不截原文'),
        }),
      ]),
    );
    expect(d.budgetCategories?.turnLore.chars).toBe(0);
    expect(d.budgetCategories?.recall.chars).toBe(0);
    expect(d.budgetCategories?.summary.chars).toBeGreaterThan(0);
    expect(d.budgetCategories?.rawHistory.chars).toBeGreaterThan(0);
    expect(result.messages.map((m) => m.content).join('\n')).toContain('正文4');
    expect(result.messages.map((m) => m.content).join('\n')).toContain('窗口外常驻摘要');
    expect(assessStoryContextBudget(d, 1).overBudget).toBe(true);
  });

  it('同ID覆盖摘要语义修订，旧归档退出长期总览，改写摘要恢复第4区', async () => {
    const result = await budgetFixture(undefined, '', true);
    expect(result.diagnostics.archiveIds).toEqual([]);
    expect(result.diagnostics.summarySegmentIds).toContain('s1');
    expect(result.messages.map((m) => m.content).join('\n')).toContain('同ID改写摘要');
  });

  it('输入额度充足无移除；未接输出预留时不伪称实际预留为0', async () => {
    const result = await budgetFixture(100000);
    expect(result.diagnostics.budgetRemovals).toEqual([]);
    const withoutReserve = await assemble([entry('规则', '固定', 10)], [], 1);
    expect(withoutReserve.diagnostics.outputReservedTokens).toBeUndefined();
  });
});
