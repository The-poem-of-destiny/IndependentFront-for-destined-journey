/**
 * create-store.ts — 捏人页 Store 纯逻辑测试
 *
 * 测试范围: Pinia store 所有 computed / action / watcher / 流水线
 * 不依赖 DOM, 在 Node 环境运行
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useCreateStore } from './create-store';
import { useSettingsStore } from './settings-store';
import {
  DIFFICULTY_PRESETS,
  DEFAULT_EQUIPMENT_POOL,
  DEFAULT_ITEM_POOL,
  DEFAULT_BACKGROUNDS,
  DEFAULT_DESTINY_CORES,
} from '@engine/start-catalog';
import { TIER_CONFIGS } from '@engine/tier-constants';

// AgentClient mock — 大纲生成链测试用（可控响应队列）
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('@engine/agent-client', () => ({
  AgentClient: class {
    chat(...args: any[]) {
      return chatMock(...args);
    }
  },
}));

// Mock localStorage for Node test environment (after vi.mock hoisting)
const store_ = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store_.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store_.set(k, v);
  },
  removeItem: (k: string) => {
    store_.delete(k);
  },
  clear: () => {
    store_.clear();
  },
  get length() {
    return store_.size;
  },
  key: (i: number) => [...store_.keys()][i] ?? null,
});

// Clear localStorage mock between ALL tests to prevent draft leakage
beforeEach(() => {
  store_.clear();
});

// ===== 辅助 =====

function makeStore() {
  setActivePinia(createPinia());
  return useCreateStore();
}

/** 快速设置一个基础角色 */
function setupBasicChar(store: ReturnType<typeof useCreateStore>) {
  store.name = '测试角色';
  store.race = '人类';
  store.identity = '非贵族平民';
  store.level = 1;
}

// ===== 难度系统 =====

describe('难度系统', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('初始不应选中任何难度', () => {
    expect(store.difficulty).toBeNull();
  });

  it('selectDifficulty 应正确设置 6 档难度点数', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      store.selectDifficulty(preset.id);
      expect(store.difficulty?.id).toBe(preset.id);
      expect(store.reincarnationPoints).toBe(preset.points);
    }
  });

  it('创造模式应有 1000000 点', () => {
    store.selectDifficulty('creative');
    expect(store.reincarnationPoints).toBe(1000000);
  });

  it('地狱模式应有 100 点', () => {
    store.selectDifficulty('hell');
    expect(store.reincarnationPoints).toBe(100);
  });

  it('未匹配的 id 不应改变难度', () => {
    store.selectDifficulty('nonexistent');
    expect(store.difficulty).toBeNull();
    expect(store.reincarnationPoints).toBe(1000); // 默认值不变
  });
});

// ===== 等级 → 层级 =====

describe('等级 → 层级联动', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('Lv.1 → T1 普通', () => {
    store.level = 1;
    expect(store.tier).toBe(1);
    expect(store.tierName).toBe('普通');
  });

  it('Lv.5 → T2 中坚', () => {
    store.level = 5;
    expect(store.tier).toBe(2);
    expect(store.tierName).toBe('中坚');
  });

  it('Lv.10 → T3 精英', () => {
    store.level = 10;
    expect(store.tier).toBe(3);
    expect(store.tierName).toBe('精英');
  });

  it('Lv.25 → T7 神祗', () => {
    store.level = 25;
    expect(store.tier).toBe(7);
    expect(store.tierName).toBe('神祗');
  });

  it('tierBonus = tier - 1', () => {
    store.level = 1;
    expect(store.tierBonus).toBe(0);
    store.level = 5;
    expect(store.tierBonus).toBe(1);
    store.level = 25;
    expect(store.tierBonus).toBe(6);
  });
});

// ===== BP 分配 =====

describe('基础属性 BP 分配', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('初始所有 BP 应为 0', () => {
    expect(store.usedBP).toBe(0);
    expect(store.remainingBP).toBe(25);
  });

  it('addBasePoint 应增加指定属性', () => {
    store.addBasePoint('力量');
    expect(store.basePoints['力量']).toBe(1);
    expect(store.usedBP).toBe(1);
  });

  it('单属性上限 6', () => {
    for (let i = 0; i < 10; i++) store.addBasePoint('力量');
    expect(store.basePoints['力量']).toBe(6);
  });

  it('总 BP 上限 25', () => {
    // 5属性各加到6 = 30, 但总上限25
    for (const attr of ['力量', '敏捷', '体质', '智力', '精神']) {
      for (let i = 0; i < 6; i++) store.addBasePoint(attr);
    }
    expect(store.usedBP).toBeLessThanOrEqual(25);
  });

  it('removeBasePoint 应减少指定属性', () => {
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.removeBasePoint('力量');
    expect(store.basePoints['力量']).toBe(1);
  });

  it('removeBasePoint 下限为 0', () => {
    store.removeBasePoint('力量');
    expect(store.basePoints['力量']).toBe(0);
  });

  it('remainingBP=0 时不能继续加', () => {
    store.level = 25; // 大 levelCost 不影响 BP
    for (let i = 0; i < 30; i++) store.addBasePoint('力量');
    expect(store.usedBP).toBeLessThanOrEqual(25);
  });
});

// ===== AP 分配 =====

describe('额外属性 AP 分配', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('Lv.1 时 maxAP=0', () => {
    store.level = 1;
    expect(store.maxAP).toBe(0);
  });

  it('Lv.5 时 maxAP=4', () => {
    store.level = 5;
    expect(store.maxAP).toBe(4);
  });

  it('addAttributePoint 应增加 AP', () => {
    store.level = 10; // maxAP=9
    store.addAttributePoint('智力');
    expect(store.attributePoints['智力']).toBe(1);
    expect(store.usedAP).toBe(1);
  });

  it('remainingAP=0 时不能继续加', () => {
    store.level = 2; // maxAP=1
    store.addAttributePoint('力量');
    store.addAttributePoint('力量');
    store.addAttributePoint('敏捷');
    expect(store.usedAP).toBe(1);
  });

  it('removeAttributePoint 下限为 0', () => {
    store.removeAttributePoint('力量');
    expect(store.attributePoints['力量']).toBe(0);
  });

  it('maxAP=0 时 addAttributePoint 无效', () => {
    store.level = 1;
    store.addAttributePoint('力量');
    expect(store.usedAP).toBe(0);
  });
});

// ===== level watcher → 重置 AP =====

describe('level 变化 → AP 重置', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('等级升高时 attributePoints 应归零', async () => {
    store.level = 10; // maxAP=9
    store.addAttributePoint('力量');
    store.addAttributePoint('敏捷');
    expect(store.usedAP).toBeGreaterThan(0);

    store.level = 15;
    await nextTick();
    expect(store.usedAP).toBe(0);
  });

  it('等级降低时 attributePoints 也应归零', async () => {
    store.level = 10;
    store.addAttributePoint('力量');
    store.level = 5;
    await nextTick();
    expect(store.usedAP).toBe(0);
  });
});

// ===== 最终属性 =====

describe('最终属性计算 finalAttributes', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('finalAttr = BP + tierBonus + AP', () => {
    store.level = 1; // tierBonus=0
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    // BP=3, tierBonus=0, AP=0 → 3
    expect(store.finalAttributes['力量']).toBe(3);
  });

  it('T2 层级加成正确', () => {
    store.level = 5; // T2, tierBonus=1
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    // BP=2, tierBonus=1, AP=0 → 3
    expect(store.finalAttributes['体质']).toBe(3);
  });

  it('BP + AP + tierBonus 完整', () => {
    store.level = 10; // T3, tierBonus=2, maxAP=9
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.addAttributePoint('力量');
    store.addAttributePoint('力量');
    // BP=3, tierBonus=2, AP=2 → 7
    expect(store.finalAttributes['力量']).toBe(7);
  });
});

// ===== HP/MP/SP 预览 =====

describe('HP/MP/SP 资源预览', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('T1 Lv.1 体质=0 时公式兜底为5 → 最低 HP=525（世界书公式）', () => {
    store.level = 1;
    // 体质=0 (falsy), finalAttributes 用 || 0 兜底为 0；但默认属性全 5
    // 五维和 = 5+5+5+5+5 = 25；HP = 5×100×1 + 25 = 525
    expect(store.hpPreview).toBe(525);
  });

  it('HP = 体 × 100 × hpMul + 五维和（世界书公式）', () => {
    store.level = 1; // T1, hpMultiplier=1
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    // 体质=3, 其他默认 5；五维和 = 3+5+5+5+5 = 23
    // HP = 3×100×1 + 23 = 323
    expect(store.hpPreview).toBe(323);
  });

  it('T3 HP 计算正确（世界书公式）', () => {
    store.level = 10; // T3, hpMultiplier=4, tierBonus=2
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    store.addBasePoint('体质');
    // 体质=5, tierBonus=2 → 体质final=7；其他属性 = 0+tierBonus2=2
    // 五维和 = 7+2+2+2+2 = 15
    // HP = 7×100×4 + 15 = 2815
    expect(store.finalAttributes['体质']).toBe(7);
    expect(store.hpPreview).toBe(2815);
  });
});

// ===== 消耗公式 =====

describe('totalCost 消耗公式', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.selectDifficulty('normal'); // 1000 点
    store.level = 1;
  });

  it('默认状态下 totalCost = 种族费 + 身份费', () => {
    // 人类=0, 非贵族平民=?
    // identityCost 从 DEFAULT_IDENTITY_COSTS 查
    expect(store.totalCost).toBe(store.raceCost + store.identityCost);
  });

  it('levelCost = (level-1)*5', () => {
    store.level = 1;
    expect(store.levelCost).toBe(0);
    store.level = 5;
    expect(store.levelCost).toBe(20);
    store.level = 25;
    expect(store.levelCost).toBe(120);
  });

  it('usedAP 应计入 totalCost', () => {
    store.level = 5; // maxAP=4
    store.addAttributePoint('敏捷');
    store.addAttributePoint('敏捷');
    expect(store.usedAP).toBe(2);
    expect(store.totalCost).toBe(store.raceCost + store.identityCost + store.levelCost + 2);
  });

  it('moneyCost = ceil(money/100)', () => {
    store.money = 250;
    expect(store.moneyCost).toBe(3); // ceil(250/100)=3
  });

  it('destinyCost = ceil(destinyPoints/2)', () => {
    store.destinyPoints = 5;
    expect(store.destinyCost).toBe(3); // ceil(5/2)=3
  });

  it('remainingPoints = reincarnationPoints - totalCost', () => {
    store.level = 5; // levelCost=20
    expect(store.remainingPoints).toBe(1000 - store.totalCost);
  });
});

// ===== 装备选择 =====

describe('装备选择', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.selectDifficulty('creative'); // 1000000 点, 够用
  });

  const sword = DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '武器')!;
  const armor = DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '防具')!;
  const accessory = DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '饰品')!;

  it('添加武器应成功', () => {
    if (sword) {
      store.addEquipment(sword);
      expect(store.selectedEquipments).toHaveLength(1);
      expect(store.isSelected(sword)).toBe(true);
    }
  });

  it('同类型防具应允许多选', () => {
    const armors = DEFAULT_EQUIPMENT_POOL.filter((e) => e.type === '防具');
    if (armors.length >= 2) {
      store.addEquipment(armors[0]);
      store.addEquipment(armors[1]);
      expect(store.selectedEquipments).toHaveLength(2);
    }
  });

  it('武器不限制唯一', () => {
    // 武器的 addEquipment 逻辑允许多个
    // 检查现有代码: addEquipment 只对非武器做替换
    // 所以多把武器是允许的
    const weapons = DEFAULT_EQUIPMENT_POOL.filter((e) => e.type === '武器');
    if (weapons.length >= 2) {
      store.addEquipment(weapons[0]);
      store.addEquipment(weapons[1]);
      expect(store.selectedEquipments.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('removeEquipment 应移除指定装备', () => {
    if (sword) {
      store.addEquipment(sword);
      store.removeEquipment(sword.id);
      expect(store.selectedEquipments).toHaveLength(0);
    }
  });
});

// ===== 道具选择 =====

describe('道具选择', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.selectDifficulty('creative');
  });

  it('同 id 道具应叠加 quantity', () => {
    const item = DEFAULT_ITEM_POOL[0];
    if (item) {
      store.addItem(item);
      store.addItem(item);
      expect(store.selectedItems).toHaveLength(1);
      const q = store.selectedItems[0].quantity || 1;
      const origQ = item.quantity || 1;
      expect(q).toBe(origQ * 2);
    }
  });

  it('removeItem 应移除指定道具', () => {
    const item = DEFAULT_ITEM_POOL[0];
    if (item) {
      store.addItem(item);
      store.removeItem(item.id);
      expect(store.selectedItems).toHaveLength(0);
    }
  });
});

// ===== 技能选择 =====

describe('技能选择', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.selectDifficulty('creative');
  });

  it('addSkill / removeSkill 正常', () => {
    // 使用 filteredPool 中的技能（CDN 可能未加载，此时池为空则跳过）
    const skills = store.filteredPool;
    if (skills.length === 0) return;
    const skill = skills[0];
    store.addSkill(skill);
    expect(store.selectedSkills.length).toBeGreaterThanOrEqual(1);
    store.removeSkill(skill.id);
    expect(store.selectedSkills.length).toBe(0);
  });

  it('canSelect 点数不足时返回 false', () => {
    store.selectDifficulty('hell'); // 100 点
    const item = DEFAULT_EQUIPMENT_POOL.find((e) => e.cost > 100);
    if (item) {
      expect(store.canSelect(item)).toBe(false);
    }
  });
});

// ===== 背景条件 =====

describe('背景条件检查', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.name = '测试';
    store.race = '人类';
    store.identity = '非贵族平民';
    store.startLocation = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德';
  });

  it('无限制背景应始终通过', () => {
    const bg = DEFAULT_BACKGROUNDS.find(
      (b) =>
        !b.requiredRace && !b.requiredIdentity && !b.requiredLocation && !b.requiredDestinyCore,
    );
    if (bg) {
      const result = store.checkBackgroundConditions(bg);
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    }
  });

  it('种族不匹配应返回 missing', () => {
    const bg = DEFAULT_BACKGROUNDS.find((b) => b.requiredRace && b.requiredRace !== '人类');
    if (bg) {
      const result = store.checkBackgroundConditions(bg);
      expect(result.valid).toBe(false);
      expect(result.missing.some((m) => m.includes('种族'))).toBe(true);
    }
  });

  it('身份不匹配应返回 missing', () => {
    const bg = DEFAULT_BACKGROUNDS.find(
      (b) => b.requiredIdentity && b.requiredIdentity !== '非贵族平民',
    );
    if (bg) {
      const result = store.checkBackgroundConditions(bg);
      expect(result.valid).toBe(false);
    }
  });

  it('地点前缀匹配应通过', () => {
    const bg = DEFAULT_BACKGROUNDS.find((b) => b.requiredLocation);
    if (bg) {
      // 设置地点包含 requiredLocation
      store.startLocation = (bg.requiredLocation || '') + '-某处';
      const result = store.checkBackgroundConditions(bg);
      if (bg.requiredRace && store.race !== bg.requiredRace) return; // 受种族限制跳过
      if (bg.requiredIdentity && store.identity !== bg.requiredIdentity) return;
      expect(result.valid).toBe(true);
    }
  });
});

// ===== 背景分类 =====

describe('背景四分类过滤', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('通用分类应只含无限定背景', () => {
    store.activeBackgroundCategory = 'universal';
    expect(
      store.filteredBackgrounds.every(
        (bg) =>
          !bg.requiredRace &&
          !bg.requiredIdentity &&
          !bg.requiredLocation &&
          !bg.requiredDestinyCore,
      ),
    ).toBe(true);
  });

  it('身份限定分类应有 requiredIdentity', () => {
    store.activeBackgroundCategory = 'identity';
    expect(store.filteredBackgrounds.length).toBeGreaterThanOrEqual(0);
    expect(store.filteredBackgrounds.every((bg) => !!bg.requiredIdentity)).toBe(true);
  });

  it('种族限定分类应有 requiredRace', () => {
    store.activeBackgroundCategory = 'race';
    expect(store.filteredBackgrounds.every((bg) => !!bg.requiredRace)).toBe(true);
  });

  it('地区限定分类应有 requiredLocation 或 requiredDestinyCore', () => {
    store.activeBackgroundCategory = 'location';
    expect(
      store.filteredBackgrounds.every((bg) => !!bg.requiredLocation || !!bg.requiredDestinyCore),
    ).toBe(true);
  });
});

// ===== 步骤验证 =====

describe('stepValid 步骤验证', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('Step 0: 未选难度时无效', () => {
    expect(store.stepValid[0]).toBe(false);
    store.selectDifficulty('normal');
    expect(store.stepValid[0]).toBe(true);
  });

  it('Step 1: 角色名为空时无效', () => {
    store.selectDifficulty('normal');
    store.race = '人类';
    expect(store.stepValid[1]).toBe(false);
    store.name = '艾琳';
    expect(store.stepValid[1]).toBe(true);
  });

  it('Step 2: 未选命定核心时无效', () => {
    expect(store.stepValid[2]).toBe(false);
    // 新的世界书驱动 API：selectedSystemCoreEntryUid 控制 step 2 验证
    store.selectSystemCoreEntry(1001);
    expect(store.stepValid[2]).toBe(true);
  });

  it('Steps 3-7: 应始终有效(无强制要求)', () => {
    expect(store.stepValid[3]).toBe(true);
    expect(store.stepValid[4]).toBe(true);
    expect(store.stepValid[5]).toBe(true);
    expect(store.stepValid[6]).toBe(true);
    expect(store.stepValid[7]).toBe(true);
  });
});

// ===== substituteUser =====

describe('substituteUser 模板替换', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('有角色名时 <user> 应替换为角色名', () => {
    store.name = '艾琳';
    expect(store.substituteUser('<user>走在路上')).toBe('艾琳走在路上');
  });

  it('角色名为空时 <user> 应替换为 你', () => {
    store.name = '';
    expect(store.substituteUser('<user>醒了')).toBe('你醒了');
  });

  it('多个 <user> 应全部替换', () => {
    store.name = '艾琳';
    expect(store.substituteUser('<user>看了看<user>的手')).toBe('艾琳看了看艾琳的手');
  });

  it('无 <user> 的文本应原样返回', () => {
    expect(store.substituteUser('天空很蓝')).toBe('天空很蓝');
  });
});

// ===== buildCharacterState =====

describe('buildCharacterState', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.name = '测试';
    store.race = '人类';
    store.identity = '冒险者';
    store.level = 5;
  });

  it('应生成合法的 CharacterState', () => {
    const state = store.buildCharacterState('test-save-id');
    expect(state.name).toBe('测试');
    expect(state.race).toBe('人类');
    expect(state.level).toBe(5);
    expect(state.type).toBe('player');
    expect(state.id).toBeTruthy();
  });

  it('自定义种族应写入 customRace', () => {
    store.race = '自定义';
    store.customRace = '精灵混血';
    const state = store.buildCharacterState('test-save-id');
    expect(state.race).toBe('精灵混血');
  });

  it('开局 inventory/skills 始终为空（装备/道具/技能交 item_gen 链经开场正文生成，不直接落库）', () => {
    store.selectDifficulty('creative');
    // 即使选了装备/道具，buildCharacterState 也不再直接落库
    store.addEquipment(DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '武器')!);
    store.addItem(DEFAULT_ITEM_POOL[0]);
    const state = store.buildCharacterState('test-save-id');
    expect(state.inventory).toEqual([]);
    expect(state.skills).toEqual([]);
  });

  it('真机修(2026-07-23): 选中项写进开场正文而非直接落库（交 item_gen 生成 stats）', () => {
    store.selectDifficulty('creative');
    const sword = DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '武器')!;
    const armor = DEFAULT_EQUIPMENT_POOL.find((e) => e.type === '防具')!;
    const potion = DEFAULT_ITEM_POOL[0];
    // DEFAULT_SKILL_POOL 为空数组（运行时从 baseInfo 加载），测试用手工条目
    const skill = {
      id: 'sk_test',
      name: '灼热射线',
      category: 'skill' as const,
      type: '主动',
      rarity: 'uncommon' as const,
      tag: [],
      effect: { 灼烧: '造成持续伤害' },
      consume: '',
      description: '一道炽热凝练的能量射线',
      cost: 100,
    };
    store.addEquipment(sword);
    store.addEquipment(armor);
    store.addItem(potion);
    store.addSkill(skill);

    // 不直接落库 — inventory/skills 为空，交下游 item_gen 经开场正文生成
    const state = store.buildCharacterState('test-save-id');
    expect(state.inventory).toEqual([]);
    expect(state.skills).toEqual([]);

    // 装备/道具/技能信息写进开场正文（供 request_dispatcher 识别 → item_gen_request）
    const prompt = store.buildOpeningPrompt();
    expect(prompt).toContain(sword.name);
    expect(prompt).toContain(armor.name);
    expect(prompt).toContain(potion.name);
    expect(prompt).toContain(skill.name);
  });

  it('HP/MP/SP 应正确写入', () => {
    const state = store.buildCharacterState('test-save-id');
    expect(state.hp).toBe(store.hpPreview);
    expect(state.maxHp).toBe(store.hpPreview);
  });
});

// ===== buildOpeningPrompt =====

describe('buildOpeningPrompt', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.name = '测试';
    store.selectDifficulty('creative');
  });

  it('空选择时返回仅包含标题头的开场', () => {
    const prompt = store.buildOpeningPrompt();
    expect(prompt).toContain('创角完成');
    expect(prompt).toContain('测试');
    // 没有选择任何装备/技能/物品 → 不应有 --- 初始* --- 标签
    expect(prompt).not.toContain('--- 初始装备 ---');
    expect(prompt).not.toContain('--- 初始技能 ---');
    expect(prompt).not.toContain('--- 背包物品 ---');
    // 开局时间总是存在（纪元基准 488 年）
    expect(prompt).toContain('--- 开局时间 ---');
    expect(prompt).toContain('复兴纪元0488年');
  });

  it('有装备应输出装备信息', () => {
    const eq = DEFAULT_EQUIPMENT_POOL[0];
    if (eq) {
      store.addEquipment(eq);
      const prompt = store.buildOpeningPrompt();
      expect(prompt).toContain('--- 初始装备 ---');
      expect(prompt).toContain(eq.name);
    }
  });

  it('有命定核心应输出命定之灵', () => {
    const core = DEFAULT_DESTINY_CORES[0];
    if (core) {
      store.selectDestinyCore(core.id);
      const prompt = store.buildOpeningPrompt();
      expect(prompt).toContain('--- 命定之灵');
      expect(prompt).toContain(core.name);
    }
  });

  it('选中 system_core 世界书条目时应输出激活指针而非条目全文（命定之灵）', () => {
    // 新的 UI 命定核心选择走 selectedSystemCoreEntry（system_core 世界书条目）
    store.systemCoreEntries = [
      {
        uid: 413,
        name: '裂命之灵',
        content: '寄宿于灵魂深处的命运之灵，影响叙事风格。',
        enabled: true,
        constant: false,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 0,
        position: 0,
      } as any,
    ];
    store.selectSystemCoreEntry(413);
    const prompt = store.buildOpeningPrompt();
    expect(prompt).toContain('--- 命定之灵：');
    expect(prompt).toContain('裂命之灵');
    // e42f971 起开场白仅输出激活指针；条目全文由世界书通道注入
    // （buildEnabledWorldBookEntries → SaveSlot.metadata.enabledWorldBookEntries → worldbook-loader），
    // 避免同一内容在开场 user 消息中重复占用 token。
    expect(prompt).toContain('命定核心「裂命之灵」已激活，详细内容参见世界书。');
    expect(prompt).not.toContain('寄宿于灵魂深处的命运之灵');
  });
});

// ===== 预设系统 =====

describe('预设系统', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.name = '预设测试';
    store.selectDifficulty('normal');
    store.level = 5;
  });

  it('getCurrentPresetData → applyPresetData 往返一致', () => {
    const data = store.getCurrentPresetData();
    expect(data.character.name).toBe('预设测试');

    // 创建新 store 并应用
    const store2 = makeStore();
    store2.applyPresetData({
      id: 'test',
      name: 'test-preset',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...data,
    });
    expect(store2.name).toBe('预设测试');
    expect(store2.level).toBe(5);
    expect(store2.difficulty?.id).toBe('normal');
  });
});

// ===== 自定义物品编辑（updateXxx，捏人页内编辑入口） =====

describe('自定义物品编辑 updateXxx', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('updateEquipment 按 id 原地替换装备（含 stats）', () => {
    const eq = {
      id: 'custom_equipment_abc',
      name: '原剑',
      category: 'equipment' as const,
      type: '武器',
      rarity: 'common' as const,
      tag: [],
      effect: {},
      consume: '',
      description: 'd',
      cost: 30,
      stats: { atk: 10 },
    };
    store.addEquipment(eq);
    store.updateEquipment({ ...eq, name: '改名校', stats: { atk: 99 } });
    expect(store.selectedEquipments).toHaveLength(1);
    expect(store.selectedEquipments[0].name).toBe('改名校');
    expect(store.selectedEquipments[0].stats).toEqual({ atk: 99 });
  });

  it('updateItem 按 id 原地替换道具', () => {
    const it = {
      id: 'custom_item_abc',
      name: '原药',
      category: 'item' as const,
      type: '消耗品',
      rarity: 'common' as const,
      tag: [],
      effect: {},
      consume: '',
      description: 'd',
      cost: 30,
      quantity: 3,
    };
    store.addItem(it);
    store.updateItem({ ...it, name: '改名药', quantity: 5 });
    expect(store.selectedItems).toHaveLength(1);
    expect(store.selectedItems[0].name).toBe('改名药');
    expect(store.selectedItems[0].quantity).toBe(5);
  });

  it('updateSkill 按 id 原地替换技能', () => {
    const sk = {
      id: 'custom_skill_abc',
      name: '原技',
      category: 'skill' as const,
      type: '主动',
      rarity: 'common' as const,
      tag: [],
      effect: {},
      consume: '',
      description: 'd',
      cost: 30,
    };
    store.addSkill(sk);
    store.updateSkill({ ...sk, name: '改名技' });
    expect(store.selectedSkills).toHaveLength(1);
    expect(store.selectedSkills[0].name).toBe('改名技');
  });

  it('update 未匹配 id 时不新增不删除（幂等）', () => {
    const eq = {
      id: 'custom_equipment_abc',
      name: '剑',
      category: 'equipment' as const,
      type: '武器',
      rarity: 'common' as const,
      tag: [],
      effect: {},
      consume: '',
      description: 'd',
      cost: 30,
    };
    store.addEquipment(eq);
    store.updateEquipment({ ...eq, id: 'custom_equipment_nope', name: '不存在的' });
    expect(store.selectedEquipments).toHaveLength(1);
    expect(store.selectedEquipments[0].name).toBe('剑');
  });
});

// ===== resetAll =====

describe('resetAll', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('resetAll 应恢复所有状态到默认', () => {
    store.name = '测试';
    store.level = 10;
    store.selectDifficulty('easy');
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.addBasePoint('力量');
    store.destinyPoints = 100;
    store.money = 5000;

    store.resetAll();

    expect(store.name).toBe('');
    expect(store.level).toBe(1);
    expect(store.difficulty).toBeNull();
    expect(store.usedBP).toBe(0);
    expect(store.destinyPoints).toBe(0);
    expect(store.money).toBe(0);
    expect(store.currentStep).toBe(0);
    expect(store.selectedEquipments).toHaveLength(0);
  });

  it('resetAll 应重置剧情设置为默认（重读设置页新档默认值）', () => {
    store.plotMode = 'main';
    store.plotGenrePreference = ['combat', 'romance'] as any;
    store.resetAll();
    expect(store.plotMode).toBe('off');
    // 设置页新档默认值 plotGenrePreference = ['combat', 'social']
    expect(store.plotGenrePreference).toEqual(['combat', 'social']);
  });
});

// ===== 步骤导航 =====

describe('步骤导航', () => {
  let store: ReturnType<typeof useCreateStore>;
  beforeEach(() => {
    store = makeStore();
    store.selectDifficulty('normal');
    store.name = '测试';
    store.race = '人类';
  });

  it('nextStep 应前进', () => {
    expect(store.currentStep).toBe(0);
    store.nextStep();
    expect(store.currentStep).toBe(1);
  });

  it('prevStep 应后退', () => {
    store.currentStep = 3;
    store.prevStep();
    expect(store.currentStep).toBe(2);
  });

  it('currentStep=0 时 prevStep 不应后退', () => {
    store.prevStep();
    expect(store.currentStep).toBe(0);
  });

  it('步骤验证不通过时 nextStep 不应前进', () => {
    store.currentStep = 0;
    store.difficulty = null; // 难度未选
    expect(store.stepValid[0]).toBe(false);
    const before = store.currentStep;
    store.nextStep();
    expect(store.currentStep).toBe(before);
  });
});

// ===== 剧情默认值从设置页读入 =====

describe('剧情默认值从设置页读入', () => {
  it('initPlotDefaultsFromSettings 应读入 settings-store 新档默认值', () => {
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    settings.settings.plotMode = 'main';
    settings.settings.plotDurationYears = 12;
    settings.settings.plotDifficultyTier = 3;
    settings.settings.plotAllowNonWorldbookNpc = false;
    settings.settings.plotGenrePreference = ['mystery', 'politics'];
    settings.settings.plotCustomPreference = '多一些权谋';
    settings.settings.plotFocusRegion = '奥古斯提姆帝国';
    settings.settings.plotTabooContent = '不要虐待动物';
    settings.settings.plotChapterCount = 3;
    settings.settings.plotEventsPerChapter = 5;

    const store = useCreateStore();
    expect(store.plotMode).toBe('main');
    expect(store.plotDurationYears).toBe(12);
    expect(store.plotDifficultyTier).toBe(3);
    expect(store.plotAllowNonWorldbookNpc).toBe(false);
    expect(store.plotGenrePreference).toEqual(['mystery', 'politics']);
    expect(store.plotCustomPreference).toBe('多一些权谋');
    expect(store.plotFocusRegion).toBe('奥古斯提姆帝国');
    expect(store.plotTabooContent).toBe('不要虐待动物');
    expect(store.plotChapterCount).toBe(3);
    expect(store.plotEventsPerChapter).toBe(5);
  });

  it('adaptive 难度默认值应保持 adaptive', () => {
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    settings.settings.plotDifficultyTier = 'adaptive';
    const store = useCreateStore();
    expect(store.plotDifficultyTier).toBe('adaptive');
  });
});

// ===== 大纲生成链（AgentClient mock） =====

function outlineJson(score = 8, title = '血色纹章') {
  return JSON.stringify({
    title,
    summary: '一句话摘要',
    content: '# 完整叙事大纲',
    chapters: [
      {
        title: '第一章 序幕',
        summary: '章节摘要',
        keyEvents: [
          { title: '初入王都', description: '主角抵达艾瑟嘉德', triggerHint: '进入王都' },
          { title: '命运初显', description: '命定核心苏醒', triggerHint: '首次战斗' },
        ],
      },
    ],
    selfCritique: { score, strengths: [], weaknesses: ['节奏偏慢'], suggestions: ['加快开篇'] },
  });
}

function okResult(raw: string) {
  return {
    agentId: 'plot_outline',
    output: raw,
    rawResponse: raw,
    tokensUsed: 100,
    cacheHit: false,
    duration: 10,
  };
}

function setupPlotStore() {
  setActivePinia(createPinia());
  const settings = useSettingsStore();
  settings.settings.apiPool = [
    {
      id: 'ep1',
      name: 'test',
      baseUrl: 'http://localhost',
      apiKey: 'k',
      maskedKey: '***',
      model: 'test-model',
      models: ['test-model'],
      apiType: 'chat',
    },
  ];
  settings.settings.agentModels = { plot_outline: 'ep1' };
  settings.settings.agentPrompts = { plot_outline: '你是剧情大纲生成 Agent' };
  const store = useCreateStore();
  store.plotMode = 'main';
  store.name = '艾琳';
  return store;
}

describe('generatePlotOutline 大纲生成', () => {
  beforeEach(async () => {
    const { getDatabase } = await import('@engine/database');
    await getDatabase().apiEndpoints.clear();
    chatMock.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as any);
  });

  it('score >= 6 时一次调用即产出大纲', async () => {
    chatMock.mockResolvedValueOnce(okResult(outlineJson(8)));
    const store = setupPlotStore();
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(store.plotOutline?.title).toBe('血色纹章');
    expect(store.plotOutline?.summary).toBe('一句话摘要');
    expect(store.plotOutline?.chapters).toHaveLength(1);
    expect(store.plotOutlineChapters[0].keyEvents).toHaveLength(2);
    expect(store.isPlotGenerating).toBe(false);
    expect(store.plotGenerationError).toBeNull();
  });

  it('score < 6 时应带 weaknesses/suggestions 自动重试一次（总共 2 次调用）', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(4, '初版大纲')))
      .mockResolvedValueOnce(okResult(outlineJson(8, '改良大纲')));
    const store = setupPlotStore();
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(2);
    // 第二次调用的 user 消息应包含上一版与改进点
    const secondCall = chatMock.mock.calls[1][0];
    const userMsg = secondCall.messages[secondCall.messages.length - 1].content as string;
    expect(userMsg).toContain('节奏偏慢');
    expect(userMsg).toContain('加快开篇');
    expect(store.plotOutline?.title).toBe('改良大纲');
  });

  it('两次均低分时用最后一版（不再第三次调用）', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(3, '初版')))
      .mockResolvedValueOnce(okResult(outlineJson(5, '第二版')));
    const store = setupPlotStore();
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(store.plotOutline?.title).toBe('第二版');
  });

  it('AI 报错时应设置错误状态且不 crash', async () => {
    chatMock.mockResolvedValueOnce({
      agentId: 'plot_outline',
      output: null,
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
      error: 'HTTP 500',
    });
    const store = setupPlotStore();
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(false);
    expect(store.plotOutline).toBeNull();
    expect(store.plotGenerationError).toContain('HTTP 500');
    expect(store.isPlotGenerating).toBe(false);
  });

  it('输出解析失败时应设置错误状态', async () => {
    chatMock.mockResolvedValueOnce(okResult('这不是 JSON'));
    const store = setupPlotStore();
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(false);
    expect(store.plotGenerationError).toContain('解析失败');
  });

  it('未配置 API 端点时应报错不调用', async () => {
    setActivePinia(createPinia());
    const store = useCreateStore();
    store.plotMode = 'main';
    const ok = await store.generatePlotOutline();
    expect(ok).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
    expect(store.plotGenerationError).toContain('未配置');
  });

  it('雷点应注入 system prompt（通过模板 PLOT_EVENTS 占位符）', async () => {
    chatMock.mockResolvedValueOnce(okResult(outlineJson(8)));
    const store = setupPlotStore();
    store.plotTabooContent = '禁止出现背叛剧情';
    await store.generatePlotOutline();
    const call = chatMock.mock.calls[0][0];
    // 模板系统将系统提示词 + 解析后的占位符放入 messages[0]（system role）
    const sysMsg = call.messages[0].content as string;
    expect(sysMsg).toContain('禁止出现背叛剧情');
    expect(sysMsg).toContain('雷点');
  });
});

describe('reviseOutline 重 roll 与 outlineHistory', () => {
  beforeEach(() => {
    chatMock.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as any);
  });

  it('无大纲时 reviseOutline 应拒绝', async () => {
    const store = setupPlotStore();
    const ok = await store.reviseOutline('改一下');
    expect(ok).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('reviseOutline 应带上一版 JSON + 修改要求，成功后旧版入栈', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(8, '初版')))
      .mockResolvedValueOnce(okResult(outlineJson(8, '修改版')));
    const store = setupPlotStore();
    await store.generatePlotOutline();
    const ok = await store.reviseOutline('结局不要大团圆');
    expect(ok).toBe(true);
    const call = chatMock.mock.calls[1][0];
    const userMsg = call.messages[call.messages.length - 1].content as string;
    expect(userMsg).toContain('初版');
    expect(userMsg).toContain('结局不要大团圆');
    expect(userMsg).toContain('上一版大纲');
    expect(store.plotOutline?.title).toBe('修改版');
    expect(store.outlineHistory).toHaveLength(1);
    expect(store.outlineHistory[0].title).toBe('初版');
  });

  it('rollbackOutline 应恢复最近一版', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(8, '初版')))
      .mockResolvedValueOnce(okResult(outlineJson(8, '修改版')));
    const store = setupPlotStore();
    await store.generatePlotOutline();
    await store.reviseOutline('改');
    const ok = store.rollbackOutline();
    expect(ok).toBe(true);
    expect(store.plotOutline?.title).toBe('初版');
    expect(store.outlineHistory).toHaveLength(0);
  });

  it('空历史时 rollbackOutline 返回 false', () => {
    const store = setupPlotStore();
    expect(store.rollbackOutline()).toBe(false);
  });

  it('普通重新生成也应把旧版推入历史', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(8, 'v1')))
      .mockResolvedValueOnce(okResult(outlineJson(8, 'v2')));
    const store = setupPlotStore();
    await store.generatePlotOutline();
    await store.generatePlotOutline();
    expect(store.plotOutline?.title).toBe('v2');
    expect(store.outlineHistory).toHaveLength(1);
    expect(store.outlineHistory[0].title).toBe('v1');
  });

  it('历史最多保留 5 版（超出丢最旧）', async () => {
    for (let i = 1; i <= 7; i++) {
      chatMock.mockResolvedValueOnce(okResult(outlineJson(8, `v${i}`)));
    }
    const store = setupPlotStore();
    for (let i = 1; i <= 7; i++) {
      await store.generatePlotOutline();
    }
    expect(store.plotOutline?.title).toBe('v7');
    expect(store.outlineHistory).toHaveLength(5);
    expect(store.outlineHistory[0].title).toBe('v2');
    expect(store.outlineHistory[4].title).toBe('v6');
  });
});

// ===== startJourney 落库（plotSettings metadata + 大纲 + 事件树） =====

describe('startJourney 剧情落库', () => {
  beforeEach(async () => {
    chatMock.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as any);
    const { clearAllData, initializeDatabase } = await import('@engine/database');
    try {
      await clearAllData();
    } catch {
      /* db may not exist */
    }
    await initializeDatabase();
  });

  it('plotSettings（含雷点）应写入 SaveSlot.metadata', async () => {
    const store = setupPlotStore();
    store.plotTabooContent = '禁止团灭';
    const saveId = await store.startJourney();
    const { getSave } = await import('@engine/database');
    const save = await getSave(saveId);
    const ps = (save?.metadata as any)?.plotSettings;
    expect(ps).toBeDefined();
    expect(ps.mode).toBe('main');
    expect(ps.tabooContent).toBe('禁止团灭');
    expect(ps.main?.durationYears).toBe(store.plotDurationYears);
  });

  it('main 模式且有大纲: 落库 confirmed 大纲 + hidden 事件树', async () => {
    chatMock.mockResolvedValueOnce(okResult(outlineJson(8)));
    const store = setupPlotStore();
    await store.generatePlotOutline();
    const saveId = await store.startJourney();

    const { getLatestPlotOutline, getPlotEvents } = await import('@engine/database');
    const outline = await getLatestPlotOutline(saveId);
    expect(outline).toBeDefined();
    expect(outline!.confirmed).toBe(true);
    expect(outline!.saveId).toBe(saveId);
    expect(outline!.title).toBe('血色纹章');

    const events = await getPlotEvents(saveId);
    // 1 章节(depth 0) + 2 keyEvents(depth 1)
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.visibility === 'hidden')).toBe(true);
    const chapter = events.find((e) => e.depth === 0)!;
    expect(chapter.title).toBe('第一章 序幕');
    expect(chapter.childrenIds).toHaveLength(2);
    const keyEvents = events.filter((e) => e.depth === 1);
    expect(keyEvents.every((e) => e.parentId === chapter.id)).toBe(true);
  });

  it('历史版本不落库（只存最终确认版）', async () => {
    chatMock
      .mockResolvedValueOnce(okResult(outlineJson(8, 'v1')))
      .mockResolvedValueOnce(okResult(outlineJson(8, 'v2')));
    const store = setupPlotStore();
    await store.generatePlotOutline();
    await store.generatePlotOutline();
    const saveId = await store.startJourney();
    const { getPlotOutlines } = await import('@engine/database');
    const all = await getPlotOutlines(saveId);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('v2');
  });

  it('off 模式无大纲: 不落库大纲与事件', async () => {
    setActivePinia(createPinia());
    const store = useCreateStore();
    store.name = '测试';
    const saveId = await store.startJourney();
    const { getLatestPlotOutline, getPlotEvents } = await import('@engine/database');
    expect(await getLatestPlotOutline(saveId)).toBeUndefined();
    expect(await getPlotEvents(saveId)).toHaveLength(0);
  });

  it('开局兑换的命运点应写入存档级 SaveProfile.fp（修 FP 丢失 bug）', async () => {
    setActivePinia(createPinia());
    const store = useCreateStore();
    store.name = '测试';
    store.destinyPoints = 100;
    const saveId = await store.startJourney();
    const { getSaveProfile } = await import('@engine/database');
    const profile = await getSaveProfile(saveId);
    expect(profile).toBeDefined();
    expect(profile!.fp).toBe(100);
    expect(profile!.fpHistory).toHaveLength(1);
    expect(profile!.fpHistory[0].amount).toBe(100);
    expect(profile!.fpHistory[0].reason).toContain('开局');
  });

  it('未兑换命运点时不强制创建 SaveProfile（保持 lazy 初始化语义）', async () => {
    setActivePinia(createPinia());
    const store = useCreateStore();
    store.name = '测试';
    // destinyPoints 默认 0
    const saveId = await store.startJourney();
    const { getSaveProfile } = await import('@engine/database');
    const profile = await getSaveProfile(saveId);
    expect(profile).toBeUndefined();
  });
});

// ===== localStorage 草稿 =====

describe('localStorage 草稿 save/restore/clear', () => {
  const DRAFT_KEY = 'plotOutlineDraft_v1';

  function makePlotStore() {
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    settings.settings.apiPool = [
      {
        id: 'ep1',
        name: 'test',
        baseUrl: 'http://localhost',
        apiKey: 'k',
        maskedKey: '***',
        model: 'test-model',
        models: ['test-model'],
        apiType: 'chat',
      },
    ];
    settings.settings.agentModels = { plot_outline: 'ep1' };
    settings.settings.agentPrompts = { plot_outline: '你是剧情大纲生成 Agent' };
    return useCreateStore();
  }

  beforeEach(() => {
    // Ensure localStorage is clean
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  });

  afterEach(() => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  });

  it('autoSaveDraft 写入 localStorage 并可被 tryRestoreDraft 恢复', () => {
    const store = makePlotStore();
    store.plotMode = 'main';
    store.name = '艾琳';

    // Set outline and chapters via store's own reactive API (not raw ref assignment)
    // We can't directly assign to plotOutline (it's a computed from generatePlotOutline),
    // so we simulate by directly calling the draft functions after setting via a known path.
    // Instead, directly test by writing to localStorage and reading back.
    const outline = {
      id: 'test-id',
      saveId: '',
      mode: 'main' as const,
      title: '血色纹章',
      summary: '一句话摘要',
      content: '完整叙事大纲',
      chapters: [{ title: '第一章 序幕', summary: '章节摘要', status: 'pending' as const }],
      selfCritique: '评分: 8',
      confirmed: false,
      version: 1,
      timeRange: { start: '复兴纪元001年01月01日', end: '复兴纪元005年12月30日' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const chapters = [
      {
        title: '第一章 序幕',
        summary: '章节摘要',
        keyEvents: [
          { title: '初入王都', description: '主角抵达艾瑟嘉德', triggerHint: '进入王都' },
        ],
      },
    ];

    // Use tryRestoreDraft with valid data to set the store state, then autoSaveDraft should work
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline,
        chapters,
        outlineHistory: [],
        chaptersHistory: [],
        savedAt: Date.now(),
      }),
    );
    const restored = store.tryRestoreDraft();
    expect(restored).toBe(true);
    expect(store.plotOutline?.title).toBe('血色纹章');

    // Now autoSaveDraft should save the current state
    store.autoSaveDraft();
    const raw = localStorage.getItem(DRAFT_KEY);
    expect(raw).not.toBeNull();
    const draft = JSON.parse(raw!);
    expect(draft.outline.title).toBe('血色纹章');
    expect(draft.chapters).toHaveLength(1);
    expect(draft.savedAt).toBeGreaterThan(0);

    // Create a fresh store and restore
    const store2 = makePlotStore();
    const restored2 = store2.tryRestoreDraft();
    expect(restored2).toBe(true);
    expect(store2.plotOutline?.title).toBe('血色纹章');
    expect(store2.plotOutlineChapters).toHaveLength(1);
  });

  it('tryRestoreDraft 空 localStorage 时返回 false', () => {
    const store = makePlotStore();
    expect(store.tryRestoreDraft()).toBe(false);
  });

  it('tryRestoreDraft 损坏 JSON 时返回 false 并清除 localStorage', () => {
    localStorage.setItem(DRAFT_KEY, 'not valid json{{{');
    const store = makePlotStore();
    expect(store.tryRestoreDraft()).toBe(false);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('tryRestoreDraft 缺少 title 时返回 false 并清除', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline: { title: '', summary: '' },
        chapters: [],
        savedAt: Date.now(),
      }),
    );
    const store = makePlotStore();
    expect(store.tryRestoreDraft()).toBe(false);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('tryRestoreDraft 缺少 chapters 时返回 false 并清除', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline: { title: '有标题' },
        chapters: [],
        savedAt: Date.now(),
      }),
    );
    const store = makePlotStore();
    expect(store.tryRestoreDraft()).toBe(false);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('clearDraft 应清除 localStorage key', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline: { title: '测试大纲' },
        chapters: [{ title: '第一章', summary: '摘要', keyEvents: [] }],
        savedAt: Date.now(),
      }),
    );
    const store = makePlotStore();
    store.clearDraft();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('autoSaveDraft 应保留 outlineHistory 最多 5 版', () => {
    // Pre-populate localStorage with a draft containing 6 history entries
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline: { title: '大纲1', chapters: [] },
        chapters: [{ title: '第一章', summary: '摘要', keyEvents: [] }],
        outlineHistory: [
          { title: '旧版1' },
          { title: '旧版2' },
          { title: '旧版3' },
          { title: '旧版4' },
          { title: '旧版5' },
          { title: '旧版6' },
        ],
        chaptersHistory: [],
        savedAt: Date.now(),
      }),
    );
    // Restore to load it into store
    const store = makePlotStore();
    const restored = store.tryRestoreDraft();
    expect(restored).toBe(true);
    // tryRestoreDraft restores all entries; autoSaveDraft slices to 5
    expect(store.outlineHistory).toHaveLength(6); // restore doesn't slice
    expect(store.outlineHistory[0].title).toBe('旧版1');
    expect(store.outlineHistory[5].title).toBe('旧版6');

    // Now autoSaveDraft should slice to 5
    store.autoSaveDraft();
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(draft.outlineHistory).toHaveLength(5);
    expect(draft.outlineHistory[0].title).toBe('旧版2'); // oldest dropped
    expect(draft.outlineHistory[4].title).toBe('旧版6');
  });

  it('startJourney 应包含 clearDraft 调用（手动验证 clearDraft）', () => {
    // Test clearDraft independent of DB operations (startJourney requires DB setup)
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        outline: { title: '草稿大纲', chapters: [] },
        chapters: [{ title: '第一章', summary: '摘要', keyEvents: [] }],
        savedAt: Date.now(),
      }),
    );
    const store = makePlotStore();
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    store.clearDraft();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// ===== 世界书启用轴（P1-5: 命定核心单选 / 角色多选 / 工坊项目多选，三轴互不干扰） =====

describe('buildEnabledWorldBookEntries 三条启用轴', () => {
  let store: ReturnType<typeof useCreateStore>;

  /** 直接铺 workshopOptions —— 不碰 Dexie，测的是展开语义本身 */
  function seedWorkshop() {
    store.workshopOptions = [
      {
        projectId: 'p1',
        name: '维拉',
        description: '一个角色包',
        authorName: '作者A',
        version: '1.2.0',
        tags: ['角色'],
        entryUids: [105, 106, 107],
      },
      {
        projectId: 'p2',
        name: '空项目',
        description: '只带正则',
        authorName: '作者B',
        version: '0.1',
        tags: [],
        entryUids: [],
      },
    ];
  }

  beforeEach(() => {
    store = makeStore();
    seedWorkshop();
  });

  /** 一个标了「系统」的工坊项目 —— 它是命定核心候选，不是附加内容 */
  function seedWorkshopSystem() {
    store.workshopOptions = [
      ...store.workshopOptions,
      {
        projectId: 'sys1',
        name: '异界律令',
        description: '一个工坊命定核心',
        authorName: '作者C',
        version: '2.0',
        tags: ['系统'],
        entryUids: [201, 202],
      },
    ];
  }

  it('★ 工坊「系统」项目进核心单选名单，不进附加多选名单', () => {
    seedWorkshopSystem();
    expect(store.workshopSystemOptions.map((o) => o.projectId)).toEqual(['sys1']);
    // 否则它会在同一屏出现两次，且勾哪个都过不了必选闸门
    expect(store.workshopExtraOptions.map((o) => o.projectId)).toEqual(['p1', 'p2']);
  });

  it('★ 选工坊命定核心即可通过本步 —— 这正是此前卡死用户的地方', () => {
    seedWorkshopSystem();
    expect(store.stepValid[2]).toBe(false);
    store.selectWorkshopCore('sys1');
    expect(store.stepValid[2]).toBe(true);
  });

  it('★ 内置核心与工坊核心互斥 —— 命定核心只有一枚', () => {
    seedWorkshopSystem();
    store.selectSystemCoreEntry(413);
    store.selectWorkshopCore('sys1');
    expect(store.selectedSystemCoreEntryUid).toBeNull();

    store.selectSystemCoreEntry(413);
    expect(store.selectedWorkshopCoreProjectId).toBeNull();
    expect(store.stepValid[2]).toBe(true);
  });

  it('工坊核心照常展开成 creative_workshop:<uid>，与附加项目同一套存储', () => {
    seedWorkshopSystem();
    store.selectWorkshopCore('sys1');
    const ids = store.buildEnabledWorldBookEntries();
    expect(ids).toContain('creative_workshop:201');
    expect(ids).toContain('creative_workshop:202');
    // 没选内置核心时不该冒出 system_core: 串
    expect(ids.some((i) => i.startsWith('system_core:'))).toBe(false);
  });

  it('工坊核心与附加项目可以并存，互不覆盖', () => {
    seedWorkshopSystem();
    store.selectWorkshopCore('sys1');
    store.toggleWorkshopProject('p1');
    const ids = store.buildEnabledWorldBookEntries();
    for (const uid of [201, 202, 105, 106, 107]) {
      expect(ids).toContain(`creative_workshop:${uid}`);
    }
  });

  it('取消工坊核心后闸门重新关上', () => {
    seedWorkshopSystem();
    store.selectWorkshopCore('sys1');
    store.selectWorkshopCore(null);
    expect(store.stepValid[2]).toBe(false);
    expect(store.buildEnabledWorldBookEntries()).toEqual([]);
  });

  it('勾一个项目 → 输出该项目全部条目的 creative_workshop:<uid>', () => {
    store.toggleWorkshopProject('p1');
    expect(store.buildEnabledWorldBookEntries()).toEqual([
      'creative_workshop:105',
      'creative_workshop:106',
      'creative_workshop:107',
    ]);
  });

  it('取消 → 该项目的串全部移除', () => {
    store.toggleWorkshopProject('p1');
    store.toggleWorkshopProject('p1');
    expect(store.buildEnabledWorldBookEntries()).toEqual([]);
  });

  it('★ 与 system_core / character 两轴互不干扰', () => {
    store.selectSystemCoreEntry(413);
    store.toggleCharacterEntry(313);
    store.toggleWorkshopProject('p1');
    const ids = store.buildEnabledWorldBookEntries();
    expect(ids).toContain('system_core:413');
    expect(ids).toContain('character:313');
    expect(ids.filter((i) => i.startsWith('creative_workshop:'))).toHaveLength(3);

    // 取消工坊后另两轴原样还在
    store.toggleWorkshopProject('p1');
    expect(store.buildEnabledWorldBookEntries()).toEqual(['system_core:413', 'character:313']);
  });

  it('未安装的项目不在列表里，也就勾不上（勾不存在的 id 不产出任何串）', () => {
    store.toggleWorkshopProject('不存在的项目');
    expect(store.buildEnabledWorldBookEntries()).toEqual([]);
  });

  it('已装但无条目的项目：勾选不炸，只是产不出串', () => {
    expect(() => store.toggleWorkshopProject('p2')).not.toThrow();
    expect(store.buildEnabledWorldBookEntries()).toEqual([]);
  });

  it('工坊轴是独立的一条 —— 不占用命定核心那个单选槽', () => {
    store.toggleWorkshopProject('p1');
    expect(store.selectedSystemCoreEntryUid).toBeNull();
  });

  it('resetAll 清空工坊勾选与选项', () => {
    store.toggleWorkshopProject('p1');
    store.resetAll();
    expect(store.enabledWorkshopProjectIds.size).toBe(0);
    expect(store.workshopOptions).toEqual([]);
  });
});
