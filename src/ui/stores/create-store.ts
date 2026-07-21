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
import type { CharacterState, PlotSettings, PlotOutline, ApiEndpoint, AgentConfig } from '@engine/types'
import { TIER_CONFIGS } from '@engine/tier-constants'
import { getBloodlineList } from '@engine/bloodlines'
import { normalizeSlot, normalizeItemType, normalizeRarity } from '@engine/field-enums'
import { AgentClient } from '@engine/agent-client'
import {
  tryParseOutline,
  createOutlineFromAgent,
  type ParsedOutlineOutput,
} from '@engine/plot-outline'
import type { AgentContext } from '@engine/types'
import { useSettingsStore } from './settings-store'
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
import { filterBooksByEnabledEntries } from '@engine/worldbook-loader'
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
  // flush: 'sync' 确保预设加载时 level 赋值后 watch 立即执行完毕，
  // 再由后续 attributePoints = {...} 恢复预设值，不被异步 flush 覆盖。
  watch(level, () => {
    attributePoints.value = { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 }
  }, { flush: 'sync' })

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
    // 不再清空 customBackgroundText — 用户可能在预设和自定义之间切换，
    // buildOpeningPrompt 优先用预设，所以保留自定义文本不影响正确性。
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
  const plotChapterCount = ref(0)
  const plotEventsPerChapter = ref(0)
  const plotTabooContent = ref('')
  const plotOutline = ref<PlotOutline | null>(null)
  /** 结构化章节（含 keyEvents）— startJourney 时经 outlineToEvents 生成事件树 */
  const plotOutlineChapters = ref<ParsedOutlineOutput['chapters']>([])
  const isPlotGenerating = ref(false)
  const plotGenerationError = ref<string | null>(null)
  /** 最近一次大纲生成的完整 AI 数据（供导出） */
  const lastPlotGenerationMeta = ref<{
    messages: Array<{ role: string; content: string }>;
    rawResponse: string;
    reasoning?: string;
    model: string;
    timestamp: number;
  } | null>(null)
  /** 会话内大纲历史（最多 5 版，重新生成/修改时旧版入栈，可回退） */
  const outlineHistory = ref<PlotOutline[]>([])
  const chaptersHistory = ref<ParsedOutlineOutput['chapters'][]>([])

  const plotSettings = computed<PlotSettings>(() => {
    const ps: PlotSettings = { mode: plotMode.value, tabooContent: plotTabooContent.value.trim() }
    if (plotMode.value === 'main') {
      const tier = plotDifficultyTier.value === 'adaptive' ? undefined : plotDifficultyTier.value
      ps.main = {
        durationYears: plotDurationYears.value,
        allowNonWorldbookNpc: plotAllowNonWorldbookNpc.value,
        ...(tier !== undefined ? { difficultyTier: tier } : {}),
        genrePreference: plotGenrePreference.value,
        customPreference: plotCustomPreference.value.trim() || '',
      }
      if (plotChapterCount.value > 0) ps.main.chapterCount = plotChapterCount.value
      if (plotEventsPerChapter.value > 0) ps.main.eventsPerChapter = plotEventsPerChapter.value
    } else if (plotMode.value === 'side') {
      ps.side = {
        focusRegion: plotFocusRegion.value.trim() || '',
      }
      if (plotChapterCount.value > 0) ps.side.chapterCount = plotChapterCount.value
      if (plotEventsPerChapter.value > 0) ps.side.eventsPerChapter = plotEventsPerChapter.value
    }
    return ps
  })

  // ═══════════════════════════════════════════════════════
  // localStorage 草稿 key — 必须定义在 initPlotDefaultsFromSettings
  // （会调用 tryRestoreDraft）之前，避免 TDZ 报错
  // ═══════════════════════════════════════════════════════
  const DRAFT_KEY = 'plotOutlineDraft_v1'

  // ═══════════════════════════════════════════════════════
  // 剧情设置默认值 — 从设置页（settings-store）读入新档默认值
  // ═══════════════════════════════════════════════════════

  function initPlotDefaultsFromSettings() {
    try {
      const s = useSettingsStore().settings
      const mode = s.plotMode
      if (mode === 'off' || mode === 'side' || mode === 'main') plotMode.value = mode
      const dur = Number(s.plotDurationYears)
      if (Number.isFinite(dur) && dur > 0) plotDurationYears.value = dur
      const tier = s.plotDifficultyTier
      plotDifficultyTier.value = (tier === 'adaptive' || tier === undefined || tier === null || tier === '')
        ? 'adaptive'
        : Number(tier)
      plotAllowNonWorldbookNpc.value = s.plotAllowNonWorldbookNpc !== false
      if (Array.isArray(s.plotGenrePreference) && s.plotGenrePreference.length > 0) {
        plotGenrePreference.value = [...s.plotGenrePreference] as typeof plotGenrePreference.value
      }
      plotCustomPreference.value = typeof s.plotCustomPreference === 'string' ? s.plotCustomPreference : ''
      plotFocusRegion.value = typeof s.plotFocusRegion === 'string' ? s.plotFocusRegion : ''
      plotTabooContent.value = typeof s.plotTabooContent === 'string' ? s.plotTabooContent : ''
const cc = Number(s.plotChapterCount)
      plotChapterCount.value = Number.isFinite(cc) && cc > 0 ? cc : 0
      const ec = Number(s.plotEventsPerChapter)
      plotEventsPerChapter.value = Number.isFinite(ec) && ec > 0 ? ec : 0
    } catch { /* settings 不可用时保持内置默认 */ }
  }

  initPlotDefaultsFromSettings()
  // 尝试恢复之前保存的大纲草稿（仅浏览器环境，Node 测试环境跳过）
  if (typeof localStorage !== 'undefined') tryRestoreDraft()

  // ═══════════════════════════════════════════════════════
  // 剧情大纲生成 — 捏人页走模板系统 (buildAgentMessages)
  // ═══════════════════════════════════════════════════════

  /** 端点解析（对齐 game-pipeline.buildEndpoints: agentModels 存 API 池 id，ApiEntry.model → defaultModel） */
  function resolvePlotOutlineEndpoint(): ApiEndpoint | null {
    try {
      const s = useSettingsStore().settings
      const pool = ((s.apiPool ?? []) as any[]).map((entry: any) => ({
        id: entry.id || '',
        name: entry.name || '',
        provider: entry.provider || entry.apiType || 'custom',
        baseUrl: entry.baseUrl || '',
        apiKey: entry.apiKey || '',
        defaultModel: entry.defaultModel || entry.model || '',
        models: entry.models || [],
        timeout: entry.timeout ?? 60000,
        enableThinking: entry.enableThinking ?? false,
      })) as ApiEndpoint[]
      const poolId = ((s.agentModels ?? {}) as Record<string, string>)['plot_outline'] || ''
      return pool.find(ep => ep.id === poolId) || pool[0] || null
    } catch {
      return null
    }
  }

  /** 角色信息 → 最小 CharacterState（供模板系统 {{CHARACTER_STATE}} 占位符） */
  function buildOutlineCharacterState(): CharacterState {
    return buildCharacterState('create-outline')
  }

  /** 剧情配置文本（含雷点，通过 localParams['PLOT_EVENTS'] 覆盖模板占位符） */
  function buildOutlinePlotSettingsText(): string {
    const ps = plotSettings.value
    const parts: string[] = []
    parts.push('') // 前导空行使合并后分隔清晰
    parts.push('# 剧情配置')
    parts.push(`模式: ${ps.mode}`)
    if (ps.main) {
      parts.push(`持续年份: ${ps.main.durationYears}`)
      parts.push(`难度层级: ${ps.main.difficultyTier ?? '自适应'}`)
      parts.push(`允许世界书外NPC: ${ps.main.allowNonWorldbookNpc ? '是' : '否'}`)
      parts.push(`剧情偏向: ${ps.main.genrePreference.join('、')}`)
      if (ps.main.customPreference) parts.push(`自定义偏好: ${ps.main.customPreference}`)
      if (ps.main.chapterCount) parts.push(`章节数量: ${ps.main.chapterCount} 章`)
      if (ps.main.eventsPerChapter) parts.push(`每章事件: ${ps.main.eventsPerChapter} 个`)
    }
    if (ps.side) {
      if (ps.side.focusRegion) parts.push(`专注区域: ${ps.side.focusRegion}`)
      if (ps.side.chapterCount) parts.push(`章节数量: ${ps.side.chapterCount} 章`)
      if (ps.side.eventsPerChapter) parts.push(`每章事件: ${ps.side.eventsPerChapter} 个`)
    }
    if (ps.tabooContent) {
      parts.push('')
      parts.push('雷点（绝对禁止出现的内容，优先级高于一切偏好）:')
      parts.push(ps.tabooContent)
    }
    return parts.join('\n')
  }

  /** 加载 agent-config.json 中的 Agent 配置 */
  async function loadOutlineAgentConfigs(): Promise<AgentConfig[]> {
    try {
      const resp = await fetch('/data/defaults/agent-config.json')
      if (!resp.ok) return []
      const json = await resp.json()
      if (!json.agents) return []
      const result: AgentConfig[] = []
      for (const [id, cfg] of Object.entries(json.agents) as [string, any][]) {
        result.push({ ...cfg, agentId: id } as AgentConfig)
      }
      return result
    } catch {
      return []
    }
  }

  /** 加载剧情大纲 Agent 可见的世界书（走 agent-config.json 的 worldBookIds 过滤 + 用户捏人勾选） */
  async function loadPlotOutlineWorldBooks(agentConfigs: AgentConfig[]): Promise<WorldBook[]> {
    try {
      const all = await loadBuiltInWorldBooks()
      const cfg = agentConfigs.find(c => c.agentId === 'plot_outline')
      let filtered = all
      if (cfg && cfg.worldBookIds?.length) {
        filtered = all.filter(wb => cfg.worldBookIds!.includes(wb.id))
      }
      // 对齐游戏页面：只注入用户在捏人页勾选的角色 + 命定核心
      const enabledEntries = buildEnabledWorldBookEntries()
      return filterBooksByEnabledEntries(filtered, enabledEntries)
    } catch {
      return []
    }
  }

  function buildOutlineTimeRange(): { start: string; end: string } {
    const years = plotMode.value === 'main' ? plotDurationYears.value : 1
    const endYear = String(Math.max(1, years)).padStart(3, '0')
    return { start: '复兴纪元001年01月01日', end: `复兴纪元${endYear}年12月30日` }
  }

  /** 历史入栈（最多 5 版，超出丢最旧） */
  function pushOutlineHistory() {
    if (!plotOutline.value) return
    outlineHistory.value = [...outlineHistory.value, plotOutline.value].slice(-5)
    chaptersHistory.value = [...chaptersHistory.value, plotOutlineChapters.value].slice(-5)
  }

  /** 从原始输出提取结构化自检（score/weaknesses/suggestions） */
  function extractSelfCritique(raw: string): { score: number; weaknesses: string[]; suggestions: string[] } | null {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      const parsed = JSON.parse(m[0])
      const sc = parsed?.selfCritique
      if (!sc || typeof sc.score !== 'number') return null
      return {
        score: sc.score,
        weaknesses: Array.isArray(sc.weaknesses) ? sc.weaknesses : [],
        suggestions: Array.isArray(sc.suggestions) ? sc.suggestions : [],
      }
    } catch {
      return null
    }
  }

  /** 核心生成循环: 通过模板系统 buildAgentMessages 构建上下文，selfCritique.score < 6 时重试（最多 2 次调用） */
  async function runOutlineGeneration(initialUserMessage: string): Promise<boolean> {
    plotGenerationError.value = null
    const endpoint = resolvePlotOutlineEndpoint()
    if (!endpoint || !endpoint.defaultModel) {
      plotGenerationError.value = '未配置 API 端点或模型，请在设置页为「大纲生成」Agent 配置 API'
      return false
    }

    isPlotGenerating.value = true
    try {
      const settings = useSettingsStore().settings

      // 加载模板系统依赖: Agent 配置 + 世界书
      const { buildAgentMessages } = await import('@engine/agent-templates')
      const agentConfigs = await loadOutlineAgentConfigs()
      const worldBooks = await loadPlotOutlineWorldBooks(agentConfigs)

      // 构建 AgentContext
      const ctx: AgentContext = {
        userInput: initialUserMessage,
        history: [],
        characters: [buildOutlineCharacterState()],
        memories: [],
        plotEvents: [],
        plotSettings: plotSettings.value,
        variables: {},
        agentOutputs: new Map(),
        lorebookMatches: [],
        worldBooks: [],
      }

      // localParams: 用剧情配置文本覆盖模板中的 {{PLOT_EVENTS}}
      const localParams: Record<string, string> = {
        'PLOT_EVENTS': buildOutlinePlotSettingsText(),
      }

      const baseMessages = buildAgentMessages('plot_outline', ctx, agentConfigs, worldBooks, undefined, localParams)
      const messages: Array<{ role: string; content: string }> = baseMessages
        ? [...baseMessages]
        : [{ role: 'system', content: '' }]

      const client = new AgentClient({
        endpoint,
        agentId: 'plot_outline',
        saveId: 'create',
        timeout: 120000,
      })
      const llmParams = {
        model: endpoint.defaultModel,
        temperature: ((settings.agentTemperature ?? {}) as Record<string, number>)['plot_outline'] ?? 0.7,
        maxTokens: ((settings.agentMaxTokens ?? {}) as Record<string, number>)['plot_outline'] ?? 16384,
        topP: ((settings.agentTopP ?? {}) as Record<string, number>)['plot_outline'] ?? 1.0,
      }

      let best: { parsed: ParsedOutlineOutput; raw: string } | null = null
      let userMessage = initialUserMessage

      for (let attempt = 0; attempt < 2; attempt++) {
        // 替换最后一条 user 消息为当前 userMessage（首次用 initialUserMessage，重试带弱点）
        // 如果 baseMessages 最后一条是 user，替换它；否则追加
        const lastMsg = messages[messages.length - 1]
        if (lastMsg && lastMsg.role === 'user') {
          messages[messages.length - 1] = { role: 'user', content: userMessage }
        } else {
          messages.push({ role: 'user', content: userMessage })
        }
        const result = await client.chat({ ...llmParams, messages })
        if (result.error || !result.rawResponse) {
          if (best) break
          plotGenerationError.value = `大纲生成失败: ${result.error ?? 'AI 返回为空'}`
          return false
        }
        const parsed = tryParseOutline(result.rawResponse)
        if (!parsed) {
          if (best) break
          plotGenerationError.value = '大纲输出解析失败，请重试'
          return false
        }
        best = { parsed, raw: result.rawResponse }
      // 保存本轮完整 AI 数据，供导出调试用
      lastPlotGenerationMeta.value = {
        messages: messages.map(m => ({ ...m })),
        rawResponse: best.raw,
        reasoning: (result as any).reasoning ?? undefined,
        model: llmParams.model,
        timestamp: Date.now(),
      }

        const critique = extractSelfCritique(result.rawResponse)
        if (!critique || critique.score >= 6) break
        userMessage = [
          initialUserMessage,
          '',
          `# 上一版大纲（自检评分 ${critique.score}/10，未达标，需重写）`,
          result.rawResponse,
          '# 待改进点',
          ...(critique.weaknesses.length ? critique.weaknesses : ['（未给出）']),
          '# 改进建议',
          ...(critique.suggestions.length ? critique.suggestions : ['（未给出）']),
          '请针对以上不足重写大纲，输出完整大纲 XML（<outline>...</outline>）。',
        ].join('\n')
      }

      if (!best) {
        plotGenerationError.value = '大纲生成失败'
        return false
      }

      const outline = createOutlineFromAgent(
        '',
        plotMode.value,
        best.raw,
        buildOutlineTimeRange(),
        (plotOutline.value?.version ?? 0) + 1,
      )
      if (!outline) {
        plotGenerationError.value = '大纲输出解析失败，请重试'
        return false
      }
      pushOutlineHistory()
      plotOutline.value = outline
      plotOutlineChapters.value = best.parsed.chapters
      autoSaveDraft()
      return true
    } catch (err) {
      plotGenerationError.value = `大纲生成失败: ${err instanceof Error ? err.message : String(err)}`
      return false
    } finally {
      isPlotGenerating.value = false
    }
  }

  /** 导出本轮 AI 调试数据（系统提示词 + 思维链 + 正文输出） */
  function exportAIDebugDump(): boolean {
    if (!lastPlotGenerationMeta.value) return false
    const m = lastPlotGenerationMeta.value
    const data = {
      exportedAt: new Date().toISOString(),
      model: m.model,
      timestamp: m.timestamp,
      systemPrompt: m.messages.find(msg => msg.role === 'system')?.content ?? '',
      userMessage: m.messages.find(msg => msg.role === 'user')?.content ?? '',
      allMessages: m.messages,
      reasoning: m.reasoning,
      rawResponse: m.rawResponse,
      parsedOutline: plotOutline.value ? {
        title: plotOutline.value.title,
        summary: plotOutline.value.summary,
        content: plotOutline.value.content,
        timeRange: plotOutline.value.timeRange,
      } : null,
      plotSettings: plotSettings.value,
    }
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `AI调试数据-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return true
    } catch { return false }
  }

  /** 生成剧情大纲（重新生成时旧版入栈 history 可回退） */
  async function generatePlotOutline(): Promise<boolean> {
    if (isPlotGenerating.value) return false
    // 简单的初始 user 消息 — 模板系统的 systemPrompt 已包含完整指令
    const message = '# 剧情大纲生成请求\n\n请根据角色背景和剧情配置，生成完整剧情大纲。'
    return runOutlineGeneration(message)
  }

  /** 大纲重 roll（修改模式）: 带上一版完整 JSON + 用户修改要求让 AI 重写 */
  async function reviseOutline(userRequest: string): Promise<boolean> {
    if (isPlotGenerating.value) return false
    if (!plotOutline.value) {
      plotGenerationError.value = '尚无大纲可修改，请先生成大纲'
      return false
    }
    const previousJson = JSON.stringify({
      title: plotOutline.value.title,
      summary: plotOutline.value.summary,
      content: plotOutline.value.content,
      chapters: plotOutlineChapters.value,
    }, null, 2)
    const message = [
      '# 修改模式',
      '',
      '## 上一版大纲（完整 JSON）',
      previousJson,
      '',
      '## 用户的修改要求',
      userRequest.trim(),
      '',
      '请根据以上要求重写大纲。修改要求与雷点冲突时雷点优先。输出完整大纲 XML（<outline>...</outline>）。',
    ].join('\n')
    return runOutlineGeneration(message)
  }

  /** 回退到上一版大纲 */
  function rollbackOutline(): boolean {
    if (outlineHistory.value.length === 0) return false
    const prev = outlineHistory.value[outlineHistory.value.length - 1]
    outlineHistory.value = outlineHistory.value.slice(0, -1)
    const prevChapters = chaptersHistory.value[chaptersHistory.value.length - 1] ?? []
    chaptersHistory.value = chaptersHistory.value.slice(0, -1)
    plotOutline.value = prev
    plotOutlineChapters.value = prevChapters
    autoSaveDraft()
    return true
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

    // ═══ 真机修（2026-07-17）: 选中的装备/道具/技能直接结构化落库 ═══
    // 池条目是完整结构化数据，不依赖 AI 从开场白文本回写（ADR-11: 确定性逻辑归 Code）。
    // 装备: equippedSlot 经 normalizeSlot(type) 归一（武器/防具/饰品→槽位），不可识别躺背包。
    const startInventory = [
      ...selectedEquipments.value.map(e => ({
        name: e.name,
        description: e.description,
        quantity: 1,
        type: '装备',
        rarity: normalizeRarity(e.rarity),
        equippedSlot: normalizeSlot(e.type),  // 开局即穿；null=躺背包
        effects: e.effect && Object.keys(e.effect).length ? { ...e.effect } : undefined,
      })),
      ...selectedItems.value.map(i => ({
        name: i.name,
        description: i.description,
        quantity: i.quantity ?? 1,
        type: normalizeItemType(i.type) ?? '特殊',
        rarity: normalizeRarity(i.rarity),
        effects: i.effect && Object.keys(i.effect).length ? { ...i.effect } : undefined,
      })),
    ]
    const startSkills = selectedSkills.value.map(s => ({
      name: s.name,
      description: s.description,
      type: (s.type === '被动' ? 'passive' : 'active') as 'active' | 'passive',
      level: 1,
      effects: s.effect && Object.keys(s.effect).length ? { ...s.effect } : undefined,
    }))

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
      // 真机修: 创角选中项结构化落库（equippedSlot 非空 = 开局已穿，规范 §3）
      skills: startSkills,
      inventory: startInventory,
      statusEffects: [],
      money: money.value,
      location: startLocation.value === '自定义' ? customStartLocation.value : startLocation.value,
      adventurerRank: '未评级',
      currentAction: '',
      bloodlineIds: [],
      // 正式字段（规范 §2.1；M6 T2 双写退役完成，customFields 只留真扩展数据）
      gender: gender.value === '自定义' ? customGender.value : gender.value,
      personality: personality.value.trim(),
      appearance: physics.value.trim(),
      background: [backstory.value.trim(), extra.value.trim()].filter(Boolean).join('\n\n'),
      customFields: {
        // M6 T2: saveId/gender/personality/physics/backstory 已升一等字段停写
        age: age.value,
        destinyCoreId: destinyCore.value?.id ?? null,
        destinyPoints: destinyPoints.value,
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
    if (backstory.value.trim() || extra.value.trim()) {
      lines.push('')
      lines.push(`--- 身世 ---\n${[backstory.value.trim(), extra.value.trim()].filter(Boolean).join('\n\n')}`)
    }

    // 收尾
    // 真机迭代2: 首轮叙事 = 开局剧情的"复述+续写"（以开局场景为舞台重新演绎再推进），
    // 且命定核心的激活必须在开场叙事中体现（世界书条目有具体表现），不再指示"跳过不复述"。
    lines.push('')
    lines.push('---')
    lines.push(`以上是${charName}的角色设定与开局剧情。首轮叙事请以「开局剧情」描写的时间地点为舞台：先将这段开场以你的笔触重新演绎（可扩写细节与氛围，不可改变既定事实），再自然续写后续发展。命定核心的激活是这段开场的一部分，必须在叙事中具体展现其苏醒的过程与表征（表现细节参见世界书对应条目）。`)

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
      slot: 0,  // TODO: 自动分配空闲槽位（多槽位属产品功能非字段规范）
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeSnapshotId: null,
      metadata: {
        characterName: charState.name,
        userName: '玩家',
        gameStartTime: new Date().toISOString(),
        totalTurns: 0,
        enabledWorldBookEntries: buildEnabledWorldBookEntries(),  // 🆕
        openingPrompt: openingPrompt,                              // 🆕
        openingPromptConsumed: false,                              // 🆕
        plotSettings: JSON.parse(JSON.stringify(plotSettings.value)),  // §5.2: 本档剧情配置随档落库（含雷点）
      } as any,
    })

    // §5.2: 主线/支线已生成大纲 → 落库确认版 + 结构化事件树（全部 hidden）；历史版本不落库
    if ((plotMode.value === 'main' || plotMode.value === 'side') && plotOutline.value) {
      const { savePlotOutline, savePlotEvents } = await import('@engine/database')
      const { outlineToEvents } = await import('@engine/plot-outline')
      const confirmed: PlotOutline = { ...JSON.parse(JSON.stringify(plotOutline.value)), saveId, confirmed: true }
      await savePlotOutline(confirmed)
      const events = outlineToEvents(JSON.parse(JSON.stringify(plotOutlineChapters.value)), saveId)
      if (events.length > 0) await savePlotEvents(events)
    } else if (plotOutline.value) {
      const { savePlotOutline } = await import('@engine/database')
      await savePlotOutline({ ...JSON.parse(JSON.stringify(plotOutline.value)), saveId })
    }

    return saveId
  }

  /** 成功开局后清除草稿 */
  async function startJourneyAndClearDraft(): Promise<string> {
    const saveId = await startJourney()
    clearDraft()
    return saveId
  }

  // ═══════════════════════════════════════════════════════
  // localStorage 草稿 — 大纲自动保存/恢复/清除
  // ═══════════════════════════════════════════════════════

  /** 自动保存草稿（大纲生成/修改/回退后调用） */
  function autoSaveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        outline: plotOutline.value,
        chapters: plotOutlineChapters.value,
        outlineHistory: outlineHistory.value.slice(-5),
        chaptersHistory: chaptersHistory.value.slice(-5),
        savedAt: Date.now(),
      }))
    } catch { /* localStorage full — silently skip */ }
  }

  /** 尝试恢复草稿，成功返回 true */
  function tryRestoreDraft(): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return false
      const draft = JSON.parse(raw)
      if (!draft.outline?.title || !draft.chapters?.length) {
        localStorage.removeItem(DRAFT_KEY)
        return false
      }
      plotOutline.value = draft.outline
      plotOutlineChapters.value = draft.chapters
      outlineHistory.value = Array.isArray(draft.outlineHistory) ? draft.outlineHistory : []
      chaptersHistory.value = Array.isArray(draft.chaptersHistory) ? draft.chaptersHistory : []
      return true
    } catch {
      localStorage.removeItem(DRAFT_KEY)
      return false
    }
  }

  /** 清除草稿（开局成功后调用） */
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY) } catch { /* silent */ }
  }

  /** 清除当前大纲（回到未生成状态）+ 清草稿；不动角色捏人数据 */
  function clearOutline() {
    plotOutline.value = null
    plotOutlineChapters.value = []
    outlineHistory.value = []
    chaptersHistory.value = []
    plotGenerationError.value = null
    isPlotGenerating.value = false
    clearDraft()
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
      plotTabooContent.value = data.plotSettings.tabooContent ?? ''
      if (data.plotSettings.main) {
        plotDurationYears.value = data.plotSettings.main.durationYears
        plotAllowNonWorldbookNpc.value = data.plotSettings.main.allowNonWorldbookNpc
        plotDifficultyTier.value = (data.plotSettings.main.difficultyTier ?? 'adaptive') as typeof plotDifficultyTier.value
        plotGenrePreference.value = data.plotSettings.main.genrePreference as typeof plotGenrePreference.value
        plotCustomPreference.value = data.plotSettings.main.customPreference
        if (data.plotSettings.main.chapterCount) plotChapterCount.value = data.plotSettings.main.chapterCount
        if (data.plotSettings.main.eventsPerChapter) plotEventsPerChapter.value = data.plotSettings.main.eventsPerChapter
      }
      if (data.plotSettings.side) {
        plotFocusRegion.value = data.plotSettings.side.focusRegion
        if (data.plotSettings.side.chapterCount) plotChapterCount.value = data.plotSettings.side.chapterCount
        if (data.plotSettings.side.eventsPerChapter) plotEventsPerChapter.value = data.plotSettings.side.eventsPerChapter
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
    plotOutlineChapters.value = []
    outlineHistory.value = []; chaptersHistory.value = []
    plotGenerationError.value = null
    plotMode.value = 'off'; plotDurationYears.value = 5
    plotAllowNonWorldbookNpc.value = true; plotDifficultyTier.value = 'adaptive'
    plotGenrePreference.value = ['combat']; plotCustomPreference.value = ''
    plotFocusRegion.value = ''; plotTabooContent.value = ''
    plotChapterCount.value = 0; plotEventsPerChapter.value = 0
    initPlotDefaultsFromSettings()
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
    plotFocusRegion, plotTabooContent,
    plotChapterCount, plotEventsPerChapter,
    plotSettings, plotOutline, plotOutlineChapters, isPlotGenerating,
    plotGenerationError, outlineHistory,
    exportAIDebugDump,
    lastPlotGenerationMeta,
    generatePlotOutline, reviseOutline, rollbackOutline,
    initPlotDefaultsFromSettings,
    // 提交
    buildCharacterState, buildOpeningPrompt, startJourney: startJourneyAndClearDraft,
    // 模板
    substituteUser,
    // localStorage 草稿
    autoSaveDraft, tryRestoreDraft, clearDraft, clearOutline,
    // 预设
    showPresetModal, presets, getCurrentPresetData, applyPresetData,
    // 重置
    resetAll,
  }
})
