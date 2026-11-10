import {
  acceptDirectContext,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../../../src/core/agents/agent-client';
import {
  generateDirectTurn,
  type DirectGenerationInput,
} from '../../../src/core/agents/direct-main';
import { createDirectPreset } from '../../../src/core/prompts/direct-prompt';
import { projectStreamingStory } from '../../../src/core/story/story-output';
import type { AgentConfig, ApiEndpoint } from '../../../src/core/types/types';

const raw =
  '<maintext>铁匠收好短剑。</maintext><character_updates>{"characters":[]}</character_updates><direct_updates>{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}</direct_updates>';

function setup(v2: boolean) {
  const endpoint: ApiEndpoint = {
    id: 'direct-wire',
    name: 'Test',
    provider: 'openai',
    protocol: 'openai-chat',
    baseUrl: 'https://invalid.example/v1',
    apiKey: 'test-only',
    defaultModel: 'test',
    models: ['test'],
    timeout: 1000,
  };
  let preview = '';
  const visible: string[] = [];
  const onError = vi.fn();
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
    userId: 'direct-wire',
    historyLayers: 2,
    presetId: createDirectPreset().id,
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    streamCallbacks: {
      onChunk(text, done) {
        if (!done) {
          preview += text;
          visible.push(projectStreamingStory(preview));
        }
      },
      onComplete: vi.fn(),
      onError,
    },
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
      agentOutputs: new Map([['memory_recall', '铁匠已收到材料']]),
    },
    ...(v2 ? { storyContext: { windowTurns: 2, segments: [], archives: [] } } : {}),
  };
  return {
    input,
    visible,
    onError,
    client: new AgentClient({
      endpoint,
      agentId: 'direct_main',
      saveId: 'direct-wire',
      maxRetries: 0,
    }),
  };
}

function streamResponse(complete: boolean) {
  const events =
    [raw.slice(0, 11), raw.slice(11, 70), raw.slice(70)]
      .map(
        (content) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
      )
      .join('') + (complete ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(events);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split UTF-8 and SSE delimiters, as a real transport may do.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('direct generation through the real client and stream parser', () => {
  it.each([false, true])(
    'sends one complete request each turn and hides control JSON (v2=%s)',
    async (v2) => {
      const { input, client, visible, onError } = setup(v2);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => streamResponse(true));
      for (const location of ['铁匠铺', '街道']) {
        input.context.variables.地点 = location;
        const generated = await generateDirectTurn(input, client);
        expect(generated.draft.content).toBe('铁匠收好短剑。');
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [index, [url, init]] of fetch.mock.calls.entries()) {
        expect(url).toBe('/api/llm/openai-chat/generate');
        const body = JSON.parse(String(init!.body));
        expect(body.stream).toBe(true);
        expect(body.tools).toBeUndefined();
        const prompt = JSON.stringify(body.messages);
        expect(prompt).toContain('direct_updates');
        expect(prompt).toContain('铁匠已收到材料');
        expect(prompt).toContain(index ? '街道' : '铁匠铺');
        expect(prompt.match(/查看短剑/g)).toHaveLength(1);
      }
      expect(onError).not.toHaveBeenCalled();
      expect(visible.some((text) => text.includes('铁匠收好短剑'))).toBe(true);
      expect(
        visible.every((text) => !text.includes('direct_updates') && !text.includes('"diceUsed"')),
      ).toBe(true);
    },
  );

  it.each(['http', 'truncated'] as const)(
    'rejects %s failures without a second request',
    async (failure) => {
      const { input, client, onError } = setup(true);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () =>
          failure === 'http' ? new Response('Unavailable', { status: 503 }) : streamResponse(false),
        );
      await expect(generateDirectTurn(input, client)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );
});

it.each([false, true])(
  'cached direct reuses the accepted wire prefix with legacy/v2=%s',
  async (v2) => {
    invalidateDirectContext('cached-wire');
    const { input, client } = setup(v2);
    input.cache = { saveId: 'cached-wire', policy: 'prefix' };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => streamResponse(true));
    const first = await generateDirectTurn(input, client);
    expect(first.cache).toBeDefined();
    await acceptDirectContext(first.cache!.ticket, { ...first.cache!, acceptedMessages: [] });
    input.context.userInput = '离开铁匠铺';
    input.context.variables = { 地点: '街道' };
    const second = await generateDirectTurn(input, client);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.result.promptRebased).toBe(false);
    expect(second.result.requestMessages!.slice(0, first.result.requestMessages!.length)).toEqual(
      first.result.requestMessages,
    );
    expect(
      second.result.requestMessages![second.result.requestMessages!.length - 1]!.content,
    ).toContain('街道');
    expect(
      second.result.requestMessages![second.result.requestMessages!.length - 1]!.content,
    ).toContain('离开铁匠铺');
    expect(second.result.providerUsage).toBeDefined();
    invalidateDirectContext('cached-wire');
  },
);
