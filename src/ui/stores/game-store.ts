import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SaveSlot, CharacterState, ChatMessage, MemoryRecord, PlotEvent, PlotOutline, CombatState, SaveProfile } from '@engine/types'
import { getSave, getSaves, getCharacters, getMemories, getPlotEvents, getSaveProfile } from '@engine/database'
import { saveMessage, getMessages, saveSaveSlot } from '@engine/database'

export const useGameStore = defineStore('game', () => {
  // === 存档 ===
  const saves = ref<SaveSlot[]>([])
  const activeSaveId = ref<string | null>(null)
  const activeSave = computed(() => saves.value.find((s: SaveSlot) => s.id === activeSaveId.value) || null)

  // === 角色 ===
  const characters = ref<CharacterState[]>([])
  const player = computed(() => characters.value.find((c: CharacterState) => c.type === 'player') || null)
  const npcs = computed(() => characters.value.filter((c: CharacterState) => c.type === 'npc'))

  // === 对话 ===
  const messages = ref<ChatMessage[]>([])
  const isGenerating = ref(false)

  const recentMemories = ref<MemoryRecord[]>([])
  const activePlotEvents = ref<PlotEvent[]>([])
  const plotOutline = ref<PlotOutline | null>(null)

  // === 战斗 & 制作 ===
  const activeCombat = ref<CombatState | null>(null)
  const isInCombat = computed(() => activeCombat.value !== null && activeCombat.value.status !== 'ended')

  // === 元数据 ===
  const saveProfile = ref<SaveProfile | null>(null)
  const fp = computed(() => saveProfile.value?.fp || 0)
  const gameTime = computed(() => saveProfile.value?.gameTime ?? null)

  // === 变量快照（v3 关系层 / 天气 / 心里话 路径 A 读取入口） ===
  // 取 messages 末尾首个带 variablesAfter 的快照，不合并历史（覆盖式语义）。
  // 生产中 src/ 暂无环节写入 variablesAfter，此 getter 常为 null；引擎层接 vars_update 后生效。
  const latestVariables = computed<Record<string, any> | null>(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const v = messages.value[i].variablesAfter
      if (v && typeof v === 'object') return v
    }
    return null
  })

  // === 新闻（存档级，守护非可选字段的运行时缺失与坏数据） ===
  const news = computed(() =>
    (saveProfile.value?.news ?? []).filter((n: any) => n && n.id != null),
  )

  // === 心里话 ===
  // 路径 A：latestVariables.关系列表[<角色名>].心里话 —— 运行时流变（引擎未接时不可用，预埋）
  //   兼容三种 key 形态：顶层 `关系列表` / `stat_data.关系列表` 包裹 / engine `sys.relationships`
  // 路径 B（本任务常亮）：CharacterState.customFields.thoughts —— 存档固化
  function getThoughts(charName: string, char?: CharacterState): string {
    const v = latestVariables.value
    const rel =
      v?.['关系列表']?.[charName] ??
      v?.['stat_data']?.['关系列表']?.[charName] ??
      v?.['sys']?.['relationships']?.[charName]
    if (rel && typeof rel['心里话'] === 'string' && rel['心里话']) return rel['心里话']
    const cf = (char as any)?.customFields
    if (cf && typeof cf.thoughts === 'string' && cf.thoughts) return cf.thoughts
    return ''
  }

  // === UI 布局状态 (Phase 7e) ===
  const sidebarCollapsed = ref(false)
  const activeModal = ref<string | null>(null)
  const fullscreenStatus = ref(false)

  // 选项填充 — ChatFlow 点击选项 → InputBar 填入
  const pendingInput = ref('')

  function fillInput(text: string) { pendingInput.value = text }
  function clearPendingInput() { pendingInput.value = '' }

  // === 开场 Prompt 管理 ===
  /** 是否已消费开场 Prompt（未消费 → 需要自动发送） */
  const hasOpeningPromptConsumed = computed(() => {
    return activeSave.value?.metadata?.openingPromptConsumed === true || messages.value.length > 0
  })

  /** 获取开场 Prompt 文本 */
  const openingPrompt = computed(() => {
    return activeSave.value?.metadata?.openingPrompt ?? null
  })

  /** 标记开场 Prompt 已消费 */
  async function markOpeningPromptConsumed() {
    if (!activeSave.value) return
    activeSave.value.metadata.openingPromptConsumed = true
    try {
      await saveSaveSlot(activeSave.value)
    } catch (err) {
      console.error('[game-store] 标记开场 Prompt 失败:', err)
    }
  }

  // === 选项管理 ===
  /** vars_update 解析出的行动选项 */
  const pendingOptions = ref<string[]>([])

  /** 设置行动选项（供 GamePipeline 回调使用） */
  function setPendingOptions(options: string[]) {
    pendingOptions.value = options
  }

  function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
  function showModal(id: string) { activeModal.value = id }
  function closeModal() { activeModal.value = null }
  function toggleFullscreen() { fullscreenStatus.value = !fullscreenStatus.value }

  /** 预览/测试注入：供 Ctrl+Shift+T 直接灌入 characters 与 saveProfile，不绕 IndexedDB。
   *  采用合并语义而非替换，避免覆盖从 IndexedDB 加载的真实存档数据。 */
  function hydratePreview(payload: { characters?: any[]; saveProfile?: any }) {
    if (payload.characters) {
      const existingMap = new Map(characters.value.map(c => [c.id, c]))
      for (const c of payload.characters) {
        const existing = existingMap.get(c.id)
        if (existing) {
          // 已有角色 → 合并覆盖字段（mock 只带 id/name/race/tier/location/customFields，不会破坏属性/装备/背包）
          Object.assign(existing, c)
        } else if (c.type === 'player') {
          // Mock 玩家：只更新真实玩家的 location，不添加假玩家
          const realPlayer = characters.value.find(rp => rp.type === 'player')
          if (realPlayer) {
            if (c.location) realPlayer.location = c.location
            if (c.customFields) {
              realPlayer.customFields = { ...realPlayer.customFields, ...c.customFields }
            }
          }
        } else {
          // 新 NPC → 追加
          characters.value.push(c as CharacterState)
        }
      }
    }
    if (payload.saveProfile) {
      // 浅合并：保留真实 fp/quests 等字段，只覆盖 mock 提供的 gameTime/news/worldFlags
      saveProfile.value = { ...saveProfile.value, ...payload.saveProfile } as SaveProfile
    }
  }

  // === 消息管理 ===
  let turnCounter = 0

  /** 持久化单条消息到 IndexedDB */
  async function persistMessage(msg: ChatMessage) {
    try {
      await saveMessage({ ...msg, saveId: activeSaveId.value! })
    } catch (err) {
      console.error('[game-store] 消息持久化失败:', err)
    }
  }

  /** 从 IndexedDB 恢复消息到内存 */
  async function restoreMessages() {
    if (!activeSaveId.value) return
    try {
      const msgs = await getMessages(activeSaveId.value)
      if (msgs.length > 0) {
        messages.value = msgs
      }
    } catch (err) {
      console.error('[game-store] 恢复消息失败:', err)
    }
  }

  function addMessage(content: string, role: 'user' | 'assistant'): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
      saveId: activeSaveId.value ?? undefined,
      turn: role === 'user' ? ++turnCounter : turnCounter,
    }
    messages.value.push(msg)
    // 异步持久化（不阻塞 UI）
    persistMessage(msg)
  }

  function addSystemMessage(systemEvent: import('@engine/types').SystemEvent): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content: systemEvent.narrative,
      timestamp: Date.now(),
      saveId: activeSaveId.value ?? undefined,
      turn: turnCounter,
      systemEvent,
    }
    messages.value.push(msg)
    persistMessage(msg)
  }

  // === 动作 ===
  async function loadSaves() {
    saves.value = await getSaves()
  }

  async function loadSave(saveId: string) {
    const save = await getSave(saveId)
    if (!save) throw new Error(`Save ${saveId} not found`)
    activeSaveId.value = saveId

    // 加载关联数据
    const [chars, mems, events, profile] = await Promise.all([
      getCharacters(saveId),
      getMemories(saveId),
      getPlotEvents(saveId),
      getSaveProfile(saveId),
    ])

    if (chars) characters.value = chars as CharacterState[]
    if (mems) recentMemories.value = mems as MemoryRecord[]
    if (events) activePlotEvents.value = events as PlotEvent[]
    if (profile) saveProfile.value = profile as SaveProfile

    // 从 Snapshot 恢复角色状态
    if (save.activeSnapshotId && save.snapshots) {
      const snap = save.snapshots.find((s: any) => s.id === save.activeSnapshotId)
      if (snap) {
        if (snap.characters) characters.value = snap.characters as CharacterState[]
      }
    }

    // 从 messages 表恢复对话历史
    await restoreMessages()

    // 恢复 turnCounter（取最后一条 user/assistant 消息的 turn）
    const lastMsg = messages.value.filter(m => m.role === 'user' || m.role === 'assistant').pop()
    turnCounter = lastMsg?.turn ?? 0
  }

  function clearActive() {
    activeSaveId.value = null
    isGenerating.value = false
    characters.value = []
    messages.value = []
    recentMemories.value = []
    activePlotEvents.value = []
    plotOutline.value = null
    activeCombat.value = null
    saveProfile.value = null
  }

  return {
    saves, activeSaveId, activeSave,
    characters, player, npcs,
    messages, isGenerating,
    recentMemories, activePlotEvents, plotOutline,
    activeCombat, isInCombat,
    saveProfile, fp, gameTime,
    latestVariables, news, getThoughts,
    sidebarCollapsed, activeModal, fullscreenStatus,
    toggleSidebar, showModal, closeModal, toggleFullscreen,
    hydratePreview,
    addMessage, addSystemMessage,
    loadSaves, loadSave, clearActive,
    pendingInput, fillInput, clearPendingInput,
    hasOpeningPromptConsumed, openingPrompt, markOpeningPromptConsumed,
    pendingOptions, setPendingOptions,
    persistMessage, restoreMessages,
  }
})
