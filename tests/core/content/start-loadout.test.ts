/**
 * start-loadout.ts — 开局装备/道具/技能结构化落库映射测试
 */
import { describe, it, expect } from 'vitest';
import { buildStartLoadout, parseSkillCost } from '../../../src/core/content/start-loadout';
import type { CatalogItem } from '../../../src/core/content/start-catalog-mechanics';

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    id: 'x',
    name: '未命名',
    category: 'item',
    type: '消耗品',
    rarity: 'common',
    tag: [],
    effect: {},
    description: '',
    cost: 0,
    ...overrides,
  };
}

const empty = { equipments: [], items: [], skills: [] };

describe('buildStartLoadout — 空输入', () => {
  it('三类都为空时返回空 inventory 与 skills', () => {
    expect(buildStartLoadout(empty)).toEqual({ inventory: [], skills: [] });
  });
});

describe('buildStartLoadout — 装备', () => {
  it('映射为装备形状：type 装备、数量 1、品质归一化、槽位归一化、数值保留', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      equipments: [
        item({
          name: '铁剑',
          category: 'equipment',
          type: '武器',
          rarity: 'rare',
          tag: ['单手'],
          effect: { 锋利: '攻击附带流血' },
          description: '一把普通的铁剑',
          stats: { atk: 5 },
        }),
      ],
    });
    expect(inventory).toHaveLength(1);
    const sword = inventory[0];
    expect(sword).toMatchObject({
      name: '铁剑',
      description: '一把普通的铁剑',
      quantity: 1,
      type: '装备',
      rarity: '稀有',
      equippedSlot: '武器',
      stats: { atk: 5 },
      effects: { 锋利: '攻击附带流血' },
      tags: ['单手'],
    });
    expect(sword.protocolText).toBe(
      ['一把普通的铁剑', '标签：单手', '效果：锋利（攻击附带流血）', '数值：攻击力 5'].join('\n'),
    );
  });

  it('同槽位第二件不穿上（equippedSlot 为 null），不同槽位各自穿上', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      equipments: [
        item({ name: '铁剑', category: 'equipment', type: '武器' }),
        item({ name: '短刀', category: 'equipment', type: '武器' }),
        item({ name: '皮甲', category: 'equipment', type: '防具' }),
      ],
    });
    expect(inventory.map((i) => [i.name, i.equippedSlot])).toEqual([
      ['铁剑', '武器'],
      ['短刀', null],
      ['皮甲', '身体'],
    ]);
  });

  it('认不出槽位的装备躺背包（equippedSlot 为 null）', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      equipments: [item({ name: '奇物', category: 'equipment', type: '某种未知部位' })],
    });
    expect(inventory[0].equippedSlot).toBeNull();
    expect(inventory[0].type).toBe('装备');
  });

  it('空的 stats/effects/tags 不写入字段，全空时也不写 protocolText', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      equipments: [item({ name: '布衣', category: 'equipment', type: '防具', stats: {} })],
    });
    expect(inventory[0]).not.toHaveProperty('stats');
    expect(inventory[0]).not.toHaveProperty('effects');
    expect(inventory[0]).not.toHaveProperty('tags');
    expect(inventory[0]).not.toHaveProperty('protocolText');
  });

  it('同名装备合并数量且不占第二个槽位', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      equipments: [
        item({ name: '铁剑', category: 'equipment', type: '武器' }),
        item({ name: '铁剑', category: 'equipment', type: '武器' }),
        item({ name: '短刀', category: 'equipment', type: '武器' }),
      ],
    });
    expect(inventory.map((i) => [i.name, i.quantity, i.equippedSlot])).toEqual([
      ['铁剑', 2, '武器'],
      ['短刀', 1, null],
    ]);
  });
});

describe('buildStartLoadout — 道具', () => {
  it('数量取 quantity，缺省为 1；类型归一化', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      items: [
        item({ name: '治疗药水', type: '消耗品', quantity: 3, description: '恢复少量生命' }),
        item({ name: '铁矿石', type: '材料' }),
      ],
    });
    expect(inventory.map((i) => [i.name, i.quantity, i.type])).toEqual([
      ['治疗药水', 3, '消耗品'],
      ['铁矿石', 1, '材料'],
    ]);
    expect(inventory[0].equippedSlot).toBeUndefined();
    expect(inventory[0].protocolText).toBe('恢复少量生命');
  });

  it('认不出的道具类型兜底为「特殊」', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      items: [item({ name: '旧怀表', type: '纪念品' })],
    });
    expect(inventory[0].type).toBe('特殊');
  });

  it('同名道具合并数量，保留第一条的其余字段', () => {
    const { inventory } = buildStartLoadout({
      ...empty,
      items: [
        item({ name: '面包', quantity: 2, description: '第一份' }),
        item({ name: '面包', quantity: 3, description: '第二份' }),
      ],
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ name: '面包', quantity: 5, description: '第一份' });
  });
});

describe('buildStartLoadout — 技能', () => {
  it('类型含「被动」为 passive，其余 active；level 为 1', () => {
    const { skills } = buildStartLoadout({
      ...empty,
      skills: [
        item({ name: '坚韧', category: 'skill', type: '被动技能' }),
        item({ name: '火球术', category: 'skill', type: '主动' }),
      ],
    });
    expect(skills.map((s) => [s.name, s.type, s.level])).toEqual([
      ['坚韧', 'passive', 1],
      ['火球术', 'active', 1],
    ]);
  });

  it('consume 能读出资源与数值时写 cost，并进 protocolText', () => {
    const { skills } = buildStartLoadout({
      ...empty,
      skills: [
        item({
          name: '火球术',
          category: 'skill',
          type: '主动',
          rarity: 'uncommon',
          consume: '攻击: 40MP',
          description: '掷出火球',
          effect: { 灼烧: '附带持续伤害' },
          tag: ['火焰'],
        }),
      ],
    });
    expect(skills[0]).toMatchObject({
      cost: { type: 'MP', amount: 40 },
      rarity: '优良',
      effects: { 灼烧: '附带持续伤害' },
      tags: ['火焰'],
    });
    expect(skills[0].protocolText).toBe(
      ['掷出火球', '标签：火焰', '效果：灼烧（附带持续伤害）', '消耗：攻击: 40MP'].join('\n'),
    );
  });

  it('consume 读不出资源数值时不写 cost，但原文仍进 protocolText', () => {
    const { skills } = buildStartLoadout({
      ...empty,
      skills: [item({ name: '冥想', category: 'skill', type: '主动', consume: '一段安静的时间' })],
    });
    expect(skills[0]).not.toHaveProperty('cost');
    expect(skills[0].protocolText).toBe('消耗：一段安静的时间');
  });

  it('同名技能只保留第一条', () => {
    const { skills } = buildStartLoadout({
      ...empty,
      skills: [
        item({ name: '火球术', category: 'skill', type: '主动', description: '第一份' }),
        item({ name: '火球术', category: 'skill', type: '被动', description: '第二份' }),
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ description: '第一份', type: 'active' });
  });
});

describe('parseSkillCost', () => {
  it.each([
    ['MP 10', { type: 'MP', amount: 10 }],
    ['sp：25', { type: 'SP', amount: 25 }],
    ['150HP', { type: 'HP', amount: 150 }],
    ['攻击: 400MP / 动作: 150MP', { type: 'MP', amount: 400 }],
  ])('能解析 %s', (raw, expected) => {
    expect(parseSkillCost(raw)).toEqual(expected);
  });

  it.each([undefined, '', '无', '少量法力'])('解析不出时返回 undefined：%s', (raw) => {
    expect(parseSkillCost(raw)).toBeUndefined();
  });
});
