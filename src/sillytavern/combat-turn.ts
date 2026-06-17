/**
 * 战斗回合管理 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: 先攻掷骰、行动顺序排序、回合资源追踪 (1攻击+1动作/回合)。
 * 对齐世界书 #837805 [战斗协议] 第二阶段「行动顺序」。
 *
 * 先攻公式: (敏捷 × (1 + 速度修正%)) + d20 + 固定修正 (多来源取最高值)
 * 每回合资源: 1 攻击 + 1 动作
 */

import type { CombatUnitTurn, TurnOrder, CombatParticipant } from './types';

// ========== 先攻计算 ==========

/**
 * 计算单个参与者的先攻总值。
 * 公式: (敏捷 × (1 + 速度修正%)) + d20 + 固定修正
 * 速度修正和固定修正均为多来源取最高值。
 */
export function rollInitiative(
  participant: CombatParticipant,
  d20Roll: number,
): CombatUnitTurn {
  const agility = participant.attributes.dex;

  // 速度修正: 多来源取最高
  const speedMod = participant.speedModifiers.length > 0
    ? Math.max(...participant.speedModifiers)
    : 0;

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

/**
 * 为一组参战者掷先攻并排序。
 * 排序: 先攻总值从高到低。
 * 面板列表顺序默认: user → 队友 → 敌人 (世界书)
 */
export function rollAndSortInitiative(
  participants: CombatParticipant[],
  d20Rolls: number[], // 每个参与者的 d20 骰值，按 participants 顺序
): TurnOrder {
  const turns: CombatUnitTurn[] = participants.map((p, i) =>
    rollInitiative(p, d20Rolls[i] ?? Math.floor(Math.random() * 20) + 1),
  );

  // 从高到低排序
  turns.sort((a, b) => b.totalInitiative - a.totalInitiative);

  return {
    sequence: turns,
    round: 1,
  };
}

/** 为单个新回合更新 TurnOrder */
export function nextTurnOrder(
  participants: CombatParticipant[],
  d20Rolls: number[],
  currentRound: number,
): TurnOrder {
  const newOrder = rollAndSortInitiative(participants, d20Rolls);
  newOrder.round = currentRound;
  return newOrder;
}

// ========== 行动顺序管理 ==========

/** 获取当前行动者 */
export function getCurrentActor(order: TurnOrder, currentIndex: number): CombatUnitTurn | null {
  if (currentIndex < 0 || currentIndex >= order.sequence.length) return null;
  return order.sequence[currentIndex];
}

/** 获取下一个有剩余行动力的行动者索引 */
export function getNextActiveIndex(order: TurnOrder, currentIndex: number): number {
  const len = order.sequence.length;
  if (len === 0) return -1;

  // 从下一个位置开始搜索
  for (let i = 1; i <= len; i++) {
    const idx = (currentIndex + i) % len;
    const unit = order.sequence[idx];
    if (unit && (unit.attacksRemaining > 0 || unit.actionsRemaining > 0)) {
      return idx;
    }
  }

  // 所有人都用完行动力 → 回合结束
  return -1;
}

/** 检查回合是否结束 (所有单位的攻击和动作都用完) */
export function isRoundOver(order: TurnOrder): boolean {
  return order.sequence.every(
    u => u.attacksRemaining <= 0 && u.actionsRemaining <= 0,
  );
}

/** 消耗 1 次攻击 */
export function consumeAttack(order: TurnOrder, characterId: string): void {
  const unit = order.sequence.find(u => u.characterId === characterId);
  if (unit) {
    unit.attacksRemaining = Math.max(0, unit.attacksRemaining - 1);
  }
}

/** 消耗 1 个动作 */
export function consumeAction(order: TurnOrder, characterId: string): void {
  const unit = order.sequence.find(u => u.characterId === characterId);
  if (unit) {
    unit.actionsRemaining = Math.max(0, unit.actionsRemaining - 1);
  }
}

/** 为新回合重置所有单位的攻击和动作 */
export function resetTurnResources(order: TurnOrder): void {
  for (const unit of order.sequence) {
    unit.attacksRemaining = 1;
    unit.actionsRemaining = 1;
  }
}

// ========== 回合序列描述 ==========

/** 生成人类可读的先攻序列描述 */
export function formatInitiativeSequence(order: TurnOrder): string {
  if (order.sequence.length === 0) return '(空)';

  const details = order.sequence
    .map(u => {
      const speedModStr = u.speedModifiers.length > 0
        ? ` × (1+${Math.max(...u.speedModifiers) * 100}%修正)`
        : '';
      return `${u.name}: (敏捷${u.agility}${speedModStr}) + 骰${u.d20Roll} = ${u.totalInitiative}`;
    })
    .join('\n');

  const sequence = order.sequence.map(u => u.name).join(' → ');

  return `${details}\n序列: ${sequence}`;
}

// ========== 验证 ==========

/** 验证先攻序列的合法性 */
export function validateInitiative(participants: CombatParticipant[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (participants.length < 2) {
    errors.push('战斗至少需要 2 名参与者');
  }

  const allyCount = participants.filter(p => p.side === 'ally').length;
  const enemyCount = participants.filter(p => p.side === 'enemy').length;

  if (allyCount === 0) errors.push('没有友方参与者');
  if (enemyCount === 0) errors.push('没有敌方参与者');

  for (const p of participants) {
    if (p.attributes.dex < 1) errors.push(`${p.name}: 敏捷值无效 (${p.attributes.dex})`);
    if (p.tier < 1 || p.tier > 7) errors.push(`${p.name}: 层级值无效 (${p.tier})`);
  }

  return { valid: errors.length === 0, errors };
}
