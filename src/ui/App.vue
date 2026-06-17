<script setup lang="ts">
import { useThemeStore } from './stores/theme-store'
import ToastContainer from './components/shared/ToastContainer.vue'

const theme = useThemeStore()
</script>

<template>
  <div class="app-shell">
    <router-view v-slot="{ Component, route }">
      <transition :name="(route.meta.transition as string) || 'fade'" mode="out-in">
        <component :is="Component" :key="route.path" />
      </transition>
    </router-view>
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
