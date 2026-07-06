<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import InputBar from './InputBar.vue'

export interface FlowMessage {
  role: 'player' | 'assistant' | 'system'
  content: string
  timestamp?: number
}

const props = defineProps<{
  messages?: FlowMessage[]
  isGenerating?: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
}>()

const container = ref<HTMLDivElement>()

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
</script>

<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages">
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="(msg, i) in messages" :key="i">
        <div v-if="msg.role === 'player'" class="bubble-row bubble-row-player">
          <div class="bubble bubble-player">
            <span class="bubble-prefix">你:</span>
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <div v-else-if="msg.role === 'assistant'" class="bubble-row bubble-row-narrative">
          <div class="bubble bubble-narrative">
            <span class="bubble-prefix">正文:</span>
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <div v-else-if="msg.role === 'system'" class="bubble-row bubble-row-trigger">
          <div class="bubble bubble-trigger">
            <span class="bubble-prefix">⚡ 触发:</span>
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
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
  gap: 12px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
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
.bubble-row-player {
  justify-content: flex-end;
}
.bubble-row-narrative {
  justify-content: flex-start;
}
.bubble-row-trigger {
  justify-content: center;
}
.bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: var(--theme-radius-md, 8px);
  font-size: 0.875rem;
  line-height: 1.6;
}
.bubble-player {
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
}
.bubble-narrative {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.bubble-trigger {
  background: var(--theme-content-bg);
  border-left: 3px solid var(--theme-primary);
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  max-width: 85%;
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
</style>
