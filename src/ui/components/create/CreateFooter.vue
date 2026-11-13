<script setup lang="ts">
import AppButton from '../shared/AppButton.vue';
import type { BlockedHint } from '../../lib/create-options';

defineProps<{
  busy?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  nextLabel?: string;
  /**
   * 下一步被禁用时的原因：前缀 + 缺项。缺项带所属步骤，不在当前步骤的渲染成可点的跳转，
   * 让玩家直接去补，而不是只被告知「缺了」。null = 不显示。
   */
  blocked?: BlockedHint | null;
}>();

defineEmits<{
  prev: [];
  next: [];
  openPreset: [];
  jump: [step: number];
}>();
</script>

<template>
  <footer class="create-footer">
    <AppButton variant="ghost" size="sm" :disabled="busy" @click="$emit('openPreset')">
      <i class="btn-icon fa-solid fa-bookmark" aria-hidden="true"></i>角色预设
    </AppButton>

    <div class="footer-right">
      <p v-if="canNext === false && blocked?.items.length" class="blocked-hint" role="status">
        {{ blocked.prefix
        }}<template v-for="(item, i) in blocked.items" :key="item.label"
          ><template v-if="i > 0">、</template
          ><button
            v-if="item.step !== blocked.currentStep"
            type="button"
            class="blocked-link"
            :title="`前往补全「${item.label}」`"
            @click="$emit('jump', item.step)"
          >
            {{ item.label }}</button
          ><template v-else>{{ item.label }}</template></template
        >
      </p>
      <div class="footer-nav">
        <AppButton
          variant="secondary"
          size="md"
          :disabled="canPrev === false"
          @click="$emit('prev')"
        >
          ← 上一步
        </AppButton>
        <AppButton variant="primary" size="md" :disabled="canNext === false" @click="$emit('next')">
          {{ nextLabel || '下一步 →' }}
        </AppButton>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.create-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  padding-bottom: max(var(--theme-spacing-md), env(safe-area-inset-bottom, 12px));
  background: var(--theme-card-bg);
  border-top: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.footer-right {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  min-width: 0;
}
.blocked-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-warning);
  text-align: right;
}
.blocked-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.blocked-link:hover,
.blocked-link:focus-visible {
  color: var(--theme-text-primary);
}
.footer-nav {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-shrink: 0;
}
.btn-icon {
  margin-right: 4px;
}
</style>
