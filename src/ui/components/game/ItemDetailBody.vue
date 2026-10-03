<script setup lang="ts">
/**
 * ItemDetailBody.vue — 物品 / 技能详情正文（玩家背包与 NPC 查看器**共用**）
 *
 * 2026-09-12：从 `ItemsPanel.vue` 抽出。两边数据结构等价（InventoryItem / Skill），
 * 共用这一份「品质 + 效果 + 描述」，避免再分叉
 * （此前 NPC 侧缺品质、且 effects 未归一化，显示与主角不一致）。
 *
 * 纯展示：不碰 store、不含删除/重铸等动作（那些由宿主用插槽/外部按钮提供）。
 */
import { computed } from 'vue';
import { qualityVar } from '../../lib/quality-colors';
import {
  qualityOf,
  typeLabel,
  detailExtra,
  entryEffects,
  type ItemCategory,
  type PanelEntry,
} from '../../lib/item-view';

const props = defineProps<{
  entry: PanelEntry;
  category: ItemCategory;
}>();

const quality = computed(() => qualityOf(props.entry));
const effects = computed(() => entryEffects(props.entry));
</script>

<template>
  <div
    class="item-detail-body"
    :style="{
      '--item-detail-border': qualityVar(quality),
      '--item-detail-glow': qualityVar(quality),
    }"
  >
    <div class="d-header">
      <span class="d-name" :style="{ color: qualityVar(quality) }">{{ entry.row.name }}</span>
      <span
        class="d-quality"
        :style="{ color: qualityVar(quality), borderColor: qualityVar(quality) }"
        >{{ quality }}</span
      >
    </div>
    <div class="d-meta">
      <span>{{ typeLabel(entry, category) }}</span
      ><span>{{ detailExtra(entry, category) }}</span>
    </div>

    <!-- 效果词条 -->
    <div v-if="effects && Object.keys(effects).length > 0" class="fx-section">
      <div class="d-label">效果</div>
      <div v-for="(desc, name) in effects" :key="name" class="fx-row">
        <span class="fx-name">{{ name }}</span
        ><span class="fx-desc">{{ desc }}</span>
      </div>
    </div>

    <!-- 描述 -->
    <div v-if="entry.row.description" class="desc-section">
      <div class="d-label">描述</div>
      <p class="d-desc">{{ entry.row.description }}</p>
    </div>
  </div>
</template>

<style scoped>
.item-detail-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ═══ 头部：名称 + 品质 ═══ */
.d-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--item-detail-border, var(--theme-card-border));
  /* 品质光晕 */
  --glow: color-mix(in srgb, var(--item-detail-glow, var(--theme-text-muted)) 20%, transparent);
  box-shadow: 0 1px 0 0 var(--glow);
}
.d-name {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 1.125rem;
  font-weight: 700;
}
.d-quality {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid;
  letter-spacing: 0.03em;
}
.d-meta {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  display: flex;
  gap: 16px;
}
.d-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.d-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

/* ═══ 效果词条 ═══ */
.fx-row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 0.8125rem;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 40%, transparent);
}
.fx-row:last-child {
  border-bottom: none;
}
.fx-name {
  color: var(--theme-text-secondary);
  font-weight: 500;
  min-width: 4.375rem;
}
.fx-desc {
  color: var(--theme-text-primary);
}

/* ═══ 描述 ═══ */
.d-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-style: italic;
}
</style>
