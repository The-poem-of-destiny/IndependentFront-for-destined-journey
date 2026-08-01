<script setup lang="ts">
/**
 * 项目详情 —— 安装决策就在这一屏做完（Phase 1 / P1-4）
 *
 * ★ **这一屏的存在理由是 D12**：我们**不做**命定核心冲突拦截（tags 是上游自由文本，
 * 没有可靠机器信号，猜必误伤），改为把判断依据完整摊开 —— 标签、完整简介、条目数、
 * 正则数、体积、作者、版本。用户看完自己决定。任何把这些藏进折叠区的改动都是在
 * 悄悄推翻 D12 的前提。
 *
 * 社交面（P3c）: 底栏放大版的点赞/订阅 + 三个计数，值来自**同一份详情响应**的
 * `social`（零额外请求）。动作与状态封在 `WorkshopSocialActions` 里，与卡片同源。
 * 投稿/管理面仍不做。
 *
 * 数据来源分工（P1-2 实测，最容易搞错的一处）:
 * - **正则条目** ← 详情响应的 `regexEntriesPreview`（名字里写着 Preview，实测是完整的）
 * - **世界书条目** ← 安装时才下载的载荷；详情里的 `worldbookEntriesPreview` 只够拿来
 *   **估个数**。所以这里的条目数标着「预览」二字 —— 不许说成确数去骗用户。
 *
 * 安装动作不在本组件里执行: 只 emit，由 WorkshopPage 统一走 store 的两段式提交
 * （冲突要先弹警告，D15）。组件里各写一条安装路径 = 各写一条绕过警告的路径。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkshopProject } from '@engine/types';
import { groupWorkshopNotes } from '@engine/workshop-types';
import { mapWorkshopRegexes } from '@engine/workshop-regex-map';
import { fetchProject } from '../../lib/workshop-client';
import type { WorkshopFailure, WorkshopProjectDetail } from '../../lib/workshop-client';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import WorkshopSocialActions from './WorkshopSocialActions.vue';
import {
  describeEntryPosition,
  describeSelectiveLogic,
  formatBytes,
  formatDate,
  formatVersion,
  truncate,
  WORKSHOP_NOTE_LABEL,
} from './format';
import { describeFailure } from './failure-text';

const props = defineProps<{
  open: boolean;
  projectId: string;
  /** 本地已装记录；未装则不传 */
  installed?: WorkshopProject;
  /** 父组件正在为这个项目跑安装/卸载 —— 按钮据此禁用 */
  busy?: boolean;
  /**
   * 跑的是哪个动作。缺省空串 → 忙碌时只禁用不转圈（与加这个 prop 之前一致）。
   *
   * 有它才能避免「卸载时装按钮在转圈」：`busy` 只按项目 id 判定，动作是什么它不知道。
   */
  busyAction?: '' | 'install' | 'update' | 'check' | 'uninstall';
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  install: [projectId: string];
  uninstall: [projectId: string];
}>();

const detail = ref<WorkshopProjectDetail | null>(null);
const loading = ref(false);
const failure = ref<WorkshopFailure | null>(null);

let inflight: AbortController | null = null;

function abortInflight(): void {
  inflight?.abort();
  inflight = null;
}

async function load(force = false): Promise<void> {
  const id = props.projectId;
  if (!id) return;
  abortInflight();
  const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctrl = typeof Ctor === 'function' ? new Ctor() : null;
  inflight = ctrl;

  loading.value = true;
  failure.value = null;

  const res = await fetchProject(id, { force, signal: ctrl?.signal });

  if (inflight !== ctrl) return; // 被后来者/关闭掐掉，结果作废
  inflight = null;
  loading.value = false;

  if (!res.ok) {
    if (res.error.kind === 'cancelled') return; // 取消是正常收场
    failure.value = res.error;
    return;
  }
  detail.value = res.data;
}

watch(
  () => [props.open, props.projectId] as const,
  ([isOpen]) => {
    if (isOpen) {
      detail.value = null;
      void load();
    } else {
      abortInflight();
      loading.value = false;
    }
  },
);

onBeforeUnmount(abortInflight);

// ═══ 派生 ═══

/**
 * 展示用元数据: 优先用刚拉到的上游详情，拉不到就退回本地已装记录。
 *
 * 这个回退不是可有可无的 —— 上游挂掉时用户最需要的恰恰是「我装的是什么、怎么卸载」，
 * 而那份信息本地就有。让整屏因为网络失败而空白是最没用的收场。
 */
const meta = computed(() => detail.value?.project ?? props.installed ?? null);

const regexCount = computed(() => detail.value?.regexEntries.length ?? 0);
const previewEntryCount = computed(() => detail.value?.previewEntries.length ?? 0);
const sizeText = computed(() => formatBytes(meta.value?.fileSize));

const hasUpdate = computed(() => {
  const local = props.installed;
  const upstream = detail.value?.project;
  if (!local || !upstream) return false;
  // D13: 版本只做串比对，不解析语义版本号
  return upstream.version !== local.installedVersion;
});

/** 主按钮的三态：装 / 更新 / 重装 */
const primaryLabel = computed(() => {
  if (!props.installed) return '安装';
  return hasUpdate.value ? '更新到最新版' : '重新安装';
});

const failureText = computed(() => (failure.value ? describeFailure(failure.value) : ''));

// ═══════════════════════════════════════════════════════════
// 装前检视
// ═══════════════════════════════════════════════════════════

/**
 * 一次渲染多少行。
 *
 * 有上限不是为了好看: 上游有几百条目的项目，一次性展开几百个折叠行会让模态开启
 * 明显卡一拍。先渲一屏，其余按需。
 */
const INSPECT_PAGE = 25;

const entryLimit = ref(INSPECT_PAGE);
const regexLimit = ref(INSPECT_PAGE);

/** 展开的折叠行 —— 存 key 而非在每行挂 ref，换项目时一次清干净 */
const openRows = ref(new Set<string>());

function toggleRow(key: string): void {
  // 必须换 Set 实例：原地 add/delete 不会触发 Vue 的依赖更新
  const next = new Set(openRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openRows.value = next;
}

const isOpen = (key: string): boolean => openRows.value.has(key);

/** 换项目/重新拉取时把检视区复位，免得上一个项目的展开状态串到下一个 */
watch(
  () => [props.projectId, detail.value] as const,
  () => {
    entryLimit.value = INSPECT_PAGE;
    regexLimit.value = INSPECT_PAGE;
    openRows.value = new Set();
  },
);

const previewEntries = computed(() => detail.value?.previewEntries ?? []);
const visibleEntries = computed(() => previewEntries.value.slice(0, entryLimit.value));

/**
 * ★ 每条正则**装进来会变成什么样** —— 用的就是安装时的那个纯函数。
 *
 * 这是本屏比上游多出来的一件事: 上游把 ST 的字段原样搬进 ST，没有东西会丢，
 * 所以它只需展示 pattern/replacement。我们的美化库不是 ST 正则引擎，`promptOnly`、
 * `placement`、`substituteRegex` 这些没有对应物 —— 与其装完再在已装列表里告诉用户
 * 「14 项未导入」，不如**装之前**就在每一条上标出来。
 *
 * 复用 `mapWorkshopRegexes` 而不是另写一套判定，是因为两套判定迟早会分家，
 * 而分家的那天用户会看到「装前说好好的、装完说没导入」。逐条单独调用只是为了
 * 拿到**按条归属**的 notes（该函数返回的是整批的平铺数组）。
 */
const regexRows = computed(() => {
  const list = detail.value?.regexEntries ?? [];
  const projectName = meta.value?.name ?? '';
  return list.map((entry, index) => {
    // ★ indexBase 必须传真实序号。这个函数是索引敏感的（未命名正则兜底成
    //   `未命名正则 ${序号+1}`），不传的话每条单独调用时序号恒为 0 —— 同一条正则
    //   装前显示「未命名正则 1」、装后显示「未命名正则 3」，用户会以为是两条规则。
    const { rules, droppedNotes } = mapWorkshopRegexes([entry], {
      projectId: props.projectId,
      projectName,
      indexBase: index,
    });
    const groups = groupWorkshopNotes(droppedNotes);
    return {
      // 带上序号：上游 JSON 不可信，两条正则共用一个 uuid 时若只用 id 作 key，
      // 展开一条会连带展开另一条（manifest 已去重，这里是第二道保险）
      key: `${entry.id}@${index}`,
      entry,
      /** 整条被跳过（promptOnly / 表达式编译失败）→ 一条规则都不会产出 */
      willInstall: rules.length > 0,
      groups,
      notes: droppedNotes,
    };
  });
});

const visibleRegexRows = computed(() => regexRows.value.slice(0, regexLimit.value));

/** 顶部提要：这个项目里有几条正则装不进来 —— 装之前就该看见的数字 */
const regexDropCount = computed(() => regexRows.value.filter((r) => !r.willInstall).length);
</script>

<template>
  <AppModal
    :open="open"
    :title="meta?.name || '项目详情'"
    size="lg"
    @update:open="emit('update:open', $event)"
  >
    <div class="wk-detail">
      <!--
        首屏骨架而非一行文字: 文字态只有一行高，详情到位后整个模态从一行猛涨到满屏，
        那一下窜动比等待本身更让人不适。骨架先把最终版式占住。
      -->
      <div v-if="loading && !meta" class="wk-sk">
        <div class="wk-sk-head" aria-hidden="true">
          <div class="wk-sk-cover"></div>
          <div class="wk-sk-col">
            <div class="wk-sk-line sk-w40"></div>
            <div class="wk-sk-line sk-w70"></div>
            <div class="wk-sk-line sk-w55"></div>
          </div>
        </div>
        <div class="wk-sk-line sk-w25" aria-hidden="true"></div>
        <div class="wk-sk-line sk-w90" aria-hidden="true"></div>
        <div class="wk-sk-line sk-w80" aria-hidden="true"></div>
        <div class="wk-sk-line sk-w25" aria-hidden="true"></div>
        <div v-for="n in 3" :key="n" class="wk-sk-row" aria-hidden="true"></div>
        <!-- 骨架本身对读屏是噪音，所以只让这一句发声 -->
        <p class="sr-only" role="status">正在向创意工坊取详情…</p>
      </div>

      <template v-else-if="meta">
        <!-- ═══ 头部：封面 + 关键元数据 ═══ -->
        <div class="wk-head">
          <img
            v-if="meta.coverUrl"
            class="wk-head-cover"
            :src="meta.coverUrl"
            :alt="`${meta.name} 封面`"
            referrerpolicy="no-referrer"
          />
          <div class="wk-head-meta">
            <p class="wk-head-author">{{ meta.authorName || '佚名' }}</p>
            <div class="wk-kv-grid">
              <div class="wk-kv">
                <span class="wk-kv-k">上游版本</span>
                <span class="wk-kv-v">{{ formatVersion(meta.version) || '未标注' }}</span>
              </div>
              <div v-if="installed" class="wk-kv">
                <span class="wk-kv-k">已装版本</span>
                <span class="wk-kv-v" :class="{ 'v-stale': hasUpdate }">
                  {{ formatVersion(installed.installedVersion) || '未标注' }}
                </span>
              </div>
              <div v-if="sizeText" class="wk-kv">
                <span class="wk-kv-k">文件大小</span>
                <span class="wk-kv-v">{{ sizeText }}</span>
              </div>
              <div v-if="installed" class="wk-kv">
                <span class="wk-kv-k">安装于</span>
                <span class="wk-kv-v">{{ formatDate(installed.installedAt) || '—' }}</span>
              </div>
            </div>
          </div>
        </div>

        <p v-if="hasUpdate" class="wk-update-banner">
          上游已有新版本：{{ formatVersion(installed?.installedVersion) }} →
          {{ formatVersion(detail?.project.version) }}
        </p>

        <!-- ═══ ★ 标签（D12：判断依据，必须显眼） ═══ -->
        <section class="wk-section">
          <h4 class="wk-label">标签</h4>
          <ul v-if="meta.tags.length > 0" class="wk-tags">
            <li v-for="tag in meta.tags" :key="tag" class="wk-tag">{{ tag }}</li>
          </ul>
          <p v-else class="wk-muted">作者未标注标签。</p>
          <p class="wk-caution">
            工坊内容来自社区投稿，未经本引擎审核。标签与简介是判断它会不会和你正在玩的
            设定（尤其是命定核心）冲突的<strong>唯一</strong>依据 —— 装之前请自行过目。
          </p>
        </section>

        <!-- ═══ 简介 ═══ -->
        <section class="wk-section">
          <h4 class="wk-label">简介</h4>
          <p v-if="meta.description" class="wk-desc">{{ meta.description }}</p>
          <p v-else class="wk-muted">作者未填写简介。</p>
        </section>

        <!-- ═══ 内容构成 ═══ -->
        <section class="wk-section">
          <h4 class="wk-label">内容</h4>
          <div class="wk-kv-grid">
            <div class="wk-kv">
              <span class="wk-kv-k">世界书条目</span>
              <span class="wk-kv-v">{{ previewEntryCount }} 条（预览）</span>
            </div>
            <div class="wk-kv">
              <span class="wk-kv-k">正则（美化规则）</span>
              <span class="wk-kv-v">{{ regexCount }} 条</span>
            </div>
          </div>
          <p class="wk-muted wk-note">
            条目数取自详情预览，安装时以实际下载的载荷为准，可能更多。正则会装进「输出美化」
            规则库，默认启用，只在这本世界书装着时生效。
          </p>
        </section>

        <!-- ═══ 世界书条目检视 ═══ -->
        <section v-if="previewEntries.length > 0" class="wk-section">
          <h4 class="wk-label">世界书条目预览（{{ previewEntries.length }}）</h4>
          <ul class="wk-rows">
            <li v-for="(e, i) in visibleEntries" :key="`e${i}`" class="wk-row">
              <button
                type="button"
                class="wk-row-head"
                :aria-expanded="isOpen(`e${i}`)"
                :aria-controls="`wk-entry-body-${i}`"
                @click="toggleRow(`e${i}`)"
              >
                <span
                  class="wk-chevron"
                  :class="{ 'chev-open': isOpen(`e${i}`) }"
                  aria-hidden="true"
                  >›</span
                >
                <span class="wk-row-name">{{ e.name || '无标题' }}</span>
                <span v-if="!e.enabled" class="wk-flag flag-off">默认关闭</span>
                <span v-if="!isOpen(`e${i}`)" class="wk-row-peek">{{ truncate(e.content) }}</span>
              </button>
              <div
                :id="`wk-entry-body-${i}`"
                class="wk-row-body"
                :class="{ 'body-open': isOpen(`e${i}`) }"
              >
                <div class="wk-row-inner">
                  <div class="wk-chip-block">
                    <span class="wk-chip-k">主要关键词</span>
                    <span v-if="e.key.length === 0" class="wk-muted">无（常驻注入）</span>
                    <ul v-else class="wk-chips">
                      <li v-for="(k, ki) in e.key" :key="ki" class="wk-chip">{{ k }}</li>
                    </ul>
                  </div>
                  <div v-if="e.keysecondary.length > 0" class="wk-chip-block">
                    <span class="wk-chip-k">
                      次要关键词 · {{ describeSelectiveLogic(e.selectiveLogic) }}
                    </span>
                    <ul class="wk-chips">
                      <li v-for="(k, ki) in e.keysecondary" :key="ki" class="wk-chip">{{ k }}</li>
                    </ul>
                  </div>
                  <p class="wk-row-meta">
                    order {{ e.order }} · {{ describeEntryPosition(e.position) }}
                  </p>
                  <pre class="wk-row-content">{{ e.content || '（空内容）' }}</pre>
                </div>
              </div>
            </li>
          </ul>
          <AppButton
            v-if="entryLimit < previewEntries.length"
            variant="ghost"
            size="sm"
            @click="entryLimit = previewEntries.length"
          >
            展开其余 {{ previewEntries.length - entryLimit }} 条
          </AppButton>
        </section>

        <!-- ═══ 正则检视（含装前处置预告） ═══ -->
        <section v-if="regexRows.length > 0" class="wk-section">
          <h4 class="wk-label">正则（{{ regexRows.length }}）</h4>
          <p v-if="regexDropCount > 0" class="wk-predrop">
            其中 <strong>{{ regexDropCount }}</strong> 条在本引擎没有对应物，安装后不会生效 ——
            下面逐条标了出来。
          </p>
          <ul class="wk-rows">
            <li v-for="row in visibleRegexRows" :key="row.key" class="wk-row">
              <button
                type="button"
                class="wk-row-head"
                :aria-expanded="isOpen(`r${row.key}`)"
                :aria-controls="`wk-regex-body-${row.key}`"
                @click="toggleRow(`r${row.key}`)"
              >
                <span
                  class="wk-chevron"
                  :class="{ 'chev-open': isOpen(`r${row.key}`) }"
                  aria-hidden="true"
                  >›</span
                >
                <span class="wk-row-name">{{ row.entry.scriptName || '未命名正则' }}</span>
                <span v-if="!row.willInstall" class="wk-flag flag-drop">不会生效</span>
                <span v-else-if="row.entry.disabled" class="wk-flag flag-off">默认关闭</span>
                <span v-if="row.groups.sideEffect.length > 0" class="wk-flag flag-side">
                  全局副作用
                </span>
              </button>
              <div
                :id="`wk-regex-body-${row.key}`"
                class="wk-row-body"
                :class="{ 'body-open': isOpen(`r${row.key}`) }"
              >
                <div class="wk-row-inner">
                  <div class="wk-chip-block">
                    <span class="wk-chip-k">匹配</span>
                    <pre class="wk-code">{{ row.entry.findRegex || '（空）' }}</pre>
                  </div>
                  <div class="wk-chip-block">
                    <span class="wk-chip-k">替换为</span>
                    <pre class="wk-code">{{ row.entry.replaceString || '（删除匹配内容）' }}</pre>
                  </div>
                  <!-- 装前处置预告：与装后已装列表同一口径（同一个纯函数算出来的） -->
                  <ul v-if="row.notes.length > 0" class="wk-note-list">
                    <li v-for="(n, ni) in row.notes" :key="ni" :class="`note-${n.kind}`">
                      <strong>{{ WORKSHOP_NOTE_LABEL[n.kind] }}</strong> · {{ n.text }}
                    </li>
                  </ul>
                </div>
              </div>
            </li>
          </ul>
          <AppButton
            v-if="regexLimit < regexRows.length"
            variant="ghost"
            size="sm"
            @click="regexLimit = regexRows.length"
          >
            展开其余 {{ regexRows.length - regexLimit }} 条
          </AppButton>
        </section>

        <!-- ═══ 上游拉取失败但本地有记录 ═══ -->
        <p v-if="failure" class="wk-inline-failure" role="alert">
          {{ failureText }} 下面显示的是本地已安装的信息。
        </p>
      </template>

      <!-- ═══ 既没拉到也没装过 ═══ -->
      <div v-else class="wk-failure" role="alert">
        <p class="wk-failure-text">{{ failureText || '取不到这个项目的信息。' }}</p>
        <p v-if="failure" class="wk-failure-detail">{{ failure.message }}</p>
        <AppButton variant="primary" size="sm" @click="load(true)">重试</AppButton>
      </div>
    </div>

    <template #footer>
      <!--
        社交动作放在底栏最左，与右侧的安装/卸载隔开一整段 auto 间距: 它们是**两类
        不同后果**的动作（一个改上游计数、一个往本地写世界书），挨在一起排会让人
        点错。计数在按钮上，下载数跟在后面（仅展示，§1.3 不做逻辑依赖）。
      -->
      <div v-if="meta" class="wk-footer-social">
        <WorkshopSocialActions
          :project-id="projectId"
          :social="detail?.social"
          variant="full"
          show-downloads
        />
      </div>

      <AppButton
        v-if="installed"
        variant="danger"
        size="sm"
        :disabled="busy"
        @click="emit('uninstall', projectId)"
      >
        卸载
      </AppButton>
      <!--
        卸载**不给** loading: 它只是打开确认弹窗（askUninstall），本身是瞬时的。
        给它转圈会暗示"正在卸载"，而这时一行都还没删。
      -->

      <AppButton variant="ghost" size="sm" @click="emit('update:open', false)">关闭</AppButton>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="busy || (!detail && !installed)"
        :loading="busy && busyAction !== 'uninstall' && busyAction !== 'check'"
        @click="emit('install', projectId)"
      >
        {{ busy ? '处理中…' : primaryLabel }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.wk-detail {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
}

/* ── 头部 ── */
.wk-head {
  display: flex;
  gap: var(--theme-spacing-lg);
  align-items: flex-start;
}
.wk-head-cover {
  width: 160px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  flex-shrink: 0;
}
.wk-head-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  min-width: 0;
}
.wk-head-author {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  color: var(--theme-text-secondary);
}

.wk-kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 14px;
}
.wk-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  font-size: 0.8125rem;
  line-height: 1.6;
}
.wk-kv-k {
  color: var(--theme-text-muted);
}
.wk-kv-v {
  color: var(--theme-text-primary);
}
.v-stale {
  color: var(--theme-warning);
}

.wk-update-banner {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-warning) 12%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-warning) 32%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  color: var(--theme-warning);
  font-size: 0.8125rem;
}

/* ── Section（design.md §5.1 装饰线） ── */
.wk-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.wk-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  letter-spacing: 0.03em;
}
.wk-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.wk-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}
.wk-tag {
  padding: 3px 10px;
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 32%, var(--theme-card-border));
  color: var(--theme-text-primary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.wk-caution {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}
.wk-desc {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
  white-space: pre-wrap;
}
.wk-muted {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.wk-note {
  font-style: normal;
  line-height: 1.6;
}

/* ── 装前检视：折叠行 ── */
.wk-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wk-row {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  overflow: hidden;
}
.wk-row-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  width: 100%;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
  transition: background var(--theme-transition-fast);
}
.wk-row-head:hover {
  background: var(--theme-tab-hover-bg);
}
.wk-row-head:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}
.wk-chevron {
  flex-shrink: 0;
  color: var(--theme-text-muted);
  font-size: 0.9rem;
  line-height: 1;
  /* transform 而非改字符：旋转可过渡，换字符会跳 */
  transition: transform var(--theme-transition-fast);
}
.chev-open {
  transform: rotate(90deg);
}
.wk-row-name {
  flex-shrink: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
/* 收起时补一段正文摘要 —— 不展开也能扫一遍这条是干什么的 */
.wk-row-peek {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.wk-flag {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: var(--theme-radius-full);
  font-size: 0.6875rem;
  line-height: 1.7;
}
.flag-off {
  background: color-mix(in srgb, var(--theme-text-muted) 12%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-text-muted) 30%, var(--theme-card-border));
  color: var(--theme-text-muted);
}
.flag-drop {
  background: color-mix(in srgb, var(--theme-error) 14%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 32%, var(--theme-card-border));
  color: var(--theme-error);
}
.flag-side {
  background: color-mix(in srgb, var(--theme-warning) 14%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-warning) 32%, var(--theme-card-border));
  color: var(--theme-warning);
}

/*
 * 展开动画: grid-template-rows 0fr→1fr（design.md §6.1 指定，禁止 max-height 过渡）。
 * 内层必须 min-height:0 + overflow:hidden，否则 0fr 那一格压不住内容。
 */
.wk-row-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  /*
   * ★ `visibility: hidden` 不是装饰: 只靠 0fr + overflow:hidden 的话，收起的行**仍在
   * 无障碍树里** —— 读屏会把所有折叠内容一路念完，`aria-expanded="false"` 拦不住它。
   * 更糟的是里面的 `.wk-row-content` / `.wk-code` 是 `overflow: auto`，Chrome 默认让
   * 可滚动容器可聚焦，Tab 会落进一个看不见的行里，然后浏览器为了「滚动到焦点」把
   * 被裁掉的内容顶出来。
   *
   * 延迟到展开动画结束再隐藏（`visibility 0s linear <时长>`），否则收起过程第一帧
   * 内容就消失了，0fr 的收拢动画会演给空气看。
   */
  visibility: hidden;
  transition:
    grid-template-rows var(--theme-transition-normal),
    opacity var(--theme-transition-normal),
    visibility 0s linear 0.25s;
}
.body-open {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  /* 展开时立刻可见，不能等 —— 否则动画期间内容是隐形的 */
  transition:
    grid-template-rows var(--theme-transition-normal),
    opacity var(--theme-transition-normal),
    visibility 0s;
}
.wk-row-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  /*
   * padding-bottom 常驻，不随展开切换: 切换它会在收起的第一帧让内容高度突变一下
   * （0fr 已经把整格裁成 0 高，留着这点 padding 完全看不见，却省掉那一下抖）。
   */
  padding: 0 var(--theme-spacing-md) var(--theme-spacing-md);
}

.wk-chip-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wk-chip-k {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.03em;
}
.wk-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wk-chip {
  padding: 1px 7px;
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.7;
}
.wk-row-meta {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.wk-row-content,
.wk-code {
  margin: 0;
  padding: var(--theme-spacing-sm);
  max-height: 220px;
  overflow: auto;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.wk-predrop {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-error) 8%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 28%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.wk-note-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.6875rem;
  line-height: 1.6;
}
.note-dropped {
  color: var(--theme-error);
}
.note-degraded {
  color: var(--theme-text-muted);
}
.note-sideEffect {
  color: var(--theme-warning);
}

.wk-inline-failure {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-error);
}

/* 底栏是 justify-end 的一排；auto 把社交那一组顶到最左 */
.wk-footer-social {
  margin-right: auto;
}

@media (prefers-reduced-motion: reduce) {
  .wk-row-head,
  .wk-chevron,
  .wk-row-body {
    transition: none;
  }
  /* 骨架脉动由 themes/variables.css 的全局减动效规则兜住，别在这里写 animation: none */
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

/* ── 首屏骨架 ── */
.wk-sk {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}
.wk-sk-head {
  display: flex;
  gap: var(--theme-spacing-lg);
}
.wk-sk-cover {
  width: 160px;
  aspect-ratio: 16 / 9;
  flex-shrink: 0;
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
}
.wk-sk-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding-top: 4px;
}
.wk-sk-line {
  height: 11px;
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
}
/* 折叠行的占位：高度按真实行高来，内容到位时不会再窜一次 */
.wk-sk-row {
  height: 34px;
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
}
.sk-w25 {
  width: 25%;
}
.sk-w40 {
  width: 40%;
}
.sk-w55 {
  width: 55%;
}
.sk-w70 {
  width: 70%;
}
.sk-w80 {
  width: 80%;
}
.sk-w90 {
  width: 90%;
}
.wk-sk-cover,
.wk-sk-line,
.wk-sk-row {
  animation: wk-sk-pulse 1.4s ease-in-out infinite;
}
@keyframes wk-sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
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
</style>
