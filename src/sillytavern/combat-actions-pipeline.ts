/**
 * combat-actions-pipeline — $combat 战术动作扩展 (M3 战斗 v2 · 任务 4.7)
 *
 * 职责: useSkill/useItem/block/move/focus（§13 决策 h，对齐 #837805 §4）。
 *      各自走 emitChain(combat.action.use) + 生成 StatePatch。
 *
 * 设计要点:
 *  - 每个动作先 emit ACTION_USE（AI/脚本可观测/改写参数），再返回 ActionResult。
 *  - 技能效果实际由技能定义驱动（M3 简化：本文件不解析技能效果，patches 留空）。
 *  - 道具消耗走 remove_item（按名寻址，铁律 1：AI 永不产 id）。
 *  - 格挡/专注走 add_status_effect patch（声明式优先，ADR-20）。
 *  - 移动: §13 m 节点式 location 无二维坐标，位置变更由 Story 叙事处理，本动作只 emit 事件。
 *
 * RFC: docs/planning/2026-07-28-combat-v2-m3-rfc.md §3 D7
 */

import type { StatePatch, StatusEffect } from './types';
import type { PipelineContext } from './combat-pipeline';
import { COMBAT_EVENTS } from './combat-pipeline';

export interface ActionResult {
  success: boolean;
  patches: StatePatch[];
  description: string;
}

/** 使用技能（走 emitChain combat.action.use + 技能效果） */
export async function resolveUseSkill(
  characterId: string,
  skillName: string,
  ctx: PipelineContext,
): Promise<ActionResult> {
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ACTION_USE,
    { characterId, action: 'skill', skillName },
    { combatants: ctx.combatants, source: characterId },
  );
  // M3 简化：技能效果实际由技能定义驱动，本动作只 emit 事件，patches 留空。
  return {
    success: true,
    patches: [],
    description: `${characterId} 使用 ${skillName}`,
  };
}

/** 使用道具 */
export async function resolveUseItem(
  characterId: string,
  itemName: string,
  ctx: PipelineContext,
): Promise<ActionResult> {
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ACTION_USE,
    { characterId, action: 'item', itemName },
    { combatants: ctx.combatants, source: characterId },
  );
  const patches: StatePatch[] = [
    {
      op: 'remove_item',
      target: `characters.${characterId}`,
      value: { name: itemName, quantity: 1 },
      metadata: { source: 'combat-action' },
    },
  ];
  return {
    success: true,
    patches,
    description: `${characterId} 使用了 ${itemName}`,
  };
}

/** 格挡（本回合防御+50%/闪避+3，走 M2 buff-registry 上「防御姿态」buff） */
export async function resolveBlock(
  characterId: string,
  ctx: PipelineContext,
): Promise<ActionResult> {
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ACTION_USE,
    { characterId, action: 'block' },
    { combatants: ctx.combatants, source: characterId },
  );
  const blockEffect: StatusEffect = {
    name: '防御姿态',
    description: '本回合防御+50%，闪避+3',
    category: '增益',
    stacks: 1,
    remainingTime: 1,
    timeUnit: '回合',
    source: 'combat-block',
    sourceKey: '战斗',
    effects: { defense: 0.5, dodge: 3 },
    lifecycle: '战斗',
  };
  const patches: StatePatch[] = [
    {
      op: 'add_status_effect',
      target: `characters.${characterId}`,
      value: blockEffect,
    },
  ];
  return {
    success: true,
    patches,
    description: `${characterId} 进入防御姿态`,
  };
}

/** 移动（先攻/逃跑检定修正标签，§13 m 逃跑无位置变更） */
export async function resolveMove(
  characterId: string,
  ctx: PipelineContext,
): Promise<ActionResult> {
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ACTION_USE,
    { characterId, action: 'move' },
    { combatants: ctx.combatants, source: characterId },
  );
  // §13 m: 节点式 location 无二维坐标，位置变更由 Story 叙事处理，本动作不产 patch。
  return {
    success: true,
    patches: [],
    description: `${characterId} 进行战术移动`,
  };
}

/** 专注（先攻/下次攻击命中修正） */
export async function resolveFocus(
  characterId: string,
  ctx: PipelineContext,
): Promise<ActionResult> {
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ACTION_USE,
    { characterId, action: 'focus' },
    { combatants: ctx.combatants, source: characterId },
  );
  const focusEffect: StatusEffect = {
    name: '专注',
    description: '下次攻击命中+5',
    category: '增益',
    stacks: 1,
    // 🐛修复(真机压测): rt=1 会在回合 wrap 的增益 tick 就过期 —— 专注常常在"下次攻击"
    // 发生前已消失（S10 实测全程未生效）。改 rt=2 保证跨一次回合边界存活，
    // 实际消耗由 combat-runner 在攻击结算后执行（一次性 buff，用掉即移除）。
    remainingTime: 2,
    timeUnit: '回合',
    source: 'combat-focus',
    sourceKey: '战斗',
    effects: { hit: 5 },
    lifecycle: '战斗',
  };
  const patches: StatePatch[] = [
    {
      op: 'add_status_effect',
      target: `characters.${characterId}`,
      value: focusEffect,
    },
  ];
  return {
    success: true,
    patches,
    description: `${characterId} 专注提升命中`,
  };
}
