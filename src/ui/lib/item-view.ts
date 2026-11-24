/**
 * item-view.ts — 物品 / 技能条目的**展示层纯逻辑**（唯一真源）
 *
 * 背景（2026-09-12）：玩家背包面板（`ItemsPanel.vue`）与 NPC 查看器
 * （`CharacterViewerModal.vue`）此前各写一套渲染，NPC 那套缺品质/效果归一化，
 * 显示不一致。数据结构上主角与 NPC 完全等价（都是 `InventoryItem[]` / `Skill[]`），
 * 故把「品质判定 / 分类 / 详情字段 / 效果」等纯逻辑收在这里，两个视图共用。
 *
 * 🔴 纯函数：无 I/O、无 store、无副作用。品质推断走引擎 ADR-11 的
 *    `inferQualityFromStats`（Q-11 起是全仓唯一一份，别再内联第二张阈值表）。
 */

import type { InventoryItem, ItemGenOutput, QualityLevel, Skill } from '@engine/types/types';
import { QUALITY_RANK } from '@engine/types/types';
import { inferQualityFromStats } from '@engine/crafting/quality-inference';
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
    const cost = skillCostLabel(entry.row);
    return `Lv.${entry.row.level || 1}${cost ? ` · ${cost}` : ''}`;
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

/** 读技能消耗所需的最小形状（存档里的 `Skill` 与生成卡片里的技能条目都满足） */
export interface SkillCostLike {
  cost?: { type: string; amount: number } | null;
  costText?: string | null;
}

/**
 * 技能消耗的展示文案（状态树协议 §5.7，2026-11-22）：`costText` 有值时原样显示，
 * 否则按 `cost` 格式化，都没有返回空串。各处原有的数值排版不同，由 `typeFirst` / `sep` 指定：
 * 默认「10MP」，`{ sep: ' ' }` 为「10 MP」，`{ typeFirst: true, sep: ' ' }` 为「MP 10」。
 */
export function skillCostLabel(
  skill: SkillCostLike,
  opts: { typeFirst?: boolean; sep?: string } = {},
): string {
  const text = skill.costText?.trim();
  if (text) return text;
  const cost = skill.cost;
  if (!cost) return '';
  const sep = opts.sep ?? '';
  return opts.typeFirst ? `${cost.type}${sep}${cost.amount}` : `${cost.amount}${sep}${cost.type}`;
}

/** 重铸时交给 AI 的技能现状：生成条目形状，另带原样的 `costText`（AI 看得到解析不了的消耗原文） */
export type SkillRewriteEntry = ItemGenOutput['skills'][number] & { costText?: string };

/**
 * 把存档里的技能转成 entity_gen `<重铸目标>` 的条目。关键字段逐项透传，让 AI 能看到这条现状；
 * `costText` 有值时一并带上（§5.7「重铸时交给 AI 的现状」）。玩家背包与 NPC 列表共用。
 */
export function skillRewriteEntry(sk: Skill): SkillRewriteEntry {
  const costText = sk.costText?.trim();
  return {
    name: sk.name,
    description: sk.description ?? '',
    type: sk.type === 'passive' ? 'passive' : 'active',
    ...(sk.cost ? { cost: sk.cost } : {}),
    ...(costText ? { costText } : {}),
    ...(sk.cooldown !== undefined ? { cooldown: sk.cooldown } : {}),
    ...(sk.effects ? { effects: sk.effects } : {}),
    ...(sk.skillPower !== undefined ? { skillPower: sk.skillPower } : {}),
    ...(sk.relevantAttribute ? { relevantAttribute: sk.relevantAttribute } : {}),
    ...(sk.damageType ? { damageType: sk.damageType } : {}),
  };
}
