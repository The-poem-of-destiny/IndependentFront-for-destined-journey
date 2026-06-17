<script setup lang="ts">
import AppButton from '../shared/AppButton.vue'

defineProps<{ outline: any; isGenerating: boolean; revealed: boolean }>()
defineEmits<{ reveal: []; regenerate: [] }>()
</script>

<template>
  <div class="outline-preview">
    <!-- 未生成 -->
    <div v-if="!outline && !isGenerating" class="outline-empty">
      ─ 尚未生成剧情大纲 ─
    </div>

    <!-- 生成中 -->
    <div v-if="isGenerating" class="outline-loading">
      <div class="shimmer" />
      <p>⏳ AI 正在生成剧情大纲，请耐心等待…</p>
    </div>

    <!-- 已生成, 模糊 -->
    <div v-if="outline && !revealed && !isGenerating" class="outline-blurred">
      <pre class="outline-text blurred">{{ JSON.stringify(outline, null, 2) }}</pre>
      <AppButton size="sm" @click="$emit('reveal')">点击查看大纲</AppButton>
    </div>

    <!-- 已揭示 -->
    <div v-if="outline && revealed" class="outline-visible">
      <pre class="outline-text">{{ JSON.stringify(outline, null, 2) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.outline-preview {
  border: 1px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-md);
  min-height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.outline-empty { color: var(--theme-text-muted); font-size: 0.8rem; }
.outline-loading { text-align: center; color: var(--theme-text-muted); font-size: 0.8rem; }
.shimmer {
  width: 100%; height: 40px;
  background: linear-gradient(90deg, var(--theme-card-border) 25%, var(--theme-card-bg) 50%, var(--theme-card-border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--theme-radius-sm);
  margin-bottom: var(--theme-spacing-sm);
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.outline-blurred { text-align: center; }
.outline-text.blurred { filter: blur(4px); user-select: none; }
.outline-text { font-size: 0.65rem; color: var(--theme-text-secondary); max-height: 200px; overflow-y: auto; text-align: left; }
</style>
