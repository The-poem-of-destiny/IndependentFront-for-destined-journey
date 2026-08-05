<script setup lang="ts" generic="T">
import { ref } from 'vue';

const props = defineProps<{
  modelValue: T;
  items: { key: string; value: T }[];
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: T];
}>();

const open = ref(false);
// 🔴 **写了没人读** —— `search` 下面被清空两次（select / toggle），但模板里没有任何输入框绑定它，
//    下拉列表直接 `v-for="item in items"`：**搜索框从来就没做出来**，这是它仅存的痕迹。
//    2026-08-05 收紧 lint 删掉 `const filtered = ref(props.items)` 时才暴露 —— 那个 computed 是
//    最后一个读者，而它自己也是死的（模板没用）。ESLint 逮不到（`search` 确实被"引用"了，
//    只是全是写），typecheck 也逮不到。留着注释而不是一并删掉，是为了不让这个缺口再次隐形：
//    要么把搜索框补上，要么连 `search` 一起清掉 —— 两者都是功能改动，不塞进 lint 清理。
const search = ref('');

function select(item: { key: string; value: T }) {
  emit('update:modelValue', item.value);
  open.value = false;
  search.value = '';
}

function toggle() {
  if (!props.disabled) {
    open.value = !open.value;
    if (open.value) search.value = '';
  }
}

function onBlur() {
  setTimeout(() => {
    open.value = false;
  }, 150);
}
</script>

<template>
  <div class="cascader" tabindex="-1" @blur="onBlur">
    <button class="cascader-trigger" :disabled="disabled" @click="toggle">
      <span v-if="modelValue" class="cascader-value">{{ modelValue }}</span>
      <span v-else class="cascader-placeholder">{{ placeholder || '请选择' }}</span>
    </button>
    <div v-if="open" class="cascader-dropdown">
      <div class="cascader-list">
        <button
          v-for="item in items"
          :key="item.key"
          class="cascader-item"
          :class="{ 'cascader-selected': item.value === modelValue }"
          @mousedown.prevent="select(item)"
        >
          {{ item.key }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cascader {
  position: relative;
}
.cascader-trigger {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.95rem;
  cursor: pointer;
  text-align: left;
  transition: border-color var(--theme-transition-fast);
}
.cascader-trigger:focus {
  border-color: var(--theme-primary);
}
.cascader-placeholder {
  color: var(--theme-text-muted);
}

.cascader-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  margin-top: 4px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--theme-shadow-md);
  max-height: 240px;
  overflow-y: auto;
}
.cascader-list {
  display: flex;
  flex-direction: column;
  padding: 4px;
}
.cascader-item {
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
  border-radius: var(--theme-radius-sm);
  transition: background var(--theme-transition-fast);
}
.cascader-item:hover {
  background: var(--theme-tab-hover-bg);
}
.cascader-selected {
  color: var(--theme-primary);
  font-weight: 500;
}
</style>
