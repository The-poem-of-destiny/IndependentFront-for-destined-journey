<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { subscribeApiRpmWaits } from '@engine/api-rpm-limiter';
import type { ApiRpmWaitItem } from '@engine/types';
import { useUIStore } from '../../stores/ui-store';
import AppButton from './AppButton.vue';
import AppCard from './AppCard.vue';

const ui = useUIStore();
const waits = ref<ApiRpmWaitItem[]>([]);
const now = ref(Date.now());
let unsubscribe: (() => void) | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

const visible = computed(() => waits.value.length > 0);

function countdown(resumeAt: number): string {
  const seconds = Math.max(0, Math.ceil((resumeAt - now.value) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function openSettings() {
  ui.openSettings('api');
}

onMounted(() => {
  unsubscribe = subscribeApiRpmWaits((snapshot) => {
    waits.value = snapshot.waits;
    now.value = Date.now();
  });
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  if (clock !== undefined) clearInterval(clock);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="rpm-popup">
      <AppCard v-if="visible" class="rpm-popup" padding="md" role="status" aria-live="polite">
        <div class="rpm-popup-title">
          <span class="rpm-popup-mark" aria-hidden="true">!</span>
          <strong>API 请求已达到 RPM 限制</strong>
        </div>
        <div class="rpm-popup-list">
          <div v-for="wait in waits" :key="wait.credentialId" class="rpm-popup-row">
            <div class="rpm-popup-copy">
              <strong>{{ wait.label }}</strong>
              <span> {{ wait.rpmLimit }} RPM · {{ wait.queuedCount }} 个请求正在等待 </span>
              <span class="sr-only">达到请求限制，系统会自动继续。</span>
            </div>
            <span class="rpm-popup-countdown" aria-hidden="true">{{
              countdown(wait.resumeAt)
            }}</span>
          </div>
        </div>
        <div class="rpm-popup-footer">
          <span>倒计时结束后自动继续</span>
          <AppButton variant="secondary" size="sm" @click="openSettings">
            打开 API 限制设置
          </AppButton>
        </div>
      </AppCard>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rpm-popup {
  position: fixed;
  right: var(--theme-spacing-lg);
  bottom: var(--theme-spacing-lg);
  z-index: 2100;
  display: grid;
  width: min(26rem, calc(100vw - 2 * var(--theme-spacing-lg)));
  gap: var(--theme-spacing-md);
  border-color: color-mix(in srgb, var(--theme-warning) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-warning) 7%, var(--theme-card-bg));
  box-shadow: var(--theme-shadow-lg);
}

.rpm-popup-title,
.rpm-popup-row,
.rpm-popup-footer {
  display: flex;
  align-items: center;
}

.rpm-popup-title {
  gap: var(--theme-spacing-sm);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
}

.rpm-popup-mark {
  display: grid;
  width: 1.5rem;
  height: 1.5rem;
  flex: 0 0 1.5rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--theme-warning) 50%, var(--theme-card-border));
  border-radius: 50%;
  color: var(--theme-warning);
  font-weight: 700;
}

.rpm-popup-list {
  display: grid;
  gap: var(--theme-spacing-sm);
}

.rpm-popup-row {
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-primary) 4%, var(--theme-content-bg));
}

.rpm-popup-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.rpm-popup-copy strong {
  overflow: hidden;
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpm-popup-copy span,
.rpm-popup-footer {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.rpm-popup-countdown {
  flex: 0 0 auto;
  color: var(--theme-warning);
  font-family: 'Cascadia Code', monospace;
  font-size: 1rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.rpm-popup-footer {
  justify-content: space-between;
  gap: var(--theme-spacing-md);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.rpm-popup-enter-active,
.rpm-popup-leave-active {
  transition:
    opacity var(--theme-transition-fast),
    transform var(--theme-transition-fast);
}

.rpm-popup-enter-from,
.rpm-popup-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 480px) {
  .rpm-popup {
    right: var(--theme-spacing-sm);
    bottom: var(--theme-spacing-sm);
    width: calc(100vw - 2 * var(--theme-spacing-sm));
  }

  .rpm-popup-footer {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rpm-popup-enter-active,
  .rpm-popup-leave-active {
    transition: none;
  }
}
</style>
