/**
 * combat-v3-projection.ts — v3 战斗单位字典 → 有序数组投影（设计 §3.1 决策 A2）
 *
 * 前端战斗组件读 `game.v3ActiveCombat`（CombatView 形状）：units 是
 * `Record<id, CombatUnitView>` 字典、initiativeOrder 是优先级数组 —— **没有**
 * participants 数组。UI 需要按阵营投影成有序数组（设计 §3.1 明确选 A2：
 * 原生吃 v3 形状，不写 v3→v2 适配层）。
 *
 * CombatUnitView 不在 combat-v3 公共出口（index.ts 只导 CombatView / CombatCommand
 * 等），这里用 `CombatView['units'][string]` 索引推导，避免为前端开引擎侧新出口。
 *
 * 纯函数叶子（照 scene-image-view.ts / cg-gallery.ts 的规矩）：零 store、零副作用，
 * 可独立单测。三个战斗组件（CombatPanel / CombatActionBar / CombatUnitCard）共用。
 */
import type { CombatView } from '@engine/combat-v3';

/** v3 单位投影类型（= CombatUnitView，经 CombatView.units 索引推导） */
export type V3Unit = CombatView['units'][string];

/** v3 阵营（CombatUnitView.side：'player' | 'enemy'，映射自 v2 的 'ally' | 'enemy'） */
export type V3Side = V3Unit['side'];

/**
 * 按 initiativeOrder + side 投影：字典 → 有序单位数组。
 *
 * 只保留「在 initiativeOrder 中且阵营匹配」的单位；units 还没填充（T13 前的空
 * 字典）或 order 里引用了已移除/未收录单位时静默跳过，绝不抛。
 */
export function projectUnitsBySide(combat: CombatView | null, side: V3Side): V3Unit[] {
  if (!combat) return [];
  const out: V3Unit[] = [];
  for (const id of combat.initiativeOrder) {
    const u = combat.units[id];
    if (u && u.side === side) out.push(u);
  }
  return out;
}
