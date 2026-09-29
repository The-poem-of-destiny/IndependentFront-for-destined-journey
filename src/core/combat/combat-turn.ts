/**
 * 战斗先攻计算 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: 根据显式骰值与角色属性计算先攻。回合顺序与行动槽由内核管理。
 * 对齐世界书 #837805 [战斗协议] 第二阶段「行动顺序」。
 *
 * 先攻公式: (敏捷 × (1 + 速度修正%)) + d20 + 固定修正 (多来源取最高值)
 * 每回合资源: 1 攻击 + 1 动作
 */

import type { CombatUnitTurn, CombatParticipant } from '../types/types';

// ========== 先攻计算 ==========

/**
 * 计算单个参与者的先攻总值。
 * 公式: (敏捷 × (1 + 速度修正%)) + d20 + 固定修正
 * 速度修正和固定修正均为多来源取最高值。
 */
export function rollInitiative(participant: CombatParticipant, d20Roll: number): CombatUnitTurn {
  const agility = participant.attributes.dex;

  // 速度修正: 多来源取最高
  const speedMod =
    participant.speedModifiers.length > 0 ? Math.max(...participant.speedModifiers) : 0;

  // 固定修正: 多来源取最高
  const fixedMod = participant.fixedInitiativeBonus;

  const speedPart = agility * (1 + speedMod);
  const total = Math.floor(speedPart) + d20Roll + fixedMod;

  return {
    characterId: participant.characterId,
    name: participant.name,
    agility,
    d20Roll,
    speedModifiers: participant.speedModifiers,
    totalInitiative: total,
    attacksRemaining: participant.canAct ? 1 : 0,
    actionsRemaining: participant.canAct ? 1 : 0,
  };
}
