<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import InputBar from './InputBar.vue'
import type { ChatMessage, SystemEvent } from '@engine/types'
import { processRules, escapeHtml } from '@engine/beautifier'
import { useSettingsStore } from '../../stores/settings-store'
import CraftSystemCard from './cards/CraftSystemCard.vue'
import CharGenSystemCard from './cards/CharGenSystemCard.vue'
import CombatSystemCard from './cards/CombatSystemCard.vue'
import ItemSystemCard from './cards/ItemSystemCard.vue'
import SystemNotifBar from './cards/SystemNotifBar.vue'
import type { Component } from 'vue'

const CARD_COMPONENTS: Record<string, Component> = {
  craft: CraftSystemCard,
  char_gen: CharGenSystemCard,
  combat: CombatSystemCard,
  item_gen: ItemSystemCard,
}

const props = defineProps<{
  messages?: ChatMessage[]
  isGenerating?: boolean
  systemEventsVisible?: boolean
  systemEventFilters?: Record<string, boolean>
  streamingText?: string
}>()

const emit = defineEmits<{
  send: [content: string]
  'select-option': [text: string]
  stop: []
}>()

const settings = useSettingsStore()
const s = settings.settings

const container = ref<HTMLDivElement>()
const expandedIds = ref<Record<string, boolean>>({})

watch(() => props.messages?.length, () => {
  nextTick(() => {
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  })
})

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function toggleExpand(id: string) {
  if (expandedIds.value[id]) {
    collapseCard(id)
  } else {
    expandedIds.value = { ...expandedIds.value, [id]: true }
  }
}

function collapseCard(id: string) {
  // 整体替换对象确保 Vue 3 响应式追踪
  const next: Record<string, boolean> = {}
  for (const key of Object.keys(expandedIds.value)) {
    if (key !== id) next[key] = expandedIds.value[key]
  }
  expandedIds.value = next
}

function isComplexEvent(type: string): boolean {
  return type === 'craft' || type === 'char_gen' || type === 'combat' || type === 'item_gen'
}

/** 该系统事件是否应该显示 */
function isEventVisible(ev: SystemEvent): boolean {
  if (!props.systemEventsVisible) return false
  if (props.systemEventFilters && ev.type in props.systemEventFilters) {
    return props.systemEventFilters[ev.type]
  }
  return true // 未知类型默认显示
}

function eventIconClass(type: string): string {
  const icons: Record<string, string> = {
    craft: 'fa-solid fa-hammer',
    char_gen: 'fa-solid fa-user-plus',
    item_gen: 'fa-solid fa-gift',
    combat: 'fa-solid fa-swords',          /* Font Awesome 6 pro — 降级为 fa-hand-fist */
    character_update: 'fa-solid fa-arrow-trend-up',
    item_update: 'fa-solid fa-boxes-stacked',
    quest_update: 'fa-solid fa-list-check',
  }
  return icons[type] ?? 'fa-solid fa-circle-info'
}

/**
 * 美化助手文本 — 使用 settings 中配置的规则管道
 *
 * 段落处理: \n\n 分隔的文本段落包裹为 &lt;p&gt; 标签，
 * 使 CSS 的 text-indent 和段间距生效，实现「读小说」而非「读聊天」的排版。
 */
/** 合并预设规则 + 用户规则，返回完整美化规则列表 */
function getBeautifierRules(): import('@engine/types').BeautifierRule[] {
  const preset = (s.beautifierPresetRules ?? []) as import('@engine/types').BeautifierRule[]
  const user = (s.beautifierRules ?? []) as import('@engine/types').BeautifierRule[]
  const presetIds = new Set(preset.map(r => r.id))
  return [...preset, ...user.filter(r => !presetIds.has(r.id))]
}

function beautifyText(msg: ChatMessage): string {
  const raw = msg.content
  // 未启用美化时：走纯文本 + 换行转 &lt;br&gt;，不做段落包裹
  if (!s.beautifierEnabled) {
    return escapeHtml(raw).replace(/\n/g, '<br>')
  }
  const rules = getBeautifierRules()
  let html = processRules(raw, 'maintext', rules)
  // 将双换行分隔的文本段落包裹成 &lt;p&gt;，跳过已有 HTML 标签块（dialogue-card 等）
  html = wrapParagraphs(html)
  return html
}

/** 将双换行分隔的纯文本块包裹成 &lt;p&gt;，保留已有 HTML 标签不变 */
function wrapParagraphs(html: string): string {
  // 把 HTML 标签临时替换为占位符，避免被拆分
  const tags: string[] = []
  const placeholder = html.replace(/<[^>]+>/g, (match) => {
    tags.push(match)
    return `\x00TAG${tags.length - 1}\x00`
  })
  // 按双换行拆分
  const parts = placeholder.split(/\n\n+/)
  const wrapped = parts.map((part) => {
    const trimmed = part.trim()
    if (!trimmed) return ''
    // 纯 HTML 标签块（如 dialogue-card）不包裹 &lt;p&gt;，避免 block-in-inline 非法嵌套
    if (/^\x00TAG(\d+)\x00$/.test(trimmed)) return trimmed
    // 段内换行 → <br>（浏览器不渲染 \n，必须显式转换）
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`
  }).join('')
  // 还原 HTML 标签
  return wrapped.replace(/\x00TAG(\d+)\x00/g, (_, i) => tags[Number(i)])
}

/** 对流式文本实时应用美化（与 beautifyText 逻辑一致，但跳过最终的 wrapParagraphs 以避免边界闪烁） */
function beautifyStreamingText(raw: string): string {
  if (!raw) return ''
  if (!s.beautifierEnabled) {
    return escapeHtml(raw).replace(/\n/g, '<br>')
  }
  const rules = getBeautifierRules()
  // 美化后单换行转 <br>（浏览器不渲染裸 \n）
  return processRules(raw, 'maintext', rules).replace(/\n/g, '<br>')
}
</script>

<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages" tabindex="0">
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="msg in messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="bubble-row bubble-row-player">
          <div class="bubble bubble-player">
            <span class="bubble-prefix">你:</span>
            <span class="bubble-text" v-html="escapeHtml(msg.content).replace(/\n/g, '<br>')" />
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- AI 叙事消息 — 只渲染美化正文 -->
        <div v-else-if="msg.role === 'assistant'" class="bubble-row bubble-row-narrative">
          <div class="bubble bubble-narrative-full">
            <div class="narrative-body" v-html="beautifyText(msg)" />
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- 系统事件消息 — 简单类型：纯通知条，无折叠 -->
        <div
          v-else-if="msg.role === 'system' && msg.systemEvent && isEventVisible(msg.systemEvent) && !isComplexEvent(msg.systemEvent.type)"
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
            <span class="system-notif-chevron">▶</span>
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
        <span class="loading-dot">●</span> AI 正在生成...
      </div>

      <!-- 🆕 流式正文实时渲染 -->
      <div v-if="isGenerating && streamingText" class="bubble-row bubble-row-narrative">
        <div class="bubble bubble-narrative-full">
          <div class="narrative-body streaming-content" v-html="beautifyStreamingText(streamingText)" />
        </div>
      </div>
    </div>

    <InputBar :disabled="isGenerating" @send="(c) => emit('send', c)" @stop="emit('stop')" />
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
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  max-width: 800px;
  margin: 0 auto;
  color: var(--theme-text-muted);
  font-size: 1rem;
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
.bubble {
  width: 100%;
  max-width: 800px;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  font-size: 0.875rem;
  line-height: 1.6;
}
.bubble-player {
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  text-align: left;
  border-left: 3px solid var(--theme-primary);
}
.bubble-narrative {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, 'Cinzel', serif);
  text-align: left;
  border-left: 3px solid var(--theme-text-muted);
}
.bubble-narrative-full {
  width: 100%;
  max-width: 800px;
  padding: 12px 16px;
  border-radius: var(--theme-radius-md, 8px);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.875rem;
  line-height: 1.7;
  text-align: left;
  border-left: 3px solid var(--theme-text-muted);
}

/* ===== 叙事正文 ===== */
.narrative-body {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  color: var(--theme-text-primary);
  line-height: 1.7;
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

/* ===== 对话卡片 (Discord 风格) ===== */
.narrative-body :deep(.dialogue-card) {
  margin: 10px 0;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: var(--theme-surface-muted);
  border-left: 4px solid var(--theme-primary);
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
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
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
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
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
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: var(--theme-surface-muted);
  border-left: 3px solid var(--theme-primary);
  cursor: pointer;
  max-width: 800px;
  width: 100%;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  transition: background 0.15s;
  user-select: none;
}
.system-notif:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
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
  max-width: 800px;
  width: 100%;
}
</style>
