<script setup lang="ts">
/**
 * DialogueCard — 内置对话卡片规则（`builtin-dialogue-card`）的原生渲染
 *
 * 三个字段分别对应对话卡片 pattern 的捕获组：名字 / 情绪动作（可空）/ 台词。
 * 一律文本插值，不走 v-html —— 台词是模型原文，不许被当成标记解析。
 *
 * 🔴 类名 `.dialogue-card` / `.dialogue-name` / `.dialogue-mood` / `.dialogue-body` 是契约：
 *    `styles/integrated-game-surfaces.css` 与若干主题按全局类名覆盖底色与边框，别改名。
 */
import { computed } from 'vue';

const props = defineProps<{
  name: string;
  mood?: string;
  body: string;
}>();

/** 名字去掉两侧 Markdown 粗体残留的星号与空白 */
const displayName = computed(() => props.name.replace(/^[\s*]+|[\s*]+$/g, ''));

/** 情绪/动作：trim 后为空就不渲染 */
const displayMood = computed(() => props.mood?.trim() ?? '');
</script>

<template>
  <div class="dialogue-card">
    <div class="dialogue-header">
      <span class="dialogue-name">{{ displayName }}</span>
      <span v-if="displayMood" class="dialogue-mood">{{ displayMood }}</span>
    </div>
    <div class="dialogue-body">{{ body }}</div>
  </div>
</template>

<style scoped>
.dialogue-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: var(--theme-spacing-md) 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  border-radius: var(--theme-radius-md);
}

.dialogue-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
}

.dialogue-name {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-primary);
}

.dialogue-mood {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

.dialogue-body {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  line-height: 1.7;
  text-indent: 0;
  white-space: pre-line;
}
</style>
