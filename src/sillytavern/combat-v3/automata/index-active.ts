/**
 * combat-v3/automata/index-active.ts — ActiveEffectIndex 派生与增量更新（M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §七 7.5（ActiveEffectIndex）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.8
 *
 * ActiveEffectIndex 是战斗内唯一的权威效果索引（架构 §七 7.5）：
 *   - byWindow：每窗口**已按求值顺序**（window → divinity → priority → stableId）排序的 automaton 队列
 *   - byOwner：每持有者 → automaton id 列表（在场过滤 / 离场清理）
 *
 * - `buildIndex(units)`：从在场单位（装备/技能/已编译 automaton）派生全量索引（openCombat）
 * - `updateIndex(index, delta)`：增量增删（ApplyStatus / RemoveStatus / Summon / Despawn 后）
 *
 * index-active.ts 是**纯函数**：buildIndex/updateIndex 都是不可变返回新对象。
 * 排序是稳定的（Array.prototype.sort 稳定排序在 ES2019+ 保证），保证 replay 确定性。
 */

import type { ActiveEffectIndex, CompiledAutomaton, QueuedAutomaton, WindowKey } from '../types';

/** 空索引内的窗口原位（每窗口空数组引用共享，避免重复分配） */
const EMPTY_BY_WINDOW: Readonly<Record<WindowKey, readonly QueuedAutomaton[]>> = {
  'round.open': [],
  'round.close': [],
  'initiative.before': [],
  'initiative.after': [],
  'turn.open': [],
  'turn.close': [],
  'action.declared': [],
  'check.intent': [],
  'check.hit': [],
  collect_attacker_mods: [],
  collect_defender_mods: [],
  'damage.preview': [],
  'damage.compute': [],
  'damage.after': [],
  'unit.beforeDown': [],
  'morale.before': [],
  'morale.after': [],
  'settlement.before': [],
};

/**
 * 求值排序比较器（架构 §五 5.3，固定不可配置）：
 *   window phase → divinity（高者先）→ declared priority → stable id。
 *
 * 末位 stableId 保证同输入同顺序（replay 前提），与 ADR-29 的 (priority, order, 注册序)
 * 同源——只是把「注册序」换成「stable id」，因为 ActiveEffectIndex 是派生的。
 */
export function compareAutomata(a: QueuedAutomaton, b: QueuedAutomaton): number {
  // 1. divinity 高者先（降序）
  if (b.divinity !== a.divinity) return b.divinity - a.divinity;
  // 2. declared priority（升序）
  if (a.priority !== b.priority) return a.priority - b.priority;
  // 3. stable id（字典序升序）
  const sa = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (sa !== 0) return sa;
  return 0;
}

/**
 * 对一组 automaton 做求值排序，返回排序后数组（不修改入参）。
 */
function sortAutomata<T extends QueuedAutomaton>(list: readonly T[]): T[] {
  return [...list].sort(compareAutomata);
}

/**
 * 从在场所属 automaton 集合构建全量索引（openCombat / 战斗内装备变更全量重建）。
 *
 * @param automata 已编译的在场效果集合（每条的 owner 是持有者 unitId）
 * @returns ActiveEffectIndex（byWindow 已排序，byOwner 已分组）
 */
export function buildIndex(automata: readonly CompiledAutomaton[]): ActiveEffectIndex {
  const byWindow: Record<string, CompiledAutomaton[]> = {};
  const byOwner: Record<string, string[]> = {};

  for (const a of automata) {
    // 按窗口分组
    const w = (byWindow[a.subscribe] ??= []);
    w.push(a);
    // 按持有者分组
    const o = (byOwner[a.owner] ??= []);
    o.push(a.id);
  }

  // 构造完整的 byWindow（缺失窗口补空数组），每窗口排序
  const sortedByWindow = {} as Record<WindowKey, readonly QueuedAutomaton[]>;
  for (const key of Object.keys(EMPTY_BY_WINDOW) as WindowKey[]) {
    const list = byWindow[key] ?? [];
    sortedByWindow[key] = sortAutomata(list);
  }

  return { byWindow: sortedByWindow, byOwner };
}

/**
 * 增量更新索引（ApplyStatus / RemoveStatus / Summon / Despawn / 战斗内换装后）。
 *
 * 纯函数：返回新索引，入参不被修改。增量做「加 automaton」/「减 automaton by id」。
 */
export function updateIndex(
  index: ActiveEffectIndex,
  delta: {
    /** 要新增的已编译 automaton（可空） */
    add?: readonly CompiledAutomaton[];
    /** 要移除的 automaton id 列表（可空） */
    removeIds?: readonly string[];
  },
): ActiveEffectIndex {
  const { add = [], removeIds = [] } = delta;
  if (add.length === 0 && removeIds.length === 0) return index;

  // 先在当前索引上做加的增量（拷贝 per-window 数组）
  const byWindow = {} as Record<WindowKey, QueuedAutomaton[]>;
  for (const key of Object.keys(EMPTY_BY_WINDOW) as WindowKey[]) {
    byWindow[key] = [...(index.byWindow[key] ?? [])];
  }
  for (const a of add) {
    byWindow[a.subscribe] = [...(byWindow[a.subscribe] ?? []), a];
  }

  // 移除 id（跨所有窗口过滤）
  const removeSet = new Set(removeIds);
  if (removeSet.size > 0) {
    for (const key of Object.keys(byWindow) as WindowKey[]) {
      if ((byWindow[key] ?? []).some((x) => removeSet.has(x.id))) {
        byWindow[key] = byWindow[key].filter((x) => !removeSet.has(x.id));
      }
    }
  }

  // 每窗口重排序
  const sortedByWindow = {} as Record<WindowKey, readonly QueuedAutomaton[]>;
  for (const key of Object.keys(byWindow) as WindowKey[]) {
    sortedByWindow[key] = sortAutomata(byWindow[key]);
  }

  // byOwner 增量
  const byOwner: Record<string, string[]> = {};
  for (const [owner, ids] of Object.entries(index.byOwner)) {
    byOwner[owner] = [...ids.filter((id) => !removeSet.has(id))];
  }
  for (const a of add) {
    (byOwner[a.owner] ??= []).push(a.id);
  }

  return { byWindow: sortedByWindow, byOwner };
}
