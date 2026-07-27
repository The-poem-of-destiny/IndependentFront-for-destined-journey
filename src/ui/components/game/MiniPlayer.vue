<script setup lang="ts">
/**
 * MiniPlayer.vue — 游戏内迷你播放器 (Phase Audio §6.2)
 *
 * 刻意**不**走 AppModal: 调音量/切曲是唯一值得在「读正文时」做的操作，
 * Modal 会每次把叙事整片盖掉。代价是本组件自己负责关闭(外部点击 + Esc)与焦点。
 *
 * 位置轮询 (§6.3): 卡片打开才 start，关闭/卸载即 stop —— 没人看进度条时不跑定时器。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAudioStore } from '../../stores/audio-store'
import type { AudioRepeatMode } from '@engine/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const audio = useAudioStore()
const cardRef = ref<HTMLElement | null>(null)

// ── 派生状态 ────────────────────────────────────────────────
const music = computed(() => audio.state.music)
const isPlaying = computed(() => music.value.status === 'playing')
const currentTrack = computed(() =>
  music.value.trackId ? audio.findTrack(music.value.trackId) : undefined,
)
const trackTitle = computed(() => currentTrack.value?.name ?? '')
const durationSec = computed(() => music.value.durationSec || 0)
const progressRatio = computed(() => {
  if (durationSec.value <= 0) return 0
  return Math.min(1, Math.max(0, audio.positionSec / durationSec.value))
})
const musicPlaylists = computed(() => audio.playlists)

const repeatLabel = computed(() =>
  music.value.repeat === 'one' ? '单曲循环' : music.value.repeat === 'all' ? '列表循环' : '不循环',
)

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

// ── 传输 ────────────────────────────────────────────────────
function onToggle() { void audio.toggle() }
function onPrev() { void audio.prev() }
function onNext() { void audio.next() }

const REPEAT_CYCLE: AudioRepeatMode[] = ['off', 'all', 'one']
function onCycleRepeat() {
  const i = REPEAT_CYCLE.indexOf(music.value.repeat)
  audio.setRepeat(REPEAT_CYCLE[(i + 1) % REPEAT_CYCLE.length])
}
function onToggleShuffle() { audio.setShuffle(!music.value.shuffle) }

function onSelectPlaylist(e: Event) {
  const id = (e.target as HTMLSelectElement).value
  if (id) void audio.playPlaylist(id)
}

// ── 进度条 ──────────────────────────────────────────────────
function ratioFromPointer(e: MouseEvent, el: HTMLElement): number {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

function onSeekClick(e: MouseEvent) {
  if (durationSec.value <= 0) return
  audio.seek(ratioFromPointer(e, e.currentTarget as HTMLElement) * durationSec.value)
}

function onSeekKey(e: KeyboardEvent) {
  if (durationSec.value <= 0) return
  const step = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0
  if (!step) return
  e.preventDefault()
  audio.seek(Math.min(durationSec.value, Math.max(0, audio.positionSec + step)))
}

// ── 音量 (主音量) ───────────────────────────────────────────
function onVolumeClick(e: MouseEvent) {
  audio.setMasterVolume(ratioFromPointer(e, e.currentTarget as HTMLElement))
}

function onVolumeKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0
  if (!step) return
  e.preventDefault()
  audio.setMasterVolume(Math.min(1, Math.max(0, audio.state.masterVolume + step)))
}

function onToggleMute() { audio.setMasterMuted(!audio.state.masterMuted) }

// ── 关闭: Esc + 外部点击 (自持，非 AppModal 继承) ────────────
function close() { emit('close') }

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

function onDocPointerDown(e: Event) {
  const el = cardRef.value
  if (el && e.target instanceof Node && !el.contains(e.target)) close()
}

let listening = false
function bindDismiss() {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('keydown', onDocKeydown)
  document.addEventListener('pointerdown', onDocPointerDown)
}
function unbindDismiss() {
  if (!listening) return
  listening = false
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('pointerdown', onDocPointerDown)
}

// ── 位置轮询生命周期 (§6.3) ─────────────────────────────────
let polling = false
function startPolling() {
  if (polling) return
  polling = true
  audio.startPositionPolling()
}
function stopPolling() {
  if (!polling) return
  polling = false
  audio.stopPositionPolling()
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void audio.init()
      startPolling()
      bindDismiss()
    } else {
      stopPolling()
      unbindDismiss()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  stopPolling()
  unbindDismiss()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="mini-fade">
      <div
        v-if="open"
        ref="cardRef"
        class="mini-player"
        role="dialog"
        aria-label="音乐播放器"
      >
        <!-- 标题行 -->
        <div class="mp-head">
          <i class="fa-solid fa-music mp-note" aria-hidden="true" />
          <span v-if="trackTitle" class="mp-title" :title="trackTitle">{{ trackTitle }}</span>
          <span v-else class="mp-title mp-title-empty">尚未播放</span>
          <button class="mp-close" type="button" aria-label="关闭播放器" @click="close">✕</button>
        </div>

        <!-- 未解锁提示 (§7) -->
        <p v-if="!audio.state.unlocked" class="mp-hint">点击页面任意处即可开始播放音乐</p>

        <!-- 空态 -->
        <p v-else-if="audio.tracks.length === 0" class="mp-empty">曲库尚空…</p>

        <template v-else>
          <!-- 进度 -->
          <div class="mp-progress">
            <span class="mp-time">{{ fmtTime(audio.positionSec) }}</span>
            <div
              class="mp-track"
              role="slider"
              tabindex="0"
              aria-label="播放进度"
              :aria-valuemin="0"
              :aria-valuemax="Math.round(durationSec)"
              :aria-valuenow="Math.round(audio.positionSec)"
              @click="onSeekClick"
              @keydown="onSeekKey"
            >
              <div class="mp-fill" :style="{ transform: `scaleX(${progressRatio})` }" />
            </div>
            <span class="mp-time">{{ fmtTime(durationSec) }}</span>
          </div>

          <!-- 传输 -->
          <div class="mp-transport">
            <button class="mp-btn" type="button" aria-label="上一曲" @click="onPrev">
              <i class="fa-solid fa-backward-step" aria-hidden="true" />
            </button>
            <button
              class="mp-btn mp-btn-main"
              type="button"
              :aria-label="isPlaying ? '暂停' : '播放'"
              @click="onToggle"
            >
              <i :class="isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play'" aria-hidden="true" />
            </button>
            <button class="mp-btn" type="button" aria-label="下一曲" @click="onNext">
              <i class="fa-solid fa-forward-step" aria-hidden="true" />
            </button>
            <span class="mp-gap" />
            <button
              class="mp-btn mp-toggle"
              type="button"
              :class="{ active: music.repeat !== 'off' }"
              :aria-label="repeatLabel"
              :aria-pressed="music.repeat !== 'off'"
              :title="repeatLabel"
              @click="onCycleRepeat"
            >
              <i
                :class="music.repeat === 'one' ? 'fa-solid fa-repeat' : 'fa-solid fa-rotate-right'"
                aria-hidden="true"
              />
            </button>
            <button
              class="mp-btn mp-toggle"
              type="button"
              :class="{ active: music.shuffle }"
              aria-label="随机播放"
              :aria-pressed="music.shuffle"
              title="随机播放"
              @click="onToggleShuffle"
            >
              <i class="fa-solid fa-shuffle" aria-hidden="true" />
            </button>
          </div>

          <!-- 音量 -->
          <div class="mp-volume">
            <button
              class="mp-btn"
              type="button"
              :aria-label="audio.state.masterMuted ? '取消静音' : '静音'"
              :aria-pressed="audio.state.masterMuted"
              @click="onToggleMute"
            >
              <i
                :class="audio.state.masterMuted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high'"
                aria-hidden="true"
              />
            </button>
            <div
              class="mp-track"
              role="slider"
              tabindex="0"
              aria-label="主音量"
              :aria-valuemin="0"
              :aria-valuemax="100"
              :aria-valuenow="Math.round(audio.state.masterVolume * 100)"
              @click="onVolumeClick"
              @keydown="onVolumeKey"
            >
              <div
                class="mp-fill"
                :style="{ transform: `scaleX(${audio.state.masterMuted ? 0 : audio.state.masterVolume})` }"
              />
            </div>
          </div>

          <!-- 播放列表快切 -->
          <div class="mp-playlist">
            <label class="mp-plabel" for="mp-playlist-select">列表</label>
            <select
              id="mp-playlist-select"
              class="mp-select"
              aria-label="切换播放列表"
              :value="music.playlistId ?? ''"
              @change="onSelectPlaylist"
            >
              <option value="">— 未选择 —</option>
              <option v-for="p in musicPlaylists" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mini-player {
  position: fixed;
  left: 6.5rem;
  bottom: var(--theme-spacing-lg);
  z-index: var(--z-dropdown);
  width: 17rem;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-primary);
}

/* ── 标题 ── */
.mp-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.mp-note {
  font-size: 0.75rem;
  color: var(--theme-primary);
  flex-shrink: 0;
}
.mp-title {
  flex: 1;
  min-width: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-title-empty {
  color: var(--theme-text-muted);
  font-style: italic;
  font-weight: 400;
}
.mp-close {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--theme-radius-sm);
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast);
}
.mp-close:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

/* ── 提示 / 空态 ── */
.mp-hint {
  margin: 0;
  font-size: 0.75rem;
  font-style: italic;
  line-height: 1.5;
  color: var(--theme-text-secondary);
}
.mp-empty {
  margin: 0;
  padding: var(--theme-spacing-lg) 0;
  text-align: center;
  font-size: 0.8125rem;
  font-style: italic;
  color: var(--theme-text-muted);
}
.mp-empty::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}

/* ── 进度 / 音量 共用轨道 ── */
.mp-progress,
.mp-volume {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.mp-time {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.mp-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 6px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
  cursor: pointer;
}
.mp-track:focus-visible {
  outline: 1px solid var(--theme-primary);
  outline-offset: 2px;
}
.mp-fill {
  position: absolute;
  inset: 0;
  background: var(--theme-primary);
  border-radius: var(--theme-radius-full);
  transform-origin: left center;
  transition: transform var(--theme-transition-normal);
}

/* ── 传输按钮 ── */
.mp-transport {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
}
.mp-gap {
  flex: 1;
}
.mp-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: none;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--theme-radius-sm);
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.mp-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.mp-btn-main {
  color: var(--theme-primary);
  font-size: 0.9375rem;
}
.mp-toggle.active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
}

/* ── 播放列表 ── */
.mp-playlist {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.mp-plabel {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.mp-select {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}
.mp-select:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}

/* ── 出入场 ── */
.mini-fade-enter-active,
.mini-fade-leave-active {
  transition: opacity var(--theme-transition-fast), transform var(--theme-transition-fast);
}
.mini-fade-enter-from,
.mini-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .mp-fill,
  .mini-fade-enter-active,
  .mini-fade-leave-active {
    transition: none;
  }
}
</style>
