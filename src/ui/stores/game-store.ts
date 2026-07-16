import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SaveSlot, CharacterState, ChatMessage, MemoryRecord, PlotEvent, PlotOutline, CombatState, SaveProfile } from '@engine/types'
import { getSave, getSaves, getCharacters, getMemories, getPlotEvents, getSaveProfile } from '@engine/database'
import { saveMessage, getMessages, saveSaveSlot } from '@engine/database'

/** 单条 Agent 调试日志（含完整请求/响应上下文） */
export interface DebugAgentEntry {
  agentId: string
  label: string
  endpointId: string
  endpointName: string
  baseUrl: string
  model: string
  messages: Array<{ role: string; content: string | null }>
  rawResponse: string
  /** 🆕 DeepSeek 思维链（reasoning_content），可能为空 */
  reasoning?: string
  error?: string
  tokensUsed: number
  cacheHit: boolean
  duration: number
}

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

  // === Agent 管线状态（供 AgentStatusPanel 读取） ===
  interface AgentStatusEntry {
    agentId: string
    label: string
    startedAt: number
  }
  const agentStatus = ref<{ agentId: string; label: string; startedAt: number } | null>(null)
  const agentDurations = ref<{ agentId: string; label: string; elapsed: number }[]>([])

  const AGENT_LABELS: Record<string, string> = {
    memory_recall: '检索记忆',
    plot_pre_check: '剧情检查',
    story: '生成正文',
    request_dispatcher: '请求调度',
    vars_update: '更新状态',
    memory_summary: '压缩记忆',
    plot_post_check: '剧情修正',
    craft_gen: '制作中',
    char_gen: '角色生成',
    item_gen: '物品生成',
  }

  function updateAgentStatus(agentId: string) {
    agentStatus.value = {
      agentId,
      label: AGENT_LABELS[agentId] ?? agentId,
      startedAt: Date.now(),
    }
  }

  function clearAgentStatus(agentId: string, _error?: string) {
    if (agentStatus.value && agentStatus.value.agentId === agentId) {
      const elapsed = Date.now() - agentStatus.value.startedAt
      agentDurations.value = [
        ...agentDurations.value.slice(-9), // keep last 9 to avoid overflow
        { agentId, label: agentStatus.value.label, elapsed },
      ]
      agentStatus.value = null
    }
  }

  function clearAllAgentStatus() {
    agentStatus.value = null
    agentDurations.value = []
  }

  // === UI 布局状态 (Phase 7e) ===
  const sidebarCollapsed = ref(false)
  const activeModal = ref<string | null>(null)
  const fullscreenStatus = ref(false)

  // 选项填充 — ChatFlow 点击选项 → InputBar 填入
  const pendingInput = ref('')

  function fillInput(text: string) { pendingInput.value = text }
  function clearPendingInput() { pendingInput.value = '' }

  /** 是否已消费开场 Prompt（未消费 → 需要自动发送）
   *  注意：仅以 openingPromptConsumed 元数据为准，messages 长度不作为消费判定。
   *  因为创角流程可能会预先插入一条消息，但开场 prompt 仍应自动发送。 */
  const hasOpeningPromptConsumed = computed(() => {
    return activeSave.value?.metadata?.openingPromptConsumed === true
  })

  /** 获取开场 Prompt 文本 */
  const openingPrompt = computed(() => {
    return activeSave.value?.metadata?.openingPrompt ?? null
  })

  /** Agent 调用日志 — 每轮管线追加 */
  const agentLog = ref<DebugAgentEntry[]>([])

  /** 追加一条 Agent 调试日志 (idempotent: 同名 agent 替换) */
  function addAgentLogEntry(entry: DebugAgentEntry) {
    const existing = agentLog.value.findIndex(e => e.agentId === entry.agentId)
    if (existing >= 0) {
      agentLog.value[existing] = entry
    } else {
      agentLog.value.push(entry)
    }
  }

  /** 清除本轮所有调试日志 (新一轮开始时调用) */
  function clearAgentLog() {
    agentLog.value = []
  }

  /** 标记开场 Prompt 已消费 */
  async function markOpeningPromptConsumed() {
    if (!activeSave.value) return
    const clean = JSON.parse(JSON.stringify(activeSave.value))
    clean.metadata.openingPromptConsumed = true
    try {
      await saveSaveSlot(clean)
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
    if (!activeSaveId.value) {
      // 规范 §10: 消息 saveId 必填；无活跃存档时拒绝写入，避免产生永不召回的孤儿消息 (#13)
      console.error('[game-store] persistMessage 拒绝: activeSaveId 为空，消息未持久化:', msg.content.slice(0, 50))
      return
    }
    try {
      await saveMessage({ ...msg, saveId: activeSaveId.value })
    } catch (err) {
      console.error('[game-store] 消息持久化失败:', err)
    }
  }

  /** 从 IndexedDB 恢复消息到内存（始终覆写，无消息时清空） */
  async function restoreMessages() {
    if (!activeSaveId.value) return
    try {
      messages.value = await getMessages(activeSaveId.value)
    } catch (err) {
      console.error('[game-store] 恢复消息失败:', err)
      messages.value = []
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

    // 🔴 关键：先清空旧存档的所有内存状态，避免 DB 无数据时旧值残留
    clearActive()
    activeSaveId.value = saveId
    saves.value = [save]

    // 关键：先设置 activeSaveId，让 activeSave computed 能正确引用到 save
    console.log('[game-store] activeSave after set:', JSON.stringify({
      id: activeSave.value?.id,
      hasMetadata: !!activeSave.value?.metadata,
      hasOpeningPrompt: !!activeSave.value?.metadata?.openingPrompt,
      openingPromptConsumed: activeSave.value?.metadata?.openingPromptConsumed,
    }))

    // 加载关联数据（始终覆写，DB 返回 undefined 时写默认空值）
    const [chars, mems, events, profile] = await Promise.all([
      getCharacters(saveId),
      getMemories(saveId),
      getPlotEvents(saveId),
      getSaveProfile(saveId),
    ])

    characters.value = (chars as CharacterState[]) ?? []
    recentMemories.value = (mems as MemoryRecord[]) ?? []
    activePlotEvents.value = (events as PlotEvent[]) ?? []
    plotOutline.value = null
    activeCombat.value = null
    saveProfile.value = (profile as SaveProfile) ?? null

    // 快照恢复走 snapshots 表（规范 §11.2），机制在 M5 重建 (#2)

    // 从 messages 表恢复对话历史（始终覆写，无消息时为空数组）
    await restoreMessages()

    // 恢复 turnCounter（取最后一条 user/assistant 消息的 turn）
    const lastMsg = messages.value.filter(m => m.role === 'user' || m.role === 'assistant').pop()
    turnCounter = lastMsg?.turn ?? 0
  }

  /** 🆕 轻量回读：管线跑完后 StateManager / 侧链直接写了 Dexie，
   *  把 DB 里更新后的 save.metadata / characters / saveProfile 同步回内存。
   *  不动 messages / agentLog / combat 等 UI 态（与 loadSave 的全量重载区分开）。 */
  async function refreshFromDb() {
    if (!activeSaveId.value) return
    try {
      const [save, allChars, profile] = await Promise.all([
        getSave(activeSaveId.value),
        getCharacters(),   // 全量取后按一等 saveId 过滤追加（Task 4 起侧链 NPC 由 applyAddCharacter 注入 saveId）
        getSaveProfile(activeSaveId.value),
      ])

      // 1. save.metadata（totalTurns / openingPromptConsumed 等）
      if (save) {
        const idx = saves.value.findIndex((s: SaveSlot) => s.id === save.id)
        if (idx >= 0) saves.value[idx] = save
        else saves.value.push(save)
      }

      // 2. characters：合并语义 —— DB 版本覆盖同 id 内存版本（拿到最新背包/装备/资源），
      //    DB 里属于本存档但内存没有的角色追加；内存独有的（预览注入等）保留。
      const dbById = new Map((allChars as CharacterState[]).map(c => [c.id, c]))
      characters.value = characters.value.map(c => dbById.get(c.id) ?? c)
      const memIds = new Set(characters.value.map(c => c.id))
      for (const c of allChars as CharacterState[]) {
        if (!memIds.has(c.id) && c.saveId === activeSaveId.value) {
          characters.value.push(c)
        }
      }

      // 3. saveProfile（gameTime / fp / quests / news）
      if (profile) saveProfile.value = profile as SaveProfile
    } catch (err) {
      console.error('[game-store] refreshFromDb 失败:', err)
    }
  }

  function clearActive() {
    clearAllAgentStatus()
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
    loadSaves, loadSave, refreshFromDb, clearActive,
    pendingInput, fillInput, clearPendingInput,
    hasOpeningPromptConsumed, openingPrompt, markOpeningPromptConsumed,
    pendingOptions, setPendingOptions,
    agentStatus, agentDurations, updateAgentStatus, clearAgentStatus, clearAllAgentStatus,
    agentLog, addAgentLogEntry, clearAgentLog,
    persistMessage, restoreMessages,
  }
})
