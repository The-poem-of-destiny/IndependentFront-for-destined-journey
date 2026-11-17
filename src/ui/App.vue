<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useUIStore, type AppView } from './stores/ui-store';
import { useAudioStore } from './stores/audio-store';
import { useAssetStore } from './stores/asset-store';
import { useSettingsStore } from './stores/settings-store';
import { useApiSourceStore } from './stores/api-source-store';
import { useWorldBookStore } from './stores/worldbook-store';
import { useBeautifierStore } from './stores/beautifier-store';
import { useWorkshopStore } from './stores/workshop-store';
import { queryForView } from './lib/view-audio';
import { applyReducedMotion } from './lib/reduced-motion';
import { syncFxGate, useFxEnabled } from './lib/fx-gate';
import { runContentStartupChain } from './lib/content-startup-chain';
import { createViewRegistry } from './lib/view-loader';
import ViewLoading from './components/shared/ViewLoading.vue';
import ToastContainer from './components/shared/ToastContainer.vue';
import ConfirmDialogHost from './components/shared/ConfirmDialogHost.vue';
import ApiRateLimitWaitPopup from './components/shared/ApiRateLimitWaitPopup.vue';
import SaveManager from './components/shared/SaveManager.vue';
import FxLayer from './components/fx/FxLayer.vue';

const ui = useUIStore();
const audio = useAudioStore();
const assets = useAssetStore();
const settings = useSettingsStore();
const apiSources = useApiSourceStore();
const worldbooks = useWorldBookStore();
const beautifier = useBeautifierStore();
const workshop = useWorkshopStore();

void settings.initApiSecrets().then((outcome) => {
  if (outcome.status === 'failed') {
    ui.toast(
      'API 密钥无法迁移到安全存储；旧密钥仍保留，本次会话不会覆盖原设置。请检查浏览器存储后重试。',
      'error',
      // 启动期关键错误常驻到用户手动关闭（审查 G-06）
      0,
    );
    return;
  }
  void apiSources.initialize().catch(() => {
    ui.toast('API 配置迁移失败；远端调用已暂停，请在设置页重试。', 'error', 0);
  });
});

// ═══ 世界书（Phase 0 / 设计 D4）═══════════════════════════
//
// 必须在**任何**世界书消费之前跑：init() 会把 localStorage 里的书搬进 Dexie
// 并删掉 localStorage 副本，之后 `settings.worldBooks` 就不存在了。
// 这里只负责尽早踢一脚；三个消费端（game-pipeline / create-store / SettingsPage）
// 各自也 `await init()` —— init() 幂等且并发共用同一个 Promise，
// 所以「谁先到谁等着」，不依赖本处的时序。
//
// 工坊正则还要按「当前存档启用了哪个工坊项目」隔离，所以世界书就绪后接着水合项目
// 元数据，让首屏正文就能将工坊条目 UID 对应到 workshop:<projectId> 规则绑定。
//
// 远程素材同步（远程素材 v1）挂在这条链的末尾：它的声明有一半住在世界书条目正文里
// （含工坊装进来的书），所以必须排在那两步之后。**只是踢一脚** —— 真正的前置等待
// 在 `syncRemoteAssets()` 内部（那几个 init 都幂等，且设置页的「立即同步」不经过这条链，
// 所以门必须在 action 里，不能只靠这里的顺序）。
// 它自己永不抛、永不阻塞启动；失败只进 console.warn 与 store 的 `remoteSync` 状态。
// 工坊那一步单独兜底：它读库失败会 reject，但不能因此跳过远程素材同步（见 content-startup-chain.ts）。
void runContentStartupChain({ worldbooks, workshop, assets });

// ═══ 美化规则（Phase 0b）═════════════════════════════════
//
// 同理：init() 把用户规则搬进 Dexie 并删掉 localStorage 副本，同时丢弃
// `beautifierPresetRules` 那份 ~378 KB 的派生缓存，改为纯内存持有。
// 必须在游戏页首次美化正文之前跑完，否则规则列表是空的 → 正则不生效。
// init() 幂等，消费端（ChatFlow via useBeautify / BeautifierSection）各自也会 await。
void beautifier.init().catch(() => {
  /* 同上：不该拦住应用启动 */
});

// ═══ 减少动态效果（应用内开关）═══════════════════════════
//
// 把 `settings.reducedMotion` 同步到 `<html data-reduced-motion>`，CSS 据此关掉全站
// 动画（themes/variables.css）。`immediate` 是必须的：设置从 localStorage 水合回来
// 时不会触发变更回调，少了它，开着这个选项的用户重启后会先看到一轮完整动画。
//
// 系统的 `prefers-reduced-motion` 由 CSS 那条媒体查询独立负责，与本开关是或的关系
// —— 所以这里只写 true/false，不去读系统偏好。
watch(
  () => settings.settings.reducedMotion,
  (enabled) => applyReducedMotion(Boolean(enabled)),
  { immediate: true },
);

// ═══ 界面特效闸门 ═══════════════════════════════════════
//
// `<html data-fx="on">` = 设置 `visualEffects` 开 **且** 不处于减动效（系统偏好 ∪ 应用内开关）。
// 判定与写入唯一在 lib/fx-gate.ts。🔴 本 watch 必须声明在上面那个减动效 watch **之后**：
// 同为 pre 刷新的 watch 按创建顺序执行，syncFxGate 读的是刚写好的 `data-reduced-motion`。
// `immediate` 的理由同上（水合不触发回调）。系统偏好不经过 settings，单独听 matchMedia。
// 📌 只靠声明顺序不够：同一拍里两项都变时，队列按**触发**顺序排 —— 先改 visualEffects 会让本
// watch 排在减动效 watch 前面、读到上一拍的属性。所以这里先把减动效写一遍（幂等）再开关闸。
const fxEnabled = useFxEnabled();
watch(
  () => [settings.settings.visualEffects, settings.settings.reducedMotion] as const,
  ([fxOn, reduced]) => {
    applyReducedMotion(Boolean(reduced));
    syncFxGate(fxOn !== false);
  },
  { immediate: true },
);

let reducedMotionQuery: MediaQueryList | undefined;
function onSystemMotionChange(): void {
  syncFxGate(settings.settings.visualEffects !== false);
}
onMounted(() => {
  if (typeof matchMedia !== 'function') return;
  try {
    reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionQuery.addEventListener?.('change', onSystemMotionChange);
  } catch {
    reducedMotionQuery = undefined;
  }
});
onUnmounted(() => {
  reducedMotionQuery?.removeEventListener?.('change', onSystemMotionChange);
  syncFxGate(false);
});

// ═══ 界面级场景配乐 ═══════════════════════════════════════
//
// 曲库在这里装（幂等）—— 首页也要出声，不能等进了游戏页才装库。
// GamePage 仍会再调一次 init()，那时直接空转。
void audio.init().catch(() => {
  /* 音频装不起来不该影响应用启动 */
});

// ═══ 素材库 ═══════════════════════════════════════════════
//
// 与曲库同一个理由、同一个位置: 素材要在**游戏页与捏人页**里渲染，而那两处
// 都不经过设置页。此前 init() 只在 settings/AssetSection.vue 的 onMounted 里
// 调，于是没进过设置页的会话里，库恒为空 —— 表现成「导入过的头像不显示」。
// init() 幂等（内部 `initialized` 闸），AssetSection 照旧再调一次即空转。
void assets.init().catch(() => {
  /* 素材库装不起来不该影响应用启动 */
});

watch(
  () => ui.currentView,
  (view) => {
    // 与地点配乐共用同一个开关 —— 一个开关关掉全部自动换歌，不设第二个
    if (settings.settings.audioSceneAutoPlay === false) return;
    const query = queryForView(view);
    if (!query) return; // 游戏页 / 设置页 / 工坊：不动音乐，理由见 view-audio.ts
    void audio.playByScene(query).catch(() => {
      /* 配乐是旁路，出错不影响导航 */
    });
  },
  { immediate: true },
);

// ═══ 页面懒加载（动效 v1，2026-11-16）═══════════════════════
//
// 六个页面仍按需加载，但「载好没有」由 lib/view-loader.ts 显式持有：没载好渲染
// ViewLoading，载好后换成真页面 —— 这是 Transition 看得见的一次子节点变化，所以
// 每次进入页面都有入场动画，也不再有「旧页淡出后一整段纯黑」。
// 不用 defineAsyncComponent 的原因见 view-loader.ts 文件头。
const views = createViewRegistry<AppView>({
  home: () => import('./components/home/HomePage.vue'),
  create: () => import('./components/create/CreatePage.vue'),
  game: () => import('./components/game/GamePage.vue'),
  settings: () => import('./components/settings/SettingsPage.vue'),
  extensions: () => import('./components/workshop/ExtensionManagementPage.vue'),
  workshop: () => import('./components/workshop/WorkshopPage.vue'),
});

watch(
  () => ui.currentView,
  (view) => void views.ensure(view),
  { immediate: true },
);

// 首页开场动画（星流）跑完之前不抢主线程；之后按「最可能的下一站」逐个空闲预取
let stopPrefetch: (() => void) | undefined;
onMounted(() => {
  stopPrefetch = views.prefetch(['create', 'game', 'settings', 'extensions', 'workshop'], {
    startDelayMs: 2500,
  });
});
onUnmounted(() => stopPrefetch?.());

const viewComponent = computed(() => views.resolved(ui.currentView) ?? ViewLoading);

/**
 * 切换正在游玩的存档时重挂 GamePage；其它页面仍只按视图身份重挂。
 * 加载态单独一个 key：载好时 key 变化，Transition 才会把加载态换成真页面并播放入场。
 */
const viewKey = computed(() => {
  const view = ui.currentView;
  if (!views.resolved(view)) return `loading:${view}`;
  return view === 'game' ? `game:${ui.activeSaveId ?? 'none'}` : view;
});

/** 只有加载态吃这两个 prop；真页面不收任何 prop（与旧实现一致） */
const viewProps = computed(() =>
  views.resolved(ui.currentView)
    ? {}
    : { failed: views.failed(ui.currentView), onRetry: () => void views.ensure(ui.currentView) },
);
</script>

<template>
  <div class="app-shell">
    <transition name="view" mode="out-in">
      <component :is="viewComponent" :key="viewKey" v-bind="viewProps" />
    </transition>
    <SaveManager />
    <ToastContainer />
    <ConfirmDialogHost />
    <ApiRateLimitWaitPopup />
    <FxLayer v-if="fxEnabled" />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--theme-window-bg);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body);
  transition:
    background var(--motion-duration-slow) var(--motion-ease-standard),
    color var(--motion-duration-slow) var(--motion-ease-standard);
}
</style>
