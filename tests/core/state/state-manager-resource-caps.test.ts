/**
 * StateManager 资源上限不变式 + 文本时长 / 文本消耗互斥（状态树协议 §5.6 / §5.2 / §7.2）
 *
 * 走真实 StateManager + fake-indexeddb：
 * - 旧档角色（无 *Bonus）经无关写入后总上限一分不变，额外被固化成「现上限 − 基础」；
 * - 属性 / 层级变化后有效上限 = 新基础 + 额外；上限下降钳当前值，上升不动当前值；
 * - `update_character {maxHp: n}` 旧写法解释为「总上限设为 n」；
 * - NPC 写等级时层级由代码推出；
 * - 新建角色额外缺席时与旧档同一读法（带来的总上限不变），自带额外的项才重算；
 * - durationText / remainingTime、costText / cost 互斥。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  initializeDatabase,
  clearAllData,
  saveCharacter,
  getCharacters,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { CharacterState, StatePatch } from '../../../src/core/types/types';
import { calcResources } from '../../../src/core/character/tier-constants';

const SAVE = 'caps';

async function seed(overrides: Partial<CharacterState>): Promise<CharacterState> {
  const char = createDefaultCharacterState({ saveId: SAVE, ...overrides });
  await saveCharacter(char);
  return char;
}

async function commit(patches: StatePatch[]): Promise<void> {
  const result = await createStateManager(SAVE).commitChatState(patches);
  expect(result.errors).toEqual([]);
  expect(result.success).toBe(true);
}

async function load(name: string): Promise<CharacterState> {
  const c = (await getCharacters(SAVE)).find((x) => x.name === name);
  if (!c) throw new Error(`角色不存在: ${name}`);
  return c;
}

const ATTRS = { str: 10, dex: 10, con: 10, int: 10, spi: 10 };

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
});

describe('资源上限不变式（§5.6）', () => {
  it('旧档角色（无 *Bonus）经无关写入后总上限不变，额外固化为「现上限 − 基础」', async () => {
    const base = calcResources(1, ATTRS);
    await seed({
      id: 'n1',
      name: '老兵',
      type: 'npc',
      maxHp: 300,
      hp: 250,
      maxMp: 70,
      maxSp: 2000,
    });
    await commit([
      { op: 'update_character', target: 'characters.老兵', value: { location: '王都' } },
    ]);
    const c = await load('老兵');
    expect([c.maxHp, c.maxMp, c.maxSp]).toEqual([300, 70, 2000]);
    expect(c.hp).toBe(250);
    expect(c.maxHpBonus).toBe(300 - base.maxHp);
    expect(c.maxMpBonus).toBe(70 - base.maxMp);
    expect(c.maxSpBonus).toBe(2000 - base.maxSp);
  });

  it('上限为 0 的旧数据经无关写入不被抬到 1', async () => {
    await seed({ id: 'm1', name: '石像', type: 'monster', maxMp: 0, mp: 0 });
    await commit([
      { op: 'update_character', target: 'characters.石像', value: { currentAction: '伫立' } },
    ]);
    const c = await load('石像');
    expect(c.maxMp).toBe(0);
    expect(c.mp).toBe(0);
  });

  it('上限为 0 的怪物经 update_character {maxHp} 旧写法后，maxMp / maxSp 仍为 0', async () => {
    await seed({
      id: 'm2',
      name: '石魔',
      type: 'monster',
      maxMp: 0,
      mp: 0,
      maxSp: 0,
      sp: 0,
    });
    await commit([{ op: 'update_character', target: 'characters.石魔', value: { maxHp: 500 } }]);
    const c = await load('石魔');
    expect(c.maxHp).toBe(500);
    expect([c.maxMp, c.maxSp, c.mp, c.sp]).toEqual([0, 0, 0, 0]);
  });

  it('上限为 0 的怪物经 maxHpBonus delta 后，maxMp / maxSp 仍为 0', async () => {
    const base = calcResources(1, ATTRS);
    await seed({
      id: 'm3',
      name: '傀儡',
      type: 'monster',
      maxHp: base.maxHp,
      maxMp: 0,
      mp: 0,
      maxSp: 0,
      sp: 0,
    });
    await commit([
      {
        op: 'update_character',
        target: 'characters.傀儡',
        value: { maxHpBonus: 30 },
        metadata: { delta: true },
      },
    ]);
    const c = await load('傀儡');
    expect(c.maxHp).toBe(base.maxHp + 30);
    expect([c.maxMp, c.maxSp]).toEqual([0, 0]);
  });

  it('升级后上限保持 0 的项额外重固化为 −新基础；之后额外 +10 → 上限 10（= max(1, 基础 + 额外)）', async () => {
    await seed({
      id: 'm5',
      name: '石像',
      type: 'monster',
      level: 2,
      tier: 1,
      maxMp: 0,
      mp: 0,
      maxMpBonus: -500,
    });
    await commit([{ op: 'update_character', target: 'characters.石像', value: { level: 9 } }]);
    const leveled = await load('石像');
    const newBase = calcResources(leveled.tier, leveled.attributes).maxMp;
    expect(leveled.tier).toBeGreaterThan(1);
    expect(leveled.maxMp).toBe(0);
    expect(leveled.maxMpBonus).toBe(-newBase);
    await commit([
      {
        op: 'update_character',
        target: 'characters.石像',
        value: { maxMpBonus: 10 },
        metadata: { delta: true },
      },
    ]);
    const c = await load('石像');
    expect(c.maxMpBonus).toBe(-newBase + 10);
    expect(c.maxMp).toBe(10);
    expect(c.mp).toBe(0);
  });

  it('属性变化需要重算时，原上限为 0 的项保持 0，其余项按公式重算', async () => {
    const oldBase = calcResources(1, ATTRS);
    await seed({
      id: 'm4',
      name: '幽影',
      type: 'monster',
      maxHp: oldBase.maxHp + 20,
      maxMp: 0,
      mp: 0,
      maxSp: oldBase.maxSp,
    });
    await commit([
      { op: 'update_character', target: 'characters.幽影', value: { attributes: { con: 14 } } },
    ]);
    const c = await load('幽影');
    const newBase = calcResources(1, { ...ATTRS, con: 14 });
    expect(c.maxHp).toBe(newBase.maxHp + 20);
    expect(c.maxSp).toBe(newBase.maxSp);
    expect(c.maxMp).toBe(0);
    expect(c.mp).toBe(0);
  });

  it('只写到 maxHp 时不重算 MP / SP（旧档 MP 上限偏离公式也不被改）', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n9', name: '术士', type: 'npc', maxHp: base.maxHp, maxMp: 3, mp: 3 });
    await commit([{ op: 'update_character', target: 'characters.术士', value: { maxHp: 600 } }]);
    const c = await load('术士');
    expect(c.maxHp).toBe(600);
    expect(c.maxMp).toBe(3);
  });

  it('属性变化后有效上限 = 新基础 + 额外；上限上升时当前值不变', async () => {
    const oldBase = calcResources(1, ATTRS);
    await seed({
      id: 'n2',
      name: '学徒',
      type: 'npc',
      maxHp: oldBase.maxHp + 150,
      hp: 500,
      maxMp: oldBase.maxMp,
      mp: oldBase.maxMp,
    });
    await commit([
      { op: 'update_character', target: 'characters.学徒', value: { attributes: { con: 12 } } },
    ]);
    const c = await load('学徒');
    const newBase = calcResources(1, { ...ATTRS, con: 12 });
    expect(c.maxHpBonus).toBe(150);
    expect(c.maxHp).toBe(newBase.maxHp + 150);
    expect(c.hp).toBe(500);
  });

  it('上限下降时当前值钳到新上限', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n3', name: '病人', type: 'npc', maxHp: base.maxHp, hp: base.maxHp });
    await commit([
      {
        op: 'update_character',
        target: 'characters.病人',
        value: { attributes: { con: -5 } },
        metadata: { delta: true },
      },
    ]);
    const c = await load('病人');
    const newBase = calcResources(1, { ...ATTRS, con: 5 });
    expect(c.maxHp).toBe(newBase.maxHp);
    expect(c.hp).toBe(newBase.maxHp);
  });

  it('层级变化（主角旧兜底升层，全属性 +1）后按新层级与新属性重算', async () => {
    // 五维取 5：升到 T2 后 +1 不触及该层属性上限
    const attrs = { str: 5, dex: 5, con: 5, int: 5, spi: 5 };
    const oldBase = calcResources(1, attrs);
    await seed({
      id: 'p1',
      name: '主角',
      type: 'player',
      attributes: attrs,
      maxHp: oldBase.maxHp + 40,
      hp: 100,
    });
    await commit([{ op: 'update_character', target: 'characters.主角', value: { tier: 2 } }]);
    const c = await load('主角');
    const newAttrs = { str: 6, dex: 6, con: 6, int: 6, spi: 6 };
    expect(c.attributes).toEqual(newAttrs);
    expect(c.maxHp).toBe(calcResources(2, newAttrs).maxHp + 40);
    expect(c.hp).toBe(100);
  });

  it('NPC 写等级：层级由代码按等级推出（补丁自带的矛盾层级被覆盖），并重算上限', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n4', name: '骑士', type: 'npc', level: 1, tier: 1, maxHp: base.maxHp });
    await commit([
      { op: 'update_character', target: 'characters.骑士', value: { level: 10, tier: 1 } },
    ]);
    const c = await load('骑士');
    expect(c.tier).toBe(3);
    expect(c.tierName).toBe('精英');
    expect(c.maxHp).toBe(calcResources(3, ATTRS).maxHp);
    expect(c.maxHpBonus).toBe(0);
  });

  it('旧写法 update_character {maxHp: n} 解释为总上限 n，换算成额外 = n − 基础', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n5', name: '法师', type: 'npc', maxHp: base.maxHp, hp: 900 });
    await commit([{ op: 'update_character', target: 'characters.法师', value: { maxHp: 800 } }]);
    const c = await load('法师');
    expect(c.maxHp).toBe(800);
    expect(c.maxHpBonus).toBe(800 - base.maxHp);
    expect(c.hp).toBe(800);
  });

  it('旧写法与属性变化同一补丁：最终总上限仍是写入的 n', async () => {
    await seed({ id: 'n6', name: '巨人', type: 'npc' });
    await commit([
      {
        op: 'update_character',
        target: 'characters.巨人',
        value: { maxHp: 5000, attributes: { con: 14 } },
      },
    ]);
    const c = await load('巨人');
    expect(c.maxHp).toBe(5000);
    expect(c.maxHpBonus).toBe(5000 - calcResources(1, { ...ATTRS, con: 14 }).maxHp);
  });

  it('旧写法 delta maxHp：总上限 = 旧总值 + d', async () => {
    await seed({ id: 'n7', name: '盾卫', type: 'npc', maxHp: 1200, hp: 1200 });
    await commit([
      {
        op: 'update_character',
        target: 'characters.盾卫',
        value: { maxHp: 30 },
        metadata: { delta: true },
      },
    ]);
    const c = await load('盾卫');
    expect(c.maxHp).toBe(1230);
    expect(c.hp).toBe(1200);
  });

  it('*Bonus 键在白名单内，delta 从固化值起加', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n8', name: '牧师', type: 'npc', maxMp: base.maxMp + 10 });
    await commit([
      {
        op: 'update_character',
        target: 'characters.牧师',
        value: { maxMpBonus: 25 },
        metadata: { delta: true },
      },
    ]);
    const c = await load('牧师');
    expect(c.maxMpBonus).toBe(35);
    expect(c.maxMp).toBe(base.maxMp + 35);
  });

  it('替换写 *Bonus：有效上限 = 基础 + 新额外，并钳到至少 1', async () => {
    const base = calcResources(1, ATTRS);
    await seed({ id: 'n9', name: '幽灵', type: 'npc', hp: 50 });
    await commit([
      {
        op: 'update_character',
        target: 'characters.幽灵',
        value: { maxHpBonus: -base.maxHp - 100, maxSpBonus: 7 },
      },
    ]);
    const c = await load('幽灵');
    expect(c.maxHp).toBe(1);
    expect(c.hp).toBe(1);
    expect(c.maxSp).toBe(base.maxSp + 7);
  });

  it('新建角色：额外缺席时固化为「带来的上限 − 基础」，总上限一分不变；自带额外的项按它重算', async () => {
    const base = calcResources(2, ATTRS);
    await commit([
      {
        op: 'add_character',
        target: 'characters.新人',
        value: createDefaultCharacterState({
          id: 'a1',
          name: '新人',
          type: 'npc',
          tier: 2,
          maxHp: base.maxHp,
          hp: base.maxHp,
          maxMp: base.maxMp,
          mp: base.maxMp,
          maxSp: base.maxSp,
          sp: base.maxSp,
        }),
      },
      {
        op: 'add_character',
        target: 'characters.手写',
        value: createDefaultCharacterState({
          id: 'a3',
          name: '手写',
          type: 'npc',
          tier: 2,
          maxHp: 300,
          hp: 300,
        }),
      },
      {
        op: 'add_character',
        target: 'characters.魔像',
        value: createDefaultCharacterState({
          id: 'a4',
          name: '魔像',
          type: 'monster',
          maxMp: 0,
          mp: 0,
        }),
      },
      {
        op: 'add_character',
        target: 'characters.精灵',
        value: createDefaultCharacterState({
          id: 'a2',
          name: '精灵',
          type: 'npc',
          tier: 2,
          maxMpBonus: 30,
        }),
      },
    ]);
    // 按公式组装（entity_gen / 直出）的角色：额外自然为 0
    const a = await load('新人');
    expect([a.maxHp, a.maxMp, a.maxSp]).toEqual([base.maxHp, base.maxMp, base.maxSp]);
    expect([a.maxHpBonus, a.maxMpBonus, a.maxSpBonus]).toEqual([0, 0, 0]);
    expect(a.hp).toBe(base.maxHp);
    // 手写上限：总上限与当前值都不变，差值变成额外
    const h = await load('手写');
    expect([h.maxHp, h.maxMp, h.maxSp]).toEqual([300, 50, 50]);
    expect(h.hp).toBe(300);
    expect(h.maxHpBonus).toBe(300 - base.maxHp);
    // 上限为 0 的怪物不被抬成 1
    const m = await load('魔像');
    expect(m.maxMp).toBe(0);
    expect(m.mp).toBe(0);
    // 自带额外的那一项按公式 + 额外重算，未带的项总上限不变
    const b = await load('精灵');
    expect(b.maxMpBonus).toBe(30);
    expect(b.maxMp).toBe(base.maxMp + 30);
    expect(b.maxHp).toBe(100);
    expect(b.maxHpBonus).toBe(100 - base.maxHp);
  });
});

describe('文本时长互斥（§5.2）', () => {
  beforeEach(async () => {
    await seed({ id: 'p', name: '主角', type: 'player' });
  });

  it('add_status_effect 带 durationText：remainingTime 存 null，文本落库', async () => {
    await commit([
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '庇护', durationText: ' 直到离开城镇 ', remainingTime: 3 },
      },
    ]);
    const s = (await load('主角')).statusEffects.find((e) => e.name === '庇护')!;
    expect(s.remainingTime).toBeNull();
    expect(s.durationText).toBe('直到离开城镇');
  });

  it('update_status_effect 写数值或 null 的 remainingTime 时清掉 durationText', async () => {
    await commit([
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '庇护', durationText: '直到离开城镇' },
      },
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '祝福', durationText: '直到日落' },
      },
    ]);
    await commit([
      {
        op: 'update_status_effect',
        target: 'characters.主角',
        value: { name: '庇护', remainingTime: 30 },
      },
      {
        op: 'update_status_effect',
        target: 'characters.主角',
        value: { name: '祝福', remainingTime: null },
      },
    ]);
    const effects = (await load('主角')).statusEffects;
    const a = effects.find((e) => e.name === '庇护')!;
    const b = effects.find((e) => e.name === '祝福')!;
    expect(a.remainingTime).toBe(30);
    expect(a.durationText).toBeUndefined();
    expect(b.remainingTime).toBeNull();
    expect(b.durationText).toBeUndefined();
  });

  it('update_status_effect 写 durationText：remainingTime 存 null', async () => {
    await commit([
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '中毒', remainingTime: 5 },
      },
    ]);
    await commit([
      {
        op: 'update_status_effect',
        target: 'characters.主角',
        value: { name: '中毒', durationText: '直到解毒' },
      },
    ]);
    const s = (await load('主角')).statusEffects.find((e) => e.name === '中毒')!;
    expect(s.remainingTime).toBeNull();
    expect(s.durationText).toBe('直到解毒');
  });

  it('同名再施加数值时长：取代文本时长而不是被钉成永久', async () => {
    await commit([
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '庇护', durationText: '直到离开城镇' },
      },
    ]);
    await commit([
      {
        op: 'add_status_effect',
        target: 'characters.主角',
        value: { name: '庇护', remainingTime: 12 },
      },
    ]);
    const s = (await load('主角')).statusEffects.find((e) => e.name === '庇护')!;
    expect(s.remainingTime).toBe(12);
    expect(s.durationText).toBeUndefined();
  });
});

describe('文本消耗互斥（§5.2）', () => {
  beforeEach(async () => {
    await seed({ id: 'p', name: '主角', type: 'player' });
  });

  it('add_skill 只带 costText：落库保留原文，无 cost', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '血祭', costText: '献祭一名同伴' },
      },
    ]);
    const s = (await load('主角')).skills.find((k) => k.name === '血祭')!;
    expect(s.costText).toBe('献祭一名同伴');
    expect(s.cost).toBeUndefined();
  });

  it('add_skill 同时给可解析 cost 与 costText：以 cost 为准', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '火球', cost: { type: 'MP', amount: 10 }, costText: '十点法力' },
      },
    ]);
    const s = (await load('主角')).skills.find((k) => k.name === '火球')!;
    expect(s.cost).toEqual({ type: 'MP', amount: 10 });
    expect(s.costText).toBeUndefined();
  });

  it('add_skill 新建：小写资源类型的 cost 规整为结构化消耗，非 HP/MP/SP 的 cost 转成可读 costText', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '奥术飞弹', cost: { type: 'mp', amount: 10 } as never },
      },
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '神恩', cost: { type: '信仰', amount: 3 } as never },
      },
    ]);
    const skills = (await load('主角')).skills;
    const a = skills.find((k) => k.name === '奥术飞弹')!;
    const b = skills.find((k) => k.name === '神恩')!;
    expect(a.cost).toEqual({ type: 'MP', amount: 10 });
    expect(a.costText).toBeUndefined();
    expect(b.cost).toBeUndefined();
    expect(b.costText).toBe('信仰 3');
  });

  it('add_skill 同名覆盖与新建对认不出的 cost 处理一致', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '奥术飞弹', cost: { type: 'HP', amount: 1 } },
      },
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '神恩', cost: { type: 'SP', amount: 1 } },
      },
    ]);
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '奥术飞弹', cost: { type: 'mp', amount: 10 } as never },
      },
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '神恩', cost: { type: '信仰', amount: 3 } as never },
      },
    ]);
    const skills = (await load('主角')).skills;
    const a = skills.find((k) => k.name === '奥术飞弹')!;
    const b = skills.find((k) => k.name === '神恩')!;
    expect(a.cost).toEqual({ type: 'MP', amount: 10 });
    expect(a.costText).toBeUndefined();
    expect(b.cost).toBeUndefined();
    expect(b.costText).toBe('信仰 3');
  });

  it('认不出的 cost 与显式 costText 同给时，以显式文本为准', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '神恩', cost: { type: '信仰', amount: 3 } as never, costText: '虔诚之心' },
      },
    ]);
    const s = (await load('主角')).skills.find((k) => k.name === '神恩')!;
    expect(s.cost).toBeUndefined();
    expect(s.costText).toBe('虔诚之心');
  });

  it('update_skill 写可解析 cost 时清 costText；写 costText 时清 cost', async () => {
    await commit([
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '血祭', costText: '献祭一名同伴' },
      },
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '火球', cost: { type: 'MP', amount: 10 } },
      },
    ]);
    await commit([
      {
        op: 'update_skill',
        target: 'characters.主角',
        value: { name: '血祭', changes: { cost: { type: 'HP', amount: 50 } } },
      },
      {
        op: 'add_skill',
        target: 'characters.主角',
        value: { name: '火球', costText: '视咏唱长短而定' },
      },
    ]);
    const skills = (await load('主角')).skills;
    const a = skills.find((k) => k.name === '血祭')!;
    const b = skills.find((k) => k.name === '火球')!;
    expect(a.cost).toEqual({ type: 'HP', amount: 50 });
    expect(a.costText).toBeUndefined();
    expect(b.costText).toBe('视咏唱长短而定');
    expect(b.cost).toBeUndefined();
  });
});
