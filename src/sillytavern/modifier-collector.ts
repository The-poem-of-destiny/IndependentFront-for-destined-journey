/**
 * ModifierCollector — collect_mods 机制（M2 战斗 v2 · 组 C）
 *
 * 职责：用 M1 的 {@link EventBus.emitChain} 收集攻/守方装备/技能/buff 声明的 modifier。
 *
 * 设计（对齐 RFC §3 D3 + §4.2 + 架构 §四/§6.3）：
 *  - 装备/技能通过 `bus.subscribeChain(ATTACKER_MODS, ...)` 注册 handler，
 *    handler 内读 `params.attack` 决定是否声明 modifier，往 `params.mods.push(...)` 写入。
 *  - `collectAttackerMods` / `collectDefenderMods` 只负责构造初始 params、emitChain、返回最终 mods。
 *  - 在场过滤复用 emitChain 内置能力（`ctx.combatants` + `subscription.owner`）：
 *      * `owner` 给定且不在 `combatants` 的订阅被跳过
 *      * `owner` 缺省的订阅（系统/环境 buff）永不被过滤
 *  - 错误隔离复用 emitChain：单个 handler 抛错不中断收集。
 *
 * M2 边界（RFC §3 D4）：本模块只 collect，**不**把 modifier 分发到 runDamagePipeline 各步。
 * 分类聚合工具在 {@link ./effect-types}（classifyModifier / sumFixedDamage / ...），
 * 真正注入管线是 M3 任务 4.4。
 *
 * 复用要点（M1 已交付）：
 *  - `EventBus.emitChain(type, initialParams, ctx)` 链式传递 + 在场过滤 + priority 排序 + 错误隔离
 *  - `ChainSubscription` 的 `owner`/`priority`/`order`/`condition` 字段
 */

import type { EventBus } from './game-event';
import type { Modifier } from './effect-types';
import type { DamageType } from './types';

// ========== 事件名常量（M3 战斗管线 import 复用，避免拼写错） ==========

/**
 * collect_mods 事件名常量。
 *
 * - `ATTACKER_MODS`：收集攻方 modifier（攻击者装备/技能/buff 声明）
 * - `DEFENDER_MODS`：收集守方 modifier（防御者装备/技能/buff 声明）
 *
 * 两者走独立的链式管道，互不串台（在 ATTACKER_MODS 注册的 handler 不会被 DEFENDER_MODS 收集触发）。
 */
export const COMBAT_MOD_EVENTS = {
  ATTACKER_MODS: 'combat.attack.collect_attacker_mods',
  DEFENDER_MODS: 'combat.attack.collect_defender_mods',
} as const;

// ========== 收集上下文 ==========

/**
 * collect 时的 attack 上下文 —— handler 读它决定是否声明 modifier。
 *
 * 与 {@link CollectModsParams.attack} 同形：emitChain 把它放进 params 透传给每个 handler。
 * 字段语义：
 *  - `attackerId` / `defenderId`：参战双方 charId（也是在场过滤、source 溯源的依据）
 *  - `skillId`：本次攻击使用的技能名（缺省=普攻/未指定）
 *  - `weaponName`：本次攻击使用的武器名（缺省=徒手/未指定）
 *  - `damageType`：本次攻击的伤害类型（缺省=未指定，handler 自行推导）
 */
export interface CollectModsAttack {
  attackerId: string;
  defenderId: string;
  skillId?: string;
  weaponName?: string;
  damageType?: DamageType;
}

/**
 * emitChain 传给 handler 的 params。
 *
 * - `mods`：handler 往这里 push 声明的 modifier（初始为空数组，链尾返回完整列表）
 * - `attack`：本次攻击的上下文（透传给每个 handler 做判定）
 */
export interface CollectModsParams {
  mods: Modifier[];
  attack: CollectModsAttack;
}

// ========== 收集函数 ==========

/**
 * 收集攻方 modifier（走 emitChain `ATTACKER_MODS`）。
 *
 * 流程：
 *  1. 构造 `params = { mods: [], attack }`
 *  2. `await bus.emitChain(ATTACKER_MODS, params, { combatants, source: attack.attackerId })`
 *  3. 返回 `params.mods`
 *
 * 在场过滤（由 emitChain 内置）：
 *  - 订阅带 `owner='charX'` 且 `charX` 不在 `combatants` 中 → 该订阅被跳过
 *  - 订阅 `owner` 缺省（系统/环境 buff）→ 永不被过滤
 *
 * @param bus 存档级 EventBus 实例（按 SaveSlot 隔离）
 * @param attack 本次攻击上下文（attackerId 用作 emitChain 的 source 溯源）
 * @param combatants 参战者 charId 列表（在场过滤依据；空数组=全场无人在场，所有 owner 订阅都被跳过）
 * @returns 收集到的 modifier 列表（按链式顺序累积，未排序时为订阅注册序）
 */
export async function collectAttackerMods(
  bus: EventBus,
  attack: CollectModsAttack,
  combatants: string[],
): Promise<Modifier[]> {
  const params: CollectModsParams = { mods: [], attack };
  const result = await bus.emitChain<CollectModsParams>(
    COMBAT_MOD_EVENTS.ATTACKER_MODS,
    params,
    { combatants, source: attack.attackerId },
  );
  return result.mods;
}

/**
 * 收集守方 modifier（走 emitChain `DEFENDER_MODS`）。
 *
 * 与 {@link collectAttackerMods} 同构，区别仅在：
 *  - 事件名走 `DEFENDER_MODS`（与 `ATTACKER_MODS` 互不串台）
 *  - emitChain 的 `source` 用 `attack.defenderId`（守方视角溯源）
 *
 * @param bus 存档级 EventBus 实例
 * @param attack 本次攻击上下文（defenderId 用作 emitChain 的 source 溯源）
 * @param combatants 参战者 charId 列表
 * @returns 收集到的守方 modifier 列表
 */
export async function collectDefenderMods(
  bus: EventBus,
  attack: CollectModsAttack,
  combatants: string[],
): Promise<Modifier[]> {
  const params: CollectModsParams = { mods: [], attack };
  const result = await bus.emitChain<CollectModsParams>(
    COMBAT_MOD_EVENTS.DEFENDER_MODS,
    params,
    { combatants, source: attack.defenderId },
  );
  return result.mods;
}
