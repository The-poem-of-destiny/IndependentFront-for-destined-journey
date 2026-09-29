/**
 * 士气/战意系统 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: 基于 HP% 和战斗类型判定战意状态，管理 4 级士气状态机。
 * 对齐世界书 #837805 [战斗协议] 第五阶段「战意判定」。
 *
 * 4 级战意状态: steady → shaken → wavering → routing
 *
 * 阈值规则 (按战斗类型):
 *   高阈值 (自动触发): 切磋(40%) / 竞技(30%) / 压制(50%)
 *   低阈值 (需 d20<12 检定): 死斗(10%) / 标准(30%) / 守卫(35%)
 *
 * 结果池: 投降/认输/求饶/溃逃/撤退/被击昏/被俘虏/中止战斗/阵线溃散/内讧
 */

import type { CombatType, MoraleState, MoraleCheckResult } from '../types/types';
import {
  COMBAT_TYPE_MORALE_THRESHOLDS,
  MORALE_OUTCOME_POOL,
  MORALE_STATE_LABELS,
} from '../types/types';

// ========== 阈值查询 ==========

/**
 * 获取指定战斗类型的士气溃败阈值 (HP%)。
 * 复用 types.ts 中的 COMBAT_TYPE_MORALE_THRESHOLDS。
 */
export function getMoraleThreshold(combatType: CombatType): number {
  return COMBAT_TYPE_MORALE_THRESHOLDS[combatType];
}

/**
 * 高阈值战斗类型: HP 低于阈值时自动触发战意动摇。
 * 包括: 切磋(40%) / 竞技(30%) / 压制(50%)
 */
export function isAutoTriggerType(combatType: CombatType): boolean {
  return combatType === '切磋' || combatType === '竞技' || combatType === '压制';
}

/**
 * 低阈值战斗类型: HP 低于阈值时需 d20 < 12 检定。
 * 包括: 死斗(10%) / 标准(30%) / 守卫(35%)
 */
export function isCheckTriggerType(combatType: CombatType): boolean {
  return combatType === '死斗' || combatType === '标准' || combatType === '守卫';
}

// ========== 士气检查 (核心) ==========

/**
 * 执行完整的战意判定 (对齐世界书 #837805 第五阶段)。
 *
 * 仅非 <user> 单位触发。
 * - 高阈值类型 (切磋/竞技/压制): HP 低于阈值 → 自动战意动摇
 * - 低阈值类型 (死斗/标准/守卫): HP 低于阈值 → d20 < 12 触发
 * - HP 高于阈值 → 不触发
 *
 * @param hpRatio - 当前 HP / 最大 HP (0.0 ~ 1.0)
 * @param combatType - 战斗类型
 * @param d20Roll - d20 骰值 (仅低阈值类型需要, 1~20)
 */
export function checkMorale(
  hpRatio: number,
  combatType: CombatType,
  d20Roll?: number,
): MoraleCheckResult {
  const threshold = getMoraleThreshold(combatType);

  // HP 高于阈值 → 未触发
  if (hpRatio > threshold) {
    return {
      moraleState: 'steady',
      triggered: false,
      triggerType: 'none',
      narrative: `HP ${(hpRatio * 100).toFixed(0)}% > 阈值 ${(threshold * 100).toFixed(0)}% → 战意坚定`,
    };
  }

  // 高阈值类型 → 自动触发
  if (isAutoTriggerType(combatType)) {
    const state = hpRatio <= threshold * 0.25 ? 'routing' : 'wavering';
    const outcome = pickRandomOutcome(state);

    return {
      moraleState: state,
      triggered: true,
      triggerType: 'auto',
      outcome,
      narrative: `[${combatType}] HP ${(hpRatio * 100).toFixed(0)}% < 阈值 ${(threshold * 100).toFixed(0)}% → 自动触发 [${MORALE_STATE_LABELS[state]}] → ${outcome}`,
    };
  }

  // 低阈值类型 → 需要 d20 检定
  if (isCheckTriggerType(combatType)) {
    const roll = d20Roll ?? 10; // 默认值 (用于测试)
    const passed = roll < 12; // d20 < 12 → 战意崩溃
    const state: MoraleState = passed ? 'routing' : 'shaken';
    const outcome = passed ? pickRandomOutcome('routing') : pickRandomOutcome('shaken');

    return {
      moraleState: state,
      triggered: passed,
      triggerType: 'check',
      checkRoll: {
        d20Roll: roll,
        target: 12,
        passed,
      },
      outcome: passed ? outcome : undefined,
      narrative: passed
        ? `[${combatType}] HP ${(hpRatio * 100).toFixed(0)}% < 阈值 ${(threshold * 100).toFixed(0)}%, d20=${roll} < 12 → 触发 [${MORALE_STATE_LABELS[state]}] → ${outcome}`
        : `[${combatType}] HP ${(hpRatio * 100).toFixed(0)}% < 阈值 ${(threshold * 100).toFixed(0)}%, d20=${roll} ≥ 12 → 未触发, 仅 [${MORALE_STATE_LABELS[state]}]`,
    };
  }

  // fallback (不应到达)
  return {
    moraleState: 'steady',
    triggered: false,
    triggerType: 'none',
    narrative: '未知战斗类型，跳过战意判定',
  };
}

// ========== 结果池 ==========

/**
 * 从战意结果池中随机选取一个结果。
 * 使用简单的确定性选择 (基于状态 + 简单轮换) 而非 implicit random dice。
 * 调用方可通过 seed 参数控制选择。
 */
export function pickRandomOutcome(state: MoraleState, seed?: number): string {
  const pool = MORALE_OUTCOME_POOL[state];
  if (pool.length === 0) return '坚守阵地';
  // 确定性选择: 使用 seed (默认 0) 取模
  const idx = (seed ?? 0) % pool.length;
  return pool[idx];
}
