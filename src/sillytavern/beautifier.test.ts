/**
 * beautifier.test.ts —— 美化器核心纯函数（autoEnable 解析 + 信号提取）
 *
 * 🔴 2026-08-02 回归防护：`resolveAutoEnable` 三维匹配契约钉死。
 * 注意：**游戏内激活信号按「启用的世界书条目」**（useBeautify 只传 worldBookIds/
 * worldBookEntryUids，不传 characterNames）——角色是否在场不影响规则激活。
 * characterNames 维度仍保留为引擎函数能力（部分角色标签美化规则同时绑了 uid），
 * 但消费方（useBeautify）不依赖它做游戏内判断。
 */
import { describe, it, expect } from 'vitest';
import { resolveAutoEnable, collectActiveSignalsFromEntries } from './beautifier';
import type { BeautifierRule } from './types';

function rule(over: Partial<BeautifierRule>): BeautifierRule {
  return {
    id: 'r1',
    name: '测试规则',
    scope: 'maintext',
    pattern: 'x',
    flags: 'g',
    replacement: 'y',
    enabled: false,
    order: 0,
    isBuiltin: true,
    locked: false,
    ...over,
  };
}

// ========== collectActiveSignalsFromEntries ==========

describe('collectActiveSignalsFromEntries', () => {
  it('解析 partition:uid 到 worldBookIds + entryUids', () => {
    const r = collectActiveSignalsFromEntries(['system_core:413', 'dlc:100']);
    expect(r.activeEntryUids.has(413)).toBe(true);
    expect(r.activeEntryUids.has(100)).toBe(true);
    expect(r.activeWorldBookIds.has('system_core')).toBe(true);
    expect(r.activeWorldBookIds.has('dlc')).toBe(true);
  });

  it('无冒号的条目被忽略', () => {
    const r = collectActiveSignalsFromEntries(['invalid', 'system_core:413']);
    expect(r.activeEntryUids.size).toBe(1);
    expect(r.activeEntryUids.has(413)).toBe(true);
  });

  it('空数组 → 空集合', () => {
    const r = collectActiveSignalsFromEntries([]);
    expect(r.activeEntryUids.size).toBe(0);
    expect(r.activeWorldBookIds.size).toBe(0);
  });
});

// ========== resolveAutoEnable 三维匹配 ==========

describe('resolveAutoEnable — worldBookEntryUids 维度', () => {
  it('命中 uid → enabled + locked', () => {
    const r = rule({ autoEnable: { worldBookEntryUids: [413] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set([413]), new Set());
    expect(out.enabled).toBe(true);
    expect(out.locked).toBe(true);
  });

  it('未命中 → 保持 disabled', () => {
    const r = rule({ autoEnable: { worldBookEntryUids: [413] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set([999]), new Set());
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — characterNames 维度（🔴 修复核心）', () => {
  it('命中角色名 → enabled + locked（如 <dalian> 规则靠妲丽安激活）', () => {
    const r = rule({ autoEnable: { characterNames: ['妲丽安'] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set(['妲丽安']));
    expect(out.enabled).toBe(true);
    expect(out.locked).toBe(true);
  });

  it('角色名未在场 → 保持 disabled', () => {
    const r = rule({ autoEnable: { characterNames: ['妲丽安'] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set(['艾莉亚']));
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — worldBookIds 维度', () => {
  it('命中世界书 id → enabled + locked', () => {
    const r = rule({ autoEnable: { worldBookIds: ['system_core'] } });
    const [out] = resolveAutoEnable([r], new Set(['system_core']), new Set(), new Set());
    expect(out.enabled).toBe(true);
  });

  it('未命中 → 保持 disabled', () => {
    const r = rule({ autoEnable: { worldBookIds: ['system_core'] } });
    const [out] = resolveAutoEnable([r], new Set(['dlc']), new Set(), new Set());
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — 三维 OR 匹配', () => {
  it('规则同时绑 uid + 角色名，任一命中即激活', () => {
    // 与真实 dalian 规则同构：worldBookEntryUids + characterNames 都有
    const r = rule({ autoEnable: { worldBookEntryUids: [413], characterNames: ['妲丽安'] } });
    // 只命中角色名（uid 未命中）也激活
    const [byName] = resolveAutoEnable([r], new Set(), new Set([999]), new Set(['妲丽安']));
    expect(byName.enabled).toBe(true);
    // 只命中 uid（角色不在场）也激活
    const [byUid] = resolveAutoEnable([r], new Set(), new Set([413]), new Set(['艾莉亚']));
    expect(byUid.enabled).toBe(true);
  });

  it('无 autoEnable 的规则不受影响', () => {
    const r = rule({});
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set());
    expect(out.enabled).toBe(false);
    expect(out.locked).toBe(false);
  });
});
