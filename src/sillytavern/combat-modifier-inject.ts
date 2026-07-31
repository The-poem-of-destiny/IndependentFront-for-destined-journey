/**
 * combat-modifier-inject — modifier 折叠 + 登神压制 (M3 战斗 v2 · 任务 4.4+4.5)
 *
 * 职责: 把 collect 的攻/守 Modifier[] 折叠成 PipelineModifiers（runDamagePipeline 消费），
 *      并应用登神压制（§13 决策 c 差值压制表）。
 *
 * 折叠规则对齐架构 §4.4 + RFC §3 D3/D5 + §4。
 */

import type { Modifier } from './effect-types';
import type { PipelineModifiers } from './combat-damage';
import {
  resolveDivinityConflict,
  sumFixedDamage,
  sumPercentages,
  collectChecks,
  collectSpecialMechanisms,
} from './effect-types';
import type { DivinityLevel } from './types';

/**
 * 折叠攻/守 modifier + 登神压制 → PipelineModifiers。
 *
 * 折叠规则（架构 §4.4）:
 *  - 固伤: 累加 attacker 固伤 amount → fixedDamageBonus
 *  - 百分比: 累加 attacker 百分比 coefficient → damageMultiplier
 *  - 穿透: 取 attacker 声明的「特殊机制·穿透」value 之和 → penetrationRateBonus
 *  - DR: 取 defender 声明的「特殊机制·DR」value 之和 → drRateBonus
 *  - 检定: attacker 命中/闪避 → hitBonus/dodgeBonus
 *
 * 登神压制（§13 c）:
 *  - atkDiv = attackerMods 中最高 divinity（缺省 0）
 *  - defDiv = defenderMods 中最高 divinity（缺省 0）
 *  - 压制率 = resolveDivinityConflict(atkDiv, defDiv)
 *  - penetrationRateBonus += 压制率（压制率当穿透）
 *  - drRateBonus += -压制率（负值削减守方 DR）
 */
export function foldModsToPipelineModifiers(
  attackerMods: Modifier[],
  defenderMods: Modifier[],
): PipelineModifiers {
  // 1. 固伤（attacker 声明累加）→ fixedDamageBonus
  const fixedDamageBonus = sumFixedDamage(attackerMods).amount;

  // 2. 百分比（attacker 声明累加系数）→ damageMultiplier
  // 🐛修复: 只累加 target='damage' 的百分比 modifier（heal/resource 不进伤害乘区）
  const damageMultiplier = sumPercentages(attackerMods, 'damage');

  // 3. 穿透（attacker 声明的「特殊机制·穿透」value 之和）→ penetrationRateBonus
  const penetrationRateBonus = collectSpecialMechanisms(attackerMods, '穿透').reduce(
    (sum, m) => sum + m.value,
    0,
  );

  // 4. DR（defender 声明的「特殊机制·DR」value 之和）→ drRateBonus
  const drRateBonus = collectSpecialMechanisms(defenderMods, 'DR').reduce(
    (sum, m) => sum + m.value,
    0,
  );

  // 5. 命中（attacker 检定·命中 bonus 之和）→ hitBonus
  const hitBonus = collectChecks(attackerMods, '命中').reduce((sum, m) => sum + m.bonus, 0);

  // 6. 闪避（defender 检定·闪避 bonus 之和）→ dodgeBonus
  const dodgeBonus = collectChecks(defenderMods, '闪避').reduce((sum, m) => sum + m.bonus, 0);

  // 7. 登神压制（§13 决策 c）: 攻方神位高于守方时，压制率当穿透、负值削减守方 DR
  const atkDiv = maxDivinity(attackerMods);
  const defDiv = maxDivinity(defenderMods);
  const suppressionRate = resolveDivinityConflict(atkDiv, defDiv);

  return {
    // 固伤 0 也写出（明确语义；runDamagePipeline Step 6a 累加 0 = 无影响）
    fixedDamageBonus,
    damageMultiplier,
    penetrationRateBonus: penetrationRateBonus + suppressionRate,
    drRateBonus: drRateBonus + -suppressionRate,
    hitBonus,
    dodgeBonus,
  };
}

/** 辅助：取 mods 中最高 divinity（agent 可用） */
export function maxDivinity(mods: Modifier[]): DivinityLevel {
  let max: DivinityLevel = 0;
  for (const m of mods) {
    const d = m.divinity ?? 0;
    if (d > max) max = d;
  }
  return max;
}
