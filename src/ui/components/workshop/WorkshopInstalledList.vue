<script setup lang="ts">
/**
 * 已安装项目列表（Phase 1 / P1-4）
 *
 * ★ **`droppedNotes` 是本组件的重点，不是脚注。**
 *
 * 安装从来不是无损的: ST 正则的 `promptOnly` / `placement` / `minDepth` / `maxDepth`
 * / `substituteRegex` / `runOnEdit` / `trimStrings` 在本引擎里没有对应物，一律丢弃
 * （设计 D16）；`<script>` 在 `v-html` 里不会执行；载荷缺失时条目取自详情预览……
 * 每一条都写进了 `WorkshopProject.droppedNotes`。
 *
 * **丢弃必须 loud**（D16 原话）: 折叠态就把数字摆在行上，一次点击即可看全文。
 * 静默截断会让用户以为装全了，然后花一晚上找"为什么这个正则不生效"。
 *
 * ★ **但 loud ≠ 一律说「未导入」。** 首版把三种处置合流成一个数字，真机上一个
 * 项目报「34 项内容未导入」，其中 20 多条其实是「装了、也启用了，只是 `<script>`
 * 不执行 / `<style>` 会全局生效」—— 用户读到的是安装失败。现在按 `kind` 分三组
 * 各自计数：只有 `dropped` 叫「未导入」，`sideEffect` 因为会波及整个界面而最显眼。
 *
 * 老项目行的 `droppedNotes` 是裸 `string[]`（P1 首版落库形态），`groupWorkshopNotes`
 * 就地兼容（裸串归 `dropped`），不做迁移。
 *
 * 本组件纯呈现: 更新/卸载只 emit，实际动作由 WorkshopPage 走 store 的两段式提交。
 */
import { computed, ref } from 'vue';
import type { WorkshopNoteKind, WorkshopProject } from '@engine/types';
import type { WorkshopNoteGroups } from '@engine/workshop-types';
import { WORKSHOP_NOTE_KINDS, groupWorkshopNotes } from '@engine/workshop-types';
import AppButton from '../shared/AppButton.vue';
import {
  WORKSHOP_NOTE_HINT,
  WORKSHOP_NOTE_LABEL,
  formatDate,
  formatNoteSegment,
  formatVersion,
} from './format';

const props = defineProps<{
  projects: WorkshopProject[];
  /** 正在处理中的项目 id（安装/更新/卸载/查更新），用于禁用该行按钮 */
  busyId?: string;
}>();

/** 项目 id → 分好组的处置记录。一次算好，模板里三处读同一份 */
const noteGroups = computed<Record<string, WorkshopNoteGroups>>(() => {
  const map: Record<string, WorkshopNoteGroups> = {};
  for (const p of props.projects) map[p.id] = groupWorkshopNotes(p.droppedNotes);
  return map;
});

/** 非空的类别（保持 dropped → degraded → sideEffect 的固定次序） */
function activeKinds(id: string): WorkshopNoteKind[] {
  const groups = noteGroups.value[id];
  if (!groups) return [];
  return WORKSHOP_NOTE_KINDS.filter((kind) => groups[kind].length > 0);
}

function noteCount(id: string): number {
  const groups = noteGroups.value[id];
  if (!groups) return 0;
  return WORKSHOP_NOTE_KINDS.reduce((sum, kind) => sum + groups[kind].length, 0);
}

const emit = defineEmits<{
  detail: [projectId: string];
  update: [projectId: string];
  check: [projectId: string];
  uninstall: [projectId: string];
}>();

/** 展开了处置记录的项目 id 集合 —— 默认全折叠，行本身已带数字 */
const expanded = ref<Set<string>>(new Set());

function toggleNotes(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function stateText(p: WorkshopProject): string {
  switch (p.installState) {
    case 'update_available':
      return '有更新';
    case 'broken':
      return '上游不可达';
    default:
      return '已安装';
  }
}
</script>

<template>
  <div class="wk-installed">
    <p v-if="projects.length === 0" class="empty-tab">尚未安装任何工坊项目</p>

    <ul v-else class="wk-list">
      <li v-for="p in projects" :key="p.id" class="wk-row">
        <div class="wk-row-main">
          <div class="wk-row-head">
            <button type="button" class="wk-row-name" @click="emit('detail', p.id)">
              {{ p.name }}
            </button>
            <span class="wk-state" :class="`state-${p.installState}`">{{ stateText(p) }}</span>
          </div>

          <div class="wk-row-meta">
            <span>{{ p.authorName || '佚名' }}</span>
            <span class="wk-dot" aria-hidden="true">·</span>
            <!-- 版本对比：装的是哪版、上游是哪版，同一行读完 -->
            <span class="wk-ver">已装 {{ formatVersion(p.installedVersion) || '未标注' }}</span>
            <template v-if="p.version && p.version !== p.installedVersion">
              <span class="wk-arrow" aria-hidden="true">→</span>
              <span class="wk-ver wk-ver-new">上游 {{ formatVersion(p.version) }}</span>
            </template>
            <span class="wk-dot" aria-hidden="true">·</span>
            <span>装于 {{ formatDate(p.installedAt) || '—' }}</span>
          </div>

          <ul v-if="p.tags.length > 0" class="wk-tags">
            <li v-for="tag in p.tags" :key="tag" class="wk-tag">{{ tag }}</li>
          </ul>

          <!-- ★ 丢弃必须 loud（D16），但按 kind 分组如实报数：只有 dropped 叫「未导入」 -->
          <div v-if="noteCount(p.id) > 0" class="wk-notes">
            <button
              type="button"
              class="wk-notes-toggle"
              :aria-expanded="expanded.has(p.id)"
              @click="toggleNotes(p.id)"
            >
              <span
                class="wk-caret"
                :class="{ 'caret-open': expanded.has(p.id) }"
                aria-hidden="true"
                >▶</span
              >
              <span
                v-for="(kind, i) in activeKinds(p.id)"
                :key="kind"
                class="wk-note-seg"
                :class="`seg-${kind}`"
              >
                <span v-if="i > 0" class="wk-dot" aria-hidden="true">·</span>
                <span v-if="kind === 'sideEffect'" aria-hidden="true">⚠ </span>
                {{ formatNoteSegment(kind, noteGroups[p.id][kind].length) }}
              </span>
            </button>
            <Transition name="notes">
              <div v-if="expanded.has(p.id)" class="wk-notes-body">
                <section
                  v-for="kind in activeKinds(p.id)"
                  :key="kind"
                  class="wk-note-group"
                  :class="`group-${kind}`"
                >
                  <h4 class="wk-note-title">
                    {{ noteGroups[p.id][kind].length }} 项{{ WORKSHOP_NOTE_LABEL[kind] }}
                  </h4>
                  <p class="wk-note-hint">{{ WORKSHOP_NOTE_HINT[kind] }}</p>
                  <ul class="wk-notes-list">
                    <li v-for="(note, i) in noteGroups[p.id][kind]" :key="i">{{ note.text }}</li>
                  </ul>
                </section>
              </div>
            </Transition>
          </div>
        </div>

        <div class="wk-row-actions">
          <AppButton
            v-if="p.installState === 'update_available'"
            variant="primary"
            size="sm"
            :disabled="busyId === p.id"
            @click="emit('update', p.id)"
          >
            更新
          </AppButton>
          <AppButton
            v-else
            variant="secondary"
            size="sm"
            :disabled="busyId === p.id"
            @click="emit('check', p.id)"
          >
            查更新
          </AppButton>
          <AppButton
            variant="ghost"
            size="sm"
            :disabled="busyId === p.id"
            @click="emit('uninstall', p.id)"
          >
            卸载
          </AppButton>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.wk-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.wk-row {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  /* 全边 1px —— 禁止品质/状态色左边条（design.md §1） */
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.wk-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}
.wk-row-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.wk-row-name {
  padding: 0;
  background: none;
  border: none;
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  cursor: pointer;
  text-align: left;
  transition: color var(--theme-transition-fast);
}
.wk-row-name:hover {
  color: var(--theme-primary);
}

.wk-state {
  padding: 1px 8px;
  border-radius: var(--theme-radius-full);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.7;
}
.state-installed {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
}
.state-update_available {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.state-broken {
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
}

.wk-row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.wk-dot {
  opacity: 0.6;
}
.wk-ver-new {
  color: var(--theme-warning);
}
.wk-arrow {
  color: var(--theme-text-muted);
}

.wk-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}
.wk-tag {
  padding: 1px 7px;
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 26%, var(--theme-card-border));
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.7;
}

/* ── 处置记录 ── */
.wk-notes {
  margin-top: var(--theme-spacing-xs);
}
.wk-notes-toggle {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
  background: none;
  border: none;
  color: var(--theme-text-muted);
  font-family: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
  transition: color var(--theme-transition-fast);
}
.wk-notes-toggle:hover {
  color: var(--theme-text-primary);
}
.wk-caret {
  display: inline-block;
  font-size: 0.55rem;
  transition: transform var(--theme-transition-fast);
}
.caret-open {
  transform: rotate(90deg);
}

/* 折叠行分段：真丢弃用 warning，装上了但打折用 muted，全局副作用最显眼 */
.wk-note-seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.seg-dropped {
  color: var(--theme-warning);
}
.seg-degraded {
  color: var(--theme-text-muted);
}
.seg-sideEffect {
  color: var(--theme-error);
  font-weight: 600;
}

.wk-notes-body {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin-top: var(--theme-spacing-xs);
}
.wk-note-group {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  /* 全边 1px —— 禁止状态色左边条（design.md §1） */
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
}
.group-dropped {
  background: color-mix(in srgb, var(--theme-warning) 6%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-warning) 22%, var(--theme-card-border));
}
.group-degraded {
  background: color-mix(in srgb, var(--theme-text-muted) 6%, var(--theme-card-bg));
}
.group-sideEffect {
  background: color-mix(in srgb, var(--theme-error) 7%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}
.wk-note-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.group-sideEffect .wk-note-title {
  color: var(--theme-error);
}
.wk-note-hint {
  margin: 2px 0 0;
  font-size: 0.6875rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}
.wk-notes-list {
  margin: var(--theme-spacing-xs) 0 0;
  padding: 0 0 0 var(--theme-spacing-lg);
  list-style: disc;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}

/* 展开用 opacity + grid 行高，绝不过渡 max-height/padding（design.md §1 禁令） */
.notes-enter-active,
.notes-leave-active {
  transition: opacity 0.25s ease;
}
.notes-enter-from,
.notes-leave-to {
  opacity: 0;
}

.wk-row-actions {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}

.empty-tab {
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}

@media (prefers-reduced-motion: reduce) {
  .notes-enter-active,
  .notes-leave-active,
  .wk-caret,
  .wk-row-name,
  .wk-notes-toggle {
    transition: none;
  }
}
</style>
