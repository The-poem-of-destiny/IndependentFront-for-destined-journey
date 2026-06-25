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

// ===== 类型 =====

export interface ApiEntry {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  maskedKey: string
  model: string
  models: string[]
}

export interface PresetItem {
  id: string
  name: string
  description?: string
  mainPrompt?: string
  system_prompt?: string
  temperature?: string
  maxTokens?: string
  topP?: string
  freqPen?: string
  presPen?: string
  prompts?: { name: string; content: string; enabled: boolean; role: string }[]
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
    agentPromptEdited: false,
    agentDirty: {} as Record<string, boolean>,

    // Agent LLM 参数 (每 Agent 独立)
    agentTemperature: {} as Record<string, number>,
    agentTopP: {} as Record<string, number>,
    agentFreqPen: {} as Record<string, number>,
    agentPresPen: {} as Record<string, number>,
    agentMaxTokens: {} as Record<string, number>,

    // 预设系统 (ChatPreset)
    presets: [] as PresetItem[],
    activePresetId: '',

    // Phase 8: 世界书管理
    worldBooks: [] as WorldBook[],
    activeWorldBookId: null as string | null,
    worldBookDirty: false,
    disableWorldBookProtection: false,  // 取消内置书只读保护

    // 剧情系统
    plotMode: 'off' as string,
    plotDuration: 5,
    plotDifficulty: 'dynamic' as string,
    plotAllowExternalNPC: true,
    plotGenres: ['combat', 'social'] as string[],
    plotCustomPref: '',

    // 记忆 & 缓存
    memoryRecallCount: 20,
    memoryCompressionThreshold: 100,
    memorySnapshotLimit: 30,
    memoryCacheStrategy: 'balanced' as string,
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
        } else {
          // 更新内置书条目（用户可能通过开关修改了 enabled/constant）
          const idx = existing.findIndex(b => b.id === book.id)
          if (idx >= 0) existing[idx] = book
        }
      }
      settings.value.worldBooks = [...existing]
    } catch {
      // fetch 不可用时静默跳过
    }
    // 加载项目默认 Agent 配置
    await loadAgentProjectDefaults()
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
      // 预设：如果项目默认有预设且用户本地没有，插入 presets 数组
      if (entry.preset && entry.presetId) {
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
