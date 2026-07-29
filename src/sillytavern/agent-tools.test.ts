/**
 * agent-tools.test.ts — Agent 工具注册表测试
 *
 * 覆盖范围:
 *  1. AGENT_TOOL_MAP['combat'] 存在且含全部 13 新工具 + 7 复用工具（共 20）
 *  2. getToolsForAgent('combat') 返回的工具名集合 = 白名单
 *  3. 每个新 combat/status 工具 schema 结构完整 (name/description/parameters)
 *  4. executeToolCall 旧通道占位行为:
 *     - combat_* / get_combat_state / status_apply / status_remove 抛 PipelineContext 占位错误
 *       （combat 工具走独立 executeCombatToolCall 通道，旧通道仍 throw 引导）
 *     - status_query 接真函数（按名寻址 / 缺省返回全部 / 指定 buff 聚合层数）
 *  5. 复用工具 (roll_d20 等) 仍可正常工作（回归保护）
 *  6. executeCombatToolCall 独立通道（B 方案, M4 任务 5.2）:
 *     - combat_start: initCombat 返回合法 CombatState
 *     - combat_attack: resolveAttackPipeline 走通，返回 CombatActionResult 含 patches/damage
 *     - status_apply: applyStatusIntents 去重正确
 *     - get_combat_state: 只读快照
 *     - 占位工具在新通道不再 throw（combat_* 走 executeCombatToolCall 正常执行）
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_TOOL_DEFINITIONS,
  AGENT_TOOL_MAP,
  getToolsForAgent,
  getToolDefinition,
  executeToolCall,
  executeCombatToolCall,
} from './agent-tools';
import type { ToolExecutionContext, CharacterState } from './types';
import { EventBus } from './game-event';

// ═══════════════════════════════════════════════════════════
// 测试夹具
// ═══════════════════════════════════════════════════════════

function makeCharacter(partial: Partial<CharacterState>): CharacterState {
  return {
    id: 'char_1',
    name: '主角',
    race: '智人种',
    type: 'player',
    tier: 1,
    tierName: 'T1',
    level: 1,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    hp: 100, maxHp: 100,
    mp: 50, maxMp: 50,
    sp: 50, maxSp: 50,
    location: '奥古斯提姆帝国·王都',
    inventory: [],
    statusEffects: [],
    ...partial,
  } as CharacterState;
}

function makeCtx(characters: CharacterState[] = []): ToolExecutionContext {
  return {
    characters,
    variables: {},
    saveId: 'save_test',
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 白名单完整性
// ═══════════════════════════════════════════════════════════

describe('AGENT_TOOL_MAP["combat"] 白名单', () => {
  it('combat 条目存在且非空', () => {
    expect(AGENT_TOOL_MAP.combat).toBeDefined();
    expect(AGENT_TOOL_MAP.combat.length).toBeGreaterThan(0);
  });

  it('含全部 13 个新工具 + 7 个复用工具（共 20）', () => {
    const combatTools = AGENT_TOOL_MAP.combat;
    // 13 个新建工具
    const newTools = [
      'combat_start', 'combat_attack', 'combat_use_skill', 'combat_use_item',
      'combat_block', 'combat_move', 'combat_focus', 'combat_flee', 'combat_end',
      'status_apply', 'status_remove', 'status_query',
      'get_combat_state',
    ];
    // 7 个复用工具
    const reuseTools = ['roll_d20', 'roll_d100', 'roll_dice', 'get_character', 'get_hp_percent', 'get_inventory'];
    for (const name of [...newTools, ...reuseTools]) {
      expect(combatTools, `白名单缺工具: ${name}`).toContain(name);
    }
    // 总数 = 13 新 + 6 复用（roll_d20/roll_d100/roll_dice/get_character/get_hp_percent/get_inventory）
    expect(combatTools.length).toBe(newTools.length + reuseTools.length);
  });

  it('其他 Agent 白名单不受影响（回归保护）', () => {
    expect(AGENT_TOOL_MAP.craft_gen).toBeDefined();
    expect(AGENT_TOOL_MAP.char_gen).toBeDefined();
    expect(AGENT_TOOL_MAP.item_gen).toBeDefined();
    expect(AGENT_TOOL_MAP.vars_update).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. getToolsForAgent('combat')
// ═══════════════════════════════════════════════════════════

describe('getToolsForAgent("combat")', () => {
  it('返回的工具名集合 = 白名单', () => {
    const tools = getToolsForAgent('combat');
    const names = tools.map(t => t.function.name);
    expect(names.sort()).toEqual([...AGENT_TOOL_MAP.combat].sort());
  });

  it('每个返回的工具都有 type=function', () => {
    const tools = getToolsForAgent('combat');
    for (const t of tools) {
      expect(t.type).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 新工具 schema 结构完整性
// ═══════════════════════════════════════════════════════════

describe('新 combat/status 工具 schema 结构', () => {
  const newToolNames = [
    'combat_start', 'combat_attack', 'combat_use_skill', 'combat_use_item',
    'combat_block', 'combat_move', 'combat_focus', 'combat_flee', 'combat_end',
    'status_apply', 'status_remove', 'status_query',
    'get_combat_state',
  ];

  it('全部 13 个工具在 ALL_TOOL_DEFINITIONS 中注册', () => {
    for (const name of newToolNames) {
      const def = getToolDefinition(name);
      expect(def, `工具未注册: ${name}`).toBeDefined();
    }
  });

  it('每个工具有 name / description / parameters 三字段', () => {
    for (const name of newToolNames) {
      const def = getToolDefinition(name)!;
      expect(def.function.name).toBe(name);
      expect(def.function.description, `${name} 缺 description`).toBeTruthy();
      expect(def.function.description!.length, `${name} description 过短`).toBeGreaterThan(10);
      expect(def.function.parameters, `${name} 缺 parameters`).toBeDefined();
      expect(def.function.parameters!.type).toBe('object');
    }
  });

  it('combat_attack 的 damageType 枚举为中文 4 类', () => {
    const def = getToolDefinition('combat_attack')!;
    const dmgType = def.function.parameters!.properties!.damageType as any;
    expect(dmgType.enum).toEqual(['物理', '能量', '精神', '真实']);
  });

  it('combat_start 的 combatType 枚举为 6 类', () => {
    const def = getToolDefinition('combat_start')!;
    const ct = def.function.parameters!.properties!.combatType as any;
    expect(ct.enum).toEqual(['切磋', '竞技', '压制', '死斗', '标准', '守卫']);
  });

  it('status_apply 的 category 枚举为 3 类', () => {
    const def = getToolDefinition('status_apply')!;
    const cat = def.function.parameters!.properties!.category as any;
    expect(cat.enum).toEqual(['增益', '减益', '特殊']);
  });

  it('combat_attack 含真实计算纪律声明', () => {
    const def = getToolDefinition('combat_attack')!;
    expect(def.function.description).toContain('真实计算');
  });

  it('涉及骰值的工具含禁造骰值声明', () => {
    const diceTools = ['combat_attack', 'combat_flee', 'combat_start'];
    for (const name of diceTools) {
      const def = getToolDefinition(name)!;
      expect(def.function.description, `${name} 应声明禁止编造骰值`).toContain('roll_d20');
    }
  });

  it('required 字段非空时为字符串数组', () => {
    for (const name of newToolNames) {
      const def = getToolDefinition(name)!;
      const required = def.function.parameters!.required;
      if (required) {
        expect(Array.isArray(required)).toBe(true);
        for (const r of required) {
          expect(typeof r).toBe('string');
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 4. executeToolCall 占位行为
// ═══════════════════════════════════════════════════════════

describe('executeToolCall combat 占位分发', () => {
  const placeholderTools = [
    'combat_start', 'combat_attack', 'combat_use_skill', 'combat_use_item',
    'combat_block', 'combat_move', 'combat_focus', 'combat_flee', 'combat_end',
    'get_combat_state',
    'status_apply', 'status_remove',
  ];
  const ctx = makeCtx();

  for (const name of placeholderTools) {
    it(`「${name}」抛 PipelineContext 占位错误`, async () => {
      await expect(executeToolCall(name, {}, ctx)).rejects.toThrow();
      try {
        await executeToolCall(name, {}, ctx);
      } catch (e: any) {
        expect(e.message).toContain('PipelineContext');
      }
    });
  }

  it('占位错误含文档引用 docs/reference/combat-agent-api.md', async () => {
    try {
      await executeToolCall('combat_attack', {}, makeCtx());
      expect.unreachable('应抛错');
    } catch (e: any) {
      expect(e.message).toContain('combat-agent-api.md');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 5. status_query 接真函数
// ═══════════════════════════════════════════════════════════

describe('executeToolCall status_query（接真函数）', () => {
  it('按名寻址：找不到角色返回 found:false', async () => {
    const ctx = makeCtx([]);
    const r = await executeToolCall('status_query', { target: '不存在的人' }, ctx);
    expect(r.found).toBe(false);
    expect(r.target).toBe('不存在的人');
  });

  it('缺省 buffIdOrName 返回全部 statusEffects', async () => {
    const char = makeCharacter({
      name: '勇者',
      statusEffects: [
        { name: '流血', description: 'd', category: '减益', stacks: 2, remainingTime: 3, timeUnit: '回合', source: 's', effects: {}, sourceKey: '剑' } as any,
        { name: '专注', description: 'd', category: '增益', stacks: 1, remainingTime: null, timeUnit: '回合', source: 's', effects: {} } as any,
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('status_query', { target: '勇者' }, ctx);
    expect(r.found).toBe(true);
    expect(r.count).toBe(2);
    expect(r.statusEffects).toHaveLength(2);
  });

  it('指定裸 name 聚合同名多源层数', async () => {
    const char = makeCharacter({
      name: '战士',
      statusEffects: [
        { name: '流血', description: 'd', category: '减益', stacks: 2, remainingTime: 3, timeUnit: '回合', source: 's', effects: {}, sourceKey: '剑A' } as any,
        { name: '流血', description: 'd', category: '减益', stacks: 3, remainingTime: 3, timeUnit: '回合', source: 's', effects: {}, sourceKey: '剑B' } as any,
        { name: '中毒', description: 'd', category: '减益', stacks: 1, remainingTime: 3, timeUnit: '回合', source: 's', effects: {} } as any,
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('status_query', { target: '战士', buffIdOrName: '流血' }, ctx);
    expect(r.has).toBe(true);
    expect(r.stacks).toBe(5); // 2 + 3
    expect(r.matched).toHaveLength(2);
  });

  it('指定完整 buffId 精确匹配', async () => {
    const char = makeCharacter({
      name: '法师',
      statusEffects: [
        { name: '灼烧', description: 'd', category: '减益', stacks: 1, remainingTime: 3, timeUnit: '回合', source: 's', effects: {}, sourceKey: '火杖' } as any,
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('status_query', { target: '法师', buffIdOrName: '火杖.灼烧' }, ctx);
    expect(r.has).toBe(true);
    expect(r.stacks).toBe(1);
    expect(r.matched).toHaveLength(1);
  });

  it('指定不存在的 buff 返回 has:false', async () => {
    const char = makeCharacter({ name: '游侠', statusEffects: [] });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('status_query', { target: '游侠', buffIdOrName: '冰冻' }, ctx);
    expect(r.has).toBe(false);
    expect(r.stacks).toBe(0);
  });

  it('角色无 statusEffects 字段时容错返回空', async () => {
    const char = makeCharacter({ name: '新人', statusEffects: undefined as any });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('status_query', { target: '新人' }, ctx);
    expect(r.found).toBe(true);
    expect(r.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 复用工具回归保护
// ═══════════════════════════════════════════════════════════

describe('复用工具回归保护', () => {
  it('roll_d20 仍正常工作', async () => {
    const r = await executeToolCall('roll_d20', { modifier: 5, reason: '攻击检定' }, makeCtx());
    expect(r).toHaveProperty('total');
    expect(r).toHaveProperty('rolls');
    expect(r.reason).toBe('攻击检定');
  });

  it('get_hp_percent 仍按 id 寻址（未受 combat 改动影响）', async () => {
    const char = makeCharacter({ id: 'char_1', name: '测试员', hp: 30, maxHp: 100 });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('get_hp_percent', { characterId: 'char_1' }, ctx);
    expect(r.hpPercent).toBe(30);
  });

  it('未知工具仍抛错', async () => {
    await expect(executeToolCall('不存在的工具', {}, makeCtx())).rejects.toThrow('未知工具');
  });
});

// ═══════════════════════════════════════════════════════════
// 6. executeCombatToolCall 独立通道（B 方案, M4 任务 5.2）
// ═══════════════════════════════════════════════════════════

import type {
  CombatState,
  CombatParticipant,
  StatusEffect,
} from './types';
import type { CombatToolContext } from './agent-tools';

// ── combat 专用夹具 ──

function makeCombatParticipant(o: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'default',
    name: '默认',
    tier: 3,
    level: 10,
    attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
    hp: 1000, maxHp: 1000,
    mp: 50, maxMp: 50, sp: 50, maxSp: 50,
    defense: 100, dr: 0, penetration: 0,
    hitBonus: 3, dodgeBonus: 2,
    speedModifiers: [], fixedInitiativeBonus: 0,
    attacksRemaining: 1, actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 25, side: 'ally', canAct: true,
    ...o,
  };
}

function makeCombatState(o: Partial<CombatState> = {}): CombatState {
  return {
    combatId: 'tool-test-01',
    combatType: '标准',
    round: 1,
    participants: [
      makeCombatParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
      makeCombatParticipant({ characterId: 'enemy1', name: '哥布林', side: 'enemy', tier: 1, hp: 2000, maxHp: 2000 }),
    ],
    turnOrder: [],
    currentTurnIndex: 0,
    status: 'active',
    environment: '平原',
    patches: [],
    roundLogs: [],
    ...o,
  };
}

function makeCombatToolCtx(
  characters: CharacterState[],
  combat: CombatState,
  bus: EventBus,
): CombatToolContext {
  return {
    characters,
    variables: {},
    saveId: 'save_combat_test',
    bus,
    combatants: ['ally1', 'enemy1'],
    combat,
  };
}

describe('executeCombatToolCall — combat 工具独立通道', () => {
  it('combat_start: initCombat 返回合法 CombatState（角色名→CombatParticipant 转换）', async () => {
    const ally = makeCharacter({ id: 'ally1', name: '勇者', tier: 3, level: 10 });
    const enemy = makeCharacter({ id: 'enemy1', name: '哥布林', tier: 1, level: 5 });
    const bus = new EventBus({ maxHistory: 50 });
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([ally, enemy], combat, bus);

    const r = await executeCombatToolCall(
      'combat_start',
      {
        combatType: '标准',
        allies: ['勇者'],
        enemies: ['哥布林'],
        environment: '森林空地',
        d20Rolls: [15, 8],
      },
      ctx,
    );

    expect(r.error).toBeUndefined();
    const cs = r.result;
    expect(cs.combatType).toBe('标准');
    expect(cs.round).toBe(1);
    expect(cs.environment).toBe('森林空地');
    expect(cs.status).toBe('active');
    expect(cs.turnOrder.length).toBe(2);
    // 先攻排序：勇者 d20=15 应排在哥布林 d20=8 之前
    expect(cs.turnOrder[0].characterId).toBe('ally1');
    expect(cs.participants.map((p: CombatParticipant) => p.name).sort()).toEqual(['勇者', '哥布林']);
    // _combatState 是原始 CombatState，调用方据此更新 ctx.combat
    expect(cs._combatState).toBeDefined();
    expect(cs._combatState.combatId).toBe(cs.combatId);
  });

  it('combat_start: 角色名不存在时返回 error（按名寻址铁律1）', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall(
      'combat_start',
      { combatType: '标准', allies: ['不存在的角色'], enemies: ['哥布林'], environment: 'x', d20Rolls: [10] },
      ctx,
    );

    expect(r.error).toContain('不存在的角色');
  });

  it('combat_attack: resolveAttackPipeline 走通，返回 CombatActionResult 含 damage/patches', async () => {
    const bus = new EventBus({ maxHistory: 50 });
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall(
      'combat_attack',
      {
        attackerId: '勇者',      // 按名寻址
        defenderId: '哥布林',    // 按名寻址
        d20Attack: 20,           // 暴击命中
        skillName: '斩击',
        skillPower: 30,
        weaponName: '长剑',
        damageType: '物理',
      },
      ctx,
    );

    expect(r.error).toBeUndefined();
    const ar = r.result;
    // CombatActionResult 形状
    expect(ar.damage.finalDamage).toBeGreaterThan(0);
    expect(ar.finalHp).toBeLessThan(2000);     // 守方 HP 下降
    expect(ar.isDead).toBe(false);
    expect(Array.isArray(ar.patches)).toBe(true);
    expect(ar.patches.some((p: any) => p.op === 'delta_hp')).toBe(true);
    // patches 交给调用方落库（executeCombatToolCall 不落库）
  });

  it('combat_block: resolveBlock 返回 add_status_effect patch（防御姿态）', async () => {
    const bus = new EventBus({ maxHistory: 50 });
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall('combat_block', { characterId: '勇者' }, ctx);

    expect(r.error).toBeUndefined();
    expect(r.result.success).toBe(true);
    expect(r.result.patches.some((p: any) => p.op === 'add_status_effect')).toBe(true);
    const eff = r.result.patches.find((p: any) => p.op === 'add_status_effect').value;
    expect(eff.name).toBe('防御姿态');
  });

  it('combat_flee: resolveFlee 走通（同步纯函数包装）', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall(
      'combat_flee',
      { characterId: '勇者', d20Roll: 20 },  // 高骰值利于逃脱
      ctx,
    );

    expect(r.error).toBeUndefined();
    expect(r.result).toHaveProperty('success');
    expect(typeof r.result.success).toBe('boolean');
  });

  it('combat_end: runSettlementPipeline 返回 SettlementResult 含 exp', async () => {
    const bus = new EventBus({ maxHistory: 50 });
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall('combat_end', { winner: 'ally' }, ctx);

    expect(r.error).toBeUndefined();
    // ally 胜 → 败方=enemy（哥布林 Lv5 T1），exp > 0
    expect(r.result.exp).toBeGreaterThan(0);
    expect(Array.isArray(r.result.patches)).toBe(true);
  });

  it('get_combat_state: 只读快照含回合/类型/participants', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    const ctx = makeCombatToolCtx([], combat, bus);

    const r = await executeCombatToolCall('get_combat_state', {}, ctx);

    expect(r.error).toBeUndefined();
    expect(r.result.summary).toContain('回合1');
    expect(r.result.combatType).toBe('标准');
    expect(r.result.participants.length).toBe(2);
  });
});

describe('executeCombatToolCall — status 类工具', () => {
  it('status_apply: applyStatusIntents 异源新增 buff → patches 含 add_status_effect', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    const char = makeCharacter({
      id: 'ally1',
      name: '勇者',
      statusEffects: [],
    });
    const ctx = makeCombatToolCtx([char], combat, bus);

    const r = await executeCombatToolCall(
      'status_apply',
      {
        target: '勇者',
        name: '流血',
        category: '减益',
        sourceKey: '毒刃',
        stacks: 2,
        duration: 3,
        effects: { defense: -0.1 },
      },
      ctx,
    );

    expect(r.error).toBeUndefined();
    expect(['added', 'refreshed', 'stacked']).toContain(r.result.action);
    expect(r.result.patches.some((p: any) => p.op === 'add_status_effect')).toBe(true);
  });

  it('status_apply: 同 sourceKey 同名 buff 去重 → action=refreshed（不新增重复）', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    // 角色已有一个 "毒刃.流血" buff
    const existing: StatusEffect = {
      name: '流血',
      description: '持续伤害',
      category: '减益',
      stacks: 1,
      remainingTime: 3,
      timeUnit: '回合',
      source: '减益-毒刃;自然解除',
      sourceKey: '毒刃',
      effects: { defense: -0.1 },
    };
    const char = makeCharacter({
      id: 'ally1',
      name: '勇者',
      statusEffects: [existing],
    });
    const ctx = makeCombatToolCtx([char], combat, bus);

    // 再施加同 sourceKey.同名 → 应刷新而非新增
    const r = await executeCombatToolCall(
      'status_apply',
      {
        target: '勇者',
        name: '流血',
        category: '减益',
        sourceKey: '毒刃',
        stacks: 2,
        duration: 3,
      },
      ctx,
    );

    expect(r.error).toBeUndefined();
    // 同 (owner, buffId=毒刃.流血) → refreshed 或 stacked（都属去重，不是 added）
    expect(r.result.action).not.toBe('added');
    // updated 列表仍只有 1 个流血（去重生效）
    const liuXue = r.result.updated.filter((e: StatusEffect) => e.name === '流血');
    expect(liuXue.length).toBe(1);
  });

  it('status_remove: removeStatusIntents 移除 buff → patches 含 remove_status_effect', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();
    const existing: StatusEffect = {
      name: '中毒',
      description: '每回合扣血',
      category: '减益',
      stacks: 1,
      remainingTime: 5,
      timeUnit: '回合',
      source: '减益-毒沼;自然解除',
      sourceKey: '毒沼',
      effects: {},
    };
    const char = makeCharacter({
      id: 'ally1',
      name: '勇者',
      statusEffects: [existing],
    });
    const ctx = makeCombatToolCtx([char], combat, bus);

    const r = await executeCombatToolCall(
      'status_remove',
      { target: '勇者', buffIdOrName: '毒沼.中毒' },
      ctx,
    );

    expect(r.error).toBeUndefined();
    expect(r.result.patches.some((p: any) => p.op === 'remove_status_effect')).toBe(true);
    expect(r.result.updated.length).toBe(0);  // 移除后为空
  });

  it('status_apply: target 角色不在战斗 participants → 报错（按名寻址失败）', async () => {
    const bus = new EventBus();
    const combat = makeCombatState();  // participants 只有 勇者/哥布林
    const char = makeCharacter({ id: 'bystander', name: '路人' });
    const ctx = makeCombatToolCtx([char], combat, bus);

    const r = await executeCombatToolCall(
      'status_apply',
      { target: '路人', name: '流血', category: '减益', sourceKey: '毒刃' },
      ctx,
    );

    // 路人 不在 combat.participants → findCharIdByName 抛错 → 包成 error
    expect(r.error).toContain('路人');
  });
});

describe('executeCombatToolCall — 占位工具在新通道不再 throw', () => {
  // 旧 executeToolCall 通道对 combat_* 仍 throw（引导到新通道）；
  // 新 executeCombatToolCall 通道对全部 12 个工具正常分发，不抛「PipelineContext」错。
  const combatTools = [
    'combat_start', 'combat_attack', 'combat_use_skill', 'combat_use_item',
    'combat_block', 'combat_move', 'combat_focus', 'combat_flee', 'combat_end',
    'get_combat_state',
    'status_apply', 'status_remove',
  ];

  const bus = new EventBus();
  const combat = makeCombatState();
  const ctx = makeCombatToolCtx([], combat, bus);

  for (const name of combatTools) {
    it(`「${name}」在新通道不抛 PipelineContext 错（返回 error 或正常结果）`, async () => {
      const r = await executeCombatToolCall(name, {} as any, ctx);
      // 不抛错即通过：要么有正常 result，要么有 error（但绝不是 PipelineContext 占位）
      expect(r).toHaveProperty('functionName', name);
      expect(r.error ?? r.result).toBeDefined();
      // 若有 error，不应含旧占位文案
      if (r.error) {
        expect(r.error).not.toContain('PipelineContext');
        expect(r.error).not.toContain('需 M4 orchestrator 接入');
      }
    });
  }
});
