/**
 * combat-v3/automata/compile.ts — EffectProgram 编译链 + 编译期校验（M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §七 7.4（EffectProgram 编译链 D3）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.5（9 条校验）/ §5.6
 *
 * `compileEffectProgram(entity)`：把一份效果源（物品/技能/buff 定义）编译为：
 *   - automata: CompiledAutomaton[]（合格才进；不合规 → **编译期剔除**，运行时不见，A3-3）
 *   - staticModifiers: StaticModifier[]（纯数值修正，不走窗口，直接并入结算）
 *   - errors: CompileError[]（每条被剔除 automaton 的错误）
 *
 * 三来源（架构 §七 7.4）：
 *   ① modifiers[]（六大类别）→ 订阅 collect_*_mods、返回 ModifierIntent 的 push-handler automaton（ADR-29）
 *   ② ParsedEffect（effect-parser 中文词条）→ 经内建映射表编译为可信 TS adapter（builtins.ts）
 *   ③ AI 产的自由效果（automaton JSON）→ DSL automaton + 编译期校验
 *
 * 9 条编译期校验（plan §5.5，逐条对不合规**剔除** + errors.push；#6 #9 clamp/warn 不剔除）：
 *   1. subscribe ∈ 18 窗口清单
 *   2. trigger 表达式文法合规（带列号）
 *   3. intents[].kind ∈ 8 大类
 *   4. OverrideIntent.ruleKey ∈ closed RuleKey 白名单
 *   5. divinity ≤ 所有者装备/技能声明的 divinity
 *   6. 数值范围按品质上限 clamp（warn 不剔除）
 *   7. ctx.* 路径根段 ∈ WindowCtxMap[subscribe] 的键集
 *   8. 五维直改检测（五维只能走检定修正）
 *   9. buff id 带上级前缀（warn + 自动补前缀）
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import { parseExpression, ExprSyntaxError } from './parser';
import { windowCtxRoots } from './interpreter';
import { compileParsedEffect } from './builtins';
import type {
  CompiledAutomaton,
  CompileError,
  EffectAutomaton,
  EffectIntent,
  ExprAst,
  ModifierSlot,
  StaticModifier,
  WindowKey,
} from '../types';
import {
  validateModifier,
  V3_WINDOW_KEYS,
  V3_INTENT_KINDS,
  V3_RULE_KEYS,
} from '../../combat-item-validator';
import type { Modifier } from '../../effect-types';
import { parseEffectDeclaration } from '../../effect-parser';
import type { ParsedEffect } from '../../types';

// ──────────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────────

/** 18 个合法窗口（架构 §五 5.1）——委托 combat-item-validator 共享常量 */
const VALID_WINDOWS: ReadonlySet<string> = V3_WINDOW_KEYS;

/** closed RuleKey 白名单（架构 §八 8.2 / plan §5.5 #4） */
const VALID_RULE_KEYS: ReadonlySet<string> = V3_RULE_KEYS;

/** 八大类合法 intent kind（架构 §六 6.1 / plan §5.5 #3） */
const VALID_INTENT_KINDS: ReadonlySet<string> = V3_INTENT_KINDS;

/** 五维英文别名（校验 #8：非检定类不得直接改五维） */
const FIVE_DIM: ReadonlySet<string> = new Set(['str', 'dex', 'con', 'int', 'spi']);

/** 编译产物 */
export interface CompiledProgram {
  automata: readonly CompiledAutomaton[];
  staticModifiers: readonly StaticModifier[];
  errors: readonly CompileError[];
}

/**
 * 编译一份效果源。
 *
 * @param entity 效果源定义（物品/技能）。含可选：
 *   - modifiers?: Modifier[]（六大类别）
 *   - effects?: string（effect-parser 中文词条串）
 *   - automata?: EffectAutomaton[]（AI 产的自由效果 JSON）
 *   - owner / source / idPrefix / divinity / buffs?
 * @returns { automata, staticModifiers, errors }
 */
export function compileEffectProgram(entity: {
  owner?: string;
  source?: string;
  idPrefix?: string;
  divinity?: number;
  modifiers?: readonly unknown[];
  effects?: string;
  automata?: readonly EffectAutomaton[];
  buffs?: readonly unknown[];
}): CompiledProgram {
  const owner = entity.owner ?? 'unit';
  const source = entity.source ?? entity.idPrefix ?? 'item';
  const seed = {
    owner,
    source,
    idPrefix: entity.idPrefix ?? 'item',
    divinity: entity.divinity ?? 0,
  };

  const automata: CompiledAutomaton[] = [];
  const staticModifiers: StaticModifier[] = [];
  const errors: CompileError[] = [];

  // ── ① modifiers[] → push-handler automaton（ADR-29） ──
  for (const rawMod of entity.modifiers ?? []) {
    const modIssues = validateModifier(rawMod);
    if (modIssues.length > 0) {
      errors.push({
        automatonId: `${source}.modifier`,
        code: 'WINDOW_NOT_FOUND',
        message: `modifier 不合规：${modIssues.join('；')}`,
      });
      continue;
    }
    const mod = rawMod as unknown as Modifier;
    const compiled = compileModifierPushHandler(mod, seed);
    if (compiled) automata.push(compiled);
  }

  // ── ② ParsedEffect（effect-parser 中文词条）→ 内建 adapter ──
  if (entity.effects) {
    const parsedList = parseEffectDeclaration(entity.effects);
    for (const parsed of parsedList) {
      const builtin = compileParsedEffect(parsed, seed);
      if (builtin) {
        automata.push(builtin);
      } else if (parsed.key !== 'charges') {
        // 不匹配任何内建 → UnsupportedCapability（架构 §六 6.4）
        errors.push({
          automatonId: `${source}.${parsed.key}`,
          code: 'UNSUPPORTED_CAPABILITY',
          message: `无法编译内建词条「${parsed.rawKey}」（key=${parsed.key}）`,
        });
      }
    }
  }

  // ── ③ AI 产的自由效果（automaton JSON）→ 编译期校验 ──
  for (const a of entity.automata ?? []) {
    const { automation, mergeErrors } = runDslWithErrors(a, seed);
    errors.push(...mergeErrors);
    if (automation) automata.push(automation);
  }

  return { automata, staticModifiers, errors };
}

/**
 * 包装 compileDslAutomaton：把其 messages（剔除错误 + warn）统一合并进外层 errors。
 */
function runDslWithErrors(
  a: EffectAutomaton,
  seed: { owner: string; source: string; idPrefix: string; divinity: number },
): { automation: CompiledAutomaton | null; mergeErrors: CompileError[] } {
  const { automaton, messages } = compileDslAutomaton(a, seed);
  return { automation: automaton, mergeErrors: messages };
}

// ──────────────────────────────────────────────────────────────────────────────
// ① modifier → push-handler automaton
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把一个六大类别 modifier 编译为 push-handler automaton（ADR-29：modifier 非第二套系统）。
 *
 * 返回 `collect_attacker_mods` / `collect_defender_mods`（或对应窗口）的 AddModifier automaton，
 * 或 static validator 判定为纯属性时并入 staticModifiers。
 */
function compileModifierPushHandler(
  mod: Modifier,
  seed: { owner: string; source: string; idPrefix: string; divinity: number },
): CompiledAutomaton | null {
  const { category } = mod;
  const base: CompiledAutomaton = {
    id: `${seed.idPrefix}.${seed.source}.${category}`,
    name: seed.source,
    source: seed.source,
    owner: seed.owner,
    subscribe: 'collect_attacker_mods',
    priority: 0,
    divinity: seed.divinity,
    stableId: `${seed.idPrefix}.${seed.source}.${category}`,
    triggerAst: { t: 'bool', v: true },
    intents: [] as EffectIntent[],
    isAdapter: true,
  };
  const div = seed.divinity;

  switch (category) {
    case '固伤': {
      const m = mod as Extract<Modifier, { category: '固伤' }>;
      return {
        ...base,
        subscribe: 'collect_attacker_mods',
        intents: [
          {
            kind: 'AddModifier',
            slot: 'fixedDamage',
            value: m.amount,
            scope: 'whole_action',
            targetId: seed.owner,
            divinity: div,
          },
        ],
      };
    }
    case '百分比': {
      const m = mod as Extract<Modifier, { category: '百分比' }>;
      if (m.target === 'damage') {
        return {
          ...base,
          subscribe: 'collect_attacker_mods',
          intents: [
            {
              kind: 'AddModifier',
              slot: 'damageMult',
              value: m.coefficient,
              scope: 'whole_action',
              targetId: seed.owner,
              divinity: div,
            },
          ],
        };
      }
      // heal/resource 暂不进管线（M3 范围限于伤害侧）
      return null;
    }
    case '资源': {
      const m = mod as Extract<Modifier, { category: '资源' }>;
      return {
        ...base,
        subscribe: 'round.open',
        intents: [
          {
            kind: m.resource === 'hp' ? 'Heal' : 'SpendResource',
            targetId: seed.owner,
            amount: m.amount,
          } as EffectIntent,
        ],
      };
    }
    case '检定': {
      const m = mod as Extract<Modifier, { category: '检定' }>;
      const slotMap: Record<string, 'hitBonus' | 'dodge' | 'initiative' | 'attribute'> = {
        命中: 'hitBonus',
        闪避: 'dodge',
        先攻: 'initiative',
        抵抗: 'dodge',
        属性: 'attribute',
      };
      const subscribe: WindowKey =
        m.checkType === '先攻'
          ? 'initiative.before'
          : m.checkType === '命中' || m.checkType === '闪避' || m.checkType === '抵抗'
            ? 'check.hit'
            : 'check.hit';
      return {
        ...base,
        subscribe,
        intents: [
          {
            kind: 'AddModifier',
            slot: slotMap[m.checkType] ?? 'hitBonus',
            value: m.bonus,
            scope: 'whole_action',
            targetId: seed.owner,
            divinity: div,
          },
        ],
      };
    }
    case '附加效果': {
      const m = mod as Extract<Modifier, { category: '附加效果' }>;
      // 附加效果 → 每次战斗开始施加 buff（turn.open 挂起），带 sourceKey 前缀（校验 #9）
      const statusId = m.sourceKey ? `${m.sourceKey}.${m.buffName}` : m.buffName;
      return {
        ...base,
        subscribe: 'turn.open',
        intents: [
          {
            kind: 'ApplyStatus',
            targetId: seed.owner,
            statusId,
            duration: m.duration ?? 1,
            layers: m.stacks ?? 1,
          },
        ],
      };
    }
    case '特殊机制': {
      const m = mod as Extract<Modifier, { category: '特殊机制' }>;
      const slotMap: Record<string, ModifierSlot> = {
        DR: 'dr',
        穿透: 'penetration',
        暴击倍率: 'critDmg',
      };
      const slot = slotMap[m.mechanism];
      if (!slot) return null;
      return {
        ...base,
        subscribe: m.mechanism === 'DR' ? 'collect_defender_mods' : 'collect_attacker_mods',
        intents: [
          {
            kind: 'AddModifier',
            slot,
            value: m.value / 100,
            scope: 'whole_action',
            targetId: seed.owner,
            divinity: div,
          },
        ],
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ③ DSL automaton 编译期校验（9 条，plan §5.5）
// ──────────────────────────────────────────────────────────────────────────────

/** DSL automaton 编译结果（含累积错误） */
interface DslResult {
  automaton: CompiledAutomaton;
  errors: CompileError[];
}

/**
 * 编译并校验一个 AI automaton JSON。
 * 任一**致命**校验失败 ⇒ 剔除（返回 { automaton: null }），对应 CompileError 在 messages。
 * warn 级（#6 clamp / #9 前缀）不剔除，automaton 返回 + messages 带 warn。
 */
function compileDslAutomaton(
  a: EffectAutomaton,
  seed: { owner: string; source: string; idPrefix: string; divinity: number },
): { automaton: CompiledAutomaton | null; messages: CompileError[] } {
  const messages: CompileError[] = [];
  const owner = a.owner ?? seed.owner;

  // 校验 #1：subscribe ∈ 18 窗口
  if (!VALID_WINDOWS.has(a.subscribe)) {
    messages.push({
      automatonId: a.id,
      code: 'WINDOW_NOT_FOUND',
      message: `subscribe「${a.subscribe}」不在 18 窗口清单内`,
    });
    return { automaton: null, messages };
  }
  const subscribe = a.subscribe as WindowKey;

  // 校验 #2：trigger 表达式文法合规（带列号）
  let triggerAst: ExprAst;
  try {
    triggerAst = parseExpression(a.trigger);
  } catch (e) {
    const syntax = e as ExprSyntaxError;
    messages.push({
      automatonId: a.id,
      code: 'TRIGGER_SYNTAX',
      message: `trigger 表达式语法错误：${syntax.message}`,
    });
    return { automaton: null, messages };
  }

  // 校验 #7：ctx.* 路径根段 ∈ WindowCtxMap[subscribe] 的键集
  const allowedRoots = new Set(windowCtxRoots(subscribe));
  const ctxRootError = checkCtxRoots(triggerAst, allowedRoots);
  if (ctxRootError) {
    messages.push({ automatonId: a.id, code: 'CTX_PATH_ILLEGAL', message: ctxRootError });
    return { automaton: null, messages };
  }

  // 校验 #5：divinity ≤ 所有者声明
  if (a.divinity > seed.divinity) {
    messages.push({
      automatonId: a.id,
      code: 'DIVINITY_EXCEEDED',
      message: `divinity ${a.divinity} 超过所有者「${seed.source}」声明 ${seed.divinity}`,
    });
    return { automaton: null, messages };
  }

  // 校验 #3/#4：intents[].kind ∈ 8 大类 + OverrideIntent.ruleKey ∈ 白名单；#8 五维直改
  const intents: EffectIntent[] = [];
  for (const intent of a.intents) {
    const intentErr = validateIntent(intent, subscribe);
    if (intentErr) {
      messages.push({ automatonId: a.id, code: intentErr.code, message: intentErr.message });
      return { automaton: null, messages };
    }
    intents.push(intent);
  }

  // 校验 #6：数值范围随品质上限 clamp（warn 不剔除）——M3 以 ±10000 为绝对护栏
  const clamped = clampOutOfRange(intents);
  if (clamped.warned) {
    messages.push({
      automatonId: a.id,
      code: 'WARN_CLAMPED',
      message: `intent 数值超护栏已 clamp（未剔除）`,
    });
  }

  // 校验 #9：buff id 带上级前缀（这里 DSL automaton 的 intent 不直接带 buff id，
  //            但注入的 ApplyStatus statusId 若裸名则自动补 owner 前缀，warn 不剔除）
  const prefixed = prefixStatusIds(clamped.intents, owner);
  if (prefixed.prefixed) {
    messages.push({
      automatonId: a.id,
      code: 'WARN_PREFIXED',
      message: `ApplyStatus 裸 id 已自动补 owner 前缀（未剔除）`,
    });
  }

  const automaton: CompiledAutomaton = {
    id: a.id,
    name: a.name,
    source: a.source ?? seed.source,
    owner,
    subscribe,
    priority: a.priority ?? 0,
    divinity: a.divinity,
    stableId: a.id,
    charges: a.charges ? { ...a.charges } : undefined,
    triggerAst,
    intents: prefixed.intents,
    isAdapter: false,
  };
  return { automaton, messages };
}

/** 校验 #9：ApplyStatus 的裸 statusId 自动补 owner 前缀（warn 不剔除） */
function prefixStatusIds(
  intents: EffectIntent[],
  owner: string,
): { intents: EffectIntent[]; prefixed: boolean } {
  let prefixed = false;
  const next = intents.map((i) => {
    if (i.kind === 'ApplyStatus' && !i.statusId.includes('.')) {
      prefixed = true;
      return { ...i, statusId: `${owner}.${i.statusId}` } as EffectIntent;
    }
    if (i.kind === 'ScheduleIntent' && i.intent.kind === 'ApplyStatus') {
      const inner = i.intent;
      if (!inner.statusId.includes('.')) {
        prefixed = true;
        return {
          ...i,
          intent: { ...inner, statusId: `${owner}.${inner.statusId}` },
        } as EffectIntent;
      }
    }
    return i;
  });
  return { intents: next, prefixed };
}

/**
 * 深层扫描 AST 收集 `ctx.X` 的根段。
 */
function collectCtxRoots(ast: ExprAst, acc: Set<string>): void {
  switch (ast.t) {
    case 'path':
      if (ast.segments.length > 0) acc.add(ast.segments[0]);
      return;
    case 'call':
      ast.args.forEach((x) => collectCtxRoots(x, acc));
      return;
    case 'unary':
      collectCtxRoots(ast.operand, acc);
      return;
    case 'bin':
      collectCtxRoots(ast.l, acc);
      collectCtxRoots(ast.r, acc);
      return;
    default:
      return;
  }
}

/** 校验 #7：AST 内 ctx 根段都在窗口允许集合内 */
function checkCtxRoots(ast: ExprAst, allowedRoots: ReadonlySet<string>): string | null {
  const used = new Set<string>();
  collectCtxRoots(ast, used);
  for (const root of used) {
    if (!allowedRoots.has(root)) {
      return `ctx.${root} 不在窗口 ${allowedRoots.size === 0 ? '（无）' : '[ ' + [...allowedRoots].join(', ') + ' ]'} 白名单内（校验#7）`;
    }
  }
  return null;
}

/** 单个 intent 校验（#3 #4 #8） */
function validateIntent(
  intent: EffectIntent,
  subscribe: WindowKey,
): { code: string; message: string } | null {
  // #3：kind ∈ 8 大类
  if (!VALID_INTENT_KINDS.has(intent.kind)) {
    return { code: 'INTENT_KIND_ILLEGAL', message: `intents[].kind「${intent.kind}」不在 8 大类` };
  }

  // #4：OverrideIntent.ruleKey ∈ closed 白名单
  if (intent.kind === 'OverrideIntent' && !VALID_RULE_KEYS.has(intent.ruleKey)) {
    return {
      code: 'RULEKEY_ILLEGAL',
      message: `OverrideIntent.ruleKey「${intent.ruleKey}」不在 closed RuleKey 白名单`,
    };
  }

  // #8：五维直改检测——ModifierSlot 不含五维（str/dex/con/int/spi），
  // 若 AI 传出非法 slot（在类型守卫下转成 string 前缀命中）则拒绝。
  // 五维只能走检定修正（AddModifier.slot='attribute' 是合法检定出口）。
  if (intent.kind === 'AddModifier') {
    const slot = String(intent.slot);
    if (slot === 'str' || slot === 'dex' || slot === 'con' || slot === 'int' || slot === 'spi') {
      return {
        code: 'FIVE_DIM_STRAIGHT',
        message: `五维只能走检定修正，不能直接 AddModifier(slot:'${slot}')`,
      };
    }
  }

  // ScheduleIntent 递归校验其内部 intent
  if (intent.kind === 'ScheduleIntent') {
    return validateIntent(intent.intent, subscribe);
  }

  return null;
}

/** 校验 #6：数值范围护栏（clamp 到 ±10000，warn 不剔除） */
function clampOutOfRange(intents: EffectIntent[]): { intents: EffectIntent[]; warned: boolean } {
  let warned = false;
  const next = intents.map((i) => {
    if (i.kind === 'AddModifier' && typeof i.value === 'number' && Math.abs(i.value) > 10000) {
      warned = true;
      return { ...i, value: Math.sign(i.value) * 10000 } as EffectIntent;
    }
    if (
      (i.kind === 'DealDamage' || i.kind === 'Heal') &&
      typeof i.amount === 'number' &&
      Math.abs(i.amount) > 10000
    ) {
      warned = true;
      return { ...i, amount: Math.sign(i.amount) * 10000 } as EffectIntent;
    }
    return i;
  });
  return { intents: next, warned };
}
