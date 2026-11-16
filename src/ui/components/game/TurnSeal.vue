<script lang="ts">
import { shallowRef, type Ref } from 'vue';

/** 印记的三种形制 */
type SealShape = 'square' | 'wax' | 'star';

/**
 * 主题 → 印记形制的**唯一一张表**。
 * - 朱文方印：纸墨、漆器、圣物匣一路（parchment / indigo / sakura / crimson）
 * - 火漆圆封：金属、织锦、林野一路（bronze / ivory / forest）
 * - 星芒符印：夜空、深海、雾紫一路（obsidian / ocean / misty-lilac）
 * 表外的主题落到方印。
 */
const SEAL_SHAPE_BY_THEME: Readonly<Record<string, SealShape>> = Object.freeze({
  parchment: 'square',
  indigo: 'square',
  sakura: 'square',
  crimson: 'square',
  bronze: 'wax',
  ivory: 'wax',
  forest: 'wax',
  obsidian: 'star',
  ocean: 'star',
  'misty-lilac': 'star',
});

function sealShapeFor(theme: string | null | undefined): SealShape {
  return (theme && SEAL_SHAPE_BY_THEME[theme]) || 'square';
}

/*
 * 当前主题的共享镜像：所有印记共用一个 MutationObserver（按引用计数开关），
 * 不按印记各挂一个 —— 历史里可能有上百枚印记。
 */
const themeRef = shallowRef<string | null>(null);
let observer: MutationObserver | null = null;
let users = 0;

function readTheme(): string | null {
  return typeof document === 'undefined'
    ? null
    : document.documentElement.getAttribute('data-theme');
}

function acquireTheme(): Readonly<Ref<string | null>> {
  users++;
  themeRef.value = readTheme();
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      themeRef.value = readTheme();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
  return themeRef;
}

function releaseTheme(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && observer) {
    observer.disconnect();
    observer = null;
  }
}
</script>

<script setup lang="ts">
/**
 * TurnSeal — 一回合正文落定后的行末小印记（动效 v1 · 特效层）
 *
 * 行内结束符，不是绝对定位的浮层：跟在最后一段文字之后，静止、淡（约 0.5 不透明度）。
 * 只有「刚刚生成完的那一条」在 `pressed` 时盖一下印：1.08 → 1 落定，外加一圈极淡的
 * 洇墨环。宿主（ChatFlow）在特效闸门关闭时整个不渲染它。
 */
import { computed, onBeforeUnmount } from 'vue';

defineProps<{
  /** 刚完成的那一条：播放一次盖印动画 */
  pressed?: boolean;
}>();

const theme = acquireTheme();
onBeforeUnmount(releaseTheme);

const shape = computed(() => sealShapeFor(theme.value));
</script>

<template>
  <svg
    class="turn-seal"
    :class="[`turn-seal--${shape}`, { 'is-pressed': pressed }]"
    :data-shape="shape"
    viewBox="0 0 20 20"
    width="18"
    height="18"
    aria-hidden="true"
    focusable="false"
  >
    <circle v-if="pressed" class="turn-seal-ring" cx="10" cy="10" r="8.5" />
    <g class="turn-seal-body">
      <template v-if="shape === 'square'">
        <rect class="seal-fill" x="2.5" y="2.5" width="15" height="15" rx="1.6" />
        <rect class="seal-cut" x="5" y="5" width="10" height="10" rx="0.6" />
        <path class="seal-cut" d="M10 5.6v8.8M6.4 8.6h7.2M6.4 11.6h7.2" />
      </template>
      <template v-else-if="shape === 'wax'">
        <path
          class="seal-fill"
          d="M10 1.8c1.6 0 2.3 1.1 3.6 1.5 1.4.4 2.7-.1 3.4 1.2.7 1.2-.2 2.3 0 3.7.2 1.3 1.4 2.1.9 3.5-.5 1.4-1.9 1.5-2.8 2.5-.9 1-.9 2.5-2.3 3-1.3.5-2.2-.5-3.6-.5s-2.3 1-3.6.5c-1.4-.5-1.4-2-2.3-3-.9-1-2.3-1.1-2.8-2.5-.5-1.4.7-2.2.9-3.5.2-1.4-.7-2.5 0-3.7.7-1.3 2-.8 3.4-1.2C7.7 2.9 8.4 1.8 10 1.8z"
        />
        <circle class="seal-cut" cx="10" cy="10" r="4.6" />
      </template>
      <template v-else>
        <path
          class="seal-line"
          d="M10 1.8l1.7 5.1 5.1-1.7-3.4 4.8 3.4 4.8-5.1-1.7L10 18.2l-1.7-5.1-5.1 1.7 3.4-4.8-3.4-4.8 5.1 1.7z"
        />
        <circle class="seal-dot" cx="10" cy="10" r="1.4" />
      </template>
    </g>
  </svg>
</template>

<style scoped>
.turn-seal {
  display: inline-block;
  width: 1.1em;
  height: 1.1em;
  max-width: 20px;
  max-height: 20px;
  min-width: 16px;
  min-height: 16px;
  margin-inline-start: 0.45em;
  vertical-align: -0.18em;
  opacity: 0.5;
  overflow: visible;
  pointer-events: none;
  /* 朱砂：印泥本色，不随主题漂移；火漆与星芒取主题强调色 */
  --seal-vermilion: #b8432f;
}

/* 闸门之外绝不出现（宿主已 v-if，这里是第二道） */
:root:not([data-fx='on']) .turn-seal {
  display: none;
}

.seal-fill {
  fill: var(--seal-vermilion);
}
.turn-seal--wax .seal-fill {
  fill: color-mix(in srgb, var(--theme-primary) 80%, var(--seal-vermilion));
}
.seal-cut {
  fill: none;
  stroke: var(--theme-window-bg, #191512);
  stroke-width: 1;
  stroke-opacity: 0.75;
}
.seal-line {
  fill: none;
  stroke: var(--theme-primary);
  stroke-width: 1.1;
  stroke-linejoin: round;
}
.seal-dot {
  fill: var(--theme-primary);
}

.turn-seal-body,
.turn-seal-ring {
  transform-box: fill-box;
  transform-origin: center;
}
.turn-seal-ring {
  fill: none;
  stroke: var(--seal-vermilion);
  stroke-width: 0.8;
  opacity: 0;
}
.turn-seal--star .turn-seal-ring,
.turn-seal--wax .turn-seal-ring {
  stroke: var(--theme-primary);
}

/* 盖印：落下略大 → 落定；一圈洇墨环散开即逝。只在刚完成的那一条上 */
:root[data-fx='on'] .turn-seal.is-pressed .turn-seal-body {
  animation: seal-press var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}
:root[data-fx='on'] .turn-seal.is-pressed .turn-seal-ring {
  animation: seal-ink-spread var(--motion-duration-page) var(--motion-ease-exit) 80ms backwards;
}

@keyframes seal-press {
  from {
    opacity: 0;
    transform: scale(1.08);
  }
}

@keyframes seal-ink-spread {
  from {
    opacity: 0.45;
    transform: scale(0.7);
  }
  to {
    opacity: 0;
    transform: scale(1.35);
  }
}
</style>
