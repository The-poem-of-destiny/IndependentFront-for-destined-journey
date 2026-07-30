<script setup lang="ts">
/**
 * 素材分区的确认 / 输入弹窗（取代 window.confirm / window.prompt）
 *
 * 与 audio/AudioDialogs.vue 同构 —— 一次只有一个弹窗在场，由 AssetSection 挂
 * 一份并把 askConfirm / askPrompt provide 下去（契约见 ./dialogs.ts），各子组件
 * inject 后直接 await。Esc / 遮罩 / × 三条路都由 AppModal 兜到 update:open，
 * 统一收进 closeXxx 的唯一出口，保证 Promise 只兑现一次。
 */
import { ref, computed, nextTick, onUnmounted } from 'vue'
import AppButton from '../../shared/AppButton.vue'
import AppModal from '../../shared/AppModal.vue'
import type { AssetConfirmOptions, AssetPromptOptions } from './dialogs'

// ===== 确认 =====

const confirmDialog = ref({ open: false, title: '', message: '', confirmLabel: '确认', danger: false })
let confirmResolve: ((ok: boolean) => void) | null = null

function askConfirm(opts: AssetConfirmOptions): Promise<boolean> {
  closeConfirm(false) // 保险：清掉任何残留的上一轮
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve
    confirmDialog.value = {
      open: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? '确认',
      danger: opts.danger ?? false,
    }
  })
}

/** 唯一出口 —— 取消 / Esc / 遮罩 / 确认 都走这里，保证 resolve 只兑现一次 */
function closeConfirm(ok: boolean): void {
  const resolve = confirmResolve
  confirmResolve = null
  confirmDialog.value.open = false
  resolve?.(ok)
}

// ===== 输入 =====

const promptDialog = ref({ open: false, title: '', label: '', value: '' })
const promptInput = ref<HTMLInputElement | null>(null)
let promptResolve: ((value: string | null) => void) | null = null

/** 解析为 trim 后的非空字符串；取消返回 null（对齐 window.prompt 的语义） */
function askPrompt(opts: AssetPromptOptions): Promise<string | null> {
  closePrompt(null)
  return new Promise<string | null>((resolve) => {
    promptResolve = resolve
    promptDialog.value = { open: true, title: opts.title, label: opts.label, value: opts.value }
    void nextTick(() => {
      promptInput.value?.focus()
      promptInput.value?.select()
    })
  })
}

function closePrompt(value: string | null): void {
  const resolve = promptResolve
  promptResolve = null
  promptDialog.value.open = false
  resolve?.(value)
}

const promptValid = computed(() => promptDialog.value.value.trim().length > 0)

function submitPrompt(): void {
  if (!promptValid.value) return
  closePrompt(promptDialog.value.value.trim())
}

onUnmounted(() => {
  // 卸载时把悬着的 Promise 收干净，避免调用方永远 await 不到
  closeConfirm(false)
  closePrompt(null)
})

defineExpose({ askConfirm, askPrompt })
</script>

<template>
  <!-- ═══ 确认弹窗（取代 window.confirm） ═══ -->
  <AppModal
    :open="confirmDialog.open"
    :title="confirmDialog.title"
    size="sm"
    @update:open="closeConfirm(false)"
  >
    <p class="dialog-text">{{ confirmDialog.message }}</p>
    <template #footer>
      <AppButton variant="ghost" size="sm" @click="closeConfirm(false)">取消</AppButton>
      <AppButton
        :variant="confirmDialog.danger ? 'danger' : 'primary'"
        size="sm"
        @click="closeConfirm(true)"
      >{{ confirmDialog.confirmLabel }}</AppButton>
    </template>
  </AppModal>

  <!-- ═══ 输入弹窗（取代 window.prompt） ═══ -->
  <AppModal
    :open="promptDialog.open"
    :title="promptDialog.title"
    size="sm"
    @update:open="closePrompt(null)"
  >
    <label class="dialog-label">
      {{ promptDialog.label }}
      <input
        ref="promptInput"
        v-model="promptDialog.value"
        class="mini-input dialog-input"
        type="text"
        @keydown.enter.prevent="submitPrompt"
      />
    </label>
    <template #footer>
      <AppButton variant="ghost" size="sm" @click="closePrompt(null)">取消</AppButton>
      <AppButton variant="primary" size="sm" :disabled="!promptValid" @click="submitPrompt">确定</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
/* ═══ 确认 / 输入弹窗（与音频分区同一副视觉） ═══ */
.dialog-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
  /* 删除确认的爆炸半径分几句写，用 \n 断句，这里保留原文换行 */
  white-space: pre-line;
}
.dialog-label {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
/* 输入框沿用素材库那套 mini 外壳（同一副视觉），故本组件也带一份 */
.mini-input {
  height: 36px;
  padding: 0 var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
  min-width: 9rem;
  flex: 1;
}
.mini-input:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.dialog-input {
  width: 100%;
}
</style>
