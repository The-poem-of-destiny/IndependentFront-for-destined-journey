<script setup lang="ts">
import type { CraftSystemEvent } from '@engine/types'
import { qualityVar } from '../../../lib/quality-colors'

defineProps<{ event: CraftSystemEvent }>()
const emit = defineEmits<{ collapse: [] }>()

// Industry icon mapping
const industryIcons: Record<string, string> = {
  '锻造': 'fa-solid fa-hammer',
  '炼金': 'fa-solid fa-flask',
  '烹饪': 'fa-solid fa-utensils',
  '裁缝': 'fa-solid fa-scissors',
}
const industryIconsDefault = 'fa-solid fa-hammer'

// Rating icon + color
const ratingMeta: Record<string, { icon: string; color: string }> = {
  '大失败':     { icon: 'fa-regular fa-circle-xmark',       color: '#e53e3e' },
  '失败':       { icon: 'fa-solid fa-triangle-exclamation', color: '#fc8181' },
  '成功':       { icon: 'fa-regular fa-circle-check',      color: '#68d391' },
  '精益求精': { icon: 'fa-solid fa-star',                color: '#ffd700' },
}
</script>

<template>
  <div class="sys-card" :style="{ borderLeft: `4px solid ${qualityVar(event.quality)}` }">
    <!-- Header -->
    <div class="sys-card-header" @click="emit('collapse')">
      <i :class="'fa-solid ' + (industryIcons[event.details.craftParams.industry] ?? industryIconsDefault) + ' sys-card-icon'" />
      <span class="sys-card-title">{{ event.quality }} · {{ event.productName }}</span>
      <span v-if="!event.details.success" class="sys-card-fail">失败</span>
      <i class="fa-solid fa-chevron-up sys-card-collapse" title="收起" />
    </div>

    <!-- Body -->
    <div class="sys-card-body">
      <!-- A. Rating -->
      <div class="card-section craft-rating">
        <i :class="ratingMeta[event.rating]?.icon ?? 'fa-regular fa-circle-question'" class="rating-icon" :style="{ color: ratingMeta[event.rating]?.color ?? 'var(--theme-text-muted)' }" />
        <span class="rating-text" :style="{ color: ratingMeta[event.rating]?.color }">{{ event.rating }}</span>
        <span v-if="event.details.perfectionBonus" class="perfection-bonus">— {{ event.details.perfectionBonus }}</span>
      </div>

      <!-- B. Check summary -->
      <div class="card-section">
        <span class="section-label"><i class="fa-solid fa-dice" /> 检定</span>
        <p class="check-text">{{ event.details.checkSummary }}</p>
      </div>

      <!-- C. Materials -->
      <div v-if="event.details.craftParams.materials" class="card-section">
        <span class="section-label"><i class="fa-solid fa-cubes" /> 材料</span>
        <div class="material-chips">
          <span v-for="(mat, idx) in event.details.craftParams.materials.split(/[,，、]/)" :key="idx" class="material-chip">{{ mat.trim() }}</span>
        </div>
      </div>

      <!-- D. Item requests -->
      <div v-if="event.details.itemRequests?.length" class="card-section">
        <span class="section-label"><i class="fa-solid fa-gift" /> 制品</span>
        <div v-for="req in event.details.itemRequests" :key="req.quality + req.type + (req.slot ?? '')" class="item-request">
          <i :class="req.type === 'equipment' ? 'fa-solid fa-shield-halved' : 'fa-solid fa-flask'" class="req-type" />
          <span class="req-quality" :style="{ color: qualityVar(req.quality) }">{{ req.quality }}</span>
          <span v-if="req.slot" class="req-slot">{{ req.slot }}</span>
          <span class="req-desc">{{ req.description.slice(0, 100) }}</span>
        </div>
      </div>

      <!-- E. Footer: meta info -->
      <div class="card-section craft-footer">
        <span class="stat-badge">
          <i :class="'fa-solid ' + (industryIcons[event.details.craftParams.industry] ?? industryIconsDefault)" />
          {{ event.details.craftParams.industry }}
        </span>
        <span class="stat-badge" v-if="event.details.craftParams.stage !== '成品'">
          <i class="fa-solid fa-gears" /> {{ event.details.craftParams.stage }}
        </span>
        <span class="stat-badge" v-if="event.details.craftParams.quantity > 1">
          <i class="fa-solid fa-layer-group" /> ×{{ event.details.craftParams.quantity }}
        </span>
        <span class="stat-badge" v-if="event.details.craftParams.expGained > 0">
          <i class="fa-solid fa-bolt" /> EXP +{{ event.details.craftParams.expGained }}
        </span>
        <span class="stat-badge" v-if="event.details.craftParams.fpGained > 0">
          <i class="fa-solid fa-star" /> FP +{{ event.details.craftParams.fpGained }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sys-card {
  border-radius: var(--theme-radius-md, 8px);
  overflow: hidden;
  background: var(--theme-card-bg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

/* Header */
.sys-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--theme-surface-muted);
  cursor: pointer;
  user-select: none;
  color: var(--theme-text-primary);
}
.sys-card-header:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}

.sys-card-icon {
  font-size: 0.8125rem;
  opacity: 0.7;
}

.sys-card-title {
  flex: 1;
  font-size: 0.875rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sys-card-collapse {
  font-size: 0.625rem;
  opacity: 0.4;
  cursor: pointer;
  transition: opacity 0.15s;
  padding: 2px;
}
.sys-card-collapse:hover { opacity: 0.8; }

/* Body */
.sys-card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}

/* Sections with dashed dividers */
.card-section {
  padding-top: 8px;
}
.card-section + .card-section {
  border-top: 1px dashed var(--theme-card-border, var(--theme-border, rgba(255,255,255,0.08)));
}

/* A. Rating row */
.craft-rating {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  padding-top: 0;
}

.rating-icon {
  font-size: 0.875rem;
}

.rating-text {
  font-size: 0.875rem;
}

/* Section label */
.section-label {
  font-weight: 600;
  opacity: 0.6;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Materials */
.material-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.material-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-border, rgba(255,255,255,0.06));
}

/* Item requests */
.item-request {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 0.75rem;
  margin-bottom: 4px;
}

.req-type {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

.req-quality {
  font-weight: 600;
}

.req-slot {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: var(--theme-primary);
  color: #fff;
}

.req-desc {
  opacity: 0.65;
  font-size: 0.75rem;
}

/* Footer */
.craft-footer {
  display: flex;
  gap: 8px;
}

.stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}

/* New classes */
.sys-card-fail {
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--theme-error);
  padding: 2px 6px;
  border: 1px solid var(--theme-error);
  border-radius: 3px;
}

.perfection-bonus {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #ffd700;
}

.check-text {
  font-size: 0.75rem;
  opacity: 0.7;
  line-height: 1.5;
  color: var(--theme-text-secondary);
  margin: 0;
}
</style>
