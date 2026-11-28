import { describe, expect, it } from 'vitest';
import { PatchRehearsal } from '../../../src/core/state/patch-rehearsal';
import {
  createDefaultCharacterState,
  type CharacterState,
  type StatePatch,
} from '../../../src/core/types/types';

function cast(): CharacterState[] {
  return [
    createDefaultCharacterState({
      id: 'p',
      saveId: 's',
      name: '旅人',
      type: 'player',
      inventory: [
        { name: '药水', quantity: 3 },
        { name: '长剑', quantity: 1 },
      ],
      skills: [{ name: '火球术', description: '', type: 'active' }],
    }),
    createDefaultCharacterState({ id: 'a', saveId: 's', name: '艾拉', aliases: ['小艾'] }),
  ];
}

const p = (op: StatePatch['op'], value?: unknown, target = 'characters.旅人'): StatePatch =>
  ({ op, target, value }) as StatePatch;

/** 逐条预演，能落就落下，返回每条的报错（能落为 null） */
function run(rehearsal: PatchRehearsal, patches: StatePatch[]): Array<string | null> {
  return patches.map((patch) => {
    try {
      rehearsal.vet(patch)();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });
}

describe('PatchRehearsal：建补丁预演', () => {
  it('静态形状不合格时抛出与提交时相同的报错', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('add_item'))).toThrow('add_item 需要 value 字段');
  });

  it('非角色目标直接放行', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('set_variable', 1, 'world.x'))()).not.toThrow();
  });

  it('引用的人物不存在时抛错；别名与「主角」可寻址', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('add_item', { name: '石头' }, 'characters.路人'))).toThrow(
      '角色不存在: 路人',
    );
    expect(() => r.vet(p('add_item', { name: '石头' }, 'characters.小艾'))).not.toThrow();
    expect(() => r.vet(p('remove_item', { name: '药水' }, 'characters.主角'))).not.toThrow();
  });

  it('物品类补丁缺 value.name 时抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('add_item', {}))).toThrow('add_item 需要 value.name');
    expect(() => r.vet(p('update_item', {}))).toThrow('update_item 需要 value.name');
  });

  it('移除物品：不存在、数量不足、按顺序扣减', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('remove_item', { name: '盾牌' }),
        p('remove_item', { name: '药水', quantity: 5 }),
        p('remove_item', { name: '药水', quantity: 2 }),
        p('remove_item', { name: '药水', quantity: 2 }),
        p('remove_item', { name: '药水' }),
        p('remove_item', { name: '药水' }),
      ]),
    ).toEqual([
      '物品不存在: 盾牌',
      '物品「药水」库存不足: 持有 3，需要 5',
      null,
      '物品「药水」库存不足: 持有 1，需要 2',
      null,
      '物品不存在: 药水',
    ]);
  });

  it('先加物品后移除可以落；加物品数量缺省或非正数按 1 计', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('add_item', { name: '石头', quantity: 0 }),
        p('add_item', { name: '石头', quantity: 2 }),
        p('remove_item', { name: '石头', quantity: 3 }),
        p('remove_item', { name: '石头' }),
      ]),
    ).toEqual([null, null, null, '物品不存在: 石头']);
  });

  it('转移物品：缺接收方、自我转移、数量不足、接收方随后可用', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('transfer_item', { name: '药水' }),
        p('transfer_item', { name: '药水', to: '主角' }),
        p('transfer_item', { name: '盾牌', to: '艾拉' }),
        p('transfer_item', { name: '药水', to: '艾拉', quantity: 4 }),
        p('transfer_item', { name: '药水', to: '艾拉', quantity: 3 }),
        p('remove_item', { name: '药水', quantity: 3 }, 'characters.艾拉'),
        p('remove_item', { name: '药水' }),
      ]),
    ).toEqual([
      'transfer_item 需要 value.to（接收方名字）',
      'transfer_item 不允许自我转移: 旅人',
      '物品不存在: 盾牌',
      '物品数量不足: 药水（持有 3，需 4）',
      null,
      null,
      '物品不存在: 药水',
    ]);
  });

  it('转移给不存在的人物时抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('transfer_item', { name: '药水', to: '路人' }))).toThrow(
      '角色不存在: 路人',
    );
  });

  it('穿戴：缺槽位、槽位无法识别、物品不存在、堆叠物品', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('equip_item', { name: '长剑' }),
        p('equip_item', { name: '长剑', slot: '尾巴' }),
        p('equip_item', { name: '盾牌', slot: '副手' }),
        p('equip_item', { name: '药水', slot: '武器' }),
        p('equip_item', { name: '长剑', slot: '武器' }),
      ]),
    ).toEqual([
      'equip_item 需要 value.slot',
      '无法识别的装备槽位: 尾巴',
      '物品不存在: 盾牌',
      '堆叠物品不可直接穿戴: 药水（数量 3），请先拆分为单件',
      null,
    ]);
  });

  it('卸下 / 修改物品：名字不在身上时抛错，按槽位卸下空槽抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('unequip_item', { name: '盾牌' }),
        p('unequip_item', { slot: '武器' }),
        p('update_item', { name: '盾牌' }),
        p('update_item', { name: '长剑' }),
      ]),
    ).toEqual(['物品不存在: 盾牌', '该槽位无穿戴: 武器', '物品不存在: 盾牌', null]);
  });

  it('按槽位卸下：槽位无法识别、缺名字缺槽位都与提交时同样抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(run(r, [p('unequip_item', { slot: '尾巴' }), p('unequip_item', {})])).toEqual([
      '无法识别的装备槽位: 尾巴',
      'unequip_item 需要 value.name 或 value.slot',
    ]);
  });

  it('按槽位卸下：同批先穿上再按槽位卸下可以落，卸下后再卸同一槽抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('equip_item', { name: '长剑', slot: '武器' }),
        p('unequip_item', { slot: '武器' }),
        p('unequip_item', { slot: '武器' }),
      ]),
    ).toEqual([null, null, '该槽位无穿戴: 武器']);
  });

  it('按槽位卸下：已穿戴的快照可以直接按槽位卸下', () => {
    const characters = cast();
    characters[0].inventory[1].equippedSlot = '武器';
    const r = new PatchRehearsal(characters);
    expect(run(r, [p('unequip_item', { slot: '武器' })])).toEqual([null]);
    expect(characters[0].inventory[1].equippedSlot).toBe('武器');
  });

  it('snapshot / restore 回滚含按槽位卸下的一组补丁', () => {
    const r = new PatchRehearsal(cast());
    r.vet(p('equip_item', { name: '长剑', slot: '武器' }))();
    const before = r.snapshot();
    r.vet(p('unequip_item', { slot: '武器' }))();
    expect(() => r.vet(p('unequip_item', { slot: '武器' }))).toThrow('该槽位无穿戴: 武器');
    r.restore(before);
    expect(() => r.vet(p('unequip_item', { slot: '武器' }))).not.toThrow();
  });

  it('技能：不存在时移除 / 修改抛错，先加后改可以落，移除后再改抛错', () => {
    const r = new PatchRehearsal(cast());
    expect(
      run(r, [
        p('update_skill', { name: '冰箭' }),
        p('add_skill', { name: '冰箭' }),
        p('update_skill', { name: '冰箭' }),
        p('remove_skill', { name: '火球术' }),
        p('remove_skill', { name: '火球术' }),
        p('add_skill', {}),
      ]),
    ).toEqual([
      '技能不存在: 冰箭',
      null,
      null,
      null,
      '技能不存在: 火球术',
      'add_skill 需要 value.name',
    ]);
  });

  it('vet 只判定不落下：不调用返回的动作，影子状态不变', () => {
    const r = new PatchRehearsal(cast());
    r.vet(p('remove_item', { name: '长剑' }));
    expect(() => r.vet(p('remove_item', { name: '长剑' }))).not.toThrow();
  });

  it('snapshot / restore 回滚一组补丁的预演进度', () => {
    const r = new PatchRehearsal(cast());
    const before = r.snapshot();
    r.vet(p('remove_item', { name: '长剑' }))();
    r.vet(p('remove_skill', { name: '火球术' }))();
    expect(() => r.vet(p('remove_item', { name: '长剑' }))).toThrow('物品不存在: 长剑');
    r.restore(before);
    expect(() => r.vet(p('remove_item', { name: '长剑' }))).not.toThrow();
    expect(() => r.vet(p('update_skill', { name: '火球术' }))).not.toThrow();
  });

  it('只读角色快照，不改真实角色', () => {
    const characters = cast();
    const r = new PatchRehearsal(characters);
    r.vet(p('remove_item', { name: '药水', quantity: 3 }))();
    r.vet(p('add_skill', { name: '冰箭' }))();
    expect(characters[0].inventory).toEqual([
      { name: '药水', quantity: 3 },
      { name: '长剑', quantity: 1 },
    ]);
    expect(characters[0].skills.map((s) => s.name)).toEqual(['火球术']);
  });

  it('其余 op 放行', () => {
    const r = new PatchRehearsal(cast());
    expect(() => r.vet(p('add_status_effect', { name: '中毒' }))()).not.toThrow();
  });
});
