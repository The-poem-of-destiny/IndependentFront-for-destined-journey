<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useGameStore, setRewriteLoadoutImpl } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useAudioStore } from '../../stores/audio-store';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useImagePresetStore } from '../../stores/image-preset-store';
import { unwireEffectSystem } from '@engine/effect-wiring';
import { GamePipeline, waitForGameSaveIdle } from '../../lib/game-pipeline';
import { buildSceneImageSeams, resolveSceneWeather } from '../../lib/scene-image-seams';
import { getContentRegistry } from '../../stores/content-store';
import { useCharacterAppearanceStore } from '../../stores/character-appearance-store';
import {
  appearanceWriteTarget,
  buildEffectivePresets,
  needsBaselineReport,
} from '@engine/character-appearance-resolve';
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
import MapPanel from './MapPanel.vue';
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
let disposed = false;
const requestedSaveId = ui.activeSaveId;
const ownsPage = () =>
  !disposed && ui.currentView === 'game' && ui.activeSaveId === requestedSaveId;
const streamingText = ref('');
const loadingSave = ref(true);
let streamingFrame: number | null = null;
let pendingStreamingText = '';

function cancelStreamingPreview() {
  if (streamingFrame !== null) cancelAnimationFrame(streamingFrame);
  streamingFrame = null;
  pendingStreamingText = '';
  streamingText.value = '';
}

/** 网络 delta 可能远快于绘制；每帧只提交最新可见快照，避免整段正文重复重排。 */
function handleStoryChunk(chunk: string, isComplete: boolean) {
  if (isComplete) {
    cancelStreamingPreview();
    return;
  }
  pendingStreamingText = chunk;
  if (streamingFrame !== null) return;
  streamingFrame = requestAnimationFrame(() => {
    streamingFrame = null;
    streamingText.value = pendingStreamingText;
  });
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  console.log('[GamePage] onMounted, activeSaveId:', ui.activeSaveId);
  if (requestedSaveId) {
    try {
      console.log('[GamePage] loading save...');
      await waitForGameSaveIdle(requestedSaveId);
      if (!ownsPage()) return;
      if (!(await game.loadSave(requestedSaveId)) || !ownsPage()) return;
      // API endpoint construction is synchronous, so hydrate/migrate its secrets before creating it.
      await settings.initApiSecrets();
      if (!ownsPage()) return;
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
        saveId: requestedSaveId,
      });
      // 🖼 情景插画：载入本存档的记录 + **挂上三条注入缝**。
      //
      // 🔴 缝不挂的话，每一次 generate() 都会以 prompt-agent 失败告终 —— 症状是
      //    「按了没反应、记录直接变红」，看起来像 store 坏了。装配逻辑全在
      //    `lib/scene-image-seams.ts`（不碰 Pinia，可单测），这里只负责接线。
      await sceneImages.load(requestedSaveId, ownsPage);
      if (!ownsPage()) return;
      void imagePresets.init();
      // 🔴 会话外貌副本**必须按存档载入**（D56）：不载入就会拿上一个存档的外貌去出图，
      //    而同一个角色名在两周目里长得不一样是正常的 —— 那正是会话副本存在的理由。
      await charAppearance.load(requestedSaveId, ownsPage);
      if (!ownsPage()) return;
      sceneImages.setSeams(
        buildSceneImageSeams({
          settings: () => settings.settings,
          // 🔴 交出去的是注册表那一面的**原始值**（图像 v2 / C4）：解析与用户覆盖的叠加
          //    留在 seams 里（纯函数、有测试）。这里现取现给 —— 内容包换了方言表之后
          //    不必重挂缝，与 `settings` 同一条纪律
          rawDialects: () => getContentRegistry().imageDialects,
          // 🔴 交出去的是**基线 + 本档覆盖**合并后的预设（D56）：装配层只认一份外貌，
          //    会话覆盖在这里就地叠好，`composePrompt` 不必知道有两份定义这回事。
          //
          // 🔴 合并归 `buildEffectivePresets`（纯函数、有测试），**不在这个 .vue 里手写** ——
          //    它还要负责 v1.3 那一半：**只有会话副本、没有预设行**的角色（AI 即兴出来的
          //    那些）也必须出现在结果里。漏掉他们，那份即兴外貌永远到不了提示词，表现是
          //    「AI 明明报了外貌，画出来还是每张一个样」。这类漏供值的缺陷 .vue 里的单组件
          //    测试证明不了（blurByDefault 当年就是这么死的），所以逻辑不留在这儿。
          presets: () => buildEffectivePresets(imagePresets.presets, charAppearance.rows),
          world: () => ({
            gameTime: game.saveProfile?.gameTime,
            weather: resolveSceneWeather(game.saveProfile),
            location: game.player?.location || undefined,
          }),
          // D57：引擎知道谁还没有任何可用外貌，直接告诉侧链 —— 模型看不到库，
          // 「第一次出场」这件事它自己永远判断不出来。
          // 🔴 判据含**会话副本**：报过一次之后就该收声，否则每张图都会让模型把九个槽
          //    重新即兴一遍，点名本身反而成了漂移的来源（见 needsBaselineReport）。
          charactersNeedingBaseline: (names) =>
            names.filter((n) =>
              needsBaselineReport(imagePresets.find('character', n), charAppearance.patchOf(n)),
            ),
          /**
           * AI 报了外貌变化（D56/D57，v1.3 修订）。
           *
           * 🔴 **一律写会话副本，AI 永远碰不到基线**。差量基准由 `appearanceWriteTarget`
           *    给：有基线就是基线，没有就是全空（那份即兴外貌）。此前这里的分支会为
           *    「没有基线」的角色调 `imagePresets.upsert` **建一份全局基线** —— 而全局
           *    意味着 A 周目的即兴成了 B 周目的定义，且两个重置口都够不着它，设置页却
           *    正写着「初始设定不受影响」。
           *
           * 🔴 `skip` 那一支是用户**手写的老形态预设**（有 danbooru 串、没有槽）：会话层
           *    只能表达槽，落下去会让合并后的槽盖过那串手写标签，等于 AI 悄悄改写了用户
           *    写的东西。宁可这一档记不住「她换了衣服」。
           */
          applyAppearances: async (list) => {
            for (const item of list) {
              const target = appearanceWriteTarget(imagePresets.find('character', item.name));
              if (target.kind === 'skip') continue;
              await charAppearance.applyPatch(item.name, target.base, item.patch);
            }
          },
          // 🔴 第三参是**方言的 systemPrompt**（C3/C5）：解析在 seams 里发生（全仓一处），
          //    这里只负责原样转达。忘了转达不会报错 —— 只是换了方言之后侧链仍按老吃法
          //    说话，产出一串给错模型的标签
          runPromptAgent: (request, signal, systemPrompt) =>
            pipeline
              ? pipeline.runImagePromptAgent(request, signal, systemPrompt)
              : Promise.resolve({
                  ok: false as const,
                  kind: 'prompt-agent' as const,
                  message: '游戏管线还没就绪，稍后再试',
                  retryable: true,
                }),
        }),
      );
      // 🆕 重铸（2026-08-24）：单条目重铸的注入缝 —— GamePipeline 装配
      //     endpoint / chainData（含 worldBooks） / stateManager；store 与面板不直接碰装配。
      setRewriteLoadoutImpl((characterId, target, userDescription) =>
        pipeline
          ? pipeline.rewriteLoadoutItem(characterId, target, userDescription)
          : Promise.resolve({ ok: false, reason: '游戏管线还没就绪，稍后再试' }),
      );
      // 🎵 曲库必须在这里装 —— 此前只有设置页音频分区和迷你播放器会 init()，
      // 没打开过它们的会话曲库是空的，选曲永远命中不了任何东西。
      // 装完按当前地点起一次场景配乐（读档回来的第一眼也该有音乐）。
      void audio
        .init()
        .then(() => (ownsPage() ? pipeline?.primeSceneAudio() : undefined))
        .catch((err) => console.warn('[GamePage] 音频初始化失败（不影响游戏）:', err));
      // 首次加载 → 自动发送开场 Prompt
      loadingSave.value = false;
      if (!game.hasOpeningPromptConsumed && game.openingPrompt) {
        console.log('[GamePage] sending opening prompt...');
        await pipeline.sendOpeningPrompt(handleStoryChunk);
      } else {
        console.log(
          '[GamePage] NOT sending opening prompt. consumed:',
          game.hasOpeningPromptConsumed,
          'prompt empty:',
          !game.openingPrompt,
        );
      }
    } catch (err) {
      if (ownsPage()) {
        ui.toast(`存档加载失败：${err instanceof Error ? err.message : '请重试'}`, 'error');
        ui.navigate('home');
      }
    }
  } else {
    console.log('[GamePage] no activeSaveId, skipping');
  }
});

/** 🧪 开发用测试注入 — 仍限定 DEV 构建，且要求用户已开启开发者模式。 */
async function injectChatFlowTest() {
  if (!s.developerMode) return;
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

// Alt+Shift+D 属于用户可控的开发者模式；Ctrl+Shift+T 测试注入仍只在 DEV 构建响应。
function onKeyDown(e: KeyboardEvent) {
  if (!s.developerMode) return;
  if (import.meta.env.DEV && e.ctrlKey && e.shiftKey && e.key === 'T') {
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

// 关闭开关必须立刻收起所有原始诊断面，不能只把下次入口藏起来。
watch(
  () => s.developerMode,
  (enabled) => {
    if (enabled) return;
    showDebug.value = false;
    if (game.activeModal === 'debug') game.closeModal();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  game.invalidatePendingLoads();
  window.removeEventListener('keydown', onKeyDown);
  // 🔴 COR-02（2026-08-09 审查）：**先 abort 再清 isGenerating**。
  // 应用没有 KeepAlive（App.vue 用 `:key="ui.currentView"`），而「← 首页」是一个
  // 始终可点的按钮 —— 生成中途导航就会在这里卸载 GamePage。此前不调 abort，仍在飞的
  // run() 之后会走到 handleAgentResult → game.addMessage(...)，而 game-store 是从
  // **store** 而不是从 pipeline 取存档号的。于是「存档 A 生成中 → 回首页 → 打开存档 B」
  // 会把为 A 生成的正文追加进 B 并以 saveId:B 落库，永久留在 B 的历史里。
  // （漏网写入还有第二道闸：GamePipeline 内的 emitMessage 存档归属检查。）
  pipeline?.dispose();
  if (requestedSaveId) unwireEffectSystem(requestedSaveId);
  // 🆕 T4（设计 §8.1 / §9）：离开游戏页 = 存档切换/销毁的既有清理点。本 pipeline 是
  //    per-save 实例，invalidatePromptSessions 只清自己的 saveId 的全部 prompt session
  //    （切档/删档都发生在离开游戏页之后，而 session 是模块级内存态，不清会一直驻留）。

  cancelStreamingPreview();
  game.isGenerating = false;
  // 🖼 离开游戏页：中止在飞的出图、清掉排队的（§8.2）。排队中的一个字节都没花，
  //    删掉即可；在飞的那条会落 failed/aborted，因为上游照样计费。
  sceneImages.abortAll();
  // ⚔️ 结算确认框挂起时离开页面（2026-08-13 需求 D）：裁决不可能发生了，
  //    exitCombat 收掉挂起的 await（resolve(null)）并清确认态——否则 pipeline 的
  //    await 永久悬挂。战斗进行中/就绪态**不清**：切设置页再回来战斗还能接着打
  //    （CombatPanel 重新挂载后 v3ActiveCombat 还在，这是现状下能工作的场景）。
  if (game.combatSummaryReview) game.exitCombat();
});

async function handleSend(content: string) {
  if (game.isGenerating || !pipeline) return;
  cancelStreamingPreview();
  await pipeline.run(content, handleStoryChunk);
}

async function handleRetry(messageId: string) {
  if (game.isGenerating || !pipeline) return;
  const message = game.messages.find((entry) => entry.id === messageId && entry.role === 'user');
  if (!message) return;
  cancelStreamingPreview();
  await pipeline.run(message.content, handleStoryChunk, false, message.id);
}

function handleStop() {
  pipeline?.abort();
  cancelStreamingPreview();
}

function handleToolClick(id: string) {
  if (id === 'settings') {
    ui.navigate('settings');
    return;
  }
  if (id === 'extensions') {
    ui.navigate('extensions');
    return;
  }
  // 迷你播放器是浮动卡片，不走 activeModal（§6.2），必须先于 showModal 拦下
  if (id === 'audio') {
    showMiniPlayer.value = !showMiniPlayer.value;
    return;
  }
  if (id === 'debug' && !s.developerMode) return;
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
      <div v-if="loadingSave" class="save-loading" role="status">
        正在加载存档，等待上一回合收尾…
      </div>
      <ChatFlow
        v-else
        :messages="game.messages"
        :is-generating="game.isGenerating"
        :system-events-visible="s.systemEventsVisible"
        :system-event-filters="s.systemEventFilters"
        :streaming-text="streamingText"
        @send="handleSend"
        @select-option="handleSelectOption"
        @stop="handleStop"
        @retry-turn="handleRetry"
      />
      <StatusHUD />
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
      size="xxl"
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
      :open="s.developerMode && game.activeModal === 'debug'"
      size="xxl"
      closable
      @close="game.closeModal()"
      @update:open="onModalOpenChange"
    >
      <DebugPanel />
    </AppModal>

    <!-- 调试面板 (Alt+Shift+D) -->
    <Teleport to="body">
      <div v-if="s.developerMode && showDebug" class="debug-drawer">
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
.save-loading {
  flex: 1;
  align-self: center;
  padding: var(--theme-spacing-lg);
  color: var(--theme-text-secondary);
  text-align: center;
}

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
