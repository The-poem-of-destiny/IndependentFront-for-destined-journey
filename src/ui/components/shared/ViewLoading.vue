<script setup lang="ts">
/**
 * 顶层页面的加载态（动效 v1，2026-11-16）—— App.vue 在页面模块还没到手时渲染它。
 *
 * - 前 200ms 什么都不画：绝大多数切换（尤其预取过的）在这之前就载完了，
 *   一闪而过的加载态比空白更扰人。延迟由入场动画的 delay 实现，不用定时器。
 * - 载失败时给「重试」：开发服务器重启 / 网络中断时模块请求会失败，
 *   旧实现（defineAsyncComponent，无 errorComponent）只会留下一整屏空白。
 * - 离场是瞬时的（styles/transitions.css 的 `.view-loading.view-leave-active`），
 *   真页面载好后直接入场，不为一个加载态多等一段淡出。
 */
import AppButton from './AppButton.vue';

defineProps<{ failed?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="view-loading" role="status" aria-live="polite">
    <template v-if="!failed">
      <span class="vl-mark" aria-hidden="true">
        <span class="vl-ring" />
        <span class="vl-arc" />
        <span class="vl-core" />
      </span>
      <p class="vl-text">正在展开书页…</p>
    </template>
    <template v-else>
      <p class="vl-text">这一页没能载入。</p>
      <p class="vl-hint">开发服务器刚重启或网络中断时会这样，重试即可。</p>
      <AppButton variant="secondary" size="sm" @click="emit('retry')">重试</AppButton>
    </template>
  </div>
</template>

<style scoped>
.view-loading {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-md);
  color: var(--theme-text-muted);
  animation: vl-appear var(--motion-duration-slow) var(--motion-ease-standard) 200ms backwards;
}
@keyframes vl-appear {
  from {
    opacity: 0;
  }
}

/* 星盘式标记：静止的外环 + 缓转的弧 + 中心一点。减动效下弧停在原位，仍是一个完整的图形 */
.vl-mark {
  position: relative;
  width: 44px;
  height: 44px;
}
.vl-ring,
.vl-arc,
.vl-core {
  position: absolute;
  border-radius: 50%;
}
.vl-ring {
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
}
.vl-arc {
  inset: 5px;
  border: 1.5px solid transparent;
  border-top-color: var(--theme-primary);
  border-right-color: color-mix(in srgb, var(--theme-primary) 35%, transparent);
  animation: vl-spin 1.4s var(--motion-ease-standard) infinite;
}
.vl-core {
  inset: 19px;
  background: color-mix(in srgb, var(--theme-primary) 70%, transparent);
}
@keyframes vl-spin {
  to {
    transform: rotate(360deg);
  }
}

.vl-text {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  letter-spacing: 0.08em;
}
.vl-hint {
  margin: 0;
  font-size: 0.75rem;
}
</style>
