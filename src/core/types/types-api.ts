/**
 * API source configuration types.
 *
 * A source's purpose (`kind`) and wire format (`protocol`) are deliberately
 * separate.  Protocol selection is explicit: neither model names nor URLs are
 * used to guess a provider.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ApiSourceKind = 'llm' | 'embedding' | 'reranker';
export type LlmProtocol = 'openai-chat' | 'gemini' | 'anthropic-messages';
export type RetrievalProtocol = 'openai-embeddings' | 'openai-rerank';
export type ApiProtocol = LlmProtocol | RetrievalProtocol;

export interface ApiSourceBase {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Cached discovery result, never an authoritative allow-list. */
  models: string[];
  timeoutMs: number;
  /** Provider-native request parameters. Applied after caller parameters. */
  bodyOverrides: JsonObject;
  /** Optional fields removed after overrides, expressed as JSON Pointers. */
  bodyOmitPaths: string[];
  /** Incremented by the persistence layer whenever connection semantics change. */
  revision?: number;
}

export interface LlmApiSource extends ApiSourceBase {
  kind: 'llm';
  protocol: LlmProtocol;
  contextWindowTokens?: number;
  /** Claude Messages wire version; ignored by other protocols. */
  anthropicVersion?: string;
  /** Explicitly enabled Claude beta headers; arbitrary headers are not supported. */
  anthropicBeta?: string[];
}

export interface EmbeddingApiSource extends ApiSourceBase {
  kind: 'embedding';
  protocol: 'openai-embeddings';
}

export interface RerankerApiSource extends ApiSourceBase {
  kind: 'reranker';
  protocol: 'openai-rerank';
}

export type ApiSource = LlmApiSource | EmbeddingApiSource | RerankerApiSource;

export type ApiSourceForProtocol<P extends ApiProtocol> = Extract<ApiSource, { protocol: P }>;

/** Device-local image provider connection; it never enters ordinary backups. */
export interface ImageApiConnection {
  id: string;
  name: string;
  provider: 'novelai' | 'comfyui';
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  revision?: number;
}

/** Provider-native assistant payload retained verbatim for tool continuation. */
export interface NativeLlmContent {
  protocol: LlmProtocol;
  value: JsonObject;
}

/** Business-level message plus an optional lossless provider representation. */
export interface LlmMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  native?: NativeLlmContent;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NormalizedLlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHit?: boolean;
  cacheReadTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface NormalizedLlmResponse {
  text: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  finishReason?: string;
  usage: NormalizedLlmUsage;
  nativeAssistant: NativeLlmContent;
  raw: JsonObject;
}
