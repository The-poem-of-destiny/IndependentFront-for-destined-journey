import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SaveSlot, CharacterState, ChatMessage, MemoryRecord, PlotEvent, PlotOutline, CombatState, SaveProfile } from '@engine/types'
import { getSave, getSaves, getCharacters, getMemories, getPlotEvents, getSaveProfile } from '@engine/database'

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

  // === 记忆 & 剧情 ===
  const recentMemories = ref<MemoryRecord[]>([])
  const activePlotEvents = ref<PlotEvent[]>([])
  const plotOutline = ref<PlotOutline | null>(null)

  // === 战斗 & 制作 ===
  const activeCombat = ref<CombatState | null>(null)
  const isInCombat = computed(() => activeCombat.value !== null && activeCombat.value.status !== 'ended')

  // === 元数据 ===
  const saveProfile = ref<SaveProfile | null>(null)
  const fp = computed(() => saveProfile.value?.fp || 0)

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
  }

  function clearActive() {
    activeSaveId.value = null
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
    saveProfile, fp,
    loadSaves, loadSave, clearActive,
  }
})
