/**
 * engine-log-store.ts — 引擎日志的 Dexie 落盘实现（v34 `engineLogs`，2026-11-16 T1）。
 *
 * 用途：给 `runtime/engine-logger.ts` 的 sink 缝提供生产实现，并提供导出 / 统计 / 清空等读写入口。
 *
 * 关键约定：
 * - 本模块是 sink 缝的**唯一**生产实现；由前端在 `src/ui/main.ts` 安装。引擎默认不装，
 *   于是引擎单测保持纯内存行为、零 Dexie 依赖（照 `prompts/prompt-session-store.ts` 的先例）。
 * - 写入**不进** `withSaveWriteLock`：日志不参与任何存档状态的读-改-写，串行由日志器保证。
 * - 淘汰随写入发生：每个 saveId 只留最近 100 个回合层（用 `[saveId+layer]` 索引求边界后范围删除）；
 *   层 0（应用级 / 无回合）的条目按 `(saveId, 0)` 分桶，每桶最多 2000 条，按 seq 删最旧。
 * - 该表**不进 FullBackup、不进单存档导出**；删存档级联删。装着受保护内容包时照常落盘
 *   （主人裁定，明文风险写在开关说明里）：每次启动的 `purgeProtectedPackPlaintext` 与内容包
 *   安装事务都**不清**它，只有一次性的 `migrateLegacyContentPacks` 会清。
 */

import Dexie from 'dexie';
import { getDatabase } from './database';
import { NO_TURN_LAYER } from '../runtime/engine-logger';
import type { EngineLogEntry, EngineLogLayerHead, EngineLogSink } from '../runtime/engine-logger';

/** 每个存档保留的回合层数 */
const LAYERS_PER_SAVE = 100;
/** 每个 `(saveId, 层 0)` 桶保留的条目数 */
const UNLAYERED_CAP = 2000;
/** 导出分页的默认页大小 */
const DEFAULT_PAGE_SIZE = 200;

/** 某存档当前最大回合层号及其开层依据；没有任何回合层时为 `{ layer: 0 }` */
export async function getEngineLogLayerHead(saveId: string): Promise<EngineLogLayerHead> {
  const last = await getDatabase()
    .engineLogs.where('[saveId+layer]')
    .between([saveId, NO_TURN_LAYER + 1], [saveId, Dexie.maxKey], true, true)
    .last();
  if (!last) return { layer: NO_TURN_LAYER };
  return last.layerKey !== undefined
    ? { layer: last.layer, layerKey: last.layerKey }
    : { layer: last.layer };
}

/** 引擎日志 sink 的 Dexie 实现（生产安装用） */
export function createDexieEngineLogSink(): EngineLogSink {
  /** 每个存档已淘汰到的层号（本会话内缓存，免得每批都跑一次空的范围删除） */
  const evictedThrough = new Map<string, number>();
  return {
    getLayerHead: getEngineLogLayerHead,
    async write(entries) {
      if (entries.length === 0) return;
      const db = getDatabase();
      const rows = entries.map((entry) => {
        const row = { ...entry };
        delete row.seq;
        return row;
      });
      const topLayer = new Map<string, number>();
      const unlayered = new Set<string>();
      for (const row of rows) {
        if (row.layer > NO_TURN_LAYER) {
          topLayer.set(row.saveId, Math.max(topLayer.get(row.saveId) ?? 0, row.layer));
        } else {
          unlayered.add(row.saveId);
        }
      }
      const evicted = new Map<string, number>();
      await db.transaction('rw', db.engineLogs, async () => {
        await db.engineLogs.bulkAdd(rows);
        for (const [saveId, top] of topLayer) {
          const boundary = top - LAYERS_PER_SAVE;
          if (boundary < 1 || (evictedThrough.get(saveId) ?? 0) >= boundary) continue;
          await db.engineLogs
            .where('[saveId+layer]')
            .between([saveId, NO_TURN_LAYER + 1], [saveId, boundary], true, true)
            .delete();
          evicted.set(saveId, boundary);
        }
        for (const saveId of unlayered) {
          const bucket = db.engineLogs.where('[saveId+layer]').equals([saveId, NO_TURN_LAYER]);
          const count = await bucket.count();
          if (count <= UNLAYERED_CAP) continue;
          // 同一索引键下按主键（seq）升序 —— 取前 overflow 个即最旧
          const stale = await db.engineLogs
            .where('[saveId+layer]')
            .equals([saveId, NO_TURN_LAYER])
            .limit(count - UNLAYERED_CAP)
            .primaryKeys();
          await db.engineLogs.bulkDelete(stale);
        }
      });
      // 事务提交后才记缓存：回滚时下次还会重删
      for (const [saveId, boundary] of evicted) evictedThrough.set(saveId, boundary);
    },
  };
}

/**
 * 按 seq 升序分页读取（导出用）：返回 seq > `afterSeq` 的至多 `limit` 条。
 * 给了 `saveId` 时只取该存档（应用级条目用 `APP_LOG_SAVE_ID`）。
 */
export async function readEngineLogPage(
  options: { afterSeq?: number; limit?: number; saveId?: string } = {},
): Promise<EngineLogEntry[]> {
  const { afterSeq = 0, limit = DEFAULT_PAGE_SIZE, saveId } = options;
  let collection = getDatabase().engineLogs.where('seq').above(afterSeq);
  if (saveId !== undefined) collection = collection.filter((entry) => entry.saveId === saveId);
  return collection.limit(limit).toArray();
}

/**
 * 一条日志 → 一行 JSONL（不含换行）。payload 是合法 JSON 时原样嵌入为 `payload` 的值，
 * 否则（空串或异常文本）作为字符串嵌入。
 */
export function formatEngineLogLine(entry: EngineLogEntry): string {
  const { payload, ...rest } = entry;
  const head = JSON.stringify(rest);
  if (!payload) return head;
  let embedded = JSON.stringify(payload);
  try {
    JSON.parse(payload);
    embedded = payload;
  } catch {
    // 不是合法 JSON：保持字符串嵌入
  }
  return `${head.slice(0, -1)},"payload":${embedded}}`;
}

export async function countEngineLogs(): Promise<number> {
  return getDatabase().engineLogs.count();
}

export async function clearEngineLogs(): Promise<void> {
  await getDatabase().engineLogs.clear();
}
