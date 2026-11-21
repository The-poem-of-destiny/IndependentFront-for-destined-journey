<script setup lang="ts">
/**
 * OpeningPromptEditor — 建档最后一步的「开局提示词」预览与编辑
 *
 * 这段文本会**原样**作为新存档的第一条用户消息发出。读写都经 create-store：
 * - 显示 `openingPromptText`（玩家改写稿，或跟随建档输入生成的默认稿）
 * - 输入即 `setOpeningPromptText`（store 同时记下此刻的默认稿，用来判断之后是否过期）
 * - 「恢复默认」先确认再 `restoreDefaultOpeningPrompt`，没改过时禁用
 * - `openingPromptStale`：改写之后建档选择又变了，默认稿已经不同 —— 提示玩家可以恢复默认
 * - 建档提交中（`isCreating`）整块只读
 */
import { useCreateStore } from '../../stores/create-store';
import { confirmDialog } from '../../lib/confirm-dialog';
import AppButton from '../shared/AppButton.vue';

const store = useCreateStore();

const TEXTAREA_ID = 'opening-prompt-editor';
const HINT_ID = 'opening-prompt-hint';

function onInput(event: Event) {
  store.setOpeningPromptText((event.target as HTMLTextAreaElement).value);
}

async function onRestore() {
  if (!store.openingPromptEdited || store.isCreating) return;
  const confirmed = await confirmDialog({
    title: '恢复默认开局提示词？',
    message: '你对开局提示词的修改将被丢弃，改用按当前建档选择生成的默认文本。',
    confirmLabel: '恢复默认',
    danger: true,
  });
  if (!confirmed) return;
  store.restoreDefaultOpeningPrompt();
}
</script>

<template>
  <section class="opening-prompt" aria-labelledby="opening-prompt-title">
    <div class="op-header">
      <h3 id="opening-prompt-title" class="op-title">开局提示词</h3>
      <AppButton
        class="op-restore"
        size="sm"
        variant="secondary"
        :disabled="!store.openingPromptEdited || store.isCreating"
        @click="onRestore"
      >
        恢复默认
      </AppButton>
    </div>
    <p :id="HINT_ID" class="op-hint">
      这段文本会原样作为第一条消息发出。可以在这里补充或修改开局要求。
    </p>

    <p v-if="store.openingPromptStale" class="op-stale" role="status">
      修改之后你又调整了建档选择，默认提示词已经随之变化，当前文本可能已过时。可点「恢复默认」改用新的默认文本。
    </p>

    <label :for="TEXTAREA_ID" class="op-sr-only">开局提示词</label>
    <textarea
      :id="TEXTAREA_ID"
      class="op-editor"
      :value="store.openingPromptText"
      :disabled="store.isCreating"
      :aria-describedby="HINT_ID"
      spellcheck="false"
      rows="12"
      @input="onInput"
    />
  </section>
</template>

<style scoped>
.opening-prompt {
  margin-top: var(--theme-spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.op-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.op-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-family: var(--theme-font-title, serif);
  font-size: 1rem;
  color: var(--theme-text-primary);
}
.op-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.op-restore {
  flex-shrink: 0;
}
.op-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--theme-text-muted);
}
.op-stale {
  margin: 0;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  font-size: 0.8rem;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-md);
}
/* 照 settings/agent/agent-chrome.css 的 .prompt-editor：等宽、内凹底色、焦点环
   （内凹底色取主题 token --theme-surface-muted，不硬编码 #000） */
.op-editor {
  box-sizing: border-box;
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.8rem;
  line-height: 1.6;
  min-height: 280px;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  resize: vertical;
  tab-size: 2;
  transition:
    border-color var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}
.op-editor:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 12%, transparent);
}
.op-editor:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.op-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 600px) {
  .op-editor {
    min-height: 220px;
    padding: var(--theme-spacing-sm);
  }
}
@media (prefers-reduced-motion: reduce) {
  .op-editor {
    transition: none;
  }
}
</style>
