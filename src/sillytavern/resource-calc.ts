/**
 * $resource — 资源计算引擎 (Layer 2, AI 只读)
 *
 * Phase 5 模块。职责:
 * 1. HP/MP/SP 百分比计算
 * 2. 资源是否可支付检查
 * 3. 等级/层级比较
 * 4. 经验值计算
 */

import type { CharacterState, ResourceQuery, ResourceResult } from './types';

// ========== 百分比 ==========

export function getHpPercent(char: CharacterState): number {
  if (char.maxHp <= 0) return 0;
  return Math.round((char.hp / char.maxHp) * 100);
}

export function getMpPercent(char: CharacterState): number {
  if (char.maxMp <= 0) return 0;
  return Math.round((char.mp / char.maxMp) * 100);
}

export function getSpPercent(char: CharacterState): number {
  if (char.maxSp <= 0) return 0;
  return Math.round((char.sp / char.maxSp) * 100);
}

// ========== 状态判断 ==========

export function isAlive(char: CharacterState): boolean {
  return char.hp > 0;
}

export function isUnconscious(char: CharacterState): boolean {
  return char.hp === 0;
}

export function isDead(char: CharacterState): boolean {
  return char.hp <= 0;
}

export function isFullHp(char: CharacterState): boolean {
  return char.hp >= char.maxHp;
}

export function isFullMp(char: CharacterState): boolean {
  return char.mp >= char.maxMp;
}

export function isExhausted(char: CharacterState): boolean {
  return char.sp <= 0;
}

// ========== 可支付性 ==========

/** 检查是否可以支付 HP 消耗 */
export function canAffordHp(char: CharacterState, amount: number): boolean {
  return char.hp > amount; // 不能把自己支付到 0
}

/** 检查是否可以支付 MP 消耗 */
export function canAffordMp(char: CharacterState, amount: number): boolean {
  return char.mp >= amount;
}

/** 检查是否可以支付 SP 消耗 */
export function canAffordSp(char: CharacterState, amount: number): boolean {
  return char.sp >= amount;
}

/** 检查是否有足够金钱 */
export function canAffordMoney(char: CharacterState, amount: number): boolean {
  return char.money >= amount;
}

/** 检查是否有物品 */
export function hasItem(char: CharacterState, itemId: string, quantity: number = 1): boolean {
  const item = char.inventory.find(i => i.id === itemId);
  return item ? item.quantity >= quantity : false;
}

/** 检查是否有技能 */
export function hasSkill(char: CharacterState, skillId: string): boolean {
  return char.skills.some(s => s.id === skillId);
}

/** 检查是否有某个状态效果 */
export function hasStatus(char: CharacterState, statusName: string): boolean {
  return char.statusEffects.some(s => s.name === statusName || s.id === statusName);
}

// ========== 属性查询 ==========

export function getAttribute(char: CharacterState, attr: string): number {
  return (char.attributes as Record<string, number>)[attr] ?? 0;
}

export function getTier(char: CharacterState): number {
  return char.tier;
}

export function getLevel(char: CharacterState): number {
  return char.level;
}

export function getAdventurerRank(char: CharacterState): string {
  return char.adventurerRank;
}

// ========== 经验值计算 ==========

/** 计算升级所需经验 */
export function expToLevel(level: number): number {
  return Math.floor(100 * Math.pow(1.5, level - 1));
}

/** 计算总经验值 */
export function totalExpForLevel(level: number): number {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += expToLevel(i);
  }
  return total;
}

/** 计算怪物经验奖励 */
export function expFromMonster(monsterTier: number, monsterLevel: number): number {
  const base = monsterTier * 25;
  return Math.floor(base * (1 + monsterLevel * 0.1));
}

// ========== Resource Query Engine ==========

/** 统一资源查询入口 */
export function queryResource(char: CharacterState, query: ResourceQuery): ResourceResult {
  const base = {
    characterId: char.id,
    query: query.query,
    timestamp: Date.now(),
  };

  switch (query.query) {
    case 'hp_percent':
      return { ...base, value: getHpPercent(char), description: `${char.name} HP: ${char.hp}/${char.maxHp} (${getHpPercent(char)}%)` };
    case 'mp_percent':
      return { ...base, value: getMpPercent(char), description: `${char.name} MP: ${char.mp}/${char.maxMp} (${getMpPercent(char)}%)` };
    case 'sp_percent':
      return { ...base, value: getSpPercent(char), description: `${char.name} SP: ${char.sp}/${char.maxSp} (${getSpPercent(char)}%)` };
    case 'tier':
      return { ...base, value: char.tier, description: `${char.name} 层级: ${char.tierName} (T${char.tier})` };
    case 'level':
      return { ...base, value: char.level, description: `${char.name} 等级: Lv.${char.level}` };
    case 'stat':
      return { ...base, value: getAttribute(char, query.params?.attr ?? 'str'), description: `${char.name} ${query.params?.attr}: ${getAttribute(char, query.params?.attr ?? 'str')}` };
    case 'can_afford':
      return { ...base, value: canAffordMoney(char, query.params?.amount ?? 0), description: canAffordMoney(char, query.params?.amount ?? 0) ? '可支付' : '资金不足' };
    case 'has_item':
      return { ...base, value: hasItem(char, query.params?.itemId ?? ''), description: hasItem(char, query.params?.itemId ?? '') ? '拥有' : '未拥有' };
    case 'has_skill':
      return { ...base, value: hasSkill(char, query.params?.skillId ?? ''), description: hasSkill(char, query.params?.skillId ?? '') ? '已习得' : '未习得' };
    case 'has_status':
      return { ...base, value: hasStatus(char, query.params?.statusName ?? ''), description: hasStatus(char, query.params?.statusName ?? '') ? '已受影响' : '未受影响' };
    default:
      return { ...base, value: 0, description: '未知查询' };
  }
}

// ========== $resource Namespace ==========

/** AI 只读 $resource API */
export const $resource = {
  getHpPercent,
  getMpPercent,
  getSpPercent,
  isAlive,
  isUnconscious,
  isDead,
  isFullHp,
  isFullMp,
  isExhausted,
  canAffordHp,
  canAffordMp,
  canAffordSp,
  canAffordMoney,
  hasItem,
  hasSkill,
  hasStatus,
  getAttribute,
  getTier,
  getLevel,
  getAdventurerRank,
  expToLevel,
  totalExpForLevel,
  expFromMonster,
  queryResource,
} as const;
