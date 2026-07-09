/**
 * 系统事件 → ChatMessage 工厂函数
 *
 * 产出 ChatMessage 的 role 为 'system'，前端根据此区分三种消息来源。
 * content 字段存纯文本摘要（给 AI 看），systemEvent 字段存结构化数据（给前端渲染卡片）。
 */

import type { ChatMessage, SystemEvent } from '@engine/types';

export function toSystemMessage(event: SystemEvent): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    content: event.narrative,
    timestamp: Date.now(),
    systemEvent: event,
  };
}

// ========== Convenience helpers — 各类型 event 构造 + 自动生成 narrative ==========

import type {
  CraftAgentOutput, CharGenOutput, ItemGenOutput, CombatSummaryResult,
  QualityLevel, CraftRating,
} from '@engine/types';

export function craftToEvent(output: CraftAgentOutput): SystemEvent {
  return {
    type: 'craft',
    productName: output.craftToolCall.productName,
    quality: output.craftToolCall.targetQuality as QualityLevel,
    rating: '成功' as CraftRating,
    narrative: `[制作] ${output.craftToolCall.targetQuality}级 ${output.craftToolCall.productName}`,
    details: output,
  };
}

export function charGenToEvent(output: CharGenOutput): SystemEvent {
  return {
    type: 'char_gen',
    characterName: output.name,
    race: output.race,
    tier: output.tier,
    narrative: `[新角色] ${output.name} (${output.race}, T${output.tier})`,
    details: output,
  };
}

export function itemGenToEvent(output: ItemGenOutput): SystemEvent {
  // 提取第一个物品/技能/装备名作为摘要
  const firstName = output.equipment?.[0]?.name
    ?? output.skills?.[0]?.name
    ?? output.inventory?.[0]?.name
    ?? '未知物品';
  let quality: QualityLevel = '普通';
  if (output.equipment?.[0]?.quality) quality = output.equipment[0].quality as QualityLevel;
  else if (output.inventory?.[0]?.rarity) quality = output.inventory[0].rarity as QualityLevel;
  return {
    type: 'item_gen',
    itemName: firstName,
    quality,
    itemType: output.equipment?.[0] ? '装备' : output.skills?.[0] ? '技能' : '物品',
    narrative: `[获得] ${firstName}`,
    details: output,
  };
}

export function combatToEvent(result: CombatSummaryResult): SystemEvent {
  const outcomeLabel: Record<string, string> = {
    ally_win: '胜利', enemy_win: '败北', draw: '平局', fled: '逃跑',
  };
  return {
    type: 'combat',
    outcome: result.outcome,
    narrative: `[战斗] ${outcomeLabel[result.outcome] ?? result.outcome} · ${result.rounds}回合 · EXP +${result.totalExp}`,
    details: result,
  };
}

export function charUpdateToEvent(characterName: string, summary: string): SystemEvent {
  return {
    type: 'character_update',
    characterName,
    narrative: `[角色变动] ${characterName}: ${summary}`,
  };
}

export function itemUpdateToEvent(itemName: string, operation: string, summary: string): SystemEvent {
  const opLabel: Record<string, string> = {
    consume: '消耗', transfer: '转移', modify: '变更', equip: '装备', unequip: '卸下',
  };
  return {
    type: 'item_update',
    itemName,
    operation,
    narrative: `[${opLabel[operation] ?? operation}] ${itemName}: ${summary}`,
  };
}

export function questUpdateToEvent(questName: string, status: string, summary: string): SystemEvent {
  return {
    type: 'quest_update',
    questName,
    status,
    narrative: `[任务] ${questName}: ${summary}`,
  };
}
