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

function makeCtx(characters: CharacterState[] = []): ToolExecutionContext {
  return {
    characters,
    variables: {},
    saveId: 'save_test',
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
