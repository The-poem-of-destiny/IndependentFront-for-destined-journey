<script setup lang="ts">
/**
 * CombatActionCard — 战斗动作结果卡片（M5 前端战斗面板子组件 P2）
 *
 * 渲染单次工具调用（主要是 combat_attack）的结果卡片：
 * - 折叠态：一行摘要（攻方→守方 / 检定评级 / 最终伤害）
 * - 展开态：8 步伤害管线竖向 KV + HP 变化 + 状态施加
 *
 * 替代旧 combat-panel.ts 的 <action_info> XML 文本。
 *
 * @see docs/planning/2026-07-29-combat-v2-m5-plan.md §2.4
 * @see docs/design.md §4.6(折叠卡片) §6.1(grid-template-rows) §7.2(KV网格)
 */

import { ref, computed } from 'vue';
import type { CombatActionResult, CombatDamageBreakdown } from '@engine/types';

const props = defineProps<{
  /** 工具调用结果（CombatActionResult 形状，可能不完整） */
  result?: Record<string, unknown>;
  /** 工具名称，如 'combat_attack' / 'combat_use_skill' / 'status_apply' */
  toolName?: string;
  /** 单位 id → 名字字典（v3 攻击卡片用：生产路径 attackerId/targetId 是角色 UUID，
   *  显示标题前反查中文名；缺失时回退显示原 id） */
  units?: Record<string, string>;
}>();

// ── 折叠/展开状态 ──
const expanded = ref(false);

// ── 防御性类型窄化辅助 ──
/** 判断 result 是否包含完整伤害分解（是 combat_attack 型结果） */
const hasDamageBreakdown = computed((): boolean => {
  const r = props.result;
  return (
    r?.damage != null &&
    typeof r.damage === 'object' &&
    (r.damage as Record<string, unknown>)?.finalDamage != null &&
    typeof r.attackRoll === 'object'
  );
});

/** 安全读取 result.attackRoll.rating.level（评级名） */
const ratingLevel = computed((): string | null => {
  const attackRoll = props.result?.attackRoll;
  if (attackRoll == null || typeof attackRoll !== 'object') return null;
  const rating = (attackRoll as Record<string, unknown>)?.rating;
  if (rating == null || typeof rating !== 'object') return null;
  const level = (rating as Record<string, unknown>)?.level;
  return typeof level === 'string' ? level : null;
});

/** 安全读取 result.attackRoll.rating.coefficient（评级系数） */
const ratingCoefficient = computed((): number | null => {
  const attackRoll = props.result?.attackRoll;
  if (attackRoll == null || typeof attackRoll !== 'object') return null;
  const rating = (attackRoll as Record<string, unknown>)?.rating;
  if (rating == null || typeof rating !== 'object') return null;
  const coeff = (rating as Record<string, unknown>)?.coefficient;
  return typeof coeff === 'number' ? coeff : null;
});

/** 安全读取 result.attackRoll.checkValue */
const checkValue = computed((): number | null => {
  const attackRoll = props.result?.attackRoll;
  if (attackRoll == null || typeof attackRoll !== 'object') return null;
  const cv = (attackRoll as Record<string, unknown>)?.checkValue;
  return typeof cv === 'number' ? cv : null;
});

/** 安全读取 result.request.attackerId / defenderId */
const attackerId = computed((): string | null => {
  const req = props.result?.request;
  if (req == null || typeof req !== 'object') return null;
  const id = (req as Record<string, unknown>)?.attackerId;
  return typeof id === 'string' ? id : null;
});
const defenderId = computed((): string | null => {
  const req = props.result?.request;
  if (req == null || typeof req !== 'object') return null;
  const id = (req as Record<string, unknown>)?.defenderId;
  return typeof id === 'string' ? id : null;
});

/** 安全读取 result.damage 作为 CombatDamageBreakdown */
const damage = computed((): CombatDamageBreakdown | null => {
  if (!hasDamageBreakdown.value) return null;
  return props.result!.damage as CombatDamageBreakdown;
});

/** 安全读取 finalDamage */
const finalDamage = computed((): number | null => {
  const d = damage.value;
  return d?.finalDamage ?? null;
});

/** 安全读取 result.finalHp / result.maxHp / result.isDead */
const finalHp = computed((): number | null => {
  const v = props.result?.finalHp;
  return typeof v === 'number' ? v : null;
});
const maxHp = computed((): number | null => {
  const v = props.result?.maxHp;
  return typeof v === 'number' ? v : null;
});
const isDead = computed((): boolean => {
  const v = props.result?.isDead;
  return v === true;
});

/** 安全读取 result.statusApplied 数组 */
const statusApplied = computed<Array<{ name: string; duration: number; effect: string }> | null>(
  () => {
    const arr = props.result?.statusApplied;
    if (!Array.isArray(arr)) return null;
    return arr.filter(
      (item): item is { name: string; duration: number; effect: string } =>
        item != null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).name === 'string',
    );
  },
);

/** 安全读取 result.description */
const description = computed((): string => {
  const v = props.result?.description;
  return typeof v === 'string' ? v : '';
});

/** 判断是否失误（系数 === 0） */
const isMiss = computed((): boolean => {
  return ratingCoefficient.value === 0;
});

/** 按评级系数映射语义色 */
const ratingColor = computed((): string => {
  const coeff = ratingCoefficient.value;
  if (coeff === null) return 'var(--theme-text-muted)';
  if (coeff === 0) return 'var(--theme-text-muted)'; // 失误
  if (coeff <= 0.3) return 'var(--theme-warning)'; // 擦伤
  if (coeff < 1.0) return 'var(--theme-text-secondary)'; // 勉强
  if (coeff === 1.0) return 'var(--theme-text-primary)'; // 有效/命中
  return 'var(--theme-primary)'; // 暴击以上
});

/** 工具名 → 中文标签映射 */
const toolLabel = computed((): string => {
  const map: Record<string, string> = {
    attack: '攻击',
    cost: '消耗',
    flee: '逃跑',
    combat_attack: '攻击',
    combat_use_skill: '技能',
    combat_use_item: '道具',
    combat_defend: '防御',
    combat_flee: '逃跑',
    status_apply: '状态',
  };
  return map[props.toolName ?? ''] ?? props.toolName ?? '';
});

/** 多段分割信息 */
const multiSplitInfo = computed<{ count: number; perHit: number } | null>(() => {
  const d = damage.value;
  if (!d?.multiSplitInfo) return null;
  const info = d.multiSplitInfo;
  if (typeof info.count === 'number' && typeof info.perHit === 'number') return info;
  return null;
});

/** 是否有穿透信息可展示 */
const hasPenetration = computed((): boolean => {
  const p = damage.value?.penetration;
  return p != null && typeof p.effectiveDef === 'number';
});

// ── 辅助：格式化数字（取整，避免浮点噪音） ──
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 完整结果对象（仅在 hasDamageBreakdown 时用于模板深层引用） */
const fullResult = computed((): CombatActionResult | null => {
  if (!hasDamageBreakdown.value) return null;
  return props.result as unknown as CombatActionResult;
});

// ════════════════════════════════════════════════════════════════
// 🆕 v3 形状识别（2026-08-12）：v3 的 v3_action(attack) 卡片是**扁平字段**
//   （{ attackerId, targetId, skill?, checkValue?, rating?, hit?, final?, ... }），
//   不是 v2 的 CombatActionResult（request/attackRoll/damage 嵌套）。
//   hasDamageBreakdown=false 时会落兜底「attack」空卡 —— 那就是「显示三个 attack、
//   点开没内容」的根源。这里识别 v3 形状并渲染完整摘要 + 展开详情。
// ════════════════════════════════════════════════════════════════

/** 是否为 v3 攻击卡片（扁平字段，顶层有 attackerId + targetId） */
const isV3Attack = computed((): boolean => {
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
const v3AttackerId = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.attackerId;
  return typeof v === 'string' ? v : null;
});
const v3TargetId = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.targetId;
  return typeof v === 'string' ? v : null;
});

/** v3：技能名（可选） */
const v3Skill = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.skill;
  return typeof v === 'string' && v.length > 0 ? v : null;
});

/** v3：检定值 / 评级 / 是否命中 */
const v3CheckValue = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.checkValue;
  return typeof v === 'number' ? v : null;
});
const v3Rating = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.rating;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
const v3Hit = computed((): boolean | null => {
  const v = (props.result as Record<string, unknown>)?.hit;
  return typeof v === 'boolean' ? v : null;
});

/** v3：最终伤害 / 伤害类型 / 目标 HP 前后 */
const v3Final = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.final;
  return typeof v === 'number' ? v : null;
});
const v3DamageType = computed((): string | null => {
  const v = (props.result as Record<string, unknown>)?.damageType;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
const v3TargetHpBefore = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.targetHpBefore;
  return typeof v === 'number' ? v : null;
});
const v3TargetHpAfter = computed((): number | null => {
  const v = (props.result as Record<string, unknown>)?.targetHpAfter;
  return typeof v === 'number' ? v : null;
});

/** v3：是否命中（hit !== false 且伤害 > 0；未命中 = hit false 或伤害 0） */
const v3IsMiss = computed((): boolean => {
  if (v3Hit.value === false) return true;
  if (v3Hit.value === null) return (v3Final.value ?? 0) <= 0;
  return (v3Final.value ?? 0) <= 0;
});

/** v3：按评级/命中映射语义色 */
const v3Color = computed((): string => {
  if (v3IsMiss.value) return 'var(--theme-text-muted)';
  if (v3Final.value === null) return 'var(--theme-text-primary)';
  return 'var(--theme-primary)';
});

/** 从 v3 扁平字段渲染的摘要行：攻方 → 守方（技能）| 检定 N（评级）| 伤害 |
 *  HP 前后。攻守 id 先经 units 字典反查名字（生产是 UUID），查不到回退 id */
function v3Summary(): {
  attacker: string;
  target: string;
  skill: string;
  check: string;
  damage: string;
  hp: string;
} {
  const atk = v3AttackerId.value
    ? (props.units?.[v3AttackerId.value] ?? v3AttackerId.value)
    : '未知';
  const tgt = v3TargetId.value ? (props.units?.[v3TargetId.value] ?? v3TargetId.value) : '未知';
  const skill = v3Skill.value ? ` · ${v3Skill.value}` : '';
  const check = v3CheckValue.value !== null ? `检定 ${v3CheckValue.value}` : '';
  const rating = v3Rating.value ? `（${v3Rating.value}）` : '';
  const dmg =
    v3Final.value !== null && !v3IsMiss.value
      ? `${v3Final.value} 点${v3DamageType.value ?? ''}伤害`
      : v3IsMiss.value
        ? '未命中'
        : '';
  const hp =
    v3TargetHpBefore.value !== null && v3TargetHpAfter.value !== null
      ? `HP ${v3TargetHpBefore.value} → ${v3TargetHpAfter.value}`
      : '';
  return { attacker: atk, target: tgt, skill, check, rating, damage: dmg, hp };
}

/** v3：展开详情行（供模板渲染完整信息） */
const v3DetailRows = computed(() => {
  const rows: Array<{ label: string; value: string }> = [];
  if (v3Skill.value) rows.push({ label: '技能', value: v3Skill.value });
  if (v3CheckValue.value !== null) {
    rows.push({
      label: '检定',
      value: `${v3CheckValue.value}${v3Rating.value ? `（${v3Rating.value}）` : ''}`,
    });
  }
  if (v3Final.value !== null && !v3IsMiss.value) {
    rows.push({ label: '伤害', value: `${v3Final.value} 点${v3DamageType.value ?? ''}` });
  }
  if (v3TargetHpBefore.value !== null && v3TargetHpAfter.value !== null) {
    rows.push({
      label: '目标 HP',
      value: `${v3TargetHpBefore.value} → ${v3TargetHpAfter.value}`,
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
      :class="{ 'cac-header--miss': isMiss }"
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
      <template v-if="isV3Attack">
        <span class="cac-summary">
          <span class="cac-name">{{ v3Summary().attacker }}</span>
          <i class="fa-solid fa-arrow-right cac-arrow" />
          <span class="cac-name">{{ v3Summary().target }}</span>
          <span v-if="v3Summary().skill" class="cac-skill">{{ v3Summary().skill }}</span>
        </span>

        <span v-if="v3Summary().check" class="cac-divider" />
        <span v-if="v3Summary().check" class="cac-check">{{ v3Summary().check }}</span>
        <span v-if="v3Summary().rating" class="cac-rating" :style="{ color: v3Color }">
          {{ v3Summary().rating }}
        </span>

        <span v-if="v3Summary().damage" class="cac-damage" :style="{ color: v3Color }">
          {{ v3Summary().damage }}
        </span>
        <span v-else-if="v3IsMiss" class="cac-miss">未命中</span>

        <span v-if="v3Summary().hp" class="cac-hp">{{ v3Summary().hp }}</span>
      </template>

      <!-- 有完整伤害分解：标准摘要行 -->
      <template v-else-if="hasDamageBreakdown">
        <span class="cac-summary">
          <span class="cac-name">{{ attackerId ?? '未知' }}</span>
          <i class="fa-solid fa-arrow-right cac-arrow" />
          <span class="cac-name">{{ defenderId ?? '未知' }}</span>
        </span>

        <span class="cac-divider" />

        <span v-if="checkValue !== null" class="cac-check"> 检定{{ checkValue }} </span>
        <span class="cac-rating" :style="{ color: ratingColor }"> ({{ ratingLevel ?? '—' }}) </span>

        <span v-if="!isMiss" class="cac-damage">
          <span class="cac-damage-num">{{ fmt(finalDamage) }}</span
          >伤
        </span>
        <span v-else class="cac-miss">未命中</span>

        <span v-if="finalHp !== null && maxHp !== null" class="cac-hp">
          HP {{ fmt(finalHp) }}/{{ fmt(maxHp) }}
        </span>
      </template>

      <!-- 无完整伤害分解：兜底显示 toolName + description -->
      <template v-else>
        <span class="cac-fallback">{{ description || toolName }}</span>
      </template>

      <i class="fa-solid cac-chevron" :class="expanded ? 'fa-chevron-up' : 'fa-chevron-down'" />
    </div>

    <!-- ════════ 展开态：v3 扁平详情 / 8 步伤害管线 ════════ -->
    <Transition name="cac-expand">
      <!-- 🆕 v3 攻击卡片展开：技能/检定/伤害/HP 详情行（2026-08-12） -->
      <div v-if="expanded && isV3Attack" class="cac-body">
        <div class="cac-detail-list">
          <div v-for="row in v3DetailRows" :key="row.label" class="cac-step">
            <span class="cac-step-label">{{ row.label }}</span>
            <span class="cac-step-value">{{ row.value }}</span>
          </div>
          <div v-if="v3DetailRows.length === 0" class="cac-desc">本次行动无详细结算数据</div>
        </div>
      </div>

      <div v-else-if="expanded && hasDamageBreakdown && fullResult" class="cac-body">
        <div class="cac-pipeline">
          <!-- Step 1: 初始伤害 -->
          <div class="cac-step">
            <span class="cac-step-label">初始伤害</span>
            <span class="cac-step-value">{{ fmt(fullResult.damage.initialDamage) }}</span>
            <span v-if="fullResult.damage.initialFormula" class="cac-step-note">
              {{ fullResult.damage.initialFormula }}
            </span>
          </div>

          <!-- Step 2: 多段分割（若有） -->
          <template v-if="multiSplitInfo">
            <div class="cac-sep"></div>
            <div class="cac-step">
              <span class="cac-step-label">多段分割</span>
              <span class="cac-step-value">&times;{{ multiSplitInfo.count }}</span>
              <span class="cac-step-note">{{ fmt(multiSplitInfo.perHit) }}/段</span>
            </div>
          </template>

          <div class="cac-sep"></div>

          <!-- Step 3: 穿透修正 -->
          <div v-if="hasPenetration" class="cac-step">
            <span class="cac-step-label">穿透修正</span>
            <span class="cac-step-value"
              >有效防御 {{ fmt(fullResult.damage.penetration.effectiveDef) }}</span
            >
            <span class="cac-step-note">
              防御{{ fmt(fullResult.damage.penetration.originalDef) }} &times; (1 &minus;
              {{ fmt(fullResult.damage.penetration.penetrationRate * 100) }}%)
            </span>
          </div>

          <div v-if="hasPenetration" class="cac-sep"></div>

          <!-- Step 4: 装备减免 -->
          <div class="cac-step">
            <span class="cac-step-label">装备减免</span>
            <span class="cac-step-value cac-step-value--reduce"
              >&minus;{{ fmt(fullResult.damage.equipmentReduction) }}</span
            >
          </div>

          <div class="cac-sep"></div>

          <!-- Step 5: 类型减免 -->
          <div class="cac-step">
            <span class="cac-step-label">类型减免</span>
            <span class="cac-step-value cac-step-value--reduce">
              &minus;{{ fmt(fullResult.damage.typeReductionAmount) }}
            </span>
            <span v-if="fullResult.damage.typeReductionRate > 0" class="cac-step-note">
              {{ fmt(fullResult.damage.typeReductionRate * 100) }}%
            </span>
          </div>

          <div class="cac-sep"></div>

          <!-- Step 6: 评级系数 + 意图系数 -->
          <div class="cac-step">
            <span class="cac-step-label">系数修正</span>
            <span class="cac-step-value">
              评级 &times;{{ fmt(fullResult.damage.ratingCoefficient) }}
            </span>
            <span class="cac-step-note">
              意图 &times;{{ fmt(fullResult.damage.intentionCoefficient) }}
            </span>
          </div>

          <div class="cac-sep"></div>

          <!-- Step 7: DR 修正 -->
          <div v-if="fullResult.damage.drRate > 0" class="cac-step">
            <span class="cac-step-label">伤害减免</span>
            <span class="cac-step-value cac-step-value--reduce">
              DR &minus;{{ fmt(fullResult.damage.drRate * 100) }}%
            </span>
          </div>

          <div v-if="fullResult.damage.drRate > 0" class="cac-sep"></div>

          <!-- Step 8: 最终伤害（★ 高亮） -->
          <div class="cac-step cac-step--final">
            <span class="cac-step-label cac-step-label--final">
              <i class="fa-solid fa-star" /> 最终伤害
            </span>
            <span class="cac-step-value cac-step-value--final">
              {{ fmt(fullResult.damage.finalDamage) }}
            </span>
          </div>
        </div>

        <!-- HP 变化行 -->
        <div v-if="finalHp !== null && maxHp !== null" class="cac-hp-line">
          <span class="cac-hp-line-label">
            {{ defenderId ?? '守方' }}
          </span>
          <span class="cac-hp-line-change">
            HP {{ fmt(maxHp) }} <i class="fa-solid fa-arrow-right cac-hp-arrow" />
            {{ fmt(finalHp) }}
          </span>
          <span v-if="isDead" class="cac-hp-line-dead">已倒下</span>
          <span v-else class="cac-hp-line-alive">存活</span>
        </div>

        <!-- 状态施加 -->
        <div v-if="statusApplied && statusApplied.length > 0" class="cac-status">
          <div v-for="(status, idx) in statusApplied" :key="idx" class="cac-status-item">
            <i class="fa-solid fa-plus cac-status-icon" />
            <span class="cac-status-name">{{ status.name }}</span>
            <span class="cac-status-duration">{{ status.duration }}回合</span>
          </div>
        </div>
      </div>

      <!-- 展开态但无伤害分解：展示 description（如有） -->
      <div
        v-else-if="expanded && !hasDamageBreakdown && description"
        class="cac-body cac-body--fallback"
      >
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

/* 失误态整体灰化 */
.cac-header--miss {
  opacity: 0.55;
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
.cac-damage-num {
  font-size: 0.875rem; /* 14px 略大 */
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

/* ── 管线容器（左侧竖线引导） ── */
.cac-pipeline {
  display: flex;
  flex-direction: column;
  border-left: 2px solid var(--theme-card-border);
  padding-left: var(--theme-spacing-md, 12px);
  gap: 0;
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
.cac-step-value--reduce {
  color: var(--theme-text-secondary);
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

/* ── 竖线分隔（备用：当 border-left 不够时） ── */
.cac-sep {
  height: 0;
}

/* ════════ HP 变化行 ════════ */
.cac-hp-line {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm, 8px);
  padding-top: var(--theme-spacing-sm, 8px);
  border-top: 1px dashed var(--theme-card-border);
  font-size: 0.75rem;
}
.cac-hp-line-label {
  font-weight: 600;
  color: var(--theme-text-secondary);
}
.cac-hp-line-change {
  color: var(--theme-error);
  font-weight: 600;
}
.cac-hp-arrow {
  font-size: 0.625rem;
  opacity: 0.4;
}
.cac-hp-line-dead {
  margin-left: auto;
  font-weight: 700;
  color: var(--theme-error);
  font-size: 0.75rem;
}
.cac-hp-line-alive {
  margin-left: auto;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

/* ════════ 状态施加 ════════ */
.cac-status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: var(--theme-spacing-xs, 4px);
}
.cac-status-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  color: var(--theme-primary);
  padding: 1px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.6875rem; /* 11px 小字 */
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.cac-status-icon {
  font-size: 0.5rem;
}
.cac-status-duration {
  opacity: 0.7;
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
