<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useThemeStore } from '../../stores/theme-store';
import { isReducedMotion } from '../../lib/reduced-motion';
import type { AstralDriftScene } from './drift/runtime';

const emit = defineEmits<{
  ready: [ready: boolean];
}>();

const settings = useSettingsStore();
const theme = useThemeStore();
const stage = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const isLightTheme = computed(() => theme.currentTheme?.type === 'light');

let scene: AstralDriftScene | null = null;
let cancelled = false;
let idleHandle: number | null = null;
let mediaQuery: MediaQueryList | null = null;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function publishReady(value: boolean) {
  ready.value = value;
  emit('ready', value);
}

function supportsWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    const context = probe.getContext('webgl2');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function cancelIdleLoad() {
  if (idleHandle === null) return;
  const browser = window as IdleWindow;
  if (browser.cancelIdleCallback) browser.cancelIdleCallback(idleHandle);
  else window.clearTimeout(idleHandle);
  idleHandle = null;
}

function disposeScene() {
  cancelIdleLoad();
  scene?.dispose();
  scene = null;
  publishReady(false);
}

function shouldRender(): boolean {
  return settings.settings.homeBackdrop && !isReducedMotion();
}

async function createScene() {
  idleHandle = null;
  if (cancelled || scene || !shouldRender() || !stage.value || !canvas.value) return;

  try {
    const runtime = await import('./drift/runtime');
    if (cancelled || !shouldRender() || !stage.value || !canvas.value) return;
    scene = runtime.createAstralDriftScene(canvas.value, stage.value, {
      themeId: theme.current,
    });
    publishReady(true);
  } catch (error) {
    console.warn('[home] Astral Drift 背景初始化失败，已退回静态首页。', error);
    disposeScene();
  }
}

function scheduleScene() {
  if (scene || idleHandle !== null || !shouldRender() || !supportsWebGL2()) return;
  const browser = window as IdleWindow;
  idleHandle = browser.requestIdleCallback
    ? browser.requestIdleCallback(() => void createScene(), { timeout: 1_200 })
    : window.setTimeout(() => void createScene(), 0);
}

function syncSceneAvailability() {
  if (!shouldRender()) {
    disposeScene();
    return;
  }
  scheduleScene();
}

function onVisibilityChange() {
  if (document.hidden) scene?.pause();
  else scene?.resume();
}

function onContextLost(event: Event) {
  event.preventDefault();
  console.warn('[home] WebGL context lost，已退回静态首页。');
  disposeScene();
}

watch(
  () => theme.current,
  async (themeId) => {
    await nextTick();
    scene?.applyTheme(themeId);
  },
  { flush: 'post' },
);

watch(
  () => [settings.settings.homeBackdrop, settings.settings.reducedMotion],
  syncSceneAvailability,
);

onMounted(() => {
  cancelled = false;
  document.addEventListener('visibilitychange', onVisibilityChange);
  canvas.value?.addEventListener('webglcontextlost', onContextLost);
  mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  mediaQuery.addEventListener('change', syncSceneAvailability);
  scheduleScene();
});

onUnmounted(() => {
  cancelled = true;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  canvas.value?.removeEventListener('webglcontextlost', onContextLost);
  mediaQuery?.removeEventListener('change', syncSceneAvailability);
  disposeScene();
});
</script>

<template>
  <div ref="stage" class="astral-drift" :class="{ 'is-ready': ready, 'is-light': isLightTheme }">
    <canvas ref="canvas" class="astral-drift-canvas" aria-hidden="true"></canvas>
    <div class="astral-vignette" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.astral-drift {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  touch-action: none;
}

.astral-drift-canvas {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.4s ease;
}

.astral-drift.is-ready .astral-drift-canvas {
  opacity: 1;
}

.astral-vignette {
  position: absolute;
  inset: 0;
  opacity: 0;
  background:
    linear-gradient(
      to bottom,
      color-mix(in srgb, var(--theme-window-bg) 66%, transparent) 0%,
      color-mix(in srgb, var(--theme-window-bg) 22%, transparent) 22%,
      transparent 42%
    ),
    radial-gradient(
      ellipse 78% 74% at 50% 46%,
      transparent 42%,
      color-mix(in srgb, var(--theme-window-bg) 40%, transparent) 76%,
      color-mix(in srgb, var(--theme-window-bg) 90%, transparent) 100%
    );
  transition: opacity 0.4s ease;
}

.astral-drift.is-ready:not(.is-light) .astral-vignette {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .astral-drift-canvas,
  .astral-vignette {
    transition: none;
  }
}

:global(html[data-reduced-motion='true']) .astral-drift-canvas,
:global(html[data-reduced-motion='true']) .astral-vignette {
  transition: none;
}
</style>
