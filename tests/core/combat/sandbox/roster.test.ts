/**
 * roster.test.ts —— marker 名单解析 + 集群聚合（`名字×N`）
 */
import { describe, it, expect } from 'vitest';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import type { CharacterState } from '../../../../src/core/types/types';
import type { CombatTriggerMarker } from '../../../../src/core/types/types';
import {
  COMBAT_CLUSTER_THRESHOLD,
  buildClusterCombatant,
  buildCombatRosterFromMarker,
  parseCombatRoster,
  rosterNames,
} from '../../../../src/core/combat/sandbox/roster';

function makeChar(name: string, over: Partial<CharacterState> = {}): CharacterState {
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
    ...over,
  });
}

function marker(over: Partial<CombatTriggerMarker> = {}): CombatTriggerMarker {
  return { type: 'combat_trigger', rawContent: '', position: 0, ...over };
}

describe('parseCombatRoster', () => {
  it('解析 名字×N，半/全角逗号都吃，未写数量按 1', () => {
    const r = parseCombatRoster('林沼食腐兽×5，理查德, 妲丽安');
    expect(r.get('林沼食腐兽')).toBe(5);
    expect(r.get('理查德')).toBe(1);
    expect(r.get('妲丽安')).toBe(1);
  });

  it('× / * / x / X 都认', () => {
    const r = parseCombatRoster('甲×3, 乙*2, 丙x4, 丁X2');
    expect([r.get('甲'), r.get('乙'), r.get('丙'), r.get('丁')]).toEqual([3, 2, 4, 2]);
  });

  it('同名累加人数', () => {
    const r = parseCombatRoster('林沼食腐兽×2, 林沼食腐兽×3');
    expect(r.get('林沼食腐兽')).toBe(5);
  });

  it('空串 / undefined → 空表', () => {
    expect(parseCombatRoster('').size).toBe(0);
    expect(parseCombatRoster(undefined).size).toBe(0);
  });

  it('rosterNames 去掉数量只留名字', () => {
    expect([...rosterNames(parseCombatRoster('林沼食腐兽×5, 理查德'))]).toEqual([
      '林沼食腐兽',
      '理查德',
    ]);
  });
});

describe('buildClusterCombatant', () => {
  it('资源 = 个体上限 × N，cluster 记存活/总数', () => {
    const c = makeChar('食腐兽');
    const unit = buildClusterCombatant(c, 'enemy', 1, 'left', 5);
    expect(unit.cluster).toEqual({ alive: 5, total: 5 });
    expect(unit.hp).toBe(1000);
    expect(unit.maxHp).toBe(1000);
    expect(unit.mp).toBe(300);
    expect(unit.sp).toBe(200);
  });
});

describe('buildCombatRosterFromMarker', () => {
  it('人数 ≥3 → 聚合成单个集群单位（资源×N），并保留名字', () => {
    const chars = [makeChar('理查德', { type: 'player' }), makeChar('林沼食腐兽', { type: 'npc' })];
    const roster = buildCombatRosterFromMarker(marker({ enemies: '林沼食腐兽×5' }), chars);
    expect(roster).not.toBeNull();
    // 玩家 + 集群 = 2 个单位（不是 1 + 5）
    expect(roster!.combatants).toHaveLength(2);
    const cluster = roster!.combatants.find((c) => c.character?.name === '林沼食腐兽')!;
    expect(cluster.side).toBe('enemy');
    expect(cluster.cluster).toEqual({ alive: 5, total: 5 });
    expect(cluster.maxHp).toBe(1000);
  });

  it('人数 < 阈值 → 不聚合（仍是普通单位）', () => {
    const chars = [makeChar('理查德', { type: 'player' }), makeChar('林沼食腐兽', { type: 'npc' })];
    const roster = buildCombatRosterFromMarker(marker({ enemies: '林沼食腐兽×2' }), chars);
    expect(roster!.combatants).toHaveLength(2);
    const enemy = roster!.combatants.find((c) => c.side === 'enemy')!;
    expect(enemy.cluster).toBeUndefined();
    expect(COMBAT_CLUSTER_THRESHOLD).toBe(3);
  });

  it('未列名字、无名单时，玩家为 ally、其余非玩家为 enemy', () => {
    const chars = [makeChar('理查德', { type: 'player' }), makeChar('路人', { type: 'npc' })];
    const roster = buildCombatRosterFromMarker(marker({}), chars);
    expect(roster!.combatants.find((c) => c.character?.name === '理查德')!.side).toBe('ally');
    expect(roster!.combatants.find((c) => c.character?.name === '路人')!.side).toBe('enemy');
  });

  it('无可参战角色 → null', () => {
    expect(buildCombatRosterFromMarker(marker({ enemies: '林沼食腐兽×3' }), [])).toBeNull();
  });
});
