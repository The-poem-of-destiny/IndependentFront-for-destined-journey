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

/**
 * 源级自定义请求头（name → value）。
 *
 * 「参数跟随模型」请求头那一半：非标准 OpenAI 兼容网关常要求附带会话/租户头
 * （如 opencode 的 `x-opencode-session`）。受保护头名（鉴权 / 内容类型 / 传输控制 /
 * 本 BFF 自身的 `X-Target-*` 控制头）由解析层拒绝，前端组装时经 `X-Custom-Headers`
 * 载荷交给 BFF，BFF 侧再验一次。
 */
export type HeaderOverrides = Record<string, string>;

/**
 * 源级 LLM 默认采样 / 生成长度参数（「参数跟随模型」）。
 *
 * 生效优先级：**Agent 显式覆写 > 本默认 > 内容包默认层 > 硬兜底**。
 * 它让「换模型不必逐个 Agent 重设」成立 —— 一个模型（= 一个 API 池）配一次即可。
 * 只含真正的采样/长度旋钮；重试次数、历史层数、末尾指令是角色行为，不在此列。
 */
export interface LlmDefaultParameters {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
}

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
  /** User-defined request headers forwarded to the provider (protected names rejected). */
  headerOverrides: HeaderOverrides;
  /** Incremented by the persistence layer whenever connection semantics change. */
  revision?: number;
}

export interface LlmApiSource extends ApiSourceBase {
  kind: 'llm';
  protocol: LlmProtocol;
  contextWindowTokens?: number;
  /** 源级默认采样参数；Agent 覆写优先于它（见 `LlmDefaultParameters`）。 */
  defaultParameters?: LlmDefaultParameters;
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
  /**
   * DeepSeek beta **前缀续写**：把最后一条 assistant 消息标记为「前缀」，模型从
   * `content` 之后接着写。仅 openai-chat 协议透传（`prefix: true`）。
   */
  prefix?: boolean;
  /**
   * DeepSeek 思考模式的前缀/回传字段。作为 assistant 消息的思维链前缀交给模型
   * （配合 `prefix: true` 引导思维链），或原样回传上一轮 assistant 的思维链。
   * 仅 openai-chat 协议透传（`reasoning_content`）。
   */
  reasoning_content?: string;
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
