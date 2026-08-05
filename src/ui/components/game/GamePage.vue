<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useAudioStore } from '../../stores/audio-store';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useImagePresetStore } from '../../stores/image-preset-store';
import { GamePipeline } from '../../lib/game-pipeline';
import { buildSceneImageSeams, resolveSceneWeather } from '../../lib/scene-image-seams';
import { useCharacterAppearanceStore } from '../../stores/character-appearance-store';
import TopBar from './TopBar.vue';
import SideToolbar from './SideToolbar.vue';
import ChatFlow from './ChatFlow.vue';
import ScenePanel from './ScenePanel.vue';
import StatusHUD from './StatusHUD.vue';
import AppModal from '../shared/AppModal.vue';
import ItemsPanel from './ItemsPanel.vue';
import CharacterListPanel from './CharacterListPanel.vue';
import QuestsPanel from './QuestsPanel.vue';
import PlotPanel from './PlotPanel.vue';
import MemoryPanel from './MemoryPanel.vue';
import SnapshotPanel from './SnapshotPanel.vue';
import CgGalleryPanel from './CgGalleryPanel.vue';
import WorkshopEnablePanel from './WorkshopEnablePanel.vue';
import MapPanel from './MapPanel.vue';
import AgentStatusPanel from './AgentStatusPanel.vue';
import DebugPanel from './DebugPanel.vue';
import MiniPlayer from './MiniPlayer.vue';
import CombatPanel from './combat/CombatPanel.vue';

const game = useGameStore();
const ui = useUIStore();
const settings = useSettingsStore();
const audio = useAudioStore();
const sceneImages = useSceneImageStore();
const imagePresets = useImagePresetStore();
/** 角色外貌的会话副本（D56）—— 基线在 imagePresets，这一份随存档走 */
const charAppearance = useCharacterAppearanceStore();
const s = settings.settings;

let pipeline: GamePipeline | null = null;
const streamingText = ref('');

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  console.log('[GamePage] onMounted, activeSaveId:', ui.activeSaveId);
  if (ui.activeSaveId) {
    console.log('[GamePage] loading save...');
    await game.loadSave(ui.activeSaveId);
    // API endpoint construction is synchronous, so hydrate/migrate its secrets before creating it.
    await settings.initApiSecrets();
    console.log(
      '[GamePage] save loaded, hasOpeningPromptConsumed:',
      game.hasOpeningPromptConsumed,
      'openingPrompt exists:',
      !!game.openingPrompt,
    );
    // 创建 pipeline 实例
    pipeline = new GamePipeline({
      gameStore: game,
      settingsStore: settings,
      saveId: ui.activeSaveId,
    });
    // 🖼 情景插画：载入本存档的记录 + **挂上三条注入缝**。
    //
    // 🔴 缝不挂的话，每一次 generate() 都会以 prompt-agent 失败告终 —— 症状是
    //    「按了没反应、记录直接变红」，看起来像 store 坏了。装配逻辑全在
    //    `lib/scene-image-seams.ts`（不碰 Pinia，可单测），这里只负责接线。
    await sceneImages.load(ui.activeSaveId);
    void imagePresets.init();
    // 🔴 会话外貌副本**必须按存档载入**（D56）：不载入就会拿上一个存档的外貌去出图，
    //    而同一个角色名在两周目里长得不一样是正常的 —— 那正是会话副本存在的理由。
    await charAppearance.load(ui.activeSaveId);
    sceneImages.setSeams(
      buildSceneImageSeams({
        settings: () => settings.settings,
        // 🔴 交出去的是**基线 + 本档覆盖**合并后的预设（D56）：装配层只认一份外貌，
        //    会话覆盖在这里就地叠好，`composePrompt` 不必知道有两份定义这回事。
        presets: () =>
          imagePresets.presets.map((p) =>
            p.appearance ? { ...p, appearance: charAppearance.resolve(p.name, p.appearance) } : p,
          ),
        world: () => ({
          gameTime: game.saveProfile?.gameTime,
          weather: resolveSceneWeather(game.saveProfile),
          location: game.player?.location || undefined,
        }),
        runPromptAgent: (request, signal) =>
          pipeline
            ? pipeline.runImagePromptAgent(request, signal)
            : Promise.resolve({
                ok: false as const,
                kind: 'prompt-agent' as const,
                message: '游戏管线还没就绪，稍后再试',
                retryable: true,
              }),
      }),
    );
    // 🎵 曲库必须在这里装 —— 此前只有设置页音频分区和迷你播放器会 init()，
    // 没打开过它们的会话曲库是空的，选曲永远命中不了任何东西。
    // 装完按当前地点起一次场景配乐（读档回来的第一眼也该有音乐）。
    void audio
      .init()
      .then(() => pipeline?.primeSceneAudio())
      .catch((err) => console.warn('[GamePage] 音频初始化失败（不影响游戏）:', err));
    // 首次加载 → 自动发送开场 Prompt
    if (!game.hasOpeningPromptConsumed && game.openingPrompt) {
      console.log('[GamePage] sending opening prompt...');
      await pipeline.sendOpeningPrompt((chunk: string, isComplete: boolean) => {
        if (isComplete) {
          streamingText.value = '';
        } else {
          streamingText.value = chunk;
        }
      });
    } else {
      console.log(
        '[GamePage] NOT sending opening prompt. consumed:',
        game.hasOpeningPromptConsumed,
        'prompt empty:',
        !game.openingPrompt,
      );
    }
  } else {
    console.log('[GamePage] no activeSaveId, skipping');
  }
});

/** 🧪 开发用测试注入 — 仅 DEV 构建注册到 window / 快捷键（P1-14: 生产构建不暴露） */
async function injectChatFlowTest() {
  // 确保所有系统事件类型都可见
  s.systemEventsVisible = true;
  s.systemEventFilters = {
    craft: true,
    char_gen: true,
    item_gen: true,
    combat: true,
    character_update: true,
    item_update: true,
    quest_update: true,
  };
  // 动态 import：test-fixtures 只在调用时加载，不进生产首包
  const { injectTestData, buildScenePreviewMock } = await import('../../lib/test-fixtures');
  // 注入 ScenePanel 中段(在场NPC + thoughts 心里话) 与下段(新闻) 预览数据
  // 经 store.getThoughts(CharacterState.thoughts 正式字段，M6 单源)、saveProfile.news 读取
  const preview = buildScenePreviewMock();
  game.hydratePreview(preview);
  // 先清空再注入 ChatFlow 消息
  injectTestData({
    messages: game.messages,
    isGenerating: game.isGenerating,
  });
}

// 暴露到全局，方便控制台调用: window.__injectChatFlowTest__()
// 🔒 P1-14: 仅 DEV 构建暴露 —— 生产构建不该有可注入测试数据的入口（会污染真实存档）
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__injectChatFlowTest__ = injectChatFlowTest;
}

// Ctrl+Shift+T 快捷键注入 / Alt+Shift+D 调试面板 — 仅 DEV 构建响应（P1-14）
function onKeyDown(e: KeyboardEvent) {
  if (!import.meta.env.DEV) return;
  if (e.ctrlKey && e.shiftKey && e.key === 'T') {
    e.preventDefault();
    void injectChatFlowTest();
  }
  // Alt+Shift+D 切换调试面板
  if (e.altKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    showDebug.value = !showDebug.value;
  }
}

// ===== 调试面板 =====
const showDebug = ref(false);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  game.isGenerating = false;
  // 🖼 离开游戏页：中止在飞的出图、清掉排队的（§8.2）。排队中的一个字节都没花，
  //    删掉即可；在飞的那条会落 failed/aborted，因为上游照样计费。
  sceneImages.abortAll();
});

async function handleSend(content: string) {
  if (game.isGenerating || !pipeline) return;
  streamingText.value = '';
  await pipeline.run(content, (chunk: string, isComplete: boolean) => {
    if (isComplete) {
      streamingText.value = '';
    } else {
      streamingText.value = chunk;
    }
  });
}

function handleStop() {
  pipeline?.abort();
  streamingText.value = '';
}

function handleToolClick(id: string) {
  if (id === 'settings') {
    ui.navigate('settings');
    return;
  }
  // 迷你播放器是浮动卡片，不走 activeModal（§6.2），必须先于 showModal 拦下
  if (id === 'audio') {
    showMiniPlayer.value = !showMiniPlayer.value;
    return;
  }
  game.showModal(id);
}

/** 迷你播放器开合（浮动卡片，非 Modal） */
const showMiniPlayer = ref(false);

function handleSelectOption(text: string) {
  game.fillInput(text);
}

function onModalOpenChange(v: boolean) {
  if (!v) game.closeModal();
}
</script>

<template>
  <div class="game-page-layout">
    <TopBar />
    <div class="game-body" :class="{ 'rail-collapsed': game.sidebarCollapsed }">
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

    <MiniPlayer :open="showMiniPlayer" @close="showMiniPlayer = false" />

    <!-- M5 战斗面板（isInCombat 驱动，覆盖层） -->
    <CombatPanel />

    <AppModal
      title="背包 / 装备 / 技能"
      :open="game.activeModal === 'items'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <ItemsPanel />
    </AppModal>
    <AppModal
      title="角色列表"
      :open="game.activeModal === 'characters'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <CharacterListPanel />
    </AppModal>
    <AppModal
      title="任务"
      :open="game.activeModal === 'quests'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <QuestsPanel />
    </AppModal>
    <AppModal
      title="剧情规划"
      :open="game.activeModal === 'plot'"
      size="lg"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <PlotPanel />
    </AppModal>
    <AppModal
      title="记忆"
      :open="game.activeModal === 'memory'"
      size="lg"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <MemoryPanel />
    </AppModal>
    <AppModal
      title="快照"
      :open="game.activeModal === 'snapshots'"
      size="md"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <SnapshotPanel />
    </AppModal>
    <AppModal
      title="CG 图鉴"
      :open="game.activeModal === 'gallery'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <CgGalleryPanel />
    </AppModal>
    <AppModal
      title="工坊内容启用"
      :open="game.activeModal === 'workshop'"
      size="lg"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <WorkshopEnablePanel />
    </AppModal>
    <AppModal
      title="地图"
      :open="game.activeModal === 'map'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <MapPanel />
    </AppModal>
    <AppModal
      title="调试 & 导出"
      :open="game.activeModal === 'debug'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <DebugPanel />
    </AppModal>

    <!-- 调试面板 (Alt+Shift+D) -->
    <Teleport to="body">
      <div v-if="showDebug" class="debug-drawer">
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
          <pre>{{
            JSON.stringify(
              game.characters.map((c) => ({ id: c.id, name: c.name, type: c.type })),
              null,
              2,
            )
          }}</pre>
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
/* 三分屏比例（PC 16:9）: 左 25% (工具栏 + 场景栏) | 正文 50% | 状态栏 25%
   --rail-w 是工具栏实宽，ScenePanel 用 calc(25% - var(--rail-w)) 补足左侧那 25%，
   所以侧栏折叠时场景栏自动吃掉让出的宽度，左块恒为 25%。 */
.game-body {
  --rail-w: 4.2rem;
  display: flex;
  flex: 1;
  overflow: hidden;
}
.game-body.rail-collapsed {
  --rail-w: 1.925rem;
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
.debug-drawer {
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
