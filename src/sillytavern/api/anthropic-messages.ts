import type {
  JsonObject,
  LlmMessage,
  NormalizedLlmResponse,
  NormalizedLlmUsage,
  NormalizedToolCall,
} from '../types-api';
import { asObject, finiteNumber, parseToolArguments, parseToolResult } from './adapter-utils';
import type { LlmBuildInput, LlmStreamAccumulator, LlmStreamEventResult } from './llm-adapter';

function assistantBlocks(message: LlmMessage): JsonObject[] {
  const blocks: JsonObject[] = message.content ? [{ type: 'text', text: message.content }] : [];
  if (Array.isArray(message.tool_calls)) {
    for (let index = 0; index < message.tool_calls.length; index++) {
      const call = asObject(message.tool_calls[index], `tool_calls[${index}]`);
      const fn = call.function ? asObject(call.function, 'tool function') : call;
      blocks.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : `anthropic-imported-${index}`,
        name: typeof fn.name === 'string' ? fn.name : '',
        input:
          typeof fn.arguments === 'string'
            ? (parseToolResult(fn.arguments) as never)
            : ((fn.arguments ?? {}) as never),
      });
    }
  }
  return blocks;
}

function convertAnthropicMessages(messages: LlmMessage[]): {
  messages: JsonObject[];
  system?: string;
} {
  const system: string[] = [];
  const converted: JsonObject[] = [];
  let sawConversation = false;

  for (const message of messages) {
    if (message.role === 'system') {
      if (sawConversation) {
        throw new Error('Claude Messages does not support mid-conversation system messages');
      }
      if (message.content) system.push(message.content);
      continue;
    }
    sawConversation = true;
    if (message.role === 'assistant' && message.native?.protocol === 'anthropic-messages') {
      const value = message.native.value;
      converted.push({ role: 'assistant', content: value.content ?? [] });
      continue;
    }
    if (message.role === 'tool') {
      const block: JsonObject = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: JSON.stringify(parseToolResult(message.content)),
      };
      const previous = converted[converted.length - 1];
      if (previous?.role === 'user' && previous.__toolResults === true) {
        (previous.content as JsonObject[]).push(block);
      } else {
        converted.push({ role: 'user', content: [block], __toolResults: true });
      }
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content =
      role === 'assistant'
        ? assistantBlocks(message)
        : ([{ type: 'text', text: message.content ?? '' }] as JsonObject[]);
    const previous = converted[converted.length - 1];
    if (previous?.role === role && previous.__toolResults !== true) {
      (previous.content as JsonObject[]).push(...content);
    } else {
      converted.push({ role, content });
    }
  }
  for (const message of converted) delete message.__toolResults;
  return { messages: converted, ...(system.length ? { system: system.join('\n\n') } : {}) };
}

export function buildAnthropicBody(input: LlmBuildInput): JsonObject {
  const converted = convertAnthropicMessages(input.messages);
  const body: JsonObject = {
    model: input.model,
    messages: converted.messages,
    max_tokens: input.maxTokens ?? 65_536,
    stream: input.stream,
  };
  if (converted.system) body.system = converted.system;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.topP !== undefined) body.top_p = input.topP;
  if (input.stop !== undefined) body.stop_sequences = input.stop;
  if (input.tools?.length && input.toolChoice !== 'none') {
    body.tools = input.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })) as never;
    const choice = input.toolChoice ?? 'auto';
    body.tool_choice =
      choice === 'required'
        ? { type: 'any' }
        : typeof choice === 'object'
          ? { type: 'tool', name: choice.function.name }
          : { type: 'auto' };
  }
  return body;
}

function anthropicUsage(raw: JsonObject) {
  const usage = raw.usage && typeof raw.usage === 'object' ? asObject(raw.usage, 'usage') : {};
  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
    cacheReadTokens: finiteNumber(usage.cache_read_input_tokens),
    cacheWriteTokens: finiteNumber(usage.cache_creation_input_tokens),
  };
}

export function parseAnthropicResponse(input: unknown): NormalizedLlmResponse {
  const raw = asObject(input, 'Claude response');
  if (raw.type === 'error') {
    const error = raw.error && typeof raw.error === 'object' ? asObject(raw.error, 'error') : {};
    throw new Error(typeof error.message === 'string' ? error.message : 'Claude API error');
  }
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = asObject(blocks[index], `content[${index}]`);
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'thinking' && typeof block.thinking === 'string')
      reasoning.push(block.thinking);
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : `anthropic-tool-${index}`,
        name: typeof block.name === 'string' ? block.name : '',
        arguments: parseToolArguments(block.input),
      });
    }
  }
  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls,
    finishReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : undefined,
    usage: anthropicUsage(raw),
    nativeAssistant: { protocol: 'anthropic-messages', value: { content: blocks as never } },
    raw,
  };
}

export class AnthropicStreamAccumulator implements LlmStreamAccumulator {
  terminal = false;
  private fullText = '';
  private reasoning = '';
  private finishReason: string | undefined;
  private usage: NormalizedLlmUsage = {};
  private blocks = new Map<number, JsonObject>();
  private partialJson = new Map<number, string>();

  accept(value: unknown): LlmStreamEventResult[] {
    const event = asObject(value, 'Claude stream event');
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'error') {
      const error =
        event.error && typeof event.error === 'object' ? asObject(event.error, 'error') : {};
      return [{ error: typeof error.message === 'string' ? error.message : 'Claude stream error' }];
    }
    if (type === 'message_start' && event.message && typeof event.message === 'object') {
      this.usage = anthropicUsage(asObject(event.message, 'message'));
      return [];
    }
    if (type === 'content_block_start') {
      const index = finiteNumber(event.index) ?? 0;
      const block = asObject(event.content_block, 'content_block');
      this.blocks.set(index, { ...block });
      if (block.type === 'tool_use') this.partialJson.set(index, '');
      return [];
    }
    if (type === 'content_block_delta') {
      const index = finiteNumber(event.index) ?? 0;
      const delta = asObject(event.delta, 'delta');
      const block = this.blocks.get(index) ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.fullText += delta.text;
        block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
        this.blocks.set(index, block);
        return [{ textDelta: delta.text }];
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.reasoning += delta.thinking;
        block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
        this.blocks.set(index, block);
        return [{ reasoningDelta: delta.thinking }];
      }
      if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        block.signature = delta.signature;
        this.blocks.set(index, block);
        return [];
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const next = `${this.partialJson.get(index) ?? ''}${delta.partial_json}`;
        this.partialJson.set(index, next);
        const id = typeof block.id === 'string' ? block.id : `anthropic-tool-${index}`;
        const name = typeof block.name === 'string' ? block.name : '';
        return [{ toolCall: { id, name, arguments: next } }];
      }
      return [];
    }
    if (type === 'content_block_stop') {
      const index = finiteNumber(event.index) ?? 0;
      const block = this.blocks.get(index);
      const json = this.partialJson.get(index);
      if (block?.type === 'tool_use' && json !== undefined) {
        try {
          block.input = JSON.parse(json || '{}');
        } catch {
          throw new Error(`Claude returned incomplete tool JSON at content block ${index}`);
        }
      }
      return [];
    }
    if (type === 'message_delta') {
      const delta =
        event.delta && typeof event.delta === 'object' ? asObject(event.delta, 'delta') : {};
      if (typeof delta.stop_reason === 'string') this.finishReason = delta.stop_reason;
      const nextUsage = anthropicUsage(event);
      this.usage = { ...this.usage, ...nextUsage };
      return [];
    }
    if (type === 'message_stop') {
      this.terminal = true;
      return [{ done: true }];
    }
    return [];
  }

  snapshot() {
    const blocks = [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block);
    const toolCalls = blocks
      .filter((block) => block.type === 'tool_use')
      .map((block, index) => ({
        id: typeof block.id === 'string' ? block.id : `anthropic-tool-${index}`,
        name: typeof block.name === 'string' ? block.name : '',
        arguments: parseToolArguments(block.input),
      }));
    return {
      fullText: this.fullText,
      reasoning: this.reasoning,
      toolCalls,
      usage: this.usage,
      finishReason: this.finishReason,
      nativeAssistant: {
        protocol: 'anthropic-messages' as const,
        value: { content: blocks },
      },
    };
  }
}
