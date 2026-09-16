import type {
  JsonObject,
  LlmMessage,
  NormalizedLlmResponse,
  NormalizedLlmUsage,
  NormalizedToolCall,
} from '../types-api';
import { asObject, finiteNumber, parseToolArguments, parseToolResult } from './adapter-utils';
import type { LlmBuildInput, LlmStreamAccumulator, LlmStreamEventResult } from './llm-adapter';

function textPart(text: string | null): JsonObject {
  return { text: text ?? '' };
}

function toolCallParts(message: LlmMessage): JsonObject[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((entry, index) => {
    const call = asObject(entry, `tool_calls[${index}]`);
    const fn = call.function ? asObject(call.function, 'tool function') : call;
    return {
      functionCall: {
        id: typeof call.id === 'string' ? call.id : `gemini-imported-${index}`,
        name: typeof fn.name === 'string' ? fn.name : '',
        args:
          typeof fn.arguments === 'string'
            ? (parseToolResult(fn.arguments) as never)
            : ((fn.arguments ?? {}) as never),
      },
    };
  });
}

function convertGeminiMessages(messages: LlmMessage[]): {
  contents: JsonObject[];
  systemInstruction?: JsonObject;
} {
  const system: string[] = [];
  const contents: JsonObject[] = [];
  let sawConversation = false;

  for (const message of messages) {
    if (message.role === 'system') {
      if (sawConversation) {
        throw new Error('Gemini does not support system messages after conversation content');
      }
      if (message.content) system.push(message.content);
      continue;
    }
    sawConversation = true;

    if (message.role === 'assistant' && message.native?.protocol === 'gemini') {
      contents.push(message.native.value);
      continue;
    }
    if (message.role === 'tool') {
      const part: JsonObject = {
        functionResponse: {
          id: message.tool_call_id ?? '',
          name: message.name ?? '',
          response: parseToolResult(message.content) as never,
        },
      };
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user' && previous.__toolResults === true) {
        (previous.parts as JsonObject[]).push(part);
      } else {
        contents.push({ role: 'user', parts: [part], __toolResults: true });
      }
      continue;
    }

    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts =
      message.role === 'assistant'
        ? [...(message.content ? [textPart(message.content)] : []), ...toolCallParts(message)]
        : [textPart(message.content)];
    contents.push({ role, parts });
  }

  // Internal grouping marker must never cross the wire.
  for (const content of contents) delete content.__toolResults;
  return {
    contents,
    ...(system.length
      ? { systemInstruction: { role: 'system', parts: [{ text: system.join('\n\n') }] } }
      : {}),
  };
}

export function buildGeminiBody(input: LlmBuildInput): JsonObject {
  const converted = convertGeminiMessages(input.messages);
  const generationConfig: JsonObject = {
    temperature: input.temperature ?? 0.7,
    maxOutputTokens: input.maxTokens ?? 65_536,
    topP: input.topP ?? 1,
    candidateCount: 1,
  };
  if (input.frequencyPenalty !== undefined)
    generationConfig.frequencyPenalty = input.frequencyPenalty;
  if (input.presencePenalty !== undefined) generationConfig.presencePenalty = input.presencePenalty;
  if (input.stop !== undefined) generationConfig.stopSequences = input.stop;

  const body: JsonObject = {
    contents: converted.contents,
    generationConfig,
  };
  if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction;
  if (input.tools?.length && input.toolChoice !== 'none') {
    body.tools = [
      {
        functionDeclarations: input.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ] as never;
    const choice = input.toolChoice ?? 'auto';
    body.toolConfig = {
      functionCallingConfig:
        choice === 'required'
          ? { mode: 'ANY' }
          : typeof choice === 'object'
            ? { mode: 'ANY', allowedFunctionNames: [choice.function.name] }
            : { mode: 'AUTO' },
    } as never;
  }
  return body;
}

function geminiUsage(raw: JsonObject) {
  const usage =
    raw.usageMetadata && typeof raw.usageMetadata === 'object'
      ? asObject(raw.usageMetadata, 'usageMetadata')
      : {};
  return {
    inputTokens: finiteNumber(usage.promptTokenCount),
    outputTokens: finiteNumber(usage.candidatesTokenCount),
    totalTokens: finiteNumber(usage.totalTokenCount),
    cacheReadTokens: finiteNumber(usage.cachedContentTokenCount),
    reasoningTokens: finiteNumber(usage.thoughtsTokenCount),
  };
}

export function parseGeminiResponse(input: unknown): NormalizedLlmResponse {
  const raw = asObject(input, 'Gemini response');
  const candidate = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined;
  if (!candidate || typeof candidate !== 'object') {
    const error =
      raw.error && typeof raw.error === 'object' ? asObject(raw.error, 'error') : undefined;
    throw new Error(
      error && typeof error.message === 'string'
        ? error.message
        : 'Gemini response has no candidate',
    );
  }
  const candidateObject = asObject(candidate, 'candidate');
  const content = asObject(candidateObject.content, 'candidate.content');
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = asObject(parts[index], `parts[${index}]`);
    if (typeof part.text === 'string') {
      (part.thought === true ? reasoning : text).push(part.text);
    }
    if (part.functionCall && typeof part.functionCall === 'object') {
      const call = asObject(part.functionCall, 'functionCall');
      toolCalls.push({
        id: typeof call.id === 'string' ? call.id : `gemini-tool-${index}`,
        name: typeof call.name === 'string' ? call.name : '',
        arguments: parseToolArguments(call.args),
      });
    }
  }
  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls,
    finishReason:
      typeof candidateObject.finishReason === 'string' ? candidateObject.finishReason : undefined,
    usage: geminiUsage(raw),
    nativeAssistant: { protocol: 'gemini', value: content },
    raw,
  };
}

export class GeminiStreamAccumulator implements LlmStreamAccumulator {
  terminal = false;
  private fullText = '';
  private reasoning = '';
  private finishReason: string | undefined;
  private usage: NormalizedLlmUsage = {};
  private nativeParts: JsonObject[] = [];
  private toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  accept(value: unknown): LlmStreamEventResult[] {
    const raw = asObject(value, 'Gemini stream event');
    if (raw.error && typeof raw.error === 'object') {
      const error = asObject(raw.error, 'Gemini stream error');
      return [{ error: typeof error.message === 'string' ? error.message : 'Gemini stream error' }];
    }
    this.usage = { ...this.usage, ...geminiUsage(raw) };
    const candidate = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined;
    if (!candidate || typeof candidate !== 'object') return [];
    const candidateObject = asObject(candidate, 'candidate');
    const content =
      candidateObject.content && typeof candidateObject.content === 'object'
        ? asObject(candidateObject.content, 'content')
        : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const out: LlmStreamEventResult[] = [];
    for (const entry of parts) {
      const part = asObject(entry, 'part');
      this.nativeParts.push(part);
      if (typeof part.text === 'string' && part.text) {
        if (part.thought === true) {
          this.reasoning += part.text;
          out.push({ reasoningDelta: part.text });
        } else {
          this.fullText += part.text;
          out.push({ textDelta: part.text });
        }
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        const call = asObject(part.functionCall, 'functionCall');
        const normalized = {
          id: typeof call.id === 'string' ? call.id : `gemini-tool-${this.toolCalls.length}`,
          name: typeof call.name === 'string' ? call.name : '',
          arguments: parseToolArguments(call.args),
        };
        this.toolCalls.push(normalized);
        out.push({ toolCall: normalized });
      }
    }
    if (typeof candidateObject.finishReason === 'string') {
      this.finishReason = candidateObject.finishReason;
      this.terminal = true;
    }
    return out;
  }

  snapshot() {
    return {
      fullText: this.fullText,
      reasoning: this.reasoning,
      toolCalls: [...this.toolCalls],
      usage: this.usage,
      finishReason: this.finishReason,
      nativeAssistant: {
        protocol: 'gemini' as const,
        value: { role: 'model', parts: this.nativeParts },
      },
    };
  }
}
