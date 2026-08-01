/**
 * combat-v3/automata/builtins.ts — 内建 adapter 注册表（M3）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §七 7.4 ②
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §5.3（15 条）
 *
 * 用途：把 effect-parser.ts 的 `ParsedEffect`（中文标准词条，如「攻击时 +N 物理伤害」）
 * 经内建映射表编译为**可信 TS adapter automaton**（不走 DSL 解释器，直接是编译好的纯
 * 函数状 automaton）。这保证 v2 六大效果类别（架构 §四 4.1）的常见词条在 v3 战斗内仍
 * 以声明式 automaton 形式生效，且**确定性可重放**。
 *
 * 每条映射断言编译结果的 window + intent kind（验收 A3-4 衍生）：
 *   - A3-4：装备带 `modifiers[]` 的物品后 `collect_attacker_mods` 收到对应 ModifierIntent
 *
 * 不匹配任何内建 ⇒ 调用方产 `UnsupportedCapability`（架构 §六 6.4，该批作废）。
 */

import type {
  CompiledAutomaton,
  EffectAutomaton,
  DamageType,
  ModifierSlot,
  WindowKey,
} from '../types';
import type { ParsedEffect } from '../../types';
import { parseExpression } from './parser';

/** ParsedEffect 编译注入的基础字段（owner / source / name / id / divinity） */
export interface BuiltinSeed {
  owner: string;
  source: string;
  name?: string;
  idPrefix?: string;
  divinity?: number;
}

function idOf(prefix: string, source: string, kind: string): string {
  return `${prefix}.${kind}.${source}`;
}

/**
 * 从 ParsedEffect 产出一个「附加效果型」automaton（附加 buff），
 * 归属于 `turn.open` / `round.open` / `round.close` 等生命周期窗口。
 */
function asAutomaton(
  seed: BuiltinSeed,
  subscribe: WindowKey,
  kindtag: string,
  trigger: string,
  intents: EffectAutomaton['intents'],
  adapter: boolean,
): CompiledAutomaton {
  const id = idOf(seed.idPrefix ?? 'item', seed.source, kindtag);
  // 编译为即时可用的 adapter automaton（isAdapter 标记：不走 DSL 解释器）
  // trigger 传给内建的可信表达式（如 'ctx.damage.final > 0'），编译为 AST 供 windows 解释。
  return {
    id,
    name: seed.name ?? kindtag,
    source: seed.source,
    owner: seed.owner,
    subscribe,
    priority: 0,
    divinity: seed.divinity ?? 0,
    stableId: id,
    triggerAst: trigger === 'true' ? { t: 'bool', v: true } : parseExpression(trigger),
    intents,
    isAdapter: adapter,
  };
}

/**
 * 把 ParsedEffect 映射为 AddModifier automaton（push-handler）。
 *
 * 依据词条 key + 方向（attacker/defender）确定：
 *   - 攻方修饰（collect_attacker_mods）
 *   - 守方修饰（collect_defender_mods）
 *   - 检定修饰（check.hit / check.intent / initiative.before）
 */
function modifierAutomaton(
  seed: BuiltinSeed,
  parsed: ParsedEffect,
  slot: ModifierSlot,
  window: WindowKey,
  magnitude: number,
  scope: 'whole_action' | 'per_hit' | 'per_target',
): CompiledAutomaton {
  return asAutomaton(
    seed,
    window,
    slot,
    'true',
    [
      {
        kind: 'AddModifier',
        slot,
        value: magnitude,
        scope,
        targetId: seed.owner,
        divinity: seed.divinity ?? 0,
      },
    ],
    true,
  );
}

/**
 * 内建 adapter 注册表（plan §5.3，15 条）。
 *
 * key 是 effect-parser 的 ParsedEffect.key（标准化英文 key）：
 *   physicalDmg / damageMult / damageTaken / hit / dodge / initiative /
 *   dr / penetration / reflect / lifesteal / shield / dot / hot / critRate / charges
 *
 * 值签名为 `(parsed, seed) => CompiledAutomaton | null`：
 *   - 命中 → 产 adapter automaton
 *   - 不匹配 → null（调用方产 UnsupportedCapability）
 */
export type BuiltinAdapter = (parsed: ParsedEffect, seed: BuiltinSeed) => CompiledAutomaton | null;

export const BUILTIN_ADAPTERS: Record<string, BuiltinAdapter> = {
  // #1 攻击时 +N 物理伤害（固伤，进管线 Step 6a）
  physicalDmg: (p, s) =>
    p.isPercentage
      ? null
      : modifierAutomaton(s, p, 'fixedDamage', 'collect_attacker_mods', p.value, 'whole_action'),
  // #2 伤害 +N%（攻方百分比，进管线 Step 6 乘算）
  damageMult: (p, s) =>
    p.isPercentage
      ? modifierAutomaton(
          s,
          p,
          'damageMult',
          'collect_attacker_mods',
          p.value / 100,
          'whole_action',
        )
      : null,
  // #3 受到伤害 -N%（守方百分比——修 M-6：守方百分比进管线，走 collect_defender_mods + damageTaken）
  damageTaken: (p, s) =>
    p.isPercentage
      ? modifierAutomaton(
          s,
          p,
          'damageTaken',
          'collect_defender_mods',
          -p.value / 100,
          'whole_action',
        )
      : null,
  // #4 命中 +N（检定，进 check.hit）
  hit: (p, s) => modifierAutomaton(s, p, 'hitBonus', 'check.hit', p.value, 'per_hit'),
  // #5 闪避 +N（检定，进 check.hit）
  dodge: (p, s) => modifierAutomaton(s, p, 'dodge', 'check.hit', p.value, 'per_hit'),
  // #6 先攻 +N（检定，进 initiative.before）
  initiative: (p, s) =>
    modifierAutomaton(s, p, 'initiative', 'initiative.before', p.value, 'whole_action'),
  // #7 DR N%（守方减免，进 collect_defender_mods）
  dr: (p, s) =>
    p.isPercentage
      ? modifierAutomaton(s, p, 'dr', 'collect_defender_mods', p.value / 100, 'whole_action')
      : null,
  // #8 穿透 N%（攻方穿透，进 collect_attacker_mods）
  penetration: (p, s) =>
    p.isPercentage
      ? modifierAutomaton(
          s,
          p,
          'penetration',
          'collect_attacker_mods',
          p.value / 100,
          'whole_action',
        )
      : null,
  // #9 反弹 N% 伤害（damage.after → Schedule(DealDamage isReaction)）。amount 用表达式按 preReduction×N 算
  reflect: (p, s) =>
    p.isPercentage
      ? asAutomaton(
          s,
          'damage.after',
          'reflect',
          'true',
          [
            {
              kind: 'ScheduleIntent',
              delay: 0,
              intent: {
                kind: 'DealDamage',
                targetId: 'ctx.damage.attackerId',
                amount: `ctx.damage.preReduction * ${p.value / 100}`,
                damageType: 'true',
                isReaction: true,
                doesNotConsumeSlot: true,
                rootChainId: 'ctx.damage.rootChainId',
                depth: 'ctx.depth + 1',
                hitPolicy: { consumeDice: true, advantage: 'adv' },
              },
            },
          ],
          true,
        )
      : null,
  // #10 吸血 N%（damage.after → Heal(self, ctx.damage.final * N)）
  lifesteal: (p, s) =>
    p.isPercentage
      ? asAutomaton(
          s,
          'damage.after',
          'lifesteal',
          'ctx.damage.final > 0',
          [
            {
              kind: 'Heal',
              targetId: 'ctx.self.id',
              amount: `ctx.damage.final * ${p.value / 100}`,
            },
          ],
          true,
        )
      : null,
  // #11 护盾 N（turn.open → ApplyStatus('护盾', layers:N)）
  shield: (p, s) =>
    !p.isPercentage
      ? asAutomaton(
          s,
          'turn.open',
          'shield',
          'true',
          [
            {
              kind: 'ApplyStatus',
              targetId: s.owner,
              statusId: '护盾',
              duration: 1,
              layers: Math.max(1, Math.floor(p.value)),
            },
          ],
          true,
        )
      : null,
  // #12 每回合扣 N% maxHp，持续 X 回合（round.close → DealDamage + duration 递减）
  //   key 透传：见 handleDot 特判在 compile.builtinDot
  dot: (p, s) =>
    p.isPercentage
      ? asAutomaton(
          s,
          'round.close',
          'dot',
          'true',
          [
            {
              kind: 'DealDamage',
              targetId: s.owner,
              amount: `ctx.self.maxHp * ${p.value / 100}`,
              damageType: 'true',
              doesNotConsumeSlot: true,
              hitPolicy: { consumeDice: false, advantage: 'none' },
            },
          ],
          true,
        )
      : null,
  // #13 每回合回 N HP（round.open → Heal）
  hot: (p, s) =>
    !p.isPercentage
      ? asAutomaton(
          s,
          'round.open',
          'hot',
          'true',
          [{ kind: 'Heal', targetId: s.owner, amount: p.value }],
          true,
        )
      : null,
  // #14 暴击率 +N%（检定，进 check.hit → critThreshold）
  critRate: (p, s) =>
    p.isPercentage
      ? modifierAutomaton(s, p, 'critThreshold', 'check.hit', p.value / 100, 'per_hit')
      : null,
};

/** 全部内建 key（供编译期遍历 & 测试） */
export const BUILTIN_KEYS: readonly string[] = Object.keys(BUILTIN_ADAPTERS);

/**
 * 编译一个 ParsedEffect 为编译态 automaton（不含 charges 特判）。
 * 不匹配任何内建 ⇒ 返回 null（调用方产 UnsupportedCapability）。
 */
export function compileParsedEffect(
  parsed: ParsedEffect,
  seed: BuiltinSeed,
): CompiledAutomaton | null {
  if (parsed.key === 'charges') return null; // charges 由 compile.builtinCharges 特判
  const adapter = BUILTIN_ADAPTERS[parsed.key];
  if (!adapter) return null;
  return adapter(parsed, seed);
}

/** 导出 DamageType 与 ModifierSlot 类型（供 builtins 测试/外部引用） */
export type { DamageType, ModifierSlot };
