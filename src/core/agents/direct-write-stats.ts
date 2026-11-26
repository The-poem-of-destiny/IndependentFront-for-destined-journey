/**
 * direct-write-stats.ts — 直出一楼的状态写入统计（§7.1，只作参考，不设门槛）。
 *
 * 从 direct-main.ts 拆出（2026-11-25 整合审查 R2）。解析期由 generateDirectTurn 记初步值，
 * 接纳时由前端在建补丁后调 `summarizeStateWrites` 补全并记本楼唯一一条 `state.write_stats`。
 * 协议口径取草稿的 `stateProtocol`（生成时整轮取一次），不重读开关。
 */
import type { StateWriteStats } from '../types/types';
import { logEngine } from '../runtime/engine-logger';
import type { DirectPatchResult, DirectTurnDraft } from './direct-output';

/**
 * 一楼的状态写入统计。`built` 缺席 = 只算解析期（建补丁之前的初步值）。
 *
 * 口径：
 * - `dropped` = 解析期 + 建补丁期的丢弃说明条数，与调试面板「已忽略 N 项」、接纳后提示的数同一个数
 *   （含 character_updates、信封里 plot / diceUsed / tile_ops 等非 op 单元的丢弃）。
 * - tree：`ops` = 解析救回的 patch op 数 + `dropped`；建补丁后 `applied` / `corrected` 取翻译记录里
 *   「已应用」/「已纠正」的条数（逐条 op 计），建补丁前按「解析期带纠正说明的 op」算 `corrected`。
 * - legacy（含 tree 下回落旧形状的楼）没有逐条记录，按写入单元近似：`ops` = 解析后留下的
 *   entities + effects + state 各操作行 + tile_ops + character_updates 条目 + 时间推进（>0 计 1）
 *   + `dropped`；`corrected` = 无损纠正说明的处数（一个单元可能有多处，封顶到未丢弃的单元数），
 *   `applied` = 其余。
 * - 缺 direct_updates 区块的楼 `updatesMissing: true`，op 只来自 character_updates。
 */
export function summarizeStateWrites(
  protocol: 'legacy' | 'tree',
  draft: DirectTurnDraft,
  built?: Pick<DirectPatchResult, 'dropped' | 'stateUpdates'>,
): StateWriteStats {
  const dropped = (draft.dropped?.length ?? 0) + (built?.dropped.length ?? 0);
  let applied: number;
  let corrected: number;
  if (draft.treePatch) {
    const records = built?.stateUpdates?.ops;
    if (records) {
      applied = records.filter((r) => r.status === '已应用' || r.status === '已手动修订').length;
      corrected = records.filter((r) => r.status === '已纠正').length;
    } else {
      const recovered = draft.treePatch.ops.length;
      corrected = Math.min(recovered, new Set(draft.treePatch.normalized.map((n) => n.index)).size);
      applied = recovered - corrected;
    }
  } else {
    const kept = Math.max(0, countLegacyWriteUnits(draft) - (built?.dropped.length ?? 0));
    corrected = Math.min(kept, draft.normalized?.length ?? 0);
    applied = kept - corrected;
  }
  return {
    protocol,
    ops: applied + corrected + dropped,
    applied,
    corrected,
    dropped,
    rejected: false,
    ...(draft.updatesMissing ? { updatesMissing: true as const } : {}),
  };
}

/** 整楼拒收的一楼：只记这一条统计（被接纳的楼由调用方在建补丁后补全） */
export function rejectedStateWrites(protocol: 'legacy' | 'tree'): StateWriteStats {
  return { protocol, ops: 0, applied: 0, corrected: 0, dropped: 0, rejected: true };
}

/** 旧形状一楼的写入单元数（解析期丢弃的单元已不在草稿里） */
function countLegacyWriteUnits(draft: DirectTurnDraft): number {
  const rows = (value: unknown): number => {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object')
      return Object.values(value).reduce<number>((sum, v) => sum + rows(v), 0);
    return value === undefined || value === null ? 0 : 1;
  };
  const { updates } = draft;
  const tileOps = (updates.world as { tile_ops?: unknown } | undefined)?.tile_ops;
  return (
    (updates.entities?.length ?? 0) +
    (updates.effects?.length ?? 0) +
    rows(updates.state) +
    (Array.isArray(tileOps) ? tileOps.length : 0) +
    draft.characterUpdates.length +
    ((updates.time?.delta_time ?? 0) > 0 ? 1 : 0)
  );
}

/** 记一楼的 `state.write_stats` 日志事件（每楼一条；payload 带模型名供离线脚本按模型分组） */
export function logStateWriteStats(stats: StateWriteStats, model: string): void {
  logEngine(
    'info',
    'state.write_stats',
    stats.rejected
      ? `状态写入统计（${stats.protocol}）：整楼拒收`
      : `状态写入统计（${stats.protocol}）：${stats.ops} 条，应用 ${stats.applied}，纠正 ${stats.corrected}，丢弃 ${stats.dropped}`,
    () => ({ ...stats, model }),
    { agentId: 'direct_main' },
  );
}
