<script setup lang="ts">
/**
 * WorkshopEnableList.vue — 工坊项目启用勾选列表（P1-5，纯呈现）
 *
 * 捏人页（建档前）与游戏页每存档面板（建档后）共用同一份呈现: 两处各画一遍必然
 * 在「tags 显示成什么样」上分叉，而 tags 与简介是 D12 里**唯一**的冲突提示手段
 * —— 不做命定核心冲突拦截（上游 tags 是自由文本，猜必误伤），只把它们摆到用户眼前。
 *
 * 本组件不碰任何 store: 勾了什么、写到哪，由调用方决定。
 */
import type { WorkshopEnableOption } from '../../lib/workshop-enable';

const props = withDefaults(
  defineProps<{
    options: readonly WorkshopEnableOption[];
    /** 已勾选的项目 id */
    selected: ReadonlySet<string> | readonly string[];
    /** 无已装项目时的提示 */
    emptyText?: string;
    disabled?: boolean;
  }>(),
  {
    emptyText: '尚未安装任何工坊项目',
    disabled: false,
  },
);

const emit = defineEmits<{ toggle: [projectId: string] }>();

function isChecked(projectId: string): boolean {
  const s = props.selected;
  return s instanceof Set ? s.has(projectId) : (s as readonly string[]).includes(projectId);
}

/** 无条目的项目没有可启用之物 —— 勾了也产不出 token，直接锁住并说明 */
function isSelectable(option: WorkshopEnableOption): boolean {
  return !props.disabled && option.entryUids.length > 0;
}

function summary(text: string, maxLen = 120): string {
  const cleaned = text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

function onToggle(option: WorkshopEnableOption) {
  if (!isSelectable(option)) return;
  emit('toggle', option.projectId);
}
</script>

<template>
  <div class="workshop-enable-list">
    <div v-if="options.length === 0" class="empty-tab">{{ emptyText }}</div>

    <div v-else class="wk-grid">
      <label
        v-for="option in options"
        :key="option.projectId"
        class="wk-card"
        :class="{ checked: isChecked(option.projectId), locked: !isSelectable(option) }"
      >
        <input
          type="checkbox"
          class="wk-checkbox"
          :checked="isChecked(option.projectId)"
          :disabled="!isSelectable(option)"
          @change="onToggle(option)"
        />
        <div class="wk-info">
          <div class="wk-title-row">
            <span class="wk-name">{{ option.name }}</span>
            <span v-if="option.version" class="wk-version">v{{ option.version }}</span>
          </div>
          <div class="wk-meta">
            <span v-if="option.authorName">{{ option.authorName }}</span>
            <span v-if="option.authorName" class="wk-dot" aria-hidden="true">·</span>
            <span v-if="option.entryUids.length > 0">{{ option.entryUids.length }} 条条目</span>
            <span v-else class="wk-warn">无世界书条目</span>
          </div>
          <div v-if="option.tags.length > 0" class="wk-tags">
            <span v-for="tag in option.tags" :key="tag" class="wk-tag">{{ tag }}</span>
          </div>
          <p v-if="option.description" class="wk-desc">{{ summary(option.description) }}</p>
        </div>
      </label>
    </div>

    <!--
      W-02（2026-11-14）：口径对着 lib/workshop-enable.ts + worldbook-loader 的
      filterBooksByEnabledEntries + useBeautify 写 —— 存档里只要有任一工坊条目 token，
      工坊分区就只放行勾选的条目；一个都没有时不过滤。美化规则只在项目被勾选时生效。
    -->
    <div v-if="options.length > 0" class="wk-note">
      <p>工坊内容来自社区投稿，可能与内置设定（含命定核心）重叠，请按标签与简介自行判断。</p>
      <p>勾选：该扩展的世界书条目和美化规则在本存档生效。</p>
      <p>
        不勾选：它的美化规则不生效；只要本存档勾选了任意一个扩展，未勾选的扩展就完全不参与。
        一个都没勾选时，所有已安装扩展的世界书条目仍会按各自的关键词规则参与。
      </p>
    </div>
  </div>
</template>

<style scoped>
.workshop-enable-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  min-height: 0;
}

/* 空态 — design.md §5.2 */
.empty-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--theme-spacing-xl);
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
}
.empty-tab::before {
  content: '❦';
  margin-right: var(--theme-spacing-sm);
  opacity: 0.5;
}

.wk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--theme-spacing-sm);
  align-content: start;
  overflow-y: auto;
  min-height: 0;
}

.wk-card {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}
.wk-card:hover {
  border-color: var(--theme-primary);
}
.wk-card.checked {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-primary);
}
/* 命名避开全局 .disabled（utilities.css 会加 pointer-events:none） */
.wk-card.locked {
  opacity: 0.55;
  cursor: not-allowed;
}
.wk-card.locked:hover {
  border-color: var(--theme-card-border);
}

.wk-checkbox {
  margin-top: var(--theme-spacing-xs);
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}

.wk-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.wk-title-row {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  min-width: 0;
}
.wk-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk-version {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}

.wk-meta {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.wk-dot {
  opacity: 0.5;
}
.wk-warn {
  color: var(--theme-warning, var(--theme-text-secondary));
}

.wk-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.wk-tag {
  padding: 1px var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.5;
}

.wk-desc {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--theme-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.wk-note {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}
.wk-note p {
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wk-card {
    transition: none;
  }
}
</style>
