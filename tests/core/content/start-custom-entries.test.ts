/**
 * start-custom-entries.ts — 自制开局条目库纯函数测试。
 */
import { describe, it, expect } from 'vitest';
import {
  planLibrarySave,
  sanitizeCustomCatalogItem,
} from '../../../src/core/content/start-custom-entries';
import type { CatalogItem } from '../../../src/core/content/start-catalog-mechanics';
import type { CreateCustomItemRecord } from '../../../src/core/persistence/database';

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'custom_equipment_1a2b3c4d',
    name: '  旧铁剑  ',
    category: 'equipment',
    type: '武器',
    rarity: 'rare',
    tag: ['锋利', ' 锋利 ', '', 3, '沉重'],
    effect: { 锋锐: '轻微', 坚固: '中等' },
    description: '一把旧铁剑。',
    cost: 12,
    stats: { atk: 5, defense: 0, hit: -1, dodge: Number.NaN, dr: 2.5 },
    ...overrides,
  };
}

function record(overrides: Partial<CreateCustomItemRecord> = {}): CreateCustomItemRecord {
  const id = overrides.id ?? 'custom_skill_old00000';
  const name = overrides.name ?? '星火术';
  const category = overrides.category ?? 'skill';
  return {
    id,
    category,
    name,
    createdAt: 100,
    updatedAt: 100,
    data: {
      id,
      name,
      category,
      type: '主动',
      rarity: 'common',
      tag: [],
      effect: {},
      description: name,
      cost: 1,
    },
    ...overrides,
  };
}

describe('sanitizeCustomCatalogItem', () => {
  it('合法装备：名称去空白、标签去重去空、stats 只留正有限数', () => {
    const item = sanitizeCustomCatalogItem(rawItem());
    expect(item).toEqual({
      id: 'custom_equipment_1a2b3c4d',
      name: '旧铁剑',
      category: 'equipment',
      type: '武器',
      rarity: 'rare',
      tag: ['锋利', '沉重'],
      effect: { 锋锐: '轻微', 坚固: '中等' },
      description: '一把旧铁剑。',
      cost: 12,
      stats: { atk: 5, dr: 2.5 },
    });
  });

  it('非对象 / null / 数组一律返回 null', () => {
    expect(sanitizeCustomCatalogItem(null)).toBeNull();
    expect(sanitizeCustomCatalogItem('custom_x')).toBeNull();
    expect(sanitizeCustomCatalogItem([rawItem()])).toBeNull();
  });

  it('id 不以 custom_ 开头或只有前缀：返回 null', () => {
    expect(sanitizeCustomCatalogItem(rawItem({ id: 'eq_001' }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ id: 'custom_' }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ id: 42 }))).toBeNull();
  });

  it('名称为空或全空白：返回 null', () => {
    expect(sanitizeCustomCatalogItem(rawItem({ name: '   ' }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ name: undefined }))).toBeNull();
  });

  it('类别不在枚举内：返回 null', () => {
    expect(sanitizeCustomCatalogItem(rawItem({ category: 'weapon' }))).toBeNull();
  });

  it('点数必须是 1–9999 的整数', () => {
    expect(sanitizeCustomCatalogItem(rawItem({ cost: 0 }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ cost: 10000 }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ cost: 1.5 }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ cost: '10' }))).toBeNull();
    expect(sanitizeCustomCatalogItem(rawItem({ cost: 1 }))?.cost).toBe(1);
    expect(sanitizeCustomCatalogItem(rawItem({ cost: 9999 }))?.cost).toBe(9999);
  });

  it('认不出的品质回退 common；不设品质上限（only 也收）', () => {
    expect(sanitizeCustomCatalogItem(rawItem({ rarity: 'godlike' }))?.rarity).toBe('common');
    expect(sanitizeCustomCatalogItem(rawItem({ rarity: undefined }))?.rarity).toBe('common');
    expect(sanitizeCustomCatalogItem(rawItem({ rarity: 'only' }))?.rarity).toBe('only');
  });

  it('数量只给物品：1–99 的整数，不合法回退 1；非物品不带 quantity', () => {
    const base = { id: 'custom_item_aaaa0000', category: 'item', stats: undefined };
    expect(sanitizeCustomCatalogItem(rawItem({ ...base, quantity: 5 }))?.quantity).toBe(5);
    expect(sanitizeCustomCatalogItem(rawItem({ ...base, quantity: 99 }))?.quantity).toBe(99);
    expect(sanitizeCustomCatalogItem(rawItem({ ...base, quantity: 100 }))?.quantity).toBe(1);
    expect(sanitizeCustomCatalogItem(rawItem({ ...base, quantity: 0 }))?.quantity).toBe(1);
    expect(sanitizeCustomCatalogItem(rawItem({ ...base }))?.quantity).toBe(1);
    expect(sanitizeCustomCatalogItem(rawItem({ quantity: 5 }))).not.toHaveProperty('quantity');
  });

  it('stats 只给装备；没有正数值时整个省略', () => {
    const skill = sanitizeCustomCatalogItem(
      rawItem({ id: 'custom_skill_aaaa0000', category: 'skill' }),
    );
    expect(skill).not.toHaveProperty('stats');
    const bare = sanitizeCustomCatalogItem(rawItem({ stats: { atk: 0, dodge: -3 } }));
    expect(bare).not.toHaveProperty('stats');
  });

  it('consume 只给技能，空串省略', () => {
    const skill = sanitizeCustomCatalogItem(
      rawItem({ id: 'custom_skill_aaaa0000', category: 'skill', consume: ' MP 5 ' }),
    );
    expect(skill?.consume).toBe('MP 5');
    const blank = sanitizeCustomCatalogItem(
      rawItem({ id: 'custom_skill_aaaa0000', category: 'skill', consume: '  ' }),
    );
    expect(blank).not.toHaveProperty('consume');
    expect(sanitizeCustomCatalogItem(rawItem({ consume: 'MP 5' }))).not.toHaveProperty('consume');
  });

  it('effect 丢弃原型污染键与非字符串值', () => {
    const effect = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":"x","prototype":"y","命中":"小幅","坏值":3}',
    );
    const item = sanitizeCustomCatalogItem(rawItem({ effect }));
    expect(item?.effect).toEqual({ 命中: '小幅' });
    expect(Object.getPrototypeOf(item?.effect)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('stats 同样丢弃原型污染键', () => {
    const stats = JSON.parse('{"__proto__":{"atk":9},"constructor":3,"atk":2}');
    expect(sanitizeCustomCatalogItem(rawItem({ stats }))?.stats).toEqual({ atk: 2 });
  });

  it('描述为空时回退名称；tag / effect 缺失时给空值', () => {
    const item = sanitizeCustomCatalogItem(
      rawItem({ description: ' ', tag: undefined, effect: 'oops' }),
    );
    expect(item?.description).toBe('旧铁剑');
    expect(item?.tag).toEqual([]);
    expect(item?.effect).toEqual({});
  });
});

describe('planLibrarySave', () => {
  const item: CatalogItem = {
    id: 'custom_skill_new00000',
    name: '星火术',
    category: 'skill',
    type: '主动',
    rarity: 'epic',
    tag: [],
    effect: {},
    description: '新版本',
    cost: 20,
  };

  it('库里没有同名条目：createdAt = updatedAt = now，无替换', () => {
    const plan = planLibrarySave([], item, 500);
    expect(plan.replaceIds).toEqual([]);
    expect(plan.record).toEqual({
      id: item.id,
      category: 'skill',
      name: '星火术',
      createdAt: 500,
      updatedAt: 500,
      data: item,
    });
  });

  it('同类别同名的旧条目被替换，createdAt 继承最早那条', () => {
    const existing = [
      record({ id: 'custom_skill_a', createdAt: 300 }),
      record({ id: 'custom_skill_b', name: ' 星火术 ', createdAt: 200 }),
      record({ id: 'custom_item_c', category: 'item', createdAt: 50 }),
      record({ id: 'custom_skill_d', name: '寒冰术', createdAt: 10 }),
    ];
    const plan = planLibrarySave(existing, item, 900);
    expect(plan.replaceIds.sort()).toEqual(['custom_skill_a', 'custom_skill_b']);
    expect(plan.record.createdAt).toBe(200);
    expect(plan.record.updatedAt).toBe(900);
  });

  it('同 id 再存（编辑）：保留原 createdAt，不把自己列进 replaceIds', () => {
    const existing = [record({ id: item.id, createdAt: 123 })];
    const plan = planLibrarySave(existing, item, 900);
    expect(plan.replaceIds).toEqual([]);
    expect(plan.record.createdAt).toBe(123);
  });

  it('编辑时改成了另一条已有条目的名字：那条被替换', () => {
    const existing = [
      record({ id: item.id, name: '旧名', createdAt: 123 }),
      record({ id: 'custom_skill_dup', createdAt: 5 }),
    ];
    const plan = planLibrarySave(existing, item, 900);
    expect(plan.replaceIds).toEqual(['custom_skill_dup']);
    expect(plan.record.createdAt).toBe(123);
  });

  it('不同类别同名不算同一条目', () => {
    const existing = [record({ id: 'custom_equipment_x', category: 'equipment' })];
    expect(planLibrarySave(existing, item, 1).replaceIds).toEqual([]);
  });
});
