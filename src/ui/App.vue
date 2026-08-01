<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from 'vue';
import { useUIStore } from './stores/ui-store';
import { useThemeStore } from './stores/theme-store';
import { useAudioStore } from './stores/audio-store';
import { useAssetStore } from './stores/asset-store';
import { useSettingsStore } from './stores/settings-store';
import { useWorldBookStore } from './stores/worldbook-store';
import { useBeautifierStore } from './stores/beautifier-store';
import { queryForView } from './lib/view-audio';
import { applyReducedMotion } from './lib/reduced-motion';
import ToastContainer from './components/shared/ToastContainer.vue';

const theme = useThemeStore();
const ui = useUIStore();
const audio = useAudioStore();
const assets = useAssetStore();
const settings = useSettingsStore();
const worldbooks = useWorldBookStore();
const beautifier = useBeautifierStore();

// ═══ 世界书（Phase 0 / 设计 D4）═══════════════════════════
//
// 必须在**任何**世界书消费之前跑：init() 会把 localStorage 里的书搬进 Dexie
// 并删掉 localStorage 副本，之后 `settings.worldBooks` 就不存在了。
// 这里只负责尽早踢一脚；三个消费端（game-pipeline / create-store / SettingsPage）
// 各自也 `await init()` —— init() 幂等且并发共用同一个 Promise，
// 所以「谁先到谁等着」，不依赖本处的时序。
void worldbooks.init().catch(() => {
  /* 迁移例程内部永不抛；这里兜 hydrate/内置合并的意外，不该拦住应用启动 */
});

// ═══ 美化规则（Phase 0b）═════════════════════════════════
//
// 同理：init() 把用户规则搬进 Dexie 并删掉 localStorage 副本，同时丢弃
// `beautifierPresetRules` 那份 ~378 KB 的派生缓存，改为纯内存持有。
// 必须在游戏页首次美化正文之前跑完，否则规则列表是空的 → 正则不生效。
// init() 幂等，消费端（ChatFlow via useBeautify / BeautifierSection）各自也会 await。
void beautifier.init().catch(() => {
  /* 同上：不该拦住应用启动 */
});

// ═══ 减少动态效果（应用内开关）═══════════════════════════
//
// 把 `settings.reducedMotion` 同步到 `<html data-reduced-motion>`，CSS 据此关掉全站
// 动画（themes/variables.css）。`immediate` 是必须的：设置从 localStorage 水合回来
// 时不会触发变更回调，少了它，开着这个选项的用户重启后会先看到一轮完整动画。
//
// 系统的 `prefers-reduced-motion` 由 CSS 那条媒体查询独立负责，与本开关是或的关系
// —— 所以这里只写 true/false，不去读系统偏好。
watch(
  () => settings.settings.reducedMotion as boolean,
  (enabled) => applyReducedMotion(Boolean(enabled)),
  { immediate: true },
);

// ═══ 界面级场景配乐 ═══════════════════════════════════════
//
// 曲库在这里装（幂等）—— 首页也要出声，不能等进了游戏页才装库。
// GamePage 仍会再调一次 init()，那时直接空转。
void audio.init().catch(() => {
  /* 音频装不起来不该影响应用启动 */
});

// ═══ 素材库 ═══════════════════════════════════════════════
//
// 与曲库同一个理由、同一个位置: 素材要在**游戏页与捏人页**里渲染，而那两处
// 都不经过设置页。此前 init() 只在 settings/AssetSection.vue 的 onMounted 里
// 调，于是没进过设置页的会话里，库恒为空 —— 表现成「导入过的头像不显示」。
// init() 幂等（内部 `initialized` 闸），AssetSection 照旧再调一次即空转。
void assets.init().catch(() => {
  /* 素材库装不起来不该影响应用启动 */
});

watch(
  () => ui.currentView,
  (view) => {
    // 与地点配乐共用同一个开关 —— 一个开关关掉全部自动换歌，不设第二个
    if (settings.settings.audioSceneAutoPlay === false) return;
    const query = queryForView(view);
    if (!query) return; // 游戏页 / 设置页 / 工坊：不动音乐，理由见 view-audio.ts
    void audio.playByScene(query).catch(() => {
      /* 配乐是旁路，出错不影响导航 */
    });
  },
  { immediate: true },
);

// 懒加载所有页面（和原来 router 一样的异步加载）
const HomePage = defineAsyncComponent(() => import('./components/home/HomePage.vue'));
const CreatePage = defineAsyncComponent(() => import('./components/create/CreatePage.vue'));
const GamePage = defineAsyncComponent(() => import('./components/game/GamePage.vue'));
const SettingsPage = defineAsyncComponent(() => import('./components/settings/SettingsPage.vue'));
const WorkshopPage = defineAsyncComponent(() => import('./components/workshop/WorkshopPage.vue'));

const viewComponent = computed(() => {
  switch (ui.currentView) {
    case 'create':
      return CreatePage;
    case 'game':
      return GamePage;
    case 'settings':
      return SettingsPage;
    case 'workshop':
      return WorkshopPage;
    default:
      return HomePage;
  }
});
</script>

<template>
  <div class="app-shell">
    <transition name="fade" mode="out-in">
      <component :is="viewComponent" :key="ui.currentView" />
    </transition>
    <ToastContainer />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--theme-window-bg);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body);
  transition:
    background 0.3s ease,
    color 0.3s ease;
}
</style>
