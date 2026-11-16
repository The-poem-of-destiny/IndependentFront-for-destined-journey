<script setup lang="ts">
/**
 * 开发期「内容源」开关 —— 已安装内容包 vs 本地内容目录（`/data/*`）
 *
 * 🔴 只在开发构建里出现：ContentPackSection 以
 *    `import.meta.env.DEV ? defineAsyncComponent(...) : null` 挂载本组件，
 *    生产构建整块被摇掉（连同偏好键名）。
 *
 * 切换流程：确认 → 写偏好 → 整页重载。取消则什么都不写。
 * 内容包行始终留在 Dexie，选「本地内容目录」只是不激活它；
 * 存档里的内容 uid 不会随之迁移，所以提示用测试存档验证。
 */
import { computed, ref } from 'vue';
import AppCard from '../shared/AppCard.vue';
import { confirmDialog } from '../../lib/confirm-dialog';
import {
  describeDevContentNotices,
  readDevContentSourcePreference,
  writeDevContentSourcePreference,
  type DevContentSourcePreference,
} from '../../lib/dev-content-source';
import { useContentStore } from '../../stores/content-store';

const content = useContentStore();

const OPTIONS: { key: DevContentSourcePreference; label: string; hint: string }[] = [
  { key: 'local', label: '本地内容目录', hint: '不激活已安装的内容包，改读 /data 下的本地内容' },
  { key: 'pack', label: '内容包', hint: '有已安装的内容包就用包（默认）' },
];

const resolution = computed(() => content.devContentSource);
/** store 尚未 hydrate 时回落到本地存储里的偏好，保证开关不会显示错位 */
const current = computed<DevContentSourcePreference>(
  () => resolution.value?.preference ?? readDevContentSourcePreference(),
);
const noticeTexts = computed(() => describeDevContentNotices(resolution.value?.notices ?? []));
const suppressedPack = computed(() =>
  resolution.value?.suppressPack ? resolution.value.suppressedPack : null,
);

const switching = ref(false);

async function choose(next: DevContentSourcePreference): Promise<void> {
  if (next === current.value || switching.value) return;
  switching.value = true;
  try {
    const label = OPTIONS.find((o) => o.key === next)?.label ?? next;
    const ok = await confirmDialog({
      title: '切换内容源（开发）',
      message: `切换到「${label}」后将重新加载页面。`,
      details: [
        '已安装的内容包仍保留在本地数据库，只是不激活或重新激活。',
        '存档里的内容 uid 不会随之迁移，请用测试存档验证。',
      ],
      confirmLabel: '切换并重载',
    });
    if (!ok) return;
    writeDevContentSourcePreference(next);
    location.reload();
  } finally {
    switching.value = false;
  }
}
</script>

<template>
  <AppCard padding="md" class="dev-source-card" data-testid="dev-content-source-card">
    <div class="dev-source-head">
      <h4>内容源</h4>
      <span class="dev-source-badge"
        ><i class="fa-solid fa-code" aria-hidden="true" /> 仅开发构建</span
      >
    </div>
    <p class="card-desc">
      选择开发时读取的内容来源。生产构建中没有这个开关，始终使用已安装的内容包。
    </p>
    <div class="mode-list" role="radiogroup" aria-label="开发内容源">
      <button
        v-for="o in OPTIONS"
        :key="o.key"
        type="button"
        class="mode-item"
        :class="{ 'mode-active': current === o.key }"
        role="radio"
        :aria-checked="current === o.key"
        :disabled="switching"
        :data-source="o.key"
        @click="choose(o.key)"
      >
        <span class="mode-label">{{ o.label }}</span>
        <span class="mode-hint">{{ o.hint }}</span>
      </button>
    </div>
    <p v-if="suppressedPack" class="dev-source-suppressed text-sm">
      已安装的内容包 <code>{{ suppressedPack.packId }}</code> v{{ suppressedPack.packVersion }}
      保留在本地数据库中，当前未启用。
    </p>
    <ul v-if="noticeTexts.length" class="dev-source-notices">
      <li v-for="text in noticeTexts" :key="text">{{ text }}</li>
    </ul>
    <p class="form-hint dev-source-hint">
      切换不会迁移存档里的内容 uid，请用测试存档验证，不要拿正式存档来回切。
    </p>
  </AppCard>
</template>

<!-- 共用外壳（.card-desc / .form-hint）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* 开发工具卡：警示色细边 + 浅染底，一眼区别于玩家可见的卡片（design.md 禁侧边条，用全边） */
.dev-source-card {
  border-color: color-mix(in srgb, var(--theme-warning) 45%, var(--theme-card-border)) !important;
  border-style: dashed !important;
  background: color-mix(in srgb, var(--theme-warning) 5%, var(--theme-card-bg)) !important;
}
.dev-source-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
}
.dev-source-head h4 {
  margin: 0;
  font-size: 0.95rem;
}
.dev-source-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: calc(var(--theme-spacing-xs) / 2) var(--theme-spacing-sm);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 35%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  font-size: 0.6875rem;
  line-height: 1.5;
}

/* 二选一：沿用图像生成卡的 mode-* 块级单选外壳，每项带一行后果说明 */
.mode-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-md);
}
.mode-item {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-height: 36px;
  padding: 10px var(--theme-spacing-md);
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.mode-item:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.mode-item:disabled {
  cursor: progress;
  opacity: 0.7;
}
.mode-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.mode-label {
  font-size: 0.9rem;
  font-weight: 600;
}
.mode-active .mode-label {
  color: var(--theme-primary);
}
.mode-hint {
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}

.dev-source-suppressed {
  margin: 0 0 var(--theme-spacing-sm);
  color: var(--theme-text-secondary);
}
.dev-source-notices {
  margin: 0 0 var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  list-style: none;
  font-size: 0.8rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
  background: color-mix(in srgb, var(--theme-warning) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-md);
}
.dev-source-notices li + li {
  margin-top: var(--theme-spacing-xs);
}
.dev-source-hint {
  margin: 0;
}
</style>
