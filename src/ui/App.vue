<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from 'vue'
import { useUIStore } from './stores/ui-store'
import { useThemeStore } from './stores/theme-store'
import { useAudioStore } from './stores/audio-store'
import { useSettingsStore } from './stores/settings-store'
import { queryForView } from './lib/view-audio'
import ToastContainer from './components/shared/ToastContainer.vue'

const theme = useThemeStore()
const ui = useUIStore()
const audio = useAudioStore()
const settings = useSettingsStore()

// ═══ 界面级场景配乐 ═══════════════════════════════════════
//
// 曲库在这里装（幂等）—— 首页也要出声，不能等进了游戏页才装库。
// GamePage 仍会再调一次 init()，那时直接空转。
void audio.init().catch(() => { /* 音频装不起来不该影响应用启动 */ })

watch(
  () => ui.currentView,
  (view) => {
    // 与地点配乐共用同一个开关 —— 一个开关关掉全部自动换歌，不设第二个
    if (settings.settings.audioSceneAutoPlay === false) return
    const query = queryForView(view)
    if (!query) return // 游戏页 / 设置页 / 工坊：不动音乐，理由见 view-audio.ts
    void audio.playByScene(query).catch(() => { /* 配乐是旁路，出错不影响导航 */ })
  },
  { immediate: true },
)

// 懒加载所有页面（和原来 router 一样的异步加载）
const HomePage = defineAsyncComponent(() => import('./components/home/HomePage.vue'))
const CreatePage = defineAsyncComponent(() => import('./components/create/CreatePage.vue'))
const GamePage = defineAsyncComponent(() => import('./components/game/GamePage.vue'))
const SettingsPage = defineAsyncComponent(() => import('./components/settings/SettingsPage.vue'))
const WorkshopPage = defineAsyncComponent(() => import('./components/workshop/WorkshopPage.vue'))

const viewComponent = computed(() => {
  switch (ui.currentView) {
    case 'create':   return CreatePage
    case 'game':     return GamePage
    case 'settings': return SettingsPage
    case 'workshop': return WorkshopPage
    default:         return HomePage
  }
})
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
  transition: background 0.3s ease, color 0.3s ease;
}
</style>
