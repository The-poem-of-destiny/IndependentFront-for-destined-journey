<script setup lang="ts">
/**
 * 应用内确认弹窗的唯一宿主（App.vue 挂载一次，与 ToastContainer 并列）。
 *
 * 状态全在 `lib/confirm-dialog.ts` 的模块级 ref 里，本组件只负责画出来。
 * 🔴 AppModal 用 `v-if` + `:key` 按请求挂载：Teleport 的锚点在**打开那一刻**才追加到
 *    body 末尾，DOM 顺序天然排在已打开的弹窗之后；再加上下方非 scoped 的 z-index 提升，
 *    从其他弹窗里发起确认时它一定盖在上面。焦点栈由 modal-focus 统一管理。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import AppButton from './AppButton.vue';
import { activeConfirm, registerConfirmHost, settleConfirm } from '../../lib/confirm-dialog';

const request = computed(() => activeConfirm.value);
const options = computed(() => request.value?.options);

const confirmBtn = ref<InstanceType<typeof AppButton> | null>(null);
const cancelBtn = ref<InstanceType<typeof AppButton> | null>(null);

let unregister: (() => void) | undefined;
onMounted(() => {
  unregister = registerConfirmHost();
});
onUnmounted(() => unregister?.());

/** 危险操作默认聚焦「取消」，避免回车误删；普通确认聚焦「确定」 */
watch(
  () => request.value?.id,
  async (id) => {
    if (id == null) return;
    await nextTick();
    const target = options.value?.danger ? cancelBtn.value : confirmBtn.value;
    (target?.$el as HTMLElement | undefined)?.focus();
  },
  { flush: 'post', immediate: true },
);

function onConfirm() {
  settleConfirm(true);
}
function onCancel() {
  settleConfirm(false);
}
</script>

<template>
  <AppModal
    v-if="request && options"
    :key="request.id"
    :open="true"
    :title="options.title"
    :size="options.details?.length ? 'md' : 'sm'"
    @close="onCancel"
  >
    <div class="confirm-dialog-body" :data-danger="options.danger ? 'true' : undefined">
      <p class="confirm-message">{{ options.message }}</p>
      <ul v-if="options.details?.length" class="confirm-details">
        <li v-for="(line, i) in options.details" :key="i">{{ line }}</li>
      </ul>
    </div>
    <template #footer>
      <AppButton ref="cancelBtn" variant="secondary" data-confirm-action="cancel" @click="onCancel">
        {{ options.cancelLabel ?? '取消' }}
      </AppButton>
      <AppButton
        ref="confirmBtn"
        :variant="options.danger ? 'danger' : 'primary'"
        data-confirm-action="confirm"
        @click="onConfirm"
      >
        {{ options.confirmLabel ?? '确定' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  color: var(--theme-text-primary);
  line-height: 1.6;
}
.confirm-details {
  margin: var(--theme-spacing-md) 0 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md) var(--theme-spacing-sm)
    var(--theme-spacing-xl);
  max-height: 40vh;
  overflow-y: auto;
  color: var(--theme-text-secondary);
  font-size: 0.9rem;
  line-height: 1.6;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
</style>

<style>
/*
 * 确认弹窗的遮罩层级高于普通 AppModal（1000），低于 Toast（2000）。
 * AppModal 的样式是 scoped 的、外层是 Teleport，只能用 :has() 从外面认领这一层。
 */
.modal-overlay:has(.confirm-dialog-body) {
  z-index: 1100;
}
</style>
