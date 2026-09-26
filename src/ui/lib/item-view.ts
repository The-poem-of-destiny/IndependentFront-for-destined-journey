/**
 * item-view.ts — 物品 / 技能条目的**展示层纯逻辑**（唯一真源）
 *
 * 背景（2026-09-12）：玩家背包面板（`ItemsPanel.vue`）与 NPC 查看器
 * （`CharacterViewerModal.vue`）此前各写一套渲染，NPC 那套缺品质/战斗修正/效果归一化，
 * 显示不一致。数据结构上主角与 NPC 完全等价（都是 `InventoryItem[]` / `Skill[]`），
 * 故把「品质判定 / 分类 / 详情字段 / 效果与战斗修正」等纯逻辑收在这里，两个视图共用。
 *
 * 🔴 纯函数：无 I/O、无 store、无副作用。品质推断走引擎 ADR-11 的
 *    `inferQualityFromStats`（Q-11 起是全仓唯一一份，别再内联第二张阈值表）。
 */

import type { InventoryItem, QualityLevel, Skill } from '@engine/types';
import { QUALITY_RANK } from '@engine/types';
import { inferQualityFromStats } from '@engine/quality-inference';
import { describeModifiers } from '@engine/describe-modifier';
import { describeAutomata } from '@engine/describe-automaton';
import { normalizeEffects } from './item-effects';

/** 面板/查看器的分类（技能与物品是两种形状，故用判别联合而非取交集） */
export type ItemCategory = 'inventory' | 'equipment' | 'skills';

/** 一行条目 —— 物品与技能两种真实形状的判别联合（Q-11 起沿用） */
export type PanelEntry = { kind: 'item'; row: InventoryItem } | { kind: 'skill'; row: Skill };

/** 这一行的品质：优先存储的 rarity，缺失才推断。技能缺失回落中性「普通」，不编造。 */
export function qualityOf(entry: PanelEntry): string {
  if (entry.kind === 'skill') return entry.row.rarity || '普通';
  return entry.row.rarity || inferQualityFromStats(entry.row.stats);
}

/** 排序用品质序号（引擎唯一真源 `QUALITY_RANK`） */
export function qualityRank(entry: PanelEntry): number {
  return QUALITY_RANK[qualityOf(entry) as QualityLevel] ?? -1;
}

/** 归到哪个子分类 —— 筛选选项与筛选判据共用同一份 */
export function facetOf(entry: PanelEntry, category: ItemCategory): string | undefined {
  if (category === 'equipment') {
    return entry.kind === 'item' ? (entry.row.equippedSlot ?? undefined) : undefined;
  }
  if (entry.kind === 'skill') return entry.row.type === 'active' ? '主动' : '被动';
  return entry.row.type;
}

/** 列表行尾部的那点补充信息 */
export function listExtra(entry: PanelEntry, category: ItemCategory): string {
  if (entry.kind === 'skill') return `Lv.${entry.row.level ?? 1}`;
  return category === 'equipment' ? `[${entry.row.equippedSlot}]` : `×${entry.row.quantity}`;
}

/**
 * 详情头的类型文案。**不与 `facetOf` 合并**：这里返回「主动技能」「被动技能」，
 * 并对缺失值回退「装备」「物品」—— 是给人看的字，不是筛选键。
 */
export function typeLabel(entry: PanelEntry, category: ItemCategory): string {
  if (entry.kind === 'skill') return entry.row.type === 'active' ? '主动技能' : '被动技能';
  if (category === 'equipment') return entry.row.equippedSlot || '装备';
  return entry.row.type || '物品';
}

/** 详情头第二行（等级/消耗、耐久、数量） */
export function detailExtra(entry: PanelEntry, category: ItemCategory): string {
  if (entry.kind === 'skill') {
    const cost = entry.row.cost;
    return `Lv.${entry.row.level || 1}${cost ? ` · ${cost.amount}${cost.type}` : ''}`;
  }
  if (category === 'equipment') {
    return `${entry.row.durability || '?'}/${entry.row.maxDurability || '?'} 耐久`;
  }
  return `×${entry.row.quantity || 1}`;
}

/** 效果词条：三种历史形态（对象 / 名字:描述分号串 / 数组）统一归一化 */
export function entryEffects(entry: PanelEntry): Record<string, string> {
  return normalizeEffects(entry.row.effects);
}

/** 战斗修正中文摘要（modifiers + automata） */
export function entryCombatLines(entry: PanelEntry): string[] {
  return [...describeModifiers(entry.row.modifiers), ...describeAutomata(entry.row.automata)];
}

/** 原始战斗数据折叠（modifiers / automata JSON） */
export function entryRawCombatJson(entry: PanelEntry): string {
  const row = entry.row;
  const parts: string[] = [];
  if (row.modifiers?.length) parts.push(JSON.stringify(row.modifiers, null, 2));
  if (row.automata?.length) parts.push(JSON.stringify(row.automata, null, 2));
  return parts.join('\n\n');
}
