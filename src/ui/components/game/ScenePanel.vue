<script setup lang="ts">
import { computed } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useSettingsStore } from '../../stores/settings-store'
import { MONTH_NAMES, WEEKDAY_NAMES, getTimeOfDay } from '@engine/time-system'
import type { CharacterState } from '@engine/types'

const game = useGameStore()
const settings = useSettingsStore()
const s = settings.settings

// ═══ 时间 ═══
const timeInfo = computed(() => {
  const t = game.gameTime
  if (!t) return null
  return {
    era: `${t.era}${t.year}年`,
    date: `${MONTH_NAMES[t.month - 1]}${t.day}日 ${WEEKDAY_NAMES[t.weekday - 1]}`,
    time: `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
    timeOfDay: getTimeOfDay(t),
  }
})

// ═══ 位置 ═══
const locationDisplay = computed(() => {
  const loc = game.player?.location
  if (!loc) return '未知'
  return loc.replace(/-/g, ' · ')
})

// ═══ 天气 — 从游戏变量读取（由 request_dispatcher → vars_update 更新到 chat.variables） ═══
//
// 数据路线:
// 1. Story Agent 在正文中描写环境天气
// 2. request_dispatcher 读取正文，检测到天气变化
// 3. request_dispatcher 输出 <json> {"replace": [{"path": "天气", "value": "xxx"}]}
// 4. vars_update 处理 <json>，调用 applyVarsPatch → 写入 chat.variables["天气"]
// 5. 前端 reactively 从 game.variables 读取
//
// 当前获取优先级:
//   1. game.variables (chat.variables) — request_dispatcher + vars_update 写入
//   2. saveProfile.worldFlags — 存档级变量兜底
//   3. 空字符串 — 无天气数据
const weather = computed(() => {
  // 从最新消息的 variablesAfter 获取（vars_update 写入后的快照）
  const msgs = game.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const v = msgs[i].variablesAfter
    if (v && v['天气']) return v['天气'] as string
    if (v && v['weather']) return v['weather'] as string
  }
  // fallback: worldFlags 存档级
  return (game.saveProfile?.worldFlags?.['天气'] as string)
    ?? (game.saveProfile?.worldFlags?.['weather'] as string)
    ?? ''
})

// ═══ 在场角色 — 同地点前缀匹配 ═══
const presentChars = computed(() => {
  const all = game.characters
  const playerLoc = game.player?.location ?? ''
  if (!playerLoc) return []
  const locPrefix = playerLoc.split('-').slice(0, 2).join('-')
  return all.filter(c => {
    if (c.type === 'player') return false
    return (c.location || '').startsWith(locPrefix)
  })
})

// ═══ 思维链 ═══
const thinkingDisplay = computed(() => (s.thinkingDisplay as string) || 'fold')

const latestThinking = computed(() => {
  if (thinkingDisplay.value === 'hide') return ''
  const msgs = game.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].parsed?.thinking) {
      return msgs[i].parsed!.thinking.slice(0, 500)
    }
  }
  return ''
})

// ═══ 动作 ═══
function openChar(_char: CharacterState) {
  game.showModal('characters')
}
</script>

<template>
  <div class="scene-panel" v-if="game.activeSaveId">
    <!-- ═══════ 时间 ═══════ -->
    <div class="scene-section">
      <div class="scene-section-title">时间</div>
      <template v-if="timeInfo">
        <div class="scene-time-era">{{ timeInfo.era }}</div>
        <div class="scene-time-date">{{ timeInfo.date }}</div>
        <div class="scene-time-tod">{{ timeInfo.timeOfDay }} {{ timeInfo.time }}</div>
      </template>
      <div class="scene-empty" v-else>时间未同步</div>
    </div>

    <!-- ═══════ 位置 ═══════ -->
    <div class="scene-section">
      <div class="scene-section-title">位置</div>
      <div class="scene-location">{{ locationDisplay }}</div>
    </div>

    <!-- ═══════ 天气 ═══════ -->
    <div class="scene-section" v-if="weather">
      <div class="scene-section-title">天气</div>
      <div class="scene-weather">{{ weather }}</div>
    </div>

    <!-- ═══════ 在场角色 ═══════ -->
    <div class="scene-section">
      <div class="scene-section-title">在场 ({{ presentChars.length }})</div>
      <div class="scene-npc-list">
        <div
          v-for="char in presentChars"
          :key="char.id"
          class="scene-npc-item"
          :class="'npc-type-' + (char.type || 'npc')"
          @click="openChar(char)"
        >
          <span class="npc-dot" />
          <span class="npc-name">{{ char.name }}</span>
          <span class="npc-tier" v-if="char.tier">T{{ char.tier }}</span>
        </div>
        <div v-if="presentChars.length === 0" class="scene-npc-empty">
          暂无其他角色
        </div>
      </div>
    </div>

    <!-- ═══════ 思维链 ═══════ -->
    <div class="scene-section" v-if="latestThinking">
      <details class="scene-thinking" :open="thinkingDisplay === 'inline'">
        <summary class="scene-section-title scene-thinking-toggle">思维链</summary>
        <div class="scene-thinking-content">{{ latestThinking }}</div>
      </details>
    </div>
  </div>

  <!-- ═══ 未加载 ═══ -->
  <div class="scene-panel scene-panel-empty" v-else>
    <div class="scene-empty-msg">未选择存档</div>
  </div>
</template>

<style scoped>
/* ═══ 根容器 ═══ */
.scene-panel {
  width: 190px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--theme-content-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}

.scene-panel-empty {
  align-items: center;
  justify-content: center;
}

/* ═══ Section 区块 ═══ */
.scene-section {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.04));
}
.scene-section:last-child {
  border-bottom: none;
}

.scene-section-title {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--theme-text-muted);
  margin-bottom: 4px;
  font-family: system-ui, sans-serif;
}

/* ═══ 时间 ═══ */
.scene-time-era {
  font-family: var(--theme-font-title, serif);
  font-size: 0.85rem;
  color: var(--theme-text-primary);
  font-weight: 600;
}
.scene-time-date {
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
}
.scene-time-tod {
  font-size: 0.68rem;
  color: var(--theme-accent, var(--theme-primary));
}

/* ═══ 位置 ═══ */
.scene-location {
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  line-height: 1.4;
}

/* ═══ 天气 ═══ */
.scene-weather {
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  font-style: italic;
}

/* ═══ 在场角色 ═══ */
.scene-npc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}

.scene-npc-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  transition: background 0.1s;
}
.scene-npc-item:hover {
  background: var(--theme-tab-hover-bg);
}

.npc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.npc-type-player .npc-dot {
  background: #4caf50;
}
.npc-type-npc .npc-dot {
  background: #42a5f5;
}
.npc-type-ally .npc-dot,
.npc-type-summon .npc-dot {
  background: #66bb6a;
}
.npc-type-monster .npc-dot {
  background: #ef5350;
}

.npc-name {
  flex: 1;
  font-size: 0.72rem;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.npc-tier {
  font-size: 0.6rem;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 4px;
  border-radius: 2px;
  flex-shrink: 0;
}

.scene-npc-empty {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-style: italic;
  padding: 4px 6px;
}

/* ═══ 思维链 ═══ */
.scene-thinking {
  margin: 0;
}
.scene-thinking-toggle {
  cursor: pointer;
  list-style: none;
  margin-bottom: 0;
}
.scene-thinking-toggle::-webkit-details-marker {
  display: none;
}
.scene-thinking-toggle::before {
  content: '\25B6';
  display: inline-block;
  margin-right: 4px;
  font-size: 0.55rem;
  transition: transform 0.15s;
  vertical-align: middle;
}
details[open] .scene-thinking-toggle::before {
  transform: rotate(90deg);
}
.scene-thinking-content {
  margin-top: 4px;
  font-size: 0.68rem;
  color: var(--theme-text-muted);
  line-height: 1.4;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
}

/* ═══ 空态 ═══ */
.scene-empty {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.scene-empty-msg {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
</style>
