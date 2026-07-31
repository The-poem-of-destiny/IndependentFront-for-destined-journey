<script setup lang="ts">
/**
 * ① 混音台 —— 主/音乐/音效 三条音量条 + 静音 + 传输控制 + 进度条
 *
 * 边界: 只调 audio-store 的公开动作，不碰 AudioContext / Dexie。
 * 进度轮询的起停由外层 AudioSection 负责（分区级生命周期），本组件只管
 * 显示值与 seek 的交互语义。
 */
import { ref, computed, onUnmounted } from 'vue';
import { useAudioStore } from '../../../stores/audio-store';
import { useSettingsStore } from '../../../stores/settings-store';
import type { AudioTrack, AudioRepeatMode } from '@engine/types';
import { fmtDuration } from './format';

const audio = useAudioStore();
const settings = useSettingsStore();

/** 场景自动配乐开关（写进 settings-store，deep watch 自动持久化） */
const sceneAutoPlay = computed({
  get: () => settings.settings.audioSceneAutoPlay !== false,
  set: (v: boolean) => {
    settings.settings.audioSceneAutoPlay = v;
  },
});

// ===== 通道 =====

type ChannelKey = 'master' | 'music' | 'sfx';

const channels = computed(() => [
  {
    key: 'master' as ChannelKey,
    label: '主音量',
    volume: audio.state.masterVolume,
    muted: audio.state.masterMuted,
  },
  {
    key: 'music' as ChannelKey,
    label: '音乐',
    volume: audio.state.music.volume,
    muted: audio.state.music.muted,
  },
  {
    key: 'sfx' as ChannelKey,
    label: '音效',
    volume: audio.state.sfx.volume,
    muted: audio.state.sfx.muted,
  },
]);

function setVolume(key: ChannelKey, raw: string | number): void {
  const v = Math.min(1, Math.max(0, Number(raw) / 100));
  if (key === 'master') audio.setMasterVolume(v);
  else audio.setChannelVolume(key, v);
}

function toggleMute(key: ChannelKey, current: boolean): void {
  if (key === 'master') audio.setMasterMuted(!current);
  else audio.setChannelMuted(key, !current);
}

// ===== 传输 =====

const currentTrack = computed<AudioTrack | undefined>(() => {
  const id = audio.state.music.trackId;
  return id ? audio.findTrack(id) : undefined;
});

const durationSec = computed(
  () => audio.state.music.durationSec || currentTrack.value?.duration || 0,
);

// ── 进度滑块：提交式 seek ────────────────────────────────
// store 以 ~4Hz 轮询回写 positionSec。若滑块直接绑定它，拖动时轮询会把把手
// 从手里抢回去（每 250ms 跳一次）。所以拖动期间显示值走本地草稿，只有 change
// （松手 / 方向键 / Home-End）才真的 seek。音量滑块不受影响 —— 那里需要
// input 的连续反馈。
//
// 冻结范围刻意收得很窄：**只在真的有交互时**冻结。单纯把焦点停在进度条上
// 不冻结任何东西 —— 否则用户 Tab 过来听歌，进度条和时钟就一起僵住，界面
// 等于在撒谎。提交后再压一个极短的安定窗口，挡掉那一两拍还在路上的陈旧
// 轮询值，随后无论焦点在哪都放开跟随真实播放位置。

/** 提交后的安定窗口(ms)：够盖住 1-2 拍 250ms 轮询，短到用户察觉不到 */
const SEEK_SETTLE_MS = 500;

const seekDragging = ref(false);
const seekSettling = ref(false);
const seekDraft = ref(0);

let seekSettleTimer: ReturnType<typeof setTimeout> | null = null;

function clearSeekSettle(): void {
  if (seekSettleTimer !== null) {
    clearTimeout(seekSettleTimer);
    seekSettleTimer = null;
  }
  seekSettling.value = false;
}

/** 用户正在操纵进度条（或刚松手） → 冻结轮询对显示值的写入 */
const seekHeld = computed(() => seekDragging.value || seekSettling.value);

/** 进度条把手与时间文字共用的显示值，保证两者永远一致 */
const displayPositionSec = computed(() => (seekHeld.value ? seekDraft.value : audio.positionSec));

/** 拖动过程中只更新草稿，不真的 seek */
function onSeekInput(raw: string | number): void {
  clearSeekSettle(); // 新交互作废上一次的安定窗口
  seekDragging.value = true;
  seekDraft.value = Number(raw);
}

/** 提交才 seek —— 松手、方向键、Home/End 都会触发 change */
function onSeekCommit(raw: string | number): void {
  const sec = Number(raw);
  clearSeekSettle();
  seekDraft.value = sec;
  seekDragging.value = false;
  audio.seek(sec);
  seekSettling.value = true;
  seekSettleTimer = setTimeout(() => {
    seekSettleTimer = null;
    seekSettling.value = false;
  }, SEEK_SETTLE_MS);
}

/** 松手时值没变则不会有 change —— 兜住这条路径，别把冻结态留在原地 */
function onSeekPointerUp(): void {
  if (!seekDragging.value) return;
  seekDragging.value = false;
  clearSeekSettle();
}

/** 0..1 —— 进度条用 scaleX，绝不过渡 width（design.md §1 禁令） */
const progressRatio = computed(() => {
  const d = durationSec.value;
  if (d <= 0) return 0;
  return Math.min(1, Math.max(0, displayPositionSec.value / d));
});

const isPlaying = computed(() => audio.state.music.status === 'playing');

const repeatLabel = computed(() => {
  const map: Record<AudioRepeatMode, string> = { off: '不循环', all: '列表循环', one: '单曲循环' };
  return map[audio.state.music.repeat] ?? '列表循环';
});

function cycleRepeat(): void {
  const order: AudioRepeatMode[] = ['off', 'all', 'one'];
  const i = order.indexOf(audio.state.music.repeat);
  audio.setRepeat(order[(i + 1) % order.length]);
}

onUnmounted(() => {
  clearSeekSettle(); // 别让安定计时器烧到已拆掉的组件上
});
</script>

<template>
  <h4 class="band-title">混音台</h4>

  <div v-for="ch in channels" :key="ch.key" class="mix-row">
    <span class="mix-label">{{ ch.label }}</span>
    <button
      class="icon-btn"
      :class="{ 'icon-btn-off': ch.muted }"
      :aria-label="ch.muted ? `取消静音：${ch.label}` : `静音：${ch.label}`"
      :aria-pressed="ch.muted"
      @click="toggleMute(ch.key, ch.muted)"
    >
      <i
        class="fa-solid"
        :class="ch.muted ? 'fa-volume-xmark' : 'fa-volume-high'"
        aria-hidden="true"
      />
    </button>
    <div class="slider" :class="{ 'slider-off': ch.muted }">
      <div class="slider-track">
        <div class="slider-fill" :style="{ transform: `scaleX(${ch.volume})` }" />
      </div>
      <input
        class="slider-input"
        type="range"
        min="0"
        max="100"
        step="1"
        :value="Math.round(ch.volume * 100)"
        :aria-label="`${ch.label}音量`"
        :aria-valuetext="`${Math.round(ch.volume * 100)}%`"
        @input="setVolume(ch.key, ($event.target as HTMLInputElement).value)"
      />
    </div>
    <span class="mix-value">{{ Math.round(ch.volume * 100) }}</span>
  </div>

  <!-- 传输 -->
  <div class="transport">
    <div class="transport-title">
      {{ currentTrack ? currentTrack.name : '未在播放' }}
    </div>
    <div class="slider progress">
      <div class="slider-track">
        <div class="slider-fill" :style="{ transform: `scaleX(${progressRatio})` }" />
      </div>
      <input
        class="slider-input"
        type="range"
        min="0"
        :max="Math.max(1, Math.floor(durationSec))"
        step="1"
        :value="Math.floor(displayPositionSec)"
        :disabled="durationSec <= 0"
        aria-label="播放进度"
        :aria-valuetext="`${fmtDuration(displayPositionSec)} / ${fmtDuration(durationSec)}`"
        @input="onSeekInput(($event.target as HTMLInputElement).value)"
        @change="onSeekCommit(($event.target as HTMLInputElement).value)"
        @pointerup="onSeekPointerUp"
        @pointercancel="onSeekPointerUp"
      />
    </div>
    <div class="transport-row">
      <span class="time-text"
        >{{ fmtDuration(displayPositionSec) }} / {{ fmtDuration(durationSec) }}</span
      >
      <div class="transport-btns">
        <button class="icon-btn" aria-label="上一曲" @click="audio.prev()">
          <i class="fa-solid fa-backward-step" aria-hidden="true" />
        </button>
        <button class="icon-btn" :aria-label="isPlaying ? '暂停' : '播放'" @click="audio.toggle()">
          <i class="fa-solid" :class="isPlaying ? 'fa-pause' : 'fa-play'" aria-hidden="true" />
        </button>
        <button class="icon-btn" aria-label="下一曲" @click="audio.next()">
          <i class="fa-solid fa-forward-step" aria-hidden="true" />
        </button>
        <button
          class="chip-btn"
          :class="{ 'chip-on': audio.state.music.repeat !== 'off' }"
          :aria-label="`循环模式：${repeatLabel}`"
          @click="cycleRepeat()"
        >
          <i class="fa-solid fa-repeat" aria-hidden="true" /> {{ repeatLabel }}
        </button>
        <button
          class="chip-btn"
          :class="{ 'chip-on': audio.state.music.shuffle }"
          :aria-pressed="audio.state.music.shuffle"
          aria-label="随机播放"
          @click="audio.setShuffle(!audio.state.music.shuffle)"
        >
          <i class="fa-solid fa-shuffle" aria-hidden="true" /> 随机
        </button>
        <button
          class="chip-btn"
          :class="{ 'chip-on': sceneAutoPlay }"
          :aria-pressed="sceneAutoPlay"
          aria-label="进入新地点时自动换背景音乐"
          title="进入新地点时，按地点/人物/情绪/情境自动挑一首 BGM"
          @click="sceneAutoPlay = !sceneAutoPlay"
        >
          <i class="fa-solid fa-location-dot" aria-hidden="true" /> 场景配乐
        </button>
      </div>
    </div>
    <p class="hint-text">
      {{
        sceneAutoPlay
          ? '进入新地点时会自动换背景音乐；曲库里没有合适的曲子时保持当前播放，不会突然静音。'
          : '已关闭：地点变化不再自动换歌，音乐完全由你手动控制。'
      }}
    </p>
    <p v-if="!audio.state.unlocked" class="hint-text">浏览器需要一次点击才能开始播放。</p>
  </div>
</template>

<style scoped>
/* ═══ 分段标题 + 装饰线 ═══ */
.band-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-md);
}
.band-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

/* ═══ 混音台 ═══ */
.mix-row {
  display: grid;
  grid-template-columns: 4rem 36px minmax(0, 1fr) 2.2rem;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) 0;
}
.mix-label {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.mix-value {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ═══ 滑块（手搓轨/填充，对齐 ResourceBar；交互层是原生 range） ═══
 * 视觉轨保持 6px 的纤细感，但交互层撑到 36px 命中区（design.md §8 触摸目标）。
 * range 自身只保留把手可见 —— 轨道与进度都交给下面的 .slider-track/.slider-fill。 */
.slider {
  position: relative;
  height: 36px;
  display: flex;
  align-items: center;
}
.slider-track {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(50% - 3px);
  height: 6px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
}
.slider-fill {
  height: 100%;
  width: 100%;
  background: var(--theme-primary);
  border-radius: var(--theme-radius-full);
  transform-origin: left center;
  transition: transform var(--theme-transition-fast);
}
.slider-input {
  position: relative;
  width: 100%;
  height: 36px;
  margin: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.slider-input:disabled {
  cursor: default;
}

/* 原生轨道让位给手搓轨；把手是 range 唯一可见的部分 */
.slider-input::-webkit-slider-runnable-track {
  height: 36px;
  background: transparent;
  border: none;
}
.slider-input::-moz-range-track {
  height: 36px;
  background: transparent;
  border: none;
}
.slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  /* webkit 把手相对 runnable-track 顶部定位，手动居中：(36 - 16) / 2 */
  margin-top: 10px;
  border-radius: 50%;
  background: var(--theme-primary);
  border: 2px solid var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  cursor: pointer;
}
.slider-input::-moz-range-thumb {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-primary);
  border: 2px solid var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  cursor: pointer;
}
/* 三条各写各的 —— 选择器列表里混入厂商伪元素会让整条规则被另一引擎整体丢弃 */
.slider-off .slider-fill {
  background: var(--theme-text-muted);
}
.slider-off .slider-input::-webkit-slider-thumb {
  background: var(--theme-text-muted);
}
.slider-off .slider-input::-moz-range-thumb {
  background: var(--theme-text-muted);
}
/* 没有时长时进度条无意义 —— 把手收起来，不给假的可拖动暗示 */
.slider-input:disabled::-webkit-slider-thumb {
  opacity: 0;
}
.slider-input:disabled::-moz-range-thumb {
  opacity: 0;
}

/* 悬停：轨道一圈中性描边（轻） */
.slider:hover .slider-track {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-text-muted) 45%, transparent);
}
/*
 * 键盘焦点：轨道加粗成主色环 + 把手外扩光晕，与 hover / 鼠标按下明显区分。
 * 旧写法 `.slider-input:focus-visible + .slider-track` 永远不可能命中 ——
 * `.slider-track` 是 range 的**前**一个兄弟，`+` 只能往后选；退守的
 * `:focus-within` 又会在鼠标按下时误触发。改用外层 `:has()` 一次解决。
 */
.slider:has(.slider-input:focus-visible) .slider-track {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.slider-input:focus {
  outline: none;
}
.slider-input:focus-visible::-webkit-slider-thumb {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.slider-input:focus-visible::-moz-range-thumb {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 传输 ═══ */
.transport {
  margin-top: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.transport-title {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  color: var(--theme-text-primary);
  margin-bottom: var(--theme-spacing-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transport-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-xs);
  flex-wrap: wrap;
}
.transport-btns {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-wrap: wrap;
}
.time-text {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.hint-text {
  margin: var(--theme-spacing-sm) 0 0;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ═══ 按钮 ═══ */
/* 统一的键盘焦点环 —— 这片区域按钮最密，没有焦点提示等于让人闭眼穿行 */
.icon-btn:focus-visible,
.chip-btn:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.icon-btn {
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
/* 图标字体的视觉重量与 emoji 不同，单独给一档字号找回平衡（按钮尺寸不变） */
.icon-btn i {
  font-size: 0.875rem;
  line-height: 1;
}
.icon-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.icon-btn-off {
  color: var(--theme-text-muted);
}
.chip-btn {
  height: 36px;
  padding: 0 var(--theme-spacing-md);
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.chip-btn i {
  font-size: 0.8125rem;
  line-height: 1;
}
.chip-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.chip-on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
}
</style>
