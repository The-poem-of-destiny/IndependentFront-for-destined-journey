<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import InputBar from './InputBar.vue'
import type { ChatMessage, SystemEvent } from '@engine/types'

import CraftSystemCard from './cards/CraftSystemCard.vue'
import CharGenSystemCard from './cards/CharGenSystemCard.vue'
import CombatSystemCard from './cards/CombatSystemCard.vue'
import ItemSystemCard from './cards/ItemSystemCard.vue'
import SystemNotifBar from './cards/SystemNotifBar.vue'

const props = defineProps<{
  messages?: ChatMessage[]
  isGenerating?: boolean
  systemEventsVisible?: boolean
  systemEventFilters?: Record<string, boolean>
}>()

const emit = defineEmits<{
  send: [content: string]
}>()

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
    delete expandedIds.value[id]
  } else {
    expandedIds.value[id] = true
  }
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
</script>

<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages">
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="msg in messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="bubble-row bubble-row-player">
          <div class="bubble bubble-player">
            <span class="bubble-prefix">你:</span>
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- AI 叙事消息 -->
        <div v-else-if="msg.role === 'assistant'" class="bubble-row bubble-row-narrative">
          <div class="bubble bubble-narrative">
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- 系统事件消息 -->
        <div
          v-else-if="msg.role === 'system' && msg.systemEvent && isEventVisible(msg.systemEvent)"
          class="bubble-row bubble-row-system"
        >
          <!-- 折叠通知条 -->
          <div
            v-if="!expandedIds[msg.id]"
            class="system-notif"
            :class="`system-notif-${msg.systemEvent.type}`"
            @click="toggleExpand(msg.id)"
          >
            <i :class="'system-notif-icon fa-solid ' + eventIconClass(msg.systemEvent.type)" />
            <span class="system-notif-text">{{ msg.content }}</span>
            <span class="system-notif-chevron">▶</span>
          </div>

          <!-- 展开的系统卡片 — 组件自带折叠交互 -->
          <div v-else class="system-card-wrapper">
            <CraftSystemCard
              v-if="msg.systemEvent.type === 'craft'"
              :event="msg.systemEvent"
            />
            <CharGenSystemCard
              v-else-if="msg.systemEvent.type === 'char_gen'"
              :event="msg.systemEvent"
            />
            <CombatSystemCard
              v-else-if="msg.systemEvent.type === 'combat'"
              :event="msg.systemEvent"
            />
            <ItemSystemCard
              v-else-if="msg.systemEvent.type === 'item_gen'"
              :event="msg.systemEvent"
            />
            <SystemNotifBar
              v-else
              :event="msg.systemEvent"
            />
          </div>
        </div>
      </template>

      <div v-if="isGenerating" class="chat-loading">
        <span class="loading-dot">●</span> AI 正在生成...
      </div>
    </div>

    <InputBar @send="(c) => emit('send', c)" />
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
.system-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--theme-surface-muted);
  border-bottom: 1px solid var(--theme-border, rgba(255,255,255,0.06));
  cursor: pointer;
  user-select: none;
}
.system-card-header:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}
.system-card-icon {
  font-size: 1rem;
}
.system-card-title {
  flex: 1;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-card-chevron {
  font-size: 0.625rem;
  opacity: 0.5;
}
.system-card-body {
  padding: 12px;
}
</style>
