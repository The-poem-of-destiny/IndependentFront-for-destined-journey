<script setup lang="ts">
/**
 * CombatActionCard — 战斗动作结果卡片（M5 前端战斗面板子组件 P2）
 *
 * 渲染内核投影的动作结果：折叠显示攻守方、检定、伤害和 HP，展开显示结算详情。
 *
 * @see docs/design.md §4.6(折叠卡片) §6.1(grid-template-rows) §7.2(KV网格)
 */

import { ref, computed } from 'vue';

const props = defineProps<{
  /** 内核投影的动作结果 */
  result?: Record<string, unknown>;
  /** 工具名称，如 'attack' / 'cost' / 'flee' */
  toolName?: string;
  /** 单位 id → 名字字典（v3 攻击卡片用：生产路径 attackerId/targetId 是角色 UUID，
   *  显示标题前反查中文名；缺失时回退显示原 id） */
  units?: Record<string, string>;
}>();

// ── 折叠/展开状态 ──
const expanded = ref(false);

/** 安全读取 result.description */
const description = computed((): string => {
  const v = props.result?.description;
  return typeof v === 'string' ? v : '';
});

/** 工具名 → 中文标签映射 */
const toolLabel = computed((): string => {
  const map: Record<string, string> = {
    attack: '攻击',
    cost: '消耗',
    flee: '逃跑',
  };
  return map[props.toolName ?? ''] ?? props.toolName ?? '';
});

/** 是否为 v3 攻击卡片（扁平字段，顶层有 attackerId + targetId） */
const isAttack = computed((): boolean => {
  const r = props.result;
  return (
    r != null &&
    typeof r === 'object' &&
    typeof (r as Record<string, unknown>).attackerId === 'string' &&
    typeof (r as Record<string, unknown>).targetId === 'string' &&
    props.toolName === 'attack'
  );
});

/** v3：攻方 / 守方 id（用于反查名字，缺失回退 id） */
const attackerId = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.attackerId;
  return typeof v === 'string' ? v : null;
});
const targetId = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.targetId;
  return typeof v === 'string' ? v : null;
});

/** v3：技能名（可选） */
const skill = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.skill;
  return typeof v === 'string' && v.length > 0 ? v : null;
});

/** v3：检定值 / 评级 / 是否命中 */
const checkValue = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.checkValue;
  return typeof v === 'number' ? v : null;
});
const rating = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.rating;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
const hit = computed((): boolean | null => {
  const v = (props.result as Record<string, unknown>)?.hit;
  return typeof v === 'boolean' ? v : null;
});

/** v3：骰值数组（1~2 颗 d20，AttackResolved.dice） */
const dice = computed<number[] | null>(() => {
  const v = (props.result as Record<string, unknown>)?.dice;
  return Array.isArray(v) ? (v.filter((d) => typeof d === 'number') as number[]) : null;
});

/** v3：意图层级（AttackDeclared.intentionLevel） */
const intention = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.intentionLevel;
  return typeof v === 'string' && v.length > 0 ? v : null;
});

/** v3：最终伤害 / 伤害类型 / 目标 HP 前后 */
const final = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.final;
  return typeof v === 'number' ? v : null;
});
const damageType = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.damageType;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
/** v3：减免前伤害（= 初始伤害 = 属性×10×系数 + 技能威力 + 武器攻击力） */
const preReduction = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.preReduction;
  return typeof v === 'number' ? v : null;
});
/** v3：评级/意图系数修正后、DR 减免前的中间伤害值 */
const postStep6 = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.postStep6;
  return typeof v === 'number' ? v : null;
});
const targetHpBefore = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.targetHpBefore;
  return typeof v === 'number' ? v : null;
});
const targetHpAfter = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.targetHpAfter;
  return typeof v === 'number' ? v : null;
});

/** v3：是否命中（hit !== false 且伤害 > 0；未命中 = hit false 或伤害 0） */
const isMiss = computed((): boolean => {
  if (hit.value === false) return true;
  if (hit.value === null) return (final.value ?? 0) <= 0;
  return (final.value ?? 0) <= 0;
});

/** v3：按评级/命中映射语义色 */
const color = computed((): string => {
  if (isMiss.value) return 'var(--theme-text-muted)';
  if (final.value === null) return 'var(--theme-text-primary)';
  return 'var(--theme-primary)';
});

/** 从 v3 扁平字段渲染的摘要行：攻方 → 守方（技能）| 检定 N（评级）| 伤害 |
 *  HP 前后。攻守 id 先经 units 字典反查名字（生产是 UUID），查不到回退 id */
function summary(): {
  attacker: string;
  target: string;
  skill: string;
  check: string;
  rating: string;
  damage: string;
  hp: string;
} {
  const atk = attackerId.value ? (props.units?.[attackerId.value] ?? attackerId.value) : '未知';
  const tgt = targetId.value ? (props.units?.[targetId.value] ?? targetId.value) : '未知';
  const skillText = skill.value ? ` · ${skill.value}` : '';
  const check = checkValue.value !== null ? `检定 ${checkValue.value}` : '';
  const ratingText = rating.value ? `（${rating.value}）` : '';
  const dmg =
    final.value !== null && !isMiss.value
      ? `${final.value} 点${damageType.value ?? ''}伤害`
      : isMiss.value
        ? '未命中'
        : '';
  const hp =
    targetHpBefore.value !== null && targetHpAfter.value !== null
      ? `HP ${targetHpBefore.value} → ${targetHpAfter.value}`
      : '';
  return {
    attacker: atk,
    target: tgt,
    skill: skillText,
    check,
    rating: ratingText,
    damage: dmg,
    hp,
  };
}

/** v3：展开详情行（供模板渲染完整信息：骰值/检定/伤害分解/HP） */
const detailRows = computed(() => {
  const rows: Array<{ label: string; value: string; note?: string; highlight?: boolean }> = [];
  if (skill.value) rows.push({ label: '技能', value: skill.value });
  if (intention.value) rows.push({ label: '意图', value: intention.value });
  // 骰值：1~2 颗 d20 原始骰面 → checkValue（检定值）→ rating（评级）
  const diceStr = dice.value && dice.value.length > 0 ? dice.value.join(' + ') : null;
  if (checkValue.value !== null) {
    rows.push({
      label: '检定',
      value: `${checkValue.value}${rating.value ? `（${rating.value}）` : ''}`,
      note: diceStr ? `骰 ${diceStr}` : undefined,
    });
  } else if (diceStr) {
    rows.push({ label: '骰值', value: diceStr });
  }
  // 伤害分解：preReduction（初始）→ postStep6（评级修正后）→ final（DR 减免后）
  if (!isMiss.value && final.value !== null) {
    const parts: string[] = [];
    if (preReduction.value !== null) parts.push(`初始 ${preReduction.value}`);
    if (postStep6.value !== null && postStep6.value !== preReduction.value) {
      parts.push(`修正 ${postStep6.value}`);
    }
    if (postStep6.value !== null && final.value !== postStep6.value) {
      parts.push(`减免 −${postStep6.value - final.value}`);
    }
    rows.push({
      label: '伤害',
      value: `${final.value} 点${damageType.value ?? ''}`,
      note: parts.length > 1 ? parts.join(' → ') : undefined,
      highlight: true,
    });
  }
  if (targetHpBefore.value !== null && targetHpAfter.value !== null) {
    rows.push({
      label: '目标 HP',
      value: `${targetHpBefore.value} → ${targetHpAfter.value}`,
    });
  }
  return rows;
});
</script>

<template>
  <div class="combat-action-card">
    <!-- ════════ 折叠态：一行摘要 ════════ -->
    <div
      class="cac-header"
      role="button"
      :aria-expanded="expanded"
      :aria-label="`${toolLabel}结果卡片，${expanded ? '点击收起' : '点击展开'}`"
      tabindex="0"
      @click="expanded = !expanded"
      @keydown.enter.prevent="expanded = !expanded"
      @keydown.space.prevent="expanded = !expanded"
    >
      <span class="cac-tag">{{ toolLabel }}</span>

      <!-- 🆕 v3 攻击卡片：扁平字段摘要（2026-08-12） -->
      <template v-if="isAttack">
        <span class="cac-summary">
          <span class="cac-name">{{ summary().attacker }}</span>
          <i class="fa-solid fa-arrow-right cac-arrow" />
          <span class="cac-name">{{ summary().target }}</span>
          <span v-if="summary().skill" class="cac-skill">{{ summary().skill }}</span>
        </span>

        <span v-if="summary().check" class="cac-divider" />
        <span v-if="summary().check" class="cac-check">{{ summary().check }}</span>
        <span v-if="summary().rating" class="cac-rating" :style="{ color: color }">
          {{ summary().rating }}
        </span>

        <span v-if="summary().damage" class="cac-damage" :style="{ color: color }">
          {{ summary().damage }}
        </span>
        <span v-else-if="isMiss" class="cac-miss">未命中</span>

        <span v-if="summary().hp" class="cac-hp">{{ summary().hp }}</span>
      </template>

      <!-- 其他动作摘要 -->
      <template v-else>
        <span class="cac-fallback">{{ description || toolName }}</span>
      </template>

      <i class="fa-solid cac-chevron" :class="expanded ? 'fa-chevron-up' : 'fa-chevron-down'" />
    </div>

    <!-- ════════ 展开态：v3 扁平详情 / 8 步伤害管线 ════════ -->
    <Transition name="cac-expand">
      <!-- 🆕 v3 攻击卡片展开：骰值/检定/伤害分解/HP 详情行（2026-08-12） -->
      <div v-if="expanded && isAttack" class="cac-body">
        <div class="cac-detail-list">
          <div
            v-for="row in detailRows"
            :key="row.label"
            class="cac-step"
            :class="{ 'cac-step--final': row.highlight }"
          >
            <span class="cac-step-label" :class="{ 'cac-step-label--final': row.highlight }">
              {{ row.label }}
            </span>
            <span class="cac-step-value" :class="{ 'cac-step-value--final': row.highlight }">
              {{ row.value }}
            </span>
            <span v-if="row.note" class="cac-step-note">{{ row.note }}</span>
          </div>
          <div v-if="detailRows.length === 0" class="cac-desc">本次行动无详细结算数据</div>
        </div>
      </div>

      <!-- 展开态但无伤害分解：展示 description（如有） -->
      <div v-else-if="expanded && description" class="cac-body cac-body--fallback">
        <div class="cac-desc">{{ description }}</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ════════ 卡片骨架 ════════ */
.combat-action-card {
  border: 1px solid transparent;
  border-bottom-color: var(--theme-card-border);
  border-radius: 0;
  overflow: hidden;
  background: transparent;
  box-shadow: none;
}

/* ════════ 折叠态头部 ════════ */
.cac-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm, 8px);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  min-height: 36px; /* design §8: 触摸目标 ≥ 36px */
  cursor: pointer;
  user-select: none;
  background: transparent;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.cac-header:hover {
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-card-bg));
}
.cac-header:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}

/* 工具标签 */
.cac-tag {
  flex-shrink: 0;
  font-size: 0.6875rem; /* 11px 小字徽章 */
  font-weight: 600;
  color: var(--theme-text-muted);
  background: var(--theme-card-bg);
  padding: 1px 6px;
  border-radius: var(--theme-radius-sm);
  border: 1px solid var(--theme-card-border);
}

/* 摘要行 */
.cac-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.cac-name {
  font-size: 0.8125rem; /* 13px 正文 */
  font-weight: 600;
  color: var(--theme-text-primary);
}
.cac-arrow {
  font-size: 0.625rem; /* 10px */
  opacity: 0.4;
}

/* v3 攻击卡片：技能名小字（2026-08-12） */
.cac-skill {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-weight: 500;
  margin-inline-start: var(--theme-spacing-xs, 4px);
}

/* v3 攻击卡片：展开态详情行（复用管线步视觉） */
.cac-detail-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs, 4px);
}

.cac-divider {
  flex-shrink: 0;
  width: 1px;
  height: 12px;
  background: var(--theme-card-border);
}

/* 检定值 */
.cac-check {
  font-size: 0.75rem; /* 12px 辅助 */
  color: var(--theme-text-secondary);
}

/* 评级（语义色） */
.cac-rating {
  font-size: 0.75rem;
  font-weight: 600;
}

/* 伤害 */
.cac-damage {
  font-size: 0.75rem;
  color: var(--theme-error);
  font-weight: 600;
  margin-left: auto;
}

/* 未命中 */
.cac-miss {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
  margin-left: auto;
}

/* HP 概要 */
.cac-hp {
  flex-shrink: 0;
  font-size: 0.6875rem; /* 11px 小字 */
  color: var(--theme-text-muted);
}

/* 展开箭头 */
.cac-chevron {
  flex-shrink: 0;
  font-size: 0.625rem; /* 10px */
  opacity: 0.4;
  transition:
    opacity 0.15s ease,
    transform 0.25s ease;
  padding: 2px;
}
.cac-header:hover .cac-chevron {
  opacity: 0.8;
}

/* 无伤害分解时的兜底文字 */
.cac-fallback {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  margin-right: auto;
}

/* ════════ 展开态：grid-template-rows 过渡（design §6.1） ════════ */
.cac-expand-enter-active,
.cac-expand-leave-active {
  display: grid;
}
.cac-expand-enter-from,
.cac-expand-leave-to {
  opacity: 0;
}

/* ════════ 展开态内容 ════════ */
.cac-body {
  padding: var(--theme-spacing-md);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm, 8px);
  font-size: 0.75rem; /* 12px 管线步 */
  color: var(--theme-text-primary);
  background: color-mix(in srgb, var(--theme-card-bg) 76%, var(--theme-content-bg));
  border-top: 1px solid var(--theme-card-border);
}

.cac-body--fallback {
  padding: var(--theme-spacing-sm, 8px) var(--theme-spacing-md, 12px);
}
.cac-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
}

/* ── 单步 KV ── */
.cac-step {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm, 8px);
  padding: 3px 0;
  position: relative;
}
/* 步骤前的竖线节点圆点 */
.cac-step::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--theme-spacing-md, 12px) - 5px);
  top: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--theme-card-bg);
  border: 2px solid var(--theme-card-border);
}

.cac-step-label {
  flex-shrink: 0;
  font-size: 0.6875rem; /* 11px 标签 */
  font-weight: 600;
  color: var(--theme-text-muted);
  min-width: 4em;
}
.cac-step-value {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--theme-text-primary);
}
.cac-step-note {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  opacity: 0.7;
  margin-left: auto;
}

/* ── 最终伤害步骤（★ 高亮） ── */
.cac-step--final {
  align-items: center;
  padding: var(--theme-spacing-sm, 8px) 0 2px;
}
.cac-step--final::before {
  background: var(--theme-primary);
  border-color: var(--theme-primary);
  box-shadow: 0 0 6px color-mix(in srgb, var(--theme-primary) 45%, transparent);
}
.cac-step-label--final {
  color: var(--theme-primary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
}
.cac-step-label--final i {
  font-size: 0.625rem;
}
.cac-step-value--final {
  font-size: 0.9375rem; /* 15px 显著 */
  font-weight: 700;
  color: var(--theme-primary);
}

/* ════════ prefers-reduced-motion（design §6.3） ════════ */
@media (prefers-reduced-motion: reduce) {
  .cac-chevron {
    transition: none;
  }
  .cac-header {
    transition: none;
  }
}
</style>
