/**
 * settings-store 冒烟测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from './settings-store'

// Mock localStorage for Node test environment
const store_ = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store_.get(k) ?? null,
  setItem: (k: string, v: string) => { store_.set(k, v) },
  removeItem: (k: string) => { store_.delete(k) },
  clear: () => { store_.clear() },
  get length() { return store_.size },
  key: (i: number) => [...store_.keys()][i] ?? null,
})

describe('settings-store', () => {
  let store: ReturnType<typeof useSettingsStore>
  beforeEach(() => {
    store_.clear()
    setActivePinia(createPinia())
    store = useSettingsStore()
  })

  it('应创建 store 实例', () => {
    expect(store).toBeDefined()
  })

  it('settings 应为响应式对象', () => {
    expect(store.settings).toBeDefined()
    expect(Array.isArray(store.settings.apiPool)).toBe(true)
    expect(store.settings.plotMode).toBe('off')
    expect(store.settings.memoryRecallCount).toBe(20)
  })

  it('修改 settings 应自动写 localStorage', async () => {
    store.settings.apiPool = [{ id: '1', name: 'test', baseUrl: 'http://a', apiKey: 'k', maskedKey: '***', model: 'm', models: ['m'] }]
    await nextTick()
    const raw = localStorage.getItem('fated-poem-settings')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.apiPool).toHaveLength(1)
  })

  it('再次创建 store 应从 localStorage 恢复', () => {
    store.settings.plotMode = 'main'
    const store2 = useSettingsStore()
    expect(store2.settings.plotMode).toBe('main')
  })

  it('resetAll 应恢复默认值', () => {
    store.settings.plotMode = 'main'
    store.resetAll()
    expect(store.settings.plotMode).toBe('off')
  })

  it('getStorageUsage 应返回用量信息', async () => {
    const info = await store.getStorageUsage()
    if (info) {
      expect(info.used).toBeGreaterThanOrEqual(0)
      expect(info.quota).toBeGreaterThan(0)
    }
  })

  it('settings 中所有默认字段应存在', () => {
    const keys = Object.keys(store.settings)
    expect(keys).toContain('apiPool')
    expect(keys).toContain('agentModels')
    expect(keys).toContain('presets')
    expect(keys).toContain('plotMode')
    expect(keys).toContain('plotDurationYears')
    expect(keys).toContain('plotDifficultyTier')
    expect(keys).toContain('plotAllowNonWorldbookNpc')
    expect(keys).toContain('plotGenrePreference')
    expect(keys).toContain('plotCustomPreference')
    expect(keys).toContain('plotFocusRegion')
    expect(keys).toContain('plotTabooContent')
    expect(keys).toContain('plotChapterCount')
    expect(keys).toContain('plotEventsPerChapter')
    expect(keys).toContain('memoryRecallCount')
    expect(keys).toContain('memoryCacheStrategy')
  })

  it('剧情系统新档默认值形状对齐 create-store', () => {
    expect(store.settings.plotMode).toBe('off')
    expect(store.settings.plotDurationYears).toBe(5)
    expect(store.settings.plotDifficultyTier).toBe('adaptive')
    expect(store.settings.plotAllowNonWorldbookNpc).toBe(true)
    expect(store.settings.plotGenrePreference).toEqual(['combat', 'social'])
    expect(store.settings.plotCustomPreference).toBe('')
    expect(store.settings.plotFocusRegion).toBe('')
    expect(store.settings.plotTabooContent).toBe('')
    expect(store.settings.plotChapterCount).toBe(0)
    expect(store.settings.plotEventsPerChapter).toBe(0)
  })
})
