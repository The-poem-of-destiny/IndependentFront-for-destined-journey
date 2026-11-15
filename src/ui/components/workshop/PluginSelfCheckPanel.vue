<script setup lang="ts">
/**
 * 插件启动自检面板（插件设计 §4.8）。
 *
 * - 显示本页面会话的自检状态：未跑 / 检查中 / 通过 / 未通过。🔴 未通过时必须写明
 *   **哪一项**没过（设计：「任何一项失败则插件子系统禁用，并在扩展管理页写明是哪一项」），
 *   所以逐项列出编号、结果与中文说明，失败项排在最前。
 * - 「重新检查」走 `pluginStore.rerunSelfCheck()`（丢掉缓存结果再跑一轮）。
 * - 仅开发者模式：打开「人工矩阵探针」—— `buildManualMatrixProbe()` 的文档作为插件入口挂进
 *   **生产的插件帧**（`mountPluginFrame`，未声明联网域名），由人逐个点按钮对照抓包
 *   （§4.8「人工矩阵」）。探针帧用的就是插件的沙盒与 CSP，不另开一条宽松的路。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import AppButton from '../shared/AppButton.vue';
import { usePluginStore } from '../../stores/plugin-store';
import { useSettingsStore } from '../../stores/settings-store';
import { buildManualMatrixProbe } from '../../lib/plugin-selfcheck';
import { mountPluginFrame } from '../../lib/plugin-frame';

const plugins = usePluginStore();
const settings = useSettingsStore();

/** 自检各项的中文名（编号由 plugin-selfcheck.ts 定义） */
const ITEM_LABELS: Record<string, string> = {
  CAGE: '牢笼帧装载',
  S0: '对照组（各手段可用）',
  S1: '资源请求被拦截',
  S2: '导航被拦截',
  S3: '子文档继承限制',
  S4: 'Worker 被拦截',
  S5: '重定向被拦截',
  S6: '插件存档的美化帧',
  S7: '文件选择器',
};

const STATUS_LABELS = { pass: '通过', fail: '失败', skipped: '未自检' } as const;

const result = computed(() =>
  plugins.selfCheck !== null && plugins.selfCheck !== 'running' ? plugins.selfCheck : null,
);
const running = computed(() => plugins.selfCheck === 'running');

/** 失败项排前面，其余保持原顺序 */
const items = computed(() => {
  const list = result.value?.items ?? [];
  return [...list.filter((i) => i.status === 'fail'), ...list.filter((i) => i.status !== 'fail')];
});
const failedLabels = computed(() =>
  items.value.filter((i) => i.status === 'fail').map((i) => `${i.id} ${ITEM_LABELS[i.id] ?? ''}`),
);

const innerModeText = computed(() => {
  const mode = result.value?.innerMode;
  if (mode === 'srcdoc') return 'srcdoc';
  if (mode === 'blob') return 'blob';
  return '无（插件帧没能启动）';
});

const ranAtText = computed(() => {
  const at = result.value?.ranAt;
  return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '';
});

function rerun() {
  void plugins.rerunSelfCheck();
}

// ─── 人工矩阵探针（仅开发者模式） ───

const showProbe = ref(false);
const probeHost = ref<HTMLElement | null>(null);
let probeHandle: ReturnType<typeof mountPluginFrame> | null = null;

function disposeProbe() {
  probeHandle?.dispose();
  probeHandle = null;
}

async function openProbe() {
  if (!settings.settings.developerMode) return;
  disposeProbe();
  showProbe.value = true;
  await nextTick();
  const host = probeHost.value;
  if (!host) return;
  const mode = result.value?.innerMode;
  probeHandle = mountPluginFrame(host, {
    pluginId: 'manual-matrix-probe',
    network: [],
    entry: 'index.html',
    files: [
      {
        path: 'index.html',
        mime: 'text/html',
        bytes: new TextEncoder().encode(buildManualMatrixProbe()),
      },
    ],
    theme: {},
    innerMode: mode === 'srcdoc' || mode === 'blob' ? mode : undefined,
    onViolation: () => {
      probeHandle = null;
    },
  });
}

function closeProbe() {
  disposeProbe();
  showProbe.value = false;
}

onBeforeUnmount(disposeProbe);
</script>

<template>
  <div class="selfcheck" data-testid="plugin-selfcheck">
    <div class="selfcheck-head">
      <div class="selfcheck-title">
        <h4>启动自检</h4>
        <span
          v-if="running"
          class="selfcheck-badge"
          data-state="running"
          data-testid="selfcheck-state"
          >检查中…</span
        >
        <span
          v-else-if="result?.ok"
          class="selfcheck-badge"
          data-state="pass"
          data-testid="selfcheck-state"
          >已通过</span
        >
        <span
          v-else-if="result"
          class="selfcheck-badge"
          data-state="fail"
          data-testid="selfcheck-state"
          >未通过</span
        >
        <span v-else class="selfcheck-badge" data-state="idle" data-testid="selfcheck-state"
          >未检查</span
        >
      </div>
      <AppButton
        variant="secondary"
        size="sm"
        :loading="running"
        data-testid="selfcheck-rerun"
        @click="rerun"
      >
        重新检查
      </AppButton>
    </div>

    <p class="selfcheck-desc">
      在这台机器、这个浏览器上验证插件窗口够不着本机与局域网。任何一项未通过，插件在所有存档里都不会运行。
    </p>

    <p v-if="result && !result.ok" class="selfcheck-alert" role="alert">
      未通过的项目：{{ failedLabels.join('、') || '未知' }}。插件已全部停用。
    </p>

    <template v-if="result">
      <p class="selfcheck-meta">
        <span>内层装载方式：{{ innerModeText }}</span>
        <span v-if="ranAtText">检查时间：{{ ranAtText }}</span>
      </p>
      <ul class="selfcheck-items">
        <li
          v-for="item in items"
          :key="item.id"
          class="selfcheck-item"
          :data-status="item.status"
          :data-item-id="item.id"
        >
          <span class="selfcheck-item-id">{{ item.id }}</span>
          <span class="selfcheck-item-name">{{ ITEM_LABELS[item.id] ?? item.id }}</span>
          <span class="selfcheck-item-status">{{ STATUS_LABELS[item.status] }}</span>
          <span class="selfcheck-item-detail">{{ item.detail }}</span>
        </li>
      </ul>
    </template>

    <div v-if="settings.settings.developerMode" class="selfcheck-dev" data-testid="selfcheck-dev">
      <div class="selfcheck-dev-head">
        <span>人工矩阵探针（开发者）</span>
        <AppButton
          v-if="!showProbe"
          variant="ghost"
          size="sm"
          data-testid="probe-open"
          @click="openProbe"
        >
          打开探针
        </AppButton>
        <AppButton v-else variant="ghost" size="sm" data-testid="probe-close" @click="closeProbe">
          关闭探针
        </AppButton>
      </div>
      <template v-if="showProbe">
        <ol class="selfcheck-dev-steps">
          <li>探针跑在与插件相同的沙盒和 CSP 里（未声明联网域名）。</li>
          <li>逐个点击探针里的按钮，结果会写在各节下方。</li>
          <li>WebRTC 与 preconnect 两项请同时抓包，确认没有发往本机或局域网的报文。</li>
          <li>在 Chromium、Firefox、Safari 上各跑一遍，结果写回插件设计文档 §4.8。</li>
        </ol>
        <div ref="probeHost" class="selfcheck-probe" data-testid="probe-host"></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.selfcheck {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
}

.selfcheck-head,
.selfcheck-dev-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}

.selfcheck-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}

.selfcheck-title h4 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
}

.selfcheck-badge {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-text-muted) 30%, transparent);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-text-muted) 10%, transparent);
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  font-weight: 600;
}

.selfcheck-badge[data-state='pass'] {
  border-color: color-mix(in srgb, var(--theme-success) 30%, transparent);
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
}

.selfcheck-badge[data-state='fail'] {
  border-color: color-mix(in srgb, var(--theme-error) 30%, transparent);
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
}

.selfcheck-desc,
.selfcheck-meta {
  margin: 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.selfcheck-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-lg);
}

.selfcheck-alert {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  color: var(--theme-error);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.selfcheck-items {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.selfcheck-item {
  display: grid;
  grid-template-columns: 3rem 10rem 4rem minmax(0, 1fr);
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  font-size: 0.75rem;
  line-height: 1.5;
}

.selfcheck-item[data-status='fail'] {
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-error) 6%, transparent);
}

.selfcheck-item-id {
  color: var(--theme-text-muted);
  font-family: 'Cascadia Code', monospace;
}

.selfcheck-item-name {
  color: var(--theme-text-primary);
  font-weight: 500;
}

.selfcheck-item-status {
  color: var(--theme-text-secondary);
  font-weight: 600;
}

.selfcheck-item[data-status='pass'] .selfcheck-item-status {
  color: var(--theme-success);
}

.selfcheck-item[data-status='fail'] .selfcheck-item-status {
  color: var(--theme-error);
}

.selfcheck-item-detail {
  color: var(--theme-text-secondary);
  overflow-wrap: anywhere;
}

.selfcheck-dev {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px dashed var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.selfcheck-dev-steps {
  margin: 0;
  padding-left: var(--theme-spacing-xl);
  line-height: 1.6;
}

.selfcheck-probe {
  height: 28rem;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  overflow: hidden;
}

@media (max-width: 640px) {
  .selfcheck-item {
    grid-template-columns: 3rem minmax(0, 1fr) auto;
  }

  .selfcheck-item-detail {
    grid-column: 1 / -1;
  }
}
</style>
