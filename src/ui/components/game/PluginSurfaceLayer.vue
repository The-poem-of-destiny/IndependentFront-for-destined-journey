<script setup lang="ts">
/**
 * PluginSurfaceLayer.vue — 游戏页的插件界面图层（插件系统设计 §4.7、§5.7、§6.5）
 *
 * 挂在 GamePage 的游戏区定位容器里（overlay 形态是 `position:absolute; inset:0`），负责：
 *
 * 1. 按 `pluginRuntime.openSurfaces` 渲染 PluginSurface：
 *    - `window` / `overlay` 一律在这里画；
 *    - `panel` 形态**属于 `panel.items.footer`** 的界面由 ItemsPanel 自己内联渲染（它才有那个具名插槽），
 *      这里跳过；别的贡献点上声明成 `panel` 的界面没有面板可挂，在这里退化成浮动窗。
 * 2. 插件外链弹窗（PluginExternalLinkModal，宿主从不替插件打开链接）。
 * 3. 跨标签页锁横幅（§6.5）：锁拿不到 / 浏览器不支持时插件写入已暂停，给「重试」。
 *
 * 🔴 插件窗口**不占** `game.activeModal`（§5.7）：那是页面级弹窗的单选位，
 *    插件窗口与迷你播放器一样是浮动卡片，开着插件窗也能同时打开背包。
 * 🔴 层级：store 的 `zIndex` 单调递增（每次聚焦 +1），这里不直接拿来当 CSS 值，
 *    而是按它排序后取名次 —— 名次有上限，插件窗永远压不过页面级弹窗（--z-modal-backdrop 300）。
 * overlay 同一时刻至多一个由 store 保证（开新关旧），本图层只照单渲染。
 */
import { computed } from 'vue';
import { usePluginRuntimeStore, type PluginOpenSurface } from '../../stores/plugin-runtime-store';
import { usePluginContributions } from '../../composables/usePluginContributions';
import PluginSurface, { type PluginSurfaceMode } from './PluginSurface.vue';
import PluginExternalLinkModal from './PluginExternalLinkModal.vue';
import AppButton from '../shared/AppButton.vue';

const rt = usePluginRuntimeStore();
const contributions = usePluginContributions();

/** 浮动窗层级起点：高于 overlay（--z-sticky 200），低于页面级弹窗遮罩（300） */
const WINDOW_Z_BASE = 210;
/** 名次上限：窗口再多也不越过弹窗遮罩 */
const WINDOW_Z_SPAN = 80;

/** 由图层渲染的界面及其实际形态 */
const layerSurfaces = computed<{ surface: PluginOpenSurface; mode: PluginSurfaceMode }[]>(() =>
  rt.openSurfaces
    .filter(
      (s) =>
        s.mode !== 'panel' ||
        contributions.slotOf(s.pluginId, s.contributionId) !== 'panel.items.footer',
    )
    .map((s) => ({ surface: s, mode: s.mode === 'panel' ? 'window' : s.mode })),
);

/** surfaceId → 浮动窗 CSS 层级（按 store 的聚焦序取名次） */
const windowZ = computed<Map<string, number>>(() => {
  const ordered = [...rt.openSurfaces].sort((a, b) => a.zIndex - b.zIndex);
  return new Map(
    ordered.map((s, rank) => [s.surfaceId, WINDOW_Z_BASE + Math.min(rank, WINDOW_Z_SPAN)]),
  );
});

/** 横幅文案（§6.5）；锁正常持有或已释放时不显示 */
const lockMessage = computed<string | null>(() => {
  if (rt.lockState === 'waiting') {
    return '另一个标签页正在使用这个存档，本页的插件写入已暂停。那边关闭或离开存档后会自动恢复。';
  }
  if (rt.lockState === 'unsupported') {
    return '当前浏览器环境不支持跨标签页锁（需要通过 localhost 或 HTTPS 访问），插件写入已禁用。';
  }
  return null;
});

function retryLock(): void {
  void rt.retryLock();
}
</script>

<template>
  <div class="plugin-surface-layer">
    <div v-if="lockMessage" class="psl-lock-banner" role="status" data-testid="plugin-lock-banner">
      <i class="fa-solid fa-lock psl-lock-icon" aria-hidden="true" />
      <span class="psl-lock-text">{{ lockMessage }}</span>
      <AppButton variant="secondary" size="sm" data-testid="plugin-lock-retry" @click="retryLock">
        重试
      </AppButton>
    </div>

    <PluginSurface
      v-for="{ surface: s, mode } in layerSurfaces"
      :key="s.surfaceId"
      :plugin-id="s.pluginId"
      :plugin-name="s.pluginName"
      :networked="s.networked"
      :mode="mode"
      :title="s.title"
      :width="s.width"
      :height="s.height"
      :z-index="windowZ.get(s.surfaceId)"
      :requested-size="s.requestedSize"
      :mount-frame="rt.mountFrameFor(s.surfaceId)"
      :data-surface-id="s.surfaceId"
      @close="rt.closeSurface(s.surfaceId)"
      @focus="rt.focusSurface(s.surfaceId)"
    />

    <PluginExternalLinkModal
      v-if="rt.externalLink"
      :plugin-name="rt.externalLink.pluginName"
      :url="rt.externalLink.url"
      @close="rt.closeExternalLink()"
    />
  </div>
</template>

<style scoped>
/* 图层本身不占位、不挡点击：只有横幅与各界面自己接收指针 */
.plugin-surface-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.plugin-surface-layer > * {
  pointer-events: auto;
}

/* §6.5 锁横幅：游戏区顶部居中的一条提示，不遮正文主体 */
.psl-lock-banner {
  position: absolute;
  top: var(--theme-spacing-sm);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-dropdown);
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  max-width: min(42rem, calc(100% - var(--theme-spacing-xl)));
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-warning, var(--theme-primary)) 45%, transparent);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack, var(--theme-shadow-sm));
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--theme-text-primary);
}
.psl-lock-icon {
  flex-shrink: 0;
  color: var(--theme-warning, var(--theme-primary));
}
.psl-lock-text {
  flex: 1;
  min-width: 0;
}
</style>
