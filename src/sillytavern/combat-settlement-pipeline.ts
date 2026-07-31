/**
 * combat-settlement-pipeline — 结算子管道 (M3 战斗 v2 · 任务 4.9)
 *
 * 职责: combat.end → EXP 计算（代码）→ combat.settle.loot（AI 战利品 itemThink）→ combat.settle.complete（EXP/FP + 摘要）。
 *
 * 对齐:
 *  - docs/reference/combat-system-architecture.md §6.4（结算级 event）
 *  - docs/planning/2026-07-28-combat-v2-m3-rfc.md §3 D9
 *
 * 计算分工（架构 §7）:
 *  - EXP 公式（代码）: 单体 = 目标 Lv × 战斗系数；集群占位衰减（M4 精细化）。
 *  - 战利品（AI）: 通过 subscribeChain(SETTLE_LOOT) 返回 loot 列表（itemThink）。
 *  - EXP 分配（M4）: 本子管道仅把 EXP 汇总写进 patches 占位（给第一个 ally），精细分配由调用方/M4 处理。
 */

import type { CombatState, StatePatch } from './types';
import type { PipelineContext } from './combat-pipeline';
import { COMBAT_EVENTS } from './combat-pipeline';
import { getCombatCoefficient } from './tier-constants';

export interface SettlementResult {
  /** 计算出的 EXP（单体 = 目标 Lv × 战斗系数，集群衰减） */
  exp: number;
  /** FP 奖励（AI 创造性评估） */
  fp?: number;
  /** 战利品 / EXP 结算 patch */
  patches: StatePatch[];
  /** AI 写的结算摘要 */
  summary?: string;
}

/** 集群单位 EXP 贡献衰减系数（M3 占位：≥3 合并的目标按成员数线性衰减，M4 改查世界书规则） */
function clusterExpFactor(clusterCount: number | undefined): number {
  if (!clusterCount || clusterCount < 3) return 1;
  // 简化: 集群越大单位贡献越低（避免一次战斗 EXP 暴涨），下限 0.5
  return Math.max(0.5, 1 - (clusterCount - 3) * 0.1);
}

/**
 * 结算子管道。
 *
 * 流程:
 *   1. emitChain combat.end（传 winner）
 *   2. 代码算 EXP（单体/集群占位衰减）
 *   3. emitChain combat.settle.loot（AI 通过 subscribeChain 返回 loot 列表）
 *   4. emitChain combat.settle.complete（EXP/FP + 摘要）
 *   5. 返回 SettlementResult（EXP patch 占位给第一个 ally，M4 精细分配）
 *
 * 胜负语义:
 *  - ally 胜: 败方 = enemy，EXP = 敌方所有单位 Lv×战斗系数之和（含集群衰减），patches 含 EXP。
 *  - enemy 胜: 败方 = ally，己方败北无奖励 → EXP = 0，patches 空（仍触发全部 event，AI 可写伤亡摘要）。
 *  - draw: 双方均未胜出 → EXP = 0。
 */
export async function runSettlementPipeline(
  combat: CombatState,
  winner: 'ally' | 'enemy' | 'draw',
  ctx: PipelineContext,
): Promise<SettlementResult> {
  const chainCtx = { combatants: ctx.combatants, readHooks: ctx.readHooks };

  // ===== 1. event: combat.end (代码→AI/脚本，通知终局 + winner) =====
  await ctx.bus.emitChain(
    COMBAT_EVENTS.END,
    { combatId: combat.combatId, winner, round: combat.round },
    chainCtx,
  );

  // ===== 2. 代码算 EXP（败方所有单位 Lv × 战斗系数，集群占位衰减）=====
  // 语义: ally 胜 → 败方 = enemy，按敌单位汇总 EXP；enemy 胜/draw → 己方败北或平局，无奖励。
  const loserSide: 'ally' | 'enemy' | null = winner === 'ally' ? 'enemy' : null;

  let exp = 0;
  const defeatedEnemies: Array<{ name: string; tier: number; level: number }> = [];
  if (loserSide) {
    // 🐛修复(对抗验证): 先排除逃跑成功的单位（runner 对其置 canAct=false + fled 标记，
    // 若只看 hp/canAct，逃掉的敌人会被当作"被击败"照发 EXP —— 规范 §13-m 逃跑无 EXP）
    const losers = combat.participants.filter(
      (p) => p.side === loserSide && !(p as { fled?: boolean }).fled,
    );
    // EXP 只计"被击败"的单位（阵亡或失能/被制服）。
    // 若无人满足（如全员投降的无伤胜利），退回按全体未逃跑败方计（认输也是被击败）。
    const defeated = losers.filter((p) => p.hp <= 0 || !p.canAct);
    const counted = defeated.length > 0 ? defeated : losers;
    for (const p of counted) {
      const factor = clusterExpFactor(p.clusterCount);
      exp += p.level * getCombatCoefficient(p.tier) * factor;
      defeatedEnemies.push({ name: p.name, tier: p.tier, level: p.level });
    }
    // 整数取整（与 tier-constants 的乘数表对齐，避免浮点 EXP）
    exp = Math.floor(exp);
  }

  // ===== 3. event: combat.settle.loot (代码→AI，战利品 itemThink) =====
  // AI 通过 subscribeChain(SETTLE_LOOT) 在 handler 里返回 { ...p, loot: [...] }
  const lootParams = await ctx.bus.emitChain(
    COMBAT_EVENTS.SETTLE_LOOT,
    {
      winner,
      exp,
      defeatedEnemies,
      loot: [] as Array<{ name: string; quality?: string; quantity?: number }>,
    },
    chainCtx,
  );
  const loot =
    (lootParams as { loot?: Array<{ name: string; quality?: string; quantity?: number }> })?.loot ??
    [];

  // ===== 4. event: combat.settle.complete (代码→AI，EXP/FP + 摘要) =====
  // AI 可在 handler 里写入 summary（结算叙事）和 fp（FP 创造性评估）
  const completeParams = await ctx.bus.emitChain(
    COMBAT_EVENTS.SETTLE_COMPLETE,
    {
      winner,
      exp,
      loot,
      fp: 0,
      summary: '',
    },
    chainCtx,
  );
  const summaryRaw = (completeParams as { summary?: string })?.summary;
  const summary: string =
    summaryRaw && summaryRaw.trim().length > 0
      ? summaryRaw
      : `${winner === 'draw' ? '平局' : `${winner} 方胜利`}${exp > 0 ? `，获得 ${exp} EXP` : ''}`;
  const fpRaw = (completeParams as { fp?: number })?.fp;
  const fp: number | undefined = fpRaw && fpRaw > 0 ? fpRaw : undefined;

  // ===== 5. 组装 patches（EXP 占位给第一个 ally，M4 精细分配）=====
  const patches: StatePatch[] = [];
  if (winner === 'ally' && exp > 0) {
    const firstAlly = combat.participants.find((p) => p.side === 'ally');
    if (firstAlly) {
      patches.push({
        op: 'delta_variable',
        target: 'variables.exp',
        amount: exp,
        metadata: {
          source: 'combat-settlement',
          combatId: combat.combatId,
          winner,
          allyCharId: firstAlly.characterId,
        },
      });
    }
  }

  return { exp, patches, summary, ...(fp !== undefined ? { fp } : {}) };
}
