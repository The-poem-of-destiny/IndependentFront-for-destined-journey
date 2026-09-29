/**
 * item-view.ts —— 物品/技能条目展示逻辑（玩家背包与 NPC 查看器共用）纯函数测试。
 */
import { describe, it, expect } from 'vitest';
import {
  qualityOf,
  qualityRank,
  facetOf,
  listExtra,
  typeLabel,
  detailExtra,
  entryEffects,
  entryCombatLines,
  entryRawCombatJson,
  type PanelEntry,
} from '../../../src/ui/lib/item-view';

const item = (over: Record<string, unknown> = {}): PanelEntry => ({
  kind: 'item',
  row: { name: '铁剑', quantity: 2, ...over } as never,
});
const skill = (over: Record<string, unknown> = {}): PanelEntry => ({
  kind: 'skill',
  row: { name: '火球术', type: 'active', level: 3, ...over } as never,
});

describe('qualityOf / qualityRank', () => {
  it('物品：有 rarity 用它，否则按 stats 推断', () => {
    expect(qualityOf(item({ rarity: '唯一' }))).toBe('唯一');
    expect(qualityOf(item({ stats: { str: 12 } }))).toBe('优良');
    expect(qualityOf(item())).toBe('普通');
  });
  it('技能：有 rarity 用它，否则回落「普通」（不编造）', () => {
    expect(qualityOf(skill({ rarity: '史诗' }))).toBe('史诗');
    expect(qualityOf(skill())).toBe('普通');
  });
  it('qualityRank 可排序（品质越高序号越大）', () => {
    expect(qualityRank(item({ rarity: '神话' }))).toBeGreaterThan(
      qualityRank(item({ rarity: '普通' })),
    );
  });
});

describe('facetOf / listExtra', () => {
  it('装备分类取槽位', () => {
    const eq = item({ equippedSlot: '武器' });
    expect(facetOf(eq, 'equipment')).toBe('武器');
    expect(listExtra(eq, 'equipment')).toBe('[武器]');
  });
  it('背包取 type，尾部数量', () => {
    expect(facetOf(item({ type: '消耗品' }), 'inventory')).toBe('消耗品');
    expect(listExtra(item({ quantity: 3 }), 'inventory')).toBe('×3');
  });
  it('技能取主/被动，尾部等级', () => {
    expect(facetOf(skill(), 'skills')).toBe('主动');
    expect(facetOf(skill({ type: 'passive' }), 'skills')).toBe('被动');
    expect(listExtra(skill({ level: 5 }), 'skills')).toBe('Lv.5');
  });
});

describe('typeLabel / detailExtra', () => {
  it('技能文案与等级消耗', () => {
    expect(typeLabel(skill(), 'skills')).toBe('主动技能');
    expect(typeLabel(skill({ type: 'passive' }), 'skills')).toBe('被动技能');
    expect(detailExtra(skill({ level: 2, cost: { type: 'MP', amount: 10 } }), 'skills')).toBe(
      'Lv.2 · 10MP',
    );
  });
  it('装备槽位与耐久', () => {
    const eq = item({ equippedSlot: '护甲', durability: 3, maxDurability: 10 });
    expect(typeLabel(eq, 'equipment')).toBe('护甲');
    expect(detailExtra(eq, 'equipment')).toBe('3/10 耐久');
  });
  it('背包类型与数量', () => {
    const it = item({ type: '材料', quantity: 4 });
    expect(typeLabel(it, 'inventory')).toBe('材料');
    expect(detailExtra(it, 'inventory')).toBe('×4');
  });
});

describe('entryEffects / 战斗', () => {
  it('效果三种形态都归一化（数组不再吐数字键）', () => {
    expect(entryEffects(item({ effects: { 灼烧: '每回合伤害' } }))).toEqual({ 灼烧: '每回合伤害' });
    expect(entryEffects(item({ effects: ['灼烧:每回合伤害', '减速:移速下降'] }))).toEqual({
      灼烧: '每回合伤害',
      减速: '移速下降',
    });
    expect(entryEffects(item({ effects: '灼烧:每回合伤害;减速:移速下降' }))).toEqual({
      灼烧: '每回合伤害',
      减速: '移速下降',
    });
    expect(entryEffects(item())).toEqual({});
  });
  it('无 modifiers/automata → 无战斗修正行；原始 JSON 为空', () => {
    expect(entryCombatLines(item())).toEqual([]);
    expect(entryRawCombatJson(item())).toBe('');
  });
  it('有 modifiers → 原始 JSON 非空', () => {
    const row = item({ modifiers: [{ kind: 'flat', value: 10 }] });
    expect(entryRawCombatJson(row)).toContain('flat');
  });
});
