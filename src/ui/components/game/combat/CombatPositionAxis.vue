<script setup lang="ts">
/**
 * CombatPositionAxis.vue — 坐标轴与站位（C6 · 数据源 = 沙盒 `CombatState`）
 *
 * 按 `unit.pos` 把参战单位投影到 `meta.coordinateRange` 坐标轴上，标出阵营、当前
 * 行动者与面向。坐标范围 / 位置全部来自状态，组件不写死任何刻度或单位。
 */
import { computed } from 'vue';
import type { CombatState } from '@engine/combat/sandbox/types';
import { COMBAT_FACING_LABELS, axisTicks, posToPercent } from './combat-view';

const props = defineProps<{ state: CombatState }>();

const range = computed(() => props.state.meta.coordinateRange);
const ticks = computed(() => axisTicks(range.value));
const units = computed(() => Object.values(props.state.units));
const currentName = computed(() => props.state.meta.pendingPlayerUnit ?? null);

function boxClass(pos: number): Record<string, boolean> {
  const unit = Object.values(props.state.units).find((u) => u.pos === pos);
  return {
    ally: unit?.side === 'ally',
    enemy: unit?.side === 'enemy',
    current: !!currentName.value && unit?.name === currentName.value,
    dead: !!unit && !unit.alive,
  };
}

function facingOf(pos: number): string {
  const unit = Object.values(props.state.units).find((u) => u.pos === pos);
  return unit ? (COMBAT_FACING_LABELS[unit.facing] ?? '') : '';
}
</script>

<template>
  <section class="axis-wrap" aria-label="坐标轴与站位">
    <div class="axis-head">
      <span class="ah-title">坐标轴与站位</span>
      <span class="ah-sub">坐标范围 0 ~ {{ range }}</span>
    </div>
    <div class="axis">
      <div class="axis-line" />
      <span
        v-for="tick in ticks"
        :key="tick"
        class="axis-tick"
        :style="{ left: posToPercent(tick, range) + '%' }"
      >
        {{ tick }}
      </span>
      <div
        v-for="unit in units"
        :key="unit.name"
        class="unitbox"
        :class="boxClass(unit.pos)"
        :style="{ left: posToPercent(unit.pos, range) + '%' }"
      >
        <div class="ub-name">{{ unit.name }}</div>
        <div v-if="facingOf(unit.pos)" class="ub-face">{{ facingOf(unit.pos) }}</div>
      </div>
    </div>
    <div class="legend">
      <span><i class="lg-ally" />我方</span>
      <span><i class="lg-enemy" />敌方</span>
      <span><i class="lg-current" />当前行动者</span>
      <span>从当前位置检查有效距离</span>
    </div>
  </section>
</template>

<style scoped>
.axis-wrap {
  padding: var(--theme-spacing-md) var(--theme-spacing-xl) var(--theme-spacing-sm);
  border-bottom: 1px solid var(--theme-card-border);
  background: color-mix(in srgb, var(--theme-window-bg) 40%, transparent);
  flex-shrink: 0;
}
.axis-head {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
}
.ah-title {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-primary);
  font-weight: 600;
}
.ah-sub {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.axis {
  position: relative;
  height: 74px;
  margin: 0 var(--theme-spacing-sm);
}
.axis-line {
  position: absolute;
  bottom: 22px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--theme-card-border);
}
.axis-tick {
  position: absolute;
  bottom: 4px;
  transform: translateX(-50%);
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.axis-tick::before {
  content: '';
  position: absolute;
  bottom: 14px;
  left: 50%;
  width: 1px;
  height: 5px;
  background: var(--theme-card-border);
}
.unitbox {
  position: absolute;
  bottom: 26px;
  transform: translateX(-50%);
  width: 108px;
  padding: 4px 6px;
  border-radius: var(--theme-radius-sm);
  border: 1px solid var(--theme-card-border);
  background: var(--theme-card-bg);
  text-align: center;
  font-size: 0.6875rem;
  line-height: 1.35;
  transition: border-color var(--theme-transition-fast);
}
.ub-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ub-face {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.unitbox.ally {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
}
.unitbox.enemy {
  border-color: color-mix(in srgb, var(--theme-error) 55%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-error) 12%, var(--theme-card-bg));
}
.unitbox.current {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 1px var(--theme-primary);
}
.unitbox.dead {
  opacity: 0.45;
  text-decoration: line-through;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-lg);
  margin-top: var(--theme-spacing-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: -1px;
  border: 1px solid var(--theme-card-border);
}
.lg-ally {
  background: color-mix(in srgb, var(--theme-primary) 50%, transparent);
}
.lg-enemy {
  background: color-mix(in srgb, var(--theme-error) 50%, transparent);
}
.lg-current {
  background: var(--theme-primary);
  border-color: var(--theme-primary) !important;
}
</style>
