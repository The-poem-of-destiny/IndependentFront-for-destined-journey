<script setup lang="ts">
/**
 * CombatUnitCard.vue — 战斗单位紧凑卡片（M5 前端战斗面板 P1 子组件）
 *
 * 渲染单个参战单位（CombatParticipant）的紧凑卡片，用于 CombatPanel 的敌我展示区
 * （敌方在上、我方在下）。展示：品质色点 + 名字 + tier/level + HP/MP/SP 资源条
 * + buff chips + 低血/死亡/当前行动者/无法行动 状态标记。
 *
 * 设计规范遵循 docs/design.md：
 * - 禁侧边条，品质用色点 + 名字着色（§5.3）
 * - 选中态环绕光晕用 box-shadow（§4.2）
 * - 间距用 --theme-spacing-* 变量（§3）
 * - 名字用 var(--theme-font-title)（§2 衬线叙事）
 * - HP 闪烁动画配合 prefers-reduced-motion（§6.3）
 */

import { computed } from 'vue'
import type { CombatParticipant, StatusEffect } from '@engine/types'
import { qualityVar } from '../../../lib/quality-colors'
import ResourceBar from '../../shared/ResourceBar.vue'
import BuffChip from '../../shared/BuffChip.vue'

const props = withDefaults(
  defineProps<{
    /** 参战单位数据 */
    participant: CombatParticipant
    /** 是否为当前行动者（高亮环绕光晕） */
    isCurrentTurn?: boolean
  }>(),
  { isCurrentTurn: false },
)

// ── tier(number 1-7) → 中文品质名（对齐世界书层级 T1-T7 = 普通~唯一）──
const TIER_TO_QUALITY: readonly string[] = [
  '',      // 0 占位（tier 从 1 起）
  '普通',  // T1
  '优良',  // T2
  '稀有',  // T3
  '史诗',  // T4
  '传说',  // T5
  '神话',  // T6
  '唯一',  // T7
]

/** tier 数字 → 中文品质名，越界兜底「普通」 */
function tierToQuality(tier: number): string {
  return TIER_TO_QUALITY[tier] ?? '普通'
}

// ── 派生状态 ──

const qualityName = computed(() => tierToQuality(props.participant.tier))
const qualityColor = computed(() => qualityVar(qualityName.value))

/** HP 百分比（0-100），maxHp<=0 时返回 0 */
const hpPercent = computed(() => {
  const { hp, maxHp } = props.participant
  if (maxHp <= 0) return 0
  return Math.min(100, Math.max(0, (hp / maxHp) * 100))
})

/** 是否死亡（hp <= 0） */
const isDead = computed(() => props.participant.hp <= 0)

/** 是否低血（HP < 30% 且 hp > 0） */
const isLowHp = computed(() => !isDead.value && hpPercent.value > 0 && hpPercent.value < 30)

/** 是否无法行动（非死亡但 canAct=false，如眩晕/冰冻） */
const isIncapacitated = computed(() => !isDead.value && !props.participant.canAct)

// ── BuffChip 类型映射 ──
// StatusEffect.category: '增益'|'减益'|'特殊' → BuffChip type: 'buff'|'debuff'|'special'
type BuffChipType = 'buff' | 'debuff' | 'special'
const CATEGORY_TO_CHIP: Record<StatusEffect['category'], BuffChipType> = {
  增益: 'buff',
  减益: 'debuff',
  特殊: 'special',
}

/** 格式化状态效果列表为 BuffChip 所需的 props */
const buffChips = computed(() =>
  (props.participant.statusEffects ?? []).map((fx) => ({
    type: CATEGORY_TO_CHIP[fx.category] ?? 'special',
    name: fx.name,
    stacks: fx.stacks,
    // 战斗中 timeUnit='回合' 时显示剩余回合数；否则不追加回合标注
    remainRounds: fx.timeUnit === '回合' && fx.remainingTime != null ? fx.remainingTime : null,
  })),
)
</script>

<template>
  <div
    class="combat-unit-card"
    :class="{
      'is-current-turn': isCurrentTurn,
      'is-dead': isDead,
      'is-incapacitated': isIncapacitated,
    }"
  >
    <!-- ── 名字行 ── -->
    <div class="unit-header">
      <div class="unit-name-row">
        <span class="quality-dot" :style="{ background: qualityColor }" aria-hidden="true" />
        <span class="unit-name" :style="{ color: qualityColor }">{{ participant.name }}</span>
        <span class="unit-tier-level">T{{ participant.tier }} · Lv{{ participant.level }}</span>
      </div>

      <!-- 右侧状态标记 -->
      <div class="unit-marks">
        <span v-if="isLowHp" class="mark mark-low-hp">⚠ 低血</span>
        <span v-if="isDead" class="mark mark-dead">已倒下</span>
        <span v-else-if="isIncapacitated" class="mark mark-incapacitated">无法行动</span>
      </div>
    </div>

    <!-- ── HP / MP / SP 资源条 ── -->
    <div class="unit-resources" :class="{ 'hp-flashing': isLowHp }">
      <ResourceBar
        label="HP"
        :current="participant.hp"
        :max="participant.maxHp"
        color="var(--theme-hp)"
      />
      <ResourceBar
        label="MP"
        :current="participant.mp"
        :max="participant.maxMp"
        color="var(--theme-mp)"
      />
      <ResourceBar
        label="SP"
        :current="participant.sp"
        :max="participant.maxSp"
        color="var(--theme-sp)"
      />
    </div>

    <!-- ── Buff chips（每个 buff 和它的剩余回合小标成组渲染） ── -->
    <div v-if="buffChips.length > 0" class="unit-buffs">
      <span
        v-for="(chip, idx) in buffChips"
        :key="idx"
        class="buff-group"
      >
        <BuffChip :type="chip.type" :name="chip.name" :stacks="chip.stacks" />
        <!-- 剩余回合小标（仅战斗型、有剩余时间时显示，不侵入 BuffChip 通用组件） -->
        <span v-if="chip.remainRounds !== null" class="buff-remain">
          剩{{ chip.remainRounds }}回合
        </span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.combat-unit-card {
  position: relative;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-md);
  transition: box-shadow 0.15s ease, opacity 0.2s ease;
}

/* 当前行动者：环绕光晕（design §4.2 选中态） */
.combat-unit-card.is-current-turn {
  box-shadow: 0 0 0 1px var(--theme-primary);
}

/* 无法行动（非死亡）：降低存在感 */
.combat-unit-card.is-incapacitated {
  opacity: 0.6;
}

/* 死亡态：半透明 + 删除线由名字承担 */
.combat-unit-card.is-dead {
  opacity: 0.5;
}

/* ── 名字行 ── */
.unit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
}

.unit-name-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-width: 0; /* 允许名字截断 */
}

.quality-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.unit-name {
  font-family: var(--theme-font-title);
  font-weight: 600;
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 死亡态：名字加删除线 */
.is-dead .unit-name {
  text-decoration: line-through;
}

.unit-tier-level {
  flex-shrink: 0;
  font-size: 0.72rem;
  color: var(--theme-text-muted);
  font-weight: 500;
  letter-spacing: 0.02em;
}

/* ── 右侧状态标记 ── */
.unit-marks {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}

.mark {
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: var(--theme-radius-full);
}

.mark-low-hp {
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
}

.mark-dead {
  color: #fff;
  background: color-mix(in srgb, var(--theme-error) 70%, transparent);
  border: 1px solid var(--theme-error);
}

.mark-incapacitated {
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}

/* ── 资源条区 ── */
.unit-resources {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

/* 低血时 HP 条闪烁动画 */
.hp-flashing > :deep(.resource-bar:first-child .res-fill) {
  animation: hp-flash 1s ease-in-out infinite;
}

@keyframes hp-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Buff chips 区 ── */
.unit-buffs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs);
  margin-top: var(--theme-spacing-sm);
}

/* BuffChip + 剩余回合小标 成组紧挨（不换行） */
.buff-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}

/* 剩余回合小标（独立于 BuffChip，不侵入通用组件） */
.buff-remain {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-weight: 500;
}

/* ── prefers-reduced-motion：禁用闪烁动画（design §6.3） ── */
@media (prefers-reduced-motion: reduce) {
  .combat-unit-card {
    transition: none;
  }
  .hp-flashing > :deep(.resource-bar:first-child .res-fill) {
    animation: none;
  }
}
</style>
