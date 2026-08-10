<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AgentActivityRun, AgentActivityStep } from '@engine/types';

const props = defineProps<{
  run: AgentActivityRun;
  canRetry?: boolean;
}>();

const emit = defineEmits<{
  retry: [];
  resize: [];
}>();

const expanded = ref(props.run.status !== 'completed');
const userToggled = ref(false);
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const isActive = computed(() => props.run.status === 'running' || props.run.status === 'stopping');
const settledCount = computed(
  () => props.run.steps.filter((step) => step.status !== 'running').length,
);
const totalCount = computed(() => props.run.steps.length);
const elapsed = computed(() => {
  void tick.value;
  return (props.run.completedAt ?? Date.now()) - props.run.startedAt;
});

const heading = computed(() => {
  switch (props.run.status) {
    case 'stopping':
      return '正在停下本回合';
    case 'completed':
      return '本回合完成';
    case 'failed':
      return '本回合未完成';
    case 'cancelled':
      return '本回合已中止';
    default:
      return '回合进程';
  }
});

const headingIcon = computed(() => {
  switch (props.run.status) {
    case 'completed':
      return 'fa-solid fa-check';
    case 'failed':
      return 'fa-solid fa-triangle-exclamation';
    case 'cancelled':
      return 'fa-solid fa-ban';
    case 'stopping':
      return 'fa-solid fa-hourglass-half';
    default:
      return 'fa-solid fa-feather-pointed';
  }
});

function stepIcon(step: AgentActivityStep): string {
  switch (step.status) {
    case 'completed':
      return 'fa-solid fa-check';
    case 'failed':
      return 'fa-solid fa-exclamation';
    case 'cancelled':
      return 'fa-solid fa-minus';
    default:
      return 'fa-solid fa-ellipsis';
  }
}

function stepState(step: AgentActivityStep): string {
  switch (step.status) {
    case 'completed':
      return '完成';
    case 'failed':
      return '未完成';
    case 'cancelled':
      return '已中止';
    default:
      return '进行中';
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}分 ${rest.toString().padStart(2, '0')}秒` : `${rest}秒`;
}

function notifyResize() {
  nextTick(() => emit('resize'));
}

function toggleExpanded() {
  expanded.value = !expanded.value;
  userToggled.value = true;
  notifyResize();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function syncTimer() {
  if (isActive.value && !timer) {
    timer = setInterval(() => {
      tick.value += 1;
    }, 1000);
  } else if (!isActive.value) {
    stopTimer();
  }
}

watch(
  () => props.run.status,
  (status, previous) => {
    syncTimer();
    const wasActive = previous === 'running' || previous === 'stopping';
    if (wasActive && (status === 'failed' || status === 'cancelled')) {
      expanded.value = true;
    } else if (wasActive && status === 'completed' && !userToggled.value) {
      expanded.value = false;
    }
    notifyResize();
  },
);

watch(
  () => `${props.run.steps.length}:${props.run.steps.map((step) => step.tools.length).join(',')}`,
  notifyResize,
);

onMounted(() => {
  syncTimer();
  notifyResize();
});
onUnmounted(stopTimer);
</script>

<template>
  <section class="turn-activity" :class="`turn-activity-${run.status}`" :aria-label="heading">
    <button
      class="activity-heading"
      type="button"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <span class="activity-heading-mark" aria-hidden="true">
        <i :class="headingIcon" />
      </span>
      <span class="activity-heading-copy">
        <strong>{{ heading }}</strong>
        <span v-if="totalCount > 0">
          {{ settledCount }} / {{ totalCount }} 项 · {{ formatElapsed(elapsed) }}
        </span>
        <span v-else>正在开始</span>
      </span>
      <i
        class="activity-chevron fa-solid fa-chevron-down"
        :class="{ 'is-expanded': expanded }"
        aria-hidden="true"
      />
    </button>

    <Transition name="activity-expand" @after-enter="notifyResize" @after-leave="notifyResize">
      <div v-if="expanded" class="activity-expand-shell">
        <div class="activity-expand-inner">
          <div class="activity-scroll">
            <div v-if="run.steps.length === 0" class="activity-empty">
              <span class="activity-step-mark is-running" aria-hidden="true">
                <i class="fa-solid fa-ellipsis" />
              </span>
              <span>倾听命运的回声</span>
            </div>

            <ol v-else class="activity-list" aria-live="polite">
              <li
                v-for="step in run.steps"
                :key="step.id"
                class="activity-step"
                :class="`is-${step.status}`"
              >
                <span class="activity-step-mark" :class="`is-${step.status}`" aria-hidden="true">
                  <i :class="stepIcon(step)" />
                </span>
                <div class="activity-step-content">
                  <div class="activity-step-line">
                    <span class="activity-step-label">{{ step.label }}</span>
                    <span class="activity-step-state">{{ stepState(step) }}</span>
                  </div>

                  <ol v-if="step.tools.length > 0" class="activity-tools">
                    <li
                      v-for="tool in step.tools"
                      :key="tool.id"
                      class="activity-tool"
                      :class="`is-${tool.status}`"
                    >
                      <i
                        :class="
                          tool.status === 'failed' ? 'fa-solid fa-exclamation' : 'fa-solid fa-check'
                        "
                        aria-hidden="true"
                      />
                      <span>{{ tool.label }}</span>
                      <small v-if="tool.detail">{{ tool.detail }}</small>
                    </li>
                  </ol>
                </div>
              </li>
            </ol>
          </div>

          <div v-if="run.message" class="activity-recovery" role="status">
            <span>{{ run.message }}</span>
            <button v-if="canRetry" type="button" @click.stop="emit('retry')">再次尝试</button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.turn-activity {
  width: 100%;
  flex: 0 0 auto;
  color: var(--theme-text-primary);
  background: color-mix(in srgb, var(--theme-card-bg) 94%, transparent);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(
    --paper-stack,
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08)
  );
  overflow: hidden;
}

.activity-heading {
  width: 100%;
  min-height: 2.75rem;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 0;
  background-color: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}

.activity-heading:hover {
  background-color: color-mix(in srgb, var(--theme-primary) 7%, transparent);
}

.activity-heading:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -3px;
}

.activity-heading-mark,
.activity-step-mark {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 32%, var(--theme-card-border));
  border-radius: 50%;
  color: var(--theme-primary);
  background-color: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  font-size: 0.625rem;
}

.activity-heading-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
}

.activity-heading-copy strong {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
}

.activity-heading-copy span,
.activity-step-state {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.activity-chevron {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  transform: rotate(-90deg);
  transition: transform var(--theme-transition-fast);
}

.activity-chevron.is-expanded {
  transform: rotate(0);
}

.activity-expand-shell {
  display: grid;
  grid-template-rows: 1fr;
}

.activity-expand-inner {
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--theme-card-border);
}

.activity-scroll {
  max-block-size: 12rem;
  overflow-y: auto;
  padding: var(--theme-spacing-md);
}

.activity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

.activity-step,
.activity-empty {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  min-width: 0;
}

.activity-step-mark {
  width: 1.25rem;
  height: 1.25rem;
  margin-top: 0.0625rem;
  font-size: 0.5625rem;
}

.activity-step-mark.is-completed {
  color: var(--theme-success);
  border-color: color-mix(in srgb, var(--theme-success) 30%, var(--theme-card-border));
  background-color: color-mix(in srgb, var(--theme-success) 10%, transparent);
}

.activity-step-mark.is-failed {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  background-color: color-mix(in srgb, var(--theme-error) 10%, transparent);
}

.activity-step-mark.is-cancelled {
  color: var(--theme-text-muted);
}

.activity-step-content {
  flex: 1;
  min-width: 0;
}

.activity-step-line {
  min-height: 1.375rem;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}

.activity-step-label {
  font-size: 0.8125rem;
  line-height: 1.5;
}

.activity-tools {
  list-style: none;
  margin: var(--theme-spacing-xs) 0 0;
  padding: 0 0 0 var(--theme-spacing-md);
  border-inline-start: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.activity-tool {
  min-width: 0;
  display: grid;
  grid-template-columns: 0.875rem minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: var(--theme-spacing-xs);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.activity-tool > i {
  color: var(--theme-success);
  font-size: 0.5625rem;
}

.activity-tool.is-failed > i {
  color: var(--theme-error);
}

.activity-tool small {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  white-space: nowrap;
}

.activity-empty {
  align-items: center;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
}

.activity-recovery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  margin: 0 var(--theme-spacing-md) var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-error) 28%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm, 4px);
  background-color: color-mix(in srgb, var(--theme-error) 7%, transparent);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.activity-recovery button {
  min-height: 2.25rem;
  flex: 0 0 auto;
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

.activity-recovery button:hover {
  background-color: color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}

.turn-activity-completed .activity-heading-mark {
  color: var(--theme-success);
  border-color: color-mix(in srgb, var(--theme-success) 30%, var(--theme-card-border));
  background-color: color-mix(in srgb, var(--theme-success) 10%, transparent);
}

.turn-activity-failed .activity-heading-mark {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  background-color: color-mix(in srgb, var(--theme-error) 10%, transparent);
}

.turn-activity-cancelled .activity-heading-mark,
.turn-activity-stopping .activity-heading-mark {
  color: var(--theme-text-muted);
}

.activity-expand-enter-active,
.activity-expand-leave-active {
  transition:
    grid-template-rows 0.25s ease,
    opacity 0.2s ease;
}

.activity-expand-enter-from,
.activity-expand-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}

@media (max-width: 720px) {
  .activity-heading-copy {
    align-items: flex-start;
    flex-direction: column;
    gap: 0;
  }

  .activity-tool {
    grid-template-columns: 0.875rem minmax(0, 1fr);
  }

  .activity-tool small {
    grid-column: 2;
    white-space: normal;
  }

  .activity-recovery {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .activity-heading,
  .activity-chevron,
  .activity-recovery button,
  .activity-expand-enter-active,
  .activity-expand-leave-active {
    transition: none;
  }
}
</style>
