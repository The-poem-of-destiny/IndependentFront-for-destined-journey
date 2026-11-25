<!--
  CreateReadiness.vue — 创建向导前的准入页「启程前的准备」

  只负责呈现：检查状态（checking / checkError / issues / blocked）由 CreatePage 持有并传入，
  这里把操作以事件交回去。版式与难度步一致：居中、直接坐在页面底色上，不套外层卡片。

  🔴 两个「内容状态」别混：
  - catalogStatus = create-store 的目录加载态（idle / loading / ready / empty），决定能否开始创建
  - contentSource = content-store 的内容来源（placeholder / pack …），只影响主按钮文案
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { GenerationMode } from '@engine/story/generation-mode';
import type { SettingsSection } from '../../stores/ui-store';
import type { ReadinessIssue } from '../../lib/journey-readiness';
import { LOCKED_GENERATION_MODES } from '../../lib/create-options';
import AppButton from '../shared/AppButton.vue';
import AppCard from '../shared/AppCard.vue';
import ContentStatusBanner from '../shared/ContentStatusBanner.vue';

const props = defineProps<{
  generationMode: GenerationMode | '';
  issues: readonly ReadinessIssue[];
  checking: boolean;
  checkError: string;
  catalogStatus: string;
  contentSource: string;
  blocked: boolean;
}>();

const emit = defineEmits<{
  'update:generationMode': [mode: GenerationMode];
  accept: [];
  recheck: [];
  'open-settings': [section: SettingsSection];
}>();

/** 每种模式只留一句简介；计费相关说明收进下方默认收起的 details */
const MODE_OPTIONS: ReadonlyArray<{ value: GenerationMode; label: string; desc: string }> = [
  { value: 'agent', label: 'Agent 模式', desc: '多个 AI 分工、多次调用，适合单价较低的模型。' },
  {
    value: 'direct',
    label: '直出（无缓存优化）',
    desc: '主 AI 一次回复完成叙事、战斗、制作与状态变化，接近角色卡体验。',
  },
  {
    value: 'direct_cached',
    label: '直出（缓存优化）',
    desc: '同样一次主调用完成整轮，适合较强的模型。',
  },
];

interface CheckRow {
  key: string;
  message: string;
  blocking: boolean;
  section?: ReadinessIssue['section'];
  alert?: boolean;
}

/** 清单的全部行：加载失败与目录不可用也是「需要处理」，与配置问题同列 */
const rows = computed<CheckRow[]>(() => {
  if (props.checking) return [];
  const list: CheckRow[] = [];
  if (props.checkError) {
    list.push({ key: 'check-error', message: props.checkError, blocking: true, alert: true });
  }
  if (props.catalogStatus !== 'ready') {
    list.push({
      key: 'catalog',
      message: '没有可用的角色内容目录，请先导入内容包。',
      blocking: true,
      alert: true,
    });
  }
  for (const issue of props.issues) {
    list.push({
      key: `issue:${issue.message}`,
      message: issue.message,
      blocking: issue.blocking,
      section: issue.section,
    });
  }
  return list;
});

const pendingCount = computed(() => rows.value.filter((row) => row.blocking).length);
const allClear = computed(
  () => !props.checking && rows.value.length === 0 && !!props.generationMode,
);

/** 屏上只留一个 API 设置入口：清单里已有 API 行时，操作行不再重复放 */
const showApiShortcut = computed(() => !rows.value.some((row) => row.section === 'api'));

const blockedReason = computed(() =>
  props.blocked && !props.checking && pendingCount.value > 0
    ? `还有 ${pendingCount.value} 项需要处理`
    : '',
);
</script>

<template>
  <section class="readiness" aria-labelledby="readiness-title">
    <h1 id="readiness-title" class="readiness-title">启程前的准备</h1>
    <p class="readiness-lead">先选定生成模式并确认本机配置，再开始创建角色。</p>
    <ContentStatusBanner />

    <div class="readiness-section">
      <h2 id="readiness-mode-label" class="section-label">生成模式</h2>
      <p class="section-hint">本存档创建后不可更改。</p>
      <div class="mode-list" role="group" aria-labelledby="readiness-mode-label">
        <AppCard
          v-for="mode in MODE_OPTIONS"
          :key="mode.value"
          :clickable="!LOCKED_GENERATION_MODES.has(mode.value)"
          :selected="generationMode === mode.value"
          class="mode-card"
          :class="{ 'is-locked': LOCKED_GENERATION_MODES.has(mode.value) }"
          :aria-disabled="LOCKED_GENERATION_MODES.has(mode.value) ? 'true' : undefined"
          @click="
            !LOCKED_GENERATION_MODES.has(mode.value) && emit('update:generationMode', mode.value)
          "
        >
          <span class="mode-name"
            >{{ mode.label
            }}<span v-if="LOCKED_GENERATION_MODES.has(mode.value)" class="mode-locked-tag"
              >暂未开放</span
            ></span
          >
          <span class="mode-desc">{{ mode.desc }}</span>
        </AppCard>
      </div>
      <details class="mode-details">
        <summary>计费与请求次数说明</summary>
        <ul>
          <li>直出（无缓存优化）适合按请求次数计费的渠道。</li>
          <li>直出（缓存优化）适合按 Token 计费且支持缓存的渠道。</li>
          <li>实际命中与费用取决于渠道。</li>
          <li>所有模式都保留独立记忆调用，因此整楼可能不止一次请求。</li>
        </ul>
      </details>
    </div>

    <div class="readiness-section">
      <h2 class="section-label">本机配置检查</h2>
      <p v-if="checking" class="check-status" role="status">正在检查本机配置…</p>
      <template v-else>
        <ul v-if="rows.length" class="check-list">
          <li v-for="row in rows" :key="row.key" class="check-row">
            <span class="check-badge" :class="row.blocking ? 'is-blocking' : 'is-optional'">
              {{ row.blocking ? '需要处理' : '可选' }}
            </span>
            <span class="check-message" :role="row.alert ? 'alert' : undefined">{{
              row.message
            }}</span>
            <AppButton
              v-if="row.section"
              variant="secondary"
              size="sm"
              @click="emit('open-settings', row.section)"
            >
              {{ row.section === 'api' ? '配置 API' : '配置 Agent' }}
            </AppButton>
          </li>
        </ul>
        <p v-if="allClear" class="check-status">对话配置已齐备。</p>
      </template>
      <p class="readiness-note">
        此处只检查本机配置，不发送模型请求。密钥权限与连接可在 API
        设置中测试；实际生成可能产生费用。图像生成和额外的 Embedding 服务均为可选。
      </p>
    </div>

    <div class="readiness-actions">
      <div class="action-row">
        <AppButton variant="primary" :disabled="blocked" @click="emit('accept')">{{
          contentSource === 'placeholder' ? '使用演示内容创建角色' : '开始创建角色'
        }}</AppButton>
        <AppButton variant="secondary" :disabled="checking" @click="emit('recheck')"
          >重新检查</AppButton
        >
        <AppButton v-if="showApiShortcut" variant="ghost" @click="emit('open-settings', 'api')"
          >打开 API 设置</AppButton
        >
      </div>
      <p class="blocked-reason" aria-live="polite">{{ blockedReason }}</p>
    </div>
  </section>
</template>

<style scoped>
.readiness {
  max-width: 800px;
  margin: 0 auto;
  color: var(--theme-text-primary);
  line-height: 1.6;
}
.readiness-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  font-weight: 700;
  margin: 0 0 var(--theme-spacing-xs);
}
.readiness-lead {
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  margin: 0 0 var(--theme-spacing-lg);
}

/* ===== 分区 ===== */
.readiness-section {
  margin-top: var(--theme-spacing-xl);
}
.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--theme-text-muted);
}
.section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.section-hint {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

/* ===== 生成模式 ===== */
.mode-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: var(--theme-spacing-sm);
}
.mode-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.mode-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
}
.mode-card.is-locked {
  opacity: 0.5;
  cursor: not-allowed;
}
.mode-locked-tag {
  margin-left: var(--theme-spacing-xs);
  padding: 1px 6px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  vertical-align: middle;
}
.mode-desc {
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}
.mode-details {
  margin-top: var(--theme-spacing-sm);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.mode-details summary {
  cursor: pointer;
  color: var(--theme-text-muted);
  transition: color var(--theme-transition-fast);
}
.mode-details summary:hover {
  color: var(--theme-text-secondary);
}
.mode-details ul {
  margin: var(--theme-spacing-xs) 0 0;
  padding-left: var(--theme-spacing-lg);
}

/* ===== 本机配置清单 ===== */
.check-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.check-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) 0;
}
.check-row + .check-row {
  border-top: 1px solid var(--theme-card-border);
}
.check-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  font-weight: 600;
  white-space: nowrap;
}
.check-badge.is-blocking {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.check-badge.is-optional {
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}
.check-message {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
}
.check-status {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.readiness-note {
  margin: var(--theme-spacing-md) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

/* ===== 操作行 ===== */
.readiness-actions {
  margin-top: var(--theme-spacing-2xl);
}
.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.blocked-reason {
  min-height: 1.2em;
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.blocked-reason:empty {
  min-height: 0;
}
</style>
