<script setup lang="ts">
defineProps<{
  src?: string
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** 'circle'（默认，原有调用方不受影响）| 'square' 立绘/画像框 */
  shape?: 'circle' | 'square'
}>()

function initials(name: string): string {
  return name.slice(0, 2)
}
</script>

<template>
  <div class="avatar" :class="[`avatar-${size || 'md'}`, `avatar-shape-${shape || 'circle'}`]">
    <img v-if="src" :src="src" :alt="name" class="avatar-img" />
    <span v-else class="avatar-text">{{ initials(name) }}</span>
  </div>
</template>

<style scoped>
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-weight: 600;
  overflow: hidden;
  flex-shrink: 0;
}
.avatar-shape-circle { border-radius: 50%; }
/* 画像框 —— 走 design.md §4.2 的统一卡片外壳（叠纸阴影 + 1px 边框） */
.avatar-shape-square {
  border-radius: var(--theme-radius-md, 6px);
  border: 1px solid var(--theme-card-border);
  box-shadow: var(--paper-stack);
}
.avatar-sm { width: 40px; height: 40px; font-size: 0.8rem; }
.avatar-md { width: 64px; height: 64px; font-size: 1.1rem; }
.avatar-lg { width: 96px; height: 96px; font-size: 1.5rem; }
/* xl 为方形画像框设计：宽度跟随容器，高度由 aspect-ratio 保方 */
.avatar-xl {
  width: 100%;
  max-width: 11.25rem;
  aspect-ratio: 1;
  font-size: 2.25rem;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-text {
  line-height: 1;
}
</style>
