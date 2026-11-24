<script setup lang="ts">
/**
 * 行动面板的资源条：实心段画到 `lo`，`lo → hi` 是变化段 ——
 * 下降为斜纹残影、回升为提亮。`lo === hi` 时就是一条普通的当前值条。
 *
 * `animate`：实心段自左 scaleX 长出、变化段随后淡入（只动 transform / opacity，backwards 填充）。
 * 时长缓动全取 `--motion-*` token；减动效由全局规则压成瞬时。
 */
import { computed } from 'vue';

const props = defineProps<{
  lo: number;
  hi: number;
  max: number;
  /** HP / MP / SP（大小写皆可） */
  resource: string;
  dir?: 'up' | 'down';
  animate?: boolean;
}>();

const RESOURCE_VAR: Record<string, string> = {
  hp: 'var(--theme-hp)',
  mp: 'var(--theme-mp)',
  sp: 'var(--theme-sp)',
};

function pct(value: number): string {
  const max = props.max;
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`;
}

const style = computed(() => ({
  '--rc': RESOURCE_VAR[props.resource.toLowerCase()] ?? 'var(--theme-text-muted)',
  '--lo': pct(Math.min(props.lo, props.hi)),
  '--hi': pct(Math.max(props.lo, props.hi)),
}));
</script>

<template>
  <span
    class="gbar"
    :class="{ 'is-animate': animate }"
    :data-dir="dir"
    :style="style"
    aria-hidden="true"
  >
    <i class="gbar-f" />
    <i class="gbar-g" />
  </span>
</template>

<style scoped>
.gbar {
  position: relative;
  display: block;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--rc) 16%, var(--theme-surface-muted));
}

.gbar-f,
.gbar-g {
  position: absolute;
  top: 0;
  bottom: 0;
}

.gbar-f {
  left: 0;
  width: var(--lo);
  background: var(--rc);
  transform-origin: left center;
}

.gbar-g {
  left: var(--lo);
  width: calc(var(--hi) - var(--lo));
}

.gbar[data-dir='down'] .gbar-g {
  background: repeating-linear-gradient(135deg, var(--theme-error) 0 2px, transparent 2px 4px);
  opacity: 0.75;
}

.gbar[data-dir='up'] .gbar-g {
  background: color-mix(in srgb, var(--theme-success) 75%, var(--theme-text-primary));
}

@keyframes gbar-fill {
  from {
    transform: scaleX(0);
  }
}

@keyframes gbar-ghost {
  from {
    opacity: 0;
  }
}

.gbar.is-animate .gbar-f {
  animation: gbar-fill var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}

.gbar.is-animate .gbar-g {
  animation: gbar-ghost var(--motion-duration-base) var(--motion-ease-standard)
    var(--motion-duration-base) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .gbar.is-animate .gbar-f,
  .gbar.is-animate .gbar-g {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .gbar.is-animate .gbar-f,
:root[data-reduced-motion='true'] .gbar.is-animate .gbar-g {
  animation: none;
}
</style>
