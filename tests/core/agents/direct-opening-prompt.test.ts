import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  generateDirectTurn,
  type DirectGenerationInput,
} from '../../../src/core/agents/direct-main';
import {
  acceptDirectContext,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import type { AgentConfig, ApiEndpoint } from '../../../src/core/types/types';

// 旧直出存档的开局提示词不该在认领之后每轮随状态区块重发：
// game-pipeline 的 buildContext 在直出、openingPromptConsumed 且历史里已有被接纳正文时给 undefined，
// 这里钉住 direct-main 一侧「ctx 不带 openingPrompt → 请求里就没有这个键」。

const raw =
  '<maintext>铁匠收好短剑。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>';

const OPENING = '开局提示词：首轮叙事请以开局剧情为舞台重新演绎。';

function setup() {
  const endpoint: ApiEndpoint = {
    id: 'direct-opening',
    name: 'Test',
    provider: 'openai',
    protocol: 'openai-chat',
    baseUrl: 'https://invalid.example/v1',
    apiKey: 'test-only',
    defaultModel: 'test',
    models: ['test'],
    timeout: 1000,
  };
  const config: AgentConfig = {
    agentId: 'direct_main',
    enabled: true,
    apiEndpointId: endpoint.id,
    model: 'test',
    temperature: 0.7,
    maxTokens: 1000,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    maxRetries: 0,
    timeout: 1000,
    userId: 'direct-opening',
    historyLayers: 2,
    presetId: createDirectPreset().id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
  };
  const input: DirectGenerationInput = {
    config,
    endpoint,
    configs: [config],
    presets: [createDirectPreset()],
    worldBooks: [],
    combat: null,
    context: {
      userInput: '查看短剑',
      characters: [],
      variables: { 地点: '铁匠铺' },
      history: [],
      memories: [],
      worldBooks: [],
      plotEvents: [],
      agentOutputs: new Map(),
    },
  };
  return {
    input,
    client: new AgentClient({
      endpoint,
      agentId: 'direct_main',
      saveId: 'direct-opening',
      maxRetries: 0,
    }),
  };
}

function jsonResponse() {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: raw } }] }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

/** 从请求消息里取出 `<direct_state>` 的 JSON */
function directState(messages: Array<{ content?: string | null }>): Record<string, unknown> {
  const text = messages.map((m) => m.content ?? '').join('\n');
  const match = /<direct_state>\n([\s\S]*?)\n<\/direct_state>/.exec(text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

/** 从留存消息里取出 `<direct_context>` 的 { set, remove } */
function directContext(content: string): { set: Record<string, unknown>; remove: string[] } {
  const match = /<direct_context>\n([\s\S]*?)\n<\/direct_context>/.exec(content);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as { set: Record<string, unknown>; remove: string[] };
}

afterEach(() => vi.restoreAllMocks());

describe('直出：开局提示词认领后不再随状态区块重发', () => {
  it('ctx 不带 openingPrompt 时 <direct_state> 没有该键', async () => {
    const { input, client } = setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse());
    const generated = await generateDirectTurn(input, client);
    expect(directState(generated.result.requestMessages!)).not.toHaveProperty('openingPrompt');
  });

  it('首轮 openingPrompt 与 userInput 等值时同样省略（首轮管线仍供值，由 direct-main 等值省略）', async () => {
    const { input, client } = setup();
    input.context.userInput = OPENING;
    input.context.openingPrompt = OPENING;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse());
    const generated = await generateDirectTurn(input, client);
    expect(directState(generated.result.requestMessages!)).not.toHaveProperty('openingPrompt');
  });

  it('对照：ctx 带着与 userInput 不同的 openingPrompt 时才会出现在 <direct_state>', async () => {
    const { input, client } = setup();
    input.context.openingPrompt = OPENING;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse());
    const generated = await generateDirectTurn(input, client);
    expect(directState(generated.result.requestMessages!).openingPrompt).toBe(OPENING);
  });

  it('缓存直出：第二楼去掉 openingPrompt 时不重基线，direct_context 的 remove 含 openingPrompt', async () => {
    const saveId = 'cached-opening-prompt';
    invalidateDirectContext(saveId);
    const { input, client } = setup();
    input.cache = { saveId, policy: 'prefix' };
    input.context.openingPrompt = OPENING;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse());
    try {
      const first = await generateDirectTurn(input, client);
      const firstRetained = first.cache!.ticket.messages[first.cache!.ticket.retainedCount - 1];
      expect(directContext(firstRetained.content!).set.openingPrompt).toBe(OPENING);
      await acceptDirectContext(first.cache!.ticket, { acceptedMessages: [] });

      input.context.openingPrompt = undefined;
      input.context.userInput = '离开铁匠铺';
      const second = await generateDirectTurn(input, client);
      const ticket = second.cache!.ticket;
      expect(second.result.promptRebased).toBe(false);
      expect(ticket.rebaseReason).toBeUndefined();
      const { set, remove } = directContext(ticket.messages[ticket.retainedCount - 1].content!);
      expect(remove).toContain('openingPrompt');
      expect(set).not.toHaveProperty('openingPrompt');
    } finally {
      invalidateDirectContext(saveId);
    }
  });
});
