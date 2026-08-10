import { describe, expect, it } from 'vitest';
import type { CombatView } from '@engine/combat-v3';
import { projectUnitsBySide, type V3Unit } from './combat-v3-projection';

/** 最小 CombatUnitView 替身（只填投影用到的字段） */
function unit(id: string, side: 'player' | 'enemy'): V3Unit {
  return {
    id,
    name: id,
    side,
    tier: 1,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    attacksRemaining: 1,
    actionsRemaining: 1,
    canAct: true,
    morale: 'steady',
    statusEffects: [],
  };
}

/** 最小 CombatView 替身：字典 + 优先级数组（刻意分开传，模拟 T13 前 units 可能不全） */
function combatView(order: readonly string[], units: readonly V3Unit[]): CombatView {
  const map: Record<string, V3Unit> = {};
  for (const u of units) map[u.id] = u;
  return {
    combatId: 'c1',
    revision: 0,
    phase: 'CombatOpen',
    round: 1,
    initiativeOrder: order,
    currentTurnIndex: 0,
    units: map,
    resourceSnapshots: { FP: 0 },
  };
}

describe('projectUnitsBySide — v3 字典→有序数组投影（设计 §3.1 A2）', () => {
  it('🔴 顺序严格跟随 initiativeOrder（核心断言：投影片段顺序正确）', () => {
    // 丙先动、甲次之、乙最后 —— 字典是无序的，顺序只能来自 initiativeOrder
    const view = combatView(
      ['丙', '甲', '乙'],
      [unit('甲', 'player'), unit('乙', 'enemy'), unit('丙', 'player')],
    );
    const allies = projectUnitsBySide(view, 'player');
    expect(allies.map((u) => u.id)).toEqual(['丙', '甲']);
  });

  it('按 side 过滤：player 与 enemy 各回各的阵营', () => {
    const view = combatView(
      ['甲', '乙', '丙'],
      [unit('甲', 'player'), unit('乙', 'enemy'), unit('丙', 'enemy')],
    );
    expect(projectUnitsBySide(view, 'player').map((u) => u.id)).toEqual(['甲']);
    expect(projectUnitsBySide(view, 'enemy').map((u) => u.id)).toEqual(['乙', '丙']);
  });

  it('null combat → 空数组（未开战/已结束不炸）', () => {
    expect(projectUnitsBySide(null, 'player')).toEqual([]);
    expect(projectUnitsBySide(null, 'enemy')).toEqual([]);
  });

  it('initiativeOrder 引用不在 units 字典的单位 → 静默跳过（T13 前 units 是空字典）', () => {
    // 与 T13 之前的 store 形状一致：v3_combat_started 只填了 initiativeOrder、units={}
    const emptyUnits = combatView(['甲', '乙'], []);
    expect(projectUnitsBySide(emptyUnits, 'player')).toEqual([]);
    expect(projectUnitsBySide(emptyUnits, 'enemy')).toEqual([]);

    // 部分缺失（单位已倒下/被移除）同样跳过，不抛
    const partial = combatView(['甲', '乙', '丙'], [unit('甲', 'player'), unit('丙', 'player')]);
    expect(projectUnitsBySide(partial, 'player').map((u) => u.id)).toEqual(['甲', '丙']);
  });
});
