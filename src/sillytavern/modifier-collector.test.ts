/**
 * ModifierCollector 测试 —— M2 战斗 v2 · 组 C
 *
 * 覆盖 RFC §7.2 + 本任务 7 项验收点：
 *  1. 注册 3 个装备声明 → collectAttackerMods 返回 3 个 modifier
 *  2. 在场过滤：owner 不在 combatants 时不被收集
 *  3. owner 缺省的声明（系统/环境 buff）不受在场过滤影响
 *  4. collectDefenderMods 走 DEFENDER_MODS（与 ATTACKER_MODS 互不串台）
 *  5. 无任何订阅时返回空数组
 *  6. handler push 不同类别 modifier（固伤/百分比/检定）都能正确收集
 *  7. 某个 handler 抛错不中断收集（emitChain 错误隔离）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from './game-event';
import {
  COMBAT_MOD_EVENTS,
  collectAttackerMods,
  collectDefenderMods,
  type CollectModsAttack,
} from './modifier-collector';
import type {
  FixedDamageModifier,
  PercentageModifier,
  CheckModifier,
  Modifier,
} from './effect-types';

// ---------- 测试夹具 ----------

const attack: CollectModsAttack = {
  attackerId: 'char_1',
  defenderId: 'char_2',
  skillId: '挥砍',
  weaponName: '钢剑',
  damageType: '物理',
};

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

// ---------- 测试用例 ----------

describe('modifier-collector', () => {
  it('1. 注册 3 个装备声明 → collectAttackerMods 返回 3 个 modifier', async () => {
    // 三个装备声明各自往 params.mods push 一个固伤 modifier
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '力量戒指',
          amount: 100,
          damageType: '物理',
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '锋利附魔',
          amount: 50,
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '战士天赋',
          amount: 30,
          damageType: '物理',
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    const mods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

    expect(mods).toHaveLength(3);
    expect(mods.map((m) => m.source).sort()).toEqual(['力量戒指', '战士天赋', '锋利附魔']);
    // 每个都应该是固伤 modifier
    expect(mods.every((m) => m.category === '固伤')).toBe(true);
  });

  it('2. 在场过滤：订阅 owner 不在 combatants 时不被收集', async () => {
    // owner='char_99'，但 combatants 只有 char_1/char_2
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      owner: 'char_99',
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '旁观者的护符',
          amount: 999,
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    // owner='char_1'（在场）应被收集
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      owner: 'char_1',
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '主角的力量',
          amount: 10,
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    const mods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

    expect(mods).toHaveLength(1);
    expect(mods[0].source).toBe('主角的力量');
  });

  it('3. owner 缺省的声明（系统/环境 buff）不受在场过滤影响', async () => {
    // combatants 只有 char_1（孤狼场景），但仍应有系统 buff 被 collect
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      // 不设 owner —— 永在场
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '战场环境：火山喷发',
          amount: 200,
          damageType: '真实',
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    // 同时在场 owner 的也应被收集
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      owner: 'char_1',
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '主角光环',
          amount: 5,
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    const mods = await collectAttackerMods(bus, attack, ['char_1']);

    // owner 缺省的系统 buff + 在场的 owner buff 都应被收集
    expect(mods).toHaveLength(2);
    expect(mods.map((m) => m.source).sort()).toEqual(['主角光环', '战场环境：火山喷发']);
  });

  it('4. collectDefenderMods 走 DEFENDER_MODS，与 ATTACKER_MODS 互不串台', async () => {
    // 在 ATTACKER_MODS 注册一个 handler
    let attackerTriggered = false;
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        attackerTriggered = true;
        params.mods.push({
          category: '固伤',
          source: '攻方:怒火',
          amount: 80,
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    // 在 DEFENDER_MODS 注册另一个 handler
    let defenderTriggered = false;
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.DEFENDER_MODS,
      handler: (params) => {
        defenderTriggered = true;
        params.mods.push({
          category: '百分比',
          source: '守方:荆棘护甲',
          coefficient: -0.3,
          target: 'damage',
        } satisfies PercentageModifier);
        return params;
      },
    });

    // 先只做攻方收集 → 验证 attacker handler 触发、defender handler 未触发（互不串台）
    const attackerMods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);
    expect(attackerTriggered).toBe(true);
    expect(defenderTriggered).toBe(false); // ← 关键：attacker collect 不应触发 defender handler
    expect(attackerMods).toHaveLength(1);
    expect(attackerMods[0].source).toBe('攻方:怒火');

    // 再做守方收集 → 验证 defender handler 触发，且只收 defender 声明的 modifier
    const defenderMods = await collectDefenderMods(bus, attack, ['char_1', 'char_2']);
    expect(defenderTriggered).toBe(true);
    expect(defenderMods).toHaveLength(1);
    expect(defenderMods[0].source).toBe('守方:荆棘护甲');
    expect(defenderMods[0].category).toBe('百分比');
  });

  it('5. 无任何订阅时返回空数组', async () => {
    // 不注册任何 handler
    const attackerMods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);
    const defenderMods = await collectDefenderMods(bus, attack, ['char_1', 'char_2']);

    expect(attackerMods).toEqual([]);
    expect(defenderMods).toEqual([]);
    expect(Array.isArray(attackerMods)).toBe(true);
    expect(Array.isArray(defenderMods)).toBe(true);
  });

  it('6. handler push 不同类别 modifier（固伤/百分比/检定）都能正确收集', async () => {
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '附魔:烈焰',
          amount: 60,
          damageType: '能量',
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '百分比',
          source: '蓄力:全力一击',
          coefficient: 0.5,
          target: 'damage',
        } satisfies PercentageModifier);
        return params;
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '检定',
          source: '鹰眼:精准',
          checkType: '命中',
          bonus: 4,
        } satisfies CheckModifier);
        return params;
      },
    });

    const mods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

    expect(mods).toHaveLength(3);
    // 校验每种类别都被正确收集 + 判别字段可读
    const categories = mods.map((m) => m.category).sort();
    expect(categories).toEqual(['固伤', '检定', '百分比']);

    const fixed = mods.find((m) => m.category === '固伤') as FixedDamageModifier;
    expect(fixed.amount).toBe(60);
    expect(fixed.damageType).toBe('能量');

    const pct = mods.find((m) => m.category === '百分比') as PercentageModifier;
    expect(pct.coefficient).toBe(0.5);
    expect(pct.target).toBe('damage');

    const chk = mods.find((m) => m.category === '检定') as CheckModifier;
    expect(chk.checkType).toBe('命中');
    expect(chk.bonus).toBe(4);
  });

  it('7. 某个 handler 抛错不中断收集（emitChain 错误隔离）', async () => {
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '装备A:正常声明',
          amount: 10,
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    // 中间这个 handler 会抛错
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: () => {
        throw new Error('装备B: 数据损坏，模拟异常');
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '装备C:正常声明',
          amount: 20,
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    // 抑制 emitChain 内部的 console.warn 噪音（错误隔离会 warn）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mods = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

      // 抛错的 handler 没贡献 modifier，但前后的正常 handler 仍被收集
      expect(mods).toHaveLength(2);
      expect(mods.map((m) => m.source).sort()).toEqual(['装备A:正常声明', '装备C:正常声明']);
      // emitChain 应该 warn 了错误
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------- 额外覆盖：注销订阅后不再被收集 ----------

  it('8. 注销订阅后该 handler 不再被收集', async () => {
    const unsub = bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '临时buff',
          amount: 1,
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    const beforeUnsub = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);
    expect(beforeUnsub).toHaveLength(1);

    unsub();

    const afterUnsub = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);
    expect(afterUnsub).toEqual([]);
  });

  // ---------- 额外覆盖：params.attack 透传给 handler ----------

  it('9. params.attack 上下文被正确透传给 handler（可读 attackerId/skillId 等）', async () => {
    let capturedAttack: CollectModsAttack | null = null;
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        capturedAttack = params.attack;
        return params;
      },
    });

    await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

    expect(capturedAttack).not.toBeNull();
    expect(capturedAttack!.attackerId).toBe('char_1');
    expect(capturedAttack!.defenderId).toBe('char_2');
    expect(capturedAttack!.skillId).toBe('挥砍');
    expect(capturedAttack!.weaponName).toBe('钢剑');
    expect(capturedAttack!.damageType).toBe('物理');
  });

  // ---------- 额外覆盖：combatants 空数组 ----------

  it('10. combatants 为空数组时，所有带 owner 的订阅都被过滤（仅 owner 缺省的保留）', async () => {
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      owner: 'char_1',
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '角色buff',
          amount: 1,
        } satisfies FixedDamageModifier);
        return params;
      },
    });
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      // owner 缺省 —— 永在场
      handler: (params) => {
        params.mods.push({
          category: '固伤',
          source: '全局规则buff',
          amount: 2,
        } satisfies FixedDamageModifier);
        return params;
      },
    });

    // 空数组：物理意义上"没有任何人在场"，所有 owner 订阅被跳过
    const mods = await collectAttackerMods(bus, attack, []);

    expect(mods).toHaveLength(1);
    expect(mods[0].source).toBe('全局规则buff');
  });

  // ---------- 额外覆盖：返回值类型校验 ----------

  it('11. 返回的 modifier 列表类型正确（满足 Modifier 联合）', async () => {
    bus.subscribeChain({
      type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
      handler: (params) => {
        params.mods.push({
          category: '检定',
          source: '敏捷加成',
          checkType: '属性',
          attribute: 'dex',
          bonus: 2,
        } satisfies CheckModifier);
        return params;
      },
    });

    const mods: Modifier[] = await collectAttackerMods(bus, attack, ['char_1', 'char_2']);

    expect(mods).toHaveLength(1);
    // Modifier 联合类型层面已编译期校验，运行时校验判别字段
    expect(mods[0].category).toBe('检定');
  });
});
