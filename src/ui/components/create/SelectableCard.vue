<script setup lang="ts">
import type { CatalogItem, Rarity } from '@engine/start-catalog'
import { RARITY_TO_QUALITY } from '@engine/start-catalog'
import type { QualityLevel } from '@engine/types'
import QualityBadge from '../shared/QualityBadge.vue'
import AppButton from '../shared/AppButton.vue'
import { computed } from 'vue'

const props = defineProps<{ item: CatalogItem; selected: boolean; disabled?: boolean }>()
defineEmits<{ select: [item: CatalogItem]; remove: [item: CatalogItem] }>()

const qualityLabel = computed(() => RARITY_TO_QUALITY[props.item.rarity] as QualityLevel)

// 稀有度 → 左边框颜色映射
const RARITY_BORDER: Record<string, string> = {
  common:    '#9e9e9e',
  uncommon:  '#4caf50',
  rare:      '#2196f3',
  epic:      '#9c27b0',
  legendary: '#ff9800',
  mythic:    '#f44336',
  only:      '#00bcd4',
}

const borderColor = computed(() => RARITY_BORDER[props.item.rarity] || '#9e9e9e')

function handleClick() {
  if (props.disabled) return
  if (props.selected) {
    // 整卡点击 → 移除 (需二次确认的感觉)
  }
  // 但为了避免误操作，整卡点击 = 选中，移除仍需要按钮
  if (!props.selected) {
    // 直接 emit select，不做移除
  }
}
</script>

<template>
  <div
    class="selectable-card"
    :class="{
      selected,
      disabled,
      ['rarity-' + item.rarity]: true,
    }"
    :style="{ borderLeftColor: borderColor }"
    @click="!disabled && !selected ? $emit('select', item) : undefined"
  >
    <div class="card-body">
      <!-- 头部: 名称 + 稀有度 + 类型 -->
      <div class="card-header">
        <span class="item-name">{{ item.name }}</span>
        <QualityBadge :quality="qualityLabel" size="sm" />
        <span class="item-type">{{ item.type }}</span>
      </div>

      <!-- Tag 标签 (最多 5 个) -->
      <div class="card-tags" v-if="item.tag.length">
        <span v-for="t in item.tag.slice(0, 5)" :key="t" class="tag">{{ t }}</span>
      </div>

      <!-- Effect 效果键值对 -->
      <div class="card-effects" v-if="Object.keys(item.effect).length">
        <span v-for="(v, k) in item.effect" :key="k" class="effect-line">
          <strong>{{ k }}:</strong> {{ v }}
        </span>
      </div>

      <!-- Consume 消耗 (MP/SP) — 原版有此字段，当前缺失 -->
      <div class="card-consume" v-if="item.consume">
        ⚡ {{ item.consume }}
      </div>

      <!-- 描述 (截断) -->
      <div class="card-desc" v-if="item.description">{{ item.description }}</div>

      <!-- 转生点数消耗 -->
      <div class="card-cost">
        消耗: <strong>{{ item.cost }}</strong> 点
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="card-action">
      <AppButton v-if="!selected" size="sm" @click.stop="$emit('select', item)">
        选择
      </AppButton>
      <AppButton v-else size="sm" variant="danger" @click.stop="$emit('remove', item)">
        移除
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.selectable-card {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-sm) var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-left: 3px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  transition: all var(--theme-transition-normal);
  cursor: pointer;
}
.selectable-card:not(.disabled):not(.selected):hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
  border-color: var(--theme-color-primary);
}

/* 选中态 */
.selectable-card.selected {
  border-color: var(--theme-color-primary);
  border-left-width: 3px;
  background: var(--theme-card-border);
}

/* 禁用态 */
.selectable-card.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ===== 卡片内容 ===== */
.card-body { flex: 1; min-width: 0; }

.card-header {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin-bottom: 0.25em;
}
.item-name {
  font-weight: 700;
  font-size: 0.9em;
  color: var(--theme-text-primary);
}
.item-type {
  font-size: 0.7em;
  color: var(--theme-text-muted);
  margin-left: auto;
}

/* Tags */
.card-tags { display: flex; flex-wrap: wrap; gap: 0.2em; margin-bottom: 0.25em; }
.tag {
  font-size: 0.65em;
  padding: 0.15em 0.4em;
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-border);
  color: var(--theme-text-secondary);
  white-space: nowrap;
}

/* Effects */
.card-effects { margin-bottom: 0.25em; }
.effect-line { display: block; font-size: 0.72em; color: var(--theme-text-secondary); line-height: 1.5; }
.effect-line strong { color: var(--theme-text-primary); font-size: inherit; }

/* Consume */
.card-consume {
  font-size: 0.75em;
  color: var(--theme-color-primary);
  margin-bottom: 0.25em;
  font-weight: 600;
}

/* 描述 */
.card-desc {
  font-size: 0.72em;
  color: var(--theme-text-muted);
  line-height: 1.45;
  margin-bottom: 0.25em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 转生点消耗 */
.card-cost { font-size: 0.75em; color: var(--theme-color-primary); font-weight: 600; }

/* 操作按钮 */
.card-action {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding-top: 2px;
}
</style>
