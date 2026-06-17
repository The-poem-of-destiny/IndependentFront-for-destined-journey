/**
 * 记忆总结引擎 — 每轮记忆总结 + MEM 编号生成 + Embedding 计算 + 持久化
 *
 * Phase 4 核心模块。职责:
 * 1. 生成自增 MEM 编号 (MEM000001, MEM000002...)
 * 2. 编排 memory_summary Agent → 获取结构化记忆
 * 3. 校验 content ≥ 200 字
 * 4. 计算 embedding 向量
 * 5. 持久化到 IndexedDB
 */

import type { MemoryRecord, AgentContext } from './types';
import { getMemories, saveMemory } from './database';
import { computeEmbedding } from './memory-store';

// ========== MEM 编号 ==========

/** 生成下一条记忆的 ID（格式: MEM + 6 位编号） */
export async function generateMemoryId(saveId: string): Promise<string> {
  const memories = await getMemories(saveId);

  let maxNum = 0;
  for (const m of memories) {
    const match = m.id.match(/^MEM(\d{6})$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum + 1;
  return `MEM${String(nextNum).padStart(6, '0')}`;
}

// ========== 校验 ==========

/** 校验记忆正文是否满足最低字数要求 */
export function validateMemoryContent(content: string, minChars: number = 200): {
  valid: boolean;
  reason?: string;
} {
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: '记忆正文为空' };
  }
  if (content.length < minChars) {
    return {
      valid: false,
      reason: `记忆正文不足 ${minChars} 字（当前 ${content.length} 字）`,
    };
  }
  return { valid: true };
}

// ========== Agent 输出解析 ==========

/** memory_summary Agent 的输出结构 */
export interface MemorySummaryOutput {
  content: string;
  hiddenLine: string;
  keywords: string[];
  importance: number;
  timeRangeStart: string;
  timeRangeEnd: string;
}

/** 解析 memory_summary Agent 的 JSON 输出 */
export function parseMemorySummaryOutput(rawOutput: string): MemorySummaryOutput | null {
  try {
    // 尝试直接解析 JSON
    const parsed = JSON.parse(rawOutput) as MemorySummaryOutput;

    if (!parsed.content || !parsed.hiddenLine || !Array.isArray(parsed.keywords)) {
      return null;
    }

    return {
      content: parsed.content,
      hiddenLine: parsed.hiddenLine,
      keywords: parsed.keywords.slice(0, 8),
      importance: Math.max(1, Math.min(10, parsed.importance || 5)),
      timeRangeStart: parsed.timeRangeStart || '未知',
      timeRangeEnd: parsed.timeRangeEnd || '未知',
    };
  } catch {
    // 尝试从文本中提取 JSON
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as MemorySummaryOutput;
      if (!parsed.content || !parsed.hiddenLine) return null;

      return {
        content: parsed.content,
        hiddenLine: parsed.hiddenLine,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [],
        importance: Math.max(1, Math.min(10, parsed.importance || 5)),
        timeRangeStart: parsed.timeRangeStart || '未知',
        timeRangeEnd: parsed.timeRangeEnd || '未知',
      };
    } catch {
      return null;
    }
  }
}

// ========== 总结 & 保存 ==========

export interface SummarizeAndSaveOptions {
  saveId: string;
  /** memory_summary Agent 的原始输出文本 */
  agentRawOutput: string;
  /** 关联的剧情事件 ID（可选） */
  relatedPlotEventId?: string;
  /** 关联的角色 ID 列表 */
  relatedCharacterIds?: string[];
  /** Embedding API 端点（可选，不提供则不计算 embedding） */
  embeddingEndpoint?: { baseUrl: string; apiKey: string; defaultModel: string };
  /** 游戏时间 */
  gameTimeRange?: { start: string; end: string };
}

/**
 * 编排完整的记忆总结流程:
 * 1. 解析 Agent 输出
 * 2. 校验 content ≥ 200 字
 * 3. 生成 MEM 编号
 * 4. 计算 embedding
 * 5. 持久化
 */
export async function summarizeAndSave(options: SummarizeAndSaveOptions): Promise<MemoryRecord | null> {
  const {
    saveId,
    agentRawOutput,
    relatedPlotEventId,
    relatedCharacterIds = [],
    embeddingEndpoint,
    gameTimeRange,
  } = options;

  // 1. 解析
  const parsed = parseMemorySummaryOutput(agentRawOutput);
  if (!parsed) {
    throw new Error('无法解析 memory_summary Agent 的输出');
  }

  // 2. 校验
  const validation = validateMemoryContent(parsed.content);
  if (!validation.valid) {
    throw new Error(`记忆校验失败: ${validation.reason}`);
  }

  // 3. 生成 ID
  const id = await generateMemoryId(saveId);

  const now = Date.now();
  const memory: MemoryRecord = {
    id,
    saveId,
    createdAt: now,
    realTimestamp: now,
    timeRange: gameTimeRange || {
      start: parsed.timeRangeStart,
      end: parsed.timeRangeEnd,
    },
    content: parsed.content,
    hiddenLine: parsed.hiddenLine,
    keywords: parsed.keywords,
    relatedCharacterIds,
    relatedPlotEventId,
    importance: parsed.importance,
  };

  // 4. 计算 embedding
  if (embeddingEndpoint) {
    try {
      const embeddingText = `[${parsed.keywords.join(', ')}] ${parsed.content}`;
      memory.embedding = await computeEmbedding(embeddingText, embeddingEndpoint);
    } catch {
      // Embedding 不可用 — 保存无 embedding 的记忆
      memory.embedding = undefined;
    }
  }

  // 5. 持久化
  await saveMemory(memory);
  return memory;
}

// ========== 压缩摘要辅助 ==========

/**
 * 为压缩操作生成摘要记忆
 * 用于压缩 N 条旧记忆为 1 条摘要
 */
export function createCompressionSummaryMemory(
  saveId: string,
  oldMemories: MemoryRecord[],
  summaryText: string,
  hiddenLine: string,
  keywords: string[],
  importance: number,
): Omit<MemoryRecord, 'id' | 'embedding'> {
  const now = Date.now();
  const earliestTime = oldMemories.reduce(
    (min, m) => m.createdAt < min ? m.createdAt : min,
    oldMemories[0]?.createdAt ?? now,
  );

  return {
    saveId,
    createdAt: earliestTime,
    realTimestamp: now,
    timeRange: {
      start: oldMemories[0]?.timeRange.start ?? '未知',
      end: oldMemories[oldMemories.length - 1]?.timeRange.end ?? '未知',
    },
    content: summaryText,
    hiddenLine,
    keywords,
    relatedCharacterIds: [],
    importance,
  };
}
