<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useUIStore } from '../../stores/ui-store'
import { useSettingsStore } from '../../stores/settings-store'
import TopBar from './TopBar.vue'
import SideToolbar from './SideToolbar.vue'
import ChatFlow from './ChatFlow.vue'
import StatusHUD from './StatusHUD.vue'
import AppModal from '../shared/AppModal.vue'
import ItemsPanel from './ItemsPanel.vue'
import CharacterListPanel from './CharacterListPanel.vue'
import QuestsPanel from './QuestsPanel.vue'
import PlotPanel from './PlotPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import MapPanel from './MapPanel.vue'

const game = useGameStore()
const ui = useUIStore()
const settings = useSettingsStore()
const s = settings.settings

onMounted(async () => {
  if (ui.activeSaveId) {
    await game.loadSave(ui.activeSaveId)
  }
})

let mockTimer: ReturnType<typeof setTimeout> | null = null

onUnmounted(() => {
  if (mockTimer !== null) {
    clearTimeout(mockTimer)
    mockTimer = null
  }
  game.isGenerating = false
})

function handleSend(content: string) {
  if (game.isGenerating) return
  game.addMessage(content, 'user')
  // TODO: Phase 7e-3 — 接入 AgentOrchestrator，移除 mock
  game.isGenerating = true
  mockTimer = setTimeout(() => {
    game.addMessage('[AI 回复将在 Phase 7e-3 接入引擎后生效]', 'assistant')
    game.isGenerating = false
    mockTimer = null
  }, 500)
}

function handleToolClick(id: string) {
  if (id === 'settings') {
    ui.navigate('settings')
    return
  }
  game.showModal(id)
}
</script>

<template>
  <div class="game-page-layout">
    <TopBar />
    <div class="game-body">
      <SideToolbar @tool-click="handleToolClick" />
      <ChatFlow
        :messages="game.messages"
        :is-generating="game.isGenerating"
        :system-events-visible="s.systemEventsVisible"
        :system-event-filters="s.systemEventFilters"
        @send="handleSend"
      />
      <StatusHUD />
    </div>

    <AppModal title="背包 / 装备 / 技能" :open="game.activeModal === 'items'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="xxl" closable>
      <ItemsPanel />
    </AppModal>
    <AppModal title="角色列表" :open="game.activeModal === 'characters'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="xxl" closable>
      <CharacterListPanel />
    </AppModal>
    <AppModal title="任务" :open="game.activeModal === 'quests'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="xxl" closable>
      <QuestsPanel />
    </AppModal>
    <AppModal title="剧情规划" :open="game.activeModal === 'plot'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="lg" closable>
      <PlotPanel />
    </AppModal>
    <AppModal title="记忆" :open="game.activeModal === 'memory'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="lg" closable>
      <MemoryPanel />
    </AppModal>
    <AppModal title="快照" :open="game.activeModal === 'snapshots'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="md" closable>
      <div class="placeholder-panel">快照管理 — 后续实现</div>
    </AppModal>
    <AppModal title="🗺 地图" :open="game.activeModal === 'map'" @close="game.closeModal()" @update:open="(v: boolean) => { if (!v) game.closeModal() }" size="xxl" closable>
      <MapPanel />
    </AppModal>
  </div>
</template>

<style scoped>
.game-page-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--theme-window-bg);
  color: var(--theme-text-primary);
  overflow: hidden;
}
.game-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.placeholder-panel {
  padding: 2.5rem;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  min-height: 12.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* Panel content inside modals needs explicit height to scroll */
:deep(.modal-body) > :first-child {
  max-height: 55vh;
  overflow-y: auto;
}
</style>
