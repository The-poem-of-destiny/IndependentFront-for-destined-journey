/**
 * game-store.ts — 游戏页 Store 测试
 *
 * 重点覆盖 refreshFromDb()：管线跑完后 StateManager 直接写 Dexie，
 * 回读必须用合并语义（DB 覆盖同 id / 追加本存档新角色 / 保留内存独有 mock）。
 * DB 层用 fake-indexeddb（src/test-setup.ts 全局注入）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGameStore } from './game-store'
import {
  initializeDatabase, clearAllData,
  saveSaveSlot, saveCharacter, saveSaveProfile,
  savePlotOutline, savePlotEvents,
  getDatabase,
} from '@engine/database'
import { createDefaultCharacterState } from '@engine/types'
import type { SaveSlot, SaveProfile, CharacterState, PlotOutline, PlotEvent } from '@engine/types'

// ===== 辅助 =====

const SAVE_ID = 'save-refresh-test'

function makeSaveSlot(overrides: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'Refresh Test Save',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: '理查德',
      userName: 'Tester',
      gameStartTime: '001-01-01',
      totalTurns: 0,
    },
    ...overrides,
  }
}

function makeProfile(overrides: Partial<SaveProfile> = {}): SaveProfile {
  return {
    saveId: SAVE_ID,
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 },
    variables: {},
    worldFlags: {},
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    saveId: SAVE_ID,   // v9: 一等字段（M1 #43，替代 customFields.saveId）
    ...overrides,
  })
}

function makeStore() {
  setActivePinia(createPinia())
  return useGameStore()
}

function makeOutline(overrides: Partial<PlotOutline> = {}): PlotOutline {
  return {
    id: crypto.randomUUID(),
    saveId: SAVE_ID,
    mode: 'main',
    title: '血色纹章',
    summary: '一句话摘要',
    content: '# 大纲正文',
    chapters: [{ title: '第一章', summary: '章节摘要', status: 'pending' }],
    confirmed: true,
    version: 1,
    timeRange: { start: '复兴纪元001年01月01日', end: '复兴纪元005年12月30日' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makePlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: crypto.randomUUID(),
    saveId: SAVE_ID,
    title: '初入王都',
    description: '主角抵达艾瑟嘉德',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    visibility: 'hidden',
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ===== refreshFromDb =====

describe('refreshFromDb', () => {
  let store: ReturnType<typeof useGameStore>

  beforeEach(async () => {
    try { await clearAllData() } catch { /* db may not exist yet */ }
    await initializeDatabase()
    store = makeStore()
  })

  it('无 activeSaveId 时应为 no-op', async () => {
    store.characters = [makeChar({ id: 'c1', name: '内存角色' })]
    await store.refreshFromDb()
    expect(store.characters).toHaveLength(1)
    expect(store.saves).toHaveLength(0)
  })

  it('DB 角色应覆盖同 id 内存角色（背包/装备更新可见）', async () => {
    const memChar = makeChar({ id: 'c1', name: '理查德', type: 'player', inventory: [] })
    store.activeSaveId = SAVE_ID
    store.characters = [memChar]

    // 模拟 StateManager 落库：DB 版本多了一件物品
    const dbChar = { ...JSON.parse(JSON.stringify(memChar)) }
    dbChar.inventory = [{ id: 'item1', name: '磨秃的粉笔残片', quantity: 1 }]
    await saveCharacter(dbChar)
    await saveSaveSlot(makeSaveSlot())

    await store.refreshFromDb()
    expect(store.characters).toHaveLength(1)
    expect(store.characters[0].inventory).toHaveLength(1)
    expect(store.characters[0].inventory[0].name).toBe('磨秃的粉笔残片')
  })

  it('DB 中本存档的新角色（侧链 char_gen NPC）应被追加', async () => {
    store.activeSaveId = SAVE_ID
    store.characters = [makeChar({ id: 'c1', name: '理查德', type: 'player' })]

    await saveCharacter(makeChar({ id: 'npc1', name: '妲丽安', type: 'npc' }))
    await saveSaveSlot(makeSaveSlot())

    await store.refreshFromDb()
    expect(store.characters.map(c => c.name)).toContain('妲丽安')
  })

  it('其他存档的 DB 角色不应被追加', async () => {
    store.activeSaveId = SAVE_ID
    store.characters = []

    await saveCharacter(makeChar({
      id: 'other1', name: '别人家的NPC',
      saveId: 'other-save',
    }))
    await saveSaveSlot(makeSaveSlot())

    await store.refreshFromDb()
    expect(store.characters.map(c => c.name)).not.toContain('别人家的NPC')
  })

  it('内存独有的 mock 角色（DB 无此 id）应保留', async () => {
    store.activeSaveId = SAVE_ID
    store.characters = [makeChar({ id: 'mock1', name: '预览注入NPC' })]
    await saveSaveSlot(makeSaveSlot())

    await store.refreshFromDb()
    expect(store.characters.map(c => c.name)).toContain('预览注入NPC')
  })

  it('save.metadata 与 saveProfile 应回读最新值', async () => {
    store.activeSaveId = SAVE_ID
    store.saves = [makeSaveSlot()]

    // 模拟 StateManager 落库后的最新状态
    await saveSaveSlot(makeSaveSlot({
      metadata: {
        characterName: '理查德', userName: 'Tester',
        gameStartTime: '001-01-01', totalTurns: 3,
      } as any,
    }))
    await saveSaveProfile(makeProfile({
      gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 10 },
      fp: 5,
    }))

    await store.refreshFromDb()
    expect(store.activeSave?.metadata?.totalTurns).toBe(3)
    expect(store.saveProfile?.fp).toBe(5)
    expect(store.saveProfile?.gameTime?.minute).toBe(10)
  })

  it('剧情大纲与事件应回读最新值（post_check 落库后 PlotPanel 可见）', async () => {
    store.activeSaveId = SAVE_ID
    await saveSaveSlot(makeSaveSlot())

    await savePlotOutline(makeOutline({ title: '血色纹章' }))
    const chapter = makePlotEvent({ id: 'ch1', depth: 0, childrenIds: ['ke1'] })
    const keyEvent = makePlotEvent({ id: 'ke1', title: '命运初显', depth: 1, parentId: 'ch1' })
    await savePlotEvents([chapter, keyEvent])

    await store.refreshFromDb()
    expect(store.plotOutline?.title).toBe('血色纹章')
    expect(store.plotOutline?.confirmed).toBe(true)
    expect(store.activePlotEvents).toHaveLength(2)
    expect(store.activePlotEvents.map(e => e.title)).toContain('命运初显')
  })
})

// ===== loadSave 剧情回读 =====

describe('loadSave 剧情回读', () => {
  beforeEach(async () => {
    try { await clearAllData() } catch { /* db may not exist yet */ }
    await initializeDatabase()
  })

  it('loadSave 应并行回读最新大纲与事件树', async () => {
    await saveSaveSlot(makeSaveSlot())
    await savePlotOutline(makeOutline({ title: '旧版', version: 1, updatedAt: Date.now() - 1000 }))
    await savePlotOutline(makeOutline({ title: '确认版', version: 2 }))
    await savePlotEvents([
      makePlotEvent({ id: 'ch1', title: '第一章 序幕', depth: 0, childrenIds: ['ke1'] }),
      makePlotEvent({ id: 'ke1', title: '初入王都', depth: 1, parentId: 'ch1' }),
    ])

    const store = makeStore()
    await store.loadSave(SAVE_ID)

    expect(store.plotOutline?.title).toBe('确认版')
    expect(store.activePlotEvents).toHaveLength(2)
    expect(store.activePlotEvents.every(e => e.visibility === 'hidden')).toBe(true)
  })

  it('无大纲的存档 loadSave 后 plotOutline 应为 null', async () => {
    await saveSaveSlot(makeSaveSlot())
    const store = makeStore()
    await store.loadSave(SAVE_ID)
    expect(store.plotOutline).toBeNull()
    expect(store.activePlotEvents).toHaveLength(0)
  })
})

// ===== persistMessage 前置校验 (#13) =====

describe('persistMessage 前置校验', () => {
  beforeEach(async () => {
    try { await clearAllData() } catch { /* db may not exist yet */ }
    await initializeDatabase()
  })

  it('activeSaveId 为 null 时拒绝持久化（不产生孤儿消息）', async () => {
    const store = makeStore()
    // activeSaveId 默认 null
    store.addMessage('测试内容', 'user')
    await new Promise(r => setTimeout(r, 20))   // addMessage 内部异步持久化
    // getMessages(undefined) 会被 Dexie 的 where().equals(undefined) 拒绝，
    // 改为直接查全表：库里不应出现这条孤儿消息
    const all = await getDatabase().messages.toArray()
    expect(all.filter(m => m.content === '测试内容')).toHaveLength(0)
  })
})
