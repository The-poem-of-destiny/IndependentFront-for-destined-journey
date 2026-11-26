/**
 * patch-reducer：角色类补丁纯变换的单元测试（审查报告 R5b）。
 *
 * StateManager 的角色 handler 与状态树翻译层的影子状态共用这一份变换；
 * 端到端的「影子后值 = 真实落库」对照在 tests/core/variables/state-tree-shadow-parity.test.ts。
 */

import { describe, expect, it } from 'vitest';
import {
  findByName,
  isCharacterPatchOp,
  prepareNewCharacter,
  readTransferItemRequest,
  reduceCharacterPatch,
  reduceTransferItem,
  resourceCeiling,
} from '../../../src/core/state/patch-reducer';
import {
  createDefaultCharacterState,
  type CharacterState,
  type StatePatch,
} from '../../../src/core/types/types';

const GAME_TIME = { year: 1000, month: 3, day: 15 };

function npc(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({ id: 'id-npc', name: '布兰', ...overrides });
}

function patch(op: StatePatch['op'], value?: unknown, extra: Partial<StatePatch> = {}): StatePatch {
  return { op, target: 'characters.布兰', value, ...extra } as StatePatch;
}

describe('patch-reducer：分发', () => {
  it('只认角色域单角色补丁', () => {
    expect(isCharacterPatchOp('update_character')).toBe(true);
    expect(isCharacterPatchOp('add_item')).toBe(true);
    expect(isCharacterPatchOp('set_location')).toBe(true);
    expect(isCharacterPatchOp('transfer_item')).toBe(false);
    expect(isCharacterPatchOp('add_character')).toBe(false);
    expect(isCharacterPatchOp('set_variable')).toBe(false);
    expect(() => reduceCharacterPatch(npc(), patch('set_variable', 1))).toThrow('不是角色类补丁');
  });
});

describe('patch-reducer：update_character', () => {
  it('白名单外的键整份拒绝，角色不被改动', () => {
    const c = npc();
    const before = structuredClone(c);
    expect(() =>
      reduceCharacterPatch(c, patch('update_character', { money: 5, inventory: [] })),
    ).toThrow('禁止写数组字段');
    expect(() => reduceCharacterPatch(c, patch('update_character', { 名字: 'x' }))).toThrow(
      '不认识的字段',
    );
    expect(c).toEqual(before);
  });

  it('delta 真加法；金钱扣成负数或写成非有限值都钳到 0 并留说明', () => {
    const c = npc({ money: 10 });
    const r = reduceCharacterPatch(
      c,
      patch('update_character', { money: -50 }, { metadata: { delta: true } }),
    );
    expect(c.money).toBe(0);
    expect(r.notes.map((n) => n.level)).toEqual(['fix']);
    reduceCharacterPatch(c, patch('update_character', { money: Number.NaN }));
    expect(c.money).toBe(0);
    reduceCharacterPatch(c, patch('update_character', { money: 7 }));
    expect(c.money).toBe(7);
  });

  it('NPC 写等级 → 层级由等级推出', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('update_character', { level: 12 }));
    expect(c.tier).toBeGreaterThan(1);
  });

  it('写额外上限：有效上限重算，当前值钳到新上限', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('update_character', { maxHpBonus: -1_000_000 }));
    expect(c.maxHp).toBe(1);
    expect(c.hp).toBe(1);
    expect(c.maxHpBonus).toBe(-1_000_000);
  });

  it('metadata.action 覆盖 currentAction', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('update_character', {}, { metadata: { action: '打铁' } }));
    expect(c.currentAction).toBe('打铁');
  });
});

describe('patch-reducer：资源', () => {
  it('set / delta 按角色身上的有效上限钳制，零上限只能写 0', () => {
    const c = npc({ mp: 0, maxMp: 0 });
    expect(resourceCeiling(c, 'mp')).toBe(0);
    const r = reduceCharacterPatch(c, patch('set_mp', 5));
    expect(c.mp).toBe(0);
    expect(r.notes[0]?.text).toContain('已钳到 0');

    const d = npc({ hp: 40, maxHp: 100 });
    reduceCharacterPatch(d, { op: 'delta_hp', target: 'characters.布兰', amount: 500 });
    expect(d.hp).toBe(100);
    reduceCharacterPatch(d, { op: 'delta_hp', target: 'characters.布兰', amount: -500 });
    expect(d.hp).toBe(0);
  });
});

describe('patch-reducer：状态效果', () => {
  it('同名叠层按 maxStacks 封顶；不可叠加的保持 1 层', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('add_status_effect', { name: '中毒', stacks: 2, maxStacks: 3 }));
    reduceCharacterPatch(c, patch('add_status_effect', { name: '中毒', stacks: 5 }));
    expect(findByName(c.statusEffects, '中毒')?.stacks).toBe(3);
    reduceCharacterPatch(c, patch('add_status_effect', { name: '祝福', stackable: false }));
    reduceCharacterPatch(c, patch('add_status_effect', { name: '祝福', stacks: 4 }));
    expect(findByName(c.statusEffects, '祝福')?.stacks).toBe(1);
  });

  it('文本时长与数值时长互斥', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('add_status_effect', { name: '流血', durationText: ' 2小时 ' }));
    const e = findByName(c.statusEffects, '流血')!;
    expect(e.durationText).toBe('2小时');
    expect(e.remainingTime).toBeNull();
    reduceCharacterPatch(c, patch('update_status_effect', { name: '流血', remainingTime: 30 }));
    expect(e.durationText).toBeUndefined();
    expect(e.remainingTime).toBe(30);
  });

  it('update_status_effect 找不到名字：不抛，留 warn 说明', () => {
    const c = npc();
    const r = reduceCharacterPatch(c, patch('update_status_effect', { name: '不存在', stacks: 2 }));
    expect(r.notes).toEqual([{ level: 'warn', text: expect.stringContaining('找不到状态') }]);
  });
});

describe('patch-reducer：物品', () => {
  it('新物品枚举归一：认不出的旧式 type 归一成 undefined', () => {
    const c = npc();
    reduceCharacterPatch(c, patch('add_item', { name: '宝剑', type: '武器', quantity: 0 }));
    const item = findByName(c.inventory, '宝剑')!;
    expect(item.type).toBeUndefined();
    expect(item.quantity).toBe(1);
    reduceCharacterPatch(c, patch('add_item', { name: '宝剑', quantity: 2 }));
    expect(item.quantity).toBe(3);
  });

  it('库存不足抛错且不扣；扣到 0 删条目', () => {
    const c = npc({ inventory: [{ name: '药水', quantity: 2 }] });
    expect(() =>
      reduceCharacterPatch(c, patch('remove_item', { name: '药水', quantity: 3 })),
    ).toThrow('库存不足');
    expect(c.inventory[0].quantity).toBe(2);
    reduceCharacterPatch(c, patch('remove_item', { name: '药水', quantity: 2 }));
    expect(c.inventory).toEqual([]);
  });

  it('穿戴顶替同槽旧装备；堆叠物品不可穿戴', () => {
    const c = npc({
      inventory: [
        { name: '长剑', quantity: 1, equippedSlot: '武器' },
        { name: '短剑', quantity: 1 },
        { name: '飞刀', quantity: 3 },
      ],
    });
    reduceCharacterPatch(c, patch('equip_item', { name: '短剑', slot: '武器' }));
    expect(findByName(c.inventory, '长剑')?.equippedSlot).toBeNull();
    expect(findByName(c.inventory, '短剑')?.equippedSlot).toBe('武器');
    expect(() =>
      reduceCharacterPatch(c, patch('equip_item', { name: '飞刀', slot: '武器' })),
    ).toThrow('堆叠物品不可直接穿戴');
  });

  it('update_item 禁改名与数量', () => {
    const c = npc({ inventory: [{ name: '长剑', quantity: 1 }] });
    expect(() =>
      reduceCharacterPatch(c, patch('update_item', { name: '长剑', changes: { quantity: 2 } })),
    ).toThrow('禁止改 quantity');
  });

  it('transfer_item：转出脱下、接收方合并；自我转移拒绝', () => {
    const from = npc({ inventory: [{ name: '铁盾', quantity: 1, equippedSlot: '副手' }] });
    const to = npc({ id: 'id-卡拉', name: '卡拉' });
    const req = readTransferItemRequest(patch('transfer_item', { name: '铁盾', to: '卡拉' }));
    expect(() => reduceTransferItem(from, from, req)).toThrow('不允许自我转移');
    reduceTransferItem(from, to, req);
    expect(from.inventory).toEqual([]);
    expect(to.inventory).toEqual([{ name: '铁盾', quantity: 1, equippedSlot: null }]);
    expect(() => readTransferItemRequest(patch('transfer_item', { name: '铁盾' }))).toThrow(
      'value.to',
    );
  });
});

describe('patch-reducer：技能', () => {
  it('认不出的消耗转成文本；结构化消耗与文本消耗互斥', () => {
    const c = npc();
    reduceCharacterPatch(
      c,
      patch('add_skill', { name: '祷言', cost: { type: '信仰', amount: 3 } }),
    );
    const s = findByName(c.skills, '祷言')!;
    expect(s.cost).toBeUndefined();
    expect(s.costText).toBe('信仰 3');
    reduceCharacterPatch(
      c,
      patch('update_skill', { name: '祷言', changes: { cost: { type: 'mp', amount: 5 } } }),
    );
    expect(s.cost).toEqual({ type: 'MP', amount: 5 });
    expect(s.costText).toBeUndefined();
  });

  it('删除不存在的技能抛错', () => {
    expect(() => reduceCharacterPatch(npc(), patch('remove_skill', { name: '无' }))).toThrow(
      '技能不存在',
    );
  });
});

describe('patch-reducer：新建人物', () => {
  it('补年龄锚点；已有合法锚点原样保留', () => {
    const c = npc();
    prepareNewCharacter(c, GAME_TIME);
    expect(c.ageAnchor).toBeDefined();
    const anchor = { startAge: 30, month: 6, day: 1 };
    const d = npc({ ageAnchor: { ...anchor } });
    prepareNewCharacter(d, GAME_TIME);
    expect(d.ageAnchor).toEqual(anchor);
  });

  it('缺席额外按「带来的上限 − 基础」固化，总上限不变；零上限不被抬成 1', () => {
    const c = npc({ maxMp: 0, mp: 0 });
    prepareNewCharacter(c, GAME_TIME);
    expect(c.maxHp).toBe(100);
    expect(c.maxMp).toBe(0);
    expect(typeof c.maxMpBonus).toBe('number');
  });
});
