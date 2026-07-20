<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useSettingsStore } from '../../stores/settings-store'
import { markNewsRead } from '@engine/save-profile'
import { MONTH_NAMES, WEEKDAY_NAMES, getTimeOfDay } from '@engine/time-system'
import { nameColorVar, initialsOf } from '../../utils/name-color'
import { formatRel } from '../../utils/time-format'
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

/**
 * 时段 → 图标 + 氛围色 token
 *
 * 7 档时段分到 4 个视觉氛围 (凌晨/深夜→夜 / 早晨/上午→昼前 / 中午/下午→昼 / 傍晚→夕)
 * 氛围色用主题语义 token，不引入硬编码 hex，双模式下都能呼吸。
 */
const TOD_META: Record<string, { icon: string; colorVar: string }> = {
  凌晨: { icon: 'fa-solid fa-moon', colorVar: '--theme-quality-rare' },       // 静谧蓝
  早晨: { icon: 'fa-solid fa-sun', colorVar: '--theme-quality-uncommon' },   // 晨光绿
  上午: { icon: 'fa-solid fa-sun', colorVar: '--theme-quality-uncommon' },
  中午: { icon: 'fa-solid fa-sun', colorVar: '--theme-warning' },             // 正午金
  下午: { icon: 'fa-solid fa-sun', colorVar: '--theme-warning' },
  傍晚: { icon: 'fa-solid fa-cloud-sun', colorVar: '--theme-quality-mythic' }, // 黄昏赤
  深夜: { icon: 'fa-solid fa-moon', colorVar: '--theme-quality-rare' },
}

const todMeta = computed(() => {
  const t = game.gameTime
  if (!t) return null
  const tod = getTimeOfDay(t)
  return TOD_META[tod] ?? { icon: 'fa-solid fa-clock', colorVar: '--theme-text-muted' }
})

// ═══ 位置 ═══
const locationDisplay = computed(() => {
  const loc = game.player?.location
  if (!loc) return '未知'
  return loc.replace(/-/g, ' · ')
})

// ═══ 天气 —— 变量真源 SaveProfile.variables（M5 §12；dispatcher 的 天气 变量落 sys 命名空间），worldFlags 兜底旧数据 ═══
const weather = computed(() => {
  const sys = (game.saveProfile?.variables as any)?.sys
  const wf = game.saveProfile?.worldFlags
  return (sys?.['天气'] as string) ?? (wf?.['天气'] as string) ?? (wf?.['weather'] as string) ?? ''
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

// ═══ 中段：单选展开心声 ═══
const expandedId = ref<string | null>(null)

/** tier 名 → CSS 变量描边色；tierName 未在品质池时降级默认色。 */
const TIER_COLOR: Record<string, string> = {
  普通: 'var(--theme-quality-common)',
  优良: 'var(--theme-quality-uncommon)',
  稀有: 'var(--theme-quality-rare)',
  史诗: 'var(--theme-quality-epic)',
  传说: 'var(--theme-quality-legendary)',
  神话: 'var(--theme-quality-mythic)',
}
function tierColor(tierName?: string): string {
  if (tierName && TIER_COLOR[tierName]) return TIER_COLOR[tierName]
  return 'var(--theme-text-muted)'
}

// 展开行的 DOM 引用，用于 scrollIntoView 跟随
const rowRefs = new Map<string, HTMLDivElement>()
function setRowRef(id: string, el: HTMLDivElement | null) {
  if (el) rowRefs.set(id, el)
  else rowRefs.delete(id)
}

function toggleExpand(char: CharacterState) {
  if (expandedId.value === char.id) {
    expandedId.value = null
    return
  }
  expandedId.value = char.id
  nextTick(() => {
    const el = rowRefs.get(char.id)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function thoughtsOf(char: CharacterState): string {
  return game.getThoughts(char)
}

// ═══ 下段：新闻单选展开 ═══
const expandedNewsId = ref<string | null>(null)

/**
 * M6 #36: 展开新闻时标记已读并持久化。
 * 先改内存 reactive（红点即时消失、其他面板即时可见），再传 JSON 克隆给 markNewsRead 落库
 * （Dexie 结构化克隆吃不下 Vue Proxy，同 QuestsPanel focusQuest 回写的做法）。
 */
async function toggleNews(id: string) {
  const opening = expandedNewsId.value !== id
  expandedNewsId.value = opening ? id : null
  if (!opening) return

  const profile = game.saveProfile
  if (!profile) return
  const item = profile.news?.find(n => n.id === id)
  if (!item || item.read) return // 只标未读项

  item.read = true
  try {
    await markNewsRead(JSON.parse(JSON.stringify(profile)), id)
  } catch (err) {
    console.error('[ScenePanel] 新闻已读标记持久化失败:', err)
  }
}

function openCharList() {
  game.showModal('characters')
}
</script>

<template>
  <div class="scene-panel" v-if="game.activeSaveId">
    <!-- ═══════ 上段：场景 (时间 + 位置 + 天气) ═══════ -->
    <div class="scene-top">
      <!-- 时间 -->
      <div class="scene-section scene-time">
        <div class="scene-section-title">时间</div>
        <template v-if="timeInfo">
          <div class="scene-tod-line" :style="{ '--tod-color': `var(${todMeta?.colorVar ?? '--theme-text-muted'})` }">
            <i :class="'scene-tod-icon ' + (todMeta?.icon ?? 'fa-solid fa-clock')" />
            <span class="scene-tod-name">{{ timeInfo.timeOfDay }}</span>
            <span class="scene-tod-clock">{{ timeInfo.time }}</span>
          </div>
          <div class="scene-time-era">{{ timeInfo.era }}</div>
          <div class="scene-time-date">{{ timeInfo.date }}</div>
        </template>
        <div class="scene-empty" v-else>时间未同步</div>
      </div>

      <!-- 位置 -->
      <div class="scene-section">
        <div class="scene-section-title">位置</div>
        <div class="scene-location">{{ locationDisplay }}</div>
      </div>

      <!-- 天气 -->
      <div class="scene-section" v-if="weather">
        <div class="scene-section-title">天气</div>
        <div class="scene-weather">{{ weather }}</div>
      </div>
    </div>

    <!-- ═══════ 中段：在场 NPC（可滚动，点击出心里话） ═══════ -->
    <div class="scene-mid">
      <div class="scene-section-title scene-mid-title">
        <span>在场 ({{ presentChars.length }})</span>
        <button class="scene-title-action" @click="openCharList" title="查看完整角色列表" aria-label="查看完整角色列表">›</button>
      </div>

      <div class="scene-npc-list" v-if="presentChars.length">
        <template v-for="char in presentChars" :key="char.id">
          <div
            :ref="(el) => setRowRef(char.id, el as HTMLDivElement)"
            class="scene-npc-item"
            :class="{ expanded: expandedId === char.id }"
            role="button"
            tabindex="0"
            :aria-expanded="expandedId === char.id"
            @click="toggleExpand(char)"
            @keydown.enter="toggleExpand(char)"
            @keydown.space.prevent="toggleExpand(char)"
          >
            <span class="npc-avatar" :style="{ background: nameColorVar(char.name) }">
              {{ initialsOf(char.name) }}
            </span>
            <span class="npc-name">{{ char.name }}</span>
            <span
              class="npc-tier"
              v-if="char.tier"
              :style="{ color: tierColor((char as any).tierName), borderColor: tierColor((char as any).tierName) }"
            >
              T{{ char.tier }}
            </span>
          </div>

          <!-- 心声气泡（v-if 不用 v-show，overflow 滚动容器内更稳） -->
          <div v-if="expandedId === char.id" class="npc-thought">
            <span class="npc-thought-quote">"</span>
            <span class="npc-thought-text">{{ thoughtsOf(char) || '此刻风平浪静，无声可闻…' }}</span>
            <span class="npc-thought-quote">"</span>
          </div>
        </template>
      </div>

      <div class="scene-empty-block" v-else>暂无其他角色在场</div>
    </div>

    <!-- ═══════ 下段：新闻 ═══════ -->
    <div class="scene-bot">
      <div class="scene-section-title">世界消息 · {{ timeInfo?.date || '' }} {{ timeInfo?.time || '' }}</div>

      <div class="scene-news-list" v-if="game.news.length">
        <div
          v-for="item in game.news"
          :key="item.id"
          class="news-item"
          :class="{ expanded: expandedNewsId === item.id, read: item.read }"
          role="button"
          tabindex="0"
          :aria-expanded="expandedNewsId === item.id"
          @click="toggleNews(item.id)"
          @keydown.enter="toggleNews(item.id)"
          @keydown.space.prevent="toggleNews(item.id)"
        >
          <span class="news-dot" v-if="!item.read" />
          <i class="news-icon fa-solid fa-newspaper" v-else />
          <div class="news-main">
            <div class="news-title-row">
              <span class="news-title">{{ item.title }}</span>
            </div>
            <div v-if="expandedNewsId === item.id" class="news-content">
              <span class="news-category" v-if="item.category">{{ item.category }}</span>
              {{ item.content }}
            </div>
          </div>
        </div>
      </div>

      <div class="scene-empty-block" v-else>暂无新消息</div>
    </div>
  </div>

  <!-- ═══ 未加载 ═══ -->
  <div class="scene-panel scene-panel-empty" v-else>
    <div class="scene-empty-msg">未选择存档</div>
  </div>
</template>

<style scoped>
/* ═══ 根容器 — 三段式 flex column，外层不滚 ═══ */
.scene-panel {
  width: 240px;
  flex-shrink: 0;
  overflow: hidden;                      /* 外层不滚， scrolls 委托给 mid/bot */
  background: var(--theme-content-bg);
  border-right: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}

.scene-panel-empty {
  height: 100%;
  align-items: center;
  justify-content: center;
}

/* ═══ 三段 ═══ */
.scene-top {
  flex-shrink: 0;
  padding: 12px 12px 6px;
  border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.04));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scene-mid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.04));
  display: flex;
  flex-direction: column;
}
.scene-bot {
  flex-shrink: 0;
  min-height: 30%;       /* 兜底：世界消息块至少占面板 1/3，不被中段挤窄贴底 */
  max-height: 40%;       /* 上限放宽：让多条新闻有展开空间 */
  overflow-y: auto;
  padding: 10px 12px;
}

/* ═══ 区块标题 ═══ */
.scene-section {
  padding-bottom: 4px;
}
.scene-section-title {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--theme-text-muted);
  margin-bottom: 5px;
  font-family: system-ui, sans-serif;
  display: flex;
  align-items: center;
}
.scene-mid-title {
  justify-content: space-between;
}
.scene-title-action {
  background: none;
  border: none;
  color: var(--theme-text-muted);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  font-family: inherit;
  transition: color 150ms;
}
.scene-title-action:hover {
  color: var(--theme-text-secondary);
}

/* ═══ 时间 ═══ */
.scene-time {
  padding-top: 2px;
}
.scene-tod-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 6px;
  color: var(--tod-color, var(--theme-text-secondary));
}
.scene-tod-icon {
  font-size: 0.85rem;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--tod-color, var(--theme-text-muted)) 55%, transparent));
}
.scene-tod-name {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-family: system-ui, sans-serif;
}
.scene-tod-clock {
  margin-left: auto;
  font-family: var(--theme-font-body, system-ui, sans-serif);
  font-variant-numeric: tabular-nums;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--theme-text-primary);
  opacity: 0.85;
}
.scene-time-era {
  font-family: var(--theme-font-title, serif);
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.25;
}
.scene-time-date {
  font-size: 0.7rem;
  color: var(--theme-text-secondary);
  margin-top: 1px;
}

/* ═══ 位置 / 天气 ═══ */
.scene-location {
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  line-height: 1.45;
  word-break: break-all;
  overflow-wrap: break-word;
}
.scene-weather {
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  font-style: italic;
}

/* ═══ 中段 NPC 行 ═══ */
.scene-npc-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.scene-npc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--theme-radius-md, 6px);
  cursor: pointer;
  transition: background 120ms;
  user-select: none;
}
.scene-npc-item:hover {
  background: var(--theme-tab-hover-bg);
}
.scene-npc-item.expanded {
  background: var(--theme-primary-bg);
}

.npc-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  color: #fff;
  font-size: 0.68rem;
  font-weight: 700;
  font-family: system-ui, sans-serif;
  letter-spacing: -0.02em;
  text-shadow: 0 1px 2px rgba(0,0,0,0.35);
  overflow: hidden;
  white-space: nowrap;
}
.npc-name {
  flex: 1;
  font-size: 0.78rem;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.npc-tier {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 5px;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid transparent;
  flex-shrink: 0;
}

/* ═══ 心声气泡 — 手稿引文样式 ═══ */
.npc-thought {
  margin: 2px 6px 8px 42px;
  padding: 8px 10px;
  border-radius: var(--theme-radius-md, 6px);
  background: color-mix(in srgb, var(--theme-primary) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 20%, var(--theme-card-border));
  font-size: 0.72rem;
  font-style: italic;
  color: var(--theme-text-secondary);
  line-height: 1.55;
  position: relative;
}
.npc-thought-quote {
  color: var(--theme-primary);
  opacity: 0.55;
  font-weight: 700;
  font-style: normal;
}
.npc-thought-text {
  margin: 0 2px;
}

/* ═══ 下段新闻 ═══ */
.scene-news-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.news-item {
  display: flex;
  gap: 8px;
  padding: 6px 7px;
  border-radius: var(--theme-radius-md, 6px);
  cursor: pointer;
  transition: background 120ms;
}
.news-item:hover {
  background: var(--theme-tab-hover-bg);
}
.news-item.expanded {
  background: var(--theme-primary-bg);
}

.news-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
  background: var(--theme-quality-mythic);
  box-shadow: 0 0 5px color-mix(in srgb, var(--theme-quality-mythic) 60%, transparent);
}
.news-icon {
  font-size: 0.72rem;
  margin-top: 3px;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.news-main {
  flex: 1;
  min-width: 0;
}
.news-title-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.news-title {
  flex: 1;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.news-item.read .news-title {
  color: var(--theme-text-secondary);
  font-weight: 500;
}
.news-time {
  flex-shrink: 0;
  font-size: 0.62rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.news-content {
  margin-top: 4px;
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
}
.news-category {
  display: inline-block;
  font-size: 0.6rem;
  color: var(--theme-primary);
  background: var(--theme-primary-bg);
  padding: 0 5px;
  border-radius: 2px;
  margin-right: 5px;
  font-style: normal;
}

/* ═══ 空态 ═══ */
.scene-empty {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.scene-empty-block {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
  font-style: italic;
  padding: 6px 2px;
  text-align: center;
}
.scene-empty-msg {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
</style>