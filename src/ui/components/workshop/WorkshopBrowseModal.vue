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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkshopProjectMeta } from '@engine/workshop-types';
import { WORKSHOP_BASE_TAGS } from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import {
  listProjects,
  WORKSHOP_DEFAULT_PAGE_SIZE,
  WORKSHOP_DEFAULT_SORT,
} from '../../lib/workshop-client';
import type { WorkshopFailure, WorkshopSortMode } from '../../lib/workshop-client';
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
const sort = ref<WorkshopSortMode>(WORKSHOP_DEFAULT_SORT as WorkshopSortMode);

/**
 * 排序选项。**值**是上游 `z.enum` 的成员（传别的会 400），文案是本地的。
 *
 * 按点赞/订阅/下载排序不需要我们建任何社交状态 —— 它只是个查询参数，计数本身
 * 仍然不消费（属 Phase 3+）。
 */
const SORT_OPTIONS: { value: WorkshopSortMode; label: string }[] = [
  { value: 'published', label: '最新发布' },
  { value: 'updated', label: '最近更新' },
  { value: 'likes', label: '最多点赞' },
  { value: 'subscribes', label: '最多订阅' },
  { value: 'downloads', label: '最多下载' },
];

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

/**
 * 标签筛选条 —— **恒定**四个基础标签，不从当前页现采（见 `WORKSHOP_BASE_TAGS`）。
 *
 * 现采的老做法有两处害：翻到不含某标签的页时该标签会从条上消失；条的行数随内容
 * 变化，每次翻页都把下方整个网格顶上顶下。上游 `/api` 没有 `/tags` 接口，所以
 * 「完整标签全集」本来也拿不到 —— 现采只是拿一页冒充全集。
 *
 * 卡片和详情页仍然照常展示项目自己的全部标签（D12），这里限制的只是**筛选入口**。
 */
const tagOptions = WORKSHOP_BASE_TAGS;

/**
 * 网格的重建键。变一次 → Vue 整片换掉 → 卡片重跑入场动画。
 *
 * 这是「翻页像换了一页纸」而不是「内容原地跳变」的关键: 没有它，Vue 会按 key 复用
 * 卡片 DOM，新旧两页的内容逐格替换，读起来像闪烁。
 */
const gridKey = computed(
  () => `${sort.value}|${activeTag.value}|${search.value.trim()}|${page.value}`,
);

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
      sort: sort.value,
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

/**
 * 排序必须**服务端**做且回到第 0 页。只对当前页重排会排出「第 2 页的热门项目
 * 排在第 1 页的冷门项目之前」这种自相矛盾的结果。
 */
function selectSort(next: WorkshopSortMode): void {
  if (sort.value === next) return;
  sort.value = next;
  reloadFromFirstPage();
}

/** 结果区容器 —— 翻页后要把它滚回顶部 */
const resultsEl = ref<HTMLElement | null>(null);

/**
 * 翻页后把滚动位置带回结果区顶部。
 *
 * 不做的话，从第 1 页底部按「下一页」会停在第 2 页的中段，屏幕上一半是空白一半是
 * 卡片 —— 用户以为新页只有几个项目。滚的是模态自己的滚动容器（`closest`），
 * 不是 window。
 */
function scrollResultsToTop(): void {
  const el = resultsEl.value;
  if (!el) return;
  const scroller = el.closest<HTMLElement>('.modal-body') ?? el.parentElement;
  if (!scroller || typeof scroller.scrollTo !== 'function') return;
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

function goPage(delta: number): void {
  const next = page.value + delta;
  if (next < 0 || next >= totalPages.value) return;
  page.value = next;
  void load().then(() => nextTick(scrollResultsToTop));
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
      <!-- ═══ 工具条：搜索 + 排序 + 取消/刷新 ═══ -->
      <div class="wk-toolbar">
        <input
          v-model="search"
          type="search"
          class="wk-search"
          placeholder="搜索项目名或作者…"
          aria-label="搜索工坊项目"
        />
        <select
          class="wk-sort"
          aria-label="排序方式"
          :value="sort"
          @change="selectSort(($event.target as HTMLSelectElement).value as WorkshopSortMode)"
        >
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <AppButton v-if="loading" variant="secondary" size="sm" @click="cancelLoad">
          取消
        </AppButton>
        <AppButton v-else variant="secondary" size="sm" @click="load()"> 刷新 </AppButton>
      </div>

      <!-- ═══ 标签筛选（恒定四项，不随当前页漂移） ═══ -->
      <div class="wk-tagbar" role="group" aria-label="按标签筛选">
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
      <div ref="resultsEl" class="wk-results" :aria-busy="loading">
        <div v-if="loading && projects.length === 0" class="wk-skeleton-grid" aria-hidden="true">
          <div v-for="n in 8" :key="n" class="wk-skeleton">
            <div class="wk-skeleton-cover"></div>
            <div class="wk-skeleton-line sk-title"></div>
            <div class="wk-skeleton-line sk-meta"></div>
            <div class="wk-skeleton-line sk-desc"></div>
          </div>
        </div>

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

        <!-- :key 让整片网格随查询条件重建 → 卡片重跑入场动画，翻页读起来像换了一页纸 -->
        <div v-else :key="gridKey" class="wk-grid" :class="{ 'grid-loading': loading }">
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
/* 排序：与搜索框同高同字号（工具条里两个控件差一号字会很扎眼） */
.wk-sort {
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}
.wk-sort:focus {
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
/*
 * min-height 撑住一整屏卡片的高度。翻页时新旧两页条数不同（末页往往只有几个），
 * 没有它模态会先塌到几十像素再弹回来 —— 那一下塌陷就是最明显的一次抖动。
 */
.wk-results {
  min-height: 420px;
}
.wk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: var(--theme-spacing-md);
}

/*
 * 在飞时把旧结果压暗而不是抽走: 屏幕上始终有内容，用户知道自己还在原地。
 * 只动 opacity（design.md §1 禁止布局属性过渡）。
 */
.grid-loading {
  opacity: 0.45;
  pointer-events: none;
}
.wk-grid {
  transition: opacity var(--theme-transition-normal);
}

/*
 * 卡片入场: opacity + translateY(12px) / 0.35s（design.md §6.1「消息入场」同款）。
 * 逐格递延 40ms，到第 8 格封顶 —— 不封顶的话一页 20 个卡片最后一个要等 0.8s，
 * 那已经不是「入场」而是「加载慢」了。
 */
.wk-grid > * {
  animation: wk-card-in 0.35s ease both;
}
.wk-grid > *:nth-child(1) {
  animation-delay: 0ms;
}
.wk-grid > *:nth-child(2) {
  animation-delay: 40ms;
}
.wk-grid > *:nth-child(3) {
  animation-delay: 80ms;
}
.wk-grid > *:nth-child(4) {
  animation-delay: 120ms;
}
.wk-grid > *:nth-child(5) {
  animation-delay: 160ms;
}
.wk-grid > *:nth-child(6) {
  animation-delay: 200ms;
}
.wk-grid > *:nth-child(7) {
  animation-delay: 240ms;
}
.wk-grid > *:nth-child(n + 8) {
  animation-delay: 280ms;
}
@keyframes wk-card-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/*
 * 骨架屏 —— 首次加载用它替掉一行「正在取书…」的文字。
 *
 * 理由不是好看: 文字态只有一行高，等结果到了整个模态从一行猛涨到满屏，是这里
 * 第二明显的一次抖动。骨架把最终布局**先占住**，内容到位时只是填色。
 */
.wk-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: var(--theme-spacing-md);
}
.wk-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: 0 0 var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  overflow: hidden;
}
.wk-skeleton-cover {
  aspect-ratio: 16 / 9;
  background: var(--theme-surface-muted);
}
.wk-skeleton-line {
  height: 10px;
  margin: 0 var(--theme-spacing-md);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
}
.sk-title {
  width: 70%;
  height: 13px;
}
.sk-meta {
  width: 45%;
}
.sk-desc {
  width: 90%;
}
.wk-skeleton-cover,
.wk-skeleton-line {
  animation: wk-skeleton-pulse 1.4s ease-in-out infinite;
}
@keyframes wk-skeleton-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
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
  .wk-sort,
  .wk-tagchip,
  .wk-grid {
    transition: none;
  }
  /*
   * 入场动画与骨架脉动**不在这里关**: `themes/variables.css` 的全局减动效规则已用
   * `animation-duration: .01ms !important` + `animation-iteration-count: 1 !important`
   * 兜住了全站。
   *
   * ★ 别改成 `animation: none` —— 那会连 `both` 的终态一起撤销，卡片停在
   * `opacity: 0` 上，减动效用户看到的是一片空网格。全局那套则是「瞬间跑完一轮」，
   * 天然停在终态（卡片可见、骨架不闪、转圈静止），正是我们要的。
   */
}
</style>
