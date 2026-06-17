<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import { ATTRIBUTE_NAMES, RARITY_TO_QUALITY } from '@engine/start-catalog'
import type { QualityLevel } from '@engine/types'
import AvatarPanel from '../shared/AvatarPanel.vue'
import ResourceBar from '../shared/ResourceBar.vue'
import QualityBadge from '../shared/QualityBadge.vue'

const store = useCreateStore()
</script>

<template>
  <section class="step-confirm">
    <h2 class="step-title">确认角色</h2>

    <div class="confirm-card">
      <!-- 头像 + 基本信息 -->
      <div class="hero-row">
        <AvatarPanel :name="store.name || '?'" size="lg" />
        <div class="hero-info">
          <span class="hero-name">{{ store.name || '未命名' }}</span>
          <span class="hero-meta">
            {{ store.race === '自定义' ? (store.customRace || '自定义') : store.race }}
            |
            {{ store.identity === '自定义' ? (store.customIdentity || '自定义') : store.identity }}
          </span>
          <span class="hero-tier">
            Lv.{{ store.level }} T{{ store.tier }} {{ store.tierName }}
          </span>
          <span class="hero-location">起始: {{ store.startLocation }}</span>
          <span v-if="store.destinyCore" class="hero-core">
            命定之灵: {{ store.destinyCore.name }} ({{ store.destinyCore.author }})
          </span>
        </div>
      </div>

      <!-- HP/MP/SP -->
      <div class="resource-row">
        <ResourceBar label="HP" :current="store.hpPreview" :max="store.hpPreview" color="var(--theme-hp, #e74c3c)" />
        <ResourceBar label="MP" :current="store.mpPreview" :max="store.mpPreview" color="var(--theme-mp, #3498db)" />
        <ResourceBar label="SP" :current="store.spPreview" :max="store.spPreview" color="var(--theme-sp, #f1c40f)" />
      </div>

      <!-- 属性 -->
      <div class="attr-row">
        <span v-for="attr in ATTRIBUTE_NAMES" :key="attr">
          {{ attr }}: <strong>{{ store.finalAttributes[attr] }}</strong>
        </span>
      </div>

      <!-- 装备/技能/道具 统计 -->
      <div class="stats-row">
        <span>装备 ×{{ store.selectedEquipments.length }}</span>
        <span>技能 ×{{ store.selectedSkills.length }}</span>
        <span>道具 ×{{ store.selectedItems.length }}</span>
        <span>背景: {{ store.selectedBackground?.name || (store.customBackgroundText ? '自定义背景' : '无') }}</span>
        <span>大纲: {{ store.plotOutline ? '✅ 已生成' : '⚠ 未生成' }}</span>
      </div>

      <!-- 已选物品摘要 -->
      <div class="items-summary" v-if="store.selectedEquipments.length">
        <h4>装备</h4>
        <span v-for="e in store.selectedEquipments" :key="e.id" class="item-chip">
          {{ e.name }} <QualityBadge :quality="(RARITY_TO_QUALITY[e.rarity] || '普通') as QualityLevel" size="sm" />
        </span>
      </div>
      <div class="items-summary" v-if="store.selectedSkills.length">
        <h4>技能</h4>
        <span v-for="s in store.selectedSkills" :key="s.id" class="item-chip">
          {{ s.name }} <QualityBadge :quality="(RARITY_TO_QUALITY[s.rarity] || '普通') as QualityLevel" size="sm" />
        </span>
      </div>
      <div class="items-summary" v-if="store.selectedItems.length">
        <h4>道具</h4>
        <span v-for="i in store.selectedItems" :key="i.id" class="item-chip">
          {{ i.name }}×{{ i.quantity || 1 }}
        </span>
      </div>
    </div>

    <p class="points-remaining">
      💡 剩余转生点数: {{ store.remainingPoints }} (未使用的点数将保留在存档中)
    </p>
  </section>
</template>

<style scoped>
.step-confirm { max-width: 560px; margin: 0 auto; }
.step-title { font-family: var(--theme-font-title, serif); color: var(--theme-text-primary); font-size: 1.3rem; margin-bottom: var(--theme-spacing-md); }
.confirm-card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-lg);
}
.hero-row { display: flex; align-items: center; gap: var(--theme-spacing-md); margin-bottom: var(--theme-spacing-md); }
.hero-info { display: flex; flex-direction: column; gap: 2px; }
.hero-name { font-size: 1.2rem; font-weight: 700; color: var(--theme-text-primary); }
.hero-meta { font-size: 0.8rem; color: var(--theme-text-secondary); }
.hero-tier { font-size: 0.75rem; color: var(--theme-color-primary); font-weight: 600; }
.hero-location { font-size: 0.7rem; color: var(--theme-text-muted); }
.hero-core { font-size: 0.7rem; color: var(--theme-quality-史诗); }
.resource-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--theme-spacing-md); }
.attr-row { display: flex; gap: var(--theme-spacing-md); font-size: 0.8rem; color: var(--theme-text-secondary); margin-bottom: var(--theme-spacing-sm); }
.attr-row strong { color: var(--theme-color-primary); }
.stats-row { display: flex; flex-wrap: wrap; gap: var(--theme-spacing-sm) var(--theme-spacing-lg); font-size: 0.75rem; color: var(--theme-text-muted); margin-bottom: var(--theme-spacing-sm); }
.items-summary { margin-bottom: var(--theme-spacing-xs); }
.items-summary h4 { font-size: 0.7rem; color: var(--theme-text-muted); margin: 4px 0; }
.item-chip { display: inline-flex; align-items: center; gap: 3px; margin: 2px 4px 2px 0; font-size: 0.7rem; color: var(--theme-text-primary); }
.points-remaining { text-align: center; margin-top: var(--theme-spacing-md); font-size: 0.8rem; color: var(--theme-text-muted); }
</style>
