<script setup lang="ts">
import { useGameStore } from '../../stores/game-store'
import { ref, computed, onMounted, onUnmounted } from 'vue'

const game = useGameStore()

/** 持续递增的 tick，每 250ms +1，产生 reactive 副作用驱动计时 */
const tick = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => { tick.value++ }, 250)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/** 随 tick 自动刷新的已过毫秒 */
const currentElapsedMs = computed(() => {
  void tick.value  // 消费 tick 确保依赖追踪
  if (!game.agentStatus) return 0
  return Date.now() - game.agentStatus.startedAt
})

/** 格式化毫秒为 mm:ss */
function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
</script>

<template>
  <Teleport to="body">
    <transition name="slide-up">
      <div v-if="game.isGenerating || game.agentStatus" class="agent-status-panel">
        <!-- 当前 Agent -->
        <div class="agent-current">
          <div class="agent-spinner" />
          <span class="agent-label">{{ game.agentStatus.label }}</span>
          <span class="agent-timer">{{ formatElapsed(currentElapsedMs) }}</span>
        </div>

        <!-- 已完成的 Agent 列表 -->
        <div v-if="game.agentDurations.length > 0" class="agent-history">
          <span
            v-for="d in game.agentDurations"
            :key="d.agentId + '-' + d.elapsed"
            class="agent-done"
          >
            {{ d.label }}
            <span class="agent-done-time">{{ formatElapsed(d.elapsed) }}</span>
          </span>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.agent-status-panel {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 950;
  min-width: 200px;
  max-width: 280px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack, 0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent), 0 4px 12px rgba(0,0,0,0.08));
  padding: var(--theme-spacing-md, 12px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 当前 Agent */
.agent-current {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid var(--theme-card-border);
  border-top-color: var(--theme-primary);
  border-radius: 50%;
  animation: agent-spin 0.6s linear infinite;
}

@keyframes agent-spin {
  to { transform: rotate(360deg); }
}

.agent-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--theme-text-primary);
  flex: 1;
}

.agent-timer {
  font-size: 0.6875rem;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--theme-text-muted);
  white-space: nowrap;
}

/* 已完成 Agent 历史 */
.agent-history {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--theme-card-border);
}

.agent-done {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  padding: 2px 6px;
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-surface-muted);
}

.agent-done-time {
  color: var(--theme-text-muted);
  opacity: 0.6;
}

/* 过渡 */
.slide-up-enter-active {
  transition: all 0.2s ease;
}
.slide-up-leave-active {
  transition: all 0.15s ease;
}
.slide-up-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .agent-spinner {
    animation: none;
  }
  .slide-up-enter-active,
  .slide-up-leave-active {
    transition: none;
  }
}
</style>
