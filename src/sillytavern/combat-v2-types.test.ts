/**
 * combat-v2-types.test.ts — v2 残存契约容器测试
 *
 * 覆盖 characterToCombatParticipant（原出自 combat-resolver，v3/agent-tools 仍引）：
 *   - 装备 modifiers 收集（战斗 v3 修复）
 *   - 装备 + 被动技能 automata 收集（战斗 v3 S3）
 *   - 主动技能 automata 不进被动效果
 */

import { describe, it, expect } from 'vitest';
import { characterToCombatParticipant } from './combat-v2-types';
import { createDefaultCharacterState } from './types';

function makeChar(overrides: Partial<ReturnType<typeof createDefaultCharacterState>> = {}) {
  return createDefaultCharacterState({
    id: 'char_1',
    name: '理查德',
    inventory: [],
    skills: [],
    ...overrides,
  });
}

describe('characterToCombatParticipant', () => {
  it('收集已装备物品的 modifiers → participant.modifiers', () => {
    const char = makeChar({
      inventory: [
        {
          name: '幽怨之剑',
          quantity: 1,
          equippedSlot: '武器',
          modifiers: [{ category: '检定', source: '幽怨之剑', checkType: '命中', bonus: 5 }],
        },
        {
          name: '躺背包物品',
          quantity: 1,
          modifiers: [{ category: '固伤', source: 'X', amount: 99 }],
        },
      ],
    });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.modifiers).toHaveLength(1);
    expect(p.modifiers![0]).toMatchObject({ category: '检定', bonus: 5 });
  });

  it('🆕 收集已装备物品的 automata → participant.automata（S3）', () => {
    const char = makeChar({
      inventory: [
        {
          name: '嗜血之刃',
          quantity: 1,
          equippedSlot: '武器',
          automata: [
            {
              id: '嗜血之刃.噬血',
              name: '噬血',
              source: '嗜血之刃',
              owner: 'char_1',
              subscribe: 'damage.after',
              trigger: 'ctx.damage.final > 0',
              priority: 0,
              divinity: 0,
              intents: [{ kind: 'Heal', targetId: 'char_1', amount: 'ctx.damage.final * 0.1' }],
            },
          ],
        },
      ],
    });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.automata).toHaveLength(1);
    expect(p.automata![0]).toMatchObject({ subscribe: 'damage.after' });
  });

  it('🆕 被动技能 automata 收入 participant.automata；主动技能不收（S3）', () => {
    const char = makeChar({
      inventory: [],
      skills: [
        {
          name: '猎杀本能',
          description: '',
          type: 'passive',
          automata: [
            {
              id: '猎杀本能.残血',
              name: '残血追击',
              source: '猎杀本能',
              owner: 'char_1',
              subscribe: 'check.hit',
              trigger: 'ctx.target.hpPercent < 0.5',
              priority: 0,
              divinity: 0,
              intents: [
                {
                  kind: 'AddModifier',
                  slot: 'hitBonus',
                  value: 3,
                  scope: 'whole_action',
                  targetId: 'char_1',
                  divinity: 0,
                },
              ],
            },
          ],
        },
        {
          name: '烈焰斩',
          description: '',
          type: 'active',
          automata: [
            {
              id: '烈焰斩.爆',
              name: '爆',
              source: '烈焰斩',
              owner: 'char_1',
              subscribe: 'damage.after',
              trigger: 'true',
              priority: 0,
              divinity: 0,
              intents: [{ kind: 'Heal', targetId: 'char_1', amount: 1 }],
            },
          ],
        },
      ],
    });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.automata).toHaveLength(1);
    expect(p.automata![0]).toMatchObject({ subscribe: 'check.hit' });
  });

  it('🆕 无修饰无 automata → 字段 undefined（回归）', () => {
    const char = makeChar({ inventory: [], skills: [] });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.modifiers).toBeUndefined();
    expect(p.automata).toBeUndefined();
    expect(p.activeSkills).toBeUndefined(); // 🆕 skillPower 链路修复
  });

  it('🆕 skillPower 链路修复 (2026-08-04): 主动技能摘进 activeSkills（skillPower/relevantAttribute/damageType）', () => {
    const char = makeChar({
      inventory: [],
      skills: [
        {
          name: '火球术',
          description: '',
          type: 'active',
          skillPower: 450,
          relevantAttribute: 'int',
          damageType: '能量',
        },
        { name: '高等材料学', description: '', type: 'passive' },
      ],
    });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.activeSkills).toHaveLength(1);
    expect(p.activeSkills![0]).toMatchObject({
      name: '火球术',
      skillPower: 450,
      relevantAttribute: 'int',
      damageType: '能量',
    });
  });

  it('🆕 skillPower 链路修复: 被动技能不进 activeSkills；主动无 skillPower 被过滤（旧存档兼容，兜底 0 不退化）', () => {
    const char = makeChar({
      inventory: [],
      skills: [
        { name: '猎杀本能', description: '', type: 'passive' },
        { name: '旧主动技能', description: '', type: 'active' },
        {
          name: '火球术',
          description: '',
          type: 'active',
          skillPower: 450,
          relevantAttribute: 'int',
          damageType: '能量',
        },
      ],
    });
    const p = characterToCombatParticipant(char, 'ally');
    expect(p.activeSkills).toHaveLength(1);
    expect(p.activeSkills![0].name).toBe('火球术');
  });
});
