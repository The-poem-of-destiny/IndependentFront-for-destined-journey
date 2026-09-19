import { describe, expect, it } from 'vitest';
import { buildLlmRequest, createLlmStreamAccumulator, parseLlmResponse } from './llm-adapter';

const base = {
  model: 'model-x',
  messages: [
    { role: 'system', content: 'first' },
    { role: 'system', content: 'second' },
    { role: 'user', content: 'hello' },
  ],
  maxTokens: 32,
  stream: false,
  userId: 'test',
};

describe('LLM protocol adapters', () => {
  it('builds OpenAI bodies with source overrides and omissions', () => {
    const built = buildLlmRequest({
      ...base,
      protocol: 'openai-chat',
      temperature: 0.8,
      bodyOverrides: { temperature: 0.2, extra_body: { thinking: true } },
      bodyOmitPaths: ['/frequency_penalty'],
    });
    expect(built.body.temperature).toBe(0.2);
    expect(built.body.frequency_penalty).toBeUndefined();
    expect(built.outputBudget).toBe(32);
  });

  it('reads OpenAI cached prompt tokens from the official response field', () => {
    const response = parseLlmResponse('openai-chat', {
      choices: [{ message: { content: 'cached' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
    });
    expect(response.usage.cacheReadTokens).toBe(80);
  });

  it('maps Gemini system/tool messages and preserves thought signatures for continuation', () => {
    const response = parseLlmResponse('gemini', {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'hidden', thought: true, thoughtSignature: 'opaque-signature' },
              { functionCall: { id: 'call-1', name: 'lookup', args: { name: 'A' } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    });
    expect(response.reasoning).toBe('hidden');
    expect(response.toolCalls[0]).toEqual({
      id: 'call-1',
      name: 'lookup',
      arguments: '{"name":"A"}',
    });
    expect(
      (response.nativeAssistant.value.parts as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ thoughtSignature: 'opaque-signature' });

    const continuation = buildLlmRequest({
      ...base,
      protocol: 'gemini',
      messages: [
        ...base.messages,
        { role: 'assistant', content: null, native: response.nativeAssistant },
        { role: 'tool', name: 'lookup', tool_call_id: 'call-1', content: '{"ok":true}' },
      ],
    });
    expect(continuation.body.systemInstruction).toMatchObject({
      parts: [{ text: 'first\n\nsecond' }],
    });
    expect(JSON.stringify(continuation.body)).toContain('opaque-signature');
    expect(JSON.stringify(continuation.body)).toContain('functionResponse');
  });

  it('rejects mid-conversation Gemini system messages', () => {
    expect(() =>
      buildLlmRequest({
        ...base,
        protocol: 'gemini',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: 'too late' },
        ],
      }),
    ).toThrow('after conversation');
  });

  it('maps Claude blocks and preserves thinking signatures', () => {
    const response = parseLlmResponse('anthropic-messages', {
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'tool_use', id: 'tool-1', name: 'inspect', input: { id: 2 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 2 },
    });
    expect(response.reasoning).toBe('plan');
    expect(response.usage.totalTokens).toBe(11);
    expect(
      (response.nativeAssistant.value.content as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ signature: 'sig-1' });
    const continuation = buildLlmRequest({
      ...base,
      protocol: 'anthropic-messages',
      messages: [
        ...base.messages,
        { role: 'assistant', content: null, native: response.nativeAssistant },
        { role: 'tool', tool_call_id: 'tool-1', content: '{"ok":true}' },
      ],
    });
    expect(continuation.body.system).toBe('first\n\nsecond');
    expect(JSON.stringify(continuation.body)).toContain('sig-1');
    expect(JSON.stringify(continuation.body)).toContain('tool_result');
  });

  it('decodes provider-native streaming terminal and in-stream errors', () => {
    const openai = createLlmStreamAccumulator('openai-chat');
    openai.accept({
      choices: [{ delta: { content: 'cached' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
    });
    expect(openai.snapshot().usage.cacheReadTokens).toBe(80);

    const gemini = createLlmStreamAccumulator('gemini');
    expect(
      gemini.accept({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { totalTokenCount: 4 },
      }),
    ).toEqual([{ textDelta: 'hello' }]);
    expect(gemini.terminal).toBe(true);
    expect(gemini.snapshot().fullText).toBe('hello');

    const claude = createLlmStreamAccumulator('anthropic-messages');
    expect(claude.accept({ type: 'error', error: { message: 'overloaded' } })).toEqual([
      { error: 'overloaded' },
    ]);
    claude.accept({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    claude.accept({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-stream' },
    });
    claude.accept({ type: 'message_stop' });
    expect(claude.snapshot().nativeAssistant).toMatchObject({
      value: { content: [expect.objectContaining({ signature: 'sig-stream' })] },
    });
  });
});
