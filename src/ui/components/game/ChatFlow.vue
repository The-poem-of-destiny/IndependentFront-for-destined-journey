<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import InputBar from './InputBar.vue';
import type { ChatMessage, SystemEvent } from '@engine/types';
import { escapeHtml } from '@engine/beautifier';
import { splitSceneImageSegments } from '@engine/image-segments';
import { useSettingsStore } from '../../stores/settings-store';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useManualSceneImage } from '../../composables/useManualSceneImage';
import { computeConversationalDepths } from '../../lib/chat-depth';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import BeautifiedNarrative from './BeautifiedNarrative.vue';
import CraftSystemCard from './cards/CraftSystemCard.vue';
import CharGenSystemCard from './cards/CharGenSystemCard.vue';
import CombatSystemCard from './cards/CombatSystemCard.vue';
import ItemSystemCard from './cards/ItemSystemCard.vue';
import SystemNotifBar from './cards/SystemNotifBar.vue';
import type { Component } from 'vue';

const CARD_COMPONENTS: Record<string, Component> = {
  craft: CraftSystemCard,
  char_gen: CharGenSystemCard,
  combat: CombatSystemCard,
  item_gen: ItemSystemCard,
};

const props = defineProps<{
  messages?: ChatMessage[];
  isGenerating?: boolean;
  systemEventsVisible?: boolean;
  systemEventFilters?: Record<string, boolean>;
  streamingText?: string;
}>();

const emit = defineEmits<{
  send: [content: string];
  'select-option': [text: string];
  stop: [];
}>();

const settings = useSettingsStore();
const s = settings.settings;
const game = useGameStore();
const ui = useUIStore();
const sceneImages = useSceneImageStore();

const container = ref<HTMLDivElement>();
const expandedIds = ref<Record<string, boolean>>({});
const pinnedToBottom = ref(true);
const messageDepths = computed(() => computeConversationalDepths(props.messages ?? []));

/** 滚到底部（进存档 / 新消息 / 快照回退时调用）。nextTick 等本轮 DOM 落定。 */
function scrollToBottom() {
  nextTick(() => {
    const el = container.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 新消息是 `messages.value.push` —— 数组原地变更，只有 length 会变，靠它触发。
watch(
  () => props.messages?.length,
  () => scrollToBottom(),
);

// 载入存档 / 快照回退是 `messages.value = await getMessages(...)` —— 整体换数组，
// **长度可能完全不变**（回到同一轮），length watcher 不会触发，必须盯数组引用。
watch(
  () => props.messages,
  () => scrollToBottom(),
);

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function messageDepth(id: string): number {
  return messageDepths.value.get(id) ?? 0;
}

function toggleExpand(id: string) {
  if (expandedIds.value[id]) {
    collapseCard(id);
  } else {
    expandedIds.value = { ...expandedIds.value, [id]: true };
  }
}

function collapseCard(id: string) {
  // 整体替换对象确保 Vue 3 响应式追踪
  const next: Record<string, boolean> = {};
  for (const key of Object.keys(expandedIds.value)) {
    if (key !== id) next[key] = expandedIds.value[key];
  }
  expandedIds.value = next;
}

function isComplexEvent(type: string): boolean {
  return type === 'craft' || type === 'char_gen' || type === 'combat' || type === 'item_gen';
}

/** 该系统事件是否应该显示 */
function isEventVisible(ev: SystemEvent): boolean {
  if (!props.systemEventsVisible) return false;
  if (props.systemEventFilters && ev.type in props.systemEventFilters) {
    return props.systemEventFilters[ev.type];
  }
  return true; // 未知类型默认显示
}

function eventIconClass(type: string): string {
  const icons: Record<string, string> = {
    craft: 'fa-solid fa-hammer',
    char_gen: 'fa-solid fa-user-plus',
    item_gen: 'fa-solid fa-gift',
    combat: 'fa-solid fa-swords' /* Font Awesome 6 pro — 降级为 fa-hand-fist */,
    character_update: 'fa-solid fa-arrow-trend-up',
    item_update: 'fa-solid fa-boxes-stacked',
    quest_update: 'fa-solid fa-list-check',
  };
  return icons[type] ?? 'fa-solid fa-circle-info';
}

function handleChatScroll() {
  const el = container.value;
  if (!el) return;
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  closeCtxMenu();
}

function handleNarrativeResize() {
  if (!pinnedToBottom.value) return;
  nextTick(() => {
    const el = container.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ===== 右键菜单（回退 / 复制 / 为这一段配图）=====
/**
 * 🔴 菜单项**按消息过滤**（D33）：
 *
 * - 回退本轮 —— 仍然只在**最新一条** assistant 消息上出现（回退的是"这一轮"，
 *   对着三屏之前的段落给它，语义是空的）。
 * - 为这一段配图 —— **哪条都行**。story 被教了「克制使用」，所以"AI 没配图但我想要
 *   这一刻"必然存在，而付钱的是玩家。
 * - 🔴 `off` 档下配图项**不出现**。整个功能关掉时右键里还留着一个能开始花钱的入口，
 *   是「关掉了但没完全关掉」那类最招人烦的 bug。
 *
 * 一项能做的都没有时**不拦浏览器默认右键** —— 选中文字复制仍然是这里最常用的操作。
 */
const ctxMenu = ref<{
  x: number;
  y: number;
  msgId: string;
  canRollback: boolean;
  canImage: boolean;
} | null>(null);

/** 最新一条 assistant 消息（「回退本轮」仅对它生效） */
const latestAssistantMsg = computed<ChatMessage | undefined>(() => {
  const list = props.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i];
  }
  return undefined;
});

function menuFor(msg: ChatMessage): { canRollback: boolean; canImage: boolean } {
  return {
    canRollback: latestAssistantMsg.value?.id === msg.id,
    canImage: s.imageGenMode !== 'off',
  };
}

/** 这条消息上右键有没有事可做（也决定要不要把美化框里的右键转发上来） */
function canOpenMenu(msg: ChatMessage): boolean {
  if (game.isInCombat || props.isGenerating) return false;
  const can = menuFor(msg);
  return can.canRollback || can.canImage;
}

/** 悬停提示照着实际能做的事写 —— 写「回退本轮」却点不动是最没必要的一种困惑 */
function ctxHint(msg: ChatMessage): string {
  if (!canOpenMenu(msg)) return '';
  const can = menuFor(msg);
  const items: string[] = [];
  if (can.canRollback) items.push('回退本轮');
  if (can.canImage) items.push('为这一段配图');
  items.push('复制');
  return `右键：${items.join(' / ')}`;
}

function onContextMenu(e: MouseEvent, msg: ChatMessage) {
  if (!canOpenMenu(msg)) return;
  e.preventDefault();
  // 视口夹紧，避免菜单溢出屏幕
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 128);
  ctxMenu.value = { x, y, msgId: msg.id, ...menuFor(msg) };
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

async function ctxRollback() {
  const result = await game.rollbackOneTurn();
  closeCtxMenu();
  if (!result.ok && result.error) console.warn('[ChatFlow] 回退失败:', result.error);
}

async function ctxCopy() {
  const msgId = ctxMenu.value?.msgId;
  closeCtxMenu();
  const msg = (props.messages ?? []).find((m) => m.id === msgId);
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg.content);
  } catch (e) {
    console.warn('[ChatFlow] 复制失败:', e);
  }
}

// ===== 「为这一段配图」（D33 / D34 / D24）=====

/**
 * 手动开火那一条路。被限额拦下时**立起确认框而不是弹个 toast 就结束**（D24）——
 * 判定与正文按钮共用同一个 `checkQuota`（§5.3 不变式），出路也共用同一个 composable。
 */
const {
  busy: imageBusy,
  pending: quotaPending,
  request: requestImage,
  confirm: confirmQuota,
  dismiss: dismissQuota,
} = useManualSceneImage({
  generate: (input) => sceneImages.generate(input),
  notify: (message) => ui.toast(message, 'warning'),
});

/** 整条消息正文，已剥掉全部插画标记 —— `message-end` 的 `intent` 就是它（§10.2b） */
function strippedNarrativeOf(content: string): string {
  return splitSceneImageSegments(content)
    .filter(
      (segment): segment is Extract<typeof segment, { kind: 'text' }> => segment.kind === 'text',
    )
    .map((segment) => segment.text)
    .join('')
    .trim();
}

async function ctxSceneImage() {
  const msgId = ctxMenu.value?.msgId;
  closeCtxMenu();
  const msg = (props.messages ?? []).find((m) => m.id === msgId);
  if (!msg) return;
  const saveId = sceneImages.activeSaveId;
  if (saveId === null) {
    ui.toast('还没有载入存档，暂时画不了', 'warning');
    return;
  }
  const turn = msg.turn ?? 0;
  const narrative = strippedNarrativeOf(msg.content);
  await requestImage({
    saveId,
    messageId: msg.id,
    turn,
    // 🔴 message-end（D34）：渲染在该消息正文之后，occurrence 由 store 在同 anchorKind
    //    内顺延 —— 与标记那一路各自独立计数，互不干扰
    anchorKind: 'message-end',
    // 不做选中文本锚定：那是这套东西里最脆弱的一半（原文一改锚点就丢）
    intent: narrative,
    // 这里没有 story 写的标题，侧链跑完之前先用回合号占位（desc 之后会兼任说明）
    title: `第 ${turn} 回合的插画`,
    // 没有标记就没有出场角色名单 —— 侧链自己从正文里看
    characters: [],
    // 没有标记可钳，rating 上限就是这一张的 rating（D38）
    rating: s.imageMaxRating,
    narrative,
  });
}

function handleGlobalClick() {
  closeCtxMenu();
}
function handleEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu();
}
function handleScrollClose() {
  closeCtxMenu();
}

onMounted(() => {
  window.addEventListener('click', handleGlobalClick);
  window.addEventListener('keydown', handleEsc);
  window.addEventListener('scroll', handleScrollClose, true); // capture：捕获容器内滚动
  // 进存档时消息早已就位，两个 watcher 都不会触发 —— 必须显式滚一次。
  // 后续插画字节异步装载会触发 resize（pinnedToBottom 初值 true），自动保持钉底。
  scrollToBottom();
});
onUnmounted(() => {
  window.removeEventListener('click', handleGlobalClick);
  window.removeEventListener('keydown', handleEsc);
  window.removeEventListener('scroll', handleScrollClose, true);
});
</script>

<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages" tabindex="0" @scroll="handleChatScroll">
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <span class="chat-empty-glyph" aria-hidden="true">❦</span>
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="msg in messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="bubble-row bubble-row-player">
          <div class="bubble bubble-player">
            <span class="bubble-prefix">你:</span>
            <!-- 内容先过 escapeHtml()，再只把换行还原成 <br>。别把 escapeHtml 摘掉 -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span class="bubble-text" v-html="escapeHtml(msg.content).replace(/\n/g, '<br>')" />
            <span v-if="msg.timestamp" class="bubble-time">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- AI 叙事消息 — 只渲染美化正文 -->
        <!-- data-message-id 是 CG 图鉴「跳回那条消息」的锚点（§10.3），别删 -->
        <div
          v-else-if="msg.role === 'assistant'"
          :data-message-id="msg.id"
          class="bubble-row bubble-row-narrative"
          :title="ctxHint(msg)"
          @contextmenu="onContextMenu($event, msg)"
        >
          <div class="bubble bubble-narrative-full">
            <BeautifiedNarrative
              class="narrative-body"
              :text="msg.content"
              :depth="messageDepth(msg.id)"
              :forward-context-menu="canOpenMenu(msg)"
              :message-id="msg.id"
              :turn="msg.turn ?? 0"
              :image-mode="s.imageGenMode"
              :image-max-rating="s.imageMaxRating"
              :image-blur-by-default="s.imageBlurByDefault"
              @resize="handleNarrativeResize"
            />
            <span v-if="msg.timestamp" class="bubble-time">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- 系统事件消息 — 简单类型：纯通知条，无折叠 -->
        <div
          v-else-if="
            msg.role === 'system' &&
            msg.systemEvent &&
            isEventVisible(msg.systemEvent) &&
            !isComplexEvent(msg.systemEvent.type)
          "
          class="bubble-row bubble-row-system"
        >
          <SystemNotifBar :event="msg.systemEvent" />
        </div>

        <!-- 系统事件消息 — 复杂类型：通知条 ⇄ 卡片 -->
        <div
          v-else-if="msg.role === 'system' && msg.systemEvent && isEventVisible(msg.systemEvent)"
          class="bubble-row bubble-row-system"
        >
          <!-- 折叠通知条 -->
          <div
            v-if="!expandedIds[msg.id]"
            class="system-notif"
            :class="`system-notif-${msg.systemEvent.type}`"
            role="button"
            tabindex="0"
            :aria-expanded="false"
            @click="toggleExpand(msg.id)"
            @keydown.enter="toggleExpand(msg.id)"
            @keydown.space.prevent="toggleExpand(msg.id)"
          >
            <i :class="'system-notif-icon fa-solid ' + eventIconClass(msg.systemEvent.type)" />
            <span class="system-notif-text">{{ msg.content }}</span>
            <span class="system-notif-chevron">▸</span>
          </div>

          <!-- 展开卡片 -->
          <div v-else class="system-card-wrapper">
            <component
              :is="CARD_COMPONENTS[msg.systemEvent.type]"
              :event="msg.systemEvent"
              @collapse="collapseCard(msg.id)"
            />
          </div>
        </div>
      </template>

      <div v-if="isGenerating" class="chat-loading">
        <span class="loading-dot">·</span> AI 正在生成...
      </div>

      <!-- 🆕 流式正文实时渲染 -->
      <div v-if="isGenerating && streamingText" class="bubble-row bubble-row-narrative">
        <div class="bubble bubble-narrative-full">
          <BeautifiedNarrative
            class="narrative-body streaming-content"
            :text="streamingText"
            streaming
            @resize="handleNarrativeResize"
          />
        </div>
      </div>
    </div>

    <InputBar :disabled="isGenerating" @send="(c) => emit('send', c)" @stop="emit('stop')" />

    <!-- 右键菜单（回退只在最新一条；配图哪条都行，off 档下整项不出现） -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      >
        <button
          v-if="ctxMenu.canRollback"
          class="ctx-item"
          :disabled="game.isInCombat"
          @click.stop="ctxRollback"
        >
          <i class="fa-solid fa-rotate-left" /> 回退本轮
        </button>
        <button v-if="ctxMenu.canImage" class="ctx-item" @click.stop="ctxSceneImage">
          <i class="fa-solid fa-image" /> 为这一段配图
        </button>
        <button class="ctx-item" @click.stop="ctxCopy"><i class="fa-solid fa-copy" /> 复制</button>
      </div>
    </Teleport>

    <!--
      限额确认（D24）—— 手动**永不被拦死**，最多是要确认一下。
      🔴 显示的是 checkQuota 原样给的那句中文：它已经按「还能继续、只是要确认」的
         口吻写好了，在这里改写会让人以为功能坏了。
    -->
    <AppModal
      :open="quotaPending !== null"
      title="继续生成这张插画？"
      size="sm"
      @update:open="dismissQuota"
    >
      <p class="quota-msg">{{ quotaPending?.message }}</p>
      <template #footer>
        <AppButton variant="ghost" @click="dismissQuota">算了</AppButton>
        <AppButton variant="primary" :loading="imageBusy" @click="confirmQuota">仍然生成</AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.chat-flow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  max-width: 70ch;
  margin: 0 auto;
  color: var(--theme-text-muted);
  font-size: 1rem;
  font-family: var(--theme-font-title, serif);
}
.chat-empty-glyph {
  font-size: 1.5rem;
  color: color-mix(in srgb, var(--theme-primary) 55%, transparent);
  margin-bottom: 12px;
}
.chat-empty-hint {
  font-size: 0.8125rem;
  margin-top: 8px;
}
.bubble-row {
  display: flex;
  animation: msg-enter 0.35s ease both;
}
@keyframes msg-enter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bubble-row {
    animation: none;
  }
}
.bubble-row-player,
.bubble-row-narrative {
  justify-content: center;
}
/* 正文列已经是屏宽 50%，宽度由布局决定而非 ch 上限 ——
   原先 72ch 会在宽屏上把正文钉在中间、两侧留出大片空白。 */
.bubble {
  width: 100%;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  font-size: 0.875rem;
  line-height: 1.6;
}
/* 玩家发言 — 手稿旁注: 淡金底 + 整圈细描边 */
.bubble-player {
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
/* 叙事正文 — 书页而非卡片: 无边框无底色，靠留白与衬线成页 */
.bubble-narrative-full {
  width: 100%;
  max-width: 100%;
  padding: 4px 8px;
  color: var(--theme-text-primary);
  font-size: 0.9375rem;
  line-height: 1.8;
  text-align: left;
}

/* ===== 叙事正文 ===== */
.narrative-body {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  color: var(--theme-text-primary);
  line-height: 1.8;
  text-wrap: pretty;
}

/* 叙事正文段落排版 */
.narrative-body :deep(p) {
  text-indent: 2em;
  margin: 0 0 0.6em;
}
.narrative-body :deep(p:last-child) {
  margin-bottom: 0;
}
/* 对话卡片内的段落不缩进（对话格式不需要首行缩进） */
.narrative-body :deep(.dialogue-body p) {
  text-indent: 0;
}

/* ===== 对话卡片 ===== */
.narrative-body :deep(.dialogue-card) {
  margin: 10px 0;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: color-mix(in srgb, var(--theme-surface-muted) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
}
.narrative-body :deep(.dialogue-header) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.narrative-body :deep(.dialogue-avatar) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--theme-primary);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  font-family: system-ui, sans-serif;
  overflow: hidden;
  white-space: nowrap;
}
.narrative-body :deep(.dialogue-name) {
  font-weight: 700;
  font-size: 0.82rem;
  color: var(--theme-accent, var(--theme-primary));
  font-family: system-ui, sans-serif;
}
.narrative-body :deep(.dialogue-body) {
  font-size: 0.9rem;
  color: var(--theme-text-primary);
  line-height: 1.6;
  padding-left: 36px;
}

.bubble-prefix {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  margin-right: 6px;
  font-family: system-ui, sans-serif;
}
.bubble-time {
  display: block;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  margin-top: 4px;
}
.chat-loading {
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  padding: 8px;
}
.loading-dot {
  animation: pulse 1s infinite;
  display: inline-block;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}

/* ===== 流式正文 ===== */
.streaming-content {
  /* 流式渲染时使用闪烁光标提示正在输出 */
  position: relative;
}
.streaming-content::after {
  content: '▍';
  animation: cursor-blink 1s steps(1) infinite;
  color: var(--theme-primary);
  opacity: 0.8;
}
@keyframes cursor-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* ===== 系统消息 ===== */
.bubble-row-system {
  justify-content: center;
}

/* 折叠通知条 */
.system-notif {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: color-mix(in srgb, var(--theme-surface-muted) 70%, transparent);
  border: 1px solid var(--theme-card-border);
  cursor: pointer;
  max-width: 100%;
  width: 100%;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  transition:
    background 0.15s,
    border-color 0.15s;
  user-select: none;
}
.system-notif:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border));
}
.system-notif-icon {
  font-size: 0.8125rem;
  opacity: 0.7;
  width: 1.125rem;
  text-align: center;
}
.system-notif-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-notif-chevron {
  font-size: 0.625rem;
  opacity: 0.5;
  transition: transform 0.2s;
}

/* 展开卡片 */
.system-card-wrapper {
  max-width: 100%;
  width: 100%;
}

/* ===== 右键菜单 ===== */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  box-shadow: var(--theme-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.25));
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: system-ui, sans-serif;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: none;
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--theme-radius-sm, 4px);
  text-align: left;
}
.ctx-item:hover:not(:disabled) {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}
.ctx-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctx-item i {
  width: 1rem;
  text-align: center;
  opacity: 0.8;
}

/* 限额确认弹窗正文 —— 一句话，不缩进（它不是叙事） */
.quota-msg {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
  text-indent: 0;
}
</style>
