/**
 * agent-tools.test.ts — Agent 工具注册表测试
 *
 * M5-PR2 后 v2 combat 工具（combat_start / combat_attack / ... / status_query）及其
 * executeCombatToolCall 独立通道已随 v2 战斗运行时退役删除。本文件只测试**存活**的共享工具基础设施：
 *
 * 覆盖范围:
 *  1. status_query 接真函数（按名寻址 / 缺省返回全部 / 指定 buff 聚合层数）——executeToolCall 内仍保留
 *  2. 复用工具 (roll_d20 / get_hp_percent 等) 仍可正常工作（回归保护）
 */

import { describe, it, expect } from 'vitest';
import { executeToolCall } from './agent-tools';
import type { ToolExecutionContext, CharacterState } from './types';
import { EventBus } from './game-event';
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

    expect(r.items.map((item: { name: string }) => item.name)).toEqual(['铁矿石']);
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

    expect(r.items.map((item: { name: string }) => item.name)).toEqual(['银矿石']);
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

  it('未知工具仍抛错', async () => {
    await expect(executeToolCall('不存在的工具', {}, makeCtx())).rejects.toThrow('未知工具');
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
      const result = await executeToolCall(
        'craft_settle',
        {
          characterId: '落库匠人',
          industry: '锻造',
          stage: '基础加工',
          productName: '铁锭',
          targetQuality: '普通',
          materials: [{ name: '铁矿石', quantity: 1, quality: '普通' }],
        },
        makeCtx([crafter], saveId),
      );

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBeGreaterThan(0);
      const [stored] = await getCharacters(saveId);
      expect(stored.inventory.find((item) => item.name === '铁矿石')?.quantity).toBe(1);
    } finally {
      await deleteCharacter(crafter.id);
    }
  });
});
