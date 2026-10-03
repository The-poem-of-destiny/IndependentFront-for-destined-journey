/**
 * state.ts 测试 —— 建状态 / 纯函数字段操作 / 不变量告警 / 状态增删 / meta
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import type { CharacterState } from '../../../../src/core/types/types';
import { calcResources } from '../../../../src/core/character/tier-constants';
import {
  addCombatUnit,
  addStatusEffect,
  applyOps,
  cloneCombatState,
  collectInvariantViolations,
  createCombatState,
  createCombatUnit,
  getCombatUnit,
  listCombatUnits,
  removeCombatUnit,
  removeStatusEffect,
  setCombatMeta,
  snapshotCombatState,
  toCombatStatus,
  toSaveStatus,
} from '../../../../src/core/combat/sandbox/state';

function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: 'id-1',
    saveId: 's1',
    name: '艾莉丝',
    tier: 2,
    level: 6,
    race: '人类',
    attributes: { str: 12, dex: 14, con: 10, int: 16, spi: 8 },
    hp: 300,
    maxHp: 400,
    mp: 100,
    maxMp: 120,
    sp: 80,
    maxSp: 90,
    skills: [{ name: '火球术', description: '火', type: 'active', skillPower: 40 }],
    inventory: [
      { name: '长剑', quantity: 1, equippedSlot: 'mainHand', rarity: '稀有' },
      { name: '面包', quantity: 2 },
    ],
    statusEffects: [
      {
        name: '祝福',
        description: '增益',
        category: '增益',
        stacks: 1,
        remainingTime: 3,
        timeUnit: '回合',
        source: '神术',
        effects: {},
      },
    ],
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCombatState', () => {
  it('从存档角色建 origin:save 单位（真实字段 + 技能/装备/状态）', () => {
    const state = createCombatState({
      combatants: [{ character: makeChar(), side: 'ally' }],
      fillResources: false,
    });
    const unit = state.units['艾莉丝'];
    expect(unit.origin).toBe('save');
    expect(unit.side).toBe('ally');
    expect(unit.hp).toBe(300);
    expect(unit.maxHp).toBe(400);
    expect(unit.attributes.dex).toBe(14);
    expect(unit.skills?.[0].name).toBe('火球术');
    expect(unit.equipment?.map((e) => e.name)).toEqual(['长剑']);
    expect(unit.statusEffects[0].name).toBe('祝福');
    expect(state.meta.actionOrder).toEqual(['艾莉丝']);
    expect(state.meta.phase).toBe('active');
  });

  it('maxHp/maxMp/maxSp 缺省为 0 时按 tier-constants 补齐', () => {
    const attrs = { str: 12, dex: 14, con: 10, int: 16, spi: 8 };
    const char = makeChar({ maxHp: 0, maxMp: 0, maxSp: 0, hp: 0, mp: 0, sp: 0 });
    const state = createCombatState({ combatants: [{ character: char, side: 'enemy' }] });
    const expected = calcResources(2, attrs);
    const unit = state.units['艾莉丝'];
    expect(unit.maxHp).toBe(expected.maxHp);
    expect(unit.maxMp).toBe(expected.maxMp);
    expect(unit.maxSp).toBe(expected.maxSp);
    // 当前值不被补齐（0 的 hp 是合法状态，不擅自回满）
    expect(unit.hp).toBe(0);
  });

  it('临时单位 origin:temp，并可自定义字段', () => {
    const state = createCombatState({
      combatants: [
        {
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 2,
          attributes: { str: 6, dex: 5, con: 4, int: 2, spi: 2 },
          cluster: { alive: 3, total: 3 },
        },
      ],
    });
    const unit = state.units['哥布林'];
    expect(unit.origin).toBe('temp');
    expect(unit.cluster).toEqual({ alive: 3, total: 3 });
    expect(unit.maxHp).toBeGreaterThan(0);
  });

  it('缺少名字时建单位抛错', () => {
    expect(() => createCombatUnit({ side: 'ally' })).toThrow(/缺少单位名/);
  });
});

describe('applyOps', () => {
  it('set / inc / dec / remove extras 生效且不改原状态（纯函数）', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const before = JSON.stringify(state);
    const next = applyOps(state, '艾莉丝', [
      { op: 'set', field: 'hp', value: 250 },
      { op: 'inc', field: 'mp', value: 10 },
      { op: 'dec', field: 'sp', value: 5 },
      { op: 'set', field: 'extras.蓄力', value: 2 },
      { op: 'remove', field: 'extras.蓄力' },
    ]);
    expect(next.units['艾莉丝'].hp).toBe(250);
    expect(next.units['艾莉丝'].mp).toBe(110);
    expect(next.units['艾莉丝'].sp).toBe(75);
    expect(next.units['艾莉丝'].extras?.['蓄力']).toBeUndefined();
    expect(JSON.stringify(state)).toBe(before); // 原状态未变
  });

  it('attributes.<键> / slots.<槽> 点路径可写', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const next = applyOps(state, '艾莉丝', [
      { op: 'set', field: 'attributes.dex', value: 20 },
      { op: 'dec', field: 'slots.attack', value: 1 },
    ]);
    expect(next.units['艾莉丝'].attributes.dex).toBe(20);
    expect(next.units['艾莉丝'].slots.attack).toBe(0);
  });

  it('负数 / 超上限只 warn 不抛，且照写', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const next = applyOps(state, '艾莉丝', [
      { op: 'set', field: 'hp', value: 9999 },
      { op: 'set', field: 'mp', value: -5 },
    ]);
    expect(next.units['艾莉丝'].hp).toBe(9999);
    expect(next.units['艾莉丝'].mp).toBe(-5);
    expect(warn).toHaveBeenCalled();
  });

  it('目标单位不存在时 warn 并原样返回', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const next = applyOps(state, '不存在', [{ op: 'set', field: 'hp', value: 1 }]);
    expect(Object.keys(next.units)).toEqual(['艾莉丝']);
    expect(warn).toHaveBeenCalled();
  });

  it('未知字段 warn 且忽略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const next = applyOps(state, '艾莉丝', [{ op: 'set', field: '不存在字段', value: 1 }]);
    expect(
      (next.units['艾莉丝'] as unknown as Record<string, unknown>)['不存在字段'],
    ).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('collectInvariantViolations', () => {
  it('负数与超上限均被收集', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const unit = state.units['艾莉丝'];
    unit.hp = 9999;
    unit.mp = -1;
    const violations = collectInvariantViolations(unit);
    expect(violations.some((v) => v.includes('hp'))).toBe(true);
    expect(violations.some((v) => v.includes('mp'))).toBe(true);
  });

  it('合规单位零违规', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    expect(collectInvariantViolations(state.units['艾莉丝'])).toEqual([]);
  });
});

describe('状态 / meta / 单位增删', () => {
  it('addCombatUnit 加入并进入行动轴；removeCombatUnit 摘除', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const withUnit = addCombatUnit(state, { name: '狼', side: 'enemy', tier: 1, level: 1 });
    expect(withUnit.units['狼']).toBeDefined();
    expect(withUnit.meta.actionOrder).toContain('狼');
    const removed = removeCombatUnit(withUnit, '狼');
    expect(removed.units['狼']).toBeUndefined();
    expect(removed.meta.actionOrder).not.toContain('狼');
  });

  it('addStatusEffect 同名覆盖 / removeStatusEffect 移除', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const added = addStatusEffect(state, '艾莉丝', { name: '中毒', stacks: 2, tempSource: '临时' });
    expect(added.units['艾莉丝'].statusEffects.some((fx) => fx.name === '中毒')).toBe(true);

    const refreshed = addStatusEffect(added, '艾莉丝', { name: '中毒', stacks: 3 });
    expect(refreshed.units['艾莉丝'].statusEffects.filter((fx) => fx.name === '中毒')).toHaveLength(
      1,
    );
    expect(refreshed.units['艾莉丝'].statusEffects.find((fx) => fx.name === '中毒')?.stacks).toBe(
      3,
    );

    const removed = removeStatusEffect(refreshed, '艾莉丝', '中毒');
    expect(removed.units['艾莉丝'].statusEffects.some((fx) => fx.name === '中毒')).toBe(false);
  });

  it('setCombatMeta 浅合并', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const next = setCombatMeta(state, { phase: 'ended', outcome: 'ally_win', round: 5 });
    expect(next.meta.phase).toBe('ended');
    expect(next.meta.outcome).toBe('ally_win');
    expect(next.meta.round).toBe(5);
    expect(state.meta.phase).toBe('active'); // 原状态未变
  });
});

describe('clone / snapshot / 查询 / 状态转换', () => {
  it('cloneCombatState / snapshotCombatState 深拷贝且互不影响', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    const clone = cloneCombatState(state);
    const snap = snapshotCombatState(state);
    clone.units['艾莉丝'].hp = 1;
    snap.units['艾莉丝'].hp = 2;
    expect(state.units['艾莉丝'].hp).toBe(300);
  });

  it('getCombatUnit / listCombatUnits', () => {
    const state = createCombatState({ combatants: [{ character: makeChar(), side: 'ally' }] });
    expect(getCombatUnit(state, '艾莉丝')?.name).toBe('艾莉丝');
    expect(getCombatUnit(state, '无')).toBeUndefined();
    expect(listCombatUnits(state)).toHaveLength(1);
  });

  it('toCombatStatus 保留字段 / toSaveStatus 剥去 tempSource 并补齐必填', () => {
    const combat = toCombatStatus({
      name: '祝福',
      description: '增益',
      category: '增益',
      stacks: 2,
      remainingTime: 3,
      timeUnit: '回合',
      source: '神术',
      effects: { str: 1 },
    });
    expect(combat.name).toBe('祝福');
    const save = toSaveStatus({ name: '蓄力', tempSource: '蓄力' });
    expect(save.description).toBe('');
    expect(save.category).toBe('特殊');
    expect(save.stacks).toBe(1);
    expect(save.remainingTime).toBeNull();
    expect(save.timeUnit).toBe('回合');
    expect((save as unknown as Record<string, unknown>).tempSource).toBeUndefined();
  });
});
