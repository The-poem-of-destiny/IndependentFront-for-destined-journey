<script setup lang="ts">
/**
 * ② 素材库 —— 两个视图，一份数据源（§7.3）
 *
 *   **按角色**  `groups`（按原始 `name` 严格分组，不归一化）。每组显示缩略图、
 *               名字、**变体数** —— 变体数是「永不覆盖」那条政策的成本可见化
 *               （D11）: 不显示的话，同一个角色下慢慢堆出的 `_2`/`_3` 谁都看不见。
 *   **全部素材** 平铺全库，**含名字匹配不到任何角色的行**（`IMG_20240101.png`
 *               这种会入库、匹配不到、也不渲染 —— 它必须在某个地方看得见才能被删掉）。
 *
 * 刻意没有的东西: **角色名册**。整个管理器只读 `assetMeta`，从不去问存档或角色表
 * （D3），所以「库是空的」与「还没有角色」不再是两种要区分的状态 —— 空态只有一种。
 *
 * object URL 的规矩（§7.5）: 缩略图 URL 由 store 的 LRU 铸造，本组件在卸载时调一次
 * `revokeAllUrls()`。**绝不持久化 URL** —— 要存就存逻辑键，渲染时再解析。
 */
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { ASSET_TYPES, type AssetMetaRecord, type AssetType } from '@engine/types';
import { isVideoExtension } from '@engine/asset-types';
import { useAssetStore, type AssetGroup } from '../../../stores/asset-store';
import AppButton from '../../shared/AppButton.vue';
import AssetCharacterDrawer from './AssetCharacterDrawer.vue';
import { assetDialogsKey } from './dialogs';
import { useAssetThumbs } from './thumbs';
import { fmtBytes } from '../audio/format';

const emit = defineEmits<{
  /** 一次性事件的无障碍播报，由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void;
}>();

const assets = useAssetStore();
const dialogs = inject(assetDialogsKey)!;

type View = 'group' | 'flat';
const view = ref<View>('group');
const search = ref('');
const typeFilter = ref<'all' | AssetType>('all');

/** 打开的分组名（null = 抽屉关着）。抽屉本体挂在这里，因为点击源在这里 */
const openGroupName = ref<string | null>(null);

// ═══ 筛选 ═════════════════════════════════════════════════

function matchesSearch(name: string): boolean {
  const q = search.value.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

const filteredGroups = computed<AssetGroup[]>(() =>
  assets.groups.filter((g) => {
    if (!matchesSearch(g.name)) return false;
    if (typeFilter.value !== 'all' && !g.rows.some((r) => r.type === typeFilter.value))
      return false;
    return true;
  }),
);

const filteredRows = computed<AssetMetaRecord[]>(() =>
  assets.flat.filter((r) => {
    if (typeFilter.value !== 'all' && r.type !== typeFilter.value) return false;
    // 变体也参与搜索：想找「苏婉 微笑」时不该被迫先记住它属于哪个名字
    return matchesSearch(r.name) || matchesSearch(r.variant ?? '');
  }),
);

/** 分组卡的封面: 优先 头像 主图，其次组里第一行（顺序由 store 定好） */
function coverRow(g: AssetGroup): AssetMetaRecord {
  return g.rows.find((r) => r.type === '头像' && !r.variant) ?? g.rows[0];
}

/**
 * 当前**可见**的行 —— 缩略图只给这批装载。
 * 两个视图各自的可见集合合并成一份，视图一切换旧的那批就被对账剪掉。
 */
const visibleRows = computed<AssetMetaRecord[]>(() =>
  view.value === 'group' ? filteredGroups.value.map(coverRow).filter(Boolean) : filteredRows.value,
);

const { thumbFor } = useAssetThumbs(() => visibleRows.value);

onUnmounted(() => {
  // 网格一屏就要挂几十个 object URL，不撤销就是泄漏（§7.5）
  assets.revokeAllUrls();
});

// ═══ 多选 + 批量删除（只在「全部素材」视图）══════════════
// 选中集合按 id 存，跨筛选保留 —— 换个筛选条件不该把已选的东西悄悄丢掉。
// 但「全选」只作用于**当前筛选结果**，所以勾选框旁边写死了筛选后的条数。
// 整套交互（含 shift 区间与 syncBox 的受控闭环）对齐音频曲库的既有实现。

const selectedIds = ref<Set<string>>(new Set());
/** shift 区间选择的锚点（上一次点过的行） */
const anchorId = ref('');

function isSelected(row: AssetMetaRecord): boolean {
  return selectedIds.value.has(row.id);
}

const selectedRows = computed(() => assets.flat.filter((r) => selectedIds.value.has(r.id)));
const selectedCount = computed(() => selectedRows.value.length);
/** 选中项里有几个是主图 —— 删主图不会自动提拔变体，确认文案得说清楚 */
const selectedBaseCount = computed(() => selectedRows.value.filter((r) => !r.variant).length);

const allFilteredSelected = computed(
  () =>
    filteredRows.value.length > 0 && filteredRows.value.every((r) => selectedIds.value.has(r.id)),
);
const someFilteredSelected = computed(
  () => !allFilteredSelected.value && filteredRows.value.some((r) => selectedIds.value.has(r.id)),
);

/**
 * 勾选框的受控闭环（照搬音频曲库那条真机踩坑结论）。
 *
 * 别用 `@click.prevent` 让浏览器把勾「回滚」掉 —— 浏览器先翻转 checked → 调监听器
 * → 微任务检查点让 Vue 打完 DOM 补丁 → 浏览器这才执行「取消激活恢复」把勾抹回去。
 * 结果是集合、计数、染底全对，唯独那一行的勾永远打不上。所以放手让它翻转，
 * 由处理函数在同一帧把 DOM 写回集合的真值。
 */
function syncBox(target: EventTarget | null, checked: boolean, indeterminate = false): void {
  const el = target as HTMLInputElement | null;
  if (!el) return;
  el.checked = checked;
  el.indeterminate = indeterminate;
}

function onRowSelect(row: AssetMetaRecord, e: MouseEvent): void {
  const next = new Set(selectedIds.value);
  const list = filteredRows.value;
  const to = list.findIndex((x) => x.id === row.id);
  const from = anchorId.value ? list.findIndex((x) => x.id === anchorId.value) : -1;
  if (e.shiftKey && from >= 0 && to >= 0) {
    // 区间只加不减，这是列表多选的通用预期
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let i = a; i <= b; i += 1) next.add(list[i].id);
  } else if (next.has(row.id)) {
    next.delete(row.id);
  } else {
    next.add(row.id);
  }
  anchorId.value = row.id;
  selectedIds.value = next;
  syncBox(e.target, next.has(row.id));
}

/** 全选/取消全选 —— **只作用于当前筛选结果** */
function toggleSelectAllFiltered(e: MouseEvent): void {
  const next = new Set(selectedIds.value);
  const all = allFilteredSelected.value;
  for (const row of filteredRows.value) {
    if (all) next.delete(row.id);
    else next.add(row.id);
  }
  anchorId.value = '';
  selectedIds.value = next;
  // 全选框还有 indeterminate：浏览器在点击时会清掉它，同样得写回真值
  syncBox(e.target, allFilteredSelected.value, someFilteredSelected.value);
}

function clearSelection(): void {
  selectedIds.value = new Set();
  anchorId.value = '';
}

// 素材被删掉（这里删的、抽屉里删的都算）之后不能留下悬空的选中 id，
// 否则「已选 N 项」会一直虚报，批量删除也会对着不存在的行发号施令。
watch(
  () => assets.assets,
  (list) => {
    if (selectedIds.value.size === 0) return;
    const alive = new Set(list.map((r) => r.id));
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)));
    if (next.size !== selectedIds.value.size) selectedIds.value = next;
  },
);

async function batchDelete(): Promise<void> {
  const rows = selectedRows.value;
  if (rows.length === 0) return;
  const lines = [`删除选中的 ${rows.length} 条素材？此操作不可撤销。`];
  if (selectedBaseCount.value > 0) {
    lines.push(
      `其中 ${selectedBaseCount.value} 条是主图。删除主图不会自动提拔其他变体，对应的类型会显示为「无主图」，需要手动重新指定。`,
    );
  }
  const ok = await dialogs.askConfirm({
    title: '批量删除素材',
    message: lines.join('\n'),
    confirmLabel: `删除 ${rows.length} 条`,
    danger: true,
  });
  if (!ok) return;
  // 汇总提示由 store 负责（尽力做完模式），这里只清选择并补一次播报
  const res = await assets.deleteAssets(rows.map((r) => r.id));
  clearSelection();
  emit(
    'announce',
    res.failed > 0
      ? `已删除 ${res.ok} 条素材，${res.failed} 条未能删除。`
      : `已删除 ${res.ok} 条素材。`,
  );
}

// ═══ 抽屉 ═════════════════════════════════════════════════

function openGroup(g: AssetGroup): void {
  openGroupName.value = g.name;
}

function onGroupKey(g: AssetGroup, e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openGroup(g);
  }
}
</script>

<template>
  <div class="library-head">
    <h4 class="band-title">素材库</h4>
    <span class="usage-text"
      >共 {{ assets.assets.length }} 条 · {{ assets.groups.length }} 个名字</span
    >
  </div>

  <!-- 视图切换：分段按钮式 Tab（design.md §4.3 主类别切换） -->
  <div class="view-tabs" role="tablist" aria-label="素材视图">
    <button
      class="view-tab"
      :class="{ 'view-tab-on': view === 'group' }"
      role="tab"
      :aria-selected="view === 'group'"
      @click="view = 'group'"
    >
      按角色
    </button>
    <button
      class="view-tab"
      :class="{ 'view-tab-on': view === 'flat' }"
      role="tab"
      :aria-selected="view === 'flat'"
      @click="view = 'flat'"
    >
      全部素材
    </button>
  </div>

  <!-- 工具条 -->
  <div class="lib-toolbar">
    <input
      v-model="search"
      class="mini-input"
      type="search"
      placeholder="搜索名字或变体…"
      aria-label="搜索素材"
    />
    <select v-model="typeFilter" class="mini-select" aria-label="按类型过滤">
      <option value="all">全部类型</option>
      <option v-for="t in ASSET_TYPES" :key="t" :value="t">{{ t }}</option>
    </select>
  </div>

  <!-- 批量操作条：只在「全部素材」视图（按角色视图选的是组，不是行） -->
  <div v-if="view === 'flat'" class="batch-bar" role="group" aria-label="批量操作">
    <label class="batch-all">
      <input
        type="checkbox"
        class="batch-all-box"
        :checked="allFilteredSelected"
        :indeterminate="someFilteredSelected"
        :disabled="filteredRows.length === 0"
        @click="toggleSelectAllFiltered"
      />
      <span>全选当前筛选结果（{{ filteredRows.length }} 条）</span>
    </label>
    <span class="batch-count">已选 {{ selectedCount }} 条</span>
    <AppButton variant="danger" size="sm" :disabled="selectedCount === 0" @click="batchDelete">
      删除选中
    </AppButton>
    <span v-if="selectedBaseCount > 0" class="batch-hint">
      其中 {{ selectedBaseCount }} 条是主图，删后对应类型会变成「无主图」
    </span>
  </div>

  <!-- 空态：库整个空着，就把命名约定和导入入口一次说清（§8） -->
  <div v-if="assets.loading" class="empty-tab">正在翻检素材库…</div>
  <div v-else-if="assets.assets.length === 0" class="empty-tab">
    素材库尚空 —— 用上方的「导入素材包」放一个 .zip 进来。<br />
    包里的文件按 <code class="conv-code">名字_类型_变体.png</code> 命名即可，例如
    <code class="conv-code">苏婉_头像.png</code>（类型可省略，默认「头像」）。
  </div>

  <!-- ═══ 按角色 ═══ -->
  <template v-else-if="view === 'group'">
    <div v-if="filteredGroups.length === 0" class="empty-tab">没有符合条件的角色…</div>
    <div v-else class="group-grid">
      <div
        v-for="g in filteredGroups"
        :key="g.name"
        class="group-card"
        role="button"
        tabindex="0"
        :aria-label="`查看「${g.name}」的 ${g.total} 条素材`"
        @click="openGroup(g)"
        @keydown="onGroupKey(g, $event)"
      >
        <span class="thumb thumb-lg">
          <video
            v-if="isVideoExtension(coverRow(g).ext) && thumbFor(coverRow(g).id)"
            class="thumb-media"
            :src="thumbFor(coverRow(g).id) ?? undefined"
            muted
            playsinline
            preload="metadata"
          />
          <img
            v-else-if="thumbFor(coverRow(g).id)"
            class="thumb-media"
            :src="thumbFor(coverRow(g).id) ?? undefined"
            :alt="`${g.name} 的封面素材`"
          />
          <span v-else class="thumb-blank" role="img" aria-label="预览不可用">—</span>
        </span>
        <span class="group-name">{{ g.name }}</span>
        <span class="group-meta">
          {{ g.total }} 项
          <template v-if="g.variantCount > 0"> · {{ g.variantCount }} 变体</template>
        </span>
        <span v-if="g.baselessTypes.length > 0" class="baseless-badge">无主图</span>
      </div>
    </div>
  </template>

  <!-- ═══ 全部素材 ═══ -->
  <template v-else>
    <div v-if="filteredRows.length === 0" class="empty-tab">没有符合条件的素材…</div>
    <div
      v-for="row in filteredRows"
      :key="row.id"
      class="asset-row"
      :class="{ 'row-selected': isSelected(row) }"
    >
      <!-- 勾选：撑到 36px 触摸目标；选中态不只靠底色，勾选框本身就是形状指示 -->
      <label class="check-cell">
        <input
          type="checkbox"
          class="row-check"
          :checked="isSelected(row)"
          :aria-label="`选择「${row.name}」的${row.type}${row.variant ? ' ' + row.variant : '主图'}`"
          @click="onRowSelect(row, $event)"
        />
      </label>
      <span class="thumb">
        <video
          v-if="isVideoExtension(row.ext) && thumbFor(row.id)"
          class="thumb-media"
          :src="thumbFor(row.id) ?? undefined"
          muted
          playsinline
          preload="metadata"
        />
        <img
          v-else-if="thumbFor(row.id)"
          class="thumb-media"
          :src="thumbFor(row.id) ?? undefined"
          :alt="`${row.name} ${row.type}`"
        />
        <span v-else class="thumb-blank" role="img" aria-label="预览不可用">—</span>
      </span>
      <span class="row-name">{{ row.name }}</span>
      <span class="type-chip">{{ row.type }}</span>
      <span v-if="row.variant" class="variant-chip">{{ row.variant }}</span>
      <span v-else class="base-badge">主图</span>
      <span class="row-meta">{{ row.ext.toUpperCase() }}</span>
      <span class="row-meta">{{ fmtBytes(row.bytes) }}</span>
      <AppButton variant="secondary" size="sm" @click="openGroupName = row.name">管理</AppButton>
    </div>
  </template>

  <!-- 角色抽屉：改名 / 设为主图 / 删除都在里面 -->
  <AssetCharacterDrawer
    :name="openGroupName"
    @close="openGroupName = null"
    @announce="emit('announce', $event)"
  />
</template>

<style scoped>
/* ═══ 分段标题 + 装饰线 ═══ */
.library-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.band-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.band-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.usage-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ═══ 视图切换：分段按钮式 Tab ═══ */
.view-tabs {
  display: inline-flex;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-xs);
  margin: var(--theme-spacing-md) 0;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
.view-tab {
  min-height: 36px;
  padding: 0 var(--theme-spacing-md);
  background: transparent;
  border: none;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  cursor: pointer;
  /* 颜色过渡而已，不动布局属性 */
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.view-tab:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.view-tab-on {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-weight: 600;
  box-shadow: var(--theme-shadow-sm);
}
.view-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 工具条 ═══ */
.lib-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-md);
}
.mini-input,
.mini-select {
  height: 36px;
  padding: 0 var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
}
.mini-input {
  min-width: 9rem;
  flex: 1;
}
.mini-input:focus,
.mini-select:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 批量操作条 ═══ */
.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.batch-all {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  cursor: pointer;
}
.batch-count {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  font-variant-numeric: tabular-nums;
}
.batch-hint {
  flex: 1;
  min-width: 10rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}
.check-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  cursor: pointer;
}
.row-check,
.batch-all-box {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--theme-primary);
}
.row-check:focus-visible,
.batch-all-box:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 空态 ═══ */
/* 空态样式在 styles/utilities.css（全站唯一一份 `.empty-tab`，design.md §5.2）——
 * 本组件原先自带一份拷贝，三份之间已经开始漂移（padding xl vs 2xl / 多一条 line-height）。 */
.conv-code {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.75rem;
  font-style: normal;
  color: var(--theme-text-secondary);
}

/* ═══ 按角色：分组卡 ═══ */
.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: var(--theme-spacing-md);
}
.group-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  cursor: pointer;
  /* hover 只换颜色，不做 scale / 位移（design.md §4.1） */
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.group-card:hover {
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.group-card:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 1px var(--theme-primary),
    var(--paper-stack);
}
.group-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.group-meta {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ═══ 全部素材：行 ═══ */
.asset-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) 0;
  border-bottom: 1px solid var(--theme-card-border);
}
.asset-row:last-child {
  border-bottom: none;
}
/* 无过渡与动画，prefers-reduced-motion 下无需额外处理 */
.row-selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
}
.row-name {
  flex: 1;
  min-width: 8rem;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 3rem;
  text-align: right;
}

/* ═══ 缩略图 ═══ */
.thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
}
.thumb-lg {
  width: 100%;
  height: 6rem;
  border-radius: var(--theme-radius-sm);
}
.thumb-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-blank {
  font-size: 0.875rem;
  color: var(--theme-text-muted);
  opacity: 0.5;
}

/* ═══ 徽章（纵向 1px 沿用音频曲库 .tag-chip 的既有取舍） ═══ */
.type-chip,
.variant-chip,
.base-badge,
.baseless-badge {
  font-size: 0.6875rem;
  padding: 1px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-full);
}
.type-chip {
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
}
.variant-chip,
.base-badge {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  color: var(--theme-primary);
}
.baseless-badge {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
}

@media (prefers-reduced-motion: reduce) {
  .view-tab,
  .group-card {
    transition: none;
  }
}
</style>
