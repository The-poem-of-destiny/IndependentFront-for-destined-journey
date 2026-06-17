<script setup lang="ts">
defineProps<{
  src?: string
  name: string
  size?: 'sm' | 'md' | 'lg'
}>()

function initials(name: string): string {
  return name.slice(0, 2)
}
</script>

<template>
  <div class="avatar" :class="[`avatar-${size || 'md'}`]">
    <img v-if="src" :src="src" :alt="name" class="avatar-img" />
    <span v-else class="avatar-text">{{ initials(name) }}</span>
  </div>
</template>

<style scoped>
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-weight: 600;
  overflow: hidden;
  flex-shrink: 0;
}
.avatar-sm { width: 40px; height: 40px; font-size: 0.8rem; }
.avatar-md { width: 64px; height: 64px; font-size: 1.1rem; }
.avatar-lg { width: 96px; height: 96px; font-size: 1.5rem; }

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-text {
  line-height: 1;
}
</style>
