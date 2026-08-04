/**
 * craft-request.test.ts — 制作请求装配（Q-21 刀三）
 *
 * 重点覆盖三件此前没有单点可测的事：
 *  1. 兜底默认值只有一份（craft_check / craft_settle 装出来的必须逐字段相同）
 *  2. 骰数由优/劣势决定 —— 常规必须**恰好 1 颗**，否则大失败判据永久失效
 *  3. 指纹的等价类：同一次制作稳定、任一项变了就是另一次
 */

import { describe, it, expect } from 'vitest';
import type { CharacterState, CraftDiceTape } from './types';
import {
  buildCraftRequest,
  collectCraftBonuses,
  craftCheckDiceCount,
  craftRequestFingerprint,
  getCraftCoreAttribute,
} from './craft-request';

function makeCharacter(partial: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'uuid_ignored',
    name: '铁砧',
    race: '智人种',
    type: 'npc',
    tier: 2,
    tierName: 'T2',
    level: 6,
    attributes: { str: 14, dex: 11, con: 12, int: 9, spi: 8 },
    hp: 90,
    maxHp: 100,
    mp: 20,
    maxMp: 50,
    sp: 30,
    maxSp: 60,
    location: '奥古斯提姆帝国·王都',
    inventory: [],
    statusEffects: [],
    ...partial,
  } as CharacterState;
}

const TAPE: CraftDiceTape = { d20Rolls: [7], d20MaterialSave: 13, d20QualityUpgrade: 19 };

// ========== craftCheckDiceCount ==========

describe('craftCheckDiceCount', () => {
  it('层级齐平 → 1 颗（大失败判据依赖 length === 1）', () => {
    // 优良 对应 T1；制作者 T1 → 齐平
    expect(craftCheckDiceCount(1, '优良')).toBe(1);
  });

  it('制作者层级更高 → 优势 2 颗', () => {
    expect(craftCheckDiceCount(3, '普通')).toBe(2);
  });

  it('制作者层级更低 → 劣势 2 颗', () => {
    expect(craftCheckDiceCount(2, '神话')).toBe(2);
  });
});

// ========== getCraftCoreAttribute ==========

describe('getCraftCoreAttribute', () => {
  const char = makeCharacter();

  it('四个行业各取各的属性', () => {
    expect(getCraftCoreAttribute(char, '锻造')).toBe(14); // str
    expect(getCraftCoreAttribute(char, '炼金')).toBe(9); // int
    expect(getCraftCoreAttribute(char, '烹饪')).toBe(8); // spi
    expect(getCraftCoreAttribute(char, '裁缝')).toBe(11); // dex
  });

  it('行业缺省/表外 → 取五维最大（沿用工具层原口径）', () => {
    expect(getCraftCoreAttribute(char)).toBe(14);
    expect(getCraftCoreAttribute(char, '不存在的行业')).toBe(14);
  });
});

// ========== collectCraftBonuses ==========

describe('collectCraftBonuses', () => {
  it('只收已装备物品与技能上的「生产」检定 modifier', () => {
    const char = makeCharacter({
      inventory: [
        {
          name: '锻火铁锤',
          description: '',
          quantity: 1,
          equippedSlot: '武器',
          modifiers: [
            { category: '检定', source: '锻火铁锤', checkType: '生产', bonus: 5 },
            { category: '检定', source: '锻火铁锤', checkType: '命中', bonus: 9 },
          ],
        },
        {
          name: '闲置模具',
          description: '',
          quantity: 1,
          modifiers: [{ category: '检定', source: '闲置模具', checkType: '生产', bonus: 99 }],
        },
      ],
      skills: [
        {
          name: '锻造辅助',
          description: '',
          type: 'passive',
          modifiers: [{ category: '检定', source: '锻造辅助', checkType: '生产', bonus: 3 }],
        },
      ],
    } as Partial<CharacterState>);

    expect(collectCraftBonuses(char)).toEqual({ toolBonus: 5, skillBonus: 3 });
  });

  it('无 modifier 时两项都是 0（不是 undefined）', () => {
    expect(collectCraftBonuses(makeCharacter())).toEqual({ toolBonus: 0, skillBonus: 0 });
  });
});

// ========== buildCraftRequest ==========

describe('buildCraftRequest', () => {
  it('characterId 写角色**名**而不是 uuid（铁律 ①）', () => {
    const req = buildCraftRequest(makeCharacter(), { industry: '锻造' }, TAPE);
    expect(req.characterId).toBe('铁砧');
  });

  it('六个兜底默认值只有这一份', () => {
    const req = buildCraftRequest(makeCharacter(), { materials: [{}] }, TAPE);
    expect(req.industry).toBe('锻造');
    expect(req.stage).toBe('成品');
    expect(req.productName).toBe('未命名制品');
    expect(req.targetQuality).toBe('普通');
    expect(req.quantity).toBe(1);
    expect(req.materials[0].itemName).toBe('未知材料');
    expect(req.materials[0].quantity).toBe(1);
    expect(req.materials[0].quality).toBe('普通');
  });

  it('materials 按下标发 itemId，dcModifier 留给 craft-quality 算', () => {
    const req = buildCraftRequest(
      makeCharacter(),
      { materials: [{ name: '铁锭', quantity: 3, quality: '优良' }, { name: '木炭' }] },
      TAPE,
    );
    expect(req.materials.map((m) => m.itemId)).toEqual(['mat_0', 'mat_1']);
    expect(req.materials.every((m) => m.dcModifier === 0)).toBe(true);
  });

  it('三条骰全部落进请求（此前 d20Rolls 恒为空数组）', () => {
    const req = buildCraftRequest(makeCharacter(), {}, TAPE);
    expect(req.d20Rolls).toEqual([7]);
    expect(req.d20MaterialSave).toBe(13);
    expect(req.d20QualityUpgrade).toBe(19);
  });

  it('骰带被复制，改请求不会回头污染缓存里的那条带', () => {
    const tape: CraftDiceTape = { d20Rolls: [7], d20MaterialSave: 1, d20QualityUpgrade: 1 };
    const req = buildCraftRequest(makeCharacter(), {}, tape);
    req.d20Rolls.push(20);
    expect(tape.d20Rolls).toEqual([7]);
  });

  it('hasRecipe 缺省按 false —— 不能按 stage 推（否则半成品凭空多出批量能力）', () => {
    expect(buildCraftRequest(makeCharacter(), { stage: '半成品' }, TAPE).hasRecipe).toBe(false);
    expect(buildCraftRequest(makeCharacter(), { hasRecipe: true }, TAPE).hasRecipe).toBe(true);
  });

  it('资源与层级来自角色当前状态', () => {
    const req = buildCraftRequest(makeCharacter(), { industry: '炼金' }, TAPE);
    expect(req.crafterTier).toBe(2);
    expect(req.crafterLevel).toBe(6);
    expect(req.currentResources).toEqual({ hp: 90, mp: 20, sp: 30 });
    expect(req.coreAttributeValue).toBe(9); // 炼金 → int
  });

  it('同参数装两次逐字段相同 —— craft_check 与 craft_settle 从此不可能分叉', () => {
    const args = {
      industry: '锻造',
      stage: '成品',
      productName: '铁剑',
      targetQuality: '优良',
      quantity: 2,
      materials: [{ name: '铁锭', quantity: 4, quality: '优良' }],
    };
    const char = makeCharacter();
    expect(buildCraftRequest(char, args, TAPE)).toEqual(buildCraftRequest(char, args, TAPE));
  });
});

// ========== craftRequestFingerprint ==========

describe('craftRequestFingerprint', () => {
  const args = {
    industry: '锻造',
    stage: '成品',
    productName: '铁剑',
    targetQuality: '优良',
    quantity: 1,
    materials: [{ name: '铁锭', quantity: 2, quality: '优良' }],
  };

  it('同一次制作 → 同一个键', () => {
    expect(craftRequestFingerprint('铁砧', args)).toBe(craftRequestFingerprint('铁砧', args));
  });

  it.each([
    ['角色', () => craftRequestFingerprint('别人', args)],
    ['品质', () => craftRequestFingerprint('铁砧', { ...args, targetQuality: '稀有' })],
    ['数量', () => craftRequestFingerprint('铁砧', { ...args, quantity: 2 })],
    ['产物', () => craftRequestFingerprint('铁砧', { ...args, productName: '钢剑' })],
    ['行业', () => craftRequestFingerprint('铁砧', { ...args, industry: '炼金' })],
    ['阶段', () => craftRequestFingerprint('铁砧', { ...args, stage: '半成品' })],
    [
      '材料数量',
      () =>
        craftRequestFingerprint('铁砧', {
          ...args,
          materials: [{ name: '铁锭', quantity: 3, quality: '优良' }],
        }),
    ],
  ])('%s 变了就是另一次制作（会重新掷骰）', (_label, mutate) => {
    expect(mutate()).not.toBe(craftRequestFingerprint('铁砧', args));
  });

  it('缺省参数也能算出稳定键（两个工具都允许只给必填项）', () => {
    expect(craftRequestFingerprint('铁砧', {})).toBe(craftRequestFingerprint('铁砧', {}));
  });
});
