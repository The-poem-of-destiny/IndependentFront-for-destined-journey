<script setup lang="ts">
import AppButton from '../shared/AppButton.vue';

defineProps<{
  busy?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  nextLabel?: string;
  /** 下一步被禁用时的原因（缺哪些必填项）；空串 = 不显示 */
  blockedHint?: string;
}>();

defineEmits<{
  prev: [];
  next: [];
  openPreset: [];
}>();
</script>

<template>
  <footer class="create-footer">
    <AppButton variant="ghost" size="sm" :disabled="busy" @click="$emit('openPreset')">
      <i class="btn-icon fa-solid fa-bookmark" aria-hidden="true"></i>角色预设
    </AppButton>

    <div class="footer-right">
      <p v-if="canNext === false && blockedHint" class="blocked-hint" role="status">
        {{ blockedHint }}
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
.footer-nav {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-shrink: 0;
}
.btn-icon {
  margin-right: 4px;
}
</style>
