/**
 * 记忆召回引擎 — Embedding 向量检索 + 余弦相似度排序 + 压缩触发
 *
 * Phase 4 核心模块。职责:
 * 1. 调用 Embedding API 计算向量
 * 2. 余弦相似度排序 → top-K 召回
 * 3. 定期触发记忆压缩（旧记忆 → 单条摘要）
 *
 * F09 (2026-09-04) 向量溯源与校验：
 * - 落库时向量与 {@link EmbeddingMetadata} **原子成对**（spaceId 由归一化 endpoint 身份 +
 *   模型 + 维度 + 预处理版本派生，**绝不含 API Key / URL userinfo / query**；key 轮换
 *   不改变空间身份）。
 * - 召回只对「同 spaceId 且元素有效」的向量算余弦；空 / 零 / NaN·Inf / 越界维度 /
 *   非数组 → invalid；无元数据的存量记录 = legacy → **不假定兼容**（维度相同也不证明
 *   同一空间），走兜底直到显式重嵌入。
 * - 一条坏数据只跳过自己，**绝不让整次召回抛穿**。兼容不足的槽位由重要性/recency
 *   兜底补上（score 恒 0，不冒充余弦分）；查询向量生成失败同样兜底并记非致命诊断
 *   （区分「provider 不可用」与「无匹配记忆」）。
 */

import type { EmbeddingMetadata, MemoryRecord } from './types';
export type { EmbeddingMetadata } from './types';
import { getMemories, saveMemory, deleteMemories } from './database';
import { scheduleApiRequest } from './api-rpm-limiter';

// ========== 常量与空间指纹 (F09) ==========

/**
 * 文本预处理版本 —— 「如何把文本变成 embedding 输入」的规则集标识。
 * 变更此版本等于声明「旧向量与新向量不再同一空间」：查询端空间指纹随之变化，
 * 存量记录自动降级为 legacy（这是有意的空间版本 bump 手段，不用做别的迁移）。
 */
export const EMBEDDING_PREPROCESSING_VERSION = 'fmt-v1';

/** 向量维度硬上限（防畸形形状撑爆分配/循环；现役模型实际 ≤ 3072） */
export const MAX_EMBEDDING_DIMENSIONS = 65536;

/** Embedding API 端点（与 computeEmbedding 既有入参形状一致，仅起名复用） */
export interface EmbeddingEndpoint {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  name?: string;
}

/**
 * 归一化 endpoint 身份 —— 只取「部署标识」用于空间指纹。
 * 剥离 URL userinfo / query / hash / 显式默认端口 / 尾斜杠；host 统一小写。
 * 🔴 绝不纳入 apiKey：key 轮换后同空间向量必须仍然可用。
 * 非 URL（相对路径/占位串）时保守去掉 `@` 前片段与 `?`/`#` 后片段。
 */
export function normalizeEndpointIdentity(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '(unknown)';
  try {
    const u = new URL(trimmed);
    // 只认 http(s) 部署标识：`user:pw@api.example.com/v1` 这类无 scheme 串会被解析成
    // scheme='user' 的 opaque path，必须扔进下面的保守分支清洗
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`unsupported scheme: ${u.protocol}`);
    }
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const hasDefaultPort =
      (u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80');
    if (hasDefaultPort) u.port = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    const withoutUserinfo = trimmed.split('@').pop() ?? trimmed;
    const withoutQuery = withoutUserinfo.split(/[?#]/)[0] ?? withoutUserinfo;
    return withoutQuery.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * 派生 embedding 空间指纹（F09）。同空间 ⇔ 同端部署 + 同模型 + 同维度 + 同预处理版本。
 * 摘要不含任何凭据，可安全随记忆记录进备份。
 */
export function computeEmbeddingSpaceId(
  endpoint: Pick<EmbeddingEndpoint, 'baseUrl'>,
  model: string,
  dimensions: number,
): string {
  const identity = normalizeEndpointIdentity(endpoint.baseUrl);
  return `emb:v1|${identity}|${model}|d${dimensions}|${EMBEDDING_PREPROCESSING_VERSION}`;
}

/**
 * 确定性短指纹（FNV-1a 32bit，纯同步）。
 * 用途：`contentRevision` —— 「被嵌入的文本长这样」的比对标记，重嵌入时校验文本未变。
 * 非密码学用途；刻意同步：不把纯函数/组装路径传染成 async
 * （先例：content-source 因 crypto.subtle 异步而改用同步 hash）。
 */
export function hashTextDeterministic(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 记忆文本 → embedding 输入的拼接规则（**全仓唯一一份**，F09 收敛了两处各自
 * `[${keywords.join(', ')}] ${content}` 的拷贝）。
 * 🔴 查询路径不经过这里 —— 查询文本原样入模型（既有行为，保持不变）。
 */
export function buildEmbeddingText(keywords: string[], content: string): string {
  return `[${keywords.join(', ')}] ${content}`;
}

/**
 * 由「已产出的向量 + 请求配置」合成溯源元数据（F09）。
 * dimensions / preprocessingVersion / contentRevision 与 spaceId 同批派生，
 * 保证「向量与元数据原子成对」（调用方必须把它们一起写入同一条记录）。
 *
 * @param modelRevision provider 报告的模型（如响应 `model` 字段；缺席即不记录）
 */
export function buildEmbeddingMetadata(
  embedding: number[],
  endpoint: Pick<EmbeddingEndpoint, 'baseUrl'>,
  model: string,
  embeddingText: string,
  modelRevision?: string,
): EmbeddingMetadata {
  const dimensions = embedding.length;
  return {
    spaceId: computeEmbeddingSpaceId(endpoint, model, dimensions),
    model,
    dimensions,
    preprocessingVersion: EMBEDDING_PREPROCESSING_VERSION,
    contentRevision: hashTextDeterministic(embeddingText),
    ...(modelRevision ? { modelRevision } : {}),
  };
}

export type EmbeddingValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * 校验一个向量是否可用于余弦排名（入径校验，F09）：
 * 须为非空数组、全元素为有限数、非零范数、维度不超上限；可选期望维度精确比对。
 * 🔴 零向量余弦无意义（与一切向量相似度恒 0），一律判非法。
 */
export function validateEmbeddingVector(
  vector: unknown,
  options: { expectedDimensions?: number; maxDimensions?: number } = {},
): EmbeddingValidationResult {
  if (!Array.isArray(vector)) return { valid: false, reason: '非数组' };
  if (vector.length === 0) return { valid: false, reason: '空向量' };
  const max = options.maxDimensions ?? MAX_EMBEDDING_DIMENSIONS;
  if (vector.length > max) return { valid: false, reason: `维度超上限 ${max}` };
  if (options.expectedDimensions !== undefined && vector.length !== options.expectedDimensions) {
    return {
      valid: false,
      reason: `维度不符: 期望 ${options.expectedDimensions}，实际 ${vector.length}`,
    };
  }
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { valid: false, reason: `元素 ${i} 非有限数` };
    }
  }
  let normSq = 0;
  for (let i = 0; i < vector.length; i++) normSq += vector[i] * vector[i];
  if (normSq === 0) return { valid: false, reason: '零向量' };
  return { valid: true };
}

/** 召回时一条存储向量被分入的桶（F09 核心不变量 1） */
export type StoredVectorClass =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'incompatible'; reason: string }
  | { kind: 'compatible' };

/**
 * 召回分区判据（纯函数）。只有 `compatible` 参与余弦排名：
 * - missing：根本没有向量；
 * - invalid：向量坏了（空 / 非数组 / NaN·Inf / 零向量 / 越界维度）或元数据自相矛盾；
 * - incompatible：向量本身合法但空间无法确认一致 —— 无元数据（legacy）或 spaceId 不同
 *   （哪怕维度相同，也**不**降级为余弦比较，简报 §3.6 保守语义）；
 * - compatible：与查询同空间且元数据维度一致，可以算余弦。
 * 一条坏数据只丢掉它自己，绝不中止整次召回。
 */
export function classifyStoredVector(
  embedding: unknown,
  meta: EmbeddingMetadata | undefined,
  querySpaceId: string,
  queryDimensions: number,
): StoredVectorClass {
  if (embedding === undefined || embedding === null) return { kind: 'missing' };
  const shape = validateEmbeddingVector(embedding);
  if (!shape.valid) return { kind: 'invalid', reason: shape.reason };
  if (!meta?.spaceId || typeof meta.dimensions !== 'number') {
    return { kind: 'incompatible', reason: '缺少空间元数据（legacy，不假定兼容）' };
  }
  if (meta.spaceId !== querySpaceId) {
    return { kind: 'incompatible', reason: '不同 embedding 空间' };
  }
  // validateEmbeddingVector 已确认它是数组；此处收窄类型再做维度比对
  if (
    meta.dimensions !== queryDimensions ||
    !Array.isArray(embedding) ||
    embedding.length !== queryDimensions
  ) {
    return { kind: 'invalid', reason: '元数据维度与查询不符' };
  }
  return { kind: 'compatible' };
}

// ========== Embedding ==========

/** 一次真实 Embedding Provider 请求的可导出诊断信息（不包含 API Key 或向量字节）。 */
export interface EmbeddingRequestTrace {
  input: string;
  model: string;
  baseUrl: string;
  startedAt: number;
  completedAt: number;
  promptTokens?: number;
  totalTokens?: number;
  dimensions?: number;
  responseSummary?: string;
  error?: string;
}

export type EmbeddingRequestObserver = (trace: EmbeddingRequestTrace) => void;

/**
 * 调用 OpenAI 兼容的 /embeddings 端点计算向量（直接使用 fetch，浏览器/Node 18+ 均可用），
 * 并**同批合成溯源元数据**（F09）。
 *
 * 🔴 入径校验：provider 返回值必须非空数字数组、全元素有限、非零范数、维度不超上限
 * （`validateEmbeddingVector`）；非法输出在此抛错，调用方据此降级为「无向量」落库，
 * 非法字节永远不会进持久化字段。
 */
export async function computeEmbeddingWithMeta(
  text: string,
  endpoint: EmbeddingEndpoint,
  model?: string,
  signal?: AbortSignal,
  onRequest?: EmbeddingRequestObserver,
): Promise<{ embedding: number[]; meta: EmbeddingMetadata }> {
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');
  const resolvedModel = model || endpoint.defaultModel;
  const startedAt = Date.now();
  const body = JSON.stringify({
    model: resolvedModel,
    input: text,
  });
  let observed = false;
  const observe = (extra: Partial<EmbeddingRequestTrace>) => {
    if (observed) return;
    observed = true;
    try {
      onRequest?.({
        input: text,
        model: resolvedModel,
        baseUrl,
        startedAt,
        completedAt: Date.now(),
        ...extra,
      });
    } catch (error) {
      console.warn('[memory-store] Embedding 调试观察器失败（不影响请求）:', error);
    }
  };

  try {
    const res = await scheduleApiRequest(
      { baseUrl, apiKey: endpoint.apiKey, label: endpoint.name || baseUrl },
      signal,
      () =>
        fetch('/api/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Target-Base-URL': baseUrl,
            Authorization: `Bearer ${endpoint.apiKey}`,
          },
          body,
          signal,
        }),
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Embedding API ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      object?: string;
      model?: string;
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    const embedding = json.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Embedding API 返回数据格式异常');
    }
    const validation = validateEmbeddingVector(embedding);
    if (!validation.valid) {
      throw new Error(`Embedding 响应向量非法: ${validation.reason}`);
    }

    // 向量与元数据同批派生；modelRevision = provider 实际报告（别名解析后）的模型
    const meta = buildEmbeddingMetadata(embedding, endpoint, resolvedModel, text, json.model);

    const responseSummary = JSON.stringify({
      object: json.object,
      model: json.model,
      dataCount: json.data.length,
      dimensions: embedding.length,
      usage: json.usage,
    });
    observe({
      promptTokens: json.usage?.prompt_tokens,
      totalTokens: json.usage?.total_tokens,
      dimensions: embedding.length,
      responseSummary,
    });
    return { embedding, meta };
  } catch (error) {
    observe({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * 调用 OpenAI 兼容的 /embeddings 端点计算向量（只取向量；要元数据用
 * `computeEmbeddingWithMeta`）。
 */
export async function computeEmbedding(
  text: string,
  endpoint: EmbeddingEndpoint,
  model?: string,
  signal?: AbortSignal,
  onRequest?: EmbeddingRequestObserver,
): Promise<number[]> {
  const { embedding } = await computeEmbeddingWithMeta(text, endpoint, model, signal, onRequest);
  return embedding;
}

// ========== 相似度 ==========

/** 余弦相似度 — 值域 [-1, 1]，越大越相似 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// ========== 召回 ==========

/**
 * 召回结果。`score` 仅当 `source === 'cosine'` 时是真实余弦相似度；
 * `source === 'fallback'` 时恒为 0 —— 兜底记忆按 importance/recency 排序补齐，
 * **不假装它们的值是余弦分**（F09 核心不变量 4）。
 */
export interface RecalledMemory {
  memory: MemoryRecord;
  score: number;
  source: 'cosine' | 'fallback';
}

/** 一次召回的诊断摘要（不含全向量、不含任何凭据；F09 核心不变量 8） */
export interface RecallDiagnostics {
  /** 本次查询命中的空间指纹（查询向量生成成功时提供） */
  spaceId?: string;
  /** 查询端实际使用的模型 */
  queryModel?: string;
  /** 查询向量维度 */
  queryDimensions?: number;
  total: number;
  compatible: number;
  missing: number;
  incompatible: number;
  invalid: number;
  /** 最终结果里是否有兜底补槽 */
  fallbackUsed: boolean;
  /** 查询向量生成失败时的非致命诊断（区别于「记忆库无匹配」） */
  queryError?: string;
}

export type RecallObserver = (diag: RecallDiagnostics) => void;

/** importance desc，平手按 createdAt desc（recency）—— 兜底排序的唯一口径 */
function rankByImportanceRecency(memories: MemoryRecord[]): MemoryRecord[] {
  return [...memories].sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
}

/**
 * 基于 embedding 相似度召回 top-K 记忆（F09 重写）。
 *
 * 流程:
 * 1. 获取 saveId 下所有记忆
 * 2. 计算 query 的 embedding（同空间指纹；失败 → importance/recency 兜底 + 非致命诊断）
 * 3. 逐条分区：compatible / missing / incompatible / invalid —— 只给 compatible 算余弦
 * 4. compatible 按相似度降序，槽位不足由 fallback（importance/recency）补上
 * 5. 全程一条坏数据只跳过自己，绝不抛穿
 */
export async function recallMemories(
  saveId: string,
  query: string,
  topK: number,
  endpoint: EmbeddingEndpoint,
  signal?: AbortSignal,
  onEmbeddingRequest?: EmbeddingRequestObserver,
  onRecall?: RecallObserver,
): Promise<RecalledMemory[]> {
  const allMemories = await getMemories(saveId);
  const diag: RecallDiagnostics = {
    total: allMemories.length,
    compatible: 0,
    missing: 0,
    incompatible: 0,
    invalid: 0,
    fallbackUsed: false,
  };
  const reportDiag = () => {
    try {
      onRecall?.(diag);
    } catch (error) {
      console.warn('[memory-store] 召回诊断观察器失败（不影响召回）:', error);
    }
  };

  if (allMemories.length === 0) {
    reportDiag();
    return [];
  }

  // 计算查询向量（一次，捕获本次召回的空间配置；查询端失败不中止召回）
  let queryResult: { embedding: number[]; meta: EmbeddingMetadata };
  try {
    queryResult = await computeEmbeddingWithMeta(
      query,
      endpoint,
      undefined,
      signal,
      onEmbeddingRequest,
    );
    diag.spaceId = queryResult.meta.spaceId;
    diag.queryModel = queryResult.meta.model;
    diag.queryDimensions = queryResult.embedding.length;
  } catch (error) {
    diag.queryError = error instanceof Error ? error.message : String(error);
    reportDiag();
    // 兜底：按重要性 + 时间排序，score=0（不伪装成余弦分）
    return rankByImportanceRecency(allMemories)
      .slice(0, topK)
      .map((memory) => ({ memory, score: 0, source: 'fallback' as const }));
  }

  // 分区：只有 compatible 参与余弦排名
  const compatible: Array<{ memory: MemoryRecord; score: number }> = [];
  const fallbackPool: MemoryRecord[] = [];

  for (const memory of allMemories) {
    const cls = classifyStoredVector(
      memory.embedding,
      memory.embeddingMeta,
      queryResult.meta.spaceId,
      queryResult.embedding.length,
    );
    switch (cls.kind) {
      case 'compatible': {
        const stored = memory.embedding as number[];
        compatible.push({ memory, score: cosineSimilarity(queryResult.embedding, stored) });
        break;
      }
      case 'missing':
        diag.missing++;
        fallbackPool.push(memory);
        break;
      case 'incompatible':
        diag.incompatible++;
        fallbackPool.push(memory);
        break;
      case 'invalid':
        diag.invalid++;
        fallbackPool.push(memory);
        break;
    }
  }

  compatible.sort((a, b) => b.score - a.score);
  diag.compatible = compatible.length;

  const result: RecalledMemory[] = compatible
    .slice(0, topK)
    .map((item) => ({ memory: item.memory, score: item.score, source: 'cosine' as const }));

  // 兼容不足的槽位由 importance/recency 兜底补齐（不冒充余弦分）
  const fallback = rankByImportanceRecency(fallbackPool);
  for (const memory of fallback) {
    if (result.length >= topK) break;
    result.push({ memory, score: 0, source: 'fallback' as const });
  }
  diag.fallbackUsed = result.some((r) => r.source === 'fallback');

  reportDiag();
  return result;
}

// ========== 轮次计数 ==========

/**
 * 获取存档的当前轮次（用记忆数量近似）
 * 更精确的实现可以通过 SaveSlot.metadata.totalTurns
 */
export async function getRoundCount(saveId: string): Promise<number> {
  const memories = await getMemories(saveId);
  return memories.length;
}

// ========== 压缩检查 ==========

/**
 * 检查是否需要压缩旧记忆
 * 如果记忆数超过 threshold，返回需要压缩的记忆
 */
export async function checkCompressionNeeded(
  saveId: string,
  threshold: number,
): Promise<{ needed: boolean; oldMemories: MemoryRecord[] }> {
  const allMemories = await getMemories(saveId);
  if (allMemories.length <= threshold) {
    return { needed: false, oldMemories: [] };
  }

  // 取超出部分（最旧的）
  const sorted = allMemories.sort((a, b) => a.createdAt - b.createdAt);
  const excess = allMemories.length - threshold;
  const oldMemories = sorted.slice(0, excess);

  return { needed: true, oldMemories };
}

/**
 * 将旧记忆替换为压缩摘要
 *
 * 调用方应:
 * 1. 使用 memory_summary Agent 对 oldMemories 生成摘要
 * 2. 调用此函数: 删除旧记忆 + 保存摘要记忆
 *
 * @param saveId 存档 ID
 * @param oldMemories 需要被压缩的旧记忆
 * @param summaryMemory 压缩后的摘要记忆（已含 content/hiddenLine/keywords/importance/embedding）
 */
export async function applyCompression(
  saveId: string,
  oldMemories: MemoryRecord[],
  summaryMemory: MemoryRecord,
): Promise<void> {
  // 删除旧记忆（一次 bulkDelete，压缩一次可涉及几十条，逐条删就是几十次 IDB 往返）
  await deleteMemories(oldMemories.map((mem) => mem.id));

  // 保存摘要记忆
  await saveMemory(summaryMemory);
}

// ========== 带 Embedding 的记忆保存 ==========

/**
 * 保存记忆并计算其 embedding（向量与元数据原子成对，F09）。
 * 如果 embedding API 不可用**或响应非法**，则不带 embedding 保存
 * （此时 `embeddingMeta` 一并清空 —— 不允许出现「有向量无元数据」或
 * 「无向量有元数据」的孤儿字段）。
 *
 * 这条路径也是「显式重嵌入一条记忆」的入口（普通召回不会触发无界付费重嵌入；
 * 批量 reindex 属 F04 工作流，不在本模块自动做）。
 */
export async function saveMemoryWithEmbedding(
  memory: MemoryRecord,
  endpoint: EmbeddingEndpoint,
): Promise<MemoryRecord> {
  try {
    const embeddingText = buildEmbeddingText(memory.keywords, memory.content);
    const { embedding, meta } = await computeEmbeddingWithMeta(embeddingText, endpoint);
    memory.embedding = embedding;
    memory.embeddingMeta = meta;
  } catch {
    // Embedding 失败或响应非法 — 仍然保存记忆（无 embedding、无元数据，原子成对清理）
    memory.embedding = undefined;
    memory.embeddingMeta = undefined;
  }

  await saveMemory(memory);
  return memory;
}
