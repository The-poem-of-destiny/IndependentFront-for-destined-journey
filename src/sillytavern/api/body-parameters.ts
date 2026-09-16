import type { ApiProtocol, JsonObject, JsonValue } from '../types-api';
import { cloneJsonObject } from './source-config';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PROTECTED_ROOT_FIELDS: Readonly<Record<ApiProtocol, ReadonlySet<string>>> = {
  'openai-chat': new Set(['model', 'messages', 'stream', 'tools', 'tool_choice']),
  gemini: new Set(['model', 'contents', 'systemInstruction', 'tools', 'toolConfig']),
  'anthropic-messages': new Set(['model', 'messages', 'system', 'stream', 'tools', 'tool_choice']),
  'openai-embeddings': new Set(['model', 'input']),
  'openai-rerank': new Set(['model', 'query', 'documents']),
};

export class BodyParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyParametersError';
  }
}

export interface BodyParameterInput {
  protocol: ApiProtocol;
  baseBody: JsonObject;
  bodyOverrides?: JsonObject;
  bodyOmitPaths?: readonly string[];
}

export interface BodyParameterResult {
  body: JsonObject;
  /** Provider-native output ceiling after overrides and omissions. */
  outputBudget?: number;
  overriddenPaths: string[];
  omittedPaths: string[];
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectLeafPaths(value: JsonValue, root: string, output: string[]): void {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      collectLeafPaths(child, `${root}/${encodePointerToken(key)}`, output);
    }
    return;
  }
  output.push(root || '/');
}

function mergeJson(base: JsonObject, overrides: JsonObject): JsonObject {
  const output = cloneJsonObject(base, 'baseBody');
  for (const [key, override] of Object.entries(overrides)) {
    if (DANGEROUS_KEYS.has(key))
      throw new BodyParametersError(`Dangerous key is not allowed: ${key}`);
    const current = output[key];
    output[key] =
      isObject(current) && isObject(override) ? mergeJson(current, override) : cloneValue(override);
  }
  return output;
}

function cloneValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isObject(value)) return cloneJsonObject(value);
  return value;
}

function decodePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new BodyParametersError(`Invalid JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~(?![01])/u.test(token))
        throw new BodyParametersError(`Invalid JSON Pointer: ${pointer}`);
      return token.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function assertCustomizableRoot(protocol: ApiProtocol, root: string, operation: string): void {
  if (PROTECTED_ROOT_FIELDS[protocol].has(root)) {
    throw new BodyParametersError(`${operation} protected field /${encodePointerToken(root)}`);
  }
}

function omitPointer(body: JsonObject, pointer: string): boolean {
  const tokens = decodePointer(pointer);
  if (tokens.length === 0) throw new BodyParametersError('The request body root cannot be omitted');
  let parent: JsonObject = body;
  for (let index = 0; index < tokens.length - 1; index++) {
    const value = parent[tokens[index]];
    if (Array.isArray(value)) {
      throw new BodyParametersError(`Array element omission is not supported: ${pointer}`);
    }
    if (!isObject(value)) return false;
    parent = value;
  }
  if (Array.isArray(parent)) {
    throw new BodyParametersError(`Array element omission is not supported: ${pointer}`);
  }
  return delete parent[tokens[tokens.length - 1]];
}

function finitePositiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readOutputBudget(protocol: ApiProtocol, body: JsonObject): number | undefined {
  if (protocol === 'gemini') {
    const config = body.generationConfig;
    return isObject(config) ? finitePositiveInteger(config.maxOutputTokens) : undefined;
  }
  return (
    finitePositiveInteger(body.max_completion_tokens) ?? finitePositiveInteger(body.max_tokens)
  );
}

function validateFinalBody(protocol: ApiProtocol, body: JsonObject): void {
  if (protocol === 'openai-chat' && body.n !== undefined && body.n !== 1) {
    throw new BodyParametersError('OpenAI-compatible chat only supports n = 1');
  }
  if (protocol === 'gemini') {
    const config = body.generationConfig;
    if (isObject(config) && config.candidateCount !== undefined && config.candidateCount !== 1) {
      throw new BodyParametersError('Gemini only supports generationConfig.candidateCount = 1');
    }
  }
}

/**
 * Applies source parameters without mutating either input.
 * Merge order is caller/native body -> source overrides -> source omissions.
 */
export function applyBodyParameters(input: BodyParameterInput): BodyParameterResult {
  const overrides = cloneJsonObject(input.bodyOverrides ?? {}, 'bodyOverrides');
  for (const key of Object.keys(overrides)) {
    assertCustomizableRoot(input.protocol, key, 'Cannot override');
  }

  const overriddenPaths: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    collectLeafPaths(value, `/${encodePointerToken(key)}`, overriddenPaths);
  }
  const body = mergeJson(input.baseBody, overrides);
  const omittedPaths: string[] = [];
  for (const rawPointer of input.bodyOmitPaths ?? []) {
    const pointer = rawPointer.trim();
    const tokens = decodePointer(pointer);
    if (tokens.length === 0)
      throw new BodyParametersError('The request body root cannot be omitted');
    assertCustomizableRoot(input.protocol, tokens[0], 'Cannot omit');
    if (omitPointer(body, pointer)) omittedPaths.push(pointer);
  }

  validateFinalBody(input.protocol, body);
  return {
    body,
    outputBudget: readOutputBudget(input.protocol, body),
    overriddenPaths: overriddenPaths.sort(),
    omittedPaths,
  };
}
