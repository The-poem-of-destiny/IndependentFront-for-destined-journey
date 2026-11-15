<script setup lang="ts">
/**
 * 回合没完成时的说明与两条出路（审查 GAME-05 / GAME-09 / GAME-16，2026-11-14）。
 *
 * 两个宿主：回合活动卡片（本次会话里刚失败 / 停下的回合）与 ChatFlow 的「上一回合未完成」
 * 横幅（离开过游戏页、刷新或切过存档后，只剩持久化的状态可读）。两处的出路必须一致：
 *
 * - 「再次尝试」：**不回退**，保留这一回合已经写入的内容，在此基础上用同一句输入重新生成；
 * - 「回退并重试」：先回到上一回合结束时的状态，再用同一句输入重新生成（开场回合没有上一回合）。
 *
 * 失败原因的措辞只来自 `lib/turn-failure.ts`；「去设置」先过离开游戏页确认。
 */
import { computed } from 'vue';
import type { TurnFailureInfo } from '@engine/types/types';
import { turnFailureCopy } from '../../lib/turn-failure';
import { confirmLeaveGame } from '../../lib/leave-game-guard';
import { useUIStore } from '../../stores/ui-store';

const props = defineProps<{
  /** 发生了什么（一句话） */
  message: string;
  /** 归类后的失败原因；缺席 = 不是失败（停下）或原因未保留 */
  failure?: TurnFailureInfo | null;
  /** 原因没留下来（重新载入后只知道失败了） */
  causeUnknown?: boolean;
  canRetry?: boolean;
  canRollbackRetry?: boolean;
  /**
   * 第三条出路「回退并修改输入」：回到上一回合结束时的状态，把这句输入填回输入框，
   * 不自动重发。只有 ChatFlow 的「上一回合未完成」横幅提供（替代同一条输入下那行
   * 「回退到这条输入」，两处合成一块）；不传 = 不显示。
   */
  canRollbackEdit?: boolean;
  /** 不能回退时的原因（如开场回合），显示在按钮位置 */
  rollbackBlockedReason?: string;
}>();

const emit = defineEmits<{ retry: []; 'rollback-retry': []; 'rollback-edit': [] }>();

const copy = computed(() => (props.failure ? turnFailureCopy(props.failure.category) : null));

async function openSettings() {
  if (!(await confirmLeaveGame('设置'))) return;
  useUIStore().openSettings('api');
}
</script>

<template>
  <div class="turn-recovery" role="status">
    <p class="turn-recovery-message">{{ message }}</p>

    <template v-if="copy && failure">
      <p class="turn-recovery-cause">
        <strong>{{ copy.summary }}</strong>
        <span v-if="failure.stepLabel" class="turn-recovery-step">
          出错的步骤：{{ failure.stepLabel }}
        </span>
      </p>
      <p class="turn-recovery-hint">
        {{ copy.hint }}
        <button
          v-if="copy.needsSettings"
          type="button"
          class="turn-recovery-link"
          @click.stop="openSettings"
        >
          去设置
        </button>
      </p>
      <details v-if="failure.detail" class="turn-recovery-detail">
        <summary>技术详情</summary>
        <code>{{ failure.detail }}</code>
      </details>
    </template>
    <p v-else-if="causeUnknown" class="turn-recovery-hint">原因未保留（离开过游戏页或刷新过）。</p>

    <div
      v-if="canRetry || canRollbackRetry || canRollbackEdit || rollbackBlockedReason"
      class="turn-recovery-choices"
    >
      <div v-if="canRetry" class="turn-recovery-choice">
        <button type="button" @click.stop="emit('retry')">再次尝试</button>
        <small>保留这一回合已经写入的内容，在此基础上重新生成</small>
      </div>
      <div v-if="canRollbackRetry" class="turn-recovery-choice">
        <button type="button" @click.stop="emit('rollback-retry')">回退并重试</button>
        <small>先回到上一回合结束时的状态，再用同一句输入重新生成</small>
      </div>
      <small v-else-if="rollbackBlockedReason" class="turn-recovery-note">
        {{ rollbackBlockedReason }}
      </small>
      <div v-if="canRollbackEdit" class="turn-recovery-choice">
        <button type="button" @click.stop="emit('rollback-edit')">回退并修改输入</button>
        <small>先回到上一回合结束时的状态，这句输入填回输入框，改好再发送</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-recovery {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs, 4px);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-error) 28%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm, 4px);
  background-color: color-mix(in srgb, var(--theme-error) 7%, transparent);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.6;
}
.turn-recovery p {
  margin: 0;
  text-indent: 0;
}
.turn-recovery-message {
  color: var(--theme-text-primary);
}
.turn-recovery-cause strong {
  font-weight: 600;
  color: var(--theme-text-primary);
}
.turn-recovery-step {
  margin-left: var(--theme-spacing-sm, 8px);
  color: var(--theme-text-muted);
}
.turn-recovery-link {
  margin-left: var(--theme-spacing-xs, 4px);
  padding: 0;
  border: 0;
  background: none;
  color: var(--theme-primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.turn-recovery-link:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.turn-recovery-detail summary {
  cursor: pointer;
  color: var(--theme-text-muted);
}
.turn-recovery-detail code {
  display: block;
  margin-top: var(--theme-spacing-xs, 4px);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.turn-recovery-choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm, 8px) var(--theme-spacing-md, 12px);
  margin-top: var(--theme-spacing-xs, 4px);
}
.turn-recovery-choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 16rem;
}
.turn-recovery-choice small,
.turn-recovery-note {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}
.turn-recovery-choice button {
  align-self: flex-start;
  min-height: 2.25rem;
  padding: 0 var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm, 4px);
  background-color: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  font: inherit;
  cursor: pointer;
  transition:
    background-color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.turn-recovery-choice button:hover {
  background-color: color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.turn-recovery-choice button:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .turn-recovery-choice button {
    transition: none;
  }
}
</style>
