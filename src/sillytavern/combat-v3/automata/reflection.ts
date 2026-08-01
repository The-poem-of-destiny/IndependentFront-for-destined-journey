/**
 * combat-v3/automata/reflection.ts — 反射（反伤）解析纯函数（M3, 架构 §九）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §九（反射专项）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.9 / 验收 A3-8
 *
 * 第 24 场「虚数反弹」反伤的确定性解析（§九 R1-R8）：
 *   - intent 形态（R1）：DealDamage({ damageType:'true', isReaction:true, doesNotConsumeSlot:true, rootChainId, depth })
 *   - 基准取值（R4/R7）：depth≥1 反伤基准取 rootChain 的 **preReduction**，不放大
 *   - 熔断（R6）：depth ≥ MAX_REFLECTION_DEPTH(=2) ⇒ mutual_cancel + NarrativeCue('反射湮灭')
 *   - 不消耗攻击槽（不变量①豁免）：反伤 doesNotConsumeSlot，不碰攻击者槽位
 *   - 命中骰（R8）：反伤须走 attackHit 通道（hitPolicy.consumeDice）
 *
 * 纯函数：无副作用，确定性可重放（零 Math.random / new Function / eval）。
 */

import { MAX_REFLECTION_DEPTH, type DamageCtx } from '../types';

/** 反射解析结果：推进一层反伤 or 熔断 */
export type ReflectionResolution =
  | {
      kind: 'propagate';
      baseDamage: number;
      reflectRatio: number;
      reflectedAmount: number;
      nextDepth: number;
    }
  | { kind: 'mutual_cancel'; baseDamage: number; annihilated: true };

/** 反射策略常量（架构 §九 9.1） */
export interface ReflectionPolicy {
  MAX_REFLECTION_DEPTH: number;
  overflowStrategy: 'mutual_cancel';
  baseRule: 'root_chain';
}

export const REFLECTION_POLICY: ReflectionPolicy = {
  MAX_REFLECTION_DEPTH,
  overflowStrategy: 'mutual_cancel',
  baseRule: 'root_chain',
};

/**
 * 决定一次反伤是否继续推进（§九 R1/R4/R6/R7）。
 *
 * @param depth 当前反伤深度（1 = 首次反伤；2 = 反伤对反伤）
 * @param damage 攻击链的伤害上下文（取 preReduction 为基准，R4）
 * @param reflectRatio 反伤百分比（如 0.3 = 30%）
 * @returns
 *   - depth ≥ MAX → mutual_cancel（双方本链反伤互相抵消 + 湮灭叙事）
 *   - 否则 propagate（base = preReduction，不放大，R7）
 */
export function resolveReflection(
  depth: number,
  damage: Pick<DamageCtx, 'preReduction' | 'final'>,
  reflectRatio: number,
): ReflectionResolution {
  // 首次反伤深度：damage 链根的 depth=0，automatons 里自检 depth<2；
  // 这里把「当前链深度」与 MAX 比较：depth(进入该 automaton 时) >= MAX ⇒ 熔断
  if (depth >= MAX_REFLECTION_DEPTH) {
    return { kind: 'mutual_cancel', baseDamage: damage.preReduction, annihilated: true };
  }
  // R4/R7：基准取 preReduction（Step 1 初始），非 final；depth≥2 也不放大
  const base = damage.preReduction;
  const reflectedAmount = Math.floor(base * reflectRatio);
  return {
    kind: 'propagate',
    baseDamage: base,
    reflectRatio,
    reflectedAmount,
    nextDepth: depth + 1,
  };
}

/**
 * 反伤时产生的叙事提示（R6 熔断）。
 */
export const REFLECTION_ANNIHILATION_CUE = '反射湮灭';
