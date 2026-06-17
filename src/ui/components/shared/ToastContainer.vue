<script setup lang="ts">
import { useUIStore } from '../../stores/ui-store'

const ui = useUIStore()
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <transition-group name="toast">
        <div
          v-for="t in ui.toasts"
          :key="t.id"
          class="toast-item"
          :class="[`toast-${t.type}`]"
          @click="ui.removeToast(t.id)"
        >
          {{ t.message }}
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(400px, 90vw);
}

.toast-item {
  padding: 10px 16px;
  border-radius: var(--theme-radius-md);
  font-size: 0.9rem;
  cursor: pointer;
  box-shadow: var(--theme-shadow-md);
  transition: all var(--theme-transition-fast);
}

.toast-info    { background: var(--theme-primary); color: var(--theme-primary-text); }
.toast-success { background: var(--theme-success); color: #fff; }
.toast-warning { background: var(--theme-warning); color: #1a1510; }
.toast-error   { background: var(--theme-error); color: #fff; }

.toast-enter-active { transition: all 0.3s ease; }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { opacity: 0; transform: translateX(50px); }
.toast-leave-to   { opacity: 0; transform: translateX(50px); }
</style>
