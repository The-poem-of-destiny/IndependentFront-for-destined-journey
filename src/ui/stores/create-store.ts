/**
 * 捏人页 Store — 角色创建状态管理
 *
 * 数据来源:
 * - start-catalog.ts — 难度/核心/装备池/技能池/道具池/背景/种族费用/身份费用/地点
 * - bloodlines.ts — 23 血脉列表
 * - tier-constants.ts — 7 层级 HP/MP/SP 乘数
 * - custom_start_index.html — BP/AP/消耗计算 原版逻辑
 */

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { CharacterState, PlotSettings, PlotOutline } from '@engine/types'
import { TIER_CONFIGS } from '@engine/tier-constants'
import { getBloodlineList } from '@engine/bloodlines'
import {
  type CatalogItem,
  type BackgroundTemplate,
  type DestinyCore,
  type DifficultyPreset,
  type Rarity,
  DIFFICULTY_PRESETS,
  DEFAULT_DESTINY_CORES,
  DEFAULT_EQUIPMENT_POOL,
  DEFAULT_ITEM_POOL,
  DEFAULT_BACKGROUNDS,
  DEFAULT_RACE_COSTS,
  DEFAULT_IDENTITY_COSTS,
  GENDER_OPTIONS,
  START_LOCATIONS,
  ATTRIBUTE_NAMES,
  ATTR_CN_TO_EN,
} from '@engine/start-catalog'
import { loadBuiltInWorldBooks } from '@engine/builtin-worldbooks'
import type { WorldBook, WorldBookEntry } from '@engine/types'

// ===== 类型 =====

/** 捏人预设 */
export interface CreatePreset {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  difficulty: string
  character: {
    name: string; gender: string; customGender?: string; age: number
    race: string; customRace?: string; identity: string; customIdentity?: string
    startLocation: string; customStartLocation?: string
    level: number
    basePoints: Record<string, number>; attributePoints: Record<string, number>
    money: number; destinyPoints: number
  }
  equipments: CatalogItem[]
  items: CatalogItem[]
  skills: CatalogItem[]
  background: BackgroundTemplate | null
  customBackgroundText: string
  destinyCoreId: string | null
  plotSettings: PlotSettings | null
  /** Phase 10h: 世界书驱动字段 */
  systemCoreEntryUid?: number | null
  enabledCharacterEntryUids?: number[]
  /** 角色补充信息 */
  personality?: string
  physics?: string
  backstory?: string
  extra?: string
}

// ===== 原版常量 (custom_start_index.html) =====
const MAX_BP = 25
const BP_PER_ATTR_MAX = 6

function getTier(level: number): number {
  if (level <= 4) return 1
  if (level <= 8) return 2
  if (level <= 12) return 3
  if (level <= 16) return 4
  if (level <= 20) return 5
  if (level <= 24) return 6
  return 7
}

const TIER_NAMES = ['普通', '中坚', '精英', '史诗', '传说', '神话', '神祗']

// ===== Store =====

export const useCreateStore = defineStore('create', () => {
  // ═══════════════════════════════════════════════════════
  // 步骤控制
  // ═══════════════════════════════════════════════════════
  const currentStep = ref(0)

  const stepValid = computed<Record<number, boolean>>(() => ({
    0: difficulty.value !== null,
    1: name.value.trim().length > 0 && race.value !== '' && remainingBP.value >= 0 && remainingAP.value >= 0,
    2: selectedSystemCoreEntryUid.value !== null,  // 命定核心
    3: true,  // 角色启用（可选）
    4: true,  // 装备选择
    5: true,  // 背景故事
    6: true,  // 剧情规划
    7: true,  // 确认提交
  }))

  function nextStep() {
    if (currentStep.value < 7 && stepValid.value[currentStep.value]) currentStep.value++
  }
  function prevStep() {
    if (currentStep.value > 0) currentStep.value--
  }

  // ═══════════════════════════════════════════════════════
  // 难度
  // ═══════════════════════════════════════════════════════
  const difficulty = ref<DifficultyPreset | null>(null)
  const reincarnationPoints = ref(1000)

  function selectDifficulty(id: string) {
    const preset = DIFFICULTY_PRESETS.find(d => d.id === id)
    if (preset) {
      difficulty.value = preset
      reincarnationPoints.value = preset.points
    }
  }

  // ═══════════════════════════════════════════════════════
  // 角色基本信息 (→ 变量路径)
  // ═══════════════════════════════════════════════════════
  const name = ref('')
  const gender = ref('男')
  const customGender = ref('')
  const age = ref(18)
  const race = ref('人类')
  const customRace = ref('')
  const identity = ref('非贵族平民')
  const customIdentity = ref('')
  const startLocation = ref('大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德')
  const customStartLocation = ref('')
  /** 角色性格描述 */
  const personality = ref('')
  /** 角色身材描述 */
  const physics = ref('')
  /** 角色身世简述 */
  const backstory = ref('')
  /** 补充说明 */
  const extra = ref('')

  // 扁平化地点列表（从级联树提取）
  function flattenLocations(nodes: typeof START_LOCATIONS, prefix = ''): { label: string; value: string }[] {
    const result: { label: string; value: string }[] = []
    for (const n of nodes) {
      const label = prefix ? `${prefix} > ${n.label}` : n.label
      if (!n.children || n.children.length === 0) {
        result.push({ label, value: n.value })
      } else {
        result.push(...flattenLocations(n.children, label))
      }
    }
    return result
  }
  const flatLocationOptions = computed(() => flattenLocations(START_LOCATIONS))

  const raceOptions = computed(() => {
    const bloodlines = getBloodlineList()
    return [
      ...bloodlines.map(b => ({ label: b.name, value: b.name })),
      { label: '自定义', value: '自定义' },
    ]
  })

  const identityOptions = computed(() => {
    return [
      ...Object.keys(DEFAULT_IDENTITY_COSTS).filter(k => k !== '自定义'),
      '自定义',
    ]
  })

  // ═══════════════════════════════════════════════════════
  // 等级 & 属性 (→ 变量路径) — 对齐原版 custom_start_index.html
  // ═══════════════════════════════════════════════════════
  const level = ref(1)
  const basePoints = ref<Record<string, number>>({ 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 })
  const attributePoints = ref<Record<string, number>>({ 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 })

  const tier = computed(() => getTier(level.value))
  const tierName = computed(() => TIER_NAMES[tier.value - 1])
  const tierBonus = computed(() => tier.value - 1)

  const usedBP = computed(() => Object.values(basePoints.value).reduce((a, b) => a + b, 0))
  const remainingBP = computed(() => MAX_BP - usedBP.value)

  function addBasePoint(attr: string) {
    if (remainingBP.value > 0 && (basePoints.value[attr] || 0) < BP_PER_ATTR_MAX) {
      basePoints.value = { ...basePoints.value, [attr]: (basePoints.value[attr] || 0) + 1 }
    }
  }
  function removeBasePoint(attr: string) {
    if ((basePoints.value[attr] || 0) > 0) {
      basePoints.value = { ...basePoints.value, [attr]: (basePoints.value[attr] || 0) - 1 }
    }
  }

  const maxAP = computed(() => Math.max(0, level.value - 1))
  const usedAP = computed(() => Object.values(attributePoints.value).reduce((a, b) => a + b, 0))
  const remainingAP = computed(() => maxAP.value - usedAP.value)

  function addAttributePoint(attr: string) {
    if (remainingAP.value > 0) {
      attributePoints.value = { ...attributePoints.value, [attr]: (attributePoints.value[attr] || 0) + 1 }
    }
  }
  function removeAttributePoint(attr: string) {
    if ((attributePoints.value[attr] || 0) > 0) {
      attributePoints.value = { ...attributePoints.value, [attr]: (attributePoints.value[attr] || 0) - 1 }
    }
  }

  // 原版: 等级变化时重置 AP
  watch(level, () => {
    attributePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 }
  })

  const finalAttributes = computed(() => {
    const result: Record<string, number> = {}
    for (const attr of ATTRIBUTE_NAMES) {
      result[attr] = (basePoints.value[attr] || 0) + tierBonus.value + (attributePoints.value[attr] || 0)
    }
    return result
  })

  const hpPreview = computed(() => {
    const cfg = TIER_CONFIGS[tier.value - 1]
    if (!cfg) return 100
    return Math.floor((finalAttributes.value['体质'] || 5) * cfg.hpMultiplier * 10)
  })
  const mpPreview = computed(() => {
    const cfg = TIER_CONFIGS[tier.value - 1]
    if (!cfg) return 50
    return Math.floor((finalAttributes.value['智力'] || 5) * cfg.mpMultiplier * 10)
  })
  const spPreview = computed(() => {
    const cfg = TIER_CONFIGS[tier.value - 1]
    if (!cfg) return 50
    return Math.floor((finalAttributes.value['精神'] || 5) * cfg.spMultiplier * 10)
  })

  // ═══════════════════════════════════════════════════════
  // 经济 — 对齐原版消耗公式
  // ═══════════════════════════════════════════════════════
  const destinyPoints = ref(0)
  const money = ref(0)

  const raceCost = computed(() => {
    const key = race.value === '自定义' ? '自定义' : race.value
    return DEFAULT_RACE_COSTS[key] ?? 80
  })
  const identityCost = computed(() => {
    const key = identity.value === '自定义' ? '自定义' : identity.value
    return DEFAULT_IDENTITY_COSTS[key] ?? 80
  })
  const equipmentCost = computed(() => selectedEquipments.value.reduce((s, e) => s + (e.cost || 0), 0))
  const itemCost = computed(() => selectedItems.value.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0))
  const skillCost = computed(() => selectedSkills.value.reduce((s, sk) => s + (sk.cost || 0), 0))
  const moneyCost = computed(() => Math.ceil(money.value / 100))
  const destinyCost = computed(() => Math.ceil(destinyPoints.value / 2))
  const levelCost = computed(() => Math.max(0, level.value - 1) * 5)

  const totalCost = computed(() =>
    raceCost.value + identityCost.value +
    levelCost.value + usedAP.value +
    equipmentCost.value + itemCost.value + skillCost.value +
    moneyCost.value + destinyCost.value
  )
  const remainingPoints = computed(() => reincarnationPoints.value - totalCost.value)

  // ═══════════════════════════════════════════════════════
  // 命定核心
  // ═══════════════════════════════════════════════════════
  const destinyCore = ref<DestinyCore | null>(null)
  const destinyCorePool = DEFAULT_DESTINY_CORES

  function selectDestinyCore(coreId: string) {
    const core = DEFAULT_DESTINY_CORES.find(c => c.id === coreId)
    destinyCore.value = core ?? null
  }

  // ═══════════════════════════════════════════════════════
  // Phase 10h: 世界书驱动的命定核心 + 角色启用
  // ═══════════════════════════════════════════════════════

  /** system_core 世界书条目列表（命定核心候选） */
  const systemCoreEntries = ref<WorldBookEntry[]>([])

  /** character 世界书条目列表（可启用角色） */
  const characterEntries = ref<WorldBookEntry[]>([])

  /** 选中的命定核心 entry uid */
  const selectedSystemCoreEntryUid = ref<number | null>(null)

  /** 选中的命定核心条目 */
  const selectedSystemCoreEntry = computed<WorldBookEntry | null>(() => {
    if (selectedSystemCoreEntryUid.value === null) return null
    return systemCoreEntries.value.find(e => e.uid === selectedSystemCoreEntryUid.value) ?? null
  })

  /** 勾选的 character entry uids */
  const enabledCharacterEntryUids = ref<Set<number>>(new Set())

  /** 从内置世界书加载 system_core 和 character 条目 */
  async function loadWorldBookEntries() {
    try {
      const books = await loadBuiltInWorldBooks()
      systemCoreEntries.value = books
        .filter(b => b.partition === 'system_core')
        .flatMap(b => b.entries)
      characterEntries.value = books
        .filter(b => b.partition === 'character')
        .flatMap(b => b.entries)
    } catch {
      // fetch 不可用时静默跳过，保持空数组
      systemCoreEntries.value = []
      characterEntries.value = []
    }
  }

  /** 单选命定核心（传 null 取消选择） */
  function selectSystemCoreEntry(uid: number | null) {
    selectedSystemCoreEntryUid.value = uid
  }

  /** toggle 勾选角色 */
  function toggleCharacterEntry(uid: number) {
    const next = new Set(enabledCharacterEntryUids.value)
    if (next.has(uid)) {
      next.delete(uid)
    } else {
      next.add(uid)
    }
    enabledCharacterEntryUids.value = next
  }

  /** 构建存档用的世界书条目 ID 列表（partition:uid 格式） */
  function buildEnabledWorldBookEntries(): string[] {
    const ids: string[] = []

    // 命定核心 → system_core:uid
    if (selectedSystemCoreEntryUid.value !== null) {
      ids.push(`system_core:${selectedSystemCoreEntryUid.value}`)
    }

    // 启用角色 → character:uid
    for (const uid of enabledCharacterEntryUids.value) {
      ids.push(`character:${uid}`)
    }

    return ids
  }

  // ═══════════════════════════════════════════════════════
  // 装备/道具/技能 选择 (→ 开场提示词路径)
  // ═══════════════════════════════════════════════════════
  const selectedEquipments = ref<CatalogItem[]>([])
  const selectedItems = ref<CatalogItem[]>([])
  const selectedSkills = ref<CatalogItem[]>([])

  const activeCategory = ref<'equipment' | 'item' | 'skill'>('equipment')
  const rarityFilter = ref<Rarity | 'all'>('all')
  const typeFilter = ref<string>('all')

  const skillPool = ref<CatalogItem[]>([])
  // 异步加载 CDN 技能
  ;(async () => {
    try {
      const resp = await fetch('https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/public/assets/data/skills.json')
      const text = await resp.text()
      const cleaned = text.replace(/\/\/.*$/gm, '').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
      const data = JSON.parse(cleaned)
      const items: CatalogItem[] = []
      for (const [, skills] of Object.entries(data)) {
        if (!Array.isArray(skills)) continue
        for (const s of skills as any[]) {
          items.push({
            id: 'sk_' + (s.name || '').replace(/[^a-zA-Z一-鿿]/g, '_'),
            name: s.name || '', category: 'skill',
            type: s.type || '主动', rarity: s.rarity || 'common',
            tag: s.tag || [], effect: s.effect || {},
            consume: s.consume || '', description: s.description || '',
            cost: s.cost || 30,
          })
        }
      }
      skillPool.value = items
    } catch { skillPool.value = [] }
  })()

  const filteredPool = computed(() => {
    let pool: CatalogItem[]
    switch (activeCategory.value) {
      case 'equipment': pool = DEFAULT_EQUIPMENT_POOL; break
      case 'item': pool = DEFAULT_ITEM_POOL; break
      case 'skill': pool = skillPool.value; break
    }
    if (rarityFilter.value !== 'all') {
      pool = pool.filter(i => i.rarity === rarityFilter.value)
    }
    if (typeFilter.value !== 'all') {
      pool = pool.filter(i => i.type === typeFilter.value)
    }
    return pool
  })

  watch(activeCategory, () => { typeFilter.value = 'all'; subCategoryFilter.value = 'all' })

  /** 从原始池 (不受稀有度/类型过滤影响) 提取 tag[0] 去重作为子分类 */
  const subCategoryFilter = ref<string>('all')
  const subCategories = computed(() => {
    // 使用未过滤的原始池，确保子分类始终可见
    let rawPool: CatalogItem[]
    switch (activeCategory.value) {
      case 'equipment': rawPool = DEFAULT_EQUIPMENT_POOL; break
      case 'item': rawPool = DEFAULT_ITEM_POOL; break
      case 'skill': rawPool = skillPool.value; break
    }
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of rawPool) {
      const firstTag = item.tag?.[0]
      if (firstTag && !seen.has(firstTag)) {
        seen.add(firstTag)
        result.push(firstTag)
      }
    }
    // 按中文排序
    result.sort((a, b) => a.localeCompare(b, 'zh'))
    return result
  })

  function isSelected(item: CatalogItem): boolean {
    switch (item.category) {
      case 'equipment': return selectedEquipments.value.some(e => e.id === item.id)
      case 'item': return selectedItems.value.some(i => i.id === item.id)
      case 'skill': return selectedSkills.value.some(s => s.id === item.id)
    }
  }

  /** 检查物品是否可以选中: 点数足够 + 未选中 + 种族/身份限制 */
  function canSelect(item: CatalogItem): boolean {
    if (isSelected(item)) return true  // 已选中 = 可以保留
    const cost = item.cost || 0
    if (remainingPoints.value < cost) return false
    // 种族限制 (为未来数据扩展预留)
    if ((item as any).requiredRace && (item as any).requiredRace !== race.value) return false
    // 身份限制 (为未来数据扩展预留)
    if ((item as any).requiredIdentity && (item as any).requiredIdentity !== identity.value) return false
    return true
  }

  function addEquipment(item: CatalogItem) {
    if (isSelected(item)) return
    // 允许同一个 type 选多个装备（不强制替换）
    selectedEquipments.value = [...selectedEquipments.value, item]
  }

  function removeEquipment(itemId: string) {
    selectedEquipments.value = selectedEquipments.value.filter(e => e.id !== itemId)
  }

  function addItem(item: CatalogItem) {
    const existing = selectedItems.value.find(i => i.id === item.id)
    if (existing) {
      selectedItems.value = selectedItems.value.map(i =>
        i.id === item.id ? { ...i, quantity: (i.quantity || 1) + (item.quantity || 1) } : i
      )
    } else {
      selectedItems.value = [...selectedItems.value, { ...item }]
    }
  }

  function removeItem(itemId: string) {
    selectedItems.value = selectedItems.value.filter(i => i.id !== itemId)
  }

  function addSkill(item: CatalogItem) {
    if (isSelected(item)) return
    selectedSkills.value = [...selectedSkills.value, item]
  }

  function removeSkill(skillId: string) {
    selectedSkills.value = selectedSkills.value.filter(s => s.id !== skillId)
  }

  function clearAllSelections() {
    selectedEquipments.value = []
    selectedItems.value = []
    selectedSkills.value = []
  }

  // ═══════════════════════════════════════════════════════
  // 背景故事
  // ═══════════════════════════════════════════════════════
  const selectedBackground = ref<BackgroundTemplate | null>(null)
  const customBackgroundText = ref('')

  function selectBackground(bg: BackgroundTemplate | null) {
    selectedBackground.value = bg
    if (bg) customBackgroundText.value = ''
  }

  // ═══════════════════════════════════════════════════════
  // 背景分类 (4 侧栏: 通用/身份/种族/地区)
  // ═══════════════════════════════════════════════════════

  const activeBackgroundCategory = ref<'universal' | 'identity' | 'race' | 'location'>('universal')

  const backgroundCategories = computed(() => {
    const cats = [
      { key: 'universal' as const, label: '通用开局', count: 0 },
      { key: 'identity' as const,  label: '身份限定', count: 0 },
      { key: 'race' as const,      label: '种族限定', count: 0 },
      { key: 'location' as const,  label: '地区限定', count: 0 },
    ]
    for (const bg of DEFAULT_BACKGROUNDS) {
      if (bg.requiredIdentity) cats[1].count++
      else if (bg.requiredRace) cats[2].count++
      else if (bg.requiredLocation || bg.requiredDestinyCore) cats[3].count++
      else cats[0].count++
    }
    return cats
  })

  const filteredBackgrounds = computed(() => {
    let pool = DEFAULT_BACKGROUNDS
    switch (activeBackgroundCategory.value) {
      case 'universal':
        pool = pool.filter(bg => !bg.requiredRace && !bg.requiredIdentity && !bg.requiredLocation && !bg.requiredDestinyCore)
        break
      case 'identity':
        pool = pool.filter(bg => !!bg.requiredIdentity)
        break
      case 'race':
        pool = pool.filter(bg => !!bg.requiredRace)
        break
      case 'location':
        pool = pool.filter(bg => !!bg.requiredLocation || !!bg.requiredDestinyCore)
        break
    }
    return pool
  })

  /** 检查单个背景是否满足所有限定条件 */
  function checkBackgroundConditions(bg: BackgroundTemplate): { valid: boolean; missing: string[] } {
    const missing: string[] = []
    if (bg.requiredRace && race.value !== bg.requiredRace) {
      missing.push(`种族需为「${bg.requiredRace}」`)
    }
    if (bg.requiredIdentity && identity.value !== bg.requiredIdentity) {
      missing.push(`身份需为「${bg.requiredIdentity}」`)
    }
    if (bg.requiredLocation) {
      const loc = startLocation.value
      // 前缀匹配: 如 "诺瓦·瓦伦蒂亚城" 匹配 "大陆中南部区域-瓦伦蒂亚公国-诺瓦·瓦伦蒂亚城-外城区"
      if (loc !== bg.requiredLocation && !loc.includes(bg.requiredLocation)) {
        missing.push(`出生地需在「${bg.requiredLocation}」`)
      }
    }
    if (bg.requiredDestinyCore) {
      const dc = destinyCore.value?.name
      if (!dc || !dc.includes(bg.requiredDestinyCore)) {
        missing.push(`命定核心需为「${bg.requiredDestinyCore}」`)
      }
    }
    return { valid: missing.length === 0, missing }
  }

  // ═══════════════════════════════════════════════════════
  // 剧情规划 — 对齐 PlotSettings 类型 (types.ts)
  // ═══════════════════════════════════════════════════════
  const plotMode = ref<'off' | 'side' | 'main'>('off')
  const plotDurationYears = ref(5)
  const plotAllowNonWorldbookNpc = ref(true)
  const plotDifficultyTier = ref<number | 'adaptive'>('adaptive')
  const plotGenrePreference = ref<Array<'combat' | 'mystery' | 'social' | 'romance' | 'exploration' | 'politics' | 'survival' | 'tragedy'>>(['combat'])
  const plotCustomPreference = ref('')
  const plotFocusRegion = ref('')
  const plotYearlyGeneration = ref(true)
  const plotOutline = ref<PlotOutline | null>(null)
  const isPlotGenerating = ref(false)

  const plotSettings = computed<PlotSettings>(() => {
    const ps: PlotSettings = { mode: plotMode.value }
    if (plotMode.value === 'main') {
      const tier = plotDifficultyTier.value === 'adaptive' ? undefined : plotDifficultyTier.value
      ps.main = {
        durationYears: plotDurationYears.value,
        allowNonWorldbookNpc: plotAllowNonWorldbookNpc.value,
        ...(tier !== undefined ? { difficultyTier: tier } : {}),
        genrePreference: plotGenrePreference.value,
        customPreference: plotCustomPreference.value.trim() || '',
      }
    } else if (plotMode.value === 'side') {
      ps.side = {
        yearlyGeneration: plotYearlyGeneration.value,
        focusRegion: plotFocusRegion.value.trim() || '',
      }
    }
    return ps
  })

  // 剧情大纲生成 — 在捏人页为占位，实际 AI 调用在游戏页首回合执行
  function generatePlotOutline() {
    // 标记已请求生成，实际生成在 startJourney → game page 首回合
    isPlotGenerating.value = false  // 捏人页不做真实 AI 调用
    console.log('[create-store] 剧情大纲将在游戏开始后自动生成')
  }

  // ═══════════════════════════════════════════════════════
  // 模板替换: <user> → 角色名
  // ═══════════════════════════════════════════════════════

  /** 将文本中的 &lt;user&gt; 替换为当前角色名（未填写时用 "你"） */
  function substituteUser(text: string): string {
    const userName = name.value.trim() || '你'
    return text.replace(/<user>/g, userName)
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 变量路径
  // ═══════════════════════════════════════════════════════

  function buildCharacterState(saveId: string): CharacterState {
    const charId = crypto.randomUUID()
    const englishAttrs: Record<string, number> = {}
    for (const attr of ATTRIBUTE_NAMES) {
      englishAttrs[ATTR_CN_TO_EN[attr]] = finalAttributes.value[attr]
    }

    return {
      id: charId,
      saveId,
      type: 'player',
      name: name.value.trim(),
      race: race.value === '自定义' ? customRace.value || '人类' : race.value,
      identity: [identity.value === '自定义' ? customIdentity.value || '非贵族平民' : identity.value],
      occupation: [],
      tier: tier.value,
      tierName: tierName.value,
      level: level.value,
      totalExp: 0,
      expToNext: TIER_CONFIGS[tier.value - 1]?.expCap ?? 100,
      attributes: englishAttrs as CharacterState['attributes'],
      freeAttrPoints: 0,
      hp: hpPreview.value,
      maxHp: hpPreview.value,
      mp: mpPreview.value,
      maxMp: mpPreview.value,
      sp: spPreview.value,
      maxSp: spPreview.value,
      ascension: {
        enabled: false,
        elements: [],
        authority: [],
        law: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      equipment: [],
      skills: [],
      inventory: [],
      statusEffects: [],
      money: money.value,
      location: startLocation.value === '自定义' ? customStartLocation.value : startLocation.value,
      adventurerRank: '未评级',
      currentAction: '',
      bloodlineIds: [],
      // 🆕 正式字段（规范 §2.1；customFields 同步保留旧 key 双写，M6 切换读方后再删）
      gender: gender.value === '自定义' ? customGender.value : gender.value,
      personality: personality.value.trim(),
      appearance: physics.value.trim(),
      background: backstory.value.trim(),
      customFields: {
        saveId,                                                 // 🔧 关联存档，缺了这个 getCharacters 匹配不到
        gender: gender.value === '自定义' ? customGender.value : gender.value,
        age: age.value,
        destinyCoreId: destinyCore.value?.id ?? null,
        destinyPoints: destinyPoints.value,
        personality: personality.value.trim(),
        physics: physics.value.trim(),
        backstory: backstory.value.trim(),
        extra: extra.value.trim(),
      },
    }
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 开场提示词 — 组装自然语言叙事，作为首条用户消息注入管线
  // ═══════════════════════════════════════════════════════
  // 原则：
  // - name / LV / 五维 / HP / race / identity / location → 写死在 CharacterState 字段
  //   → {{CHARACTER_STATE}} system prompt 占位符自动格式化注入
  // - 装备 / 技能 / 物品 / 背景 / 命定核心 / 性格身材身世 → 下游 Agent 需要处理
  //   → 组装为自然语言，作为开场 user 消息注入，走 story→request_dispatcher→vars_update 链路

  function buildOpeningPrompt(): string {
    const charName = name.value.trim() || '未命名'
    const lines: string[] = []

    lines.push(`【创角完成，${charName} 的初始数据】`)

    // 装备
    if (selectedEquipments.value.length > 0) {
      lines.push('')
      lines.push('--- 初始装备 ---')
      for (const e of selectedEquipments.value) {
        const desc = e.description ? `：${e.description}` : ''
        const effects = e.effect && Object.keys(e.effect).length > 0
          ? ` [${Object.entries(e.effect).map(([k, v]) => `${k}:${v}`).join(', ')}]`
          : ''
        const tags = e.tag?.length ? ` (${e.tag.join(', ')})` : ''
        lines.push(`  ${e.name}（${e.type}·${e.rarity}${tags}）${desc}${effects}`)
      }
    }

    // 技能
    if (selectedSkills.value.length > 0) {
      lines.push('')
      lines.push('--- 初始技能 ---')
      for (const s of selectedSkills.value) {
        const desc = s.description ? `：${s.description}` : ''
        const effects = s.effect && Object.keys(s.effect).length > 0
          ? ` [${Object.entries(s.effect).map(([k, v]) => `${k}:${v}`).join(', ')}]`
          : ''
        const consume = s.consume ? ` · 消耗:${s.consume}` : ''
        const tags = s.tag?.length ? ` (${s.tag.join(', ')})` : ''
        lines.push(`  ${s.name}（${s.type}·${s.rarity}${tags}）${desc}${effects}${consume}`)
      }
    }

    // 背包物品
    if (selectedItems.value.length > 0) {
      lines.push('')
      lines.push('--- 背包物品 ---')
      for (const i of selectedItems.value) {
        const desc = i.description ? `：${i.description}` : ''
        const effects = i.effect && Object.keys(i.effect).length > 0
          ? ` [${Object.entries(i.effect).map(([k, v]) => `${k}:${v}`).join(', ')}]`
          : ''
        const tags = i.tag?.length ? ` (${i.tag.join(', ')})` : ''
        lines.push(`  ${i.name} ×${i.quantity || 1}（${i.type}·${i.rarity}${tags}）${desc}${effects}`)
      }
    }

    // 开局剧情（已发生的既成事实：不要复述背景，从当前时间地点直接叙事）
    if (selectedBackground.value) {
      lines.push('')
      lines.push(`--- 开局剧情：「${selectedBackground.value.name}」---`)
      lines.push(substituteUser(selectedBackground.value.fullText))
    } else if (customBackgroundText.value.trim()) {
      lines.push('')
      lines.push('--- 开局剧情：自定义 ---')
      lines.push(substituteUser(customBackgroundText.value.trim()))
    }

    // 开局时间（首次开局固定为复兴纪元001年01月01日，供 memory_summary 等下游 Agent 作为时间锚点）
    lines.push('')
    lines.push('--- 开局时间 ---')
    lines.push('复兴纪元001年01月01日')

    // 命定核心
    // 优先用 UI 捏人选中的 system_core 世界书条目（selectedSystemCoreEntry）；
    // 兼容旧的 destinyCore 对象（DestinyCore Pool，保留兜底）。
    if (selectedSystemCoreEntry.value) {
      const core = selectedSystemCoreEntry.value
      lines.push('')
      lines.push(`--- 命定之灵：「${core.name}」---`)
      lines.push(`命定核心「${core.name}」已激活，详细内容参见世界书。`)
    } else if (destinyCore.value) {
      lines.push('')
      lines.push(`--- 命定之灵：「${destinyCore.value.name}」---`)
      lines.push(`命定核心「${destinyCore.value.name}」已激活，详细内容参见世界书。`)
    }

    // 角色补充信息
    if (personality.value.trim()) {
      lines.push('')
      lines.push(`--- 性格 ---\n${personality.value.trim()}`)
    }
    if (physics.value.trim()) {
      lines.push('')
      lines.push(`--- 身材 ---\n${physics.value.trim()}`)
    }
    if (backstory.value.trim()) {
      lines.push('')
      lines.push(`--- 身世 ---\n${backstory.value.trim()}`)
    }
    if (extra.value.trim()) {
      lines.push('')
      lines.push(`--- 补充 ---\n${extra.value.trim()}`)
    }

    // 收尾
    lines.push('')
    lines.push('---')
    lines.push(`以上是${charName}的角色设定与开局剧情。开局剧情是已经发生的事实，请从当前时间地点直接开始叙事，不要复述或回顾。`)

    return lines.join('\n')
  }

  // ═══════════════════════════════════════════════════════
  // 提交: 写入 DB + 跳转
  // ═══════════════════════════════════════════════════════

  async function startJourney(): Promise<string> {
    const saveId = crypto.randomUUID()
    const charState = buildCharacterState(saveId)
    const openingPrompt = buildOpeningPrompt()
    console.log('[create-store] startJourney — openingPrompt:', openingPrompt.slice(0, 200))
    console.log('[create-store] startJourney — openingPrompt length:', openingPrompt.length)

    const { saveCharacter, saveSaveSlot } = await import('@engine/database')

    await saveCharacter(charState)

    // 存档名：主角名 + 层级 + 日期
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const saveName = `${charState.name} · ${charState.tierName} · ${dateStr}`

    await saveSaveSlot({
      id: saveId,
      name: saveName,
      slot: 0,  // TODO: 自动分配空闲槽位
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeSnapshotId: null,
      snapshots: [],
      metadata: {
        characterName: charState.name,
        userName: '玩家',
        gameStartTime: new Date().toISOString(),
        totalTurns: 0,
        description: JSON.stringify({
          openingPrompt,
          destinyCoreId: destinyCore.value?.id ?? null,
          difficulty: difficulty.value?.id ?? 'normal',
          remainingPoints: remainingPoints.value,
        }),
        enabledWorldBookEntries: buildEnabledWorldBookEntries(),  // 🆕
        openingPrompt: openingPrompt,                              // 🆕
        openingPromptConsumed: false,                              // 🆕
      },
    })

    if (plotOutline.value) {
      const { savePlotOutline } = await import('@engine/database')
      await savePlotOutline({ ...plotOutline.value, saveId })
    }

    return saveId
  }

  // ═══════════════════════════════════════════════════════
  // 预设系统
  // ═══════════════════════════════════════════════════════
  const showPresetModal = ref(false)
  const presets = ref<CreatePreset[]>([])

  function getCurrentPresetData(): Omit<CreatePreset, 'id' | 'name' | 'createdAt' | 'updatedAt'> {
    return {
      difficulty: difficulty.value?.id ?? '',
      character: {
        name: name.value, gender: gender.value, customGender: customGender.value,
        age: age.value, race: race.value, customRace: customRace.value,
        identity: identity.value, customIdentity: customIdentity.value,
        startLocation: startLocation.value, customStartLocation: customStartLocation.value,
        level: level.value,
        basePoints: { ...basePoints.value },
        attributePoints: { ...attributePoints.value },
        money: money.value, destinyPoints: destinyPoints.value,
      },
      equipments: [...selectedEquipments.value],
      items: [...selectedItems.value],
      skills: [...selectedSkills.value],
      background: selectedBackground.value,
      customBackgroundText: customBackgroundText.value,
      destinyCoreId: destinyCore.value?.id ?? null,
      plotSettings: plotSettings.value,
      systemCoreEntryUid: selectedSystemCoreEntryUid.value,
      enabledCharacterEntryUids: [...enabledCharacterEntryUids.value],
      personality: personality.value,
      physics: physics.value,
      backstory: backstory.value,
      extra: extra.value,
    }
  }

  function applyPresetData(data: CreatePreset) {
    selectDifficulty(data.difficulty)
    name.value = data.character.name
    gender.value = data.character.gender
    customGender.value = data.character.customGender || ''
    age.value = data.character.age
    race.value = data.character.race
    customRace.value = data.character.customRace || ''
    identity.value = data.character.identity
    customIdentity.value = data.character.customIdentity || ''
    startLocation.value = data.character.startLocation
    customStartLocation.value = data.character.customStartLocation || ''
    level.value = data.character.level
    basePoints.value = { ...data.character.basePoints }
    attributePoints.value = { ...data.character.attributePoints }
    money.value = data.character.money
    destinyPoints.value = data.character.destinyPoints
    clearAllSelections()
    data.equipments.forEach(e => addEquipment(e))
    data.items.forEach(i => addItem(i))
    data.skills.forEach(s => addSkill(s))
    selectedBackground.value = data.background
    customBackgroundText.value = data.customBackgroundText || ''
    if (data.destinyCoreId) selectDestinyCore(data.destinyCoreId)
    if (data.systemCoreEntryUid) selectSystemCoreEntry(data.systemCoreEntryUid)
    if (data.enabledCharacterEntryUids) {
      enabledCharacterEntryUids.value = new Set(data.enabledCharacterEntryUids)
    }
    personality.value = data.personality || ''
    physics.value = data.physics || ''
    backstory.value = data.backstory || ''
    extra.value = data.extra || ''
    if (data.plotSettings) {
      plotMode.value = data.plotSettings.mode
      if (data.plotSettings.main) {
        plotDurationYears.value = data.plotSettings.main.durationYears
        plotAllowNonWorldbookNpc.value = data.plotSettings.main.allowNonWorldbookNpc
        plotDifficultyTier.value = (data.plotSettings.main.difficultyTier ?? 'adaptive') as typeof plotDifficultyTier.value
        plotGenrePreference.value = data.plotSettings.main.genrePreference as typeof plotGenrePreference.value
        plotCustomPreference.value = data.plotSettings.main.customPreference
      }
      if (data.plotSettings.side) {
        plotYearlyGeneration.value = data.plotSettings.side.yearlyGeneration
        plotFocusRegion.value = data.plotSettings.side.focusRegion
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 重置 — 对齐原版 resetCharacter
  // ═══════════════════════════════════════════════════════
  function resetAll() {
    currentStep.value = 0
    difficulty.value = null
    reincarnationPoints.value = 1000
    name.value = ''; gender.value = '男'; customGender.value = ''; age.value = 18
    race.value = '人类'; customRace.value = ''; identity.value = '非贵族平民'; customIdentity.value = ''
    startLocation.value = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德'; customStartLocation.value = ''
    level.value = 1
    basePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 }
    attributePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 }
    destinyPoints.value = 0; money.value = 0
    clearAllSelections()
    destinyCore.value = null
    selectedBackground.value = null; customBackgroundText.value = ''
    plotOutline.value = null; isPlotGenerating.value = false
    plotMode.value = 'off'; plotDurationYears.value = 5
    plotAllowNonWorldbookNpc.value = true; plotDifficultyTier.value = 'adaptive'
    plotGenrePreference.value = ['combat']; plotCustomPreference.value = ''
    plotFocusRegion.value = ''; plotYearlyGeneration.value = true
    showPresetModal.value = false
    selectedSystemCoreEntryUid.value = null
    enabledCharacterEntryUids.value = new Set()
    systemCoreEntries.value = []
    characterEntries.value = []
  }

  return {
    // 步骤
    currentStep, stepValid, nextStep, prevStep,
    // 难度
    difficulty, selectDifficulty,
    // 角色 (→ 变量)
    name, gender, customGender, age,
    race, customRace, raceOptions,
    identity, customIdentity, identityOptions,
    startLocation, customStartLocation, START_LOCATIONS, flatLocationOptions,
    GENDER_OPTIONS,
    // 角色补充信息
    personality, physics, backstory, extra,
    // 属性 (→ 变量)
    level, basePoints, attributePoints,
    tier, tierName, tierBonus, finalAttributes,
    MAX_BP, BP_PER_ATTR_MAX, usedBP, remainingBP, maxAP, usedAP, remainingAP,
    addBasePoint, removeBasePoint, addAttributePoint, removeAttributePoint,
    hpPreview, mpPreview, spPreview,
    // 经济
    reincarnationPoints, destinyPoints, money,
    raceCost, identityCost, levelCost, equipmentCost, itemCost, skillCost,
    moneyCost, destinyCost, totalCost, remainingPoints,
    // 命定核心
    destinyCore, destinyCorePool, selectDestinyCore,
    // Phase 10h: 世界书驱动
    systemCoreEntries, characterEntries,
    selectedSystemCoreEntryUid, selectedSystemCoreEntry,
    enabledCharacterEntryUids,
    loadWorldBookEntries, selectSystemCoreEntry, toggleCharacterEntry,
    buildEnabledWorldBookEntries,
    // 选择 (→ 开场提示词)
    selectedEquipments, selectedItems, selectedSkills,
    activeCategory, rarityFilter, typeFilter, subCategoryFilter, subCategories, filteredPool,
    isSelected, canSelect, addEquipment, removeEquipment,
    addItem, removeItem, addSkill, removeSkill, clearAllSelections,
    // 背景
    selectedBackground, customBackgroundText, selectBackground,
    activeBackgroundCategory, backgroundCategories, filteredBackgrounds, checkBackgroundConditions,
    // 剧情
    plotMode, plotDurationYears, plotAllowNonWorldbookNpc,
    plotDifficultyTier, plotGenrePreference, plotCustomPreference,
    plotFocusRegion, plotYearlyGeneration,
    plotSettings, plotOutline, isPlotGenerating,
    generatePlotOutline,
    // 提交
    buildCharacterState, buildOpeningPrompt, startJourney,
    // 模板
    substituteUser,
    // 预设
    showPresetModal, presets, getCurrentPresetData, applyPresetData,
    // 重置
    resetAll,
  }
})
