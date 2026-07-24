/**
 * $char — 角色查询系统 (Layer 2, AI 只读)
 *
 * Phase 5 模块。职责:
 * 1. 按 ID/类型/位置查询角色
 * 2. 角色关系查询
 * 3. 角色状态摘要
 * 4. 角色比较
 *
 * 所有函数为纯函数或异步数据库查询，AI 可读不可写。
 */

import type { CharacterState } from './types';
import { getCharacter, getCharacters, getCharactersByType } from './database';

// ========== 角色查询 ==========

/** 按 ID 获取角色 */
export async function getChar(id: string): Promise<CharacterState | undefined> {
  return getCharacter(id);
}

/** 获取存档下所有角色 */
export async function getChars(saveId?: string): Promise<CharacterState[]> {
  return getCharacters(saveId);
}

/** 按类型过滤 */
export async function getCharsByType(type: CharacterState['type'], saveId?: string): Promise<CharacterState[]> {
  return getCharactersByType(type, saveId);
}

/** 获取玩家角色 */
export async function getPlayer(saveId?: string): Promise<CharacterState | undefined> {
  const all = await getCharacters(saveId);
  return all.find(c => c.type === 'player');
}

/** 获取所有 NPC */
export async function getNpcs(saveId?: string): Promise<CharacterState[]> {
  return getCharactersByType('npc', saveId);
}

/** 获取所有怪物 */
export async function getMonsters(saveId?: string): Promise<CharacterState[]> {
  return getCharactersByType('monster', saveId);
}

// ========== 纯函数查询 ==========

/** 按名称查找 */
export function findByName(chars: CharacterState[], name: string): CharacterState | undefined {
  return chars.find(c => c.name === name);
}

/** 按位置过滤 */
export function filterByLocation(chars: CharacterState[], location: string): CharacterState[] {
  return chars.filter(c => c.location === location);
}

/** 按层级过滤 */
export function filterByTier(chars: CharacterState[], tier: number): CharacterState[] {
  return chars.filter(c => c.tier === tier);
}

/** 按冒险者等级过滤 */
export function filterByRank(chars: CharacterState[], rank: string): CharacterState[] {
  return chars.filter(c => c.adventurerRank === rank);
}

/** 角色是否在场（在主角附近/同场景）。严格 === true 判断。 */
export function isPresent(c: CharacterState): boolean {
  return c.present === true;
}

/** 获取在场角色（在主角附近/同场景） */
export function getPresentCharacters(chars: CharacterState[], reference: CharacterState): CharacterState[] {
  return chars.filter(c => c.id !== reference.id && c.present === true);
}

// ========== 状态摘要 ==========

/** 生成角色状态摘要字符串（AI 可注入 Prompt） */
export function summarizeChar(char: CharacterState): string {
  const parts: string[] = [];

  parts.push(`[${char.type}:${char.name}]`);
  parts.push(`Lv.${char.level} ${char.tierName}`);
  parts.push(`HP:${char.hp}/${char.maxHp} MP:${char.mp}/${char.maxMp} SP:${char.sp}/${char.maxSp}`);
  parts.push(`位置:${char.location || '未知'}[${char.present === true ? '在场' : '离场'}]`);

  if (char.statusEffects.length > 0) {
    const effects = char.statusEffects.map(s => `${s.name}(${s.stacks}层)`).join(', ');
    parts.push(`状态:[${effects}]`);
  }

  // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）
  const equipped = char.inventory.filter(i => i.equippedSlot);
  if (equipped.length > 0) {
    const equip = equipped.map(e => e.name).join(', ');
    parts.push(`装备:[${equip}]`);
  }

  parts.push(char.currentAction || '待机中');

  return parts.join(' | ');
}

/** 生成所有角色状态摘要 */
export function summarizeChars(chars: CharacterState[]): string {
  return chars.map(c => summarizeChar(c)).join('\n');
}

// ========== 角色比较 ==========

/** 比较两个角色的战斗力（近似值） */
export function comparePower(a: CharacterState, b: CharacterState): number {
  const powerA = a.level * 10 + a.tier * 50 + Object.values(a.attributes).reduce((s, v) => s + v, 0);
  const powerB = b.level * 10 + b.tier * 50 + Object.values(b.attributes).reduce((s, v) => s + v, 0);
  return powerA - powerB;
}

/** 判断 A 是否明显强于 B */
export function isStrongerThan(a: CharacterState, b: CharacterState): boolean {
  return comparePower(a, b) > 20;
}

// ========== 关系查询 ==========

/** 获取角色的身份标签 */
export function getIdentities(char: CharacterState): string[] {
  return char.identity;
}

/** 获取角色的职业标签 */
export function getOccupations(char: CharacterState): string[] {
  return char.occupation;
}

/** 检查角色是否有某个身份 */
export function hasIdentity(char: CharacterState, identity: string): boolean {
  return char.identity.includes(identity);
}

// ========== 登神长阶查询 ==========

/** 检查角色是否开启了登神长阶 */
export function hasAscension(char: CharacterState): boolean {
  return char.ascension?.enabled ?? false;
}

/** 获取角色的要素列表 */
export function getElements(char: CharacterState): string[] {
  if (!char.ascension?.elements) return [];
  return char.ascension.elements.map(e => e.name);
}

/** 获取角色的权能列表 */
export function getAuthorities(char: CharacterState): string[] {
  if (!char.ascension?.authority) return [];
  return char.ascension.authority.map(a => a.name);
}

/** 获取角色的法则列表 */
export function getLaws(char: CharacterState): string[] {
  if (!char.ascension?.law) return [];
  return char.ascension.law.map(l => l.name);
}

// ========== $char Namespace ==========

/** AI 只读 $char API */
export const $char = {
  // 异步查询 (需要 await)
  getChar,
  getChars,
  getCharsByType,
  getPlayer,
  getNpcs,
  getMonsters,
  // 纯函数
  findByName,
  filterByLocation,
  filterByTier,
  filterByRank,
  isPresent,
  getPresentCharacters,
  summarizeChar,
  summarizeChars,
  comparePower,
  isStrongerThan,
  getIdentities,
  getOccupations,
  hasIdentity,
  hasAscension,
  getElements,
  getAuthorities,
  getLaws,
} as const;
