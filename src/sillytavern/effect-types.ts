/**
 * EffectTypes — 战斗 modifier 6 大类 + 登神 divinity 仲裁 (M2 战斗 v2)
 *
 * 职责: 定义战斗管线修正（modifier）的类型系统，独立于 StatusEffect / EffectDefinition。
 *  - StatusEffect:      buff 实例的持久状态（落 DB）
 *  - EffectDefinition:  Agent 输出的结构化效果声明（Phase 4.5）
 *  - Modifier（本文件）: 装备/技能/buff 声明的"管线修正"（固伤/百分比/检定/...），由 collect_mods 收集
 *
 * 对齐: docs/reference/combat-system-architecture.md §四（效果系统）+ §十三 决策 c（差值压制表）
 * RFC:  docs/planning/2026-07-28-combat-v2-m2-rfc.md §3 D1/D2/D4 + §4.1
 */

import type { AttributeName, DivinityLevel, DamageType } from './types';

// ========== 效果类别（6 大类，对齐 #265160 [品质效果限定]） ==========

export type EffectCategory = '固伤' | '百分比' | '资源' | '检定' | '附加效果' | '特殊机制';

// ========== Modifier 基础 ==========

/** 所有 modifier 共享的基础字段 */
export interface ModifierBase {
  category: EffectCategory;
  /** 声明来源（物品/技能名 —— 调试溯源 + 装备级 divinity 继承标识） */
  source: string;
  /** 登神等级（继承所属装备；缺省=普通 0） */
  divinity?: DivinityLevel;
  /** 可选触发条件（EJS 风格，如 `{{target.hpPercent}} < 0.5`） */
  condition?: string;
}

// ========== 6 大类 modifier 接口（每类进管线位置见架构 §4.1） ==========

/** 固伤 —— 进管线 Step 6a（+ 额外固定伤害） */
export interface FixedDamageModifier extends ModifierBase {
  category: '固伤';
  amount: number;
  damageType?: DamageType;
}

/** 百分比 —— 进管线 Step 6（× 乘算系数；增伤 +0.2 / 减伤 -0.2） */
export interface PercentageModifier extends ModifierBase {
  category: '百分比';
  /** 增益正值（+0.2=+20%）、减益负值 */
  coefficient: number;
  target: 'damage' | 'heal' | 'resource';
}

/** 资源 —— 直接结算（HP/MP/SP 变动、护盾） */
export interface ResourceModifier extends ModifierBase {
  category: '资源';
  resource: 'hp' | 'mp' | 'sp';
  /** 正=恢复，负=消耗 */
  amount: number;
}

/** 检定 —— 命中/闪避/先攻/抵抗/属性修正（五维只能走这类，#265160 铁律） */
export interface CheckModifier extends ModifierBase {
  category: '检定';
  checkType: '命中' | '闪避' | '先攻' | '抵抗' | '属性';
  /** checkType='属性' 时指定哪一维 */
  attribute?: AttributeName;
  bonus: number;
}

/** 附加效果 —— 转 buff 施加（走 buff 系统，不直接进管线数值） */
export interface AdditionalEffectModifier extends ModifierBase {
  category: '附加效果';
  buffName: string;
  /** buff id 前缀（物品/技能名） */
  sourceKey: string;
  stacks?: number;
  /** 持续回合（lifecycle='战斗' 时有效） */
  duration?: number;
  lifecycle?: '战斗' | '持续' | '触发' | '条件';
}

/** 特殊机制 —— DR/穿透/暴击倍率/召唤/光环/规则改写，各归其管线位 */
export interface SpecialMechanismModifier extends ModifierBase {
  category: '特殊机制';
  mechanism: 'DR' | '穿透' | '暴击倍率' | '召唤' | '光环' | '规则改写';
  value: number;
}

export type Modifier =
  | FixedDamageModifier
  | PercentageModifier
  | ResourceModifier
  | CheckModifier
  | AdditionalEffectModifier
  | SpecialMechanismModifier;

// ========== 登神 divinity 仲裁（§13 决策 c 差值压制表） ==========

/**
 * 登神冲突压制率（§13 决策 c）。
 *
 * 攻方 divinity 高于守方时，差值决定压制程度：
 *   差 1 级 → 20% | 差 2 级 → 40% | 差 3 级 → 60% | 差 4 级 → 80% | 差 ≥5 级 → 100%（完全无视）
 *   差 ≤0（攻方不高于守方）→ 0%（不压制）
 *
 * 用法（M3 管线消费）:
 *   守方防御被压制率 = resolveDivinityConflict(攻方div, 守方div)
 *   effectiveDef = def × (1 − 压制率)   // 等效穿透
 *   effectiveDR  = dr  × (1 − 压制率)   // 等效无视 DR
 */
export function resolveDivinityConflict(atk: DivinityLevel, def: DivinityLevel): number {
  const diff = atk - def;
  if (diff <= 0) return 0;
  if (diff >= 5) return 1;
  return diff * 0.2;
}

// ========== 分类与聚合工具（M2 边界：不接入 runDamagePipeline，M3 再消费） ==========

/** 返回 modifier 的类别（category 是判别字段，直接读） */
export function classifyModifier(m: Modifier): EffectCategory {
  return m.category;
}

/** 聚合固伤 modifier（累加 amount；首个带 damageType 的作为整体类型） */
export function sumFixedDamage(mods: Modifier[]): { amount: number; type?: DamageType } {
  let amount = 0;
  let type: DamageType | undefined;
  for (const m of mods) {
    if (m.category === '固伤') {
      amount += m.amount;
      if (m.damageType && type === undefined) type = m.damageType;
    }
  }
  return { amount, type };
}

/** 聚合百分比 modifier（架构 §4.4：累加进乘算系数）。
 *  返回总系数和（如 0.5 = +50%），调用方按 `1 + sum` 调整乘数 */
export function sumPercentages(mods: Modifier[]): number {
  let sum = 0;
  for (const m of mods) {
    if (m.category === '百分比') {
      sum += m.coefficient;
    }
  }
  return sum;
}

/** 提取检定 modifier（可按 checkType 过滤） */
export function collectChecks(
  mods: Modifier[],
  checkType?: CheckModifier['checkType'],
): CheckModifier[] {
  return mods.filter(
    (m): m is CheckModifier => m.category === '检定' && (!checkType || m.checkType === checkType),
  );
}

/** 提取资源 modifier */
export function collectResources(mods: Modifier[]): ResourceModifier[] {
  return mods.filter((m): m is ResourceModifier => m.category === '资源');
}

/** 提取附加效果 modifier（→ 转 buff 施加） */
export function collectAdditionalEffects(mods: Modifier[]): AdditionalEffectModifier[] {
  return mods.filter((m): m is AdditionalEffectModifier => m.category === '附加效果');
}

/** 提取特殊机制 modifier（可按 mechanism 过滤：DR/穿透/...） */
export function collectSpecialMechanisms(
  mods: Modifier[],
  mechanism?: SpecialMechanismModifier['mechanism'],
): SpecialMechanismModifier[] {
  return mods.filter(
    (m): m is SpecialMechanismModifier =>
      m.category === '特殊机制' && (!mechanism || m.mechanism === mechanism),
  );
}
