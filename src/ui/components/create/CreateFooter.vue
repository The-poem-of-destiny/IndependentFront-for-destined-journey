<script setup lang="ts">
import AppButton from '../shared/AppButton.vue'

defineProps<{
  canPrev?: boolean
  canNext?: boolean
  nextLabel?: string
}>()

defineEmits<{
  prev: []
  next: []
  openPreset: []
}>()
</script>

<template>
  <footer class="create-footer">
    <AppButton variant="ghost" size="sm" @click="$emit('openPreset')">
      角色预设
    </AppButton>

    <div class="footer-nav">
      <AppButton
        variant="secondary"
        size="md"
        :disabled="canPrev === false"
        @click="$emit('prev')"
      >
        ← 上一步
      </AppButton>
      <AppButton
        variant="primary"
        size="md"
        :disabled="canNext === false"
        @click="$emit('next')"
      >
        {{ nextLabel || '下一步 →' }}
      </AppButton>
    </div>
  </footer>
</template>

<style scoped>
.create-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  padding-bottom: max(var(--theme-spacing-md), env(safe-area-inset-bottom, 12px));
  background: var(--theme-card-bg);
  border-top: 1px solid var(--theme-card-border);
}
.footer-nav {
  display: flex;
  gap: var(--theme-spacing-sm);
}
</style>
