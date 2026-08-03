/**
 * combat-v3/windows.ts — ReactionWindow evaluator（M3 实装）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §五（ReactionWindow 清单）
 *   - 求值顺序 §5.3：window phase → divinity → priority → stable id（索引已排序）
 *   - 在场过滤 §5.4：automaton owner 不在 state.units 或已 defeated ⇒ 跳过
 *   - 错误隔离 §5.4：单个 automaton 求值抛错 ⇒ 该 automaton 整批 intent 作废 + EffectRejected
 *   - 递归保护 §5.4/§九：窗口递归 ≤5；反射深度 ≤2
 *   - 求值预算 §5.4：单窗口 ≤64，超出截断 + EffectRejected(BUDGET_EXCEEDED)
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.6
 *
 * M1 空转版签名冻结，M3 改为实装。返回 { intents, rejections }：
 *   - intents：通过批验证的 automaton intent 聚合（phase 收集后并入管线）
 *   - rejections：因错误隔离 / 批非法 / 预算超限产出的 EffectRejected 事件
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type {
  ActiveEffectIndex,
  CombatState,
  CombatUnitState,
  CompiledAutomaton,
  DomainEvent,
  EffectIntent,
  EffectRejectCode,
  QueuedAutomaton,
  UnitCtx,
  WindowCtx,
  WindowKey,
} from './types';
import { MAX_AUTOMATON_PER_WINDOW, MAX_REFLECTION_DEPTH } from './types';
import { evaluate, ExprEvalError } from './automata/interpreter';
import { parseExpression } from './automata/parser';
import { validateBatch } from './intents';

/** 单窗口求值结果 */
export interface WindowEvaluation {
  /** 通过批验证的全部 automaton intent 聚合（含内部 Schedule 的展开） */
  intents: readonly RawIntent[];
  /** 错误隔离 / 批非法 / 预算超限产生的 EffectRejected 事件 */
  rejections: readonly DomainEvent[];
}

/** 原始收集的 intent（带所属 automaton 元数据，供 phase 判断是谁的） */
export interface RawIntent {
  automatonId: string;
  owner: string;
  intents: readonly EffectIntent[];
}

/** 从 index 里取某窗口已按求值顺序排好序的队列 */
export function queuedFor(index: ActiveEffectIndex, key: WindowKey): readonly QueuedAutomaton[] {
  return index.byWindow[key] ?? [];
}

/**
 * 检查某窗口是否有订阅者（架构 §五 5.2 约束 3：无订阅者跳过，不打断节奏）。
 * damage.preview 等暂停窗口借此判断要不要暂停。
 */
export function hasSubscribers(index: ActiveEffectIndex, key: WindowKey): boolean {
  return (index.byWindow[key] ?? []).length > 0;
}

/**
 * 窗口求值运行时上下文：窗口分型 ctx + 内核提供的状态访问器。
 *
 * 由调用方（phases/attack / reducer）构造，注入 resolver：
 *   - present(unitId)：目标/持有者是否在场且未 defeated（在场过滤）
 *   - resolveNumber(expr, fallback)：把 intent 里的表达式串解析为数字
 *   - resolveChoice(text)：把 RequestChoiceIntent 的 prompt/选项等模板文本解析为具体值（M3 暂恒等）
 *   - depthBase：当前窗口递归深度（反射链用）
 */
export interface RuntimeWindowCtx<K extends WindowKey> {
  /** 窗口分型的语境 */
  ctx: WindowCtx<K>;
  present: (unitId: string) => boolean;
  resolveNumber: (expr: string, fallback: number) => number;
  /** 每个 automaton 是否已耗尽次数 */
  chargesAvailable: (a: CompiledAutomaton) => boolean;
  /** 当前递归深度（反射链；默认 0） */
  depthBase?: number;
  /** automaton 抛错时的兜底（把错误并入 rejections）——M3 传 reject 收集器 */
  onError?: (a: CompiledAutomaton, err: unknown) => DomainEvent;
}

/**
 * 求值一个 ReactionWindow（M3 实装）。
 *
 * 对窗口内每条 automaton（已按 §5.3 排序）：
 *   1. 在场过滤：owner 不在场/defeated ⇒ 跳过
 *   2. charges 耗尽 ⇒ 跳过
 *   3. 求值 trigger（evaluate triggerAst）——抛错 ⇒ 整批作废 + EffectRejected
 *   4. trigger 为真 ⇒ 对 intent batch validateBatch：
 *        - 非法 ⇒ 整批 reject + EffectRejected（A3-7）
 *        - 合法 ⇒ applyIntents 收集到返回集
 *   5. 错误隔离：单个 automaton 抛错不影响其他
 *   6. 预算 64：超过按求值顺序截断 + EffectRejected(BUDGET_EXCEEDED)
 */
export function evaluateWindow<K extends WindowKey>(
  index: ActiveEffectIndex,
  key: WindowKey,
  rt: RuntimeWindowCtx<K>,
): WindowEvaluation {
  const queue = index.byWindow[key] ?? [];
  const intents: RawIntent[] = [];
  const rejections: DomainEvent[] = [];

  // 预算（架构 §五 5.4）：单窗口 ≤64；超出按求值顺序截断
  const budgetCap = MAX_AUTOMATON_PER_WINDOW;
  let budgetRejected = false;

  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    // 预算：前 64 条照常求值，第 65 条起截断 + EffectRejected(BUDGET_EXCEEDED)
    if (i >= budgetCap) {
      if (!budgetRejected) {
        rejections.push(
          makeReject(a, 'BUDGET_EXCEEDED', `窗口预算 ${budgetCap} 已耗尽，本 automaton 被截断`),
        );
        budgetRejected = true;
      }
      continue;
    }

    // 在场过滤（架构 §五 5.4）：owner 不在场/defeated ⇒ 跳过
    if (!rt.present(a.owner)) continue;
    // charges 耗尽
    if (a.charges && !rt.chargesAvailable(a)) continue;

    // trigger 求值（抛错 ⇒ 错误隔离）
    let condition: boolean;
    try {
      condition = evaluate(a.triggerAst, rt.ctx as WindowCtx<WindowKey>) ? true : false;
    } catch (e) {
      rejections.push(makeReject(a, 'EVAL_ERROR', e instanceof Error ? e.message : String(e)));
      continue;
    }
    if (!condition) continue;

    // intent batch 原子性（A3-7）
    const v = validateBatch(a.intents);
    if (!v.ok) {
      rejections.push(makeReject(a, v.code, v.detail));
      continue;
    }

    intents.push({ automatonId: a.id, owner: a.owner, intents: v.intents });
  }

  return { intents, rejections };
}

/**
 * 窗口求值的**唯一推荐调用形态**（Q-07 步骤 2）。
 *
 * `evaluateWindow` 返回 `{ intents, rejections }`，而历史上 12 个调用点里有 7 个直接
 * 丢弃整个返回值 —— 于是 effect intents **和** `EffectRejected` 诊断一起静默消失：
 * 作者写的 automaton 过了全部编译校验、进了索引、tooltip 里也显示，然后什么都不做，
 * 没有日志、没有 rejection、没有测试。排查一次要烧掉一天。
 *
 * `runWindow` 把「rejections 必须落进 out.events」变成调用形态的一部分：暂时消费不了
 * intents 的窗口写成一行 `runWindow(events, ...)` 忽略返回值 —— 那是**可见的** TODO，
 * 而不是藏起来的丢弃。
 *
 * @param out 该阶段的 DomainEvent 收集数组（rejections 直接 push 进去）
 * @returns 本窗口产出的 intent 批次（调用方可消费，也可显式忽略）
 */
export function runWindow<K extends WindowKey>(
  out: DomainEvent[],
  index: ActiveEffectIndex,
  key: WindowKey,
  rt: RuntimeWindowCtx<K>,
): readonly RawIntent[] {
  const evaluation = evaluateWindow(index, key, rt);
  out.push(...evaluation.rejections);
  return evaluation.intents;
}

/** 构造一条 EffectRejected 事件 */
function makeReject(a: QueuedAutomaton, code: EffectRejectCode, detail: string): DomainEvent {
  return {
    kind: 'EffectRejected',
    automatonId: a.id,
    window: a.subscribe,
    owner: a.owner,
    code,
    detail,
  } as DomainEvent;
}

/**
 * 从 CombatState + 触发来源构造一个最小 RuntimeWindowCtx（供 phases 调用 evaluateWindow）。
 *
 * 这是 M1「窗口调用点全部就位」的适配层：phases 只需传 selfId / targetId / round，
 * 本函数负责构建窗口分型的 ctx + 注入 state 访问器（present / charges / resolveNumber）。
 *
 * 表达式解析（M4）：intent 里的 `ctx.*` 字符串表达式（如反伤 amount
 * `'ctx.damage.preReduction * 0.5'`）先 `parseExpression` 编译成 AST，再 `evaluate`
 * 于**带真实伤害覆盖**的窗口 ctx 上解析为数字。本层 resolveNumber 兼任 intent 数值
 * 表达式的求值入口（供 applyIntents 的 coerceAmount 复用）。求值失败（语法错 /
 * 路径未定义 / 类型不可算）一律回退 fallback，**不抛出**（错误隔离语义，保守）。
 */
export function makeWindowRuntimeCtx(
  state: CombatState,
  opts: {
    selfId?: string;
    targetId?: string;
    round: number;
    window: WindowKey;
    /** M4：本窗口的伤害覆盖（damage.after / unit.beforeDown 等伤害窗口传真实 preReduction/postStep6/final） */
    damage?: Partial<DamageCtxLike>;
    /**
     * 反应嵌套深度（Q-07）。此前写死 0，任何读 `ctx.depth` 的触发表达式恒见 0 ——
     * 「只在第一层反应里触发」这类条件写了等于没写。反伤链等嵌套求值应逐层 +1。
     */
    depth?: number;
    /**
     * 本 automaton 的剩余 charges（Q-07）。此前写死 0，读 `ctx.charges.remaining`
     * 的表达式恒见 0（即「还剩几次」永远是「零次」）。
     */
    chargesRemaining?: number;
  },
): RuntimeWindowCtx<WindowKey> {
  const selfU = opts.selfId ? state.units[opts.selfId] : undefined;
  const targetU = opts.targetId ? state.units[opts.targetId] : undefined;

  const unitCtx = (u: CombatUnitState | undefined, fallbackId: string): UnitCtx => ({
    id: u?.id ?? fallbackId,
    hp: u?.hp ?? 0,
    maxHp: u?.maxHp ?? 0,
    hpPercent: u && u.maxHp > 0 ? u.hp / u.maxHp : 0,
    mp: u?.mp ?? 0,
    sp: u?.sp ?? 0,
    tier: u?.tier ?? 1,
    divinity: u?.ability?.divinity ?? 0,
    statuses: (u?.statusEffects ?? []).map((s) => s.name),
  });

  const self = unitCtx(selfU, opts.selfId ?? '');
  const target = unitCtx(targetU, opts.targetId ?? '');
  const round = { index: state.round, phase: state.phase };

  const base: WindowCtx<WindowKey> = {
    self,
    target,
    round,
    depth: opts.depth ?? 0,
    charges: { remaining: opts.chargesRemaining ?? 0 },
    damage: {
      attackerId: opts.selfId ?? '',
      targetId: opts.targetId ?? '',
      preReduction: opts.damage?.preReduction ?? 0,
      postStep6: opts.damage?.postStep6 ?? 0,
      final: opts.damage?.final ?? 0,
      type: opts.damage?.type ?? '物理',
      rating: opts.damage?.rating ?? '有效',
    },
  } as WindowCtx<WindowKey>;

  return {
    ctx: base,
    present: (unitId) => {
      const u = state.units[unitId];
      return !!u && u.hp > 0;
    },
    resolveNumber: (expr, fallback) => resolveNumberExpr(expr, base, fallback),
    chargesAvailable: (a) => !a.charges || a.charges.remaining > 0,
    depthBase: 0,
  };
}

/**
 * 解析一个数值表达式串（字面量或 `ctx.*` 表达式）为数字。
 *
 * - 数字字面量（含整数串）→ 直接返回
 * - 表达式串 → parseExpression → evaluate 于窗口 ctx（伤害值已在 base.damage）
 * - 任何求值失败 → 回退 fallback（不抛出，错误隔离）
 *
 * exporter：供 applyIntents 构造 IntentApplyCtx.resolveNumber 以及攻击接线层复用，
 * 保证「amount='ctx.damage.preReduction * 0.5'」这类表达式能被同一套解析器算出来。
 */
export function resolveNumberExpr(
  expr: string,
  ctx: WindowCtx<WindowKey>,
  fallback: number,
): number {
  const direct = Number(expr);
  if (typeof expr === 'string' && Number.isFinite(direct)) return direct;
  try {
    const ast = parseExpression(expr);
    const v = evaluate(ast, ctx);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    // ExprSyntaxError / ExprEvalError —— 保守回退 fallback（错误隔离，不抛出）
    return fallback;
  }
}

/** DamageCtx 子集（供 damage 覆盖类型，避免把完整 DamageCtx 依赖进本文件造成类型发散） */
interface DamageCtxLike {
  preReduction: number;
  postStep6: number;
  final: number;
  type: string;
  rating: string | number;
}

/** 反射深度 > MAX → 该 automaton 的反伤不再触发（架构 §九 R6） */
export function reflectionDepthAt(depthBase: number | undefined): number {
  return depthBase ?? 0;
}
export function reflectionExhausted(depth: number): boolean {
  return depth >= MAX_REFLECTION_DEPTH;
}
