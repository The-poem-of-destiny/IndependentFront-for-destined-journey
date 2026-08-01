<script setup lang="ts">
/**
 * 工坊项目卡片 —— 浏览模态里的一格（Phase 1 / P1-4）
 *
 * 装没装、能不能装由父组件判定后以 `state` 传进来；本体不碰 store、不发请求。
 * **唯一的例外**是右下角那对点赞/订阅按钮（P3c）—— 它整块封在
 * `WorkshopSocialActions` 里，卡片只负责把 `project.id` 与本次响应的社交值递进去。
 *
 * ★ **根节点是 `div[role=button]` 而不是 `<button>`**（P3c 改）: 社交按钮嵌在卡片里，
 * 而 `<button>` 套 `<button>` 是非法 HTML —— 浏览器解析时会把内层按钮**提到外面**，
 * 卡片的版式当场散架。改用 role + tabindex + 键盘处理保住原来的可访问性。
 *
 * ★ **tags 必须显眼**（设计 D12）。我们**刻意不做**命定核心冲突拦截 —— 上游 tags 是
 * 自由文本（"系统"/"命定核心"/"外挂"/"路边"），没有可靠机器信号，猜必误伤。
 * 于是这张卡片承担的职责就是「把判断依据摆到用户眼前」: 标签一条不折叠、简介给两行。
 * 任何把 tags 收进"更多"里的改动都是在悄悄推翻 D12。
 *
 * 封面走上游 URL（worker 代理，CORS 已开）。加载失败退回文字占位 —— 一张图挂了
 * 不该让整格塌掉，更不该留下浏览器的碎图标。
 */
import { computed, ref, watch } from 'vue';
import type { WorkshopProjectMeta, WorkshopSocialMeta } from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import WorkshopSocialActions from './WorkshopSocialActions.vue';
import { formatBytes, formatVersion } from './format';

const props = defineProps<{
  project: WorkshopProjectMeta;
  /** 本地安装状态；未装则不传 */
  state?: WorkshopProject['installState'];
  /** 已装版本 —— 与上游 version 不同时卡片上直接说清「x → y」 */
  installedVersion?: string;
  /** 本次列表响应带回的社交计数（D22）。缺省 → 不显示计数，也**不编** 0 */
  social?: WorkshopSocialMeta;
}>();

const emit = defineEmits<{ open: [projectId: string] }>();

const coverFailed = ref(false);
// 换了项目就重置失败标志，否则复用同一个 DOM 节点时新封面会被判死
watch(
  () => props.project.coverUrl,
  () => {
    coverFailed.value = false;
  },
);

const showCover = computed(() => Boolean(props.project.coverUrl) && !coverFailed.value);
const sizeText = computed(() => formatBytes(props.project.fileSize));

/** 未装 → 不出徽章（多数卡片是未装的，全都挂个"未安装"只是噪音） */
const badge = computed<{ text: string; kind: string } | null>(() => {
  switch (props.state) {
    case 'installed':
      return { text: '已安装', kind: 'ok' };
    case 'update_available':
      return { text: '有更新', kind: 'warn' };
    case 'broken':
      return { text: '上游不可达', kind: 'err' };
    default:
      return null;
  }
});

/** 首字母兜底：中文取首字，英文取首字母 */
const initial = computed(() => (props.project.name || '?').trim().slice(0, 1));

function open(): void {
  emit('open', props.project.id);
}

/**
 * 回车/空格 = 打开详情（补回 `<button>` 根节点原本白送的那份键盘行为）。
 *
 * ★ `target !== currentTarget` 时直接放行: 焦点落在卡内的点赞按钮上时，回车属于
 * **那个按钮**。不判这一下的话，用键盘赞一个项目会顺手弹出详情模态 —— 与鼠标
 * 那侧靠 `@click.stop` 拦住的正是同一种误触，只是走的另一条事件通道。
 */
function onKey(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
  event.preventDefault(); // 空格默认滚动页面
  open();
}
</script>

<template>
  <div
    class="wk-card"
    role="button"
    tabindex="0"
    :aria-label="`查看「${project.name}」详情`"
    @click="open"
    @keydown="onKey"
  >
    <div class="wk-cover">
      <img
        v-if="showCover"
        :src="project.coverUrl"
        :alt="`${project.name} 封面`"
        loading="lazy"
        referrerpolicy="no-referrer"
        @error="coverFailed = true"
      />
      <span v-else class="wk-cover-fallback" aria-hidden="true">{{ initial }}</span>
      <span v-if="badge" class="wk-badge" :class="`badge-${badge.kind}`">{{ badge.text }}</span>
    </div>

    <div class="wk-body">
      <h4 class="wk-name">{{ project.name }}</h4>

      <div class="wk-meta">
        <span class="wk-author">{{ project.authorName || '佚名' }}</span>
        <span v-if="formatVersion(project.version)" class="wk-dot" aria-hidden="true">·</span>
        <span v-if="formatVersion(project.version)" class="wk-version">
          {{ formatVersion(project.version) }}
        </span>
        <span v-if="sizeText" class="wk-dot" aria-hidden="true">·</span>
        <span v-if="sizeText" class="wk-size">{{ sizeText }}</span>
      </div>

      <p v-if="project.description" class="wk-desc">{{ project.description }}</p>
      <p v-else class="wk-desc wk-desc-empty">作者未填写简介</p>

      <!-- ★ D12：标签是用户判断「这项目会不会和我的命定核心打架」的唯一依据，不折叠 -->
      <ul v-if="project.tags.length > 0" class="wk-tags">
        <li v-for="tag in project.tags" :key="tag" class="wk-tag">{{ tag }}</li>
      </ul>
      <p v-else class="wk-tags-empty">未标注标签</p>

      <p v-if="state === 'update_available' && installedVersion" class="wk-update-line">
        {{ formatVersion(installedVersion) }} → {{ formatVersion(project.version) }}
      </p>

      <!-- 社交动作：点击不冒泡到整卡的「打开详情」（组件内 @click.stop） -->
      <div class="wk-card-social">
        <WorkshopSocialActions :project-id="project.id" :social="social" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wk-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: 0 0 var(--theme-spacing-md);
  text-align: left;
  background: var(--theme-card-bg);
  /* 全边 1px，禁止侧边色条（design.md §1 绝对禁令） */
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  box-shadow: var(--paper-stack);
  cursor: pointer;
  overflow: hidden;
  font-family: inherit;
  color: inherit;
  transition:
    border-color var(--theme-transition-fast),
    background var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}
.wk-card:hover,
.wk-card:focus-visible {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-card-bg));
  box-shadow: var(--theme-shadow-md);
}
.wk-card:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

/* ── 封面 ── */
.wk-cover {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--theme-surface-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.wk-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.wk-cover-fallback {
  font-family: var(--theme-font-title);
  font-size: 2rem;
  color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-text-muted));
}
.wk-badge {
  position: absolute;
  top: var(--theme-spacing-sm);
  right: var(--theme-spacing-sm);
  padding: 2px 8px;
  border-radius: var(--theme-radius-full);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.6;
}
.badge-ok {
  background: color-mix(in srgb, var(--theme-success) 16%, var(--theme-card-bg));
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 35%, transparent);
}
.badge-warn {
  background: color-mix(in srgb, var(--theme-warning) 16%, var(--theme-card-bg));
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 35%, transparent);
}
.badge-err {
  background: color-mix(in srgb, var(--theme-error) 16%, var(--theme-card-bg));
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 35%, transparent);
}

/* ── 正文 ── */
.wk-body {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: 0 var(--theme-spacing-md);
}
.wk-name {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--theme-text-primary);
}
.wk-meta {
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
.wk-desc {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.wk-desc-empty {
  color: var(--theme-text-muted);
  font-style: italic;
}

.wk-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  margin: var(--theme-spacing-xs) 0 0;
  padding: 0;
  list-style: none;
}
.wk-tag {
  padding: 1px 7px;
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.7;
}
.wk-tags-empty {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.6875rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

.wk-update-line {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.6875rem;
  color: var(--theme-warning);
}

/* 社交按钮靠右下角，与上方内容留一口气 */
.wk-card-social {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--theme-spacing-sm);
}

@media (prefers-reduced-motion: reduce) {
  .wk-card {
    transition: none;
  }
}
</style>
