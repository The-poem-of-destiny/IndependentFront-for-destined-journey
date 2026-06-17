/**
 * 记忆召回引擎 — Embedding 向量检索 + 余弦相似度排序 + 压缩触发
 *
 * Phase 4 核心模块。职责:
 * 1. 调用 Embedding API 计算向量
 * 2. 余弦相似度排序 → top-K 召回
 * 3. 定期触发记忆压缩（旧记忆 → 单条摘要）
 */

import type { MemoryRecord, ApiEndpoint } from './types';
import {
  getMemories, getRecentMemories, saveMemory, deleteMemory,
} from './database';

// ========== Embedding ==========

/**
 * 调用 OpenAI 兼容的 /embeddings 端点计算向量
 * 直接使用 fetch（浏览器/Node 18+ 均可用）
 */
export async function computeEmbedding(
  text: string,
  endpoint: { baseUrl: string; apiKey: string; defaultModel: string },
  model?: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const body = JSON.stringify({
    model: model || endpoint.defaultModel,
    input: text,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${endpoint.apiKey}`,
    },
    body,
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Embedding API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json() as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  const embedding = json.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Embedding API 返回数据格式异常');
  }

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

/** 召回结果 */
export interface RecalledMemory {
  memory: MemoryRecord;
  score: number;           // 余弦相似度
}

/**
 * 基于 embedding 相似度召回 top-K 记忆
 *
 * 流程:
 * 1. 获取 saveId 下所有记忆
 * 2. 计算 query 的 embedding
 * 3. 对已有 embedding 的记忆计算余弦相似度
 * 4. 按相似度降序排序，取 topK
 * 5. 没有 embedding 的记忆排在后面（按重要度排序）
 */
export async function recallMemories(
  saveId: string,
  query: string,
  topK: number,
  endpoint: { baseUrl: string; apiKey: string; defaultModel: string },
  signal?: AbortSignal,
): Promise<RecalledMemory[]> {
  const allMemories = await getMemories(saveId);
  if (allMemories.length === 0) return [];

  // 计算查询向量
  let queryEmbedding: number[];
  try {
    queryEmbedding = await computeEmbedding(query, endpoint, undefined, signal);
  } catch {
    // Embedding API 失败 → 回退到按重要度 + 时间排序
    return allMemories
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, topK)
      .map(m => ({ memory: m, score: 0 }));
  }

  // 有 embedding 的记忆：余弦相似度
  const withEmbedding: RecalledMemory[] = [];
  const withoutEmbedding: RecalledMemory[] = [];

  for (const mem of allMemories) {
    if (mem.embedding && mem.embedding.length > 0) {
      withEmbedding.push({
        memory: mem,
        score: cosineSimilarity(queryEmbedding, mem.embedding),
      });
    } else {
      withoutEmbedding.push({ memory: mem, score: 0 });
    }
  }

  // 按相似度降序
  withEmbedding.sort((a, b) => b.score - a.score);

  // 没有 embedding 的按重要度降序
  withoutEmbedding.sort((a, b) => b.memory.importance - a.memory.importance);

  // 合并：有 embedding 的在前，然后 topK
  const ranked = [...withEmbedding, ...withoutEmbedding];
  return ranked.slice(0, topK);
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
  // 删除旧记忆
  for (const mem of oldMemories) {
    await deleteMemory(mem.id);
  }

  // 保存摘要记忆
  await saveMemory(summaryMemory);
}

// ========== 带 Embedding 的记忆保存 ==========

/**
 * 保存记忆并计算其 embedding
 * 如果 embedding API 不可用，则不带 embedding 保存
 */
export async function saveMemoryWithEmbedding(
  memory: MemoryRecord,
  endpoint: { baseUrl: string; apiKey: string; defaultModel: string },
): Promise<MemoryRecord> {
  try {
    const embeddingText = `[${memory.keywords.join(', ')}] ${memory.content}`;
    const embedding = await computeEmbedding(embeddingText, endpoint);
    memory.embedding = embedding;
  } catch {
    // Embedding 失败 — 仍然保存记忆（无 embedding）
    memory.embedding = undefined;
  }

  await saveMemory(memory);
  return memory;
}
