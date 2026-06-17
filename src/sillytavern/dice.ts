/**
 * $dice 骰池系统 — Layer 2 纯函数
 *
 * 职责: 掷骰计算、判定、格式化。纯函数，无副作用，AI 可读不可写。
 *
 * 支持:
 * - 标准骰子: d4, d6, d8, d10, d12, d20, d100
 * - 优势/劣势 (d20 系统)
 * - 多骰子: 2d6+3, 4d8
 * - 临界判定 (d20 大成功 20 / 大失败 1)
 * - DC 目标判定
 */

import type { DiceRollPayload, DiceRollResult } from './types';

// ========== 掷骰核心 ==========

/** 掷单个骰子 (1~sides) */
export function rollDie(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

/** 掷 N 个 M 面骰子 */
export function rollDice(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => rollDie(sides));
}

// ========== 公式解析 ==========

const DICE_REGEX = /^(\d+)?d(\d+)([+-]\d+)?$/i;

/** 解析骰子公式: "d20", "2d6+3", "4d8-1" */
export function parseDiceFormula(formula: string): {
  count: number;
  sides: number;
  modifier: number;
} | null {
  const match = formula.trim().match(DICE_REGEX);
  if (!match) return null;

  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (count < 1 || sides < 2) return null;

  return { count, sides, modifier };
}

// ========== 主投掷函数 ==========

/**
 * 根据 DiceRollPayload 执行完整掷骰
 * 支持优势/劣势 (d20 系统) 和 DC 目标判定
 */
export function executeDiceRoll(payload: DiceRollPayload): DiceRollResult {
  const parsed = parseDiceFormula(payload.formula);
  if (!parsed) {
    throw new Error(`无效的骰子公式: ${payload.formula}`);
  }

  const { count, sides, modifier: formulaMod } = parsed;
  const totalModifier = (payload.modifier ?? 0) + formulaMod;

  let rolls: number[];

  // 优势/劣势: 掷两次取高/低 (仅 d20)
  if (payload.advantage && sides === 20) {
    const r1 = rollDie(20);
    const r2 = rollDie(20);
    rolls = [Math.max(r1, r2)];
  } else if (payload.disadvantage && sides === 20) {
    const r1 = rollDie(20);
    const r2 = rollDie(20);
    rolls = [Math.min(r1, r2)];
  } else {
    rolls = rollDice(count, sides);
  }

  const rawTotal = rolls.reduce((a, b) => a + b, 0);
  const total = rawTotal + totalModifier;

  // 临界判定
  const criticalSuccess = sides === 20 && rolls.length === 1 && rolls[0] === 20;
  const criticalFailure = sides === 20 && rolls.length === 1 && rolls[0] === 1;

  // DC 判定
  const meetsDC = payload.targetDC !== undefined ? total >= payload.targetDC : undefined;

  // 构建描述
  const advantageText = payload.advantage ? ' (优势)' : payload.disadvantage ? ' (劣势)' : '';
  const modText = totalModifier !== 0
    ? (totalModifier > 0 ? ` +${totalModifier}` : ` ${totalModifier}`)
    : '';
  const critText = criticalSuccess ? ' 🎯大成功!' : criticalFailure ? ' 💀大失败!' : '';
  const dcText = payload.targetDC !== undefined
    ? ` [DC${payload.targetDC}: ${meetsDC ? '✓成功' : '✗失败'}]`
    : '';

  const description = `${payload.formula}${advantageText}${modText} = ${total} (${rolls.join(', ')})${critText}${dcText}`;

  return {
    formula: payload.formula,
    rolls,
    total,
    modifier: totalModifier,
    advantage: payload.advantage ?? false,
    disadvantage: payload.disadvantage ?? false,
    criticalSuccess,
    criticalFailure,
    meetsDC,
    description,
  };
}

// ========== 便捷掷骰函数 ==========

/** d20 检定 */
export function d20(modifier: number = 0, advantage: boolean = false, disadvantage: boolean = false): DiceRollResult {
  return executeDiceRoll({
    formula: 'd20',
    advantage,
    disadvantage,
    modifier,
  });
}

/** d100 检定 */
export function d100(modifier: number = 0): DiceRollResult {
  return executeDiceRoll({ formula: 'd100', modifier });
}

/** 通用多骰子: 2d6, 3d8+2 等 */
export function roll(formula: string, modifier: number = 0, targetDC?: number): DiceRollResult {
  return executeDiceRoll({ formula, modifier, targetDC });
}

// ========== $dice Namespace (AI 可读) ==========

/** AI 可见的 $dice API */
export const $dice = {
  d20,
  d100,
  roll,
  rollDie,
  parseDiceFormula,
  executeDiceRoll,
} as const;

// ========== 辅助计算 ==========

/** 计算期望值 */
export function expectedValue(count: number, sides: number): number {
  return count * (sides + 1) / 2;
}

/** 计算成功率 (vs DC) — 基于均匀分布近似 */
export function successProbability(modifier: number, dc: number, sides: number = 20): number {
  const needed = dc - modifier;
  if (needed <= 1) return 1;
  if (needed > sides) return 0;
  return (sides - needed + 1) / sides;
}
