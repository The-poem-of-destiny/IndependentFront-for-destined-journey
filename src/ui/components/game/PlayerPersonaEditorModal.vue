<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { PlayerPersonaDraft } from '@engine/state-manager';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    persona: PlayerPersonaDraft;
    saving?: boolean;
    error?: string;
  }>(),
  {
    saving: false,
    error: '',
  },
);

const emit = defineEmits<{
  close: [];
  save: [draft: PlayerPersonaDraft];
}>();

const draft = reactive<PlayerPersonaDraft>({
  personality: '',
  appearance: '',
  background: '',
});
const baseline = reactive<PlayerPersonaDraft>({
  personality: '',
  appearance: '',
  background: '',
});

function normalize(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function normalizedOf(value: PlayerPersonaDraft): PlayerPersonaDraft {
  return {
    personality: normalize(value.personality),
    appearance: normalize(value.appearance),
    background: normalize(value.background),
  };
}

function resetDraft() {
  Object.assign(baseline, normalizedOf(props.persona));
  Object.assign(draft, baseline);
}

watch(
  () => props.open,
  (open) => {
    if (open) resetDraft();
  },
  { immediate: true },
);

const dirty = computed(() => {
  const next = normalizedOf(draft);
  return (
    next.personality !== baseline.personality ||
    next.appearance !== baseline.appearance ||
    next.background !== baseline.background
  );
});

function requestClose() {
  if (props.saving) return;
  if (dirty.value && !window.confirm('放弃未保存的人设修改？')) return;
  emit('close');
}

function onOpenChange(open: boolean) {
  if (!open) requestClose();
}

function submit() {
  if (props.saving || !dirty.value) return;
  emit('save', { ...draft });
}
</script>

<template>
  <AppModal
    :open="open"
    title="编辑玩家人设"
    size="lg"
    :closable="!saving"
    @update:open="onOpenChange"
  >
    <div class="persona-editor">
      <div class="persona-notice">修改会从下一次行动起影响叙事，不会改写已经发生的剧情。</div>
      <div class="persona-warning" role="note">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true" />
        <span>修改会改变后续提示词，可能降低提示词缓存命中，并产生额外模型费用。</span>
      </div>

      <div class="persona-field">
        <label for="persona-personality">性格</label>
        <textarea
          id="persona-personality"
          v-model="draft.personality"
          rows="3"
          :disabled="saving"
          placeholder="描述主角稳定的性格特点与待人方式"
        />
      </div>

      <div class="persona-field">
        <label for="persona-appearance">外貌与体态</label>
        <textarea
          id="persona-appearance"
          v-model="draft.appearance"
          rows="4"
          :disabled="saving"
          placeholder="描述主角的身形、五官与外在特征"
        />
        <p class="field-hint">此处只修改正文中的人物设定，不会修改画像生成使用的外貌预设。</p>
      </div>

      <div class="persona-field">
        <label for="persona-background">背景经历</label>
        <textarea
          id="persona-background"
          v-model="draft.background"
          rows="6"
          :disabled="saving"
          placeholder="描述主角在故事开始前的重要经历与来历"
        />
      </div>

      <p v-if="error" class="persona-error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <AppButton
        class="persona-footer-button"
        variant="ghost"
        :disabled="saving"
        @click="requestClose"
      >
        取消
      </AppButton>
      <AppButton
        class="persona-footer-button"
        variant="primary"
        :loading="saving"
        :disabled="!dirty"
        @click="submit"
      >
        {{ saving ? '保存中…' : '保存人设' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.persona-editor {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
}

.persona-notice,
.persona-warning,
.persona-error {
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.persona-notice {
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  box-shadow: var(--paper-stack);
}

.persona-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 10%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-warning) 32%, var(--theme-card-border));
}

.persona-warning i {
  margin-top: 0.25em;
  flex-shrink: 0;
}

.persona-field {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.persona-field label {
  color: var(--theme-text-secondary);
  font-size: 0.875rem;
  font-weight: 600;
}

.persona-field textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  color: var(--theme-text-primary);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.6;
  transition:
    border-color var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}

.persona-field textarea:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 24%, transparent);
}

.persona-field textarea:disabled {
  opacity: 0.6;
  cursor: wait;
}

.field-hint {
  margin: 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

.persona-error {
  margin: 0;
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}

.persona-footer-button {
  min-height: 36px;
}

@media (max-width: 36rem) {
  .persona-editor {
    gap: var(--theme-spacing-md);
  }
}
</style>
