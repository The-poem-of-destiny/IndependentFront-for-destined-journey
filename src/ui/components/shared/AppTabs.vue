<script setup lang="ts" generic="T extends string">
defineProps<{
  tabs: { key: T; label: string; badge?: number }[]
  active: T
}>()

const emit = defineEmits<{
  select: [key: T]
}>()
</script>

<template>
  <div class="tab-bar">
    <div class="tab-list">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ 'tab-active': tab.key === active }"
        @click="emit('select', tab.key)"
      >
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="tab.badge !== undefined" class="tab-badge">{{ tab.badge }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  background: var(--theme-tab-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
}
.tab-list {
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
}
.tab-list::-webkit-scrollbar { display: none; }

.tab-item {
  position: relative;
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  color: var(--theme-tab-text);
  font-size: 0.85rem;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  white-space: nowrap;
}
.tab-item:hover {
  color: var(--theme-tab-active-text);
  background: var(--theme-tab-hover-bg);
}
.tab-item::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: transparent;
  transition: background var(--theme-transition-fast);
}
.tab-active {
  color: var(--theme-tab-active-text);
}
.tab-active::after {
  background: var(--theme-tab-indicator);
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: var(--theme-radius-full);
  background: var(--theme-error);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;
}
</style>
