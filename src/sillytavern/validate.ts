/**
 * $validate — 数值约束引擎 (Layer 1, 引擎内部)
 *
 * Phase 5 模块。AI 不可见。职责:
 * 1. 数值范围约束 (clamp)
 * 2. 类型校验
 * 3. 必填字段检查
 * 4. Item/Equipment/Skill 数据完整性验证
 *
 * 所有写入 StateManager 的数据必须先通过 validate。
 */

import type {
  CharacterState, StatusEffect, EquipmentSlot, Skill, InventoryItem,
  VarsPatch, StatePatch,
} from './types';

// ========== 数值约束 ==========

/** 层级约束 */
export const TIER_RANGE = { min: 1, max: 7 } as const;
/** 等级约束 */
export const LEVEL_RANGE = { min: 1, max: 25 } as const;
/** HP/MP/SP 上限 */
export const RESOURCE_MAX = 99999;
/** 金钱上限 */
export const MONEY_MAX = 99999999;
/** 属性范围 */
export const ATTR_RANGE = { min: 1, max: 20 } as const;
/** 重要度范围 */
export const IMPORTANCE_RANGE = { min: 1, max: 10 } as const;
/** 状态效果最大层数 */
export const MAX_STATUS_STACKS = 99;
/** 背包最大物品数 */
export const MAX_INVENTORY_SIZE = 200;
/** 技能最大数量 */
export const MAX_SKILL_COUNT = 50;
/** 装备槽最大数量 */
export const MAX_EQUIPMENT_SLOTS = 12;

// ========== 通用 clamp ==========

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampHp(value: number, maxHp: number): number {
  return clamp(value, 0, Math.min(maxHp, RESOURCE_MAX));
}

export function clampMp(value: number, maxMp: number): number {
  return clamp(value, 0, Math.min(maxMp, RESOURCE_MAX));
}

export function clampSp(value: number, maxSp: number): number {
  return clamp(value, 0, Math.min(maxSp, RESOURCE_MAX));
}

// ========== 校验结果 ==========

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validResult(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

export function errorResult(msg: string): ValidationResult {
  return { valid: false, errors: [msg], warnings: [] };
}

// ========== 角色校验 ==========

export function validateCharacterState(char: CharacterState): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 必填字段
  if (!char.id) errors.push('缺少 id');
  if (!char.name) warnings.push('角色名称为空');
  if (!char.race) warnings.push('种族为空');

  // 层级 1-7
  if (char.tier < TIER_RANGE.min || char.tier > TIER_RANGE.max) {
    errors.push(`tier ${char.tier} 超出范围 [${TIER_RANGE.min}, ${TIER_RANGE.max}]`);
  }

  // 等级 1-25
  if (char.level < LEVEL_RANGE.min || char.level > LEVEL_RANGE.max) {
    errors.push(`level ${char.level} 超出范围 [${LEVEL_RANGE.min}, ${LEVEL_RANGE.max}]`);
  }

  // HP/MP/SP
  if (char.hp < 0 || char.hp > RESOURCE_MAX) errors.push('hp 溢出');
  if (char.mp < 0 || char.mp > RESOURCE_MAX) errors.push('mp 溢出');
  if (char.sp < 0 || char.sp > RESOURCE_MAX) errors.push('sp 溢出');
  if (char.hp > char.maxHp) warnings.push(`hp(${char.hp}) > maxHp(${char.maxHp})`);
  if (char.mp > char.maxMp) warnings.push(`mp(${char.mp}) > maxMp(${char.maxMp})`);
  if (char.sp > char.maxSp) warnings.push(`sp(${char.sp}) > maxSp(${char.maxSp})`);

  // 属性
  for (const [attr, val] of Object.entries(char.attributes)) {
    if (val < ATTR_RANGE.min || val > ATTR_RANGE.max) {
      errors.push(`属性 ${attr}=${val} 超出范围`);
    }
  }

  // 金钱
  if (char.money < 0 || char.money > MONEY_MAX) {
    errors.push(`金钱 ${char.money} 超出范围`);
  }

  // 背包上限
  if (char.inventory.length > MAX_INVENTORY_SIZE) {
    warnings.push(`背包物品数(${char.inventory.length})超过建议上限(${MAX_INVENTORY_SIZE})`);
  }

  // 状态效果层数
  for (const se of char.statusEffects) {
    if (se.stacks > MAX_STATUS_STACKS) {
      errors.push(`状态效果 "${se.name}" 层数(${se.stacks})超过上限(${MAX_STATUS_STACKS})`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ========== Patch 校验 ==========

export function validateStatePatch(patch: StatePatch): ValidationResult {
  const errors: string[] = [];

  if (!patch.op) errors.push('缺少 op');
  if (!patch.target) errors.push('缺少 target');

  // 数值操作约束
  if (patch.op === 'delta_hp' || patch.op === 'delta_mp' || patch.op === 'delta_sp') {
    if (patch.amount !== undefined && Math.abs(patch.amount) > RESOURCE_MAX) {
      errors.push(`delta amount ${patch.amount} 异常过大`);
    }
  }

  if (patch.op === 'set_hp' || patch.op === 'set_mp' || patch.op === 'set_sp') {
    if (typeof patch.value === 'number' && (patch.value < 0 || patch.value > RESOURCE_MAX)) {
      errors.push(`资源值 ${patch.value} 超出范围`);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ========== 装备/技能/物品校验 ==========

export function validateEquipment(equip: EquipmentSlot): ValidationResult {
  const errors: string[] = [];
  if (!equip.slot) errors.push('装备缺少 slot');
  if (!equip.itemId) errors.push('装备缺少 itemId');
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validateSkill(skill: Skill): ValidationResult {
  const errors: string[] = [];
  if (!skill.id) errors.push('技能缺少 id');
  if (!skill.name) errors.push('技能缺少 name');
  if (skill.cost && skill.cost.amount < 0) errors.push('技能消耗不能为负');
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validateItem(item: InventoryItem): ValidationResult {
  const errors: string[] = [];
  if (!item.id) errors.push('物品缺少 id');
  if (!item.name) errors.push('物品缺少 name');
  if (item.quantity < 0) errors.push(`物品 ${item.name} 数量为负`);
  return { valid: errors.length === 0, errors, warnings: [] };
}

// ========== VarsPatch 校验 ==========

export function validateVarsPatch(patch: VarsPatch): ValidationResult {
  const errors: string[] = [];

  if (patch.delta) {
    for (const d of patch.delta) {
      if (typeof d.amount !== 'number') {
        errors.push(`delta path=${d.path} amount 不是数字`);
      }
      if (Math.abs(d.amount) > 1_000_000) {
        errors.push(`delta amount ${d.amount} 异常过大`);
      }
    }
  }

  if (patch.replace) {
    for (const r of patch.replace) {
      if (r.value === undefined) {
        errors.push(`replace path=${r.path} 缺少 value`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ========== $validate Namespace ==========

/** 引擎内部 $validate API — AI 不可见 */
export const $validate = {
  // 数值约束
  clamp,
  clampHp,
  clampMp,
  clampSp,
  // 常量
  TIER_RANGE,
  LEVEL_RANGE,
  RESOURCE_MAX,
  MONEY_MAX,
  ATTR_RANGE,
  MAX_STATUS_STACKS,
  MAX_INVENTORY_SIZE,
  MAX_SKILL_COUNT,
  MAX_EQUIPMENT_SLOTS,
  // 校验函数
  validateCharacterState,
  validateStatePatch,
  validateEquipment,
  validateSkill,
  validateItem,
  validateVarsPatch,
  validResult,
  errorResult,
} as const;
