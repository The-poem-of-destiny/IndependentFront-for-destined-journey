<script setup lang="ts">
/**
 * 变量修改器左栏：可折叠状态树 + 按名字或路径搜索（拆自 StateEditorPanel，2026-11-25 审查 R6）。
 *
 * 选中路径与展开集合由面板持有（跳转定位、提交后退到祖先都要改它们），本组件只画、只发事件；
 * 搜索词只影响树，留在本组件。搜索判定在 `state-editor-view.ts` 的 `searchEditorTree`。
 *
 * 🔴 全程文本插值，不用 v-html（树上的名字来自模型输出）。
 */
import { computed, ref } from 'vue';
import { searchEditorTree, type EditorNode } from '../state-editor-view';

const props = defineProps<{
  nodes: readonly EditorNode[];
  selectedPath: string;
  expanded: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  select: [node: EditorNode];
  toggle: [path: string];
}>();

const query = ref('');
const search = computed(() => searchEditorTree(props.nodes, query.value));

interface TreeRow {
  node: EditorNode;
  depth: number;
  open: boolean;
}

const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  const s = search.value;
  const walk = (list: readonly EditorNode[], depth: number) => {
    for (const node of list) {
      if (s && !s.visible.has(node.path)) continue;
      const open = s ? s.expanded.has(node.path) : props.expanded.has(node.path);
      out.push({ node, depth, open });
      if (open && node.children.length > 0) walk(node.children, depth + 1);
    }
  };
  walk(props.nodes, 1);
  return out;
});

function onRowKey(e: KeyboardEvent, row: TreeRow) {
  if (row.node.children.length === 0) return;
  if (e.key === 'ArrowRight' && !row.open) emit('toggle', row.node.path);
  else if (e.key === 'ArrowLeft' && row.open) emit('toggle', row.node.path);
}
</script>

<template>
  <aside class="se-tree">
    <label class="se-search">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        placeholder="按名字或路径搜索"
        aria-label="按名字或路径搜索"
      />
    </label>
    <div class="se-tree-scroll" role="tree" aria-label="状态树">
      <div
        v-for="row in rows"
        :key="row.node.path"
        class="se-row"
        :class="{
          'is-selected': row.node.path === selectedPath,
          'is-match': search?.matched.has(row.node.path),
        }"
        :style="{ '--depth': row.depth }"
      >
        <button
          v-if="row.node.children.length > 0 && !search"
          class="se-caret"
          type="button"
          :aria-label="row.open ? `折叠 ${row.node.label}` : `展开 ${row.node.label}`"
          tabindex="-1"
          @click="emit('toggle', row.node.path)"
        >
          <i class="fa-solid fa-chevron-right" :class="{ open: row.open }" aria-hidden="true" />
        </button>
        <span v-else class="se-caret-spacer" aria-hidden="true" />
        <button
          class="se-row-label"
          type="button"
          role="treeitem"
          :aria-level="row.depth"
          :aria-selected="row.node.path === selectedPath"
          :aria-expanded="row.node.children.length > 0 ? row.open : undefined"
          :data-path="row.node.path"
          @click="emit('select', row.node)"
          @keydown="onRowKey($event, row)"
        >
          <span class="se-row-name">{{ row.node.label }}</span>
          <span v-if="row.node.kind === 'record'" class="se-row-count">{{
            row.node.children.length
          }}</span>
        </button>
      </div>
      <div v-if="rows.length === 0" class="empty-tab">没有匹配的条目</div>
    </div>
  </aside>
</template>

<style scoped src="./state-editor-shared.css"></style>
<style scoped>
.se-tree {
  width: 18rem;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.se-search {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-sm);
  min-height: 36px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-muted);
}
.se-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  outline: none;
}
.se-search:focus-within {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.se-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.se-row {
  display: flex;
  align-items: center;
  padding-left: calc((var(--depth) - 1) * var(--theme-spacing-md));
  border-radius: var(--theme-radius-sm);
  transition: background var(--theme-transition-fast);
}
.se-row:hover {
  background: var(--theme-tab-hover-bg);
}
.se-row.is-selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.se-caret,
.se-caret-spacer {
  width: 24px;
  height: 32px;
  flex-shrink: 0;
}
.se-caret {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.6875rem;
}
.se-caret i {
  transition: transform var(--theme-transition-fast);
}
.se-caret i.open {
  transform: rotate(90deg);
}
.se-row-label {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-sm) 0 0;
  border: none;
  background: none;
  color: var(--theme-text-secondary);
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}
.se-row.is-selected .se-row-label {
  color: var(--theme-text-primary);
  font-weight: 600;
}
.se-row.is-match .se-row-name {
  color: var(--theme-primary);
}
.se-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.5;
}
.se-row-count {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .se-caret i,
  .se-row {
    transition: none;
  }
}

/* 窄屏：两栏叠成一栏（面板那侧把 .se-body 改成纵向） */
@media (max-width: 900px) {
  .se-tree {
    width: auto;
    max-height: 40%;
  }
}
</style>
