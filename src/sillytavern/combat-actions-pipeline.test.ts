/**
 * combat-actions-pipeline.test — 战术动作扩展测试 (M3 战斗 v2 · 任务 4.7)
 *
 * 覆盖 5 个动作（useSkill/useItem/block/move/focus）的:
 *  - ACTION_USE event 触发（用 subscribeChain 计数，emitChain 的正确观测点）
 *  - patches 结构正确（按名寻址、op、effects）
 *  - description 文本
 *
 * 注: emitChain 只走 chainHandlers 注册表，不触发 subscribeAll/globalHandlers
 *    （见 game-event.ts emitChain 实现第 250 行 `this.chainHandlers.get(type)`，
 *     与 publish 的 globalHandlers 互不干扰）。故 ACTION_USE 触发验证用 subscribeChain。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from './game-event';
import { COMBAT_EVENTS, type PipelineContext } from './combat-pipeline';
import {
  resolveUseSkill,
  resolveUseItem,
  resolveBlock,
  resolveMove,
  resolveFocus,
} from './combat-actions-pipeline';

function makeCtx(combatants: string[] = ['char_hero', 'char_goblin']): PipelineContext {
  return {
    bus: new EventBus(),
    combatants,
  };
}

describe('combat-actions-pipeline', () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  // ========== 1. resolveUseSkill ==========
  describe('resolveUseSkill', () => {
    it('emit ACTION_USE 并 success=true，patches 为空（M3 简化）', async () => {
      const seen: any[] = [];
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: (p) => {
          seen.push(p);
          return p;
        },
      });

      const result = await resolveUseSkill('char_hero', '烈焰斩', ctx);

      expect(result.success).toBe(true);
      expect(result.patches).toEqual([]);
      expect(result.description).toBe('char_hero 使用 烈焰斩');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        characterId: 'char_hero',
        action: 'skill',
        skillName: '烈焰斩',
      });
    });
  });

  // ========== 2. resolveUseItem ==========
  describe('resolveUseItem', () => {
    it('emit ACTION_USE + patches 含 remove_item（按名寻址 value.name=itemName）', async () => {
      const seen: any[] = [];
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: (p) => {
          seen.push(p);
          return p;
        },
      });

      const result = await resolveUseItem('char_hero', '治疗药水', ctx);

      expect(result.success).toBe(true);
      expect(result.description).toBe('char_hero 使用了 治疗药水');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        characterId: 'char_hero',
        action: 'item',
        itemName: '治疗药水',
      });

      // patches: remove_item 按名寻址
      expect(result.patches).toHaveLength(1);
      const patch = result.patches[0];
      expect(patch.op).toBe('remove_item');
      expect(patch.target).toBe('characters.char_hero');
      expect(patch.value).toMatchObject({ name: '治疗药水', quantity: 1 });
      expect(patch.metadata).toMatchObject({ source: 'combat-action' });
    });
  });

  // ========== 3. resolveBlock ==========
  describe('resolveBlock', () => {
    it('emit ACTION_USE + patches 含 add_status_effect「防御姿态」(category=增益/lifecycle=战斗/effects.defense=0.5)', async () => {
      const seen: any[] = [];
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: (p) => {
          seen.push(p);
          return p;
        },
      });

      const result = await resolveBlock('char_hero', ctx);

      expect(result.success).toBe(true);
      expect(result.description).toBe('char_hero 进入防御姿态');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        characterId: 'char_hero',
        action: 'block',
      });

      expect(result.patches).toHaveLength(1);
      const patch = result.patches[0];
      expect(patch.op).toBe('add_status_effect');
      expect(patch.target).toBe('characters.char_hero');

      const effect = patch.value;
      expect(effect.name).toBe('防御姿态');
      expect(effect.category).toBe('增益');
      expect(effect.lifecycle).toBe('战斗');
      expect(effect.effects.defense).toBe(0.5);
      expect(effect.effects.dodge).toBe(3);
      expect(effect.source).toBe('combat-block');
      expect(effect.sourceKey).toBe('战斗');
      expect(effect.remainingTime).toBe(1);
      expect(effect.timeUnit).toBe('回合');
    });
  });

  // ========== 4. resolveMove ==========
  describe('resolveMove', () => {
    it('emit ACTION_USE + patches=[]（§13 m 节点式 location 无位置变更）', async () => {
      const seen: any[] = [];
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: (p) => {
          seen.push(p);
          return p;
        },
      });

      const result = await resolveMove('char_hero', ctx);

      expect(result.success).toBe(true);
      expect(result.patches).toEqual([]);
      expect(result.description).toBe('char_hero 进行战术移动');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        characterId: 'char_hero',
        action: 'move',
      });
    });
  });

  // ========== 5. resolveFocus ==========
  describe('resolveFocus', () => {
    it('emit ACTION_USE + patches 含 add_status_effect「专注」(effects.hit=5)', async () => {
      const seen: any[] = [];
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: (p) => {
          seen.push(p);
          return p;
        },
      });

      const result = await resolveFocus('char_hero', ctx);

      expect(result.success).toBe(true);
      expect(result.description).toBe('char_hero 专注提升命中');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        characterId: 'char_hero',
        action: 'focus',
      });

      expect(result.patches).toHaveLength(1);
      const patch = result.patches[0];
      expect(patch.op).toBe('add_status_effect');
      expect(patch.target).toBe('characters.char_hero');

      const effect = patch.value;
      expect(effect.name).toBe('专注');
      expect(effect.category).toBe('增益');
      expect(effect.lifecycle).toBe('战斗');
      expect(effect.effects.hit).toBe(5);
      expect(effect.source).toBe('combat-focus');
      expect(effect.sourceKey).toBe('战斗');
      // 🐛修复(真机压测): rt=1 在回合 wrap 的增益 tick 就过期，专注常在"下次攻击"发生前
      // 已消失 → rt=2 保证跨一次回合边界，实际消耗由 runner 在攻击结算后执行（一次性）
      expect(effect.remainingTime).toBe(2);
    });
  });

  // ========== 6. ACTION_USE event 都触发（subscribeChain 计数验证） ==========
  describe('ACTION_USE event 触发计数', () => {
    it('5 个动作各调用一次，ACTION_USE 共触发 5 次', async () => {
      const counter = vi.fn((p: any) => p);
      ctx.bus.subscribeChain({
        type: COMBAT_EVENTS.ACTION_USE,
        handler: counter,
      });

      await resolveUseSkill('char_hero', '技能A', ctx);
      await resolveUseItem('char_hero', '道具B', ctx);
      await resolveBlock('char_hero', ctx);
      await resolveMove('char_hero', ctx);
      await resolveFocus('char_hero', ctx);

      expect(counter).toHaveBeenCalledTimes(5);

      // 验证每次 emit 的 action 字段正确
      const actions = counter.mock.calls.map((c) => (c[0] as any).action);
      expect(actions).toEqual(['skill', 'item', 'block', 'move', 'focus']);
    });

    it('emitChain 入历史，getLatest(ACTION_USE) 能查到最近一次', async () => {
      await resolveUseSkill('char_hero', '烈焰斩', ctx);
      await resolveFocus('char_hero', ctx);

      const latest = ctx.bus.getLatest(COMBAT_EVENTS.ACTION_USE as any);
      expect(latest).toBeDefined();
      expect((latest!.data as any).action).toBe('focus');
      expect((latest!.data as any).characterId).toBe('char_hero');
    });
  });

  // ========== 7. 5 个动作的 description 正确 ==========
  describe('description 文本', () => {
    it('useSkill description 含角色名和技能名', async () => {
      const r = await resolveUseSkill('char_mage', '火球术', ctx);
      expect(r.description).toBe('char_mage 使用 火球术');
    });

    it('useItem description 含角色名和道具名', async () => {
      const r = await resolveUseItem('char_mage', '法力药剂', ctx);
      expect(r.description).toBe('char_mage 使用了 法力药剂');
    });

    it('block description', async () => {
      const r = await resolveBlock('char_mage', ctx);
      expect(r.description).toBe('char_mage 进入防御姿态');
    });

    it('move description', async () => {
      const r = await resolveMove('char_mage', ctx);
      expect(r.description).toBe('char_mage 进行战术移动');
    });

    it('focus description', async () => {
      const r = await resolveFocus('char_mage', ctx);
      expect(r.description).toBe('char_mage 专注提升命中');
    });
  });
});
