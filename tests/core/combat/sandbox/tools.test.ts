/**
 * tools.test.ts —— 战斗沙盒工具：定义 / 安全算术 / 状态维护 / 骰子 / 计算
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import {
  COMBAT_SANDBOX_TOOL_DEFINITIONS,
  createCombatToolBinding,
  evaluateArithmetic,
  executeCombatTool,
} from '../../../../src/core/combat/sandbox/tools';
import { createCombatState } from '../../../../src/core/combat/sandbox/state';
import type { CombatState } from '../../../../src/core/combat/sandbox/types';

function makeState(): CombatState {
  return createCombatState({
    combatants: [
      {
        character: createDefaultCharacterState({
          name: '艾莉丝',
          saveId: 's1',
          hp: 200,
          maxHp: 200,
          mp: 50,
          maxMp: 50,
          sp: 40,
          maxSp: 40,
          attributes: { str: 12, dex: 14, con: 10, int: 16, spi: 8 },
        }),
        side: 'ally',
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluateArithmetic', () => {
  it('四则与括号、负号、小数', () => {
    expect(evaluateArithmetic('2+3*4')).toBe(14);
    expect(evaluateArithmetic('(2+3)*4')).toBe(20);
    expect(evaluateArithmetic('-3+10')).toBe(7);
    expect(evaluateArithmetic('10/4')).toBe(2.5);
    expect(evaluateArithmetic('.5+1')).toBe(1.5);
    expect(evaluateArithmetic('100 * (1 + 0.25)')).toBe(125);
  });

  it('拒绝标识符 / 除零 / 括号不匹配 / 多余内容 / 空串', () => {
    expect(() => evaluateArithmetic('alert(1)')).toThrow();
    expect(() => evaluateArithmetic('1/0')).toThrow(/除以零/);
    expect(() => evaluateArithmetic('(1+2')).toThrow();
    expect(() => evaluateArithmetic('1+2)')).toThrow();
    expect(() => evaluateArithmetic('')).toThrow();
  });
});

describe('COMBAT_SANDBOX_TOOL_DEFINITIONS', () => {
  it('含全部 15 个工具，名字齐全', () => {
    const names = COMBAT_SANDBOX_TOOL_DEFINITIONS.map((d) => d.function.name).sort();
    expect(names).toEqual(
      [
        'calc',
        'calc_damage',
        'calc_initiative',
        'combat_add_status',
        'combat_add_unit',
        'combat_remove_status',
        'combat_remove_unit',
        'combat_set_meta',
        'combat_update_unit',
        'combat_yield_to_player',
        'get_character',
        'get_inventory',
        'roll_d20',
        'roll_d100',
        'roll_dice',
      ].sort(),
    );
  });
});

describe('executeCombatTool — 状态维护', () => {
  it('combat_add_unit 加入临时单位', async () => {
    const state = makeState();
    await executeCombatTool(
      'combat_add_unit',
      { name: '哥布林', side: 'enemy', tier: 1, level: 2 },
      state,
    );
    expect(state.units['哥布林'].origin).toBe('temp');
    expect(state.meta.actionOrder).toContain('哥布林');
  });

  it('combat_update_unit 就地改字段（含 extras 点路径）', async () => {
    const state = makeState();
    await executeCombatTool(
      'combat_update_unit',
      {
        name: '艾莉丝',
        ops: [
          { op: 'dec', field: 'hp', value: 35 },
          { op: 'set', field: 'extras.蓄力', value: 1 },
        ],
      },
      state,
    );
    expect(state.units['艾莉丝'].hp).toBe(165);
    expect(state.units['艾莉丝'].extras?.['蓄力']).toBe(1);
  });

  it('combat_update_unit 目标不存在抛错', async () => {
    const state = makeState();
    await expect(
      executeCombatTool('combat_update_unit', { name: '无', ops: [] }, state),
    ).rejects.toThrow(/单位不存在/);
  });

  it('combat_remove_unit 移除并摘行动轴', async () => {
    const state = makeState();
    await executeCombatTool('combat_remove_unit', { name: '艾莉丝' }, state);
    expect(state.units['艾莉丝']).toBeUndefined();
    expect(state.meta.actionOrder).not.toContain('艾莉丝');
  });

  it('combat_add_status / combat_remove_status', async () => {
    const state = makeState();
    await executeCombatTool(
      'combat_add_status',
      { name: '艾莉丝', status: { name: '中毒', stacks: 2, tempSource: '临时' } },
      state,
    );
    expect(state.units['艾莉丝'].statusEffects.some((f) => f.name === '中毒')).toBe(true);
    await executeCombatTool('combat_remove_status', { name: '艾莉丝', statusName: '中毒' }, state);
    expect(state.units['艾莉丝'].statusEffects.some((f) => f.name === '中毒')).toBe(false);
  });

  it('combat_set_meta 合并终局字段（含 fpReward）', async () => {
    const state = makeState();
    await executeCombatTool(
      'combat_set_meta',
      { patch: { phase: 'ended', outcome: 'ally_win', round: 3, fpReward: 5 } },
      state,
    );
    expect(state.meta.phase).toBe('ended');
    expect(state.meta.outcome).toBe('ally_win');
    expect(state.meta.round).toBe(3);
    expect(state.meta.fpReward).toBe(5);
  });

  it('combat_yield_to_player 写入等待玩家', async () => {
    const state = makeState();
    const result = await executeCombatTool(
      'combat_yield_to_player',
      { unit: '艾莉丝', prompt: '轮到你行动', options: ['攻击', '防御'] },
      state,
    );
    expect(result.waitingForPlayer).toBe(true);
    expect(state.meta.pendingPlayerUnit).toBe('艾莉丝');
    expect(state.meta.pendingOptions).toEqual(['攻击', '防御']);
  });
});

describe('executeCombatTool — 骰子与计算', () => {
  it('roll_d20 / roll_d100 / roll_dice 返回骰值', async () => {
    const state = makeState();
    const d20Res = await executeCombatTool('roll_d20', { modifier: 3, reason: '先攻' }, state);
    expect(d20Res.total).toBeGreaterThanOrEqual(4);
    const d100Res = await executeCombatTool('roll_d100', {}, state);
    expect(d100Res.total).toBeGreaterThanOrEqual(1);
    const diceRes = await executeCombatTool('roll_dice', { formula: '2d6' }, state);
    expect(diceRes.total).toBeGreaterThanOrEqual(2);
  });

  it('calc 返回安全求值', async () => {
    const state = makeState();
    const res = await executeCombatTool('calc', { expression: '12 * 10 * 2.0' }, state);
    expect(res.value).toBe(240);
  });

  it('calc_damage 走 8 步管线', async () => {
    const state = makeState();
    const res = (await executeCombatTool(
      'calc_damage',
      {
        relevantAttribute: 10,
        attackerTier: 1,
        damageType: '真实',
        defenderAttributes: { str: 0, dex: 0, con: 0, int: 0, spi: 0 },
      },
      state,
    )) as { finalDamage: number };
    expect(res.finalDamage).toBe(200);
  });

  it('calc_damage 未知伤害类型抛错', async () => {
    const state = makeState();
    await expect(
      executeCombatTool('calc_damage', { relevantAttribute: 1, damageType: '奥术' }, state),
    ).rejects.toThrow(/未知伤害类型/);
  });

  it('calc_initiative 用指定 d20 确定性计算', async () => {
    const state = makeState();
    const res = (await executeCombatTool(
      'calc_initiative',
      { name: '艾莉丝', dex: 10, d20: 5 },
      state,
    )) as { totalInitiative: number; d20Roll: number };
    expect(res.d20Roll).toBe(5);
    expect(res.totalInitiative).toBe(15);
  });

  it('未知工具抛错', async () => {
    const state = makeState();
    await expect(executeCombatTool('nope', {}, state)).rejects.toThrow(/未注册/);
  });
});

describe('createCombatToolBinding', () => {
  it('绑定共享同一个状态实例，getState 反映就地更新', async () => {
    const state = makeState();
    const binding = createCombatToolBinding(state);
    await binding.execute('combat_update_unit', {
      name: '艾莉丝',
      ops: [{ op: 'set', field: 'hp', value: 1 }],
    });
    expect(binding.getState().units['艾莉丝'].hp).toBe(1);
    expect(state.units['艾莉丝'].hp).toBe(1);
    expect(binding.definitions).toBe(COMBAT_SANDBOX_TOOL_DEFINITIONS);
  });
});

describe('executeCombatTool — 只读查询', () => {
  it('get_character：在场单位直接返回战斗视图', async () => {
    const state = makeState();
    const res = (await executeCombatTool('get_character', { name: '艾莉丝' }, state)) as Record<
      string,
      unknown
    >;
    expect(res.name).toBe('艾莉丝');
    expect(res.attributes).toEqual({ str: 12, dex: 14, con: 10, int: 16, spi: 8 });
  });

  it('get_character / get_inventory：不在场单位退回存档角色', async () => {
    const state = makeState();
    const hero = createDefaultCharacterState({
      id: 'hero',
      saveId: 's1',
      name: '理查德',
      hp: 40,
      maxHp: 100,
      inventory: [],
    });
    const charRes = (await executeCombatTool('get_character', { name: '理查德' }, state, [
      hero,
    ])) as Record<string, unknown>;
    expect(charRes.name).toBe('理查德');
    expect(charRes.hp).toBe(40);
    const invRes = (await executeCombatTool('get_inventory', { name: '理查德' }, state, [
      hero,
    ])) as Record<string, unknown>;
    expect(invRes.inventory).toEqual([]);
  });

  it('查不到角色时抛错', async () => {
    const state = makeState();
    await expect(executeCombatTool('get_inventory', { name: '失踪者' }, state, [])).rejects.toThrow(
      /角色不存在/,
    );
  });
});
