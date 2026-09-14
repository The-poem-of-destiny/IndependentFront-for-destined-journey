import { describe, expect, it } from 'vitest';
import {
  accumulateVisibleCombatFacts,
  createCombatVisibilityState,
  executeVisibleUnitQuery,
  projectCombatStateForRole,
} from './agent-visibility';
import { createCombatState, toView } from './state';
import { mkBundle } from './test-utils';

describe('combat agent visibility', () => {
  const view = toView(createCombatState(mkBundle()));
  const characters: Record<string, unknown>[] = [
    {
      id: '甲',
      name: '甲',
      race: '人类',
      attributes: { str: 8 },
      skills: [{ name: '秘剑', description: '未公开技能' }],
      inventory: [{ name: '秘密药剂', quantity: 1 }],
    },
    {
      id: '乙',
      name: '乙',
      race: '魔物',
      attributes: { str: 7 },
      skills: [{ name: '撕咬', description: '咬击' }],
      inventory: [{ name: '兽牙', quantity: 1, equippedSlot: '武器' }],
    },
  ];

  it('主持人保留精确 Kernel 投影，敌方对玩家只见 HP 比例', () => {
    const visibility = createCombatVisibilityState();
    const host = projectCombatStateForRole(view, 'combat_host', visibility);
    const enemy = projectCombatStateForRole(view, 'combat_enemy', visibility);
    const hostPlayer = (host.units as Array<Record<string, unknown>>).find((u) => u.name === '甲')!;
    const enemyPlayer = (enemy.units as Array<Record<string, unknown>>).find(
      (u) => u.name === '甲',
    )!;

    expect(hostPlayer.hp).toBe(500);
    expect(hostPlayer.maxHp).toBe(500);
    expect(enemyPlayer.hpPercent).toBe(100);
    expect(enemyPlayer).not.toHaveProperty('hp');
    expect(enemyPlayer).not.toHaveProperty('maxHp');
    expect(enemyPlayer).not.toHaveProperty('mp');
    expect(enemy).not.toHaveProperty('resourceSnapshots');
  });

  it('玩家公开使用技能后，敌方只新增公开技能名而非完整技能记录', () => {
    const visibility = accumulateVisibleCombatFacts(createCombatVisibilityState(), [
      {
        kind: 'AttackDeclared',
        attackerId: '甲',
        targetId: '乙',
        skill: '秘剑',
        intentionLevel: '常规',
      },
    ]);
    const result = executeVisibleUnitQuery({
      kind: 'get_unit_detail',
      requestedName: '甲',
      role: 'combat_enemy',
      view,
      visibility,
      characters,
    });
    const character = result.character as Record<string, unknown>;
    expect(character.revealedSkills).toEqual(['秘剑']);
    expect(character).not.toHaveProperty('skills');
    expect(JSON.stringify(result)).not.toContain('未公开技能');
  });

  it('换用 get_inventory 也不能读取玩家背包，己方查询使用最新 Kernel 动态值', () => {
    const visibility = createCombatVisibilityState();
    const denied = executeVisibleUnitQuery({
      kind: 'get_inventory',
      requestedName: '甲',
      role: 'combat_enemy',
      view,
      visibility,
      characters,
    });
    const own = executeVisibleUnitQuery({
      kind: 'get_unit_detail',
      requestedName: '乙',
      role: 'combat_enemy',
      view,
      visibility,
      characters,
    });
    expect(denied.found).toBe(false);
    expect(JSON.stringify(denied)).not.toContain('秘密药剂');
    expect((own.character as Record<string, unknown>).hp).toBe(view.units['乙'].hp);
    expect((own.character as Record<string, unknown>).skills).toEqual([
      expect.objectContaining({ name: '撕咬' }),
    ]);
  });

  it('查询只接受参战单位展示名，未知对象返回不泄露式未找到', () => {
    const result = executeVisibleUnitQuery({
      kind: 'get_character',
      requestedName: '不存在',
      role: 'combat_enemy',
      view,
      visibility: createCombatVisibilityState(),
      characters,
    });
    expect(result).toEqual({ found: false, reason: '未找到可见的参战单位' });
  });
});
