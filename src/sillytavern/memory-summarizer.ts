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

import type { MemoryRecord } from './types';
import { getAllMemoryIds, saveMemory } from './database';
import { computeEmbedding } from './memory-store';
// Q-05：从模型输出抢救 JSON 的唯一入口
import { parseModelJson } from './model-json';
// 并行化改造：MEM 编号是全库分配（跨存档），「分配 + 落库」必须同段互斥，
// 否则并发两侧都分到同一个号、后写静默覆盖（state-write-queue 全局锁）。
import { withGlobalWriteLock } from './state-write-queue';

// ========== 常量 ==========

/**
 * 记忆正文最低字数门槛（Q-03 裁定：引擎侧 200 与 UI 侧 50 的分歧，统一取 100）。
 * 唯一真源 —— UI 侧（game-pipeline.persistMemorySummary）不得自带阈值。
 */
export const MEMORY_MIN_CHARS = 100;

// ========== MEM 编号 ==========

/**
 * MEM 编号分配器（纯函数）—— **全仓唯一一份**，`session-backup.ts` 导入同一个实现。
 *
 * 🔴 **编号必须按全库分配，不能按存档分配**：`memories` 表的主键 `id` 是**全局主键**
 * （`saveId` 只是索引），所以两个存档各自从 MEM000001 数下去时，第二个存档的
 * `saveMemory()` 是 Dexie `put` —— 它会**静默覆盖**第一个存档的那一行。表现是
 * 「另一个周目的记忆莫名其妙变成了这个周目的内容」，不报错、不掉行数。
 *
 * 位数规则是**补齐到至少 6 位**而不是截断到 6 位：超过 999999 条时编号自然变长，
 * 正则 `/^MEM(\d{6,})$/` 照样认得，截断则会重新撞号。
 */
export function allocateMemoryIds(existingIds: string[], count: number): string[] {
  let maxNum = 0;
  for (const id of existingIds) {
    const m = /^MEM(\d{6,})$/.exec(id);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > maxNum) maxNum = n;
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`MEM${String(maxNum + 1 + i).padStart(6, '0')}`);
  }
  return out;
}

/**
 * 生成下一条记忆的 ID（格式: MEM + 至少 6 位编号）。
 *
 * 扫的是**全库**（所有存档）的最大号 +1 —— 理由见 {@link allocateMemoryIds}。
 * 故本函数**不收 saveId**：收了会让调用方以为编号是按存档分配的，而那正是被修掉的 bug。
 */
export async function generateMemoryId(): Promise<string> {
  const existingIds = await getAllMemoryIds();
  return allocateMemoryIds(existingIds, 1)[0];
}

// ========== 校验 ==========

/** 校验记忆正文是否满足最低字数要求（门槛统一取 MEMORY_MIN_CHARS，Q-03） */
export function validateMemoryContent(
  content: string,
  minChars: number = MEMORY_MIN_CHARS,
): {
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

/**
 * 剥掉 AI 输出外层可能包裹的 <json>...</json> 围栏（Q-03 下沉 UI 侧方言）。
 * UI 侧（game-pipeline.persistMemorySummary）曾有内联剥壳，现统一在此。
 */
export function stripJsonEnvelope(raw: string): string {
  const m = raw.match(/<json>([\s\S]*?)<\/json>/);
  return m ? m[1].trim() : raw.trim();
}

/** memory_summary Agent 的输出结构 */
export interface MemorySummaryOutput {
  content: string;
  hiddenLine: string;
  keywords: string[];
  importance: number;
  timeRangeStart: string;
  timeRangeEnd: string;
}

/**
 * 解析 memory_summary Agent 的 JSON 输出。
 *
 * Q-05：剥壳与兜底分家 —— `model-json` 认四种包裹形态，这里只留一条校验口径。
 * 旧实现主/兜底两个分支的必填字段判据不一样（主分支要求 keywords 是数组、兜底分支不要求），
 * 同一份输出走哪条路结果不同。**统一到严格的那份**：keywords 不是数组即整条不落库，
 * 与 Q-03 裁定「hiddenLine 缺失不落库」同一口径 —— 记忆宁缺毋滥。
 */
export function parseMemorySummaryOutput(rawOutput: string): MemorySummaryOutput | null {
  return parseModelJson<MemorySummaryOutput>(rawOutput, (p) => {
    const o = (p ?? {}) as Partial<MemorySummaryOutput>;
    if (!o.content || !o.hiddenLine || !Array.isArray(o.keywords)) return null;
    return {
      content: o.content,
      hiddenLine: o.hiddenLine,
      keywords: o.keywords.slice(0, 8),
      importance: Math.max(1, Math.min(10, o.importance || 5)),
      timeRangeStart: o.timeRangeStart || '未知',
      timeRangeEnd: o.timeRangeEnd || '未知',
    };
  });
}

// ========== 总结 & 保存 ==========

export interface SummarizeAndSaveOptions {
  saveId: string;
  /** memory_summary Agent 的原始输出文本 */
  agentRawOutput: string;
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
export async function summarizeAndSave(
  options: SummarizeAndSaveOptions,
): Promise<MemoryRecord | null> {
  const {
    saveId,
    agentRawOutput,
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

  // 🔴 并行化改造：「分配 id → 组装 → embedding → 保存」必须在同一个全局锁段内。
  // id 是全库唯一（`generateMemoryId` 扫全库最大号 +1），分到号但没落库就放锁，
  // 另一个任务扫库看不到这个号、也会分到它 —— 后写覆盖先写（丢一条记忆且零报错）。
  // embedding 是网络调用，会 hold 住全局锁 1-3 秒；竞争方只有「另一次记忆写入」
  // （低频），可接受 —— 不能把 embedding 挪出锁外，那会重新开撞号窗口。
  return withGlobalWriteLock(async () => {
    // 3. 生成 ID（全库唯一，不按存档编号）
    const id = await generateMemoryId();

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
  });
}

// ========== 压缩摘要辅助 ==========

/**
 * 为压缩操作生成摘要记忆
 * 用于压缩 N 条旧记忆为 1 条摘要
 *
 * M6 #50: 内部通过 generateMemoryId() 补全 id，直接返回完整 MemoryRecord（不再要求调用方补 id）
 */
export async function createCompressionSummaryMemory(
  saveId: string,
  oldMemories: MemoryRecord[],
  summaryText: string,
  hiddenLine: string,
  keywords: string[],
  importance: number,
): Promise<MemoryRecord> {
  // 🔴 并行化改造：分配段入全局锁（与 summarizeAndSave 的「分配+落库」段互斥，
  // 防两个压缩任务分到同一个号）。⚠️ 已知残余窗口：写库发生在调用方的
  // applyCompression（另一个函数），分配与写入之间理论上仍可被别的任务抢号 ——
  // 压缩是用户手动低频操作，现状串行时窗口同样存在，本次不扩大不修复。
  const id = await withGlobalWriteLock(() => generateMemoryId());
  const now = Date.now();
  const earliestTime = oldMemories.reduce(
    (min, m) => (m.createdAt < min ? m.createdAt : min),
    oldMemories[0]?.createdAt ?? now,
  );

  return {
    id,
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
