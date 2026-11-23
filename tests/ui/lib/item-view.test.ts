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
  skillCostLabel,
  skillRewriteEntry,
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

describe('entryEffects', () => {
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
});

describe('skillCostLabel / costText 优先（状态树协议 §5.7）', () => {
  it('有 costText 时原样显示，忽略数值格式', () => {
    expect(skillCostLabel({ costText: '一缕寿元' })).toBe('一缕寿元');
    expect(skillCostLabel({ costText: '一缕寿元' }, { typeFirst: true, sep: ' ' })).toBe(
      '一缕寿元',
    );
    expect(detailExtra(skill({ costText: '一缕寿元' }), 'skills')).toBe('Lv.3 · 一缕寿元');
  });
  it('无 costText 时按 cost 格式化；三种排版', () => {
    const s = { cost: { type: 'MP', amount: 10 } };
    expect(skillCostLabel(s)).toBe('10MP');
    expect(skillCostLabel(s, { sep: ' ' })).toBe('10 MP');
    expect(skillCostLabel(s, { typeFirst: true, sep: ' ' })).toBe('MP 10');
  });
  it('空白 costText 视为没有；都没有返回空串', () => {
    expect(skillCostLabel({ costText: '  ', cost: { type: 'SP', amount: 5 } })).toBe('5SP');
    expect(skillCostLabel({})).toBe('');
    expect(detailExtra(skill(), 'skills')).toBe('Lv.3');
  });
});

describe('skillRewriteEntry（重铸交给 AI 的技能现状）', () => {
  it('带上 costText，关键字段透传', () => {
    const entry = skillRewriteEntry({
      name: '血祭',
      description: '以血换力',
      type: 'active',
      costText: '一缕寿元',
      cooldown: 2,
      skillPower: 30,
      relevantAttribute: 'int',
    });
    expect(entry).toEqual({
      name: '血祭',
      description: '以血换力',
      type: 'active',
      costText: '一缕寿元',
      cooldown: 2,
      skillPower: 30,
      relevantAttribute: 'int',
    });
  });
  it('数值消耗照旧带 cost，不出现 costText 键', () => {
    const entry = skillRewriteEntry({
      name: '火球术',
      description: '',
      type: 'passive',
      cost: { type: 'MP', amount: 10 },
    });
    expect(entry).toEqual({
      name: '火球术',
      description: '',
      type: 'passive',
      cost: { type: 'MP', amount: 10 },
    });
    expect('costText' in entry).toBe(false);
  });
});
