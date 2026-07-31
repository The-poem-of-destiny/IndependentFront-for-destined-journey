<script setup lang="ts">
/**
 * 项目详情 —— 安装决策就在这一屏做完（Phase 1 / P1-4）
 *
 * ★ **这一屏的存在理由是 D12**：我们**不做**命定核心冲突拦截（tags 是上游自由文本，
 * 没有可靠机器信号，猜必误伤），改为把判断依据完整摊开 —— 标签、完整简介、条目数、
 * 正则数、体积、作者、版本。用户看完自己决定。任何把这些藏进折叠区的改动都是在
 * 悄悄推翻 D12 的前提。
 *
 * 只读一面: 没有点赞/订阅/投稿（Phase 3+）。
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
import { fetchProject } from '../../lib/workshop-client';
import type { WorkshopFailure, WorkshopProjectDetail } from '../../lib/workshop-client';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import { formatBytes, formatDate, formatVersion } from './format';
import { describeFailure } from './failure-text';

const props = defineProps<{
  open: boolean;
  projectId: string;
  /** 本地已装记录；未装则不传 */
  installed?: WorkshopProject;
  /** 父组件正在为这个项目跑安装/卸载 —— 按钮据此禁用 */
  busy?: boolean;
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
</script>

<template>
  <AppModal
    :open="open"
    :title="meta?.name || '项目详情'"
    size="lg"
    @update:open="emit('update:open', $event)"
  >
    <div class="wk-detail">
      <p v-if="loading && !meta" class="empty-tab">正在向创意工坊取详情…</p>

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
      <AppButton
        v-if="installed"
        variant="danger"
        size="sm"
        :disabled="busy"
        @click="emit('uninstall', projectId)"
      >
        卸载
      </AppButton>
      <AppButton variant="ghost" size="sm" @click="emit('update:open', false)">关闭</AppButton>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="busy || (!detail && !installed)"
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

.wk-inline-failure {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-error);
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
