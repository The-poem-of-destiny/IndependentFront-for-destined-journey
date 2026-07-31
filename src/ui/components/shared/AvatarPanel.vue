<script setup lang="ts">
defineProps<{
  src?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 'circle'（默认，原有调用方不受影响）| 'square' 立绘/画像框 */
  shape?: 'circle' | 'square';
  /**
   * `src` 指向的是 mp4 吗（D7 允许 `头像` / `立绘bg` 用视频）。
   *
   * 省略即 `false`，走原来的 `<img>` —— **现有调用方一个都不受影响**。
   * 由调用方从**素材行**判定（`useAssetImage` 的 `isVideo`），不要在这里嗅 URL:
   * object URL 里没有扩展名。
   */
  video?: boolean;
}>();

function initials(name: string): string {
  return name.slice(0, 2);
}
</script>

<template>
  <div class="avatar" :class="[`avatar-${size || 'md'}`, `avatar-shape-${shape || 'circle'}`]">
    <!-- 视频与图片共用 .avatar-img（100% + object-fit: cover），不另开一套样式 -->
    <video
      v-if="src && video"
      :src="src"
      :aria-label="name"
      class="avatar-img"
      muted
      playsinline
      loop
      autoplay
    />
    <img v-else-if="src" :src="src" :alt="name" class="avatar-img" />
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
.avatar-shape-circle {
  border-radius: 50%;
}
/* 画像框 —— 走 design.md §4.2 的统一卡片外壳（叠纸阴影 + 1px 边框） */
.avatar-shape-square {
  border-radius: var(--theme-radius-md, 6px);
  border: 1px solid var(--theme-card-border);
  box-shadow: var(--paper-stack);
}
.avatar-sm {
  width: 40px;
  height: 40px;
  font-size: 0.8rem;
}
.avatar-md {
  width: 64px;
  height: 64px;
  font-size: 1.1rem;
}
.avatar-lg {
  width: 96px;
  height: 96px;
  font-size: 1.5rem;
}
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
