<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useUIStore } from '../../stores/ui-store'
import { useSettingsStore } from '../../stores/settings-store'
import { injectTestData, buildScenePreviewMock } from '../../lib/test-fixtures'
import { GamePipeline } from '../../lib/game-pipeline'
import TopBar from './TopBar.vue'
import SideToolbar from './SideToolbar.vue'
import ChatFlow from './ChatFlow.vue'
import ScenePanel from './ScenePanel.vue'
import StatusHUD from './StatusHUD.vue'
import AppModal from '../shared/AppModal.vue'
import ItemsPanel from './ItemsPanel.vue'
import CharacterListPanel from './CharacterListPanel.vue'
import QuestsPanel from './QuestsPanel.vue'
import PlotPanel from './PlotPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import MapPanel from './MapPanel.vue'
import AgentStatusPanel from './AgentStatusPanel.vue'
import DebugPanel from './DebugPanel.vue'

const game = useGameStore()
const ui = useUIStore()
const settings = useSettingsStore()
const s = settings.settings

let pipeline: GamePipeline | null = null
const streamingText = ref('')

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  console.log('[GamePage] onMounted, activeSaveId:', ui.activeSaveId)
  if (ui.activeSaveId) {
    console.log('[GamePage] loading save...')
    await game.loadSave(ui.activeSaveId)
    console.log('[GamePage] save loaded, hasOpeningPromptConsumed:', game.hasOpeningPromptConsumed, 'openingPrompt exists:', !!game.openingPrompt)
    // 创建 pipeline 实例
    pipeline = new GamePipeline({
      gameStore: game,
      settingsStore: settings,
      saveId: ui.activeSaveId,
    })
    // 首次加载 → 自动发送开场 Prompt
    if (!game.hasOpeningPromptConsumed && game.openingPrompt) {
      console.log('[GamePage] sending opening prompt...')
      await pipeline.sendOpeningPrompt((chunk: string, isComplete: boolean) => {
        if (isComplete) {
          streamingText.value = ''
        } else {
          streamingText.value += chunk
        }
      })
    } else {
      console.log('[GamePage] NOT sending opening prompt. consumed:', game.hasOpeningPromptConsumed, 'prompt empty:', !game.openingPrompt)
    }
  } else {
    console.log('[GamePage] no activeSaveId, skipping')
  }
})

// ===== 🧪 ChatFlow 测试注入 =====
/** 注入覆盖全 7 种卡片 + 对话流 + ScenePanel 中下段(在场NPC/心里话/新闻) 的测试数据 */
function injectChatFlowTest() {
  // 确保所有系统事件类型都可见
  s.systemEventsVisible = true
  s.systemEventFilters = {
    craft: true,
    char_gen: true,
    item_gen: true,
    combat: true,
    character_update: true,
    item_update: true,
    quest_update: true,
  }
  // 注入 ScenePanel 中段(在场NPC + thoughts 心里话) 与下段(新闻) 预览数据
  // 经 store.getThoughts(CharacterState.thoughts 正式字段，M6 单源)、saveProfile.news 读取
  const preview = buildScenePreviewMock()
  game.hydratePreview(preview)
  // 先清空再注入 ChatFlow 消息
  injectTestData({
    messages: game.messages,
    isGenerating: game.isGenerating,
  })
}

// 暴露到全局，方便控制台调用: window.__injectChatFlowTest__()
if (typeof window !== 'undefined') {
  ;(window as any).__injectChatFlowTest__ = injectChatFlowTest
}

// Ctrl+Shift+T 快捷键注入
function onKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === 'T') {
    e.preventDefault()
    injectChatFlowTest()
  }
  // Alt+Shift+D 切换调试面板
  if (e.altKey && e.shiftKey && e.key === 'D') {
    e.preventDefault()
    showDebug.value = !showDebug.value
  }
}

// ===== 调试面板 =====
const showDebug = ref(false)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  game.isGenerating = false
})

async function handleSend(content: string) {
  if (game.isGenerating || !pipeline) return
  streamingText.value = ''
  await pipeline.run(content, (chunk: string, isComplete: boolean) => {
    if (isComplete) {
      streamingText.value = ''
    } else {
      streamingText.value += chunk
    }
  })
}

function handleStop() {
  pipeline?.abort()
  streamingText.value = ''
}

function handleToolClick(id: string) {
  if (id === 'settings') {
    ui.navigate('settings')
    return
  }
  game.showModal(id)
}

function handleSelectOption(text: string) {
  game.fillInput(text)
}

function onModalOpenChange(v: boolean) {
  if (!v) game.closeModal()
}
</script>

<template>
  <div class="game-page-layout">
    <TopBar />
    <div class="game-body">
      <SideToolbar @tool-click="handleToolClick" />
      <ScenePanel />
      <ChatFlow
        :messages="game.messages"
        :is-generating="game.isGenerating"
        :system-events-visible="s.systemEventsVisible"
        :system-event-filters="s.systemEventFilters"
        :streaming-text="streamingText"
        @send="handleSend"
        @select-option="handleSelectOption"
        @stop="handleStop"
      />
      <StatusHUD />
      <AgentStatusPanel />
    </div>

    <AppModal title="背包 / 装备 / 技能" :open="game.activeModal === 'items'" @close="game.closeModal()" @update:open="onModalOpenChange" size="xxl" closable>
      <ItemsPanel />
    </AppModal>
    <AppModal title="角色列表" :open="game.activeModal === 'characters'" @close="game.closeModal()" @update:open="onModalOpenChange" size="xxl" closable>
      <CharacterListPanel />
    </AppModal>
    <AppModal title="任务" :open="game.activeModal === 'quests'" @close="game.closeModal()" @update:open="onModalOpenChange" size="xxl" closable>
      <QuestsPanel />
    </AppModal>
    <AppModal title="剧情规划" :open="game.activeModal === 'plot'" @close="game.closeModal()" @update:open="onModalOpenChange" size="lg" closable>
      <PlotPanel />
    </AppModal>
    <AppModal title="记忆" :open="game.activeModal === 'memory'" @close="game.closeModal()" @update:open="onModalOpenChange" size="lg" closable>
      <MemoryPanel />
    </AppModal>
    <AppModal title="快照" :open="game.activeModal === 'snapshots'" @close="game.closeModal()" @update:open="onModalOpenChange" size="md" closable>
      <div class="placeholder-panel">快照管理 — 后续实现</div>
    </AppModal>
    <AppModal title="地图" :open="game.activeModal === 'map'" @close="game.closeModal()" @update:open="onModalOpenChange" size="xxl" closable>
      <MapPanel />
    </AppModal>
    <AppModal title="调试 & 导出" :open="game.activeModal === 'debug'" @close="game.closeModal()" @update:open="onModalOpenChange" size="xxl" closable>
      <DebugPanel />
    </AppModal>

    <!-- 调试面板 (Alt+Shift+D) -->
    <Teleport to="body">
      <div v-if="showDebug" class="debug-panel">
        <div class="debug-header">
          <span>Debug Panel</span>
          <button @click="showDebug = false">✕</button>
        </div>
        <div class="debug-section">
          <h4>Messages ({{ game.messages.length }})</h4>
          <pre>{{ JSON.stringify(game.messages.slice(-5), null, 2) }}</pre>
        </div>
        <div class="debug-section">
          <h4>Save Profile</h4>
          <pre>{{ JSON.stringify(game.saveProfile, null, 2) }}</pre>
        </div>
        <div class="debug-section">
          <h4>Characters ({{ game.characters.length }})</h4>
          <pre>{{ JSON.stringify(game.characters.map(c => ({ id: c.id, name: c.name, type: c.type })), null, 2) }}</pre>
        </div>
        <div class="debug-section">
          <h4>Pending Options</h4>
          <pre>{{ JSON.stringify(game.pendingOptions, null, 2) }}</pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.game-page-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  min-width: 900px;
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

/* ===== 调试面板 ===== */
.debug-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  max-width: 90vw;
  height: 100vh;
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  border-left: 1px solid var(--theme-card-border);
  z-index: var(--z-tooltip, 500);
  overflow-y: auto;
  padding: 16px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.75rem;
}
.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--theme-card-border);
}
.debug-header span {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-primary);
}
.debug-header button {
  background: none;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.debug-section {
  margin-bottom: 16px;
}
.debug-section h4 {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  margin: 0 0 4px;
}
.debug-section pre {
  background: var(--theme-window-bg);
  padding: 8px;
  border-radius: 4px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
