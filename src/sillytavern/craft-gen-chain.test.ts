/**
 * craft-gen-chain.test.ts — 制作生成链测试 (M2 终审补测)
 *
 * 测试:
 * - buildCraftPatches: 纯函数（产物 add_item / item_gen 同名去重 / 装备 equip_item / 散件 add_item / 奖励）
 *
 * 注: 本模块整体在 M3 重写，此处只锁桥接形态的关键行为 —
 * 尤其是"产物与 item_gen equipment 同名时不得重复 add_item"（否则 M2 同名合并
 * 把 quantity 累到 ≥2，随后 equip_item 触发堆叠拒穿 throw）。
 */

import { describe, it, expect } from 'vitest';
import { buildCraftPatches } from './craft-gen-chain';
import type { CraftGenOutput } from './craft-gen-chain';
import type { ItemGenOutput } from './types';

// ========== Factory Helpers ==========

function makeCraftOutput(overrides: Partial<CraftGenOutput> = {}): CraftGenOutput {
  return {
    success: true,
    productName: '精钢长剑',
    quality: '稀有',
    rating: '成功',
    checkSummary: '锻造检定 d20=15 + 技艺 5 vs DC 18 → 成功',
    itemRequests: [],
    narrative: '炉火中，一柄泛着幽蓝光泽的长剑逐渐成形。',
    craftParams: {
      industry: '锻造',
      targetQuality: '稀有',
      stage: '成品',
      quantity: 1,
      materials: '精铁锭x3, 秘银粉x1',
      expGained: 50,
      fpGained: 2,
    },
    ...overrides,
  } as CraftGenOutput;
}

/** 从 patches 中筛出指定 op */
function ops(patches: ReturnType<typeof buildCraftPatches>, op: string) {
  return patches.filter((p) => p.op === op);
}

// ========== buildCraftPatches (纯函数) ==========

describe('buildCraftPatches', () => {
  it('① 无 item_gen 输出 → 产物 1 条 add_item + 经验/FP 奖励', () => {
    const patches = buildCraftPatches(makeCraftOutput(), null, '理查德');

    const addItems = ops(patches, 'add_item');
    expect(addItems).toHaveLength(1);
    expect(addItems[0].target).toBe('characters.理查德');
    expect((addItems[0].value as any).name).toBe('精钢长剑');
    expect((addItems[0].value as any).quantity).toBe(1);
    expect((addItems[0].value as any).rarity).toBe('稀有');

    // 无装备细化 → 不发 equip_item
    expect(ops(patches, 'equip_item')).toHaveLength(0);

    // 奖励: 经验走 update_character delta（M3），FP 走 delta_variable
    const deltas = ops(patches, 'delta_variable');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].target).toBe('profile.fp');
    expect(deltas[0].amount).toBe(2);

    const charUpdates = ops(patches, 'update_character');
    expect(charUpdates).toHaveLength(1);
    expect(charUpdates[0].target).toBe('characters.理查德');
    expect(charUpdates[0].value).toEqual({ totalExp: 50 });
    expect(charUpdates[0].metadata).toEqual({ source: 'craft_gen', delta: true });
  });

  it('② item_gen equipment 与产物同名 → 不重复 add_item（同名恰好 1 条），单 add_item 带 equippedSlot（M3）', () => {
    const itemOutput: ItemGenOutput = {
      skills: [],
      equipment: [
        {
          slot: '武器',
          name: '精钢长剑', // 与产物同名 — item_gen 细化了产物本身
          description: '剑身流转着秘银纹路',
          stats: { 攻击: 45 },
          durability: 120,
          quality: '稀有',
        },
      ],
      inventory: [],
    };

    const patches = buildCraftPatches(makeCraftOutput(), itemOutput, '理查德');

    // 同名产物只入库 1 次（equipment 条目字段更全，以它为准）
    const addItems = ops(patches, 'add_item');
    const sameNameAdds = addItems.filter((p) => (p.value as any).name === '精钢长剑');
    expect(sameNameAdds).toHaveLength(1);
    expect((sameNameAdds[0].value as any).description).toBe('剑身流转着秘银纹路');

    // M3: 装备单 add_item 带 equippedSlot，不再两步（无单独 equip_item）
    expect(ops(patches, 'equip_item')).toHaveLength(0);
    expect(sameNameAdds[0].value).toHaveProperty('equippedSlot', '武器');
  });

  it('③ item_gen 产出异名装备/散件 → 产物 + 装备 + 散件各自 add_item', () => {
    const itemOutput: ItemGenOutput = {
      skills: [],
      equipment: [
        {
          slot: '饰品',
          name: '锻造师的护符', // 与产物异名 — 附带产出
          description: '锻造中意外凝成的小护符',
          stats: { 体质: 1 },
          quality: '优良',
        },
      ],
      inventory: [
        { name: '秘银碎屑', description: '锻造残料', quantity: 3, type: '材料', rarity: '稀有' },
      ],
    };

    const patches = buildCraftPatches(makeCraftOutput(), itemOutput, '理查德');

    const addItems = ops(patches, 'add_item');
    const names = addItems.map((p) => (p.value as any).name);
    expect(names).toContain('精钢长剑'); // 产物自身
    expect(names).toContain('锻造师的护符'); // 异名装备
    expect(names).toContain('秘银碎屑'); // 散件
    expect(addItems).toHaveLength(3);

    const scrap = addItems.find((p) => (p.value as any).name === '秘银碎屑');
    expect((scrap!.value as any).quantity).toBe(3);
  });

  it('④ item_gen 装备带 automata（S3 DSL 自由效果）→ add_item 透传 automata', () => {
    const itemOutput: ItemGenOutput = {
      skills: [],
      equipment: [
        {
          slot: '武器',
          name: '嗜血之刃',
          description: '剑身残留嗜血意志',
          stats: { 攻击力: 60 },
          quality: '传说',
          automata: [
            {
              id: '嗜血之刃.噬血',
              name: '噬血',
              source: '嗜血之刃',
              owner: '<unitId>',
              subscribe: 'damage.after',
              trigger: 'ctx.damage.final > 0',
              priority: 0,
              divinity: 0,
              intents: [{ kind: 'Heal', targetId: '<owner>', amount: 'ctx.damage.final * 0.1' }],
            },
          ],
        },
      ],
      inventory: [],
    };

    const patches = buildCraftPatches(makeCraftOutput(), itemOutput, '理查德');
    const addItem = ops(patches, 'add_item').find((p) => (p.value as any).name === '嗜血之刃');
    expect(addItem).toBeTruthy();
    expect((addItem!.value as any).automata).toHaveLength(1);
    expect((addItem!.value as any).automata[0]).toMatchObject({ subscribe: 'damage.after' });
  });

  it('制作失败 (success=false) → 空 patches，不产出任何物品', () => {
    const patches = buildCraftPatches(
      makeCraftOutput({ success: false, rating: '失败' }),
      null,
      '理查德',
    );
    expect(patches).toHaveLength(0);
  });

  it('expGained/fpGained 为 0 时不发奖励 patch', () => {
    const output = makeCraftOutput();
    output.craftParams.expGained = 0;
    output.craftParams.fpGained = 0;
    const patches = buildCraftPatches(output, null, '理查德');
    expect(ops(patches, 'delta_variable')).toHaveLength(0);
  });
});
