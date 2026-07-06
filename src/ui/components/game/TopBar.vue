<script setup lang="ts">
import { computed } from 'vue'
import { useUIStore } from '../../stores/ui-store'
import { useGameStore } from '../../stores/game-store'
import { MONTH_NAMES, WEEKDAY_NAMES } from '@engine/time-system'

const ui = useUIStore()
const game = useGameStore()

const timeDisplay = computed(() => {
  const t = game.gameTime
  if (!t) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.era} ${pad(t.year)} 年 · ${MONTH_NAMES[t.month - 1]} · ${t.day} 日 · ${WEEKDAY_NAMES[t.weekday - 1]} · ${pad(t.hour)}:${pad(t.minute)}`
})
</script>

<template>
  <div class="top-bar">
    <button class="top-btn" @click="ui.navigate('home')" title="回到首页">
      ← 首页
    </button>
    <span class="top-time" v-if="timeDisplay">{{ timeDisplay }}</span>
    <span class="top-time dim" v-else>--</span>
    <button class="top-btn" @click="game.toggleFullscreen()" title="全屏">
      {{ game.fullscreenStatus ? '⛶ 退出' : '⛶ 全屏' }}
    </button>
  </div>
</template>

<style scoped>
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 2.75rem;
  padding: 0 12px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.top-btn {
  background: none;
  border: none;
  color: var(--theme-title-bar-icon);
  font-size: 0.8125rem;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  transition: background 150ms;
  font-family: inherit;
}
.top-btn:hover {
  background: var(--theme-title-bar-btn-hover);
}
.top-time {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 0.875rem;
  color: var(--theme-text-secondary);
  letter-spacing: 0.02em;
}
.top-time.dim {
  color: var(--theme-text-muted);
}
</style>