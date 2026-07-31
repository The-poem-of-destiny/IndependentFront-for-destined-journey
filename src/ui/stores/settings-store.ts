/**
 * 设置持久化 Store — 通用 key-value 自动存 localStorage
 *
 * 用法：
 *   const s = useSettingsStore()
 *   s.settings.apiPool = [...]        // 写入 → 自动存
 *   s.settings.任意新字段 = 值         // 加新设置零改动
 *
 * 设计：一个 ref 装所有设置，deep watch 自动写 localStorage。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { WorldBook } from '@engine/types'
import { loadBuiltInWorldBooks } from '@engine/builtin-worldbooks'
import { loadPresetRules, mergeRules } from '@engine/beautifier'

// ===== 类型 =====

export interface ApiEntry {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  maskedKey: string
  model: string
  models: string[]
  apiType: 'chat' | 'embedding'
  enableThinking?: boolean
}

export interface PresetItem {
  id: string
  name: string
  description?: string
  /** SillyTavern 预设原始 JSON：prompts / temp_openai / openai_max_tokens / top_p_openai / freq_pen_openai 等（ST 导入或前端构建） */
  settings: Record<string, any>
  createdAt: number
  updatedAt: number
}

// ===== Phase 8: Agent 项目默认配置 =====

export interface AgentDefaultEntry {
  worldBookEnabled: boolean
  worldBookIds: string[]
  model: string
  systemPrompt: string
  presetId: string
  preset: PresetItem | null
  temperature: number
  topP: number
  freqPen: number
  presPen: number
  maxTokens: number
  /** Phase 8.6: 历史对话注入层数（几轮 user+ai 对，0=不注入；不填=按 agent 类别默认） */
  historyLayers?: number
  /** Phase 8.6: 每条历史正文截断字数（不填=按 agent 类别默认） */
  historySlice?: number
  /** Phase 10: Custom template string with {{PLACEHOLDER}} references */
  template?: string
}

export interface AgentProjectDefaults {
  version: number
  agents: Record<string, AgentDefaultEntry>
}

// ===== 默认值 =====

const STORAGE_KEY = 'fated-poem-settings'

function getDefaults(): Record<string, any> {
  return {
    // API 池
    apiPool: [] as ApiEntry[],

    // Agent 配置
    activeAgent: null as string | null,
    agentModels: {} as Record<string, string>,
    agentWorldbookEnabled: {} as Record<string, boolean>,
    agentWorldbookIds: {} as Record<string, string[]>,
    agentPrompts: {} as Record<string, string>,
    /** Phase 10: 用户自定义的 Agent 上下文模板 ({{PLACEHOLDER}} 字符串) */
    agentTemplates: {} as Record<string, string>,
    agentPromptEdited: false,
    agentDirty: {} as Record<string, boolean>,

    // Agent LLM 参数 (每 Agent 独立)
    agentTemperature: {} as Record<string, number>,
    agentTopP: {} as Record<string, number>,
    agentFreqPen: {} as Record<string, number>,
    agentPresPen: {} as Record<string, number>,
    agentMaxTokens: {} as Record<string, number>,
    // Phase 8.6: Agent 上下文注入 (每 Agent 独立)
    agentHistoryLayers: {} as Record<string, number>,
    agentHistorySlice: {} as Record<string, number>,

    // 预设系统 (ChatPreset)
    presets: [] as PresetItem[],
    activePresetId: '',

    // Phase 8: 世界书管理
    worldBooks: [] as WorldBook[],
    activeWorldBookId: null as string | null,
    worldBookDirty: false,
    allowEditBuiltInBooks: false,  // 允许编辑内置世界书（默认只读保护）

    // 剧情系统（新档默认值 — 捏人页初始化时读入，字段形状对齐 create-store / types.ts PlotSettings）
    plotMode: 'off' as string,
    plotDurationYears: 5,
    plotDifficultyTier: 'adaptive' as string | number,
    plotAllowNonWorldbookNpc: true,
    plotGenrePreference: ['combat', 'social'] as string[],
    plotCustomPreference: '',
    plotFocusRegion: '',
    plotTabooContent: '',
    plotChapterCount: 0 as number,
    plotEventsPerChapter: 0 as number,

    // 记忆 & 缓存
    memoryRecallCount: 20,
    memoryCompressionThreshold: 100,
    memorySnapshotLimit: 30,
    snapshotRetentionMode: 'tiered' as 'tiered' | 'dense',
    memoryCacheStrategy: 'balanced' as string,

    // 交互 —— 悬停浮层延迟（ms）。全站 hover-to-display 统一读它：
    // 状态效果气泡、在场角色心声气泡等。0 = 立即弹出。
    hoverDelayMs: 200,

    // 消息 & 系统事件可见性
    systemEventsVisible: true,
    systemEventFilters: {
      craft: true,
      char_gen: true,
      item_gen: true,
      combat: true,
      character_update: false,
      item_update: false,
      quest_update: false,
    } as Record<string, boolean>,

    // 音频系统（全局环境属性，不属于存档状态 — 设计 §4.1）
    audioMasterVolume: 0.7,
    audioMasterMuted: false,
    audioMusicVolume: 0.7,
    audioMusicMuted: false,
    audioSfxVolume: 0.7,
    audioSfxMuted: false,
    audioRepeat: 'all' as 'off' | 'all' | 'one',
    audioShuffle: false,
    audioLastPlaylistId: '',
    /** 内置曲目不可删，只能隐藏（设计 §2）— 对齐 beautifierBuiltinDisabled 先例 */
    audioHiddenBuiltinIds: [] as string[],
    /**
     * 进入新地点时自动换 BGM。默认开 —— 这是场景配乐的主路径。
     * 关掉之后地点变化不再触发，音乐完全由用户手动控制（AI 的 <play_audio> 标记同样不生效）。
     */
    audioSceneAutoPlay: true,

    // 输出美化
    beautifierEnabled: true,
    beautifierRules: [] as any[],
    beautifierPresetRules: [] as any[],
    beautifierBuiltinDisabled: [] as string[],
  }
}

// ===== Store =====

export const useSettingsStore = defineStore('settings', () => {
  // 从 localStorage 恢复
  let saved: Record<string, any> = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) saved = JSON.parse(raw)
  } catch { /* 解析失败用默认值 */ }

  // 合并：已存值覆盖默认值（支持未来新增字段自动补默认值）
  const defaults = getDefaults()
  const merged = { ...defaults, ...saved }

  // Phase 8: 启动时异步加载内置世界书（运行时 fetch，始终最新）
  setTimeout(async () => {
    try {
      const builtIn = await loadBuiltInWorldBooks()
      const existing = (settings.value.worldBooks as WorldBook[]) || []
      const existingIds = new Set(existing.map(b => b.id))
      for (const book of builtIn) {
        if (!existingIds.has(book.id)) {
          existing.push(book)
        }
        // 已有 → 保留 localStorage 版本（用户编辑不丢）
      }
      settings.value.worldBooks = [...existing]
    } catch {
      // fetch 不可用时静默跳过
    }
    // 加载项目默认 Agent 配置
    await loadAgentProjectDefaults()

    // 🆕 初始化美化预设规则（含 autoEnable 解析）—— 修复开局游戏页读到空规则导致正则不生效。
    // 此前仅 BeautifierSection.onMounted 加载（要打开设置→输出美化才触发），现提到全局启动。
    // autoEnable 信号来自存档（命定核心选择），启动时无存档上下文 → 传空信号；
    // 规则定义加载即可，locked 由游戏页/设置页按存档 enabledWorldBookEntries 重算。
    try {
      const presetRules = await loadPresetRules()
      const merged = mergeRules(
        presetRules,
        (settings.value.beautifierRules as any[]) ?? [],
        (settings.value.beautifierBuiltinDisabled as string[]) ?? [],
        new Set(),
        new Set(),
        new Set(),
      )
      settings.value.beautifierPresetRules = merged.filter((r: any) => r.isBuiltin)
    } catch {
      // 加载失败静默（BeautifierSection 打开时会兜底重算）
    }
  }, 0)

  const settings = ref<Record<string, any>>(merged)

  // deep watch → 自动存
  watch(settings, (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    } catch { /* quota exceeded 等极端情况静默失败 */ }
  }, { deep: true })

  /** 手动触发存储（正常情况下不需要调用，deep watch 自动处理） */
  function saveNow() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value))
    } catch { /* 静默 */ }
  }

  /** 重置所有设置为默认值 */
  function resetAll() {
    settings.value = getDefaults()
    saveNow()
  }

  /** 恢复世界书为默认：清除旧数据，重新从 data/worldbooks/ 加载 */
  async function resetWorldBooksToDefaults() {
    try {
      const builtIn = await loadBuiltInWorldBooks()
      settings.value.worldBooks = builtIn
      settings.value.activeWorldBookId = null
      saveNow()
    } catch { /* fetch 不可用时静默跳过 */ }
  }

  // ===== 项目默认 Agent 配置 =====

  const projectAgentDefaults = ref<AgentProjectDefaults>({ version: 1, agents: {} })

  /** 从 data/defaults/agent-config.json 加载项目默认配置 */
  async function loadAgentProjectDefaults() {
    try {
      const res = await fetch('/data/defaults/agent-config.json')
      if (res.ok) {
        projectAgentDefaults.value = await res.json()
      }
    } catch {
      // 文件不存在或 fetch 失败，使用空骨架
    }
    // 对未被用户配置过的 agent 补上项目默认值
    const pd = projectAgentDefaults.value?.agents
    if (!pd) return
    for (const [agentId, entry] of Object.entries(pd)) {
      if (!(agentId in (settings.value.agentModels as Record<string, string>))) {
        settings.value.agentModels[agentId] = entry.model ?? ''
      }
      if (!(agentId in (settings.value.agentWorldbookEnabled as Record<string, boolean>))) {
        settings.value.agentWorldbookEnabled[agentId] = entry.worldBookEnabled ?? false
      }
      if (!(agentId in (settings.value.agentWorldbookIds as Record<string, string[]>))) {
        settings.value.agentWorldbookIds[agentId] = [...(entry.worldBookIds ?? [])]
      }
      if (!(agentId in (settings.value.agentPrompts as Record<string, string>))) {
        settings.value.agentPrompts[agentId] = entry.systemPrompt ?? ''
      }
      // Phase 10: 从项目默认加载上下文模板
      if (entry.template && !(agentId in (settings.value.agentTemplates as Record<string, string>))) {
        settings.value.agentTemplates[agentId] = entry.template
      }
      // LLM 参数（缺省使用合理默认值）
      if (!(agentId in (settings.value.agentTemperature as Record<string, number>))) {
        settings.value.agentTemperature[agentId] = entry.temperature ?? 0.7
      }
      if (!(agentId in (settings.value.agentTopP as Record<string, number>))) {
        settings.value.agentTopP[agentId] = entry.topP ?? 1.0
      }
      if (!(agentId in (settings.value.agentFreqPen as Record<string, number>))) {
        settings.value.agentFreqPen[agentId] = entry.freqPen ?? 0
      }
      if (!(agentId in (settings.value.agentPresPen as Record<string, number>))) {
        settings.value.agentPresPen[agentId] = entry.presPen ?? 0
      }
      if (!(agentId in (settings.value.agentMaxTokens as Record<string, number>))) {
        settings.value.agentMaxTokens[agentId] = entry.maxTokens ?? 16384
      }
      // Phase 8.6: 历史注入层数/截断字数 — 不设则留空 (引擎侧 defaultHistoryLayers/Slice 兜底)
      if (entry.historyLayers !== undefined && !(agentId in (settings.value.agentHistoryLayers as Record<string, number>))) {
        settings.value.agentHistoryLayers[agentId] = entry.historyLayers
      }
      if (entry.historySlice !== undefined && !(agentId in (settings.value.agentHistorySlice as Record<string, number>))) {
        settings.value.agentHistorySlice[agentId] = entry.historySlice
      }
      // Phase 10: 从项目默认加载 Agent 上下文模板
      if (entry.template && !(agentId in (settings.value.agentTemplates as Record<string, string>))) {
        settings.value.agentTemplates[agentId] = entry.template
      }
      // 预设：DB 空 → seed 出厂预设；DB 有同 id → 同步出厂 name（保留用户 prompts 编辑）
      if (entry.preset && entry.presetId) {
        try {
          const { getPresets, savePreset } = await import('@engine/database')
          const existing = await getPresets()
          const embedded: any = JSON.parse(JSON.stringify(entry.preset))
          if (!existing || existing.length === 0) {
            await savePreset(embedded)
          } else {
            // M5.1: 出厂预设改名同步 —— id 匹配时把 DB 预设 name 更新为出厂版
            // （prompts/settings 保留用户编辑；仅 name 跟随 agent-config.json）
            const dbMatch = existing.find((p: any) => p.id === embedded.id)
            if (dbMatch && dbMatch.name !== embedded.name) {
              const updated = { ...dbMatch, name: embedded.name }
              await savePreset(updated)
              const idx = (settings.value.presets as PresetItem[]).findIndex((p) => p.id === embedded.id)
              if (idx >= 0) (settings.value.presets as PresetItem[])[idx] = updated as PresetItem
            }
          }
        } catch { /* IndexedDB 不可用时静默跳过 */ }
        const existingPreset = (settings.value.presets as PresetItem[]).find(p => p.id === entry.presetId)
        if (!existingPreset && entry.preset) {
          ;(settings.value.presets as PresetItem[]).push(entry.preset)
        }
        if (!settings.value.activePresetId) {
          settings.value.activePresetId = entry.presetId
        }
      }
    }
  }

  /** 保存项目默认 Agent 配置到 data/defaults/agent-config.json */
  async function saveAgentProjectDefaults(data: AgentProjectDefaults): Promise<boolean> {
    try {
      const res = await fetch('/api/defaults/agent-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data, null, 2),
      })
      if (res.ok) {
        projectAgentDefaults.value = data
        return true
      }
    } catch {
      // 网络错误
    }
    return false
  }

  /** 获取浏览器存储用量 */
  async function getStorageUsage(): Promise<{ used: number; quota: number; pct: number } | null> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const est = await navigator.storage.estimate()
        const used = est.usage ?? 0
        const quota = est.quota ?? 0
        return { used, quota, pct: quota > 0 ? (used / quota) * 100 : 0 }
      }
    } catch { /* 浏览器不支持 */ }
    return null
  }

  return { settings, saveNow, resetAll, resetWorldBooksToDefaults, getStorageUsage, projectAgentDefaults, loadAgentProjectDefaults, saveAgentProjectDefaults }
})
