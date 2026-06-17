/**
 * 血脉系统 — 最小实现 (Phase 5)
 *
 * 设计决策: 血脉主要是 AI 扮演层的内容（性格/行为/社会地位），
 * Code 层只存标识 + 基础属性修正。完整觉醒/继承/复合机制由 AI 叙事。
 * 种族列表对齐世界书条目 #906373 [种族概览]。
 */

// ========== 已知血脉列表 ==========

/** 静态血脉数据（用于角色创建的参考），对齐世界书种族体系 */
export const KNOWN_BLOODLINES: Record<string, { name: string; description: string; statModifiers?: Partial<Record<string, number>> }> = {
  // ===== 智人种 =====
  'human': {
    name: '人类',
    description: '适应力最强的短寿种族（60-70 岁），欲望驱动，分布最广',
    statModifiers: {},
  },
  'elf': {
    name: '精灵',
    description: '与翠梦乡之树共生的古老种族，天生感知本源之歌，元颂魔法',
    statModifiers: { dex: 2, int: 1 },
  },
  'dwarf': {
    name: '矮人',
    description: '山脉之子（~120cm, 300-350 岁），地下城邦，锻造与胡须文化',
    statModifiers: { con: 2, str: 1 },
  },
  'winged': {
    name: '翼民',
    description: '拥有 3-5m 功能性羽翼的神迹山脉种族，小头翼感知情绪与魔法，以诚实守诺为荣',
    statModifiers: { dex: 2, spi: 1 },
  },
  'merfolk': {
    name: '人鱼',
    description: '半人半鱼的海洋种族（150-300 岁），高魔法亲和，分浅海种与深海种',
    statModifiers: { int: 2, spi: 1 },
  },
  'halfling': {
    name: '半身人',
    description: '~110cm 的小型种族（55-65 岁），城镇中无处不在的工匠与商人',
    statModifiers: { dex: 2, int: 1 },
  },

  // ===== 亚人种 =====
  'beast': {
    name: '兽族',
    description: '耳型种/幻身种（半人马/人鱼），120 岁，部落社会结构',
    statModifiers: { str: 1, dex: 2 },
  },
  'centaur': {
    name: '半人马',
    description: '幻身种兽族，女性上身+马身，平原游牧生活',
    statModifiers: { str: 2, dex: 1 },
  },
  'vampire': {
    name: '血族',
    description: '13 氏族血脉的不死长生种，炼金术诅咒起源，血魔法与恩惠体系社会',
    statModifiers: { dex: 2, con: -1, spi: 2 },
  },
  'undead': {
    name: '不死生物',
    description: '负能量驱动的超越生死者：僵尸/骷髅/幽灵/巫妖，各具不同意识层级',
    statModifiers: { con: -1, spi: 2 },
  },
  'dragonkin_north': {
    name: '北境龙裔',
    description: '人形龙血传承者（1.8-2.2m），竖瞳，龙吼之力',
    statModifiers: { str: 2, con: 2 },
  },

  // ===== 幻身种 =====
  'fairy_lightwing': {
    name: '光翅妖精',
    description: '~30cm 的纯粹自然精魂，蝉/蝶翼，迷恋歌声与故事',
    statModifiers: { int: 2, spi: 2 },
  },
  'slime': {
    name: '不定形生物',
    description: '源初魔力凝胶构成的最基础生物，分布极广，可拟态进化',
    statModifiers: { con: 2 },
  },
  'wish_spirit': {
    name: '愿灵',
    description: '集体意识/祈愿/记忆中诞生的精魂，存在强度取决于被记忆的程度',
    statModifiers: { spi: 3 },
  },
  'construct': {
    name: '构装体',
    description: '魔力驱动的非生命体：魔像/活化物体/自律机器，遵守创造者的指令',
    statModifiers: { str: 2, con: 2 },
  },
  'plant_creature': {
    name: '植物生物',
    description: '自然觉醒或德鲁伊唤醒的植物生命：树精/曼德拉草/真菌',
    statModifiers: { con: 2, spi: 1 },
  },

  // ===== 异界种 =====
  'celestial': {
    name: '天族',
    description: '辉煌神国的天使——神圣秩序之力的具现',
    statModifiers: { spi: 2, int: 1 },
  },
  'demon': {
    name: '魔族',
    description: '魔界/九层地狱的深渊血脉，混沌之力流淌于身',
    statModifiers: { str: 2, spi: 1 },
  },
  'elemental': {
    name: '元素生物',
    description: '四元素位面的造物：火/水/风/土精魂，位面裂隙或高阶召唤而来',
    statModifiers: { int: 2, spi: 1 },
  },

  // ===== 巨人种 =====
  'frost_giant': {
    name: '霜巨人',
    description: '20-40m 的极寒巨人，冰晶发，鲸/猛犸皮衣，诺斯加德冰原的原住民',
    statModifiers: { str: 3, con: 3 },
  },

  // ===== 龙种 =====
  'true_dragon': {
    name: '巨龙',
    description: '四足双翼的元素吐息之主，千岁寿命，第 6 层级世界调节者',
    statModifiers: { str: 3, con: 3, int: 2, spi: 2 },
  },
  'ancient_dragon': {
    name: '古龙',
    description: '神造的世界调节者（第 6 层级），可化人形（龙姬/龙人），无固定肉身',
    statModifiers: { str: 3, int: 3, spi: 3 },
  },
  'drake': {
    name: '亚龙',
    description: '龙血稀释种：地龙/双足飞龙/多头蛇，中层级冒险者的对手',
    statModifiers: { str: 2, con: 2 },
  },
};

// ========== 辅助函数 ==========

/** 获取血脉信息 */
export function getBloodline(id: string) {
  return KNOWN_BLOODLINES[id];
}

/** 获取血脉列表（用于 UI） */
export function getBloodlineList() {
  return Object.entries(KNOWN_BLOODLINES).map(([id, info]) => ({ id, ...info }));
}

/** 计算血脉属性修正总和 */
export function calcBloodlineModifiers(bloodlineIds: string[]): Partial<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const id of bloodlineIds) {
    const bl = KNOWN_BLOODLINES[id];
    if (bl?.statModifiers) {
      for (const [stat, val] of Object.entries(bl.statModifiers)) {
        totals[stat] = (totals[stat] ?? 0) + (val ?? 0);
      }
    }
  }
  return totals;
}
