<script setup lang="ts">
/**
 * SelectedPanel — 已选物品汇总面板
 *
 * 对齐原版: 三区聚合 (装备/道具/技能) + 始终可见 + 消耗汇总
 */
import type { CatalogItem } from '@engine/start-catalog'
import { RARITY_TO_QUALITY } from '@engine/start-catalog'
import type { QualityLevel } from '@engine/types'
import QualityBadge from '../shared/QualityBadge.vue'
import { computed } from 'vue'

const props = defineProps<{
  equipments: CatalogItem[]
  items: CatalogItem[]
  skills: CatalogItem[]
  equipmentCost?: number
  itemCost?: number
  skillCost?: number
}>()

defineEmits<{
  'remove-equipment': [item: CatalogItem]
  'remove-item': [item: CatalogItem]
  'remove-skill': [item: CatalogItem]
}>()

function qualityLabel(item: CatalogItem): QualityLevel {
  return RARITY_TO_QUALITY[item.rarity] as QualityLevel
}

const totalCost = computed(() =>
  (props.equipmentCost ?? props.equipments.reduce((s, e) => s + (e.cost || 0), 0)) +
  (props.itemCost ?? props.items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0)) +
  (props.skillCost ?? props.skills.reduce((s, sk) => s + (sk.cost || 0), 0))
)

function roundCost(items: CatalogItem[]): number {
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0)
}

const eqCost = computed(() => props.equipmentCost ?? roundCost(props.equipments))
const itCost = computed(() => props.itemCost ?? roundCost(props.items))
const skCost = computed(() => props.skillCost ?? roundCost(props.skills))
</script>

<template>
  <div class="selected-panel">
    <h3 class="panel-title">已选物品</h3>

    <!-- 装备区 -->
    <div class="zone" v-if="equipments.length > 0">
      <div class="zone-header">
        <span class="zone-title">装备 ({{ equipments.length }})</span>
        <span class="zone-cost">{{ eqCost }} 点</span>
      </div>
      <div v-for="item in equipments" :key="item.id" class="selected-item">
        <span class="item-name">{{ item.name }}</span>
        <QualityBadge :quality="qualityLabel(item)" size="sm" />
        <button class="remove-btn" @click="$emit('remove-equipment', item)" title="移除">✕</button>
      </div>
    </div>

    <!-- 道具区 -->
    <div class="zone" v-if="items.length > 0">
      <div class="zone-header">
        <span class="zone-title">道具 ({{ items.length }})</span>
        <span class="zone-cost">{{ itCost }} 点</span>
      </div>
      <div v-for="item in items" :key="item.id" class="selected-item">
        <span class="item-name">{{ item.name }}</span>
        <span v-if="item.quantity && item.quantity > 1" class="item-qty">×{{ item.quantity }}</span>
        <QualityBadge :quality="qualityLabel(item)" size="sm" />
        <button class="remove-btn" @click="$emit('remove-item', item)" title="移除">✕</button>
      </div>
    </div>

    <!-- 技能区 -->
    <div class="zone" v-if="skills.length > 0">
      <div class="zone-header">
        <span class="zone-title">技能 ({{ skills.length }})</span>
        <span class="zone-cost">{{ skCost }} 点</span>
      </div>
      <div v-for="item in skills" :key="item.id" class="selected-item">
        <span class="item-name">{{ item.name }}</span>
        <QualityBadge :quality="qualityLabel(item)" size="sm" />
        <button class="remove-btn" @click="$emit('remove-skill', item)" title="移除">✕</button>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="equipments.length === 0 && items.length === 0 && skills.length === 0" class="empty">
      暂未选择物品
    </div>

    <!-- ★ 底部消耗汇总 -->
    <div class="cost-summary">
      <span class="summary-label">合计消耗</span>
      <span class="summary-value">{{ totalCost }}</span>
      <span class="summary-unit">转生点</span>
    </div>
  </div>
</template>

<style scoped>
.selected-panel {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  min-width: 220px;
}

.panel-title {
  font-family: var(--theme-font-title, serif);
  font-size: 0.85em;
  color: var(--theme-text-primary);
  margin-bottom: var(--theme-spacing-sm);
  padding-bottom: var(--theme-spacing-xs);
  border-bottom: 1px solid var(--theme-card-border);
}

/* ===== 区域 ===== */
.zone {
  margin-bottom: var(--theme-spacing-sm);
}
.zone:last-of-type {
  margin-bottom: var(--theme-spacing-sm);
}

.zone-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25em;
}
.zone-title {
  font-size: 0.75em;
  font-weight: 700;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.zone-cost {
  font-size: 0.72em;
  color: var(--theme-color-primary);
  font-weight: 600;
}

/* ===== 物品行 ===== */
.selected-item {
  display: flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.15em 0;
  border-bottom: 1px solid var(--theme-card-border);
}
.selected-item:last-child { border-bottom: none; }

.item-name {
  font-size: 0.8em;
  font-weight: 600;
  color: var(--theme-text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-qty {
  font-size: 0.7em;
  color: var(--theme-text-muted);
}

.remove-btn {
  border: none;
  background: transparent;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.8em;
  padding: 0.15em 0.3em;
  border-radius: var(--theme-radius-sm);
  transition: all var(--theme-transition-fast);
  flex-shrink: 0;
}
.remove-btn:hover {
  color: #f44336;
  background: rgba(244, 67, 54, 0.1);
}

/* ===== 空状态 ===== */
.empty {
  text-align: center;
  font-size: 0.8em;
  color: var(--theme-text-muted);
  padding: var(--theme-spacing-md) 0;
}

/* ===== ★ 底部消耗汇总 ===== */
.cost-summary {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.4em;
  margin-top: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
.summary-label {
  font-size: 0.75em;
  color: var(--theme-text-muted);
}
.summary-value {
  font-family: var(--theme-font-title, serif);
  font-size: 1.3em;
  font-weight: 800;
  color: var(--theme-color-primary);
}
.summary-unit {
  font-size: 0.7em;
  color: var(--theme-text-muted);
}
</style>
