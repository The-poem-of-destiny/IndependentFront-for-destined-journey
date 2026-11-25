<script setup lang="ts">
/**
 * StageControls — 逐节演出的控制条（2026-11-20 从正文末尾移到输入框正上方）
 *
 * 只画、不判：何时出现、快进状态由 ChatFlow 决定，本组件只发事件。
 *
 * - 浮在输入框上沿（`.stage-dock` 高度为 0，内层绝对定位）：出现 / 消失 / 收起都不推动正文与输入框。
 * - 可收起：收起后只剩右侧一枚小标签「演出」，还能推进时带一个呼吸点；
 *   收起状态由调用方持久化（设置 `stagedControlsCollapsed`）。
 * - 演出本身不受影响：Space / Enter / 点正文推进照常，收起只是把按钮藏起来。
 */
withDefaults(
  defineProps<{
    /** 下一节已经完整、可以推进 */
    canAdvance?: boolean;
    fastForwarding?: boolean;
    collapsed?: boolean;
  }>(),
  { canAdvance: false, fastForwarding: false, collapsed: false },
);

const emit = defineEmits<{
  'show-full': [];
  'fast-forward': [];
  'skip-all': [];
  'update:collapsed': [value: boolean];
}>();
</script>

<template>
  <div class="stage-dock">
    <Transition name="stage-dock" mode="out-in">
      <button
        v-if="collapsed"
        key="tab"
        type="button"
        class="stage-dock-tab"
        aria-label="展开正文演出控制"
        :aria-expanded="false"
        @click="emit('update:collapsed', false)"
      >
        <span v-if="canAdvance" class="stage-dock-pulse" aria-hidden="true" />
        演出
        <i class="fa-solid fa-chevron-up" aria-hidden="true" />
      </button>
      <div v-else key="bar" class="stage-bar" role="group" aria-label="正文演出">
        <span v-if="canAdvance" class="stage-hint">点击正文或按空格继续</span>
        <span class="stage-mode" role="group" aria-label="正文显示方式">
          <button type="button" class="stage-btn" :aria-pressed="false" @click="emit('show-full')">
            全文
          </button>
          <button type="button" class="stage-btn is-current" :aria-pressed="true" disabled>
            演出
          </button>
        </span>
        <button
          type="button"
          class="stage-btn"
          :aria-pressed="fastForwarding"
          :class="{ 'is-current': fastForwarding }"
          @click="emit('fast-forward')"
        >
          <i class="fa-solid fa-forward" aria-hidden="true" /> 快进
        </button>
        <button type="button" class="stage-btn" @click="emit('skip-all')">
          <i class="fa-solid fa-forward-fast" aria-hidden="true" /> 全部显示
        </button>
        <button
          type="button"
          class="stage-btn stage-collapse"
          aria-label="收起正文演出控制"
          :aria-expanded="true"
          @click="emit('update:collapsed', true)"
        >
          <i class="fa-solid fa-chevron-down" aria-hidden="true" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 高度 0 的锚：控制条浮在输入框上沿，不参与布局，出现与收起都不挤动正文 */
.stage-dock {
  position: relative;
  height: 0;
  z-index: 2;
}
.stage-bar,
.stage-dock-tab {
  position: absolute;
  right: 12px;
  bottom: 8px;
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  background: color-mix(in srgb, var(--theme-title-bar-bg) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  backdrop-filter: blur(6px);
}
.stage-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  max-width: calc(100% - 24px);
  padding: 4px 6px 4px 10px;
  opacity: 0.78;
  transition: opacity var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-bar:hover,
.stage-bar:focus-within {
  opacity: 1;
}
.stage-hint {
  margin-right: 4px;
  letter-spacing: 0.04em;
}
.stage-mode {
  display: inline-flex;
}
.stage-mode .stage-btn:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.stage-mode .stage-btn:last-child {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left-width: 0;
}
.stage-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard),
    background-color var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-btn:hover:not(:disabled) {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.stage-btn.is-current {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.stage-btn:disabled {
  cursor: default;
}
.stage-collapse {
  padding: 2px 7px;
  border-color: transparent;
}

.stage-dock-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  cursor: pointer;
  opacity: 0.6;
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-dock-tab:hover,
.stage-dock-tab:focus-visible {
  opacity: 1;
  color: var(--theme-text-primary);
}
.stage-dock-tab .fa-chevron-up {
  font-size: 0.625rem;
}
.stage-dock-pulse {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--theme-primary) 70%, transparent);
  animation: stage-dock-breathe 1.6s var(--motion-ease-standard) infinite alternate;
}
@keyframes stage-dock-breathe {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}

/* 收起 / 展开：只动 opacity 与 transform（design.md §6.0） */
.stage-dock-enter-active {
  transition:
    opacity var(--motion-duration-base) var(--motion-ease-enter),
    transform var(--motion-duration-base) var(--motion-ease-enter);
}
.stage-dock-leave-active {
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease-standard),
    transform var(--motion-duration-fast) var(--motion-ease-standard);
}
.stage-dock-enter-from,
.stage-dock-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .stage-dock-enter-active,
  .stage-dock-leave-active {
    transition: none;
  }
}
</style>
