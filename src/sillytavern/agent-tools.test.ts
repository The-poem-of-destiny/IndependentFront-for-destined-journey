/**
 * agent-tools.test.ts — Agent 工具注册表测试
 *
 * M5-PR2 后 v2 combat 工具（combat_start / combat_attack / ... / status_query）及其
 * executeCombatToolCall 独立通道已随 v2 战斗运行时退役删除。本文件只测试**存活**的共享工具基础设施：
 *
 * 覆盖范围:
 *  1. status_query 接真函数（按名寻址 / 缺省返回全部 / 指定 buff 聚合层数）——executeToolCall 内仍保留
 *  2. 复用工具 (roll_d20 / get_hp_percent 等) 仍可正常工作（回归保护）
 *  3. random_name 工具描述的品牌面（D26）——注册表未就绪时必须是**不含作品名**的中性文案
 */

import { describe, it, expect, afterEach } from 'vitest';
import { executeToolCall, getToolDefinition, getToolsForAgent } from './agent-tools';
import { getContentRegistry, setContentRegistry } from '@ui/stores/content-store';
import { craftRequestFingerprint } from './craft-request';
import type { ToolExecutionContext, CharacterState } from './types';
import { deleteCharacter, getCharacters, saveCharacter } from './database';

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
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    location: '奥古斯提姆帝国·王都',
    inventory: [],
    statusEffects: [],
    ...partial,
  } as CharacterState;
}

function makeCtx(characters: CharacterState[] = [], saveId = 'save_test'): ToolExecutionContext {
  return {
    characters,
    variables: {},
    saveId,
  };
}

/**
 * 取 get_inventory 结果里的物品名。
 * Q-14 把 `executeToolCall` 从 `Promise<any>` 收成 `Promise<ToolResult>` 后，
 * 结果字段是 `unknown` —— 断言前必须先声明期望的形状，这正是收类型的目的。
 */
function itemNames(result: Record<string, unknown>): string[] {
  return (result.items as Array<{ name: string }>).map((item) => item.name);
}

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
        {
          name: '流血',
          description: 'd',
          category: '减益',
          stacks: 2,
          remainingTime: 3,
          timeUnit: '回合',
          source: 's',
          effects: {},
          sourceKey: '剑',
        } as any,
        {
          name: '专注',
          description: 'd',
          category: '增益',
          stacks: 1,
          remainingTime: null,
          timeUnit: '回合',
          source: 's',
          effects: {},
        } as any,
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
        {
          name: '流血',
          description: 'd',
          category: '减益',
          stacks: 2,
          remainingTime: 3,
          timeUnit: '回合',
          source: 's',
          effects: {},
          sourceKey: '剑A',
        } as any,
        {
          name: '流血',
          description: 'd',
          category: '减益',
          stacks: 3,
          remainingTime: 3,
          timeUnit: '回合',
          source: 's',
          effects: {},
          sourceKey: '剑B',
        } as any,
        {
          name: '中毒',
          description: 'd',
          category: '减益',
          stacks: 1,
          remainingTime: 3,
          timeUnit: '回合',
          source: 's',
          effects: {},
        } as any,
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
        {
          name: '灼烧',
          description: 'd',
          category: '减益',
          stacks: 1,
          remainingTime: 3,
          timeUnit: '回合',
          source: 's',
          effects: {},
          sourceKey: '火杖',
        } as any,
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall(
      'status_query',
      { target: '法师', buffIdOrName: '火杖.灼烧' },
      ctx,
    );
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

  it('get_character 优先按角色名寻址', async () => {
    const byName = makeCharacter({ id: 'uuid_by_name', name: '同一个键' });
    const byLegacyId = makeCharacter({ id: '同一个键', name: 'ID 碰撞角色' });
    const r = await executeToolCall(
      'get_character',
      { characterId: '同一个键' },
      makeCtx([byName, byLegacyId]),
    );

    expect(r.found).toBe(true);
    expect(r.id).toBe('uuid_by_name');
    expect(r.name).toBe('同一个键');
  });

  it('get_hp_percent 按角色名寻址', async () => {
    const char = makeCharacter({ id: 'uuid_hp', name: '测试员', hp: 30, maxHp: 100 });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('get_hp_percent', { characterId: '测试员' }, ctx);
    expect(r.hpPercent).toBe(30);
  });

  it('get_hp_percent 兼容旧 UUID 寻址', async () => {
    const char = makeCharacter({ id: 'char_1', name: '测试员', hp: 30, maxHp: 100 });
    const ctx = makeCtx([char]);
    const r = await executeToolCall('get_hp_percent', { characterId: 'char_1' }, ctx);
    expect(r.hpPercent).toBe(30);
  });

  it('get_inventory 接受中文材料类型并按角色名寻址', async () => {
    const char = makeCharacter({
      id: 'uuid_inventory',
      name: '采集者',
      inventory: [
        { name: '铁矿石', quantity: 3, type: '材料', rarity: '普通' },
        { name: '治疗药水', quantity: 1, type: '消耗品', rarity: '普通' },
      ],
    });

    const r = await executeToolCall(
      'get_inventory',
      { characterId: '采集者', type: '材料' },
      makeCtx([char]),
    );

    expect(itemNames(r)).toEqual(['铁矿石']);
  });

  it('get_inventory 兼容英文材料别名和旧 UUID 寻址', async () => {
    const char = makeCharacter({
      id: 'uuid_inventory_legacy',
      name: '旧版采集者',
      inventory: [
        { name: '银矿石', quantity: 2, type: '材料', rarity: '普通' },
        { name: '任务信物', quantity: 1, type: '任务物品', rarity: '普通' },
      ],
    });

    const r = await executeToolCall(
      'get_inventory',
      { characterId: 'uuid_inventory_legacy', type: 'material' },
      makeCtx([char]),
    );

    expect(itemNames(r)).toEqual(['银矿石']);
  });

  it('get_inventory 对未知类型显式报错', async () => {
    const char = makeCharacter({ name: '采集者' });

    await expect(
      executeToolCall(
        'get_inventory',
        { characterId: '采集者', type: 'not-a-real-type' },
        makeCtx([char]),
      ),
    ).rejects.toThrow('未知物品类型');
  });

  it('未知工具仍抛错（且报错可行动：提示白名单外 + 正确的替代做法）', async () => {
    await expect(executeToolCall('call_item_gen', {}, makeCtx())).rejects.toThrow(
      '未注册或不在本 Agent 白名单',
    );
    await expect(executeToolCall('call_item_gen', {}, makeCtx())).rejects.toThrow('skill_requests');
  });

  // 🆕 S2b（2026-08-01 制造反向链路）：craft_check 收集装备「生产检定」modifier → toolBonus
  it('craft_check 装备生产检定 modifier → toolBonus 计入固定加值', async () => {
    const char = makeCharacter({
      name: '匠人',
      tier: 3,
      attributes: { str: 12, dex: 10, con: 10, int: 10, spi: 10 },
      inventory: [
        {
          name: '锻火铁锤',
          description: '',
          quantity: 1,
          equippedSlot: '武器',
          modifiers: [
            { category: '检定', source: '锻火铁锤', checkType: '生产', bonus: 5 },
            { category: '检定', source: '锻火铁锤', checkType: '命中', bonus: 9 }, // 命中不走制造
          ],
        },
        // 躺背包的生产检定 modifier 不应计入（只有已装备）
        {
          name: '闲置模具',
          description: '',
          quantity: 1,
          modifiers: [{ category: '检定', source: '闲置模具', checkType: '生产', bonus: 99 }],
        },
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall(
      'craft_check',
      { characterId: 'char_1', industry: '锻造', productName: '铁剑', materials: [] },
      ctx,
    );
    // coreAttr(12) + toolBonus(5, 生产检定) + d20 = 17 + d20；命中+9 不进制造
    expect(r.fixedBonus).toBe(17);
    // 只进加值、不减免 DC（S2c）：普通品质产能减免 1 → finalDC 5（未被 toolBonus 再减）
    expect(r.finalDC).toBe(5);
  });

  // 🆕 S4a（2026-08-01）：技能「生产检定」modifier → skillBonus 计入固定加值（收 S2-2）
  it('craft_check 技能生产检定 modifier → skillBonus 计入固定加值', async () => {
    const char = makeCharacter({
      name: '匠人学徒',
      tier: 3,
      attributes: { str: 12, dex: 10, con: 10, int: 10, spi: 10 },
      inventory: [],
      skills: [
        {
          name: '锻造辅助',
          description: '深谙火候与锻打手法。',
          type: 'passive',
          modifiers: [
            { category: '检定', source: '锻造辅助', checkType: '生产', bonus: 3 },
            { category: '检定', source: '锻造辅助', checkType: '命中', bonus: 9 }, // 命中不走制造
          ],
        },
        {
          name: '战斗本能',
          description: '',
          type: 'passive',
          modifiers: [{ category: '检定', source: '战斗本能', checkType: '命中', bonus: 99 }],
        },
      ],
    });
    const ctx = makeCtx([char]);
    const r = await executeToolCall(
      'craft_check',
      { characterId: 'char_1', industry: '锻造', productName: '铁剑', materials: [] },
      ctx,
    );
    // coreAttr(12) + skillBonus(3, 生产检定) + d20 = 15 + d20；命中不加
    expect(r.fixedBonus).toBe(15);
  });

  it('craft_settle 将按名解析的制作者写成 StatePatch 角色名并真实扣除材料', async () => {
    const saveId = 'save_agent_tools_craft_name';
    const crafter = makeCharacter({
      id: 'uuid_craft_name',
      saveId,
      name: '落库匠人',
      tier: 1,
      level: 1,
      totalExp: 0,
      attributes: { str: 20, dex: 10, con: 10, int: 10, spi: 10 },
      inventory: [
        {
          name: '铁矿石',
          description: '普通锻造材料',
          quantity: 2,
          type: '材料',
          rarity: '普通',
        },
      ],
    });

    await deleteCharacter(crafter.id);
    await saveCharacter(crafter);

    try {
      const args = {
        characterId: '落库匠人',
        industry: '锻造',
        stage: '基础加工',
        productName: '铁锭',
        targetQuality: '普通',
        materials: [{ name: '铁矿石', quantity: 1, quality: '普通' }],
      };
      const ctx = makeCtx([crafter], saveId);
      // 🔴 Q-21 起制作检定用的是**真骰子**。本用例断言的是「落库路径」而不是骰运，
      //    所以必须把骰带钉死 —— 不钉的话 T1 齐平品质是 1 颗骰，d20=1 即大失败，
      //    这条用例会以 5% 的概率随机红。任何断言 success/评级的用例都得这么做。
      ctx.craftDice = {
        [craftRequestFingerprint('落库匠人', args)]: {
          d20Rolls: [15],
          d20MaterialSave: 10,
          d20QualityUpgrade: 10,
        },
      };
      const result = await executeToolCall('craft_settle', args, ctx);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBeGreaterThan(0);
      const [stored] = await getCharacters(saveId);
      expect(stored.inventory.find((item) => item.name === '铁矿石')?.quantity).toBe(1);
    } finally {
      await deleteCharacter(crafter.id);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Q-21：制作检定的骰子（此前生产恒 d20 = 10）
// ═══════════════════════════════════════════════════════════

describe('craft 骰带 — 真骰子 + check/settle 同源', () => {
  /** 与工具参数一一对应的检定参数（层级齐平 → 常规 1 颗骰） */
  const CHECK_ARGS = {
    // 按名寻址（铁律 ①）——工具参数名沿用历史的 characterId，值是角色名
    characterId: '铁砧',
    industry: '锻造',
    stage: '成品',
    productName: '铁剑',
    targetQuality: '优良',
    quantity: 1,
    // 优良需要**两种**同品质投入物（inheritQuality），少一种会整条降级并让检定空转
    materials: [
      { name: '铁锭', quantity: 1, quality: '优良' },
      { name: '钢材', quantity: 1, quality: '优良' },
    ],
  };

  /** 优良 对应 T1；制作者也 T1 → 齐平，恰好 1 颗骰（大失败判据成立的前提） */
  const smith = () =>
    makeCharacter({
      name: '铁砧',
      tier: 1,
      attributes: { str: 12, dex: 8, con: 8, int: 8, spi: 8 },
    });

  it('骰子是真的 —— 多次独立调用不再全是 10', async () => {
    const seen = new Set<unknown>();
    for (let i = 0; i < 20; i++) {
      // 每次全新 ctx（无缓存）→ 每次现掷
      const r = await executeToolCall('craft_check', CHECK_ARGS, makeCtx([smith()]));
      seen.add(r.diceValue);
    }
    // 修复前这里恒为 {10}
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.has(10) && seen.size === 1).toBe(false);
  });

  it('常规检定恰好 1 颗骰 —— 多掷一颗会让大失败永久不可达', async () => {
    const r = await executeToolCall('craft_check', CHECK_ARGS, makeCtx([smith()]));
    expect((r.diceRolls as number[]).length).toBe(1);
  });

  it('大失败可达（d20=1 且只掷了 1 颗）', async () => {
    const ctx = makeCtx([smith()]);
    // 预置骰带：指纹即键，AI 参与不了
    ctx.craftDice = {
      [craftRequestFingerprint('铁砧', CHECK_ARGS)]: {
        d20Rolls: [1],
        d20MaterialSave: 10,
        d20QualityUpgrade: 10,
      },
    };
    const r = await executeToolCall('craft_check', CHECK_ARGS, ctx);
    expect(r.diceValue).toBe(1);
    expect(r.rating).toBe('大失败');
  });

  it('优/劣势掷 2 颗并取高 —— 整条规则此前是死的', async () => {
    // T3 制作普通品质（对应 T1）→ 优势
    const r = await executeToolCall(
      'craft_check',
      { ...CHECK_ARGS, targetQuality: '普通' },
      makeCtx([makeCharacter({ name: '铁砧', tier: 3 })]),
    );
    const rolls = r.diceRolls as number[];
    expect(rolls.length).toBe(2);
    expect(r.diceValue).toBe(Math.max(rolls[0], rolls[1]));
  });

  it('同一次制作重复 check 是幂等的 —— 「再算一次」不等于偷偷重掷', async () => {
    const ctx = makeCtx([smith()]);
    const a = await executeToolCall('craft_check', CHECK_ARGS, ctx);
    const b = await executeToolCall('craft_check', CHECK_ARGS, ctx);
    expect(b.diceValue).toBe(a.diceValue);
    expect(b.rating).toBe(a.rating);
  });

  it('换了任一项就是另一次制作 → 另一条骰带', async () => {
    const ctx = makeCtx([smith()]);
    await executeToolCall('craft_check', CHECK_ARGS, ctx);
    await executeToolCall('craft_check', { ...CHECK_ARGS, quantity: 2 }, ctx);
    expect(Object.keys(ctx.craftDice ?? {})).toHaveLength(2);
  });

  it('craft_settle 取走 craft_check 的骰带 —— AI 看到的评级就是落库的结果', async () => {
    const saveId = 'save_craft_tape_share';
    const crafter = makeCharacter({
      id: 'uuid_craft_tape',
      saveId,
      name: '铁砧',
      tier: 1,
      level: 1,
      totalExp: 0,
      attributes: { str: 12, dex: 8, con: 8, int: 8, spi: 8 },
      inventory: [
        { name: '铁锭', description: '', quantity: 5, type: '材料', rarity: '优良' },
        { name: '钢材', description: '', quantity: 5, type: '材料', rarity: '优良' },
      ],
    });
    await deleteCharacter(crafter.id);
    await saveCharacter(crafter);

    try {
      const ctx = makeCtx([crafter], saveId);
      // 钉死一条注定失败的骰带（d20=1），check 与 settle 必须看到同一条
      ctx.craftDice = {
        [craftRequestFingerprint('铁砧', CHECK_ARGS)]: {
          d20Rolls: [1],
          d20MaterialSave: 10,
          d20QualityUpgrade: 10,
        },
      };

      const check = await executeToolCall('craft_check', CHECK_ARGS, ctx);
      expect(check.rating).toBe('大失败');

      const settle = await executeToolCall('craft_settle', CHECK_ARGS, ctx);
      // 修复前 settle 会另掷（其实是恒 10 → 成功），与 check 展示给 AI 的结论相反
      expect(settle.success).toBe(false);
      // 取走即消费：同一件东西再做一次会重新掷
      expect(Object.keys(ctx.craftDice ?? {})).toHaveLength(0);
    } finally {
      await deleteCharacter(crafter.id);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 失败一律 throw（Q-14）
// ═══════════════════════════════════════════════════════════

describe('executeToolCall — 失败形态只有一种', () => {
  it('get_script_reference 未知分类 throw，异常消息里带可用清单', async () => {
    await expect(
      executeToolCall('get_script_reference', { query: '不存在的分类' }, makeCtx()),
    ).rejects.toThrow(/未知分类.*可用/s);
  });

  it('get_script_reference 合法分类仍是正常结果', async () => {
    const r = await executeToolCall('get_script_reference', { query: 'all' }, makeCtx());
    expect(typeof r.reference).toBe('string');
  });

  it('craft_get_production_bonus 表外品质 throw（旧实现返回裸 null，模型无从判断）', async () => {
    await expect(
      executeToolCall('craft_get_production_bonus', { quality: '不存在的品质' }, makeCtx()),
    ).rejects.toThrow(/未知品质.*可用/s);
  });

  it('status_query 查无此角色**不算失败** —— 那是这个工具的正常回答', async () => {
    const r = await executeToolCall('status_query', { target: '查无此人' }, makeCtx());
    expect(r.found).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 品牌面注入（D26 / 波 2 T10）
// ═══════════════════════════════════════════════════════════

describe('random_name 工具描述的品牌面（D26）', () => {
  afterEach(() => {
    setContentRegistry({ ...getContentRegistry(), branding: undefined });
  });

  it('注册表未就绪 → 中性文案，不含任何作品名', () => {
    setContentRegistry({ ...getContentRegistry(), branding: undefined });
    const def = getToolDefinition('random_name');
    expect(def).toBeDefined();
    expect(def!.function.description).toBe(
      '随机生成一个符合当前世界观的角色名称。根据种族和性别从名称池中随机选取。',
    );
    expect(def!.function.description).not.toContain('《');
  });

  it('注册表有 branding.appTitle → 描述换成带作品名的版本', () => {
    setContentRegistry({ ...getContentRegistry(), branding: { appTitle: '某某作品' } });
    expect(getToolDefinition('random_name')!.function.description).toBe(
      '随机生成一个符合《某某作品》世界观的角色名称。根据种族和性别从名称池中随机选取。',
    );
  });

  it('getToolsForAgent 出口同样套上品牌面（两个读取口不许漂移）', () => {
    setContentRegistry({ ...getContentRegistry(), branding: { appTitle: '某某作品' } });
    const tools = getToolsForAgent('char_gen');
    const def = tools.find((t) => t.function.name === 'random_name');
    expect(def).toBeDefined();
    expect(def!.function.description).toContain('《某某作品》');
  });

  it('branding 形状不对（数组 / appTitle 非字符串 / 空串）一律回落中性文案', () => {
    for (const bad of [['x'], { appTitle: 42 }, { appTitle: '' }, 'nope']) {
      setContentRegistry({ ...getContentRegistry(), branding: bad });
      expect(getToolDefinition('random_name')!.function.description).toContain('符合当前世界观');
    }
  });

  it('非品牌工具的描述不被改写', () => {
    setContentRegistry({ ...getContentRegistry(), branding: { appTitle: '某某作品' } });
    const before = getToolDefinition('roll_d20')!.function.description;
    setContentRegistry({ ...getContentRegistry(), branding: undefined });
    expect(getToolDefinition('roll_d20')!.function.description).toBe(before);
  });
});
