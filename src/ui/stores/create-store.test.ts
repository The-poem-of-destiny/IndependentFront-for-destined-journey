/**
 * create-store.ts — 捏人页 Store 纯逻辑测试
 *
 * 测试范围: Pinia store 所有 computed / action / watcher / 流水线
 * 不依赖 DOM, 在 Node 环境运行
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useCreateStore } from './create-store'
import { DIFFICULTY_PRESETS, DEFAULT_EQUIPMENT_POOL, DEFAULT_ITEM_POOL, DEFAULT_BACKGROUNDS, DEFAULT_DESTINY_CORES } from '@engine/start-catalog'
import { TIER_CONFIGS } from '@engine/tier-constants'

// ===== 辅助 =====

function makeStore() {
  setActivePinia(createPinia())
  return useCreateStore()
}

/** 快速设置一个基础角色 */
function setupBasicChar(store: ReturnType<typeof useCreateStore>) {
  store.name = '测试角色'
  store.race = '人类'
  store.identity = '非贵族平民'
  store.level = 1
}

// ===== 难度系统 =====

describe('难度系统', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('初始不应选中任何难度', () => {
    expect(store.difficulty).toBeNull()
  })

  it('selectDifficulty 应正确设置 6 档难度点数', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      store.selectDifficulty(preset.id)
      expect(store.difficulty?.id).toBe(preset.id)
      expect(store.reincarnationPoints).toBe(preset.points)
    }
  })

  it('创造模式应有 1000000 点', () => {
    store.selectDifficulty('creative')
    expect(store.reincarnationPoints).toBe(1000000)
  })

  it('地狱模式应有 100 点', () => {
    store.selectDifficulty('hell')
    expect(store.reincarnationPoints).toBe(100)
  })

  it('未匹配的 id 不应改变难度', () => {
    store.selectDifficulty('nonexistent')
    expect(store.difficulty).toBeNull()
    expect(store.reincarnationPoints).toBe(1000) // 默认值不变
  })
})

// ===== 等级 → 层级 =====

describe('等级 → 层级联动', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('Lv.1 → T1 普通', () => {
    store.level = 1
    expect(store.tier).toBe(1)
    expect(store.tierName).toBe('普通')
  })

  it('Lv.5 → T2 中坚', () => {
    store.level = 5
    expect(store.tier).toBe(2)
    expect(store.tierName).toBe('中坚')
  })

  it('Lv.10 → T3 精英', () => {
    store.level = 10
    expect(store.tier).toBe(3)
    expect(store.tierName).toBe('精英')
  })

  it('Lv.25 → T7 神祗', () => {
    store.level = 25
    expect(store.tier).toBe(7)
    expect(store.tierName).toBe('神祗')
  })

  it('tierBonus = tier - 1', () => {
    store.level = 1; expect(store.tierBonus).toBe(0)
    store.level = 5; expect(store.tierBonus).toBe(1)
    store.level = 25; expect(store.tierBonus).toBe(6)
  })
})

// ===== BP 分配 =====

describe('基础属性 BP 分配', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('初始所有 BP 应为 0', () => {
    expect(store.usedBP).toBe(0)
    expect(store.remainingBP).toBe(25)
  })

  it('addBasePoint 应增加指定属性', () => {
    store.addBasePoint('力量')
    expect(store.basePoints['力量']).toBe(1)
    expect(store.usedBP).toBe(1)
  })

  it('单属性上限 6', () => {
    for (let i = 0; i < 10; i++) store.addBasePoint('力量')
    expect(store.basePoints['力量']).toBe(6)
  })

  it('总 BP 上限 25', () => {
    // 5属性各加到6 = 30, 但总上限25
    for (const attr of ['力量','敏捷','体质','智力','精神']) {
      for (let i = 0; i < 6; i++) store.addBasePoint(attr)
    }
    expect(store.usedBP).toBeLessThanOrEqual(25)
  })

  it('removeBasePoint 应减少指定属性', () => {
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.removeBasePoint('力量')
    expect(store.basePoints['力量']).toBe(1)
  })

  it('removeBasePoint 下限为 0', () => {
    store.removeBasePoint('力量')
    expect(store.basePoints['力量']).toBe(0)
  })

  it('remainingBP=0 时不能继续加', () => {
    store.level = 25 // 大 levelCost 不影响 BP
    for (let i = 0; i < 30; i++) store.addBasePoint('力量')
    expect(store.usedBP).toBeLessThanOrEqual(25)
  })
})

// ===== AP 分配 =====

describe('额外属性 AP 分配', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('Lv.1 时 maxAP=0', () => {
    store.level = 1
    expect(store.maxAP).toBe(0)
  })

  it('Lv.5 时 maxAP=4', () => {
    store.level = 5
    expect(store.maxAP).toBe(4)
  })

  it('addAttributePoint 应增加 AP', () => {
    store.level = 10 // maxAP=9
    store.addAttributePoint('智力')
    expect(store.attributePoints['智力']).toBe(1)
    expect(store.usedAP).toBe(1)
  })

  it('remainingAP=0 时不能继续加', () => {
    store.level = 2 // maxAP=1
    store.addAttributePoint('力量')
    store.addAttributePoint('力量')
    store.addAttributePoint('敏捷')
    expect(store.usedAP).toBe(1)
  })

  it('removeAttributePoint 下限为 0', () => {
    store.removeAttributePoint('力量')
    expect(store.attributePoints['力量']).toBe(0)
  })

  it('maxAP=0 时 addAttributePoint 无效', () => {
    store.level = 1
    store.addAttributePoint('力量')
    expect(store.usedAP).toBe(0)
  })
})

// ===== level watcher → 重置 AP =====

describe('level 变化 → AP 重置', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('等级升高时 attributePoints 应归零', async () => {
    store.level = 10 // maxAP=9
    store.addAttributePoint('力量')
    store.addAttributePoint('敏捷')
    expect(store.usedAP).toBeGreaterThan(0)

    store.level = 15
    await nextTick()
    expect(store.usedAP).toBe(0)
  })

  it('等级降低时 attributePoints 也应归零', async () => {
    store.level = 10
    store.addAttributePoint('力量')
    store.level = 5
    await nextTick()
    expect(store.usedAP).toBe(0)
  })
})

// ===== 最终属性 =====

describe('最终属性计算 finalAttributes', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('finalAttr = BP + tierBonus + AP', () => {
    store.level = 1 // tierBonus=0
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    // BP=3, tierBonus=0, AP=0 → 3
    expect(store.finalAttributes['力量']).toBe(3)
  })

  it('T2 层级加成正确', () => {
    store.level = 5 // T2, tierBonus=1
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    // BP=2, tierBonus=1, AP=0 → 3
    expect(store.finalAttributes['体质']).toBe(3)
  })

  it('BP + AP + tierBonus 完整', () => {
    store.level = 10 // T3, tierBonus=2, maxAP=9
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.addAttributePoint('力量')
    store.addAttributePoint('力量')
    // BP=3, tierBonus=2, AP=2 → 7
    expect(store.finalAttributes['力量']).toBe(7)
  })
})

// ===== HP/MP/SP 预览 =====

describe('HP/MP/SP 资源预览', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('T1 Lv.1 体质=0 时公式兜底为5 → 最低 HP=50', () => {
    store.level = 1
    // 体质=0 (falsy), 公式用 || 5 兜底: floor(5 × 1 × 10) = 50
    expect(store.hpPreview).toBe(50)
  })

  it('HP = floor(体质 × hpMultiplier × 10)', () => {
    store.level = 1 // T1, hpMultiplier=1
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    // 体质=3, hpMultiplier=1 → 30
    expect(store.hpPreview).toBe(30)
  })

  it('T3 HP 计算正确', () => {
    store.level = 10 // T3, hpMultiplier=4
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    store.addBasePoint('体质')
    // 体质=5, T3 hpMultiplier=4, tierBonus=2 → 体质final=7
    // hpPreview = floor(7 × 4 × 10) = 280
    expect(store.finalAttributes['体质']).toBe(7)
    expect(store.hpPreview).toBe(280)
  })
})

// ===== 消耗公式 =====

describe('totalCost 消耗公式', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.selectDifficulty('normal') // 1000 点
    store.level = 1
  })

  it('默认状态下 totalCost = 种族费 + 身份费', () => {
    // 人类=0, 非贵族平民=?
    // identityCost 从 DEFAULT_IDENTITY_COSTS 查
    expect(store.totalCost).toBe(store.raceCost + store.identityCost)
  })

  it('levelCost = (level-1)*5', () => {
    store.level = 1; expect(store.levelCost).toBe(0)
    store.level = 5; expect(store.levelCost).toBe(20)
    store.level = 25; expect(store.levelCost).toBe(120)
  })

  it('usedAP 应计入 totalCost', () => {
    store.level = 5 // maxAP=4
    store.addAttributePoint('敏捷')
    store.addAttributePoint('敏捷')
    expect(store.usedAP).toBe(2)
    expect(store.totalCost).toBe(store.raceCost + store.identityCost + store.levelCost + 2)
  })

  it('moneyCost = ceil(money/100)', () => {
    store.money = 250
    expect(store.moneyCost).toBe(3) // ceil(250/100)=3
  })

  it('destinyCost = ceil(destinyPoints/2)', () => {
    store.destinyPoints = 5
    expect(store.destinyCost).toBe(3) // ceil(5/2)=3
  })

  it('remainingPoints = reincarnationPoints - totalCost', () => {
    store.level = 5 // levelCost=20
    expect(store.remainingPoints).toBe(1000 - store.totalCost)
  })
})

// ===== 装备选择 =====

describe('装备选择', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.selectDifficulty('creative') // 1000000 点, 够用
  })

  const sword = DEFAULT_EQUIPMENT_POOL.find(e => e.type === '武器')!
  const armor = DEFAULT_EQUIPMENT_POOL.find(e => e.type === '防具')!
  const accessory = DEFAULT_EQUIPMENT_POOL.find(e => e.type === '饰品')!

  it('添加武器应成功', () => {
    if (sword) {
      store.addEquipment(sword)
      expect(store.selectedEquipments).toHaveLength(1)
      expect(store.isSelected(sword)).toBe(true)
    }
  })

  it('同类型防具应允许多选', () => {
    const armors = DEFAULT_EQUIPMENT_POOL.filter(e => e.type === '防具')
    if (armors.length >= 2) {
      store.addEquipment(armors[0])
      store.addEquipment(armors[1])
      expect(store.selectedEquipments).toHaveLength(2)
    }
  })

  it('武器不限制唯一', () => {
    // 武器的 addEquipment 逻辑允许多个
    // 检查现有代码: addEquipment 只对非武器做替换
    // 所以多把武器是允许的
    const weapons = DEFAULT_EQUIPMENT_POOL.filter(e => e.type === '武器')
    if (weapons.length >= 2) {
      store.addEquipment(weapons[0])
      store.addEquipment(weapons[1])
      expect(store.selectedEquipments.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('removeEquipment 应移除指定装备', () => {
    if (sword) {
      store.addEquipment(sword)
      store.removeEquipment(sword.id)
      expect(store.selectedEquipments).toHaveLength(0)
    }
  })
})

// ===== 道具选择 =====

describe('道具选择', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.selectDifficulty('creative')
  })

  it('同 id 道具应叠加 quantity', () => {
    const item = DEFAULT_ITEM_POOL[0]
    if (item) {
      store.addItem(item)
      store.addItem(item)
      expect(store.selectedItems).toHaveLength(1)
      const q = store.selectedItems[0].quantity || 1
      const origQ = item.quantity || 1
      expect(q).toBe(origQ * 2)
    }
  })

  it('removeItem 应移除指定道具', () => {
    const item = DEFAULT_ITEM_POOL[0]
    if (item) {
      store.addItem(item)
      store.removeItem(item.id)
      expect(store.selectedItems).toHaveLength(0)
    }
  })
})

// ===== 技能选择 =====

describe('技能选择', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.selectDifficulty('creative')
  })

  it('addSkill / removeSkill 正常', () => {
    // 使用 filteredPool 中的技能（CDN 可能未加载，此时池为空则跳过）
    const skills = store.filteredPool
    if (skills.length === 0) return
    const skill = skills[0]
    store.addSkill(skill)
    expect(store.selectedSkills.length).toBeGreaterThanOrEqual(1)
    store.removeSkill(skill.id)
    expect(store.selectedSkills.length).toBe(0)
  })

  it('canSelect 点数不足时返回 false', () => {
    store.selectDifficulty('hell') // 100 点
    const item = DEFAULT_EQUIPMENT_POOL.find(e => e.cost > 100)
    if (item) {
      expect(store.canSelect(item)).toBe(false)
    }
  })
})

// ===== 背景条件 =====

describe('背景条件检查', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.name = '测试'
    store.race = '人类'
    store.identity = '非贵族平民'
    store.startLocation = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德'
  })

  it('无限制背景应始终通过', () => {
    const bg = DEFAULT_BACKGROUNDS.find(b =>
      !b.requiredRace && !b.requiredIdentity && !b.requiredLocation && !b.requiredDestinyCore)
    if (bg) {
      const result = store.checkBackgroundConditions(bg)
      expect(result.valid).toBe(true)
      expect(result.missing).toHaveLength(0)
    }
  })

  it('种族不匹配应返回 missing', () => {
    const bg = DEFAULT_BACKGROUNDS.find(b => b.requiredRace && b.requiredRace !== '人类')
    if (bg) {
      const result = store.checkBackgroundConditions(bg)
      expect(result.valid).toBe(false)
      expect(result.missing.some(m => m.includes('种族'))).toBe(true)
    }
  })

  it('身份不匹配应返回 missing', () => {
    const bg = DEFAULT_BACKGROUNDS.find(b => b.requiredIdentity && b.requiredIdentity !== '非贵族平民')
    if (bg) {
      const result = store.checkBackgroundConditions(bg)
      expect(result.valid).toBe(false)
    }
  })

  it('地点前缀匹配应通过', () => {
    const bg = DEFAULT_BACKGROUNDS.find(b => b.requiredLocation)
    if (bg) {
      // 设置地点包含 requiredLocation
      store.startLocation = (bg.requiredLocation || '') + '-某处'
      const result = store.checkBackgroundConditions(bg)
      if (bg.requiredRace && store.race !== bg.requiredRace) return // 受种族限制跳过
      if (bg.requiredIdentity && store.identity !== bg.requiredIdentity) return
      expect(result.valid).toBe(true)
    }
  })
})

// ===== 背景分类 =====

describe('背景四分类过滤', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('通用分类应只含无限定背景', () => {
    store.activeBackgroundCategory = 'universal'
    expect(store.filteredBackgrounds.every(bg =>
      !bg.requiredRace && !bg.requiredIdentity && !bg.requiredLocation && !bg.requiredDestinyCore
    )).toBe(true)
  })

  it('身份限定分类应有 requiredIdentity', () => {
    store.activeBackgroundCategory = 'identity'
    expect(store.filteredBackgrounds.length).toBeGreaterThanOrEqual(0)
    expect(store.filteredBackgrounds.every(bg => !!bg.requiredIdentity)).toBe(true)
  })

  it('种族限定分类应有 requiredRace', () => {
    store.activeBackgroundCategory = 'race'
    expect(store.filteredBackgrounds.every(bg => !!bg.requiredRace)).toBe(true)
  })

  it('地区限定分类应有 requiredLocation 或 requiredDestinyCore', () => {
    store.activeBackgroundCategory = 'location'
    expect(store.filteredBackgrounds.every(bg =>
      !!bg.requiredLocation || !!bg.requiredDestinyCore
    )).toBe(true)
  })
})

// ===== 步骤验证 =====

describe('stepValid 步骤验证', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('Step 0: 未选难度时无效', () => {
    expect(store.stepValid[0]).toBe(false)
    store.selectDifficulty('normal')
    expect(store.stepValid[0]).toBe(true)
  })

  it('Step 1: 角色名为空时无效', () => {
    store.selectDifficulty('normal')
    store.race = '人类'
    expect(store.stepValid[1]).toBe(false)
    store.name = '艾琳'
    expect(store.stepValid[1]).toBe(true)
  })

  it('Step 2: 未选命定核心时无效', () => {
    expect(store.stepValid[2]).toBe(false)
    // 新的世界书驱动 API：selectedSystemCoreEntryUid 控制 step 2 验证
    store.selectSystemCoreEntry(1001)
    expect(store.stepValid[2]).toBe(true)
  })

  it('Steps 3-7: 应始终有效(无强制要求)', () => {
    expect(store.stepValid[3]).toBe(true)
    expect(store.stepValid[4]).toBe(true)
    expect(store.stepValid[5]).toBe(true)
    expect(store.stepValid[6]).toBe(true)
    expect(store.stepValid[7]).toBe(true)
  })
})

// ===== substituteUser =====

describe('substituteUser 模板替换', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('有角色名时 <user> 应替换为角色名', () => {
    store.name = '艾琳'
    expect(store.substituteUser('<user>走在路上')).toBe('艾琳走在路上')
  })

  it('角色名为空时 <user> 应替换为 你', () => {
    store.name = ''
    expect(store.substituteUser('<user>醒了')).toBe('你醒了')
  })

  it('多个 <user> 应全部替换', () => {
    store.name = '艾琳'
    expect(store.substituteUser('<user>看了看<user>的手'))
      .toBe('艾琳看了看艾琳的手')
  })

  it('无 <user> 的文本应原样返回', () => {
    expect(store.substituteUser('天空很蓝')).toBe('天空很蓝')
  })
})

// ===== buildCharacterState =====

describe('buildCharacterState', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.name = '测试'
    store.race = '人类'
    store.identity = '冒险者'
    store.level = 5
  })

  it('应生成合法的 CharacterState', () => {
    const state = store.buildCharacterState('test-save-id')
    expect(state.name).toBe('测试')
    expect(state.race).toBe('人类')
    expect(state.level).toBe(5)
    expect(state.type).toBe('player')
    expect(state.id).toBeTruthy()
  })

  it('自定义种族应写入 customRace', () => {
    store.race = '自定义'
    store.customRace = '精灵混血'
    const state = store.buildCharacterState('test-save-id')
    expect(state.race).toBe('精灵混血')
  })

  it('equipment/skills/inventory 应置空', () => {
    const state = store.buildCharacterState('test-save-id')
    // M2: equipment[] 已删除 — 装备 = inventory 中 equippedSlot 非空的物品（规范 §3）
    expect(state.inventory.filter(i => i.equippedSlot)).toEqual([])
    expect(state.skills).toEqual([])
    expect(state.inventory).toEqual([])
  })

  it('HP/MP/SP 应正确写入', () => {
    const state = store.buildCharacterState('test-save-id')
    expect(state.hp).toBe(store.hpPreview)
    expect(state.maxHp).toBe(store.hpPreview)
  })
})

// ===== buildOpeningPrompt =====

describe('buildOpeningPrompt', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.name = '测试'
    store.selectDifficulty('creative')
  })

  it('空选择时返回仅包含标题头的开场', () => {
    const prompt = store.buildOpeningPrompt()
    expect(prompt).toContain('创角完成')
    expect(prompt).toContain('测试')
    // 没有选择任何装备/技能/物品 → 不应有 --- 初始* --- 标签
    expect(prompt).not.toContain('--- 初始装备 ---')
    expect(prompt).not.toContain('--- 初始技能 ---')
    expect(prompt).not.toContain('--- 背包物品 ---')
    // 开局时间总是存在
    expect(prompt).toContain('--- 开局时间 ---')
    expect(prompt).toContain('复兴纪元001年01月01日')
  })

  it('有装备应输出装备信息', () => {
    const eq = DEFAULT_EQUIPMENT_POOL[0]
    if (eq) {
      store.addEquipment(eq)
      const prompt = store.buildOpeningPrompt()
      expect(prompt).toContain('--- 初始装备 ---')
      expect(prompt).toContain(eq.name)
    }
  })

  it('有命定核心应输出命定之灵', () => {
    const core = DEFAULT_DESTINY_CORES[0]
    if (core) {
      store.selectDestinyCore(core.id)
      const prompt = store.buildOpeningPrompt()
      expect(prompt).toContain('--- 命定之灵')
      expect(prompt).toContain(core.name)
    }
  })

  it('选中 system_core 世界书条目时应输出该条目内容（命定之灵）', () => {
    // 新的 UI 命定核心选择走 selectedSystemCoreEntry（system_core 世界书条目）
    store.systemCoreEntries = [
      { uid: 413, name: '裂命之灵', content: '寄宿于灵魂深处的命运之灵，影响叙事风格。', enabled: true, constant: false, key: [], keysecondary: [], selectiveLogic: 0, order: 0, position: 0 } as any,
    ]
    store.selectSystemCoreEntry(413)
    const prompt = store.buildOpeningPrompt()
    expect(prompt).toContain('--- 命定之灵：')
    expect(prompt).toContain('裂命之灵')
    expect(prompt).toContain('寄宿于灵魂深处的命运之灵')
  })
})

// ===== 预设系统 =====

describe('预设系统', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.name = '预设测试'
    store.selectDifficulty('normal')
    store.level = 5
  })

  it('getCurrentPresetData → applyPresetData 往返一致', () => {
    const data = store.getCurrentPresetData()
    expect(data.character.name).toBe('预设测试')

    // 创建新 store 并应用
    const store2 = makeStore()
    store2.applyPresetData({
      id: 'test',
      name: 'test-preset',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...data,
    })
    expect(store2.name).toBe('预设测试')
    expect(store2.level).toBe(5)
    expect(store2.difficulty?.id).toBe('normal')
  })
})

// ===== resetAll =====

describe('resetAll', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => { store = makeStore() })

  it('resetAll 应恢复所有状态到默认', () => {
    store.name = '测试'
    store.level = 10
    store.selectDifficulty('easy')
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.addBasePoint('力量')
    store.destinyPoints = 100
    store.money = 5000

    store.resetAll()

    expect(store.name).toBe('')
    expect(store.level).toBe(1)
    expect(store.difficulty).toBeNull()
    expect(store.usedBP).toBe(0)
    expect(store.destinyPoints).toBe(0)
    expect(store.money).toBe(0)
    expect(store.currentStep).toBe(0)
    expect(store.selectedEquipments).toHaveLength(0)
  })

  it('resetAll 应重置剧情设置为默认', () => {
    store.plotMode = 'main'
    store.plotGenrePreference = ['combat', 'romance'] as any
    store.resetAll()
    expect(store.plotMode).toBe('off')
    expect(store.plotGenrePreference).toEqual(['combat'])
  })
})

// ===== 步骤导航 =====

describe('步骤导航', () => {
  let store: ReturnType<typeof useCreateStore>
  beforeEach(() => {
    store = makeStore()
    store.selectDifficulty('normal')
    store.name = '测试'
    store.race = '人类'
  })

  it('nextStep 应前进', () => {
    expect(store.currentStep).toBe(0)
    store.nextStep()
    expect(store.currentStep).toBe(1)
  })

  it('prevStep 应后退', () => {
    store.currentStep = 3
    store.prevStep()
    expect(store.currentStep).toBe(2)
  })

  it('currentStep=0 时 prevStep 不应后退', () => {
    store.prevStep()
    expect(store.currentStep).toBe(0)
  })

  it('步骤验证不通过时 nextStep 不应前进', () => {
    store.currentStep = 0
    store.difficulty = null // 难度未选
    expect(store.stepValid[0]).toBe(false)
    const before = store.currentStep
    store.nextStep()
    expect(store.currentStep).toBe(before)
  })
})
