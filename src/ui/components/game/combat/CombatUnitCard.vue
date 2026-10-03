<script setup lang="ts">
/**
 * CombatUnitCard.vue — 战斗单位卡（C6 · 数据源 = 沙盒 `CombatUnit`）
 *
 * 渲染单个参战单位：名字（品质色点 + 着色）+ T/等级 + 位置 + HP/MP/SP + 五维 +
 * 攻击/动作槽 + 状态 + 技能 / 装备列表（全部从单位数据读，组件不写死任何单位/技能/数值）。
 *
 * 设计规范遵循 docs/design.md：品质用色点 + 名字着色（§5.3，禁侧边条）、
 * 间距用 --theme-spacing-*、非当前行动者降低存在感、`prefers-reduced-motion`。
 */
import { computed } from 'vue';
import type { CombatUnit } from '@engine/combat/sandbox/types';
import { qualityLabelForTier, qualityVar } from '../../../lib/quality-colors';
import {
  COMBAT_ATTRIBUTE_LABELS,
  COMBAT_FACING_LABELS,
  moraleLabel,
  resourcePercent,
  slotStatesOf,
  statusViewsOf,
} from './combat-view';
import ResourceBar from '../../shared/ResourceBar.vue';
import BuffChip from '../../shared/BuffChip.vue';

const props = withDefaults(
  defineProps<{
    unit: CombatUnit;
    /** 当前行动者（环绕光晕） */
    isCurrent?: boolean;
    /** 高亮为可选目标 / 落点 */
    isTarget?: boolean;
  }>(),
  { isCurrent: false, isTarget: false },
);

const qualityName = computed(() => qualityLabelForTier(props.unit.tier));
const qualityColor = computed(() => qualityVar(qualityName.value));

const isDead = computed(() => !props.unit.alive || props.unit.hp <= 0);
const isLowHp = computed(
  () => !isDead.value && resourcePercent(props.unit.hp, props.unit.maxHp) < 30,
);
const isIncapacitated = computed(() => !isDead.value && !props.unit.canAct);

const statusViews = computed(() => statusViewsOf(props.unit));
const slotStates = computed(() => slotStatesOf(props.unit));
const facingLabel = computed(() => COMBAT_FACING_LABELS[props.unit.facing] ?? '');
const morale = computed(() => moraleLabel(props.unit));

/** 只有真实存在的资源条才渲染（max>0），避免敌人满屏 0/0 */
const resourceRows = computed(() =>
  [
    { label: 'HP', current: props.unit.hp, max: props.unit.maxHp, color: 'var(--theme-hp)' },
    { label: 'MP', current: props.unit.mp, max: props.unit.maxMp, color: 'var(--theme-mp)' },
    { label: 'SP', current: props.unit.sp, max: props.unit.maxSp, color: 'var(--theme-sp)' },
  ].filter((row) => row.max > 0 || row.current > 0),
);

const skills = computed(() => props.unit.skills ?? []);
const equipment = computed(() => props.unit.equipment ?? []);
</script>

<template>
  <article
    class="combat-unit-card"
    :class="{
      'is-current': isCurrent,
      'is-target': isTarget,
      'is-dead': isDead,
      'is-incapacitated': isIncapacitated,
    }"
  >
    <header class="cu-top">
      <span class="quality-dot" :style="{ background: qualityColor }" aria-hidden="true" />
      <span class="cu-name" :style="{ color: qualityColor }">{{ unit.name }}</span>
      <span class="cu-sub">{{ unit.race }} · T{{ unit.tier }} / Lv.{{ unit.level }}</span>
      <span v-if="unit.cluster" class="cu-cluster">
        {{ unit.cluster.alive }}/{{ unit.cluster.total }}
      </span>
      <span class="cu-pos">位置 {{ unit.pos }}</span>
    </header>

    <div class="cu-bars">
      <ResourceBar
        v-for="row in resourceRows"
        :key="row.label"
        :label="row.label"
        :current="row.current"
        :max="row.max"
        :color="row.color"
        show-values
      />
    </div>

    <div class="cu-attrs">
      <span v-for="attr in COMBAT_ATTRIBUTE_LABELS" :key="attr.key" class="cu-attr">
        {{ attr.short }} <b>{{ unit.attributes[attr.key] }}</b>
      </span>
    </div>

    <div class="cu-status">
      <div class="cu-slots">
        <span v-for="slot in slotStates" :key="slot.label" class="cu-slot">
          <i class="cu-dot" :class="{ on: slot.remaining > 0 }" />
          {{ slot.label }}<template v-if="slot.remaining > 1"> ×{{ slot.remaining }}</template>
        </span>
      </div>
      <span v-if="unit.morale !== 'steady'" class="cu-morale">战意 {{ morale }}</span>
      <span v-if="isLowHp" class="cu-flag is-warn">⚠ 低血</span>
      <span v-if="isDead" class="cu-flag is-dead">已倒下</span>
      <span v-else-if="isIncapacitated" class="cu-flag">无法行动</span>
      <span v-if="facingLabel" class="cu-facing">{{ facingLabel }}</span>
    </div>

    <div v-if="statusViews.length" class="cu-buffs">
      <span v-for="(chip, i) in statusViews" :key="i" class="cu-buff-group">
        <BuffChip :type="chip.type" :name="chip.name" :stacks="chip.stacks" />
        <span v-if="chip.remainRounds !== null" class="cu-remain"
          >剩{{ chip.remainRounds }}回合</span
        >
      </span>
    </div>

    <ul v-if="skills.length || equipment.length" class="cu-loadout">
      <li v-for="skill in skills" :key="'s-' + skill.name" class="cu-item">
        <span class="cu-item-name">{{ skill.name }}</span>
        <span v-if="skill.type" class="cu-item-tag">{{ skill.type }}</span>
        <span v-if="skill.cost" class="cu-item-num">{{ skill.cost }}</span>
        <span v-if="skill.skillPower !== undefined" class="cu-item-num"
          >威力 <b>{{ skill.skillPower }}</b></span
        >
        <span v-if="skill.description" class="cu-item-eff">{{ skill.description }}</span>
        <span v-if="skill.tags?.length" class="cu-item-tags">
          <span v-for="tag in skill.tags" :key="tag" class="tag">{{ tag }}</span>
        </span>
      </li>
      <li v-for="eq in equipment" :key="'e-' + eq.name" class="cu-item">
        <span
          class="cu-item-name"
          :style="{ color: eq.rarity ? qualityVar(eq.rarity) : undefined }"
        >
          {{ eq.name }}
        </span>
        <span v-if="eq.slot" class="cu-item-tag">{{ eq.slot }}</span>
        <span v-if="eq.description" class="cu-item-eff">{{ eq.description }}</span>
        <span v-if="eq.tags?.length" class="cu-item-tags">
          <span v-for="tag in eq.tags" :key="tag" class="tag">{{ tag }}</span>
        </span>
      </li>
    </ul>
  </article>
</template>

<style scoped>
.combat-unit-card {
  display: flex;
  flex-direction: column;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  overflow: hidden;
  box-shadow: var(--paper-stack);
  transition:
    border-color var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast),
    opacity 0.2s ease;
}
.combat-unit-card.is-current {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 45%, transparent);
}
.combat-unit-card.is-target {
  border-color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 8%, var(--theme-card-bg));
}
.combat-unit-card.is-incapacitated {
  opacity: 0.65;
}
.combat-unit-card.is-dead {
  opacity: 0.5;
}
.is-dead .cu-name {
  text-decoration: line-through;
}

.cu-top {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-surface-muted);
  min-width: 0;
}
.quality-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.cu-name {
  font-family: var(--theme-font-title);
  font-weight: 600;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cu-sub {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cu-cluster {
  font-size: 0.6875rem;
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 35%, transparent);
  border-radius: var(--theme-radius-full);
  padding: 0 6px;
}
.cu-pos {
  margin-left: auto;
  flex: none;
  font-size: 0.6875rem;
  color: var(--theme-primary);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  padding: 1px 8px;
}

.cu-bars {
  display: flex;
  flex-direction: column;
  gap: calc(var(--theme-spacing-xs) / 2);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}

.cu-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-md) var(--theme-spacing-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.cu-attr b {
  color: var(--theme-text-primary);
  font-weight: 600;
}

.cu-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-md) var(--theme-spacing-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.cu-slots {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.cu-slot {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.cu-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--theme-text-muted);
}
.cu-dot.on {
  background: var(--theme-primary);
  border-color: var(--theme-primary);
}
.cu-morale {
  color: var(--theme-warning);
}
.cu-flag {
  color: var(--theme-warning);
}
.cu-flag.is-warn {
  color: var(--theme-error);
}
.cu-flag.is-dead {
  color: var(--theme-error);
}
.cu-facing {
  margin-left: auto;
}

.cu-buffs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  padding: 0 var(--theme-spacing-md) var(--theme-spacing-sm);
}
.cu-buff-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.cu-remain {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}

.cu-loadout {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.cu-item {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
}
.cu-item-name {
  font-weight: 600;
  color: var(--theme-text-primary);
}
.cu-item-tag {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  padding: 0 4px;
}
.cu-item-num {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.cu-item-num b {
  color: var(--theme-primary);
}
.cu-item-eff {
  flex-basis: 100%;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  line-height: 1.5;
}
.cu-item-tags {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.tag {
  font-size: 0.625rem;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  border-radius: var(--theme-radius-sm);
  padding: 0 5px;
}

@media (prefers-reduced-motion: reduce) {
  .combat-unit-card {
    transition: none;
  }
}
</style>
