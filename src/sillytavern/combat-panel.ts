/**
 * 战斗面板生成器 — Layer 3 流程级 (AI 不可见 / AI 可读)
 *
 * 职责: 生成 <action_info> XML 面板，对齐世界书 #837805 [战斗协议] 三阶段面板模板。
 *
 * 三阶段面板:
 *   第一阶段: 战况总览 — 所有参战单位状态
 *   第二阶段: 行动顺序 — 先攻序列
 *   第三阶段: 攻击行动 — 伤害管线完整展示
 */

import type {
  CombatState,
  CombatParticipant,
  CombatUnitTurn,
  CombatType,
  CombatDamageBreakdown,
  CombatActionRequest,
  IntentionResult,
} from './types';

// ========== 第一阶段: 战况总览 ==========

/**
 * 生成战况总览面板 (Phase 1)。
 * 列出所有友方敌方参战单位的完整资源、核心属性及当前状态。
 */
export function buildOverviewPanel(state: CombatState): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push(`  {战况总览}`);
  lines.push(`  | 回合: ${state.round} | 类型: ${state.combatType} | 环境: ${state.environment} |`);

  // 列参战单位
  for (const p of state.participants) {
    const sideLabel = p.side === 'ally' ? '友方' : '敌方';
    const clusterInfo = ''; // Phase 6c 集群扩展

    lines.push(`  | [${sideLabel}] ${p.name}${clusterInfo}: HP ${p.hp}/${p.maxHp} | MP ${p.mp}/${p.maxMp} | SP ${p.sp}/${p.maxSp} | 力${p.attributes.str} 敏${p.attributes.dex} 体${p.attributes.con} 智${p.attributes.int} 精${p.attributes.spi} |`);

    if (p.statusEffects.length > 0) {
      const statusStr = p.statusEffects
        .map(s => `${s.name}(${s.remainingTime}回合)`)
        .join(', ');
      lines.push(`  | 状态: ${statusStr} |`);
    }
  }

  lines.push('</action_info>');
  lines.push('  叙事指导: (描写当前的对峙局势、环境氛围、角色的状态外貌，为本回合定调)');

  return lines.join('\n');
}

// ========== 第二阶段: 行动顺序 ==========

/**
 * 生成行动顺序面板 (Phase 2)。
 * 先攻公式: (敏捷 × (1 + 速度修正%)) + d20 + 固定修正
 */
export function buildInitiativePanel(order: CombatUnitTurn[]): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push('  {行动顺序}');

  for (const u of order) {
    const speedModStr = u.speedModifiers.length > 0
      ? ` × (1+${Math.max(...u.speedModifiers) * 100}%修正)`
      : '';
    const fixedStr = ''; // 固定修正待 Phase 6c 扩展
    lines.push(`  | ${u.name}: (敏捷${u.agility}${speedModStr}) + 骰${u.d20Roll}${fixedStr} = ${u.totalInitiative} |`);
  }

  const sequence = order.map(u => u.name).join(' → ');
  lines.push(`  | 序列: ${sequence} |`);
  lines.push('</action_info>');
  lines.push('  叙事指导: (描写双方的反应速度，谁先动了，谁慢了一拍，空气中紧绷的一触即发感)');

  return lines.join('\n');
}

// ========== 第三阶段: 攻击行动 ==========

/**
 * 生成攻击行动面板 (Phase 3 — 伤害基准计算部分)。
 * 包含完整的 8 步管线展开。
 */
export function buildAttackPanel(params: {
  attackerName: string;
  defenderName: string;
  skillName: string;
  weaponName: string;
  costs: { hp?: number; mp?: number; sp?: number };
  intention: IntentionResult;
  damage: CombatDamageBreakdown;
  request: CombatActionRequest;
  attackerAttributes: { str: number; dex: number; con: number; int: number; spi: number };
  defenderAttributes: { str: number; dex: number; con: number; int: number; spi: number };
  diceRolls: number[];
  hitBonus: number;
  dodgeBonus: number;
  checkValue: number;
  ratingName: string;
  ratingCoeff: number;
  advantage: boolean;
  disadvantage: boolean;
}): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push('  {攻击行动}');

  // 基本信息
  const costs = params.costs;
  lines.push(`  | 攻方: ${params.attackerName} | 守方: ${params.defenderName} | 招式: ${params.skillName} | 所使武器: ${params.weaponName} |`);
  lines.push(`  | 消耗: HP ${costs.hp ?? 0} | MP ${costs.mp ?? 0} | SP ${costs.sp ?? 0} |`);

  // 意图
  const intentionLine = `  | 意图: ${params.request.intentionKeywords || '常规'} → 判定为 ${params.intention.level} / ${params.intention.verdict} |`;
  lines.push(intentionLine);

  // 伤害基准计算
  lines.push('  {伤害基准计算}');
  lines.push(`  | 初始伤害: ${params.damage.initialFormula} |`);

  if (params.damage.multiSplitInfo) {
    const ms = params.damage.multiSplitInfo;
    lines.push(`  | 多段/连击(${ms.count}): ${params.damage.initialDamage} / ${ms.count} = ${ms.perHit} |`);
  }

  const pen = params.damage.penetration;
  if (pen.penetrationRate > 0) {
    lines.push(`  | 穿透修正: 防御${pen.originalDef} × (1-穿透${pen.penetrationRate * 100}%) = 有效防御${pen.effectiveDef} |`);
  }

  const dmgType = params.request.damageType || '物理';
  lines.push(`  | ${dmgType}伤害: 构成${params.damage.afterMultiSplit} - 装备减免${params.damage.equipmentReduction} - 属性减免${params.damage.typeReductionAmount} = 结算基值${params.damage.afterTypeReduction} |`);
  lines.push(`  | 基础伤害 (单次基准): ${params.damage.afterTypeReduction} |`);

  // 意图判定
  if (params.intention.contested) {
    const c = params.intention.contested;
    lines.push(`  | 意图判定: ${c.attackerFormula} = ${c.attackerValue} vs ${c.defenderFormula} = ${c.defenderValue} → ${params.intention.verdict} |`);
  } else {
    lines.push(`  | 意图判定: → ${params.intention.verdict} |`);
  }

  // 结算清单
  lines.push('  {结算清单}');

  const diceDesc = params.advantage
    ? `优势:2d20(${params.diceRolls.join(',')})→取值${Math.max(...params.diceRolls)}`
    : params.disadvantage
      ? `劣势:2d20(${params.diceRolls.join(',')})→取值${Math.min(...params.diceRolls)}`
      : `正常:d20(${params.diceRolls[0]})`;
  lines.push(`  | 掷骰: ${diceDesc} |`);
  lines.push(`  | 命中加值: ${params.hitBonus} |`);
  lines.push(`  | 闪避减值: ${params.dodgeBonus} |`);
  lines.push(`  | 检定结果: d20[${params.diceRolls[0]}] + 命中${params.hitBonus} - 闪避${params.dodgeBonus} = ${params.checkValue} | 结果: ${params.ratingName}(${params.ratingCoeff}) |`);

  // 伤害修正
  const afterRating = params.damage.afterRating;
  lines.push(`  | 伤害修正: (基础${params.damage.afterTypeReduction} × 评级系数${params.damage.ratingCoefficient} × 意图系数${params.damage.intentionCoefficient}) = ${afterRating} |`);

  if (params.damage.drRate > 0) {
    lines.push(`  | DR修正: ${afterRating} × (1-DR${params.damage.drRate * 100}%) = ${params.damage.afterDr} |`);
  }

  lines.push(`  | 最终伤害: ${params.damage.finalDamage} |`);

  return lines.join('\n');
}

// ========== 完整回合面板 ==========

/**
 * 生成完整的单次攻击 <action_info> 面板 (Phase 3 完整版)。
 * 整合意图→攻击检定→伤害管线→最终结算。
 */
export function buildFullActionPanel(params: {
  attackerName: string;
  defenderName: string;
  attackerHp: { before: number; after: number; max: number };
  defenderHp: { before: number; after: number; max: number };
  skillName: string;
  weaponName: string;
  costs: { hp?: number; mp?: number; sp?: number };
  intention: IntentionResult;
  damage: CombatDamageBreakdown;
  request: CombatActionRequest;
  diceRolls: number[];
  hitBonus: number;
  dodgeBonus: number;
  checkValue: number;
  ratingName: string;
  ratingCoeff: number;
  advantage: boolean;
  disadvantage: boolean;
  /** 状态施加结果 */
  statusApplied: Array<{ name: string; effect: string; duration: number; triggered: boolean; reason: string }>;
  /** 是否死亡 */
  isDead: boolean;
  /** 非致死注释 */
  nonLethalNote?: string;
}): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push('  {攻击行动}');

  // 基本信息行
  const costs = params.costs;
  lines.push(`  | 攻方: ${params.attackerName} | 守方: ${params.defenderName} | 招式: ${params.skillName} | 所使武器: ${params.weaponName} |`);
  lines.push(`  | 消耗: HP ${costs.hp ?? 0} | MP ${costs.mp ?? 0} | SP ${costs.sp ?? 0} |`);
  lines.push(`  | 意图: ${params.request.intentionKeywords || '常规'} → 判定为 ${params.intention.level} |`);

  // 伤害基准计算
  lines.push('  {伤害基准计算}');
  lines.push(`  | 初始伤害: ${params.damage.initialFormula} |`);

  if (params.damage.multiSplitInfo) {
    const ms = params.damage.multiSplitInfo;
    lines.push(`  | 多段/连击(${ms.count}): ${params.damage.initialDamage} / ${ms.count} = ${ms.perHit} |`);
  }

  const pen = params.damage.penetration;
  if (pen.penetrationRate > 0) {
    lines.push(`  | 穿透修正: 防御${pen.originalDef} × (1-穿透${(pen.penetrationRate * 100).toFixed(0)}%) = 有效防御${pen.effectiveDef} |`);
  }

  const dmgType = params.request.damageType || '物理';
  lines.push(`  | ${dmgType}伤害: 构成${params.damage.afterMultiSplit} - 装备减免${params.damage.equipmentReduction} - 属性减免${params.damage.typeReductionAmount} = 结算基值${params.damage.afterTypeReduction} |`);
  lines.push(`  | 基础伤害 (单次基准): ${params.damage.afterTypeReduction} |`);

  // 意图判定行
  if (params.intention.contested) {
    const c = params.intention.contested;
    lines.push(`  | 意图判定: ${c.attackerFormula} = ${c.attackerValue} vs ${c.defenderFormula} = ${c.defenderValue} → ${params.intention.verdict} |`);
  } else {
    lines.push(`  | 意图判定: → ${params.intention.verdict} |`);
  }

  // 结算清单
  lines.push('  {结算清单}');

  const diceDesc = params.advantage
    ? `优势:2d20(${params.diceRolls.join(',')})→取值${Math.max(...params.diceRolls)}`
    : params.disadvantage
      ? `劣势:2d20(${params.diceRolls.join(',')})→取值${Math.min(...params.diceRolls)}`
      : `正常:d20(${params.diceRolls[0]})`;
  lines.push(`  | 掷骰: ${diceDesc} |`);
  lines.push(`  | 命中加值: max(技能命中, 装备命中) = ${params.hitBonus} |`);
  lines.push(`  | 闪避减值: max(装备闪避, 技能闪避) = ${params.dodgeBonus} |`);
  lines.push(`  | 检定结果: d20[取值${params.diceRolls.length > 1 ? '=' + Math.max(...params.diceRolls) : params.diceRolls[0]}] + 命中${params.hitBonus} - 闪避${params.dodgeBonus} = ${params.checkValue} | 结果: ${params.ratingName}(${params.ratingCoeff}) |`);

  // 伤害修正
  const afterRating = params.damage.afterRating;
  lines.push(`  | 伤害修正: (基础${params.damage.afterTypeReduction} × 评级系数${params.damage.ratingCoefficient} × 意图系数${params.damage.intentionCoefficient}) + 额外固定伤害0 = ${afterRating} |`);

  // 效果修正 (如果有减伤类型)
  if (params.damage.typeReductionRate > 0) {
    lines.push(`  | 效果修正: ${afterRating} × ${dmgType}修正${(params.damage.typeReductionRate * 100).toFixed(1)}% × 机制修正1.0 = ${params.damage.afterDr} |`);
  }

  // DR 修正
  if (params.damage.drRate > 0) {
    lines.push(`  | DR修正: ${params.damage.afterDr} × (1-DR${(params.damage.drRate * 100).toFixed(0)}%) = ${damageAfter(params.damage)} |`);
  }

  lines.push(`  | 最终伤害: ${params.damage.finalDamage} | 变更: ${params.defenderName} HP ${params.defenderHp.before} → ${params.defenderHp.after} (${hpPercent(params.defenderHp.after, params.defenderHp.max)}%) (-${params.damage.finalDamage}) |`);
  lines.push(`  | 是否存活: ${params.defenderHp.after} > 0 → [${params.isDead ? '死亡/毁坏' : '未死/存活'}] |${params.nonLethalNote ? ` (${params.nonLethalNote})` : ''}`);

  // 状态施加
  for (const s of params.statusApplied) {
    lines.push(`  | 状态施加(${s.name}): ${s.reason} → [${s.triggered ? '触发成功' : '失败'}] |`);
    if (s.triggered) {
      lines.push(`  | 状态效果: ${params.defenderName}获得${s.name}(${s.effect}), 持续${s.duration}回合 |`);
    }
  }

  lines.push('</action_info>');

  return lines.join('\n');
}

/** 辅助: DR 后伤害 */
function damageAfter(b: CombatDamageBreakdown): number {
  return b.afterDr;
}

/** 辅助: HP 百分比 */
function hpPercent(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((current / max) * 100);
}

// ========== 简单面板 (快速战斗摘要) ==========

/** 生成简化的单行战斗摘要 (用于日志) */
export function buildCombatSummary(params: {
  attackerName: string;
  defenderName: string;
  damage: number;
  ratingName: string;
  isDead: boolean;
}): string {
  return `${params.attackerName} → ${params.defenderName}: ${params.damage}伤害 (${params.ratingName})${params.isDead ? ' [击杀]' : ''}`;
}

// ========== 范围攻击面板 ==========

/** 为 AoE 技能对多个目标逐行生成面板条目 */
export function buildAoELine(targetName: string, checkValue: number, rating: string, damage: number): string {
  return `  | → ${targetName}: 检定${checkValue}(${rating}) 伤害${damage} |`;
}
