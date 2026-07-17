/**
 * 游戏数据枚举集中定义 + 归一化（数据字段规范 铁律5）
 *
 * 所有游戏实体的枚举取值一律中文、只在此处定义。
 * AI 提名的枚举值在写入前必须经过对应 normalize* 归一化。
 * 规范: docs/superpowers/specs/2026-07-16-data-field-conventions-design.md 第 3.2 节
 */

// ========== 枚举常量 ==========

/** 装备槽位（对齐世界书装备条目，一槽一件） */
export const EQUIP_SLOTS = ['武器', '副手', '头部', '身体', '手部', '脚部', '腰带', '饰品'] as const;
export type EquipSlot = typeof EQUIP_SLOTS[number];

/** 物品类型 */
export const ITEM_TYPES = ['装备', '消耗品', '材料', '任务物品', '特殊'] as const;
export type ItemType = typeof ITEM_TYPES[number];

/** 7 级品质（世界书 #417617 品质体系） */
export const RARITY_LEVELS = ['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一'] as const;
export type Rarity = typeof RARITY_LEVELS[number];

/** 任务状态（修 #32: 自由字符串 → 4 态枚举） */
export const QUEST_STATUSES = ['进行中', '已完成', '失败', '搁置'] as const;
export type QuestStatus = typeof QUEST_STATUSES[number];

/** 状态效果分类 */
export const STATUS_CATEGORIES = ['增益', '减益', '特殊'] as const;
export type StatusCategory = typeof STATUS_CATEGORIES[number];

// ========== 归一化 ==========

/** slot 别名表（中文变体 + 英文遗留，修 #37 slot 中英双轨） */
const SLOT_ALIASES: Record<string, EquipSlot> = Object.assign(Object.create(null), {
  '主手': '武器', '惯用手': '武器', '副武器': '副手',
  '护甲': '身体', '胸甲': '身体', '衣服': '身体',
  '鞋子': '脚部', '靴子': '脚部', '手套': '手部', '头盔': '头部',
  weapon: '武器', offhand: '副手', head: '头部', armor: '身体',
  hands: '手部', feet: '脚部', belt: '腰带', accessory: '饰品',
});

/** 归一化装备槽位。无法识别返回 null，调用方决定报错或兜底 */
export function normalizeSlot(raw: string): EquipSlot | null {
  const s = (raw ?? '').trim();
  if ((EQUIP_SLOTS as readonly string[]).includes(s)) return s as EquipSlot;
  return SLOT_ALIASES[s] ?? SLOT_ALIASES[s.toLowerCase()] ?? null;
}

/** item type 别名表（英文枚举遗留，修 #38 三套取值） */
const ITEM_TYPE_ALIASES: Record<string, ItemType> = Object.assign(Object.create(null), {
  equipment: '装备', weapon: '装备', armor: '装备',
  consumable: '消耗品', material: '材料', quest: '任务物品', special: '特殊',
  '道具': '特殊',
});

/** 归一化物品类型。无法识别返回 undefined（type 为可选字段） */
export function normalizeItemType(raw: string): ItemType | undefined {
  const s = (raw ?? '').trim();
  if ((ITEM_TYPES as readonly string[]).includes(s)) return s as ItemType;
  return ITEM_TYPE_ALIASES[s] ?? ITEM_TYPE_ALIASES[s.toLowerCase()];
}

/** rarity 别名表（英文遗留 + quality 字段废除后统一入口，修 #39） */
const RARITY_ALIASES: Record<string, Rarity> = Object.assign(Object.create(null), {
  common: '普通', uncommon: '优良', rare: '稀有',
  epic: '史诗', legendary: '传说', mythic: '神话', unique: '唯一',
});

/** 归一化品质。无法识别返回 undefined */
export function normalizeRarity(raw: string): Rarity | undefined {
  const s = (raw ?? '').trim();
  if ((RARITY_LEVELS as readonly string[]).includes(s)) return s as Rarity;
  return RARITY_ALIASES[s.toLowerCase()];
}

/** quest status 别名表 */
const QUEST_STATUS_ALIASES: Record<string, QuestStatus> = Object.assign(Object.create(null), {
  '完成': '已完成', '已结束': '已完成', '完毕': '已完成',
  '进行': '进行中', '正在进行': '进行中', '接受': '进行中',
  '失败了': '失败', '已失败': '失败',
  '暂停': '搁置', '挂起': '搁置', '搁置中': '搁置',
});

/** 归一化任务状态。无法识别兜底 '进行中'（宁可误留活跃也不误杀） */
export function normalizeQuestStatus(raw: string): QuestStatus {
  const s = (raw ?? '').trim();
  if ((QUEST_STATUSES as readonly string[]).includes(s)) return s as QuestStatus;
  return QUEST_STATUS_ALIASES[s] ?? '进行中';
}

/** status category 别名表 */
const STATUS_CATEGORY_ALIASES: Record<string, StatusCategory> = Object.assign(Object.create(null), {
  buff: '增益', debuff: '减益', special: '特殊',
});

/** 归一化状态效果分类。无法识别兜底 '特殊' */
export function normalizeStatusCategory(raw: string): StatusCategory {
  const s = (raw ?? '').trim();
  if ((STATUS_CATEGORIES as readonly string[]).includes(s)) return s as StatusCategory;
  return STATUS_CATEGORY_ALIASES[s.toLowerCase()] ?? '特殊';
}
