/**
 * combat-v3/windows.ts — ReactionWindow 空转版 evaluator（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §五（ReactionWindow 清单）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.2 / §3.6
 *
 * M1 空转：ActiveEffectIndex 恒空（无 automaton），evaluateWindow 遍历 it 恒返回空数组。
 * 但窗口调用点全部就位——phases/round、phases/attack 等在对应结算点调用
 * evaluateWindow(key, ctx)，M3 只填索引、不用改调用点。
 *
 * 求值顺序（架构 §五 5.3）M3 实装：window phase → divinity → priority → stable id。
 * 返回 intents 数组（M1 恒空）。
 */

import type { ActiveEffectIndex, WindowKey } from './types';

/**
 * 窗口求值上下文（M1 空转版：由 phases 构造，ctx 可空）。
 * M3 起按窗口分型；这里给最小公共字段，避免 M3 大改调用点。
 */
export interface WindowCtx {
  /** 触发窗口的根本单位（攻击者 / 受击者） */
  selfId?: string;
  /** 目标单位（damage 类窗口） */
  targetId?: string;
  /** 当前回合 */
  round?: number;
}

/**
 * 求值一个 ReactionWindow。
 *
 * M1 恒返回空数组（无 automaton 订阅）。签名固定，M3 实装时只改内部：
 *   - 取 ActiveEffectIndex.byWindow[key]（已按 §5.3 排序）
 *   - 每个 automaton 求值 trigger → 收集 intent batch
 *   - 在场过滤 / 错误隔离 / 预算 64（§5.4）
 */
export function evaluateWindow(
  index: ActiveEffectIndex,
  key: WindowKey,
  ctx: WindowCtx,
): readonly { automatonId: string; intents: readonly unknown[] }[] {
  // M1 恒空：const queue = index.byWindow[key] ?? [];
  // if (queue.length === 0) return [];
  return [];
}

/**
 * 检查某窗口是否有订阅者（架构 §五 5.2 约束 3：无订阅者跳过，不打断节奏）。
 * M1 恒返回 false（无 automaton）。M3 实装后用于 damage.preview 等暂停判断。
 */
export function hasSubscribers(index: ActiveEffectIndex, key: WindowKey): boolean {
  return (index.byWindow[key] ?? []).length > 0;
}
