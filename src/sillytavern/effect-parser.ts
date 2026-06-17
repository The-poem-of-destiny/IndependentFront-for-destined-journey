/**
 * Effect 声明解析器 — 解析技能/装备/物品的效果声明字符串 (Phase 4.6)
 *
 * 将 JSON 格式的效果声明字符串 (如 "攻击力: +50, DR: 5%, 火焰抗性: +30")
 * 解析为结构化的 ParsedEffect[] 供 CombatResolver/CraftResolver 使用
 */

import type { ParsedEffect } from './types';

// ========== 效果键映射表 ==========

const CHINESE_TO_KEY: Record<string, string> = {
  // 基础属性
  '攻击力': 'atk',
  '防御力': 'def',
  'HP': 'hp',
  'MP': 'mp',
  'SP': 'sp',
  '力量': 'str',
  '敏捷': 'dex',
  '体质': 'con',
  '智力': 'int',
  '精神': 'spi',
  '生命值': 'hp',
  '法力值': 'mp',
  '体力值': 'sp',
  // 战斗属性
  'DR': 'dr',
  '伤害减免': 'dr',
  '命中': 'hit',
  '闪避': 'dodge',
  '暴击率': 'critRate',
  '暴击伤害': 'critDmg',
  '攻速': 'atkSpeed',
  '移速': 'moveSpeed',
  '穿透': 'penetration',
  '穿透率': 'penetration',
  '格挡': 'block',
  // 抗性
  '火焰抗性': 'fireResist',
  '冰霜抗性': 'iceResist',
  '雷电抗性': 'lightningResist',
  '暗影抗性': 'shadowResist',
  '光明抗性': 'lightResist',
  '物理抗性': 'physicalResist',
  '魔法抗性': 'magicResist',
  '精神抗性': 'spiritResist',
  '毒素抗性': 'poisonResist',
  // 伤害加成
  '火焰伤害': 'fireDmg',
  '冰霜伤害': 'iceDmg',
  '雷电伤害': 'lightningDmg',
  '暗影伤害': 'shadowDmg',
  '光明伤害': 'lightDmg',
  '物理伤害': 'physicalDmg',
  '魔法伤害': 'magicDmg',
  // 恢复
  'HP恢复': 'hpRegen',
  'MP恢复': 'mpRegen',
  'SP恢复': 'spRegen',
  '生命恢复': 'hpRegen',
  '法力恢复': 'mpRegen',
  '体力恢复': 'spRegen',
  // 特殊
  '经验加成': 'expBonus',
  '金钱加成': 'moneyBonus',
  '掉落率': 'dropRate',
  '冷却缩减': 'cooldownReduction',
  '技能威力': 'skillPower',
  '治疗效果': 'healPower',
};

// ========== 解析函数 ==========

/** 解析单个效果键值对 (如 "攻击力: +50" → {key:'atk', value:50}) */
function parseSingleEffect(segment: string): ParsedEffect | null {
  const colonIdx = segment.indexOf(':');
  if (colonIdx === -1) return null;

  const rawKey = segment.slice(0, colonIdx).trim();
  const rawValue = segment.slice(colonIdx + 1).trim();

  if (!rawKey || !rawValue) return null;

  // 检测百分比
  const isPercentage = rawValue.includes('%');

  // 提取数值
  const numMatch = rawValue.match(/([+-]?\d+(?:\.\d+)?)/);
  if (!numMatch) return null;

  let value = parseFloat(numMatch[1]);
  const isSubtractive = rawValue.startsWith('-') || value < 0;

  // 标准化键
  const key = normalizeEffectKey(rawKey);

  return { key, rawKey, value, isPercentage, isSubtractive };
}

/** 标准化效果键 (中文 → 英文) */
export function normalizeEffectKey(chineseKey: string): string {
  // 直接查询映射表
  const exact = CHINESE_TO_KEY[chineseKey];
  if (exact) return exact;

  // 模糊匹配: 去除空格后查表
  const normalized = chineseKey.replace(/\s+/g, '');
  for (const [cn, en] of Object.entries(CHINESE_TO_KEY)) {
    if (cn.replace(/\s+/g, '') === normalized) return en;
  }

  // 未匹配: 返回小写 key 自身
  return chineseKey.toLowerCase().replace(/\s+/g, '_');
}

/** 解析完整的效果声明字符串 */
export function parseEffectDeclaration(raw: string): ParsedEffect[] {
  if (!raw || raw.trim().length === 0) return [];

  // 按逗号或分号分割
  const segments = raw.split(/[,;，；]/);
  const effects: ParsedEffect[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    const parsed = parseSingleEffect(trimmed);
    if (parsed) {
      effects.push(parsed);
    }
  }

  return effects;
}

/** 从效果列表中查找指定 key 的值 */
export function getEffectValue(effects: ParsedEffect[], key: string, defaultValue: number = 0): number {
  const effect = effects.find(e => e.key === key);
  return effect ? effect.value : defaultValue;
}

/** 从效果列表中查找所有匹配 key 的总和 */
export function sumEffectValues(effects: ParsedEffect[], key: string): number {
  return effects
    .filter(e => e.key === key)
    .reduce((sum, e) => sum + e.value, 0);
}

// ========== $effect Namespace ==========

export const $effect = {
  parse: parseEffectDeclaration,
  normalizeKey: normalizeEffectKey,
  getValue: getEffectValue,
  sumValues: sumEffectValues,
  mapping: CHINESE_TO_KEY,
} as const;
