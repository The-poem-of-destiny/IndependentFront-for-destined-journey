<script setup lang="ts">
/**
 * CombatUnitCard.vue — 战斗单位紧凑卡片（M5 前端战斗面板 P1 子组件 · v3 数据源）
 *
 * 渲染单个参战单位（v3 CombatUnitView）的紧凑卡片，用于 CombatPanel 的敌我展示区
 * （敌方在上、我方在下）。展示：品质色点 + 名字 + tier + HP/MP/SP 资源条
 * + buff chips + 战意 + 低血/死亡/当前行动者/无法行动 状态标记。
 *
 * 详情展开（设计 §3.3）：五维 + 技能列表 + Lv —— v3 CombatUnitView 不含五维/等级
 * （外层零额外拉取），从本地 characters 数据按单位 id（= 角色名，铁律 ①）反查，
 * 查不到（怪物/临时单位）显示占位文案。
 *
 * 设计规范遵循 docs/design.md：
 * - 禁侧边条，品质用色点 + 名字着色（§5.3）
 * - 选中态环绕光晕用 box-shadow（§4.2）
 * - 间距用 --theme-spacing-* 变量（§3）
 * - 名字用 var(--theme-font-title)（§2 衬线叙事）
 * - HP 闪烁动画配合 prefers-reduced-motion（§6.3）
 */

import { computed, ref } from 'vue';
import { MORALE_STATE_LABELS, type CharacterState, type StatusEffect } from '@engine/types';
import { useGameStore } from '../../../stores/game-store';
import { qualityLabelForTier, qualityVar } from '../../../lib/quality-colors';
import type { V3Unit } from './combat-v3-projection';
import ResourceBar from '../../shared/ResourceBar.vue';
import BuffChip from '../../shared/BuffChip.vue';

const props = withDefaults(
  defineProps<{
    /** v3 参战单位数据（CombatUnitView，经 CombatView.units 索引推导） */
    unit: V3Unit;
    /** 是否为当前行动者（高亮环绕光晕） */
    isCurrentTurn?: boolean;
  }>(),
  { isCurrentTurn: false },
);

const game = useGameStore();

// Q-11: tier(1-7) → 中文品质名（世界书 T1-T7 = 普通~唯一）走唯一入口，
// 此前本文件自带一张带 0 号占位的平行表。
const tierToQuality = qualityLabelForTier;

// ── 详情展开（设计 §3.3）──
const expanded = ref(false);

/** 五维中文标签（与 StatusOverview / CharacterListPanel 同口径） */
const ATTR_ROWS: ReadonlyArray<{ key: keyof CharacterState['attributes']; label: string }> = [
  { key: 'str', label: '力量' },
  { key: 'dex', label: '敏捷' },
  { key: 'con', label: '体质' },
  { key: 'int', label: '智力' },
  { key: 'spi', label: '精神' },
];

/** 详情数据：本地 characters 按单位 id（= 角色名）反查；只在展开时才查 */
const detail = computed<CharacterState | null>(() => {
  if (!expanded.value) return null;
  return game.characters.find((c) => c.id === props.unit.id) ?? null;
});

// ── 派生状态 ──

const qualityName = computed(() => tierToQuality(props.unit.tier));
const qualityColor = computed(() => qualityVar(qualityName.value));

/** 战意中文标签（MORALE_STATE_LABELS 是唯一入口） */
const moraleLabel = computed(() => MORALE_STATE_LABELS[props.unit.morale] ?? props.unit.morale);

/** HP 百分比（0-100），maxHp<=0 时返回 0 */
const hpPercent = computed(() => {
  const { hp, maxHp } = props.unit;
  if (maxHp <= 0) return 0;
  return Math.min(100, Math.max(0, (hp / maxHp) * 100));
});

/** 是否死亡（hp <= 0） */
const isDead = computed(() => props.unit.hp <= 0);

/** 是否低血（HP < 30% 且 hp > 0） */
const isLowHp = computed(() => !isDead.value && hpPercent.value > 0 && hpPercent.value < 30);

/** 是否无法行动（非死亡但 canAct=false，如眩晕/冰冻） */
const isIncapacitated = computed(() => !isDead.value && !props.unit.canAct);

// ── BuffChip 类型映射 ──
// StatusEffect.category: '增益'|'减益'|'特殊' → BuffChip type: 'buff'|'debuff'|'special'
type BuffChipType = 'buff' | 'debuff' | 'special';
const CATEGORY_TO_CHIP: Record<StatusEffect['category'], BuffChipType> = {
  增益: 'buff',
  减益: 'debuff',
  特殊: 'special',
};

/** 格式化状态效果列表为 BuffChip 所需的 props */
const buffChips = computed(() =>
  (props.unit.statusEffects ?? []).map((fx) => ({
    type: CATEGORY_TO_CHIP[fx.category] ?? 'special',
    name: fx.name,
    stacks: fx.stacks,
    // 战斗中 timeUnit='回合' 时显示剩余回合数；否则不追加回合标注
    remainRounds: fx.timeUnit === '回合' && fx.remainingTime != null ? fx.remainingTime : null,
  })),
);
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
        <span class="unit-name" :style="{ color: qualityColor }">{{ unit.name }}</span>
        <!-- v3 CombatUnitView 无 level（外层零额外拉取，设计 §3.3）；Lv 进详情展开 -->
        <span class="unit-tier-level">T{{ unit.tier }}</span>
      </div>

      <!-- 右侧状态标记 -->
      <div class="unit-marks">
        <span v-if="unit.morale !== 'steady'" class="mark mark-morale">
          战意 {{ moraleLabel }}
        </span>
        <span v-if="isLowHp" class="mark mark-low-hp">⚠ 低血</span>
        <span v-if="isDead" class="mark mark-dead">已倒下</span>
        <span v-else-if="isIncapacitated" class="mark mark-incapacitated">无法行动</span>
        <button class="detail-toggle" type="button" @click="expanded = !expanded">
          {{ expanded ? '收起' : '详情' }}
        </button>
      </div>
    </div>

    <!-- ── HP / MP / SP 资源条 ── -->
    <div class="unit-resources" :class="{ 'hp-flashing': isLowHp }">
      <ResourceBar
        label="HP"
        :current="unit.hp"
        :max="unit.maxHp"
        color="var(--theme-hp)"
      />
      <ResourceBar
        label="MP"
        :current="unit.mp"
        :max="unit.maxMp"
        color="var(--theme-mp)"
      />
      <ResourceBar
        label="SP"
        :current="unit.sp"
        :max="unit.maxSp"
        color="var(--theme-sp)"
      />
    </div>

    <!-- ── Buff chips（每个 buff 和它的剩余回合小标成组渲染） ── -->
    <div v-if="buffChips.length > 0" class="unit-buffs">
      <span v-for="(chip, idx) in buffChips" :key="idx" class="buff-group">
        <BuffChip :type="chip.type" :name="chip.name" :stacks="chip.stacks" />
        <!-- 剩余回合小标（仅战斗型、有剩余时间时显示，不侵入 BuffChip 通用组件） -->
        <span v-if="chip.remainRounds !== null" class="buff-remain">
          剩{{ chip.remainRounds }}回合
        </span>
      </span>
    </div>

    <!-- ── 详情展开（设计 §3.3：五维 + 技能列表 + Lv，本地 characters 数据） ── -->
    <div v-if="expanded" class="unit-detail">
      <template v-if="detail">
        <div class="detail-row">
          <span class="detail-label">Lv.{{ detail.level }}</span>
          <span class="detail-value">{{ detail.race }}</span>
        </div>
        <div class="detail-row">
          <span v-for="a in ATTR_ROWS" :key="a.key" class="attr-item">
            <span class="attr-label">{{ a.label }}</span>
            <span class="attr-value">{{ detail.attributes[a.key] }}</span>
          </span>
        </div>
        <div class="detail-row">
          <span class="detail-label">技能</span>
          <span v-if="!detail.skills?.length" class="detail-empty">无</span>
          <span v-else class="skill-chips">
            <span v-for="sk in detail.skills" :key="sk.name" class="skill-chip">{{ sk.name }}</span>
          </span>
        </div>
      </template>
      <div v-else class="detail-empty">暂无角色数据（怪物/临时单位）</div>
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
  transition:
    box-shadow 0.15s ease,
    opacity 0.2s ease;
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

/* 战意标记（非 steady 才显示，v3 CombatUnitView.morale） */
.mark-morale {
  color: var(--theme-text-secondary, var(--theme-text-muted));
  background: color-mix(in srgb, var(--theme-text-muted) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-text-muted) 25%, transparent);
}

/* 详情展开开关（触摸目标 ≥ 36px） */
.detail-toggle {
  min-height: 22px;
  padding: 0 8px;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: system-ui, sans-serif;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  border-radius: var(--theme-radius-full);
  cursor: pointer;
  transition: opacity var(--theme-transition-fast);
}

.detail-toggle:hover {
  opacity: 0.8;
}

/* ── 详情展开区（设计 §3.3：五维 + 技能 + Lv）── */
.unit-detail {
  margin-top: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px dashed var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.detail-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-sm);
  font-size: 0.75rem;
}

.detail-label {
  flex-shrink: 0;
  color: var(--theme-text-muted);
  font-weight: 600;
}

.detail-value {
  color: var(--theme-text-secondary, var(--theme-text-muted));
}

.attr-item {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}

.attr-label {
  color: var(--theme-text-muted);
}

.attr-value {
  color: var(--theme-text-primary);
  font-weight: 600;
}

.skill-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}

.skill-chip {
  padding: 1px 8px;
  font-size: 0.7rem;
  color: var(--theme-text-secondary, var(--theme-text-muted));
  background: var(--theme-bg-secondary, var(--theme-card-bg));
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
}

.detail-empty {
  color: var(--theme-text-muted);
  font-style: italic;
  font-size: 0.72rem;
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
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
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
  .detail-toggle {
    transition: none;
  }
}
</style>
