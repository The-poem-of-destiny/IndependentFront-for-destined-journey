<script setup lang="ts">
/**
 * CategorySelectionLayout — 左侧分类侧栏 + 右侧内容区
 *
 * 对齐原版 custom_start_index.html 的 CategorySelectionLayout 模式:
 * - 左侧垂直导航 (slot #sidebar)
 * - 右侧: 工具栏 (sticky) + 可滚动内容区 (slot #content)
 * - slot #toolbar: 过滤控件 (子类型/稀有度等)
 * - slot #extra: 内容区下方的额外操作 (如"自定义物品"按钮)
 * - 响应式: 768px 以下侧栏折叠为水平模式
 */

defineProps<{
  sidebarWidth?: string
  gap?: string
}>()
</script>

<template>
  <div class="cat-layout" :style="{ gap: gap || 'var(--theme-spacing-md)' }">
    <!-- 左侧分类导航 -->
    <aside class="cat-sidebar" :style="{ width: sidebarWidth || '140px' }">
      <slot name="sidebar" />
    </aside>

    <!-- 右侧内容区 -->
    <div class="cat-main">
      <!-- 工具栏 (sticky) -->
      <div v-if="$slots.toolbar" class="cat-toolbar">
        <slot name="toolbar" />
      </div>

      <!-- 内容区 (可滚动) -->
      <div class="cat-content">
        <slot name="content" />
      </div>

      <!-- 额外操作 (如"自定义物品"按钮) -->
      <div v-if="$slots.extra" class="cat-extra">
        <slot name="extra" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cat-layout {
  display: flex;
  align-items: flex-start;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ===== 左侧侧栏 ===== */
.cat-sidebar {
  flex-shrink: 0;
  position: sticky;
  top: 0;
}

/* ===== 右侧主区 ===== */
.cat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}

.cat-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4em;
  margin-bottom: var(--theme-spacing-sm);
  padding-bottom: var(--theme-spacing-sm);
  border-bottom: 1px solid var(--theme-card-border);
  position: sticky;
  top: 0;
  background: var(--theme-card-bg);
  z-index: 5;
}

.cat-content {
  flex: 1;
  min-height: 8em;
  max-height: 50vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.cat-extra {
  margin-top: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .cat-layout {
    flex-direction: column;
  }
  .cat-sidebar {
    width: 100% !important;
    position: static;
    margin-bottom: var(--theme-spacing-sm);
  }
  .cat-content { max-height: none; }
  .cat-toolbar {
    position: static;
  }
}
</style>
