/**
 * direct-cache-debug.ts — 调试面板「缓存直出记账」块的展示层判定（纯函数）
 *
 * 只把引擎给的 `DirectCacheDiagnostics` 换成展示数据，不另算重建判定：
 * 是否重建以引擎记下的 `rebased` 为准，倍数与余量只是同一组数字的读法。
 * 字符数是引擎估算口径，token 一律是「字符数 / 1.5 向上取整」的估算，不是渠道用量。
 */
import type { DirectCacheDiagnostics } from '@engine/types/types';

/** 与引擎估算同一口径：字符数 / 1.5 向上取整 */
function estimateDirectCacheTokens(chars: number): number {
  return Math.ceil(chars / 1.5);
}

interface DirectCacheSectionRow {
  /** 分区键；「其余」行为「其余 N 项」 */
  key: string;
  kind: 'set' | 'remove' | 'other';
  actionLabel: string;
  chars: number;
  estimatedTokens: number;
}

export interface DirectCacheDebugView {
  rebased: boolean;
  requestChars: number;
  requestTokens: number;
  baselineChars: number;
  baselineTokens: number;
  /** requestChars / baselineChars；基线为 0 时为 null（不显示倍数） */
  growthRatio: number | null;
  growthLimit: number;
  /** 再增长多少字符会超过上限；基线为 0 时为 null */
  headroomChars: number | null;
  /** 一行概述：累计倍数 / 上限 / 余量 */
  growthSummary: string;
  rows: DirectCacheSectionRow[];
  tailChars: number;
  tailTokens: number;
}

function formatRatio(value: number): string {
  return value.toFixed(2);
}

export function buildDirectCacheDebugView(
  diagnostics: DirectCacheDiagnostics | undefined,
): DirectCacheDebugView | null {
  if (!diagnostics) return null;
  const { requestChars, baselineChars, growthLimit } = diagnostics;
  const growthRatio = baselineChars > 0 ? requestChars / baselineChars : null;
  const headroomChars =
    baselineChars > 0 ? Math.max(0, Math.floor(growthLimit * baselineChars - requestChars)) : null;
  const growthSummary =
    growthRatio === null
      ? `基线 0 字符，不计倍数 · 上限 ${formatRatio(growthLimit)} 倍`
      : `累计 ${formatRatio(growthRatio)} 倍 / 上限 ${formatRatio(growthLimit)} 倍 · 距重建约 ${headroomChars} 字符`;

  const rows: DirectCacheSectionRow[] = diagnostics.sections.map((section) => ({
    key: section.key,
    kind: section.action,
    actionLabel: section.action === 'set' ? '发送' : '移除',
    chars: section.chars,
    estimatedTokens: estimateDirectCacheTokens(section.chars),
  }));
  if (diagnostics.otherSections) {
    rows.push({
      key: `其余 ${diagnostics.otherSections.count} 项`,
      kind: 'other',
      actionLabel: '—',
      chars: diagnostics.otherSections.chars,
      estimatedTokens: estimateDirectCacheTokens(diagnostics.otherSections.chars),
    });
  }

  return {
    rebased: diagnostics.rebased,
    requestChars,
    requestTokens: estimateDirectCacheTokens(requestChars),
    baselineChars,
    baselineTokens: estimateDirectCacheTokens(baselineChars),
    growthRatio,
    growthLimit,
    headroomChars,
    growthSummary,
    rows,
    tailChars: diagnostics.tailChars,
    tailTokens: estimateDirectCacheTokens(diagnostics.tailChars),
  };
}
