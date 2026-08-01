<script setup lang="ts">
/**
 * 浏览工坊 —— 列表模态（Phase 1 / P1-4，设计 D17）
 *
 * 本项目自己的 Vue 模态，直连上游公开 REST。**不嵌 iframe、不跑上游 JS**（D17）。
 *
 * 社交面只到「展示 + 转交」为止（P3c）: 计数随同一份列表响应回来（`data.socials`，
 * 零额外请求），本组件按 id 派给对应卡片；点赞/订阅的动作与状态归
 * `WorkshopSocialActions` + social store。投稿/管理面仍不做。
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
import type {
  WorkshopListingMeta,
  WorkshopProjectMeta,
  WorkshopSocialMeta,
} from '@engine/workshop-types';
import { WORKSHOP_BASE_TAGS } from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import {
  deleteProject,
  invalidateWorkshopProject,
  listMyProjects,
  listProjects,
  setProjectVisibility,
  WORKSHOP_DEFAULT_PAGE_SIZE,
  WORKSHOP_DEFAULT_SORT,
} from '../../lib/workshop-client';
import { useWorkshopSocialStore } from '../../stores/workshop-social-store';
import type { WorkshopFailure, WorkshopSortMode } from '../../lib/workshop-client';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import WorkshopProjectCard from './WorkshopProjectCard.vue';
import { scrollBehavior } from '../../lib/reduced-motion';
import { describeFailure } from './failure-text';
import { baseTagOf } from './format';

const props = defineProps<{
  open: boolean;
  /** 已安装项目 —— 用来给卡片打「已安装 / 有更新」徽章 */
  installed: WorkshopProject[];
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  open: [projectId: string];
  /** 作者要编辑自己的项目（B4）—— 表单归页面持有，本模态只转达 */
  edit: [projectId: string];
  /** 一句要给用户看的话（成功/失败），由页面统一 toast */
  notify: [message: string, kind: 'success' | 'error'];
}>();

/** 只读社交状态 —— 「订阅与已装」要认哪些项目是我订阅的（覆盖层优先，§3.3） */
const socialStore = useWorkshopSocialStore();

// ═══ 查询状态 ═══

const search = ref('');
const activeTag = ref('');
const page = ref(0);
const pageSize = ref(WORKSHOP_DEFAULT_PAGE_SIZE);
const sort = ref<WorkshopSortMode>(WORKSHOP_DEFAULT_SORT as WorkshopSortMode);

/**
 * 排序选项。**值**是上游 `z.enum` 的成员（传别的会 400），文案是本地的。
 *
 * 按点赞/订阅/下载排序是纯查询参数，与卡片上显示的计数各走各的 —— 排序由服务端
 * 定序，计数由响应里的 `socials` 给，两者不必也不该互相校验。
 */
const SORT_OPTIONS: { value: WorkshopSortMode; label: string }[] = [
  { value: 'published', label: '最新发布' },
  { value: 'updated', label: '最近更新' },
  { value: 'likes', label: '最多点赞' },
  { value: 'subscribes', label: '最多订阅' },
  { value: 'downloads', label: '最多下载' },
];

/**
 * 三个视图（对齐上游的「全部 / 我的项目 / 订阅与安装项目」）。
 *
 * ★ 只有 `all` 是**服务端**驱动的 —— 上游的分页/排序/标签/搜索参数全长在
 * `GET /api/projects` 上。另外两个视图上游没有对应的查询接口:
 * - `mine` 走 `GET /api/my/projects`，一次全量返回、不吃任何筛选参数
 * - `library` 根本不发请求，是对**已加载结果 + 本地已装**做的纯客户端派生
 *
 * 所以这两个视图里的搜索与标签只能在本地做，排序与「加载更多」直接不出现 ——
 * 摆一个点了没反应的控件比没有它更糟。上游同样把这两个控件在这两个视图里整个藏掉。
 */
type BrowseScope = 'all' | 'mine' | 'library';
const scope = ref<BrowseScope>('all');
const SCOPE_OPTIONS: { value: BrowseScope; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的项目' },
  { value: 'library', label: '订阅与已装' },
];
/** 服务端筛选只在 `all` 里成立 —— 另外两个视图的筛选一律落到本地 */
const isServerScope = computed(() => scope.value === 'all');

const projects = ref<WorkshopProjectMeta[]>([]);
/**
 * 项目 id → 社交计数（D22）。与 `projects` 分开存而不是并进每个项目里，是因为它
 * **永不落库**：合进去之后，「这个对象能不能写进 Dexie」就再没有类型上的答案了。
 * 同一份响应顺带带回来的，零额外请求。
 */
const socials = ref<Record<string, WorkshopSocialMeta>>({});
/** 项目 id → 作者身份 + 审核状态（Phase 4）。与 socials 同源同纪律：不落库 */
const listings = ref<Record<string, WorkshopListingMeta>>({});
const total = ref(0);
const droppedCount = ref(0);
const loading = ref(false);
/**
 * 追加中 —— 与 `loading` 分开。合成一个的话，点「加载更多」会把已经在屏幕上的
 * 网格换成骨架屏（`loading && projects.length === 0` 那条不成立，但 `grid-loading`
 * 会把它压暗），用户会以为自己把列表弄没了。
 */
const loadingMore = ref(false);
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

/**
 * 「还能再加载」= 已经拉到过东西，且上游报的总数比手上的多（对齐上游
 * `shouldShowProjectLoadMore`）。用 total 而不是「上一页拉满了 pageSize」判断 ——
 * 后者在总数恰好是 pageSize 整数倍时会多出一次拉到空页的请求。
 */
const remaining = computed(() => Math.max(0, total.value - projects.value.length));
const canLoadMore = computed(
  () => isServerScope.value && projects.value.length > 0 && remaining.value > 0,
);

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
 * 网格的重建键 —— **只在结果落地时 +1**。
 *
 * 变一次 → Vue 整片换掉 → 卡片重跑入场动画，「翻页像换了一页纸」而不是内容原地跳变。
 *
 * ★ 曾经它是 `sort|tag|search|page` 拼出来的 computed，那是错的：这些都是**输入**，
 * 在请求发出之前就变了。后果有两处 ——
 * - 打字：搜索是 350ms 防抖的，敲「abc」会在一发请求都还没出去时把网格重建三次，
 *   每次都拿**没变过的旧数据**重放 0.35s 交错入场
 * - 翻页：按下就重建，先拿**上一页**的卡片演一遍入场，等新数据到了（卡片按 p.id
 *   为 key，是全新节点）再演第二遍
 *
 * 一个「防抖动」的机关，自己成了抖动的来源。绑数据落地就没有这个问题。
 */
const renderSeq = ref(0);

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

/**
 * 拉一页。
 *
 * `force` = 越过 `listProjects` 的 45 秒列表缓存。**只有工具条上的「刷新」传 true**：
 * 那是用户明确表达「我要最新的」的唯一入口。翻页/改搜索词/切标签都不传 —— 它们各自
 * 是不同的缓存键，本来就拉的是新内容；而「翻回上一页」这种原地打转命中缓存正是我们
 * 想要的省。失败从不入缓存，所以失败态里的「重试」也不需要 force。
 */
async function load(force = false, append = false): Promise<void> {
  abortInflight();
  const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctrl = typeof Ctor === 'function' ? new Ctor() : null;
  inflight = ctrl;

  const targetPage = append ? page.value + 1 : page.value;
  if (append) loadingMore.value = true;
  else loading.value = true;
  failure.value = null;

  const res = isServerScope.value
    ? await listProjects(
        {
          page: targetPage,
          pageSize: pageSize.value,
          sort: sort.value,
          tag: activeTag.value || undefined,
          search: search.value.trim() || undefined,
        },
        { signal: ctrl?.signal, force },
      )
    : // 「我的项目」不吃任何筛选参数（上游一次全量返回）；「订阅与已装」压根不发请求，
      // 由 displayProjects 从已加载结果派生 —— 这里给它一个空页占位即可
      scope.value === 'mine'
      ? await listMyProjects({ signal: ctrl?.signal })
      : ({ ok: true, fromCache: false, data: emptyPage() } as const);

  // 已被后来者掐掉 → 这份结果属于上一个查询，一个字都不许写进屏幕状态
  if (inflight !== ctrl) return;
  inflight = null;
  loading.value = false;
  loadingMore.value = false;

  if (!res.ok) {
    // 取消是正常收场，不是错误：不写错误态、不清列表
    if (res.error.kind === 'cancelled') return;
    // 追加失败**不清空已加载的内容** —— 用户翻了半天的结果不该因为第 4 页挂了就消失
    failure.value = res.error;
    return;
  }

  page.value = targetPage;
  if (append) {
    /*
     * 按 id 去重后再追加。上游按 `updated_at` 等可变列排序又用 OFFSET 分页，
     * 两次请求之间有人更新了项目，同一条就会同时出现在第 1 页尾和第 2 页头 ——
     * 不去重的话 Vue 会拿到重复 key，整片网格的复用逻辑当场错乱。
     */
    const seen = new Set(projects.value.map((p) => p.id));
    projects.value = [...projects.value, ...res.data.projects.filter((p) => !seen.has(p.id))];
    socials.value = { ...socials.value, ...res.data.socials };
    listings.value = { ...listings.value, ...res.data.listings };
    droppedCount.value += res.data.droppedCount;
  } else {
    projects.value = res.data.projects;
    socials.value = res.data.socials;
    listings.value = res.data.listings;
    droppedCount.value = res.data.droppedCount;
    // 结果落地才重建网格 —— 入场动画演的必须是**这一页**，不是上一页。
    // 追加时刻意**不** bump: 那会让已经在屏幕上的卡片重演一遍入场。
    renderSeq.value += 1;
  }
  total.value = res.data.total;
  /*
   * ★ **只有服务端分页的视图才准回写 pageSize**（2026-08-01 真机回归）。
   *
   * `listMyProjects` / 「订阅与已装」都是不分页的，它们回执里的 `pageSize` 只是
   * 「这一把拿到了几条」。无条件采纳的后果是：名下只有 1 个项目的作者点一次
   * 「我的项目」，`pageSize` 就被钉成 1；切回「全部」之后每页只剩一个项目，
   * 「加载更多」也一次只加载一个 —— 而且这个坏状态会一直粘着，因为再也没有
   * 任何一次响应会把它改回去。
   */
  if (isServerScope.value && res.data.pageSize > 0) {
    pageSize.value = res.data.pageSize;
  }
  loadedOnce.value = true;
}

/** 「订阅与已装」视图不发请求时用的空页占位 */
function emptyPage(): {
  total: number;
  page: number;
  pageSize: number;
  projects: WorkshopProjectMeta[];
  droppedCount: number;
  socials: Record<string, WorkshopSocialMeta>;
  listings: Record<string, WorkshopListingMeta>;
} {
  return {
    total: 0,
    page: 0,
    pageSize: pageSize.value,
    projects: [],
    droppedCount: 0,
    socials: {},
    listings: {},
  };
}

/**
 * 切视图。三件事都不能省:
 * - **清空结果**再拉。不清的话，从「我的项目」切回「全部」的那一瞬间，屏幕上还挂着
 *   自己那几个未过审的项目，而计数已经变成了全站的 —— 一个自相矛盾的中间态。
 * - `library` **不发请求**，直接用手上已有的（它是纯派生视图）。
 * - 回第 0 页。
 */
function selectScope(next: BrowseScope): void {
  if (scope.value === next) return;
  scope.value = next;
  page.value = 0;
  projects.value = [];
  socials.value = {};
  listings.value = {};
  total.value = 0;
  droppedCount.value = 0;
  failure.value = null;
  loadedOnce.value = false;
  void load().then(() => nextTick(scrollResultsToTop));
}

/** 本地筛选：标签按**主基础标签**比对（与上游 matchProjectBaseTag 同口径） */
function matchesLocalFilters(p: WorkshopProjectMeta): boolean {
  if (activeTag.value && baseTagOf(p.tags) !== activeTag.value) return false;

  const keyword = search.value.trim().toLowerCase();
  if (!keyword) return true;
  return [p.name, p.description, p.authorName, ...p.tags]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .some((v) => v.toLowerCase().includes(keyword));
}

/**
 * 「订阅与已装」的来源 —— 已加载结果里我订阅了的，**并上**本地所有已装项目。
 *
 * ⚠️ 一处上游也有的局限，照实说出来（模板里有一行提示）: 订阅那一半只能从**已经
 * 加载出来的页**里挑，因为上游没有「我订阅的项目」这个接口。翻得越多认得越全。
 * 已装的那一半没有这个问题 —— 它整份都在本地。
 */
const libraryProjects = computed<WorkshopProjectMeta[]>(() => {
  const byId = new Map<string, WorkshopProjectMeta>();
  for (const p of projects.value) {
    if (socialStore.socialOf(p.id, socials.value[p.id])?.userSubscribed === true) byId.set(p.id, p);
  }
  // 已装的一律进来（`WorkshopProject` 是 `WorkshopProjectMeta` 的超集）
  for (const p of props.installed) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
});

/**
 * 「这是我的项目吗」（B4）—— 决定卡片上出不出编辑/隐藏/删除那一排。
 *
 * 用 `listing.authorId` 与登录用户比，**不是**看在哪个视图里: 管理员在「全部」里
 * 也可能看到自己的项目，而「我的项目」视图理论上全是自己的。按数据判而不是按
 * 位置判，两处才不会有一处说错。
 */
function canManage(projectId: string): boolean {
  const me = socialStore.user?.userId;
  if (!me) return false;
  return listings.value[projectId]?.authorId === me;
}

/** 公开 / 隐藏。成功后重拉当前视图 —— 状态变了，屏幕上的徽章要跟着变 */
async function onToggleVisibility(projectId: string): Promise<void> {
  const next = listings.value[projectId]?.visibility === false;
  const res = await setProjectVisibility(projectId, next);
  if (!res.ok) {
    emit('notify', `操作失败：${describeFailure(res.error)}`, 'error');
    return;
  }
  // 写完就把这个项目的缓存丢掉，否则详情那 5 分钟 TTL 会继续端出旧状态
  invalidateWorkshopProject(projectId);
  emit('notify', next ? '项目已公开' : '项目已隐藏', 'success');
  void load(true);
}

/**
 * 删除的二次确认。
 *
 * ★ **不用 `window.confirm`**（曾经用过，2026-08-01 改）: 原生对话框在嵌入式
 * webview / 无头环境里会被**直接自动关掉并返回 false**，于是「删除」表现为
 * 「点了什么都没发生」—— 没有报错、没有请求，最难查的一种坏法。而且原生弹窗
 * 一律是系统样式，与全站主题格格不入。改用应用内模态，与「卸载」那道确认同款。
 */
const pendingDelete = ref<WorkshopProjectMeta | null>(null);
const deleting = ref(false);

function onRemove(projectId: string): void {
  pendingDelete.value =
    projects.value.find((p) => p.id === projectId) ??
    props.installed.find((p) => p.id === projectId) ??
    null;
}

/** 上游是硬删，没有回收站 —— 确认文案里必须说清这一点 */
async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    const res = await deleteProject(target.id);
    if (!res.ok) {
      emit('notify', `删除失败：${describeFailure(res.error)}`, 'error');
      return;
    }
    invalidateWorkshopProject(target.id);
    emit('notify', `「${target.name}」已删除`, 'success');
    // 先从屏幕上拿掉，不等重拉回来 —— 删完还杵在那儿会让人以为没删掉
    projects.value = projects.value.filter((p) => p.id !== target.id);
    void load(true);
  } finally {
    deleting.value = false;
    pendingDelete.value = null;
  }
}

/** 屏幕上真正渲染的那一列 —— `all` 由服务端定好，另两个视图在本地筛 */
const displayProjects = computed<WorkshopProjectMeta[]>(() => {
  if (isServerScope.value) return projects.value;
  const source = scope.value === 'library' ? libraryProjects.value : projects.value;
  return source.filter(matchesLocalFilters);
});

/** 用户按「取消」：掐掉请求并退出忙碌态，屏幕保留上一次的结果 */
function cancelLoad(): void {
  abortInflight();
  loading.value = false;
}

function reloadFromFirstPage(): void {
  page.value = 0;
  void load().then(() => nextTick(scrollResultsToTop));
}

// 搜索词防抖 350ms —— 每敲一个字发一次请求既浪费上游也让结果闪烁。
// 本地视图里筛选不过网，`displayProjects` 会自己重算，一发请求都不必发。
watch(search, () => {
  if (!isServerScope.value) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reloadFromFirstPage();
  }, 350);
});

function selectTag(tag: string): void {
  activeTag.value = activeTag.value === tag ? '' : tag;
  if (!isServerScope.value) return;
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

/** 结果区容器 —— 换查询条件后要把它滚回顶部 */
const resultsEl = ref<HTMLElement | null>(null);

/**
 * 把滚动位置带回结果区顶部。
 *
 * 只在**换查询条件**（搜索/标签/排序）后调 —— 那时屏幕上是一批全新的项目，停在
 * 原来的滚动位置等于从第 12 个开始看。追加时**绝不调**：用户按「加载更多」的意图
 * 就是接着往下看，把他弹回顶部是最气人的一种「贴心」。
 *
 * 滚的是模态自己的滚动容器（`closest`），不是 window。
 */
function scrollResultsToTop(): void {
  const el = resultsEl.value;
  if (!el) return;
  const scroller = el.closest<HTMLElement>('.modal-body') ?? el.parentElement;
  if (!scroller || typeof scroller.scrollTo !== 'function') return;
  // 系统偏好 **或** 应用内开关，判定收在 lib/reduced-motion.ts
  scroller.scrollTo({ top: 0, behavior: scrollBehavior() });
}

/** 追加下一页（对齐上游 `loadMoreProjects`） */
function loadMore(): void {
  if (loading.value || loadingMore.value || !canLoadMore.value) return;
  void load(false, true);
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // 每次打开都拉一次，但**不 force**: 关掉又立刻打开（找错项目、回去看一眼）是常见
      // 动作，45 秒内的这一发本就该命中缓存。要最新的按工具条上的「刷新」。
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
      <!-- ═══ 视图切换（全部 / 我的项目 / 订阅与已装） ═══ -->
      <div class="wk-scopebar" role="group" aria-label="切换视图">
        <button
          v-for="opt in SCOPE_OPTIONS"
          :key="opt.value"
          type="button"
          class="wk-scopechip"
          :class="{ 'chip-active': scope === opt.value }"
          :aria-pressed="scope === opt.value"
          @click="selectScope(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>

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
          v-if="isServerScope"
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
        <!-- 「刷新」是用户表达「我要最新的」的唯一入口 → 唯一一处传 force。
             「订阅与已装」是纯派生视图，没有可刷新的东西，就不摆这个按钮 -->
        <AppButton
          v-else-if="scope !== 'library'"
          variant="secondary"
          size="sm"
          @click="load(true)"
        >
          刷新
        </AppButton>
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
            : loadingMore
              ? '正在加载更多项目…'
              : failure
                ? failureText
                : isServerScope
                  ? `已加载 ${projects.length} 个，共 ${total} 个项目。`
                  : `${displayProjects.length} 个项目。`
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

        <!--
          整块失败态**只在手上一个项目都没有时**出现。追加失败走下方的行内失败条 ——
          把已经翻出来的一屏结果换成一块红色报错，用户会以为自己把列表弄丢了，
          而那份结果其实还好好地在内存里（`已加载 X / Y` 那行就是证据）。
        -->
        <div v-else-if="failure && projects.length === 0" class="wk-failure" role="alert">
          <p class="wk-failure-text">{{ failureText }}</p>
          <p class="wk-failure-detail">{{ failure.message }}</p>
          <AppButton variant="primary" size="sm" @click="load()">重试</AppButton>
          <!--
            ★ 这里曾经有一句「也可以从工坊网页下载 project-xxx.json，回到工坊页用
            『导入本地文件』装上」。**删掉了**（2026-08-01）: 工坊网页上根本没有下载按钮
            （查过上游源码，三个 file input 全是投稿用的上传口，`fa-download` 那个图标是
            「安装」按钮自己的图标）。指着一个不存在的入口，恰好是在用户最急的时候让他
            白找一趟。随后「导入本地文件」这个功能本身也一并删除了 —— 一条没有起点的后路。
          -->
        </div>

        <p v-else-if="displayProjects.length === 0 && loadedOnce" class="empty-tab">
          <template v-if="search.trim() || activeTag">没有符合条件的项目</template>
          <template v-else-if="scope === 'mine'">你还没有投稿过项目</template>
          <template v-else-if="scope === 'library'">还没有订阅或安装任何项目</template>
          <template v-else>工坊里还空着</template>
        </p>

        <!-- :key 让整片网格随查询条件重建 → 卡片重跑入场动画，翻页读起来像换了一页纸 -->
        <div v-else :key="renderSeq" class="wk-grid" :class="{ 'grid-loading': loading }">
          <WorkshopProjectCard
            v-for="p in displayProjects"
            :key="p.id"
            :project="p"
            :state="installedById.get(p.id)?.installState"
            :installed-version="installedById.get(p.id)?.installedVersion"
            :social="socials[p.id]"
            :listing="listings[p.id]"
            :can-manage="canManage(p.id)"
            @open="emit('open', $event)"
            @edit="emit('edit', $event)"
            @remove="onRemove"
            @toggle-visibility="onToggleVisibility"
          />
        </div>

        <!-- 追加失败：结果留在屏幕上，只在末尾补一条可重试的窄条 -->
        <p v-if="failure && projects.length > 0" class="wk-more-failure" role="alert">
          {{ failureText }}
        </p>

        <!-- 加载更多（对齐上游）—— 追加式浏览，不打断已经看到哪儿了 -->
        <div v-if="canLoadMore" class="wk-more">
          <AppButton
            variant="secondary"
            size="sm"
            :disabled="loading || loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? '加载中…' : failure ? '重试' : `加载更多（剩余 ${remaining} 个）` }}
          </AppButton>
        </div>

        <!-- 上游没有「我订阅的项目」接口，订阅那一半只能从已加载的页里认（照实说） -->
        <p v-if="scope === 'library'" class="wk-scope-note">
          已安装的项目全在这里；订阅的项目只能从「全部」里已经加载出来的那些认出来。
        </p>

        <p v-if="droppedCount > 0" class="wk-dropped-note">
          上游有 {{ droppedCount }} 个项目缺少 id，已跳过它们。
        </p>
      </div>
    </div>

    <template #footer>
      <div class="wk-pager">
        <span class="wk-pager-info">
          <template v-if="!isServerScope">{{ displayProjects.length }} 个项目</template>
          <template v-else-if="loadedOnce">
            已加载 {{ projects.length }} / {{ total }} 个项目
          </template>
          <template v-else>共 {{ total }} 个项目</template>
        </span>
      </div>
    </template>
  </AppModal>

  <!-- 删除确认（应用内，不用原生 confirm —— 见 onRemove 上方注释） -->
  <AppModal
    :open="pendingDelete !== null"
    title="删除工坊项目"
    size="sm"
    @update:open="deleting ? undefined : (pendingDelete = null)"
  >
    <p class="wk-del-text">
      删除「<strong>{{ pendingDelete?.name }}</strong
      >」？<br />
      工坊没有回收站，删掉之后连同已上传的文件一并消失，找不回来。
    </p>
    <template #footer>
      <AppButton variant="ghost" size="sm" :disabled="deleting" @click="pendingDelete = null">
        取消
      </AppButton>
      <AppButton variant="danger" size="sm" :loading="deleting" @click="confirmDelete">
        {{ deleting ? '删除中…' : '删除' }}
      </AppButton>
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

/* ── 视图切换条 ── */
.wk-scopebar {
  display: flex;
  gap: var(--theme-spacing-xs);
}
.wk-scopechip {
  padding: 5px 12px;
  min-height: 28px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.wk-scopechip:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.wk-scope-note {
  margin: var(--theme-spacing-md) 0 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
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

/* 追加失败的窄条 —— 不抢眼，因为屏幕上的结果仍然是有效的 */
.wk-more-failure {
  margin: var(--theme-spacing-lg) 0 0;
  text-align: center;
  font-size: 0.75rem;
  color: var(--theme-error);
}

/* 加载更多 —— 居中一枚，与网格留出一段呼吸 */
.wk-more {
  display: flex;
  justify-content: center;
  margin-top: var(--theme-spacing-lg);
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

.wk-del-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.8;
  color: var(--theme-text-primary);
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
  .wk-scopechip,
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
