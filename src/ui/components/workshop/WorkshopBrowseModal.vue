<script setup lang="ts">
/**
 * 浏览工坊 —— 列表模态（Phase 1 / P1-4，设计 D17）
 *
 * 本项目自己的 Vue 模态，直连上游公开 REST。**不嵌 iframe、不跑上游 JS**（D17）。
 *
 * 只读一面: 这里没有点赞/订阅/投稿，Phase 3+ 再说。
 *
 * 三条纪律:
 * 1. **网络只经 `workshop-client`**。组件不碰 `fetch`，也不自己拼 URL —— 上游改路径时
 *    只有一个文件要改。
 * 2. **每次请求都可取消**。翻页、改搜索词、切标签、关模态都会掐掉上一发在飞请求；
 *    `kind: 'cancelled'` 是**正常收场**，不弹错、不写错误态（否则用户每敲一个字
 *    就闪一次红）。
 * 3. **失败要说人话且给得起重试**。上游是第三方 worker，抽风是常态而非异常路径。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkshopProjectMeta } from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import { listProjects, WORKSHOP_DEFAULT_PAGE_SIZE } from '../../lib/workshop-client';
import type { WorkshopFailure } from '../../lib/workshop-client';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import WorkshopProjectCard from './WorkshopProjectCard.vue';
import { describeFailure } from './failure-text';

const props = defineProps<{
  open: boolean;
  /** 已安装项目 —— 用来给卡片打「已安装 / 有更新」徽章 */
  installed: WorkshopProject[];
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  open: [projectId: string];
}>();

// ═══ 查询状态 ═══

const search = ref('');
const activeTag = ref('');
const page = ref(0);
const pageSize = ref(WORKSHOP_DEFAULT_PAGE_SIZE);

const projects = ref<WorkshopProjectMeta[]>([]);
const total = ref(0);
const droppedCount = ref(0);
const loading = ref(false);
const failure = ref<WorkshopFailure | null>(null);
/** 至少成功加载过一次 —— 区分「还没拉过」与「拉到了但是空的」 */
const loadedOnce = ref(false);

/**
 * 在飞请求的取消把手。
 *
 * 只留**一个**: 工坊列表在任一时刻只该有一发请求在路上，后来者一律先掐前者。
 * 保留多个会让后到的响应覆盖先到的（经典的乱序竞态），而列表的正确性完全取决于
 * 「屏幕上这一页是不是最后一次请求的结果」。
 */
let inflight: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const totalPages = computed(() =>
  Math.max(1, Math.ceil(Math.max(0, total.value) / Math.max(1, pageSize.value))),
);
const canPrev = computed(() => page.value > 0 && !loading.value);
const canNext = computed(() => page.value + 1 < totalPages.value && !loading.value);

/** 标签筛选条: 从当前这页的结果里现采。上游没有 `/api/tags`，这是唯一的来源 */
const tagOptions = computed(() => {
  const seen = new Set<string>();
  for (const p of projects.value) for (const t of p.tags) if (t) seen.add(t);
  if (activeTag.value) seen.add(activeTag.value); // 筛出来的那页可能不含该标签本身
  return [...seen];
});

const installedById = computed(() => {
  const map = new Map<string, WorkshopProject>();
  for (const p of props.installed) map.set(p.id, p);
  return map;
});

// ═══ 加载 ═══

function abortInflight(): void {
  inflight?.abort();
  inflight = null;
}

async function load(): Promise<void> {
  abortInflight();
  const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctrl = typeof Ctor === 'function' ? new Ctor() : null;
  inflight = ctrl;

  loading.value = true;
  failure.value = null;

  const res = await listProjects(
    {
      page: page.value,
      pageSize: pageSize.value,
      tag: activeTag.value || undefined,
      search: search.value.trim() || undefined,
    },
    { signal: ctrl?.signal },
  );

  // 已被后来者掐掉 → 这份结果属于上一个查询，一个字都不许写进屏幕状态
  if (inflight !== ctrl) return;
  inflight = null;
  loading.value = false;

  if (!res.ok) {
    // 取消是正常收场，不是错误：不写错误态、不清列表
    if (res.error.kind === 'cancelled') return;
    failure.value = res.error;
    return;
  }

  projects.value = res.data.projects;
  total.value = res.data.total;
  pageSize.value = res.data.pageSize > 0 ? res.data.pageSize : pageSize.value;
  droppedCount.value = res.data.droppedCount;
  loadedOnce.value = true;
}

/** 用户按「取消」：掐掉请求并退出忙碌态，屏幕保留上一次的结果 */
function cancelLoad(): void {
  abortInflight();
  loading.value = false;
}

function reloadFromFirstPage(): void {
  page.value = 0;
  void load();
}

// 搜索词防抖 350ms —— 每敲一个字发一次请求既浪费上游也让结果闪烁
watch(search, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reloadFromFirstPage();
  }, 350);
});

function selectTag(tag: string): void {
  activeTag.value = activeTag.value === tag ? '' : tag;
  reloadFromFirstPage();
}

function goPage(delta: number): void {
  const next = page.value + delta;
  if (next < 0 || next >= totalPages.value) return;
  page.value = next;
  void load();
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // 每次打开都重拉：列表是上游变动最频繁的一面，且 listProjects 本就不缓存
      void load();
    } else {
      abortInflight();
      loading.value = false;
    }
  },
);

onBeforeUnmount(() => {
  abortInflight();
  if (debounceTimer) clearTimeout(debounceTimer);
});

// ═══ 失败文案 ═══

const failureText = computed(() => (failure.value ? describeFailure(failure.value) : ''));
</script>

<template>
  <AppModal :open="open" title="浏览创意工坊" size="xl" @update:open="emit('update:open', $event)">
    <div class="wk-browse">
      <!-- ═══ 工具条：搜索 + 取消/刷新 ═══ -->
      <div class="wk-toolbar">
        <input
          v-model="search"
          type="search"
          class="wk-search"
          placeholder="搜索项目名或作者…"
          aria-label="搜索工坊项目"
        />
        <AppButton v-if="loading" variant="secondary" size="sm" @click="cancelLoad">
          取消
        </AppButton>
        <AppButton v-else variant="secondary" size="sm" @click="load()"> 刷新 </AppButton>
      </div>

      <!-- ═══ 标签筛选 ═══ -->
      <div v-if="tagOptions.length > 0" class="wk-tagbar" role="group" aria-label="按标签筛选">
        <button
          v-for="tag in tagOptions"
          :key="tag"
          type="button"
          class="wk-tagchip"
          :class="{ 'chip-active': activeTag === tag }"
          :aria-pressed="activeTag === tag"
          @click="selectTag(tag)"
        >
          {{ tag }}
        </button>
        <button
          v-if="activeTag"
          type="button"
          class="wk-tagchip chip-clear"
          @click="selectTag(activeTag)"
        >
          清除筛选
        </button>
      </div>

      <p class="sr-only" role="status" aria-live="polite">
        {{
          loading
            ? '正在向创意工坊取列表…'
            : failure
              ? failureText
              : `共 ${total} 个项目，第 ${page + 1} / ${totalPages} 页。`
        }}
      </p>

      <!-- ═══ 结果区 ═══ -->
      <div class="wk-results">
        <p v-if="loading && projects.length === 0" class="empty-tab">正在向创意工坊取书…</p>

        <div v-else-if="failure" class="wk-failure" role="alert">
          <p class="wk-failure-text">{{ failureText }}</p>
          <p class="wk-failure-detail">{{ failure.message }}</p>
          <AppButton variant="primary" size="sm" @click="load()">重试</AppButton>
          <p class="wk-failure-hint">
            也可以从工坊网页下载 <code>project-xxx.json</code>，回到工坊页用「导入本地文件」装上。
          </p>
        </div>

        <p v-else-if="projects.length === 0 && loadedOnce" class="empty-tab">
          {{ search.trim() || activeTag ? '没有符合条件的项目' : '工坊里还空着' }}
        </p>

        <div v-else class="wk-grid">
          <WorkshopProjectCard
            v-for="p in projects"
            :key="p.id"
            :project="p"
            :state="installedById.get(p.id)?.installState"
            :installed-version="installedById.get(p.id)?.installedVersion"
            @open="emit('open', $event)"
          />
        </div>

        <p v-if="droppedCount > 0" class="wk-dropped-note">
          上游有 {{ droppedCount }} 个项目缺少 id，本页跳过了它们。
        </p>
      </div>
    </div>

    <template #footer>
      <div class="wk-pager">
        <span class="wk-pager-info">
          共 {{ total }} 个项目 · 第 {{ page + 1 }} / {{ totalPages }} 页
        </span>
        <AppButton variant="secondary" size="sm" :disabled="!canPrev" @click="goPage(-1)">
          上一页
        </AppButton>
        <AppButton variant="secondary" size="sm" :disabled="!canNext" @click="goPage(1)">
          下一页
        </AppButton>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.wk-browse {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

/* ── 工具条 ── */
.wk-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.wk-search {
  flex: 1;
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
  transition: border-color var(--theme-transition-fast);
}
.wk-search:focus {
  outline: none;
  border-color: var(--theme-primary);
}

/* ── 标签条 ── */
.wk-tagbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.wk-tagchip {
  padding: 4px 10px;
  min-height: 26px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.wk-tagchip:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.chip-active {
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  color: var(--theme-text-primary);
  font-weight: 600;
}
.chip-clear {
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ── 结果 ── */
.wk-results {
  min-height: 220px;
}
.wk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: var(--theme-spacing-md);
}

.wk-failure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xl) var(--theme-spacing-lg);
  text-align: center;
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.wk-failure-text {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
}
.wk-failure-detail {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  word-break: break-all;
}
.wk-failure-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.wk-failure-hint code {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.7rem;
}

.wk-dropped-note {
  margin: var(--theme-spacing-md) 0 0;
  font-size: 0.75rem;
  color: var(--theme-warning);
}

/* ── 空态（design.md §5.2） ── */
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

/* ── 分页 ── */
.wk-pager {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  width: 100%;
}
.wk-pager-info {
  flex: 1;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .wk-search,
  .wk-tagchip {
    transition: none;
  }
}
</style>
