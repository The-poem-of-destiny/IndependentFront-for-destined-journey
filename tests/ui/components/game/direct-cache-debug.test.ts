/**
 * direct-cache-debug.ts — 缓存直出记账的展示层判定
 */
import { describe, expect, it } from 'vitest';
import { buildDirectCacheDebugView } from '../../../../src/ui/components/game/direct-cache-debug';
import type { DirectCacheDiagnostics } from '@engine/types/types';

function diagnostics(patch: Partial<DirectCacheDiagnostics> = {}): DirectCacheDiagnostics {
  return {
    rebased: false,
    requestChars: 1200,
    baselineChars: 1000,
    growthLimit: 1.4,
    tailChars: 30,
    sections: [
      { key: 'state/主角', action: 'set', chars: 300 },
      { key: 'memory/12', action: 'set', chars: 100 },
    ],
    ...patch,
  };
}

describe('buildDirectCacheDebugView', () => {
  it('字段缺席时返回 null', () => {
    expect(buildDirectCacheDebugView(undefined)).toBeNull();
  });

  it('累计倍数 = 请求 / 基线，并给出上限与距重建的字符余量', () => {
    const view = buildDirectCacheDebugView(diagnostics())!;
    expect(view.growthRatio).toBeCloseTo(1.2);
    expect(view.growthLimit).toBe(1.4);
    expect(view.headroomChars).toBe(200);
    expect(view.growthSummary).toBe('累计 1.20 倍 / 上限 1.40 倍 · 距重建约 200 字符');
    expect(view.rebased).toBe(false);
  });

  it('估算 token 按字符数 / 1.5 向上取整', () => {
    const view = buildDirectCacheDebugView(diagnostics())!;
    expect(view.requestTokens).toBe(800);
    expect(view.baselineTokens).toBe(667);
    expect(view.rows[1]).toMatchObject({ chars: 100, estimatedTokens: 67 });
    expect(view.tailChars).toBe(30);
    expect(view.tailTokens).toBe(20);
  });

  it('基线为 0 时不显示倍数', () => {
    const view = buildDirectCacheDebugView(diagnostics({ baselineChars: 0 }))!;
    expect(view.growthRatio).toBeNull();
    expect(view.headroomChars).toBeNull();
    expect(view.growthSummary).not.toContain('累计');
    expect(view.growthSummary).toContain('上限 1.40 倍');
  });

  it('超过上限时余量记 0，不出负数', () => {
    const view = buildDirectCacheDebugView(diagnostics({ requestChars: 1500 }))!;
    expect(view.headroomChars).toBe(0);
  });

  it('移除行标「移除」、字符数 0；发送行标「发送」', () => {
    const view = buildDirectCacheDebugView(
      diagnostics({
        sections: [
          { key: 'state/主角', action: 'set', chars: 300 },
          { key: 'region/旧城', action: 'remove', chars: 0 },
        ],
      }),
    )!;
    expect(view.rows).toEqual([
      { key: 'state/主角', kind: 'set', actionLabel: '发送', chars: 300, estimatedTokens: 200 },
      { key: 'region/旧城', kind: 'remove', actionLabel: '移除', chars: 0, estimatedTokens: 0 },
    ]);
  });

  it('otherSections 存在时追加「其余 N 项」一行', () => {
    const view = buildDirectCacheDebugView(
      diagnostics({ otherSections: { count: 5, chars: 45 } }),
    )!;
    expect(view.rows).toHaveLength(3);
    expect(view.rows[2]).toEqual({
      key: '其余 5 项',
      kind: 'other',
      actionLabel: '—',
      chars: 45,
      estimatedTokens: 30,
    });
  });

  it('空分区时没有分区行，尾部仍在', () => {
    const view = buildDirectCacheDebugView(diagnostics({ sections: [], tailChars: 0 }))!;
    expect(view.rows).toEqual([]);
    expect(view.tailChars).toBe(0);
    expect(view.tailTokens).toBe(0);
  });
});
