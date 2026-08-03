/**
 * field-enums.ts — 中文枚举集中定义 + 归一化测试（数据字段规范 铁律5）
 */
import { describe, it, expect } from 'vitest';
import {
  EQUIP_SLOTS,
  ITEM_TYPES,
  RARITY_LEVELS,
  QUEST_STATUSES,
  STATUS_CATEGORIES,
  normalizeSlot,
  normalizeItemType,
  normalizeRarity,
  normalizeQuestStatus,
  normalizeStatusCategory,
} from './field-enums';

describe('枚举常量', () => {
  it('slot 枚举为规范定义的 8 个中文槽位', () => {
    expect(EQUIP_SLOTS).toEqual(['武器', '副手', '头部', '身体', '手部', '脚部', '腰带', '饰品']);
  });
  it('rarity 为 7 级品质', () => {
    expect(RARITY_LEVELS).toEqual(['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一']);
  });
  it('quest status 为 4 态', () => {
    expect(QUEST_STATUSES).toEqual(['进行中', '已完成', '失败', '搁置']);
  });
  it('item type 为 5 类', () => {
    expect(ITEM_TYPES).toEqual(['装备', '消耗品', '材料', '任务物品', '特殊']);
  });
  it('status category 为 3 类', () => {
    expect(STATUS_CATEGORIES).toEqual(['增益', '减益', '特殊']);
  });
});

describe('normalizeSlot', () => {
  it('标准值直通', () => {
    expect(normalizeSlot('武器')).toBe('武器');
  });
  it('中文别名归一: 主手/惯用手→武器, 护甲/胸甲→身体, 鞋子/靴子→脚部', () => {
    expect(normalizeSlot('主手')).toBe('武器');
    expect(normalizeSlot('惯用手')).toBe('武器');
    expect(normalizeSlot('护甲')).toBe('身体');
    expect(normalizeSlot('鞋子')).toBe('脚部');
  });
  it('英文遗留归一: weapon→武器, armor→身体, accessory→饰品', () => {
    expect(normalizeSlot('weapon')).toBe('武器');
    expect(normalizeSlot('armor')).toBe('身体');
    expect(normalizeSlot('accessory')).toBe('饰品');
  });
  it('无法识别返回 null（调用方决定报错或兜底）', () => {
    expect(normalizeSlot('不存在的槽位')).toBeNull();
    expect(normalizeSlot('')).toBeNull();
  });
  it('两侧空白容忍', () => {
    expect(normalizeSlot(' 武器 ')).toBe('武器');
  });
});

describe('normalizeItemType', () => {
  it('标准值直通', () => {
    expect(normalizeItemType('消耗品')).toBe('消耗品');
  });
  it('英文遗留归一: equipment→装备, consumable→消耗品, material→材料, quest→任务物品', () => {
    expect(normalizeItemType('equipment')).toBe('装备');
    expect(normalizeItemType('consumable')).toBe('消耗品');
    expect(normalizeItemType('material')).toBe('材料');
    expect(normalizeItemType('quest')).toBe('任务物品');
  });
  it('weapon/armor 视为装备', () => {
    expect(normalizeItemType('weapon')).toBe('装备');
    expect(normalizeItemType('armor')).toBe('装备');
  });
  it('无法识别返回 undefined（type 可选字段）', () => {
    expect(normalizeItemType('奇怪类型')).toBeUndefined();
  });
});

describe('normalizeRarity', () => {
  it('标准值直通', () => {
    expect(normalizeRarity('史诗')).toBe('史诗');
  });
  it('英文归一: common→普通, rare→稀有, legendary→传说, unique→唯一', () => {
    expect(normalizeRarity('common')).toBe('普通');
    expect(normalizeRarity('rare')).toBe('稀有');
    expect(normalizeRarity('legendary')).toBe('传说');
    expect(normalizeRarity('unique')).toBe('唯一');
  });
  it('uncommon→优良, epic→史诗, mythic→神话', () => {
    expect(normalizeRarity('uncommon')).toBe('优良');
    expect(normalizeRarity('epic')).toBe('史诗');
    expect(normalizeRarity('mythic')).toBe('神话');
  });
  it('无法识别返回 undefined', () => {
    expect(normalizeRarity('五彩斑斓')).toBeUndefined();
  });
  // Q-30 防分叉闸门: start-catalog 池里出现过的每个 rarity 码都必须能被 normalizeRarity 认出。
  // 若 CDN 数据再出新的稀有度编码而 RARITY_ALIASES 没跟上，此测试红灯即分叉。
  it('Q-30 闸门: start-catalog 池的每个稀有度编码都能被 normalizeRarity 认出', () => {
    const catalogCodes = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'only'];
    for (const code of catalogCodes) {
      expect(
        normalizeRarity(code),
        `start-catalog 编码 ${code} 未被 RARITY_ALIASES 认出`,
      ).toBeDefined();
    }
  });
});

describe('normalizeQuestStatus', () => {
  it('标准值直通', () => {
    expect(normalizeQuestStatus('已完成')).toBe('已完成');
  });
  it('变体归一: 完成→已完成, 进行→进行中, 失败了→失败, 暂停/挂起→搁置', () => {
    expect(normalizeQuestStatus('完成')).toBe('已完成');
    expect(normalizeQuestStatus('进行')).toBe('进行中');
    expect(normalizeQuestStatus('失败了')).toBe('失败');
    expect(normalizeQuestStatus('暂停')).toBe('搁置');
    expect(normalizeQuestStatus('挂起')).toBe('搁置');
  });
  it('无法识别兜底为进行中（修 #32: 自由字符串导致误判活跃）', () => {
    expect(normalizeQuestStatus('莫名其妙')).toBe('进行中');
    expect(normalizeQuestStatus('')).toBe('进行中');
  });
});

describe('normalizeStatusCategory', () => {
  it('标准值直通', () => {
    expect(normalizeStatusCategory('减益')).toBe('减益');
  });
  it('英文归一: buff→增益, debuff→减益, special→特殊', () => {
    expect(normalizeStatusCategory('buff')).toBe('增益');
    expect(normalizeStatusCategory('debuff')).toBe('减益');
    expect(normalizeStatusCategory('special')).toBe('特殊');
  });
  it('无法识别兜底为特殊', () => {
    expect(normalizeStatusCategory('未知')).toBe('特殊');
  });
});

describe('原型键安全（M2 硬前置: AI 提名值可能是任意字符串）', () => {
  it('normalizeSlot 对原型键返回 null 而非原型成员', () => {
    expect(normalizeSlot('constructor')).toBeNull();
    expect(normalizeSlot('toString')).toBeNull();
    expect(normalizeSlot('__proto__')).toBeNull();
  });
  it('normalizeItemType/normalizeRarity 对原型键返回 undefined', () => {
    expect(normalizeItemType('constructor')).toBeUndefined();
    expect(normalizeRarity('valueOf')).toBeUndefined();
  });
  it('normalizeQuestStatus/normalizeStatusCategory 对原型键走兜底', () => {
    expect(normalizeQuestStatus('constructor')).toBe('进行中');
    expect(normalizeStatusCategory('toString')).toBe('特殊');
  });
  it('normalizeItemType 的 special/道具 别名（M1 测试缺口）', () => {
    expect(normalizeItemType('special')).toBe('特殊');
    expect(normalizeItemType('道具')).toBe('特殊');
  });
});
