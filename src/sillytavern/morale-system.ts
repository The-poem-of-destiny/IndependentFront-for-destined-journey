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

import type { CombatType, MoraleState, MoraleCheckResult } from './types';
import {
  COMBAT_TYPE_MORALE_THRESHOLDS,
  MORALE_OUTCOME_POOL,
  MORALE_STATE_LABELS,
} from './types';

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

/** 高阈值战斗类型列表 (自动触发) */
export const AUTO_TRIGGER_TYPES: CombatType[] = ['切磋', '竞技', '压制'];

/** 低阈值战斗类型列表 (需 d20 检定) */
export const CHECK_TRIGGER_TYPES: CombatType[] = ['死斗', '标准', '守卫'];

// ========== 战意状态判定 ==========

/**
 * 根据 HP 比例和阈值判定基础战意状态。
 *
 * @param hpRatio - 当前 HP / 最大 HP (0.0 ~ 1.0)
 * @param threshold - 士气阈值 (如 0.30 = 30%)
 */
export function getBaseMoraleState(
  hpRatio: number,
  threshold: number,
): MoraleState {
  if (hpRatio > threshold) return 'steady';
  if (hpRatio > threshold * 0.5) return 'shaken';
  if (hpRatio > threshold * 0.25) return 'wavering';
  return 'routing';
}

/** 战意状态 → 严重度 (0-3) */
export function getMoraleSeverity(state: MoraleState): number {
  switch (state) {
    case 'steady': return 0;
    case 'shaken': return 1;
    case 'wavering': return 2;
    case 'routing': return 3;
  }
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
  const baseState = getBaseMoraleState(hpRatio, threshold);

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
    const passed = roll < 12;   // d20 < 12 → 战意崩溃
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
 * 使用简单的确定性选择 (基于状态 + 简单轮换) 而非 Math.random()。
 * 调用方可通过 seed 参数控制选择。
 */
export function pickRandomOutcome(
  state: MoraleState,
  seed?: number,
): string {
  const pool = MORALE_OUTCOME_POOL[state];
  if (pool.length === 0) return '坚守阵地';
  // 确定性选择: 使用 seed (默认 0) 取模
  const idx = (seed ?? 0) % pool.length;
  return pool[idx];
}

/** 战意结果池 (全部结果) */
export function getMoraleOutcomePool(state: MoraleState): readonly string[] {
  return MORALE_OUTCOME_POOL[state] ?? [];
}

// ========== 战意状态机能修正 ==========

/**
 * 战意状态对战斗行为的修正。
 * - steady: 无修正
 * - shaken: 攻击骰-2, 无法处决
 * - wavering: 攻击骰-4, 闪避无效, 无法攻击
 * - routing: 无法行动, 闪避无效, 可被处决
 */
export interface MoraleModifiers {
  attackPenalty: number;
  dodgeNegated: boolean;
  canAct: boolean;
  canBeExecuted: boolean;
}

export function getMoraleModifiers(state: MoraleState): MoraleModifiers {
  switch (state) {
    case 'steady':
      return { attackPenalty: 0, dodgeNegated: false, canAct: true, canBeExecuted: false };
    case 'shaken':
      return { attackPenalty: -2, dodgeNegated: false, canAct: true, canBeExecuted: false };
    case 'wavering':
      return { attackPenalty: -4, dodgeNegated: true, canAct: false, canBeExecuted: true };
    case 'routing':
      return { attackPenalty: -999, dodgeNegated: true, canAct: false, canBeExecuted: true };
  }
}

// ========== 处决条件检测 ==========

/**
 * 检测目标是否满足处决条件 (对齐世界书 #837805 第三阶段 §3):
 *   - 战意动摇 (wavering) 或 崩溃 (routing)
 *   - 攻方意图处决
 *   → 意图判定自动成功，闪避无效，评级保底暴击(1.3)
 */
export function canExecute(moraleState: MoraleState): boolean {
  return moraleState === 'wavering' || moraleState === 'routing';
}

/** 处决时的战斗修正 */
export function getExecutionModifiers() {
  return {
    intentionAutoSuccess: true,
    dodgeNegated: true,
    minRatingCoefficient: 1.3, // 保底暴击
    narrativeNote: '目标战意动摇/崩溃 + 处决意图 → 自动成功, 闪避无效, 评级保底暴击(1.3)',
  };
}

// ========== 面板展示 ==========

/**
 * 格式化战意状态为 <action_info> 面板行。
 */
export function formatMoralePanel(
  characterName: string,
  hp: number,
  maxHp: number,
  threshold: number,
  combatType: CombatType,
  d20Roll?: number,
): string {
  const hpRatio = maxHp > 0 ? hp / maxHp : 0;
  const autoType = isAutoTriggerType(combatType);
  const result = checkMorale(hpRatio, combatType, d20Roll);

  const lines = [
    `| 触发: ${characterName} HP [${hp}/${maxHp}] < 阈值 [${(threshold * 100).toFixed(0)}%] |`,
    `| 类型: ${combatType} -> ${autoType ? '无需检定' : '需要检定'} |`,
  ];

  if (result.triggerType === 'check' && result.checkRoll) {
    const cr = result.checkRoll;
    lines.push(`| 判定: d20=${cr.d20Roll} vs ${cr.target} -> ${cr.passed ? '崩溃' : '坚守'} |`);
  } else if (result.triggerType === 'auto' && result.triggered) {
    lines.push(`| 判定: 自动触发 -> ${MORALE_STATE_LABELS[result.moraleState]} |`);
  } else {
    lines.push(`| 判定: 未触发 |`);
  }

  if (result.outcome) {
    lines.push(`| 结果: ${characterName} ${result.outcome} |`);
  }

  return lines.join('\n');
}

// ========== 批量士气检测 ==========

/**
 * 对所有非 <user> 战斗参与者执行士气检测。
 * 返回触发战意事件的单位列表。
 */
export interface BatchMoraleResult {
  participantId: string;
  name: string;
  result: MoraleCheckResult;
}

export function checkAllMorale(
  participants: Array<{
    id: string;
    name: string;
    hp: number;
    maxHp: number;
    isUser: boolean;
  }>,
  combatType: CombatType,
  d20Rolls: number[],
): BatchMoraleResult[] {
  const results: BatchMoraleResult[] = [];

  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    // 跳过 user
    if (p.isUser) continue;

    const hpRatio = p.maxHp > 0 ? p.hp / p.maxHp : 0;
    const d20 = d20Rolls[i] ?? 10;
    const result = checkMorale(hpRatio, combatType, d20);

    if (result.triggered) {
      results.push({ participantId: p.id, name: p.name, result });
    }
  }

  return results;
}
