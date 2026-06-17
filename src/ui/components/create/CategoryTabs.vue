<script setup lang="ts">
/**
 * CategoryTabs — 分类标签组件
 *
 * 支持两种模式:
 * - horizontal (默认): 等宽水平按钮 + 底部指示线
 * - vertical: 垂直堆叠按钮 + 左侧高亮线 + Badge 计数
 */

defineProps<{
  categories: { key: string; label: string; count?: number }[]
  modelValue: string
  variant?: 'horizontal' | 'vertical'
}>()

defineEmits<{ 'update:modelValue': [key: string] }>()
</script>

<template>
  <div class="category-tabs" :class="'tabs-' + (variant || 'horizontal')">
    <button
      v-for="cat in categories"
      :key="cat.key"
      class="tab-btn"
      :class="{ active: modelValue === cat.key }"
      @click="$emit('update:modelValue', cat.key)"
    >
      <span class="tab-label">{{ cat.label }}</span>
      <span v-if="cat.count !== undefined" class="tab-count">{{ cat.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* ===== 水平模式 (默认) ===== */
.tabs-horizontal {
  display: flex;
  gap: 2px;
  margin-bottom: var(--theme-spacing-sm);
}
.tabs-horizontal .tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--theme-spacing-xs) 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--theme-text-muted);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.tabs-horizontal .tab-btn:hover {
  color: var(--theme-text-primary);
}
.tabs-horizontal .tab-btn.active {
  color: var(--theme-color-primary);
  border-bottom-color: var(--theme-color-primary);
}

/* ===== 垂直模式 ===== */
.tabs-vertical {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tabs-vertical .tab-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 2.4em;
  padding: 0.5em 0.8em;
  border: none;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.9em;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  border-radius: 0 var(--theme-radius-sm) var(--theme-radius-sm) 0;
  transition: all var(--theme-transition-fast);
}
.tabs-vertical .tab-btn:hover {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
}
.tabs-vertical .tab-btn.active {
  background: var(--theme-card-bg);
  color: var(--theme-color-primary);
  border-left-color: var(--theme-color-primary);
}

/* Badge 计数 */
.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  transition: all var(--theme-transition-fast);
}
.tab-btn.active .tab-count {
  background: var(--theme-color-primary);
  color: #fff;
}

/* ===== 响应式: 垂直模式在手机端变水平 ===== */
@media (max-width: 768px) {
  .tabs-vertical {
    flex-direction: row;
    gap: 2px;
  }
  .tabs-vertical .tab-btn {
    flex: 1;
    justify-content: center;
    border-left: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
    font-size: 0.8rem;
  }
  .tabs-vertical .tab-btn.active {
    border-bottom-color: var(--theme-color-primary);
  }
}
</style>
