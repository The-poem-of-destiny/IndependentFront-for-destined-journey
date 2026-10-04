/**
 * settlement.test.ts —— CombatState → StatePatch[] 白名单写回
 */
import { describe, it, expect } from 'vitest';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import type { CharacterState, StatePatch, StatusEffect } from '../../../../src/core/types/types';
import {
  buildCombatSettlementPatches,
  computeCombatExpRewards,
  deriveCombatOutcome,
  isCombatOutcome,
  normalizeCombatOutcome,
} from '../../../../src/core/combat/sandbox/settlement';
import {
  applyOps,
  cloneCombatState,
  createCombatState,
} from '../../../../src/core/combat/sandbox/state';

function makeChar(name: string, statusEffects: StatusEffect[] = []): CharacterState {
  return createDefaultCharacterState({
    id: name,
    saveId: 's1',
    name,
    hp: 100,
    maxHp: 200,
    mp: 30,
    maxMp: 60,
    sp: 10,
    maxSp: 40,
    statusEffects,
  });
}

function findPatches(patches: StatePatch[], op: string, target?: string): StatePatch[] {
  return patches.filter((p) => p.op === op && (target === undefined || p.target === target));
}

describe('buildCombatSettlementPatches', () => {
  it('只写 origin:save 单位，temp 单位丢弃', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 1 },
      ],
    });
    const patched = applyOps(state, '艾莉丝', [{ op: 'set', field: 'hp', value: 77 }]);
    const patches = buildCombatSettlementPatches(patched, [makeChar('艾莉丝')]);

    expect(findPatches(patches, 'set_hp', 'characters.艾莉丝')[0]?.value).toBe(77);
    expect(findPatches(patches, 'set_mp', 'characters.艾莉丝')[0]?.value).toBe(30);
    expect(findPatches(patches, 'set_sp', 'characters.艾莉丝')[0]?.value).toBe(10);
    // 临时单位不写回
    expect(patches.some((p) => p.target === 'characters.哥布林')).toBe(false);
  });

  it('找不到对应存档角色时跳过（不硬造）', () => {
    const state = createCombatState({
      combatants: [{ character: makeChar('幽灵'), side: 'enemy' }],
    });
    const patches = buildCombatSettlementPatches(state, []);
    expect(patches).toEqual([]);
  });

  it('状态差量：初始有终局无 → remove；终局有 → add', () => {
    const poison: StatusEffect = {
      name: '中毒',
      description: '中毒',
      category: '减益',
      stacks: 1,
      remainingTime: 2,
      timeUnit: '回合',
      source: '毒刃',
      effects: {},
    };
    const initial = makeChar('艾莉丝', [poison]);
    const state = createCombatState({ combatants: [{ character: initial, side: 'ally' }] });

    const finalState = cloneCombatState(state);
    finalState.units['艾莉丝'].statusEffects = [{ name: '祝福', tempSource: '临时' }];

    const patches = buildCombatSettlementPatches(finalState, [initial]);
    const removes = findPatches(patches, 'remove_status_effect', 'characters.艾莉丝');
    const adds = findPatches(patches, 'add_status_effect', 'characters.艾莉丝');
    expect(removes.map((p) => p.value.name)).toEqual(['中毒']);
    expect(adds.map((p) => p.value.name)).toEqual(['祝福']);
    // 战斗临时标记不落进写回值
    expect((adds[0].value as Record<string, unknown>).tempSource).toBeUndefined();
  });

  it('expByUnit 只写有存档角色的单位，fpDelta 写 profile.fp', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 1 },
      ],
    });
    const patches = buildCombatSettlementPatches(state, [makeChar('艾莉丝')], {
      expByUnit: { 艾莉丝: 120, 哥布林: 999, 缺席者: 5 },
      fpDelta: 10.4,
    });
    const exp = findPatches(patches, 'update_character', 'characters.艾莉丝');
    expect(exp).toHaveLength(1);
    expect(exp[0].value).toEqual({ totalExp: 120 });
    expect(exp[0].metadata).toEqual({ source: 'combat', delta: true });
    expect(patches.some((p) => p.target === 'characters.哥布林')).toBe(false);
    const fp = patches.find((p) => p.op === 'delta_variable');
    expect(fp?.target).toBe('profile.fp');
    expect(fp?.amount).toBe(10);
  });

  it('exp/fp 缺席或不合法时不发 patch', () => {
    const state = createCombatState({
      combatants: [{ character: makeChar('艾莉丝'), side: 'ally' }],
    });
    const patches = buildCombatSettlementPatches(state, [makeChar('艾莉丝')], {
      expByUnit: { 艾莉丝: 0 },
      fpDelta: 0,
    });
    expect(findPatches(patches, 'update_character')).toEqual([]);
    expect(patches.some((p) => p.op === 'delta_variable')).toBe(false);
  });
});

describe('computeCombatExpRewards', () => {
  it('仅 ally_win 结算：被击杀敌方 level × tier 系数，平分给存活存档单位', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { character: makeChar('贝拉'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 3 },
      ],
    });
    state.meta.outcome = 'ally_win';
    state.units['哥布林'].alive = false;
    state.units['哥布林'].hp = 0;
    // tier1 系数 normal = 10 → 3 × 10 = 30 → 2 名存活者各 15
    const rewards = computeCombatExpRewards(state, 'normal');
    expect(rewards.totalExp).toBe(30);
    expect(rewards.expByUnit).toEqual({ 艾莉丝: 15, 贝拉: 15 });
  });

  it('非 ally_win 不发经验', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 3 },
      ],
    });
    state.meta.outcome = 'enemy_win';
    state.units['哥布林'].alive = false;
    expect(computeCombatExpRewards(state, 'normal')).toEqual({ expByUnit: {}, totalExp: 0 });

    state.meta.outcome = 'draw';
    expect(computeCombatExpRewards(state, 'normal')).toEqual({ expByUnit: {}, totalExp: 0 });
  });

  it('判胜但无阵亡记录（AI 没写回状态）→ 按全歼兜底', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 3, hp: 50, maxHp: 50 },
      ],
    });
    state.meta.outcome = 'ally_win';
    // 敌人仍活着（DM 只在正文里宣布全歼）→ 兜底计入
    const rewards = computeCombatExpRewards(state, 'normal');
    expect(rewards.totalExp).toBe(30);
    expect(rewards.expByUnit).toEqual({ 艾莉丝: 30 });
  });

  it('集群衰减：单体 × (1 + (同类数量-1) × 0.2)', () => {
    const state = createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '食腐兽群', side: 'enemy', tier: 1, level: 3, cluster: { alive: 5, total: 5 } },
      ],
    });
    state.meta.outcome = 'ally_win';
    state.units['食腐兽群'].alive = false;
    state.units['食腐兽群'].hp = 0;
    // 单体 3 × tier1 系数 10 = 30；N=5 → 30 × (1 + 4 × 0.2) = 54
    expect(computeCombatExpRewards(state, 'normal').totalExp).toBe(54);
  });
});

describe('deriveCombatOutcome / isCombatOutcome（AI 中文结果归一化）', () => {
  it('isCombatOutcome 只认四值枚举', () => {
    expect(isCombatOutcome('ally_win')).toBe(true);
    expect(isCombatOutcome('fled')).toBe(true);
    expect(isCombatOutcome('胜利（我方全歼敌军）')).toBe(false);
    expect(isCombatOutcome(undefined)).toBe(false);
  });

  function battle(): ReturnType<typeof createCombatState> {
    return createCombatState({
      combatants: [
        { character: makeChar('艾莉丝'), side: 'ally' },
        { name: '哥布林', side: 'enemy', tier: 1, level: 3, hp: 50, maxHp: 50 },
      ],
    });
  }

  it('全歼敌方 → ally_win', () => {
    const state = battle();
    state.units['哥布林'].alive = false;
    state.units['哥布林'].hp = 0;
    expect(deriveCombatOutcome(state)).toBe('ally_win');
  });

  it('我方全灭 → enemy_win', () => {
    const state = battle();
    state.units['艾莉丝'].alive = false;
    state.units['艾莉丝'].hp = 0;
    expect(deriveCombatOutcome(state)).toBe('enemy_win');
  });

  it('双方都还有人 → draw', () => {
    expect(deriveCombatOutcome(battle())).toBe('draw');
  });
});

describe('normalizeCombatOutcome（AI 结果自由文本 → 枚举）', () => {
  it('枚举原样通过', () => {
    expect(normalizeCombatOutcome('ally_win')).toBe('ally_win');
    expect(normalizeCombatOutcome('fled')).toBe('fled');
  });

  it('中文/英文同义词归一化', () => {
    expect(normalizeCombatOutcome('胜利（我方全歼敌军）')).toBe('ally_win');
    expect(normalizeCombatOutcome('victory')).toBe('ally_win');
    expect(normalizeCombatOutcome('战败')).toBe('enemy_win');
    expect(normalizeCombatOutcome('defeat')).toBe('enemy_win');
    expect(normalizeCombatOutcome('成功撤退')).toBe('fled');
    expect(normalizeCombatOutcome('平局')).toBe('draw');
  });

  it('认不出 → null（交给 deriveCombatOutcome 兜底）', () => {
    expect(normalizeCombatOutcome('???')).toBeNull();
    expect(normalizeCombatOutcome(undefined)).toBeNull();
    expect(normalizeCombatOutcome(123 as unknown as string)).toBeNull();
  });
});
