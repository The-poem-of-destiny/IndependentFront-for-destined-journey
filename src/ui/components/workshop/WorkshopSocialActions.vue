<script setup lang="ts">
/**
 * 点赞 / 订阅按钮对 —— 卡片与详情**共用的唯一**社交动作入口（Phase 3 / P3c）
 *
 * 为什么两处共用一个组件而不是各写一份: 这对按钮背后有四条分支（未登录引导、
 * 节流跳过、401 退回登录、失败提示），四条的处置与文案必须一模一样。分头写之后，
 * 卡片上说「请先登录」而详情里弹一条红色报错，用户会以为自己遇到了两个毛病。
 *
 * 三条纪律:
 *
 * 1. **不编数字**（§3.3）—— 显示值只由 store 的 `socialOf`（override ?? 本次响应）
 *    给；它给不出来就**整个计数不渲染**。写个 0 顶上去等于向用户断言「没人赞过」，
 *    而我们其实只是不知道。
 * 2. **未登录一发请求都不出去** —— 本组件先判 `isLoggedIn` 再调 store（store 里
 *    还有第二道），未登录时只把「去登录」说清楚。
 * 3. **点击不许冒泡**（`@click.stop`）—— 卡片整块是「打开详情」的点击区，赞一下就
 *    弹出一个详情模态是最讨厌的一种误触。
 *
 * 乐观更新/校正/回滚/节流全在 store 里（D23），本组件只渲染状态。
 */
import { computed } from 'vue';
import type { WorkshopSocialMeta } from '@engine/workshop-types';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopSocialStore } from '../../stores/workshop-social-store';
import type { WorkshopToggleOutcome } from '../../stores/workshop-social-store';
import { WORKSHOP_LOGIN_GUIDE } from './failure-text';

const props = defineProps<{
  projectId: string;
  /**
   * 本次列表/详情响应顺带带回来的社交值。**不是**最终显示值 —— 交给 store 的
   * `socialOf` 与 override 层比一次才是（§3.3）。
   */
  social?: WorkshopSocialMeta;
  /** `compact` 卡片角落的小按钮；`full` 详情底栏的大按钮 */
  variant?: 'compact' | 'full';
  /** 是否显示下载数（仅详情）。⚠️ 该数只供展示，不做任何逻辑依赖（§1.3） */
  showDownloads?: boolean;
}>();

const ui = useUIStore();
const socialStore = useWorkshopSocialStore();

/** §3.3 的唯一读取规则收在 store 里，这里只问一次 */
const shown = computed<WorkshopSocialMeta | undefined>(() =>
  socialStore.socialOf(props.projectId, props.social),
);

const liked = computed(() => shown.value?.userLiked === true);
const subscribed = computed(() => shown.value?.userSubscribed === true);
const likeBusy = computed(() => socialStore.isBusy(props.projectId, 'like'));
const subscribeBusy = computed(() => socialStore.isBusy(props.projectId, 'subscribe'));

const isFull = computed(() => props.variant === 'full');

async function act(kind: 'like' | 'subscribe'): Promise<void> {
  if (!socialStore.isLoggedIn) {
    ui.toast(WORKSHOP_LOGIN_GUIDE, 'info');
    return;
  }
  const outcome: WorkshopToggleOutcome =
    kind === 'like'
      ? await socialStore.toggleLike(props.projectId, props.social)
      : await socialStore.toggleSubscribe(props.projectId, props.social);

  if (outcome.status === 'unauthorized') {
    // token 被上游拒了（store 已顺手登出）——同样是引导，不是报错
    ui.toast(WORKSHOP_LOGIN_GUIDE, 'info');
  } else if (outcome.status === 'failed') {
    ui.toast(`${kind === 'like' ? '点赞' : '订阅'}失败：${outcome.message}`, 'error');
  }
  // ok / skipped 一律不吭声: 结果已经在屏幕上了，再弹一条只是噪音
}
</script>

<template>
  <div class="wk-social" :class="{ 'social-full': isFull }">
    <button
      type="button"
      class="wk-social-btn"
      :class="{ 'is-active': liked }"
      :aria-pressed="liked"
      :aria-label="liked ? `取消点赞（当前 ${shown?.likesCount ?? 0}）` : '点赞'"
      :aria-busy="likeBusy || undefined"
      :disabled="likeBusy"
      @click.stop="act('like')"
    >
      <span class="wk-social-icon" aria-hidden="true">♥</span>
      <span v-if="isFull" class="wk-social-word">点赞</span>
      <!-- 计数只在真有数据时出现（§3.3），没有就整格不渲染 —— 不编数字 -->
      <span v-if="shown" class="wk-social-count">{{ shown.likesCount }}</span>
    </button>

    <button
      type="button"
      class="wk-social-btn"
      :class="{ 'is-active': subscribed }"
      :aria-pressed="subscribed"
      :aria-label="subscribed ? `取消订阅（当前 ${shown?.subscribesCount ?? 0}）` : '订阅'"
      :aria-busy="subscribeBusy || undefined"
      :disabled="subscribeBusy"
      @click.stop="act('subscribe')"
    >
      <span class="wk-social-icon" aria-hidden="true">★</span>
      <span v-if="isFull" class="wk-social-word">订阅</span>
      <span v-if="shown" class="wk-social-count">{{ shown.subscribesCount }}</span>
    </button>

    <span v-if="showDownloads && shown" class="wk-social-downloads">
      下载 {{ shown.downloadsCount }}
    </span>
  </div>
</template>

<style scoped>
.wk-social {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
}
.social-full {
  gap: var(--theme-spacing-sm);
}

.wk-social-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 触摸目标 ≥ 36px 只对 full 强求；卡片角落那对是次要动作，26px 已是同类 chip 的高度 */
  min-height: 26px;
  padding: 2px 8px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-muted);
  font-family: inherit;
  font-size: 0.6875rem;
  line-height: 1.7;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.social-full .wk-social-btn {
  min-height: 36px;
  padding: 6px 14px;
  font-size: 0.8125rem;
}

.wk-social-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.wk-social-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.wk-social-btn:disabled {
  opacity: 0.55;
  cursor: progress;
}

/* 激活态：染底 + 混合边框（design.md §1 通用配方），不用侧边条 */
.is-active {
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  color: var(--theme-primary);
  font-weight: 600;
}

.wk-social-icon {
  font-size: 0.8em;
  line-height: 1;
}
.social-full .wk-social-icon {
  font-size: 0.95em;
}

/*
 * 计数用等宽数字 + 保底宽度: 9→10 的那一位进位不该把整排按钮往外顶一下。
 * 这是本组件里唯一会频繁变的字符，抖动只可能从这里来。
 */
.wk-social-count {
  min-width: 1.5em;
  text-align: left;
  font-variant-numeric: tabular-nums;
}

.wk-social-downloads {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .wk-social-btn {
    transition: none;
  }
}
</style>
