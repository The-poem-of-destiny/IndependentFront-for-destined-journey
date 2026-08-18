<script setup lang="ts">
/**
 * ③ 远程素材条 —— 总开关 + 立即同步 + 上次同步的结果行（远程素材 v1）
 *
 * 与 `AssetImportStrip` 是同一类东西（第三条**获取**素材的路径），所以视觉沿用
 * 它那副 `.io-strip` 外壳；开关沿用设置页共用的 `.toggle-*`（`settings-chrome.css`
 * 一份源码、各自作用域），不自画第二种开关样式。
 *
 * 本组件**不做任何判断**: 同步跑不跑、跑出什么、文案怎么写，全在 store 与
 * `lib/remote-asset-sync.ts`（结果行用的就是那边导出的 `formatRemoteSyncCounts`，
 * 与 toast 同一份措辞 —— 两处各写一份的下场是提示与面板说出不同的数字）。
 */
import { computed } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import { useAssetStore } from '../../../stores/asset-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { formatRemoteSyncCounts } from '../../../lib/remote-asset-sync';

const emit = defineEmits<{
  /** 一次性事件的无障碍播报，由外层写进唯一的 aria-live 区 */
  (e: 'announce', message: string): void;
}>();

const assets = useAssetStore();
const settings = useSettingsStore();

const s = settings.settings;

/**
 * 上次同步的结果行。
 *
 * 三态刻意分开：从没跑过（本次会话）/ 开关关着 / 跑过了。把「没跑」显示成一排 0
 * 会让人以为同步跑过而且什么都没找到 —— 那两件事的下一步动作完全不同。
 */
const lastLine = computed<string>(() => {
  const r = assets.remoteSync.lastResult;
  if (r === null) return '本次启动后还没有同步过。';
  return `上次同步：${formatRemoteSyncCounts(r)}`;
});

/** 失败逐条点名（部分成功要如实说，与导入回执同一条纪律） */
const failures = computed(() => assets.remoteSync.lastResult?.failed ?? []);

async function runSync(): Promise<void> {
  const res = await assets.syncRemoteAssets();
  emit(
    'announce',
    res === null ? '远程素材同步没有执行。' : `远程素材同步完成：${formatRemoteSyncCounts(res)}`,
  );
}
</script>

<template>
  <h4 class="band-title">远程素材</h4>
  <p class="band-note text-muted text-sm">
    有些角色卡（世界书条目）与内容包会写明立绘的网址。打开后，引擎会按这些声明把图下到
    本地素材库，并<strong>只管自己下的那些</strong>——你自己导入的同名图永远优先，不会被覆盖；
    声明里删掉的图会跟着从库里移除。
  </p>

  <div class="io-strip">
    <span class="io-label">自动同步</span>
    <span class="io-hint">
      每次启动检查一次。关掉之后完全不动素材库（已经下好的图照样留着）。
    </span>
    <span class="toggle-label">
      <input v-model="s.remoteAssetsEnabled" type="checkbox" class="toggle-input" />
      <span class="toggle-slider"></span>
    </span>
    <AppButton
      variant="secondary"
      size="sm"
      :disabled="assets.remoteSync.running || !s.remoteAssetsEnabled"
      @click="runSync"
    >
      {{ assets.remoteSync.running ? '正在同步…' : '立即同步' }}
    </AppButton>
  </div>

  <p class="sync-line">{{ lastLine }}</p>
  <p v-for="f in failures" :key="f.url" class="sync-fail">
    下载失败：{{ f.url }}（{{ f.reason }}）
  </p>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
/* ═══ 分段标题 + 装饰线（与 AssetImportStrip 同一副） ═══ */
.band-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-sm);
}
.band-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.band-note {
  margin: 0 0 var(--theme-spacing-md);
  line-height: 1.55;
}

/* ═══ 条状分组外壳 —— 与导入条逐值一致 ═══ */
.io-strip {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  margin-bottom: var(--theme-spacing-sm);
}
.io-label {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.io-hint {
  flex: 1;
  min-width: 12rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}

.sync-line {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-variant-numeric: tabular-nums;
}
.sync-fail {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-error);
  word-break: break-all;
}
</style>
