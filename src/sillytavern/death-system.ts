/**
 * 死亡检测 — 最小实现 (Phase 5)
 *
 * 设计决策: 复活机制（延迟/FP补偿/状态恢复）是 AI 叙事层的内容，
 * Code 只负责检测 HP=0 的事实。世界书规则已包含复活逻辑，AI 自会演绎。
 */

import type { CharacterState } from './types';

/** 检测角色是否死亡 */
export function detectDeath(char: CharacterState): boolean {
  return char.hp <= 0;
}

/** 批量检测 */
export function detectDeaths(characters: CharacterState[]): CharacterState[] {
  return characters.filter(c => detectDeath(c));
}
