/**
 * combat-v3/rule-keys.ts — closed RuleKey 注册表 + 空转 override（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §八（closed RuleKey 与 divinity 压制）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.2 / §3.5（C3 落点）
 *
 * M1 只注册 `terminal.forceTerminal`（概念级终局，非 HP 清空判胜，第 09 场）。
 * 其余三个（morale.forceState / action.freezeSlot / death.threshold）M4 补（plan §7.3）。
 *
 * RuleKeySpec 描述每把锁的 schema 与 divinity 门槛（架构 §八 8.2 表）。
 * resolveOverride 空转（M1 coordinator 未接，override 经由内核内部 forceTerminal 触发）。
 */

import type { DivinityLevel } from '../types';

/**
 * 一把 closed RuleKey 的规格。
 * M1 只用 terminal.forceTerminal；其余 M4 注册。
 */
export interface RuleKeySpec {
  /** 用途说明 */
  description: string;
  /** 激活所需的最低 divinity（架构 §八 8.2，法则级 ≥5） */
  divinityThreshold: DivinityLevel;
  /** Override 载荷（M1 不精确收窄，M4 起按 key 定型） */
  payload: unknown;
}

/** closed RuleKey 钥匙串。M1 只注册 1 把。 */
export type RuleKey =
  'terminal.forceTerminal' | 'morale.forceState' | 'action.freezeSlot' | 'death.threshold';

/** M1 已注册的 RuleKey 注册表（其余 M4 补）。 */
export const RULE_KEYS: Readonly<Record<RuleKey, RuleKeySpec | undefined>> = {
  'terminal.forceTerminal': {
    description: '概念级终局，非 HP 清空判胜（第 09 场认知剥夺）',
    divinityThreshold: 5,
    payload: { reason: 'string', winner: 'string' },
  },
  'morale.forceState': undefined,
  'action.freezeSlot': undefined,
  'death.threshold': undefined,
};

/**
 * Override 解析结果（M1 恒为 not-supported，因为只有 forceTerminal 一把锁，
 * 且 M1 的内核 override 走内部 forceTerminal 而非 Adjudicate 进这里）。
 */
export type OverrideResult =
  { kind: 'applied'; detail: string } | { kind: 'rejected'; reason: string };

/**
 * 解析一次 RuleKey override（架构 §八，M1 空转）。
 *
 * M1 范围：只有内核内部触发的 forceTerminal（phases/terminal.ts checkTerminal），
 * 不经过 Adjudicate 提交，故这里只做注册表存在性检查，并验证 divinity 门槛。
 * 真正的 divinity 压制与 AdjudicationAccepted 由 M3.5/§6.5 接。
 */
export function resolveOverride(key: RuleKey, divinity: number, _payload: unknown): OverrideResult {
  const spec = RULE_KEYS[key];
  if (!spec) {
    return { kind: 'rejected', reason: `RuleKey「${key}」未注册（M1 仅 terminal.forceTerminal）` };
  }
  if (divinity < spec.divinityThreshold) {
    return {
      kind: 'rejected',
      reason: `divinity ${divinity} < 门槛 ${spec.divinityThreshold}（法则级）`,
    };
  }
  return { kind: 'applied', detail: `RuleKey「${key}」已解析` };
}

/**
 * 检查一个 terminal.forceTerminal 是否被允许（内核内部触发用，A1-6 forceTerminal 出口）。
 * M1：只要 registry 注册且 divinity ≥ 门槛即可。
 */
export function canForceTerminal(divinity: number): boolean {
  const spec = RULE_KEYS['terminal.forceTerminal'];
  return !!spec && divinity >= spec.divinityThreshold;
}
