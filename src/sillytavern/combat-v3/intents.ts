/**
 * combat-v3/intents.ts — EffectIntent 验证 + 解释执行（批原子性，M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §六 6.3（intent batch 原子性）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.5 / §5.8
 *
 * `validateBatch(batch, ctx)`：batch 内**任一** intent 非法 ⇒ 整批 reject + 产 EffectRejected。
 *  code 枚举（架构 §6.3）：TARGET_ILLEGAL / DIVINITY_INSUFFICIENT / RESOURCE_INSUFFICIENT /
 *  CHARGE_EXHAUSTED / VALUE_OUT_OF_RANGE / INVARIANT_VIOLATION / UNSUPPORTED_CAPABILITY /
 *  EVAL_ERROR / BUDGET_EXCEEDED。
 *
 * `applyIntents(state, intents)`：把通过验证的 intent 应用到 pendingChanges（一次 Command 末尾原子提交）。
 *
 * **不取消**合法的核心攻击，也不取消同窗口其他 automaton 的合法 batch（A3-7）——
 * 本模块只对单个 batch 做原子拒绝。
 *
 * 铁律：零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { CombatState, EffectRejectCode, EffectIntent, PendingChangeSet } from './types';
import { resolveReflection, REFLECTION_ANNIHILATION_CUE } from './automata/reflection';
import type { DamageCtx } from './types';

/** 单条 intent 验证结果（可通过 or 拒绝） */
export type IntentValidation = { ok: true } | { ok: false; code: EffectRejectCode; detail: string };

/** 整个 batch 的验证结果 */
export type BatchValidation =
  | { ok: true; intents: readonly EffectIntent[] }
  | { ok: false; code: EffectRejectCode; detail: string; rejectedIntents: readonly EffectIntent[] };

/** 供 applyIntents 使用的求值上下文快照（target 在场/资源） */
export interface IntentApplyCtx {
  state: CombatState;
  automatonOwner: string;
  /** 当前 automaton 的 charges（可能随 ConsumeCharge 递减） */
  charges?: { max: number; remaining: number };
  /** 解析表达式（amount='ctx.damage.final*0.1'）——M3 用注入的解析器闭包避免循环依赖 */
  resolveNumber: (expr: string, fallback: number) => number;
  /** 目标在场检查 */
  present: (unitId: string) => boolean;
  /** 当前反射链的伤害上下文（取 preReduction 为基准，架构 §九 R4）；缺省无反射 */
  reflectBase?: Pick<DamageCtx, 'preReduction' | 'final'>;
  /** 当前反射深度（架构 §九 R6，缺省 0） */
  reflectDepth?: number;
  /** 反伤百分比（如 0.3 = 30%）；有 reflectBase 时用于 ScheduleIntent 反伤解析 */
  reflectRatio?: number;
}
// ──────────────────────────────────────────────────────────────────────────────
// validateBatch —— 批原子性（A3-7）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 校验整个 intent batch。任一非法 ⇒ 整批拒绝 + EffectRejected。
 *
 * 合法的核心攻击与同窗口其他 automaton 不受影响（A3-7）——本函数只返回本 batch 的
 * 验证结果，不接触外部状态。
 */
export function validateBatch(batch: readonly EffectIntent[]): BatchValidation {
  for (const intent of batch) {
    const r = validateOne(intent);
    if (!r.ok) {
      return { ok: false, code: r.code, detail: r.detail, rejectedIntents: [...batch] };
    }
  }
  return { ok: true, intents: [...batch] };
}

/** 单条 intent 合法性（范围内静态检查；运行时目标在场/资源在 applyIntents 兜底） */
function validateOne(intent: EffectIntent): IntentValidation {
  switch (intent.kind) {
    case 'DealDamage': {
      if (!intent.targetId)
        return { ok: false, code: 'TARGET_ILLEGAL', detail: 'DealDamage.targetId 为空' };
      return { ok: true };
    }
    case 'Heal': {
      const amt = intent.amount;
      if (typeof amt === 'number' && amt < 0) {
        return {
          ok: false,
          code: 'VALUE_OUT_OF_RANGE',
          detail: 'Heal.amount 不得为负（负伤害 ≠ 治疗）',
        };
      }
      return { ok: true };
    }
    case 'SpendResource': {
      const amt = intent.amount;
      if (typeof amt === 'number' && amt < 0) {
        return { ok: false, code: 'VALUE_OUT_OF_RANGE', detail: 'SpendResource.amount 不得为负' };
      }
      return { ok: true };
    }
    case 'ApplyStatus':
      if (!intent.targetId)
        return { ok: false, code: 'TARGET_ILLEGAL', detail: 'ApplyStatus.targetId 为空' };
      return { ok: true };
    case 'RemoveStatus':
      if (!intent.targetId)
        return { ok: false, code: 'TARGET_ILLEGAL', detail: 'RemoveStatus.targetId 为空' };
      return { ok: true };
    case 'PreventDeath':
      if (!intent.targetId)
        return { ok: false, code: 'TARGET_ILLEGAL', detail: 'PreventDeath.targetId 为空' };
      return { ok: true };
    case 'ConsumeCharge':
      if (intent.amount !== undefined && typeof intent.amount === 'number' && intent.amount < 0) {
        return { ok: false, code: 'CHARGE_EXHAUSTED', detail: 'ConsumeCharge.amount 不得为负' };
      }
      return { ok: true };
    case 'AddModifier':
      return { ok: true };
    case 'EmitNarrativeCue':
      return { ok: true };
    case 'OverrideIntent':
      return { ok: true };
    case 'ScheduleIntent':
      // 递归校验内部 intent
      return validateOne(intent.intent);
    case 'SpawnOrDespawnIntent':
      return { ok: true };
    case 'RequestChoiceIntent': {
      if (!intent.choiceId)
        return {
          ok: false,
          code: 'INVARIANT_VIOLATION',
          detail: 'RequestChoiceIntent.choiceId 为空',
        };
      return { ok: true };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// applyIntents —— 把已验证 intent 应用到 pendingChanges（一次原子提交）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把一批通过验证（validateBatch ok）的 intent 应用到阶段性的 PendingChangeSet。
 *
 * 注意：本函数**不施加不变量（HP clamp / 槽位核销）**——那些由 phase 末尾 applyPending
 * 统一完成。这里只把 intent → pending 数值字段（hp/mp/sp/fp/statusPatches/...）。
 *
 * 返回 { changes, consumedCharge, spawnRequests }：
 *   - changes: 可并入 phase 的 PendingChangeSet
 *   - consumedCharge: 是否消耗了一次 automaton charge
 *   - events: 附带产生的叙事/事件意图（如 EmitNarrativeCue）
 */
export function applyIntents(
  ctx: IntentApplyCtx,
  intents: readonly EffectIntent[],
  base: PendingChangeSet,
): {
  changes: PendingChangeSet;
  consumedCharge: boolean;
  narrative: readonly string[];
} {
  let consumedCharge = false;
  const narrative: string[] = [];

  for (const intent of intents) {
    const collected = applyOne(ctx, intent, base);
    if (collected.narrative) narrative.push(...collected.narrative);
    if (collected.consumedCharge) consumedCharge = true;
  }
  return { changes: base, consumedCharge, narrative };
}

/** 单条 intent 应用结果（累计变更直接写 base） */
interface ApplyOneResult {
  narrative: readonly string[];
  consumedCharge: boolean;
}

/**
 * 逐条应用 intent（就地累积到 base）。
 */
function applyOne(
  ctx: IntentApplyCtx,
  intent: EffectIntent,
  base: PendingChangeSet,
): ApplyOneResult {
  switch (intent.kind) {
    case 'AddModifier':
      // AddModifier 不进 pending 变更集——它是"修饰"，由 windows 收集后并入管线入参。
      return { narrative: [], consumedCharge: false };
    case 'DealDamage': {
      const target = intent.targetId;
      if (!ctx.present(target)) return { narrative: [], consumedCharge: false };
      const amt = coerceAmount(ctx, intent.amount, 0);
      base.hpChanges[target] = (base.hpChanges[target] ?? 0) - amt;
      return { narrative: [], consumedCharge: false };
    }
    case 'Heal': {
      const target = intent.targetId;
      if (!ctx.present(target)) return { narrative: [], consumedCharge: false };
      const amt = coerceAmount(ctx, intent.amount, 0);
      base.hpChanges[target] = (base.hpChanges[target] ?? 0) + amt;
      return { narrative: [], consumedCharge: false };
    }
    case 'SpendResource': {
      const target = intent.targetId;
      if (!ctx.present(target)) return { narrative: [], consumedCharge: false };
      if (intent.resource === 'fp') {
        base.fpDelta += -intent.amount;
      } else {
        const field =
          intent.resource === 'mp'
            ? base.mpChanges
            : intent.resource === 'sp'
              ? base.spChanges
              : base.hpChanges;
        field[target] = (field[target] ?? 0) - intent.amount;
      }
      return { narrative: [], consumedCharge: false };
    }
    case 'ApplyStatus': {
      const target = intent.targetId;
      if (!ctx.present(target)) return { narrative: [], consumedCharge: false };
      base.statusPatches.push({
        op: 'apply',
        unitId: target,
        status: {
          name: intent.statusId,
          description: '',
          category: '增益',
          stacks: intent.layers ?? 1,
          remainingTime: intent.duration,
          timeUnit: '回合',
          source: `[效果]-[${ctx.automatonOwner}]`,
          effects: {},
          lifecycle: '战斗',
        },
      });
      return { narrative: [], consumedCharge: false };
    }
    case 'RemoveStatus': {
      const target = intent.targetId;
      if (!ctx.present(target)) return { narrative: [], consumedCharge: false };
      base.statusPatches.push({ op: 'remove', unitId: target, statusId: intent.statusId });
      return { narrative: [], consumedCharge: false };
    }
    case 'ConsumeCharge':
      return { narrative: [], consumedCharge: true };
    case 'EmitNarrativeCue':
      return { narrative: [intent.text], consumedCharge: false };
    case 'ScheduleIntent': {
      // 延迟意图：若内部是反伤 DealDamage(isReaction) 且有反射基准，则按 §九 解析
      const inner = intent.intent;
      if (inner.kind === 'DealDamage' && inner.isReaction && ctx.reflectBase !== undefined) {
        const ratio = ctx.reflectRatio ?? 0;
        if (ratio <= 0) return { narrative: [], consumedCharge: false };
        const res = resolveReflection(ctx.reflectDepth ?? 0, ctx.reflectBase, ratio);
        if (res.kind === 'mutual_cancel') {
          // R6 熔断：双方本链反伤互相抵消 + 湮灭叙事
          return { narrative: [REFLECTION_ANNIHILATION_CUE], consumedCharge: false };
        }
        // R1/R7：反伤命中（R8 命中骰由 windows 层负责消费 dice），
        // doesNotConsumeSlot 天然不进槽位（只写 hpChanges）
        base.hpChanges[inner.targetId] =
          (base.hpChanges[inner.targetId] ?? 0) - res.reflectedAmount;
        return { narrative: [], consumedCharge: false };
      }
      return { narrative: [], consumedCharge: false };
    }
    case 'PreventDeath':
    case 'SpawnOrDespawnIntent':
    case 'RequestChoiceIntent':
      // M3 范围：这些要么由 damage.preview 单独处理（RequestChoice），要么 M4 实现。
      return { narrative: [], consumedCharge: false };
    default:
      return { narrative: [], consumedCharge: false };
  }
}

/** 把 intent 的 amount/value（字面量或表达式串）解析为数字 */
function coerceAmount(ctx: IntentApplyCtx, v: number | string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return Number(v);
    // 表达式串（如 'ctx.damage.final * 0.1'）→ 注入的解析器
    return ctx.resolveNumber(v, dflt);
  }
  return dflt;
}
