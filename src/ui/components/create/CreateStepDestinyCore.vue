<script setup lang="ts">
import { useNsfwText } from '../../composables/useNsfwText';
import { computed, nextTick, ref } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import WorkshopEnableList from '../shared/WorkshopEnableList.vue';
import AppButton from '../shared/AppButton.vue';
const nsfw = useNsfwText();

const store = useCreateStore();

/** 展开/折叠的条目 uid */
const expandedUid = ref<string | null>(null);

function toggleExpand(uid: string) {
  expandedUid.value = expandedUid.value === uid ? null : uid;
}

// ── C-19：命定核心单选组的键盘可达性（radiogroup + roving tabindex） ──
const groupEl = ref<HTMLElement | null>(null);

const builtinKey = (uid: string) => `b:${uid}`;
const workshopKey = (projectId: string) => `w:${projectId}`;

/** 组内全部候选，顺序与渲染顺序一致（内置在前、工坊在后） */
const radioKeys = computed(() => [
  ...store.systemCoreEntries.map((e) => builtinKey(e.uid)),
  ...store.workshopSystemOptions.map((o) => workshopKey(o.projectId)),
]);

/** 当前选中项的 key；没有选中时为 null */
const checkedKey = computed<string | null>(() => {
  if (store.selectedSystemCoreEntryUid !== null) {
    return builtinKey(store.selectedSystemCoreEntryUid);
  }
  if (store.selectedWorkshopCoreProjectId !== null) {
    return workshopKey(store.selectedWorkshopCoreProjectId);
  }
  return null;
});

/** roving tabindex：选中项（或无选中时的第一项）可 Tab 进入，其余为 -1 */
function tabIndexFor(key: string): number {
  const keys = radioKeys.value;
  const anchor = checkedKey.value && keys.includes(checkedKey.value) ? checkedKey.value : keys[0];
  return key === anchor ? 0 : -1;
}

function selectByKey(key: string) {
  if (key.startsWith('b:')) store.selectSystemCoreEntry(key.slice(2));
  else store.selectWorkshopCore(key.slice(2));
}

function focusKey(key: string) {
  const rows = groupEl.value?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [];
  for (const row of Array.from(rows)) {
    if (row.dataset.coreKey === key) {
      row.focus();
      return;
    }
  }
}

/** 回车/空格选中；方向键按 WAI-ARIA radio 模式在组内移动并选中（首尾循环） */
function onRadioKeydown(event: KeyboardEvent, key: string) {
  // 行内的展开按钮自己处理按键，不当作选择
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectByKey(key);
    return;
  }
  const keys = radioKeys.value;
  const index = keys.indexOf(key);
  if (index < 0 || keys.length === 0) return;
  let next: number | null = null;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % keys.length;
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    next = (index - 1 + keys.length) % keys.length;
  } else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = keys.length - 1;
  if (next === null) return;
  event.preventDefault();
  const target = keys[next];
  selectByKey(target);
  void nextTick(() => focusKey(target));
}

/** 提取条目内容的纯文本摘要（去掉 HTML/EJS 标签） */
function summary(content: string, maxLen = 200): string {
  // 先按露骨内容开关过滤：下面那步剥 HTML 标签会把 <nsfw> 标记剥掉、留下被包裹的内容
  const cleaned = nsfw(content)
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
</script>

<template>
  <section class="step-core">
    <h2 class="step-title">命定核心与工坊内容</h2>
    <p class="step-desc">
      <b>命定核心</b>只能选一枚 —— 内置的与工坊标了「系统」的项目在同一份名单里挑。
      其余<b>工坊项目</b>是附加内容，可以勾多个。
    </p>

    <!-- ═══ 轴一：命定核心（单选） ═══ -->
    <div class="axis">
      <h3 class="axis-label">
        <span class="axis-name">一 · 命定核心</span>
        <span class="axis-badge badge-single">{{
          store.coreRequired ? '单选 · 必选' : '单选 · 可跳过'
        }}</span>
      </h3>
      <p class="axis-desc">
        命定之灵是寄宿于你灵魂中的存在，它将伴随整个命运之旅，影响叙事风格和特殊机制。请慎重选择。
      </p>

      <!-- 名单加载三态：加载中 / 失败可重试 / 成功但内容未提供任何核心（豁免必选） -->
      <div
        v-if="store.coreCatalogStatus === 'idle' || store.coreCatalogStatus === 'loading'"
        class="core-loading"
        role="status"
      >
        正在加载命定核心列表…
      </div>
      <div v-else-if="store.coreCatalogStatus === 'failed'" class="core-loading core-failed">
        <p role="alert">命定核心列表加载失败，暂时无法选择。</p>
        <AppButton variant="secondary" size="sm" @click="store.loadWorldBookEntries()">
          重试
        </AppButton>
      </div>
      <div v-else-if="store.coreCandidateCount === 0" class="core-loading core-empty">
        当前内容包未提供命定核心，可直接进入下一步。
      </div>

      <!-- 选中条目的详情卡片 -->
      <div v-if="store.selectedSystemCoreEntry" class="selected-detail">
        <div class="sd-header">
          <span class="sd-dot" />
          <h3>{{ store.selectedSystemCoreEntry.name }}</h3>
          <button
            class="sd-deselect"
            title="取消选择"
            @click="store.selectSystemCoreEntry(null as any)"
          >
            ✕
          </button>
        </div>
        <div class="sd-desc">{{ summary(store.selectedSystemCoreEntry.content, 500) }}</div>
      </div>

      <!-- 紧凑单选列表（始终显示所有条目） -->
      <!-- C-19：可聚焦的是 role="radio" 行本身，点击/回车/空格都挂在它上面；
           整个名单是一个 radiogroup（内置与工坊核心共用一个单选槽），方向键在组内移动，
           roving tabindex 保证 Tab 只停在一行上。 -->
      <div ref="groupEl" class="core-list" role="radiogroup" aria-label="命定核心">
        <div
          v-for="entry in store.systemCoreEntries"
          :key="entry.uid"
          class="core-row"
          :class="{ selected: store.selectedSystemCoreEntryUid === entry.uid }"
          role="radio"
          :aria-checked="store.selectedSystemCoreEntryUid === entry.uid ? 'true' : 'false'"
          :tabindex="tabIndexFor(builtinKey(entry.uid))"
          :data-core-key="builtinKey(entry.uid)"
          @click="store.selectSystemCoreEntry(entry.uid)"
          @keydown="onRadioKeydown($event, builtinKey(entry.uid))"
        >
          <!-- 行主体：点击即选中（事件挂在外层 radio 上） -->
          <div class="core-row-body">
            <span
              class="core-radio"
              :class="{ checked: store.selectedSystemCoreEntryUid === entry.uid }"
            />
            <span class="core-name">{{ entry.name }}</span>
          </div>

          <!-- 展开/折叠按钮 -->
          <button
            class="core-chevron"
            :class="{ expanded: expandedUid === entry.uid }"
            aria-label="展开内容预览"
            type="button"
            @click.stop="toggleExpand(entry.uid)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M4 2l4 4-4 4"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <!-- 可展开的内容预览 -->
          <div class="core-preview" :class="{ open: expandedUid === entry.uid }">
            <div class="core-preview-inner">
              {{ summary(entry.content, 400) }}
            </div>
          </div>
        </div>

        <!-- ═══ 工坊命定核心：与内置的**同一份名单、同一个单选槽** ═══
             标了「系统」的工坊项目就是命定核心候选，不是附加内容。它们此前混在下方
             多选区里，于是选中一个既过不了本步的必选闸门（按钮永远不亮），语义上
             也说不通 —— 两个命定核心同时生效，设定直接打架。 -->
        <div
          v-for="opt in store.workshopSystemOptions"
          :key="opt.projectId"
          class="core-row core-row-workshop"
          :class="{ selected: store.selectedWorkshopCoreProjectId === opt.projectId }"
          role="radio"
          :aria-checked="store.selectedWorkshopCoreProjectId === opt.projectId ? 'true' : 'false'"
          :tabindex="tabIndexFor(workshopKey(opt.projectId))"
          :data-core-key="workshopKey(opt.projectId)"
          @click="store.selectWorkshopCore(opt.projectId)"
          @keydown="onRadioKeydown($event, workshopKey(opt.projectId))"
        >
          <div class="core-row-body">
            <span
              class="core-radio"
              :class="{ checked: store.selectedWorkshopCoreProjectId === opt.projectId }"
            />
            <span class="core-name">{{ opt.name }}</span>
            <span class="core-src">工坊 · {{ opt.authorName || '佚名' }}</span>
          </div>
          <div class="core-preview open">
            <div class="core-preview-inner">
              {{ opt.description || '作者未填写简介。' }}
              <span v-if="opt.entryUids.length === 0" class="core-warn">
                （这个项目没有世界书条目 —— 选它不会带来任何设定内容）
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 轴二：工坊项目（多选，D10/D12） ═══
         刻意与命定核心同屏并列：一个工坊项目是 N 条条目，塞不进单个 uid 的单选槽；
         项目可能自带自己的命定核心，与上方内置单选撞车 —— 不做冲突拦截（tags 是
         上游自由文本，猜必误伤），而是把两边摆在同一屏，由用户对照标签与简介判断。 -->
    <div class="axis">
      <h3 class="axis-label">
        <span class="axis-name">二 · 工坊项目</span>
        <span class="axis-badge badge-multi">多选 · 可选</span>
      </h3>
      <p class="axis-desc">
        来自创意工坊的社区内容，勾选后其全部世界书条目随本存档启用。 标了「系统」的项目不在这里 ——
        它们是命定核心候选，已并入上方单选名单。
      </p>
      <WorkshopEnableList
        :options="store.workshopExtraOptions"
        :selected="store.enabledWorkshopProjectIds"
        empty-text="没有可作为附加内容的工坊项目 —— 可在首页「扩展管理 → 创意工坊」中安装"
        @toggle="store.toggleWorkshopProject"
      />
    </div>
  </section>
</template>

<style scoped>
.step-core {
  max-width: 800px;
  margin: 0 auto;
}

.step-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  margin-bottom: var(--theme-spacing-xs);
}

.step-desc {
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  line-height: 1.6;
  margin-bottom: var(--theme-spacing-lg);
}
.step-desc b {
  color: var(--theme-text-primary);
  font-weight: 700;
}

/* ── 两条并列的轴（命定核心单选 / 工坊项目多选） ── */
.axis + .axis {
  margin-top: var(--theme-spacing-xl);
  padding-top: var(--theme-spacing-lg);
  border-top: 1px solid var(--theme-card-border);
}

/* Section 标题装饰线 — design.md §5.1 */
.axis-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0 0 var(--theme-spacing-xs);
  font-family: var(--theme-font-title, serif);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.axis-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.axis-name {
  flex-shrink: 0;
}
.axis-badge {
  flex-shrink: 0;
  padding: 1px var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  font-family: var(--theme-font-body, sans-serif);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.6;
  letter-spacing: 0.02em;
}
/* 单选 / 多选用两种颜色区分，避免误以为是同一条轴 */
.badge-single {
  color: var(--theme-quality-epic);
  border-color: color-mix(in srgb, var(--theme-quality-epic) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-quality-epic) 8%, var(--theme-card-bg));
}
.badge-multi {
  color: var(--theme-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}

.axis-desc {
  color: var(--theme-text-secondary);
  font-size: 0.8rem;
  line-height: 1.5;
  margin: 0 0 var(--theme-spacing-md);
}

.core-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}
.core-failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.core-failed p {
  margin: 0;
  color: var(--theme-error);
}

/* ── 详情卡片 ── */
.selected-detail {
  margin-bottom: var(--theme-spacing-lg);
  padding: var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-quality-epic) 6%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-quality-epic) 45%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.sd-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xs);
}
.sd-dot {
  width: var(--theme-spacing-sm);
  height: var(--theme-spacing-sm);
  border-radius: 50%;
  background: var(--theme-quality-epic);
  flex-shrink: 0;
}
.sd-header h3 {
  color: var(--theme-quality-epic);
  margin: 0;
  font-size: 0.95rem;
  flex: 1;
}
.sd-deselect {
  background: none;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.75rem;
  transition:
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.sd-deselect:hover {
  color: var(--theme-text-primary);
  border-color: var(--theme-text-muted);
}
.sd-desc {
  font-size: 0.8rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
  margin: var(--theme-spacing-xs) 0 0;
}

/* ── 列表容器 ── */
/* 工坊来源的核心行：同一份名单，但标明出处 —— 社区内容与内置内容信任域不同 */
.core-row-workshop .core-src {
  margin-left: auto;
  padding-left: var(--theme-spacing-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
}
.core-warn {
  color: var(--theme-warning);
}

.core-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

/* ── 单行 ── */
.core-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: border-color 0.2s ease;
}
.core-row:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.core-row:hover {
  border-color: var(--theme-text-muted);
}
.core-row.selected {
  border-color: var(--theme-quality-epic);
  box-shadow: 0 0 0 1px var(--theme-quality-epic);
}

/* ── 行主体（radio + name） ── */
.core-row-body {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  min-width: 0;
  cursor: pointer;
  padding: var(--theme-spacing-xs) 0;
}

/* ── 自定义 radio 圆圈 ── */
.core-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--theme-text-muted);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}
.core-radio.checked {
  border-color: var(--theme-quality-epic);
  background-color: var(--theme-quality-epic);
}
.core-radio.checked::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--theme-card-bg);
}

.core-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, serif);
}

/* ── 展开/折叠按钮 ── */
.core-chevron {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--theme-spacing-xs);
  color: var(--theme-text-muted);
  transition:
    transform 0.2s ease,
    color 0.2s ease;
  margin-top: 2px;
}
.core-chevron:hover {
  color: var(--theme-text-primary);
}
.core-chevron.expanded {
  transform: rotate(90deg);
}

/* ── 可展开预览（grid-rows 展开，不动 max-height） ── */
.core-preview {
  width: 100%;
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.core-preview.open {
  grid-template-rows: 1fr;
}
.core-preview-inner {
  overflow: hidden;
  min-height: 0;
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  line-height: 1.6;
}
.core-preview.open .core-preview-inner {
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
@media (prefers-reduced-motion: reduce) {
  .core-preview {
    transition: none;
  }
}
</style>
