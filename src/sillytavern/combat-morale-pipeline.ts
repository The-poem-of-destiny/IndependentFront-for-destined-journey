/**
 * combat-morale-pipeline — 战意子管道 (M3 战斗 v2 · 任务 4.8)
 *
 * 职责: HP<阈值 → emit combat.morale.check（代码→AI）→ AI 从结果池选行为 → emit combat.morale.result（应用）。
 *      AI 不响应时走 checkMorale 纯函数兜底（确定性，§ RFC Q6）。
 *
 * 流程（架构 §6.4 战意级 event）:
 *   1. checkMorale 纯函数判定基础（确定性兜底）
 *   2. emitChain combat.morale.check（代码→AI，传 hpRatio/combatType/结果池/基础判定）
 *      —— AI 通过 subscribeChain(COMBAT_EVENTS.MORALE_CHECK) 改 params.outcome 覆盖
 *   3. emitChain combat.morale.result（AI→代码，应用最终 outcome）
 *
 * @see docs/reference/combat-system-architecture.md §6.4
 * @see docs/planning/2026-07-28-combat-v2-m3-rfc.md §3 D8 / Q6
 */

import type { PipelineContext } from './combat-v2-types';
import { COMBAT_EVENTS } from './combat-v2-types';
import type { MoraleState, CombatType } from './types';
import { checkMorale, getMoraleOutcomePool } from './morale-system';

export interface MoralePipelineResult {
  triggered: boolean;
  moraleState?: MoraleState;
  /** AI/纯函数选定的结果（投降/溃逃/…） */
  outcome?: string;
}

/** combat.morale.check 链式事件 params 形状（AI 可读可改） */
interface MoraleCheckParams {
  defenderId: string;
  hpRatio: number;
  combatType: CombatType;
  /** 纯函数判定的基础战意状态（AI 参考） */
  baseState: MoraleState;
  /** 纯函数兜底结果（AI 不响应时用此） */
  baseOutcome?: string;
  /** 该 state 下可选的结果池（AI 从中挑选） */
  outcomePool: readonly string[];
  /** 最终 outcome —— AI 可覆盖；未覆盖则取 baseOutcome */
  outcome?: string;
}

/** combat.morale.result 链式事件 params 形状（代码→AI 应用通知） */
interface MoraleResultParams {
  defenderId: string;
  moraleState: MoraleState;
  outcome?: string;
  triggered: boolean;
}

/**
 * 战意子管道。
 *
 * @param defenderId       守方 charId
 * @param defenderHpRatio  守方当前 HP/maxHp（0~1）
 * @param combatType       战斗类型（阈值查 COMBAT_TYPE_MORALE_THRESHOLDS）
 * @param ctx              管道上下文（emitChain 用）
 * @param d20Roll          低阈值类型的 d20（必传）
 *
 * v3 M0 修复架构 §1.4 M-4：v2 此处为 `d20Roll?: number` 可选 + `d20Roll ?? 10` 默认值，
 * 导致战意骰恒 10。现改为**必传**，调用方显式给值；v2 调用方传 10 保持行为不变，
 * M1 起 v3 由内核从 DiceTape statusContest 通道取真骰。
 */
export async function runMoraleCheckPipeline(
  defenderId: string,
  defenderHpRatio: number,
  combatType: CombatType,
  ctx: PipelineContext,
  d20Roll: number,
): Promise<MoralePipelineResult> {
  // 1. 纯函数判定基础（确定性兜底，RFC Q6）
  const baseResult = checkMorale(defenderHpRatio, combatType, d20Roll);

  // 2. emit combat.morale.check（代码→AI）—— AI 通过 subscribeChain(MORALE_CHECK) 注册的 handler
  //    可改 params.outcome（从结果池选行为）。无订阅者时返回原 initialParams。
  const initialCheck: MoraleCheckParams = {
    defenderId,
    hpRatio: defenderHpRatio,
    combatType,
    baseState: baseResult.moraleState,
    baseOutcome: baseResult.outcome,
    outcomePool: getMoraleOutcomePool(baseResult.moraleState),
    outcome: baseResult.outcome,
  };
  const chainCtx = {
    combatants: ctx.combatants,
    source: defenderId,
    readHooks: ctx.readHooks,
  };
  const finalCheck = await ctx.bus.emitChain<MoraleCheckParams>(
    COMBAT_EVENTS.MORALE_CHECK,
    initialCheck,
    chainCtx,
  );

  // 3. AI 不响应 → 用 baseResult 兜底；AI 响应 → 取 params.outcome
  const outcome = finalCheck.outcome ?? baseResult.outcome;
  // 只要纯函数触发 或 AI 选了 outcome，就算触发
  const triggered = baseResult.triggered || outcome !== undefined;

  // 4. emit combat.morale.result（AI→代码，应用最终 outcome）
  const resultParams: MoraleResultParams = {
    defenderId,
    moraleState: baseResult.moraleState,
    outcome,
    triggered,
  };
  await ctx.bus.emitChain<MoraleResultParams>(COMBAT_EVENTS.MORALE_RESULT, resultParams, {
    combatants: ctx.combatants,
    source: defenderId,
  });

  return { triggered, moraleState: baseResult.moraleState, outcome };
}
